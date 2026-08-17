import * as fs from 'fs';
import * as path from 'path';
import { sha256 } from './hash';
import { vaultProjectDirName } from './paths';
import type { DiscoveredSession, Provider } from './discover';

export const VAULT_FORMAT = 1;

/** Nivel de gzip: medido, el 6 da un 12 % menos de tamaño a costa de un 45 % más de CPU. */
export const GZIP_LEVEL = 4;

export interface VaultManifest {
  readonly formatVersion: number;
  readonly hostId: string;
  readonly createdAt: string;
  budgetBytes: number;
}

export interface ChunkRecord {
  readonly n: number;
  readonly from: number;
  readonly to: number;
  readonly sha256: string;
}

export interface PartState {
  readonly formatVersion: number;
  readonly rel: string;
  readonly generation: number;
  copiedBytes: number;
  headHash: string;
  tailHash: string;
  chunks: ChunkRecord[];
  updatedAt: string;
  /** Puesto a true cuando se abre una generación posterior; la cerrada sigue restaurable. */
  closed: boolean;
}

export interface SessionMeta {
  readonly formatVersion: number;
  readonly provider: Provider;
  /** Slug completo, porque en el almacén va acortado para no pasarse de MAX_PATH. */
  readonly projectSlug: string;
  readonly sessionId: string;
  firstSeenAt: string;
  lastBackupAt: string;
  /** True cuando el original ya no está en disco: la copia es lo único que queda. */
  orphan: boolean;
  sourceRoot: string;
}

/** Escritura atómica: fichero temporal + rename, y fsync antes de renombrar. */
export function writeAtomic(file: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Identificador de equipo: evita que dos máquinas choquen en una carpeta sincronizada. */
export function hostId(hostname: string): string {
  const clean = hostname.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${clean.slice(0, 24) || 'host'}-${sha256(hostname).slice(0, 6)}`;
}

export function ensureManifest(vaultRoot: string, host: string): VaultManifest {
  const file = path.join(vaultRoot, 'manifest.json');
  const existing = readJson<VaultManifest>(file);
  if (existing) {
    return existing;
  }
  const manifest: VaultManifest = {
    formatVersion: VAULT_FORMAT,
    hostId: host,
    createdAt: new Date().toISOString(),
    budgetBytes: 2 * 1024 * 1024 * 1024,
  };
  writeAtomic(file, JSON.stringify(manifest, null, 2));
  return manifest;
}

export function sessionDir(vaultRoot: string, session: DiscoveredSession): string {
  const project = vaultProjectDirName(session.projectSlug, sha256(session.projectSlug).slice(0, 8));
  return path.join(vaultRoot, session.provider, project, session.sessionId);
}

/**
 * Directorio de una parte dentro de la sesión. El `rel` puede traer subdirectorios y
 * nombres largos, así que se aplana y, si se pasa, se acorta con hash: en Windows la ruta
 * completa tiene que caber aunque `LongPathsEnabled` esté desactivado (hallazgo T-11).
 */
export function partDirName(rel: string): string {
  const flat = rel.replace(/[\\/]/g, '__');
  if (flat.length <= 48) {
    return flat;
  }
  return `${flat.slice(0, 40)}-${sha256(rel).slice(0, 8)}`;
}

export function partDir(vaultRoot: string, session: DiscoveredSession, rel: string): string {
  return path.join(sessionDir(vaultRoot, session), 'parts', partDirName(rel));
}

export function generationDir(base: string, generation: number): string {
  return path.join(base, `gen-${String(generation).padStart(3, '0')}`);
}

export function statePath(base: string, generation: number): string {
  return path.join(generationDir(base, generation), 'gen.json');
}

export function chunkPath(base: string, generation: number, n: number): string {
  return path.join(generationDir(base, generation), 'chunks', `${String(n).padStart(6, '0')}.gz`);
}

/** Generaciones existentes de una parte, de la más antigua a la más reciente. */
export function generationsOf(base: string): number[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(base);
  } catch {
    return [];
  }
  return entries
    .filter((e) => /^gen-\d{3}$/.test(e))
    .map((e) => Number(e.slice(4)))
    .sort((a, b) => a - b);
}

export function latestGeneration(base: string): number {
  const all = generationsOf(base);
  return all.length ? all[all.length - 1] : 0;
}

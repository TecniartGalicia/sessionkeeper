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
  /** Huella de las sondas intermedias; vacía si el fichero es más corto que dos sondas. */
  midHash: string;
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
  /** Ruta original de cada parte, para poder restaurarla cuando ya no exista en disco. */
  parts?: { rel: string; path: string }[];
}

/** Permisos del almacén: solo el dueño. Las transcripciones pueden contener credenciales. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

function sleepBusy(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* espera activa: son decenas de milisegundos y no hay await en esta capa */
  }
}

/**
 * Escritura atómica: temporal + `rename`, con `fsync` antes de renombrar.
 *
 * El `rename` sobre un destino existente falla con EPERM en Windows cuando el antivirus o
 * el indexador tienen el fichero abierto un instante — medido en este equipo: **118 fallos
 * de 2.000 escrituras** del mismo fichero. Sin reintento, ese 6 % aborta la copia entera.
 */
export function writeAtomic(file: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', FILE_MODE);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  let delay = 10;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (attempt >= 5 || !RETRYABLE.has(code)) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* el temporal se limpiará en el próximo `sweepTempFiles` */
        }
        throw err;
      }
      sleepBusy(delay);
      delay = Math.min(delay * 2, 200);
    }
  }
}

/**
 * Lee un JSON del almacén. Solo "no existe" devuelve `undefined`: un fichero **ilegible**
 * (bloqueado, a medio sincronizar, corrupto) tiene que propagarse, porque tratarlo como
 * inexistente hace que el motor recopie desde cero encima de los trozos ya escritos.
 */
export function readJson<T>(file: string): T | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${file} no es JSON legible: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Restos de escrituras atómicas interrumpidas. Se barren al abrir el almacén. */
export function sweepTempFiles(dir: string): number {
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removed += sweepTempFiles(full);
    } else if (/\.tmp-\d+$/.test(entry.name)) {
      try {
        fs.rmSync(full, { force: true });
        removed++;
      } catch {
        /* si otro proceso lo está escribiendo ahora mismo, se deja */
      }
    }
  }
  return removed;
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

/** Formato máximo del almacén que esta versión entiende. */
export const MAX_SUPPORTED_FORMAT = VAULT_FORMAT;

/**
 * Un almacén escrito por una versión más nueva no se puede leer a medias: mejor decirlo que
 * devolver datos incompletos.
 */
export function assertReadableFormat(manifest: VaultManifest | undefined): void {
  if (manifest && manifest.formatVersion > MAX_SUPPORTED_FORMAT) {
    throw new Error(
      `este almacén usa el formato ${manifest.formatVersion} y esta versión de SessionKeeper entiende hasta el ${MAX_SUPPORTED_FORMAT}: actualiza la extensión`,
    );
  }
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
  // El filtro de tres dígitos hacía invisible la generación 1000 en adelante: `latestGeneration`
  // habría devuelto una anterior y se habría copiado encima de ella.
  return entries
    .filter((e) => /^gen-\d+$/.test(e))
    .map((e) => Number(e.slice(4)))
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);
}

export function latestGeneration(base: string): number {
  const all = generationsOf(base);
  return all.length ? all[all.length - 1] : 0;
}

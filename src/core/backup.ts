import * as fs from 'fs';
import * as path from 'path';
import { gunzipSync, gzipSync } from 'zlib';
import { PROBE_BYTES, probeMid, readRange, safeCutOffset, sha256 } from './hash';
import type { DiscoveredSession, SessionPart } from './discover';
import {
  chunkPath,
  generationDir,
  generationsOf,
  GZIP_LEVEL,
  latestGeneration,
  partDir,
  readJson,
  sessionDir,
  statePath,
  VAULT_FORMAT,
  writeAtomic,
  type PartState,
  type SessionMeta,
} from './vault';

export type PlanAction = 'skip' | 'append' | 'new-generation' | 'missing' | 'wait' | 'error';

/** Tamaño de bloque de trabajo: acota la memoria y da granularidad ante cortes. */
export const CHUNK_BYTES = 8 * 1024 * 1024;
/** Tope para una sola línea sin salto: más allá se copia en crudo en vez de crecer sin fin. */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

export interface PartPlan {
  readonly action: PlanAction;
  readonly rel: string;
  /** Bytes que se copiarían en este ciclo (0 salvo en `append`/`new-generation`). */
  readonly pending: number;
  readonly reason?: string;
}

/** Huellas del origen limitadas a lo ya copiado, para comparar con el estado guardado. */
function probesOfSource(file: string, copiedBytes: number): { head: string; tail: string; mid: string } {
  const headLen = Math.min(PROBE_BYTES, copiedBytes);
  const head = sha256(readRange(file, 0, headLen));
  const tailFrom = Math.max(0, copiedBytes - PROBE_BYTES);
  const tail = sha256(readRange(file, tailFrom, copiedBytes - tailFrom));
  return { head, tail, mid: probeMid(file, copiedBytes) };
}

/**
 * Decide qué hacer con una parte, sin tocar nada.
 *
 * Se comparan las DOS puntas del tramo ya copiado: solo la cola dejaría pasar una
 * reescritura que la conservase, y la restauración produciría un fichero que cuadra con
 * su hash acumulado sin ser el original (hallazgo T-10).
 */
export function planPart(sourcePath: string, rel: string, state: PartState | undefined): PartPlan {
  let size: number;
  try {
    size = fs.statSync(sourcePath).size;
  } catch {
    return { action: 'missing', rel, pending: 0, reason: 'el original ya no está en disco' };
  }

  if (!state || state.copiedBytes === 0) {
    return size === 0
      ? { action: 'skip', rel, pending: 0, reason: 'vacío' }
      : { action: 'append', rel, pending: size };
  }

  if (size < state.copiedBytes) {
    return { action: 'new-generation', rel, pending: size, reason: 'el fichero ha encogido' };
  }

  const probes = probesOfSource(sourcePath, state.copiedBytes);
  if (probes.head !== state.headHash) {
    return { action: 'new-generation', rel, pending: size, reason: 'la cabecera ha cambiado' };
  }
  if (probes.tail !== state.tailHash) {
    return { action: 'new-generation', rel, pending: size, reason: 'la cola ha cambiado' };
  }
  if (probes.mid !== (state.midHash ?? '')) {
    return { action: 'new-generation', rel, pending: size, reason: 'ha cambiado por el medio' };
  }
  if (size === state.copiedBytes) {
    return { action: 'skip', rel, pending: 0 };
  }
  return { action: 'append', rel, pending: size - state.copiedBytes };
}

export interface PartResult {
  readonly rel: string;
  readonly action: PlanAction;
  readonly bytesCopied: number;
  readonly generation: number;
  readonly reason?: string;
}

/** Ejecuta un ciclo sobre una parte. Solo escribe dentro del almacén. */
export function backupPart(
  vaultRoot: string,
  session: DiscoveredSession,
  part: SessionPart,
): PartResult {
  const base = partDir(vaultRoot, session, part.rel);
  let generation = latestGeneration(base);
  let state = generation ? readJson<PartState>(statePath(base, generation)) : undefined;

  const plan = planPart(part.path, part.rel, state);

  if (plan.action === 'missing' || plan.action === 'skip') {
    return { rel: part.rel, action: plan.action, bytesCopied: 0, generation, reason: plan.reason };
  }

  if (plan.action === 'new-generation') {
    if (state) {
      state.closed = true;
      writeAtomic(statePath(base, generation), JSON.stringify(state, null, 2));
    }
    generation += 1;
    state = undefined;
  }

  if (generation === 0) {
    generation = 1;
  }

  const size = fs.statSync(part.path).size;
  const isJsonl = part.rel.endsWith('.jsonl');
  let from = state?.copiedBytes ?? 0;
  let chunks = [...(state?.chunks ?? [])];
  let copied = 0;

  // Se avanza por bloques y se persiste el estado tras cada uno: así la primera copia de un
  // fichero de 324 MB no se lee de golpe (el criterio de memoria es 300 MB de RSS para TODO
  // el proceso) y un corte a mitad de barrido deja una copia coherente hasta el último bloque.
  while (from < size) {
    let want = Math.min(CHUNK_BYTES, size - from);
    let block = readRange(part.path, from, want);
    let usable = isJsonl ? safeCutOffset(block) : block.length;

    // Una línea más larga que el bloque: se amplía la ventana hasta encontrar su final.
    while (isJsonl && usable === 0 && want < MAX_LINE_BYTES && from + want < size) {
      want = Math.min(want * 2, MAX_LINE_BYTES, size - from);
      block = readRange(part.path, from, want);
      usable = safeCutOffset(block);
    }
    if (usable === 0) {
      if (isJsonl && from + want >= size) {
        break; // la cola es una línea a medias: se recoge en el ciclo siguiente
      }
      usable = block.length; // línea gigantesca sin frontera: se copia tal cual
    }

    const payload = block.subarray(0, usable);
    // max(n)+1, no chunks.length+1: si un ciclo anterior dejó un trozo sin registrar, no se pisa.
    const n = chunks.reduce((max, c) => Math.max(max, c.n), 0) + 1;
    writeAtomic(chunkPath(base, generation, n), gzipSync(payload, { level: GZIP_LEVEL }));

    const to = from + usable;
    chunks = [...chunks, { n, from, to, sha256: sha256(payload) }];
    const probes = probesOfSource(part.path, to);
    const next: PartState = {
      formatVersion: VAULT_FORMAT,
      rel: part.rel,
      generation,
      copiedBytes: to,
      headHash: probes.head,
      tailHash: probes.tail,
      midHash: probes.mid,
      chunks,
      updatedAt: new Date().toISOString(),
      closed: false,
    };
    writeAtomic(statePath(base, generation), JSON.stringify(next, null, 2));

    copied += usable;
    from = to;
  }

  if (copied === 0) {
    return {
      rel: part.rel,
      action: 'wait',
      bytesCopied: 0,
      generation,
      reason: 'no hay ninguna línea completa todavía',
    };
  }

  // El motivo viaja con el resultado: es lo que el informe le enseña al usuario cuando
  // una sesión rota de generación ("la cabecera ha cambiado", "el fichero ha encogido").
  return { rel: part.rel, action: plan.action, bytesCopied: copied, generation, reason: plan.reason };
}

export interface SessionResult {
  readonly sessionId: string;
  readonly parts: readonly PartResult[];
  readonly bytesCopied: number;
}

/** Conserva las rutas conocidas aunque una parte ya no aparezca en el origen. */
function mergeParts(
  previous: { rel: string; path: string }[] | undefined,
  current: { rel: string; path: string }[],
): { rel: string; path: string }[] {
  const byRel = new Map((previous ?? []).map((p) => [p.rel, p]));
  for (const part of current) {
    byRel.set(part.rel, part);
  }
  return [...byRel.values()];
}

export function backupSession(vaultRoot: string, session: DiscoveredSession): SessionResult {
  const dir = sessionDir(vaultRoot, session);
  const metaFile = path.join(dir, 'meta.json');
  let previous: SessionMeta | undefined;
  try {
    previous = readJson<SessionMeta>(metaFile);
  } catch {
    previous = undefined; // meta ilegible: se reescribe, los trozos no dependen de ella
  }
  const now = new Date().toISOString();

  // Un fallo de E/S en una parte (antivirus, fichero bloqueado, disco lleno) no puede
  // tumbar la copia del resto: se anota como 'error' y se sigue.
  const parts = session.parts.map((p) => {
    try {
      return backupPart(vaultRoot, session, p);
    } catch (err) {
      return {
        rel: p.rel,
        action: 'error' as const,
        bytesCopied: 0,
        generation: 0,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  });

  const meta: SessionMeta = {
    formatVersion: VAULT_FORMAT,
    provider: session.provider,
    projectSlug: session.projectSlug,
    sessionId: session.sessionId,
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastBackupAt: now,
    orphan: parts.length > 0 && parts.every((p) => p.action === 'missing'),
    sourceRoot: path.dirname(session.parts[0]?.path ?? ''),
    // Las rutas originales viajan con la copia: sin ellas, una sesión ya borrada no sabría
    // dónde volver.
    parts: mergeParts(previous?.parts, session.parts.map((p) => ({ rel: p.rel, path: p.path }))),
  };
  writeAtomic(metaFile, JSON.stringify(meta, null, 2));

  return {
    sessionId: session.sessionId,
    parts,
    bytesCopied: parts.reduce((n, p) => n + p.bytesCopied, 0),
  };
}

/**
 * Reconstruye una parte desde el almacén y verifica cada trozo. Devuelve los bytes.
 * No escribe nada: quien decide dónde va el resultado es `restore.ts`, con sus guardas.
 */
export function rebuildPart(
  vaultRoot: string,
  session: DiscoveredSession,
  rel: string,
  generation?: number,
): Buffer {
  const base = partDir(vaultRoot, session, rel);
  const gen = generation ?? latestGeneration(base);
  if (gen === 0) {
    throw new Error(`sin copia de ${rel}`);
  }
  const state = readJson<PartState>(statePath(base, gen));
  if (!state) {
    throw new Error(`copia de ${rel} sin estado legible (gen ${gen})`);
  }

  const blocks: Buffer[] = [];
  let offset = 0;
  for (const chunk of state.chunks) {
    const raw = gunzipSync(fs.readFileSync(chunkPath(base, gen, chunk.n)));
    if (sha256(raw) !== chunk.sha256) {
      throw new Error(`trozo ${chunk.n} de ${rel} corrupto`);
    }
    if (chunk.from !== offset) {
      throw new Error(`trozo ${chunk.n} de ${rel} fuera de sitio (${chunk.from} ≠ ${offset})`);
    }
    blocks.push(raw);
    offset = chunk.to;
  }
  if (offset !== state.copiedBytes) {
    throw new Error(`la copia de ${rel} está incompleta (${offset} de ${state.copiedBytes})`);
  }
  return Buffer.concat(blocks);
}

/** Generaciones disponibles de una parte, para poder ofrecer versiones anteriores. */
export function availableGenerations(
  vaultRoot: string,
  session: DiscoveredSession,
  rel: string,
): number[] {
  return generationsOf(partDir(vaultRoot, session, rel));
}

export function generationPath(
  vaultRoot: string,
  session: DiscoveredSession,
  rel: string,
  generation: number,
): string {
  return generationDir(partDir(vaultRoot, session, rel), generation);
}

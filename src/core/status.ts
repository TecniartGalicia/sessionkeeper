import * as fs from 'fs';
import * as path from 'path';
import { planPart } from './backup';
import type { DiscoveredSession } from './discover';
import { latestGeneration, partDir, readJson, sessionDir, type PartState, type SessionMeta } from './vault';

export type BackupState =
  /** Nunca se ha copiado. */
  | 'new'
  /** Copiada y sin cambios desde entonces. */
  | 'backed-up'
  /** Copiada, pero ha crecido desde la última vez. */
  | 'pending'
  /** El original ya no está en disco: la copia es lo único que queda. */
  | 'orphan';

export interface SessionStatus {
  readonly state: BackupState;
  readonly pendingBytes: number;
  readonly copiedBytes: number;
  readonly lastBackupAt?: string;
  readonly generations: number;
}

/**
 * Caché del estado de cada parte, invalidada por el `mtime` del propio `gen.json`.
 *
 * Refrescar el árbol o dar una vuelta el vigilante leía y parseaba un `gen.json` por parte: con
 * 60 sesiones son 180 lecturas para no enterarse de nada. Ahora es un `stat` por parte, y solo
 * se lee de verdad lo que ha cambiado.
 */
const stateCache = new Map<string, { mtimeMs: number; size: number; state: PartState | undefined }>();

function readStateCached(file: string): PartState | undefined {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    stateCache.delete(file);
    return undefined;
  }
  const hit = stateCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return hit.state;
  }
  const state = readJson<PartState>(file);
  stateCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, state });
  return state;
}

function statSize(file: string): number | undefined {
  try {
    return fs.statSync(file).size;
  } catch {
    return undefined;
  }
}

export function sessionStatus(vaultRoot: string, session: DiscoveredSession): SessionStatus {
  const meta = readJson<SessionMeta>(path.join(sessionDir(vaultRoot, session), 'meta.json'));

  let pending = 0;
  let copied = 0;
  let generations = 0;
  let anyState = false;
  let allMissing = session.parts.length > 0;

  for (const part of session.parts) {
    const base = partDir(vaultRoot, session, part.rel);
    const gen = latestGeneration(base);
    if (gen > 0) {
      generations = Math.max(generations, gen);
      const state = readStateCached(path.join(base, `gen-${String(gen).padStart(3, '0')}`, 'gen.json'));
      if (state) {
        anyState = true;
        copied += state.copiedBytes;
      }
      // Atajo barato: un `stat` decide. Si el fichero está y su tamaño es el ya copiado,
      // no hace falta leer las puntas; refrescar el árbol con cientos de partes tiene que
      // costar `stat`, no 128 KB por parte. Pero el `stat` es obligatorio: sin él, una
      // sesión reconstruida desde el almacén parecería copiada en vez de huérfana.
      const live = statSize(part.path);
      if (state && live === state.copiedBytes) {
        allMissing = false;
      } else if (state && live === undefined) {
        // el original ya no está
      } else {
        const plan = planPart(part.path, part.rel, state);
        if (plan.action === 'append' || plan.action === 'new-generation') {
          pending += plan.pending;
        }
        if (plan.action !== 'missing') {
          allMissing = false;
        }
      }
    } else {
      allMissing = false;
      pending += part.size;
    }
  }

  if (!anyState && !meta) {
    return { state: 'new', pendingBytes: pending, copiedBytes: 0, generations: 0 };
  }
  if (allMissing) {
    return {
      state: 'orphan',
      pendingBytes: 0,
      copiedBytes: copied,
      lastBackupAt: meta?.lastBackupAt,
      generations,
    };
  }
  return {
    state: pending > 0 ? 'pending' : 'backed-up',
    pendingBytes: pending,
    copiedBytes: copied,
    lastBackupAt: meta?.lastBackupAt,
    generations,
  };
}

/** Tamaño total del almacén, para el presupuesto y el informe. */
export function vaultSize(vaultRoot: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* el fichero puede desaparecer entre readdir y stat */
        }
      }
    }
  };
  walk(vaultRoot);
  return total;
}

export function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

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
      const state = readJson<PartState>(path.join(base, `gen-${String(gen).padStart(3, '0')}`, 'gen.json'));
      if (state) {
        anyState = true;
        copied += state.copiedBytes;
      }
      const plan = planPart(part.path, part.rel, state);
      if (plan.action === 'append' || plan.action === 'new-generation') {
        pending += plan.pending;
      }
      if (plan.action !== 'missing') {
        allMissing = false;
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

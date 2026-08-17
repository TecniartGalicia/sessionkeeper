import * as fs from 'fs';
import * as path from 'path';
import { readJson, writeAtomic } from './vault';

/**
 * Lock del almacén entre ventanas de VS Code.
 *
 * Un lock que solo guarda el pid es exactamente lo que produce los ficheros obsoletos que
 * deja Claude Code en `~/.claude/sessions` (39 de 48 medidos): tras un cierre brusco, o el
 * almacén queda bloqueado para siempre, o un pid reutilizado hace creer que hay dueño vivo.
 * Por eso se guarda además un latido: si lleva parado más que `STALE_MS`, se toma el relevo.
 */
export const STALE_MS = 10 * 60 * 1000;

interface LockData {
  readonly pid: number;
  readonly host: string;
  readonly takenAt: string;
  heartbeatMs: number;
}

export interface VaultLock {
  heartbeat(): void;
  release(): void;
}

export class LockedError extends Error {
  constructor(public readonly owner: LockData) {
    super(`el almacén lo está usando otro proceso (pid ${owner.pid} en ${owner.host})`);
    this.name = 'LockedError';
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireLock(vaultRoot: string, host: string, now = Date.now()): VaultLock {
  const file = path.join(vaultRoot, '.lock');
  const current = readJson<LockData>(file);

  if (current && current.pid !== process.pid) {
    const fresh = now - current.heartbeatMs < STALE_MS;
    if (fresh && alive(current.pid)) {
      throw new LockedError(current);
    }
  }

  const data: LockData = { pid: process.pid, host, takenAt: new Date(now).toISOString(), heartbeatMs: now };
  writeAtomic(file, JSON.stringify(data, null, 2));

  return {
    heartbeat(): void {
      const owner = readJson<LockData>(file);
      if (owner?.pid !== process.pid) {
        return; // alguien nos relevó: no se pisa su lock
      }
      writeAtomic(file, JSON.stringify({ ...data, heartbeatMs: Date.now() }, null, 2));
    },
    release(): void {
      const owner = readJson<LockData>(file);
      if (owner?.pid === process.pid) {
        try {
          fs.rmSync(file);
        } catch {
          /* si ya no está, mejor */
        }
      }
    },
  };
}

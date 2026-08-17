import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { backupSession, rebuildPart, type SessionResult } from '../core/backup';
import { discoverClaude, discoverCodex, type DiscoveredSession } from '../core/discover';
import { readRetention, runDoctor, type Finding } from '../core/doctor';
import { MAX_EXPORT_BYTES, toMarkdown, type ExportResult } from '../core/exporter';
import { acquireLock } from '../core/lock';
import { defaultVaultRoot, type Env } from '../core/paths';
import { restoreSession, isSessionLive, writeRestoreDocs, type RestoreOptions, type RestoreResult } from '../core/restore';
import { scanText, type SecretHit } from '../core/secrets';
import { sessionStatus, vaultSize, type SessionStatus } from '../core/status';
import { discoverVault } from '../core/vaultIndex';
import { DIR_MODE, ensureManifest, hostId, sweepTempFiles, writeAtomic } from '../core/vault';

/** Localiza un fichero de `assets/` tanto en el bundle (`dist/`) como en los tests (`out/`). */
function findAsset(name: string): string | undefined {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'assets', name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

export interface KeeperConfig {
  readonly env: Env;
  readonly vaultPath?: string;
  readonly claudeHome?: string;
  readonly includeCodex?: boolean;
}

export interface SessionView {
  readonly session: DiscoveredSession;
  readonly status: SessionStatus;
}

export interface BackupOutcome {
  readonly sessions: number;
  readonly bytesCopied: number;
  readonly rotated: readonly string[];
  readonly waiting: number;
  readonly secrets: readonly SecretHit[];
  /** Partes que no se pudieron copiar, con su motivo. Se enseñan; nunca se ocultan. */
  readonly errors: readonly string[];
  /** Cierto cuando se paró por presupuesto de disco: nunca se borra para hacer sitio. */
  readonly budgetReached?: boolean;
}

/**
 * Orquesta el trabajo real. No conoce `vscode`: recibe un `Env` y devuelve datos, para que
 * la capa de UI solo tenga que pintar y pedir confirmaciones.
 */
export class Keeper {
  constructor(private readonly config: KeeperConfig) {}

  get env(): Env {
    return this.config.env;
  }

  get claudeHomeOverride(): string | undefined {
    return this.config.claudeHome;
  }

  get vaultRoot(): string {
    const base = this.config.vaultPath?.trim() || defaultVaultRoot(this.config.env);
    return path.join(base, hostId(os.hostname()));
  }

  discover(): { views: SessionView[]; warnings: string[]; memoryDirs: string[] } {
    const claude = discoverClaude(this.config.env, this.config.claudeHome);
    const codex = this.config.includeCodex
      ? discoverCodex(this.config.env)
      : { sessions: [], memoryDirs: [], warnings: [] };

    const root = this.vaultRoot;

    // Unión origen ∪ almacén: una sesión que ya se borró del disco sigue estando aquí, que
    // es exactamente para lo que existe el producto. Gana la del origen cuando está en las dos.
    const byKey = new Map<string, DiscoveredSession>();
    for (const session of discoverVault(root)) {
      byKey.set(`${session.provider}/${session.projectSlug}/${session.sessionId}`, session);
    }
    for (const session of [...claude.sessions, ...codex.sessions]) {
      byKey.set(`${session.provider}/${session.projectSlug}/${session.sessionId}`, session);
    }
    const all = [...byKey.values()].sort((a, b) => b.lastModified - a.lastModified);

    return {
      views: all.map((session) => ({ session, status: sessionStatus(root, session) })),
      warnings: [...claude.warnings, ...codex.warnings],
      memoryDirs: [...claude.memoryDirs],
    };
  }

  /** Copia las sesiones indicadas. `onProgress` permite cancelar entre sesiones. */
  backup(
    sessions: readonly DiscoveredSession[],
    onProgress?: (done: number, total: number, current: string) => boolean,
  ): BackupOutcome {
    const root = this.vaultRoot;
    fs.mkdirSync(root, { recursive: true, mode: DIR_MODE });
    const manifest = ensureManifest(root, hostId(os.hostname()));
    sweepTempFiles(root);
    writeRestoreDocs(root);
    this.writeRestoreScript(root);

    // Dos ventanas de VS Code copiando al mismo almacén se pisarían el estado.
    const lock = acquireLock(root, os.hostname());

    let bytes = 0;
    let waiting = 0;
    let budgetReached = false;
    let used = vaultSize(root);
    const errors: string[] = [];
    const rotated: string[] = [];
    const secrets = new Map<string, SecretHit>();
    let done = 0;

    try {
      for (const session of sessions) {
        if (onProgress && !onProgress(done, sessions.length, session.sessionId)) {
          break;
        }
        // Presupuesto de disco: se para y se avisa. Nunca se borra la última copia de nada
        // para hacer sitio — un producto de copias que borra copias no sirve para nada.
        if (manifest.budgetBytes > 0 && used >= manifest.budgetBytes) {
          budgetReached = true;
          break;
        }
        let result;
        try {
          result = backupSession(root, session);
        } catch (err) {
          errors.push(`${session.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
          done++;
          continue;
        }
        bytes += result.bytesCopied;
        for (const part of result.parts) {
          if (part.action === 'new-generation') {
            rotated.push(`${session.sessionId} · ${part.rel}: ${part.reason ?? 'cambió el origen'}`);
          }
          if (part.action === 'wait') {
            waiting++;
          }
          if (part.action === 'error') {
            errors.push(`${session.sessionId} · ${part.rel}: ${part.reason ?? 'error de E/S'}`);
          }
        }
        used += result.bytesCopied;
        for (const hit of this.scanCopied(session, result)) {
          const prev = secrets.get(hit.id);
          secrets.set(hit.id, { ...hit, count: (prev?.count ?? 0) + hit.count });
        }
        done++;
        lock.heartbeat();
      }
    } finally {
      lock.release();
    }

    return { sessions: done, bytesCopied: bytes, rotated, waiting, secrets: [...secrets.values()], errors, budgetReached };
  }

  /**
   * Aviso de credenciales sobre lo que se acaba de copiar, en TODAS las partes (también
   * subagentes y salidas de herramientas, que es justo donde acaba volcado un `.env`).
   * Se limita a 1 MB por parte para no releer ficheros enteros.
   */
  private scanCopied(session: DiscoveredSession, result: SessionResult): SecretHit[] {
    const hits: SecretHit[] = [];
    for (const part of result.parts) {
      if (part.bytesCopied <= 0) {
        continue;
      }
      const source = session.parts.find((p) => p.rel === part.rel);
      if (!source) {
        continue;
      }
      try {
        const size = fs.statSync(source.path).size;
        const length = Math.min(part.bytesCopied, 1024 * 1024);
        const from = Math.max(0, size - length);
        const fd = fs.openSync(source.path, 'r');
        try {
          const buf = Buffer.alloc(Math.min(length, size - from));
          fs.readSync(fd, buf, 0, buf.length, from);
          hits.push(...scanText(buf.toString('utf8')));
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        /* si no se puede releer, no se avisa: el aviso nunca puede romper la copia */
      }
    }
    return hits;
  }

  restore(session: DiscoveredSession, options: RestoreOptions = {}): RestoreResult[] {
    // La comprobación de "sesión viva" se repite aquí dentro: entre el aviso de la interfaz
    // y el clic de confirmación puede haber pasado cualquier cosa.
    return restoreSession(this.vaultRoot, session, {
      ...options,
      env: this.config.env,
      claudeHome: this.config.claudeHome,
    });
  }

  isLive(session: DiscoveredSession): boolean {
    return isSessionLive(this.config.env, session.sessionId, this.config.claudeHome).live;
  }

  /** Exporta a Markdown desde la COPIA, para poder exportar sesiones ya desaparecidas. */
  export(session: DiscoveredSession, title: string): ExportResult {
    let buffer: Buffer;
    try {
      buffer = rebuildPart(this.vaultRoot, session, 'main.jsonl');
    } catch {
      buffer = fs.readFileSync(session.parts[0].path);
    }

    // Sesiones de cientos de MB: se exporta la parte final, que es la que se busca, en vez
    // de reventar con "Cannot create a string longer than…".
    const truncated = buffer.length > MAX_EXPORT_BYTES;
    if (truncated) {
      const from = buffer.length - MAX_EXPORT_BYTES;
      const cut = buffer.indexOf(0x0a, from);
      buffer = buffer.subarray(cut >= 0 ? cut + 1 : from);
    }

    const result = toMarkdown(buffer.toString('utf8'), { title });
    return { ...result, truncated };
  }

  doctor(sessions: readonly DiscoveredSession[]): { findings: Finding[]; markdown: string } {
    return runDoctor({
      env: this.config.env,
      sessions,
      vaultRoot: this.vaultRoot,
      retention: readRetention(this.config.env, this.config.claudeHome),
      now: Date.now(),
      homeOverride: this.config.claudeHome,
    });
  }

  vaultBytes(): number {
    return vaultSize(this.vaultRoot);
  }

  /**
   * Script de recuperación independiente. Va dentro del almacén para que restaurar no
   * dependa nunca de tener la extensión instalada ni una licencia.
   *
   * Vive como fichero del paquete (`assets/restore.mjs`) y no incrustado en el código: un
   * script con expresiones regulares y rutas de Windows dentro de una plantilla pierde las
   * barras invertidas por el camino, y este fichero es justo el que tiene que funcionar el
   * día que todo lo demás falle.
   */
  private writeRestoreScript(root: string): void {
    const source = findAsset('restore.mjs');
    if (!source) {
      return;
    }
    writeAtomic(path.join(root, 'restore.mjs'), fs.readFileSync(source));
  }
}

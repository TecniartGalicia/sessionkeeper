import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { backupSession, rebuildPart } from '../core/backup';
import { discoverClaude, discoverCodex, type DiscoveredSession } from '../core/discover';
import { readRetention, runDoctor, type Finding } from '../core/doctor';
import { toMarkdown, type ExportResult } from '../core/exporter';
import { defaultVaultRoot, type Env } from '../core/paths';
import { restoreSession, isSessionLive, writeRestoreDocs, type RestoreOptions, type RestoreResult } from '../core/restore';
import { scanText, type SecretHit } from '../core/secrets';
import { sessionStatus, vaultSize, type SessionStatus } from '../core/status';
import { ensureManifest, hostId, writeAtomic } from '../core/vault';

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
}

/**
 * Orquesta el trabajo real. No conoce `vscode`: recibe un `Env` y devuelve datos, para que
 * la capa de UI solo tenga que pintar y pedir confirmaciones.
 */
export class Keeper {
  constructor(private readonly config: KeeperConfig) {}

  get vaultRoot(): string {
    const base = this.config.vaultPath?.trim() || defaultVaultRoot(this.config.env);
    return path.join(base, hostId(os.hostname()));
  }

  discover(): { views: SessionView[]; warnings: string[]; memoryDirs: string[] } {
    const claude = discoverClaude(this.config.env, this.config.claudeHome);
    const codex = this.config.includeCodex
      ? discoverCodex(this.config.env)
      : { sessions: [], memoryDirs: [], warnings: [] };

    const all = [...claude.sessions, ...codex.sessions].sort((a, b) => b.lastModified - a.lastModified);
    const root = this.vaultRoot;

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
    fs.mkdirSync(root, { recursive: true });
    ensureManifest(root, hostId(os.hostname()));
    writeRestoreDocs(root);
    this.writeRestoreScript(root);

    let bytes = 0;
    let waiting = 0;
    const rotated: string[] = [];
    const secrets = new Map<string, SecretHit>();
    let done = 0;

    for (const session of sessions) {
      if (onProgress && !onProgress(done, sessions.length, session.sessionId)) {
        break;
      }
      const result = backupSession(root, session);
      bytes += result.bytesCopied;
      for (const part of result.parts) {
        if (part.action === 'new-generation') {
          rotated.push(`${session.sessionId} · ${part.rel}: ${part.reason ?? 'cambió el origen'}`);
        }
        if (part.action === 'wait') {
          waiting++;
        }
      }
      for (const hit of this.scanNewBytes(session)) {
        const prev = secrets.get(hit.id);
        secrets.set(hit.id, { ...hit, count: (prev?.count ?? 0) + hit.count });
      }
      done++;
    }

    return { sessions: done, bytesCopied: bytes, rotated, waiting, secrets: [...secrets.values()] };
  }

  /** Aviso de credenciales: se mira la cola de la transcripción, no el fichero entero. */
  private scanNewBytes(session: DiscoveredSession): SecretHit[] {
    const main = session.parts.find((p) => p.kind === 'main');
    if (!main) {
      return [];
    }
    try {
      const size = fs.statSync(main.path).size;
      const from = Math.max(0, size - 256 * 1024);
      const fd = fs.openSync(main.path, 'r');
      try {
        const buf = Buffer.alloc(size - from);
        fs.readSync(fd, buf, 0, buf.length, from);
        return scanText(buf.toString('utf8'));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return [];
    }
  }

  restore(session: DiscoveredSession, options: RestoreOptions = {}): RestoreResult[] {
    return restoreSession(this.vaultRoot, session, options);
  }

  isLive(session: DiscoveredSession): boolean {
    return isSessionLive(this.config.env, session.sessionId, this.config.claudeHome).live;
  }

  /** Exporta a Markdown desde la COPIA, para poder exportar sesiones ya desaparecidas. */
  export(session: DiscoveredSession, title: string): ExportResult {
    let jsonl: string;
    try {
      jsonl = rebuildPart(this.vaultRoot, session, 'main.jsonl').toString('utf8');
    } catch {
      jsonl = fs.readFileSync(session.parts[0].path, 'utf8');
    }
    return toMarkdown(jsonl, { title });
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
   */
  private writeRestoreScript(root: string): void {
    const script = `#!/usr/bin/env node
// Recupera un almacén de SessionKeeper sin la extensión: node restore.mjs <vault> <destino>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [vault, dest] = process.argv.slice(2);
if (!vault || !dest) {
  console.error('uso: node restore.mjs <carpeta-del-vault> <carpeta-destino>');
  process.exit(1);
}
const long = (p) => (process.platform === 'win32' && !p.startsWith('\\\\\\\\?\\\\') ? '\\\\\\\\?\\\\' + path.resolve(p) : p);
let count = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    if (e.name !== 'gen.json') continue;
    const state = JSON.parse(fs.readFileSync(full, 'utf8'));
    const out = path.join(dest, path.relative(vault, path.dirname(path.dirname(dir))), state.rel);
    fs.mkdirSync(long(path.dirname(out)), { recursive: true });
    const blocks = state.chunks.map((c) =>
      zlib.gunzipSync(fs.readFileSync(long(path.join(path.dirname(full), 'chunks', String(c.n).padStart(6, '0') + '.gz')))),
    );
    fs.writeFileSync(long(out), Buffer.concat(blocks));
    count++;
  }
};
walk(vault);
console.log('recuperados ' + count + ' ficheros en ' + dest);
`;
    writeAtomic(path.join(root, 'restore.mjs'), script);
  }
}

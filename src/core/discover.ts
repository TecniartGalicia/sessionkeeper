import * as fs from 'fs';
import * as path from 'path';
import {
  claudeMemoryDir,
  claudeProjectsDir,
  claudeSessionPaths,
  codexSessionsDir,
  isSessionId,
  NON_SESSION_DIRS,
  type Env,
} from './paths';

export type Provider = 'claude-code' | 'codex';

export type PartKind = 'main' | 'subagent' | 'tool-result';

export interface SessionPart {
  readonly kind: PartKind;
  /** Ruta absoluta en el disco del usuario. */
  readonly path: string;
  /** Ruta dentro del almacén, relativa a la carpeta de la sesión. */
  readonly rel: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface DiscoveredSession {
  readonly provider: Provider;
  readonly projectSlug: string;
  readonly sessionId: string;
  readonly parts: readonly SessionPart[];
  readonly totalBytes: number;
  readonly lastModified: number;
}

export interface DiscoveryResult {
  readonly sessions: readonly DiscoveredSession[];
  /** Carpetas `memory/` encontradas: artefacto propio, nunca una sesión (hallazgo T-12). */
  readonly memoryDirs: readonly string[];
  /** Lo que no se pudo leer, con su motivo. Nunca se lanza: un proveedor roto no tumba al otro. */
  readonly warnings: readonly string[];
}

function statSafe(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}

function readdirSafe(p: string, warnings: string[]): fs.Dirent[] {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch (err) {
    warnings.push(`${p}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function filesIn(dir: string, kind: PartKind, relBase: string, warnings: string[]): SessionPart[] {
  const out: SessionPart[] = [];
  const st = statSafe(dir);
  if (!st?.isDirectory()) {
    return out;
  }
  for (const entry of readdirSafe(dir, warnings)) {
    if (!entry.isFile()) {
      continue;
    }
    const full = path.join(dir, entry.name);
    const fst = statSafe(full);
    if (!fst) {
      continue;
    }
    out.push({
      kind,
      path: full,
      rel: `${relBase}/${entry.name}`,
      size: fst.size,
      mtimeMs: fst.mtimeMs,
    });
  }
  return out;
}

/**
 * Descubre las sesiones de Claude Code. Una sesión es `<id>.jsonl` MÁS el directorio
 * hermano `<id>/` con `subagents/` y `tool-results/` (verificado en disco, ANALISIS §2.4):
 * copiar solo el `.jsonl` produce una copia falsa que aun así pasa una comprobación de hash.
 */
export function discoverClaude(env: Env, homeOverride?: string): DiscoveryResult {
  const warnings: string[] = [];
  const sessions: DiscoveredSession[] = [];
  const memoryDirs: string[] = [];
  const projects = claudeProjectsDir(env, homeOverride);

  if (!statSafe(projects)?.isDirectory()) {
    return { sessions, memoryDirs, warnings };
  }

  for (const projectEntry of readdirSafe(projects, warnings)) {
    if (!projectEntry.isDirectory()) {
      continue;
    }
    const slug = projectEntry.name;
    const projectDir = path.join(projects, slug);

    const memory = claudeMemoryDir(env, slug, homeOverride);
    if (statSafe(memory)?.isDirectory()) {
      memoryDirs.push(memory);
    }

    for (const entry of readdirSafe(projectDir, warnings)) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }
      const sessionId = entry.name.slice(0, -'.jsonl'.length);
      if (!isSessionId(sessionId)) {
        continue;
      }
      const paths = claudeSessionPaths(env, slug, sessionId, homeOverride);
      const mainStat = statSafe(paths.transcript);
      if (!mainStat) {
        continue;
      }

      const parts: SessionPart[] = [
        {
          kind: 'main',
          path: paths.transcript,
          rel: 'main.jsonl',
          size: mainStat.size,
          mtimeMs: mainStat.mtimeMs,
        },
        ...filesIn(paths.subagents, 'subagent', 'subagents', warnings),
        ...filesIn(paths.toolResults, 'tool-result', 'tool-results', warnings),
      ];

      sessions.push({
        provider: 'claude-code',
        projectSlug: slug,
        sessionId,
        parts,
        totalBytes: parts.reduce((n, p) => n + p.size, 0),
        lastModified: parts.reduce((n, p) => Math.max(n, p.mtimeMs), 0),
      });
    }

    for (const name of NON_SESSION_DIRS) {
      const stray = path.join(projectDir, `${name}.jsonl`);
      if (statSafe(stray)) {
        warnings.push(`${stray}: nombre reservado, no se trata como sesión`);
      }
    }
  }

  return { sessions, memoryDirs, warnings };
}

/**
 * Codex: `sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, un fichero por sesión.
 * Los `.sqlite` de `~/.codex` quedan fuera de alcance a propósito: tienen WAL abierto y
 * copiarlos por rangos de bytes produce basura (hallazgo T-9).
 */
export function discoverCodex(env: Env): DiscoveryResult {
  const warnings: string[] = [];
  const sessions: DiscoveredSession[] = [];
  const root = codexSessionsDir(env);
  if (!statSafe(root)?.isDirectory()) {
    return { sessions, memoryDirs: [], warnings };
  }

  const walk = (dir: string, depth: number): void => {
    for (const entry of readdirSafe(dir, warnings)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) {
        continue;
      }
      const st = statSafe(full);
      if (!st) {
        continue;
      }
      const sessionId = entry.name.slice('rollout-'.length, -'.jsonl'.length);
      sessions.push({
        provider: 'codex',
        projectSlug: path.relative(root, dir).split(path.sep).join('-') || 'root',
        sessionId,
        parts: [{ kind: 'main', path: full, rel: 'main.jsonl', size: st.size, mtimeMs: st.mtimeMs }],
        totalBytes: st.size,
        lastModified: st.mtimeMs,
      });
    }
  };

  walk(root, 0);
  return { sessions, memoryDirs: [], warnings };
}

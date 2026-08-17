import * as fs from 'fs';
import * as path from 'path';
import type { DiscoveredSession, PartKind, Provider, SessionPart } from './discover';
import { generationsOf, readJson, statePath, type PartState, type SessionMeta } from './vault';

/**
 * Enumera lo que hay **en el almacén**, no en el disco del usuario.
 *
 * Sin esto, el día que la retención se lleva una sesión, esa sesión desaparece también de
 * la extensión: no se puede restaurar, no se puede exportar y el diagnóstico no la nombra
 * — justo el caso para el que existe el producto. La lista final es la unión de lo que hay
 * en el origen y lo que hay aquí.
 */
export function discoverVault(vaultRoot: string): DiscoveredSession[] {
  const out: DiscoveredSession[] = [];
  let providers: fs.Dirent[];
  try {
    providers = fs.readdirSync(vaultRoot, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const provider of providers) {
    if (!provider.isDirectory() || (provider.name !== 'claude-code' && provider.name !== 'codex')) {
      continue;
    }
    const providerDir = path.join(vaultRoot, provider.name);
    for (const project of readdirSafe(providerDir)) {
      if (!project.isDirectory()) {
        continue;
      }
      for (const session of readdirSafe(path.join(providerDir, project.name))) {
        if (!session.isDirectory()) {
          continue;
        }
        const dir = path.join(providerDir, project.name, session.name);
        const restored = sessionFromVault(dir, provider.name as Provider);
        if (restored) {
          out.push(restored);
        }
      }
    }
  }
  return out;
}

function readdirSafe(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function kindOf(rel: string): PartKind {
  if (rel.startsWith('subagents/')) {
    return 'subagent';
  }
  if (rel.startsWith('tool-results/')) {
    return 'tool-result';
  }
  return 'main';
}

function sessionFromVault(dir: string, provider: Provider): DiscoveredSession | undefined {
  let meta: SessionMeta | undefined;
  try {
    meta = readJson<SessionMeta>(path.join(dir, 'meta.json'));
  } catch {
    return undefined; // meta ilegible: se ignora, pero no se rompe el listado
  }
  if (!meta) {
    return undefined;
  }

  const parts: SessionPart[] = [];
  let lastModified = Date.parse(meta.lastBackupAt) || 0;

  for (const part of readdirSafe(path.join(dir, 'parts'))) {
    if (!part.isDirectory()) {
      continue;
    }
    const base = path.join(dir, 'parts', part.name);
    const generations = generationsOf(base);
    if (!generations.length) {
      continue;
    }
    let state: PartState | undefined;
    try {
      state = readJson<PartState>(statePath(base, generations[generations.length - 1]));
    } catch {
      continue;
    }
    if (!state) {
      continue;
    }
    const source =
      meta.parts?.find((p) => p.rel === state!.rel)?.path ??
      originalPathOf(meta, state.rel);
    parts.push({
      kind: kindOf(state.rel),
      path: source,
      rel: state.rel,
      size: state.copiedBytes,
      mtimeMs: Date.parse(state.updatedAt) || lastModified,
    });
    lastModified = Math.max(lastModified, Date.parse(state.updatedAt) || 0);
  }

  if (!parts.length) {
    return undefined;
  }

  return {
    provider,
    projectSlug: meta.projectSlug,
    sessionId: meta.sessionId,
    parts,
    totalBytes: parts.reduce((n, p) => n + p.size, 0),
    lastModified,
  };
}

/** Compatibilidad con almacenes escritos antes de que `meta.json` guardara las rutas. */
function originalPathOf(meta: SessionMeta, rel: string): string {
  if (rel === 'main.jsonl') {
    return path.join(meta.sourceRoot, `${meta.sessionId}.jsonl`);
  }
  return path.join(meta.sourceRoot, meta.sessionId, ...rel.split('/'));
}

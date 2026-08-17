/**
 * Resolución pura de rutas de los proveedores. Sin dependencias de 'vscode' ni de fs:
 * todo entra por parámetro (plataforma, variables de entorno, home) para poder testear
 * el caso win32 y el posix en la misma máquina.
 *
 * Verificado en disco el 2026-08-17 (ver docs/ANALISIS.md §5.1): una sesión de Claude Code
 * NO es un fichero suelto, es un fichero más un directorio hermano con el mismo id.
 */

import * as pathPosix from 'path/posix';
import * as pathWin32 from 'path/win32';

export type Platform = 'win32' | 'posix';

export interface Env {
  readonly platform: Platform;
  readonly home: string;
  readonly vars: Readonly<Record<string, string | undefined>>;
}

function p(platform: Platform): pathPosix.PlatformPath {
  return platform === 'win32' ? pathWin32 : pathPosix;
}

/** Un id de sesión es un UUID. Cualquier otra cosa dentro de un proyecto NO es una sesión. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(name: string): boolean {
  return SESSION_ID.test(name);
}

/**
 * Directorios que viven dentro de `projects/<slug>/` y que no son sesiones.
 * `memory/` es la memoria persistente del usuario: se respalda como artefacto propio,
 * nunca se confunde con una sesión (hallazgo T-12 de la auditoría).
 */
export const NON_SESSION_DIRS: readonly string[] = ['memory'];

export function claudeHome(env: Env, override?: string): string {
  if (override && override.trim()) {
    return override.trim();
  }
  const configured = env.vars.CLAUDE_CONFIG_DIR;
  if (configured && configured.trim()) {
    return configured.trim();
  }
  return p(env.platform).join(env.home, '.claude');
}

export function claudeProjectsDir(env: Env, override?: string): string {
  return p(env.platform).join(claudeHome(env, override), 'projects');
}

/**
 * Slug de proyecto: la ruta de trabajo con los caracteres no alfanuméricos convertidos en `-`.
 * Si el resultado pasa de 200 caracteres, Claude Code lo trunca y le añade un hash del
 * original; aquí solo truncamos, porque el hash exacto no está documentado y el
 * descubrimiento se hace leyendo el directorio, no adivinando el nombre.
 */
export function projectSlug(cwd: string): { slug: string; truncated: boolean } {
  const raw = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (raw.length <= 200) {
    return { slug: raw, truncated: false };
  }
  return { slug: raw.slice(0, 200), truncated: true };
}

export interface ClaudeSessionPaths {
  /** La transcripción: `projects/<slug>/<id>.jsonl` */
  readonly transcript: string;
  /** Directorio hermano con las partes grandes: `projects/<slug>/<id>/` */
  readonly dir: string;
  /** `projects/<slug>/<id>/subagents/` — transcripciones de subagentes */
  readonly subagents: string;
  /** `projects/<slug>/<id>/tool-results/` — salidas grandes derramadas a fichero */
  readonly toolResults: string;
}

export function claudeSessionPaths(
  env: Env,
  slug: string,
  sessionId: string,
  override?: string,
): ClaudeSessionPaths {
  const path = p(env.platform);
  const base = path.join(claudeProjectsDir(env, override), slug);
  const dir = path.join(base, sessionId);
  return {
    transcript: path.join(base, `${sessionId}.jsonl`),
    dir,
    subagents: path.join(dir, 'subagents'),
    toolResults: path.join(dir, 'tool-results'),
  };
}

/** Memoria persistente del proyecto: `projects/<slug>/memory/`. */
export function claudeMemoryDir(env: Env, slug: string, override?: string): string {
  return p(env.platform).join(claudeProjectsDir(env, override), slug, 'memory');
}

/** Sesiones vivas: `sessions/<pid>.json`. Ojo: quedan ficheros obsoletos (hallazgo T-4). */
export function claudeLiveSessionsDir(env: Env, override?: string): string {
  return p(env.platform).join(claudeHome(env, override), 'sessions');
}

/** Historial de contenidos de ficheros por sesión: `file-history/<sessionId>/`. Opcional. */
export function claudeFileHistoryDir(env: Env, override?: string): string {
  return p(env.platform).join(claudeHome(env, override), 'file-history');
}

/** Sesiones de la app de escritorio, donde ocurrieron las pérdidas más sonadas. */
export function claudeDesktopSessionsDir(env: Env): string | undefined {
  const path = p(env.platform);
  if (env.platform === 'win32') {
    const appData = env.vars.APPDATA;
    if (!appData) {
      return undefined;
    }
    return path.join(appData, 'Claude', 'claude-code-sessions');
  }
  if (env.vars.SESSIONKEEPER_PLATFORM_DARWIN === '1') {
    return path.join(env.home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  }
  return path.join(env.home, '.config', 'Claude', 'claude-code-sessions');
}

export function codexHome(env: Env): string {
  const configured = env.vars.CODEX_HOME;
  if (configured && configured.trim()) {
    return configured.trim();
  }
  return p(env.platform).join(env.home, '.codex');
}

export function codexSessionsDir(env: Env): string {
  return p(env.platform).join(codexHome(env), 'sessions');
}

/** Carpeta por defecto del almacén cuando el usuario no configura ninguna. */
export function defaultVaultRoot(env: Env): string {
  const path = p(env.platform);
  if (env.platform === 'win32') {
    const local = env.vars.LOCALAPPDATA ?? path.join(env.home, 'AppData', 'Local');
    return path.join(local, 'SessionKeeper', 'vault');
  }
  const xdg = env.vars.XDG_DATA_HOME;
  if (xdg && xdg.trim()) {
    return path.join(xdg.trim(), 'sessionkeeper', 'vault');
  }
  return path.join(env.home, '.local', 'share', 'sessionkeeper', 'vault');
}

/**
 * Nombre del proyecto dentro del almacén. El slug original puede llegar a 200 caracteres
 * y hacer que la ruta final pase de MAX_PATH en Windows (hallazgo T-11), así que en el
 * almacén se guarda acortado con un hash delante; el slug completo va en `meta.json`.
 */
export function vaultProjectDirName(slug: string, hash8: string): string {
  return `${hash8}-${slug.slice(0, 40)}`;
}

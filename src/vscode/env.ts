import * as os from 'os';
import type { Env, Platform } from '../core/paths';

export function currentPlatform(): Platform {
  return process.platform === 'win32' ? 'win32' : 'posix';
}

/** Env real del proceso, para pasárselo a las funciones puras de `core/`. */
export function currentEnv(): Env {
  const vars: Record<string, string | undefined> = { ...process.env };
  if (process.platform === 'darwin') {
    vars.SESSIONKEEPER_PLATFORM_DARWIN = '1';
  }
  return {
    platform: currentPlatform(),
    home: os.homedir(),
    vars,
  };
}

let channel: { appendLine(line: string): void } | undefined;

/** El canal de salida se inyecta al activar, para que `core/` y `pro/` no dependan de la UI. */
export function setLogChannel(target: { appendLine(line: string): void }): void {
  channel = target;
}

export function log(line: string): void {
  channel?.appendLine(`${new Date().toISOString()} ${line}`);
}

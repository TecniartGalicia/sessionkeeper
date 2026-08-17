import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Env } from '../../core/paths';

/**
 * Cada test monta su propio `CLAUDE_CONFIG_DIR` en un directorio temporal.
 * Regla del proyecto: los tests NUNCA leen ni escriben en el `~/.claude` real.
 */
export interface Sandbox {
  readonly root: string;
  readonly claudeHome: string;
  readonly vault: string;
  readonly env: Env;
  dispose(): void;
}

export function makeSandbox(name: string): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sk-${name}-`));
  const claudeHome = path.join(root, 'claude');
  const vault = path.join(root, 'vault');
  fs.mkdirSync(path.join(claudeHome, 'projects'), { recursive: true });
  fs.mkdirSync(vault, { recursive: true });

  const env: Env = {
    platform: process.platform === 'win32' ? 'win32' : 'posix',
    home: root,
    vars: { CLAUDE_CONFIG_DIR: claudeHome },
  };

  return {
    root,
    claudeHome,
    vault,
    env,
    dispose(): void {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function jsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

export function line(type: string, extra: Record<string, unknown> = {}): unknown {
  return { type, timestamp: new Date().toISOString(), ...extra };
}

/** Crea una sesión completa: transcripción + subagentes + salidas de herramientas. */
export function writeSession(
  sandbox: Sandbox,
  slug: string,
  sessionId: string,
  options: { messages?: number; subagents?: number; toolResults?: number } = {},
): string {
  const projects = path.join(sandbox.claudeHome, 'projects', slug);
  fs.mkdirSync(projects, { recursive: true });

  const messages = options.messages ?? 3;
  const transcript = path.join(projects, `${sessionId}.jsonl`);
  fs.writeFileSync(
    transcript,
    jsonl(Array.from({ length: messages }, (_, i) => line(i % 2 ? 'assistant' : 'user', { i, sessionId }))),
  );

  if (options.subagents) {
    const dir = path.join(projects, sessionId, 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < options.subagents; i++) {
      fs.writeFileSync(path.join(dir, `agent-${i}.jsonl`), jsonl([line('assistant', { agent: i })]));
      fs.writeFileSync(path.join(dir, `agent-${i}.meta.json`), JSON.stringify({ agent: i }));
    }
  }

  if (options.toolResults) {
    const dir = path.join(projects, sessionId, 'tool-results');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < options.toolResults; i++) {
      fs.writeFileSync(path.join(dir, `toolu_${i}.txt`), `salida grande ${i}\n`.repeat(10));
    }
  }

  return transcript;
}

export function appendLines(file: string, lines: unknown[]): void {
  fs.appendFileSync(file, jsonl(lines));
}

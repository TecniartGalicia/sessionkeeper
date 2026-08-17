import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { currentEnv } from './vscode/env';
import {
  claudeDesktopSessionsDir,
  claudeHome,
  claudeProjectsDir,
  codexSessionsDir,
  defaultVaultRoot,
} from './core/paths';
import { SessionsProvider } from './view/sessionsView';

let output: vscode.OutputChannel | undefined;

function log(message: string): void {
  output?.appendLine(`${new Date().toISOString()} ${message}`);
}

/** Envuelve un comando para que ningún fallo llegue como "command failed" sin explicación. */
function wrap(name: string, fn: () => Promise<void> | void): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`ERROR ${name}: ${message}`);
      void vscode.window.showErrorMessage(l10n.t('SessionKeeper: {0}', message));
    }
  };
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('SessionKeeper');
  context.subscriptions.push(output);

  const provider = new SessionsProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('sessionkeeper.sessions', provider),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'sessionkeeper.refresh',
      wrap('refresh', () => provider.refresh()),
    ),
    vscode.commands.registerCommand(
      'sessionkeeper.showStorage',
      wrap('showStorage', () => showStorage()),
    ),
    vscode.commands.registerCommand('sessionkeeper.showLog', () => output?.show(true)),
  );

  log('activated');
}

/** Dónde busca SessionKeeper y dónde guardaría la copia. Solo lectura, sin tocar nada. */
async function showStorage(): Promise<void> {
  const env = currentEnv();
  const config = vscode.workspace.getConfiguration('sessionkeeper');
  const homeOverride = config.get<string>('claudeHome')?.trim() || undefined;
  const vaultOverride = config.get<string>('vaultPath')?.trim() || undefined;

  const lines = [
    `# ${l10n.t('Storage locations')}`,
    '',
    `- Claude Code: \`${claudeProjectsDir(env, homeOverride)}\``,
    `- Claude Code (${l10n.t('config')}): \`${claudeHome(env, homeOverride)}\``,
    `- Claude ${l10n.t('desktop app')}: \`${claudeDesktopSessionsDir(env) ?? '—'}\``,
    `- Codex: \`${codexSessionsDir(env)}\``,
    `- ${l10n.t('Vault')}: \`${vaultOverride ?? defaultVaultRoot(env)}\``,
  ];

  const doc = await vscode.workspace.openTextDocument({
    content: lines.join('\n'),
    language: 'markdown',
  });
  await vscode.window.showTextDocument(doc, { preview: true });
}

export function deactivate(): void {
  output = undefined;
}

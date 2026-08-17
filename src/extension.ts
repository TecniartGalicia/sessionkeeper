import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { currentEnv } from './vscode/env';
import {
  claudeDesktopSessionsDir,
  claudeHome,
  claudeProjectsDir,
  codexSessionsDir,
} from './core/paths';
import { formatBytes } from './core/status';
import { Keeper } from './service/keeper';
import { SessionsProvider, type Node } from './view/sessionsView';

let output: vscode.OutputChannel | undefined;

function log(message: string): void {
  output?.appendLine(`${new Date().toISOString()} ${message}`);
}

function keeper(): Keeper {
  const config = vscode.workspace.getConfiguration('sessionkeeper');
  return new Keeper({
    env: currentEnv(),
    vaultPath: config.get<string>('vaultPath')?.trim() || undefined,
    claudeHome: config.get<string>('claudeHome')?.trim() || undefined,
    includeCodex: config.get<boolean>('includeCodex') ?? false,
  });
}

function wrap(name: string, fn: (...args: never[]) => Promise<void> | void) {
  return async (...args: never[]): Promise<void> => {
    try {
      await fn(...args);
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

  const provider = new SessionsProvider(keeper);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('sessionkeeper.sessions', provider),
    vscode.commands.registerCommand('sessionkeeper.refresh', wrap('refresh', () => provider.refresh())),
    vscode.commands.registerCommand('sessionkeeper.backupAll', wrap('backupAll', () => backupAll(provider))),
    vscode.commands.registerCommand('sessionkeeper.backupSession', wrap('backupSession', (node: Node) => backupOne(provider, node))),
    vscode.commands.registerCommand('sessionkeeper.restoreSession', wrap('restoreSession', (node: Node) => restore(provider, node))),
    vscode.commands.registerCommand('sessionkeeper.exportSession', wrap('exportSession', (node: Node) => exportOne(node))),
    vscode.commands.registerCommand('sessionkeeper.doctor', wrap('doctor', () => doctor(provider))),
    vscode.commands.registerCommand('sessionkeeper.openVault', wrap('openVault', () => openVault())),
    vscode.commands.registerCommand('sessionkeeper.showStorage', wrap('showStorage', () => showStorage())),
    vscode.commands.registerCommand('sessionkeeper.showLog', () => output?.show(true)),
  );

  provider.refresh();
  warnAboutRemote();
  log('activated');
}

/**
 * En una ventana remota (WSL, contenedor, SSH) la extensión corre en el remoto: ve el
 * `~/.claude` de ese lado y guardaría el almacén en un sistema de ficheros que puede
 * desaparecer al reconstruir el contenedor. Copia de seguridad que se borra sola.
 */
function warnAboutRemote(): void {
  const remote = vscode.env.remoteName;
  if (!remote) {
    return;
  }
  const configured = vscode.workspace.getConfiguration('sessionkeeper').get<string>('vaultPath')?.trim();
  if (configured) {
    return;
  }
  void vscode.window.showWarningMessage(
    l10n.t('This is a {0} window: SessionKeeper sees the remote sessions and would store the vault there, where it may not survive. Set "sessionkeeper.vaultPath" to a folder that persists.', remote),
  );
}

async function openMarkdown(content: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function backupAll(provider: SessionsProvider): Promise<void> {
  provider.refresh();
  const pending = provider.sessionsNeedingBackup();
  if (!pending.length) {
    void vscode.window.showInformationMessage(l10n.t('Everything is already backed up.'));
    return;
  }

  const k = keeper();
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: l10n.t('SessionKeeper: backing up'), cancellable: true },
    async (progress, token) => {
      const outcome = k.backup(pending, (done, total, current) => {
        progress.report({
          message: l10n.t('{0} of {1} · {2}', done + 1, total, current.slice(0, 8)),
          increment: 100 / total,
        });
        return !token.isCancellationRequested;
      });

      log(`backup: ${outcome.sessions} sesiones, ${formatBytes(outcome.bytesCopied)}`);
      for (const rotation of outcome.rotated) {
        log(`rotación: ${rotation}`);
      }

      provider.refresh();
      const parts = [
        l10n.t('{0} sessions backed up ({1})', outcome.sessions, formatBytes(outcome.bytesCopied)),
      ];
      if (outcome.rotated.length) {
        parts.push(l10n.t('{0} changed on disk and got a new version', outcome.rotated.length));
      }
      if (outcome.secrets.length) {
        parts.push(
          l10n.t('credentials detected in the transcripts ({0}) — keep the vault private', outcome.secrets.map((s) => s.label).join(', ')),
        );
      }

      if (outcome.budgetReached) {
        void vscode.window.showWarningMessage(
          l10n.t('Disk budget reached: nothing was deleted, but some sessions were not copied. Raise the budget in the vault manifest or free space.'),
        );
      }

      if (outcome.errors.length) {
        for (const failure of outcome.errors) {
          log(`ERROR copia: ${failure}`);
        }
        void vscode.window.showWarningMessage(
          l10n.t('{0} parts could not be copied — see the log', outcome.errors.length),
          l10n.t('Show log'),
        ).then((choice) => {
          if (choice) {
            output?.show(true);
          }
        });
      }
      void vscode.window.showInformationMessage(parts.join(' · '));
    },
  );
}

async function backupOne(provider: SessionsProvider, node: Node): Promise<void> {
  if (node?.kind !== 'session') {
    await backupAll(provider);
    return;
  }
  const outcome = keeper().backup([node.view.session]);
  provider.refresh();
  void vscode.window.showInformationMessage(
    l10n.t('Backed up {0}', formatBytes(outcome.bytesCopied)),
  );
}

async function restore(provider: SessionsProvider, node: Node): Promise<void> {
  if (node?.kind !== 'session') {
    void vscode.window.showWarningMessage(l10n.t('Pick a session in the SessionKeeper view first.'));
    return;
  }
  const k = keeper();
  const { session } = node.view;

  if (k.isLive(session)) {
    void vscode.window.showWarningMessage(
      l10n.t('That session is running right now. Close it before restoring — writing over a live transcript loses whatever the agent writes next.'),
    );
    return;
  }

  const overwriteLabel = l10n.t('Overwrite the original');
  const sidecarLabel = l10n.t('Write next to it (.restored)');
  const choice = await vscode.window.showWarningMessage(
    l10n.t('Restore session {0}?', session.sessionId.slice(0, 8)),
    { modal: true, detail: l10n.t('A copy of whatever is on disk is saved first, and can be undone. Restoring a session outside its original folder leaves a duplicate, and a duplicate makes "claude --resume" report not found.') },
    sidecarLabel,
    overwriteLabel,
  );
  if (!choice) {
    return;
  }

  const results = k.restore(session, { overwrite: choice === overwriteLabel });
  provider.refresh();
  log(`restore: ${results.map((r) => `${r.rel} → ${r.target}`).join(', ')}`);
  void vscode.window.showInformationMessage(
    l10n.t('Restored {0} files. Previous contents saved in the vault.', results.length),
  );
}

async function exportOne(node: Node): Promise<void> {
  if (node?.kind !== 'session') {
    void vscode.window.showWarningMessage(l10n.t('Pick a session in the SessionKeeper view first.'));
    return;
  }
  const { session } = node.view;
  const result = keeper().export(session, session.sessionId);
  await openMarkdown(result.markdown);
  if (result.secrets.length) {
    void vscode.window.showWarningMessage(
      l10n.t('Credentials were replaced in the export: {0}', result.secrets.map((s) => s.label).join(', ')),
    );
  }
}

async function doctor(provider: SessionsProvider): Promise<void> {
  provider.refresh();
  const report = keeper().doctor(provider.all.map((v) => v.session));
  await openMarkdown(report.markdown);
}

async function openVault(): Promise<void> {
  const root = keeper().vaultRoot;
  await vscode.env.openExternal(vscode.Uri.file(root));
}

async function showStorage(): Promise<void> {
  const env = currentEnv();
  const config = vscode.workspace.getConfiguration('sessionkeeper');
  const homeOverride = config.get<string>('claudeHome')?.trim() || undefined;
  const k = keeper();

  await openMarkdown(
    [
      `# ${l10n.t('Storage locations')}`,
      '',
      `- Claude Code: \`${claudeProjectsDir(env, homeOverride)}\``,
      `- Claude Code (${l10n.t('config')}): \`${claudeHome(env, homeOverride)}\``,
      `- Claude ${l10n.t('desktop app')}: \`${claudeDesktopSessionsDir(env) ?? '—'}\``,
      `- Codex: \`${codexSessionsDir(env)}\``,
      `- ${l10n.t('Vault')}: \`${k.vaultRoot}\` (${formatBytes(k.vaultBytes())})`,
      '',
      l10n.t('SessionKeeper only reads the folders above. It only ever writes inside the vault.'),
    ].join('\n'),
  );
}

export function deactivate(): void {
  output = undefined;
}

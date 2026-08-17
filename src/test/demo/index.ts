import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Guion de la demo: deja la extensión en los tres estados que enseña la ficha, con una
 * pausa en cada uno para poder capturar la ventana. No es un test: no afirma nada.
 */
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function run(): Promise<void> {
  const claudeHome = process.env.SK_DEMO_CLAUDE_HOME!;
  const shots = path.join(__dirname, '../../../media/shots');
  fs.mkdirSync(shots, { recursive: true });
  const mark = (name: string): void => fs.writeFileSync(path.join(shots, `.step-${name}`), new Date().toISOString());

  const ext = vscode.extensions.getExtension('argalla.sessionkeeper');
  await ext?.activate();

  // Ventana limpia para la ficha: sin panel de chat, sin barra de estado de depuración y
  // sin el aviso de "extensiones desactivadas" del modo desarrollo.
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.view.extension.sessionkeeper');
  await pause(2500);

  // 1) el árbol con todo por copiar
  await vscode.commands.executeCommand('notifications.clearAll');
  mark('01-pendientes');
  await pause(6000);

  // 2) copiar todo → estados en verde
  await vscode.commands.executeCommand('sessionkeeper.backupAll');
  await pause(6000);
  mark('02-copiadas');
  await pause(6000);

  // 3) una sesión desaparece del disco: sigue estando, ya solo en el almacén
  const victim = path.join(
    claudeHome,
    'projects',
    'c--work-billing-api',
    '91ab77cd-2211-4f60-b8aa-cc1122334455.jsonl',
  );
  fs.rmSync(victim, { force: true });
  fs.rmSync(victim.replace('.jsonl', ''), { recursive: true, force: true });
  await vscode.commands.executeCommand('sessionkeeper.refresh');
  await vscode.commands.executeCommand('notifications.clearAll');
  await pause(2000);
  mark('03-huerfana');
  await pause(6000);

  // 4) el diagnóstico
  await vscode.commands.executeCommand('sessionkeeper.doctor');
  await pause(2000);
  await vscode.commands.executeCommand('notifications.clearAll');
  await pause(1000);
  mark('04-doctor');
  await pause(8000);
}

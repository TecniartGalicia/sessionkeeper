import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const CLAUDE_HOME = process.env.SK_IT_CLAUDE_HOME!;
const VAULT = process.env.SK_IT_VAULT!;
const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

describe('SessionKeeper (integración)', function () {
  this.timeout(30000);

  it('se activa y registra sus comandos', async () => {
    const ext = vscode.extensions.getExtension('argalla.sessionkeeper');
    assert.ok(ext, 'la extensión debería estar instalada');
    await ext!.activate();

    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'sessionkeeper.backupAll',
      'sessionkeeper.restoreSession',
      'sessionkeeper.doctor',
      'sessionkeeper.showStorage',
    ]) {
      assert.ok(commands.includes(id), `falta el comando ${id}`);
    }
  });

  it('copia la sesión de prueba entera, con su subagente', async () => {
    await vscode.commands.executeCommand('sessionkeeper.backupAll');

    // Deja tiempo a que termine la notificación de progreso.
    await new Promise((r) => setTimeout(r, 1500));

    const files = walk(VAULT);
    assert.ok(files.some((f) => f.endsWith('manifest.json')), 'debería haber manifest');
    assert.ok(files.some((f) => f.endsWith('RESTORE.md')), 'debería haber instrucciones de recuperación');
    assert.ok(files.some((f) => f.endsWith('restore.mjs')), 'debería haber script de recuperación');
    assert.ok(files.some((f) => f.includes(SESSION) && f.endsWith('meta.json')), 'debería haber meta de la sesión');

    const chunks = files.filter((f) => f.endsWith('.gz'));
    assert.ok(chunks.length >= 2, `debería haber al menos 2 trozos (transcripción y subagente), hay ${chunks.length}`);
  });

  it('no escribe nada fuera del almacén', async () => {
    const before = walk(CLAUDE_HOME).map((f) => `${f}:${fs.statSync(f).size}`).sort();
    await vscode.commands.executeCommand('sessionkeeper.backupAll');
    await new Promise((r) => setTimeout(r, 1000));
    const after = walk(CLAUDE_HOME).map((f) => `${f}:${fs.statSync(f).size}`).sort();
    assert.deepStrictEqual(after, before, 'el directorio de Claude Code no puede cambiar');
  });

  it('el diagnóstico abre un informe sin tocar nada', async () => {
    await vscode.commands.executeCommand('sessionkeeper.doctor');
    const doc = vscode.window.activeTextEditor?.document;
    assert.ok(doc, 'debería abrirse un documento');
    assert.strictEqual(doc!.languageId, 'markdown');
    assert.ok(doc!.getText().includes('SessionKeeper'), 'el informe debería llevar cabecera');
  });
});

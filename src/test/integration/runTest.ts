import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * Integración hermética:
 *  - se monta un `CLAUDE_CONFIG_DIR` de mentira con sesiones falsas y un almacén temporal;
 *  - VS Code arranca con su propio `--user-data-dir` y sin más extensiones.
 *
 * El `~/.claude` real del desarrollador NO se toca nunca: es una regla del proyecto.
 * `SK_VSCODE_EXE` permite correr la misma suite en VSCodium o Cursor.
 */
async function main(): Promise<void> {
  // Lanzado desde un terminal dentro de VS Code, el host deja ELECTRON_RUN_AS_NODE=1 y el
  // VS Code de pruebas arrancaría como Node pelado ("bad option: --...").
  delete process.env.ELECTRON_RUN_AS_NODE;

  const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-it-'));
  const claudeHome = path.join(tmp, 'claude');
  const vault = path.join(tmp, 'vault');
  const workspace = path.join(tmp, 'workspace');
  const project = path.join(claudeHome, 'projects', 'c--tmp-demo');
  fs.mkdirSync(path.join(project, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'subagents'), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(vault, { recursive: true });

  const entry = (type: string, text: string): string =>
    JSON.stringify({ type, timestamp: new Date().toISOString(), message: { role: type, content: [{ type: 'text', text }] } });
  fs.writeFileSync(
    path.join(project, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl'),
    [entry('user', 'arregla el login'), entry('assistant', 'hecho'), ''].join('\n'),
  );
  fs.writeFileSync(
    path.join(project, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'subagents', 'agent-1.jsonl'),
    entry('assistant', 'subagente') + '\n',
  );
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify({ model: 'test' }));

  const vscodeExecutablePath = process.env.SK_VSCODE_EXE || undefined;
  if (vscodeExecutablePath) {
    console.log(`Suite de integración en: ${vscodeExecutablePath}`);
  }
  const userDataDir = path.join(extensionDevelopmentPath, '.vscode-test', 'user-data');
  fs.rmSync(path.join(userDataDir, 'User', 'globalStorage', 'argalla.sessionkeeper'), {
    recursive: true,
    force: true,
  });

  // Los ajustes de la extensión se fijan por settings del usuario de ESE VS Code de pruebas.
  const userSettings = path.join(userDataDir, 'User', 'settings.json');
  fs.mkdirSync(path.dirname(userSettings), { recursive: true });
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(userSettings, 'utf8')) as Record<string, unknown>;
  } catch {
    /* primera vez */
  }
  settings['sessionkeeper.claudeHome'] = claudeHome;
  settings['sessionkeeper.vaultPath'] = vault;
  fs.writeFileSync(userSettings, JSON.stringify(settings, null, 2));

  try {
    await runTests({
      ...(vscodeExecutablePath ? { vscodeExecutablePath } : {}),
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspace,
        `--user-data-dir=${userDataDir}`,
        '--disable-extensions',
        '--disable-workspace-trust',
      ],
      extensionTestsEnv: { SK_IT_CLAUDE_HOME: claudeHome, SK_IT_VAULT: vault, SK_IT_TMP: tmp },
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Los tests de integración han fallado', err);
  process.exit(1);
});

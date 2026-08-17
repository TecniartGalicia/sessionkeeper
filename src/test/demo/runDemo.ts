import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * Lanza un VS Code de pruebas con un `~/.claude` de mentira poblado a mano y deja la vista
 * abierta el tiempo suficiente para hacer capturas de la ficha. No toca nada real: el
 * `CLAUDE_CONFIG_DIR` y el almacén viven en un directorio temporal que se borra al salir.
 *
 * Uso: npm run demo  (y en paralelo, el script de captura de ventana)
 */
function entry(type: string, text: string, minutesAgo: number): string {
  return JSON.stringify({
    type,
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    message: { role: type, content: [{ type: 'text', text }] },
  });
}

async function main(): Promise<void> {
  delete process.env.ELECTRON_RUN_AS_NODE;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-demo-'));
  const claudeHome = path.join(tmp, 'claude');
  const vault = path.join(tmp, 'vault');
  const workspace = path.join(tmp, 'checkout-service');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(vault, { recursive: true });

  const projects: Array<[string, string[]]> = [
    ['c--work-checkout-service', ['3f2b1c44-9a01-4b7e-8c31-5d0e7a9b1122', '7c1d9e02-4b55-4a10-9f22-1188aa22bb33']],
    ['c--work-billing-api', ['91ab77cd-2211-4f60-b8aa-cc1122334455']],
    ['c--work-mobile-app', ['a1b2c3d4-5566-4778-899a-bbccddeeff00']],
  ];

  const prompts = [
    'arregla el 500 al aplicar un cupón caducado',
    'por qué el webhook de pagos llega dos veces',
    'migra el cálculo de IVA a la nueva tabla',
    'revisa por qué la app pierde la sesión al volver del pago',
  ];

  let n = 0;
  for (const [slug, ids] of projects) {
    const dir = path.join(claudeHome, 'projects', slug);
    fs.mkdirSync(dir, { recursive: true });
    for (const id of ids) {
      const lines: string[] = [];
      for (let i = 0; i < 40; i++) {
        lines.push(entry(i % 2 ? 'assistant' : 'user', i === 0 ? prompts[n % prompts.length] : `paso ${i}: ${'detalle '.repeat(20)}`, 600 - i));
      }
      fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.join('\n') + '\n');
      const subagents = path.join(dir, id, 'subagents');
      fs.mkdirSync(subagents, { recursive: true });
      fs.writeFileSync(path.join(subagents, 'agent-1.jsonl'), entry('assistant', 'subagente: repaso de los tests', 300) + '\n');
      n++;
    }
    fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '# decisiones del proyecto\n');
  }

  fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify({ model: 'demo' }, null, 2));

  const userDataDir = path.join(path.resolve(__dirname, '../../../'), '.vscode-test', 'demo-user-data');
  const userSettings = path.join(userDataDir, 'User', 'settings.json');
  fs.mkdirSync(path.dirname(userSettings), { recursive: true });
  fs.writeFileSync(
    userSettings,
    JSON.stringify(
      {
        'sessionkeeper.claudeHome': claudeHome,
        'sessionkeeper.vaultPath': vault,
        'workbench.colorTheme': 'Default Dark Modern',
        'window.zoomLevel': 0,
        'workbench.startupEditor': 'none',
        'workbench.tips.enabled': false,
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
      },
      null,
      2,
    ),
  );

  try {
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, '../../../'),
      extensionTestsPath: path.resolve(__dirname, './index'),
      launchArgs: [
        workspace,
        `--user-data-dir=${userDataDir}`,
        '--disable-extensions',
        '--disable-workspace-trust',
      ],
      extensionTestsEnv: { SK_DEMO_CLAUDE_HOME: claudeHome, SK_DEMO_VAULT: vault, SK_DEMO: '1' },
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('demo falló', err);
  process.exit(1);
});

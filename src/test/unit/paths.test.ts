import * as assert from 'assert';
import {
  claudeDesktopSessionsDir,
  claudeHome,
  claudeMemoryDir,
  claudeProjectsDir,
  claudeSessionPaths,
  codexSessionsDir,
  defaultVaultRoot,
  isSessionId,
  NON_SESSION_DIRS,
  projectSlug,
  vaultProjectDirName,
  type Env,
} from '../../core/paths';

const win: Env = {
  platform: 'win32',
  home: 'C:\\Users\\kirne',
  vars: { APPDATA: 'C:\\Users\\kirne\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\kirne\\AppData\\Local' },
};

const nix: Env = { platform: 'posix', home: '/home/dev', vars: {} };

describe('core/paths', () => {
  it('resuelve la carpeta de Claude Code en Windows y en POSIX', () => {
    assert.strictEqual(claudeHome(win), 'C:\\Users\\kirne\\.claude');
    assert.strictEqual(claudeHome(nix), '/home/dev/.claude');
    assert.strictEqual(claudeProjectsDir(nix), '/home/dev/.claude/projects');
  });

  it('respeta CLAUDE_CONFIG_DIR y el ajuste del usuario, en ese orden', () => {
    const env: Env = { ...nix, vars: { CLAUDE_CONFIG_DIR: '/data/claude' } };
    assert.strictEqual(claudeHome(env), '/data/claude');
    assert.strictEqual(claudeHome(env, '/otro/sitio'), '/otro/sitio');
    assert.strictEqual(claudeHome(env, '   '), '/data/claude', 'un ajuste en blanco no cuenta');
  });

  it('una sesión es un fichero MÁS un directorio hermano', () => {
    const s = claudeSessionPaths(nix, 'home-dev-app', '73425e8d-12ef-4bdc-8976-0e5b6db7694a');
    assert.strictEqual(s.transcript, '/home/dev/.claude/projects/home-dev-app/73425e8d-12ef-4bdc-8976-0e5b6db7694a.jsonl');
    assert.strictEqual(s.dir, '/home/dev/.claude/projects/home-dev-app/73425e8d-12ef-4bdc-8976-0e5b6db7694a');
    assert.ok(s.subagents.endsWith('/subagents'));
    assert.ok(s.toolResults.endsWith('/tool-results'));
  });

  it('reconoce ids de sesión y descarta lo que no lo es', () => {
    assert.ok(isSessionId('73425e8d-12ef-4bdc-8976-0e5b6db7694a'));
    assert.ok(isSessionId('73425E8D-12EF-4BDC-8976-0E5B6DD7694A'));
    assert.ok(!isSessionId('memory'), 'memory no es una sesión');
    assert.ok(!isSessionId('73425e8d-12ef-4bdc-8976'), 'un uuid incompleto no vale');
    assert.ok(!isSessionId(''));
    for (const dir of NON_SESSION_DIRS) {
      assert.ok(!isSessionId(dir), `${dir} no puede tomarse por sesión`);
    }
  });

  it('la memoria del proyecto tiene su propia ruta', () => {
    assert.strictEqual(claudeMemoryDir(nix, 'home-dev-app'), '/home/dev/.claude/projects/home-dev-app/memory');
  });

  it('convierte la ruta de trabajo en slug y trunca a 200', () => {
    assert.deepStrictEqual(projectSlug('c:\\Users\\kirne'), { slug: 'c--Users-kirne', truncated: false });
    assert.deepStrictEqual(projectSlug('/home/dev/mi app'), { slug: '-home-dev-mi-app', truncated: false });
    const largo = projectSlug('/' + 'a'.repeat(300));
    assert.strictEqual(largo.slug.length, 200);
    assert.ok(largo.truncated);
  });

  it('localiza la app de escritorio en cada plataforma', () => {
    assert.strictEqual(claudeDesktopSessionsDir(win), 'C:\\Users\\kirne\\AppData\\Roaming\\Claude\\claude-code-sessions');
    assert.strictEqual(claudeDesktopSessionsDir(nix), '/home/dev/.config/Claude/claude-code-sessions');
    const mac: Env = { ...nix, vars: { SESSIONKEEPER_PLATFORM_DARWIN: '1' } };
    assert.ok(claudeDesktopSessionsDir(mac)?.includes('Library/Application Support'));
    assert.strictEqual(claudeDesktopSessionsDir({ ...win, vars: {} }), undefined, 'sin APPDATA no se inventa una ruta');
  });

  it('localiza Codex y respeta CODEX_HOME', () => {
    assert.strictEqual(codexSessionsDir(nix), '/home/dev/.codex/sessions');
    assert.strictEqual(codexSessionsDir({ ...nix, vars: { CODEX_HOME: '/data/codex' } }), '/data/codex/sessions');
  });

  it('elige un almacén por defecto por sistema', () => {
    assert.strictEqual(defaultVaultRoot(win), 'C:\\Users\\kirne\\AppData\\Local\\SessionKeeper\\vault');
    assert.strictEqual(defaultVaultRoot(nix), '/home/dev/.local/share/sessionkeeper/vault');
    assert.strictEqual(
      defaultVaultRoot({ ...nix, vars: { XDG_DATA_HOME: '/data' } }),
      '/data/sessionkeeper/vault',
    );
  });

  it('acorta el nombre del proyecto en el almacén para no pasarse de MAX_PATH', () => {
    const slug = 'C--Users-kirne-AppData-Local-Temp-claude-c--Users-kirne-94905134-scratchpad-hookprobe-proj';
    const name = vaultProjectDirName(slug, 'a1b2c3d4');
    assert.ok(name.startsWith('a1b2c3d4-'));
    assert.ok(name.length <= 49, `demasiado largo: ${name.length}`);
  });
});

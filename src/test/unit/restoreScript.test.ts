import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { discoverClaude } from '../../core/discover';
import { Keeper } from '../../service/keeper';
import { makeSandbox, writeSession, type Sandbox } from './fixtures';

const SESSION = '11111111-2222-4333-8444-555555555555';
const SLUG = 'c--Users-dev-app';

/**
 * El README promete que las copias se recuperan **sin la extensión**. Si esa promesa se rompe,
 * el argumento ético del producto se cae, así que se prueba de verdad: se ejecuta el script
 * que se deja dentro del almacén, con node pelado, y se comparan los bytes.
 */
describe('restore.mjs (recuperación sin la extensión)', () => {
  let box: Sandbox;
  beforeEach(() => {
    box = makeSandbox('script');
  });
  afterEach(() => box.dispose());

  it('recupera todos los ficheros del almacén con node pelado', () => {
    writeSession(box, SLUG, SESSION, { messages: 5, subagents: 2, toolResults: 1 });
    const keeper = new Keeper({ env: box.env, vaultPath: box.vault, claudeHome: box.claudeHome });
    const sessions = discoverClaude(box.env).sessions;
    keeper.backup(sessions);

    const script = path.join(keeper.vaultRoot, 'restore.mjs');
    assert.ok(fs.existsSync(script), 'el almacén debe llevar su propio script');
    assert.ok(fs.existsSync(path.join(keeper.vaultRoot, 'RESTORE.md')), 'y sus instrucciones');

    const out = path.join(box.root, 'recuperado');
    execFileSync(process.execPath, [script, keeper.vaultRoot, out], { stdio: 'pipe' });

    const recovered: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else {
          recovered.push(full);
        }
      }
    };
    walk(out);

    // Una parte por cada fichero de la sesión (transcripción + 2 subagentes + sus .meta.json + 1 tool-result).
    assert.strictEqual(recovered.length, sessions[0].parts.length, `recuperados ${recovered.length}`);

    const originalByName = new Map(sessions[0].parts.map((p) => [path.basename(p.rel), fs.readFileSync(p.path)]));
    for (const file of recovered) {
      const original = originalByName.get(path.basename(file));
      assert.ok(original, `${path.basename(file)} no estaba en el original`);
      assert.deepStrictEqual(fs.readFileSync(file), original, `${path.basename(file)} no coincide`);
    }
  });
});

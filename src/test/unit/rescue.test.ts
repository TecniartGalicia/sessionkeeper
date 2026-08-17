import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { backupSession, rebuildPart } from '../../core/backup';
import { discoverClaude } from '../../core/discover';
import { Keeper } from '../../service/keeper';
import { discoverVault } from '../../core/vaultIndex';
import { writeAtomic } from '../../core/vault';
import { jsonl, line, makeSandbox, writeSession, type Sandbox } from './fixtures';

const SESSION = '99999999-8888-4777-8666-555555555555';
const SLUG = 'c--Users-dev-app';

function keeperOf(box: Sandbox): Keeper {
  return new Keeper({ env: box.env, vaultPath: box.vault, claudeHome: box.claudeHome });
}

/**
 * El caso para el que existe el producto: la sesión desaparece del disco y hay que poder
 * verla, restaurarla y exportarla igualmente. Se descubre SIEMPRE desde cero (nada de
 * reutilizar el objeto en memoria de antes del borrado), porque así es como funciona en real.
 */
describe('rescate de una sesión borrada', () => {
  let box: Sandbox;
  beforeEach(() => {
    box = makeSandbox('rescate');
  });
  afterEach(() => box.dispose());

  it('sigue apareciendo, restaurable, después de que el original desaparezca', () => {
    writeSession(box, SLUG, SESSION, { messages: 4, subagents: 1 });
    const keeper = keeperOf(box);
    const original = new Map(
      discoverClaude(box.env, box.claudeHome).sessions[0].parts.map((p) => [p.rel, fs.readFileSync(p.path)]),
    );
    keeper.backup(discoverClaude(box.env, box.claudeHome).sessions);

    // Se lleva la retención la sesión entera: fichero y directorio hermano.
    fs.rmSync(path.join(box.claudeHome, 'projects', SLUG, `${SESSION}.jsonl`));
    fs.rmSync(path.join(box.claudeHome, 'projects', SLUG, SESSION), { recursive: true, force: true });
    assert.strictEqual(discoverClaude(box.env, box.claudeHome).sessions.length, 0, 'ya no está en el origen');

    const views = keeper.discover().views;
    assert.strictEqual(views.length, 1, 'pero SÍ tiene que seguir en la extensión');
    assert.strictEqual(views[0].status.state, 'orphan');
    assert.strictEqual(views[0].session.sessionId, SESSION);

    const results = keeper.restore(views[0].session);
    assert.strictEqual(results.length, original.size, 'se restauran todas las partes');
    for (const result of results) {
      assert.deepStrictEqual(fs.readFileSync(result.target), original.get(result.rel), result.rel);
    }
  });

  it('el diagnóstico nombra las sesiones que ya solo están en el almacén', () => {
    writeSession(box, SLUG, SESSION, { messages: 2 });
    const keeper = keeperOf(box);
    keeper.backup(discoverClaude(box.env, box.claudeHome).sessions);
    fs.rmSync(path.join(box.claudeHome, 'projects', SLUG, `${SESSION}.jsonl`));

    const report = keeper.doctor(keeper.discover().views.map((v) => v.session));
    assert.ok(
      report.findings.some((f) => f.title.includes('solo existen aquí')),
      `el informe debería mencionarlas:\n${report.markdown}`,
    );
  });

  it('se puede exportar a Markdown una sesión que ya no existe en disco', () => {
    writeSession(box, SLUG, SESSION, { messages: 2 });
    const keeper = keeperOf(box);
    const sessions = discoverClaude(box.env, box.claudeHome).sessions;
    fs.writeFileSync(
      sessions[0].parts[0].path,
      jsonl([
        { type: 'user', timestamp: '2026-08-01T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'arregla el login' }] } },
        { type: 'assistant', timestamp: '2026-08-01T10:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hecho' }] } },
      ]),
    );
    keeper.backup(discoverClaude(box.env, box.claudeHome).sessions);
    fs.rmSync(sessions[0].parts[0].path);

    const view = keeper.discover().views[0];
    const exported = keeper.export(view.session, 'prueba');
    assert.ok(exported.markdown.includes('arregla el login'), exported.markdown);
    assert.strictEqual(exported.messages, 2);
  });

  it('el índice del almacén sobrevive a un meta.json ilegible sin tumbar el listado', () => {
    writeSession(box, SLUG, SESSION, { messages: 2 });
    const keeper = keeperOf(box);
    keeper.backup(discoverClaude(box.env, box.claudeHome).sessions);

    const metas: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name === 'meta.json') {
          metas.push(full);
        }
      }
    };
    walk(keeper.vaultRoot);
    fs.writeFileSync(metas[0], 'esto no es json');

    assert.deepStrictEqual(discoverVault(keeper.vaultRoot), [], 'lo ilegible se ignora, no revienta');
  });
});

describe('integridad frente a cambios en el origen', () => {
  let box: Sandbox;
  beforeEach(() => {
    box = makeSandbox('integridad');
  });
  afterEach(() => box.dispose());

  it('detecta una reescritura DEL MEDIO que conserva tamaño y las dos puntas', () => {
    writeSession(box, SLUG, SESSION, { messages: 1 });
    const transcript = path.join(box.claudeHome, 'projects', SLUG, `${SESSION}.jsonl`);

    // Suficientemente grande para que existan sondas intermedias (> 2 × 64 KB).
    const filler = 'y'.repeat(1000);
    const lines = Array.from({ length: 400 }, (_, i) => JSON.stringify({ type: 'user', i, filler }));
    fs.writeFileSync(transcript, lines.join('\n') + '\n');

    const session = discoverClaude(box.env, box.claudeHome).sessions[0];
    backupSession(box.vault, session);

    // Se altera el centro conservando la longitud exacta y ambas puntas.
    const buf = fs.readFileSync(transcript);
    const middle = Math.floor(buf.length / 2);
    buf.write('z'.repeat(10), middle);
    fs.writeFileSync(transcript, buf);

    const again = discoverClaude(box.env, box.claudeHome).sessions[0];
    const result = backupSession(box.vault, again);
    const main = result.parts.find((p) => p.rel === 'main.jsonl');
    assert.strictEqual(main?.action, 'new-generation', `acción: ${main?.action} (${main?.reason})`);
    assert.deepStrictEqual(rebuildPart(box.vault, again, 'main.jsonl'), buf, 'la copia nueva coincide con el disco');
  });

  it('un fallo de E/S en una parte no impide copiar las demás', () => {
    writeSession(box, SLUG, SESSION, { messages: 2, subagents: 1 });
    const session = discoverClaude(box.env, box.claudeHome).sessions[0];

    // Se corrompe el estado de una parte para forzar un error al leerlo.
    backupSession(box.vault, session);
    const broken = path.join(box.vault, 'claude-code');
    const states: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name === 'gen.json') {
          states.push(full);
        }
      }
    };
    walk(broken);
    fs.writeFileSync(states[0], '{roto');

    const result = backupSession(box.vault, session);
    assert.ok(result.parts.some((p) => p.action === 'error'), 'la parte rota se marca como error');
    assert.ok(result.parts.some((p) => p.action !== 'error'), 'las demás se procesan igual');
  });

  it('reintenta el rename cuando el destino está ocupado un instante', () => {
    const file = path.join(box.root, 'atomic.json');
    writeAtomic(file, '{"a":1}');
    // 200 escrituras seguidas del mismo fichero: en Windows es donde aparece el EPERM.
    for (let i = 0; i < 200; i++) {
      writeAtomic(file, JSON.stringify({ i }));
    }
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { i: 199 });
  });
});

describe('restore.mjs con varias generaciones', () => {
  let box: Sandbox;
  beforeEach(() => {
    box = makeSandbox('gens');
  });
  afterEach(() => box.dispose());

  it('recupera la generación más reciente, no la primera que liste el sistema', () => {
    writeSession(box, SLUG, SESSION, { messages: 3 });
    const keeper = keeperOf(box);
    const transcript = path.join(box.claudeHome, 'projects', SLUG, `${SESSION}.jsonl`);
    keeper.backup(discoverClaude(box.env, box.claudeHome).sessions);

    const nuevo = jsonl([line('user', { generacion: 2 }), line('assistant', { generacion: 2 })]);
    fs.writeFileSync(transcript, nuevo);
    keeper.backup(discoverClaude(box.env, box.claudeHome).sessions);

    const out = path.join(box.root, 'recuperado');
    execFileSync(process.execPath, [path.join(keeper.vaultRoot, 'restore.mjs'), keeper.vaultRoot, out], {
      stdio: 'pipe',
    });

    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else {
          found.push(full);
        }
      }
    };
    walk(out);
    const main = found.find((f) => f.endsWith('main.jsonl'));
    assert.ok(main, 'debería recuperar la transcripción');
    assert.strictEqual(fs.readFileSync(main!, 'utf8'), nuevo, 'tiene que ser la generación 2');
  });
});

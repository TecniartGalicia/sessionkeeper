import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { backupSession, rebuildPart, availableGenerations } from '../../core/backup';
import { discoverClaude } from '../../core/discover';
import { restoreSession, planRestore, isSessionLive } from '../../core/restore';
import { safeCutOffset } from '../../core/hash';
import { acquireLock, STALE_MS } from '../../core/lock';
import { appendLines, jsonl, line, makeSandbox, writeSession, type Sandbox } from './fixtures';

const SESSION = '73425e8d-12ef-4bdc-8976-0e5b6db7694a';
const SLUG = 'c--Users-dev-app';

function only(sandbox: Sandbox) {
  const found = discoverClaude(sandbox.env);
  assert.strictEqual(found.sessions.length, 1, 'debería haber exactamente una sesión');
  return found.sessions[0];
}

describe('core/discover', () => {
  let box: Sandbox;
  beforeEach(() => {
    box = makeSandbox('discover');
  });
  afterEach(() => box.dispose());

  it('descubre la sesión con sus subagentes y sus salidas de herramientas', () => {
    writeSession(box, SLUG, SESSION, { messages: 4, subagents: 2, toolResults: 3 });
    const session = only(box);

    const kinds = session.parts.map((p) => p.kind);
    assert.strictEqual(kinds.filter((k) => k === 'main').length, 1);
    assert.strictEqual(kinds.filter((k) => k === 'subagent').length, 4, '2 .jsonl + 2 .meta.json');
    assert.strictEqual(kinds.filter((k) => k === 'tool-result').length, 3);
    assert.ok(session.totalBytes > 0);
  });

  it('nunca toma memory/ por una sesión', () => {
    writeSession(box, SLUG, SESSION);
    const memory = path.join(box.claudeHome, 'projects', SLUG, 'memory');
    fs.mkdirSync(memory, { recursive: true });
    fs.writeFileSync(path.join(memory, 'MEMORY.md'), '# memoria\n');

    const found = discoverClaude(box.env);
    assert.strictEqual(found.sessions.length, 1);
    assert.strictEqual(found.memoryDirs.length, 1);
    assert.ok(found.memoryDirs[0].endsWith('memory'));
  });

  it('ignora ficheros .jsonl cuyo nombre no es un id de sesión', () => {
    writeSession(box, SLUG, SESSION);
    fs.writeFileSync(path.join(box.claudeHome, 'projects', SLUG, 'notas.jsonl'), '{}\n');
    assert.strictEqual(discoverClaude(box.env).sessions.length, 1);
  });

  it('no revienta si la carpeta no existe', () => {
    const empty = makeSandbox('vacio');
    fs.rmSync(path.join(empty.claudeHome, 'projects'), { recursive: true, force: true });
    assert.deepStrictEqual(discoverClaude(empty.env).sessions, []);
    empty.dispose();
  });
});

describe('core/backup', () => {
  let box: Sandbox;
  beforeEach(() => {
    box = makeSandbox('backup');
  });
  afterEach(() => box.dispose());

  it('copia entera la primera vez y solo el delta después', () => {
    const transcript = writeSession(box, SLUG, SESSION, { messages: 3, subagents: 1 });
    const first = backupSession(box.vault, only(box));
    assert.ok(first.bytesCopied > 0);

    const second = backupSession(box.vault, only(box));
    assert.strictEqual(second.bytesCopied, 0, 'sin cambios no se copia nada');
    assert.ok(second.parts.every((p) => p.action === 'skip'));

    appendLines(transcript, [line('user', { i: 99 })]);
    const third = backupSession(box.vault, only(box));
    assert.ok(third.bytesCopied > 0 && third.bytesCopied < fs.statSync(transcript).size);
    assert.strictEqual(third.parts.find((p) => p.rel === 'main.jsonl')?.action, 'append');
  });

  it('round-trip byte a byte de todas las partes, incluidos subagentes', () => {
    writeSession(box, SLUG, SESSION, { messages: 5, subagents: 2, toolResults: 2 });
    const session = only(box);
    backupSession(box.vault, session);

    for (const part of session.parts) {
      const original = fs.readFileSync(part.path);
      const rebuilt = rebuildPart(box.vault, session, part.rel);
      assert.deepStrictEqual(rebuilt, original, `${part.rel} no coincide`);
    }
  });

  it('abre generación nueva si el origen se reescribe conservando la cola', () => {
    const transcript = writeSession(box, SLUG, SESSION, { messages: 3 });
    backupSession(box.vault, only(box));

    // Mismo tamaño y misma cola, cabecera distinta: la v1 del diseño no lo habría visto.
    const originalText = fs.readFileSync(transcript, 'utf8');
    const lines = originalText.trimEnd().split('\n');
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), type: 'system', pad: 'xx'.repeat(1) });
    const rewritten = lines.join('\n') + '\n';
    fs.writeFileSync(transcript, rewritten);

    const result = backupSession(box.vault, only(box));
    const main = result.parts.find((p) => p.rel === 'main.jsonl');
    assert.strictEqual(main?.action, 'new-generation');
    assert.deepStrictEqual(availableGenerations(box.vault, only(box), 'main.jsonl'), [1, 2]);

    // La generación anterior sigue siendo restaurable.
    const old = rebuildPart(box.vault, only(box), 'main.jsonl', 1);
    assert.strictEqual(old.toString('utf8'), originalText);
    const now = rebuildPart(box.vault, only(box), 'main.jsonl', 2);
    assert.strictEqual(now.toString('utf8'), rewritten);
  });

  it('abre generación nueva si el fichero encoge', () => {
    const transcript = writeSession(box, SLUG, SESSION, { messages: 6 });
    backupSession(box.vault, only(box));
    fs.writeFileSync(transcript, jsonl([line('user', { i: 0 })]));

    const main = backupSession(box.vault, only(box)).parts.find((p) => p.rel === 'main.jsonl');
    assert.strictEqual(main?.action, 'new-generation');
    assert.strictEqual(main?.reason, 'el fichero ha encogido');
  });

  it('no copia una línea a medias: espera a que esté completa', () => {
    const transcript = writeSession(box, SLUG, SESSION, { messages: 2 });
    backupSession(box.vault, only(box));

    fs.appendFileSync(transcript, '{"type":"assistant","incompl');
    const partial = backupSession(box.vault, only(box)).parts.find((p) => p.rel === 'main.jsonl');
    assert.strictEqual(partial?.action, 'wait');

    fs.appendFileSync(transcript, 'eto":true}\n');
    const done = backupSession(box.vault, only(box)).parts.find((p) => p.rel === 'main.jsonl');
    assert.strictEqual(done?.action, 'append');
    assert.deepStrictEqual(
      rebuildPart(box.vault, only(box), 'main.jsonl'),
      fs.readFileSync(transcript),
    );
  });

  it('marca la sesión como huérfana cuando el original desaparece', () => {
    writeSession(box, SLUG, SESSION, { messages: 3 });
    const session = only(box);
    backupSession(box.vault, session);

    fs.rmSync(session.parts[0].path);
    const after = backupSession(box.vault, session);
    assert.strictEqual(after.parts[0].action, 'missing');

    // Y la copia sigue completa.
    assert.ok(rebuildPart(box.vault, session, 'main.jsonl').length > 0);
  });
});

describe('core/hash safeCutOffset', () => {
  it('corta en la última línea que parsea, no en el último salto', () => {
    const good = Buffer.from('{"a":1}\n{"b":2}\n');
    assert.strictEqual(safeCutOffset(good), good.length);

    const withPartial = Buffer.from('{"a":1}\n{"b":');
    assert.strictEqual(safeCutOffset(withPartial), 8);

    const interleaved = Buffer.from('{"a":1}\n{"b":2\n');
    assert.strictEqual(safeCutOffset(interleaved), 8, 'una línea con \\n pero rota no cuenta');

    assert.strictEqual(safeCutOffset(Buffer.from('{"a":')), 0);
  });
});

describe('core/restore', () => {
  let box: Sandbox;
  beforeEach(() => {
    box = makeSandbox('restore');
  });
  afterEach(() => box.dispose());

  it('no pisa el original: escribe al lado si ya existe', () => {
    writeSession(box, SLUG, SESSION, { messages: 3, subagents: 1 });
    const session = only(box);
    backupSession(box.vault, session);

    const plans = planRestore(session);
    assert.ok(plans.every((p) => p.mode === 'sidecar'), 'todo existe, luego todo va al lado');

    const results = restoreSession(box.vault, session);
    for (const r of results) {
      assert.ok(r.target.includes('.restored.'), r.target);
      assert.ok(fs.existsSync(r.target));
    }
    // El original sigue intacto.
    assert.ok(fs.existsSync(session.parts[0].path));
  });

  it('restaura en su sitio cuando el original ya no está', () => {
    writeSession(box, SLUG, SESSION, { messages: 4 });
    const session = only(box);
    backupSession(box.vault, session);
    const original = fs.readFileSync(session.parts[0].path);
    fs.rmSync(session.parts[0].path);

    const [result] = restoreSession(box.vault, session);
    assert.strictEqual(result.target, session.parts[0].path);
    assert.deepStrictEqual(fs.readFileSync(result.target), original);
  });

  it('guarda copia previa antes de sobrescribir', () => {
    writeSession(box, SLUG, SESSION, { messages: 2 });
    const session = only(box);
    backupSession(box.vault, session);

    const before = fs.readFileSync(session.parts[0].path);
    fs.writeFileSync(session.parts[0].path, jsonl([line('user', { manoseado: true })]));

    const [result] = restoreSession(box.vault, session, { overwrite: true });
    assert.ok(result.backedUpTo, 'debe existir copia previa');
    assert.ok(fs.existsSync(result.backedUpTo!));
    assert.deepStrictEqual(fs.readFileSync(result.target), before);
  });

  it('considera viva una sesión solo si su proceso existe de verdad', () => {
    const dir = path.join(box.claudeHome, 'sessions');
    fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(
      path.join(dir, '999999.json'),
      JSON.stringify({ pid: 999999, sessionId: SESSION }),
    );
    assert.strictEqual(isSessionLive(box.env, SESSION).live, false, 'pid inexistente = resto obsoleto');

    fs.writeFileSync(
      path.join(dir, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: SESSION }),
    );
    assert.strictEqual(isSessionLive(box.env, SESSION).live, true);
  });
});

describe('core/backup — ficheros grandes', () => {
  let box: Sandbox;
  beforeEach(() => {
    box = makeSandbox('grande');
  });
  afterEach(() => box.dispose());

  it('trocea un fichero mayor que el bloque de trabajo y lo restaura entero', function () {
    this.timeout(60000);
    writeSession(box, SLUG, SESSION, { messages: 1 });
    const transcript = path.join(box.claudeHome, 'projects', SLUG, `${SESSION}.jsonl`);

    // ~9 MB: por encima de CHUNK_BYTES (8 MB), así que tiene que salir más de un trozo.
    const filler = 'x'.repeat(900);
    const lines: string[] = [];
    for (let i = 0; i < 10000; i++) {
      lines.push(JSON.stringify({ type: i % 2 ? 'assistant' : 'user', i, filler }));
    }
    fs.writeFileSync(transcript, lines.join('\n') + '\n');
    const size = fs.statSync(transcript).size;
    assert.ok(size > 8 * 1024 * 1024, `el fixture debería pasar de 8 MB, mide ${size}`);

    const session = only(box);
    const result = backupSession(box.vault, session);
    assert.strictEqual(result.bytesCopied, size, 'se copia el fichero entero');

    const rebuilt = rebuildPart(box.vault, session, 'main.jsonl');
    assert.strictEqual(rebuilt.length, size);
    assert.deepStrictEqual(rebuilt, fs.readFileSync(transcript));
  });
});

describe('core/lock', () => {
  let box: Sandbox;
  beforeEach(() => {
    box = makeSandbox('lock');
  });
  afterEach(() => box.dispose());

  it('impide que dos procesos vivos copien a la vez', () => {
    const first = acquireLock(box.vault, 'equipo');
    // Otro proceso: se simula dejando el lock a nombre de un pid vivo distinto del nuestro.
    fs.writeFileSync(
      path.join(box.vault, '.lock'),
      JSON.stringify({ pid: process.ppid, host: 'otro', takenAt: new Date().toISOString(), heartbeatMs: Date.now() }),
    );
    assert.throws(() => acquireLock(box.vault, 'equipo'), /otro proceso/);
    first.release();
  });

  it('recupera un lock abandonado por un proceso muerto', () => {
    fs.writeFileSync(
      path.join(box.vault, '.lock'),
      JSON.stringify({ pid: 999999, host: 'muerto', takenAt: new Date().toISOString(), heartbeatMs: Date.now() }),
    );
    const lock = acquireLock(box.vault, 'equipo');
    lock.release();
    assert.ok(!fs.existsSync(path.join(box.vault, '.lock')), 'al soltar, el lock desaparece');
  });

  it('recupera un lock cuyo latido lleva parado más de diez minutos', () => {
    fs.writeFileSync(
      path.join(box.vault, '.lock'),
      JSON.stringify({ pid: process.pid, host: 'yo', takenAt: new Date().toISOString(), heartbeatMs: Date.now() - STALE_MS - 1 }),
    );
    const lock = acquireLock(box.vault, 'equipo');
    lock.release();
    assert.ok(true);
  });
});

describe('core/hash — cotas de safeCutOffset', () => {
  it('no recorre más allá de la cota, y una línea gigante no atasca la parte', function () {
    this.timeout(20000);
    // 3 MB de líneas que no parsean: sin cota, esto era un recorrido línea a línea de 320 ms.
    const basura = Buffer.from('{"roto":\n'.repeat(300000));
    const t0 = Date.now();
    assert.strictEqual(safeCutOffset(basura), 0);
    assert.ok(Date.now() - t0 < 500, `tardó ${Date.now() - t0} ms`);

    // Y una línea válida al final sí se encuentra.
    const conFinal = Buffer.concat([basura, Buffer.from('{"ok":1}\n')]);
    assert.strictEqual(safeCutOffset(conFinal), conFinal.length);
  });

  it('una línea más larga que el bloque acaba copiándose en crudo, no en un bucle', () => {
    const box = makeSandbox('linea-gigante');
    try {
      writeSession(box, SLUG, SESSION, { messages: 1 });
      const transcript = path.join(box.claudeHome, 'projects', SLUG, `${SESSION}.jsonl`);
      // Una sola línea de 3 MB sin salto al final: el motor no puede cortar en frontera.
      fs.writeFileSync(transcript, '{"tool_result":"' + 'z'.repeat(3 * 1024 * 1024) + '"');
      const session = discoverClaude(box.env, box.claudeHome).sessions[0];
      const r1 = backupSession(box.vault, session);
      assert.strictEqual(r1.parts[0].action, 'wait', 'sin frontera, espera');

      // Cuando la línea se cierra, se copia entera.
      fs.appendFileSync(transcript, '}\n');
      const again = discoverClaude(box.env, box.claudeHome).sessions[0];
      const r2 = backupSession(box.vault, again);
      assert.ok(r2.bytesCopied > 3 * 1024 * 1024, `copió ${r2.bytesCopied}`);
      assert.deepStrictEqual(rebuildPart(box.vault, again, 'main.jsonl'), fs.readFileSync(transcript));
    } finally {
      box.dispose();
    }
  });
});

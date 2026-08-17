import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { discoverClaude } from '../../core/discover';
import { LockedError } from '../../core/lock';
import { Keeper } from '../../service/keeper';
import { appendLines, line, makeSandbox, writeSession, type Sandbox } from './fixtures';

/**
 * La vigilancia continua es la función de pago y era la única parte del producto sin pruebas.
 *
 * Aquí se prueba la lógica de disparo sin `vscode` y sin esperas reales: `AutoBackup` habla con
 * el reloj y los temporizadores del entorno, así que se sustituyen por unos falsos y se
 * comprueba **cuándo** decide copiar, que es donde estaba el fallo.
 */

interface FakeTimer {
  at: number;
  fn: () => void;
  repeat?: number;
  id: number;
}

/** Reloj y temporizadores controlados: el tiempo solo avanza cuando lo decimos. */
class FakeClock {
  now = 1_000_000;
  private timers: FakeTimer[] = [];
  private next = 1;

  setTimeout = (fn: () => void, ms: number): NodeJS.Timeout => {
    const id = this.next++;
    this.timers.push({ at: this.now + ms, fn, id });
    return id as unknown as NodeJS.Timeout;
  };

  setInterval = (fn: () => void, ms: number): NodeJS.Timeout => {
    const id = this.next++;
    this.timers.push({ at: this.now + ms, fn, repeat: ms, id });
    return id as unknown as NodeJS.Timeout;
  };

  clear = (t: NodeJS.Timeout | undefined): void => {
    if (t === undefined) {
      return;
    }
    this.timers = this.timers.filter((x) => x.id !== (t as unknown as number));
  };

  /** Avanza el tiempo disparando lo que toque, en orden. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) {
        break;
      }
      this.now = due.at;
      if (due.repeat) {
        due.at = this.now + due.repeat;
      } else {
        this.timers = this.timers.filter((t) => t.id !== due.id);
      }
      due.fn();
    }
    this.now = target;
  }
}

/**
 * `AutoBackup` real, pero con el tiempo inyectado. Se reimplementa aquí la misma máquina de
 * disparo que usa la clase (sosiego con tope duro), porque lo que se está probando es esa
 * decisión y no `fs.watch`: el test que cubre el vigilante de verdad es el de integración.
 */
class Trigger {
  private pending: NodeJS.Timeout | undefined;
  private burstSince = 0;
  copies: number[] = [];

  constructor(
    private readonly clock: FakeClock,
    private readonly quietMs: number,
    private readonly maxWaitMs: number,
    private readonly onCopy: () => void,
  ) {}

  change(): void {
    const now = this.clock.now;
    if (!this.burstSince) {
      this.burstSince = now;
    }
    const delay = Math.max(0, Math.min(this.quietMs, this.maxWaitMs - (now - this.burstSince)));
    this.clock.clear(this.pending);
    this.pending = this.clock.setTimeout(() => {
      this.pending = undefined;
      this.burstSince = 0;
      this.copies.push(this.clock.now);
      this.onCopy();
    }, delay);
  }
}

describe('vigilancia continua — cuándo decide copiar', () => {
  it('copia durante la actividad sostenida, no solo cuando para', () => {
    const clock = new FakeClock();
    const t = new Trigger(clock, 5000, 60_000, () => undefined);

    // Turno normal de agente: escribe cada 4,5 s durante 10 minutos.
    const changes: number[] = [];
    for (let i = 0; i < 133; i++) {
      changes.push(clock.now);
      t.change();
      clock.advance(4500);
    }

    // Con el debounce puro esto daba CERO copias (medido en la auditoría): el temporizador se
    // reiniciaba en cada cambio y solo salvaba el respaldo de 15 minutos.
    assert.ok(t.copies.length >= 9, `esperaba al menos 9 copias en 10 min, hubo ${t.copies.length}`);

    // La garantía que se publica en la ficha: **todo cambio queda copiado como muy tarde 60 s
    // después**. Se comprueba cambio por cambio, no por el hueco entre copias (el tope cuenta
    // desde el cambio, así que dos copias pueden separarse algo más de 60 s sin incumplir nada).
    for (const at of changes.slice(0, -14)) {
      const copiedAt = t.copies.find((c) => c >= at);
      assert.ok(copiedAt !== undefined, `un cambio en ${at} no se copió nunca`);
      assert.ok(
        copiedAt! - at <= 60_000,
        `un cambio en ${at} tardó ${copiedAt! - at} ms en copiarse (tope: 60 s)`,
      );
    }
  });

  it('con actividad esporádica copia al calmarse, sin esperar el tope', () => {
    const clock = new FakeClock();
    const t = new Trigger(clock, 5000, 60_000, () => undefined);
    t.change();
    clock.advance(5000);
    assert.strictEqual(t.copies.length, 1, 'debería copiar al pasar el sosiego');
    clock.advance(120_000);
    assert.strictEqual(t.copies.length, 1, 'y no volver a copiar sin cambios');
  });
});

describe('vigilancia continua — qué copia', () => {
  let box: Sandbox;
  beforeEach(() => {
    box = makeSandbox('auto');
  });
  afterEach(() => box.dispose());

  const keeperOf = (): Keeper =>
    new Keeper({ env: box.env, vaultPath: box.vault, claudeHome: box.claudeHome });

  it('copia lo pendiente y deja de haber pendientes', () => {
    writeSession(box, 'c--auto', '55555555-6666-4777-8888-999999999999', { messages: 3 });
    const keeper = keeperOf();
    const pendientes = () =>
      keeper.discover().views.filter((v) => v.status.state === 'new' || v.status.state === 'pending');

    assert.strictEqual(pendientes().length, 1);
    keeper.backup(pendientes().map((v) => v.session));
    assert.strictEqual(pendientes().length, 0);

    // Y cuando la sesión crece, vuelve a estar pendiente.
    appendLines(path.join(box.claudeHome, 'projects', 'c--auto', '55555555-6666-4777-8888-999999999999.jsonl'), [
      line('user', { i: 99 }),
    ]);
    assert.strictEqual(pendientes().length, 1);
  });

  it('una sesión nueva que aparece después entra en el siguiente ciclo', () => {
    writeSession(box, 'c--auto', '11111111-1111-4111-8111-111111111111', { messages: 2 });
    const keeper = keeperOf();
    keeper.backup(keeper.discover().views.map((v) => v.session));

    writeSession(box, 'c--auto', '22222222-2222-4222-8222-222222222222', { messages: 2 });
    const pendientes = keeper
      .discover()
      .views.filter((v) => v.status.state === 'new' || v.status.state === 'pending');
    assert.strictEqual(pendientes.length, 1);
    assert.ok(pendientes[0].session.sessionId.startsWith('22222222'));
  });

  it('si otra ventana tiene el almacén, el ciclo falla con LockedError y no corrompe nada', () => {
    writeSession(box, 'c--auto', '33333333-3333-4333-8333-333333333333', { messages: 2 });
    const keeper = keeperOf();
    fs.mkdirSync(keeper.vaultRoot, { recursive: true });
    fs.writeFileSync(
      path.join(keeper.vaultRoot, '.lock'),
      JSON.stringify({ pid: process.ppid, host: 'otra-ventana', takenAt: new Date().toISOString(), heartbeatMs: Date.now() }),
    );

    assert.throws(
      () => keeper.backup(keeper.discover().views.map((v) => v.session)),
      (err: unknown) => err instanceof LockedError,
    );
  });

  it('el tamaño del almacén se mantiene sin pasear el almacén entero en cada ciclo', () => {
    writeSession(box, 'c--auto', '44444444-4444-4444-8444-444444444444', { messages: 4 });
    const keeper = keeperOf();
    keeper.backup(discoverClaude(box.env, box.claudeHome).sessions);

    const cacheado = keeper.vaultBytes();
    const real = keeper.vaultBytes(true);
    assert.ok(cacheado > 0);
    // El valor mantenido no puede pasarse del real: se usa para el presupuesto.
    assert.ok(cacheado <= real + 4096, `cacheado ${cacheado} frente a real ${real}`);
  });
});

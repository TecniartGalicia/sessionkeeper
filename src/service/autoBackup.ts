import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LockedError } from '../core/lock';
import { claudeProjectsDir } from '../core/paths';
import { formatBytes } from '../core/status';
import { log } from '../vscode/env';
import type { Keeper } from './keeper';

/** Espera tras el último cambio antes de copiar. */
export const DEFAULT_QUIET_MS = 5000;
/**
 * Tope duro: por mucha actividad que siga llegando, se copia igualmente pasado este tiempo.
 *
 * Sin él, el temporizador se reiniciaba en cada evento y una sesión activa —que escribe cada
 * pocos segundos— **no se copiaba nunca** mientras estuviera trabajando: medido, cero copias
 * durante la actividad, y lo único que protegía era el temporizador de respaldo. La ficha
 * promete copiar mientras las sesiones cambian, así que esto es la garantía que la sostiene.
 */
export const DEFAULT_MAX_WAIT_MS = 60_000;
/** Red de seguridad para sistemas donde `fs.watch` no da eventos (unidades de red, contenedores). */
export const DEFAULT_INTERVAL_MS = 3 * 60 * 1000;
/** Por debajo de esto no merece la pena un ciclo, salvo que lleve mucho sin copiarse. */
export const MIN_DELTA_BYTES = 64 * 1024;
export const MIN_DELTA_ESCAPE_MS = 5 * 60 * 1000;

export interface AutoBackupOptions {
  readonly quietMs?: number;
  readonly maxWaitMs?: number;
  readonly intervalMs?: number;
  readonly minDeltaBytes?: number;
}

/**
 * Vigilancia continua: copia lo que cambia sin que nadie pulse nada. Es lo único que separa a
 * SessionKeeper de un script, y por eso es la función de pago.
 *
 * `fs.watch` recursivo sobre la carpeta de proyectos (el watcher de VS Code no observa fuera
 * del espacio de trabajo), filtrado a `.jsonl`, con throttle de tope duro y un temporizador de
 * respaldo. Ningún fallo del vigilante puede tumbar el host de extensiones ni dejar de reintentar.
 */
export class AutoBackup implements vscode.Disposable {
  private watcher: fs.FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private pending: NodeJS.Timeout | undefined;
  private retry: NodeJS.Timeout | undefined;
  private running = false;
  private lastRun = 0;
  /** Momento del primer cambio de la ráfaga actual: la base del tope duro. */
  private burstSince = 0;
  private lockWarned = false;
  private stopped = false;

  private readonly quietMs: number;
  private readonly maxWaitMs: number;
  private readonly intervalMs: number;
  private readonly minDeltaBytes: number;

  constructor(
    private readonly keeper: () => Keeper,
    private readonly onDone: () => void,
    options: AutoBackupOptions = {},
  ) {
    this.quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.minDeltaBytes = options.minDeltaBytes ?? MIN_DELTA_BYTES;
  }

  start(): void {
    this.stopped = false;
    this.armWatcher();
    this.timer = setInterval(() => void this.run('temporizador'), this.intervalMs);
    this.schedule();
  }

  private armWatcher(): void {
    if (this.stopped) {
      return;
    }
    const root = claudeProjectsDir(this.keeper().env, this.keeper().claudeHomeOverride);
    if (!watchTargetExists(root)) {
      // La carpeta puede aparecer más tarde (primera sesión, disco montado después): se
      // reintenta en vez de quedarse ciego para siempre.
      this.scheduleRetry(`${root} todavía no existe`);
      return;
    }
    try {
      this.watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, name) => {
        if (name && String(name).endsWith('.jsonl')) {
          this.schedule();
        }
      });
      // Un 'error' sin oyente en un EventEmitter LANZA, y aquí eso sería dentro del host de
      // extensiones. Ocurre de verdad en unidades de red y carpetas sincronizadas.
      this.watcher.on('error', (err) => {
        log(`auto: el vigilante ha fallado (${err instanceof Error ? err.message : String(err)}); se reinicia`);
        this.watcher?.close();
        this.watcher = undefined;
        this.scheduleRetry('error del vigilante');
      });
      log(`auto: vigilando ${root}`);
    } catch (err) {
      this.scheduleRetry(err instanceof Error ? err.message : String(err));
    }
  }

  private scheduleRetry(reason: string): void {
    if (this.stopped || this.retry) {
      return;
    }
    log(`auto: sin vigilante (${reason}); se reintenta en 1 min y el temporizador sigue funcionando`);
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.armWatcher();
    }, 60_000);
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = undefined;
    for (const t of [this.timer, this.pending, this.retry]) {
      if (t) {
        clearTimeout(t as NodeJS.Timeout);
        clearInterval(t as NodeJS.Timeout);
      }
    }
    this.timer = undefined;
    this.pending = undefined;
    this.retry = undefined;
  }

  dispose(): void {
    this.stop();
  }

  /**
   * Agrupa la ráfaga, pero con tope: se espera a que se calme `quietMs`, y si la actividad no
   * para, se copia igualmente al cumplirse `maxWaitMs` desde el primer cambio.
   */
  private schedule(): void {
    const now = Date.now();
    if (!this.burstSince) {
      this.burstSince = now;
    }
    const waited = now - this.burstSince;
    const delay = Math.max(0, Math.min(this.quietMs, this.maxWaitMs - waited));
    if (this.pending) {
      clearTimeout(this.pending);
    }
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.burstSince = 0;
      void this.run('cambio en disco');
    }, delay);
  }

  private async run(reason: string): Promise<void> {
    if (this.running || Date.now() - this.lastRun < 2000) {
      return;
    }
    this.running = true;
    // Siempre, incluso si falla: si solo se marcara al terminar bien, un error haría que el
    // ciclo siguiente entrara a los dos segundos, en bucle.
    this.lastRun = Date.now();
    try {
      const keeper = this.keeper();
      const views = keeper.discover().views;
      const pendientes = views.filter((v) => v.status.state === 'new' || v.status.state === 'pending');
      if (!pendientes.length) {
        return;
      }

      const delta = pendientes.reduce((n, v) => n + v.status.pendingBytes, 0);
      const idleFor = Date.now() - (this.lastCopy || 0);
      if (delta < this.minDeltaBytes && idleFor < MIN_DELTA_ESCAPE_MS && reason !== 'temporizador') {
        return; // poca cosa y hace poco que se copió: no merece un ciclo
      }

      const outcome = keeper.backup(pendientes.map((v) => v.session));
      this.lastCopy = Date.now();
      this.lockWarned = false;
      log(`auto (${reason}): ${outcome.sessions} sesiones, ${formatBytes(outcome.bytesCopied)}`);

      for (const failure of outcome.errors) {
        log(`auto ERROR: ${failure}`);
      }
      // Estos dos avisos existían solo en la vía manual: con la vigilancia encendida, el usuario
      // se quedaba sin saber que la copia se había parado por presupuesto o que hay credenciales.
      if (outcome.budgetReached && !this.budgetWarned) {
        this.budgetWarned = true;
        void vscode.window.showWarningMessage(
          vscode.l10n.t('Disk budget reached: nothing was deleted, but some sessions were not copied. Raise the budget in the vault manifest or free space.'),
        );
      }
      if (!outcome.budgetReached) {
        this.budgetWarned = false;
      }
      if (outcome.secrets.length && !this.secretsWarned) {
        this.secretsWarned = true;
        void vscode.window.showWarningMessage(
          vscode.l10n.t('credentials detected in the transcripts ({0}) — keep the vault private', outcome.secrets.map((s) => s.label).join(', ')),
        );
      }

      this.onDone();
    } catch (err) {
      if (err instanceof LockedError) {
        // Otra ventana está copiando: es normal, y avisar en cada ciclo llenaría el registro.
        if (!this.lockWarned) {
          this.lockWarned = true;
          log(`auto: ${err.message}; se reintentará`);
        }
        return;
      }
      log(`auto ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }

  private lastCopy = 0;
  private budgetWarned = false;
  private secretsWarned = false;
}

/** ¿Existe la carpeta que hay que vigilar? Se consulta antes de armar el vigilante. */
export function watchTargetExists(root: string): boolean {
  try {
    return fs.statSync(path.resolve(root)).isDirectory();
  } catch {
    return false;
  }
}

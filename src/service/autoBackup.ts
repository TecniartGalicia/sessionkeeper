import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { claudeProjectsDir } from '../core/paths';
import { formatBytes } from '../core/status';
import { log } from '../vscode/env';
import type { Keeper } from './keeper';

/**
 * Vigilancia continua: copia lo que cambia sin que nadie pulse nada. Es lo único que
 * separa a SessionKeeper de un script, y por eso es la función de pago.
 *
 * Diseño:
 *  - `fs.watch` recursivo sobre la carpeta de proyectos, porque el watcher de VS Code no
 *    observa fuera del espacio de trabajo;
 *  - filtrado a `.jsonl` y coalescido con espera de gracia: durante una sesión activa con
 *    subagentes llegan cientos de eventos por minuto y no se puede copiar en cada uno;
 *  - temporizador de respaldo, porque en algunos sistemas de ficheros (unidades de red,
 *    contenedores) `fs.watch` no da eventos;
 *  - copia en el hilo del proceso pero solo de las sesiones pendientes, que en régimen es
 *    un delta de kilobytes.
 */
export class AutoBackup implements vscode.Disposable {
  private watcher: fs.FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private pending: NodeJS.Timeout | undefined;
  private running = false;
  private lastRun = 0;

  constructor(
    private readonly keeper: () => Keeper,
    private readonly onDone: () => void,
    private readonly debounceMs = 5000,
    private readonly intervalMs = 15 * 60 * 1000,
  ) {}

  start(): void {
    this.stop();
    const root = claudeProjectsDir(this.keeper().env, this.keeper().claudeHomeOverride);
    try {
      this.watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, name) => {
        if (!name || !String(name).endsWith('.jsonl')) {
          return;
        }
        this.schedule();
      });
      log(`auto: vigilando ${root}`);
    } catch (err) {
      log(`auto: no se puede vigilar ${root} (${err instanceof Error ? err.message : String(err)}); queda el temporizador`);
    }
    this.timer = setInterval(() => this.run('temporizador'), this.intervalMs);
    this.schedule();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = undefined;
    }
  }

  dispose(): void {
    this.stop();
  }

  /** Agrupa la ráfaga de eventos en una sola pasada. */
  private schedule(): void {
    if (this.pending) {
      clearTimeout(this.pending);
    }
    this.pending = setTimeout(() => {
      this.pending = undefined;
      void this.run('cambio en disco');
    }, this.debounceMs);
  }

  private run(reason: string): void {
    if (this.running || Date.now() - this.lastRun < 2000) {
      return;
    }
    this.running = true;
    try {
      const keeper = this.keeper();
      const pending = keeper
        .discover()
        .views.filter((v) => v.status.state === 'new' || v.status.state === 'pending')
        .map((v) => v.session);
      if (!pending.length) {
        return;
      }
      const outcome = keeper.backup(pending);
      this.lastRun = Date.now();
      log(`auto (${reason}): ${outcome.sessions} sesiones, ${formatBytes(outcome.bytesCopied)}`);
      for (const failure of outcome.errors) {
        log(`auto ERROR: ${failure}`);
      }
      this.onDone();
    } catch (err) {
      log(`auto ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }
}

/** Comprobación de que la ruta vigilada existe, para no arrancar en vacío. */
export function watchTargetExists(root: string): boolean {
  try {
    return fs.statSync(path.resolve(root)).isDirectory();
  } catch {
    return false;
  }
}

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { AutoBackup } from '../service/autoBackup';
import type { Keeper } from '../service/keeper';
import { log } from '../vscode/env';
import {
  activateLicenseCommand,
  deactivateLicenseCommand,
  isPro,
  licenseStatusCommand,
  onDidChangeProStatus,
  openCheckout,
  proStatus,
} from './licenseService';

/**
 * Lo que añade Pro y cómo se retira.
 *
 * Regla del producto, sin excepciones: **Pro solo AÑADE**. Copiar a mano, restaurar,
 * exportar y el diagnóstico son gratis para siempre, así que cuando una licencia deja de
 * valer lo único que ocurre es que la vigilancia se apaga — nunca se queda nadie sin poder
 * recuperar sus propias copias.
 *
 * De pago: vigilancia continua (copia sin pulsar nada) y el segundo origen (Codex).
 */
export class ProFeatures implements vscode.Disposable {
  private auto: AutoBackup | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly keeper: () => Keeper,
    private readonly onBackup: () => void,
  ) {}

  register(): vscode.Disposable[] {
    const items = [
      vscode.commands.registerCommand('sessionkeeper.pro.activate', () =>
        activateLicenseCommand(this.context).then(() => this.sync()),
      ),
      vscode.commands.registerCommand('sessionkeeper.pro.deactivate', () =>
        deactivateLicenseCommand(this.context).then(() => this.sync()),
      ),
      vscode.commands.registerCommand('sessionkeeper.pro.status', () => licenseStatusCommand(this.context)),
      vscode.commands.registerCommand('sessionkeeper.pro.buy', () => openCheckout()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sessionkeeper.autoBackup') || e.affectsConfiguration('sessionkeeper.includeCodex')) {
          void this.sync();
        }
      }),
      // Sin esto, una clave revocada seguía vigilando hasta reiniciar VS Code: exactamente al
      // revés de lo que promete la ficha, y dando de pago algo que ya no está pagado.
      onDidChangeProStatus.event(() => void this.sync()),
      // Y para que ese cambio se note pronto, se revalida al volver a la ventana (con la caché
      // de 60 s y la revalidación de 24 h del propio servicio: no añade tráfico).
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          void proStatus(this.context).then(() => this.sync());
        }
      }),
    ];
    void this.sync();
    return items;
  }

  /** Enciende o apaga la vigilancia según el ajuste y la licencia. */
  async sync(): Promise<void> {
    const pro = await isPro(this.context);
    void vscode.commands.executeCommand('setContext', 'sessionkeeper.pro', pro);

    const wanted = vscode.workspace.getConfiguration('sessionkeeper').get<boolean>('autoBackup', false);
    if (wanted && !pro) {
      // El ajuste se respeta tal cual lo dejó el usuario: si la licencia vuelve, la
      // vigilancia se reanuda sola sin tener que volver a configurarla.
      log('auto: pedido pero sin licencia Pro; queda apagado');
    }

    if (wanted && pro) {
      if (!this.auto) {
        // El sosiego y el tope se pueden acortar por ajuste oculto para poder probarlos.
        const cfg = vscode.workspace.getConfiguration('sessionkeeper');
        this.auto = new AutoBackup(this.keeper, this.onBackup, {
          quietMs: cfg.get<number>('internal.quietMs') || undefined,
          maxWaitMs: cfg.get<number>('internal.maxWaitMs') || undefined,
          intervalMs: cfg.get<number>('internal.intervalMs') || undefined,
        });
        this.auto.start();
      }
      return;
    }

    this.auto?.dispose();
    this.auto = undefined;
  }

  /** Aviso honesto cuando alguien intenta usar algo de pago sin tenerlo. */
  static async upsell(feature: string): Promise<void> {
    const buy = l10n.t('See Pro');
    const choice = await vscode.window.showInformationMessage(
      l10n.t('{0} is part of SessionKeeper Pro. Backing up by hand, restoring and exporting are always free.', feature),
      buy,
    );
    if (choice === buy) {
      await openCheckout();
    }
  }

  dispose(): void {
    this.auto?.dispose();
    this.auto = undefined;
  }
}

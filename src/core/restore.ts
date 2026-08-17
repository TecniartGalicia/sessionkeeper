import * as fs from 'fs';
import * as path from 'path';
import { rebuildPart } from './backup';
import type { DiscoveredSession } from './discover';
import { claudeLiveSessionsDir, type Env } from './paths';
import { sessionDir, writeAtomic } from './vault';

export interface LiveCheck {
  readonly live: boolean;
  readonly reason: string;
}

/**
 * ¿Hay un proceso usando esta sesión ahora mismo?
 *
 * Windows no bloquea nada: un `.jsonl` abierto en modo añadir se puede sobrescribir,
 * renombrar o borrar sin error, y el agente sigue escribiendo contra un fichero huérfano
 * hasta que falla en silencio (hallazgo T-4). Además, de los ficheros de pid que deja
 * Claude Code, la mayoría están obsoletos, así que "existe el fichero" no vale como prueba.
 *
 * Regla: ante la duda, se considera VIVA. Un falso positivo cuesta un aviso; un falso
 * negativo cuesta el trabajo del usuario.
 */
export function isSessionLive(env: Env, sessionId: string, homeOverride?: string): LiveCheck {
  const dir = claudeLiveSessionsDir(env, homeOverride);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { live: false, reason: 'no hay registro de sesiones vivas' };
  }

  for (const name of entries) {
    if (!name.endsWith('.json')) {
      continue;
    }
    let data: { pid?: number; sessionId?: string } | undefined;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (data?.sessionId !== sessionId || typeof data.pid !== 'number') {
      continue;
    }
    try {
      process.kill(data.pid, 0);
      return { live: true, reason: `el proceso ${data.pid} sigue vivo` };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM') {
        return { live: true, reason: `el proceso ${data.pid} existe (sin permiso para comprobarlo)` };
      }
      // ESRCH: el pid ya no existe → el fichero es un resto.
    }
  }
  return { live: false, reason: 'ningún proceso vivo usa esta sesión' };
}

export type RestoreMode = 'canonical' | 'sidecar';

export interface RestorePlan {
  readonly rel: string;
  readonly target: string;
  readonly mode: RestoreMode;
  readonly exists: boolean;
}

export interface RestoreOptions {
  /** Sobrescribir la ruta original aunque exista. Exige confirmación explícita arriba. */
  readonly overwrite?: boolean;
  /** Destino alternativo; si no se indica, se usa la ruta original de la parte. */
  readonly targetRoot?: string;
}

function sidecarOf(target: string): string {
  const ext = path.extname(target);
  return `${target.slice(0, target.length - ext.length)}.restored${ext}`;
}

/** Qué se escribiría y dónde, sin tocar nada. */
export function planRestore(
  session: DiscoveredSession,
  options: RestoreOptions = {},
): RestorePlan[] {
  return session.parts.map((part) => {
    const original = options.targetRoot
      ? path.join(options.targetRoot, part.rel.split('/').join(path.sep))
      : part.path;
    const exists = fs.existsSync(original);
    const useSidecar = exists && !options.overwrite;
    return {
      rel: part.rel,
      target: useSidecar ? sidecarOf(original) : original,
      mode: useSidecar ? 'sidecar' : 'canonical',
      exists,
    };
  });
}

export interface RestoreResult {
  readonly rel: string;
  readonly target: string;
  readonly bytes: number;
  readonly backedUpTo?: string;
}

/**
 * Restaura una sesión completa desde el almacén.
 *
 * Garantías: (a) nunca se escribe encima de un fichero existente sin haber guardado antes
 * una copia byte a byte en `_pre-restore/`; (b) el destino se abre en modo exclusivo, de
 * forma que si otro proceso lo tiene abierto la operación falla en vez de destruirlo;
 * (c) restaurar fuera de la ruta canónica deja un duplicado, y un duplicado hace que
 * `claude --resume <id>` responda "not found" — quien llama debe avisar de eso.
 */
export function restoreSession(
  vaultRoot: string,
  session: DiscoveredSession,
  options: RestoreOptions = {},
): RestoreResult[] {
  const plans = planRestore(session, options);
  const results: RestoreResult[] = [];

  for (const plan of plans) {
    const data = rebuildPart(vaultRoot, session, plan.rel);

    let backedUpTo: string | undefined;
    if (fs.existsSync(plan.target)) {
      backedUpTo = path.join(
        vaultRoot,
        '_pre-restore',
        session.sessionId,
        `${Date.now()}-${path.basename(plan.target)}`,
      );
      writeAtomic(backedUpTo, fs.readFileSync(plan.target));
    }

    // Temporal + rename: nunca hay un instante en el que el destino esté borrado o a medias.
    // Y si otro proceso tiene el fichero abierto, en Windows el rename falla — que es justo lo
    // que queremos: mejor un error que destruir el trabajo de una sesión viva.
    fs.mkdirSync(path.dirname(plan.target), { recursive: true });
    const tmp = `${plan.target}.sk-restore-${process.pid}`;
    const fd = fs.openSync(tmp, 'wx');
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, plan.target);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }

    results.push({ rel: plan.rel, target: plan.target, bytes: data.length, backedUpTo });
  }

  return results;
}

/** Documento que acompaña al almacén: cómo recuperar sin la extensión y sin nosotros. */
export function restoreDocs(): string {
  return [
    '# Cómo recuperar tus sesiones sin SessionKeeper',
    '',
    'El almacén es formato abierto. Cada parte de cada sesión vive en:',
    '',
    '```',
    '<vault>/<hostId>/<proveedor>/<proyecto>/<sesión>/parts/<parte>/gen-NNN/',
    '    gen.json          # orden de los trozos, tamaños y sha256',
    '    chunks/000001.gz  # trozos, en orden, comprimidos con gzip',
    '```',
    '',
    'Para reconstruir un fichero, descomprime los trozos **en orden numérico** y concaténalos:',
    '',
    '```bash',
    'cd <...>/gen-001/chunks',
    'for f in $(ls *.gz | sort); do gunzip -c "$f"; done > sesion.jsonl',
    '```',
    '',
    'En Windows con PowerShell puedes usar `node restore.mjs <vault> <destino>`, incluido junto a este fichero.',
    '',
    'Comprueba el resultado con los `sha256` de `gen.json`. Restaurar y exportar son gratis',
    'para siempre y no requieren licencia ni tener la extensión instalada.',
  ].join('\n');
}

export function writeRestoreDocs(vaultRoot: string): void {
  writeAtomic(path.join(vaultRoot, 'RESTORE.md'), restoreDocs());
}

export function vaultSessionPath(vaultRoot: string, session: DiscoveredSession): string {
  return sessionDir(vaultRoot, session);
}

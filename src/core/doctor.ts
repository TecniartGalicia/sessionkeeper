import * as fs from 'fs';
import * as path from 'path';
import type { DiscoveredSession } from './discover';
import { readRange } from './hash';
import { claudeHome, type Env } from './paths';
import { formatBytes, sessionStatus, vaultSize } from './status';

export interface RetentionSetting {
  /** Días declarados, o `undefined` si nadie lo ha puesto (entonces rige el valor por defecto). */
  readonly days?: number;
  readonly source: 'settings.json' | 'settings.local.json' | 'default';
}

/** El valor por defecto documentado por Anthropic. Mínimo 1: `0` es un error de validación. */
export const DEFAULT_CLEANUP_DAYS = 30;
export const MIN_CLEANUP_DAYS = 1;
/** Lo que se escribe para "desactivar" la limpieza sin romper la validación (~100 años). */
export const DISABLE_CLEANUP_DAYS = 36500;

export function readRetention(env: Env, homeOverride?: string): RetentionSetting {
  const home = claudeHome(env, homeOverride);
  for (const file of ['settings.local.json', 'settings.json'] as const) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(home, file), 'utf8')) as {
        cleanupPeriodDays?: unknown;
      };
      if (typeof raw.cleanupPeriodDays === 'number') {
        return { days: raw.cleanupPeriodDays, source: file };
      }
    } catch {
      /* si no existe o no parsea, se sigue buscando */
    }
  }
  return { source: 'default' };
}

export type FindingLevel = 'info' | 'warn' | 'risk';

export interface Finding {
  readonly level: FindingLevel;
  readonly title: string;
  readonly detail: string;
}

export interface DoctorInput {
  readonly env: Env;
  readonly sessions: readonly DiscoveredSession[];
  readonly vaultRoot: string;
  readonly retention: RetentionSetting;
  readonly now: number;
  readonly homeOverride?: string;
}

/** Última línea del fichero: ¿está completa? Solo lectura, y solo de la cola. */
export function tailIsComplete(file: string): boolean {
  try {
    const size = fs.statSync(file).size;
    if (size === 0) {
      return false;
    }
    const tail = readRange(file, Math.max(0, size - 65536), Math.min(65536, size)).toString('utf8');
    const lines = tail.split('\n').filter((l) => l.trim());
    const last = lines[lines.length - 1];
    if (!last) {
      return false;
    }
    JSON.parse(last);
    return true;
  } catch {
    return false;
  }
}

export function runDoctor(input: DoctorInput): { findings: Finding[]; markdown: string } {
  const { env, sessions, vaultRoot, retention, now } = input;
  const findings: Finding[] = [];

  const days = retention.days ?? DEFAULT_CLEANUP_DAYS;
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const atRisk = sessions.filter((s) => s.lastModified < cutoff);
  const unprotected = atRisk.filter((s) => sessionStatus(vaultRoot, s).state === 'new');

  if (retention.source === 'default') {
    findings.push({
      level: atRisk.length ? 'risk' : 'warn',
      title: `Retención en su valor por defecto (${DEFAULT_CLEANUP_DAYS} días)`,
      detail:
        `Nadie ha declarado \`cleanupPeriodDays\`, así que rige el valor por defecto. Si la limpieza está activa, ` +
        `Claude Code borra al arrancar las sesiones más antiguas que ese plazo, sin aviso ni papelera. ` +
        (atRisk.length
          ? `Aquí hay **${atRisk.length}** por encima del plazo, **${unprotected.length}** de ellas sin copia.`
          : `Ahora mismo no hay ninguna por encima del plazo.`),
    });
  } else {
    findings.push({
      level: days >= DISABLE_CLEANUP_DAYS ? 'info' : atRisk.length ? 'risk' : 'warn',
      title: `Retención: ${days} días (${retention.source})`,
      detail:
        days >= DISABLE_CLEANUP_DAYS
          ? 'La limpieza automática está efectivamente desactivada.'
          : `${atRisk.length} sesiones superan el plazo; ${unprotected.length} de ellas no tienen copia.`,
    });
  }

  const orphans = sessions.filter((s) => sessionStatus(vaultRoot, s).state === 'orphan');
  if (orphans.length) {
    findings.push({
      level: 'info',
      title: `${orphans.length} sesiones ya solo existen aquí`,
      detail: 'Su original desapareció del disco. La copia es lo único que queda: se puede restaurar.',
    });
  }

  const broken = sessions.filter((s) => !tailIsComplete(s.parts[0]?.path ?? ''));
  if (broken.length) {
    findings.push({
      level: 'warn',
      title: `${broken.length} sesiones acaban en una línea incompleta`,
      detail: 'Suele ser una sesión en curso. Si no lo es, el fichero se cortó a medias.',
    });
  }

  const totalBytes = sessions.reduce((n, s) => n + s.totalBytes, 0);
  const heavy = sessions.filter((s) => s.totalBytes > 50 * 1024 * 1024);
  findings.push({
    level: 'info',
    title: `${sessions.length} sesiones, ${formatBytes(totalBytes)} en disco`,
    detail: `${heavy.length} pasan de 50 MB. El almacén ocupa ${formatBytes(vaultSize(vaultRoot))}.`,
  });

  const icon = (l: FindingLevel): string => (l === 'risk' ? '🔴' : l === 'warn' ? '🟠' : '🔵');
  const markdown = [
    '# SessionKeeper — diagnóstico',
    '',
    `_${new Date(now).toISOString()} · ${claudeHome(env, input.homeOverride)}_`,
    '',
    ...findings.flatMap((f) => [`## ${icon(f.level)} ${f.title}`, '', f.detail, '']),
    '---',
    '',
    'Este informe **no modifica nada**. Las acciones que escriben (copiar, restaurar, ajustar la',
    'retención) piden confirmación, guardan copia previa y se pueden deshacer.',
    '',
    'Nota honesta sobre la retención: Claude Code **pausa** su limpieza cuando no puede determinar',
    'con seguridad el plazo, así que "en riesgo" significa *si la limpieza está activa*, no que vaya',
    'a ocurrir con certeza.',
  ].join('\n');

  return { findings, markdown };
}

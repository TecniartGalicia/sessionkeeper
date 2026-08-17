/**
 * Detección de credenciales en las transcripciones.
 *
 * La documentación de Claude Code lo dice sin rodeos: si una herramienta lee un `.env` o
 * un comando imprime una credencial, ese valor queda escrito en el `.jsonl`. Por eso el
 * aviso se da **al copiar** y es gratuito: quien va a guardar copias de sus sesiones tiene
 * derecho a saber que está multiplicando secretos, sobre todo si el destino es una carpeta
 * sincronizada con la nube.
 *
 * Se avisa; no se modifica nada. La redacción solo se aplica al exportar, nunca al copiar:
 * una copia recortada dejaría de ser una copia.
 *
 * Criterio de diseño: un aviso que salta con cualquier ruta temporal es un aviso que se
 * ignora. Los patrones van anclados a formatos reales y los valores de ejemplo se descartan.
 */

export interface SecretPattern {
  readonly id: string;
  readonly label: string;
  readonly re: RegExp;
  /**
   * Patrones genéricos (asignaciones, cabeceras, URLs) donde un valor de ejemplo es
   * probable. Solo a estos se les aplica el filtro de marcadores; los formatos estrictos
   * —una clave de AWS, un JWT— son inconfundibles y no deben filtrarse: `db.example.com`
   * no convierte en falsa una contraseña real.
   */
  readonly loose?: boolean;
}

/** Valores que aparecen en documentación y plantillas: nunca son credenciales de verdad. */
const PLACEHOLDER = /(?:^|[^a-z0-9])(?:your|tu|my|mi|example|ejemplo|placeholder|changeme|xxx+|test|dummy|fake|sample|aqui|here|todo|redacted|\.\.\.)(?:[^a-z0-9]|$)/i;

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { id: 'aws-key', label: 'clave de AWS', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', label: 'token de GitHub', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: 'github-pat', label: 'token de GitHub (fine-grained)', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { id: 'anthropic-key', label: 'clave de Anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'openai-key', label: 'clave de OpenAI', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  { id: 'slack-token', label: 'token de Slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'google-key', label: 'clave de Google', re: /\bAIza[0-9A-Za-z_-]{33,}/ },
  { id: 'stripe-key', label: 'clave de Stripe', re: /\b[rs]k_live_[A-Za-z0-9]{20,}\b/ },
  { id: 'npm-token', label: 'token de npm', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'private-key', label: 'clave privada', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'jwt', label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    id: 'bearer',
    label: 'cabecera Authorization',
    re: /\bAuthorization\s*:\s*(?:Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/i,
  },
  {
    id: 'uri-credentials',
    label: 'contraseña en una URL',
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]{4,}@[^\s/]+/i,
  },
  {
    id: 'env-assign',
    label: 'variable con secreto',
    re: /\b[A-Za-z0-9_.-]*(?:SECRET|PASSWORD|PASSWD|PASSPHRASE|API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET)[A-Za-z0-9_.-]*\s*[=:]\s*["']?([^\s"',;}]{8,})/i,
    loose: true,
  },
];

export interface SecretHit {
  readonly id: string;
  readonly label: string;
  readonly count: number;
}

function globalOf(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
}

/** ¿Es un valor de documentación en vez de una credencial? Solo se pregunta en los sueltos. */
function isPlaceholder(pattern: SecretPattern, match: RegExpMatchArray): boolean {
  if (!pattern.loose) {
    return false;
  }
  return PLACEHOLDER.test(match[1] ?? match[0]);
}

/**
 * Cuenta coincidencias por tipo. Nunca devuelve el valor encontrado: un informe que
 * imprimiera el secreto sería otro sitio donde queda escrito.
 */
export function scanText(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const pattern of SECRET_PATTERNS) {
    let count = 0;
    for (const match of text.matchAll(globalOf(pattern.re))) {
      if (!isPlaceholder(pattern, match)) {
        count++;
      }
    }
    if (count) {
      hits.push({ id: pattern.id, label: pattern.label, count });
    }
  }
  return hits;
}

/** Sustituye los valores detectados por una marca, para exportar sin filtrar nada. */
export function redact(text: string): { text: string; hits: SecretHit[] } {
  const hits = scanText(text);
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(globalOf(pattern.re), (...args: unknown[]) => {
      const match = args[0] as string;
      const groups = args.slice(1, -2) as (string | undefined)[];
      const value = groups[0];
      if (pattern.loose && PLACEHOLDER.test(value ?? match)) {
        return match;
      }
      // En los patrones con grupo se sustituye solo el valor, para no borrar el contexto
      // (`Authorization: Bearer …` sigue leyéndose como tal en la exportación).
      return value ? match.replace(value, `[redacted: ${pattern.id}]`) : `[redacted: ${pattern.id}]`;
    });
  }
  return { text: out, hits };
}

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
 */

export interface SecretPattern {
  readonly id: string;
  readonly label: string;
  readonly re: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { id: 'aws-key', label: 'clave de AWS', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', label: 'token de GitHub', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: 'openai-key', label: 'clave tipo sk-', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'anthropic-key', label: 'clave de Anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'slack-token', label: 'token de Slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'google-key', label: 'clave de Google', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'stripe-key', label: 'clave de Stripe', re: /\b[rs]k_live_[A-Za-z0-9]{20,}\b/ },
  { id: 'private-key', label: 'clave privada', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'jwt', label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    id: 'env-assign',
    label: 'variable con secreto',
    re: /\b(?:[A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?TOKEN|PRIVATE_?KEY))\s*[=:]\s*["']?[^\s"',}]{8,}/,
  },
];

export interface SecretHit {
  readonly id: string;
  readonly label: string;
  readonly count: number;
}

/**
 * Cuenta coincidencias por tipo. Nunca devuelve el valor encontrado: un informe que
 * imprimiera el secreto sería otro sitio donde queda escrito.
 */
export function scanText(text: string): SecretHit[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const pattern of SECRET_PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags.includes('g') ? pattern.re.flags : `${pattern.re.flags}g`);
    const found = text.match(re);
    if (found?.length) {
      counts.set(pattern.id, { label: pattern.label, count: found.length });
    }
  }
  return [...counts.entries()].map(([id, v]) => ({ id, label: v.label, count: v.count }));
}

/** Sustituye los valores detectados por una marca, para exportar sin filtrar nada. */
export function redact(text: string): { text: string; hits: SecretHit[] } {
  const hits = scanText(text);
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags.includes('g') ? pattern.re.flags : `${pattern.re.flags}g`);
    out = out.replace(re, `[redacted: ${pattern.id}]`);
  }
  return { text: out, hits };
}

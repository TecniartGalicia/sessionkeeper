import { redact, type SecretHit } from './secrets';

interface Block {
  type?: string;
  text?: string;
  name?: string;
  content?: unknown;
}

interface Entry {
  type?: string;
  timestamp?: string;
  message?: { role?: string; content?: string | Block[] };
}

function textOf(content: string | Block[] | undefined): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block?.text === 'string') {
      parts.push(block.text);
    } else if (block?.type === 'tool_use' && block.name) {
      parts.push(`\`[herramienta: ${block.name}]\``);
    } else if (block?.type === 'tool_result') {
      const raw = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
      parts.push(['```', raw.slice(0, 2000), '```'].join('\n'));
    }
  }
  return parts.join('\n\n');
}

export interface ExportOptions {
  /** Sustituir credenciales por marcas. Activado por defecto al compartir. */
  readonly redactSecrets?: boolean;
  readonly title?: string;
}

export interface ExportResult {
  readonly markdown: string;
  readonly secrets: readonly SecretHit[];
  readonly messages: number;
}

/** Convierte una transcripción JSONL en Markdown legible. Tolera líneas ilegibles. */
export function toMarkdown(jsonl: string, options: ExportOptions = {}): ExportResult {
  const out: string[] = [`# ${options.title ?? 'Sesión'}`, ''];
  let messages = 0;

  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let entry: Entry;
    try {
      entry = JSON.parse(trimmed) as Entry;
    } catch {
      continue;
    }
    if (entry.type !== 'user' && entry.type !== 'assistant') {
      continue;
    }
    const body = textOf(entry.message?.content).trim();
    if (!body) {
      continue;
    }
    messages++;
    const who = entry.type === 'user' ? 'Tú' : 'Agente';
    const when = entry.timestamp ? ` · ${entry.timestamp}` : '';
    out.push(`### ${who}${when}`, '', body, '');
  }

  const joined = out.join('\n');
  if (options.redactSecrets === false) {
    return { markdown: joined, secrets: [], messages };
  }
  const { text, hits } = redact(joined);
  return { markdown: text, secrets: hits, messages };
}

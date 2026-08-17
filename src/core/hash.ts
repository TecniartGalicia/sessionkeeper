import { createHash } from 'crypto';
import * as fs from 'fs';

/** Cuántos bytes se muestrean de la cabecera y de la cola para detectar reescrituras. */
export const PROBE_BYTES = 64 * 1024;

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Lee un rango de un fichero sin cargarlo entero. Devuelve lo que haya, aunque sea menos. */
export function readRange(file: string, start: number, length: number): Buffer {
  if (length <= 0) {
    return Buffer.alloc(0);
  }
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, start);
    return read === length ? buf : buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

export interface Probes {
  /** sha256 de los primeros PROBE_BYTES (o de todo, si es más corto). */
  readonly head: string;
  /** sha256 de los últimos PROBE_BYTES de la parte ya copiada. */
  readonly tail: string;
  /** Bytes sobre los que se calculó `tail`. */
  readonly tailFrom: number;
}

/**
 * Huellas de continuidad de un fichero de solo-añadir.
 *
 * La v1 del plan solo comprobaba la cola: una reescritura que conservara esos últimos
 * 64 KB pasaba desapercibida y producía una copia Frankenstein que aun así cuadraba con
 * su hash acumulado (hallazgo T-10). Por eso se comprueban las dos puntas.
 */
export function probeFile(file: string, copiedBytes: number): Probes {
  const head = sha256(readRange(file, 0, Math.min(PROBE_BYTES, Math.max(copiedBytes, 0) || PROBE_BYTES)));
  const tailFrom = Math.max(0, copiedBytes - PROBE_BYTES);
  const tail = sha256(readRange(file, tailFrom, copiedBytes - tailFrom));
  return { head, tail, tailFrom };
}

/**
 * Último corte seguro dentro de un bloque recién leído: el final de la última línea que
 * **parsea como JSON**. Un simple `\n` no basta — hay escrituras entrelazadas entre el
 * agente, los resultados de herramientas y los subagentes (hallazgo T-19).
 *
 * Devuelve cuántos bytes del bloque se pueden dar por buenos (0 = ninguno todavía).
 */
export function safeCutOffset(block: Buffer): number {
  let end = block.length;
  while (end > 0) {
    const nl = block.lastIndexOf(0x0a, end - 1);
    if (nl < 0) {
      return 0;
    }
    const line = block.subarray(lineStart(block, nl), nl).toString('utf8').trim();
    if (line === '' || isJsonLine(line)) {
      return nl + 1;
    }
    end = nl;
  }
  return 0;
}

function lineStart(block: Buffer, nl: number): number {
  const prev = block.lastIndexOf(0x0a, nl - 1);
  return prev < 0 ? 0 : prev + 1;
}

function isJsonLine(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

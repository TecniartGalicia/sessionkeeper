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

/** Cada cuántos bytes se coloca una sonda intermedia. */
export const PROBE_EVERY = 16 * 1024 * 1024;
/** Tope de sondas intermedias, para que un fichero enorme no dispare la lectura. */
export const MAX_PROBES = 24;

/**
 * Huellas de continuidad de un fichero de solo-añadir: cabecera, cola y sondas repartidas.
 *
 * Comprobar solo la cola dejaba pasar una reescritura que la conservara (hallazgo T-10);
 * comprobar solo las dos puntas deja pasar una reescritura **del medio**, que produce
 * exactamente el mismo fichero Frankenstein: cuadra con su hash acumulado y no es el
 * original. Con una sonda cada 16 MB, verificar un fichero de 324 MB cuesta ~1,3 MB de
 * lectura, y el 68 % de los bytes del corpus real está en 9 ficheros de ese tamaño.
 */
export function probeOffsets(copiedBytes: number): number[] {
  const offsets: number[] = [];
  if (copiedBytes <= 2 * PROBE_BYTES) {
    return offsets;
  }
  const usable = copiedBytes - 2 * PROBE_BYTES;
  // Siempre al menos una sonda intermedia: un fichero de 400 KB también puede reescribirse
  // por el medio conservando tamaño y puntas, y ese es justo el fallo que hay que cazar.
  const count = Math.max(1, Math.min(MAX_PROBES, Math.ceil(usable / PROBE_EVERY)));
  for (let i = 1; i <= count; i++) {
    offsets.push(PROBE_BYTES + Math.floor((usable * i) / (count + 1)));
  }
  return offsets;
}

export function probeMid(file: string, copiedBytes: number): string {
  const offsets = probeOffsets(copiedBytes);
  if (!offsets.length) {
    return '';
  }
  const hash = createHash('sha256');
  for (const offset of offsets) {
    hash.update(readRange(file, offset, Math.min(PROBE_BYTES, copiedBytes - offset)));
  }
  return hash.digest('hex');
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

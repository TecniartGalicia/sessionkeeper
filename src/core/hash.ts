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

/** Cuánto se retrocede como máximo buscando una línea válida. */
export const MAX_SCAN_BACK = 1024 * 1024;

/**
 * Último corte seguro dentro de un bloque recién leído: el final de la última línea que
 * **parsea como JSON**. Un simple `\n` no basta — hay escrituras entrelazadas entre el
 * agente, los resultados de herramientas y los subagentes (hallazgo T-19).
 *
 * La marcha atrás está acotada **por bytes explorados**, no por número de líneas: recorrer
 * 4 MB de líneas ilegibles costaba 320 ms, y acotar por líneas dejaría atascada para siempre
 * una parte cuyo obstáculo fuese una única línea gigantesca. Si no hay corte dentro de la cota
 * se devuelve 0, y quien llama decide: esperar el ciclo siguiente o —si el fichero ya creció
 * más allá— copiar en crudo (ver `backupPart`).
 *
 * Devuelve cuántos bytes del bloque se pueden dar por buenos (0 = ninguno todavía).
 */
export function safeCutOffset(block: Buffer): number {
  const floor = Math.max(0, block.length - MAX_SCAN_BACK);
  let end = block.length;
  while (end > floor) {
    const nl = block.lastIndexOf(0x0a, end - 1);
    if (nl < 0 || nl < floor) {
      return 0;
    }
    // Descarte barato antes de gastar un JSON.parse: una línea de transcripción es un objeto,
    // así que si no empieza y acaba por llave no hace falta ni construir el string. Con esto,
    // recorrer un megabyte de líneas rotas cuesta milisegundos en vez de segundos.
    const from = lineStart(block, nl);
    let a = from;
    let b = nl - 1;
    while (a < nl && isSpace(block[a])) a++;
    while (b >= a && isSpace(block[b])) b--;
    if (b < a) {
      return nl + 1; // línea en blanco: frontera válida
    }
    if (block[a] === 0x7b && block[b] === 0x7d && isJsonLine(block.subarray(a, b + 1).toString('utf8'))) {
      return nl + 1;
    }
    end = nl;
  }
  return 0;
}

function isSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a;
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

#!/usr/bin/env node
// Recupera un almacén de SessionKeeper sin la extensión:
//   node restore.mjs <carpeta-del-vault> <carpeta-destino>
//
// Toma la ÚLTIMA generación de cada parte y verifica el sha256 de cada trozo antes de
// escribir nada. No necesita la extensión, ni licencia, ni conexión.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const [vault, dest] = process.argv.slice(2);
if (!vault || !dest) {
  console.error('uso: node restore.mjs <carpeta-del-vault> <carpeta-destino>');
  process.exit(1);
}

const WIN = process.platform === 'win32';
// Prefijo de rutas largas de Windows: sin él, una ruta de más de 260 caracteres falla en
// equipos donde LongPathsEnabled está desactivado (que es el valor por defecto).
const long = (p) => (WIN && !p.startsWith('\\\\?\\') ? '\\\\?\\' + path.resolve(p) : p);
const dirs = (d) => {
  try {
    return fs.readdirSync(long(d), { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return [];
  }
};

const generationOf = (name) => {
  if (!name.startsWith('gen-')) return NaN;
  const n = Number(name.slice(4));
  return Number.isInteger(n) ? n : NaN;
};

let ok = 0;
let bad = 0;

// <vault>/<proveedor>/<proyecto>/<sesión>/parts/<parte>/gen-NNN/
for (const provider of dirs(vault)) {
  if (provider.name.startsWith('_')) continue; // _pre-restore y demás carpetas internas
  const providerDir = path.join(vault, provider.name);
  for (const project of dirs(providerDir)) {
    const projectDir = path.join(providerDir, project.name);
    for (const session of dirs(projectDir)) {
      const partsDir = path.join(projectDir, session.name, 'parts');
      for (const part of dirs(partsDir)) {
        const partDir = path.join(partsDir, part.name);
        const gens = dirs(partDir)
          .map((e) => generationOf(e.name))
          .filter((n) => !Number.isNaN(n))
          .sort((a, b) => a - b);
        if (!gens.length) continue;

        const gen = gens[gens.length - 1]; // la última, no la primera que devuelva el sistema
        const genDir = path.join(partDir, 'gen-' + String(gen).padStart(3, '0'));
        let state;
        try {
          state = JSON.parse(fs.readFileSync(long(path.join(genDir, 'gen.json')), 'utf8'));
        } catch (err) {
          console.error('ESTADO ILEGIBLE ' + genDir + ': ' + err.message);
          bad++;
          continue;
        }

        const blocks = [];
        let broken = false;
        for (const chunk of state.chunks) {
          const file = path.join(genDir, 'chunks', String(chunk.n).padStart(6, '0') + '.gz');
          try {
            const raw = zlib.gunzipSync(fs.readFileSync(long(file)));
            if (crypto.createHash('sha256').update(raw).digest('hex') !== chunk.sha256) {
              console.error('TROZO CORRUPTO ' + file);
              broken = true;
              break;
            }
            blocks.push(raw);
          } catch (err) {
            console.error('TROZO ILEGIBLE ' + file + ': ' + err.message);
            broken = true;
            break;
          }
        }
        if (broken) {
          bad++;
          continue;
        }

        const out = path.join(dest, provider.name, project.name, session.name, state.rel);
        fs.mkdirSync(long(path.dirname(out)), { recursive: true });
        fs.writeFileSync(long(out), Buffer.concat(blocks));
        ok++;
      }
    }
  }
}

console.log('recuperados ' + ok + ' ficheros en ' + dest + (bad ? ' (' + bad + ' con problemas)' : ''));
if (bad) process.exit(2);

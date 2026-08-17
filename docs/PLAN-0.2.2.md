# Plan 0.2.2 — v2, tras la auditoría

> Interno (gitignored). **v1 descartada**: el auditor independiente devolvió *REPLANTEAR* con seis
> bloqueantes, y tenía razón en lo esencial. Lo que sigue es el plan corregido, con lo que se ejecuta
> ahora y lo que se aparca a la 0.3.0.

## Qué se cayó de la v1, y por qué

**1. El número que justificaba todo el plan estaba mal atribuido.** Yo dije "188 trozos ocupan 1,3 veces
el original". Medido en serio: ese 1,3× **no son los trozos, es `gen.json`**, y solo aparece con la
sesión más pequeña posible (22 KB). Con una sesión de tamaño realista el almacén ocupa **0,11× el
origen hoy, sin tocar nada** — es decir, el criterio de aceptación que había escrito (`≤ 0,40×`) ya lo
cumple el motor actual y no medía nada.

**2. El problema real es otro, y la consolidación no lo arregla**: **amplificación de escritura**.
`gen.json` se reescribe entero con `fsync` en cada ciclo, así que 2000 ciclos sobre un origen de 226 KB
escribieron **306 MB** (1353×), y en NTFS 2000 trozos de ~95 bytes ocupan **37× el origen** en clústeres
de 4 KB, algo que `vaultSize` no ve porque cuenta bytes lógicos.

**3. La consolidación era la peor de las opciones sobre la mesa.** Subir el umbral del watcher da
**~20×** de la mejora (de ~2000 trozos a ~96 en ocho horas) con **cero migración y cero borrados**. Y si
algún día hace falta más, la buena es un **contenedor append-only por generación**: el auditor verificó
que los miembros gzip son concatenables, que `gunzip -c` sigue funcionando y que un corte a mitad de
`append` falla en alto en vez de en silencio. Estrenar la primera operación que **borra** ficheros del
almacén en una *patch* de un producto que ya cobra era el mayor riesgo del plan, y era evitable.

## Lo que la auditoría encontró que no tiene nada que ver con R1 (y es lo urgente)

Tres cosas que ya están en manos de clientes:

- **Revocar la licencia no apaga la vigilancia.** `onDidChangeProStatus` se dispara y **nadie se
  suscribe**: una clave revocada sigue vigilando hasta que se reinicie VS Code. Es exactamente al revés
  de la promesa publicada — está dando de pago lo que ya no está pagado.
- **El vigilante se muere de hambre justo cuando hay que copiar.** El debounce se **reinicia** en cada
  evento, así que con escrituras cada pocos segundos —un turno normal de agente— hay **cero copias
  mientras la sesión está activa**; lo único que protege es el temporizador de 15 minutos. Y la ficha
  vendida dice *"as they change"*. Mi v1 proponía subir el debounce a 15 s: habría **empeorado** esto.
- **Cada ciclo pasea el almacén entero dos veces.** `backup()` llama a `sweepTempFiles` y `vaultSize`
  sin condición: 306 ms para copiar 167 bytes con 40 sesiones, y ~21 s proyectados con un almacén
  grande — más de lo que dura el intervalo.

---

## R1 — Que la vigilancia cumpla lo que promete la ficha · ~0,5 día

**Throttle con tope duro**, no debounce: se copia en el flanco de subida y, si la actividad continúa, se
copia igualmente cada **60 s como máximo**. Temporizador de respaldo de 15 min → **3 min**. Umbral de
64 KB de delta con escapatoria por tiempo. Debounce y tope **inyectables**, para poder probarlos.

**Aceptación** (medible, con temporizadores falsos): con escrituras cada 4,5 s sostenidas durante 10
minutos, **≥ 9 copias** (hoy: 0); ningún ciclo con delta < 64 KB salvo el de la escapatoria; y la
garantía real —"como muy tarde 60 s después del cambio"— escrita en la ficha en lugar de *"as they
change"*.

## R2 — Que la licencia gobierne de verdad · ~0,25 día

`ProFeatures.sync` suscrito a `onDidChangeProStatus`; revalidación al recuperar el foco de la ventana
además de cada 24 h. **Aceptación**: test con `fetch` sustituido en el que una clave que pasa a revocada
apaga la vigilancia **sin reiniciar**, y la copia manual sigue funcionando después.

## R3 — Coste por ciclo · ~0,5 día

`sweepTempFiles` y la escritura de `RESTORE.md`/`restore.mjs`, **solo en el primer ciclo** tras activar.
`vaultSize` cacheado e incrementado con lo copiado (recálculo completo bajo demanda). `discover()` con
caché por `mtime` de directorio. El bucle cede el hilo entre sesiones.

**Aceptación**: ciclo en vacío con 60 sesiones **< 60 ms** (hoy 628 ms); retraso p99 del bucle de eventos
< 50 ms durante un barrido; y el criterio de CPU < 1 % medido de verdad, no supuesto.

## R4 — Los fallos del vigilante y del almacén · ~0,5 día

| # | Fallo (auditoría) | Arreglo |
|---|---|---|
| A-14 | `FSWatcher` sin oyente de `'error'`: un error **lanza** dentro del host de extensiones | `on('error')` con reinicio y backoff |
| A-14 | Si la carpeta no existe al arrancar, nunca se reintenta (`watchTargetExists` es código muerto) | reintento periódico usando esa función |
| A-14 | `lastRun` solo se actualiza al terminar bien → tras un error el ciclo entra a los 2 s | actualizar siempre |
| A-14 | El lock ajeno se registra como error **en cada ciclo, para siempre** | avisar una sola vez |
| A-13 | Al llegar al presupuesto la vigilancia **se para en silencio**; y el aviso de credenciales desaparece en la vía automática | propagar `budgetReached` (una vez) y `secrets` al camino automático |
| A-3 | Lock TOCTOU (`readJson`+`writeAtomic` sin `wx`) y latido **entre sesiones**, no dentro | `openSync(..., 'wx')`, latido dentro del bucle de bloques, y lock también al restaurar |
| A-15 | `gen-1000` es invisible: el filtro es `/^gen-\d{3}$/` y el nombre ya no cabe | filtro `/^gen-\d+$/` y comparación numérica |
| A-1 | `restore.mjs` no valida contigüidad ni total: devolvería un fichero desordenado con **código 0** | replicar las tres comprobaciones de `rebuildPart` y ordenar por `from` |
| A-5 | `formatVersion` se escribe y **no se lee**: una versión vieja no sabría rechazar un almacén nuevo | leerlo y rechazar formatos superiores con mensaje claro |
| A-16 | El arreglo de `safeCutOffset` que propuse podía **atascar una parte para siempre** | acotar por bytes explorados, conservando la escapatoria de línea gigante; test con línea de 2 MB |

## R5 — Pruebas de lo que hoy no tiene ninguna · ~0,5 día

La función de pago es la única parte sin tests. Con el stub de `vscode` que ya existe y nadie usa, y
temporizadores falsos: inanición, sin licencia, revocación en caliente, error en un ciclo que no mata el
temporizador, sesión nueva que aparece, lock ajeno. Un único test de integración con el debounce
inyectado y timeout holgado. La prueba con clave viva queda como comprobación **manual** documentada,
fuera de CI.

## R6 — La ficha y el registro, al día · ~0,25 día

- *"as they change"* → la garantía real de R1.
- *"kilobytes, in milliseconds"* → cierto hoy por poco y falso al crecer; se reformula.
- *"it checks both ends"* → ahora son tres sondas.
- **`AUDITORIA.md` §0 dice que el cifrado del vault está "aplicado" y no lo está**: se corrige a "no
  aplicado, decisión pendiente" para que la próxima auditoría no herede una premisa falsa.
- Test que compare las promesas medibles del README con las constantes del código.

## R7 — Publicar 0.2.2

`check` + integración en Windows y Linux, CHANGELOG, tag, verificación en las tres tiendas con el guion
de reintento del Marketplace.

---

## Aparcado a la 0.3.0, con decisión escrita

| Qué | Decisión |
|---|---|
| **Formato append-only** por generación (miembros gzip concatenados) | Sí, en 0.3.0: `VAULT_FORMAT = 2`, doble camino de lectura, `restore-v2.mjs`. Resuelve la amplificación de escritura sin borrar nada |
| **Poda y retención** (`_pre-restore` y generaciones crecen sin techo) | Entra con el formato 2 |
| **Búsqueda full-text** (`node:sqlite` + FTS5) | 0.3.0 |
| **Cifrado del vault** | **Decisión del usuario**: implementarlo en 0.3.0 o retirar la promesa. Hoy no está y la ficha no lo anuncia, así que no hay engaño, pero el registro de auditoría lo daba por hecho |
| Soporte real de remotos | Fuera de alcance, declarado en el README |

## Riesgos de este plan

| Riesgo | Mitigación |
|---|---|
| Copiar cada 60 s durante actividad sostenida cuesta más ciclos que hoy | Por eso R3 va en el mismo release: un ciclo pasa de 628 ms a < 60 ms |
| Tocar el lock puede romper la exclusión que hoy funciona | `wx` es más estricto, no menos; y hay test de dos ventanas con muerte brusca |
| Nada de esto cambia el formato del almacén | Es deliberado: los almacenes de producción siguen siendo válidos y legibles con la 0.2.1 |

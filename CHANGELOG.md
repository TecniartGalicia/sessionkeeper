# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versionado [SemVer](https://semver.org/lang/es/).

## [0.2.2] — 2026-08-17

Arreglos que salen de una auditoría independiente del plan de la 0.2.2, que devolvió
*replantear*: el problema que iba a arreglar estaba mal medido y había tres fallos peores al lado.

### Corregido
- **La vigilancia continua no copiaba durante la actividad.** El temporizador se reiniciaba con
  cada cambio, así que en una sesión activa —que escribe cada pocos segundos— no se copiaba nada
  hasta que la sesión paraba; lo único que protegía era el respaldo de 15 minutos. Ahora hay un
  tope duro: **todo cambio queda copiado como muy tarde 60 s después**, y el respaldo baja a 3 min.
- **Una licencia revocada seguía vigilando** hasta reiniciar VS Code: el cambio de estado no
  estaba conectado. Ahora se apaga en cuanto se detecta, y se revalida al volver a la ventana.
- **Cada ciclo paseaba el almacén entero dos veces** (barrido de temporales y cálculo de tamaño):
  628 ms por ciclo con 60 sesiones. Ahora la preparación ocurre una vez por sesión de VS Code, el
  tamaño se mantiene incrementalmente y el estado se cachea por `mtime`: **92 ms**.
- Al llegar al presupuesto de disco, o al detectar credenciales, la vigilancia lo avisaba solo en
  el camino manual: ahora también en el automático, una vez y no en bucle.
- El vigilante ya no puede tumbar el host de extensiones (`error` sin oyente), reintenta si la
  carpeta aún no existe, no se atasca tras un fallo y no llena el registro cuando otra ventana
  tiene el almacén.
- El lock del almacén se toma con creación exclusiva y late **durante** la copia de un fichero
  grande, no solo entre sesiones.
- La generación 1000 era invisible (el filtro esperaba tres dígitos) y se habría copiado encima.
- `restore.mjs` ahora ordena por posición y verifica contigüidad y total: antes, un `gen.json`
  desordenado habría devuelto un fichero del tamaño correcto con el contenido mezclado, y con
  código de salida 0.
- El almacén declara su formato y una versión que no lo entienda lo dice en vez de leerlo a medias.
- Buscar el corte de línea está acotado y ya no puede atascar una parte con una línea gigante.

### Cambiado
- La ficha dice ahora la garantía real de la vigilancia (60 s) en lugar de "a medida que cambian".

## [0.2.1] — 2026-08-17

### Cambiado
- Capturas reales en la ficha: el árbol con los estados de copia (incluida una sesión que ya
  solo existe en el almacén) y el informe del diagnóstico.

## [0.2.0] — 2026-08-17

### Añadido
- **SessionKeeper Pro** (12 € de pago único; 7 € con el código `LANZAMIENTO` hasta el 2026-09-14):
  vigilancia continua —las sesiones se copian a medida que cambian, sin pulsar nada— y Codex
  como segundo origen. Licencias vía Polar, con validación offline-first: caché de 60 s,
  revalidación cada 24 h y 14 días de gracia sin red.
- Comandos `Pro: introducir clave`, `Pro: estado de la licencia`, `Pro: quitar la licencia de
  este equipo` y `Pro: conseguir una licencia`.

### Notas
- **Pro solo añade.** Copiar a mano, restaurar, exportar y el diagnóstico siguen siendo gratis
  sin licencia; si una clave deja de valer, lo único que se apaga es la vigilancia.
- Compromiso publicado en el README: si el desarrollo se congela, el Pro se libera.

## [0.1.0] — 2026-08-17

Primera versión pública.

### Añadido
- Descubrimiento de las sesiones de Claude Code como unidad completa: transcripción, `subagents/`, `tool-results/` y la carpeta `memory/` del proyecto.
- Copia incremental a un almacén local: trozos gzip por generaciones, con doble huella (cabecera y cola) para detectar reescrituras y corte seguro en la última línea válida.
- Restauración con copia previa del destino, apertura exclusiva y comprobación de que la sesión no esté en marcha.
- Diagnóstico: riesgo por retención, sesiones que solo existen ya en el almacén, integridad, ocupación y detección de credenciales.
- Exportación a Markdown con credenciales sustituidas.
- Almacén en formato abierto con `RESTORE.md` y `restore.mjs` para recuperar sin la extensión.
- Aviso de credenciales al copiar y sustitución al exportar.
- Lock del almacén entre ventanas, presupuesto de disco que avisa y para sin borrar nada,
  y permisos restrictivos (0700/0600) en el almacén.
- Interfaz en inglés y castellano.

### Notas
- Esta versión es completamente gratuita. No hay telemetría, cuentas ni llamadas de red.
- El motor y la restauración pasaron una auditoría independiente antes de publicarse; los
  seis fallos bloqueantes que encontró están corregidos y documentados en `docs/AUDITORIA.md`.

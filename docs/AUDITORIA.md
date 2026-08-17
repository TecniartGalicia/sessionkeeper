# Auditorías

Cada fase de SessionKeeper la revisa un agente independiente con contexto limpio, y todos los hallazgos se resuelven antes de pasar a la siguiente. Aquí quedan registrados con su resolución.

---

## §0 — Auditoría del plan (2026-08-17, antes de escribir código)

Dos auditorías independientes sobre la v1 de `ANALISIS.md` y `PLAN.md`: una **técnica** (verificación en disco, mediciones y diseño del motor) y una de **producto, mercado y riesgo legal** (verificación contra GitHub, la documentación oficial y la API del Marketplace). 25 + 17 hallazgos. Resultado: la v1 no era publicable como plan — cinco premisas eran falsas.

### Lo que se verificó de primera mano antes de aceptar cada hallazgo

| Comprobación | Resultado |
|---|---|
| Sesiones reales (`projects/<slug>/*.jsonl`, nivel 2) | **91 ficheros, 2,09 GB**; mediana 5,3 MB, p90 40,5 MB, máx 324 MB |
| Ficheros de subagentes (nivel 4) | **651** |
| Directorios `<sessionId>/subagents` y `/tool-results` | **Existen**: 20 sesiones con subagentes (155 MB), 52 con salidas derramadas (7,9 MB) |
| `projects/<slug>/memory/` | **111 ficheros** de memoria persistente |
| Sesión de nivel superior más antigua | **2026-07-22 (26 días)** — no queda ninguna de más de 30 |
| Profundidad de los "264 ficheros del 3-jul" | 223 a nivel 4 + 41 a nivel 6 → **subagentes, no una migración** |
| `node:sqlite` + FTS5 en el host real | **`{node:24.18.0, electron:42.8.0, sqlite:3.53.1, fts5:"SI"}`** en VS Code 1.133.0 |
| `cleanupPeriodDays` en la doc oficial | *"Default 30, **minimum 1**"* → **`0` es un error de validación** |
| Estado de las incidencias citadas | #64999, #62959, #58608, #48334, #45076 **cerradas**; #62476 y #59248 abiertas; **#86730, #85466, #84279, #82084 abiertas y recientes** |
| Duplicados y `--resume` | Doc oficial: *"a hand-copied duplicate makes Claude Code report not-found"* |
| Mayor rollout de Codex | **536 MiB** (mayor que el peor caso de Claude Code) |

### Hallazgos técnicos

| # | Sev. | Hallazgo | Resolución |
|---|---|---|---|
| T-1 | Bloqueante | "740 sesiones / 2,25 GB": son 91 sesiones + 651 subagentes; la distribución real es de cola pesada (68 % de los bytes en 9 ficheros) | **Aplicado.** ANALISIS §2.3 rehecho; F1 recalibrada sobre "pocos ficheros enormes" |
| T-2 | Bloqueante | La sesión es un **directorio** (`subagents/`, `tool-results/`): copiar solo el `.jsonl` da una copia falsa que aun así pasa el hash | **Aplicado.** `SessionRef.parts`; vault con `main/` y `subagents/<agentId>/`; round-trip que los incluye |
| T-3 | Bloqueante | `node:sqlite` con FTS5 **sí** está disponible (Node 24.18 en el host); el índice propio pesaría el 40 % del origen (~780 MB) y 275 MB de RAM por fichero | **Aplicado.** FTS5 con detección en runtime; índice propio descartado; `engines.vscode` a bisecar (E4) |
| T-4 | Bloqueante | Restaurar puede destruir una sesión viva: en Windows un fichero abierto en append se puede borrar/renombrar sin error, y 39 de 48 ficheros de pid están obsoletos | **Aplicado.** `pid`+`procStart`, apertura exclusiva `wx`, restauración a ruta canónica solo si no existe |
| T-5 | Bloqueante | La "migración masiva de 264 ficheros" era una mala lectura: son subagentes. Los datos son consistentes con que la limpieza **sí** funciona | **Aplicado.** Evidencia corregida y reforzada: aquí ya no queda nada de más de 26 días |
| T-6/7/8 | Importante | RSS < 300 MB se incumple ya con una lectura vacía (236 MB); el índice invertido no escala; no estaba decidido qué texto se indexa (solo `message.content` = 8,8 % del corpus) | **Aplicado.** Criterios medidos durante el trabajo real; alcance del índice fijado con `tool_result` incluido |
| T-9 | Importante | Codex mal caracterizado: rollout de 536 MiB, y hay `.sqlite` con WAL abierto que el motor de chunks corrompería | **Aplicado.** Peor caso recalibrado; `.sqlite` fuera de alcance declarado |
| T-10 | Importante | El tail-hash solo detecta cambios en la cola: una reescritura que la conserve produce un fichero Frankenstein que cuadra | **Aplicado.** Doble hash (cabecera + cola) y test específico |
| T-11 | Importante | Rutas > 260 caracteres: el slug más largo de aquí ya son 118, y `_pre-restore` de un subagente llega a 288 | **Aplicado.** Slug hasheado en el vault, `\\?\` en `restore.mjs`, test con slug de 200 |
| T-12 | Importante | `projects/<slug>/memory/` (111 ficheros) no es una sesión y no se copiaba | **Aplicado.** Artefacto de primera clase + lista blanca de qué es sesión |
| T-13 | Importante | Criterios de rendimiento 16x más laxos que la realidad y no verificables (`strace` no existe en Windows) | **Aplicado.** Throughput, RSS, p99 del bucle de eventos y espía de `fs` |
| T-14 | Importante | La retención se rompe con la distribución real: una rotación del fichero de 324 MB cuesta 77 MB, y "mantener siempre la última generación" puede hacer imposible respetar el presupuesto | **Aplicado.** Avisar y parar; no rotar > 100 MB sin confirmación |
| T-15 | Importante | Escribir en `settings.json` pisa cambios de otras herramientas (aquí hay `.bak`, `.orig`, `.bak-autoaccept`) | **Aplicado.** Se escribe en `settings.local.json` |
| T-16 | Importante | `extensionKind: ["workspace"]` deja sin copiar el `~/.claude` local en WSL/Dev Containers/SSH | **Abierto con dueño**: experimento E5 en F1, decisión antes de F3 |
| T-17 | Importante | Faltaba el ciclo de vida del vault: desinstalar, mover, migrar formato, dos equipos en OneDrive | **Aplicado.** `hostId` en la ruta, migración con paso de solo lectura, "al desinstalar nunca se borra" |
| T-18 | Importante | Lock de solo-pid repite el fallo de los 39 pid obsoletos | **Aplicado.** pid + arranque + heartbeat con toma automática |
| T-19 | Menor | Hay escrituras entrelazadas (timestamps no monótonos en 28 de 40 ficheros): un `\n` no garantiza una línea JSON completa | **Aplicado.** El corte avanza solo hasta la última línea que parsea |
| T-20 | Menor | Se prometían "ficheros originales" en un vault que solo tiene chunks gzip | **Aplicado.** Promesa reescrita + `RESTORE.md` con el equivalente manual |
| T-21 | Menor | Nivel de gzip sin decidir; la estimación del vault sobraba 2x | **Aplicado.** Nivel 4; vault estimado ~500 MB |
| T-22 | Menor | El watcher de VS Code no observa fuera del workspace y habría tormentas de eventos | **Aplicado.** `fs.watch` filtrado + debounce + criterio de CPU en reposo |
| T-23 | Menor | El "4,4 GB" del argumento comercial incluía 464 MB de imágenes generadas y 79 MB de logs | **Aplicado.** Cifra honesta: 2,09 GB (Claude) + 893 MB (Codex) |
| T-24 | Menor | La integridad "740/740" se midió sobre la población equivocada (la conclusión se sostiene) | **Aplicado.** 91/91 correctas |
| T-25 | Menor | F3 proponía reconstruir el `session_index.jsonl` de Codex, que su dueño reescribe entero | **Aplicado.** Al backlog, condicionado a verificarlo antes |

### Hallazgos de producto, mercado y riesgo

| # | Sev. | Hallazgo | Resolución |
|---|---|---|---|
| P-1 | Bloqueante | El hueco no está vacío: [DazzleML/Claude-Session-Backup](https://github.com/DazzleML/Claude-Session-Backup) ya hace copia, restauración, detección de borrados, FTS5, hooks `SessionEnd`/`PreCompact` y programación | **Aplicado.** Reconocido en ANALISIS §3.2 con una frase de diferenciación defendible (nativo en VS Code, sin terminal ni Python, restauración a un clic). Si esa frase no se sostiene, no hay producto |
| P-2 | Bloqueante | `cleanupPeriodDays: 0` es inválido (mínimo 1) y dejaría la configuración del usuario en error permanente | **Aplicado.** Se escribe `36500` en `settings.local.json` |
| P-3 | Importante | 5 de las 7 incidencias citadas están cerradas; hay 4 abiertas mucho mejores (agosto de 2026) | **Aplicado.** Citas sustituidas |
| P-4 | Importante | Indicios de réplica de sesiones a claude.ai (no documentada oficialmente) | **Aplicado con cautela.** Citado como indicio + vigilancia mensual en F7 |
| P-5 | Importante | El Doctor daría falsas alarmas: el barrido se **pausa** en varias condiciones | **Aplicado.** Avisos en condicional; el experimento E1 se sustituye por la doc oficial |
| P-6 | Importante | Nadie paga por prevención cuando la doc oficial regala un hook `SessionEnd` | **Aplicado.** El producto se vende como **rescate**; restaurar y exportar siempre gratis |
| P-7 | Importante | El competidor está a semanas: ya tiene archivado con restaurar, export/import y papelera; 7 releases en 3 meses | **Aplicado.** Plan recortado para publicar el día 6 |
| P-8 | Importante | El criterio ">1.500 instalaciones en 60 días" exige el ritmo del líder; el canal propio no está probado (1 instalación en cada extensión publicada) | **Aplicado.** 300 instalaciones y ≥3 ventas **a 30 días**; instalaciones sin ventas ⇒ se abre el Pro |
| P-9 | Importante | El plan vendía el dolor de la app de escritorio y protegía solo el CLI | **Aplicado.** La app de escritorio entra como origen en F1 |
| P-10 | Importante | El orden de fases no validaba el negocio hasta el día 9-10, y F1 competía justo donde el rival es más fuerte | **Aplicado.** Búsqueda full-text y Codex movidos a 0.2.0 |
| P-11 | Importante | La detección de secretos llegaba tarde (solo al exportar) y de pago; RGPD si el vault acaba en una carpeta sincronizada | **Aplicado.** Aviso al copiar y gratis; cifrado del vault en Pro; consentimiento explícito; `PRIVACY.md` declara que no hay servidor |
| P-12 | Importante | El fabricante desaconseja por escrito parsear los ficheros y no había política de rotura | **Aplicado.** Copia de bytes + modo degradado + fixtures **semanales** en CI + política de compatibilidad en el README |
| P-13 | Menor | Restaurar duplicados **rompe** `claude --resume` | **Aplicado.** Ruta canónica, aviso y limpieza tras los tests |
| P-14 | Menor | Riesgo de marca: la política de Anthropic exige permiso previo para usar sus marcas | **Aplicado.** Marca propia en el nombre, mención solo referencial, sin logos ni colores, "Not affiliated" visible |
| P-15 | Menor | Codex no borra por retención (su problema es el contrario) | **Aplicado.** Argumento distinto para Codex, y fuera del MVP |
| P-16 | Menor | Con pago único, "congelar el desarrollo" deja a los compradores con software muerto | **Aplicado.** Compromiso en el README desde 0.1.0: si se congela, el Pro se libera |
| P-17 | — | Veredicto: **adelante con cambios** | Los cuatro cambios exigidos están aplicados en la v2 |

### Lo que las auditorías confirmaron como correcto

- La premisa **append-only** se sostiene: la compactación añade en vez de reescribir, los prefijos son estables entre muestras y `sessionId` coincide con el nombre del fichero en las 400 comprobadas. El motor de chunks es viable con las correcciones T-10 y T-19.
- La conclusión de fondo — **la corrupción no es el caso común; el caso común es el borrado** — se sostiene con la población corregida (91/91 ficheros íntegros).
- El dolor es real, grande y creciente: 120 incidencias abiertas con la etiqueta `data-loss` y casos de agosto de 2026 con cientos de transcripciones perdidas.

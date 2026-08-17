# SessionKeeper — Análisis del proyecto

> Idea de partida: `ideasVs/03-agent-session-vault.md` ("Agent Session Vault").
> **v2, 2026-08-17**, tras dos auditorías independientes (técnica y de producto) que tumbaron cuatro premisas de la v1.
> Todo lo marcado **[verificado]** se comprobó en este equipo o contra la fuente oficial el mismo día. Registro de la auditoría: [AUDITORIA.md](AUDITORIA.md).

---

## 1. Qué decía la ficha y qué sobrevive

La ficha proponía un "vault" de sesiones con diez funciones (descubrir, copiar, buscar, alias, etiquetas, exportar, reparar, memoria, handoff, sincronización cifrada), índice SQLite, backend de blobs cifrados y planes Free/Pro/Team/Enterprise.

| Propuesta de la ficha | Veredicto | Motivo |
|---|---|---|
| Visor: buscar, etiquetar, alias, exportar | **Fuera del núcleo** | Existe gratis y muy maduro (§3). La búsqueda full-text llega en 0.2.0, no en la primera versión. |
| Copias preventivas y **rescate** | **Núcleo** | Es el único hueco que queda en el Marketplace, y el daño está documentado y es reciente (§2). |
| Handoff entre agentes | **Descartado** | El competidor ya lo tiene. |
| Memoria resumida reutilizable | **Backlog** | Requiere LLM: coste, red y privacidad. |
| Sincronización cifrada + backend | **Descartado** | Servidor, coste fijo y responsabilidad RGPD sobre código y secretos de clientes. Se sustituye por carpeta destino del usuario **con `hostId` en la ruta** (§5.5). |
| Free/Pro/Team/Enterprise | **Simplificado** | Free + Pro 7 € pago único, como el resto de la familia Argalla. |
| Índice SQLite | **Recuperado** | La v1 lo descartó por miedo a binarios nativos. Es un error: `node:sqlite` con FTS5 **está disponible** en el host real (§5.4). |

**Conclusión:** el producto no es un visor de historial. Es **el rescate** de las sesiones: copia continua para que exista algo que rescatar, y herramientas para el día que desaparecen. Se vende por el día malo, no por la prevención.

---

## 2. El problema, con evidencia verificada

### 2.1 Claude Code borra las sesiones de más de 30 días en cada arranque, por defecto

**[verificado, doc oficial]** `cleanupPeriodDays`: *"Default: 30 days, minimum 1. Claude Code deletes session files and other application data older than this period at startup, **as long as it can safely determine the retention period**"*. No hay papelera, ni aviso, ni deshacer.

Dos consecuencias que la v1 de este análisis se comió:

- **El mínimo es 1: escribir `0` es un error de validación**, no una desactivación. Para desactivar hay que poner un valor alto (36500). Un producto que "protegiera" al usuario escribiendo `0` le dejaría la configuración en estado de error. Corregido en el plan.
- El barrido **se pausa** si Claude Code no puede determinar con seguridad el periodo de retención. Cualquier aviso del tipo "estas sesiones se borran mañana" tiene que estar redactado en condicional y modelar esa pausa, o mentirá.

**[verificado en este equipo]** El `settings.json` del usuario **no** declara `cleanupPeriodDays` → valor por defecto. `~/.claude/.last-cleanup` es de hoy. Y la sesión de nivel superior más antigua que queda es del **2026-07-22, 26 días**: no hay ni una sola sesión de más de 30 días. **Aquí ya se ha borrado historial, y se seguirá borrando cada semana.**

> Corrección de la v1: se afirmó que sobrevivían 264 ficheros de 45 días, y se interpretó como que la limpieza no barría esa ruta. Falso: 223 de esos ficheros están a profundidad 4 y 41 a profundidad 6 — son transcripciones de subagentes, no sesiones. Los datos son perfectamente consistentes con que la limpieza funciona.

### 2.2 Pérdidas masivas, recientes y sin arreglar

**[verificado por API de GitHub, 2026-08-17]** — cuatro **abiertas** y frescas:

| Incidencia | Fecha | Qué pasó |
|---|---|---|
| [#86730](https://github.com/anthropics/claude-code/issues/86730) | 14-ago-2026 | 58 de 69 transcripciones borradas |
| [#85466](https://github.com/anthropics/claude-code/issues/85466) | 10-ago-2026 | ~950 transcripciones borradas en duro, sin aviso ni papelera |
| [#84279](https://github.com/anthropics/claude-code/issues/84279) | 5-ago-2026 | Meses de historial destruidos |
| [#82084](https://github.com/anthropics/claude-code/issues/82084) | 28-jul-2026 | Borrado silencioso y permanente a los 30 días |
| [#62476](https://github.com/anthropics/claude-code/issues/62476) · [#59248](https://github.com/anthropics/claude-code/issues/59248) | may-2026 | Las mismas quejas, abiertas desde mayo |
| [microsoft/vscode#321290](https://github.com/microsoft/vscode/issues/321290) | 13-jun-2026 | Copilot: sesión marcada vacía y oculta con 557 eventos intactos en disco |

Cuidado al citar: **#64999, #62959, #58608, #48334 y #45076 están cerradas** (`duplicate`, `not_planned`, `stale`). Que Anthropic las cierre por *stale* mientras siguen entrando casos nuevos refuerza la tesis, pero enlazarlas como "abiertas" en el lanzamiento sería un regalo para el primer comentarista.

### 2.3 El corpus real de este equipo **[verificado, corregido]**

La v1 dijo "740 sesiones / 2,25 GB". Falso: eran 91 sesiones más 651 ficheros de subagentes.

| Población | Ficheros | Tamaño | Distribución |
|---|---|---|---|
| **Sesiones** `projects/<slug>/<id>.jsonl` | **91** | **2,09 GB** | mediana **5,3 MB**, p90 **40,5 MB**, máx **324 MB** |
| Subagentes `<id>/subagents/*.jsonl` | 651 | 155 MB | 20 sesiones los tienen |
| Salidas grandes `<id>/tool-results/*` | 52 | 7,9 MB | |
| **Memoria** `projects/<slug>/memory/*.md` | **111** | pequeña | **irreemplazable** |
| Historial de ficheros `~/.claude/file-history` | 52 sesiones | 298 MB | 3.068 versiones en una sola |
| Codex `~/.codex/sessions` | 55 | 893 MB | mayor **536 MiB** |

Dos consecuencias de diseño: (a) es un problema de **pocos ficheros enormes**, no de muchos pequeños — el 68 % de los bytes está en 9 ficheros; (b) el peor caso real no es el `.jsonl` de 324 MB de Claude, es el rollout de **536 MiB** de Codex.

**[verificado]** Integridad hoy sobre las 91 sesiones: 0 vacías, 0 sin salto de línea final, 0 con última línea ilegible. **La corrupción no es el caso común. El caso común es el borrado.** Por eso reparar ficheros dañados es backlog, no MVP.

### 2.4 Una sesión no es un fichero: es un directorio **[verificado]**

```
~/.claude/projects/<slug>/
    <sessionId>.jsonl              ← la transcripción
    <sessionId>/subagents/agent-<id>.jsonl (+ .meta.json)
    <sessionId>/tool-results/<toolUseId>.txt   ← salidas grandes derramadas a fichero
    memory/*.md                    ← memoria persistente entre conversaciones
```

Copiar solo el `.jsonl` y superar una comprobación de hash byte a byte **da una copia falsa**: sin las salidas de herramientas ni el trabajo de los subagentes. Este fue el peor fallo de la v1 y obliga a rehacer la unidad de copia.

### 2.5 Quién paga

El que acumula meses de trabajo en varios proyectos: consultoras, freelances con muchos clientes, equipos que documentan decisiones en la conversación. El argumento **no** es "organiza tu historial" ni "haz copias" (eso lo hace un script). Es: *"el día que abras el selector y no esté, esto te lo devuelve"*.

El mercado potencial es grande y verificable: solo las seis extensiones de historial del §3.1 suman **más de 28.000 instalaciones**, todas de gente que ya ha ido a buscar sus sesiones a mano. Ese es el público al que hay que llegar.

> **Este equipo no es el cliente.** Sus 91 sesiones, 651 ficheros de subagentes y 893 MB de Codex son el **banco de pruebas**: fixtures reales, corpus de rendimiento (un `.jsonl` de 324 MB, un rollout de 536 MiB) y casos límite que ningún competidor tiene a mano. El producto se diseña para el mercado, no para esta máquina.

---

## 3. Competencia **[verificado 2026-08-17]**

### 3.1 En el Marketplace: lleno de visores, ninguno copia

Instalaciones reales según la API pública del Marketplace: `agsoft.claude-history-viewer` **9.911** · `AlexZanfir.claude-chats` **7.640** (abandonada desde nov-2025) · [`hiztam.codex-history-viewer`](https://marketplace.visualstudio.com/items?itemName=hiztam.codex-history-viewer) **6.075** · `doorsofperception.claude-code-history` **3.162** · `ShahadIshraq` **1.007** · `fahadjabbar.claude-sessions-restore` **27**.

El rival serio es **hiztam** (v2.11.0 del 14-ago, 7 releases en 3 meses, 4,86★, ya cubre Claude Code y Codex): árbol, búsqueda, etiquetas, notas, pines, insights, resume, export/import, ramas, sub-agentes, handoff, **archivado con restaurar** y **borrado seguro a la papelera**. Le falta exactamente una cosa: **temporizador + carpeta destino**, o sea, un fin de semana de trabajo. Su propio aviso dice *"el autor no puede garantizar la recuperación de datos perdidos o corruptos; haz copias"*.

**La ventana competitiva es de 4 a 8 semanas, no de meses.** Eso manda sobre todo el plan.

### 3.2 Fuera del Marketplace: el producto ya existe en CLI

**[hallazgo de la auditoría]** [DazzleML/Claude-Session-Backup](https://github.com/DazzleML/Claude-Session-Backup) (`pip install claude-session-backup`, GPL-3.0): copia completa, línea temporal, detección de borrados, restauración, índice FTS5, **hooks `PreCompact` y `SessionEnd`** y programación por Task Scheduler/cron. Es el MVP entero, ya escrito. También [drewburchfield/claude-session-manager](https://github.com/drewburchfield/claude-session-manager).

Y la propia documentación de Anthropic regala el atajo: *"A `SessionEnd` hook can archive the transcript when a session ends"*.

**Diferenciación defendible, en una frase para el README:** *nativo en VS Code — sin terminal, sin Python, sin cron —, con la restauración a un clic desde la lista de sesiones y un diagnóstico que te dice qué está en riesgo antes de perderlo.* Si esa frase no se sostiene, no hay producto.

### 3.3 El riesgo de que Anthropic lo resuelva

Existen indicios de réplica de sesiones locales a claude.ai en modo solo lectura (referida en incidencias como [#74367](https://github.com/anthropics/claude-code/issues/74367) y [#53920](https://github.com/anthropics/claude-code/issues/53920); **no documentada** en la página oficial de ajustes, así que se cita con cautela). No es una restauración a `.jsonl` ni es tuya, pero marca la dirección del roadmap: **vigilancia mensual y criterio de salida claro** (§6).

---

## 4. Posicionamiento

**SessionKeeper — copia y rescate de sesiones de agentes de programación.** Familia con ChangeKeeper, publisher `argalla`.

1. **No pierdes nada.** Copia incremental de la **sesión completa** (transcripción + subagentes + salidas de herramientas + memoria del proyecto) a una carpeta tuya.
2. **Lo recuperas.** Restauración segura a su sitio, exportación y, si el proveedor lo permite, reanudación real.
3. **Sabes qué tienes.** Qué está en riesgo, qué ocupa, dónde hay secretos.

Lo que **no** hace: no manda nada a ningún servidor (salvo validar la licencia), no compite en visor (el README recomendará el de hiztam para eso) y no promete reanudar lo que el producto original no permita.

**Reglas innegociables:**
- **Restaurar y exportar son gratis para siempre**, también sin licencia y sin la extensión: el almacén es formato abierto y `RESTORE.md` documenta cómo recuperar con `gunzip` + `cat`, sin ejecutar nada nuestro.
- **Nunca se sobrescribe un fichero vivo** (§5.3).
- **Si el desarrollo se congela, el Pro se libera.** Publicado en el README desde 0.1.0. Es barato de prometer, es cierto por diseño y es lo único que hace comprable un pago único de un desconocido.

---

## 5. Viabilidad técnica **[verificado en disco]**

### 5.1 Formatos

**Claude Code** — `~/.claude/projects/<slug>/` con la estructura de §2.4. `<slug>` = ruta con los caracteres no alfanuméricos convertidos en `-`, truncado a 200 caracteres + hash si excede. Ojo: aquí conviven `C--Users-kirne` y `c--Users-kirne` (dos variantes del mismo directorio). Tipos de línea observados en una sesión de 92.989 líneas: `assistant` 39.244, `user` 23.706, `attachment` 8.083, `file-history-snapshot` 2.401, `ai-title`/`custom-title`, `queue-operation`, `mode`, `system`… Origen adicional a soportar: la **app de escritorio** (`%AppData%/Roaming/Claude/claude-code-sessions/`), que es donde ocurrieron las pérdidas más sonadas.

**Codex** — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (mayor: 536 MiB) + `session_index.jsonl`. **Codex no borra por retención**: su queja es la contraria (los logs crecen sin límite). Para Codex el argumento es disco y corrupción, no retención. En `~/.codex` hay además `logs_2.sqlite`/`state_5.sqlite` **abiertos y con WAL**: quedan explícitamente fuera de alcance (copiar un `.sqlite` por rangos de bytes produce basura).

**Copilot Chat** — `workspaceStorage/<hash>/chatSessions/*.json`: formato interno de VS Code, sin contrato. Backlog, y solo como copia opaca.

### 5.2 La propiedad que lo hace barato: append-only **[verificado por la auditoría]**

Los `.jsonl` solo crecen: la compactación **añade** un resumen, no reescribe (`isCompactSummary` aparece intercalado, con el prefijo intacto), los prefijos se mantienen estables entre muestras y `sessionId` coincide con el nombre del fichero en las 400 comprobadas. Así que la copia puede ser incremental por desplazamiento: coste de kilobytes por ciclo.

Con dos correcciones respecto a la v1: hay que verificar el hash del **principio** además del de la cola (si no, una reescritura que conserve la cola pasa desapercibida y produce un fichero Frankenstein que aun así cuadra), y el corte del delta debe avanzar solo hasta la última línea **que parsea como JSON** — hay escrituras que se entrelazan (en 28 de 40 ficheros los timestamps no son monótonos).

### 5.3 El peligro real: restaurar puede destruir una sesión viva

**[verificado por la auditoría]** En Windows, un fichero abierto en modo *append* por el agente **se puede sobrescribir, renombrar y borrar** sin error; el proceso sigue escribiendo contra un inodo huérfano y todo lo que transcriba después se pierde en silencio. El guardián que proponía la v1 (mirar `~/.claude/sessions/<pid>.json`) es papel mojado: de 48 ficheros de pid, **39 están obsoletos**.

Diseño corregido: validar `pid` **+ `procStart`** contra el proceso vivo, abrir el destino en modo exclusivo (`wx`) para fallar si alguien lo tiene abierto, y **restaurar por defecto a la ruta canónica solo si no existe**; si existe, a `<sessionId>.restored.jsonl` salvo confirmación explícita.

Además, **[doc oficial]**: *"a hand-copied duplicate makes Claude Code report not-found rather than resume an arbitrary copy"*. Es decir: dejar una copia duplicada en otro proyecto **rompe** `claude --resume <id>`. Restaurar fuera de sitio no es neutral: hay que avisar y limpiar.

### 5.4 `node:sqlite` + FTS5 sí está disponible **[verificado ejecutándolo]**

Ejecutado en el host real de este equipo (`ELECTRON_RUN_AS_NODE=1 Code.exe`):

```json
{"node":"24.18.0","electron":"42.8.0","sqlite":"3.53.1","fts5":"SI, match=1"}   // VS Code 1.133.0
```

Sin binarios nativos y sin peso en el `.vsix`. La v1 descartó SQLite creyendo que el host corría Node 20 y acabó proponiendo un índice invertido propio que, medido, pesa el 40 % del origen (≈780 MB para este corpus) y necesita 275 MB de RAM para un solo fichero de 38 MB. Decisión: **FTS5 con detección en tiempo de ejecución**, `engines.vscode` fijado a una versión cuyo host lo traiga (a verificar en F1), y degradación a búsqueda por barrido si falta — nunca un índice propio.

### 5.5 Riesgos técnicos y su mitigación

| Riesgo | Mitigación |
|---|---|
| Ficheros de 324–536 MB | Todo por streaming en proceso hijo con `--max-old-space-size`; presupuesto de RSS medido **durante** el trabajo real, no en una lectura vacía |
| Rutas > 260 caracteres (aquí ya hay un slug de 118) | Slug hasheado en el vault (`<hash8>-<slug-truncado>`) + slug completo en `meta.json`; prefijo `\\?\` obligatorio en `restore.mjs` |
| Dos equipos escribiendo el mismo vault en OneDrive | `hostId` en la raíz del vault: `vault/<hostId>/claude-code/…` |
| Lock entre ventanas de VS Code | `pid` + arranque del proceso + heartbeat por `mtime`; toma automática si lleva parado N minutos |
| El formato cambia en cualquier release (lo dice la doc) | La copia es de **bytes**, nunca depende del parseo; modo degradado; fixtures en CI **semanal** contra la última versión publicada |
| `~/.claude/settings.json` lo escriben varias herramientas | No tocarlo: escribir en `settings.local.json`, que tiene precedencia |
| Secretos en las transcripciones (la doc lo confirma: si una herramienta lee un `.env`, el valor acaba en el `.jsonl`) | Detección y aviso **al copiar**, gratis; cifrado del vault opcional; consentimiento explícito si el destino es una carpeta sincronizada |
| Remotos (WSL, Dev Containers, SSH) | Decisión explícita de `extensionKind` y rutas por host, o exclusión declarada en el README |

---

## 6. Modelo de negocio

- **Free**: descubrir, copiar (manual y por temporizador), **restaurar**, exportar, doctor de lectura, aviso de secretos.
- **Pro 7 € pago único**: vigilancia continua, más de un origen a la vez, retención por generaciones y presupuesto, cifrado del vault, rescate avanzado (índices que mienten, reparación), informes.
- Restaurar y exportar **nunca** son de pago.

**Criterio de continuidad, corregido a la realidad**: la v1 pedía >1.500 instalaciones en 60 días, que es el ritmo del líder consolidado (hiztam hace ~870/mes siendo el nº 1). Y el canal propio no está probado: `argalla.changekeeper` y `argalla.handsfree-claude-code` tienen **1 instalación cada una** a día de hoy. Nuevo criterio, **a 30 días**: **300 instalaciones y ≥ 3 ventas**. Si hay instalaciones pero cero ventas, el problema es el precio o el valor, y se responde abriendo el Pro, no gastando más.

---

## 7. Decisiones cerradas

1. `sessionkeeper` / **SessionKeeper** / publisher `argalla`.
2. Unidad de copia = **directorio de sesión completo + `memory/`**. Verificado con round-trip que incluya subagentes.
3. Origen del MVP: Claude Code (CLI **y app de escritorio**). Codex tras publicar; Copilot al backlog.
4. `node:sqlite` + FTS5 con degradación; nada de índice propio ni binarios nativos.
5. Búsqueda full-text **después** de la primera publicación: 0.1.0 sale con copia + rescate + filtro por metadatos.
6. Free/Pro 7 €; restaurar y exportar gratis; si se congela, el Pro se libera.
7. Ventana competitiva de 4–8 semanas: publicable en ~6 días de trabajo.

Plan por fases: [PLAN.md](PLAN.md). Auditoría: [AUDITORIA.md](AUDITORIA.md).

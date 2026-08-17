# SessionKeeper

**Tus sesiones de agente, a salvo.** SessionKeeper guarda una copia local y versionada de cada sesión de Claude Code —transcripción, subagentes y salidas grandes de herramientas— para que el día que la retención, una actualización o un fallo se las lleve, tú las sigas teniendo.

**Instalar:** `code --install-extension argalla.sessionkeeper` · [Marketplace](https://marketplace.visualstudio.com/items?itemName=argalla.sessionkeeper) · [Open VSX](https://open-vsx.org/extension/argalla/sessionkeeper)

> Sin relación con Anthropic ni OpenAI. Trabaja con los ficheros que Claude Code escribe en tu propio equipo.

## Por qué

Claude Code borra al arrancar las transcripciones más antiguas que `cleanupPeriodDays` — **30 días por defecto**, sin aviso, sin papelera y sin deshacer. Hay quien ha perdido meses de trabajo así: [58 de 69 transcripciones](https://github.com/anthropics/claude-code/issues/86730), [~950 borradas en duro](https://github.com/anthropics/claude-code/issues/85466), [meses de historial destruidos](https://github.com/anthropics/claude-code/issues/84279). Y luego están las actualizaciones y los cierres bruscos; a veces el dato sigue en disco mientras el índice dice que la sesión está vacía.

Esas transcripciones no son un chat: son las decisiones, los comandos, los intentos fallidos y el razonamiento detrás de código que ya está en producción.

## Qué hace

- **Copia la sesión entera, no solo el fichero.** Una sesión de Claude Code es `<id>.jsonl` **más** una carpeta hermana con `subagents/` y `tool-results/`. Si copias solo la transcripción te queda algo que parece completo y no lo está. SessionKeeper copia todo, y también tu carpeta `memory/`.
- **De forma incremental.** Las transcripciones solo crecen, así que después de la primera copia cada ciclo guarda únicamente los bytes nuevos: kilobytes, en milisegundos. Si un fichero se reescribe o se trunca en lugar de crecer, SessionKeeper lo detecta (comprueba las dos puntas de lo ya copiado) y abre una versión nueva en vez de estropear la anterior.
- **Restaura con cuidado.** Nunca escribe sobre un fichero existente sin guardar antes una copia byte a byte, se niega a tocar una sesión que está en marcha, y te avisa de que un duplicado en la carpeta equivocada hace que `claude --resume` responda que no la encuentra.
- **Te dice qué está en riesgo.** El diagnóstico lista lo que caería fuera de tu ventana de retención, qué sesiones ya solo existen en el almacén, cuánto ocupa todo y si tus transcripciones contienen credenciales.
- **Exporta a Markdown**, con las credenciales sustituidas.

## Qué no hace

No es un visor de historial. Enseña lo justo para encontrar y rescatar una sesión: ni Mermaid, ni líneas temporales, ni etiquetas. Si lo que quieres es **navegar** por tu historial, [Codex History Viewer](https://marketplace.visualstudio.com/items?itemName=hiztam.codex-history-viewer) es gratuito, maduro y muy bueno justo en eso; los dos conviven sin problema.

Tampoco promete que una sesión restaurada se pueda reanudar. Restaurar te devuelve los bytes; que la herramienta los reabra es cosa suya.

## Pro

Todo lo anterior es gratis, para siempre. **Pro añade dos cosas**, por **12 € de pago único** (7 € con el código `LANZAMIENTO` hasta el 14 de septiembre de 2026):

- **Vigilancia continua** — las sesiones se copian a medida que cambian, sin pulsar nada.
- **Codex como segundo origen** — `~/.codex/sessions` junto a Claude Code.

`SessionKeeper Pro: conseguir una licencia` abre el pago ([Polar](https://polar.sh) es el merchant of record: factura y liquida el IVA). Una clave activa **tres** equipos, y puedes liberar una activación desde tu portal de cliente de Polar.

**Pro solo añade.** Copiar a mano, restaurar, exportar y el diagnóstico siguen siendo gratis sin ninguna licencia, así que una clave que caduque solo apaga la vigilancia: nunca te quedas fuera de tus propias copias.

**Nuestro compromiso**: si dejamos de desarrollar SessionKeeper, el Pro se libera gratis. El almacén es formato abierto y `restore.mjs` funciona sin nosotros de todas formas.

## Requisitos

- VS Code 1.95 o posterior.
- Claude Code con sus ficheros locales (`~/.claude/projects`, o `CLAUDE_CONFIG_DIR`). El soporte de Codex es experimental y viene apagado.
- Una carpeta donde guardar el almacén. Elige una que ya respaldes.

## Privacidad

Todo se queda en tu equipo. Sin telemetría, sin cuentas, sin llamadas de red. SessionKeeper solo escribe dentro del almacén que elijas —y, si se lo pides explícitamente, en el fichero que estés restaurando—. Detalle en [PRIVACY.es.md](PRIVACY.es.md).

**Las transcripciones pueden contener secretos.** Lo dice la propia documentación de Anthropic: si una herramienta lee un `.env` o un comando imprime una credencial, ese valor queda escrito en la transcripción. SessionKeeper te avisa cuando detecta credenciales y las sustituye al exportar, pero nunca edita tus ficheros: trata el almacén como la carpeta sensible que es, y piénsatelo dos veces antes de apuntarlo a una unidad sincronizada con la nube.

## Tus copias son tuyas

El almacén es formato abierto: trozos gzip y un `gen.json` legible. Cada almacén lleva dentro un `RESTORE.md` y un `restore.mjs` independiente que recuperan todo **sin esta extensión**, sin licencia y sin nosotros. Copiar, restaurar y exportar son gratis, y seguirán siéndolo.

## Licencia

MIT — ver [LICENSE](LICENSE). Dudas e incidencias: [GitHub](https://github.com/TecniartGalicia/sessionkeeper/issues).

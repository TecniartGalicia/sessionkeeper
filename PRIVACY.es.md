# Privacidad

**En corto: nada sale de tu equipo. No hay servidor, ni cuenta, ni telemetría.**

## Qué lee SessionKeeper

- `~/.claude/projects/**` (o la carpeta de `CLAUDE_CONFIG_DIR`, o la que pongas en `sessionkeeper.claudeHome`): transcripciones, subagentes, salidas grandes de herramientas y tu carpeta `memory/`.
- `~/.claude/settings.json` y `settings.local.json`: solo el valor `cleanupPeriodDays`, para decirte qué está en riesgo.
- `~/.claude/sessions/*.json`: solo para comprobar si una sesión está en marcha antes de restaurarla.
- `~/.codex/sessions/**`: solo si activas `sessionkeeper.includeCodex`.

Los lee. No los modifica.

## Qué escribe SessionKeeper

- **El almacén**, en la carpeta que elijas (`sessionkeeper.vaultPath`) o en la ubicación por defecto de tu sistema. Contiene copias gzip de tus ficheros de sesión, un `meta.json` por sesión y un `gen.json` por versión.
- **El fichero que hayas pedido restaurar**, y solo después de guardar una copia byte a byte de lo que hubiera en `_pre-restore/`, dentro del almacén.

Nada más. Nunca.

## Red

**Sin licencia Pro: ninguna en absoluto.** SessionKeeper no hace ninguna petición HTTP. No busca actualizaciones, no reporta errores, no cuenta usuarios. En un equipo sin licencia no llega ni a leer su propio almacén de secretos.

**Con licencia Pro** se contacta con un único endpoint, y solo con ese: `api.polar.sh/v1/customer-portal/license-keys` (activar / validar / desactivar). Lo que se envía: tu clave de licencia, el nombre de este equipo (como etiqueta de la activación), tu plataforma y la versión de la extensión. Nada más: ni contenido de sesiones, ni rutas, ni ajustes.

Cuándo: una vez al introducir la clave, una vez cada 24 horas para revalidar, y cuando pides el estado de la licencia. Si no hay red, Pro sigue funcionando 14 días con la última validación positiva. Al quitar la licencia se envía una desactivación para liberar la activación.

Polar (Polar Software Inc.) es el merchant of record de la compra: tus datos de correo y facturación los recibe Polar, no nosotros. Ver [polar.sh/legal/privacy](https://polar.sh/legal/privacy).

## Credenciales en tus transcripciones

Anthropic documenta que si una herramienta lee un `.env` o un comando imprime una credencial, ese valor queda escrito en la transcripción. Copiar transcripciones multiplica, por tanto, las copias de esos secretos.

SessionKeeper:

- **cuenta** las cadenas con pinta de credencial al copiar y te avisa, sin imprimir nunca el valor;
- **las sustituye** al exportar una sesión a Markdown;
- **no edita jamás** tus ficheros ni la copia: una copia censurada no sería una copia.

Lo que implica para ti: el almacén hereda los permisos de la carpeta que elijas. Si lo apuntas a OneDrive, Dropbox, Google Drive o cualquier carpeta sincronizada, esos secretos van a ese proveedor, posiblemente fuera de tu país. Puede ser justo lo que quieres (copias fuera del equipo), pero es una decisión tuya y conviene tomarla a sabiendas.

## Responsable del tratamiento

No hay tratamiento de datos personales por nuestra parte: ningún dato llega a Tecniart Galicia / Argalla. La validación de licencia va contra Polar, que actúa como merchant of record y responsable de los datos de compra.

## Dudas

[github.com/TecniartGalicia/sessionkeeper/issues](https://github.com/TecniartGalicia/sessionkeeper/issues)

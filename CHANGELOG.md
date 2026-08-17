# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versionado [SemVer](https://semver.org/lang/es/).

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

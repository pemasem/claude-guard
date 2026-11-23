# Changelog

## Sin publicar / Unreleased

- Lockfiles de Python, Rust, PHP, Ruby y Go (`poetry.lock`, `uv.lock`, `Pipfile.lock`, `Cargo.lock`, `composer.lock`, `Gemfile.lock`, `go.sum`): `protect-files` no deja editarlos a mano y `scan-secrets` los omite.

- `guard-bash`: el push forzado con refspec `+` (`git push origin +master`) cuenta como forzado en cualquier rama, y los refspecs hacia ramas protegidas (`feature:master`, `HEAD:refs/heads/master`, `:master`) se bloquean como el push directo.

- `guard-bash` bloquea más formas de volcar o leer variables de entorno: PowerShell (`$env:…` con nombre de secreto, `Get-Item Env:`, `dir env:`, `[Environment]::GetEnvironmentVariable(s)`), `python -c` imprimiendo `os.environ`/`os.getenv`, `echo $…KEY/TOKEN…` y `set` sin argumentos. `$env:PATH`, `$env:NODE_ENV` y las asignaciones pasan.

- `post-edit` ya no bloquea todas las ediciones mientras el proyecto tenga un problema previo: ignora ficheros fuera del proyecto y usa `check-deploy-safety --changed <fichero>`, que solo informa de lo que causa ese fichero (y de las comprobaciones globales de Docker/`.dockerignore`/Vite/`serverEntry` cuando se edita uno de ellos). El modo completo no cambia.

- Ficheros de entorno con otros nombres (`.env_local`, `.env_prod`, `.env-staging`, `prod.env`) protegidos en `protect-files`, `guard-bash` (incluido `Get-Content`/`gc`/`Select-String`), `env-tracked`, `dockerignore-env` y la lista de denegaciones del instalador. Nueva clave `envTemplates` para plantillas propias (`.env.master`).

## 0.1.0 — 2026-11-23

Primera versión, a raíz del incidente [2026-11-vite-dev-server](docs/incidentes/2026-11-vite-dev-server.md).

- Hooks de Claude Code: `guard-bash`, `protect-files` y `post-edit`.
- `check-deploy-safety`:
  - Dockerfile de producción (`NODE_ENV`, sin servidor de desarrollo, sin root, sin secretos en `ENV`/`ARG`, build del frontend, solo dependencias de producción);
  - `.dockerignore`;
  - configuración de Vite;
  - variables públicas con secreto (`VITE_`, `NEXT_PUBLIC_`, `REACT_APP_`, `EXPO_PUBLIC_`, `PUBLIC_`, `NUXT_PUBLIC_`);
  - SDK de IA en el frontend;
  - `.env` versionados;
  - import estático de vite en el servidor.
- `scan-secrets` ligero.
- Instalador idempotente con `--dry-run`, `--claude-md`, `--ci github|bitbucket` y `uninstall`.

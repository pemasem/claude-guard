# Changelog

## Sin publicar / Unreleased

- `guard-bash`: bloquea los comandos que vacían o revierten toda la base de datos (`alembic downgrade base`, `manage.py migrate <app> zero`/`flush`, `prisma migrate reset`, `prisma db push --force-reset`, `rails db:drop`/`db:reset`, `sequelize db:migrate:undo:all`, `knex migrate:rollback --all`, `typeorm schema:drop`, `artisan migrate:fresh`/`db:wipe`…). Revertir un paso sigue permitido.

- Falsos positivos de un monorepo real (FastAPI + Next.js + Caddy + Docker):
  - `dockerignore-missing` es por contexto de construcción: se busca el `.dockerignore` en la carpeta de cada Dockerfile (o `<Dockerfile>.dockerignore`) y, si hay `docker-compose*.yml`, en el `context:` de cada servicio. La opción `dockerignore` sigue valiendo para la raíz. Nueva regla `dockerignore-env-in-context`: error si el contexto tiene un `.env*` real, el Dockerfile hace `COPY . …` y ningún `.dockerignore` lo excluye.
  - `docker-prod-deps` solo revisa la etapa final (y las que hereda): si solo copia artefactos con `COPY --from=…` (p. ej. `.next/standalone`) y no instala, no es error.
  - `public-secret-var` (check y `guard-bash`) no marca nombres con `PUBLISHABLE` o `ANON` como palabra (`VITE_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`).
  - `guard-bash`: en `grep`/`rg`/`Select-String`/`sls`/`findstr` el patrón (primer argumento sin opción y valores de `-e`/`--regexp`/`-Pattern`/`/c:`) ya no se toma por fichero: `grep -iE "^\.env|docker" .gitignore` pasa, `grep X .env` y `cat .env` siguen bloqueados.
  - `guard-bash`: el motivo de `git reset --hard` recomienda una rama o un commit de trabajo en vez de `git stash` (peligroso con varios agentes: el índice se comparte).

- `check-deploy-safety`: nuevas reglas de aviso `forwarded-ips-wildcard` (`--forwarded-allow-ips=*` / `FORWARDED_ALLOW_IPS=*`), `uvicorn-proxy-headers` (uvicorn sin `--proxy-headers` con `Caddyfile`/`nginx.conf` en el proyecto), `default-secret-value` (`secret_key = "changeme"` y similares en código de servidor), `browser-sandbox-disabled` (`chromium_sandbox=False` / `chromiumSandbox: false`) y `frontend-token-storage` (token o sesión en `localStorage`/`sessionStorage`).

- CI (`ci/github-actions.yml`, `ci/bitbucket-pipelines.yml`): paso opcional de auditoría de dependencias, `npm audit --omit=dev --audit-level=high` por cada carpeta con `package-lock.json` y `pip-audit` si hay `requirements.txt`/`pyproject.toml` (se omite sin romper si no se puede instalar).

- `templates/CLAUDE.section.md`: cuatro reglas de comportamiento nuevas para Claude (prevención, sin código de detección): SSRF con navegador o cliente HTTP, rutas de fichero con datos del usuario, contenido de terceros en prompts de LLM y navegadores headless con sandbox. La de no relajar reglas pasa a ser la 9.

- `check-deploy-safety`: nueva regla `docker-browser-no-sandbox` (aviso por `--no-sandbox`/`--disable-setuid-sandbox` en el Dockerfile; error si además la imagen corre como root).

- `scan-secrets`: nueva clave `secretScanAllow` (prefijos de ruta o ficheros con valores falsos conocidos; se listan siempre en la salida) y nuevos patrones `google-oauth-secret` (`GOCSPX-`) y `gcp-service-account` (JSON de cuenta de servicio con clave privada).

- `check-deploy-safety`, Python: nuevas reglas `docker-python-dev-server` (`uvicorn --reload`, `fastapi dev`, `flask run`, `manage.py runserver`, `FLASK_DEBUG`, `DEBUG=True`) y `docker-debug-log` (aviso por `--log-level debug/trace`). El mensaje de `docker-user` ya no menciona `USER node` fuera de Node.

- Credenciales: `protect-files` bloquea `*.sa.json`, los `*.json` de `credentials/` y `secrets/`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials` y `kubeconfig`; `guard-bash` bloquea `gcloud secrets versions access`, `gcloud auth print-access-token`/`print-identity-token`, `aws secretsmanager get-secret-value`, `az keyvault secret show` y `kubectl get secret -o yaml/json`.

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

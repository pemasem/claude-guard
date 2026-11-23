# Catálogo de reglas

*[English](rules.en.md)*

Cada regla del comprobador lleva un id. Si hiciera falta, se desactiva con `"disable": ["id"]` en `claude-guard.config.json`, siempre con la razón escrita en el mismo fichero.

## check-deploy-safety

### Imagen (Dockerfile)

| Id | Regla | Por qué |
|---|---|---|
| `docker-node-env` | Las imágenes de Node fijan `ENV NODE_ENV=production`, nunca `development` | Muchos servidores (Express con Vite en modo middleware, Nuxt, Remix…) deciden por `NODE_ENV` si arrancan el servidor de desarrollo. Sin la variable, en producción corre el modo desarrollo. |
| `docker-dev-server` | La imagen no arranca `npm run dev`, `vite`, `next dev`, `nodemon`, `tsx watch`, `ng serve`… | Un servidor de desarrollo sirve el código fuente y, por diseño o por fallos (Vite `server.fs.deny`), ficheros del contenedor como `.env`. |
| `docker-user` | La etapa final corre con un usuario sin privilegios (`USER node` en Node; en otras imágenes, p. ej. `RUN useradd -r app` + `USER app`; o una imagen `:nonroot`) | Si algo se compromete (un navegador headless, una dependencia), no es root dentro del contenedor. |
| `docker-python-dev-server` | En imágenes de Python (`FROM python` o un `CMD` con `uvicorn`/`gunicorn`/`flask`…): sin `uvicorn --reload`, `fastapi dev`, `flask run`, `manage.py runserver`, `FLASK_DEBUG=1`, `FLASK_ENV=development` ni `DEBUG=True` | Recarga en caliente y depuradores interactivos (Werkzeug, páginas de depuración de Django con variables de entorno y ajustes) no se exponen en producción. |
| `docker-debug-log` | Aviso si el `CMD`/`ENTRYPOINT` de una imagen de Python usa `--log-level debug` o `trace` | Los logs de depuración pueden incluir cabeceras, tokens y datos de usuario. |
| `docker-secret-env` | No hay secretos en `ENV` ni en `ARG` | Quedan grabados en las capas de la imagen y en el historial del registro. Van en el gestor de secretos. |
| `docker-copy-all` | Aviso (o error con `copyAllIsError`) ante `COPY . .` | Copia todo el contexto: depende por completo de que el `.dockerignore` sea correcto. |
| `docker-frontend-build` | Si hay `vite.config.*`, la imagen ejecuta `npm run build` | Sin build no hay `dist/`, y la app acaba sirviendo el frontend con el servidor de desarrollo. |
| `docker-prod-deps` | La imagen instala solo dependencias de producción (`npm ci --omit=dev`, `pnpm install --prod`…) | Las devDependencies incluyen los servidores de desarrollo y más superficie de ataque. |

### Contexto de la imagen (.dockerignore)

| Id | Regla | Por qué |
|---|---|---|
| `dockerignore-missing` | Si hay Dockerfile, existe un `.dockerignore` | Sin él, entran en la imagen `.env`, `.git` y datos locales. |
| `dockerignore-env` | Excluye `**/.env` y `**/.env.*` (o `**/.env_*`), y no los vuelve a incluir con `!` (salvo plantillas como `.env.example`) | Un `.env` dentro de la imagen se puede leer en cuanto algo sirva ficheros. |
| `dockerignore-git` | Excluye `.git` | El historial puede contener secretos antiguos y expone el código. |
| `dockerignore-node-modules` | Excluye `node_modules` | Evita binarios del host y paquetes de desarrollo. |

### Vite

| Id | Regla | Por qué |
|---|---|---|
| `vite-allowed-hosts` | `server.allowedHosts` sin dominios reales ni `true` | Si el servidor de desarrollo acepta el dominio público, se ha previsto exponerlo. |
| `vite-env-prefix` | Sin `envPrefix` | Cambia qué variables se publican en el navegador. |
| `vite-load-env` | Sin `loadEnv(…, '')` (prefijo vacío) | Carga **todas** las variables en la configuración y de ahí es fácil pasarlas a `define`. |
| `vite-define-secret` | Sin secretos en `define` | `define` se incrusta en el JavaScript que descarga el navegador. |

### Código y repositorio

| Id | Regla | Por qué |
|---|---|---|
| `public-secret-var` | Ninguna variable `VITE_*`, `NEXT_PUBLIC_*`, `REACT_APP_*`, `EXPO_PUBLIC_*`, `PUBLIC_*` o `NUXT_PUBLIC_*` con nombre de secreto (KEY, SECRET, TOKEN, PASSWORD…) en ningún fichero (código, README, `.env.example`, CI) | Esos prefijos significan "publícame en el navegador". Una clave con ese nombre es una clave pública. |
| `frontend-ai-sdk` | El frontend no importa SDK de IA (`@google/genai`, `openai`, `@anthropic-ai/sdk`, `groq-sdk`, `@mistralai/*`…) | Para llamar al proveedor desde el navegador, la clave tiene que estar en el navegador. |
| `frontend-env` | (con `strictImportMetaEnv`) El frontend no lee variables de entorno propias | Todo lo que lee el navegador es público. Así se evita que alguien añada "solo una". |
| `env-tracked` | Ningún fichero de entorno versionado (`.env`, `.env.local`, `.env_prod`, `.env-staging`, `prod.env`…), salvo plantillas (`.example/.sample/.template/.dist`, con `.`, `_` o `-`) y las de `envTemplates` | Una vez en git, el secreto queda en el historial: hay que rotarlo. Las plantillas propias con otro nombre (`.env.master`) se declaran en `envTemplates`. |
| `server-entry` / `server-static-vite` | (con `serverEntry`) El servidor importa `vite` solo dinámicamente, dentro de la rama de desarrollo | La imagen de producción no necesita vite, ni puede arrancarlo por error. |

## guard-bash (comandos)

| Bloquea | Por qué |
|---|---|
| `git push --force`, `-f`, `--force-with-lease` y el refspec con `+` (`git push origin +rama`) | Reescribe historia compartida; el `+` fuerza igual que `--force`, en cualquier rama. |
| `git push` a `protectedBranches` (también como refspec: `rama:master`, `HEAD:refs/heads/master`, `:master`) y `git commit` estando en ellas | El flujo es rama de trabajo y luego pull request. Un refspec con destino protegido salta la regla igual que `git push origin master`. |
| `git reset --hard`, `git clean -f` y `rm -rf` de la raíz | Pierden trabajo de forma irreversible. |
| `--no-verify` y `--no-gpg-sign` | Saltarse un hook oculta el problema. |
| `npm audit fix --force` | Mete versiones mayores sin control. |
| `DROP TABLE`/`DATABASE`/`SCHEMA` y `TRUNCATE TABLE` | Destructivo; las migraciones deben ser aditivas. |
| `cat`/`type`/`Get-Content`/`grep`/… sobre ficheros de entorno (`.env`, `.env_prod`, `.env-staging`, `prod.env`…; salvo plantillas y `envTemplates`) | El contenido acabaría en la conversación y en los logs. |
| `printenv`, `env`, `Get-ChildItem env:` y `/proc/self/environ` | Igual que lo anterior, con todas las variables a la vez. |
| PowerShell: `$env:NOMBRE` con nombre de secreto (KEY, SECRET, TOKEN…), `Get-Item Env:NOMBRE`, `dir env:`, `ls env:`, `[Environment]::GetEnvironmentVariables()` y `GetEnvironmentVariable(…)` con nombre de secreto o no literal | Lo mismo en PowerShell. Se permiten `$env:PATH`, `$env:NODE_ENV`, `$env:PWD` y las asignaciones (`$env:X = …`). |
| `python -c` que imprime `os.environ` o `os.getenv` | Vuelca las claves. Se permite leer una clave literal que no sea secreta (`os.environ['HOME']`). |
| `echo $NOMBRE` / `echo ${NOMBRE}` con nombre de secreto en mayúsculas | Imprime el secreto en la conversación. `$PATH`, `$HOME` y `$PWD` pasan. |
| `set` sin argumentos (cmd o bash) | Lista todas las variables. `set -e` y similares pasan. |
| `VITE_…KEY=` y similares (asignar variables públicas con secreto) | Ver `public-secret-var`. |
| `gcloud secrets versions access`, `gcloud auth print-access-token` / `print-identity-token`, `aws secretsmanager get-secret-value`, `az keyvault secret show`, `kubectl get secret … -o yaml/json` | Imprimen el valor de un secreto o una credencial viva: acabaría en la conversación y en los logs. Listar nombres (`gcloud secrets list`, `kubectl get secrets`) sí se permite. |
| `ngrok`, `cloudflared tunnel`, `localtunnel`, `tailscale funnel`… | Exponen el servidor de desarrollo a Internet. |
| `docker build`/`run` con `NODE_ENV=development`, `npm run dev`, `vite` o `next dev` | Imagen de desarrollo. |

## protect-files (ficheros)

| Acción | Ficheros | Por qué |
|---|---|---|
| Bloquea leer y editar | `.env`, `.env.*`, `.env_*`, `.env-*`, `*.env` (salvo plantillas `.example/.sample/.template/.dist`, con `.`, `_` o `-`, y `envTemplates`), `*.pem`, `*.key`, `*.p12`, `id_rsa`, `credentials*.json`, `service-account*.json` | Secretos. |
| Bloquea leer y editar | `*.sa.json`, cualquier `*.json` dentro de `credentials/` o `secrets/`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials` y `kubeconfig` (o `.kube/config`) | Credenciales de cuentas de servicio, registros de paquetes, git y clústeres. Si tu `.npmrc` es solo de configuración, léelo con el terminal (o deja el secreto fuera de él). |
| Bloquea editar | `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `poetry.lock`, `uv.lock`, `Pipfile.lock`, `Cargo.lock`, `composer.lock`, `Gemfile.lock` y `go.sum` | Se regeneran con el gestor de paquetes. `scan-secrets` tampoco los recorre: son miles de hashes que parecen secretos. |
| Pide confirmación | `.claude/hooks/claude-guard/`, `.claude-guard/`, `.claude/settings.json` y `claude-guard.config.json` | Son las propias barreras: no se relajan sin que el usuario lo vea. |

## post-edit

Tras cada edición ejecuta `scan-secrets` sobre el fichero y `check-deploy-safety --changed <fichero>` (incluido el fichero, aunque aún no esté versionado). Cualquier fallo devuelve exit 2 y Claude tiene que corregirlo antes de seguir.

- **Ficheros fuera del proyecto** (una carpeta temporal, por ejemplo): se ignoran. No son asunto de las reglas del proyecto.
- **Modo acotado** (`--changed`): solo se informa de los problemas cuya ubicación es el fichero editado y, si el fichero editado es el Dockerfile, el `.dockerignore`, la config de Vite o `serverEntry`, de las comprobaciones globales de ese grupo. Un problema previo en otro sitio ya no bloquea cualquier edición. El modo completo (CI, sin `--changed`) no cambia.

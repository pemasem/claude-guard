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
| `forwarded-ips-wildcard` | Aviso si un Dockerfile o `docker-compose*.yml` pasa `--forwarded-allow-ips=*` (o `'*'`) a uvicorn/gunicorn, o fija `FORWARDED_ALLOW_IPS=*` | Con `*` el servidor se fía de `X-Forwarded-For` venga de donde venga: cualquiera puede falsificar su IP y saltarse los frenos por IP (limitación de peticiones, bloqueos, logs). Limítalo a la IP o la red del proxy. |
| `uvicorn-proxy-headers` | Aviso si uvicorn arranca (Dockerfile o compose) sin `--proxy-headers` ni `--forwarded-allow-ips` (ni `FORWARDED_ALLOW_IPS`) en ningún Dockerfile/compose revisado y el proyecto tiene un `Caddyfile` o `nginx.conf` | uvicorn solo se fía de `X-Forwarded-For` desde 127.0.0.1: detrás de un proxy en otro contenedor, los frenos por IP verán únicamente la IP del proxy. Solo ve los ficheros del proyecto: si el flag va en la plataforma de despliegue, silencia la regla con `disable`. |
| `docker-browser-no-sandbox` | Aviso si el Dockerfile (`ENV`, `RUN`, `CMD`, `ENTRYPOINT`) usa `--no-sandbox` o `--disable-setuid-sandbox`; **error** si además la etapa final corre como root (la misma condición que `docker-user`) | Un navegador headless que renderiza páginas de terceros sin sandbox y como root, en un contenedor con secretos, convierte un exploit del renderizador en una shell root con todas las variables de entorno. Solo ve el Dockerfile: un `--no-sandbox` pasado desde el código no se detecta. |
| `docker-secret-env` | No hay secretos en `ENV` ni en `ARG` | Quedan grabados en las capas de la imagen y en el historial del registro. Van en el gestor de secretos. |
| `docker-copy-all` | Aviso (o error con `copyAllIsError`) ante `COPY . .` | Copia todo el contexto: depende por completo de que el `.dockerignore` sea correcto. |
| `docker-frontend-build` | Si hay `vite.config.*`, la imagen ejecuta `npm run build` | Sin build no hay `dist/`, y la app acaba sirviendo el frontend con el servidor de desarrollo. |
| `docker-prod-deps` | La **etapa final** (y las que hereda con `FROM etapa`) instala solo dependencias de producción (`npm ci --omit=dev`, `pnpm install --prod`…), o se limita a copiar artefactos con `COPY --from=…` (p. ej. `.next/standalone`) sin instalar nada. Las etapas intermedias de build pueden instalar todo | Las devDependencies incluyen los servidores de desarrollo y más superficie de ataque. Una etapa final que solo copia el resultado compilado no lleva devDependencies. |

### Contexto de la imagen (.dockerignore)

| Id | Regla | Por qué |
|---|---|---|
| `dockerignore-missing` | Si hay Dockerfile, existe el `.dockerignore` **de su contexto de construcción**: la carpeta del Dockerfile (o `<Dockerfile>.dockerignore` a su lado) o, si un `docker-compose*.yml` de la raíz lo construye, el `context:` de ese servicio. En la raíz del proyecto vale la opción `dockerignore`. Un error por contexto | Sin él, entran en la imagen `.env`, `.git` y datos locales. En un monorepo, el `.dockerignore` de la raíz no se aplica a los Dockerfile que se construyen desde `backend/` o `web/`. |
| `dockerignore-env-in-context` | Error si el contexto contiene un fichero `.env*` real (no plantilla), el Dockerfile hace `COPY . …`/`ADD . …` desde el contexto y el `.dockerignore` (o su ausencia) no lo excluye | El `COPY . .` mete el secreto en una capa de la imagen. Los patrones del `.dockerignore` se anclan a la raíz del contexto (`.env` no cubre `web/.env`; `**/.env` sí). |
| `dockerignore-env` | Excluye `**/.env` y `**/.env.*` (o `**/.env_*`), y no los vuelve a incluir con `!` (salvo plantillas como `.env.example`) | Un `.env` dentro de la imagen se puede leer en cuanto algo sirva ficheros. |
| `dockerignore-git` | Excluye `.git`, solo si el contexto es la raíz del proyecto o contiene `.git` (en un contexto de subcarpeta el `.git` está fuera y no entra en la imagen) | El historial puede contener secretos antiguos y expone el código. |
| `dockerignore-node-modules` | Excluye `node_modules`, solo si el contexto contiene `package.json` o `node_modules` (un contexto Python sin Node no lo necesita) | Evita binarios del host y paquetes de desarrollo. |

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
| `public-secret-var` | Ninguna variable `VITE_*`, `NEXT_PUBLIC_*`, `REACT_APP_*`, `EXPO_PUBLIC_*`, `PUBLIC_*` o `NUXT_PUBLIC_*` con nombre de secreto (KEY, SECRET, TOKEN, PASSWORD…) en ningún fichero (código, README, `.env.example`, CI). Quedan fuera los nombres que son claves públicas por diseño: los que contienen `PUBLISHABLE` o `ANON` como palabra (`VITE_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`) | Esos prefijos significan "publícame en el navegador". Una clave con ese nombre es una clave pública. Las claves *publishable* de Stripe y *anon* de Supabase están pensadas para el navegador (la protección va en las políticas de acceso, no en ocultarlas). `ANONYMIZE_KEY` sigue marcándose: `ANON` cuenta solo como palabra entera. |
| `frontend-ai-sdk` | El frontend no importa SDK de IA (`@google/genai`, `openai`, `@anthropic-ai/sdk`, `groq-sdk`, `@mistralai/*`…) | Para llamar al proveedor desde el navegador, la clave tiene que estar en el navegador. |
| `frontend-env` | (con `strictImportMetaEnv`) El frontend no lee variables de entorno propias | Todo lo que lee el navegador es público. Así se evita que alguien añada "solo una". |
| `env-tracked` | Ningún fichero de entorno versionado (`.env`, `.env.local`, `.env_prod`, `.env-staging`, `prod.env`…), salvo plantillas (`.example/.sample/.template/.dist`, con `.`, `_` o `-`) y las de `envTemplates` | Una vez en git, el secreto queda en el historial: hay que rotarlo. Las plantillas propias con otro nombre (`.env.master`) se declaran en `envTemplates`. |
| `default-secret-value` | Aviso si en un `.py`/`.ts`/`.js` de servidor (fuera de tests y de `allowMention`) un secreto (`secret_key`, `jwt_secret`, `session_secret`, `signing_key`, `encryption_key`…) lleva un valor por defecto conocido (`changeme`, `cambiame`, `secret`, `dev-secret`, `insecure`, `password`…), sea asignado o como segundo argumento de `os.getenv`/`environ.get` o tras `\|\|`/`??`. Una comparación (`startswith`/`endswith`/`includes`/`==`/`!=`/`===`/`!==`/`in`) no es un valor por defecto sino la guarda que lo rechaza: no avisa. Si el mismo fichero (o `serverEntry`) compara el secreto con ese valor (o con su prefijo, p. ej. `startswith("cambiame")` cubre `cambiame-en-produccion`), la asignación por defecto tampoco avisa. Una línea con `secret-scan: ignore` se omite | Si falta la variable de entorno en producción, el servidor arranca con una clave que conoce todo el mundo y las sesiones o tokens se pueden falsificar. Es aviso porque no puede ver si otra parte del arranque se niega a continuar con ese valor; solo reconoce la guarda en el mismo fichero o en `serverEntry`. |
| `browser-sandbox-disabled` | Aviso si el código usa `chromium_sandbox=False` (Playwright Python) o `chromiumSandbox: false` (Node) | Complementa a `docker-browser-no-sandbox`, que solo ve el Dockerfile: un renderizador comprometido sin sandbox compromete el proceso y sus secretos. |
| `frontend-token-storage` | Aviso si un fichero de navegador (`.js/.ts/.jsx/.tsx/.vue/.svelte/.astro`) hace `localStorage`/`sessionStorage` `setItem(` con una clave que contiene `token`, `jwt`, `auth` o `session` (o `localStorage['token'] = …`) | Cualquier XSS lee el almacenamiento y se lleva la sesión. Una cookie `httpOnly` (con `Secure` y `SameSite`) puesta por el servidor no es legible desde JavaScript. |
| `server-entry` / `server-static-vite` | (con `serverEntry`) El servidor importa `vite` solo dinámicamente, dentro de la rama de desarrollo | La imagen de producción no necesita vite, ni puede arrancarlo por error. |

### Escaneo de secretos (`scan-secrets`)

| Patrón | Detecta |
|---|---|
| `google-oauth-secret` | Secretos de cliente OAuth de Google (prefijo `GOCSPX-`) |
| `gcp-service-account` | JSON de cuenta de servicio de Google: un `type` de cuenta de servicio junto a una `private_key` (en cualquier línea del fichero) |

Los ficheros con valores falsos conocidos (claves PEM de test, por ejemplo) se declaran en `secretScanAllow` (prefijos de ruta o ficheros). Se omiten del escaneo, pero la salida lista siempre cuáles, para que sigan a la vista. Una línea con `secret-scan: ignore` sigue valiendo para valores sueltos.

## guard-bash (comandos)

| Bloquea | Por qué |
|---|---|
| `git push --force`, `-f`, `--force-with-lease` y el refspec con `+` (`git push origin +rama`) | Reescribe historia compartida; el `+` fuerza igual que `--force`, en cualquier rama. |
| `git push` a `protectedBranches` (también como refspec: `rama:master`, `HEAD:refs/heads/master`, `:master`) y `git commit` estando en ellas | El flujo es rama de trabajo y luego pull request. Un refspec con destino protegido salta la regla igual que `git push origin master`. |
| `git reset --hard`, `git clean -f` y `rm -rf` de la raíz | Pierden trabajo de forma irreversible. El motivo recomienda una rama o un commit de trabajo, no `git stash`: con varios agentes en paralelo el índice es compartido y el stash arrastra o pierde cambios ajenos. |
| `--no-verify` y `--no-gpg-sign` | Saltarse un hook oculta el problema. |
| `npm audit fix --force` | Mete versiones mayores sin control. |
| `DROP TABLE`/`DATABASE`/`SCHEMA` y `TRUNCATE TABLE` | Destructivo; las migraciones deben ser aditivas. |
| Vaciar o revertir toda la base: `alembic`/`flask db downgrade base`, `manage.py migrate <app> zero`/`flush`/`reset_db`, `prisma migrate reset`, `prisma db push --force-reset`, `rails db:drop`/`db:reset`/`db:schema:load`, `sequelize db:migrate:undo:all`/`db:drop`, `knex migrate:rollback --all`, `typeorm schema:drop`, `artisan migrate:fresh`/`migrate:reset`/`db:wipe` | Borra todas las tablas de la base a la que apunte el entorno, que puede no ser la local. Revertir un paso sigue permitido (`alembic downgrade -1`, `knex migrate:rollback`). |
| `cat`/`type`/`Get-Content`/`grep`/… sobre ficheros de entorno (`.env`, `.env_prod`, `.env-staging`, `prod.env`…; salvo plantillas y `envTemplates`) | El contenido acabaría en la conversación y en los logs. | En `grep`/`rg`/`Select-String`/`findstr` el patrón de búsqueda (primer argumento sin opción y valores de `-e`/`--regexp`/`-Pattern`/`/c:`) no cuenta como fichero: `grep -iE "^\.env\|docker" .gitignore` pasa; `grep X .env` no.
| `printenv`, `env`, `Get-ChildItem env:` y `/proc/self/environ` | Igual que lo anterior, con todas las variables a la vez. |
| PowerShell: `$env:NOMBRE` con nombre de secreto (KEY, SECRET, TOKEN…), `Get-Item Env:NOMBRE`, `dir env:`, `ls env:`, `[Environment]::GetEnvironmentVariables()` y `GetEnvironmentVariable(…)` con nombre de secreto o no literal | Lo mismo en PowerShell. Se permiten `$env:PATH`, `$env:NODE_ENV`, `$env:PWD` y las asignaciones (`$env:X = …`). |
| `python -c` que imprime `os.environ` o `os.getenv` | Vuelca las claves. Se permite leer una clave literal que no sea secreta (`os.environ['HOME']`). |
| `echo $NOMBRE` / `echo ${NOMBRE}` con nombre de secreto en mayúsculas | Imprime el secreto en la conversación. `$PATH`, `$HOME` y `$PWD` pasan. |
| `set` sin argumentos (cmd o bash) | Lista todas las variables. `set -e` y similares pasan. |
| `VITE_…KEY=` y similares (asignar variables públicas con secreto) | Ver `public-secret-var`. | Excepción: `PUBLISHABLE` y `ANON`.
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

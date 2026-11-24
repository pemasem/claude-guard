# Rule catalog

*[Español](reglas.md)*

Every check has an id. If you really need to, disable it with `"disable": ["id"]` in `claude-guard.config.json`, always with the reason written in that same file.

## check-deploy-safety

### Image (Dockerfile)

| Id | Rule | Why |
|---|---|---|
| `docker-node-env` | Node images set `ENV NODE_ENV=production`, never `development` | Many servers (Express with Vite in middleware mode, Nuxt, Remix…) use `NODE_ENV` to decide whether to start the dev server. Without it, production runs in development mode. |
| `docker-dev-server` | The image doesn't start `npm run dev`, `vite`, `next dev`, `nodemon`, `tsx watch`, `ng serve`… | A dev server serves the source code and, by design or through bugs (Vite `server.fs.deny`), container files such as `.env`. |
| `docker-user` | The final stage runs as a non-root user (`USER node` or a `:nonroot` image) | If something gets compromised (a headless browser, a dependency), it isn't root inside the container. |
| `docker-python-dev-server` | In Python images (`FROM python` or a `CMD` with `uvicorn`/`gunicorn`/`flask`…): no `uvicorn --reload`, `fastapi dev`, `flask run`, `manage.py runserver`, `FLASK_DEBUG=1`, `FLASK_ENV=development` or `DEBUG=True` | Hot reload and interactive debuggers (Werkzeug, Django debug pages showing settings and environment) must not be exposed in production. |
| `docker-debug-log` | Warning if the `CMD`/`ENTRYPOINT` of a Python image uses `--log-level debug` or `trace` | Debug logs can include headers, tokens and user data. |
| `forwarded-ips-wildcard` | Warning if a Dockerfile or `docker-compose*.yml` passes `--forwarded-allow-ips=*` (or `'*'`) to uvicorn/gunicorn, or sets `FORWARDED_ALLOW_IPS=*` | With `*` the server trusts `X-Forwarded-For` from anywhere: anyone can spoof their IP and bypass per-IP brakes (rate limits, bans, logs). Restrict it to the proxy IP or network. |
| `uvicorn-proxy-headers` | Warning if uvicorn starts (Dockerfile or compose) with no `--proxy-headers`, `--forwarded-allow-ips` or `FORWARDED_ALLOW_IPS` in any checked Dockerfile/compose and the project has a `Caddyfile` or `nginx.conf` | uvicorn only trusts `X-Forwarded-For` from 127.0.0.1: behind a proxy in another container, per-IP brakes will only see the proxy IP. It only sees project files: if the flag is set in the deploy platform, silence the rule with `disable`. |
| `docker-browser-no-sandbox` | Warning if the Dockerfile (`ENV`, `RUN`, `CMD`, `ENTRYPOINT`) uses `--no-sandbox` or `--disable-setuid-sandbox`; **error** if the final stage also runs as root (the same condition as `docker-user`) | A headless browser rendering third-party pages without a sandbox and as root, in a container holding secrets, turns a renderer exploit into a root shell with every environment variable. It only sees the Dockerfile: a `--no-sandbox` passed from code isn't detected. |
| `docker-secret-env` | No secrets in `ENV` or `ARG` | They get baked into the image layers and the registry history. Use the platform's secret manager. |
| `docker-copy-all` | Warning (or error with `copyAllIsError`) on `COPY . .` | It copies the whole build context, so it depends entirely on `.dockerignore` being right. |
| `docker-frontend-build` | If there's a `vite.config.*`, the image runs `npm run build` | With no build there's no `dist/`, and the app ends up serving the frontend through the dev server. |
| `docker-prod-deps` | The **final stage** (and the stages it inherits with `FROM stage`) installs production dependencies only (`npm ci --omit=dev`, `pnpm install --prod`…), or just copies artifacts with `COPY --from=…` (e.g. `.next/standalone`) and installs nothing. Intermediate build stages may install everything | devDependencies include the dev servers and add attack surface. A final stage that only copies the compiled output carries no devDependencies. |

### Build context (.dockerignore)

| Id | Rule | Why |
|---|---|---|
| `dockerignore-missing` | If there's a Dockerfile, the `.dockerignore` **of its build context** exists: the Dockerfile's folder (or `<Dockerfile>.dockerignore` beside it) or, if a root `docker-compose*.yml` builds it, that service's `context:`. At the project root the `dockerignore` option applies. One error per context | Without it, `.env`, `.git` and local data go into the image. In a monorepo the root `.dockerignore` does not apply to Dockerfiles built from `backend/` or `web/`. |
| `dockerignore-env-in-context` | Error if the context holds a real `.env*` file (not a template), the Dockerfile does `COPY . …`/`ADD . …` from the context and the `.dockerignore` (or its absence) doesn't exclude it | `COPY . .` puts the secret in an image layer. `.dockerignore` patterns are anchored at the context root (`.env` doesn't cover `web/.env`; `**/.env` does). |
| `dockerignore-env` | Excludes `**/.env` and `**/.env.*` (or `**/.env_*`) and never re-includes them with `!` (except templates such as `.env.example`) | A `.env` inside the image can be read as soon as anything serves files. |
| `dockerignore-git` | Excludes `.git` | History can hold old secrets and exposes the code. |
| `dockerignore-node-modules` | Excludes `node_modules` | Avoids host binaries and dev packages. |

### Vite

| Id | Rule | Why |
|---|---|---|
| `vite-allowed-hosts` | `server.allowedHosts` without real domains or `true` | If the dev server accepts the public domain, someone planned to expose it. |
| `vite-env-prefix` | No `envPrefix` | It changes which variables get published to the browser. |
| `vite-load-env` | No `loadEnv(…, '')` (empty prefix) | It loads **every** variable into the config, and from there it's easy to pass them to `define`. |
| `vite-define-secret` | No secrets in `define` | `define` is inlined into the JavaScript the browser downloads. |

### Code and repository

| Id | Rule | Why |
|---|---|---|
| `public-secret-var` | No `VITE_*`, `NEXT_PUBLIC_*`, `REACT_APP_*`, `EXPO_PUBLIC_*`, `PUBLIC_*` or `NUXT_PUBLIC_*` variable with a secret-like name (KEY, SECRET, TOKEN, PASSWORD…) in any file (code, README, `.env.example`, CI). Names that are public keys by design are exempt: those containing `PUBLISHABLE` or `ANON` as a word (`VITE_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`) | These prefixes mean "publish me to the browser". A key with that name is a public key. Stripe publishable keys and Supabase anon keys are meant for the browser (protection lives in access policies, not in hiding them). `ANONYMIZE_KEY` is still flagged: `ANON` only counts as a whole word. |
| `frontend-ai-sdk` | The frontend doesn't import AI SDKs (`@google/genai`, `openai`, `@anthropic-ai/sdk`, `groq-sdk`, `@mistralai/*`…) | To call the provider from the browser, the key has to be in the browser. |
| `frontend-env` | (with `strictImportMetaEnv`) The frontend reads no custom environment variables | Everything the browser reads is public. This stops someone from adding "just one". |
| `env-tracked` | No committed env file (`.env`, `.env.local`, `.env_prod`, `.env-staging`, `prod.env`…), except templates (`.example/.sample/.template/.dist`, with `.`, `_` or `-`) and those listed in `envTemplates` | Once in git, the secret stays in the history and has to be rotated. Your own template names (`.env.master`) go in `envTemplates`. |
| `default-secret-value` | Warning if, in a server `.py`/`.ts`/`.js` (outside tests and `allowMention`), a secret (`secret_key`, `jwt_secret`, `session_secret`, `signing_key`, `encryption_key`…) has a well-known default (`changeme`, `cambiame`, `secret`, `dev-secret`, `insecure`, `password`…), assigned directly or as the second argument of `os.getenv`/`environ.get` or after `\|\|`/`??`. A line with `secret-scan: ignore` is skipped | If the environment variable is missing in production, the server starts with a key everyone knows and sessions or tokens can be forged. It is a warning because it can't see whether another part of startup refuses to continue with that value. |
| `browser-sandbox-disabled` | Warning if code uses `chromium_sandbox=False` (Playwright Python) or `chromiumSandbox: false` (Node) | Complements `docker-browser-no-sandbox`, which only sees the Dockerfile: a compromised renderer without a sandbox compromises the process and its secrets. |
| `frontend-token-storage` | Warning if a browser file (`.js/.ts/.jsx/.tsx/.vue/.svelte/.astro`) calls `localStorage`/`sessionStorage` `setItem(` with a key containing `token`, `jwt`, `auth` or `session` (or `localStorage['token'] = …`) | Any XSS reads the storage and takes the session. A server-set `httpOnly` cookie (with `Secure` and `SameSite`) isn't readable from JavaScript. |
| `server-entry` / `server-static-vite` | (with `serverEntry`) The server imports `vite` only dynamically, inside the development branch | The production image doesn't need vite and can't start it by mistake. |

### Secret scanning (`scan-secrets`)

| Pattern | Detects |
|---|---|
| `google-oauth-secret` | Google OAuth client secrets (`GOCSPX-` prefix) |
| `gcp-service-account` | Google service-account JSON: a service-account `type` together with a `private_key` (on any line of the file) |

Files with known fake values (test PEM keys, for example) are declared in `secretScanAllow` (path prefixes or files). They are skipped, but the output always lists which ones, so they stay visible. A line with `secret-scan: ignore` still works for single values.

## guard-bash (commands)

| Blocks | Why |
|---|---|
| `git push --force`, `-f`, `--force-with-lease` and the `+` refspec (`git push origin +branch`) | Rewrites shared history; the `+` forces just like `--force`, on any branch. |
| `git push` to `protectedBranches` (also as a refspec: `branch:master`, `HEAD:refs/heads/master`, `:master`), and `git commit` while on one | The workflow is a working branch, then a pull request. A refspec targeting a protected branch bypasses the rule just like `git push origin master`. |
| `git reset --hard`, `git clean -f` and root `rm -rf` | Lose work irreversibly. The message suggests a branch or a working commit, not `git stash`: with several agents in parallel the index is shared and a stash drags in or loses other people's changes. |
| `--no-verify` and `--no-gpg-sign` | Skipping a hook hides the problem. |
| `npm audit fix --force` | Pulls in uncontrolled major versions. |
| `DROP TABLE`/`DATABASE`/`SCHEMA` and `TRUNCATE TABLE` | Destructive; migrations should be additive. |
| Wiping or fully reverting the database: `alembic`/`flask db downgrade base`, `manage.py migrate <app> zero`/`flush`/`reset_db`, `prisma migrate reset`, `prisma db push --force-reset`, `rails db:drop`/`db:reset`/`db:schema:load`, `sequelize db:migrate:undo:all`/`db:drop`, `knex migrate:rollback --all`, `typeorm schema:drop`, `artisan migrate:fresh`/`migrate:reset`/`db:wipe` | Drops every table of whatever database the environment points to, which may not be the local one. Reverting one step is still allowed (`alembic downgrade -1`, `knex migrate:rollback`). |
| `cat`/`type`/`Get-Content`/`grep`/… on env files (`.env`, `.env_prod`, `.env-staging`, `prod.env`…; except templates and `envTemplates`) | The contents would end up in the conversation and the logs. | In `grep`/`rg`/`Select-String`/`findstr` the search pattern (first non-option argument and the values of `-e`/`--regexp`/`-Pattern`/`/c:`) does not count as a file: `grep -iE "^\.env\|docker" .gitignore` passes; `grep X .env` doesn't.
| `printenv`, `env`, `Get-ChildItem env:` and `/proc/self/environ` | Same as above, with every variable at once. |
| PowerShell: `$env:NAME` with a secret-like name (KEY, SECRET, TOKEN…), `Get-Item Env:NAME`, `dir env:`, `ls env:`, `[Environment]::GetEnvironmentVariables()` and `GetEnvironmentVariable(…)` with a secret-like or non-literal name | Same as above, in PowerShell. `$env:PATH`, `$env:NODE_ENV`, `$env:PWD` and assignments (`$env:X = …`) are allowed. |
| `python -c` printing `os.environ` or `os.getenv` | Dumps keys. Reading a literal, non-secret key (`os.environ['HOME']`) is allowed. |
| `echo $NAME` / `echo ${NAME}` with an uppercase secret-like name | Prints the secret into the conversation. `$PATH`, `$HOME` and `$PWD` pass. |
| `set` with no arguments (cmd or bash) | Lists every variable. `set -e` and the like pass. |
| `VITE_…KEY=` and similar (assigning public variables that hold secrets) | See `public-secret-var`. | Exception: `PUBLISHABLE` and `ANON`.
| `gcloud secrets versions access`, `gcloud auth print-access-token` / `print-identity-token`, `aws secretsmanager get-secret-value`, `az keyvault secret show`, `kubectl get secret … -o yaml/json` | They print a secret's value or a live credential: it would end up in the conversation and the logs. Listing names (`gcloud secrets list`, `kubectl get secrets`) is allowed. |
| `ngrok`, `cloudflared tunnel`, `localtunnel`, `tailscale funnel`… | They expose the dev server to the Internet. |
| `docker build`/`run` with `NODE_ENV=development`, `npm run dev`, `vite` or `next dev` | Development image. |

## protect-files (files)

| Action | Files | Why |
|---|---|---|
| Blocks reading and editing | `.env`, `.env.*`, `.env_*`, `.env-*`, `*.env` (except `.example/.sample/.template/.dist` templates, with `.`, `_` or `-`, and `envTemplates`), `*.pem`, `*.key`, `*.p12`, `id_rsa`, `credentials*.json`, `service-account*.json` | Secrets. |
| Blocks reading and editing | `*.sa.json`, any `*.json` inside `credentials/` or `secrets/`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials` and `kubeconfig` (or `.kube/config`) | Service-account, package-registry, git and cluster credentials. If your `.npmrc` is configuration only, read it from the terminal (or keep the secret out of it). |
| Blocks editing | `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `poetry.lock`, `uv.lock`, `Pipfile.lock`, `Cargo.lock`, `composer.lock`, `Gemfile.lock` and `go.sum` | The package manager regenerates them. `scan-secrets` skips them too: thousands of hashes that look like secrets. |
| Asks for confirmation | `.claude/hooks/claude-guard/`, `.claude-guard/`, `.claude/settings.json` and `claude-guard.config.json` | They are the safeguards themselves: they aren't loosened without the user seeing it. |

## post-edit

After every edit it runs `scan-secrets` on the file and `check-deploy-safety --changed <file>` (including the file, even if it isn't committed yet). Any failure returns exit 2, and Claude has to fix it before moving on.

- **Files outside the project** (a temp folder, say) are ignored. They are not the project's rules' business.
- **Scoped mode** (`--changed`): it only reports problems located in the edited file and, if the edited file is the Dockerfile, the `.dockerignore`, the Vite config or `serverEntry`, the global checks of that group. A pre-existing problem elsewhere no longer blocks every edit. Full mode (CI, no `--changed`) is unchanged.

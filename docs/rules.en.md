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
| `docker-secret-env` | No secrets in `ENV` or `ARG` | They get baked into the image layers and the registry history. Use the platform's secret manager. |
| `docker-copy-all` | Warning (or error with `copyAllIsError`) on `COPY . .` | It copies the whole build context, so it depends entirely on `.dockerignore` being right. |
| `docker-frontend-build` | If there's a `vite.config.*`, the image runs `npm run build` | With no build there's no `dist/`, and the app ends up serving the frontend through the dev server. |
| `docker-prod-deps` | The image installs production dependencies only (`npm ci --omit=dev`, `pnpm install --prod`…) | devDependencies include the dev servers and add attack surface. |

### Build context (.dockerignore)

| Id | Rule | Why |
|---|---|---|
| `dockerignore-missing` | If there's a Dockerfile, a `.dockerignore` exists | Without it, `.env`, `.git` and local data go into the image. |
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
| `public-secret-var` | No `VITE_*`, `NEXT_PUBLIC_*`, `REACT_APP_*`, `EXPO_PUBLIC_*`, `PUBLIC_*` or `NUXT_PUBLIC_*` variable with a secret-like name (KEY, SECRET, TOKEN, PASSWORD…) in any file (code, README, `.env.example`, CI) | These prefixes mean "publish me to the browser". A key with that name is a public key. |
| `frontend-ai-sdk` | The frontend doesn't import AI SDKs (`@google/genai`, `openai`, `@anthropic-ai/sdk`, `groq-sdk`, `@mistralai/*`…) | To call the provider from the browser, the key has to be in the browser. |
| `frontend-env` | (with `strictImportMetaEnv`) The frontend reads no custom environment variables | Everything the browser reads is public. This stops someone from adding "just one". |
| `env-tracked` | No committed env file (`.env`, `.env.local`, `.env_prod`, `.env-staging`, `prod.env`…), except templates (`.example/.sample/.template/.dist`, with `.`, `_` or `-`) and those listed in `envTemplates` | Once in git, the secret stays in the history and has to be rotated. Your own template names (`.env.master`) go in `envTemplates`. |
| `server-entry` / `server-static-vite` | (with `serverEntry`) The server imports `vite` only dynamically, inside the development branch | The production image doesn't need vite and can't start it by mistake. |

## guard-bash (commands)

| Blocks | Why |
|---|---|
| `git push --force`, `-f` and `--force-with-lease` | Rewrites shared history. |
| `git push` to `protectedBranches`, and `git commit` while on one | The workflow is a working branch, then a pull request. |
| `git reset --hard`, `git clean -f` and root `rm -rf` | Lose work irreversibly. |
| `--no-verify` and `--no-gpg-sign` | Skipping a hook hides the problem. |
| `npm audit fix --force` | Pulls in uncontrolled major versions. |
| `DROP TABLE`/`DATABASE`/`SCHEMA` and `TRUNCATE TABLE` | Destructive; migrations should be additive. |
| `cat`/`type`/`Get-Content`/`grep`/… on env files (`.env`, `.env_prod`, `.env-staging`, `prod.env`…; except templates and `envTemplates`) | The contents would end up in the conversation and the logs. |
| `printenv`, `env`, `Get-ChildItem env:` and `/proc/self/environ` | Same as above, with every variable at once. |
| `VITE_…KEY=` and similar (assigning public variables that hold secrets) | See `public-secret-var`. |
| `ngrok`, `cloudflared tunnel`, `localtunnel`, `tailscale funnel`… | They expose the dev server to the Internet. |
| `docker build`/`run` with `NODE_ENV=development`, `npm run dev`, `vite` or `next dev` | Development image. |

## protect-files (files)

| Action | Files | Why |
|---|---|---|
| Blocks reading and editing | `.env`, `.env.*`, `.env_*`, `.env-*`, `*.env` (except `.example/.sample/.template/.dist` templates, with `.`, `_` or `-`, and `envTemplates`), `*.pem`, `*.key`, `*.p12`, `id_rsa`, `credentials*.json`, `service-account*.json` | Secrets. |
| Blocks editing | `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml` and `bun.lockb` | The package manager regenerates them. |
| Asks for confirmation | `.claude/hooks/claude-guard/`, `.claude-guard/`, `.claude/settings.json` and `claude-guard.config.json` | They are the safeguards themselves: they aren't loosened without the user seeing it. |

## post-edit

After every edit it runs `scan-secrets` on the file and `check-deploy-safety` on the project (including the file, even if it isn't committed yet). Any failure returns exit 2, and Claude has to fix it before moving on.

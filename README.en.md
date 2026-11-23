# claude-guard

*[Español](README.md)*

[Claude Code](https://docs.claude.com/en/docs/claude-code) hooks and CI checks that stop a project from **deploying development servers or leaking secrets**. It collects the safeguards we keep learning, sometimes the hard way, so any teammate can install them with one command and work under the same rules.

> It was born from an incident: a cloud container was serving the Vite development server, and an AI API key sat in a `VITE_*` variable. Someone pulled it out and used it to send hundreds of thousands of requests in half an hour. Details in [docs/incidentes/2026-11-vite-dev-server.en.md](docs/incidentes/2026-11-vite-dev-server.en.md).

## What it does

| Piece | When it runs | What it does |
|---|---|---|
| `guard-bash` | Before every Claude command | Blocks dangerous commands (see the list below) |
| `protect-files` | Before reading or editing a file | Blocks reading or editing `.env*` and private keys, and hand-editing lockfiles. Asks for your confirmation before touching the safeguards themselves |
| `post-edit` | After every edit | Scans the file for secrets and runs `check-deploy-safety`. If something fails, Claude has to fix it right away |
| `check-deploy-safety` | Hook, CI or by hand | Checks the Dockerfile, `.dockerignore`, Vite config, public variables holding secrets, AI SDKs in the frontend and committed `.env` files |
| `scan-secrets` | Hook, CI or by hand | Looks for Google, OpenAI, Anthropic, GitHub, AWS, Slack and Stripe keys, private keys and JWTs |

`guard-bash` blocks:

- force pushes and pushes to protected branches;
- `reset --hard`, `clean -f`, `--no-verify` and root `rm -rf`;
- `npm audit fix --force` and destructive SQL;
- reading `.env` or dumping environment variables;
- defining public variables that hold a secret;
- tunnels to the dev server (ngrok, cloudflared…);
- Docker images that run the dev server.

Hook messages are in Spanish. The full rule catalog, with the reasoning behind each rule: [docs/rules.en.md](docs/rules.en.md).

## Install

You need Node 18 or later and nothing else (no dependencies).

```bash
git clone https://github.com/pemasem/claude-guard.git
node claude-guard/install.mjs /path/to/project --claude-md --ci github   # or --ci bitbucket
```

The installer:

- copies the hooks to `.claude/hooks/claude-guard/` and the checks to `.claude-guard/`;
- **merges** its entries into `.claude/settings.json`: it removes nothing that was already there, keeps a `settings.json.bak-*` copy, and duplicates nothing if you run it again;
- creates `claude-guard.config.json` if it doesn't exist;
- with `--claude-md`, adds a rules section to `CLAUDE.md` between markers (in Spanish);
- with `--ci`, creates the GitHub Actions workflow or leaves the snippet for Bitbucket Pipelines.

Then:

1. Review `claude-guard.config.json` (frontend and server paths, protected branches).
2. Run `node .claude-guard/check-deploy-safety.mjs && node .claude-guard/scan-secrets.mjs` and fix what it reports.
3. Commit `.claude/`, `.claude-guard/` and `claude-guard.config.json`, so the whole team gets the same rules.
4. Restart Claude Code (or check `/hooks`).

Other commands:

```bash
node claude-guard/install.mjs /path/project --dry-run      # shows what it would do, without writing
node claude-guard/install.mjs uninstall /path/project      # removes hooks, checks and the CLAUDE.md section
```

To update: `git pull` in `claude-guard` and run the installer again. It is idempotent and leaves your config alone.

## Configuration (`claude-guard.config.json`)

| Key | Default | Purpose |
|---|---|---|
| `protectedBranches` | `["main","master","develop"]` | Branches with no direct pushes or commits |
| `dockerfiles` | `["Dockerfile"]` | Dockerfiles to check. With no Dockerfile, `.dockerignore` isn't required |
| `dockerignore` | `".dockerignore"` | |
| `viteConfigs` | `vite.config.{ts,js,mjs,mts}` | If any exists, the image must build the frontend |
| `frontendDirs` / `frontendExtensions` | `src/components`… / `.tsx .jsx .vue .svelte .astro` | What counts as browser code |
| `serverDirs` | `server`, `api`, `app/api`, `pages/api`… | Never treated as frontend (AI SDKs are fine there) |
| `serverEntry` | `null` | If set, forbids a static `vite` import in that file |
| `allowMention` | `docs/`, `test/`… | Paths allowed to **name** public variables that hold secrets (to document or test them) |
| `strictImportMetaEnv` | `false` | If `true`, the frontend may only read `import.meta.env.DEV/PROD/MODE/BASE_URL/SSR` |
| `envTemplates` | `[]` | Extra names of committed value-less templates (e.g. `.env.master`): neither `env-tracked` nor the hooks treat them as secrets |
| `secretScanAllow` | `[]` | Files or folders `scan-secrets` doesn't scan because they hold known fake values (e.g. test PEM keys inside a JSON, where `secret-scan: ignore` can't go). Always listed in the output |
| `copyAllIsError` | `false` | If `true`, `COPY . .` goes from a warning to an error |
| `disable` | `[]` | Disabled rule ids. **Only with a reason documented** in the same file |

## Adding new safeguards

Every incident or finding should end up here as a rule, with a test and an explanation. See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm test        # node --test, no dependencies
npm run check   # claude-guard checking itself
```

## Limits

The hooks are a safety net for work with Claude Code and for CI, not a guarantee. They don't replace:

- the platform's secret manager;
- API key restrictions and quotas;
- spending alerts;
- code review.

See the platform checklist in the [incident write-up](docs/incidentes/2026-11-vite-dev-server.en.md#platform-checklist).

## License

[MIT](LICENSE)

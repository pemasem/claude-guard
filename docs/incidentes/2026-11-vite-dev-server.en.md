# Incident 2026-11: AI API key stolen through the Vite development server

*[Español](2026-11-vite-dev-server.md)* · Anonymized report.

## Summary

A service deployed in a cloud container was serving the **Vite development server** to the Internet. The API key for an AI provider was stored in a **`VITE_*`** variable. Someone obtained it and sent **hundreds of thousands of requests in about 30 minutes** from outside the project's infrastructure. The spend was significant, and billing had to be disabled to stop it.

## Chain of failures

No single one of these failures would have been enough. Together, they were.

1. **The image wasn't a production image.**
   - The Dockerfile installed dependencies, copied the code and started `tsx server.ts`, with no `npm run build` and no `NODE_ENV=production`.
   - The server (Express) did what templates usually do: `if (NODE_ENV !== 'production')` mounts Vite in middleware mode, otherwise it serves `dist/`.
   - Without the variable, the cloud ran development mode.

2. **The key was meant to reach the browser.**
   - The project docs said to define the key as `VITE_GEMINI_API_KEY`.
   - Vite publishes **every** `VITE_`-prefixed variable to the client.
   - A frontend module read it with `import.meta.env`. With the dev server running, requesting that module (`GET /src/services/<file>.ts`) was enough to get the key inside the JavaScript.

3. **The dev server had a file-read bug.**
   - The Vite version in use (6.4.4) had a bug that bypasses `server.fs.deny` using query parameters.
   - `GET /.env` returned 403, but `GET /.env?raw` returned the file's contents.
   - On top of that, the server's entire source code (`/server.ts`, services, seed scripts with development passwords) was readable.

4. **No defense in depth.**
   - The key had no API restriction and no quotas.
   - There were no spending alerts.
   - The public-source-code risk had been spotted weeks earlier and postponed.

## How it was confirmed

It was reproduced locally, with fake keys and a decoy `.env`, on Windows and Linux:

| Request | Result |
|---|---|
| `GET /src/services/<module>.ts` | 200, with the key in clear text |
| `GET /.env?raw`, `/.env?raw??`, `/.env?import&raw??` | 200, with the `.env` contents |
| `GET /.env` | 403 |
| `GET /server.ts` and other `.ts` files | 200, with the source code |
| `GET /.git/config`, `/proc/self/environ` | 200, **but it's `index.html`**: the dev server with `appType: 'spa'` returns the page for any unknown path |
| `GET /@fs/proc/self/environ?raw` | 403 |

**Lesson for log analysis:** a 200 on a sensitive path doesn't always mean something leaked. Check the response **size** and compare it with `index.html`.

## Fix

- Multi-stage image:
  - build stage: `npm ci` and `npm run build`;
  - final stage: `ENV NODE_ENV=production`, `npm ci --omit=dev` (vite isn't even in the image) and `USER node`.
- A `.dockerignore` that excludes `.env*`, `.git`, tests and local data.
- The server **refuses to start** in these cases:
  - on the cloud platform (detected through its variables, such as `K_SERVICE`), if `NODE_ENV` isn't `production`;
  - if there's a `VITE_*` variable with a secret-like name;
  - if required secrets are missing or too short.
- Vite is only loaded with `await import('vite')`, inside the development branch.
- The key is read only on the server, under a name without a public prefix.
- Vite upgraded to a fixed version.
- This repository: hooks and checks so it doesn't happen again in any project.

## Platform checklist

What no hook can do for you:

- [ ] **Revoke** the compromised key and create a **restricted** one (only the required API and, where possible, by origin or service account). Better still: service-account authentication, no API key.
- [ ] Keep secrets in the platform's **secret manager**, never in variables typed into the console or baked into the image.
- [ ] **Rotate everything** that was in the environment or in readable files: other AI keys, JWT secrets, integration tokens, the database password and admin passwords.
- [ ] Per-minute and per-day request **quotas** on the provider's API.
- [ ] **Budgets with alerts**, plus an **automatic billing cut-off** (budget → event → function that disables it) for projects that use paid APIs.
- [ ] Monitoring **alerts** on request volume to the provider.
- [ ] A capped `max-instances` and spending limits inside the application itself.
- [ ] **Least privilege**: who can view and create keys, and what the service account can do.
- [ ] An inventory of deployed services: delete old or forgotten ones (the affected service wasn't any of the "official" environments).
- [ ] Don't bring the service back up until all of the above is verified.

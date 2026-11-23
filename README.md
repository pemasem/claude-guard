# claude-guard

*[English](README.en.md)*

Hooks de [Claude Code](https://docs.claude.com/en/docs/claude-code) y comprobadores de CI para que un proyecto **no despliegue servidores de desarrollo ni filtre secretos**. Recoge las medidas que vamos aprendiendo, a veces a base de incidentes reales, para que cualquier compañero las instale con un comando y trabaje con las mismas reglas.

> Nació de un incidente: un contenedor en la nube servía el servidor de desarrollo de Vite, con una clave de IA guardada en una variable `VITE_*`. Alguien la sacó y la usó para lanzar cientos de miles de peticiones en media hora. Detalles en [docs/incidentes/2026-11-vite-dev-server.md](docs/incidentes/2026-11-vite-dev-server.md).

## Qué hace

| Pieza | Cuándo actúa | Qué hace |
|---|---|---|
| `guard-bash` | Antes de cada comando de Claude | Bloquea los comandos peligrosos (ver la lista debajo) |
| `protect-files` | Antes de leer o editar un fichero | Bloquea leer o editar `.env*` y claves privadas, y editar lockfiles a mano. Pide tu confirmación para tocar las propias barreras |
| `post-edit` | Después de cada edición | Busca secretos en el fichero y pasa `check-deploy-safety`. Si algo falla, Claude tiene que corregirlo en el momento |
| `check-deploy-safety` | Hook, CI o a mano | Revisa el Dockerfile, el `.dockerignore`, la configuración de Vite, las variables públicas con secreto, los SDK de IA en el frontend y los `.env` versionados |
| `scan-secrets` | Hook, CI o a mano | Busca claves de Google, OpenAI, Anthropic, GitHub, AWS, Slack y Stripe, claves privadas y JWT |

`guard-bash` bloquea:

- push forzado y push a ramas protegidas;
- `reset --hard`, `clean -f`, `--no-verify` y `rm -rf` de la raíz;
- `npm audit fix --force` y SQL destructivo;
- leer `.env` o volcar las variables de entorno;
- definir variables públicas con un secreto;
- túneles al servidor de desarrollo (ngrok, cloudflared…);
- imágenes Docker con el servidor de desarrollo.

Catálogo completo, con el porqué de cada regla: [docs/reglas.md](docs/reglas.md).

## Instalación

Necesitas Node 18 o superior y nada más (no tiene dependencias).

```bash
git clone https://github.com/pemasem/claude-guard.git
node claude-guard/install.mjs /ruta/a/tu-proyecto --claude-md --ci github   # o --ci bitbucket
```

El instalador:

- copia los hooks a `.claude/hooks/claude-guard/` y los comprobadores a `.claude-guard/`;
- **fusiona** sus entradas en `.claude/settings.json`: no borra nada de lo que ya hubiera, guarda una copia `settings.json.bak-*` y no duplica nada si lo ejecutas otra vez;
- crea `claude-guard.config.json` si no existe;
- con `--claude-md`, añade a `CLAUDE.md` una sección de reglas entre marcadores;
- con `--ci`, crea el workflow de GitHub Actions o deja el fragmento para Bitbucket Pipelines.

Después:

1. Revisa `claude-guard.config.json` (rutas del frontend y del servidor, ramas protegidas).
2. Ejecuta `node .claude-guard/check-deploy-safety.mjs && node .claude-guard/scan-secrets.mjs` y corrige lo que salga.
3. Versiona `.claude/`, `.claude-guard/` y `claude-guard.config.json`, para que todo el equipo tenga las mismas reglas.
4. Reinicia Claude Code (o revisa `/hooks`).

Otros comandos:

```bash
node claude-guard/install.mjs /ruta/proyecto --dry-run      # muestra qué haría, sin escribir
node claude-guard/install.mjs uninstall /ruta/proyecto      # quita hooks, comprobadores y la sección de CLAUDE.md
```

Para actualizar: `git pull` en `claude-guard` y vuelve a ejecutar el instalador. Es idempotente y no toca tu configuración.

## Configuración (`claude-guard.config.json`)

| Clave | Por defecto | Para qué |
|---|---|---|
| `protectedBranches` | `["main","master","develop"]` | Ramas sin push directo ni commits |
| `dockerfiles` | `["Dockerfile"]` | Dockerfiles que se revisan. Sin Dockerfile, no se exige `.dockerignore` |
| `dockerignore` | `".dockerignore"` | |
| `viteConfigs` | `vite.config.{ts,js,mjs,mts}` | Si existe alguno, la imagen tiene que compilar el frontend |
| `frontendDirs` / `frontendExtensions` | `src/components`… / `.tsx .jsx .vue .svelte .astro` | Qué cuenta como código de navegador |
| `serverDirs` | `server`, `api`, `app/api`, `pages/api`… | Nunca cuentan como frontend (ahí sí puede haber SDK de IA) |
| `serverEntry` | `null` | Si lo defines, prohíbe importar `vite` de forma estática en ese fichero |
| `allowMention` | `docs/`, `test/`… | Rutas que pueden **nombrar** variables públicas con secreto (para documentarlas o probarlas) |
| `strictImportMetaEnv` | `false` | Si está a `true`, el frontend solo puede leer `import.meta.env.DEV/PROD/MODE/BASE_URL/SSR` |
| `envTemplates` | `[]` | Nombres extra de plantillas versionadas sin valores (p. ej. `.env.master`): ni `env-tracked` ni los hooks las tratan como secretos |
| `copyAllIsError` | `false` | Si está a `true`, `COPY . .` pasa de aviso a error |
| `disable` | `[]` | Ids de regla desactivados. **Solo con una razón documentada** en el mismo fichero |

## Añadir medidas nuevas

Cada incidente o hallazgo debería acabar aquí como una regla, con su test y su explicación. Ver [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm test        # node --test, sin dependencias
npm run check   # claude-guard comprobándose a sí mismo
```

## Límites

Los hooks son una red de seguridad para el trabajo con Claude Code y para el CI, no una garantía. No sustituyen:

- el gestor de secretos de la plataforma;
- las restricciones y cuotas de las claves de API;
- las alertas de gasto;
- la revisión de código.

Mira el checklist de plataforma del [incidente](docs/incidentes/2026-11-vite-dev-server.md#checklist-de-plataforma).

## Licencia

[MIT](LICENSE)

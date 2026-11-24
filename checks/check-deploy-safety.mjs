#!/usr/bin/env node
// claude-guard · Comprobador de seguridad del despliegue.
//
// Nació de un incidente real (docs/incidentes/2026-11-vite-dev-server.md): un contenedor en la nube servía el
// servidor de DESARROLLO de Vite, que publicaba el código fuente, el contenido de .env y una clave de IA guardada en
// una variable VITE_*. Alguien la usó para lanzar cientos de miles de peticiones en media hora.
//
//   node .claude-guard/check-deploy-safety.mjs                 -> comprueba el proyecto (exit 1 si algo falla)
//   node .claude-guard/check-deploy-safety.mjs <ficheros…>     -> además, ficheros aún no versionados (hook)
//   --root <dir>                                               -> raíz del proyecto (por defecto, la carpeta padre)
//
// Configuración opcional en <raíz>/claude-guard.config.json (ver README). Cada problema lleva un id de regla;
// "disable": ["id", …] desactiva reglas concretas (déjalo documentado en el propio fichero de configuración).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const rootIdx = argv.indexOf('--root');
const rootArg = rootIdx >= 0 ? argv.splice(rootIdx, 2)[1] : null;
const changedIdx = argv.indexOf('--changed');
const changedArg = changedIdx >= 0 ? argv.splice(changedIdx, 2)[1] : null;
const root = path.resolve(rootArg || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

const DEFAULTS = {
  dockerfiles: ['Dockerfile'],
  dockerignore: '.dockerignore',
  viteConfigs: ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts'],
  frontendDirs: ['src/components', 'src/pages', 'src/views', 'src/hooks', 'src/services', 'src/lib/client', 'components', 'client', 'frontend', 'web/src'],
  frontendExtensions: ['.tsx', '.jsx', '.vue', '.svelte', '.astro'],
  serverDirs: ['server', 'api', 'backend', 'functions', 'src/server', 'src/api', 'app/api', 'src/app/api', 'pages/api', 'src/pages/api', 'scripts'],
  serverEntry: null,
  allowMention: ['docs/', 'test/', 'tests/', '__tests__/', '.claude-guard/', '.claude/hooks/claude-guard/', 'CHANGELOG.md', 'claude-guard.config.json'],
  envTemplates: [],
  strictImportMetaEnv: false,
  copyAllIsError: false,
  disable: [],
};

function loadConfig() {
  const p = path.join(root, 'claude-guard.config.json');
  if (!fs.existsSync(p)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch (e) {
    console.error(`✖ claude-guard.config.json no es JSON válido: ${e.message}`);
    process.exit(1);
  }
}
const config = loadConfig();
const disabled = new Set(config.disable || []);

const rel = (p) => path.relative(root, p).split(path.sep).join('/');
const read = (p) => (fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : null);
const stripHashComments = (s) => s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

// Prefijos que los frameworks publican en el navegador; armados por partes para no detectarse a sí mismos.
const PUBLIC_PREFIXES = [['VI', 'TE_'], ['NEXT', '_PUBLIC_'], ['REACT', '_APP_'], ['EXPO', '_PUBLIC_'], ['NUXT', '_PUBLIC_'], ['PUB', 'LIC_']].map((p) => p.join(''));
const SECRET_WORDS = 'KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIAL|PRIVATE|AUTH';
// Claves públicas por diseño (Supabase anon, Stripe publishable…): misma definición que PUBLIC_BY_DESIGN de hooks/lib.mjs.
const PUBLIC_BY_DESIGN = '[A-Z0-9_]*?(?:PUBLISHABLE|(?<![A-Za-z0-9])ANON(?![A-Za-z0-9]))';
const PUBLIC_SECRET_VAR = new RegExp(`\\b(?:${PUBLIC_PREFIXES.join('|')})(?!${PUBLIC_BY_DESIGN})[A-Z0-9_]*(?:${SECRET_WORDS})[A-Z0-9_]*\\b`);
// Valores por defecto conocidos de secretos (en código de servidor): el servidor arrancaría con una clave que conoce todo el mundo.
const SECRET_NAME_IN_CODE = /(?:secret[_-]?key|jwt[_-]?secret(?:[_-]?key)?|jwt[_-]?key|signing[_-]?key|session[_-]?secret|cookie[_-]?secret|app[_-]?secret|auth[_-]?secret|api[_-]?secret|encryption[_-]?key|nextauth[_-]?secret)/i;
const KNOWN_DEFAULT_SECRET = /^(?:change[-_ ]?me|cambiame|cámbiame|secret|secretkey|super[-_]?secret|dev[-_]?secret|dev[-_]?key|insecure|unsafe|default[-_]?secret|my[-_]?secret|replace[-_ ]?me|your[-_]?secret|test[-_]?secret|password|1234\d*)(?:[-_ ][\w -]*)?$/i;
const isTestFile = (f) => /(^|\/)(tests?|__tests__|e2e|fixtures)\/|\.(test|spec)\.[^.]+$|(^|\/)(test_[^/]*|[^/]*_test)\.py$|(^|\/)conftest\.py$/.test(f);
const BROWSER_NO_SANDBOX_API = /\bchromium_sandbox\s*=\s*False\b|\bchromiumSandbox\s*:\s*false\b/;
const TOKEN_IN_BROWSER_STORAGE = /\b(?:local|session)Storage\s*\.\s*setItem\s*\(\s*[^,)\n]*(?:token|jwt|auth|session)|\b(?:local|session)Storage\s*\[\s*["'`][^"'`\n]*(?:token|jwt|auth|session)[^"'`\n]*["'`]\s*\]\s*=(?!=)/i;
const FORWARDED_ALL = /--forwarded-allow-ips[=\s"',]+\*|\bFORWARDED_ALLOW_IPS\b["']?(?:\s*[:=]\s*|\s+)["']?\*/i;
const PROXY_FLAGS = /--proxy-headers\b|--forwarded-allow-ips\b|\bFORWARDED_ALLOW_IPS\b/i;
const PROD_DEPS_ONLY = /npm\s+ci\b[^\n]*--(omit=dev|only=prod(uction)?|production)\b|npm\s+(install|i)\b[^\n]*--(omit=dev|production)\b|npm\s+prune\b[^\n]*--(omit=dev|production)|yarn\s+(install\b[^\n]*--production|workspaces\s+focus\b[^\n]*--production)|pnpm\s+(install\b[^\n]*--prod\b|deploy\b[^\n]*--prod\b)|NODE_ENV=production\s+npm\s+ci\b/;
const INSTALLS_DEPS = /^\s*RUN\b(?![^\n]*(?:\s-g\b|--global\b))[^\n]*\b(?:npm\s+(?:ci|install|i)\b|yarn\s*(?:install\b|$|&&|;|--)|pnpm\s+(?:install|i)\b|bun\s+install\b)/m;
const AI_SDK = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](@google\/genai|@google\/generative-ai|openai|@anthropic-ai\/sdk|groq-sdk|@mistralai\/[\w-]+|cohere-ai|replicate)['"]/;
const BROWSER_ENV_OK = new Set(['DEV', 'PROD', 'MODE', 'BASE_URL', 'SSR']);
// Misma definición que isEnvFile de hooks/lib.mjs (este comprobador es autónomo, también corre en CI).
function isEnvFile(file) {
  const f = file.replace(/\\/g, '/');
  const base = f.split('/').pop();
  if (!/^(\.env([._-].+)?|.+\.env)$/i.test(base)) return false;
  if (/[._-](example|sample|template|dist)$/i.test(base)) return false;
  return !(config.envTemplates || []).some((t) => f === t || f.endsWith('/' + t));
}
const TEXT_EXT = /\.(m?[jt]sx?|c[jt]s|json|md|mdx|ya?ml|html|css|scss|sh|ps1|txt|example|sample|sql|toml|ini|cfg|conf|vue|svelte|astro|py|rb|go|java|kt|cs|php|tf|properties)$|(^|\/)(Dockerfile[^/]*|\.dockerignore|\.gitignore|\.env[^/]*|Makefile|Procfile)$/i;

const problems = [];
const warnings = [];
function fail(rule, where, msg) {
  if (!disabled.has(rule)) problems.push({ rule, where, text: `[${rule}] ${where}: ${msg}` });
}
function warn(rule, where, msg) {
  if (!disabled.has(rule)) warnings.push({ rule, where, text: `[${rule}] ${where}: ${msg}` });
}

function gitFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    // Solo vale si root es la raíz del repositorio (ls-files devuelve rutas relativas al cwd).
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.venv', 'vendor'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(rel(p));
  }
  return acc;
}

const viteConfigPath = (config.viteConfigs || []).map((f) => path.join(root, f)).find((p) => fs.existsSync(p)) || null;

// ---------------------------------------------------------------------------------------------------------------
// 1) Dockerfile(s): imagen de producción, sin servidor de desarrollo ni secretos.
// ---------------------------------------------------------------------------------------------------------------
function checkDockerfile(file) {
  const where = file;
  const s = read(path.join(root, file));
  if (s === null) return false;
  // La forma exec de CMD/ENTRYPOINT (["npm", "run", "dev"]) se aplana para que las reglas vean el comando.
  const code = stripHashComments(s).replace(/["']\s*,\s*["']/g, ' ');
  const isNode = /^\s*FROM\s+[^\n]*\bnode\b/im.test(code);
  // Python: la imagen parte de python o el CMD/ENTRYPOINT arranca un servidor Python.
  const isPython = /^\s*FROM\s+[^\n]*\bpython\b/im.test(code) || /^\s*(?:CMD|ENTRYPOINT)\b[^\n]*\b(?:uvicorn|gunicorn|hypercorn|daphne|flask|fastapi|manage\.py|python[\d.]*)\b/im.test(code);

  if (isNode && !/^\s*ENV\s+(?:[^\n]*\s)?NODE_ENV(?:=|\s+)["']?production["']?(?:\s|$)/m.test(code)) {
    fail('docker-node-env', where, 'falta `ENV NODE_ENV=production`: muchas apps (Express+Vite, Nuxt, etc.) arrancan el modo desarrollo sin él');
  }
  if (/NODE_ENV(?:=|\s+)["']?(development|dev)\b/.test(code)) fail('docker-node-env', where, 'NODE_ENV de desarrollo en la imagen');
  if (/\b(npm|yarn|pnpm|bun)\s+(run\s+)?dev\b|tsx\s+watch|\bnodemon\b|\bvite(\s+(dev|serve|preview))?\s*["'\]]|\bvite\s+(dev|serve|preview)\b|next\s+dev\b|ng\s+serve\b|react-scripts\s+start\b|nuxt\s+dev\b|astro\s+dev\b/.test(code)) {
    fail('docker-dev-server', where, 'arranca un servidor de desarrollo (npm run dev, vite, next dev, nodemon, tsx watch…): publica código y ficheros del contenedor');
  }
  const users = [...code.matchAll(/^\s*USER\s+(\S+)/gm)].map((m) => m[1]);
  const fromNonroot = /^\s*FROM\s+[^\n]*:nonroot\b/im.test(code);
  const runsAsRoot = !fromNonroot && (!users.length || /^(root|0)(:|$)/.test(users[users.length - 1]));
  if (runsAsRoot) {
    fail('docker-user', where, isNode
      ? 'el contenedor corre como root: añade `USER node` (o un usuario sin privilegios) en la etapa final'
      : 'el contenedor corre como root: añade un usuario sin privilegios (p. ej. `RUN useradd -r app` + `USER app`) en la etapa final');
  }
  // Navegador headless sin sandbox: si renderiza páginas de terceros como root y en un contenedor con secretos,
  // un exploit del renderizador da una shell root con todo el entorno. Aviso; error si además corre como root.
  if (/--no-sandbox\b|--disable-setuid-sandbox\b/.test(code)) {
    (runsAsRoot ? fail : warn)('docker-browser-no-sandbox', where, runsAsRoot
      ? 'navegador headless sin sandbox (--no-sandbox / --disable-setuid-sandbox) y el contenedor corre como root: un exploit del renderizador daría una shell root con todos los secretos del entorno'
      : 'navegador headless sin sandbox (--no-sandbox / --disable-setuid-sandbox): un exploit del renderizador comprometería el contenedor y sus secretos; si la plataforma lo obliga, aísla el navegador en un servicio sin secretos');
  }
  if (isPython) {
    if (/\buvicorn\b[^\n]*--reload\b|\bfastapi\s+dev\b|\bflask\b(?:\s+--?[\w-]+(?:[= ]\S+)?)*\s+run(?![\w-])|manage\.py\s+runserver\b|\bFLASK_DEBUG(?:=|\s+)["']?(?:1|true)\b|\bFLASK_ENV(?:=|\s+)["']?development\b|\b(?:DJANGO_)?DEBUG(?:=|\s+)["']?(?:True|true|1)\b/i.test(code)) {
      fail('docker-python-dev-server', where, 'servidor de desarrollo de Python o modo debug en la imagen (uvicorn --reload, fastapi dev, flask run, manage.py runserver, FLASK_DEBUG, DEBUG=True): usa uvicorn/gunicorn sin --reload y con el debug apagado');
    }
    const startLines = code.split('\n').filter((l) => /^\s*(?:CMD|ENTRYPOINT)\b/i.test(l)).join('\n');
    if (/--log-level(?:=|\s+)["']?(?:debug|trace)\b/i.test(startLines)) {
      warn('docker-debug-log', where, 'el arranque usa --log-level debug/trace: los logs de depuración pueden incluir cabeceras, tokens y datos de usuario');
    }
  }
  const secretEnv = new RegExp(`^\\s*(ENV|ARG)\\s+[A-Z0-9_]*(${SECRET_WORDS})[A-Z0-9_]*(?:=|\\s+)\\S`, 'm');
  if (secretEnv.test(code)) fail('docker-secret-env', where, 'un secreto en ENV/ARG queda grabado en las capas de la imagen: usa el gestor de secretos de la plataforma');
  if (/^\s*COPY\s+(--\S+\s+)*\.\s+\S+\s*$/m.test(code)) {
    (config.copyAllIsError ? fail : warn)('docker-copy-all', where, '`COPY . …` copia todo el contexto: confirma que el .dockerignore excluye secretos, .git y datos locales');
  }
  if (isNode && viteConfigPath && !/\b(npm|yarn|pnpm|bun)\s+(run\s+)?build\b|\bvite\s+build\b/.test(code)) {
    fail('docker-frontend-build', where, 'hay configuración de Vite pero la imagen no compila el frontend (`npm run build`): se acabaría sirviendo con el servidor de desarrollo');
  }
  // Solo cuenta la etapa final (y las que hereda con `FROM etapa`): si solo copia artefactos (`COPY --from=…`, p. ej.
  // `.next/standalone`) y no instala nada, no hay devDependencies que revisar.
  if (isNode) {
    const finalText = finalStageText(code);
    const onlyCopiesArtifacts = /^\s*COPY\s+[^\n]*--from=/im.test(finalText) && !INSTALLS_DEPS.test(finalText);
    if (!PROD_DEPS_ONLY.test(finalText) && !onlyCopiesArtifacts) {
      fail('docker-prod-deps', where, 'la etapa final debería instalar solo dependencias de producción (`npm ci --omit=dev` o equivalente) o limitarse a copiar artefactos con `COPY --from=…`: las devDependencies incluyen servidores de desarrollo');
    }
  }
  // `COPY . …` / `ADD . …` desde el contexto (no desde otra etapa): lo usa la comprobación del contexto.
  const copiesContext = code.split('\n').some((l) => /^\s*(?:COPY|ADD)\s+(?:--(?!from\b)\S+\s+)*\.\/?\s+\S+/i.test(l));
  return { code, copiesContext };
}

// Etapas de un Dockerfile multi-etapa: [{ from, name, lines }].
function stagesOf(code) {
  const stages = [];
  for (const line of code.split('\n')) {
    const m = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (m) stages.push({ from: m[1].toLowerCase(), name: (m[2] || '').toLowerCase(), lines: [line] });
    else if (stages.length) stages[stages.length - 1].lines.push(line);
  }
  return stages;
}
// Texto de la etapa final más el de las etapas de las que parte (`FROM build AS runner` hereda lo instalado en `build`).
function finalStageText(code) {
  const stages = stagesOf(code);
  if (!stages.length) return code;
  let i = stages.length - 1;
  let text = stages[i].lines.join('\n');
  const seen = new Set([i]);
  for (;;) {
    const parent = stages.findIndex((s, j) => j < i && s.name && s.name === stages[i].from);
    if (parent < 0 || seen.has(parent)) break;
    seen.add(parent);
    text = stages[parent].lines.join('\n') + '\n' + text;
    i = parent;
  }
  return text;
}
// ---------------------------------------------------------------------------------------------------------------
// 2) .dockerignore: secretos, historial y dependencias del host fuera de la imagen.
// ---------------------------------------------------------------------------------------------------------------
// Cada Dockerfile se construye con su contexto: la carpeta del Dockerfile o, si un docker-compose*.yml lo construye,
// el `context:` de cada servicio. El .dockerignore es el del contexto (o `<Dockerfile>.dockerignore` junto al Dockerfile).
// En la raíz del proyecto vale la opción `dockerignore` de la configuración.
const unquote = (v) => v.replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
function composeFiles() {
  try {
    return fs.readdirSync(root).filter((f) => /^(?:docker-)?compose(?:[.-][\w.-]*)?\.ya?ml$/i.test(f));
  } catch {
    return [];
  }
}
function composeBuilds() {
  const out = [];
  for (const name of composeFiles()) {
    const text = read(path.join(root, name));
    if (text === null) continue;
    const lines = stripHashComments(text).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)build:\s*(.*?)\s*$/.exec(lines[i]);
      if (!m) continue;
      let context = unquote(m[2]);
      let dockerfile = null;
      if (!context) {
        for (let j = i + 1; j < lines.length; j++) {
          if (!lines[j].trim()) continue;
          if (/^\s*/.exec(lines[j])[0].length <= m[1].length) break;
          const kv = /^\s*(context|dockerfile):\s*(.*?)\s*$/.exec(lines[j]);
          if (kv && kv[1] === 'context') context = unquote(kv[2]);
          else if (kv) dockerfile = unquote(kv[2]);
        }
      }
      if (!context || /\$|^[a-z][\w+.-]*:\/\//i.test(context)) continue;
      const ctxAbs = path.resolve(root, context);
      out.push({ compose: name, ctxAbs, dockerfileAbs: path.resolve(ctxAbs, dockerfile || 'Dockerfile') });
    }
  }
  return out;
}

function contextsOf(file, builds) {
  const abs = path.resolve(root, file);
  const ctxs = builds.filter((b) => b.dockerfileAbs === abs).map((b) => b.ctxAbs);
  return [...new Set(ctxs.length ? ctxs : [path.dirname(abs)])];
}

// Patrones de .dockerignore (siempre anclados a la raíz del contexto; `**/` cubre cualquier profundidad).
function dockerPattern(p) {
  const g = p.replace(/^\/+/, '').replace(/\/+$/, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
function excludedByDockerignore(lines, relPath) {
  const parts = relPath.split('/');
  let excluded = false;
  for (const l of lines) {
    const neg = l.startsWith('!');
    const re = dockerPattern(neg ? l.slice(1) : l);
    if (parts.some((_, i) => re.test(parts.slice(0, i + 1).join('/')))) excluded = !neg;
  }
  return excluded;
}

function checkDockerContexts(dockerfiles) {
  const builds = composeBuilds();
  const seen = new Set();
  for (const d of dockerfiles) {
    for (const ctxAbs of contextsOf(d.file, builds)) {
      const ctxRel = rel(ctxAbs);
      const candidates = [`${d.file}.dockerignore`, ctxRel ? `${ctxRel}/.dockerignore` : config.dockerignore];
      const found = candidates.find((c) => read(path.join(root, c)) !== null);
      const where = found || candidates[1];
      const s = found ? read(path.join(root, found)) : null;
      if (!seen.has(where)) {
        seen.add(where);
        if (s === null) fail('dockerignore-missing', where, 'no existe: todo el contexto de construcción (incluidos .env y .git) entraría en la imagen. En un monorepo, cada Dockerfile necesita el .dockerignore de su contexto');
        else checkDockerignore(where, s);
      }
      // Un .env real dentro del contexto con `COPY . …` y sin .dockerignore que lo excluya acaba en la imagen.
      if (!d.copiesContext) continue;
      const lines = s === null ? [] : s.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      const leaked = (fs.existsSync(ctxAbs) ? walk(ctxAbs) : [])
        .map((f) => path.relative(ctxAbs, path.join(root, f)).split(path.sep).join('/'))
        .filter((f) => isEnvFile(f) && !excludedByDockerignore(lines, f));
      if (leaked.length) {
        fail('dockerignore-env-in-context', d.file, `el Dockerfile hace \`COPY . …\` y el contexto${ctxRel ? ` \`${ctxRel}\`` : ''} contiene ${leaked.join(', ')}${s === null ? ' sin .dockerignore' : ' que su .dockerignore no excluye'}: el secreto entraría en la imagen`);
      }
    }
  }
}

function checkDockerignore(where, s) {
  const lines = s.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const has = (...alts) => alts.some((a) => lines.includes(a));
  if (!has('.env', '**/.env', '.env*', '**/.env*', '*.env', '**/*.env')) fail('dockerignore-env', where, 'falta `**/.env`');
  if (!has('.env.*', '**/.env.*', '.env_*', '**/.env_*', '.env*', '**/.env*')) fail('dockerignore-env', where, 'falta `**/.env.*` o `**/.env_*` (.env.local, .env_prod…)');
  if (!has('.git', '**/.git', '.git/', '**/.git/')) fail('dockerignore-git', where, 'falta `.git` (historial con posibles secretos antiguos)');
  if (!has('node_modules', '**/node_modules', 'node_modules/', '**/node_modules/')) fail('dockerignore-node-modules', where, 'falta `**/node_modules` (binarios del host y paquetes de desarrollo)');
  for (const l of lines) {
    if (/^!.*\.env/.test(l) && isEnvFile(l.slice(1))) fail('dockerignore-env', where, `no re-incluyas ficheros .env (\`${l}\`)`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 2b) Servidores Python detrás de un proxy: IP real del cliente sin falsificación.
// ---------------------------------------------------------------------------------------------------------------
function checkProxy(dockerUnits) {
  const units = dockerUnits.map((d) => ({ where: d.file, text: d.code, start: d.code.split('\n').filter((l) => /^\s*(?:CMD|ENTRYPOINT)\b/i.test(l)).join('\n') }));
  for (const c of composeFiles()) {
    const text = stripHashComments(read(path.join(root, c)) || '');
    units.push({ where: c, text, start: text });
  }
  for (const u of units) {
    if (FORWARDED_ALL.test(u.text)) {
      warn('forwarded-ips-wildcard', u.where, 'uvicorn/gunicorn confían en X-Forwarded-For de cualquier origen (`--forwarded-allow-ips=*` / FORWARDED_ALLOW_IPS=*): cualquiera puede falsificar su IP y saltarse los frenos por IP. Limítalo a la IP o la red del proxy');
    }
  }
  const hasProxy = projectFiles().files.some((f) => /^(?:Caddyfile(?:\..+)?|nginx\.conf)$/.test(f.split('/').pop()));
  if (!hasProxy || units.some((u) => PROXY_FLAGS.test(u.text))) return;
  for (const u of units) {
    if (/\buvicorn\b/.test(u.start)) {
      warn('uvicorn-proxy-headers', u.where, 'uvicorn sin `--proxy-headers` (ni `--forwarded-allow-ips`) y el proyecto tiene un proxy inverso (Caddyfile/nginx.conf): los frenos por IP verán solo la IP del proxy');
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 3) Configuración de Vite: nada de secretos al navegador ni servidor de desarrollo en dominios reales.
// ---------------------------------------------------------------------------------------------------------------
function checkViteConfig() {
  if (!viteConfigPath) return;
  const where = rel(viteConfigPath);
  const code = read(viteConfigPath).replace(/^\s*\/\/.*$/gm, '');
  const hosts = /allowedHosts\s*:\s*(true|\[[^\]]*\])/.exec(code);
  if (hosts) {
    const val = hosts[1];
    const nonLocal = val === 'true' || [...val.matchAll(/['"`]([^'"`]+)['"`]/g)].some((m) => !/^(localhost|127\.0\.0\.1|::1|\.localhost|host\.docker\.internal)$/.test(m[1]));
    if (nonLocal) fail('vite-allowed-hosts', where, '`allowedHosts` con dominios reales: el servidor de desarrollo no debe responder nunca en un dominio público');
  }
  if (/\benvPrefix\s*:/.test(code)) fail('vite-env-prefix', where, '`envPrefix` cambia qué variables se publican en el navegador');
  if (/loadEnv\s*\([^)]*,\s*(['"`])\1\s*\)/.test(code)) fail('vite-load-env', where, '`loadEnv(…, \'\')` carga TODAS las variables (también secretos) en la config: fácil acabar metiéndolas en `define`');
  const define = /define\s*:\s*\{([\s\S]*?)\}/.exec(code);
  if (define && new RegExp(`(process\\.env|env)\\.[A-Z0-9_]*(${SECRET_WORDS})`).test(define[1])) {
    fail('vite-define-secret', where, '`define` con un secreto: se incrusta en el JavaScript que descarga el navegador');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 4) Entrypoint del servidor (opcional): Vite solo con import dinámico dentro de la rama de desarrollo.
// ---------------------------------------------------------------------------------------------------------------
function checkServerEntry() {
  if (!config.serverEntry) return;
  const where = config.serverEntry;
  const s = read(path.join(root, where));
  if (s === null) return fail('server-entry', where, 'no existe (revisa serverEntry en claude-guard.config.json)');
  if (/^\s*import\s+[^;]*from\s+['"]vite['"]/m.test(s)) {
    fail('server-static-vite', where, 'import estático de vite: usa `await import(\'vite\')` dentro de la rama de desarrollo, para que la imagen de producción no lo necesite ni pueda arrancarlo');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 5) Ficheros del proyecto: variables públicas con secreto, SDK de IA en el frontend y .env versionados.
// ---------------------------------------------------------------------------------------------------------------
const startsWithAny = (f, list) => (list || []).some((d) => f === d || f.startsWith(d.endsWith('/') ? d : d + '/'));
function isFrontend(f) {
  if (startsWithAny(f, config.serverDirs)) return false;
  if (/\.(test|spec)\.[^.]+$/.test(f)) return false;
  if (startsWithAny(f, config.frontendDirs) && /\.(m?[jt]sx?|vue|svelte|astro)$/.test(f)) return true;
  return (config.frontendExtensions || []).some((ext) => f.endsWith(ext));
}

// Ficheros del proyecto: los versionados (si root es la raíz del repositorio) o un recorrido de la carpeta.
let fileListCache = null;
function projectFiles() {
  if (!fileListCache) {
    const tracked = gitFiles();
    const inRepoRoot = tracked !== null && fs.existsSync(path.join(root, '.git'));
    fileListCache = { tracked, inRepoRoot, files: inRepoRoot ? tracked : walk(root) };
  }
  return fileListCache;
}

// Avisos sobre el contenido de un fichero de código (no de pruebas ni de documentación).
function checkCodeFile(f, s) {
  if (/\.(?:py|[cm]?[jt]s)$/.test(f) && !isFrontend(f)) {
    const lines = s.split('\n');
    const norm = (v) => v.replace(/[-_]/g, '').toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('secret-scan: ignore') || /^\s*(?:#|\/\/|\*)/.test(line)) continue;
      const name = SECRET_NAME_IN_CODE.exec(line);
      if (!name) continue;
      const known = [...line.matchAll(/(["'`])([^"'`\n]*)\1/g)].some((q) => q.index > name.index && norm(q[2]) !== norm(name[0]) && KNOWN_DEFAULT_SECRET.test(q[2]));
      if (known) {
        warn('default-secret-value', f, `línea ${i + 1}: el secreto tiene un valor por defecto conocido (changeme, secret, dev-secret…). Si falta la variable de entorno, el servidor debe negarse a arrancar. Para silenciar un valor falso a propósito: \`secret-scan: ignore\``);
        break;
      }
    }
  }
  if (BROWSER_NO_SANDBOX_API.test(s)) warn('browser-sandbox-disabled', f, 'Playwright/Chromium con el sandbox desactivado (chromium_sandbox=False / chromiumSandbox: false): un exploit del renderizador comprometería el proceso y sus secretos. Déjalo activo y aísla el navegador si no puede');
  if (/\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/.test(f) && TOKEN_IN_BROWSER_STORAGE.test(s)) {
    warn('frontend-token-storage', f, 'guarda un token o sesión en localStorage/sessionStorage: cualquier XSS se lleva la sesión. Usa una cookie httpOnly (con Secure y SameSite) puesta por el servidor');
  }
}

function checkFiles(extra) {
  const { tracked, inRepoRoot, files: listed } = projectFiles();
  const files = new Set([...listed, ...extra]);
  for (const f of files) {
    if (isEnvFile(f)) {
      if (inRepoRoot && tracked.includes(f)) fail('env-tracked', f, 'fichero .env versionado: los secretos nunca van al repositorio (sácalo, añádelo a .gitignore y rota sus claves)');
      continue;
    }
    if (!TEXT_EXT.test(f) || /(^|\/)node_modules\/|(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f)) continue;
    const s = read(path.join(root, f));
    if (s === null || s.length > 2_000_000) continue;
    const allowed = startsWithAny(f, config.allowMention) || (config.allowMention || []).includes(f);
    if (!allowed) {
      const m = PUBLIC_SECRET_VAR.exec(s);
      if (m) fail('public-secret-var', f, `\`${m[0]}\`: las variables con prefijo público se incrustan en el navegador. Usa un nombre sin prefijo, leído solo en el servidor`);
      if (!isTestFile(f)) checkCodeFile(f, s);
    }
    if (isFrontend(f)) {
      if (AI_SDK.test(s)) fail('frontend-ai-sdk', f, 'SDK de IA en el frontend: la clave acabaría en el navegador. Las llamadas a IA van por el servidor');
      if (config.strictImportMetaEnv) {
        for (const mm of s.matchAll(/import\.meta\.env\.([A-Za-z0-9_]+)/g)) {
          if (!BROWSER_ENV_OK.has(mm[1])) fail('frontend-env', f, `\`import.meta.env.${mm[1]}\`: el frontend no lee variables de entorno propias (todo lo que lee es público)`);
        }
      }
    }
  }
}

// Modo acotado (--changed <fichero>, lo usa el hook tras cada edición): solo cuenta lo que causa ese fichero.
// Un fichero ajeno al proyecto no se comprueba. El modo completo (CI) no cambia.
const changedRel = changedArg ? rel(path.resolve(changedArg)) : null;
if (changedRel !== null && (!changedRel || changedRel.startsWith('..') || path.isAbsolute(changedRel))) process.exit(0);
const changedGroup = (() => {
  if (changedRel === null) return null;
  if ((config.dockerfiles || []).includes(changedRel) || changedRel === config.dockerignore || /(^|\/)[^/]*\.dockerignore$/.test(changedRel)) return 'docker';
  if ((config.viteConfigs || []).includes(changedRel)) return 'vite';
  if (config.serverEntry && changedRel === config.serverEntry) return 'server';
  return null;
})();
const groupOf = (rule) => (/^docker/.test(rule) ? 'docker' : /^vite-/.test(rule) ? 'vite' : /^server-/.test(rule) ? 'server' : null);
const causedByChanged = (p) => changedRel === null || p.where === changedRel || (changedGroup !== null && groupOf(p.rule) === changedGroup);

const extra = [...argv, ...(changedArg ? [changedArg] : [])]
  .map((p) => rel(path.resolve(p)))
  .filter((p) => p && !p.startsWith('..') && !path.isAbsolute(p));

const dockerUnits = [];
for (const f of config.dockerfiles || []) {
  const r = checkDockerfile(f);
  if (r) dockerUnits.push({ file: f, ...r });
}
if (dockerUnits.length) checkDockerContexts(dockerUnits);
checkProxy(dockerUnits);
checkViteConfig();
checkServerEntry();
checkFiles(extra);

const shownWarnings = warnings.filter(causedByChanged);
const shownProblems = problems.filter(causedByChanged);
if (shownWarnings.length) console.warn('⚠ claude-guard: avisos\n' + shownWarnings.map((w) => '  - ' + w.text).join('\n'));
if (shownProblems.length) {
  console.error(`✖ claude-guard · seguridad del despliegue: ${shownProblems.length} problema(s)\n` + shownProblems.map((p) => '  - ' + p.text).join('\n'));
  console.error('\nCorrige la causa; no relajes la regla. Catálogo y motivos: docs/reglas.md del repositorio claude-guard.');
  process.exit(1);
}
console.log('✔ claude-guard · seguridad del despliegue: sin servidor de desarrollo, sin secretos públicos ni .env en la imagen.');

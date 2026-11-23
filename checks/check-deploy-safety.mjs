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
const PUBLIC_SECRET_VAR = new RegExp(`\\b(?:${PUBLIC_PREFIXES.join('|')})[A-Z0-9_]*(?:${SECRET_WORDS})[A-Z0-9_]*\\b`);
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

  if (isNode && !/^\s*ENV\s+(?:[^\n]*\s)?NODE_ENV(?:=|\s+)["']?production["']?(?:\s|$)/m.test(code)) {
    fail('docker-node-env', where, 'falta `ENV NODE_ENV=production`: muchas apps (Express+Vite, Nuxt, etc.) arrancan el modo desarrollo sin él');
  }
  if (/NODE_ENV(?:=|\s+)["']?(development|dev)\b/.test(code)) fail('docker-node-env', where, 'NODE_ENV de desarrollo en la imagen');
  if (/\b(npm|yarn|pnpm|bun)\s+(run\s+)?dev\b|tsx\s+watch|\bnodemon\b|\bvite(\s+(dev|serve|preview))?\s*["'\]]|\bvite\s+(dev|serve|preview)\b|next\s+dev\b|ng\s+serve\b|react-scripts\s+start\b|nuxt\s+dev\b|astro\s+dev\b/.test(code)) {
    fail('docker-dev-server', where, 'arranca un servidor de desarrollo (npm run dev, vite, next dev, nodemon, tsx watch…): publica código y ficheros del contenedor');
  }
  const users = [...code.matchAll(/^\s*USER\s+(\S+)/gm)].map((m) => m[1]);
  const fromNonroot = /^\s*FROM\s+[^\n]*:nonroot\b/im.test(code);
  if (!fromNonroot && (!users.length || /^(root|0)(:|$)/.test(users[users.length - 1]))) {
    fail('docker-user', where, 'el contenedor corre como root: añade `USER node` (o un usuario sin privilegios) en la etapa final');
  }
  const secretEnv = new RegExp(`^\\s*(ENV|ARG)\\s+[A-Z0-9_]*(${SECRET_WORDS})[A-Z0-9_]*(?:=|\\s+)\\S`, 'm');
  if (secretEnv.test(code)) fail('docker-secret-env', where, 'un secreto en ENV/ARG queda grabado en las capas de la imagen: usa el gestor de secretos de la plataforma');
  if (/^\s*COPY\s+(--\S+\s+)*\.\s+\S+\s*$/m.test(code)) {
    (config.copyAllIsError ? fail : warn)('docker-copy-all', where, '`COPY . …` copia todo el contexto: confirma que el .dockerignore excluye secretos, .git y datos locales');
  }
  if (isNode && viteConfigPath && !/\b(npm|yarn|pnpm|bun)\s+(run\s+)?build\b|\bvite\s+build\b/.test(code)) {
    fail('docker-frontend-build', where, 'hay configuración de Vite pero la imagen no compila el frontend (`npm run build`): se acabaría sirviendo con el servidor de desarrollo');
  }
  if (isNode && !/npm\s+ci\b[^\n]*--(omit=dev|only=prod(uction)?|production)\b|npm\s+(install|i)\b[^\n]*--(omit=dev|production)\b|npm\s+prune\b[^\n]*--(omit=dev|production)|yarn\s+(install\b[^\n]*--production|workspaces\s+focus\b[^\n]*--production)|pnpm\s+(install\b[^\n]*--prod\b|deploy\b[^\n]*--prod\b)|NODE_ENV=production\s+npm\s+ci\b/.test(code)) {
    fail('docker-prod-deps', where, 'la imagen final debería instalar solo dependencias de producción (`npm ci --omit=dev` o equivalente): las devDependencies incluyen servidores de desarrollo');
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// 2) .dockerignore: secretos, historial y dependencias del host fuera de la imagen.
// ---------------------------------------------------------------------------------------------------------------
function checkDockerignore() {
  const where = config.dockerignore;
  const s = read(path.join(root, where));
  if (s === null) return fail('dockerignore-missing', where, 'no existe: todo el contexto (incluidos .env y .git) entraría en la imagen');
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

function checkFiles(extra) {
  const tracked = gitFiles();
  const inRepoRoot = tracked !== null && fs.existsSync(path.join(root, '.git'));
  const files = new Set([...(inRepoRoot ? tracked : walk(root)), ...extra]);
  for (const f of files) {
    if (isEnvFile(f)) {
      if (inRepoRoot && tracked.includes(f)) fail('env-tracked', f, 'fichero .env versionado: los secretos nunca van al repositorio (sácalo, añádelo a .gitignore y rota sus claves)');
      continue;
    }
    if (!TEXT_EXT.test(f) || /(^|\/)node_modules\/|(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f)) continue;
    const s = read(path.join(root, f));
    if (s === null || s.length > 2_000_000) continue;
    if (!startsWithAny(f, config.allowMention) && !(config.allowMention || []).includes(f)) {
      const m = PUBLIC_SECRET_VAR.exec(s);
      if (m) fail('public-secret-var', f, `\`${m[0]}\`: las variables con prefijo público se incrustan en el navegador. Usa un nombre sin prefijo, leído solo en el servidor`);
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
  if ((config.dockerfiles || []).includes(changedRel) || changedRel === config.dockerignore) return 'docker';
  if ((config.viteConfigs || []).includes(changedRel)) return 'vite';
  if (config.serverEntry && changedRel === config.serverEntry) return 'server';
  return null;
})();
const groupOf = (rule) => (/^docker/.test(rule) ? 'docker' : /^vite-/.test(rule) ? 'vite' : /^server-/.test(rule) ? 'server' : null);
const causedByChanged = (p) => changedRel === null || p.where === changedRel || (changedGroup !== null && groupOf(p.rule) === changedGroup);

const extra = [...argv, ...(changedArg ? [changedArg] : [])]
  .map((p) => rel(path.resolve(p)))
  .filter((p) => p && !p.startsWith('..') && !path.isAbsolute(p));

let anyDockerfile = false;
for (const f of config.dockerfiles || []) anyDockerfile = checkDockerfile(f) || anyDockerfile;
if (anyDockerfile) checkDockerignore();
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

// claude-guard · PreToolUse (Bash | PowerShell): frena los comandos que pueden romper lo que funciona,
// perder trabajo o exponer secretos. Exit 2 = bloqueado (el motivo le llega a Claude).
import { block, currentBranch, isEnvFile, loadConfig, projectDir, readInput, PUBLIC_BY_DESIGN, PUBLIC_PREFIXES, SECRET_WORDS } from './lib.mjs';

const input = readInput();
const cmd = String(input.tool_input?.command ?? '');
const dir = projectDir(input);
const config = loadConfig(dir);
const protectedBranches = (config.protectedBranches || []).filter(Boolean);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const branchAlt = protectedBranches.map(esc).join('|');

const publicSecretAssign = new RegExp(`\\b(?:${PUBLIC_PREFIXES.join('|')})(?!${PUBLIC_BY_DESIGN})\\w*(?:${SECRET_WORDS})\\w*\\s*=`, 'i');

const rules = [
  [/git\s+push\b[^\n]*(--force\b|\s-f\b|--force-with-lease|\s\+[^\s+])/, 'Push forzado prohibido (--force, -f o refspec con "+"): reescribe historia compartida. Abre un PR o crea una rama nueva.'],
  ...(branchAlt
    ? [[new RegExp(`git\\s+push\\b[^\\n]*\\s(?:\\S+\\s+)?(?:[^\\s:]*:)?(?:refs/heads/)?(?:${branchAlt})(?:\\s|$)`), `Push directo a una rama protegida (${protectedBranches.join(', ')}). El flujo es rama de trabajo → pull request.`]]
    : []),
  [/git\s+reset\s+--hard/, 'git reset --hard descarta trabajo sin posibilidad de recuperarlo. Crea una rama o un commit de trabajo antes (git stash es peligroso con varios agentes en paralelo: el índice se comparte).'],
  [/git\s+clean\s+-[a-z]*f/, 'git clean -f borra ficheros sin seguimiento de forma irreversible.'],
  [/--no-verify\b|--no-gpg-sign\b/, 'No se saltan hooks ni firmas. Si un hook falla, arregla la causa.'],
  [/\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\.|\*|\.git|src\/?)(\s|$)/, 'Borrado recursivo de una ruta raíz bloqueado.'],
  [/npm\s+audit\s+fix\s+--force/, 'npm audit fix --force mete versiones mayores sin control. Actualiza la dependencia a mano y pasa los tests.'],
  [/\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i, 'Sentencia SQL destructiva: las migraciones deben ser aditivas e idempotentes.'],
  [/\bprintenv\b|(^|[;&|]\s*)env\s*($|\||;)|\benv\s*\|\s*(grep|findstr|sort)|\bset\s*\|\s*findstr|Get-ChildItem\s+env:|\bgci\s+env:|\/proc\/self\/environ/i, 'No se vuelcan variables de entorno: pueden contener claves.'],
  [/\bgcloud\s+secrets\s+versions\s+access\b/i, 'No se leen valores de secretos de Secret Manager (gcloud secrets versions access): acabarían en la conversación.'],
  [/\bgcloud\s+auth\s+(?:application-default\s+)?print-(?:access|identity)-token\b/i, 'No se imprimen tokens de acceso o de identidad (gcloud auth print-…-token): son credenciales vivas.'],
  [/\baws\s+secretsmanager\s+get-secret-value\b/i, 'No se leen valores de secretos de AWS (aws secretsmanager get-secret-value).'],
  [/\baz\s+keyvault\s+secret\s+show\b/i, 'No se leen valores de secretos de Azure Key Vault (az keyvault secret show).'],
  [/\bkubectl(?:\s+--?[\w-]+(?:[= ]\S+)?)*\s+get\s+secrets?\b[^\n|;&]*(?:-o\s*=?\s*|--output(?:=|\s+))(?:yaml|json|jsonpath|go-template)/i, 'No se vuelcan secretos de Kubernetes (kubectl get secret -o yaml/json): sus valores van en base64, no cifrados.'],
  [publicSecretAssign, 'Una variable con prefijo público (VITE_, NEXT_PUBLIC_, REACT_APP_, EXPO_PUBLIC_, PUBLIC_…) y nombre de secreto acaba en el navegador. Usa un nombre sin prefijo, leído solo en el servidor.'],
  [/\b(ngrok|cloudflared\s+tunnel|localtunnel|lt\s+--port|serveo\.net|tailscale\s+funnel|localhost\.run)\b/i, 'No se expone un servidor de desarrollo a Internet: publica el código fuente, el .env y las claves.'],
  [/docker\s+(build|run)\b[^\n]*(NODE_ENV=(development|dev)\b|npm\s+run\s+dev\b|\bvite\b(?!\s+build)|next\s+dev\b)/i, 'Imagen o contenedor con el servidor de desarrollo: la imagen solo arranca en modo producción (NODE_ENV=production, frontend compilado).'],
];

// Lectores de ficheros (bash, cmd y PowerShell) sobre un fichero .env, .env_prod, .env-staging, prod.env…
const READERS = new Set(['cat', 'type', 'get-content', 'gc', 'less', 'more', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'bat', 'nl', 'strings', 'xxd', 'od', 'select-string', 'sls', 'findstr']);
// grep/rg/sls/findstr: el primer argumento sin opción es el patrón de búsqueda, no un fichero.
const PATTERN_READERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'select-string', 'sls', 'findstr']);
// Opciones con valor que no son el patrón ni un fichero (para no confundirlas con el primer argumento posicional).
const VALUED_SHORT = { grep: 'ABCmdD', egrep: 'ABCmdD', fgrep: 'ABCmdD', rg: 'ABCmgtTMjdrE' };
const VALUED_LONG = /^--(?:max-count|context|after-context|before-context|include|exclude|exclude-dir|glob|type|type-not|max-filesize|threads|replace|color|colour|directories|devices)$/;
const VALUED_PS = new Set(['path', 'literalpath', 'context', 'encoding', 'include', 'exclude']);

// Trocea el comando respetando comillas; | ; & saltos de línea, paréntesis y comillas invertidas separan comandos.
function segments(command) {
  const segs = [[]];
  let tok = null;
  let q = null;
  const push = () => {
    if (tok !== null) segs[segs.length - 1].push(tok);
    tok = null;
  };
  const cut = () => {
    push();
    if (segs[segs.length - 1].length) segs.push([]);
  };
  for (const ch of command) {
    if (q) {
      if (ch === q) q = null;
      else tok += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      tok ??= '';
    } else if (ch === '\n' || '|;&()`'.includes(ch)) cut();
    else if (/\s/.test(ch)) push();
    else tok = (tok ?? '') + ch;
  }
  push();
  return segs.filter((x) => x.length);
}

const baseName = (t) => t.replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '').toLowerCase();

// Índices (de `rest`) del patrón de búsqueda y de los valores de -e/--regexp/-Pattern//c:, que no son ficheros.
function patternSlots(name, rest) {
  const skip = new Set();
  const positional = [];
  let explicit = false;
  const ps = name === 'sls' || name === 'select-string';
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (name === 'findstr') {
      if (/^\/c:/i.test(t)) {
        explicit = true;
        skip.add(i);
      } else if (/^\/g:/i.test(t)) explicit = true;
      else if (!/^\/[a-z](:|$)/i.test(t)) positional.push(i);
    } else if (ps) {
      const m = /^-([a-z]+)(:.*)?$/i.exec(t);
      if (m && m[1].toLowerCase() === 'pattern') {
        explicit = true;
        if (m[2]) skip.add(i);
        else if (i + 1 < rest.length) skip.add(++i);
      } else if (m) {
        if (!m[2] && VALUED_PS.has(m[1].toLowerCase())) i++;
      } else positional.push(i);
    } else if (t === '--') {
      for (let j = i + 1; j < rest.length; j++) positional.push(j);
      break;
    } else if (t.startsWith('--')) {
      if (/^--regexp(=|$)/.test(t)) {
        explicit = true;
        if (t.includes('=')) skip.add(i);
        else if (i + 1 < rest.length) skip.add(++i);
      } else if (/^--file(=|$)/.test(t)) explicit = true;
      else if (!t.includes('=') && VALUED_LONG.test(t)) i++;
    } else if (/^-[^-]/.test(t)) {
      for (let c = 1; c < t.length; c++) {
        const ch = t[c];
        const valued = ch === 'e' || ch === 'f' || (VALUED_SHORT[name] || '').includes(ch);
        if (!valued) continue;
        if (ch === 'e' || ch === 'f') explicit = true;
        const inline = c + 1 < t.length;
        if (ch === 'e') {
          if (inline) skip.add(i);
          else if (i + 1 < rest.length) skip.add(++i);
        } else if (!inline) i++;
        break;
      }
    } else positional.push(i);
  }
  if (!explicit && positional.length) skip.add(positional[0]);
  return skip;
}

function readsEnvFile(command, depth = 0) {
  for (const seg of segments(command)) {
    const idx = seg.findIndex((t) => READERS.has(baseName(t)));
    const name = idx >= 0 ? baseName(seg[idx]) : '';
    const skip = PATTERN_READERS.has(name) ? patternSlots(name, seg.slice(idx + 1)) : new Set();
    for (let i = 0; i < seg.length; i++) {
      const t = seg[i];
      if (idx >= 0 && i > idx && skip.has(i - idx - 1)) continue;
      // Un argumento entre comillas con varias palabras puede ser otro comando (bash -c "<comando>").
      if (/[\s|;&]/.test(t) && depth < 3 && readsEnvFile(t, depth + 1)) return true;
      if (idx >= 0 && i > idx && t.split(/[=,<>]+/).some((x) => x && isEnvFile(x, config.envTemplates))) return true;
    }
  }
  return false;
}
if (readsEnvFile(cmd)) block(`⛔ claude-guard (guard-bash): No se leen ficheros .env: contienen secretos. Usa .env.example como referencia.
Comando: ${cmd}`);

// Lectura de variables de entorno con nombre de secreto (PowerShell, .NET, Python, bash) o volcado completo.
const SECRET_NAME = '[A-Za-z0-9_]*(?:' + SECRET_WORDS + ')[A-Za-z0-9_]*';
const envReadRules = [
  // PowerShell: $env:OPENAI_API_KEY y la forma con llaves. Se permite $env:PATH, $env:NODE_ENV, $env:PWD y las asignaciones.
  [new RegExp('\\$\\{?env:(?!(?:OLD)?PWD\\b)' + SECRET_NAME + '(?![A-Za-z0-9_])\\}?(?!\\s*[-+*/]?=(?!=))', 'i'), 'No se lee una variable de entorno con nombre de secreto ($env:…): su valor acabaría en la conversación.'],
  // Get-Item Env:X, Get-ChildItem/dir/ls env: (volcado completo o variable con nombre de secreto).
  [new RegExp('\\b(?:Get-ChildItem|gci|dir|ls|Get-Item|gi|Get-Content|gc)\\s+(?:-(?:Literal)?Path\\s+)?["\']?env:(?:\\*?["\']?(?:\\s|$|[|;&)])|' + SECRET_NAME + ')', 'i'), 'No se vuelcan ni se leen variables de entorno con nombre de secreto (Get-Item/dir/ls env:).'],
  // .NET: [Environment]::GetEnvironmentVariables() siempre; GetEnvironmentVariable(...) con nombre de secreto o no literal.
  [/\[Environment\]::GetEnvironmentVariables\s*\(/i, 'No se vuelcan todas las variables de entorno ([Environment]::GetEnvironmentVariables).'],
  [new RegExp('\\[Environment\\]::GetEnvironmentVariable\\s*\\(\\s*(?:["\'][^"\']*(?:' + SECRET_WORDS + ')[^"\']*["\']|(?!["\']))', 'i'), 'No se lee una variable de entorno con nombre de secreto ([Environment]::GetEnvironmentVariable).'],
  // bash: echo con una variable con nombre de secreto (solo nombres en mayúsculas; $PWD queda fuera).
  [new RegExp('\\b(?:echo|printf|print)\\b[^\\n|;&]*\\$\\{?(?!(?:OLD)?PWD\\b)' + SECRET_NAME.replace(/\[A-Za-z0-9_\]/g, '[A-Z0-9_]')), 'No se imprime una variable de entorno con nombre de secreto (echo $…KEY/SECRET/TOKEN…).'],
  // cmd / bash: "set" sin argumentos vuelca todas las variables.
  [/(?:^|[;&|\n]\s*|\bcmd(?:\.exe)?\s+\/[ck]\s+)set\s*(?:$|[;&|\n])/i, 'No se vuelcan variables de entorno: "set" sin argumentos las lista todas.'],
];
for (const [re, reason] of envReadRules) {
  if (re.test(cmd)) block(`⛔ claude-guard (guard-bash): ${reason}\nComando: ${cmd}`);
}

// Python: python -c con os.environ / os.getenv impreso o volcado. Se permite leer una clave literal que no sea secreta.
function dumpsPythonEnv(command) {
  if (!/\b(?:python[\d.]*|py)(?:\.exe)?\s+(?:-[\w-]+\s+)*-c\b/i.test(command)) return false;
  const rest = command
    .replace(new RegExp('os\\.environ\\s*\\[\\s*(["\'])(?![^"\']*(?:' + SECRET_WORDS + '))[^"\']*\\1\\s*\\]', 'gi'), '')
    .replace(new RegExp('os\\.(?:environ\\.get|getenv)\\s*\\(\\s*(["\'])(?![^"\']*(?:' + SECRET_WORDS + '))[^"\']*\\1[^)]*\\)', 'gi'), '');
  return /os\.(?:environ|getenv)/.test(rest) && /\b(?:print|pprint|dump|dumps|json)\b/.test(rest);
}
if (dumpsPythonEnv(cmd)) block(`⛔ claude-guard (guard-bash): python -c que imprime os.environ/os.getenv: puede volcar claves. Lee solo variables concretas que no sean secretas.\nComando: ${cmd}`);

for (const [re, reason] of rules) {
  if (re.test(cmd)) block(`⛔ claude-guard (guard-bash): ${reason}\nComando: ${cmd}`);
}

if (/git\s+commit\b/.test(cmd) && protectedBranches.length) {
  const branch = currentBranch(dir);
  if (protectedBranches.includes(branch)) {
    block(`⛔ claude-guard (guard-bash): estás en "${branch}", una rama protegida. Crea antes una rama de trabajo (git checkout -b feature/descripcion).`);
  }
}
process.exit(0);

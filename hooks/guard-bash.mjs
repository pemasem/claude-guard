// claude-guard · PreToolUse (Bash | PowerShell): frena los comandos que pueden romper lo que funciona,
// perder trabajo o exponer secretos. Exit 2 = bloqueado (el motivo le llega a Claude).
import { block, currentBranch, isEnvFile, loadConfig, projectDir, readInput, PUBLIC_PREFIXES, SECRET_WORDS } from './lib.mjs';

const input = readInput();
const cmd = String(input.tool_input?.command ?? '');
const dir = projectDir(input);
const config = loadConfig(dir);
const protectedBranches = (config.protectedBranches || []).filter(Boolean);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const branchAlt = protectedBranches.map(esc).join('|');

const publicSecretAssign = new RegExp(`\\b(?:${PUBLIC_PREFIXES.join('|')})\\w*(?:${SECRET_WORDS})\\w*\\s*=`, 'i');

const rules = [
  [/git\s+push\b[^\n]*(--force\b|\s-f\b|--force-with-lease|\s\+[^\s+])/, 'Push forzado prohibido (--force, -f o refspec con "+"): reescribe historia compartida. Abre un PR o crea una rama nueva.'],
  ...(branchAlt
    ? [[new RegExp(`git\\s+push\\b[^\\n]*\\s(?:\\S+\\s+)?(?:[^\\s:]*:)?(?:refs/heads/)?(?:${branchAlt})(?:\\s|$)`), `Push directo a una rama protegida (${protectedBranches.join(', ')}). El flujo es rama de trabajo → pull request.`]]
    : []),
  [/git\s+reset\s+--hard/, 'git reset --hard descarta trabajo sin posibilidad de recuperarlo. Usa git stash o una rama.'],
  [/git\s+clean\s+-[a-z]*f/, 'git clean -f borra ficheros sin seguimiento de forma irreversible.'],
  [/--no-verify\b|--no-gpg-sign\b/, 'No se saltan hooks ni firmas. Si un hook falla, arregla la causa.'],
  [/\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\.|\*|\.git|src\/?)(\s|$)/, 'Borrado recursivo de una ruta raíz bloqueado.'],
  [/npm\s+audit\s+fix\s+--force/, 'npm audit fix --force mete versiones mayores sin control. Actualiza la dependencia a mano y pasa los tests.'],
  [/\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i, 'Sentencia SQL destructiva: las migraciones deben ser aditivas e idempotentes.'],
  [/\bprintenv\b|(^|[;&|]\s*)env\s*($|\||;)|\benv\s*\|\s*(grep|findstr|sort)|\bset\s*\|\s*findstr|Get-ChildItem\s+env:|\bgci\s+env:|\/proc\/self\/environ/i, 'No se vuelcan variables de entorno: pueden contener claves.'],
  [publicSecretAssign, 'Una variable con prefijo público (VITE_, NEXT_PUBLIC_, REACT_APP_, EXPO_PUBLIC_, PUBLIC_…) y nombre de secreto acaba en el navegador. Usa un nombre sin prefijo, leído solo en el servidor.'],
  [/\b(ngrok|cloudflared\s+tunnel|localtunnel|lt\s+--port|serveo\.net|tailscale\s+funnel|localhost\.run)\b/i, 'No se expone un servidor de desarrollo a Internet: publica el código fuente, el .env y las claves.'],
  [/docker\s+(build|run)\b[^\n]*(NODE_ENV=(development|dev)\b|npm\s+run\s+dev\b|\bvite\b(?!\s+build)|next\s+dev\b)/i, 'Imagen o contenedor con el servidor de desarrollo: la imagen solo arranca en modo producción (NODE_ENV=production, frontend compilado).'],
];

// Lectores de ficheros (bash, cmd y PowerShell) sobre un fichero .env, .env_prod, .env-staging, prod.env…
const READERS = /\b(cat|type|Get-Content|gc|less|more|head|tail|grep|rg|sed|awk|bat|nl|strings|xxd|od|Select-String|sls|findstr)\b/i;
function readsEnvFile(command) {
  for (const seg of command.split(/[|;&\n]/)) {
    const m = READERS.exec(seg);
    if (!m) continue;
    for (const tok of seg.slice(m.index + m[0].length).split(/[\s"'`=,()]+/)) {
      if (tok && isEnvFile(tok, config.envTemplates)) return true;
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

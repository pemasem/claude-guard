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
  [/git\s+push\b[^\n]*(--force\b|\s-f\b|--force-with-lease)/, 'Push forzado prohibido: reescribe historia compartida. Abre un PR o crea una rama nueva.'],
  ...(branchAlt
    ? [[new RegExp(`git\\s+push\\b[^\\n]*\\s(?:\\S+\\s+)?(?:HEAD:)?(?:${branchAlt})(?:\\s|$)`), `Push directo a una rama protegida (${protectedBranches.join(', ')}). El flujo es rama de trabajo → pull request.`]]
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

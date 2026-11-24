#!/usr/bin/env node
// claude-guard · instalador (Node 18+, sin dependencias, Windows/macOS/Linux).
//
//   node install.mjs <proyecto> [--dry-run] [--claude-md] [--ci github|bitbucket]
//   node install.mjs uninstall <proyecto> [--dry-run]
//
// Instala:
//   <proyecto>/.claude/hooks/claude-guard/*.mjs   hooks de Claude Code
//   <proyecto>/.claude-guard/*.mjs                comprobadores (también para CI)
//   <proyecto>/.claude/settings.json              entradas de hooks y denegaciones (fusión idempotente, con copia previa)
//   <proyecto>/claude-guard.config.json           configuración por defecto (solo si no existe)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version;
const MARK_START = '<!-- claude-guard:start -->';
const MARK_END = '<!-- claude-guard:end -->';
const HOOK_FILES = ['lib.mjs', 'guard-bash.mjs', 'protect-files.mjs', 'post-edit.mjs'];
const CHECK_FILES = ['check-deploy-safety.mjs', 'scan-secrets.mjs'];
const cmdFor = (f) => `node "$CLAUDE_PROJECT_DIR/.claude/hooks/claude-guard/${f}"`;
const HOOKS = [
  { event: 'PreToolUse', matcher: 'Bash|PowerShell', file: 'guard-bash.mjs', timeout: 10 },
  { event: 'PreToolUse', matcher: 'Read|Edit|Write|MultiEdit|NotebookEdit', file: 'protect-files.mjs', timeout: 10 },
  { event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit', file: 'post-edit.mjs', timeout: 30 },
];
const DENY = ['Read(**/.env)', 'Read(**/.env.*)', 'Edit(**/.env)', 'Edit(**/.env.*)', 'Read(**/.env_*)', 'Read(**/.env-*)', 'Read(**/*.env)', 'Edit(**/.env_*)', 'Edit(**/.env-*)', 'Edit(**/*.env)', 'Bash(git push --force*)', 'Bash(git push -f*)', 'Bash(npm audit fix --force*)'];
const DEFAULT_CONFIG = {
  _info: 'claude-guard: ajusta las rutas a tu proyecto. "disable" solo con una razón documentada aquí. Ver README de claude-guard.',
  protectedBranches: ['main', 'master', 'develop'],
  envTemplates: [],
  secretScanAllow: [],
  dockerfiles: ['Dockerfile'],
  dockerignore: '.dockerignore',
  viteConfigs: ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts'],
  frontendDirs: ['src/components', 'src/pages', 'src/views', 'src/hooks', 'src/services', 'components', 'client', 'frontend'],
  serverDirs: ['server', 'api', 'backend', 'functions', 'src/server', 'src/api', 'app/api', 'src/app/api', 'pages/api', 'src/pages/api', 'scripts'],
  serverEntry: null,
  allowMention: ['docs/', 'test/', 'tests/', '__tests__/', '.claude-guard/', '.claude/hooks/claude-guard/', 'CHANGELOG.md', 'claude-guard.config.json'],
  strictImportMetaEnv: false,
  copyAllIsError: false,
  disable: [],
};

// ------------------------------------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const optVal = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const dry = flag('--dry-run');
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--ci');
const uninstall = positional[0] === 'uninstall';
const target = path.resolve(uninstall ? positional[1] || '.' : positional[0] || '.');
const log = (m) => console.log((dry ? '[dry-run] ' : '') + m);

if (flag('--help') || flag('-h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}
if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
  console.error(`✖ No existe el directorio del proyecto: ${target}`);
  process.exit(1);
}

function write(p, content) {
  log(`escribe ${path.relative(target, p) || p}`);
  if (dry) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
function remove(p) {
  if (!fs.existsSync(p)) return;
  log(`elimina ${path.relative(target, p)}`);
  if (!dry) fs.rmSync(p, { recursive: true, force: true });
}
function readJson(p) {
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`✖ ${p} no es JSON válido (${e.message}). Corrígelo antes de instalar.`);
    process.exit(1);
  }
}
function saveSettings(p, before, after) {
  const text = JSON.stringify(after, null, 2) + '\n';
  if (before !== null && JSON.stringify(before) === JSON.stringify(after)) {
    log('settings.json ya estaba al día');
    return;
  }
  if (before !== null && !dry) {
    const backup = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(p, backup);
    log(`copia de seguridad: ${path.relative(target, backup)}`);
  }
  write(p, text);
}
const isOurs = (h) => typeof h?.command === 'string' && h.command.includes('.claude/hooks/claude-guard/');

// ------------------------------------------------------------------------------------------------
function mergeSettings(settings) {
  const s = structuredClone(settings || {});
  s.hooks ||= {};
  for (const { event, matcher, file, timeout } of HOOKS) {
    s.hooks[event] ||= [];
    const already = s.hooks[event].some((entry) => (entry.hooks || []).some((h) => isOurs(h) && h.command.endsWith(`${file}"`)));
    if (!already) s.hooks[event].push({ matcher, hooks: [{ type: 'command', command: cmdFor(file), timeout }] });
  }
  s.permissions ||= {};
  s.permissions.deny ||= [];
  for (const d of DENY) if (!s.permissions.deny.includes(d)) s.permissions.deny.push(d);
  return s;
}

function unmergeSettings(settings) {
  const s = structuredClone(settings || {});
  for (const event of Object.keys(s.hooks || {})) {
    s.hooks[event] = s.hooks[event]
      .map((entry) => ({ ...entry, hooks: (entry.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((entry) => entry.hooks.length > 0);
    if (!s.hooks[event].length) delete s.hooks[event];
  }
  if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
  if (s.permissions?.deny) {
    s.permissions.deny = s.permissions.deny.filter((d) => !DENY.includes(d));
    if (!s.permissions.deny.length) delete s.permissions.deny;
    if (!Object.keys(s.permissions).length) delete s.permissions;
  }
  return s;
}

function claudeMdBlock() {
  const rules = fs.readFileSync(path.join(PKG, 'templates', 'CLAUDE.section.md'), 'utf8').trim();
  return `${MARK_START}\n${rules}\n${MARK_END}`;
}

function updateClaudeMd(add) {
  const p = path.join(target, 'CLAUDE.md');
  const current = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  const re = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`);
  let next;
  if (add) {
    next = re.test(current) ? current.replace(re, claudeMdBlock()) : (current.trimEnd() ? current.trimEnd() + '\n\n' : '') + claudeMdBlock() + '\n';
  } else {
    if (!re.test(current)) return;
    next = current.replace(re, '').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }
  if (next !== current) write(p, next);
  else log('CLAUDE.md ya estaba al día');
}

function installCi(kind) {
  if (kind === 'github') {
    const dest = path.join(target, '.github', 'workflows', 'claude-guard.yml');
    if (fs.existsSync(dest)) return log('.github/workflows/claude-guard.yml ya existe: no se toca');
    write(dest, fs.readFileSync(path.join(PKG, 'ci', 'github-actions.yml'), 'utf8'));
  } else if (kind === 'bitbucket') {
    const snippet = fs.readFileSync(path.join(PKG, 'ci', 'bitbucket-pipelines.yml'), 'utf8');
    write(path.join(target, '.claude-guard', 'bitbucket-pipelines.snippet.yml'), snippet);
    console.log('\nAñade este paso a tu bitbucket-pipelines.yml (no se fusiona automáticamente):\n\n' + snippet);
  } else {
    console.error('✖ --ci admite "github" o "bitbucket"');
    process.exit(1);
  }
}

// ------------------------------------------------------------------------------------------------
const settingsPath = path.join(target, '.claude', 'settings.json');

if (uninstall) {
  remove(path.join(target, '.claude', 'hooks', 'claude-guard'));
  for (const f of [...CHECK_FILES, 'VERSION']) remove(path.join(target, '.claude-guard', f));
  const before = readJson(settingsPath);
  if (before) saveSettings(settingsPath, before, unmergeSettings(before));
  updateClaudeMd(false);
  console.log(`\n✔ claude-guard desinstalado de ${target}. claude-guard.config.json se conserva (bórralo a mano si quieres).`);
  process.exit(0);
}

for (const f of HOOK_FILES) write(path.join(target, '.claude', 'hooks', 'claude-guard', f), fs.readFileSync(path.join(PKG, 'hooks', f), 'utf8'));
for (const f of CHECK_FILES) write(path.join(target, '.claude-guard', f), fs.readFileSync(path.join(PKG, 'checks', f), 'utf8'));
write(path.join(target, '.claude-guard', 'VERSION'), VERSION + '\n');

const before = readJson(settingsPath);
saveSettings(settingsPath, before, mergeSettings(before));

const configPath = path.join(target, 'claude-guard.config.json');
if (!fs.existsSync(configPath)) write(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
else log('claude-guard.config.json ya existe: se conserva');

if (flag('--claude-md')) updateClaudeMd(true);
const ci = optVal('--ci');
if (ci) installCi(ci);

console.log(`
✔ claude-guard ${VERSION} instalado en ${target}
  Comprueba el proyecto ahora:   node .claude-guard/check-deploy-safety.mjs && node .claude-guard/scan-secrets.mjs
  Ajusta las rutas en claude-guard.config.json y versiona .claude/, .claude-guard/ y el config.
  Reinicia Claude Code (o abre /hooks) para cargar los hooks.`);

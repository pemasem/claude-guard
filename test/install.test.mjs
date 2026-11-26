import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PKG, git, put, run, tmpDir } from './helpers.mjs';

const installer = path.join(PKG, 'install.mjs');
const settingsOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
const ourHooks = (s) =>
  Object.values(s.hooks || {})
    .flat()
    .flatMap((e) => e.hooks || [])
    .filter((h) => h.command.includes('.claude/hooks/claude-guard/'));

test('instala en un proyecto vacío', () => {
  const dir = tmpDir();
  const r = run(installer, [dir]);
  assert.equal(r.status, 0, r.out);
  for (const f of ['lib.mjs', 'guard-bash.mjs', 'protect-files.mjs', 'post-edit.mjs']) assert.ok(fs.existsSync(path.join(dir, '.claude', 'hooks', 'claude-guard', f)), f);
  for (const f of ['check-deploy-safety.mjs', 'scan-secrets.mjs', 'VERSION']) assert.ok(fs.existsSync(path.join(dir, '.claude-guard', f)), f);
  assert.ok(fs.existsSync(path.join(dir, 'claude-guard.config.json')));
  assert.equal(ourHooks(settingsOf(dir)).length, 3);
  assert.ok(settingsOf(dir).permissions.deny.includes('Read(**/.env)'));
});

test('es idempotente y conserva lo que ya había en settings.json, con copia de seguridad', () => {
  const dir = tmpDir();
  const existing = {
    model: 'x',
    permissions: { allow: ['Bash(npm test*)'], deny: ['Read(**/.env)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node mio.mjs' }] }] },
  };
  put(dir, '.claude/settings.json', JSON.stringify(existing, null, 2));
  assert.equal(run(installer, [dir]).status, 0);
  const once = settingsOf(dir);
  assert.equal(run(installer, [dir]).status, 0);
  const twice = settingsOf(dir);
  assert.deepEqual(twice, once);
  assert.equal(ourHooks(twice).length, 3);
  assert.equal(twice.model, 'x');
  assert.deepEqual(twice.permissions.allow, ['Bash(npm test*)']);
  assert.equal(twice.permissions.deny.filter((d) => d === 'Read(**/.env)').length, 1);
  assert.ok(twice.hooks.PreToolUse.some((e) => e.hooks.some((h) => h.command === 'node mio.mjs')));
  const backups = fs.readdirSync(path.join(dir, '.claude')).filter((f) => f.startsWith('settings.json.bak-'));
  assert.equal(backups.length, 1, 'solo se copia cuando cambia');
});

test('no pisa una configuración existente', () => {
  const dir = tmpDir();
  put(dir, 'claude-guard.config.json', '{"protectedBranches":["trunk"]}');
  run(installer, [dir]);
  assert.equal(fs.readFileSync(path.join(dir, 'claude-guard.config.json'), 'utf8'), '{"protectedBranches":["trunk"]}');
});

test('--claude-md añade la sección una sola vez y uninstall la quita', () => {
  const dir = tmpDir();
  put(dir, 'CLAUDE.md', '# Mi proyecto\n\nReglas propias.\n');
  run(installer, [dir, '--claude-md']);
  run(installer, [dir, '--claude-md']);
  const md = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.equal(md.split('<!-- claude-guard:start -->').length - 1, 1);
  assert.match(md, /Reglas propias/);
  run(installer, ['uninstall', dir]);
  const after = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.doesNotMatch(after, /claude-guard:start/);
  assert.match(after, /Reglas propias/);
});

test('uninstall quita solo lo de claude-guard', () => {
  const dir = tmpDir();
  put(dir, '.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node stop.mjs' }] }] }, permissions: { deny: ['Bash(rm *)'] } }));
  run(installer, [dir]);
  const r = run(installer, ['uninstall', dir]);
  assert.equal(r.status, 0, r.out);
  const s = settingsOf(dir);
  assert.equal(ourHooks(s).length, 0);
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'node stop.mjs');
  assert.deepEqual(s.permissions.deny, ['Bash(rm *)']);
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'hooks', 'claude-guard')));
  assert.ok(fs.existsSync(path.join(dir, 'claude-guard.config.json')), 'el config se conserva');
});

test('--dry-run no escribe nada', () => {
  const dir = tmpDir();
  const r = run(installer, [dir, '--dry-run', '--claude-md', '--ci', 'github']);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('--ci github crea el workflow y --ci bitbucket deja el fragmento', () => {
  const dir = tmpDir();
  run(installer, [dir, '--ci', 'github']);
  assert.ok(fs.existsSync(path.join(dir, '.github', 'workflows', 'claude-guard.yml')));
  const r = run(installer, [dir, '--ci', 'bitbucket']);
  assert.match(r.stdout, /check-deploy-safety/);
  assert.ok(fs.existsSync(path.join(dir, '.claude-guard', 'bitbucket-pipelines.snippet.yml')));
});

test('el proyecto instalado se puede comprobar con el comprobador copiado', () => {
  const dir = tmpDir();
  run(installer, [dir]);
  const r = run(path.join(dir, '.claude-guard', 'check-deploy-safety.mjs'), []);
  assert.equal(r.status, 0, r.out);
});

test('el instalador deniega los .env reales y no las plantillas', () => {
  const dir = tmpDir();
  run(installer, [dir]);
  const deny = settingsOf(dir).permissions.deny;
  for (const d of ['Read(**/.env)', 'Read(**/.env.local)', 'Edit(**/.env.production)', 'Read(**/*.env)']) assert.ok(deny.includes(d), d);
  // Las reglas de permisos no admiten excepciones: ningún comodín puede casar con una plantilla.
  for (const d of deny) {
    const m = /^(?:Read|Edit)\(\*\*\/(.+)\)$/.exec(d);
    if (!m) continue;
    const re = new RegExp('^' + m[1].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    for (const t of ['.env.example', '.env_example', '.env-example', '.env.sample', '.env.template']) assert.ok(!re.test(t), `${d} bloquea ${t}`);
  }
});

test('al reinstalar retira los comodines antiguos que bloqueaban las plantillas y conserva el resto', () => {
  const dir = tmpDir();
  put(dir, '.claude/settings.json', JSON.stringify({ permissions: { deny: ['Bash(rm *)', 'Read(**/.env.*)', 'Edit(**/.env.*)', 'Read(**/.env_*)', 'Edit(**/.env-*)'] } }));
  const r = run(installer, [dir]);
  assert.equal(r.status, 0, r.out);
  const deny = settingsOf(dir).permissions.deny;
  for (const d of ['Read(**/.env.*)', 'Edit(**/.env.*)', 'Read(**/.env_*)', 'Edit(**/.env-*)']) assert.ok(!deny.includes(d), d);
  assert.ok(deny.includes('Bash(rm *)'));
  assert.ok(deny.includes('Read(**/.env.local)'));
  assert.match(r.out, /retira denegaciones antiguas/);
  run(installer, ['uninstall', dir]);
  assert.deepEqual(settingsOf(dir).permissions.deny, ['Bash(rm *)']);
});

test('la sección de CLAUDE.md incluye las reglas de comportamiento y deja la de no relajar reglas la última', () => {
  const dir = tmpDir();
  run(installer, [dir, '--claude-md']);
  const md = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  const numbers = [...md.matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  for (const re of [/SSRF/, /relative_to\(base\)/, /delimitado y marcado como datos/, /--no-sandbox/]) assert.match(md, re);
  const last = md.split('\n').filter((l) => /^\d+\. /.test(l)).pop();
  assert.match(last, /^9\. \*\*Ninguna regla de claude-guard se relaja/);
});

test('CI: el paso opcional de auditoría de dependencias es un script válido y no rompe sin lockfiles ni pip-audit', () => {
  // Saca el bloque `run: |` / `- |` (indentación común quitada) de cada plantilla.
  const block = (file, marker) => {
    const lines = fs.readFileSync(path.join(PKG, 'ci', file), 'utf8').split('\n');
    const start = lines.findIndex((l) => l.trim() === marker) + 1;
    assert.ok(start > 0, `${file}: falta ${marker}`);
    const indent = /^\s*/.exec(lines[start])[0].length;
    const out = [];
    for (let i = start; i < lines.length && (!lines[i].trim() || /^\s*/.exec(lines[i])[0].length >= indent); i++) out.push(lines[i].slice(indent));
    return out.join('\n');
  };
  for (const [file, marker] of [['github-actions.yml', 'run: |'], ['bitbucket-pipelines.yml', '- |']]) {
    const script = block(file, marker);
    assert.match(script, /npm audit --omit=dev --audit-level=high/, file);
    assert.match(script, /pip-audit/, file);
    const dir = tmpDir();
    put(dir, 'audit.sh', script + '\n');
    git(dir, 'init', '-q');
    assert.equal(spawnSync('bash', ['-n', path.join(dir, 'audit.sh')], { encoding: 'utf8' }).status, 0, `${file}: bash -n`);
    // Repositorio sin package-lock.json ni requirements: no hay nada que auditar y no falla.
    const r = spawnSync('bash', [path.join(dir, 'audit.sh')], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `${file}: ${r.stdout}${r.stderr}`);
  }
});

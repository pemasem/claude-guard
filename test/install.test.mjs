import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PKG, put, run, tmpDir } from './helpers.mjs';

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

test('el instalador deniega también .env_* y .env-*', () => {
  const dir = tmpDir();
  run(path.join(PKG, 'install.mjs'), [dir]);
  const deny = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8')).permissions.deny;
  for (const d of ['Read(**/.env_*)', 'Read(**/.env-*)', 'Edit(**/.env_*)', 'Read(**/*.env)']) assert.ok(deny.includes(d), d);
});

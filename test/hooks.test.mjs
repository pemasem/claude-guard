import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FAKE, PKG, git, put, run, tmpDir } from './helpers.mjs';

const hook = (name) => path.join(PKG, 'hooks', name);
const bash = (command, dir) => run(hook('guard-bash.mjs'), [], { input: JSON.stringify({ tool_input: { command }, cwd: dir }), env: { CLAUDE_PROJECT_DIR: dir } });
const file = (tool_name, file_path, dir) => run(hook('protect-files.mjs'), [], { input: JSON.stringify({ tool_name, tool_input: { file_path } }), env: { CLAUDE_PROJECT_DIR: dir } });

test('guard-bash bloquea los comandos peligrosos', () => {
  const dir = tmpDir();
  const blocked = [
    'git push --force origin feature/x',
    'git push origin main',
    'git push origin HEAD:develop',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'git commit -m x --no-verify',
    'rm -rf /',
    'npm audit fix --force',
    'psql -c "DROP TABLE users"',
    'cat .env',
    'type src\\.env.local',
    'printenv',
    'env | grep KEY',
    `export ${FAKE.publicSecretVar}=abc`,
    `gcloud run services update app --set-env-vars ${FAKE.nextPublicSecretVar}=x`,
    'ngrok http 3000',
    'cloudflared tunnel --url http://localhost:5173',
    'docker run -e NODE_ENV=development app',
    'docker build -t app . && docker run app npm run dev',
  ];
  for (const c of blocked) assert.equal(bash(c, dir).status, 2, c);
});

test('guard-bash deja pasar lo normal', () => {
  const dir = tmpDir();
  for (const c of ['git status', 'git push origin feature/T12-login', 'npm test', 'cat .env.example', 'docker build -t app .', 'npm run build', 'echo VITE_APP_TITLE=Hola']) {
    assert.equal(bash(c, dir).status, 0, c);
  }
});

test('guard-bash: ramas protegidas configurables y commit en rama protegida', () => {
  const dir = tmpDir();
  put(dir, 'claude-guard.config.json', JSON.stringify({ protectedBranches: ['release'] }));
  assert.equal(bash('git push origin main', dir).status, 0);
  assert.equal(bash('git push origin release', dir).status, 2);
  git(dir, 'init', '-q', '-b', 'release');
  assert.equal(bash('git commit -m "x"', dir).status, 2);
  git(dir, 'checkout', '-q', '-b', 'feature/x');
  assert.equal(bash('git commit -m "x"', dir).status, 0);
});

test('protect-files: .env y claves bloqueados; .env.example permitido', () => {
  const dir = tmpDir();
  assert.equal(file('Read', '/p/.env', dir).status, 2);
  assert.equal(file('Read', 'C:/p/src/.env.production', dir).status, 2);
  assert.equal(file('Edit', '/p/.env.local', dir).status, 2);
  assert.equal(file('Read', '/p/.env.example', dir).status, 0);
  assert.equal(file('Read', '/p/certs/server.key', dir).status, 2);
  assert.equal(file('Read', '/p/service-account-prod.json', dir).status, 2);
  assert.equal(file('Read', '/p/src/app.ts', dir).status, 0);
});

test('protect-files: lockfiles no se editan y las barreras piden confirmación', () => {
  const dir = tmpDir();
  assert.equal(file('Edit', '/p/package-lock.json', dir).status, 2);
  assert.equal(file('Read', '/p/package-lock.json', dir).status, 0);
  for (const f of ['/p/.claude/settings.json', '/p/.claude/hooks/claude-guard/guard-bash.mjs', '/p/.claude-guard/check-deploy-safety.mjs', '/p/claude-guard.config.json']) {
    const r = file('Write', f, dir);
    assert.equal(r.status, 0, f);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'ask', f);
  }
});

test('post-edit: bloquea un secreto o una variable pública con secreto tras editar', () => {
  const dir = tmpDir();
  run(path.join(PKG, 'install.mjs'), [dir]);
  const post = (f) => run(path.join(dir, '.claude', 'hooks', 'claude-guard', 'post-edit.mjs'), [], { input: JSON.stringify({ tool_input: { file_path: f } }), env: { CLAUDE_PROJECT_DIR: dir } });

  const ok = put(dir, 'src/server/x.ts', 'export const a = 1;\n');
  assert.equal(post(ok).status, 0, post(ok).out);

  const leak = put(dir, 'src/server/y.ts', `const k = '${FAKE.googleKey}';\n`);
  const r1 = post(leak);
  assert.equal(r1.status, 2);
  assert.match(r1.stderr, /google-api-key/);
  assert.doesNotMatch(r1.stderr, new RegExp(FAKE.googleKey));
  fs.rmSync(leak);

  const pub = put(dir, 'README.md', `Define ${FAKE.publicSecretVar}\n`);
  const r2 = post(pub);
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /public-secret-var/);
});

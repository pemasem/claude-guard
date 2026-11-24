import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FAKE, PKG, git, goodProject, put, run, tmpDir } from './helpers.mjs';

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
    'alembic downgrade base',
    'poetry run alembic -c alembic.ini downgrade base',
    'flask db downgrade base',
    'python manage.py migrate shop zero',
    'python manage.py flush --no-input',
    'npx prisma migrate reset --force',
    'npx prisma db push --force-reset',
    'bin/rails db:drop',
    'npx sequelize-cli db:migrate:undo:all',
    'npx knex migrate:rollback --all',
    'npx typeorm schema:drop -d ds.ts',
    'php artisan migrate:fresh --seed',
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
  for (const c of ['git status', 'git push origin feature/T12-login', 'npm test', 'cat .env.example', 'docker build -t app .', 'npm run build', 'echo VITE_APP_TITLE=Hola', 'alembic upgrade head', 'alembic downgrade -1', 'python manage.py migrate', 'npx prisma migrate deploy', 'npx knex migrate:rollback']) {
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

test('variantes de nombre de .env: .env_local, .env-staging, prod.env', () => {
  const dir = tmpDir();
  for (const c of ['cat src/.env_local', 'Get-Content src/.env_prod', 'type src\\.env-staging', 'cat config/prod.env', 'grep KEY .env_dev', 'gc .env.local', 'Select-String X -Path .env_prod']) {
    assert.equal(bash(c, dir).status, 2, c);
  }
  for (const c of ['cat .env.example', 'cat .env_example', 'cat .env-sample', 'cat prod.env.template', 'cat src/environment.ts', 'cat .envrc.md', 'ls .env_prod']) {
    assert.equal(bash(c, dir).status, 0, c);
  }
  for (const f of ['/p/src/.env_local', '/p/.env_dev', '/p/.env_prod', '/p/prod.env', '/p/.env-staging', 'C:\\p\\src\\.env_prod']) {
    assert.equal(file('Read', f, dir).status, 2, f);
    assert.equal(file('Edit', f, dir).status, 2, f);
  }
  for (const f of ['/p/.env.example', '/p/.env_example', '/p/.env-sample', '/p/.env_template', '/p/prod.env.dist', '/p/src/environment.ts', '/p/.envrc']) {
    assert.equal(file('Read', f, dir).status, 0, f);
  }
});

test('envTemplates: plantillas propias versionadas (.env.master) legibles', () => {
  const dir = tmpDir();
  assert.equal(file('Read', '/p/src/.env.master', dir).status, 2);
  assert.equal(bash('cat src/.env.master', dir).status, 2);
  put(dir, 'claude-guard.config.json', JSON.stringify({ envTemplates: ['.env.master'] }));
  assert.equal(file('Read', '/p/src/.env.master', dir).status, 0);
  assert.equal(bash('cat src/.env.master', dir).status, 0);
  assert.equal(file('Read', '/p/src/.env_prod', dir).status, 2);
});

test('readsEnvFile: el patrón de grep/rg/sls/findstr no se toma por fichero (regresión de un monorepo real)', () => {
  const dir = tmpDir();
  const ok = [
    'grep -iE "^\\.env|dockerignore" .gitignore',
    'grep -iE "^\\.env|dockerignore" backend/.dockerignore',
    'git ls-files | grep -iE "^\\.env|docker"',
    'rg -n "^\\.env" src',
    'rg --regexp=".env.local" src',
    'grep -e .env.local -e foo README.md',
    'grep --regexp .env_prod README.md',
    'grep -rn --include=*.ts -m 3 foo .',
    'Select-String -Pattern "^\\.env" -Path notes.txt',
    'sls .env.local notes.txt',
    'findstr /i /c:".env.local" notes.txt',
    'findstr ".env_prod" notes.txt',
  ];
  for (const c of ok) assert.equal(bash(c, dir).status, 0, c);
  const blocked = [
    'grep X .env',
    'grep -iE "^key" .env.local',
    'grep -e KEY -e TOKEN .env_prod',
    'grep -n -- KEY .env',
    'rg KEY .env',
    'rg -n -g "*.ts" KEY .env.local',
    'cat .env',
    'git ls-files | grep -iE "^\\.env" ; cat .env',
    'Select-String -Pattern X -Path .env_prod',
    'sls X .env.local',
    'findstr /i KEY .env',
    'findstr /c:"a b" .env_dev',
    'bash -c "cat .env"',
    'sh -c \'grep KEY .env\'',
    'sudo cat /app/.env',
  ];
  for (const c of blocked) assert.equal(bash(c, dir).status, 2, c);
});

test('guard-bash: git reset --hard no recomienda git stash (índice compartido con varios agentes)', () => {
  const r = bash('git reset --hard HEAD~1', tmpDir());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /rama o un commit de trabajo/);
  assert.doesNotMatch(r.stderr.split('Comando:')[0], /Usa git stash/);
});

test('guard-bash: claves públicas por diseño (PUBLISHABLE, ANON) no son secretos', () => {
  const dir = tmpDir();
  const p = (a, b) => [a, b].join('');
  const fine = [
    `export ${p('VI', 'TE_')}SUPABASE_PUBLISHABLE_KEY=abc`,
    `export ${p('NEXT', '_PUBLIC_')}SUPABASE_ANON_KEY=abc`,
    `export ${p('NEXT', '_PUBLIC_')}STRIPE_PUBLISHABLE_KEY=abc`,
  ];
  for (const c of fine) assert.equal(bash(c, dir).status, 0, c);
  // ANON solo cuenta como palabra entera: ANONYMIZE_KEY sigue siendo un secreto.
  assert.equal(bash(`export ${p('VI', 'TE_')}ANONYMIZE_KEY=abc`, dir).status, 2);
  assert.equal(bash(`export ${FAKE.nextPublicSecretVar}=abc`, dir).status, 2);
});

test('post-edit: ignora ficheros fuera del proyecto y problemas previos ajenos al fichero editado', () => {
  const dir = goodProject(tmpDir());
  run(path.join(PKG, 'install.mjs'), [dir]);
  const post = (f) => run(path.join(dir, '.claude', 'hooks', 'claude-guard', 'post-edit.mjs'), [], { input: JSON.stringify({ tool_input: { file_path: f } }), env: { CLAUDE_PROJECT_DIR: dir } });
  // Problema previo en el proyecto: la imagen corre como root.
  put(dir, 'Dockerfile', fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8').replace('USER node\n', ''));

  const outside = put(tmpDir(), 'notes.md', 'texto\n');
  assert.equal(post(outside).status, 0, post(outside).out);
  // Aunque el fichero ajeno contenga un secreto: no es del proyecto.
  const outsideLeak = put(tmpDir(), 'k.ts', `const k = '${FAKE.googleKey}';\n`);
  assert.equal(post(outsideLeak).status, 0);

  const unrelated = put(dir, 'src/server/ok.ts', 'export const a = 1;\n');
  assert.equal(post(unrelated).status, 0, post(unrelated).out);

  // Editar el Dockerfile roto sí bloquea.
  const r = post(path.join(dir, 'Dockerfile'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /\[docker-user\]/);
});

test('post-edit: un .env versionado bloquea al editarlo, no al editar otro fichero', () => {
  const dir = goodProject(tmpDir());
  run(path.join(PKG, 'install.mjs'), [dir]);
  git(dir, 'init', '-q');
  put(dir, 'config/.env_prod', 'X=1\n');
  git(dir, 'add', '-A');
  const post = (f) => run(path.join(dir, '.claude', 'hooks', 'claude-guard', 'post-edit.mjs'), [], { input: JSON.stringify({ tool_input: { file_path: f } }), env: { CLAUDE_PROJECT_DIR: dir } });
  assert.equal(post(path.join(dir, 'server', 'index.js')).status, 0);
  assert.equal(post(path.join(dir, 'config', '.env_prod')).status, 2);
});

test('guard-bash bloquea el volcado y la lectura de variables de entorno con secretos', () => {
  const dir = tmpDir();
  const blocked = [
    'Write-Host $env:OPENAI_API_KEY',
    'echo ${env:GITHUB_TOKEN}',
    'Get-Item Env:DB_PASSWORD',
    'dir env:',
    'ls env:',
    'Get-ChildItem env:*',
    'gi env:SECRET_KEY',
    '[Environment]::GetEnvironmentVariable("API_KEY")',
    '[Environment]::GetEnvironmentVariable($name)',
    '[Environment]::GetEnvironmentVariables()',
    'python -c "import os; print(os.environ)"',
    'python3 -c "import os,json; print(json.dumps(dict(os.environ)))"',
    'python -c "import os; print(os.getenv(\'OPENAI_API_KEY\'))"',
    'python -c "import os; print(os.environ[\'DB_PASSWORD\'])"',
    'py -c "import os; [print(k, v) for k, v in os.environ.items()]"',
    'echo $OPENAI_API_KEY',
    'echo "token: ${GITHUB_TOKEN}"',
    'printf "%s" $DB_PASSWORD',
    'set',
    'cmd /c set',
    'cd app && set',
  ];
  for (const c of blocked) assert.equal(bash(c, dir).status, 2, c);
});

test('guard-bash deja pasar el uso normal de variables de entorno', () => {
  const dir = tmpDir();
  const ok = [
    '$env:PATH = "C:\\tools;" + $env:PATH',
    'Write-Host $env:NODE_ENV',
    '$env:OPENAI_API_KEY = "x"',
    '$env:PWD',
    'ls env:PATH',
    'Get-Item Env:NODE_ENV',
    '[Environment]::GetEnvironmentVariable("PATH")',
    'python -c "import os; print(os.environ[\'HOME\'])"',
    'python -c "import os; print(os.getenv(\'NODE_ENV\', \'dev\'))"',
    'python -c "import os; os.environ[\'X\'] = \'1\'"',
    'python -c "print(1+1)"',
    'python script.py',
    'echo $PATH',
    'echo $HOME $PWD',
    'echo hola',
    'set -e',
    'set -o pipefail; npm test',
    'npm run set',
  ];
  for (const c of ok) assert.equal(bash(c, dir).status, 0, c);
});

test('guard-bash: push forzado con "+" y refspecs hacia ramas protegidas', () => {
  const dir = tmpDir();
  const blocked = [
    'git push origin +master',
    'git push origin +feature/x',
    'git push origin +HEAD:feature/x',
    'git push origin feature:master',
    'git push origin HEAD:refs/heads/master',
    'git push origin feature/x:refs/heads/develop',
    'git push -u origin HEAD:main',
    'git push origin :master',
  ];
  for (const c of blocked) assert.equal(bash(c, dir).status, 2, c);
  const ok = [
    'git push origin feature/T12-login',
    'git push -u origin feature/x',
    'git push origin feature/main-fix',
    'git push origin feature:feature2',
    'git push origin HEAD:refs/heads/feature/x',
    'git push origin feature/a+b',
  ];
  for (const c of ok) assert.equal(bash(c, dir).status, 0, c);
});

test('protect-files: lockfiles de otros ecosistemas no se editan (sí se leen)', () => {
  const dir = tmpDir();
  for (const f of ['poetry.lock', 'uv.lock', 'Pipfile.lock', 'Cargo.lock', 'composer.lock', 'Gemfile.lock', 'go.sum']) {
    assert.equal(file('Edit', `/p/src/${f}`, dir).status, 2, f);
    assert.equal(file('Write', `C:\\p\\${f}`, dir).status, 2, f);
    assert.equal(file('Read', `/p/src/${f}`, dir).status, 0, f);
  }
  // Ficheros con nombre parecido pero que no son lockfiles.
  for (const f of ['go.mod', 'pyproject.toml', 'Cargo.toml', 'composer.json', 'my-go.sum.md']) assert.equal(file('Edit', `/p/${f}`, dir).status, 0, f);
});

test('protect-files: credenciales de cuentas de servicio, registros, git y clústeres', () => {
  const dir = tmpDir();
  for (const f of ['/p/deploy.sa.json', '/p/credentials/gcp.json', '/p/config/secrets/db/prod.json', '/p/.npmrc', '/p/.pypirc', '/home/u/.netrc', '/p/.git-credentials', '/p/kubeconfig', '/home/u/.kube/config', 'C:\\p\\credentials\\x.json']) {
    assert.equal(file('Read', f, dir).status, 2, f);
    assert.equal(file('Edit', f, dir).status, 2, f);
  }
  for (const f of ['/p/package.json', '/p/config/settings.json', '/p/secrets/README.md', '/p/credentials.md', '/p/src/netrc-parser.ts']) {
    assert.equal(file('Read', f, dir).status, 0, f);
  }
});

test('guard-bash: bloquea la extracción de secretos de la nube y de Kubernetes', () => {
  const dir = tmpDir();
  const blocked = [
    'gcloud secrets versions access latest --secret=db',
    'gcloud auth print-access-token',
    'gcloud auth application-default print-access-token',
    'gcloud auth print-identity-token',
    'aws secretsmanager get-secret-value --secret-id prod/db',
    'az keyvault secret show --name db --vault-name v',
    'kubectl get secret db -o yaml',
    'kubectl get secrets -n prod -o json',
    'kubectl get secret db -ojson',
    'kubectl get secret db --output=yaml',
    'kubectl -n prod get secret db -o jsonpath="{.data}"',
  ];
  for (const c of blocked) assert.equal(bash(c, dir).status, 2, c);
  const ok = [
    'gcloud secrets list',
    'gcloud secrets describe db',
    'gcloud auth login',
    'gcloud run deploy app --source .',
    'aws secretsmanager list-secrets',
    'az keyvault secret list --vault-name v',
    'kubectl get secrets',
    'kubectl get pods -o yaml',
    'kubectl get secret db',
    'kubectl describe secret db',
  ];
  for (const c of ok) assert.equal(bash(c, dir).status, 0, c);
});

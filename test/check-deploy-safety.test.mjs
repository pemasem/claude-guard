import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FAKE, PKG, git, goodProject, put, run, tmpDir } from './helpers.mjs';

const script = path.join(PKG, 'checks', 'check-deploy-safety.mjs');
let root;
const check = (...files) => run(script, ['--root', root, ...files]);
const dockerfile = () => fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');

beforeEach(() => {
  root = goodProject(tmpDir());
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('un proyecto correcto pasa', () => {
  const r = check();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /✔/);
});

test('el Dockerfile del incidente falla por todas sus causas', () => {
  put(root, 'Dockerfile', 'FROM node:20-slim\nWORKDIR /app\nCOPY package*.json ./\nRUN npm install\nCOPY . .\nCMD ["npm", "run", "start"]\n');
  const r = check();
  assert.equal(r.status, 1);
  for (const id of ['docker-node-env', 'docker-user', 'docker-frontend-build', 'docker-prod-deps']) assert.match(r.out, new RegExp(`\\[${id}\\]`), id);
  assert.match(r.out, /\[docker-copy-all\]/); // aviso
});

test('COPY . . es error si copyAllIsError', () => {
  put(root, 'Dockerfile', dockerfile().replace('COPY server ./server', 'COPY . .'));
  assert.equal(check().status, 0);
  put(root, 'claude-guard.config.json', JSON.stringify({ copyAllIsError: true }));
  assert.equal(check().status, 1);
});

test('servidor de desarrollo en la imagen', () => {
  for (const cmd of ['CMD ["npm", "run", "dev"]', 'CMD ["npx", "vite"]', 'CMD npx next dev', 'CMD ["npx", "tsx", "watch", "server.ts"]', 'CMD ["nodemon", "server"]']) {
    put(root, 'Dockerfile', dockerfile().replace('CMD ["node", "server/index.js"]', cmd));
    assert.match(check().out, /\[docker-dev-server\]/, cmd);
    goodProject(root);
  }
  put(root, 'Dockerfile', dockerfile().replace('ENV NODE_ENV=production', 'ENV NODE_ENV=development'));
  assert.match(check().out, /\[docker-node-env\]/);
});

test('root y secretos en ENV/ARG', () => {
  put(root, 'Dockerfile', dockerfile() + 'USER root\n');
  assert.match(check().out, /\[docker-user\]/);
  goodProject(root);
  put(root, 'Dockerfile', dockerfile().replace('ENV NODE_ENV=production', 'ENV NODE_ENV=production\nENV OPENAI_API_KEY=abc'));
  assert.match(check().out, /\[docker-secret-env\]/);
  goodProject(root);
  put(root, 'Dockerfile', dockerfile().replace('WORKDIR /app\nCOPY package.json', 'ARG DB_PASSWORD=x\nWORKDIR /app\nCOPY package.json'));
  assert.match(check().out, /\[docker-secret-env\]/);
});

test('imagen distroless :nonroot no exige USER', () => {
  put(root, 'Dockerfile', dockerfile().replace('FROM node:22-slim\n', 'FROM gcr.io/distroless/nodejs22-debian12:nonroot\n').replace('USER node\n', ''));
  assert.doesNotMatch(check().out, /\[docker-user\]/);
});

test('.dockerignore incompleto, ausente o que re-incluye .env', () => {
  put(root, '.dockerignore', 'node_modules\n');
  const r = check();
  assert.match(r.out, /\[dockerignore-env\]/);
  assert.match(r.out, /\[dockerignore-git\]/);
  put(root, '.dockerignore', '**/.env\n**/.env.*\n.git\n**/node_modules\n!.env.production\n');
  assert.match(check().out, /no re-incluyas/);
  put(root, '.dockerignore', '**/.env\n**/.env.*\n.git\n**/node_modules\n!.env.example\n');
  assert.equal(check().status, 0);
  fs.rmSync(path.join(root, '.dockerignore'));
  assert.match(check().out, /\[dockerignore-missing\]/);
});

test('vite.config: allowedHosts públicos, envPrefix, loadEnv completo y define con secretos', () => {
  const cases = [
    ["server: { allowedHosts: ['app.example.com'] }", 'vite-allowed-hosts'],
    ['server: { allowedHosts: true }', 'vite-allowed-hosts'],
    ["envPrefix: '', server: {}", 'vite-env-prefix'],
  ];
  for (const [body, id] of cases) {
    put(root, 'vite.config.ts', `import { defineConfig } from 'vite';\nexport default defineConfig({ ${body} });\n`);
    assert.match(check().out, new RegExp(`\\[${id}\\]`), body);
  }
  put(root, 'vite.config.ts', "import { defineConfig, loadEnv } from 'vite';\nconst env = loadEnv('production', '.', '');\nexport default defineConfig({ define: { 'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY) } });\n");
  const r = check();
  assert.match(r.out, /\[vite-load-env\]/);
  assert.match(r.out, /\[vite-define-secret\]/);
});

test('variable pública con secreto en cualquier fichero', () => {
  const f = put(root, 'README.md', `Define ${FAKE.publicSecretVar} en el servicio\n`);
  const r = check(f);
  assert.equal(r.status, 1);
  assert.match(r.out, /\[public-secret-var\]/);
  put(root, 'README.md', `Usa ${FAKE.nextPublicSecretVar}\n`);
  assert.match(check().out, /\[public-secret-var\]/);
  // Permitido en las rutas de allowMention (documentación, tests).
  fs.rmSync(path.join(root, 'README.md'));
  put(root, 'docs/incidente.md', `La clave iba en ${FAKE.publicSecretVar}\n`);
  assert.equal(check().status, 0);
});

test('SDK de IA en el frontend, pero no en el servidor', () => {
  put(root, 'src/components/Chat.tsx', "import { GoogleGenAI } from '@google/genai';\nexport const x = GoogleGenAI;\n");
  assert.match(check().out, /\[frontend-ai-sdk\]/);
  fs.rmSync(path.join(root, 'src/components/Chat.tsx'));
  put(root, 'src/pages/Home.jsx', "const sdk = await import('@anthropic-ai/sdk');\n");
  assert.match(check().out, /\[frontend-ai-sdk\]/);
  fs.rmSync(path.join(root, 'src/pages/Home.jsx'));
  put(root, 'app/api/chat/route.tsx', "import OpenAI from 'openai';\n");
  assert.equal(check().status, 0, 'app/api es servidor');
});

test('strictImportMetaEnv prohíbe variables propias en el frontend', () => {
  put(root, 'src/components/Api.tsx', 'export const url = import.meta.env.VITE_API_URL;\n');
  assert.equal(check().status, 0);
  put(root, 'claude-guard.config.json', JSON.stringify({ strictImportMetaEnv: true }));
  assert.match(check().out, /\[frontend-env\]/);
});

test('entrypoint con import estático de vite (serverEntry)', () => {
  put(root, 'server.ts', "import { createServer } from 'vite';\n");
  put(root, 'claude-guard.config.json', JSON.stringify({ serverEntry: 'server.ts' }));
  assert.match(check().out, /\[server-static-vite\]/);
  put(root, 'server.ts', "if (dev) { const { createServer } = await import('vite'); }\n");
  assert.equal(check().status, 0);
});

test('.env versionado en git', () => {
  git(root, 'init', '-q');
  put(root, '.env.production', 'X=1\n');
  git(root, 'add', '-A');
  assert.match(check().out, /\[env-tracked\]/);
});

test('disable desactiva una regla concreta', () => {
  put(root, 'Dockerfile', dockerfile().replace('USER node\n', ''));
  assert.equal(check().status, 1);
  put(root, 'claude-guard.config.json', JSON.stringify({ disable: ['docker-user'] }));
  assert.equal(check().status, 0);
});

test('sin Dockerfile no se exige .dockerignore', () => {
  fs.rmSync(path.join(root, 'Dockerfile'));
  fs.rmSync(path.join(root, '.dockerignore'));
  assert.equal(check().status, 0);
});

test('variantes .env versionadas (.env_prod, prod.env) y envTemplates', () => {
  git(root, 'init', '-q');
  put(root, 'src/.env_prod', 'X=1\n');
  put(root, 'prod.env', 'X=1\n');
  put(root, 'src/.env.master', 'X=\n');
  put(root, '.env_example', 'X=\n');
  git(root, 'add', '-A');
  const r = check();
  assert.match(r.out, /\[env-tracked\] src\/\.env_prod/);
  assert.match(r.out, /\[env-tracked\] prod\.env/);
  assert.match(r.out, /\[env-tracked\] src\/\.env\.master/);
  assert.doesNotMatch(r.out, /\[env-tracked\] \.env_example/);
  put(root, 'claude-guard.config.json', JSON.stringify({ envTemplates: ['.env.master'] }));
  assert.doesNotMatch(check().out, /\.env\.master/);
});

test('.dockerignore acepta **/.env_* y no se puede re-incluir .env_prod', () => {
  put(root, '.dockerignore', '**/.env\n**/.env_*\n.git\n**/node_modules\n');
  assert.equal(check().status, 0);
  put(root, '.dockerignore', '**/.env\n.git\n**/node_modules\n');
  assert.match(check().out, /\[dockerignore-env\]/);
  put(root, '.dockerignore', '**/.env\n**/.env_*\n.git\n**/node_modules\n!.env_prod\n');
  assert.match(check().out, /no re-incluyas/);
  put(root, '.dockerignore', '**/.env\n**/.env_*\n.git\n**/node_modules\n!.env_example\n');
  assert.equal(check().status, 0);
});

test('--changed: solo los problemas causados por ese fichero', () => {
  put(root, 'Dockerfile', dockerfile().replace('USER node\n', ''));
  put(root, 'src/components/Bad.tsx', `export const k = '${FAKE.publicSecretVar}';\n`);
  const scoped = (f) => run(script, ['--root', root, '--changed', path.join(root, f)]);
  // Fichero ajeno a los problemas: pasa.
  assert.equal(scoped('server/index.js').status, 0, scoped('server/index.js').out);
  // El propio Dockerfile o el fichero con la variable pública: falla, y solo por lo suyo.
  const d = scoped('Dockerfile');
  assert.equal(d.status, 1);
  assert.match(d.out, /\[docker-user\]/);
  assert.doesNotMatch(d.out, /public-secret-var/);
  const b = scoped('src/components/Bad.tsx');
  assert.equal(b.status, 1);
  assert.match(b.out, /public-secret-var/);
  assert.doesNotMatch(b.out, /docker-user/);
  // Fuera del proyecto: se ignora.
  assert.equal(run(script, ['--root', root, '--changed', path.join(tmpDir(), 'x.md')]).status, 0);
  // Modo completo (CI): ve todo.
  const full = check();
  assert.match(full.out, /docker-user/);
  assert.match(full.out, /public-secret-var/);
});

test('--changed: editar el .dockerignore reporta los problemas del .dockerignore, no los de Vite', () => {
  put(root, '.dockerignore', 'node_modules\n');
  put(root, 'vite.config.ts', "import { defineConfig } from 'vite';\nexport default defineConfig({ envPrefix: '' });\n");
  const r = run(script, ['--root', root, '--changed', path.join(root, '.dockerignore')]);
  assert.equal(r.status, 1);
  assert.match(r.out, /dockerignore-env/);
  assert.doesNotMatch(r.out, /vite-env-prefix/);
});

const pyDockerfile = (cmd, extra = '') => `FROM python:3.12-slim\n${extra}WORKDIR /app\nCOPY requirements.txt ./\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY app ./app\nRUN useradd -r app\nUSER app\n${cmd}\n`;

test('Python: una imagen de producción correcta pasa', () => {
  put(root, 'Dockerfile', pyDockerfile('CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]'));
  const r = check();
  assert.equal(r.status, 0, r.out);
  put(root, 'Dockerfile', pyDockerfile('CMD ["gunicorn", "app:app", "--log-level", "info"]'));
  assert.equal(check().status, 0);
});

test('Python: servidores de desarrollo y modo debug en la imagen', () => {
  const cases = [
    pyDockerfile('CMD ["uvicorn", "app.main:app", "--reload"]'),
    pyDockerfile('CMD uvicorn app.main:app --host 0.0.0.0 --reload'),
    pyDockerfile('CMD ["fastapi", "dev", "app/main.py"]'),
    pyDockerfile('CMD ["flask", "run", "--host=0.0.0.0"]'),
    pyDockerfile('CMD ["flask", "--app", "app", "run"]'),
    pyDockerfile('CMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]'),
    pyDockerfile('CMD ["gunicorn", "app:app"]', 'ENV FLASK_DEBUG=1\n'),
    pyDockerfile('CMD ["gunicorn", "app:app"]', 'ENV FLASK_ENV=development\n'),
    pyDockerfile('CMD ["gunicorn", "app:app"]', 'ENV DEBUG=True\n'),
    pyDockerfile('CMD ["gunicorn", "app:app"]', 'ENV DJANGO_DEBUG=true\n'),
  ];
  for (const d of cases) {
    put(root, 'Dockerfile', d);
    assert.match(check().out, /\[docker-python-dev-server\]/, d);
  }
  // No es servidor de desarrollo: DEBUG=False, LOG_DEBUG, y "flask" solo como paquete.
  for (const extra of ['ENV DEBUG=False\n', 'ENV LOG_DEBUG=1\n']) {
    put(root, 'Dockerfile', pyDockerfile('CMD ["gunicorn", "app:app"]', extra));
    assert.doesNotMatch(check().out, /docker-python-dev-server/, extra);
  }
  put(root, 'Dockerfile', pyDockerfile('CMD ["gunicorn", "app:app"]').replace('pip install --no-cache-dir -r requirements.txt', 'pip install flask run-tools'));
  assert.doesNotMatch(check().out, /docker-python-dev-server/);
});

test('Python: --log-level debug/trace es un aviso, no un error', () => {
  for (const level of ['debug', 'trace']) {
    put(root, 'Dockerfile', pyDockerfile(`CMD ["uvicorn", "app.main:app", "--log-level", "${level}"]`));
    const r = check();
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /\[docker-debug-log\]/);
  }
  put(root, 'Dockerfile', pyDockerfile('CMD ["uvicorn", "app.main:app", "--log-level", "info"]'));
  assert.doesNotMatch(check().out, /docker-debug-log/);
  put(root, 'claude-guard.config.json', JSON.stringify({ disable: ['docker-debug-log'] }));
  put(root, 'Dockerfile', pyDockerfile('CMD ["uvicorn", "app.main:app", "--log-level", "debug"]'));
  assert.doesNotMatch(check().out, /docker-debug-log/);
});

test('las reglas de Python no se aplican a una imagen de Node', () => {
  put(root, 'Dockerfile', dockerfile().replace('ENV NODE_ENV=production', 'ENV NODE_ENV=production\nENV DEBUG=True'));
  assert.doesNotMatch(check().out, /docker-python-dev-server/);
});

test('docker-user: el mensaje depende de la imagen', () => {
  put(root, 'Dockerfile', dockerfile().replace('USER node\n', ''));
  assert.match(check().out, /USER node/);
  put(root, 'Dockerfile', pyDockerfile('CMD ["gunicorn", "app:app"]').replace('RUN useradd -r app\nUSER app\n', ''));
  const r = check();
  assert.match(r.out, /\[docker-user\]/);
  assert.match(r.out, /useradd -r app/);
  assert.doesNotMatch(r.out, /USER node/);
});

test('navegador headless sin sandbox: aviso, y error si el contenedor corre como root', () => {
  // Con usuario sin privilegios: solo aviso.
  for (const flag of ['--no-sandbox', '--disable-setuid-sandbox']) {
    put(root, 'Dockerfile', dockerfile().replace('USER node', `ENV CHROMIUM_FLAGS=${flag}\nUSER node`));
    const r = check();
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /\[docker-browser-no-sandbox\]/, flag);
  }
  put(root, 'Dockerfile', dockerfile().replace('CMD ["node", "server/index.js"]', 'CMD ["node", "server/index.js", "--no-sandbox"]'));
  assert.match(check().out, /\[docker-browser-no-sandbox\]/);
  // Como root: error.
  put(root, 'Dockerfile', dockerfile().replace('USER node\n', 'ENV CHROMIUM_FLAGS=--no-sandbox\n'));
  const r = check();
  assert.equal(r.status, 1);
  assert.match(r.out, /\[docker-browser-no-sandbox\][^\n]*root/);
  // Sin la bandera, ni aviso ni error; un comentario no cuenta.
  goodProject(root);
  put(root, 'Dockerfile', dockerfile().replace('USER node', '# no usar --no-sandbox\nUSER node'));
  assert.doesNotMatch(check().out, /docker-browser-no-sandbox/);
  put(root, 'Dockerfile', dockerfile());
  assert.doesNotMatch(check().out, /docker-browser-no-sandbox/);
});

// --- Monorepos y backend Python (falsos positivos y reglas nuevas) ---------------------------------------------

const PY_DOCKERFILE = 'FROM python:3.12-slim\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install -r requirements.txt && useradd -r app\nCOPY app ./app\nUSER app\nCMD ["uvicorn", "app.main:app", "--host", "0.0.0.0"]\n';
const NEXT_STANDALONE = [
  'FROM node:22-alpine AS deps',
  'WORKDIR /app',
  'COPY package.json package-lock.json ./',
  'RUN npm ci',
  '',
  'FROM node:22-alpine AS build',
  'WORKDIR /app',
  'COPY --from=deps /app/node_modules ./node_modules',
  'COPY . .',
  'RUN npm run build',
  '',
  'FROM node:22-alpine AS runner',
  'ENV NODE_ENV=production',
  'WORKDIR /app',
  'COPY --from=build /app/.next/standalone ./',
  'COPY --from=build /app/.next/static ./.next/static',
  'USER node',
  'CMD ["node", "server.js"]',
  '',
].join('\n');
const GOOD_IGNORE = '**/.env\n**/.env.*\n.git\n**/node_modules\n';
const monorepo = () => {
  fs.rmSync(path.join(root, 'Dockerfile'));
  fs.rmSync(path.join(root, '.dockerignore'));
  put(root, 'claude-guard.config.json', JSON.stringify({ dockerfiles: ['backend/Dockerfile', 'web/Dockerfile'] }));
  put(root, 'backend/Dockerfile', PY_DOCKERFILE);
  put(root, 'web/Dockerfile', NEXT_STANDALONE);
};

test('monorepo: cada Dockerfile exige el .dockerignore de su carpeta (el de la raíz no vale)', () => {
  monorepo();
  put(root, '.dockerignore', GOOD_IGNORE); // el de la raíz no cubre los contextos backend/ y web/
  const r = check();
  assert.equal(r.status, 1);
  assert.match(r.out, /\[dockerignore-missing\] backend\/\.dockerignore/);
  assert.match(r.out, /\[dockerignore-missing\] web\/\.dockerignore/);
  put(root, 'backend/.dockerignore', GOOD_IGNORE);
  put(root, 'web/.dockerignore', GOOD_IGNORE);
  const ok = check();
  assert.equal(ok.status, 0, ok.out);
});

test('monorepo: .env real en el contexto + COPY . . sin .dockerignore que lo excluya es error', () => {
  monorepo();
  put(root, 'backend/.dockerignore', GOOD_IGNORE);
  put(root, 'web/.env.local', 'NEXT_TELEMETRY_DISABLED=1\n');
  const r = check();
  assert.equal(r.status, 1);
  assert.match(r.out, /\[dockerignore-env-in-context\] web\/Dockerfile[^\n]*web[^\n]*\.env\.local/);
  assert.doesNotMatch(r.out, /backend\/\.dockerignore/);
  // Con un .dockerignore que lo excluye, pasa.
  put(root, 'web/.dockerignore', GOOD_IGNORE);
  assert.equal(check().status, 0);
  // Sin COPY . . no hay riesgo de que el .env entre por ahí.
  fs.rmSync(path.join(root, 'web/.dockerignore'));
  put(root, 'web/Dockerfile', NEXT_STANDALONE.replace('COPY . .', 'COPY src ./src'));
  assert.doesNotMatch(check().out, /dockerignore-env-in-context/);
  // Una plantilla (.env.example) no cuenta como .env real.
  fs.rmSync(path.join(root, 'web/.env.local'));
  put(root, 'web/Dockerfile', NEXT_STANDALONE);
  put(root, 'web/.env.example', 'FOO=\n');
  assert.doesNotMatch(check().out, /dockerignore-env-in-context/);
});

test('el .dockerignore de un contexto de docker-compose se busca en su context:', () => {
  fs.rmSync(path.join(root, '.dockerignore'));
  put(root, 'claude-guard.config.json', JSON.stringify({ dockerfiles: ['Dockerfile', 'backend/Dockerfile'] }));
  put(root, 'backend/Dockerfile', PY_DOCKERFILE);
  put(root, 'docker-compose.yml', 'services:\n  api:\n    build:\n      context: .\n      dockerfile: backend/Dockerfile\n  web:\n    build: .\n');
  // Ambos se construyen desde la raíz: basta el .dockerignore de la raíz.
  put(root, '.dockerignore', GOOD_IGNORE);
  const r = check();
  assert.equal(r.status, 0, r.out);
  // Un servicio con otro context: exige el .dockerignore de ese context.
  put(root, 'docker-compose.yml', 'services:\n  api:\n    build:\n      context: ./backend\n');
  const r2 = check();
  assert.equal(r2.status, 1);
  assert.match(r2.out, /\[dockerignore-missing\] backend\/\.dockerignore/);
  put(root, 'backend/.dockerignore', GOOD_IGNORE);
  assert.equal(check().status, 0);
});

test('la opción dockerignore sigue valiendo para el contexto de la raíz', () => {
  fs.rmSync(path.join(root, '.dockerignore'));
  put(root, 'docker/ignore.txt', GOOD_IGNORE);
  put(root, 'claude-guard.config.json', JSON.stringify({ dockerignore: 'docker/ignore.txt' }));
  assert.equal(check().status, 0);
  fs.rmSync(path.join(root, 'docker/ignore.txt'));
  assert.match(check().out, /\[dockerignore-missing\] docker\/ignore\.txt/);
});

test('docker-prod-deps: Next standalone multi-etapa (la final solo copia artefactos) no es error', () => {
  put(root, 'Dockerfile', NEXT_STANDALONE);
  const r = check();
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /docker-prod-deps/);
});

test('docker-prod-deps: sigue siendo error si la etapa final instala sin --omit=dev o hereda una etapa con devDependencies', () => {
  put(root, 'Dockerfile', NEXT_STANDALONE.replace('COPY --from=build /app/.next/standalone ./', 'COPY package.json package-lock.json ./\nRUN npm ci\nCOPY --from=build /app/.next/standalone ./'));
  assert.match(check().out, /\[docker-prod-deps\]/);
  put(root, 'Dockerfile', NEXT_STANDALONE.replace('FROM node:22-alpine AS build', 'FROM deps AS build').replace('FROM node:22-alpine AS runner', 'FROM build AS runner'));
  assert.match(check().out, /\[docker-prod-deps\]/);
  // Instalar solo producción en la etapa final, o podar, vale.
  put(root, 'Dockerfile', NEXT_STANDALONE.replace('COPY --from=build /app/.next/standalone ./', 'COPY package.json package-lock.json ./\nRUN npm ci --omit=dev\nCOPY --from=build /app/.next/standalone ./'));
  assert.doesNotMatch(check().out, /docker-prod-deps/);
  // Un `npm ci --omit=dev` en una etapa intermedia no salva a una final que instala sin filtrar.
  put(root, 'Dockerfile', dockerfile().replace('RUN npm ci --omit=dev', 'RUN npm install').replace('RUN npm ci\n', 'RUN npm ci --omit=dev\n'));
  assert.match(check().out, /\[docker-prod-deps\]/);
});

test('public-secret-var: claves públicas por diseño (PUBLISHABLE, ANON) no se marcan; ANONYMIZE_KEY sí', () => {
  const p = (a, b) => [a, b].join('');
  const names = [`${p('VI', 'TE_')}SUPABASE_PUBLISHABLE_KEY`, `${p('NEXT', '_PUBLIC_')}SUPABASE_ANON_KEY`, `${p('NEXT', '_PUBLIC_')}STRIPE_PUBLISHABLE_KEY`];
  put(root, '.env.example', names.map((n) => `${n}=\n`).join(''));
  put(root, 'src/components/Supa.tsx', names.map((n, i) => `export const a${i} = process.env.${n};`).join('\n') + '\n');
  const r = check();
  assert.equal(r.status, 0, r.out);
  put(root, '.env.example', `${p('VI', 'TE_')}ANONYMIZE_KEY=\n`);
  assert.match(check().out, /\[public-secret-var\]/);
  put(root, '.env.example', `${FAKE.nextPublicSecretVar}=\n`);
  assert.match(check().out, /\[public-secret-var\]/);
});

test('forwarded-ips-wildcard: aviso por --forwarded-allow-ips=* o FORWARDED_ALLOW_IPS=*, también en compose', () => {
  const py = (cmd) => PY_DOCKERFILE.replace(/CMD .*\n/, cmd + '\n');
  for (const cmd of ['CMD ["uvicorn", "app.main:app", "--proxy-headers", "--forwarded-allow-ips=*"]', "CMD uvicorn app.main:app --proxy-headers --forwarded-allow-ips='*'", 'CMD ["gunicorn", "app:app", "--forwarded-allow-ips", "*"]', 'ENV FORWARDED_ALLOW_IPS=*\nCMD ["uvicorn", "app.main:app"]']) {
    put(root, 'Dockerfile', py(cmd));
    const r = check();
    assert.equal(r.status, 0, r.out); // solo aviso
    assert.match(r.out, /\[forwarded-ips-wildcard\] Dockerfile/, cmd);
  }
  put(root, 'Dockerfile', py('CMD ["uvicorn", "app.main:app", "--proxy-headers", "--forwarded-allow-ips=172.18.0.2"]'));
  assert.doesNotMatch(check().out, /forwarded-ips-wildcard/);
  put(root, 'docker-compose.yml', 'services:\n  api:\n    environment:\n      - FORWARDED_ALLOW_IPS=*\n');
  assert.match(check().out, /\[forwarded-ips-wildcard\] docker-compose\.yml/);
  put(root, 'docker-compose.yml', 'services:\n  api:\n    command: ["uvicorn", "app.main:app", "--forwarded-allow-ips", "*"]\n');
  assert.match(check().out, /\[forwarded-ips-wildcard\] docker-compose\.yml/);
});

test('uvicorn-proxy-headers: aviso solo con un proxy en el proyecto y sin --proxy-headers ni --forwarded-allow-ips', () => {
  put(root, 'Dockerfile', PY_DOCKERFILE);
  // Sin Caddyfile ni nginx.conf, no hay proxy conocido.
  assert.doesNotMatch(check().out, /uvicorn-proxy-headers/);
  put(root, 'Caddyfile', 'example.com {\n  reverse_proxy api:8000\n}\n');
  const r = check();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /\[uvicorn-proxy-headers\] Dockerfile[^\n]*IP del proxy/);
  put(root, 'Dockerfile', PY_DOCKERFILE.replace('"--host", "0.0.0.0"', '"--host", "0.0.0.0", "--proxy-headers", "--forwarded-allow-ips=10.0.0.5"'));
  assert.doesNotMatch(check().out, /uvicorn-proxy-headers/);
  // El flag puede estar en el compose que lanza la imagen.
  put(root, 'Dockerfile', PY_DOCKERFILE);
  put(root, 'docker-compose.yml', 'services:\n  api:\n    command: uvicorn app.main:app --proxy-headers\n');
  assert.doesNotMatch(check().out, /uvicorn-proxy-headers/);
  fs.rmSync(path.join(root, 'docker-compose.yml'));
  fs.rmSync(path.join(root, 'Caddyfile'));
  put(root, 'infra/nginx.conf', 'events {}\n');
  assert.match(check().out, /\[uvicorn-proxy-headers\]/);
});

test('default-secret-value: secreto con valor por defecto conocido en código de servidor', () => {
  put(root, 'backend/app/config.py', 'import os\nsecret_key: str = "changeme"\n');
  const r = check();
  assert.equal(r.status, 0, r.out); // aviso, no error
  assert.match(r.out, /\[default-secret-value\] backend\/app\/config\.py: línea 2/);
  for (const [file, body] of [
    ['backend/app/a.py', 'import os\nSECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret")\n'],
    ['server/b.js', 'const jwtSecret = process.env.JWT_SECRET || "cambiame";\n'],
    ['api/c.ts', "export const sessionSecret = process.env.SESSION_SECRET ?? 'secret';\n"],
  ]) {
    put(root, file, body);
    assert.match(check().out, new RegExp(`\\[default-secret-value\\] ${file.replace('.', '\\.')}`), file);
  }
  // Sin valor por defecto, con valor aleatorio, comentario, silenciado, tests y documentación: nada.
  for (const f of ['backend/app/config.py', 'backend/app/a.py', 'server/b.js', 'api/c.ts']) fs.rmSync(path.join(root, f));
  put(root, 'backend/app/ok1.py', 'import os\nSECRET_KEY = os.environ["SECRET_KEY"]\nJWT_SECRET = os.getenv("JWT_SECRET")\n');
  put(root, 'backend/app/ok2.py', 'secret_key = "q8Zr2vXk7LmP4sTn"\n# secret_key = "changeme"\n');
  put(root, 'backend/app/ok3.py', 'secret_key = "changeme"  # secret-scan: ignore\n');
  put(root, 'backend/tests/test_auth.py', 'secret_key = "changeme"\n');
  put(root, 'docs/auth.md', 'secret_key = "changeme"\n');
  assert.doesNotMatch(check().out, /default-secret-value/);
});

test('browser-sandbox-disabled: aviso por chromium_sandbox=False / chromiumSandbox: false', () => {
  put(root, 'server/scrape.py', 'browser = p.chromium.launch(chromium_sandbox=False)\n');
  put(root, 'server/scrape.js', 'const b = await chromium.launch({ chromiumSandbox: false });\n');
  const r = check();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /\[browser-sandbox-disabled\] server\/scrape\.py/);
  assert.match(r.out, /\[browser-sandbox-disabled\] server\/scrape\.js/);
  put(root, 'server/scrape.py', 'browser = p.chromium.launch(chromium_sandbox=True)\n');
  put(root, 'server/scrape.js', 'const b = await chromium.launch({ chromiumSandbox: true });\n');
  assert.doesNotMatch(check().out, /browser-sandbox-disabled/);
});

test('frontend-token-storage: token o sesión en localStorage/sessionStorage', () => {
  const bad = [
    "localStorage.setItem('access_token', t);",
    'sessionStorage.setItem("jwt", t);',
    'window.localStorage.setItem(`auth-${id}`, t);',
    'localStorage.setItem(TOKEN_KEY, t);',
    "localStorage['session'] = s;",
  ];
  for (const line of bad) {
    put(root, 'src/components/Login.tsx', `export const save = (t: string) => { ${line} };\n`);
    const r = check();
    assert.equal(r.status, 0, r.out); // aviso
    assert.match(r.out, /\[frontend-token-storage\] src\/components\/Login\.tsx/, line);
  }
  put(root, 'src/components/Login.tsx', "export const save = () => { localStorage.setItem('theme', 'dark'); const t = localStorage.getItem('access_token'); };\n");
  assert.doesNotMatch(check().out, /frontend-token-storage/);
});

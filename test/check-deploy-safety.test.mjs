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

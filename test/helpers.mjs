import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function tmpDir(prefix = 'claude-guard-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function put(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

/** Ejecuta un script de Node con stdin opcional; devuelve { status, stdout, stderr }. */
export function run(script, args = [], { input, cwd, env } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    input,
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', out: (r.stdout || '') + (r.stderr || '') };
}

export function git(cwd, ...args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

// Valores que los escáneres detectarían, armados en tiempo de ejecución (este fichero no debe dispararlos).
export const FAKE = {
  publicSecretVar: ['VI', 'TE_', 'GEMINI_API_KEY'].join(''),
  nextPublicSecretVar: ['NEXT', '_PUBLIC_', 'STRIPE_SECRET'].join(''),
  googleKey: ['AI', 'za', 'Sy', 'A'.repeat(33)].join(''),
  githubToken: ['gh', 'p_', 'x'.repeat(36)].join(''),
};

/** Proyecto de ejemplo que cumple todas las reglas (Express + Vite, imagen multi-stage). */
export function goodProject(root) {
  put(root, 'Dockerfile', [
    'FROM node:22-slim AS build',
    'WORKDIR /app',
    'COPY package.json package-lock.json ./',
    'RUN npm ci',
    'COPY src ./src',
    'RUN npm run build',
    '',
    'FROM node:22-slim',
    'ENV NODE_ENV=production',
    'WORKDIR /app',
    'COPY package.json package-lock.json ./',
    'RUN npm ci --omit=dev',
    'COPY --from=build /app/dist ./dist',
    'COPY server ./server',
    'USER node',
    'CMD ["node", "server/index.js"]',
    '',
  ].join('\n'));
  put(root, '.dockerignore', '**/.env\n**/.env.*\n.git\n**/node_modules\n');
  put(root, 'vite.config.ts', "import { defineConfig } from 'vite';\nexport default defineConfig({ server: { allowedHosts: ['localhost'] } });\n");
  put(root, 'src/components/App.tsx', 'export const App = () => import.meta.env.DEV;\n');
  put(root, 'server/index.js', "import OpenAI from 'openai';\nconst key = process.env.OPENAI_API_KEY;\nexport { OpenAI, key };\n");
  put(root, '.env.example', 'OPENAI_API_KEY=\n');
  return root;
}

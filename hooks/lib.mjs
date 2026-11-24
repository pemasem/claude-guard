// claude-guard: utilidades comunes de los hooks de Claude Code.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

/** Bloquea la acción: el motivo (stderr) le llega a Claude para que corrija el rumbo. */
export function block(reason) {
  process.stderr.write(reason + '\n');
  process.exit(2);
}

/** Devuelve una respuesta estructurada al hook (p. ej. permissionDecision: 'ask') y termina. */
export function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

export const norm = (p = '') => String(p).replace(/\\/g, '/');

export function projectDir(input) {
  return process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();
}

export function currentBranch(cwd) {
  try {
    return execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

export const DEFAULT_CONFIG = Object.freeze({
  protectedBranches: ['main', 'master', 'develop'],
  envTemplates: [],
});

/**
 * ¿Es un fichero de variables de entorno? .env, .env.local, .env_prod, .env-staging, prod.env…
 * Quedan fuera las plantillas sin valores (.env.example/.sample/.template/.dist, también con "_" o "-")
 * y las que el proyecto declare en `envTemplates` (p. ej. ".env.master").
 */
export function isEnvFile(file, templates = []) {
  const f = norm(file);
  const base = f.split('/').pop();
  if (!/^(\.env([._-].+)?|.+\.env)$/i.test(base)) return false;
  if (/[._-](example|sample|template|dist)$/i.test(base)) return false;
  return !(templates || []).some((t) => {
    const n = norm(t);
    return f === n || f.endsWith('/' + n);
  });
}

/** Lee claude-guard.config.json de la raíz del proyecto (si existe) sobre los valores por defecto. */
export function loadConfig(dir) {
  const p = path.join(dir, 'claude-guard.config.json');
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Prefijos que los frameworks publican en el navegador (Vite, Next.js, Create React App, Expo, SvelteKit/Astro, Nuxt).
 * Se arman por partes para que este fichero no se detecte a sí mismo en los escaneos.
 */
export const PUBLIC_PREFIXES = [
  ['VI', 'TE_'],
  ['NEXT', '_PUBLIC_'],
  ['REACT', '_APP_'],
  ['EXPO', '_PUBLIC_'],
  ['NUXT', '_PUBLIC_'],
  ['PUB', 'LIC_'],
].map((p) => p.join(''));

export const SECRET_WORDS = 'KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIAL|PRIVATE|AUTH';

/**
 * Nombres que, aun con prefijo público, son claves públicas por diseño (Supabase anon, Stripe publishable…).
 * Fragmento de expresión regular para un lookahead negativo; el comprobador lleva su propia copia (es autónomo).
 */
export const PUBLIC_BY_DESIGN = '\\w*?(?:PUBLISHABLE|(?<![A-Za-z0-9])ANON(?![A-Za-z0-9]))';

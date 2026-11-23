#!/usr/bin/env node
// claude-guard · Escaneo ligero de secretos.
//
//   node .claude-guard/scan-secrets.mjs               -> ficheros versionados del repositorio (git ls-files)
//   node .claude-guard/scan-secrets.mjs <ficheros…>   -> solo esos ficheros (lo usa el hook tras cada edición)
//
// Exit 1 si encuentra algo. Nunca imprime el secreto completo. Una línea con `secret-scan: ignore` se omite
// (para valores de ejemplo o de test claramente falsos; nunca para claves reales).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Patrones armados por partes para que este fichero no se detecte a sí mismo.
const P = (...parts) => new RegExp(parts.join(''));
const RULES = [
  ['google-api-key', P('AI', 'za', '[0-9A-Za-z_\\-]{35}')],
  ['anthropic-key', P('sk-', 'ant-', '[0-9A-Za-z_\\-]{20,}')],
  ['openai-key', P('\\bsk-', '(?:proj-|svcacct-|admin-)?', '[0-9A-Za-z_\\-]{32,}')],
  ['github-token', P('\\b(?:gh', '[pousr]_[0-9A-Za-z]{36,}|github', '_pat_[0-9A-Za-z_]{40,})')],
  ['aws-access-key', P('\\b(?:AK', 'IA|AS', 'IA)[0-9A-Z]{16}\\b')],
  ['slack-token', P('\\bxox', '[abposr]-[0-9A-Za-z-]{10,}')],
  ['private-key', P('-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE', ' KEY-----')],
  ['jwt', P('\\bey', 'J[0-9A-Za-z_\\-]{20,}\\.ey', 'J[0-9A-Za-z_\\-]{20,}\\.[0-9A-Za-z_\\-]{20,}')],
  ['stripe-secret', P('\\b(?:sk|rk)_', 'live_[0-9A-Za-z]{20,}')],
];
const SKIP = /(^|\/)(node_modules|\.git|dist|build|coverage)\/|\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|mp4|lock)$|(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i;

function listFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

const files = process.argv.slice(2).length ? process.argv.slice(2) : listFiles();
const found = [];
for (const f of files) {
  if (SKIP.test(f.replace(/\\/g, '/'))) continue;
  let s;
  try {
    const st = fs.statSync(f);
    if (!st.isFile() || st.size > 5_000_000) continue;
    s = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  s.split(/\r?\n/).forEach((line, i) => {
    if (line.includes('secret-scan: ignore')) return;
    for (const [id, re] of RULES) {
      const m = re.exec(line);
      if (m) found.push(`${path.normalize(f)}:${i + 1}: ${id} (${m[0].slice(0, 6)}…)`);
    }
  });
}

if (found.length) {
  console.error('✖ claude-guard · posibles secretos:\n' + found.map((x) => '  - ' + x).join('\n'));
  process.exit(1);
}
console.log(`✔ claude-guard · escaneo de secretos: ${files.length} fichero(s), nada encontrado.`);

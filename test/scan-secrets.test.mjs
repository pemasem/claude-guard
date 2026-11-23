import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { FAKE, PKG, put, run, tmpDir } from './helpers.mjs';

const script = path.join(PKG, 'checks', 'scan-secrets.mjs');

test('detecta claves y no imprime el valor completo', () => {
  const dir = tmpDir();
  const a = put(dir, 'a.ts', `const k = "${FAKE.googleKey}";\n`);
  const b = put(dir, 'b.yml', `token: ${FAKE.githubToken}\n`);
  const r = run(script, [a, b]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /google-api-key/);
  assert.match(r.stderr, /github-token/);
  assert.doesNotMatch(r.stderr, new RegExp(FAKE.googleKey));
});

test('una línea marcada con secret-scan: ignore se omite', () => {
  const dir = tmpDir();
  const a = put(dir, 'a.ts', `const k = "${FAKE.googleKey}"; // secret-scan: ignore (valor de ejemplo)\n`);
  assert.equal(run(script, [a]).status, 0);
});

test('un fichero limpio pasa', () => {
  const dir = tmpDir();
  const a = put(dir, 'a.ts', 'const k = process.env.GEMINI_API_KEY;\n');
  assert.equal(run(script, [a]).status, 0);
});

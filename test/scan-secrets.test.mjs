import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { FAKE, PKG, fakeServiceAccountJson, put, run, tmpDir } from './helpers.mjs';

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

test('los lockfiles de otros ecosistemas no se escanean', () => {
  const dir = tmpDir();
  const files = ['go.sum', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Cargo.lock', 'composer.lock', 'Gemfile.lock'].map((f) => put(dir, f, `h1:${FAKE.googleKey}\n`));
  assert.equal(run(script, files).status, 0);
  // Un fichero normal con el mismo contenido sí se detecta.
  assert.equal(run(script, [put(dir, 'go.mod', `h1:${FAKE.googleKey}\n`)]).status, 1);
});

test('detecta secretos de cliente OAuth de Google y JSON de cuenta de servicio', () => {
  const dir = tmpDir();
  const a = put(dir, 'oauth.json', `{"client_secret": "${FAKE.googleOauthSecret}"}\n`);
  const r1 = run(script, [a]);
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /google-oauth-secret/);
  assert.doesNotMatch(r1.stderr, new RegExp(FAKE.googleOauthSecret));
  const b = put(dir, 'sa.json', fakeServiceAccountJson());
  const r2 = run(script, [b]);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /gcp-service-account/);
  // No disparan: un JSON de configuración normal, o uno de cuenta de servicio sin clave privada.
  assert.equal(run(script, [put(dir, 'cfg.json', '{"type": "module", "name": "x"}\n')]).status, 0);
  assert.equal(run(script, [put(dir, 'nokey.json', JSON.stringify({ type: 'service_' + 'account', client_email: 'a@b.example' }))]).status, 0);
});

test('secretScanAllow omite ficheros con valores falsos y los lista en la salida', () => {
  const dir = tmpDir();
  const pem = put(dir, 'tests/fixtures/fake.json', JSON.stringify({ key: `${FAKE.pemHeader}\nMIIBfake\n` }, null, 2));
  const other = put(dir, 'src/leak.ts', `const k = "${FAKE.googleKey}";\n`);
  const sa = put(dir, 'tests/fixtures/sa.json', fakeServiceAccountJson());
  // Sin configuración: todo se detecta.
  assert.equal(run(script, [pem, sa], { cwd: dir }).status, 1);
  put(dir, 'claude-guard.config.json', JSON.stringify({ secretScanAllow: ['tests/fixtures/'] }));
  const ok = run(script, [pem, sa], { cwd: dir });
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.stdout, /secretScanAllow/);
  assert.match(ok.stdout, /tests\/fixtures\/fake\.json/);
  assert.match(ok.stdout, /tests\/fixtures\/sa\.json/);
  // Un fichero fuera de la lista se sigue detectando, y la nota sale igualmente.
  const mixed = run(script, [pem, other], { cwd: dir });
  assert.equal(mixed.status, 1);
  assert.match(mixed.stderr, /google-api-key/);
  assert.match(mixed.stdout, /tests\/fixtures\/fake\.json/);
  // Un prefijo de carpeta sin "/" no cubre carpetas hermanas con el mismo comienzo.
  put(dir, 'claude-guard.config.json', JSON.stringify({ secretScanAllow: ['tests/fix'] }));
  assert.equal(run(script, [pem], { cwd: dir }).status, 1);
  // También admite un fichero concreto.
  put(dir, 'claude-guard.config.json', JSON.stringify({ secretScanAllow: ['tests/fixtures/fake.json'] }));
  assert.equal(run(script, [pem], { cwd: dir }).status, 0);
});

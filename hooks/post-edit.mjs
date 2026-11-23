// claude-guard · PostToolUse (Edit | Write | MultiEdit): tras CADA edición, escanea secretos en el fichero y comprueba
// que esa edición no rompe el despliegue (solo problemas causados por ese fichero; ignora ficheros ajenos al proyecto). Si algo falla, devuelve exit 2 para que Claude lo corrija al momento.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { block, norm, projectDir, readInput } from './lib.mjs';

const input = readInput();
const file = norm(input.tool_input?.file_path ?? '');
if (!file) process.exit(0);
const dir = projectDir(input);
// Un fichero fuera del proyecto (p. ej. una carpeta temporal) no es asunto de las reglas del proyecto.
const relToProject = path.relative(path.resolve(dir), path.resolve(dir, file));
if (!relToProject || relToProject.startsWith('..') || path.isAbsolute(relToProject)) process.exit(0);
const hookDir = path.dirname(fileURLToPath(import.meta.url));

/** Busca el comprobador instalado (<proyecto>/.claude-guard) o, en el propio repositorio de claude-guard, checks/. */
function findCheck(name) {
  for (const base of [path.join(dir, '.claude-guard'), path.join(hookDir, '..', 'checks')]) {
    const p = path.join(base, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const scan = findCheck('scan-secrets.mjs');
if (scan) {
  const r = spawnSync(process.execPath, [scan, file], { cwd: dir, encoding: 'utf8' });
  if (r.status === 1) block(`⛔ claude-guard: posible secreto en ${file}:\n${r.stderr}\nMuévelo a una variable de entorno (sin prefijo público) y documéntala en .env.example.`);
}

const safety = findCheck('check-deploy-safety.mjs');
if (safety) {
  const r = spawnSync(process.execPath, [safety, '--root', dir, '--changed', file], { cwd: dir, encoding: 'utf8' });
  if (r.status === 1) block(`⛔ claude-guard: la edición de ${file} rompe la seguridad del despliegue:\n${r.stderr}\nCorrige la causa; no relajes las reglas.`);
}
process.exit(0);

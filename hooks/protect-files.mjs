// claude-guard · PreToolUse (Read | Edit | Write | MultiEdit | NotebookEdit): protege secretos y las propias barreras.
import { block, emit, norm, readInput } from './lib.mjs';

const input = readInput();
const tool = input.tool_name;
const file = norm(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? '');
if (!file) process.exit(0);

// .env, .env.local, .env.production… (pero no .env.example / .env.sample / .env.template, que no llevan valores).
const isEnv = /(^|\/)\.env(\.[^/]*)?$/.test(file) && !/\.env\.(example|sample|template|dist)$/.test(file);
if (isEnv) block(`⛔ claude-guard (protect-files): ${file} contiene secretos. Claude no lo lee ni lo modifica; documenta las variables en .env.example.`);

// Claves privadas y credenciales de cuentas de servicio.
if (/\.(pem|key|p12|pfx)$|(^|\/)(id_rsa|id_ed25519)(\.pub)?$|(^|\/)(credentials|service-account)[^/]*\.json$/i.test(file) && !/\.pub$/.test(file)) {
  block(`⛔ claude-guard (protect-files): ${file} parece una clave o credencial. No se lee ni se edita.`);
}

if (tool === 'Read') process.exit(0);

if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/.test(file)) {
  block('⛔ claude-guard (protect-files): los lockfiles no se editan a mano; usa el gestor de paquetes (npm/yarn/pnpm install).');
}

// Las barreras de seguridad solo se cambian con aprobación explícita del usuario.
if (/(^|\/)\.claude\/hooks\/claude-guard\/|(^|\/)\.claude-guard\/|(^|\/)\.claude\/settings\.json$|(^|\/)claude-guard\.config\.json$/.test(file)) {
  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: 'claude-guard: es una barrera de seguridad (hooks, comprobadores o su configuración). Solo se cambia con aprobación explícita y sin relajar ninguna regla.',
    },
  });
}
process.exit(0);

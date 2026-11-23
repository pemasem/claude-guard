# Contribuir / Contributing

## Español

Cada medida nueva (por un incidente, una auditoría o un susto) entra como una **regla completa**:

1. **Regla**: en `checks/check-deploy-safety.mjs` (con un id nuevo en kebab-case), en `hooks/guard-bash.mjs` o en `hooks/protect-files.mjs`. Mensaje en español: qué pasa y cómo corregirlo.
2. **Test**: en `test/`, uno que falle sin la regla y pase con ella, más un caso que **no** deba dispararse (para evitar falsos positivos).
3. **Documentación**: una fila en `docs/reglas.md` y en `docs/rules.en.md` con el *porqué* técnico. Si viene de un incidente, añade su informe anonimizado en `docs/incidentes/` (ES y EN): sin empresas, clientes, personas, importes, dominios ni rutas internas.
4. **CHANGELOG.md**: entrada en "Sin publicar".
5. `npm test` y `npm run check` en verde.

Las reglas nunca deben imprimir secretos. Los valores de prueba se arman en tiempo de ejecución (ver `test/helpers.mjs`) para que el propio repositorio no los contenga.

## English

Every new safeguard (from an incident, an audit or a close call) comes in as a **complete rule**:

1. **Rule** in `checks/check-deploy-safety.mjs` (with a new kebab-case id), `hooks/guard-bash.mjs` or `hooks/protect-files.mjs`. Message in Spanish: what happened and how to fix it.
2. **Test** in `test/` that fails without the rule and passes with it, plus a case that must **not** trigger (to avoid false positives).
3. **Docs**: a row in `docs/reglas.md` and `docs/rules.en.md` with the technical *why*. If it comes from an incident, add an anonymized write-up under `docs/incidentes/` (ES and EN): no companies, customers, people, amounts, domains or internal paths.
4. **CHANGELOG.md** entry under "Unreleased".
5. `npm test` and `npm run check` green.

Rules must never print secrets. Test values are assembled at runtime (see `test/helpers.mjs`) so the repository itself doesn't contain them.

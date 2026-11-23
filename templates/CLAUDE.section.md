## Seguridad (claude-guard)

Reglas instaladas por [claude-guard](https://github.com/pemasem/claude-guard). Los hooks de `.claude/hooks/claude-guard/` las hacen cumplir; `.claude-guard/check-deploy-safety.mjs` las comprueba también en CI.

1. **Nunca un servidor de desarrollo en un entorno desplegado.** La imagen compila el frontend, fija `NODE_ENV=production`, instala solo dependencias de producción y corre sin root. `npm run dev`, Vite, `next dev`, `nodemon` o `tsx watch` solo en local, y nunca expuestos con túneles.
2. **Ningún secreto en variables públicas.** Todo lo que empieza por `VITE_`, `NEXT_PUBLIC_`, `REACT_APP_`, `EXPO_PUBLIC_`, `PUBLIC_` o `NUXT_PUBLIC_` acaba en el navegador. Las claves se leen solo en el servidor.
3. **El frontend no llama a proveedores de IA ni a APIs con clave**: va siempre a través del servidor.
4. **Los secretos no se leen, no se imprimen y no se versionan**: nada de abrir `.env`, volcar variables de entorno ni subir `.env` al repositorio. Van al gestor de secretos de la plataforma.
5. **Nunca se abre con un navegador headless ni con un cliente HTTP del servidor una URL que venga del usuario sin validar el destino**: solo http/https, y se rechazan loopback, redes privadas, link-local (169.254.169.254, metadata.google.internal) y `*.internal`, también tras redirecciones y en subrecursos (p. ej. `page.route`/`context.route` en Playwright). Si no, es un SSRF.
6. **Las rutas de fichero construidas con datos del usuario se resuelven y se comprueban contra la base** (`Path(base, rel).resolve()` + `relative_to(base)` o equivalente). Comprobar solo el prefijo con `startswith` no basta: `..` lo salta.
7. **El contenido de terceros (HTML, texto de webs, ficheros subidos) que entra en un prompt de LLM va delimitado y marcado como datos**, nunca como instrucciones. Lo que el LLM genere a partir de él no se reutiliza como prompt sin revisión.
8. **Los navegadores headless que procesan páginas de terceros corren con sandbox y con un usuario sin privilegios.** Si la plataforma obliga a `--no-sandbox`, se aíslan en un servicio sin secretos.
9. **Ninguna regla de claude-guard se relaja, se desactiva ni se salta** (`--no-verify`, `disable` en `claude-guard.config.json`, editar los hooks) sin la aprobación explícita del usuario. Si un comprobador falla, se corrige la causa.

# Incidente 2026-11: clave de IA robada a través del servidor de desarrollo de Vite

*[English](2026-11-vite-dev-server.en.md)* · Informe anonimizado.

## Resumen

Un servicio desplegado en un contenedor en la nube servía el **servidor de desarrollo de Vite** a Internet. La clave de la API de un proveedor de IA estaba en una variable **`VITE_*`**. Alguien la obtuvo y lanzó **cientos de miles de peticiones en unos 30 minutos** desde fuera de la infraestructura del proyecto. El gasto fue importante y hubo que desactivar la facturación para cortarlo.

## Cadena de fallos

Ninguno de estos fallos por sí solo habría bastado. Juntos, sí.

1. **La imagen no era de producción.**
   - El Dockerfile instalaba dependencias, copiaba el código y arrancaba `tsx server.ts`, sin `npm run build` y sin `NODE_ENV=production`.
   - El servidor (Express) hacía lo habitual en las plantillas: `if (NODE_ENV !== 'production')` monta Vite en modo middleware, y si no, sirve `dist/`.
   - Sin la variable, en la nube corría el modo desarrollo.

2. **La clave estaba pensada para llegar al navegador.**
   - La documentación del proyecto mandaba definir la clave como `VITE_GEMINI_API_KEY`.
   - Vite publica en el cliente **toda** variable con prefijo `VITE_`.
   - Un módulo del frontend la leía con `import.meta.env`. Con el servidor de desarrollo, bastaba con pedir ese módulo (`GET /src/services/<fichero>.ts`) para recibir la clave en el JavaScript.

3. **El servidor de desarrollo tenía un fallo de lectura de ficheros.**
   - La versión de Vite (6.4.4) tenía un fallo que se salta `server.fs.deny` con parámetros de query.
   - `GET /.env` respondía 403, pero `GET /.env?raw` devolvía el contenido del fichero.
   - Además, todo el código fuente del servidor (`/server.ts`, servicios, scripts de seed con contraseñas de desarrollo) era legible.

4. **Sin defensa en profundidad.**
   - La clave no tenía restricción de API ni cuotas.
   - No había alertas de gasto.
   - El riesgo del código fuente público se había visto semanas antes y se dejó aplazado.

## Cómo se confirmó

Se reprodujo en local, con claves falsas y un `.env` señuelo, en Windows y en Linux:

| Petición | Resultado |
|---|---|
| `GET /src/services/<módulo>.ts` | 200, con la clave en claro |
| `GET /.env?raw`, `/.env?raw??`, `/.env?import&raw??` | 200, con el contenido del `.env` |
| `GET /.env` | 403 |
| `GET /server.ts` y otros `.ts` | 200, con el código fuente |
| `GET /.git/config`, `/proc/self/environ` | 200, **pero es `index.html`**: el servidor de desarrollo con `appType: 'spa'` devuelve la página para cualquier ruta desconocida |
| `GET /@fs/proc/self/environ?raw` | 403 |

**Lección para el análisis de logs:** un 200 en una ruta sensible no siempre significa que se filtró algo. Hay que mirar el **tamaño** de la respuesta y compararlo con el de `index.html`.

## Corrección

- Imagen multi-stage:
  - etapa de build: `npm ci` y `npm run build`;
  - etapa final: `ENV NODE_ENV=production`, `npm ci --omit=dev` (vite ni siquiera existe en la imagen) y `USER node`.
- `.dockerignore` que excluye `.env*`, `.git`, tests y datos locales.
- El servidor **se niega a arrancar** en estos casos:
  - en la plataforma cloud (detectada por sus variables, como `K_SERVICE`), si `NODE_ENV` no es `production`;
  - si existe una variable `VITE_*` con nombre de secreto;
  - si faltan secretos obligatorios o son demasiado cortos.
- Vite solo se carga con `await import('vite')`, dentro de la rama de desarrollo.
- La clave se lee solo en el servidor, con un nombre sin prefijo.
- Vite actualizado a una versión corregida.
- Este repositorio: hooks y comprobadores para que no vuelva a pasar en ningún proyecto.

## Checklist de plataforma

Lo que ningún hook puede hacer por ti:

- [ ] **Revocar** la clave comprometida y crear otra **restringida** (solo la API necesaria y, si se puede, por origen o cuenta de servicio). Mejor aún: autenticación por cuenta de servicio, sin API key.
- [ ] Guardar los secretos en el **gestor de secretos** de la plataforma, nunca en variables escritas a mano en la consola ni en la imagen.
- [ ] **Rotar todo** lo que estuviera en el entorno o en ficheros legibles: otras claves de IA, secretos de JWT, tokens de integraciones, contraseña de la base de datos y contraseñas de administrador.
- [ ] **Cuotas** de peticiones por minuto y por día en la API del proveedor.
- [ ] **Presupuestos con alertas**, y un **corte automático de facturación** (presupuesto → evento → función que la desactiva) para los proyectos con APIs de pago.
- [ ] **Alertas** de monitorización sobre el volumen de peticiones al proveedor.
- [ ] `max-instances` acotado y límites de gasto en la propia aplicación.
- [ ] **Mínimo privilegio**: quién puede ver y crear claves y qué puede hacer la cuenta de servicio.
- [ ] Inventario de servicios desplegados: borrar los antiguos u olvidados (el servicio afectado no era ninguno de los entornos "oficiales").
- [ ] No reactivar el servicio hasta verificar todo lo anterior.

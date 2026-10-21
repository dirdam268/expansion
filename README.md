# Expansión Centro

PWA (ordenador y móvil) para que Enrique y Jose Manuel apunten locales en venta/alquiler, competencia y manzanas/calles visitadas del distrito Centro de Madrid. Nació como artifact de Claude; aquí es una app propia, igual que el resto de proyectos.

- **Fuente:** `index-src.html` (en claro, gitignored). **Nunca editar `index.html`**, que es generado y cifrado.
- **Regenerar:** `powershell -ExecutionPolicy Bypass -File build-secure.ps1 -Password '<contraseña>'` (la contraseña la conoce el usuario; no está guardada).
- **Probar en local:** `serve.ps1` (puerto 8780, sirve `index-src.html`).
- **Iconos:** `gen-icons.ps1`.
- **Clave recordada** en `localStorage['exp_pw']` (todas las apps de `dirdam268.github.io` comparten origen: cada una usa su propia clave).

## Datos compartidos (Cloudflare Worker + KV)

Sin servidor la app funciona en **modo local** (datos solo en ese dispositivo, copia en `localStorage`). Para compartirlos entre los dos:

1. Cloudflare → *Storage & Databases → KV* → crear un namespace `expansion`.
2. *Workers & Pages → Create → Worker* (nombre p. ej. `expansion-api`) → *Edit code* → pegar `worker/worker.js` → *Deploy*.
3. En el Worker → *Settings → Bindings → Add → KV namespace*: variable **`EXP`**, namespace `expansion`.
4. *Settings → Variables and Secrets → Add*: secreto **`TOKEN`** = una clave larga aleatoria.
5. En `index-src.html` rellenar `API_URL` (`https://expansion-api.<subdominio>.workers.dev`, sin barra final) y `API_TOKEN` (el mismo valor). Reconstruir y publicar.

Cómo funciona: toda la base va en una sola clave KV (`db`); las fotos van aparte (`foto:<id>`). La app guarda primero en local, manda los cambios por una cola que sobrevive a cortes de cobertura, y consulta el servidor cada 30 s y al volver a la pestaña. Dos cambios casi simultáneos sobre el mismo documento: gana el último.
El token va dentro del bloque cifrado; el Worker solo acepta peticiones con él y solo responde al origen `https://dirdam268.github.io`.

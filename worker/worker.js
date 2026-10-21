// Worker de Cloudflare para "Expansión Centro".
// Guarda TODA la base de datos en una sola clave de KV ("db") y las fotos en "foto:<id>".
// Variables que hay que crear en el Worker:
//   - Binding KV:   EXP   (un namespace de KV)
//   - Secreto:      TOKEN (la clave de acceso; la misma que va en API_TOKEN de index-src.html)
//   - Opcional:     ALLOWED_ORIGIN (por defecto https://dirdam268.github.io)

const COLLS = ['locales', 'competencia', 'calles', 'manzanas', 'config'];
const MAX_FOTO = 600 * 1024; // caracteres del dataURL

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const allowed = env.ALLOWED_ORIGIN || 'https://dirdam268.github.io';
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': origin === allowed ? origin : allowed,
      'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Token',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    const out = (body, status = 200, extra = {}) =>
      new Response(body, { status, headers: { ...cors, ...extra } });
    const json = (o, status = 200) =>
      out(JSON.stringify(o), status, { 'Content-Type': 'application/json' });

    if (req.method === 'OPTIONS') return out(null, 204);

    const token = req.headers.get('X-Token') || url.searchParams.get('t') || '';
    if (!env.TOKEN || token !== env.TOKEN) return json({ error: 'auth' }, 401);

    const loadDb = async () => {
      const db = (await env.EXP.get('db', 'json')) || {};
      for (const c of COLLS) db[c] = db[c] || {};
      return db;
    };
    const parts = url.pathname.split('/').filter(Boolean);

    // GET /all
    if (req.method === 'GET' && parts[0] === 'all') return json(await loadDb());

    // PUT|DELETE /doc/<coleccion>/<id>
    if (parts[0] === 'doc' && parts.length === 3) {
      const [, coll, id] = parts;
      if (!COLLS.includes(coll) || !/^[\w-]{1,64}$/.test(id)) return json({ error: 'ruta' }, 400);
      const db = await loadDb();
      if (req.method === 'PUT') {
        let body;
        try { body = await req.json(); } catch (e) { return json({ error: 'json' }, 400); }
        if (!body || typeof body !== 'object') return json({ error: 'json' }, 400);
        delete body.photo; // las fotos van aparte, nunca dentro del documento
        db[coll][id] = body;
      } else if (req.method === 'DELETE') {
        delete db[coll][id];
        if (coll === 'locales') await env.EXP.delete('foto:' + id);
      } else return json({ error: 'metodo' }, 405);
      await env.EXP.put('db', JSON.stringify(db));
      return json({ ok: true });
    }

    // PUT /foto/<id>  {d: "data:image/jpeg;base64,..."}   |   GET /foto/<id>
    if (parts[0] === 'foto' && parts.length === 2) {
      const id = parts[1];
      if (!/^[\w-]{1,64}$/.test(id)) return json({ error: 'ruta' }, 400);
      if (req.method === 'PUT') {
        let body;
        try { body = await req.json(); } catch (e) { return json({ error: 'json' }, 400); }
        const d = body && body.d;
        if (typeof d !== 'string' || !d.startsWith('data:image/jpeg;base64,') || d.length > MAX_FOTO)
          return json({ error: 'foto' }, 400);
        await env.EXP.put('foto:' + id, d);
        return json({ ok: true });
      }
      if (req.method === 'GET') {
        const d = await env.EXP.get('foto:' + id);
        if (!d) return out('no hay foto', 404);
        const bin = Uint8Array.from(atob(d.slice(d.indexOf(',') + 1)), (c) => c.charCodeAt(0));
        return out(bin, 200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000' });
      }
    }
    return json({ error: 'no encontrado' }, 404);
  },
};

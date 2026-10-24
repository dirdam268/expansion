// Worker de Cloudflare para "Expansión Centro".
// Guarda TODA la base de datos en una sola clave de KV ("db") y las fotos en "foto:<id>".
// Variables que hay que crear en el Worker:
//   - Binding KV:   EXP   (un namespace de KV)
//   - Secreto:      TOKEN (la clave de acceso; la misma que va en API_TOKEN de index-src.html)
//   - Opcional:     ALLOWED_ORIGIN (por defecto https://dirdam268.github.io)

const COLLS = ['locales', 'competencia', 'calles', 'manzanas', 'config'];
const MAX_FOTO = 600 * 1024; // caracteres del dataURL
const ID_OK = /^[\w-]{1,64}$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const allowed = env.ALLOWED_ORIGIN || 'https://dirdam268.github.io';
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': origin === allowed ? origin : allowed,
      'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
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
    // aplica una operación sobre la base en memoria; devuelve false si es inválida
    const apply = async (db, m, coll, id, body) => {
      if (!COLLS.includes(coll) || !ID_OK.test(id)) return false;
      if (m === 'PUT') {
        if (!body || typeof body !== 'object') return false;
        const doc = { ...body };
        delete doc.photo; // las fotos van aparte, nunca dentro del documento
        db[coll][id] = doc;
      } else if (m === 'DELETE') {
        delete db[coll][id];
        if (coll === 'locales') await env.EXP.delete('foto:' + id);
      } else return false;
      return true;
    };
    const parts = url.pathname.split('/').filter(Boolean);

    // GET /all
    if (req.method === 'GET' && parts[0] === 'all') return json(await loadDb());

    // POST /batch   {ops:[{m:'PUT'|'DELETE', c:<coleccion>, id, b:<documento>}]}  -> UNA sola escritura en KV
    if (req.method === 'POST' && parts[0] === 'batch') {
      let body;
      try { body = await req.json(); } catch (e) { return json({ error: 'json' }, 400); }
      const ops = body && Array.isArray(body.ops) ? body.ops.slice(0, 500) : null;
      if (!ops) return json({ error: 'ops' }, 400);
      const db = await loadDb();
      let n = 0;
      for (const op of ops) if (op && (await apply(db, op.m, op.c, String(op.id || ''), op.b))) n++;
      if (n) await env.EXP.put('db', JSON.stringify(db));
      return json({ ok: true, aplicadas: n, recibidas: ops.length });
    }

    // PUT|DELETE /doc/<coleccion>/<id>
    if (parts[0] === 'doc' && parts.length === 3) {
      const [, coll, id] = parts;
      const db = await loadDb();
      let body;
      if (req.method === 'PUT') {
        try { body = await req.json(); } catch (e) { return json({ error: 'json' }, 400); }
      } else if (req.method !== 'DELETE') return json({ error: 'metodo' }, 405);
      if (!(await apply(db, req.method, coll, id, body))) return json({ error: 'ruta' }, 400);
      await env.EXP.put('db', JSON.stringify(db));
      return json({ ok: true });
    }

    // PUT /foto/<id>  {d: "data:image/jpeg;base64,..."}   |   GET /foto/<id>
    if (parts[0] === 'foto' && parts.length === 2) {
      const id = parts[1];
      if (!ID_OK.test(id)) return json({ error: 'ruta' }, 400);
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

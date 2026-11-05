// Worker de Cloudflare para "Expansión Centro".
// Guarda TODA la base de datos en una sola clave de KV ("db") y las fotos en "foto:<id>".
// Variables que hay que crear en el Worker:
//   - Binding KV:   EXP   (un namespace de KV)
//   - Secreto:      TOKEN (la clave de acceso; la misma que va en API_TOKEN de index-src.html)
//   - Opcional:     ALLOWED_ORIGIN (por defecto https://dirdam268.github.io)
//   - Excel semanal: secreto RESEND_KEY (clave de resend.com), opcional DESTINO (por defecto bordetass@gmail.com)
//                    y un Cron en Settings > Trigger Events (por ejemplo 0 7 * * 1 = lunes)

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
    // POST /enviar-excel  -> manda ya el Excel por correo (sirve para probar sin esperar al lunes)
    if (parts[0] === 'enviar-excel') return json(await enviarSemanal(env));
    return json({ error: 'no encontrado' }, 404);
  },
  // Cron semanal (se configura en Settings > Trigger Events > Cron): manda el Excel por correo
  async scheduled(event, env, ctx) {
    ctx.waitUntil(enviarSemanal(env));
  },
};

/* ================== Excel semanal por correo ==================
   Cada lunes (cron) el Worker monta un Excel con todos los locales (también los desestimados) y las tomas de
   competencia, y lo envía por correo con Resend.
   Variables del Worker:  RESEND_KEY (secreto, la clave de resend.com)
                          DESTINO    (opcional, por defecto bordetass@gmail.com) */
const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const fmtMes = (m) => { const [y, n] = String(m || '').split('-'); return n ? MESES[+n - 1] + ' de ' + y : ''; };
const fmtFecha = (d) => { if (!d) return ''; const [y, m, dd] = String(d).split('-'); return dd + '/' + m + '/' + y; };
const nnum = (v) => { const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : null; };
const hayPos = (o) => o && typeof o.lat === 'number' && typeof o.lng === 'number';
const qPos = (o) => hayPos(o) ? o.lat + ',' + o.lng : encodeURIComponent((o.address || o.name || '') + ', Madrid');
const linkMaps = (o) => 'https://www.google.com/maps/search/?api=1&query=' + qPos(o);
const linkWazeW = (o) => hayPos(o) ? 'https://waze.com/ul?ll=' + o.lat + ',' + o.lng + '&navigate=yes' : 'https://waze.com/ul?q=' + encodeURIComponent((o.address || o.name || '') + ', Madrid') + '&navigate=yes';
const esMovilTel = (t) => /^[67]/.test(String(t || '').replace(/\D/g, '').replace(/^34(?=\d{9}$)/, ''));
const telsDeW = (l) => { let fijo = l.telfijo || '', movil = l.telmovil || ''; if (l.tel) { if (esMovilTel(l.tel)) { if (!movil) movil = l.tel; } else if (!fijo) fijo = l.tel; } return { fijo, movil }; };
const urlSegura = (u) => /^https?:\/\//i.test(String(u || '')) ? String(u) : '';
const portalW = (u) => { const h = String(u || '').toLowerCase(); return /idealista/.test(h) ? 'Idealista' : /fotocasa/.test(h) ? 'Fotocasa' : /habitaclia/.test(h) ? 'Habitaclia' : /pisos\.com/.test(h) ? 'Pisos.com' : h ? 'Otro' : ''; };
const ESTADOS_W = { estudio: 'En estudio', negociacion: 'En negociación', largo: 'A largo plazo', desestimado: 'Desestimado' };
const CAUSAS_W = { precio: 'Precio o renta demasiado altos', superficie: 'Superficie inadecuada', fachada: 'Fachada o escaparate insuficiente', ubicacion: 'Mala ubicación o poca afluencia', competencia: 'Competencia cercana', propiedad: 'La propiedad no negocia / ya no está disponible', legal: 'Problemas legales o de licencia', obras: 'Obras o costes de adaptación', otra: 'Otra causa' };
const notasTxt = (o) => (o.notas || []).map((x) => fmtFecha(x.d) + (x.u ? ' (' + x.u + ')' : '') + ': ' + x.t).join('\n');
const N = (v) => { const n = nnum(v); return n != null ? { num: n } : ''; };

function filasLocales(db) {
  const L = Object.entries(db.locales || {}).map(([id, l]) => ({ ...l, id })).sort((a, b) => (b.created || 0) - (a.created || 0));
  const rows = [['Nombre', 'Estado', 'Causa de desestimación', 'Operación', 'Dirección', 'Municipio', 'Precio (€)', 'Metros totales (m²)', 'Planta calle (m²)', 'Sótano (m²)', '€/m²', 'Fachada (m)',
    'Cifra de ventas (€/año)', 'Cifra espejo', 'Cifra integral', 'Cifra Geoblink', 'Inmobiliaria', 'Teléfono fijo', 'Teléfono móvil', 'Candidato', 'Candidato · móvil', 'Candidato · fijo',
    'Portal', 'Enlace del anuncio', 'Descripción', 'Notas', 'Mes de la visita', 'Dado de alta por', 'Documentos recibidos', 'Tareas de obra', 'Google Maps', 'Waze']];
  for (const l of L) {
    const p = nnum(l.price), m2 = nnum(l.m2), t = telsDeW(l), u = urlSegura(l.url);
    const estado = ESTADOS_W[l.estado || 'estudio'] || 'En estudio';
    const recibidos = Object.values(l.docs || {}).filter((s) => s === 'recibido').length + (l.docsExtra || []).filter((x) => x.s === 'recibido').length;
    const causa = l.estado === 'desestimado' ? (CAUSAS_W[l.causaDes] || '') + (l.causaDesTxt ? ' · ' + l.causaDesTxt : '') : '';
    rows.push([l.name || '', estado, causa, l.op === 'venta' ? 'Venta' : 'Alquiler', l.address || '', l.muni || '', N(p), N(m2), N(l.m2calle), N(l.m2sotano),
      p && m2 ? { num: Math.round(p / m2 * 100) / 100, dec: 1 } : '', N(l.fachada),
      N(l.cifra), l.cifras && l.cifras.espejo != null ? { num: l.cifras.espejo } : '', l.cifras && l.cifras.integral != null ? { num: l.cifras.integral } : '', N(l.cifraGb),
      l.inmo || '', t.fijo, t.movil, l.candidato || '', l.candtelmovil || '', l.candtelfijo || '', portalW(u), u ? { url: u } : '', l.notes || '', notasTxt(l),
      l.month ? fmtMes(l.month) : '', l.by || '', recibidos ? { num: recibidos } : '',
      (l.obras || []).map((x) => (x.ok ? '[hecho] ' : '[pendiente] ') + x.t + (x.d ? ' (' + fmtFecha(x.d) + (x.f ? ' → ' + fmtFecha(x.f) : '') + ')' : '')).join('\n'),
      { url: linkMaps(l), t: 'Google Maps' }, { url: linkWazeW(l), t: 'Waze' }]);
  }
  return rows;
}
function filasTomas(db) {
  const T = Object.entries(db.competencia || {}).map(([id, c]) => ({ ...c, id })).filter((c) => c.toma).sort((a, b) => (b.created || 0) - (a.created || 0));
  const rows = [['Enseña', 'Franquicia', 'Franquiciado / candidato', 'Teléfono fijo', 'Teléfono móvil', 'Dirección del proyecto', 'Municipio', 'Metros (m²)', 'Último recuento', 'Próximo recuento', 'Recontar cada (meses)', 'Descripción', 'Notas', 'Mes', 'Dado de alta por', 'Google Maps', 'Waze']];
  for (const t of T) {
    const tl = telsDeW(t);
    rows.push([t.brand || '', t.franq || '', t.candidato || '', tl.fijo, tl.movil, t.address || '', t.muni || '', N(t.m2), fmtFecha(t.ultima), fmtFecha(t.proxima), N(t.cadaMeses), t.notes || '', notasTxt(t),
      t.month ? fmtMes(t.month) : '', t.by || '', { url: linkMaps(t), t: 'Google Maps' }, { url: linkWazeW(t), t: 'Waze' }]);
  }
  return rows;
}
function filasDesestimados(db) {
  const L = Object.entries(db.locales || {}).map(([id, l]) => ({ ...l, id })).filter((l) => l.estado === 'desestimado').sort((a, b) => (b.created || 0) - (a.created || 0));
  const rows = [['Nombre', 'Dirección', 'Municipio', 'Operación', 'Precio (€)', 'Metros totales (m²)', 'Causa de la desestimación', 'Fecha', 'Inmobiliaria', 'Teléfono fijo', 'Teléfono móvil', 'Candidato', 'Enlace del anuncio', 'Descripción', 'Notas', 'Mes de la visita', 'Dado de alta por', 'Google Maps']];
  for (const l of L) {
    const t = telsDeW(l), u = urlSegura(l.url);
    rows.push([l.name || '', l.address || '', l.muni || '', l.op === 'venta' ? 'Venta' : 'Alquiler', N(l.price), N(l.m2), (CAUSAS_W[l.causaDes] || 'Sin indicar') + (l.causaDesTxt ? ' · ' + l.causaDesTxt : ''), fmtFecha(l.fechaDes),
      l.inmo || '', t.fijo, t.movil, l.candidato || '', u ? { url: u } : '', l.notes || '', notasTxt(l), l.month ? fmtMes(l.month) : '', l.by || '', { url: linkMaps(l), t: 'Google Maps' }]);
  }
  return rows;
}
// Agenda: inmobiliarias y candidatos (de locales, tomas y locales/tomas ya borrados), fusionados por nombre o teléfono
function filasAgenda(db) {
  const items = [], porTel = new Map(), porNombre = new Map();
  const slugW = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const limpia = (t) => String(t || '').replace(/\D/g, '').replace(/^34(?=\d{9}$)/, '');
  const add = (tipo, nombre, fijo, movil, ref) => {
    const claves = [...fijo, ...movil].map(limpia).filter(Boolean);
    let it = (nombre && porNombre.get(tipo + ':' + slugW(nombre))) || claves.map((c) => porTel.get(c)).find(Boolean);
    if (!it) { it = { tipo, nombre: nombre || '', fijo: [], movil: [], refs: [] }; items.push(it); }
    if (!it.nombre && nombre) it.nombre = nombre;
    for (const t of fijo) if (t && !it.fijo.some((x) => limpia(x) === limpia(t))) it.fijo.push(t);
    for (const t of movil) if (t && !it.movil.some((x) => limpia(x) === limpia(t))) it.movil.push(t);
    it.refs.push(ref);
    if (nombre) porNombre.set(tipo + ':' + slugW(nombre), it);
    for (const c of [...it.fijo, ...it.movil].map(limpia)) porTel.set(c, it);
  };
  const lista = (v) => (v ? [v] : []);
  for (const l of Object.values(db.locales || {})) {
    const t = telsDeW(l), est = ESTADOS_W[l.estado || 'estudio'] || 'En estudio';
    if (l.inmo || t.fijo || t.movil) add('Inmobiliaria', l.inmo || '', lista(t.fijo), lista(t.movil), (l.address || l.name || '') + ' (' + est + ')');
    if (l.candidato || l.candtelfijo || l.candtelmovil) add('Candidato', l.candidato || '', lista(l.candtelfijo), lista(l.candtelmovil), (l.address || l.name || '') + ' (' + est + ')');
  }
  for (const c of Object.values(db.competencia || {})) {
    if (!c.toma) continue;
    const t = telsDeW(c);
    if (c.candidato || t.fijo || t.movil) add('Candidato · competencia', c.candidato || '', lista(t.fijo), lista(t.movil), (c.brand || 'Toma') + (c.address ? ' · ' + c.address : '') + ' (toma)');
  }
  for (const d of Object.values(db.config || {})) {   // contactos de locales/tomas borrados
    if (!d || !d.ag) continue;
    const t = telsDeW(d), ref = (d.txt || 'Borrado') + ' (borrado)';
    if (!d.toma && (d.inmo || t.fijo || t.movil)) add('Inmobiliaria', d.inmo || '', lista(t.fijo), lista(t.movil), ref);
    if (d.toma) { if (d.candidato || t.fijo || t.movil) add('Candidato · competencia', d.candidato || '', lista(t.fijo), lista(t.movil), ref); }
    else if (d.candidato || d.candtelfijo || d.candtelmovil) add('Candidato', d.candidato || '', lista(d.candtelfijo), lista(d.candtelmovil), ref);
  }
  for (const it of items) if (!it.nombre) it.nombre = it.tipo + ' ' + (it.movil[0] || it.fijo[0] || 'sin teléfono');
  items.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  const rows = [['Nombre', 'Tipo', 'Teléfono móvil', 'Teléfono fijo', 'Locales / tomas relacionados']];
  for (const it of items) rows.push([it.nombre, it.tipo, it.movil.join(' / '), it.fijo.join(' / '), it.refs.join('\n')]);
  return rows;
}
const aBase64 = (buf) => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };

async function enviarSemanal(env) {
  if (!env.RESEND_KEY) return { ok: false, error: 'Falta el secreto RESEND_KEY en el Worker' };
  const db = (await env.EXP.get('db', 'json')) || {};
  const locales = filasLocales(db), tomas = filasTomas(db), desest = filasDesestimados(db), agenda = filasAgenda(db);
  const blob = buildXlsx([
    { name: 'Locales', rows: locales, widths: [28, 16, 28, 11, 32, 16, 12, 12, 12, 10, 9, 11, 16, 14, 14, 14, 22, 15, 15, 22, 15, 15, 11, 38, 50, 50, 16, 14, 11, 40, 16, 12] },
    { name: 'Tomas de competencia', rows: tomas, widths: [22, 24, 24, 15, 15, 34, 16, 10, 14, 14, 10, 50, 50, 16, 14, 16, 12] },
    { name: 'Desestimados', rows: desest, widths: [28, 32, 16, 11, 12, 12, 34, 12, 22, 15, 15, 22, 38, 50, 50, 16, 14, 16] },
    { name: 'Agenda', rows: agenda, widths: [30, 22, 22, 20, 60] }]);
  const hoy = new Date().toISOString().slice(0, 10);
  const nDes = Object.values(db.locales || {}).filter((l) => l.estado === 'desestimado').length;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Expansión Centro <onboarding@resend.dev>',
      to: [env.DESTINO || 'bordetass@gmail.com'],
      subject: 'Expansión Centro · Excel semanal ' + hoy,
      text: 'Excel semanal de Expansión Centro.\n\n' + (locales.length - 1) + ' locales (' + nDes + ' desestimados) y ' + (tomas.length - 1) + ' tomas de competencia.\nHojas: Locales, Tomas de competencia, Desestimados y Agenda (' + (agenda.length - 1) + ' contactos).\n',
      attachments: [{ filename: 'expansion-centro-' + hoy + '.xlsx', content: aBase64(await blob.arrayBuffer()) }],
    }),
  });
  const txt = await r.text();
  return { ok: r.ok, status: r.status, respuesta: txt.slice(0, 300), locales: locales.length - 1, tomas: tomas.length - 1 };
}

/* ---- generador de .xlsx (el mismo que usa la app) ---- */
const CRC_T=(()=>{const t=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0}return t})();
const crc32=b=>{let c=0xFFFFFFFF;for(let i=0;i<b.length;i++)c=CRC_T[(c^b[i])&255]^(c>>>8);return(c^0xFFFFFFFF)>>>0};
function zipStore(files){
  const enc=new TextEncoder(),parts=[],cen=[];let off=0;
  const u16=n=>[n&255,(n>>8)&255],u32=n=>[n&255,(n>>8)&255,(n>>16)&255,(n>>>24)&255];
  for(const f of files){
    const nm=enc.encode(f.name),crc=crc32(f.data),sz=f.data.length;
    const lh=new Uint8Array([0x50,0x4b,3,4,...u16(20),...u16(0x0800),...u16(0),...u16(0),...u16(0x21),...u32(crc),...u32(sz),...u32(sz),...u16(nm.length),...u16(0)]);
    parts.push(lh,nm,f.data);
    cen.push(new Uint8Array([0x50,0x4b,1,2,...u16(20),...u16(20),...u16(0x0800),...u16(0),...u16(0),...u16(0x21),...u32(crc),...u32(sz),...u32(sz),...u16(nm.length),...u16(0),...u16(0),...u16(0),...u16(0),...u32(0),...u32(off)]),nm);
    off+=lh.length+nm.length+sz;
  }
  const cd=cen.reduce((n,a)=>n+a.length,0);
  const end=new Uint8Array([0x50,0x4b,5,6,...u16(0),...u16(0),...u16(files.length),...u16(files.length),...u32(cd),...u32(off),...u16(0)]);
  return new Blob([...parts,...cen,end],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
const xe=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');
const colName=i=>{let s='';i++;while(i>0){const m=(i-1)%26;s=String.fromCharCode(65+m)+s;i=Math.floor((i-1)/26)}return s};
/* celda: texto, número, {num,dec} (con decimales) o {url,t} (enlace pulsable) */
function sheetXml(rows,widths){
  const cols=`<cols>${widths.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;
  const body=rows.map((row,ri)=>`<row r="${ri+1}">${row.map((c,ci)=>{
    if(c==null||c==='')return'';
    const ref=colName(ci)+(ri+1);
    if(typeof c==='number')return`<c r="${ref}" s="4"><v>${c}</v></c>`;
    if(typeof c==='object'&&c.num!=null)return`<c r="${ref}" s="${c.dec==='coord'?6:c.dec?5:4}"><v>${c.num}</v></c>`;
    if(typeof c==='object'&&c.url){
      const u=String(c.url),t=String(c.t||c.url);
      if(u.length>240||t.length>240)return`<c r="${ref}" t="inlineStr" s="3"><is><t xml:space="preserve">${xe(u)}</t></is></c>`;
      return`<c r="${ref}" t="str" s="2"><f>HYPERLINK("${xe(u.replace(/"/g,'%22'))}","${xe(t.replace(/"/g,'""'))}")</f><v>${xe(t)}</v></c>`}
    return`<c r="${ref}" t="inlineStr" s="${ri===0?1:3}"><is><t xml:space="preserve">${xe(c)}</t></is></c>`}).join('')}</row>`).join('');
  const last=colName(rows[0].length-1)+rows.length;
  return`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${body}</sheetData><autoFilter ref="A1:${last}"/></worksheet>`;
}
function buildXlsx(sheets){
  const enc=new TextEncoder(),X='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const files=[
   {name:'[Content_Types].xml',s:`${X}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`},
   {name:'_rels/.rels',s:`${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`},
   {name:'xl/workbook.xml',s:`${X}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sh,i)=>`<sheet name="${xe(sh.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`},
   {name:'xl/_rels/workbook.xml.rels',s:`${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`},
   {name:'xl/styles.xml',s:`${X}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.0"/><numFmt numFmtId="165" formatCode="0.00000"/></numFmts><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1B7F95"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`}];
  sheets.forEach((sh,i)=>files.push({name:`xl/worksheets/sheet${i+1}.xml`,s:sheetXml(sh.rows,sh.widths)}));
  return zipStore(files.map(f=>({name:f.name,data:enc.encode(f.s)})));
}

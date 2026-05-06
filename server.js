const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const USERS = {
  marina: { pass:'Orum2026#Mar', rol:'comercial',    nombre:'Marina' },
  danilo: { pass:'Orum2026#Dan', rol:'comercial',    nombre:'Danilo' },
  maria:  { pass:'Orum2026#Mia', rol:'caja',         nombre:'María' },
  isabel: { pass:'Orum2026#Isa', rol:'contabilidad', nombre:'Isabel' },
  ana:    { pass:'Orum2026#Ana', rol:'contabilidad', nombre:'Ana' },
  sergio: { pass:'Orum2026#Ser', rol:'admin',        nombre:'Sergio' }
};

// Mapeo custom_4 → método de pago fianzas
const FIANZA_METODOS = {
  '0': 'Transferencia Bancaria',
  '3': 'Efectivo Marbella',
  '4': 'Efectivo Monda',
  '5': 'TPV',
  '6': 'TPV Marbella',
  '7': 'TPV Monda'
};

// Caché de fianzas en memoria
const cacheFianzas = { data: [], ts: 0 };
const FIANZAS_TTL = 5 * 60 * 1000; // 5 minutos

const AS_RUTAS_URL   = 'https://script.google.com/macros/s/AKfycbxaSfXi-D3Sx8Lpek6pHPaA-2_NgrXW6CTM0d37LlCX-x0hqRLM6BwyH-BIinyiJlAi/exec';
const AS_NC_URL      = 'https://script.google.com/macros/s/AKfycbx1ayolXUAmk95s8M2bUS_46O7HQrM4gmQgh1mQF9zOCuOvEQfp59K94TnDYpopE73QmA/exec';
const AS_FIANZAS_URL = process.env.AS_FIANZAS_URL || 'PON_AQUI_URL_FIANZAS_SCRIPT';
const CAJA_TOKEN     = 'ORUMx2026CajaStore';
const RUTAS_TOKEN    = 'ORUMx2026CajaStats';
const FIANZAS_TOKEN  = 'ORUMx2026#Fianzas$Secret';
const RENTMAN_TOKEN  = process.env.RENTMAN_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3NzMxNTM0MjIsIm1lZGV3ZXJrZXIiOjIzNSwiYWNjb3VudCI6InNlcnZpY2lvc3lhbHF1aWxlcnBhcmFldmVudG9zc2wiLCJjbGllbnRfdHlwZSI6Im9wZW5hcGkiLCJjbGllbnQubmFtZSI6Im9wZW5hcGkiLCJleHAiOjIwODg3NzI2MjIsImlzcyI6IntcIm5hbWVcIjpcImJhY2tlbmRcIixcInZlcnNpb25cIjpcIjQuODI4LjAuNlwifSJ9.hyHIfRnBGkLunqFAzG40c95AjpkWJfywelT_RiTcXDs';
const RENTMAN_URL    = 'https://api.rentman.net';

// ── Caché en memoria ──────────────────────────────────────────
const cache = {
  registros:  {},
  ticks:      {},
  cierres:    {},
  saldos:     {},
  nc_confs:   {}
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({ secret:'orum-caja-2026-secret', resave:false, saveUninitialized:false, cookie:{ maxAge:8*60*60*1000 } }));

function auth(req,res,next) { if(!req.session.user) return res.status(401).json({error:'No autenticado'}); next(); }
function authAdmin(req,res,next) { if(!req.session.user) return res.status(401).json({error:'No autenticado'}); if(req.session.user.rol!=='admin') return res.status(403).json({error:'Sin permisos'}); next(); }
function authContab(req,res,next) { if(!req.session.user) return res.status(401).json({error:'No autenticado'}); if(!['contabilidad','admin'].includes(req.session.user.rol)) return res.status(403).json({error:'Sin permisos'}); next(); }

// ── Helper AS GET (sigue redirects) ──────────────────────────
async function asGet(params) {
  const qs = new URLSearchParams(params).toString();
  let url = `${AS_RUTAS_URL}?${qs}`;
  let r;
  for (let i=0; i<6; i++) {
    r = await fetch(url, { redirect:'manual' });
    if ([301,302,307,308].includes(r.status)) { url = r.headers.get('location'); if (!url) break; }
    else break;
  }
  const text = await r.text();
  try { return JSON.parse(text); }
  catch(e) { throw new Error('AS no JSON: ' + text.substring(0,300)); }
}

// ── Helper AS POST (sigue redirects) ─────────────────────────
async function asPost(body) {
  let url = AS_RUTAS_URL;
  let r;
  for (let i=0; i<6; i++) {
    r = await fetch(url, { method:'POST', redirect:'manual', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    if ([301,302,307,308].includes(r.status)) { url = r.headers.get('location'); if (!url) break; }
    else break;
  }
  const text = await r.text();
  try { return JSON.parse(text); }
  catch(e) { throw new Error('AS no JSON: ' + text.substring(0,300)); }
}

// ── Helper AS NC GET ──────────────────────────────────────────
async function asGetNC(params) {
  const qs = new URLSearchParams(params).toString();
  let url = `${AS_NC_URL}?${qs}`;
  let r;
  for (let i=0; i<6; i++) {
    r = await fetch(url, { redirect:'manual' });
    if ([301,302,307,308].includes(r.status)) { url = r.headers.get('location'); if (!url) break; }
    else break;
  }
  const text = await r.text();
  try { return JSON.parse(text); }
  catch(e) { throw new Error('NC no JSON: ' + text.substring(0,300)); }
}

// ── Cargar caché desde Sheet ──────────────────────────────────
async function recargarCache() {
  try {
    console.log('[Cache] Cargando...');
    const [rReg, rTick, rCierres, rSaldos, rNC] = await Promise.all([
      asGet({ token:RUTAS_TOKEN, action:'get_registros', desde:'', hasta:'' }),
      asGet({ token:RUTAS_TOKEN, action:'get_ticks',     desde:'', hasta:'' }),
      asGet({ token:RUTAS_TOKEN, action:'get_cierres' }),
      asGet({ token:RUTAS_TOKEN, action:'get_saldos'  }),
      asGet({ token:RUTAS_TOKEN, action:'get_nc_confs'}),
    ]);
    // Registros: convertir array a objeto keyed por factura_id
    cache.registros = {};
    (rReg.data||[]).forEach(r => { if(r.factura_id!==''&&r.factura_id!=null) cache.registros[String(r.factura_id)] = r; });
    // Ticks
    cache.ticks = rTick.data || {};
    // Cierres
    cache.cierres = rCierres.data || {};
    // Saldos
    cache.saldos = rSaldos.data || {};
    // NC Confirmaciones
    cache.nc_confs = rNC.data || {};
    console.log(`[Cache] OK — registros:${Object.keys(cache.registros).length} ticks:${Object.keys(cache.ticks).length}`);
  } catch(e) { console.error('[Cache] Error:', e.message); }
}

// Carga inicial al arrancar
recargarCache();

// ── AUTH ──────────────────────────────────────────────────────
app.post('/api/login', (req,res) => {
  const { usuario, password } = req.body;
  const u = USERS[usuario?.toLowerCase()];
  if (!u||u.pass!==password) return res.status(401).json({error:'Credenciales incorrectas'});
  req.session.user = { usuario, rol:u.rol, nombre:u.nombre };
  res.json({ ok:true, usuario, rol:u.rol, nombre:u.nombre });
});
app.post('/api/logout', (req,res) => { req.session.destroy(); res.json({ok:true}); });
app.get('/api/me', auth, (req,res) => res.json(req.session.user));

// ── TICKS ─────────────────────────────────────────────────────
app.get('/api/ticks', auth, (req,res) => {
  const { desde, hasta } = req.query;
  if (!desde||!hasta) return res.json(cache.ticks);
  const f = {};
  Object.entries(cache.ticks).forEach(([k,v]) => {
    const d = k.split('_')[0];
    if (d>=desde&&d<=hasta) f[k]=v;
  });
  res.json(f);
});

app.post('/api/tick', authContab, async (req,res) => {
  const { key, valor, nota, usuario } = req.body;
  if (!key) return res.status(400).json({error:'key requerida'});
  if (valor===null||valor===undefined) delete cache.ticks[key];
  else cache.ticks[key] = { valor, nota:nota||'', usuario:usuario||'', fecha:new Date().toISOString() };
  res.json({ok:true});
  asPost({ token:CAJA_TOKEN, action:'set_tick', key, valor:valor??null, nota:nota||'', usuario:usuario||'' })
    .catch(e => console.error('[BG tick]', e.message));
});

// ── REGISTROS CAJA ────────────────────────────────────────────
app.get('/api/caja/registros', auth, (req,res) => {
  const { desde, hasta } = req.query;
  if (!desde||!hasta) return res.json(cache.registros);
  const f = {};
  Object.entries(cache.registros).forEach(([k,v]) => {
    if (v.fecha_pago>=desde&&v.fecha_pago<=hasta) f[k]=v;
  });
  res.json(f);
});

app.post('/api/caja/registro', auth, async (req,res) => {
  const { factura_id, metodo_pago, ubicacion, tipo, importe, cliente, numero, fecha_pago, es_abrebotellas, usuario, num_operacion } = req.body;
  if (!factura_id) return res.status(400).json({error:'factura_id requerido'});
  const key = String(factura_id);
  if (metodo_pago===null||metodo_pago===undefined) {
    delete cache.registros[key];
  } else {
    cache.registros[key] = { factura_id:key, metodo_pago, ubicacion, tipo, importe, cliente, numero, fecha_pago, es_abrebotellas, usuario, num_operacion:num_operacion||'', updated:new Date().toISOString() };
  }
  res.json({ok:true});
  asPost({ token:CAJA_TOKEN, action:'set_registro', ...req.body })
    .catch(e => console.error('[BG registro]', e.message));
});

// ── CIERRES ───────────────────────────────────────────────────
app.get('/api/cierres', auth, (req,res) => res.json(cache.cierres));

app.post('/api/cierre', auth, async (req,res) => {
  const { caja, desde, hasta, total_ef, total_tpv, total_transf, retiradas, saldo_anterior, saldo_final, usuario } = req.body;
  if (!caja||!desde||!hasta) return res.status(400).json({error:'caja, desde y hasta requeridos'});
  const periodoKey = `${desde}_${hasta}`;
  if (!cache.cierres[caja]) cache.cierres[caja] = {};
  cache.cierres[caja][periodoKey] = { caja, desde, hasta, total_ef:total_ef||0, total_tpv:total_tpv||0, total_transf:total_transf||0, retiradas:retiradas||[], saldo_anterior:saldo_anterior||0, saldo_final:saldo_final||0, usuario:usuario||'', ts:new Date().toISOString() };
  cache.saldos[caja] = { efectivo_final:saldo_final||0, fecha:hasta, usuario:usuario||'', updated:new Date().toISOString() };
  res.json({ok:true});
  asPost({ token:CAJA_TOKEN, action:'set_cierre', ...req.body })
    .catch(e => console.error('[BG cierre]', e.message));
});

app.get('/api/cierre/verificar', auth, (req,res) => {
  const { caja, desde } = req.query;
  if (!caja||!desde) return res.status(400).json({error:'caja y desde requeridos'});
  const cajaCierres = cache.cierres[caja]||{};
  const periodoKey = Object.keys(cajaCierres).find(k => {
    const [d,h] = k.split('_');
    return d===desde || (d<=desde&&h>=desde);
  });
  if (periodoKey) {
    const c = cajaCierres[periodoKey];
    return res.json({ok:false, puede_cerrar:false, mensaje:`Esta caja ya fue cerrada el ${new Date(c.ts).toLocaleString('es-ES')} por ${c.usuario}`});
  }
  return res.json({ok:true, puede_cerrar:true, mensaje:null});
});

// ── SALDOS ────────────────────────────────────────────────────
app.get('/api/saldos', auth, (req,res) => res.json(cache.saldos));

// ── HISTORIAL ─────────────────────────────────────────────────
app.get('/api/historial', authAdmin, async (req,res) => {
  try {
    const { desde, hasta, limit } = req.query;
    const data = await asGet({ token:RUTAS_TOKEN, action:'get_historial', desde:desde||'', hasta:hasta||'', limit:limit||200 });
    const arr = data.data||[];
    const obj = {};
    arr.forEach((r,i) => { obj[String(Date.now()-i)] = r; });
    res.json(obj);
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── NC CONFIRMACIONES ─────────────────────────────────────────
app.get('/api/nc/confirmaciones', auth, (req,res) => res.json(cache.nc_confs));

app.post('/api/nc/confirmar', authContab, async (req,res) => {
  const { nc_id, confirmar } = req.body;
  if (!nc_id) return res.status(400).json({error:'nc_id requerido'});
  if (confirmar===false) delete cache.nc_confs[String(nc_id)];
  else cache.nc_confs[String(nc_id)] = { confirmado:true, usuario:req.body.usuario||'', ts:new Date().toISOString(), ...req.body };
  res.json({ok:true});
  asPost({ token:CAJA_TOKEN, action:'set_nc_conf', ...req.body })
    .catch(e => console.error('[BG nc_conf]', e.message));
});

// ── PROXY NO CONFIRMADOS ──────────────────────────────────────
app.get('/api/noconfirmados', auth, async (req,res) => {
  try {
    const data = await asGetNC({ token:'ORUMx2026CajaStats', action:'registros', desde:req.query.desde||'', hasta:req.query.hasta||'' });
    res.json(data);
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── FACTURAS RENTMAN (invoicepayments directo) ────────────────
app.get('/api/caja/facturas', auth, async (req,res) => {
  try {
    const { desde, hasta } = req.query;
    // Paginar invoicepayments directamente desde Rentman
    let all = [];
    let offset = 0;
    const limit = 100;
    while (true) {
      const url = `${RENTMAN_URL}/invoicepayments?limit=${limit}&offset=${offset}&paymentdate%5Bgte%5D=${encodeURIComponent(desde+' 00:00:00')}&paymentdate%5Blte%5D=${encodeURIComponent(hasta+' 23:59:59')}`;
      const r = await fetch(url, { headers:{ Authorization:`Bearer ${RENTMAN_TOKEN}` } });
      const data = await r.json();
      const items = data.data||[];
      all = all.concat(items);
      if (items.length < limit) break;
      offset += limit;
    }
    res.json({ facturas: all });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── CONTACTO RENTMAN ──────────────────────────────────────────
app.get('/api/contacto/:id', auth, async (req,res) => {
  try {
    const r = await fetch(`${RENTMAN_URL}/contacts/${req.params.id}`, { headers:{ Authorization:`Bearer ${RENTMAN_TOKEN}` } });
    const data = await r.json();
    res.json({ ok:true, data: data.data||null });
  } catch(e) { res.status(500).json({ok:false, error:e.message}); }
});

// ── PROYECTO RENTMAN ───────────────────────────────────────────
app.get('/api/proyecto/:id', auth, async (req,res) => {
  try {
    const r = await fetch(`${RENTMAN_URL}/projects/${req.params.id}`, { headers:{ Authorization:`Bearer ${RENTMAN_TOKEN}` } });
    const data = await r.json();
    res.json({ ok:true, data: data.data||null });
  } catch(e) { res.status(500).json({ok:false, error:e.message}); }
});

// ── RECARGAR CACHÉ (admin) ────────────────────────────────────
app.post('/api/cache/reload', authAdmin, async (req,res) => {
  res.json({ok:true, mensaje:'Recargando...'});
  recargarCache();
});

// ── FIANZAS ────────────────────────────────────────────────────
async function fetchFianzasRentman() {
  let all = [];
  let offset = 0;
  const limit = 300;
  while (true) {
    const r = await fetch(`${RENTMAN_URL}/projects?limit=${limit}&offset=${offset}`, {
      headers: { Authorization: `Bearer ${RENTMAN_TOKEN}` }
    });
    const data = await r.json();
    const items = data.data || [];
    all = all.concat(items);
    if (items.length < limit) break;
    offset += limit;
  }

  // Los campos custom vienen dentro de p.custom.custom_3 etc.
  const proyectos = all.filter(p => {
    const c = p.custom || {};
    const c3 = parseFloat(c.custom_3) || 0;
    const c5 = String(c.custom_5 != null ? c.custom_5 : '0');
    return c3 > 0 && (c5 === '1' || c5 === '2');
  });

  const estadoMap = { '0': 'Pendiente', '1': 'Pagada', '2': 'Devuelta' };

  // Enriquecer clientes en batch de 20
  const contactoIds = [...new Set(proyectos.map(p => p.customer).filter(Boolean).map(c => c.replace('/contacts/', '')))];
  const contactoMap = {};
  for (let i = 0; i < contactoIds.length; i += 20) {
    const batch = contactoIds.slice(i, i + 20);
    await Promise.all(batch.map(async id => {
      try {
        const r = await fetch(`${RENTMAN_URL}/contacts/${id}`, { headers: { Authorization: `Bearer ${RENTMAN_TOKEN}` } });
        const d = await r.json();
        if (d.data) {
          contactoMap[id] = d.data.displayname || [d.data.firstname, d.data.surname].filter(Boolean).join(' ') || '';
        } else {
          console.warn(`[Fianzas] Contacto ${id} sin data:`, JSON.stringify(d).substring(0,200));
        }
      } catch(e) { console.warn(`[Fianzas] Error contacto ${id}:`, e.message); }
    }));
  }

  // Enriquecer comerciales
  const comercialIds = [...new Set(proyectos.map(p => p.account_manager).filter(Boolean).map(c => c.replace('/crew/', '')))];
  const comercialMap = {};
  for (let i = 0; i < comercialIds.length; i += 20) {
    const batch = comercialIds.slice(i, i + 20);
    await Promise.all(batch.map(async id => {
      try {
        const r = await fetch(`${RENTMAN_URL}/crew/${id}`, { headers: { Authorization: `Bearer ${RENTMAN_TOKEN}` } });
        const d = await r.json();
        if (d.data) comercialMap[id] = d.data.displayname || '';
      } catch(e) {}
    }));
  }

  return proyectos.map(p => {
    const c = p.custom || {};
    const cId = (p.customer || '').replace('/contacts/', '');
    const amId = (p.account_manager || '').replace('/crew/', '');
    const c5 = String(c.custom_5 != null ? c.custom_5 : '0');
    const metodoCod = String(c.custom_4 != null ? c.custom_4 : '0');
    return {
      id: p.id,
      numero: String(p.number || ''),
      nombre: p.name || '',
      cliente: contactoMap[cId] || cId,
      comercial: comercialMap[amId] || '',
      fecha_inicio: (p.planperiod_start || '').substring(0, 10),
      fecha_fin: (p.planperiod_end || '').substring(0, 10),
      importe: parseFloat(c.custom_3) || 0,
      metodo: FIANZA_METODOS[metodoCod] || 'Transferencia Bancaria',
      metodo_id: metodoCod,
      estado: estadoMap[c5] || 'Pendiente',
      estado_id: c5
    };
  });
}

app.get('/api/fianzas', auth, async (req, res) => {
  try {
    const ahora = Date.now();
    if (ahora - cacheFianzas.ts < FIANZAS_TTL && cacheFianzas.data.length > 0) {
      return res.json({ ok: true, data: cacheFianzas.data, cached: true });
    }
    const data = await fetchFianzasRentman();
    cacheFianzas.data = data;
    cacheFianzas.ts = Date.now();
    res.json({ ok: true, data, cached: false });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/fianzas/:id/estado', auth, async (req, res) => {
  try {
    const { estado } = req.body; // '0'=Pendiente, '1'=Pagada, '2'=Devuelta
    if (!['0','1','2'].includes(String(estado))) return res.status(400).json({ ok:false, error:'Estado inválido' });
    const r = await fetch(`${RENTMAN_URL}/projects/${req.params.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${RENTMAN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ custom: { custom_5: String(estado) } })
    });
    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ ok: false, error: err });
    }
    cacheFianzas.ts = 0;
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/fianzas/cache/reload', auth, async (req, res) => {
  try {
    const data = await fetchFianzasRentman();
    cacheFianzas.data = data;
    cacheFianzas.ts = Date.now();
    res.json({ ok: true, data, count: data.length });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Helper AS Fianzas ─────────────────────────────────────────
async function asFianzasGet(params) {
  const qs = new URLSearchParams(params).toString();
  let url = `${AS_FIANZAS_URL}?${qs}`;
  let r;
  for (let i = 0; i < 6; i++) {
    r = await fetch(url, { redirect: 'manual' });
    if ([301,302,307,308].includes(r.status)) { url = r.headers.get('location'); if (!url) break; }
    else break;
  }
  const text = await r.text();
  try { return JSON.parse(text); }
  catch(e) { throw new Error('AS Fianzas no JSON: ' + text.substring(0, 300)); }
}

async function asFianzasPost(body) {
  let url = AS_FIANZAS_URL;
  let r;
  for (let i = 0; i < 6; i++) {
    r = await fetch(url, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if ([301,302,307,308].includes(r.status)) { url = r.headers.get('location'); if (!url) break; }
    else break;
  }
  const text = await r.text();
  try { return JSON.parse(text); }
  catch(e) { throw new Error('AS Fianzas no JSON: ' + text.substring(0, 300)); }
}

// ── SOLICITUDES FIANZAS ───────────────────────────────────────
// Caché de solicitudes en memoria
const cacheSolicitudes = { data: [], ts: 0 };
const SOLICITUDES_TTL = 2 * 60 * 1000; // 2 minutos

app.get('/api/fianzas/solicitudes', auth, async (req, res) => {
  try {
    const ahora = Date.now();
    if (ahora - cacheSolicitudes.ts < SOLICITUDES_TTL && cacheSolicitudes.data.length > 0) {
      return res.json({ ok: true, data: cacheSolicitudes.data, cached: true });
    }
    const d = await asFianzasGet({ token: FIANZAS_TOKEN, action: 'get_solicitudes' });
    if (!d.ok) return res.status(500).json(d);
    cacheSolicitudes.data = d.data || [];
    cacheSolicitudes.ts = Date.now();
    res.json({ ok: true, data: cacheSolicitudes.data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/fianzas/solicitar', auth, async (req, res) => {
  try {
    const d = await asFianzasPost({ token: FIANZAS_TOKEN, action: 'crear_solicitud', ...req.body });
    cacheSolicitudes.ts = 0; // invalidar caché
    cacheFianzas.ts = 0;
    res.json(d);
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/fianzas/rentman-devuelta', auth, async (req, res) => {
  try {
    const { proyecto_id } = req.body;
    const r = await fetch(`${RENTMAN_URL}/projects/${proyecto_id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${RENTMAN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ custom: { custom_5: '2' } })
    });
    if (!r.ok) { const err = await r.text(); return res.status(r.status).json({ ok: false, error: err }); }
    cacheFianzas.ts = 0;
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/fianzas/devolver', auth, async (req, res) => {
  try {
    const { solicitud_id, proyecto_id, notas } = req.body;
    // 1. Marcar devuelta en Sheet
    const d = await asFianzasPost({ token: FIANZAS_TOKEN, action: 'marcar_devuelta', id: solicitud_id, notas: notas || '' });
    if (!d.ok) return res.status(500).json(d);
    // 2. Actualizar custom_5=2 en Rentman
    await fetch(`${RENTMAN_URL}/projects/${proyecto_id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${RENTMAN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ custom: { custom_5: '2' } })
    });
    cacheSolicitudes.ts = 0;
    cacheFianzas.ts = 0;
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/fianzas/notificar', auth, async (req, res) => {
  try {
    const { solicitud_id, notificado } = req.body;
    const d = await asFianzasPost({ token: FIANZAS_TOKEN, action: 'marcar_notificado', id: solicitud_id, notificado: notificado !== false });
    cacheSolicitudes.ts = 0;
    res.json(d);
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/fianzas/cancelar-solicitud', auth, async (req, res) => {
  try {
    const d = await asFianzasPost({ token: FIANZAS_TOKEN, action: 'cancelar_solicitud', id: req.body.solicitud_id });
    cacheSolicitudes.ts = 0;
    res.json(d);
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT, ()=>console.log('ORUM Caja puerto '+PORT));

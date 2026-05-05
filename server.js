const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const USERS = {
  marina: { pass:'Orum2026#Mar', rol:'caja',         nombre:'Marina' },
  danilo: { pass:'Orum2026#Dan', rol:'caja',         nombre:'Danilo' },
  maria:  { pass:'Orum2026#Mia', rol:'caja',         nombre:'María' },
  isabel: { pass:'Orum2026#Isa', rol:'contabilidad', nombre:'Isabel' },
  ana:    { pass:'Orum2026#Ana', rol:'contabilidad', nombre:'Ana' },
  sergio: { pass:'Orum2026#Ser', rol:'admin',        nombre:'Sergio' }
};

const AS_RUTAS_URL = 'https://script.google.com/macros/s/AKfycbxaSfXi-D3Sx8Lpek6pHPaA-2_NgrXW6CTM0d37LlCX-x0hqRLM6BwyH-BIinyiJlAi/exec';
const AS_NC_URL    = 'https://script.google.com/macros/s/AKfycbx1ayolXUAmk95s8M2bUS_46O7HQrM4gmQgh1mQF9zOCuOvEQfp59K94TnDYpopE73QmA/exec';
const CAJA_TOKEN   = 'ORUMx2026CajaStore';
const RUTAS_TOKEN  = 'ORUMx2026CajaStats';

// ── Caché en memoria (respuesta inmediata al usuario, sync en background) ──
const cache = {
  registros:       {},  // { factura_id: {...} }
  ticks:           {},  // { key: {...} }
  cierres:         {},  // { caja: { periodo: {...} } }
  saldos:          {},  // { caja: {...} }
  nc_confs:        {},  // { nc_id: {...} }
  loaded:          { registros:false, ticks:false, cierres:false, saldos:false, nc_confs:false }
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({ secret:'orum-caja-2026-secret', resave:false, saveUninitialized:false, cookie:{ maxAge:8*60*60*1000 } }));

function auth(req,res,next) { if(!req.session.user) return res.status(401).json({error:'No autenticado'}); next(); }
function authAdmin(req,res,next) { if(!req.session.user) return res.status(401).json({error:'No autenticado'}); if(req.session.user.rol!=='admin') return res.status(403).json({error:'Sin permisos'}); next(); }
function authContab(req,res,next) { if(!req.session.user) return res.status(401).json({error:'No autenticado'}); if(!['contabilidad','admin'].includes(req.session.user.rol)) return res.status(403).json({error:'Sin permisos'}); next(); }

// ── Helper AS GET (sigue redirects) ──────────────────────────
async function asGet(baseUrl, params) {
  const qs = new URLSearchParams(params).toString();
  let url = `${baseUrl}?${qs}`;
  let r;
  for (let i=0; i<6; i++) {
    r = await fetch(url, { redirect:'manual' });
    if ([301,302,307,308].includes(r.status)) { url = r.headers.get('location'); if (!url) break; }
    else break;
  }
  const text = await r.text();
  try { return JSON.parse(text); }
  catch(e) { throw new Error('AS no JSON: ' + text.substring(0,200)); }
}

// ── Helper AS POST (sigue redirects) ─────────────────────────
async function asPost(baseUrl, body) {
  let url = baseUrl;
  let r;
  for (let i=0; i<6; i++) {
    r = await fetch(url, { method:'POST', redirect:'manual', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    if ([301,302,307,308].includes(r.status)) { url = r.headers.get('location'); if (!url) break; }
    else break;
  }
  const text = await r.text();
  try { return JSON.parse(text); }
  catch(e) { throw new Error('AS no JSON: ' + text.substring(0,200)); }
}

// ── Cargar caché desde Sheet (background) ────────────────────
async function cargarCacheRegistros() {
  try {
    const data = await asGet(AS_RUTAS_URL, { token:RUTAS_TOKEN, action:'get_registros', desde:'', hasta:'' });
    const arr = data.data || [];
    cache.registros = {};
    arr.forEach(r => {
      if (r.factura_id !== '' && r.factura_id !== null && r.factura_id !== undefined) {
        cache.registros[String(r.factura_id)] = r;
      }
    });
    cache.loaded.registros = true;
    console.log(`[Cache] Registros cargados: ${arr.length}`);
  } catch(e) { console.error('[Cache] Error registros:', e.message); }
}

async function cargarCacheTicks() {
  try {
    const data = await asGet(AS_RUTAS_URL, { token:RUTAS_TOKEN, action:'get_ticks', desde:'', hasta:'' });
    cache.ticks = data.data || {};
    cache.loaded.ticks = true;
    console.log(`[Cache] Ticks cargados: ${Object.keys(cache.ticks).length}`);
  } catch(e) { console.error('[Cache] Error ticks:', e.message); }
}

async function cargarCacheCierres() {
  try {
    const data = await asGet(AS_RUTAS_URL, { token:RUTAS_TOKEN, action:'get_cierres' });
    cache.cierres = data.data || {};
    cache.loaded.cierres = true;
  } catch(e) { console.error('[Cache] Error cierres:', e.message); }
}

async function cargarCacheSaldos() {
  try {
    const data = await asGet(AS_RUTAS_URL, { token:RUTAS_TOKEN, action:'get_saldos' });
    cache.saldos = data.data || {};
    cache.loaded.saldos = true;
  } catch(e) { console.error('[Cache] Error saldos:', e.message); }
}

async function cargarCacheNcConfs() {
  try {
    const data = await asGet(AS_RUTAS_URL, { token:RUTAS_TOKEN, action:'get_nc_confs' });
    cache.nc_confs = data.data || {};
    cache.loaded.nc_confs = true;
  } catch(e) { console.error('[Cache] Error nc_confs:', e.message); }
}

// Carga inicial al arrancar
(async () => {
  console.log('[Cache] Cargando datos iniciales...');
  await Promise.all([
    cargarCacheRegistros(),
    cargarCacheTicks(),
    cargarCacheCierres(),
    cargarCacheSaldos(),
    cargarCacheNcConfs()
  ]);
  console.log('[Cache] Carga inicial completa');
})();

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

// ── TICKS — respuesta inmediata desde caché ───────────────────
app.get('/api/ticks', auth, (req,res) => {
  const { desde, hasta } = req.query;
  if (!desde || !hasta) return res.json(cache.ticks);
  const f = {};
  Object.entries(cache.ticks).forEach(([k,v]) => {
    const d = k.split('_')[0];
    if (d >= desde && d <= hasta) f[k] = v;
  });
  res.json(f);
});

app.post('/api/tick', authContab, async (req,res) => {
  const { key, valor, nota, usuario } = req.body;
  if (!key) return res.status(400).json({error:'key requerida'});
  // Actualizar caché inmediatamente
  if (valor === null || valor === undefined) delete cache.ticks[key];
  else cache.ticks[key] = { valor, nota:nota||'', usuario:usuario||'', fecha:new Date().toISOString() };
  // Responder al instante
  res.json({ok:true});
  // Sync en background
  asPost(AS_RUTAS_URL, { token:CAJA_TOKEN, action:'set_tick', key, valor:valor??null, nota:nota||'', usuario:usuario||'' })
    .catch(e => console.error('[BG] tick error:', e.message));
});

// ── REGISTROS CAJA — respuesta inmediata desde caché ─────────
app.get('/api/caja/registros', auth, (req,res) => {
  const { desde, hasta } = req.query;
  if (!desde || !hasta) return res.json(cache.registros);
  const f = {};
  Object.entries(cache.registros).forEach(([k,v]) => {
    if (v.fecha_pago >= desde && v.fecha_pago <= hasta) f[k] = v;
  });
  res.json(f);
});

app.post('/api/caja/registro', auth, async (req,res) => {
  const { factura_id, metodo_pago, ubicacion, tipo, importe, cliente, numero, fecha_pago, es_abrebotellas, usuario, num_operacion } = req.body;
  if (!factura_id) return res.status(400).json({error:'factura_id requerido'});
  const key = String(factura_id);
  // Actualizar caché inmediatamente
  if (metodo_pago === null || metodo_pago === undefined) {
    delete cache.registros[key];
  } else {
    cache.registros[key] = { factura_id:key, metodo_pago, ubicacion, tipo, importe, cliente, numero, fecha_pago, es_abrebotellas, usuario, num_operacion:num_operacion||'', updated:new Date().toISOString() };
  }
  // Responder al instante
  res.json({ok:true});
  // Sync en background
  asPost(AS_RUTAS_URL, { token:CAJA_TOKEN, action:'set_registro', ...req.body })
    .catch(e => console.error('[BG] registro error:', e.message));
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
  asPost(AS_RUTAS_URL, { token:CAJA_TOKEN, action:'set_cierre', ...req.body })
    .catch(e => console.error('[BG] cierre error:', e.message));
});

app.get('/api/cierre/verificar', auth, (req,res) => {
  const { caja, desde } = req.query;
  if (!caja||!desde) return res.status(400).json({error:'caja y desde requeridos'});
  const cajaCierres = cache.cierres[caja]||{};
  const periodoKey = Object.keys(cajaCierres).find(k => {
    const [d,h] = k.split('_');
    return d===desde || (d<=desde && h>=desde);
  });
  if (periodoKey) {
    const c = cajaCierres[periodoKey];
    return res.json({ok:false,puede_cerrar:false,mensaje:`Esta caja ya fue cerrada el ${new Date(c.ts).toLocaleString('es-ES')} por ${c.usuario}`});
  }
  return res.json({ok:true,puede_cerrar:true,mensaje:null});
});

// ── SALDOS ────────────────────────────────────────────────────
app.get('/api/saldos', auth, (req,res) => res.json(cache.saldos));

// ── HISTORIAL ─────────────────────────────────────────────────
app.get('/api/historial', authAdmin, async (req,res) => {
  try {
    const { desde, hasta, limit } = req.query;
    const data = await asGet(AS_RUTAS_URL, { token:RUTAS_TOKEN, action:'get_historial', desde:desde||'', hasta:hasta||'', limit:limit||100 });
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
  if (confirmar === false) delete cache.nc_confs[String(nc_id)];
  else cache.nc_confs[String(nc_id)] = { confirmado:true, usuario:req.body.usuario||'', ts:new Date().toISOString(), ...req.body };
  res.json({ok:true});
  asPost(AS_RUTAS_URL, { token:CAJA_TOKEN, action:'set_nc_conf', ...req.body })
    .catch(e => console.error('[BG] nc_conf error:', e.message));
});

// ── PROXY NO CONFIRMADOS ──────────────────────────────────────
app.get('/api/noconfirmados', auth, async (req,res) => {
  const { desde, hasta } = req.query;
  try {
    const data = await asGet(AS_NC_URL, { token:'ORUMx2026CajaStats', action:'registros', desde, hasta });
    res.json(data);
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── PROXY RENTMAN (facturas) ──────────────────────────────────
app.get('/api/caja/facturas', auth, async (req,res) => {
  try {
    const { desde, hasta } = req.query;
    const data = await asGet(AS_RUTAS_URL, { token:RUTAS_TOKEN, action:'invoicepayments', desde, hasta });
    res.json(data.data ? { facturas: data.data } : data);
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── Endpoint para forzar recarga de caché ─────────────────────
app.post('/api/cache/reload', authAdmin, async (req,res) => {
  res.json({ok:true, mensaje:'Recargando en background...'});
  await Promise.all([cargarCacheRegistros(), cargarCacheTicks(), cargarCacheCierres(), cargarCacheSaldos(), cargarCacheNcConfs()]);
  console.log('[Cache] Recarga manual completada');
});

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT, ()=>console.log('ORUM Caja puerto '+PORT));

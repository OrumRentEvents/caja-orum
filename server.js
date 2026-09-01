const express = require('express');
const session = require('express-session');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const app = express();

// Sincronización en tiempo real a Supabase (Caja no pasa por ORUM CENTRAL,
// así que se engancha aquí directo). Si faltan las variables, se omite sin
// romper nada - Caja sigue funcionando igual que siempre, solo que ese
// registro no llegaría a Supabase hasta el próximo sync de 15 min (si
// existe algún proceso que lo recoja desde ahí más adelante).
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;
async function supabaseCajaUpsert(row) {
  if (!supabase) return;
  try {
    const { error } = await supabase.from('caja_registros').upsert(row, { onConflict: 'factura_id' });
    if (error) console.error('[Supabase caja upsert]', error.message);
  } catch (e) {
    console.error('[Supabase caja upsert] excepción:', e.message);
  }
}
async function supabaseCajaDelete(facturaId) {
  if (!supabase) return;
  try {
    const { error } = await supabase.from('caja_registros').delete().eq('factura_id', String(facturaId));
    if (error) console.error('[Supabase caja delete]', error.message);
  } catch (e) {
    console.error('[Supabase caja delete] excepción:', e.message);
  }
}
const PORT = process.env.PORT || 3000;
const USERS = {
  marina: { pass:'Orum2026#Mar', rol:'comercial',    nombre:'Marina' },
  danilo: { pass:'Orum2026#Dan', rol:'comercial',    nombre:'Danilo' },
  maria:  { pass:'Orum2026#Mia', rol:'caja',         nombre:'María' },
  lucas:  { pass:'Orum2026#Luc', rol:'caja',         nombre:'Lucas' },
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
  nc_confs:   {},
  retiradas:  { marbella:[], monda:[], marbella_nc:[], monda_nc:[] }
};
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({ secret:'orum-caja-2026-secret', resave:false, saveUninitialized:false, cookie:{ maxAge:8*60*60*1000 } }));
function auth(req,res,next) { if(!req.session.user) return res.status(401).json({error:'No autenticado'}); next(); }
function authAdmin(req,res,next) { if(!req.session.user) return res.status(401).json({error:'No autenticado'}); if(req.session.user.rol!=='admin') return res.status(403).json({error:'Sin permisos'}); next(); }
function authContab(req,res,next) { if(!req.session.user) return res.status(401).json({error:'No autenticado'}); if(!['contabilidad','admin'].includes(req.session.user.rol)) return res.status(403).json({error:'Sin permisos'}); next(); }
function authCaja(req,res,next) { if(!req.session.user) return res.status(401).json({error:'No autenticado'}); if(!['caja','admin'].includes(req.session.user.rol)) return res.status(403).json({error:'Sin permisos'}); next(); }
// Registro de Cobros: comerciales también pueden anotar cobros/devoluciones
// de sus propios proyectos, no solo Caja/admin/contabilidad.
function authCobros(req,res,next) { if(!req.session.user) return res.status(401).json({error:'No autenticado'}); if(!['comercial','caja','admin','contabilidad'].includes(req.session.user.rol)) return res.status(403).json({error:'Sin permisos'}); next(); }
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
// ── Helper AS NC POST (sigue redirects) ────────────────────────
async function asPostNC(body) {
  let url = AS_NC_URL;
  let r;
  for (let i=0; i<6; i++) {
    r = await fetch(url, { method:'POST', redirect:'manual', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    if ([301,302,307,308].includes(r.status)) { url = r.headers.get('location'); if (!url) break; }
    else break;
  }
  const text = await r.text();
  try { return JSON.parse(text); }
  catch(e) { throw new Error('NC POST no JSON: ' + text.substring(0,300)); }
}
// ── Cargar caché desde Sheet ──────────────────────────────────
async function recargarCache() {
  try {
    console.log('[Cache] Cargando...');
    const [rReg, rTick, rCierres, rSaldos, rNC, rRet] = await Promise.all([
      asGet({ token:RUTAS_TOKEN, action:'get_registros', desde:'', hasta:'' }),
      asGet({ token:RUTAS_TOKEN, action:'get_ticks',     desde:'', hasta:'' }),
      asGet({ token:RUTAS_TOKEN, action:'get_cierres' }),
      asGet({ token:RUTAS_TOKEN, action:'get_saldos'  }),
      asGet({ token:RUTAS_TOKEN, action:'get_nc_confs'}),
      asGet({ token:RUTAS_TOKEN, action:'get_retiradas'}).catch(()=>({data:{marbella:[],monda:[],marbella_nc:[],monda_nc:[]}})),
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
    // Retiradas pendientes (no cerradas aún)
    const retData = rRet.data || {};
    cache.retiradas = {
      marbella:    Array.isArray(retData.marbella)    ? retData.marbella    : [],
      monda:       Array.isArray(retData.monda)       ? retData.monda       : [],
      marbella_nc: Array.isArray(retData.marbella_nc) ? retData.marbella_nc : [],
      monda_nc:    Array.isArray(retData.monda_nc)    ? retData.monda_nc    : [],
    };
    console.log(`[Cache] OK — registros:${Object.keys(cache.registros).length} ticks:${Object.keys(cache.ticks).length} retiradas_marb:${cache.retiradas.marbella.length}`);
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
    supabaseCajaDelete(key).catch(() => {}); // fire-and-forget, no bloquea la respuesta
  } else {
    const registro = { factura_id:key, metodo_pago, ubicacion, tipo, importe, cliente, numero, fecha_pago, es_abrebotellas, usuario, num_operacion:num_operacion||'', updated:new Date().toISOString() };
    cache.registros[key] = registro;
    supabaseCajaUpsert({
      factura_id: registro.factura_id, metodo_pago: registro.metodo_pago, ubicacion: registro.ubicacion,
      tipo: registro.tipo, importe: registro.importe, cliente: registro.cliente, numero: registro.numero,
      es_abrebotellas: !!registro.es_abrebotellas, usuario: registro.usuario, num_operacion: registro.num_operacion,
      fecha_pago_raw: registro.fecha_pago, updated_raw: registro.updated
    }).catch(() => {}); // fire-and-forget, no bloquea la respuesta
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
// ── RETIRADAS PERSISTENTES ───────────────────────────────────
app.get('/api/retiradas', auth, (req,res) => res.json(cache.retiradas));
app.post('/api/retirada', auth, async (req,res) => {
  const { caja, esNC, importe, desc, tipo, usuario } = req.body;
  if (!caja || !importe) return res.status(400).json({error:'caja e importe requeridos'});
  const key = esNC ? caja+'_nc' : caja;
  if (!cache.retiradas[key]) cache.retiradas[key] = [];
  const reg = { importe: parseFloat(importe), desc: desc||'Retirada', tipo: tipo||'retirada', usuario: usuario||'', ts: new Date().toISOString() };
  cache.retiradas[key].push(reg);
  res.json({ok:true});
  asPost({ token:CAJA_TOKEN, action:'add_retirada', caja, esNC:!!esNC, importe:reg.importe, desc:reg.desc, tipo:reg.tipo, usuario:reg.usuario, ts:reg.ts })
    .catch(e => console.error('[BG retirada]', e.message));
});
app.delete('/api/retiradas/:caja', auth, async (req,res) => {
  // Limpiar retiradas de una caja tras cierre
  const { caja } = req.params;
  const { esNC } = req.query;
  const key = (esNC==='true') ? caja+'_nc' : caja;
  cache.retiradas[key] = [];
  res.json({ok:true});
  asPost({ token:CAJA_TOKEN, action:'clear_retiradas', caja, esNC:esNC==='true' })
    .catch(e => console.error('[BG clear_ret]', e.message));
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
  const ncIdStr = String(nc_id);
  if (confirmar===false) {
    delete cache.nc_confs[ncIdStr];
    if (supabase) supabase.from('caja_nc_confirmaciones').delete().eq('nc_id', ncIdStr).then(({error}) => { if (error) console.error('[Supabase nc_conf delete]', error.message); }).catch(() => {});
  } else {
    const ts = new Date().toISOString();
    cache.nc_confs[ncIdStr] = { confirmado:true, usuario:req.body.usuario||'', ts, ...req.body };
    if (supabase) supabase.from('caja_nc_confirmaciones').upsert({
      nc_id: ncIdStr, confirmado: true, usuario: req.body.usuario || null, ts,
      metodo: req.body.metodo || null, importe: req.body.importe ?? null,
      cliente: req.body.cliente || null, numero: req.body.numero ?? null
    }, { onConflict: 'nc_id' }).then(({error}) => { if (error) console.error('[Supabase nc_conf upsert]', error.message); }).catch(() => {});
  }
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
// ── ELIMINAR REGISTROS NC (borrado real, solo confirmados por Ana) ──
app.post('/api/nc/eliminar', authCaja, async (req,res) => {
  try {
    const { caja, usuario } = req.body;
    if (!caja || !['marbella','monda'].includes(caja)) return res.status(400).json({error:'caja inválida'});
    const metodoId    = caja==='marbella' ? 'efectivo-marbella' : 'efectivo-monda';
    const metodoLabel = caja==='marbella' ? 'Efectivo Marbella' : 'Efectivo Monda';
    const esTrue = v => v===true || v==='true' || v==='TRUE' || v===1;
    // Fuente de verdad del método en No Confirmados: la columna "Método" de la propia hoja NC
    let registrosNC = [];
    try {
      const ncData = await asGetNC({ token: RUTAS_TOKEN, action:'registros', desde:'', hasta:'' });
      registrosNC = ncData.registros || [];
    } catch(e) { console.error('[nc_eliminar] Error leyendo hoja NC:', e.message); }
    const idsDesdeNC = registrosNC.filter(r => r.metodo === metodoLabel).map(r => String(r.id));
    // Por si el método fue reasignado manualmente en Caja (Caja Sheet) en vez de en la hoja NC
    const idsDesdeCaja = Object.keys(cache.registros).filter(id => {
      const r = cache.registros[id];
      return r && r.metodo_pago === metodoId && String(id).startsWith('NC_');
    });
    const candidatos = [...new Set([...idsDesdeNC, ...idsDesdeCaja])];
    // Solo los ids de esa sede que Ana ya marcó como "Recibido"
    const ids = candidatos.filter(id => cache.nc_confs[id] && esTrue(cache.nc_confs[id].confirmado));
    if (ids.length===0) return res.json({ok:true, eliminados:0});
    // 1. Borrado de raíz en la hoja NO_CONFIRMADOS
    const ncResp = await asPostNC({ token: RUTAS_TOKEN, action:'eliminar_registros', ids, usuario: usuario||'' });
    if (!ncResp || !ncResp.ok) return res.status(500).json({error:'Error borrando en hoja NC: ' + (ncResp && ncResp.error ? ncResp.error : 'desconocido')});
    // 2. Limpiar rastro en la Caja Sheet (memoria + persistencia)
    ids.forEach(id => { delete cache.registros[id]; delete cache.nc_confs[id]; });
    const keyRet = `${caja}_nc`;
    cache.retiradas[keyRet] = [];
    res.json({ok:true, eliminados: ids.length});
    ids.forEach(id => {
      asPost({ token:CAJA_TOKEN, action:'set_registro', factura_id:id, metodo_pago:null })
        .catch(e => console.error('[BG nc_eliminar registro]', e.message));
      asPost({ token:CAJA_TOKEN, action:'set_nc_conf', nc_id:id, confirmar:false })
        .catch(e => console.error('[BG nc_eliminar conf]', e.message));
    });
    asPost({ token:CAJA_TOKEN, action:'clear_retiradas', caja, esNC:true })
      .catch(e => console.error('[BG nc_eliminar retiradas]', e.message));
  } catch(e) { res.status(500).json({error:e.message}); }
});
// ── FACTURAS/PAGOS (desde Supabase, sincronizado por ORUM CENTRAL) ──
// Antes: paginaba /invoicepayments de Rentman en cada carga (10-18s).
// Ahora: lee "pagos" (1 fila = 1 pago individual, igual que hacía
// invoicepayments) ya sincronizado en tiempo real por ORUM CENTRAL, y
// cruza con "facturas" (cliente) y "proyectos" (nº visible) en el mismo
// Supabase - cero llamadas a Rentman en esta ruta.
app.get('/api/caja/facturas', auth, async (req,res) => {
  try {
    const { desde, hasta } = req.query;
    if (!desde || !hasta) return res.status(400).json({ error: 'desde y hasta requeridos' });
    if (!supabase) return res.status(500).json({ error: 'Supabase no configurado (faltan SUPABASE_URL/SUPABASE_SERVICE_KEY)' });
    const desdeTs = `${desde}T00:00:00.000Z`;
    const hastaTs = `${hasta}T23:59:59.999Z`;

    let pagos = [];
    let offset = 0;
    while (true) {
      const { data, error } = await supabase.from('pagos').select('*')
        .gte('fecha_pago_ts', desdeTs).lte('fecha_pago_ts', hastaTs)
        .range(offset, offset + 999);
      if (error) throw error;
      pagos = pagos.concat(data);
      if (data.length < 1000) break;
      offset += 1000;
    }
    if (pagos.length === 0) return res.json({ facturas: [] });

    const facturaIds = [...new Set(pagos.map(p => p.factura_id).filter(x => x != null))];
    const proyectoIds = [...new Set(pagos.map(p => p.proyecto_id).filter(x => x != null))];
    const [{ data: facturasData, error: errFact }, { data: proyectosData, error: errProy }] = await Promise.all([
      facturaIds.length ? supabase.from('facturas').select('factura_id,cliente').in('factura_id', facturaIds) : Promise.resolve({ data: [] }),
      proyectoIds.length ? supabase.from('proyectos').select('id,numero').in('id', proyectoIds) : Promise.resolve({ data: [] })
    ]);
    if (errFact) throw errFact;
    if (errProy) throw errProy;
    const clientePorFactura = {};
    (facturasData || []).forEach(f => { clientePorFactura[f.factura_id] = f.cliente; });
    const numeroPorProyecto = {};
    (proyectosData || []).forEach(p => { numeroPorProyecto[p.id] = p.numero; });

    const facturas = pagos.map(p => ({
      id: p.pago_id,
      numero: p.numero_factura,
      cliente: clientePorFactura[p.factura_id] || '',
      cliente_id: null, // ya viene resuelto por nombre - no hace falta /api/contacto/:id
      proyecto_id: p.proyecto_id,
      proyecto_numero: p.proyecto_id ? (numeroPorProyecto[p.proyecto_id] ?? null) : null,
      fecha_pago: p.fecha_pago_raw,
      total_pagado: p.importe
    }));
    res.json({ facturas });
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
  // NOTA (28 ago 2026): se quitó el reintento en serie que había aquí - con
  // muchos contactos fallando de golpe alargaba muchísimo la carga (a veces
  // se quedaba colgada). Ya no hace falta: /api/registro-cobros usa
  // proyectos.cliente de Supabase como fuente principal (más fiable, sin
  // depender de resolver en vivo contra Rentman), este resultado solo se
  // usa de respaldo si el proyecto aún no está en Supabase.
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

// ================================================================
// REGISTRO DE COBROS — factura + fianza vistas juntas, cobros parciales,
// devoluciones con nº de TPV localizable. Se pre-rellena solo cruzando
// Fianzas (Rentman) + facturas (Supabase), y cualquier corrección manual
// se guarda con historial de auditoría (quién/cuándo/qué cambió).
// ================================================================
const PIPELINE_COMERCIAL = ['pending', 'concept', 'inquiry']; // mismo criterio que en orum-central-panel: "todavía sin decidir"
function capitalizaUbicacion(u) { const s = String(u || ''); return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : ''; }
app.get('/api/registro-cobros', authCobros, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: 'Supabase no configurado' });
    const ahora = Date.now();
    let fianzas;
    if (ahora - cacheFianzas.ts < FIANZAS_TTL && cacheFianzas.data.length > 0) fianzas = cacheFianzas.data;
    else { fianzas = await fetchFianzasRentman(); cacheFianzas.data = fianzas; cacheFianzas.ts = Date.now(); }

    const numeros = [...new Set(fianzas.map(f => parseInt(f.numero)).filter(n => !isNaN(n)))];

    const [{ data: overrides, error: errOv }, { data: proyectosData, error: errProy }] = await Promise.all([
      supabase.from('caja_registro_cobros').select('*'),
      numeros.length ? supabase.from('proyectos').select('id,numero,estado,cancelado,cliente,es_abrebotellas').in('numero', numeros) : Promise.resolve({ data: [] })
    ]);
    if (errOv) throw errOv;
    if (errProy) throw errProy;

    const proyectoPorNumero = {};
    (proyectosData || []).forEach(p => { proyectoPorNumero[p.numero] = p; });

    // Solo proyectos en etapa Confirmado en adelante (incluye fases logísticas
    // posteriores) - nada de la etapa comercial (Pending/Concept/Inquiry), ni
    // cancelados, ni abrebotellas (PNC no es facturación formal, no pinta
    // nada en Registro de Cobros - ej. proyecto #1795 reportado por el usuario).
    const numerosConfirmados = numeros.filter(n => {
      const p = proyectoPorNumero[n];
      if (!p) return false;
      if (p.cancelado) return false;
      if (p.es_abrebotellas) return false;
      return PIPELINE_COMERCIAL.indexOf(String(p.estado || '').toLowerCase()) === -1;
    });
    const proyectoIds = numerosConfirmados.map(n => proyectoPorNumero[n].id).filter(x => x != null);

    // Valor real del proyecto: suma de sus facturas (con IVA - esto es control
    // de pagos, no rentabilidad). facturas.numero es el nº de la FACTURA, no
    // del proyecto - hay que cruzar por proyecto_id, no por numero.
    let importeProyectoPorId = {};
    // BUG encontrado (27 ago 2026): caja_registros.numero guarda el Nº DE
    // FACTURA (ver POST /api/caja/registro -> numero:f.numero, y f viene de
    // /api/caja/facturas donde numero=p.numero_factura), NO el Nº DE PROYECTO
    // que usa Fianzas. Cruzar caja_registros.numero directo contra
    // fianzas.numero (como se hacía antes) nunca encontraba nada -> "Cobrado"
    // salía siempre 0€ y "Forma de pago"/"Devolución" siempre vacías. Puente:
    // factura.numero -> factura.proyecto_id -> proyecto.numero.
    const proyectoIdPorNumeroFactura = {};
    const numeroProyectoPorId = {};
    // facturasPagadasPorProyecto: para el aviso "factura pagada en Rentman pero
    // sin registrar en Caja" (mismo criterio que auditoria.facturas_sin_registro
    // en orum-central-panel/server.js) - se necesita saber, por proyecto, si
    // ALGUNA de sus facturas está esta_pagada=true.
    const facturasPagadasPorProyecto = {};
    (proyectosData || []).forEach(p => { numeroProyectoPorId[p.id] = p.numero; });
    if (proyectoIds.length) {
      const { data: facturasData, error: errFact } = await supabase.from('facturas').select('proyecto_id,numero,importe_con_iva,esta_pagada').in('proyecto_id', proyectoIds);
      if (errFact) throw errFact;
      (facturasData || []).forEach(f => {
        importeProyectoPorId[f.proyecto_id] = (importeProyectoPorId[f.proyecto_id] || 0) + (parseFloat(f.importe_con_iva) || 0);
        if (f.numero != null) proyectoIdPorNumeroFactura[f.numero] = f.proyecto_id;
        if (f.esta_pagada) {
          if (!facturasPagadasPorProyecto[f.proyecto_id]) facturasPagadasPorProyecto[f.proyecto_id] = [];
          facturasPagadasPorProyecto[f.proyecto_id].push(f.numero);
        }
      });
    }

    // Cobros reales por TPV/transferencia (el efectivo no cuenta aquí - se
    // controla aparte en Caja Diaria) y forma de pago + nº de operación para
    // poder localizar cada movimiento.
    let registros = [];
    {
      let offset = 0;
      while (true) {
        const { data, error } = await supabase.from('caja_registros').select('numero,metodo_pago,ubicacion,tipo,importe,fecha_pago_raw,num_operacion,es_abrebotellas').range(offset, offset + 999);
        if (error) throw error;
        registros = registros.concat(data || []);
        if (!data || data.length < 1000) break;
        offset += 1000;
      }
    }
    // Set de nº de factura con ALGÚN registro en Caja, sin las exclusiones de
    // abrebotellas/efectivo/factura0 de abajo - para el aviso "sin registrar",
    // basta con que exista un registro cualquiera (igual que en orum-central-panel).
    const facturasConAlgunRegistro = new Set();
    registros.forEach(r => {
      const nf = parseInt(r.numero);
      if (!isNaN(nf)) facturasConAlgunRegistro.add(nf);
    });
    const registrosPorNumero = {};
    registros.forEach(r => {
      if (r.es_abrebotellas) return;
      if (String(r.tipo || '').toLowerCase() === 'efectivo') return;
      // "Factura 0€" (tipo 'otro') marca facturas anuladas/rectificadas sin
      // cobro real (ver proyecto #133: factura original + nota de abono
      // negativa + reemisión) - su importe registrado no es dinero cobrado
      // de verdad, igual que el efectivo no cuenta aquí.
      if (String(r.tipo || '').toLowerCase() === 'otro') return;
      const numFactura = parseInt(r.numero);
      if (isNaN(numFactura)) return;
      // r.numero es el Nº DE FACTURA (ver comentario más arriba) - hay que
      // traducirlo a Nº DE PROYECTO antes de agrupar, si no nunca casa con fianzas.
      const proyId = proyectoIdPorNumeroFactura[numFactura];
      if (proyId == null) return;
      const numProyecto = numeroProyectoPorId[proyId];
      if (numProyecto == null) return;
      if (!registrosPorNumero[numProyecto]) registrosPorNumero[numProyecto] = [];
      registrosPorNumero[numProyecto].push(r);
    });

    const overridesPorProyecto = {};
    (overrides || []).forEach(o => { if (o.numero_proyecto != null) overridesPorProyecto[o.numero_proyecto] = o; });

    const filas = fianzas.filter(f => numerosConfirmados.indexOf(parseInt(f.numero)) !== -1).map(f => {
      const numero = parseInt(f.numero);
      const p = proyectoPorNumero[numero];
      const ov = overridesPorProyecto[numero];
      const regs = registrosPorNumero[numero] || [];
      const cobradoAuto = regs.reduce((s, r) => s + (parseFloat(r.importe) || 0), 0);
      const formaPago = [...new Set(regs.map(r => `${r.metodo_pago || ''}${r.ubicacion ? ' · ' + capitalizaUbicacion(r.ubicacion) : ''}`.trim()).filter(Boolean))].join(', ');
      const numOps = [...new Set(regs.map(r => r.num_operacion).filter(Boolean))].join(', ');
      const fechaPago = regs.map(r => r.fecha_pago_raw).filter(Boolean).sort().pop() || null;
      const importeProyecto = (ov && ov.importe_proyecto != null && ov.importe_proyecto !== 0) ? ov.importe_proyecto : Math.round((importeProyectoPorId[p.id] || 0) * 100) / 100;
      const importeFianza = (ov && ov.importe_fianza != null && ov.importe_fianza !== 0) ? ov.importe_fianza : f.importe;
      const cobrado = (ov && ov.cobrado != null && ov.cobrado !== 0) ? ov.cobrado : Math.round(cobradoAuto * 100) / 100;
      const estadoFianza = ov && ov.estado_fianza ? ov.estado_fianza : (f.estado_id === '2' ? 'devuelta' : f.estado_id === '1' ? 'cobrada' : 'pendiente');
      // "Finalizado" = ya no hace falta seguirlo: todo cobrado Y la fianza
      // devuelta (o no aplica). Se usa para el selector Vigentes/Finalizados/Todos.
      // La fianza solo cuenta como "pendiente de cobrar" mientras su estado siga
      // siendo 'pendiente' - una vez 'cobrada' ya está en poder de ORUM (falta
      // devolverla, no cobrarla; eso ya se refleja aparte en "Fianzas por devolver"),
      // y 'devuelta'/'no_aplica' no dejan nada abierto. `cobrado` (de Caja Diaria)
      // nunca incluye el importe de la fianza, así que sumar importeFianza entero
      // aquí como antes hacía que ningún proyecto con fianza ya devuelta pudiera
      // marcarse Finalizado.
      const pendienteFianza = estadoFianza === 'pendiente' ? (parseFloat(importeFianza) || 0) : 0;
      const pendiente = ((parseFloat(importeProyecto) || 0) - (parseFloat(cobrado) || 0)) + pendienteFianza;
      const finalizado = pendiente <= 0.01 && (estadoFianza === 'devuelta' || estadoFianza === 'no_aplica');
      // Aviso "sin registrar en Caja": alguna factura del proyecto está pagada
      // en Rentman (esta_pagada=true) pero no tiene NINGÚN registro en Caja
      // Diaria - el dinero ya entró, solo falta que alguien lo cuadre aquí.
      // Mismo caso que dio origen a esto: proyecto #1921 (factura 261322,
      // pagada 10/08/2026 en Rentman, nunca registrada en Caja).
      const facturasPagadas = (p && facturasPagadasPorProyecto[p.id]) || [];
      const sinRegistroCaja = facturasPagadas.some(numFact => !facturasConAlgunRegistro.has(numFact));
      return {
        numero_proyecto: numero,
        // Preferimos el cliente ya resuelto en Supabase (proyectos.cliente,
        // sincronizado vía la caché de contactos de ORUM CENTRAL) sobre el
        // de fetchFianzasRentman(), que resuelve en vivo contra Rentman en
        // lotes de 20 y a veces falla (salía el ID en bruto como nombre).
        cliente: (p && p.cliente) ? p.cliente : f.cliente,
        comercial: f.comercial,
        importe_proyecto: importeProyecto,
        importe_fianza: importeFianza,
        cobrado: cobrado,
        estado_fianza: estadoFianza,
        metodo_devolucion: ov ? ov.metodo_devolucion : null,
        numero_devolucion_tpv: ov ? ov.numero_devolucion_tpv : null,
        forma_pago: formaPago || null,
        num_operacion_pago: numOps || null,
        fecha_pago: fechaPago,
        fecha_evento: f.fecha_inicio || null,
        notas: ov ? ov.notas : null,
        es_manual: false,
        finalizado: finalizado,
        sin_registro_caja: sinRegistroCaja,
        actualizado_por: ov ? ov.actualizado_por : null,
        actualizado_en: ov ? ov.actualizado_en : null
      };
    });

    // Filas manuales sueltas (ingresos sin identificar todavía, numero_proyecto null)
    // finalizado: false siempre - por definición siguen "por casar" con un
    // proyecto, así que deben verse tanto en Vigentes como en Todos.
    const manuales = (overrides || []).filter(o => o.numero_proyecto == null).map(o => ({
      id: o.id, numero_proyecto: null, cliente: o.cliente, importe_proyecto: o.importe_proyecto || 0,
      importe_fianza: o.importe_fianza || 0, cobrado: o.cobrado || 0, estado_fianza: o.estado_fianza,
      metodo_devolucion: o.metodo_devolucion, numero_devolucion_tpv: o.numero_devolucion_tpv,
      forma_pago: o.forma_pago_manual || null, num_operacion_pago: null, fecha_pago: null,
      fecha_evento: o.fecha_cobro || null,
      notas: o.notas, es_manual: true, finalizado: false, sin_registro_caja: false,
      actualizado_por: o.actualizado_por, actualizado_en: o.actualizado_en
    }));

    const totalSinRegistro = filas.filter(f => f.sin_registro_caja).length;
    res.json({ ok: true, filas: filas.concat(manuales), total_sin_registro_caja: totalSinRegistro });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/registro-cobros/manual', authCobros, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: 'Supabase no configurado' });
    const usuario = req.session.user.usuario;
    // Un registro manual es un ingreso YA recibido pero aún sin identificar a
    // qué proyecto pertenece: se conoce fecha, forma de pago e importe pagado
    // (no un desglose proyecto/fianza, que no se sabe todavía). Se guarda
    // como "cobrado" en firme para que no aparezca como pendiente.
    const { cliente, fecha_cobro, forma_pago_manual, importe_pagado, notas } = req.body;
    const importe = parseFloat(importe_pagado) || 0;
    const fila = {
      numero_proyecto: null, cliente: cliente || '', importe_proyecto: importe, importe_fianza: 0,
      cobrado: importe, estado_fianza: 'no_aplica', fecha_cobro: fecha_cobro || null,
      forma_pago_manual: forma_pago_manual || null,
      notas: notas || '', es_manual: true, creado_por: usuario, actualizado_por: usuario
    };
    const { data, error } = await supabase.from('caja_registro_cobros').insert(fila).select().single();
    if (error) throw error;
    res.json({ ok: true, registro: data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/registro-cobros/:clave', authCobros, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: 'Supabase no configurado' });
    const usuario = req.session.user.usuario;
    const esManual = req.params.clave.startsWith('id-');
    const numeroProyecto = esManual ? null : parseInt(req.params.clave);
    const idManual = esManual ? parseInt(req.params.clave.replace('id-', '')) : null;

    const camposEditables = ['cliente', 'importe_proyecto', 'importe_fianza', 'cobrado', 'estado_fianza', 'metodo_devolucion', 'numero_devolucion_tpv', 'notas', 'fecha_cobro', 'forma_pago_manual'];
    const cambios = {};
    camposEditables.forEach(c => { if (req.body[c] !== undefined) cambios[c] = req.body[c]; });

    let existente = null;
    if (esManual) {
      const { data } = await supabase.from('caja_registro_cobros').select('*').eq('id', idManual).maybeSingle();
      existente = data;
    } else {
      const { data } = await supabase.from('caja_registro_cobros').select('*').eq('numero_proyecto', numeroProyecto).maybeSingle();
      existente = data;
    }

    const historial = [];
    camposEditables.forEach(c => {
      if (cambios[c] === undefined) return;
      const anterior = existente ? existente[c] : null;
      if (String(anterior ?? '') !== String(cambios[c] ?? '')) {
        historial.push({ numero_proyecto: numeroProyecto, campo: c, valor_anterior: anterior != null ? String(anterior) : null, valor_nuevo: cambios[c] != null ? String(cambios[c]) : null, usuario });
      }
    });

    let guardado, error;
    if (esManual) {
      ({ data: guardado, error } = await supabase.from('caja_registro_cobros').update({ ...cambios, actualizado_por: usuario, actualizado_en: new Date().toISOString() }).eq('id', idManual).select().single());
    } else {
      const fila = { numero_proyecto: numeroProyecto, ...cambios, actualizado_por: usuario, actualizado_en: new Date().toISOString() };
      ({ data: guardado, error } = await supabase.from('caja_registro_cobros').upsert(fila, { onConflict: 'numero_proyecto' }).select().single());
    }
    if (error) throw error;

    if (historial.length > 0) {
      const filasHist = historial.map(h => ({ ...h, registro_id: guardado.id }));
      await supabase.from('caja_registro_cobros_historial').insert(filasHist);
    }

    res.json({ ok: true, registro: guardado, cambios: historial.length });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/registro-cobros/:clave/historial', authCobros, async (req, res) => {
  try {
    if (!supabase) return res.json({ ok: true, historial: [] });
    const esManual = req.params.clave.startsWith('id-');
    let query = supabase.from('caja_registro_cobros_historial').select('*').order('fecha', { ascending: false });
    if (esManual) {
      const { data: reg } = await supabase.from('caja_registro_cobros').select('id').eq('id', parseInt(req.params.clave.replace('id-', ''))).maybeSingle();
      query = query.eq('registro_id', reg ? reg.id : -1);
    } else {
      query = query.eq('numero_proyecto', parseInt(req.params.clave));
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ ok: true, historial: data });
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
// Alias: todos los POST ahora son GET con params
async function asFianzasPost(params) {
  return asFianzasGet(params);
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
    const d = await asFianzasGet({ token: FIANZAS_TOKEN, action: 'crear_solicitud', ...req.body });
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
    // Marcar devuelta en Sheet — Rentman lo actualiza María manualmente al generar el documento
    const d = await asFianzasGet({ token: FIANZAS_TOKEN, action: 'marcar_devuelta', id: solicitud_id, notas: notas || '' });
    if (!d.ok) return res.status(500).json(d);
    cacheSolicitudes.ts = 0;
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/fianzas/notificar', auth, async (req, res) => {
  try {
    const { solicitud_id, notificado } = req.body;
    const d = await asFianzasGet({ token: FIANZAS_TOKEN, action: 'marcar_notificado', id: solicitud_id, notificado: String(notificado !== false) });
    cacheSolicitudes.ts = 0;
    res.json(d);
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/fianzas/cancelar-solicitud', auth, async (req, res) => {
  try {
    const d = await asFianzasGet({ token: FIANZAS_TOKEN, action: 'cancelar_solicitud', id: req.body.solicitud_id });
    cacheSolicitudes.ts = 0;
    res.json(d);
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
// ── TEST PAYMENTS RENTMAN (solo lectura, para verificar estructura) ──
app.get('/api/test/payments', authAdmin, async (req, res) => {
  try {
    const url = RENTMAN_URL + '/payments?limit=5';
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + RENTMAN_TOKEN } });
    const text = await r.text();
    const data = JSON.parse(text);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/test/invoice/:id', authAdmin, async (req, res) => {
  try {
    const url = RENTMAN_URL + '/invoices/' + req.params.id;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + RENTMAN_TOKEN } });
    const text = await r.text();
    const data = JSON.parse(text);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/test/paymentmethods', authAdmin, async (req, res) => {
  try {
    const url = RENTMAN_URL + '/paymentmethods';
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + RENTMAN_TOKEN } });
    const text = await r.text();
    try { res.json(JSON.parse(text)); } catch(e) { res.send(text); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/test/invoice/:id/payments', authAdmin, async (req, res) => {
  try {
    const url = RENTMAN_URL + '/invoices/' + req.params.id + '/payments';
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + RENTMAN_TOKEN } });
    const text = await r.text();
    const data = JSON.parse(text);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// ── DIAGNÓSTICO INVOICEPAYMENTS ──────────────────────────────
app.get('/api/test/invoicepayments', authAdmin, async (req, res) => {
  try {
    const desde = req.query.desde || new Date().toISOString().substring(0,10);
    const hasta = req.query.hasta || desde;
    const url = `${RENTMAN_URL}/invoicepayments?limit=10&paymentdate%5Bgte%5D=${encodeURIComponent(desde+' 00:00:00')}&paymentdate%5Blte%5D=${encodeURIComponent(hasta+' 23:59:59')}`;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + RENTMAN_TOKEN } });
    const text = await r.text();
    res.setHeader('Content-Type','application/json');
    res.send(text);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT, ()=>console.log('ORUM Caja puerto '+PORT));

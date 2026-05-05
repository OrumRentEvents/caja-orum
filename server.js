const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const TICKS_FILE    = path.join(DATA_DIR, 'ticks.json');
const CAJA_FILE     = path.join(DATA_DIR, 'caja_registros.json');
const HISTORIAL_FILE= path.join(DATA_DIR, 'historial.json');
const CIERRES_FILE  = path.join(DATA_DIR, 'cierres.json');
const SALDOS_FILE   = path.join(DATA_DIR, 'saldos.json');
const NC_CONF_FILE  = path.join(DATA_DIR, 'nc_confirmaciones.json');

function loadJSON(f) { try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch { return {}; } }
function saveJSON(f,d) { fs.writeFileSync(f, JSON.stringify(d,null,2)); }

function addHistorial(accion, datos, usuario) {
  const h = loadJSON(HISTORIAL_FILE);
  const key = Date.now().toString();
  h[key] = { accion, datos, usuario, ts: new Date().toISOString() };
  const keys = Object.keys(h).sort();
  if (keys.length > 2000) keys.slice(0, keys.length-2000).forEach(k => delete h[k]);
  saveJSON(HISTORIAL_FILE, h);
}

const USERS = {
  marina: { pass:'Orum2026#Mar', rol:'comercial',    nombre:'Marina' },
  danilo: { pass:'Orum2026#Dan', rol:'comercial',    nombre:'Danilo' },
  maria:  { pass:'Orum2026#Mia', rol:'caja',         nombre:'María' },
  isabel: { pass:'Orum2026#Isa', rol:'contabilidad', nombre:'Isabel' },
  ana:    { pass:'Orum2026#Ana', rol:'contabilidad', nombre:'Ana' },
  sergio: { pass:'Orum2026#Ser', rol:'admin',        nombre:'Sergio' }
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({ secret:'orum-caja-2026-secret', resave:false, saveUninitialized:false, cookie:{ maxAge:8*60*60*1000 } }));

function auth(req,res,next) { if(!req.session.user) return res.status(401).json({error:'No autenticado'}); next(); }
function authAdmin(req,res,next) { if(!req.session.user) return res.status(401).json({error:'No autenticado'}); if(req.session.user.rol!=='admin') return res.status(403).json({error:'Sin permisos'}); next(); }
function authContab(req,res,next) { if(!req.session.user) return res.status(401).json({error:'No autenticado'}); if(!['contabilidad','admin'].includes(req.session.user.rol)) return res.status(403).json({error:'Sin permisos'}); next(); }

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
  const ticks = loadJSON(TICKS_FILE);
  const { desde, hasta } = req.query;
  if (!desde||!hasta) return res.json(ticks);
  const f = {};
  Object.entries(ticks).forEach(([k,v]) => { const d=k.split('_')[0]; if(d>=desde&&d<=hasta) f[k]=v; });
  res.json(f);
});
app.post('/api/tick', authContab, (req,res) => {
  const { key, valor, nota, usuario } = req.body;
  if (!key) return res.status(400).json({error:'key requerida'});
  const ticks = loadJSON(TICKS_FILE);
  if (valor===null||valor===undefined) delete ticks[key];
  else ticks[key] = { valor, nota:nota||'', usuario:usuario||'', fecha:new Date().toISOString() };
  saveJSON(TICKS_FILE, ticks);
  addHistorial('tick', {key,valor,nota}, usuario||'');
  res.json({ok:true});
});

// ── REGISTROS CAJA ────────────────────────────────────────────
app.get('/api/caja/registros', auth, (req,res) => {
  const r = loadJSON(CAJA_FILE);
  const { desde, hasta } = req.query;
  if (!desde||!hasta) return res.json(r);
  const f = {};
  Object.entries(r).forEach(([k,v]) => { if(v.fecha_pago>=desde&&v.fecha_pago<=hasta) f[k]=v; });
  res.json(f);
});
app.post('/api/caja/registro', auth, (req,res) => {
  const { factura_id, metodo_pago, ubicacion, tipo, importe, cliente, numero, fecha_pago, es_abrebotellas, usuario, num_operacion } = req.body;
  if (!factura_id) return res.status(400).json({error:'factura_id requerido'});
  const registros = loadJSON(CAJA_FILE);
  const key = String(factura_id);
  const anterior = registros[key]?.metodo_pago||null;
  if (metodo_pago===null||metodo_pago===undefined) {
    delete registros[key];
    addHistorial('quitar_metodo', {factura_id,numero,anterior}, usuario||'');
  } else {
    registros[key] = { factura_id, metodo_pago, ubicacion, tipo, importe, cliente, numero, fecha_pago, es_abrebotellas, usuario, num_operacion:num_operacion||'', updated:new Date().toISOString() };
    addHistorial('asignar_metodo', {factura_id,numero,cliente,metodo_pago,importe,num_operacion:num_operacion||''}, usuario||'');
  }
  saveJSON(CAJA_FILE, registros);
  res.json({ok:true});
});

// ── CIERRES ───────────────────────────────────────────────────
// Estructura: cierres[caja][fecha_desde+'_'+fecha_hasta] = { usuario, ts, total_ef, total_tpv, total_transf, retiradas, saldo_anterior, saldo_final }

app.get('/api/cierres', auth, (req,res) => {
  res.json(loadJSON(CIERRES_FILE));
});

app.post('/api/cierre', auth, (req,res) => {
  const { caja, desde, hasta, total_ef, total_tpv, total_transf, retiradas, saldo_anterior, saldo_final, usuario } = req.body;
  if (!caja||!desde||!hasta) return res.status(400).json({error:'caja, desde y hasta requeridos'});

  const cierres = loadJSON(CIERRES_FILE);
  if (!cierres[caja]) cierres[caja] = {};

  const periodoKey = `${desde}_${hasta}`;
  cierres[caja][periodoKey] = {
    caja, desde, hasta,
    total_ef: total_ef||0,
    total_tpv: total_tpv||0,
    total_transf: total_transf||0,
    retiradas: retiradas||[],
    saldo_anterior: saldo_anterior||0,
    saldo_final: saldo_final||0,
    usuario: usuario||'',
    ts: new Date().toISOString()
  };
  saveJSON(CIERRES_FILE, cierres);

  // Actualizar saldo de la caja
  const saldos = loadJSON(SALDOS_FILE);
  saldos[caja] = { efectivo_final: saldo_final||0, fecha: hasta, usuario: usuario||'', updated: new Date().toISOString() };
  saveJSON(SALDOS_FILE, saldos);

  addHistorial('cierre_caja', { caja, desde, hasta, total_ef, total_tpv, saldo_final }, usuario||'');
  res.json({ok:true});
});

// Verificar si se puede cerrar una caja
app.get('/api/cierre/verificar', auth, (req,res) => {
  const { caja, desde } = req.query;
  if (!caja||!desde) return res.status(400).json({error:'caja y desde requeridos'});

  const cierres = loadJSON(CIERRES_FILE);
  const cajaCierres = cierres[caja]||{};

  // Buscar el último cierre de esta caja
  const periodosCerrados = Object.keys(cajaCierres).sort();
  if (periodosCerrados.length===0) return res.json({ ok:true, puede_cerrar:true, mensaje:null });

  const ultimoCierre = cajaCierres[periodosCerrados[periodosCerrados.length-1]];
  const ultimaFechaCierre = ultimoCierre.hasta;

  // Si hay un período sin cerrar anterior al actual
  if (ultimaFechaCierre < desde) {
    // Hay días entre el último cierre y el actual - OK, pueden no tener cobros
    return res.json({ ok:true, puede_cerrar:true, mensaje:null });
  }

  // Si el período actual ya está cerrado
  const periodoKey = Object.keys(cajaCierres).find(k => {
    const [d,h] = k.split('_');
    return d===desde || (d<=desde && h>=desde);
  });
  if (periodoKey) {
    const c = cajaCierres[periodoKey];
    return res.json({ ok:false, puede_cerrar:false, mensaje:`Esta caja ya fue cerrada el ${new Date(c.ts).toLocaleString('es-ES')} por ${c.usuario}` });
  }

  return res.json({ ok:true, puede_cerrar:true, mensaje:null });
});

// ── SALDOS ────────────────────────────────────────────────────
app.get('/api/saldos', auth, (req,res) => res.json(loadJSON(SALDOS_FILE)));

// ── HISTORIAL ─────────────────────────────────────────────────
app.get('/api/historial', authAdmin, (req,res) => {
  const h = loadJSON(HISTORIAL_FILE);
  const { desde, hasta, limit } = req.query;
  let entries = Object.entries(h).sort((a,b)=>b[0].localeCompare(a[0]));
  if (desde&&hasta) entries=entries.filter(([,v])=>v.ts>=desde&&v.ts<=hasta+'T23:59:59Z');
  if (limit) entries=entries.slice(0,parseInt(limit));
  res.json(Object.fromEntries(entries));
});

// ── PROXY NO CONFIRMADOS (Apps Script) ───────────────────────
// ── NC CONFIRMACIONES ─────────────────────────────────────────
app.get('/api/nc/confirmaciones', auth, (req, res) => {
  res.json(loadJSON(NC_CONF_FILE));
});

app.post('/api/nc/confirmar', authContab, (req, res) => {
  const { nc_id, confirmar, metodo, importe, cliente, numero, usuario } = req.body;
  if (!nc_id) return res.status(400).json({ error: 'nc_id requerido' });
  const confs = loadJSON(NC_CONF_FILE);
  if (confirmar === false) {
    delete confs[String(nc_id)];
    addHistorial('nc_quitar_confirmacion', { nc_id, numero, cliente }, usuario || '');
  } else {
    confs[String(nc_id)] = {
      confirmado: true,
      usuario: usuario || '',
      ts: new Date().toISOString(),
      metodo: metodo || '',
      importe: importe || 0,
      cliente: cliente || '',
      numero: numero || ''
    };
    addHistorial('nc_confirmar_recepcion', { nc_id, numero, cliente, metodo, importe }, usuario || '');
  }
  saveJSON(NC_CONF_FILE, confs);
  res.json({ ok: true });
});

// ── PROXY CONTACTO RENTMAN ───────────────────────────────────
const RENTMAN_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3NzMxNTM0MjIsIm1lZGV3ZXJrZXIiOjIzNSwiYWNjb3VudCI6InNlcnZpY2lvc3lhbHF1aWxlcnBhcmFldmVudG9zc2wiLCJjbGllbnRfdHlwZSI6Im9wZW5hcGkiLCJjbGllbnQubmFtZSI6Im9wZW5hcGkiLCJleHAiOjIwODg3NzI2MjIsImlzcyI6IntcIm5hbWVcIjpcImJhY2tlbmRcIixcInZlcnNpb25cIjpcIjQuODI4LjAuNlwifSJ9.hyHIfRnBGkLunqFAzG40c95AjpkWJfywelT_RiTcXDs';
const RENTMAN_URL   = 'https://api.rentman.net';

app.get('/api/contacto/:id', auth, async (req, res) => {
  try {
    const r = await fetch(`${RENTMAN_URL}/contacts/${req.params.id}`, {
      headers: { Authorization: `Bearer ${RENTMAN_TOKEN}` }
    });
    const data = await r.json();
    res.json({ ok: true, data: data.data || null });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PROXY FACTURAS RENTMAN ────────────────────────────────────
const AS_RUTAS_URL = 'https://script.google.com/macros/s/AKfycbxaSfXi-D3Sx8Lpek6pHPaA-2_NgrXW6CTM0d37LlCX-x0hqRLM6BwyH-BIinyiJlAi/exec';
const RUTAS_TOKEN  = 'ORUMx2026CajaStats';

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

app.get('/api/caja/facturas', auth, async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    const data = await asGet(AS_RUTAS_URL, { token:RUTAS_TOKEN, action:'invoicepayments', desde, hasta });
    res.json(data.data ? { facturas: data.data } : data);
  } catch(e) { res.status(500).json({error: e.message}); }
});

const NC_AS_URL = 'https://script.google.com/macros/s/AKfycbx1ayolXUAmk95s8M2bUS_46O7HQrM4gmQgh1mQF9zOCuOvEQfp59K94TnDYpopE73QmA/exec';

app.get('/api/noconfirmados', auth, async (req, res) => {
  const { desde, hasta } = req.query;
  console.log(`[NC] Cargando desde=${desde} hasta=${hasta}`);
  try {
    const url = `${NC_AS_URL}?token=ORUMx2026CajaStats&action=registros&desde=${encodeURIComponent(desde)}&hasta=${encodeURIComponent(hasta)}`;
    console.log(`[NC] URL: ${url}`);
    
    // Apps Script redirige — seguimos manualmente hasta obtener JSON
    let finalUrl = url;
    let r;
    for (let i = 0; i < 5; i++) {
      r = await fetch(finalUrl, { redirect: 'manual' });
      console.log(`[NC] Status: ${r.status}, Location: ${r.headers.get('location') || 'none'}`);
      if (r.status === 301 || r.status === 302 || r.status === 307 || r.status === 308) {
        finalUrl = r.headers.get('location');
        if (!finalUrl) break;
      } else {
        break;
      }
    }
    
    const text = await r.text();
    console.log(`[NC] Respuesta (primeros 200): ${text.substring(0, 200)}`);
    
    let data;
    try { data = JSON.parse(text); }
    catch(pe) { return res.status(500).json({ error: 'Respuesta no es JSON', raw: text.substring(0, 500) }); }
    
    res.json(data);
  } catch(e) {
    console.error(`[NC] Error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT, ()=>console.log('ORUM Caja puerto '+PORT));

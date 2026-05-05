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

// ── Apps Script URLs ──────────────────────────────────────────
const AS_RUTAS_URL = 'https://script.google.com/macros/s/AKfycbxaSfXi-D3Sx8Lpek6pHPaA-2_NgrXW6CTM0d37LlCX-x0hqRLM6BwyH-BIinyiJlAi/exec';
const AS_NC_URL    = 'https://script.google.com/macros/s/AKfycbx1ayolXUAmk95s8M2bUS_46O7HQrM4gmQgh1mQF9zOCuOvEQfp59K94TnDYpopE73QmA/exec';
const CAJA_TOKEN   = 'ORUMx2026CajaStore';
const RUTAS_TOKEN  = 'ORUMx2026CajaStats';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({ secret:'orum-caja-2026-secret', resave:false, saveUninitialized:false, cookie:{ maxAge:8*60*60*1000 } }));

function auth(req,res,next) { if(!req.session.user) return res.status(401).json({error:'No autenticado'}); next(); }
function authAdmin(req,res,next) { if(!req.session.user) return res.status(401).json({error:'No autenticado'}); if(req.session.user.rol!=='admin') return res.status(403).json({error:'Sin permisos'}); next(); }
function authContab(req,res,next) { if(!req.session.user) return res.status(401).json({error:'No autenticado'}); if(!['contabilidad','admin'].includes(req.session.user.rol)) return res.status(403).json({error:'Sin permisos'}); next(); }

// ── Helper: llamar Apps Script GET (sigue redirects) ─────────
async function asGet(baseUrl, params) {
  const qs = new URLSearchParams(params).toString();
  let url = `${baseUrl}?${qs}`;
  let r;
  for (let i=0; i<6; i++) {
    r = await fetch(url, { redirect:'manual' });
    if ([301,302,307,308].includes(r.status)) {
      url = r.headers.get('location');
      if (!url) break;
    } else break;
  }
  const text = await r.text();
  try { return JSON.parse(text); }
  catch(e) { throw new Error('Respuesta no JSON: ' + text.substring(0,200)); }
}

// ── Helper: llamar Apps Script POST ──────────────────────────
async function asPost(baseUrl, body) {
  let url = baseUrl;
  let r;
  for (let i=0; i<6; i++) {
    r = await fetch(url, {
      method:'POST', redirect:'manual',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    if ([301,302,307,308].includes(r.status)) {
      url = r.headers.get('location');
      if (!url) break;
    } else break;
  }
  const text = await r.text();
  try { return JSON.parse(text); }
  catch(e) { throw new Error('Respuesta no JSON: ' + text.substring(0,200)); }
}

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
app.get('/api/ticks', auth, async (req,res) => {
  try {
    const data = await asGet(AS_RUTAS_URL, { token:RUTAS_TOKEN, action:'get_ticks', desde:req.query.desde||'', hasta:req.query.hasta||'' });
    res.json(data.data||{});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/tick', authContab, async (req,res) => {
  try {
    const { key, valor, nota, usuario } = req.body;
    if (!key) return res.status(400).json({error:'key requerida'});
    const data = await asPost(AS_RUTAS_URL, { token:CAJA_TOKEN, action:'set_tick', key, valor:valor??null, nota:nota||'', usuario:usuario||'' });
    res.json(data);
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── REGISTROS CAJA ────────────────────────────────────────────
app.get('/api/caja/registros', auth, async (req,res) => {
  try {
    const data = await asGet(AS_RUTAS_URL, { token:RUTAS_TOKEN, action:'get_registros', desde:req.query.desde||'', hasta:req.query.hasta||'' });
    // Convertir array a objeto keyed por factura_id
    const arr = data.data||[];
    const obj = {};
    arr.forEach(r => { if(r.factura_id) obj[String(r.factura_id)] = { ...r, metodo_pago: r.metodo_pago }; });
    res.json(obj);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/caja/registro', auth, async (req,res) => {
  try {
    const data = await asPost(AS_RUTAS_URL, { token:CAJA_TOKEN, action:'set_registro', ...req.body });
    res.json(data);
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── CIERRES ───────────────────────────────────────────────────
app.get('/api/cierres', auth, async (req,res) => {
  try {
    const data = await asGet(AS_RUTAS_URL, { token:RUTAS_TOKEN, action:'get_cierres' });
    res.json(data.data||{});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/cierre', auth, async (req,res) => {
  try {
    const data = await asPost(AS_RUTAS_URL, { token:CAJA_TOKEN, action:'set_cierre', ...req.body });
    res.json(data);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/cierre/verificar', auth, async (req,res) => {
  try {
    const { caja, desde } = req.query;
    const data = await asGet(AS_RUTAS_URL, { token:RUTAS_TOKEN, action:'get_cierres' });
    const cierres = data.data||{};
    const cajaCierres = cierres[caja]||{};
    const periodosCerrados = Object.keys(cajaCierres).sort();
    if (periodosCerrados.length===0) return res.json({ok:true,puede_cerrar:true,mensaje:null});
    const periodoKey = Object.keys(cajaCierres).find(k => {
      const [d,h] = k.split('_');
      return d===desde || (d<=desde && h>=desde);
    });
    if (periodoKey) {
      const c = cajaCierres[periodoKey];
      return res.json({ok:false,puede_cerrar:false,mensaje:`Esta caja ya fue cerrada el ${new Date(c.ts).toLocaleString('es-ES')} por ${c.usuario}`});
    }
    return res.json({ok:true,puede_cerrar:true,mensaje:null});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── SALDOS ────────────────────────────────────────────────────
app.get('/api/saldos', auth, async (req,res) => {
  try {
    const data = await asGet(AS_RUTAS_URL, { token:RUTAS_TOKEN, action:'get_saldos' });
    res.json(data.data||{});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── HISTORIAL ─────────────────────────────────────────────────
app.get('/api/historial', authAdmin, async (req,res) => {
  try {
    const { desde, hasta, limit } = req.query;
    const data = await asGet(AS_RUTAS_URL, { token:RUTAS_TOKEN, action:'get_historial', desde:desde||'', hasta:hasta||'', limit:limit||100 });
    // Convertir array a objeto para compatibilidad con frontend
    const arr = data.data||[];
    const obj = {};
    arr.forEach((r,i) => { obj[String(Date.now()-i)] = r; });
    res.json(obj);
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── NC CONFIRMACIONES ─────────────────────────────────────────
app.get('/api/nc/confirmaciones', auth, async (req,res) => {
  try {
    const data = await asGet(AS_RUTAS_URL, { token:RUTAS_TOKEN, action:'get_nc_confs' });
    res.json(data.data||{});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/nc/confirmar', authContab, async (req,res) => {
  try {
    const data = await asPost(AS_RUTAS_URL, { token:CAJA_TOKEN, action:'set_nc_conf', ...req.body });
    res.json(data);
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── PROXY NO CONFIRMADOS (Apps Script NC) ─────────────────────
app.get('/api/noconfirmados', auth, async (req,res) => {
  const { desde, hasta } = req.query;
  try {
    const data = await asGet(AS_NC_URL, { token:'ORUMx2026CajaStats', action:'registros', desde, hasta });
    res.json(data);
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── PROXY RENTMAN (sin cambios) ───────────────────────────────
const AS_RENTMAN_URL = AS_RUTAS_URL;

app.get('/api/caja/facturas', auth, async (req,res) => {
  try {
    const { desde, hasta } = req.query;
    const data = await asGet(AS_RENTMAN_URL, { token:RUTAS_TOKEN, action:'invoicepayments', desde, hasta });
    res.json(data.data ? { facturas: data.data } : data);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT, ()=>console.log('ORUM Caja puerto '+PORT));

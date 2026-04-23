const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const RENTMAN_BASE = 'https://api.rentman.net';
const RENTMAN_TOKEN = process.env.RENTMAN_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3NzMxNTM0MjIsIm1lZGV3ZXJrZXIiOjIzNSwiYWNjb3VudCI6InNlcnZpY2lvc3lhbHF1aWxlcnBhcmFldmVudG9zc2wiLCJjbGllbnRfdHlwZSI6Im9wZW5hcGkiLCJjbGllbnQubmFtZSI6Im9wZW5hcGkiLCJleHAiOjIwODg3NzI2MjIsImlzcyI6IntcIm5hbWVcIjpcImJhY2tlbmRcIixcInZlcnNpb25cIjpcIjQuODI4LjAuNlwifSJ9.hyHIfRnBGkLunqFAzG40c95AjpkWJfywelT_RiTcXDs';

// ─── USUARIOS ─────────────────────────────────────────────────────────────────
const USUARIOS = {
  marina:  { password: 'Orum2026#Mar', rol: 'caja' },
  danilo:  { password: 'Orum2026#Dan', rol: 'caja' },
  maria:   { password: 'Orum2026#Mia', rol: 'caja' },
  isabel:  { password: 'Orum2026#Isa', rol: 'contabilidad' },
  ana:     { password: 'Orum2026#Ana', rol: 'contabilidad' },
  sergio:  { password: 'Orum2026#Ser', rol: 'admin' }
};

// ─── SESIONES ─────────────────────────────────────────────────────────────────
const sesiones = {};
function generarToken() { return crypto.randomBytes(32).toString('hex'); }
function getSesion(req) {
  const t = req.headers['x-session-token'];
  if (!t || !sesiones[t]) return null;
  if (Date.now() > sesiones[t].expira) { delete sesiones[t]; return null; }
  sesiones[t].expira = Date.now() + 8 * 60 * 60 * 1000;
  return sesiones[t];
}
function requireAuth(req, res, next) {
  if (!getSesion(req)) return res.status(401).json({ error: 'No autenticado' });
  next();
}
function requireContabilidad(req, res, next) {
  const s = getSesion(req);
  if (!s) return res.status(401).json({ error: 'No autenticado' });
  // contabilidad + admin (sergio) pueden acceder
  if (s.rol !== 'contabilidad' && s.rol !== 'admin') return res.status(403).json({ error: 'Sin permisos' });
  next();
}

// ─── PERSISTENCIA TICKS CONTABILIDAD ─────────────────────────────────────────
const TICKS_FILE = path.join(__dirname, 'data', 'ticks.json');
function cargarTicks() {
  try {
    if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'));
    if (!fs.existsSync(TICKS_FILE)) return {};
    return JSON.parse(fs.readFileSync(TICKS_FILE, 'utf8'));
  } catch(e) { return {}; }
}
function guardarTicks(ticks) {
  try {
    if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'));
    fs.writeFileSync(TICKS_FILE, JSON.stringify(ticks, null, 2));
  } catch(e) { console.error('Error guardando ticks:', e.message); }
}
let ticksContabilidad = cargarTicks();

// ─── AUTH ENDPOINTS ───────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { usuario, password } = req.body;
  const user = (usuario || '').toLowerCase().trim();
  const u = USUARIOS[user];
  if (!u || u.password !== password) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  const token = generarToken();
  sesiones[token] = { usuario: user, rol: u.rol, expira: Date.now() + 8 * 60 * 60 * 1000 };
  res.json({ ok: true, token, usuario: user, rol: u.rol });
});

app.post('/api/logout', (req, res) => {
  const t = req.headers['x-session-token'];
  if (t) delete sesiones[t];
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const s = getSesion(req);
  if (!s) return res.status(401).json({ error: 'No autenticado' });
  res.json({ ok: true, usuario: s.usuario, rol: s.rol });
});

// ─── HELPERS RENTMAN ──────────────────────────────────────────────────────────
async function rentmanGetAll(endpoint, extraParams = {}) {
  let offset = 0; const limit = 100; let all = [];
  while (true) {
    const params = new URLSearchParams({ limit, offset, ...extraParams });
    const res = await fetch(`${RENTMAN_BASE}${endpoint}?${params}`, {
      headers: { 'Authorization': 'Bearer ' + RENTMAN_TOKEN.trim(), 'Content-Type': 'application/json' }
    });
    if (!res.ok) { const t = await res.text(); throw new Error(`Rentman ${res.status}: ${t}`); }
    const json = await res.json();
    const items = json.data || [];
    all = all.concat(items);
    if (items.length < limit) break;
    offset += limit;
  }
  return all;
}

async function rentmanGet(endpoint) {
  const res = await fetch(`${RENTMAN_BASE}${endpoint}`, {
    headers: { 'Authorization': 'Bearer ' + RENTMAN_TOKEN.trim(), 'Content-Type': 'application/json' }
  });
  if (!res.ok) return null;
  return (await res.json()).data || null;
}

// ─── DETECCIÓN ABREBOTELLAS ───────────────────────────────────────────────────
// Busca si un proyecto tiene el equipo /equipment/1600 en algún subproyecto
async function proyectosConAbrebotellas(projectIds) {
  // Descarga todos los projectequipment y filtra por equipment path
  const eq = await rentmanGetAll('/projectequipment');
  const ABREBOTELLA_PATH = '/equipment/1600';
  // Agrupar por grupo de equipo
  const gruposConAbreb = new Set();
  eq.forEach(e => {
    if ((e.equipment || '') === ABREBOTELLA_PATH) {
      gruposConAbreb.add(e.equipment_group);
    }
  });

  // Para cada grupo encontrado, buscar el subproyecto y proyecto
  const projectsConAbreb = new Set();
  for (const grupPath of gruposConAbreb) {
    if (!grupPath) continue;
    const grupId = grupPath.split('/').pop();
    try {
      const grup = await rentmanGet(`/projectequipmentgroup/${grupId}`);
      if (grup && grup.project) {
        const projId = grup.project.split('/').pop();
        projectsConAbreb.add(projId);
      }
    } catch(e) {}
  }
  return projectsConAbreb;
}

// ─── GET /api/pagos ───────────────────────────────────────────────────────────
app.get('/api/pagos', requireAuth, async (req, res) => {
  const { fecha, ubicacion = 'all' } = req.query;
  if (!fecha) return res.status(400).json({ error: 'Fecha requerida' });

  try {
    // 1. Métodos de pago
    const metodosData = await rentmanGetAll('/paymentmethods');
    const metodoMap = {};
    metodosData.forEach(m => { metodoMap[m.id] = m.name || m.displayname || ''; });

    // 2. Pagos del día
    const payments = await rentmanGetAll('/invoicepayments', {
      'paymentdate[gte]': `${fecha} 00:00:00`,
      'paymentdate[lte]': `${fecha} 23:59:59`
    });

    // 3. Mapear
    const pagosRaw = payments.map(p => {
      const metodoParts = (p.paymentmethod || '').split('/');
      const metodoId = parseInt(metodoParts[metodoParts.length - 1]);
      const metodoNombre = metodoMap[metodoId] || '';
      let ubicPago = null, tipoPago = null;
      if (metodoNombre === 'Efectivo Marbella') { ubicPago = 'marbella'; tipoPago = 'efectivo'; }
      else if (metodoNombre === 'TPV Marbella')  { ubicPago = 'marbella'; tipoPago = 'tpv'; }
      else if (metodoNombre === 'Efectivo Monda') { ubicPago = 'monda';   tipoPago = 'efectivo'; }
      else if (metodoNombre === 'TPV Monda')      { ubicPago = 'monda';   tipoPago = 'tpv'; }
      const invoiceParts = (p.invoice || '').split('/');
      const invoiceId = invoiceParts[invoiceParts.length - 1];
      return { id: p.id, importe: parseFloat(p.amount)||0, fecha: p.paymentdate, metodo: metodoNombre, ubicacion: ubicPago, tipo: tipoPago, invoiceId, numero_factura: invoiceId, cliente: '', proyecto_numero: '', proyecto_nombre: '', proyecto_id: '', importe_base: null, tiene_abrebotellas: false };
    });

    let resultado = pagosRaw.filter(p => p.ubicacion !== null);
    if (ubicacion !== 'all') resultado = resultado.filter(p => p.ubicacion === ubicacion);

    // 4. Enriquecer con datos de factura
    const invoiceIds = [...new Set(resultado.map(p => p.invoiceId).filter(Boolean))];
    const invoiceMap = {};
    for (const invId of invoiceIds) {
      try {
        const inv = await rentmanGet(`/invoices/${invId}`);
        if (inv) {
          invoiceMap[invId] = {
            numero: inv.number || invId,
            cliente: inv.contact?.displayname || inv.customer_displayname || '',
            proyecto_numero: inv.project?.number || '',
            proyecto_nombre: inv.project?.name || '',
            proyecto_id: inv.project ? (inv.project.id || inv.project.split?.('/').pop() || '') : '',
            importe_base: parseFloat(inv.total_without_vat || inv.subtotal || 0),
            importe_total: parseFloat(inv.total_with_vat || inv.total || 0)
          };
        }
      } catch(e) {}
    }

    resultado.forEach(p => {
      const det = invoiceMap[p.invoiceId] || {};
      p.numero_factura = det.numero || p.invoiceId;
      p.cliente = det.cliente || '';
      p.proyecto_numero = det.proyecto_numero || '';
      p.proyecto_nombre = det.proyecto_nombre || '';
      p.proyecto_id = det.proyecto_id || '';
      p.importe_base = det.importe_base || null;
      p.importe_total = det.importe_total || p.importe;
    });

    // 5. Detectar abrebotellas
    const projectIds = [...new Set(resultado.map(p => p.proyecto_id).filter(Boolean))];
    let proyectosAbreb = new Set();
    if (projectIds.length > 0) {
      try { proyectosAbreb = await proyectosConAbrebotellas(projectIds); } catch(e) { console.error('Error abrebotellas:', e.message); }
    }
    resultado.forEach(p => { if (p.proyecto_id && proyectosAbreb.has(p.proyecto_id)) p.tiene_abrebotellas = true; });

    // 6. Añadir estado de tick de contabilidad
    resultado.forEach(p => {
      const tickKey = `${fecha}_${p.invoiceId}`;
      p.tick_contabilidad = ticksContabilidad[tickKey] || null;
    });

    // 7. Agrupar por caja
    const resumen = {
      marbella: { efectivo: 0, tpv: 0, total: 0, pagos: [] },
      monda:    { efectivo: 0, tpv: 0, total: 0, pagos: [] }
    };
    resultado.forEach(p => {
      resumen[p.ubicacion][p.tipo] += p.importe;
      resumen[p.ubicacion].total  += p.importe;
      resumen[p.ubicacion].pagos.push(p);
    });

    // 8. Caja abrebotellas: pagos en efectivo de proyectos con abrebotellas, importe base
    const pagosAbreb = resultado.filter(p => p.tiene_abrebotellas && p.tipo === 'efectivo');
    const cajaAbrebotellas = {
      total_base: pagosAbreb.reduce((s, p) => s + (p.importe_base || 0), 0),
      pagos: pagosAbreb
    };

    res.json({ ok: true, fecha, resumen, pagos: resultado, cajaAbrebotellas });

  } catch(err) {
    console.error('Error /api/pagos:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── TICKS CONTABILIDAD ───────────────────────────────────────────────────────
app.post('/api/tick', requireContabilidad, (req, res) => {
  const s = getSesion(req);
  const { fecha, invoiceId, marcado } = req.body;
  if (!fecha || !invoiceId) return res.status(400).json({ error: 'fecha e invoiceId requeridos' });
  const key = `${fecha}_${invoiceId}`;
  if (marcado) {
    ticksContabilidad[key] = { usuario: s.usuario, fecha_tick: new Date().toISOString(), invoiceId, fecha };
  } else {
    delete ticksContabilidad[key];
  }
  guardarTicks(ticksContabilidad);
  res.json({ ok: true, key, marcado, usuario: s.usuario });
});

app.get('/api/ticks', requireContabilidad, (req, res) => {
  const { fecha } = req.query;
  if (fecha) {
    const filtrado = {};
    Object.entries(ticksContabilidad).forEach(([k, v]) => { if (v.fecha === fecha) filtrado[k] = v; });
    return res.json({ ok: true, ticks: filtrado });
  }
  res.json({ ok: true, ticks: ticksContabilidad });
});

// ─── STATIC ───────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Caja ORUM en puerto ${PORT}`));

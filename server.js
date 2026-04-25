const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Token de Rentman — se envía al frontend al hacer login para que llame directamente
const RENTMAN_TOKEN = (process.env.RENTMAN_TOKEN || '').trim();

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
  if (s.rol !== 'contabilidad' && s.rol !== 'admin') return res.status(403).json({ error: 'Sin permisos' });
  next();
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { usuario, password } = req.body;
  const user = (usuario || '').toLowerCase().trim();
  const u = USUARIOS[user];
  if (!u || u.password !== password) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  const token = generarToken();
  sesiones[token] = { usuario: user, rol: u.rol, expira: Date.now() + 8 * 60 * 60 * 1000 };
  // Enviamos el token de Rentman al frontend para que llame directamente
  res.json({ ok: true, token, usuario: user, rol: u.rol, rentmanToken: RENTMAN_TOKEN });
});

app.post('/api/logout', (req, res) => {
  const t = req.headers['x-session-token'];
  if (t) delete sesiones[t];
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const s = getSesion(req);
  if (!s) return res.status(401).json({ error: 'No autenticado' });
  res.json({ ok: true, usuario: s.usuario, rol: s.rol, rentmanToken: RENTMAN_TOKEN });
});

// ─── PERSISTENCIA TICKS ───────────────────────────────────────────────────────
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

app.get('/api/ticks', requireAuth, (req, res) => {
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

app.listen(PORT, () => console.log(`Caja ORUM en puerto ${PORT} — Token: ${RENTMAN_TOKEN.length} chars`));

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const TICKS_FILE = path.join(DATA_DIR, 'ticks.json');
const CAJA_FILE  = path.join(DATA_DIR, 'caja_registros.json');

function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const USERS = {
  marina:  { pass: 'Orum2026#Mar', rol: 'caja',         nombre: 'Marina' },
  danilo:  { pass: 'Orum2026#Dan', rol: 'caja',         nombre: 'Danilo' },
  maria:   { pass: 'Orum2026#Mia', rol: 'caja',         nombre: 'María' },
  isabel:  { pass: 'Orum2026#Isa', rol: 'contabilidad', nombre: 'Isabel' },
  ana:     { pass: 'Orum2026#Ana', rol: 'contabilidad', nombre: 'Ana' },
  sergio:  { pass: 'Orum2026#Ser', rol: 'admin',        nombre: 'Sergio' }
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'orum-caja-2026-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

function auth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'No autenticado' });
  next();
}
function authContab(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'No autenticado' });
  if (!['contabilidad', 'admin'].includes(req.session.user.rol))
    return res.status(403).json({ error: 'Sin permisos' });
  next();
}

// ── AUTH ──────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { usuario, password } = req.body;
  const u = USERS[usuario?.toLowerCase()];
  if (!u || u.pass !== password) return res.status(401).json({ error: 'Credenciales incorrectas' });
  req.session.user = { usuario, rol: u.rol, nombre: u.nombre };
  res.json({ ok: true, usuario, rol: u.rol, nombre: u.nombre });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json(req.session.user));

// ── TICKS CONTABILIDAD ────────────────────────────────────────
app.get('/api/ticks', auth, (req, res) => {
  const ticks = loadJSON(TICKS_FILE);
  const { desde, hasta } = req.query;
  if (!desde || !hasta) return res.json(ticks);
  const filtrado = {};
  Object.entries(ticks).forEach(([k, v]) => {
    const fecha = k.split('_')[0];
    if (fecha >= desde && fecha <= hasta) filtrado[k] = v;
  });
  res.json(filtrado);
});

app.post('/api/tick', authContab, (req, res) => {
  const { key, valor, nota, usuario } = req.body;
  if (!key) return res.status(400).json({ error: 'key requerida' });
  const ticks = loadJSON(TICKS_FILE);
  if (valor === null || valor === undefined) {
    delete ticks[key];
  } else {
    ticks[key] = { valor, nota: nota || '', usuario: usuario || '', fecha: new Date().toISOString() };
  }
  saveJSON(TICKS_FILE, ticks);
  res.json({ ok: true });
});

// ── REGISTROS CAJA (métodos de pago asignados manualmente) ────
app.get('/api/caja/registros', auth, (req, res) => {
  const registros = loadJSON(CAJA_FILE);
  const { desde, hasta } = req.query;
  if (!desde || !hasta) return res.json(registros);
  const filtrado = {};
  Object.entries(registros).forEach(([k, v]) => {
    if (v.fecha_pago >= desde && v.fecha_pago <= hasta) filtrado[k] = v;
  });
  res.json(filtrado);
});

app.post('/api/caja/registro', auth, (req, res) => {
  const { factura_id, metodo_pago, ubicacion, tipo, importe, cliente, numero, fecha_pago, es_abrebotellas, usuario } = req.body;
  if (!factura_id || !metodo_pago) return res.status(400).json({ error: 'factura_id y metodo_pago requeridos' });
  const registros = loadJSON(CAJA_FILE);
  const key = String(factura_id);
  registros[key] = {
    factura_id, metodo_pago, ubicacion, tipo, importe,
    cliente, numero, fecha_pago, es_abrebotellas,
    usuario, updated: new Date().toISOString()
  };
  saveJSON(CAJA_FILE, registros);
  res.json({ ok: true });
});

app.delete('/api/caja/registro/:id', auth, (req, res) => {
  const registros = loadJSON(CAJA_FILE);
  delete registros[req.params.id];
  saveJSON(CAJA_FILE, registros);
  res.json({ ok: true });
});

// ── SERVE APP ─────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log('ORUM Caja corriendo en puerto ' + PORT));

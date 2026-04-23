const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const RENTMAN_BASE = 'https://api.rentman.net';

// ─── HELPER: fetch all pages from Rentman ───────────────────────────────────
async function rentmanGetAll(path, token, extraParams = {}) {
  let offset = 0;
  const limit = 100;
  let allItems = [];

  while (true) {
    const params = new URLSearchParams({ limit, offset, ...extraParams });
    const url = `${RENTMAN_BASE}${path}?${params}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Rentman API error ${res.status}: ${txt}`);
    }

    const json = await res.json();
    const items = json.data || [];
    allItems = allItems.concat(items);

    if (items.length < limit) break;
    offset += limit;
  }

  return allItems;
}

// ─── ENDPOINT: GET /api/pagos ────────────────────────────────────────────────
// Devuelve todos los pagos (invoicepayments) filtrados por fecha y ubicación
// Query params: token, fecha (YYYY-MM-DD), ubicacion (marbella|monda|all)
app.get('/api/pagos', async (req, res) => {
  const { token, fecha, ubicacion = 'all' } = req.query;

  if (!token) return res.status(400).json({ error: 'Token requerido' });
  if (!fecha) return res.status(400).json({ error: 'Fecha requerida (YYYY-MM-DD)' });

  try {
    // Obtener todos los invoice payments del día
    const payments = await rentmanGetAll('/invoicepayments', token, {
      'paymentdate[gte]': `${fecha} 00:00:00`,
      'paymentdate[lte]': `${fecha} 23:59:59`
    });

    // Métodos de pago ORUM
    const METODOS = {
      marbella: {
        efectivo: 'Efectivo Marbella',
        tpv: 'TPV Marbella'
      },
      monda: {
        efectivo: 'Efectivo Monda',
        tpv: 'TPV Monda'
      }
    };

    // Para cada pago, necesitamos obtener el nombre del método de pago
    // invoicepayments tiene: amount, paymentdate, paymentmethod (path like /paymentmethods/3), invoice
    // Primero cargamos los métodos de pago disponibles
    const metodosRes = await fetch(`${RENTMAN_BASE}/paymentmethods?limit=100`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    const metodosJson = await metodosRes.json();
    const metodoMap = {};
    (metodosJson.data || []).forEach(m => {
      metodoMap[m.id] = m.name || m.displayname || '';
    });

    // Enriquecer pagos con nombre del método
    const pagosEnriquecidos = payments.map(p => {
      // paymentmethod viene como "/paymentmethods/3" → extraer id
      const metodoParts = (p.paymentmethod || '').split('/');
      const metodoId = parseInt(metodoParts[metodoParts.length - 1]);
      const metodoNombre = metodoMap[metodoId] || p.paymentmethod || '';

      // Determinar ubicación y tipo
      let ubicPago = null;
      let tipoPago = null;

      if (metodoNombre === METODOS.marbella.efectivo) { ubicPago = 'marbella'; tipoPago = 'efectivo'; }
      else if (metodoNombre === METODOS.marbella.tpv) { ubicPago = 'marbella'; tipoPago = 'tpv'; }
      else if (metodoNombre === METODOS.monda.efectivo) { ubicPago = 'monda'; tipoPago = 'efectivo'; }
      else if (metodoNombre === METODOS.monda.tpv) { ubicPago = 'monda'; tipoPago = 'tpv'; }

      // Extraer número de factura del path
      const invoiceParts = (p.invoice || '').split('/');
      const invoiceId = invoiceParts[invoiceParts.length - 1];

      return {
        id: p.id,
        importe: parseFloat(p.amount) || 0,
        fecha: p.paymentdate,
        metodo: metodoNombre,
        metodoId,
        ubicacion: ubicPago,
        tipo: tipoPago,
        invoiceRef: p.invoice || '',
        invoiceId,
        numero_factura: p.invoice_number || invoiceId,
        cliente: p.customer_displayname || '',
        proyecto: p.project_number || ''
      };
    });

    // Filtrar por ubicación si aplica
    let resultado = pagosEnriquecidos.filter(p => p.ubicacion !== null);
    if (ubicacion !== 'all') {
      resultado = resultado.filter(p => p.ubicacion === ubicacion);
    }

    // Para obtener más detalle (cliente, nº proyecto), enriquecer con facturas
    // Solo si hay pagos - hacemos batch
    const invoiceIds = [...new Set(resultado.map(p => p.invoiceId).filter(Boolean))];
    const invoiceDetails = {};

    for (const invId of invoiceIds) {
      try {
        const invRes = await fetch(`${RENTMAN_BASE}/invoices/${invId}`, {
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
        });
        if (invRes.ok) {
          const invJson = await invRes.json();
          const inv = invJson.data;
          if (inv) {
            invoiceDetails[invId] = {
              numero: inv.number || inv.displayname || invId,
              cliente: inv.contact ? inv.contact.displayname || '' : (inv.customer_displayname || ''),
              proyecto_numero: inv.project ? inv.project.number || '' : '',
              proyecto_nombre: inv.project ? inv.project.name || '' : '',
              total: parseFloat(inv.total_with_vat) || 0
            };
          }
        }
      } catch (e) {
        // ignorar error individual
      }
    }

    // Merge invoice details
    resultado = resultado.map(p => {
      const det = invoiceDetails[p.invoiceId] || {};
      return {
        ...p,
        numero_factura: det.numero || p.invoiceId,
        cliente: det.cliente || p.cliente,
        proyecto_numero: det.proyecto_numero || p.proyecto,
        proyecto_nombre: det.proyecto_nombre || '',
        total_factura: det.total || null
      };
    });

    // Calcular resumen por caja
    const resumen = {
      marbella: { efectivo: 0, tpv: 0, total: 0, pagos: [] },
      monda: { efectivo: 0, tpv: 0, total: 0, pagos: [] }
    };

    resultado.forEach(p => {
      if (p.ubicacion && resumen[p.ubicacion]) {
        resumen[p.ubicacion][p.tipo] += p.importe;
        resumen[p.ubicacion].total += p.importe;
        resumen[p.ubicacion].pagos.push(p);
      }
    });

    res.json({ ok: true, fecha, resumen, pagos: resultado });

  } catch (err) {
    console.error('Error /api/pagos:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── ENDPOINT: GET /api/pagos/rango ─────────────────────────────────────────
// Devuelve pagos en un rango de fechas para histórico
app.get('/api/pagos/rango', async (req, res) => {
  const { token, desde, hasta, ubicacion = 'all' } = req.query;
  if (!token || !desde || !hasta) {
    return res.status(400).json({ error: 'Token, desde y hasta son requeridos' });
  }

  try {
    const payments = await rentmanGetAll('/invoicepayments', token, {
      'paymentdate[gte]': `${desde} 00:00:00`,
      'paymentdate[lte]': `${hasta} 23:59:59`
    });

    const metodosRes = await fetch(`${RENTMAN_BASE}/paymentmethods?limit=100`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    const metodosJson = await metodosRes.json();
    const metodoMap = {};
    (metodosJson.data || []).forEach(m => { metodoMap[m.id] = m.name || m.displayname || ''; });

    const NOMBRES_VALIDOS = ['Efectivo Marbella', 'TPV Marbella', 'Efectivo Monda', 'TPV Monda'];

    const resultado = payments.map(p => {
      const metodoParts = (p.paymentmethod || '').split('/');
      const metodoId = parseInt(metodoParts[metodoParts.length - 1]);
      const metodoNombre = metodoMap[metodoId] || '';
      let ubicPago = null;
      let tipoPago = null;
      if (metodoNombre === 'Efectivo Marbella') { ubicPago = 'marbella'; tipoPago = 'efectivo'; }
      else if (metodoNombre === 'TPV Marbella') { ubicPago = 'marbella'; tipoPago = 'tpv'; }
      else if (metodoNombre === 'Efectivo Monda') { ubicPago = 'monda'; tipoPago = 'efectivo'; }
      else if (metodoNombre === 'TPV Monda') { ubicPago = 'monda'; tipoPago = 'tpv'; }
      const invoiceParts = (p.invoice || '').split('/');
      return {
        id: p.id,
        importe: parseFloat(p.amount) || 0,
        fecha: (p.paymentdate || '').substring(0, 10),
        metodo: metodoNombre,
        ubicacion: ubicPago,
        tipo: tipoPago,
        invoiceId: invoiceParts[invoiceParts.length - 1]
      };
    }).filter(p => p.ubicacion !== null && (ubicacion === 'all' || p.ubicacion === ubicacion));

    res.json({ ok: true, desde, hasta, pagos: resultado });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ENDPOINT: POST /api/caja/cierre ────────────────────────────────────────
// Genera datos del documento de cierre (el PDF se genera en el frontend)
app.post('/api/caja/cierre', (req, res) => {
  const { ubicacion, fecha, saldo_inicial, retiradas, pagos_efectivo, pagos_tpv } = req.body;

  const total_efectivo_esperado = pagos_efectivo + saldo_inicial;
  const total_retiradas = retiradas.reduce((s, r) => s + r.importe, 0);
  const saldo_final = total_efectivo_esperado - total_retiradas;

  res.json({
    ok: true,
    resumen: {
      ubicacion,
      fecha,
      saldo_inicial,
      cobros_efectivo: pagos_efectivo,
      cobros_tpv: pagos_tpv,
      total_efectivo_esperado,
      total_retiradas,
      saldo_final,
      retiradas
    }
  });
});

// ─── SERVE FRONTEND ──────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🏦 Caja ORUM corriendo en puerto ${PORT}`);
});

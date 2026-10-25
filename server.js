const express = require('express');
const session = require('express-session');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const app = express();

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;
const PORT = process.env.PORT || 3000;
const USERS = {
  // marina: excedencia desde 1 oct 2026 - descomentar para devolverle el acceso
  // marina: { pass:'Orum2026#Mar', rol:'comercial',    nombre:'Marina' },
  danilo: { pass:'Orum2026#Dan', rol:'comercial',    nombre:'Danilo' },
  maria:  { pass:'Orum2026#Mia', rol:'caja',         nombre:'María' },
  lucas:  { pass:'Orum2026#Luc', rol:'comercial',    nombre:'Lucas' },
  isabel: { pass:'Orum2026#Isa', rol:'contabilidad', nombre:'Isabel' },
  ana:    { pass:'Orum2026#Ana', rol:'contabilidad', nombre:'Ana' },
  sergio: { pass:'Orum2026#Ser', rol:'admin',        nombre:'Sergio' }
};
const AS_RUTAS_URL   = 'https://script.google.com/macros/s/AKfycbxaSfXi-D3Sx8Lpek6pHPaA-2_NgrXW6CTM0d37LlCX-x0hqRLM6BwyH-BIinyiJlAi/exec';
const AS_NC_URL      = 'https://script.google.com/macros/s/AKfycbx1ayolXUAmk95s8M2bUS_46O7HQrM4gmQgh1mQF9zOCuOvEQfp59K94TnDYpopE73QmA/exec';
const AS_FIANZAS_URL = process.env.AS_FIANZAS_URL || 'PON_AQUI_URL_FIANZAS_SCRIPT';
const RUTAS_TOKEN    = 'ORUMx2026CajaStats';
const FIANZAS_TOKEN  = 'ORUMx2026#Fianzas$Secret';
const RENTMAN_TOKEN  = process.env.RENTMAN_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3NzMxNTM0MjIsIm1lZGV3ZXJrZXIiOjIzNSwiYWNjb3VudCI6InNlcnZpY2lvc3lhbHF1aWxlcnBhcmFldmVudG9zc2wiLCJjbGllbnRfdHlwZSI6Im9wZW5hcGkiLCJjbGllbnQubmFtZSI6Im9wZW5hcGkiLCJleHAiOjIwODg3NzI2MjIsImlzcyI6IntcIm5hbWVcIjpcImJhY2tlbmRcIixcInZlcnNpb25cIjpcIjQuODI4LjAuNlwifSJ9.hyHIfRnBGkLunqFAzG40c95AjpkWJfywelT_RiTcXDs';
const RENTMAN_URL    = 'https://api.rentman.net';
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
// ── CAJA: registros, cierres, saldos, retiradas, ticks, historial y No
// Confirmados, todo en Supabase - ver lib/caja.js. Las hojas solo se leen
// para la importación (asGet / asGetNC).
require('./lib/caja').registrar(app, {
  supabase, auth, authAdmin, authContab, authCaja, authCobros,
  leerHojaCaja: params => asGet({ token: RUTAS_TOKEN, ...params }),
  leerHojaNC:   params => asGetNC({ token: RUTAS_TOKEN, ...params })
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
      // pago_id explícito además de "id" (que Caja Diaria reutiliza como
      // clave de fila) - así al guardar el registro se manda sin ambigüedad,
      // igual que factura_id (el id de la factura en Rentman, no del pago -
      // hace falta aparte porque una factura puede tener varios pagos/filas).
      pago_id: p.pago_id,
      factura_id: p.factura_id,
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
// Fianzas: rutas y carga en lib/fianzas.js (registradas más abajo, junto al helper del Apps Script).

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
    const fianzas = await fianzasModulo.fianzas(false);

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

    // (11 sep 2026) Proyectos con un registro manual ya asignado
    // (caja_registro_cobros.numero_proyecto) que no salen en `fianzas` -
    // porque el proyecto no tiene fianza en Rentman, o su fianza no pasa el
    // filtro de lib/fianzas.js (importe/estado). Sin esto, un registro
    // manual asignado a uno de estos proyectos desaparecía de la pantalla por
    // completo: dejaba de contar como "manual" (ya tiene numero_proyecto) pero
    // tampoco salía como fila real (el proyecto no estaba en `fianzas`).
    const numerosSoloOverride = [...new Set((overrides || []).map(o => o.numero_proyecto).filter(n => n != null))]
      .filter(n => numerosConfirmados.indexOf(n) === -1);
    if (numerosSoloOverride.length) {
      const { data: proyExtra, error: errProyExtra } = await supabase.from('proyectos')
        .select('id,numero,estado,cancelado,cliente,es_abrebotellas,entrega_fecha_raw')
        .in('numero', numerosSoloOverride);
      if (errProyExtra) throw errProyExtra;
      (proyExtra || []).forEach(p => {
        if (p.cancelado || p.es_abrebotellas) return;
        // Aún en fase comercial (Pending/Concept/Inquiry) - no forzamos su
        // aparición aquí, mismo criterio que numerosConfirmados arriba.
        if (PIPELINE_COMERCIAL.indexOf(String(p.estado || '').toLowerCase()) !== -1) return;
        proyectoPorNumero[p.numero] = p;
      });
    }

    const proyectoIds = [...numerosConfirmados, ...numerosSoloOverride]
      .map(n => proyectoPorNumero[n] && proyectoPorNumero[n].id)
      .filter(x => x != null);

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
    // Incluye tanto los proyectos con fianza (proyectosData) como los
    // "solo override" añadidos arriba a proyectoPorNumero.
    Object.values(proyectoPorNumero).forEach(p => { numeroProyectoPorId[p.id] = p.numero; });
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

    // Igual que registrosPorNumero pero SIN excluir el efectivo - solo para
    // calcular "Pendiente": el efectivo no cuenta en la columna "Cobrado" (se
    // audita aparte, en el cuadre diario de Caja), pero si ya está registrado
    // en Caja Diaria como efectivo, no es dinero que falte por cobrar. Antes
    // de este cruce, un proyecto pagado 100% en efectivo salía siempre con
    // Pendiente en rojo aunque ya estuviera todo controlado (caso real:
    // proyecto #1921, factura 261322 cobrada en efectivo-Monda por María).
    const registrosConEfectivoPorNumero = {};
    registros.forEach(r => {
      if (r.es_abrebotellas) return;
      if (String(r.tipo || '').toLowerCase() === 'otro') return;
      const numFactura = parseInt(r.numero);
      if (isNaN(numFactura)) return;
      const proyId = proyectoIdPorNumeroFactura[numFactura];
      if (proyId == null) return;
      const numProyecto = numeroProyectoPorId[proyId];
      if (numProyecto == null) return;
      if (!registrosConEfectivoPorNumero[numProyecto]) registrosConEfectivoPorNumero[numProyecto] = [];
      registrosConEfectivoPorNumero[numProyecto].push(r);
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
      // "Pendiente" del proyecto: si el override manual de "cobrado" no cubre
      // ya el importe, comprobamos también el efectivo (registrosConEfectivoPorNumero)
      // antes de dar por pendiente algo que en realidad ya está cobrado, solo
      // que en efectivo (caso real: proyecto #1921, factura 261322, cobrada en
      // efectivo-Monda por María - "Cobrado" la excluye a propósito, pero no
      // por eso está pendiente de verdad). El propio importe registrado con
      // override manda si es mayor (el usuario corrigió algo a mano).
      const regsConEfectivo = registrosConEfectivoPorNumero[numero] || [];
      const cobradoConEfectivoAuto = Math.round(regsConEfectivo.reduce((s, r) => s + (parseFloat(r.importe) || 0), 0) * 100) / 100;
      const cobradoParaPendiente = Math.max(parseFloat(cobrado) || 0, cobradoConEfectivoAuto);
      const pendienteCubiertoPorEfectivo = cobradoConEfectivoAuto > (parseFloat(cobrado) || 0) + 0.01;
      const pendienteProyecto = (parseFloat(importeProyecto) || 0) - cobradoParaPendiente;
      const pendiente = pendienteProyecto + pendienteFianza;
      const finalizado = pendiente <= 0.01 && (estadoFianza === 'devuelta' || estadoFianza === 'no_aplica');
      // Aviso "sin registrar en Caja": alguna factura del proyecto está pagada
      // en Rentman (esta_pagada=true) pero no tiene NINGÚN registro en Caja
      // Diaria (de ningún tipo, ni siquiera efectivo) - el dinero ya entró,
      // solo falta que alguien lo cuadre aquí.
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
        pendiente: Math.round(pendiente * 100) / 100,
        pendiente_cubierto_efectivo: pendienteCubiertoPorEfectivo,
        sin_registro_caja: sinRegistroCaja,
        actualizado_por: ov ? ov.actualizado_por : null,
        actualizado_en: ov ? ov.actualizado_en : null
      };
    });

    // Filas de proyectos con registro manual asignado pero sin fianza real en
    // Rentman que cuente para esta vista (ver numerosSoloOverride arriba).
    // Mismo cálculo que las filas normales, pero partiendo del override en
    // vez de una fianza (no hay f.importe/f.estado_id/f.comercial que usar).
    const filasSoloOverride = numerosSoloOverride.filter(n => proyectoPorNumero[n]).map(numero => {
      const p = proyectoPorNumero[numero];
      const ov = overridesPorProyecto[numero];
      const regs = registrosPorNumero[numero] || [];
      const cobradoAuto = regs.reduce((s, r) => s + (parseFloat(r.importe) || 0), 0);
      const formaPago = [...new Set(regs.map(r => `${r.metodo_pago || ''}${r.ubicacion ? ' · ' + capitalizaUbicacion(r.ubicacion) : ''}`.trim()).filter(Boolean))].join(', ');
      const numOps = [...new Set(regs.map(r => r.num_operacion).filter(Boolean))].join(', ');
      const fechaPago = regs.map(r => r.fecha_pago_raw).filter(Boolean).sort().pop() || null;
      const importeProyecto = (ov && ov.importe_proyecto != null && ov.importe_proyecto !== 0) ? ov.importe_proyecto : Math.round((importeProyectoPorId[p.id] || 0) * 100) / 100;
      const importeFianza = (ov && ov.importe_fianza != null) ? ov.importe_fianza : 0;
      const cobrado = (ov && ov.cobrado != null && ov.cobrado !== 0) ? ov.cobrado : Math.round(cobradoAuto * 100) / 100;
      const estadoFianza = ov && ov.estado_fianza ? ov.estado_fianza : 'no_aplica';
      const pendienteFianza = estadoFianza === 'pendiente' ? (parseFloat(importeFianza) || 0) : 0;
      const regsConEfectivo = registrosConEfectivoPorNumero[numero] || [];
      const cobradoConEfectivoAuto = Math.round(regsConEfectivo.reduce((s, r) => s + (parseFloat(r.importe) || 0), 0) * 100) / 100;
      const cobradoParaPendiente = Math.max(parseFloat(cobrado) || 0, cobradoConEfectivoAuto);
      const pendienteCubiertoPorEfectivo = cobradoConEfectivoAuto > (parseFloat(cobrado) || 0) + 0.01;
      const pendienteProyecto = (parseFloat(importeProyecto) || 0) - cobradoParaPendiente;
      const pendiente = pendienteProyecto + pendienteFianza;
      const finalizado = pendiente <= 0.01 && (estadoFianza === 'devuelta' || estadoFianza === 'no_aplica');
      const facturasPagadas = facturasPagadasPorProyecto[p.id] || [];
      const sinRegistroCaja = facturasPagadas.some(numFact => !facturasConAlgunRegistro.has(numFact));
      return {
        numero_proyecto: numero,
        cliente: (p && p.cliente) ? p.cliente : (ov ? ov.cliente : ''),
        comercial: null,
        importe_proyecto: importeProyecto,
        importe_fianza: importeFianza,
        cobrado: cobrado,
        estado_fianza: estadoFianza,
        metodo_devolucion: ov ? ov.metodo_devolucion : null,
        numero_devolucion_tpv: ov ? ov.numero_devolucion_tpv : null,
        forma_pago: formaPago || null,
        num_operacion_pago: numOps || null,
        fecha_pago: fechaPago,
        fecha_evento: (p && p.entrega_fecha_raw) || (ov ? ov.fecha_cobro : null),
        notas: ov ? ov.notas : null,
        es_manual: false,
        finalizado: finalizado,
        pendiente: Math.round(pendiente * 100) / 100,
        pendiente_cubierto_efectivo: pendienteCubiertoPorEfectivo,
        sin_registro_caja: sinRegistroCaja,
        actualizado_por: ov ? ov.actualizado_por : null,
        actualizado_en: ov ? ov.actualizado_en : null
      };
    });

    // Filas manuales sueltas (ingresos sin identificar todavía, numero_proyecto null)
    // finalizado: false siempre - por definición siguen "por casar" con un
    // proyecto, así que deben verse tanto en Vigentes como en Todos.
    const manuales = (overrides || []).filter(o => o.numero_proyecto == null).map(o => {
      const manualPendienteFianza = o.estado_fianza === 'pendiente' ? (parseFloat(o.importe_fianza) || 0) : 0;
      const manualPendiente = ((parseFloat(o.importe_proyecto) || 0) - (parseFloat(o.cobrado) || 0)) + manualPendienteFianza;
      return {
        id: o.id, numero_proyecto: null, cliente: o.cliente, importe_proyecto: o.importe_proyecto || 0,
        importe_fianza: o.importe_fianza || 0, cobrado: o.cobrado || 0, estado_fianza: o.estado_fianza,
        metodo_devolucion: o.metodo_devolucion, numero_devolucion_tpv: o.numero_devolucion_tpv,
        forma_pago: o.forma_pago_manual || null, num_operacion_pago: null, fecha_pago: null,
        fecha_evento: o.fecha_cobro || null,
        notas: o.notas, es_manual: true, finalizado: false,
        pendiente: Math.round(manualPendiente * 100) / 100, pendiente_cubierto_efectivo: false,
        sin_registro_caja: false,
        actualizado_por: o.actualizado_por, actualizado_en: o.actualizado_en
      };
    });

    const todasLasFilas = filas.concat(filasSoloOverride);
    const totalSinRegistro = todasLasFilas.filter(f => f.sin_registro_caja).length;
    res.json({ ok: true, filas: todasLasFilas.concat(manuales), total_sin_registro_caja: totalSinRegistro });
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

// (9 sep 2026) "Buscar coincidencia" para un registro manual sin identificar:
// cruza su importe (y, de forma más laxa, la fecha) contra Rentman vía
// Supabase - misma técnica que se usó a mano para localizar 3 cobros reales
// el 9 sep 2026 (una factura exacta, una combinación de facturas impagadas
// del mismo cliente, y una fianza pendiente). Todo lee de Supabase (facturas/
// proyectos), no llama a Rentman en directo - más rápido y sin límite de tasa.
const FIANZA_METODO_POR_TEXTO = [
  [/transfer/i, '0'], [/efectivo.*marbella/i, '3'], [/efectivo.*monda/i, '4'],
  [/tpv.*marbella/i, '6'], [/tpv.*monda/i, '7'], [/tpv/i, '5']
];
function metodoFianzaProbable(formaPagoManual) {
  const txt = String(formaPagoManual || '');
  const hit = FIANZA_METODO_POR_TEXTO.find(([re]) => re.test(txt));
  return hit ? hit[1] : null;
}
app.get('/api/registro-cobros/:idManual/sugerencias', authCobros, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: 'Supabase no configurado' });
    const idManual = parseInt(req.params.idManual);
    const { data: fila, error: errFila } = await supabase.from('caja_registro_cobros').select('*').eq('id', idManual).maybeSingle();
    if (errFila) throw errFila;
    if (!fila || !fila.es_manual || fila.numero_proyecto != null) {
      return res.status(400).json({ ok: false, error: 'No es un registro manual sin asignar.' });
    }
    const importe = Math.round((parseFloat(fila.cobrado) || parseFloat(fila.importe_proyecto) || 0) * 100) / 100;
    if (importe <= 0) return res.json({ ok: true, sugerencias: [] });
    const TOL = 0.02;
    const metodoProbable = metodoFianzaProbable(fila.forma_pago_manual);

    const sugerencias = [];

    // Todas las facturas (paginado - la tabla ya supera el límite por defecto
    // de 1000 filas de una sola query). Se filtra en JS: es más simple y
    // seguro que anidar .or()/.lte() para dos campos distintos a la vez.
    let candidatasFactura = [];
    {
      let off = 0;
      while (true) {
        const { data, error } = await supabase.from('facturas')
          .select('proyecto_id,numero,importe_con_iva,pendiente_cobro,esta_pagada,cliente')
          .range(off, off + 999);
        if (error) throw error;
        candidatasFactura = candidatasFactura.concat(data || []);
        if (!data || data.length < 1000) break;
        off += 1000;
      }
    }

    // 1) Factura exacta (importe con IVA, o pendiente de cobro si es parcial)
    candidatasFactura.forEach(f => {
      const porTotal = Math.abs((parseFloat(f.importe_con_iva) || 0) - importe) < TOL;
      const porPendiente = !f.esta_pagada && Math.abs((parseFloat(f.pendiente_cobro) || 0) - importe) < TOL;
      if (porTotal || porPendiente) {
        sugerencias.push({
          tipo: porTotal && f.esta_pagada ? 'factura_exacta' : 'factura_pendiente',
          proyecto_id: f.proyecto_id, numero_factura: f.numero, cliente: f.cliente,
          importe: porTotal ? f.importe_con_iva : f.pendiente_cobro,
          confianza: porTotal && f.esta_pagada ? 'alta' : 'media'
        });
      }
    });

    // 2) Combinación de 2-4 facturas impagadas del mismo cliente que sumen el importe
    const impagadas = candidatasFactura.filter(f => !f.esta_pagada);
    if (impagadas.length) {
      const porCliente = {};
      impagadas.forEach(f => {
        const c = f.cliente || '(?)';
        (porCliente[c] = porCliente[c] || []).push(f);
      });
      Object.keys(porCliente).forEach(cliente => {
        const facs = porCliente[cliente];
        if (facs.length < 2 || facs.length > 10) return;
        const n = facs.length;
        for (let r = 2; r <= Math.min(n, 4); r++) {
          combinaciones(n, r).forEach(combo => {
            const suma = Math.round(combo.reduce((s, i) => s + (parseFloat(facs[i].pendiente_cobro) || 0), 0) * 100) / 100;
            if (Math.abs(suma - importe) < TOL) {
              sugerencias.push({
                tipo: 'combinacion_facturas', cliente,
                proyecto_id: facs[combo[0]].proyecto_id, // referencia, puede haber varios proyectos
                proyectos_ids: [...new Set(combo.map(i => facs[i].proyecto_id))],
                numeros_factura: combo.map(i => facs[i].numero),
                importe: suma, confianza: 'media'
              });
            }
          });
        }
      });
    }

    // 3) Fianza (importe típico, cualquier estado - Pendiente incluida)
    const { data: fianzasCandidatas } = await supabase
      .from('proyectos')
      .select('id,numero,cliente,estado,importe_fianza,estado_fianza_id,forma_pago_fianza_id,entrega_fecha_raw')
      .gte('importe_fianza', importe - TOL).lte('importe_fianza', importe + TOL);
    (fianzasCandidatas || []).forEach(p => {
      const coincideMetodo = metodoProbable && String(p.forma_pago_fianza_id) === metodoProbable;
      sugerencias.push({
        tipo: 'fianza', proyecto_id: p.id, numero_proyecto: p.numero, cliente: p.cliente,
        estado_proyecto: p.estado, fecha_evento: p.entrega_fecha_raw,
        estado_fianza_id: p.estado_fianza_id, importe: p.importe_fianza,
        confianza: coincideMetodo ? 'media' : 'baja'
      });
    });

    // Resolver proyecto_id -> numero/cliente/estado/fecha para las de factura
    // (fianza ya trae numero_proyecto directo de "proyectos").
    const idsProyecto = [...new Set(sugerencias.filter(s => s.proyecto_id != null && s.tipo !== 'fianza').map(s => s.proyecto_id))];
    let proyectosPorId = {};
    if (idsProyecto.length) {
      const { data: proys } = await supabase.from('proyectos').select('id,numero,cliente,estado,entrega_fecha_raw').in('id', idsProyecto);
      (proys || []).forEach(p => { proyectosPorId[p.id] = p; });
    }
    sugerencias.forEach(s => {
      if (s.tipo === 'fianza') return;
      const p = proyectosPorId[s.proyecto_id];
      if (p) { s.numero_proyecto = p.numero; s.cliente = s.cliente || p.cliente; s.estado_proyecto = p.estado; s.fecha_evento = p.entrega_fecha_raw; }
    });

    // Fecha del cobro cerca de la fecha del evento sube la confianza de alta -> alta+ (visual),
    // y de media -> alta cuando además el importe es exacto y único.
    const fechaCobro = fila.fecha_cobro ? new Date(fila.fecha_cobro) : null;
    sugerencias.forEach(s => {
      if (!fechaCobro || !s.fecha_evento) return;
      const [d, m, y] = String(s.fecha_evento).split('/');
      if (!y) return;
      const fEvento = new Date(y, m - 1, d);
      const dias = Math.abs((fechaCobro - fEvento) / (1000 * 60 * 60 * 24));
      s.dias_desde_evento = Math.round(dias);
    });

    // Orden: alta primero, luego media, luego baja; dentro de cada grupo, más cerca en fecha primero.
    const pesoConfianza = { alta: 0, media: 1, baja: 2 };
    sugerencias.sort((a, b) => {
      const pa = pesoConfianza[a.confianza] ?? 3, pb = pesoConfianza[b.confianza] ?? 3;
      if (pa !== pb) return pa - pb;
      const da = a.dias_desde_evento ?? 9999, db = b.dias_desde_evento ?? 9999;
      return da - db;
    });

    res.json({ ok: true, importe_buscado: importe, sugerencias: sugerencias.slice(0, 15) });
  } catch (e) {
    console.error('Error en /api/registro-cobros/:idManual/sugerencias:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});
function combinaciones(n, r) {
  const resultado = [];
  const combo = [];
  function backtrack(inicio) {
    if (combo.length === r) { resultado.push([...combo]); return; }
    for (let i = inicio; i < n; i++) { combo.push(i); backtrack(i + 1); combo.pop(); }
  }
  backtrack(0);
  return resultado;
}

app.post('/api/registro-cobros/:clave', authCobros, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: 'Supabase no configurado' });
    const usuario = req.session.user.usuario;
    const esManual = req.params.clave.startsWith('id-');
    const numeroProyecto = esManual ? null : parseInt(req.params.clave);
    const idManual = esManual ? parseInt(req.params.clave.replace('id-', '')) : null;

    // numero_proyecto incluido aquí (9 sep 2026) para que "Asignar a este
    // proyecto" desde las sugerencias de búsqueda pueda reutilizar este mismo
    // endpoint - una fila manual con numero_proyecto asignado deja de salir
    // en "manuales" (GET de arriba) y pasa a fusionarse con la fila de ese
    // proyecto vía overridesPorProyecto, sin tocar nada más.
    const camposEditables = ['cliente', 'importe_proyecto', 'importe_fianza', 'cobrado', 'estado_fianza', 'metodo_devolucion', 'numero_devolucion_tpv', 'notas', 'fecha_cobro', 'forma_pago_manual', 'numero_proyecto'];
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

// (11 sep 2026) Borrar un registro manual sin identificar (o ya casado) que
// ya no hace falta - p.ej. se casó a mano con varias facturas y el registro
// manual se quedó suelto y lioso. Solo admite claves "id-N" (registros
// manuales) a propósito: la fila real de un proyecto (numero_proyecto) no se
// puede borrar por aquí para evitar borrar por error el histórico de cobros
// de un proyecto real.
app.delete('/api/registro-cobros/id-:idManual', authCobros, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ ok: false, error: 'Supabase no configurado' });
    const idManual = parseInt(req.params.idManual);
    const { data: fila, error: errFila } = await supabase.from('caja_registro_cobros').select('id').eq('id', idManual).maybeSingle();
    if (errFila) throw errFila;
    if (!fila) return res.status(404).json({ ok: false, error: 'Registro no encontrado.' });

    await supabase.from('caja_registro_cobros_historial').delete().eq('registro_id', idManual);
    const { error } = await supabase.from('caja_registro_cobros').delete().eq('id', idManual);
    if (error) throw error;

    res.json({ ok: true });
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
// ── FIANZAS: todo en Supabase, ver lib/fianzas.js ─────────────
// leerHoja solo se usa para la importación única desde la hoja SOLICITUDES.
const fianzasModulo = require('./lib/fianzas').registrar(app, {
  supabase, auth, authCaja, authContab, authAdmin,
  leerHoja: async () => {
    const d = await asFianzasGet({ token: FIANZAS_TOKEN, action: 'get_solicitudes' });
    if (!d.ok) throw new Error('Hoja de fianzas: ' + (d.error || 'sin respuesta'));
    return d.data || [];
  },
  patchRentmanEstado: async (proyectoId, estadoId) => {
    const r = await fetch(RENTMAN_URL + '/projects/' + proyectoId, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + RENTMAN_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ custom: { custom_5: String(estadoId) } })
    });
    if (!r.ok) throw Object.assign(new Error('Rentman ' + r.status + ': ' + (await r.text()).slice(0, 200)), { status: 502 });
  }
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

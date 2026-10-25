// Caja (24 oct 2026): todo en Supabase.
// Antes, todo lo de caja vivía en la hoja del Apps Script de Caja (REGISTROS,
// CIERRES, SALDOS, RETIRADAS, TICKS, HISTORIAL) y el servidor lo cargaba en
// memoria al arrancar; los No Confirmados entraban por un formulario de Google
// a otra hoja. Ahora cada ruta lee y escribe Supabase directamente (SQL en
// orum-central-panel/sql/caja_supabase.sql):
//  - caja_registros         forma de pago de cada pago (ya existía, se escribía a la vez)
//  - caja_cierres           cierres; el saldo arrastrado = saldo_final del último cierre
//  - caja_retiradas         retiradas; al cerrar se marcan cerradas en vez de borrarse
//  - caja_ticks             verificación de Contabilidad
//  - caja_historial         historial (pestaña admin)
//  - caja_nc_formulario     cobros No Confirmados (formulario propio de Caja)
//  - caja_nc_confirmaciones "Recibido" de Ana (ya existía)
// La hoja solo se lee para la importación (POST /api/caja/importar-desde-hoja).

const crypto = require('crypto');

const TZ = 'Europe/Madrid';
const CAJAS = ['marbella', 'monda'];
// Método en la caja (id) ↔ texto guardado en No Confirmados (columna "Método" del formulario)
const NC_METODO_TEXTO = { 'efectivo-marbella': 'Efectivo Marbella', 'efectivo-monda': 'Efectivo Monda' };

// Fecha (yyyy-mm-dd) en Madrid de un instante
function fechaMadrid(valor) {
  const d = valor instanceof Date ? valor : new Date(valor);
  if (isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// Desfase de Madrid ("+02:00" / "+01:00") en un instante
function desfaseMadrid(d) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(d);
  const z = (p.find(x => x.type === 'timeZoneName') || {}).value || 'GMT';
  return z === 'GMT' ? '+00:00' : z.replace('GMT', '');
}

// "2026-10-24" → instante de las 00:00 de ese día en Madrid (ISO)
function inicioDiaMadrid(fecha) {
  // 2 pasadas: el desfase de las 12:00 puede no ser el de las 00:00 el día del cambio de hora
  const aprox = new Date(`${fecha}T00:00:00${desfaseMadrid(new Date(`${fecha}T12:00:00Z`))}`);
  return new Date(`${fecha}T00:00:00${desfaseMadrid(aprox)}`).toISOString();
}

function sumarDias(fecha, n) {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// "24/10/2026 09:40" en Madrid (mismo formato que el Timestamp del formulario de Google)
function marcaFormulario(d) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = t => p.find(x => x.type === t).value;
  return `${g('day')}/${g('month')}/${g('year')} ${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`;
}

// "2026-08-13 15:11" (hora de Madrid, como lo guardaba el histórico de la hoja NC) → ISO
function isoDeMadridTexto(texto) {
  const m = String(texto || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const aprox = new Date(`${m[1]}T12:00:00Z`);
  return new Date(`${m[1]}T${m[2]}:${m[3]}:00${desfaseMadrid(aprox)}`).toISOString();
}

// Quién hace qué (25 oct 2026):
//  - admin (Sergio): todo.
//  - caja (María): todo menos confirmar lo recibido por Contabilidad.
//  - comercial: en Caja Diaria solo asigna efectivo o TPV (transferencia y
//    lo demás, María o Sergio); registra cobros No Confirmados.
//  - contabilidad (Ana, Isabel): marca recibido (NC y efectivo oficial) y
//    verifica; en Caja Diaria solo mira.
const METODOS_EF_TPV = ['efectivo-marbella', 'efectivo-monda', 'tpv-marbella', 'tpv-monda', 'fianza-efectivo-marbella', 'fianza-efectivo-monda'];
const METODOS_EFECTIVO = ['efectivo-marbella', 'efectivo-monda', 'fianza-efectivo-marbella', 'fianza-efectivo-monda'];
// Efectivo oficial pendiente de entregar a Contabilidad: cobros desde esta
// fecha (día en que empezó a marcarse "Recibido").
const EFECTIVO_RECIBIDO_DESDE = process.env.CAJA_EFECTIVO_DESDE || '2026-10-26';

const num = v => (v == null || v === '' ? 0 : Number(v));
const redondear = v => Math.round(num(v) * 100) / 100;

// Clave con la que la pantalla identifica cada registro (igual que hacía la
// caché sobre la hoja): No Confirmados → factura_id (UUID del cobro NC);
// oficiales → pago_id, +"_N" si es la parte N de un pago partido.
function claveRegistro(r) {
  if (r.es_abrebotellas) return String(r.factura_id);
  const pagoKey = r.pago_id != null ? r.pago_id : r.factura_id;
  const splitIdx = parseInt(r.split_idx) || 1;
  return splitIdx > 1 ? `${pagoKey}_${splitIdx}` : String(pagoKey);
}

function filaCierre(c) {
  return {
    caja: c.caja, desde: c.desde, hasta: c.hasta,
    total_ef: num(c.total_ef), total_tpv: num(c.total_tpv), total_transf: num(c.total_transf),
    retiradas: c.retiradas || [], saldo_anterior: num(c.saldo_anterior), saldo_final: num(c.saldo_final),
    usuario: c.usuario || '', ts: c.ts
  };
}

function registrar(app, { supabase, auth, authAdmin, authContab, authCaja, authCobros, leerHojaCaja, leerHojaNC }) {
  const usuario = req => (req.session.user && req.session.user.nombre) || '';
  const rol = req => (req.session.user && req.session.user.rol) || '';
  const fallo = (status, msg) => Object.assign(new Error(msg), { status });
  const exigirRol = (req, roles, que) => { if (!roles.includes(rol(req))) throw fallo(403, `No tienes permiso para ${que}`); };
  const ruta = fn => async (req, res) => {
    if (!supabase) return res.status(500).json({ ok: false, error: 'Supabase no configurado (SUPABASE_URL / SUPABASE_SERVICE_KEY)' });
    try { res.json(await fn(req, res)); }
    catch (e) {
      console.error('[Caja]', req.method, req.path, e.message);
      res.status(e.status || 500).json({ ok: false, error: e.message });
    }
  };
  const comprobar = (resp, que) => { if (resp.error) throw new Error(`${que}: ${resp.error.message}`); return resp.data; };

  async function selectTodo(tabla, columnas, filtrar) {
    let filas = [];
    for (let desde = 0; ; desde += 1000) {
      let q = supabase.from(tabla).select(columnas);
      if (filtrar) q = filtrar(q);
      const data = comprobar(await q.range(desde, desde + 999), tabla);
      filas = filas.concat(data || []);
      if (!data || data.length < 1000) break;
    }
    return filas;
  }

  // El historial nunca debe tumbar la acción principal: si falla, solo se avisa en el log.
  async function historial(accion, usr, datos) {
    const { error } = await supabase.from('caja_historial').insert({ accion, usuario: usr || null, datos: datos || null });
    if (error) console.error('[Caja historial]', accion, error.message);
  }

  // ── REGISTROS (forma de pago de cada pago) ──────────────────────────────
  // Una factura oficial puede tener varias filas (una por pago de Rentman, y
  // varias por pago si se partió en 2+ formas): se borra todo lo de ese
  // pago_id y se reescribe (ver migración 1 sep 2026: los índices únicos son
  // parciales y PostgREST no puede usarlos en un upsert).
  async function guardarRegistroOficial({ pagoId, facturaId, numero, cliente, fechaPago, usuario: usr, splits }) {
    const ahora = new Date().toISOString();
    comprobar(await supabase.from('caja_registros').delete().eq('pago_id', pagoId), 'borrar registro');
    if (splits.length) {
      const filas = splits.map((sp, idx) => ({
        factura_id: String(facturaId), pago_id: pagoId, split_idx: idx + 1,
        metodo_pago: sp.metodo_pago, ubicacion: sp.ubicacion || null, tipo: sp.tipo || null,
        importe: sp.importe, cliente: cliente || null, numero: numero === '' || numero == null ? null : numero,
        es_abrebotellas: false, usuario: usr || null, num_operacion: sp.num_operacion || '',
        fecha_pago_raw: fechaPago || null, updated_raw: ahora, updated_ts: ahora, sincronizado_en: ahora
      }));
      comprobar(await supabase.from('caja_registros').insert(filas), 'guardar registro');
    }
  }

  // No Confirmados: 1 fila por cobro NC (factura_id = su UUID). Además el
  // método se guarda en el propio cobro (caja_nc_formulario.metodo), que es lo
  // que lee la pestaña No Confirmados.
  async function guardarRegistroNC(body, usr) {
    const id = String(body.factura_id);
    comprobar(await supabase.from('caja_registros').delete().eq('factura_id', id).eq('es_abrebotellas', true), 'borrar registro NC');
    if (body.metodo_pago) {
      const ahora = new Date().toISOString();
      comprobar(await supabase.from('caja_registros').insert({
        factura_id: id, pago_id: null, split_idx: 1, metodo_pago: body.metodo_pago, ubicacion: body.ubicacion || null,
        tipo: body.tipo || null, importe: body.importe ?? null, cliente: body.cliente || null,
        numero: body.numero === '' || body.numero == null ? null : body.numero, es_abrebotellas: true,
        usuario: usr || null, num_operacion: body.num_operacion || '', fecha_pago_raw: body.fecha_pago || null,
        updated_raw: ahora, updated_ts: ahora, sincronizado_en: ahora
      }), 'guardar registro NC');
    }
    comprobar(await supabase.from('caja_nc_formulario')
      .update({ metodo: body.metodo_pago ? (NC_METODO_TEXTO[body.metodo_pago] || body.metodo_pago) : null })
      .eq('id_unico', id), 'guardar método NC');
  }

  app.get('/api/caja/registros', auth, ruta(async () => {
    const filas = await selectTodo('caja_registros',
      'id,factura_id,pago_id,split_idx,metodo_pago,ubicacion,tipo,importe,cliente,numero,fecha_pago_raw,es_abrebotellas,usuario,num_operacion,updated_raw',
      q => q.order('id', { ascending: true }));
    const out = {};
    filas.forEach(r => {
      const clave = claveRegistro(r);
      if (clave === '' || clave === 'null') return;
      out[clave] = {
        factura_id: r.factura_id, pago_id: r.pago_id, split_idx: r.split_idx || 1,
        metodo_pago: r.metodo_pago, ubicacion: r.ubicacion, tipo: r.tipo, importe: r.importe,
        cliente: r.cliente, numero: r.numero, fecha_pago: r.fecha_pago_raw, es_abrebotellas: !!r.es_abrebotellas,
        usuario: r.usuario, num_operacion: r.num_operacion || '', updated: r.updated_raw
      };
    });
    return out;
  }));

  // Antes de cambiar la forma de pago de un cobro oficial: un comercial solo
  // puede tocar efectivo/TPV (lo que había y lo que pone), y nadie salvo
  // admin puede tocar efectivo que Contabilidad ya marcó recibido.
  async function comprobarCambioOficial(req, pagoId, metodosNuevos) {
    const r = rol(req);
    exigirRol(req, ['admin', 'caja', 'comercial'], 'cambiar formas de pago');
    const actuales = comprobar(await supabase.from('caja_registros').select('factura_id,pago_id,split_idx,metodo_pago,es_abrebotellas').eq('pago_id', pagoId), 'registro actual');
    if (r === 'comercial') {
      const todos = [...(actuales || []).map(a => a.metodo_pago), ...metodosNuevos].filter(Boolean);
      if (todos.some(m => !METODOS_EF_TPV.includes(m))) throw fallo(403, 'Los comerciales solo pueden asignar efectivo o TPV. Transferencias y el resto, María o Sergio.');
    }
    if (r !== 'admin' && actuales && actuales.length) {
      const claves = actuales.map(claveRegistro);
      const rec = comprobar(await supabase.from('caja_efectivo_recibido').select('clave,recibido_por').in('clave', claves), 'efectivo recibido');
      if (rec && rec.length) throw fallo(409, `${rec[0].recibido_por || 'Contabilidad'} ya marcó este efectivo como recibido: no se puede cambiar (pídeselo a Sergio).`);
    }
  }

  app.post('/api/caja/registro', auth, ruta(async req => {
    const b = req.body || {};
    if (!b.factura_id) throw fallo(400, 'factura_id requerido');
    const usr = usuario(req) || b.usuario;
    if (b.es_abrebotellas) {
      exigirRol(req, ['admin', 'caja', 'comercial'], 'cambiar el método de un No Confirmado');
      await guardarRegistroNC(b, usr);
    } else {
      await comprobarCambioOficial(req, b.pago_id || b.factura_id, [b.metodo_pago]);
      const splits = (b.metodo_pago === null || b.metodo_pago === undefined || b.metodo_pago === '')
        ? []
        : [{ importe: b.importe, metodo_pago: b.metodo_pago, ubicacion: b.ubicacion, tipo: b.tipo, num_operacion: b.num_operacion }];
      await guardarRegistroOficial({ pagoId: b.pago_id || b.factura_id, facturaId: b.factura_id, numero: b.numero, cliente: b.cliente, fechaPago: b.fecha_pago, usuario: usr, splits });
    }
    const { usuario: _u, ...datos } = b;
    await historial(b.metodo_pago ? 'asignar_metodo' : 'quitar_metodo', usr, datos);
    return { ok: true };
  }));

  // Pago partido en 2+ formas: body { factura_id, pago_id, numero, cliente,
  // fecha_pago, splits: [{importe, metodo_pago, ubicacion, tipo, num_operacion}] }.
  // splits vacío = deshacer partición (igual que quitar el método).
  app.post('/api/caja/registro-partido', auth, ruta(async req => {
    const b = req.body || {};
    if (!b.pago_id) throw fallo(400, 'pago_id requerido');
    if (!Array.isArray(b.splits)) throw fallo(400, 'splits requerido (array)');
    await comprobarCambioOficial(req, b.pago_id, b.splits.map(s => s.metodo_pago));
    const usr = usuario(req) || b.usuario;
    await guardarRegistroOficial({ pagoId: b.pago_id, facturaId: b.factura_id, numero: b.numero, cliente: b.cliente, fechaPago: b.fecha_pago, usuario: usr, splits: b.splits });
    const { usuario: _u, ...datos } = b;
    await historial(b.splits.length ? 'asignar_metodo' : 'quitar_metodo', usr, datos);
    return { ok: true };
  }));

  // ── EFECTIVO OFICIAL RECIBIDO POR CONTABILIDAD ──────────────────────────
  // María entrega a Ana el efectivo de las facturas oficiales; Ana (o
  // Isabel) marca cada cobro recibido, igual que en No Confirmados. Lo
  // recibido sale de "pendiente de entregar" y pasa a Entregados.
  app.get('/api/caja/efectivo-recibidos', auth, ruta(async () => {
    const filas = await selectTodo('caja_efectivo_recibido', 'clave,recibido_por,recibido_en');
    const out = {};
    filas.forEach(r => { out[r.clave] = { por: r.recibido_por || '', en: r.recibido_en }; });
    return out;
  }));

  // Efectivo oficial aún sin entregar a Contabilidad, por caja.
  app.get('/api/caja/efectivo-pendiente', auth, ruta(async () => {
    const [regs, recibidos] = await Promise.all([
      selectTodo('caja_registros', 'id,factura_id,pago_id,split_idx,metodo_pago,ubicacion,importe,cliente,numero,fecha_pago_raw,fecha_pago_ts,es_abrebotellas',
        q => q.in('metodo_pago', METODOS_EFECTIVO).gte('fecha_pago_ts', `${EFECTIVO_RECIBIDO_DESDE}T00:00:00Z`).order('fecha_pago_ts', { ascending: true })),
      selectTodo('caja_efectivo_recibido', 'clave')
    ]);
    const ya = new Set(recibidos.map(r => r.clave));
    const out = { desde: EFECTIVO_RECIBIDO_DESDE, marbella: [], monda: [] };
    regs.filter(r => !r.es_abrebotellas).forEach(r => {
      const clave = claveRegistro(r);
      if (ya.has(clave)) return;
      const caja = String(r.metodo_pago).endsWith('monda') ? 'monda' : 'marbella';
      out[caja].push({ clave, pago_id: r.pago_id, numero: r.numero, cliente: r.cliente || '', fecha_pago: r.fecha_pago_raw, importe: num(r.importe), metodo: r.metodo_pago });
    });
    return out;
  }));

  app.post('/api/caja/efectivo-recibido', authContab, ruta(async req => {
    const { clave, recibido } = req.body || {};
    if (!clave) throw fallo(400, 'clave requerida');
    if (recibido === false) {
      comprobar(await supabase.from('caja_efectivo_recibido').delete().eq('clave', String(clave)), 'quitar recibido');
      await historial('efectivo_quitar_recibido', usuario(req), { clave });
      return { ok: true };
    }
    // Copia del cobro tal como está ahora (para la lista de entregados)
    const [pagoKey, split] = String(clave).split('_');
    const regs = comprobar(await supabase.from('caja_registros').select('pago_id,split_idx,metodo_pago,importe,numero,cliente,fecha_pago_raw')
      .eq('pago_id', pagoKey).eq('split_idx', parseInt(split) || 1).limit(1), 'cobro');
    const r = regs && regs[0];
    if (!r || !METODOS_EFECTIVO.includes(r.metodo_pago)) throw fallo(404, 'Ese cobro ya no figura como efectivo');
    comprobar(await supabase.from('caja_efectivo_recibido').upsert({
      clave: String(clave), pago_id: r.pago_id, metodo: r.metodo_pago, importe: r.importe, numero: r.numero,
      cliente: r.cliente, fecha_pago_raw: r.fecha_pago_raw, recibido_por: usuario(req), recibido_en: new Date().toISOString()
    }, { onConflict: 'clave' }), 'marcar recibido');
    await historial('efectivo_recibido', usuario(req), { clave, numero: r.numero, cliente: r.cliente, importe: r.importe, metodo_pago: r.metodo_pago });
    return { ok: true };
  }));

  // Entregados: efectivo oficial ya recibido, agrupado por día, caja y quién.
  app.get('/api/caja/efectivo-entregados', auth, ruta(async () => {
    const filas = await selectTodo('caja_efectivo_recibido', '*', q => q.order('recibido_en', { ascending: false }));
    const grupos = new Map();
    filas.forEach(r => {
      const dia = fechaMadrid(r.recibido_en);
      const caja = String(r.metodo || '').endsWith('monda') ? 'Efectivo Monda' : 'Efectivo Marbella';
      const k = `${dia}|${caja}|${r.recibido_por || ''}`;
      if (!grupos.has(k)) grupos.set(k, { dia, metodo: caja, por: r.recibido_por || '', total: 0, cobros: [] });
      const g = grupos.get(k);
      g.total = redondear(g.total + num(r.importe));
      g.cobros.push({ clave: r.clave, numero: r.numero, cliente: r.cliente || '', fecha_pago: r.fecha_pago_raw, importe: num(r.importe) });
    });
    return { ok: true, entregas: [...grupos.values()] };
  }));

  // ── TICKS (verificación de Contabilidad) ────────────────────────────────
  app.get('/api/ticks', auth, ruta(async req => {
    const { desde, hasta } = req.query;
    const filas = await selectTodo('caja_ticks', 'key,valor,nota,usuario,fecha');
    const out = {};
    filas.forEach(t => {
      const d = t.key.split('_')[0];
      if (desde && hasta && !(d >= desde && d <= hasta)) return;
      out[t.key] = { valor: t.valor, nota: t.nota || '', usuario: t.usuario || '', fecha: t.fecha };
    });
    return out;
  }));

  app.post('/api/tick', authContab, ruta(async req => {
    const { key, valor, nota } = req.body || {};
    if (!key) throw fallo(400, 'key requerida');
    const usr = usuario(req);
    if (valor === null || valor === undefined) {
      comprobar(await supabase.from('caja_ticks').delete().eq('key', key), 'quitar tick');
    } else {
      comprobar(await supabase.from('caja_ticks').upsert({ key, valor: !!valor, nota: nota || '', usuario: usr, fecha: new Date().toISOString() }, { onConflict: 'key' }), 'guardar tick');
    }
    await historial('tick', usr, { key, valor: valor ?? null, nota: nota || '' });
    return { ok: true };
  }));

  // ── CIERRES Y SALDOS ────────────────────────────────────────────────────
  async function cierresPorCaja() {
    const filas = await selectTodo('caja_cierres', '*', q => q.order('ts', { ascending: true }));
    const out = {};
    filas.forEach(c => {
      if (!out[c.caja]) out[c.caja] = {};
      out[c.caja][`${c.desde}_${c.hasta}`] = filaCierre(c);
    });
    return { out, filas };
  }

  app.get('/api/cierres', auth, ruta(async () => (await cierresPorCaja()).out));

  // Saldo arrastrado de cada caja = el del último cierre que se hizo.
  app.get('/api/saldos', auth, ruta(async () => {
    const { filas } = await cierresPorCaja();
    const out = {};
    filas.forEach(c => {
      out[c.caja] = { caja: c.caja, efectivo_final: num(c.saldo_final), fecha: c.hasta, usuario: c.usuario || '', updated: c.ts };
    });
    return out;
  }));

  app.post('/api/cierre', authCaja, ruta(async req => {
    const b = req.body || {};
    if (!CAJAS.includes(b.caja) || !/^\d{4}-\d{2}-\d{2}$/.test(b.desde || '') || !/^\d{4}-\d{2}-\d{2}$/.test(b.hasta || '')) {
      throw fallo(400, 'caja, desde y hasta (yyyy-mm-dd) requeridos');
    }
    const ahora = new Date().toISOString();
    const fila = {
      caja: b.caja, desde: b.desde, hasta: b.hasta,
      total_ef: redondear(b.total_ef), total_tpv: redondear(b.total_tpv), total_transf: redondear(b.total_transf),
      retiradas: Array.isArray(b.retiradas) ? b.retiradas : [],
      saldo_anterior: num(b.saldo_anterior), saldo_final: num(b.saldo_final),
      usuario: b.usuario || usuario(req), ts: ahora, importado_de_hoja: false
    };
    const cierre = comprobar(await supabase.from('caja_cierres').upsert(fila, { onConflict: 'caja,desde,hasta' }).select('id').single(), 'guardar cierre');
    // Las retiradas pendientes de esa caja entran en este cierre.
    comprobar(await supabase.from('caja_retiradas')
      .update({ cerrada_en: ahora, cerrada_por: usuario(req), cierre_id: cierre.id })
      .eq('caja', b.caja).eq('es_nc', false).is('cerrada_en', null), 'cerrar retiradas');
    await historial('cierre_caja', usuario(req), { caja: b.caja, desde: b.desde, hasta: b.hasta, total_ef: fila.total_ef, total_tpv: fila.total_tpv, total_transf: fila.total_transf, saldo_anterior: fila.saldo_anterior, saldo_final: fila.saldo_final, usuario: fila.usuario });
    return { ok: true };
  }));

  app.get('/api/cierre/verificar', auth, ruta(async req => {
    const { caja, desde } = req.query;
    if (!caja || !desde) throw fallo(400, 'caja y desde requeridos');
    const filas = comprobar(await supabase.from('caja_cierres').select('desde,hasta,ts,usuario').eq('caja', caja)
      .lte('desde', desde).gte('hasta', desde).order('ts', { ascending: false }).limit(1), 'cierres');
    if (filas && filas.length) {
      const c = filas[0];
      return { ok: false, puede_cerrar: false, mensaje: `Esta caja ya fue cerrada el ${new Date(c.ts).toLocaleString('es-ES', { timeZone: TZ })} por ${c.usuario}` };
    }
    return { ok: true, puede_cerrar: true, mensaje: null };
  }));

  // ── RETIRADAS ───────────────────────────────────────────────────────────
  app.get('/api/retiradas', auth, ruta(async () => {
    const filas = await selectTodo('caja_retiradas', 'caja,es_nc,importe,descripcion,tipo,usuario,ts',
      q => q.is('cerrada_en', null).order('ts', { ascending: true }));
    const out = { marbella: [], monda: [], marbella_nc: [], monda_nc: [] };
    filas.forEach(r => {
      const k = r.es_nc ? `${r.caja}_nc` : r.caja;
      if (out[k]) out[k].push({ importe: num(r.importe), desc: r.descripcion || '', tipo: r.tipo, usuario: r.usuario || '', ts: r.ts });
    });
    return out;
  }));

  app.post('/api/retirada', authCaja, ruta(async req => {
    const { caja, esNC, importe, desc, tipo } = req.body || {};
    if (!CAJAS.includes(caja) || !(parseFloat(importe) > 0)) throw fallo(400, 'caja e importe requeridos');
    const fila = { caja, es_nc: !!esNC, importe: redondear(importe), descripcion: desc || 'Retirada', tipo: tipo || 'retirada', usuario: usuario(req) };
    comprobar(await supabase.from('caja_retiradas').insert(fila), 'guardar retirada');
    await historial('add_retirada', usuario(req), { caja, esNC: !!esNC, importe: fila.importe, desc: fila.descripcion, tipo: fila.tipo });
    return { ok: true };
  }));

  // "Vaciar" las retiradas pendientes de una caja (tras un cierre, o el
  // botón de No Confirmados): se marcan cerradas, no se borran.
  app.delete('/api/retiradas/:caja', authCaja, ruta(async req => {
    const { caja } = req.params;
    const esNC = req.query.esNC === 'true';
    if (!CAJAS.includes(caja)) throw fallo(400, 'caja inválida');
    const cerradas = comprobar(await supabase.from('caja_retiradas')
      .update({ cerrada_en: new Date().toISOString(), cerrada_por: usuario(req) })
      .eq('caja', caja).eq('es_nc', esNC).is('cerrada_en', null).select('id'), 'vaciar retiradas');
    if (cerradas && cerradas.length) await historial('clear_retiradas', usuario(req), { caja, esNC, retiradas: cerradas.length });
    return { ok: true };
  }));

  // ── HISTORIAL (admin) ───────────────────────────────────────────────────
  app.get('/api/historial', authAdmin, ruta(async req => {
    const { desde, hasta } = req.query;
    const limite = Math.min(parseInt(req.query.limit) || 200, 5000);
    let q = supabase.from('caja_historial').select('ts,accion,usuario,datos').order('ts', { ascending: false }).limit(limite);
    if (/^\d{4}-\d{2}-\d{2}$/.test(desde || '')) q = q.gte('ts', inicioDiaMadrid(desde));
    if (/^\d{4}-\d{2}-\d{2}$/.test(hasta || '')) q = q.lt('ts', inicioDiaMadrid(sumarDias(hasta, 1)));
    const filas = comprobar(await q, 'historial');
    // La pantalla ordena por la clave (desc): misma forma que devolvía la hoja.
    const out = {};
    const base = Date.now();
    (filas || []).forEach((r, i) => { out[String(base - i)] = r; });
    return out;
  }));

  // ── NO CONFIRMADOS ──────────────────────────────────────────────────────
  app.get('/api/noconfirmados', auth, ruta(async req => {
    const { desde, hasta } = req.query;
    const filas = await selectTodo('caja_nc_formulario', 'id_unico,fecha,timestamp_raw,email,numero_proyecto,cliente,importe,metodo,registrado_por,creado_en', q => {
      q = q.is('eliminado_en', null).order('fecha', { ascending: true }).order('timestamp_raw', { ascending: true });
      if (desde) q = q.gte('fecha', desde);
      if (hasta) q = q.lte('fecha', hasta);
      return q;
    });
    return {
      ok: true,
      registros: filas.map(r => ({
        id: r.id_unico, fecha: r.fecha, email: r.email || '', numero_proyecto: r.numero_proyecto != null ? String(r.numero_proyecto) : '',
        cliente: r.cliente || '', importe: num(r.importe), metodo: r.metodo || '', registrado_por: r.registrado_por || ''
      }))
    };
  }));

  // Proyecto por nº, para rellenar el cliente en el formulario.
  app.get('/api/nc/proyecto/:numero', authCobros, ruta(async req => {
    const numero = parseInt(req.params.numero);
    if (!numero) throw fallo(400, 'nº de proyecto inválido');
    const data = comprobar(await supabase.from('proyectos').select('id,numero,nombre,cliente,estado,cancelado,es_abrebotellas').eq('numero', numero).limit(1), 'proyectos');
    return { ok: true, proyecto: (data && data[0]) || null };
  }));

  // Formulario de cobro No Confirmado (sustituye al formulario de Google).
  app.post('/api/nc/registro', authCobros, ruta(async req => {
    const b = req.body || {};
    const numero = parseInt(b.numero_proyecto);
    const importe = Math.round(parseFloat(b.importe) * 100) / 100;
    const metodo = Object.values(NC_METODO_TEXTO).includes(b.metodo) ? b.metodo : null;
    if (!numero) throw fallo(400, 'Falta el nº de proyecto');
    if (!importe) throw fallo(400, 'Falta el importe');
    if (!metodo) throw fallo(400, 'Elige la caja (Efectivo Marbella o Efectivo Monda)');
    const cliente = String(b.cliente || '').trim();
    if (!cliente) throw fallo(400, 'Falta el cliente');
    const ahora = new Date();
    const fila = {
      id_unico: crypto.randomUUID(), timestamp_raw: marcaFormulario(ahora), fecha: fechaMadrid(ahora),
      email: null, numero_proyecto: numero, cliente, importe, metodo,
      registrado_por: usuario(req), creado_en: ahora.toISOString(), origen: 'caja', sincronizado_en: ahora.toISOString()
    };
    comprobar(await supabase.from('caja_nc_formulario').insert(fila), 'guardar cobro NC');
    await historial('nc_registro', usuario(req), { nc_id: fila.id_unico, numero: numero, cliente, importe, metodo });
    return { ok: true, registro: { id: fila.id_unico, fecha: fila.fecha } };
  }));

  // Anular un cobro NC mal metido (solo si Ana aún no lo ha marcado recibido).
  // Solo admin (Sergio): el resto debe pedírselo (decisión del 25 oct 2026).
  app.post('/api/nc/anular', authAdmin, ruta(async req => {
    const id = String((req.body || {}).nc_id || '');
    if (!id) throw fallo(400, 'nc_id requerido');
    const conf = comprobar(await supabase.from('caja_nc_confirmaciones').select('confirmado').eq('nc_id', id).maybeSingle(), 'confirmaciones');
    if (conf && conf.confirmado) throw fallo(409, 'Ana ya lo marcó como recibido: quita antes la confirmación');
    const anuladas = comprobar(await supabase.from('caja_nc_formulario')
      .update({ eliminado_en: new Date().toISOString(), eliminado_por: `${usuario(req)} (anulado)` })
      .eq('id_unico', id).is('eliminado_en', null).select('id_unico,numero_proyecto,cliente,importe,metodo'), 'anular cobro NC');
    if (!anuladas || !anuladas.length) throw fallo(404, 'Cobro no encontrado');
    comprobar(await supabase.from('caja_registros').delete().eq('factura_id', id).eq('es_abrebotellas', true), 'borrar registro NC');
    const a = anuladas[0];
    await historial('nc_anular', usuario(req), { nc_id: id, numero: a.numero_proyecto, cliente: a.cliente, importe: a.importe, metodo: a.metodo });
    return { ok: true };
  }));

  app.get('/api/nc/confirmaciones', auth, ruta(async () => {
    const filas = await selectTodo('caja_nc_confirmaciones', 'nc_id,confirmado,usuario,ts,metodo,importe,cliente,numero');
    const out = {};
    filas.forEach(c => { out[c.nc_id] = { nc_id: c.nc_id, confirmado: !!c.confirmado, usuario: c.usuario || '', ts: c.ts, metodo: c.metodo, importe: c.importe, cliente: c.cliente, numero: c.numero }; });
    return out;
  }));

  app.post('/api/nc/confirmar', authContab, ruta(async req => {
    const b = req.body || {};
    if (!b.nc_id) throw fallo(400, 'nc_id requerido');
    const ncId = String(b.nc_id);
    const usr = usuario(req);
    if (b.confirmar === false) {
      comprobar(await supabase.from('caja_nc_confirmaciones').delete().eq('nc_id', ncId), 'quitar confirmación');
    } else {
      comprobar(await supabase.from('caja_nc_confirmaciones').upsert({
        nc_id: ncId, confirmado: true, usuario: usr || null, ts: new Date().toISOString(),
        metodo: b.metodo || null, importe: b.importe ?? null, cliente: b.cliente || null,
        numero: b.numero === '' || b.numero == null ? null : parseInt(b.numero) || null, sincronizado_en: new Date().toISOString()
      }, { onConflict: 'nc_id' }), 'confirmar');
    }
    await historial(b.confirmar === false ? 'nc_quitar_confirmacion' : 'nc_confirmar_recepcion', usr,
      { nc_id: ncId, metodo: b.metodo, importe: b.importe, cliente: b.cliente, numero: b.numero });
    return { ok: true };
  }));

  // "Eliminar confirmados" de una sede: tras imprimir y firmar el listado y
  // entregar el dinero, los cobros de esa caja ya marcados "Recibido" por Ana
  // salen de la lista (se marcan eliminados, no se borran) y se vacían las
  // retiradas NC de esa caja. Solo admin (Sergio), decisión del 25 oct 2026.
  app.post('/api/nc/eliminar', authAdmin, ruta(async req => {
    const { caja } = req.body || {};
    if (!CAJAS.includes(caja)) throw fallo(400, 'caja inválida');
    const metodoId = caja === 'marbella' ? 'efectivo-marbella' : 'efectivo-monda';
    const [activos, registrosNC, confs] = await Promise.all([
      selectTodo('caja_nc_formulario', 'id_unico,metodo', q => q.is('eliminado_en', null)),
      selectTodo('caja_registros', 'factura_id,metodo_pago', q => q.eq('es_abrebotellas', true)),
      selectTodo('caja_nc_confirmaciones', 'nc_id,confirmado', q => q.eq('confirmado', true))
    ]);
    const confirmados = new Set(confs.map(c => String(c.nc_id)));
    const activosIds = new Set(activos.map(r => String(r.id_unico)));
    const metodoPorRegistro = {};
    registrosNC.forEach(r => { metodoPorRegistro[String(r.factura_id)] = r.metodo_pago; });
    const ids = activos
      .filter(r => r.metodo === NC_METODO_TEXTO[metodoId] || metodoPorRegistro[String(r.id_unico)] === metodoId)
      .map(r => String(r.id_unico))
      .filter(id => activosIds.has(id) && confirmados.has(id));
    if (!ids.length) return { ok: true, eliminados: 0 };
    const ahora = new Date().toISOString();
    for (let i = 0; i < ids.length; i += 200) {
      const tanda = ids.slice(i, i + 200);
      comprobar(await supabase.from('caja_nc_formulario').update({ eliminado_en: ahora, eliminado_por: usuario(req) }).in('id_unico', tanda), 'eliminar cobros NC');
      comprobar(await supabase.from('caja_registros').delete().eq('es_abrebotellas', true).in('factura_id', tanda), 'borrar registros NC');
    }
    comprobar(await supabase.from('caja_retiradas').update({ cerrada_en: ahora, cerrada_por: usuario(req) })
      .eq('caja', caja).eq('es_nc', true).is('cerrada_en', null), 'vaciar retiradas NC');
    await historial('nc_eliminar', usuario(req), { caja, eliminados: ids.length });
    return { ok: true, eliminados: ids.length };
  }));

  // Entregados: los cobros que salieron de la caja NC con "Eliminar
  // confirmados" (antes, pestaña histórico de la hoja), agrupados por entrega
  // (día + caja + quién). Los anulados por error no cuentan como entregados.
  app.get('/api/nc/entregados', auth, ruta(async req => {
    if (!['caja', 'contabilidad', 'admin'].includes(req.session.user.rol)) throw fallo(403, 'Sin permisos');
    const filas = await selectTodo('caja_nc_formulario', 'id_unico,fecha,numero_proyecto,cliente,importe,metodo,registrado_por,eliminado_en,eliminado_por',
      q => q.not('eliminado_en', 'is', null).order('eliminado_en', { ascending: false }));
    const entregas = new Map();
    filas.filter(r => !String(r.eliminado_por || '').endsWith('(anulado)')).forEach(r => {
      const dia = fechaMadrid(r.eliminado_en);
      const clave = `${dia}|${r.metodo || ''}|${r.eliminado_por || ''}`;
      if (!entregas.has(clave)) entregas.set(clave, { dia, metodo: r.metodo || '', por: r.eliminado_por || '', total: 0, cobros: [] });
      const e = entregas.get(clave);
      e.total = redondear(e.total + num(r.importe));
      e.cobros.push({ id: r.id_unico, fecha: r.fecha, numero_proyecto: r.numero_proyecto, cliente: r.cliente || '', importe: num(r.importe), registrado_por: r.registrado_por || '' });
    });
    return { ok: true, entregas: [...entregas.values()] };
  }));

  // ── IMPORTACIÓN DESDE LA HOJA (admin) ───────────────────────────────────
  // Se puede repetir sin duplicar: solo añade lo que aún no está en Supabase
  // (nunca pisa algo creado ya desde la app). Registros y confirmaciones NC no
  // se importan: Caja ya los escribía en Supabase y el cron los igualaba a la
  // hoja cada 15 min. Tras el cambio, sirve también para recoger cobros que
  // alguien meta todavía por el formulario de Google.
  async function importarDesdeHoja() {
    const res = {};

    // Cierres. La hoja guarda desde/hasta como fecha (00:00 de Madrid).
    const rC = await leerHojaCaja({ action: 'get_cierres' });
    if (!rC || !rC.ok) throw new Error('Hoja: get_cierres sin respuesta');
    const cierres = [];
    Object.values(rC.data || {}).forEach(porPeriodo => Object.values(porPeriodo || {}).forEach(c => {
      const desde = fechaMadrid(c.desde), hasta = fechaMadrid(c.hasta);
      if (!CAJAS.includes(c.caja) || !desde || !hasta) return;
      cierres.push({
        caja: c.caja, desde, hasta, total_ef: redondear(c.total_ef), total_tpv: redondear(c.total_tpv), total_transf: redondear(c.total_transf),
        retiradas: Array.isArray(c.retiradas) ? c.retiradas : [], saldo_anterior: num(c.saldo_anterior), saldo_final: num(c.saldo_final),
        usuario: c.usuario || null, ts: c.ts || new Date().toISOString(), importado_de_hoja: true
      });
    }));
    if (cierres.length) comprobar(await supabase.from('caja_cierres').upsert(cierres, { onConflict: 'caja,desde,hasta', ignoreDuplicates: true }), 'importar cierres');
    res.cierres = cierres.length;

    // Retiradas pendientes (aún no cerradas).
    const rR = await leerHojaCaja({ action: 'get_retiradas' });
    if (!rR || !rR.ok) throw new Error('Hoja: get_retiradas sin respuesta');
    const yaRet = new Set((await selectTodo('caja_retiradas', 'caja,es_nc,ts', q => q.eq('importada_de_hoja', true)))
      .map(r => `${r.caja}|${r.es_nc}|${new Date(r.ts).toISOString()}`));
    const retiradas = [];
    Object.entries(rR.data || {}).forEach(([k, lista]) => (Array.isArray(lista) ? lista : []).forEach(r => {
      const caja = k.replace('_nc', ''), esNC = k.endsWith('_nc');
      const ts = r.ts ? new Date(r.ts).toISOString() : new Date().toISOString();
      if (!CAJAS.includes(caja) || yaRet.has(`${caja}|${esNC}|${ts}`)) return;
      retiradas.push({ caja, es_nc: esNC, importe: redondear(r.importe), descripcion: r.desc || null, tipo: r.tipo || 'retirada', usuario: r.usuario || null, ts, importada_de_hoja: true });
    }));
    if (retiradas.length) comprobar(await supabase.from('caja_retiradas').insert(retiradas), 'importar retiradas');
    res.retiradas_pendientes = retiradas.length;

    // Ticks de Contabilidad.
    const rT = await leerHojaCaja({ action: 'get_ticks', desde: '', hasta: '' });
    if (!rT || !rT.ok) throw new Error('Hoja: get_ticks sin respuesta');
    const ticks = Object.entries(rT.data || {}).map(([key, t]) => ({
      key, valor: t.valor !== false && t.valor !== 'false', nota: t.nota || '', usuario: t.usuario || null, fecha: t.fecha || new Date().toISOString()
    }));
    if (ticks.length) comprobar(await supabase.from('caja_ticks').upsert(ticks, { onConflict: 'key', ignoreDuplicates: true }), 'importar ticks');
    res.ticks = ticks.length;

    // Historial: por meses (la hoja devuelve como mucho 2.000 filas por llamada).
    const yaHist = new Set((await selectTodo('caja_historial', 'ts,accion,usuario', q => q.eq('importado_de_hoja', true)))
      .map(h => `${new Date(h.ts).toISOString()}|${h.accion}|${h.usuario || ''}`));
    const hist = [];
    const avisos = [];
    const hoy = fechaMadrid(new Date());
    for (let mes = '2026-01-01'; mes <= hoy; ) {
      const siguiente = sumarDias(mes.slice(0, 8) + '28', 4).slice(0, 8) + '01';
      const hasta = sumarDias(siguiente, -1);
      const rH = await leerHojaCaja({ action: 'get_historial', desde: mes, hasta, limit: 100000 });
      if (!rH || !rH.ok) throw new Error(`Hoja: get_historial ${mes} sin respuesta`);
      const filas = rH.data || [];
      if (filas.length >= 2000) avisos.push(`historial ${mes.slice(0, 7)}: ${filas.length} filas (puede estar recortado)`);
      filas.forEach(h => {
        const ts = h.ts ? new Date(h.ts).toISOString() : null;
        const clave = `${ts}|${h.accion}|${h.usuario || ''}`;
        if (!ts || yaHist.has(clave)) return;
        yaHist.add(clave);
        let datos = h.datos;
        if (typeof datos === 'string') { try { datos = JSON.parse(datos); } catch (e) { datos = { texto: datos }; } }
        if (datos && typeof datos === 'object') delete datos.token;
        hist.push({ ts, accion: h.accion || 'desconocida', usuario: h.usuario || null, datos: datos || null, importado_de_hoja: true });
      });
      mes = siguiente;
    }
    for (let i = 0; i < hist.length; i += 500) comprobar(await supabase.from('caja_historial').insert(hist.slice(i, i + 500)), 'importar historial');
    res.historial = hist.length;

    // No Confirmados: cobros activos + los ya eliminados (pestaña histórico).
    const rN = await leerHojaNC({ action: 'registros', desde: '', hasta: '' });
    if (!rN || !rN.ok) throw new Error('Hoja NC sin respuesta');
    const existentes = new Map((await selectTodo('caja_nc_formulario', 'id_unico,eliminado_en')).map(r => [String(r.id_unico), r]));
    const nuevos = [];
    const marcarEliminados = [];
    const desdeHoja = (r, eliminado) => {
      const id = String(r.id || '');
      if (!id) return;
      const ya = existentes.get(id);
      const elimEn = eliminado ? (isoDeMadridTexto(r.fecha_eliminacion) || new Date().toISOString()) : null;
      if (ya) {
        if (eliminado && !ya.eliminado_en) marcarEliminados.push({ id, eliminado_en: elimEn, eliminado_por: r.eliminado_por || null });
        return;
      }
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(r.fecha || '')) ? r.fecha : null;
      nuevos.push({
        id_unico: id, timestamp_raw: fecha ? `${fecha.slice(8, 10)}/${fecha.slice(5, 7)}/${fecha.slice(0, 4)}` : null, fecha,
        email: r.email || null, numero_proyecto: parseInt(r.numero_proyecto) || null, cliente: r.cliente || null,
        importe: r.importe === '' || r.importe == null ? null : Number(r.importe), metodo: r.metodo || null,
        eliminado_en: elimEn, eliminado_por: eliminado ? (r.eliminado_por || null) : null, origen: 'formulario_google'
      });
      existentes.set(id, { eliminado_en: elimEn });
    };
    (rN.registros || []).forEach(r => desdeHoja(r, false));
    (rN.historico || []).forEach(r => desdeHoja(r, true));
    for (let i = 0; i < nuevos.length; i += 500) comprobar(await supabase.from('caja_nc_formulario').insert(nuevos.slice(i, i + 500)), 'importar cobros NC');
    for (const m of marcarEliminados) {
      comprobar(await supabase.from('caja_nc_formulario').update({ eliminado_en: m.eliminado_en, eliminado_por: m.eliminado_por }).eq('id_unico', m.id).is('eliminado_en', null), 'marcar NC eliminado');
    }
    res.nc_nuevos = nuevos.length;
    res.nc_marcados_eliminados = marcarEliminados.length;
    if (avisos.length) res.avisos = avisos;
    return res;
  }

  app.post('/api/caja/importar-desde-hoja', authAdmin, ruta(async req => {
    const resultado = await importarDesdeHoja();
    await historial('importar_hoja', usuario(req), resultado);
    return { ok: true, ...resultado };
  }));

  // Comparación hoja ↔ Supabase, para comprobar el cambio (solo lectura).
  app.get('/api/caja/comparar-hoja', authAdmin, ruta(async () => {
    const [rReg, rConf, rN, rC, rT] = await Promise.all([
      leerHojaCaja({ action: 'get_registros', desde: '', hasta: '' }),
      leerHojaCaja({ action: 'get_nc_confs' }),
      leerHojaNC({ action: 'registros', desde: '', hasta: '' }),
      leerHojaCaja({ action: 'get_cierres' }),
      leerHojaCaja({ action: 'get_ticks', desde: '', hasta: '' })
    ]);
    // Registros: misma clave que la pantalla; "último gana" igual que la caché antigua.
    const hoja = new Map();
    (rReg.data || []).forEach(r => hoja.set(claveRegistro({ ...r, pago_id: r.pago_id === '' ? null : r.pago_id }), r));
    const supa = new Map();
    (await selectTodo('caja_registros', 'id,factura_id,pago_id,split_idx,metodo_pago,importe,num_operacion,es_abrebotellas', q => q.order('id', { ascending: true })))
      .forEach(r => supa.set(claveRegistro(r), r));
    const soloHoja = [], soloSupabase = [], distintos = [];
    hoja.forEach((h, k) => {
      const s = supa.get(k);
      if (!s) return soloHoja.push(k);
      if ((h.metodo_pago || null) !== (s.metodo_pago || null) || redondear(h.importe) !== redondear(s.importe) || String(h.num_operacion || '') !== String(s.num_operacion || '')) {
        distintos.push({ clave: k, hoja: { metodo: h.metodo_pago, importe: h.importe, op: h.num_operacion }, supabase: { metodo: s.metodo_pago, importe: s.importe, op: s.num_operacion } });
      }
    });
    supa.forEach((s, k) => { if (!hoja.has(k)) soloSupabase.push({ clave: k, factura_id: s.factura_id, pago_id: s.pago_id, metodo: s.metodo_pago }); });

    const confHoja = Object.keys(rConf.data || {});
    const confSupa = new Set((await selectTodo('caja_nc_confirmaciones', 'nc_id')).map(c => String(c.nc_id)));
    const ncActivosHoja = (rN.registros || []).map(r => String(r.id));
    const ncSupa = new Map((await selectTodo('caja_nc_formulario', 'id_unico,eliminado_en,metodo')).map(r => [String(r.id_unico), r]));
    const cierresHoja = Object.values(rC.data || {}).reduce((s, p) => s + Object.keys(p || {}).length, 0);
    const cierresSupa = (await selectTodo('caja_cierres', 'id')).length;
    const ticksSupa = new Set((await selectTodo('caja_ticks', 'key')).map(t => t.key));

    return {
      ok: true,
      registros: { hoja: hoja.size, supabase: supa.size, solo_en_hoja: soloHoja, solo_en_supabase: soloSupabase, distintos },
      nc_confirmaciones: { hoja: confHoja.length, supabase: confSupa.size, faltan_en_supabase: confHoja.filter(id => !confSupa.has(id)) },
      nc_cobros: {
        activos_hoja: ncActivosHoja.length,
        activos_supabase: [...ncSupa.values()].filter(r => !r.eliminado_en).length,
        faltan_en_supabase: ncActivosHoja.filter(id => !ncSupa.has(id)),
        eliminados_en_supabase_pero_activos_en_hoja: ncActivosHoja.filter(id => ncSupa.get(id) && ncSupa.get(id).eliminado_en)
      },
      cierres: { hoja: cierresHoja, supabase: cierresSupa },
      ticks: { hoja: Object.keys(rT.data || {}).length, supabase: ticksSupa.size, faltan_en_supabase: Object.keys(rT.data || {}).filter(k => !ticksSupa.has(k)) }
    };
  }));
}

module.exports = { registrar, _test: { fechaMadrid, inicioDiaMadrid, sumarDias, marcaFormulario, isoDeMadridTexto, claveRegistro } };

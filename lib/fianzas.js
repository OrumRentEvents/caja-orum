// Fianzas (20 oct 2026): todo desde Supabase.
//  - Las fianzas salen de la tabla `proyectos` (la rellena la sincronización
//    Rentman→Supabase de orum-central-panel), en vez de pedir a Rentman los
//    ~2.300 proyectos y ~500 contactos en cada carga.
//  - Las solicitudes de devolución viven en `fianza_solicitudes` (antes: hoja
//    SOLICITUDES del Apps Script "ORUM Fianzas 2026"). SQL en
//    orum-central-panel/sql/fianza_solicitudes.sql.
//  - Rentman sigue siendo el sistema oficial del estado de la fianza
//    (custom_5): cuando Caja lo cambia, se escribe en Rentman y en Supabase a
//    la vez, para no esperar a la sincronización.
//
// Flujo de una solicitud: María (caja) la crea → Ana (contabilidad) hace la
// transferencia y la marca devuelta → María genera el documento en Rentman y
// avisa al cliente (notificado). "Deshacer" = cancelarla antes de que Ana la
// ejecute.

const FIANZA_METODOS = {
  '0': 'Transferencia Bancaria',
  '3': 'Efectivo Marbella',
  '4': 'Efectivo Monda',
  '5': 'TPV',
  '6': 'TPV Marbella',
  '7': 'TPV Monda'
};
const ESTADOS_FIANZA = { '0': 'Pendiente', '1': 'Pagada', '2': 'Devuelta' };

// "20/03/2026" → "2026-03-20"
function isoDeFechaES(f) {
  const m = String(f || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

function filaFianza(p) {
  const metodoId = p.forma_pago_fianza_id != null ? String(p.forma_pago_fianza_id) : '0';
  const estadoId = String(p.estado_fianza_id != null ? p.estado_fianza_id : '0');
  return {
    id: Number(p.id),
    numero: String(p.numero != null ? p.numero : ''),
    nombre: p.nombre || '',
    cliente: p.cliente || '',
    comercial: p.comercial || '',
    fecha_inicio: isoDeFechaES(p.entrega_fecha_raw),
    fecha_fin: isoDeFechaES(p.recogida_fecha_raw),
    importe: parseFloat(p.importe_fianza) || 0,
    metodo: FIANZA_METODOS[metodoId] || 'Transferencia Bancaria',
    metodo_id: metodoId,
    estado: ESTADOS_FIANZA[estadoId] || 'Pendiente',
    estado_id: estadoId,
    // Nº de operación del TPV (Rentman custom_10 / custom_15)
    op_cobro: p.num_operacion_tpv_cobro || '',
    op_devolucion: p.num_operacion_tpv_devolucion || ''
  };
}

const CAMPOS_PROYECTO = 'id,numero,nombre,cliente,comercial,entrega_fecha_raw,recogida_fecha_raw,importe_fianza,forma_pago_fianza_id,estado_fianza_id,num_operacion_tpv_cobro,num_operacion_tpv_devolucion';

// Proyectos con fianza cobrada o devuelta (mismo criterio que la versión que
// leía de Rentman: importe > 0 y estado 1 ó 2).
async function cargarFianzas(supabase) {
  let filas = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await supabase.from('proyectos').select(CAMPOS_PROYECTO)
      .gt('importe_fianza', 0).in('estado_fianza_id', ['1', '2'])
      .order('id').range(desde, desde + 999);
    if (error) throw new Error('Supabase proyectos: ' + error.message);
    filas = filas.concat(data || []);
    if (!data || data.length < 1000) break;
  }
  return filas.map(filaFianza);
}

async function cargarSolicitudes(supabase) {
  let filas = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await supabase.from('fianza_solicitudes').select('*')
      .order('fecha_solicitud').range(desde, desde + 999);
    if (error) throw new Error('Supabase fianza_solicitudes: ' + error.message);
    filas = filas.concat(data || []);
    if (!data || data.length < 1000) break;
  }
  // El cliente guardado en la solicitud a veces es un ID de Rentman (la hoja
  // lo copiaba tal cual cuando el nombre no estaba resuelto): se usa siempre
  // el nombre del proyecto en Supabase, aunque ya no figure como fianza.
  // Lo mismo con la forma de cobro: manda la de Rentman (custom_4), no la que
  // se apuntó al crear la solicitud (la hoja ponía "Transferencia" por defecto).
  const proyectos = await proyectosPorId(supabase, filas.map(s => s.proyecto_id));
  return filas.map(s => {
    const p = proyectos.get(Number(s.proyecto_id));
    const metodoRentman = p && p.forma_pago_fianza_id != null ? FIANZA_METODOS[String(p.forma_pago_fianza_id)] : '';
    return {
      ...s,
      proyecto_id: String(s.proyecto_id),
      importe: parseFloat(s.importe) || 0,
      metodo: metodoRentman || s.metodo || '',
      // Cómo se devuelve (elegido al pedirla); si no se eligió, como se cobró
      metodo_devolucion: s.metodo_devolucion || metodoRentman || s.metodo || '',
      autorizada: !s.requiere_autorizacion || !!s.autorizada_en,
      cliente: (p && p.cliente) || (/^\s*\d+\s*$/.test(s.cliente || '') ? '' : s.cliente) || '',
      nombre_proyecto: (p && p.nombre) || ''
    };
  });
}

async function proyectosPorId(supabase, ids) {
  const unicos = [...new Set(ids.map(Number).filter(Boolean))];
  const mapa = new Map();
  for (let i = 0; i < unicos.length; i += 200) {
    const { data, error } = await supabase.from('proyectos').select('id,numero,nombre,cliente,forma_pago_fianza_id').in('id', unicos.slice(i, i + 200));
    if (error) throw new Error('Supabase proyectos: ' + error.message);
    (data || []).forEach(p => mapa.set(Number(p.id), p));
  }
  return mapa;
}

// ── Importación desde la hoja (una vez, al pasar a Supabase) ─────────────
// El Apps Script devuelve fechas como "dd/MM/yyyy HH:mm" en hora de Madrid.
function utcDeMadrid(texto) {
  const m = String(texto || '').match(/^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2}))?/);
  if (!m) return null;
  const [, d, mo, y, h = '00', mi = '00'] = m;
  const comoUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi);
  // Desfase de Madrid en ese momento (CET/CEST)
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(comoUtc));
  const g = t => Number(p.find(x => x.type === t).value);
  const enMadrid = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'));
  return new Date(comoUtc - (enMadrid - comoUtc)).toISOString();
}

// En la hoja, la columna NOTAS guarda las notas de María, pero al marcar
// devuelta Ana la sobrescribe con las suyas ("BBVA 19/06 100€"). Además unas
// cuantas contienen una fecha volcada por error ("Thu May 07 2026 23:59:39
// GMT+0200 ..."), que se descarta.
const NOTA_FECHA_BASURA = /^\w{3} \w{3} \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT/;
function filaDesdeHoja(s) {
  let nota = s.notas == null ? '' : String(s.notas).trim();
  if (NOTA_FECHA_BASURA.test(nota)) nota = '';
  const estado = ['PENDIENTE', 'DEVUELTA', 'CANCELADA'].includes(String(s.estado)) ? String(s.estado) : 'PENDIENTE';
  return {
    id: String(s.id),
    proyecto_id: Number(s.proyecto_id),
    numero_proyecto: s.numero_proyecto ? String(s.numero_proyecto) : null,
    cliente: s.cliente ? String(s.cliente) : null,
    importe: parseFloat(s.importe) || 0,
    metodo: s.metodo || null,
    fecha_evento: /^\d{4}-\d{2}-\d{2}$/.test(String(s.fecha_evento || '')) ? s.fecha_evento : null,
    solicitado_por: s.solicitado_por || null,
    fecha_solicitud: utcDeMadrid(s.fecha_solicitud) || new Date().toISOString(),
    notas: estado === 'DEVUELTA' ? null : (nota || null),
    notas_devolucion: estado === 'DEVUELTA' ? (nota || null) : null,
    estado,
    fecha_devolucion: utcDeMadrid(s.fecha_devolucion),
    notificado: String(s.notificado) === 'SI',
    fecha_notificacion: utcDeMadrid(s.fecha_notificacion),
    importada_de_hoja: true
  };
}

// opciones.leerHoja() → solicitudes tal como las da el Apps Script (get_solicitudes)
// opciones.patchRentmanEstado(proyectoId, estadoId) → cambia custom_5 en Rentman
function registrar(app, { supabase, auth, authCaja, authContab, authAdmin, leerHoja, patchRentmanEstado }) {
  const cache = { fianzas: [], ts: 0 };
  const TTL = 60 * 1000; // Supabase es barato: 1 min basta para no repetir en ráfaga
  const sinSupabase = res => res.status(500).json({ ok: false, error: 'Supabase no configurado (SUPABASE_URL / SUPABASE_SERVICE_KEY)' });
  const usuario = req => (req.session.user && req.session.user.nombre) || '';

  async function fianzas(forzar) {
    if (!forzar && Date.now() - cache.ts < TTL && cache.fianzas.length) return cache.fianzas;
    cache.fianzas = await cargarFianzas(supabase);
    cache.ts = Date.now();
    return cache.fianzas;
  }

  // Cambia el estado de la fianza en Rentman y lo refleja ya en Supabase.
  async function cambiarEstadoFianza(proyectoId, estadoId) {
    await patchRentmanEstado(proyectoId, estadoId);
    const { error } = await supabase.from('proyectos').update({ estado_fianza_id: String(estadoId) }).eq('id', proyectoId);
    if (error) console.error('[Fianzas] Rentman actualizado pero Supabase no:', error.message);
    cache.ts = 0;
  }

  async function solicitudPorId(id) {
    const { data, error } = await supabase.from('fianza_solicitudes').select('*').eq('id', String(id)).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }

  const ruta = fn => async (req, res) => {
    if (!supabase) return sinSupabase(res);
    try { res.json(await fn(req, res)); }
    catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message }); }
  };
  const fallo = (status, msg) => Object.assign(new Error(msg), { status });

  app.get('/api/fianzas', auth, ruta(async req => ({ ok: true, data: await fianzas(false) })));
  app.post('/api/fianzas/cache/reload', auth, ruta(async () => { const data = await fianzas(true); return { ok: true, data, count: data.length }; }));

  app.post('/api/fianzas/:id/estado', authCaja, ruta(async req => {
    const estado = String(req.body.estado);
    if (!['0', '1', '2'].includes(estado)) throw fallo(400, 'Estado inválido');
    await cambiarEstadoFianza(Number(req.params.id), estado);
    return { ok: true };
  }));
  app.post('/api/fianzas/rentman-devuelta', authCaja, ruta(async req => {
    await cambiarEstadoFianza(Number(req.body.proyecto_id), '2');
    return { ok: true };
  }));

  app.get('/api/fianzas/solicitudes', auth, ruta(async () => ({ ok: true, data: await cargarSolicitudes(supabase) })));

  // Quién hace qué con las devoluciones (25 oct 2026):
  //  - piden la devolución: comerciales, María, Sergio
  //  - la autorizan (obligatorio en toda solicitud nueva): María o Sergio
  //  - la marcan hecha: transferencia → Ana o Isabel; efectivo o TPV → quien
  //    la devuelve en la sede (María o un comercial). Sergio, todo.
  const rol = req => (req.session.user && req.session.user.rol) || '';
  const exigirRol = (req, roles, que) => { if (!roles.includes(rol(req))) throw fallo(403, 'No tienes permiso para ' + que); };
  const esTransferencia = metodo => /transferencia/i.test(String(metodo || ''));
  const METODOS_DEVOLUCION = Object.values(FIANZA_METODOS);
  async function metodoDevolucion(s) {
    if (s.metodo_devolucion) return s.metodo_devolucion;
    const p = (await proyectosPorId(supabase, [s.proyecto_id])).get(Number(s.proyecto_id));
    return (p && FIANZA_METODOS[String(p.forma_pago_fianza_id)]) || s.metodo || '';
  }

  // Nueva solicitud. Como mucho una pendiente por proyecto (índice único
  // parcial en Supabase). Queda pendiente de autorizar.
  app.post('/api/fianzas/solicitar', auth, ruta(async req => {
    exigirRol(req, ['admin', 'caja', 'comercial'], 'pedir devoluciones de fianza');
    const b = req.body || {};
    const importe = Math.round((parseFloat(b.importe) || 0) * 100) / 100;
    if (!b.proyecto_id) throw fallo(400, 'Falta el proyecto');
    if (!(importe >= 0)) throw fallo(400, 'El importe a devolver no puede ser negativo');
    // 0 € = nos quedamos toda la fianza (antes se ponía 1 € con la nota "se queda fianza")
    if (importe === 0 && !(b.notas || '').trim()) throw fallo(400, 'Si no se devuelve nada, indica el motivo en las notas');
    const fila = {
      id: 'SOL-' + Date.now(),
      proyecto_id: Number(b.proyecto_id),
      numero_proyecto: b.numero_proyecto ? String(b.numero_proyecto) : null,
      cliente: b.cliente || null,
      importe,
      metodo: b.metodo || null,
      metodo_devolucion: METODOS_DEVOLUCION.includes(b.metodo_devolucion) ? b.metodo_devolucion : (b.metodo || null),
      requiere_autorizacion: true,
      fecha_evento: /^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha_evento || '')) ? b.fecha_evento : null,
      solicitado_por: usuario(req),
      notas: (b.notas || '').trim() || null
    };
    const { error } = await supabase.from('fianza_solicitudes').insert(fila);
    if (error) {
      if (error.code === '23505') throw fallo(409, 'Ya existe una solicitud pendiente para este proyecto');
      throw new Error(error.message);
    }
    return { ok: true, id: fila.id };
  }));

  // María / Sergio: autorizar una solicitud pendiente.
  app.post('/api/fianzas/autorizar', authCaja, ruta(async req => {
    const s = await solicitudPorId(req.body.solicitud_id);
    if (!s) throw fallo(404, 'Solicitud no encontrada');
    if (s.estado !== 'PENDIENTE') throw fallo(409, 'La solicitud ya está ' + s.estado.toLowerCase());
    if (s.autorizada_en) throw fallo(409, 'Ya está autorizada');
    const { error } = await supabase.from('fianza_solicitudes').update({ autorizada_en: new Date().toISOString(), autorizada_por: usuario(req) })
      .eq('id', s.id).eq('estado', 'PENDIENTE');
    if (error) throw new Error(error.message);
    return { ok: true };
  }));

  // Devolución hecha (transferencia: Ana/Isabel; efectivo o TPV: María o el
  // comercial que la devuelve). No toca Rentman: María genera el documento
  // allí y avisa al cliente (igual que con la hoja).
  app.post('/api/fianzas/devolver', auth, ruta(async req => {
    const s = await solicitudPorId(req.body.solicitud_id);
    if (!s) throw fallo(404, 'Solicitud no encontrada');
    if (s.estado !== 'PENDIENTE') throw fallo(409, 'La solicitud ya está ' + s.estado.toLowerCase());
    if (s.requiere_autorizacion && !s.autorizada_en) throw fallo(409, 'Falta que María o Sergio autoricen la devolución');
    if (esTransferencia(await metodoDevolucion(s))) exigirRol(req, ['admin', 'contabilidad'], 'marcar devuelta una transferencia (lo hacen Ana o Isabel)');
    else exigirRol(req, ['admin', 'caja', 'comercial'], 'marcar devuelta una fianza en efectivo o TPV (lo hace quien la devuelve)');
    const { error } = await supabase.from('fianza_solicitudes').update({
      estado: 'DEVUELTA', fecha_devolucion: new Date().toISOString(), devuelta_por: usuario(req),
      notas_devolucion: (req.body.notas || '').trim() || null
    }).eq('id', s.id).eq('estado', 'PENDIENTE');
    if (error) throw new Error(error.message);
    return { ok: true };
  }));

  // Deshacer: María o Sergio; un comercial, solo la suya y si aún no está autorizada.
  app.post('/api/fianzas/cancelar-solicitud', auth, ruta(async req => {
    const s = await solicitudPorId(req.body.solicitud_id);
    if (!s) throw fallo(404, 'Solicitud no encontrada');
    if (rol(req) === 'comercial') {
      if (s.solicitado_por !== usuario(req) || s.autorizada_en) throw fallo(403, 'Solo puedes deshacer tus solicitudes que aún no estén autorizadas');
    } else exigirRol(req, ['admin', 'caja'], 'deshacer solicitudes');
    if (s.estado !== 'PENDIENTE') throw fallo(409, 'Solo se puede deshacer una solicitud pendiente (esta está ' + s.estado.toLowerCase() + ')');
    const { error } = await supabase.from('fianza_solicitudes').update({
      estado: 'CANCELADA', fecha_cancelacion: new Date().toISOString(), cancelada_por: usuario(req)
    }).eq('id', s.id).eq('estado', 'PENDIENTE');
    if (error) throw new Error(error.message);
    return { ok: true };
  }));

  app.post('/api/fianzas/notificar', authCaja, ruta(async req => {
    const notificado = req.body.notificado !== false && req.body.notificado !== 'false';
    const { data, error } = await supabase.from('fianza_solicitudes').update({
      notificado,
      fecha_notificacion: notificado ? new Date().toISOString() : null,
      notificado_por: notificado ? usuario(req) : null
    }).eq('id', String(req.body.solicitud_id)).select('id');
    if (error) throw new Error(error.message);
    if (!data || !data.length) throw fallo(404, 'Solicitud no encontrada');
    return { ok: true };
  }));

  // Admin: copia la hoja SOLICITUDES a Supabase. Se puede repetir sin
  // duplicar (mismo id); nunca pisa una solicitud creada o tocada ya desde
  // Supabase (importada_de_hoja = false).
  app.post('/api/fianzas/importar-desde-hoja', authAdmin, ruta(async () => {
    const hoja = await leerHoja();
    const filas = hoja.filter(s => s && s.id).map(filaDesdeHoja).filter(f => f.proyecto_id && f.importe >= 0);
    const { data: propias, error: errP } = await supabase.from('fianza_solicitudes').select('id').eq('importada_de_hoja', false);
    if (errP) throw new Error(errP.message);
    const noTocar = new Set((propias || []).map(x => x.id));
    const aEscribir = filas.filter(f => !noTocar.has(f.id));
    for (let i = 0; i < aEscribir.length; i += 200) {
      const { error } = await supabase.from('fianza_solicitudes').upsert(aEscribir.slice(i, i + 200), { onConflict: 'id' });
      if (error) throw new Error('Importación (fila ' + (i + 1) + '): ' + error.message);
    }
    const porEstado = {};
    aEscribir.forEach(f => { porEstado[f.estado] = (porEstado[f.estado] || 0) + 1; });
    return { ok: true, leidas: hoja.length, importadas: aEscribir.length, omitidas_ya_en_supabase: filas.length - aEscribir.length, por_estado: porEstado };
  }));

  return { fianzas };
}

module.exports = { registrar, cargarFianzas, _test: { filaFianza, filaDesdeHoja, utcDeMadrid, isoDeFechaES } };

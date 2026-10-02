// Portal GeoVictoria — web para empleados (RFC + atención de sus clientes) y para clientes (chat).
// Seguridad: la llave "publishable" de Supabase es pública por diseño; lo que protege los datos son
// las reglas de acceso por fila en la base. Desde aquí nadie escribe directo en la base: los mensajes
// pasan por la función "chat" del servidor, que valida quién es cada persona.
// La sesión vive solo en esta pestaña y se cierra tras 30 min sin uso.
(function () {
  'use strict';
  if (window.top !== window.self) { document.body.textContent = 'Abre el Portal GeoVictoria directamente desde su dirección.'; return; }
  var URL_SB = 'https://uvodcmmehtghkbwadzlq.supabase.co';
  var LLAVE_PUBLICA = 'sb_publishable_CLYuajCg_s7EcEQDBkKyNQ__j2Wg_t3';
  var INACTIVIDAD_MS = 30 * 60 * 1000;
  var ETAPAS = ['SDR', 'Comercial', 'Implementación', 'Postventa'];
  var SUGERENCIAS = ['¿Qué es GeoVictoria?', '¿En qué etapa va mi proceso?', 'Necesito una factura del último pago', 'El lector biométrico no está marcando bien', '¿Podemos agregar 30 usuarios más?'];

  var sb = window.supabase.createClient(URL_SB, LLAVE_PUBLICA, {
    auth: { storage: window.sessionStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });

  var $ = function (id) { return document.getElementById(id); };
  var VISTAS = ['vistaLogin', 'vistaCambio', 'vistaLista', 'vistaDetalle', 'vistaClientes', 'vistaConv', 'vistaCliente'];
  var MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
  function nuevoEstado() { return { rol: null, ficha: null, rfcs: [], area: '', texto: '', convs: [], filtroConv: 'abiertas', convAbierta: null, cuentas: [], cliente: null }; }
  var estado = nuevoEstado();

  function el(tag, attrs, hijos) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'texto') n.textContent = attrs[k];
      else if (k === 'clase') n.className = attrs[k];
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (hijos || []).forEach(function (h) { if (h) n.appendChild(typeof h === 'string' ? document.createTextNode(h) : h); });
    return n;
  }
  function hoyISO() { var d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
  function fecha(iso) { if (!iso) return ''; var p = String(iso).slice(0, 10).split('-'); return +p[2] + ' de ' + MESES[+p[1] - 1] + ' ' + p[0]; }
  function hora(iso) { var d = new Date(iso); return d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }); }
  function mostrar(v) {
    VISTAS.forEach(function (x) { $(x).hidden = x !== v; });
    var emp = estado.rol === 'empleado' && ['vistaLista', 'vistaDetalle', 'vistaClientes', 'vistaConv'].indexOf(v) >= 0;
    $('pestanas').hidden = !emp;
    $('tabRfc').setAttribute('aria-pressed', String(v === 'vistaLista' || v === 'vistaDetalle'));
    $('tabClientes').setAttribute('aria-pressed', String(v === 'vistaClientes' || v === 'vistaConv'));
    window.scrollTo(0, 0);
  }
  async function llamarChat(cuerpo) {
    var r = await sb.functions.invoke('chat', { body: cuerpo });
    var datos = r.data || (r.error && r.error.context && await r.error.context.json().catch(function () { return null; }));
    return datos || { error: 'No se pudo conectar. Intenta de nuevo.' };
  }

  // ---------- sesión ----------
  var temporizador = null;
  function reiniciarInactividad() {
    clearTimeout(temporizador);
    temporizador = setTimeout(function () { salir('Tu sesión se cerró por inactividad.'); }, INACTIVIDAD_MS);
  }
  ['click', 'keydown', 'scroll', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, function () { if (estado.ficha) reiniciarInactividad(); }, { passive: true }); });

  function salir(mensaje) {
    estado = nuevoEstado();
    clearTimeout(temporizador);
    detenerTiempoReal();
    sb.auth.signOut().finally(function () {
      $('sesion').hidden = true;
      $('dispCaja').hidden = true;
      $('formLogin').reset();
      $('avisoLogin').textContent = mensaje || '';
      mostrar('vistaLogin');
    });
  }
  $('btnSalir').addEventListener('click', function () { salir(''); });

  async function arrancar() {
    var s = (await sb.auth.getSession()).data.session;
    if (!s) { mostrar('vistaLogin'); return; }
    var f = await sb.from('empleados').select('nombre, cargo, correo, activo, debe_cambiar_clave, es_lider, disponible').maybeSingle();
    var rol = 'empleado';
    if (!f.data) { f = await sb.from('clientes').select('nombre, correo, activo, debe_cambiar_clave, cuenta_id').maybeSingle(); rol = 'cliente'; }
    if (f.error || !f.data || !f.data.activo) { salir('Tu cuenta no tiene acceso. Habla con tu contacto en GeoVictoria.'); return; }
    estado.ficha = f.data; estado.rol = rol; estado.uid = s.user.id;
    $('quien').textContent = f.data.nombre || f.data.correo;
    $('sesion').hidden = false;
    reiniciarInactividad();
    if (f.data.debe_cambiar_clave) { $('formCambio').reset(); $('avisoCambio').textContent = ''; mostrar('vistaCambio'); return; }
    iniciarTiempoReal();
    if (rol === 'cliente') { $('pie').textContent = 'Te responde el asistente de GeoVictoria y, si hace falta, la persona que lleva tu cuenta.'; await abrirCliente(); return; }
    $('pie').textContent = 'Las RFC las publican la Country y los líderes desde el Comité de Cambios.';
    $('dispCaja').hidden = false;
    $('disponible').checked = f.data.disponible !== false;
    await cargarRfcs();
    mostrar('vistaLista');
    cargarConversaciones();
  }

  // ---------- ingreso ----------
  $('verClave').addEventListener('click', function () {
    var i = $('clave'), ver = i.type === 'password';
    i.type = ver ? 'text' : 'password';
    this.textContent = ver ? 'Ocultar' : 'Ver';
    this.setAttribute('aria-label', ver ? 'Ocultar contraseña' : 'Mostrar contraseña');
  });
  $('formLogin').addEventListener('submit', async function (e) {
    e.preventDefault();
    var correo = $('correo').value.trim().toLowerCase(), clave = $('clave').value;
    $('avisoLogin').textContent = '';
    if (!correo || !clave) { $('avisoLogin').textContent = 'Escribe tu correo y tu contraseña.'; return; }
    $('btnEntrar').disabled = true;
    var r = await sb.auth.signInWithPassword({ email: correo, password: clave });
    $('btnEntrar').disabled = false;
    if (r.error) { $('avisoLogin').textContent = /rate|many/i.test(r.error.message) ? 'Demasiados intentos. Espera unos minutos.' : 'Correo o contraseña incorrectos.'; return; }
    $('clave').value = '';
    arrancar();
  });

  // ---------- cambio de clave obligatorio ----------
  $('formCambio').addEventListener('submit', async function (e) {
    e.preventDefault();
    var actual = $('claveActual').value, nueva = $('claveNueva').value, nueva2 = $('claveNueva2').value;
    var aviso = $('avisoCambio');
    aviso.textContent = '';
    if (nueva !== nueva2) { aviso.textContent = 'Las contraseñas nuevas no coinciden.'; return; }
    if (nueva.length < 10 || !/[A-Za-z]/.test(nueva) || !/\d/.test(nueva)) { aviso.textContent = 'Usa al menos 10 caracteres, con letras y números.'; return; }
    $('btnCambiar').disabled = true;
    try {
      var r = await sb.functions.invoke('cambiar-clave', { body: { actual: actual, nueva: nueva } });
      var datos = r.data || (r.error && r.error.context && await r.error.context.json().catch(function () { return null; }));
      if (!datos || !datos.ok) { aviso.textContent = (datos && datos.error) || 'No se pudo cambiar la contraseña.'; return; }
      $('formCambio').reset();
      await sb.auth.signInWithPassword({ email: estado.ficha.correo, password: nueva });
      arrancar();
    } finally { $('btnCambiar').disabled = false; }
  });

  // ================= EMPLEADO: RFC =================
  $('tabRfc').addEventListener('click', function () { mostrar('vistaLista'); });
  $('tabClientes').addEventListener('click', function () { mostrar('vistaClientes'); cargarConversaciones(); cargarCuentas(); });

  async function cargarRfcs() {
    var r = await sb.from('rfcs').select('id, titulo, origen, descripcion, areas, fases, plan, activa, revision, actualizada_en, publicada_por').order('actualizada_en', { ascending: false });
    if (r.error) { $('lista').replaceChildren(el('div', { clase: 'vacio', texto: 'No se pudieron cargar las RFC. Intenta de nuevo.' })); return; }
    estado.rfcs = r.data || [];
    pintarFiltros();
    pintarLista();
  }
  function pintarFiltros() {
    var areas = [];
    estado.rfcs.forEach(function (x) { (x.areas || []).forEach(function (a) { if (areas.indexOf(a) < 0) areas.push(a); }); });
    areas.sort(function (a, b) { return a === 'Toda la empresa' ? -1 : b === 'Toda la empresa' ? 1 : a.localeCompare(b); });
    var cont = $('filtros');
    cont.replaceChildren();
    [''].concat(areas).forEach(function (a) {
      cont.appendChild(el('button', { type: 'button', clase: 'filtro', 'aria-pressed': String(estado.area === a), texto: a || 'Todas las áreas',
        onclick: function () { estado.area = a; pintarFiltros(); pintarLista(); } }));
    });
  }
  function proxima(x) {
    var hoy = hoyISO(), f = (x.fases || []).map(function (y) { return y.date; }).sort();
    var fut = f.filter(function (d) { return d >= hoy; });
    return fut.length ? 'Próximo hito: ' + fecha(fut[0]) : (f.length ? 'Terminó el ' + fecha(f[f.length - 1]) : 'Sin cronograma');
  }
  function pintarLista() {
    var t = estado.texto.toLowerCase();
    var vis = estado.rfcs.filter(function (x) {
      var areas = x.areas || [];
      var enArea = !estado.area || areas.indexOf(estado.area) >= 0 || areas.indexOf('Toda la empresa') >= 0;
      return enArea && (!t || String(x.titulo).toLowerCase().indexOf(t) >= 0);
    });
    var cont = $('lista');
    if (!vis.length) { cont.replaceChildren(el('div', { clase: 'vacio', texto: estado.rfcs.length ? 'Ninguna RFC coincide con el filtro.' : 'Todavía no hay RFC publicadas.' })); return; }
    cont.replaceChildren.apply(cont, vis.map(function (x) {
      var todos = (x.areas || []).indexOf('Toda la empresa') >= 0;
      return el('button', { type: 'button', clase: 'item' + (todos ? ' toda' : ''), onclick: function () { abrir(x.id); } }, [
        el('div', {}, [todos ? el('span', { clase: 'chip toda-chip', texto: 'Para toda la empresa' }) : null, el('h2', { texto: x.titulo }),
          el('div', { clase: 'meta', texto: (x.areas || []).filter(function (a) { return a !== 'Toda la empresa'; }).join(' · ') + ' — ' + proxima(x) })]),
        el('span', { clase: 'estado ' + (x.activa ? 'activa' : 'inactiva'), texto: x.activa ? 'Activa' : 'Inactiva' })
      ]);
    }));
  }
  $('buscar').addEventListener('input', function () { estado.texto = this.value; pintarLista(); });

  async function abrir(id) {
    var x = estado.rfcs.filter(function (r) { return r.id === id; })[0];
    if (!x) return;
    var docs = (await sb.from('rfc_documentos').select('doc_id, nombre, estado, prometido, archivo_path, archivo_nombre').eq('rfc_id', id)).data || [];
    var hoy = hoyISO();
    var fases = (x.fases || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    var queCambia = (x.plan && Array.isArray(x.plan.queCambia)) ? x.plan.queCambia : [];
    $('detalle').replaceChildren(
      el('h1', { texto: x.titulo }),
      el('div', { clase: 'meta', texto: 'Revisión ' + x.revision + ' · actualizada el ' + fecha(x.actualizada_en) + (x.publicada_por && x.publicada_por.nombre ? ' por ' + x.publicada_por.nombre : '') }),
      queCambia.length ? el('div', { clase: 'bloque' }, [el('h3', { texto: 'Qué cambia' }), el('ul', {}, queCambia.map(function (q) { return el('li', { texto: q }); }))]) : null,
      el('div', { clase: 'bloque' }, [el('h3', { texto: 'Cronograma' }),
        fases.length ? el('div', { clase: 'linea' }, fases.map(function (f) {
          var c = f.date < hoy ? 'pasado' : (f.date === hoy ? 'hoy' : '');
          return el('div', { clase: 'hito' + (f.date <= hoy ? ' alcanzado' : '') }, [el('div', { clase: 'punto ' + c }), el('div', { clase: 't', texto: f.label }), el('div', { clase: 'f', texto: fecha(f.date) })]);
        })) : el('p', { clase: 'meta', texto: 'Sin fechas definidas todavía.' })]),
      x.descripcion ? el('div', { clase: 'bloque' }, [el('h3', { texto: 'Descripción' }), el('p', { clase: 'descripcion', texto: x.descripcion })]) : null,
      (x.areas || []).length ? el('div', { clase: 'bloque' }, [el('h3', { texto: 'Áreas' }), el('div', { clase: 'chips' }, x.areas.map(function (a) { return el('span', { clase: 'chip' + (a === 'Toda la empresa' ? ' toda-chip' : ''), texto: a }); }))]) : null,
      docs.length ? el('div', { clase: 'bloque' }, [el('h3', { texto: 'Documentos' })].concat(docs.map(function (doc) {
        return el('div', { clase: 'doc' }, [el('span', { texto: doc.nombre }),
          doc.archivo_path ? el('button', { type: 'button', texto: 'Descargar', onclick: function () { descargar(doc); } })
            : el('span', { clase: 'pend', texto: doc.prometido ? 'Pendiente · prometido ' + fecha(doc.prometido) : 'Pendiente' })]);
      }))) : null
    );
    mostrar('vistaDetalle');
  }
  async function descargar(doc) {
    var r = await sb.storage.from('rfc-adjuntos').createSignedUrl(doc.archivo_path, 60, { download: doc.archivo_nombre || doc.nombre });
    if (r.error) { var p = el('p', { clase: 'aviso', texto: 'No se pudo descargar el documento.' }); $('detalle').appendChild(p); setTimeout(function () { p.remove(); }, 4000); return; }
    var a = el('a', { href: r.data.signedUrl, rel: 'noopener noreferrer' });
    document.body.appendChild(a); a.click(); a.remove();
  }
  $('btnVolver').addEventListener('click', function () { mostrar('vistaLista'); });

  // ================= EMPLEADO: mis clientes =================
  $('disponible').addEventListener('change', function () { llamarChat({ accion: 'disponible', valor: this.checked }); });
  document.querySelectorAll('[data-filtro]').forEach(function (b) {
    b.addEventListener('click', function () {
      estado.filtroConv = b.getAttribute('data-filtro');
      document.querySelectorAll('[data-filtro]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      pintarConversaciones();
    });
  });
  async function cargarConversaciones() {
    if (estado.rol !== 'empleado') return;
    var r = await sb.from('conversaciones').select('id, estado, tema, regla, pendiente_empleado, actualizada, empleado_id, cuenta_id, cliente_nombre, crm_cuentas(nombre, etapa, segmento)').order('actualizada', { ascending: false }).limit(300);
    if (r.error) return;
    estado.convs = r.data || [];
    var pendientes = estado.convs.filter(function (c) { return c.estado === 'abierta' && c.pendiente_empleado; }).length;
    $('badgeClientes').hidden = !pendientes;
    $('badgeClientes').textContent = String(pendientes);
    pintarConversaciones();
  }
  function pintarConversaciones() {
    var abiertas = estado.filtroConv === 'abiertas';
    var vis = estado.convs.filter(function (c) { return (c.estado === 'abierta') === abiertas; });
    var cont = $('listaConv');
    if (!vis.length) { cont.replaceChildren(el('div', { clase: 'vacio', texto: abiertas ? 'No tienes conversaciones abiertas.' : 'No hay conversaciones cerradas.' })); return; }
    cont.replaceChildren.apply(cont, vis.map(function (c) {
      var cuenta = c.crm_cuentas || {};
      return el('button', { type: 'button', clase: 'item', onclick: function () { abrirConversacion(c.id); } }, [
        el('div', {}, [el('h2', { texto: (cuenta.nombre || 'Empresa') + ' — ' + (c.cliente_nombre || 'cliente') }),
          el('div', { clase: 'meta', texto: (cuenta.etapa || '') + (c.tema ? ' · ' + c.tema : '') + ' · ' + hora(c.actualizada) + (c.empleado_id ? '' : ' · sin asignar') })]),
        c.pendiente_empleado && c.estado === 'abierta' ? el('span', { clase: 'estado pendiente', texto: 'Por responder' }) : el('span', { clase: 'estado inactiva', texto: c.estado === 'abierta' ? 'Al día' : 'Cerrada' })
      ]);
    }));
  }
  async function cargarCuentas() {
    var q = sb.from('crm_cuentas').select('id, nombre, etapa, fase_detalle, segmento, usuarios').eq('activa', true).order('nombre').limit(200);
    var t = $('buscarCuenta').value.trim();
    if (t) q = q.ilike('nombre', '%' + t.replace(/[%_]/g, '') + '%');
    var r = await q;
    var cont = $('listaCuentas');
    if (r.error || !r.data || !r.data.length) { cont.replaceChildren(el('div', { clase: 'vacio', texto: t ? 'Ninguna empresa coincide.' : 'Todavía no tienes cuentas asignadas en el CRM (se cruzan por tu correo).' })); return; }
    cont.replaceChildren.apply(cont, r.data.map(function (c) {
      return el('div', { clase: 'item fijo' }, [el('div', {}, [el('h2', { texto: c.nombre }),
        el('div', { clase: 'meta', texto: c.etapa + (c.fase_detalle ? ' · ' + c.fase_detalle : '') + (c.segmento ? ' · ' + c.segmento : '') + (c.usuarios != null ? ' · ' + c.usuarios + ' usuarios' : '') })])]);
    }));
  }
  var demoraBusqueda = null;
  $('buscarCuenta').addEventListener('input', function () { clearTimeout(demoraBusqueda); demoraBusqueda = setTimeout(cargarCuentas, 300); });

  async function abrirConversacion(id) {
    estado.convAbierta = id;
    $('txtResponder').value = '';
    $('avisoResponder').textContent = '';
    await pintarConversacion();
    mostrar('vistaConv');
  }
  async function pintarConversacion() {
    var id = estado.convAbierta;
    if (!id) return;
    var c = (await sb.from('conversaciones').select('id, estado, tema, regla, empleado_id, cliente_nombre, cuenta_id').eq('id', id).maybeSingle()).data;
    var m = (await sb.from('mensajes').select('id, de, autor, texto, en').eq('conversacion_id', id).order('id')).data || [];
    if (!c) return;
    // Datos internos de la cuenta (sanidad, ERP, responsables): solo por ficha_cuenta(), que verifica que el empleado pueda verla.
    var cuenta = (await sb.rpc('ficha_cuenta', { p_cuenta: c.cuenta_id })).data || {};
    var s = cuenta.senales || {};
    $('convCabecera').replaceChildren(
      el('h1', { clase: 'titulo-conv', texto: (cuenta.nombre || 'Empresa') + ' — ' + (c.cliente_nombre || '') }),
      el('div', { clase: 'meta', texto: [cuenta.etapa, cuenta.fase_detalle, cuenta.segmento, cuenta.usuarios != null ? cuenta.usuarios + ' usuarios' : '', s.sanidad ? 'Sanidad: ' + s.sanidad : '', s.erp ? 'ERP: ' + s.erp : ''].filter(Boolean).join(' · ') }),
      c.regla ? el('div', { clase: 'meta', texto: 'Asignación: ' + c.regla }) : null
    );
    pintarMensajes($('convMensajes'), m, 'empleado');
    $('btnTomar').hidden = c.empleado_id === estado.uid || c.estado !== 'abierta';
    $('btnCerrar').hidden = c.estado !== 'abierta';
  }
  function pintarMensajes(cont, mensajes, yo) {
    var abajo = cont.scrollHeight - cont.scrollTop - cont.clientHeight < 40;
    cont.replaceChildren.apply(cont, mensajes.map(function (x) {
      var propio = x.de === yo;
      return el('div', { clase: 'msg ' + x.de + (propio ? ' propio' : '') }, [
        el('div', { clase: 'autor', texto: (x.de === 'cliente' && yo === 'cliente' ? 'Tú' : (x.autor || '')) + ' · ' + hora(x.en) }),
        el('div', { clase: 'texto', texto: x.texto })]);
    }));
    if (abajo || cont.dataset.n !== String(mensajes.length)) cont.scrollTop = cont.scrollHeight;
    cont.dataset.n = String(mensajes.length);
  }
  $('formResponder').addEventListener('submit', async function (e) {
    e.preventDefault();
    var t = $('txtResponder').value.trim();
    if (!t) return;
    $('btnResponder').disabled = true;
    var d = await llamarChat({ accion: 'responder', conversacion_id: estado.convAbierta, texto: t });
    $('btnResponder').disabled = false;
    if (d.error) { $('avisoResponder').textContent = d.error; return; }
    $('txtResponder').value = '';
    pintarConversacion(); cargarConversaciones();
  });
  $('btnCerrar').addEventListener('click', async function () {
    var d = await llamarChat({ accion: 'cerrar', conversacion_id: estado.convAbierta });
    if (d.error) { $('avisoResponder').textContent = d.error; return; }
    pintarConversacion(); cargarConversaciones();
  });
  $('btnTomar').addEventListener('click', async function () {
    var d = await llamarChat({ accion: 'tomar', conversacion_id: estado.convAbierta });
    if (d.error) { $('avisoResponder').textContent = d.error; return; }
    pintarConversacion(); cargarConversaciones();
  });
  $('btnVolverConv').addEventListener('click', function () { estado.convAbierta = null; mostrar('vistaClientes'); cargarConversaciones(); });

  // ================= CLIENTE =================
  async function abrirCliente() {
    var cuenta = (await sb.from('crm_cuentas').select('nombre, etapa, fase_detalle').eq('id', estado.ficha.cuenta_id).maybeSingle()).data || {};
    estado.cliente = cuenta;
    $('cliEmpresa').textContent = cuenta.nombre || '';
    var idx = ETAPAS.indexOf(cuenta.etapa);
    $('cliEtapas').replaceChildren.apply($('cliEtapas'), ETAPAS.map(function (e, i) {
      return el('div', { clase: 'etapa' + (i < idx ? ' hecha' : i === idx ? ' actual' : '') }, [el('span', { clase: 'pto' }), el('span', { texto: e }), i === idx && cuenta.fase_detalle ? el('small', { texto: cuenta.fase_detalle }) : null]);
    }));
    $('cliSugerencias').replaceChildren.apply($('cliSugerencias'), SUGERENCIAS.map(function (s) {
      return el('button', { type: 'button', clase: 'filtro', texto: s, onclick: function () { $('txtCliente').value = s; $('txtCliente').focus(); } });
    }));
    await pintarChatCliente();
    mostrar('vistaCliente');
  }
  async function pintarChatCliente() {
    var convs = (await sb.from('conversaciones').select('id').order('creada', { ascending: false }).limit(3)).data || [];
    var m = convs.length ? ((await sb.from('mensajes').select('id, de, autor, texto, en').in('conversacion_id', convs.map(function (c) { return c.id; })).order('id')).data || []) : [];
    if (!m.length) m = [{ de: 'asistente', autor: 'Asistente GeoVictoria', texto: 'Hola, soy el asistente de GeoVictoria. Cuéntame en qué te ayudo; si es algo de tu cuenta, te paso con la persona que la lleva.', en: new Date().toISOString() }];
    pintarMensajes($('cliMensajes'), m, 'cliente');
    $('cliSugerencias').hidden = convs.length > 0;
  }
  $('formCliente').addEventListener('submit', async function (e) {
    e.preventDefault();
    var t = $('txtCliente').value.trim();
    if (!t) return;
    $('btnCliente').disabled = true;
    $('avisoCliente').textContent = '';
    var d = await llamarChat({ accion: 'enviar', texto: t });
    $('btnCliente').disabled = false;
    if (d.error) { $('avisoCliente').textContent = d.error; return; }
    $('txtCliente').value = '';
    pintarChatCliente();
  });
  $('txtCliente').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('formCliente').requestSubmit(); } });

  // ---------- tiempo real ----------
  // Supabase Realtime avisa al instante de mensajes y conversaciones nuevas. Solo llegan los cambios que las reglas por fila
  // permiten ver a esta persona (un cliente solo los suyos; un empleado los de sus cuentas). Si la conexión se cae,
  // queda el refresco de respaldo cada 30 s.
  var canal = null, pendienteRefresco = null;
  function refrescar() {
    if (!estado.ficha || estado.ficha.debe_cambiar_clave) return;
    if (estado.rol === 'cliente' && !$('vistaCliente').hidden) pintarChatCliente();
    if (estado.rol === 'empleado') {
      if (!$('vistaConv').hidden) pintarConversacion();
      cargarConversaciones();
    }
  }
  function alCambiar() { clearTimeout(pendienteRefresco); pendienteRefresco = setTimeout(refrescar, 150); }
  function iniciarTiempoReal() {
    detenerTiempoReal();
    canal = sb.channel('portal-' + (estado.uid || 'x'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mensajes' }, alCambiar)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversaciones' }, alCambiar)
      .subscribe();
  }
  function detenerTiempoReal() { if (canal) { sb.removeChannel(canal); canal = null; } }
  setInterval(function () { if (document.visibilityState === 'visible') refrescar(); }, 30000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refrescar(); });
  setInterval(function () { if (estado.rol === 'empleado' && document.visibilityState === 'visible' && !$('vistaLista').hidden) cargarRfcs(); }, 60000);

  sb.auth.onAuthStateChange(function (ev) { if (ev === 'SIGNED_OUT' && estado.ficha) salir(''); });
  arrancar();
})();

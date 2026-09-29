// Comité de Cambios GeoVictoria — web de solo lectura para empleados.
// Seguridad: la llave "publishable" de Supabase es pública por diseño; lo que protege los datos son
// las reglas de acceso por fila en la base (solo empleados activos que ya cambiaron su clave leen RFC,
// nadie escribe desde aquí). La sesión vive solo en esta pestaña y se cierra tras 30 min sin uso.
(function () {
  'use strict';
  var URL_SB = 'https://uvodcmmehtghkbwadzlq.supabase.co';
  var LLAVE_PUBLICA = 'sb_publishable_CLYuajCg_s7EcEQDBkKyNQ__j2Wg_t3';
  var INACTIVIDAD_MS = 30 * 60 * 1000;

  var sb = window.supabase.createClient(URL_SB, LLAVE_PUBLICA, {
    auth: { storage: window.sessionStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });

  var $ = function (id) { return document.getElementById(id); };
  var estado = { ficha: null, rfcs: [], area: '', texto: '', abierta: null };
  var MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];

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
  function mostrar(v) { ['vistaLogin', 'vistaCambio', 'vistaLista', 'vistaDetalle'].forEach(function (x) { $(x).hidden = x !== v; }); window.scrollTo(0, 0); }

  // ---------- sesión ----------
  var temporizador = null;
  function reiniciarInactividad() {
    clearTimeout(temporizador);
    temporizador = setTimeout(function () { salir('Tu sesión se cerró por inactividad.'); }, INACTIVIDAD_MS);
  }
  ['click', 'keydown', 'scroll', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, function () { if (estado.ficha) reiniciarInactividad(); }, { passive: true }); });

  function salir(mensaje) {
    estado = { ficha: null, rfcs: [], area: '', texto: '', abierta: null };
    clearTimeout(temporizador);
    sb.auth.signOut().finally(function () {
      $('sesion').hidden = true;
      $('formLogin').reset();
      $('avisoLogin').textContent = mensaje || '';
      mostrar('vistaLogin');
    });
  }
  $('btnSalir').addEventListener('click', function () { salir(''); });

  async function arrancar() {
    var s = (await sb.auth.getSession()).data.session;
    if (!s) { mostrar('vistaLogin'); return; }
    var f = await sb.from('empleados').select('nombre, cargo, correo, activo, debe_cambiar_clave').maybeSingle();
    if (f.error || !f.data || !f.data.activo) { salir('Tu cuenta no tiene acceso. Habla con tu líder.'); return; }
    estado.ficha = f.data;
    $('quien').textContent = f.data.nombre;
    $('sesion').hidden = false;
    reiniciarInactividad();
    if (f.data.debe_cambiar_clave) { $('formCambio').reset(); $('avisoCambio').textContent = ''; mostrar('vistaCambio'); return; }
    await cargarRfcs();
    mostrar('vistaLista');
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

  // ---------- lista ----------
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
    areas.sort();
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
      return (!estado.area || (x.areas || []).indexOf(estado.area) >= 0) && (!t || String(x.titulo).toLowerCase().indexOf(t) >= 0);
    });
    var cont = $('lista');
    if (!vis.length) { cont.replaceChildren(el('div', { clase: 'vacio', texto: estado.rfcs.length ? 'Ninguna RFC coincide con el filtro.' : 'Todavía no hay RFC publicadas.' })); return; }
    cont.replaceChildren.apply(cont, vis.map(function (x) {
      return el('button', { type: 'button', clase: 'item', onclick: function () { abrir(x.id); } }, [
        el('div', {}, [el('h2', { texto: x.titulo }), el('div', { clase: 'meta', texto: (x.areas || []).join(' · ') + (x.areas && x.areas.length ? ' — ' : '') + proxima(x) })]),
        el('span', { clase: 'estado ' + (x.activa ? 'activa' : 'inactiva'), texto: x.activa ? 'Activa' : 'Inactiva' })
      ]);
    }));
  }
  $('buscar').addEventListener('input', function () { estado.texto = this.value; pintarLista(); });

  // ---------- detalle ----------
  async function abrir(id) {
    var x = estado.rfcs.filter(function (r) { return r.id === id; })[0];
    if (!x) return;
    estado.abierta = id;
    var docs = (await sb.from('rfc_documentos').select('doc_id, nombre, estado, prometido, archivo_path, archivo_nombre').eq('rfc_id', id)).data || [];
    var hoy = hoyISO();
    var fases = (x.fases || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    var queCambia = (x.plan && Array.isArray(x.plan.queCambia)) ? x.plan.queCambia : [];
    var d = $('detalle');
    d.replaceChildren(
      el('h1', { texto: x.titulo }),
      el('div', { clase: 'meta', texto: 'Revisión ' + x.revision + ' · actualizada el ' + fecha(x.actualizada_en) + (x.publicada_por && x.publicada_por.nombre ? ' por ' + x.publicada_por.nombre : '') }),
      queCambia.length ? el('div', { clase: 'bloque' }, [el('h3', { texto: 'Qué cambia' }), el('ul', {}, queCambia.map(function (q) { return el('li', { texto: q }); }))]) : null,
      el('div', { clase: 'bloque' }, [el('h3', { texto: 'Cronograma' }),
        fases.length ? el('div', { clase: 'linea' }, fases.map(function (f) {
          var c = f.date < hoy ? 'pasado' : (f.date === hoy ? 'hoy' : '');
          return el('div', { clase: 'hito' + (f.date <= hoy ? ' alcanzado' : '') }, [el('div', { clase: 'punto ' + c }), el('div', { clase: 't', texto: f.label }), el('div', { clase: 'f', texto: fecha(f.date) })]);
        })) : el('p', { clase: 'meta', texto: 'Sin fechas definidas todavía.' })]),
      x.descripcion ? el('div', { clase: 'bloque' }, [el('h3', { texto: 'Descripción' }), el('p', { clase: 'descripcion', texto: x.descripcion })]) : null,
      (x.areas || []).length ? el('div', { clase: 'bloque' }, [el('h3', { texto: 'Áreas' }), el('div', { clase: 'chips' }, x.areas.map(function (a) { return el('span', { clase: 'chip', texto: a }); }))]) : null,
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
    if (r.error) { alertaSuave('No se pudo descargar el documento.'); return; }
    var a = el('a', { href: r.data.signedUrl, rel: 'noopener noreferrer' });
    document.body.appendChild(a); a.click(); a.remove();
  }
  function alertaSuave(t) { var p = el('p', { clase: 'aviso', texto: t }); $('detalle').appendChild(p); setTimeout(function () { p.remove(); }, 4000); }
  $('btnVolver').addEventListener('click', function () { estado.abierta = null; mostrar('vistaLista'); });

  // Refresca la lista cada minuto mientras la pestaña está visible (así aparecen las RFC nuevas).
  setInterval(function () { if (estado.ficha && !estado.ficha.debe_cambiar_clave && document.visibilityState === 'visible' && !$('vistaLista').hidden) cargarRfcs(); }, 60000);

  sb.auth.onAuthStateChange(function (ev) { if (ev === 'SIGNED_OUT' && estado.ficha) salir(''); });
  arrancar();
})();

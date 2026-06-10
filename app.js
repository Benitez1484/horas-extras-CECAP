'use strict';
/* ════════════════════════════════════════════════════
   TIMETRACK PRO  –  app.js  v2.1
   ════════════════════════════════════════════════════ */

/* ── Firebase ─────────────────────────────────────── */
const firebaseConfig = {
  apiKey:            "AIzaSyCRDjxDzGA-9FAxxmsm0vzr3GGWxtT4Vx0",
  authDomain:        "horasextras-d9155.firebaseapp.com",
  projectId:         "horasextras-d9155",
  storageBucket:     "horasextras-d9155.firebasestorage.app",
  messagingSenderId: "155998460822",
  appId:             "1:155998460822:web:2c20bb105ab7bb7a539bb7"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// Caché local en disco → segunda visita es instantánea
db.enablePersistence({ synchronizeTabs: true }).catch(() => {
  // Si falla (navegador privado o ya activo en otra pestaña), ignorar
});

/* ── Constants ────────────────────────────────────── */
const SESSION_KEY   = 'tt_v2_session';
const SESSION_HOURS = 8;
const ADMIN_REF     = db.doc('config/admin');
const COLORS = [
  '#00d4aa','#ff6b6b','#ffd166','#4d9fff','#a78bfa',
  '#fb923c','#34d399','#f472b6','#60a5fa','#e879f9'
];

/* ── Login cache (evita llamadas extra a Firebase al iniciar sesión) ────── */
const CACHE = {
  admin:     null,  // { name, passwordHash } – precargado en init()
  employees: {},    // { id: { name, color, passwordHash } } – precargado al mostrar login
};

/* ── State ────────────────────────────────────────── */
const S = {
  session:     null,   // { personId, name, color, isAdmin }
  employees:   {},     // { id: employeeData }
  empStats:    {},     // cached stats { id: {extra,recovery,balance} }
  currentPid:  null,
  entries:     [],
  entryUnsub:  null,
  empUnsub:    null,
  entryType:   'extra',
  activeFilter:'all',
  pickedColor: COLORS[0],
  changePwFor: null,   // { personId, isAdmin }
  drawerOpen:  false,
};

/* ════════════════════════════════════════════════════
   SHA-256 via Web Crypto (no libraries needed)
   ════════════════════════════════════════════════════ */
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

/* ════════════════════════════════════════════════════
   SESSION  (sessionStorage, expires in 8h)
   ════════════════════════════════════════════════════ */
function saveSession(data) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({
    ...data, expiresAt: Date.now() + SESSION_HOURS * 3_600_000
  }));
}
function loadSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (s && s.expiresAt > Date.now()) return s;
    sessionStorage.removeItem(SESSION_KEY);
  } catch {}
  return null;
}
function clearSession() { sessionStorage.removeItem(SESSION_KEY) }

/* ════════════════════════════════════════════════════
   HELPERS
   ════════════════════════════════════════════════════ */
const qs    = id => document.getElementById(id);
const uid   = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const today = () => new Date().toISOString().slice(0,10);
const ini   = n  => (n||'').trim().split(/\s+/).slice(0,2).map(w=>w[0]||'').join('').toUpperCase() || '?';

function fmtH(h) {
  h = Math.max(h || 0, 0);
  const hrs  = Math.floor(h);
  const mins = Math.round((h - hrs) * 60);
  if (!hrs && !mins) return '0h';
  if (!hrs)  return `${mins}m`;
  if (!mins) return `${hrs}h`;
  return `${hrs}h ${mins}m`;
}
function fmtDate(d) {
  if (!d) return '';
  const [y,m,day] = d.split('-');
  return `${day}/${m}/${y.slice(2)}`;
}
function calcStats(list) {
  let extra = 0, recovery = 0;
  (list || []).forEach(e => e.type === 'extra' ? extra += (e.hours||0) : recovery += (e.hours||0));
  return { extra, recovery, balance: extra - recovery };
}
function animateCount(el, target) {
  if (!el) return;
  const start = performance.now(), dur = 700;
  (function step(now) {
    const t = Math.min((now - start) / dur, 1);
    el.textContent = fmtH(target * (t<.5 ? 2*t*t : -1+(4-2*t)*t));
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = fmtH(target);
  })(start);
}
function toast(msg, type = 'ok') {
  const el = qs('toast'); if (!el) return;
  qs('ti').textContent = type==='ok' ? '✅' : type==='err' ? '❌' : 'ℹ️';
  qs('tm').textContent = msg;
  el.className = `toast t-${type} show`;
  setTimeout(() => el.classList.remove('show'), 3500);
}
function togglePw(id) {
  const el = qs(id);
  if (el) el.type = el.type === 'password' ? 'text' : 'password';
}
function copyRules() {
  const txt = qs('rules-text');
  if (txt) navigator.clipboard.writeText(txt.textContent).then(() => toast('Reglas copiadas ✓'));
}
function showResetHelp() {
  alert(
    '¿Olvidaste la contraseña del Administrador?\n\n' +
    '1. Abre Firebase Console:\n' +
    '   https://console.firebase.google.com/project/horasextras-d9155/firestore\n\n' +
    '2. Ve a: config → admin\n' +
    '3. Haz clic en "Eliminar documento"\n' +
    '4. Recarga esta página\n' +
    '5. Podrás configurar una nueva contraseña\n\n' +
    '(Solo el admin puede eliminar ese documento)'
  );
}

/* ════════════════════════════════════════════════════
   SCREEN SWITCHER
   ════════════════════════════════════════════════════ */
function showScreen(name) {
  ['loading-screen','firebase-help','setup-screen','login-screen','app'].forEach(id => {
    const el = qs(id); if (!el) return;
    el.style.display = id === name ? (id === 'app' ? 'block' : 'flex') : 'none';
  });
}

/* ════════════════════════════════════════════════════
   INIT  —  punto de entrada principal
   ════════════════════════════════════════════════════ */
async function init() {
  showScreen('loading-screen');
  stopListeners();  // limpia listeners anteriores

  // ¿Hay sesión válida? Restaurar sin pasar por login
  const session = loadSession();
  if (session) {
    S.session = session;
    try { await startApp(); return; } catch (e) { clearSession(); }
  }

  // Verificar conexión y configuración de Firebase
  try {
    const snap = await Promise.race([
      ADMIN_REF.get(),
      new Promise((_, rej) =>
        setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'timeout' })), 10000)
      )
    ]);

    if (!snap.exists) {
      // Primera vez: mostrar setup
      showScreen('setup-screen');
    } else {
      CACHE.admin = snap.data(); // ← guardar en caché para login instantáneo
      await populateLoginDropdown();
      showScreen('login-screen');
    }
  } catch (err) {
    console.error('init() error:', err.code, err.message);
    if (err.code === 'permission-denied') {
      showScreen('firebase-help');
    } else if (err.code === 'timeout') {
      toast('Sin conexión a internet. Verifica tu red.', 'err');
      showScreen('login-screen');
    } else {
      toast('Error de conexión: ' + (err.message || err.code || 'desconocido'), 'err');
      showScreen('login-screen');
    }
  }
}

/* ── Cleanup listeners ────────────────────────────── */
function stopListeners() {
  if (S.entryUnsub) { try { S.entryUnsub() } catch {} S.entryUnsub = null }
  if (S.empUnsub)   { try { S.empUnsub()   } catch {} S.empUnsub   = null }
}
function fullCleanup() {
  stopListeners();
  S.session    = null;
  S.employees  = {};
  S.empStats   = {};
  S.currentPid = null;
  S.entries    = [];
  S.drawerOpen = false;
}

/* ════════════════════════════════════════════════════
   PRIMERA CONFIGURACIÓN (admin)
   ════════════════════════════════════════════════════ */
async function doSetupAdmin() {
  const name = (qs('setup-name').value || '').trim() || 'Administrador';
  const pw1  = qs('setup-pw').value;
  const pw2  = qs('setup-pw2').value;

  if (!pw1)           { toast('Escribe una contraseña', 'err'); return }
  if (pw1.length < 4) { toast('Mínimo 4 caracteres', 'err'); return }
  if (pw1 !== pw2)    { toast('Las contraseñas no coinciden', 'err'); return }

  const btn = qs('setup-btn');
  btn.disabled = true;
  btn.textContent = 'Guardando…';

  try {
    const hash = await sha256(pw1);
    await ADMIN_REF.set({ name, passwordHash: hash, createdAt: new Date().toISOString() });
    // Auto-login como admin tras configurar
    S.session = { personId: '__admin__', name, color: '#4d9fff', isAdmin: true };
    saveSession(S.session);
    toast('¡Sistema configurado! Bienvenido 🎉');
    await startApp();
  } catch (err) {
    console.error('doSetupAdmin error:', err);
    if (err.code === 'permission-denied') showScreen('firebase-help');
    else toast('Error al guardar: ' + (err.message || ''), 'err');
    btn.disabled = false;
    btn.textContent = 'Configurar Sistema →';
  }
}

/* ════════════════════════════════════════════════════
   AUTH  —  login / logout
   ════════════════════════════════════════════════════ */
async function populateLoginDropdown() {
  try {
    // Sin orderBy para evitar requerir índices de Firestore
    const snap = await db.collection('employees').get();
    const list = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));

    // Guardar en caché para verificación local en doLogin (sin llamada extra a Firebase)
    CACHE.employees = {};
    list.forEach(emp => { CACHE.employees[emp.id] = emp });

    const sel = qs('login-who');
    sel.innerHTML = '<option value="">— Seleccionar persona —</option><option value="__admin__">🛡 Administrador</option>';
    list.forEach(emp => {
      const o = document.createElement('option');
      o.value = emp.id;
      o.textContent = emp.name;
      sel.appendChild(o);
    });
  } catch (err) {
    console.error('populateLoginDropdown:', err);
    if (err.code === 'permission-denied') showScreen('firebase-help');
  }
}

async function doLogin() {
  const pid   = qs('login-who').value;
  const pw    = qs('login-pw').value;
  const errEl = qs('login-err');
  const btn   = qs('login-btn');

  errEl.style.display = 'none';
  if (!pid) { toast('Selecciona una persona de la lista', 'err'); return }
  if (!pw)  { toast('Escribe tu contraseña', 'err'); return }

  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;margin:0 auto"></div>';

  try {
    // SHA-256 local (≈ 1ms) — sin llamada a Firebase
    const hash = await sha256(pw);
    let newSession;

    if (pid === '__admin__') {
      // Verificar contra caché local (cargado en init)
      if (!CACHE.admin || CACHE.admin.passwordHash !== hash) {
        throw Object.assign(new Error(), { code: 'wrong' });
      }
      newSession = {
        personId: '__admin__', isAdmin: true,
        name: CACHE.admin.name || 'Administrador', color: '#4d9fff'
      };
    } else {
      // Verificar contra caché local (cargado en populateLoginDropdown)
      const emp = CACHE.employees[pid];
      if (!emp || emp.passwordHash !== hash) {
        // Si no hay caché (ej. página recién abierta con sesión), ir a Firebase como respaldo
        const snap = await db.collection('employees').doc(pid).get();
        if (!snap.exists || snap.data().passwordHash !== hash) {
          throw Object.assign(new Error(), { code: 'wrong' });
        }
        const d = snap.data();
        CACHE.employees[pid] = d; // guardar para próxima vez
        newSession = { personId: pid, isAdmin: false, name: d.name, color: d.color || '#00d4aa' };
      } else {
        newSession = { personId: pid, isAdmin: false, name: emp.name, color: emp.color || '#00d4aa' };
      }
    }

    S.session = newSession;
    saveSession(S.session);
    await startApp();

  } catch (err) {
    if (err.code === 'wrong') {
      errEl.style.display = 'flex';
    } else if (err.code === 'permission-denied') {
      showScreen('firebase-help');
    } else {
      toast('Error de conexión: ' + (err.message || err.code || ''), 'err');
      console.error('doLogin error:', err);
    }
    btn.disabled = false;
    btn.innerHTML = '<span>Iniciar Sesión</span> <span>→</span>';
  }
}

function doLogout() {
  if (!confirm('¿Cerrar sesión?')) return;
  fullCleanup();
  clearSession();
  qs('login-pw').value = '';
  qs('login-who').value = '';
  qs('login-err').style.display = 'none';
  closeDrawer();
  populateLoginDropdown();
  showScreen('login-screen');
}

/* ════════════════════════════════════════════════════
   INICIAR APP tras login exitoso
   ════════════════════════════════════════════════════ */
async function startApp() {
  showScreen('app');
  const s = S.session;

  // User chip en el header
  qs('user-chip').innerHTML =
    `<div class="uc-av" style="background:${s.color}">${ini(s.name)}</div>` +
    `<span class="uc-name">${s.name.split(' ')[0]}</span>` +
    (s.isAdmin ? '<span class="uc-role">Admin</span>' : '');

  if (s.isAdmin) {
    qs('btn-summary').style.display = '';
    qs('btn-add-emp').style.display = 'flex';
    qs('hamburger').style.display   = '';     // CSS oculta en desktop
    qs('sidebar').style.display     = '';
    showPersonView(null);
    startEmployeeListener();
  } else {
    // Empleado: sin sidebar, ve directamente sus datos
    qs('btn-summary').style.display = 'none';
    qs('btn-add-emp').style.display = 'none';
    qs('hamburger').style.display   = 'none';
    qs('sidebar').style.display     = 'none';
    selectPerson(s.personId);
  }
}

/* ════════════════════════════════════════════════════
   LISTENER DE EMPLEADOS (solo admin, tiempo real)
   ════════════════════════════════════════════════════ */
function startEmployeeListener() {
  stopListeners();
  // Sin orderBy → evita requerir índices compuestos en Firestore
  S.empUnsub = db.collection('employees').onSnapshot(snap => {
    const list = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    S.employees = {};
    list.forEach(emp => { S.employees[emp.id] = emp });
    renderSidebar();
    // Si el colaborador actual fue eliminado, limpiar vista
    if (S.currentPid && !S.employees[S.currentPid]) {
      if (S.entryUnsub) { try { S.entryUnsub() } catch {} S.entryUnsub = null }
      S.currentPid = null; S.entries = [];
      showPersonView(null);
    }
  }, err => {
    console.error('Employee listener:', err);
    if (err.code === 'permission-denied') showScreen('firebase-help');
    else toast('Error al cargar colaboradores', 'err');
  });
}

/* ════════════════════════════════════════════════════
   CRUD EMPLEADOS
   ════════════════════════════════════════════════════ */
function openAddEmployee() {
  closeDrawer();
  qs('ie-name').value = '';
  qs('ie-pw').value   = '';
  S.pickedColor = COLORS[Object.keys(S.employees).length % COLORS.length];
  buildColorPicker();
  openModal('m-emp');
  setTimeout(() => qs('ie-name').focus(), 180);
}

async function doAddEmployee() {
  const name = (qs('ie-name').value || '').trim();
  const pw   = qs('ie-pw').value;

  if (!name)         { toast('Escribe el nombre del colaborador', 'err'); return }
  if (!pw)           { toast('Escribe una contraseña inicial', 'err'); return }
  if (pw.length < 3) { toast('La contraseña debe tener mínimo 3 caracteres', 'err'); return }

  // Verificar nombre duplicado
  const existingNames = Object.values(S.employees).map(e => e.name.toLowerCase());
  if (existingNames.includes(name.toLowerCase())) {
    toast('Ya existe un colaborador con ese nombre', 'err'); return;
  }

  try {
    const hash = await sha256(pw);
    const newId = uid();
    const empData = {
      name, color: S.pickedColor, passwordHash: hash,
      createdAt: new Date().toISOString()
    };
    await db.collection('employees').doc(newId).set(empData);
    CACHE.employees[newId] = { id: newId, ...empData }; // añadir al caché
    closeModals();
    toast(`${name} agregado al equipo 🎉`);
  } catch (err) {
    console.error('doAddEmployee:', err);
    if (err.code === 'permission-denied') showScreen('firebase-help');
    else toast('Error al guardar', 'err');
  }
}

async function doDeleteEmployee(id) {
  const p = S.employees[id];
  if (!p) return;
  if (!confirm(`¿Eliminar a "${p.name}" y TODOS sus registros?\n\n⚠ Esta acción no se puede deshacer.`)) return;
  try {
    const snap  = await db.collection('employees').doc(id).collection('entries').get();
    const batch = db.batch();
    snap.forEach(d => batch.delete(d.ref));
    batch.delete(db.collection('employees').doc(id));
    await batch.commit();
    if (S.currentPid === id) {
      if (S.entryUnsub) { try { S.entryUnsub() } catch {} S.entryUnsub = null }
      S.currentPid = null; S.entries = [];
      showPersonView(null);
    }
    toast(`${p.name} eliminado del sistema`);
  } catch (err) {
    console.error('doDeleteEmployee:', err);
    toast('Error al eliminar: ' + (err.message || ''), 'err');
  }
}

/* ════════════════════════════════════════════════════
   CAMBIO DE CONTRASEÑA
   ════════════════════════════════════════════════════ */
function openChangePw(personId, isAdmin) {
  S.changePwFor = { personId, isAdmin };
  const lbl = isAdmin
    ? 'Administrador'
    : (S.employees[personId]?.name || S.session?.name || 'Colaborador');
  qs('pw-for').textContent = `Cambiando contraseña de: ${lbl}`;
  qs('ipw-new').value  = '';
  qs('ipw-new2').value = '';
  openModal('m-pw');
  setTimeout(() => qs('ipw-new').focus(), 180);
}

async function doChangePw() {
  const pw1 = qs('ipw-new').value;
  const pw2 = qs('ipw-new2').value;

  if (!pw1)           { toast('Escribe la nueva contraseña', 'err'); return }
  if (pw1.length < 3) { toast('Mínimo 3 caracteres', 'err'); return }
  if (pw1 !== pw2)    { toast('Las contraseñas no coinciden', 'err'); return }

  const { personId, isAdmin } = S.changePwFor;
  try {
    const hash = await sha256(pw1);
    if (isAdmin) {
      await ADMIN_REF.update({ passwordHash: hash });
      if (CACHE.admin) CACHE.admin.passwordHash = hash; // mantener caché sincronizado
    } else {
      await db.collection('employees').doc(personId).update({ passwordHash: hash });
      if (CACHE.employees[personId]) CACHE.employees[personId].passwordHash = hash;
    }
    closeModals();
    toast('Contraseña actualizada correctamente ✓');
  } catch (err) {
    console.error('doChangePw:', err);
    toast('Error al cambiar contraseña', 'err');
  }
}

/* ════════════════════════════════════════════════════
   SELECCIÓN DE PERSONA Y VISTA
   ════════════════════════════════════════════════════ */
function selectPerson(id) {
  S.currentPid   = id;
  S.entries      = [];       // limpiar registros del anterior
  S.activeFilter = 'all';   // resetear filtro
  if (S.entryUnsub) { try { S.entryUnsub() } catch {} S.entryUnsub = null }

  showPersonView(id);
  renderPersonHeader(id);
  resetFilterPills();
  if (S.session?.isAdmin) { renderSidebar(); closeDrawer() }

  // Spinner mientras carga
  const el = qs('entries-list');
  if (el) el.innerHTML = '<div class="loading"><div class="spinner"></div> Cargando registros…</div>';

  // Listener en tiempo real de registros
  // Sin orderBy para evitar índices; ordenamos client-side
  S.entryUnsub = db.collection('employees').doc(id).collection('entries')
    .onSnapshot(snap => {
      S.entries = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      S.empStats[id] = calcStats(S.entries);
      renderStats();
      renderEntries();
      if (S.session?.isAdmin) renderSidebar();
    }, err => {
      console.error('Entry listener:', err);
      if (err.code === 'permission-denied') showScreen('firebase-help');
      else toast('Error al cargar registros', 'err');
    });
}

function showPersonView(id) {
  const show = !!id;
  const em = qs('empty-state');
  const pv = qs('person-view');
  if (em) em.style.display = show ? 'none' : 'flex';
  if (pv) pv.style.display = show ? 'block' : 'none';
}

function renderPersonHeader(id) {
  const s = S.session;
  const p = s?.isAdmin
    ? S.employees[id]
    : { name: s?.name || '', color: s?.color || '#00d4aa', createdAt: '' };
  if (!p) return;

  const av = qs('v-avatar');
  if (av) {
    av.textContent      = ini(p.name);
    av.style.background = p.color || '#00d4aa';
    av.style.boxShadow  = `0 0 22px ${p.color || '#00d4aa'}55`;
  }
  const n = qs('v-name');
  const t = qs('v-since');
  if (n) n.textContent = p.name;
  if (t) t.textContent = p.createdAt
    ? `Desde ${new Date(p.createdAt).toLocaleDateString('es-ES',{day:'numeric',month:'long',year:'numeric'})}`
    : '';

  const actions = qs('ph-actions');
  if (!actions) return;
  if (s?.isAdmin) {
    actions.innerHTML =
      `<button class="btn btn-ghost btn-sm" onclick="openChangePw('${id}',false)" title="Cambiar contraseña">🔑</button>` +
      `<button class="danger-btn" onclick="doDeleteEmployee('${id}')" title="Eliminar colaborador">🗑</button>`;
  } else {
    actions.innerHTML =
      `<button class="btn btn-ghost btn-sm" onclick="openChangePw('${s.personId}',false)">🔑 Mi contraseña</button>`;
  }
}

/* ════════════════════════════════════════════════════
   RENDER SIDEBAR
   ════════════════════════════════════════════════════ */
function renderSidebar() {
  const list = qs('person-list'); if (!list) return;
  const ids  = Object.keys(S.employees);

  const sumBtn = qs('btn-summary');
  if (sumBtn) sumBtn.style.display = ids.length ? '' : 'none';

  if (!ids.length) {
    list.innerHTML = '<div style="padding:20px 14px;text-align:center;color:var(--txt3);font-size:.82rem;line-height:1.7">Sin colaboradores.<br>Agrega el primero ↓</div>';
    return;
  }

  list.innerHTML = ids.map(id => {
    const p     = S.employees[id];
    const stats = S.empStats[id] || { extra:0, recovery:0, balance:0 };
    const { extra, recovery, balance } = stats;
    const pct = extra > 0 ? Math.min(Math.round((recovery/extra)*100), 100) : (recovery > 0 ? 100 : 0);
    const bc  = balance > 0 ? 'bpending' : balance < 0 ? 'bgold' : 'bok';
    const bt  = balance > 0 ? `${fmtH(balance)} ⚠` : balance < 0 ? `${fmtH(-balance)} ↑` : '✓';

    return `<div class="person-tab${id === S.currentPid ? ' active' : ''}" style="--tc:${p.color}" onclick="selectPerson('${id}')">
      <div class="ptab-inner">
        <div class="avatar" style="background:${p.color};box-shadow:0 0 10px ${p.color}44">${ini(p.name)}</div>
        <div class="ptab-info">
          <div class="ptab-name">${p.name}</div>
          <div class="ptab-prog"><div class="ptab-prog-bar" style="width:${pct}%;background:${p.color}"></div></div>
          <div class="ptab-meta">${pct}% repuesto</div>
        </div>
        <span class="badge ${bc}">${bt}</span>
      </div>
    </div>`;
  }).join('');
}

/* ════════════════════════════════════════════════════
   RENDER STATS (tarjetas numéricas)
   ════════════════════════════════════════════════════ */
function renderStats() {
  const { extra, recovery, balance } = calcStats(S.entries);
  const ec = S.entries.filter(e => e.type === 'extra').length;
  const rc = S.entries.filter(e => e.type === 'recovery').length;

  animateCount(qs('s-extra'),    extra);
  animateCount(qs('s-recovery'), recovery);
  animateCount(qs('s-balance'),  Math.abs(balance));

  const scE = qs('sc-extra');    if (scE) scE.textContent = `${ec} registro${ec!==1?'s':''}`;
  const scR = qs('sc-recovery'); if (scR) scR.textContent = `${rc} registro${rc!==1?'s':''}`;

  const maxH = Math.max(extra, recovery, 0.01);
  setTimeout(() => {
    const sbE = qs('sb-extra');
    const sbR = qs('sb-recovery');
    const sbB = qs('sb-balance');
    if (sbE) sbE.style.width = `${(extra/maxH)*100}%`;
    if (sbR) sbR.style.width = `${(recovery/maxH)*100}%`;
    if (sbB) sbB.style.width = extra > 0 ? `${Math.min((Math.abs(balance)/extra)*100,100)}%` : '0%';
  }, 80);

  const pct    = extra > 0 ? Math.round((recovery/extra)*100) : 0;
  const banner = qs('banner');
  const scCard = qs('sc-card');
  const scBal  = qs('sc-balance');
  const bIcon  = qs('b-icon');
  const bTitle = qs('b-title');
  const bSub   = qs('b-sub');
  const bPct   = qs('b-pct');

  let state;
  if (extra === 0 && recovery === 0)  state = 'neutral';
  else if (balance > 0)               state = 'pending';
  else if (balance === 0)             state = 'ok';
  else                                state = 'credit';

  const cfg = {
    neutral: { sc:'--sc:var(--txt3)',    bal:'sin datos',   cls:'bn-neutral', icon:'💡', title:'Sin registros aún',               sub:'Usa los botones para agregar horas extra o reposiciones.', pct:'' },
    pending: { sc:'--sc:var(--coral)',   bal:'por reponer', cls:'bn-pending', icon:'⏳', title:`Pendiente: ${fmtH(balance)}`,     sub:`Quedan ${fmtH(balance)} por reponer.`,                     pct:`${pct}%` },
    ok:      { sc:'--sc:var(--teal)',    bal:'al día',      cls:'bn-ok',      icon:'✅', title:'¡Al Día! Todo el tiempo repuesto', sub:'Excelente, no hay horas extras pendientes.',               pct:'100%' },
    credit:  { sc:'--sc:var(--gold)',    bal:'a tu favor',  cls:'bn-credit',  icon:'🏆', title:`Saldo a favor: ${fmtH(-balance)}`,sub:'Se repuso más tiempo del trabajado extra.',                pct:'+' },
  }[state];

  if (scCard) scCard.style.cssText = cfg.sc;
  if (scBal)  scBal.textContent    = cfg.bal;
  if (banner) banner.className     = `banner ${cfg.cls}`;
  if (bIcon)  bIcon.textContent    = cfg.icon;
  if (bTitle) bTitle.textContent   = cfg.title;
  if (bSub)   bSub.textContent     = cfg.sub;
  if (bPct)   bPct.textContent     = cfg.pct;
}

/* ════════════════════════════════════════════════════
   FILTRO DE REGISTROS
   ════════════════════════════════════════════════════ */
function resetFilterPills() {
  S.activeFilter = 'all';
  ['all','extra','recovery'].forEach(k => {
    const b = qs(`fp-${k}`); if (!b) return;
    b.className = 'fpill' + (k === 'all' ? ' fpill-active' : '');
  });
}
function setFilter(f) {
  S.activeFilter = f;
  ['all','extra','recovery'].forEach(k => {
    const b = qs(`fp-${k}`); if (!b) return;
    b.className = 'fpill' + (f===k ? ` fpill-${k==='all'?'active':k}` : '');
  });
  renderEntries();
}

/* ════════════════════════════════════════════════════
   RENDER REGISTROS
   ════════════════════════════════════════════════════ */
function renderEntries() {
  const list = qs('entries-list'); if (!list) return;
  const filtered = S.activeFilter === 'all'
    ? S.entries
    : S.entries.filter(e => e.type === S.activeFilter);

  if (!filtered.length) {
    const msg = S.activeFilter === 'extra' ? 'Sin horas extra.'
              : S.activeFilter === 'recovery' ? 'Sin reposiciones.'
              : 'Sin registros todavía.';
    list.innerHTML = `<div class="entries-empty">
      <div style="font-size:2rem">📋</div>
      <p>${msg}<br><small>Usa los botones de arriba para agregar.</small></p>
    </div>`;
    return;
  }

  list.innerHTML = filtered.map(e => `
    <div class="entry-card">
      <div class="entry-accent" style="background:${e.type==='extra'?'var(--coral)':'var(--teal)'}"></div>
      <div class="entry-body">
        <div class="entry-top">
          <span class="entry-pill ${e.type==='extra'?'pill-extra':'pill-recovery'}">
            ${e.type==='extra'?'⬆ Extra':'⬇ Reposición'}
          </span>
          <span class="entry-date-txt">${fmtDate(e.date)}</span>
        </div>
        <div class="entry-activity">${e.activity||''}</div>
        ${e.notes ? `<div class="entry-notes">${e.notes}</div>` : ''}
      </div>
      <div class="entry-right">
        <div class="entry-hrs ${e.type==='extra'?'hrs-extra':'hrs-recovery'}">
          ${e.type==='extra'?'+':'-'}${fmtH(e.hours||0)}
        </div>
        <button class="entry-del" onclick="doDeleteEntry('${e.id}')" title="Eliminar">✕</button>
      </div>
    </div>`).join('');
}

/* ════════════════════════════════════════════════════
   CRUD REGISTROS
   ════════════════════════════════════════════════════ */
function openAddEntry(type) {
  if (!S.currentPid) { toast('Selecciona un colaborador primero', 'err'); return }
  S.entryType = type || 'extra';
  selectEntryType(S.entryType);
  qs('ie-date').value  = today();
  qs('ie-hrs').value   = '';
  qs('ie-min').value   = '0';
  qs('ie-act').value   = '';
  qs('ie-notes').value = '';
  openModal('m-entry');
  setTimeout(() => qs('ie-hrs').focus(), 180);
}

function selectEntryType(t) {
  S.entryType = t;
  const toE = qs('topt-extra');
  const toR = qs('topt-recovery');
  const ttl = qs('entry-ttl');
  const btn = qs('btn-save');
  if (toE) toE.className = `topt${t==='extra'?' topt-extra':''}`;
  if (toR) toR.className = `topt${t==='recovery'?' topt-recovery':''}`;
  if (ttl) ttl.textContent = t==='extra' ? '⬆ Registrar Horas Extra' : '⬇ Registrar Reposición';
  if (btn) {
    btn.style.background = t==='extra' ? 'var(--coral)' : 'var(--teal)';
    btn.style.boxShadow  = t==='extra' ? '0 0 16px var(--coral-g)' : '0 0 16px var(--teal-g)';
    btn.style.color      = t==='extra' ? '#fff' : '#060c1a';
  }
}

async function doSaveEntry() {
  const date  = qs('ie-date').value;
  const hrs   = parseInt(qs('ie-hrs').value)  || 0;
  const mins  = parseInt(qs('ie-min').value)  || 0;
  const act   = (qs('ie-act').value   || '').trim();
  const notes = (qs('ie-notes').value || '').trim();

  if (!date)         { toast('Selecciona una fecha', 'err'); return }
  if (!hrs && !mins) { toast('Ingresa las horas o los minutos', 'err'); return }
  if (!act)          { toast('Describe la actividad realizada', 'err'); return }
  if (!S.currentPid) { toast('Error: sin colaborador seleccionado', 'err'); return }

  try {
    await db.collection('employees').doc(S.currentPid)
      .collection('entries').doc(uid()).set({
        type: S.entryType,
        date, hours: hrs + mins/60,
        activity: act, notes,
        createdAt: new Date().toISOString()
      });
    closeModals();
    toast(S.entryType==='extra' ? 'Horas extra registradas ⬆' : 'Reposición registrada ⬇');
  } catch (err) {
    console.error('doSaveEntry:', err);
    toast('Error al guardar: ' + (err.message || ''), 'err');
  }
}

async function doDeleteEntry(eid) {
  if (!confirm('¿Eliminar este registro?')) return;
  if (!S.currentPid) return;
  try {
    await db.collection('employees').doc(S.currentPid).collection('entries').doc(eid).delete();
    toast('Registro eliminado');
  } catch (err) {
    console.error('doDeleteEntry:', err);
    toast('Error al eliminar', 'err');
  }
}

/* ════════════════════════════════════════════════════
   RESUMEN GENERAL (solo admin)
   ════════════════════════════════════════════════════ */
async function openSummary() {
  if (!S.session?.isAdmin) return;
  openModal('m-sum');
  const sc = qs('sum-content'); if (!sc) return;
  sc.innerHTML = '<div class="loading"><div class="spinner"></div> Calculando resumen…</div>';

  const ids = Object.keys(S.employees);
  if (!ids.length) {
    sc.innerHTML = '<p style="text-align:center;color:var(--txt3);padding:28px">Sin colaboradores registrados.</p>';
    return;
  }

  try {
    const rows = await Promise.all(ids.map(async id => {
      const p    = S.employees[id];
      const snap = await db.collection('employees').doc(id).collection('entries').get();
      const ents = snap.docs.map(d => d.data());
      const { extra, recovery, balance } = calcStats(ents);
      const pct  = extra > 0 ? Math.min(Math.round((recovery/extra)*100), 100) : (recovery>0?100:0);
      return { id, p, extra, recovery, balance, pct, count: ents.length };
    }));

    const te = rows.reduce((s,r)=>s+r.extra,    0);
    const tr = rows.reduce((s,r)=>s+r.recovery,  0);
    const tb = te - tr;

    sc.innerHTML = `
      <div class="sum-totals">
        <div class="sum-total"><div class="sum-total-val" style="color:var(--coral)">${fmtH(te)}</div><div class="sum-total-lbl">Total Extra</div></div>
        <div class="sum-total"><div class="sum-total-val" style="color:var(--teal)">${fmtH(tr)}</div><div class="sum-total-lbl">Total Repuesto</div></div>
        <div class="sum-total"><div class="sum-total-val" style="color:${tb>0?'var(--coral)':tb<0?'var(--gold)':'var(--teal)'}">${fmtH(Math.abs(tb))}</div><div class="sum-total-lbl">${tb>0?'Pendiente':tb<0?'A Favor':'Al Día ✓'}</div></div>
      </div>
      <div class="divider"></div>
      <div class="sum-rows">
        ${[...rows].sort((a,b)=>b.balance-a.balance).map(r => {
          const clr = r.balance>0?'var(--coral)':r.balance<0?'var(--gold)':'var(--teal)';
          const st  = r.balance>0?`⚠ ${fmtH(r.balance)} pend.`:r.balance<0?`🏆 ${fmtH(-r.balance)} favor`:'✅ Al día';
          return `
            <div class="sum-row" onclick="selectPerson('${r.id}');closeModals()">
              <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
                <div class="avatar" style="background:${r.p.color};box-shadow:0 0 10px ${r.p.color}44">${ini(r.p.name)}</div>
                <div style="flex:1;min-width:0">
                  <div style="font-weight:600;font-size:.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.p.name}</div>
                  <div class="sum-prog"><div class="sum-prog-bar" style="width:${r.pct}%;background:${r.p.color}"></div></div>
                  <div style="font-size:.68rem;color:var(--txt3)">${r.pct}% repuesto · ${r.count} registro${r.count!==1?'s':''}</div>
                </div>
              </div>
              <div class="sum-stats">
                <div class="sum-stat"><div class="sum-stat-val" style="color:var(--coral)">+${fmtH(r.extra)}</div><div class="sum-stat-lbl">Extra</div></div>
                <div class="sum-stat"><div class="sum-stat-val" style="color:var(--teal)">-${fmtH(r.recovery)}</div><div class="sum-stat-lbl">Repuesto</div></div>
                <div class="sum-stat"><div class="sum-stat-val" style="color:${clr};font-size:.76rem">${st}</div><div class="sum-stat-lbl">Estado</div></div>
              </div>
            </div>`;
        }).join('')}
      </div>
      <div class="divider"></div>
      <button class="btn btn-ghost btn-sm" style="width:100%;justify-content:center" onclick="openChangePw('__admin__',true)">
        🔑 Cambiar contraseña del Administrador
      </button>`;
  } catch (err) {
    console.error('openSummary:', err);
    sc.innerHTML = '<p style="color:var(--coral);text-align:center;padding:20px">Error al cargar datos del resumen.</p>';
  }
}

/* ════════════════════════════════════════════════════
   UI HELPERS
   ════════════════════════════════════════════════════ */
function buildColorPicker() {
  const cp = qs('cp'); if (!cp) return;
  cp.innerHTML = COLORS.map(c =>
    `<div class="color-opt${c===S.pickedColor?' sel':''}" style="background:${c}" onclick="pickColor('${c}')"></div>`
  ).join('');
}
function pickColor(c) { S.pickedColor = c; buildColorPicker() }

function openModal(id) {
  closeModals();
  const el = qs(id); if (el) el.style.display = 'flex';
}
function closeModals() {
  ['m-emp','m-entry','m-pw','m-sum'].forEach(id => {
    const el = qs(id); if (el) el.style.display = 'none';
  });
}

function toggleDrawer() { S.drawerOpen ? closeDrawer() : openDrawer() }
function openDrawer() {
  S.drawerOpen = true;
  const sb = qs('sidebar');
  const ov = qs('drawer-overlay');
  if (sb) sb.classList.add('open');
  if (ov) ov.classList.add('visible');
  document.body.style.overflow = 'hidden';
}
function closeDrawer() {
  S.drawerOpen = false;
  const sb = qs('sidebar');
  const ov = qs('drawer-overlay');
  if (sb) sb.classList.remove('open');
  if (ov) ov.classList.remove('visible');
  document.body.style.overflow = '';
}

/* ════════════════════════════════════════════════════
   EVENTOS GLOBALES
   ════════════════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModals(); if (S.drawerOpen) closeDrawer() }
});
document.addEventListener('click', e => {
  if (e.target.classList.contains('overlay')) closeModals();
});

/* ════════════════════════════════════════════════════
   ARRANCAR
   ════════════════════════════════════════════════════ */
init();

/* =====================================================================
 *  Healthcare Initiatives Board — app.js (frontend)
 *  Vanilla JS single-page app. Talks to the Apps Script web app with
 *  simple text/plain POST requests (no CORS pre-flight).
 * ===================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------
   *  Constants & state
   * ---------------------------------------------------------------- */
  const CFG = Object.assign({ API_URL: '', GOOGLE_CLIENT_ID: '' }, window.HIB_CONFIG || {});
  const STATUSES = ['Not Started', 'In Progress', 'Blocked', 'Under Review', 'Completed', 'Cancelled'];
  const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];
  const STAGES = ['Under Design', 'Build', 'Live', 'Parked', 'Completed'];
  const PROJECT_STATUSES = ['Planning', 'Active', 'On Hold', 'Completed', 'Cancelled'];
  const ROLES = ['Admin', 'Manager', 'Member', 'Viewer'];
  const STATUS_COLORS = { 'Not Started': '#94A3B8', 'In Progress': '#2563EB', 'Blocked': '#DC2626', 'Under Review': '#D97706', 'Completed': '#16A34A', 'Cancelled': '#CBD5E1' };
  const PRIORITY_COLORS = { Critical: '#991B1B', High: '#EA580C', Medium: '#2556A0', Low: '#94A3B8' };
  const AVATAR_COLORS = ['#1B4079', '#0D9488', '#7C3AED', '#B45309', '#BE123C', '#0369A1', '#4D7C0F', '#9333EA', '#0F766E', '#C2410C'];
  const READ_ACTIONS = new Set(['bootstrap', 'sync', 'getTask', 'getActivity', 'ping', 'config']);
  const AUTH_ERRORS = new Set(['AUTH_EXPIRED', 'AUTH_REQUIRED', 'UNAUTHORIZED', 'AUTH_INVALID']);
  const PAGE_SIZES = [25, 50, 100];
  const VERSION = '1.7.0'; // must match CONFIG.APP_VERSION in Code.gs

  const defaultTaskFilter = () => ({ q: '', meeting: '', team: '', status: '', priority: '', assignee: '', initiative: '', project: '', category: '', due: '', archived: false, sort: 'DueDate', dir: 1, page: 1, size: 25 });

  const S = {
    token: null, expiresAt: null, me: null, rev: null,
    data: { tasks: [], initiatives: [], projects: [], users: [], commentStats: {}, recentComments: [], notifications: [], activity: [], settings: {} },
    userMap: {}, route: { view: '', id: '', q: {} },
    filters: {
      all: defaultTaskFilter(),
      my: Object.assign(defaultTaskFilter(), { tab: 'assigned' }),
      dash: { range: 'all', from: '', to: '', initiative: '', project: '', status: '', priority: '', assignee: '' },
      kanban: { q: '', initiative: '', assignee: '', priority: '' },
      ini: { scope: 'all', group: 'Stage', forum: '', flag: '', q: '' },
      act: { tab: 'discussions', type: '', q: '' },
      mtg: { mode: 'status', stage: 'Live', meeting: '', q: '' },
      settingsTab: 'profile'
    },
    cal: null, drawer: null, drafts: {}, syncing: false, saving: 0, pollTimer: null, lastSync: 0, syncFails: 0,
    pendingRender: false, authLost: false
  };

  /* ------------------------------------------------------------------
   *  Small utilities
   * ---------------------------------------------------------------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (n, cls) => `<svg class="ic ${cls || ''}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  const OPEN = (s) => s !== 'Completed' && s !== 'Cancelled';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  function tz() { return S.data.settings.TIMEZONE || undefined; }
  function ymdIn(date) {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); }
    catch (e) { return date.toISOString().slice(0, 10); }
  }
  const today = () => ymdIn(new Date());
  const isoToYmd = (iso) => (iso ? ymdIn(new Date(iso)) : '');
  function addDays(ymd, n) { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }
  function weekStart(ymd) { const d = new Date(ymd + 'T00:00:00Z'); return addDays(ymd, -((d.getUTCDay() + 6) % 7)); }
  function fmtDate(ymd, withYear) {
    if (!ymd) return '—';
    const d = new Date(ymd + 'T00:00:00Z');
    if (isNaN(d)) return esc(ymd);
    const y = withYear || ymd.slice(0, 4) !== today().slice(0, 4);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: y ? 'numeric' : undefined, timeZone: 'UTC' });
  }
  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: tz() });
  }
  function relTime(iso) {
    if (!iso) return '';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    if (s < 86400 * 7) return Math.round(s / 86400) + 'd ago';
    return fmtDate(isoToYmd(iso));
  }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
  /** Escape, linkify and highlight @mentions of known users. */
  function richText(body) {
    let h = linkify(esc(body));
    if (h.indexOf('@') < 0) return h;
    const names = S.data.users.map((u) => u.Name).filter(Boolean).sort((a, b) => b.length - a.length);
    names.forEach((n) => {
      const re = new RegExp('(^|[^\\w@])@(' + esc(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?![\\w])', 'gi');
      h = h.replace(re, (m, pre, name) => `${pre}<span class="mention">@${name}</span>`);
    });
    return h;
  }
  function linkify(escaped) { return escaped.replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`); }

  /* ------------------------------------------------------------------
   *  Domain helpers
   * ---------------------------------------------------------------- */
  const user = (email) => S.userMap[String(email || '').toLowerCase()] || { Email: email || '', Name: email ? email.split('@')[0] : 'Unassigned', Role: '', Active: false };
  const uname = (email) => (email ? user(email).Name : 'TBD');
  const teamOf = (t) => t.Team || (t.AssignedTo ? user(t.AssignedTo).Department || '' : '');
  const assigneeMatch = (t, a) => !a || (a === '__tbd__' ? !t.AssignedTo : t.AssignedTo === a);
  const isAdmin = () => S.me && S.me.role === 'Admin';
  const isManager = () => S.me && (S.me.role === 'Admin' || S.me.role === 'Manager');
  const canManageUser = (u) => isAdmin() || (isManager() && (!u || ['Member', 'Viewer'].includes(u.Role) || u.Email === S.me.email));
  const canCreateTask = () => S.me && S.me.role !== 'Viewer';
  const initiative = (id) => S.data.initiatives.find((i) => i.InitiativeID === id);
  const project = (id) => S.data.projects.find((p) => p.ProjectID === id);
  const taskById = (id) => S.data.tasks.find((t) => t.TaskID === id);
  const activeUsers = () => S.data.users.filter((u) => u.Active).sort((a, b) => a.Name.localeCompare(b.Name));
  const settingList = (k) => list(S.data.settings[k]);

  function canEditTask(t) {
    if (!S.me || !t) return false;
    if (isManager()) return true;
    if (S.me.role === 'Viewer') return false;
    const e = S.me.email;
    return t.CreatedBy === e || t.AssignedTo === e || list(t.Collaborators).includes(e);
  }
  const canArchiveTask = (t) => isManager() || (t && t.CreatedBy === S.me.email);
  const canEditOwned = (r) => isManager() || (r && r.Owner === S.me.email);

  const isOverdue = (t) => OPEN(t.Status) && t.DueDate && t.DueDate < today();
  const isDueToday = (t) => OPEN(t.Status) && t.DueDate === today();
  function isDueThisWeek(t) { if (!OPEN(t.Status) || !t.DueDate) return false; const s = weekStart(today()); return t.DueDate >= s && t.DueDate <= addDays(s, 6); }
  function openDeps(t) { return list(t.DependsOn).map(taskById).filter((d) => d && OPEN(d.Status)); }
  const effProgress = (t) => (t.Status === 'Completed' ? 100 : Number(t.Progress) || 0);

  /** Initiative / project progress = average progress of linked, non-archived, non-cancelled tasks (Completed = 100%). */
  function rollup(tasks) {
    const live = tasks.filter((t) => !t.Archived && t.Status !== 'Cancelled');
    const done = live.filter((t) => t.Status === 'Completed').length;
    const pct = live.length ? Math.round(live.reduce((a, t) => a + effProgress(t), 0) / live.length) : 0;
    return { pct, total: live.length, done, open: live.length - done, overdue: live.filter(isOverdue).length, blocked: live.filter((t) => t.Status === 'Blocked').length };
  }
  const initiativeStats = (id) => rollup(S.data.tasks.filter((t) => t.InitiativeID === id));
  const projectStats = (id) => rollup(S.data.tasks.filter((t) => t.ProjectID === id));

  /* ------------------------------------------------------------------
   *  UI atoms
   * ---------------------------------------------------------------- */
  function initials(name) { const p = String(name || '?').trim().split(/\s+/); return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); }
  function avatar(email, size) {
    const u = user(email);
    const c = AVATAR_COLORS[hash(u.Email || u.Name) % AVATAR_COLORS.length];
    const inner = u.Photo ? `<img src="${esc(u.Photo)}" alt="" referrerpolicy="no-referrer" loading="lazy" onerror="this.remove()">` : '';
    return `<span class="avatar ${size || ''}" style="background:${c}" title="${esc(u.Name)}">${esc(initials(u.Name))}${inner}</span>`;
  }
  /** Presence (admins & managers only): 'online' (used the board in the last 10 min), 'active' (has signed in), 'pending' (never signed in). */
  function presenceOf(u) {
    if (!u) return 'pending';
    if ((S.data.presence || {})[u.Email]) return 'online';
    return u.LastLogin ? 'active' : 'pending';
  }
  function presenceBadge(u) {
    const p = presenceOf(u);
    if (p === 'online') return '<span class="pres pres-online"><i></i>Online now</span>';
    if (p === 'active') return `<span class="pres pres-active"><i></i>Active · ${esc(relTime(u.LastSeen || u.LastLogin))}</span>`;
    return '<span class="pres pres-pending"><i></i>Not activated yet</span>';
  }
  const person = (email, size) => (email ? `<span class="person">${avatar(email, size || 'sm')}<span>${esc(uname(email))}</span></span>` : '<span class="tag tag-amber" title="Not assigned yet">TBD</span>');
  const statusBadge = (s) => `<span class="badge st-${slug(s)}">${esc(s)}</span>`;
  const prioBadge = (p) => `<span class="pr pr-${slug(p)}">${esc(p)}</span>`;
  const stageBadge = (s) => `<span class="stage stage-${slug(s)}">${esc(s)}</span>`;
  const progressBar = (p, done, lg) => `<div class="prog-row"><div class="progress ${done ? 'done' : ''} ${lg ? 'lg' : ''}"><i style="width:${Math.max(0, Math.min(100, p))}%"></i></div><span class="pct">${p}%</span></div>`;
  const opts = (arr, sel, placeholder) => (placeholder !== undefined ? `<option value="">${esc(placeholder)}</option>` : '') +
    arr.map((o) => { const v = typeof o === 'object' ? o.v : o; const l = typeof o === 'object' ? o.l : o; return `<option value="${esc(v)}" ${String(v) === String(sel) ? 'selected' : ''}>${esc(l)}</option>`; }).join('');
  const userOpts = (sel, placeholder) => opts(activeUsers().map((u) => ({ v: u.Email, l: u.Name })), sel, placeholder);
  const assigneeOpts = (sel, placeholder) => opts([{ v: '__tbd__', l: 'TBD (unassigned)' }].concat(activeUsers().map((u) => ({ v: u.Email, l: u.Name }))), sel, placeholder);
  const iniOpts = (sel, placeholder) => opts(S.data.initiatives.filter((i) => !i.Archived || i.InitiativeID === sel).map((i) => ({ v: i.InitiativeID, l: i.Name })), sel, placeholder);
  const prjOpts = (sel, placeholder, iniId) => opts(S.data.projects.filter((p) => (!p.Archived || p.ProjectID === sel) && (!iniId || !p.InitiativeID || p.InitiativeID === iniId)).map((p) => ({ v: p.ProjectID, l: p.Name })), sel, placeholder);
  function dueCell(t) {
    if (!t.DueDate) return '<span class="faint">—</span>';
    if (isOverdue(t)) { const d = daysBetween(t.DueDate, today()); return `<span class="due-overdue" title="Due ${fmtDate(t.DueDate, true)}">${d}d overdue</span>`; }
    if (isDueToday(t)) return '<span class="due-today">Today</span>';
    return `<span class="nowrap">${fmtDate(t.DueDate)}</span>`;
  }
  function commentBadge(t) {
    const st = S.data.commentStats[t.TaskID];
    if (!st || !st.count) return `<span class="comment-count faint">${icon('chat', 'ic-sm')}0</span>`;
    const isNew = hasNewComments(t.TaskID);
    const iss = st.openIssues ? `<span class="issue-pill" title="${plural(st.openIssues, 'open issue')}">${icon('alert', 'ic-sm')}${st.openIssues}</span>` : '';
    return `<span class="comment-count ${isNew ? 'new' : ''}" title="${isNew ? 'New comments' : plural(st.count, 'comment')}">${icon('chat', 'ic-sm')}${st.count}</span>${iss}`;
  }
  function emptyState(ic, title, text, action) {
    return `<div class="empty">${icon(ic)}<h3>${esc(title)}</h3><p>${esc(text)}</p>${action || ''}</div>`;
  }

  /* "New comment" tracking: last time *this browser* viewed each discussion (convenience only). */
  const seenKey = () => 'hib-seen:' + (S.me ? S.me.email : '');
  function hasNewComments(taskId) {
    const st = S.data.commentStats[taskId];
    if (!st || !st.lastAt || st.lastBy === (S.me && S.me.email)) return false;
    const seen = store.get(seenKey(), {})[taskId];
    return !seen || st.lastAt > seen;
  }
  function markSeen(taskId) { const m = store.get(seenKey(), {}); m[taskId] = new Date().toISOString(); store.set(seenKey(), m); }
  /** Remember the previous "seen" time so comments newer than it are highlighted as New, then mark as seen. */
  function enterDiscussion(taskId) { const m = store.get(seenKey(), {}); m[taskId + ':prev'] = m[taskId] || '1970-01-01T00:00:00.000Z'; m[taskId] = new Date().toISOString(); store.set(seenKey(), m); }

  /* ------------------------------------------------------------------
   *  Toasts, modals, confirm
   * ---------------------------------------------------------------- */
  function toast(msg, type, opt) {
    type = type || 'ok'; opt = opt || {};
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.setAttribute('role', type === 'err' ? 'alert' : 'status');
    el.innerHTML = icon(type === 'ok' ? 'check' : type === 'err' ? 'alert' : 'clock') + `<div>${esc(msg)}</div>` + (opt.action ? `<button>${esc(opt.action)}</button>` : '');
    if (opt.action) el.querySelector('button').onclick = () => { el.remove(); opt.onAction && opt.onAction(); };
    const box = $('#toasts');
    while (box.children.length >= 3) box.firstChild.remove();
    box.appendChild(el);
    setTimeout(() => el.remove(), opt.timeout || (type === 'err' ? 7000 : 3500));
  }
  function showError(e, prefix) { toast((prefix ? prefix + ': ' : '') + (e && e.message ? e.message : String(e)), 'err'); }

  const modalStack = [];
  function openModal(o) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal ${o.size || ''}" role="dialog" aria-modal="true" aria-label="${esc(o.title)}">
      <div class="modal-head"><h3>${esc(o.title)}</h3><button class="icon-btn sm" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="modal-body">${o.body}</div>${o.foot ? `<div class="modal-foot">${o.foot}</div>` : ''}</div>`;
    $('#modalRoot').appendChild(back);
    const m = {
      el: back,
      close() { const i = modalStack.indexOf(m); if (i >= 0) modalStack.splice(i, 1); back.remove(); o.onClose && o.onClose(); }
    };
    back.addEventListener('mousedown', (e) => { if (e.target === back && !o.sticky) m.close(); });
    back.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) { e.preventDefault(); m.close(); } });
    modalStack.push(m);
    setTimeout(() => { const f = back.querySelector('[autofocus], .modal-body input:not([type=hidden]):not([type=checkbox]), .modal-body textarea, .modal-body select'); if (f) f.focus(); }, 30);
    return m;
  }
  function confirmDialog(o) {
    return new Promise((resolve) => {
      let done = false;
      const m = openModal({
        title: o.title, size: 'sm',
        body: `<p>${esc(o.message)}</p>`,
        foot: `<button class="btn" data-close>${esc(o.cancelText || 'Cancel')}</button><button class="btn ${o.danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(o.confirmText || 'Confirm')}</button>`,
        onClose: () => { if (!done) resolve(false); }
      });
      m.el.querySelector('[data-ok]').onclick = () => { done = true; m.close(); resolve(true); };
    });
  }

  /* ------------------------------------------------------------------
   *  API layer (Apps Script web app)
   * ---------------------------------------------------------------- */
  class ApiError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } }

  async function api(action, payload) {
    const req = { action, payload: payload || {}, token: S.token };
    let res = null;
    if (!CFG.API_URL) throw new ApiError('CONFIG', 'The board is not connected yet: add your Apps Script web-app URL to API_URL in config.js.');
    if (useJsonp()) {
      try { res = await jsonp(req); }
      catch (e) { throw new ApiError('NETWORK', e.message); }
    } else {
      const tries = READ_ACTIONS.has(action) ? 3 : 1;
      let lastErr;
      for (let i = 0; i < tries && !res; i++) {
        try {
          const r = await fetch(CFG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(req), redirect: 'follow', cache: 'no-store' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const text = await r.text();
          try { res = JSON.parse(text); }
          catch (e) { throw new Error(/<html/i.test(text) ? 'The server returned a web page instead of data. Check that the Apps Script deployment access is set to "Anyone".' : 'Invalid response from server.'); }
        } catch (e) {
          lastErr = e;
          if (i < tries - 1) await sleep(700 * (i + 1));
        }
      }
      if (!res && lastErr && /fetch|network|load/i.test(lastErr.message)) {
        // Browser blocked the cross-site call (deployment limited to the company domain) → switch to the script-tag transport.
        try { res = await jsonp(req); S.transport = 'jsonp'; store.set('hib-transport', 'jsonp'); } catch (e) { lastErr = e; }
      }
      if (!res) throw new ApiError('NETWORK', 'Could not reach the server (' + (lastErr ? lastErr.message : 'network error') + '). Check your connection and try again.');
    }
    if (!res.ok) {
      const err = new ApiError(res.error.code, res.error.message, res.error.details);
      if (err.code === 'BUSY' && !READ_ACTIONS.has(action) && !payload.__retried) {
        await sleep(1200);
        return api(action, Object.assign({}, payload, { __retried: true }));
      }
      if (AUTH_ERRORS.has(err.code) && action !== 'login' && action !== 'config' && S.me) handleAuthLost(err);
      throw err;
    }
    return res.data;
  }

  /* Transport for web apps deployed as "Anyone within <domain>" (URL contains /a/macros/<domain>/):
   * the request is sent as a <script> GET, which carries the user's Google login and needs no CORS. */
  function useJsonp() { return S.transport === 'jsonp' || /\/a\/macros\//.test(CFG.API_URL) || store.get('hib-transport', '') === 'jsonp'; }
  let jsonpSeq = 0;
  function jsonp(req) {
    return new Promise((resolve, reject) => {
      const cb = '__hib' + Date.now().toString(36) + (jsonpSeq++);
      const el = document.createElement('script');
      const timer = setTimeout(() => { done(); reject(new Error('The server did not answer in time.')); }, 45000);
      function done() { clearTimeout(timer); try { delete window[cb]; } catch (e) { window[cb] = undefined; } el.remove(); }
      window[cb] = (data) => { done(); resolve(data); };
      el.onerror = () => { done(); reject(new Error('Could not load the board backend. Make sure you are signed in to your company Google account in this browser (open gmail.com to check), then try again.')); };
      el.src = CFG.API_URL + (CFG.API_URL.includes('?') ? '&' : '?') + 'callback=' + cb + '&p=' + encodeURIComponent(JSON.stringify(req));
      document.head.appendChild(el);
    });
  }

  /** Writes: shows saving state, triggers a background sync afterwards. */
  async function write(action, payload) {
    S.saving++;
    setSync('busy', 'Saving…');
    try {
      return await api(action, payload);
    } finally {
      S.saving--;
      setTimeout(() => sync(), 60);
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }

  /* ------------------------------------------------------------------
   *  Session & authentication
   * ---------------------------------------------------------------- */
  const sessionKey = () => 'hib-session';
  function saveSession(d) { S.token = d.token; S.expiresAt = d.expiresAt; store.set(sessionKey(), { token: d.token, expiresAt: d.expiresAt }); }
  function loadSession() { const s = store.get(sessionKey(), null); if (s && s.token && new Date(s.expiresAt) > new Date()) return s; store.del(sessionKey()); return null; }
  function clearSession() { S.token = null; store.del(sessionKey()); }

  function handleAuthLost(err) {
    if (S.authLost) return;
    S.authLost = true;
    stopPolling();
    clearSession();
    closeDrawer(true);
    modalStack.slice().forEach((m) => m.close());
    showLogin(err.code === 'UNAUTHORIZED' ? err.message : 'Your session has ended. Please sign in again.');
  }

  function bootMsg(t) { $('#bootMsg').textContent = t; }
  function loginMsg(text, kind) {
    const el = $('#loginMsg');
    if (!text) { el.hidden = true; return; }
    el.hidden = false; el.className = 'login-msg' + (kind === 'info' ? ' info' : ''); el.textContent = text;
  }

  async function showLogin(message) {
    $('#boot').hidden = true; $('#shell').hidden = true; $('#login').hidden = false;
    const body = $('#loginBody');
    body.innerHTML = '<div class="loading-row"><div class="spinner dark sm"></div>Connecting to the board…</div>';
    loginMsg(message || '', message ? 'err' : '');
    let cfg;
    try { cfg = await api('config'); }
    catch (e) {
      body.innerHTML = `<div class="login-option"><button class="btn btn-primary" data-action="retryLogin">${icon('refresh')}Try again</button></div>`;
      if (!CFG.API_URL) { body.innerHTML = ''; loginMsg('Setup needed: paste your Apps Script web-app URL into API_URL in config.js (see README, step 2).', 'info'); return; }
      loginMsg(CFG.API_URL ? 'Cannot reach the board backend. Check API_URL in config.js and that the Apps Script web app is deployed with access "Anyone". (' + e.message + ')' : e.message);
      return;
    }
    if (cfg.appName) { $('#loginTitle').textContent = cfg.appName; document.title = cfg.appName; }
    if (cfg.orgName) $('#loginOrg').textContent = cfg.orgName;
    if (cfg.setupRequired) {
      body.innerHTML = '';
      loginMsg('The spreadsheet has not been initialised yet. Open the Apps Script editor and run setupHealthcareBoard() once. (' + cfg.message + ')');
      return;
    }
    const parts = [];
    if (cfg.authMode === 'google' || CFG.GOOGLE_CLIENT_ID) {
      parts.push(CFG.GOOGLE_CLIENT_ID
        ? '<div class="login-option"><div id="gsiBtn" style="min-height:44px"></div></div>'
        : '<div class="warn-box">Google sign-in is not configured: add your OAuth client ID to <code>config.js</code> (GOOGLE_CLIENT_ID).</div>');
    }
    if (cfg.authMode === 'test') {
      parts.push(`${parts.length ? '<div class="login-divider">or, while testing</div>' : ''}
        <form class="login-option" data-form="testLogin">
          <div class="warn-box"><b>Test sign-in mode is on.</b> Identities are not verified — anyone who knows a listed email can sign in. Switch <b>AUTH_MODE</b> to <b>google</b> in the Settings sheet before rolling out.</div>
          <div class="field"><label for="testEmail">Work email (must be listed in the Users tab)</label><input class="input" id="testEmail" type="email" required placeholder="name@justlife.com" autocomplete="email"></div>
          <button class="btn btn-primary" type="submit">Continue</button>
        </form>`);
    }
    body.innerHTML = parts.join('');
    if (CFG.GOOGLE_CLIENT_ID && $('#gsiBtn')) initGoogle().catch((e) => loginMsg('Google sign-in could not load: ' + e.message));
  }

  async function initGoogle() {
    if (!window.google || !google.accounts) await loadScript('https://accounts.google.com/gsi/client');
    google.accounts.id.initialize({ client_id: CFG.GOOGLE_CLIENT_ID, callback: onGoogleCredential, auto_select: true, cancel_on_tap_outside: false, use_fedcm_for_prompt: true });
    google.accounts.id.renderButton($('#gsiBtn'), { theme: 'filled_blue', size: 'large', text: 'signin_with', shape: 'rectangular', width: 320, logo_alignment: 'left' });
    google.accounts.id.prompt();
  }

  async function onGoogleCredential(resp) {
    loginMsg('Verifying your Google account…', 'info');
    try { await completeLogin({ idToken: resp.credential }); }
    catch (e) { loginMsg(e.message); }
  }

  async function completeLogin(payload) {
    const d = await api('login', payload);
    saveSession(d);
    S.authLost = false;
    await loadAll();
    enterApp();
    if (d.firstLogin) toast(`Welcome, ${String(d.user.Name).split(' ')[0]}! Your profile is now active.`, 'ok', { timeout: 6000 });
  }

  /** New people pick their team once (BD / Marketing …). */
  function askTeam() {
    const teams = settingList('DEPARTMENTS');
    if (!S.me || !teams.length || user(S.me.email).Department || S.askedTeam) return;
    S.askedTeam = true;
    const m = openModal({
      title: 'Which team are you in?', size: 'sm', sticky: true,
      body: `<p class="muted">Pick your team so your tasks and name appear in the right group. An admin can change it later.</p>
        <div class="team-pick mt-16">${teams.map((t) => `<button class="team-option" data-team="${esc(t)}">${icon('team')}<b>${esc(t)}</b></button>`).join('')}</div>`,
      foot: '<button class="btn btn-ghost" data-close>Later</button>'
    });
    m.el.querySelectorAll('[data-team]').forEach((b) => {
      b.onclick = async () => {
        m.el.querySelectorAll('[data-team]').forEach((x) => { x.disabled = true; });
        try { const r = await write('setMyTeam', { team: b.dataset.team }); upsert('users', r.user); m.close(); toast(`You joined ${b.dataset.team}`); rerender(); }
        catch (e) { showError(e, 'Not saved'); m.el.querySelectorAll('[data-team]').forEach((x) => { x.disabled = false; }); }
      };
    });
  }

  async function signOut() {
    try { if (S.token) await api('logout'); } catch (e) { /* ignore */ }
    try { if (window.google && google.accounts) google.accounts.id.disableAutoSelect(); } catch (e) { /* ignore */ }
    stopPolling(); clearSession(); closeDrawer(true);
    S.me = null;
    showLogin();
  }

  /* ------------------------------------------------------------------
   *  Data loading & synchronisation (polling)
   * ---------------------------------------------------------------- */
  async function loadAll() { applyData(await api('bootstrap')); checkNewNotifications(true); }

  /* ------------------------------------------------------------------
   *  Popups: in-app card + desktop (browser) notification for new alerts
   * ---------------------------------------------------------------- */
  const NOTIF_TITLES = { MENTION: 'You were tagged', ISSUE: '⚠ Issue reported', NOTE: 'New note / instruction', ASSIGNED: 'New task for you', REASSIGNED: 'Task reassigned',
    REPLY: 'New reply', COMMENT: 'New comment', RESOLVED: 'Issue resolved', NOT_STARTED: '⏰ Deadline near — not started', DUE_SOON: 'Due soon', OVERDUE: 'Task overdue', BLOCKED: 'Task blocked', COMPLETED: 'Task completed' };
  const notifKey = () => 'hib-notif-known:' + (S.me ? S.me.email : '');
  const desktopSupported = () => 'Notification' in window;
  function checkNewNotifications(initial) {
    if (!S.me) return;
    const known = new Set(store.get(notifKey(), []));
    const firstTime = !store.get(notifKey(), null);
    store.set(notifKey(), S.data.notifications.map((n) => n.NotificationID).slice(0, 400));
    const fresh = S.data.notifications.filter((n) => !n.Read && !known.has(n.NotificationID));
    if (!fresh.length) return;
    if (!firstTime && initial && fresh.length > 3) { toast(`While you were away: ${plural(fresh.length, 'new notification')}`, 'warn', { action: 'View', onAction: () => ACTIONS.toggleNotifications() }); return; }
    if (firstTime) { if (fresh.length) setTimeout(() => toast(`You have ${plural(fresh.length, 'unread notification')}`, 'warn', { action: 'View', onAction: () => ACTIONS.toggleNotifications() }), 800); return; }
    fresh.slice(0, 3).reverse().forEach(showPopup);
    if (fresh.length > 3) toast(`+${fresh.length - 3} more notifications`, 'warn', { action: 'View', onAction: () => ACTIONS.toggleNotifications() });
  }
  function openNotif(n) { if (!n.Read) markRead([n.NotificationID]); if (n.EntityType === 'Task') navTask(n.EntityID, /COMMENT|REPLY|MENTION|ISSUE|NOTE|RESOLVED/.test(n.Type) ? 'discussion' : 'details'); }
  function showPopup(n) {
    const title = NOTIF_TITLES[n.Type] || 'Notification';
    // 1) In-app popup card
    const box = $('#popups');
    const el = document.createElement('div');
    el.className = 'popup-card ' + (/ISSUE|OVERDUE|BLOCKED/.test(n.Type) ? 'p-red' : /NOT_STARTED|DUE_SOON/.test(n.Type) ? 'p-amber' : '');
    el.setAttribute('role', 'alert');
    el.innerHTML = `${n.Actor ? avatar(n.Actor) : `<img src="logo.png" alt="" class="popup-logo">`}<div class="popup-body"><b>${esc(title)}</b><p>${esc(n.Message)}</p><div class="row mt-8"><button class="btn btn-sm btn-primary" data-open>Open</button><button class="btn btn-sm btn-ghost" data-dismiss>Dismiss</button></div></div>`;
    el.querySelector('[data-open]').onclick = () => { el.remove(); openNotif(n); };
    el.querySelector('[data-dismiss]').onclick = () => el.remove();
    while (box.children.length >= 3) box.firstChild.remove();
    box.appendChild(el);
    setTimeout(() => el.remove(), 12000);
    // 2) Desktop notification (Windows / macOS notification centre)
    if (desktopSupported() && Notification.permission === 'granted') {
      try {
        const dn = new Notification(title, { body: n.Message, icon: 'logo.png', badge: 'logo.png', tag: n.NotificationID, requireInteraction: /MENTION|ISSUE/.test(n.Type) });
        dn.onclick = () => { window.focus(); openNotif(n); dn.close(); };
      } catch (e) { /* some browsers only allow notifications from a service worker */ }
    }
  }
  async function enableDesktop() {
    if (!desktopSupported()) return toast('This browser does not support desktop notifications.', 'warn');
    const p = await Notification.requestPermission();
    store.set('hib-desktop-asked', 1);
    $$('.desktop-prompt').forEach((x) => x.remove());
    if (p === 'granted') { toast('Desktop popups are on'); try { new Notification('Desktop popups are on', { body: 'You will see a popup when someone tags you or assigns you work.', icon: 'logo.png' }); } catch (e) { /* ignore */ } }
    else toast('Desktop popups are blocked. Click the 🔒 icon next to the address bar to allow notifications.', 'warn', { timeout: 9000 });
    if (!$('#notifPop').hidden) renderNotifications();
  }
  function maybeAskDesktop() {
    if (!desktopSupported() || Notification.permission !== 'default' || store.get('hib-desktop-asked', 0)) return;
    const el = document.createElement('div');
    el.className = 'popup-card desktop-prompt';
    el.innerHTML = `<img src="logo.png" alt="" class="popup-logo"><div class="popup-body"><b>Get a popup on your computer</b><p>See a desktop notification when someone tags you, assigns you a task or reports an issue — even when this tab is in the background.</p><div class="row mt-8"><button class="btn btn-sm btn-primary" data-on>Turn on</button><button class="btn btn-sm btn-ghost" data-off>Not now</button></div></div>`;
    el.querySelector('[data-on]').onclick = enableDesktop;
    el.querySelector('[data-off]').onclick = () => { store.set('hib-desktop-asked', 1); el.remove(); };
    $('#popups').appendChild(el);
  }

  function applyData(d) {
    S.rev = d.rev;
    S.serverVersion = d.version || 'old';
    S.me = d.me;
    S.data = {
      tasks: d.tasks || [], initiatives: d.initiatives || [], projects: d.projects || [], users: d.users || [],
      presence: d.presence || {}, commentStats: d.commentStats || {}, recentComments: d.recentComments || [], notifications: d.notifications || [],
      activity: d.activity || [], settings: d.settings || {}
    };
    S.userMap = {};
    S.data.users.forEach((u) => { S.userMap[u.Email] = u; });
    S.lastSync = Date.now();
  }

  function setSync(state, text) {
    const el = $('#syncState');
    if (!el) return;
    el.className = 'sync ' + state;
    el.querySelector('.sync-text').textContent = text;
  }
  function syncIdleText() { return 'Synced ' + new Date(S.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

  async function sync(force) {
    if (!S.token) return;
    if (S.syncing) { S.syncQueued = true; return; }
    S.syncing = true;
    if (!S.saving) setSync('busy', 'Syncing…');
    try {
      const d = await api('sync', { rev: force ? null : S.rev });
      if (d.changed) { applyData(d); rerender(); updateBanner(); checkNewNotifications(false); }
      S.lastSync = Date.now(); S.syncFails = 0;
      if (!S.saving) setSync('ok', syncIdleText());
      $('#banner').classList.contains('err') && updateBanner();
    } catch (e) {
      if (AUTH_ERRORS.has(e.code)) return;
      S.syncFails++;
      setSync('err', 'Sync failed — retrying');
      if (S.syncFails === 3) updateBanner('Connection problem: changes from your team may not be showing. ' + e.message);
    } finally {
      S.syncing = false;
      if (S.syncQueued) { S.syncQueued = false; setTimeout(() => sync(), 50); }
    }
  }

  function startPolling() {
    stopPolling();
    const sec = Math.max(15, Number(S.data.settings.POLL_SECONDS) || 30);
    S.pollSec = sec;
    S.pollTimer = setInterval(() => { if (document.visibilityState === 'visible') sync(); }, sec * 1000);
  }
  function stopPolling() { if (S.pollTimer) clearInterval(S.pollTimer); S.pollTimer = null; }

  /** Re-render after new data, without destroying what the user is typing. */
  function rerender() {
    updateChrome();
    const a = document.activeElement;
    const typing = a && $('#view').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName);
    if (typing) S.pendingRender = true; else renderView();
    if (S.drawer) refreshDrawerFromData();
    if (S.pollSec && Math.max(15, Number(S.data.settings.POLL_SECONDS) || 30) !== S.pollSec) startPolling();
  }

  function upsert(kind, rec) {
    const key = { tasks: 'TaskID', initiatives: 'InitiativeID', projects: 'ProjectID', users: 'Email' }[kind];
    const arr = S.data[kind];
    const i = arr.findIndex((x) => x[key] === rec[key]);
    if (i >= 0) arr[i] = rec; else arr.push(rec);
    if (kind === 'users') S.userMap[rec.Email] = rec;
  }

  /* ------------------------------------------------------------------
   *  App shell, banner, router
   * ---------------------------------------------------------------- */
  function enterApp() {
    $('#boot').hidden = true; $('#login').hidden = true; $('#shell').hidden = false;
    S.authLost = false;
    updateChrome();
    updateBanner();
    $('#versionInfo').textContent = 'v' + VERSION;
    setSync('ok', syncIdleText());
    if (!location.hash) location.hash = '#/dashboard';
    route(true);
    startPolling();
    setTimeout(askTeam, 400);
    setTimeout(maybeAskDesktop, 2500);
  }

  function updateBanner(errorText) {
    const b = $('#banner');
    if (!errorText && S.serverVersion && S.serverVersion !== VERSION) {
      b.hidden = false; b.className = 'banner err';
      b.innerHTML = icon('alert') + `<span><b>The server script is out of date</b> (server ${esc(S.serverVersion === 'old' ? 'older than 1.7' : 'v' + S.serverVersion)}, website v${VERSION}). Some changes, such as Stage and Meeting, will not be saved. ${isAdmin() ? 'Fix: in Apps Script paste the latest Code.gs, then <b>Deploy ▸ Manage deployments ▸ ✏ Edit ▸ Version: New version ▸ Deploy</b>.' : 'Please tell an administrator.'}</span>`;
      return;
    }
    if (errorText) {
      b.hidden = false; b.className = 'banner err';
      b.innerHTML = icon('alert') + `<span>${esc(errorText)}</span><button class="btn btn-sm" data-action="syncNow">${icon('refresh')}Retry</button>`;
    } else if (S.me && !S.me.verified) {
      b.hidden = false; b.className = 'banner test';
      b.innerHTML = icon('alert') + '<span><b>Test sign-in mode</b> — identities are not verified. Set AUTH_MODE to <b>google</b> in the Settings sheet before rolling out to the team.</span>';
    } else { b.hidden = true; }
  }

  function updateChrome() {
    const s = S.data.settings;
    $('#brandOrg').textContent = s.ORG_NAME || 'Healthcare';
    const unreadN = S.data.notifications.filter((n) => !n.Read).length;
    document.title = (unreadN ? '(' + unreadN + ') ' : '') + (s.APP_NAME || 'Healthcare Initiatives Board');
    $('#meBtn').innerHTML = avatar(S.me.email);
    const unread = S.data.notifications.filter((n) => !n.Read).length;
    const bc = $('#bellCount');
    bc.hidden = !unread; bc.textContent = unread > 99 ? '99+' : unread;
    const mine = S.data.tasks.filter((t) => !t.Archived && t.AssignedTo === S.me.email && OPEN(t.Status)).length;
    $('#navMyCount').textContent = mine || '';
    if (!$('#notifPop').hidden) renderNotifications();
  }

  const VIEW_TITLES = { meetings: 'Meeting board', dashboard: 'Overview', tasks: 'All tasks', my: 'My tasks', kanban: 'Kanban board', calendar: 'Calendar', initiatives: 'Initiatives', initiative: 'Initiative', projects: 'Projects', project: 'Project', activity: 'Discussions & activity', team: 'Team overview', settings: 'Settings' };

  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    const qi = h.indexOf('?');
    const path = qi >= 0 ? h.slice(0, qi) : h;
    const qs = qi >= 0 ? h.slice(qi + 1) : '';
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    let view = parts[0] || 'dashboard';
    const id = parts[1] || '';
    if (view === 'initiatives' && id) view = 'initiative';
    if (view === 'projects' && id) view = 'project';
    const q = {};
    new URLSearchParams(qs).forEach((v, k) => { q[k] = v; });
    return { view, id, q, path };
  }

  function route(forceRender) {
    if (!S.me) return;
    const r = parseHash();
    if (!VIEWS[r.view]) { location.hash = '#/dashboard'; return; }
    const changed = forceRender || r.view !== S.route.view || r.id !== S.route.id;
    S.route = r;
    if (changed) { renderView(); window.scrollTo(0, 0); }
    $$('#nav a').forEach((a) => {
      const v = a.dataset.nav;
      a.classList.toggle('active', v === r.view || (v === 'initiatives' && r.view === 'initiative') || (v === 'projects' && r.view === 'project'));
    });
    $('#shell').classList.remove('nav-open');
    hidePopovers();
    if (r.q.task) { if (!S.drawer || S.drawer.id !== r.q.task) openDrawer(r.q.task, r.q.tab); }
    else if (S.drawer) closeDrawer(true);
  }

  function renderView() {
    S.pendingRender = false;
    const r = S.route;
    $('#pageTitle').textContent = VIEW_TITLES[r.view] || '';
    S.after = null;
    $('#view').innerHTML = VIEWS[r.view](r);
    if (S.after) S.after();
  }

  function go(hash) { location.hash = hash; }
  function navTask(id, tab) {
    const r = parseHash();
    const q = new URLSearchParams();
    Object.keys(r.q).forEach((k) => { if (k !== 'task' && k !== 'tab') q.set(k, r.q[k]); });
    if (id) { q.set('task', id); if (tab) q.set('tab', tab); }
    const qs = q.toString();
    location.hash = '#/' + (r.path || 'dashboard') + (qs ? '?' + qs : '');
  }

  /* ------------------------------------------------------------------
   *  Charts (dependency-free SVG/HTML)
   * ---------------------------------------------------------------- */
  function hbars(items, opt) {
    opt = opt || {};
    const max = Math.max(1, ...items.map((i) => i.value));
    if (!items.length) return emptyState('activity', 'No data', 'Nothing matches the current filters.');
    return `<div class="hbars">${items.map((i) => `<div class="hbar" ${i.action || ''} data-tip="${esc(i.label)}: ${i.value}">
      <span class="lab">${esc(i.label)}</span><span class="track"><i style="width:${(i.value / max) * 100}%;background:${i.color}"></i></span><span class="val">${i.value}</span></div>`).join('')}</div>`;
  }
  function stackedBars(rows, keys) {
    const max = Math.max(1, ...rows.map((r) => keys.reduce((a, k) => a + r[k.key], 0)));
    if (!rows.length) return emptyState('team', 'No assignments', 'No tasks match the current filters.');
    return `<div class="hbars">${rows.map((r) => {
      const total = keys.reduce((a, k) => a + r[k.key], 0);
      return `<div class="hbar" ${r.action || ''} data-tip="${esc(r.label)} — ${keys.map((k) => k.label + ': ' + r[k.key]).join(', ')}">
        <span class="lab">${esc(r.label)}</span><span class="track" style="width:${(total / max) * 100}%">${keys.map((k) => `<i style="width:${total ? (r[k.key] / total) * 100 : 0}%;background:${k.color}"></i>`).join('')}</span><span class="val">${total}</span></div>`;
    }).join('')}</div><div class="legend">${keys.map((k) => `<span><i style="background:${k.color}"></i>${esc(k.label)}</span>`).join('')}</div>`;
  }
  function vbars(items) {
    const max = Math.max(1, ...items.map((i) => i.value));
    return `<div class="vbars">${items.map((i) => `<div class="vbar" ${i.action || ''} data-tip="${esc(i.label)}: ${i.value}"><span class="v">${i.value}</span><div class="col" style="height:${Math.max(2, (i.value / max) * 130)}px;background:${i.color}"></div><span class="l">${esc(i.label)}</span></div>`).join('')}</div>`;
  }
  function lineChart(labels, series) {
    const W = 640, H = 220, pl = 32, pr = 12, pt = 14, pb = 28;
    const raw = Math.max(1, ...series.flatMap((s) => s.values));
    const step = Math.max(1, Math.ceil(raw / 4));
    const max = step * 4;
    const n = labels.length;
    const x = (i) => pl + (n === 1 ? 0 : (i * (W - pl - pr)) / (n - 1));
    const y = (v) => pt + (H - pt - pb) * (1 - v / max);
    let g = '';
    for (let k = 0; k <= 4; k++) { const v = step * k; g += `<line class="grid-line" x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/><text x="${pl - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`; }
    labels.forEach((l, i) => { if (n <= 8 || i % 2 === 0) g += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(l)}</text>`; });
    series.forEach((s) => {
      const d = s.values.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
      g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" ${s.dash ? 'stroke-dasharray="5 4"' : ''}/>`;
      s.values.forEach((v, i) => { g += `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="#fff" stroke="${s.color}" stroke-width="2" data-tip="${esc(s.name)} · week of ${esc(labels[i])}: ${v}"/>`; });
    });
    return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.name).join(' vs '))} per week">${g}</svg>
      <div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`;
  }

  /* ------------------------------------------------------------------
   *  VIEW: Overview dashboard
   * ---------------------------------------------------------------- */
  function dashTasks() {
    const f = S.filters.dash;
    const t0 = today(), ws = weekStart(t0);
    return S.data.tasks.filter((t) => {
      if (t.Archived) return false;
      if (f.initiative && t.InitiativeID !== f.initiative) return false;
      if (f.project && t.ProjectID !== f.project) return false;
      if (f.status && t.Status !== f.status) return false;
      if (f.priority && t.Priority !== f.priority) return false;
      if (!assigneeMatch(t, f.assignee)) return false;
      const due = t.DueDate;
      switch (f.range) {
        case 'week': return due >= ws && due <= addDays(ws, 6);
        case 'month': return due && due.slice(0, 7) === t0.slice(0, 7);
        case 'next30': return due >= t0 && due <= addDays(t0, 30);
        case 'last30': return due >= addDays(t0, -30) && due <= t0;
        case 'custom': return (!f.from || due >= f.from) && (!f.to || due <= f.to);
        default: return true;
      }
    });
  }

  function renderDashboard() {
    const f = S.filters.dash;
    const tasks = dashTasks();
    const open = tasks.filter((t) => OPEN(t.Status));
    const me = S.me.email;
    const k = {
      total: tasks.length,
      ns: tasks.filter((t) => t.Status === 'Not Started').length,
      ip: tasks.filter((t) => t.Status === 'In Progress').length,
      done: tasks.filter((t) => t.Status === 'Completed').length,
      overdue: tasks.filter(isOverdue).length,
      today: tasks.filter(isDueToday).length,
      week: tasks.filter(isDueThisWeek).length,
      high: open.filter((t) => t.Priority === 'Critical' || t.Priority === 'High').length,
      mine: open.filter((t) => t.AssignedTo === me).length
    };
    const rate = tasks.length ? Math.round((k.done / tasks.filter((t) => t.Status !== 'Cancelled').length || 0) * 100) : 0;
    const kpi = (label, value, color, preset, foot, ic) => `<button class="kpi" style="--kpi:${color}" data-action="kpi" data-preset='${esc(JSON.stringify(preset))}'>
      <span class="kpi-label">${ic ? icon(ic, 'ic-sm') : ''}${esc(label)}</span><span class="kpi-value">${value}</span>${foot ? `<span class="kpi-foot">${esc(foot)}</span>` : ''}</button>`;

    // Trend: last 8 weeks created vs completed
    const ws0 = weekStart(today());
    const weeks = Array.from({ length: 8 }, (_, i) => addDays(ws0, -7 * (7 - i)));
    const bucket = (ymd) => { if (!ymd) return -1; for (let i = 7; i >= 0; i--) { if (ymd >= weeks[i]) return ymd < addDays(weeks[i], 7) ? i : -1; } return -1; };
    const created = Array(8).fill(0), completed = Array(8).fill(0);
    tasks.forEach((t) => { const c = bucket(isoToYmd(t.CreatedAt)); if (c >= 0) created[c]++; const d = bucket(t.CompletedDate); if (d >= 0 && t.Status === 'Completed') completed[d]++; });

    // Workload
    const byUser = {};
    tasks.forEach((t) => {
      if (t.Status === 'Cancelled') return;
      const r = byUser[t.AssignedTo] || (byUser[t.AssignedTo] = { label: uname(t.AssignedTo), email: t.AssignedTo, done: 0, open: 0, late: 0 });
      if (t.Status === 'Completed') r.done++; else if (isOverdue(t)) r.late++; else r.open++;
    });
    const workload = Object.values(byUser).sort((a, b) => (b.open + b.late) - (a.open + a.late) || b.done - a.done).slice(0, 10)
      .map((r) => Object.assign(r, { action: `data-action="filterTasks" data-preset='${esc(JSON.stringify({ assignee: r.email }))}'` }));

    const overdueList = tasks.filter(isOverdue).sort((a, b) => a.DueDate.localeCompare(b.DueDate)).slice(0, 8);
    const attention = tasks.filter((t) => t.Status === 'Blocked' || t.Status === 'Under Review' || (OPEN(t.Status) && (openDeps(t).length || (S.data.commentStats[t.TaskID] || {}).openIssues)))
      .sort((a, b) => PRIORITIES.indexOf(a.Priority) - PRIORITIES.indexOf(b.Priority)).slice(0, 8);
    const inis = S.data.initiatives.filter((i) => !i.Archived && (!f.initiative || i.InitiativeID === f.initiative))
      .map((i) => Object.assign({ i }, initiativeStats(i.InitiativeID))).sort((a, b) => STAGES.indexOf(a.i.Stage) - STAGES.indexOf(b.i.Stage) || b.pct - a.pct);

    const filtersActive = f.range !== 'all' || f.initiative || f.project || f.status || f.priority || f.assignee;
    return `
    <div class="view-head">
      <div><h2>Good ${greeting()}, ${esc(String(S.me.name).split(' ')[0])}</h2>
        <p class="sub">${esc(S.data.settings.ORG_NAME || '')} · ${plural(k.total, 'task')} in view · ${rate}% completion rate · updated ${esc(relTime(new Date(S.lastSync).toISOString()))}</p></div>
      <div class="actions"><button class="btn" data-action="syncNow">${icon('refresh')}Refresh</button>${canCreateTask() ? `<button class="btn btn-primary" data-action="newTask">${icon('plus')}New task</button>` : ''}</div>
    </div>
    <div class="filters" role="group" aria-label="Dashboard filters">
      <span class="lbl-inline">${icon('calendar', 'ic-sm')}</span>
      <select class="select" data-change="dash" data-key="range" aria-label="Due date range">${opts([{ v: 'all', l: 'All due dates' }, { v: 'week', l: 'Due this week' }, { v: 'month', l: 'Due this month' }, { v: 'next30', l: 'Due next 30 days' }, { v: 'last30', l: 'Due last 30 days' }, { v: 'custom', l: 'Custom range…' }], f.range)}</select>
      ${f.range === 'custom' ? `<input class="input" type="date" data-change="dash" data-key="from" value="${esc(f.from)}" aria-label="From"><input class="input" type="date" data-change="dash" data-key="to" value="${esc(f.to)}" aria-label="To">` : ''}
      <select class="select" data-change="dash" data-key="initiative" aria-label="Initiative">${iniOpts(f.initiative, 'All initiatives')}</select>
      <select class="select" data-change="dash" data-key="project" aria-label="Project">${prjOpts(f.project, 'All projects', f.initiative)}</select>
      <select class="select" data-change="dash" data-key="status" aria-label="Status">${opts(STATUSES, f.status, 'All statuses')}</select>
      <select class="select" data-change="dash" data-key="priority" aria-label="Priority">${opts(PRIORITIES, f.priority, 'All priorities')}</select>
      <select class="select" data-change="dash" data-key="assignee" aria-label="Assignee">${assigneeOpts(f.assignee, 'All assignees')}</select>
      ${filtersActive ? `<button class="btn btn-ghost btn-sm" data-action="resetDash">${icon('x', 'ic-sm')}Clear</button>` : ''}
    </div>
    <div class="kpis">
      ${kpi('Total tasks', k.total, '#1B4079', {}, 'Excludes archived', 'tasks')}
      ${kpi('Not started', k.ns, STATUS_COLORS['Not Started'], { status: 'Not Started' })}
      ${kpi('In progress', k.ip, STATUS_COLORS['In Progress'], { status: 'In Progress' })}
      ${kpi('Completed', k.done, STATUS_COLORS.Completed, { status: 'Completed' })}
      ${kpi('Overdue', k.overdue, '#DC2626', { status: 'overdue' }, 'Past due & still open', 'alert')}
      ${kpi('Due today', k.today, '#D97706', { due: 'today' }, '', 'clock')}
      ${kpi('Due this week', k.week, '#0089C2', { due: 'week' }, 'Mon – Sun, open tasks')}
      ${kpi('High priority', k.high, '#EA580C', { priority: 'high+', status: 'open' }, 'Critical + High, open', 'flag')}
      ${kpi('Assigned to me', k.mine, '#7C3AED', { assignee: me, status: 'open' }, 'Open tasks', 'user')}
    </div>
    <div class="grid grid-2">
      <div class="card"><div class="card-head"><h3>Tasks by status</h3><span class="sub">${k.total} total</span></div><div class="card-body">
        ${hbars(STATUSES.map((s) => ({ label: s, value: tasks.filter((t) => t.Status === s).length, color: STATUS_COLORS[s], action: `data-action="filterTasks" data-preset='${esc(JSON.stringify({ status: s }))}'` })))}</div></div>
      <div class="card"><div class="card-head"><h3>Open tasks by priority</h3><span class="sub">${open.length} open</span></div><div class="card-body">
        ${vbars(PRIORITIES.map((p) => ({ label: p, value: open.filter((t) => t.Priority === p).length, color: PRIORITY_COLORS[p], action: `data-action="filterTasks" data-preset='${esc(JSON.stringify({ priority: p, status: 'open' }))}'` })))}</div></div>
    </div>
    <div class="grid grid-2-1 mt-16">
      <div class="card"><div class="card-head"><h3>Completion trend</h3><span class="sub">Tasks created vs completed per week (last 8 weeks)</span></div><div class="card-body">
        ${lineChart(weeks.map((w) => fmtDate(w)), [{ name: 'Created', color: '#94A3B8', values: created, dash: true }, { name: 'Completed', color: '#0089C2', values: completed }])}</div></div>
      <div class="card"><div class="card-head"><h3>Overdue tasks</h3><span class="sub">${k.overdue}</span>${k.overdue ? `<div class="actions"><button class="btn btn-sm btn-ghost" data-action="filterTasks" data-preset='${esc(JSON.stringify({ status: 'overdue' }))}'>View all</button></div>` : ''}</div>
        <div class="card-body flush">${overdueList.length ? `<div class="list">${overdueList.map((t) => `<div class="list-item" data-action="openTask" data-id="${esc(t.TaskID)}">${avatar(t.AssignedTo, 'sm')}<div class="grow"><span class="t">${esc(t.Title)}</span><span class="s">${esc(t.TaskID)} · ${esc(uname(t.AssignedTo))}</span></div>${dueCell(t)}</div>`).join('')}</div>` : emptyState('check', 'Nothing overdue', 'Every open task is on schedule.')}</div></div>
    </div>
    <div class="grid grid-2 mt-16">
      <div class="card"><div class="card-head"><h3>Workload by team member</h3><span class="sub">Top ${workload.length}</span></div><div class="card-body">
        ${stackedBars(workload, [{ key: 'late', label: 'Overdue', color: '#DC2626' }, { key: 'open', label: 'Open', color: '#2556A0' }, { key: 'done', label: 'Completed', color: '#16A34A' }])}</div></div>
      <div class="card"><div class="card-head"><h3>Initiative progress</h3><span class="sub">Average progress of linked tasks</span><div class="actions"><a class="btn btn-sm btn-ghost" href="#/initiatives">All initiatives</a></div></div>
        <div class="card-body flush">${inis.length ? `<div class="list">${inis.slice(0, 8).map((x) => `<div class="list-item" data-action="go" data-href="#/initiatives/${esc(x.i.InitiativeID)}">
          <div class="grow"><span class="t">${esc(x.i.Name)}</span><span class="s">${stageBadge(x.i.Stage)} &nbsp;${x.done}/${x.total} done${x.overdue ? ` · <span class="due-overdue">${x.overdue} overdue</span>` : ''}</span></div>
          <div style="width:150px">${progressBar(x.pct, x.pct === 100)}</div></div>`).join('')}</div>` : emptyState('target', 'No initiatives yet', 'Create an initiative to track portfolio progress.')}</div></div>
    </div>
    <div class="grid grid-2 mt-16">
      <div class="card"><div class="card-head"><h3>Blocked &amp; awaiting feedback</h3><span class="sub">${attention.length}</span></div>
        <div class="card-body flush">${attention.length ? `<div class="list">${attention.map((t) => { const deps = openDeps(t); return `<div class="list-item" data-action="openTask" data-id="${esc(t.TaskID)}">${avatar(t.AssignedTo, 'sm')}<div class="grow"><span class="t">${esc(t.Title)}</span><span class="s">${esc(t.TaskID)} · ${(S.data.commentStats[t.TaskID] || {}).openIssues ? '⚠ Issue reported — needs help' : t.Status === 'Under Review' ? 'Awaiting review / feedback' : t.Status === 'Blocked' ? 'Blocked' : 'Waiting on ' + deps.map((d) => d.TaskID).join(', ')}</span></div>${statusBadge(t.Status)}</div>`; }).join('')}</div>` : emptyState('check', 'Nothing blocked', 'No tasks are blocked or waiting for feedback.')}</div></div>
      <div class="card"><div class="card-head"><h3>Recent activity</h3><div class="actions"><a class="btn btn-sm btn-ghost" href="#/activity">View all</a></div></div>
        <div class="card-body flush">${feedHtml(S.data.activity.slice(0, 7))}</div></div>
    </div>`;
  }
  function greeting() { const h = new Date().getHours(); return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'; }

  /* ------------------------------------------------------------------
   *  VIEW: Task lists (All tasks / My tasks)
   * ---------------------------------------------------------------- */
  function filterTasks(f, base) {
    const q = (f.q || '').trim().toLowerCase();
    const t0 = today();
    return base.filter((t) => {
      if (f.archived === 'only') { if (!t.Archived) return false; } else if (!f.archived && t.Archived) return false;
      if (f.status) {
        if (f.status === 'open') { if (!OPEN(t.Status)) return false; }
        else if (f.status === 'overdue') { if (!isOverdue(t)) return false; }
        else if (t.Status !== f.status) return false;
      }
      if (f.priority) { if (f.priority === 'high+') { if (t.Priority !== 'Critical' && t.Priority !== 'High') return false; } else if (t.Priority !== f.priority) return false; }
      if (!assigneeMatch(t, f.assignee)) return false;
      if (f.team && teamOf(t) !== f.team) return false;
      if (f.initiative && t.InitiativeID !== f.initiative) return false;
      if (f.project && t.ProjectID !== f.project) return false;
      if (f.category && t.Category !== f.category) return false;
      if (f.meeting && (f.meeting === '__none__' ? t.Meeting : t.Meeting !== f.meeting)) return false;
      if (f.due === 'today' && !isDueToday(t)) return false;
      if (f.due === 'week' && !isDueThisWeek(t)) return false;
      if (f.due === 'next7' && !(OPEN(t.Status) && t.DueDate >= t0 && t.DueDate <= addDays(t0, 7))) return false;
      if (q) {
        const ini = initiative(t.InitiativeID);
        const hay = [t.TaskID, t.Title, t.Description, uname(t.AssignedTo), t.AssignedTo, ini ? ini.Name : '', t.Category, uname(t.CreatedBy)].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function sortTasks(rows, key, dir) {
    const val = (t) => {
      switch (key) {
        case 'Priority': return PRIORITIES.indexOf(t.Priority);
        case 'Status': return STATUSES.indexOf(t.Status);
        case 'AssignedTo': return uname(t.AssignedTo).toLowerCase();
        case 'DueDate': return t.DueDate || '9999';
        case 'Progress': return effProgress(t);
        case 'Comments': return (S.data.commentStats[t.TaskID] || {}).count || 0;
        case 'TaskID': return t.TaskID;
        case 'UpdatedAt': return t.UpdatedAt || '';
        default: return String(t[key] || '').toLowerCase();
      }
    };
    return rows.slice().sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir || a.TaskID.localeCompare(b.TaskID); });
  }

  function taskTable(rows, f, scope) {
    if (!rows.length) {
      return emptyState('tasks', 'No tasks found', f.q || f.status || f.priority || f.assignee || f.initiative || f.project || f.category || f.due ? 'Try clearing a filter or searching for something else.' : 'Create the first task to get started.',
        canCreateTask() ? `<button class="btn btn-primary" data-action="newTask">${icon('plus')}New task</button>` : '');
    }
    const sorted = sortTasks(rows, f.sort, f.dir);
    const pages = Math.max(1, Math.ceil(sorted.length / f.size));
    if (f.page > pages) f.page = pages;
    const pageRows = sorted.slice((f.page - 1) * f.size, f.page * f.size);
    const th = (key, label, cls) => `<th class="sortable ${cls || ''}" data-action="sort" data-scope="${scope}" data-key="${key}" aria-sort="${f.sort === key ? (f.dir > 0 ? 'ascending' : 'descending') : 'none'}">${label}${f.sort === key ? `<span class="arrow">${f.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`;
    return `<div class="table-wrap"><table class="tbl responsive">
      <thead><tr>${th('TaskID', 'ID', 'c-id')}${th('Title', 'Task')}${th('AssignedTo', 'Assignee')}${th('Priority', 'Priority')}${th('Status', 'Status')}${th('DueDate', 'Due')}${th('Progress', 'Progress', 'c-prog')}${th('Comments', '<span class="sr-only">Comments</span>' + icon('chat', 'ic-sm'))}<th class="c-cat"></th></tr></thead>
      <tbody>${pageRows.map((t) => {
        const ini = initiative(t.InitiativeID);
        const editable = canEditTask(t) && !t.Archived;
        const deps = openDeps(t);
        return `<tr class="${isOverdue(t) ? 'overdue' : ''} ${t.Archived ? 'archived' : ''}" data-action="openTask" data-id="${esc(t.TaskID)}">
          <td class="c-id"><span class="idtag">${esc(t.TaskID)}</span></td>
          <td class="title-cell"><span class="t">${esc(t.Title)}</span><span class="s">${ini ? esc(ini.Name) : esc(t.Category || 'No initiative')}${deps.length ? ` · <span class="tag tag-amber">Waiting on ${esc(deps[0].TaskID)}${deps.length > 1 ? ' +' + (deps.length - 1) : ''}</span>` : ''}${t.Archived ? ' · <span class="tag">Archived</span>' : ''}</span></td>
          <td>${person(t.AssignedTo)}</td>
          <td>${prioBadge(t.Priority)}</td>
          <td>${editable ? `<select class="select select-sm" data-change="quickStatus" data-id="${esc(t.TaskID)}" aria-label="Status of ${esc(t.TaskID)}">${opts(STATUSES, t.Status)}</select>` : statusBadge(t.Status)}</td>
          <td>${dueCell(t)}</td>
          <td class="c-prog" style="min-width:120px">${progressBar(effProgress(t), t.Status === 'Completed')}</td>
          <td>${commentBadge(t)}</td>
          <td class="row-actions c-cat">${canCreateTask() ? `<button class="icon-btn sm" data-action="duplicateTask" data-id="${esc(t.TaskID)}" title="Duplicate" aria-label="Duplicate">${icon('copy', 'ic-sm')}</button>` : ''}${canArchiveTask(t) ? `<button class="icon-btn sm" data-action="archiveTask" data-id="${esc(t.TaskID)}" title="${t.Archived ? 'Restore' : 'Archive'}" aria-label="${t.Archived ? 'Restore' : 'Archive'}">${icon(t.Archived ? 'refresh' : 'archive', 'ic-sm')}</button>` : ''}${isAdmin() ? `<button class="icon-btn sm danger-btn" data-action="deleteTask" data-id="${esc(t.TaskID)}" title="Delete permanently" aria-label="Delete">${icon('trash', 'ic-sm')}</button>` : ''}</td>
        </tr>`;
      }).join('')}</tbody></table></div>
      <div class="pager"><span>Showing ${(f.page - 1) * f.size + 1}–${Math.min(f.page * f.size, sorted.length)} of ${sorted.length}</span>
        <span class="spacer"></span>
        <label class="row">Rows <select class="select select-sm" style="width:auto" data-change="pageSize" data-scope="${scope}">${opts(PAGE_SIZES, f.size)}</select></label>
        <button class="btn btn-sm" data-action="page" data-scope="${scope}" data-dir="-1" ${f.page <= 1 ? 'disabled' : ''} aria-label="Previous page">${icon('left', 'ic-sm')}</button>
        <span>Page ${f.page} of ${pages}</span>
        <button class="btn btn-sm" data-action="page" data-scope="${scope}" data-dir="1" ${f.page >= pages ? 'disabled' : ''} aria-label="Next page">${icon('right', 'ic-sm')}</button></div>`;
  }

  function taskFilterBar(f, scope, opt) {
    opt = opt || {};
    const any = f.q || f.meeting || f.team || f.status || f.priority || f.assignee || f.initiative || f.project || f.category || f.due || f.archived;
    return `<div class="filters" role="group" aria-label="Task filters">
      <input class="input grow" type="search" placeholder="Search by title, ID, description or owner…" value="${esc(f.q)}" data-input="taskFilter" data-scope="${scope}" data-key="q" aria-label="Search tasks">
      <select class="select" data-change="taskFilter" data-scope="${scope}" data-key="status" aria-label="Status">${opts([{ v: 'open', l: 'All open' }, { v: 'overdue', l: 'Overdue' }].concat(STATUSES), f.status, 'All statuses')}</select>
      <select class="select" data-change="taskFilter" data-scope="${scope}" data-key="priority" aria-label="Priority">${opts([{ v: 'high+', l: 'Critical + High' }].concat(PRIORITIES), f.priority, 'All priorities')}</select>
      ${opt.noAssignee ? '' : `<select class="select" data-change="taskFilter" data-scope="${scope}" data-key="assignee" aria-label="Assignee">${assigneeOpts(f.assignee, 'All assignees')}</select>`}
      <select class="select" data-change="taskFilter" data-scope="${scope}" data-key="initiative" aria-label="Initiative">${iniOpts(f.initiative, 'All initiatives')}</select>
      <select class="select" data-change="taskFilter" data-scope="${scope}" data-key="project" aria-label="Project">${prjOpts(f.project, 'All projects', f.initiative)}</select>
      <select class="select" data-change="taskFilter" data-scope="${scope}" data-key="meeting" aria-label="Meeting">${opts(settingList('FORUMS').concat([{ v: '__none__', l: 'No meeting' }]), f.meeting, 'All meetings')}</select>
      <select class="select" data-change="taskFilter" data-scope="${scope}" data-key="category" aria-label="Category">${opts(settingList('CATEGORIES'), f.category, 'All categories')}</select>
      <select class="select" data-change="taskFilter" data-scope="${scope}" data-key="due" aria-label="Due">${opts([{ v: 'today', l: 'Due today' }, { v: 'week', l: 'Due this week' }, { v: 'next7', l: 'Due in next 7 days' }], f.due, 'Any due date')}</select>
      <label class="check"><input type="checkbox" data-change="taskFilter" data-scope="${scope}" data-key="archived" ${f.archived ? 'checked' : ''}>Show archived</label>
      ${any ? `<button class="btn btn-ghost btn-sm" data-action="resetTaskFilter" data-scope="${scope}">${icon('x', 'ic-sm')}Clear</button>` : ''}
    </div>`;
  }

  function renderAllTasks() {
    const f = S.filters.all;
    const rows = filterTasks(f, S.data.tasks);
    const live = S.data.tasks.filter((t) => !t.Archived);
    return `<div class="view-head"><div><h2>All tasks</h2><p class="sub">${plural(live.length, 'task')} · ${live.filter((t) => OPEN(t.Status)).length} open · ${live.filter(isOverdue).length} overdue</p></div>
      <div class="actions"><button class="btn" data-action="exportCsv" data-scope="all">${icon('download')}Export CSV</button>${canCreateTask() ? `<button class="btn btn-primary" data-action="newTask">${icon('plus')}New task</button>` : ''}</div></div>
      ${ownerChips(f)}
      ${taskFilterBar(f, 'all')}
      <div class="card" id="tableArea">${taskTable(rows, f, 'all')}</div>`;
  }

  /** Team rows of owner chips (e.g. "BD · All 32 | Nitish 9 | … | TBD 4"). Counts = open, non-archived tasks. */
  function ownerChips(f) {
    const teams = settingList('DEPARTMENTS');
    if (!teams.length) return '';
    const open = S.data.tasks.filter((t) => !t.Archived && OPEN(t.Status));
    const chip = (label, n, preset, on, tbd) => `<button class="owner-chip ${on ? 'on' : ''} ${tbd ? 'tbd' : ''}" data-action="ownerChip" data-preset='${esc(JSON.stringify(preset))}'><span>${esc(label)}</span><span class="n">${n}</span></button>`;
    return `<div class="owner-rows">${teams.map((team) => {
      const tt = open.filter((t) => teamOf(t) === team);
      const members = S.data.users.filter((u) => u.Active && u.Department === team); // Users-sheet order
      return `<div class="owner-row">${chip(team + ' · All', tt.length, { team }, f.team === team && !f.assignee)}${members.map((u) => chip(u.Name, tt.filter((t) => t.AssignedTo === u.Email).length, { team, assignee: u.Email }, f.team === team && f.assignee === u.Email)).join('')}${chip('TBD', tt.filter((t) => !t.AssignedTo).length, { team, assignee: '__tbd__' }, f.team === team && f.assignee === '__tbd__', true)}</div>`;
    }).join('')}</div>`;
  }

  function myBase(tab) {
    const e = S.me.email;
    return S.data.tasks.filter((t) => {
      if (tab === 'assigned') return t.AssignedTo === e;
      if (tab === 'collab') return list(t.Collaborators).includes(e);
      if (tab === 'created') return t.CreatedBy === e;
      return t.AssignedTo === e || list(t.Collaborators).includes(e);
    });
  }
  function renderMyTasks() {
    const f = S.filters.my;
    const base = myBase(f.tab);
    const mine = S.data.tasks.filter((t) => !t.Archived && t.AssignedTo === S.me.email);
    const count = (tab) => myBase(tab).filter((t) => !t.Archived && OPEN(t.Status)).length;
    return `<div class="view-head"><div><h2>My tasks</h2><p class="sub">${mine.filter((t) => OPEN(t.Status)).length} open · ${mine.filter(isOverdue).length} overdue · ${mine.filter(isDueThisWeek).length} due this week</p></div>
      <div class="actions">${canCreateTask() ? `<button class="btn btn-primary" data-action="newTask" data-assignee="${esc(S.me.email)}">${icon('plus')}New task</button>` : ''}</div></div>
      <div class="tabs" role="tablist">
        ${[['assigned', 'Assigned to me'], ['collab', 'Collaborating'], ['created', 'Created by me']].map(([k, l]) => `<button role="tab" class="${f.tab === k ? 'on' : ''}" data-action="myTab" data-tab="${k}">${l}<span class="pill-count">${count(k)}</span></button>`).join('')}
      </div>
      ${taskFilterBar(f, 'my', { noAssignee: f.tab === 'assigned' })}
      <div class="card" id="tableArea">${taskTable(filterTasks(f, base), f, 'my')}</div>`;
  }

  function refreshTable(scope) {
    const area = $('#tableArea');
    if (!area) return renderView();
    const f = S.filters[scope];
    const base = scope === 'my' ? myBase(f.tab) : S.data.tasks;
    area.innerHTML = taskTable(filterTasks(f, base), f, scope);
  }

  /* ------------------------------------------------------------------
   *  VIEW: Kanban
   * ---------------------------------------------------------------- */
  function renderKanban() {
    const f = S.filters.kanban;
    const q = f.q.trim().toLowerCase();
    const tasks = S.data.tasks.filter((t) => !t.Archived &&
      (!f.initiative || t.InitiativeID === f.initiative) && assigneeMatch(t, f.assignee) && (!f.priority || t.Priority === f.priority) &&
      (!q || (t.TaskID + ' ' + t.Title + ' ' + uname(t.AssignedTo)).toLowerCase().includes(q)));
    const card = (t) => {
      const draggable = canEditTask(t);
      return `<div class="kcard ${isOverdue(t) ? 'overdue' : ''}" data-action="openTask" data-id="${esc(t.TaskID)}" ${draggable ? 'draggable="true"' : ''} tabindex="0" aria-label="${esc(t.Title)}">
        <div class="meta"><span class="idtag">${esc(t.TaskID)}</span><span class="right">${prioBadge(t.Priority)}</span></div>
        <div class="t">${esc(t.Title)}</div>
        ${t.InitiativeID ? `<div class="meta">${icon('target', 'ic-sm')}${esc((initiative(t.InitiativeID) || {}).Name || '')}</div>` : ''}
        ${t.Status === 'In Progress' || t.Status === 'Under Review' ? progressBar(effProgress(t)) : ''}
        <div class="meta">${avatar(t.AssignedTo, 'sm')}<span>${dueCell(t)}</span><span class="right">${commentBadge(t)}</span></div></div>`;
    };
    S.after = bindKanban;
    return `<div class="view-head"><div><h2>Kanban board</h2><p class="sub">Drag a card to another column to change its status. Changes save to Google Sheets immediately.</p></div>
      <div class="actions">${canCreateTask() ? `<button class="btn btn-primary" data-action="newTask">${icon('plus')}New task</button>` : ''}</div></div>
      <div class="filters">
        <input class="input grow" type="search" placeholder="Filter cards…" value="${esc(f.q)}" data-input="kanbanFilter" data-key="q" aria-label="Filter cards">
        <select class="select" data-change="kanbanFilter" data-key="initiative" aria-label="Initiative">${iniOpts(f.initiative, 'All initiatives')}</select>
        <select class="select" data-change="kanbanFilter" data-key="assignee" aria-label="Assignee">${assigneeOpts(f.assignee, 'All assignees')}</select>
        <select class="select" data-change="kanbanFilter" data-key="priority" aria-label="Priority">${opts(PRIORITIES, f.priority, 'All priorities')}</select>
      </div>
      <div class="board" id="board">${STATUSES.map((s) => {
        const items = tasks.filter((t) => t.Status === s).sort((a, b) => PRIORITIES.indexOf(a.Priority) - PRIORITIES.indexOf(b.Priority) || (a.DueDate || '9').localeCompare(b.DueDate || '9'));
        return `<section class="col" aria-label="${esc(s)}"><div class="col-head"><span class="dot" style="background:${STATUS_COLORS[s]}"></span>${esc(s)}<span class="n">${items.length}</span></div>
          <div class="col-body" data-status="${esc(s)}">${items.map(card).join('') || '<div class="faint" style="text-align:center;padding:16px 0;font-size:12px">No tasks</div>'}</div></section>`;
      }).join('')}</div>`;
  }

  function bindKanban() {
    let dragId = null;
    $$('.kcard[draggable]').forEach((c) => {
      c.addEventListener('dragstart', (e) => { dragId = c.dataset.id; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); });
      c.addEventListener('dragend', () => { c.classList.remove('dragging'); $$('.col-body.drop').forEach((x) => x.classList.remove('drop')); });
    });
    $$('.col-body').forEach((col) => {
      col.addEventListener('dragover', (e) => { if (!dragId) return; e.preventDefault(); col.classList.add('drop'); });
      col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); });
      col.addEventListener('drop', (e) => { e.preventDefault(); col.classList.remove('drop'); const id = dragId || e.dataTransfer.getData('text/plain'); dragId = null; if (id) changeTaskField(id, { Status: col.dataset.status }, { optimistic: true }); });
    });
  }

  /* ------------------------------------------------------------------
   *  VIEW: Calendar
   * ---------------------------------------------------------------- */
  function renderCalendar() {
    if (!S.cal) { const t = today(); S.cal = { y: +t.slice(0, 4), m: +t.slice(5, 7) - 1, mine: false, initiative: '' }; }
    const c = S.cal;
    const first = `${c.y}-${String(c.m + 1).padStart(2, '0')}-01`;
    const start = weekStart(first);
    const nextMonth = c.m === 11 ? `${c.y + 1}-01-01` : `${c.y}-${String(c.m + 2).padStart(2, '0')}-01`;
    const lastDay = addDays(nextMonth, -1);
    const end = addDays(weekStart(lastDay), 6);
    const tasks = S.data.tasks.filter((t) => !t.Archived && t.DueDate && t.DueDate >= start && t.DueDate <= end &&
      (!c.mine || t.AssignedTo === S.me.email || list(t.Collaborators).includes(S.me.email)) && (!c.initiative || t.InitiativeID === c.initiative));
    const byDay = {};
    tasks.forEach((t) => { (byDay[t.DueDate] = byDay[t.DueDate] || []).push(t); });
    Object.values(byDay).forEach((a) => a.sort((x, y) => PRIORITIES.indexOf(x.Priority) - PRIORITIES.indexOf(y.Priority)));
    const t0 = today();
    const ev = (t) => `<div class="cal-ev p-${slug(t.Priority)} ${t.Status === 'Completed' ? 'done' : isOverdue(t) ? 'late' : ''}" data-action="openTask" data-id="${esc(t.TaskID)}" title="${esc(t.TaskID + ' · ' + t.Title + ' · ' + uname(t.AssignedTo))}">${esc(t.Title)}</div>`;
    let cells = '';
    for (let d = start; d <= end; d = addDays(d, 1)) {
      const items = byDay[d] || [];
      cells += `<div class="cal-day ${d.slice(0, 7) !== first.slice(0, 7) ? 'other' : ''} ${d === t0 ? 'today' : ''}"><span class="num">${+d.slice(8)}</span>
        ${items.slice(0, 3).map(ev).join('')}${items.length > 3 ? `<span class="cal-more" data-action="calDay" data-date="${d}">+${items.length - 3} more</span>` : ''}</div>`;
    }
    const monthTasks = tasks.filter((t) => t.DueDate >= first && t.DueDate <= lastDay).sort((a, b) => a.DueDate.localeCompare(b.DueDate));
    const agendaDays = [...new Set(monthTasks.map((t) => t.DueDate))];
    const title = new Date(first + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    return `<div class="view-head"><div><h2>Deadlines calendar</h2><p class="sub">${plural(monthTasks.length, 'task')} due in ${esc(title)} · ${monthTasks.filter(isOverdue).length} overdue</p></div>
      <div class="actions"><div class="seg"><button class="${!c.mine ? 'on' : ''}" data-action="calMine" data-v="0">Everyone</button><button class="${c.mine ? 'on' : ''}" data-action="calMine" data-v="1">Mine</button></div>
      <select class="select" style="width:200px" data-change="calInit" aria-label="Initiative">${iniOpts(c.initiative, 'All initiatives')}</select></div></div>
      <div class="card"><div class="card-head"><button class="icon-btn sm" data-action="calNav" data-d="-1" aria-label="Previous month">${icon('left')}</button><h3 style="min-width:150px;text-align:center">${esc(title)}</h3><button class="icon-btn sm" data-action="calNav" data-d="1" aria-label="Next month">${icon('right')}</button><button class="btn btn-sm" data-action="calNav" data-d="0">Today</button>
        <div class="actions legend" style="margin:0"><span><i style="background:#991B1B"></i>Critical</span><span><i style="background:#EA580C"></i>High</span><span><i style="background:var(--red-bg);border:1px solid var(--red)"></i>Overdue</span><span><i style="background:var(--green-bg);border:1px solid var(--green)"></i>Done</span></div></div>
        <div class="cal">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="cal-dow">${d}</div>`).join('')}${cells}</div>
        <div class="agenda">${agendaDays.length ? agendaDays.map((d) => `<div class="card-head" style="background:var(--surface-2)"><h4>${fmtDate(d, true)}${d === t0 ? ' · Today' : ''}</h4></div><div class="list">${monthTasks.filter((t) => t.DueDate === d).map((t) => `<div class="list-item" data-action="openTask" data-id="${esc(t.TaskID)}">${avatar(t.AssignedTo, 'sm')}<div class="grow"><span class="t">${esc(t.Title)}</span><span class="s">${esc(t.TaskID)} · ${esc(uname(t.AssignedTo))}</span></div>${statusBadge(t.Status)}</div>`).join('')}</div>`).join('') : emptyState('calendar', 'No deadlines this month', 'Use the arrows to move between months.')}</div>
      </div>`;
  }

  /* ------------------------------------------------------------------
   *  VIEW: Initiatives & detail
   * ---------------------------------------------------------------- */
  function stageCaps() { const caps = {}; list(S.data.settings.STAGE_CAPS).forEach((p) => { const m = p.split('='); if (m.length === 2) caps[m[0].trim()] = +m[1]; }); return caps; }
  function iniFlags(i) {
    return `${i.NeedleMover ? `<span title="Needle mover">${icon('star', 'flag-ic flag-star')}</span>` : ''}${i.WeeklyFocus ? `<span title="This week's focus">${icon('focus', 'flag-ic flag-focus')}</span>` : ''}${i.RedFlag ? `<span title="Red flag: ${esc(i.RedFlag)}">${icon('flag', 'flag-ic flag-red')}</span>` : ''}`;
  }
  function filteredInitiatives() {
    const f = S.filters.ini, me = S.me.email, q = f.q.trim().toLowerCase();
    return S.data.initiatives.filter((i) => !i.Archived &&
      (f.scope !== 'mine' || i.Owner === me || list(i.Members).includes(me)) &&
      (!f.forum || i.Forum === f.forum) &&
      (!f.flag || (f.flag === 'needle' && i.NeedleMover) || (f.flag === 'focus' && i.WeeklyFocus) || (f.flag === 'red' && i.RedFlag)) &&
      (!q || (i.InitiativeID + ' ' + i.Name + ' ' + i.Objective + ' ' + uname(i.Owner) + ' ' + i.Category).toLowerCase().includes(q)));
  }
  function iniCard(i) {
    const st = initiativeStats(i.InitiativeID);
    return `<article class="ini-card ${i.RedFlag ? 'red' : ''}" data-action="go" data-href="#/initiatives/${esc(i.InitiativeID)}" tabindex="0">
      <div class="top">${stageBadge(i.Stage)}${prioBadge(i.Priority)}<span class="flags">${iniFlags(i)}</span></div>
      <h4>${esc(i.Name)}</h4>
      <p class="obj">${esc(i.Objective || i.Description || 'No objective recorded yet.')}</p>
      ${progressBar(st.pct, st.pct === 100, true)}
      <div class="foot">${person(i.Owner)}<span>${st.total ? `${st.done}/${st.total} tasks` : 'No tasks yet'}${st.overdue ? ` · <span class="due-overdue">${st.overdue} overdue</span>` : ''}</span>
        <span class="right">${i.Forum ? `<span class="tag">${esc(i.Forum)}</span> ` : ''}${i.TargetDate ? fmtDate(i.TargetDate) : ''}</span></div>
    </article>`;
  }
  function iniGroupsHtml() {
    const f = S.filters.ini;
    const inis = filteredInitiatives();
    if (!inis.length) return emptyState('target', 'No initiatives match', f.scope === 'mine' ? 'You do not own or belong to any initiative with these filters.' : 'Try another filter, or create a new initiative.');
    let groups;
    if (f.group === 'Stage') groups = STAGES.map((s) => [s, inis.filter((i) => i.Stage === s)]);
    else if (f.group === 'Category') groups = [...new Set(inis.map((i) => i.Category || 'Uncategorised'))].sort().map((c) => [c, inis.filter((i) => (i.Category || 'Uncategorised') === c)]);
    else groups = [...new Set(inis.map((i) => i.Owner))].map((o) => [uname(o), inis.filter((i) => i.Owner === o)]).sort((a, b) => a[0].localeCompare(b[0]));
    const caps = stageCaps();
    return `<div class="ini-groups">${groups.filter((g) => g[1].length).map(([name, items]) => `<section class="ini-group"><h3>${f.group === 'Stage' ? stageBadge(name) : esc(name)}<span class="muted" style="font-weight:500">${items.length}${f.group === 'Stage' && caps[name] ? ' / ' + caps[name] : ''}</span></h3>
      <div class="ini-grid">${items.sort((a, b) => PRIORITIES.indexOf(a.Priority) - PRIORITIES.indexOf(b.Priority)).map(iniCard).join('')}</div></section>`).join('')}</div>`;
  }
  function renderInitiatives() {
    const f = S.filters.ini;
    const all = S.data.initiatives.filter((i) => !i.Archived);
    const caps = stageCaps();
    const box = (k, v, cap, color) => `<div class="stage-box ${cap && v > cap ? 'over' : ''}"><div class="k">${esc(k)}</div><div class="v">${v}${cap ? `<small> / ${cap}</small>` : ''}</div>${cap ? `<div class="bar"><i style="width:${Math.min(100, (v / cap) * 100)}%;background:${v > cap ? 'var(--red)' : color}"></i></div>` : ''}</div>`;
    const forums = settingList('FORUMS');
    return `<div class="view-head"><div><h2>Initiatives</h2><p class="sub">${esc(S.data.settings.ORG_NAME || '')} · initiatives only (spend, guardrails and compliance are BAU) · progress = average of linked task progress</p></div>
      <div class="actions">${isManager() ? `<button class="btn btn-primary" data-action="newInitiative">${icon('plus')}New initiative</button>` : ''}</div></div>
      <div class="stage-summary">
        ${box('Live', all.filter((i) => i.Stage === 'Live').length, caps.Live, 'var(--green)')}
        ${box('Build', all.filter((i) => i.Stage === 'Build').length, caps.Build, 'var(--blue)')}
        ${box('Under design', all.filter((i) => i.Stage === 'Under Design').length, caps['Under Design'], 'var(--violet)')}
        ${box('Parked', all.filter((i) => i.Stage === 'Parked').length)}
        <div class="stage-box"><div class="k">${icon('star', 'ic-sm flag-star')} Needle movers</div><div class="v">${all.filter((i) => i.NeedleMover).length}</div></div>
        <div class="stage-box"><div class="k">${icon('focus', 'ic-sm flag-focus')} This week's focus</div><div class="v">${all.filter((i) => i.WeeklyFocus).length}</div></div>
        <div class="stage-box ${all.some((i) => i.RedFlag) ? 'over' : ''}"><div class="k">${icon('flag', 'ic-sm flag-red')} Red flags</div><div class="v">${all.filter((i) => i.RedFlag).length}</div></div>
      </div>
      <div class="filters">
        <div class="seg">${[['mine', 'My review'], ['all', 'All']].map(([k, l]) => `<button class="${f.scope === k ? 'on' : ''}" data-action="iniSet" data-key="scope" data-v="${k}">${l}</button>`).join('')}</div>
        <div class="seg" aria-label="Group by">${['Stage', 'Category', 'Owner'].map((g) => `<button class="${f.group === g ? 'on' : ''}" data-action="iniSet" data-key="group" data-v="${g}">${g === 'Owner' ? 'Owners' : g}</button>`).join('')}</div>
        <input class="input grow" type="search" placeholder="Search initiatives…" value="${esc(f.q)}" data-input="iniSearch" aria-label="Search initiatives">
      </div>
      <div class="row mb-16"><div class="chips">
        <button class="chip ${!f.forum ? 'on' : ''}" data-action="iniSet" data-key="forum" data-v="">All meetings</button>
        ${forums.map((m) => `<button class="chip ${f.forum === m ? 'on' : ''}" data-action="iniSet" data-key="forum" data-v="${esc(m)}">${esc(m)}</button>`).join('')}
      </div><span class="faint">|</span><div class="chips">
        ${[['needle', 'Needle movers', 'star'], ['focus', "This week's focus", 'focus'], ['red', 'Red flags', 'flag']].map(([k, l, ic]) => `<button class="chip ${f.flag === k ? 'on' : ''}" data-action="iniSet" data-key="flag" data-v="${f.flag === k ? '' : k}">${icon(ic, 'ic-sm')}${l}</button>`).join('')}
      </div></div>
      <div id="iniGroups">${iniGroupsHtml()}</div>`;
  }

  function parseMilestones(text) {
    return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const p = l.split('|').map((x) => x.trim());
      const hasDate = /^\d{4}-\d{2}-\d{2}$/.test(p[0]);
      return { date: hasDate ? p[0] : '', name: hasDate ? (p[1] || '') : p[0], done: /^(done|yes|true|x|✓)$/i.test(hasDate ? p[2] || '' : p[1] || '') };
    });
  }
  function miniTaskList(tasks, emptyText) {
    if (!tasks.length) return emptyState('tasks', 'No tasks', emptyText);
    return `<div class="table-wrap"><table class="tbl responsive"><thead><tr><th class="c-id">ID</th><th>Task</th><th>Assignee</th><th>Priority</th><th>Status</th><th>Due</th><th class="c-prog">Progress</th><th>${icon('chat', 'ic-sm')}</th></tr></thead><tbody>
      ${sortTasks(tasks, 'DueDate', 1).map((t) => `<tr class="${isOverdue(t) ? 'overdue' : ''}" data-action="openTask" data-id="${esc(t.TaskID)}"><td class="c-id"><span class="idtag">${esc(t.TaskID)}</span></td>
      <td class="title-cell"><span class="t">${esc(t.Title)}</span><span class="s">${esc(t.Category || '')}</span></td><td>${person(t.AssignedTo)}</td><td>${prioBadge(t.Priority)}</td><td>${statusBadge(t.Status)}</td><td>${dueCell(t)}</td><td class="c-prog" style="min-width:110px">${progressBar(effProgress(t), t.Status === 'Completed')}</td><td>${commentBadge(t)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }
  function discussionFor(taskIds) {
    const set = new Set(taskIds);
    const items = S.data.recentComments.filter((c) => set.has(c.TaskID)).slice(0, 8);
    if (!items.length) return emptyState('chat', 'No recent discussion', 'Comments on linked tasks appear here.');
    return `<div class="feed">${items.map(commentFeedItem).join('')}</div>`;
  }
  function commentFeedItem(c) {
    const t = taskById(c.TaskID);
    return `<div class="feed-item" data-action="openTask" data-id="${esc(c.TaskID)}" data-tab="discussion" style="cursor:pointer">${avatar(c.AuthorEmail)}<div class="body"><b>${esc(c.AuthorName || uname(c.AuthorEmail))}</b> ${c.ParentID ? 'replied on' : 'commented on'} <b>${esc(c.TaskID)}</b>${t ? ' · ' + esc(t.Title) : ''}
      <div class="det">${richText(c.Body.length > 220 ? c.Body.slice(0, 219) + '…' : c.Body)}</div><div class="meta">${esc(relTime(c.CreatedAt))}</div></div></div>`;
  }

  function renderInitiativeDetail(r) {
    const i = initiative(r.id);
    if (!i) return emptyState('target', 'Initiative not found', 'It may have been removed or you followed an old link.', '<a class="btn" href="#/initiatives">Back to initiatives</a>');
    const tasks = S.data.tasks.filter((t) => t.InitiativeID === i.InitiativeID && !t.Archived);
    const st = rollup(tasks);
    const ms = parseMilestones(i.Milestones);
    const projects = S.data.projects.filter((p) => p.InitiativeID === i.InitiativeID && !p.Archived);
    const ids = new Set(tasks.map((t) => t.TaskID).concat([i.InitiativeID], projects.map((p) => p.ProjectID)));
    const acts = S.data.activity.filter((a) => ids.has(a.EntityID)).slice(0, 12);
    const editable = canEditOwned(i);
    return `<div class="crumbs"><a href="#/initiatives">Initiatives</a>${icon('right', 'ic-sm')}<span>${esc(i.InitiativeID)}</span></div>
      <div class="view-head"><div><div class="row">${stageBadge(i.Stage)}${prioBadge(i.Priority)}${iniFlags(i)}${i.Archived ? '<span class="tag">Archived</span>' : ''}</div>
        <h2 class="mt-8">${esc(i.Name)}</h2><p class="sub">${esc(i.Category || 'Uncategorised')}${i.Forum ? ' · Reviewed in ' + esc(i.Forum) : ''} · Owner ${esc(uname(i.Owner))}${i.TargetDate ? ' · Target ' + fmtDate(i.TargetDate, true) : ''}</p></div>
        <div class="actions">${canCreateTask() ? `<button class="btn" data-action="newTask" data-initiative="${esc(i.InitiativeID)}">${icon('plus')}Add task</button>` : ''}
          ${editable ? `<button class="btn" data-action="editInitiative" data-id="${esc(i.InitiativeID)}">${icon('edit')}Edit</button><button class="btn" data-action="archiveInitiative" data-id="${esc(i.InitiativeID)}">${icon(i.Archived ? 'refresh' : 'archive')}${i.Archived ? 'Restore' : 'Archive'}</button>` : ''}</div></div>
      ${i.RedFlag ? `<div class="alert alert-red">${icon('flag')}<div><b>Red flag:</b> ${esc(i.RedFlag)}</div></div>` : ''}
      <div class="detail-kpis">
        <div class="kpi" style="--kpi:var(--teal-600);cursor:default"><span class="kpi-label">Overall progress</span><span class="kpi-value">${st.pct}%</span>${progressBar(st.pct, st.pct === 100)}</div>
        <div class="kpi" style="cursor:default"><span class="kpi-label">Tasks</span><span class="kpi-value">${st.total}</span><span class="kpi-foot">${st.open} open</span></div>
        <div class="kpi" style="--kpi:#16A34A;cursor:default"><span class="kpi-label">Completed</span><span class="kpi-value">${st.done}</span></div>
        <div class="kpi" style="--kpi:#DC2626;cursor:default"><span class="kpi-label">Overdue</span><span class="kpi-value">${st.overdue}</span></div>
        <div class="kpi" style="--kpi:#D97706;cursor:default"><span class="kpi-label">Blocked</span><span class="kpi-value">${st.blocked}</span></div>
      </div>
      <div class="grid grid-2-1">
        <div class="grid" style="align-content:start">
          <div class="card"><div class="card-head"><h3>Objective &amp; description</h3></div><div class="card-body"><p class="prewrap"><b>${esc(i.Objective || 'No business objective recorded.')}</b></p>${i.Description ? `<p class="prewrap muted mt-8">${linkify(esc(i.Description))}</p>` : ''}</div></div>
          <div class="card"><div class="card-head"><h3>Tasks</h3><span class="sub">${st.total}</span></div><div class="card-body flush">${miniTaskList(tasks, 'Add a task to start tracking delivery.')}</div></div>
          <div class="card"><div class="card-head"><h3>Recent discussion</h3></div><div class="card-body flush">${discussionFor(tasks.map((t) => t.TaskID))}</div></div>
        </div>
        <div class="grid" style="align-content:start">
          <div class="card"><div class="card-head"><h3>Team</h3></div><div class="card-body"><div class="grid" style="gap:10px">${person(i.Owner, '')} <span class="tag" style="justify-self:start">Owner</span>${list(i.Members).map((m) => person(m, '')).join('')}</div></div></div>
          <div class="card"><div class="card-head"><h3>Milestones</h3></div><div class="card-body">${ms.length ? `<div class="milestones">${ms.map((m) => `<div class="ms ${m.done ? 'done' : m.date && m.date < today() ? 'late' : ''}"><span class="ms-dot">${m.done ? icon('check', 'ic-sm') : ''}</span><span>${esc(m.name)}</span><span class="d">${m.date ? fmtDate(m.date) : ''}</span></div>`).join('')}</div>` : '<p class="muted">No milestones recorded.</p>'}</div></div>
          <div class="card"><div class="card-head"><h3>Risks &amp; blockers</h3></div><div class="card-body"><p class="prewrap ${i.Risks ? '' : 'muted'}">${esc(i.Risks || 'None recorded.')}</p></div></div>
          <div class="card"><div class="card-head"><h3>Projects</h3></div><div class="card-body flush">${projects.length ? `<div class="list">${projects.map((p) => { const ps = projectStats(p.ProjectID); return `<div class="list-item" data-action="go" data-href="#/projects/${esc(p.ProjectID)}"><div class="grow"><span class="t">${esc(p.Name)}</span><span class="s">${esc(p.Status)} · ${ps.total} tasks</span></div><div style="width:110px">${progressBar(ps.pct, ps.pct === 100)}</div></div>`; }).join('')}</div>` : '<div class="card-body muted">No projects.</div>'}</div></div>
          <div class="card"><div class="card-head"><h3>Activity</h3></div><div class="card-body flush">${feedHtml(acts)}</div></div>
        </div>
      </div>`;
  }

  /* ------------------------------------------------------------------
   *  VIEW: Projects & detail
   * ---------------------------------------------------------------- */
  function renderProjects() {
    const ps = S.data.projects.filter((p) => !p.Archived);
    return `<div class="view-head"><div><h2>Projects</h2><p class="sub">${plural(ps.length, 'project')} · progress = average of linked task progress</p></div>
      <div class="actions">${isManager() ? `<button class="btn btn-primary" data-action="newProject">${icon('plus')}New project</button>` : ''}</div></div>
      <div class="card">${ps.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>ID</th><th>Project</th><th>Initiative</th><th>Owner</th><th>Status</th><th>Tasks</th><th>Progress</th><th>Target</th></tr></thead><tbody>
        ${ps.map((p) => { const st = projectStats(p.ProjectID); const i = initiative(p.InitiativeID); return `<tr data-action="go" data-href="#/projects/${esc(p.ProjectID)}"><td><span class="idtag">${esc(p.ProjectID)}</span></td><td class="title-cell"><span class="t">${esc(p.Name)}</span><span class="s">${esc(p.Description || '')}</span></td>
          <td>${i ? esc(i.Name) : '<span class="faint">—</span>'}</td><td>${person(p.Owner)}</td><td><span class="tag">${esc(p.Status)}</span></td><td class="mono">${st.done}/${st.total}${st.overdue ? ` <span class="due-overdue">· ${st.overdue} late</span>` : ''}</td><td style="min-width:130px">${progressBar(st.pct, st.pct === 100)}</td><td>${fmtDate(p.TargetDate)}</td></tr>`; }).join('')}
        </tbody></table></div>` : emptyState('folder', 'No projects yet', 'Projects group related tasks, optionally under an initiative.', isManager() ? `<button class="btn btn-primary" data-action="newProject">${icon('plus')}New project</button>` : '')}</div>`;
  }
  function renderProjectDetail(r) {
    const p = project(r.id);
    if (!p) return emptyState('folder', 'Project not found', 'It may have been removed.', '<a class="btn" href="#/projects">Back to projects</a>');
    const tasks = S.data.tasks.filter((t) => t.ProjectID === p.ProjectID && !t.Archived);
    const st = rollup(tasks);
    const i = initiative(p.InitiativeID);
    return `<div class="crumbs"><a href="#/projects">Projects</a>${icon('right', 'ic-sm')}<span>${esc(p.ProjectID)}</span></div>
      <div class="view-head"><div><div class="row"><span class="tag">${esc(p.Status)}</span>${p.Archived ? '<span class="tag">Archived</span>' : ''}</div><h2 class="mt-8">${esc(p.Name)}</h2>
        <p class="sub">${i ? `Initiative: <a href="#/initiatives/${esc(i.InitiativeID)}">${esc(i.Name)}</a> · ` : ''}Owner ${esc(uname(p.Owner))} · ${fmtDate(p.StartDate)} → ${fmtDate(p.TargetDate)}</p></div>
        <div class="actions">${canCreateTask() ? `<button class="btn" data-action="newTask" data-project="${esc(p.ProjectID)}" data-initiative="${esc(p.InitiativeID)}">${icon('plus')}Add task</button>` : ''}
        ${canEditOwned(p) ? `<button class="btn" data-action="editProject" data-id="${esc(p.ProjectID)}">${icon('edit')}Edit</button><button class="btn" data-action="archiveProject" data-id="${esc(p.ProjectID)}">${icon(p.Archived ? 'refresh' : 'archive')}${p.Archived ? 'Restore' : 'Archive'}</button>` : ''}</div></div>
      ${p.Description ? `<div class="card mb-16"><div class="card-body prewrap">${linkify(esc(p.Description))}</div></div>` : ''}
      <div class="detail-kpis">
        <div class="kpi" style="--kpi:var(--teal-600);cursor:default"><span class="kpi-label">Progress</span><span class="kpi-value">${st.pct}%</span>${progressBar(st.pct, st.pct === 100)}</div>
        <div class="kpi" style="cursor:default"><span class="kpi-label">Tasks</span><span class="kpi-value">${st.total}</span></div>
        <div class="kpi" style="--kpi:#16A34A;cursor:default"><span class="kpi-label">Completed</span><span class="kpi-value">${st.done}</span></div>
        <div class="kpi" style="--kpi:#DC2626;cursor:default"><span class="kpi-label">Overdue</span><span class="kpi-value">${st.overdue}</span></div>
        <div class="kpi" style="--kpi:#D97706;cursor:default"><span class="kpi-label">Blocked</span><span class="kpi-value">${st.blocked}</span></div>
      </div>
      <div class="card"><div class="card-head"><h3>Tasks</h3></div><div class="card-body flush">${miniTaskList(tasks, 'No tasks in this project yet.')}</div></div>`;
  }

  /* ------------------------------------------------------------------
   *  VIEW: Discussions & activity
   * ---------------------------------------------------------------- */
  function actIcon(a) {
    const s = a.Action || '';
    if (/Comment|Reply/.test(s)) return ['chat', 'teal'];
    if (/completed/i.test(s)) return ['check', 'green'];
    if (/archived|deleted/i.test(s)) return ['archive', 'amber'];
    if (/Assignment/.test(s)) return ['user', ''];
    if (/Status|Stage/.test(s)) return ['activity', ''];
    if (/Priority/.test(s)) return ['flag', 'red'];
    if (/created|added/i.test(s)) return ['plus', 'green'];
    return ['edit', ''];
  }
  function entityLink(a) {
    if (a.EntityType === 'Task') return `<a href="javascript:void 0" data-action="openTask" data-id="${esc(a.EntityID)}">${esc(a.EntityID)}</a>`;
    if (a.EntityType === 'Initiative') return `<a href="#/initiatives/${esc(a.EntityID)}">${esc(a.EntityID)}</a>`;
    if (a.EntityType === 'Project') return `<a href="#/projects/${esc(a.EntityID)}">${esc(a.EntityID)}</a>`;
    return esc(a.EntityID);
  }
  function feedHtml(items) {
    if (!items.length) return emptyState('activity', 'No activity yet', 'Changes made by the team will appear here.');
    return `<div class="feed">${items.map((a) => { const [ic, c] = actIcon(a); const t = a.EntityType === 'Task' ? taskById(a.EntityID) : null; return `<div class="feed-item"><span class="feed-ic ${c}">${icon(ic)}</span><div class="body">
      <b>${esc(a.ActorName || uname(a.ActorEmail) || 'System')}</b> · ${esc(a.Action)} · ${entityLink(a)}${t ? ' <span class="muted">' + esc(t.Title) + '</span>' : ''}
      ${a.Details ? `<div class="det">${esc(a.Details)}</div>` : ''}<div class="meta" title="${esc(fmtDateTime(a.Timestamp))}">${esc(relTime(a.Timestamp))}</div></div></div>`; }).join('')}</div>`;
  }
  function renderActivity() {
    const f = S.filters.act;
    const q = f.q.trim().toLowerCase();
    const comments = S.data.recentComments.filter((c) => !q || (c.Body + ' ' + c.AuthorName + ' ' + c.TaskID).toLowerCase().includes(q));
    const acts = S.data.activity.filter((a) => (!f.type || a.EntityType === f.type) && (!q || (a.Action + ' ' + a.Details + ' ' + a.ActorName + ' ' + a.EntityID).toLowerCase().includes(q)));
    return `<div class="view-head"><div><h2>Discussions &amp; activity</h2><p class="sub">Latest comments, replies and audit trail across the board</p></div></div>
      <div class="tabs">${[['discussions', 'Discussions', S.data.recentComments.length], ['log', 'Activity log', S.data.activity.length]].map(([k, l, n]) => `<button class="${f.tab === k ? 'on' : ''}" data-action="actTab" data-tab="${k}">${l}<span class="pill-count">${n}</span></button>`).join('')}</div>
      <div class="filters"><input class="input grow" type="search" placeholder="Search ${f.tab === 'log' ? 'activity' : 'discussions'}…" value="${esc(f.q)}" data-input="actSearch" aria-label="Search">
        ${f.tab === 'log' ? `<select class="select" data-change="actType" aria-label="Entity type">${opts(['Task', 'Initiative', 'Project', 'Comment', 'User', 'Settings'], f.type, 'All record types')}</select>` : ''}</div>
      <div class="card" id="actArea">${f.tab === 'log' ? feedHtml(acts) : (comments.length ? `<div class="feed">${comments.map(commentFeedItem).join('')}</div>` : emptyState('chat', 'No discussions yet', 'Open any task and add a comment to start a discussion.'))}</div>
      <p class="muted mt-8" style="font-size:12px">Showing the most recent ${S.data.activity.length} log entries and ${S.data.recentComments.length} comments. The full history is kept in the ActivityLog and Comments sheets.</p>`;
  }

  /* ------------------------------------------------------------------
   *  VIEW: Team overview
   * ---------------------------------------------------------------- */
  function renderTeam() {
    const t0 = today();
    const users = activeUsers().map((u) => {
      const ts = S.data.tasks.filter((t) => !t.Archived && t.AssignedTo === u.Email);
      return { u, open: ts.filter((t) => OPEN(t.Status)).length, overdue: ts.filter(isOverdue).length, week: ts.filter(isDueThisWeek).length, done30: ts.filter((t) => t.Status === 'Completed' && t.CompletedDate >= addDays(t0, -30)).length, collab: S.data.tasks.filter((t) => !t.Archived && OPEN(t.Status) && list(t.Collaborators).includes(u.Email)).length };
    }).sort((a, b) => b.open - a.open || a.u.Name.localeCompare(b.u.Name));
    const heads = users.filter((x) => /^head of all/i.test(x.u.Title || ''));
    return `<div class="view-head"><div><h2>Team overview</h2><p class="sub">${plural(users.length, 'active member')} · workload based on open assigned tasks${isManager() ? ` · ${users.filter((x) => presenceOf(x.u) === 'online').length} online now` : ''}</p></div>
      ${isManager() ? `<div class="actions"><button class="btn btn-primary" data-action="newUser">${icon('plus')}Add team member</button><a class="btn" href="#/settings" data-action="settingsTab" data-tab="users">Manage team</a></div>` : ''}</div>
      ${heads.length ? `<div class="lead-banner">${heads.map((x) => `${avatar(x.u.Email, 'lg')}<div><div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:700">Leadership</div><b>${esc(x.u.Name)}</b> · ${esc(x.u.Title)}</div>`).join('')}</div>` : ''}
      ${(() => { const groups = [...new Set(users.map((x) => x.u.Department || 'Other'))].sort((a, b) => (settingList('DEPARTMENTS').indexOf(a) + 1 || 99) - (settingList('DEPARTMENTS').indexOf(b) + 1 || 99));
        return groups.map((g) => { const tbd = S.data.tasks.filter((t) => !t.Archived && OPEN(t.Status) && !t.AssignedTo && teamOf(t) === g).length; return `<h3 class="mt-16 mb-16 row">${esc(g)} <span class="muted" style="font-weight:500">${users.filter((x) => (x.u.Department || 'Other') === g).length} people${tbd ? ` · <a href="javascript:void 0" data-action="ownerChip" data-preset='${esc(JSON.stringify({ team: g, assignee: '__tbd__' }))}'>${tbd} TBD tasks</a>` : ''}</span></h3><div class="team-grid">${users.filter((x) => (x.u.Department || 'Other') === g).map(memberCard).join('')}</div>`; }).join(''); })()}`;
  }
  function memberCard(x) {
    const maxOpen = 10;
    return `<div class="member" data-action="filterTasks" data-preset='${esc(JSON.stringify({ assignee: x.u.Email, status: 'open' }))}' tabindex="0">
        <div class="who">${avatar(x.u.Email, 'lg')}<div style="min-width:0"><b>${esc(x.u.Name)}</b><div class="muted" style="font-size:12px">${esc(x.u.Title || x.u.Department || x.u.Role)}</div>${isManager() ? `<div class="mt-8">${presenceBadge(x.u)}</div>` : ''}</div><span class="tag ${x.u.Role === 'Admin' ? 'tag-teal' : ''}" style="margin-left:auto">${/^head/i.test(x.u.Title) ? '★ Head' : esc(x.u.Role)}</span></div>
        <div class="stats"><div><b>${x.open}</b><span>Open</span></div><div><b class="${x.overdue ? 'due-overdue' : ''}">${x.overdue}</b><span>Overdue</span></div><div><b>${x.week}</b><span>This week</span></div><div><b>${x.done30}</b><span>Done 30d</span></div></div>
        <div><div class="progress"><i style="width:${Math.min(100, (x.open / maxOpen) * 100)}%;background:${x.overdue ? 'var(--red)' : 'var(--navy-600)'}"></i></div><div class="muted mt-8" style="font-size:12px">${x.collab ? `Collaborating on ${plural(x.collab, 'open task')}` : 'No collaborations'}</div></div>
      </div>`;
  }

  /* ------------------------------------------------------------------
   *  VIEW: Settings & administration
   * ---------------------------------------------------------------- */
  function renderSettings() {
    const tab = S.filters.settingsTab;
    const tabs = [['profile', 'My profile'], ['connection', 'Connection & data']];
    if (isManager()) tabs.splice(1, 0, ['import', 'Import tasks']);
    if (isAdmin()) tabs.splice(1, 0, ['users', 'Users & roles'], ['config', 'Configuration']);
    else if (isManager()) tabs.splice(1, 0, ['users', 'Team members']);
    const t = tabs.some((x) => x[0] === tab) ? tab : 'profile';
    let body = '';
    const me = user(S.me.email);
    if (t === 'profile') {
      body = `<div class="card"><div class="card-body"><div class="row" style="gap:16px">${avatar(S.me.email, 'xl')}<div><h3>${esc(S.me.name)}</h3><p class="muted">${esc(S.me.email)}</p></div></div>
        <dl class="kv mt-16"><dt>Role</dt><dd>${esc(S.me.role)}</dd><dt>Department</dt><dd>${esc(me.Department || '—')}</dd><dt>Title</dt><dd>${esc(me.Title || '—')}</dd>
        <dt>Sign-in</dt><dd>${S.me.verified ? '✓ Verified with Google' : '⚠ Test mode (not verified)'}</dd><dt>Session expires</dt><dd>${esc(fmtDateTime(S.expiresAt))}</dd>
        <dt>Permissions</dt><dd>${esc({ Admin: 'Full access, including users and configuration.', Manager: 'Create and edit all tasks, initiatives and projects.', Member: 'Create tasks; edit tasks you created, own or collaborate on; comment everywhere.', Viewer: 'Read everything and take part in discussions.' }[S.me.role] || '')}</dd></dl>
        <div class="row mt-16"><button class="btn" data-action="signOut">${icon('logout')}Sign out</button></div></div></div>`;
    } else if (t === 'users') {
      const us = S.data.users.slice().sort((a, b) => Number(b.Active) - Number(a.Active) || a.Name.localeCompare(b.Name));
      const live = us.filter((u) => u.Active);
      const cnt = (p) => live.filter((u) => presenceOf(u) === p).length;
      body = `<div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">
          <div class="kpi" style="--kpi:#16A34A;cursor:default"><span class="kpi-label">Online now</span><span class="kpi-value">${cnt('online')}</span><span class="kpi-foot">Used the board in the last 10 min</span></div>
          <div class="kpi" style="--kpi:var(--teal-500);cursor:default"><span class="kpi-label">Activated profiles</span><span class="kpi-value">${cnt('online') + cnt('active')}</span><span class="kpi-foot">Signed in at least once</span></div>
          <div class="kpi" style="--kpi:#D97706;cursor:default"><span class="kpi-label">Not activated yet</span><span class="kpi-value">${cnt('pending')}</span><span class="kpi-foot">Never signed in</span></div>
          <div class="kpi" style="--kpi:#94A3B8;cursor:default"><span class="kpi-label">Deactivated</span><span class="kpi-value">${us.length - live.length}</span></div></div>
        <div class="card"><div class="card-head"><h3>${isAdmin() ? 'Users &amp; roles' : 'Team members'}</h3><span class="sub">${live.length} active accounts</span><div class="actions"><button class="btn btn-primary btn-sm" data-action="newUser">${icon('plus', 'ic-sm')}Add team member</button></div></div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Team</th><th>Status</th><th>Last seen</th><th></th></tr></thead><tbody>
        ${us.map((u) => `<tr style="cursor:default" data-email="${esc(u.Email)}"><td>${person(u.Email)}${u.Title ? `<div class="muted" style="font-size:11.5px;margin-left:30px">${esc(u.Title)}</div>` : ''}</td><td style="font-size:12.5px">${esc(u.Email)}</td>
          <td>${isAdmin() ? `<select class="select select-sm" style="width:118px" data-change="userRole" data-email="${esc(u.Email)}" aria-label="Role of ${esc(u.Name)}">${opts(ROLES, u.Role)}</select>` : `<span class="tag">${esc(u.Role)}</span>`}</td>
          <td>${esc(u.Department || '—')}</td><td>${u.Active ? presenceBadge(u) : '<span class="badge st-not-started">Deactivated</span>'}</td><td class="muted">${u.LastSeen || u.LastLogin ? esc(relTime(u.LastSeen || u.LastLogin)) : 'Never'}</td>
          <td class="row-actions">${canManageUser(u) ? `<button class="btn btn-xs" data-action="editUser" data-email="${esc(u.Email)}">Edit</button>` : ''}${isAdmin() && u.Email !== S.me.email ? ` <button class="icon-btn sm danger-btn" data-action="deleteUser" data-email="${esc(u.Email)}" title="Delete user" aria-label="Delete ${esc(u.Name)}">${icon('trash', 'ic-sm')}</button>` : ''}</td></tr>`).join('')}
        </tbody></table></div></div>
        <p class="muted mt-8" style="font-size:12px">Users from <b>${esc(S.data.settings.ALLOWED_DOMAINS || '—')}</b> ${String(S.data.settings.AUTO_PROVISION).toUpperCase() === 'TRUE' ? 'are added automatically as ' + esc(S.data.settings.DEFAULT_ROLE) + ' on first Google sign-in' : 'must be added here before they can sign in'}. When someone signs in with Google for the first time, their profile is <b>activated</b> automatically: their company name and photo are picked up, and if a profile with the same first name was waiting for them (e.g. "Nitish"), it is linked to their real email so their tasks stay with them. Deactivate users instead of deleting them so their history stays intact.</p>`;
    } else if (t === 'import') {
      body = importPanel();
    } else if (t === 'config') {
      const s = S.data.settings;
      const fld = (k, label, hint, type) => `<div class="field ${type === 'area' ? 'span-2' : ''}"><label for="cfg-${k}">${esc(label)}</label>${type === 'area' ? `<textarea class="textarea" id="cfg-${k}" data-cfg="${k}" rows="2">${esc(s[k] || '')}</textarea>` : type === 'bool' ? `<select class="select" id="cfg-${k}" data-cfg="${k}">${opts(['TRUE', 'FALSE'], String(s[k] || '').toUpperCase())}</select>` : type === 'role' ? `<select class="select" id="cfg-${k}" data-cfg="${k}">${opts(['Member', 'Viewer', 'Manager'], s[k])}</select>` : `<input class="input" id="cfg-${k}" data-cfg="${k}" value="${esc(s[k] || '')}">`}<span class="hint">${esc(hint)}</span></div>`;
      body = `<div class="card"><div class="card-head"><h3>Configuration</h3><span class="sub">Saved to the Settings sheet</span></div><div class="card-body"><div class="form-grid">
        ${fld('APP_NAME', 'Application name', 'Shown in the header and browser tab.')}${fld('ORG_NAME', 'Organisation', 'Shown in the sidebar.')}
        ${fld('ALLOWED_DOMAINS', 'Allowed email domains', 'Comma-separated, e.g. justlife.com')}${fld('AUTO_PROVISION', 'Auto-add users from allowed domains', 'TRUE adds new Google users automatically.', 'bool')}
        ${fld('DEFAULT_ROLE', 'Default role for new users', 'Applied on auto-provisioning.', 'role')}${fld('SESSION_HOURS', 'Session length (hours)', 'Between 1 and 6.')}
        ${fld('TIMEZONE', 'Time zone', 'IANA name, e.g. Asia/Dubai.')}${fld('POLL_SECONDS', 'Refresh interval (seconds)', 'How often browsers check for team changes (min 15).')}
        ${fld('DUE_SOON_DAYS', 'Due-soon reminder (days)', 'Days before the due date for reminders.')}${fld('STAGE_CAPS', 'Stage caps', 'e.g. Live=8, Build=8, Under Design=8')}
        ${fld('EMAIL_ENABLED', 'Send email notifications', 'TRUE sends emails for the types below.', 'bool')}${fld('BOARD_URL', 'Board link (for emails)', 'Your GitHub Pages address.')}
        ${fld('EMAIL_TYPES', 'Emailed notification types', 'MENTION, ASSIGNED, ISSUE, NOTE, NOT_STARTED, OVERDUE (also: REPLY, COMMENT, DUE_SOON, BLOCKED, COMPLETED, RESOLVED)', 'area')}
        ${fld('CATEGORIES', 'Categories / departments', 'Comma-separated list.', 'area')}${fld('FORUMS', 'Review forums / meetings', 'Comma-separated list.', 'area')}${fld('DEPARTMENTS', 'Departments (for users)', 'Comma-separated list.', 'area')}
        </div><div class="alert alert-blue mt-16">${icon('lock')}<div>For security, <b>AUTH_MODE</b> (currently <b>${esc(s.AUTH_MODE)}</b>) and <b>GOOGLE_CLIENT_ID</b> can only be changed directly in the Settings sheet by the spreadsheet owner.</div></div>
        <div class="row end mt-16"><button class="btn btn-primary" data-action="saveConfig">Save configuration</button></div></div></div>`;
    } else {
      body = `<div class="card"><div class="card-body"><dl class="kv">
        <dt>Mode</dt><dd>Live — Google Apps Script + Google Sheets</dd>
        <dt>Backend URL</dt><dd>${esc(CFG.API_URL)}</dd>
        <dt>Sign-in mode</dt><dd>${esc(S.data.settings.AUTH_MODE)}</dd>
        <dt>Synchronisation</dt><dd>Polling every ${S.pollSec || 30}s while this tab is visible, immediately when you return to the tab, and after every change you save. Changes by others appear within one interval.</dd>
        <dt>Last synced</dt><dd>${esc(fmtDateTime(new Date(S.lastSync).toISOString()))}</dd>
        <dt>Versions</dt><dd>Website v${VERSION} · server ${esc(S.serverVersion === 'old' ? 'older than 1.7 (redeploy!)' : 'v' + S.serverVersion)}</dd>
        <dt>Data revision</dt><dd class="mono">${esc(S.rev)}</dd>
        <dt>Records loaded</dt><dd>${S.data.tasks.length} tasks · ${S.data.initiatives.length} initiatives · ${S.data.projects.length} projects · ${S.data.users.length} users</dd>
        </dl><div class="row mt-16"><button class="btn" data-action="syncNow">${icon('refresh')}Sync now</button></div></div></div>`;
    }
    return `<div class="view-head"><div><h2>Settings</h2><p class="sub">Profile, administration and connection details</p></div></div>
      <div class="tabs">${tabs.map(([k, l]) => `<button class="${t === k ? 'on' : ''}" data-action="settingsTab" data-tab="${k}">${l}</button>`).join('')}</div>${body}`;
  }

  /* ------------------------------------------------------------------
   *  Bulk import (paste from Excel / Google Sheets / old board)
   * ---------------------------------------------------------------- */
  const IMPORT_COLS = {
    Title: ['title', 'task', 'task name', 'name', 'item', 'subject', 'initiative name', 'action'],
    Stage: ['stage', 'board stage', 'phase'],
    Meeting: ['meeting', 'forum', 'review meeting', 'meetings'],
    Owner: ['owner', 'assignee', 'assigned to', 'assigned', 'person', 'who', 'responsible'],
    Team: ['team', 'department', 'dept', 'function', 'group'],
    Status: ['status', 'state'],
    Priority: ['priority', 'prio', 'pri', 'importance'],
    DueDate: ['due', 'due date', 'deadline', 'target', 'target date', 'eta', 'end date'],
    StartDate: ['start', 'start date', 'started'],
    Initiative: ['initiative', 'project', 'workstream', 'program'],
    Category: ['category', 'type', 'area'],
    Description: ['description', 'notes', 'details', 'comment', 'comments', 'update', 'latest update'],
    Progress: ['progress', '%', 'percent', '% complete'],
    Links: ['link', 'links', 'url', 'doc']
  };
  const DEFAULT_ORDER = ['Title', 'Owner', 'Team', 'Status', 'Priority', 'DueDate', 'Initiative', 'Description'];
  function parseDelimited(text) {
    const delim = text.includes('\t') ? '\t' : ',';
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
      else if (c === '"' && cell === '') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some(Boolean));
  }
  function mapImport(text) {
    const grid = parseDelimited(text);
    if (!grid.length) return { rows: [], mapping: [] };
    const head = grid[0].map((h) => h.toLowerCase().replace(/[*:]/g, '').trim());
    let mapping = head.map((h) => Object.keys(IMPORT_COLS).find((k) => IMPORT_COLS[k].includes(h)) || '');
    let body = grid.slice(1);
    if (!mapping.includes('Title')) { mapping = grid[0].map((_, i) => DEFAULT_ORDER[i] || ''); body = grid; }
    const rows = body.map((r) => { const o = {}; mapping.forEach((k, i) => { if (k && r[i] !== undefined && !o[k]) o[k] = r[i]; }); return o; }).filter((o) => o.Title);
    return { rows, mapping };
  }
  async function importChunks(rows, dryRun) {
    const size = 20, out = { dryRun, total: 0, importable: 0, imported: 0, results: [] };
    for (let i = 0; i < rows.length; i += size) {
      const r = dryRun ? await api('importTasks', { rows: rows.slice(i, i + size), dryRun: true }) : await write('importTasks', { rows: rows.slice(i, i + size) });
      out.total += r.total; out.importable += r.importable; out.imported += r.imported;
      r.results.forEach((x) => { x.row += i; out.results.push(x); });
    }
    return out;
  }
  function importPanel() {
    const st = S.importState || (S.importState = { text: '', preview: null });
    const p = st.preview;
    return `<div class="card"><div class="card-head"><h3>Import tasks</h3><span class="sub">Paste rows copied from Excel, Google Sheets or the old board</span></div><div class="card-body">
      <p class="muted">Include a header row. Recognised columns: <b>Title</b>, <b>Owner</b> (name or email — blank or "TBD" = unassigned), <b>Team</b> (${esc(settingList('DEPARTMENTS').join(' / '))}), <b>Status</b>, <b>Priority</b>, <b>Due date</b>, Start date, Initiative, Category, Description, Progress, Links.
      Without a header the order is assumed to be: Title, Owner, Team, Status, Priority, Due date, Initiative, Description.</p>
      <textarea class="textarea mt-8" id="importText" rows="9" placeholder="Title&#9;Owner&#9;Team&#9;Status&#9;Priority&#9;Due date&#10;Hospital partnership — Mediclinic&#9;Nitish&#9;BD&#9;In progress&#9;High&#9;2026-11-15&#10;Q4 campaign brief&#9;Yana&#9;Marketing&#9;Not started&#9;Medium&#9;30/11/2026" data-input="importText">${esc(st.text)}</textarea>
      <div class="row mt-8"><button class="btn" data-action="importPreview">${icon('search')}Preview</button>${p && p.importable ? `<button class="btn btn-primary" data-action="importRun">${icon('download')}Import / update ${p.importable} task${p.importable === 1 ? '' : 's'}</button>` : ''}<span class="muted" style="font-size:12px">Nothing is saved until you click Import. Duplicate titles for the same owner are skipped.</span></div>
      ${p ? `<div class="mt-16 table-wrap"><table class="tbl"><thead><tr><th>#</th><th>Title</th><th>Owner</th><th>Team</th><th>Status</th><th>Priority</th><th>Due</th><th>Initiative</th><th>Notes</th></tr></thead><tbody>
        ${p.results.map((r) => `<tr style="cursor:default" class="${r.ok || r.update ? '' : 'overdue'}"><td class="muted">${r.row}</td><td class="title-cell"><span class="t">${esc(r.task.Title)}</span>${r.task.TaskID ? `<span class="s">${esc(r.task.TaskID)}</span>` : ''}</td><td>${person(r.task.AssignedTo)}</td><td>${esc(r.task.Team || '—')}</td><td>${statusBadge(r.task.Status)}</td><td>${prioBadge(r.task.Priority)}</td><td>${fmtDate(r.task.DueDate)}</td><td>${esc(r.task.Initiative || '—')}</td>
        <td style="font-size:12px">${r.ok ? '' : `<span class="${r.update ? 'muted' : 'due-overdue'}">${esc(r.error)}</span><br>`}${r.warnings.map((w) => `<span class="muted">${esc(w)}</span>`).join('<br>')}</td></tr>`).join('')}
        </tbody></table></div><p class="mt-8 muted">${p.dryRun ? `${p.importable} of ${p.total} rows ready to import.` : `<b>${p.imported} tasks imported${p.updated ? `, ${p.updated} existing tasks updated` : ''}.</b>`}</p>` : ''}
    </div></div>`;
  }

  /* ------------------------------------------------------------------
   *  VIEW: Meeting board (stage tabs · meeting filter · All / Status / Category / Owners)
   * ---------------------------------------------------------------- */
  const TASK_STAGES = ['Live', 'Build', 'Under Design', 'Parked', 'Done'];
  const STAGE_INFO = {
    Live: { label: 'Live', note: 'Running · weekly update in the team meeting', cls: 'live' },
    Build: { label: 'Build', note: 'Being built · owner drives it to launch', cls: 'build' },
    'Under Design': { label: 'Under design', note: 'Scoping · needs owner, plan and date', cls: 'design' },
    Parked: { label: 'Parked', note: 'Paused 2–3 weeks · review date set', cls: 'parked' },
    Done: { label: 'Done', note: 'Completed', cls: 'done' }
  };
  const PRI = { Critical: 'P0', High: 'P1', Medium: 'P2', Low: 'P3' };
  /** Stage used on the meeting board: the task's Stage, or one derived from its status. */
  function effStage(t) {
    if (t.Stage) return t.Stage;
    return { 'Not Started': 'Under Design', 'In Progress': 'Build', 'Under Review': 'Build', Blocked: 'Parked', Completed: 'Done', Cancelled: 'Done' }[t.Status] || 'Under Design';
  }
  const stagePill = (st) => `<span class="sp sp-${STAGE_INFO[st] ? STAGE_INFO[st].cls : 'design'}">${esc(STAGE_INFO[st] ? STAGE_INFO[st].label : st)}</span>`;
  const priPill = (p) => `<span class="pp pp-${slug(p)}" title="${esc(p)}">${PRI[p] || esc(p)}</span>`;

  function meetingTasks() {
    const f = S.filters.mtg;
    const q = f.q.trim().toLowerCase();
    return S.data.tasks.filter((t) => !t.Archived && t.Status !== 'Cancelled' &&
      (!f.meeting || t.Meeting === f.meeting) &&
      (!q || (t.TaskID + ' ' + t.Title + ' ' + t.Description + ' ' + uname(t.AssignedTo) + ' ' + t.Category).toLowerCase().includes(q)));
  }
  function actionTable(rows) {
    if (!rows.length) return emptyState('focus', 'Nothing here', 'No actions match this stage and meeting.');
    const sorted = rows.slice().sort((a, b) => PRIORITIES.indexOf(a.Priority) - PRIORITIES.indexOf(b.Priority) || (a.DueDate || '9').localeCompare(b.DueDate || '9') || a.Title.localeCompare(b.Title));
    return `<div class="table-wrap"><table class="tbl atbl"><thead><tr><th style="width:110px">Status</th><th>Action</th><th>Category</th><th>Owner</th><th>Due</th><th style="text-align:right">Pri</th></tr></thead><tbody>
      ${sorted.map((t) => { const sub = String(t.Description || '').split('\n')[0]; const oi = (S.data.commentStats[t.TaskID] || {}).openIssues; return `<tr class="${isOverdue(t) ? 'overdue' : ''}" data-action="openTask" data-id="${esc(t.TaskID)}">
        <td>${stagePill(effStage(t))}</td>
        <td class="title-cell"><span class="t">${esc(t.Title)}${oi ? ` <span class="issue-pill">${icon('alert', 'ic-sm')}${oi}</span>` : ''}</span><span class="s">${esc(sub.length > 120 ? sub.slice(0, 119) + '…' : sub) || (t.Meeting ? esc(t.Meeting) : '&nbsp;')}</span></td>
        <td>${t.Category ? `<span class="ctag">${esc(t.Category)}</span>` : '<span class="faint">—</span>'}</td>
        <td>${person(t.AssignedTo)}</td>
        <td class="mono">${t.DueDate ? dueCell(t) : '<span class="faint">–</span>'}</td>
        <td style="text-align:right">${priPill(t.Priority)}</td></tr>`; }).join('')}</tbody></table></div>`;
  }
  function renderMeetings() {
    const f = S.filters.mtg;
    const all = meetingTasks();
    const by = (st) => all.filter((t) => effStage(t) === st);
    const p0 = (arr) => arr.filter((t) => t.Priority === 'Critical').length;
    let body = '';
    if (f.mode === 'status') {
      body = `<div class="stage-tabs">${TASK_STAGES.map((st) => { const n = by(st); return `<button class="stage-tab st-${STAGE_INFO[st].cls} ${f.stage === st ? 'on' : ''}" data-action="mtgSet" data-key="stage" data-v="${esc(st)}">${esc(STAGE_INFO[st].label)} <span class="n">${n.length}</span>${p0(n) ? `<span class="p0">• ${p0(n)} P0</span>` : ''}</button>`; }).join('')}</div>
        <p class="stage-note">${esc(STAGE_INFO[f.stage].note)}</p>
        <div class="card">${actionTable(by(f.stage))}</div>`;
    } else if (f.mode === 'category') {
      const cats = [...new Set(all.map((t) => t.Category || 'Uncategorised'))].sort((a, b) => (a === 'Others') - (b === 'Others') || a.localeCompare(b));
      body = cats.map((c) => { const rows = all.filter((t) => (t.Category || 'Uncategorised') === c); return `<div class="group-head"><span class="ctag">${esc(c)}</span><span class="muted">${rows.length}${p0(rows) ? ` · <span class="p0">${p0(rows)} P0</span>` : ''}</span></div><div class="card mb-16">${actionTable(rows)}</div>`; }).join('') || `<div class="card">${actionTable([])}</div>`;
    } else if (f.mode === 'owners') {
      const owners = [...new Set(all.map((t) => t.AssignedTo))];
      const order = (e) => { const i = S.data.users.findIndex((u) => u.Email === e); return e ? (i < 0 ? 999 : i) : 1000; };
      owners.sort((a, b) => order(a) - order(b));
      body = owners.map((o) => { const rows = all.filter((t) => t.AssignedTo === o); return `<div class="group-head">${person(o, '')}<span class="muted">${rows.length} action${rows.length === 1 ? '' : 's'}${p0(rows) ? ` · <span class="p0">${p0(rows)} P0</span>` : ''}</span></div><div class="card mb-16">${actionTable(rows)}</div>`; }).join('') || `<div class="card">${actionTable([])}</div>`;
    } else {
      const sorted = TASK_STAGES.flatMap((st) => by(st));
      body = `<div class="card">${actionTable(sorted).replace('<tbody>', '<tbody>')}</div>`;
    }
    const forums = settingList('FORUMS');
    return `<div class="view-head"><div><h2>Meeting board</h2><p class="sub">Actions by stage for ${f.meeting ? esc(f.meeting) : 'all meetings'} · ${plural(all.length, 'action')} · ${p0(all)} P0</p></div></div>
      <div class="mtg-bar">
        <div class="seg">${[['all', 'All'], ['status', 'Status'], ['category', 'Category'], ['owners', 'Owners']].map(([k, l]) => `<button class="${f.mode === k ? 'on' : ''}" data-action="mtgSet" data-key="mode" data-v="${k}">${l}</button>`).join('')}</div>
        <div class="mtg-right">
          <div class="chips"><button class="chip ${!f.meeting ? 'on' : ''}" data-action="mtgSet" data-key="meeting" data-v="">All meetings</button>${forums.map((m) => `<button class="chip ${f.meeting === m ? 'on' : ''}" data-action="mtgSet" data-key="meeting" data-v="${esc(m)}">${esc(m)}</button>`).join('')}</div>
          <input class="input" type="search" placeholder="Search" value="${esc(f.q)}" data-input="mtgSearch" aria-label="Search actions" style="width:200px">
          ${canCreateTask() ? `<button class="btn btn-teal" data-action="newTask" data-meeting="${esc(f.meeting)}" data-stage="${f.mode === 'status' ? esc(f.stage) : ''}">${icon('plus')}Add action</button>` : ''}
        </div>
      </div>
      <div id="mtgBody">${body}</div>
      <p class="muted mt-16" style="font-size:12.5px">Click any row to update status, owner, due date or notes. Changes save to Google Sheets for everyone.</p>`;
  }

  const VIEWS = { meetings: renderMeetings, dashboard: renderDashboard, tasks: renderAllTasks, my: renderMyTasks, kanban: renderKanban, calendar: renderCalendar, initiatives: renderInitiatives, initiative: renderInitiativeDetail, projects: renderProjects, project: renderProjectDetail, activity: renderActivity, team: renderTeam, settings: renderSettings };

  /* ------------------------------------------------------------------
   *  Task drawer (details, threaded discussion, activity)
   * ---------------------------------------------------------------- */
  function openDrawer(id, tab) {
    S.drawer = { id, tab: tab || 'details', detail: null, loading: true, replyTo: null, editId: null, stale: false };
    if (S.drawer.tab === 'discussion') enterDiscussion(id);
    $('#drawerScrim').hidden = false;
    const d = $('#drawer');
    d.classList.add('open'); d.setAttribute('aria-hidden', 'false');
    renderDrawer();
    loadDrawerDetail();
  }
  function closeDrawer(silent) {
    if (!S.drawer) return;
    S.drawer = null;
    $('#drawerScrim').hidden = true;
    const d = $('#drawer');
    d.classList.remove('open'); d.setAttribute('aria-hidden', 'true');
    if (!silent && parseHash().q.task) navTask(null);
    if (S.pendingRender) renderView();
  }
  async function loadDrawerDetail(quiet) {
    const dr = S.drawer;
    if (!dr) return;
    try {
      const d = await api('getTask', { id: dr.id });
      if (S.drawer !== dr) return;
      dr.detail = d; dr.loading = false; dr.stale = false;
      upsert('tasks', d.task);
      if (dr.tab === 'discussion') markSeen(dr.id);
      renderDrawer();
    } catch (e) {
      if (S.drawer !== dr) return;
      dr.loading = false;
      if (e.code === 'NOT_FOUND') dr.missing = true;
      else if (!quiet) showError(e, 'Could not load task');
      renderDrawer();
    }
  }
  function refreshDrawerFromData() {
    const dr = S.drawer;
    if (!dr || !dr.detail) return;
    const t = taskById(dr.id);
    const st = S.data.commentStats[dr.id] || { count: 0 };
    const known = dr.detail.comments.filter((c) => c.Status !== 'deleted').length;
    const changed = !t || t.Version !== dr.detail.task.Version || st.count !== known;
    if (!changed) return;
    const a = document.activeElement;
    if (a && $('#drawer').contains(a) && /TEXTAREA|INPUT/.test(a.tagName) && a.value) { dr.stale = true; renderDrawerStaleHint(); return; }
    loadDrawerDetail(true);
  }
  function renderDrawerStaleHint() {
    const h = $('#drawerStale');
    if (h) h.hidden = !(S.drawer && S.drawer.stale);
  }

  function renderDrawer() {
    mentionHide();
    const dr = S.drawer;
    const el = $('#drawer');
    if (!dr) { el.innerHTML = ''; return; }
    const t = (dr.detail && dr.detail.task) || taskById(dr.id);
    if (!t || dr.missing) {
      el.innerHTML = `<div class="drawer-head"><div class="row1"><span class="idtag">${esc(dr.id)}</span><div class="actions"><button class="icon-btn" data-action="closeDrawer" aria-label="Close">${icon('x')}</button></div></div></div>
        <div class="drawer-body">${dr.loading ? '<div class="loading-row"><div class="spinner dark"></div>Loading task…</div>' : emptyState('alert', 'Task not found', 'This task does not exist or was removed.')}</div>`;
      return;
    }
    const editable = canEditTask(t) && !t.Archived;
    const cCount = dr.detail ? dr.detail.comments.filter((c) => c.Status !== 'deleted').length : ((S.data.commentStats[t.TaskID] || {}).count || 0);
    const quick = (label, field, control) => `<div class="field"><label>${label}</label>${control}</div>`;
    el.innerHTML = `
      <div class="drawer-head">
        <div class="row1"><span class="idtag">${esc(t.TaskID)}</span>${t.Archived ? '<span class="tag">Archived</span>' : ''}${isOverdue(t) ? '<span class="tag tag-red">Overdue</span>' : ''}
          <div class="actions">
            ${editable ? `<button class="btn btn-sm" data-action="editTask" data-id="${esc(t.TaskID)}">${icon('edit', 'ic-sm')}Edit</button>` : ''}
            ${canCreateTask() ? `<button class="icon-btn sm" data-action="duplicateTask" data-id="${esc(t.TaskID)}" title="Duplicate" aria-label="Duplicate task">${icon('copy', 'ic-sm')}</button>` : ''}
            ${canArchiveTask(t) ? `<button class="icon-btn sm" data-action="archiveTask" data-id="${esc(t.TaskID)}" title="${t.Archived ? 'Restore' : 'Archive'}" aria-label="${t.Archived ? 'Restore' : 'Archive'} task">${icon(t.Archived ? 'refresh' : 'archive', 'ic-sm')}</button>` : ''}
            <button class="icon-btn sm" data-action="copyLink" data-id="${esc(t.TaskID)}" title="Copy link" aria-label="Copy link">${icon('link', 'ic-sm')}</button>
            ${isAdmin() ? `<button class="icon-btn sm danger-btn" data-action="deleteTask" data-id="${esc(t.TaskID)}" title="Delete permanently (admin)" aria-label="Delete task">${icon('trash', 'ic-sm')}</button>` : ''}
            <button class="icon-btn sm" data-action="closeDrawer" aria-label="Close">${icon('x')}</button>
          </div></div>
        <h2>${esc(t.Title)}</h2>
        <div class="quick">
          ${quick('Status', 'Status', editable ? `<select class="select" data-change="drawerField" data-field="Status">${opts(STATUSES, t.Status)}</select>` : statusBadge(t.Status))}
          ${quick('Priority', 'Priority', editable ? `<select class="select" data-change="drawerField" data-field="Priority">${opts(PRIORITIES, t.Priority)}</select>` : prioBadge(t.Priority))}
          ${quick('Assignee', 'AssignedTo', editable ? `<select class="select" data-change="drawerField" data-field="AssignedTo">${userOpts(t.AssignedTo)}</select>` : person(t.AssignedTo))}
          ${quick('Progress', 'Progress', editable && t.Status !== 'Completed' ? `<select class="select" data-change="drawerField" data-field="Progress">${opts([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((v) => ({ v, l: v + '%' })), Math.round(effProgress(t) / 10) * 10 === effProgress(t) ? effProgress(t) : '', Math.round(effProgress(t) / 10) * 10 === effProgress(t) ? undefined : effProgress(t) + '%')}</select>` : progressBar(effProgress(t), t.Status === 'Completed'))}
        </div>
      </div>
      <div class="tabs" role="tablist">
        <button role="tab" class="${dr.tab === 'details' ? 'on' : ''}" data-action="drawerTab" data-tab="details">Details</button>
        <button role="tab" class="${dr.tab === 'discussion' ? 'on' : ''}" data-action="drawerTab" data-tab="discussion">Discussion<span class="pill-count">${cCount}</span></button>
        <button role="tab" class="${dr.tab === 'activity' ? 'on' : ''}" data-action="drawerTab" data-tab="activity">Activity</button>
      </div>
      <div class="drawer-body" id="drawerBody">
        <div class="alert alert-blue" id="drawerStale" hidden>${icon('refresh')}<div>This task has new updates. <a href="javascript:void 0" data-action="reloadDrawer">Refresh</a></div></div>
        ${dr.tab === 'details' ? drawerDetails(t) : dr.tab === 'discussion' ? drawerDiscussion(t) : drawerActivity()}
      </div>`;
    renderDrawerStaleHint();
  }

  function drawerDetails(t) {
    const dr = S.drawer;
    const ini = initiative(t.InitiativeID), prj = project(t.ProjectID);
    const deps = dr.detail ? dr.detail.dependencies : list(t.DependsOn).map((id) => { const x = taskById(id); return { TaskID: id, Title: x ? x.Title : '', Status: x ? x.Status : '' }; });
    const dependents = dr.detail ? dr.detail.dependents : [];
    const openD = deps.filter((d) => OPEN(d.Status));
    const links = String(t.Links || '').split('\n').filter((l) => /^https?:\/\//i.test(l));
    const alerts = [];
    if (isOverdue(t)) alerts.push(`<div class="alert alert-red">${icon('alert')}<div>Overdue by ${plural(daysBetween(t.DueDate, today()), 'day')} — due ${fmtDate(t.DueDate, true)}.</div></div>`);
    if (t.Status === 'Blocked') alerts.push(`<div class="alert alert-red">${icon('alert')}<div>This task is <b>blocked</b>. Use the discussion to record what is needed to unblock it.</div></div>`);
    const oi = (S.data.commentStats[t.TaskID] || {}).openIssues || 0;
    if (oi) alerts.push(`<div class="alert alert-red">${icon('alert')}<div><b>${plural(oi, 'open issue')}</b> reported on this task. <a href="javascript:void 0" data-action="drawerTab" data-tab="discussion">See discussion</a></div></div>`);
    if (t.Status === 'Under Review') alerts.push(`<div class="alert alert-amber">${icon('clock')}<div>Awaiting review / feedback.</div></div>`);
    if (openD.length && OPEN(t.Status)) alerts.push(`<div class="alert alert-amber">${icon('link')}<div>Waiting on ${openD.map((d) => `<a href="javascript:void 0" data-action="openTask" data-id="${esc(d.TaskID)}">${esc(d.TaskID)}</a>`).join(', ')} to be completed.</div></div>`);
    return `${alerts.join('')}
      <div class="desc prewrap">${t.Description ? linkify(esc(t.Description)) : '<span class="muted">No description.</span>'}</div>
      <dl class="meta-grid">
        <dt>Initiative</dt><dd>${ini ? `<a href="#/initiatives/${esc(ini.InitiativeID)}">${esc(ini.Name)}</a>` : '<span class="faint">—</span>'}</dd>
        <dt>Project</dt><dd>${prj ? `<a href="#/projects/${esc(prj.ProjectID)}">${esc(prj.Name)}</a>` : '<span class="faint">—</span>'}</dd>
        <dt>Stage</dt><dd>${stagePill(effStage(t))}</dd>
        <dt>Meeting</dt><dd>${esc(t.Meeting || '—')}</dd>
        <dt>Category</dt><dd>${esc(t.Category || '—')}</dd>
        <dt>Assigned to</dt><dd>${person(t.AssignedTo)}</dd>
        <dt>Collaborators</dt><dd>${list(t.Collaborators).length ? `<div class="row">${list(t.Collaborators).map((c) => person(c)).join('')}</div>` : '<span class="faint">—</span>'}</dd>
        <dt>Created by</dt><dd>${person(t.CreatedBy)} <span class="muted">· ${esc(fmtDateTime(t.CreatedAt))}</span></dd>
        <dt>Start date</dt><dd>${fmtDate(t.StartDate, true)}</dd>
        <dt>Due date</dt><dd>${t.DueDate ? fmtDate(t.DueDate, true) : '—'} ${dueCell(t).includes('overdue') || isDueToday(t) ? '· ' + dueCell(t) : ''}</dd>
        <dt>Completed</dt><dd>${t.CompletedDate ? fmtDate(t.CompletedDate, true) : '<span class="faint">—</span>'}</dd>
        <dt>Depends on</dt><dd>${deps.length ? deps.map((d) => `<div><a href="javascript:void 0" data-action="openTask" data-id="${esc(d.TaskID)}">${esc(d.TaskID)}</a> ${esc(d.Title)} ${d.Status ? statusBadge(d.Status) : ''}</div>`).join('') : '<span class="faint">—</span>'}</dd>
        <dt>Blocking</dt><dd>${dependents.length ? dependents.map((d) => `<div><a href="javascript:void 0" data-action="openTask" data-id="${esc(d.TaskID)}">${esc(d.TaskID)}</a> ${esc(d.Title)}</div>`).join('') : '<span class="faint">—</span>'}</dd>
        <dt>Links</dt><dd>${links.length ? links.map((l) => `<div><a href="${esc(l)}" target="_blank" rel="noopener noreferrer">${icon('link', 'ic-sm')} ${esc(l.length > 60 ? l.slice(0, 59) + '…' : l)}</a></div>`).join('') : '<span class="faint">—</span>'}</dd>
        <dt>Last updated</dt><dd>${esc(fmtDateTime(t.UpdatedAt))} by ${esc(uname(t.UpdatedBy))}</dd>
      </dl>`;
  }

  function drawerActivity() {
    const dr = S.drawer;
    if (dr.loading && !dr.detail) return '<div class="loading-row"><div class="spinner dark sm"></div>Loading activity…</div>';
    return `<div class="card">${feedHtml(dr.detail ? dr.detail.activity : [])}</div>`;
  }

  const KINDS = {
    comment: { label: 'Comment', icon: 'chat', button: 'Post comment', placeholder: 'Add a comment or feedback… Type @ to tag someone (Ctrl+Enter to post)', hint: 'Type <b>@</b> to tag a teammate — they get a popup and notification.' },
    issue: { label: 'Report issue', icon: 'alert', button: 'Report issue', placeholder: 'What is blocking you? What help do you need? Type @ to tag someone who can help.', hint: 'Your team\'s managers and admins are notified (popup + email).' },
    note: { label: 'Note / instruction', icon: 'edit', button: 'Add note', placeholder: 'Add a note, guidance or instruction for the assignee… Type @ to tag someone.', hint: 'The assignee and collaborators are notified (popup + email).' }
  };
  function drawerDiscussion(t) {
    const dr = S.drawer;
    const draft = S.drafts['c:' + t.TaskID] || '';
    const kind = dr.kind || 'comment';
    const K = KINDS[kind];
    const composer = `<div class="kind-tabs" role="radiogroup" aria-label="Type of message">${Object.keys(KINDS).map((k) => `<button role="radio" aria-checked="${k === kind}" class="kind-tab k-${k} ${k === kind ? 'on' : ''}" data-action="setKind" data-kind="${k}">${icon(KINDS[k].icon, 'ic-sm')}${KINDS[k].label}</button>`).join('')}</div>
      <div class="composer k-${kind}"><textarea id="newComment" data-input="draft" data-key="c:${esc(t.TaskID)}" placeholder="${esc(K.placeholder)}" aria-label="${esc(K.label)}" maxlength="4000">${esc(draft)}</textarea>
      <div class="bar"><span class="hint">${K.hint}</span><div class="btns"><button class="btn ${kind === 'issue' ? 'btn-danger' : 'btn-primary'} btn-sm" data-action="postComment" data-task="${esc(t.TaskID)}">${esc(K.button)}</button></div></div></div>`;
    if (dr.loading && !dr.detail) return composer + '<div class="loading-row"><div class="spinner dark sm"></div>Loading discussion…</div>';
    const comments = dr.detail ? dr.detail.comments : [];
    const byParent = {};
    const byId = {};
    comments.forEach((c) => { byId[c.CommentID] = c; });
    comments.forEach((c) => { const p = c.ParentID && byId[c.ParentID] ? c.ParentID : ''; (byParent[p] = byParent[p] || []).push(c); });
    const hasLiveDesc = (c) => (byParent[c.CommentID] || []).some((x) => x.Status !== 'deleted' || hasLiveDesc(x));
    const seen = store.get(seenKey(), {})[t.TaskID + ':prev'] || '';
    const lastActivity = (c) => [c.CreatedAt].concat((byParent[c.CommentID] || []).map(lastActivity)).sort().pop();
    const renderC = (c, depth) => {
      if (c.Status === 'deleted' && !hasLiveDesc(c)) return '';
      const mine = c.AuthorEmail === S.me.email;
      const isNew = seen && c.CreatedAt > seen && !mine;
      const editing = dr.editId === c.CommentID;
      const kids = (byParent[c.CommentID] || []).slice().sort((a, b) => a.CreatedAt.localeCompare(b.CreatedAt));
      const parent = c.ParentID ? byId[c.ParentID] : null;
      const replyDraftKey = 'r:' + c.CommentID;
      const body = c.Status === 'deleted' ? '<div class="cmt-body deleted">This comment was deleted.</div>'
        : editing ? `<div class="composer inline-composer"><textarea id="edit-${esc(c.CommentID)}" aria-label="Edit comment" maxlength="4000">${esc(c.Body)}</textarea><div class="bar"><div class="btns"><button class="btn btn-sm" data-action="cancelEdit">Cancel</button><button class="btn btn-primary btn-sm" data-action="saveEdit" data-id="${esc(c.CommentID)}">Save</button></div></div></div>`
          : `<div class="cmt-body">${richText(c.Body)}</div>`;
      const kindTag = c.Kind === 'issue' ? (c.Resolved ? `<span class="kind-tag k-resolved">${icon('check', 'ic-sm')}Issue resolved</span>` : `<span class="kind-tag k-issue">${icon('alert', 'ic-sm')}Issue</span>`) : c.Kind === 'note' ? `<span class="kind-tag k-note">${icon('edit', 'ic-sm')}Note / instruction</span>` : '';
      const canResolve = c.Kind === 'issue' && c.Status !== 'deleted' && (isManager() || mine || t.AssignedTo === S.me.email || t.CreatedBy === S.me.email);
      const resolveBtn = canResolve ? `<button data-action="resolveIssue" data-id="${esc(c.CommentID)}" data-v="${c.Resolved ? '0' : '1'}">${icon(c.Resolved ? 'refresh' : 'check', 'ic-sm')}${c.Resolved ? 'Reopen issue' : 'Mark resolved'}</button>` : '';
      const actions = c.Status === 'deleted' || editing ? '' : `<div class="cmt-actions"><button data-action="replyTo" data-id="${esc(c.CommentID)}">${icon('reply', 'ic-sm')}${c.Kind === 'issue' ? 'Help / reply' : 'Reply'}</button>${resolveBtn}${mine ? `<button data-action="editComment" data-id="${esc(c.CommentID)}">${icon('edit', 'ic-sm')}Edit</button>` : ''}${mine || isAdmin() ? `<button data-action="deleteComment" data-id="${esc(c.CommentID)}">${icon('trash', 'ic-sm')}Delete</button>` : ''}</div>`;
      const reply = dr.replyTo === c.CommentID ? `<div class="composer inline-composer"><textarea id="reply-${esc(c.CommentID)}" data-input="draft" data-key="${esc(replyDraftKey)}" placeholder="${c.Kind === 'issue' ? 'Add guidance or an instruction for ' + esc(c.AuthorName) + '… Type @ to tag someone.' : 'Reply to ' + esc(c.AuthorName) + '… Type @ to tag someone.'}" aria-label="Reply" maxlength="4000">${esc(S.drafts[replyDraftKey] || '')}</textarea><div class="bar"><span class="hint">Ctrl+Enter to send</span><div class="btns"><button class="btn btn-sm" data-action="cancelReply">Cancel</button><button class="btn btn-primary btn-sm" data-action="postReply" data-id="${esc(c.CommentID)}" data-task="${esc(t.TaskID)}">Reply</button></div></div></div>` : '';
      const childHtml = kids.map((k) => renderC(k, depth + 1)).join('');
      return `<div class="cmt-wrap" data-cid="${esc(c.CommentID)}"><div class="cmt ${isNew ? 'is-new' : ''} ${c.Kind === 'issue' ? (c.Resolved ? 'cmt-resolved' : 'cmt-issue') : c.Kind === 'note' ? 'cmt-note' : ''}">${avatar(c.AuthorEmail)}<div class="cmt-main">
        ${kindTag ? `<div>${kindTag}${c.Resolved && c.ResolvedBy ? `<span class="time"> by ${esc(uname(c.ResolvedBy))} · ${esc(relTime(c.ResolvedAt))}</span>` : ''}</div>` : ''}
        <div class="cmt-head"><b>${esc(c.AuthorName || uname(c.AuthorEmail))}</b><span class="time" title="${esc(fmtDateTime(c.CreatedAt))}">${esc(relTime(c.CreatedAt))}</span>${c.Status === 'edited' ? `<span class="time" title="Edited ${esc(fmtDateTime(c.UpdatedAt))}">· edited</span>` : ''}${isNew ? '<span class="new-tag">New</span>' : ''}</div>
        ${depth >= 3 && parent ? `<div class="reply-to">↪ replying to ${esc(parent.AuthorName)}</div>` : ''}
        ${body}${actions}${reply}</div></div>
        ${childHtml ? (depth >= 3 ? childHtml : `<div class="cmt-replies">${childHtml}</div>`) : ''}</div>`;
    };
    const top = (byParent[''] || []).slice().sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));
    const threads = top.map((c) => renderC(c, 0)).join('');
    return composer + (threads ? `<div class="thread">${threads}</div>` : emptyState('chat', 'No comments yet', 'Start the discussion — ask a question, share feedback or record a decision.'));
  }

  /* ------------------------------------------------------------------
   *  Task mutations
   * ---------------------------------------------------------------- */
  async function changeTaskField(id, patch, opt) {
    opt = opt || {};
    const t = taskById(id);
    if (!t) return;
    const before = Object.assign({}, t);
    if (opt.optimistic) { Object.assign(t, patch); if (patch.Status === 'Completed') t.Progress = 100; renderView(); }
    try {
      const d = await write('saveTask', { id, version: before.Version, patch });
      upsert('tasks', d.task);
      if (!d.unchanged) toast(`${id} updated`, 'ok', { timeout: 2200 });
      rerender();
      if (S.drawer && S.drawer.id === id) loadDrawerDetail(true);
    } catch (e) {
      Object.assign(t, before);
      rerender();
      if (S.drawer && S.drawer.id === id) renderDrawer();
      if (e.code === 'CONFLICT') {
        if (e.details && e.details.latest) upsert('tasks', e.details.latest);
        toast(e.message, 'err', { action: 'Refresh', onAction: () => sync(true) });
        sync(true);
      } else if (e.code === 'VALIDATION') {
        const f = e.details && e.details.fields ? Object.values(e.details.fields)[0] : e.message;
        toast(f, 'err');
      } else showError(e, 'Not saved');
    }
  }

  async function duplicateTask(id) {
    try {
      const d = await write('duplicateTask', { id });
      upsert('tasks', d.task);
      rerender();
      toast(`Duplicated as ${d.task.TaskID}`, 'ok', { action: 'Open', onAction: () => navTask(d.task.TaskID) });
    } catch (e) { showError(e, 'Could not duplicate'); }
  }

  async function archiveTask(id) {
    const t = taskById(id);
    if (!t) return;
    const restore = !!t.Archived;
    const ok = await confirmDialog({ title: restore ? 'Restore task?' : 'Archive task?', message: restore ? `${id} will be visible in task lists again.` : `${id} “${t.Title}” will be hidden from boards and dashboards. It stays in Google Sheets and can be restored at any time.`, confirmText: restore ? 'Restore' : 'Archive', danger: !restore });
    if (!ok) return;
    try {
      const d = await write('archiveTask', { id, version: t.Version, archived: !restore });
      upsert('tasks', d.task);
      if (S.drawer && S.drawer.id === id) loadDrawerDetail(true);
      rerender();
      toast(restore ? `${id} restored` : `${id} archived`, 'ok', restore ? {} : { action: 'Undo', onAction: () => write('archiveTask', { id, version: d.task.Version, archived: false }).then((x) => { upsert('tasks', x.task); rerender(); }).catch(showError) });
    } catch (e) {
      if (e.code === 'CONFLICT') { toast(e.message, 'err'); sync(true); } else showError(e, 'Not saved');
    }
  }

  async function postComment(taskId, parentId, textarea, button, kind) {
    const body = textarea.value.trim();
    if (!body) { textarea.focus(); toast('Write something first.', 'warn'); return; }
    if (body.length > 4000) { toast('Comments are limited to 4,000 characters.', 'err'); return; }
    button.disabled = true;
    const label = button.innerHTML;
    button.innerHTML = '<span class="spinner"></span>Posting…';
    textarea.disabled = true;
    try {
      const d = await write('addComment', { taskId, parentId: parentId || '', body, kind: kind || 'comment' });
      delete S.drafts[parentId ? 'r:' + parentId : 'c:' + taskId];
      if (S.drawer && S.drawer.id === taskId && S.drawer.detail) {
        S.drawer.detail.comments = d.comments;
        S.drawer.replyTo = null;
        const st = S.data.commentStats[taskId] || (S.data.commentStats[taskId] = { count: 0 });
        st.count = d.comments.filter((c) => c.Status !== 'deleted').length; st.lastAt = d.comment.CreatedAt; st.lastBy = S.me.email;
        renderDrawer();
      }
      toast(kind === 'issue' ? 'Issue reported — your managers have been notified' : kind === 'note' ? 'Note added' : parentId ? 'Reply posted' : 'Comment posted', 'ok', { timeout: 2600 });
      if (S.drawer) S.drawer.kind = 'comment';
    } catch (e) {
      showError(e, 'Comment not saved');
      textarea.disabled = false; button.disabled = false; button.innerHTML = label;
    }
  }

  /* ------------------------------------------------------------------
   *  Generic form modal
   * ---------------------------------------------------------------- */
  function fieldHtml(f, value) {
    const id = 'f-' + f.name;
    const v = value === undefined || value === null ? (f.default !== undefined ? f.default : '') : value;
    let control = '';
    switch (f.type) {
      case 'textarea': control = `<textarea class="textarea" id="${id}" name="${f.name}" rows="${f.rows || 4}" maxlength="${f.max || 5000}" placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea>`; break;
      case 'select': control = `<select class="select" id="${id}" name="${f.name}">${opts(f.options, v, f.placeholder)}</select>`; break;
      case 'checkbox': control = `<label class="check"><input type="checkbox" id="${id}" name="${f.name}" ${v === true || String(v).toUpperCase() === 'TRUE' ? 'checked' : ''}>${esc(f.checkLabel || f.label)}</label>`; break;
      case 'checklist': {
        const sel = list(v);
        control = `<div class="checklist" id="${id}">${f.options.length ? f.options.map((o) => `<label class="check"><input type="checkbox" name="${f.name}" value="${esc(o.v)}" ${sel.includes(o.v) ? 'checked' : ''}>${esc(o.l)}</label>`).join('') : '<span class="faint">No options</span>'}</div>`;
        break;
      }
      case 'range': control = `<div class="range-row"><input type="range" min="0" max="100" step="5" value="${esc(v || 0)}" data-input="rangeSync" data-target="${id}" aria-label="${esc(f.label)}"><input class="input" type="number" min="0" max="100" id="${id}" name="${f.name}" value="${esc(v || 0)}" data-input="rangeSync" data-target="r-${id}"></div>`; break;
      default: control = `<input class="input" id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${esc(v)}" maxlength="${f.max || 500}" placeholder="${esc(f.placeholder || '')}" ${f.list ? `list="${f.list}"` : ''}>`;
    }
    return `<div class="field ${f.span ? 'span-2' : ''}" data-field="${f.name}">${f.type === 'checkbox' ? '' : `<label for="${id}">${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ''}</label>`}${control}${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}<span class="err" hidden></span></div>`;
  }
  function readField(form, f) {
    if (f.type === 'checklist') return $$(`input[name="${f.name}"]:checked`, form).map((i) => i.value).join(', ');
    const el = form.querySelector(`[name="${f.name}"]`);
    if (!el) return '';
    if (f.type === 'checkbox') return el.checked;
    if (f.type === 'number' || f.type === 'range') return el.value === '' ? '' : Number(el.value);
    return el.value.trim();
  }
  function openForm(o) {
    const m = openModal({
      title: o.title, size: o.size, sticky: true,
      body: `<form novalidate><div class="form-error" hidden></div><div class="form-grid">${o.fields.map((f) => fieldHtml(f, o.values[f.name])).join('')}</div>${o.extra || ''}<button type="submit" hidden></button></form>`,
      foot: `${o.footNote ? `<span class="left">${o.footNote}</span>` : ''}<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-submit>${esc(o.submitText || 'Save')}</button>`
    });
    const form = m.el.querySelector('form');
    const btn = m.el.querySelector('[data-submit]');
    const read = () => { const v = {}; o.fields.forEach((f) => { v[f.name] = readField(form, f); }); return v; };
    const showErrors = (errs, general) => {
      o.fields.forEach((f) => {
        const w = form.querySelector(`[data-field="${f.name}"]`);
        if (!w) return;
        const e = errs[f.name];
        w.classList.toggle('invalid', !!e);
        const er = w.querySelector('.err'); er.hidden = !e; er.textContent = e || '';
      });
      const fe = form.querySelector('.form-error'); fe.hidden = !general; fe.textContent = general || '';
      const firstBad = form.querySelector('.invalid input, .invalid select, .invalid textarea');
      if (firstBad) firstBad.focus();
    };
    const submit = async () => {
      if (btn.disabled) return;
      const v = read();
      const errs = {};
      o.fields.forEach((f) => { if (f.required && (v[f.name] === '' || v[f.name] === undefined)) errs[f.name] = f.label + ' is required.'; });
      if (o.validate) Object.assign(errs, o.validate(v) || {});
      if (Object.keys(errs).length) { showErrors(errs, 'Please correct the highlighted fields.'); return; }
      showErrors({}, '');
      btn.disabled = true;
      const label = btn.innerHTML;
      btn.innerHTML = '<span class="spinner"></span>Saving…';
      try {
        await o.onSubmit(v, m);
        m.close();
      } catch (e) {
        if (e.code === 'VALIDATION') showErrors((e.details && e.details.fields) || {}, e.message);
        else if (!e.handled) showErrors({}, e.message || String(e));
      } finally { btn.disabled = false; btn.innerHTML = label; }
    };
    btn.onclick = submit;
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    if (o.onChange) form.addEventListener('change', (e) => o.onChange(e.target.name, read(), form));
    return m;
  }

  /** Shown when the server rejects a save because someone else changed the record first. */
  function conflictDialog(e) {
    return new Promise((resolve) => {
      let done = false;
      const m = openModal({
        title: 'Someone else changed this record', size: 'sm',
        body: `<p>${esc(e.message)}</p><p class="muted mt-8">Choose <b>Apply my changes</b> to save your edits on top of the latest version, or <b>Discard mine</b> to keep theirs.</p>`,
        foot: '<button class="btn" data-discard>Discard mine</button><button class="btn btn-primary" data-apply>Apply my changes</button>',
        onClose: () => { if (!done) resolve('cancel'); }
      });
      m.el.querySelector('[data-apply]').onclick = () => { done = true; m.close(); resolve('apply'); };
      m.el.querySelector('[data-discard]').onclick = () => { done = true; m.close(); resolve('discard'); };
    });
  }
  async function saveWithConflict(action, payload, kind) {
    try { return await write(action, payload); }
    catch (e) {
      if (e.code !== 'CONFLICT') throw e;
      const latest = e.details && e.details.latest;
      if (latest) upsert(kind, latest);
      const choice = await conflictDialog(e);
      if (choice === 'apply' && latest) return write(action, Object.assign({}, payload, { version: latest.Version }));
      sync(true);
      const err = new Error('Not saved.'); err.handled = true;
      throw err;
    }
  }

  function changedOnly(orig, v) {
    if (!orig) return v;
    const out = {};
    Object.keys(v).forEach((k) => { const a = orig[k] === undefined || orig[k] === null ? '' : String(orig[k]); const b = v[k] === undefined || v[k] === null ? '' : String(v[k]); if (a !== b) out[k] = v[k]; });
    return out;
  }

  /* ---------- Task form ---------- */
  function openTaskForm(t, preset) {
    preset = preset || {};
    const isNew = !t;
    const values = t ? Object.assign({}, t, { Progress: effProgress(t) }) : Object.assign({ Status: 'Not Started', Priority: 'Medium', Progress: 0, AssignedTo: S.me.role === 'Viewer' ? '' : S.me.email, DueDate: addDays(today(), 7), StartDate: today() }, preset);
    const others = S.data.tasks.filter((x) => !x.Archived && (!t || x.TaskID !== t.TaskID));
    const fields = [
      { name: 'Title', label: 'Title', required: true, span: true, max: 200, placeholder: 'e.g. Finalise nurse onboarding checklist' },
      { name: 'Description', label: 'Description', type: 'textarea', span: true, rows: 4, hint: 'Context, acceptance criteria, decisions. Do not include patient information.' },
      { name: 'InitiativeID', label: 'Initiative', type: 'select', options: S.data.initiatives.filter((i) => !i.Archived || i.InitiativeID === values.InitiativeID).map((i) => ({ v: i.InitiativeID, l: i.Name })), placeholder: '— None —' },
      { name: 'ProjectID', label: 'Project', type: 'select', options: S.data.projects.filter((p) => !p.Archived && (!values.InitiativeID || !p.InitiativeID || p.InitiativeID === values.InitiativeID)).map((p) => ({ v: p.ProjectID, l: p.Name })), placeholder: '— None —' },
      { name: 'Category', label: 'Category / department', type: 'select', options: settingList('CATEGORIES'), placeholder: '— Select —' },
      { name: 'Team', label: 'Team', type: 'select', options: settingList('DEPARTMENTS'), placeholder: '— From assignee —' },
      { name: 'AssignedTo', label: 'Assigned to', type: 'select', options: activeUsers().map((u) => ({ v: u.Email, l: u.Name + (u.Department ? ' · ' + u.Department : '') })), placeholder: 'TBD — not assigned yet' },
      { name: 'Priority', label: 'Priority', type: 'select', required: true, options: PRIORITIES },
      { name: 'Status', label: 'Status', type: 'select', required: true, options: STATUSES },
      { name: 'StartDate', label: 'Start date', type: 'date' },
      { name: 'DueDate', label: 'Due date', type: 'date', hint: 'Required unless the stage is Parked or Under Design.' },
      { name: 'Stage', label: 'Stage (meeting board)', type: 'select', options: TASK_STAGES, placeholder: '— Auto from status —' },
      { name: 'Meeting', label: 'Review meeting', type: 'select', options: settingList('FORUMS'), placeholder: '— No meeting —' },
      { name: 'Progress', label: 'Progress (%)', type: 'range', span: true },
      { name: 'Collaborators', label: 'Collaborators', type: 'checklist', options: activeUsers().map((u) => ({ v: u.Email, l: u.Name })), hint: 'They will be notified and can edit the task.' },
      { name: 'DependsOn', label: 'Depends on (task IDs)', placeholder: 'e.g. TSK-00012, TSK-00015', list: 'taskIdList', hint: 'Comma-separated. The task shows as waiting until these are completed.' },
      { name: 'Links', label: 'Supporting links', type: 'textarea', span: true, rows: 2, placeholder: 'https://… (one per line)', hint: 'Up to 10 http(s) links: documents, sheets, SOPs.' }
    ];
    openForm({
      title: isNew ? 'New task' : `Edit ${t.TaskID}`, values, fields,
      submitText: isNew ? 'Create task' : 'Save changes',
      footNote: isNew ? 'A unique Task ID is generated automatically.' : `Last updated ${esc(relTime(t.UpdatedAt))} by ${esc(uname(t.UpdatedBy))}`,
      extra: `<datalist id="taskIdList">${others.slice(0, 500).map((x) => `<option value="${esc(x.TaskID)}">${esc(x.Title)}</option>`).join('')}</datalist>`,
      validate: (v) => {
        const e = {};
        if (v.Title && v.Title.length < 3) e.Title = 'At least 3 characters.';
        if (v.StartDate && v.DueDate && v.StartDate > v.DueDate) e.DueDate = 'Due date cannot be before the start date.';
        if (!v.DueDate && !['Parked', 'Under Design', 'Done'].includes(v.Stage) && !['Completed', 'Cancelled'].includes(v.Status)) e.DueDate = 'Due date is required (optional for Parked / Under Design).';
        if (v.Progress !== '' && (v.Progress < 0 || v.Progress > 100)) e.Progress = 'Between 0 and 100.';
        const bad = String(v.Links || '').split('\n').map((l) => l.trim()).filter(Boolean).find((l) => !/^https?:\/\/\S+$/i.test(l));
        if (bad) e.Links = 'Not a valid link: ' + bad.slice(0, 50);
        const unknown = list(v.DependsOn).map((x) => x.toUpperCase()).find((x) => !S.data.tasks.some((y) => y.TaskID === x));
        if (unknown) e.DependsOn = 'Unknown task ID: ' + unknown;
        return e;
      },
      onChange: (name, v, form) => {
        if (name === 'InitiativeID') {
          const sel = form.querySelector('[name="ProjectID"]');
          const cur = sel.value;
          sel.innerHTML = prjOpts(cur, '— None —', v.InitiativeID);
        }
        if (name === 'ProjectID' && v.ProjectID) {
          const p = project(v.ProjectID);
          if (p && p.InitiativeID) form.querySelector('[name="InitiativeID"]').value = p.InitiativeID;
        }
        if (name === 'AssignedTo' && v.AssignedTo && !v.Team) { const d = user(v.AssignedTo).Department; if (d) form.querySelector('[name="Team"]').value = d; }
        if (name === 'Status' && v.Status === 'Completed') { form.querySelector('[name="Progress"]').value = 100; const r = form.querySelector('input[type=range]'); if (r) r.value = 100; }
      },
      onSubmit: async (v) => {
        v.DependsOn = list(v.DependsOn).map((x) => x.toUpperCase()).join(', ');
        const patch = isNew ? v : changedOnly(Object.assign({}, t, { Progress: effProgress(t) }), v);
        if (!isNew && !Object.keys(patch).length) { toast('No changes to save.', 'warn'); return; }
        const d = await saveWithConflict('saveTask', isNew ? { patch } : { id: t.TaskID, version: t.Version, patch }, 'tasks');
        upsert('tasks', d.task);
        rerender();
        if (isNew) toast(`${d.task.TaskID} created`, 'ok', { action: 'Open', onAction: () => navTask(d.task.TaskID) });
        else { toast('Task saved'); if (S.drawer && S.drawer.id === t.TaskID) loadDrawerDetail(true); }
      }
    });
  }

  /* ---------- Initiative form ---------- */
  function openInitiativeForm(i) {
    const isNew = !i;
    const values = i ? Object.assign({}, i) : { Stage: 'Under Design', Priority: 'Medium', Owner: S.me.email, StartDate: today() };
    openForm({
      title: isNew ? 'New initiative' : `Edit ${i.InitiativeID}`, values, submitText: isNew ? 'Create initiative' : 'Save changes',
      fields: [
        { name: 'Name', label: 'Name', required: true, span: true, max: 150 },
        { name: 'Objective', label: 'Business objective', type: 'textarea', rows: 2, span: true, placeholder: 'The measurable outcome this initiative delivers' },
        { name: 'Description', label: 'Description', type: 'textarea', rows: 3, span: true },
        { name: 'Owner', label: 'Owner', type: 'select', required: true, options: activeUsers().map((u) => ({ v: u.Email, l: u.Name })), placeholder: '— Select —' },
        { name: 'Priority', label: 'Priority', type: 'select', options: PRIORITIES },
        { name: 'Stage', label: 'Stage', type: 'select', options: STAGES },
        { name: 'Category', label: 'Category', type: 'select', options: settingList('CATEGORIES'), placeholder: '— Select —' },
        { name: 'Forum', label: 'Review forum / meeting', type: 'select', options: settingList('FORUMS'), placeholder: '— None —' },
        { name: 'Members', label: 'Team members', type: 'checklist', options: activeUsers().map((u) => ({ v: u.Email, l: u.Name })) },
        { name: 'StartDate', label: 'Start date', type: 'date' },
        { name: 'TargetDate', label: 'Target completion', type: 'date' },
        { name: 'NeedleMover', label: 'Needle mover', type: 'checkbox', checkLabel: '★ Needle mover' },
        { name: 'WeeklyFocus', label: "This week's focus", type: 'checkbox', checkLabel: "◎ This week's focus" },
        { name: 'RedFlag', label: 'Red flag', span: true, placeholder: 'Leave empty unless there is a red flag to escalate' },
        { name: 'Milestones', label: 'Key milestones', type: 'textarea', rows: 3, span: true, placeholder: '2026-11-15 | Pilot launched | done\n2026-12-01 | Roll-out complete', hint: 'One per line: yyyy-mm-dd | milestone | done (optional)' },
        { name: 'Risks', label: 'Risks & blockers', type: 'textarea', rows: 2, span: true }
      ],
      validate: (v) => (v.StartDate && v.TargetDate && v.StartDate > v.TargetDate ? { TargetDate: 'Target cannot be before the start date.' } : {}),
      onSubmit: async (v) => {
        const patch = isNew ? v : changedOnly(i, v);
        if (!isNew && !Object.keys(patch).length) { toast('No changes to save.', 'warn'); return; }
        const payload = isNew ? { patch } : { id: i.InitiativeID, version: i.Version, patch };
        let d;
        try { d = await saveWithConflict('saveInitiative', payload, 'initiatives'); }
        catch (e) {
          if (e.code !== 'STAGE_CAP') throw e;
          const ok = await confirmDialog({ title: 'Stage cap reached', message: e.message, confirmText: 'Move anyway' });
          if (!ok) { const x = new Error('Not saved.'); x.handled = true; throw x; }
          d = await write('saveInitiative', Object.assign({ force: true }, payload));
        }
        upsert('initiatives', d.initiative);
        rerender();
        toast(isNew ? `${d.initiative.InitiativeID} created` : 'Initiative saved');
        if (isNew) go('#/initiatives/' + d.initiative.InitiativeID);
      }
    });
  }

  /* ---------- Project form ---------- */
  function openProjectForm(p) {
    const isNew = !p;
    const values = p ? Object.assign({}, p) : { Status: 'Planning', Owner: S.me.email, StartDate: today() };
    openForm({
      title: isNew ? 'New project' : `Edit ${p.ProjectID}`, values, size: 'sm', submitText: isNew ? 'Create project' : 'Save changes',
      fields: [
        { name: 'Name', label: 'Name', required: true, span: true },
        { name: 'Description', label: 'Description', type: 'textarea', rows: 3, span: true },
        { name: 'InitiativeID', label: 'Initiative', type: 'select', options: S.data.initiatives.filter((x) => !x.Archived).map((x) => ({ v: x.InitiativeID, l: x.Name })), placeholder: '— None —', span: true },
        { name: 'Owner', label: 'Owner', type: 'select', required: true, options: activeUsers().map((u) => ({ v: u.Email, l: u.Name })), placeholder: '— Select —' },
        { name: 'Status', label: 'Status', type: 'select', options: PROJECT_STATUSES },
        { name: 'StartDate', label: 'Start date', type: 'date' },
        { name: 'TargetDate', label: 'Target date', type: 'date' }
      ],
      onSubmit: async (v) => {
        const patch = isNew ? v : changedOnly(p, v);
        if (!isNew && !Object.keys(patch).length) { toast('No changes to save.', 'warn'); return; }
        const d = await saveWithConflict('saveProject', isNew ? { patch } : { id: p.ProjectID, version: p.Version, patch }, 'projects');
        upsert('projects', d.project);
        rerender();
        toast(isNew ? `${d.project.ProjectID} created` : 'Project saved');
      }
    });
  }

  /* ---------- User form (admin) ---------- */
  function openUserForm(u) {
    const isNew = !u;
    openForm({
      title: isNew ? 'Add team member' : 'Edit ' + u.Name, size: 'sm', submitText: isNew ? 'Create profile' : 'Save',
      footNote: isNew ? 'They can sign in straight away with this email and will see their own name and tasks.' : '',
      values: u ? Object.assign({}, u) : { Role: 'Member', Active: true, Department: user(S.me.email).Department || '' },
      fields: [
        { name: 'Email', label: 'Google account email', type: 'email', required: true, span: true, placeholder: 'name@justlife.com', hint: isNew ? 'Must be the Google account they sign in with.' : 'Changing it updates every task, comment and record that uses the old email.' },
        { name: 'Name', label: 'Full name', required: true, span: true },
        { name: 'Role', label: 'Role', type: 'select', options: isAdmin() ? ROLES : ['Member', 'Viewer'], hint: isAdmin() ? '' : 'Managers can add Members and Viewers.' },
        { name: 'Department', label: 'Team', type: 'select', options: settingList('DEPARTMENTS'), placeholder: '— Select —' },
        { name: 'Title', label: 'Job title (optional)', span: true },
        { name: 'Active', label: 'Active', type: 'checkbox', checkLabel: 'Active (can sign in)' }
      ],
      validate: (v) => (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.Email) ? { Email: 'Enter a valid email.' } : {}),
      onSubmit: async (v) => {
        if (!isNew && v.Email.toLowerCase() !== u.Email) {
          const r = await write('renameUser', { oldEmail: u.Email, newEmail: v.Email.toLowerCase() });
          toast(`Email updated in ${r.changed} records`);
        }
        const d = await write('saveUser', { email: v.Email.toLowerCase(), patch: { Name: v.Name, Role: v.Role, Department: v.Department, Title: v.Title, Active: v.Active } });
        upsert('users', d.user);
        rerender();
        toast(isNew ? 'User added' : 'User saved');
      }
    });
  }

  /* ------------------------------------------------------------------
   *  Notifications, user menu, global search
   * ---------------------------------------------------------------- */
  function renderNotifications() {
    const ns = S.data.notifications;
    const unread = ns.filter((n) => !n.Read).length;
    const ic = { MENTION: 'chat', ISSUE: 'alert', NOTE: 'edit', RESOLVED: 'check', NOT_STARTED: 'clock', ASSIGNED: 'user', REASSIGNED: 'user', COMMENT: 'chat', REPLY: 'reply', DUE_SOON: 'clock', OVERDUE: 'alert', BLOCKED: 'alert', COMPLETED: 'check' };
    $('#notifPop').innerHTML = `<div class="head"><h3>Notifications</h3>${unread ? `<span class="tag">${unread} new</span><button class="btn btn-xs" data-action="markAllRead">Mark all read</button>` : ''}</div>
      ${desktopSupported() && Notification.permission !== 'granted' ? `<div class="notif-desktop">${icon('bell', 'ic-sm')}<span>${Notification.permission === 'denied' ? 'Desktop popups are blocked in this browser (allow via the 🔒 icon in the address bar).' : 'Get desktop popups for tags and new tasks.'}</span>${Notification.permission === 'default' ? '<button class="btn btn-xs btn-primary" data-action="enableDesktop">Turn on</button>' : ''}</div>` : ''}
      <div class="notif-list">${ns.length ? ns.map((n) => `<div class="notif ${n.Read ? '' : 'unread'}" data-action="openNotification" data-id="${esc(n.NotificationID)}"><span class="udot"></span><span class="feed-ic ${/OVERDUE|BLOCKED|ISSUE/.test(n.Type) ? 'red' : /COMPLETED|RESOLVED/.test(n.Type) ? 'green' : /DUE_SOON|NOT_STARTED/.test(n.Type) ? 'amber' : /MENTION|NOTE/.test(n.Type) ? 'teal' : ''}">${icon(ic[n.Type] || 'bell')}</span>
        <div style="min-width:0"><div class="msg">${esc(n.Message)}</div><div class="time">${esc(relTime(n.CreatedAt))}</div></div></div>`).join('') : emptyState('bell', 'You are all caught up', 'Assignments, comments, replies and deadlines will show up here.')}</div>`;
  }
  async function markRead(ids, all) {
    S.data.notifications.forEach((n) => { if (all || ids.includes(n.NotificationID)) n.Read = true; });
    updateChrome();
    try { await api('markNotifications', all ? { all: true } : { ids }); } catch (e) { /* non-critical */ }
  }
  function renderUserMenu() {
    const u = user(S.me.email);
    $('#userPop').innerHTML = `<div class="who">${avatar(S.me.email, 'lg')}<div style="min-width:0"><b>${esc(S.me.name)}</b><div class="muted" style="font-size:12px;overflow:hidden;text-overflow:ellipsis">${esc(S.me.email)}</div><div class="muted" style="font-size:12px">${esc(S.me.role)}${u.Department ? ' · ' + esc(u.Department) : ''}</div></div></div>
      <a class="menu-item" href="#/my">${icon('user')}My tasks</a><a class="menu-item" href="#/settings" data-action="settingsTab" data-tab="profile">${icon('settings')}Settings</a>
      <button class="menu-item danger" data-action="signOut">${icon('logout')}Sign out</button>`;
  }
  function hidePopovers(except) { ['#notifPop', '#userPop'].forEach((s) => { if (s !== except) $(s).hidden = true; }); }

  let searchSel = -1;
  function searchResults(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const out = [];
    S.data.tasks.forEach((t) => {
      if (t.Archived) return;
      const hay = (t.TaskID + ' ' + t.Title + ' ' + t.Description + ' ' + uname(t.AssignedTo)).toLowerCase();
      if (hay.includes(q)) out.push({ score: t.TaskID.toLowerCase() === q ? 0 : t.Title.toLowerCase().includes(q) ? 1 : 2, html: `${statusBadge(t.Status)}<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><b>${esc(t.TaskID)}</b> ${esc(t.Title)}</span><span class="sr-kind">${esc(uname(t.AssignedTo))}</span>`, act: () => navTask(t.TaskID) });
    });
    S.data.initiatives.forEach((i) => { if (!i.Archived && (i.InitiativeID + ' ' + i.Name + ' ' + i.Objective).toLowerCase().includes(q)) out.push({ score: 1, html: `${icon('target')}<span><b>${esc(i.Name)}</b></span><span class="sr-kind">Initiative</span>`, act: () => go('#/initiatives/' + i.InitiativeID) }); });
    S.data.projects.forEach((p) => { if (!p.Archived && (p.ProjectID + ' ' + p.Name).toLowerCase().includes(q)) out.push({ score: 1, html: `${icon('folder')}<span><b>${esc(p.Name)}</b></span><span class="sr-kind">Project</span>`, act: () => go('#/projects/' + p.ProjectID) }); });
    activeUsers().forEach((u) => { if ((u.Name + ' ' + u.Email).toLowerCase().includes(q)) out.push({ score: 2, html: `${avatar(u.Email, 'sm')}<span><b>${esc(u.Name)}</b></span><span class="sr-kind">Person · open tasks</span>`, act: () => applyTaskPreset({ assignee: u.Email, status: 'open' }) }); });
    return out.sort((a, b) => a.score - b.score).slice(0, 10);
  }
  let lastResults = [];
  function renderSearch() {
    const input = $('#globalSearch');
    const box = $('#searchResults');
    const q = input.value;
    if (!q.trim()) { box.hidden = true; return; }
    lastResults = searchResults(q);
    box.hidden = false;
    box.innerHTML = (lastResults.length ? lastResults.map((r, i) => `<div class="sr-item ${i === searchSel ? 'active' : ''}" data-sr="${i}">${r.html}</div>`).join('') : '<div class="sr-empty">No matches</div>') +
      `<div class="sr-item" data-sr="all">${icon('search')}<span>Search all tasks for “${esc(q)}”</span><span class="sr-kind">Enter</span></div>`;
  }
  function runSearchItem(idx) {
    const q = $('#globalSearch').value;
    $('#searchResults').hidden = true;
    if (idx === 'all' || idx === -1 || !lastResults[idx]) applyTaskPreset({ q });
    else lastResults[idx].act();
    $('#globalSearch').value = ''; searchSel = -1;
    $('#globalSearch').blur();
  }

  function applyTaskPreset(preset) {
    S.filters.all = Object.assign(defaultTaskFilter(), preset);
    if (S.route.view === 'tasks') renderView(); else go('#/tasks');
  }

  function exportCsv(scope) {
    const f = S.filters[scope];
    const rows = sortTasks(filterTasks(f, scope === 'my' ? myBase(f.tab) : S.data.tasks), f.sort, f.dir);
    const cols = ['TaskID', 'Title', 'Status', 'Priority', 'AssignedTo', 'Collaborators', 'InitiativeID', 'ProjectID', 'Category', 'StartDate', 'DueDate', 'CompletedDate', 'Progress', 'CreatedBy', 'CreatedAt', 'UpdatedAt'];
    const cell = (v) => { let s = String(v === null || v === undefined ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const csv = [cols.join(',')].concat(rows.map((t) => cols.map((c) => cell(t[c])).join(','))).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `tasks-${today()}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast(`Exported ${rows.length} tasks`);
  }

  /* ------------------------------------------------------------------
   *  Event wiring
   * ---------------------------------------------------------------- */
  const ACTIONS = {
    go: (el) => go(el.dataset.href),
    openTask: (el) => navTask(el.dataset.id, el.dataset.tab),
    closeDrawer: () => closeDrawer(),
    reloadDrawer: () => loadDrawerDetail(),
    drawerTab: (el) => { S.drawer.tab = el.dataset.tab; if (el.dataset.tab === 'discussion') { enterDiscussion(S.drawer.id); rerenderChromeOnly(); } renderDrawer(); },
    newTask: (el) => { if (!canCreateTask()) return toast('Viewers cannot create tasks.', 'warn'); openTaskForm(null, { InitiativeID: el.dataset.initiative || '', ProjectID: el.dataset.project || '', AssignedTo: el.dataset.assignee || S.me.email, Meeting: el.dataset.meeting || '', Stage: el.dataset.stage || '' }); },
    editTask: (el) => { const t = taskById(el.dataset.id); if (t) openTaskForm(t); },
    duplicateTask: (el) => duplicateTask(el.dataset.id),
    archiveTask: (el) => archiveTask(el.dataset.id),
    deleteTask: async (el) => {
      const id = el.dataset.id, t = taskById(id);
      if (!t || !isAdmin()) return;
      const n = (S.data.commentStats[id] || {}).count || 0;
      if (!(await confirmDialog({ title: `Delete ${id} permanently?`, message: `“${t.Title}”${n ? ` and its ${plural(n, 'comment')}` : ''} will be removed from the board for everyone. A recovery copy is kept in the DeletedTasks tab of the spreadsheet. Tip: use Archive if you only want to hide it.`, confirmText: 'Delete task', danger: true }))) return;
      try {
        await write('deleteTask', { id });
        S.data.tasks = S.data.tasks.filter((x) => x.TaskID !== id);
        if (S.drawer && S.drawer.id === id) closeDrawer();
        rerender();
        toast(`${id} deleted`);
      } catch (e) { showError(e, 'Not deleted'); }
    },
    copyLink: (el) => { const url = location.href.split('#')[0] + '#/tasks?task=' + encodeURIComponent(el.dataset.id); (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => toast('Link copied')).catch(() => toast(url, 'warn', { timeout: 8000 })); },
    postComment: (el) => postComment(el.dataset.task, '', $('#newComment'), el, (S.drawer && S.drawer.kind) || 'comment'),
    postReply: (el) => { const parent = S.drawer && S.drawer.detail && S.drawer.detail.comments.find((c) => c.CommentID === el.dataset.id); postComment(el.dataset.task, el.dataset.id, $('#reply-' + CSS.escape(el.dataset.id)), el, parent && parent.Kind === 'issue' ? 'note' : 'comment'); },
    setKind: (el) => { S.drawer.kind = el.dataset.kind; const ta = $('#newComment'); const v = ta ? ta.value : ''; renderDrawer(); const n = $('#newComment'); if (n) { n.value = v; n.focus(); } },
    resolveIssue: async (el) => {
      el.disabled = true;
      try { const d = await write('resolveIssue', { id: el.dataset.id, resolved: el.dataset.v === '1' }); S.drawer.detail.comments = d.comments; renderDrawer(); toast(el.dataset.v === '1' ? 'Issue marked resolved' : 'Issue reopened'); }
      catch (e) { el.disabled = false; showError(e, 'Not saved'); }
    },
    replyTo: (el) => { S.drawer.replyTo = el.dataset.id; S.drawer.editId = null; renderDrawer(); const ta = $('#reply-' + CSS.escape(el.dataset.id)); if (ta) ta.focus(); },
    cancelReply: () => { S.drawer.replyTo = null; renderDrawer(); },
    editComment: (el) => { S.drawer.editId = el.dataset.id; S.drawer.replyTo = null; renderDrawer(); const ta = $('#edit-' + CSS.escape(el.dataset.id)); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } },
    cancelEdit: () => { S.drawer.editId = null; renderDrawer(); },
    saveEdit: async (el) => {
      const ta = $('#edit-' + CSS.escape(el.dataset.id));
      const body = ta.value.trim();
      if (!body) return toast('Comment cannot be empty.', 'warn');
      el.disabled = true;
      try { const d = await write('editComment', { id: el.dataset.id, body }); S.drawer.detail.comments = d.comments; S.drawer.editId = null; renderDrawer(); toast('Comment updated'); }
      catch (e) { el.disabled = false; showError(e, 'Not saved'); }
    },
    deleteComment: async (el) => {
      if (!(await confirmDialog({ title: 'Delete comment?', message: 'The comment text will be removed for everyone. Replies stay visible. This cannot be undone.', confirmText: 'Delete', danger: true }))) return;
      try { const d = await write('deleteComment', { id: el.dataset.id }); S.drawer.detail.comments = d.comments; renderDrawer(); toast('Comment deleted'); }
      catch (e) { showError(e, 'Not deleted'); }
    },
    importPreview: async (el) => {
      const text = $('#importText').value;
      S.importState.text = text;
      const { rows } = mapImport(text);
      if (!rows.length) return toast('No rows with a Title found. Paste rows including a header line.', 'warn');
      el.disabled = true;
      try { S.importState.preview = await importChunks(rows, true); renderView(); }
      catch (e) { showError(e, 'Preview failed'); } finally { el.disabled = false; }
    },
    importRun: async (el) => {
      const { rows } = mapImport(S.importState.text);
      if (!(await confirmDialog({ title: 'Import tasks?', message: `${S.importState.preview.importable} tasks will be created in Google Sheets and assignees will be notified.`, confirmText: 'Import' }))) return;
      el.disabled = true; el.innerHTML = '<span class="spinner"></span>Importing…';
      try { const r = await importChunks(rows, false); S.importState.preview = r; S.importState.text = ''; toast(`${r.imported} imported${r.updated ? `, ${r.updated} updated` : ''}`); renderView(); }
      catch (e) { el.disabled = false; showError(e, 'Import failed'); }
    },
    ownerChip: (el) => { const p = JSON.parse(el.dataset.preset); const f = S.filters.all; const same = f.team === p.team && (f.assignee || '') === (p.assignee || ''); Object.assign(f, { team: same ? '' : p.team, assignee: same ? '' : (p.assignee || ''), page: 1 }); renderView(); },
    kpi: (el) => applyTaskPreset(Object.assign(dashCarry(), JSON.parse(el.dataset.preset || '{}'))),
    filterTasks: (el) => applyTaskPreset(Object.assign(S.route.view === 'dashboard' ? dashCarry() : {}, JSON.parse(el.dataset.preset || '{}'))),
    resetDash: () => { S.filters.dash = { range: 'all', from: '', to: '', initiative: '', project: '', status: '', priority: '', assignee: '' }; renderView(); },
    sort: (el) => { const f = S.filters[el.dataset.scope]; if (f.sort === el.dataset.key) f.dir = -f.dir; else { f.sort = el.dataset.key; f.dir = 1; } refreshTable(el.dataset.scope); },
    page: (el) => { const f = S.filters[el.dataset.scope]; f.page += Number(el.dataset.dir); refreshTable(el.dataset.scope); $('#tableArea').scrollIntoView({ block: 'start', behavior: 'smooth' }); },
    resetTaskFilter: (el) => { const s = el.dataset.scope; const keep = s === 'my' ? { tab: S.filters.my.tab } : {}; S.filters[s] = Object.assign(defaultTaskFilter(), keep); renderView(); },
    myTab: (el) => { S.filters.my.tab = el.dataset.tab; S.filters.my.page = 1; if (el.dataset.tab === 'assigned') S.filters.my.assignee = ''; renderView(); },
    exportCsv: (el) => exportCsv(el.dataset.scope),
    calNav: (el) => { const d = +el.dataset.d; if (!d) { const t = today(); S.cal.y = +t.slice(0, 4); S.cal.m = +t.slice(5, 7) - 1; } else { S.cal.m += d; if (S.cal.m < 0) { S.cal.m = 11; S.cal.y--; } if (S.cal.m > 11) { S.cal.m = 0; S.cal.y++; } } renderView(); },
    calMine: (el) => { S.cal.mine = el.dataset.v === '1'; renderView(); },
    calDay: (el) => {
      const d = el.dataset.date;
      const ts = S.data.tasks.filter((t) => !t.Archived && t.DueDate === d && (!S.cal.mine || t.AssignedTo === S.me.email || list(t.Collaborators).includes(S.me.email)) && (!S.cal.initiative || t.InitiativeID === S.cal.initiative));
      const m = openModal({ title: 'Due ' + fmtDate(d, true), size: 'sm', body: `<div class="list">${ts.map((t) => `<div class="list-item" data-action="openTask" data-id="${esc(t.TaskID)}">${avatar(t.AssignedTo, 'sm')}<div class="grow"><span class="t">${esc(t.Title)}</span><span class="s">${esc(t.TaskID)}</span></div>${statusBadge(t.Status)}</div>`).join('')}</div>` });
      m.el.addEventListener('click', (e) => { if (e.target.closest('[data-action="openTask"]')) m.close(); });
    },
    iniSet: (el) => { S.filters.ini[el.dataset.key] = el.dataset.v; renderView(); },
    mtgSet: (el) => { S.filters.mtg[el.dataset.key] = el.dataset.v; renderView(); },
    newInitiative: () => openInitiativeForm(null),
    editInitiative: (el) => openInitiativeForm(initiative(el.dataset.id)),
    archiveInitiative: (el) => archiveOwned('initiatives', 'archiveInitiative', initiative(el.dataset.id), 'InitiativeID', 'initiative'),
    newProject: () => openProjectForm(null),
    editProject: (el) => openProjectForm(project(el.dataset.id)),
    archiveProject: (el) => archiveOwned('projects', 'archiveProject', project(el.dataset.id), 'ProjectID', 'project'),
    actTab: (el) => { S.filters.act.tab = el.dataset.tab; renderView(); },
    settingsTab: (el) => { S.filters.settingsTab = el.dataset.tab; if (S.route.view === 'settings') renderView(); else go('#/settings'); hidePopovers(); },
    newUser: () => openUserForm(null),
    deleteUser: async (el) => {
      const u = user(el.dataset.email);
      const n = S.data.tasks.filter((t) => t.AssignedTo === u.Email && !t.Archived).length;
      if (!(await confirmDialog({ title: `Delete ${u.Name}?`, message: `${u.Email} will be removed from the board and can no longer sign in${n ? `. Their ${plural(n, 'task')} will become TBD (unassigned)` : ''}. Comments and history are kept.`, confirmText: 'Delete user', danger: true }))) return;
      try { const r = await write('deleteUser', { email: u.Email }); S.data.users = S.data.users.filter((x) => x.Email !== u.Email); delete S.userMap[u.Email]; rerender(); toast(`${u.Name} deleted${r.unassigned ? ` · ${r.unassigned} tasks now TBD` : ''}`); }
      catch (e) { showError(e, 'Not deleted'); }
    },
    editUser: (el) => openUserForm(user(el.dataset.email)),
    saveConfig: async (el) => {
      const values = {};
      $$('[data-cfg]').forEach((i) => { values[i.dataset.cfg] = i.value.trim(); });
      el.disabled = true;
      try { const d = await write('saveSettings', { values }); S.data.settings = Object.assign(S.data.settings, d.settings); toast(d.changed.length ? 'Configuration saved (' + d.changed.join(', ') + ')' : 'No changes to save', d.changed.length ? 'ok' : 'warn'); startPolling(); renderView(); }
      catch (e) { showError(e, 'Not saved'); } finally { el.disabled = false; }
    },
    syncNow: async () => { await sync(true); toast('Board is up to date', 'ok', { timeout: 1800 }); },
    openSidebar: () => $('#shell').classList.add('nav-open'),
    closeSidebar: () => $('#shell').classList.remove('nav-open'),
    toggleNotifications: () => { const p = $('#notifPop'); hidePopovers('#notifPop'); p.hidden = !p.hidden; if (!p.hidden) renderNotifications(); },
    toggleUserMenu: () => { const p = $('#userPop'); hidePopovers('#userPop'); p.hidden = !p.hidden; if (!p.hidden) renderUserMenu(); },
    markAllRead: () => markRead([], true),
    enableDesktop: () => enableDesktop(),
    openNotification: (el) => {
      const n = S.data.notifications.find((x) => x.NotificationID === el.dataset.id);
      hidePopovers();
      if (!n) return;
      if (!n.Read) markRead([n.NotificationID]);
      if (n.EntityType === 'Task') navTask(n.EntityID, /COMMENT|REPLY|MENTION|ISSUE|NOTE|RESOLVED/.test(n.Type) ? 'discussion' : 'details');
    },
    signOut: () => { hidePopovers(); signOut(); },
    retryLogin: () => showLogin()
  };
  function rerenderChromeOnly() { if (S.route.view === 'tasks' || S.route.view === 'my') refreshTable(S.route.view === 'my' ? 'my' : 'all'); }
  function dashCarry() { const f = S.filters.dash; const o = {}; ['initiative', 'project', 'priority', 'assignee'].forEach((k) => { if (f[k]) o[k] = f[k]; }); if (f.status) o.status = f.status; return o; }

  async function archiveOwned(kind, action, rec, key, label) {
    if (!rec) return;
    const restore = !!rec.Archived;
    if (!(await confirmDialog({ title: (restore ? 'Restore ' : 'Archive ') + label + '?', message: restore ? `“${rec.Name}” will be visible again.` : `“${rec.Name}” will be hidden from views. Linked tasks are not changed. You can restore it later.`, confirmText: restore ? 'Restore' : 'Archive', danger: !restore }))) return;
    try {
      const d = await write(action, { id: rec[key], version: rec.Version, archived: !restore });
      upsert(kind, d[label]);
      toast(`${rec[key]} ${restore ? 'restored' : 'archived'}`);
      if (!restore) go(kind === 'initiatives' ? '#/initiatives' : '#/projects'); else rerender();
    } catch (e) { if (e.code === 'CONFLICT') { toast(e.message, 'err'); sync(true); } else showError(e, 'Not saved'); }
  }

  const CHANGES = {
    dash: (el) => { S.filters.dash[el.dataset.key] = el.value; if (el.dataset.key === 'initiative') S.filters.dash.project = ''; renderView(); },
    taskFilter: (el) => { const f = S.filters[el.dataset.scope]; f[el.dataset.key] = el.type === 'checkbox' ? el.checked : el.value; if (el.dataset.key === 'initiative') f.project = ''; f.page = 1; renderView(); },
    pageSize: (el) => { const f = S.filters[el.dataset.scope]; f.size = +el.value; f.page = 1; refreshTable(el.dataset.scope); },
    userRole: async (el) => {
      const u = user(el.dataset.email), role = el.value;
      if (role === u.Role) return;
      if (!(await confirmDialog({ title: 'Change role?', message: `${u.Name} will become ${role}.`, confirmText: 'Change role' }))) { el.value = u.Role; return; }
      try { const d = await write('saveUser', { email: u.Email, patch: { Role: role } }); upsert('users', d.user); toast(`${u.Name} is now ${role}`); rerender(); }
      catch (e) { el.value = u.Role; showError(e, 'Role not changed'); }
    },
    quickStatus: (el) => changeTaskField(el.dataset.id, { Status: el.value }),
    drawerField: (el) => { const v = el.dataset.field === 'Progress' ? Number(el.value) : el.value; changeTaskField(S.drawer.id, { [el.dataset.field]: v }); },
    kanbanFilter: (el) => { S.filters.kanban[el.dataset.key] = el.value; renderView(); },
    calInit: (el) => { S.cal.initiative = el.value; renderView(); },
    actType: (el) => { S.filters.act.type = el.value; renderView(); }
  };

  let inputTimer = null;
  const debounce = (fn) => { clearTimeout(inputTimer); inputTimer = setTimeout(fn, 180); };
  const INPUTS = {
    taskFilter: (el) => { const f = S.filters[el.dataset.scope]; f[el.dataset.key] = el.value; f.page = 1; debounce(() => refreshTable(el.dataset.scope)); },
    kanbanFilter: (el) => { S.filters.kanban.q = el.value; debounce(() => { const pos = el.selectionStart; renderView(); const i = $('[data-input="kanbanFilter"]'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } }); },
    mtgSearch: (el) => { S.filters.mtg.q = el.value; debounce(() => { const pos = el.selectionStart; renderView(); const i = $('[data-input="mtgSearch"]'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } }); },
    iniSearch: (el) => { S.filters.ini.q = el.value; debounce(() => { $('#iniGroups').innerHTML = iniGroupsHtml(); }); },
    actSearch: (el) => { S.filters.act.q = el.value; debounce(() => { const pos = el.selectionStart; renderView(); const i = $('[data-input="actSearch"]'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } }); },
    draft: (el) => { S.drafts[el.dataset.key] = el.value; },
    importText: (el) => { if (S.importState) { S.importState.text = el.value; if (S.importState.preview) { S.importState.preview = null; const r = $('[data-action="importRun"]'); if (r) r.remove(); } } },
    rangeSync: (el) => { const other = el.dataset.target.startsWith('r-') ? el.parentElement.querySelector('input[type=range]') : document.getElementById(el.dataset.target); if (other) other.value = el.value; }
  };

  /* ------------------------------------------------------------------
   *  @mention picker for comment boxes
   * ---------------------------------------------------------------- */
  const MN = { box: null, ta: null, start: -1, items: [], sel: 0 };
  function mentionHide() { if (MN.box) MN.box.remove(); MN.box = null; MN.ta = null; MN.items = []; }
  function mentionCheck(ta) {
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const m = before.match(/(^|[\s(,])@([^\s@]{0,30})$/);
    if (!m) return mentionHide();
    const q = m[2].toLowerCase();
    const items = activeUsers().filter((u) => !q || u.Name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || u.Name.toLowerCase().startsWith(q) || u.Email.startsWith(q)).slice(0, 8);
    if (!items.length) return mentionHide();
    MN.ta = ta; MN.start = pos - m[2].length - 1; MN.items = items; MN.sel = Math.min(MN.sel, items.length - 1);
    if (!MN.box || MN.box.parentElement !== ta.parentElement) { mentionHide(); MN.ta = ta; MN.start = pos - m[2].length - 1; MN.items = items; MN.sel = 0; MN.box = document.createElement('div'); MN.box.className = 'mention-box'; MN.box.setAttribute('role', 'listbox'); ta.parentElement.appendChild(MN.box); }
    MN.box.style.top = (ta.offsetTop + ta.offsetHeight + 2) + 'px';
    MN.box.innerHTML = `<div class="mention-head">Tag a teammate</div>` + items.map((u, i) => `<div class="mention-item ${i === MN.sel ? 'on' : ''}" role="option" data-mi="${i}">${avatar(u.Email, 'sm')}<span><b>${esc(u.Name)}</b></span><span class="muted">${esc(u.Department || '')}</span></div>`).join('');
  }
  function mentionInsert(i) {
    const u = MN.items[i], ta = MN.ta;
    if (!u || !ta) return mentionHide();
    const pos = ta.selectionStart;
    const ins = '@' + u.Name + ' ';
    ta.value = ta.value.slice(0, MN.start) + ins + ta.value.slice(pos);
    const caret = MN.start + ins.length;
    ta.setSelectionRange(caret, caret);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    mentionHide();
    ta.focus();
  }

  function wireEvents() {
    document.addEventListener('input', (e) => { if (e.target.tagName === 'TEXTAREA' && e.target.closest('.composer') && !MN.inserting) mentionCheck(e.target); }, true);
    document.addEventListener('mousedown', (e) => { const it = e.target.closest('.mention-item'); if (it) { e.preventDefault(); mentionInsert(+it.dataset.mi); } else if (MN.box && !e.target.closest('.mention-box')) mentionHide(); }, true);
    document.addEventListener('keydown', (e) => {
      if (!MN.box || e.target !== MN.ta) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); MN.sel = (MN.sel + (e.key === 'ArrowDown' ? 1 : -1) + MN.items.length) % MN.items.length; mentionCheck(MN.ta); }
      else if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); mentionInsert(MN.sel); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); mentionHide(); }
    }, true);
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.pop-wrap')) hidePopovers();
      if (!e.target.closest('.search')) $('#searchResults').hidden = true;
      const sr = e.target.closest('[data-sr]');
      if (sr) { e.preventDefault(); runSearchItem(sr.dataset.sr === 'all' ? 'all' : +sr.dataset.sr); return; }
      const el = e.target.closest('[data-action]');
      if (!el) return;
      // Don't let clicks on controls inside a clickable row trigger the row.
      const ctrl = e.target.closest('select, input, textarea, label, a[href]:not([href^="javascript"]), button');
      if (ctrl && ctrl !== el && el.contains(ctrl) && !ctrl.dataset.action) return;
      const fn = ACTIONS[el.dataset.action];
      if (fn) {
        if (el.tagName === 'A' && el.getAttribute('href') && !el.getAttribute('href').startsWith('javascript') && el.dataset.action !== 'settingsTab') return fn(el, e);
        e.preventDefault();
        fn(el, e);
      }
    });
    document.addEventListener('change', (e) => { const el = e.target.closest('[data-change]'); if (el && CHANGES[el.dataset.change]) CHANGES[el.dataset.change](el, e); });
    document.addEventListener('input', (e) => { const el = e.target.closest('[data-input]'); if (el && INPUTS[el.dataset.input]) INPUTS[el.dataset.input](el, e); });
    document.addEventListener('submit', async (e) => {
      const f = e.target.closest('[data-form="testLogin"]');
      if (!f) return;
      e.preventDefault();
      const btn = f.querySelector('button[type=submit]');
      btn.disabled = true;
      loginMsg('Signing in…', 'info');
      try { await completeLogin({ testEmail: $('#testEmail').value.trim() }); } catch (err) { loginMsg(err.message); } finally { btn.disabled = false; }
    });
    document.addEventListener('focusout', () => { setTimeout(() => { const a = document.activeElement; if (S.pendingRender && !(a && $('#view').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName))) renderView(); }, 0); });
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && S.me) { e.preventDefault(); $('#globalSearch').focus(); return; }
      if (e.key === 'Escape') {
        if (modalStack.length) { modalStack[modalStack.length - 1].close(); return; }
        if (!$('#searchResults').hidden) { $('#searchResults').hidden = true; return; }
        hidePopovers();
        if (S.drawer) closeDrawer();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && e.target.tagName === 'TEXTAREA') {
        if (e.target.id === 'newComment') { e.preventDefault(); $('[data-action="postComment"]').click(); }
        else if (e.target.id.startsWith('reply-')) { e.preventDefault(); $('[data-action="postReply"]').click(); }
        else if (e.target.id.startsWith('edit-')) { e.preventDefault(); $('[data-action="saveEdit"]').click(); }
      }
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.kcard, .ini-card, .member')) { e.preventDefault(); e.target.click(); }
    });
    const gs = $('#globalSearch');
    gs.addEventListener('input', () => { searchSel = -1; renderSearch(); });
    gs.addEventListener('focus', renderSearch);
    gs.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); searchSel = Math.min(lastResults.length - 1, searchSel + 1); renderSearch(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); searchSel = Math.max(-1, searchSel - 1); renderSearch(); }
      else if (e.key === 'Enter') { e.preventDefault(); runSearchItem(searchSel >= 0 ? searchSel : 'all'); }
    });
    // Chart / bar tooltips
    let tip = null;
    document.addEventListener('mouseover', (e) => {
      const t = e.target.closest('[data-tip]');
      if (!t) { if (tip) { tip.remove(); tip = null; } return; }
      if (!tip) { tip = document.createElement('div'); tip.className = 'chart-tip'; document.body.appendChild(tip); }
      tip.textContent = t.dataset.tip;
    });
    document.addEventListener('mousemove', (e) => { if (tip) { tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 12) + 'px'; tip.style.top = (e.clientY + 14) + 'px'; } });
    window.addEventListener('hashchange', () => route());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.token && S.me && Date.now() - S.lastSync > 5000) sync(); });
    window.addEventListener('online', () => { if (S.token) sync(true); });
    window.addEventListener('beforeunload', (e) => { if (S.saving > 0) { e.preventDefault(); e.returnValue = ''; } });
    $('#syncState').addEventListener('click', () => sync(true));
  }

  /* ------------------------------------------------------------------
   *  Boot
   * ---------------------------------------------------------------- */
  async function start() {
    wireEvents();
    try {
      const saved = loadSession();
      if (saved) {
        S.token = saved.token; S.expiresAt = saved.expiresAt;
        bootMsg('Loading your board…');
        try { await loadAll(); enterApp(); return; }
        catch (e) { if (!AUTH_ERRORS.has(e.code)) { showLogin(e.message); return; } clearSession(); S.authLost = false; }
      }
      await showLogin();
    } catch (e) {
      console.error(e);
      bootMsg('Could not start: ' + e.message);
      $('#boot .spinner').hidden = true;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

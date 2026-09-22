// picossh admin dashboard: devices, SSH connections, zombies, the server process
// and activity charts, from /api/admin/*. Signs in like the app (password or
// Face ID); the cookie is shared, so signing in to either signs in to both.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const REFRESH_MS = 5000;
  const RANGE_KEY = 'picossh.admin.range';

  // ------------------------------------------------------------------ helpers

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') el.textContent = v;
      else if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
    return el;
  }

  const SVG = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, ...children) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null) el.setAttribute(k, v);
    for (const c of children.flat()) if (c) el.append(c);
    return el;
  }

  function bytes(n, digits = 1) {
    n = Number(n) || 0;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (Math.abs(n) >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${i === 0 ? Math.round(n) : n.toFixed(n >= 100 ? 0 : digits)} ${units[i]}`;
  }
  const rate = (n) => `${bytes(n)}/s`;

  function duration(ms) {
    const sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}m ${sec % 60}s`;
    const hrs = Math.floor(m / 60);
    if (hrs < 24) return `${hrs}h ${m % 60}m`;
    return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
  }
  const ago = (t, now) => (now - t < 5000 ? 'just now' : `${duration(now - t)} ago`);
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const clockSec = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dateTime = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'fetch', ...(body && { 'Content-Type': 'application/json' }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) throw Object.assign(new Error((data && data.error) || `HTTP ${res.status}`), { status: res.status });
    return data;
  }

  // ------------------------------------------------------------------ sign-in

  const passkeySupported = () => window.isSecureContext && !!window.PublicKeyCredential && !!navigator.credentials;
  const b64url = {
    toBuffer(str) {
      const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
      return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
    },
    fromBuffer(buf) {
      let bin = '';
      for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
  };

  function assertionToJSON(cred) {
    const r = cred.response;
    const response = {
      clientDataJSON: b64url.fromBuffer(r.clientDataJSON),
      authenticatorData: b64url.fromBuffer(r.authenticatorData),
      signature: b64url.fromBuffer(r.signature),
    };
    if (r.userHandle) response.userHandle = b64url.fromBuffer(r.userHandle);
    return {
      id: cred.id,
      rawId: b64url.fromBuffer(cred.rawId),
      type: cred.type,
      response,
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    };
  }

  // Safari wants the Face ID prompt close to the tap, so the options are
  // fetched when the sign-in page shows and reused while fresh.
  let loginOptions = null;
  async function prefetchOptions() {
    loginOptions = null;
    try {
      loginOptions = { at: Date.now(), options: await api('POST', '/api/passkeys/login/options') };
    } catch {}
  }

  async function passkeySignIn() {
    $('login-error').textContent = '';
    try {
      const cached = loginOptions;
      loginOptions = null;
      const options = cached && Date.now() - cached.at < 90000 ? cached.options : await api('POST', '/api/passkeys/login/options');
      const cred = await navigator.credentials.get({
        publicKey: {
          ...options,
          challenge: b64url.toBuffer(options.challenge),
          allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: b64url.toBuffer(c.id) })),
        },
      });
      if (!cred) throw new Error('No passkey returned');
      await api('POST', '/api/passkeys/login/verify', { response: assertionToJSON(cred) });
      signedIn();
    } catch (err) {
      $('login-error').textContent = err.name === 'NotAllowedError' ? 'Face ID was cancelled or timed out.' : err.message;
      prefetchOptions();
    }
  }

  async function showLogin(message) {
    stopPolling();
    $('view-dash').hidden = true;
    $('view-login').hidden = false;
    $('login-error').textContent = message || '';
    $('login-passkey').hidden = true;
    $('login-or').hidden = true;
    let count = 0;
    try {
      ({ count } = await api('GET', '/api/passkeys'));
    } catch {}
    const offer = passkeySupported() && count > 0;
    $('login-passkey').hidden = !offer;
    $('login-or').hidden = !offer;
    if (offer) prefetchOptions();
    else if (!matchMedia('(pointer: coarse)').matches) $('login-password').focus();
  }

  // The eye button in the password field, as in the app: shows what is typed
  // until pressed again. Material's visibility and visibility_off.
  const EYE = 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z';
  const EYE_OFF = 'M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78 3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z';
  const revealPath = s('path');
  const revealBtn = h('button', { type: 'button', class: 'reveal-btn' }, s('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, revealPath));
  const showPassword = (shown) => {
    $('login-password').type = shown ? 'text' : 'password';
    const label = shown ? 'Hide password' : 'Show password';
    revealBtn.setAttribute('aria-pressed', String(shown));
    revealBtn.setAttribute('aria-label', label);
    revealBtn.title = label;
    revealPath.setAttribute('d', shown ? EYE_OFF : EYE);
  };
  $('login-password').after(revealBtn);
  showPassword(false);
  revealBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keeps focus in the field
  revealBtn.addEventListener('click', () => showPassword($('login-password').type === 'password'));

  function signedIn() {
    $('login-password').value = '';
    showPassword(false);
    $('view-login').hidden = true;
    $('view-dash').hidden = false;
    startPolling();
    loadSettings();
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('login-submit');
    button.disabled = true;
    $('login-error').textContent = '';
    try {
      await api('POST', '/login', { password: $('login-password').value });
      signedIn();
    } catch (err) {
      $('login-error').textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
  $('login-passkey').addEventListener('click', passkeySignIn);
  $('signout').addEventListener('click', async () => {
    try {
      await api('POST', '/logout');
    } catch {}
    showLogin();
  });

  // ------------------------------------------------------------------ polling

  let overview = null;
  let history = null;
  let range = 3600;
  try {
    range = Number(localStorage.getItem(RANGE_KEY)) || 3600;
  } catch {}
  let timer = null;
  let lastHistoryAt = 0;

  async function refresh() {
    clearTimeout(timer);
    timer = null;
    try {
      const wantHistory = !history || Date.now() - lastHistoryAt >= Math.max(10000, (overview && overview.sampleMs) || 10000);
      const [o, hist] = await Promise.all([
        api('GET', '/api/admin/overview'),
        wantHistory ? api('GET', `/api/admin/history?range=${range}`) : null,
      ]);
      overview = o;
      if (hist) {
        history = hist;
        lastHistoryAt = Date.now();
      }
      $('dash-error').hidden = true;
      render();
    } catch (err) {
      if (err.status === 401) return showLogin();
      $('dash-error').textContent = `Could not reach the server: ${err.message}. Retrying…`;
      $('dash-error').hidden = false;
    }
    if (!document.hidden && !$('view-dash').hidden) timer = setTimeout(refresh, REFRESH_MS);
  }

  function startPolling() {
    history = null;
    refresh();
  }
  function stopPolling() {
    clearTimeout(timer);
    timer = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !$('view-dash').hidden && !timer) refresh();
  });

  for (const b of $('ranges').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.range) === range));
    b.addEventListener('click', () => {
      range = Number(b.dataset.range);
      try {
        localStorage.setItem(RANGE_KEY, String(range));
      } catch {}
      for (const other of $('ranges').querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === b));
      history = null;
      refresh();
    });
  }

  // ------------------------------------------------------------------ actions

  function confirmDialog(text, ok = 'Close') {
    const dialog = $('confirm');
    $('confirm-text').textContent = text;
    $('confirm-ok').textContent = ok;
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
      dialog.returnValue = '';
      dialog.showModal();
    });
  }

  async function closeSessions(which, text) {
    if (!(await confirmDialog(text))) return;
    try {
      await api('POST', '/api/admin/sessions/close', { which });
    } catch (err) {
      if (err.status === 401) return showLogin();
      alertBanner(err.message);
    }
    refresh();
  }

  async function closeOne(session) {
    if (!(await confirmDialog(`Close ${session.target} (${session.name})? Its shells end and any page using it disconnects.`))) return;
    try {
      await api('POST', `/api/admin/sessions/${encodeURIComponent(session.id)}/close`);
    } catch (err) {
      if (err.status === 401) return showLogin();
      if (err.status !== 404) alertBanner(err.message);
    }
    refresh();
  }

  function alertBanner(message) {
    $('dash-error').textContent = message;
    $('dash-error').hidden = false;
  }

  $('close-all').addEventListener('click', () => {
    const n = overview ? overview.counts.sessions : 0;
    closeSessions('all', `Close all ${plural(n, 'SSH connection')}? Every terminal and file transfer on them ends, including ones in use right now.`);
  });
  // SSH connections: every one, or only the unused (zombie) ones.
  let sessionFilter = 'all';
  function showSessions(filter) {
    sessionFilter = filter;
    for (const b of $('sessions-filter').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.filter === filter));
    if (overview) renderSessions(overview);
  }
  for (const b of $('sessions-filter').querySelectorAll('button')) b.addEventListener('click', () => showSessions(b.dataset.filter));

  $('close-zombies').addEventListener('click', () => {
    const n = overview ? overview.counts.zombies : 0;
    closeSessions('zombies', `Close ${plural(n, 'unused SSH connection')}? Shells left running on them end.`);
  });

  // ------------------------------------------------------------------ render

  function render() {
    const o = overview;
    $('updated').textContent = `Updated ${clockSec(o.now)} · up ${duration(o.server.uptime * 1000)} · ${o.server.hostname}`;
    renderTiles(o);
    renderDevices(o);
    renderSessions(o);
    renderBuffers(o);
    renderServer(o);
    renderEvents(o);
    renderClosed(o);
    if (history) renderCharts();
  }

  function tile({ label, value, unit, sub, color, warn, meter, onclick }) {
    const el = h(onclick ? 'button' : 'div', { class: `tile${warn ? ' warn' : ''}`, type: onclick ? 'button' : null, onclick },
      h('div', { class: 'label', text: label }),
      h('div', { class: 'value' }, String(value), unit ? h('small', { text: ` ${unit}` }) : null),
      sub ? h('div', { class: 'sub', text: sub }) : null,
      meter !== undefined ? h('div', { class: 'meter' }, h('span', { style: `width:${Math.min(100, Math.max(0, meter)).toFixed(1)}%` })) : null);
    el.style.setProperty('--tile', color);
    return el;
  }

  function renderTiles(o) {
    const c = o.counts;
    const m = o.server.memory;
    const sys = o.server.system;
    const recent = history && history.points.length ? history.points[history.points.length - 1] : null;
    const secs = recent ? history.bucketMs / 1000 : 1;
    $('tiles').replaceChildren(
      tile({ label: 'Client devices online', value: c.devicesOnline, sub: `${plural(c.devices, 'device')} seen in 24 h`, color: 'var(--s1)' }),
      tile({ label: 'SSH connections', value: c.sessions, sub: `${plural(c.shells, 'shell')}, ${c.attached} with a page attached`, color: 'var(--s3)' }),
      tile({
        label: 'Unused (zombie) connections',
        value: c.zombies,
        sub: c.zombies ? 'Nothing is using them · show' : 'None',
        color: c.zombies ? 'var(--warn)' : 'var(--border)',
        warn: c.zombies > 0,
        onclick: c.zombies ? () => {
          showSessions('unused');
          $('sessions-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
        } : undefined,
      }),
      tile({
        label: 'SSH traffic since start',
        value: bytes(o.totals.sshIn + o.totals.sshOut),
        sub: recent ? `now ↓ ${rate(recent.sshIn / secs)} · ↑ ${rate(recent.sshOut / secs)}` : `↓ ${bytes(o.totals.sshIn)} · ↑ ${bytes(o.totals.sshOut)}`,
        color: 'var(--s2)',
      }),
      tile({
        label: 'Server memory (RSS)',
        value: bytes(m.rss),
        sub: `heap ${bytes(m.heapUsed)} of ${bytes(m.heapTotal)} · ${(100 * m.rss / sys.total).toFixed(1)}% of RAM`,
        color: 'var(--s1)',
        meter: (100 * m.heapUsed) / m.heapTotal,
      }),
      tile({ label: 'CPU', value: o.server.cpu, unit: '%', sub: `event loop p99 ${o.server.eventLoop.p99} ms`, color: 'var(--s3)' }),
    );
  }

  function table(columns, rows, { rowClass } = {}) {
    return h('div', { class: 'table-wrap' },
      h('table', {},
        h('thead', {}, h('tr', {}, columns.map((col) => h('th', { class: col.num ? 'num' : null, text: col.label })))),
        h('tbody', {}, rows.map((row) => h('tr', { class: rowClass ? rowClass(row) : null },
          columns.map((col) => {
            const v = col.value(row);
            // One element per cell: on phones the cell is a label/value row.
            return h('td', { class: [col.num ? 'num' : '', col.lead ? 'lead' : '', col.actions ? 'actions' : ''].join(' ').trim() || null, 'data-label': col.label }, h('div', { class: 'cell' }, v));
          }))))));
  }

  const empty = (text) => h('div', { class: 'empty', text });
  const two = (main, sub, mono) => [h('div', { class: `strong${mono ? ' mono' : ''}`, text: main }), sub ? h('div', { class: 'sub', text: sub }) : null];

  function sessionLabel(o, id) {
    const sess = o.sessions.find((x) => x.id === id);
    return sess ? sess.target : id.slice(0, 6);
  }

  function renderDevices(o) {
    const online = o.devices.filter((d) => d.online).length;
    $('devices-sum').textContent = `${online} online · ${o.devices.length} seen in the last 24 h`;
    if (!o.devices.length) return $('devices').replaceChildren(empty('No devices yet.'));
    $('devices').replaceChildren(table([
      { label: 'Device', lead: true, value: (d) => [h('div', { class: 'strong', text: d.label, title: d.ua }), h('div', { class: 'sub mono', text: d.ip })] },
      { label: 'Status', value: (d) => h('span', { class: `status ${d.online ? 'online' : 'offline'}`, text: d.online ? (d.sockets ? 'Connected' : 'Online') : 'Away' }) },
      { label: 'Online for', num: true, value: (d) => (d.online ? duration(o.now - d.since) : '—') },
      { label: 'Last seen', num: true, value: (d) => (d.sockets ? 'now' : ago(d.lastSeen, o.now)) },
      { label: 'Terminals', num: true, value: (d) => String(d.sockets) },
      { label: 'SSH connections', value: (d) => (d.sessions.length ? h('div', { class: 'mono', text: d.sessions.map((id) => sessionLabel(o, id)).join('\n'), style: 'white-space:pre-line' }) : '—') },
      { label: 'Terminal traffic', num: true, value: (d) => two(`↓ ${bytes(d.bytesOut)}`, `↑ ${bytes(d.bytesIn)}`) },
      { label: 'Requests', num: true, value: (d) => String(d.requests) },
      {
        label: 'Sign-ins',
        num: true,
        value: (d) => [h('span', { text: String(d.signIns) }), d.failures ? h('span', { class: 'pill warn', text: `${d.failures} failed`, style: 'margin-left:6px' }) : null,
          !d.signedIn ? h('div', { class: 'sub', text: 'not signed in' }) : null],
      },
    ], o.devices, { rowClass: (d) => (d.online ? null : 'dim') }));
  }

  function health(sess) {
    const st = sess.stats;
    const item = (label, value, bad) => h('span', { class: bad ? 'bad' : null }, `${label} `, h('b', { text: String(value) }));
    return h('div', { class: 'health' },
      item('reconnects', st.reconnects),
      item('drops', st.drops, st.drops > 0),
      item('repaints', st.repaints),
      item('output lost', bytes(st.lostBytes), st.lostBytes > 0),
      item('throttled', st.pauses));
  }

  const ZOMBIE_HINT = 'Unused (zombie): no page is using this connection: no terminal is attached, no transfer is running and nothing touched it for the unused-connection time (a minute unless changed under Server settings). It closes when the background time its shells got runs out; one kept Forever does not close on its own. Closing it ends its shells.';

  function stateCell(sess, now) {
    const label = { active: 'Active', detached: 'Detached', idle: 'Idle' }[sess.state];
    return [
      h('span', { class: `status ${sess.state}`, text: label }),
      sess.zombie ? h('span', { class: 'pill zombie', text: 'zombie', style: 'margin-left:6px', title: ZOMBIE_HINT }) : null,
      sess.busy ? h('div', { class: 'sub', text: plural(sess.busy, 'transfer') }) : null,
      sess.state !== 'active' ? h('div', { class: 'sub', text: `last used ${ago(sess.lastUsed, now)}` }) : null,
      sess.closesAt ? h('div', { class: 'sub', text: `closes in ~${duration(Math.max(0, sess.closesAt - now))}`, title: `at ${dateTime(sess.closesAt)}` }) : null,
      sess.noExpiry ? h('div', { class: 'sub', text: 'no background expiry (Forever)' }) : null,
    ];
  }

  function sessionColumns(o) {
    const cols = [
      { label: 'Connection', lead: true, value: (x) => two(x.target, x.name, true) },
      { label: 'State', value: (x) => stateCell(x, o.now) },
      { label: 'Opened by', value: (x) => (x.openedBy ? two(x.openedBy.label, x.openedBy.ip) : '—') },
      { label: 'Connected for', num: true, value: (x) => two(duration(o.now - x.connectedAt), `since ${dateTime(x.connectedAt)}`) },
      {
        label: 'Shells',
        num: true,
        value: (x) => [
          h('div', { text: `${x.shells.filter((sh) => sh.attached).length} / ${x.shells.length} attached` }),
          x.shells.length ? h('ul', { class: 'shells' }, x.shells.map((sh) => h('li', {
            text: sh.attached ? `${sh.id}: ${sh.device ? sh.device.label : 'attached'}` : `${sh.id}: detached ${duration(o.now - (sh.detachedAt || o.now))}`,
          }))) : null,
        ],
      },
      { label: 'SSH traffic', num: true, value: (x) => two(`↓ ${bytes(x.bytesIn)} · ↑ ${bytes(x.bytesOut)}`, `now ↓ ${rate(x.rateIn)} · ↑ ${rate(x.rateOut)}`) },
    ];
    cols.push(
      { label: 'Terminal', num: true, value: (x) => two(`out ${bytes(x.termOut)}`, `typed ${bytes(x.termIn)}`) },
      { label: 'Link health', value: health },
    );
    cols.push({ label: '', actions: true, value: (x) => h('button', { type: 'button', class: 'btn small danger', text: 'Close', onclick: () => closeOne(x) }) });
    return cols;
  }

  // Unused (zombie) connections first, as they are the ones to act on; then
  // oldest first.
  function renderSessions(o) {
    const zombies = o.sessions.filter((x) => x.zombie).length;
    const [all, unused] = $('sessions-filter').querySelectorAll('button');
    all.textContent = `All (${o.sessions.length})`;
    unused.textContent = `Unused (${zombies})`;
    $('close-all').disabled = !o.sessions.length;
    $('close-zombies').disabled = !zombies;
    $('close-zombies').textContent = zombies ? `Close all unused (${zombies})` : 'Close all unused';
    $('close-zombies').title = ZOMBIE_HINT;
    $('unused-note').hidden = sessionFilter !== 'unused';
    const rows = o.sessions.filter((x) => sessionFilter === 'all' || x.zombie)
      .sort((a, b) => (b.zombie - a.zombie) || (a.connectedAt - b.connectedAt));
    if (!rows.length) return $('sessions').replaceChildren(empty(sessionFilter === 'all' ? 'No SSH connections are open.' : 'No unused connections.'));
    $('sessions').replaceChildren(table(sessionColumns(o), rows, { rowClass: (x) => (x.zombie ? 'zombie' : null) }));
  }

  const meter = (fraction, warn) => h('div', { class: `meter${warn ? ' warn' : ''}` },
    h('span', { style: `width:${(100 * Math.min(1, Math.max(0, fraction))).toFixed(1)}%` }));

  // Every shell's replay buffer, detached ones first and the fullest of those
  // on top: they are the ones whose page may come back to missing output.
  function renderBuffers(o) {
    const rows = [];
    for (const sess of o.sessions) {
      for (const sh of sess.shells) if (sh.buffer) rows.push({ sess, sh, b: sh.buffer });
    }
    const detached = rows.filter((r) => !r.sh.attached);
    $('buffers-sum').textContent = rows.length
      ? `${bytes(o.counts.buffered)} held for ${plural(rows.length, 'shell')} · ${detached.length} detached` +
        (o.counts.overflowing ? ` · ${o.counts.overflowing} past the limit` : '')
      : '';
    if (!rows.length) return $('buffers').replaceChildren(empty('No shells are open.'));
    const fill = (r) => (r.sh.attached ? -1 : r.b.sinceDetach / r.b.limit);
    rows.sort((a, b) => fill(b) - fill(a));
    $('buffers').replaceChildren(table([
      { label: 'Shell', lead: true, value: (r) => two(r.sess.target, `shell ${r.sh.id} · ${r.sess.name}`, true) },
      {
        label: 'Page',
        value: (r) => (r.sh.attached
          ? [h('span', { class: 'status active', text: 'Attached' }), r.sh.device ? h('div', { class: 'sub', text: r.sh.device.label }) : null]
          : [h('span', { class: 'status detached', text: 'Detached' }), h('div', { class: 'sub', text: `for ${duration(o.now - r.sh.detachedAt)}` })]),
      },
      {
        label: 'Printed since the page left',
        num: true,
        value: (r) => {
          if (r.sh.attached) return '—';
          const over = r.b.lostOnReturn > 0;
          return [
            h('div', { text: `${bytes(r.b.sinceDetach)} of ${bytes(r.b.limit)}` }),
            meter(r.b.sinceDetach / r.b.limit, over),
            over ? h('div', { class: 'warn-text', text: `${bytes(r.b.lostOnReturn)} will be missing on return` }) : null,
          ];
        },
      },
      { label: 'Output now', num: true, value: (r) => rate(r.sh.outRate) },
      {
        label: 'Full in',
        num: true,
        value: (r) => {
          if (r.sh.attached) return '—';
          if (r.b.lostOnReturn > 0) return h('span', { class: 'warn-text', text: 'full' });
          if (!r.sh.outRate) return 'not filling';
          return `~${duration((1000 * (r.b.limit - r.b.sinceDetach)) / r.sh.outRate)}`;
        },
      },
      { label: 'Held in memory', num: true, value: (r) => [h('div', { text: `${bytes(r.b.kept)} of ${bytes(r.b.limit)}` }), meter(r.b.kept / r.b.limit)] },
    ], rows, { rowClass: (r) => (r.sh.attached ? 'dim' : null) }));
  }

  function renderServer(o) {
    const sv = o.server;
    const m = sv.memory;
    const sys = sv.system;
    const other = Math.max(0, m.rss - m.heapTotal - m.external);
    const part = (value, color, label) => ({ value, color, label });
    const parts = [
      part(m.heapUsed, 'var(--s1)', 'Heap used'),
      part(Math.max(0, m.heapTotal - m.heapUsed), '#27496f', 'Heap free'),
      part(m.external, 'var(--s2)', 'External (buffers)'),
      part(other, 'var(--s3)', 'Code & stacks'),
    ];
    const total = parts.reduce((n, p) => n + p.value, 0) || 1;
    $('server').replaceChildren(
      h('div', { class: 'small muted', text: `Resident memory ${bytes(m.rss)}` }),
      h('div', { class: 'membar', role: 'img', 'aria-label': parts.map((p) => `${p.label} ${bytes(p.value)}`).join(', ') },
        parts.filter((p) => p.value > 0).map((p) => h('span', { style: `width:${(100 * p.value) / total}%;background:${p.color}`, title: `${p.label}: ${bytes(p.value)}` }))),
      h('div', { class: 'memlegend' }, parts.map((p) => h('span', {}, h('i', { style: `background:${p.color}` }), `${p.label} ${bytes(p.value)}`))),
      h('dl', { class: 'kv' },
        h('dt', { text: 'Array buffers' }), h('dd', { text: bytes(m.arrayBuffers) }),
        h('dt', { text: 'System memory' }), h('dd', { text: `${bytes(sys.total - sys.free)} used of ${bytes(sys.total)} (${bytes(sys.free)} free)` }),
        h('dt', { text: 'CPU' }), h('dd', { text: `${sv.cpu}% of one core · ${sys.cpus} cores${sys.load.some(Boolean) ? ` · load ${sys.load.map((l) => l.toFixed(2)).join(' ')}` : ''}` }),
        h('dt', { text: 'Event loop delay' }), h('dd', { text: `mean ${sv.eventLoop.mean} ms · p99 ${sv.eventLoop.p99} ms · max ${sv.eventLoop.max} ms` }),
        h('dt', { text: 'Uptime' }), h('dd', { text: `${duration(sv.uptime * 1000)} (since ${dateTime(sv.startedAt)})` }),
        h('dt', { text: 'Process' }), h('dd', { text: `pid ${sv.pid} · Node ${sv.node}` }),
        h('dt', { text: 'Host' }), h('dd', { text: `${sv.hostname} · ${sv.platform}` }),
        h('dt', { text: 'Totals' }), h('dd', { text: `SSH ↓ ${bytes(o.totals.sshIn)} ↑ ${bytes(o.totals.sshOut)} · terminals ↓ ${bytes(o.totals.wsOut)} ↑ ${bytes(o.totals.wsIn)} · ${o.totals.requests} requests` })));
  }

  function renderEvents(o) {
    if (!o.events.length) return $('events').replaceChildren(h('li', { class: 'empty', text: 'Nothing yet.' }));
    $('events').replaceChildren(...o.events.slice(0, 60).map((e) => h('li', {},
      h('time', { datetime: new Date(e.at).toISOString(), text: clock(e.at), title: dateTime(e.at) }),
      h('span', { class: e.kind, text: e.text }),
      e.device ? h('span', { class: 'who', text: `${e.device.label} · ${e.device.ip}` }) : null)));
  }

  function renderClosed(o) {
    $('closed-card').hidden = !o.closed.length;
    if (!o.closed.length) return;
    $('closed').replaceChildren(table([
      { label: 'Connection', lead: true, value: (x) => two(x.target, x.name, true) },
      { label: 'Closed', num: true, value: (x) => two(ago(x.closedAt, o.now), x.reason) },
      { label: 'Lasted', num: true, value: (x) => duration(x.closedAt - x.connectedAt) },
      { label: 'Opened by', value: (x) => (x.openedBy ? two(x.openedBy.label, x.openedBy.ip) : '—') },
      { label: 'SSH traffic', num: true, value: (x) => `↓ ${bytes(x.bytesIn)} · ↑ ${bytes(x.bytesOut)}` },
      { label: 'Link health', value: health },
    ], o.closed.slice(0, 20)));
  }

  // ------------------------------------------------------------------ settings

  const minutes = (m) => (m === 'forever' ? 'Forever' : m < 1 ? `${Math.round(m * 60)} s` : m >= 60 && m % 60 === 0 ? `${m / 60} h` : `${m} min`);
  // A select's value as the server keeps it: a number, or "forever".
  const settingValue = (text) => (text === 'forever' ? text : Number(text));
  const order = (v) => (v === 'forever' ? Infinity : v);
  const seconds = (sec) => (sec < 1 ? `${Math.round(sec * 1000)} ms` : sec >= 60 && sec % 60 === 0 ? minutes(sec / 60) : `${sec} s`);
  // In the order shown; each value is in the unit the server keeps it in.
  const SETTINGS = [
    ['replayKB', 'Output kept per shell', (v) => bytes(v * 1024, 0),
      'What a page coming back can repaint from. Each open shell can hold this much memory; lowering it drops the oldest output at once.'],
    ['backgroundMinutes', 'Default background time', minutes,
      'How long a shell with no page attached, and then its SSH connection, stays open once picossh notices the page is gone. Taken at that moment, so a change applies from the next disconnection. Forever sets no expiry, but connections still end when picossh restarts, the SSH server drops them, or they are closed. The app\'s Settings changes the same value; a connection can have its own.'],
    ['zombieMinutes', 'Unused connection after', minutes,
      'How long an SSH connection nothing uses waits before it is listed as unused (a zombie).'],
    ['heartbeatSeconds', 'Terminal heartbeat', seconds,
      'How often each terminal socket is pinged; one that misses a round is dropped. Short keeps mobile network mappings alive.'],
    ['transferIdleMinutes', 'Stalled transfer timeout', minutes,
      'A request that moves no bytes either way for this long is given up. Applies to connections made after the change.'],
    ['loginAttempts', 'Failed sign-ins before a wait', String,
      'Wrong passwords or Face ID failures from one address.'],
    ['loginWaitSeconds', 'Wait after too many failures', seconds,
      'How long that address then has to wait before trying again.'],
  ];
  let limits = null;

  function renderSettings() {
    $('settings-fields').replaceChildren(...SETTINGS.filter(([name]) => limits[name]).map(([name, label, format, hint]) => {
      const lim = limits[name];
      const values = lim.options.includes(lim.value) ? lim.options : [...lim.options, lim.value].sort((a, b) => order(a) - order(b));
      const select = h('select', { id: `setting-${name}`, name },
        values.map((v) => h('option', {
          value: String(v),
          text: `${format(v)}${v === lim.default ? ' (default)' : ''}${lim.options.includes(v) ? '' : ' (from the environment)'}`,
        })));
      select.value = String(lim.value);
      select.addEventListener('change', settingsChanged);
      return h('div', { class: 'setting' },
        h('label', { for: select.id, text: label }),
        select,
        h('div', { class: 'hint', text: hint }));
    }));
    settingsChanged();
  }

  function pendingSettings() {
    const out = {};
    for (const [name] of SETTINGS) {
      const select = $(`setting-${name}`);
      if (select && settingValue(select.value) !== limits[name].value) out[name] = settingValue(select.value);
    }
    return out;
  }

  function settingsChanged() {
    const pending = pendingSettings();
    for (const [name] of SETTINGS) {
      const select = $(`setting-${name}`);
      if (select) select.closest('.setting').classList.toggle('changed', name in pending);
    }
    const n = Object.keys(pending).length;
    $('settings-save').disabled = !n;
    $('settings-undo').disabled = !n;
    if (n) $('settings-status').textContent = `${plural(n, 'change')} not saved`;
    else if ($('settings-status').textContent.endsWith('not saved')) $('settings-status').textContent = '';
  }

  async function loadSettings() {
    try {
      ({ limits } = await api('GET', '/api/admin/settings'));
      renderSettings();
    } catch (err) {
      if (err.status === 401) return showLogin();
      $('settings-status').textContent = `Could not load the settings: ${err.message}`;
    }
  }

  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pending = pendingSettings();
    if (!Object.keys(pending).length) return;
    $('settings-save').disabled = true;
    try {
      ({ limits } = await api('PUT', '/api/admin/settings', pending));
      renderSettings();
      $('settings-status').textContent = `Saved at ${clockSec(Date.now())}`;
      refresh();
    } catch (err) {
      if (err.status === 401) return showLogin();
      $('settings-status').textContent = `Not saved: ${err.message}`;
      settingsChanged();
    }
  });
  $('settings-undo').addEventListener('click', () => renderSettings());

  // ------------------------------------------------------------------ charts

  // A grid step of 1, 2, 2.5 or 5 times a power of ten (within a unit of 1024
  // for bytes) so that `ticks` of them reach v; counts step in whole numbers.
  function niceStep(v, ticks, bytesScale) {
    const raw = v / ticks;
    if (!(raw > 0)) return 1;
    // From half a unit up, count in that unit: 1 KB/s rather than 1000 B/s.
    const unit = bytesScale ? 1024 ** Math.max(0, Math.floor(Math.log(raw * 2) / Math.log(1024))) : 1;
    const x = raw / unit;
    const p = 10 ** Math.floor(Math.log10(x));
    const f = x / p;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 && p >= 1 ? 2.5 : f <= 5 ? 5 : 10) * p * unit;
    return bytesScale ? step : Math.max(1, step);
  }

  const tooltip = $('tooltip');
  function showTip(evt, when, rows) {
    tooltip.replaceChildren(h('div', { class: 'when', text: when }),
      rows.map((r) => h('div', { class: 'row' }, h('i', { style: `background:${r.color}` }), r.label, h('b', { text: r.value }))));
    tooltip.hidden = false;
    const pad = 14;
    const w = tooltip.offsetWidth;
    const ht = tooltip.offsetHeight;
    let x = evt.clientX + pad;
    if (x + w > window.innerWidth - 8) x = evt.clientX - w - pad;
    let y = evt.clientY - ht - pad;
    if (y < 8) y = evt.clientY + pad;
    tooltip.style.left = `${Math.max(8, x)}px`;
    tooltip.style.top = `${y}px`;
  }
  const hideTip = () => { tooltip.hidden = true; };

  // A time series chart: lines (with a light area for a single series) or
  // bars. `series`: [{ key, label, color }], values from value(point, key).
  function chart(fig, { title, series, points, value, format, axisFormat = format, bars = false, byteScale = false, step = false }) {
    const width = Math.max(260, fig.clientWidth || 460);
    const height = 180;
    const m = { top: 8, right: 8, bottom: 22, left: 52 };
    const iw = width - m.left - m.right;
    const ih = height - m.top - m.bottom;
    const from = history.from;
    const to = history.now;
    const xAt = (t) => m.left + ((t - from) / (to - from)) * iw;
    const TICKS = 4;
    const max = TICKS * niceStep(Math.max(0, ...points.flatMap((p) => series.map((sr) => value(p, sr.key)))), TICKS, byteScale);
    const yAt = (v) => m.top + ih - (v / max) * ih;

    const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${title}, last ${duration(history.range)}` });
    const grid = s('g', { class: 'grid' });
    const axis = s('g', { class: 'axis' });
    for (let i = 0; i <= TICKS; i++) {
      const v = (max / TICKS) * i;
      const y = yAt(v);
      if (i > 0) grid.append(s('line', { x1: m.left, x2: width - m.right, y1: y, y2: y }));
      axis.append(s('text', { x: m.left - 6, y: y + 4, 'text-anchor': 'end' }, document.createTextNode(axisFormat(v))));
    }
    const ticks = Math.max(2, Math.min(5, Math.floor(iw / 90))); // time labels need ~70px each
    for (let i = 0; i <= ticks; i++) {
      const t = from + ((to - from) / ticks) * i;
      axis.append(s('text', { x: xAt(t), y: height - 5, 'text-anchor': i === 0 ? 'start' : i === ticks ? 'end' : 'middle' }, document.createTextNode(clock(t))));
    }
    svg.append(grid, s('line', { class: 'baseline', x1: m.left, x2: width - m.right, y1: yAt(0), y2: yAt(0) }), axis);

    if (!points.length) {
      svg.append(s('text', { class: 'nodata', x: m.left + iw / 2, y: m.top + ih / 2, 'text-anchor': 'middle' }, document.createTextNode('Collecting data…')));
    } else if (bars) {
      const bw = Math.max(1, (history.bucketMs / (to - from)) * iw - 2);
      for (const p of points) {
        const v = value(p, series[0].key);
        if (v <= 0) continue;
        const x = xAt(p.t);
        const y = yAt(v);
        const hgt = yAt(0) - y;
        const r = Math.min(4, bw / 2, hgt);
        // Rounded at the data end only, anchored flat on the baseline.
        svg.append(s('path', { class: 'bar', d: `M${x},${yAt(0)}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${yAt(0)}Z` }));
      }
    } else {
      for (const sr of series) {
        let d = '';
        points.forEach((p, i) => {
          const x = xAt(p.t + history.bucketMs / 2);
          const y = yAt(value(p, sr.key));
          if (i === 0) d += `M${x},${y}`;
          else if (step) d += `H${x}V${y}`;
          else d += `L${x},${y}`;
        });
        if (series.length === 1) {
          const first = xAt(points[0].t + history.bucketMs / 2);
          svg.append(s('path', { class: 'area', fill: sr.color, d: `${d}V${yAt(0)}H${first}Z` }));
        }
        svg.append(s('path', { class: 'line', stroke: sr.color, d }));
      }
    }

    // Hover: a crosshair on the nearest point and a tooltip with every series.
    const cross = s('line', { class: 'cross', y1: m.top, y2: m.top + ih, visibility: 'hidden' });
    const dots = series.map((sr) => s('circle', { class: 'dot', r: 4, fill: sr.color, visibility: 'hidden' }));
    const hit = s('rect', { x: m.left, y: 0, width: iw, height: height, fill: 'transparent' });
    svg.append(cross, ...(bars ? [] : dots), hit);
    let hovered = null;
    const move = (evt) => {
      if (!points.length) return;
      const box = svg.getBoundingClientRect();
      const px = ((evt.clientX - box.left) / box.width) * width;
      const t = from + ((px - m.left) / iw) * (to - from);
      let best = points[0];
      for (const p of points) if (Math.abs(p.t + history.bucketMs / 2 - t) < Math.abs(best.t + history.bucketMs / 2 - t)) best = p;
      const x = xAt(best.t + history.bucketMs / 2);
      cross.setAttribute('x1', x);
      cross.setAttribute('x2', x);
      cross.setAttribute('visibility', 'visible');
      if (bars) {
        if (hovered) hovered.classList.remove('hover');
        hovered = null;
      } else {
        series.forEach((sr, i) => {
          dots[i].setAttribute('cx', x);
          dots[i].setAttribute('cy', yAt(value(best, sr.key)));
          dots[i].setAttribute('visibility', 'visible');
        });
      }
      const span = history.bucketMs > history.sampleMs ? `${clock(best.t)}–${clock(best.t + history.bucketMs)}` : clockSec(best.t);
      showTip(evt, span, series.map((sr) => ({ color: sr.color, label: sr.label, value: format(value(best, sr.key)) })));
    };
    const leave = () => {
      cross.setAttribute('visibility', 'hidden');
      for (const d of dots) d.setAttribute('visibility', 'hidden');
      hideTip();
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', leave);

    const latest = points.length ? points[points.length - 1] : null;
    fig.replaceChildren(
      h('div', { class: 'chart-title' },
        h('h3', { text: title }),
        series.length > 1
          ? h('div', { class: 'legend' }, series.map((sr) => h('span', { style: `color:${sr.color}` }, h('i'),
            h('span', { style: 'color:var(--muted)', text: latest ? `${sr.label} ${format(value(latest, sr.key))}` : sr.label }))))
          : h('div', { class: 'legend', text: latest ? `now ${format(value(latest, series[0].key))}` : '' })),
      svg);
  }

  function renderCharts() {
    const points = history.points;
    const secs = history.bucketMs / 1000;
    const perSec = (p, k) => p[k] / secs;
    const count = (n) => String(Math.round(n));
    chart($('chart-activity'), {
      title: 'Clients & SSH connections',
      series: [
        { key: 'devices', label: 'Devices online', color: 'var(--s1)' },
        { key: 'sessions', label: 'SSH connections', color: 'var(--s2)' },
        { key: 'zombies', label: 'Zombies', color: 'var(--s3)' },
      ],
      points, value: (p, k) => p[k], format: count, step: true,
    });
    chart($('chart-traffic'), {
      title: 'SSH traffic',
      series: [
        { key: 'sshIn', label: 'From servers', color: 'var(--s1)' },
        { key: 'sshOut', label: 'To servers', color: 'var(--s2)' },
      ],
      points, value: perSec, format: rate, byteScale: true,
    });
    chart($('chart-memory'), {
      title: 'Server memory',
      series: [
        { key: 'rss', label: 'Resident (RSS)', color: 'var(--s1)' },
        { key: 'heapUsed', label: 'Heap used', color: 'var(--s2)' },
      ],
      points, value: (p, k) => p[k], format: (v) => bytes(v), byteScale: true,
    });
    const perMin = history.bucketMs / 60000;
    chart($('chart-requests'), {
      title: 'Requests per minute',
      series: [{ key: 'requests', label: 'Requests', color: 'var(--s1)' }],
      points, value: (p) => p.requests / perMin, format: (v) => (v >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1)), bars: true,
    });
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (history && !$('view-dash').hidden) renderCharts(); }, 150);
  });

  // ------------------------------------------------------------------ start

  (async () => {
    try {
      await api('GET', '/api/admin/overview');
      signedIn();
    } catch (err) {
      showLogin(err.status === 401 ? '' : err.message);
    }
  })();
})();

'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  async function call(method, path, body) {
    const res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, json };
  }

  function message(id, text, kind) {
    const el = $(id);
    el.textContent = text || '';
    el.className = `msg ${kind || ''}`.trim();
    el.hidden = !text;
  }

  // ================= Pages: the sidebar, top bar and account menu come from shell.js =================

  const TABS = ['overview', 'users', 'classes', 'github'];
  const TITLES = { overview: 'Overview', users: 'Users', classes: 'All classes', github: 'GitHub settings' };
  const NAV_KEYS = { overview: 'overview', users: 'users', classes: 'admin-classes', github: 'github' };
  let me = null;

  function showTab(name) {
    if (!TABS.includes(name)) name = 'overview';
    for (const id of TABS) $(`pane-${id}`).hidden = id !== name;
    window.CCShell.setActive(NAV_KEYS[name]);
    window.CCShell.setCrumb(['Admin', TITLES[name]]);
    document.title = `${TITLES[name]} · Admin · cc-studio`;
    window.scrollTo(0, 0);
    if (name === 'overview') loadOverview();
    if (name === 'users') loadUsers();
    if (name === 'classes') loadClasses();
    if (name === 'github') loadGithubSettings();
  }
  window.addEventListener('hashchange', () => showTab(window.location.hash.slice(1)));

  // The search box in the top bar finds a user.
  function searchUsers(q) {
    $('u-q').value = q;
    $('u-role').value = '';
    if (window.location.hash === '#users') loadUsers(); else window.location.hash = 'users';
  }
  window.addEventListener('shell:search', (e) => searchUsers(e.detail));

  // ================= Small helpers =================

  const fmtDate = (v) => (v ? new Date(v).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
  const fmtDateTime = (v) => (v ? new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
  const who = (u) => u.username || u.email;
  const initials = (u) => who(u).replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
  const ROLE_NAMES = { student: 'Student', teacher: 'Teacher', superadmin: 'Super admin' };
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    for (const k of kids) if (k != null) n.append(k);
    return n;
  }
  const button = (text, cls, onClick) => el('button', { type: 'button', className: `btn small ${cls || ''}`.trim(), textContent: text, onclick: onClick });
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'i');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  // ================= Overview =================

  function cell(iconName, label, value, note, tone) {
    return el('div', { className: 'cell' },
      el('div', { className: 'cell-label' }, icon(iconName), label),
      el('div', { className: 'cell-value', textContent: String(value) }),
      el('div', { className: `cell-note ${tone || ''}`.trim(), textContent: note }));
  }

  let acctTab = 'newest';
  let newest = [];

  function accountRow(u) {
    return el('li', null,
      el('span', { className: 'avatar sm', textContent: initials(u) }),
      el('span', { className: 'name', textContent: who(u) }),
      el('span', { className: 'chip', textContent: ROLE_NAMES[u.role] || u.role }),
      el('span', { className: 'meta', textContent: fmtDate(u.createdAt) }));
  }

  async function showAccounts() {
    for (const b of document.querySelectorAll('#acct-tabs button')) b.classList.toggle('on', b.dataset.list === acctTab);
    let rows = newest;
    if (acctTab !== 'newest') {
      const r = await call('GET', `/admin/users?role=${acctTab}`);
      rows = r.ok ? r.json.users.slice().reverse().slice(0, 8) : [];
    }
    const list = $('acct-list');
    list.replaceChildren(...rows.map(accountRow));
    $('acct-empty').hidden = rows.length > 0;
    $('acct-empty').textContent = acctTab === 'teacher' ? 'No teachers yet. Promote someone on the Users page.' : acctTab === 'student' ? 'No students yet.' : 'No accounts yet.';
  }
  for (const b of document.querySelectorAll('#acct-tabs button')) b.addEventListener('click', () => { acctTab = b.dataset.list; showAccounts(); });

  function attentionRow(tone, text, linkText, href) {
    return el('li', null, el('span', { className: `dot ${tone}` }), el('span', { className: 'name', textContent: text }), linkText ? el('a', { href, textContent: linkText }) : null);
  }

  async function loadOverview() {
    const hour = new Date().getHours();
    $('greeting').textContent = `Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}, ${who(me)}`;
    $('today').textContent = `${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} · Here's what's happening across cc-studio.`;

    const [r, g, cls] = await Promise.all([call('GET', '/admin/stats'), call('GET', '/admin/settings/github'), call('GET', '/admin/classes')]);
    if (!r.ok) return;
    const s = r.json.stats;
    newest = r.json.newest;
    setCounts(s);

    $('stat-strip').replaceChildren(
      cell('users', 'Accounts', s.users, s.newThisWeek ? `${s.newThisWeek} new this week` : 'none new this week', s.newThisWeek ? 'ok' : ''),
      cell('book', 'Classes', s.classes, `${s.memberships} ${s.memberships === 1 ? 'enrolment' : 'enrolments'}`),
      cell('list', 'Assignments and shares', s.assignments + s.shared, `${s.shared} shared ${s.shared === 1 ? 'program' : 'programs'}`),
      cell('pulse', 'Signed in now', s.activeSessions, 'active sessions', s.activeSessions ? 'ok' : ''));

    showAccounts();

    const classes = cls.ok ? cls.json.classes.slice(0, 5) : [];
    $('ov-classes').hidden = classes.length === 0;
    $('ov-classes-empty').hidden = classes.length > 0;
    $('ov-classes-body').replaceChildren(...classes.map((c) => el('tr', null,
      el('td', { className: 'user', textContent: c.name }), el('td', { textContent: c.teacher }), el('td', { textContent: String(c.students) }), el('td', { textContent: fmtDate(c.createdAt) }))));

    // Needs attention
    const items = [];
    if (g.ok) {
      const v = g.json;
      if (!v.canStoreSecrets) items.push(attentionRow('bad', 'GitHub is off: TOKEN_ENCRYPTION_KEY is missing on the server.', null));
      else if (!v.clientId) items.push(attentionRow('warn', 'GitHub is not set up yet.', 'Set up', '#github'));
      else if (!v.hasSecret) items.push(attentionRow('warn', 'GitHub login uses a typed code. Add a client secret for the Authorize page.', 'Finish', '#github'));
      else items.push(attentionRow('ok', 'GitHub sign-in uses the Authorize page.', 'Settings', '#github'));
    }
    if (s.teachers === 0) items.push(attentionRow('warn', 'No teachers yet, so nobody can create a class.', 'Users', '#users'));
    if (s.teachers > 0 && s.classes === 0) items.push(attentionRow('warn', 'Teachers exist but no class has been created.', null));
    $('attention').replaceChildren(...items);

    const kv = (label, value) => el('div', null, el('dt', { textContent: label }), el('dd', { textContent: String(value) }));
    $('system').replaceChildren(
      kv('Students', s.students), kv('Teachers', s.teachers), kv('Signed up with GitHub', s.githubOnly), kv('Accounts tied to GitHub', s.githubAccounts),
      kv('Saved workspaces', s.workspaces), kv('GitHub push and pull', `${s.githubRepos} of ${s.githubLinks} connected`), kv('Database size', fmtBytes(s.databaseBytes)));
  }

  function setCounts(s) {
    $('n-users').textContent = String(s.users);
    $('n-classes').textContent = String(s.classes);
  }

  // ================= Users =================

  let userTimer = null;

  async function loadUsers() {
    const q = $('u-q').value.trim();
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if ($('u-role').value) params.set('role', $('u-role').value);
    const r = await call('GET', `/admin/users?${params}`);
    if (!r.ok) return message('u-msg', (r.json && r.json.error) || 'Could not load the users.', 'err');
    const { users, total, limit } = r.json;
    $('u-count').textContent = total > users.length ? `Showing the first ${limit} of ${total}. Search to narrow it down.` : `${total} ${total === 1 ? 'account' : 'accounts'}`;
    const body = $('u-body');
    body.replaceChildren();
    for (const u of users) {
      const isMe = String(u.id) === String(me.id);
      const signIn = [u.hasPassword ? 'Password' : null, u.githubLinked ? 'GitHub' : null].filter(Boolean).join(' + ') || '—';
      const roleCell = el('td');
      if (u.role === 'superadmin') {
        roleCell.append(ROLE_NAMES.superadmin);
      } else {
        const sel = el('select', { 'aria-label': `Role of ${who(u)}` });
        for (const key of ['student', 'teacher']) sel.append(new Option(ROLE_NAMES[key], key, false, u.role === key));
        sel.addEventListener('change', async () => {
          const d = await call('PUT', `/admin/users/${u.id}/role`, { role: sel.value });
          if (d.ok) { u.role = sel.value; message('u-msg', `${who(u)} is now a ${ROLE_NAMES[sel.value].toLowerCase()}.`, 'ok'); } else { message('u-msg', (d.json && d.json.error) || 'Could not change the role.', 'err'); sel.value = u.role; }
        });
        roleCell.append(sel);
      }
      const actions = el('div', { className: 'actions-cell' });
      if (!isMe && u.role !== 'superadmin') {
        actions.append(
          button('Reset password', '', async () => {
            const pw = window.prompt(`New password for ${who(u)} (at least 8 characters). They will be signed out everywhere, so tell them the new password.`);
            if (pw === null) return;
            const d = await call('POST', `/admin/users/${u.id}/password`, { newPassword: pw });
            message('u-msg', d.ok ? `Password changed for ${who(u)}.` : (d.json && d.json.error) || 'Could not change the password.', d.ok ? 'ok' : 'err');
          }),
          button('Delete', 'danger', async () => {
            if (!window.confirm(`Delete ${who(u)} and all their saved files? This cannot be undone.`)) return;
            const d = await call('DELETE', `/admin/users/${u.id}`);
            if (d.ok) { message('u-msg', `${who(u)} was deleted.`, 'ok'); loadUsers(); } else message('u-msg', (d.json && d.json.error) || 'Could not delete.', 'err');
          }));
      }
      body.append(el('tr', null,
        el('td', { className: 'user', textContent: isMe ? `${who(u)} (you)` : who(u) }),
        roleCell,
        el('td', { textContent: signIn }),
        el('td', { textContent: fmtDate(u.createdAt) }),
        el('td', { textContent: fmtDateTime(u.workspaceUpdatedAt) }),
        el('td', null, actions)));
    }
  }
  $('u-q').addEventListener('input', () => { clearTimeout(userTimer); userTimer = setTimeout(loadUsers, 250); });
  $('u-role').addEventListener('change', loadUsers);

  // ================= Classes =================

  async function loadClasses() {
    const r = await call('GET', '/admin/classes');
    if (!r.ok) return message('c-msg', (r.json && r.json.error) || 'Could not load the classes.', 'err');
    const rows = r.json.classes;
    $('c-empty').hidden = rows.length > 0;
    $('c-table').hidden = rows.length === 0;
    const body = $('c-body');
    body.replaceChildren();
    for (const c of rows) {
      body.append(el('tr', null,
        el('td', { className: 'user', textContent: c.name }),
        el('td', { textContent: c.teacher }),
        el('td', { textContent: String(c.students) }),
        el('td', { textContent: String(c.items) }),
        el('td', { className: 'mono', textContent: c.code }),
        el('td', { textContent: fmtDate(c.createdAt) }),
        el('td', null, el('div', { className: 'actions-cell' }, button('Delete', 'danger', async () => {
          if (!window.confirm(`Delete the class "${c.name}" with its ${c.students} student${c.students === 1 ? '' : 's'} and ${c.items} assignment${c.items === 1 ? '' : 's'}? Students keep their own files. This cannot be undone.`)) return;
          const d = await call('DELETE', `/admin/classes/${c.id}`);
          if (d.ok) { message('c-msg', `"${c.name}" was deleted.`, 'ok'); loadClasses(); } else message('c-msg', (d.json && d.json.error) || 'Could not delete.', 'err');
        })))));
    }
  }

  // ================= GitHub settings =================

  const SOURCES = { database: 'saved here', environment: 'from the server settings (.env)', none: 'not set' };
  let view = null; // the last answer from the server

  function secretHint(v) {
    $('src-secret').textContent = v.hasSecret ? `A secret is saved (${SOURCES[v.sources.clientSecret]}). Type a new one to replace it.` : 'No secret saved.';
    $('a-secret').placeholder = v.hasSecret ? '•••••••••••••••• (saved)' : 'Paste the client secret';
    $('remove-secret').hidden = !(v.hasSecret && v.sources.clientSecret === 'database');
  }

  /** What users will get, in one sentence. */
  function showState(v) {
    const el = $('state');
    if (!v.canStoreSecrets) {
      el.className = 'state warn';
      el.textContent = 'TOKEN_ENCRYPTION_KEY is not set on the server, so GitHub is off and secrets cannot be stored.';
    } else if (!v.clientId) {
      el.className = 'state warn';
      el.textContent = 'GitHub is off: no Client ID yet.';
    } else if (v.hasSecret) {
      el.className = 'state on';
      el.textContent = 'On: users get GitHub’s Authorize page (no code to type).';
    } else {
      el.className = 'state';
      el.textContent = 'On, with a typed code: add a client secret to switch to the Authorize page.';
    }
  }

  function updateCallback() {
    const raw = $('a-url').value.trim();
    let origin = '';
    try { origin = raw ? new URL(raw).origin : ''; } catch { origin = ''; }
    $('a-callback').value = `${origin || window.location.origin}/api/github/oauth/callback`;
    $('callback-note').classList.toggle('warn', !origin);
  }

  function fill(v) {
    view = v;
    $('a-url').value = v.publicUrl;
    $('a-id').value = v.clientId;
    $('a-scope').value = v.scope;
    $('a-secret').value = '';
    $('src-url').textContent = SOURCES[v.sources.publicUrl];
    $('src-id').textContent = SOURCES[v.sources.clientId];
    secretHint(v);
    showState(v);
    updateCallback();
    if (v.callbackIsGuess && !$('a-url').value) {
      $('callback-note').textContent = `Until you set the public address, this is a guess from the address of this page. Paste it into your OAuth App as the Authorization callback URL (github.com → Settings → Developer settings → OAuth Apps).`;
    }
  }

  async function save(patch, doneText) {
    message('msg', '');
    message('check-msg', '');
    $('save').disabled = true;
    try {
      const r = await call('PUT', '/admin/settings/github', patch);
      if (!r.ok) { message('msg', (r.json && r.json.error) || 'Could not save.', 'err'); return; }
      fill(r.json);
      message('msg', doneText, 'ok');
    } catch {
      message('msg', 'Could not reach the server.', 'err');
    } finally {
      $('save').disabled = false;
    }
  }

  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const patch = { clientId: $('a-id').value.trim(), publicUrl: $('a-url').value.trim(), scope: $('a-scope').value };
    const secret = $('a-secret').value.trim();
    if (secret) patch.clientSecret = secret;
    save(patch, secret ? 'Saved. The secret is stored encrypted and will not be shown again.' : 'Saved.');
  });

  $('remove-secret').addEventListener('click', () => {
    if (!window.confirm('Remove the saved client secret? GitHub sign-in goes back to typing a code until you save a new one.')) return;
    save({ clearSecret: true }, 'Secret removed.');
  });

  $('check').addEventListener('click', async () => {
    message('check-msg', 'Asking GitHub…');
    try {
      const r = await call('POST', '/admin/settings/github/check', {});
      if (!r.ok) return message('check-msg', (r.json && r.json.error) || 'Could not check.', 'err');
      return message('check-msg', r.json.message, r.json.ok ? 'ok' : 'err');
    } catch {
      return message('check-msg', 'Could not reach the server.', 'err');
    }
  });

  $('check').title = 'Asks GitHub whether it knows the saved Client ID. It does not test the secret.';
  $('a-url').addEventListener('input', updateCallback);

  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('a-callback').value); message('msg', 'Callback URL copied.', 'ok'); } catch { $('a-callback').select(); message('msg', 'Press Ctrl+C to copy the selected address.', 'err'); }
  });


  async function loadGithubSettings() {
    const r = await call('GET', '/admin/settings/github');
    if (!r.ok) return message('msg', (r.json && r.json.error) || 'Could not load the settings.', 'err');
    fill(r.json);
  }

  // ================= Start =================

  (async function init() {
    const user = await window.CCShell.ready;
    $('loading').hidden = true;
    if (!user || user.role !== 'superadmin') {
      $('denied').hidden = false;
      window.CCShell.setCrumb(['Admin']);
      if (user) $('denied-text').textContent = 'Your account is not a super admin.';
      return;
    }
    me = user;
    $('content').hidden = false;
    // Arriving from the search box on another page: /admin?q=ada#users
    const q = new URLSearchParams(window.location.search).get('q');
    if (q) { $('u-q').value = q; window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`); }
    showTab(window.location.hash.slice(1));
    // The sidebar counts, even when another page opens first.
    call('GET', '/admin/stats').then((r) => { if (r.ok) setCounts(r.json.stats); });
  })();
})();

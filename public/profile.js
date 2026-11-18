'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  // ---- Theme: follow the editor's saved theme and accent (same localStorage key as app.js) ----
  const ACCENTS = { teal: ['#7fc4b0', '#1f7a68'], blue: ['#7fb0e8', '#2a62b8'], amber: ['#e0b060', '#a86a10'], violet: ['#b79be0', '#6a45b8'] };
  const PALETTE = {
    dark: { bg: '#111314', bg2: '#141617', bd: '#26292a', bd2: '#2f3334', fg: '#d6d9d8', mu: '#9aa19f', mu2: '#7d8584', hov: '#1c1f20', inp: '#0d0f10', err: '#e07a72', onac: '#0d1211' },
    light: { bg: '#f6f7f7', bg2: '#eceeee', bd: '#dcdfdf', bd2: '#cfd3d3', fg: '#1b1f1f', mu: '#4f5856', mu2: '#626b69', hov: '#e3e6e6', inp: '#ffffff', err: '#c0392b', onac: '#ffffff' },
  };
  try {
    const s = JSON.parse(localStorage.getItem('cc-studio:v1')) || {};
    const mode = s.mode === 'light' ? 'light' : 'dark';
    const ac = (ACCENTS[s.acc] || ACCENTS.teal)[mode === 'dark' ? 0 : 1];
    const vars = { ...PALETTE[mode], ac, ac2: ac, acbg: ac + (mode === 'dark' ? '33' : '22') };
    for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(`--${k}`, v);
    document.documentElement.style.colorScheme = mode;
  } catch { /* no saved theme: keep the dark default */ }

  // ---- API ----
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

  const fmtDate = (v) => (v ? new Date(v).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '—');
  const fmtDateTime = (v) => (v ? new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const ROLES = { superadmin: 'Super admin', teacher: 'Teacher', student: 'Student' };

  function message(el, text, kind) {
    el.textContent = text || '';
    el.className = `msg ${kind || ''}`.trim();
    el.hidden = !text;
  }

  // ---- Page ----
  let me = null;

  function showProfile(user, workspace, updatedAt) {
    const label = user.username || user.email;
    $('avatar').textContent = label.charAt(0).toUpperCase();
    $('name').textContent = label;
    $('role').hidden = !ROLES[user.role];
    $('role').textContent = ROLES[user.role] || '';
    $('f-username').textContent = user.username || '—';
    $('f-email').textContent = user.email || '—';
    $('f-since').textContent = fmtDate(user.createdAt);
    const count = workspace ? Object.keys(workspace.files || {}).length : 0;
    $('f-files').textContent = workspace ? `${count} file${count === 1 ? '' : 's'}` : 'Nothing saved yet';
    $('f-saved').textContent = fmtDateTime(updatedAt);
    document.title = `${label} · cc-studio`;
  }

  async function loadUsers() {
    const r = await call('GET', '/admin/users');
    if (!r.ok) { message($('admin-msg'), (r.json && r.json.error) || 'Could not load users.', 'err'); return; }
    const body = $('users');
    body.replaceChildren();
    for (const u of r.json.users) {
      const tr = document.createElement('tr');
      const cell = (text, cls) => { const td = document.createElement('td'); td.textContent = text; if (cls) td.className = cls; tr.appendChild(td); return td; };
      cell(u.username || u.email, 'user');
      const roleCell = cell(u.role === 'superadmin' ? ROLES.superadmin : '');
      if (u.role !== 'superadmin') {
        const sel = document.createElement('select');
        sel.setAttribute('aria-label', `Role of ${u.username || u.email}`);
        for (const key of ['student', 'teacher']) sel.append(new Option(ROLES[key], key, false, u.role === key));
        sel.addEventListener('change', async () => {
          const d = await call('PUT', `/admin/users/${u.id}/role`, { role: sel.value });
          if (d.ok) message($('admin-msg'), `${u.username || u.email} is now a ${ROLES[sel.value].toLowerCase()}.`, 'ok');
          else { message($('admin-msg'), (d.json && d.json.error) || 'Could not change the role.', 'err'); sel.value = u.role; }
          if (d.ok) u.role = sel.value;
        });
        roleCell.append(sel);
      }
      cell(fmtDate(u.createdAt));
      cell(fmtDateTime(u.workspaceUpdatedAt));
      const act = document.createElement('td');
      if (String(u.id) !== String(me.id)) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn danger';
        del.textContent = 'Delete';
        del.addEventListener('click', async () => {
          if (!window.confirm(`Delete ${u.username || u.email} and all their saved files? This cannot be undone.`)) return;
          del.disabled = true;
          const d = await call('DELETE', `/admin/users/${u.id}`);
          if (d.ok) { message($('admin-msg'), ''); loadUsers(); } else { message($('admin-msg'), (d.json && d.json.error) || 'Could not delete.', 'err'); del.disabled = false; }
        });
        act.appendChild(del);
      }
      tr.appendChild(act);
      body.appendChild(tr);
    }
  }

  $('pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const next = $('pw-new').value;
    if (next.length < 8) return message($('pw-msg'), 'Use a new password of at least 8 characters.', 'err');
    if (next !== $('pw-confirm').value) return message($('pw-msg'), 'The new passwords do not match.', 'err');
    const btn = $('pw-submit');
    btn.disabled = true;
    message($('pw-msg'), '');
    try {
      const r = await call('POST', '/password', { currentPassword: $('pw-current').value, newPassword: next });
      if (r.ok) { $('pw-form').reset(); message($('pw-msg'), 'Password updated.', 'ok'); } else message($('pw-msg'), (r.json && r.json.error) || 'Could not update the password.', 'err');
    } catch {
      message($('pw-msg'), 'Could not reach the server.', 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('logout').addEventListener('click', async () => {
    try { await call('POST', '/logout', {}); } catch { /* cookie expires on its own */ }
    window.location.href = '/';
  });

  (async function init() {
    let r;
    try { r = await call('GET', '/me'); } catch { r = null; }
    $('loading').hidden = true;
    if (!r || !r.ok || !r.json || !r.json.user) { $('signed-out').hidden = false; return; }
    me = r.json.user;
    const ws = await call('GET', '/workspace');
    showProfile(me, ws.ok ? ws.json.workspace : null, ws.ok ? ws.json.updatedAt : null);
    $('signed-in').hidden = false;
    if (me.role === 'superadmin') { $('admin').hidden = false; await loadUsers(); }
  })();
})();

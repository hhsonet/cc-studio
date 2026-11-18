'use strict';

// Accounts and cloud save. Talks to /api (lib/auth.js). app.js hands in three callbacks:
//   getWorkspace() -> { files, open, collapsed }   what to save
//   setWorkspace(ws)                               replace the open project with a cloud copy
//   isDefault() -> boolean                         true while the files are still the untouched sample
// If the server has no database (/api/me is a 404) the Log in button stays hidden.
(function () {
  const $ = (id) => document.getElementById(id);
  const SAVE_DELAY = 1500;

  let user = null;
  let api = null;
  let saveTimer = null;
  let applying = false; // true while a cloud copy is being loaded, so it is not echoed back
  let mode = 'login'; // 'login' | 'signup' in the dialog
  let viewing = false; // a teacher is looking at a student's files: never save or sync

  async function call(method, path, body) {
    const res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty or non-JSON body */ }
    return { ok: res.ok, status: res.status, json };
  }

  function setStatus(text, cls) {
    const el = $('cloud-status');
    el.textContent = text;
    el.className = `cloud-status ${cls || ''}`.trim();
    el.hidden = !text;
  }

  const ROLES = { superadmin: 'Super admin', teacher: 'Teacher', student: 'Student' };

  /** The sidebar footer (avatar, name) and the account section at the top of the settings menu. */
  function renderButton() {
    const label = user ? (user.username || user.email) : '';
    $('user-avatar').textContent = user ? label.charAt(0).toUpperCase() : 'cc';
    $('user-name').textContent = user ? label : 'cc-studio';
    $('user-sub').textContent = user ? 'Signed in · Settings' : 'Settings';
    $('acct-section').hidden = false;
    $('share').hidden = !(user && (user.role === 'teacher' || user.role === 'superadmin') && !viewing);
    $('acct-out').hidden = !!user;
    $('acct-in').hidden = !user;
    if (user) {
      $('acct-name').textContent = label;
      const role = ROLES[user.role];
      $('acct-role').hidden = !role;
      $('acct-role').textContent = role || '';
    } else {
      setStatus('');
    }
  }

  function closeMenu() {
    $('settings-menu').hidden = true;
    $('settings-btn').setAttribute('aria-expanded', 'false');
  }

  // ---- Cloud save ----

  async function pushNow() {
    clearTimeout(saveTimer);
    if (!user) return;
    setStatus('Saving…', 'busy');
    try {
      const sent = api.getWorkspace();
      const r = await call('PUT', '/workspace', { workspace: sent });
      if (r.status === 401) { user = null; renderButton(); return; }
      if (r.ok) markSynced(sent);
      setStatus(r.ok ? 'Saved to cloud' : (r.json && r.json.error) || 'Not saved', r.ok ? 'ok' : 'err');
    } catch {
      setStatus('Offline: not saved to cloud', 'err');
    }
  }

  /** Called by app.js after every local save. */
  function changed() {
    if (!user || applying || viewing) return;
    clearTimeout(saveTimer);
    setStatus('Unsaved changes', 'busy');
    saveTimer = setTimeout(pushNow, SAVE_DELAY);
  }

  const same = (a, b) => JSON.stringify(a.files) === JSON.stringify(b.files);

  // Remember what this browser last had in sync with the cloud, so a change made elsewhere (another
  // device, or a teacher's starter code) loads quietly instead of asking, as long as nothing local changed.
  const SYNC_KEY = 'cc-studio:synced';
  const hashOf = (ws) => {
    const str = JSON.stringify(ws.files);
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return `${str.length}:${h >>> 0}`;
  };
  function markSynced(ws) {
    try { localStorage.setItem(SYNC_KEY, JSON.stringify({ u: user.id, h: hashOf(ws) })); } catch { /* storage blocked */ }
  }
  function unchangedSinceSync(ws) {
    try { const s = JSON.parse(localStorage.getItem(SYNC_KEY)); return !!s && s.u === user.id && s.h === hashOf(ws); } catch { return false; }
  }

  /** Right after logging in: merge this browser's files with the saved cloud copy. */
  async function syncAfterLogin() {
    setStatus('Syncing…', 'busy');
    const r = await call('GET', '/workspace');
    if (!r.ok) { setStatus('Could not load cloud files', 'err'); return; }
    const cloud = r.json.workspace;
    const local = api.getWorkspace();
    if (!cloud) { await pushNow(); return; } // first time: this browser's files become the cloud copy
    if (same(cloud, local)) { markSynced(cloud); setStatus('Saved to cloud', 'ok'); return; }
    const useCloud = api.isDefault() || unchangedSinceSync(local) || window.confirm(
      'You have saved files in your account that differ from the files in this browser.\n\n'
      + 'OK: load your saved files (replaces what is open here).\n'
      + 'Cancel: keep what is open here and overwrite your saved files.');
    if (useCloud) {
      applying = true;
      try { api.setWorkspace(cloud); } finally { applying = false; }
      markSynced(cloud);
      setStatus('Loaded from cloud', 'ok');
    } else {
      await pushNow();
    }
  }

  // ---- Dialog ----

  function showError(msg) {
    const el = $('auth-error');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function setMode(next) {
    mode = next;
    const signup = mode === 'signup';
    $('auth-title').textContent = signup ? 'Create an account' : 'Log in';
    $('auth-submit').textContent = signup ? 'Sign up' : 'Log in';
    $('auth-switch-text').textContent = signup ? 'Already have an account?' : 'New here?';
    $('auth-switch').textContent = signup ? 'Log in' : 'Sign up';
    $('auth-password').autocomplete = signup ? 'new-password' : 'current-password';
    $('auth-hint').hidden = !signup;
    $('auth-email-label').textContent = signup ? 'Email' : 'Email or username';
    showError('');
  }

  function openDialog() {
    const dlg = $('auth-dialog');
    $('auth-form').hidden = !!user;
    $('auth-account').hidden = !user;
    if (user) $('auth-who').textContent = user.username || user.email;
    else { setMode('login'); $('auth-password').value = ''; }
    if (!dlg.open) dlg.showModal();
    if (!user) $('auth-email').focus();
  }

  async function submit(e) {
    e.preventDefault();
    const btn = $('auth-submit');
    btn.disabled = true;
    showError('');
    try {
      const r = await call('POST', mode === 'signup' ? '/signup' : '/login', {
        email: $('auth-email').value,
        password: $('auth-password').value,
      });
      if (!r.ok) { showError((r.json && r.json.error) || 'Something went wrong. Try again.'); return; }
      user = r.json.user;
      $('auth-password').value = '';
      $('auth-dialog').close();
      renderButton();
      await syncAfterLogin();
    } catch {
      showError('Could not reach the server.');
    } finally {
      btn.disabled = false;
    }
  }

  // ---- Teachers: send the open file to a class ----

  async function openShare() {
    const file = api.getOpenFile();
    const sel = $('share-class');
    $('share-error').hidden = true;
    $('share-file').textContent = `File: ${file.path}`;
    $('share-name').value = file.path.split('/').pop();
    sel.replaceChildren();
    const r = await call('GET', '/classes');
    const classes = r.ok ? r.json.classes : [];
    for (const c of classes) sel.append(new Option(c.name, c.id));
    $('share-send').disabled = classes.length === 0;
    if (!classes.length) {
      $('share-error').textContent = 'You have no classes yet. Create one on the Classes page first.';
      $('share-error').hidden = false;
    } else {
      const last = localStorage.getItem('cc-studio:share-class');
      if (last && classes.some((c) => String(c.id) === last)) sel.value = last;
    }
    $('share-dialog').showModal();
  }

  async function sendShare(e) {
    e.preventDefault();
    const file = api.getOpenFile();
    const btn = $('share-send');
    btn.disabled = true;
    $('share-error').hidden = true;
    try {
      const classId = $('share-class').value;
      const r = await call('POST', `/classes/${classId}/shares`, { path: file.path, content: file.content, title: $('share-name').value });
      if (!r.ok) { $('share-error').textContent = (r.json && r.json.error) || 'Could not share.'; $('share-error').hidden = false; return; }
      try { localStorage.setItem('cc-studio:share-class', classId); } catch { /* storage blocked */ }
      $('share-dialog').close();
      setStatus(`Shared with ${r.json.shared.className}`, 'ok');
    } catch {
      $('share-error').textContent = 'Could not reach the server.';
      $('share-error').hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  async function logout() {
    clearTimeout(saveTimer);
    if (user) await pushNow(); // do not lose the last edits
    try { await call('POST', '/logout', {}); } catch { /* the cookie is cleared server-side on the next visit anyway */ }
    user = null;
    $('auth-dialog').close();
    renderButton();
  }

  async function init(callbacks) {
    api = callbacks;
    let me;
    try { me = await call('GET', '/me'); } catch { return; }
    if (!me.ok) return; // no database configured: accounts are off
    user = me.json && me.json.user;
    renderButton();

    $('share').addEventListener('click', openShare);
    $('share-cancel').addEventListener('click', () => $('share-dialog').close());
    $('share-form').addEventListener('submit', sendShare);
    $('share-dialog').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
    $('menu-login').addEventListener('click', () => { closeMenu(); openDialog(); });
    $('menu-logout').addEventListener('click', () => { closeMenu(); logout(); });
    $('auth-form').addEventListener('submit', submit);
    $('auth-switch').addEventListener('click', () => setMode(mode === 'login' ? 'signup' : 'login'));
    $('auth-logout').addEventListener('click', logout);
    for (const b of document.querySelectorAll('.auth-close')) b.addEventListener('click', () => $('auth-dialog').close());
    // A click on the dimmed backdrop (the dialog element itself) closes it.
    $('auth-dialog').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
    window.addEventListener('pagehide', () => {
      if (!user || viewing) return;
      // keepalive lets the last save finish while the page is going away
      fetch('/api/workspace', {
        method: 'PUT', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: api.getWorkspace() }),
      }).catch(() => {});
    });

    if (user && (await openStudentView())) return;
    if (user) await syncAfterLogin();
  }

  /** /?view=<classId>:<studentId> (teachers): show that student's files as a throwaway copy. */
  async function openStudentView() {
    const m = /^(\d+):(\d+)$/.exec(new URLSearchParams(window.location.search).get('view') || '');
    if (!m) return false;
    const r = await call('GET', `/classes/${m[1]}/students/${m[2]}/workspace`);
    if (!r.ok || !r.json.workspace) {
      setStatus(r.ok ? 'That student has no saved files yet' : (r.json && r.json.error) || 'Could not open that student', 'err');
      return r.ok; // no files: still stay out of the way of the teacher's own work
    }
    viewing = true;
    $('share').hidden = true;
    api.enterViewOnly(`Viewing ${r.json.student}'s files from ${r.json.className}. This is a read-only copy: you can run and edit it, but nothing here is saved.`);
    applying = true;
    try { api.setWorkspace(r.json.workspace); } finally { applying = false; }
    setStatus('');
    return true;
  }

  window.CCAccount = { init, changed };
})();

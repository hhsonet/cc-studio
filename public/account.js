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

  function renderButton() {
    const btn = $('account-btn');
    btn.hidden = false;
    btn.textContent = user ? (user.username || user.email) : 'Log in';
    btn.title = user ? 'Account' : 'Log in to save your files in the cloud';
    if (!user) setStatus('');
  }

  // ---- Cloud save ----

  async function pushNow() {
    clearTimeout(saveTimer);
    if (!user) return;
    setStatus('Saving…', 'busy');
    try {
      const r = await call('PUT', '/workspace', { workspace: api.getWorkspace() });
      if (r.status === 401) { user = null; renderButton(); return; }
      setStatus(r.ok ? 'Saved to cloud' : (r.json && r.json.error) || 'Not saved', r.ok ? 'ok' : 'err');
    } catch {
      setStatus('Offline: not saved to cloud', 'err');
    }
  }

  /** Called by app.js after every local save. */
  function changed() {
    if (!user || applying) return;
    clearTimeout(saveTimer);
    setStatus('Unsaved changes', 'busy');
    saveTimer = setTimeout(pushNow, SAVE_DELAY);
  }

  const same = (a, b) => JSON.stringify(a.files) === JSON.stringify(b.files);

  /** Right after logging in: merge this browser's files with the saved cloud copy. */
  async function syncAfterLogin() {
    setStatus('Syncing…', 'busy');
    const r = await call('GET', '/workspace');
    if (!r.ok) { setStatus('Could not load cloud files', 'err'); return; }
    const cloud = r.json.workspace;
    const local = api.getWorkspace();
    if (!cloud) { await pushNow(); return; } // first time: this browser's files become the cloud copy
    if (same(cloud, local)) { setStatus('Saved to cloud', 'ok'); return; }
    const useCloud = api.isDefault() || window.confirm(
      'You have saved files in your account that differ from the files in this browser.\n\n'
      + 'OK: load your saved files (replaces what is open here).\n'
      + 'Cancel: keep what is open here and overwrite your saved files.');
    if (useCloud) {
      applying = true;
      try { api.setWorkspace(cloud); } finally { applying = false; }
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

    $('account-btn').addEventListener('click', openDialog);
    $('auth-form').addEventListener('submit', submit);
    $('auth-switch').addEventListener('click', () => setMode(mode === 'login' ? 'signup' : 'login'));
    $('auth-logout').addEventListener('click', logout);
    for (const b of document.querySelectorAll('.auth-close')) b.addEventListener('click', () => $('auth-dialog').close());
    // A click on the dimmed backdrop (the dialog element itself) closes it.
    $('auth-dialog').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
    window.addEventListener('pagehide', () => {
      if (!user) return;
      // keepalive lets the last save finish while the page is going away
      fetch('/api/workspace', {
        method: 'PUT', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: api.getWorkspace() }),
      }).catch(() => {});
    });

    if (user) await syncAfterLogin();
  }

  window.CCAccount = { init, changed };
})();

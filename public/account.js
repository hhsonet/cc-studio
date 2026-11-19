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
  let githubLogin = false; // the server has a GitHub app: show "Continue with GitHub"
  let githubWeb = false; // it also has a client secret: use GitHub's Authorize page instead of a typed code
  let ghPoll = null;
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
    $('acct-admin').hidden = !(user && user.role === 'superadmin');
    if (window.CCGithub) window.CCGithub.setUser(user && !viewing ? user : null);
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
    $('auth-name-row').hidden = !signup;
    $('auth-sid-row').hidden = !signup;
    $('auth-email-label').textContent = signup ? 'Email' : 'Email or username';
    showError('');
    if (signup && $('auth-dialog').open) $('auth-name').focus(); // the first empty field
  }

  function openDialog() {
    const dlg = $('auth-dialog');
    $('auth-form').hidden = !!user;
    $('auth-account').hidden = !user;
    if (user) $('auth-who').textContent = user.username || user.email;
    else { setMode('login'); $('auth-password').value = ''; }
    $('auth-gh').hidden = !githubLogin;
    $('auth-gh-box').hidden = true;
    if (!dlg.open) dlg.showModal();
    if (!user) $('auth-email').focus();
  }

  async function submit(e) {
    e.preventDefault();
    const btn = $('auth-submit');
    btn.disabled = true;
    showError('');
    try {
      const signup = mode === 'signup';
      if (signup && $('auth-name').value.trim().length < 2) { showError('Enter your full name.'); $('auth-name').focus(); return; }
      const r = await call('POST', signup ? '/signup' : '/login', {
        email: $('auth-email').value,
        password: $('auth-password').value,
        ...(signup ? { fullName: $('auth-name').value, studentId: $('auth-sid').value } : {}),
      });
      if (!r.ok) { showError((r.json && r.json.error) || 'Something went wrong. Try again.'); return; }
      user = r.json.user;
      $('auth-password').value = '';
      $('auth-name').value = '';
      $('auth-sid').value = '';
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

  // ---- Sign in with GitHub (device login: no password, no redirect) ----
  function stopGithubPoll() { clearTimeout(ghPoll); ghPoll = null; }

  const AUTH_MESSAGES = {
    github_denied: 'You declined the request on GitHub.',
    github_state: 'The GitHub sign-in could not be verified (it may have expired). Please try again.',
    github_failed: 'GitHub sign-in failed. Please try again.',
    login_first: 'Log in first, then connect GitHub.',
    github_taken: 'That GitHub account already belongs to another cc-studio account.',
    github_other: 'This cc-studio account is already tied to a different GitHub account.',
  };

  async function githubSignIn() {
    if (githubWeb) { window.location.href = '/api/github/oauth/login'; return; } // GitHub's own Authorize page, then back here
    const btn = $('auth-gh-btn');
    btn.disabled = true;
    showError('');
    try {
      const r = await call('POST', '/github/login/start', {});
      if (!r.ok) { showError((r.json && r.json.error) || 'Could not start the GitHub sign-in.'); return; }
      const uri = String(r.json.verificationUri || '');
      if (!uri.startsWith('https://github.com/')) { showError('GitHub sent an unexpected address. Try again.'); return; }
      $('auth-gh-verify').href = uri;
      $('auth-gh-code').textContent = r.json.userCode;
      $('auth-gh-box').hidden = false;
      pollGithubSignIn(r.json.loginId, r.json.interval || 5);
    } catch {
      showError('Could not reach the server.');
    } finally {
      btn.disabled = false;
    }
  }

  function pollGithubSignIn(loginId, seconds) {
    stopGithubPoll();
    ghPoll = setTimeout(async () => {
      if (!$('auth-dialog').open) return; // closed: stop asking
      let r;
      try { r = await call('POST', '/github/login/poll', { loginId }); } catch { pollGithubSignIn(loginId, seconds); return; }
      if (!r.ok) { $('auth-gh-box').hidden = true; showError((r.json && r.json.error) || 'GitHub sign-in failed.'); return; }
      const s = r.json.status;
      if (s === 'pending') { pollGithubSignIn(loginId, r.json.interval || seconds); return; }
      $('auth-gh-box').hidden = true;
      if (s !== 'connected') { showError(s === 'denied' ? 'You declined the request on GitHub.' : 'That code expired. Click Continue with GitHub for a new one.'); return; }
      user = r.json.user;
      $('auth-dialog').close();
      renderButton();
      await syncAfterLogin();
    }, seconds * 1000);
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
    try {
      const g = await (await fetch('/api/github/login/status')).json();
      githubLogin = Boolean(g.enabled);
      githubWeb = Boolean(g.webFlow);
    } catch { githubLogin = false; }
    renderButton();

    $('share').addEventListener('click', openShare);
    $('share-cancel').addEventListener('click', () => $('share-dialog').close());
    $('share-form').addEventListener('submit', sendShare);
    $('share-dialog').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
    $('auth-gh-btn').addEventListener('click', githubSignIn);
    $('auth-dialog').addEventListener('close', stopGithubPoll);
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

    // Coming back from GitHub with a problem: say so in the login dialog.
    const problem = AUTH_MESSAGES[new URLSearchParams(window.location.search).get('auth')];
    if (problem) {
      window.history.replaceState(null, '', window.location.pathname + window.location.hash);
      if (!user) { openDialog(); showError(problem); }
    }
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
    if (window.CCGithub) window.CCGithub.setUser(null);
    api.enterViewOnly(`Viewing ${r.json.student}'s files from ${r.json.className}. This is a read-only copy: you can run and edit it, but nothing here is saved.`);
    applying = true;
    try { api.setWorkspace(r.json.workspace); } finally { applying = false; }
    setStatus('');
    return true;
  }

  window.CCAccount = { init, changed };
})();

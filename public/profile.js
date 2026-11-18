'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

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
    $('pw-card').hidden = user.hasPassword === false; // signed in with GitHub: there is no password to change
    document.title = `${label} · cc-studio`;
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

  // ---- GitHub: connect with the device login, then link the one repository the editor pushes to and pulls from ----
  let ghStatus = null;
  let ghPoll = null;
  const gcall = (method, path, body) => call(method, `/github${path}`, body);

  function showGithub() {
    const s = ghStatus;
    $('github').hidden = !(s && s.enabled);
    if (!s || !s.enabled) return;
    $('gh-off').hidden = s.connected;
    $('gh-on').hidden = !s.connected;
    if (!s.connected) return;
    $('gh-login').textContent = `@${s.login}`;
    const now = $('gh-repo-now');
    now.replaceChildren();
    if (s.repo) {
      const a = document.createElement('a');
      a.href = `https://github.com/${encodeURIComponent(s.login)}/${encodeURIComponent(s.repo)}`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = `${s.login}/${s.repo}`;
      now.append(a);
    } else {
      now.textContent = 'None yet';
    }
    $('gh-repo-label').textContent = s.repo ? 'Change repository' : 'Link a repository';
    $('gh-link').textContent = s.repo ? 'Change' : 'Link repository';
    $('gh-unlink').hidden = !s.repo;
  }

  const AUTH_MESSAGES = {
    github_denied: 'You declined the request on GitHub.',
    github_state: 'The GitHub connection could not be verified (it may have expired). Please try again.',
    github_failed: 'Connecting GitHub failed. Please try again.',
    login_first: 'Log in first, then connect GitHub.',
    github_taken: 'That GitHub account already belongs to another cc-studio account.',
    github_other: 'This cc-studio account is already tied to a different GitHub account.',
  };

  async function loadGithub() {
    const r = await gcall('GET', '/status');
    ghStatus = r.ok ? r.json : null;
    showGithub();
    if (ghStatus && ghStatus.connected) {
      const list = $('gh-repo-list');
      const repos = await gcall('GET', '/repos');
      list.replaceChildren();
      if (repos.ok) for (const x of repos.json.repos) list.append(new Option(x.description || '', x.name));
    }
    const problem = AUTH_MESSAGES[new URLSearchParams(window.location.search).get('auth')];
    if (problem) {
      window.history.replaceState(null, '', window.location.pathname + window.location.hash);
      message($('gh-msg'), problem, 'err');
    }
    if (window.location.hash === '#github' && !$('github').hidden) $('github').scrollIntoView();
  }

  function pollGithub(seconds) {
    clearTimeout(ghPoll);
    ghPoll = setTimeout(async () => {
      let r;
      try { r = await gcall('POST', '/device/poll', {}); } catch { pollGithub(seconds); return; }
      if (!r.ok) { $('gh-code-box').hidden = true; message($('gh-msg'), (r.json && r.json.error) || 'Could not connect GitHub.', 'err'); return; }
      const st = r.json && r.json.status;
      if (st === 'connected') { $('gh-code-box').hidden = true; message($('gh-msg'), ''); await loadGithub(); return; }
      if (st === 'pending') { pollGithub(r.json.interval || seconds); return; }
      $('gh-code-box').hidden = true;
      message($('gh-msg'), st === 'denied' ? 'You declined the request on GitHub.' : 'That code expired. Click Connect GitHub for a new one.', 'err');
    }, seconds * 1000);
  }

  $('gh-connect').addEventListener('click', async () => {
    if (ghStatus && ghStatus.webFlow) { window.location.href = '/api/github/oauth/connect'; return; } // GitHub's Authorize page, then back here
    message($('gh-msg'), '');
    const btn = $('gh-connect');
    btn.disabled = true;
    try {
      const r = await gcall('POST', '/device/start', {});
      if (!r.ok) return message($('gh-msg'), (r.json && r.json.error) || 'Could not start the GitHub login.', 'err');
      const uri = String(r.json.verificationUri || '');
      if (!uri.startsWith('https://github.com/')) return message($('gh-msg'), 'GitHub sent an unexpected address. Try again.', 'err');
      $('gh-verify').href = uri;
      $('gh-code').textContent = r.json.userCode;
      $('gh-code-box').hidden = false;
      pollGithub(r.json.interval || 5);
      return null;
    } catch {
      return message($('gh-msg'), 'Could not reach the server.', 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('gh-repo-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const repo = $('gh-repo').value.trim();
    if (!repo) return message($('gh-msg'), 'Choose or type a repository name.', 'err');
    message($('gh-msg'), '');
    const btn = $('gh-link');
    btn.disabled = true;
    try {
      let r = await gcall('PUT', '/repo', { repo });
      if (r.status === 404 && r.json && r.json.canCreate) {
        if (!window.confirm(`There is no repository called "${repo}" on your GitHub that cc-studio can see.\n\nCreate it as a new public repository?`)) { message($('gh-msg'), r.json.error, 'err'); return null; }
        r = await gcall('PUT', '/repo', { repo, create: true });
      }
      if (!r.ok) {
        message($('gh-msg'), (r.json && r.json.error) || 'Could not link the repository.', 'err');
        if (r.json && r.json.needsConnect) await loadGithub();
        return null;
      }
      $('gh-repo').value = '';
      message($('gh-msg'), `Linked ${r.json.fullName}. Use GitHub in the editor to push and pull.`, 'ok');
      await loadGithub();
      return null;
    } catch {
      return message($('gh-msg'), 'Could not reach the server.', 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('gh-unlink').addEventListener('click', async () => {
    await gcall('DELETE', '/repo');
    message($('gh-msg'), 'Repository unlinked. Your files here and on GitHub are untouched.', 'ok');
    await loadGithub();
  });

  $('gh-disconnect').addEventListener('click', async () => {
    if (!window.confirm('Disconnect GitHub? cc-studio forgets your login and the linked repository. Nothing on GitHub changes.')) return;
    await gcall('DELETE', '');
    message($('gh-msg'), 'GitHub disconnected here. To revoke access completely, remove the app in your GitHub settings.', 'ok');
    await loadGithub();
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
    loadGithub();
  })();
})();

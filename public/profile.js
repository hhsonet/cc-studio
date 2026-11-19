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

  // ---- Your details: full name, student ID, and an email when the account has none ----
  function fillDetails(user) {
    $('d-name').value = user.fullName || '';
    $('d-sid').value = user.studentId || '';
    const email = $('d-email');
    email.value = user.email || '';
    email.readOnly = Boolean(user.email); // once set it is the sign-in name and cannot be changed here
    const note = $('d-email-note');
    note.hidden = false;
    note.textContent = user.email
      ? 'This is how you sign in, so it cannot be changed here.'
      : (user.hasPassword === false ? 'You sign in with GitHub. Adding an email is optional.' : 'Add an email address so you can sign in with it too.');
  }

  $('details-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('d-name').value.trim();
    if (name.length < 2) return message($('d-msg'), 'Enter your full name.', 'err');
    const btn = $('d-save');
    btn.disabled = true;
    message($('d-msg'), '');
    try {
      const r = await call('PUT', '/profile', { fullName: name, studentId: $('d-sid').value, email: $('d-email').value });
      if (!r.ok) { message($('d-msg'), (r.json && r.json.error) || 'Could not save your details.', 'err'); return; }
      me = r.json.user;
      showProfile(me, lastWorkspace.workspace, lastWorkspace.updatedAt);
      message($('d-msg'), 'Saved.', 'ok');
    } catch {
      message($('d-msg'), 'Could not reach the server.', 'err');
    } finally {
      btn.disabled = false;
    }
  });

  let lastWorkspace = { workspace: null, updatedAt: null };

  function showProfile(user, workspace, updatedAt) {
    lastWorkspace = { workspace, updatedAt };
    const label = user.username || user.email;
    window.CCAvatar.set($('avatar'), user, label.charAt(0).toUpperCase());
    $('name').textContent = label;
    $('role').hidden = !ROLES[user.role];
    $('role').textContent = ROLES[user.role] || '';
    fillDetails(user);
    $('f-username').textContent = user.username || '—';
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

  /**
   * The repository picker: a themed dropdown (the browser's <datalist> can't be styled).
   * Type to filter by name or description, ↑/↓ + Enter to pick, Esc to close. A name that is not in the list is fine:
   * it shows up as "Use ... as a new repository", and Link offers to create it. Opens upward when there is no room below.
   */
  const repoCombo = (() => {
    const input = $('gh-repo');
    const list = $('gh-repo-list');
    const toggle = $('gh-repo-toggle');
    const VALID_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/; // same rule as the server
    const SVG = 'http://www.w3.org/2000/svg';
    let repos = [];
    let rows = []; // what is on screen: { name, description?, linked?, create? }
    let active = -1;

    const icon = (d, cls) => {
      const svg = document.createElementNS(SVG, 'svg');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('class', cls);
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.7');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.append(path);
      return svg;
    };
    const CHECK = 'M3.5 8.5l3 3 6-7';
    const PLUS = 'M8 3.5v9M3.5 8h9';

    const isOpen = () => !list.hidden;
    function setActive(i) {
      active = i;
      list.querySelectorAll('[role=option]').forEach((li, n) => {
        li.setAttribute('aria-selected', String(n === i));
        if (n === i) { li.scrollIntoView({ block: 'nearest' }); input.setAttribute('aria-activedescendant', li.id); }
      });
      if (i < 0) input.removeAttribute('aria-activedescendant');
    }
    function place() { // open upward when the list would run off the bottom of the window
      list.classList.remove('up');
      const below = window.innerHeight - input.getBoundingClientRect().bottom - 12;
      const above = input.getBoundingClientRect().top - 12;
      if (list.offsetHeight > below && above > below) list.classList.add('up');
    }
    function close() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); setActive(-1); }
    function pick(i) { input.value = rows[i].name; close(); input.focus(); }

    function render() {
      const typed = input.value.trim();
      const q = typed.toLowerCase();
      const linked = ghStatus && ghStatus.repo;
      rows = repos
        .filter((r) => !q || r.name.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q))
        .map((r) => ({ name: r.name, description: r.description, linked: r.name === linked }));
      const exact = repos.some((r) => r.name.toLowerCase() === q);
      if (typed && !exact && VALID_NAME.test(typed)) rows.push({ name: typed, create: true });

      list.replaceChildren();
      rows.forEach((r, n) => {
        const li = document.createElement('li');
        li.id = `gh-repo-opt-${n}`;
        li.setAttribute('role', 'option');
        if (r.create) {
          li.className = 'combo-create';
          li.append(icon(PLUS, 'combo-glyph'));
          const t = document.createElement('span');
          t.className = 'combo-main';
          const lead = document.createElement('span');
          lead.className = 'combo-desc';
          lead.textContent = 'Create a new public repository';
          const nm = document.createElement('span');
          nm.className = 'combo-name';
          nm.textContent = r.name;
          t.append(nm, lead);
          li.append(t);
        } else {
          const t = document.createElement('span');
          t.className = 'combo-main';
          const nm = document.createElement('span');
          nm.className = 'combo-name';
          nm.textContent = r.name;
          t.append(nm);
          if (r.description) {
            const d = document.createElement('span');
            d.className = 'combo-desc';
            d.textContent = r.description;
            t.append(d);
          }
          li.append(t);
          if (r.linked) {
            li.classList.add('is-linked');
            const mark = icon(CHECK, 'combo-check');
            mark.setAttribute('role', 'img');
            mark.setAttribute('aria-label', 'Currently linked');
            li.append(mark);
          }
        }
        li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(n); }); // before the input loses focus
        li.addEventListener('mousemove', () => { if (active !== n) setActive(n); });
        list.append(li);
      });
      if (!rows.length) {
        const li = document.createElement('li');
        li.className = 'combo-empty';
        li.setAttribute('role', 'presentation');
        li.textContent = !repos.length ? 'No repositories on your GitHub yet. Type a name to create one.' : `Nothing matches "${typed}". Names can use letters, digits, . _ -`;
        list.append(li);
      }
      const hint = document.createElement('li');
      hint.className = 'combo-hint';
      hint.setAttribute('role', 'presentation');
      for (const [k, label] of [['↑↓', 'move'], ['Enter', 'choose'], ['Esc', 'close']]) {
        const kbd = document.createElement('kbd');
        kbd.textContent = k;
        hint.append(kbd, ` ${label} `);
      }
      list.append(hint);
      // Start on the top match so Enter picks it, unless what is typed already is a full name (then Enter submits the form).
      setActive(typed && rows.length && !exact ? 0 : -1);
    }
    function open() {
      render();
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      place();
    }

    input.addEventListener('focus', open);
    input.addEventListener('input', open);
    toggle.addEventListener('mousedown', (e) => { e.preventDefault(); if (isOpen()) close(); else { input.focus(); open(); } });
    input.addEventListener('blur', close);
    window.addEventListener('resize', () => { if (isOpen()) place(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!isOpen()) open();
        if (!rows.length) return;
        setActive((active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
      } else if (e.key === 'Enter' && isOpen() && active >= 0) {
        e.preventDefault(); // choose the highlighted row instead of submitting
        pick(active);
      } else if (e.key === 'Escape' && isOpen()) {
        e.preventDefault();
        close();
      }
    });
    return { setRepos(r) { repos = r || []; if (isOpen()) render(); } };
  })();

  async function loadGithub() {
    const r = await gcall('GET', '/status');
    ghStatus = r.ok ? r.json : null;
    showGithub();
    if (ghStatus && ghStatus.connected) {
      const repos = await gcall('GET', '/repos');
      repoCombo.setRepos(repos.ok ? repos.json.repos : []);
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

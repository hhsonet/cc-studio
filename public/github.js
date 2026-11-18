'use strict';

// Export the project to a GitHub repository (lib/github.js). The button only shows up when the server
// has a GitHub OAuth App configured. app.js hands in getWorkspace(); account.js tells us who is signed in.
(function () {
  const $ = (id) => document.getElementById(id);
  let api = null;
  let status = null; // { enabled, connected, login, canBePrivate }
  let pollTimer = null;
  let repoEdited = false; // stop suggesting a repository name once the user types their own

  async function call(method, path, body) {
    const res = await fetch(`/api/github${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, json };
  }

  const show = (id, text) => { const el = $(id); el.textContent = text || ''; el.hidden = !text; };

  async function refreshStatus() {
    const r = await call('GET', '/status');
    status = r.ok ? r.json : null;
    return status;
  }

  /** Called by account.js on login/logout: the button exists only for a signed-in user on a server with GitHub set up. */
  async function setUser(user) {
    const btn = $('gh-btn');
    if (!user) { btn.hidden = true; return; }
    try { await refreshStatus(); } catch { status = null; }
    btn.hidden = !(status && status.enabled);
  }

  // ---- Connect (device login) ----
  function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }

  async function startConnect() {
    show('gh-connect-error', '');
    $('gh-connect').disabled = true;
    try {
      const r = await call('POST', '/device/start', {});
      if (!r.ok) { show('gh-connect-error', (r.json && r.json.error) || 'Could not start the GitHub login.'); return; }
      const uri = String(r.json.verificationUri || '');
      if (!uri.startsWith('https://github.com/')) { show('gh-connect-error', 'GitHub sent an unexpected address. Try again.'); return; }
      $('gh-verify').href = uri;
      $('gh-code').textContent = r.json.userCode;
      $('gh-code-box').hidden = false;
      poll(r.json.interval || 5);
    } catch {
      show('gh-connect-error', 'Could not reach the server.');
    } finally {
      $('gh-connect').disabled = false;
    }
  }

  function poll(seconds) {
    stopPolling();
    pollTimer = setTimeout(async () => {
      if (!$('gh-dialog').open) return;
      let r;
      try { r = await call('POST', '/device/poll', {}); } catch { poll(seconds); return; }
      const s = r.json && r.json.status;
      if (s === 'connected') { stopPolling(); await refreshStatus(); showExport(); return; }
      if (s === 'pending') { poll((r.json.interval || seconds)); return; }
      stopPolling();
      $('gh-code-box').hidden = true;
      show('gh-connect-error', s === 'denied' ? 'You declined the request on GitHub.' : 'That code expired. Click Connect GitHub to get a new one.');
    }, seconds * 1000);
  }

  // ---- Export ----
  const suggestName = (what) => (what || 'cc-studio-project').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 100) || 'cc-studio-project';

  function folders(files) {
    return [...new Set(Object.keys(files).filter((p) => p.includes('/')).map((p) => p.split('/')[0]))].sort();
  }

  function showTab(which) {
    const pull = which === 'pull';
    $('gh-tab-push').classList.toggle('on', !pull);
    $('gh-tab-pull').classList.toggle('on', pull);
    $('gh-export-view').hidden = pull;
    $('gh-import-view').hidden = !pull;
    if (pull) loadRepoList();
  }

  async function loadRepoList() {
    const list = $('gh-repo-list');
    list.replaceChildren();
    try {
      const r = await call('GET', '/repos');
      if (!r.ok) return;
      for (const repo of r.json.repos) list.append(new Option(repo.description || '', repo.name));
    } catch { /* typing the name still works */ }
  }

  function showExport() {
    $('gh-connect-view').hidden = true;
    $('gh-connected').hidden = false;
    showTab('push');
    $('gh-login').textContent = `@${status.login}`;
    $('gh-private-row').hidden = !status.canBePrivate;
    const sel = $('gh-what');
    sel.replaceChildren(new Option('All my files (folders kept as they are)', ''));
    for (const f of folders(api.getWorkspace().files)) sel.append(new Option(`Folder "${f}" (its files become the repository root)`, f));
    if (!repoEdited) $('gh-repo').value = suggestName(sel.value);
    show('gh-error', '');
    $('gh-result').hidden = true;
  }

  function showConnect() {
    $('gh-connected').hidden = true;
    $('gh-import-view').hidden = true;
    $('gh-export-view').hidden = true;
    $('gh-connect-view').hidden = false;
    $('gh-code-box').hidden = true;
    show('gh-connect-error', '');
  }

  function filesToExport() {
    const all = api.getWorkspace().files;
    const folder = $('gh-what').value;
    if (!folder) return { ...all };
    const out = {};
    for (const [p, text] of Object.entries(all)) if (p.startsWith(`${folder}/`)) out[p.slice(folder.length + 1)] = text;
    return out;
  }

  async function submit(e) {
    e.preventDefault();
    const btn = $('gh-export');
    btn.disabled = true;
    show('gh-error', '');
    $('gh-result').hidden = true;
    try {
      const r = await call('POST', '/export', {
        repo: $('gh-repo').value.trim(),
        files: filesToExport(),
        message: $('gh-message').value,
        private: !$('gh-private-row').hidden && $('gh-private').checked,
      });
      if (!r.ok) {
        show('gh-error', (r.json && r.json.error) || 'Could not export.');
        if (r.json && r.json.needsConnect) { await refreshStatus(); showConnect(); show('gh-connect-error', r.json.error); }
        return;
      }
      const out = $('gh-result');
      out.replaceChildren();
      const link = document.createElement('a');
      link.href = r.json.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = r.json.repo;
      out.append(r.json.unchanged ? 'Nothing changed since the last export: ' : r.json.created ? 'Created and exported to ' : 'Exported to ', link);
      out.hidden = false;
    } catch {
      show('gh-error', 'Could not reach the server.');
    } finally {
      btn.disabled = false;
    }
  }

  // ---- Pull (clone or update a folder from a repository) ----
  const folderFor = (repo) => repo.replace(/\.{2,}/g, '.').replace(/^\.+/, '') || 'repo';

  async function pull(e) {
    e.preventDefault();
    const btn = $('gh-pull');
    const repo = $('gh-pull-repo').value.trim();
    show('gh-pull-error', '');
    $('gh-pull-result').hidden = true;
    if (!repo) return show('gh-pull-error', 'Choose or type a repository name.');
    btn.disabled = true;
    try {
      const r = await call('POST', '/import', { repo, branch: $('gh-pull-branch').value.trim() });
      if (!r.ok) {
        show('gh-pull-error', (r.json && r.json.error) || 'Could not pull.');
        if (r.json && r.json.needsConnect) { await refreshStatus(); showConnect(); show('gh-connect-error', r.json.error); }
        return;
      }
      const folder = folderFor(repo);
      const local = api.getWorkspace().files;
      const remote = r.json.files;
      const changed = Object.keys(remote).filter((p) => local[`${folder}/${p}`] !== undefined && local[`${folder}/${p}`] !== remote[p]);
      if (changed.length && !window.confirm(`These files in "${folder}/" differ from GitHub and will be replaced with GitHub's version:\n\n${changed.slice(0, 12).join('\n')}${changed.length > 12 ? `\n…and ${changed.length - 12} more` : ''}\n\nYour other files are kept. Continue?`)) return;
      api.applyFolder(folder, remote);
      const n = Object.keys(remote).length;
      const skipped = r.json.skipped ? ` ${r.json.skipped} other file${r.json.skipped === 1 ? ' was' : 's were'} left out (not source code cc-studio can open).` : '';
      show('gh-pull-result', `Pulled ${n} file${n === 1 ? '' : 's'} from ${r.json.repo} (${r.json.branch}) into "${folder}/".${skipped}`);
    } catch {
      show('gh-pull-error', 'Could not reach the server.');
    } finally {
      btn.disabled = false;
    }
  }

  async function open() {
    const dlg = $('gh-dialog');
    await refreshStatus();
    if (!status || !status.enabled) return;
    if (status.connected) showExport(); else showConnect();
    if (!dlg.open) dlg.showModal();
  }

  function init(callbacks) {
    api = callbacks;
    $('gh-btn').addEventListener('click', open);
    $('gh-connect').addEventListener('click', startConnect);
    $('gh-export-view').addEventListener('submit', submit);
    $('gh-import-view').addEventListener('submit', pull);
    $('gh-tab-push').addEventListener('click', () => showTab('push'));
    $('gh-tab-pull').addEventListener('click', () => showTab('pull'));
    $('gh-repo').addEventListener('input', () => { repoEdited = true; });
    $('gh-what').addEventListener('change', () => { if (!repoEdited) $('gh-repo').value = suggestName($('gh-what').value); });
    $('gh-disconnect').addEventListener('click', async () => {
      await call('DELETE', '');
      await refreshStatus();
      showConnect();
    });
    for (const b of document.querySelectorAll('.gh-close')) b.addEventListener('click', () => $('gh-dialog').close());
    $('gh-dialog').addEventListener('close', stopPolling);
    $('gh-dialog').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  }

  window.CCGithub = { init, setUser };
})();

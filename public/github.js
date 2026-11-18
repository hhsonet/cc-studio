'use strict';

// Push and pull the one repository linked in the user's profile (lib/github.js). The button only shows
// up when the server has GitHub set up. app.js hands in getWorkspace() and applyFolder(); account.js
// tells us who is signed in. Connecting an account and choosing the repository happen on the profile page.
(function () {
  const $ = (id) => document.getElementById(id);
  let api = null;
  let status = null; // { enabled, connected, login, repo }

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

  // The repository's files live in a folder of the same name.
  const folderFor = (repo) => repo.replace(/\.{2,}/g, '.').replace(/^\.+/, '') || 'repo';

  function showTab(which) {
    const pull = which === 'pull';
    $('gh-tab-push').classList.toggle('on', !pull);
    $('gh-tab-pull').classList.toggle('on', pull);
    $('gh-export-view').hidden = pull;
    $('gh-import-view').hidden = !pull;
  }

  function showReady() {
    const folder = folderFor(status.repo);
    $('gh-setup').hidden = true;
    $('gh-ready').hidden = false;
    const link = $('gh-repo-link');
    link.textContent = `${status.login}/${status.repo}`;
    link.href = `https://github.com/${encodeURIComponent(status.login)}/${encodeURIComponent(status.repo)}`;
    $('gh-pull-folder').textContent = `${folder}/`;
    const count = Object.keys(filesToPush()).length;
    $('gh-what').textContent = count
      ? `Pushes the folder "${folder}/" (${count} file${count === 1 ? '' : 's'}). Its files become the repository root.`
      : `There is no folder called "${folder}/" here yet. Pull first to bring the repository in, or create a folder with that name and add your files.`;
    $('gh-export').disabled = count === 0;
    show('gh-error', '');
    show('gh-pull-error', '');
    $('gh-result').hidden = true;
    $('gh-pull-result').hidden = true;
    showTab('push');
  }

  function showSetup() {
    $('gh-ready').hidden = true;
    $('gh-setup').hidden = false;
    $('gh-setup-text').textContent = status.connected
      ? 'Choose the repository you want to push to and pull from in your profile.'
      : 'Connect your GitHub account and choose a repository in your profile. It takes a minute.';
  }

  /** Only the repository's own folder is ever pushed, with the folder name stripped. */
  function filesToPush() {
    const all = api.getWorkspace().files;
    const folder = folderFor(status.repo);
    const out = {};
    for (const [p, text] of Object.entries(all)) if (p.startsWith(`${folder}/`)) out[p.slice(folder.length + 1)] = text;
    return out;
  }

  /** The profile has no repository (or no login) any more: say so and point there. */
  async function lostLink(message) {
    await refreshStatus();
    showSetup();
    $('gh-setup-text').textContent = message;
  }

  async function push(e) {
    e.preventDefault();
    const btn = $('gh-export');
    btn.disabled = true;
    show('gh-error', '');
    $('gh-result').hidden = true;
    try {
      const files = filesToPush();
      if (Object.keys(files).length === 0) return show('gh-error', `There are no files in "${folderFor(status.repo)}/" to push.`);
      const r = await call('POST', '/export', { files, message: $('gh-message').value });
      if (!r.ok) {
        if (r.json && (r.json.needsConnect || r.json.needsRepo)) return lostLink(r.json.error);
        return show('gh-error', (r.json && r.json.error) || 'Could not push.');
      }
      const out = $('gh-result');
      out.replaceChildren();
      const link = document.createElement('a');
      link.href = r.json.commitUrl || r.json.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = r.json.repo;
      out.append(r.json.unchanged ? 'Nothing changed since the last push: ' : 'Pushed to ', link);
      out.hidden = false;
      return null;
    } catch {
      return show('gh-error', 'Could not reach the server.');
    } finally {
      btn.disabled = false;
    }
  }

  async function pull(e) {
    e.preventDefault();
    const btn = $('gh-pull');
    btn.disabled = true;
    show('gh-pull-error', '');
    $('gh-pull-result').hidden = true;
    try {
      const r = await call('POST', '/import', {});
      if (!r.ok) {
        if (r.json && (r.json.needsConnect || r.json.needsRepo)) return lostLink(r.json.error);
        return show('gh-pull-error', (r.json && r.json.error) || 'Could not pull.');
      }
      const folder = folderFor(status.repo);
      const local = api.getWorkspace().files;
      const remote = r.json.files;
      const changed = Object.keys(remote).filter((p) => local[`${folder}/${p}`] !== undefined && local[`${folder}/${p}`] !== remote[p]);
      if (changed.length && !window.confirm(`These files in "${folder}/" differ from GitHub and will be replaced with GitHub's version:\n\n${changed.slice(0, 12).join('\n')}${changed.length > 12 ? `\n…and ${changed.length - 12} more` : ''}\n\nYour other files are kept. Continue?`)) return null;
      api.applyFolder(folder, remote);
      const n = Object.keys(remote).length;
      const skipped = r.json.skipped ? ` ${r.json.skipped} other file${r.json.skipped === 1 ? ' was' : 's were'} left out (not text cc-studio can open).` : '';
      return show('gh-pull-result', `Pulled ${n} file${n === 1 ? '' : 's'} from ${r.json.repo} (${r.json.branch}) into "${folder}/".${skipped}`);
    } catch {
      return show('gh-pull-error', 'Could not reach the server.');
    } finally {
      btn.disabled = false;
    }
  }

  async function open() {
    await refreshStatus();
    if (!status || !status.enabled) return;
    if (status.connected && status.repo) showReady(); else showSetup();
    if (!$('gh-dialog').open) $('gh-dialog').showModal();
  }

  function init(callbacks) {
    api = callbacks;
    $('gh-btn').addEventListener('click', open);
    $('gh-export-view').addEventListener('submit', push);
    $('gh-import-view').addEventListener('submit', pull);
    $('gh-tab-push').addEventListener('click', () => showTab('push'));
    $('gh-tab-pull').addEventListener('click', () => showTab('pull'));
    for (const b of document.querySelectorAll('.gh-close')) b.addEventListener('click', () => $('gh-dialog').close());
    $('gh-dialog').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  }

  window.CCGithub = { init, setUser };
})();

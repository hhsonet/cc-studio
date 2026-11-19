'use strict';

// Pull and Push buttons in the top bar for the one repository linked in the user's profile (lib/github.js).
// They show up when the user has connected GitHub. app.js hands in getWorkspace() and applyFolder();
// account.js tells us who is signed in. Connecting an account and choosing the repository happen on the profile page.
(function () {
  const $ = (id) => document.getElementById(id);
  let api = null;
  let status = null; // { enabled, connected, login, repo }
  let statusTimer = null;

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

  function showButtons() {
    const on = Boolean(status && status.enabled && status.connected);
    $('gh-pull-btn').hidden = !on;
    $('gh-push-btn').hidden = !on;
    $('tab-git').hidden = !on;
    if (!on) {
      $('gh-status').hidden = true;
      if (api && api.isGitTabOpen()) api.leaveGitTab(); // the tab went away: fall back to the Console
    }
  }

  /** Called by account.js on login/logout: the buttons exist only for a signed-in user who has connected GitHub. */
  async function setUser(user) {
    if (!user) { status = null; showButtons(); return; }
    try { await refreshStatus(); } catch { status = null; }
    showButtons();
  }

  /** A short note next to the buttons that fades after a few seconds. */
  function note(text, kind) {
    const el = $('gh-status');
    clearTimeout(statusTimer);
    el.textContent = text;
    el.className = `cloud-status ${kind || ''}`.trim();
    el.hidden = !text;
    if (text) statusTimer = setTimeout(() => { el.hidden = true; }, 8000);
  }

  // The repository's files live in a folder of the same name.
  const folderFor = (repo) => repo.replace(/\.{2,}/g, '.').replace(/^\.+/, '') || 'repo';

  /** Show a message in the dialog, with a link to the profile when something there needs doing. */
  function showMessage(text, withProfileLink) {
    $('gh-export-view').hidden = true;
    $('gh-setup').hidden = false;
    $('gh-setup-text').textContent = text;
    $('gh-profile-link').hidden = !withProfileLink;
    if (!$('gh-dialog').open) $('gh-dialog').showModal();
  }

  /** A needsConnect / needsRepo answer: the profile has lost the login or the repository. */
  async function lostLink(message) {
    await refreshStatus();
    showButtons();
    showMessage(message, true);
  }

  async function ensureLinked() {
    await refreshStatus();
    showButtons();
    if (!status || !status.enabled) return false;
    if (!status.connected) { showMessage('Connect your GitHub account and choose a repository in your profile.', true); return false; }
    if (!status.repo) { showMessage('Choose the repository you want to push to and pull from in your profile.', true); return false; }
    return true;
  }

  // ---- Pull: one click ----
  async function pull() {
    const btn = $('gh-pull-btn');
    if (btn.disabled || !(await ensureLinked())) return;
    btn.disabled = true;
    note('Pulling…');
    try {
      const r = await call('POST', '/import', {});
      if (!r.ok) {
        note('');
        if (r.json && (r.json.needsConnect || r.json.needsRepo)) return await lostLink(r.json.error);
        return showMessage((r.json && r.json.error) || 'Could not pull.', false);
      }
      const folder = folderFor(status.repo);
      const local = api.getWorkspace().files;
      const remote = r.json.files;
      const changed = Object.keys(remote).filter((p) => local[`${folder}/${p}`] !== undefined && local[`${folder}/${p}`] !== remote[p]);
      if (changed.length && !window.confirm(`These files in "${folder}/" differ from GitHub and will be replaced with GitHub's version:\n\n${changed.slice(0, 12).join('\n')}${changed.length > 12 ? `\n…and ${changed.length - 12} more` : ''}\n\nYour other files are kept. Continue?`)) {
        return note('Pull cancelled');
      }
      api.applyFolder(folder, remote);
      const n = Object.keys(remote).length;
      api.log(`GitHub: pulled ${n} file${n === 1 ? '' : 's'} from ${r.json.repo} into ${folder}/`);
      return note(`Pulled ${n} file${n === 1 ? '' : 's'} into ${folder}/${r.json.skipped ? ` (${r.json.skipped} skipped)` : ''}`, 'ok');
    } catch {
      note('');
      return showMessage('Could not reach the server.', false);
    } finally {
      btn.disabled = false;
    }
  }

  // ---- Push: a small dialog for the commit message ----

  /** Only the repository's own folder is ever pushed, with the folder name stripped. */
  function filesToPush() {
    const all = api.getWorkspace().files;
    const folder = folderFor(status.repo);
    const out = {};
    for (const [p, text] of Object.entries(all)) if (p.startsWith(`${folder}/`)) out[p.slice(folder.length + 1)] = text;
    return out;
  }

  async function openPush() {
    if (!(await ensureLinked())) return;
    const folder = folderFor(status.repo);
    $('gh-setup').hidden = true;
    $('gh-export-view').hidden = false;
    const link = $('gh-repo-link');
    link.textContent = `${status.login}/${status.repo}`;
    link.href = `https://github.com/${encodeURIComponent(status.login)}/${encodeURIComponent(status.repo)}`;
    const count = Object.keys(filesToPush()).length;
    $('gh-what').textContent = count
      ? `Pushes the folder "${folder}/" (${count} file${count === 1 ? '' : 's'}). Its files become the repository root.`
      : `There is no folder called "${folder}/" here yet. Pull first to bring the repository in, or create a folder with that name and add your files.`;
    $('gh-export').disabled = count === 0;
    show('gh-error', '');
    $('gh-result').hidden = true;
    if (!$('gh-dialog').open) $('gh-dialog').showModal();
    $('gh-message').focus();
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
        if (r.json && (r.json.needsConnect || r.json.needsRepo)) return await lostLink(r.json.error);
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
      const n = Object.keys(files).length;
      api.log(r.json.unchanged
        ? `GitHub: nothing to push to ${r.json.repo} (no changes)`
        : `GitHub: pushed ${n} file${n === 1 ? '' : 's'} to ${r.json.repo}${$('gh-message').value.trim() ? ` · "${$('gh-message').value.trim()}"` : ''}`);
      if (api.isGitTabOpen()) loadHistory(); // the new commit shows up right away
      $('gh-message').value = '';
      return null;
    } catch {
      return show('gh-error', 'Could not reach the server.');
    } finally {
      btn.disabled = Object.keys(filesToPush()).length === 0;
    }
  }

  // ---- Git tab: the linked repository's recent commits ----
  function relTime(iso) {
    const t = Date.parse(iso);
    if (!t) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    const units = [[31536000, 'year'], [2592000, 'month'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
    for (const [secs, name] of units) {
      if (s >= secs) { const n = Math.floor(s / secs); return `${n} ${name}${n === 1 ? '' : 's'} ago`; }
    }
    return 'just now';
  }

  function gitMessage(text, profile) {
    const el = $('git-msg');
    el.replaceChildren(text);
    if (profile) {
      const a = document.createElement('a');
      a.href = '/profile#github';
      a.textContent = 'Open profile';
      el.append(' ', a);
    }
    el.hidden = !text;
  }

  async function loadHistory() {
    const list = $('git-list');
    if (!api) return;
    list.replaceChildren();
    gitMessage('', false);
    $('git-repo').textContent = '';
    try { await refreshStatus(); } catch { status = null; }
    showButtons();
    if (!status || !status.connected) { gitMessage('Connect your GitHub account in your profile to see its history here.', true); return; }
    if (!status.repo) { gitMessage('Choose a repository in your profile to see its history here.', true); return; }
    gitMessage('Loading…', false);
    let r;
    try { r = await call('GET', '/commits'); } catch { gitMessage('Could not reach the server.', false); return; }
    if (!r.ok) {
      if (r.json && (r.json.needsConnect || r.json.needsRepo)) { await refreshStatus(); showButtons(); gitMessage(r.json.error, true); return; }
      gitMessage((r.json && r.json.error) || 'Could not load the history.', false);
      return;
    }
    const repoLink = document.createElement('a');
    repoLink.href = `https://github.com/${r.json.repo}`;
    repoLink.target = '_blank';
    repoLink.rel = 'noopener noreferrer';
    repoLink.textContent = r.json.repo;
    $('git-repo').replaceChildren(repoLink);
    gitMessage(r.json.commits.length ? '' : (r.json.empty ? 'This repository has no commits yet.' : 'No commits found.'), false);
    r.json.commits.forEach((c, i) => {
      const li = document.createElement('li');
      li.className = 'commit';
      const msg = document.createElement(c.url ? 'a' : 'span');
      msg.className = 'commit-msg';
      msg.textContent = c.message || '(no message)';
      if (c.url) { msg.href = c.url; msg.target = '_blank'; msg.rel = 'noopener noreferrer'; }
      const meta = document.createElement('span');
      meta.className = 'commit-meta';
      meta.textContent = `${c.sha} · ${c.author}${c.date ? ` · ${relTime(c.date)}` : ''}`;
      li.append(msg, meta);
      if (i === 0) {
        const chip = document.createElement('span');
        chip.className = 'chip commit-latest';
        chip.textContent = 'latest';
        li.append(chip);
      }
      list.append(li);
    });
  }

  function init(callbacks) {
    api = callbacks;
    $('gh-pull-btn').addEventListener('click', pull);
    $('git-refresh').addEventListener('click', loadHistory);
    $('gh-push-btn').addEventListener('click', openPush);
    $('gh-export-view').addEventListener('submit', push);
    for (const b of document.querySelectorAll('.gh-close')) b.addEventListener('click', () => $('gh-dialog').close());
    $('gh-dialog').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  }

  window.CCGithub = { init, setUser, loadHistory };
})();

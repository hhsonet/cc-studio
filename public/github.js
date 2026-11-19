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
      // The repository wins: a file that exists on both sides takes GitHub's version, no questions asked.
      // Files that exist only here are kept. The Console names every file that was overwritten.
      const replaced = Object.keys(remote).filter((p) => local[`${folder}/${p}`] !== undefined && local[`${folder}/${p}`] !== remote[p]);
      api.applyFolder(folder, remote);
      const n = Object.keys(remote).length;
      const s = (k) => (k === 1 ? '' : 's');
      api.log(`GitHub: pulled ${n} file${s(n)} from ${r.json.repo} into ${folder}/`);
      if (replaced.length) api.log(`GitHub: replaced ${replaced.length} changed file${s(replaced.length)}: ${replaced.map((p) => `${folder}/${p}`).join(', ')}`);
      return note(`Pulled ${n} file${s(n)} into ${folder}/${replaced.length ? ` (${replaced.length} replaced)` : ''}${r.json.skipped ? ` (${r.json.skipped} skipped)` : ''}`, 'ok');
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

  /** The bar and wording while a push is running; the commit message is locked so it can't change under the request. */
  function pushBusy(on, count) {
    const btn = $('gh-export');
    $('gh-progress').hidden = !on;
    $('gh-message').disabled = on;
    $('gh-export-view').setAttribute('aria-busy', String(on));
    if (on) {
      btn.textContent = 'Pushing…';
      show('gh-progress-text', `Pushing ${count} file${count === 1 ? '' : 's'} to ${status.login}/${status.repo}…`);
    } else {
      btn.textContent = 'Push';
      show('gh-progress-text', '');
    }
  }

  async function push(e) {
    e.preventDefault();
    const btn = $('gh-export');
    if (btn.disabled) return null; // Enter in the message box while a push is already running
    btn.disabled = true;
    show('gh-error', '');
    $('gh-result').hidden = true;
    try {
      const files = filesToPush();
      if (Object.keys(files).length === 0) return show('gh-error', `There are no files in "${folderFor(status.repo)}/" to push.`);
      pushBusy(true, Object.keys(files).length);
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
      pushBusy(false);
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

  // ---- Git tab: a graph of commits; click one to see the files it changed as a tree ----

  const changeCache = new Map(); // full commit id -> the server's answer (a commit never changes)
  const STATUS = { added: ['A', 'Added'], modified: ['M', 'Modified'], removed: ['D', 'Deleted'], renamed: ['R', 'Renamed'] };
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function glyph(d, cls) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', cls);
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    for (const [k, v] of [['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.6'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) p.setAttribute(k, v);
    svg.append(p);
    return svg;
  }

  const plain = (text) => { const p = document.createElement('p'); p.className = 'chg-note'; p.textContent = text; return p; };

  /** Paths -> nested folders. A folder with one folder inside and no files is joined with it (a/b/c/), like GitHub does. */
  function renderChangeTree(files) {
    const root = { dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.path.split('/');
      let node = root;
      for (const d of parts.slice(0, -1)) {
        if (!node.dirs.has(d)) node.dirs.set(d, { dirs: new Map(), files: [] });
        node = node.dirs.get(d);
      }
      node.files.push({ ...f, name: parts[parts.length - 1] });
    }
    const ul = document.createElement('ul');
    ul.className = 'chg';
    const row = (cls, depth) => { const li = document.createElement('li'); li.className = cls; li.style.setProperty('--d', String(depth)); ul.append(li); return li; };
    const counts = (li, f) => {
      if (!f.additions && !f.deletions) return;
      const n = document.createElement('span');
      n.className = 'chg-n';
      if (f.additions) { const a = document.createElement('span'); a.className = 'add'; a.textContent = `+${f.additions}`; n.append(a, ' '); }
      if (f.deletions) { const d = document.createElement('span'); d.className = 'del'; d.textContent = `−${f.deletions}`; n.append(d); }
      li.append(n);
    };
    (function walk(node, depth) {
      for (const [name, child0] of [...node.dirs].sort((x, y) => x[0].localeCompare(y[0]))) {
        let label = name;
        let child = child0;
        while (child.files.length === 0 && child.dirs.size === 1) {
          const [next, inner] = [...child.dirs][0];
          label += `/${next}`;
          child = inner;
        }
        const li = row('chg-dir', depth);
        li.textContent = `${label}/`;
        walk(child, depth + 1);
      }
      for (const f of [...node.files].sort((x, y) => x.name.localeCompare(y.name))) {
        const [letter, word] = STATUS[f.status] || STATUS.modified;
        const li = row(`chg-file ${f.status}`, depth);
        const st = document.createElement('span');
        st.className = 'chg-st';
        st.textContent = letter;
        st.title = word;
        const nm = document.createElement('span');
        nm.className = 'chg-name';
        nm.textContent = f.name;
        if (f.from) nm.title = `Renamed from ${f.from}`;
        li.append(st, nm);
        counts(li, f);
      }
    })(root, 0);
    return ul;
  }

  function renderChanges(d) {
    const box = document.createDocumentFragment();
    const sum = document.createElement('p');
    sum.className = 'chg-sum';
    const n = d.total || d.files.length;
    sum.append(n ? `${n} file${n === 1 ? '' : 's'} changed` : 'No file changes in this commit');
    if (d.additions) { const a = document.createElement('span'); a.className = 'add'; a.textContent = ` +${d.additions}`; sum.append(a); }
    if (d.deletions) { const x = document.createElement('span'); x.className = 'del'; x.textContent = ` −${d.deletions}`; sum.append(x); }
    box.append(sum);
    const body = (d.message || '').split('\n').slice(1).join('\n').trim();
    if (body) { const b = document.createElement('p'); b.className = 'chg-body'; b.textContent = body; box.append(b); }
    if (d.files.length) box.append(renderChangeTree(d.files));
    if (d.total > d.files.length) box.append(plain(`Showing the first ${d.files.length} of ${d.total} files.`));
    return box;
  }

  async function toggleCommit(li, toggle, detail, c) {
    const opening = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(opening));
    li.classList.toggle('open', opening);
    detail.hidden = !opening;
    if (!opening || detail.dataset.loaded) return;
    const key = c.fullSha || c.sha;
    if (!changeCache.has(key)) {
      detail.replaceChildren(plain('Loading changes…'));
      let r;
      try { r = await call('GET', `/commits/${encodeURIComponent(key)}`); } catch { detail.replaceChildren(plain('Could not reach the server. Click the commit to try again.')); detail.dataset.loaded = ''; return; }
      if (!r.ok) { detail.replaceChildren(plain((r.json && r.json.error) || 'Could not load the changes.')); return; } // not cached: a second click retries
      changeCache.set(key, r.json);
    }
    detail.replaceChildren(renderChanges(changeCache.get(key)));
    detail.dataset.loaded = '1';
  }

  function commitRow(c, i) {
    const li = document.createElement('li');
    li.className = 'commit';
    const detail = document.createElement('div');
    detail.className = 'commit-detail';
    detail.id = `commit-detail-${i}`;
    detail.hidden = true;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'commit-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', detail.id);
    const msg = document.createElement('span');
    msg.className = 'commit-msg';
    msg.textContent = c.message || '(no message)';
    const meta = document.createElement('span');
    meta.className = 'commit-meta';
    meta.textContent = `${c.sha} · ${c.author}${c.date ? ` · ${relTime(c.date)}` : ''}`;
    toggle.append(msg, meta);
    if (i === 0) {
      const chip = document.createElement('span');
      chip.className = 'chip commit-latest';
      chip.textContent = 'latest';
      toggle.append(chip);
    }
    toggle.append(glyph('M4 6l4 4 4-4', 'commit-chev'));
    toggle.addEventListener('click', () => toggleCommit(li, toggle, detail, c));
    li.append(toggle);
    if (c.url) {
      const ext = document.createElement('a');
      ext.className = 'commit-ext';
      ext.href = c.url;
      ext.target = '_blank';
      ext.rel = 'noopener noreferrer';
      ext.title = 'Open on GitHub';
      ext.setAttribute('aria-label', `Open commit ${c.sha} on GitHub`);
      ext.append(glyph('M6.5 3.5h-3v9h9v-3M9 3.5h3.5V7M12.5 3.5L7.5 8.5', 'commit-ext-icon'));
      li.append(ext);
    }
    li.append(detail);
    return li;
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
    r.json.commits.forEach((c, i) => list.append(commitRow(c, i)));
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

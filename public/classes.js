'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  // ---- Helpers ----
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
  const errText = (r, fallback) => (r.json && r.json.error) || fallback;
  const fmtDate = (v) => (v ? new Date(v).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
  const fmtDateTime = (v) => (v ? new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  function msg(id, text, kind) {
    const el = $(id);
    el.textContent = text || '';
    el.className = `msg ${kind || ''}`.trim();
    el.hidden = !text;
  }
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    for (const k of kids) if (k != null) n.append(k);
    return n;
  }
  const button = (text, cls, onClick) => el('button', { type: 'button', className: `btn ${cls || ''}`.trim(), textContent: text, onclick: onClick });
  const who = (u) => u.username || u.email;

  let role = null; // 'teacher' | 'student'

  // ---- Class list ----
  async function showList() {
    $('detail').hidden = true;
    $('list').hidden = false;
    const r = await call('GET', '/classes');
    if (!r.ok) return;
    role = r.json.role;
    const teacher = role === 'teacher';
    $('join-card').hidden = teacher;
    $('new-card').hidden = !teacher;
    $('list-title').textContent = teacher ? 'My classes' : 'Classes I joined';
    $('list-empty').hidden = r.json.classes.length > 0;
    $('list-empty').textContent = teacher ? 'You have no classes yet. Create one above.' : 'You have not joined a class yet. Enter a class code above.';
    const ul = $('classes');
    ul.replaceChildren();
    for (const c of r.json.classes) {
      const meta = teacher ? `${c.studentCount} student${c.studentCount === 1 ? '' : 's'} · code ${c.code}` : `Teacher: ${c.teacher}`;
      ul.append(el('li', null,
        el('a', { className: 'title', href: `#class=${c.id}`, textContent: c.name }),
        el('span', { className: 'meta', textContent: meta })));
    }
  }

  $('new-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    msg('new-msg', '');
    const r = await call('POST', '/classes', { name: $('new-name').value });
    if (!r.ok) return msg('new-msg', errText(r, 'Could not create the class.'), 'err');
    $('new-name').value = '';
    window.location.hash = `#class=${r.json.class.id}`;
  });

  $('join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    msg('join-msg', '');
    const r = await call('POST', '/classes/join', { code: $('join-code').value });
    if (!r.ok) return msg('join-msg', errText(r, 'Could not join.'), 'err');
    $('join-code').value = '';
    msg('join-msg', `Joined ${r.json.class.name}.`, 'ok');
    showList();
  });

  // ---- One class ----
  let current = null; // class id

  async function showClass(id) {
    current = id;
    $('list').hidden = true;
    $('detail').hidden = false;
    msg('d-msg', '');
    const r = await call('GET', `/classes/${id}`);
    if (!r.ok) { window.location.hash = ''; return; }
    const c = r.json.class;
    const teacher = c.isTeacher;
    $('d-name').textContent = c.name;
    $('d-sub').textContent = teacher ? 'You teach this class.' : `Teacher: ${c.teacher}`;
    $('d-leave').hidden = teacher;
    $('d-delete').hidden = !teacher;
    $('d-code-row').hidden = !teacher;
    if (teacher) $('d-code').textContent = c.code;
    $('roster-card').hidden = !teacher;
    $('a-form').hidden = !teacher;
    $('a-hint').hidden = !teacher;
    renderAssignments(c);
    if (teacher) { renderRoster(c); loadFolders(); }
  }

  function renderAssignments(c) {
    const ul = $('a-list');
    ul.replaceChildren();
    $('a-empty').hidden = c.assignments.length > 0;
    $('a-empty').textContent = c.isTeacher ? 'Nothing here yet.' : 'Your teacher has not shared anything yet.';
    for (const a of c.assignments) {
      const shared = a.kind === 'shared';
      const meta = `${shared ? 'Shared program' : `${a.fileCount} file${a.fileCount === 1 ? '' : 's'}`} · ${fmtDate(a.createdAt)}`;
      const li = el('li', null, el('span', { className: 'title', textContent: a.title }), el('span', { className: 'meta', textContent: meta }));
      if (c.isTeacher) {
        li.append(button('Delete', 'danger small', async () => {
          if (!window.confirm(`Delete "${a.title}"? Students who already started it keep their copy.`)) return;
          const r = await call('DELETE', `/classes/${c.id}/assignments/${a.id}`);
          if (r.ok) showClass(c.id); else msg('d-msg', errText(r, 'Could not delete.'), 'err');
        }));
      } else {
        li.append(button(shared ? 'Get code' : 'Get starter code', 'primary small', () => startAssignment(c.id, a, false)));
      }
      ul.append(li);
    }
  }

  async function startAssignment(classId, a, overwrite) {
    msg('d-msg', '');
    const r = await call('POST', `/classes/${classId}/assignments/${a.id}/start`, overwrite ? { overwrite: true } : {});
    if (r.status === 409) {
      if (window.confirm(`${r.json.error}\n\nReplace it with a fresh copy?`)) startAssignment(classId, a, true);
      return;
    }
    if (!r.ok) return msg('d-msg', errText(r, 'Could not copy the starter code.'), 'err');
    $('d-msg').textContent = '';
    $('d-msg').append(`Copied into your files, in the folder "${r.json.folder}". `, el('a', { href: '/', textContent: 'Open the editor' }), '.');
    $('d-msg').className = 'msg ok';
    $('d-msg').hidden = false;
  }

  function renderRoster(c) {
    $('r-count').textContent = `(${c.students.length})`;
    $('r-empty').hidden = c.students.length > 0;
    $('r-table').hidden = c.students.length === 0;
    const body = $('r-body');
    body.replaceChildren();
    for (const s of c.students) {
      const actions = el('div', { className: 'actions-cell' },
        s.savedAt
          ? el('a', { className: 'btn small', href: `/?view=${c.id}:${s.id}`, textContent: 'View / run code' })
          : el('span', { className: 'meta', textContent: 'No files yet' }),
        button('Reset password', 'small', async () => {
          const pw = window.prompt(`New password for ${who(s)} (at least 8 characters). Tell them the new password; they will be signed out everywhere.`);
          if (pw === null) return;
          const r = await call('POST', `/classes/${c.id}/students/${s.id}/password`, { newPassword: pw });
          msg('d-msg', r.ok ? `Password changed for ${who(s)}.` : errText(r, 'Could not change the password.'), r.ok ? 'ok' : 'err');
        }),
        button('Remove', 'danger small', async () => {
          if (!window.confirm(`Remove ${who(s)} from ${c.name}? Their files are not deleted.`)) return;
          const r = await call('DELETE', `/classes/${c.id}/students/${s.id}`);
          if (r.ok) showClass(c.id); else msg('d-msg', errText(r, 'Could not remove.'), 'err');
        }));
      const tr = el('tr', null,
        el('td', { className: 'user', textContent: who(s) }),
        el('td', { textContent: fmtDate(s.joinedAt) }),
        el('td', { textContent: fmtDateTime(s.savedAt) }),
        el('td', { textContent: String(s.fileCount || 0) }));
      tr.append(el('td', null, actions));
      body.append(tr);
    }
  }

  /** Folders of the teacher's own saved files, for the "Starter files" choice. */
  async function loadFolders() {
    const sel = $('a-folder');
    sel.replaceChildren(el('option', { value: '', textContent: 'All my saved files' }));
    const r = await call('GET', '/workspace');
    const files = r.ok && r.json.workspace ? Object.keys(r.json.workspace.files) : [];
    const folders = [...new Set(files.filter((p) => p.includes('/')).map((p) => p.split('/')[0]))].sort();
    for (const f of folders) sel.append(el('option', { value: f, textContent: `Folder: ${f}/` }));
    if (folders.length) sel.value = folders[0];
  }

  $('a-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    msg('d-msg', '');
    const r = await call('POST', `/classes/${current}/assignments`, { title: $('a-title').value, folder: $('a-folder').value });
    if (!r.ok) return msg('d-msg', errText(r, 'Could not add the assignment.'), 'err');
    $('a-title').value = '';
    showClass(current);
  });

  $('d-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('d-code').textContent); msg('d-msg', 'Code copied.', 'ok'); } catch { msg('d-msg', 'Select the code and copy it.', 'err'); }
  });
  $('d-delete').addEventListener('click', async () => {
    if (!window.confirm('Delete this class, its assignments and its roster? Students keep their own files. This cannot be undone.')) return;
    const r = await call('DELETE', `/classes/${current}`);
    if (r.ok) window.location.hash = ''; else msg('d-msg', errText(r, 'Could not delete.'), 'err');
  });
  $('d-leave').addEventListener('click', async () => {
    if (!window.confirm('Leave this class? Your own files stay as they are.')) return;
    const r = await call('DELETE', `/classes/${current}/membership`);
    if (r.ok) window.location.hash = ''; else msg('d-msg', errText(r, 'Could not leave.'), 'err');
  });

  // ---- Routing by hash: "" is the list, "#class=ID" is one class ----
  function route() {
    const m = /^#class=(\d+)$/.exec(window.location.hash);
    if (m) showClass(m[1]); else showList();
  }
  window.addEventListener('hashchange', route);

  (async function init() {
    let me;
    try { me = await call('GET', '/me'); } catch { me = null; }
    $('loading').hidden = true;
    if (!me || !me.ok || !me.json.user) { $('signed-out').hidden = false; return; }
    route();
  })();
})();

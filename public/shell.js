'use strict';

// The app shell for the Admin, Classes and Profile pages: a sidebar that fits who is logged in, a top bar with
// breadcrumb, search and the account menu (with the theme switch). A page puts its content in <main id="page">
// and sets <body data-nav="profile|classes|admin">; this script builds the shell around it.
(function () {
  const ICONS = {
    home: '<path d="M2.5 7 8 2.5 13.5 7v6a.5.5 0 0 1-.5.5h-3v-3.5h-4v3.5H3a.5.5 0 0 1-.5-.5V7z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
    users: '<g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="6" cy="5.5" r="2.3"/><path d="M1.8 13c0-2.3 2-3.8 4.2-3.8s4.2 1.5 4.2 3.8"/><circle cx="11.2" cy="6" r="1.8"/><path d="M11.5 9.4c1.6.2 2.9 1.4 2.9 3.4"/></g>',
    book: '<path d="M2.5 3.2c1.8-.5 3.6-.2 5.5 1v8.6c-1.9-1.2-3.7-1.5-5.5-1V3.2zM13.5 3.2c-1.8-.5-3.6-.2-5.5 1v8.6c1.9-1.2 3.7-1.5 5.5-1V3.2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
    github: '<path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>',
    code: '<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    user: '<g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="8" cy="5.5" r="2.7"/><path d="M2.8 13.8c.5-2.6 2.6-4 5.2-4s4.7 1.4 5.2 4"/></g>',
    search: '<g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3"/></g>',
    sun: '<g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="8" cy="8" r="2.6"/><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1"/></g>',
    moon: '<path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
    panel: '<g fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="3" width="12" height="10" rx="2"/><path d="M6 3v10"/></g>',
    menu: '<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
    list: '<path d="M3 4.5h.5M6 4.5h7M3 8h.5M6 8h7M3 11.5h.5M6 11.5h7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
    pulse: '<path d="M1.5 8h3l1.5-4 3 8 1.5-4h4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    logout: '<path d="M6 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H6M10 5l3 3-3 3M13 8H6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  };
  const NS = 'http://www.w3.org/2000/svg';

  // [key, label, icon, address, id of the count badge]
  const ADMIN_NAV = [
    ['overview', 'Overview', 'home', '/admin#overview'],
    ['users', 'Users', 'users', '/admin#users', 'n-users'],
    ['admin-classes', 'All classes', 'book', '/admin#classes', 'n-classes'],
    ['github', 'GitHub settings', 'github', '/admin#github'],
  ];
  const USER_NAV = [
    ['editor', 'Editor', 'code', '/'],
    ['classes', 'Classes', 'list', '/classes'],
    ['profile', 'Profile', 'user', '/profile'],
  ];
  const PAGE_TITLES = { classes: 'Classes', profile: 'Profile' };
  const ROLE_NAMES = { student: 'Student', teacher: 'Teacher', superadmin: 'Super admin' };

  function svg(name, cls) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('class', cls || 'i');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = ICONS[name]; // fixed markup from this file, never user text
    return s;
  }

  function make(tag, props, ...kids) {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    for (const k of kids) if (k != null) n.append(k);
    return n;
  }

  const page = document.getElementById('page');
  const current = document.body.dataset.nav || '';
  let user = null;
  const refs = {};

  // ---- Build the frame ----
  function navItem([key, label, icon, href, countId]) {
    const a = make('a', { className: 'nav-item', href });
    a.dataset.key = key;
    a.append(svg(icon), label);
    if (countId) a.append(make('span', { className: 'count', id: countId }));
    return a;
  }

  refs.nav = make('nav', { className: 'nav' });
  refs.nav.setAttribute('aria-label', 'Main');
  refs.side = make('aside', { className: 'side' },
    make('div', { className: 'side-top' },
      (() => { const a = make('a', { className: 'brand', href: '/' }); a.append(make('span', { className: 'logo', textContent: 'cc' }), 'cc-studio'); return a; })(),
      (() => { const b = make('button', { type: 'button', className: 'icon-btn only-mobile', ariaLabel: 'Close menu' }); b.setAttribute('aria-label', 'Close menu'); b.append(svg('panel')); b.addEventListener('click', closeSide); return b; })()),
    refs.nav,
    (refs.foot = make('div', { className: 'side-foot' })));
  refs.scrim = make('div', { className: 'scrim', hidden: true });
  refs.scrim.addEventListener('click', closeSide);

  refs.crumbs = make('nav', { className: 'crumbs' });
  refs.crumbs.setAttribute('aria-label', 'Breadcrumb');
  refs.searchInput = make('input', { type: 'search', placeholder: 'Search users…', autocomplete: 'off', spellcheck: false });
  refs.searchInput.setAttribute('aria-label', 'Search users');
  refs.search = make('label', { className: 'search', hidden: true }, svg('search'), refs.searchInput, make('kbd', { textContent: '/' }));
  refs.avatarBtn = make('button', { type: 'button', className: 'avatar' });
  refs.avatarBtn.setAttribute('aria-haspopup', 'true');
  refs.avatarBtn.setAttribute('aria-expanded', 'false');
  refs.avatarBtn.setAttribute('aria-label', 'Account menu');
  refs.menu = make('div', { className: 'menu', hidden: true });
  refs.menuWrap = make('div', { className: 'menu-wrap' }, refs.avatarBtn, refs.menu);

  const menuBtn = make('button', { type: 'button', className: 'icon-btn only-mobile' });
  menuBtn.setAttribute('aria-label', 'Open menu');
  menuBtn.append(svg('menu'));
  menuBtn.addEventListener('click', openSide);

  refs.content = make('main', { className: 'content' });
  const frame = make('div', { className: 'shell' },
    refs.side, refs.scrim,
    make('div', { className: 'main' },
      make('header', { className: 'topbar' }, menuBtn, refs.crumbs, make('div', { className: 'grow' }), refs.search, refs.menuWrap),
      refs.content));
  if (page) refs.content.append(page);
  document.body.prepend(frame);

  function openSide() { refs.side.classList.add('open'); refs.scrim.hidden = false; }
  function closeSide() { refs.side.classList.remove('open'); refs.scrim.hidden = true; }

  function toggleMenu(open) {
    refs.menu.hidden = open === undefined ? !refs.menu.hidden : !open;
    refs.avatarBtn.setAttribute('aria-expanded', String(!refs.menu.hidden));
  }
  refs.avatarBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  refs.menu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => toggleMenu(false));

  // ---- What the shell shows for this person ----
  const initials = (u) => (u.username || u.email || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
  const label = (u) => u.username || u.email;

  function setActive(key) {
    for (const a of refs.nav.querySelectorAll('.nav-item')) a.classList.toggle('on', a.dataset.key === key);
    closeSide();
  }

  /** The breadcrumb after "cc-studio": a string or a list of strings. The last one is the current page. */
  function setCrumb(parts) {
    const list = Array.isArray(parts) ? parts : [parts];
    const home = make('a', { href: '/', textContent: 'cc-studio' });
    refs.crumbs.replaceChildren(home);
    list.forEach((p, i) => {
      refs.crumbs.append(make('span', { className: 'sep', textContent: '/' }));
      refs.crumbs.append(i === list.length - 1 ? make('span', { className: 'here', textContent: p }) : make('a', { href: p === 'Admin' ? '/admin#overview' : '#', textContent: p }));
    });
  }

  function groupLabel(text) { return make('div', { className: 'nav-label', textContent: text }); }

  function renderNav() {
    refs.nav.replaceChildren();
    if (user && user.role === 'superadmin') {
      refs.nav.append(groupLabel('Admin'), ...ADMIN_NAV.map(navItem));
      refs.nav.append(groupLabel('Workspace'));
    }
    refs.nav.append(...USER_NAV.map(navItem));
    if (user && user.role === 'teacher') {
      // nothing extra yet: teachers create classes on the Classes page
    }
    setActive(current && current !== 'admin' ? current : '');
  }

  function renderMenu() {
    refs.menu.replaceChildren();
    const item = (href, icon, text) => { const a = make('a', { className: 'menu-item', href }); a.append(svg(icon), text); return a; };
    if (user) {
      refs.menu.append(
        make('div', { className: 'menu-head' },
          make('span', { className: 'avatar big', textContent: initials(user) }),
          make('span', { className: 'who' }, make('span', { className: 'name', textContent: label(user) }), make('span', { className: 'sub', textContent: user.email || ROLE_NAMES[user.role] || '' }))),
        item('/profile', 'user', 'View profile'),
        item('/', 'code', 'Open editor'));
    } else {
      refs.menu.append(item('/', 'user', 'Log in from the editor'));
    }
    const light = make('button', { type: 'button' });
    light.append(svg('sun'), 'Light');
    const dark = make('button', { type: 'button' });
    dark.append(svg('moon'), 'Dark');
    const showTheme = () => {
      const mode = window.CCTheme ? window.CCTheme.current() : 'dark';
      light.classList.toggle('on', mode === 'light');
      dark.classList.toggle('on', mode === 'dark');
    };
    light.addEventListener('click', () => { window.CCTheme.set('light'); showTheme(); });
    dark.addEventListener('click', () => { window.CCTheme.set('dark'); showTheme(); });
    showTheme();
    const seg = make('div', { className: 'seg' }, light, dark);
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Theme');
    refs.menu.append(make('div', { className: 'menu-label', textContent: 'Theme' }), seg);
    if (user) {
      const out = make('button', { type: 'button', className: 'menu-item' });
      out.append(svg('logout'), 'Sign out');
      out.addEventListener('click', async () => {
        try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { /* the cookie expires on its own */ }
        window.location.href = '/';
      });
      refs.menu.append(out);
    }
  }

  function renderUser() {
    refs.avatarBtn.textContent = user ? initials(user) : '?';
    refs.foot.replaceChildren();
    if (user) {
      refs.foot.append(make('span', { className: 'avatar sm', textContent: initials(user) }),
        make('span', { className: 'who' }, make('span', { className: 'name', textContent: label(user) }), make('span', { className: 'sub', textContent: ROLE_NAMES[user.role] || '' })));
    } else {
      refs.foot.append(make('span', { className: 'who' }, make('span', { className: 'sub', textContent: 'Not logged in' })), make('a', { href: '/', textContent: 'Log in' }));
    }
    refs.search.hidden = !(user && user.role === 'superadmin');
    renderNav();
    renderMenu();
  }

  // ---- Search (super admins): find a user ----
  refs.searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const q = refs.searchInput.value.trim();
    if (current === 'admin') window.dispatchEvent(new CustomEvent('shell:search', { detail: q }));
    else window.location.href = `/admin?q=${encodeURIComponent(q)}#users`;
  });
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !refs.search.hidden) { e.preventDefault(); refs.searchInput.focus(); }
    if (e.key === 'Escape') { toggleMenu(false); closeSide(); }
  });

  // ---- Start: who is this? ----
  setCrumb(PAGE_TITLES[current] ? [PAGE_TITLES[current]] : ['Admin']);
  renderUser(); // the frame is there at once; names and the admin links fill in when we know the role
  const ready = (async () => {
    try {
      const res = await fetch('/api/me', { credentials: 'same-origin' });
      const body = res.ok ? await res.json() : null;
      user = body && body.user ? body.user : null;
    } catch { user = null; }
    renderUser();
    return user;
  })();

  window.CCShell = { ready, setActive, setCrumb, user: () => user };
})();

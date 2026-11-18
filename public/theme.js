'use strict';

// The profile, classes and admin pages follow the editor's saved theme and accent (same localStorage key as app.js).
(function () {
  const KEY = 'cc-studio:v1';
  const ACCENTS = { teal: ['#7fc4b0', '#1f7a68'], blue: ['#7fb0e8', '#2a62b8'], amber: ['#e0b060', '#a86a10'], violet: ['#b79be0', '#6a45b8'] };
  const PALETTE = {
    dark: { bg: '#111314', bg2: '#141617', bd: '#26292a', bd2: '#2f3334', fg: '#d6d9d8', mu: '#9aa19f', mu2: '#7d8584', hov: '#1c1f20', inp: '#0d0f10', err: '#e07a72', ok: '#6fcf97', warn: '#e0a860', onac: '#0d1211' },
    light: { bg: '#ffffff', bg2: '#f7f7f6', bd: '#e6e8e8', bd2: '#d6dada', fg: '#1b1f1f', mu: '#4f5856', mu2: '#6b7573', hov: '#eef0f0', inp: '#ffffff', err: '#c0392b', ok: '#1e8e5a', warn: '#a86a10', onac: '#ffffff' },
  };

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
  }

  function apply() {
    const s = read();
    const mode = s.mode === 'light' ? 'light' : 'dark';
    const ac = (ACCENTS[s.acc] || ACCENTS.teal)[mode === 'dark' ? 0 : 1];
    const root = document.documentElement;
    for (const [k, v] of Object.entries({ ...PALETTE[mode], ac, ac2: ac, acbg: ac + (mode === 'dark' ? '33' : '22') })) root.style.setProperty(`--${k}`, v);
    root.style.colorScheme = mode;
    return mode;
  }

  /** Switch between 'light' and 'dark' for every page, the editor included (they share this setting). */
  function set(mode) {
    const s = read();
    s.mode = mode === 'light' ? 'light' : 'dark';
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage blocked: the change lasts for this page only */ }
    return apply();
  }

  try { apply(); } catch { /* keep the dark default */ }
  window.CCTheme = { apply, set, current: () => (read().mode === 'light' ? 'light' : 'dark') };
})();

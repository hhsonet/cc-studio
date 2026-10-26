'use strict';

// cc-studio front end. No framework, no build step.
//   - project files live in `state.files` (path -> text) and are saved to localStorage
//   - the editor is Monaco (one model per file) with a plain <textarea> fallback
//   - Run sends every file to /ws/run; compile output, program output and your input all
//     stream through the Console panel, compiler warnings/errors also feed Diagnostics

// Who built this. Shown in the bottom bar and by the `about` command in the stdin box.
const AUTHOR = { name: 'hhsonet', fullName: 'Hasan Sonet', github: 'https://github.com/hhsonet/' };
// Typing any of these in the stdin box (when no program is running) shows the author card.
const ABOUT_RE = /^(about|sonet|hhs|hhsonet|hasan\s+sonet)$/i;

const STORAGE_KEY = 'cc-studio:v1';
const MONACO_BASE = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min';
const ALLOWED_EXT = /\.(c|cpp|cc|cxx|h|hpp|hh|hxx|txt)$/i;
const MAX_FILE_BYTES = 64 * 1024;

// The default project: one plain Hello World.
const DEFAULT_FILES = {
  'src/main.c': `#include <stdio.h>

int main(void) {
    printf("Hello, World!\\n");
    return 0;
}
`,
};

// Earlier versions started with a Hello World that printed a random joke.
const JOKE_MAIN_C = `#include <stdio.h>
#include <stdlib.h>
#include <time.h>

int main(void) {
    const char *jokes[] = {
        "There are 10 kinds of people: those who know binary and those who don't.",
        "Why do programmers prefer dark mode? Because light attracts bugs.",
        "It works on my machine.",
        "I'd tell you a UDP joke, but you might not get it.",
        "!false: it's funny because it's true.",
    };
    int count = sizeof jokes / sizeof jokes[0];

    srand((unsigned)time(NULL));
    printf("Hello, World!\\n");
    printf("%s\\n", jokes[rand() % count]);
    return 0;
}
`;

// The project used to start with four sample files. If the saved project is exactly that
// untouched sample, treat it as "never customised" and start from the current default instead.
const LEGACY_MAIN_C = `#include <stdio.h>
#include "util.h"

int main(void) {
    int n;
    printf("Hello, World!\\n");
    printf("Enter a number: ");
    scanf("%d", &n);
    printf("fib(%d) = %d\\n", n, fib(n));
    return 0;
}
`;
function isUntouchedLegacyDefault(files) {
  const keys = Object.keys(files).sort().join();
  if (keys === 'src/main.c') return files['src/main.c'] === JOKE_MAIN_C;
  return keys === 'src/main.c,src/main.cpp,src/util.c,src/util.h' && files['src/main.c'] === LEGACY_MAIN_C;
}

// ---- Theme (palette from the design) ----

const ACCENTS = {
  teal: ['#7fc4b0', '#1f7a68'],
  blue: ['#7fb0e8', '#2a62b8'],
  amber: ['#e0b060', '#a86a10'],
  violet: ['#b79be0', '#6a45b8'],
};
const PALETTE = {
  dark: { bg: '#111314', bg2: '#141617', bd: '#26292a', bd2: '#2f3334', fg: '#d6d9d8', mu: '#9aa19f', mu2: '#7d8584', mu3: '#4f5655', hov: '#1c1f20', inp: '#0d0f10', warn: '#e0a860', err: '#e07a72', blue: '#82b7e0', kw: '#c99bd9', str: '#d9b878', num: '#e0a070', onac: '#0d1211' },
  light: { bg: '#f6f7f7', bg2: '#eceeee', bd: '#dcdfdf', bd2: '#cfd3d3', fg: '#1b1f1f', mu: '#4f5856', mu2: '#626b69', mu3: '#98a09e', hov: '#e3e6e6', inp: '#ffffff', warn: '#8f5a0c', err: '#c0392b', blue: '#2a62b8', kw: '#8a3fa8', str: '#7a5c14', num: '#a24f12', onac: '#ffffff' },
};

// ---- State (localStorage may be unavailable, so every access is guarded) ----

// Console text colors: a preset name, or a custom #rrggbb. Presets have a variant per theme.
const CONSOLE_COLORS = {
  green: ['#7ee787', '#1a7f37'],
  amber: ['#e3b341', '#9a6700'],
  cyan: ['#79c0ff', '#0969da'],
  pink: ['#ff9bce', '#bf3989'],
};

const INDENT_SIZES = [2, 4, 8];
const FORMAT_STYLES = window.CCFormat.STYLES; // from format-config.js

/** Editor indentation settings: auto indent on/off and the indent width (spaces). */
function cleanIndentSettings(raw) {
  const out = { auto: true, size: 4 };
  if (raw && typeof raw === 'object') {
    if (raw.auto === false) out.auto = false;
    if (INDENT_SIZES.includes(raw.size)) out.size = raw.size;
  }
  return out;
}

function cleanConsoleSettings(raw) {
  const out = { fs: 13, color: '' };
  if (raw && typeof raw === 'object') {
    out.fs = Math.min(22, Math.max(10, Math.round(Number(raw.fs)) || 13));
    if (CONSOLE_COLORS[raw.color] || /^#[0-9a-f]{6}$/i.test(raw.color)) out.color = raw.color;
  }
  return out;
}

// ---- Saved state ----

const MAX_STORED_PROJECTS = 20;
const cleanFiles = (raw) => Object.fromEntries(
  Object.entries(raw && typeof raw === 'object' ? raw : {}).filter(([p, c]) => typeof c === 'string' && ALLOWED_EXT.test(p))
);
const firstFile = (files) => Object.keys(files).sort()[0];

/**
 * An earlier version had a project switcher. Its data is folded into the one file tree: the project you
 * were in stays at the top level, every other project that has real content becomes a folder named
 * after it (where it builds on its own, since only the open file's folder is built), and untouched
 * sample projects are dropped.
 */
function mergeSavedProjects(raw, currentId) {
  const projects = raw.slice(0, MAX_STORED_PROJECTS).map((p) => {
    if (!p || typeof p !== 'object') return null;
    const files = cleanFiles(p.files);
    if (!Object.keys(files).length) return null;
    return {
      id: p.id,
      name: typeof p.name === 'string' ? p.name : '',
      files,
      open: files[p.open] !== undefined ? p.open : firstFile(files),
      collapsed: p.collapsed && typeof p.collapsed === 'object' ? p.collapsed : {},
    };
  }).filter(Boolean);
  if (!projects.length) return null;

  const main = projects.find((p) => p.id === currentId) || projects[0];
  const files = { ...main.files };
  const taken = new Set(Object.keys(files).map((p) => p.split('/')[0]));
  const untouched = (p) => Object.keys(p.files).join() === 'src/main.c' && p.files['src/main.c'] === DEFAULT_FILES['src/main.c'];
  for (const p of projects) {
    if (p === main || untouched(p)) continue;
    let folder = (p.name.trim().replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^\.+/, '').replace(/^_+|_+$/g, '') || 'project').slice(0, 30);
    for (let n = 2; taken.has(folder); n++) folder = `${folder.replace(/-\d+$/, '')}-${n}`;
    taken.add(folder);
    for (const [path, content] of Object.entries(p.files)) files[`${folder}/${path}`] = content;
  }
  return { files, open: main.open, collapsed: main.collapsed };
}

function loadState() {
  const settings = {
    mode: 'dark', acc: 'teal', fs: 13, sideOpen: window.innerWidth > 760, panelOpen: true, friendly: true,
    console: { fs: 13, color: '' }, indent: { auto: true, size: 4 }, formatStyle: 'LLVM',
  };
  let saved = null; // { files, open, collapsed }
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (s && typeof s === 'object') {
      Object.assign(settings, {
        mode: s.mode === 'light' ? 'light' : 'dark',
        acc: ACCENTS[s.acc] ? s.acc : 'teal',
        fs: Math.min(24, Math.max(10, Number(s.fs) || 13)),
        sideOpen: typeof s.sideOpen === 'boolean' ? s.sideOpen : settings.sideOpen,
        panelOpen: typeof s.panelOpen === 'boolean' ? s.panelOpen : true,
        friendly: typeof s.friendly === 'boolean' ? s.friendly : true,
        console: cleanConsoleSettings(s.console),
        indent: cleanIndentSettings(s.indent),
        formatStyle: FORMAT_STYLES.includes(s.formatStyle) ? s.formatStyle : 'LLVM',
      });
      if (Array.isArray(s.projects)) {
        saved = mergeSavedProjects(s.projects, s.current);
      } else if (s.files && typeof s.files === 'object') {
        const files = cleanFiles(s.files);
        if (Object.keys(files).length && !isUntouchedLegacyDefault(files)) saved = { files, open: s.open, collapsed: s.collapsed };
      }
    }
  } catch { /* corrupt or blocked storage: start fresh */ }

  const files = saved && Object.keys(saved.files).length ? saved.files : { ...DEFAULT_FILES };
  return {
    files,
    open: saved && files[saved.open] !== undefined ? saved.open : firstFile(files),
    collapsed: saved && saved.collapsed && typeof saved.collapsed === 'object' ? saved.collapsed : {},
    ...settings,
  };
}

let saveTimer = null;
function flushSave() {
  clearTimeout(saveTimer);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* storage full or blocked */ }
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 200); // batch rapid edits (typing)
}
// A change made just before the tab is closed or reloaded must not be lost to the delay above.
window.addEventListener('pagehide', flushSave);
window.addEventListener('beforeunload', flushSave);

const state = loadState();
const $ = (id) => document.getElementById(id);

// ---- Small helpers ----

const langOf = (p) => (/\.(cpp|cc|cxx|hpp|hh|hxx)$/i.test(p) ? 'C++' : /\.(c|h)$/i.test(p) ? 'C' : 'Text');
const runLanguage = (p) => ({ 'C++': 'cpp', C: 'c' }[langOf(p)] || null);
const monacoLang = (p) => ({ 'C++': 'cpp', C: 'c' }[langOf(p)] || 'plaintext');
const baseName = (p) => p.split('/').pop();

/** Same rules as the server (lib/validate.js): relative path of safe characters, known extension. */
function validName(p) {
  return /^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9_.\-/]{1,100}$/.test(p) && ALLOWED_EXT.test(p);
}

// ---- Theme application ----

let themeSeq = 0;
function applyTheme() {
  const dk = state.mode === 'dark';
  const P = PALETTE[state.mode];
  const ac = ACCENTS[state.acc][dk ? 0 : 1];
  const vars = {
    ...P,
    ac,
    ac2: dk && state.acc === 'teal' ? '#a6dccd' : dk ? ac : ac,
    acbg: ac + (dk ? '33' : '22'),
    sel: ac + (dk ? '26' : '1a'),
  };
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(`--${k}`, v);
  root.style.colorScheme = state.mode;
  applyConsoleStyle();
  if (editor && editor.setTheme) editor.setTheme(P, ac);
}

/** Console font size and text color (the Aa popover). The color applies to program output and your input. */
function applyConsoleStyle() {
  const root = document.documentElement;
  const { fs, color } = state.console;
  root.style.setProperty('--console-fs', `${fs}px`);
  root.style.setProperty('--console-lh', `${Math.round(fs * 1.6)}px`);
  const resolved = CONSOLE_COLORS[color] ? CONSOLE_COLORS[color][state.mode === 'dark' ? 0 : 1] : color;
  if (resolved) root.style.setProperty('--console-out', resolved);
  else root.style.removeProperty('--console-out'); // default: the theme's text color
}

// ---- Formatting: clang-format compiled to WebAssembly, loaded on first use ----

let formatterPromise = null;
let formatterFailures = 0;
function loadFormatter() {
  if (!formatterPromise) {
    // Browsers remember a failed import() for a URL and never re-fetch it, so a retry after a failure
    // (a network blip) uses a fresh URL; otherwise Format would stay broken until the page is reloaded.
    const retry = formatterFailures ? `?retry=${formatterFailures}` : '';
    formatterPromise = import(`./vendor/clang-format/clang-format-web.js${retry}`)
      .then(async (mod) => { await mod.default(); return mod; })
      .catch((err) => { formatterPromise = null; formatterFailures++; throw err; });
  }
  return formatterPromise;
}

async function formatSource(code, filename) {
  const mod = await loadFormatter();
  return mod.format(code, filename, window.CCFormat.formatConfig(state.formatStyle, state.indent.size)).replace(/\r\n/g, '\n');
}

/** Common prefix/suffix lengths of two strings, so only the part that changed is replaced. */
function commonAffix(a, b) {
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a[p] === b[p]) p++;
  let q = 0;
  while (q < max - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  return { p, q };
}

// ---- Editor: Monaco, with a textarea fallback if the CDN is unreachable ----

let editor = null; // { show, getValue, reveal, decorate, setFont, setTheme, remove, focus }
const editorReady = (async () => {
  try {
    editor = await initMonaco();
  } catch (err) {
    console.warn('Monaco failed to load, using a plain textarea:', err);
    editor = initFallback();
  }
  applyTheme();
  editor.setFont(state.fs);
  editor.show(state.open);
  applyDiagnostics();
})();

async function initMonaco() {
  if (typeof window.require !== 'function') throw new Error('Monaco loader missing');

  // Monaco runs its workers from a blob that imports the real worker from the CDN
  // (a cross-origin Worker URL isn't allowed directly).
  window.MonacoEnvironment = {
    getWorkerUrl() {
      const code = `self.MonacoEnvironment={baseUrl:'${MONACO_BASE}/'};importScripts('${MONACO_BASE}/vs/base/worker/workerMain.js');`;
      return URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    },
  };
  // Monaco measures glyph widths when it starts, so the editor font must be loaded first.
  const fontReady = document.fonts && document.fonts.load ? document.fonts.load("13px 'JetBrains Mono'") : Promise.resolve();
  window.require.config({ paths: { vs: `${MONACO_BASE}/vs` } });
  const m = await new Promise((resolve, reject) => window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject));
  await Promise.race([fontReady, new Promise((r) => setTimeout(r, 1500))]);

  const instance = m.editor.create($('editor'), {
    model: null,
    automaticLayout: true,
    minimap: { enabled: false },
    fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace",
    fontSize: state.fs,
    lineHeight: Math.round(state.fs * 1.7),
    scrollBeyondLastLine: false,
    padding: { top: 4 },
    // Indentation comes from the Settings popover, never guessed from the file's contents.
    tabSize: state.indent.size,
    insertSpaces: true,
    detectIndentation: false,
    autoIndent: state.indent.auto ? 'full' : 'none',
    renderLineHighlight: 'line',
    stickyScroll: { enabled: false },
  });
  // Ctrl/Cmd+Enter inside the editor (Monaco swallows the key otherwise).
  instance.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.Enter, () => runClicked());
  // Shift+Alt+F everywhere. (Monaco's own Format Document key is Ctrl+Shift+I on Linux, so bind ours too.)
  instance.addCommand(m.KeyMod.Shift | m.KeyMod.Alt | m.KeyCode.KeyF, () => formatCurrent());
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => m.editor.remeasureFonts());

  // Format Document (Shift+Alt+F, right-click menu) uses the same formatter. Only the lines that change are
  // replaced, so the cursor and scroll position stay put when the code is mostly formatted already.
  async function formatEdits(model) {
    const before = model.getValue();
    const after = await formatSource(before, model.uri.path.split('/').pop());
    const { p, q } = commonAffix(before, after);
    if (before === after) return [];
    return [{
      range: m.Range.fromPositions(model.getPositionAt(p), model.getPositionAt(before.length - q)),
      text: after.slice(p, after.length - q),
    }];
  }
  const provider = { provideDocumentFormattingEdits: (model) => formatEdits(model) };
  m.languages.registerDocumentFormattingEditProvider('c', provider);
  m.languages.registerDocumentFormattingEditProvider('cpp', provider);

  const models = new Map();
  const decorations = instance.createDecorationsCollection();
  // Inline diagnostics describe the code as it was when you compiled. Once you edit, they are stale
  // and the end-of-line message would sit in the way of typing, so drop them until the next compile.
  instance.onDidChangeModelContent(() => decorations.clear());

  function modelFor(path) {
    let md = models.get(path);
    if (!md) {
      md = m.editor.createModel(state.files[path] ?? '', monacoLang(path), m.Uri.parse(`file:///${path}`));
      md.onDidChangeContent(() => { if (state.files[path] !== undefined) { state.files[path] = md.getValue(); save(); } });
      md.updateOptions({ tabSize: state.indent.size, insertSpaces: true });
      models.set(path, md);
    }
    return md;
  }

  return {
    show(path) { instance.setModel(modelFor(path)); },
    /** Format the open file as one undoable step. Resolves true if anything changed. */
    async format() {
      const model = instance.getModel();
      if (!model) return false;
      const edits = await formatEdits(model);
      if (!edits.length) return false;
      instance.pushUndoStop();
      instance.executeEdits('format', edits);
      instance.pushUndoStop();
      return true;
    },
    getValue: () => (instance.getModel() ? instance.getModel().getValue() : ''),
    focus: () => instance.focus(),
    reveal(line, col = 1) {
      instance.revealLineInCenter(line);
      instance.setPosition({ lineNumber: line, column: col });
      instance.focus();
    },
    setFont(fs) { instance.updateOptions({ fontSize: fs, lineHeight: Math.round(fs * 1.7) }); },
    /** Apply state.indent to the editor and to every open model. */
    setIndent() {
      instance.updateOptions({ autoIndent: state.indent.auto ? 'full' : 'none', tabSize: state.indent.size, insertSpaces: true, detectIndentation: false });
      for (const md of models.values()) md.updateOptions({ tabSize: state.indent.size, insertSpaces: true });
      // Monaco only rebuilds its cursor settings when certain options change, and autoIndent is not one of
      // them: without this, switching auto indent off keeps indenting until some other option changes.
      // Flipping a harmless option (and back) forces the rebuild.
      instance.updateOptions({ emptySelectionClipboard: false });
      instance.updateOptions({ emptySelectionClipboard: true });
    },
    setTheme(P, ac) {
      const name = `cc-${++themeSeq}`;
      const hex = (c) => c.replace('#', '');
      m.editor.defineTheme(name, {
        base: state.mode === 'dark' ? 'vs-dark' : 'vs',
        inherit: true,
        rules: [
          { token: '', foreground: hex(P.fg) },
          { token: 'keyword', foreground: hex(P.kw) },
          { token: 'string', foreground: hex(P.str) },
          { token: 'number', foreground: hex(P.num) },
          { token: 'comment', foreground: hex(P.mu2), fontStyle: 'italic' },
          { token: 'type', foreground: hex(P.blue) },
          { token: 'predefined', foreground: hex(P.blue) },
          { token: 'meta', foreground: hex(P.kw) },
        ],
        colors: {
          'editor.background': P.bg,
          'editor.foreground': P.fg,
          'editorLineNumber.foreground': P.mu3,
          'editorLineNumber.activeForeground': ac,
          'editor.lineHighlightBackground': ac + (state.mode === 'dark' ? '1c' : '14'),
          'editor.selectionBackground': ac + '44',
          'editorCursor.foreground': ac,
          'editorWidget.background': P.hov,
          'editorIndentGuide.background1': P.bd,
        },
      });
      m.editor.setTheme(name);
    },
    /** diags: [{ line, col, kind, msg }] for the file that is currently open. */
    decorate(diags) {
      const model = instance.getModel();
      if (!model) return;
      const seen = new Set();
      const items = [];
      for (const d of diags) {
        if (d.line < 1 || d.line > model.getLineCount()) continue;
        const word = model.getWordAtPosition({ lineNumber: d.line, column: d.col });
        const end = word ? word.endColumn : Math.min(d.col + 1, model.getLineMaxColumn(d.line));
        if (d.kind !== 'note') {
          items.push({
            range: new m.Range(d.line, d.col, d.line, end),
            options: { inlineClassName: d.kind === 'error' ? 'cc-err-text' : 'cc-warn-text' },
          });
        }
        if (!seen.has(d.line)) {
          seen.add(d.line);
          const cls = d.kind === 'error' ? 'err' : d.kind === 'warning' ? 'warn' : 'note';
          const max = model.getLineMaxColumn(d.line);
          items.push({
            range: new m.Range(d.line, max, d.line, max),
            // showIfCollapsed: Monaco hides decorations on an empty range unless told otherwise
            options: { showIfCollapsed: true, after: { content: `▲ ${d.msg.slice(0, 90)}`, inlineClassName: `cc-diag-after ${cls}`, cursorStops: m.editor.InjectedTextCursorStops.None } },
          });
        }
      }
      decorations.set(items);
    },
    remove(path) {
      const md = models.get(path);
      if (md) { md.dispose(); models.delete(path); }
    },
  };
}

function initFallback() {
  const ta = document.createElement('textarea');
  ta.className = 'fallback';
  ta.spellcheck = false;
  $('editor').appendChild(ta);
  let current = '';
  ta.addEventListener('input', () => {
    if (current) { state.files[current] = ta.value; save(); }
  });
  ta.addEventListener('keydown', (e) => {
    const unit = ' '.repeat(state.indent.size);
    if (e.key === 'Tab') { // keep Tab inside the editor, inserting spaces
      e.preventDefault();
      ta.setRangeText(unit, ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    } else if (e.key === 'Enter' && state.indent.auto && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      // Auto indent: keep the current line's indentation, one level deeper after "{".
      e.preventDefault();
      const pos = ta.selectionStart;
      const lineStart = ta.value.lastIndexOf('\n', pos - 1) + 1;
      const indent = /^[ \t]*/.exec(ta.value.slice(lineStart, pos))[0];
      ta.setRangeText(`\n${indent}${ta.value[pos - 1] === '{' ? unit : ''}`, ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  });
  return {
    show(path) { current = path; ta.value = state.files[path] ?? ''; },
    getValue: () => ta.value,
    focus: () => ta.focus(),
    reveal(line) {
      const before = ta.value.split('\n').slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0);
      ta.focus();
      ta.setSelectionRange(before, before);
    },
    setFont(fs) { ta.style.fontSize = `${fs}px`; ta.style.lineHeight = `${Math.round(fs * 1.7)}px`; },
    setIndent() { ta.style.tabSize = state.indent.size; },
    async format() {
      const before = ta.value;
      const after = await formatSource(before, current);
      if (after === before) return false;
      const { p, q } = commonAffix(before, after);
      const caret = ta.selectionStart;
      ta.value = after;
      // keep the caret in the same place relative to the text that did not change
      const moved = caret <= p ? caret : caret >= before.length - q ? caret + (after.length - before.length) : p;
      ta.setSelectionRange(moved, moved);
      ta.dispatchEvent(new Event('input'));
      return true;
    },
    setTheme() {},
    decorate() {},
    remove() {},
  };
}

// ---- Diagnostics (parsed from the compiler output) ----

let diags = []; // [{ file, line, col, kind, msg }]
const DIAG_RE = /^([^\s:][^:]*):(\d+):(\d+): (fatal error|error|warning|note): (.*)$/;

function parseDiags(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = DIAG_RE.exec(line);
    if (m) out.push({ file: m[1], line: Number(m[2]), col: Number(m[3]), kind: m[4] === 'fatal error' ? 'error' : m[4], msg: m[5] });
  }
  return out;
}

function applyDiagnostics() {
  $('tab-diag').textContent = `Diagnostics (${diags.length})`;
  if (editor) editor.decorate(diags.filter((d) => d.file === state.open));

  const list = $('diag-list');
  list.replaceChildren();
  if (!diags.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'No problems. Compile to check your code.';
    list.appendChild(e);
    return;
  }
  for (const d of diags) {
    const row = document.createElement('div');
    row.className = 'drow';
    const kind = document.createElement('span');
    kind.className = `kind k-${d.kind}`;
    kind.textContent = d.kind;
    const msg = document.createElement('span');
    msg.className = 'msg';
    msg.textContent = d.msg;
    const tipText = state.friendly && window.CCFriendly ? window.CCFriendly.explainDiag(d) : null;
    if (tipText) {
      const tip = document.createElement('span');
      tip.className = 'tip';
      tip.textContent = `↳ ${tipText}`;
      msg.appendChild(tip);
    }
    const loc = document.createElement('span');
    loc.className = 'loc';
    loc.textContent = `${d.file}:${d.line}:${d.col}`;
    row.append(kind, msg, loc);
    row.addEventListener('click', () => {
      if (state.files[d.file] === undefined) return;
      openFile(d.file);
      editor.reveal(d.line, d.col);
    });
    list.appendChild(row);
  }
}

// ---- Panels ----

let panel = 'console';
/** Select a tab. By default this also opens the panel if it was collapsed. */
function showPanel(name, reveal = true) {
  panel = name;
  if (reveal && !state.panelOpen) setPanelOpen(true);
  for (const t of document.querySelectorAll('.ptab')) {
    const on = t.dataset.tab === name;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', String(on));
  }
  $('pane-diag').hidden = name !== 'diag';
  $('pane-console').hidden = name !== 'console';
  $('clear').hidden = name !== 'console';
  $('console-settings-btn').hidden = name !== 'console';
  if (name !== 'console') toggleConsoleMenu(false);
}
for (const t of document.querySelectorAll('.ptab')) t.addEventListener('click', () => showPanel(t.dataset.tab));

function setPanelOpen(open) {
  state.panelOpen = open;
  // Collapsing never removes the panel: it shrinks to a rail that still holds the toggle and tab names.
  $('panel').classList.toggle('collapsed', !open);
  for (const b of document.querySelectorAll('.js-toggle-panel')) {
    b.setAttribute('aria-expanded', String(open));
    b.title = open ? 'Collapse panel' : 'Expand panel';
    b.setAttribute('aria-label', b.title);
    b.querySelector('.sideicon').classList.toggle('closed', !open);
  }
  save();
}
for (const b of document.querySelectorAll('.js-toggle-panel')) b.addEventListener('click', () => setPanelOpen(!state.panelOpen));

// ---- Console settings (Aa): font size and text color ----

function renderConsoleSettings() {
  const { fs, color } = state.console;
  $('cfs-val').textContent = fs;
  const holder = $('console-colors');
  const dk = state.mode === 'dark';
  const swatch = (key, bg, title) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', `${title} text`);
    b.style.background = bg;
    b.className = color === key ? 'on' : '';
    b.addEventListener('click', () => setConsoleColor(key));
    return b;
  };
  holder.replaceChildren(
    swatch('', 'var(--fg)', 'Default'),
    ...Object.entries(CONSOLE_COLORS).map(([k, v]) => swatch(k, v[dk ? 0 : 1], k[0].toUpperCase() + k.slice(1)))
  );
  const resolved = CONSOLE_COLORS[color] ? CONSOLE_COLORS[color][dk ? 0 : 1] : color;
  $('console-color-custom').value = /^#[0-9a-f]{6}$/i.test(resolved) ? resolved : (dk ? '#d6d9d8' : '#1b1f1f');
}

function setConsoleFont(fs) {
  state.console.fs = Math.min(22, Math.max(10, fs));
  applyConsoleStyle();
  renderConsoleSettings();
  logEl.scrollTop = logEl.scrollHeight;
  save();
}

function setConsoleColor(color) {
  state.console.color = color;
  applyConsoleStyle();
  renderConsoleSettings();
  save();
}

function toggleConsoleMenu(open) {
  const menu = $('console-menu');
  menu.hidden = open === undefined ? !menu.hidden : !open;
  $('console-settings-btn').setAttribute('aria-expanded', String(!menu.hidden));
}

$('cfs-down').addEventListener('click', () => setConsoleFont(state.console.fs - 1));
$('cfs-up').addEventListener('click', () => setConsoleFont(state.console.fs + 1));
$('console-color-custom').addEventListener('input', (e) => setConsoleColor(e.target.value));
$('console-color-reset').addEventListener('click', () => setConsoleColor(''));
$('console-settings-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleConsoleMenu(); });
$('console-menu').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => toggleConsoleMenu(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleConsoleMenu(false); });

// ---- Console log ----
// Rows are written with textContent, so program output can never inject HTML. Output arrives in
// chunks: text without a trailing newline (a prompt like "Enter a number: ") stays in an open row
// that the next chunk continues.

const logEl = $('log');
let openRow = null; // { el, kind } for a line that has not been terminated yet
const MAX_ROWS = 2000;

function newRow(kind) {
  const el = document.createElement('div');
  el.className = `row ${kind}`;
  logEl.appendChild(el);
  while (logEl.childElementCount > MAX_ROWS) logEl.firstElementChild.remove();
  return { el, kind };
}

function logWrite(text, kind = 'out') {
  const parts = text.replace(/\r\n/g, '\n').split('\n');
  parts.forEach((seg, i) => {
    const last = i === parts.length - 1;
    if (seg !== '' || !last) {
      if (!(openRow && openRow.kind === kind)) openRow = newRow(kind);
      openRow.el.textContent += seg;
    }
    if (!last) openRow = null; // a newline ends the row
  });
  logEl.scrollTop = logEl.scrollHeight;
}

/** A whole line of our own (command echo, status): always starts on a fresh row. */
function logLine(text, kind) {
  openRow = null;
  logWrite(`${text}\n`, kind);
}

function clearLog() {
  logEl.replaceChildren();
  openRow = null;
}

function resetLog() {
  clearLog();
  queued = []; // input typed before a run is echoed in the log, so clearing the log clears it too
  const F = window.CCFriendly;
  logLine(state.friendly && F ? F.pickQuip() : 'Ready. Press Compile to build and run.', 'dim');
}

$('clear').addEventListener('click', resetLog);

// ---- Files: tree, open, create, upload, download, delete ----

function openFile(path) {
  state.open = path;
  if (!editor) { renderTree(); return; } // editor still loading: it shows state.open when ready
  editor.show(path);
  $('filename').textContent = path;
  $('lang').textContent = langOf(path);
  renderTree();
  applyDiagnostics();
  save();
}

function buildTree(paths) {
  const root = { dirs: {}, files: [] };
  for (const p of paths) {
    const parts = p.split('/');
    let node = root;
    for (const d of parts.slice(0, -1)) node = node.dirs[d] ||= { dirs: {}, files: [] };
    node.files.push(p);
  }
  return root;
}

function renderTree() {
  const tree = $('tree');
  tree.replaceChildren();
  const paths = Object.keys(state.files).sort();
  const canDelete = paths.length > 1;

  const addRow = (cls, depth, icon, name, onClick) => {
    const row = document.createElement('div');
    row.className = `node ${cls}`;
    row.style.paddingLeft = `${14 + depth * 16}px`;
    row.setAttribute('role', 'treeitem');
    const i = document.createElement('span');
    i.className = 'icon';
    i.textContent = icon;
    const n = document.createElement('span');
    n.className = 'nm';
    n.textContent = name;
    row.append(i, n);
    row.addEventListener('click', onClick);
    tree.appendChild(row);
    return row;
  };

  const walk = (node, depth, prefix) => {
    for (const d of Object.keys(node.dirs).sort()) {
      const key = prefix + d;
      const closed = state.collapsed[key];
      addRow('dir', depth, closed ? '▸' : '▾', `${d}/`, () => { state.collapsed[key] = !closed; save(); renderTree(); });
      if (!closed) walk(node.dirs[d], depth + 1, `${key}/`);
    }
    for (const p of node.files.sort()) {
      const on = p === state.open;
      const row = addRow(on ? 'file on' : 'file', depth, '', baseName(p), () => openFile(p));
      if (on) {
        const dl = document.createElement('button');
        dl.className = 'act';
        dl.title = 'Download';
        dl.setAttribute('aria-label', `Download ${baseName(p)}`);
        dl.textContent = '↓';
        dl.addEventListener('click', (e) => { e.stopPropagation(); downloadFile(p); });
        row.appendChild(dl);
        if (canDelete) {
          const del = document.createElement('button');
          del.className = 'act del';
          del.title = 'Delete';
          del.setAttribute('aria-label', `Delete ${baseName(p)}`);
          del.textContent = '×';
          del.addEventListener('click', (e) => { e.stopPropagation(); deleteFile(p); });
          row.appendChild(del);
        }
      }
    }
  };
  walk(buildTree(paths), 0, '');
}

function downloadFile(p) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([state.files[p] ?? ''], { type: 'text/plain' }));
  a.download = baseName(p);
  a.click();
  URL.revokeObjectURL(a.href);
}

function deleteFile(p) {
  const rest = Object.keys(state.files).filter((x) => x !== p);
  if (!rest.length) return;
  delete state.files[p];
  editor.remove(p);
  diags = diags.filter((d) => d.file !== p);
  openFile(rest.sort()[0]);
}

function addFile(path, content) {
  state.files[path] = content;
  openFile(path);
}

// new file
const addRowEl = $('add-row');
const nameInput = $('new-name');
function cancelAdd() {
  addRowEl.hidden = true;
  nameInput.classList.remove('bad');
}
$('new-file').addEventListener('click', () => {
  if (!state.sideOpen) setSidebarOpen(true); // the name box lives in the file list, so show it
  addRowEl.hidden = false;
  // Start in the folder of the open file ("src/"), so a bare name lands next to it.
  const dir = state.open.includes('/') ? state.open.slice(0, state.open.lastIndexOf('/') + 1) : '';
  nameInput.value = dir;
  nameInput.focus();
  nameInput.setSelectionRange(dir.length, dir.length);
});
nameInput.addEventListener('blur', cancelAdd);
nameInput.addEventListener('input', () => nameInput.classList.remove('bad'));
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return cancelAdd();
  if (e.key !== 'Enter') return;
  e.preventDefault(); // otherwise this Enter would also be typed into the editor we are about to focus
  const p = nameInput.value.trim().replace(/^\/+/, '');
  if (!p || state.files[p] !== undefined) return cancelAdd();
  if (!validName(p)) {
    nameInput.classList.add('bad');
    nameInput.title = 'Use letters, digits, _ - . / and a .c .cpp .h .hpp or .txt extension';
    return;
  }
  cancelAdd();
  addFile(p, '');
  if (editor) setTimeout(() => editor.focus(), 0); // so you can start typing in the new file straight away
});

// upload
$('upload').addEventListener('click', () => $('upload-input').click());
$('upload-input').addEventListener('change', async (e) => {
  const list = Array.from(e.target.files || []);
  e.target.value = '';
  for (const f of list) {
    if (!ALLOWED_EXT.test(f.name)) { logLine(`Skipped ${f.name}: only .c .cpp .h .hpp .txt files`, 'warn'); continue; }
    if (f.size > MAX_FILE_BYTES) { logLine(`Skipped ${f.name}: larger than 64 KB`, 'warn'); continue; }
    const safe = f.name.replace(/[^A-Za-z0-9_.\-]/g, '_');
    let p = `src/${safe}`;
    for (let i = 1; state.files[p] !== undefined; i++) p = `src/${safe.replace(/(\.\w+)$/, `-${i}$1`)}`;
    addFile(p, (await f.text()).replace(/\r\n/g, '\n'));
  }
});

// ---- Format button ----

const formatBtn = $('format');
let formatFlash = null;
function flashFormat(text) {
  formatBtn.textContent = text;
  clearTimeout(formatFlash);
  formatFlash = setTimeout(() => { formatBtn.textContent = 'Format'; }, 1500);
}

async function formatCurrent() {
  if (formatBtn.disabled) return;
  if (langOf(state.open) === 'Text') { flashFormat('C/C++ only'); return; }
  formatBtn.disabled = true;
  try {
    await editorReady;
    flashFormat((await editor.format()) ? 'Formatted ✓' : 'Already neat ✓');
  } catch (err) {
    console.warn('format failed:', err);
    showPanel('console');
    logLine(`[Could not format: ${err && err.message ? err.message : err}]`, 'err');
    flashFormat('Format failed');
  } finally {
    formatBtn.disabled = false;
  }
}
formatBtn.addEventListener('click', formatCurrent);

// Shift+Alt+F. Inside Monaco its own Format Document binding already runs, so only handle it elsewhere.
document.addEventListener('keydown', (e) => {
  if (e.shiftKey && e.altKey && e.code === 'KeyF' && !e.target.closest('.monaco-editor')) {
    e.preventDefault();
    formatCurrent();
  }
});

// ---- Sidebar and settings ----

// Collapsing shrinks the sidebar to a rail (hidden entirely on phones). Two buttons drive it:
// the one in the top bar and the one at the top of the sidebar.
function applySidebar() {
  $('sidebar').classList.toggle('collapsed', !state.sideOpen);
  for (const b of document.querySelectorAll('.js-toggle-side')) {
    b.setAttribute('aria-expanded', String(state.sideOpen));
    b.title = state.sideOpen ? 'Collapse sidebar' : 'Expand sidebar';
    b.setAttribute('aria-label', b.title);
    b.querySelector('.sideicon').classList.toggle('closed', !state.sideOpen);
  }
}
function setSidebarOpen(open) { state.sideOpen = open; applySidebar(); save(); }
for (const b of document.querySelectorAll('.js-toggle-side')) b.addEventListener('click', () => setSidebarOpen(!state.sideOpen));

function renderSettings() {
  const seg = $('mode-seg');
  seg.replaceChildren(...['dark', 'light'].map((k) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = k === 'dark' ? 'Dark' : 'Light';
    b.className = state.mode === k ? 'on' : '';
    b.addEventListener('click', () => { state.mode = k; applyTheme(); renderSettings(); renderConsoleSettings(); save(); });
    return b;
  }));
  const acc = $('accents');
  acc.replaceChildren(...Object.keys(ACCENTS).map((k) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = k;
    b.setAttribute('aria-label', `${k} accent`);
    b.style.background = ACCENTS[k][state.mode === 'dark' ? 0 : 1];
    b.className = state.acc === k ? 'on' : '';
    b.addEventListener('click', () => { state.acc = k; applyTheme(); renderSettings(); save(); });
    return b;
  }));
  const choice = (id, options, current, pick) => $(id).replaceChildren(...options.map(([value, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.className = current === value ? 'on' : '';
    b.addEventListener('click', () => { pick(value); renderSettings(); if (editor) editor.setIndent(); save(); });
    return b;
  }));
  choice('autoindent-seg', [[true, 'On'], [false, 'Off']], state.indent.auto, (v) => { state.indent.auto = v; });
  choice('indentsize-seg', INDENT_SIZES.map((n) => [n, String(n)]), state.indent.size, (v) => { state.indent.size = v; });
  $('friendly-seg').replaceChildren(...[[true, 'On'], [false, 'Off']].map(([v, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.className = state.friendly === v ? 'on' : '';
    b.addEventListener('click', () => { state.friendly = v; renderSettings(); applyDiagnostics(); updateStatsBar(); save(); });
    return b;
  }));
  $('format-style').value = state.formatStyle;
  $('fs-val').textContent = state.fs;
}

$('format-style').addEventListener('change', (e) => {
  if (FORMAT_STYLES.includes(e.target.value)) { state.formatStyle = e.target.value; save(); }
});

function setFont(fs) {
  state.fs = Math.min(24, Math.max(10, fs));
  $('fs-val').textContent = state.fs;
  if (editor) editor.setFont(state.fs);
  save();
}
$('fs-down').addEventListener('click', () => setFont(state.fs - 1));
$('fs-up').addEventListener('click', () => setFont(state.fs + 1));

function toggleSettings(open) {
  const menu = $('settings-menu');
  menu.hidden = open === undefined ? !menu.hidden : !open;
  $('settings-btn').setAttribute('aria-expanded', String(!menu.hidden));
}
$('settings-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleSettings(); });
$('settings-menu').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => toggleSettings(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleSettings(false); });

$('show-keys').addEventListener('click', () => {
  toggleSettings(false);
  showPanel('console');
  logLine('Keyboard shortcuts', 'muted');
  for (const l of ['  Ctrl/Cmd+Enter   compile and run', '  Enter            send a line of input', '  Ctrl+C           stop the running program (in the stdin box)', '  Ctrl+D           end of input (in the stdin box)', '  Up / Down        previous inputs (in the stdin box)', '  Shift+Alt+F      format the open file']) logLine(l, 'dim');
});

// ---- Build counter and streak (bottom bar) ----
// Kept apart from the project state, in its own localStorage key. Only shown in Friendly mode.

const STATS_KEY = 'cc-studio:stats:v1';
function loadStats() {
  try { return window.CCFriendly.cleanStats(JSON.parse(localStorage.getItem(STATS_KEY))); } catch { return window.CCFriendly.emptyStats(); }
}
let stats = window.CCFriendly ? loadStats() : null;

// The bar always shows the credit; the build counter on its left is part of Friendly mode.
function updateStatsBar() {
  const F = window.CCFriendly;
  $('stats').hidden = !state.friendly || !F;
  if (F) $('stats').textContent = F.statsLine(stats, F.dayKey());
}

function authorLink(label) {
  const a = document.createElement('a');
  a.href = AUTHOR.github;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = label;
  return a;
}

function renderCredit() {
  const long = document.createElement('span');
  long.className = 'long';
  long.textContent = 'Built by ';
  $('credit').replaceChildren(long, authorLink(`${AUTHOR.name} ↗`));
}

/** Count one build. ok = it compiled (a crash later does not matter); a build you stop midway is not counted. */
function countBuild(ok) {
  const F = window.CCFriendly;
  if (!F) return;
  stats = F.recordBuild(stats, ok, F.dayKey());
  try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch { /* storage full or blocked */ }
  updateStatsBar();
}

// ---- Running ----

let phase = 'idle'; // 'idle' | 'compiling' | 'running'
let ws = null;
let queued = []; // input typed before the program is running; sent as soon as it starts
const history = [];
let histPos = 0;

function setPhase(p) {
  phase = p;
  const btn = $('run');
  btn.disabled = false;
  btn.querySelector('.spinner').hidden = p === 'idle';
  btn.querySelector('.label').textContent = { idle: 'Compile ⏎', compiling: 'Compiling…', running: 'Stop' }[p];
  btn.title = p === 'idle' ? 'Compile and run (Ctrl+Enter)' : 'Stop';
}

// The compiler output is a series of blocks: a "file:line:col: kind: message" header followed by its
// code excerpt, optionally preceded by context lines ("In function 'main':"). Linker lines and
// "compilation terminated." stand alone.
const CONTEXT_RE = /^(.*: In (?:member )?function |In file included from |\s+from )/;
const STANDALONE_RE = /^(\/usr\/bin\/|collect2:|compilation terminated)|undefined reference|multiple definition/;

function splitCompileOutput(text) {
  const blocks = [];
  let cur = null;
  let prefix = [];
  for (const line of text.replace(/\n+$/, '').split('\n')) {
    const m = DIAG_RE.exec(line);
    if (m) {
      cur = { kind: m[4] === 'fatal error' ? 'error' : m[4], msg: m[5], prefix, lines: [line] };
      prefix = [];
      blocks.push(cur);
    } else if (CONTEXT_RE.test(line)) {
      prefix.push(line);
      cur = null;
    } else if (STANDALONE_RE.test(line) || !cur) {
      cur = null;
      blocks.push({ kind: 'other', prefix: [], lines: [line] });
    } else {
      cur.lines.push(line);
    }
  }
  return blocks;
}

/**
 * Print compiler output to the console. Warnings are not printed here (they live in the Diagnostics
 * tab and as marks in the editor), so a successful build with warnings stays quiet and a failed one
 * shows just its errors. A warning's notes, code excerpt and hint are dropped with it.
 */
function logCompile(text) {
  const F = state.friendly ? window.CCFriendly : null;
  let hideNotes = false;
  for (const b of splitCompileOutput(text)) {
    if (b.kind === 'note') {
      if (hideNotes) continue;
    } else {
      hideNotes = b.kind === 'warning';
    }
    if (b.kind === 'warning') continue;
    for (const l of b.prefix) logLine(l, 'dim');
    logLine(b.lines[0], b.kind === 'error' ? 'err' : 'dim');
    for (const l of b.lines.slice(1)) logLine(l, 'dim');
    const tip = F ? (b.kind === 'error' ? F.explainDiag(b) : b.kind === 'other' ? F.explainLine(b.lines[0]) : null) : null;
    if (tip) logLine(`  ↳ ${tip}`, 'tip'); // after the code excerpt, so it reads as a comment on the whole error
  }
}

function exitRow(m) {
  const secs = typeof m.ms === 'number' && m.ms > 0 ? ` · ${m.ms < 1000 ? `${m.ms}ms` : `${(m.ms / 1000).toFixed(2)}s`}` : '';
  switch (m.reason) {
    case 'compile_error': return ['[build failed]', 'err'];
    case 'timeout': return ['[time limit exceeded]', 'err'];
    case 'idle': return ['[stopped: no activity]', 'err'];
    case 'cpu_limit': return [`[CPU time limit exceeded${secs}]`, 'err'];
    case 'memory_limit': return ['[memory limit exceeded]', 'err'];
    case 'output_limit': return ['[output limit exceeded]', 'err'];
    case 'killed': return ['[stopped]', 'dim'];
    default:
      if (m.signal) return [`[crashed: ${m.signal}${secs}]`, 'err'];
      return [`[exit ${m.code}${secs}]`, m.code === 0 ? 'ok' : 'err'];
  }
}

function runClicked() {
  if (phase === 'idle') run();
  else stop();
}

function stop() {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'kill' }));
}

async function run() {
  await editorReady;
  const path = state.open;
  const language = runLanguage(path);
  if (!language) {
    showPanel('console');
    logLine(`${baseName(path)} is not a C or C++ file. Open a .c or .cpp file to compile.`, 'err');
    return;
  }
  const files = Object.entries(state.files).map(([p, content]) => ({ path: p, content }));

  // Input typed but not yet submitted with Enter counts as the last input line.
  const stdinEl = $('stdin');
  if (stdinEl.value) submitInput(stdinEl.value);
  const lines = queued;
  queued = [];

  diags = [];
  applyDiagnostics();
  showPanel('console');
  setPhase('compiling');

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/ws/run`);
  ws = socket;
  let finished = false;
  let counted = false; // each run is counted once
  const count = (ok) => { if (!counted) { counted = true; countBuild(ok); } };

  const finish = () => {
    if (finished) return;
    finished = true;
    queued = [];
    setPhase('idle');
    try { socket.close(); } catch { /* already closed */ }
    $('stdin').focus();
  };

  socket.onopen = () => socket.send(JSON.stringify({ type: 'run', language, files, entry: path }));
  socket.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    switch (m.type) {
      case 'compile':
        diags = parseDiags(m.text);
        applyDiagnostics();
        logCompile(m.text);
        break;
      case 'started':
        count(true);
        setPhase('running');
        if (lines.length) socket.send(JSON.stringify({ type: 'input', data: `${lines.join('\n')}\n` }));
        break;
      case 'out':
        logWrite(m.data, m.stream === 'stderr' ? 'warn' : 'out');
        break;
      case 'exit': {
        if (m.reason === 'compile_error') count(false);
        const [text, kind] = exitRow(m);
        logLine(text, kind);
        const exitTip = state.friendly && window.CCFriendly ? window.CCFriendly.explainExit(m) : null;
        if (exitTip) logLine(`  ↳ ${exitTip}`, 'tip');
        finish();
        break;
      }
      case 'error':
        logLine(`[${m.message}]`, 'err');
        finish();
        break;
    }
  };
  socket.onerror = () => { /* onclose follows and reports it */ };
  socket.onclose = () => {
    if (!finished) {
      logLine('[connection lost]', 'err');
      finish();
    }
  };
}

$('run').addEventListener('click', runClicked);

// Ctrl/Cmd+Enter anywhere outside Monaco (e.g. in the stdin box).
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    if (phase === 'idle') run();
  }
});

// ---- stdin row ----

/**
 * Friendly mode: a few commands and easter eggs in the stdin box. Only when idle, so a running
 * program (which may legitimately read the word "hello") always gets what you type.
 */
function handleConsoleCommand(text) {
  const cmd = text.trim();
  const F = window.CCFriendly;
  if (phase !== 'idle' || !cmd) return false;
  if (ABOUT_RE.test(cmd)) { // informational, so it works with Friendly mode off too
    logLine(`› ${text}`, 'in');
    logAbout();
    return true;
  }
  if (!state.friendly || !F) return false;
  if (/^(clear|cls)$/i.test(cmd)) { resetLog(); return true; }
  const reply = /^(ls|dir)$/i.test(cmd) ? Object.keys(state.files).sort().join('\n') : F.eggReply(cmd);
  if (!reply) return false;
  logLine(`› ${text}`, 'in');
  for (const line of reply.split('\n')) logLine(line, 'muted');
  return true;
}

// The `about` card is ASCII art: a block-letter banner (SONET, drawn here by hand, so change it together
// with AUTHOR) above a plain +---+ frame. Rows are `white-space: pre` so the art never wraps; on a very
// narrow console the log scrolls sideways instead.
const ASCII_BANNER = [
  ' ____    ___   _   _  _____  _____',
  '/ ___|  / _ \\ | \\ | || ____||_   _|',
  '\\___ \\ | | | ||  \\| ||  _|    | |',
  ' ___) || |_| || |\\  || |___   | |',
  '|____/  \\___/ |_| \\_||_____|  |_|',
];
const ABOUT_WIDTH = 35; // inner width of the frame; the banner is 35 columns wide too

/** One preformatted console row made of text and/or DOM nodes (links), never HTML strings. */
function asciiRow(parts, kind) {
  openRow = null;
  newRow(`ascii ${kind}`).el.append(...parts);
}

/** The `about` card: who built this, with a real link. */
function logAbout() {
  const W = ABOUT_WIDTH;
  const rule = `+${'-'.repeat(W + 2)}+`;
  const fit = (s) => s.slice(0, W) + ' '.repeat(Math.max(0, W - s.length));
  const text = (s) => asciiRow([`| ${fit(s)} |`], 'dim');
  for (const line of ASCII_BANNER) asciiRow([line], 'art');
  asciiRow([''], 'dim');
  asciiRow([rule], 'dim');
  text('cc-studio: C and C++ in the browser');
  text(`built by ${AUTHOR.fullName} (${AUTHOR.name})`);
  const label = AUTHOR.github.replace(/^https?:\/\//, '').replace(/\/$/, '');
  asciiRow(['| ', authorLink(label), ' '.repeat(Math.max(0, W - label.length)), ' |'], 'dim');
  text("runs in a sandbox. try 'help'");
  asciiRow([rule], 'dim');
  logEl.scrollTop = logEl.scrollHeight;
}

function submitInput(text) {
  if (text === '' && phase !== 'running') return; // a blank line only means something to a running program
  if (handleConsoleCommand(text)) return;
  logLine(`› ${text}`, 'in');
  history.push(text);
  histPos = history.length;
  if (phase === 'running' && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', data: `${text}\n` }));
  } else {
    queued.push(text); // not running yet: delivered when the next run starts
  }
}

$('stdin').addEventListener('keydown', (e) => {
  const el = e.target;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Enter' && !mod) {
    e.preventDefault();
    submitInput(el.value);
    el.value = '';
  } else if (mod && e.key.toLowerCase() === 'c' && phase !== 'idle' && el.selectionStart === el.selectionEnd) {
    e.preventDefault(); // Ctrl+C stops a running program, like a real console
    logLine('^C', 'dim');
    stop();
  } else if (mod && e.key.toLowerCase() === 'd' && phase === 'running') {
    e.preventDefault(); // Ctrl+D: end of input
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'eof' }));
  } else if (e.key === 'ArrowUp' && history.length) {
    e.preventDefault();
    histPos = Math.max(0, histPos - 1);
    el.value = history[histPos] ?? '';
  } else if (e.key === 'ArrowDown' && history.length) {
    e.preventDefault();
    histPos = Math.min(history.length, histPos + 1);
    el.value = history[histPos] ?? '';
  }
});

// Multi-line paste becomes several submitted lines; the last fragment stays editable.
$('stdin').addEventListener('paste', (e) => {
  const text = e.clipboardData && e.clipboardData.getData('text');
  if (!text || !/[\r\n]/.test(text)) return;
  e.preventDefault();
  const parts = (e.target.value + text).split(/\r?\n/);
  const rest = parts.pop();
  parts.forEach(submitInput);
  e.target.value = rest;
});

// ---- Start-up ----

applyTheme();
applySidebar();
renderSettings();
renderConsoleSettings();
renderCredit();
renderTree();
showPanel('console', false);
setPanelOpen(state.panelOpen);
$('filename').textContent = state.open;
$('lang').textContent = langOf(state.open);
setPhase('idle');
resetLog();
updateStatsBar();
applyDiagnostics();

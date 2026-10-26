'use strict';

const MAX_SOURCE_BYTES = 64 * 1024; // total across all files
const MAX_FILES = 20;
const LANGUAGES = ['c', 'cpp'];

// Which files are compiled for each language, and which other files may be sent along.
const SOURCE_EXT = { c: /\.c$/i, cpp: /\.(cpp|cc|cxx)$/i };
const ALLOWED_EXT = /\.(c|cpp|cc|cxx|h|hpp|hh|hxx|txt)$/i;
// Relative path of safe characters: no leading "/", no "..", no "//". These names end up
// inside a shell command and a filesystem path, so the whitelist is deliberately strict.
const PATH_RE = /^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9_.\-/]{1,100}$/;

/** Folder of a path, with a trailing slash ('' for a top-level file). */
const folderOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');

/**
 * The files to compile: sources of the language inside the folder of `entry` (the file the user has
 * open), subfolders included. Without an entry, every source in the project. Other folders' files are
 * still written to disk so headers can be included from anywhere.
 */
function sourcesFor(language, paths, entry) {
  const scope = entry ? folderOf(entry) : '';
  return paths.filter((p) => SOURCE_EXT[language].test(p) && p.startsWith(scope));
}

/**
 * Validate a run request: { language, files: [{path, content}], entry? } (entry: the open file, whose folder
 * is built), or the single-file shorthand { language, source_code } which becomes main.c / main.cpp.
 * Returns { ok: true, value: { language, files } } or { ok: false, error }.
 * Sizes are measured in UTF-8 bytes, not characters, since that is what actually
 * gets written for the compiler.
 */
function validateRunBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }

  const { language, source_code, files, entry } = body;

  if (!LANGUAGES.includes(language)) {
    return { ok: false, error: 'language must be "c" or "cpp".' };
  }

  let list;
  if (files !== undefined) {
    if (!Array.isArray(files) || files.length === 0) return { ok: false, error: 'files must be a non-empty array.' };
    if (files.length > MAX_FILES) return { ok: false, error: `At most ${MAX_FILES} files are allowed.` };
    list = files;
  } else {
    if (typeof source_code !== 'string') return { ok: false, error: 'source_code must be a string.' };
    if (source_code.trim() === '') return { ok: false, error: 'source_code must not be empty.' };
    list = [{ path: language === 'cpp' ? 'main.cpp' : 'main.c', content: source_code }];
  }

  const seen = new Set();
  let total = 0;
  for (const f of list) {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') {
      return { ok: false, error: 'Each file needs a string path and string content.' };
    }
    if (!PATH_RE.test(f.path) || !ALLOWED_EXT.test(f.path)) {
      return { ok: false, error: `Invalid file name "${f.path.slice(0, 40)}". Use letters, digits, _ - . / and a .c .cpp .h .hpp .txt extension.` };
    }
    if (seen.has(f.path)) return { ok: false, error: `Duplicate file "${f.path}".` };
    seen.add(f.path);
    total += Buffer.byteLength(f.content, 'utf8');
  }
  if (total > MAX_SOURCE_BYTES) return { ok: false, error: 'Source files must be at most 64 KB in total.' };

  if (entry !== undefined && (typeof entry !== 'string' || !seen.has(entry))) {
    return { ok: false, error: 'entry must be the path of one of the files.' };
  }

  const inScope = new Set(sourcesFor(language, list.map((f) => f.path), entry));
  const sources = list.filter((f) => inScope.has(f.path) && f.content.trim() !== '');
  if (sources.length === 0) {
    const where = entry && folderOf(entry) ? ` in "${folderOf(entry)}"` : '';
    return { ok: false, error: `No ${language === 'cpp' ? '.cpp' : '.c'} source file${where} to compile.` };
  }

  const value = { language, files: list.map(({ path, content }) => ({ path, content })) };
  if (entry !== undefined) value.entry = entry;
  return { ok: true, value };
}

module.exports = { validateRunBody, sourcesFor, folderOf, MAX_SOURCE_BYTES, MAX_FILES, LANGUAGES, SOURCE_EXT };

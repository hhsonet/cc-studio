'use strict';

// Friendly explanations for compiler diagnostics, linker errors and program crashes, plus the
// console's idle quips and the easter eggs for the stdin box.
// Pure functions with no DOM access, so the same file runs in the browser (window.CCFriendly)
// and in the Node tests (require). Every rule is a [pattern, builder]; the first match wins,
// so specific rules come before generic ones. Anything unknown returns null: better silent
// than wrong.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CCFriendly = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Which header declares the common C library functions people forget to include.
  const HEADERS = {
    'stdio.h': 'printf scanf puts putchar getchar fopen fclose fgets fputs fprintf fscanf sprintf snprintf sscanf perror fread fwrite fflush',
    'stdlib.h': 'malloc calloc realloc free exit atoi atof atol rand srand abs qsort strtol strtod system',
    'string.h': 'strlen strcpy strncpy strcmp strncmp strcat strncat memcpy memset memcmp memmove strchr strrchr strstr strdup',
    'math.h': 'sqrt pow sin cos tan fabs floor ceil log log10 exp fmod',
    'ctype.h': 'isdigit isalpha isspace isalnum isupper islower toupper tolower',
    'time.h': 'time clock difftime',
  };
  const HEADER_OF = {};
  for (const [h, fns] of Object.entries(HEADERS)) for (const f of fns.split(' ')) HEADER_OF[f] = h;

  // Which header provides common std:: names (for "'string' is not a member of 'std'").
  const STD_HEADER = {};
  const STD_HEADERS = {
    string: 'string', vector: 'vector', map: 'map', set: 'set', unordered_map: 'unordered_map', queue: 'queue', stack: 'stack',
    cout: 'iostream', cin: 'iostream', cerr: 'iostream', endl: 'iostream', sort: 'algorithm', min: 'algorithm', max: 'algorithm',
    swap: 'algorithm', reverse: 'algorithm', unique_ptr: 'memory', shared_ptr: 'memory', ifstream: 'fstream', ofstream: 'fstream',
  };
  Object.assign(STD_HEADER, STD_HEADERS);

  const quote = (s) => `'${s}'`;
  const first = (m, ...idx) => idx.map((i) => m[i]).find(Boolean);

  // Rules for compiler diagnostics. `msg` is the text after "error:" / "warning:".
  const DIAG_RULES = [
    [/expected ';' (?:before|after)/, () => 'You forgot a semicolon. Classic.'],
    [/expected '\)' before/, () => "A parenthesis was opened and never closed. It's still waiting."],
    [/expected declaration or statement at end of input|expected '\}' at end of input/, () => 'A closing brace is missing somewhere. Count your { and }.'],
    [/missing terminating " character|unterminated string/, () => 'A string never got its closing quote.'],
    [/missing terminating ' character/, () => 'A character literal never got its closing quote.'],
    [/implicit declaration of function '([^']+)'/, (m, msg) => {
      const fn = m[1];
      if (HEADER_OF[fn]) return `You used ${quote(fn)} without saying hello to <${HEADER_OF[fn]}> first. Add #include <${HEADER_OF[fn]}>.`;
      const dym = /did you mean '([^']+)'/.exec(msg);
      if (dym) return `${quote(fn)} doesn't exist. Did you mean ${quote(dym[1])}?`;
      return `${quote(fn)} was used before it was declared. Add its #include, or declare it above main.`;
    }],
    [/did you mean '([^']+)'/, (m) => `Did you mean ${quote(m[1])}? The compiler thinks so.`],
    [/'(cout|cin|cerr|endl|string|vector|map|set|unique_ptr|shared_ptr)' was not declared/, (m) => `${quote(m[1])} lives in the std namespace: write std::${m[1]}, or add 'using namespace std;' (and the right #include).`],
    [/'([^']+)' undeclared \(first use in this function\)|'([^']+)' undeclared here|'([^']+)' was not declared in this scope/, (m) => `${quote(first(m, 1, 2, 3))} was never declared. A typo, or declared in a different scope?`],
    [/unknown type name '([^']+)'|'([^']+)' does not name a type/, (m) => `${quote(first(m, 1, 2))} isn't a type the compiler knows. Missing #include, or a typo?`],
    [/expected expression at end of input/, () => 'The file ended in the middle of something. A quote, bracket or brace is probably unclosed.'],
    [/'([^']+)' is not a member of 'std'/, (m) => {
      const h = STD_HEADER[m[1]];
      return h ? `std::${m[1]} needs #include <${h}>.` : `std::${m[1]} isn't known here. Missing #include, or a typo?`;
    }],
    [/expected expression before|expected primary-expression before/, () => 'The compiler wanted a value here and found something else.'],
    [/expected unqualified-id before/, () => 'Something is out of place here: often a stray brace, a stray semicolon, or a missing type.'],
    [/unused variable '([^']+)'/, (m) => `You declared ${quote(m[1])} and never used it. A very lonely variable.`],
    [/unused parameter '([^']+)'/, (m) => `The parameter ${quote(m[1])} is never used. Remove it, or ignore it on purpose.`],
    [/variable '([^']+)' set but not used/, (m) => `You assigned ${quote(m[1])} but never read it.`],
    [/'([^']+)' defined but not used/, (m) => `${quote(m[1])} is never called. Dead code, still on the payroll.`],
    [/'([^']+)' (?:may be|is) used uninitialized/, (m) => `${quote(m[1])} is read before it gets a value. Garbage in, garbage out.`],
    [/control reaches end of non-void function/, () => 'A function promised to return a value, then just stopped. Add a return.'],
    [/format '(%[^']+)' expects argument of type '([^']+)', but argument \d+ has type '([^']+)'/, (m) => `The format ${m[1]} wants a ${m[2]} but got a ${m[3]}. printf takes you literally.`],
    [/too many arguments for format/, () => 'More arguments than format specifiers. The extras are ignored.'],
    [/format '[^']*' expects a matching '[^']*' argument|too few arguments for format/, () => 'printf wants more arguments than you gave it.'],
    [/too few arguments to function '([^']+)'/, (m) => `${quote(m[1])} needs more arguments than you gave it.`],
    [/too many arguments to function '([^']+)'/, (m) => `${quote(m[1])} was given more arguments than it takes.`],
    [/no matching function for call to/, () => 'No overload accepts those arguments. Check their types and how many there are.'],
    [/assignment to expression with array type/, () => "Arrays can't be assigned with =. Copy with strcpy, memcpy or a loop."],
    [/incompatible pointer type|makes pointer from integer|makes integer from pointer|invalid conversion from/, () => 'Two types got mixed up. Check what each side of the assignment or call really is.'],
    [/lvalue required as left operand of assignment/, () => "You can only assign to a variable, not to a value. 5 = x won't work either way round."],
    [/using the result of an assignment as a condition|suggest parentheses around assignment used as truth value/, () => 'Did you write = where you meant ==?'],
    [/comparison of integer expressions of different signedness/, () => 'Comparing signed and unsigned numbers: a negative value will surprise you.'],
    [/suggest parentheses around '&&' within '\|\|'/, () => 'Mixing && and || without parentheses. Add them so the precedence is obvious.'],
    [/division by zero/, () => 'Dividing by zero. Bold.'],
    [/array subscript .* (?:above|outside) array bounds/, () => 'That index is past the end of the array. Valid indexes run from 0 to length-1.'],
    [/ignoring return value of '([^']+)'/, (m) => `${quote(m[1])} returned something and you ignored it. It was trying to tell you something.`],
    [/conflicting types for '([^']+)'/, (m) => `${quote(m[1])} is declared twice with different signatures.`],
    [/redefinition of '([^']+)'|redeclaration of '([^']+)'/, (m) => `${quote(first(m, 1, 2))} is defined twice. There can only be one.`],
    [/No such file or directory/, () => "That file doesn't exist where the compiler looked. Check the name and path (they are case-sensitive)."],
    [/return type of 'main' is not 'int'/, () => 'main should return int.'],
    [/stray '\\\d+' in program|stray '[^']' in program/, () => "A character the compiler doesn't recognise slipped in, often from pasted text with fancy quotes."],
  ];

  // Linker errors do not have the file:line:col shape, so these match the raw output line.
  const LINE_RULES = [
    [/undefined reference to [`']main'/, () => "There's no main function. Every program starts there."],
    [/undefined reference to [`']([^'`]+)'/, (m) => `The linker can't find ${quote(m[1])}: it's declared but never defined. Is its .c file in the project?`],
    [/multiple definition of [`']([^'`]+)'/, (m) => `${quote(m[1])} is defined in more than one file. Keep one definition and put declarations in a header.`],
    [/cannot find -l(\S+)/, (m) => `The library ${quote(m[1])} isn't available on this server.`],
  ];

  /** Tip for one parsed diagnostic { kind, msg }, or null. Notes are never explained. */
  function explainDiag(d) {
    if (!d || d.kind === 'note') return null;
    for (const [re, build] of DIAG_RULES) {
      const m = re.exec(d.msg);
      if (m) return build(m, d.msg);
    }
    return null;
  }

  /** Tip for a raw compiler/linker output line (used for linker errors), or null. */
  function explainLine(line) {
    for (const [re, build] of LINE_RULES) {
      const m = re.exec(line);
      if (m) return build(m, line);
    }
    return null;
  }

  const SIGNAL_TIPS = {
    SIGSEGV: "Segmentation fault: you touched memory that wasn't yours. Check pointers, array bounds and uninitialised variables.",
    SIGFPE: 'Arithmetic fault, usually a division by zero.',
    SIGABRT: 'The program aborted itself, often a failed assert(), a double free or heap corruption.',
    SIGBUS: 'Bus error: an invalid or misaligned memory access.',
    SIGILL: 'Illegal instruction: something corrupted the stack or the program itself.',
  };
  const REASON_TIPS = {
    cpu_limit: 'Your loop discovered eternity. Check the loop condition.',
    timeout: 'The program ran for too long. Is something waiting forever?',
    idle: 'It sat there waiting. If it reads input, type something at stdin ›.',
    memory_limit: 'The program asked for more memory than it may use. Runaway recursion, or a giant array?',
    output_limit: "That's a lot of output. Is a loop printing forever?",
  };

  /** Tip for how a run ended: { reason, signal, code }. Clean exits and manual stops get none. */
  function explainExit(m) {
    if (!m || m.reason === 'killed' || m.reason === 'compile_error') return null;
    if (REASON_TIPS[m.reason]) return REASON_TIPS[m.reason];
    if (m.signal && SIGNAL_TIPS[m.signal]) return SIGNAL_TIPS[m.signal];
    if (typeof m.code === 'number' && m.code !== 0 && !m.signal) return `Exit code ${m.code}. By tradition 0 means success and anything else means "something went wrong".`;
    return null;
  }

  // ---- Idle quips: the first console line. Every one still says how to run. ----
  const PLAIN_READY = 'Ready. Press Compile to build and run.';
  const QUIPS = [
    PLAIN_READY,
    'Waiting for you to break something. Press Compile when ready.',
    'The compiler is warming up its opinions. Press Compile.',
    'Nothing is broken yet. Press Compile to change that.',
    'Semicolons: checked? Press Compile and find out.',
    'Zero warnings so far. Press Compile to spoil that.',
  ];
  function pickQuip(random = Math.random) {
    return QUIPS[Math.floor(random() * QUIPS.length) % QUIPS.length];
  }

  // ---- Easter eggs: things people type into the stdin box when no program is running. ----
  const EGGS = [
    [/^sudo(\s|$)/i, "Nice try. You're not root in here, you're 'nobody' (uid 65534), and that's the whole point."],
    [/^rm\s+-[a-z]*r/i, "That's a sandbox, not a prank. The container is thrown away after every run anyway."],
    [/^(exit|quit|logout|:q!?|:wq)$/i, "You can't quit from here. Closing the tab works, and so does learning how to exit Vim."],
    [/^(help|\?|--help)$/i, 'Try: about, ls, clear, whoami, sudo, make coffee. Or just press Compile.'],
    [/^(hi|hello|hey)!?$/i, "Hello! I'm a console, not a chatbot. Press Compile and I'll run your code."],
    [/^make\s+coffee$/i, "error 418: I'm a teapot."],
    [/^(whoami|id)$/i, 'nobody (uid 65534). No network, no privileges, a read-only filesystem. Living the dream.'],
    [/^(ping|curl|wget|ssh)(\s|$)/i, "There's no network in here. The container has no way out, and nobody is coming in."],
    [/^(vim?|emacs|nano|code)$/i, 'The editor is on the left. It even has syntax highlighting.'],
  ];
  /** Reply for an easter-egg line, or null if it is just ordinary input. */
  function eggReply(text) {
    const t = String(text).trim();
    if (!t) return null;
    for (const [re, reply] of EGGS) if (re.test(t)) return reply;
    return null;
  }

  // ---- Build counter and streak (the bottom bar). Pure functions; the page keeps the state in localStorage. ----
  const emptyStats = () => ({ day: '', builds: 0, streak: 0, best: 0, last: '' });

  /** Local date as YYYY-MM-DD. */
  function dayKey(date = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  }

  /** Stats read back from storage, reduced to safe values (it is user-editable data). */
  function cleanStats(raw) {
    const s = emptyStats();
    if (!raw || typeof raw !== 'object') return s;
    const n = (v) => (Number.isInteger(v) && v >= 0 && v < 1e9 ? v : 0);
    if (typeof raw.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.day)) s.day = raw.day;
    s.builds = n(raw.builds);
    s.streak = n(raw.streak);
    s.best = Math.max(n(raw.best), s.streak);
    s.last = raw.last === 'ok' || raw.last === 'fail' ? raw.last : '';
    return s;
  }

  /** Stats after one more build. ok = the code compiled. Today's count restarts each day, the streak does not. */
  function recordBuild(stats, ok, today = dayKey()) {
    const s = cleanStats(stats);
    if (s.day !== today) { s.day = today; s.builds = 0; }
    s.builds += 1;
    s.streak = ok ? s.streak + 1 : 0;
    s.best = Math.max(s.best, s.streak);
    s.last = ok ? 'ok' : 'fail';
    return s;
  }

  /** The text for the bottom bar. */
  function statsLine(stats, today = dayKey()) {
    const s = cleanStats(stats);
    if (s.day !== today || s.builds === 0) return s.streak >= 3 ? `No builds yet today · streak of ${s.streak} waiting for you` : 'No builds yet today';
    if (s.last === 'fail') return `Build #${s.builds} today · streak reset${s.best >= 3 ? ` · best ${s.best}` : ''}`;
    const streak = s.streak === 1 ? 'clean build' : `${s.streak} clean in a row${s.streak >= 3 ? ' 🔥' : ''}`;
    return `Build #${s.builds} today · ${streak}${s.best > s.streak && s.best >= 3 ? ` · best ${s.best}` : ''}`;
  }

  return { explainDiag, explainLine, explainExit, pickQuip, eggReply, emptyStats, dayKey, cleanStats, recordBuild, statsLine, PLAIN_READY, QUIPS, DIAG_RULES, LINE_RULES, HEADER_OF };
});

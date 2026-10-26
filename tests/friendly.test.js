'use strict';

// Tests for the friendly-mode table (public/friendly.js): compiler/linker tips, crash notes,
// console quips and stdin easter eggs. It is a pure module, so no browser is needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../public/friendly.js');

const diag = (msg, kind = 'error') => F.explainDiag({ kind, msg });

test('common gcc errors get a plain-English tip', () => {
  const cases = [
    ["expected ';' before 'return'", /semicolon/i],
    ["expected ';' before '}' token", /semicolon/i],
    ["expected ')' before ';' token", /parenthesis/i],
    ['expected declaration or statement at end of input', /closing brace/i],
    ['missing terminating " character', /closing quote/i],
    ["implicit declaration of function 'printf' [-Wimplicit-function-declaration]", /#include <stdio\.h>/],
    ["implicit declaration of function 'malloc'", /<stdlib\.h>/],
    ["implicit declaration of function 'strlen'", /<string\.h>/],
    ["implicit declaration of function 'sqrt'", /<math\.h>/],
    ["implicit declaration of function 'foo'", /declare it above main/i],
    ["implicit declaration of function 'pritnf'; did you mean 'printf'?", /Did you mean 'printf'/],
    ["'x' undeclared (first use in this function)", /'x' was never declared/],
    ["'cout' was not declared in this scope", /std::cout/],
    ["'cout' was not declared in this scope; did you mean 'std::cout'?", /Did you mean 'std::cout'/],
    ["unknown type name 'uint8_t'", /'uint8_t' isn't a type/],
    ["control reaches end of non-void function [-Wreturn-type]", /return/i],
    ["format '%d' expects argument of type 'int', but argument 2 has type 'double' [-Wformat=]", /%d wants a int but got a double/],
    ["too few arguments to function 'fib'", /'fib' needs more arguments/],
    ["assignment to expression with array type", /strcpy/],
    ["lvalue required as left operand of assignment", /assign to a variable/],
    ['division by zero [-Wdiv-by-zero]', /Dividing by zero/],
    ["conflicting types for 'f'", /'f' is declared twice/],
    ["util.h: No such file or directory", /case-sensitive/],
    ['expected expression at end of input', /ended in the middle/],
    ["'string' is not a member of 'std'", /std::string needs #include <string>/],
    ["'vector' is not a member of 'std'", /<vector>/],
    ["'sort' is not a member of 'std'", /<algorithm>/],
    ["'frobnicate' is not a member of 'std'", /Missing #include, or a typo/],
  ];
  for (const [msg, re] of cases) assert.match(diag(msg), re, msg);
});

test('warnings get tips too, and gcc notes never do', () => {
  assert.match(diag("unused variable 'unused' [-Wunused-variable]", 'warning'), /'unused'.*lonely/i);
  assert.match(diag("'n' may be used uninitialized [-Wmaybe-uninitialized]", 'warning'), /'n' is read before/);
  assert.match(diag("ignoring return value of 'scanf' [-Wunused-result]", 'warning'), /'scanf' returned/);
  assert.equal(diag("include '<stdio.h>' or provide a declaration of 'printf'", 'note'), null);
});

test('unknown diagnostics return null instead of a wrong guess', () => {
  assert.equal(diag('some brand new diagnostic nobody has seen'), null);
  assert.equal(F.explainDiag(null), null);
  assert.equal(F.explainDiag({ kind: 'error' }.msg), null);
});

test('linker errors are explained from the raw output line', () => {
  assert.match(F.explainLine("/usr/bin/ld: /tmp/cc.o: in function `main': main.c:(.text+0x1e): undefined reference to `fib'"), /can't find 'fib'.*\.c file/);
  assert.match(F.explainLine("undefined reference to `main'"), /no main function/i);
  assert.match(F.explainLine("/usr/bin/ld: multiple definition of `helper'; a.o: first defined here"), /'helper' is defined in more than one file/);
  assert.equal(F.explainLine('collect2: error: ld returned 1 exit status'), null);
  assert.equal(F.explainLine('plain text'), null);
});

test('every tip is a clean sentence: no leftover placeholders or "undefined"', () => {
  const samples = [
    ["implicit declaration of function 'x'", "'x' undeclared (first use in this function)", "unknown type name 'T'", "unused variable 'v'",
      "unused parameter 'p'", "variable 'v' set but not used", "'f' defined but not used", "'v' is used uninitialized", "too many arguments to function 'f'",
      "redefinition of 'f'", "redeclaration of 'f'", "ignoring return value of 'f'", "'x' does not name a type", "'x' was not declared in this scope"],
  ].flat();
  for (const msg of samples) {
    const tip = diag(msg, 'warning');
    assert.ok(tip, msg);
    assert.doesNotMatch(tip, /undefined|\$\d|\[object|null/, `${msg} -> ${tip}`);
  }
  for (const [re] of F.DIAG_RULES) assert.ok(re instanceof RegExp);
});

test('crash and limit notes', () => {
  assert.match(F.explainExit({ signal: 'SIGSEGV', code: 139 }), /memory that wasn't yours/);
  assert.match(F.explainExit({ signal: 'SIGFPE' }), /division by zero/);
  assert.match(F.explainExit({ signal: 'SIGABRT' }), /assert|free/);
  assert.match(F.explainExit({ reason: 'cpu_limit', signal: 'SIGXCPU' }), /eternity/);
  assert.match(F.explainExit({ reason: 'memory_limit' }), /memory/);
  assert.match(F.explainExit({ reason: 'output_limit' }), /output/);
  assert.match(F.explainExit({ code: 3 }), /Exit code 3/);
  // nothing to say about a clean exit, a manual stop, or a failed build
  assert.equal(F.explainExit({ code: 0 }), null);
  assert.equal(F.explainExit({ reason: 'killed', signal: 'SIGKILL', code: 137 }), null);
  assert.equal(F.explainExit({ reason: 'compile_error', code: 198 }), null);
});

test('console quips always tell you how to run', () => {
  assert.ok(F.QUIPS.length >= 5);
  for (const q of F.QUIPS) assert.match(q, /Compile/, q);
  assert.equal(F.pickQuip(() => 0), F.PLAIN_READY);
  assert.equal(F.pickQuip(() => 0.999999), F.QUIPS[F.QUIPS.length - 1]);
  assert.ok(F.QUIPS.includes(F.pickQuip()));
});

test('easter eggs: fun words get a reply, ordinary input does not', () => {
  assert.match(F.eggReply('sudo rm -rf /'), /Nice try/);
  assert.match(F.eggReply('SUDO make me a sandwich'), /Nice try/);
  assert.match(F.eggReply('rm -rf /'), /sandbox, not a prank/);
  assert.match(F.eggReply('exit'), /Vim/);
  assert.match(F.eggReply(':q'), /Vim/);
  assert.match(F.eggReply('make coffee'), /teapot/);
  assert.match(F.eggReply('whoami'), /nobody/);
  assert.match(F.eggReply('curl example.com'), /no network/i);
  assert.match(F.eggReply('hello'), /not a chatbot/);
  assert.match(F.eggReply('help'), /ls, clear/);
  // input a real program could plausibly read must pass through untouched
  for (const t of ['42', '-7', '3.14', 'Alice', 'sudoku', 'rmdir', 'hellothere', 'yes', 'n', '', '   ']) assert.equal(F.eggReply(t), null, JSON.stringify(t));
});

test('build counter and streak', () => {
  const today = '2026-10-26';
  assert.equal(F.statsLine(null, today), 'No builds yet today');
  let s = null;
  const lines = [true, true, true, false, true].map((ok) => F.statsLine((s = F.recordBuild(s, ok, today)), today));
  assert.deepEqual(lines, [
    'Build #1 today · clean build',
    'Build #2 today · 2 clean in a row',
    'Build #3 today · 3 clean in a row 🔥',
    'Build #4 today · streak reset · best 3',
    'Build #5 today · clean build · best 3',
  ]);
});

test('the daily count restarts each day but the streak carries over', () => {
  const yesterday = { day: '2026-10-25', builds: 9, streak: 4, best: 6, last: 'ok' };
  assert.equal(F.statsLine(yesterday, '2026-10-26'), 'No builds yet today · streak of 4 waiting for you');
  assert.equal(F.statsLine(F.recordBuild(yesterday, true, '2026-10-26'), '2026-10-26'), 'Build #1 today · 5 clean in a row 🔥 · best 6');
  assert.equal(F.statsLine(F.recordBuild(yesterday, false, '2026-10-26'), '2026-10-26'), 'Build #1 today · streak reset · best 6');
});

test('stats read from storage are sanitised', () => {
  assert.deepEqual(F.cleanStats({ day: 'x', builds: -1, streak: 'a', best: 2.5 }), F.emptyStats());
  assert.deepEqual(F.cleanStats(null), F.emptyStats());
  assert.deepEqual(F.cleanStats('junk'), F.emptyStats());
  assert.equal(F.cleanStats({ day: '2026-10-26', builds: 3, streak: 2, best: 1, last: 'ok' }).best, 2); // best is never below the streak
  assert.match(F.dayKey(new Date(2026, 0, 5)), /^2026-01-05$/);
});

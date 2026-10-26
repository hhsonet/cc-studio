'use strict';

// The clang-format settings used by the Format button. A tiny shared module (browser: window.CCFormat,
// Node tests: require) so the page and the tests always agree on the exact configuration.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CCFormat = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const STYLES = ['LLVM', 'Google', 'GNU', 'Chromium', 'Mozilla', 'WebKit', 'Microsoft'];

  /** clang-format config (JSON): a preset, your indent size, spaces only, and nothing joined onto one line. */
  function formatConfig(style, indentSize) {
    return JSON.stringify({
      BasedOnStyle: STYLES.includes(style) ? style : 'LLVM',
      IndentWidth: indentSize,
      TabWidth: indentSize,
      UseTab: 'Never',
      // Predictable for learners: LLVM and friends would fold short functions and statements onto one line
      // (`int main() { return 0; }`), which undoes code that was laid out on purpose.
      AllowShortFunctionsOnASingleLine: 'None',
      AllowShortIfStatementsOnASingleLine: 'Never',
      AllowShortLoopsOnASingleLine: false,
      AllowShortBlocksOnASingleLine: 'Never',
      AllowShortCaseLabelsOnASingleLine: false,
      BreakTemplateDeclarations: 'Yes',
    });
  }

  return { STYLES, formatConfig };
});

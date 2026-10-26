# clang-format (WebAssembly)

Unmodified files from the npm package `@wasm-fmt/clang-format` 23.1.1 (MIT, see LICENSE), which is
LLVM's `clang-format` compiled to WebAssembly (clang-format itself: Apache-2.0 with LLVM exceptions, see
LLVM-LICENSE.txt). `public/app.js` loads it on first use ("Format").
`package.json` here only tells Node that these `.js` files are ES modules (the unit tests import them);
browsers ignore it.

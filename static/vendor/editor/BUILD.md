# vessel-editor.bundle.mjs

Self-contained ESM bundle of the collaborative editor stack, so the app runs
fully offline (no runtime CDN/npm). Single shared instances of Yjs and the
CodeMirror packages (esbuild dedupes), which is required or Yjs/CodeMirror break.

Contents (see entry.js): CodeMirror 6 (@codemirror/view, /state, /commands,
/language, /lang-markdown), Yjs, y-codemirror.next (yCollab — real remote
cursors via awareness), y-protocols/awareness.

## Rebuild (build-time only; runtime stays offline)
    npm install codemirror@6 @codemirror/view @codemirror/state @codemirror/commands \
      @codemirror/language @codemirror/lang-markdown yjs@13 y-codemirror.next y-protocols
    npx esbuild entry.js --bundle --format=esm --minify --target=es2020 \
      --outfile=vessel-editor.bundle.mjs

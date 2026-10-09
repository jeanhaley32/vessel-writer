# Third-party notices

The browser code under `static/vendor/` bundles the following libraries,
minified. Each is distributed under the MIT License, reproduced once below;
the copyright lines are theirs.

| Library | Version | Copyright | Where |
|---|---|---|---|
| [marked](https://github.com/markedjs/marked) | 12.0.2 | Copyright (c) 2018+, MarkedJS; Copyright (c) 2011-2018, Christopher Jeffrey | `static/vendor/marked/` |
| [mermaid](https://github.com/mermaid-js/mermaid) | 11.4.1 (bundles dagre-d3-es, d3 and others, all permissively licensed) | Copyright (c) 2014-2024 Knut Sveidqvist | `static/vendor/mermaid/` |
| [CodeMirror 6](https://github.com/codemirror/dev) (`@codemirror/*`, `@lezer/*`) | 6.x | Copyright (C) 2018-2021 by Marijn Haverbeke and others | `static/vendor/editor/` |
| [Yjs](https://github.com/yjs/yjs) and [lib0](https://github.com/dmonad/lib0) | 13.x | Copyright (c) 2014 Kevin Jahns | `static/vendor/editor/` |
| [y-codemirror.next](https://github.com/yjs/y-codemirror.next) | latest at build | Copyright (c) 2021 Kevin Jahns | `static/vendor/editor/` |
| [y-protocols](https://github.com/yjs/y-protocols) | latest at build | Copyright (c) 2019 Kevin Jahns | `static/vendor/editor/` |

`static/vendor/editor/BUILD.md` records how the editor bundle is rebuilt.

The Go MCP adapter depends on
[modelcontextprotocol/go-sdk](https://github.com/modelcontextprotocol/go-sdk)
(MIT) and its dependencies, fetched by the Go toolchain rather than vendored;
see `go.mod`. The Python backend's dependencies are in `requirements.txt` and
are installed, not vendored.

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

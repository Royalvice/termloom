# Third-party notices

TermLoom source code is licensed under the [MIT License](LICENSE). The compiled release
contains the Bun runtime, OpenTUI native code, `bun-pty`, JavaScript production dependencies,
and the Rust `termloom-render` helper. Their license texts and notices are preserved in
[`THIRD_PARTY_LICENSES.txt`](THIRD_PARTY_LICENSES.txt).

The inventory is generated from `package.json` and the installed production dependency graph
with Bun 1.3.14:

```bash
bun install --frozen-lockfile
bun run licenses
bun run licenses:check
```

The generator traverses direct, transitive, installed optional, and installed peer
dependencies. It always includes the OpenTUI native packages for the v0.3.0
`darwin-arm64`, `darwin-x64`, and `linux-x64` build/test targets, regardless of the host
running the generator. Development-only dependencies are excluded. The current inventory has
165 package records in addition to Bun's own runtime and linked-library notice.

Four published packages do not ship a discoverable top-level license file. Reproducible
overrides are checked into [`licenses/overrides`](licenses/overrides):

- `@xterm/headless@6.0.0`: license from the official xterm.js `6.0.0` tag.
- `emoji-regex@10.6.0`: `LICENSE-MIT.txt` from the official `v10.6.0` tag.
- `remark-math@6.0.0`: license from the official remark-math repository.
- `@mathjax/mathjax-newcm-font@4.1.3`: the npm package declares Apache-2.0 but omits the
  text; the generator uses the Apache-2.0 license shipped by `@mathjax/src@4.1.3` from the
  same MathJax release.

[`licenses/BUN_LICENSE.md`](licenses/BUN_LICENSE.md) is the Bun 1.3.14 distribution notice
used by the release compiler. It describes JavaScriptCore/WebKit and Bun's other embedded
components and provides the corresponding source and relinking instructions.

OpenSSH, tmux, rclone, FFmpeg/ffprobe, mpv, and resvg are invoked as separate executables.
TermLoom does not copy or redistribute them in its release archive; their licenses remain
with their respective upstream distributions.

The retained native Markdown tile experiment links the MIT-licensed `mlux` 2.4.0 crate and its
Typst/MiTeX dependency graph. The native LaTeX cell helper uses a checked-in, local fork of the
MIT/Apache-2.0 `term-maths` 1.0.0 crate under [`native/term-maths`](native/term-maths). The fork
keeps the upstream character-cell layout and only carries TermLoom's native-math corrections:
math-italic variables, stacked simultaneous scripts, connected radical vincula, and operator
spacing. It also links the MIT-licensed `pulldown-latex` 0.7.1 parser and the MIT-licensed
`unicode-width` 0.2.2 cell-width utility. Cargo records the exact dependency sources in
[`native/termloom-render/Cargo.lock`](native/termloom-render/Cargo.lock) and
[`native/termloom-math/Cargo.lock`](native/termloom-math/Cargo.lock); the public release gate must
include a corresponding Rust license inventory alongside both compiled helpers.

This file is an engineering record, not legal advice. If a generated license file or
package declaration is incomplete, please report it through a GitHub issue or security
advisory as appropriate.

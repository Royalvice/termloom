# Contributing to TermLoom

Thank you for improving TermLoom. The project is intentionally narrow: it is an OpenTUI
process that runs inside an existing terminal. It does not bundle a terminal emulator or
reimplement SSH, SFTP, tmux, VT parsing, Markdown parsing, or media codecs.

## Before opening a change

- Search existing issues and discussions.
- For a user-visible feature or architecture change, open an issue before investing in a
  large implementation.
- Keep credentials, private SSH aliases, remote paths, tokens, and personal diagnostic
  output out of commits and fixtures.
- Never add Finder, Quick Look, a browser, or a GUI media player as a silent fallback.
- Do not add `.agent-os/`; it is a private local project-state directory and is deliberately
  ignored.

## Development environment

TermLoom uses Bun 1.3.14 and exact dependency versions. Install the external tools checked
by `termloom doctor`: OpenSSH, tmux, rclone, FFmpeg/ffprobe, mpv, and resvg. The integration
suite also starts an isolated user-level `sshd` and exercises Vim, less, htop, tmux, SFTP,
and media processes.

```bash
git clone https://github.com/Royalvice/termloom.git
cd termloom
bun install --frozen-lockfile
bun run check
bun run build
bun run verify:build
```

The test suite must not use a contributor's real SSH hosts, keys, tmux server, or remote
files. Use the isolated fixtures under `tests/helpers` and temporary directories.

## Architecture boundaries

- OpenTUI owns layout, focus, input routing, state presentation, and custom drawing.
- `bun-pty` owns the PTY; `@xterm/headless` owns VT/ANSI state.
- System OpenSSH owns SSH configuration and authentication. Resolve aliases with `ssh -G`.
- Remote system tmux owns durable sessions.
- rclone owns SFTP operations and reuses the OpenSSH ControlMaster.
- FFmpeg/ffprobe decode frames and metadata; resvg rasterizes SVG; MathJax renders formulas.
- mpv may run only with video and window creation disabled, as an audio/clock backend.
- Missing capabilities are explicit errors. Do not invent a text-only media substitute and
  call it success.

See [Architecture](docs/architecture.md) for the full dependency and ownership model.

## Quality gates

Run these before opening a pull request:

```bash
bun run check
bun run build
bun run verify:build
git diff --check
```

When production dependencies change, regenerate and inspect the complete license bundle:

```bash
bun run licenses
bun run licenses:check
```

Changes to terminal rendering need focused unit coverage plus a real-terminal result where
the behavior cannot be represented by the mock renderer. Do not weaken teardown assertions:
every OpenTUI renderer and FFmpeg/mpv/PTY subprocess must be closed on success, error, and
cancellation paths.

## Code and commits

- Use TypeScript strict mode and the existing Biome configuration.
- Keep user-facing output in English and route TUI strings through the bilingual catalog.
- Spawn external commands with argument arrays; do not interpolate user input through a
  shell.
- Preserve structured errors, timeouts, cancellation, and diagnostic redaction.
- Prefer small, reviewable commits in imperative style, such as `fix: preserve media
  placement`.

## Pull requests

A pull request should explain the user-visible result, architecture impact, tests run, and
remaining limitations. Include terminal name/version and capability evidence for rendering
changes. Screenshots are useful, but structured test evidence is still required.

By contributing, you agree that your contribution is licensed under the repository's MIT
License and that you will follow the [Code of Conduct](CODE_OF_CONDUCT.md).

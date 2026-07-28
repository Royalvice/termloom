# TermLoom

[简体中文](README.CN.md)

[![CI](https://github.com/Royalvice/termloom/actions/workflows/ci.yml/badge.svg)](https://github.com/Royalvice/termloom/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Royalvice/termloom)](https://github.com/Royalvice/termloom/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

TermLoom is a lightweight remote workspace that runs inside the terminal you already use.
OpenTUI provides the sidebar, tabs, recursive splits, focus, settings, and drawing surfaces;
system OpenSSH, remote tmux, rclone SFTP, FFmpeg, mpv, resvg, MathJax, and mature parsers do
the protocol and media work.

It is not a terminal emulator, a Ghostty plugin, or a macOS GUI application. It runs in
Ghostty, Kitty, WezTerm, iTerm2, and other capable terminals without opening Finder, Quick
Look, a browser, or a media-player window.

## What works

- Use existing OpenSSH aliases, `Include`, ProxyJump/ProxyCommand, agents, certificates, and
  known-host behavior. Authentication and host-key prompts stay visible in an embedded pane.
- List, create, rename, kill, and attach remote tmux sessions from the OpenTUI sidebar.
- Reattach a tmux pane after SSH loss with bounded exponential backoff, and restore tabs,
  splits, paths, focus, host, and session intent after restarting TermLoom.
- Browse and search remote files; create, rename, copy, move, upload, download, and delete with
  explicit conflict handling, progress, and cancellation.
- Render read-only GFM Markdown, tables, code, safe HTML, inline/block TeX, PNG, JPEG, WebP,
  SVG, animated GIF, and MP4 in an OpenTUI-managed pane.
- Play GIF and MP4 with play/pause, seek, volume, mute, progress, and pane-native fullscreen.
  FFmpeg produces frames; windowless mpv provides audio and the playback clock only when a
  video has an audio track.
- Use English or Simplified Chinese UI, a configurable leader key, tabs, and recursively
  nested horizontal/vertical splits.
- Diagnose dependencies, SSH aliases, terminal capabilities, config/state schemas, paths,
  permissions, and accidental credential-like content with a versioned `termloom doctor`
  report.

## Reused components

TermLoom deliberately does not reinvent these systems:

| Concern | Implementation |
| --- | --- |
| TUI layout, input, state, rendering lifecycle | OpenTUI Core and OpenTUI keymap |
| PTY and VT/ANSI state | `bun-pty` and `@xterm/headless` |
| SSH configuration and authentication | System OpenSSH and per-host ControlMaster |
| Durable remote sessions | Remote system tmux |
| SFTP operations | rclone `:sftp:` with `--sftp-ssh` over the authenticated ControlMaster |
| Markdown and safe HTML | unified, remark, rehype |
| Formula rendering | MathJax SVG followed by resvg |
| Image/GIF/video frames | FFmpeg and ffprobe |
| Video audio and clock | mpv JSON IPC with video/window output disabled |
| Terminal media | Kitty Unicode placement, iTerm2 inline images, or truecolor half-block cells |

See [Architecture](docs/architecture.md) for ownership and lifecycle details.

## Requirements

The v0.1.0 binary release target is macOS arm64. Building from source and CI also cover Linux
x64. Windows is not supported by this release.

TermLoom expects these programs on `PATH`:

- `ssh`
- `tmux` on each remote host used for sessions, and locally for the real integration suite
- `rclone`
- `ffmpeg` and `ffprobe`
- `mpv`
- `resvg`

On macOS, OpenSSH is provided by the operating system. The remaining runtime dependencies can
be installed with Homebrew:

```bash
brew install tmux rclone ffmpeg mpv resvg
```

The release archive does not bundle or automatically install those tools. The rclone build
must expose `--sftp-ssh`; doctor checks this because TermLoom deliberately reuses the
authenticated system OpenSSH ControlMaster. Run the doctor before starting the TUI:

```bash
termloom doctor
termloom doctor --json
```

`doctor --no-terminal-probe` is intended for CI or other non-interactive checks. A real media
adapter can only be confirmed from a real TTY capability probe.

## Install

### macOS arm64 release

Download the archive and checksum from the matching GitHub Release, then verify before
installing:

```bash
shasum -a 256 -c termloom-v0.1.0-darwin-arm64.tar.gz.sha256
tar -xzf termloom-v0.1.0-darwin-arm64.tar.gz
install -d "$HOME/.local/bin"
install -m 0755 termloom-v0.1.0-darwin-arm64/termloom "$HOME/.local/bin/termloom"
```

The v0.1.0 binary is ad-hoc signed and **not notarized**. If macOS quarantines the downloaded
binary, first verify its SHA-256 checksum and GitHub release provenance. Then, if you trust the
artifact, remove quarantine from that exact file:

```bash
xattr -d com.apple.quarantine "$HOME/.local/bin/termloom"
```

Do not disable Gatekeeper globally.

### Build from source

Bun 1.3.14 is the pinned development and compilation runtime:

```bash
git clone https://github.com/Royalvice/termloom.git
cd termloom
bun install --frozen-lockfile
bun run check
bun run start
```

Compile a native executable for the current platform with:

```bash
bun run build
bun run verify:build
```

The package is marked `private` intentionally. TermLoom is distributed as source and GitHub
Release binaries, not as an npm package.

## Quick start

First make sure the target already works as an OpenSSH alias:

```sshconfig
Host lab
  HostName server.example.com
  User alice
  IdentityFile ~/.ssh/id_ed25519
```

```bash
ssh -G lab >/dev/null
ssh lab
```

Start TermLoom:

```bash
termloom doctor
termloom
```

In the Hosts sidebar, press `n` and enter a local host ID, the OpenSSH alias (`lab` in the
example), an optional label, default remote path, and optional default tmux session. Press
`Enter` on the host to open an embedded SSH pane. Complete any host-key, passphrase, password,
or 2FA prompts there; TermLoom does not store them.

After the SSH connection establishes its ControlMaster:

- choose Sessions and press `n` to create a tmux session, then `Enter` to attach it; or
- choose Files and press `Enter` to open the default path.

SFTP intentionally fails with an explicit error until that host has an authenticated
ControlMaster. This keeps rclone on the same OpenSSH trust and authentication path instead of
building a second credential store.

## Keyboard model

The default leader is `Ctrl+Space`. It is configurable as `ui.leader`. Leader bindings are
handled by OpenTUI; unhandled input in terminal panes is encoded and sent to the embedded PTY.

| Keys | Action |
| --- | --- |
| `Ctrl+Q` | Cleanly quit TermLoom |
| `<leader>s` / `<leader>v` | Split active pane horizontally / vertically |
| `<leader>x` | Close active pane when more than one exists |
| `<leader>n` / `<leader>p` | Focus next / previous pane |
| `<leader>a` / `<leader>w` | Add a local-shell tab / close active tab |
| `<leader>.` / `<leader>,` | Next / previous tab |
| `<leader>]` / `<leader>[` | Grow / shrink the nearest split by 5% |
| `<leader>e` | Exchange active pane with the next pane |
| `<leader>b` | Toggle sidebar |
| `<leader>1` / `2` / `3` | Focus Hosts / Sessions / Files sidebar |
| `<leader>g` / `<leader>t` | Open Settings / Transfers |
| `<leader><leader>` | Send a literal `Ctrl+Space` to the active terminal pane |

Each focused sidebar, file, document, settings, and transfer view shows its local bindings in
the footer. The complete reference is in [Configuration and key bindings](docs/configuration.md).

## Terminal media behavior

TermLoom selects an explicit adapter from live OpenTUI capabilities. It does not claim that
every terminal produces the same pixel density.

| Environment | Selected adapter | Protocol | Current v0.1.0 evidence |
| --- | --- | --- | --- |
| Ghostty 1.3.1, direct | `truecolor-cells` | Truecolor half-block cells | Direct structured probe and screenshot passed |
| Kitty 0.48.1, direct | `kitty` | Kitty graphics + Unicode placement | Direct structured probe and screenshot passed |
| WezTerm 20240203, direct | `iterm2` | iTerm2 inline image | Direct structured probe and screenshot passed |
| iTerm2 3.6.11, direct | `iterm2` | iTerm2 inline image | Direct structured probe and screenshot passed |
| Inside tmux 3.7b | `truecolor-cells` | Truecolor half-block cells | Ghostty, Kitty, WezTerm, and iTerm2 hosts passed |

Truecolor-cell rendering is real raster content in the OpenTUI framebuffer, not a filename or
text placeholder. Direct Kitty and iTerm2-family protocols preserve more image detail. Inside
tmux, v0.1.0 intentionally selects the portable truecolor-cell adapter rather than depending
on graphics passthrough.

The complete matrix, capability rules, and evidence boundary are documented in
[Terminal compatibility](docs/terminal-compatibility.md).

## Verification status

The local release gate currently passes:

- 89 tests, 353 assertions, 3 terminal-size snapshots, 0 failures.
- Biome format/lint and TypeScript strict type checking.
- Real PTY smoke tests for zsh, Vim, less, htop, and tmux.
- Isolated user-level OpenSSH, ControlMaster, remote tmux durability/re-attach, rclone SFTP,
  checksums, transfers, cancellation, and full file operations.
- Real FFmpeg, ffprobe, mpv no-video JSON IPC, resvg, MathJax, animated GIF, and audio-bearing
  MP4 playback with subprocess teardown.
- Native macOS arm64 compile plus `--version`, `--help`, and compiled doctor verification.
- Direct and tmux real-TTY structured probes hosted by Ghostty, Kitty, WezTerm, and iTerm2,
  with current-code visual evidence for all four terminals.

GitHub-hosted Ubuntu 24.04 x64 and macOS 15 x64 both passed the complete workflow for commit
`9a8308c` in [CI run 30329845495](https://github.com/Royalvice/termloom/actions/runs/30329845495),
including native compilation, compiled doctor verification, and artifact upload. See
[Terminal compatibility](docs/terminal-compatibility.md) for the separately dated real-terminal
matrix.

The published [v0.1.0 macOS arm64 assets](https://github.com/Royalvice/termloom/releases/tag/v0.1.0)
were then downloaded again through their unauthenticated public URLs. The archive passed its
published SHA-256, byte-for-byte comparison, clean extraction, ad-hoc code-signature check,
`BUILDINFO.json`, version/help, isolated doctor, and real-PTY OpenTUI enter/leave teardown.

## Persistence and privacy

TermLoom respects XDG overrides and otherwise uses:

| Data | Default path |
| --- | --- |
| Configuration | `~/.config/termloom/config.toml` |
| Workspace state | `~/.local/state/termloom/workspaces.json` |
| Resource and SSH-control cache | `~/.cache/termloom/` |
| Diagnostic log directory | `~/.local/state/termloom/logs/` |

Configuration and state have strict versioned schemas and atomic writes. Invalid files are
reported and preserved; TermLoom does not silently reset them. Passwords, private keys,
passphrases, OTPs, and tokens are not configuration fields.

Remote Markdown HTTP(S) resources are blocked before the first request to an origin. Press
`o` to allow the current origin once or `P` to persist the domain in configuration.

## Documentation

- [Architecture](docs/architecture.md)
- [Configuration and key bindings](docs/configuration.md)
- [Terminal compatibility](docs/terminal-compatibility.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Release process](docs/releasing.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Scope boundaries

v0.1.0 intentionally does not provide a remote text editor, terminal emulator, SSH/SFTP
protocol implementation, tmux replacement, media codec, automatic system-package installer,
GUI fallback, npm package, Windows build, Developer ID signature, or Apple notarization.

## License

TermLoom is released under the [MIT License](LICENSE). Compiled-distribution notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the generated
[THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt).

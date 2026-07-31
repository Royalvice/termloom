# TermLoom

[简体中文](README.CN.md)

[![CI](https://github.com/Royalvice/termloom/actions/workflows/ci.yml/badge.svg)](https://github.com/Royalvice/termloom/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Royalvice/termloom)](https://github.com/Royalvice/termloom/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

TermLoom is a lightweight local and remote file workspace that runs inside the terminal you
already use. It starts as a mouse-friendly file browser, keeps terminal sessions available on
demand, and renders Markdown, images, GIFs, video, and formulas without opening another app.

TermLoom is not a terminal emulator, a Ghostty plugin, or a macOS GUI application. OpenTUI owns
the layout, input, mouse handling, and drawing surfaces. System OpenSSH, remote tmux, rclone
SFTP, FFmpeg, mpv, resvg, MathJax, and established parsers continue to do the protocol and media
work.

## What works in v0.2.0

- Start on the permanently available **Local** endpoint and open `$HOME` without SSH, rclone,
  or tmux. Literal aliases from `~/.ssh/config` and recursive `Include` files appear below it.
- Click a remote Host to open Files/SFTP only. TermLoom does not list tmux sessions or create a
  remote shell merely because a Host was selected.
- Press `F2` or click **Terminal** on a remote Host to choose explicitly between **Direct SSH**
  and **Tmux**. Session discovery begins only after choosing Tmux.
- Keep independent Files and Terminal surfaces alive for each Local/SSH target. The header shows
  one active workspace context with previous/next navigation instead of an undifferentiated row
  of Host tabs; switching context, surface, or split does not destroy hidden state.
- Read endpoint state without guessing from color: every Local/SSH row combines a type badge,
  status shape, status word (`LOCAL`, `IDLE`, `READY`, `AUTH`, `RETRY`, or `ERROR`), and a strong
  selected-row background.
- Browse with a Termius-style adaptive layout:
  - 84 columns and wider: parent directory, current directory, and preview.
  - 48–83 columns: current directory and preview.
  - narrower than 48 columns: current directory only; open a preview and press `Escape` to return.
- See directories, text, images, video, archives, source/config files, executables, and unknown
  files with distinct one-cell symbols and colors. Entries are directory-first and naturally
  sorted, and the selected row uses a high-contrast background rather than color alone.
- Single-click a file to select and preview it after a short debounce; double-click a directory
  to enter it. Directory previews summarize their children.
- Use the compact `← Up` control in the Files path bar to return to the parent directory. It is
  disabled at the Local or SFTP root.
- Create files/folders, rename, copy, move, upload, download, search, refresh, and cancel transfers
  through right-click menus, focused keyboard commands, or `F1` Help & Commands.
- Deliberately provide **no file deletion command** for either Local or SFTP files. Overwrite is
  available only as an explicit conflict policy for copy/move/rename/transfer operations.
- Render read-only GFM Markdown, tables, safe HTML, inline/block TeX, PNG, JPEG, WebP, SVG,
  animated GIF, and MP4. Local Markdown resolves local relative media directly; remote Markdown
  resolves relative resources through SFTP.
- Play GIF and MP4 with play/pause, seek, volume, mute, progress, and pane-native fullscreen.
  FFmpeg produces frames; windowless mpv supplies audio and the playback clock only when needed.
- Use embedded system-SSH authentication for host-key, passphrase, password, and 2FA prompts.
  Files, Direct SSH, and Tmux share one per-Host ControlMaster and never create a second
  credential store.
- Restore the last target, path, selection, preview, active Files/Terminal surface, tabs, splits,
  focus, and attached terminal intent from workspace schema v3.

## Reused components

| Concern | Implementation |
| --- | --- |
| TUI layout, input, mouse, and rendering lifecycle | OpenTUI Core and OpenTUI keymap |
| PTY and VT/ANSI state | `bun-pty` and `@xterm/headless` |
| SSH configuration and authentication | System OpenSSH and per-Host ControlMaster |
| SSH Config discovery | `ssh-config`, Bun globbing, and `ssh -G` as final truth |
| Durable remote sessions | Remote system tmux, loaded only when requested |
| Local files | Node/Bun `fs/promises` through `LocalFileProvider` |
| Remote files | rclone `:sftp:` with `--sftp-ssh` over the shared ControlMaster |
| Markdown and safe HTML | unified, remark, and rehype |
| Formula rendering | MathJax SVG followed by resvg |
| Image/GIF/video frames | FFmpeg and ffprobe |
| Video audio and clock | mpv JSON IPC with video/window output disabled |
| Terminal media | Kitty Unicode placement, iTerm2 inline images, or truecolor half-block cells |

See [Architecture](docs/architecture.md) for ownership and lifecycle details.

## Requirements

The v0.2.0 binary release target is macOS arm64. Source builds and CI also cover Linux x64 and
macOS x64. Windows is not supported.

Local file browsing and local text/Markdown/media previews work without SSH, tmux, or rclone.
Features are enabled by these external programs:

| Program | Required for |
| --- | --- |
| `ssh` | Remote authentication, Direct SSH, Tmux, and SFTP transport |
| `rclone` with `--sftp-ssh` | Remote file browsing and transfer |
| `tmux` on the remote Host | The explicitly selected persistent-session path |
| `ffmpeg` and `ffprobe` | Image/GIF/video decoding and metadata |
| `mpv` | Audio and playback clock for audio-bearing video |
| `resvg` | SVG and MathJax rasterization |

On macOS:

```bash
brew install tmux rclone ffmpeg mpv resvg
```

The archive does not bundle or install these tools. Check the active environment before opening
the TUI:

```bash
termloom doctor
termloom doctor --json
```

`doctor --no-terminal-probe` is intended for CI and other non-interactive checks. It cannot
confirm a live terminal media protocol.

## Install

### macOS arm64 release

Download both v0.2.0 assets from the matching GitHub Release:

```bash
shasum -a 256 -c termloom-v0.2.0-darwin-arm64.tar.gz.sha256
tar -xzf termloom-v0.2.0-darwin-arm64.tar.gz
install -d "$HOME/.local/bin"
install -m 0755 termloom-v0.2.0-darwin-arm64/termloom "$HOME/.local/bin/termloom"
```

The binary is ad-hoc signed and **not notarized**. If macOS quarantines a download, verify the
checksum and GitHub Release provenance first. If you trust that exact artifact:

```bash
xattr -d com.apple.quarantine "$HOME/.local/bin/termloom"
```

Do not disable Gatekeeper globally.

### Build from source

Bun 1.3.14 is pinned for development and compilation:

```bash
git clone https://github.com/Royalvice/termloom.git
cd termloom
bun install --frozen-lockfile
bun run check
bun run start
```

Build and verify a native executable for the current platform:

```bash
bun run build
bun run verify:build
```

The package is private intentionally. TermLoom is distributed as source and GitHub Release
binaries, not as an npm package.

## First journey

Run `termloom`. With no valid saved workspace, TermLoom selects **Local** and opens `$HOME`.
No SSH or tmux command is executed.

For a remote Host:

1. Configure a working OpenSSH alias. TermLoom enumerates literal `Host` aliases and recursively
   follows `Include`; wildcard-only targets can be added through the sidebar `+` button.
2. Click the Host. Complete any embedded host-key, passphrase, password, or 2FA prompt. Only
   Files/SFTP opens.
3. Single-click a file to preview it, double-click a directory to enter it, and right-click the
   selected row or blank directory area for contextual actions. Use `← Up` in the path bar to
   return to the parent directory.
4. Press `F2` when a terminal is needed. Choose **Direct SSH** for a normal shell or **Tmux** to
   discover/create/attach persistent sessions.
5. Press `F2` again to return to Files. The terminal backend remains alive while hidden.

TermLoom refreshes only the active remote Files workspace and any Tmux picker that the user
already opened. A healthy shared ControlMaster is reused silently, avoiding repeated connection
state broadcasts and refresh loops.

## Mouse and keyboard

All common paths are clickable. Single-click selects/focuses, double-click activates, right-click
opens a viewport-bounded context menu, the wheel scrolls the hovered surface, and sidebar/split
dividers can be dragged. A context menu closes on `Escape`, outside click, a second right-click,
item activation, target/surface/tab change, resize, renderer blur, or replacement by another
overlay.

In a terminal pane, hold `Ctrl` and left-click a trusted absolute POSIX path (or a `file:///` URI)
to open that path in the **same Local/SSH target's** Files surface. A file opens its parent
directory and is selected for preview; a directory opens directly. A trailing `:line` or
`:line:column` is accepted. Relative paths are deliberately not guessed, and ordinary terminal
mouse input is still passed through to shell, tmux, Vim, and other terminal programs.

The only permanent footer hint is `F1 Help`; the rest is searchable in Help & Commands.

| Keys | Action |
| --- | --- |
| `F1` | Open searchable Help & Commands |
| `F2` | Switch the active target between Files and Terminal |
| `Ctrl+Q` | Flush workspace state and quit |
| `Ctrl+G` | Default advanced-command leader |
| `Ctrl+G Ctrl+G` | Send literal Ctrl+G/BEL to the terminal |
| `Ctrl+G F2` | Send a literal F2 sequence to the terminal |
| `Ctrl+Space` | Pass through unchanged to the focused PTY |

Focused file-browser commands include `j/k` or arrows, `Enter`, `Escape`/Backspace, `r`
refresh, `/` search, `n` new file, `N` new folder, `R` rename, `c` copy, `m` move,
`u` upload, `D` download, `x` cancel the latest transfer, and `[`/`]` paging. Availability
depends on the Local/SFTP provider. There is no file-delete key.

The complete leader map and configuration reference are in
[Configuration and key bindings](docs/configuration.md).

## Terminal media behavior

TermLoom selects an adapter from live OpenTUI capability data. Direct Kitty and iTerm2-family
protocols preserve more image detail; truecolor-cell rendering remains terminal-resident and is
used where direct image placement is unavailable or intentionally avoided inside tmux.

For a direct, positively identified Ghostty or Kitty session, `auto` uses native Kitty graphics
with Unicode placement: source image/video frames are transmitted as rasters, not downsampled to
the character-cell grid. An outer tmux intentionally uses the lower-resolution
`truecolor-cells` fallback because graphics passthrough is not assumed.

| Environment | Expected adapter | Protocol |
| --- | --- | --- |
| Ghostty, direct | `kitty` | Kitty graphics with Unicode placement |
| Kitty, direct | `kitty` | Kitty graphics with Unicode placement |
| WezTerm, direct | `iterm2` | iTerm2 inline image |
| iTerm2, direct | `iterm2` | iTerm2 inline image |
| Inside tmux | `truecolor-cells` | Portable truecolor half-block cells |

Exact dated versions and acceptance evidence are maintained in
[Terminal compatibility](docs/terminal-compatibility.md).

## Verification

The current source gate covers:

- 179 automated tests, 735 assertions, three terminal-size snapshots, and no skipped regression
  assertions in the current lockfile.
- Local provider behavior, no public file-delete capability, adaptive colored browser layout,
  mouse selection, preview debounce/cancellation, and context-menu dismissal paths.
- Recursive SSH Config discovery, embedded authentication, shared ControlMaster, encrypted-key
  and password/2FA fixtures, rclone SFTP, Direct SSH, and explicitly requested tmux operations.
- Config v1→v2 and workspace v1/v2→v3 migration, including Local/`$HOME` defaults and preservation
  of existing remote terminals, splits, focus, and tmux attachments.
- Markdown, PNG/JPEG/WebP/SVG, GIF, MP4, MathJax, FFmpeg/ffprobe, mpv JSON IPC, resvg, transfer
  cancellation, and subprocess teardown.
- Native compile verification plus real PTY journeys both directly and under an outer tmux.

GitHub-hosted Ubuntu x64 and macOS x64 repeat frozen install, formatting, lint, TypeScript,
licenses, complete tests, native compilation, and compiled-binary verification. Release
acceptance additionally requires anonymous clone/download, checksum, BUILDINFO, codesign, real
PTY, Local/SFTP/Direct SSH/explicit Tmux, media, and exact-process cleanup checks.

## Persistence and privacy

| Data | Default path |
| --- | --- |
| Configuration | `~/.config/termloom/config.toml` |
| Workspace state | `~/.local/state/termloom/workspaces.json` |
| Resource and SSH-control cache | `~/.cache/termloom/` |
| Diagnostic log directory | `~/.local/state/termloom/logs/` |

Configuration remains schema v2. Workspace state is schema v3 and uses explicit Local/SSH
targets. Valid legacy documents are validated, backed up with user-only permissions, migrated,
validated again, and atomically written. Invalid files are reported and preserved.

Passwords, private keys, passphrases, OTPs, and tokens are never configuration or workspace
fields. HTTP(S) resources referenced by Markdown are blocked before the first request to an
origin; allow once with `o` or persist an approved bare domain with `P`.

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

v0.2.0 does not provide a text editor, terminal emulator, SSH/SFTP protocol implementation, tmux
replacement, media codec, file deletion UI, automatic package installer, external GUI fallback,
npm package, Windows build, Developer ID signature, or Apple notarization.

## License

TermLoom is released under the [MIT License](LICENSE). Compiled-distribution notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the generated
[THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt).

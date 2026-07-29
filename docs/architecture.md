# Architecture

TermLoom is one Bun/OpenTUI process inside an existing terminal. It owns workspace state,
layout, input routing, capability selection, and presentation; it delegates protocols,
terminal emulation state, and codecs to established tools and libraries.

## System shape

```mermaid
flowchart LR
    User[Existing terminal and keyboard] --> OT[OpenTUI renderer and keymap]
    OT --> Workspace[Host tree, tabs, dual surfaces, recursive splits]
    Workspace --> Catalog[SSH Config Host catalog]
    Catalog --> Resolve[Lazy ssh -G resolution]
    Resolve --> Coordinator[Per-Host connection coordinator]
    Workspace --> Terminal[Terminal pane]
    Workspace --> Files[File pane]
    Workspace --> Preview[Rich preview pane]

    Terminal --> PTY[bun-pty]
    PTY --> Xterm[@xterm/headless VT state]
    PTY --> SSH[System OpenSSH]
    Coordinator --> PTY
    SSH --> Tmux[Remote tmux]

    Files --> Rclone[rclone :sftp:]
    Rclone --> Master[OpenSSH ControlMaster]

    Preview --> Parser[unified + remark + rehype]
    Parser --> Loader[SFTP/HTTP resource loader and cache]
    Loader --> Media[FFmpeg + ffprobe + resvg + MathJax]
    Media --> Adapter[Kitty / iTerm2 / truecolor-cell adapter]
    Media --> MPV[mpv no-video JSON IPC]

    Xterm --> OT
    Adapter --> OT
```

The arrows into OpenTUI are important: PTY cells, status, and media surfaces remain children
of an OpenTUI pane. TermLoom never suspends the TUI and hands the whole physical terminal to
SSH, tmux, or mpv.

## Layers and ownership

### Runtime and UI

`src/runtime/run.ts` is the composition root. It loads strict configuration and workspace
state, performs local SSH Config discovery without connecting, creates services, probes the
live terminal, chooses one media adapter, creates the OpenTUI renderer, and waits for renderer
destruction before flushing workspace writes. OpenSSH resolution is lazy per Host.

`WorkspaceApp` owns:

- the clickable header, unified Host/session tree, tabs, per-Host Files/Terminal surfaces,
  recursive split trees, footer, SSH authentication panel, settings, command palette, and
  transfer overlay;
- the reusable OpenTUI keymap with `Ctrl+G` leader, `F1`, `F2`, literal-key forwarding, and
  clean `Ctrl+Q` renderer shutdown;
- renderer-focus and timer-gap recovery signals that refresh only the active Host;
- reconciliation between persistent pane state and live renderables;
- frame ownership and renderable teardown.

`PaneRegistry` keeps live terminal/file/preview/session-picker renderables attached to exactly
one frame while layouts are rebuilt. Split containers are disposable view structure; pane
renderables and their PTY/media state survive tab and Files/Terminal switches. A hidden
Terminal surface therefore keeps its PTY and scrollback until its pane is explicitly closed.

### Embedded terminals

`bun-pty` creates the real pseudoterminal and owns OS-level process I/O and resize. The
headless xterm library owns VT parsing, screen buffers, alternate-screen state, cursor state,
color attributes, wide cells, bracketed paste, and mouse modes. `TerminalRenderable` only
maps the mature xterm buffer into OpenTUI cells and translates OpenTUI key/mouse/paste events
into the PTY.

This division avoids implementing a second terminal emulator while still keeping the remote
shell or tmux client inside a normal OpenTUI pane.

### Host discovery, OpenSSH, and tmux

`HostCatalog` starts at `~/.ssh/config`. `ssh-config` parses directive structure; Bun globbing
expands recursive `Include`; realpath deduplication prevents cycles. Only positive literal
Host tokens are selectable automatically. Saved metadata supplies labels/defaults/hiding and
manual wildcard-only aliases. A stable alias-derived ID is replaced by an older matching ID
when migrating existing data, so workspace references remain valid.

Discovery is local and non-networked. It watches the root file plus expanded Include files and
directories, then debounces rescans. Each selectable Host is resolved only when restored or
selected, and system `ssh -G` remains the final source of effective OpenSSH behavior.

The configured host `alias` is passed to `ssh -G`; the resulting hostname, user, port, and
identity participate in a hashed per-host ControlPath. Every SSH process continues to use the
original alias, so OpenSSH remains responsible for `Include`, ProxyJump, ProxyCommand, agents,
certificates, identities, host keys, and interactive authentication.

`HostConnectionCoordinator` owns one in-flight task per Host with
`idle/resolving/authenticating/connected/reconnecting/error` state. Files, tmux discovery, and
terminals await the same task, so one connection attempt yields at most one authentication
PTY. Host-key, password, private-key passphrase, and 2FA text travels only between system SSH
and that PTY; it is not copied into app configuration, workspace state, diagnostics, or
snapshots.

Interactive shell and tmux attach processes run under `bun-pty` with `ssh -tt`. Non-interactive
tmux commands run through OpenSSH with `-T` and quoted positional arguments. Session names are
restricted to 1-128 letters, numbers, dots, underscores, or hyphens, and exact tmux targets
use the `=` prefix.

Attaching a session executes remote system tmux as:

```text
tmux new-session -A -s SESSION [-c CWD]
```

`ReconnectSession` treats a zero SSH exit as an intentional detach. A non-zero exit schedules
bounded exponential backoff with jitter and creates a new OpenSSH/tmux PTY. On first data,
the attempt count resets. There is no replacement tmux server in TermLoom: the remote tmux
process is the durability boundary.

After sleep or network loss, OpenSSH server-alive handling eventually produces a non-zero
exit, which enters the same reconnect state machine. Renderer focus also triggers a low-cost
catalog rescan, active-ControlMaster check, active file refresh, and active tmux refresh. A
five-second heartbeat detects a timer gap of at least fifteen seconds so lid-close/resume is
handled even when a focus event is absent. Neither path probes every discovered Host.

### SFTP and transfers

`RcloneSftpService` requires a live, authenticated OpenSSH ControlMaster. It invokes rclone's
connection-string backend with `--config /dev/null` and `--sftp-ssh` pointing at an argument-
quoted OpenSSH command. TermLoom does not give rclone a second password, private key, or host
database.

Directory operations are structured rclone commands. Upload/download operations enter a
two-worker `TransferQueue`, consume JSON progress lines, support `AbortSignal` cancellation,
and expose explicit `error`, `overwrite`, `skip`, and `rename` conflict policies. Deletes
first stat the target and select `deletefile` or `purge`; destructive actions require a TUI
confirmation.

### Documents, resources, and permissions

The parser builds a small internal RichDocument tree from unified/remark/rehype. GFM and math
extensions are enabled. Raw HTML passes through a strict allowlist; scripts, event handlers,
unsafe schemes, embedded credentials, `data:` URLs, and `javascript:` URLs are rejected.

Remote relative and absolute resources resolve against the Markdown file's SFTP path. The
resource loader downloads through `RcloneSftpService` into a versioned cache using metadata-
derived keys and atomic file replacement.

HTTP(S) resources pass through `DomainPermissionGate` before `fetch`. An unknown domain emits
a pane prompt without making a request. The user can grant a runtime-only origin or persist
the hostname in `permissions.allowedHttpDomains`.

### Formulas and media

MathJax direct modules convert inline and block TeX to a specific SVG element. resvg converts
SVG and formula output to raster pixels. FFprobe supplies media metadata; FFmpeg produces
RGB24 still or real-time frames.

`MediaPlaybackController` has two clock paths:

- GIF and silent video use FFmpeg frame timestamps.
- Video with audio starts mpv with `--no-video --force-window=no --audio-display=no` and JSON
  IPC. mpv provides audio, position, pause, seek, volume, and mute; FFmpeg still provides every
  visible frame. Frame-to-clock drift is bounded by the controller.

mpv never owns a visible surface. A pane or fullscreen transition only reparents the OpenTUI
media renderable inside the existing terminal.

### Terminal media adapters

Capability selection waits for OpenTUI's multi-stage capability events. It prefers a
confirmed XTVersion result and otherwise returns the last snapshot after a 1.2-second bounded
wait. A partial `kitty_graphics=false` is not treated as confirmed until terminal identity is
settled.

The three adapters are explicit:

- `kitty`: `kitty-motion` encodes image/animation commands. After each OpenTUI frame, TermLoom
  emits the complete Unicode placeholder grapheme at the real pane coordinates. Invisible
  NBSP sentinels in the framebuffer let OpenTUI dirty rectangles own move, hide, fullscreen,
  and destruction cleanup.
- `iterm2`: emits inline-image escapes after the OpenTUI frame and uses the same framebuffer
  sentinel ownership. It does not maintain an independent raw-space clearing compositor.
- `truecolor-cells`: rasterizes into upper/lower half-block glyphs and RGB foreground/
  background values directly in the OpenTUI framebuffer.

The first two protocols can preserve more pixels, but all three render actual media. A
missing usable adapter is an explicit capability error, never a filename or ASCII placeholder
presented as successful rendering.

## Persistence

Configuration is TOML schema version 2. Workspace state is JSON schema version 2. Each Host tab
stores an active surface plus independent Files and Terminal split trees, pane kind,
host/session/path intent, sidebar, selection, preview scroll, and focus. It does not store
credentials, authentication UI state, terminal input, or live process IDs.

Valid v1 documents are parsed before migration, transformed, validated as v2, and atomically
written with a restrictive one-time `.v1.bak`. The old default `Ctrl+Space` leader becomes
`Ctrl+G`; a user-defined leader remains unchanged. The pristine Local-shell workspace becomes
the Files start page, while custom tabs and split trees remain intact in the matching surface.

All writes use a same-directory temporary file, restrictive permissions, rename, and directory
creation. Parsing is strict. When a persisted file is invalid, startup reports the error and
leaves the file untouched; it does not silently reset user state.

## Process and security rules

- Local external commands use executable-and-argument arrays, not a shell command string.
- Remote commands quote each positional argument after local validation.
- Every subprocess has a bounded timeout, cancellation path, or owned long-running lifecycle.
- Diagnostic text passes through credential-pattern redaction.
- Renderer destruction is the terminal teardown boundary; code does not call `process.exit()`
  while OpenTUI owns terminal modes.
- FFmpeg, mpv, PTY, temporary sockets, and temporary media directories are closed on normal,
  failure, cancellation, and renderable-destruction paths.
- Missing tools and unsupported capabilities stay visible as structured errors.

## Test strategy

The suite deliberately crosses abstraction boundaries:

- unit tests cover schemas, reducers, input encoding, ANSI colors, capability selection,
  parser safety, cache and domain permissions, process redaction, services, and renderables;
- OpenTUI tests use real memory renderers, mock keyboard/mouse, divider drag, narrow toolbar
  scrolling, and stable 80x24, 120x40, and 200x60 snapshots;
- PTY tests run zsh, Vim, less, htop, and tmux through the production
  `bun-pty → @xterm/headless → TerminalRenderable` path;
- integration fixtures start an isolated user-level sshd with temporary plain/encrypted keys,
  known_hosts, ControlPath, and tmux socket; a separate fake-OpenSSH PTY sequence exercises
  password plus verification-code routing without claiming real PAM password authentication;
- SFTP tests invoke real rclone and verify full operations, SHA-256, progress, conflict, and
  cancellation;
- media tests invoke real FFmpeg/ffprobe, resvg, MathJax, and windowless mpv, and verify that
  child PIDs disappear after teardown;
- the terminal matrix runs a real OpenTUI TTY probe and RichDocument fixture inside each
  supported terminal and inside tmux;
- compiled verification checks native file format, CLI identity, and a non-interactive doctor
  report.

See [Terminal compatibility](terminal-compatibility.md) for the current real-terminal evidence
boundary and [Release process](releasing.md) for the gates that turn those results into an
artifact.

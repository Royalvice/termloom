# Architecture

TermLoom is one Bun/OpenTUI process inside an existing terminal. It owns workspace state,
layout, input routing, capability selection, and presentation; it delegates protocols,
terminal emulation state, and codecs to established tools and libraries.

## System shape

```mermaid
flowchart LR
    User[Existing terminal and keyboard] --> OT[OpenTUI renderer and keymap]
    OT --> Workspace[Tabs, recursive splits, sidebar, settings]
    Workspace --> Terminal[Terminal pane]
    Workspace --> Files[File pane]
    Workspace --> Preview[Rich preview pane]

    Terminal --> PTY[bun-pty]
    PTY --> Xterm[@xterm/headless VT state]
    PTY --> SSH[System OpenSSH]
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
state, resolves OpenSSH hosts, creates services, probes the live terminal, chooses one media
adapter, creates the OpenTUI renderer, and waits for renderer destruction before flushing
workspace writes.

`WorkspaceApp` owns:

- the header, tabs, sidebar, recursive split tree, footer, settings overlay, and transfer
  overlay;
- the global leader keymap and clean `Ctrl+Q` renderer shutdown;
- reconciliation between persistent pane state and live renderables;
- frame ownership and renderable teardown.

`PaneRegistry` keeps a live terminal/file/preview renderable attached to exactly one frame
while layouts are rebuilt. Split containers are disposable view structure; the pane
renderables and their PTY/media state survive tab switches and resize operations.

### Embedded terminals

`bun-pty` creates the real pseudoterminal and owns OS-level process I/O and resize. The
headless xterm library owns VT parsing, screen buffers, alternate-screen state, cursor state,
color attributes, wide cells, bracketed paste, and mouse modes. `TerminalRenderable` only
maps the mature xterm buffer into OpenTUI cells and translates OpenTUI key/mouse/paste events
into the PTY.

This division avoids implementing a second terminal emulator while still keeping the remote
shell or tmux client inside a normal OpenTUI pane.

### OpenSSH and tmux

The configured host `alias` is passed to `ssh -G`; the resulting hostname, user, port, and
identity participate in a hashed per-host ControlPath. Every SSH process continues to use the
original alias, so OpenSSH remains responsible for `Include`, ProxyJump, ProxyCommand, agents,
certificates, identities, host keys, and interactive authentication.

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

The application does not need a special macOS sleep event hook. After sleep or network loss,
OpenSSH server-alive handling eventually produces a non-zero exit, which enters the same
reconnect state machine. Physical lid-close timing depends on the operating system and
network; process-loss and application-restart behavior are covered by integration tests.

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

Configuration is TOML schema version 1. Workspace state is JSON schema version 1. The
workspace stores tabs, the recursive split tree, pane kind, host/session/path intent, sidebar,
selection, scroll offset, and focus. It does not store credentials or live process IDs.

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
- OpenTUI tests use real renderers and stable 80x24, 120x40, and 200x60 snapshots;
- PTY tests run zsh, Vim, less, htop, and tmux through the production
  `bun-pty → @xterm/headless → TerminalRenderable` path;
- integration fixtures start an isolated user-level sshd with temporary keys, known_hosts,
  home directory, ControlPath, and tmux socket;
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

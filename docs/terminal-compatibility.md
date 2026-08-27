# Terminal compatibility

TermLoom runs inside an existing terminal and selects media behavior from live OpenTUI
capabilities. File browsing, PTYs, SSH, SFTP, and tmux do not require a pixel-graphics protocol;
rich media requires either a supported image protocol or truecolor cells.

This document distinguishes automated renderer coverage from real direct-terminal and outer-tmux
acceptance. A row is never inferred from a terminal's feature list.

## Adapter selection

`media.adapter = "auto"` follows these rules:

1. Inside tmux, select `truecolor-cells` only after RGB/truecolor is confirmed.
2. In a direct, positively identified Ghostty or Kitty session, select the Kitty adapter. This
   narrowly overrides OpenTUI 0.4.5's known false `kitty_graphics=false` result for Ghostty;
   unidentified terminals do not inherit that exception.
3. In direct WezTerm or iTerm2 with RGB, select the iTerm2 inline-image adapter.
4. In another RGB-capable direct terminal, select `truecolor-cells`.
5. Otherwise fail with `CAPABILITY_UNSUPPORTED`.

OpenTUI may emit multiple capability events while terminal identity settles. TermLoom listens
until XTVersion confirms identity or a bounded 1.2-second settling window ends. Final adapter
selection combines that result with the positive terminal identity; one false Kitty probe no
longer downgrades a known direct Ghostty session to character cells.

Forcing a configured adapter cannot manufacture missing terminal support and never opens an
external GUI fallback.

## Protocol behavior

### Kitty graphics and Unicode placement

`kitty-motion` encodes frames. A Kitty Unicode placement marker is a full grapheme containing
a placeholder base plus row/column combining marks. Because OpenTUI's single-character cell API
cannot preserve the whole marker by itself, TermLoom emits it after each OpenTUI frame at the
pane's real coordinates.

Invisible sentinel cells reserve the same framebuffer region. OpenTUI dirty rectangles then own
movement, hiding, fullscreen transitions, and teardown; a second raw-space compositor cannot
erase a newly rendered TUI frame.

Ghostty 1.3.1 implements Kitty image transmission and Unicode placeholders but not Kitty's
`a=f` animation-frame edit action. TermLoom therefore disables dirty-frame edits for Ghostty and
replaces each complete frame with `a=t`; Kitty keeps the smaller `a=f` update path. Both use the
same OpenTUI-owned placement and teardown lifecycle.

This is a raster protocol path, not a character-cell preview: a direct Ghostty/Kitty image keeps
its decoded frame resolution until the terminal compositor scales it. If the media status instead
shows `truecolor-cells`, TermLoom is deliberately rendering the lower-resolution half-block
fallback (most commonly because it is running inside tmux).

### iTerm2 inline images

WezTerm and iTerm2 use the iTerm2 inline-image escape path. Frames are positioned inside the
OpenTUI-owned pane, and framebuffer sentinels provide the same hide/move/destroy lifecycle.
No external image window is created.

### Truecolor half-block cells

The portable adapter downsamples RGB into the pane's cell grid. Every `▀` uses an upper-pixel
foreground and lower-pixel background. Resolution is lower than direct Kitty/iTerm2 graphics,
but content remains real raster data in the OpenTUI framebuffer and works through tmux when
truecolor is intact.

## v0.3.0 acceptance required before release

Every v0.3.0 real-terminal row must use generated assets, an isolated user-level sshd, SSH
configuration, known-hosts file, rclone SFTP source, an explicit local download destination, and
a dedicated tmux socket. No private Host, path, credential, or document is accepted as evidence.

`ok=true` for v0.3.0 requires all of these behaviors:

- Local starts at the generated home path with zero SSH and zero tmux requests;
- Local and SFTP Files are strictly read-only: browse/search/preview/refresh/navigation work,
  while no source create, rename, copy, move, upload, overwrite, or delete path appears. Copying
  an absolute path is a UI-only clipboard export;
- a mouse-initiated remote file and directory download reaches an editable generated local
  destination without changing the remote snapshot; duplicate names never overwrite, selected
  links fail closed, and nested links are reported as skipped;
- Direct SSH opens without tmux discovery, reconnects after a non-zero exit through the shared
  ControlMaster, and waits for Enter or click after a normal exit;
- choosing Tmux is the only route to session discovery, then its attach and recovery work;
- workspace schema v3 restore, Markdown/media interaction, Files/Terminal keepalive, and all
  renderer, ControlMaster, PTY, media, sshd, fixture, and dedicated tmux cleanup checks pass.

The generated JSON is written after teardown checks. A visually successful run with one owned
resource remaining is `ok=false`. The v0.3.0 matrix must be recorded before its release commit;
the dated v0.2.0 rows below remain historical evidence only.

## Historical v0.2.0 workspace acceptance journey

Every real-terminal row uses generated assets plus an isolated user-level sshd, SSH config,
known-hosts file, rclone SFTP target, and tmux socket. No private Host, path, credential, or
document is accepted as evidence.

`ok=true` requires all of these v0.2.0 behaviors:

- Local is selected first at the generated home path, with zero SSH and zero tmux requests;
- the sidebar shows Local plus two generated literal SSH aliases, without loading sessions;
- mouse-selecting a Host opens only Files and uses one embedded host-key/authentication PTY;
- SFTP listing succeeds and Files plus later Direct SSH/Tmux reuse that same ControlMaster;
- colored adaptive Files layout, click preview, double-click navigation, right-click actions,
  context-menu dismissal, sidebar drag, and split drag work;
- Direct SSH opens without a tmux list request;
- only selecting Tmux performs session discovery, then create/attach/reconnect works;
- F2 hides and restores the terminal without losing its backend;
- workspace schema v3 restores target, path, preview, surface, splits, focus, and terminal intent;
- Local and remote Markdown, PNG, animated GIF, formula, and audio-bearing MP4 render, with media
  play/pause, seek, volume, mute, and pane-native fullscreen;
- renderer, ControlMaster, authentication PTY, FFmpeg, mpv, sshd, inner/outer tmux, fixture, and
  every owned process/socket are gone at teardown.

The generated JSON is written after teardown checks. A visually successful run with one owned
resource remaining is `ok=false`.

## v0.3.0 matrix

The v0.3.0 release-candidate matrix was executed on macOS arm64 on 2026-08-03. Every row ran
the full isolated workspace journey at 80×24: Local zero-network start, embedded SSH
authentication, read-only Local/SFTP Files, explicit no-overwrite remote download, Direct SSH
abnormal-exit recovery, explicit tmux, preview/restart restore, PNG/GIF/MP4/formula media, and
mouse media controls. Each structured report has exit status `0`, `ok=true`, every journey/media
field true, every cleanup field true, and `ownedProcessMatches: 0`. The reports are retained in
the private release ledger rather than in the public repository.

### Direct terminal runs

| Terminal | Version | Environment | Adapter / protocol | Result |
| --- | --- | --- | --- | --- |
| Ghostty | 1.3.1 | `TERM=xterm-ghostty`, `TERM_PROGRAM=ghostty` | `kitty` / `kitty-unicode` | Passed |
| Kitty | 0.48.1 | `TERM=xterm-kitty` | `kitty` / `kitty-unicode` | Passed |
| WezTerm | 20240203-110809-5046fc22 | `TERM=xterm-256color`, `TERM_PROGRAM=WezTerm` | `iterm2` / `iterm2-inline` | Passed |
| iTerm2 | 3.6.11 | `TERM=xterm-256color`, `TERM_PROGRAM=iTerm.app` | `iterm2` / `iterm2-inline` | Passed |

### Outer tmux runs

Every row used its own temporary outer tmux socket and reported `TERM=tmux-256color`,
`TERM_PROGRAM=tmux`. TermLoom selected bounded truecolor cells rather than assuming graphics
passthrough through the multiplexer.

| Host terminal | Adapter / protocol | Result |
| --- | --- | --- |
| Ghostty 1.3.1 | `truecolor-cells` / `truecolor-half-block` | Passed |
| Kitty 0.48.1 | `truecolor-cells` / `truecolor-half-block` | Passed |
| WezTerm 20240203 | `truecolor-cells` / `truecolor-half-block` | Passed |
| iTerm2 3.6.11 | `truecolor-cells` / `truecolor-half-block` | Passed |

## Dated v0.2.0 matrix

The current v0.2.0 matrix was executed on macOS arm64 on 2026-07-29 in Ghostty, Kitty,
WezTerm, and iTerm2, both directly and under a dedicated outer tmux 3.7b socket. All eight
accepted reports have `ok=true`, every journey/media field true, every cleanup field true, and
`ownedProcessMatches: 0`.

The Ghostty direct row below predates the Unreleased native-Kitty policy and therefore records
the old `truecolor-cells` result. It is historical v0.2.0 acceptance evidence only, **not** proof
that a current direct Ghostty candidate has rendered the new high-resolution adapter. That needs
a new direct Ghostty run reporting `kitty / kitty-unicode`.

### Direct terminal runs

| Terminal | Version | Size | Environment | Adapter / protocol | v0.2.0 result |
| --- | --- | --- | --- | --- | --- |
| Ghostty | 1.3.1 | 82×24 | `TERM=xterm-ghostty`, `TERM_PROGRAM=ghostty` | `truecolor-cells` / `truecolor-half-block` | Passed |
| Kitty | 0.48.1 | 100×35 | `TERM=xterm-kitty` | `kitty` / `kitty-unicode` | Passed |
| WezTerm | 20240203-110809-5046fc22 | 80×24 | `TERM=xterm-256color`, `TERM_PROGRAM=WezTerm` | `iterm2` / `iterm2-inline` | Passed |
| iTerm2 | 3.6.11 | 80×25 | `TERM=xterm-256color`, `TERM_PROGRAM=iTerm.app` | `iterm2` / `iterm2-inline` | Passed |

### Outer tmux runs

The expected inner environment is `TERM=tmux-256color`, `TERM_PROGRAM=tmux`, and confirmed
truecolor. TermLoom intentionally selects cells rather than assuming graphics passthrough.

| Host terminal | Expected adapter / protocol | v0.2.0 result |
| --- | --- | --- |
| Ghostty 1.3.1 | `truecolor-cells` / `truecolor-half-block` | Passed at 82×23 |
| Kitty 0.48.1 | `truecolor-cells` / `truecolor-half-block` | Passed at 100×34 |
| WezTerm 20240203 | `truecolor-cells` / `truecolor-half-block` | Passed at 80×23 |
| iTerm2 3.6.11 | `truecolor-cells` / `truecolor-half-block` | Passed at 80×24 |

The harness records the dedicated terminal PID/window identifier where available, outer tmux
client/server/socket, authentication PTY, media children, ControlMaster, and sshd fixture.
Cleanup targets only those recorded resources. Pre-existing terminal processes and unrelated
tmux sessions are never closed.

One Ghostty direct exploration correctly failed with
`The file context menu did not open from a right click`: the probe checked the overlay
immediately after an asynchronously laid-out row click. That `ok=false` report also completed
all cleanup checks. The probe now waits for a non-zero, in-viewport row and then waits
boundedly for the overlay; focused tests and the final Ghostty direct/tmux rows passed. The
failed report remains in the private acceptance ledger and is not counted as a successful row.

## Automated coverage

The normal suite validates:

- capability priority, tmux handling, forced adapters, unsupported errors, multi-event settling,
  and XTVersion provenance;
- Kitty transmit/placement/animation commands, complete placeholder graphemes, framebuffer
  sentinels, movement, hiding, fullscreen, and teardown;
- iTerm2 frame output, coordinate changes, sentinel ownership, hide/destroy behavior;
- truecolor framebuffer rasterization;
- RichDocument PNG, SVG, GIF, formula, video controls, fullscreen reparenting, and disposal;
- real FFmpeg streams, mpv no-video JSON IPC, audio/silent clocks, drift handling, and child
  process termination;
- OpenTUI mouse behavior across 80×24, 120×40, and 200×60 workspace snapshots.

Mock-terminal tests are necessary but not sufficient. The dated eight-row real-terminal matrix
is the release evidence boundary.

## tmux and nested environments

TermLoom does not depend on tmux graphics passthrough in v0.3.0. Use a modern tmux with truecolor
and a valid `tmux-256color` terminfo entry. A common baseline is:

```tmux
set -g default-terminal "tmux-256color"
set -as terminal-features ",xterm-256color:RGB"
```

The exact outer-terminal pattern may differ. Verify from the same client with
`infocmp tmux-256color`, `tmux info`, and `termloom doctor`. Do not set `TERM` manually to
impersonate another terminal.

Nested tmux, GNU screen, SSH hops that filter OSC/graphics, and third-party multiplexers are not
covered by the named matrix. They may receive truecolor cells if the live probe confirms RGB,
but support is not implied.

## Reproducing the workspace probe

Run the harness in the actual target TTY:

```bash
bun run scripts/terminal-workspace-probe.ts \
  --label kitty-direct \
  --mode direct \
  --output /tmp/termloom-workspace-kitty-direct.json \
  --media on \
  --hold-ms 20000
```

For an outer-tmux row, create a dedicated socket/session in that terminal and run the same
command with `--mode tmux`. The optional hold occurs before final teardown.

Never run public compatibility evidence against private Markdown, SSH Hosts, or media. Save the
structured report first, then close only the exact dedicated window/process/socket created for
that row and verify `ownedProcessMatches: 0`.

## Release boundary

A v0.3.0 matrix pass is local real-terminal evidence, not a substitute for hosted CI or release
artifact verification. The release also requires Ubuntu x64 and macOS x64 CI, clean packaging,
ad-hoc codesign, published SHA-256, anonymous download, BUILDINFO/tag equality, clean extraction,
isolated doctor, real PTY, Local/SFTP/Direct SSH/explicit Tmux/media smoke, and installed-binary
hash equality. The distributed binary remains macOS arm64 only, ad-hoc signed, and not notarized.

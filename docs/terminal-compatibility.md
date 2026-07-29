# Terminal compatibility

TermLoom runs inside an existing terminal and selects media behavior from live OpenTUI
capabilities. File browsing, PTYs, SSH, SFTP, and tmux do not require a pixel-graphics protocol;
rich media requires either a supported image protocol or truecolor cells.

This document distinguishes automated renderer coverage from real direct-terminal and outer-tmux
acceptance. A row is never inferred from a terminal's feature list.

## Adapter selection

`media.adapter = "auto"` follows these rules:

1. Inside tmux, select `truecolor-cells` only after RGB/truecolor is confirmed.
2. In direct Kitty, select the Kitty adapter unless a completed XTVersion result explicitly
   rejects Kitty graphics.
3. In direct WezTerm or iTerm2 with RGB, select the iTerm2 inline-image adapter.
4. In another RGB-capable direct terminal, select `truecolor-cells`.
5. Otherwise fail with `CAPABILITY_UNSUPPORTED`.

OpenTUI may emit multiple capability events while terminal identity settles. TermLoom listens
until XTVersion confirms identity or a bounded 1.2-second settling window ends; it does not treat
the first partial `kitty_graphics=false` event as final.

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

### iTerm2 inline images

WezTerm and iTerm2 use the iTerm2 inline-image escape path. Frames are positioned inside the
OpenTUI-owned pane, and framebuffer sentinels provide the same hide/move/destroy lifecycle.
No external image window is created.

### Truecolor half-block cells

The portable adapter downsamples RGB into the pane's cell grid. Every `▀` uses an upper-pixel
foreground and lower-pixel background. Resolution is lower than direct Kitty/iTerm2 graphics,
but content remains real raster data in the OpenTUI framebuffer and works through tmux when
truecolor is intact.

## v0.2.0 workspace acceptance journey

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

## Dated v0.2.0 matrix

The current v0.2.0 matrix was executed on macOS arm64 on 2026-07-29 in Ghostty, Kitty,
WezTerm, and iTerm2, both directly and under a dedicated outer tmux 3.7b socket. All eight
accepted reports have `ok=true`, every journey/media field true, every cleanup field true, and
`ownedProcessMatches: 0`.

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

TermLoom does not depend on tmux graphics passthrough in v0.2.0. Use a modern tmux with truecolor
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

A v0.2.0 matrix pass is local real-terminal evidence, not a substitute for hosted CI or release
artifact verification. The release also requires Ubuntu x64 and macOS x64 CI, clean packaging,
ad-hoc codesign, published SHA-256, anonymous download, BUILDINFO/tag equality, clean extraction,
isolated doctor, real PTY, Local/SFTP/Direct SSH/explicit Tmux/media smoke, and installed-binary
hash equality. The distributed binary remains macOS arm64 only, ad-hoc signed, and not notarized.

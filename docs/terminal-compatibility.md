# Terminal compatibility

TermLoom runs inside an existing terminal and selects media behavior from live OpenTUI
capabilities. Terminal management, embedded PTY, SSH, tmux, and file functions do not require
a pixel graphics protocol, but rich media requires either a supported graphics protocol or
truecolor cells.

This document separates automated coverage, real-terminal direct coverage, and coverage
inside tmux. An untested row is never inferred from a terminal's marketing claim.

## Adapter selection

The `auto` selector uses these rules:

1. If the process is inside tmux, select `truecolor-cells` only when RGB/truecolor is confirmed.
2. For a direct Kitty terminal with confirmed or still-settling Kitty identity, select the
   Kitty adapter unless a completed XTVersion result explicitly says Kitty graphics is false.
3. For direct WezTerm or iTerm2 with RGB capability, select the iTerm2 inline-image adapter.
4. For any other RGB-capable terminal, select `truecolor-cells`.
5. If none applies, fail with `CAPABILITY_UNSUPPORTED`.

OpenTUI can emit several capability events during startup. TermLoom keeps listening until it
receives a terminal identity confirmed by XTVersion, or until a bounded 1.2-second settling
window expires. The first partial `kitty_graphics=false` is not accepted as a final negative.

`media.adapter` can request a specific adapter, but configuration cannot manufacture a missing
terminal capability. `auto` is the supported default.

## Protocol behavior

### Kitty graphics and Unicode placement

`kitty-motion` encodes image and animation payloads. Kitty's Unicode placement marker is a
full grapheme: a base placeholder code point plus row and column combining marks. OpenTUI's
single-cell character API cannot preserve those combining marks by itself, so TermLoom emits
the complete marker after each OpenTUI frame at the pane's real coordinates.

Invisible NBSP sentinel cells occupy the same region in the framebuffer. OpenTUI's dirty-rect
diff then owns movement, hiding, fullscreen transitions, and destruction. This avoids an
independent raw-space compositor that could erase a freshly rendered TUI frame.

### iTerm2 inline images

WezTerm and iTerm2 use the iTerm2 inline-image escape path. Each frame is positioned in the
OpenTUI-owned pane region, with framebuffer sentinels providing the same cleanup lifecycle.
No external image window is created.

### Truecolor half-block cells

The fallback adapter downsamples an RGB frame to the pane's cell grid. Each `▀` cell carries
an upper-pixel foreground color and a lower-pixel background color. This has lower spatial
resolution than Kitty/iTerm2 graphics but remains real raster content in the normal OpenTUI
framebuffer and works through tmux when truecolor is intact.

## Dated workspace journey matrix

The current matrix was run on macOS arm64 on 2026-07-29. It exercises the complete TermLoom
workspace rather than a media-only showcase. Every run uses generated files and an isolated
user-level sshd, SSH config, known-hosts file, rclone SFTP target, and tmux socket. No private
SSH alias, address, username, path, credential, or document is used as evidence.

Each structured run requires all of the following before `ok=true`:

- the initial Files start page and two locally discovered literal SSH aliases, with zero network
  connections to an unselected Host;
- mouse Host selection, an embedded real OpenSSH host-key prompt, and exactly one shared
  authentication PTY for Files and tmux discovery;
- SFTP listing, mouse-created remote file, right-click context menu, automatic tmux discovery,
  and mouse double-click attach;
- F2 Files/Terminal switching while the hidden tmux terminal continues running;
- mouse Markdown open/scroll, recursive split drag, sidebar drag, and Settings close;
- config/workspace v2 persistence, application-process restart restore, renderer-focus/timer-gap
  refresh, and no second authentication PTY after restart;
- remote Markdown, PNG, animated GIF, formula, audio-bearing MP4, play/pause, seek, volume,
  mute, and pane-native fullscreen, including horizontally scrollable controls at narrow widths;
- renderer, ControlMaster, authentication PTY, FFmpeg, mpv, sshd, inner tmux, and owned-process
  teardown with zero remaining matches.

### Direct terminal runs

| Terminal | Version | Size | Environment | Adapter / protocol | Result |
| --- | --- | --- | --- | --- | --- |
| Kitty | 0.48.1 | 100×35 | `TERM=xterm-kitty` | `kitty` / `kitty-unicode` | Passed |
| WezTerm | 20240203-110809-5046fc22 | 80×24 | `TERM=xterm-256color`, `TERM_PROGRAM=WezTerm` | `iterm2` / `iterm2-inline` | Passed |
| iTerm2 | 3.6.11 | 80×25 | `TERM=xterm-256color`, `TERM_PROGRAM=iTerm.app` | `iterm2` / `iterm2-inline` | Passed |
| Ghostty | 1.3.1 | 82×24 | `TERM=xterm-ghostty` | `truecolor-cells` / `truecolor-half-block` | Passed |

### Outer tmux runs

Inside tmux, all four hosts reported `TERM=tmux-256color`, `TERM_PROGRAM=tmux`, tmux 3.7b,
and truecolor. TermLoom deliberately selected the portable cell adapter instead of assuming
that Kitty or iTerm2 graphics passthrough was available.

| Host terminal | Size | Adapter / protocol | Result |
| --- | --- | --- | --- |
| Kitty 0.48.1 | 100×34 | `truecolor-cells` / `truecolor-half-block` | Passed |
| WezTerm 20240203 | 80×23 | `truecolor-cells` / `truecolor-half-block` | Passed |
| iTerm2 3.6.11 | 80×24 | `truecolor-cells` / `truecolor-half-block` | Passed |
| Ghostty 1.3.1 | 82×23 | `truecolor-cells` / `truecolor-half-block` | Passed |

The harness records the dedicated terminal process, window identifiers where the host exposes
them, outer tmux client/server/socket, authentication PTY, media children, and sshd fixture.
Cleanup targets only those recorded resources. Ghostty's pre-existing application process and
unrelated terminal/tmux sessions were not closed. Failed exploratory runs remain in the private
acceptance ledger and are not counted as passed rows.

## Automated coverage

The normal test suite validates:

- capability priority, tmux behavior, forced adapters, and unsupported-capability errors;
- multi-event capability settling and XTVersion provenance;
- Kitty transmit (`a=T`), Unicode placement (`U=1`), animation edits (`a=f`), full placeholder
  graphemes, framebuffer sentinels, and hidden-region removal;
- iTerm2 frame output, coordinate changes, sentinel ownership, and hide/destroy behavior;
- truecolor framebuffer rasterization;
- RichDocument PNG, SVG, GIF, formula, video controls, fullscreen reparenting, and disposal;
- real FFmpeg frame streams, mpv no-video flags and JSON IPC, audio/silent clocks, drift, and
  child-process termination.

Mock-terminal tests are necessary but not sufficient for protocol compatibility. The dated
real-terminal matrix is the release evidence boundary.

## tmux and nested environments

TermLoom does not enable or depend on tmux graphics passthrough in v0.1.0. Configure a modern
tmux with truecolor and a valid `tmux-256color` terminfo entry. A common tmux baseline is:

```tmux
set -g default-terminal "tmux-256color"
set -as terminal-features ",xterm-256color:RGB"
```

The exact outer terminal pattern may differ. Verify with `infocmp tmux-256color`, `tmux info`,
and `termloom doctor` inside the same tmux client. Do not set `TERM` manually to impersonate
another terminal.

Nested tmux, screen, remote SSH hops that filter OSC/graphics, and third-party terminal
multiplexers are not part of the v0.1.0 matrix. They may still use truecolor cells if a live
probe confirms RGB, but they are not implied by the four named terminal rows.

## Reproducing a structured probe

The development harness must run in the actual target TTY:

```bash
bun run scripts/terminal-workspace-probe.ts \
  --label kitty-direct \
  --mode direct \
  --output /tmp/termloom-workspace-kitty-direct.json \
  --media on \
  --hold-ms 20000
```

For a tmux path, start an isolated socket/session from the target terminal and run the same
command with `--mode tmux`. The optional hold occurs before the final F2/Ctrl+Q/restart teardown;
the JSON is written only after all cleanup checks finish, so a visible successful journey with
an orphaned process or socket still produces `ok=false`.

Never run compatibility evidence against private Markdown, SSH hosts, or media. The harness
generates its own synthetic assets. After a run, verify there is no harness, FFmpeg, mpv, or
isolated tmux socket left behind.

## Current release boundary

The 2026-07-29 complete workspace matrix is four of four direct and four of four inside tmux.
It is local real-terminal evidence, not a substitute for GitHub-hosted CI or release-archive
verification. The replacement `v0.1.0` asset is accepted only when the exact release commit also
passes Ubuntu 24.04 x64 and macOS 15 x64 CI, clean packaging, ad-hoc codesign, published SHA-256,
anonymous download, clean extraction, isolated doctor, real PTY, SSH/tmux/SFTP/media smoke, and
local-install hash equality. The binary remains macOS arm64 only, ad-hoc signed, and not notarized.

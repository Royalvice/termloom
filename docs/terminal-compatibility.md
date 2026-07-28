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

## Dated v0.1.0 matrix

The following direct runs were executed on macOS arm64 on 2026-07-28. Each structured probe:

- ran doctor through a real TTY and required `capabilitySource=opentui`;
- created a remote-resource-style Markdown fixture with GFM, PNG, animation GIF, TeX formula,
  and an audio-bearing MP4;
- required a decoded still frame, playing GIF, playing video, mpv audio clock, and pane-native
  fullscreen;
- compared doctor and showcase adapter identity/protocol;
- destroyed OpenTUI, FFmpeg, mpv, cache, and temporary fixture state.

| Terminal | Version | Environment | Adapter / protocol | Structured result | Visual evidence |
| --- | --- | --- | --- | --- | --- |
| Ghostty | 1.3.1 | `TERM=xterm-ghostty`, direct | `truecolor-cells` / `truecolor-half-block` | Passed | Current truecolor video/fullscreen screenshot passed |
| Kitty | 0.48.1 | `TERM=xterm-kitty`, direct | `kitty` / `kitty-unicode` | Passed | Current Kitty graphics/video/fullscreen screenshot passed |
| WezTerm | 20240203-110809-5046fc22 | direct | `iterm2` / `iterm2-inline` | Passed | Current inline-image screenshot passed |
| iTerm2 | 3.6.11 | direct | `iterm2` / `iterm2-inline` | Passed | Current inline-image video/fullscreen screenshot passed |

All accepted screenshots were captured from active, uniquely identified test windows after the
placement fixes. They contain only the harness's synthetic media fixture. Black, white, stale,
or privacy-sensitive diagnostic captures are not counted as release evidence.

## tmux submatrix

Inside tmux, the terminal environment becomes `TERM=tmux-256color` and `TERM_PROGRAM=tmux`.
v0.1.0 deliberately uses the portable truecolor-cell adapter instead of Kitty/iTerm2 graphics
passthrough.

| Host terminal | tmux | Adapter / protocol | Structured result | Evidence boundary |
| --- | --- | --- | --- | --- |
| Kitty 0.48.1 | 3.7b | `truecolor-cells` / `truecolor-half-block` | Passed | Current direct Kitty screenshot plus tmux structured probe |
| WezTerm 20240203 | 3.7b | `truecolor-cells` / `truecolor-half-block` | Passed | None in structured probe |
| iTerm2 3.6.11 | 3.7b | `truecolor-cells` / `truecolor-half-block` | Passed | Current direct iTerm2 screenshot plus tmux structured probe |
| Ghostty 1.3.1 | 3.7b | `truecolor-cells` / `truecolor-half-block` | Passed | Current truecolor video/fullscreen tmux screenshot and structured probe |

All four tmux runs recorded Markdown, PNG, GIF, formula, MP4, fullscreen, FFmpeg, windowless
mpv, truecolor capability, and closed test sockets. The terminal windows and test subprocesses
were identified individually and closed after evidence capture.

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
bun run scripts/terminal-matrix-probe.ts \
  --label kitty \
  --mode direct \
  --output /tmp/termloom-kitty-direct.json \
  --hold-ms 20000
```

For a tmux path, start an isolated socket/session from the target terminal and run the same
command with `--mode tmux`. The harness writes its JSON before the optional hold period, then
pauses the video, disposes all renderables/processes, and removes temporary fixtures.

Never run compatibility evidence against private Markdown, SSH hosts, or media. The harness
generates its own synthetic assets. After a run, verify there is no harness, FFmpeg, mpv, or
isolated tmux socket left behind.

## Current release boundary

The direct structured matrix is four of four, and the tmux structured matrix is four of four.
Current-code visual evidence exists for Ghostty, Kitty, WezTerm, and iTerm2. GitHub-hosted
Ubuntu 24.04 x64 and macOS 15 x64 passed run `30329845495` for commit `9a8308c`; an anonymous
public clone of that commit also passed frozen install, the complete test gate, native build,
and compiled verification. The final commit `3896005` then passed run `30330204678` on both
hosted platforms. The published v0.1.0 macOS arm64 archive was downloaded again through its
unauthenticated public URL and passed the published SHA-256, clean extraction, ad-hoc codesign,
build provenance, isolated doctor, and real-PTY OpenTUI teardown.

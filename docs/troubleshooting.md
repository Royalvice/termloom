# Troubleshooting

Start with the doctor. Its human report is concise; the JSON form preserves schema version,
capability provenance, paths, resolved hosts, and individual check statuses.

```bash
termloom doctor
termloom doctor --json >termloom-doctor.json
```

Review and redact the JSON before sharing it. Doctor output passes through credential-pattern
redaction, but paths, host IDs, terminal identity, and environment details may still be private
in your context.

## Doctor says a dependency is missing

The release does not install or bundle external tools, but v0.2.0 enables features
independently:

- Local browsing and plain-text/Markdown parsing do not require SSH, tmux, or rclone.
- `ssh` is required only for an SSH target.
- rclone with `--sftp-ssh` is required only for remote Files.
- remote tmux is required only after choosing **Terminal → Tmux**.
- FFmpeg/ffprobe, mpv, and resvg are required only by the corresponding media/formula paths.

On macOS:

```bash
brew install tmux rclone ffmpeg mpv resvg
hash -r
termloom doctor
```

OpenSSH is normally `/usr/bin/ssh`. `ffprobe` is installed with FFmpeg. If multiple package
managers are present, doctor shows the exact executable path and first version line used.

On Linux, package names vary by distribution. Install OpenSSH client/server as appropriate,
tmux, rclone, FFmpeg, mpv, and resvg from trusted distribution or upstream packages. rclone
must expose `--sftp-ssh`; old distribution builds that omit it are rejected by doctor. CI uses
Ubuntu packages plus checksum-pinned official rclone and resvg releases.

## Terminal probe fails or reports `environment-only`

A real OpenTUI capability probe requires both stdin and stdout to be the same interactive TTY.
Pipes, redirected output, `script(1)` without a responding terminal, CI logs, and some IDE
task runners cannot answer XTVersion and graphics queries.

Run directly in the target terminal:

```bash
termloom doctor
```

Use this only for dependency/config checks in a non-interactive environment:

```bash
termloom doctor --json --no-terminal-probe
```

That mode deliberately reports `capabilitySource: environment-only`; it is not proof that a
graphics protocol works. See [Terminal compatibility](terminal-compatibility.md).

## The terminal looks corrupted after a crash

Controlled TermLoom exits call OpenTUI renderer teardown. A process killed with `SIGKILL`, a
terminal crash, or an OS failure cannot run cleanup. In the affected shell, use:

```bash
stty sane
reset
```

Do not add `process.exit()` to TermLoom rendering paths as a workaround; it can bypass renderer
cleanup and recreate this problem.

## An OpenSSH alias is invalid

TermLoom discovers literal aliases locally at startup, but resolves only the active/selected
Host with `ssh -G -T -- ALIAS`. Doctor checks every catalog Host without opening a network
connection. Test the same source of truth outside TermLoom:

```bash
ssh -G ALIAS
ssh -vv ALIAS
```

Repair `~/.ssh/config`, included files, ProxyJump/ProxyCommand, identity paths, permissions,
agent state, or DNS there. TermLoom does not maintain a parallel SSH configuration.

SSH Config and expanded Include files are watched and debounced. Use Refresh or refocus the
terminal for an immediate rescan. A manually added wildcard alias and edited metadata are
usable immediately; SSH option changes apply on the next connection/reconnection without
restarting or interrupting an existing ControlMaster.

## SSH Config discovery shows an error

- A missing `~/.ssh/config` is a valid empty catalog; use `+ Alias` for a dynamic target.
- A config path that is a directory, unreadable file, malformed file, or unmatched Include is
  an explicit discovery error. Usable Hosts from other files remain visible.
- Relative Include paths follow the user OpenSSH config base; `~` and globs are expanded, and
  realpath cycles are ignored safely.
- Pattern-only entries such as `Host *.example.com` cannot be enumerated. Add the concrete
  alias through `+ Alias`; TermLoom still delegates its final meaning to `ssh -G`.

TermLoom never edits or deletes SSH Config. “Hide host” writes only TermLoom metadata.

## Host-key, passphrase, password, or 2FA prompt

Select the Host and answer the normal OpenSSH prompt in the full-height authentication panel.
Files and any later Direct SSH/Tmux path wait on the same coordinator, so only one authentication
PTY should appear per Host. Retry starts a fresh attempt; Cancel terminates the owned SSH PTY and
closes the panel. TermLoom does not save the answer. Do not paste secrets into issue reports or
configuration.

If a host-key changed unexpectedly, stop and verify the fingerprint through a trusted channel.
Do not delete known_hosts entries merely to suppress the warning.

## `SSH control path is too long`

Unix-domain socket paths are short on macOS. TermLoom rejects a ControlPath longer than 100
bytes instead of truncating it and risking collisions. Choose a short, private cache root:

```bash
install -d -m 0700 "$HOME/.tl-cache"
export XDG_CACHE_HOME="$HOME/.tl-cache"
termloom doctor
termloom
```

Persist the environment setting in the shell configuration only after confirming it does not
conflict with other XDG-aware tools.

## SFTP says there is no authenticated ControlMaster

rclone intentionally reuses OpenSSH and does not initiate a second authentication flow.

1. Select the Host in TermLoom.
2. Complete all OpenSSH prompts in the authentication panel.
3. Wait for the Host marker to become connected.
4. Focus Files and press `r`, or right-click the directory background and choose Refresh, if the
   original operation is no longer pending.

The master remains available for `ssh.controlPersistSeconds` after the last client closes. If
it expired, reconnect the host. Check it manually only when diagnosing the exact alias and
ControlPath shown by doctor; avoid deleting broad cache directories.

## SFTP operation or transfer fails

- Confirm `rclone version` works and doctor finds the expected binary.
- Confirm the remote account can read/write the path through normal SSH.
- Remember that remote paths are passed to rclone's `:sftp:` backend and are evaluated under
  the authenticated account.
- For an existing destination, enter exactly `overwrite`, `skip`, or `rename` when prompted.
- `x` cancels the newest transfer in a file pane; the Transfers overlay lets you select a job
  and cancel it with `x`.
- A cancelled or failed transfer may leave upstream/tool-specific partial state. Inspect the
  exact source and destination before retrying.
- TermLoom has no file-delete command. An explicit `overwrite` conflict policy may replace the
  exact destination, so verify both paths before confirming it.

## Remote Files stays on Loading or flickers

v0.2.0 silently reuses a healthy OpenSSH ControlMaster. Each SFTP list must not rebroadcast
`resolving → connected`, because a connected listener also refreshes active Files.

First confirm the installed version:

```bash
termloom --version
```

If it is older than 0.2.0, update it. On v0.2.0, collect a redacted doctor report and reproduce
with one generated/non-sensitive Host. A stable Host marker plus repeated Loading indicates a
real refresh lifecycle bug; do not work around it by repeatedly clicking Refresh.

## A right-click menu does not disappear

The unified overlay controller should close a menu on Escape, outside click, a second
right-click, action execution, target/surface/tab change, resize, or renderer blur.

If one remains visible:

1. press `Escape`;
2. resize the terminal by one column;
3. if it still remains, quit with `Ctrl+Q` so renderer teardown runs;
4. report the terminal name/version, direct/outer-tmux mode, terminal size, exact click sequence,
   and whether another modal such as Settings or SSH authentication was open.

Do not use `SIGKILL` unless controlled exit is impossible; it prevents normal terminal cleanup.

## tmux list is empty or attach fails

Tmux is intentionally lazy in v0.2.0. Selecting a Host or opening Direct SSH does not list
sessions. Press `F2`, choose **Tmux**, and only then diagnose the picker.

Verify tmux on the remote host:

```bash
ssh ALIAS 'tmux -V && tmux list-sessions'
```

No tmux server is a valid empty state. A permission error, malformed command, or missing tmux
is not. Session names in TermLoom may contain only letters, numbers, dots, underscores, and
hyphens, up to 128 characters.

If an SSH connection exits non-zero, an attached tmux pane shows reconnect attempts. A clean
zero exit is treated as intentional detach and does not loop. Reopen the Tmux path from the
Terminal surface and attach again.

When the terminal regains focus or a sleep-sized timer gap is detected, TermLoom reconnects and
refreshes active remote Files plus only those session pickers the user already opened. If a new
prompt is required, complete it in the embedded authentication panel. Hidden Terminal surfaces
keep their PTY alive; `F2` does not detach.

The remote tmux server is what preserves processes during sleep, disconnection, or TermLoom
restart. A raw SSH shell without a tmux session is not durable in the same way.

## Media shows a capability error

Run `termloom doctor` directly in the same terminal and inspect `terminal.adapter`. With
`media.adapter = "auto"`, the expected v0.2.0 direct adapters are:

- Kitty: `kitty`
- WezTerm and iTerm2: `iterm2`
- Ghostty direct: `kitty` with `kitty-unicode` placement
- any supported terminal inside tmux: `truecolor-cells`

Known direct Ghostty and Kitty identities use their Kitty-graphics path even when OpenTUI 0.4.5
reports one false negative before/at XTVersion. Unknown terminals are not upgraded from identity
guessing. Do not force `kitty` or `iterm2` merely because an unrelated terminal claims partial
compatibility. A forced adapter still needs a compatible known identity or the required live
capability. Truecolor cells have lower spatial resolution but display real image/video pixels.

## Images or video look blocky/pixelated

First inspect the media status line in the preview and run `termloom doctor` in the **same
terminal session**.

- `kitty` / `kitty-unicode` in direct Ghostty or Kitty is the high-resolution raster path. The
  source frame is not sampled down to terminal cells.
- `truecolor-cells` / `truecolor-half-block` is intentionally lower spatial resolution. It is
  expected inside an outer tmux because TermLoom does not assume graphics passthrough.
- If direct Ghostty still says `truecolor-cells`, make sure you are running the newly built
  candidate (not an older installed binary), are not inside tmux/screen, and report the redacted
  `doctor` terminal identity plus the media status. Do not force a graphics adapter through an
  unidentified terminal.

TermLoom never opens a GUI viewer as a hidden workaround. For a direct Ghostty regression, test
the exact window after its native execution permission is granted; an automated source payload
test alone is not a visual acceptance result.

Check that `COLORTERM=truecolor` and a correct terminfo entry reach tmux. For tmux, use a
current version and `TERM=tmux-256color`; fix terminfo or tmux configuration at the terminal/
tmux layer rather than hardcoding a false terminal identity in TermLoom.

## Image, SVG, or formula fails

- PNG/JPEG/WebP/GIF/MP4 decoding requires FFmpeg and ffprobe.
- SVG and MathJax formula output require resvg.
- A formula parse error is shown in the preview; it is not converted into a fake text image.
- A resource larger than the configured/cache safety limit fails with `RESOURCE_TOO_LARGE`.
- Relative Local resources are resolved with native filesystem rules against the Markdown
  file's local directory; they do not require rclone or a cache download.
- Relative remote resources are resolved against the Markdown file's remote directory. Verify
  letter case and permissions on the remote filesystem.

## Video has no picture or no sound

Visible frames always come from FFmpeg and the selected terminal adapter. mpv is launched with
video and window creation disabled. Therefore:

- no picture usually means FFmpeg, resource, or terminal-adapter failure;
- no sound on a video with audio usually means mpv or the system audio output;
- a silent MP4 intentionally does not start mpv and uses the FFmpeg clock;
- the terminal must remain active enough to receive frame writes; screen capture behavior of
  an inactive GPU window does not prove the live terminal itself failed.

Run these checks against a non-sensitive local fixture:

```bash
ffprobe -v error -show_streams sample.mp4
mpv --no-video --force-window=no --audio-display=no sample.mp4
```

The second command tests audio only and still creates no video window with the stated flags.

## HTTP image is blocked

This is the intended default. TermLoom makes zero requests to an unapproved hostname. Focus the
preview and press `o` to allow once or `P` to persist the hostname. Stored values must be bare
hostnames without scheme, port, path, credentials, or wildcard.

If a persisted domain should no longer be trusted, remove it in Settings or from
`permissions.allowedHttpDomains`; the running permission gate updates after Save.

## Invalid configuration or workspace state

`CONFIG_INVALID` and `STATE_INVALID` preserve the original file. Configuration v1 migrates to
configuration v2; workspace v1/v2 migrates to workspace v3. Valid legacy input receives a
user-only backup before atomic replacement. Invalid legacy/current input is not replaced and
gets no migration backup. Never overwrite an invalid file before making your own backup. With
TermLoom stopped:

```bash
cp ~/.config/termloom/config.toml ~/.config/termloom/config.toml.backup
cp ~/.local/state/termloom/workspaces.json ~/.local/state/termloom/workspaces.json.backup
```

Repair the reported field, then rerun `termloom doctor`. If you intentionally want a fresh
workspace, move only the exact state file aside; do not recursively remove the state directory.

```bash
mv ~/.local/state/termloom/workspaces.json \
  ~/.local/state/termloom/workspaces.json.invalid
termloom doctor
```

This loses TermLoom's saved Local/Host paths, selection, previews, tabs, splits, focus, and
Terminal intent, but it does not kill remote tmux sessions.

## macOS blocks the release binary

The v0.2.0 artifact is ad-hoc signed and not notarized. Verify the checksum from the same
GitHub Release first:

```bash
shasum -a 256 -c termloom-v0.2.0-darwin-arm64.tar.gz.sha256
codesign --verify --deep --strict --verbose=2 termloom-v0.2.0-darwin-arm64/termloom
```

If you trust the verified file, remove quarantine from that exact binary:

```bash
xattr -d com.apple.quarantine termloom-v0.2.0-darwin-arm64/termloom
```

Do not use `spctl --master-disable`, recursive `xattr` on a broad directory, or an unverified
binary from a third-party mirror.

## Reporting a reproducible issue

Include:

- TermLoom version or commit;
- OS and architecture;
- terminal name/version, whether tmux is involved, and `TERM`/`TERM_PROGRAM`;
- selected adapter and capability provenance from doctor;
- exact minimal steps and the smallest non-sensitive fixture;
- which cleanup checks you performed for FFmpeg, mpv, tmux sockets, and PTYs.

Remove usernames, home paths, SSH aliases, remote paths, hostnames, keys, tokens, and terminal
captures containing private data. Use the private process in [Security policy](../SECURITY.md)
for vulnerabilities.

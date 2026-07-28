# Configuration and key bindings

TermLoom uses a strict, versioned TOML configuration. When the file is absent, schema defaults
are used in memory. When it exists but is invalid, startup fails with a repair hint and leaves
the file untouched.

## Paths

The defaults are derived from `HOME` and respect XDG overrides:

| Purpose | Default | Override |
| --- | --- | --- |
| Configuration | `~/.config/termloom/config.toml` | `XDG_CONFIG_HOME` |
| Workspace state | `~/.local/state/termloom/workspaces.json` | `XDG_STATE_HOME` |
| Resource cache | `~/.cache/termloom/resources/` | `XDG_CACHE_HOME` |
| SSH control sockets | `~/.cache/termloom/ssh-control/` | `XDG_CACHE_HOME` |
| Diagnostic log directory | `~/.local/state/termloom/logs/` | `XDG_STATE_HOME` |

`HOME` is required. The doctor reports the effective paths, file types, permissions, and
writable ancestors.

## Complete example

```toml
schemaVersion = 1

[ui]
locale = "auto"
theme = "system"
sidebarWidth = 28
leader = "ctrl+space"

[ssh]
controlPersistSeconds = 600
connectTimeoutSeconds = 15
serverAliveInterval = 15
serverAliveCountMax = 3

[reconnect]
enabled = true
initialDelayMs = 500
maxDelayMs = 15000
multiplier = 1.8
jitter = 0.2

[media]
adapter = "auto"
videoFps = 24
maxCacheBytes = 536870912
autoplayGif = true

[permissions]
allowedHttpDomains = ["images.example.com"]

[[hosts]]
id = "lab"
alias = "my-lab"
label = "Lab server"
defaultPath = "/home/alice/project"
defaultTmuxSession = "work"
```

`alias` must be an existing OpenSSH alias, not a duplicate SSH configuration inside
TermLoom. Validate it with:

```bash
ssh -G my-lab
```

## Configuration fields

### UI

| Field | Type and range | Default | Meaning |
| --- | --- | --- | --- |
| `ui.locale` | `auto`, `en`, `zh-CN` | `auto` | UI catalog; `auto` follows the process locale |
| `ui.theme` | `dark`, `light`, `system` | `system` | Theme selection |
| `ui.sidebarWidth` | integer 18-60 | `28` | Sidebar columns |
| `ui.leader` | non-empty OpenTUI key expression | `ctrl+space` | Prefix for workspace commands |

### SSH

These values become explicit `ssh -o` options while all remaining behavior still comes from
the user's OpenSSH configuration.

| Field | Type and range | Default | Meaning |
| --- | --- | --- | --- |
| `ssh.controlPersistSeconds` | integer 30-86400 | `600` | How long an idle ControlMaster remains available |
| `ssh.connectTimeoutSeconds` | integer 1-120 | `15` | OpenSSH connect and non-interactive command timeout base |
| `ssh.serverAliveInterval` | integer 1-600 | `15` | OpenSSH server-alive interval |
| `ssh.serverAliveCountMax` | integer 1-20 | `3` | Missed server-alive responses before SSH exits |

The ControlPath contains a SHA-256-derived host identity instead of raw hostname/user values.
macOS Unix sockets have a short path limit; use a shorter `XDG_CACHE_HOME` if doctor reports a
path longer than 100 bytes.

### Reconnect

Reconnect applies to remote tmux panes. A clean zero exit is treated as an intentional detach;
a non-zero SSH exit enters this backoff policy.

| Field | Type and range | Default | Meaning |
| --- | --- | --- | --- |
| `reconnect.enabled` | boolean | `true` | Automatically recreate the SSH/tmux PTY |
| `reconnect.initialDelayMs` | integer 100-60000 | `500` | First retry delay |
| `reconnect.maxDelayMs` | integer 500-300000 | `15000` | Maximum base delay |
| `reconnect.multiplier` | number 1-5 | `1.8` | Exponential growth factor |
| `reconnect.jitter` | number 0-1 | `0.2` | Random plus/minus fraction applied to each delay |

### Media

| Field | Type and range | Default | Meaning |
| --- | --- | --- | --- |
| `media.adapter` | `auto`, `kitty`, `iterm2`, `truecolor-cells` | `auto` | Requested media adapter |
| `media.videoFps` | integer 1-60 | `24` | FFmpeg display frame target |
| `media.maxCacheBytes` | integer at least 1048576 | `536870912` | Versioned resource cache limit |
| `media.autoplayGif` | boolean | `true` | Start animated GIF playback after load |

`auto` is recommended. A forced adapter still has to pass capability selection; missing
support is an explicit error. Inside tmux, v0.1.0 chooses `truecolor-cells` rather than relying
on graphics passthrough.

### HTTP permissions

`permissions.allowedHttpDomains` is an array of hostnames without scheme, port, path,
credentials, or wildcard. Values are normalized to lowercase. Permission is hostname-wide for
both HTTP and HTTPS because the stored unit is a domain.

An unapproved remote Markdown resource creates no network request. In the preview pane:

- `o` allows the pending origin for the current TermLoom process;
- `P` persists the hostname in `allowedHttpDomains` before loading it.

### Hosts

Each `[[hosts]]` entry contains:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | Yes | Local stable ID matching `[A-Za-z0-9._-]+` |
| `alias` | Yes | Existing OpenSSH alias passed to `ssh -G` and `ssh` |
| `label` | No | Human-readable sidebar label |
| `defaultPath` | No | Initial SFTP and tmux working path; default `.` |
| `defaultTmuxSession` | No | Session to attach when the host entry is opened |

Host add/edit/delete is available in the sidebar. Deleting a host referenced by an open pane
is blocked. Host list changes are persisted immediately, but the process-level OpenSSH, tmux,
SFTP, and preview services are composed at startup; restart TermLoom before connecting a newly
added or materially changed host. Existing panes keep their original service objects until
shutdown.

## Applying settings

Open Settings with `<leader>g`. Use `Up`/`Down` or `k`/`j`, press `Enter` to edit the selected
field, then `Enter` to validate and save. `Esc` or `q` closes the overlay.

Sidebar width updates the active workspace immediately. The sidebar receives the saved host
list immediately. Leader, locale, theme, SSH, reconnect, media, and permission-service changes
apply after restarting TermLoom. This boundary is shown in the settings status message.

Do not edit `config.toml` while the settings overlay is saving. All writes are atomic, but the
last successful writer wins.

## Workspace state

`workspaces.json` is not a user preference file. It stores schema version 1 tabs, recursive
split nodes and ratios, panes, focused pane, host/session/path intent, sidebar state, selected
file, and Markdown scroll offset. It never stores credentials or live process IDs.

If it becomes invalid, TermLoom reports `STATE_INVALID` and does not overwrite it. Back it up
and repair it or explicitly move it aside while TermLoom is stopped. See
[Troubleshooting](troubleshooting.md).

## Global key bindings

`<leader>` means the configured `ui.leader`, `Ctrl+Space` by default.

| Binding | Action |
| --- | --- |
| `Ctrl+Q` | Destroy renderer, flush workspace state, and quit |
| `<leader>s` | Split active pane horizontally |
| `<leader>v` | Split active pane vertically |
| `<leader>x` | Close active pane if the tab has another pane |
| `<leader>n`, `<leader>p` | Focus next or previous pane |
| `<leader>a` | Add a tab with a local login shell |
| `<leader>w` | Close active tab if another tab exists |
| `<leader>.`, `<leader>,` | Activate next or previous tab |
| `<leader>]`, `<leader>[` | Grow or shrink the nearest enclosing split by 5% |
| `<leader>e` | Exchange active pane with the next pane in layout order |
| `<leader>b` | Toggle sidebar visibility |
| `<leader>1`, `<leader>2`, `<leader>3` | Select/focus Hosts, Sessions, or Files |
| `<leader>g` | Open Settings |
| `<leader>t` | Open Transfers |
| `<leader><leader>` | Send byte `0x00` (`Ctrl+Space`) to the active terminal PTY |

The split ratio is clamped to 10%-90%. New splits clone the active pane intent: a terminal
gets another terminal connection, a file pane gets another browser, and a preview gets another
read-only preview.

## Sidebar key bindings

Common bindings are `Up`/`Down` or `k`/`j` to select, `Left`/`Right` to change section,
`Enter` to open, and `r` to refresh.

| Section | Binding | Action |
| --- | --- | --- |
| Hosts | `Enter` | Open SSH shell or configured default tmux session |
| Hosts | `f` | Open default file path |
| Hosts | `s` | Switch to Sessions for the selected host |
| Hosts | `n` | Add host |
| Hosts | `R` | Edit host |
| Hosts | `d` | Delete after typing `DELETE` |
| Sessions | `Enter` | Attach selected tmux session |
| Sessions | `n` | Create session at host default path |
| Sessions | `R` | Rename selected session |
| Sessions | `d` | Kill after typing `DELETE` |
| Files | `Enter` | Open host default path |
| Files | `n` or `p` | Prompt for an arbitrary remote path |

`Esc` closes an active sidebar prompt without saving.

## File browser key bindings

| Binding | Action |
| --- | --- |
| `Up`/`Down`, `k`/`j` | Select entry and persist selection |
| `Enter` | Enter a directory or split/open a read-only preview for a file |
| `Esc` | Navigate to the parent directory |
| `r` | Refresh |
| `/` | Search current listing |
| `n`, `N` | Create file or directory |
| `R` | Rename selected entry |
| `c`, `m` | Copy or move to an entered remote path |
| `d` | Delete after typing `DELETE` |
| `u`, `D` | Upload local path or download selected file |
| `x` | Cancel the newest queued/running transfer |
| `[`, `]` | Previous or next page |

If a destination exists, enter exactly `overwrite`, `skip`, or `rename`. The initial operation
uses `error`, so no existing destination is overwritten without a second explicit choice.

## Rich preview key bindings

| Binding | Action |
| --- | --- |
| `j`/`k`, `Down`/`Up` | Scroll two rows |
| `PageDown`, `PageUp` | Scroll one viewport |
| `Tab`, `Shift+Tab` | Select next or previous playable media block |
| `Space` | Play or pause selected GIF/video |
| `Left`, `Right` | Seek -5 or +5 seconds |
| `+`, `-` | Volume +5 or -5 |
| `m` | Toggle mute |
| `f` | Enter or leave pane-native fullscreen |
| `o`, `P` | Allow pending HTTP origin once or persistently |

Fullscreen remains inside the same OpenTUI renderer and physical terminal. It does not invoke
the terminal's native fullscreen mode or create an application window.

## Overlay key bindings

- Settings: `Up`/`Down` or `k`/`j`, `Enter` edit/save, `Esc`/`q` close.
- Transfers: `Up`/`Down` or `k`/`j`, `x` cancel selected queued/running job, `Esc`/`q` close.
- Text prompts: type a value, `Enter` submits, and `Esc` cancels.

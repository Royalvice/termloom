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
schemaVersion = 2

[ui]
locale = "auto"
theme = "system"
sidebarWidth = 28
leader = "ctrl+g"
quickSwitch = "f2"

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
id = "ssh-0123456789abcdefabcd"
alias = "my-lab"
label = "Lab server"
defaultPath = "/srv/project"
defaultTmuxSession = "work"
hidden = false
source = "discovered"
```

The `[[hosts]]` block is optional metadata, not a second SSH configuration. Literal aliases
are discovered from `~/.ssh/config` and recursive `Include` files. A block is created only when
TermLoom needs to retain a label/default, hide a discovered Host, preserve migrated metadata,
or store a manually added wildcard-only alias. Validate the final OpenSSH configuration with:

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
| `ui.leader` | non-empty OpenTUI key expression | `ctrl+g` | Prefix for advanced workspace commands |
| `ui.quickSwitch` | non-empty OpenTUI key expression | `f2` | Files/Terminal surface switch |

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

TermLoom recursively expands `Include`, `~`, and glob patterns from the user SSH Config. It
lists positive literal tokens from `Host` directives and ignores wildcard, character-class,
and negated patterns as selectable entries. Files are realpath-deduplicated with cycle
protection. A missing root config produces an empty list; malformed, unreadable, non-file, or
unmatched Include inputs remain visible as discovery errors.

The `ssh-config` package reads directive structure, but system `ssh -G` remains authoritative
for HostName, User, Port, identity files, ProxyJump/ProxyCommand, and known-host behavior.
Discovery never modifies `~/.ssh/config` and never opens a network connection. Only the active
or explicitly selected Host is resolved and connected.

Each optional `[[hosts]]` metadata entry contains:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | Yes in the file | Stable internal ID matching `[A-Za-z0-9._-]+`; the UI does not ask for it |
| `alias` | Yes | Existing OpenSSH alias passed to `ssh -G` and `ssh` |
| `label` | No | Human-readable sidebar label |
| `defaultPath` | No | Initial SFTP and tmux working path; default `.` |
| `defaultTmuxSession` | No | Preferred selection in the Terminal session picker |
| `hidden` | No | Hide a discovered Host from TermLoom without editing SSH Config; default `false` |
| `source` | No | `discovered` metadata or a `manual` wildcard-only alias |

Use `+ Alias` only when a wildcard-only/dynamic alias cannot be enumerated. It asks for the
OpenSSH alias, not five internal fields. The Host context menu edits label/default path/default
session in one form. Removing a manual alias referenced by an open pane is blocked. Removing an
auto-discovered Host means “hide in TermLoom”; it never deletes or rewrites SSH Config.

## Applying settings

Open Settings from the clickable header, `F1` command palette, or `<leader>g`. Settings use
typed controls: Select for enums, toggle/checkbox for booleans, and Input/Slider for numbers.
Use `Up`/`Down` or `k`/`j`, `Enter` to edit, and `Ctrl+S` or the visible Save button to apply;
`Esc`, `q`, Cancel, or Close leaves the overlay.

Locale, theme, leader, quick switch, and sidebar width apply to the running UI. SSH parameters
apply to the next connection/reconnection without interrupting an existing ControlMaster.
Reconnect settings update existing terminal sessions. Media settings refresh existing preview
services; if that would stop active playback, TermLoom asks for confirmation first. Host
metadata refreshes the catalog immediately. None of these changes requires an application
restart.

Do not edit `config.toml` while the settings overlay is saving. All writes are atomic, but the
last successful writer wins.

## Workspace state

`workspaces.json` is not a user preference file. Schema v2 stores tabs plus independent
`surfaces.files` and `surfaces.terminal` trees for every Host. Each surface keeps its recursive
splits, ratios, active/focused pane, path/session intent, selected file, and preview scroll.
It never stores authentication state, credentials, terminal input, or live process IDs.

Valid config/workspace v1 files are validated, migrated to v2, and atomically written. The
original is retained once as a user-only `.v1.bak`. The exact pristine v1 Local-shell workspace
migrates to the Files start page; non-pristine tabs and split trees are preserved in their
matching surface. A saved alias missing from current SSH Config remains visible for remapping.

If it becomes invalid, TermLoom reports `STATE_INVALID` and does not overwrite it. Back it up
and repair it or explicitly move it aside while TermLoom is stopped. See
[Troubleshooting](troubleshooting.md).

## Global key bindings

`<leader>` means the configured `ui.leader`, `Ctrl+G` by default. `Ctrl+Space` has no global
TermLoom binding and is delivered to the active terminal PTY.

| Binding | Action |
| --- | --- |
| `Ctrl+Q` | Destroy renderer, flush workspace state, and quit |
| `F1` | Open searchable, clickable Help & Commands |
| `F2` | Switch the current Host between Files and Terminal |
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
| `<leader>g` | Open Settings |
| `<leader>t` | Open Transfers |
| `<leader><leader>` | Send the configured leader's literal control byte to the terminal PTY |
| `<leader>F2` | Send the literal F2 sequence (`ESC O Q`) to the terminal PTY |

The split ratio is clamped to 10%-90%. New splits clone the active pane intent: a terminal
gets another terminal connection, a file pane gets another browser, and a preview gets another
read-only preview.

## Host tree key bindings

The sidebar is one searchable Host/session tree rather than three hidden sections.

| Binding | Action |
| --- | --- |
| `Up`/`Down`, `k`/`j` | Select Host or session |
| `Enter` | Open selected Host in Files, or attach selected session |
| `/` | Focus Host search |
| `r` | Rescan SSH Config/Includes and refresh the tree |
| `n` | Create a tmux session for the expanded Host, or add a manual alias otherwise |
| `R` | Rename selected tmux session |
| `d` | Confirm session kill, manual-alias deletion, or discovered-Host hiding |
| `Esc` | Close the active Host-tree prompt/menu without saving |

Visible Refresh/Open/Add Alias/Actions/Collapse buttons provide the same common paths. The
top `Hosts` button reopens a collapsed sidebar without requiring a remembered shortcut.

## Mouse model

- Single-click selects and focuses; double-click opens a file/directory/Host or attaches a
  session. Visible Open and Attach buttons provide single-click activation.
- The wheel scrolls the list, document, terminal scrollback, modal, or horizontal toolbar under
  the pointer. Right-click opens context actions and never performs deletion by itself.
- Tabs, Files/Terminal, Help, Settings, Transfers, file operations, confirmations, HTTP
  permissions, playback, seek/volume sliders, mute, fullscreen, and close/cancel actions are
  clickable.
- Drag the sidebar or recursive split divider to resize; every split ratio remains clamped to
  10%-90%.
- A terminal pane receives SGR/VT mouse input when the remote program enables mouse tracking;
  otherwise its wheel controls local scrollback.

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

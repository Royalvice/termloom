# Configuration and key bindings

TermLoom separates user preferences from runtime workspace state:

- configuration schema v2: `~/.config/termloom/config.toml`;
- workspace schema v3: `~/.local/state/termloom/workspaces.json`;
- cache and SSH ControlPath files: `~/.cache/termloom/`;
- diagnostic logs: `~/.local/state/termloom/logs/`.

The corresponding XDG environment variables are respected. Writes are validated and atomic.
Authentication input is never a configuration or workspace field.

## Default configuration

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
allowedHttpDomains = []
```

Host entries are optional metadata. Discovered SSH aliases do not have to be copied into the
file:

```toml
[[hosts]]
id = "stable-generated-or-preserved-id"
alias = "lab"
label = "Lab"
defaultPath = "."
defaultTmuxSession = "work"
hidden = false
source = "discovered"
```

TermLoom never writes `~/.ssh/config`. Hiding an auto-discovered Host only adds TermLoom
metadata; removing a manual alias only removes TermLoom metadata.

## UI settings

| Key | Accepted values | Default | Effect |
| --- | --- | --- | --- |
| `ui.locale` | `auto`, `en`, `zh-CN` | `auto` | UI language |
| `ui.theme` | `system`, `dark`, `light` | `system` | Color theme |
| `ui.sidebarWidth` | integer 18–60 | 28 | Initial sidebar width; mouse drag persists later changes |
| `ui.leader` | keymap chord | `ctrl+g` | Advanced command prefix |
| `ui.quickSwitch` | keymap key/chord | `f2` | Files/Terminal surface switch |

Locale, theme, leader, quick switch, and sidebar width apply immediately after saving Settings.
`Ctrl+Space` is intentionally not a global binding and reaches the focused PTY unchanged.

## SSH and reconnect settings

| Key | Range | Default |
| --- | --- | --- |
| `ssh.controlPersistSeconds` | 30–86400 | 600 |
| `ssh.connectTimeoutSeconds` | 1–120 | 15 |
| `ssh.serverAliveInterval` | 1–600 | 15 |
| `ssh.serverAliveCountMax` | 1–20 | 3 |
| `reconnect.enabled` | boolean | true |
| `reconnect.initialDelayMs` | 100–60000 | 500 |
| `reconnect.maxDelayMs` | 500–300000 | 15000 |
| `reconnect.multiplier` | 1–5 | 1.8 |
| `reconnect.jitter` | 0–1 | 0.2 |

SSH values apply on the next connection/reconnection and do not forcibly stop a healthy current
ControlMaster. Reconnect values update active Direct SSH and tmux session coordination. A healthy
master is checked and silently reused; TermLoom does not emit another connected transition for
every SFTP command. A non-zero Direct SSH exit reconnects after the configured delay; a clean
exit remains stopped until the user presses Enter or clicks the ended pane.

System `ssh -G <alias>` remains authoritative for HostName, User, Port, IdentityFile,
CertificateFile, ProxyJump, ProxyCommand, known-hosts policy, agent behavior, and OpenSSH
extensions.

## Media settings

| Key | Accepted values | Default |
| --- | --- | --- |
| `media.adapter` | `auto`, `kitty`, `iterm2`, `truecolor-cells` | `auto` |
| `media.videoFps` | integer 1–60 | 24 |
| `media.maxCacheBytes` | integer ≥1048576 | 536870912 |
| `media.autoplayGif` | boolean | true |

`auto` uses live terminal capability data. Forcing an unsupported protocol is an explicit
error; no external GUI viewer is opened. Inside tmux, the accepted portable route is
`truecolor-cells` unless the implementation and acceptance matrix explicitly add a passthrough
mode.

Changing a media setting refreshes the current preview or applies to the next load. A refresh
that would stop active video first asks for confirmation.

## HTTP resource permission

`permissions.allowedHttpDomains` contains bare hostnames only:

```toml
[permissions]
allowedHttpDomains = ["static.example.org"]
```

Do not include a scheme, port, path, wildcard, username, or password. A Markdown HTTP(S)
resource is blocked before the first request to an unapproved origin. In the focused preview:

- `o`: allow that origin once for the current process;
- `P`: persist the bare domain after confirmation.

## Endpoint sidebar

The sidebar is a searchable endpoint list, not a Host/session tree:

1. **Local** is permanent and always first.
2. Literal OpenSSH aliases follow it.
3. Tmux sessions never appear in the sidebar and are never loaded by sidebar selection.

Each row is intentionally redundant so connection state remains legible with a low-saturation
theme or impaired color perception:

- Local uses a `LOCAL` badge and a distinct local marker;
- SSH uses an `SSH` badge plus `IDLE`, `LOAD`, `AUTH`, `READY`, `RETRY`, or `ERROR`;
- the state word is paired with a shape and theme color;
- the selected row uses a strong full-row background and left selection rail.

The header shows only the active workspace name/type/state and `current / total`, with clickable
previous, next, add, and close actions. This is a navigation view over the persisted workspace
registry, not destructive tab virtualization; hidden Files and Terminal backends stay alive.

Mouse actions:

- single-click Local/Host: select and open its Files surface;
- double-click: same activation path;
- right-click Local: Open Local Files;
- right-click Host: Open Files, edit label/defaults, hide/remove metadata;
- `↻`: rescan SSH Config and recursive Includes;
- `+`: add a manual OpenSSH alias for wildcard/dynamic configurations;
- `⋯`: open contextual endpoint actions;
- `‹`: collapse the sidebar.

Focused sidebar keys:

| Key | Action |
| --- | --- |
| `↑`/`↓`, `k`/`j` | Move selection |
| `Enter` | Open selected endpoint Files |
| `/` | Focus endpoint search |
| `r` | Refresh SSH Config catalog |
| `n` | Add a manual alias |

Local is not filtered out by Host search, cannot be hidden or deleted, and never invokes SSH.

## Files surface

The layout responds to the content width:

| Width | Columns |
| --- | --- |
| ≥84 | Parent directory 23%, current directory 43%, preview remainder |
| 48–83 | Current directory and preview |
| <48 | Current directory only; Enter/double-click a file opens a narrow preview |

Rows are directory-first and natural/case-insensitive sorted. A single-cell symbol and theme
color jointly identify each kind: `▸` directory, `≡` text/Markdown, `▧` image, `▶` GIF/video,
`◆` archive, `λ` source/config, `*` executable, `↗` symlink, and `·` unknown. The selected row
uses the stronger selection background. Each row also contains the name, size, and, where space
permits, modification time. The footer shows full path, size, modification time, mode, transfer
progress, or the current error.

The path bar begins with a compact clickable `← Up` control. It uses the active Local/SFTP
provider's normalized parent path, matches `Escape`/Backspace navigation, and is disabled at the
provider root.

Mouse actions:

- single-click: select/focus and schedule preview;
- double-click directory: enter;
- double-click file: open preview;
- right-click row: Open/Preview, Open in Split, and remote Download when applicable;
- right-click directory background: Refresh and Search;
- wheel: scroll the hovered list or preview.

In a TermLoom embedded terminal, every trustworthy absolute POSIX path or `file:///` URI is
underlined. Hovering it adds a stronger weight, switches to a pointer, and changes the compact
footer to `Open in Files · Ctrl+Click`. `Ctrl` + left-click opens the same target's Files surface.
`:line` and `:line:column` suffixes are removed before validation. A shell error delimiter such
as `/path:` is tried first as `/path`, then only falls back to the literal colon spelling if that
same provider can verify it. Relative paths are not interpreted. The provider must `stat()` the
target first, so no shell command is constructed from terminal text. Non-`Ctrl` mouse input
remains available to the focused terminal application.

Context menus are anchored to the pointer and clamped to the terminal viewport. They close on
Escape, outside click, a second right-click, action execution, endpoint/surface/tab/pane change,
resize, renderer blur, or replacement by another overlay.

Focused Files keys:

| Key | Action |
| --- | --- |
| `↑`/`↓`, `k`/`j` | Move current selection |
| `Enter` | Enter directory or open file preview |
| `Escape`/Backspace | Close narrow preview or go to parent directory |
| `r` | Refresh |
| `/` | Search current directory |
| `Shift+D` | Download selected remote file or directory |
| `x` | Cancel the latest download owned by this Host and pane |
| `[` / `]` | Previous / next page |

Files is deliberately read-only for Local and remote sources: there is no source-file create,
rename, copy, move, overwrite, upload, or delete action/key. A file context menu can copy its
absolute path, and the address bar accepts `Command+C`/`Command+V` clipboard events; neither
changes the source tree. Download is remote-to-local only, defaults to `~/Downloads/<name>`, never
overwrites, and rejects selected symbolic links. Tmux session `Kill` remains a separate, explicitly
confirmed session-management action.

## Terminal surface

Local owns a persistent local shell immediately. No tmux launcher is shown for Local.

An SSH target initially owns a `terminal-launcher` with two choices:

- **Direct SSH**: replace the launcher with a normal system-SSH terminal; no tmux list call;
- **Tmux**: replace the launcher with a session picker, then perform the first session discovery.

Every terminal pane also supports `Ctrl` + left-click path navigation into its own target's Files
surface. For a file, Files opens its parent directory and selects/previews the file; for a
directory, Files opens the directory itself. This does not create a tmux picker or invoke tmux.

Drag with the left mouse button to select terminal cell text. The selection is highlighted and
`Command+C` copies it; hold `Shift` while dragging when the child program has enabled mouse
tracking. `Command+V` follows the existing PTY paste/bracketed-paste path.

The Tmux picker supports attach, open in split, create, rename, refresh, raw SSH shell, and Kill.
Kill requires typing `DELETE`; it kills a remote tmux session, not a file.

## Global keymap

`<leader>` means `ui.leader`, default `Ctrl+G`.

| Key | Action |
| --- | --- |
| `Ctrl+Q` | Flush workspace state and quit |
| `F1` | Open searchable/clickable Help & Commands |
| `F2` | Switch Files/Terminal for the active target |
| `<leader>s` / `<leader>v` | Split horizontally / vertically |
| `<leader>x` | Close active pane when a sibling exists |
| `<leader>n` / `<leader>p` | Focus next / previous pane |
| `<leader>a` | Add an explicit Local tab |
| `<leader>w` | Close active tab when another tab exists |
| `<leader>.` / `<leader>,` | Next / previous tab |
| `<leader>]` / `<leader>[` | Grow / shrink nearest split by 5% |
| `<leader>e` | Exchange active pane with the next pane |
| `<leader>b` | Toggle sidebar |
| `<leader>g` | Settings |
| `<leader>t` | Transfers |
| `<leader><leader>` | Send the literal leader control byte to the PTY |
| `<leader>F2` | Send the literal F2 sequence to the PTY |
| `Ctrl+Space` | Pass through unchanged |

The footer permanently advertises only `F1 Help`.

## Schema migration

Config remains schema v2:

- valid v1 is parsed and validated before migration;
- the old default `ctrl+space` leader becomes `ctrl+g`;
- a user-customized leader is preserved;
- `quickSwitch = "f2"` and Host metadata fields are added;
- a restrictive `.v1.bak` is retained;
- invalid source files are reported and not overwritten.

Workspace is schema v3:

- `hostId` becomes an explicit `{ kind = "ssh", hostId }` target;
- local panes become `{ kind = "local" }`;
- the pristine Start/Local placeholder becomes Local Files at `$HOME`;
- a default remote `session-picker` becomes `terminal-launcher`, preventing tmux discovery
  during startup;
- already attached tmux terminals, Direct SSH terminals, paths, preview state, layouts, tabs,
  splits, active surface, and focus are preserved;
- valid v1/v2 input is backed up with mode `0600`, migrated, validated as v3, and atomically
  written;
- invalid v1/v2/v3 state is preserved and reported rather than reset.

## Manual editing

Stop TermLoom before editing configuration or workspace files. Make an exact backup first, edit
only the intended file, and rerun:

```bash
termloom doctor
termloom doctor --json --no-terminal-probe
```

Do not recursively delete the configuration, state, or cache root to fix one invalid document.

# Architecture

TermLoom is a terminal-resident workspace, not a terminal emulator or a protocol stack.
OpenTUI owns presentation and input; mature system tools own SSH, SFTP, tmux, decoding, audio,
and rasterization.

## Product boundary

```text
Existing terminal
  └─ OpenTUI renderer
      └─ WorkspaceApp
          ├─ endpoint sidebar: Local + SSH Hosts
          ├─ persistent workspace registry
          │   ├─ one current-context navigation bar
          │   ├─ Files surface
          │   └─ Terminal surface
          ├─ root overlay controller
          └─ settings / transfers / authentication

Files
  └─ FileProviderRouter
      ├─ LocalFileProvider ── fs/promises
      └─ RcloneSftpService ── rclone :sftp: ── shared system OpenSSH master
          ├─ RemoteResourceReader ── internal preview cache only
          └─ RemoteDownloadService ── explicit remote-to-local downloads

Terminal
  ├─ Local ── bun-pty ── local shell
  └─ SSH target
      ├─ Direct SSH ── system ssh PTY
      └─ Tmux picker ── remote tmux ── system ssh PTY

Preview
  ├─ unified/remark/rehype + MathJax
  ├─ ResourceLoader: file | sftp | http | https
  └─ FFmpeg/ffprobe + resvg + optional windowless mpv
```

No layer opens Finder, Quick Look, a browser, or a media-player window. mpv runs with video and
window output disabled; decoded frames remain in OpenTUI-managed terminal surfaces.

## Runtime assembly

`src/runtime/run.ts` loads and validates:

1. configuration schema v2;
2. workspace schema v3, including legacy migration;
3. external dependency/capability services;
4. Host discovery and catalog;
5. connection, file, tmux, document, and media services;
6. the OpenTUI renderer and `WorkspaceApp`.

Startup performs local SSH Config discovery but does not connect all aliases. An absent valid
workspace creates a Local target at `$HOME`.

## OpenTUI ownership

`WorkspaceApp` owns the stable application shell:

- one bounded current-workspace context bar with previous/next/add/close actions;
- permanent Local + SSH endpoint sidebar with explicit type/state/selection semantics;
- Files/Terminal segmented control;
- recursive split layout;
- active pane focus;
- footer status and the single `F1 Help` hint;
- Settings, Transfers, Help, and authentication overlays;
- one `DismissibleOverlayController` for context menus.

OpenTUI Yoga remains responsible for sizing and positioning. TermLoom adds only thin behavior
where OpenTUI 0.4.5 does not provide the required item hit-testing:

- `EndpointListRenderable`: one-row type badges, state shape/text/color, strong selection,
  click/right-click, keyboard movement, and scroll-into-view over OpenTUI primitives;
- `WorkspaceContextBarRenderable`: a responsive view/controller for the active entry in the
  persistent workspace registry; hidden workspace trees and PTYs remain owned by the registry;
- `FileListRenderable`: selected row, row color/icon, click/double-click/right-click, and
  scroll-into-view over OpenTUI `ScrollBoxRenderable` and `TextRenderable`;
- the existing mouse-select adapter for OpenTUI list controls;
- sidebar/split divider pointer-to-ratio mapping, constrained to 10–90%;
- dismissible menu anchoring and viewport clamping.

TermLoom does not duplicate OpenTUI layout, scrolling, text shaping, or renderer lifecycle.

## Endpoint model

`HostCatalog` contains only real SSH profiles. The UI constructs a separate endpoint view:

```ts
type Endpoint =
  | { kind: "local" }
  | { kind: "ssh"; profile: HostProfile };
```

Local is therefore not a fake Host:

- it does not have a Host ID, alias, resolution state, ControlPath, or tmux service;
- it is always first and cannot be hidden/deleted;
- selecting it opens/reuses Local Files;
- its Terminal surface is a persistent local PTY.

SSH discovery starts at `~/.ssh/config`, recursively expands relative/`~`/glob Includes,
deduplicates real paths, protects against cycles, preserves first-seen alias order, and enumerates
only positive literal Host tokens. `ssh-config` parses structure; `ssh -G` remains the final
resolution truth.

Manual aliases cover wildcard-only or dynamic SSH configurations. Host metadata can override
label, default path, default tmux session, and visibility without rewriting SSH Config.

## Connection lifecycle

`HostConnectionCoordinator` serializes authentication per Host:

```text
idle → resolving → authenticating → connected
                    ↘ error
connected → reconnecting → authenticating/connected/error
```

Files, Direct SSH, and Tmux wait on the same connection task. Interactive system-SSH output and
input flow only through an embedded PTY. Passwords, passphrases, OTPs, and host-key answers are
not added to structured state, events, errors, logs, snapshots, or tests.

After a Host is known connected, a later request performs a silent `ssh -O check`:

- healthy master: return without another `resolving` or `connected` event;
- missing master: enter reconnect/authentication;
- first encounter of a healthy externally created master: publish one connected transition.

This invariant prevents the SFTP-list → connected-event → Files-refresh → SFTP-list loop.

## Files providers

`FileProvider` is target-neutral:

```ts
interface FileProvider {
  readonly kind: "local" | "sftp";
  list(path: string, options?: DirectoryQuery): Promise<DirectoryPage>;
  stat(path: string, options?: FileStatOptions): Promise<FileEntry>;
}
```

This is intentionally a read-only boundary: neither provider exposes create, rename, copy, move,
overwrite, upload, download, or delete. Preview cache materialization belongs to the internal
`RemoteResourceReader`; an explicit user download belongs to `RemoteDownloadService` and only
copies a remote source to a supplied local destination.

`LocalFileProvider` uses `fs/promises` and reports real lstat/stat metadata: name, absolute
path, directory/symlink type, size, modification time, MIME, mode, uid, and gid. It never writes
the source tree.

`RcloneSftpService` streams lightweight rclone CSV listings and requests detailed metadata only
for a selected `stat()`. It uses `--sftp-ssh` so the data path reuses the authenticated OpenSSH
ControlMaster, holds a bounded five-second directory cache, rejects oversized listings, and maps
remote data into the same `FileEntry` shape without inventing metadata absent from rclone.

`RemoteDownloadService` validates the remote source twice, rejects selected symbolic links, and
binds every job to its Host and owner pane. Files download into a private same-directory partial
and publish through no-replace hard link or `COPYFILE_EXCL`; directories reserve a unique target
with an ownership marker and only clean up a failed tree when that ownership can still be proven.
Nested remote links are skipped rather than followed. No step opens Finder, Quick Look, or a GUI
media player.

`FileProviderRouter` returns Local unconditionally. If rclone is missing, only an SSH target's
Files pane reports `DEPENDENCY_MISSING`; Local browsing and local preview remain usable.

## Adaptive file browser

`FileBrowserRenderable` coordinates three logical regions:

- parent directory list;
- current directory list;
- embedded preview host.

Responsive modes are computed from the content width:

- `three` at ≥84 columns;
- `two` at 48–83 columns;
- `single` below 48 columns.

Selection schedules preview after roughly 150 ms. Every request carries a monotonically
increasing generation and an `AbortSignal`; stale work is cancelled instead of merely discarded.
Refresh requests are coalesced without losing a later refresh, teardown settles outstanding work,
and a destroyed pane cannot re-enter rendering. Directory pages stat only their visible entries;
preview text is read in bounded 512 KiB increments, unknown binary is sniffed once, and oversized
remote resources remain metadata-only until the user explicitly downloads them.

The Files path bar owns a compact `← Up` control. It calculates the provider-normalized parent
path and is inert at the provider root; Local and SFTP therefore share the same behavior instead
of maintaining a separate breadcrumb implementation.

Preview is embedded in Files and does not create a workspace split for every selection. Legacy
standalone preview panes remain supported for migrated layouts and explicit Open in split.

## Context menu lifecycle

All sidebar, Files, and tmux menus use `DismissibleOverlayController`. It owns at most one
context menu and restores the previous focus exactly once.

A menu is dismissed by:

- Escape;
- pointer press outside the menu;
- another right-click;
- menu-item activation;
- endpoint, Files/Terminal surface, tab, or pane change;
- renderer resize or blur;
- replacement by Settings, Transfers, Help, authentication, or another modal;
- renderer/application destruction.

The requested mouse point is converted into viewport coordinates, and the final box is clamped
inside the current terminal dimensions.

## Terminal surfaces and on-demand tmux

Every target has two independently persisted surfaces.

Local:

- Files starts at `$HOME`;
- Terminal owns a local shell PTY immediately;
- no SSH or tmux service is constructed for navigation.

SSH:

- Files selection ensures the shared SSH master, then lists through SFTP;
- Terminal initially contains `terminal-launcher`;
- Direct SSH replaces that pane with a normal remote `terminal`;
- Tmux replaces it with `session-picker`, and only the picker constructor/refresh calls
  `list-sessions`;
- attaching replaces the picker or opens a new split;
- hidden terminal backends remain registered and alive.

Direct SSH and tmux attachments both use `ReconnectSession`. A non-zero backend exit first
confirms the shared ControlMaster and then follows the configured bounded retry policy. Exit code
zero means an intentional session end: the pane shows a reconnect affordance and reconnects only
after Enter or click. Connection generations, timers, and stale callbacks are invalidated on pane
destruction.

`PaneRegistry.refreshHost()` refreshes Files panes and session pickers that already exist. It
does not create a picker, so focus/sleep/network recovery cannot accidentally start tmux
discovery.

### Terminal path navigation

`TerminalRenderable` finds safe absolute-path tokens in the xterm active buffer and renders them
with a persistent underline. Hover adds a stronger text attribute, sets a pointer, and enables
the compact footer affordance; only an absolute POSIX path or `file:///` URI is eligible. Quoted
paths are supported and terminal locations such as `/project/file.ts:42:7` normalize to
`/project/file.ts`. For shell prose such as `-bash: /project/output: Is a directory`, the
delimiter-free `/project/output` is the first candidate and the literal trailing-colon spelling
is only a verified fallback. Relative paths, non-local file URI hosts, malformed URIs, and
NUL-containing text fail closed.

On `Ctrl` + left-click, `WorkspaceApp` routes the path through the source terminal pane's
`WorkspaceTarget`, validates it with that target's `FileProvider.stat()`, and activates the tab
that owns that terminal. A file reveals its parent Files directory with `selectedPath` and
`previewPath`; a directory reveals itself. No shell interpolation, endpoint guessing, tmux
discovery, or cross-target Local fallback occurs. A safe, classified status is shown when SFTP
cannot verify the path; raw endpoint paths and rclone diagnostics are not rendered. Normal mouse
traffic remains terminal traffic.

## Document and media resources

```ts
type ResourceLocation =
  | { scheme: "file"; path: string }
  | { scheme: "sftp"; hostId: string; path: string }
  | { scheme: "http" | "https"; url: string; domain: string };
```

- Local relative references use native `node:path` resolution.
- SFTP relative references use POSIX path rules and the same Host ID.
- `file:` URLs are valid only from Local documents and reject non-local hostnames.
- HTTP(S) credentials and unsupported protocols are rejected.
- HTTP(S) origins pass through `DomainPermissionGate` before any network request.

Local files are read directly. SFTP resources are materialized into a versioned cache only after
size/type validation. Parsing and rendering remain separate: unified/remark/rehype produces a
sanitized document model, MathJax produces SVG formulas, resvg/FFmpeg produce bounded raster
frames, and the selected terminal adapter places them into the OpenTUI surface. Rich documents
preload only around the visible viewport, cap concurrent resource work at two, and cancel work on
selection, hide, or destruction.

## Persistence and migration

Configuration stays schema v2 and workspace schema v3
introduces:

```ts
type WorkspaceTarget =
  | { kind: "local" }
  | { kind: "ssh"; hostId: string };
```

Workspace entries and panes carry a target explicitly. A remote Terminal start pane is
`terminal-launcher`; `session-picker` now means the user has explicitly entered Tmux.

Migration is parse → validate old schema → transform → validate v3 → restrictive backup →
atomic write. The exact pristine old Start/Local state becomes Local Files at `$HOME`. Existing
remote terminals, attached tmux sessions, Direct SSH terminals, files, previews, paths, split
trees, workspace entries, active surface, and focus are preserved. Invalid state is reported and
not reset.

## Failure and cleanup invariants

- A bad SSH alias affects only that Host.
- Missing rclone affects only remote Files.
- Missing tmux appears only after the user chooses Tmux.
- Missing media tools affect the corresponding preview and never trigger a GUI fallback.
- Files source mutation is absent; explicit remote-to-local downloads never overwrite.
- Tmux session Kill requires explicit typed confirmation.
- Renderer teardown unsubscribes listeners and destroys owned PTYs/media processes.
- Test harnesses record exact PIDs, window IDs, tmux sockets, sshd, ControlMaster, FFmpeg, mpv,
  and fixture paths, then clean only those exact resources.

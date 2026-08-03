# Changelog

All notable changes to TermLoom are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow Semantic
Versioning.

## [0.3.0] - 2026-08-03

### Added

- Adds an explicit, editable remote-to-local download action for files and directories. Every
  target is unique/no-replace, files publish from private partials, selected symbolic links are
  rejected, and nested directory links are skipped and reported.
- Adds a host- and Files-pane-owned bounded download queue with cancellation, throttled progress,
  bounded history, and a Transfers view that cannot cancel another pane's job.
- Adds direct-SSH recovery through the shared ControlMaster: non-zero exits retry with backoff,
  while a normal exit stays detached until Enter or click reconnects it.

- Adds a compact, clickable `← Up` control to the Files path bar. It uses the same provider path
  rules as keyboard Backspace/Escape and becomes inert at the Local or SFTP root.
- Adds terminal `Ctrl` + left-click path navigation. Trusted absolute POSIX paths and `file:///`
  URIs (including a trailing `:line:column`) open the owning Local/SSH Files surface; files select
  and preview in their parent directory, while directories open directly.
- Makes trustworthy absolute paths in embedded terminal output visibly underlined, with a stronger
  hover state, pointer, and compact `Ctrl+Click` Files affordance. Shell-error punctuation after
  a directory path is normalized safely and SFTP path failures now show a redacted actionable
  reason instead of a generic message.

### Fixed

- Removes all Local/SFTP source-mutation paths from the provider API, Files UI, keyboard
  shortcuts, context menus, palette, and public documentation. Files now only browses, searches,
  previews, refreshes, and navigates.
- Makes persisted workspace saves revision-aware, coalesced, and recoverable after a failed
  write; drag-end and no-op transitions no longer cause unnecessary state churn.
- Bounds and cancels directory listings, remote resources, preview reads, cache producers, and
  viewport preloads so stale/hidden work cannot keep producing media or network output.
- Makes media disposal wait for placements and child work, assembles decoded frames linearly, and
  applies latest-frame/backpressure handling before terminal writes.

- Keeps known direct Ghostty sessions on Kitty graphics with Unicode placement instead of
  accepting OpenTUI 0.4.5's false `kitty_graphics=false` probe and degrading a 768×768 image to
  the terminal cell grid. Ghostty animation uses complete `a=t` replacement frames because
  Ghostty 1.3.1 does not implement Kitty's `a=f` frame-edit action.
- Replaces visually flat endpoint rows with type badges, state shape + text + color, a strong
  selected-row rail/background, and lifecycle-safe asynchronous add/edit forms.

### Changed

- Replaces the equal-width Host tab strip with one responsive current-workspace context bar and
  previous/next/add/close controls while preserving every hidden workspace, surface, split, and
  PTY backend.
- Gives file kinds distinct one-cell symbols as well as colors, and applies the stronger selected
  background to file rows and the Files/Terminal active segment.

## [0.2.0] - 2026-07-29

### Changed

- Makes the permanent Local endpoint and `$HOME` file browser the zero-state experience.
  Literal SSH Config aliases remain auto-discovered below Local, but selecting one opens only
  Files/SFTP.
- Replaces automatic sidebar tmux discovery with an explicit remote Terminal launcher.
  **Direct SSH** opens a normal shell without touching tmux; **Tmux** creates the session picker
  and performs the first `list-sessions` request only when chosen.
- Rebuilds Files as a Termius-style adaptive browser: parent/current/preview at 84+ columns,
  current/preview at 48–83 columns, and a current-directory view with an explicit narrow preview
  below 48 columns.
- Replaces the uniform file selector with colored, directory-first, naturally sorted rows for
  directories, text, images, video, archives, source/config files, executables, and unknown
  entries.
- Moves file actions out of the permanent text toolbar into right-click menus, focused keyboard
  commands, and the searchable `F1` command palette. The footer now carries path/selection/
  transfer/error status with only `F1 Help` as its permanent hint.
- Removes file deletion from the public Local and SFTP provider interface and from every menu,
  key binding, command-palette entry, and document. Explicit overwrite conflict handling remains
  available for copy, move, rename, upload, and download.
- Uses a root-owned dismissible overlay controller so context menus close on Escape, outside
  click, second right-click, activation, target/surface/tab change, resize, renderer blur, or
  replacement by another overlay.
- Prevents healthy ControlMaster reuse from rebroadcasting `resolving`/`connected`, removing
  the remote Files refresh loop and the observed loading flicker.

### Added

- Adds `LocalFileProvider` and a target-based `FileProvider` router. Local browse, stat,
  create, rename, copy, move, Markdown, image, GIF, MP4, and formula preview work without rclone.
- Adds explicit `file | sftp | http | https` document-resource locations so local relative
  Markdown resources use native paths while remote resources retain POSIX/SFTP resolution.
- Adds debounced, generation-guarded inline preview, directory summaries, viewport-bounded
  context menus, and responsive three/two/one-column mouse tests.
- Upgrades workspace state to schema v3 with explicit
  `{ kind: "local" } | { kind: "ssh", hostId }` targets and a `terminal-launcher` pane.
  Valid v1/v2 state migrates atomically while preserving existing terminal/tmux attachments,
  tabs, splits, paths, preview state, and focus.

The public v0.1.0 tag, Release, assets, and its documented rebuild audit chain remain unchanged.

## [0.1.0] - 2026-07-28

### Rebuilt UX

- Automatically discovers literal Hosts from local OpenSSH config and recursive `Include`
  files, watches them for changes, keeps system `ssh -G` authoritative, and connects only the
  restored or selected Host.
- Shares one per-Host ControlMaster authentication task across Files, tmux discovery, and
  terminals, with an embedded host-key/passphrase/password/2FA PTY and explicit Retry/Cancel.
- Replaces the three-section sidebar with one searchable Host/session tree and per-Host,
  independently persistent Files and Terminal surfaces. Files is the default; `F2` switches
  without destroying hidden PTYs or file/preview state.
- Changes the default advanced leader from `Ctrl+Space` to `Ctrl+G`, leaves `Ctrl+Space` for
  remote programs, adds a searchable/clickable `F1` command palette, literal leader/F2
  forwarding, and a permanently clickable Host-tree toggle.
- Extends mouse operation across Host/session/file lists, tabs, surfaces, settings, transfers,
  confirmations, document/media controls, scrollable narrow toolbars, sidebar width, and
  recursive split dividers.
- Migrates valid config and workspace v1 documents to v2 with restrictive backups, preserving
  custom Host IDs and layouts while converting the exact pristine Local-shell state into the
  Files start page.
- Refreshes only the active Host after renderer focus, connection recovery, or a sleep-sized
  timer gap, while remote tmux and hidden terminal surfaces continue running.
- Adds real encrypted-key PTY coverage plus an explicitly simulated OpenSSH password/2FA PTY
  sequence, with assertions that credentials never enter config, state, events, or fixtures.

This rebuilt v0.1.0 intentionally replaces the initial public asset in place with a public
audit trail. The initial build commit was
`3896005d4b23c4b9cc944ceb01c95e5d2411e479`; its archive SHA-256 was
`a5b45015edc49ca7cd7756825874295683f17fc85bdad07bad289acc223288a2`.

### Added

- OpenTUI workspace with host/session/file sidebar, tabs, recursive splits, settings,
  transfers, English, and Simplified Chinese.
- Embedded `bun-pty` and `@xterm/headless` terminal panes for local shells, OpenSSH, and
  remote tmux attach.
- System OpenSSH alias resolution, per-host ControlMaster, interactive authentication,
  reconnect backoff, and persistent workspace/session intent.
- Complete rclone SFTP file operations with paging, search, conflict policies, progress, and
  cancellation.
- Read-only GFM Markdown, sanitized HTML, remote resources, explicit HTTP-domain permission,
  MathJax formulas, images, SVG, animated GIF, and MP4.
- Kitty, iTerm2 inline-image, and truecolor-cell media adapters with pane-native fullscreen,
  FFmpeg frames, and windowless mpv audio/clock control.
- Versioned doctor JSON, failure exit codes, dependency/config/state/path/security checks, and
  diagnostic redaction.
- macOS/Linux CI, native build verification, real-terminal matrix harness, release packaging,
  community policies, and complete production dependency license inventory.

[Unreleased]: https://github.com/Royalvice/termloom/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Royalvice/termloom/releases/tag/v0.3.0
[0.2.0]: https://github.com/Royalvice/termloom/releases/tag/v0.2.0
[0.1.0]: https://github.com/Royalvice/termloom/releases/tag/v0.1.0

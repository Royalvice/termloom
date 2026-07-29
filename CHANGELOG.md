# Changelog

All notable changes to TermLoom are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow Semantic
Versioning.

## [Unreleased]

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

[Unreleased]: https://github.com/Royalvice/termloom/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Royalvice/termloom/releases/tag/v0.1.0

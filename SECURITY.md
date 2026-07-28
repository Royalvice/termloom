# Security policy

## Supported versions

Security fixes are provided for the latest published release. Pre-release source on `main`
may change without a compatibility guarantee.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes, while it is the latest release |
| Earlier or unreleased snapshots | No |

## Reporting a vulnerability

Please use **Security → Report a vulnerability** in the GitHub repository to open a private
security advisory. Do not include credentials, private keys, SSH configuration, private host
aliases, remote paths, terminal captures containing secrets, or exploit details in a public
issue.

Include the TermLoom version or commit, operating system and architecture, terminal and tmux
versions, reproduction steps, impact, and whether the issue requires a particular SSH or
media configuration. Redact all credentials and private infrastructure names.

The maintainer will make a best effort to acknowledge a complete report within seven days,
coordinate validation and a fix privately, and credit the reporter if requested. A response
target is not a warranty or service-level agreement.

## Security boundaries

TermLoom:

- delegates SSH configuration, host-key verification, authentication, agents, certificates,
  and proxies to system OpenSSH;
- never intentionally persists passwords, private keys, passphrases, one-time codes, or API
  tokens;
- passes external command arguments without a local shell and validates remote tmux names;
- requires an authenticated OpenSSH ControlMaster before rclone SFTP operations;
- blocks HTTP(S) Markdown resources before the user allows the origin;
- sanitizes Markdown HTML and rejects `data:`, `javascript:`, and credential-bearing URLs;
- runs mpv with `--no-video --force-window=no --audio-display=no` and does not launch Finder,
  Quick Look, a browser, or a GUI media window;
- treats invalid configuration and workspace state as errors instead of silently replacing
  them;
- restores terminal ownership through OpenTUI renderer teardown on all controlled exits.

The release does not bundle OpenSSH, tmux, rclone, FFmpeg/ffprobe, mpv, or resvg. Vulnerabilities
inside those programs should normally be reported to their upstream projects, unless
TermLoom invokes them unsafely or bypasses an expected boundary.

## Release integrity

Release archives include a SHA-256 checksum and third-party license bundle. The macOS arm64
v0.1.0 artifact is ad-hoc signed and is **not notarized**. Verify the checksum and GitHub
release provenance before removing macOS quarantine metadata.

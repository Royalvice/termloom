# AGENTS.md

This file is the root operating contract for TermLoom.

## Mission

- Preserve the user-defined goal and acceptance boundaries as the highest-priority truth source.
- Keep the project recoverable from documents alone.
- Maintain truthful state, evidence, failures, and next-action visibility for future agents.

## Recovery Order

1. Read this file.
2. If the private local `.agent-os/` directory exists, read
   `.agent-os/project-index.md`, then its active items, then the newest relevant
   entries in `.agent-os/run-log.md`.
3. If `.agent-os/` is absent (as it is in public clones), read `README.md`,
   `docs/architecture.md`, `docs/configuration.md`, and the tests related to the
   requested change.
4. Dive deeper only as needed.

## Required Documents

When `.agent-os/` exists, it must remain Git-ignored and contain:

- `project-index.md`
- `requirements.md`
- `change-decisions.md`
- `architecture-milestones.md`
- `todo.md`
- `acceptance-report.md`
- `lessons-learned.md`
- `run-log.md`

## Non-Negotiable Rules

1. Do not change the user-defined goal, requirements, or acceptance meaning without an explicit human decision.
2. Record human decisions in `change-decisions.md` instead of silently rewriting the original requirements.
3. Use typed global item IDs across the document set.
4. Do not claim completion or verification without evidence.
5. Failed explorations and blocked paths must remain visible.
6. Keep exactly one global top next action in `project-index.md`.
7. If project documents are in Chinese, code comments and `print` output must still be in English.
8. TermLoom is a terminal-resident TUI, not a terminal application. Do not add
   a GUI shell, bundled terminal, or Ghostty-only dependency.
9. Reuse system OpenSSH, remote tmux, rclone, FFmpeg/ffprobe, mpv, resvg, and
   established parser/rendering libraries. Do not write a new SSH/SFTP/VT/media
   decoder.
10. Unsupported capabilities and missing dependencies are explicit errors. Do
    not silently launch Finder, Quick Look, a browser, or a GUI media window.
11. Never persist passwords, private keys, passphrases, one-time codes, or
    authentication tokens in configuration, state, logs, fixtures, or Git.
12. All terminal teardown paths must call the OpenTUI renderer's `destroy()`;
    never call `process.exit()` while the renderer still owns the terminal.

## Escalation Rules

Escalate to the human only when:

- a required human judgment is still unresolved
- a hard external blocker prevents progress
- repeated exploration has failed and progress has effectively stalled
- the user's stated constraints appear mutually incompatible

## Update Discipline

Update the state docs whenever there is a meaningful change in TODO state, evidence, blockers, milestones, or failed explorations.

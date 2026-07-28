## Outcome

Describe the user-visible result.

## Architecture and safety

- Which existing TermLoom boundary or reusable upstream component does this use?
- Does it change subprocesses, SSH/SFTP behavior, terminal modes, persistence, HTTP access, or
  media lifecycle?
- How are errors, cancellation, teardown, and redaction preserved?

## Verification

- [ ] `bun run check`
- [ ] `bun run build`
- [ ] `bun run verify:build`
- [ ] `git diff --check`
- [ ] Real-terminal evidence added when protocol behavior changed
- [ ] No credentials, private aliases/paths, `.agent-os/`, or local identity leaked
- [ ] Third-party license inventory regenerated when production dependencies changed

List exact commands, terminal/OS versions, and observed results.

## Remaining limitations

State anything not tested or intentionally outside the change. Do not mark inferred support as
verified.

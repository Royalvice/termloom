# Release process

TermLoom v0.3.0 publishes one macOS arm64 archive. Linux x64 and macOS x64 are hosted build/test
targets, not downloadable release targets. No npm package is published, and external tools are
not bundled.

v0.1.0 and v0.2.0 are immutable history. v0.3.0 uses a new annotated tag, new assets, and a new
GitHub Release; it must not force-move an earlier tag or overwrite an earlier asset.

## Release invariants

- The release commit is on `main`, pushed, and green in both hosted CI matrix jobs.
- `package.json`, CLI `--version`, doctor version, compiled verifier, tag, archive root,
  BUILDINFO, and Release title all say `0.3.0`.
- The worktree is clean before packaging.
- `.agent-os/`, credentials, private SSH aliases/paths, local usernames/hostnames, and private
  terminal captures are absent from Git history and archives.
- Frozen install, format, lint, TypeScript, licenses, complete tests, native build, compiled
  verifier, actionlint, whitespace checks, and the private project-state validator pass.
- The eight-row real-terminal matrix is complete from the release commit, and every row proves
  exact owned-process/socket cleanup.
- The archive contains the binary, MIT license, notices/licenses, README files, and BUILDINFO.
- The binary is ad-hoc signed and explicitly **not notarized**.
- A clean extraction and anonymous public download pass before the local installation is changed.

## 1. Inspect version, repository, and dependencies

```bash
bun --version
git status --short --branch
git log -1 --show-signature --format=fuller
rg -n '0\.2\.0|TermLoom 0\.2\.0' package.json src scripts README.md README.CN.md docs
```

Bun must match `packageManager` in `package.json` (v0.3.0 pins Bun 1.3.14).

```bash
bun install --frozen-lockfile
bun run licenses
bun run licenses:check
git diff -- THIRD_PARTY_LICENSES.txt THIRD_PARTY_NOTICES.md licenses package.json bun.lock
```

A changed dependency count is not automatically wrong, but every added/removed package and
license must be reviewed. Do not hard-code a historic package-count assertion in release notes.

## 2. Run the complete local gate

Run each gate explicitly so the failing stage is visible:

```bash
bun run format:check
bun run lint
bun run typecheck
bun run licenses:check
bun test
bun run build
bun run verify:build
actionlint .github/workflows/ci.yml
git diff --check
test -z "$(git ls-files .agent-os)"
git check-ignore -v .agent-os/project-index.md
```

Maintainers using Agent Project System must also run its validator against the repository.
`.agent-os/` is local-only and intentionally absent from public clones. If local policy requires
`CLAUDE.md` to be a hard link to `AGENTS.md`, verify content and inode identity before trusting
the private validator.

Inspect the compiled executable:

```bash
file dist/termloom
otool -L dist/termloom
dist/termloom --version
dist/termloom --help
dist/termloom doctor --json --no-terminal-probe
```

## 3. Complete real PTY and terminal evidence

First run the generated full workspace journey directly and through a dedicated outer tmux.
Every report must contain `ok: true`, all journey fields true, all cleanup fields true, and
`ownedProcessMatches: 0`.

Then run Ghostty, Kitty, WezTerm, and iTerm2 both direct and inside an isolated outer tmux. A
direct command shape is:

```bash
bun run scripts/terminal-workspace-probe.ts \
  --label ghostty-direct \
  --mode direct \
  --output /tmp/termloom-v030-ghostty-direct.json \
  --media on \
  --hold-ms 20000
```

The v0.3.0 journey must prove:

- Local/`$HOME` starts with zero SSH/tmux calls;
- Host selection opens only SFTP Files;
- Direct SSH performs no tmux discovery;
- Tmux discovery begins only after the explicit Tmux choice;
- colored adaptive read-only Files, click/double-click/right-click, menu dismissal, preview,
  paging/search/refresh, and F2 keepalive work;
- Local and remote source trees remain unchanged; a user-initiated remote file and directory
  download reaches an editable local destination, resolves name conflicts without overwrite,
  rejects selected links, and reports skipped nested links;
- Direct SSH automatically recovers from a non-zero exit through the shared ControlMaster while
  a normal exit stays detached until Enter or click;
- workspace v3 restart restoration works;
- Local and remote Markdown/image/GIF/MP4/formula paths work;
- renderer, ControlMaster, PTYs, FFmpeg, mpv, sshd, fixture, and tmux sockets are removed.

Record the dedicated terminal PID/window ID, inner/outer tmux socket/server/client, sshd,
ControlMaster, FFmpeg, mpv, and harness PID. Close only those exact resources. Never use broad
`killall`, `pkill`, or a user's existing tmux server.

Update [Terminal compatibility](terminal-compatibility.md) with the exact version, dimensions,
environment, adapter/protocol, structured report path, visual observation, and cleanup result for
all eight rows before the release commit.

## 4. Audit public history and private data

```bash
git ls-files -z | xargs -0 rg -n \
  '/Users/|\.agent-os|BEGIN (OPENSSH|RSA|EC|DSA) PRIVATE KEY|Authorization:|Bearer |api[_-]?key|token' || true
git log --all --format='%H%x09%an%x09%ae%x09%cn%x09%ce'
git log --all -p -- . ':!.agent-os' | rg -n \
  'BEGIN (OPENSSH|RSA|EC|DSA) PRIVATE KEY|Authorization: Bearer|xox[baprs]-|gh[pousr]_' || true
git fsck --full --no-reflogs
test -z "$(git ls-files .agent-os)"
```

Broad patterns intentionally produce documentation examples; inspect every match. The required
result is no credential, private Host alias, private remote path, local username/hostname, or
private evidence file in the tracked tree or reachable history.

## 5. Commit, push, and require hosted CI

```bash
git status --short
git diff --stat
git diff --check
git add --all
git commit -m 'release: TermLoom v0.3.0'
git push origin main
gh run list --workflow CI --branch main --limit 5
gh run watch RUN_ID --exit-status
```

Inspect both Linux x64 and macOS x64 jobs and download their native artifacts. Verify the Linux
artifact is ELF x86-64, the macOS artifact is Mach-O x86_64, and each reports TermLoom 0.3.0.
Workflow syntax or one green matrix job is not sufficient.

If hosted CI fails, fix the source/workflow, rerun the complete local gate, commit, push, and
watch the new run. Do not tag a known-bad commit.

## 6. Tag the release commit

Resolve and review the exact clean commit:

```bash
RELEASE_COMMIT="$(git rev-parse HEAD)"
test "$RELEASE_COMMIT" = "$(git rev-parse origin/main)"
git status --porcelain=v1
git tag -a v0.3.0 -m 'TermLoom v0.3.0' "$RELEASE_COMMIT"
git show --no-patch --decorate v0.3.0
git push origin refs/tags/v0.3.0
```

Do not use `-f` and do not modify v0.1.0 or v0.2.0.

## 7. Package macOS arm64

On the macOS arm64 release machine, from the clean tagged commit:

```bash
bun run build
bun run verify:build
bun run package:release -- --version 0.3.0
```

`package:release` refuses a dirty tree, wrong version/Bun/platform/architecture, missing input,
or existing output. It creates an isolated staging tree, ad-hoc signs a copy, verifies the
signature, writes BUILDINFO, creates the archive/checksum, checks required members, and removes
its temporary staging directory.

Expected outputs:

```text
dist/release/termloom-v0.3.0-darwin-arm64.tar.gz
dist/release/termloom-v0.3.0-darwin-arm64.tar.gz.sha256
```

## 8. Verify a clean extraction

Use a new exact temporary directory:

```bash
release_tmp="$(mktemp -d)"
cp dist/release/termloom-v0.3.0-darwin-arm64.tar.gz* "$release_tmp/"
cd "$release_tmp"
shasum -a 256 -c termloom-v0.3.0-darwin-arm64.tar.gz.sha256
tar -xzf termloom-v0.3.0-darwin-arm64.tar.gz
cd termloom-v0.3.0-darwin-arm64
codesign --verify --deep --strict --verbose=2 termloom
./termloom --version
./termloom --help
./termloom doctor --json --no-terminal-probe
```

Verify:

- BUILDINFO version, commit, platform, architecture, Bun version, signature, notarization, and
  binary SHA-256;
- archive tag commit equals BUILDINFO commit;
- `LICENSE`, `THIRD_PARTY_NOTICES.md`, and `THIRD_PARTY_LICENSES.txt` are present;
- a real local PTY starts/exits cleanly in isolated XDG state;
- strict read-only Local/SFTP Files, safe remote-to-local file/directory downloads, Direct SSH
  recovery, explicit Tmux, Markdown/media, and exact teardown pass using the packaged binary.

Save evidence before removing only the exact temporary directory.

## 9. Create the GitHub Release

Prepare reviewed release notes that include:

- strict read-only Local/SFTP file workspace and safe remote-to-local downloads;
- remote Files without automatic tmux or source mutation;
- Direct SSH/Tmux launcher, Direct SSH recovery, and lazy session discovery;
- Local/remote Markdown, image, GIF, MP4, and formula support;
- no Local or remote mutation command;
- macOS arm64 only;
- external dependencies;
- terminal matrix and known limitations;
- checksum command;
- **ad-hoc signed, not notarized**;
- no npm package and no bundled external tools;
- v0.1.0 and v0.2.0 remain unchanged.

Create the new Release and assets:

```bash
gh release create v0.3.0 \
  dist/release/termloom-v0.3.0-darwin-arm64.tar.gz \
  dist/release/termloom-v0.3.0-darwin-arm64.tar.gz.sha256 \
  --repo Royalvice/termloom \
  --title 'TermLoom v0.3.0' \
  --notes-file RELEASE_NOTES \
  --latest
```

Verify that the Release is public and both assets have non-zero size and GitHub digests. Never
use `--clobber` to change an already consumed immutable release without an explicit incident
process.

## 10. Anonymous public acceptance

Use another new directory outside the development checkout:

```bash
public_tmp="$(mktemp -d)"
git clone https://github.com/Royalvice/termloom.git "$public_tmp/source"
gh release download v0.3.0 --repo Royalvice/termloom --dir "$public_tmp/release"
```

From the anonymous clone:

- tag dereference, `main`, and BUILDINFO commit agree;
- `.agent-os/` and private data are absent;
- frozen install and the public project gate pass.

From the downloaded assets:

- published checksum, local SHA-256, and GitHub asset digest agree;
- archive extraction, codesign, version/help/doctor, real PTY, strict read-only Local/SFTP
  Files, safe downloads, Direct SSH recovery, explicit Tmux, media, and teardown pass again.

Also verify About text, topics, MIT license detection, default branch, CI badge, release link,
security policy, and README language links.

## 11. Atomically update the local installation

Only after anonymous public acceptance:

1. create a candidate beside the exact install target, on the same filesystem;
2. verify candidate hash equals the public extracted binary;
3. verify Mach-O arm64, ad-hoc signature, version/help, isolated doctor, and real PTY;
4. preserve the old installed binary as an exact backup;
5. atomically rename the candidate to the install path;
6. verify `command -v termloom`, `termloom --version`, codesign, and installed SHA-256;
7. remove only the exact backup/candidate after public and installed acceptance both pass.

Do not overwrite the current binary before the candidate is fully verified.

## Failure handling

- Before tagging: fix, rerun all gates, and create a new commit.
- After pushing a tag but before publishing: stop and inspect; do not move the tag merely to save
  time.
- After publishing: releases are immutable by default. Publish a corrected new version and
  document the incident rather than silently replacing assets.
- Never claim hosted CI, notarization, terminal support, smoke success, cleanup, or installed
  hash equality without the corresponding observed evidence.

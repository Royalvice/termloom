# Release process

This is the maintainer runbook for a public TermLoom release. v0.1.0 distributes one macOS
arm64 archive. Linux x64 and macOS x64 are build/test CI targets, not v0.1.0 binary download
targets. No npm package is published.

## Release invariants

- The release commit is on `main`, pushed, and has green GitHub-hosted Ubuntu 24.04 x64 and
  macOS 15 x64 CI.
- `package.json`, CLI `--version`, doctor runtime version, tag, archive name, and release title
  agree.
- `.agent-os/`, credentials, private SSH aliases, private remote paths, local hostnames, and
  local author email are absent from Git history and the archive.
- The terminal matrix states exactly which direct/tmux rows and visual evidence passed.
- `bun run check`, native build verification, actionlint, project-state validation, and Git
  whitespace checks pass from a clean worktree.
- The archive contains the MIT license, Bun notice, all generated production dependency
  licenses, build provenance, and an ad-hoc signed binary.
- Release notes say **ad-hoc signed, not notarized** and list external runtime dependencies.
- No Release is published until a clean extraction has been verified.

## 1. Update and inspect

Confirm the intended version and toolchain:

```bash
bun --version
git status --short --branch
git log -1 --show-signature --format=fuller
rg -n '0\.1\.0|TermLoom 0\.1\.0' package.json src scripts README.md README.CN.md docs
```

For v0.1.0, Bun must be 1.3.14. Review dependency changes and regenerate the license bundle:

```bash
bun install --frozen-lockfile
bun run licenses
bun run licenses:check
git diff -- THIRD_PARTY_LICENSES.txt THIRD_PARTY_NOTICES.md licenses package.json bun.lock
```

The generated file should contain 161 production package records for the v0.1.0 lockfile. A
changed count is not automatically wrong, but it requires dependency and license review.

## 2. Run the complete local gate

```bash
bun run check
bun run build
bun run verify:build
actionlint .github/workflows/ci.yml
git diff --check
python3 /path/to/agent-project-system/scripts/validate_project_system.py .
test -z "$(git ls-files .agent-os)"
git check-ignore -v .agent-os/project-index.md
```

The private project-state validator is a maintainer-local gate; public clones do not contain
`.agent-os/`. `AGENTS.md` is public. A local `CLAUDE.md` checkout must be a hard link to it;
history rewriting or checkout can change the inode and should be repaired locally before the
validator is trusted.

Inspect the compiled binary:

```bash
file dist/termloom
otool -L dist/termloom
dist/termloom --version
dist/termloom --help
dist/termloom doctor --json --no-terminal-probe
```

## 3. Complete real-terminal evidence

Run the generated-fixture harness in Ghostty, Kitty, WezTerm, and iTerm2, direct and inside
tmux. A representative direct command is:

```bash
bun run scripts/terminal-matrix-probe.ts \
  --label ghostty \
  --mode direct \
  --output /tmp/termloom-ghostty-direct.json \
  --hold-ms 20000
```

Every accepted JSON file must have `ok: true`, live OpenTUI provenance, a matching doctor and
showcase adapter, Markdown, decoded image, playing GIF, playing MP4, formula, fullscreen, and
the expected FFmpeg/mpv process kinds. Capture a visible current-code screenshot; black or
blank inactive-window captures are failures of evidence, not passes.

After every run, confirm the harness, FFmpeg, mpv, temporary fixture, and isolated tmux socket
were removed. Do not terminate the user's unrelated terminal or tmux sessions.

Update [Terminal compatibility](terminal-compatibility.md) with terminal versions, adapters,
protocols, date, structured result, visual evidence, and any still-pending row before the
release commit.

## 4. Public-history and secret audit

Review tracked files and all commits that will become public:

```bash
git ls-files -z | xargs -0 rg -n \
  '/Users/|\.agent-os|BEGIN (OPENSSH|RSA|EC|DSA) PRIVATE KEY|Authorization:|Bearer |api[_-]?key|token' || true
git log --all --format='%H%x09%an%x09%ae%x09%cn%x09%ce'
git log --all -p -- . ':!.agent-os' | rg -n \
  'BEGIN (OPENSSH|RSA|EC|DSA) PRIVATE KEY|Authorization: Bearer|xox[baprs]-|gh[pousr]_' || true
git fsck --full --no-reflogs
```

Broad patterns produce harmless documentation hits; inspect every match. The required outcome
is no credentials, private aliases/paths, or local hostname-derived email. Public documentation
may intentionally mention placeholder paths and security keywords.

Also verify:

```bash
test -z "$(git ls-files .agent-os)"
cmp -s AGENTS.md CLAUDE.md
stat -f '%i %N' AGENTS.md CLAUDE.md
```

`CLAUDE.md` and its hard-link relationship are local checkout policy; Git stores file content,
not inode identity.

## 5. Push and require green CI

```bash
git push origin main
gh run list --workflow CI --branch main --limit 5
gh run watch RUN_ID --exit-status
```

Inspect both matrix jobs and their uploaded native executables. Do not mark CI verified from
workflow syntax or local actionlint alone. If a hosted job fails, fix the source/workflow,
rerun the complete local gate, commit, push, and watch the new run.

## 6. Tag and package macOS arm64

On the macOS arm64 release machine, with the release commit checked out and a clean worktree:

```bash
bun run build
bun run verify:build
git tag -a v0.1.0 -m 'TermLoom v0.1.0'
bun run package:release -- --version 0.1.0
```

`package:release` refuses a dirty tree, wrong version, wrong Bun version, non-macOS/arm64 host,
missing licenses, or existing output. It copies the binary to an isolated staging directory,
ad-hoc signs the copy, verifies the signature, writes `BUILDINFO.json`, creates the archive,
checks required members, writes SHA-256, and removes staging state.

Expected outputs:

```text
dist/release/termloom-v0.1.0-darwin-arm64.tar.gz
dist/release/termloom-v0.1.0-darwin-arm64.tar.gz.sha256
```

The original `dist/termloom` remains a build input; the archive contains the separately signed
staging copy.

## 7. Verify a clean extraction

Use a new temporary directory and explicit archive path:

```bash
release_tmp="$(mktemp -d)"
cp dist/release/termloom-v0.1.0-darwin-arm64.tar.gz* "$release_tmp/"
cd "$release_tmp"
shasum -a 256 -c termloom-v0.1.0-darwin-arm64.tar.gz.sha256
tar -xzf termloom-v0.1.0-darwin-arm64.tar.gz
cd termloom-v0.1.0-darwin-arm64
codesign --verify --deep --strict --verbose=2 termloom
./termloom --version
./termloom --help
./termloom doctor --json --no-terminal-probe
```

Inspect `BUILDINFO.json`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, and
`THIRD_PARTY_LICENSES.txt`. Confirm the build commit equals the tagged commit.

The extracted binary must also receive a real-PTY smoke and a release-commit SSH/tmux/SFTP/
media smoke. The full integration suite already exercises those modules from the same locked
source; for artifact acceptance, launch the extracted binary in an isolated XDG environment,
confirm a local PTY starts and exits cleanly, then repeat the generated terminal matrix with
the release commit and external tools. Record both evidence sets. Do not substitute
`--no-terminal-probe` for the real media check.

Remove only the exact temporary directory after all evidence is saved. Never use an unresolved
or broad path in a recursive delete.

## 8. Publish tag and GitHub Release

Push the annotated tag only after extraction verification:

```bash
git push origin v0.1.0
gh release create v0.1.0 \
  dist/release/termloom-v0.1.0-darwin-arm64.tar.gz \
  dist/release/termloom-v0.1.0-darwin-arm64.tar.gz.sha256 \
  --repo Royalvice/termloom \
  --title 'TermLoom v0.1.0' \
  --notes-file /path/to/release-notes-v0.1.0.md
```

Release notes must include:

- terminal-resident OpenTUI product scope;
- SSH/tmux/SFTP/rich Markdown/media highlights;
- macOS arm64 target and external dependency list;
- terminal adapter matrix and any remaining limitation;
- checksum verification command;
- **ad-hoc signed, not notarized**;
- no npm package and no bundled external tools.

Verify GitHub reports both assets with non-zero sizes and that the release is public.

## 9. Public-install acceptance

Use a fresh directory outside the development checkout:

```bash
public_tmp="$(mktemp -d)"
git clone https://github.com/Royalvice/termloom.git "$public_tmp/source"
gh release download v0.1.0 --repo Royalvice/termloom --dir "$public_tmp/release"
```

From the clone, run frozen install and the full check. From the downloaded release, repeat
checksum, extraction, codesign, version/help/doctor, PTY, and external-service/media smoke.
Confirm `.agent-os/` is absent from clone and archive.

Finally verify repository About text, topics, license detection, default branch, Actions badge,
release link, security policy, and README language links.

## Failure handling

- Before publishing a tag, fix and rebuild; do not upload a known-bad archive.
- If a tag was pushed but no public release exists, prefer deleting and recreating it only
  when no user could reasonably depend on it, and document the action.
- If a public release is wrong, do not silently replace an asset under the same version. Mark
  it affected, publish a corrected version, and preserve an audit trail.
- Never claim notarization, hosted-CI success, terminal support, or smoke-test success without
  the corresponding observed evidence.

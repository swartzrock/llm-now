# Releasing llm-now

This document is for project maintainers. The public README is limited to information needed by users.

## Development prerequisites

Source development and release automation require Bun 1.3.14.

```bash
bun install --frozen-lockfile
bun run index.ts --help
bun test
bun run typecheck
```

Use the [manual testing guide](manual-testing.md) to validate native artifacts, provider integrations, aliases, and release candidates.

## Record release intent

Contributors record user-visible release intent with Changesets instead of editing the package version or changelog directly:

```bash
bun run changeset
bun run changeset:status
```

Select `llm-now`, choose `patch`, `minor`, or `major` for the user-visible impact, write a concise summary, and commit the generated `.changeset/*.md` file with the change. Documentation-only and maintenance-only pull requests do not need an empty Changeset.

Changesets is version-only in this repository. It does not publish to npm or create tags.

## Reviewed release train

Every push to `main` reconciles one bot-authored `chore: release` pull request from all pending Changesets. That pull request is the release review boundary: it bumps `package.json`, updates `CHANGELOG.md`, and consumes the pending Changeset files. Review all three parts before merging it.

The repository token creates the version pull request, so its normal `pull_request` CI runs appear in an approval-required state. A maintainer must approve those workflow runs and wait for the source checks and all five target checks to pass before merging. Do not merge a newer release pull request while the previous promotion is still building, awaiting protected approval, or publishing.

Merging the reviewed release pull request starts `.github/workflows/release.yml` directly. Its read-only classification job accepts only the exact push commit whose event `before` SHA is its first parent, whose stable package version increased, whose changelog has the matching version section, and whose diff consumed at least one Changeset. A normal non-release push with an unchanged version is a no-op; an incomplete or malformed version transition fails before promotion.

The same top-level workflow handles automatic promotion and manual recovery, so protected environment secrets resolve in the workflow context that owns the signing jobs. After classification, it:

1. Builds macOS x64, macOS ARM64, Linux x64 glibc, Linux ARM64 glibc, and Windows x64.
2. Uses the protected `release-signing` environment to sign and notarize both macOS executables.
3. Assembles the final archives, verifies `SHA256SUMS`, and prepares release notes from the matching changelog section.
4. Uses the protected `release-publication` environment to attest the five final archives.
5. Creates and verifies `vX.Y.Z` at the exact release SHA only after the final bytes and attestations are ready, then creates the GitHub Release.

`RELEASE_NOTES.md` travels inside the private `release-assets` workflow artifact and is passed to GitHub as release text. It is not a public downloadable release asset.

## Publication state and recovery

The release engine probes public state before building and again inside protected publication. It never deletes, moves, or overwrites a tag or Release.

| Existing state for `vX.Y.Z` | Result |
| --- | --- |
| No tag and no Release | Start new work only when no higher stable Release is already public. An untagged public run must also be a release-shaped first-parent transition. |
| Tag peels to the exact release SHA; no Release | Resume from that exact tag and create the Release after rebuilding and verifying the final assets. |
| Exact tag and complete non-draft, non-prerelease Release | Download all six assets, verify every checksum and archive attestation against the release workflow and exact source SHA, then return a no-op without mutation. |
| Tag points elsewhere, Release exists without its tag, assets are missing or extra, checksums fail, or provenance cannot be verified | Fail closed with no public mutation. Repair requires maintainer investigation; automation will not replace the conflicting state. |

For an unsigned candidate, manually dispatch `release.yml` with `publish: false` and a full lowercase `release-sha` that is any ancestor of protected `main`. The workflow builds all five native archives and `SHA256SUMS` without signing, attesting, tagging, or creating a Release. The selected workflow ref does not need to equal the candidate SHA.

For a manual `publish: true` run, the selected workflow ref and `release-sha` must resolve to the same exact commit (`release-sha == GITHUB_SHA`) so the attestations bind to the released source. If that commit has no exact tag, it must also pass the release-shaped first-parent classifier. If an automatic promotion fails before creating its tag and newer commits have since reached `main`, rerun the original automatic workflow run; do not dispatch from the newer `main` ref. If the exact tag exists without a Release, dispatch at the tag ref and pass its peeled commit as `release-sha`:

```bash
TAG=vX.Y.Z
RELEASE_SHA="$(git rev-parse "${TAG}^{commit}")"
gh workflow run release.yml --ref "$TAG" \
  -f release-sha="$RELEASE_SHA" \
  -f publish=true
```

Before the first release train run, confirm that Actions may create pull requests with the repository token, commission approval-required CI on the generated pull request, verify both protected environments and their reviewers, and ensure the publication actor may create `v*` tags while unauthorized actors cannot move or delete them. Complete [MT-25 through MT-29](manual-testing.md#mt-25-first-generated-release-pr-ci) before treating the train as commissioned.

## Distribution status

Public releases contain these five self-contained archives:

- `llm-now-v<version>-macos-x64.zip`
- `llm-now-v<version>-macos-arm64.zip`
- `llm-now-v<version>-linux-x64.zip` (glibc, not Alpine/musl)
- `llm-now-v<version>-linux-arm64.zip` (glibc, not Alpine/musl)
- `llm-now-v<version>-windows-x64.zip` (unsigned early access)

Each archive contains one executable. macOS archives are signed and notarized; Linux and Windows archives are unsigned. All five pass their native checks, match `SHA256SUMS`, and receive GitHub artifact attestations for the final downloadable bytes. The six public assets are exactly those five ZIP files plus `SHA256SUMS`.

A public promotion is allowed only when the repository is public and eligible to issue GitHub artifact attestations. Publication retains protected environment approval, exact-SHA tag verification, fail-closed state reconciliation, and the macOS signing boundary.

Verify each downloaded archive against the release workflow and the exact tag/dispatch commit recorded as the release source digest:

```bash
gh attestation verify <archive.zip> \
  --repo swartzrock/llm-now \
  --signer-workflow swartzrock/llm-now/.github/workflows/release.yml \
  --source-digest <release-source-digest>
```

Before authorizing the first public release through this train, complete the [release workflow commissioning tests](manual-testing.md#release-workflow).

Homebrew and Chocolatey integration is intentionally deferred. A custom Homebrew tap and a Chocolatey package may be added later if adoption justifies their ongoing maintenance; neither package manager is part of the current CI or release workflow.

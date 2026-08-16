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

Select each package whose public contract changes, choose the semver impact, write a concise summary, and commit the generated `.changeset/*.md` file with the change. A CLI-only change selects `llm-now`. A core-only change selects `@swartzrock/llm-now-core`. A shared change must explicitly select both packages; the packages are not fixed or linked, so selecting one never induces a bump in the other. Documentation-only and orchestration-only pull requests do not need an empty Changeset.

Core uses pre-1.0 semver. Its current `0.1.0` is the unreleased extracted
version; a compatible fix bumps `0.1.0` to `0.1.1`, while an incompatible
public API change bumps `0.1.x` to `0.2.0`. The CLI remains on its independent
stable `2.x` line.

The Changesets action is version-only. It creates the reviewed release pull
request but does not publish bytes or create a tag. Publication belongs to one
of the separate release lanes below.

## Two product release lanes

### Core package release lane

A core version transition on protected `main` starts
`.github/workflows/release-core.yml`. Its classifier accepts only the exact
first-parent transition that consumes a core Changeset and changes the core
package version and changelog consistently. A CLI-only, orchestration-only, or
ordinary push is a no-op.

The **unprivileged artifact** job checks out the exact release SHA, performs a
frozen install, builds the core, and runs the maintained package verifier. It
preserves exactly two files: `swartzrock-llm-now-core-X.Y.Z.tgz` and
`SHA256SUMS`. The one-line checksum must validate, and the tarball must retain
the private package identity, exact version, export surface, Node 20 floor, Bun
1.3.14 floor, and TypeScript NodeNext declarations.

The **protected publisher** runs in `release-publication`. It downloads only
the current run's preserved artifact, repeats the checksum and manifest checks,
and creates the action artifact attestation. It then owns only the exact
`core-vX.Y.Z` tag, a draft Release titled `core-vX.Y.Z`, and the exact two-asset
allowlist. It publishes the non-prerelease Release with `--latest=false`, then
downloads the public assets and verifies their checksum, the action attestation,
and the repository's immutable-Release attestations. It never builds a native
archive, runs signing, changes Homebrew, or claims the repository's latest
Release.

The package manifest's `private: true` prevents npm publication; it does not
make a public repository private. Source and GitHub Release assets remain
public. `npm pack` is artifact construction only, used by the maintained
verifier to build the npm-format tarball. A downstream install may still fetch
transitive dependencies from configured package registries.

### Native CLI release lane

A CLI version transition on `main` starts `.github/workflows/release.yml`. The
native lane reads version and changelog identity only from `packages/cli`, then
builds, signs, attests, publishes, and projects the five native archives as
documented below. A core-only release cannot trigger this lane. Existing CLI
manual tests and distribution behavior are unchanged. Native owns `vX.Y.Z`
tags and the repository's latest Release. Core owns `core-vX.Y.Z` and always
publishes with `--latest=false`; a core Release can neither satisfy nor replace
native latest-Release state.

## First GitHub core Release

The first GitHub core Release is an explicit maintainer go/no-go operation.

1. Merge the ordinary Changesets version pull request that advances core
   `0.1.0` to `0.1.1`, consumes the core-only patch Changeset, adds the matching
   changelog section, and leaves the CLI version unchanged unless separate
   release intent selects it. Its merge is the first GitHub core Release
   transition.
2. In repository settings, enable repository-level immutable Releases. Accept
   that this repository-wide setting applies to future native and core
   Releases and does not retroactively change existing Releases.
3. Configure the protected `release-publication` environment to admit protected
   `main`. Deny feature branches and pull-request refs. Add the intended
   required reviewers if publication should require approval. Add an environment secret named
   `CORE_RELEASE_SETTINGS_TOKEN` containing a fine-grained GitHub token limited
   to this repository with only **Administration: read** permission. The
   publisher uses it only to fail closed when checking that immutable Releases
   are enabled; keep Contents and every write permission disabled, set an
   expiry, and rotate it before expiry.
4. Confirm repository rules let the publication actor create `core-v*` tags but
   prevent unauthorized movement or deletion. Keep native `v*` ownership and
   latest-Release behavior unchanged.
5. Record the version pull request's merge SHA, first parent, and the current
   native latest tag. Confirm no `core-v0.1.1` tag or Release exists.
6. Confirm the unprivileged artifact contains the exact two-asset set, its
   checksum validates, its pack allowlist and private manifest are correct, and
   the maintained Node, Bun, and NodeNext smokes pass.
7. Before approving `release-publication`, confirm the candidate digest, source
   SHA, tag, changelog notes, signer workflow, draft Release plan, and
   `--latest=false` all agree. This is the last safe stop.
8. After publication, verify `core-v0.1.1` targets the recorded merge SHA, is
   immutable, non-draft, non-prerelease, and contains only the tarball plus
   `SHA256SUMS`. Verify both attestations and confirm the repository's latest
   Release is still a stable native tag, either unchanged or advanced.

**No-go:** stop if any protected setting or recorded identity is unknown; the
tag or Release already exists; the candidate, checksum, changelog, tag SHA,
asset set, or attestation differs; the Release would be mutable, prerelease, or
latest; or the native lane would be entered without explicit CLI release
intent.

### Core publication and failure handling

An automatic `main` push publishes only a release-shaped first-parent core
version transition. Manual `workflow_dispatch` defaults to `publish: false`,
which builds and verifies the selected full lowercase `release-sha` without
creating an attestation, tag, or Release. Manual publication requires the
selected workflow ref and `release-sha` to identify the same exact commit.

Core publication is forward-only. The publisher requires a new tag, creates one
draft with the exact two assets, publishes it once, and verifies the resulting
immutable Release. If the tag or Release already exists, automation refuses
publication instead of trying to infer or repair previous state.

Manual publication remains an exact-SHA escape hatch while protected `main`
still resolves to that commit:

```bash
RELEASE_SHA="$(git rev-parse origin/main)"
gh workflow run release-core.yml --ref main \
  -f release-sha="$RELEASE_SHA" \
  -f publish=true
```

Use this only when the selected workflow ref and `release-sha` identify the
same release-shaped commit and no tag or Release exists.

Failure handling is intentionally operational instead of another release state
machine:

- If the run fails before creating a tag or draft, rerun the original automatic
  workflow run at the recorded release SHA.
- If it stops after creating a tag or draft but before publication, preserve
  evidence and inspect the remote state. Manual cleanup may delete that
  unpublished draft and then its exact tag before rerunning the original run.
  Never clean up state whose identity or publication status is uncertain.
- If publication completed or may have completed, do not delete or replace it.
  Verify the public bytes. If they are incomplete or wrong, use a reviewed
  higher patch Changeset to fix-forward.

An existing immutable Release is verified with the documented checksum and
attestation commands, not by rerunning the publishing workflow.

Never rerun the historical `publish-core` npm workflow and never add credentials to make it pass.

For every core Release, retain the source SHA, tag, Release URL, tarball digest,
two-asset allowlist, checksum result, action and immutable-Release attestation
identities, Node/Bun/NodeNext results, protected-environment approval, and
native latest result. Recheck the exact public bytes and identities
immediately and after 24 hours.

## Native CLI reviewed release train

Every push to `main` reconciles one bot-authored `chore: release` pull request from all pending Changesets. That pull request is the release review boundary: it bumps the selected package manifests, updates their changelogs, and consumes the pending Changeset files. Review every selected package and consumed Changeset before merging it.

The repository token creates the version pull request, so its normal `pull_request` CI runs appear in an approval-required state. A maintainer must approve those workflow runs and wait for the source checks and all five target checks to pass before merging. Do not merge a newer release pull request while the previous promotion is still building, awaiting protected approval, or publishing.

For a CLI version transition, merging the reviewed release pull request starts
`.github/workflows/release.yml` directly. Its read-only classification job
accepts only the exact push commit whose event `before` SHA is its first parent,
whose stable CLI package version increased, whose CLI changelog has the matching
version section, and whose diff consumed at least one Changeset. A core-only or
normal non-release push with an unchanged CLI version is a no-op; an incomplete
or malformed CLI version transition fails before promotion.

The same top-level workflow handles automatic promotion and manual recovery, so protected environment secrets resolve in the workflow context that owns the signing jobs. After classification, it:

1. Builds macOS x64, macOS ARM64, Linux x64 glibc, Linux ARM64 glibc, and Windows x64.
2. Uses the protected `release-signing` environment to sign and notarize both macOS executables.
3. Assembles the final archives, verifies `SHA256SUMS`, and prepares release notes from the matching changelog section.
4. Uses the protected `release-publication` environment to attest the five final archives.
5. Creates and verifies `vX.Y.Z` at the exact release SHA only after the final bytes and attestations are ready, then creates the GitHub Release.
6. Enters the `homebrew-publication` environment, downloads and reverifies that public Release, and reconciles its four-platform formula into `swartzrock/homebrew-tap/main`.

`RELEASE_NOTES.md` travels inside the private `release-assets` workflow artifact and is passed to GitHub as release text. It is not a public downloadable release asset.

## Publication state and recovery

The release engine probes public state before building and again inside protected publication. It never deletes, moves, or overwrites a tag or Release.

| Existing state for `vX.Y.Z` | Result |
| --- | --- |
| No tag and no Release | Start new work only when no higher stable Release is already public. An untagged public run must also be a release-shaped first-parent transition. |
| Tag peels to the exact release SHA; no Release | Resume from that exact tag and create the Release after rebuilding and verifying the final assets. |
| Exact tag and complete non-draft, non-prerelease Release | Download all six assets, verify every checksum and archive attestation against the release workflow and exact source SHA, skip build and GitHub publication mutation, then reconcile the Homebrew projection. |
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

## Homebrew projection setup and recovery

The GitHub Release remains authoritative. Homebrew synchronization is a post-publication projection: it downloads the exact six public assets, verifies the manifest and all five archive attestations against the validated release SHA, renders the complete four-platform formula, and reads the live tap formula before any write. A Homebrew failure may fail the workflow run, but it never deletes, recreates, edits, or moves the tag, Release, assets, checksum manifest, or attestations.

Create a fine-grained personal access token that selects only `swartzrock/homebrew-tap`. Grant repository **Contents: Read and write** and no Workflow, Administration, Actions, organization, or `swartzrock/llm-now` access. GitHub may display its mandatory Metadata read permission. Contents write cannot be restricted to one path, so the token retains authority over every non-workflow file in the tap even though the workflow targets only `Formula/llm-now.rb`.

Create the `homebrew-publication` environment in `swartzrock/llm-now` and store the token as `HOMEBREW_TAP_TOKEN`. Restrict environment deployments to protected `main` and trusted stable `v*` tags; feature branches and pull-request refs must not receive its secrets. Keep the environment reviewer-free by default so release projection remains automatic. Maintainers may add a reviewer later as a stricter operational policy, accepting that every fresh projection and exact-tag recovery will then wait for approval.

Before commissioning, inspect `swartzrock/homebrew-tap/main` branch protection and repository rules while authenticated. The fine-grained identity must be allowed to update `Formula/llm-now.rb` directly. If the tap requires pull requests or otherwise rejects that identity, stop; do not broaden the token or bypass the rule ad hoc.

The Homebrew job reports one of four dispositions:

- `updated`: one blob-SHA-guarded write was read back as the exact desired bytes.
- `already-current`: the first read or the single post-write read already equals the desired formula.
- `failed-before-write`: public verification, formula validation, tap classification, credential validation, or authorization failed before an update request.
- `write-outcome-unconfirmed`: a write was attempted but the single read-back did not prove exact desired bytes.

Same-version drift, a newer tap version, or missing or invalid tap content is never overwritten. After an attempted write, the job always reads once and never issues a second write in that run. Receipts include validated tag and source SHA plus the constant tap identity; HTTP status and GitHub request ID are nullable because a transport failure may provide neither. Diagnostics must not contain formulas, manifests, response bodies, headers, or credentials.

After a Homebrew failure, first use the normal workflow rerun window. Later, recover by dispatching the exact stable tag whose peeled commit produced the Release, using the command in [Publication state and recovery](#publication-state-and-recovery). The run reverifies the existing public Release, skips build and GitHub publication mutation, and retries only the Homebrew projection. This recovery exists only for tags whose committed `.github/workflows/release.yml` already contains the Homebrew job. Historical tags such as `v2.2.0` predate that job and cannot live-commission or recover it.

Complete [MT-39 through MT-41](manual-testing.md#mt-39-static-public-v220-formula-baseline) to commission the baseline, first write, credential boundary, and exact-tag recovery.

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

Native credential storage is enabled only for an explicit release-target entry pinned to Bun 1.3.14. Every matching CI and release-candidate native job must compile the production adapter and pass its real missing, set/get, replace/get, delete, and final-missing lifecycle before uploading an archive. Run the same gate locally with:

```bash
bun scripts/release-validate.ts secrets TARGET_ID
```

Use one exact target ID from the table below. The gate verifies that ID against the current host and compiles the probe for the same Bun target as the archive. The probe uses unique synthetic identities and values, prints stage names only, and must clean up even after an intermediate failure. Linux jobs must run it in an isolated D-Bus session with an unlocked Secret Service test collection. A missing gate, skipped failure, Bun pin mismatch, host/target mismatch, unsupported target entry, or incomplete cleanup blocks release; do not infer support from the operating-system name alone.

If a native backend regresses, set that target's explicit compatibility entry to disabled and remove it from the workflow's enabled-gate list. Keep its native build job: the archive remains environment-only and existing native records are left untouched.

| Release target | Native backend | Policy |
| --- | --- | --- |
| macOS ARM64 | Keychain | Enabled behind the compiled lifecycle gate |
| macOS x64 | Keychain | Disabled after Bun 1.3.14 failed the compiled lifecycle gate; build environment-only |
| Linux x64 / ARM64 glibc | Secret Service | Enabled behind the compiled lifecycle gate and an available user session |
| Windows x64 baseline | Credential Manager | Enabled behind the compiled lifecycle gate |


The source release workflow projects each verified public Release into the four-platform formula in [swartzrock/homebrew-tap](https://github.com/swartzrock/homebrew-tap). Chocolatey integration remains deferred.

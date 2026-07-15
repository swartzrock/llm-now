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

## Distribution status

The repository builds and tests self-contained archives for macOS x64/ARM64, glibc Linux x64/ARM64, and Windows x64. Each archive contains one executable and is covered by the release checksum manifest.

Public distribution currently includes only signed and notarized macOS x64 and ARM64 archives. Linux and Windows remain CI-covered and are included in unsigned release-candidate testing, but are not public release assets yet.

Homebrew and Chocolatey integration is intentionally deferred. A custom Homebrew tap and a Chocolatey package may be added later if adoption justifies their ongoing maintenance; neither package manager is part of the current CI or release workflow.

## GitHub Environments

Create two protected GitHub Environments:

- `release-signing`: stores the Apple signing identity, base64 PKCS#12 certificate and password, and notarization Apple ID/team/app password. A required reviewer gates the signing jobs but cannot view the environment secrets.
- `release-publication`: stores no signing credentials; it provides a separate final approval before creating the GitHub Release after macOS signing and asset validation pass.

For both environments:

1. Set **Deployment branches and tags** to **Selected branches and tags**.
2. Allow only the `main` branch.
3. Configure required reviewers.
4. Disable administrator bypass when that option is available.

Environment secrets cannot be read back from GitHub after they are saved. Approval allows the protected workflow job to use them on its ephemeral GitHub-hosted runner, so branch protection and review of release-workflow changes remain part of the signing-key security boundary. The workflow also rejects dispatches whose workflow ref is not `main`, but the environment rule is the security boundary because a branch can modify its own workflow.

## Release candidates

Start the `Release candidate` GitHub Actions workflow manually from `main` using an existing `v<package-version>` tag reachable from `main`.

- `publish: false` builds unsigned artifacts for every supported target without publishing anything.
- `publish: true` builds, signs, notarizes, and publishes only the macOS x64 and ARM64 archives.

The macOS CI executable is ad-hoc signed so its code signature is structurally valid, but an unsigned `publish: false` artifact is not Apple-notarized. After verifying its checksum, macOS testers must remove browser quarantine as described in the [manual testing guide](manual-testing.md). A `publish: true` release must pass Gatekeeper without that workaround.

Protect release tags from mutation. Every release job checks out the commit SHA established by the initial tag/version/main-ancestry gate, and publication rechecks that the tag still resolves to that SHA. Publication fails rather than updating an existing GitHub Release, preventing stale Windows or Linux assets from remaining attached to a Mac-only release. Missing Apple credentials fail the authorized signing job with the missing secret's name; they do not weaken pull-request verification or publish partial assets.

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

Public releases contain these five self-contained archives:

- `llm-now-<version>-macos-x64.zip`
- `llm-now-<version>-macos-arm64.zip`
- `llm-now-<version>-linux-x64.zip` (glibc, not Alpine/musl)
- `llm-now-<version>-linux-arm64.zip` (glibc, not Alpine/musl)
- `llm-now-<version>-windows-x64.zip` (unsigned early access)

Each archive contains one executable. macOS archives are signed and notarized; Linux and Windows archives are unsigned. All five pass their native checks, match `SHA256SUMS`, and receive GitHub artifact attestations for the final downloadable bytes.

A public dispatch is allowed only when the repository is public and eligible to issue GitHub artifact attestations. The version tag must resolve to the exact protected-`main` commit used to dispatch the workflow; being an older ancestor of `main` is insufficient. Publication retains the protected environment approval, remote tag verification, duplicate-release refusal, and macOS signing boundary.

Verify each downloaded archive against the release workflow and the exact tag/dispatch commit recorded as the release source digest:

```bash
gh attestation verify <archive.zip> \
  --repo swartzrock/llm-now \
  --signer-workflow swartzrock/llm-now/.github/workflows/release.yml \
  --source-digest <release-source-digest>
```

Before authorizing the first public release that includes Linux and Windows, complete [MT-25](manual-testing.md#mt-25-first-public-cross-platform-release).

Homebrew and Chocolatey integration is intentionally deferred. A custom Homebrew tap and a Chocolatey package may be added later if adoption justifies their ongoing maintenance; neither package manager is part of the current CI or release workflow.

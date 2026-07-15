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


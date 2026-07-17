import { extractChangelogSection, validateCommitSha } from "./release-plan.ts";

export { extractChangelogSection } from "./release-plan.ts";

export function renderReleaseNotes(changelog: string, version: string, sourceDigest: string): string {
  validateCommitSha(sourceDigest, "source digest");
  const section = extractChangelogSection(changelog, version);
  return `## Choose an asset

- macOS x64 and ARM64 archives are signed and notarized.
- Linux x64 and ARM64 archives require glibc; musl and Alpine are not supported.
- Windows x64 is unsigned early access.

Windows may show a SmartScreen warning and, where policy permits, offer a manual **Run anyway** path. Smart App Control or enterprise policy may block execution with no user bypass. Do not weaken or disable security controls to run llm-now.

## Verify the download

Download one archive and \`SHA256SUMS\`, then verify only that archive's manifest entry.

macOS:

\`\`\`sh
ARCHIVE=<downloaded-archive.zip>
grep "  $ARCHIVE$" SHA256SUMS | shasum -a 256 -c -
\`\`\`

Linux:

\`\`\`sh
ARCHIVE=<downloaded-archive.zip>
grep "  $ARCHIVE$" SHA256SUMS | sha256sum --check -
\`\`\`

Windows PowerShell:

\`\`\`powershell
$Archive = "<downloaded-archive.zip>"
$ChecksumLines = @(Get-Content SHA256SUMS | Where-Object { $_.EndsWith("  $Archive") })
if ($ChecksumLines.Count -ne 1) { throw "Expected one checksum for $Archive" }
$Expected = ($ChecksumLines[0] -split '\\s+')[0].ToLowerInvariant()
$Actual = (Get-FileHash $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($Expected -ne $Actual) { throw "SHA-256 mismatch for $Archive" }
\`\`\`

Verify each archive's provenance against this repository, release workflow, and exact source digest:

\`\`\`sh
gh attestation verify <downloaded-archive.zip> --repo swartzrock/llm-now --signer-workflow swartzrock/llm-now/.github/workflows/release.yml --source-digest ${sourceDigest}
\`\`\`

Release source digest: \`${sourceDigest}\`

## Release notes

${section}
`;
}

async function main(): Promise<void> {
  const [version, sourceDigest, changelogPath, outputPath] = process.argv.slice(2);
  if (!version || !sourceDigest || !changelogPath || !outputPath) {
    throw new Error("usage: bun scripts/release-notes.ts <version> <source-sha> <changelog> <output>");
  }
  const changelog = await Bun.file(changelogPath).text();
  await Bun.write(outputPath, renderReleaseNotes(changelog, version, sourceDigest));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

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

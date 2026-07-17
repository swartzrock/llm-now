import { appendFile } from "node:fs/promises";

export interface PackageIdentity {
  name: string;
  version: string;
}

export interface ChangedFile {
  status: string;
  path: string;
}

export interface ReleaseTransitionInput {
  beforePackage: PackageIdentity;
  afterPackage: PackageIdentity;
  beforeSha: string;
  afterSha: string;
  firstParentSha: string;
  changedFiles: readonly ChangedFile[];
  changelog: string;
}

export interface ReleasePlan {
  shouldRelease: boolean;
  releaseSha: string;
}

const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const shaPattern = /^[a-f0-9]{40}$/;

export function parseStableVersion(version: string): readonly [bigint, bigint, bigint] {
  const match = stableVersionPattern.exec(version);
  if (!match) throw new Error(`version ${JSON.stringify(version)} must be stable X.Y.Z`);
  return [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)];
}

export function compareStableVersions(left: string, right: string): number {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index]! > rightParts[index]!) return 1;
    if (leftParts[index]! < rightParts[index]!) return -1;
  }
  return 0;
}

export function extractChangelogSection(changelog: string, version: string): string {
  parseStableVersion(version);
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const heading = `## ${version}`;
  const matches = lines.flatMap((line, index) => line === heading ? [index] : []);
  if (matches.length !== 1) {
    throw new Error(`CHANGELOG.md must contain exactly one ${heading} heading`);
  }
  const start = matches[0]!;
  const adjacent = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  const section = lines.slice(start, adjacent === -1 ? undefined : adjacent).join("\n").trimEnd();
  if (section === heading) throw new Error(`${heading} changelog section must not be empty`);
  return section;
}

export function validateCommitSha(sha: string, label: string): void {
  if (!shaPattern.test(sha)) throw new Error(`${label} must be a full lowercase commit SHA`);
}

export function classifyReleaseTransition(input: ReleaseTransitionInput): ReleasePlan {
  validateCommitSha(input.beforeSha, "before SHA");
  validateCommitSha(input.afterSha, "after SHA");
  validateCommitSha(input.firstParentSha, "first parent SHA");
  if (/^0{40}$/.test(input.beforeSha)) throw new Error("before SHA cannot be the zero SHA");
  if (input.beforeSha !== input.firstParentSha) {
    throw new Error("push before SHA must equal the release commit's first parent");
  }
  if (input.beforePackage.name !== input.afterPackage.name) {
    throw new Error("package name must not change during a release transition");
  }

  const comparison = compareStableVersions(input.afterPackage.version, input.beforePackage.version);
  if (comparison === 0) {
    return {
      shouldRelease: false,
      releaseSha: input.afterSha,
    };
  }
  if (comparison < 0) throw new Error("package version must increase during a release transition");

  const changed = new Set(input.changedFiles.map((file) => file.path));
  if (!changed.has("package.json")) throw new Error("release transition must modify package.json");
  if (!changed.has("CHANGELOG.md")) throw new Error("release transition must modify CHANGELOG.md");
  const consumedChangeset = input.changedFiles.some((file) =>
    file.status === "D" && /^\.changeset\/.+\.md$/.test(file.path) && file.path !== ".changeset/README.md"
  );
  if (!consumedChangeset) throw new Error("release transition must delete a consumed Changeset");

  extractChangelogSection(input.changelog, input.afterPackage.version);

  return {
    shouldRelease: true,
    releaseSha: input.afterSha,
  };
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trimEnd();
}

function packageAt(cwd: string, revision: string): PackageIdentity {
  let value: unknown;
  try {
    value = JSON.parse(git(cwd, ["show", `${revision}:package.json`]));
  } catch (error) {
    throw new Error(`could not read package.json at ${revision}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object") throw new Error(`package.json at ${revision} must be an object`);
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || typeof record.version !== "string") {
    throw new Error(`package.json at ${revision} must contain string name and version fields`);
  }
  return { name: record.name, version: record.version };
}

function changedFiles(cwd: string, beforeSha: string, afterSha: string): ChangedFile[] {
  const output = git(cwd, ["diff", "--name-status", "--no-renames", beforeSha, afterSha]);
  if (!output) return [];
  return output.split("\n").map((line) => {
    const separator = line.indexOf("\t");
    if (separator === -1) throw new Error(`could not parse git diff entry: ${line}`);
    return { status: line.slice(0, separator), path: line.slice(separator + 1) };
  });
}

export function planRelease(beforeSha: string, afterSha: string, cwd = process.cwd()): ReleasePlan {
  validateCommitSha(beforeSha, "before SHA");
  validateCommitSha(afterSha, "after SHA");
  const firstParentSha = git(cwd, ["rev-parse", `${afterSha}^1`]);
  const beforePackage = packageAt(cwd, beforeSha);
  const afterPackage = packageAt(cwd, afterSha);
  const versionChanged = beforePackage.version !== afterPackage.version;
  return classifyReleaseTransition({
    beforePackage,
    afterPackage,
    beforeSha,
    afterSha,
    firstParentSha,
    changedFiles: versionChanged ? changedFiles(cwd, beforeSha, afterSha) : [],
    changelog: versionChanged ? git(cwd, ["show", `${afterSha}:CHANGELOG.md`]) : "",
  });
}

export async function writeGithubOutput(plan: ReleasePlan, outputPath: string): Promise<void> {
  await appendFile(outputPath, [
    `should-release=${plan.shouldRelease}`,
    `release-sha=${plan.releaseSha}`,
    "",
  ].join("\n"));
}

async function main(): Promise<void> {
  const [beforeSha, afterSha, explicitOutput] = process.argv.slice(2);
  if (!beforeSha || !afterSha) {
    throw new Error("usage: bun scripts/release-plan.ts <before-sha> <after-sha> [github-output]");
  }
  const outputPath = explicitOutput ?? process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required");
  await writeGithubOutput(planRelease(beforeSha, afterSha), outputPath);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

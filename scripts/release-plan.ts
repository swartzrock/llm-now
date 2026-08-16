import { appendFile } from "node:fs/promises";

export interface PackageIdentity {
  name: string;
  version: string;
  private?: boolean;
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

export interface CoreReleaseTransitionInput extends ReleaseTransitionInput {
  beforeCliPackage: PackageIdentity;
  afterCliPackage: PackageIdentity;
  intendedCoreVersion: string | null;
}

export interface CoreReleasePlan extends ReleasePlan {
  packageName: string;
  version: string;
}

const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const shaPattern = /^[a-f0-9]{40}$/;
const corePackageName = "@swartzrock/llm-now-core";
const cliPackagePath = "packages/cli/package.json";
const legacyCliPackagePath = "package.json";
const cliChangelogPath = "packages/cli/CHANGELOG.md";
const corePackagePath = "packages/core/package.json";
const coreChangelogPath = "packages/core/CHANGELOG.md";

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
  if (!changed.has(cliPackagePath)) {
    throw new Error(`release transition must modify ${cliPackagePath}`);
  }
  if (!changed.has(cliChangelogPath)) {
    throw new Error(`release transition must modify ${cliChangelogPath}`);
  }
  if (!hasConsumedChangeset(input.changedFiles)) {
    throw new Error("release transition must delete a consumed Changeset");
  }

  extractChangelogSection(input.changelog, input.afterPackage.version);

  return {
    shouldRelease: true,
    releaseSha: input.afterSha,
  };
}

function hasConsumedChangeset(changedFiles: readonly ChangedFile[]): boolean {
  return consumedChangesetPaths(changedFiles).length > 0;
}

function consumedChangesetPaths(changedFiles: readonly ChangedFile[]): string[] {
  return changedFiles.flatMap((file) =>
    file.status === "D"
    && /^\.changeset\/.+\.md$/.test(file.path)
    && file.path !== ".changeset/README.md"
      ? [file.path]
      : []
  );
}

export function classifyCoreReleaseTransition(
  input: CoreReleaseTransitionInput,
): CoreReleasePlan {
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
  if (input.afterPackage.name !== corePackageName) {
    throw new Error(`core release package name must be ${corePackageName}`);
  }
  if (input.afterPackage.private === true) throw new Error("core release package must be public");
  if (input.beforeCliPackage.name !== input.afterCliPackage.name) {
    throw new Error("CLI package name must not change during a core release transition");
  }

  const comparison = compareStableVersions(input.afterPackage.version, input.beforePackage.version);
  const plan = {
    releaseSha: input.afterSha,
    packageName: input.afterPackage.name,
    version: input.afterPackage.version,
  };
  if (comparison === 0) return { ...plan, shouldRelease: false };
  if (comparison < 0) throw new Error("package version must increase during a release transition");

  const changed = new Set(input.changedFiles.map((file) => file.path));
  if (!changed.has(corePackagePath)) {
    throw new Error(`release transition must modify ${corePackagePath}`);
  }
  if (!changed.has(coreChangelogPath)) {
    throw new Error(`release transition must modify ${coreChangelogPath}`);
  }
  if (!hasConsumedChangeset(input.changedFiles)) {
    throw new Error("release transition must delete a consumed Changeset");
  }
  if (input.intendedCoreVersion === null) {
    throw new Error(`consumed Changesets must explicitly select ${corePackageName}`);
  }
  parseStableVersion(input.intendedCoreVersion);
  if (input.afterPackage.version !== input.intendedCoreVersion) {
    throw new Error(
      `Changeset intent requires core version ${input.intendedCoreVersion}, found ${input.afterPackage.version}`,
    );
  }
  extractChangelogSection(input.changelog, input.afterPackage.version);
  return { ...plan, shouldRelease: true };
}

type ReleaseType = "patch" | "minor" | "major";

const releaseTypePriority: Record<ReleaseType, number> = {
  patch: 0,
  minor: 1,
  major: 2,
};

function malformedChangeset(path: string, detail: string): never {
  throw new Error(`${path} has malformed Changeset frontmatter: ${detail}`);
}

function parseChangesetPackageKey(rawKey: string, path: string): string {
  if (rawKey.startsWith('"')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawKey);
    } catch {
      return malformedChangeset(path, "invalid quoted package key");
    }
    if (typeof parsed !== "string" || parsed.length === 0) {
      return malformedChangeset(path, "package key must be a non-empty string");
    }
    return parsed;
  }
  if (rawKey.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(rawKey)) {
      return malformedChangeset(path, "invalid quoted package key");
    }
    const parsed = rawKey.slice(1, -1).replaceAll("''", "'");
    if (!parsed) return malformedChangeset(path, "package key must not be empty");
    return parsed;
  }
  if (!rawKey || /[\s"'{}\[\],:#&*!|>?`]/.test(rawKey)) {
    return malformedChangeset(path, "invalid package key");
  }
  return rawKey;
}

function parseChangesetFrontmatter(source: string, path: string): Map<string, ReleaseType> {
  const normalized = source.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) malformedChangeset(path, "unsupported line endings");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") malformedChangeset(path, "missing opening delimiter");
  const closingDelimiter = lines.indexOf("---", 1);
  if (closingDelimiter === -1) malformedChangeset(path, "missing closing delimiter");

  const releases = new Map<string, ReleaseType>();
  for (const line of lines.slice(1, closingDelimiter)) {
    if (line.trim() === "") continue;
    const separator = line.indexOf(":");
    if (separator === -1) malformedChangeset(path, `invalid entry ${JSON.stringify(line)}`);
    const packageName = parseChangesetPackageKey(line.slice(0, separator).trim(), path);
    const releaseType = line.slice(separator + 1).trim();
    if (releaseType !== "patch" && releaseType !== "minor" && releaseType !== "major") {
      malformedChangeset(path, `invalid release type for ${packageName}`);
    }
    if (releases.has(packageName)) {
      malformedChangeset(path, `duplicate package key ${packageName}`);
    }
    releases.set(packageName, releaseType);
  }
  if (releases.size === 0) malformedChangeset(path, "frontmatter must select a package");
  return releases;
}

function incrementStableVersion(version: string, releaseType: ReleaseType): string {
  const [major, minor, patch] = parseStableVersion(version);
  if (releaseType === "major") return `${major + 1n}.0.0`;
  if (releaseType === "minor") return `${major}.${minor + 1n}.0`;
  return `${major}.${minor}.${patch + 1n}`;
}

function intendedCoreVersionFromChangesets(
  cwd: string,
  beforeSha: string,
  changedFiles: readonly ChangedFile[],
  beforeVersion: string,
): string | null {
  let highestReleaseType: ReleaseType | null = null;
  for (const path of consumedChangesetPaths(changedFiles)) {
    let source: string;
    try {
      source = git(cwd, ["show", `${beforeSha}:${path}`]);
    } catch (error) {
      throw new Error(
        `could not read consumed Changeset ${path} at ${beforeSha}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const releaseType = parseChangesetFrontmatter(source, path).get(corePackageName);
    if (
      releaseType !== undefined
      && (highestReleaseType === null
        || releaseTypePriority[releaseType] > releaseTypePriority[highestReleaseType])
    ) {
      highestReleaseType = releaseType;
    }
  }
  return highestReleaseType === null
    ? null
    : incrementStableVersion(beforeVersion, highestReleaseType);
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trimEnd();
}

function packageAtPath(
  cwd: string,
  revision: string,
  requestedPath: string,
  allowLegacyRootFallback = false,
): PackageIdentity {
  let packagePath = requestedPath;
  let source: string;
  try {
    source = git(cwd, ["show", `${revision}:${packagePath}`]);
  } catch (error) {
    if (!allowLegacyRootFallback) {
      throw new Error(`could not read ${packagePath} at ${revision}: ${error instanceof Error ? error.message : String(error)}`);
    }
    packagePath = legacyCliPackagePath;
    try {
      source = git(cwd, ["show", `${revision}:${packagePath}`]);
    } catch (fallbackError) {
      throw new Error(`could not read ${requestedPath} or ${legacyCliPackagePath} at ${revision}: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
    }
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`could not parse ${packagePath} at ${revision}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object") {
    throw new Error(`${packagePath} at ${revision} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || typeof record.version !== "string") {
    throw new Error(`${packagePath} at ${revision} must contain string name and version fields`);
  }
  return {
    name: record.name,
    version: record.version,
    ...(typeof record.private === "boolean" ? { private: record.private } : {}),
  };
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
  const beforePackage = packageAtPath(cwd, beforeSha, cliPackagePath, true);
  const afterPackage = packageAtPath(cwd, afterSha, cliPackagePath);
  const versionChanged = beforePackage.version !== afterPackage.version;
  return classifyReleaseTransition({
    beforePackage,
    afterPackage,
    beforeSha,
    afterSha,
    firstParentSha,
    changedFiles: versionChanged ? changedFiles(cwd, beforeSha, afterSha) : [],
    changelog: versionChanged ? git(cwd, ["show", `${afterSha}:${cliChangelogPath}`]) : "",
  });
}

export function planCoreRelease(
  beforeSha: string,
  afterSha: string,
  cwd = process.cwd(),
): CoreReleasePlan {
  validateCommitSha(beforeSha, "before SHA");
  validateCommitSha(afterSha, "after SHA");
  const firstParentSha = git(cwd, ["rev-parse", `${afterSha}^1`]);
  const beforePackage = packageAtPath(cwd, beforeSha, corePackagePath);
  const afterPackage = packageAtPath(cwd, afterSha, corePackagePath);
  const beforeCliPackage = packageAtPath(cwd, beforeSha, cliPackagePath, true);
  const afterCliPackage = packageAtPath(cwd, afterSha, cliPackagePath);
  const versionChanged = beforePackage.version !== afterPackage.version;
  const releaseChangedFiles = versionChanged ? changedFiles(cwd, beforeSha, afterSha) : [];
  return classifyCoreReleaseTransition({
    beforePackage,
    afterPackage,
    beforeCliPackage,
    afterCliPackage,
    intendedCoreVersion: versionChanged
      ? intendedCoreVersionFromChangesets(
        cwd,
        beforeSha,
        releaseChangedFiles,
        beforePackage.version,
      )
      : null,
    beforeSha,
    afterSha,
    firstParentSha,
    changedFiles: releaseChangedFiles,
    changelog: versionChanged ? git(cwd, ["show", `${afterSha}:${coreChangelogPath}`]) : "",
  });
}

function isCoreReleasePlan(plan: ReleasePlan): plan is CoreReleasePlan {
  const candidate = plan as Partial<CoreReleasePlan>;
  return typeof candidate.packageName === "string" && typeof candidate.version === "string";
}

export async function writeGithubOutput(plan: ReleasePlan, outputPath: string): Promise<void> {
  const packageOutput = isCoreReleasePlan(plan)
    ? [`package-name=${plan.packageName}`, `version=${plan.version}`]
    : [];
  await appendFile(outputPath, [
    `should-release=${plan.shouldRelease}`,
    `release-sha=${plan.releaseSha}`,
    ...packageOutput,
    "",
  ].join("\n"));
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const core = arguments_[0] === "core";
  const [beforeSha, afterSha, explicitOutput] = core ? arguments_.slice(1) : arguments_;
  if (!beforeSha || !afterSha) {
    throw new Error("usage: bun scripts/release-plan.ts [core] <before-sha> <after-sha> [github-output]");
  }
  const outputPath = explicitOutput ?? process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required");
  await writeGithubOutput(
    core ? planCoreRelease(beforeSha, afterSha) : planRelease(beforeSha, afterSha),
    outputPath,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

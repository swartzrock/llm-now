import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  classifyReleaseTransition,
  compareStableVersions,
  parseStableVersion,
  planRelease,
  writeGithubOutput,
  type ReleaseTransitionInput,
} from "../scripts/release-plan.ts";

const releaseSha = "b".repeat(40);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
function transition(overrides: Partial<ReleaseTransitionInput> = {}): ReleaseTransitionInput {
  return {
    beforePackage: { name: "llm-now", version: "0.1.0" },
    afterPackage: { name: "llm-now", version: "0.1.1" },
    beforeSha: "a".repeat(40), afterSha: releaseSha, firstParentSha: "a".repeat(40),
    changedFiles: [
      { status: "M", path: "packages/cli/package.json" },
      { status: "A", path: "packages/cli/CHANGELOG.md" },
      { status: "D", path: ".changeset/safe-release.md" },
    ],
    changelog: "# llm-now\n\n## 0.1.1\n\n- Add the release train.\n",
    ...overrides,
  };
}

describe("stable release versions", () => {
  test("parses strict stable SemVer and compares numeric components", () => {
    expect(parseStableVersion("10.2.30")).toEqual([10n, 2n, 30n]);
    expect(compareStableVersions("1.10.0", "1.2.99")).toBeGreaterThan(0);
    for (const version of ["v1.2.3", "1.2", "1.2.3-beta.1", "01.2.3", "1.02.3"]) {
      expect(() => parseStableVersion(version)).toThrow("stable X.Y.Z");
    }
  });
});

describe("release transition classification", () => {
  test("returns normalized release outputs for a valid generated transition", () => {
    expect(classifyReleaseTransition(transition())).toEqual({ shouldRelease: true, releaseSha });
  });
  test("keeps shared CLI and core transitions in the native CLI lane", () => {
    expect(classifyReleaseTransition(transition({
      changedFiles: [
        ...transition().changedFiles,
        { status: "M", path: "packages/core/package.json" },
        { status: "M", path: "packages/core/CHANGELOG.md" },
      ],
    }))).toEqual({ shouldRelease: true, releaseSha });
  });
  test("returns a clean no-op only when name and version are unchanged", () => {
    expect(classifyReleaseTransition(transition({
      afterPackage: { name: "llm-now", version: "0.1.0" },
      changedFiles: [{ status: "M", path: "README.md" }], changelog: "",
    }))).toEqual({ shouldRelease: false, releaseSha });
  });
  test("rejects malformed, decreased, renamed, zero-before, and non-first-parent transitions", () => {
    expect(() => classifyReleaseTransition(transition({ afterPackage: { name: "llm-now", version: "0.1.0-beta.1" } }))).toThrow("stable X.Y.Z");
    expect(() => classifyReleaseTransition(transition({ beforePackage: { name: "llm-now", version: "0.2.0" } }))).toThrow("must increase");
    expect(() => classifyReleaseTransition(transition({ afterPackage: { name: "renamed", version: "0.1.1" } }))).toThrow("package name");
    expect(() => classifyReleaseTransition(transition({ firstParentSha: "c".repeat(40) }))).toThrow("first parent");
    expect(() => classifyReleaseTransition(transition({ beforeSha: "0".repeat(40) }))).toThrow("before SHA");
  });
  test("requires package, changelog, consumed changeset, and one exact heading", () => {
    expect(() => classifyReleaseTransition(transition({ changedFiles: transition().changedFiles.filter((file) => file.path !== "packages/cli/package.json") }))).toThrow("packages/cli/package.json");
    expect(() => classifyReleaseTransition(transition({ changedFiles: transition().changedFiles.filter((file) => file.path !== "packages/cli/CHANGELOG.md") }))).toThrow("packages/cli/CHANGELOG.md");
    expect(() => classifyReleaseTransition(transition({ changedFiles: transition().changedFiles.filter((file) => !file.path.includes("safe-release")) }))).toThrow("consumed Changeset");
    expect(() => classifyReleaseTransition(transition({ changelog: "## 0.1.0\n" }))).toThrow("exactly one");
    expect(() => classifyReleaseTransition(transition({ changelog: "## 0.1.1\n\nFirst\n\n## 0.1.1\n\nSecond\n" }))).toThrow("exactly one");
    expect(() => classifyReleaseTransition(transition({ changelog: "## 0.1.1\n" }))).toThrow("must not be empty");
  });
  test("does not treat deletion of the Changesets README as release intent", () => {
    expect(() => classifyReleaseTransition(transition({ changedFiles: [
      { status: "M", path: "packages/cli/package.json" }, { status: "M", path: "packages/cli/CHANGELOG.md" },
      { status: "D", path: ".changeset/README.md" },
    ] }))).toThrow("consumed Changeset");
  });
  test("keeps a core-only version change out of the native release lane", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-release-plan-"));
    temporaryDirectories.push(directory);
    git(directory, "init", "--initial-branch=main");
    git(directory, "config", "user.email", "release@example.invalid");
    git(directory, "config", "user.name", "Release Test");
    await Bun.write(join(directory, "packages/cli/package.json"), '{"name":"llm-now","version":"0.1.0"}\n');
    await Bun.write(join(directory, "packages/core/package.json"), '{"name":"@swartzrock/llm-now-core","version":"0.1.0"}\n');
    git(directory, "add", ".");
    git(directory, "commit", "-m", "initial");
    const beforeSha = git(directory, "rev-parse", "HEAD");
    await Bun.write(join(directory, "packages/core/package.json"), '{"name":"@swartzrock/llm-now-core","version":"0.1.1"}\n');
    git(directory, "add", "packages/core/package.json");
    git(directory, "commit", "-m", "release core");
    const afterSha = git(directory, "rev-parse", "HEAD");
    expect(planRelease(beforeSha, afterSha, directory)).toEqual({
      shouldRelease: false, releaseSha: afterSha,
    });
  });
  test("compares the first workspace commit with the legacy root manifest", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-release-plan-"));
    temporaryDirectories.push(directory);
    git(directory, "init", "--initial-branch=main");
    git(directory, "config", "user.email", "release@example.invalid");
    git(directory, "config", "user.name", "Release Test");
    await Bun.write(join(directory, "package.json"), '{"name":"llm-now","version":"0.1.0"}\n');
    git(directory, "add", ".");
    git(directory, "commit", "-m", "legacy layout");
    const beforeSha = git(directory, "rev-parse", "HEAD");

    await Bun.write(
      join(directory, "package.json"),
      '{"name":"llm-now-workspace","private":true,"workspaces":["packages/*"]}\n',
    );
    await Bun.write(
      join(directory, "packages/cli/package.json"),
      '{"name":"llm-now","version":"0.1.0"}\n',
    );
    git(directory, "add", ".");
    git(directory, "commit", "-m", "migrate to workspaces");
    const afterSha = git(directory, "rev-parse", "HEAD");

    expect(planRelease(beforeSha, afterSha, directory)).toEqual({
      shouldRelease: false, releaseSha: afterSha,
    });
  });
  test("requires the CLI manifest at the after revision", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-release-plan-"));
    temporaryDirectories.push(directory);
    git(directory, "init", "--initial-branch=main");
    git(directory, "config", "user.email", "release@example.invalid");
    git(directory, "config", "user.name", "Release Test");
    await Bun.write(join(directory, "package.json"), '{"name":"llm-now","version":"0.1.0"}\n');
    await Bun.write(
      join(directory, "packages/cli/package.json"),
      '{"name":"llm-now","version":"0.1.0"}\n',
    );
    git(directory, "add", ".");
    git(directory, "commit", "-m", "workspace layout");
    const beforeSha = git(directory, "rev-parse", "HEAD");

    await rm(join(directory, "packages/cli/package.json"));
    git(directory, "add", "-A");
    git(directory, "commit", "-m", "remove CLI manifest");
    const afterSha = git(directory, "rev-parse", "HEAD");

    expect(() => planRelease(beforeSha, afterSha, directory)).toThrow(
      "could not read packages/cli/package.json",
    );
  });
  test("plans a real generated release diff from its exact first parent", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-release-plan-"));
    temporaryDirectories.push(directory);
    git(directory, "init", "--initial-branch=main");
    git(directory, "config", "user.email", "release@example.invalid");
    git(directory, "config", "user.name", "Release Test");
    await Bun.write(join(directory, "packages/cli/package.json"), '{"name":"llm-now","version":"0.1.0"}\n');
    await Bun.write(join(directory, ".changeset", "README.md"), "# Changesets\n");
    await Bun.write(
      join(directory, ".changeset", "safe-release.md"),
      '---\n"llm-now": patch\n---\n\nAdd the release train.\n',
    );
    git(directory, "add", ".");
    git(directory, "commit", "-m", "feature intent");
    const beforeSha = git(directory, "rev-parse", "HEAD");

    await Bun.write(join(directory, "packages/cli/package.json"), '{"name":"llm-now","version":"0.1.1"}\n');
    await Bun.write(
      join(directory, "packages/cli/CHANGELOG.md"),
      "# llm-now\n\n## 0.1.1\n\n### Patch Changes\n\n- Add the release train.\n",
    );
    await rm(join(directory, ".changeset", "safe-release.md"));
    git(directory, "add", "-A");
    git(directory, "commit", "-m", "chore: release");
    const afterSha = git(directory, "rev-parse", "HEAD");

    expect(planRelease(beforeSha, afterSha, directory)).toEqual({
      shouldRelease: true, releaseSha: afterSha,
    });
  });

  test("plans a generated release merged with a first-parent merge commit", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-release-plan-"));
    temporaryDirectories.push(directory);
    git(directory, "init", "--initial-branch=main");
    git(directory, "config", "user.email", "release@example.invalid");
    git(directory, "config", "user.name", "Release Test");
    await Bun.write(join(directory, "packages/cli/package.json"), '{"name":"llm-now","version":"0.1.0"}\n');
    await Bun.write(join(directory, ".changeset", "README.md"), "# Changesets\n");
    await Bun.write(join(directory, ".changeset", "safe-release.md"), '---\n"llm-now": patch\n---\n\nRelease it.\n');
    git(directory, "add", ".");
    git(directory, "commit", "-m", "feature intent");
    git(directory, "checkout", "-b", "release-pr");
    await Bun.write(join(directory, "packages/cli/package.json"), '{"name":"llm-now","version":"0.1.1"}\n');
    await Bun.write(join(directory, "packages/cli/CHANGELOG.md"), "# llm-now\n\n## 0.1.1\n\n- Release it.\n");
    await rm(join(directory, ".changeset", "safe-release.md"));
    git(directory, "add", "-A");
    git(directory, "commit", "-m", "chore: release");
    git(directory, "checkout", "main");
    const beforeSha = git(directory, "rev-parse", "HEAD");
    git(directory, "merge", "--no-ff", "release-pr", "-m", "merge release PR");
    const afterSha = git(directory, "rev-parse", "HEAD");
    expect(planRelease(beforeSha, afterSha, directory)).toEqual({
      shouldRelease: true, releaseSha: afterSha,
    });
  });

  test("appends exact GitHub Actions outputs", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-release-plan-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "github-output");
    await Bun.write(outputPath, "sentinel=kept\n");
    await writeGithubOutput({ shouldRelease: true, releaseSha }, outputPath);
    expect(await Bun.file(outputPath).text()).toBe(
      `sentinel=kept\nshould-release=true\nrelease-sha=${releaseSha}\n`,
    );
  });
});

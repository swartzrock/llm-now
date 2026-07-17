import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

const repositoryPackage = await Bun.file(
  new URL("../package.json", import.meta.url),
).json() as {
  private?: boolean;
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const changesetsConfig = await Bun.file(
  new URL("../.changeset/config.json", import.meta.url),
).json() as {
  privatePackages?: { version?: boolean; tag?: boolean };
};
const changesetsBinary = new URL(
  "../node_modules/@changesets/cli/bin.js",
  import.meta.url,
).pathname;
const fixtureDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function run(command: string[], cwd: string) {
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed: ${command.join(" ")}\n${result.stderr.toString()}${result.stdout.toString()}`,
    );
  }
}

describe("Changesets authoring", () => {
  test("uses the exact private, version-only Changesets configuration", async () => {
    expect(repositoryPackage.private).toBe(true);
    expect(repositoryPackage.devDependencies?.["@changesets/cli"]).toBe("2.31.0");
    expect(repositoryPackage.scripts).toMatchObject({
      changeset: "changeset",
      "changeset:status": "changeset status --verbose",
      "changeset:version": "changeset version",
    });
    expect(repositoryPackage.scripts?.["changeset:publish"]).toBeUndefined();
    expect(changesetsConfig.privatePackages).toEqual({ version: true, tag: false });

    const workflowFiles = [
      new URL("../.github/workflows/ci.yml", import.meta.url),
      new URL("../.github/workflows/release.yml", import.meta.url),
    ];
    const workflows = (await Promise.all(workflowFiles.map((file) => Bun.file(file).text())))
      .join("\n");
    expect(workflows).not.toMatch(/\b(?:changeset|npm) publish\b/);
    expect(workflows).not.toContain("NPM_TOKEN");
  });

  test("batches patch and minor intent into one private version and changelog", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-changesets-"));
    fixtureDirectories.push(directory);

    await Bun.write(join(directory, "package.json"), JSON.stringify({
      name: "fixture-app",
      version: "1.0.0",
      private: true,
    }, null, 2));
    await Bun.write(
      join(directory, ".changeset", "config.json"),
      JSON.stringify(changesetsConfig, null, 2),
    );
    await Bun.write(join(directory, ".changeset", "README.md"), "# Changesets fixture\n");
    await Bun.write(
      join(directory, ".changeset", "calm-patch.md"),
      '---\n"fixture-app": patch\n---\n\nFix the patch behavior.\n',
    );
    await Bun.write(
      join(directory, ".changeset", "bright-minor.md"),
      '---\n"fixture-app": minor\n---\n\nAdd the minor behavior.\n',
    );
    run(["git", "init", "--initial-branch=main"], directory);
    run(["git", "config", "user.email", "changesets@example.invalid"], directory);
    run(["git", "config", "user.name", "Changesets Fixture"], directory);
    run(["git", "add", "."], directory);
    run(["git", "commit", "-m", "fixture"], directory);

    run([process.execPath, changesetsBinary, "version"], directory);

    const versionedPackage = await Bun.file(join(directory, "package.json")).json() as {
      version: string;
    };
    const changelog = await Bun.file(join(directory, "CHANGELOG.md")).text();
    expect(versionedPackage.version).toBe("1.1.0");
    expect(changelog).toContain("## 1.1.0");
    expect(changelog).toContain("Fix the patch behavior.");
    expect(changelog).toContain("Add the minor behavior.");
    expect(await Bun.file(join(directory, ".changeset", "calm-patch.md")).exists()).toBe(false);
    expect(await Bun.file(join(directory, ".changeset", "bright-minor.md")).exists()).toBe(false);
    expect(await Bun.file(join(directory, ".changeset", "README.md")).exists()).toBe(true);
  });
});

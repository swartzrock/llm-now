import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { getPackagesSync } from "@manypkg/get-packages";

const repositoryPackage = await Bun.file(
  new URL("../package.json", import.meta.url),
).json() as {
  name?: string;
  version?: string;
  private?: boolean;
  workspaces?: string[];
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const cliPackage = await Bun.file(
  new URL("../packages/cli/package.json", import.meta.url),
).json() as {
  name?: string;
  version?: string;
  private?: boolean;
  devDependencies?: Record<string, string>;
};
const corePackage = await Bun.file(
  new URL("../packages/core/package.json", import.meta.url),
).json() as {
  name?: string;
  version?: string;
  private?: boolean;
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
  test("discovers both versioned workspaces and excludes the orchestration root", () => {
    expect(repositoryPackage).toMatchObject({
      name: "llm-now-workspace",
      private: true,
      workspaces: ["packages/*"],
    });
    expect(repositoryPackage.version).toBeUndefined();
    expect(cliPackage).toMatchObject({ name: "llm-now", version: "2.7.0", private: true });
    expect(corePackage).toMatchObject({
      name: "@swartzrock/llm-now-core",
      version: "0.0.0",
      private: true,
    });
    expect(cliPackage.devDependencies?.["@swartzrock/llm-now-core"]).toBe("workspace:^");

    const discovered = getPackagesSync(new URL("..", import.meta.url).pathname);
    expect(discovered.packages.map(({ packageJson }) => packageJson.name).sort()).toEqual([
      "@swartzrock/llm-now-core",
      "llm-now",
    ]);
  });

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

  test("builds the core workspace behind its package-root export only", async () => {
    const repository = new URL("..", import.meta.url).pathname;
    const cli = new URL("../packages/cli", import.meta.url).pathname;
    run([process.execPath, "scripts/build-core.ts"], repository);
    expect(await Bun.file(new URL("../packages/core/dist/index.js", import.meta.url)).exists())
      .toBe(true);
    expect(await Bun.file(new URL("../packages/core/dist/index.d.ts", import.meta.url)).exists())
      .toBe(true);
    run([process.execPath, "-e", 'import("@swartzrock/llm-now-core")'], cli);
    const deepImport = Bun.spawnSync([
      process.execPath,
      "-e",
      'import("@swartzrock/llm-now-core/dist/index.js")',
    ], { cwd: cli, stdout: "pipe", stderr: "pipe" });
    expect(deepImport.exitCode).not.toBe(0);
  });

  test("keeps the root wrapper and CLI workspace entry equivalent", () => {
    const cwd = new URL("..", import.meta.url).pathname;
    const root = Bun.spawnSync([process.execPath, "index.ts", "--version"], {
      cwd,
      stdin: new Uint8Array(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const workspace = Bun.spawnSync([
      process.execPath,
      "packages/cli/src/index.ts",
      "--version",
    ], {
      cwd,
      stdin: new Uint8Array(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(root.exitCode).toBe(0);
    expect(workspace.exitCode).toBe(0);
    expect(root.stdout.toString()).toBe("2.7.0\n");
    expect(workspace.stdout.toString()).toBe(root.stdout.toString());
    expect(workspace.stderr.toString()).toBe(root.stderr.toString());
  });

  test("does not version the CLI through its build-time core dependency", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-changesets-workspaces-"));
    fixtureDirectories.push(directory);

    await Bun.write(join(directory, "package.json"), JSON.stringify({
      name: "fixture-workspace",
      private: true,
      workspaces: ["packages/*"],
    }, null, 2));
    await Bun.write(join(directory, "packages/cli/package.json"), JSON.stringify({
      name: "llm-now",
      version: "2.7.0",
      private: true,
      devDependencies: { "@swartzrock/llm-now-core": "workspace:^" },
    }, null, 2));
    await Bun.write(join(directory, "packages/core/package.json"), JSON.stringify({
      name: "@swartzrock/llm-now-core",
      version: "0.1.0",
      private: true,
    }, null, 2));
    await Bun.write(
      join(directory, ".changeset", "config.json"),
      JSON.stringify(changesetsConfig, null, 2),
    );
    await Bun.write(join(directory, ".changeset", "README.md"), "# Changesets fixture\n");
    await Bun.write(
      join(directory, ".changeset", "core-patch.md"),
      '---\n"@swartzrock/llm-now-core": patch\n---\n\nFix core behavior.\n',
    );
    run(["git", "init", "--initial-branch=main"], directory);
    run(["git", "config", "user.email", "changesets@example.invalid"], directory);
    run(["git", "config", "user.name", "Changesets Fixture"], directory);
    run(["git", "add", "."], directory);
    run(["git", "commit", "-m", "fixture"], directory);

    run([process.execPath, changesetsBinary, "version"], directory);

    const versionedCli = await Bun.file(join(directory, "packages/cli/package.json")).json() as {
      version: string;
    };
    const versionedCore = await Bun.file(join(directory, "packages/core/package.json")).json() as {
      version: string;
    };
    expect(versionedCli.version).toBe("2.7.0");
    expect(versionedCore.version).toBe("0.1.1");
  });

  test("batches patch and minor intent into one private version and changelog", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-changesets-"));
    fixtureDirectories.push(directory);

    await Bun.write(join(directory, "package.json"), JSON.stringify({
      name: "fixture-workspace",
      private: true,
      workspaces: ["packages/*"],
    }, null, 2));
    await Bun.write(join(directory, "packages/app/package.json"), JSON.stringify({
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

    const versionedPackage = await Bun.file(join(directory, "packages/app/package.json")).json() as {
      version: string;
    };
    const changelog = await Bun.file(join(directory, "packages/app/CHANGELOG.md")).text();
    expect(versionedPackage.version).toBe("1.1.0");
    expect(changelog).toContain("## 1.1.0");
    expect(changelog).toContain("Fix the patch behavior.");
    expect(changelog).toContain("Add the minor behavior.");
    expect(await Bun.file(join(directory, ".changeset", "calm-patch.md")).exists()).toBe(false);
    expect(await Bun.file(join(directory, ".changeset", "bright-minor.md")).exists()).toBe(false);
    expect(await Bun.file(join(directory, ".changeset", "README.md")).exists()).toBe(true);
  });
});

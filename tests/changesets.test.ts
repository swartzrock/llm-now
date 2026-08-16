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
  publishConfig?: { access?: string };
};
const changesetsConfig = await Bun.file(
  new URL("../.changeset/config.json", import.meta.url),
).json() as {
  access?: string;
  fixed?: unknown[];
  linked?: unknown[];
  privatePackages?: { version?: boolean; tag?: boolean };
};
const changesetsWorkflow = await Bun.file(
  new URL("../.github/workflows/changesets.yml", import.meta.url),
).text();
const changesetsReadme = await Bun.file(
  new URL("../.changeset/README.md", import.meta.url),
).text();
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
      publishConfig: { access: "public" },
    });
    expect(corePackage.version).toMatch(/^0\.\d+\.\d+$/);
    expect(corePackage.private).toBeUndefined();
    expect(cliPackage.devDependencies?.["@swartzrock/llm-now-core"]).toBe("workspace:^");

    const discovered = getPackagesSync(new URL("..", import.meta.url).pathname);
    expect(discovered.packages.map(({ packageJson }) => packageJson.name).sort()).toEqual([
      "@swartzrock/llm-now-core",
      "llm-now",
    ]);
  });

  test("uses independent versions and keeps Changesets version-only", async () => {
    expect(repositoryPackage.private).toBe(true);
    expect(repositoryPackage.devDependencies?.["@changesets/cli"]).toBe("2.31.0");
    expect(repositoryPackage.scripts).toMatchObject({
      changeset: "changeset",
      "changeset:status": "changeset status --verbose",
      "changeset:version": "changeset version",
    });
    expect(repositoryPackage.scripts).not.toHaveProperty("changeset:publish");
    expect(changesetsConfig.fixed).toEqual([]);
    expect(changesetsConfig.linked).toEqual([]);
    expect(changesetsConfig.access).toBe("restricted");
    expect(changesetsConfig.privatePackages).toEqual({ version: true, tag: false });
    expect(corePackage.publishConfig).toEqual({ access: "public" });
    expect(changesetsReadme).toContain("`llm-now` for CLI-only");
    expect(changesetsReadme).toContain("`@swartzrock/llm-now-core` for core-only");
    expect(changesetsReadme).toContain("both for shared");
    expect(changesetsReadme).toContain("versions are independent");

    const workflowFiles = [
      new URL("../.github/workflows/ci.yml", import.meta.url),
      new URL("../.github/workflows/release.yml", import.meta.url),
    ];
    const workflows = (await Promise.all(workflowFiles.map((file) => Bun.file(file).text())))
      .join("\n");
    expect(workflows).not.toMatch(/\b(?:changeset|npm) publish\b/);
    expect(workflows).not.toContain("NPM_TOKEN");
    expect(changesetsWorkflow).not.toContain("publish:");
    expect(changesetsWorkflow).not.toContain("changeset publish");
  });

  test("builds the core workspace behind its package-root export only", async () => {
    const repository = new URL("..", import.meta.url).pathname;
    const cli = new URL("../packages/cli", import.meta.url).pathname;
    run([process.execPath, "scripts/build-core.ts"], repository);
    expect(await Bun.file(new URL("../packages/core/dist/index.js", import.meta.url)).exists())
      .toBe(true);
    expect(await Bun.file(new URL("../packages/core/dist/index.d.ts", import.meta.url)).exists())
      .toBe(true);
    const builtCore = await Bun.file(
      new URL("../packages/core/dist/index.js", import.meta.url),
    ).text();
    expect(builtCore).toMatch(/from ["']@3leaps\/string-metrics-wasm["']/);
    expect(builtCore).toMatch(/from ["']@swartzrock\/byok-runtime["']/);
    expect(builtCore).toMatch(/from ["']@swartzrock\/byok-runtime\/node["']/);
    expect(builtCore).toMatch(/from ["']unicode-case-folding["']/);
    for (const bundledMarker of [
      "node_modules/.bun/@3leaps+string-metrics-wasm",
      "node_modules/.bun/@swartzrock+byok-runtime",
      "node_modules/.bun/unicode-case-folding",
    ]) {
      expect(builtCore).not.toContain(bundledMarker);
    }
    const declarations = await Bun.file(
      new URL("../packages/core/dist/index.d.ts", import.meta.url),
    ).text();
    expect(declarations).not.toMatch(/from ["'][^"']+\.ts["']/);

    const consumer = await mkdtemp(join(cli, ".tmp-node-next-consumer-"));
    fixtureDirectories.push(consumer);
    await Bun.write(join(consumer, "package.json"), JSON.stringify({ type: "module" }));
    await Bun.write(join(consumer, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        lib: ["ES2022", "DOM"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        types: ["node"],
      },
      include: ["consumer.ts"],
    }));
    await Bun.write(join(consumer, "consumer.ts"), [
      'import { createLlmNowCore, type ModelListResult } from "@swartzrock/llm-now-core";',
      "const core = createLlmNowCore({",
      "  environment: {},",
      "  credentialResolver: { resolve: async () => ({ status: \"missing\" as const }) },",
      "});",
      "const result: Promise<ModelListResult> = core.listModels({ provider: \"ollama\" });",
      "void result;",
      "",
    ].join("\n"));
    run([
      process.execPath,
      new URL("../node_modules/typescript/bin/tsc", import.meta.url).pathname,
      "--project",
      join(consumer, "tsconfig.json"),
    ], consumer);
    run([process.execPath, "-e", 'import("@swartzrock/llm-now-core")'], cli);
    const deepImport = Bun.spawnSync([
      process.execPath,
      "-e",
      'import("@swartzrock/llm-now-core/dist/index.js")',
    ], { cwd: cli, stdout: "pipe", stderr: "pipe" });
    expect(deepImport.exitCode).not.toBe(0);
  }, 30_000);

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

  test("does not induce cross-package bumps for core patch, core minor, or CLI-only intent", async () => {
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
      publishConfig: { access: "public" },
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

    await Bun.write(
      join(directory, ".changeset", "core-minor.md"),
      '---\n"@swartzrock/llm-now-core": minor\n---\n\nAdd core behavior.\n',
    );
    run(["git", "add", "."], directory);
    run(["git", "commit", "-m", "core minor intent"], directory);
    run([process.execPath, changesetsBinary, "version"], directory);
    expect((await Bun.file(join(directory, "packages/cli/package.json")).json() as { version: string }).version)
      .toBe("2.7.0");
    expect((await Bun.file(join(directory, "packages/core/package.json")).json() as { version: string }).version)
      .toBe("0.2.0");

    await Bun.write(
      join(directory, ".changeset", "cli-patch.md"),
      '---\n"llm-now": patch\n---\n\nFix CLI behavior.\n',
    );
    run(["git", "add", "."], directory);
    run(["git", "commit", "-m", "CLI patch intent"], directory);
    run([process.execPath, changesetsBinary, "version"], directory);
    expect((await Bun.file(join(directory, "packages/cli/package.json")).json() as { version: string }).version)
      .toBe("2.7.1");
    expect((await Bun.file(join(directory, "packages/core/package.json")).json() as { version: string }).version)
      .toBe("0.2.0");
  });

  test("plans the first public core release without inducing a CLI bump", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-changesets-initial-core-"));
    fixtureDirectories.push(directory);
    await Bun.write(join(directory, "package.json"), JSON.stringify({
      name: "fixture-workspace", private: true, workspaces: ["packages/*"],
    }));
    await Bun.write(join(directory, "packages/cli/package.json"), JSON.stringify({
      name: "llm-now", version: "2.7.0", private: true,
      devDependencies: { "@swartzrock/llm-now-core": "workspace:^" },
    }));
    await Bun.write(join(directory, "packages/core/package.json"), JSON.stringify({
      name: "@swartzrock/llm-now-core", version: "0.0.0",
      publishConfig: { access: "public" },
    }));
    await Bun.write(join(directory, ".changeset/config.json"), JSON.stringify(changesetsConfig));
    await Bun.write(join(directory, ".changeset/README.md"), "# Changesets\n");
    await Bun.write(join(directory, ".changeset/initial-core.md"),
      '---\n"@swartzrock/llm-now-core": minor\n---\n\nPublish the headless core.\n');
    run(["git", "init", "--initial-branch=main"], directory);
    run(["git", "config", "user.email", "changesets@example.invalid"], directory);
    run(["git", "config", "user.name", "Changesets Fixture"], directory);
    run(["git", "add", "."], directory);
    run(["git", "commit", "-m", "fixture"], directory);
    run([process.execPath, changesetsBinary, "version"], directory);

    const versionedCli = await Bun.file(join(directory, "packages/cli/package.json")).json() as { version: string };
    const versionedCore = await Bun.file(join(directory, "packages/core/package.json")).json() as { version: string };
    expect(versionedCli.version).toBe("2.7.0");
    expect(versionedCore.version).toBe("0.1.0");
  });

  test("versions shared changes only when both packages are explicit", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-changesets-shared-"));
    fixtureDirectories.push(directory);
    await Bun.write(join(directory, "package.json"), JSON.stringify({
      name: "fixture-workspace", private: true, workspaces: ["packages/*"],
    }));
    await Bun.write(join(directory, "packages/cli/package.json"), JSON.stringify({
      name: "llm-now", version: "2.7.0", private: true,
      devDependencies: { "@swartzrock/llm-now-core": "workspace:^" },
    }));
    await Bun.write(join(directory, "packages/core/package.json"), JSON.stringify({
      name: "@swartzrock/llm-now-core", version: "0.1.9", publishConfig: { access: "public" },
    }));
    await Bun.write(join(directory, ".changeset/config.json"), JSON.stringify(changesetsConfig));
    await Bun.write(join(directory, ".changeset/README.md"), "# Changesets\n");
    await Bun.write(join(directory, ".changeset/shared.md"),
      '---\n"@swartzrock/llm-now-core": minor\n"llm-now": patch\n---\n\nUpdate both products.\n');
    run(["git", "init", "--initial-branch=main"], directory);
    run(["git", "config", "user.email", "changesets@example.invalid"], directory);
    run(["git", "config", "user.name", "Changesets Fixture"], directory);
    run(["git", "add", "."], directory);
    run(["git", "commit", "-m", "fixture"], directory);
    run([process.execPath, changesetsBinary, "version"], directory);

    const versionedCli = await Bun.file(join(directory, "packages/cli/package.json")).json() as { version: string };
    const versionedCore = await Bun.file(join(directory, "packages/core/package.json")).json() as { version: string };
    expect(versionedCli.version).toBe("2.7.1");
    expect(versionedCore.version).toBe("0.2.0");
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

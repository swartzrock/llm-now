import { describe, expect, test } from "bun:test";

const repositoryPackage = await Bun.file(
  new URL("../package.json", import.meta.url),
).json() as { scripts?: Record<string, string> };
const corePackage = await Bun.file(
  new URL("../packages/core/package.json", import.meta.url),
).json() as Record<string, unknown>;

describe("public core package", () => {
  test("declares the minimal public ESM boundary", async () => {
    expect(corePackage).toMatchObject({
      name: "@swartzrock/llm-now-core",
      version: "0.0.0",
      type: "module",
      sideEffects: false,
      license: "MIT",
      engines: {
        node: ">=20",
        bun: ">=1.3.14",
      },
      files: ["dist", "README.md", "LICENSE", "CHANGELOG.md"],
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
          default: "./dist/index.js",
        },
      },
      dependencies: {
        "@3leaps/string-metrics-wasm": "0.3.11",
        "@swartzrock/byok-runtime": "2.4.1",
        "unicode-case-folding": "1.1.1",
      },
    });
    expect(corePackage.private).toBeUndefined();
    expect(corePackage.scripts).toBeUndefined();
    expect(corePackage.bin).toBeUndefined();
    expect(corePackage.browser).toBeUndefined();

    for (const file of ["README.md", "LICENSE", "CHANGELOG.md"]) {
      expect(await Bun.file(new URL(`../packages/core/${file}`, import.meta.url)).exists())
        .toBe(true);
    }
  });

  test("packs and verifies real external Node, Bun, and NodeNext consumers", () => {
    expect(repositoryPackage.scripts?.["core:pack:verify"]).toBe(
      "bun run core:build && bun scripts/verify-core-package.ts",
    );

    const repository = new URL("..", import.meta.url).pathname;
    const build = Bun.spawnSync([process.execPath, "scripts/build-core.ts"], {
      cwd: repository,
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(build.exitCode).toBe(0);
    const result = Bun.spawnSync([process.execPath, "scripts/verify-core-package.ts"], {
      cwd: repository,
      env: { ...process.env, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString().trim().split("\n").at(-1);
    expect(output).toBeDefined();
    expect(JSON.parse(output!)).toMatchObject({
      package: "@swartzrock/llm-now-core",
      version: "0.0.0",
      node: "passed",
      bun: "passed",
      nodeNext: "passed",
    });
    expect(JSON.parse(output!).sha256).toMatch(/^[a-f0-9]{64}$/);
  }, 120_000);
});

import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const repositoryPackage = await Bun.file(
  new URL("../package.json", import.meta.url),
).json() as { scripts?: Record<string, string> };
const corePackage = await Bun.file(
  new URL("../packages/core/package.json", import.meta.url),
).json() as Record<string, unknown> & { version: string };

describe("private core package", () => {
  test("declares the minimal private ESM boundary", async () => {
    expect(corePackage).toMatchObject({
      name: "@swartzrock/llm-now-core",
      version: corePackage.version,
      private: true,
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
    });
    expect(corePackage.publishConfig).toBeUndefined();
    expect(corePackage.scripts).toBeUndefined();
    expect(corePackage.bin).toBeUndefined();
    expect(corePackage.browser).toBeUndefined();

    for (const file of ["README.md", "LICENSE", "CHANGELOG.md"]) {
      expect(await Bun.file(new URL(`../packages/core/${file}`, import.meta.url)).exists())
        .toBe(true);
    }
  });

  test.each([
    ["a public manifest", (manifest: Record<string, unknown>) => {
      delete manifest.private;
    }, "packed core package must be private"],
    ["publishConfig", (manifest: Record<string, unknown>) => {
      manifest.publishConfig = {};
    }, "packed core package must not contain publishConfig"],
    ["an install lifecycle script", (manifest: Record<string, unknown>) => {
      manifest.scripts = { postinstall: "echo forbidden" };
    }, "packed lifecycle script is forbidden: postinstall"],
  ])("rejects %s in the packed manifest", async (_label, mutate, expectedError) => {
    const repository = new URL("..", import.meta.url).pathname;
    const core = new URL("../packages/core", import.meta.url).pathname;
    const directory = await mkdtemp(join(repository, ".tmp-core-policy-"));
    try {
      const fixture = join(directory, "package");
      await cp(core, fixture, { recursive: true });
      const manifest = structuredClone(corePackage);
      manifest.private = true;
      delete manifest.publishConfig;
      mutate(manifest);
      await Bun.write(join(fixture, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

      const npm = Bun.which("npm");
      expect(npm).not.toBeNull();
      const packed = Bun.spawnSync([
        npm!,
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        directory,
      ], {
        cwd: fixture,
        env: { ...process.env, npm_config_cache: join(directory, "npm-cache") },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(packed.exitCode, packed.stderr.toString()).toBe(0);
      const [{ filename }] = JSON.parse(packed.stdout.toString()) as [{ filename: string }];

      const verify = Bun.spawnSync([
        process.execPath,
        "scripts/verify-core-package.ts",
        "--tarball",
        join(directory, filename),
      ], {
        cwd: repository,
        env: { ...process.env, NO_COLOR: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(verify.exitCode).not.toBe(0);
      expect(verify.stderr.toString()).toContain(expectedError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("packs and verifies real external Node, Bun, and NodeNext consumers", async () => {
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
    const artifactDirectory = await mkdtemp(join(repository, ".tmp-core-artifacts-"));
    const verify = (...args: string[]) => {
      const result = Bun.spawnSync([
        process.execPath,
        "scripts/verify-core-package.ts",
        ...args,
      ], {
        cwd: repository,
        env: { ...process.env, NO_COLOR: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      const output = result.stdout.toString().trim().split("\n").at(-1);
      expect(output).toBeDefined();
      const verification = JSON.parse(output!);
      expect(verification).toMatchObject({
        package: "@swartzrock/llm-now-core",
        version: corePackage.version,
        node: "passed",
        bun: "passed",
        nodeNext: "passed",
      });
      expect(verification.sha256).toMatch(/^[a-f0-9]{64}$/);
      return verification as { sha256: string };
    };

    try {
      expect(await readdir(artifactDirectory)).toEqual([]);
      const packedVerification = verify(artifactDirectory);
      const artifactFiles = (await readdir(artifactDirectory)).sort();
      const tarballs = artifactFiles.filter((file) => file.endsWith(".tgz"));
      expect(tarballs).toHaveLength(1);
      expect(artifactFiles).toEqual(["SHA256SUMS", tarballs[0]!].sort());

      const tarball = join(artifactDirectory, tarballs[0]!);
      const digest = new Bun.CryptoHasher("sha256")
        .update(new Uint8Array(await Bun.file(tarball).arrayBuffer()))
        .digest("hex");
      expect(digest).toBe(packedVerification.sha256);
      expect(await Bun.file(join(artifactDirectory, "SHA256SUMS")).text())
        .toBe(`${digest}  ${tarballs[0]}\n`);

      const preservedVerification = verify("--tarball", tarball);
      expect(preservedVerification.sha256).toBe(digest);
    } finally {
      await rm(artifactDirectory, { recursive: true, force: true });
    }
  }, 240_000);
});

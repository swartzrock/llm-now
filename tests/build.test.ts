import { afterEach, describe, expect, test } from "bun:test";
import { unzipSync } from "fflate";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import packageMetadata from "../package.json" with { type: "json" };
import {
  RELEASE_TARGETS,
  archiveMtime,
  archiveName,
  createExecutableArchive,
  createChecksumManifest,
} from "../scripts/build.ts";
import {
  NATIVE_VAULT_BUN_VERSION,
  NATIVE_VAULT_COMPATIBILITY,
  isNativeVaultEnabled,
} from "../src/credentials.ts";
import {
  assembleReleaseAssets,
  assertNativeVaultGateTarget,
  runProcess,
} from "../scripts/release-validate.ts";

const temporaryDirectories: string[] = [];
const testArchiveMtime = new Date("2026-07-13T12:34:56Z");
const testPackageVersion = packageMetadata.version;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("native release build", () => {
  test("keeps an explicit Bun-pinned vault policy in exact release-target parity", () => {
    expect(NATIVE_VAULT_BUN_VERSION).toBe("1.3.14");
    expect(NATIVE_VAULT_COMPATIBILITY.map((target) => target.id)).toEqual(
      RELEASE_TARGETS.map((target) => target.id),
    );
    for (const target of NATIVE_VAULT_COMPATIBILITY) {
      expect(isNativeVaultEnabled({
        bunVersion: NATIVE_VAULT_BUN_VERSION,
        platform: target.platform,
        arch: target.arch,
      })).toBe(target.enabled);
      expect(isNativeVaultEnabled({
        bunVersion: "1.3.15",
        platform: target.platform,
        arch: target.arch,
      })).toBe(false);
    }
  });

  test("fails the native lifecycle gate closed for a Bun or target mismatch", () => {
    expect(() => assertNativeVaultGateTarget({
      bunVersion: "1.3.15",
      platform: "darwin",
      arch: "arm64",
    }, "macos-arm64")).toThrow("requires Bun 1.3.14");
    expect(() => assertNativeVaultGateTarget({
      bunVersion: NATIVE_VAULT_BUN_VERSION,
      platform: "freebsd",
      arch: "arm64",
    }, "macos-arm64")).toThrow("requires darwin/arm64; received freebsd/arm64");
    expect(() => assertNativeVaultGateTarget({
      bunVersion: NATIVE_VAULT_BUN_VERSION,
      platform: "darwin",
      arch: "x64",
    }, "macos-x64")).toThrow("disabled for target macos-x64");
    expect(() => assertNativeVaultGateTarget({
      bunVersion: NATIVE_VAULT_BUN_VERSION,
      platform: "darwin",
      arch: "x64",
    }, "unknown-x64")).toThrow("disabled for target unknown-x64");
    expect(assertNativeVaultGateTarget({
      bunVersion: NATIVE_VAULT_BUN_VERSION,
      platform: "darwin",
      arch: "arm64",
    }, "macos-arm64").bunTarget).toBe("bun-darwin-arm64");
  });

  test("defines exactly the five supported glibc and baseline targets", () => {
    expect(RELEASE_TARGETS).toEqual([
      { id: "macos-x64", bunTarget: "bun-darwin-x64-baseline", runner: "macos-15-intel", executable: "llm-now" },
      { id: "macos-arm64", bunTarget: "bun-darwin-arm64", runner: "macos-15", executable: "llm-now" },
      { id: "linux-x64", bunTarget: "bun-linux-x64-baseline", runner: "ubuntu-24.04", executable: "llm-now" },
      { id: "linux-arm64", bunTarget: "bun-linux-arm64", runner: "ubuntu-24.04-arm", executable: "llm-now" },
      { id: "windows-x64", bunTarget: "bun-windows-x64-baseline", runner: "windows-2025", executable: "llm-now.exe" },
    ]);
    expect(RELEASE_TARGETS.map((target) => target.bunTarget).join(" ")).not.toContain("musl");
  });

  test("uses stable versioned archive names", () => {
    expect(archiveName("0.1.0", RELEASE_TARGETS[0]!)).toBe("llm-now-v0.1.0-macos-x64.zip");
    expect(archiveName("0.1.0", RELEASE_TARGETS[4]!)).toBe("llm-now-v0.1.0-windows-x64.zip");
  });

  test("keeps release documentation aligned with archive names", async () => {
    const readme = await Bun.file(new URL("../README.md", import.meta.url)).text();
    const releasing = await Bun.file(new URL("../docs/RELEASING.md", import.meta.url)).text();
    const manualTesting = await Bun.file(
      new URL("../docs/manual-testing.md", import.meta.url),
    ).text();

    for (const target of RELEASE_TARGETS) {
      expect(readme).toContain(archiveName("<version>", target));
      expect(releasing).toContain(archiveName("<version>", target));
      expect(manualTesting).toContain(archiveName("X.Y.Z", target));
    }
    expect(readme.match(/ARCHIVE="llm-now-v\$\{VERSION\}-\$\{TARGET\}\.zip"/g))
      .toHaveLength(2);
    expect(readme).toContain('$Archive = "llm-now-v$Version-windows-x64.zip"');
  });

  test("creates a deterministic archive containing one executable", () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const first = createExecutableArchive("llm-now", bytes, testArchiveMtime);
    const second = createExecutableArchive("llm-now", bytes, testArchiveMtime);
    expect(first).toEqual(second);
    expect(unzipSync(first)).toEqual({ "llm-now": bytes });
  });

  test("uses SOURCE_DATE_EPOCH for a meaningful reproducible archive date", () => {
    expect(archiveMtime("1783946096")).toEqual(testArchiveMtime);
    expect(() => archiveMtime("not-a-timestamp")).toThrow("SOURCE_DATE_EPOCH");
  });

  test("creates one sorted SHA-256 manifest", async () => {
    expect(await createChecksumManifest([
      { name: "b.zip", bytes: Uint8Array.from([2]) },
      { name: "a.zip", bytes: Uint8Array.from([1]) },
    ])).toBe(
      "4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a  a.zip\n" +
      "dbc1b4c900ffe48d575b5da5c638040125f65db0fe3e24494b76ea986457d986  b.zip\n",
    );
  });

  test("assembles exactly one archive per supported target", async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp-build-tests-"));
    temporaryDirectories.push(root);
    const input = join(root, "input");
    const output = join(root, "output");
    for (const target of RELEASE_TARGETS) {
      await mkdir(join(input, target.id), { recursive: true });
      await Bun.write(
        join(input, target.id, archiveName(testPackageVersion, target)),
        createExecutableArchive(target.executable, Uint8Array.from([target.id.length]), testArchiveMtime),
      );
    }

    await assembleReleaseAssets(input, output);
    const manifest = await Bun.file(join(output, "SHA256SUMS")).text();
    expect(manifest.trim().split("\n")).toHaveLength(5);
    for (const target of RELEASE_TARGETS) {
      expect(await Bun.file(join(output, archiveName(testPackageVersion, target))).exists()).toBe(true);
    }
  });

  test("rejects duplicate archive basenames across nested artifact directories", async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp-build-tests-"));
    temporaryDirectories.push(root);
    const input = join(root, "input");
    for (const target of RELEASE_TARGETS) {
      const archive = createExecutableArchive(
        target.executable,
        Uint8Array.from([target.id.length]),
        testArchiveMtime,
      );
      await mkdir(join(input, target.id), { recursive: true });
      await Bun.write(join(input, target.id, archiveName(testPackageVersion, target)), archive);
      if (target.id === "linux-x64") {
        await mkdir(join(input, "duplicate", target.id), { recursive: true });
        await Bun.write(join(input, "duplicate", target.id, archiveName(testPackageVersion, target)), archive);
      }
    }

    await expect(assembleReleaseAssets(input, join(root, "output"))).rejects.toThrow(
      "release archive set mismatch",
    );
  });

  test("assembles a selected release target set", async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp-build-tests-"));
    temporaryDirectories.push(root);
    const input = join(root, "input");
    const output = join(root, "output");
    const macosTargets = RELEASE_TARGETS.filter((target) => target.id.startsWith("macos-"));
    for (const target of macosTargets) {
      await mkdir(join(input, target.id), { recursive: true });
      await Bun.write(
        join(input, target.id, archiveName(testPackageVersion, target)),
        createExecutableArchive(target.executable, Uint8Array.from([target.id.length]), testArchiveMtime),
      );
    }

    await assembleReleaseAssets(input, output, ["macos-x64", "macos-arm64"]);
    const manifest = await Bun.file(join(output, "SHA256SUMS")).text();
    expect(manifest.trim().split("\n")).toHaveLength(2);
    for (const target of macosTargets) {
      expect(await Bun.file(join(output, archiveName(testPackageVersion, target))).exists()).toBe(true);
    }

    const windowsTarget = RELEASE_TARGETS.find((target) => target.id === "windows-x64")!;
    await mkdir(join(input, windowsTarget.id), { recursive: true });
    await Bun.write(
      join(input, windowsTarget.id, archiveName(testPackageVersion, windowsTarget)),
      createExecutableArchive(windowsTarget.executable, Uint8Array.of(1), testArchiveMtime),
    );
    await expect(
      assembleReleaseAssets(input, output, ["macos-x64", "macos-arm64"]),
    ).rejects.toThrow("release archive set mismatch");
  });

  test("keeps the Bun event loop available while a child calls a local fixture", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("fixture-ok") });
    try {
      const result = await runProcess(
        process.execPath,
        ["-e", `process.stdout.write(await (await fetch(${JSON.stringify(server.url.toString())})).text())`],
        { cwd: process.cwd(), env: process.env, timeoutMs: 2_000 },
      );
      expect(result).toEqual({ exitCode: 0, stdout: "fixture-ok", stderr: "" });
    } finally {
      server.stop(true);
    }
  });

  test("rejects an archive whose executable does not match its target", async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp-build-tests-"));
    temporaryDirectories.push(root);
    const input = join(root, "input");
    for (const target of RELEASE_TARGETS) {
      await mkdir(join(input, target.id), { recursive: true });
      await Bun.write(
        join(input, target.id, archiveName(testPackageVersion, target)),
        createExecutableArchive(
          target.id === "windows-x64" ? "llm-now" : target.executable,
          Uint8Array.of(1),
          testArchiveMtime,
        ),
      );
    }
    await expect(assembleReleaseAssets(input, join(root, "output"))).rejects.toThrow(
      "windows-x64.zip must contain llm-now.exe",
    );
  });
});

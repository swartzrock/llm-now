import { afterEach, describe, expect, test } from "bun:test";
import { unzipSync } from "fflate";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  RELEASE_TARGETS,
  archiveName,
  createExecutableArchive,
  createChecksumManifest,
} from "../scripts/build.ts";
import { assembleReleaseAssets } from "../scripts/release-validate.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("native release build", () => {
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

  test("creates a deterministic archive containing one executable", () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const first = createExecutableArchive("llm-now", bytes);
    const second = createExecutableArchive("llm-now", bytes);
    expect(first).toEqual(second);
    expect(unzipSync(first)).toEqual({ "llm-now": bytes });
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
        join(input, target.id, archiveName("0.1.0", target)),
        createExecutableArchive(target.executable, Uint8Array.from([target.id.length])),
      );
    }

    await assembleReleaseAssets(input, output);
    const manifest = await Bun.file(join(output, "SHA256SUMS")).text();
    expect(manifest.trim().split("\n")).toHaveLength(5);
    for (const target of RELEASE_TARGETS) {
      expect(await Bun.file(join(output, archiveName("0.1.0", target))).exists()).toBe(true);
    }
  });
});

import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import packageMetadata from "../package.json" with { type: "json" };

export interface ReleaseTarget {
  id: "macos-x64" | "macos-arm64" | "linux-x64" | "linux-arm64" | "windows-x64";
  bunTarget: Bun.Build.CompileTarget;
  runner: string;
  executable: "llm-now" | "llm-now.exe";
}

export const RELEASE_TARGETS: readonly ReleaseTarget[] = [
  { id: "macos-x64", bunTarget: "bun-darwin-x64-baseline", runner: "macos-15-intel", executable: "llm-now" },
  { id: "macos-arm64", bunTarget: "bun-darwin-arm64", runner: "macos-15", executable: "llm-now" },
  { id: "linux-x64", bunTarget: "bun-linux-x64-baseline", runner: "ubuntu-24.04", executable: "llm-now" },
  { id: "linux-arm64", bunTarget: "bun-linux-arm64", runner: "ubuntu-24.04-arm", executable: "llm-now" },
  { id: "windows-x64", bunTarget: "bun-windows-x64-baseline", runner: "windows-2025", executable: "llm-now.exe" },
];

export function archiveName(version: string, target: ReleaseTarget): string {
  return `llm-now-v${version}-${target.id}.zip`;
}

export function archiveMtime(sourceDateEpoch = process.env.SOURCE_DATE_EPOCH): Date {
  if (sourceDateEpoch === undefined) return new Date();
  if (!/^\d+$/.test(sourceDateEpoch)) {
    throw new Error("SOURCE_DATE_EPOCH must be a Unix timestamp in whole seconds");
  }
  const seconds = Number(sourceDateEpoch);
  const date = new Date(seconds * 1_000);
  if (!Number.isSafeInteger(seconds) || date.getUTCFullYear() < 1980 || seconds > 0xffff_ffff) {
    throw new Error("SOURCE_DATE_EPOCH must be representable by the ZIP timestamp range (1980-2106)");
  }
  return date;
}

export function createExecutableArchive(
  name: string,
  bytes: Uint8Array,
  mtime: Date,
): Uint8Array {
  const unixMtime = new Uint8Array(5);
  unixMtime[0] = 1;
  new DataView(unixMtime.buffer).setUint32(1, Math.floor(mtime.getTime() / 1_000), true);
  return zipSync({
    [name]: [bytes, { os: 3, attrs: 0o755 << 16, extra: { [0x5455]: unixMtime } }],
  }, { level: 9, mtime });
}

export function extractExecutableArchive(
  bytes: Uint8Array,
  label = "archive",
): { name: "llm-now" | "llm-now.exe"; bytes: Uint8Array } {
  const entries = unzipSync(bytes);
  const names = Object.keys(entries);
  const name = names[0];
  if (names.length !== 1 || (name !== "llm-now" && name !== "llm-now.exe")) {
    throw new Error(`${label} must contain exactly one llm-now executable`);
  }
  return { name, bytes: entries[name]! };
}

export async function createChecksumManifest(
  archives: readonly { name: string; bytes: Uint8Array }[],
): Promise<string> {
  const lines = [...archives]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, bytes }) => {
      const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      return `${digest}  ${name}`;
    });
  return `${lines.join("\n")}\n`;
}

function runCodesign(args: string[], label: string): void {
  const result = Bun.spawnSync(["codesign", ...args], {
    stdin: new Uint8Array(),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${label}: ${result.stderr.toString().trim()}`);
  }
}

function repairMacosSignature(target: ReleaseTarget, executable: string): void {
  if (!target.id.startsWith("macos-")) return;
  if (process.platform !== "darwin") {
    throw new Error(`${target.id} must be built on macOS so its code signature can be repaired`);
  }
  runCodesign(["--force", "--sign", "-", executable], `failed to sign ${target.id}`);
  runCodesign(["--verify", "--strict", "--verbose=2", executable], `invalid signature for ${target.id}`);
}

async function buildTarget(target: ReleaseTarget, outdir: string, mtime: Date): Promise<string> {
  const workdir = join(outdir, `.work-${target.id}`);
  const executable = join(workdir, target.executable);
  await mkdir(workdir, { recursive: true });
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "../index.ts")],
      compile: {
        target: target.bunTarget,
        outfile: executable,
        autoloadDotenv: false,
        autoloadBunfig: false,
        autoloadTsconfig: false,
        autoloadPackageJson: false,
      },
    });
    if (!build.success) throw new AggregateError(build.logs, `failed to build ${target.id}`);
    if (target.executable !== "llm-now.exe") await chmod(executable, 0o755);
    repairMacosSignature(target, executable);

    const name = archiveName(packageMetadata.version, target);
    await Bun.write(
      join(outdir, name),
      createExecutableArchive(
        target.executable,
        new Uint8Array(await Bun.file(executable).arrayBuffer()),
        mtime,
      ),
    );
    return name;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

function argument(name: string, fallback?: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? fallback : Bun.argv[index + 1];
}

async function main(): Promise<void> {
  const outdir = argument("--outdir", join(import.meta.dir, "../dist"))!;
  const targetId = argument("--target", "all")!;
  const targets = targetId === "all"
    ? RELEASE_TARGETS
    : RELEASE_TARGETS.filter((target) => target.id === targetId);
  if (targets.length === 0) throw new Error(`unknown release target: ${targetId}`);

  await mkdir(outdir, { recursive: true });
  const mtime = archiveMtime();
  const names: string[] = [];
  for (const target of targets) names.push(await buildTarget(target, outdir, mtime));
  const archives = await Promise.all(names.map(async (name) => ({
    name,
    bytes: new Uint8Array(await Bun.file(join(outdir, name)).arrayBuffer()),
  })));
  await Bun.write(join(outdir, "SHA256SUMS"), await createChecksumManifest(archives));
  console.log(names.join("\n"));
}

if (import.meta.main) await main();

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

export function createExecutableArchive(name: string, bytes: Uint8Array): Uint8Array {
  return zipSync({
    [name]: [bytes, { os: 3, attrs: 0o755 << 16 }],
  }, { level: 9, mtime: new Date("1980-01-01T00:00:00Z") });
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

async function buildTarget(target: ReleaseTarget, outdir: string): Promise<string> {
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

    const name = archiveName(packageMetadata.version, target);
    await Bun.write(
      join(outdir, name),
      createExecutableArchive(target.executable, new Uint8Array(await Bun.file(executable).arrayBuffer())),
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
  const names: string[] = [];
  for (const target of targets) names.push(await buildTarget(target, outdir));
  const archives = await Promise.all(names.map(async (name) => ({
    name,
    bytes: new Uint8Array(await Bun.file(join(outdir, name)).arrayBuffer()),
  })));
  await Bun.write(join(outdir, "SHA256SUMS"), await createChecksumManifest(archives));
  console.log(names.join("\n"));
}

if (import.meta.main) await main();

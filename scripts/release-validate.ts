import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { unzipSync } from "fflate";
import packageMetadata from "../package.json" with { type: "json" };
import {
  RELEASE_TARGETS,
  archiveName,
  createChecksumManifest,
} from "./build.ts";

async function zipFiles(directory: string): Promise<string[]> {
  const names: string[] = [];
  for await (const path of new Bun.Glob("**/*.zip").scan({ cwd: directory, absolute: true, onlyFiles: true })) {
    names.push(path);
  }
  return names.sort();
}

function archiveExecutable(path: string, bytes: Uint8Array): { name: string; bytes: Uint8Array } {
  const entries = unzipSync(bytes);
  const names = Object.keys(entries);
  if (names.length !== 1 || !["llm-now", "llm-now.exe"].includes(names[0]!)) {
    throw new Error(`${path} must contain exactly one llm-now executable`);
  }
  return { name: names[0]!, bytes: entries[names[0]!]! };
}

export async function validateArchives(directory: string): Promise<void> {
  const files = await zipFiles(directory);
  if (files.length === 0) throw new Error(`no release archives found in ${directory}`);
  for (const path of files) {
    archiveExecutable(path, new Uint8Array(await Bun.file(path).arrayBuffer()));
  }
}

export async function assembleReleaseAssets(input: string, output: string): Promise<void> {
  const files = await zipFiles(input);
  const actualNames = files.map((path) => path.split(/[\\/]/).at(-1)!).sort();
  const expectedNames = RELEASE_TARGETS.map((target) => archiveName(packageMetadata.version, target)).sort();
  if (new Set(actualNames).size !== expectedNames.length || actualNames.join("\n") !== expectedNames.join("\n")) {
    throw new Error(`release archive set mismatch: expected ${expectedNames.join(", ")}; received ${actualNames.join(", ")}`);
  }
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const archives = [];
  for (const path of files) {
    const name = path.split(/[\\/]/).at(-1)!;
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    archiveExecutable(path, bytes);
    await Bun.write(join(output, name), bytes);
    archives.push({ name, bytes });
  }
  await Bun.write(join(output, "SHA256SUMS"), await createChecksumManifest(archives));
}

function run(executable: string, args: string[], options: { cwd: string; env: Record<string, string | undefined> }) {
  return Bun.spawnSync([executable, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: new Uint8Array(),
  });
}

async function smoke(archivePath: string): Promise<void> {
  const temporary = await mkdtemp(join(process.cwd(), ".tmp-release-smoke-"));
  try {
    const archive = new Uint8Array(await Bun.file(archivePath).arrayBuffer());
    const entry = archiveExecutable(archivePath, archive);
    const executable = join(temporary, entry.name);
    await Bun.write(executable, entry.bytes);
    if (process.platform !== "win32") await chmod(executable, 0o755);

    const fakeCli = join(temporary, process.platform === "win32" ? "codex.exe" : "codex");
    const fakeBuild = await Bun.build({
      entrypoints: [join(import.meta.dir, "../tests/fixtures/fake-cli.ts")],
      compile: {
        outfile: fakeCli,
        autoloadDotenv: false,
        autoloadBunfig: false,
        autoloadTsconfig: false,
        autoloadPackageJson: false,
      },
    });
    if (!fakeBuild.success) throw new AggregateError(fakeBuild.logs, "failed to compile fake CLI");
    if (process.platform !== "win32") await chmod(fakeCli, 0o755);

    await Bun.write(join(temporary, ".env"), "OPENAI_API_KEY=must-not-autoload\n");
    await Bun.write(join(temporary, "bunfig.toml"), "this is intentionally invalid");
    await Bun.write(join(temporary, "tsconfig.json"), "this is intentionally invalid");
    await Bun.write(join(temporary, "package.json"), "this is intentionally invalid");

    const env = {
      ...process.env,
      PATH: [temporary, process.env.PATH].filter(Boolean).join(delimiter),
    };
    const cases = [
      { args: ["--help"], code: 0, stdoutIncludes: "Usage:\n  llm-now --input <text>", stderrIncludes: "" },
      { args: ["--version"], code: 0, stdout: "0.1.0\n", stderrIncludes: "" },
      { args: ["--input", "smoke"], code: 2, stdout: "", stderrIncludes: "usage: non-interactive calls require" },
      { args: ["--input", "smoke", "--provider", "codex-cli", "--model", "default"], code: 0, stdout: "fake:smoke", stderrIncludes: "" },
    ] as const;

    for (const testCase of cases) {
      const result = run(executable, [...testCase.args], { cwd: temporary, env });
      const stdout = result.stdout.toString();
      const stderr = result.stderr.toString();
      const stdoutMatches = "stdout" in testCase
        ? stdout === testCase.stdout
        : stdout.includes(testCase.stdoutIncludes);
      if (result.exitCode !== testCase.code || !stdoutMatches || !stderr.includes(testCase.stderrIncludes)) {
        throw new Error(`native smoke failed: args=${testCase.args.join(" ")} exit=${result.exitCode} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
      }
    }

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 11434,
      fetch: async (request) => request.url.endsWith("/api/generate")
        ? Response.json({ response: "http:smoke" })
        : Response.json({ models: [{ name: "fake-model" }] }),
    });
    try {
      const result = run(executable, ["--input", "smoke", "--provider", "ollama", "--model", "fake-model"], {
        cwd: temporary,
        env,
      });
      if (result.exitCode !== 0 || result.stdout.toString() !== "http:smoke" || result.stderr.toString() !== "") {
        throw new Error(`native HTTP smoke failed: exit=${result.exitCode} stdout=${JSON.stringify(result.stdout.toString())} stderr=${JSON.stringify(result.stderr.toString())}`);
      }
    } finally {
      server.stop(true);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const [command, ...args] = Bun.argv.slice(2);
  if (command === "archives" && args[0]) await validateArchives(args[0]);
  else if (command === "assemble" && args[0] && args[1]) await assembleReleaseAssets(args[0], args[1]);
  else if (command === "smoke" && args[0]) await smoke(args[0]);
  else throw new Error("usage: release-validate <archives DIR | assemble INPUT OUTPUT | smoke ARCHIVE>");
}

if (import.meta.main) await main();

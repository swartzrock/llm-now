import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, delimiter, join } from "node:path";
import packageMetadata from "../package.json" with { type: "json" };
import {
  RELEASE_TARGETS,
  archiveName,
  createChecksumManifest,
  extractExecutableArchive,
} from "./build.ts";

async function zipFiles(directory: string): Promise<string[]> {
  const names: string[] = [];
  for await (const path of new Bun.Glob("**/*.zip").scan({ cwd: directory, absolute: true, onlyFiles: true })) {
    names.push(path);
  }
  return names.sort();
}

export async function validateArchives(directory: string): Promise<void> {
  const files = await zipFiles(directory);
  if (files.length === 0) throw new Error(`no release archives found in ${directory}`);
  for (const path of files) {
    const target = RELEASE_TARGETS.find(
      (candidate) => archiveName(packageMetadata.version, candidate) === basename(path),
    );
    if (!target) throw new Error(`unexpected release archive: ${basename(path)}`);
    const entry = extractExecutableArchive(
      new Uint8Array(await Bun.file(path).arrayBuffer()),
      path,
    );
    if (entry.name !== target.executable) {
      throw new Error(`${basename(path)} must contain ${target.executable}`);
    }
  }
}

export async function assembleReleaseAssets(
  input: string,
  output: string,
  targetIds?: readonly string[],
): Promise<void> {
  const selectedTargetIds = targetIds ?? RELEASE_TARGETS.map((target) => target.id);
  const targets = selectedTargetIds.map((id) => {
    const target = RELEASE_TARGETS.find((candidate) => candidate.id === id);
    if (!target) throw new Error(`unknown release target: ${id}`);
    return target;
  });
  if (new Set(selectedTargetIds).size !== selectedTargetIds.length) throw new Error("duplicate release target");
  const files = await zipFiles(input);
  const actualNames = files.map((path) => basename(path)).sort();
  const expectedNames = targets.map((target) => archiveName(packageMetadata.version, target)).sort();
  if (new Set(actualNames).size !== expectedNames.length || actualNames.join("\n") !== expectedNames.join("\n")) {
    throw new Error(`release archive set mismatch: expected ${expectedNames.join(", ")}; received ${actualNames.join(", ")}`);
  }
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const archives = [];
  for (const path of files) {
    const name = basename(path);
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    const target = targets.find(
      (candidate) => archiveName(packageMetadata.version, candidate) === name,
    )!;
    const entry = extractExecutableArchive(bytes, path);
    if (entry.name !== target.executable) throw new Error(`${name} must contain ${target.executable}`);
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

export async function runProcess(
  executable: string,
  args: string[],
  options: { cwd: string; env: Record<string, string | undefined>; timeoutMs?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([executable, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: new Uint8Array(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const timeoutMs = options.timeoutMs ?? 10_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await Promise.race([
      child.exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`native process timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { exitCode, stdout: await stdout, stderr: await stderr };
  } catch (error) {
    child.kill();
    await child.exited;
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function smoke(archivePath: string): Promise<void> {
  const temporary = await mkdtemp(join(process.cwd(), ".tmp-release-smoke-"));
  try {
    const archive = new Uint8Array(await Bun.file(archivePath).arrayBuffer());
    const entry = extractExecutableArchive(archive, archivePath);
    const executable = join(temporary, entry.name);
    await Bun.write(executable, entry.bytes);
    if (process.platform !== "win32") await chmod(executable, 0o755);
    if (process.platform === "darwin") {
      const signature = run("codesign", ["--verify", "--strict", "--verbose=2", executable], {
        cwd: temporary,
        env: process.env,
      });
      if (signature.exitCode !== 0) {
        throw new Error(`native macOS signature validation failed: ${signature.stderr.toString().trim()}`);
      }
    }

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
      { args: ["--help"], code: 0, stdoutIncludes: "Usage:\n  llm-now\n  llm-now --input <text>", stderrIncludes: "" },
      { args: ["--version"], code: 0, stdout: `${packageMetadata.version}\n`, stderrIncludes: "" },
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
      const result = await runProcess(executable, ["--input", "smoke", "--provider", "ollama", "--model", "fake-model"], {
        cwd: temporary,
        env,
      });
      if (result.exitCode !== 0 || result.stdout !== "http:smoke" || result.stderr !== "") {
        throw new Error(`native HTTP smoke failed: exit=${result.exitCode} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`);
      }
    } finally {
      server.stop(true);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function main(): Promise<void> {
  const [command, ...args] = Bun.argv.slice(2);
  if (command === "archives" && args[0]) await validateArchives(args[0]);
  else if (command === "assemble" && args[0] && args[1]) {
    await assembleReleaseAssets(args[0], args[1], args.length > 2 ? args.slice(2) : undefined);
  }
  else if (command === "smoke" && args[0]) await smoke(args[0]);
  else throw new Error("usage: release-validate <archives DIR | assemble INPUT OUTPUT [TARGET ...] | smoke ARCHIVE>");
}

if (import.meta.main) await main();

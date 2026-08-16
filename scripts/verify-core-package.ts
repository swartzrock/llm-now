import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repositoryRoot = join(import.meta.dir, "..");
const coreRoot = join(repositoryRoot, "packages", "core");
const fixturesRoot = join(repositoryRoot, "tests", "fixtures");
const bunBinary = Bun.which("bun") ?? process.execPath;

const EXPECTED_FILES = [
  "package/CHANGELOG.md",
  "package/LICENSE",
  "package/README.md",
  "package/dist/cli-execution.d.ts",
  "package/dist/client.d.ts",
  "package/dist/credentials.d.ts",
  "package/dist/errors.d.ts",
  "package/dist/index.d.ts",
  "package/dist/index.js",
  "package/dist/providers.d.ts",
  "package/dist/routing.d.ts",
  "package/dist/safety.d.ts",
  "package/dist/streaming.d.ts",
  "package/dist/types.d.ts",
  "package/dist/workspace.d.ts",
  "package/package.json",
].sort();

const LIFECYCLE_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepack",
  "prepare",
  "postpack",
  "prepublish",
  "prepublishOnly",
  "publish",
  "postpublish",
]);

interface TarEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

function textField(bytes: Uint8Array, start: number, length: number): string {
  const field = bytes.subarray(start, start + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end < 0 ? field : field.subarray(0, end));
}

function tarEntries(compressed: Uint8Array<ArrayBuffer>): readonly TarEntry[] {
  const archive = Bun.gunzipSync(compressed);
  const entries: TarEntry[] = [];
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = textField(header, 0, 100);
    const prefix = textField(header, 345, 155);
    const fullName = prefix.length > 0 ? `${prefix}/${name}` : name;
    const sizeText = textField(header, 124, 12).trim();
    const size = sizeText.length === 0 ? 0 : Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid tar entry size");
    const type = String.fromCharCode(header[156] ?? 0);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > archive.length) throw new Error("truncated tar entry");
    if (type === "\0" || type === "0") {
      entries.push({ name: fullName, bytes: archive.subarray(contentStart, contentEnd) });
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function run(command: readonly string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const result = Bun.spawnSync([...command], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed: ${command.join(" ")}\n${result.stderr.toString()}${result.stdout.toString()}`,
    );
  }
  return result.stdout.toString();
}

async function installConsumer(
  source: string,
  destination: string,
  tarball: string,
  cache: string,
): Promise<void> {
  await cp(source, destination, { recursive: true });
  const manifestPath = join(destination, "package.json");
  const manifest = await Bun.file(manifestPath).text();
  await Bun.write(manifestPath, manifest.replace("file:__CORE_TARBALL__", `file:${tarball}`));
  run([
    bunBinary,
    "install",
    "--ignore-scripts",
    "--cache-dir",
    cache,
    "--no-progress",
    "--no-summary",
  ], destination, {
    ...process.env,
    BUN_INSTALL_CACHE_DIR: cache,
    npm_config_cache: cache,
  });
}

async function runtimeSmoke(
  runtime: string,
  consumer: string,
  home: string,
  fakeExecutable: string,
): Promise<void> {
  const fakeCli = join(consumer, "fake-cli.mjs");
  const output = run([runtime, "smoke.mjs"], consumer, {
    ...process.env,
    HOME: home,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    CORE_FIXTURE_EXECUTABLE: fakeExecutable,
    CORE_FIXTURE_CLI: fakeCli,
    SHOULD_NOT_LEAK: "parent-only",
  }).trim();
  const record = JSON.parse(output) as { status?: string };
  if (record.status !== "passed") throw new Error(`${runtime} consumer smoke did not pass`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inputTarball = args[0] === "--tarball" && args.length === 2
    ? resolve(args[1]!)
    : undefined;
  const outputDirectory = inputTarball === undefined && args.length <= 1
    ? args[0]
    : undefined;
  if (
    inputTarball === undefined
    && (args.length > 1 || args[0] === "--tarball")
  ) {
    throw new Error(
      "usage: bun scripts/verify-core-package.ts [artifact-directory] | --tarball <path>",
    );
  }
  const sourceManifest = await Bun.file(join(coreRoot, "package.json")).json() as {
    name?: string;
    version?: string;
    private?: boolean;
    publishConfig?: unknown;
    scripts?: Record<string, string>;
  };
  if (sourceManifest.private !== true) throw new Error("source core package must be private");
  if (Object.hasOwn(sourceManifest, "publishConfig")) {
    throw new Error("source core package must not contain publishConfig");
  }
  for (const script of Object.keys(sourceManifest.scripts ?? {})) {
    if (LIFECYCLE_SCRIPTS.has(script)) throw new Error(`source lifecycle script is forbidden: ${script}`);
  }
  let temporary: string;
  try {
    temporary = await mkdtemp(join(tmpdir(), "llm-now-core-package-"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EPERM")) throw error;
    temporary = await mkdtemp(join(repositoryRoot, "..", ".tmp-llm-now-core-package-"));
  }
  try {
    const artifactDirectory = join(temporary, "artifact");
    const installCache = join(temporary, "bun-cache");
    await mkdir(artifactDirectory, { recursive: true });
    await mkdir(installCache, { recursive: true });
    const npmBinary = Bun.which("npm");
    if (npmBinary === null) throw new Error("npm is required to reproduce registry pack semantics");
    const tarball = join(artifactDirectory, "llm-now-core.tgz");
    if (inputTarball === undefined) {
      const packOutput = run([
        npmBinary,
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        artifactDirectory,
      ], coreRoot, {
        ...process.env,
        BUN_INSTALL_CACHE_DIR: installCache,
        npm_config_cache: installCache,
      });
      const packed = JSON.parse(packOutput) as [{ filename?: string }];
      if (packed.length !== 1 || typeof packed[0]?.filename !== "string") {
        throw new Error("npm pack did not produce exactly one artifact");
      }
      await rename(join(artifactDirectory, packed[0].filename), tarball);
    } else {
      await cp(inputTarball, tarball);
    }
    const tarballBytes = new Uint8Array(await Bun.file(tarball).arrayBuffer());
    const digest = new Bun.CryptoHasher("sha256").update(tarballBytes).digest("hex");
    const entries = tarEntries(tarballBytes);
    const names = entries.map(({ name }) => name).sort();
    if (JSON.stringify(names) !== JSON.stringify(EXPECTED_FILES)) {
      throw new Error(`unexpected package files: ${JSON.stringify(names)}`);
    }
    const entryMap = new Map(entries.map((entry) => [entry.name, entry.bytes]));
    const manifestBytes = entryMap.get("package/package.json");
    if (manifestBytes === undefined) throw new Error("packed package.json is missing");
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
      name?: string;
      version?: string;
      private?: boolean;
      type?: string;
      sideEffects?: boolean;
      license?: string;
      engines?: Record<string, string>;
      files?: string[];
      exports?: Record<string, unknown>;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      publishConfig?: unknown;
      bin?: unknown;
      browser?: unknown;
    };
    if (manifest.private !== true) throw new Error("packed core package must be private");
    if (Object.hasOwn(manifest, "publishConfig")) {
      throw new Error("packed core package must not contain publishConfig");
    }
    if (
      manifest.name !== "@swartzrock/llm-now-core"
      || manifest.version !== sourceManifest.version
      || manifest.type !== "module"
      || manifest.sideEffects !== false
      || manifest.license !== "MIT"
      || manifest.engines?.node !== ">=20"
      || manifest.engines?.bun !== ">=1.3.14"
      || manifest.bin !== undefined
      || manifest.browser !== undefined
    ) throw new Error("packed manifest does not match the private runtime contract");
    if (JSON.stringify(Object.keys(manifest.exports ?? {})) !== JSON.stringify(["."])) {
      throw new Error("packed package must expose only its root");
    }
    if (JSON.stringify(manifest.files) !== JSON.stringify(["dist", "README.md", "LICENSE", "CHANGELOG.md"])) {
      throw new Error("packed package files allowlist changed");
    }
    if (
      manifest.dependencies?.["@3leaps/string-metrics-wasm"] !== "0.3.11"
      || manifest.dependencies?.["@swartzrock/byok-runtime"] !== "2.4.1"
      || manifest.dependencies?.["unicode-case-folding"] !== "1.1.1"
      || Object.keys(manifest.dependencies ?? {}).length !== 3
    ) throw new Error("packed runtime dependency pins changed");
    for (const script of Object.keys(manifest.scripts ?? {})) {
      if (LIFECYCLE_SCRIPTS.has(script)) throw new Error(`packed lifecycle script is forbidden: ${script}`);
    }
    if (manifest.scripts !== undefined) throw new Error("packed package must not contain repository scripts");

    const publicGraph = entries
      .filter(({ name }) => name.endsWith(".js") || name.endsWith(".d.ts"))
      .map(({ bytes }) => new TextDecoder().decode(bytes))
      .join("\n");
    for (const forbidden of [
      /\bBun(?:\.secrets)?\b/,
      /\bprocess\.env\b/,
      /\b(?:HOME|XDG_CONFIG_HOME|SHELL|COMSPEC)\b/,
      /NATIVE_VAULT_SERVICE/,
      /credential-locks/,
      /\.llm-now/,
    ]) {
      if (forbidden.test(publicGraph)) throw new Error(`forbidden core static string: ${forbidden}`);
    }
    if (!/from ["']@swartzrock\/byok-runtime["']/.test(publicGraph)) {
      throw new Error("BYOK Runtime root import was not externalized");
    }
    if (!/from ["']@swartzrock\/byok-runtime\/node["']/.test(publicGraph)) {
      throw new Error("BYOK Runtime node import was not externalized");
    }

    const nodeBinary = Bun.which("node");
    if (nodeBinary === null) throw new Error("Node 20 or later is required for package verification");
    const nodeVersion = run([nodeBinary, "--version"], repositoryRoot, process.env).trim();
    const nodeMajor = Number.parseInt(nodeVersion.replace(/^v/, "").split(".")[0] ?? "", 10);
    if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 20) {
      throw new Error(`Node 20 or later is required; received ${nodeVersion}`);
    }

    const nodeConsumer = join(temporary, "node-consumer");
    const bunConsumer = join(temporary, "bun-consumer");
    const typescriptConsumer = join(temporary, "typescript-consumer");
    await installConsumer(
      join(fixturesRoot, "core-consumer-node"),
      nodeConsumer,
      tarball,
      installCache,
    );
    await installConsumer(
      join(fixturesRoot, "core-consumer-bun"),
      bunConsumer,
      tarball,
      installCache,
    );
    await cp(join(fixturesRoot, "core-consumer-node", "smoke.mjs"), join(bunConsumer, "smoke.mjs"));
    await cp(join(fixturesRoot, "core-consumer-node", "fake-cli.mjs"), join(bunConsumer, "fake-cli.mjs"));
    await installConsumer(
      join(fixturesRoot, "core-consumer-typescript"),
      typescriptConsumer,
      tarball,
      installCache,
    );

    const nodeHome = join(temporary, "node-home");
    const bunHome = join(temporary, "bun-home");
    await mkdir(nodeHome);
    await mkdir(bunHome);
    await runtimeSmoke(nodeBinary, nodeConsumer, nodeHome, nodeBinary);
    await runtimeSmoke(bunBinary, bunConsumer, bunHome, nodeBinary);
    run([
      bunBinary,
      join(typescriptConsumer, "node_modules", "typescript", "bin", "tsc"),
      "--project",
      join(typescriptConsumer, "tsconfig.json"),
    ], typescriptConsumer, process.env);

    if (outputDirectory !== undefined) {
      await mkdir(outputDirectory, { recursive: true });
      if ((await readdir(outputDirectory)).length !== 0) {
        throw new Error("artifact directory must be empty");
      }
      const artifactName = `swartzrock-llm-now-core-${manifest.version}.tgz`;
      await cp(tarball, join(outputDirectory, artifactName));
      await Bun.write(join(outputDirectory, "SHA256SUMS"), `${digest}  ${artifactName}\n`);
    }

    console.log(JSON.stringify({
      package: manifest.name,
      version: manifest.version,
      sha256: digest,
      files: names.length,
      node: "passed",
      bun: "passed",
      nodeNext: "passed",
      ...(outputDirectory === undefined ? {} : { artifactDirectory: outputDirectory }),
    }));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();

import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import packageMetadata from "../packages/cli/package.json" with { type: "json" };
import {
  NATIVE_VAULT_BUN_VERSION,
  NATIVE_VAULT_COMPATIBILITY,
  type NativeVaultTarget,
} from "../packages/cli/src/credentials.ts";
import { serializeConfigDocument } from "../packages/cli/src/config-schema.ts";
import {
  RELEASE_TARGETS,
  archiveName,
  createChecksumManifest,
  extractExecutableArchive,
} from "./build.ts";

const VOICE_PACKAGES = {
  metric: {
    name: "@3leaps/string-metrics-wasm",
    version: "0.3.11",
    integrity: "sha512-An4O6Dd0ZVSn9/xAPJhnLKfMjDvZ5Pa+YuhwnA0gzPRBtRlLkHvYDvi77p/xZORPOKDpm5CVR153NOa1XL/h/w==",
  },
  caseFolding: {
    name: "unicode-case-folding",
    version: "1.1.1",
    integrity: "sha512-ZAYziAnMTBisO2dT5tyGvBFMNsIfonOS/BZTd3UZaKWtXMOZqK8s8HRUCrlKxGCTeCxCuCjS/6HW+4a6G+rbzw==",
  },
} as const;

const CONFIG_SERIALIZER_PACKAGE = {
  name: "smol-toml",
  version: "1.7.1",
  integrity: "sha512-PPlsspAZ4jbMBu5DMFhfUGDQLu/vrL4SyBROVS37x8ynnVmFIs1VPBz1Co8Xks3TvpIaZXmU85y4DrQ+UyVFoQ==",
} as const;

type PackageManifest = {
  name?: string;
  version?: string;
  license?: string;
  main?: string;
  files?: string[];
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  exports?: { import?: string; "."?: { import?: string } };
};

async function installedFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for await (const path of new Bun.Glob("**/*").scan({ cwd: directory, onlyFiles: true })) {
    files.push(path);
  }
  return files.sort();
}

function jsImports(source: string): string[] {
  return [...source.matchAll(/\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g)]
    .map((match) => match[1]!);
}

function assertComputationOnly(label: string, sources: readonly string[]): void {
  const joined = sources.join("\n");
  const forbidden = [
    ["network", /\b(?:fetch|WebSocket|XMLHttpRequest)\s*\(/],
    ["filesystem", /\b(?:Bun\.file|readFile|writeFile|node:fs)\b/],
    ["child process", /\b(?:Bun\.spawn|child_process|node:child_process)\b/],
    ["environment", /\b(?:process\.env|Deno\.env)\b/],
  ] as const;
  for (const [capability, pattern] of forbidden) {
    if (pattern.test(joined)) throw new Error(`${label} active entrypoint accesses ${capability}`);
  }
}

export async function validateVoiceDependencies() {
  const root = join(import.meta.dir, "..");
  const cliModules = join(root, "packages", "cli", "node_modules");
  const lock = await Bun.file(join(root, "bun.lock")).text();
  const dependencies = packageMetadata.dependencies as Record<string, string>;
  for (const expected of Object.values(VOICE_PACKAGES)) {
    if (dependencies[expected.name] !== expected.version) {
      throw new Error(`${expected.name} must be exactly pinned to ${expected.version}`);
    }
    const lockEntry = `"${expected.name}": ["${expected.name}@${expected.version}", "", {}, "${expected.integrity}"]`;
    if (!lock.includes(lockEntry)) throw new Error(`${expected.name} lock integrity does not match the audited package`);
  }

  const metricRoot = join(cliModules, "@3leaps", "string-metrics-wasm");
  const metricManifest = await Bun.file(join(metricRoot, "package.json")).json() as PackageManifest;
  if (
    metricManifest.name !== VOICE_PACKAGES.metric.name
    || metricManifest.version !== VOICE_PACKAGES.metric.version
    || metricManifest.license !== "MIT"
  ) throw new Error("metric package manifest changed");
  const metricIndex = await Bun.file(join(metricRoot, "dist", "index.js")).text();
  const metricLoader = await Bun.file(join(metricRoot, "dist", "wasm.js")).text();
  const metricGlue = await Bun.file(join(metricRoot, "pkg", "web", "string_metrics_wasm.js")).text();
  const metricInline = await Bun.file(join(metricRoot, "dist", "wasm-inline.js")).text();
  const metricFiles = await installedFiles(metricRoot);
  const metricEntrypoint = metricManifest.exports?.["."]?.import;
  if (metricEntrypoint !== "./dist/index.js") throw new Error("metric package root export changed");
  const metricRuntimeDependencies = Object.keys(metricManifest.dependencies ?? {}).sort();
  const metricInstallScripts = ["preinstall", "install", "postinstall"]
    .filter((name) => metricManifest.scripts?.[name] !== undefined);
  if (metricRuntimeDependencies.length > 0) throw new Error("metric package gained runtime dependencies");
  if (metricInstallScripts.length > 0) throw new Error("metric package gained install lifecycle scripts");
  const metricImports = [...jsImports(metricIndex), ...jsImports(metricLoader)];
  if (metricImports.join("\n") !== [
    "./wasm.js",
    "../pkg/web/string_metrics_wasm.js",
    "./wasm-inline.js",
  ].join("\n")) throw new Error("metric package active JavaScript imports changed");
  if (
    !metricLoader.includes("const ensureInitialized = () =>")
    || !metricLoader.includes("glue.initSync")
    || !metricLoader.includes("WASM_BASE64")
  ) {
    throw new Error("metric package must initialize its embedded WASM synchronously");
  }
  if (
    metricLoader.indexOf("const ensureInitialized = () =>") > metricLoader.indexOf("glue.initSync")
    || metricLoader.indexOf("glue.initSync") > metricLoader.indexOf("export const getWasm = () =>")
  ) throw new Error("metric package must keep WASM initialization lazy");
  if ([...metricLoader.matchAll(/\bglue\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]).join("\n") !== "initSync") {
    throw new Error("metric package loader must use only the synchronous glue entrypoint");
  }
  if (
    !metricGlue.includes("export { initSync }")
    || !metricGlue.includes("module_or_path = fetch(module_or_path)")
  ) throw new Error("metric package WASM glue exports changed");
  assertComputationOnly("metric package", [metricIndex, metricLoader]);
  const base64 = metricInline.match(/export const WASM_BASE64 = '([A-Za-z0-9+/=]+)'/)?.[1];
  if (!base64) throw new Error("metric package embedded WASM payload is missing");
  const wasmImports = WebAssembly.Module.imports(
    new WebAssembly.Module(Uint8Array.fromBase64(base64)),
  ).map(({ module, name, kind }) => ({ module, name, kind }));
  if (JSON.stringify(wasmImports) !== JSON.stringify([{
    module: "wbg",
    name: "__wbindgen_init_externref_table",
    kind: "function",
  }])) throw new Error("metric package WASM imports changed");
  const metricWasmFiles = metricFiles.filter((name) => name.endsWith(".wasm"));
  if (metricWasmFiles.length > 0) throw new Error("metric package contains a standalone WASM asset");
  if (!(await Bun.file(join(metricRoot, "LICENSE")).exists())) throw new Error("metric package license file is missing");

  const caseFoldingRoot = join(cliModules, "unicode-case-folding");
  const caseFoldingManifest = await Bun.file(join(caseFoldingRoot, "package.json")).json() as PackageManifest;
  if (
    caseFoldingManifest.name !== VOICE_PACKAGES.caseFolding.name
    || caseFoldingManifest.version !== VOICE_PACKAGES.caseFolding.version
    || caseFoldingManifest.license !== "MIT"
  ) throw new Error("case-folding package manifest changed");
  const caseFoldingIndex = await Bun.file(join(caseFoldingRoot, "index.js")).text();
  const caseFoldingFiles = await installedFiles(caseFoldingRoot);
  const caseFoldingEntrypoint = caseFoldingManifest.main;
  if (caseFoldingEntrypoint !== "index.js") throw new Error("case-folding package entrypoint changed");
  const caseFoldingImports = jsImports(caseFoldingIndex);
  if (caseFoldingImports.length > 0) throw new Error("case-folding package gained JavaScript imports");
  assertComputationOnly("case-folding package", [caseFoldingIndex]);
  const caseFoldingRuntimeDependencies = Object.keys(caseFoldingManifest.dependencies ?? {}).sort();
  const caseFoldingInstallScripts = ["preinstall", "install", "postinstall"]
    .filter((name) => caseFoldingManifest.scripts?.[name] !== undefined);
  if (caseFoldingRuntimeDependencies.length > 0) throw new Error("case-folding package gained runtime dependencies");
  if (caseFoldingInstallScripts.length > 0) throw new Error("case-folding package gained install lifecycle scripts");
  if (!(await Bun.file(join(caseFoldingRoot, "LICENSE")).exists())) {
    throw new Error("case-folding package license file is missing");
  }

  if (dependencies[CONFIG_SERIALIZER_PACKAGE.name] !== CONFIG_SERIALIZER_PACKAGE.version) {
    throw new Error(
      `${CONFIG_SERIALIZER_PACKAGE.name} must be exactly pinned to ${CONFIG_SERIALIZER_PACKAGE.version}`,
    );
  }
  const serializerLockEntry = `"${CONFIG_SERIALIZER_PACKAGE.name}": ["${CONFIG_SERIALIZER_PACKAGE.name}@${CONFIG_SERIALIZER_PACKAGE.version}", "", {}, "${CONFIG_SERIALIZER_PACKAGE.integrity}"]`;
  if (!lock.includes(serializerLockEntry)) {
    throw new Error(`${CONFIG_SERIALIZER_PACKAGE.name} lock integrity does not match the audited package`);
  }

  const serializerRoot = join(cliModules, CONFIG_SERIALIZER_PACKAGE.name);
  const serializerManifest = await Bun.file(join(serializerRoot, "package.json")).json() as PackageManifest;
  if (
    serializerManifest.name !== CONFIG_SERIALIZER_PACKAGE.name
    || serializerManifest.version !== CONFIG_SERIALIZER_PACKAGE.version
    || serializerManifest.license !== "BSD-3-Clause"
  ) throw new Error("serializer package manifest changed");
  const serializerEntrypoint = serializerManifest.exports?.import;
  if (serializerEntrypoint !== "./dist/index.js") {
    throw new Error("serializer package import entrypoint changed");
  }
  const serializerRuntimeDependencies = Object.keys(serializerManifest.dependencies ?? {}).sort();
  if (serializerRuntimeDependencies.length > 0) {
    throw new Error("serializer package gained runtime dependencies");
  }
  const serializerInstallScripts = ["preinstall", "install", "postinstall"]
    .filter((name) => serializerManifest.scripts?.[name] !== undefined);
  if (serializerInstallScripts.length > 0) {
    throw new Error("serializer package gained install lifecycle scripts");
  }
  const serializerFiles = await installedFiles(serializerRoot);
  const serializerJavaScriptFiles = serializerFiles
    .filter((name) => /^dist\/.+\.js$/.test(name));
  const serializerSources = await Promise.all(
    serializerJavaScriptFiles.map((name) => Bun.file(join(serializerRoot, name)).text()),
  );
  const serializerImports = serializerSources.flatMap(jsImports);
  const serializerStandaloneAssets = serializerImports
    .filter((specifier) => !/^\.\/.+\.js$/.test(specifier));
  if (serializerStandaloneAssets.length > 0) {
    throw new Error("serializer package imports an external runtime asset");
  }
  assertComputationOnly("serializer package", serializerSources);
  const serializerNativeAddons = serializerFiles.filter((name) => name.endsWith(".node"));
  if (serializerNativeAddons.length > 0) {
    throw new Error("serializer package contains a native addon");
  }
  const serializerWasmFiles = serializerFiles.filter((name) => name.endsWith(".wasm"));
  if (serializerWasmFiles.length > 0) {
    throw new Error("serializer package contains a standalone WASM asset");
  }
  const embeddedWasmMarkers = serializerSources.flatMap((source) => [
    ...source.matchAll(/\b(?:WebAssembly|WASM_BASE64)\b/g),
  ]).map((match) => match[0]);
  if (embeddedWasmMarkers.length > 0) {
    throw new Error("serializer package contains an embedded WASM payload");
  }
  if (!(await Bun.file(join(serializerRoot, "LICENSE")).exists())) {
    throw new Error("serializer package license file is missing");
  }

  return {
    metric: {
      ...VOICE_PACKAGES.metric,
      license: metricManifest.license,
      entrypoint: metricEntrypoint,
      declaredFiles: metricManifest.files ?? [],
      installedFiles: metricFiles,
      runtimeDependencies: metricRuntimeDependencies,
      lifecycleScripts: Object.keys(metricManifest.scripts ?? {})
        .filter((name) => /^(?:pre|post)/.test(name)).sort(),
      installLifecycleScripts: metricInstallScripts,
      publicationLifecycleScripts: ["prepare", "prepublishOnly"]
        .filter((name) => metricManifest.scripts?.[name] !== undefined),
      jsImports: metricImports,
      standaloneWasmFiles: metricWasmFiles,
      loader: "lazy-embedded-base64-initSync" as const,
      inactiveGlueNetworkPath: "default async export contains fetch; active wrapper calls initSync only",
      activeRuntimeAccess: [] as const,
      wasmImports,
    },
    caseFolding: {
      ...VOICE_PACKAGES.caseFolding,
      license: caseFoldingManifest.license,
      entrypoint: caseFoldingEntrypoint,
      declaredFiles: caseFoldingManifest.files ?? [],
      installedFiles: caseFoldingFiles,
      runtimeDependencies: caseFoldingRuntimeDependencies,
      lifecycleScripts: Object.keys(caseFoldingManifest.scripts ?? {})
        .filter((name) => /^(?:pre|post)/.test(name)).sort(),
      installLifecycleScripts: caseFoldingInstallScripts,
      publicationLifecycleScripts: ["prepare", "prepublishOnly"]
        .filter((name) => caseFoldingManifest.scripts?.[name] !== undefined),
      jsImports: caseFoldingImports,
      standaloneWasmFiles: caseFoldingFiles.filter((name) => name.endsWith(".wasm")),
      activeRuntimeAccess: [] as const,
    },
    serializer: {
      ...CONFIG_SERIALIZER_PACKAGE,
      license: serializerManifest.license,
      entrypoint: serializerEntrypoint,
      declaredFiles: serializerManifest.files ?? [],
      installedFiles: serializerFiles,
      runtimeDependencies: serializerRuntimeDependencies,
      lifecycleScripts: Object.keys(serializerManifest.scripts ?? {})
        .filter((name) => /^(?:pre|post)/.test(name)).sort(),
      installLifecycleScripts: serializerInstallScripts,
      jsImports: serializerImports,
      standaloneAssets: serializerStandaloneAssets,
      nativeAddons: serializerNativeAddons,
      standaloneWasmFiles: serializerWasmFiles,
      embeddedWasmMarkers,
      activeRuntimeAccess: [] as const,
    },
  };
}

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

export function assertNativeVaultGateTarget(
  target: NativeVaultTarget,
  expectedTargetId: string,
): (typeof RELEASE_TARGETS)[number] {
  const releaseTarget = RELEASE_TARGETS.find((candidate) => candidate.id === expectedTargetId);
  const policy = NATIVE_VAULT_COMPATIBILITY.find((candidate) => candidate.id === expectedTargetId);
  if (releaseTarget === undefined || policy === undefined || !policy.enabled) {
    throw new Error(`native credential lifecycle is disabled for target ${expectedTargetId}`);
  }
  if (target.bunVersion !== NATIVE_VAULT_BUN_VERSION || target.bunVersion !== policy.bunVersion) {
    throw new Error(`native credential lifecycle requires Bun ${NATIVE_VAULT_BUN_VERSION}`);
  }
  if (target.platform !== policy.platform || target.arch !== policy.arch) {
    throw new Error(
      `native credential lifecycle target ${expectedTargetId} requires ${policy.platform}/${policy.arch}; received ${target.platform}/${target.arch}`,
    );
  }
  return releaseTarget;
}

export async function validateNativeSecrets(expectedTargetId: string): Promise<void> {
  const releaseTarget = assertNativeVaultGateTarget({
    bunVersion: Bun.version,
    platform: process.platform,
    arch: process.arch,
  }, expectedTargetId);
  const temporary = await mkdtemp(join(process.cwd(), ".tmp-secret-smoke-"));
  const executable = join(
    temporary,
    process.platform === "win32" ? "secrets-smoke.exe" : "secrets-smoke",
  );
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "../tests/fixtures/secrets-compile-entry.ts")],
      compile: {
        target: releaseTarget.bunTarget,
        outfile: executable,
        autoloadDotenv: false,
        autoloadBunfig: false,
        autoloadTsconfig: false,
        autoloadPackageJson: false,
      },
    });
    if (!build.success) throw new AggregateError(build.logs, "failed to compile native credential lifecycle");
    if (process.platform !== "win32") await chmod(executable, 0o755);

    const result = run(executable, [], { cwd: temporary, env: process.env });
    const expected = [
      "missing",
      "set",
      "get",
      "replace",
      "get-replacement",
      "delete",
      "missing-after-delete",
      "cleanup",
    ].map((stage) => `native credential lifecycle: ${stage}`).join("\n") + "\n";
    if (result.exitCode !== 0 || result.stdout.toString() !== expected || result.stderr.length !== 0) {
      throw new Error(
        `native credential lifecycle gate failed: exit=${result.exitCode} stdout=${JSON.stringify(result.stdout.toString())} stderr=${JSON.stringify(result.stderr.toString())}`,
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
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

    const fakeCodex = join(temporary, process.platform === "win32" ? "codex.exe" : "codex");
    const fakeClaude = join(temporary, process.platform === "win32" ? "claude.exe" : "claude");
    for (const fakeCli of [fakeCodex, fakeClaude]) {
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
    }

    await Bun.write(join(temporary, ".env"), "OPENAI_API_KEY=must-not-autoload\n");
    await Bun.write(join(temporary, "bunfig.toml"), "this is intentionally invalid");
    await Bun.write(join(temporary, "tsconfig.json"), "this is intentionally invalid");
    await Bun.write(join(temporary, "package.json"), "this is intentionally invalid");

    const configHome = join(temporary, "config");
    const invocationDirectory = join(temporary, "caller");
    const workspacePrimary = join(temporary, "workspace", "primary");
    const workspaceAdditions = [
      join(temporary, "workspace", "additional"),
      join(temporary, "workspace", "additional with spaces"),
    ];
    await mkdir(join(configHome, "llm-now"), { recursive: true });
    await Promise.all([
      mkdir(invocationDirectory, { recursive: true }),
      mkdir(workspacePrimary, { recursive: true }),
      ...workspaceAdditions.map((path) => mkdir(path, { recursive: true })),
    ]);
    const smokeInstructions = 'Use "quoted" runtime smoke \\ transport.\nKeep each answer concise.';
    const sharedInstructions = "Apply shared runtime smoke guidance.";
    await Bun.write(
      join(configHome, "llm-now", "config.toml"),
      serializeConfigDocument({
        version: 1,
        sharedInstructions,
        aliases: {
          zeta: { provider: "openai", model: "gpt-5" },
          aliases: {
            provider: "codex-cli",
            model: "default",
            instructions: smokeInstructions,
            workspace: {
              primaryDirectory: workspacePrimary,
              additionalDirectories: workspaceAdditions,
              directoryAccess: "read-write",
            },
          },
          review: {
            provider: "claude-cli",
            model: "default",
            instructions: smokeInstructions,
            workspace: {
              primaryDirectory: workspacePrimary,
              additionalDirectories: workspaceAdditions,
              directoryAccess: "read-only",
            },
          },
        },
      }),
    );
    const aliasEnvironment = process.platform === "win32"
      ? { APPDATA: configHome }
      : { XDG_CONFIG_HOME: configHome };
    const overrideInstructions = "  Replace saved smoke instructions.\nUse the one-run override.  ";

    const inheritedEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH"),
    );
    const env = {
      ...inheritedEnvironment,
      PATH: temporary,
      ...(process.platform === "win32" ? {} : { SHELL: join(temporary, "missing-login-shell") }),
      ...aliasEnvironment,
      LLM_NOW_FAKE_WORKSPACE_PRIMARY: workspacePrimary,
      LLM_NOW_FAKE_WORKSPACE_ADDITIONS: JSON.stringify(workspaceAdditions),
    };
    const cases = [
      { name: "help", args: ["--help"], code: 0, stdoutIncludes: "Usage:\n  llm-now [<alias> | --alias <name>] [--input <text>]\n          [--instruction <text>] [--stream] [--speak]\n  llm-now --provider <id> --model <id|default> [--input <text>]", stderrIncludes: "" },
      { name: "version", args: ["--version"], code: 0, stdout: `${packageMetadata.version}\n`, stderrIncludes: "" },
      ...(process.platform === "darwin" ? [] : [{
        name: "non-macOS speech guard before scorer initialization",
        args: ["--speak", "--provider", "codex-cli", "--model", "default", "--input", "smoke"],
        code: 1,
        stdout: "",
        stderr: "voice: llm-now --speak currently supports macOS only.\n",
      }]),
      { name: "deterministic usage failure", args: ["--input", "smoke"], code: 2, stdout: "", stderrIncludes: "usage: non-interactive calls require" },
      {
        name: "alias inventory",
        args: ["--aliases"],
        code: 0,
        stdout: "aliases → Codex CLI · provider default · read-write workspace +2\nreview → Claude CLI · provider default · read-only workspace +2\nzeta → OpenAI · gpt-5\n",
        stderr: "",
      },
      { name: "explicit generation", args: ["--input", "smoke", "--provider", "codex-cli", "--model", "default"], code: 0, stdout: "fake:instruction-absent", stderrIncludes: "" },
      { name: "saved alias workspace", args: ["aliases", "--input", "smoke"], code: 0, stdout: "fake:instruction-shared-local:workspace-3", stderr: "" },
      { name: "cross-platform fuzzy voice routing", args: ["--voice-route", "--input", "aliase, smoke"], code: 0, stdout: "fake:instruction-shared-local:workspace-3", stderr: "Selecting alias 'aliases'\n" },
      {
        name: "shared alias instruction replacement",
        args: ["aliases", "--input", "smoke", "--instruction", overrideInstructions],
        code: 0,
        stdout: "fake:instruction-override-local:workspace-3",
        stderr: "",
      },
      {
        name: "saved Claude alias workspace",
        args: ["review", "--input", "smoke"],
        code: 0,
        stdout: "fake:claude-instruction-shared-local:workspace-3",
        stderr: "",
      },
    ] as const;

    for (const testCase of cases) {
      const result = run(executable, [...testCase.args], { cwd: invocationDirectory, env });
      const stdout = result.stdout.toString();
      const stderr = result.stderr.toString();
      const stdoutMatches = "stdout" in testCase
        ? stdout === testCase.stdout
        : stdout.includes(testCase.stdoutIncludes);
      const stderrMatches = "stderr" in testCase
        ? stderr === testCase.stderr
        : stderr.includes(testCase.stderrIncludes);
      if (result.exitCode !== testCase.code || !stdoutMatches || !stderrMatches) {
        throw new Error(`native smoke failed: case=${testCase.name} exit=${result.exitCode} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
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
        cwd: invocationDirectory,
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
  if (command === "packages" && args.length === 0) {
    console.log(JSON.stringify(await validateVoiceDependencies(), null, 2));
  }
  else if (command === "secrets" && args.length === 1) await validateNativeSecrets(args[0]!);
  else if (command === "archives" && args[0]) await validateArchives(args[0]);
  else if (command === "assemble" && args[0] && args[1]) {
    await assembleReleaseAssets(args[0], args[1], args.length > 2 ? args.slice(2) : undefined);
  }
  else if (command === "smoke" && args[0]) await smoke(args[0]);
  else throw new Error("usage: release-validate <packages | secrets TARGET | archives DIR | assemble INPUT OUTPUT [TARGET ...] | smoke ARCHIVE>");
}

if (import.meta.main) await main();

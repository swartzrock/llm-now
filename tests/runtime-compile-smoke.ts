import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import packageMetadata from "../package.json" with { type: "json" };
import { resolveAliasPath, saveAlias } from "../src/aliases";

if (
  packageMetadata.dependencies["@3leaps/string-metrics-wasm"] !== "0.3.11"
  || packageMetadata.dependencies["unicode-case-folding"] !== "1.1.1"
) {
  throw new Error("voice routing dependencies must remain exactly pinned");
}

const directory = await mkdtemp(join(process.cwd(), ".tmp-runtime-"));
const fakeCli = join(directory, process.platform === "win32" ? "codex.exe" : "codex");
const spike = join(
  directory,
  process.platform === "win32" ? "llm-now-spike.exe" : "llm-now-spike",
);
const runtimeSmoke = join(
  directory,
  process.platform === "win32" ? "runtime-smoke.exe" : "runtime-smoke",
);
const voiceRoutingSmoke = join(
  directory,
  process.platform === "win32" ? "voice-routing-smoke.exe" : "voice-routing-smoke",
);
const shortcutInput = join(directory, "shortcut-input.txt");
const smokeInstructions = 'Use "quoted" runtime smoke \\ transport.\nKeep each answer concise.';
const overrideInstructions = "  Replace saved smoke instructions.\nUse the one-run override.  ";

try {
  const configHome = join(directory, "config");
  const aliasEnvironment = process.platform === "win32"
    ? { APPDATA: configHome }
    : { XDG_CONFIG_HOME: configHome };
  const aliasPath = resolveAliasPath({
    platform: process.platform,
    home: directory,
    env: aliasEnvironment,
  });
  await saveAlias(aliasPath, "Daily", {
    provider: "codex-cli",
    model: null,
    instructions: smokeInstructions,
  });
  await Bun.write(shortcutInput, "daily, smoke\n");

  const builds: Array<[string, string]> = [
    [join(import.meta.dir, "fixtures/fake-cli.ts"), fakeCli],
    [join(import.meta.dir, "fixtures/runtime-smoke-entry.ts"), runtimeSmoke],
    [join(import.meta.dir, "fixtures/voice-routing-compile-entry.ts"), voiceRoutingSmoke],
    [join(import.meta.dir, "../index.ts"), spike],
  ];
  for (const [entrypoint, outfile] of builds) {
    const build = await Bun.build({
      entrypoints: [entrypoint],
      compile: {
        outfile,
        autoloadDotenv: false,
        autoloadBunfig: false,
        autoloadTsconfig: false,
        autoloadPackageJson: false,
      },
    });
    if (!build.success) throw new AggregateError(build.logs, `failed to compile ${entrypoint}`);
    if (process.platform !== "win32") await chmod(outfile, 0o755);
  }

  // Keep bare CLI lookup inside the fixture directory. byok-runtime loads a
  // login-shell PATH first, which could otherwise select a real Codex install.
  const env = {
    PATH: directory,
    ...(process.platform === "win32"
      ? {}
      : { SHELL: join(directory, "missing-login-shell") }),
    ...aliasEnvironment,
  };
  const cases = [
    {
      name: "voice routing scorer boundary",
      executable: voiceRoutingSmoke,
      args: [],
      exitCode: 0,
      stdout: "100\n66.66666666666667\n",
      stderr: "",
    },
    {
      name: "runtime boundary",
      executable: runtimeSmoke,
      args: [fakeCli, directory],
      exitCode: 0,
      stdout: "http-ok\nfake:instruction-absent\nconfig-defaults-ok\nmigration-routing-ok\n",
      stderr: "",
    },
    {
      name: "help",
      executable: spike,
      args: ["--help"],
      exitCode: 0,
      stdoutIncludes: "Usage:\n  llm-now [<alias> | --alias <name>] [--input <text>]\n          [--instruction <text>] [--speak]",
      stdoutLandmarks: [
        "Usage:\n  llm-now [<alias> | --alias <name>] [--input <text>]\n          [--instruction <text>] [--speak]\n  llm-now --provider <id> --model <id|default> [--input <text>]",
        "Notes:\n  Run without arguments to open the interactive launcher.\n  Read input from --input, stdin, or a terminal prompt; choose one.",
        "Options:\n  --aliases            List saved shortcuts\n  --config-path        Print the config.toml path\n  --migrate-config     Migrate legacy configuration to config.toml\n  --voice-route        Parse “[wake word] <shortcut> <question>” from input",
        "API key environment variables:\n  ANTHROPIC_API_KEY     DEEPINFRA_TOKEN",
        "  OPENROUTER_API_KEY    XAI_API_KEY",
        "API keys can also be stored securely through the interactive launcher.",
      ],
      stdoutExcludes: "\u001b",
      stdoutHasOneFinalNewline: true,
      stderr: "",
    },
    {
      name: "version",
      executable: spike,
      args: ["--version"],
      exitCode: 0,
      stdout: `${packageMetadata.version}\n`,
      stderr: "",
    },
    {
      name: "deterministic usage failure",
      executable: spike,
      args: ["--input", "smoke"],
      exitCode: 2,
      stdout: "",
      stderrIncludes: "usage: non-interactive calls require",
    },
    {
      name: "fake CLI generation",
      executable: spike,
      args: ["--input", "smoke", "--provider", "codex-cli", "--model", "default"],
      exitCode: 0,
      stdout: "fake:instruction-absent",
      stderr: "",
    },
    {
      name: "fake CLI generation with explicit request instruction",
      executable: spike,
      args: [
        "--input",
        "smoke",
        "--provider",
        "codex-cli",
        "--model",
        "default",
        "--instruction",
        overrideInstructions,
      ],
      exitCode: 0,
      stdout: "fake:instruction-override",
      stderr: "",
    },
    {
      name: "fake CLI generation through positional alias",
      executable: spike,
      args: ["dAiLy", "--input", "smoke"],
      exitCode: 0,
      stdout: "fake:instruction-present",
      stderr: "",
    },
    {
      name: "cross-platform fuzzy voice routing",
      executable: spike,
      args: ["--voice-route", "--input", "dail, smoke"],
      exitCode: 0,
      stdout: "fake:instruction-present",
      stderr: "",
    },
    {
      name: "file-backed stdin voice routing",
      executable: spike,
      args: ["--voice-route"],
      stdin: Bun.file(shortcutInput),
      exitCode: 0,
      stdout: "fake:instruction-present",
      stderr: "",
    },
    ...(process.platform === "darwin" ? [] : [{
      name: "non-macOS speech guard before scorer initialization",
      executable: spike,
      args: ["--speak", "--provider", "codex-cli", "--model", "default", "--input", "smoke"],
      exitCode: 1,
      stdout: "",
      stderr: "voice: llm-now --speak currently supports macOS only.\n",
    }]),
    {
      name: "fake CLI generation with alias instruction replacement",
      executable: spike,
      args: ["dAiLy", "--input", "smoke", "--instruction", overrideInstructions],
      exitCode: 0,
      stdout: "fake:instruction-override",
      stderr: "",
    },
  ] as const;

  for (const smoke of cases) {
    const result = Bun.spawnSync([smoke.executable, ...smoke.args], {
      cwd: directory,
      env,
      stdin: "stdin" in smoke ? smoke.stdin : new Uint8Array(),
    });
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    const stdoutMatches = "stdout" in smoke
      ? stdout === smoke.stdout
      : stdout.includes(smoke.stdoutIncludes);
    let landmarkIndex = -1;
    const landmarksMatch = !("stdoutLandmarks" in smoke)
      || smoke.stdoutLandmarks.every((landmark) => {
        landmarkIndex = stdout.indexOf(landmark, landmarkIndex + 1);
        return landmarkIndex !== -1;
      });
    const stdoutExclusionMatches = !("stdoutExcludes" in smoke)
      || !stdout.includes(smoke.stdoutExcludes);
    const stdoutNewlineMatches = !("stdoutHasOneFinalNewline" in smoke)
      || (stdout.endsWith("\n") && !stdout.endsWith("\n\n"));
    const stderrMatches = "stderr" in smoke
      ? stderr === smoke.stderr
      : stderr.includes(smoke.stderrIncludes);
    if (
      result.exitCode !== smoke.exitCode
      || !stdoutMatches
      || !landmarksMatch
      || !stdoutExclusionMatches
      || !stdoutNewlineMatches
      || !stderrMatches
    ) {
      throw new Error(
        `${smoke.name} smoke failed: exit=${result.exitCode} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
      );
    }
  }

  console.log("compiled runtime and CLI smoke passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}

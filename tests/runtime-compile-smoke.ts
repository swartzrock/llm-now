import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import packageMetadata from "../package.json" with { type: "json" };
import { resolveAliasPath, saveAlias } from "../src/aliases";

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
  await saveAlias(aliasPath, "Daily", { provider: "codex-cli", model: null });

  const builds: Array<[string, string]> = [
    [join(import.meta.dir, "fixtures/fake-cli.ts"), fakeCli],
    [join(import.meta.dir, "fixtures/runtime-smoke-entry.ts"), runtimeSmoke],
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
      name: "runtime boundary",
      executable: runtimeSmoke,
      args: [fakeCli],
      exitCode: 0,
      stdout: "http-ok\nfake:smoke\n",
      stderr: "",
    },
    {
      name: "help",
      executable: spike,
      args: ["--help"],
      exitCode: 0,
      stdoutIncludes: "Usage:\n  llm-now\n  llm-now --aliases\n  llm-now --input <text>\n  llm-now <alias>",
      stdoutLandmarks: [
        "Usage:\n  llm-now\n  llm-now --aliases\n  llm-now --input <text>\n  llm-now <alias>",
        "Rules:\n  Run llm-now with no arguments in a terminal to open the adaptive launcher.",
        "With shortcuts: “Run with a saved shortcut…”, “Create a new shortcut…”,\n  “Run once with another provider and model…”, then “Manage connections…”.\n  Without shortcuts: “Create a new shortcut…”, “Run once with a provider and model…”,\n  then “Manage connections…”.",
        "Creation uses “Use an available provider…” or “Add a provider with an API key…”.\n  Creation saves the provider/model target before its first prompt, then runs it once.\n  Run once generates without saving or offering a shortcut.",
        "Manage connections owns discovery and API-key addition, replacement, and deletion.\n  Opening a launcher menu performs no provider discovery or credential access.",
        "Arguments, --input, piped input, and noninteractive calls bypass the launcher.\n  Deterministic calls use an alias or both --provider and --model.",
        "Options:\n  --aliases            List saved aliases\n  --input <text>       Prompt text",
        "API key environment variables:\n  ANTHROPIC_API_KEY",
        "  DEEPINFRA_TOKEN",
        "  XAI_API_KEY",
        "Secure API-key storage:\n  llm-now can save provider API keys securely for reuse.",
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
      stdout: "fake:smoke",
      stderr: "",
    },
    {
      name: "fake CLI generation through positional alias",
      executable: spike,
      args: ["dAiLy", "--input", "smoke"],
      exitCode: 0,
      stdout: "fake:smoke",
      stderr: "",
    },
  ] as const;

  for (const smoke of cases) {
    const result = Bun.spawnSync([smoke.executable, ...smoke.args], {
      env,
      stdin: new Uint8Array(),
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

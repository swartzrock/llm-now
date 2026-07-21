import { chmod, mkdtemp, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
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

  const env = {
    PATH: [directory, process.env.PATH].filter(Boolean).join(delimiter),
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
      stdoutIncludes: "Usage:\n  llm-now\n  llm-now --input <text>",
      stdoutLandmarks: [
        "Send a prompt to a selected model.",
        "Usage:\n  llm-now\n  llm-now --input <text>",
        "Rules:\n  Run llm-now with no arguments in a terminal to set up providers and API keys.\n  Input comes from exactly one of --input or stdin.",
        "Options:\n  --input <text>       Prompt text",
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
      args: ["Daily", "--input", "smoke"],
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

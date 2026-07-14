import { chmod, mkdtemp, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
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
      stdoutIncludes: "Usage:\n  llm-now --input <text>",
      stderr: "",
    },
    {
      name: "version",
      executable: spike,
      args: ["--version"],
      exitCode: 0,
      stdout: "0.1.0\n",
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
    const stderrMatches = "stderr" in smoke
      ? stderr === smoke.stderr
      : stderr.includes(smoke.stderrIncludes);
    if (
      result.exitCode !== smoke.exitCode
      || !stdoutMatches
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

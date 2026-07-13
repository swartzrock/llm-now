import { chmod, mkdtemp, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";

const directory = await mkdtemp(join(process.cwd(), ".tmp-runtime-"));
const fakeCli = join(directory, process.platform === "win32" ? "codex.exe" : "codex");
const spike = join(
  directory,
  process.platform === "win32" ? "llm-now-spike.exe" : "llm-now-spike",
);

try {
  const builds: Array<[string, string]> = [
    [join(import.meta.dir, "fixtures/fake-cli.ts"), fakeCli],
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

  const env = { PATH: [directory, process.env.PATH].filter(Boolean).join(delimiter) };
  const cases = [
    {
      name: "runtime boundary",
      args: ["--runtime-smoke", fakeCli],
      exitCode: 0,
      stdout: "http-ok\nfake:smoke\n",
      stderrIncludes: "",
    },
    {
      name: "help",
      args: ["--help"],
      exitCode: 0,
      stdoutIncludes: "Usage:\n  llm-now --input <text>",
      stderrIncludes: "",
    },
    {
      name: "version",
      args: ["--version"],
      exitCode: 0,
      stdout: "0.1.0\n",
      stderrIncludes: "",
    },
    {
      name: "deterministic usage failure",
      args: ["--input", "smoke"],
      exitCode: 2,
      stdout: "",
      stderrIncludes: "usage: non-interactive calls require",
    },
    {
      name: "fake CLI generation",
      args: ["--input", "smoke", "--provider", "codex-cli", "--model", "default"],
      exitCode: 0,
      stdout: "fake:smoke",
      stderrIncludes: "",
    },
  ] as const;

  for (const smoke of cases) {
    const result = Bun.spawnSync([spike, ...smoke.args], {
      env,
      stdin: new Uint8Array(),
    });
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    const stdoutMatches = "stdout" in smoke
      ? stdout === smoke.stdout
      : stdout.includes(smoke.stdoutIncludes);
    if (
      result.exitCode !== smoke.exitCode
      || !stdoutMatches
      || !stderr.includes(smoke.stderrIncludes)
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

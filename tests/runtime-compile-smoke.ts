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

  const result = Bun.spawnSync([spike, "--runtime-smoke", fakeCli], {
    env: { PATH: [directory, process.env.PATH].filter(Boolean).join(delimiter) },
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0 || stdout !== "http-ok\nfake:smoke\n" || stderr !== "") {
    throw new Error(
      `compiled smoke failed: exit=${result.exitCode} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
    );
  }

  console.log("compiled runtime smoke passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}

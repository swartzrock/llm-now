import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");
const coreRoot = join(repositoryRoot, "packages/core");
const output = join(coreRoot, "dist");
const staging = await mkdtemp(join(repositoryRoot, ".tmp-core-build-"));

try {
  await rm(output, { recursive: true, force: true });
  await cp(join(coreRoot, "src"), join(staging, "src"), { recursive: true });

  // Bun 1.3.14 applies the publish-time `sideEffects: false` declaration while
  // bundling package-local source and can erase re-exported definitions. Build
  // the same source from a package-neutral staging directory so the published
  // metadata describes consumers without changing the compiler input graph.
  const build = await Bun.build({
    entrypoints: [join(staging, "src/index.ts")],
    root: join(staging, "src"),
    outdir: output,
    target: "node",
    format: "esm",
    packages: "external",
    sourcemap: "none",
    minify: false,
    naming: "[dir]/[name].js",
  });
  if (!build.success) {
    throw new AggregateError(build.logs, "failed to build @swartzrock/llm-now-core");
  }
  const bundlePath = join(output, "index.js");
  const bundle = await Bun.file(bundlePath).text();
  const stagingSourceLabel = `${staging.slice(repositoryRoot.length + 1)}/src/`;
  await Bun.write(bundlePath, bundle.replaceAll(stagingSourceLabel, "packages/core/src/"));

  const declarations = Bun.spawnSync([
    process.execPath,
    join(repositoryRoot, "node_modules/typescript/bin/tsc"),
    "--project",
    join(coreRoot, "tsconfig.build.json"),
  ], {
    cwd: repositoryRoot,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (declarations.exitCode !== 0) {
    throw new Error("failed to emit @swartzrock/llm-now-core declarations");
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}

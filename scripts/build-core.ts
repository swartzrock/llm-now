import { rm } from "node:fs/promises";
import { join } from "node:path";

const coreRoot = join(import.meta.dir, "../packages/core");
const output = join(coreRoot, "dist");

await rm(output, { recursive: true, force: true });

const build = await Bun.build({
  entrypoints: [join(coreRoot, "src/index.ts")],
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

const declarations = Bun.spawnSync([
  process.execPath,
  join(import.meta.dir, "../node_modules/typescript/bin/tsc"),
  "--project",
  join(coreRoot, "tsconfig.build.json"),
], {
  cwd: join(import.meta.dir, ".."),
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
if (declarations.exitCode !== 0) {
  throw new Error("failed to emit @swartzrock/llm-now-core declarations");
}

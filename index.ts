import { homedir } from "node:os";
import packageMetadata from "./package.json" with { type: "json" };
import { createApplicationPrompter, runApplication } from "./src/app.ts";
import { createRuntimeGateway } from "./src/runtime.ts";

process.exitCode = await runApplication({
  args: Bun.argv.slice(2),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  runtime: createRuntimeGateway({ env: process.env }),
  prompter: createApplicationPrompter(process.stdin, process.stderr),
  env: process.env,
  platform: process.platform,
  home: homedir(),
  version: packageMetadata.version,
});

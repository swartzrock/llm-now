import { isByokProviderId } from "@swartzrock/byok-runtime";
import { createByokNodeProvider } from "@swartzrock/byok-runtime/node";
import { homedir } from "node:os";
import packageMetadata from "./package.json" with { type: "json" };
import { createApplicationPrompter, runApplication } from "./src/app.ts";
import { createRuntimeGateway } from "./src/runtime.ts";

async function runRuntimeSmoke(fakeCli: string): Promise<void> {
  if (!isByokProviderId("ollama")) {
    throw new Error("root runtime export unavailable");
  }

  const httpProvider = createByokNodeProvider(
    { provider: "ollama", url: "http://runtime-smoke.invalid", model: "fake-model" },
    {
      http: async () => ({
        status: 200,
        text: JSON.stringify({ response: "http-ok" }),
        json: { response: "http-ok" },
      }),
    },
  );
  const cliProvider = createByokNodeProvider({
    provider: "codex-cli",
    command: fakeCli,
  });

  const http = await httpProvider.generateText({ prompt: "smoke" });
  const cli = await cliProvider.generateText({ prompt: "smoke" });
  process.stdout.write(`${http.text}\n${cli.text}\n`);
}

if (Bun.argv[2] === "--runtime-smoke") {
  const fakeCli = Bun.argv[3];
  if (!fakeCli) throw new Error("missing fake CLI path");
  await runRuntimeSmoke(fakeCli);
} else {
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
}

import { isByokProviderId } from "@swartzrock/byok-runtime";
import { createByokNodeProvider } from "@swartzrock/byok-runtime/node";

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
}

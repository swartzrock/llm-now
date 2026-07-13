import { isByokProviderId } from "@swartzrock/byok-runtime";
import { createByokNodeProvider } from "@swartzrock/byok-runtime/node";

const fakeCli = Bun.argv[2];
if (!fakeCli) throw new Error("missing fake CLI path");
if (!isByokProviderId("ollama")) throw new Error("root runtime export unavailable");

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
const cliProvider = createByokNodeProvider({ provider: "codex-cli", command: fakeCli });

const http = await httpProvider.generateText({ prompt: "smoke" });
const cli = await cliProvider.generateText({ prompt: "smoke" });
process.stdout.write(`${http.text}\n${cli.text}\n`);

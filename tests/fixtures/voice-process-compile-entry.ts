import { createBunVoiceProcessRunner } from "../../packages/cli/src/voice.ts";

const runner = createBunVoiceProcessRunner();
const outcome = await runner.run({
  executable: "/usr/bin/say",
  args: ["-v", "?"],
  stdin: new Uint8Array(),
  env: { PATH: "/usr/bin:/bin" },
  signal: new AbortController().signal,
  timeoutMs: 5_000,
});

if (outcome.kind !== "completed" || outcome.stdout.byteLength === 0) {
  throw new Error(`compiled voice process failed: ${outcome.kind}`);
}

process.stdout.write("voice-process-ok\n");

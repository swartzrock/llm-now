import { writeFileSync } from "node:fs";

const [markerBase] = process.argv.slice(2);
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;

if (process.env.LLM_NOW_CORE_FIXTURE !== "approved") process.exit(40);
if (process.env.SHOULD_NOT_LEAK !== undefined) process.exit(41);

if (prompt === "cancel") {
  writeFileSync(`${markerBase}.started`, "started\n");
  const stop = () => {
    writeFileSync(`${markerBase}.stopped`, "stopped\n");
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  setInterval(() => undefined, 1_000);
} else {
  process.stdout.write(`${JSON.stringify({ result: `fixture:${prompt}` })}\n`);
}

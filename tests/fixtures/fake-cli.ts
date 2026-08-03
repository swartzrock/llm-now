#!/usr/bin/env bun

const args = Bun.argv.slice(2);
const expectedInstructions = 'Use "quoted" runtime smoke \\ transport.';
const expectedInstructionConfig = `developer_instructions=${JSON.stringify(expectedInstructions)}`;

if (args[0] === "debug" && args[1] === "models") {
  console.log(JSON.stringify({ models: ["fake-model"] }));
  process.exit(0);
}

if (args[0] === "login" && args[1] === "status") {
  console.log("Logged in");
  process.exit(0);
}

if (args[0] === "exec") {
  const configIndexes = args.flatMap((arg, index) => arg === "-c" ? [index] : []);
  const instructionIndexes = args.flatMap((arg, index) =>
    arg.startsWith("developer_instructions=") ? [index] : []
  );
  const hasInstructions = configIndexes.length === 1
    && instructionIndexes.length === 1
    && instructionIndexes[0] === configIndexes[0]! + 1
    && args[instructionIndexes[0]!] === expectedInstructionConfig;
  const hasNoInstructions = configIndexes.length === 0 && instructionIndexes.length === 0;
  if (!hasInstructions && !hasNoInstructions) {
    console.error("unexpected fake CLI instruction configuration");
    process.exit(2);
  }
  const prompt = await Bun.stdin.text();
  if (prompt !== "smoke") {
    console.error("unexpected fake CLI prompt");
    process.exit(2);
  }
  console.log(JSON.stringify({
    text: hasInstructions ? "fake:instruction-present" : "fake:instruction-absent",
  }));
  process.exit(0);
}

console.error("unexpected fake CLI invocation");
process.exit(2);

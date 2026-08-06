#!/usr/bin/env bun

const args = Bun.argv.slice(2);
const expectedInstructions = 'Use "quoted" runtime smoke \\ transport.\nKeep each answer concise.';
const expectedInstructionConfig = `developer_instructions=${JSON.stringify(expectedInstructions)}`;
const expectedOverrideInstructions = "  Replace saved smoke instructions.\nUse the one-run override.  ";
const expectedOverrideConfig = `developer_instructions=${JSON.stringify(expectedOverrideInstructions)}`;

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
  const hasInstructionConfig = configIndexes.length === 1
    && instructionIndexes.length === 1
    && instructionIndexes[0] === configIndexes[0]! + 1;
  const instructionConfig = hasInstructionConfig ? args[instructionIndexes[0]!] : undefined;
  const instructionMarker = instructionConfig === expectedInstructionConfig
    ? "fake:instruction-present"
    : instructionConfig === expectedOverrideConfig
      ? "fake:instruction-override"
      : undefined;
  const hasNoInstructions = configIndexes.length === 0 && instructionIndexes.length === 0;
  if (instructionMarker === undefined && !hasNoInstructions) {
    console.error("unexpected fake CLI instruction configuration");
    process.exit(2);
  }
  const prompt = await Bun.stdin.text();
  if (prompt !== "smoke") {
    console.error("unexpected fake CLI prompt");
    process.exit(2);
  }
  console.log(JSON.stringify({
    text: instructionMarker ?? "fake:instruction-absent",
  }));
  process.exit(0);
}

console.error("unexpected fake CLI invocation");
process.exit(2);

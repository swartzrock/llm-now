#!/usr/bin/env bun

const args = Bun.argv.slice(2);
const expectedInstructions = 'Use "quoted" runtime smoke \\ transport.\nKeep each answer concise.';
const expectedInstructionConfig = `developer_instructions=${JSON.stringify(expectedInstructions)}`;
const expectedSharedInstructions = "Apply shared runtime smoke guidance.";
const expectedOverrideInstructions = "  Replace saved smoke instructions.\nUse the one-run override.  ";
const expectedOverrideConfig = `developer_instructions=${JSON.stringify(expectedOverrideInstructions)}`;
const expectedSharedLocalConfig = `developer_instructions=${JSON.stringify(
  `${expectedSharedInstructions}\n\n${expectedInstructions}`,
)}`;
const expectedOverrideLocalConfig = `developer_instructions=${JSON.stringify(
  `${expectedOverrideInstructions}\n\n${expectedInstructions}`,
)}`;
const expectedWorkspacePrimary = process.env.LLM_NOW_FAKE_WORKSPACE_PRIMARY;
const expectedWorkspaceAdditions = process.env.LLM_NOW_FAKE_WORKSPACE_ADDITIONS === undefined
  ? []
  : JSON.parse(process.env.LLM_NOW_FAKE_WORKSPACE_ADDITIONS) as string[];

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
    : instructionConfig === expectedSharedLocalConfig
      ? "fake:instruction-shared-local"
      : instructionConfig === expectedOverrideLocalConfig
        ? "fake:instruction-override-local"
        : instructionConfig === expectedOverrideConfig
          ? "fake:instruction-override"
          : undefined;
  const hasNoInstructions = configIndexes.length === 0 && instructionIndexes.length === 0;
  if (instructionMarker === undefined && !hasNoInstructions) {
    console.error("unexpected fake CLI instruction configuration");
    process.exit(2);
  }
  const addDirectoryIndexes = args.flatMap((arg, index) => arg === "--add-dir" ? [index] : []);
  const additions = addDirectoryIndexes.map((index) => args[index + 1]);
  const isWorkspaceInvocation = expectedWorkspacePrimary !== undefined
    && process.cwd() === expectedWorkspacePrimary;
  const sandboxIndex = args.indexOf("--sandbox");
  const expectedSandbox = isWorkspaceInvocation ? "workspace-write" : "read-only";
  if (
    (isWorkspaceInvocation
      && JSON.stringify(additions) !== JSON.stringify(expectedWorkspaceAdditions))
    || (!isWorkspaceInvocation && additions.length !== 0)
    || sandboxIndex === -1
    || args[sandboxIndex + 1] !== expectedSandbox
  ) {
    console.error("unexpected fake CLI workspace configuration");
    process.exit(2);
  }
  const prompt = await Bun.stdin.text();
  if (prompt !== "smoke") {
    console.error("unexpected fake CLI prompt");
    process.exit(2);
  }
  console.log(JSON.stringify({
    text: `${instructionMarker ?? "fake:instruction-absent"}${
      isWorkspaceInvocation ? `:workspace-${additions.length + 1}` : ""
    }`,
  }));
  process.exit(0);
}

if (args[0] === "-p") {
  const instructionIndex = args.indexOf("--append-system-prompt");
  const instruction = instructionIndex === -1 ? undefined : args[instructionIndex + 1];
  const instructionMarker = instruction === expectedInstructions
    ? "fake:claude-instruction-present"
    : instruction === `${expectedSharedInstructions}\n\n${expectedInstructions}`
      ? "fake:claude-instruction-shared-local"
      : instruction === `${expectedOverrideInstructions}\n\n${expectedInstructions}`
        ? "fake:claude-instruction-override-local"
        : instruction === expectedOverrideInstructions
          ? "fake:claude-instruction-override"
          : undefined;
  const toolsIndex = args.indexOf("--tools");
  if (instructionMarker === undefined || args[toolsIndex + 1] !== "Read,Glob,Grep") {
    console.error("unexpected fake Claude instruction or tool configuration");
    process.exit(2);
  }
  const addDirectoryIndexes = args.flatMap((arg, index) => arg === "--add-dir" ? [index] : []);
  const additions = addDirectoryIndexes.map((index) => args[index + 1]);
  const isWorkspaceInvocation = expectedWorkspacePrimary !== undefined
    && process.cwd() === expectedWorkspacePrimary;
  if (
    !isWorkspaceInvocation
    || JSON.stringify(additions) !== JSON.stringify(expectedWorkspaceAdditions)
  ) {
    console.error("unexpected fake Claude workspace configuration");
    process.exit(2);
  }
  const prompt = await Bun.stdin.text();
  if (prompt !== "smoke") {
    console.error("unexpected fake CLI prompt");
    process.exit(2);
  }
  console.log(JSON.stringify({
    result: `${instructionMarker}:workspace-${additions.length + 1}`,
  }));
  process.exit(0);
}

console.error("unexpected fake CLI invocation");
process.exit(2);

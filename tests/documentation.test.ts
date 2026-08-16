import { describe, expect, test } from "bun:test";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

const [rootReadme, packageReadme, api, security, releasing, manualTesting] = await Promise.all([
  read("../README.md"),
  read("../packages/core/README.md"),
  read("../docs/core-api.md"),
  read("../docs/core-security.md"),
  read("../docs/RELEASING.md"),
  read("../docs/manual-testing.md"),
]);

describe("headless core documentation", () => {
  test("links the public package, API, and security contracts", async () => {
    expect(rootReadme).toContain("@swartzrock/llm-now-core");
    expect(rootReadme).toContain("docs/core-api.md");
    expect(rootReadme).toContain("docs/core-security.md");
    expect(packageReadme).toContain("https://github.com/swartzrock/llm-now/blob/main/docs/core-api.md");
    expect(packageReadme).toContain("https://github.com/swartzrock/llm-now/blob/main/docs/core-security.md");
    expect(packageReadme).toContain("Node 20 or later");
    expect(packageReadme).toContain("Bun 1.3.14 or later");
    expect(await Bun.file(new URL("../packages/cli/src/args.ts", import.meta.url)).exists())
      .toBeTrue();
  });

  test("documents the complete value API and exact public error contract", () => {
    for (const symbol of [
      "createLlmNowCore", "LlmNowError", "compactRoutingKey", "routeTranscript",
      "routingSimilarity", "workspaceCapabilities",
    ]) expect(api).toContain(`\`${symbol}\``);
    for (const type of [
      "LlmNowCoreClient", "LlmNowCoreDependencies", "LlmNowErrorCode", "LlmNowOperation",
      "CredentialResolution", "CredentialResolver", "CliExecutionDescriptor",
      "CliExecutionResolver", "DirectCliExecutionDescriptor",
      "WindowsCommandShimExecutionDescriptor", "RouteMatch", "RouteMatchReason",
      "RouteRejection", "RouteRejectionReason", "RouteTranscriptInput",
      "RouteTranscriptResult", "RoutingCandidate", "CliProviderId", "CloudProviderId",
      "DiagnosticHandler", "EnvironmentSnapshot", "ModelOption", "ProviderId",
      "DirectoryAccess", "GenerateTextRequest", "GenerateTextResult", "StreamTextResult",
      "TextDeltaHandler", "TextStreamDelivery", "ModelListRequest", "ModelListResult",
      "ProviderAvailability", "ProviderDiscoveryRequest", "ProviderDiscoveryResult",
      "ProviderFamily", "ProviderUnavailabilityReason", "ValidateConnectionRequest",
      "ValidationResult", "WorkspaceCapabilities", "WorkspaceRequest",
    ]) expect(api).toContain(`\`${type}\``);

    const mappings = {
      discovery: ["INVALID_REQUEST", "CREDENTIAL_RESOLUTION_FAILED", "DISCOVERY_FAILED", "ABORTED", "INTERNAL_ERROR"],
      "model-list": ["INVALID_REQUEST", "PROVIDER_UNAVAILABLE", "CREDENTIAL_UNAVAILABLE", "CREDENTIAL_RESOLUTION_FAILED", "EXECUTION_UNAVAILABLE", "MODEL_LIST_FAILED", "ABORTED", "INTERNAL_ERROR"],
      validation: ["INVALID_REQUEST", "PROVIDER_UNAVAILABLE", "CREDENTIAL_UNAVAILABLE", "CREDENTIAL_RESOLUTION_FAILED", "EXECUTION_UNAVAILABLE", "VALIDATION_FAILED", "ABORTED", "INTERNAL_ERROR"],
      generation: ["INVALID_REQUEST", "PROVIDER_UNAVAILABLE", "CREDENTIAL_UNAVAILABLE", "CREDENTIAL_RESOLUTION_FAILED", "EXECUTION_UNAVAILABLE", "WORKSPACE_UNAVAILABLE", "GENERATION_FAILED", "ABORTED", "UNSAFE_RESPONSE", "INTERNAL_ERROR"],
      streaming: ["INVALID_REQUEST", "PROVIDER_UNAVAILABLE", "CREDENTIAL_UNAVAILABLE", "CREDENTIAL_RESOLUTION_FAILED", "EXECUTION_UNAVAILABLE", "WORKSPACE_UNAVAILABLE", "GENERATION_FAILED", "ABORTED", "UNSAFE_RESPONSE", "DELTA_HANDLER_FAILED", "INTERNAL_ERROR"],
    };
    for (const [operation, codes] of Object.entries(mappings)) {
      const row = api.split("\n").find((line) => line.startsWith(`| \`${operation}\``));
      expect(row).toBeDefined();
      expect([...row!.matchAll(/`([A-Z_]+)`/g)].map((match) => match[1])).toEqual(codes);
    }

    for (const message of [
      "The request is invalid.", "The provider is unavailable.",
      "A required credential is unavailable.", "Credential resolution failed.",
      "CLI execution is unavailable.", "The requested workspace is unavailable.",
      "Provider discovery failed.", "Model listing failed.",
      "Connection validation failed.", "Text generation failed.",
      "The operation was aborted.", "The provider response was withheld.",
      "The text delta handler failed.", "The core operation failed safely.",
    ]) expect(api).toContain(message);
  });

  test("documents caller-owned credentials, execution, streaming, and routing", () => {
    expect(api).toContain("candidate-or-resolver");
    expect(api).toContain("No fallback");
    expect(api).toContain("does not cache credentials");
    expect(api).toContain("backpressure");
    expect(api).toContain("cancellation wins");
    expect(api).toContain("ABORTED");
    expect(api).toContain("Talk Show characters remain separate");
    expect(api).toContain("Talk Show does not read or synchronize llm-now's");
    expect(security).toContain("trusted host process");
    expect(security).toContain("Bun.secrets");
    expect(security).toMatch(/strictly\s+CLI-owned/);
    expect(security).toContain("response-sensitive");
    expect(security).toContain("diagnostic-sensitive");
    expect(security).toContain("already-delivered deltas cannot be retracted");
    expect(security).toContain("shell: false");
    expect(security).toContain("C:\\\\Windows\\\\System32\\\\cmd.exe");
    expect(security).toContain("C:\\\\approved\\\\codex.cmd");
    expect(security).not.toMatch(/webview.{0,80}(?:api key|credential|secret) input/is);
  });

  test("documents the independent release lanes and bootstrap stop conditions", () => {
    expect(releasing).toContain("Core package release lane");
    expect(releasing).toContain("Native CLI release lane");
    expect(releasing).toContain("pre-1.0");
    expect(releasing).toContain("shared change");
    expect(releasing).toContain("unprivileged artifact");
    expect(releasing).toContain("protected publisher");
    expect(releasing).toContain("@swartzrock/llm-now-core");
    expect(releasing).toContain("2FA");
    expect(releasing).toContain("No-go");
    expect(releasing).toContain("next");
    expect(releasing).toContain("latest");
    expect(releasing).toContain("fix-forward");
    expect(releasing).toContain("trusted publisher");
    expect(releasing).toContain("npm 11.5.1+");
    expect(releasing).toContain("https://docs.npmjs.com/trusted-publishers/");
    expect(releasing).toContain("24 hours");
    expect(releasing).toContain("https://slsa.dev/provenance/v1");
    expect(releasing).toContain("https://github.com/swartzrock/llm-now");
    expect(releasing).toContain(".github/workflows/publish-core.yml");
    expect(releasing).toContain("refs/heads/main");
    expect(releasing).toContain("gitCommit");
    expect(releasing).toContain("pkg:npm/%40swartzrock/llm-now-core@VERSION");
    expect(releasing).toContain("SHA-512");
    expect(releasing).toContain("missing authentication");
    expect(manualTesting).toContain("MT-43: First core package publication");
    expect(manualTesting).toContain("Cold-cache Node and Bun consumers");
    expect(manualTesting).toContain("DSSE payload");
    expect(manualTesting).toContain("pkg:npm/%40swartzrock/llm-now-core@VERSION");
    expect(manualTesting).toContain("release SHA");
    expect(manualTesting).toContain("The native manual-test matrix above is unchanged");
    expect(manualTesting).toContain("[CLI argument contract](../packages/cli/src/args.ts)");
  });
});

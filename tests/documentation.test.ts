import { describe, expect, test } from "bun:test";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

const [
  rootReadme,
  packageReadme,
  changelog,
  api,
  security,
  releasing,
  manualTesting,
  changesetReadme,
] = await Promise.all([
  read("../README.md"),
  read("../packages/core/README.md"),
  read("../packages/core/CHANGELOG.md"),
  read("../docs/core-api.md"),
  read("../docs/core-security.md"),
  read("../docs/RELEASING.md"),
  read("../docs/manual-testing.md"),
  read("../.changeset/README.md"),
]);

const coreAssetUrl = "https://github.com/swartzrock/llm-now/releases/download/core-vX.Y.Z/swartzrock-llm-now-core-X.Y.Z.tgz";
const coreWorkflow = ".github/workflows/release-core.yml";
const coreDocs = [rootReadme, packageReadme, api].join("\n");

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

  test("documents exact GitHub Release installation and public visibility", () => {
    for (const document of [rootReadme, packageReadme, api]) {
      expect(document).toContain(coreAssetUrl);
      expect(document).toMatch(/exact version/i);
      expect(document).toMatch(/commit (?:the|your)\s+lockfile/i);
    }
    expect(packageReadme).toContain("npm install");
    expect(packageReadme).toContain("bun add");
    expect(coreDocs).not.toContain("npm install @swartzrock/llm-now-core");
    expect(coreDocs).not.toContain("bun add @swartzrock/llm-now-core");
    expect(coreDocs).toContain("private: true");
    expect(coreDocs).toMatch(/prevents npm publication/i);
    expect(coreDocs).toMatch(/source and GitHub Release assets remain public/i);
    expect(coreDocs).toMatch(/transitive dependencies.*registr/is);
    expect(coreDocs).not.toContain("releases/latest/download/swartzrock-llm-now-core");
  });

  test("documents checksum, attestation, and maintained consumer smokes", () => {
    for (const command of [
      "sha256sum --check --strict --status SHA256SUMS",
      "gh attestation verify",
      "--signer-workflow swartzrock/llm-now/.github/workflows/release-core.yml",
      "--source-digest <SHA>",
      "gh release verify core-vX.Y.Z",
      "gh release verify-asset core-vX.Y.Z swartzrock-llm-now-core-X.Y.Z.tgz",
    ]) expect(packageReadme).toContain(command);
    expect(manualTesting).toContain("Node 20 or later");
    expect(manualTesting).toContain("Bun 1.3.14 or later");
    expect(manualTesting).toContain("TypeScript NodeNext");
    expect(manualTesting).toContain(coreAssetUrl);
  });

  test("documents the independent GitHub core and native release lanes", () => {
    expect(releasing).toContain("Core package release lane");
    expect(releasing).toContain("Native CLI release lane");
    expect(releasing).toContain("pre-1.0");
    expect(releasing).toContain("shared change");
    expect(releasing).toContain("unprivileged artifact");
    expect(releasing).toContain("protected publisher");
    expect(releasing).toContain("@swartzrock/llm-now-core");
    expect(releasing).toContain(coreWorkflow);
    expect(releasing).toContain("core-vX.Y.Z");
    expect(releasing).toContain("swartzrock-llm-now-core-X.Y.Z.tgz");
    expect(releasing).toContain("SHA256SUMS");
    expect(releasing).toContain("private: true");
    expect(releasing).toContain("npm pack");
    expect(releasing).toMatch(/artifact construction only/i);
    expect(releasing).toContain("No-go");
    expect(releasing).toContain("--latest=false");
    expect(releasing).toMatch(/native.*`vX\.Y\.Z`/is);
    expect(releasing).toMatch(/core.*`core-vX\.Y\.Z`/is);
    expect(releasing).toMatch(/latest Release.*native/is);
    expect(releasing).toContain("fix-forward");
    expect(releasing).toContain("24 hours");
    expect(changesetReadme).toMatch(/GitHub core Release/i);
    expect(changesetReadme).toMatch(/independent/i);
    expect(changesetReadme).toContain("core-vX.Y.Z");
  });

  test("documents first core Release setup, publication, and fail-closed recovery", () => {
    for (const phrase of [
      "repository-level immutable Releases",
      "release-publication",
      "protected `main`",
      "stable `core-v*` recovery tags",
      "feature branches and pull-request refs",
      "draft Release",
      "exact two-asset",
      "--latest=false",
      "exact complete immutable Release",
      "verification-only no-op",
      "exact tag without a Release",
      "selected workflow ref and `release-sha`",
      "fix-forward",
    ]) expect(releasing).toContain(phrase);
    expect(releasing).toMatch(/core\s+`0\.1\.0` to `0\.1\.1`/i);
    expect(releasing).toMatch(/first GitHub core Release/i);
    expect(releasing).toContain("gh workflow run release-core.yml --ref \"$TAG\"");
    expect(releasing).toContain("-f release-sha=\"$RELEASE_SHA\"");
    expect(releasing).toContain("-f publish=true");
    expect(releasing).toMatch(/rerun the original automatic workflow run/i);
    expect(releasing).toMatch(/preserve evidence/i);
    expect(releasing).toMatch(/never rerun.*historical.*publish-core/i);

    expect(manualTesting).toContain("MT-43: First GitHub core Release");
    expect(manualTesting).toContain("MT-44: Core Release record and 24-hour check");
    expect(manualTesting).toContain("core-v0.1.1");
    expect(manualTesting).toContain("release SHA");
    expect(manualTesting).toContain("no native archive or `vX.Y.Z` tag");
    expect(manualTesting).not.toContain(
      "must produce no native archive, tag, GitHub Release",
    );
    expect(manualTesting).toContain("The native manual-test matrix above is unchanged");
    expect(manualTesting).toContain("[CLI argument contract](../packages/cli/src/args.ts)");
  });

  test("records 0.1.0 as unreleased and removes historical npm release instructions", () => {
    expect(changelog).toContain("unreleased extracted version");
    expect(changelog).toMatch(/`0\.1\.1`.*first\s+GitHub core Release/is);

    const retiredInstructions = [
      "NPM_BOOTSTRAP_TOKEN",
      "NPM_DIST_TAG_TOKEN",
      "npm-core-publish",
      "trusted publisher",
      ".github/workflows/publish-core.yml",
      "pkg:npm/%40swartzrock/llm-now-core@VERSION",
      "https://registry.npmjs.org",
    ];
    for (const instruction of retiredInstructions) {
      expect(releasing).not.toContain(instruction);
      expect(manualTesting).not.toContain(instruction);
    }
    expect(releasing).not.toMatch(/(?:^|[`$ ])npm publish(?:\s|`|$)/m);
    expect(manualTesting).not.toMatch(/(?:^|[`$ ])npm publish(?:\s|`|$)/m);
  });
});

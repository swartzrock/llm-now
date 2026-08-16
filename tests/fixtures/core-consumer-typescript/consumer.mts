import {
  LlmNowError,
  compactRoutingKey,
  createLlmNowCore,
  routeTranscript,
  routingSimilarity,
  workspaceCapabilities,
  type CliExecutionDescriptor,
  type CliExecutionResolver,
  type CredentialResolution,
  type CredentialResolver,
  type DirectCliExecutionDescriptor,
  type EnvironmentSnapshot,
  type GenerateTextRequest,
  type GenerateTextResult,
  type LlmNowCoreClient,
  type LlmNowCoreDependencies,
  type LlmNowErrorCode,
  type LlmNowOperation,
  type ModelListRequest,
  type ModelListResult,
  type ProviderDiscoveryRequest,
  type ProviderDiscoveryResult,
  type RouteMatch,
  type RouteMatchReason,
  type RouteRejection,
  type RouteRejectionReason,
  type RouteTranscriptInput,
  type RouteTranscriptResult,
  type RoutingCandidate,
  type StreamTextResult,
  type TextDeltaHandler,
  type ValidateConnectionRequest,
  type ValidationResult,
  type WindowsCommandShimExecutionDescriptor,
  type WorkspaceCapabilities,
  type WorkspaceRequest,
} from "@swartzrock/llm-now-core";

const resolver: CredentialResolver = {
  resolve: async (): Promise<CredentialResolution> => ({ status: "missing" }),
};
const executionResolver: CliExecutionResolver = {
  resolve: async (): Promise<CliExecutionDescriptor | null> => null,
};
const dependencies: LlmNowCoreDependencies = {
  environment: {} satisfies EnvironmentSnapshot,
  credentialResolver: resolver,
  cliExecutionResolver: executionResolver,
};
const client: LlmNowCoreClient = createLlmNowCore(dependencies);
const request: GenerateTextRequest = { provider: "ollama", model: "fixture", prompt: "hello" };
const generation: Promise<GenerateTextResult> = client.generateText(request);
const stream: Promise<StreamTextResult> = client.streamText(request, (() => undefined) satisfies TextDeltaHandler);
const discoveryRequest: ProviderDiscoveryRequest = {};
const discovery: Promise<ProviderDiscoveryResult> = client.discoverProviders(discoveryRequest);
const modelRequest: ModelListRequest = { provider: "ollama" };
const models: Promise<ModelListResult> = client.listModels(modelRequest);
const validationRequest: ValidateConnectionRequest = { provider: "ollama" };
const validation: Promise<ValidationResult> = client.validateConnection(validationRequest);
const candidate: RoutingCandidate = { id: "terra", canonicalName: "terra" };
const routingInput: RouteTranscriptInput = {
  transcript: "terra hello",
  candidates: [candidate],
  wakeWords: [],
  minFuzzyPhraseLength: 4,
  minSimilarity: 65,
  minMargin: 15,
};
const route: RouteTranscriptResult = routeTranscript(routingInput);
const direct: DirectCliExecutionDescriptor | WindowsCommandShimExecutionDescriptor | null = null;
const routeTypes: RouteMatch | RouteRejection | null = null;
const reasonTypes: RouteMatchReason | RouteRejectionReason | null = null;
const errorTypes: LlmNowErrorCode | LlmNowOperation | null = null;
const capabilities: WorkspaceCapabilities = workspaceCapabilities("ollama");
const workspace: WorkspaceRequest = {
  primaryDirectory: "/tmp",
  additionalDirectories: [],
  directoryAccess: "read-only",
};

void [
  LlmNowError,
  compactRoutingKey,
  routingSimilarity,
  generation,
  stream,
  discovery,
  models,
  validation,
  route,
  direct,
  routeTypes,
  reasonTypes,
  errorTypes,
  capabilities,
  workspace,
];

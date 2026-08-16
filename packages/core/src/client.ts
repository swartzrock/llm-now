import {
  isByokProviderId,
  type ByokProviderConfig,
  type ByokProviderRuntime,
} from "@swartzrock/byok-runtime";
import type { CliExecutionResolver } from "./cli-execution.js";
import type { CredentialResolution, CredentialResolver } from "./credentials.js";
import { LlmNowError } from "./errors.js";
import {
  CLOUD_PROVIDERS,
  DEFAULT_CORE_INTERNALS,
  DISCOVERY_ORDER,
  createCliRuntime,
  isCliProvider,
  isCloudProvider,
  providerFamily,
  resolveCliExecution,
  type CoreInternalDependencies,
} from "./providers.js";
import {
  createRequestSafety,
  sanitizeModelText,
  type RequestSafety,
} from "./safety.js";
import {
  awaitDeltaHandler,
  createLinkedAbortController,
  finalizeIterator,
  raceWithCancellation,
  settleOperation,
} from "./streaming.js";
import type {
  DiagnosticHandler,
  EnvironmentSnapshot,
  GenerateTextRequest,
  GenerateTextResult,
  ModelListRequest,
  ModelListResult,
  ProviderAvailability,
  ProviderDiscoveryRequest,
  ProviderDiscoveryResult,
  ProviderId,
  StreamTextResult,
  TextDeltaHandler,
  ValidateConnectionRequest,
  ValidationResult,
  WorkspaceRequest,
} from "./types.js";
import { preflightWorkspace } from "./workspace.js";

export type { CoreInternalDependencies } from "./providers.js";

export interface LlmNowCoreDependencies {
  readonly environment: EnvironmentSnapshot;
  readonly credentialResolver: CredentialResolver;
  readonly cliExecutionResolver?: CliExecutionResolver;
}

export interface LlmNowCoreClient {
  discoverProviders(request?: ProviderDiscoveryRequest): Promise<ProviderDiscoveryResult>;
  listModels(request: ModelListRequest): Promise<ModelListResult>;
  validateConnection(request: ValidateConnectionRequest): Promise<ValidationResult>;
  generateText(request: GenerateTextRequest): Promise<GenerateTextResult>;
  streamText(
    request: GenerateTextRequest,
    onTextDelta: TextDeltaHandler,
  ): Promise<StreamTextResult>;
}

type CoreOperation = "discovery" | "model-list" | "validation" | "generation" | "streaming";

function invalidRequest(operation: CoreOperation, provider?: ProviderId): LlmNowError {
  return new LlmNowError("INVALID_REQUEST", operation, provider);
}

function validProvider(value: unknown, operation: CoreOperation): ProviderId {
  if (!isByokProviderId(value)) throw invalidRequest(operation);
  return value;
}

function safeFailure(
  error: unknown,
  operation: CoreOperation,
  fallback: "DISCOVERY_FAILED" | "MODEL_LIST_FAILED" | "VALIDATION_FAILED" | "GENERATION_FAILED",
  provider?: ProviderId,
  signal?: AbortSignal,
): LlmNowError {
  if (error instanceof LlmNowError) return error;
  if (signal?.aborted) return new LlmNowError("ABORTED", operation, provider);
  return new LlmNowError(fallback, operation, provider);
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function requestObject(
  value: unknown,
  operation: CoreOperation,
): asserts value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidRequest(operation);
  }
}

function requestSignal(
  value: unknown,
  operation: CoreOperation,
  provider?: ProviderId,
): AbortSignal | undefined {
  if (value === undefined || value instanceof AbortSignal) return value;
  throw invalidRequest(operation, provider);
}

function requestDiagnosticHandler(
  value: unknown,
  operation: CoreOperation,
  provider?: ProviderId,
): DiagnosticHandler | undefined {
  if (value === undefined || typeof value === "function") return value as DiagnosticHandler | undefined;
  throw invalidRequest(operation, provider);
}

function snapshotWorkspace(workspace: WorkspaceRequest | undefined): WorkspaceRequest | undefined {
  if (
    workspace === undefined
    || typeof workspace !== "object"
    || workspace === null
    || !Array.isArray(workspace.additionalDirectories)
  ) return workspace;
  return Object.freeze({
    primaryDirectory: workspace.primaryDirectory,
    additionalDirectories: Object.freeze([...workspace.additionalDirectories]),
    directoryAccess: workspace.directoryAccess,
  });
}

function registerWorkspaceDiagnostic(
  safety: RequestSafety,
  workspace: WorkspaceRequest | undefined,
): void {
  if (workspace === undefined || typeof workspace !== "object" || workspace === null) return;
  if (typeof workspace.primaryDirectory === "string") {
    safety.registerDiagnosticSensitive(workspace.primaryDirectory);
  }
  if (Array.isArray(workspace.additionalDirectories)) {
    for (const directory of workspace.additionalDirectories) {
      if (typeof directory === "string") safety.registerDiagnosticSensitive(directory);
    }
  }
}

function ownErrorMessage(error: unknown): string | undefined {
  try {
    if (!(error instanceof Error)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    return typeof descriptor?.value === "string" ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function reportDiagnostic(
  handler: DiagnosticHandler | undefined,
  safety: RequestSafety,
  error: unknown,
): void {
  if (handler === undefined || error instanceof LlmNowError) return;
  const message = ownErrorMessage(error);
  if (message === undefined) return;
  try {
    void Promise.resolve(handler(sanitizeModelText(safety.redactDiagnostic(message))))
      .catch(() => undefined);
  } catch {
    // A diagnostic callback cannot replace the operation's primary outcome.
  }
}

async function resolveCredential(
  resolver: CredentialResolver,
  provider: ProviderId,
  operation: CoreOperation,
  signal?: AbortSignal,
): Promise<CredentialResolution> {
  if (!isCloudProvider(provider)) throw invalidRequest(operation, provider);
  try {
    signal?.throwIfAborted();
    const resolving = Promise.resolve().then(() => resolver.resolve(provider, signal));
    const resolution = signal === undefined
      ? await resolving
      : await raceWithCancellation(resolving, signal);
    signal?.throwIfAborted();
    if (
      resolution.status === "resolved"
      && nonblank(resolution.credential)
      || resolution.status === "missing"
      || resolution.status === "unavailable"
    ) return resolution;
    throw new Error("invalid credential resolution");
  } catch (error) {
    if (signal?.aborted) throw new LlmNowError("ABORTED", operation, provider);
    if (error instanceof LlmNowError) throw error;
    throw new LlmNowError("CREDENTIAL_RESOLUTION_FAILED", operation, provider);
  }
}

function requireResolvedCredential(
  resolution: CredentialResolution,
  operation: CoreOperation,
  provider: ProviderId,
): string {
  if (resolution.status === "resolved") return resolution.credential;
  throw new LlmNowError("CREDENTIAL_UNAVAILABLE", operation, provider);
}

function cloudConfig(
  provider: ProviderId,
  credential: string,
  model: string,
  operation: CoreOperation,
): ByokProviderConfig {
  if (!isCloudProvider(provider)) throw invalidRequest(operation, provider);
  return { provider, apiKey: credential, model };
}

function localConfig(provider: ProviderId, model: string, operation: CoreOperation): ByokProviderConfig {
  if (provider !== "ollama" && provider !== "lm-studio") {
    throw invalidRequest(operation, provider);
  }
  return { provider, model };
}

function validateGenerationRequest(request: GenerateTextRequest, operation: "generation" | "streaming"): ProviderId {
  requestObject(request, operation);
  const provider = validProvider(request.provider, operation);
  if (!nonblank(request.prompt)) throw invalidRequest(operation, provider);
  if (request.instructions !== undefined && typeof request.instructions !== "string") {
    throw invalidRequest(operation, provider);
  }
  if (
    (request.model !== null && !nonblank(request.model))
    || (request.model === null && !isCliProvider(provider))
    || (request.responseSensitiveValues !== undefined
      && (!Array.isArray(request.responseSensitiveValues)
        || request.responseSensitiveValues.some((value) => typeof value !== "string")))
  ) throw invalidRequest(operation, provider);
  return provider;
}

function safeModels(
  models: readonly { id: string; label: string }[],
  safety: RequestSafety,
  operation: "model-list" | "validation",
  provider: ProviderId,
): readonly { id: string; label: string }[] {
  const safe: { id: string; label: string }[] = [];
  const failure = () => new LlmNowError(
    operation === "model-list" ? "MODEL_LIST_FAILED" : "VALIDATION_FAILED",
    operation,
    provider,
  );
  for (const model of models) {
    const id = model.id;
    const label = model.label;
    if (typeof id !== "string" || typeof label !== "string") throw failure();
    const checkedId = safety.checkBufferedResponse(id);
    const checkedLabel = safety.checkBufferedResponse(label);
    if (
      !checkedId.safe
      || !checkedLabel.safe
      || checkedId.text !== id
      || checkedLabel.text !== label
    ) {
      throw failure();
    }
    safe.push(Object.freeze({ id: checkedId.text, label: checkedLabel.text }));
  }
  return Object.freeze(safe);
}

async function runtimeForOperation(
  deps: LlmNowCoreDependencies,
  internals: CoreInternalDependencies,
  provider: ProviderId,
  model: string | null,
  operation: "model-list" | "validation" | "generation" | "streaming",
  signal?: AbortSignal,
  workspace?: WorkspaceRequest,
  candidateCredential?: string,
): Promise<{ runtime: ByokProviderRuntime; responseSensitiveValues: readonly string[] }> {
  if (isCliProvider(provider)) {
    const descriptor = await resolveCliExecution(
      deps.cliExecutionResolver,
      provider,
      signal,
      operation,
    );
    return {
      runtime: createCliRuntime(provider, model, descriptor, internals, workspace, signal),
      responseSensitiveValues: descriptor.responseSensitiveValues ?? [],
    };
  }
  if (isCloudProvider(provider)) {
    const credential = candidateCredential ?? requireResolvedCredential(
      await resolveCredential(deps.credentialResolver, provider, operation, signal),
      operation,
      provider,
    );
    return {
      runtime: internals.createProvider(cloudConfig(provider, credential, model ?? "", operation)),
      responseSensitiveValues: [credential],
    };
  }
  return {
    runtime: internals.createProvider(localConfig(provider, model ?? "", operation)),
    responseSensitiveValues: [],
  };
}

export function createLlmNowCoreWithInternals(
  deps: LlmNowCoreDependencies,
  internals: CoreInternalDependencies,
): LlmNowCoreClient {
  try {
    if (
      typeof deps !== "object"
      || deps === null
      || typeof deps.environment !== "object"
      || deps.environment === null
      || typeof deps.credentialResolver?.resolve !== "function"
    ) throw invalidRequest("generation");
  } catch {
    throw invalidRequest("generation");
  }

  return Object.freeze({
    async discoverProviders(request: ProviderDiscoveryRequest = {}) {
      let linked: ReturnType<typeof createLinkedAbortController> | undefined;
      let pendingWork: PromiseLike<unknown> | undefined;
      let onDiagnostic: DiagnosticHandler | undefined;
      let failed = true;
      const safety = createRequestSafety();
      try {
        requestObject(request, "discovery");
        const parentSignal = requestSignal(request.signal, "discovery");
        onDiagnostic = requestDiagnosticHandler(request.onDiagnostic, "discovery");
        linked = createLinkedAbortController(parentSignal);
        const signal = linked.controller.signal;
        signal.throwIfAborted();
        const discovery = Promise.resolve().then(() => internals.findAvailableProviders({
          executionResolver: deps.cliExecutionResolver,
          signal,
        }));
        pendingWork = discovery;
        const detected = new Set(await raceWithCancellation(discovery, signal));
        pendingWork = undefined;
        signal.throwIfAborted();
        const records = new Map<ProviderId, ProviderAvailability>();
        for (const provider of [...DISCOVERY_ORDER]) {
          if (!isCloudProvider(provider)) {
            const available = detected.has(provider)
              && (!isCliProvider(provider) || deps.cliExecutionResolver !== undefined);
            records.set(provider, Object.freeze({
              provider,
              family: providerFamily(provider),
              available,
              ...(!available
                ? { reason: isCliProvider(provider) ? "execution-unavailable" : "connection-unavailable" }
                : {}),
            }));
          }
        }

        let degraded = false;
        for (const [index, provider] of CLOUD_PROVIDERS.entries()) {
          let resolution: CredentialResolution;
          try {
            resolution = await resolveCredential(
              deps.credentialResolver,
              provider,
              "discovery",
              signal,
            );
          } catch (error) {
            const usable = [...records.values()].some(({ available }) => available);
            if (!usable) throw error;
            degraded = true;
            for (const unresolved of CLOUD_PROVIDERS.slice(index)) {
              records.set(unresolved, Object.freeze({
                provider: unresolved,
                family: "cloud",
                available: false,
                reason: "credential-resolution-failed",
              }));
            }
            break;
          }
          records.set(provider, Object.freeze({
            provider,
            family: "cloud",
            available: resolution.status === "resolved",
            ...(resolution.status === "missing"
              ? { reason: "credential-missing" as const }
              : resolution.status === "unavailable"
                ? { reason: "credential-unavailable" as const }
                : {}),
          }));
        }
        signal.throwIfAborted();
        failed = false;
        return Object.freeze({
          providers: Object.freeze(DISCOVERY_ORDER.map((provider) => records.get(provider)!)),
          degraded,
        });
      } catch (error) {
        if (!linked?.controller.signal.aborted) reportDiagnostic(onDiagnostic, safety, error);
        const failure = safeFailure(
          error,
          "discovery",
          "DISCOVERY_FAILED",
          undefined,
          linked?.controller.signal,
        );
        linked?.controller.abort();
        throw failure;
      } finally {
        if (failed) {
          linked?.controller.abort();
          await settleOperation(pendingWork, "bounded", internals.settlementTimeoutMs);
        }
        linked?.dispose();
        safety.clear();
      }
    },

    async listModels(request: ModelListRequest) {
      let provider: ProviderId | undefined;
      let linked: ReturnType<typeof createLinkedAbortController> | undefined;
      let providerWork: PromiseLike<unknown> | undefined;
      let onDiagnostic: DiagnosticHandler | undefined;
      let failed = true;
      const safety = createRequestSafety();
      try {
        requestObject(request, "model-list");
        provider = validProvider(request.provider, "model-list");
        const parentSignal = requestSignal(request.signal, "model-list", provider);
        onDiagnostic = requestDiagnosticHandler(request.onDiagnostic, "model-list", provider);
        linked = createLinkedAbortController(parentSignal);
        const signal = linked.controller.signal;
        signal.throwIfAborted();
        const { runtime, responseSensitiveValues } = await runtimeForOperation(
          deps,
          internals,
          provider,
          null,
          "model-list",
          signal,
        );
        for (const value of responseSensitiveValues) safety.registerResponseSensitive(value);
        signal.throwIfAborted();
        const listing = Promise.resolve().then(() => runtime.listModels());
        providerWork = listing;
        const models = await raceWithCancellation(listing, signal);
        providerWork = undefined;
        signal.throwIfAborted();
        const checkedModels = safeModels(models, safety, "model-list", provider);
        failed = false;
        return Object.freeze({ provider, models: checkedModels });
      } catch (error) {
        if (!linked?.controller.signal.aborted) reportDiagnostic(onDiagnostic, safety, error);
        const failure = safeFailure(
          error,
          "model-list",
          "MODEL_LIST_FAILED",
          provider,
          linked?.controller.signal,
        );
        linked?.controller.abort();
        throw failure;
      } finally {
        if (failed && providerWork !== undefined) {
          await settleOperation(
            providerWork,
            provider !== undefined && isCliProvider(provider) ? "full" : "bounded",
            internals.settlementTimeoutMs,
          );
        }
        linked?.dispose();
        safety.clear();
      }
    },

    async validateConnection(request: ValidateConnectionRequest) {
      let provider: ProviderId | undefined;
      let linked: ReturnType<typeof createLinkedAbortController> | undefined;
      let providerWork: PromiseLike<unknown> | undefined;
      let onDiagnostic: DiagnosticHandler | undefined;
      let failed = true;
      const safety = createRequestSafety();
      try {
        requestObject(request, "validation");
        provider = validProvider(request.provider, "validation");
        const parentSignal = requestSignal(request.signal, "validation", provider);
        onDiagnostic = requestDiagnosticHandler(request.onDiagnostic, "validation", provider);
        const candidateCredential = request.candidateCredential;
        const hasCandidate = candidateCredential !== undefined;
        if (hasCandidate && (!isCloudProvider(provider) || !nonblank(candidateCredential))) {
          throw invalidRequest("validation", provider);
        }
        linked = createLinkedAbortController(parentSignal);
        const signal = linked.controller.signal;
        if (candidateCredential !== undefined) {
          safety.registerResponseSensitive(candidateCredential);
        }
        signal.throwIfAborted();
        const { runtime, responseSensitiveValues } = await runtimeForOperation(
          deps,
          internals,
          provider,
          null,
          "validation",
          signal,
          undefined,
          hasCandidate ? candidateCredential : undefined,
        );
        for (const value of responseSensitiveValues) safety.registerResponseSensitive(value);
        signal.throwIfAborted();
        const validation = Promise.resolve().then(() => runtime.listModels());
        providerWork = validation;
        const models = await raceWithCancellation(validation, signal);
        providerWork = undefined;
        signal.throwIfAborted();
        const checkedModels = safeModels(models, safety, "validation", provider);
        failed = false;
        return Object.freeze({ provider, models: checkedModels });
      } catch (error) {
        if (!linked?.controller.signal.aborted) reportDiagnostic(onDiagnostic, safety, error);
        const failure = safeFailure(
          error,
          "validation",
          "VALIDATION_FAILED",
          provider,
          linked?.controller.signal,
        );
        linked?.controller.abort();
        throw failure;
      } finally {
        if (failed && providerWork !== undefined) {
          await settleOperation(
            providerWork,
            provider !== undefined && isCliProvider(provider) ? "full" : "bounded",
            internals.settlementTimeoutMs,
          );
        }
        linked?.dispose();
        safety.clear();
      }
    },

    async generateText(request: GenerateTextRequest) {
      let provider: ProviderId | undefined;
      let linked: ReturnType<typeof createLinkedAbortController> | undefined;
      let pendingPreflightWork: PromiseLike<unknown> | undefined;
      let providerWork: PromiseLike<unknown> | undefined;
      let onDiagnostic: DiagnosticHandler | undefined;
      let failed = true;
      const safety = createRequestSafety();
      try {
        provider = validateGenerationRequest(request, "generation");
        const model = request.model;
        const prompt = request.prompt;
        const instructions = request.instructions;
        const requestedWorkspace = snapshotWorkspace(request.workspace);
        const responseSensitiveValues = Object.freeze([...(request.responseSensitiveValues ?? [])]);
        const parentSignal = requestSignal(request.signal, "generation", provider);
        onDiagnostic = requestDiagnosticHandler(request.onDiagnostic, "generation", provider);
        linked = createLinkedAbortController(parentSignal);
        const signal = linked.controller.signal;
        for (const value of responseSensitiveValues) {
          safety.registerResponseSensitive(value);
        }
        safety.registerDiagnosticSensitive(prompt);
        if (instructions !== undefined) {
          safety.registerDiagnosticSensitive(instructions);
        }
        registerWorkspaceDiagnostic(safety, requestedWorkspace);
        signal.throwIfAborted();
        let workspace: WorkspaceRequest | undefined;
        if (requestedWorkspace !== undefined) {
          const preflighting = (internals.preflightWorkspace ?? preflightWorkspace)(
            provider,
            requestedWorkspace,
            "generation",
          );
          pendingPreflightWork = preflighting;
          workspace = await raceWithCancellation(preflighting, signal);
          pendingPreflightWork = undefined;
          registerWorkspaceDiagnostic(safety, workspace);
        }
        signal.throwIfAborted();
        const { runtime, responseSensitiveValues: runtimeSensitiveValues } = await runtimeForOperation(
          deps,
          internals,
          provider,
          model,
          "generation",
          signal,
          workspace,
        );
        for (const value of runtimeSensitiveValues) safety.registerResponseSensitive(value);
        signal.throwIfAborted();
        const generation = Promise.resolve().then(() => runtime.generateText({
          prompt,
          ...(instructions === undefined ? {} : { instructions }),
        }, signal));
        providerWork = generation;
        const output = await raceWithCancellation(generation, signal);
        signal.throwIfAborted();
        const checked = safety.checkBufferedResponse(output.text);
        if (!checked.safe) throw new LlmNowError("UNSAFE_RESPONSE", "generation", provider);
        failed = false;
        return Object.freeze({
          provider,
          model,
          text: checked.text,
        });
      } catch (error) {
        if (!linked?.controller.signal.aborted) reportDiagnostic(onDiagnostic, safety, error);
        const failure = safeFailure(
          error,
          "generation",
          "GENERATION_FAILED",
          provider,
          linked?.controller.signal,
        );
        linked?.controller.abort();
        throw failure;
      } finally {
        if (failed) {
          const cleanup = Promise.allSettled(
            [pendingPreflightWork, providerWork]
              .filter((operation): operation is PromiseLike<unknown> => operation !== undefined),
          );
          await settleOperation(
            cleanup,
            providerWork !== undefined && provider !== undefined && isCliProvider(provider)
              ? "full"
              : "bounded",
            internals.settlementTimeoutMs,
          );
        }
        linked?.dispose();
        safety.clear();
      }
    },

    async streamText(request: GenerateTextRequest, onTextDelta: TextDeltaHandler) {
      let provider: ProviderId | undefined;
      let linked: ReturnType<typeof createLinkedAbortController> | undefined;
      let pendingPreflightWork: PromiseLike<unknown> | undefined;
      let pendingProviderWork: PromiseLike<unknown> | undefined;
      let iterator: AsyncIterator<string> | undefined;
      let onDiagnostic: DiagnosticHandler | undefined;
      let failed = true;
      const safety = createRequestSafety();
      try {
        provider = validateGenerationRequest(request, "streaming");
        if (typeof onTextDelta !== "function") throw invalidRequest("streaming", provider);
        const model = request.model;
        const prompt = request.prompt;
        const instructions = request.instructions;
        const requestedWorkspace = snapshotWorkspace(request.workspace);
        const responseSensitiveValues = Object.freeze([...(request.responseSensitiveValues ?? [])]);
        const parentSignal = requestSignal(request.signal, "streaming", provider);
        onDiagnostic = requestDiagnosticHandler(request.onDiagnostic, "streaming", provider);
        linked = createLinkedAbortController(parentSignal);
        const signal = linked.controller.signal;
        for (const value of responseSensitiveValues) {
          safety.registerResponseSensitive(value);
        }
        safety.registerDiagnosticSensitive(prompt);
        if (instructions !== undefined) {
          safety.registerDiagnosticSensitive(instructions);
        }
        registerWorkspaceDiagnostic(safety, requestedWorkspace);
        signal.throwIfAborted();
        let workspace: WorkspaceRequest | undefined;
        if (requestedWorkspace !== undefined) {
          const preflighting = (internals.preflightWorkspace ?? preflightWorkspace)(
            provider,
            requestedWorkspace,
            "streaming",
          );
          pendingPreflightWork = preflighting;
          workspace = await raceWithCancellation(preflighting, signal);
          pendingPreflightWork = undefined;
          registerWorkspaceDiagnostic(safety, workspace);
        }
        signal.throwIfAborted();
        const { runtime, responseSensitiveValues: runtimeSensitiveValues } = await runtimeForOperation(
          deps,
          internals,
          provider,
          model,
          "streaming",
          signal,
          workspace,
        );
        for (const value of runtimeSensitiveValues) safety.registerResponseSensitive(value);
        signal.throwIfAborted();
        const input = {
          prompt,
          ...(instructions === undefined ? {} : { instructions }),
        };

        if (runtime.streamText === undefined) {
          const generation = Promise.resolve().then(() => runtime.generateText(input, signal));
          pendingProviderWork = generation;
          const output = await raceWithCancellation(generation, signal);
          pendingProviderWork = undefined;
          const checked = safety.checkBufferedResponse(output.text);
          if (!checked.safe) throw new LlmNowError("UNSAFE_RESPONSE", "streaming", provider);
          await awaitDeltaHandler(onTextDelta, checked.text, signal, provider);
          failed = false;
          return Object.freeze({
            provider,
            model,
            delivery: "buffered" as const,
            text: checked.text,
          });
        }

        const stream = runtime.streamText(input, signal);
        if (
          (stream.delivery !== "native" && stream.delivery !== "buffered")
          || typeof stream.textStream?.[Symbol.asyncIterator] !== "function"
        ) throw new Error("invalid provider stream");
        iterator = stream.textStream[Symbol.asyncIterator]();
        while (true) {
          const next = Promise.resolve().then(() => iterator!.next());
          pendingProviderWork = next;
          const step = await raceWithCancellation(next, signal);
          pendingProviderWork = undefined;
          if (step.done) break;
          if (typeof step.value !== "string") throw new Error("invalid provider delta");
          const checked = safety.checkStreamingDelta(step.value);
          if (!checked.safe) throw new LlmNowError("UNSAFE_RESPONSE", "streaming", provider);
          await awaitDeltaHandler(onTextDelta, checked.delta, signal, provider);
        }
        const final = safety.checkStreamingResponse();
        if (!final.safe) throw new LlmNowError("UNSAFE_RESPONSE", "streaming", provider);
        if (final.delta.length > 0) {
          await awaitDeltaHandler(onTextDelta, final.delta, signal, provider);
        }
        failed = false;
        return Object.freeze({
          provider,
          model,
          delivery: stream.delivery,
          text: final.text,
        });
      } catch (error) {
        if (!linked?.controller.signal.aborted) reportDiagnostic(onDiagnostic, safety, error);
        const failure = safeFailure(
          error,
          "streaming",
          "GENERATION_FAILED",
          provider,
          linked?.controller.signal,
        );
        linked?.controller.abort();
        throw failure;
      } finally {
        if (failed) {
          linked?.controller.abort();
          const iteratorCleanup = finalizeIterator(iterator)?.then(
            () => undefined,
            () => undefined,
          );
          const mode = provider !== undefined && isCliProvider(provider) ? "full" : "bounded";
          const cleanup = Promise.allSettled(
            [pendingPreflightWork, pendingProviderWork, iteratorCleanup]
              .filter((operation): operation is PromiseLike<unknown> => operation !== undefined),
          );
          await settleOperation(
            cleanup,
            pendingProviderWork !== undefined ? mode : "bounded",
            internals.settlementTimeoutMs,
          );
        }
        linked?.dispose();
        safety.clear();
      }
    },
  });
}

export function createLlmNowCore(deps: LlmNowCoreDependencies): LlmNowCoreClient {
  return createLlmNowCoreWithInternals(deps, DEFAULT_CORE_INTERNALS);
}

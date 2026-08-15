import {
  BYOK_PROVIDER_IDS,
  isByokProviderId,
  type ByokProviderConfig,
  type ByokProviderRuntime,
} from "@swartzrock/byok-runtime";
import type { CliExecutionResolver } from "./cli-execution.ts";
import type { CredentialResolution, CredentialResolver } from "./credentials.ts";
import { LlmNowError } from "./errors.ts";
import {
  CLI_PROVIDERS,
  CLOUD_PROVIDERS,
  DEFAULT_CORE_INTERNALS,
  DISCOVERY_ORDER,
  createCliRuntime,
  isCliProvider,
  isCloudProvider,
  providerFamily,
  resolveCliExecution,
  type CoreInternalDependencies,
} from "./providers.ts";
import { createRequestSafety } from "./safety.ts";
import {
  awaitDeltaHandler,
  createLinkedAbortController,
  finalizeIterator,
  raceWithCancellation,
  settleOperation,
} from "./streaming.ts";
import type {
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
} from "./types.ts";
import { preflightWorkspace } from "./workspace.ts";

export type { CoreInternalDependencies } from "./providers.ts";

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

function freezeModels<T extends readonly { id: string; label: string }[]>(models: T): T {
  return Object.freeze(models.map((model) => Object.freeze({ id: model.id, label: model.label }))) as T;
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
      runtime: createCliRuntime(provider, model, descriptor, internals, workspace),
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
      let signal: AbortSignal | undefined;
      try {
        requestObject(request, "discovery");
        signal = requestSignal(request.signal, "discovery");
        signal?.throwIfAborted();
        const detected = new Set(await internals.findAvailableProviders({
          executionResolver: deps.cliExecutionResolver,
          signal,
        }));
        signal?.throwIfAborted();
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
        return Object.freeze({
          providers: Object.freeze(DISCOVERY_ORDER.map((provider) => records.get(provider)!)),
          degraded,
        });
      } catch (error) {
        throw safeFailure(error, "discovery", "DISCOVERY_FAILED", undefined, signal);
      }
    },

    async listModels(request: ModelListRequest) {
      let provider: ProviderId | undefined;
      let signal: AbortSignal | undefined;
      try {
        requestObject(request, "model-list");
        provider = validProvider(request.provider, "model-list");
        signal = requestSignal(request.signal, "model-list", provider);
        signal?.throwIfAborted();
        const { runtime } = await runtimeForOperation(
          deps,
          internals,
          provider,
          null,
          "model-list",
          signal,
        );
        signal?.throwIfAborted();
        const models = await runtime.listModels();
        signal?.throwIfAborted();
        return Object.freeze({ provider, models: freezeModels(models) });
      } catch (error) {
        throw safeFailure(error, "model-list", "MODEL_LIST_FAILED", provider, signal);
      }
    },

    async validateConnection(request: ValidateConnectionRequest) {
      let provider: ProviderId | undefined;
      let signal: AbortSignal | undefined;
      try {
        requestObject(request, "validation");
        provider = validProvider(request.provider, "validation");
        signal = requestSignal(request.signal, "validation", provider);
        const hasCandidate = request.candidateCredential !== undefined;
        if (hasCandidate && (!isCloudProvider(provider) || !nonblank(request.candidateCredential))) {
          throw invalidRequest("validation", provider);
        }
        signal?.throwIfAborted();
        const { runtime } = await runtimeForOperation(
          deps,
          internals,
          provider,
          null,
          "validation",
          signal,
          undefined,
          hasCandidate ? request.candidateCredential : undefined,
        );
        signal?.throwIfAborted();
        const models = await runtime.listModels();
        signal?.throwIfAborted();
        return Object.freeze({ provider, models: freezeModels(models) });
      } catch (error) {
        throw safeFailure(error, "validation", "VALIDATION_FAILED", provider, signal);
      }
    },

    async generateText(request: GenerateTextRequest) {
      let provider: ProviderId | undefined;
      let linked: ReturnType<typeof createLinkedAbortController> | undefined;
      let providerWork: PromiseLike<unknown> | undefined;
      let failed = true;
      const safety = createRequestSafety();
      try {
        provider = validateGenerationRequest(request, "generation");
        const parentSignal = requestSignal(request.signal, "generation", provider);
        linked = createLinkedAbortController(parentSignal);
        const signal = linked.controller.signal;
        for (const value of request.responseSensitiveValues ?? []) {
          safety.registerResponseSensitive(value);
        }
        safety.registerDiagnosticSensitive(request.prompt);
        if (request.instructions !== undefined) {
          safety.registerDiagnosticSensitive(request.instructions);
        }
        signal?.throwIfAborted();
        const workspace = request.workspace === undefined
          ? undefined
          : await raceWithCancellation(preflightWorkspace(provider, request.workspace), signal);
        signal?.throwIfAborted();
        const { runtime, responseSensitiveValues } = await runtimeForOperation(
          deps,
          internals,
          provider,
          request.model,
          "generation",
          signal,
          workspace,
        );
        for (const value of responseSensitiveValues) safety.registerResponseSensitive(value);
        signal.throwIfAborted();
        const generation = Promise.resolve().then(() => runtime.generateText({
          prompt: request.prompt,
          ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
        }, signal));
        providerWork = generation;
        const output = await raceWithCancellation(generation, signal);
        signal.throwIfAborted();
        const checked = safety.checkBufferedResponse(output.text);
        if (!checked.safe) throw new LlmNowError("UNSAFE_RESPONSE", "generation", provider);
        failed = false;
        return Object.freeze({
          provider,
          model: request.model,
          text: checked.text,
        });
      } catch (error) {
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

    async streamText(request: GenerateTextRequest, onTextDelta: TextDeltaHandler) {
      let provider: ProviderId | undefined;
      let linked: ReturnType<typeof createLinkedAbortController> | undefined;
      let pendingProviderWork: PromiseLike<unknown> | undefined;
      let iterator: AsyncIterator<string> | undefined;
      let failed = true;
      const safety = createRequestSafety();
      try {
        provider = validateGenerationRequest(request, "streaming");
        if (typeof onTextDelta !== "function") throw invalidRequest("streaming", provider);
        const parentSignal = requestSignal(request.signal, "streaming", provider);
        linked = createLinkedAbortController(parentSignal);
        const signal = linked.controller.signal;
        for (const value of request.responseSensitiveValues ?? []) {
          safety.registerResponseSensitive(value);
        }
        safety.registerDiagnosticSensitive(request.prompt);
        if (request.instructions !== undefined) {
          safety.registerDiagnosticSensitive(request.instructions);
        }
        signal.throwIfAborted();
        const workspace = request.workspace === undefined
          ? undefined
          : await raceWithCancellation(preflightWorkspace(provider, request.workspace), signal);
        signal.throwIfAborted();
        const { runtime, responseSensitiveValues } = await runtimeForOperation(
          deps,
          internals,
          provider,
          request.model,
          "streaming",
          signal,
          workspace,
        );
        for (const value of responseSensitiveValues) safety.registerResponseSensitive(value);
        signal.throwIfAborted();
        const input = {
          prompt: request.prompt,
          ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
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
            model: request.model,
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
        let rawText = "";
        while (true) {
          const next = Promise.resolve().then(() => iterator!.next());
          pendingProviderWork = next;
          const step = await raceWithCancellation(next, signal);
          pendingProviderWork = undefined;
          if (step.done) break;
          if (typeof step.value !== "string") throw new Error("invalid provider delta");
          rawText += step.value;
          const checked = safety.checkStreamingDelta(step.value);
          if (!checked.safe) throw new LlmNowError("UNSAFE_RESPONSE", "streaming", provider);
          await awaitDeltaHandler(onTextDelta, checked.delta, signal, provider);
        }
        const final = safety.checkBufferedResponse(rawText);
        if (!final.safe) throw new LlmNowError("UNSAFE_RESPONSE", "streaming", provider);
        failed = false;
        return Object.freeze({
          provider,
          model: request.model,
          delivery: stream.delivery,
          text: final.text,
        });
      } catch (error) {
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
          const cleanup = finalizeIterator(iterator)?.then(
            () => undefined,
            () => undefined,
          );
          const mode = provider !== undefined && isCliProvider(provider) ? "full" : "bounded";
          await settleOperation(pendingProviderWork, mode, internals.settlementTimeoutMs);
          await settleOperation(cleanup, mode, internals.settlementTimeoutMs);
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

export const CORE_PROVIDER_IDS = BYOK_PROVIDER_IDS;

import {
  BYOK_API_KEY_ENV_VARS,
  type ByokEnvironment,
  type ByokModelOption,
  type ByokProviderConfig,
  type ByokProviderId,
  type ByokProviderRuntime,
} from "@swartzrock/byok-runtime";
import {
  createByokNodeProvider,
  findAvailableProviders,
} from "@swartzrock/byok-runtime/node";

export type RuntimeStage = "discovery" | "model-list" | "generation";

export class RuntimeStageError extends Error {
  constructor(
    readonly stage: RuntimeStage,
    readonly provider: ByokProviderId | null,
    message: string,
  ) {
    super(`${stage}${provider ? ` (${provider})` : ""}: ${message}`);
    this.name = "RuntimeStageError";
  }
}

type FindProviders = typeof findAvailableProviders;
type CreateProvider = typeof createByokNodeProvider;

export interface RuntimeGatewayDependencies {
  env: ByokEnvironment;
  findProviders?: FindProviders;
  createProvider?: CreateProvider;
}

export interface RuntimeGateway {
  discover(): Promise<ByokProviderId[]>;
  listModels(provider: ByokProviderId): Promise<ByokModelOption[]>;
  generate(
    provider: ByokProviderId,
    model: string | null,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string>;
}

function providerConfig(
  provider: ByokProviderId,
  model: string | null,
  env: ByokEnvironment,
): ByokProviderConfig {
  switch (provider) {
    case "ollama":
    case "lm-studio":
      return { provider, model: model ?? "" };
    case "codex-cli":
      return {
        provider,
        command: "codex",
        ...(model === null ? {} : { model }),
      };
    case "claude-cli":
      return {
        provider,
        command: "claude",
        ...(model === null ? {} : { model }),
      };
    case "anthropic":
    case "openai":
    case "google":
    case "xai":
    case "openrouter":
    case "groq":
    case "mistral":
    case "deepseek":
    case "deepinfra":
      return {
        provider,
        credential: { source: "env", env },
        model: model ?? "",
      };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redact(message: string, env: ByokEnvironment): string {
  const values = [...new Set(
    BYOK_API_KEY_ENV_VARS
      .map((name) => env[name])
      .filter((value): value is string => Boolean(value)),
  )].sort((left, right) => right.length - left.length);
  return values.reduce(
    (redacted, value) => redacted.replaceAll(value, "[REDACTED]"),
    message,
  );
}

export function createRuntimeGateway(deps: RuntimeGatewayDependencies): RuntimeGateway {
  const findProviders = deps.findProviders ?? findAvailableProviders;
  const createProvider: CreateProvider = deps.createProvider ?? createByokNodeProvider;

  function runtime(provider: ByokProviderId, model: string | null): ByokProviderRuntime {
    return createProvider(providerConfig(provider, model, deps.env));
  }

  return {
    async discover() {
      try {
        return await findProviders({ env: deps.env });
      } catch (error) {
        throw new RuntimeStageError("discovery", null, redact(errorMessage(error), deps.env));
      }
    },

    async listModels(provider) {
      try {
        return await runtime(provider, null).listModels();
      } catch (error) {
        throw new RuntimeStageError("model-list", provider, redact(errorMessage(error), deps.env));
      }
    },

    async generate(provider, model, prompt, signal) {
      try {
        const result = await runtime(provider, model).generateText({ prompt }, signal);
        return result.text;
      } catch (error) {
        throw new RuntimeStageError("generation", provider, redact(errorMessage(error), deps.env));
      }
    },
  };
}

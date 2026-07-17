import {
  BYOK_API_KEY_ENV_VARS,
  BYOK_PROVIDER_API_KEY_ENV_VARS,
  type ByokCloudProviderId,
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
import {
  createBunCredentialVault,
  createCredentialResolver,
  createSensitiveValueRegistry,
  type CredentialResolver,
  type SensitiveValueRegistry,
} from "./credentials.ts";

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
  credentialResolver?: CredentialResolver;
  sensitive?: SensitiveValueRegistry;
}

export interface RuntimeGateway {
  discover(): Promise<ByokProviderId[]>;
  listModels(provider: ByokProviderId): Promise<ByokModelOption[]>;
  validateCredential(
    provider: ByokCloudProviderId,
    apiKey: string,
  ): Promise<ByokModelOption[]>;
  generate(
    provider: ByokProviderId,
    model: string | null,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string>;
}

async function providerConfig(
  provider: ByokProviderId,
  model: string | null,
  credentialResolver: CredentialResolver,
): Promise<ByokProviderConfig> {
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
      {
        const credential = await credentialResolver.resolve(provider);
        if (credential.source === "missing") {
          const names = BYOK_PROVIDER_API_KEY_ENV_VARS[provider].join(" or ");
          throw new Error(`missing credential; set ${names}`);
        }
        return { provider, apiKey: credential.apiKey, model: model ?? "" };
      }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRuntimeGateway(deps: RuntimeGatewayDependencies): RuntimeGateway {
  const findProviders = deps.findProviders ?? findAvailableProviders;
  const createProvider: CreateProvider = deps.createProvider ?? createByokNodeProvider;
  const sensitive = deps.sensitive ?? createSensitiveValueRegistry();
  for (const name of BYOK_API_KEY_ENV_VARS) {
    const value = deps.env[name];
    if (value) sensitive.register(value);
  }
  const credentialResolver = deps.credentialResolver ?? createCredentialResolver({
    env: deps.env,
    vault: createBunCredentialVault(),
    vaultEnabled: false,
    sensitive,
  });
  const cloudProviders = Object.keys(
    BYOK_PROVIDER_API_KEY_ENV_VARS,
  ) as ByokCloudProviderId[];

  async function runtime(
    provider: ByokProviderId,
    model: string | null,
  ): Promise<ByokProviderRuntime> {
    return createProvider(await providerConfig(provider, model, credentialResolver));
  }

  return {
    async discover() {
      try {
        const providers = [...await findProviders({ env: deps.env })];
        const available = new Set(providers);
        let vaultFailure: unknown;
        for (const provider of cloudProviders) {
          if (available.has(provider)) continue;
          try {
            const credential = await credentialResolver.resolve(provider);
            if (credential.source !== "missing") {
              providers.push(provider);
              available.add(provider);
            }
          } catch (error) {
            vaultFailure = error;
            break;
          }
        }
        if (providers.length === 0 && vaultFailure !== undefined) throw vaultFailure;
        return providers;
      } catch (error) {
        throw new RuntimeStageError("discovery", null, sensitive.redact(errorMessage(error)));
      }
    },

    async listModels(provider) {
      try {
        return await (await runtime(provider, null)).listModels();
      } catch (error) {
        throw new RuntimeStageError("model-list", provider, sensitive.redact(errorMessage(error)));
      }
    },

    async validateCredential(provider, apiKey) {
      sensitive.register(apiKey);
      try {
        return await createProvider({ provider, apiKey, model: "" }).listModels();
      } catch (error) {
        throw new RuntimeStageError("model-list", provider, sensitive.redact(errorMessage(error)));
      }
    },

    async generate(provider, model, prompt, signal) {
      try {
        const result = await (await runtime(provider, model)).generateText({ prompt }, signal);
        return result.text;
      } catch (error) {
        throw new RuntimeStageError("generation", provider, sensitive.redact(errorMessage(error)));
      }
    },
  };
}

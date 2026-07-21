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
import type {
  CredentialResolver,
  ResolvedCredential,
  SensitiveValueRegistry,
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
const CLOUD_PROVIDERS = Object.keys(
  BYOK_PROVIDER_API_KEY_ENV_VARS,
) as ByokCloudProviderId[];

function isCloudProvider(provider: ByokProviderId): provider is ByokCloudProviderId {
  return CLOUD_PROVIDERS.includes(provider as ByokCloudProviderId);
}

export interface RuntimeGatewayDependencies {
  env: ByokEnvironment;
  findProviders?: FindProviders;
  createProvider?: CreateProvider;
  credentialResolver: CredentialResolver;
  sensitive: SensitiveValueRegistry;
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
  resolveCredential: (provider: ByokCloudProviderId) => Promise<ResolvedCredential>,
): Promise<ByokProviderConfig> {
  if (isCloudProvider(provider)) {
    const credential = await resolveCredential(provider);
    if (credential.source === "missing") {
      const names = BYOK_PROVIDER_API_KEY_ENV_VARS[provider].join(" or ");
      throw new Error(`missing credential; set ${names}`);
    }
    if (credential.source === "unavailable") {
      const names = BYOK_PROVIDER_API_KEY_ENV_VARS[provider].join(" or ");
      throw new Error(`native credential storage unavailable on this target; set ${names}`);
    }
    return { provider, apiKey: credential.apiKey, model: model ?? "" };
  }

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
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRuntimeGateway(deps: RuntimeGatewayDependencies): RuntimeGateway {
  const findProviders = deps.findProviders ?? findAvailableProviders;
  const createProvider: CreateProvider = deps.createProvider ?? createByokNodeProvider;
  const sensitive = deps.sensitive;
  for (const name of BYOK_API_KEY_ENV_VARS) {
    const value = deps.env[name];
    if (value) sensitive.register(value);
  }
  const credentialResolver = deps.credentialResolver;

  async function resolveCredential(provider: ByokCloudProviderId) {
    const credential = await credentialResolver.resolve(provider);
    if (credential.source === "environment" || credential.source === "vault") {
      sensitive.register(credential.apiKey);
    }
    return credential;
  }

  async function runtime(
    provider: ByokProviderId,
    model: string | null,
  ): Promise<ByokProviderRuntime> {
    return createProvider(await providerConfig(provider, model, resolveCredential));
  }

  return {
    async discover() {
      try {
        const providers = [...await findProviders({ env: deps.env })];
        const available = new Set(providers);
        for (const provider of CLOUD_PROVIDERS) {
          if (available.has(provider)) continue;
          try {
            const credential = await resolveCredential(provider);
            if (credential.source === "environment" || credential.source === "vault") {
              providers.push(provider);
            }
          } catch (error) {
            if (providers.length === 0) throw error;
            break;
          }
        }
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

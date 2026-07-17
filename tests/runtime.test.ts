import { describe, expect, test } from "bun:test";
import {
  BYOK_API_KEY_ENV_VARS,
  BYOK_PROVIDER_IDS,
  type ByokEnvironment,
  type ByokModelOption,
  type ByokProviderConfig,
  type ByokProviderId,
  type ByokProviderRuntime,
} from "@swartzrock/byok-runtime";
import {
  createBunCredentialVault,
  createCredentialResolver,
  createSensitiveValueRegistry,
} from "../src/credentials.ts";
import {
  RuntimeStageError,
  createRuntimeGateway,
} from "../src/runtime.ts";

const providerIds: ByokProviderId[] = [...BYOK_PROVIDER_IDS];

function runtime(overrides: Partial<ByokProviderRuntime> = {}): ByokProviderRuntime {
  return {
    id: "ollama",
    label: "Fake",
    requiresNetwork: false,
    requiresDownload: false,
    testConnection: async () => ({ ok: true, message: "ok" }),
    listModels: async () => [],
    generateText: async () => ({ text: "generated" }),
    ...overrides,
  };
}

describe("runtime gateway", () => {
  test("preserves runtime discovery order without probing providers itself", async () => {
    let calls = 0;
    const gateway = createRuntimeGateway({
      env: {},
      findProviders: async () => {
        calls += 1;
        return providerIds;
      },
    });

    expect(await gateway.discover()).toEqual(providerIds);
    expect(calls).toBe(1);
  });

  test("maps every provider class to public runtime config", async () => {
    const env: ByokEnvironment = Object.fromEntries(
      BYOK_API_KEY_ENV_VARS.map((name) => [name, `${name}-secret`]),
    );
    const configs: ByokProviderConfig[] = [];
    const gateway = createRuntimeGateway({
      env,
      createProvider: (config) => {
        configs.push(config);
        return runtime({ id: config.provider });
      },
    });

    for (const provider of providerIds) await gateway.listModels(provider);

    expect(configs).toEqual([
      { provider: "anthropic", apiKey: "ANTHROPIC_API_KEY-secret", model: "" },
      { provider: "openai", apiKey: "OPENAI_API_KEY-secret", model: "" },
      { provider: "google", apiKey: "GOOGLE_API_KEY-secret", model: "" },
      { provider: "xai", apiKey: "XAI_API_KEY-secret", model: "" },
      { provider: "openrouter", apiKey: "OPENROUTER_API_KEY-secret", model: "" },
      { provider: "groq", apiKey: "GROQ_API_KEY-secret", model: "" },
      { provider: "mistral", apiKey: "MISTRAL_API_KEY-secret", model: "" },
      { provider: "deepseek", apiKey: "DEEPSEEK_API_KEY-secret", model: "" },
      { provider: "deepinfra", apiKey: "DEEPINFRA_TOKEN-secret", model: "" },
      { provider: "ollama", model: "" },
      { provider: "lm-studio", model: "" },
      { provider: "codex-cli", command: "codex" },
      { provider: "claude-cli", command: "claude" },
    ]);
  });

  test("merges vault-only cloud providers without reading vault for environment providers", async () => {
    const calls: string[] = [];
    const sensitive = createSensitiveValueRegistry();
    const vault = createBunCredentialVault({
      get: async ({ name }) => {
        calls.push(name);
        return name === "api-key:openai" ? "stored-openai" : null;
      },
      set: async () => {},
      delete: async () => false,
    });
    const env = { ANTHROPIC_API_KEY: "env-anthropic" };
    const gateway = createRuntimeGateway({
      env,
      sensitive,
      credentialResolver: createCredentialResolver({
        env,
        vault,
        vaultEnabled: true,
        sensitive,
      }),
      findProviders: async () => ["anthropic", "ollama"],
    });

    expect(await gateway.discover()).toEqual(["anthropic", "ollama", "openai"]);
    expect(calls).not.toContain("api-key:anthropic");
    expect(calls).toContain("api-key:openai");
  });

  test("does not retry another source after the selected environment key is rejected", async () => {
    let resolves = 0;
    let providers = 0;
    const gateway = createRuntimeGateway({
      env: { OPENAI_API_KEY: "selected-env-secret" },
      credentialResolver: {
        resolve: async () => {
          resolves += 1;
          return {
            source: "environment" as const,
            apiKey: "selected-env-secret",
            envName: "OPENAI_API_KEY" as const,
          };
        },
      },
      createProvider: (config) => {
        providers += 1;
        expect(config).toEqual({
          provider: "openai",
          apiKey: "selected-env-secret",
          model: "",
        });
        return runtime({
          listModels: async () => {
            throw new Error("rejected selected-env-secret");
          },
        });
      },
    });

    expect(gateway.listModels("openai")).rejects.toThrow("[REDACTED]");
    expect(resolves).toBe(1);
    expect(providers).toBe(1);
  });

  test("validates and redacts the exact candidate despite an environment override", async () => {
    const configs: ByokProviderConfig[] = [];
    const gateway = createRuntimeGateway({
      env: { OPENAI_API_KEY: "environment-secret" },
      createProvider: (config) => {
        configs.push(config);
        return runtime({
          listModels: async () => {
            throw new Error("provider echoed candidate-secret");
          },
        });
      },
    });

    expect(gateway.validateCredential("openai", "candidate-secret")).rejects.toThrow(
      "provider echoed [REDACTED]",
    );
    expect(configs).toEqual([{
      provider: "openai",
      apiKey: "candidate-secret",
      model: "",
    }]);
  });

  test("retains the failing stage and redacts environment values", async () => {
    const credentials = BYOK_API_KEY_ENV_VARS.map((name, index) => ({
      name,
      secret: `${name}-secret-${index}`,
    }));
    const secrets = credentials.map(({ secret }) => secret);
    const ordinaryEnvironmentValue = "/custom/bin";
    const env = {
      ...Object.fromEntries(
        credentials.map(({ name, secret }) => [name, secret]),
      ),
      PATH: ordinaryEnvironmentValue,
    };
    const gateway = createRuntimeGateway({
      env,
      createProvider: () =>
        runtime({
          listModels: async () => {
            throw new Error(
              `upstream rejected ${secrets.join(" ")} from ${ordinaryEnvironmentValue}`,
            );
          },
        }),
    });

    try {
      await gateway.listModels("openai");
      throw new Error("expected listModels to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeStageError);
      expect(error).toMatchObject({ stage: "model-list", provider: "openai" });
      for (const secret of secrets) expect(String(error)).not.toContain(secret);
      expect(String(error)).toContain("[REDACTED]");
      expect(String(error)).toContain(ordinaryEnvironmentValue);
    }
  });
});

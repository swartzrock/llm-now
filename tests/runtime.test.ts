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
  type RuntimeGatewayDependencies,
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

function createTestGateway(
  deps: Omit<RuntimeGatewayDependencies, "credentialResolver" | "sensitive">
    & Partial<Pick<RuntimeGatewayDependencies, "credentialResolver" | "sensitive">>,
) {
  const sensitive = deps.sensitive ?? createSensitiveValueRegistry();
  const credentialResolver = deps.credentialResolver ?? createCredentialResolver({
    env: deps.env,
    vault: createBunCredentialVault({
      get: async () => null,
      set: async () => {},
      delete: async () => false,
    }),
    vaultEnabled: false,
  });
  return createRuntimeGateway({ ...deps, sensitive, credentialResolver });
}

describe("runtime gateway", () => {
  test("preserves runtime discovery order without probing providers itself", async () => {
    let calls = 0;
    const gateway = createTestGateway({
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
    const gateway = createTestGateway({
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
    const gateway = createTestGateway({
      env,
      sensitive,
      credentialResolver: createCredentialResolver({
        env,
        vault,
        vaultEnabled: true,
      }),
      findProviders: async () => ["anthropic", "ollama"],
    });

    expect(await gateway.discover()).toEqual(["anthropic", "ollama", "openai"]);
    expect(calls).not.toContain("api-key:anthropic");
    expect(calls).toContain("api-key:openai");
  });

  test("reuses one successful vault read across discovery, listing, and generation", async () => {
    const vaultReads: string[] = [];
    const configs: ByokProviderConfig[] = [];
    const sensitive = createSensitiveValueRegistry();
    const env = {};
    const gateway = createTestGateway({
      env,
      sensitive,
      credentialResolver: createCredentialResolver({
        env,
        vaultEnabled: true,
        vault: createBunCredentialVault({
          get: async ({ name }) => {
            vaultReads.push(name);
            return name === "api-key:openai" ? "stored-openai" : null;
          },
          set: async () => {},
          delete: async () => false,
        }),
      }),
      findProviders: async () => [],
      createProvider: (config) => {
        configs.push(config);
        return runtime({ id: config.provider });
      },
    });

    expect(await gateway.discover()).toEqual(["openai"]);
    await gateway.listModels("openai");
    await gateway.generate("openai", "gpt-test", "hello");
    expect(vaultReads).toHaveLength(BYOK_PROVIDER_IDS.length - 4);
    expect(vaultReads.filter((name) => name === "api-key:openai")).toHaveLength(1);
    expect(configs).toEqual([
      { provider: "openai", apiKey: "stored-openai", model: "" },
      { provider: "openai", apiKey: "stored-openai", model: "gpt-test" },
    ]);
  });

  test("preserves usable providers on vault failure and fails when none are usable", async () => {
    const cause = new Error("backend detail");
    const resolver = createCredentialResolver({
      env: {},
      vaultEnabled: true,
      vault: createBunCredentialVault({
        get: async () => {
          throw cause;
        },
        set: async () => {},
        delete: async () => false,
      }),
    });

    const degraded = createTestGateway({
      env: {},
      credentialResolver: resolver,
      findProviders: async () => ["ollama"],
    });
    expect(await degraded.discover()).toEqual(["ollama"]);

    const failed = createTestGateway({
      env: {},
      credentialResolver: createCredentialResolver({
        env: {},
        vaultEnabled: true,
        vault: createBunCredentialVault({
          get: async () => {
            throw cause;
          },
          set: async () => {},
          delete: async () => false,
        }),
      }),
      findProviders: async () => [],
    });
    try {
      await failed.discover();
      throw new Error("expected discovery to fail");
    } catch (error) {
      expect(error).toMatchObject({ stage: "discovery", provider: null });
      expect(String(error)).not.toContain(cause.message);
    }
  });

  test("redacts a vault-selected key and never constructs an alternate provider", async () => {
    let vaultReads = 0;
    let providerCalls = 0;
    const gateway = createTestGateway({
      env: {},
      credentialResolver: createCredentialResolver({
        env: {},
        vaultEnabled: true,
        vault: createBunCredentialVault({
          get: async () => {
            vaultReads += 1;
            return "stored-openai";
          },
          set: async () => {},
          delete: async () => false,
        }),
      }),
      createProvider: (config) => {
        providerCalls += 1;
        expect(config).toEqual({ provider: "openai", apiKey: "stored-openai", model: "" });
        return runtime({
          listModels: async () => {
            throw new Error("rejected stored-openai");
          },
        });
      },
    });

    await expect(gateway.listModels("openai")).rejects.toThrow("rejected [REDACTED]");
    expect(vaultReads).toBe(1);
    expect(providerCalls).toBe(1);
  });

  test("distinguishes missing credentials from disabled native storage", async () => {
    let providerCalls = 0;
    const disabled = createTestGateway({
      env: {},
      createProvider: () => {
        providerCalls += 1;
        return runtime();
      },
    });
    await expect(disabled.listModels("openai")).rejects.toThrow(
      "native credential storage unavailable on this target; set OPENAI_API_KEY",
    );

    const missing = createTestGateway({
      env: {},
      credentialResolver: createCredentialResolver({
        env: {},
        vaultEnabled: true,
        vault: createBunCredentialVault({
          get: async () => null,
          set: async () => {},
          delete: async () => false,
        }),
      }),
      createProvider: () => {
        providerCalls += 1;
        return runtime();
      },
    });
    await expect(missing.listModels("openai")).rejects.toThrow(
      "missing credential; set OPENAI_API_KEY",
    );
    expect(providerCalls).toBe(0);
  });

  test("does not retry another source after the selected environment key is rejected", async () => {
    let vaultReads = 0;
    let providers = 0;
    const env = { OPENAI_API_KEY: "selected-env-secret" };
    const sensitive = createSensitiveValueRegistry();
    const gateway = createTestGateway({
      env,
      sensitive,
      credentialResolver: createCredentialResolver({
        env,
        vaultEnabled: true,
        vault: createBunCredentialVault({
          get: async () => {
            vaultReads += 1;
            return "valid-vault-fallback";
          },
          set: async () => {},
          delete: async () => false,
        }),
      }),
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
    expect(vaultReads).toBe(0);
    expect(providers).toBe(1);
  });

  test("validates and redacts the exact candidate despite an environment override", async () => {
    const configs: ByokProviderConfig[] = [];
    const gateway = createTestGateway({
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
    const gateway = createTestGateway({
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

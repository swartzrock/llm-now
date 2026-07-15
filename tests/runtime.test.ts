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
    const env: ByokEnvironment = { OPENAI_API_KEY: "secret" };
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
      { provider: "anthropic", credential: { source: "env", env }, model: "" },
      { provider: "openai", credential: { source: "env", env }, model: "" },
      { provider: "google", credential: { source: "env", env }, model: "" },
      { provider: "xai", credential: { source: "env", env }, model: "" },
      { provider: "openrouter", credential: { source: "env", env }, model: "" },
      { provider: "groq", credential: { source: "env", env }, model: "" },
      { provider: "mistral", credential: { source: "env", env }, model: "" },
      { provider: "deepseek", credential: { source: "env", env }, model: "" },
      { provider: "deepinfra", credential: { source: "env", env }, model: "" },
      { provider: "ollama", model: "" },
      { provider: "lm-studio", model: "" },
      { provider: "codex-cli", command: "codex" },
      { provider: "claude-cli", command: "claude" },
    ]);
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

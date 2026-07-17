import { describe, expect, test } from "bun:test";
import {
  BYOK_PROVIDER_API_KEY_ENV_VARS,
  type ByokEnvironment,
} from "@swartzrock/byok-runtime";
import {
  CredentialVaultError,
  NATIVE_VAULT_SERVICE,
  createBunCredentialVault,
  createCredentialResolver,
  createSensitiveValueRegistry,
  isNativeVaultEnabled,
  nativeVaultName,
  type NativeSecretStore,
} from "../src/credentials.ts";

function memoryStore(overrides: Partial<NativeSecretStore> = {}): NativeSecretStore {
  return {
    get: async () => null,
    set: async () => {},
    delete: async () => false,
    ...overrides,
  };
}

describe("native credential vault", () => {
  test("uses one stable provider-scoped record and Bun's object API", async () => {
    const calls: unknown[] = [];
    const store = memoryStore({
      get: async (options) => {
        calls.push(["get", options]);
        return "stored-secret";
      },
      set: async (options) => {
        calls.push(["set", options]);
      },
      delete: async (options) => {
        calls.push(["delete", options]);
        return true;
      },
    });
    const vault = createBunCredentialVault(store);

    expect(await vault.get("openai")).toBe("stored-secret");
    await vault.set("openai", "replacement");
    expect(await vault.delete("openai")).toBe(true);

    expect(calls).toEqual([
      ["get", { service: NATIVE_VAULT_SERVICE, name: "api-key:openai" }],
      ["set", {
        service: NATIVE_VAULT_SERVICE,
        name: "api-key:openai",
        value: "replacement",
      }],
      ["delete", { service: NATIVE_VAULT_SERVICE, name: "api-key:openai" }],
    ]);
    expect(nativeVaultName("google")).toBe("api-key:google");
  });

  test("rejects blank set before Bun can interpret it as deletion", async () => {
    let sets = 0;
    const vault = createBunCredentialVault(memoryStore({
      set: async () => {
        sets += 1;
      },
    }));

    expect(vault.set("openai", "")).rejects.toThrow("must not be blank");
    expect(sets).toBe(0);
  });

  test("keeps missing outcomes separate and wraps rejected operations", async () => {
    const missing = createBunCredentialVault(memoryStore());
    expect(await missing.get("openai")).toBeNull();
    expect(await missing.delete("openai")).toBe(false);

    const cause = new Error("backend detail should remain a cause");
    const failing = createBunCredentialVault(memoryStore({
      get: async () => {
        throw cause;
      },
    }));
    try {
      await failing.get("openai");
      throw new Error("expected get to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialVaultError);
      expect(error).toMatchObject({ operation: "get", provider: "openai", cause });
      expect(String(error)).not.toContain(cause.message);
    }
  });

  test("defines a record for every cloud provider and starts target support disabled", () => {
    expect(Object.keys(BYOK_PROVIDER_API_KEY_ENV_VARS).map((id) => nativeVaultName(
      id as keyof typeof BYOK_PROVIDER_API_KEY_ENV_VARS,
    ))).toEqual([
      "api-key:anthropic",
      "api-key:openai",
      "api-key:google",
      "api-key:xai",
      "api-key:openrouter",
      "api-key:groq",
      "api-key:mistral",
      "api-key:deepseek",
      "api-key:deepinfra",
    ]);
    expect(isNativeVaultEnabled({
      bunVersion: "1.3.14",
      platform: "darwin",
      arch: "arm64",
    })).toBe(false);
  });
});

describe("credential resolution and redaction", () => {
  test("uses the first nonempty provider environment value without reading the vault", async () => {
    let gets = 0;
    const env: ByokEnvironment = {
      GOOGLE_API_KEY: "google-secret",
      GEMINI_API_KEY: "gemini-secret",
    };
    const sensitive = createSensitiveValueRegistry();
    const resolver = createCredentialResolver({
      env,
      vaultEnabled: true,
      vault: {
        ...createBunCredentialVault(memoryStore()),
        get: async () => {
          gets += 1;
          return "vault-secret";
        },
      },
      sensitive,
    });

    expect(await resolver.resolve("google")).toEqual({
      source: "environment",
      apiKey: "google-secret",
      envName: "GOOGLE_API_KEY",
    });
    expect(gets).toBe(0);
    expect(sensitive.redact("google-secret gemini-secret vault-secret")).toBe(
      "[REDACTED] gemini-secret vault-secret",
    );
  });

  test("treats empty environment values as absent and resolves one vault fallback", async () => {
    let gets = 0;
    const sensitive = createSensitiveValueRegistry();
    const resolver = createCredentialResolver({
      env: { OPENAI_API_KEY: "" },
      vaultEnabled: true,
      vault: {
        ...createBunCredentialVault(memoryStore()),
        get: async (provider) => {
          gets += 1;
          expect(provider).toBe("openai");
          return "vault-secret";
        },
      },
      sensitive,
    });

    expect(await resolver.resolve("openai")).toEqual({
      source: "vault",
      apiKey: "vault-secret",
    });
    expect(gets).toBe(1);
    expect(sensitive.redact("upstream echoed vault-secret")).toBe(
      "upstream echoed [REDACTED]",
    );
  });

  test("returns missing without a vault read when target support is disabled", async () => {
    let gets = 0;
    const resolver = createCredentialResolver({
      env: {},
      vaultEnabled: false,
      vault: {
        ...createBunCredentialVault(memoryStore()),
        get: async () => {
          gets += 1;
          return "vault-secret";
        },
      },
      sensitive: createSensitiveValueRegistry(),
    });

    expect(await resolver.resolve("openai")).toEqual({ source: "missing" });
    expect(gets).toBe(0);
  });

  test("redacts overlapping registered values longest-first", () => {
    const sensitive = createSensitiveValueRegistry(["secret", "secret-long"]);
    sensitive.register("another");

    expect(sensitive.redact("secret-long secret another")).toBe(
      "[REDACTED] [REDACTED] [REDACTED]",
    );
  });
});

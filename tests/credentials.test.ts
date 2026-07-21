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

  test("wraps rejected set and delete operations without exposing backend detail", async () => {
    for (const operation of ["set", "delete"] as const) {
      const cause = new Error(`${operation} backend detail`);
      const vault = createBunCredentialVault(memoryStore({
        [operation]: async () => {
          throw cause;
        },
      }));

      try {
        if (operation === "set") await vault.set("openai", "candidate");
        else await vault.delete("openai");
        throw new Error(`expected ${operation} to fail`);
      } catch (error) {
        expect(error).toBeInstanceOf(CredentialVaultError);
        expect(error).toMatchObject({ operation, provider: "openai", cause });
        expect(String(error)).not.toContain(cause.message);
      }
    }
  });

  test("defines a record for every cloud provider and enables a lifecycle-gated target", () => {
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
    })).toBe(true);
  });
});

describe("credential resolution and redaction", () => {
  test("uses the first nonempty provider environment value without reading the vault", async () => {
    let gets = 0;
    const env: ByokEnvironment = {
      GOOGLE_API_KEY: "google-secret",
      GEMINI_API_KEY: "gemini-secret",
    };
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
    });

    expect(await resolver.resolve("google")).toEqual({
      source: "environment",
      apiKey: "google-secret",
      envName: "GOOGLE_API_KEY",
    });
    expect(gets).toBe(0);
  });

  test("skips a blank primary alias and preserves the fallback value byte-for-byte", async () => {
    let gets = 0;
    const resolver = createCredentialResolver({
      env: { GOOGLE_API_KEY: "", GEMINI_API_KEY: "  gemini-secret  " },
      vaultEnabled: true,
      vault: {
        ...createBunCredentialVault(memoryStore()),
        get: async () => {
          gets += 1;
          return "vault-secret";
        },
      },
    });

    expect(await resolver.resolve("google")).toEqual({
      source: "environment",
      apiKey: "  gemini-secret  ",
      envName: "GEMINI_API_KEY",
    });
    expect(gets).toBe(0);
  });

  test("treats empty environment values as absent and resolves one vault fallback", async () => {
    let gets = 0;
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
    });

    expect(await resolver.resolve("openai")).toEqual({
      source: "vault",
      apiKey: "vault-secret",
    });
    expect(gets).toBe(1);
  });

  test("distinguishes a disabled target from an enabled vault with no record", async () => {
    let gets = 0;
    const disabled = createCredentialResolver({
      env: {},
      vaultEnabled: false,
      vault: {
        ...createBunCredentialVault(memoryStore()),
        get: async () => {
          gets += 1;
          return "vault-secret";
        },
      },
    });

    expect(await disabled.resolve("openai")).toEqual({
      source: "unavailable",
      reason: "target-disabled",
    });
    expect(gets).toBe(0);

    const missing = createCredentialResolver({
      env: {},
      vaultEnabled: true,
      vault: createBunCredentialVault(memoryStore()),
    });
    expect(await missing.resolve("openai")).toEqual({ source: "missing" });
  });

  test("invalidates a cached vault value after credential mutation", async () => {
    let value = "first-secret";
    let gets = 0;
    const resolver = createCredentialResolver({
      env: {},
      vaultEnabled: true,
      vault: {
        ...createBunCredentialVault(memoryStore()),
        get: async () => {
          gets += 1;
          return value;
        },
      },
    });

    expect(await resolver.resolve("openai")).toMatchObject({ apiKey: "first-secret" });
    value = "replacement-secret";
    expect(await resolver.resolve("openai")).toMatchObject({ apiKey: "first-secret" });
    resolver.invalidate?.("openai");
    expect(await resolver.resolve("openai")).toMatchObject({ apiKey: "replacement-secret" });
    expect(gets).toBe(2);
  });

  test("redacts overlapping registered values longest-first", () => {
    const sensitive = createSensitiveValueRegistry(["secret", "secret-long"]);
    sensitive.register("another");

    expect(sensitive.redact("secret-long secret another")).toBe(
      "[REDACTED] [REDACTED] [REDACTED]",
    );
  });
});

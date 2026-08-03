import { afterEach, describe, expect, test } from "bun:test";
import {
  BYOK_PROVIDER_API_KEY_ENV_VARS,
  type ByokEnvironment,
} from "@swartzrock/byok-runtime";
import {
  CredentialVaultError,
  NATIVE_VAULT_SERVICE,
  createBunCredentialVault,
  createCredentialResolver,
  createPersistenceBlocker,
  createSensitiveValueRegistry,
  isNativeVaultEnabled,
  nativeVaultName,
  withCredentialMutationLock,
  type NativeSecretStore,
} from "../src/credentials.ts";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

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
  test("separates source-aware persistence blocking from broad output redaction", () => {
    const blocker = createPersistenceBlocker({
      OPENAI_API_KEY: "x",
      ANTHROPIC_API_KEY: "12345678",
    });
    const sensitive = createSensitiveValueRegistry(["x", "12345678"]);

    expect(blocker.blocks("ordinary x prose")).toBe(false);
    expect(blocker.blocks("contains 12345678")).toBe(true);
    blocker.register("y", "validated");
    blocker.register("z", "vault");
    expect(blocker.blocks("contains y")).toBe(true);
    expect(blocker.blocks("contains z")).toBe(true);
    expect(sensitive.redact("ordinary x prose")).toBe("ordinary [REDACTED] prose");
  });

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

describe("credential mutation locks", () => {
  test("serializes the same provider across concurrent mutation attempts", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-credential-lock-"));
    temporaryDirectories.push(directory);
    const events: string[] = [];
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstMayExit = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });

    const first = withCredentialMutationLock(directory, "openai", async () => {
      events.push("first:entered");
      markFirstEntered();
      await firstMayExit;
      events.push("first:leaving");
    });
    await firstEntered;
    const second = withCredentialMutationLock(directory, "openai", async () => {
      events.push("second:entered");
    });
    await Bun.sleep(30);

    expect(events).toEqual(["first:entered"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "first:entered",
      "first:leaving",
      "second:entered",
    ]);
  });

  test("does not block mutations for different providers", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-credential-lock-"));
    temporaryDirectories.push(directory);
    let releaseOpenAi!: () => void;
    let markOpenAiEntered!: () => void;
    const openAiMayExit = new Promise<void>((resolve) => {
      releaseOpenAi = resolve;
    });
    const openAiEntered = new Promise<void>((resolve) => {
      markOpenAiEntered = resolve;
    });
    const openAi = withCredentialMutationLock(directory, "openai", async () => {
      markOpenAiEntered();
      await openAiMayExit;
    });
    await openAiEntered;

    let anthropicEntered = false;
    await withCredentialMutationLock(directory, "anthropic", async () => {
      anthropicEntered = true;
    });
    expect(anthropicEntered).toBe(true);
    releaseOpenAi();
    await openAi;
  });

  test("does not reclaim an active owner after the stale threshold", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-credential-lock-"));
    temporaryDirectories.push(directory);
    const events: string[] = [];
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstMayExit = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const options = {
      lockTimeoutMs: 250,
      retryDelayMs: 2,
      staleLockMs: 5,
    };

    const first = withCredentialMutationLock(directory, "openai", async () => {
      events.push("first:entered");
      markFirstEntered();
      await firstMayExit;
      events.push("first:leaving");
    }, options);
    await firstEntered;
    const second = withCredentialMutationLock(directory, "openai", async () => {
      events.push("second:entered");
    }, options);
    await Bun.sleep(30);

    expect(events).toEqual(["first:entered"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "first:entered",
      "first:leaving",
      "second:entered",
    ]);
  });

  test("serializes two waiters while reclaiming an orphaned lock", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-credential-lock-"));
    temporaryDirectories.push(directory);
    await mkdir(directory, { recursive: true });
    const lockPath = join(directory, "credential-openai.lock");
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 99_999_999, token: "orphaned-owner" }),
      { mode: 0o600 },
    );
    const epoch = new Date(0);
    await utimes(lockPath, epoch, epoch);

    const events: string[] = [];
    let releaseWinner!: () => void;
    let markWinnerEntered!: () => void;
    const winnerMayExit = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    const winnerEntered = new Promise<void>((resolve) => {
      markWinnerEntered = resolve;
    });
    const options = {
      lockTimeoutMs: 250,
      retryDelayMs: 2,
      staleLockMs: 5,
    };
    const contend = (label: string) =>
      withCredentialMutationLock(directory, "openai", async () => {
        events.push(`${label}:entered`);
        if (events.length === 1) {
          markWinnerEntered();
          await winnerMayExit;
          events.push(`${label}:leaving`);
        }
      }, options);

    const first = contend("first");
    const second = contend("second");
    await winnerEntered;
    await Bun.sleep(30);

    expect(events).toHaveLength(1);
    releaseWinner();
    await Promise.all([first, second]);
    expect(events).toHaveLength(3);
    expect(events.filter((event) => event.endsWith(":entered")).sort()).toEqual([
      "first:entered",
      "second:entered",
    ]);
  });

  test("releases an owned lock when the mutation throws", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-credential-lock-"));
    temporaryDirectories.push(directory);

    await expect(withCredentialMutationLock(directory, "openai", async () => {
      throw new Error("mutation failed");
    })).rejects.toThrow("mutation failed");

    let entered = false;
    await withCredentialMutationLock(directory, "openai", async () => {
      entered = true;
    });
    expect(entered).toBe(true);
  });
});

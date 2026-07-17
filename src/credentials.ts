import {
  BYOK_PROVIDER_API_KEY_ENV_VARS,
  type ByokCloudProviderId,
  type ByokEnvironment,
} from "@swartzrock/byok-runtime";

export const NATIVE_VAULT_SERVICE = "llm-now";

export type CredentialVaultOperation = "get" | "set" | "delete";

export class CredentialVaultError extends Error {
  constructor(
    readonly operation: CredentialVaultOperation,
    readonly provider: ByokCloudProviderId,
    override readonly cause: unknown,
  ) {
    super(`credential vault ${operation} (${provider}): unavailable`);
    this.name = "CredentialVaultError";
  }
}

export type NativeSecretStore = Pick<typeof Bun.secrets, "get" | "set" | "delete">;

export interface NativeSecretIdentity {
  service: string;
  name: string;
}

export interface NativeSecretAdapter {
  get(identity: NativeSecretIdentity): Promise<string | null>;
  set(identity: NativeSecretIdentity, value: string): Promise<void>;
  delete(identity: NativeSecretIdentity): Promise<boolean>;
}

export function createBunNativeSecretAdapter(
  store: NativeSecretStore = Bun.secrets,
): NativeSecretAdapter {
  return {
    get: (identity) => store.get(identity),
    set: async (identity, value) => {
      await store.set({ ...identity, value });
    },
    delete: (identity) => store.delete(identity),
  };
}

export interface CredentialVault {
  get(provider: ByokCloudProviderId): Promise<string | null>;
  set(provider: ByokCloudProviderId, value: string): Promise<void>;
  delete(provider: ByokCloudProviderId): Promise<boolean>;
}

export function nativeVaultName(provider: ByokCloudProviderId): string {
  return `api-key:${provider}`;
}

function nativeSecretIdentity(provider: ByokCloudProviderId) {
  return { service: NATIVE_VAULT_SERVICE, name: nativeVaultName(provider) };
}

export function createBunCredentialVault(
  store: NativeSecretStore = Bun.secrets,
): CredentialVault {
  const adapter = createBunNativeSecretAdapter(store);
  return {
    async get(provider) {
      try {
        return await adapter.get(nativeSecretIdentity(provider));
      } catch (error) {
        throw new CredentialVaultError("get", provider, error);
      }
    },

    async set(provider, value) {
      if (value.length === 0) throw new TypeError("credential must not be blank");
      try {
        await adapter.set(nativeSecretIdentity(provider), value);
      } catch (error) {
        throw new CredentialVaultError("set", provider, error);
      }
    },

    async delete(provider) {
      try {
        return await adapter.delete(nativeSecretIdentity(provider));
      } catch (error) {
        throw new CredentialVaultError("delete", provider, error);
      }
    },
  };
}

export interface SensitiveValueRegistry {
  register(value: string): void;
  redact(text: string): string;
}

export function createSensitiveValueRegistry(
  initialValues: readonly string[] = [],
): SensitiveValueRegistry {
  const values = new Set<string>();
  let sortedValues: string[] = [];
  const register = (value: string) => {
    if (value.length > 0 && !values.has(value)) {
      values.add(value);
      sortedValues = [...values].sort((left, right) => right.length - left.length);
    }
  };
  for (const value of initialValues) register(value);

  return {
    register,
    redact(text) {
      return sortedValues.reduce(
        (redacted, value) => redacted.replaceAll(value, "[REDACTED]"),
        text,
      );
    },
  };
}

export type ResolvedCredential =
  | {
    source: "environment";
    apiKey: string;
    envName: (typeof BYOK_PROVIDER_API_KEY_ENV_VARS)[ByokCloudProviderId][number];
  }
  | { source: "vault"; apiKey: string }
  | { source: "unavailable"; reason: "target-disabled" }
  | { source: "missing" };

export interface CredentialResolver {
  resolve(provider: ByokCloudProviderId): Promise<ResolvedCredential>;
  invalidate?(provider: ByokCloudProviderId): void;
}

export interface CredentialResolverDependencies {
  env: ByokEnvironment;
  vault: CredentialVault;
  vaultEnabled: boolean;
}

export function createCredentialResolver(
  deps: CredentialResolverDependencies,
): CredentialResolver {
  const vaultValues = new Map<ByokCloudProviderId, string>();
  return {
    async resolve(provider) {
      for (const envName of BYOK_PROVIDER_API_KEY_ENV_VARS[provider]) {
        const apiKey = deps.env[envName];
        if (apiKey) {
          return { source: "environment", apiKey, envName };
        }
      }

      if (!deps.vaultEnabled) {
        return { source: "unavailable", reason: "target-disabled" };
      }
      const cached = vaultValues.get(provider);
      if (cached !== undefined) return { source: "vault", apiKey: cached };
      const apiKey = await deps.vault.get(provider);
      if (apiKey === null) return { source: "missing" };
      vaultValues.set(provider, apiKey);
      return { source: "vault", apiKey };
    },
    invalidate(provider) {
      vaultValues.delete(provider);
    },
  };
}

export interface NativeVaultTarget {
  bunVersion: string;
  platform: NodeJS.Platform;
  arch: string;
}

export const NATIVE_VAULT_BUN_VERSION = "1.3.14";

export interface NativeVaultCompatibility extends NativeVaultTarget {
  id: "macos-x64" | "macos-arm64" | "linux-x64" | "linux-arm64" | "windows-x64";
  enabled: boolean;
}

export const NATIVE_VAULT_COMPATIBILITY: readonly NativeVaultCompatibility[] = [
  { id: "macos-x64", bunVersion: NATIVE_VAULT_BUN_VERSION, platform: "darwin", arch: "x64", enabled: true },
  { id: "macos-arm64", bunVersion: NATIVE_VAULT_BUN_VERSION, platform: "darwin", arch: "arm64", enabled: true },
  { id: "linux-x64", bunVersion: NATIVE_VAULT_BUN_VERSION, platform: "linux", arch: "x64", enabled: true },
  { id: "linux-arm64", bunVersion: NATIVE_VAULT_BUN_VERSION, platform: "linux", arch: "arm64", enabled: true },
  { id: "windows-x64", bunVersion: NATIVE_VAULT_BUN_VERSION, platform: "win32", arch: "x64", enabled: true },
];

export function isNativeVaultEnabled(target: NativeVaultTarget): boolean {
  return NATIVE_VAULT_COMPATIBILITY.some((candidate) =>
    candidate.enabled
    && candidate.bunVersion === target.bunVersion
    && candidate.platform === target.platform
    && candidate.arch === target.arch
  );
}

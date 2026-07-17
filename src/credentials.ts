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

interface NativeSecretIdentity {
  service: string;
  name: string;
}

interface NativeSecretValue extends NativeSecretIdentity {
  value: string;
}

export interface NativeSecretStore {
  get(options: NativeSecretIdentity): Promise<string | null>;
  set(options: NativeSecretValue): Promise<void>;
  delete(options: NativeSecretIdentity): Promise<boolean>;
}

export interface CredentialVault {
  get(provider: ByokCloudProviderId): Promise<string | null>;
  set(provider: ByokCloudProviderId, value: string): Promise<void>;
  delete(provider: ByokCloudProviderId): Promise<boolean>;
}

export function nativeVaultName(provider: ByokCloudProviderId): string {
  return `api-key:${provider}`;
}

function nativeSecretIdentity(provider: ByokCloudProviderId): NativeSecretIdentity {
  return { service: NATIVE_VAULT_SERVICE, name: nativeVaultName(provider) };
}

export function createBunCredentialVault(
  store: NativeSecretStore = Bun.secrets,
): CredentialVault {
  return {
    async get(provider) {
      try {
        return await store.get(nativeSecretIdentity(provider));
      } catch (error) {
        throw new CredentialVaultError("get", provider, error);
      }
    },

    async set(provider, value) {
      if (value.length === 0) throw new TypeError("credential must not be blank");
      try {
        await store.set({ ...nativeSecretIdentity(provider), value });
      } catch (error) {
        throw new CredentialVaultError("set", provider, error);
      }
    },

    async delete(provider) {
      try {
        return await store.delete(nativeSecretIdentity(provider));
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
  const register = (value: string) => {
    if (value.length > 0) values.add(value);
  };
  for (const value of initialValues) register(value);

  return {
    register,
    redact(text) {
      return [...values]
        .sort((left, right) => right.length - left.length)
        .reduce(
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
  | { source: "missing" };

export interface CredentialResolver {
  resolve(provider: ByokCloudProviderId): Promise<ResolvedCredential>;
}

export interface CredentialResolverDependencies {
  env: ByokEnvironment;
  vault: CredentialVault;
  vaultEnabled: boolean;
  sensitive: SensitiveValueRegistry;
}

export function createCredentialResolver(
  deps: CredentialResolverDependencies,
): CredentialResolver {
  return {
    async resolve(provider) {
      for (const envName of BYOK_PROVIDER_API_KEY_ENV_VARS[provider]) {
        const apiKey = deps.env[envName];
        if (apiKey) {
          deps.sensitive.register(apiKey);
          return { source: "environment", apiKey, envName };
        }
      }

      if (!deps.vaultEnabled) return { source: "missing" };
      const apiKey = await deps.vault.get(provider);
      if (apiKey === null) return { source: "missing" };
      deps.sensitive.register(apiKey);
      return { source: "vault", apiKey };
    },
  };
}

export interface NativeVaultTarget {
  bunVersion: string;
  platform: NodeJS.Platform;
  arch: string;
}

const NATIVE_VAULT_COMPATIBILITY: readonly NativeVaultTarget[] = [];

export function isNativeVaultEnabled(target: NativeVaultTarget): boolean {
  return NATIVE_VAULT_COMPATIBILITY.some((candidate) =>
    candidate.bunVersion === target.bunVersion
    && candidate.platform === target.platform
    && candidate.arch === target.arch
  );
}

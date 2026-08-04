import {
  BYOK_API_KEY_ENV_VARS,
  BYOK_PROVIDER_API_KEY_ENV_VARS,
  type ByokCloudProviderId,
  type ByokEnvironment,
} from "@swartzrock/byok-runtime";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

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

export interface CredentialMutationLockOptions {
  lockTimeoutMs?: number;
  retryDelayMs?: number;
  staleLockMs?: number;
}

export type CredentialMutationLock = <T>(
  directory: string,
  provider: ByokCloudProviderId,
  operation: () => Promise<T>,
) => Promise<T>;

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface CredentialLockOwner {
  pid: number;
  token: string;
}

function isCredentialLockOwner(value: unknown): value is CredentialLockOwner {
  if (typeof value !== "object" || value === null) return false;
  const owner = value as Record<string, unknown>;
  return typeof owner.pid === "number"
    && Number.isSafeInteger(owner.pid)
    && owner.pid > 0
    && typeof owner.token === "string"
    && owner.token.length > 0;
}

async function readCredentialLockOwner(
  lockPath: string,
): Promise<CredentialLockOwner | null> {
  try {
    const value: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    return isCredentialLockOwner(value) ? value : null;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }
}

async function withCredentialLockRecoveryGuard<T>(
  guardPath: string,
  operation: () => Promise<T>,
  lockTimeoutMs: number,
  retryDelayMs: number,
): Promise<T> {
  const startedAt = Date.now();
  while (true) {
    try {
      const handle = await open(guardPath, "wx", 0o600);
      await handle.close();
      break;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      if (Date.now() - startedAt >= lockTimeoutMs) {
        throw new Error(`timed out waiting for credential mutation lock recovery: ${guardPath}`);
      }
      await delay(retryDelayMs);
    }
  }

  try {
    return await operation();
  } finally {
    await unlink(guardPath).catch(() => undefined);
  }
}

export function resolveCredentialLockDirectory(home: string): string {
  return join(home, ".llm-now", "credential-locks");
}

export async function withCredentialMutationLock<T>(
  directory: string,
  provider: ByokCloudProviderId,
  operation: () => Promise<T>,
  options: CredentialMutationLockOptions = {},
): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);

  const lockPath = join(directory, `credential-${provider}.lock`);
  const recoveryGuardPath = `${lockPath}.recovery`;
  const lockTimeoutMs = options.lockTimeoutMs ?? 2_000;
  const retryDelayMs = options.retryDelayMs ?? 20;
  const staleLockMs = options.staleLockMs ?? 30_000;
  const startedAt = Date.now();
  const owner: CredentialLockOwner = {
    pid: process.pid,
    token: randomUUID(),
  };

  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(owner));
      } catch (error) {
        await unlink(lockPath).catch(() => undefined);
        throw error;
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      let lock;
      try {
        lock = await lstat(lockPath);
      } catch (statError) {
        if (hasErrorCode(statError, "ENOENT")) continue;
        throw statError;
      }
      if (!lock.isFile()) {
        throw new Error(`invalid credential mutation lock: ${lockPath}`);
      }
      if (Date.now() - lock.mtimeMs > staleLockMs) {
        let reclaimed = false;
        await withCredentialLockRecoveryGuard(
          recoveryGuardPath,
          async () => {
            let currentLock;
            try {
              currentLock = await lstat(lockPath);
            } catch (statError) {
              if (hasErrorCode(statError, "ENOENT")) return;
              throw statError;
            }
            if (!currentLock.isFile()) {
              throw new Error(`invalid credential mutation lock: ${lockPath}`);
            }
            if (Date.now() - currentLock.mtimeMs <= staleLockMs) return;
            const currentOwner = await readCredentialLockOwner(lockPath);
            if (currentOwner !== null && isProcessAlive(currentOwner.pid)) return;
            await unlink(lockPath).catch((unlinkError: unknown) => {
              if (!hasErrorCode(unlinkError, "ENOENT")) throw unlinkError;
            });
            reclaimed = true;
          },
          lockTimeoutMs,
          retryDelayMs,
        );
        if (reclaimed) continue;
      }
      if (Date.now() - startedAt >= lockTimeoutMs) {
        throw new Error(`timed out waiting for credential mutation lock: ${lockPath}`);
      }
      await delay(retryDelayMs);
    }
  }

  try {
    return await operation();
  } finally {
    await withCredentialLockRecoveryGuard(
      recoveryGuardPath,
      async () => {
        const currentOwner = await readCredentialLockOwner(lockPath);
        if (currentOwner?.token !== owner.token) return;
        await unlink(lockPath).catch(() => undefined);
      },
      lockTimeoutMs,
      retryDelayMs,
    );
  }
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

export type PersistenceCredentialSource = "environment" | "validated" | "vault";

export interface PersistenceBlocker {
  register(value: string, source: PersistenceCredentialSource): void;
  blocks(text: string): boolean;
}

const MINIMUM_ENVIRONMENT_BLOCKER_LENGTH = 8;

export function createPersistenceBlocker(
  env: ByokEnvironment = {},
): PersistenceBlocker {
  const values = new Set<string>();
  const register = (value: string, source: PersistenceCredentialSource): void => {
    if (
      value.length > 0
      && (source !== "environment" || value.length >= MINIMUM_ENVIRONMENT_BLOCKER_LENGTH)
    ) {
      values.add(value);
    }
  };
  for (const name of BYOK_API_KEY_ENV_VARS) {
    const value = env[name];
    if (value !== undefined) register(value, "environment");
  }

  return {
    register,
    blocks(text) {
      for (const value of values) {
        if (text.includes(value)) return true;
      }
      return false;
    },
  };
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
  { id: "macos-x64", bunVersion: NATIVE_VAULT_BUN_VERSION, platform: "darwin", arch: "x64", enabled: false },
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

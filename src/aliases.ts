import { isByokProviderId, type ByokEnvironment, type ByokProviderId } from "@swartzrock/byok-runtime";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { randomUUID } from "node:crypto";

const ALIAS_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DEFAULT_MODEL_PROVIDERS = new Set<ByokProviderId>(["codex-cli", "claude-cli"]);

export function isValidAliasName(name: string): boolean {
  return ALIAS_NAME.test(name);
}

export interface AliasRecord {
  provider: ByokProviderId;
  model: string | null;
}

export interface AliasDocument {
  version: 1;
  aliases: Record<string, AliasRecord>;
}

export interface AliasPathOptions {
  platform: NodeJS.Platform;
  home: string;
  env: ByokEnvironment;
}

export interface SaveAliasOptions {
  confirmOverwrite?: (name: string, current: AliasRecord) => Promise<boolean>;
  lockTimeoutMs?: number;
  retryDelayMs?: number;
  staleLockMs?: number;
}

export interface AliasStoreDependencies {
  rename?: typeof rename;
}

export class AliasStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AliasStoreError";
  }
}

export class AliasCollisionError extends AliasStoreError {
  constructor(name: string) {
    super(`alias already exists: ${name}`);
    this.name = "AliasCollisionError";
  }
}

export function resolveAliasPath(options: AliasPathOptions): string {
  if (options.platform === "win32") {
    const roaming = options.env.APPDATA && win32.isAbsolute(options.env.APPDATA)
      ? options.env.APPDATA
      : win32.join(options.home, "AppData", "Roaming");
    return win32.join(roaming, "llm-now", "aliases.json");
  }

  const config = options.env.XDG_CONFIG_HOME && isAbsolute(options.env.XDG_CONFIG_HOME)
    ? options.env.XDG_CONFIG_HOME
    : join(options.home, ".config");
  return join(config, "llm-now", "aliases.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function validateAliasRecord(value: unknown): value is AliasRecord {
  if (!isObject(value) || !hasExactlyKeys(value, ["model", "provider"])) return false;
  if (!isByokProviderId(value.provider)) return false;
  if (value.model === null) return DEFAULT_MODEL_PROVIDERS.has(value.provider);
  return typeof value.model === "string" && value.model.length > 0;
}

function validateDocument(value: unknown): value is AliasDocument {
  if (!isObject(value) || !hasExactlyKeys(value, ["aliases", "version"])) return false;
  if (value.version !== 1 || !isObject(value.aliases)) return false;

  return Object.entries(value.aliases).every(
    ([name, record]) => isValidAliasName(name) && validateAliasRecord(record),
  );
}

function emptyDocument(): AliasDocument {
  return { version: 1, aliases: {} };
}

export async function loadAliases(path: string): Promise<AliasDocument> {
  try {
    const parsed: unknown = JSON.parse(await Bun.file(path).text());
    if (!validateDocument(parsed)) throw new Error("invalid alias document schema");
    return parsed;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return emptyDocument();
    throw new AliasStoreError(`failed to load alias store: ${path}`, { cause: error });
  }
}

export async function resolveAlias(path: string, name: string): Promise<AliasRecord> {
  if (!isValidAliasName(name)) throw new AliasStoreError(`invalid alias name: ${name}`);
  const aliases = (await loadAliases(path)).aliases;
  if (!Object.hasOwn(aliases, name)) throw new AliasStoreError(`alias not found: ${name}`);
  const record = aliases[name];
  if (record === undefined) throw new AliasStoreError(`alias not found: ${name}`);
  return record;
}

function validateSaveInput(name: string, record: AliasRecord): void {
  if (!isValidAliasName(name)) throw new AliasStoreError(`invalid alias name: ${name}`);
  if (!validateAliasRecord({ provider: record.provider, model: record.model })) {
    throw new AliasStoreError(`invalid alias selection: ${name}`);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireLock(
  lockPath: string,
  options: Required<Pick<SaveAliasOptions, "lockTimeoutMs" | "retryDelayMs" | "staleLockMs">>,
): Promise<void> {
  const startedAt = Date.now();

  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
      } catch (error) {
        await unlink(lockPath).catch(() => undefined);
        throw error;
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;

      let lock;
      try {
        lock = await lstat(lockPath);
      } catch (statError) {
        if (hasErrorCode(statError, "ENOENT")) continue;
        throw statError;
      }
      if (!lock.isFile()) throw new AliasStoreError(`invalid alias lock: ${lockPath}`);

      if (Date.now() - lock.mtimeMs > options.staleLockMs) {
        await unlink(lockPath).catch((unlinkError: unknown) => {
          if (!hasErrorCode(unlinkError, "ENOENT")) {
            throw unlinkError;
          }
        });
        continue;
      }
      if (Date.now() - startedAt >= options.lockTimeoutMs) {
        throw new AliasStoreError(`timed out waiting for alias lock: ${lockPath}`);
      }
      await delay(options.retryDelayMs);
    }
  }
}

export async function saveAlias(
  path: string,
  name: string,
  record: AliasRecord,
  options: SaveAliasOptions = {},
  dependencies: AliasStoreDependencies = {},
): Promise<"saved" | "unchanged"> {
  validateSaveInput(name, record);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);

  const lockPath = `${path}.lock`;
  const lockOptions = {
    lockTimeoutMs: options.lockTimeoutMs ?? 2_000,
    retryDelayMs: options.retryDelayMs ?? 20,
    staleLockMs: options.staleLockMs ?? 30_000,
  };
  await acquireLock(lockPath, lockOptions);

  let temporaryPath: string | undefined;
  try {
    const document = await loadAliases(path);
    const current = Object.hasOwn(document.aliases, name) ? document.aliases[name] : undefined;
    if (current !== undefined) {
      if (options.confirmOverwrite === undefined) throw new AliasCollisionError(name);
      if (!(await options.confirmOverwrite(name, current))) return "unchanged";
    }

    const next: AliasDocument = {
      version: 1,
      aliases: {
        ...document.aliases,
        [name]: { provider: record.provider, model: record.model },
      },
    };
    temporaryPath = join(directory, `.aliases-${process.pid}-${randomUUID()}.tmp`);
    await Bun.write(temporaryPath, `${JSON.stringify(next, null, 2)}\n`);
    if (process.platform !== "win32") await chmod(temporaryPath, 0o600);
    await (dependencies.rename ?? rename)(temporaryPath, path);
    temporaryPath = undefined;
    return "saved";
  } finally {
    if (temporaryPath !== undefined) await unlink(temporaryPath).catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

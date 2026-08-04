import { isByokProviderId, type ByokEnvironment, type ByokProviderId } from "@swartzrock/byok-runtime";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import type { PersistenceBlocker } from "./credentials.ts";

const ALIAS_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_ALIAS_DIAGNOSTIC_VALUE_LENGTH = 128;
const DEFAULT_MODEL_PROVIDERS = new Set<ByokProviderId>(["codex-cli", "claude-cli"]);

export function isValidAliasName(name: string): boolean {
  return ALIAS_NAME.test(name);
}

export function normalizeAliasName(name: string): string {
  if (!isValidAliasName(name)) throw new AliasStoreError(`invalid alias name: ${name}`);
  return name.toLowerCase();
}

export interface AliasRecord {
  provider: ByokProviderId;
  model: string | null;
  instructions?: string;
}

export interface AliasDocumentV1 {
  version: 1;
  aliases: Record<string, AliasRecord>;
}

export interface AliasDocumentV2 {
  version: 2;
  aliases: Record<string, AliasRecord>;
}

export type AliasDocument = AliasDocumentV1 | AliasDocumentV2;

export interface AliasPathOptions {
  platform: NodeJS.Platform;
  home: string;
  env: ByokEnvironment;
}

export interface SaveAliasOptions {
  confirmOverwrite?: (name: string, current: AliasRecord | undefined) => Promise<boolean>;
  persistenceBlocker?: PersistenceBlocker;
  persistenceGuard?: <T>(operation: () => Promise<T>) => Promise<T>;
  lockTimeoutMs?: number;
  retryDelayMs?: number;
  staleLockMs?: number;
}

export interface AliasStoreDependencies {
  rename?: typeof rename;
}

export type SaveAliasResult = "saved" | "already-saved" | "declined";

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

  const config = options.env.XDG_CONFIG_HOME && posix.isAbsolute(options.env.XDG_CONFIG_HOME)
    ? options.env.XDG_CONFIG_HOME
    : posix.join(options.home, ".config");
  return posix.join(config, "llm-now", "aliases.json");
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

function validateAliasTarget(value: Record<string, unknown>): boolean {
  if (!isByokProviderId(value.provider)) return false;
  if (value.model === null) return DEFAULT_MODEL_PROVIDERS.has(value.provider);
  return typeof value.model === "string" && value.model.length > 0;
}

export function hasInvalidInstructionCharacters(value: string): boolean {
  return /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]/.test(value);
}

function isValidInstructions(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && !hasInvalidInstructionCharacters(value);
}

function validateVersion1AliasRecord(value: unknown): value is AliasRecord {
  return isObject(value)
    && hasExactlyKeys(value, ["model", "provider"])
    && validateAliasTarget(value);
}

function validateVersion2AliasRecord(value: unknown): value is AliasRecord {
  if (!isObject(value)) return false;
  const keys = value.instructions === undefined
    ? ["model", "provider"]
    : ["instructions", "model", "provider"];
  return hasExactlyKeys(value, keys)
    && validateAliasTarget(value)
    && (value.instructions === undefined || isValidInstructions(value.instructions));
}

function validateDocument(value: unknown): value is AliasDocument {
  if (!isObject(value) || !hasExactlyKeys(value, ["aliases", "version"])) return false;
  if (!isObject(value.aliases)) return false;

  const validateRecord = value.version === 1
    ? validateVersion1AliasRecord
    : value.version === 2
    ? validateVersion2AliasRecord
    : null;
  if (validateRecord === null) return false;

  return Object.entries(value.aliases).every(
    ([name, record]) => isValidAliasName(name) && validateRecord(record),
  );
}

function emptyDocument(): AliasDocument {
  return { version: 1, aliases: {} };
}

function canonicalizeDocument(document: AliasDocument, path: string): AliasDocument {
  const aliases: Record<string, AliasRecord> = {};
  const seenAliases = new Map<string, { originalName: string; record: AliasRecord }>();
  const entries = Object.entries(document.aliases)
    .map(([originalName, record]) => ({
      originalName,
      canonicalName: normalizeAliasName(originalName),
      record,
    }))
    .sort((left, right) => {
      if (left.canonicalName !== right.canonicalName) {
        return left.canonicalName < right.canonicalName ? -1 : 1;
      }
      if (left.originalName < right.originalName) return -1;
      if (left.originalName > right.originalName) return 1;
      return 0;
    });

  for (const { originalName, canonicalName, record } of entries) {
    const current = seenAliases.get(canonicalName);
    if (current === undefined) {
      aliases[canonicalName] = record;
      seenAliases.set(canonicalName, { originalName, record });
      continue;
    }
    if (sameAliasRecord(current.record, record)) continue;

    const displayPath = summarizeDiagnosticValue(path);
    throw new AliasStoreError(
      `conflicting case-insensitive alias "${canonicalName}" in ${displayPath}: `
      + `"${current.originalName}" -> ${formatAliasTarget(current.record)}; `
      + `"${originalName}" -> ${formatAliasTarget(record)}. `
      + `Edit the alias store manually at ${displayPath} and keep only one target for "${canonicalName}".`,
    );
  }

  return { version: document.version, aliases };
}

function formatAliasTarget(record: AliasRecord): string {
  return summarizeDiagnosticValue(`${record.provider}/${record.model ?? "(default)"}`);
}

function summarizeDiagnosticValue(value: string): string {
  if (value.length <= MAX_ALIAS_DIAGNOSTIC_VALUE_LENGTH) return value;
  const startLength = Math.floor((MAX_ALIAS_DIAGNOSTIC_VALUE_LENGTH - 1) / 2);
  const endLength = MAX_ALIAS_DIAGNOSTIC_VALUE_LENGTH - startLength - 1;
  return `${value.slice(0, startLength)}…${value.slice(-endLength)}`;
}

export async function loadAliases(path: string): Promise<AliasDocument> {
  try {
    const parsed: unknown = JSON.parse(await Bun.file(path).text());
    if (!validateDocument(parsed)) throw new Error("invalid alias document schema");
    return canonicalizeDocument(parsed, path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return emptyDocument();
    if (error instanceof AliasStoreError) throw error;
    throw new AliasStoreError(`failed to load alias store: ${path}`, { cause: error });
  }
}

export async function resolveAlias(path: string, name: string): Promise<AliasRecord> {
  const canonicalName = normalizeAliasName(name);
  const aliases = (await loadAliases(path)).aliases;
  if (!Object.hasOwn(aliases, canonicalName)) throw new AliasStoreError(`alias not found: ${name}`);
  const record = aliases[canonicalName];
  if (record === undefined) throw new AliasStoreError(`alias not found: ${name}`);
  return record;
}

function validateSaveInput(name: string, record: AliasRecord): string {
  const canonicalName = normalizeAliasName(name);
  if (!validateAliasTarget({ provider: record.provider, model: record.model })) {
    throw new AliasStoreError(`invalid alias selection: ${name}`);
  }
  if (record.instructions !== undefined && !isValidInstructions(record.instructions)) {
    throw new AliasStoreError("invalid alias instructions");
  }
  return canonicalName;
}

function storedAliasRecord(record: AliasRecord): AliasRecord {
  return {
    provider: record.provider,
    model: record.model,
    ...(record.instructions === undefined ? {} : { instructions: record.instructions }),
  };
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
): Promise<SaveAliasResult> {
  const canonicalName = validateSaveInput(name, record);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);

  const lockPath = `${path}.lock`;
  const lockOptions = {
    lockTimeoutMs: options.lockTimeoutMs ?? 2_000,
    retryDelayMs: options.retryDelayMs ?? 20,
    staleLockMs: options.staleLockMs ?? 30_000,
  };

  let hasExpectedCurrent = false;
  let expectedCurrent: AliasRecord | undefined;
  while (true) {
    const result = await attemptSave(hasExpectedCurrent, expectedCurrent);
    if (result === "saved" || result === "already-saved") return result;
    if (options.confirmOverwrite === undefined) throw new AliasCollisionError(canonicalName);
    if (!(await options.confirmOverwrite(canonicalName, result.current))) return "declined";
    hasExpectedCurrent = true;
    expectedCurrent = result.current;
  }

  async function attemptSave(
    hasExpected: boolean,
    expected: AliasRecord | undefined,
  ): Promise<"saved" | "already-saved" | { current: AliasRecord | undefined }> {
    await acquireLock(lockPath, lockOptions);
    let temporaryPath: string | undefined;
    try {
      const document = await loadAliases(path);
      const current = Object.hasOwn(document.aliases, canonicalName)
        ? document.aliases[canonicalName]
        : undefined;
      if (current !== undefined && sameAliasRecord(current, record)) return "already-saved";
      const matchesExpected = expected === undefined
        ? current === undefined
        : current !== undefined && sameAliasRecord(current, expected);
      if (hasExpected && !matchesExpected) return { current };
      if (current !== undefined) {
        if (!hasExpected) return { current };
      }

      const persist = async (): Promise<"saved"> => {
        if (
          record.instructions !== undefined
          && options.persistenceBlocker?.blocks(record.instructions) === true
        ) {
          throw new AliasStoreError("instructions must not contain an API key");
        }
        const nextAliases = {
          ...document.aliases,
          [canonicalName]: storedAliasRecord(record),
        };
        const next: AliasDocument = {
          version: document.version === 2 || record.instructions !== undefined
            ? 2
            : 1,
          aliases: nextAliases,
        };
        temporaryPath = join(directory, `.aliases-${process.pid}-${randomUUID()}.tmp`);
        const handle = await open(temporaryPath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`);
        } finally {
          await handle.close();
        }
        await (dependencies.rename ?? rename)(temporaryPath, path);
        temporaryPath = undefined;
        return "saved";
      };
      return await (options.persistenceGuard === undefined
        ? persist()
        : options.persistenceGuard(persist));
    } finally {
      if (temporaryPath !== undefined) await unlink(temporaryPath).catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

export function sameAliasRecord(left: AliasRecord, right: AliasRecord): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.instructions === right.instructions;
}

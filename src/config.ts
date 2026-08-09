import type { ByokEnvironment } from "@swartzrock/byok-runtime";
import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";
import {
  AliasCollisionError,
  AliasStoreError,
  loadAliases as loadLegacyAliases,
  normalizeAliasName,
  parseAliasDocument,
  resolveAliasPath,
  sameAliasRecord,
  type AliasDocument,
  type AliasRecord,
  type SaveAliasResult,
} from "./aliases.ts";
import type { PersistenceBlocker } from "./credentials.ts";
import {
  ConfigSchemaError,
  parseConfigDocument,
  projectAliases,
  projectVoiceConfig,
  serializeConfigDocument,
  type ConfigDocumentV1,
  type EffectiveVoiceConfig,
  type StoredAliasConfig,
} from "./config-schema.ts";
import { parseVoiceConfig } from "./voice-routing.ts";

export interface ConfigPathOptions {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: ByokEnvironment;
}

export interface ConfigPaths {
  readonly configPath: string;
  readonly legacyAliasPath: string;
  readonly legacyVoicePath: string;
}

export interface ConfigSnapshot {
  readonly authority: "unified" | "legacy";
  readonly document: ConfigDocumentV1 | null;
  readonly aliases: Readonly<Record<string, AliasRecord>>;
  readonly voice: EffectiveVoiceConfig;
}

export interface ConfigSnapshotDependencies {
  readonly loadLegacyAliases?: (path: string) => Promise<AliasDocument>;
  readonly readLegacyVoiceConfig?: (path: string) => Promise<Uint8Array | null>;
  readonly includeLegacyVoice?: boolean;
}

export interface SaveConfigAliasOptions {
  readonly confirmOverwrite?: (
    name: string,
    current: AliasRecord | undefined,
  ) => Promise<boolean>;
  readonly persistenceBlocker?: PersistenceBlocker;
  readonly persistenceGuard?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly onStaleProfiles?: (names: readonly string[]) => void;
  readonly lockTimeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly staleLockMs?: number;
}

export interface ConfigMutationDependencies {
  readonly chmod?: typeof chmod;
  readonly link?: typeof link;
  readonly lstat?: typeof lstat;
  readonly mkdir?: typeof mkdir;
  readonly open?: typeof open;
  readonly readFile?: (path: string) => Promise<Uint8Array>;
  readonly rename?: typeof rename;
  readonly unlink?: typeof unlink;
  readonly randomToken?: () => string;
  readonly processIsAlive?: (pid: number) => boolean;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly syncDirectory?: (path: string) => Promise<void>;
  readonly afterLegacyBackups?: () => Promise<void>;
}

export type MigrationResult = Readonly<{
  kind: "migrated" | "already-unified" | "created-empty";
  staleProfiles: readonly string[];
}>;

export class ConfigTransactionError extends AliasStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigTransactionError";
  }
}

interface LockOptions {
  readonly lockTimeoutMs: number;
  readonly retryDelayMs: number;
  readonly staleLockMs: number;
}

interface LockOwner {
  readonly path: string;
  readonly pid: number;
  readonly token: string;
  readonly bytes: Uint8Array;
}

interface LegacySnapshot {
  readonly aliases: Uint8Array | null;
  readonly voice: Uint8Array | null;
}

interface MigrationProjection {
  readonly document: ConfigDocumentV1;
  readonly staleProfiles: readonly string[];
}

interface AliasMutation {
  readonly name: string;
  readonly record: AliasRecord;
}

interface BackupPublication {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly created: boolean;
}

export function resolveConfigPaths(options: ConfigPathOptions): ConfigPaths {
  const legacyAliasPath = resolveAliasPath(options);
  const path = options.platform === "win32" ? win32 : posix;
  const directory = path.dirname(legacyAliasPath);
  return {
    configPath: path.join(directory, "config.toml"),
    legacyAliasPath,
    legacyVoicePath: path.join(directory, "voice-router.toml"),
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function loadConfig(path: string): Promise<ConfigDocumentV1 | null> {
  try {
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ConfigSchemaError(`configuration is not valid UTF-8: ${path}`);
    }
    return parseConfigDocument(text, path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    if (error instanceof ConfigSchemaError) throw error;
    throw new ConfigSchemaError(`failed to read configuration: ${path}`, "schema", {
      cause: new Error("configuration read failed"),
    });
  }
}

async function readLegacyVoiceConfig(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await Bun.file(path).arrayBuffer());
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

function freezeLegacyAliases(document: AliasDocument): Readonly<Record<string, AliasRecord>> {
  const aliases: Record<string, AliasRecord> = {};
  for (const [name, record] of Object.entries(document.aliases)) {
    aliases[name] = Object.freeze({ ...record });
  }
  return Object.freeze(aliases);
}

export async function loadConfigSnapshot(
  paths: ConfigPaths,
  dependencies: ConfigSnapshotDependencies = {},
): Promise<ConfigSnapshot> {
  const unified = await loadUnifiedConfigSnapshot(paths.configPath);
  if (unified !== null) return unified;

  const legacyDocument = await (dependencies.loadLegacyAliases ?? loadLegacyAliases)(
    paths.legacyAliasPath,
  );
  const aliases = freezeLegacyAliases(legacyDocument);
  const voiceText = dependencies.includeLegacyVoice === true
    ? await (dependencies.readLegacyVoiceConfig ?? readLegacyVoiceConfig)(
      paths.legacyVoicePath,
    ).then((bytes) => bytes === null
      ? null
      : new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    : null;
  let voice: EffectiveVoiceConfig;
  try {
    voice = parseVoiceConfig(
      voiceText,
      Object.keys(aliases).map((name) => name.toLowerCase()),
    );
  } catch {
    throw new ConfigSchemaError(
      `failed to load legacy voice configuration: ${paths.legacyVoicePath}`,
      "schema",
      { cause: new Error("legacy voice configuration is invalid") },
    );
  }
  return Object.freeze({
    authority: "legacy",
    document: null,
    aliases,
    voice,
  });
}

export async function loadUnifiedConfigSnapshot(path: string): Promise<ConfigSnapshot | null> {
  const document = await loadConfig(path);
  if (document === null) return null;
  return Object.freeze({
    authority: "unified",
    document,
    aliases: projectAliases(document),
    voice: projectVoiceConfig(document),
  });
}

function mutationDependencies(
  overrides: ConfigMutationDependencies,
): Required<Omit<ConfigMutationDependencies, "afterLegacyBackups">>
  & Pick<ConfigMutationDependencies, "afterLegacyBackups"> {
  return {
    chmod: overrides.chmod ?? chmod,
    link: overrides.link ?? link,
    lstat: overrides.lstat ?? lstat,
    mkdir: overrides.mkdir ?? mkdir,
    open: overrides.open ?? open,
    readFile: overrides.readFile ?? (async (path) =>
      new Uint8Array(await Bun.file(path).arrayBuffer())),
    rename: overrides.rename ?? rename,
    unlink: overrides.unlink ?? unlink,
    randomToken: overrides.randomToken ?? randomUUID,
    processIsAlive: overrides.processIsAlive ?? processIsAlive,
    delay: overrides.delay ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds))),
    syncDirectory: overrides.syncDirectory ?? syncDirectory,
    afterLegacyBackups: overrides.afterLegacyBackups,
  };
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, "EPERM");
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

async function readOptionalBytes(
  path: string,
  dependencies: ReturnType<typeof mutationDependencies>,
): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await dependencies.readFile(path));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

function decodeUtf8(bytes: Uint8Array, source: "alias" | "voice"): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ConfigTransactionError(`legacy ${source} configuration is not valid UTF-8`, {
      cause: new Error("legacy configuration decoding failed"),
    });
  }
}

function parseLockContents(bytes: Uint8Array): { pid: number; token: string | null } | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    return null;
  }
  if (/^[1-9]\d*$/.test(text)) return { pid: Number(text), token: null };
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value !== "object"
      || value === null
      || Array.isArray(value)
      || !("pid" in value)
      || !("token" in value)
      || !Number.isSafeInteger(value.pid)
      || (value.pid as number) <= 0
      || typeof value.token !== "string"
      || value.token.length === 0
    ) return null;
    return { pid: value.pid as number, token: value.token };
  } catch {
    return null;
  }
}

async function acquireLock(
  lockPath: string,
  options: LockOptions,
  dependencies: ReturnType<typeof mutationDependencies>,
): Promise<LockOwner> {
  const startedAt = Date.now();
  const token = dependencies.randomToken();
  const bytes = new TextEncoder().encode(`${JSON.stringify({ pid: process.pid, token })}\n`);

  while (true) {
    try {
      const handle = await dependencies.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } catch (error) {
        await dependencies.unlink(lockPath).catch(() => undefined);
        throw error;
      } finally {
        await handle.close();
      }
      return { path: lockPath, pid: process.pid, token, bytes };
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;

      let lock;
      let existing: Uint8Array;
      try {
        [lock, existing] = await Promise.all([
          dependencies.lstat(lockPath),
          dependencies.readFile(lockPath).then((value) => new Uint8Array(value)),
        ]);
      } catch (inspectionError) {
        if (hasErrorCode(inspectionError, "ENOENT")) continue;
        throw inspectionError;
      }
      if (!lock.isFile()) throw new ConfigTransactionError(`invalid configuration lock: ${lockPath}`);
      const owner = parseLockContents(existing);
      if (owner === null) {
        if (
          Date.now() - lock.mtimeMs > options.staleLockMs
          || Date.now() - startedAt >= options.lockTimeoutMs
        ) {
          throw new ConfigTransactionError(`invalid configuration lock: ${lockPath}`);
        }
        await dependencies.delay(options.retryDelayMs);
        continue;
      }

      if (
        Date.now() - lock.mtimeMs > options.staleLockMs
        && !dependencies.processIsAlive(owner.pid)
      ) {
        await withLockRemovalGuard(lockPath, options, dependencies, async () => {
          let currentLock;
          try {
            currentLock = await dependencies.lstat(lockPath);
          } catch (inspectionError) {
            if (hasErrorCode(inspectionError, "ENOENT")) return;
            throw inspectionError;
          }
          if (!currentLock.isFile()) {
            throw new ConfigTransactionError(`invalid configuration lock: ${lockPath}`);
          }
          const current = await readOptionalBytes(lockPath, dependencies);
          if (current === null) return;
          const currentOwner = parseLockContents(current);
          if (
            Date.now() - currentLock.mtimeMs <= options.staleLockMs
            || currentOwner === null
            || dependencies.processIsAlive(currentOwner.pid)
          ) return;
          await dependencies.unlink(lockPath).catch((unlinkError: unknown) => {
            if (!hasErrorCode(unlinkError, "ENOENT")) throw unlinkError;
          });
        });
        continue;
      }
      if (Date.now() - startedAt >= options.lockTimeoutMs) {
        throw new ConfigTransactionError(`timed out waiting for configuration lock: ${lockPath}`);
      }
      await dependencies.delay(options.retryDelayMs);
    }
  }
}

async function withLockRemovalGuard<T>(
  lockPath: string,
  options: LockOptions,
  dependencies: ReturnType<typeof mutationDependencies>,
  operation: () => Promise<T>,
): Promise<T> {
  const guardPath = `${lockPath}.removal`;
  const startedAt = Date.now();
  while (true) {
    try {
      const handle = await dependencies.open(guardPath, "wx", 0o600);
      await handle.close();
      break;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      if (Date.now() - startedAt >= options.lockTimeoutMs) {
        throw new ConfigTransactionError(`timed out waiting for configuration lock removal: ${guardPath}`);
      }
      await dependencies.delay(options.retryDelayMs);
    }
  }

  try {
    return await operation();
  } finally {
    await dependencies.unlink(guardPath).catch(() => undefined);
  }
}

async function removeLockIfOwned(
  owner: LockOwner,
  options: LockOptions,
  dependencies: ReturnType<typeof mutationDependencies>,
): Promise<void> {
  await withLockRemovalGuard(owner.path, options, dependencies, async () => {
    const current = await readOptionalBytes(owner.path, dependencies);
    if (current === null || !bytesEqual(current, owner.bytes)) return;
    const parsed = parseLockContents(current);
    if (parsed?.token !== owner.token || parsed.pid !== owner.pid) return;
    await dependencies.unlink(owner.path).catch((error: unknown) => {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    });
  });
}

async function releaseLock(
  owner: LockOwner,
  options: LockOptions,
  dependencies: ReturnType<typeof mutationDependencies>,
): Promise<void> {
  await removeLockIfOwned(owner, options, dependencies);
}

async function ensureOwnerDirectory(
  path: string,
  dependencies: ReturnType<typeof mutationDependencies>,
): Promise<void> {
  await dependencies.mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await dependencies.chmod(path, 0o700);
}

async function writeSyncedTemporary(
  directory: string,
  prefix: string,
  bytes: Uint8Array,
  dependencies: ReturnType<typeof mutationDependencies>,
): Promise<string> {
  const path = join(directory, `.${prefix}-${process.pid}-${dependencies.randomToken()}.tmp`);
  const handle = await dependencies.open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await dependencies.unlink(path).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return path;
}

async function publishNoClobber(
  path: string,
  bytes: Uint8Array,
  prefix: string,
  dependencies: ReturnType<typeof mutationDependencies>,
): Promise<boolean> {
  const temporaryPath = await writeSyncedTemporary(dirname(path), prefix, bytes, dependencies);
  try {
    try {
      await dependencies.link(temporaryPath, path);
      return true;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      return false;
    }
  } finally {
    await dependencies.unlink(temporaryPath).catch(() => undefined);
  }
}

async function replaceAtomically(
  path: string,
  bytes: Uint8Array,
  dependencies: ReturnType<typeof mutationDependencies>,
): Promise<void> {
  const temporaryPath = await writeSyncedTemporary(
    dirname(path),
    "config",
    bytes,
    dependencies,
  );
  try {
    await dependencies.rename(temporaryPath, path);
  } finally {
    await dependencies.unlink(temporaryPath).catch(() => undefined);
  }
  await dependencies.syncDirectory(dirname(path));
}

function storedAlias(record: AliasRecord, current?: StoredAliasConfig): StoredAliasConfig {
  const stored: {
    provider: AliasRecord["provider"];
    model: string;
    instructions?: string;
    spokenNames?: readonly string[];
    voice?: string;
    rate?: number;
    pitch?: number;
  } = {
    provider: record.provider,
    model: record.model ?? "default",
  };
  if (record.instructions !== undefined) stored.instructions = record.instructions;
  if (current?.spokenNames !== undefined) stored.spokenNames = current.spokenNames;
  if (current?.voice !== undefined) stored.voice = current.voice;
  if (current?.rate !== undefined) stored.rate = current.rate;
  if (current?.pitch !== undefined) stored.pitch = current.pitch;
  return stored;
}

function canonicalDocument(
  document: ConfigDocumentV1,
  path: string,
): ConfigDocumentV1 {
  return parseConfigDocument(serializeConfigDocument(document), path);
}

function applyAliasMutation(
  document: ConfigDocumentV1,
  mutation: AliasMutation,
  path: string,
): ConfigDocumentV1 {
  return canonicalDocument({
    version: 1,
    ...(document.voice === undefined ? {} : { voice: document.voice }),
    aliases: {
      ...document.aliases,
      [mutation.name]: storedAlias(mutation.record, document.aliases[mutation.name]),
    },
  }, path);
}

function validateMutation(name: string, record: AliasRecord, path: string): AliasMutation {
  const canonicalName = normalizeAliasName(name);
  canonicalDocument({
    version: 1,
    aliases: { [canonicalName]: storedAlias(record) },
  }, path);
  return { name: canonicalName, record };
}

function parseLegacyAliases(bytes: Uint8Array | null, path: string): AliasDocument {
  if (bytes === null) return { version: 1, aliases: {} };
  try {
    return parseAliasDocument(decodeUtf8(bytes, "alias"), path);
  } catch {
    throw new ConfigTransactionError(`failed to validate legacy alias configuration: ${path}`, {
      cause: new Error("legacy alias configuration is invalid"),
    });
  }
}

function projectLegacySnapshot(
  snapshot: LegacySnapshot,
  paths: ConfigPaths,
  mutation?: AliasMutation,
): MigrationProjection {
  const legacyAliases = parseLegacyAliases(snapshot.aliases, paths.legacyAliasPath);
  const aliases: Record<string, StoredAliasConfig> = {};
  for (const [name, record] of Object.entries(legacyAliases.aliases)) {
    aliases[name] = storedAlias(record);
  }
  let document: ConfigDocumentV1 = canonicalDocument({ version: 1, aliases }, paths.configPath);
  if (mutation !== undefined) document = applyAliasMutation(document, mutation, paths.configPath);
  if (snapshot.voice === null) return { document, staleProfiles: [] };

  const text = decodeUtf8(snapshot.voice, "voice");
  let parsedVoice: ReturnType<typeof parseVoiceConfig>;
  let raw: Record<string, unknown>;
  try {
    parsedVoice = parseVoiceConfig(text, Object.keys(document.aliases));
    const parsed: unknown = Bun.TOML.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    raw = parsed as Record<string, unknown>;
  } catch {
    throw new ConfigTransactionError(
      `failed to validate legacy voice configuration: ${paths.legacyVoicePath}`,
      { cause: new Error("legacy voice configuration is invalid") },
    );
  }

  const mergedAliases: Record<string, StoredAliasConfig> = { ...document.aliases };
  const staleProfiles: string[] = [];
  for (const name of Object.keys(parsedVoice.profiles).sort()) {
    const profile = parsedVoice.profiles[name];
    const rawProfile = raw[name];
    if (profile === undefined || typeof rawProfile !== "object" || rawProfile === null) continue;
    if (!Object.hasOwn(mergedAliases, name)) {
      staleProfiles.push(name);
      continue;
    }
    const source = rawProfile as Record<string, unknown>;
    mergedAliases[name] = {
      ...mergedAliases[name]!,
      ...(Object.hasOwn(source, "spoken_names") ? { spokenNames: profile.spokenNames } : {}),
      ...(profile.voice === undefined ? {} : { voice: profile.voice }),
      ...(profile.rate === undefined ? {} : { rate: profile.rate }),
      ...(profile.pitch === undefined ? {} : { pitch: profile.pitch }),
    };
  }

  const voice = Object.hasOwn(raw, "wake_words")
    ? { wakeWords: parsedVoice.wakeWords }
    : undefined;
  document = canonicalDocument({
    version: 1,
    ...(voice === undefined ? {} : { voice }),
    aliases: mergedAliases,
  }, paths.configPath);
  return { document, staleProfiles: Object.freeze(staleProfiles) };
}

async function readLegacySnapshot(
  paths: ConfigPaths,
  dependencies: ReturnType<typeof mutationDependencies>,
): Promise<LegacySnapshot> {
  const [aliases, voice] = await Promise.all([
    readOptionalBytes(paths.legacyAliasPath, dependencies),
    readOptionalBytes(paths.legacyVoicePath, dependencies),
  ]);
  return { aliases, voice };
}

function sameOptionalBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  return left === null ? right === null : right !== null && bytesEqual(left, right);
}

async function publishBackup(
  sourcePath: string,
  bytes: Uint8Array,
  dependencies: ReturnType<typeof mutationDependencies>,
): Promise<BackupPublication> {
  const path = `${sourcePath}.pre-unified-v1.bak`;
  const existing = await readOptionalBytes(path, dependencies);
  if (existing !== null) {
    if (!bytesEqual(existing, bytes)) {
      throw new ConfigTransactionError(`legacy backup does not match source: ${path}`);
    }
    if (process.platform !== "win32") await dependencies.chmod(path, 0o600);
    return { path, bytes, created: false };
  }
  const created = await publishNoClobber(path, bytes, "backup", dependencies);
  if (!created) {
    const winner = await readOptionalBytes(path, dependencies);
    if (winner === null || !bytesEqual(winner, bytes)) {
      throw new ConfigTransactionError(`legacy backup does not match source: ${path}`);
    }
  }
  if (process.platform !== "win32") await dependencies.chmod(path, 0o600);
  return { path, bytes, created };
}

async function rollbackCreatedBackups(
  publications: readonly BackupPublication[],
  dependencies: ReturnType<typeof mutationDependencies>,
): Promise<void> {
  const directories = new Set<string>();
  for (const publication of publications) {
    if (!publication.created) continue;
    const current = await readOptionalBytes(publication.path, dependencies);
    if (current !== null && bytesEqual(current, publication.bytes)) {
      await dependencies.unlink(publication.path).catch(() => undefined);
      directories.add(dirname(publication.path));
    }
  }
  await Promise.all([...directories].map((directory) => dependencies.syncDirectory(directory)));
}

async function publishLegacyBackups(
  paths: ConfigPaths,
  snapshot: LegacySnapshot,
  dependencies: ReturnType<typeof mutationDependencies>,
): Promise<readonly BackupPublication[]> {
  const backups: BackupPublication[] = [];
  if (snapshot.aliases !== null) {
    backups.push(await publishBackup(paths.legacyAliasPath, snapshot.aliases, dependencies));
  }
  if (snapshot.voice !== null) {
    backups.push(await publishBackup(paths.legacyVoicePath, snapshot.voice, dependencies));
  }
  const directories = [...new Set(backups.map((backup) => dirname(backup.path)))];
  await Promise.all(directories.map((directory) => dependencies.syncDirectory(directory)));
  return backups;
}

async function projectRecoverably(
  snapshot: LegacySnapshot,
  paths: ConfigPaths,
  dependencies: ReturnType<typeof mutationDependencies>,
  mutation?: AliasMutation,
): Promise<MigrationProjection> {
  try {
    return projectLegacySnapshot(snapshot, paths, mutation);
  } catch (error) {
    const backups = await publishLegacyBackups(paths, snapshot, dependencies);
    const current = await readLegacySnapshot(paths, dependencies);
    if (
      !sameOptionalBytes(snapshot.aliases, current.aliases)
      || !sameOptionalBytes(snapshot.voice, current.voice)
    ) {
      await rollbackCreatedBackups(backups, dependencies);
      throw new ConfigTransactionError("legacy configuration changed during migration");
    }
    throw error;
  }
}

async function migrateLocked(
  paths: ConfigPaths,
  snapshot: LegacySnapshot,
  projection: MigrationProjection,
  dependencies: ReturnType<typeof mutationDependencies>,
): Promise<boolean> {
  const backups = await publishLegacyBackups(paths, snapshot, dependencies);
  await dependencies.afterLegacyBackups?.();

  const current = await readLegacySnapshot(paths, dependencies);
  if (
    !sameOptionalBytes(snapshot.aliases, current.aliases)
    || !sameOptionalBytes(snapshot.voice, current.voice)
  ) {
    await rollbackCreatedBackups(backups, dependencies);
    throw new ConfigTransactionError("legacy configuration changed during migration");
  }

  const bytes = new TextEncoder().encode(serializeConfigDocument(projection.document));
  const published = await publishNoClobber(paths.configPath, bytes, "config", dependencies);
  if (published) await dependencies.syncDirectory(dirname(paths.configPath));
  return published;
}

function lockOptions(options: SaveConfigAliasOptions): LockOptions {
  return {
    lockTimeoutMs: options.lockTimeoutMs ?? 2_000,
    retryDelayMs: options.retryDelayMs ?? 20,
    staleLockMs: options.staleLockMs ?? 30_000,
  };
}

async function currentUnifiedDocument(
  path: string,
  dependencies: ReturnType<typeof mutationDependencies>,
): Promise<ConfigDocumentV1 | null> {
  const bytes = await readOptionalBytes(path, dependencies);
  if (bytes === null) return null;
  return parseConfigDocument(decodeUtf8(bytes, "alias"), path);
}

export async function migrateConfig(
  paths: ConfigPaths,
  options: Pick<SaveConfigAliasOptions, "lockTimeoutMs" | "retryDelayMs" | "staleLockMs"> = {},
  overrides: ConfigMutationDependencies = {},
): Promise<MigrationResult> {
  const dependencies = mutationDependencies(overrides);
  const locks = lockOptions(options);
  const directory = dirname(paths.configPath);
  await ensureOwnerDirectory(directory, dependencies);
  const configOwner = await acquireLock(`${paths.configPath}.lock`, locks, dependencies);
  let legacyOwner: LockOwner | undefined;
  try {
    const existing = await currentUnifiedDocument(paths.configPath, dependencies);
    if (existing !== null) return Object.freeze({ kind: "already-unified", staleProfiles: [] });

    legacyOwner = await acquireLock(
      `${paths.legacyAliasPath}.lock`,
      locks,
      dependencies,
    );
    const snapshot = await readLegacySnapshot(paths, dependencies);
    const projection = await projectRecoverably(snapshot, paths, dependencies);
    const published = await migrateLocked(paths, snapshot, projection, dependencies);
    if (!published) {
      const winner = await currentUnifiedDocument(paths.configPath, dependencies);
      if (winner === null) throw new ConfigTransactionError("unified configuration publication failed");
      return Object.freeze({ kind: "already-unified", staleProfiles: [] });
    }
    return Object.freeze({
      kind: snapshot.aliases === null && snapshot.voice === null ? "created-empty" : "migrated",
      staleProfiles: projection.staleProfiles,
    });
  } finally {
    if (legacyOwner !== undefined) await releaseLock(legacyOwner, locks, dependencies);
    await releaseLock(configOwner, locks, dependencies);
  }
}

type SaveAttempt =
  | Readonly<{ kind: "saved"; staleProfiles: readonly string[] }>
  | Readonly<{ kind: "retry" }>
  | Readonly<{ kind: "current"; current: AliasRecord | undefined }>;

export async function saveConfigAlias(
  paths: ConfigPaths,
  name: string,
  record: AliasRecord,
  options: SaveConfigAliasOptions = {},
  overrides: ConfigMutationDependencies = {},
): Promise<SaveAliasResult> {
  const mutation = validateMutation(name, record, paths.configPath);
  if (
    record.instructions !== undefined
    && options.persistenceBlocker?.blocks(record.instructions) === true
  ) throw new ConfigTransactionError("instructions must not contain an API key");

  const initial = await loadConfigSnapshot(paths);
  let expected = initial.aliases[mutation.name];
  if (expected !== undefined && sameAliasRecord(expected, record)) return "already-saved";
  if (expected !== undefined) {
    if (options.confirmOverwrite === undefined) throw new AliasCollisionError(mutation.name);
    if (!(await options.confirmOverwrite(mutation.name, expected))) return "declined";
  }

  const dependencies = mutationDependencies(overrides);
  await ensureOwnerDirectory(dirname(paths.configPath), dependencies);
  while (true) {
    const attempt = await attemptSaveConfigAlias(paths, mutation, expected, options, dependencies);
    if (attempt.kind === "saved") {
      if (attempt.staleProfiles.length > 0) options.onStaleProfiles?.(attempt.staleProfiles);
      return "saved";
    }
    if (attempt.kind === "retry") continue;
    if (attempt.current !== undefined && sameAliasRecord(attempt.current, record)) {
      return "already-saved";
    }
    if (options.confirmOverwrite === undefined) throw new AliasCollisionError(mutation.name);
    if (!(await options.confirmOverwrite(mutation.name, attempt.current))) return "declined";
    expected = attempt.current;
  }
}

async function attemptSaveConfigAlias(
  paths: ConfigPaths,
  mutation: AliasMutation,
  expected: AliasRecord | undefined,
  options: SaveConfigAliasOptions,
  dependencies: ReturnType<typeof mutationDependencies>,
): Promise<SaveAttempt> {
  const locks = lockOptions(options);
  const configOwner = await acquireLock(
    `${paths.configPath}.lock`,
    locks,
    dependencies,
  );
  let legacyOwner: LockOwner | undefined;
  try {
    const unified = await currentUnifiedDocument(paths.configPath, dependencies);
    if (unified !== null) {
      const aliases = projectAliases(unified);
      const current = aliases[mutation.name];
      if (current !== undefined && sameAliasRecord(current, mutation.record)) {
        return { kind: "current", current };
      }
      const matchesExpected = expected === undefined
        ? current === undefined
        : current !== undefined && sameAliasRecord(current, expected);
      if (!matchesExpected) return { kind: "current", current };
      const persist = async (): Promise<SaveAttempt> => {
        const next = applyAliasMutation(unified, mutation, paths.configPath);
        await replaceAtomically(
          paths.configPath,
          new TextEncoder().encode(serializeConfigDocument(next)),
          dependencies,
        );
        return { kind: "saved", staleProfiles: [] };
      };
      return options.persistenceGuard === undefined ? persist() : options.persistenceGuard(persist);
    }

    legacyOwner = await acquireLock(
      `${paths.legacyAliasPath}.lock`,
      locks,
      dependencies,
    );
    const snapshot = await readLegacySnapshot(paths, dependencies);
    const legacyAliases = parseLegacyAliases(snapshot.aliases, paths.legacyAliasPath).aliases;
    const current = legacyAliases[mutation.name];
    const matchesExpected = expected === undefined
      ? current === undefined
      : current !== undefined && sameAliasRecord(current, expected);
    if (!matchesExpected) return { kind: "current", current };

    const persist = async (): Promise<SaveAttempt> => {
      const projection = await projectRecoverably(snapshot, paths, dependencies, mutation);
      const published = await migrateLocked(paths, snapshot, projection, dependencies);
      return published
        ? { kind: "saved", staleProfiles: projection.staleProfiles }
        : { kind: "retry" };
    };
    return options.persistenceGuard === undefined ? persist() : options.persistenceGuard(persist);
  } finally {
    if (legacyOwner !== undefined) await releaseLock(legacyOwner, locks, dependencies);
    await releaseLock(configOwner, locks, dependencies);
  }
}

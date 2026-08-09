import type { ByokEnvironment } from "@swartzrock/byok-runtime";
import { posix, win32 } from "node:path";
import {
  loadAliases as loadLegacyAliases,
  type AliasDocument,
  type AliasRecord,
} from "./aliases.ts";
import {
  ConfigSchemaError,
  parseConfigDocument,
  projectAliases,
  projectVoiceConfig,
  type ConfigDocumentV1,
  type EffectiveVoiceConfig,
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

export function resolveConfigPaths(options: ConfigPathOptions): ConfigPaths {
  if (options.platform === "win32") {
    const root = options.env.APPDATA && win32.isAbsolute(options.env.APPDATA)
      ? options.env.APPDATA
      : win32.join(options.home, "AppData", "Roaming");
    const directory = win32.join(root, "llm-now");
    return {
      configPath: win32.join(directory, "config.toml"),
      legacyAliasPath: win32.join(directory, "aliases.json"),
      legacyVoicePath: win32.join(directory, "voice-router.toml"),
    };
  }

  const root = options.env.XDG_CONFIG_HOME && posix.isAbsolute(options.env.XDG_CONFIG_HOME)
    ? options.env.XDG_CONFIG_HOME
    : posix.join(options.home, ".config");
  const directory = posix.join(root, "llm-now");
  return {
    configPath: posix.join(directory, "config.toml"),
    legacyAliasPath: posix.join(directory, "aliases.json"),
    legacyVoicePath: posix.join(directory, "voice-router.toml"),
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function loadConfig(path: string): Promise<ConfigDocumentV1 | null> {
  try {
    return parseConfigDocument(await Bun.file(path).text(), path);
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

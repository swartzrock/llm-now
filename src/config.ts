import type { ByokEnvironment } from "@swartzrock/byok-runtime";
import { posix, win32 } from "node:path";
import { ConfigSchemaError, parseConfigDocument, type ConfigDocumentV1 } from "./config-schema.ts";

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

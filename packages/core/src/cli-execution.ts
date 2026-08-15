import { posix, win32 } from "node:path";
import type { CliProviderId } from "./types.ts";

export interface DirectCliExecutionDescriptor {
  readonly mode: "direct";
  readonly executable: string;
  readonly argsPrefix: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly responseSensitiveValues?: readonly string[];
}

export interface WindowsCommandShimExecutionDescriptor {
  readonly mode: "windows-command-shim";
  readonly commandProcessor: string;
  readonly shim: string;
  readonly argsPrefix: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly responseSensitiveValues?: readonly string[];
}

export type CliExecutionDescriptor =
  | DirectCliExecutionDescriptor
  | WindowsCommandShimExecutionDescriptor;

export interface CliExecutionResolver {
  resolve(
    provider: CliProviderId,
    signal?: AbortSignal,
  ): Promise<CliExecutionDescriptor | null>;
}

function isAbsolutePath(value: string): boolean {
  return posix.isAbsolute(value) || win32.isAbsolute(value);
}

function immutableStrings(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== "string" || item.includes("\0"))
  ) return null;
  return Object.freeze([...value]);
}

function exactEnvironment(value: unknown): Readonly<Record<string, string>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const result: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    if (
      name.length === 0
      || name.includes("\0")
      || name === "__proto__"
      || typeof item !== "string"
      || item.includes("\0")
    ) return null;
    result[name] = item;
  }
  return Object.freeze(result);
}

export function validateCliExecutionDescriptor(value: unknown): CliExecutionDescriptor | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const descriptor = value as Record<string, unknown>;
    const argsPrefix = immutableStrings(descriptor.argsPrefix);
    const env = exactEnvironment(descriptor.env);
    const responseSensitiveValues = descriptor.responseSensitiveValues === undefined
      ? undefined
      : immutableStrings(descriptor.responseSensitiveValues);
    if (argsPrefix === null || env === null || responseSensitiveValues === null) return null;

    if (descriptor.mode === "direct") {
      if (
        typeof descriptor.executable !== "string"
        || descriptor.executable.includes("\0")
        || !isAbsolutePath(descriptor.executable)
      ) {
        return null;
      }
      return Object.freeze({
        mode: "direct",
        executable: descriptor.executable,
        argsPrefix,
        env,
        ...(responseSensitiveValues === undefined ? {} : { responseSensitiveValues }),
      });
    }

    if (descriptor.mode === "windows-command-shim") {
      if (
        typeof descriptor.commandProcessor !== "string"
        || descriptor.commandProcessor.includes("\0")
        || !isAbsolutePath(descriptor.commandProcessor)
        || !descriptor.commandProcessor.toLowerCase().endsWith(".exe")
        || typeof descriptor.shim !== "string"
        || descriptor.shim.includes("\0")
        || !isAbsolutePath(descriptor.shim)
        || !descriptor.shim.toLowerCase().endsWith(".cmd")
      ) {
        return null;
      }
      return Object.freeze({
        mode: "windows-command-shim",
        commandProcessor: descriptor.commandProcessor,
        shim: descriptor.shim,
        argsPrefix,
        env,
        ...(responseSensitiveValues === undefined ? {} : { responseSensitiveValues }),
      });
    }
  } catch {
    return null;
  }
  return null;
}

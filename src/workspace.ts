import {
  BYOK_PROVIDER_IDS,
  type ByokProviderId,
} from "@swartzrock/byok-runtime";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize, resolve } from "node:path";

export interface WorkspaceConfig {
  readonly primaryDirectory: string;
  readonly additionalDirectories: readonly string[];
}

export interface WorkspaceCapabilities {
  primaryDirectory: boolean;
  additionalDirectories: boolean;
}

export class WorkspaceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceError";
  }
}

const SUPPORTED_WORKSPACE: WorkspaceCapabilities = Object.freeze({
  primaryDirectory: true,
  additionalDirectories: true,
});
const UNSUPPORTED_WORKSPACE: WorkspaceCapabilities = Object.freeze({
  primaryDirectory: false,
  additionalDirectories: false,
});

const WORKSPACE_CAPABILITIES = Object.freeze(Object.fromEntries(
  BYOK_PROVIDER_IDS.map((provider) => [
    provider,
    provider === "codex-cli" || provider === "claude-cli"
      ? SUPPORTED_WORKSPACE
      : UNSUPPORTED_WORKSPACE,
  ]),
) as Record<ByokProviderId, WorkspaceCapabilities>);

export function workspaceCapabilities(provider: ByokProviderId): WorkspaceCapabilities {
  return WORKSPACE_CAPABILITIES[provider];
}

export function assertWorkspaceSupported(provider: ByokProviderId): void {
  const capabilities = workspaceCapabilities(provider);
  if (!capabilities.primaryDirectory || !capabilities.additionalDirectories) {
    throw new WorkspaceError(`provider ${provider} does not support alias workspaces`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function isWorkspaceConfig(value: unknown): value is WorkspaceConfig {
  if (!isObject(value) || !hasExactlyKeys(value, [
    "additionalDirectories",
    "primaryDirectory",
  ])) return false;
  if (typeof value.primaryDirectory !== "string" || !isAbsolute(value.primaryDirectory)) {
    return false;
  }
  if (!Array.isArray(value.additionalDirectories)) return false;
  if (!value.additionalDirectories.every(
    (directory) => typeof directory === "string" && isAbsolute(directory),
  )) return false;

  const normalized = [
    normalize(value.primaryDirectory),
    ...value.additionalDirectories.map((directory) => normalize(directory)),
  ];
  return new Set(normalized).size === normalized.length;
}

export function normalizeWorkspace(
  primaryDirectory: string,
  additionalDirectories: readonly string[],
  cwd: string,
): WorkspaceConfig {
  const primary = resolveWorkspaceDirectory(primaryDirectory, cwd);
  const additional = additionalDirectories.map((directory) => resolveWorkspaceDirectory(directory, cwd));
  const directories = [primary, ...additional];
  if (new Set(directories).size !== directories.length) {
    throw new WorkspaceError("workspace directories must be unique");
  }
  return { primaryDirectory: primary, additionalDirectories: additional };
}

function resolveWorkspaceDirectory(value: string, cwd: string): string {
  if (value.trim().length === 0) throw new WorkspaceError("workspace directory cannot be blank");
  return normalize(resolve(cwd, value));
}

export function sameWorkspace(
  left: WorkspaceConfig | undefined,
  right: WorkspaceConfig | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.primaryDirectory === right.primaryDirectory
    && left.additionalDirectories.length === right.additionalDirectories.length
    && left.additionalDirectories.every(
      (directory, index) => directory === right.additionalDirectories[index],
    );
}

export function workspaceStateLabel(workspace: WorkspaceConfig): string {
  const count = workspace.additionalDirectories.length;
  return count === 0 ? "workspace" : `workspace +${count}`;
}

export async function preflightWorkspace(
  provider: ByokProviderId,
  workspace: WorkspaceConfig,
): Promise<WorkspaceConfig> {
  assertWorkspaceSupported(provider);
  if (!isWorkspaceConfig(workspace)) throw new WorkspaceError("invalid alias workspace");

  const verified = new Set<string>();
  const configured = [workspace.primaryDirectory, ...workspace.additionalDirectories];
  for (const [index, directory] of configured.entries()) {
    const role = index === 0 ? "primary directory" : `additional directory ${index}`;
    let canonical: string;
    try {
      canonical = await realpath(directory);
      const info = await stat(canonical);
      if (!info.isDirectory()) throw new WorkspaceError(`workspace ${role} is not a directory`);
      await access(canonical, constants.R_OK | constants.X_OK);
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError(`workspace ${role} is unavailable`, { cause: error });
    }
    if (verified.has(canonical)) {
      throw new WorkspaceError(`workspace ${role} duplicates another configured directory`);
    }
    verified.add(canonical);
  }

  const [primaryDirectory, ...additionalDirectories] = [...verified];
  if (primaryDirectory === undefined) throw new WorkspaceError("invalid alias workspace");
  return { primaryDirectory, additionalDirectories };
}

export function workspacePathVariants(workspace: WorkspaceConfig): string[] {
  return [...new Set([workspace.primaryDirectory, ...workspace.additionalDirectories]
    .flatMap((directory) => [directory, JSON.stringify(directory)])
    .filter((value) => value.length > 0))];
}

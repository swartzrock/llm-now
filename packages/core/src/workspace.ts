import { BYOK_PROVIDER_IDS } from "@swartzrock/byok-runtime";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { LlmNowError } from "./errors.ts";
import type {
  DirectoryAccess,
  ProviderId,
  WorkspaceCapabilities,
  WorkspaceRequest,
} from "./types.ts";

const SUPPORTED = Object.freeze({
  primaryDirectory: true,
  additionalDirectories: true,
  readWrite: false,
});
const WRITABLE = Object.freeze({
  primaryDirectory: true,
  additionalDirectories: true,
  readWrite: true,
});
const UNSUPPORTED = Object.freeze({
  primaryDirectory: false,
  additionalDirectories: false,
  readWrite: false,
});

const CAPABILITIES = Object.freeze(Object.fromEntries(BYOK_PROVIDER_IDS.map((provider) => [
  provider,
  provider === "codex-cli" ? WRITABLE : provider === "claude-cli" ? SUPPORTED : UNSUPPORTED,
])) as Record<ProviderId, WorkspaceCapabilities>);

export function workspaceCapabilities(provider: ProviderId): WorkspaceCapabilities {
  return CAPABILITIES[provider];
}

function workspaceFailure(provider: ProviderId): LlmNowError {
  return new LlmNowError("WORKSPACE_UNAVAILABLE", "generation", provider);
}

function supportsWorkspace(provider: ProviderId, accessMode: DirectoryAccess): boolean {
  const capabilities = workspaceCapabilities(provider);
  return capabilities.primaryDirectory
    && capabilities.additionalDirectories
    && (accessMode !== "read-write" || capabilities.readWrite);
}

function validWorkspace(value: WorkspaceRequest): boolean {
  if (
    (value.directoryAccess !== "read-only" && value.directoryAccess !== "read-write")
    || typeof value.primaryDirectory !== "string"
    || !isAbsolute(value.primaryDirectory)
    || !Array.isArray(value.additionalDirectories)
    || !value.additionalDirectories.every((directory) =>
      typeof directory === "string" && isAbsolute(directory)
    )
  ) return false;
  const normalized = [
    normalize(value.primaryDirectory),
    ...value.additionalDirectories.map((directory) => normalize(directory)),
  ];
  return new Set(normalized).size === normalized.length;
}

export async function preflightWorkspace(
  provider: ProviderId,
  workspace: WorkspaceRequest,
): Promise<WorkspaceRequest> {
  try {
    if (!validWorkspace(workspace) || !supportsWorkspace(provider, workspace.directoryAccess)) {
      throw workspaceFailure(provider);
    }

    const canonical: string[] = [];
    for (const directory of [workspace.primaryDirectory, ...workspace.additionalDirectories]) {
      const resolved = await realpath(directory);
      if (!(await stat(resolved)).isDirectory()) throw workspaceFailure(provider);
      await access(
        resolved,
        constants.R_OK
          | constants.X_OK
          | (workspace.directoryAccess === "read-write" ? constants.W_OK : 0),
      );
      if (canonical.includes(resolved)) throw workspaceFailure(provider);
      canonical.push(resolved);
    }

    const [primaryDirectory, ...additionalDirectories] = canonical;
    if (primaryDirectory === undefined) throw workspaceFailure(provider);
    return Object.freeze({
      primaryDirectory,
      additionalDirectories: Object.freeze(additionalDirectories),
      directoryAccess: workspace.directoryAccess,
    });
  } catch {
    throw workspaceFailure(provider);
  }
}

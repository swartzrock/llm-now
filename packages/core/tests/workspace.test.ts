import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { preflightWorkspace, workspaceCapabilities } from "../src/workspace.ts";

describe("core workspace capability", () => {
  test("keeps provider-specific capability records", () => {
    expect(workspaceCapabilities("codex-cli")).toEqual({
      primaryDirectory: true,
      additionalDirectories: true,
      readWrite: true,
    });
    expect(workspaceCapabilities("claude-cli")).toEqual({
      primaryDirectory: true,
      additionalDirectories: true,
      readWrite: false,
    });
    expect(workspaceCapabilities("openai")).toEqual({
      primaryDirectory: false,
      additionalDirectories: false,
      readWrite: false,
    });
  });

  test("preflights explicit workspace I/O without exposing a path in failures", async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp-core-workspace-"));
    const primary = join(root, "primary");
    await mkdir(primary);
    try {
      await expect(preflightWorkspace("codex-cli", {
        primaryDirectory: primary,
        additionalDirectories: [],
        directoryAccess: "read-only",
      })).resolves.toMatchObject({ primaryDirectory: primary });

      const missing = join(root, "private-missing-path");
      try {
        await preflightWorkspace("codex-cli", {
          primaryDirectory: missing,
          additionalDirectories: [],
          directoryAccess: "read-only",
        });
        throw new Error("expected preflight failure");
      } catch (error) {
        expect(String(error)).not.toContain(missing);
      }
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("maps malformed workspace values to the closed workspace failure", async () => {
    await expect(preflightWorkspace("codex-cli", null as never)).rejects.toMatchObject({
      code: "WORKSPACE_UNAVAILABLE",
      operation: "generation",
      provider: "codex-cli",
    });
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AliasCollisionError,
  AliasStoreError,
  type AliasRecord,
  loadAliases,
  resolveAlias,
  resolveAliasPath,
  sameAliasRecord,
  saveAlias,
} from "../packages/cli/src/aliases.ts";
import { createPersistenceBlocker } from "../packages/cli/src/credentials.ts";
import {
  normalizeWorkspace,
  workspaceCapabilities,
  workspaceStateLabel,
} from "../packages/cli/src/workspace.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(process.cwd(), ".tmp-alias-tests-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

type AliasEntry = readonly [string, AliasRecord];

async function loadConflictMessages(
  path: string,
  variants: ReadonlyArray<ReadonlyArray<AliasEntry>>,
): Promise<string[]> {
  const messages: string[] = [];
  for (const entries of variants) {
    await writeFile(path, JSON.stringify({ version: 1, aliases: Object.fromEntries(entries) }));
    try {
      await loadAliases(path);
      throw new Error("expected conflicting aliases to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AliasStoreError);
      messages.push((error as Error).message);
    }
  }
  return messages;
}

describe("global aliases", () => {
  test("resolves Unix XDG and Windows roaming paths without using cwd", () => {
    expect(resolveAliasPath({ platform: "linux", home: "/home/test", env: { XDG_CONFIG_HOME: "/xdg" } }))
      .toBe("/xdg/llm-now/aliases.json");
    expect(resolveAliasPath({ platform: "darwin", home: "/Users/test", env: {} }))
      .toBe("/Users/test/.config/llm-now/aliases.json");
    expect(resolveAliasPath({ platform: "win32", home: "C:\\Users\\test", env: { APPDATA: "D:\\Roaming" } }))
      .toBe("D:\\Roaming\\llm-now\\aliases.json");
    expect(resolveAliasPath({ platform: "win32", home: "C:\\Users\\test", env: {} }))
      .toBe("C:\\Users\\test\\AppData\\Roaming\\llm-now\\aliases.json");
    expect(resolveAliasPath({ platform: "linux", home: "/home/test", env: { XDG_CONFIG_HOME: "" } }))
      .toBe("/home/test/.config/llm-now/aliases.json");
    expect(resolveAliasPath({ platform: "linux", home: "/home/test", env: { XDG_CONFIG_HOME: "relative" } }))
      .toBe("/home/test/.config/llm-now/aliases.json");
    expect(resolveAliasPath({ platform: "win32", home: "C:\\Users\\test", env: { APPDATA: "" } }))
      .toBe("C:\\Users\\test\\AppData\\Roaming\\llm-now\\aliases.json");
    expect(resolveAliasPath({ platform: "win32", home: "C:\\Users\\test", env: { APPDATA: "relative" } }))
      .toBe("C:\\Users\\test\\AppData\\Roaming\\llm-now\\aliases.json");
  });

  test("loads the versioned fixture and resolves nullable models", async () => {
    const store = await loadAliases(join(import.meta.dir, "fixtures/aliases/valid.json"));
    expect(store.aliases.daily).toEqual({ provider: "ollama", model: "llama3" });
    expect(store.aliases.claude).toEqual({ provider: "claude-cli", model: null });
  });

  test("loads version 2 instructions exactly without rewriting the store", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");
    const text = `${JSON.stringify({
      version: 2,
      aliases: {
        fred: {
          provider: "codex-cli",
          model: null,
          instructions: "You are a realtime voice architect.\nFocus on interruption handling.",
        },
        plain: { provider: "ollama", model: "llama3" },
      },
    }, null, 2)}\n`;
    await writeFile(path, text);

    expect(await loadAliases(path)).toEqual({
      version: 2,
      aliases: {
        fred: {
          provider: "codex-cli",
          model: null,
          instructions: "You are a realtime voice architect.\nFocus on interruption handling.",
        },
        plain: { provider: "ollama", model: "llama3" },
      },
    });
    expect(await readFile(path, "utf8")).toBe(text);
  });

  test("loads version 3 workspaces exactly without rewriting the store", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");
    const text = `${JSON.stringify({
      version: 3,
      aliases: {
        fred: {
          provider: "codex-cli",
          model: null,
          instructions: "Review both projects.",
          workspace: {
            primaryDirectory: "/projects/api",
            additionalDirectories: ["/projects/web", "/projects/shared lib"],
          },
        },
        plain: { provider: "ollama", model: "llama3" },
      },
    }, null, 2)}\n`;
    await writeFile(path, text);

    expect(await loadAliases(path)).toEqual({
      version: 3,
      aliases: {
        fred: {
          provider: "codex-cli",
          model: null,
          instructions: "Review both projects.",
          workspace: {
            primaryDirectory: "/projects/api",
            additionalDirectories: ["/projects/web", "/projects/shared lib"],
            directoryAccess: "read-only",
          },
        },
        plain: { provider: "ollama", model: "llama3" },
      },
    });
    expect(await readFile(path, "utf8")).toBe(text);
  });

  test("normalizes saved aliases and resolves every ASCII casing", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");
    const record = { provider: "ollama" as const, model: "llama3.1" };

    expect(await saveAlias(path, "Fred", record)).toBe("saved");
    expect(await loadAliases(path)).toEqual({ version: 1, aliases: { fred: record } });
    await expect(resolveAlias(path, "fred")).resolves.toEqual(record);
    await expect(resolveAlias(path, "Fred")).resolves.toEqual(record);
    await expect(resolveAlias(path, "FRED")).resolves.toEqual(record);
  });

  test("collapses same-target legacy casing in memory without rewriting the store", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");
    const text = `${JSON.stringify({
      version: 1,
      aliases: {
        Fred: { provider: "ollama", model: "llama3.1" },
        fRED: { provider: "ollama", model: "llama3.1" },
      },
    }, null, 2)}\n`;
    await writeFile(path, text);

    expect(await loadAliases(path)).toEqual({
      version: 1,
      aliases: { fred: { provider: "ollama", model: "llama3.1" } },
    });
    expect(await readFile(path, "utf8")).toBe(text);

    expect(await saveAlias(path, "Other", { provider: "ollama", model: "other" })).toBe("saved");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      aliases: {
        fred: { provider: "ollama", model: "llama3.1" },
        other: { provider: "ollama", model: "other" },
      },
    });
  });

  test("fails closed deterministically for conflicting legacy casing in either JSON order", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");
    const variants = [
      [
        ["Fred", { provider: "ollama", model: "llama3.1" }],
        ["fRED", { provider: "codex-cli", model: null }],
      ],
      [
        ["fRED", { provider: "codex-cli", model: null }],
        ["Fred", { provider: "ollama", model: "llama3.1" }],
      ],
    ] as const;
    const messages = await loadConflictMessages(path, variants);

    expect(messages[0]).toBe(messages[1]);
    expect(messages[0]).toContain('case-insensitive alias "fred"');
    expect(messages[0]).toContain('"Fred" -> ollama/llama3.1');
    expect(messages[0]).toContain('"fRED" -> codex-cli/(default)');
    expect(messages[0]).toContain(path);
    expect(messages[0]).toContain("Edit the alias store manually");
  });

  test("reports a deterministic conflicting pair across three legacy variants", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");
    const variants = [
      [
        ["FRED", { provider: "ollama", model: "llama3.1" }],
        ["Fred", { provider: "ollama", model: "llama3.1" }],
        ["fRED", { provider: "codex-cli", model: null }],
      ],
      [
        ["fRED", { provider: "codex-cli", model: null }],
        ["Fred", { provider: "ollama", model: "llama3.1" }],
        ["FRED", { provider: "ollama", model: "llama3.1" }],
      ],
    ] as const;
    const messages = await loadConflictMessages(path, variants);

    expect(messages[0]).toBe(messages[1]);
    expect(messages[0]).toContain('"FRED" -> ollama/llama3.1');
    expect(messages[0]).toContain('"fRED" -> codex-cli/(default)');
    expect(messages[0]).toContain('keep only one target for "fred"');
  });

  test("fails closed for corrupt JSON and invalid schema values", async () => {
    await expect(loadAliases(join(import.meta.dir, "fixtures/aliases/corrupt.json"))).rejects.toBeInstanceOf(
      AliasStoreError,
    );

    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");
    const invalidDocuments = [
      { version: 1, aliases: { daily: { provider: "unknown", model: "x" } } },
      { version: 1, aliases: { " bad": { provider: "ollama", model: "x" } } },
      { version: 1, aliases: { daily: { provider: "ollama", model: null } } },
      { version: 1, aliases: { daily: { provider: "ollama", model: "" } } },
      { version: 1, aliases: { daily: { provider: "ollama", model: "x", apiKey: "secret" } } },
      { version: 1, aliases: { daily: { provider: "ollama", model: "x", instructions: "legacy" } } },
      { version: 2, aliases: { daily: { provider: "ollama", model: "x", instructions: "" } } },
      { version: 2, aliases: { daily: { provider: "ollama", model: "x", instructions: "   " } } },
      { version: 2, aliases: { daily: { provider: "ollama", model: "x", instructions: "bad\u0000value" } } },
      { version: 2, aliases: { daily: { provider: "ollama", model: "x", instructions: 42 } } },
      { version: 3, aliases: { daily: { provider: "ollama", model: "x", workspace: {
        primaryDirectory: "/project",
        additionalDirectories: [],
      } } } },
      { version: 3, aliases: { daily: { provider: "codex-cli", model: null, workspace: {
        primaryDirectory: "relative",
        additionalDirectories: [],
      } } } },
      { version: 3, aliases: { daily: { provider: "codex-cli", model: null, workspace: {
        primaryDirectory: "/project",
        additionalDirectories: ["/project"],
      } } } },
      { version: 3, aliases: { daily: { provider: "codex-cli", model: null, workspace: {
        primaryDirectory: "/project",
        additionalDirectories: ["/other", "/other"],
      } } } },
      { version: 3, aliases: { daily: { provider: "codex-cli", model: null, workspace: {
        primaryDirectory: "/project",
        additionalDirectories: [],
        unknown: true,
      } } } },
      { version: 3, aliases: { daily: { provider: "claude-cli", model: null, workspace: {
        primaryDirectory: "/project",
        additionalDirectories: [],
        directoryAccess: "read-write",
      } } } },
      { version: 3, aliases: { daily: { provider: "codex-cli", model: null, workspace: {
        primaryDirectory: "/project",
        additionalDirectories: [],
        directoryAccess: "write",
      } } } },
    ];

    for (const document of invalidDocuments) {
      await writeFile(path, JSON.stringify(document));
      await expect(loadAliases(path)).rejects.toBeInstanceOf(AliasStoreError);
    }

    await expect(resolveAlias(path, "bad name")).rejects.toThrow("invalid alias name: bad name");
    await expect(saveAlias(path, "_bad", { provider: "ollama", model: "x" }))
      .rejects.toThrow("invalid alias name: _bad");
  });

  test("migrates only when instructions are first stored and never downgrades version 2", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");
    await writeFile(path, `${JSON.stringify({
      version: 1,
      aliases: { existing: { provider: "ollama", model: "existing" } },
    }, null, 2)}\n`);

    expect(await saveAlias(path, "plain", { provider: "ollama", model: "plain" })).toBe("saved");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      aliases: {
        existing: { provider: "ollama", model: "existing" },
        plain: { provider: "ollama", model: "plain" },
      },
    });

    expect(await saveAlias(path, "fred", {
      provider: "codex-cli",
      model: null,
      instructions: "Architect realtime voice systems.\nFocus on interruptions.",
    })).toBe("saved");
    const instructed = await loadAliases(path);
    expect(instructed.version).toBe(2);
    expect(instructed.aliases.fred?.instructions).toBe(
      "Architect realtime voice systems.\nFocus on interruptions.",
    );
    expect(instructed.aliases.existing).toEqual({
      provider: "ollama",
      model: "existing",
    });

    expect(await saveAlias(path, "fred", { provider: "codex-cli", model: null }, {
      confirmOverwrite: async () => true,
    })).toBe("saved");
    expect(await loadAliases(path)).toEqual({
      version: 2,
      aliases: {
        existing: { provider: "ollama", model: "existing" },
        fred: { provider: "codex-cli", model: null },
        plain: { provider: "ollama", model: "plain" },
      },
    });
  });

  test("upgrades to version 3 for workspace and never downgrades it", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");
    await writeFile(path, `${JSON.stringify({ version: 1, aliases: {} })}\n`);
    const workspace = {
      primaryDirectory: "/projects/api",
      additionalDirectories: ["/projects/web"],
      directoryAccess: "read-write" as const,
    };

    expect(await saveAlias(path, "fred", {
      provider: "codex-cli",
      model: null,
      workspace,
    })).toBe("saved");
    expect(await loadAliases(path)).toEqual({
      version: 3,
      aliases: {
        fred: { provider: "codex-cli", model: null, workspace },
      },
    });

    expect(await saveAlias(path, "fred", { provider: "codex-cli", model: null }, {
      confirmOverwrite: async () => true,
    })).toBe("saved");
    expect(await loadAliases(path)).toEqual({
      version: 3,
      aliases: { fred: { provider: "codex-cli", model: null } },
    });
  });

  test("uses complete records for equality and case-insensitive overwrite identity", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");
    const original = {
      provider: "ollama" as const,
      model: "model",
      instructions: "First role",
    };
    await saveAlias(path, "Fred", original);

    await expect(saveAlias(path, "FRED", original)).resolves.toBe("already-saved");
    await expect(saveAlias(path, "fred", { ...original, instructions: "Second role" }))
      .rejects.toBeInstanceOf(AliasCollisionError);
    await expect(saveAlias(path, "fReD", { ...original, instructions: "Second role" }, {
      confirmOverwrite: async (_name, current) => {
        expect(current).toEqual(original);
        return true;
      },
    })).resolves.toBe("saved");
    await expect(resolveAlias(path, "FRED")).resolves.toEqual({
      ...original,
      instructions: "Second role",
    });
  });

  test("treats ordered workspace roots as complete alias identity", () => {
    const base: AliasRecord = {
      provider: "claude-cli",
      model: null,
      workspace: {
        primaryDirectory: "/projects/api",
        additionalDirectories: ["/projects/web", "/projects/shared"],
        directoryAccess: "read-only",
      },
    };

    expect(sameAliasRecord(base, structuredClone(base))).toBe(true);
    expect(sameAliasRecord(base, {
      ...base,
      workspace: {
        ...base.workspace!,
        additionalDirectories: ["/projects/shared", "/projects/web"],
      },
    })).toBe(false);
    expect(sameAliasRecord(base, {
      ...base,
      workspace: { ...base.workspace!, directoryAccess: "read-write" },
    })).toBe(false);
    expect(sameAliasRecord(base, { provider: "claude-cli", model: null })).toBe(false);
  });

  test("normalizes creation paths and exposes a complete capability matrix", () => {
    expect(normalizeWorkspace("./api", ["../web", "../shared lib"], "/projects/root")).toEqual({
      primaryDirectory: "/projects/root/api",
      additionalDirectories: ["/projects/web", "/projects/shared lib"],
      directoryAccess: "read-only",
    });
    expect(() => normalizeWorkspace("./api", ["./api"], "/projects/root"))
      .toThrow("workspace directories must be unique");
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
    expect(workspaceCapabilities("ollama")).toEqual({
      primaryDirectory: false,
      additionalDirectories: false,
      readWrite: false,
    });
    expect(workspaceStateLabel({
      primaryDirectory: "/projects/api",
      additionalDirectories: ["/projects/web", "/projects/shared"],
      directoryAccess: "read-write",
    })).toBe("read-write workspace +2");
  });

  test("rejects invalid instruction save input without creating storage artifacts", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "nested/aliases.json");
    const invalid = [
      "",
      "   ",
      "bad\tvalue",
      "bad\u007fvalue",
      "bad\u009fvalue",
      "bad\u2028value",
      "bad\u2029value",
    ];

    for (const instructions of invalid) {
      await expect(saveAlias(path, "fred", {
        provider: "ollama",
        model: "model",
        instructions,
      })).rejects.toThrow("invalid alias instructions");
    }
    expect(await readdir(directory)).toEqual([]);
  });

  test("blocks qualifying credentials before serialization or temporary-file creation", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");
    await saveAlias(path, "plain", { provider: "ollama", model: "plain" });
    const before = await readFile(path, "utf8");
    const beforeMode = (await stat(path)).mode;
    const blocker = createPersistenceBlocker({
      OPENAI_API_KEY: "x",
      ANTHROPIC_API_KEY: "qualifying-key",
    });

    expect(await saveAlias(path, "short", {
      provider: "ollama",
      model: "short",
      instructions: "Explain x clearly",
    }, { persistenceBlocker: blocker })).toBe("saved");
    const accepted = await readFile(path, "utf8");
    const acceptedMode = (await stat(path)).mode;
    const entriesBeforeRejection = await readdir(directory);

    await expect(saveAlias(path, "blocked", {
      provider: "ollama",
      model: "blocked",
      instructions: "Do not print qualifying-key",
    }, { persistenceBlocker: blocker })).rejects.toThrow(
      "instructions must not contain an API key",
    );
    expect(await readFile(path, "utf8")).toBe(accepted);
    expect((await stat(path)).mode).toBe(acceptedMode);
    expect(await readdir(directory)).toEqual(entriesBeforeRejection);
    expect(accepted).not.toBe(before);
    expect(beforeMode & 0o777).toBe(acceptedMode & 0o777);

    blocker.register("verified-short", "validated");
    await expect(saveAlias(path, "verified", {
      provider: "ollama",
      model: "verified",
      instructions: "Contains verified-short here",
    }, { persistenceBlocker: blocker })).rejects.toThrow(
      "instructions must not contain an API key",
    );
  });

  test("creates migration temporary files with restrictive permissions", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");
    await writeFile(path, `${JSON.stringify({ version: 1, aliases: {} })}\n`);
    let temporaryMode: number | undefined;

    await saveAlias(path, "fred", {
      provider: "ollama",
      model: "model",
      instructions: "Be concise",
    }, {}, {
      rename: async (from, to) => {
        temporaryMode = (await stat(from)).mode & 0o777;
        await rename(from, to);
      },
    });

    if (process.platform !== "win32") expect(temporaryMode).toBe(0o600);
    expect((await loadAliases(path)).version).toBe(2);
  });

  test("rereads under the lock while concurrent saves migrate version 1", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");
    await writeFile(path, `${JSON.stringify({
      version: 1,
      aliases: { existing: { provider: "ollama", model: "existing" } },
    })}\n`);

    await Promise.all([
      saveAlias(path, "instructed", {
        provider: "ollama",
        model: "first",
        instructions: "Be concise",
      }),
      saveAlias(path, "plain", { provider: "ollama", model: "second" }),
    ]);

    expect(await loadAliases(path)).toEqual({
      version: 2,
      aliases: {
        existing: { provider: "ollama", model: "existing" },
        instructed: {
          provider: "ollama",
          model: "first",
          instructions: "Be concise",
        },
        plain: { provider: "ollama", model: "second" },
      },
    });
  });

  test("keeps a committed migration valid when rename acknowledgement is lost", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");
    await writeFile(path, `${JSON.stringify({ version: 1, aliases: {} })}\n`);
    let renamed = false;

    await expect(saveAlias(path, "fred", {
      provider: "ollama",
      model: "model",
      instructions: "Be concise",
    }, {}, {
      rename: async (from, to) => {
        await rename(from, to);
        renamed = true;
        throw new Error("lost acknowledgement");
      },
    })).rejects.toThrow("lost acknowledgement");
    expect(renamed).toBe(true);
    expect((await loadAliases(path)).version).toBe(2);
    await expect(saveAlias(path, "fred", {
      provider: "ollama",
      model: "model",
      instructions: "Be concise",
    })).resolves.toBe("already-saved");
  });

  test("writes only version, alias names, provider, and nullable model", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "config/aliases.json");
    const credential = "credential-must-not-be-written";
    const record = { provider: "claude-cli" as const, model: null, apiKey: credential };

    expect(await saveAlias(path, "daily", record)).toBe("saved");
    const text = await readFile(path, "utf8");
    expect(JSON.parse(text)).toEqual({
      version: 1,
      aliases: { daily: { provider: "claude-cli", model: null } },
    });
    expect(text).not.toContain(credential);
    expect(await resolveAlias(path, "daily")).toEqual({ provider: "claude-cli", model: null });
    await expect(resolveAlias(path, "missing")).rejects.toThrow("alias not found");
    if (process.platform !== "win32") {
      expect((await stat(join(directory, "config"))).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  test("treats inherited object names as absent until explicitly saved", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");

    await expect(resolveAlias(path, "toString")).rejects.toThrow("alias not found");
    await expect(resolveAlias(path, "constructor")).rejects.toThrow("alias not found");
    await expect(saveAlias(path, "toString", { provider: "ollama", model: "model" }))
      .resolves.toBe("saved");
    await expect(saveAlias(path, "constructor", { provider: "ollama", model: "second" }))
      .resolves.toBe("saved");
    await expect(resolveAlias(path, "toString")).resolves.toEqual({
      provider: "ollama",
      model: "model",
    });
    await expect(resolveAlias(path, "CONSTRUCTOR")).resolves.toEqual({
      provider: "ollama",
      model: "second",
    });
    expect(await loadAliases(path)).toEqual({
      version: 1,
      aliases: {
        constructor: { provider: "ollama" as const, model: "second" },
        tostring: { provider: "ollama" as const, model: "model" },
      },
    });
  });

  test("preserves the prior file when atomic replacement fails", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");
    await writeFile(path, JSON.stringify({ version: 1, aliases: { old: { provider: "ollama", model: "old" } } }));

    await expect(
      saveAlias(path, "new", { provider: "ollama", model: "new" }, {}, {
        rename: async () => { throw new Error("injected rename failure"); },
      }),
    ).rejects.toThrow("injected rename failure");
    expect(await loadAliases(path)).toEqual({
      version: 1,
      aliases: { old: { provider: "ollama", model: "old" } },
    });
    expect((await readdir(directory)).filter((entry) => entry !== "aliases.json")).toEqual([]);
  });

  test("distinguishes same-target, declined, and saved collision outcomes", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");
    await saveAlias(path, "daily", { provider: "ollama", model: "old" });

    await expect(saveAlias(path, "daily", { provider: "ollama", model: "new" })).rejects.toBeInstanceOf(
      AliasCollisionError,
    );
    let sameTargetConfirmed = false;
    expect(await saveAlias(path, "daily", { provider: "ollama", model: "old" }, {
      confirmOverwrite: async () => {
        sameTargetConfirmed = true;
        return true;
      },
    })).toBe("already-saved");
    expect(sameTargetConfirmed).toBe(false);
    expect(await saveAlias(path, "daily", { provider: "ollama", model: "new" }, {
      confirmOverwrite: async () => false,
    })).toBe("declined");
    expect((await loadAliases(path)).aliases.daily?.model).toBe("old");
    expect(await saveAlias(path, "daily", { provider: "ollama", model: "new" }, {
      confirmOverwrite: async () => true,
    })).toBe("saved");
    expect((await loadAliases(path)).aliases.daily?.model).toBe("new");
  });

  test("applies collision and overwrite behavior across alias casing", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");
    const oldRecord = { provider: "ollama" as const, model: "old" };
    const newRecord = { provider: "ollama" as const, model: "new" };
    await saveAlias(path, "Fred", oldRecord);

    await expect(saveAlias(path, "FRED", oldRecord)).resolves.toBe("already-saved");
    await expect(saveAlias(path, "fReD", newRecord)).rejects.toBeInstanceOf(AliasCollisionError);
    const confirmations: string[] = [];
    await expect(saveAlias(path, "FRED", newRecord, {
      confirmOverwrite: async (name, current) => {
        confirmations.push(`${name}:${current?.model}`);
        return true;
      },
    })).resolves.toBe("saved");
    expect(confirmations).toEqual(["fred:old"]);
    expect(await loadAliases(path)).toEqual({ version: 1, aliases: { fred: newRecord } });
  });

  test("does not hold the alias lock while waiting for overwrite confirmation", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");
    await saveAlias(path, "daily", { provider: "ollama", model: "old" });
    let releaseConfirmation!: () => void;
    const confirmationReleased = new Promise<void>((resolve) => releaseConfirmation = resolve);
    let confirmationStarted!: () => void;
    const started = new Promise<void>((resolve) => confirmationStarted = resolve);

    const overwrite = saveAlias(path, "daily", { provider: "ollama", model: "new" }, {
      confirmOverwrite: async () => {
        confirmationStarted();
        await confirmationReleased;
        return true;
      },
    });
    await started;
    let concurrentError: unknown;
    try {
      const result = await saveAlias(path, "other", { provider: "ollama", model: "other" }, {
        lockTimeoutMs: 20,
        retryDelayMs: 1,
      });
      expect(result).toBe("saved");
    } catch (error) {
      concurrentError = error;
    } finally {
      releaseConfirmation();
    }
    await expect(overwrite).resolves.toBe("saved");
    if (concurrentError !== undefined) throw concurrentError;
    expect(Object.keys((await loadAliases(path)).aliases).sort()).toEqual(["daily", "other"]);
  });

  test("reconfirms when the target changes after approval", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");
    await saveAlias(path, "daily", { provider: "ollama", model: "old" });
    const observed: string[] = [];

    expect(await saveAlias(path, "daily", { provider: "ollama", model: "new" }, {
      confirmOverwrite: async (_name, current) => {
        observed.push(current?.model ?? "missing");
        if (observed.length === 1) {
          await saveAlias(path, "daily", { provider: "ollama", model: "third" }, {
            confirmOverwrite: async () => true,
            lockTimeoutMs: 20,
            retryDelayMs: 1,
          });
        }
        return true;
      },
    })).toBe("saved");
    expect(observed).toEqual(["old", "third"]);
    expect((await loadAliases(path)).aliases.daily?.model).toBe("new");
  });

  test("reconfirms when the alias is deleted after approval", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");
    await saveAlias(path, "daily", { provider: "ollama", model: "old" });
    const observed: Array<string | null | undefined> = [];

    expect(await saveAlias(path, "daily", { provider: "ollama", model: "new" }, {
      confirmOverwrite: async (_name, current) => {
        observed.push(current?.model);
        if (observed.length === 1) {
          await Bun.write(path, `${JSON.stringify({ version: 1, aliases: {} }, null, 2)}\n`);
          return true;
        }
        return false;
      },
    })).toBe("declined");
    expect(observed).toEqual(["old", undefined]);
    expect((await loadAliases(path)).aliases.daily).toBeUndefined();
  });

  test("serializes concurrent save processes and preserves both aliases", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");
    const worker = join(import.meta.dir, "fixtures/alias-save-worker.ts");
    const processes = [
      Bun.spawn([process.execPath, worker, path, "first", "model-a"]),
      Bun.spawn([process.execPath, worker, path, "second", "model-b"]),
    ];
    const exits = await Promise.all(processes.map((process) => process.exited));
    expect(exits).toEqual([0, 0]);
    expect(await loadAliases(path)).toEqual({
      version: 1,
      aliases: {
        first: { provider: "ollama", model: "model-a" },
        second: { provider: "ollama", model: "model-b" },
      },
    });
  });

  test("serializes concurrent same-target saves across alias casing", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");
    const worker = join(import.meta.dir, "fixtures/alias-save-worker.ts");
    const processes = [
      Bun.spawn([process.execPath, worker, path, "Fred", "model"]),
      Bun.spawn([process.execPath, worker, path, "FRED", "model"]),
    ];

    expect(await Promise.all(processes.map((process) => process.exited))).toEqual([0, 0]);
    expect(await loadAliases(path)).toEqual({
      version: 1,
      aliases: { fred: { provider: "ollama", model: "model" } },
    });
  });

  test("times out on an invalid lock without changing the store", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");
    await saveAlias(path, "old", { provider: "ollama", model: "old" });
    await mkdir(`${path}.lock`);

    await expect(saveAlias(path, "new", { provider: "ollama", model: "new" }, {
      lockTimeoutMs: 20,
      retryDelayMs: 1,
    })).rejects.toThrow("invalid alias lock");
    expect(Object.keys((await loadAliases(path)).aliases)).toEqual(["old"]);
  });

  test("recovers a stale lock by documented age and saves", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "aliases.json");
    await mkdir(directory, { recursive: true });
    await writeFile(`${path}.lock`, "stale");
    const old = new Date(Date.now() - 60_000);
    await utimes(`${path}.lock`, old, old);

    await expect(saveAlias(path, "daily", { provider: "ollama", model: "model" }, {
      staleLockMs: 1_000,
    })).resolves.toBe("saved");
    expect((await loadAliases(path)).aliases.daily?.model).toBe("model");
  });
});

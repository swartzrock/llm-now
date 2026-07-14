import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AliasCollisionError,
  AliasStoreError,
  loadAliases,
  resolveAlias,
  resolveAliasPath,
  saveAlias,
} from "../src/aliases.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(process.cwd(), ".tmp-alias-tests-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

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
    ];

    for (const document of invalidDocuments) {
      await writeFile(path, JSON.stringify(document));
      await expect(loadAliases(path)).rejects.toBeInstanceOf(AliasStoreError);
    }
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
    await expect(resolveAlias(path, "toString")).resolves.toEqual({
      provider: "ollama",
      model: "model",
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

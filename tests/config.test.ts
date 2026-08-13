import { afterEach, describe, expect, test } from "bun:test";
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ConfigSchemaError,
  parseConfigDocument,
  projectAliases,
  projectVoiceConfig,
  serializeConfigDocument,
} from "../src/config-schema.ts";
import {
  ConfigTransactionError,
  loadConfig,
  loadConfigSnapshot,
  migrateConfig,
  resolveConfigPaths,
  saveConfigAlias,
} from "../src/config.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(process.cwd(), ".tmp-config-tests-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("unified configuration paths", () => {
  test("resolves unified and legacy paths with absolute environment roots only", () => {
    expect(resolveConfigPaths({
      platform: "linux",
      home: "/home/test",
      env: { XDG_CONFIG_HOME: "/xdg" },
    })).toEqual({
      configPath: "/xdg/llm-now/config.toml",
      legacyAliasPath: "/xdg/llm-now/aliases.json",
      legacyVoicePath: "/xdg/llm-now/voice-router.toml",
    });
    expect(resolveConfigPaths({
      platform: "linux",
      home: "/home/test",
      env: { XDG_CONFIG_HOME: "relative" },
    }).configPath).toBe("/home/test/.config/llm-now/config.toml");
    expect(resolveConfigPaths({
      platform: "win32",
      home: "C:\\Users\\test",
      env: { APPDATA: "relative" },
    })).toEqual({
      configPath: "C:\\Users\\test\\AppData\\Roaming\\llm-now\\config.toml",
      legacyAliasPath: "C:\\Users\\test\\AppData\\Roaming\\llm-now\\aliases.json",
      legacyVoicePath: "C:\\Users\\test\\AppData\\Roaming\\llm-now\\voice-router.toml",
    });
  });
});

describe("configuration read authority", () => {
  test("uses valid unified values over conflicting legacy stores in one frozen snapshot", async () => {
    const root = await temporaryDirectory();
    const directory = join(root, "llm-now");
    await mkdir(directory);
    const paths = {
      configPath: join(directory, "config.toml"),
      legacyAliasPath: join(directory, "aliases.json"),
      legacyVoicePath: join(directory, "voice-router.toml"),
    };
    await writeFile(paths.configPath, `
      version = 1
      [voice]
      min_similarity = 72
      [aliases.unified]
      provider = "ollama"
      model = "unified-model"
      spoken_names = ["primary"]
    `);
    await writeFile(paths.legacyAliasPath, JSON.stringify({
      version: 1,
      aliases: { legacy: { provider: "ollama", model: "legacy-model" } },
    }));
    await writeFile(paths.legacyVoicePath, "[legacy]\nspoken_names = ['secondary']\n");

    const snapshot = await loadConfigSnapshot(paths, { includeLegacyVoice: true });

    expect(snapshot.authority).toBe("unified");
    expect(snapshot.aliases).toEqual({
      unified: { provider: "ollama", model: "unified-model" },
    });
    expect(snapshot.voice).toEqual({
      wakeWords: ["hey"],
      minFuzzyPhraseLength: 4,
      minSimilarity: 72,
      minMargin: 15,
      profiles: { unified: { spokenNames: ["primary"] } },
    });
    expect(Object.isFrozen(snapshot)).toBeTrue();
    expect(Object.isFrozen(snapshot.aliases)).toBeTrue();
    expect(Object.isFrozen(snapshot.voice)).toBeTrue();
  });

  test("fails closed on malformed unified content instead of reading valid legacy data", async () => {
    const root = await temporaryDirectory();
    const directory = join(root, "llm-now");
    await mkdir(directory);
    const paths = {
      configPath: join(directory, "config.toml"),
      legacyAliasPath: join(directory, "aliases.json"),
      legacyVoicePath: join(directory, "voice-router.toml"),
    };
    await writeFile(paths.configPath, "version = 2\n[aliases]\n");
    await writeFile(paths.legacyAliasPath, JSON.stringify({ version: 1, aliases: {} }));

    expect(loadConfigSnapshot(paths)).rejects.toBeInstanceOf(ConfigSchemaError);
  });

  test("keeps missing-unified legacy reads compatible and performs no writes", async () => {
    const root = await temporaryDirectory();
    const directory = join(root, "llm-now");
    await mkdir(directory);
    const paths = {
      configPath: join(directory, "config.toml"),
      legacyAliasPath: join(directory, "aliases.json"),
      legacyVoicePath: join(directory, "voice-router.toml"),
    };
    await writeFile(paths.legacyAliasPath, JSON.stringify({
      version: 2,
      aliases: { legacy: { provider: "ollama", model: "legacy-model" } },
    }));
    await writeFile(paths.legacyVoicePath, "[legacy]\nspoken_names = ['secondary']\nrate = 205\n");
    const before = await readdir(directory);

    const snapshot = await loadConfigSnapshot(paths, { includeLegacyVoice: true });

    expect(snapshot.authority).toBe("legacy");
    expect(snapshot.aliases).toEqual({
      legacy: { provider: "ollama", model: "legacy-model" },
    });
    expect(snapshot.voice.profiles.legacy).toEqual({
      spokenNames: ["secondary"],
      rate: 205,
    });
    expect(await readdir(directory)).toEqual(before);
  });
});

describe("configuration transactions", () => {
  test("migrates exact legacy bytes, attaches active profiles, and reports stale profiles", async () => {
    const directory = await temporaryDirectory();
    const paths = {
      configPath: join(directory, "config.toml"),
      legacyAliasPath: join(directory, "aliases.json"),
      legacyVoicePath: join(directory, "voice-router.toml"),
    };
    const aliases = `${JSON.stringify({
      version: 2,
      aliases: {
        active: { provider: "ollama", model: "legacy", instructions: "Keep exact" },
      },
    }, null, 2)}\n`;
    const voice = `wake_words = ["computer"]\n\n[active]\nspoken_names = ["primary"]\nvoice = "Samantha"\nrate = 205\n\n[zed]\nvoice = "Alex"\n\n[alpha]\npitch = 45\n`;
    await writeFile(paths.legacyAliasPath, aliases);
    await writeFile(paths.legacyVoicePath, voice);

    const result = await migrateConfig(paths);

    expect(result).toEqual({ kind: "migrated", staleProfiles: ["alpha", "zed"] });
    expect(await readFile(`${paths.legacyAliasPath}.pre-unified-v1.bak`, "utf8")).toBe(aliases);
    expect(await readFile(`${paths.legacyVoicePath}.pre-unified-v1.bak`, "utf8")).toBe(voice);
    expect(await readFile(paths.legacyAliasPath, "utf8")).toBe(aliases);
    expect(await readFile(paths.legacyVoicePath, "utf8")).toBe(voice);
    expect(await loadConfig(paths.configPath)).toEqual({
      version: 1,
      voice: { wakeWords: ["computer"] },
      aliases: {
        active: {
          provider: "ollama",
          model: "legacy",
          instructions: "Keep exact",
          spokenNames: ["primary"],
          voice: "Samantha",
          rate: 205,
        },
      },
    });
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      for (const path of [
        paths.configPath,
        `${paths.legacyAliasPath}.pre-unified-v1.bak`,
        `${paths.legacyVoicePath}.pre-unified-v1.bak`,
      ]) expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  test("creates deterministic sparse configs for missing legacy inputs", async () => {
    const bothMissingDirectory = await temporaryDirectory();
    const bothMissing = {
      configPath: join(bothMissingDirectory, "config.toml"),
      legacyAliasPath: join(bothMissingDirectory, "aliases.json"),
      legacyVoicePath: join(bothMissingDirectory, "voice-router.toml"),
    };
    expect(await migrateConfig(bothMissing)).toEqual({
      kind: "created-empty",
      staleProfiles: [],
    });
    expect(await loadConfig(bothMissing.configPath)).toEqual({ version: 1, aliases: {} });
    expect((await readdir(bothMissingDirectory)).sort()).toEqual(["config.toml"]);

    const oneMissingDirectory = await temporaryDirectory();
    const oneMissing = {
      configPath: join(oneMissingDirectory, "config.toml"),
      legacyAliasPath: join(oneMissingDirectory, "aliases.json"),
      legacyVoicePath: join(oneMissingDirectory, "voice-router.toml"),
    };
    const aliases = '{"version":1,"aliases":{}}\n';
    await writeFile(oneMissing.legacyAliasPath, aliases);
    expect(await migrateConfig(oneMissing)).toEqual({ kind: "migrated", staleProfiles: [] });
    expect(await readFile(`${oneMissing.legacyAliasPath}.pre-unified-v1.bak`, "utf8"))
      .toBe(aliases);
    expect(await Bun.file(`${oneMissing.legacyVoicePath}.pre-unified-v1.bak`).exists()).toBeFalse();
  });

  test("validates existing unified authority before returning already-unified", async () => {
    const directory = await temporaryDirectory();
    const paths = {
      configPath: join(directory, "config.toml"),
      legacyAliasPath: join(directory, "aliases.json"),
      legacyVoicePath: join(directory, "voice-router.toml"),
    };
    await writeFile(paths.configPath, "version = 2\n[aliases]\n");
    await expect(migrateConfig(paths)).rejects.toBeInstanceOf(ConfigSchemaError);
    await writeFile(paths.configPath, "version = 1\n[aliases]\n");
    expect(await migrateConfig(paths)).toEqual({ kind: "already-unified", staleProfiles: [] });
  });

  test("rejects mismatched backups without publishing unified authority", async () => {
    const directory = await temporaryDirectory();
    const paths = {
      configPath: join(directory, "config.toml"),
      legacyAliasPath: join(directory, "aliases.json"),
      legacyVoicePath: join(directory, "voice-router.toml"),
    };
    await writeFile(paths.legacyAliasPath, '{"version":1,"aliases":{}}\n');
    await writeFile(`${paths.legacyAliasPath}.pre-unified-v1.bak`, "different bytes");

    await expect(migrateConfig(paths)).rejects.toThrow("legacy backup does not match source");
    expect(await Bun.file(paths.configPath).exists()).toBeFalse();
  });

  test("aborts a changed legacy snapshot and succeeds from a new coherent snapshot", async () => {
    const directory = await temporaryDirectory();
    const paths = {
      configPath: join(directory, "config.toml"),
      legacyAliasPath: join(directory, "aliases.json"),
      legacyVoicePath: join(directory, "voice-router.toml"),
    };
    await writeFile(paths.legacyAliasPath, '{"version":1,"aliases":{}}\n');
    let changed = false;
    await expect(migrateConfig(paths, {}, {
      afterLegacyBackups: async () => {
        changed = true;
        await writeFile(paths.legacyAliasPath, '{"version":1,"aliases":{"new":{"provider":"ollama","model":"m"}}}\n');
      },
    })).rejects.toThrow("legacy configuration changed during migration");
    expect(changed).toBeTrue();
    expect(await Bun.file(paths.configPath).exists()).toBeFalse();

    expect(await migrateConfig(paths)).toEqual({ kind: "migrated", staleProfiles: [] });
    expect((await loadConfig(paths.configPath))?.aliases.new?.model).toBe("m");
  });

  test("preserves every unrelated unified override during an alias save", async () => {
    const directory = await temporaryDirectory();
    const paths = {
      configPath: join(directory, "config.toml"),
      legacyAliasPath: join(directory, "aliases.json"),
      legacyVoicePath: join(directory, "voice-router.toml"),
    };
    await writeFile(paths.configPath, `# normalize me\nversion = 1\n[voice]\nwake_words = []\nmin_similarity = 72\n[aliases.keep]\nprovider = "ollama"\nmodel = "old"\nspoken_names = []\nvoice = "Alex"\nrate = 210\npitch = 48\n[aliases.change]\nprovider = "ollama"\nmodel = "before"\nvoice = "Samantha"\n`);

    expect(await saveConfigAlias(paths, "change", { provider: "ollama", model: "after" }, {
      confirmOverwrite: async () => true,
    })).toBe("saved");

    expect(await loadConfig(paths.configPath)).toEqual({
      version: 1,
      voice: { wakeWords: [], minSimilarity: 72 },
      aliases: {
        change: { provider: "ollama", model: "after", voice: "Samantha" },
        keep: {
          provider: "ollama",
          model: "old",
          spokenNames: [],
          voice: "Alex",
          rate: 210,
          pitch: 48,
        },
      },
    });
    expect(await readFile(paths.configPath, "utf8")).not.toContain("normalize me");
  });

  test("persists workspace changes in unified configuration", async () => {
    const directory = await temporaryDirectory();
    const paths = {
      configPath: join(directory, "config.toml"),
      legacyAliasPath: join(directory, "aliases.json"),
      legacyVoicePath: join(directory, "voice-router.toml"),
    };
    const workspace = {
      primaryDirectory: resolve(directory, "primary"),
      additionalDirectories: [
        resolve(directory, "additional"),
        resolve(directory, "additional with spaces"),
      ],
      directoryAccess: "read-write" as const,
    };

    expect(await saveConfigAlias(paths, "daily", {
      provider: "codex-cli",
      model: null,
      workspace,
    })).toBe("saved");
    expect((await loadConfig(paths.configPath))?.aliases.daily).toEqual({
      provider: "codex-cli",
      model: "default",
      workspace,
    });
    expect(projectAliases((await loadConfig(paths.configPath))!)).toEqual({
      daily: { provider: "codex-cli", model: null, workspace },
    });
    const saved = await readFile(paths.configPath, "utf8");
    expect(saved).toContain("directories = [");
    expect(saved).not.toContain("[aliases.daily.workspace]");

    expect(await saveConfigAlias(paths, "daily", {
      provider: "codex-cli",
      model: null,
    }, { confirmOverwrite: async () => true })).toBe("saved");
    expect((await loadConfig(paths.configPath))?.aliases.daily?.workspace).toBeUndefined();
  });

  test("migrates a legacy v3 workspace into unified version 1", async () => {
    const directory = await temporaryDirectory();
    const paths = {
      configPath: join(directory, "config.toml"),
      legacyAliasPath: join(directory, "aliases.json"),
      legacyVoicePath: join(directory, "voice-router.toml"),
    };
    const legacyWorkspace = {
      primaryDirectory: resolve(directory, "primary"),
      additionalDirectories: [resolve(directory, "additional")],
    };
    const workspace = {
      ...legacyWorkspace,
      directoryAccess: "read-only" as const,
    };
    const legacy = `${JSON.stringify({
      version: 3,
      aliases: {
        review: { provider: "claude-cli", model: null, workspace: legacyWorkspace },
      },
    })}\n`;
    await writeFile(paths.legacyAliasPath, legacy);

    expect(await migrateConfig(paths)).toEqual({ kind: "migrated", staleProfiles: [] });
    expect(await loadConfig(paths.configPath)).toEqual({
      version: 1,
      aliases: {
        review: { provider: "claude-cli", model: "default", workspace },
      },
    });
    expect(await readFile(paths.configPath, "utf8")).toContain('directory_access = "read-only"');
    expect(await readFile(`${paths.legacyAliasPath}.pre-unified-v1.bak`, "utf8")).toBe(legacy);
  });

  test("decline performs no migration, backup, lock, or unified write", async () => {
    const directory = await temporaryDirectory();
    const paths = {
      configPath: join(directory, "config.toml"),
      legacyAliasPath: join(directory, "aliases.json"),
      legacyVoicePath: join(directory, "voice-router.toml"),
    };
    await writeFile(paths.legacyAliasPath, '{"version":1,"aliases":{"daily":{"provider":"ollama","model":"old"}}}\n');
    const before = await readdir(directory);
    expect(await saveConfigAlias(paths, "daily", { provider: "ollama", model: "new" }, {
      confirmOverwrite: async () => false,
    })).toBe("declined");
    expect(await readdir(directory)).toEqual(before);
  });

  test("attaches a profile matching the alias created by automatic migration", async () => {
    const directory = await temporaryDirectory();
    const paths = {
      configPath: join(directory, "config.toml"),
      legacyAliasPath: join(directory, "aliases.json"),
      legacyVoicePath: join(directory, "voice-router.toml"),
    };
    await writeFile(paths.legacyVoicePath, "[new]\nvoice = 'Samantha'\nrate = 205\n");
    const stale: string[][] = [];

    expect(await saveConfigAlias(paths, "new", { provider: "ollama", model: "m" }, {
      onStaleProfiles: (names) => stale.push([...names]),
    })).toBe("saved");

    expect((await loadConfig(paths.configPath))?.aliases.new).toEqual({
      provider: "ollama",
      model: "m",
      voice: "Samantha",
      rate: 205,
    });
    expect(stale).toEqual([]);
  });

  test("keeps pre-commit filesystem faults retryable without publishing config", async () => {
    for (const fault of [
      "backup-temporary",
      "config-temporary",
      "backup-publication",
      "backup-sync",
      "config-publication",
    ] as const) {
      const directory = await temporaryDirectory();
      const paths = {
        configPath: join(directory, "config.toml"),
        legacyAliasPath: join(directory, "aliases.json"),
        legacyVoicePath: join(directory, "voice-router.toml"),
      };
      await writeFile(paths.legacyAliasPath, '{"version":1,"aliases":{}}\n');
      let syncCalls = 0;
      await expect(migrateConfig(paths, {}, {
        open: async (path, flags, mode) => {
          if (
            (fault === "backup-temporary" && String(path).includes(".backup-"))
            || (fault === "config-temporary" && String(path).includes(".config-"))
          ) {
            throw new Error("injected temporary failure");
          }
          return open(path, flags, mode);
        },
        link: async (from, to) => {
          if (fault === "backup-publication" && String(to).endsWith(".bak")) {
            throw new Error("injected backup publication failure");
          }
          if (fault === "config-publication" && to === paths.configPath) {
            throw new Error("injected config publication failure");
          }
          await link(from, to);
        },
        syncDirectory: async () => {
          syncCalls += 1;
          if (fault === "backup-sync" && syncCalls === 1) {
            throw new Error("injected directory sync failure");
          }
        },
      })).rejects.toThrow("injected");
      expect(await Bun.file(paths.configPath).exists(), fault).toBeFalse();
      expect((await readdir(directory)).every((name) => !name.endsWith(".tmp")), fault).toBeTrue();
      expect(await migrateConfig(paths)).toMatchObject({ kind: "migrated" });
    }
  });

  test("reuses the first backup when the second backup publication is retried", async () => {
    const directory = await temporaryDirectory();
    const paths = {
      configPath: join(directory, "config.toml"),
      legacyAliasPath: join(directory, "aliases.json"),
      legacyVoicePath: join(directory, "voice-router.toml"),
    };
    const aliases = '{"version":1,"aliases":{}}\n';
    const voice = "wake_words = ['computer']\n";
    await writeFile(paths.legacyAliasPath, aliases);
    await writeFile(paths.legacyVoicePath, voice);
    await expect(migrateConfig(paths, {}, {
      link: async (from, to) => {
        if (to === `${paths.legacyVoicePath}.pre-unified-v1.bak`) {
          throw new Error("injected second backup failure");
        }
        await link(from, to);
      },
    })).rejects.toThrow("injected second backup failure");
    expect(await Bun.file(`${paths.legacyAliasPath}.pre-unified-v1.bak`).text()).toBe(aliases);
    expect(await Bun.file(paths.configPath).exists()).toBeFalse();
    expect(await migrateConfig(paths)).toMatchObject({ kind: "migrated" });
    expect(await Bun.file(`${paths.legacyVoicePath}.pre-unified-v1.bak`).text()).toBe(voice);
  });

  test("recognizes a committed publication after acknowledgement is lost", async () => {
    const directory = await temporaryDirectory();
    const paths = {
      configPath: join(directory, "config.toml"),
      legacyAliasPath: join(directory, "aliases.json"),
      legacyVoicePath: join(directory, "voice-router.toml"),
    };
    await writeFile(paths.legacyAliasPath, '{"version":1,"aliases":{}}\n');
    await expect(migrateConfig(paths, {}, {
      link: async (from, to) => {
        await link(from, to);
        if (to === paths.configPath) throw new Error("lost publication acknowledgement");
      },
    })).rejects.toThrow("lost publication acknowledgement");
    expect(await Bun.file(paths.configPath).exists()).toBeTrue();
    expect(await migrateConfig(paths)).toEqual({ kind: "already-unified", staleProfiles: [] });
  });

  test("recognizes authority after a post-publication directory sync failure", async () => {
    const directory = await temporaryDirectory();
    const paths = {
      configPath: join(directory, "config.toml"),
      legacyAliasPath: join(directory, "aliases.json"),
      legacyVoicePath: join(directory, "voice-router.toml"),
    };
    await writeFile(paths.legacyAliasPath, '{"version":1,"aliases":{}}\n');
    let syncCalls = 0;
    await expect(migrateConfig(paths, {}, {
      syncDirectory: async () => {
        syncCalls += 1;
        if (syncCalls === 2) throw new Error("injected authority sync failure");
      },
    })).rejects.toThrow("injected authority sync failure");
    expect(await Bun.file(paths.configPath).exists()).toBeTrue();
    expect(await migrateConfig(paths)).toEqual({ kind: "already-unified", staleProfiles: [] });
  });

  // test("preserves unified authority across replacement failure and lost acknowledgement", async () => {
  //   for (const acknowledgeCommit of [false, true]) {
  //     const directory = await temporaryDirectory();
  //     const paths = {
  //       configPath: join(directory, "config.toml"),
  //       legacyAliasPath: join(directory, "aliases.json"),
  //       legacyVoicePath: join(directory, "voice-router.toml"),
  //     };
  //     await writeFile(paths.configPath, "version = 1\n[aliases.old]\nprovider = 'ollama'\nmodel = 'old'\n");
  //     await expect(saveConfigAlias(paths, "new", { provider: "ollama", model: "new" }, {}, {
  //       rename: async (from, to) => {
  //         if (acknowledgeCommit) await rename(from, to);
  //         throw new Error("lost replacement acknowledgement");
  //       },
  //     })).rejects.toThrow("lost replacement acknowledgement");
  //     const afterFailure = await loadConfig(paths.configPath);
  //     expect(afterFailure?.aliases.old?.model).toBe("old");
  //     expect(afterFailure?.aliases.new?.model).toBe(acknowledgeCommit ? "new" : undefined);
  //     expect(await saveConfigAlias(paths, "new", { provider: "ollama", model: "new" }))
  //       .toBe(acknowledgeCommit ? "already-saved" : "saved");
  //   }
  // });

  test("reconfirms outside the lock when the target changes after approval", async () => {
    const directory = await temporaryDirectory();
    const paths = {
      configPath: join(directory, "config.toml"),
      legacyAliasPath: join(directory, "aliases.json"),
      legacyVoicePath: join(directory, "voice-router.toml"),
    };
    await saveConfigAlias(paths, "daily", { provider: "ollama", model: "old" });
    const observed: Array<string | undefined> = [];

    expect(await saveConfigAlias(paths, "daily", { provider: "ollama", model: "new" }, {
      confirmOverwrite: async (_name, current) => {
        observed.push(current?.model ?? undefined);
        if (observed.length === 1) {
          await saveConfigAlias(paths, "daily", { provider: "ollama", model: "third" }, {
            confirmOverwrite: async () => true,
            lockTimeoutMs: 20,
            retryDelayMs: 1,
          });
        }
        return true;
      },
    })).toBe("saved");
    expect(observed).toEqual(["old", "third"]);
    expect((await loadConfig(paths.configPath))?.aliases.daily?.model).toBe("new");
  });

  test("serializes first saves and explicit migration across processes", async () => {
    const directory = await temporaryDirectory();
    const paths = {
      configPath: join(directory, "config.toml"),
      legacyAliasPath: join(directory, "aliases.json"),
      legacyVoicePath: join(directory, "voice-router.toml"),
    };
    await writeFile(paths.legacyAliasPath, '{"version":1,"aliases":{"legacy":{"provider":"ollama","model":"legacy"}}}\n');
    const worker = join(import.meta.dir, "fixtures/alias-save-worker.ts");
    const processes = [
      Bun.spawn([process.execPath, worker, paths.configPath, paths.legacyAliasPath, paths.legacyVoicePath, "first", "a"]),
      Bun.spawn([process.execPath, worker, paths.configPath, paths.legacyAliasPath, paths.legacyVoicePath, "second", "b"]),
      Bun.spawn([process.execPath, worker, "--migrate", paths.configPath, paths.legacyAliasPath, paths.legacyVoicePath]),
    ];
    expect(await Promise.all(processes.map((child) => child.exited))).toEqual([0, 0, 0]);
    expect(projectAliases((await loadConfig(paths.configPath))!)).toEqual({
      first: { provider: "ollama", model: "a" },
      legacy: { provider: "ollama", model: "legacy" },
      second: { provider: "ollama", model: "b" },
    });
  });

  test("does not break a stale-looking live lock and recovers a dead owner lock", async () => {
    const directory = await temporaryDirectory();
    const paths = {
      configPath: join(directory, "config.toml"),
      legacyAliasPath: join(directory, "aliases.json"),
      legacyVoicePath: join(directory, "voice-router.toml"),
    };
    const lockPath = `${paths.configPath}.lock`;
    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, token: "live" })}\n`, { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    await expect(saveConfigAlias(paths, "new", { provider: "ollama", model: "m" }, {
      lockTimeoutMs: 10,
      retryDelayMs: 1,
      staleLockMs: 1,
    })).rejects.toThrow("timed out waiting for configuration lock");
    expect(await readFile(lockPath, "utf8")).toContain('"token":"live"');

    await writeFile(lockPath, `${JSON.stringify({ pid: 999_999, token: "dead" })}\n`);
    await utimes(lockPath, old, old);
    expect(await saveConfigAlias(paths, "new", { provider: "ollama", model: "m" }, {
      staleLockMs: 1,
    }, { processIsAlive: () => false })).toBe("saved");
  });

  test("serializes concurrent stale-lock reclaimers without losing either save", async () => {
    const directory = await temporaryDirectory();
    const paths = {
      configPath: join(directory, "config.toml"),
      legacyAliasPath: join(directory, "aliases.json"),
      legacyVoicePath: join(directory, "voice-router.toml"),
    };
    const lockPath = `${paths.configPath}.lock`;
    await writeFile(lockPath, `${JSON.stringify({ pid: 999_999, token: "dead" })}\n`, {
      mode: 0o600,
    });
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const options = {
      lockTimeoutMs: 500,
      retryDelayMs: 1,
      staleLockMs: 1,
    };
    const dependencies = { processIsAlive: () => false };

    expect(await Promise.all([
      saveConfigAlias(paths, "first", { provider: "ollama", model: "a" }, options, dependencies),
      saveConfigAlias(paths, "second", { provider: "ollama", model: "b" }, options, dependencies),
    ])).toEqual(["saved", "saved"]);
    expect(projectAliases((await loadConfig(paths.configPath))!)).toEqual({
      first: { provider: "ollama", model: "a" },
      second: { provider: "ollama", model: "b" },
    });
    expect(await Bun.file(`${lockPath}.removal`).exists()).toBeFalse();
  });

  test("an old owner does not remove a replacement lock after an ABA sequence", async () => {
    const directory = await temporaryDirectory();
    const paths = {
      configPath: join(directory, "config.toml"),
      legacyAliasPath: join(directory, "aliases.json"),
      legacyVoicePath: join(directory, "voice-router.toml"),
    };
    const replacement = `${JSON.stringify({ pid: process.pid, token: "replacement" })}\n`;
    await migrateConfig(paths, {}, {
      afterLegacyBackups: async () => {
        await unlink(`${paths.configPath}.lock`);
        await writeFile(`${paths.configPath}.lock`, replacement, { mode: 0o600 });
      },
    });
    expect(await readFile(`${paths.configPath}.lock`, "utf8")).toBe(replacement);
    await unlink(`${paths.configPath}.lock`);
  });

  test("creates lock, temporary, backup, and unified files with owner-only modes", async () => {
    if (process.platform === "win32") return;
    const directory = await temporaryDirectory();
    const paths = {
      configPath: join(directory, "config.toml"),
      legacyAliasPath: join(directory, "aliases.json"),
      legacyVoicePath: join(directory, "voice-router.toml"),
    };
    await writeFile(paths.legacyAliasPath, '{"version":1,"aliases":{}}\n');
    const modes: Array<{ path: string; mode: number | undefined }> = [];
    await migrateConfig(paths, {}, {
      open: async (path, flags, mode) => {
        modes.push({ path: String(path), mode: typeof mode === "number" ? mode : undefined });
        return open(path, flags, mode);
      },
    });
    for (const entry of modes.filter(({ path }) => path.endsWith(".lock") || path.endsWith(".tmp"))) {
      expect(entry.mode, entry.path).toBe(0o600);
    }
    expect((await stat(paths.configPath)).mode & 0o777).toBe(0o600);
    expect((await stat(`${paths.legacyAliasPath}.pre-unified-v1.bak`)).mode & 0o777).toBe(0o600);
  });

  test("does not disclose source values through transaction failures", async () => {
    const directory = await temporaryDirectory();
    const paths = {
      configPath: join(directory, "config.toml"),
      legacyAliasPath: join(directory, "aliases.json"),
      legacyVoicePath: join(directory, "voice-router.toml"),
    };
    const sentinel = "sk-live-MIGRATION-SENTINEL";
    await writeFile(paths.legacyVoicePath, `[stale]\nvoice = "${sentinel}"\nbroken =\n`);
    let error: unknown;
    try {
      await migrateConfig(paths);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigTransactionError);
    expect(String(error)).not.toContain(sentinel);
    expect(String((error as Error).cause ?? "")).not.toContain(sentinel);
  });

  test("rejects malformed aliases and structurally invalid stale profiles before publication", async () => {
    for (const [aliasText, voiceText] of [
      ["{ broken", undefined],
      ['{"version":1,"aliases":{}}\n', "[stale]\nrate = 79\n"],
    ] as const) {
      const directory = await temporaryDirectory();
      const paths = {
        configPath: join(directory, "config.toml"),
        legacyAliasPath: join(directory, "aliases.json"),
        legacyVoicePath: join(directory, "voice-router.toml"),
      };
      await writeFile(paths.legacyAliasPath, aliasText);
      if (voiceText !== undefined) await writeFile(paths.legacyVoicePath, voiceText);
      await expect(migrateConfig(paths)).rejects.toBeInstanceOf(ConfigTransactionError);
      expect(await Bun.file(paths.configPath).exists()).toBeFalse();
      expect(await Bun.file(paths.legacyAliasPath).text()).toBe(aliasText);
      expect(await Bun.file(`${paths.legacyAliasPath}.pre-unified-v1.bak`).text()).toBe(aliasText);
      if (voiceText !== undefined) {
        expect(await Bun.file(paths.legacyVoicePath).text()).toBe(voiceText);
        expect(await Bun.file(`${paths.legacyVoicePath}.pre-unified-v1.bak`).text()).toBe(voiceText);
      }
    }
  });
});

describe("unified configuration schema", () => {
  test("round-trips capability-checked one-or-more directory workspaces", () => {
    const primaryDirectory = resolve("workspace", "primary");
    const additionalDirectories = [
      resolve("workspace", "additional"),
      resolve("workspace", "additional with spaces"),
    ];
    const document = parseConfigDocument(`
      version = 1
      [aliases.review]
      provider = "claude-cli"
      model = "default"
      directories = ${JSON.stringify([primaryDirectory, ...additionalDirectories])}
      directory_access = "read-only"
    `);

    expect(document.aliases.review?.workspace).toEqual({
      primaryDirectory,
      additionalDirectories,
      directoryAccess: "read-only",
    });
    expect(projectAliases(document).review?.workspace).toEqual({
      primaryDirectory,
      additionalDirectories,
      directoryAccess: "read-only",
    });
    const serialized = serializeConfigDocument(document);
    expect(serialized).not.toContain("[aliases.review.workspace]");
    expect(serialized).toContain("directories = [");
    expect(serialized).toContain('directory_access = "read-only"');
    expect(serialized).not.toContain("primary_directory");
    expect(serialized).not.toContain("additional_directories");
    expect(serializeConfigDocument(parseConfigDocument(serialized))).toBe(serialized);

    const primaryOnly = parseConfigDocument(`
      version = 1
      [aliases.review]
      provider = "claude-cli"
      model = "default"
      directories = [${JSON.stringify(primaryDirectory)}]
      directory_access = "read-only"
    `);
    expect(primaryOnly.aliases.review?.workspace).toEqual({
      primaryDirectory,
      additionalDirectories: [],
      directoryAccess: "read-only",
    });
    expect(serializeConfigDocument(primaryOnly)).toContain(
      `directories = [ ${JSON.stringify(primaryDirectory)} ]`,
    );
    expect(serializeConfigDocument(primaryOnly)).toContain('directory_access = "read-only"');
  });

  test("defaults omitted directory access to read-only", () => {
    const primaryDirectory = resolve("workspace", "primary");
    const document = parseConfigDocument(`
      version = 1
      [aliases.review]
      provider = "codex-cli"
      model = "default"
      directories = [${JSON.stringify(primaryDirectory)}]
    `);

    expect(document.aliases.review?.workspace).toEqual({
      primaryDirectory,
      additionalDirectories: [],
      directoryAccess: "read-only",
    });
    expect(projectAliases(document).review?.workspace?.directoryAccess).toBe("read-only");
    expect(serializeConfigDocument(document)).toContain('directory_access = "read-only"');
  });

  test("round-trips aliases canonically while retaining omission state", () => {
    const document = parseConfigDocument(`
      # removed by canonical rewrite
      version = 1

      [aliases."Slug"]
      provider = "codex-cli"
      model = "default"
      instructions = """Use Unicode: café ☕.
Keep this on two lines."""
    `, "/private/config.toml");

    expect(document).toEqual({
      version: 1,
      aliases: {
        slug: {
          provider: "codex-cli",
          model: "default",
          instructions: "Use Unicode: café ☕.\nKeep this on two lines.",
        },
      },
    });
    expect(projectAliases(document)).toEqual({
      slug: {
        provider: "codex-cli",
        model: null,
        instructions: "Use Unicode: café ☕.\nKeep this on two lines.",
      },
    });

    const serialized = serializeConfigDocument(document);
    expect(serialized).not.toContain("#");
    expect(serialized).not.toContain("wake_words");
    expect(serialized).not.toContain("spoken_names");
    expect(serialized).not.toContain("voice =");
    expect(serialized).not.toContain("rate =");
    expect(serialized).not.toContain("pitch =");
    expect(serializeConfigDocument(parseConfigDocument(serialized))).toBe(serialized);
    expect(Bun.TOML.parse(serialized)).toEqual(Bun.TOML.parse(serialized));
  });

  test("applies per-field defaults without replacing explicit empty lists", () => {
    const document = parseConfigDocument(`
      version = 1
      [voice]
      wake_words = []
      min_similarity = 72
      [aliases.slug]
      provider = "ollama"
      model = "llama3"
      spoken_names = []
      rate = 205
    `);

    expect(projectVoiceConfig(document)).toEqual({
      wakeWords: [],
      minFuzzyPhraseLength: 4,
      minSimilarity: 72,
      minMargin: 15,
      profiles: {
        slug: { spokenNames: [], rate: 205 },
      },
    });
    expect(serializeConfigDocument(document)).not.toContain("min_fuzzy_phrase_length");
    expect(serializeConfigDocument(document)).not.toContain("min_margin");
  });

  test("sorts aliases and fixes field order deterministically", () => {
    const document = parseConfigDocument(`
      version = 1
      [aliases.zed]
      pitch = 50
      rate = 205
      voice = "Samantha"
      spoken_names = ["zee"]
      instructions = "Zed"
      model = "z"
      provider = "ollama"
      [aliases.alpha]
      model = "a"
      provider = "ollama"
    `);
    const first = serializeConfigDocument(document);
    const second = serializeConfigDocument(parseConfigDocument(first));

    expect(second).toBe(first);
    expect(first.indexOf("[aliases.alpha]")).toBeLessThan(first.indexOf("[aliases.zed]"));
    expect(first.indexOf('provider = "ollama"', first.indexOf("[aliases.zed]")))
      .toBeLessThan(first.indexOf('model = "z"'));
    expect(first.indexOf('model = "z"')).toBeLessThan(first.indexOf('instructions = "Zed"'));
    expect(first.indexOf('instructions = "Zed"')).toBeLessThan(first.indexOf("spoken_names"));
  });

  test("rejects closed-schema, range, control, and collision failures", () => {
    const invalidDocuments = [
      "version = 2\n[aliases]",
      "version = 1.0\n[aliases]",
      "version = 1\ncredential = 'secret'\n[aliases]",
      "version = 1\n[aliases.slug]\nprovider='ollama'\nmodel='default'",
      "version = 1\n[voice]\nmin_fuzzy_phrase_length=0\n[aliases]",
      "version = 1\n[voice]\nmin_similarity=101\n[aliases]",
      "version = 1\n[voice]\nmin_margin=-1\n[aliases]",
      "version = 1\n[voice]\nmin_similarity=65.0\n[aliases]",
      "version = 1\n[aliases.slug]\nprovider='ollama'\nmodel='x'\nrate=79",
      "version = 1\n[aliases.slug]\nprovider='ollama'\nmodel='x'\nrate=205.0",
      "version = 1\n[aliases.slug]\nprovider='ollama'\nmodel='x'\npitch=128",
      "version = 1\n[aliases.slug]\nprovider='ollama'\nmodel='x'\ninstructions=\"bad\\u0000value\"",
      "version = 1\n[aliases.Slug]\nprovider='ollama'\nmodel='x'\n[aliases.slug]\nprovider='ollama'\nmodel='x'",
      "version = 1\n[aliases.foo-bar]\nprovider='ollama'\nmodel='x'\n[aliases.foo_bar]\nprovider='ollama'\nmodel='x'",
      "version = 1\n[aliases.one]\nprovider='ollama'\nmodel='x'\nspoken_names=['same']\n[aliases.two]\nprovider='ollama'\nmodel='y'\nspoken_names=['SAME']",
    ];

    for (const text of invalidDocuments) {
      expect(() => parseConfigDocument(text), text).toThrow(ConfigSchemaError);
    }
  });

  test("rejects invalid, unsupported, and nested directory fields", () => {
    const primaryDirectory = resolve("workspace", "primary");
    const additionalDirectory = resolve("workspace", "additional");
    const documents = [
      `version = 1\n[aliases.slug]\nprovider='ollama'\nmodel='x'\ndirectories=[${JSON.stringify(primaryDirectory)}]\ndirectory_access='read-only'`,
      "version = 1\n[aliases.slug]\nprovider='codex-cli'\nmodel='default'\ndirectories=['relative']\ndirectory_access='read-only'",
      "version = 1\n[aliases.slug]\nprovider='codex-cli'\nmodel='default'\ndirectories=[]\ndirectory_access='read-only'",
      "version = 1\n[aliases.slug]\nprovider='codex-cli'\nmodel='default'\ndirectories=[1]\ndirectory_access='read-only'",
      `version = 1\n[aliases.slug]\nprovider='codex-cli'\nmodel='default'\ndirectories=[${JSON.stringify(primaryDirectory)}]\ndirectory_access='read-only'\nextra=true`,
      `version = 1\n[aliases.slug]\nprovider='codex-cli'\nmodel='default'\ndirectories=[${JSON.stringify(primaryDirectory)}, ${JSON.stringify(additionalDirectory)}, ${JSON.stringify(additionalDirectory)}]\ndirectory_access='read-only'`,
      `version = 1\n[aliases.slug]\nprovider='claude-cli'\nmodel='default'\ndirectories=[${JSON.stringify(primaryDirectory)}]\ndirectory_access='read-write'`,
      "version = 1\n[aliases.slug]\nprovider='codex-cli'\nmodel='default'\ndirectory_access='read-only'",
      `version = 1\n[aliases.slug]\nprovider='codex-cli'\nmodel='default'\ndirectories=[${JSON.stringify(primaryDirectory)}]\ndirectory_access='write'`,
      `version = 1\n[aliases.slug]\nprovider='codex-cli'\nmodel='default'\n[aliases.slug.workspace]\nprimary_directory=${JSON.stringify(primaryDirectory)}\nadditional_directories=[]`,
      `version = 1\n[aliases.slug]\nprovider='codex-cli'\nmodel='default'\n[aliases.slug.workspace]\ndirectories=[${JSON.stringify(primaryDirectory)}]`,
    ];

    for (const text of documents) {
      expect(() => parseConfigDocument(text), text).toThrow(ConfigSchemaError);
    }
  });

  test("sanitizes parser and validation diagnostics", () => {
    const secret = "sk-live-CREDENTIAL-SENTINEL";
    const instruction = "PRIVATE-INSTRUCTION-SENTINEL";
    let error: unknown;
    try {
      parseConfigDocument(`
        version = 1
        [aliases.slug]
        provider = "ollama"
        model = "x"
        instructions = "${instruction}"
        api_key = "${secret}"
        broken =
      `, "/private/config.toml");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigSchemaError);
    expect((error as ConfigSchemaError).category).toBe("parse");
    expect((error as ConfigSchemaError).line).toBeNumber();
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain(instruction);
    expect(String((error as ConfigSchemaError).cause ?? "")).not.toContain(secret);
    expect(String((error as ConfigSchemaError).cause ?? "")).not.toContain(instruction);
  });

  test("does not reflect unknown TOML keys into diagnostics", () => {
    for (const key of ["sk-live-KEY-SENTINEL", "line\\ninjected"]) {
      let error: unknown;
      try {
        parseConfigDocument(`version = 1\n"${key}" = true\n[aliases]\n`);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ConfigSchemaError);
      expect(String(error)).toContain("unknown configuration field at root");
      expect(String(error)).not.toContain("sk-live");
      expect(String(error)).not.toContain("injected");
      expect(String(error).split("\n")).toHaveLength(1);
    }
  });

  test("loads a valid file and treats absence as empty authority", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "config.toml");
    expect(await loadConfig(path)).toBeNull();
    await writeFile(path, "version = 1\n[aliases]\n");
    expect(await loadConfig(path)).toEqual({ version: 1, aliases: {} });
  });

  test("rejects invalid UTF-8 before parsing unified authority", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "config.toml");
    const valid = new TextEncoder().encode("version = 1\n[aliases]\n");
    await writeFile(path, new Uint8Array([0x23, 0xff, 0x0a, ...valid]));

    await expect(loadConfig(path)).rejects.toThrow("not valid UTF-8");
  });
});

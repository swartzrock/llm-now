import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ConfigSchemaError,
  parseConfigDocument,
  projectAliases,
  projectVoiceConfig,
  serializeConfigDocument,
} from "../src/config-schema.ts";
import { loadConfig, resolveConfigPaths } from "../src/config.ts";

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

describe("unified configuration schema", () => {
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
    expect(serialized).not.toContain("match_phrases");
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
      match_phrases = []
      rate = 205
    `);

    expect(projectVoiceConfig(document)).toEqual({
      wakeWords: [],
      minFuzzyPhraseLength: 4,
      minSimilarity: 72,
      minMargin: 15,
      profiles: {
        slug: { matchPhrases: [], rate: 205 },
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
      match_phrases = ["zee"]
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
    expect(first.indexOf('instructions = "Zed"')).toBeLessThan(first.indexOf("match_phrases"));
  });

  test("rejects closed-schema, range, control, and collision failures", () => {
    const invalidDocuments = [
      "version = 2\n[aliases]",
      "version = 1\ncredential = 'secret'\n[aliases]",
      "version = 1\n[aliases.slug]\nprovider='ollama'\nmodel='default'",
      "version = 1\n[voice]\nmin_fuzzy_phrase_length=0\n[aliases]",
      "version = 1\n[voice]\nmin_similarity=101\n[aliases]",
      "version = 1\n[voice]\nmin_margin=-1\n[aliases]",
      "version = 1\n[aliases.slug]\nprovider='ollama'\nmodel='x'\nrate=79",
      "version = 1\n[aliases.slug]\nprovider='ollama'\nmodel='x'\npitch=128",
      "version = 1\n[aliases.slug]\nprovider='ollama'\nmodel='x'\ninstructions=\"bad\\u0000value\"",
      "version = 1\n[aliases.Slug]\nprovider='ollama'\nmodel='x'\n[aliases.slug]\nprovider='ollama'\nmodel='x'",
      "version = 1\n[aliases.foo-bar]\nprovider='ollama'\nmodel='x'\n[aliases.foo_bar]\nprovider='ollama'\nmodel='x'",
      "version = 1\n[aliases.one]\nprovider='ollama'\nmodel='x'\nmatch_phrases=['same']\n[aliases.two]\nprovider='ollama'\nmodel='y'\nmatch_phrases=['SAME']",
    ];

    for (const text of invalidDocuments) {
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

  test("loads a valid file and treats absence as empty authority", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "config.toml");
    expect(await loadConfig(path)).toBeNull();
    await writeFile(path, "version = 1\n[aliases]\n");
    expect(await loadConfig(path)).toEqual({ version: 1, aliases: {} });
  });
});

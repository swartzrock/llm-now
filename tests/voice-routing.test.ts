import { describe, expect, test } from "bun:test";
import {
  VoiceRouterError,
  compactKey,
  formatTrustedPitchCommand,
  parseVoiceConfig,
  parseVoiceInventory,
  ratio,
  resolveVoiceConfigPath,
  routeTranscript,
  validateSpeechAnswer,
} from "../src/voice-routing.ts";

interface NormalizationCase {
  id: string;
  input: string;
  compact: string;
}

interface ScoreCase {
  id: string;
  left: string;
  right: string;
  normalize?: boolean;
  expected: number;
}

interface RouteExpectation {
  alias: string | null;
  question: string | null;
  question_offset: number | null;
  reason: "canonical" | "configured" | "fuzzy" | "missing_request" | "missing_question"
    | "no_match" | "ambiguous";
  similarity: number | null;
  runner_up_similarity: number | null;
}

interface RouteCase {
  id: string;
  transcript: string;
  aliases: string[];
  config_toml?: string;
  expected: RouteExpectation;
}

interface ParityCorpus {
  normalization: NormalizationCase[];
  scores: ScoreCase[];
  routes: RouteCase[];
}

const corpus = await Bun.file(
  new URL(
    "../examples/macos-voice-router/tests/fixtures/routing-parity.json",
    import.meta.url,
  ),
).json() as ParityCorpus;

describe("shared routing parity corpus", () => {
  test("matches Unicode normalization exactly", () => {
    for (const fixture of corpus.normalization) {
      expect(compactKey(fixture.input), fixture.id).toBe(fixture.compact);
    }
  });

  test("matches raw similarity scores without package normalization or ranking", () => {
    for (const fixture of corpus.scores) {
      const left = fixture.normalize ? compactKey(fixture.left) : fixture.left;
      const right = fixture.normalize ? compactKey(fixture.right) : fixture.right;
      expect(ratio(left, right), fixture.id).toBeCloseTo(fixture.expected, 10);
    }
  });

  test("matches route decisions and Unicode-scalar question offsets", () => {
    for (const fixture of corpus.routes) {
      const config = parseVoiceConfig(fixture.config_toml ?? null, fixture.aliases);
      const result = routeTranscript(fixture.transcript, fixture.aliases, config);

      expect(result.alias, fixture.id).toBe(fixture.expected.alias);
      expect(result.question, fixture.id).toBe(fixture.expected.question);
      expect(result.questionOffset, fixture.id).toBe(fixture.expected.question_offset);
      expect(result.reason, fixture.id).toBe(fixture.expected.reason);
      if (fixture.expected.similarity === null) {
        expect(result.similarity, fixture.id).toBeNull();
      } else {
        expect(result.similarity, fixture.id).toBeCloseTo(fixture.expected.similarity, 10);
      }
      if (fixture.expected.runner_up_similarity === null) {
        expect(result.runnerUpSimilarity, fixture.id).toBeNull();
      } else {
        expect(result.runnerUpSimilarity, fixture.id)
          .toBeCloseTo(fixture.expected.runner_up_similarity, 10);
      }
    }
  });
});

describe("voice router configuration", () => {
  const aliases = ["fred", "haiku", "opus47", "qwen", "terra"];

  test("resolves only absolute XDG roots and defaults to the home config directory", () => {
    expect(resolveVoiceConfigPath("/Users/test", "/private/config"))
      .toBe("/private/config/llm-now/voice-router.toml");
    expect(resolveVoiceConfigPath("/Users/test", undefined))
      .toBe("/Users/test/.config/llm-now/voice-router.toml");
    expect(resolveVoiceConfigPath("/Users/test", ""))
      .toBe("/Users/test/.config/llm-now/voice-router.toml");
    expect(() => resolveVoiceConfigPath("/Users/test", "relative"))
      .toThrow("XDG_CONFIG_HOME must be an absolute path");
  });

  test("uses defaults and parses the closed profile schema", () => {
    const defaults = parseVoiceConfig(null, aliases);
    expect(defaults.wakeWords).toEqual(["hey"]);
    expect(defaults.profiles).toEqual({});

    const config = parseVoiceConfig(`
      wake_words = ["hey", "computer"]

      [terra]
      match_phrases = ["tara"]
      voice = " Samantha "
      rate = 205
      pitch = 50

      [opus47]
      pitch = 50.5
    `, aliases);

    expect(config).toEqual({
      wakeWords: ["hey", "computer"],
      profiles: {
        terra: {
          matchPhrases: ["tara"],
          voice: "Samantha",
          rate: 205,
          pitch: 50,
        },
        opus47: { matchPhrases: [], pitch: 50.5 },
      },
    });
    expect(Object.isFrozen(config)).toBeTrue();
    expect(Object.isFrozen(config.wakeWords)).toBeTrue();
    expect(Object.isFrozen(config.profiles.terra)).toBeTrue();
  });

  test("rejects malformed TOML, open fields, and invalid speech values", () => {
    const invalid = [
      "not toml =",
      "enabled = true",
      'wake_words = "hey"',
      'wake_words = [""]',
      "[terra]\nmatch_phrases = 'tara'",
      "[terra]\nmatch_phrases = ['...']",
      "[terra]\nvoice = ''",
      "[terra]\nrate = 79",
      "[terra]\nrate = 501",
      "[terra]\nrate = true",
      "[terra]\npitch = 0",
      "[terra]\npitch = 128",
      "[terra]\npitch = true",
      "[terra]\npitch = nan",
      "[terra]\nvolume = 10",
      "[wake_words]\nvoice = 'Samantha'",
    ];

    for (const toml of invalid) {
      expect(() => parseVoiceConfig(toml, aliases), toml).toThrow(VoiceRouterError);
    }
  });

  test("validates stale profiles structurally but keeps their phrases inert", () => {
    const config = parseVoiceConfig(`
      [retired]
      match_phrases = ["terra"]
      voice = "Old Voice"
      rate = 180
      pitch = 70
    `, aliases);

    expect(config.profiles.retired).toEqual({
      matchPhrases: ["terra"],
      voice: "Old Voice",
      rate: 180,
      pitch: 70,
    });
    expect(routeTranscript("terra, question", aliases, config).reason).toBe("canonical");
    expect(() => parseVoiceConfig("[retired]\npitch = 200", aliases))
      .toThrow("retired.pitch");
    expect(() => parseVoiceConfig("[retired]\nunknown = true", aliases))
      .toThrow("unknown profile field");
  });

  test("rejects duplicate and active canonical phrase collisions", () => {
    expect(() => parseVoiceConfig(
      "[terra]\nmatch_phrases = ['tara']\n[fred]\nmatch_phrases = ['tara']",
      aliases,
    )).toThrow("match phrase");
    expect(() => parseVoiceConfig(
      "[qwen]\nmatch_phrases = ['terra']",
      aliases,
    )).toThrow("canonical alias");
    expect(() => parseVoiceConfig(
      "[terra]\nmatch_phrases = ['tara', 'TARA']",
      aliases,
    )).toThrow("duplicate phrase");
  });
});

describe("pure voice inventory and speech safety helpers", () => {
  test("parses multiword macOS voice names case-insensitively", () => {
    const voices = parseVoiceInventory(
      "Samantha            en_US    # Hello\n"
        + "Eddy (English (US)) en_US    # Hello\n",
    );

    expect(voices.get("samantha")).toBe("Samantha");
    expect(voices.get("eddy (english (us))")).toBe("Eddy (English (US))");
    expect(() => parseVoiceInventory("not a voice row\n")).toThrow(VoiceRouterError);
    expect(() => parseVoiceInventory(
      "Samantha en_US # one\nSAMANTHA en_US # two\n",
    )).toThrow('duplicate macOS voice: "SAMANTHA"');
  });

  test("rejects blank and unsafe answers while formatting only trusted pitch", () => {
    expect(validateSpeechAnswer("A safe answer.\n")).toEqual({ valid: true });
    expect(validateSpeechAnswer(" \t\n")).toEqual({ valid: false, reason: "blank" });
    for (const answer of ["unsafe [[slnc 100]]", "unsafe\x1b[31m", "unsafe\x00text"]) {
      expect(validateSpeechAnswer(answer)).toEqual({ valid: false, reason: "unsafe" });
    }
    expect(validateSpeechAnswer("tabs\tand\nlines\rare allowed")).toEqual({ valid: true });

    expect(formatTrustedPitchCommand(50)).toBe("[[pbas 50]]");
    expect(formatTrustedPitchCommand(50.5)).toBe("[[pbas 50.5]]");
    expect(() => formatTrustedPitchCommand(Number.NaN)).toThrow(VoiceRouterError);
    expect(() => formatTrustedPitchCommand(128)).toThrow(VoiceRouterError);
  });
});

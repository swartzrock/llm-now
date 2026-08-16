import { describe, expect, test } from "bun:test";
import {
  RoutingInputError,
  compactRoutingKey,
  routeTranscript,
} from "../src/routing.ts";

const candidates = [
  { id: "character:terra", canonicalName: "terra", alternateSpokenNames: ["tara"] },
  { id: "character:opus", canonicalName: "opus47", alternateSpokenNames: ["opus forty seven"] },
] as const;

const policy = {
  wakeWords: ["hey", "hello computer"],
  minFuzzyPhraseLength: 4,
  minSimilarity: 65,
  minMargin: 15,
} as const;

describe("caller-owned transcript routing", () => {
  test("routes canonical and alternate names with exact question and metadata", () => {
    expect(routeTranscript({
      transcript: "hey terra, Explain streams.",
      candidates,
      ...policy,
    })).toEqual({
      accepted: true,
      candidateId: "character:terra",
      question: "Explain streams.",
      questionOffset: 11,
      reason: "canonical",
      similarity: null,
      runnerUpSimilarity: null,
      matchedName: "terra",
      wakeWord: "hey",
    });

    expect(routeTranscript({
      transcript: "hello computer, tara: keep punctuation?",
      candidates,
      ...policy,
    })).toMatchObject({
      accepted: true,
      candidateId: "character:terra",
      question: "keep punctuation?",
      reason: "alternate",
      matchedName: "tara",
      wakeWord: "hello computer",
    });
  });

  test("returns fuzzy, default, missing-question, and no-match outcomes", () => {
    expect(routeTranscript({
      transcript: "tera explain",
      candidates,
      ...policy,
    })).toMatchObject({
      accepted: true,
      candidateId: "character:terra",
      reason: "fuzzy",
      question: "explain",
      matchedName: "terra",
    });

    expect(routeTranscript({
      transcript: "hello computer explain this",
      candidates,
      ...policy,
      defaultCandidateId: "character:opus",
    })).toMatchObject({
      accepted: true,
      candidateId: "character:opus",
      reason: "default",
      question: "explain this",
      matchedName: null,
      wakeWord: "hello computer",
    });

    expect(routeTranscript({ transcript: "terra", candidates, ...policy })).toMatchObject({
      accepted: false,
      reason: "missing_question",
    });
    expect(routeTranscript({ transcript: "unknown request", candidates, ...policy })).toMatchObject({
      accepted: false,
      reason: "no_match",
    });
    expect(routeTranscript({ transcript: "  ", candidates, ...policy })).toMatchObject({
      accepted: false,
      reason: "missing_request",
    });
  });

  test("is independent of candidate input order", () => {
    const input = {
      transcript: "opus48 explain",
      ...policy,
    } as const;
    expect(routeTranscript({ ...input, candidates }))
      .toEqual(routeTranscript({ ...input, candidates: [...candidates].reverse() }));
  });

  test("uses Unicode routing normalization without changing caller IDs", () => {
    expect(compactRoutingKey("ＴＥＲＲＡ")).toBe("terra");
    expect(routeTranscript({
      transcript: "ＴＥＲＲＡ explain",
      candidates,
      ...policy,
    })).toMatchObject({ accepted: true, candidateId: "character:terra" });
  });

  test("rejects invalid IDs, defaults, thresholds, and normalized collisions", () => {
    const invalidInputs = [
      { candidates: [{ id: " ", canonicalName: "one" }] },
      { candidates: [{ id: "same", canonicalName: "one" }, { id: "same", canonicalName: "two" }] },
      { candidates, defaultCandidateId: "missing" },
      { candidates, minFuzzyPhraseLength: 0 },
      { candidates, minFuzzyPhraseLength: 65 },
      { candidates, minSimilarity: -1 },
      { candidates, minMargin: 101 },
      { candidates: [{ id: "one", canonicalName: "one", alternateSpokenNames: ["ONE"] }] },
      { candidates: [{ id: "one", canonicalName: "same" }, { id: "two", canonicalName: "ＳＡＭＥ" }] },
      { candidates: [{ id: "one", canonicalName: "one", alternateSpokenNames: ["shared"] }, { id: "two", canonicalName: "two", alternateSpokenNames: ["SHARED"] }] },
    ];

    for (const invalid of invalidInputs) {
      expect(() => routeTranscript({
        transcript: "one question",
        ...policy,
        ...invalid,
      } as never)).toThrow(RoutingInputError);
    }
  });
});

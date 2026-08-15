import { ratio as wasmRatio } from "@3leaps/string-metrics-wasm";
import { caseFold } from "unicode-case-folding";

const WORD_CHARACTER = /[\p{Letter}\p{Number}\p{Mark}]/u;
const COMPACT_CHARACTER = /[\p{Letter}\p{Number}]/u;

export interface RoutingCandidate {
  readonly id: string;
  readonly canonicalName: string;
  readonly alternateSpokenNames?: readonly string[];
}

export interface RouteTranscriptInput {
  readonly transcript: string;
  readonly candidates: readonly RoutingCandidate[];
  readonly wakeWords: readonly string[];
  readonly minFuzzyPhraseLength: number;
  readonly minSimilarity: number;
  readonly minMargin: number;
  readonly defaultCandidateId?: string;
}

export type RouteMatchReason = "canonical" | "alternate" | "fuzzy" | "default";
export type RouteRejectionReason =
  | "missing_request"
  | "missing_question"
  | "no_match"
  | "ambiguous";

export interface RouteMatch {
  readonly accepted: true;
  readonly candidateId: string;
  readonly question: string;
  readonly questionOffset: number;
  readonly reason: RouteMatchReason;
  readonly similarity: number | null;
  readonly runnerUpSimilarity: number | null;
  readonly matchedName: string | null;
  readonly wakeWord: string | null;
}

export interface RouteRejection {
  readonly accepted: false;
  readonly candidateId: null;
  readonly question: null;
  readonly questionOffset: null;
  readonly reason: RouteRejectionReason;
  readonly similarity: number | null;
  readonly runnerUpSimilarity: number | null;
  readonly matchedName: null;
  readonly wakeWord: string | null;
}

export type RouteTranscriptResult = RouteMatch | RouteRejection;

export class RoutingInputError extends Error {
  constructor() {
    super("Invalid routing input.");
    this.name = "RoutingInputError";
  }
}

interface Token {
  readonly key: string;
  readonly scalarStart: number;
  readonly utf16Start: number;
  readonly utf16End: number;
}

interface CandidateName {
  readonly candidateId: string;
  readonly name: string;
}

interface ValidatedCandidate extends RoutingCandidate {
  readonly alternateSpokenNames: readonly string[];
}

interface TranscriptView {
  readonly start: number;
  readonly wakeWord: string | null;
}

interface FuzzyNameMetadata extends CandidateName {
  readonly key: string;
  readonly maximumDifference: number;
  readonly digits: readonly string[];
}

interface FuzzyCandidate {
  readonly score: number;
  readonly spanLength: number;
  readonly question: string | null;
  readonly questionOffset: number | null;
  readonly name: string;
}

export function compactRoutingKey(value: string): string {
  const folded = caseFold(value.normalize("NFKC"));
  let result = "";
  for (const character of folded) {
    if (COMPACT_CHARACTER.test(character)) result += character;
  }
  return result;
}

export function routingSimilarity(left: string, right: string): number {
  return wasmRatio(left, right);
}

export function routeTranscript(input: RouteTranscriptInput): RouteTranscriptResult {
  let validated: {
    transcript: string;
    candidates: readonly ValidatedCandidate[];
    wakeWords: readonly string[];
    minFuzzyPhraseLength: number;
    minSimilarity: number;
    minMargin: number;
    defaultCandidateId?: string;
  };
  try {
    validated = validateInput(input);
  } catch (error) {
    if (error instanceof RoutingInputError) throw error;
    throw new RoutingInputError();
  }

  const tokens = tokenize(validated.transcript);
  if (tokens.length === 0) return rejectedRoute("missing_request");

  const canonicalByKey = new Map<string, CandidateName>();
  const alternateByKey = new Map<string, CandidateName>();
  for (const candidate of validated.candidates) {
    canonicalByKey.set(compactRoutingKey(candidate.canonicalName), {
      candidateId: candidate.id,
      name: candidate.canonicalName,
    });
    for (const name of candidate.alternateSpokenNames) {
      alternateByKey.set(compactRoutingKey(name), { candidateId: candidate.id, name });
    }
  }

  const views = transcriptViews(tokens, validated.wakeWords);
  let sawMissingQuestion = false;
  let strongestRejection: RouteTranscriptResult | null = null;

  for (const view of views) {
    const canonical = longestStageMatch(
      validated.transcript,
      tokens,
      view,
      canonicalByKey,
      "canonical",
    );
    if (canonical !== null) {
      if (canonical.accepted) return canonical;
      sawMissingQuestion = true;
      continue;
    }

    const alternate = longestStageMatch(
      validated.transcript,
      tokens,
      view,
      alternateByKey,
      "alternate",
    );
    if (alternate !== null) {
      if (alternate.accepted) return alternate;
      sawMissingQuestion = true;
      continue;
    }

    const fuzzy = fuzzyMatch(
      validated.transcript,
      tokens,
      view,
      canonicalByKey,
      validated,
    );
    if (fuzzy.accepted) return fuzzy;
    if (fuzzy.reason === "missing_question") sawMissingQuestion = true;
    if (fuzzy.reason === "ambiguous") strongestRejection = fuzzy;
  }

  if (sawMissingQuestion) return rejectedRoute("missing_question");
  if (strongestRejection !== null) return strongestRejection;
  if (validated.defaultCandidateId !== undefined) {
    const view = views[0] ?? { start: 0, wakeWord: null };
    const questionToken = tokens[view.start];
    if (questionToken === undefined) return rejectedRoute("missing_question", null, null, view.wakeWord);
    return acceptedRoute(
      validated.defaultCandidateId,
      validated.transcript.slice(questionToken.utf16Start),
      questionToken.scalarStart,
      "default",
      null,
      null,
      null,
      view.wakeWord,
    );
  }
  return rejectedRoute("no_match");
}

function validateInput(input: RouteTranscriptInput): {
  transcript: string;
  candidates: readonly ValidatedCandidate[];
  wakeWords: readonly string[];
  minFuzzyPhraseLength: number;
  minSimilarity: number;
  minMargin: number;
  defaultCandidateId?: string;
} {
  if (typeof input !== "object" || input === null) throw new RoutingInputError();
  if (typeof input.transcript !== "string" || !Array.isArray(input.candidates)) {
    throw new RoutingInputError();
  }
  validateInteger(input.minFuzzyPhraseLength, 1, 64);
  validateInteger(input.minSimilarity, 0, 100);
  validateInteger(input.minMargin, 0, 100);

  if (!Array.isArray(input.wakeWords)) throw new RoutingInputError();
  const wakeWords = validatePhrases(input.wakeWords);
  const candidateIds = new Set<string>();
  const nameOwners = new Map<string, string>();
  const candidates: ValidatedCandidate[] = [];

  for (const raw of input.candidates) {
    if (typeof raw !== "object" || raw === null) throw new RoutingInputError();
    const id = raw.id;
    const canonicalName = raw.canonicalName;
    if (typeof id !== "string" || id.trim().length === 0 || candidateIds.has(id)) {
      throw new RoutingInputError();
    }
    if (typeof canonicalName !== "string") throw new RoutingInputError();
    const alternateSpokenNames = raw.alternateSpokenNames ?? [];
    if (!Array.isArray(alternateSpokenNames)) throw new RoutingInputError();
    const names = validatePhrases([canonicalName, ...alternateSpokenNames]);
    for (const name of names) {
      const key = compactRoutingKey(name);
      const owner = nameOwners.get(key);
      if (owner !== undefined && owner !== id) throw new RoutingInputError();
      nameOwners.set(key, id);
    }
    candidateIds.add(id);
    candidates.push(Object.freeze({
      id,
      canonicalName,
      alternateSpokenNames: Object.freeze([...alternateSpokenNames]),
    }));
  }

  if (
    input.defaultCandidateId !== undefined
    && (typeof input.defaultCandidateId !== "string" || !candidateIds.has(input.defaultCandidateId))
  ) {
    throw new RoutingInputError();
  }

  candidates.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return {
    transcript: input.transcript,
    candidates: Object.freeze(candidates),
    wakeWords,
    minFuzzyPhraseLength: input.minFuzzyPhraseLength,
    minSimilarity: input.minSimilarity,
    minMargin: input.minMargin,
    ...(input.defaultCandidateId === undefined ? {} : { defaultCandidateId: input.defaultCandidateId }),
  };
}

function validateInteger(value: unknown, minimum: number, maximum: number): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RoutingInputError();
  }
}

function validatePhrases(value: readonly unknown[]): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const phrase of value) {
    if (typeof phrase !== "string") throw new RoutingInputError();
    const key = compactRoutingKey(phrase);
    if (key.length === 0 || seen.has(key)) throw new RoutingInputError();
    seen.add(key);
    result.push(phrase);
  }
  return Object.freeze(result);
}

function tokenize(value: string): readonly Token[] {
  const tokens: Token[] = [];
  let startScalar: number | null = null;
  let startUtf16 = 0;
  let scalarIndex = 0;
  let utf16Index = 0;

  const finish = (utf16End: number): void => {
    if (startScalar === null) return;
    const key = compactRoutingKey(value.slice(startUtf16, utf16End));
    if (key.length > 0) {
      tokens.push(Object.freeze({
        key,
        scalarStart: startScalar,
        utf16Start: startUtf16,
        utf16End,
      }));
    }
    startScalar = null;
  };

  for (const character of value) {
    if (WORD_CHARACTER.test(character)) {
      if (startScalar === null) {
        startScalar = scalarIndex;
        startUtf16 = utf16Index;
      }
    } else {
      finish(utf16Index);
    }
    scalarIndex += 1;
    utf16Index += character.length;
  }
  finish(utf16Index);
  return tokens;
}

function phraseTokenKeys(phrase: string): readonly string[] {
  return tokenize(phrase).map((token) => token.key);
}

function transcriptViews(tokens: readonly Token[], wakeWords: readonly string[]): readonly TranscriptView[] {
  const tokenKeys = tokens.map((token) => token.key);
  const matches = wakeWords.flatMap((wakeWord) => {
    const phraseKeys = phraseTokenKeys(wakeWord);
    return phraseKeys.length > 0 && phraseKeys.every((key, index) => tokenKeys[index] === key)
      ? [{ start: phraseKeys.length, wakeWord }]
      : [];
  }).sort((left, right) => {
    if (left.start !== right.start) return right.start - left.start;
    return compactRoutingKey(left.wakeWord).localeCompare(compactRoutingKey(right.wakeWord));
  });
  return matches.length > 0
    ? Object.freeze([matches[0] as TranscriptView, { start: 0, wakeWord: null }])
    : Object.freeze([{ start: 0, wakeWord: null }]);
}

function longestStageMatch(
  transcript: string,
  tokens: readonly Token[],
  view: TranscriptView,
  namesByKey: ReadonlyMap<string, CandidateName>,
  reason: "canonical" | "alternate",
): RouteTranscriptResult | null {
  let winner: { end: number; candidate: CandidateName } | null = null;
  let key = "";
  let maximumKeyLength = 0;
  for (const candidate of namesByKey.keys()) maximumKeyLength = Math.max(maximumKeyLength, scalarLength(candidate));

  for (let end = view.start + 1; end <= tokens.length; end += 1) {
    const token = tokens[end - 1];
    if (token === undefined) break;
    key += token.key;
    if (scalarLength(key) > maximumKeyLength) break;
    const candidate = namesByKey.get(key);
    if (candidate !== undefined) winner = { end, candidate };
  }

  if (winner === null) return null;
  const questionToken = tokens[winner.end];
  if (questionToken === undefined) return rejectedRoute("missing_question", null, null, view.wakeWord);
  return acceptedRoute(
    winner.candidate.candidateId,
    transcript.slice(questionToken.utf16Start),
    questionToken.scalarStart,
    reason,
    null,
    null,
    winner.candidate.name,
    view.wakeWord,
  );
}

function fuzzyMatch(
  transcript: string,
  tokens: readonly Token[],
  view: TranscriptView,
  canonicalByKey: ReadonlyMap<string, CandidateName>,
  policy: Pick<RouteTranscriptInput, "minFuzzyPhraseLength" | "minSimilarity" | "minMargin">,
): RouteTranscriptResult {
  const perCandidate = new Map<string, FuzzyCandidate>();
  const names: FuzzyNameMetadata[] = [];
  for (const [key, candidate] of canonicalByKey) {
    const length = scalarLength(key);
    if (length < policy.minFuzzyPhraseLength) continue;
    names.push({
      ...candidate,
      key,
      maximumDifference: Math.max(1, Math.ceil(length * 0.2)),
      digits: digitSequences(key),
    });
  }
  const maximumCandidateLength = names.reduce(
    (maximum, name) => Math.max(maximum, scalarLength(name.key) + name.maximumDifference),
    0,
  );

  let candidateKey = "";
  for (let end = view.start + 1; end <= tokens.length; end += 1) {
    const token = tokens[end - 1];
    if (token === undefined) break;
    candidateKey += token.key;
    const candidateLength = scalarLength(candidateKey);
    if (candidateLength > maximumCandidateLength) break;
    if (candidateLength < policy.minFuzzyPhraseLength) continue;
    const questionToken = tokens[end];
    const candidateDigits = digitSequences(candidateKey);

    for (const name of names) {
      if (Math.abs(candidateLength - scalarLength(name.key)) > name.maximumDifference) continue;
      if ((candidateDigits.length > 0 || name.digits.length > 0) && !sameStrings(candidateDigits, name.digits)) {
        continue;
      }
      const score = routingSimilarity(candidateKey, name.key);
      const spanLength = end - view.start;
      const current = perCandidate.get(name.candidateId);
      if (current === undefined || score > current.score || (score === current.score && spanLength < current.spanLength)) {
        perCandidate.set(name.candidateId, {
          score,
          spanLength,
          question: questionToken === undefined ? null : transcript.slice(questionToken.utf16Start),
          questionOffset: questionToken?.scalarStart ?? null,
          name: name.name,
        });
      }
    }
  }

  const ranked = [...perCandidate.entries()]
    .map(([candidateId, candidate]) => ({ candidateId, ...candidate }))
    .sort((left, right) => left.score !== right.score
      ? right.score - left.score
      : left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0);
  const best = ranked[0];
  if (best === undefined) return rejectedRoute("no_match", null, null, view.wakeWord);
  const runnerUp = ranked[1];
  if (best.score < policy.minSimilarity) {
    return rejectedRoute("no_match", best.score, runnerUp?.score ?? null, view.wakeWord);
  }
  if (runnerUp !== undefined && (best.score === runnerUp.score || best.score - runnerUp.score < policy.minMargin)) {
    return rejectedRoute("ambiguous", best.score, runnerUp.score, view.wakeWord);
  }
  if (best.question === null || best.questionOffset === null) {
    return rejectedRoute("missing_question", best.score, runnerUp?.score ?? null, view.wakeWord);
  }
  return acceptedRoute(
    best.candidateId,
    best.question,
    best.questionOffset,
    "fuzzy",
    best.score,
    runnerUp?.score ?? null,
    best.name,
    view.wakeWord,
  );
}

function scalarLength(value: string): number {
  return [...value].length;
}

function digitSequences(value: string): readonly string[] {
  return [...value.matchAll(/\p{Decimal_Number}+/gu)].map((match) => match[0]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function acceptedRoute(
  candidateId: string,
  question: string,
  questionOffset: number,
  reason: RouteMatchReason,
  similarity: number | null,
  runnerUpSimilarity: number | null,
  matchedName: string | null,
  wakeWord: string | null,
): RouteMatch {
  return Object.freeze({
    accepted: true,
    candidateId,
    question,
    questionOffset,
    reason,
    similarity,
    runnerUpSimilarity,
    matchedName,
    wakeWord,
  });
}

function rejectedRoute(
  reason: RouteRejectionReason,
  similarity: number | null = null,
  runnerUpSimilarity: number | null = null,
  wakeWord: string | null = null,
): RouteRejection {
  return Object.freeze({
    accepted: false,
    candidateId: null,
    question: null,
    questionOffset: null,
    reason,
    similarity,
    runnerUpSimilarity,
    matchedName: null,
    wakeWord,
  });
}

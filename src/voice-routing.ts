import { ratio as wasmRatio } from "@3leaps/string-metrics-wasm";
import { caseFold } from "unicode-case-folding";
import { posix } from "node:path";

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MIN_FUZZY_LENGTH = 4;
const MIN_FUZZY_SIMILARITY = 65;
const MIN_FUZZY_MARGIN = 15;
const WORD_CHARACTER = /[\p{Letter}\p{Number}\p{Mark}]/u;
const COMPACT_CHARACTER = /[\p{Letter}\p{Number}]/u;
const CONTROL_CHARACTER = /\p{Cc}/u;
const VOICE_ROW = /^(.+?)\s+([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)+)\s+#/;

export class VoiceRouterError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VoiceRouterError";
  }
}

export interface AliasProfile {
  readonly matchPhrases: readonly string[];
  readonly voice?: string;
  readonly rate?: number;
  readonly pitch?: number;
}

export interface VoiceConfig {
  readonly wakeWords: readonly string[];
  readonly profiles: Readonly<Record<string, AliasProfile>>;
}

export type AcceptedRouteReason = "canonical" | "configured" | "fuzzy";
export type RejectedRouteReason = "missing_request" | "missing_question" | "no_match" | "ambiguous";

export interface AcceptedRoute {
  readonly accepted: true;
  readonly alias: string;
  readonly question: string;
  readonly questionOffset: number;
  readonly reason: AcceptedRouteReason;
  readonly similarity: number | null;
  readonly runnerUpSimilarity: number | null;
}

export interface RejectedRoute {
  readonly accepted: false;
  readonly alias: null;
  readonly question: null;
  readonly questionOffset: null;
  readonly reason: RejectedRouteReason;
  readonly similarity: number | null;
  readonly runnerUpSimilarity: number | null;
}

export type RouteResult = AcceptedRoute | RejectedRoute;

export type SpeechAnswerValidation =
  | Readonly<{ valid: true }>
  | Readonly<{ valid: false; reason: "blank" | "unsafe" }>;

interface Token {
  readonly key: string;
  readonly scalarStart: number;
  readonly scalarEnd: number;
  readonly utf16Start: number;
  readonly utf16End: number;
}

interface FuzzyAliasMetadata {
  readonly key: string;
  readonly alias: string;
  readonly maximumDifference: number;
  readonly digits: readonly string[];
}

interface FuzzyCandidate {
  readonly score: number;
  readonly spanLength: number;
  readonly question: string;
  readonly questionOffset: number;
}

export function ratio(left: string, right: string): number {
  return wasmRatio(left, right);
}

export function resolveVoiceConfigPath(home: string, xdgConfigHome?: string): string {
  let root: string;
  if (xdgConfigHome) {
    if (!posix.isAbsolute(xdgConfigHome)) {
      throw new VoiceRouterError("XDG_CONFIG_HOME must be an absolute path");
    }
    root = xdgConfigHome;
  } else {
    root = posix.join(home, ".config");
  }
  return posix.join(root, "llm-now", "voice-router.toml");
}

export function compactKey(value: string): string {
  const folded = caseFold(value.normalize("NFKC"));
  let result = "";
  for (const character of folded) {
    if (COMPACT_CHARACTER.test(character)) result += character;
  }
  return result;
}

export function parseVoiceInventory(text: string): ReadonlyMap<string, string> {
  const voices = new Map<string, string>();
  for (const [index, row] of splitLines(text).entries()) {
    if (row.length === 0) continue;
    const match = VOICE_ROW.exec(row);
    if (match === null) {
      throw new VoiceRouterError(`invalid macOS voice inventory row ${index + 1}`);
    }
    const voice = (match[1] ?? "").trim();
    const key = caseFold(voice);
    if (voice.length === 0 || voices.has(key)) {
      throw new VoiceRouterError(`duplicate macOS voice: "${voice}"`);
    }
    voices.set(key, voice);
  }
  if (voices.size === 0) throw new VoiceRouterError("macOS voice inventory is empty");
  return voices;
}

export function parseVoiceConfig(
  text: string | null | undefined,
  aliases: Iterable<string>,
): VoiceConfig {
  const activeAliases = validatedAliases(aliases);
  if (text === null || text === undefined) return freezeConfig(["hey"], {});

  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (error) {
    throw new VoiceRouterError(
      `invalid voice router configuration: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isRecord(parsed)) {
    throw new VoiceRouterError("invalid voice router configuration: root must be a TOML table");
  }

  const wakeWords = stringList(
    Object.hasOwn(parsed, "wake_words") ? parsed.wake_words : ["hey"],
    "wake_words",
  );
  validatePhrases(wakeWords, "wake_words");

  const profiles: Record<string, AliasProfile> = {};
  for (const [alias, rawProfile] of Object.entries(parsed)) {
    if (alias === "wake_words") continue;
    if (!ALIAS_PATTERN.test(alias)) {
      throw new VoiceRouterError(`invalid profile alias: "${alias}"`);
    }
    if (!isRecord(rawProfile)) {
      throw new VoiceRouterError(`profile "${alias}" must be a TOML table`);
    }

    const allowedFields = new Set(["match_phrases", "voice", "rate", "pitch"]);
    const unknownFields = Object.keys(rawProfile)
      .filter((field) => !allowedFields.has(field))
      .sort();
    if (unknownFields.length > 0) {
      throw new VoiceRouterError(
        `unknown profile field for "${alias}": ${unknownFields.join(", ")}`,
      );
    }

    const matchPhrases = stringList(rawProfile.match_phrases ?? [], `${alias}.match_phrases`);
    validatePhrases(matchPhrases, `${alias}.match_phrases`);

    const profile: {
      matchPhrases: readonly string[];
      voice?: string;
      rate?: number;
      pitch?: number;
    } = { matchPhrases: Object.freeze([...matchPhrases]) };

    const voice = rawProfile.voice;
    if (voice !== undefined) {
      if (typeof voice !== "string" || voice.trim().length === 0) {
        throw new VoiceRouterError(`${alias}.voice must be a nonempty string`);
      }
      profile.voice = voice.trim();
    }

    const rate = rawProfile.rate;
    if (rate !== undefined) {
      if (typeof rate !== "number" || !Number.isInteger(rate) || rate < 80 || rate > 500) {
        throw new VoiceRouterError(`${alias}.rate must be an integer from 80 through 500`);
      }
      profile.rate = rate;
    }

    const pitch = rawProfile.pitch;
    if (pitch !== undefined) {
      validatePitch(pitch, `${alias}.pitch`);
      profile.pitch = pitch;
    }

    profiles[alias] = Object.freeze(profile);
  }

  validateActivePhrases(profiles, activeAliases);
  return freezeConfig(wakeWords, profiles);
}

export function routeTranscript(
  transcript: string,
  aliases: Iterable<string>,
  config: VoiceConfig,
): RouteResult {
  const activeAliases = validatedAliases(aliases);
  const tokens = tokenize(transcript);
  if (tokens.length === 0) return rejectedRoute("missing_request");

  const canonicalByKey = new Map<string, string>();
  for (const alias of activeAliases) canonicalByKey.set(compactKey(alias), alias);

  const phraseByKey = new Map<string, string>();
  for (const alias of activeAliases) {
    const profile = Object.hasOwn(config.profiles, alias) ? config.profiles[alias] : undefined;
    if (profile === undefined) continue;
    for (const phrase of profile.matchPhrases) phraseByKey.set(compactKey(phrase), alias);
  }

  const views = transcriptViews(tokens, config.wakeWords);
  let sawMissingQuestion = false;
  let strongestRejection: RouteResult | null = null;

  for (const start of views) {
    const exact = longestStageMatch(transcript, tokens, start, canonicalByKey, "canonical");
    if (exact !== null) {
      if (exact.accepted) return exact;
      sawMissingQuestion = true;
      continue;
    }

    const configured = longestStageMatch(
      transcript,
      tokens,
      start,
      phraseByKey,
      "configured",
    );
    if (configured !== null) {
      if (configured.accepted) return configured;
      sawMissingQuestion = true;
      continue;
    }

    const fuzzy = fuzzyMatch(transcript, tokens, start, canonicalByKey);
    if (fuzzy.accepted) return fuzzy;
    if (fuzzy.reason === "ambiguous") strongestRejection = fuzzy;
  }

  if (sawMissingQuestion) return rejectedRoute("missing_question");
  return strongestRejection ?? rejectedRoute("no_match");
}

export function validateSpeechAnswer(value: string): SpeechAnswerValidation {
  if (value.trim().length === 0) return Object.freeze({ valid: false, reason: "blank" });
  if (value.includes("[[") || value.includes("\x1b")) {
    return Object.freeze({ valid: false, reason: "unsafe" });
  }
  for (const character of value) {
    if (CONTROL_CHARACTER.test(character) && character !== "\t" && character !== "\n" && character !== "\r") {
      return Object.freeze({ valid: false, reason: "unsafe" });
    }
  }
  return Object.freeze({ valid: true });
}

export function formatTrustedPitchCommand(value: number): string {
  validatePitch(value, "pitch");
  return `[[pbas ${Number.isInteger(value) ? Math.trunc(value) : value}]]`;
}

function splitLines(value: string): string[] {
  return value.split(/\r\n|[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]/u);
}

function scalarLength(value: string): number {
  return [...value].length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatedAliases(aliases: Iterable<string>): readonly string[] {
  const result: string[] = [];
  const keys = new Map<string, string>();
  for (const alias of aliases) {
    if (typeof alias !== "string" || !ALIAS_PATTERN.test(alias)) {
      throw new VoiceRouterError(`invalid canonical alias: "${alias}"`);
    }
    const key = compactKey(alias);
    const collision = keys.get(key);
    if (collision !== undefined) {
      throw new VoiceRouterError(
        `aliases "${collision}" and "${alias}" collide after routing normalization`,
      );
    }
    result.push(alias);
    keys.set(key, alias);
  }
  return result;
}

function stringList(value: unknown, fieldName: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new VoiceRouterError(`${fieldName} must be a list of strings`);
  }
  return value as string[];
}

function validatePhrases(phrases: readonly string[], fieldName: string): void {
  const seen = new Set<string>();
  for (const phrase of phrases) {
    const key = compactKey(phrase);
    if (key.length === 0) {
      throw new VoiceRouterError(`${fieldName} contains a blank normalized phrase`);
    }
    if (seen.has(key)) {
      throw new VoiceRouterError(`${fieldName} contains a duplicate phrase`);
    }
    seen.add(key);
  }
}

function validatePitch(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 127) {
    throw new VoiceRouterError(`${fieldName} must be a number from 1 through 127`);
  }
}

function validateActivePhrases(
  profiles: Readonly<Record<string, AliasProfile>>,
  activeAliases: readonly string[],
): void {
  const canonicalByKey = new Map<string, string>();
  for (const alias of activeAliases) canonicalByKey.set(compactKey(alias), alias);
  const phraseOwners = new Map<string, string>();

  for (const alias of activeAliases) {
    const profile = Object.hasOwn(profiles, alias) ? profiles[alias] : undefined;
    if (profile === undefined) continue;
    for (const phrase of profile.matchPhrases) {
      const key = compactKey(phrase);
      const canonicalOwner = canonicalByKey.get(key);
      if (canonicalOwner !== undefined && canonicalOwner !== alias) {
        throw new VoiceRouterError(
          `match phrase "${phrase}" for "${alias}" collides with canonical alias "${canonicalOwner}"`,
        );
      }
      const phraseOwner = phraseOwners.get(key);
      if (phraseOwner !== undefined && phraseOwner !== alias) {
        throw new VoiceRouterError(
          `match phrase "${phrase}" is shared by "${phraseOwner}" and "${alias}"`,
        );
      }
      phraseOwners.set(key, alias);
    }
  }
}

function freezeConfig(
  wakeWords: readonly string[],
  profiles: Record<string, AliasProfile>,
): VoiceConfig {
  return Object.freeze({
    wakeWords: Object.freeze([...wakeWords]),
    profiles: Object.freeze(profiles),
  });
}

function tokenize(value: string): readonly Token[] {
  const tokens: Token[] = [];
  let startScalar: number | null = null;
  let startUtf16 = 0;
  let scalarIndex = 0;
  let utf16Index = 0;

  const finish = (scalarEnd: number, utf16End: number): void => {
    if (startScalar === null) return;
    const key = compactKey(value.slice(startUtf16, utf16End));
    if (key.length > 0) {
      tokens.push(Object.freeze({
        key,
        scalarStart: startScalar,
        scalarEnd,
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
      finish(scalarIndex, utf16Index);
    }
    scalarIndex += 1;
    utf16Index += character.length;
  }
  finish(scalarIndex, utf16Index);
  return tokens;
}

function phraseTokenKeys(phrase: string): readonly string[] {
  return tokenize(phrase).map((token) => token.key);
}

function transcriptViews(tokens: readonly Token[], wakeWords: readonly string[]): readonly number[] {
  const tokenKeys = tokens.map((token) => token.key);
  const wakeLengths: number[] = [];
  for (const phrase of wakeWords) {
    const phraseKeys = phraseTokenKeys(phrase);
    if (
      phraseKeys.length > 0
      && phraseKeys.every((key, index) => tokenKeys[index] === key)
    ) {
      wakeLengths.push(phraseKeys.length);
    }
  }
  return wakeLengths.length > 0 ? [Math.max(...wakeLengths), 0] : [0];
}

function longestStageMatch(
  transcript: string,
  tokens: readonly Token[],
  start: number,
  aliasesByKey: ReadonlyMap<string, string>,
  reason: "canonical" | "configured",
): RouteResult | null {
  let winner: { end: number; alias: string } | null = null;
  let key = "";
  let maximumKeyLength = 0;
  for (const candidate of aliasesByKey.keys()) {
    maximumKeyLength = Math.max(maximumKeyLength, scalarLength(candidate));
  }

  for (let end = start + 1; end <= tokens.length; end += 1) {
    const token = tokens[end - 1];
    if (token === undefined) break;
    key += token.key;
    if (scalarLength(key) > maximumKeyLength) break;
    const alias = aliasesByKey.get(key);
    if (alias !== undefined) winner = { end, alias };
  }

  if (winner === null) return null;
  if (winner.end >= tokens.length) return rejectedRoute("missing_question");
  const questionToken = tokens[winner.end];
  if (questionToken === undefined) return rejectedRoute("missing_question");
  return acceptedRoute(
    winner.alias,
    transcript.slice(questionToken.utf16Start),
    questionToken.scalarStart,
    reason,
  );
}

function digitSequences(value: string): readonly string[] {
  return [...value.matchAll(/\p{Decimal_Number}+/gu)].map((match) => match[0]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fuzzyMatch(
  transcript: string,
  tokens: readonly Token[],
  start: number,
  canonicalByKey: ReadonlyMap<string, string>,
): RouteResult {
  const perAlias = new Map<string, FuzzyCandidate>();
  const aliases: FuzzyAliasMetadata[] = [];
  for (const [key, alias] of canonicalByKey) {
    const length = scalarLength(key);
    if (length < MIN_FUZZY_LENGTH) continue;
    aliases.push({
      key,
      alias,
      maximumDifference: Math.max(1, Math.ceil(length * 0.2)),
      digits: digitSequences(key),
    });
  }
  const maximumCandidateLength = aliases.reduce(
    (maximum, alias) => Math.max(
      maximum,
      scalarLength(alias.key) + alias.maximumDifference,
    ),
    0,
  );

  let candidateKey = "";
  for (let end = start + 1; end <= tokens.length; end += 1) {
    const token = tokens[end - 1];
    if (token === undefined) break;
    candidateKey += token.key;
    const candidateLength = scalarLength(candidateKey);
    if (candidateLength > maximumCandidateLength) break;
    if (end >= tokens.length || candidateLength < MIN_FUZZY_LENGTH) continue;
    const questionToken = tokens[end];
    if (questionToken === undefined) continue;
    const candidateDigits = digitSequences(candidateKey);

    for (const alias of aliases) {
      if (Math.abs(candidateLength - scalarLength(alias.key)) > alias.maximumDifference) continue;
      if (
        (candidateDigits.length > 0 || alias.digits.length > 0)
        && !sameStrings(candidateDigits, alias.digits)
      ) continue;

      const score = ratio(candidateKey, alias.key);
      const spanLength = end - start;
      const current = perAlias.get(alias.alias);
      if (
        current === undefined
        || score > current.score
        || (score === current.score && spanLength < current.spanLength)
      ) {
        perAlias.set(alias.alias, {
          score,
          spanLength,
          question: transcript.slice(questionToken.utf16Start),
          questionOffset: questionToken.scalarStart,
        });
      }
    }
  }

  const ranked = [...perAlias.entries()]
    .map(([alias, candidate]) => ({ alias, ...candidate }))
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      return left.alias < right.alias ? -1 : left.alias > right.alias ? 1 : 0;
    });
  const best = ranked[0];
  if (best === undefined) return rejectedRoute("no_match");
  const runnerUp = ranked[1];
  if (best.score < MIN_FUZZY_SIMILARITY) {
    return rejectedRoute("no_match", best.score, runnerUp?.score ?? null);
  }
  if (runnerUp !== undefined && best.score - runnerUp.score < MIN_FUZZY_MARGIN) {
    return rejectedRoute("ambiguous", best.score, runnerUp.score);
  }
  return acceptedRoute(
    best.alias,
    best.question,
    best.questionOffset,
    "fuzzy",
    best.score,
    runnerUp?.score ?? null,
  );
}

function acceptedRoute(
  alias: string,
  question: string,
  questionOffset: number,
  reason: AcceptedRouteReason,
  similarity: number | null = null,
  runnerUpSimilarity: number | null = null,
): AcceptedRoute {
  return Object.freeze({
    accepted: true,
    alias,
    question,
    questionOffset,
    reason,
    similarity,
    runnerUpSimilarity,
  });
}

function rejectedRoute(
  reason: RejectedRouteReason,
  similarity: number | null = null,
  runnerUpSimilarity: number | null = null,
): RejectedRoute {
  return Object.freeze({
    accepted: false,
    alias: null,
    question: null,
    questionOffset: null,
    reason,
    similarity,
    runnerUpSimilarity,
  });
}

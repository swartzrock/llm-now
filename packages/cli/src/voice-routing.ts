import {
  routeTranscript as routeCoreTranscript,
  routingSimilarity,
  type RouteRejectionReason as CoreRouteRejectionReason,
} from "@swartzrock/llm-now-core";
import { caseFold } from "unicode-case-folding";
import { posix } from "node:path";

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MIN_FUZZY_LENGTH = 4;
const MIN_FUZZY_SIMILARITY = 65;
const MIN_FUZZY_MARGIN = 15;
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
  readonly spokenNames: readonly string[];
  readonly voice?: string;
  readonly rate?: number;
  readonly pitch?: number;
}

export interface VoiceConfig {
  readonly defaultAlias?: string;
  readonly wakeWords: readonly string[];
  readonly minFuzzyPhraseLength: number;
  readonly minSimilarity: number;
  readonly minMargin: number;
  readonly profiles: Readonly<Record<string, AliasProfile>>;
}

export type AcceptedRouteReason = "canonical" | "configured" | "fuzzy" | "default";
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

export function ratio(left: string, right: string): number {
  return routingSimilarity(left, right);
}

export function resolveVoiceConfigPath(home: string, xdgConfigHome?: string): string {
  const root = xdgConfigHome && posix.isAbsolute(xdgConfigHome)
    ? xdgConfigHome
    : posix.join(home, ".config");
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

    const allowedFields = new Set(["spoken_names", "voice", "rate", "pitch"]);
    const unknownFields = Object.keys(rawProfile)
      .filter((field) => !allowedFields.has(field))
      .sort();
    if (unknownFields.length > 0) {
      throw new VoiceRouterError(
        `unknown profile field for "${alias}": ${unknownFields.join(", ")}`,
      );
    }

    const spokenNames = stringList(rawProfile.spoken_names ?? [], `${alias}.spoken_names`);
    validatePhrases(spokenNames, `${alias}.spoken_names`);

    const profile: {
      spokenNames: readonly string[];
      voice?: string;
      rate?: number;
      pitch?: number;
    } = { spokenNames: Object.freeze([...spokenNames]) };

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

  validateActiveSpokenNames(profiles, activeAliases);
  return freezeConfig(wakeWords, profiles);
}

export function routeTranscript(
  transcript: string,
  aliases: Iterable<string>,
  config: VoiceConfig,
): RouteResult {
  const activeAliases = validatedAliases(aliases);
  try {
    const result = routeCoreTranscript({
      transcript,
      candidates: activeAliases.map((alias) => ({
        id: alias,
        canonicalName: alias,
        alternateSpokenNames: Object.hasOwn(config.profiles, alias)
          ? config.profiles[alias]?.spokenNames ?? []
          : [],
      })),
      wakeWords: config.wakeWords,
      minFuzzyPhraseLength: config.minFuzzyPhraseLength,
      minSimilarity: config.minSimilarity,
      minMargin: config.minMargin,
      ...(config.defaultAlias === undefined
        ? {}
        : { defaultCandidateId: config.defaultAlias }),
    });

    if (!result.accepted) {
      return Object.freeze({
        accepted: false,
        alias: null,
        question: null,
        questionOffset: null,
        reason: result.reason as CoreRouteRejectionReason,
        similarity: result.similarity,
        runnerUpSimilarity: result.runnerUpSimilarity,
      });
    }
    return Object.freeze({
      accepted: true,
      alias: result.candidateId,
      question: result.question,
      questionOffset: result.questionOffset,
      reason: result.reason === "alternate" ? "configured" : result.reason,
      similarity: result.similarity,
      runnerUpSimilarity: result.runnerUpSimilarity,
    });
  } catch (error) {
    throw new VoiceRouterError("invalid voice routing candidates", { cause: error });
  }
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

function validateActiveSpokenNames(
  profiles: Readonly<Record<string, AliasProfile>>,
  activeAliases: readonly string[],
): void {
  const canonicalByKey = new Map<string, string>();
  for (const alias of activeAliases) canonicalByKey.set(compactKey(alias), alias);
  const spokenNameOwners = new Map<string, string>();

  for (const alias of activeAliases) {
    const profile = Object.hasOwn(profiles, alias) ? profiles[alias] : undefined;
    if (profile === undefined) continue;
    for (const spokenName of profile.spokenNames) {
      const key = compactKey(spokenName);
      const canonicalOwner = canonicalByKey.get(key);
      if (canonicalOwner !== undefined && canonicalOwner !== alias) {
        throw new VoiceRouterError(
          `spoken name "${spokenName}" for "${alias}" collides with canonical alias "${canonicalOwner}"`,
        );
      }
      const spokenNameOwner = spokenNameOwners.get(key);
      if (spokenNameOwner !== undefined && spokenNameOwner !== alias) {
        throw new VoiceRouterError(
          `spoken name "${spokenName}" is shared by "${spokenNameOwner}" and "${alias}"`,
        );
      }
      spokenNameOwners.set(key, alias);
    }
  }
}

function freezeConfig(
  wakeWords: readonly string[],
  profiles: Record<string, AliasProfile>,
): VoiceConfig {
  return Object.freeze({
    wakeWords: Object.freeze([...wakeWords]),
    minFuzzyPhraseLength: MIN_FUZZY_LENGTH,
    minSimilarity: MIN_FUZZY_SIMILARITY,
    minMargin: MIN_FUZZY_MARGIN,
    profiles: Object.freeze(profiles),
  });
}

import { isByokProviderId, type ByokProviderId } from "@swartzrock/byok-runtime";
import { parse as parseToml, stringify } from "smol-toml";
import {
  hasInvalidInstructionCharacters,
  isValidAliasName,
  type AliasRecord,
} from "./aliases.ts";
import { compactKey, type AliasProfile, type VoiceConfig } from "./voice-routing.ts";

const DEFAULT_MODEL_PROVIDERS = new Set<ByokProviderId>(["codex-cli", "claude-cli"]);
const ROOT_FIELDS = new Set(["version", "voice", "aliases"]);
const VOICE_FIELDS = new Set([
  "wake_words",
  "min_fuzzy_phrase_length",
  "min_similarity",
  "min_margin",
]);
const ALIAS_FIELDS = new Set([
  "provider",
  "model",
  "instructions",
  "spoken_names",
  "voice",
  "rate",
  "pitch",
]);

export interface StoredVoiceConfig {
  readonly wakeWords?: readonly string[];
  readonly minFuzzyPhraseLength?: number;
  readonly minSimilarity?: number;
  readonly minMargin?: number;
}

export interface StoredAliasConfig {
  readonly provider: ByokProviderId;
  readonly model: string;
  readonly instructions?: string;
  readonly spokenNames?: readonly string[];
  readonly voice?: string;
  readonly rate?: number;
  readonly pitch?: number;
}

export interface ConfigDocumentV1 {
  readonly version: 1;
  readonly voice?: StoredVoiceConfig;
  readonly aliases: Readonly<Record<string, StoredAliasConfig>>;
}

export interface EffectiveVoiceConfig extends VoiceConfig {
  readonly minFuzzyPhraseLength: number;
  readonly minSimilarity: number;
  readonly minMargin: number;
}

export type ConfigErrorCategory = "parse" | "schema";

export class ConfigSchemaError extends Error {
  readonly category: ConfigErrorCategory;
  readonly line?: number;

  constructor(
    message: string,
    category: ConfigErrorCategory = "schema",
    options: { line?: number; cause?: Error } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ConfigSchemaError";
    this.category = category;
    if (options.line !== undefined) this.line = options.line;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  location: string,
): void {
  const unknown = Object.keys(value).filter((field) => !allowed.has(field)).sort();
  if (unknown.length > 0) {
    throw new ConfigSchemaError(`unknown configuration field at ${location}`);
  }
}

function assertIntegerKinds(value: unknown): void {
  if (!isRecord(value)) return;
  if (Object.hasOwn(value, "version") && typeof value.version !== "bigint") {
    throw new ConfigSchemaError("version must be an integer");
  }
  if (isRecord(value.voice)) {
    for (const field of ["min_fuzzy_phrase_length", "min_similarity", "min_margin"] as const) {
      if (Object.hasOwn(value.voice, field) && typeof value.voice[field] !== "bigint") {
        throw new ConfigSchemaError(`voice.${field} must be an integer`);
      }
    }
  }
  if (!isRecord(value.aliases)) return;
  for (const alias of Object.values(value.aliases)) {
    if (isRecord(alias) && Object.hasOwn(alias, "rate") && typeof alias.rate !== "bigint") {
      throw new ConfigSchemaError("alias rate must be an integer");
    }
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigSchemaError(`${field} must be a nonempty string`);
  }
  return value;
}

function optionalStringList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigSchemaError(`${field} must be a list of strings`);
  }
  const result = value as string[];
  const seen = new Set<string>();
  for (const phrase of result) {
    const key = compactKey(phrase);
    if (key.length === 0) throw new ConfigSchemaError(`${field} contains a blank normalized phrase`);
    if (seen.has(key)) throw new ConfigSchemaError(`${field} contains a duplicate phrase`);
    seen.add(key);
  }
  return Object.freeze([...result]);
}

function integerInRange(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ConfigSchemaError(`${field} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function optionalPitch(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 127) {
    throw new ConfigSchemaError(`${field} must be a number from 1 through 127`);
  }
  return value;
}

function validateInstructions(value: unknown): string {
  const instructions = requiredString(value, "instructions");
  if (hasInvalidInstructionCharacters(instructions)) {
    throw new ConfigSchemaError("instructions contain unsupported control characters");
  }
  return instructions;
}

function parseVoice(value: unknown): StoredVoiceConfig {
  if (!isRecord(value)) throw new ConfigSchemaError("voice must be a TOML table");
  rejectUnknownFields(value, VOICE_FIELDS, "voice");
  const voice: {
    wakeWords?: readonly string[];
    minFuzzyPhraseLength?: number;
    minSimilarity?: number;
    minMargin?: number;
  } = {};
  if (Object.hasOwn(value, "wake_words")) {
    voice.wakeWords = optionalStringList(value.wake_words, "voice.wake_words");
  }
  if (Object.hasOwn(value, "min_fuzzy_phrase_length")) {
    voice.minFuzzyPhraseLength = integerInRange(
      value.min_fuzzy_phrase_length,
      "voice.min_fuzzy_phrase_length",
      1,
      64,
    );
  }
  if (Object.hasOwn(value, "min_similarity")) {
    voice.minSimilarity = integerInRange(value.min_similarity, "voice.min_similarity", 0, 100);
  }
  if (Object.hasOwn(value, "min_margin")) {
    voice.minMargin = integerInRange(value.min_margin, "voice.min_margin", 0, 100);
  }
  return Object.freeze(voice);
}

function parseAlias(name: string, value: unknown): StoredAliasConfig {
  if (!isRecord(value)) throw new ConfigSchemaError(`alias ${name} must be a TOML table`);
  rejectUnknownFields(value, ALIAS_FIELDS, `aliases.${name}`);
  if (!isByokProviderId(value.provider)) {
    throw new ConfigSchemaError(`aliases.${name}.provider is unsupported`);
  }
  const model = requiredString(value.model, `aliases.${name}.model`);
  if (model === "default" && !DEFAULT_MODEL_PROVIDERS.has(value.provider)) {
    throw new ConfigSchemaError(`aliases.${name}.model cannot use default for this provider`);
  }

  const alias: {
    provider: ByokProviderId;
    model: string;
    instructions?: string;
    spokenNames?: readonly string[];
    voice?: string;
    rate?: number;
    pitch?: number;
  } = { provider: value.provider, model };
  if (Object.hasOwn(value, "instructions")) alias.instructions = validateInstructions(value.instructions);
  if (Object.hasOwn(value, "spoken_names")) {
    alias.spokenNames = optionalStringList(value.spoken_names, `aliases.${name}.spoken_names`);
  }
  if (Object.hasOwn(value, "voice")) {
    alias.voice = requiredString(value.voice, `aliases.${name}.voice`).trim();
  }
  if (Object.hasOwn(value, "rate")) {
    alias.rate = integerInRange(value.rate, `aliases.${name}.rate`, 80, 500);
  }
  if (Object.hasOwn(value, "pitch")) {
    alias.pitch = optionalPitch(value.pitch, `aliases.${name}.pitch`);
  }
  return Object.freeze(alias);
}

function sourceLine(error: unknown): number | undefined {
  if (
    isRecord(error)
    && isRecord(error.position)
    && typeof error.position.line === "number"
    && Number.isInteger(error.position.line)
    && error.position.line > 0
  ) {
    return error.position.line;
  }
  if (!(error instanceof Error)) return undefined;
  const match = /(?:line\s+|:)(\d+)(?::\d+)?/i.exec(error.message);
  if (match === null) return undefined;
  const line = Number(match[1]);
  return Number.isInteger(line) && line > 0 ? line : undefined;
}

export function parseConfigDocument(text: string, path = "config.toml"): ConfigDocumentV1 {
  let raw: unknown;
  let typedNumbers: unknown;
  try {
    raw = Bun.TOML.parse(text);
    typedNumbers = parseToml(text, { integersAsBigInt: true });
  } catch (error) {
    const line = sourceLine(error);
    throw new ConfigSchemaError(
      `failed to parse configuration: ${path}${line === undefined ? "" : `:${line}`}`,
      "parse",
      { line, cause: new Error("TOML parse failed") },
    );
  }
  assertIntegerKinds(typedNumbers);
  if (!isRecord(raw)) throw new ConfigSchemaError("configuration root must be a TOML table");
  rejectUnknownFields(raw, ROOT_FIELDS, "root");
  if (raw.version !== 1) throw new ConfigSchemaError("unsupported configuration version");
  if (!isRecord(raw.aliases)) throw new ConfigSchemaError("aliases must be a TOML table");

  const aliases: Record<string, StoredAliasConfig> = {};
  const names = new Map<string, string>();
  const routingNames = new Map<string, string>();
  for (const [originalName, value] of Object.entries(raw.aliases)) {
    if (!isValidAliasName(originalName)) throw new ConfigSchemaError("invalid alias name");
    const name = originalName.toLowerCase();
    if (names.has(name)) throw new ConfigSchemaError(`duplicate case-insensitive alias: ${name}`);
    const routingName = compactKey(name);
    const routingCollision = routingNames.get(routingName);
    if (routingCollision !== undefined) {
      throw new ConfigSchemaError(`aliases ${routingCollision} and ${name} collide after routing normalization`);
    }
    names.set(name, originalName);
    routingNames.set(routingName, name);
    aliases[name] = parseAlias(name, value);
  }

  const spokenNameOwners = new Map<string, string>();
  for (const [name, alias] of Object.entries(aliases)) {
    for (const spokenName of alias.spokenNames ?? []) {
      const key = compactKey(spokenName);
      const canonicalOwner = routingNames.get(key);
      if (canonicalOwner !== undefined && canonicalOwner !== name) {
        throw new ConfigSchemaError(`spoken name for ${name} collides with canonical alias`);
      }
      const spokenNameOwner = spokenNameOwners.get(key);
      if (spokenNameOwner !== undefined && spokenNameOwner !== name) {
        throw new ConfigSchemaError(`spoken name is shared by ${spokenNameOwner} and ${name}`);
      }
      spokenNameOwners.set(key, name);
    }
  }

  const document: { version: 1; voice?: StoredVoiceConfig; aliases: Record<string, StoredAliasConfig> } = {
    version: 1,
    aliases: Object.freeze(aliases),
  };
  if (Object.hasOwn(raw, "voice")) document.voice = parseVoice(raw.voice);
  return Object.freeze(document);
}

export function projectAliases(document: ConfigDocumentV1): Readonly<Record<string, AliasRecord>> {
  const aliases: Record<string, AliasRecord> = {};
  for (const [name, stored] of Object.entries(document.aliases)) {
    const record: AliasRecord = {
      provider: stored.provider,
      model: stored.model === "default" ? null : stored.model,
    };
    if (stored.instructions !== undefined) {
      record.instructions = stored.instructions;
    }
    aliases[name] = Object.freeze(record);
  }
  return Object.freeze(aliases);
}

export function projectVoiceConfig(document: ConfigDocumentV1): EffectiveVoiceConfig {
  const profiles: Record<string, AliasProfile> = {};
  for (const [name, stored] of Object.entries(document.aliases)) {
    const profile: { spokenNames: readonly string[]; voice?: string; rate?: number; pitch?: number } = {
      spokenNames: Object.freeze([...(stored.spokenNames ?? [])]),
    };
    if (stored.voice !== undefined) profile.voice = stored.voice;
    if (stored.rate !== undefined) profile.rate = stored.rate;
    if (stored.pitch !== undefined) profile.pitch = stored.pitch;
    profiles[name] = Object.freeze(profile);
  }
  return Object.freeze({
    wakeWords: Object.freeze([...(document.voice?.wakeWords ?? ["hey"])]),
    minFuzzyPhraseLength: document.voice?.minFuzzyPhraseLength ?? 4,
    minSimilarity: document.voice?.minSimilarity ?? 65,
    minMargin: document.voice?.minMargin ?? 15,
    profiles: Object.freeze(profiles),
  });
}

export function serializeConfigDocument(document: ConfigDocumentV1): string {
  const aliases: Record<string, Record<string, unknown>> = {};
  for (const name of Object.keys(document.aliases).sort()) {
    const stored = document.aliases[name];
    if (stored === undefined) continue;
    aliases[name] = {
      provider: stored.provider,
      model: stored.model,
      ...(stored.instructions === undefined ? {} : { instructions: stored.instructions }),
      ...(stored.spokenNames === undefined ? {} : { spoken_names: [...stored.spokenNames] }),
      ...(stored.voice === undefined ? {} : { voice: stored.voice }),
      ...(stored.rate === undefined ? {} : { rate: stored.rate }),
      ...(stored.pitch === undefined ? {} : { pitch: stored.pitch }),
    };
  }
  const canonical: Record<string, unknown> = { version: 1 };
  if (document.voice !== undefined) {
    canonical.voice = {
      ...(document.voice.wakeWords === undefined ? {} : { wake_words: [...document.voice.wakeWords] }),
      ...(document.voice.minFuzzyPhraseLength === undefined
        ? {}
        : { min_fuzzy_phrase_length: document.voice.minFuzzyPhraseLength }),
      ...(document.voice.minSimilarity === undefined
        ? {}
        : { min_similarity: document.voice.minSimilarity }),
      ...(document.voice.minMargin === undefined ? {} : { min_margin: document.voice.minMargin }),
    };
  }
  canonical.aliases = aliases;
  return stringify(canonical);
}

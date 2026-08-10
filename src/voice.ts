import { BYOK_API_KEY_ENV_VARS, type ByokEnvironment } from "@swartzrock/byok-runtime";
import { caseFold } from "unicode-case-folding";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { AliasRecord } from "./aliases.ts";
import type { ConfigSnapshot } from "./config.ts";
import {
  createSensitiveValueRegistry,
  type SensitiveValueRegistry,
} from "./credentials.ts";
import { stripTerminalSequences } from "./prompts.ts";
import {
  formatTrustedPitchCommand,
  parseVoiceInventory,
  routeTranscript,
  validateSpeechAnswer,
  type AliasProfile,
  type RejectedRouteReason,
} from "./voice-routing.ts";

const SAY = "/usr/bin/say";
const DEFAULT_INVENTORY_TIMEOUT_MS = 5_000;
const DEFAULT_SPEECH_TIMEOUT_MS = 120_000;
const FORCE_KILL_DELAY_MS = 250;

export const RETRY_NOTICE = "I couldn't match an alias and question. Please try again.";
export const REQUEST_FAILED_NOTICE = "The request failed. Please try again.";
export const CONFIG_FAILED_NOTICE =
  "The voice router needs attention. Check the Shortcut result.";
export const CREATE_ALIAS_NOTICE = "No aliases are configured. Create an alias and try again.";
export const VOICE_PROMPT =
  "Answer concisely in plain text suitable for speech. Do not use Markdown or code fences unless the question requires code.";

export interface VoiceCancellation {
  readonly signal: AbortSignal;
  dispose(): void;
}

export interface VoiceSignalTarget {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export function installVoiceCancellation(
  target: VoiceSignalTarget = process,
): VoiceCancellation {
  const controller = new AbortController();
  let disposed = false;
  const abort = () => controller.abort();
  target.on("SIGINT", abort);
  target.on("SIGTERM", abort);

  return {
    signal: controller.signal,
    dispose() {
      if (disposed) return;
      disposed = true;
      target.off("SIGINT", abort);
      target.off("SIGTERM", abort);
    },
  };
}

export interface VoiceProcessRequest {
  readonly executable: typeof SAY;
  readonly args: readonly string[];
  readonly stdin: Uint8Array;
  readonly env: ByokEnvironment;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export type VoiceProcessOutcome =
  | Readonly<{ kind: "completed"; stdout: Uint8Array; stderr: Uint8Array }>
  | Readonly<{ kind: "failed"; detail: string }>
  | Readonly<{ kind: "timed_out"; detail: string }>
  | Readonly<{ kind: "cancelled" }>;

export interface VoiceProcessRunner {
  isExecutable(path: string): Promise<boolean>;
  run(request: VoiceProcessRequest): Promise<VoiceProcessOutcome>;
}

interface VoiceSpawnedProcess {
  readonly stdin: {
    write(data: Uint8Array): unknown;
    end(): unknown;
  };
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  kill(signal: NodeJS.Signals): void;
}

interface BunVoiceProcessDependencies {
  access?: (path: string, mode: number) => Promise<void>;
  spawn?: (options: {
    cmd: string[];
    stdin: "pipe";
    stdout: "pipe";
    stderr: "pipe";
    env: ByokEnvironment;
  }) => VoiceSpawnedProcess;
  forceKillDelayMs?: number;
}

function bytes(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (stream === null) return Promise.resolve(new Uint8Array());
  return new Response(stream).arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function terminateAndReap(
  process: VoiceSpawnedProcess,
  forceKillDelayMs: number,
): Promise<void> {
  if (process.exitCode === null) process.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    process.exited.then(() => true, () => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), forceKillDelayMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (!exited && process.exitCode === null) process.kill("SIGKILL");
  await process.exited.catch(() => undefined);
}

export function createBunVoiceProcessRunner(
  deps: BunVoiceProcessDependencies = {},
): VoiceProcessRunner {
  const checkAccess = deps.access ?? access;
  const spawn = deps.spawn ?? ((options) => Bun.spawn(options));
  const forceKillDelayMs = deps.forceKillDelayMs ?? FORCE_KILL_DELAY_MS;

  return {
    async isExecutable(path) {
      try {
        await checkAccess(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },

    async run(request) {
      if (request.signal.aborted) return { kind: "cancelled" };

      let child: VoiceSpawnedProcess;
      try {
        child = spawn({
          cmd: [request.executable, ...request.args],
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: request.env,
        });
      } catch (error) {
        return { kind: "failed", detail: detail(error) };
      }

      const completion = (async (): Promise<VoiceProcessOutcome> => {
        try {
          child.stdin.write(request.stdin);
          child.stdin.end();
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            bytes(child.stdout),
            bytes(child.stderr),
          ]);
          return exitCode === 0
            ? { kind: "completed", stdout, stderr }
            : {
              kind: "failed",
              detail: new TextDecoder().decode(stderr).trim() || `exited with status ${exitCode}`,
            };
        } catch (error) {
          return { kind: "failed", detail: detail(error) };
        }
      })();

      let interrupt: (outcome: VoiceProcessOutcome) => void = () => undefined;
      const interrupted = new Promise<VoiceProcessOutcome>((resolve) => {
        interrupt = resolve;
      });
      const cancel = () => interrupt({ kind: "cancelled" });
      request.signal.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(
        () => interrupt({
          kind: "timed_out",
          detail: `timed out after ${request.timeoutMs}ms`,
        }),
        request.timeoutMs,
      );
      if (request.signal.aborted) cancel();

      const outcome = await Promise.race([completion, interrupted]);
      clearTimeout(timer);
      request.signal.removeEventListener("abort", cancel);
      if (outcome.kind === "cancelled" || outcome.kind === "timed_out") {
        await terminateAndReap(child, forceKillDelayMs);
        await completion;
        return request.signal.aborted ? { kind: "cancelled" } : outcome;
      }
      return request.signal.aborted ? { kind: "cancelled" } : outcome;
    },
  };
}

function filteredEnvironment(env: ByokEnvironment): ByokEnvironment {
  const filtered = { ...env };
  for (const name of BYOK_API_KEY_ENV_VARS) delete filtered[name];
  return filtered;
}

function strictUtf8(value: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

function redactionVariants(value: string): readonly string[] {
  if (value.length === 0) return [];
  const serialized = JSON.stringify(value);
  const escaped = serialized.slice(1, -1);
  return [value, serialized, escaped, JSON.stringify(escaped).slice(1, -1)];
}

function redactRequestValues(value: string, requestValues: readonly string[]): string {
  return createSensitiveValueRegistry(requestValues.flatMap(redactionVariants)).redact(value);
}

function canonicalizeDiagnostic(value: string): string {
  return stripTerminalSequences(value.replace(/\r\n?|\u2028|\u2029/g, "\n"))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

function childDetail(outcome: Exclude<VoiceProcessOutcome, { kind: "completed" | "cancelled" }>): string {
  return outcome.detail;
}

export type VoiceRouteRejectionReason = RejectedRouteReason
  | "empty_aliases"
  | "invalid_snapshot";

export type VoiceRouteOutcome =
  | Readonly<{
    kind: "routed";
    alias: string;
    aliasRecord: AliasRecord;
    question: string;
    profile?: AliasProfile;
  }>
  | Readonly<{
    kind: "rejected";
    reason: VoiceRouteRejectionReason;
  }>;

export function routeVoiceTranscript(
  transcript: string,
  snapshot: ConfigSnapshot,
): VoiceRouteOutcome {
  const aliasNames = Object.keys(snapshot.aliases);
  if (aliasNames.length === 0) {
    return Object.freeze({ kind: "rejected", reason: "empty_aliases" });
  }

  let route: ReturnType<typeof routeTranscript>;
  try {
    route = routeTranscript(transcript, aliasNames, snapshot.voice);
  } catch {
    return Object.freeze({ kind: "rejected", reason: "invalid_snapshot" });
  }
  if (!route.accepted) {
    return Object.freeze({ kind: "rejected", reason: route.reason });
  }

  const aliasRecord = snapshot.aliases[route.alias];
  if (aliasRecord === undefined) {
    return Object.freeze({ kind: "rejected", reason: "invalid_snapshot" });
  }
  const profile = snapshot.voice.profiles[route.alias];
  return Object.freeze({
    kind: "routed",
    alias: route.alias,
    aliasRecord,
    question: route.question,
    ...(profile === undefined ? {} : { profile }),
  });
}

export interface VoiceSpeechDependencies {
  readonly sensitive: SensitiveValueRegistry;
  readonly env: ByokEnvironment;
  readonly runner: VoiceProcessRunner;
  readonly signal: AbortSignal;
  readonly diagnostic: (detail: string) => void;
  readonly requestValues?: readonly string[];
  readonly inventoryTimeoutMs?: number;
  readonly speechTimeoutMs?: number;
}

export interface PreparedVoiceSpeech {
  readonly args: readonly string[];
  readonly pitchPrefix: string;
}

export type VoiceSpeechPreflightFailureReason =
  | "executable_unavailable"
  | "voice_inventory"
  | "voice_unavailable"
  | "invalid_profile";

export type VoiceSpeechPreflightOutcome =
  | Readonly<{ kind: "ready"; speech: PreparedVoiceSpeech }>
  | Readonly<{
    kind: "configuration_failed";
    reason: VoiceSpeechPreflightFailureReason;
    noticeSpeech?: PreparedVoiceSpeech;
  }>
  | Readonly<{ kind: "cancelled" }>;

export type VoiceSpeechExecutionFailureReason = "failed" | "timed_out";

export type VoiceNoticeOutcome =
  | Readonly<{ kind: "completed" }>
  | Readonly<{ kind: "failed"; reason: VoiceSpeechExecutionFailureReason }>
  | Readonly<{ kind: "cancelled" }>;

export type VoiceAnswerOutcome = VoiceNoticeOutcome
  | Readonly<{ kind: "rejected"; reason: "blank" | "unsafe" | "credential" }>;

export type VoiceNotice = typeof RETRY_NOTICE
  | typeof REQUEST_FAILED_NOTICE
  | typeof CONFIG_FAILED_NOTICE
  | typeof CREATE_ALIAS_NOTICE;

interface VoiceSpeechState {
  readonly sensitive: SensitiveValueRegistry;
  readonly env: ByokEnvironment;
  readonly runner: VoiceProcessRunner;
  readonly signal: AbortSignal;
  readonly diagnostic: (detail: string) => void;
  readonly requestValues: string[];
  readonly speechTimeoutMs: number;
}

const preparedVoiceSpeechStates = new WeakMap<PreparedVoiceSpeech, VoiceSpeechState>();

function createVoiceSpeechState(deps: VoiceSpeechDependencies): VoiceSpeechState {
  return {
    sensitive: deps.sensitive,
    env: filteredEnvironment(deps.env),
    runner: deps.runner,
    signal: deps.signal,
    diagnostic: deps.diagnostic,
    requestValues: [...(deps.requestValues ?? [])],
    speechTimeoutMs: deps.speechTimeoutMs ?? DEFAULT_SPEECH_TIMEOUT_MS,
  };
}

function reportVoiceSpeechDiagnostic(
  state: VoiceSpeechState,
  category: string,
  value?: unknown,
): void {
  const suffix = value === undefined ? "" : `: ${detail(value)}`;
  state.diagnostic(redactRequestValues(
    canonicalizeDiagnostic(`${category}${suffix}`),
    state.requestValues,
  ));
}

function preparedVoiceSpeech(
  state: VoiceSpeechState,
  args: readonly string[],
  pitchPrefix: string,
): PreparedVoiceSpeech {
  const speech = Object.freeze({
    args: Object.freeze([...args]),
    pitchPrefix,
  });
  preparedVoiceSpeechStates.set(speech, state);
  return speech;
}

function voiceSpeechState(speech: PreparedVoiceSpeech): VoiceSpeechState {
  const state = preparedVoiceSpeechStates.get(speech);
  if (state === undefined) throw new TypeError("invalid prepared voice speech handle");
  return state;
}

async function runVoiceSpeechChild(
  state: VoiceSpeechState,
  args: readonly string[],
  stdin: Uint8Array,
  timeoutMs: number,
): Promise<VoiceProcessOutcome> {
  if (state.signal.aborted) return { kind: "cancelled" };
  try {
    return await state.runner.run({
      executable: SAY,
      args: [...args],
      stdin,
      env: state.env,
      signal: state.signal,
      timeoutMs,
    });
  } catch (error) {
    return state.signal.aborted
      ? { kind: "cancelled" }
      : { kind: "failed", detail: detail(error) };
  }
}

function configurationFailure(
  state: VoiceSpeechState,
  reason: VoiceSpeechPreflightFailureReason,
  value: unknown,
  noticeSpeech?: PreparedVoiceSpeech,
): VoiceSpeechPreflightOutcome {
  reportVoiceSpeechDiagnostic(state, "voice configuration failed", value);
  return Object.freeze({
    kind: "configuration_failed",
    reason,
    ...(noticeSpeech === undefined ? {} : { noticeSpeech }),
  });
}

export async function prepareVoiceSpeech(
  deps: VoiceSpeechDependencies,
  profile?: AliasProfile,
): Promise<VoiceSpeechPreflightOutcome> {
  const state = createVoiceSpeechState(deps);
  if (state.signal.aborted) return Object.freeze({ kind: "cancelled" });

  let sayAvailable = false;
  try {
    sayAvailable = await state.runner.isExecutable(SAY);
  } catch (error) {
    if (state.signal.aborted) return Object.freeze({ kind: "cancelled" });
    return configurationFailure(state, "executable_unavailable", error);
  }
  if (state.signal.aborted) return Object.freeze({ kind: "cancelled" });
  if (!sayAvailable) {
    return configurationFailure(
      state,
      "executable_unavailable",
      "required executable is unavailable: /usr/bin/say",
    );
  }

  const noticeSpeech = preparedVoiceSpeech(state, [], "");
  let pitchPrefix = "";
  const speechArgs: string[] = [];
  try {
    if (profile?.rate !== undefined) {
      if (!Number.isInteger(profile.rate) || profile.rate < 80 || profile.rate > 500) {
        throw new Error("configured speech rate is invalid");
      }
    }
    if (profile?.pitch !== undefined) pitchPrefix = formatTrustedPitchCommand(profile.pitch);
    if (profile?.voice !== undefined && profile.voice.trim().length === 0) {
      throw new Error("configured voice is invalid");
    }
  } catch (error) {
    return configurationFailure(state, "invalid_profile", error, noticeSpeech);
  }

  if (profile?.voice !== undefined) {
    state.requestValues.push(profile.voice);
    const inventory = await runVoiceSpeechChild(
      state,
      ["-v", "?"],
      new Uint8Array(),
      deps.inventoryTimeoutMs ?? DEFAULT_INVENTORY_TIMEOUT_MS,
    );
    if (state.signal.aborted || inventory.kind === "cancelled") {
      return Object.freeze({ kind: "cancelled" });
    }
    if (inventory.kind !== "completed") {
      return configurationFailure(
        state,
        "voice_inventory",
        `voice inventory ${inventory.kind}: ${childDetail(inventory)}`,
        noticeSpeech,
      );
    }
    let installedVoice: string | undefined;
    try {
      installedVoice = parseVoiceInventory(strictUtf8(inventory.stdout)).get(caseFold(profile.voice));
    } catch (error) {
      return configurationFailure(state, "voice_inventory", error, noticeSpeech);
    }
    if (installedVoice === undefined) {
      return configurationFailure(
        state,
        "voice_unavailable",
        "configured voice is not installed",
        noticeSpeech,
      );
    }
    speechArgs.push("-v", installedVoice);
  }
  if (profile?.rate !== undefined) speechArgs.push("-r", String(profile.rate));

  return Object.freeze({
    kind: "ready",
    speech: preparedVoiceSpeech(state, speechArgs, pitchPrefix),
  });
}

function processOutcome(
  state: VoiceSpeechState,
  category: string,
  outcome: VoiceProcessOutcome,
): VoiceNoticeOutcome {
  if (state.signal.aborted || outcome.kind === "cancelled") {
    return Object.freeze({ kind: "cancelled" });
  }
  if (outcome.kind === "completed") return Object.freeze({ kind: "completed" });
  reportVoiceSpeechDiagnostic(state, category, childDetail(outcome));
  return Object.freeze({ kind: "failed", reason: outcome.kind });
}

export async function speakVoiceNotice(
  speech: PreparedVoiceSpeech,
  notice: VoiceNotice,
): Promise<VoiceNoticeOutcome> {
  const state = voiceSpeechState(speech);
  const outcome = await runVoiceSpeechChild(
    state,
    [],
    new TextEncoder().encode(notice),
    state.speechTimeoutMs,
  );
  return processOutcome(state, "voice notice speech failed", outcome);
}

export async function speakVoiceAnswer(
  speech: PreparedVoiceSpeech,
  answer: string,
): Promise<VoiceAnswerOutcome> {
  const state = voiceSpeechState(speech);
  state.requestValues.push(answer);
  const validation = validateSpeechAnswer(answer);
  if (!validation.valid) {
    reportVoiceSpeechDiagnostic(state, `voice generation returned ${validation.reason} text`);
    return Object.freeze({ kind: "rejected", reason: validation.reason });
  }
  const terminalAnswer = stripTerminalSequences(answer);
  if (
    state.sensitive.redact(answer) !== answer
    || state.sensitive.redact(terminalAnswer) !== terminalAnswer
  ) {
    reportVoiceSpeechDiagnostic(state, "voice generation returned credential-bearing text");
    return Object.freeze({ kind: "rejected", reason: "credential" });
  }

  const bytes = `${speech.pitchPrefix}${answer}`;
  state.requestValues.push(bytes);
  const outcome = await runVoiceSpeechChild(
    state,
    speech.args,
    new TextEncoder().encode(bytes),
    state.speechTimeoutMs,
  );
  return processOutcome(state, `voice answer speech ${outcome.kind}`, outcome);
}

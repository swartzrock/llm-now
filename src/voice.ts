import { BYOK_API_KEY_ENV_VARS, type ByokEnvironment } from "@swartzrock/byok-runtime";
import { caseFold } from "unicode-case-folding";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { AliasDocument, AliasRecord } from "./aliases.ts";
import type { ConfigSnapshot } from "./config.ts";
import {
  createSensitiveValueRegistry,
  type SensitiveValueRegistry,
} from "./credentials.ts";
import { InvalidUtf8Error, resolveInputSource, type PromptInput } from "./io.ts";
import { stripTerminalSequences } from "./prompts.ts";
import type { RuntimeGateway } from "./runtime.ts";
import {
  formatTrustedPitchCommand,
  parseVoiceConfig,
  parseVoiceInventory,
  resolveVoiceConfigPath,
  routeTranscript,
  validateSpeechAnswer,
  type VoiceConfig,
} from "./voice-routing.ts";

const SAY = "/usr/bin/say";
const PBCOPY = "/usr/bin/pbcopy";
const DEFAULT_GENERATION_TIMEOUT_MS = 45_000;
const DEFAULT_INVENTORY_TIMEOUT_MS = 5_000;
const DEFAULT_CLIPBOARD_TIMEOUT_MS = 5_000;
const DEFAULT_SPEECH_TIMEOUT_MS = 120_000;
const DEFAULT_GENERATION_CLEANUP_TIMEOUT_MS = 500;
const FORCE_KILL_DELAY_MS = 250;

export const RETRY_NOTICE = "I couldn't match an alias and question. Please try again.";
export const REQUEST_FAILED_NOTICE = "The request failed. Please try again.";
export const CONFIG_FAILED_NOTICE =
  "The voice router needs attention. Check the Shortcut result.";
export const COPY_FAILED_NOTICE =
  "I couldn't copy the answer. Check the Shortcut result.";
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
  readonly executable: typeof SAY | typeof PBCOPY;
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

export interface VoiceDependencies {
  readonly inputFlag: string | undefined;
  readonly stdin: PromptInput;
  readonly runtime: RuntimeGateway;
  readonly sensitive: SensitiveValueRegistry;
  readonly env: ByokEnvironment;
  readonly home: string;
  readonly aliasPath: string;
  readonly loadAliases: (path: string) => Promise<AliasDocument>;
  readonly readConfig?: (path: string) => Promise<Uint8Array | null>;
  readonly snapshot?: ConfigSnapshot;
  readonly runner: VoiceProcessRunner;
  readonly signal: AbortSignal;
  readonly diagnostic: (detail: string) => void;
  readonly generationTimeoutMs?: number;
  readonly generationCleanupTimeoutMs?: number;
  readonly inventoryTimeoutMs?: number;
  readonly clipboardTimeoutMs?: number;
  readonly speechTimeoutMs?: number;
}

export type VoiceExitCode = 0 | 1 | 130;

async function readVoiceConfig(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await Bun.file(path).arrayBuffer());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function strictUtf8(value: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

function filteredEnvironment(env: ByokEnvironment): ByokEnvironment {
  const filtered = { ...env };
  for (const name of BYOK_API_KEY_ENV_VARS) delete filtered[name];
  return filtered;
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

async function waitForSettlement(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    operation.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

function childDetail(outcome: Exclude<VoiceProcessOutcome, { kind: "completed" | "cancelled" }>): string {
  return outcome.detail;
}

export async function runVoice(deps: VoiceDependencies): Promise<VoiceExitCode> {
  const requestValues: string[] = [];
  const childEnv = filteredEnvironment(deps.env);
  const generationTimeoutMs = deps.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS;
  const generationCleanupTimeoutMs = deps.generationCleanupTimeoutMs
    ?? DEFAULT_GENERATION_CLEANUP_TIMEOUT_MS;
  const inventoryTimeoutMs = deps.inventoryTimeoutMs ?? DEFAULT_INVENTORY_TIMEOUT_MS;
  const clipboardTimeoutMs = deps.clipboardTimeoutMs ?? DEFAULT_CLIPBOARD_TIMEOUT_MS;
  const speechTimeoutMs = deps.speechTimeoutMs ?? DEFAULT_SPEECH_TIMEOUT_MS;
  let cancellationReported = false;

  const diagnostic = (category: string, value?: unknown): void => {
    const suffix = value === undefined ? "" : `: ${detail(value)}`;
    deps.diagnostic(redactRequestValues(
      canonicalizeDiagnostic(`${category}${suffix}`),
      requestValues,
    ));
  };
  const cancelled = (): VoiceExitCode => {
    if (!cancellationReported) {
      cancellationReported = true;
      deps.diagnostic("voice request cancelled");
    }
    return 130;
  };
  const runChild = async (
    executable: typeof SAY | typeof PBCOPY,
    args: readonly string[],
    stdin: Uint8Array,
    timeoutMs: number,
  ): Promise<VoiceProcessOutcome> => {
    if (deps.signal.aborted) return { kind: "cancelled" };
    try {
      return await deps.runner.run({
        executable,
        args: [...args],
        stdin,
        env: childEnv,
        signal: deps.signal,
        timeoutMs,
      });
    } catch (error) {
      return deps.signal.aborted
        ? { kind: "cancelled" }
        : { kind: "failed", detail: detail(error) };
    }
  };
  const speakNotice = async (
    notice: string,
    successfulExit: 0 | 1,
  ): Promise<VoiceExitCode> => {
    if (deps.signal.aborted) return cancelled();
    const outcome = await runChild(SAY, [], new TextEncoder().encode(notice), speechTimeoutMs);
    if (deps.signal.aborted || outcome.kind === "cancelled") return cancelled();
    if (outcome.kind === "completed") return successfulExit;
    diagnostic("voice notice speech failed", childDetail(outcome));
    return 1;
  };
  const configFailure = async (
    value: unknown,
    sayAvailable: boolean,
  ): Promise<VoiceExitCode> => {
    if (deps.signal.aborted) return cancelled();
    diagnostic("voice configuration failed", value);
    if (!sayAvailable) return 1;
    return await speakNotice(CONFIG_FAILED_NOTICE, 1);
  };

  if (deps.signal.aborted) return cancelled();

  let transcript = "";
  let invalidTranscript: unknown;
  try {
    transcript = await resolveInputSource(deps.inputFlag, deps.stdin, deps.signal);
    requestValues.push(transcript);
    if (transcript.trim().length === 0) invalidTranscript = "dictated transcript is blank";
  } catch (error) {
    if (deps.signal.aborted) return cancelled();
    if (!(error instanceof InvalidUtf8Error)) throw error;
    invalidTranscript = error;
  }
  if (deps.signal.aborted) return cancelled();

  let sayAvailable = false;
  try {
    sayAvailable = await deps.runner.isExecutable(SAY);
  } catch (error) {
    return await configFailure(error, false);
  }
  if (deps.signal.aborted) return cancelled();
  if (!sayAvailable) return await configFailure("required executable is unavailable: /usr/bin/say", false);

  let copyAvailable = false;
  try {
    copyAvailable = await deps.runner.isExecutable(PBCOPY);
  } catch (error) {
    return await configFailure(error, true);
  }
  if (deps.signal.aborted) return cancelled();
  if (!copyAvailable) {
    return await configFailure("required executable is unavailable: /usr/bin/pbcopy", true);
  }

  if (invalidTranscript !== undefined) {
    diagnostic("voice input rejected", invalidTranscript);
    return await speakNotice(RETRY_NOTICE, 0);
  }

  let aliases: Readonly<Record<string, AliasRecord>>;
  let config: VoiceConfig;
  if (deps.snapshot !== undefined) {
    aliases = deps.snapshot.aliases;
    config = deps.snapshot.voice;
  } else {
    let configText: string | null;
    try {
      const path = resolveVoiceConfigPath(deps.home, deps.env.XDG_CONFIG_HOME);
      const configBytes = await (deps.readConfig ?? readVoiceConfig)(path);
      configText = configBytes === null ? null : strictUtf8(configBytes);
    } catch (error) {
      return await configFailure(error, true);
    }
    if (deps.signal.aborted) return cancelled();

    let document: AliasDocument;
    try {
      document = await deps.loadAliases(deps.aliasPath);
    } catch (error) {
      return await configFailure(error, true);
    }
    if (deps.signal.aborted) return cancelled();
    aliases = document.aliases;
    try {
      config = parseVoiceConfig(configText, Object.keys(aliases));
    } catch (error) {
      return await configFailure(error, true);
    }
  }

  const aliasNames = Object.keys(aliases);
  if (aliasNames.length === 0) {
    diagnostic("voice alias store is empty");
    return await speakNotice(CREATE_ALIAS_NOTICE, 1);
  }

  if (deps.signal.aborted) return cancelled();

  const route = routeTranscript(transcript, aliasNames, config);
  if (!route.accepted) {
    diagnostic("voice request rejected", route.reason);
    return await speakNotice(RETRY_NOTICE, 0);
  }
  const selection = aliases[route.alias];
  if (selection === undefined) {
    return await configFailure("selected alias is missing from the loaded snapshot", true);
  }
  const profile = config.profiles[route.alias];
  requestValues.push(route.question);

  let installedVoice: string | undefined;
  if (profile?.voice !== undefined) {
    const inventory = await runChild(
      SAY,
      ["-v", "?"],
      new Uint8Array(),
      inventoryTimeoutMs,
    );
    if (deps.signal.aborted || inventory.kind === "cancelled") return cancelled();
    if (inventory.kind !== "completed") {
      return await configFailure(`voice inventory ${inventory.kind}: ${childDetail(inventory)}`, true);
    }
    try {
      installedVoice = parseVoiceInventory(strictUtf8(inventory.stdout)).get(caseFold(profile.voice));
    } catch (error) {
      return await configFailure(error, true);
    }
    if (installedVoice === undefined) {
      return await configFailure("configured voice is not installed", true);
    }
  }

  const prompt = `${VOICE_PROMPT}\n\n${route.question}`;
  requestValues.push(prompt);
  const generationController = new AbortController();
  type GenerationOutcome =
    | Readonly<{ kind: "completed"; answer: string }>
    | Readonly<{ kind: "failed"; error: unknown }>
    | Readonly<{ kind: "timed_out" }>
    | Readonly<{ kind: "cancelled" }>;
  let interruptGeneration: (outcome: GenerationOutcome) => void = () => undefined;
  const interruptedGeneration = new Promise<GenerationOutcome>((resolve) => {
    interruptGeneration = resolve;
  });
  const abortGeneration = () => {
    generationController.abort(deps.signal.reason);
    interruptGeneration({ kind: "cancelled" });
  };
  deps.signal.addEventListener("abort", abortGeneration, { once: true });
  const generationTimer = setTimeout(() => {
    generationController.abort(new Error("generation timed out"));
    interruptGeneration({ kind: "timed_out" });
  }, generationTimeoutMs);
  const generation = Promise.resolve().then(() => deps.runtime.generate(
    selection.provider,
    selection.model,
    prompt,
    generationController.signal,
    selection.instructions,
  )).then<GenerationOutcome, GenerationOutcome>(
    (answer) => ({ kind: "completed", answer }),
    (error) => ({ kind: "failed", error }),
  );
  if (deps.signal.aborted) abortGeneration();
  const generationOutcome = await Promise.race([generation, interruptedGeneration]);
  clearTimeout(generationTimer);
  deps.signal.removeEventListener("abort", abortGeneration);

  if (generationOutcome.kind === "cancelled" || generationOutcome.kind === "timed_out") {
    if (selection.provider === "codex-cli" || selection.provider === "claude-cli") {
      await generation;
    } else {
      await waitForSettlement(generation, generationCleanupTimeoutMs);
    }
    if (deps.signal.aborted || generationOutcome.kind === "cancelled") return cancelled();
    diagnostic("voice generation timed out");
    return await speakNotice(REQUEST_FAILED_NOTICE, 0);
  }
  if (generationOutcome.kind === "failed") {
    if (deps.signal.aborted) return cancelled();
    diagnostic("voice generation failed", generationOutcome.error);
    return await speakNotice(REQUEST_FAILED_NOTICE, 0);
  }
  if (deps.signal.aborted) return cancelled();
  const answer = generationOutcome.answer;
  requestValues.push(answer);
  const validation = validateSpeechAnswer(answer);
  if (!validation.valid) {
    diagnostic(`voice generation returned ${validation.reason} text`);
    return await speakNotice(REQUEST_FAILED_NOTICE, 0);
  }
  const terminalAnswer = stripTerminalSequences(answer);
  if (
    deps.sensitive.redact(answer) !== answer
    || deps.sensitive.redact(terminalAnswer) !== terminalAnswer
  ) {
    diagnostic("voice generation returned credential-bearing text");
    return await speakNotice(REQUEST_FAILED_NOTICE, 0);
  }

  const answerBytes = new TextEncoder().encode(answer);
  const copy = await runChild(PBCOPY, [], answerBytes, clipboardTimeoutMs);
  if (deps.signal.aborted || copy.kind === "cancelled") return cancelled();
  if (copy.kind !== "completed") {
    diagnostic(`voice clipboard ${copy.kind}`, childDetail(copy));
    return await speakNotice(COPY_FAILED_NOTICE, 1);
  }

  const speechPrefix = profile?.pitch === undefined
    ? ""
    : formatTrustedPitchCommand(profile.pitch);
  const speech = `${speechPrefix}${answer}`;
  requestValues.push(speech);
  const speechArgs: string[] = [];
  if (installedVoice !== undefined) speechArgs.push("-v", installedVoice);
  if (profile?.rate !== undefined) speechArgs.push("-r", String(profile.rate));
  const spoken = await runChild(SAY, speechArgs, new TextEncoder().encode(speech), speechTimeoutMs);
  if (deps.signal.aborted || spoken.kind === "cancelled") return cancelled();
  if (spoken.kind !== "completed") {
    diagnostic(`voice answer speech ${spoken.kind}`, childDetail(spoken));
    return 1;
  }
  return 0;
}

import { describe, expect, test } from "bun:test";
import { BYOK_API_KEY_ENV_VARS, type ByokEnvironment } from "@swartzrock/byok-runtime";
import type { AliasDocument } from "../src/aliases.ts";
import type { ConfigSnapshot } from "../src/config.ts";
import { createSensitiveValueRegistry } from "../src/credentials.ts";
import {
  REQUEST_FAILED_NOTICE,
  RETRY_NOTICE,
  createBunVoiceProcessRunner,
  installVoiceCancellation,
  prepareVoiceSpeech,
  routeVoiceTranscript,
  speakVoiceAnswer,
  speakVoiceNotice,
  type VoiceProcessOutcome,
  type VoiceProcessRequest,
  type VoiceProcessRunner,
  type VoiceSpeechDependencies,
} from "../src/voice.ts";
import { parseVoiceConfig } from "../src/voice-routing.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function completed(stdout = "", stderr = ""): VoiceProcessOutcome {
  return {
    kind: "completed",
    stdout: encoder.encode(stdout),
    stderr: encoder.encode(stderr),
  };
}

class FakeRunner implements VoiceProcessRunner {
  readonly accesses: string[] = [];
  readonly requests: VoiceProcessRequest[] = [];
  available = new Set(["/usr/bin/say"]);
  outcomes: VoiceProcessOutcome[] = [];
  onAccess?: (path: string) => void;
  onRun?: (request: VoiceProcessRequest, index: number) => void;

  async isExecutable(path: string): Promise<boolean> {
    this.accesses.push(path);
    this.onAccess?.(path);
    return this.available.has(path);
  }

  async run(request: VoiceProcessRequest): Promise<VoiceProcessOutcome> {
    this.requests.push(request);
    this.onRun?.(request, this.requests.length - 1);
    return this.outcomes.shift() ?? completed();
  }
}

describe("composable voice operations", () => {
  function routeSnapshot(
    aliases: AliasDocument["aliases"],
    config: string | null = null,
  ): ConfigSnapshot {
    return Object.freeze({
      authority: "legacy" as const,
      document: null,
      aliases: Object.freeze({ ...aliases }),
      voice: parseVoiceConfig(config, Object.keys(aliases)),
    });
  }

  function speechDependencies(
    runner: FakeRunner,
    options: {
      signal?: AbortSignal;
      env?: ByokEnvironment;
      sensitiveValues?: readonly string[];
      requestValues?: readonly string[];
      diagnostics?: string[];
    } = {},
  ): VoiceSpeechDependencies {
    const diagnostics = options.diagnostics ?? [];
    return {
      runner,
      signal: options.signal ?? new AbortController().signal,
      env: options.env ?? {},
      sensitive: createSensitiveValueRegistry(options.sensitiveValues),
      requestValues: options.requestValues,
      diagnostic: (message) => diagnostics.push(message),
    };
  }

  test("routes exact, configured, fuzzy, and rejected transcripts without side effects", () => {
    const snapshot = routeSnapshot({
      terra: { provider: "openai", model: "gpt-test" },
    }, "[terra]\nspoken_names = ['tara']\nvoice = 'Samantha'\n");

    expect(routeVoiceTranscript("terra exact question", snapshot)).toMatchObject({
      kind: "routed",
      alias: "terra",
      aliasRecord: { provider: "openai", model: "gpt-test" },
      question: "exact question",
      profile: { spokenNames: ["tara"], voice: "Samantha" },
    });
    expect(routeVoiceTranscript("tara configured question", snapshot)).toMatchObject({
      kind: "routed",
      alias: "terra",
      question: "configured question",
    });
    expect(routeVoiceTranscript("tera fuzzy question", snapshot)).toMatchObject({
      kind: "routed",
      alias: "terra",
      question: "fuzzy question",
    });
    for (const [transcript, reason] of [
      ["unknown question", "no_match"],
      ["terra", "missing_question"],
      ["", "missing_request"],
    ] as const) {
      const outcome = routeVoiceTranscript(transcript, snapshot);
      expect(outcome).toEqual({ kind: "rejected", reason });
      expect(JSON.stringify(outcome)).not.toContain(transcript || "unknown question");
    }

    expect(routeVoiceTranscript("anything", routeSnapshot({}))).toEqual({
      kind: "rejected",
      reason: "empty_aliases",
    });
    const ambiguous = routeSnapshot({
      abcdefghijklmnopuuuu: { provider: "openai", model: "one" },
      abcdefghijklmnvvvvvv: { provider: "openai", model: "two" },
    });
    expect(routeVoiceTranscript("abcdefghijklmnopqrst question", ambiguous)).toEqual({
      kind: "rejected",
      reason: "ambiguous",
    });
  });

  test("preflights system and configured speech into trusted process arguments", async () => {
    const systemRunner = new FakeRunner();
    const system = await prepareVoiceSpeech(speechDependencies(systemRunner));
    expect(system.kind).toBe("ready");
    if (system.kind !== "ready") throw new Error("system speech was not ready");
    expect(system.speech.args).toEqual([]);
    expect(system.speech.pitchPrefix).toBe("");
    expect(systemRunner.requests).toEqual([]);

    const secrets = Object.fromEntries(
      BYOK_API_KEY_ENV_VARS.map((name) => [name, `${name}-secret`]),
    );
    const profileRunner = new FakeRunner();
    profileRunner.outcomes = [completed("Samantha en_US    # Hello\n")];
    const configured = await prepareVoiceSpeech(
      speechDependencies(profileRunner, {
        env: { ...secrets, PATH: "/trusted/path", ORDINARY: "kept" },
      }),
      { spokenNames: [], voice: "samantha", rate: 205, pitch: 50 },
    );
    expect(configured.kind).toBe("ready");
    if (configured.kind !== "ready") throw new Error("configured speech was not ready");
    expect(configured.speech.args).toEqual(["-v", "Samantha", "-r", "205"]);
    expect(configured.speech.pitchPrefix).toBe("[[pbas 50]]");
    expect(profileRunner.requests[0]?.args).toEqual(["-v", "?"]);
    expect(profileRunner.requests[0]?.env.PATH).toBe("/trusted/path");
    expect(profileRunner.requests[0]?.env.ORDINARY).toBe("kept");
    for (const name of BYOK_API_KEY_ENV_VARS) {
      expect(profileRunner.requests[0]?.env[name]).toBeUndefined();
    }
  });

  test("returns value-free preflight failures and a safe notice handle when possible", async () => {
    const missingSay = new FakeRunner();
    missingSay.available.clear();
    expect(await prepareVoiceSpeech(speechDependencies(missingSay))).toEqual({
      kind: "configuration_failed",
      reason: "executable_unavailable",
    });

    const diagnostics: string[] = [];
    const unavailableVoice = new FakeRunner();
    unavailableVoice.outcomes = [completed("Alex en_US    # Hello\n")];
    const failed = await prepareVoiceSpeech(
      speechDependencies(unavailableVoice, {
        diagnostics,
        requestValues: ["raw-request-sentinel"],
      }),
      { spokenNames: [], voice: "raw-request-sentinel" },
    );
    expect(failed.kind).toBe("configuration_failed");
    if (failed.kind !== "configuration_failed") throw new Error("expected preflight failure");
    expect(failed.reason).toBe("voice_unavailable");
    expect(failed.noticeSpeech).toBeDefined();
    expect(JSON.stringify(failed)).not.toContain("raw-request-sentinel");
    expect(diagnostics.join("\n")).not.toContain("raw-request-sentinel");
  });

  test("validates credentials and speech controls before speaking an answer", async () => {
    const diagnostics: string[] = [];
    const runner = new FakeRunner();
    const prepared = await prepareVoiceSpeech(
      speechDependencies(runner, {
        diagnostics,
        sensitiveValues: ["registered-secret"],
        requestValues: ["raw-question"],
      }),
      { spokenNames: [], rate: 210, pitch: 55 },
    );
    if (prepared.kind !== "ready") throw new Error("speech was not ready");

    expect(await speakVoiceAnswer(prepared.speech, "safe answer")).toEqual({
      kind: "completed",
    });
    expect(runner.requests.at(-1)?.args).toEqual(["-r", "210"]);
    expect(decoder.decode(runner.requests.at(-1)?.stdin)).toBe("[[pbas 55]]safe answer");

    for (const [answer, reason] of [
      ["", "blank"],
      ["unsafe [[slnc 100]]", "unsafe"],
      ["unsafe\x1b[31m", "unsafe"],
      ["unsafe\x00text", "unsafe"],
      ["registered-secret", "credential"],
    ] as const) {
      const before = runner.requests.length;
      expect(await speakVoiceAnswer(prepared.speech, answer)).toEqual({
        kind: "rejected",
        reason,
      });
      expect(runner.requests).toHaveLength(before);
    }
    expect(diagnostics.join("\n")).not.toContain("raw-question");
    expect(runner.requests.every((request) => request.executable === "/usr/bin/say")).toBeTrue();
    expect(runner.requests.some((request) => request.executable.includes("pbcopy"))).toBeFalse();
  });

  test("speaks only stable notices and preserves process failures and cancellation", async () => {
    const failedRunner = new FakeRunner();
    failedRunner.outcomes = [{ kind: "timed_out", detail: "notice deadline" }];
    const failedPrepared = await prepareVoiceSpeech(speechDependencies(failedRunner));
    if (failedPrepared.kind !== "ready") throw new Error("speech was not ready");
    expect(await speakVoiceNotice(failedPrepared.speech, REQUEST_FAILED_NOTICE)).toEqual({
      kind: "failed",
      reason: "timed_out",
    });

    const root = new AbortController();
    const cancelledRunner = new FakeRunner();
    const cancelledPrepared = await prepareVoiceSpeech(
      speechDependencies(cancelledRunner, { signal: root.signal }),
    );
    if (cancelledPrepared.kind !== "ready") throw new Error("speech was not ready");
    root.abort();
    expect(await speakVoiceNotice(cancelledPrepared.speech, RETRY_NOTICE)).toEqual({
      kind: "cancelled",
    });
    expect(cancelledRunner.requests).toEqual([]);
  });
});

describe("voice process and signal adapters", () => {
  test("installs one root controller for SIGINT/SIGTERM and disposes idempotently", () => {
    const listeners = new Map<string, Set<() => void>>();
    const target = {
      on(event: "SIGINT" | "SIGTERM", listener: () => void) {
        const current = listeners.get(event) ?? new Set();
        current.add(listener);
        listeners.set(event, current);
      },
      off(event: "SIGINT" | "SIGTERM", listener: () => void) {
        listeners.get(event)?.delete(listener);
      },
    };

    const cancellation = installVoiceCancellation(target);
    expect(listeners.get("SIGINT")?.size).toBe(1);
    expect(listeners.get("SIGTERM")?.size).toBe(1);
    listeners.get("SIGTERM")?.values().next().value?.();
    expect(cancellation.signal.aborted).toBeTrue();
    cancellation.dispose();
    cancellation.dispose();
    expect(listeners.get("SIGINT")?.size).toBe(0);
    expect(listeners.get("SIGTERM")?.size).toBe(0);
  });

  test("Bun adapter rejects a pre-aborted run before spawning", async () => {
    let spawned = false;
    const runner = createBunVoiceProcessRunner({
      access: async () => undefined,
      spawn: () => {
        spawned = true;
        throw new Error("must not spawn");
      },
    });
    const root = new AbortController();
    root.abort();

    expect(await runner.run({
      executable: "/usr/bin/say",
      args: [],
      stdin: new Uint8Array(),
      env: {},
      signal: root.signal,
      timeoutMs: 10,
    })).toEqual({ kind: "cancelled" });
    expect(spawned).toBeFalse();
  });

  test("Bun adapter terminates, force-kills, and reaps a timed-out child", async () => {
    let resolveExit: (code: number) => void = () => undefined;
    const state: { exitCode: number | null } = { exitCode: null };
    const signals: NodeJS.Signals[] = [];
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const emptyStream = () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const runner = createBunVoiceProcessRunner({
      access: async () => undefined,
      forceKillDelayMs: 1,
      spawn: () => ({
        stdin: { write: () => undefined, end: () => undefined },
        stdout: emptyStream(),
        stderr: emptyStream(),
        exited,
        get exitCode() {
          return state.exitCode;
        },
        kill(signal) {
          signals.push(signal);
          if (signal === "SIGKILL") {
            state.exitCode = 137;
            resolveExit(137);
          }
        },
      }),
    });

    expect(await runner.run({
      executable: "/usr/bin/say",
      args: [],
      stdin: encoder.encode("answer"),
      env: {},
      signal: new AbortController().signal,
      timeoutMs: 1,
    })).toEqual({ kind: "timed_out", detail: "timed out after 1ms" });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(state.exitCode).toBe(137);
  });

  test("Bun adapter terminates, force-kills, and reaps a cancelled child", async () => {
    const root = new AbortController();
    let resolveExit: (code: number) => void = () => undefined;
    const state: { exitCode: number | null } = { exitCode: null };
    const signals: NodeJS.Signals[] = [];
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const emptyStream = () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const runner = createBunVoiceProcessRunner({
      forceKillDelayMs: 1,
      spawn: () => {
        queueMicrotask(() => root.abort());
        return {
          stdin: { write: () => undefined, end: () => undefined },
          stdout: emptyStream(),
          stderr: emptyStream(),
          exited,
          get exitCode() {
            return state.exitCode;
          },
          kill(signal) {
            signals.push(signal);
            if (signal === "SIGKILL") {
              state.exitCode = 137;
              resolveExit(137);
            }
          },
        };
      },
    });

    expect(await runner.run({
      executable: "/usr/bin/say",
      args: [],
      stdin: encoder.encode("notice"),
      env: {},
      signal: root.signal,
      timeoutMs: 1_000,
    })).toEqual({ kind: "cancelled" });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(state.exitCode).toBe(137);
  });
});

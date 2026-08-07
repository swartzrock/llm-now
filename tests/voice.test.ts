import { describe, expect, test } from "bun:test";
import { BYOK_API_KEY_ENV_VARS, type ByokEnvironment } from "@swartzrock/byok-runtime";
import type { AliasDocument } from "../src/aliases.ts";
import { createSensitiveValueRegistry } from "../src/credentials.ts";
import type { PromptInput } from "../src/io.ts";
import type { RuntimeGateway } from "../src/runtime.ts";
import {
  CONFIG_FAILED_NOTICE,
  COPY_FAILED_NOTICE,
  CREATE_ALIAS_NOTICE,
  REQUEST_FAILED_NOTICE,
  RETRY_NOTICE,
  createBunVoiceProcessRunner,
  installVoiceCancellation,
  runVoice,
  type VoiceProcessOutcome,
  type VoiceProcessRequest,
  type VoiceProcessRunner,
} from "../src/voice.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function input(value: string | Uint8Array, isTTY = false): PromptInput {
  return {
    isTTY,
    async *[Symbol.asyncIterator]() {
      yield typeof value === "string" ? encoder.encode(value) : value;
    },
  };
}

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
  available = new Set(["/usr/bin/say", "/usr/bin/pbcopy"]);
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

interface HarnessOptions {
  transcript?: string | Uint8Array;
  stdin?: PromptInput;
  inputFlag?: string;
  aliases?: AliasDocument;
  config?: string | Uint8Array | null;
  answer?: string;
  env?: ByokEnvironment;
  runner?: FakeRunner;
  signal?: AbortSignal;
  generate?: RuntimeGateway["generate"];
  generationTimeoutMs?: number;
  generationCleanupTimeoutMs?: number;
  sensitiveValues?: readonly string[];
  onReadConfig?: () => void;
  onLoadAliases?: () => void;
}

function harness(options: HarnessOptions = {}) {
  const runner = options.runner ?? new FakeRunner();
  const operations: string[] = [];
  const diagnostics: string[] = [];
  let aliasLoads = 0;
  let configReads = 0;
  const runtimeCalls: Parameters<RuntimeGateway["generate"]>[] = [];
  const aliases = options.aliases ?? {
    version: 2,
    aliases: {
      haiku: {
        provider: "ollama",
        model: "qwen",
        instructions: "Keep the saved instructions unchanged.\nEven here.",
      },
      terra: { provider: "openai", model: "gpt-test" },
    },
  };
  const runtime: RuntimeGateway = {
    discover: async () => [],
    listModels: async () => [],
    validateCredential: async () => [],
    generate: async (...args) => {
      operations.push("generate");
      runtimeCalls.push(args);
      if (options.generate) return options.generate(...args);
      return options.answer ?? "-v --flag '$HOME'\nsecond line";
    },
  };
  const originalRun = runner.run.bind(runner);
  runner.run = async (request) => {
    operations.push(`${request.executable}${request.args.length ? ` ${request.args.join(" ")}` : ""}`);
    return originalRun(request);
  };

  return {
    runner,
    operations,
    diagnostics,
    runtimeCalls,
    aliasLoads: () => aliasLoads,
    configReads: () => configReads,
    run: () => runVoice({
      inputFlag: options.inputFlag,
      stdin: options.stdin
        ?? input(options.transcript ?? "Hey haiku, write about brisket", options.inputFlag !== undefined),
      runtime,
      sensitive: createSensitiveValueRegistry(options.sensitiveValues),
      env: options.env ?? {},
      home: "/Users/test",
      aliasPath: "/config/aliases.json",
      loadAliases: async () => {
        operations.push("load aliases");
        aliasLoads += 1;
        options.onLoadAliases?.();
        return aliases;
      },
      readConfig: async (path) => {
        operations.push(`read config ${path}`);
        configReads += 1;
        options.onReadConfig?.();
        if (options.config === null || options.config === undefined) return null;
        return typeof options.config === "string" ? encoder.encode(options.config) : options.config;
      },
      runner,
      signal: options.signal ?? new AbortController().signal,
      diagnostic: (detail) => diagnostics.push(detail),
      generationTimeoutMs: options.generationTimeoutMs,
      generationCleanupTimeoutMs: options.generationCleanupTimeoutMs,
    }),
  };
}

describe("native voice coordinator", () => {
  test("loads one snapshot, generates once, copies exact answer, then speaks configured bytes", async () => {
    const secrets = Object.fromEntries(
      BYOK_API_KEY_ENV_VARS.map((name) => [name, `${name}-secret`]),
    );
    const runner = new FakeRunner();
    runner.outcomes = [
      completed("Samantha en_US    # Hello\n"),
      completed(),
      completed(),
    ];
    const app = harness({
      transcript: "Tara, keep punctuation?!",
      config: "[terra]\nmatch_phrases = ['tara']\nvoice = 'samantha'\nrate = 205\npitch = 50\n",
      answer: "-v --flag '$HOME'\nsecond line",
      env: { ...secrets, PATH: "/trusted/path", ORDINARY: "kept" },
      runner,
    });

    expect(await app.run()).toBe(0);
    expect(app.aliasLoads()).toBe(1);
    expect(app.configReads()).toBe(1);
    expect(app.runtimeCalls).toHaveLength(1);
    expect(app.runtimeCalls[0]?.slice(0, 3)).toEqual([
      "openai",
      "gpt-test",
      "Answer concisely in plain text suitable for speech. Do not use Markdown or code fences unless the question requires code.\n\nkeep punctuation?!",
    ]);
    expect(app.runtimeCalls[0]?.[3]).toBeInstanceOf(AbortSignal);
    expect(app.runtimeCalls[0]?.[4]).toBeUndefined();
    expect(app.operations).toEqual([
      "read config /Users/test/.config/llm-now/voice-router.toml",
      "load aliases",
      "/usr/bin/say -v ?",
      "generate",
      "/usr/bin/pbcopy",
      "/usr/bin/say -v Samantha -r 205",
    ]);
    expect(runner.accesses).toEqual(["/usr/bin/say", "/usr/bin/pbcopy"]);
    expect(runner.requests.map((request) => [
      request.executable,
      request.args,
      decoder.decode(request.stdin),
      request.timeoutMs,
    ])).toEqual([
      ["/usr/bin/say", ["-v", "?"], "", 5_000],
      ["/usr/bin/pbcopy", [], "-v --flag '$HOME'\nsecond line", 5_000],
      ["/usr/bin/say", ["-v", "Samantha", "-r", "205"], "[[pbas 50]]-v --flag '$HOME'\nsecond line", 120_000],
    ]);
    for (const request of runner.requests) {
      expect(request.env.PATH).toBe("/trusted/path");
      expect(request.env.ORDINARY).toBe("kept");
      for (const name of BYOK_API_KEY_ENV_VARS) expect(request.env[name]).toBeUndefined();
    }
    expect(app.diagnostics).toEqual([]);
  });

  test("forwards the selected snapshot record's saved instructions unchanged", async () => {
    const app = harness();

    expect(await app.run()).toBe(0);
    expect(app.runtimeCalls[0]?.[4]).toBe("Keep the saved instructions unchanged.\nEven here.");
    expect(app.aliasLoads()).toBe(1);
  });

  test("maps rejected and invalid UTF-8 transcripts to the unconfigured retry notice", async () => {
    for (const transcript of ["unknown question", Uint8Array.of(0xff)]) {
      const app = harness({ transcript });
      expect(await app.run()).toBe(0);
      expect(app.runtimeCalls).toHaveLength(0);
      expect(app.runner.requests).toHaveLength(1);
      expect(app.runner.requests[0]?.args).toEqual([]);
      expect(decoder.decode(app.runner.requests[0]?.stdin)).toBe(RETRY_NOTICE);
    }
  });

  test("returns exit 1 when a handled retry or request notice cannot be spoken", async () => {
    const retryRunner = new FakeRunner();
    retryRunner.outcomes = [{ kind: "failed", detail: "notice failed" }];
    expect(await harness({ transcript: "unknown question", runner: retryRunner }).run()).toBe(1);

    const requestRunner = new FakeRunner();
    requestRunner.outcomes = [{ kind: "failed", detail: "notice failed" }];
    expect(await harness({ answer: "", runner: requestRunner }).run()).toBe(1);
  });

  test("uses a dedicated setup notice and exit 1 for a valid empty alias roster", async () => {
    const app = harness({ aliases: { version: 1, aliases: {} } });

    expect(await app.run()).toBe(1);
    expect(decoder.decode(app.runner.requests.at(-1)?.stdin)).toBe(CREATE_ALIAS_NOTICE);
    expect(app.runtimeCalls).toHaveLength(0);
  });

  test("maps config, generation, clipboard, and answer-speech failures to stable outcomes", async () => {
    for (const config of ["[haiku]\npitch = 500\n", Uint8Array.of(0xff)]) {
      const malformed = harness({ config });
      expect(await malformed.run()).toBe(1);
      expect(decoder.decode(malformed.runner.requests.at(-1)?.stdin)).toBe(CONFIG_FAILED_NOTICE);
    }

    for (const answer of ["", "unsafe [[slnc 100]]", "unsafe\x1b[31m", "unsafe\x00text"]) {
      const app = harness({ answer });
      expect(await app.run()).toBe(0);
      expect(decoder.decode(app.runner.requests.at(-1)?.stdin)).toBe(REQUEST_FAILED_NOTICE);
      expect(app.runner.requests.some((request) => request.executable === "/usr/bin/pbcopy"))
        .toBeFalse();
    }

    const generation = harness({
      generate: async () => {
        throw new Error("provider failed");
      },
    });
    expect(await generation.run()).toBe(0);
    expect(decoder.decode(generation.runner.requests.at(-1)?.stdin)).toBe(REQUEST_FAILED_NOTICE);

    const copyRunner = new FakeRunner();
    copyRunner.outcomes = [{ kind: "failed", detail: "copy failed" }, completed()];
    const copy = harness({ runner: copyRunner });
    expect(await copy.run()).toBe(1);
    expect(copy.runner.requests.map((request) => request.executable)).toEqual([
      "/usr/bin/pbcopy",
      "/usr/bin/say",
    ]);
    expect(decoder.decode(copy.runner.requests.at(-1)?.stdin)).toBe(COPY_FAILED_NOTICE);

    const speechRunner = new FakeRunner();
    speechRunner.outcomes = [completed(), { kind: "failed", detail: "speech failed" }];
    const speech = harness({ runner: speechRunner });
    expect(await speech.run()).toBe(1);
    expect(speech.runner.requests).toHaveLength(2);
    expect(decoder.decode(speech.runner.requests[0]?.stdin)).toBe("-v --flag '$HOME'\nsecond line");
  });

  test("uses configuration notice for unavailable tools and selected voices", async () => {
    const missingSay = new FakeRunner();
    missingSay.available.delete("/usr/bin/say");
    const unavailableSay = harness({ runner: missingSay });
    expect(await unavailableSay.run()).toBe(1);
    expect(missingSay.requests).toEqual([]);

    const missingCopy = new FakeRunner();
    missingCopy.available.delete("/usr/bin/pbcopy");
    const unavailableCopy = harness({ runner: missingCopy });
    expect(await unavailableCopy.run()).toBe(1);
    expect(decoder.decode(missingCopy.requests.at(-1)?.stdin)).toBe(CONFIG_FAILED_NOTICE);

    const voices = new FakeRunner();
    voices.outcomes = [completed("Alex en_US    # Hello\n"), completed()];
    const unavailableVoice = harness({
      runner: voices,
      config: "[haiku]\nvoice = 'Samantha'\n",
    });
    expect(await unavailableVoice.run()).toBe(1);
    expect(unavailableVoice.runtimeCalls).toHaveLength(0);
    expect(decoder.decode(voices.requests.at(-1)?.stdin)).toBe(CONFIG_FAILED_NOTICE);

    const inventoryTimeout = new FakeRunner();
    inventoryTimeout.outcomes = [
      { kind: "timed_out", detail: "inventory deadline" },
      completed(),
    ];
    const timedOutVoice = harness({
      runner: inventoryTimeout,
      config: "[haiku]\nvoice = 'Samantha'\n",
    });
    expect(await timedOutVoice.run()).toBe(1);
    expect(timedOutVoice.runtimeCalls).toHaveLength(0);
    expect(decoder.decode(inventoryTimeout.requests.at(-1)?.stdin)).toBe(CONFIG_FAILED_NOTICE);

    const relativeConfig = harness({ env: { XDG_CONFIG_HOME: "relative" } });
    expect(await relativeConfig.run()).toBe(1);
    expect(decoder.decode(relativeConfig.runner.requests.at(-1)?.stdin)).toBe(CONFIG_FAILED_NOTICE);
  });

  test("keeps request payload sentinels and child credentials out of diagnostics and notices", async () => {
    const transcript = "haiku raw-transcript-sentinel";
    const prompt = "Answer concisely in plain text suitable for speech. Do not use Markdown or code fences unless the question requires code.\n\nraw-transcript-sentinel";
    const answer = "raw-answer-sentinel";
    const speech = `[[pbas 50]]${answer}`;
    const detail = [
      transcript,
      JSON.stringify(transcript),
      prompt,
      JSON.stringify(prompt),
      answer,
      JSON.stringify(answer),
      speech,
      JSON.stringify(speech),
      "api-secret",
      "\u001b[31mcontrol\u0000",
    ].join(" | ");
    const runner = new FakeRunner();
    runner.outcomes = [completed(), { kind: "failed", detail }];
    const app = harness({
      transcript,
      answer,
      config: "[haiku]\npitch = 50\n",
      env: { OPENAI_API_KEY: "api-secret" },
      runner,
    });

    expect(await app.run()).toBe(1);
    const diagnostics = app.diagnostics.join("\n");
    for (const sentinel of [transcript, prompt, answer, speech]) {
      expect(diagnostics).not.toContain(sentinel);
      expect(diagnostics).not.toContain(JSON.stringify(sentinel));
    }
    expect(decoder.decode(runner.requests.at(-1)?.stdin)).toBe(speech);
  });

  test("canonicalizes diagnostics before redacting the derived question", async () => {
    const question = "write about brisket";
    const app = harness({
      generate: async () => {
        throw new Error([
          "write\u001b[31m about brisket",
          "write\u0000 about brisket",
          question,
        ].join(" | "));
      },
    });

    expect(await app.run()).toBe(0);
    expect(app.diagnostics).toHaveLength(1);
    expect(app.diagnostics[0]).toContain("[REDACTED]");
    expect(app.diagnostics[0]).not.toContain(question);
    expect(decoder.decode(app.runner.requests.at(-1)?.stdin)).toBe(REQUEST_FAILED_NOTICE);
  });

  test("withholds registered credentials before clipboard and answer speech", async () => {
    const app = harness({
      answer: "Never expose registered-secret in an answer.",
      sensitiveValues: ["registered-secret"],
    });

    expect(await app.run()).toBe(0);
    expect(app.diagnostics).toEqual(["voice generation returned credential-bearing text"]);
    expect(app.runner.requests.map((request) => request.executable)).toEqual(["/usr/bin/say"]);
    expect(decoder.decode(app.runner.requests[0]?.stdin)).toBe(REQUEST_FAILED_NOTICE);
  });

  test("cancels a stalled stdin iterator and requests cleanup", async () => {
    const root = new AbortController();
    let returned = false;
    const stdin: PromptInput = {
      isTTY: false,
      [Symbol.asyncIterator]() {
        return {
          next() {
            root.abort();
            return new Promise<IteratorResult<string | Uint8Array>>(() => undefined);
          },
          async return() {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const app = harness({ signal: root.signal, stdin });

    expect(await app.run()).toBe(130);
    expect(returned).toBeTrue();
    expect(app.runner.accesses).toEqual([]);
    expect(app.diagnostics).toEqual(["voice request cancelled"]);
  });

  test("external cancellation wins before work and during generation or child stages", async () => {
    const before = new AbortController();
    before.abort();
    const precancelled = harness({ signal: before.signal });
    expect(await precancelled.run()).toBe(130);
    expect(precancelled.runner.accesses).toEqual([]);
    expect(precancelled.runner.requests).toEqual([]);
    expect(precancelled.diagnostics).toEqual(["voice request cancelled"]);

    const generation = new AbortController();
    const duringGeneration = harness({
      signal: generation.signal,
      generate: async (_provider, _model, _prompt, signal) => {
        generation.abort();
        throw signal?.reason ?? new Error("aborted");
      },
    });
    expect(await duringGeneration.run()).toBe(130);
    expect(duringGeneration.runner.requests).toEqual([]);
    expect(duringGeneration.diagnostics).toEqual(["voice request cancelled"]);

    for (const cancelledExecutable of ["/usr/bin/pbcopy", "/usr/bin/say"] as const) {
      const root = new AbortController();
      const runner = new FakeRunner();
      runner.onRun = (request) => {
        if (request.executable === cancelledExecutable) root.abort();
      };
      runner.outcomes = cancelledExecutable === "/usr/bin/pbcopy"
        ? [{ kind: "cancelled" }]
        : [completed(), { kind: "cancelled" }];
      const app = harness({ runner, signal: root.signal });
      expect(await app.run()).toBe(130);
      expect(app.diagnostics).toEqual(["voice request cancelled"]);
      expect(runner.requests.at(-1)?.executable).toBe(cancelledExecutable);
    }
  });

  test("external cancellation during setup and voice inventory suppresses every notice", async () => {
    const setupCases: Array<(root: AbortController, runner: FakeRunner) => HarnessOptions> = [
      (root, runner) => {
        runner.onAccess = () => root.abort();
        return { runner, signal: root.signal };
      },
      (root, runner) => ({
        runner,
        signal: root.signal,
        onReadConfig: () => root.abort(),
      }),
      (root, runner) => ({
        runner,
        signal: root.signal,
        onLoadAliases: () => root.abort(),
      }),
      (root, runner) => {
        runner.onRun = () => root.abort();
        runner.outcomes = [{ kind: "cancelled" }];
        return {
          runner,
          signal: root.signal,
          config: "[haiku]\nvoice = 'Samantha'\n",
        };
      },
    ];

    for (const configure of setupCases) {
      const root = new AbortController();
      const runner = new FakeRunner();
      const app = harness(configure(root, runner));
      expect(await app.run()).toBe(130);
      expect(app.diagnostics).toEqual(["voice request cancelled"]);
      expect(app.runtimeCalls).toHaveLength(0);
      expect(runner.requests.filter((request) => decoder.decode(request.stdin).includes("attention")))
        .toHaveLength(0);
    }
  });

  test("maps generation and child deadlines without confusing them with cancellation", async () => {
    const generation = harness({
      generationTimeoutMs: 1,
      generate: async (_provider, _model, _prompt, signal) =>
        await new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    });
    expect(await generation.run()).toBe(0);
    expect(decoder.decode(generation.runner.requests.at(-1)?.stdin)).toBe(REQUEST_FAILED_NOTICE);

    const timedOutCopy = new FakeRunner();
    timedOutCopy.outcomes = [{ kind: "timed_out", detail: "clipboard deadline" }, completed()];
    const copy = harness({ runner: timedOutCopy });
    expect(await copy.run()).toBe(1);
    expect(decoder.decode(timedOutCopy.requests.at(-1)?.stdin)).toBe(COPY_FAILED_NOTICE);
  });

  test("enforces the generation deadline when a runtime ignores its signal", async () => {
    const app = harness({
      generationTimeoutMs: 1,
      generationCleanupTimeoutMs: 1,
      generate: async () => await new Promise<string>(() => undefined),
    });

    expect(await app.run()).toBe(0);
    expect(app.diagnostics).toEqual(["voice generation timed out"]);
    expect(app.runner.requests.map((request) => request.executable)).toEqual(["/usr/bin/say"]);
    expect(decoder.decode(app.runner.requests[0]?.stdin)).toBe(REQUEST_FAILED_NOTICE);
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
      executable: "/usr/bin/pbcopy",
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

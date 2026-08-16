import { describe, expect, test } from "bun:test";
import type { ByokProviderRuntime } from "@swartzrock/byok-runtime";
import type { LocalProcess, LocalProcessSpawner } from "@swartzrock/byok-runtime/node";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createLlmNowCoreWithInternals } from "../src/client.ts";

function runtime(overrides: Partial<ByokProviderRuntime> = {}): ByokProviderRuntime {
  return {
    id: "ollama",
    label: "Test",
    requiresNetwork: false,
    requiresDownload: false,
    testConnection: async () => ({ ok: true, message: "ok" }),
    listModels: async () => [],
    generateText: async () => ({ text: "buffered" }),
    ...overrides,
  };
}

function client(provider: ByokProviderRuntime, credential = "resolver-secret") {
  return createLlmNowCoreWithInternals({
    environment: {},
    credentialResolver: { resolve: async () => ({ status: "resolved", credential }) },
  }, {
    findAvailableProviders: async () => [provider.id],
    createProvider: () => provider,
  });
}

describe("core streaming", () => {
  test("uses only the injected resolver and permits prompt text in the response", async () => {
    let resolverCalls = 0;
    const core = createLlmNowCoreWithInternals({
      environment: { OPENAI_API_KEY: "ambient-must-not-win" },
      credentialResolver: { resolve: async () => {
        resolverCalls += 1;
        return { status: "resolved", credential: "resolver-secret" };
      } },
    }, {
      findAvailableProviders: async () => [],
      createProvider: () => runtime({
        streamText: (input) => ({
          delivery: "native",
          textStream: (async function* () { yield input.prompt; })(),
        }),
      }),
    });
    const deltas: string[] = [];
    await expect(core.streamText({
      provider: "openai",
      model: "gpt-test",
      prompt: "repeat this prompt",
    }, (delta) => { deltas.push(delta); })).resolves.toMatchObject({
      delivery: "native",
      text: "repeat this prompt",
    });
    expect(deltas).toEqual(["repeat this prompt"]);
    expect(resolverCalls).toBe(1);
  });

  test("delivers native deltas early with awaited backpressure and final-text parity", async () => {
    const events: string[] = [];
    let finishProvider!: () => void;
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const providerFinished = new Promise<void>((resolve) => { finishProvider = resolve; });
    const firstHandled = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const core = client(runtime({
      generateText: async (input) => ({ text: `${input.instructions}:${input.prompt}` }),
      streamText: (input) => ({
        delivery: "native",
        textStream: {
          async *[Symbol.asyncIterator]() {
            expect(input).toEqual({ prompt: "question", instructions: "brief" });
            events.push("yield:first");
            yield "brief:";
            events.push("yield:second");
            yield "question";
            await providerFinished;
          },
        },
      }),
    }));

    const streaming = core.streamText({
      provider: "ollama",
      model: "qwen",
      prompt: "question",
      instructions: "brief",
    }, async (delta) => {
      events.push(`handle:${delta}`);
      if (delta === "brief:") {
        markFirstStarted();
        await firstHandled;
      }
    });
    await firstStarted;
    expect(events).toEqual(["yield:first", "handle:brief:"]);
    releaseFirst();
    while (events.length < 4) await Promise.resolve();
    expect(events).toEqual(["yield:first", "handle:brief:", "yield:second", "handle:question"]);
    finishProvider();

    const [streamed, buffered] = await Promise.all([
      streaming,
      core.generateText({
        provider: "ollama",
        model: "qwen",
        prompt: "question",
        instructions: "brief",
      }),
    ]);
    expect(streamed).toEqual({
      provider: "ollama",
      model: "qwen",
      delivery: "native",
      text: buffered.text,
    });
  });

  test("reports buffered delivery when the provider has no streaming method", async () => {
    const deltas: string[] = [];
    const core = client(runtime({
      streamText: undefined,
      generateText: async () => ({ text: "buffered\u001b[31m response" }),
    }));

    await expect(core.streamText({
      provider: "ollama",
      model: "qwen",
      prompt: "question",
    }, (delta) => { deltas.push(delta); })).resolves.toEqual({
      provider: "ollama",
      model: "qwen",
      delivery: "buffered",
      text: "buffered response",
    });
    expect(deltas).toEqual(["buffered response"]);
  });

  test("returns whole-response sanitized text when a control sequence spans deltas", async () => {
    const raw = "first\u001b[31m second\u001b[0m";
    const deltas: string[] = [];
    const core = client(runtime({
      generateText: async () => ({ text: raw }),
      streamText: () => ({
        delivery: "native",
        textStream: (async function* () {
          yield "first\u001b[";
          yield "31m second";
          yield "\u001b[0m";
        })(),
      }),
    }));

    const [buffered, streamed] = await Promise.all([
      core.generateText({ provider: "ollama", model: "qwen", prompt: "question" }),
      core.streamText(
        { provider: "ollama", model: "qwen", prompt: "question" },
        (delta) => { deltas.push(delta); },
      ),
    ]);
    expect(streamed.text).toBe(buffered.text);
    expect(streamed.text).toBe("first second");
    expect(deltas.join("")).toBe(streamed.text);
  });

  test("keeps callback and final text identical across split stream boundaries", async () => {
    const chunks = [
      "one\r",
      "\ntwo\u001b[",
      "31mthree\u001b]0;ti",
      "tle\u0007four\u001b[",
      "31",
    ];
    const deltas: string[] = [];
    const core = client(runtime({
      streamText: () => ({
        delivery: "native",
        textStream: (async function* () {
          for (const chunk of chunks) yield chunk;
        })(),
      }),
    }));

    const streamed = await core.streamText({
      provider: "ollama",
      model: "qwen",
      prompt: "question",
    }, (delta) => { deltas.push(delta); });

    expect(deltas.join("")).toBe(streamed.text);
    expect(streamed.text).toBe("one\ntwothreefour[31");
  });

  test("withholds every delta that completes a split sensitive value", async () => {
    const secret = "registered-secret";
    for (let split = 1; split < secret.length; split += 1) {
      const emitted: string[] = [];
      const core = client(runtime({
        streamText: () => ({
          delivery: "native",
          textStream: (async function* () {
            yield `safe ${secret.slice(0, split)}`;
            yield `${secret.slice(split)} unsafe`;
          })(),
        }),
      }));

      await expect(core.streamText({
        provider: "ollama",
        model: "qwen",
        prompt: "question",
        responseSensitiveValues: [secret],
      }, (delta) => { emitted.push(delta); })).rejects.toMatchObject({
        code: "UNSAFE_RESPONSE",
        operation: "streaming",
      });
      expect(emitted).toEqual([`safe ${secret.slice(0, split)}`]);
    }
  });

  test("sanitizes cumulative output before checking a control-split secret", async () => {
    const emitted: string[] = [];
    const core = client(runtime({
      streamText: () => ({
        delivery: "native",
        textStream: (async function* () {
          yield "safe registered-\u001b[31m";
          yield "secret unsafe";
        })(),
      }),
    }));

    await expect(core.streamText({
      provider: "ollama",
      model: "qwen",
      prompt: "question",
      responseSensitiveValues: ["registered-secret"],
    }, (delta) => { emitted.push(delta); })).rejects.toMatchObject({ code: "UNSAFE_RESPONSE" });
    expect(emitted).toEqual(["safe registered-"]);
  });

  test("withholds a sensitive value completed by final sanitizer flush", async () => {
    const emitted: string[] = [];
    const core = client(runtime({
      streamText: () => ({
        delivery: "native",
        textStream: (async function* () {
          yield "safe \u001b[";
          yield "31";
        })(),
      }),
    }));

    await expect(core.streamText({
      provider: "ollama",
      model: "qwen",
      prompt: "question",
      responseSensitiveValues: ["[31"],
    }, (delta) => { emitted.push(delta); })).rejects.toMatchObject({
      code: "UNSAFE_RESPONSE",
      operation: "streaming",
    });
    expect(emitted.join("")).toBe("safe ");
  });

  test("screens resolver and approved-child credentials in buffered and streamed output", async () => {
    const secret = "approved-child-secret";
    const spawnProcess = (() => {
      const events = new EventEmitter();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      queueMicrotask(() => {
        stdout.write(`${JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: secret },
        })}\n`);
        events.emit("close", 0);
      });
      return {
        stdout,
        stderr,
        stdin,
        once: events.once.bind(events),
        kill: () => true,
      } as unknown as LocalProcess;
    }) as LocalProcessSpawner;
    const core = createLlmNowCoreWithInternals({
      environment: {},
      credentialResolver: { resolve: async () => ({ status: "missing" }) },
      cliExecutionResolver: {
        resolve: async () => ({
          mode: "direct",
          executable: "/approved/codex",
          argsPrefix: [],
          env: { OPENAI_API_KEY: secret },
          responseSensitiveValues: [secret],
        }),
      },
    }, {
      findAvailableProviders: async () => [],
      createProvider: () => { throw new Error("unused"); },
      spawnProcess,
    });

    await expect(core.generateText({
      provider: "codex-cli",
      model: "gpt-test",
      prompt: "question",
    })).rejects.toMatchObject({ code: "UNSAFE_RESPONSE" });
    await expect(core.streamText({
      provider: "codex-cli",
      model: "gpt-test",
      prompt: "question",
    }, () => {})).rejects.toMatchObject({ code: "UNSAFE_RESPONSE" });
  });
});

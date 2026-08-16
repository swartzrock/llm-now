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
    generateText: async () => ({ text: "generated" }),
    ...overrides,
  };
}

function client(provider: ByokProviderRuntime, settlementTimeoutMs = 10) {
  return createLlmNowCoreWithInternals({
    environment: {},
    credentialResolver: { resolve: async () => ({ status: "missing" }) },
  }, {
    findAvailableProviders: async () => ["ollama"],
    createProvider: () => provider,
    settlementTimeoutMs,
  });
}

describe("core generation cancellation", () => {
  test("aborts pending discovery, model listing, and validation work", async () => {
    for (const operationName of ["discovery", "model-list", "validation"] as const) {
      let rejectWork!: (error: Error) => void;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const pending = new Promise<never>((_resolve, reject) => { rejectWork = reject; });
      const controller = new AbortController();
      const core = createLlmNowCoreWithInternals({
        environment: {},
        credentialResolver: { resolve: async () => ({ status: "missing" }) },
      }, {
        findAvailableProviders: () => {
          markStarted();
          return pending;
        },
        createProvider: () => runtime({
          listModels: () => {
            markStarted();
            return pending;
          },
        }),
        settlementTimeoutMs: 5,
      });
      const operation = operationName === "discovery"
        ? core.discoverProviders({ signal: controller.signal })
        : operationName === "model-list"
          ? core.listModels({ provider: "ollama", signal: controller.signal })
          : core.validateConnection({ provider: "ollama", signal: controller.signal });

      await started;
      controller.abort();
      await expect(operation).rejects.toMatchObject({
        code: "ABORTED",
        operation: operationName,
      });
      rejectWork(new Error(`late ${operationName} failure`));
      await Promise.resolve();
    }
  });

  test("passes model-list cancellation into an approved CLI child and waits for close", async () => {
    const events = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const kills: Array<NodeJS.Signals | undefined> = [];
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const spawnProcess = (() => {
      markStarted();
      return {
        stdout,
        stderr,
        stdin,
        once: events.once.bind(events),
        kill: (signal?: NodeJS.Signals) => {
          kills.push(signal);
          return true;
        },
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
          env: {},
        }),
      },
    }, {
      findAvailableProviders: async () => [],
      createProvider: () => { throw new Error("unused"); },
      spawnProcess,
      settlementTimeoutMs: 5,
    });
    const controller = new AbortController();
    let settled = false;
    const operation = core.listModels({
      provider: "codex-cli",
      signal: controller.signal,
    }).finally(() => { settled = true; });

    await started;
    controller.abort();
    await Promise.resolve();
    expect(kills).toEqual(["SIGTERM"]);
    expect(settled).toBeFalse();
    events.emit("close", null);
    await expect(operation).rejects.toMatchObject({
      code: "ABORTED",
      operation: "model-list",
      provider: "codex-cli",
    });
    expect(settled).toBeTrue();
  });

  test("aborts pending workspace preflight before resolving credentials or execution", async () => {
    for (const operationName of ["generation", "streaming"] as const) {
      let resolvePreflight!: () => void;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const pending = new Promise<void>((resolve) => { resolvePreflight = resolve; });
      let resolverCalls = 0;
      let executionCalls = 0;
      let providerCalls = 0;
      const controller = new AbortController();
      const core = createLlmNowCoreWithInternals({
        environment: {},
        credentialResolver: { resolve: async () => {
          resolverCalls += 1;
          return { status: "missing" };
        } },
        cliExecutionResolver: { resolve: async () => {
          executionCalls += 1;
          return null;
        } },
      }, {
        findAvailableProviders: async () => [],
        createProvider: () => {
          providerCalls += 1;
          return runtime();
        },
        preflightWorkspace: async (_provider, workspace) => {
          markStarted();
          await pending;
          return workspace;
        },
        settlementTimeoutMs: 5,
      });
      const request = {
        provider: "codex-cli" as const,
        model: "gpt-test",
        prompt: "question",
        signal: controller.signal,
        workspace: {
          primaryDirectory: "/approved/workspace",
          additionalDirectories: [],
          directoryAccess: "read-only" as const,
        },
      };
      const operation = operationName === "generation"
        ? core.generateText(request)
        : core.streamText(request, () => undefined);

      await started;
      controller.abort();
      await expect(operation).rejects.toMatchObject({
        code: "ABORTED",
        operation: operationName,
      });
      expect(resolverCalls).toBe(0);
      expect(executionCalls).toBe(0);
      expect(providerCalls).toBe(0);
      resolvePreflight();
      await Promise.resolve();
    }
  });

  test("reaps an erroring TERM-resistant CLI child before returning a safe abort", async () => {
    const events = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const kills: Array<NodeJS.Signals | undefined> = [];
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const spawnProcess = (() => {
      markStarted();
      return {
        stdout,
        stderr,
        stdin,
        once: events.once.bind(events),
        kill: (signal?: NodeJS.Signals) => {
          kills.push(signal);
          return true;
        },
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
          env: {},
        }),
      },
    }, {
      findAvailableProviders: async () => [],
      createProvider: () => { throw new Error("unused"); },
      spawnProcess,
      settlementTimeoutMs: 5,
    });
    const controller = new AbortController();
    const privateReason = "private-hostile-interruption-reason";
    let settled = false;
    const operation = core.generateText({
      provider: "codex-cli",
      model: "gpt-test",
      prompt: "question",
      signal: controller.signal,
    }).finally(() => { settled = true; });

    await started;
    controller.abort(new Error(privateReason));
    events.emit("error", new Error("child error after abort"));
    await Bun.sleep(275);
    expect(kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(settled).toBeFalse();
    events.emit("close", null);
    try {
      await operation;
      throw new Error("expected cancellation");
    } catch (error) {
      expect(error).toMatchObject({
        code: "ABORTED",
        operation: "generation",
        provider: "codex-cli",
      });
      expect(String(error)).not.toContain(privateReason);
      expect(String(error)).not.toContain("child error after abort");
    }
    expect(settled).toBeTrue();
  });

  test("aborts pending credential resolution without retaining the operation", async () => {
    let rejectResolution!: (error: Error) => void;
    const resolution = new Promise<never>((_resolve, reject) => { rejectResolution = reject; });
    const controller = new AbortController();
    const core = createLlmNowCoreWithInternals({
      environment: {},
      credentialResolver: { resolve: () => resolution },
    }, {
      findAvailableProviders: async () => [],
      createProvider: () => { throw new Error("provider construction must not run"); },
      settlementTimeoutMs: 5,
    });
    const operation = core.generateText({
      provider: "openai",
      model: "gpt-test",
      prompt: "question",
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    await expect(operation).rejects.toMatchObject({ code: "ABORTED" });
    rejectResolution(new Error("late credential failure"));
    await Promise.resolve();
  });

  test("cancellation escapes a never-settling delta handler and drains its later rejection", async () => {
    let rejectHandler!: (error: Error) => void;
    let markHandlerStarted!: () => void;
    let finalized = false;
    let yields = 0;
    const handler = new Promise<void>((_resolve, reject) => { rejectHandler = reject; });
    const handlerStarted = new Promise<void>((resolve) => { markHandlerStarted = resolve; });
    const controller = new AbortController();
    const core = client(runtime({
      streamText: () => ({
        delivery: "native",
        textStream: {
          async *[Symbol.asyncIterator]() {
            try {
              yields += 1;
              yield "first";
              yields += 1;
              yield "second";
            } finally {
              finalized = true;
            }
          },
        },
      }),
    }));

    const operation = core.streamText({
      provider: "ollama",
      model: "qwen",
      prompt: "question",
      signal: controller.signal,
    }, () => {
      markHandlerStarted();
      return handler;
    });
    await handlerStarted;
    controller.abort(new Error("private abort reason"));
    await expect(operation).rejects.toMatchObject({ code: "ABORTED", operation: "streaming" });
    expect(finalized).toBeTrue();
    expect(yields).toBe(1);
    rejectHandler(new Error("late private handler rejection"));
    await Promise.resolve();
  });

  test("uses callback-failure versus cancellation ordering for the primary error", async () => {
    let finalized = false;
    const before = client(runtime({
      streamText: () => ({
        delivery: "native",
        textStream: (async function* () {
          try {
            yield "delta";
          } finally {
            finalized = true;
          }
        })(),
      }),
    }));
    await expect(before.streamText({
      provider: "ollama",
      model: "qwen",
      prompt: "question",
    }, async () => { throw new Error("private handler failure"); })).rejects.toMatchObject({
      code: "DELTA_HANDLER_FAILED",
      operation: "streaming",
    });
    expect(finalized).toBeTrue();

    let rejectHandler!: (error: Error) => void;
    let markHandlerStarted!: () => void;
    const pending = new Promise<void>((_resolve, reject) => { rejectHandler = reject; });
    const handlerStarted = new Promise<void>((resolve) => { markHandlerStarted = resolve; });
    const controller = new AbortController();
    const after = client(runtime({
      streamText: () => ({
        delivery: "native",
        textStream: (async function* () { yield "delta"; })(),
      }),
    }));
    const operation = after.streamText({
      provider: "ollama",
      model: "qwen",
      prompt: "question",
      signal: controller.signal,
    }, () => {
      markHandlerStarted();
      return pending;
    });
    await handlerStarted;
    controller.abort();
    await expect(operation).rejects.toMatchObject({ code: "ABORTED" });
    rejectHandler(new Error("too late"));
    await Promise.resolve();
  });

  test("bounds remote provider settlement and drains a later rejection", async () => {
    let rejectProvider!: (error: Error) => void;
    const pending = new Promise<{ text: string }>((_resolve, reject) => { rejectProvider = reject; });
    const controller = new AbortController();
    const core = client(runtime({ generateText: () => pending }), 5);
    const operation = core.generateText({
      provider: "ollama",
      model: "qwen",
      prompt: "question",
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    const started = performance.now();
    await expect(operation).rejects.toMatchObject({ code: "ABORTED" });
    expect(performance.now() - started).toBeLessThan(100);
    rejectProvider(new Error("late provider rejection"));
    await Promise.resolve();
  });

  test("does not let iterator cleanup replace a callback failure", async () => {
    const core = client(runtime({
      streamText: () => ({
        delivery: "native",
        textStream: {
          [Symbol.asyncIterator]() {
            return {
              next: async () => ({ done: false, value: "delta" }),
              return: async () => { throw new Error("private cleanup failure"); },
            };
          },
        },
      }),
    }));

    await expect(core.streamText({
      provider: "ollama",
      model: "qwen",
      prompt: "question",
    }, async () => { throw new Error("private handler failure"); })).rejects.toMatchObject({
      code: "DELTA_HANDLER_FAILED",
    });
  });

  test("removes the caller abort listener after success", async () => {
    const controller = new AbortController();
    const originalAdd = controller.signal.addEventListener.bind(controller.signal);
    const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
    let adds = 0;
    let removes = 0;
    controller.signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
      adds += 1;
      return originalAdd(...args);
    }) as AbortSignal["addEventListener"];
    controller.signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
      removes += 1;
      return originalRemove(...args);
    }) as AbortSignal["removeEventListener"];

    await client(runtime()).generateText({
      provider: "ollama",
      model: "qwen",
      prompt: "question",
      signal: controller.signal,
    });
    expect(adds).toBeGreaterThan(0);
    expect(removes).toBe(adds);
  });
});

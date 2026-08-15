import { describe, expect, test } from "bun:test";
import type { ByokProviderConfig, ByokProviderRuntime } from "@swartzrock/byok-runtime";
import type { LocalProcess, LocalProcessSpawner } from "@swartzrock/byok-runtime/node";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { LlmNowError } from "../src/errors.ts";
import {
  createLlmNowCoreWithInternals,
  type CoreInternalDependencies,
} from "../src/client.ts";

function provider(overrides: Partial<ByokProviderRuntime> = {}): ByokProviderRuntime {
  return {
    id: "ollama",
    label: "Test",
    requiresNetwork: false,
    requiresDownload: false,
    testConnection: async () => ({ ok: true, message: "ok" }),
    listModels: async () => [{ id: "model-a", label: "Model A" }],
    generateText: async () => ({ text: "generated" }),
    ...overrides,
  };
}

function internals(overrides: Partial<CoreInternalDependencies> = {}): CoreInternalDependencies {
  return {
    findAvailableProviders: async () => ["ollama"],
    createProvider: () => provider(),
    ...overrides,
  };
}

describe("buffered core client", () => {
  test("constructs without resolving credentials or probing providers", () => {
    let calls = 0;
    createLlmNowCoreWithInternals({
      environment: {},
      credentialResolver: { resolve: async () => {
        calls += 1;
        return { status: "missing" };
      } },
    }, internals({ findAvailableProviders: async () => {
      calls += 1;
      return [];
    } }));
    expect(calls).toBe(0);
  });

  test("uses explicit provider/model/prompt values without an implicit model list", async () => {
    const configs: ByokProviderConfig[] = [];
    let lists = 0;
    const client = createLlmNowCoreWithInternals({
      environment: {},
      credentialResolver: { resolve: async () => ({
        status: "resolved",
        credential: "request-secret",
      }) },
    }, internals({
      createProvider: (config) => {
        configs.push(config);
        return provider({
          listModels: async () => {
            lists += 1;
            return [];
          },
          generateText: async (input) => ({ text: `${input.instructions}:${input.prompt}` }),
        });
      },
    }));

    await expect(client.generateText({
      provider: "openai",
      model: "gpt-test",
      prompt: "question",
      instructions: "Be brief",
    })).resolves.toEqual({
      provider: "openai",
      model: "gpt-test",
      text: "Be brief:question",
    });
    expect(configs).toEqual([{ provider: "openai", apiKey: "request-secret", model: "gpt-test" }]);
    expect(lists).toBe(0);
  });

  test("enforces the validation credential matrix without fallback", async () => {
    let resolverCalls = 0;
    const configs: ByokProviderConfig[] = [];
    const client = createLlmNowCoreWithInternals({
      environment: {},
      credentialResolver: { resolve: async () => {
        resolverCalls += 1;
        return { status: "resolved", credential: "resolver-secret" };
      } },
    }, internals({ createProvider: (config) => {
      configs.push(config);
      return provider();
    } }));

    await client.validateConnection({ provider: "openai", candidateCredential: "candidate-secret" });
    expect(resolverCalls).toBe(0);
    expect(configs[0]).toEqual({ provider: "openai", apiKey: "candidate-secret", model: "" });

    await client.validateConnection({ provider: "openai" });
    expect(resolverCalls).toBe(1);
    expect(configs[1]).toEqual({ provider: "openai", apiKey: "resolver-secret", model: "" });

    await expect(client.validateConnection({
      provider: "openai",
      candidateCredential: "   ",
    })).rejects.toMatchObject({ code: "INVALID_REQUEST", operation: "validation" });
    await expect(client.validateConnection({
      provider: "ollama",
      candidateCredential: "candidate-secret",
    })).rejects.toMatchObject({ code: "INVALID_REQUEST", operation: "validation" });
    expect(resolverCalls).toBe(1);
  });

  test("maps hostile provider failures to the closed public error", async () => {
    const secret = "hostile-provider-detail";
    const client = createLlmNowCoreWithInternals({
      environment: {},
      credentialResolver: { resolve: async () => ({ status: "missing" }) },
    }, internals({ createProvider: () => provider({
      generateText: async () => { throw new Error(secret); },
    }) }));

    try {
      await client.generateText({ provider: "ollama", model: "qwen", prompt: "hello" });
      throw new Error("expected generation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(LlmNowError);
      expect(error).toMatchObject({ code: "GENERATION_FAILED", operation: "generation", provider: "ollama" });
      expect(String(error)).not.toContain(secret);
    }
  });

  test("maps hostile request objects without inspecting their error details", async () => {
    const secret = "hostile-request-detail";
    const client = createLlmNowCoreWithInternals({
      environment: {},
      credentialResolver: { resolve: async () => ({ status: "missing" }) },
    }, internals());
    const request = new Proxy({}, {
      get() { throw new Error(secret); },
    });

    try {
      await client.generateText(request as never);
      throw new Error("expected invalid request");
    } catch (error) {
      expect(error).toBeInstanceOf(LlmNowError);
      expect(String(error)).not.toContain(secret);
    }
  });

  test("maps malformed ordinary request values to INVALID_REQUEST", async () => {
    const client = createLlmNowCoreWithInternals({
      environment: {},
      credentialResolver: { resolve: async () => ({ status: "missing" }) },
    }, internals());

    for (const operation of [
      () => client.discoverProviders("invalid" as never),
      () => client.listModels(null as never),
      () => client.validateConnection([] as never),
      () => client.generateText(undefined as never),
      () => client.generateText({
        provider: "ollama",
        model: "qwen",
        prompt: "hello",
        signal: "invalid",
      } as never),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
  });

  test("screens recognized approved-child secrets before returning CLI output", async () => {
    const events = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    let launch: Parameters<LocalProcessSpawner> | undefined;
    const spawnProcess = ((...args: Parameters<LocalProcessSpawner>) => {
      launch = args;
      queueMicrotask(() => {
        stdout.write(`${JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "approved-child-secret" },
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
    const client = createLlmNowCoreWithInternals({
      environment: {
        PATH: "/ambient/must-not-select",
        COMSPEC: "C:\\ambient\\must-not-select.exe",
      },
      credentialResolver: { resolve: async () => ({ status: "missing" }) },
      cliExecutionResolver: {
        resolve: async () => ({
          mode: "direct",
          executable: "/approved/codex",
          argsPrefix: ["approved-prefix"],
          env: { OPENAI_API_KEY: "approved-child-secret" },
          responseSensitiveValues: ["approved-child-secret"],
        }),
      },
    }, internals({
      spawnProcess,
      createProvider: () => { throw new Error("CLI generation must not use the generic factory"); },
    }));

    await expect(client.generateText({
      provider: "codex-cli",
      model: "gpt-test",
      prompt: "prompt cannot replace executable",
      instructions: "instructions cannot replace prefix",
    })).rejects.toMatchObject({
      code: "UNSAFE_RESPONSE",
      operation: "generation",
      provider: "codex-cli",
    });
    expect(launch?.[0]).toBe("/approved/codex");
    expect(launch?.[1]?.[0]).toBe("approved-prefix");
    expect(launch?.[2]).toMatchObject({
      shell: false,
      env: { OPENAI_API_KEY: "approved-child-secret" },
    });
  });
});

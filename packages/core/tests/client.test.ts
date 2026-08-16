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

  test("reports only a request-redacted diagnostic beside the fixed public error", async () => {
    const prompt = "private prompt";
    const instructions = 'private "instructions"';
    const serializedInstructions = JSON.stringify(instructions);
    const credential = "private-provider-credential";
    const diagnostics: string[] = [];
    const client = createLlmNowCoreWithInternals({
      environment: {},
      credentialResolver: { resolve: async () => ({ status: "resolved", credential }) },
    }, internals({ createProvider: () => provider({
      generateText: async () => {
        throw new Error(
          `provider failed: ${credential} ${prompt} ${instructions} ${serializedInstructions}`,
        );
      },
    }) }));

    await expect(client.generateText({
      provider: "openai",
      model: "gpt-test",
      prompt,
      instructions,
      onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
    })).rejects.toMatchObject({
      code: "GENERATION_FAILED",
      message: "Text generation failed.",
    });
    expect(diagnostics).toEqual([
      "provider failed: [REDACTED] [REDACTED] [REDACTED] [REDACTED]",
    ]);
  });

  test("does not let a diagnostic handler replace the primary failure", async () => {
    const client = createLlmNowCoreWithInternals({
      environment: {},
      credentialResolver: { resolve: async () => ({ status: "missing" }) },
    }, internals({ createProvider: () => provider({
      generateText: async () => { throw new Error("provider failed"); },
    }) }));

    await expect(client.generateText({
      provider: "ollama",
      model: "qwen",
      prompt: "hello",
      onDiagnostic: async () => { throw new Error("diagnostic handler failed"); },
    })).rejects.toMatchObject({ code: "GENERATION_FAILED" });

    await new Promise((resolve) => setTimeout(resolve, 0));
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

  test("withholds resolver and candidate credentials echoed in model metadata", async () => {
    let resolverCalls = 0;
    const secret = "resolver-model-secret";
    const client = createLlmNowCoreWithInternals({
      environment: {},
      credentialResolver: { resolve: async () => {
        resolverCalls += 1;
        return { status: "resolved", credential: secret };
      } },
    }, internals({ createProvider: (config) => provider({
      listModels: async () => {
        const credential = "apiKey" in config ? config.apiKey : secret;
        return [{ id: credential, label: `Model ${credential}` }];
      },
    }) }));

    await expect(client.listModels({ provider: "openai" })).rejects.toMatchObject({
      code: "MODEL_LIST_FAILED",
      operation: "model-list",
    });
    await expect(client.validateConnection({
      provider: "openai",
      candidateCredential: "candidate-model-secret",
    })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      operation: "validation",
    });
    expect(resolverCalls).toBe(1);
  });

  test("rejects model metadata that contains terminal control sequences", async () => {
    const client = createLlmNowCoreWithInternals({
      environment: {},
      credentialResolver: { resolve: async () => ({ status: "missing" }) },
    }, internals({ createProvider: () => provider({
      listModels: async () => [{ id: "model\u001b[31m", label: "unsafe\u0000label" }],
    }) }));

    await expect(client.listModels({ provider: "ollama" })).rejects.toMatchObject({
      code: "MODEL_LIST_FAILED",
      operation: "model-list",
    });
  });

  test("withholds approved-child credentials echoed in CLI model metadata", async () => {
    const events = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const childSecret = "non-selected-child-secret";
    const spawnProcess = (() => {
      queueMicrotask(() => {
        stdout.end(JSON.stringify([{ id: childSecret, displayName: "Unsafe model" }]));
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
      environment: {},
      credentialResolver: { resolve: async () => ({ status: "missing" }) },
      cliExecutionResolver: {
        resolve: async () => ({
          mode: "direct",
          executable: "/approved/codex",
          argsPrefix: [],
          env: { OPENAI_API_KEY: childSecret },
          responseSensitiveValues: [childSecret],
        }),
      },
    }, internals({
      createProvider: () => { throw new Error("unused"); },
      spawnProcess,
    }));

    await expect(client.listModels({ provider: "codex-cli" })).rejects.toMatchObject({
      code: "MODEL_LIST_FAILED",
      operation: "model-list",
      provider: "codex-cli",
    });
  });

  test("snapshots mutable generation input before the first asynchronous boundary", async () => {
    const configs: ByokProviderConfig[] = [];
    const inputs: Array<{ prompt: string; instructions?: string }> = [];
    const client = createLlmNowCoreWithInternals({
      environment: {},
      credentialResolver: { resolve: async () => ({ status: "missing" }) },
    }, internals({ createProvider: (config) => {
      configs.push(config);
      return provider({
        generateText: async (input) => {
          inputs.push(input);
          return { text: "generated" };
        },
      });
    } }));
    const sensitiveValues = ["original-secret"];
    const request = {
      provider: "ollama" as const,
      model: "model-a",
      prompt: "prompt-a",
      instructions: "instructions-a",
      responseSensitiveValues: sensitiveValues,
    };

    const operation = client.generateText(request);
    request.model = "model-b";
    request.prompt = "prompt-b";
    request.instructions = "instructions-b";
    sensitiveValues[0] = "mutated-secret";

    await expect(operation).resolves.toEqual({
      provider: "ollama",
      model: "model-a",
      text: "generated",
    });
    expect(configs).toEqual([{ provider: "ollama", model: "model-a" }]);
    expect(inputs).toEqual([{ prompt: "prompt-a", instructions: "instructions-a" }]);
  });
});

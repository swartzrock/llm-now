import { describe, expect, test } from "bun:test";
import type { ByokProviderId } from "@swartzrock/byok-runtime";
import { RuntimeStageError, type RuntimeGateway } from "../src/runtime.ts";
import { runApplication, type ApplicationPrompter } from "../src/app.ts";

function input(text = "", isTTY = false) {
  return {
    isTTY,
    async *[Symbol.asyncIterator]() {
      if (text) yield new TextEncoder().encode(text);
    },
  };
}

function output(isTTY = false) {
  let text = "";
  return {
    isTTY,
    write(chunk: string) {
      text += chunk;
    },
    text: () => text,
  };
}

function prompts(options: {
  choices?: Array<number | null>;
  confirms?: Array<boolean | null>;
  names?: Array<string | null>;
} = {}): ApplicationPrompter {
  return {
    choose: async () => options.choices?.shift() ?? null,
    confirm: async () => options.confirms?.shift() ?? null,
    input: async () => options.names?.shift() ?? null,
  };
}

function runtime(options: {
  providers?: ByokProviderId[];
  response?: string;
  discover?: RuntimeGateway["discover"];
  listModels?: RuntimeGateway["listModels"];
  generate?: RuntimeGateway["generate"];
} = {}) {
  const calls = { discover: 0, list: 0, generate: 0 };
  const value: RuntimeGateway = {
    discover: async () => {
      calls.discover += 1;
      if (options.discover) return options.discover();
      return options.providers ?? ["ollama"];
    },
    listModels: async (provider) => {
      calls.list += 1;
      if (options.listModels) return options.listModels(provider);
      return [{ id: "qwen", label: "Qwen" }];
    },
    generate: async (...args) => {
      calls.generate += 1;
      if (options.generate) return options.generate(...args);
      return options.response ?? "response";
    },
  };
  return { value, calls };
}

function dependencies(options: {
  args: string[];
  stdin?: ReturnType<typeof input>;
  stderrTty?: boolean;
  runtime?: ReturnType<typeof runtime>;
  prompter?: ApplicationPrompter;
  env?: Record<string, string>;
  resolveAlias?: (path: string, name: string) => Promise<{ provider: ByokProviderId; model: string | null }>;
  saveAlias?: (...args: Parameters<NonNullable<Parameters<typeof runApplication>[0]["saveAlias"]>>) => Promise<"saved" | "unchanged">;
  generationTimeoutMs?: number;
  discoveryTimeoutMs?: number;
  modelListTimeoutMs?: number;
}) {
  const stdout = output();
  const stderr = output(options.stderrTty ?? false);
  const selectedRuntime = options.runtime ?? runtime();
  return {
    stdout,
    stderr,
    runtime: selectedRuntime,
    value: {
      args: options.args,
      stdin: options.stdin ?? input(),
      stdout,
      stderr,
      runtime: selectedRuntime.value,
      prompter: options.prompter ?? prompts(),
      env: options.env ?? {},
      platform: "linux" as const,
      home: "/home/test",
      version: "1.2.3",
      aliasPath: "/config/aliases.json",
      resolveAlias: options.resolveAlias,
      saveAlias: options.saveAlias,
      generationTimeoutMs: options.generationTimeoutMs,
      discoveryTimeoutMs: options.discoveryTimeoutMs,
      modelListTimeoutMs: options.modelListTimeoutMs,
    },
  };
}

describe("one-shot application", () => {
  test("composes interactive selection and writes the response byte-faithfully once", async () => {
    const response = " exact\u001b[31m model output \n";
    const app = dependencies({
      args: ["--input", "poem"],
      stdin: input("", true),
      stderrTty: true,
      runtime: runtime({ providers: ["ollama", "claude-cli"], response }),
      prompter: prompts({ choices: [0, 0], confirms: [false] }),
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.stdout.text()).toBe(response);
    expect(app.runtime.calls).toEqual({ discover: 1, list: 1, generate: 1 });
    expect(app.stderr.text()).toContain("Choose a provider");
    expect(app.stderr.text()).toContain("Choose a model");
  });

  test("resolves an alias without discovery and keeps non-interactive stdout clean", async () => {
    const app = dependencies({
      args: ["--input", "hello", "--alias", "daily"],
      runtime: runtime({ response: "alias-result" }),
      resolveAlias: async (_path, name) => {
        expect(name).toBe("daily");
        return { provider: "claude-cli", model: null };
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.stdout.text()).toBe("alias-result");
    expect(app.stderr.text()).toBe("");
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 1 });
  });

  test("fails a stale alias without selecting a replacement", async () => {
    const app = dependencies({
      args: ["--input", "hello", "--alias", "stale"],
      runtime: runtime({
        providers: ["openai"],
        generate: async () => {
          throw new RuntimeStageError("generation", "ollama", "unavailable");
        },
      }),
      resolveAlias: async () => ({ provider: "ollama", model: "missing" }),
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(app.stdout.text()).toBe("");
    expect(app.stderr.text()).toContain("generation (ollama): unavailable");
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 1 });
  });

  test("rejects ambiguous non-interactive selection before generation", async () => {
    const app = dependencies({ args: ["--input", "hello"] });
    expect(await runApplication(app.value)).toBe(2);
    expect(app.stdout.text()).toBe("");
    expect(app.runtime.calls.generate).toBe(0);
    expect(app.stderr.text()).toContain("usage:");
  });

  test("returns 130 when interactive selection is cancelled", async () => {
    const app = dependencies({
      args: ["--input", "hello"],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({ choices: [null] }),
    });
    expect(await runApplication(app.value)).toBe(130);
    expect(app.runtime.calls.generate).toBe(0);
    expect(app.stdout.text()).toBe("");
  });

  test("sanitizes and bounds hostile diagnostic detail without leaking credentials", async () => {
    const secret = "super-secret-value";
    const hostile = `bad\r\n\u001b[31m${secret}\u0000${"x".repeat(2_000)}`;
    const app = dependencies({
      args: ["--input", "hello", "--provider", "openai", "--model", "gpt"],
      env: { OPENAI_API_KEY: secret },
      runtime: runtime({
        generate: async () => {
          throw new RuntimeStageError("generation", "openai", hostile);
        },
      }),
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(app.stdout.text()).toBe("");
    expect(app.stderr.text()).not.toContain(secret);
    expect(app.stderr.text()).not.toContain("\u001b");
    expect(app.stderr.text()).not.toContain("\u0000");
    expect(app.stderr.text()).not.toContain("\r");
    expect(app.stderr.text().length).toBeLessThanOrEqual(1_100);
    expect(app.stderr.text()).toContain("generation (openai)");
  });

  test("propagates the generation timeout signal and names the stage", async () => {
    let aborted = false;
    const app = dependencies({
      args: ["--input", "hello", "--provider", "ollama", "--model", "qwen"],
      generationTimeoutMs: 5,
      runtime: runtime({
        generate: async (_provider, _model, _prompt, signal) =>
          await new Promise<string>((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          }),
      }),
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(aborted).toBe(true);
    expect(app.stderr.text()).toContain("generation (ollama): timed out");
  });

  test("bounds discovery and model-list stages", async () => {
    const discovery = dependencies({
      args: ["--input", "hello"],
      stdin: input("", true),
      stderrTty: true,
      discoveryTimeoutMs: 5,
      runtime: runtime({ discover: () => new Promise(() => {}) }),
    });
    expect(await runApplication(discovery.value)).toBe(1);
    expect(discovery.stderr.text()).toContain("discovery: timed out");

    const models = dependencies({
      args: ["--input", "hello"],
      stdin: input("", true),
      stderrTty: true,
      modelListTimeoutMs: 5,
      runtime: runtime({ listModels: () => new Promise(() => {}) }),
      prompter: prompts({ choices: [0] }),
    });
    expect(await runApplication(models.value)).toBe(1);
    expect(models.stderr.text()).toContain("model-list (ollama): timed out");
  });

  test("post-success invalid name and declined overwrite preserve exit zero", async () => {
    const savedNames: string[] = [];
    const app = dependencies({
      args: ["--input", "hello"],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({
        choices: [0, 0],
        confirms: [true, false],
        names: [" invalid", "daily"],
      }),
      saveAlias: async (_path, name, _selection, options) => {
        savedNames.push(name);
        if (name === " invalid") throw new Error("invalid alias name:  invalid");
        expect(await options?.confirmOverwrite?.("daily", { provider: "ollama", model: "old" })).toBe(false);
        return "unchanged";
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.stdout.text()).toBe("response");
    expect(savedNames).toEqual(["daily"]);
    expect(app.stderr.text()).toContain("config: invalid alias name");
    expect(app.runtime.calls.generate).toBe(1);
  });

  test("returns an operational failure when alias persistence fails after generation", async () => {
    const app = dependencies({
      args: ["--input", "hello"],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({ choices: [0, 0], confirms: [true], names: ["daily"] }),
      saveAlias: async () => {
        throw new Error("disk full");
      },
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(app.stdout.text()).toBe("response");
    expect(app.stderr.text()).toContain("config: disk full");
    expect(app.runtime.calls.generate).toBe(1);
  });
});

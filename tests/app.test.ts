import { describe, expect, test } from "bun:test";
import type { ByokProviderId } from "@swartzrock/byok-runtime";
import { AliasStoreError, type SaveAliasResult } from "../src/aliases.ts";
import { RuntimeStageError, type RuntimeGateway } from "../src/runtime.ts";
import { runApplication, type ApplicationPrompter } from "../src/app.ts";
import type { PromptOption, PromptValue } from "../src/prompts.ts";

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
    write(chunk: string, callback?: (error?: Error | null) => void) {
      text += chunk;
      callback?.();
    },
    text: () => text,
  };
}

function prompts(options: {
  choices?: Array<PromptValue | null>;
  confirms?: Array<boolean | null>;
  names?: Array<string | null>;
  seen?: Array<{ message: string; options: PromptOption[] }>;
  inputMessages?: string[];
  confirmMessages?: string[];
  confirmInitialValues?: Array<boolean | undefined>;
} = {}): ApplicationPrompter {
  return {
    select: async (message, promptOptions) => {
      options.seen?.push({ message, options: [...promptOptions] });
      return options.choices?.shift() ?? null;
    },
    confirm: async (message, promptOptions) => {
      options.confirmMessages?.push(message);
      options.confirmInitialValues?.push(promptOptions?.initialValue);
      return options.confirms?.shift() ?? null;
    },
    input: async (message) => {
      options.inputMessages?.push(message);
      return options.names?.shift() ?? null;
    },
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
  loadAliases?: (path: string) => Promise<{
    version: 1;
    aliases: Record<string, { provider: ByokProviderId; model: string | null }>;
  }>;
  resolveAlias?: (path: string, name: string) => Promise<{ provider: ByokProviderId; model: string | null }>;
  saveAlias?: (...args: Parameters<NonNullable<Parameters<typeof runApplication>[0]["saveAlias"]>>) => Promise<SaveAliasResult>;
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
      loadAliases: options.loadAliases,
      resolveAlias: options.resolveAlias,
      saveAlias: options.saveAlias,
      generationTimeoutMs: options.generationTimeoutMs,
      discoveryTimeoutMs: options.discoveryTimeoutMs,
      modelListTimeoutMs: options.modelListTimeoutMs,
    },
  };
}

describe("one-shot application", () => {
  test("offers sorted saved aliases first and bypasses discovery for the selected alias", async () => {
    const seen: Array<{ message: string; options: PromptOption[] }> = [];
    let loads = 0;
    const app = dependencies({
      args: ["--input", "hello"],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({ choices: ["fast"], seen }),
      loadAliases: async (path) => {
        loads += 1;
        expect(path).toBe("/config/aliases.json");
        return {
          version: 1,
          aliases: {
            fast: { provider: "openai", model: "gpt-5" },
            Daily: { provider: "ollama", model: "llama3" },
            assistant: { provider: "claude-cli", model: null },
          },
        };
      },
      runtime: runtime({
        generate: async (provider, model) => {
          expect({ provider, model }).toEqual({ provider: "openai", model: "gpt-5" });
          return "alias-result";
        },
      }),
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(loads).toBe(1);
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 1 });
    expect(app.stdout.text()).toBe("alias-result");
    expect(seen).toEqual([{
      message: "Choose an alias",
      options: [
        { value: "assistant", label: "assistant", hint: "Claude CLI · provider default" },
        { value: "Daily", label: "Daily", hint: "Ollama · llama3" },
        { value: "fast", label: "fast", hint: "OpenAI · gpt-5" },
        { value: false, label: "Select a new provider and model…" },
      ],
    }]);
  });

  test("skips an empty alias picker and enters fresh discovery", async () => {
    const seen: Array<{ message: string; options: PromptOption[] }> = [];
    let loads = 0;
    const app = dependencies({
      args: ["--input", "hello"],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({
        choices: ["ollama", "qwen"],
        confirms: [false],
        seen,
      }),
      loadAliases: async () => {
        loads += 1;
        return { version: 1, aliases: {} };
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(loads).toBe(1);
    expect(app.runtime.calls).toEqual({ discover: 1, list: 1, generate: 1 });
    expect(seen.map(({ message }) => message)).toEqual([
      "Choose a provider",
      "Choose a model",
    ]);
  });

  test("the alias escape hatch enters fresh discovery", async () => {
    const seen: Array<{ message: string; options: PromptOption[] }> = [];
    const app = dependencies({
      args: ["--input", "hello"],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({
        choices: [false, "ollama", "qwen"],
        confirms: [false],
        seen,
      }),
      loadAliases: async () => ({
        version: 1,
        aliases: { daily: { provider: "openai", model: "gpt-5" } },
      }),
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.runtime.calls).toEqual({ discover: 1, list: 1, generate: 1 });
    expect(seen.map(({ message }) => message)).toEqual([
      "Choose an alias",
      "Choose a provider",
      "Choose a model",
    ]);
  });

  test("suggests an existing alias instead of offering to save the same target again", async () => {
    const inputMessages: string[] = [];
    let saves = 0;
    const app = dependencies({
      args: ["--input", "hello"],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1" },
      prompter: prompts({
        choices: [false, "ollama", "qwen"],
        names: ["duplicate"],
        inputMessages,
      }),
      loadAliases: async () => ({
        version: 1,
        aliases: {
          zebra: { provider: "ollama", model: "qwen" },
          Daily: { provider: "ollama", model: "qwen" },
        },
      }),
      saveAlias: async () => {
        saves += 1;
        return "saved";
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(inputMessages).toEqual([]);
    expect(saves).toBe(0);
    expect(app.stderr.text()).toContain(
      "◆ Ollama · qwen is already saved as alias Daily\n  Next time, use --alias Daily\n",
    );
  });

  test("suggests an existing alias for a provider-default target", async () => {
    const inputMessages: string[] = [];
    let saves = 0;
    const app = dependencies({
      args: ["--input", "hello"],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1" },
      runtime: runtime({
        providers: ["claude-cli"],
        listModels: async () => [],
      }),
      prompter: prompts({
        choices: [false, "claude-cli", false],
        names: ["duplicate"],
        inputMessages,
      }),
      loadAliases: async () => ({
        version: 1,
        aliases: { quick: { provider: "claude-cli", model: null } },
      }),
      saveAlias: async () => {
        saves += 1;
        return "saved";
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(inputMessages).toEqual([]);
    expect(saves).toBe(0);
    expect(app.stderr.text()).toContain(
      "◆ Claude CLI · provider default is already saved as alias quick\n"
      + "  Next time, use --alias quick\n",
    );
  });

  test("returns 130 when the alias picker is cancelled", async () => {
    const app = dependencies({
      args: ["--input", "hello"],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({ choices: [null] }),
      loadAliases: async () => ({
        version: 1,
        aliases: { daily: { provider: "openai", model: "gpt-5" } },
      }),
    });

    expect(await runApplication(app.value)).toBe(130);
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 0 });
    expect(app.stdout.text()).toBe("");
  });

  test("fails closed when the interactive alias document cannot load", async () => {
    const app = dependencies({
      args: ["--input", "hello"],
      stdin: input("", true),
      stderrTty: true,
      loadAliases: async () => {
        throw new AliasStoreError("failed to load alias store: /config/aliases.json");
      },
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 0 });
    expect(app.stderr.text()).toContain("failed to load alias store");
  });

  test("explicit interactive provider selection does not load aliases", async () => {
    const app = dependencies({
      args: ["--input", "hello", "--provider", "openai", "--model", "gpt-5"],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({ confirms: [false] }),
      loadAliases: async () => {
        throw new Error("explicit selection must not load aliases");
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 1 });
  });

  test("composes interactive selection and writes the response byte-faithfully once", async () => {
    const response = " exact\u001b[31m model output \n";
    const app = dependencies({
      args: ["--input", "poem"],
      stdin: input("", true),
      stderrTty: true,
      runtime: runtime({ providers: ["ollama", "claude-cli"], response }),
      prompter: prompts({ choices: ["ollama", "qwen"], confirms: [false] }),
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.stdout.text()).toBe(response);
    expect(app.runtime.calls).toEqual({ discover: 1, list: 1, generate: 1 });
    expect(app.stderr.text()).toBe("\u001b[0m\n");
  });

  test("resolves an alias without discovery and keeps non-interactive stdout clean", async () => {
    const app = dependencies({
      args: ["--input", "hello", "--alias", "daily"],
      runtime: runtime({ response: "alias-result" }),
      loadAliases: async () => {
        throw new Error("explicit alias must not load the alias picker document");
      },
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
    const app = dependencies({
      args: ["--input", "hello"],
      loadAliases: async () => {
        throw new Error("non-interactive selection must fail before alias loading");
      },
    });
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
      prompter: prompts({ choices: ["ollama"] }),
    });
    expect(await runApplication(models.value)).toBe(1);
    expect(models.stderr.text()).toContain("model-list (ollama): timed out");
  });

  test("keeps exact stdout and opens the contextual alias field after the defined boundary", async () => {
    const inputMessages: string[] = [];
    const app = dependencies({
      args: ["--input", "hello"],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1" },
      runtime: runtime({ response: "done" }),
      prompter: prompts({
        choices: ["ollama", "qwen"],
        names: [null],
        inputMessages,
      }),
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.stdout.text()).toBe("done");
    expect(app.stderr.text()).toBe("\u001b[0m\n\n");
    expect(inputMessages).toEqual([
      "Enter an alias name for Ollama · qwen (Enter to exit)",
    ]);
  });

  test("emphasizes the provider and model in the alias field", async () => {
    const inputMessages: string[] = [];
    const app = dependencies({
      args: ["--input", "hello"],
      stdin: input("", true),
      stderrTty: true,
      runtime: runtime({ response: "done" }),
      prompter: prompts({
        choices: ["ollama", "qwen"],
        names: [""],
        inputMessages,
      }),
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(inputMessages[0]).toContain("\u001b[1mOllama · qwen\u001b[22m");
    expect(inputMessages[0]).not.toContain("e.g. fast");
  });

  test("blank alias input exits successfully without saving", async () => {
    let saves = 0;
    const app = dependencies({
      args: ["--input", "hello"],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({ choices: ["ollama", "qwen"], names: [""] }),
      saveAlias: async () => {
        saves += 1;
        return "saved";
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(saves).toBe(0);
  });

  test("waits for stdout to flush before opening the interactive boundary", async () => {
    const events: string[] = [];
    const app = dependencies({
      args: ["--input", "hello"],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({ choices: ["ollama", "qwen"], names: [""] }),
    });
    const stdout = {
      write(_chunk: string, callback?: (error?: Error | null) => void) {
        events.push("stdout queued");
        setTimeout(() => {
          events.push("stdout flushed");
          callback?.();
        }, 1);
      },
    };
    const stderr = {
      isTTY: true,
      write() {
        events.push("stderr boundary");
      },
    };

    expect(await runApplication({ ...app.value, stdout, stderr })).toBe(0);
    expect(events).toEqual(["stdout queued", "stdout flushed", "stderr boundary"]);
  });

  test("adds the interactive boundary without an alias field for a named selection", async () => {
    const inputMessages: string[] = [];
    const app = dependencies({
      args: ["--input", "hello"],
      stdin: input("", true),
      stderrTty: true,
      runtime: runtime({ response: "done\n" }),
      prompter: prompts({ choices: ["daily"], inputMessages }),
      loadAliases: async () => ({
        version: 1,
        aliases: { daily: { provider: "openai", model: "gpt-5" } },
      }),
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.stdout.text()).toBe("done\n");
    expect(app.stderr.text()).toBe("\u001b[0m\n");
    expect(inputMessages).toEqual([]);
  });

  test("reports a saved alias in green", async () => {
    const app = dependencies({
      args: ["--input", "hello", "--provider", "openai", "--model", "gpt-5"],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({ names: ["fast"] }),
      saveAlias: async () => "saved",
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.stdout.text()).toBe("response");
    expect(app.stderr.text()).toContain("\u001b[32m");
    expect(app.stderr.text()).toContain("Saved alias fast → OpenAI · gpt-5");
  });

  test("reports when the selected target is already saved under that name", async () => {
    const app = dependencies({
      args: ["--input", "hello", "--provider", "openai", "--model", "gpt-5"],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1" },
      prompter: prompts({ names: ["fast"] }),
      saveAlias: async () => "already-saved",
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.stderr.text()).toContain("◆ Already saved fast → OpenAI · gpt-5");
  });

  test("post-success invalid name and declined overwrite preserve exit zero", async () => {
    const savedNames: string[] = [];
    const confirmMessages: string[] = [];
    const confirmInitialValues: Array<boolean | undefined> = [];
    const app = dependencies({
      args: ["--input", "hello"],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1" },
      prompter: prompts({
        choices: ["ollama", "qwen"],
        confirms: [false],
        names: [" invalid", "daily"],
        confirmMessages,
        confirmInitialValues,
      }),
      saveAlias: async (_path, name, _selection, options) => {
        savedNames.push(name);
        expect(await options?.confirmOverwrite?.("daily", { provider: "ollama", model: "old" })).toBe(false);
        return "declined";
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.stdout.text()).toBe("response");
    expect(savedNames).toEqual(["daily"]);
    expect(app.stderr.text()).toContain("config: invalid alias name");
    expect(confirmMessages).toEqual([
      "Overwrite alias daily?\nOld: Ollama · old\nNew: Ollama · qwen",
    ]);
    expect(confirmInitialValues).toEqual([false]);
    expect(app.runtime.calls.generate).toBe(1);
  });

  test("returns an operational failure when alias persistence fails after generation", async () => {
    const app = dependencies({
      args: ["--input", "hello"],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({ choices: ["ollama", "qwen"], names: ["daily"] }),
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

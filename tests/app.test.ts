import { describe, expect, test } from "bun:test";
import {
  BYOK_API_KEY_ENV_VARS,
  type ByokProviderId,
} from "@swartzrock/byok-runtime";
import { AliasStoreError, type SaveAliasResult } from "../src/aliases.ts";
import { HELP_TEXT } from "../src/args.ts";
import { RuntimeStageError, type RuntimeGateway } from "../src/runtime.ts";
import { createRuntimeGateway } from "../src/runtime.ts";
import { runApplication, type ApplicationPrompter } from "../src/app.ts";
import {
  CredentialVaultError,
  createCredentialResolver,
  createSensitiveValueRegistry,
  type CredentialResolver,
  type CredentialVault,
  type SensitiveValueRegistry,
} from "../src/credentials.ts";
import {
  stripTerminalSequences,
  type PromptOption,
  type PromptValue,
} from "../src/prompts.ts";

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
  passwords?: Array<string | null>;
  seen?: Array<{ message: string; options: PromptOption[] }>;
  inputMessages?: string[];
  passwordMessages?: string[];
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
    password: async (message) => {
      options.passwordMessages?.push(message);
      return options.passwords?.shift() ?? null;
    },
  };
}

function runtime(options: {
  providers?: ByokProviderId[];
  response?: string;
  discover?: RuntimeGateway["discover"];
  listModels?: RuntimeGateway["listModels"];
  validateCredential?: RuntimeGateway["validateCredential"];
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
    validateCredential: async (provider, apiKey) => {
      if (options.validateCredential) return options.validateCredential(provider, apiKey);
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
  stdoutTty?: boolean;
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
  modelListTimeoutMs?: number;
  credentialVault?: CredentialVault;
  credentialResolver?: CredentialResolver;
  sensitive?: SensitiveValueRegistry;
  nativeVaultEnabled?: boolean;
}) {
  const stdout = output(options.stdoutTty ?? false);
  const stderr = output(options.stderrTty ?? false);
  const selectedRuntime = options.runtime ?? runtime();
  const credentialVault = options.credentialVault ?? {
    get: async () => null,
    set: async () => undefined,
    delete: async () => false,
  } satisfies CredentialVault;
  const sensitive = options.sensitive ?? createSensitiveValueRegistry();
  const credentialResolver = options.credentialResolver ?? createCredentialResolver({
    env: options.env ?? {},
    vault: credentialVault,
    vaultEnabled: true,
  });
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
      modelListTimeoutMs: options.modelListTimeoutMs,
      credentialVault,
      credentialResolver,
      sensitive,
      nativeVaultEnabled: options.nativeVaultEnabled ?? true,
    },
  };
}

describe("help output", () => {
  test("colors a capable stdout terminal and returns before aliases or runtime work", async () => {
    const app = dependencies({
      args: ["-h"],
      stdoutTty: true,
      loadAliases: async () => {
        throw new Error("help must not load aliases");
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.stdout.text()).toContain("\u001b[");
    expect(stripTerminalSequences(app.stdout.text())).toBe(`${HELP_TEXT}\n`);
    expect(app.stderr.text()).toBe("");
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 0 });
  });

  test("keeps non-TTY and capability-missing stdout byte-plain", async () => {
    const nonTty = dependencies({ args: ["--help"], stdoutTty: false });

    expect(await runApplication(nonTty.value)).toBe(0);
    expect(nonTty.stdout.text()).toBe(`${HELP_TEXT}\n`);
    expect(nonTty.stdout.text()).not.toContain("\u001b");
    expect(nonTty.stderr.text()).toBe("");
    expect(nonTty.runtime.calls).toEqual({ discover: 0, list: 0, generate: 0 });

    const missingCapability = dependencies({ args: ["--help"] });
    const { isTTY: _isTTY, ...stdoutWithoutTty } = missingCapability.stdout;

    expect(await runApplication({
      ...missingCapability.value,
      stdout: stdoutWithoutTty,
    })).toBe(0);
    expect(missingCapability.stdout.text()).toBe(`${HELP_TEXT}\n`);
    expect(missingCapability.stdout.text()).not.toContain("\u001b");
    expect(missingCapability.stderr.text()).toBe("");
    expect(missingCapability.runtime.calls).toEqual({ discover: 0, list: 0, generate: 0 });
  });

  test("uses only stdout capability and honors every help color suppression", async () => {
    const scenarios: Array<{
      name: string;
      stdoutTty: boolean;
      stderrTty: boolean;
      env: Record<string, string>;
    }> = [
      { name: "stderr-only TTY", stdoutTty: false, stderrTty: true, env: {} },
      { name: "NO_COLOR", stdoutTty: true, stderrTty: false, env: { NO_COLOR: "1" } },
      { name: "TERM=dumb", stdoutTty: true, stderrTty: false, env: { TERM: "dumb" } },
      {
        name: "FORCE_COLOR on non-TTY stdout",
        stdoutTty: false,
        stderrTty: false,
        env: { FORCE_COLOR: "1" },
      },
    ];

    for (const scenario of scenarios) {
      const app = dependencies({
        args: ["--help"],
        stdoutTty: scenario.stdoutTty,
        stderrTty: scenario.stderrTty,
        env: scenario.env,
      });

      expect(await runApplication(app.value), scenario.name).toBe(0);
      expect(app.stdout.text(), scenario.name).toBe(`${HELP_TEXT}\n`);
      expect(app.stdout.text(), scenario.name).not.toContain("\u001b");
      expect(app.stderr.text(), scenario.name).toBe("");
      expect(app.runtime.calls, scenario.name).toEqual({ discover: 0, list: 0, generate: 0 });
    }
  });

  test("keeps combined help as usage failure without rendering or runtime work", async () => {
    const app = dependencies({ args: ["--help", "--alias", "daily"], stdoutTty: true });

    expect(await runApplication(app.value)).toBe(2);
    expect(app.stdout.text()).toBe("");
    expect(app.stderr.text()).toBe(
      "usage: --help and --version must be used without other options.\n",
    );
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 0 });
  });
});

describe("one-shot application", () => {
  test("routes a bare TTY invocation into setup before reading generation input", async () => {
    const seen: Array<{ message: string; options: PromptOption[] }> = [];
    const stdin = {
      isTTY: true,
      async *[Symbol.asyncIterator]() {
        throw new Error("setup must not resolve a generation prompt");
      },
    };
    const app = dependencies({
      args: [],
      stdin,
      stderrTty: true,
      prompter: prompts({ choices: [null], seen }),
      loadAliases: async () => ({
        version: 1,
        aliases: { daily: { provider: "openai", model: "gpt-5" } },
      }),
      runtime: runtime({ providers: ["ollama", "codex-cli"] }),
    });

    expect(await runApplication(app.value)).toBe(130);
    expect(app.stdout.text()).toBe("");
    expect(app.runtime.calls.generate).toBe(0);
    expect(app.runtime.calls.discover).toBe(0);
    expect(seen[0]?.message).toBe("What would you like to set up?");
    expect(seen[0]?.options.map(({ label }) => label)).toEqual([
      "daily",
      "Discover available providers…",
      "Add or manage API keys…",
    ]);
  });

  test("runs provider discovery only after the explicit setup choice", async () => {
    const seen: Array<{ message: string; options: PromptOption[] }> = [];
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({ choices: ["setup:discover-providers", "ollama"], seen }),
      runtime: runtime({ providers: ["ollama", "codex-cli"] }),
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.runtime.calls).toEqual({ discover: 1, list: 0, generate: 0 });
    expect(seen[1]?.message).toBe("Choose an available provider");
    expect(seen[1]?.options.map(({ label }) => label)).toEqual(["Codex CLI", "Ollama"]);
    expect(app.stderr.text()).toContain("Provider Ollama is available");
  });

  test("uses the static cloud catalog for API-key management and cancels without validation", async () => {
    const seen: Array<{ message: string; options: PromptOption[] }> = [];
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({ choices: ["setup:manage-api-keys", null], seen }),
      runtime: runtime({ providers: [] }),
    });

    expect(await runApplication(app.value)).toBe(130);
    expect(app.stdout.text()).toBe("");
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 0 });
    expect(seen[1]?.options.map(({ value }) => value)).toEqual([
      "anthropic",
      "deepinfra",
      "deepseek",
      "google",
      "groq",
      "mistral",
      "openai",
      "openrouter",
      "xai",
    ]);
  });

  test("rejects invalid hidden candidates without echoing or validating them", async () => {
    const invalid = " u3-secret-sentinel ";
    const passwordMessages: string[] = [];
    let validations = 0;
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({
        choices: ["setup:manage-api-keys", "openai"],
        passwords: [invalid, null],
        passwordMessages,
      }),
      runtime: runtime({
        providers: [],
        validateCredential: async () => {
          validations += 1;
          return [];
        },
      }),
    });

    expect(await runApplication(app.value)).toBe(130);
    expect(validations).toBe(0);
    expect(app.stdout.text()).toBe("");
    expect(app.stderr.text()).not.toContain(invalid);
    expect(app.stderr.text()).not.toContain(invalid.trim());
    expect(passwordMessages.every((message) => !message.includes(invalid.trim()))).toBe(true);
  });

  test("validates the exact hidden candidate while keeping setup stderr-only and secret-free", async () => {
    const candidate = "u3-valid-hidden-sentinel";
    const passwordMessages: string[] = [];
    const validated: string[] = [];
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({
        choices: ["setup:manage-api-keys", "openai"],
        passwords: [candidate],
        confirms: [true],
        passwordMessages,
      }),
      runtime: runtime({
        providers: [],
        validateCredential: async (_provider, apiKey) => {
          validated.push(apiKey);
          return [];
        },
      }),
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(validated).toEqual([candidate]);
    expect(app.stdout.text()).toBe("");
    expect(app.stderr.text()).toContain("Saved the OpenAI API key");
    expect(`${app.stdout.text()}${app.stderr.text()}${passwordMessages.join("\n")}`).not.toContain(
      candidate,
    );
  });

  test("adds bare setup guidance only to interactive missing-credential failures", async () => {
    const failure = new RuntimeStageError(
      "generation",
      "openai",
      "missing credential; set OPENAI_API_KEY",
    );
    const interactive = dependencies({
      args: ["--input", "hello", "--provider", "openai", "--model", "gpt"],
      stdin: input("", true),
      stderrTty: true,
      runtime: runtime({ generate: async () => { throw failure; } }),
    });
    expect(await runApplication(interactive.value)).toBe(1);
    expect(interactive.stderr.text()).toContain("set OPENAI_API_KEY");
    expect(interactive.stderr.text()).toContain("Run llm-now with no arguments");

    const headless = dependencies({
      args: ["--input", "hello", "--provider", "openai", "--model", "gpt"],
      runtime: runtime({ generate: async () => { throw failure; } }),
    });
    expect(await runApplication(headless.value)).toBe(1);
    expect(headless.stderr.text()).toContain("set OPENAI_API_KEY");
    expect(headless.stderr.text()).not.toContain("no arguments");
  });

  test("keeps --input and piped stdin on generation instead of setup", async () => {
    const explicit = dependencies({
      args: ["--input", "flag prompt", "--provider", "ollama", "--model", "qwen"],
      stdin: input("", true),
      stderrTty: true,
    });
    expect(await runApplication(explicit.value)).toBe(0);
    expect(explicit.runtime.calls.generate).toBe(1);

    const piped = dependencies({
      args: ["daily"],
      stdin: input("piped prompt"),
      resolveAlias: async () => ({ provider: "ollama", model: "qwen" }),
    });
    expect(await runApplication(piped.value)).toBe(0);
    expect(piped.runtime.calls.generate).toBe(1);
  });

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
      "◆ Ollama · qwen is already saved as alias Daily\n"
      + "  Next time, use llm-now Daily --input \"<prompt>\"\n",
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
      + "  Next time, use llm-now quick --input \"<prompt>\"\n",
    );
  });

  test("renders the existing-alias command in white", async () => {
    const app = dependencies({
      args: ["--input", "hello"],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({ choices: [false, "ollama", "qwen"] }),
      loadAliases: async () => ({
        version: 1,
        aliases: { Daily: { provider: "ollama", model: "qwen" } },
      }),
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.stderr.text()).toContain(
      "\u001b[37mllm-now Daily --input \"<prompt>\"\u001b[39m",
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

  test("positional and long-form aliases have exact application parity", async () => {
    const results = [];
    for (const args of [
      ["Daily", "--input", "hello"],
      ["--input", "hello", "--alias", "Daily"],
    ]) {
      const calls: string[] = [];
      const app = dependencies({
        args,
        runtime: runtime({
          generate: async (provider, model, prompt) => {
            calls.push(`${provider}:${model}:${prompt}`);
            return "alias-result";
          },
        }),
        resolveAlias: async (_path, name) => {
          calls.push(`resolve:${name}`);
          return { provider: "claude-cli", model: null };
        },
      });

      results.push({
        exitCode: await runApplication(app.value),
        stdout: app.stdout.text(),
        stderr: app.stderr.text(),
        runtimeCalls: app.runtime.calls,
        calls,
      });
    }

    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toEqual({
      exitCode: 0,
      stdout: "alias-result",
      stderr: "",
      runtimeCalls: { discover: 0, list: 0, generate: 1 },
      calls: ["resolve:Daily", "claude-cli:null:hello"],
    });
  });

  test("piped input works with a positional alias", async () => {
    const app = dependencies({
      args: ["Daily"],
      stdin: input("piped prompt"),
      runtime: runtime({
        generate: async (_provider, _model, prompt) => {
          expect(prompt).toBe("piped prompt");
          return "alias-result";
        },
      }),
      resolveAlias: async (_path, name) => {
        expect(name).toBe("Daily");
        return { provider: "claude-cli", model: null };
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.stdout.text()).toBe("alias-result");
    expect(app.stderr.text()).toBe("");
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 1 });
  });

  test("positional aliases preserve exact fail-closed parity with long form", async () => {
    const scenarios = [
      { kind: "store", alias: "missing", message: "alias not found: missing" },
      { kind: "store", alias: "bad name", message: "invalid alias name: bad name" },
      { kind: "store", alias: "corrupt", message: "failed to load alias store: corrupt JSON" },
      { kind: "stale", alias: "stale", message: "generation (ollama): unavailable" },
    ] as const;

    async function runAliasFailure(
      args: string[],
      scenario: (typeof scenarios)[number],
    ) {
      const calls: string[] = [];
      const app = dependencies({
        args,
        runtime: runtime({
          generate: async (provider, model, prompt) => {
            calls.push(`generate:${provider}:${model}:${prompt}`);
            throw new RuntimeStageError("generation", provider, "unavailable");
          },
        }),
        resolveAlias: async (path, name) => {
          calls.push(`resolve:${path}:${name}`);
          if (scenario.kind === "store") throw new AliasStoreError(scenario.message);
          return { provider: "ollama", model: "missing" };
        },
      });

      return {
        exitCode: await runApplication(app.value),
        stdout: app.stdout.text(),
        stderr: app.stderr.text(),
        runtimeCalls: app.runtime.calls,
        calls,
      };
    }

    for (const scenario of scenarios) {
      const positional = await runAliasFailure(
        [scenario.alias, "--input", "hello"],
        scenario,
      );
      const longForm = await runAliasFailure(
        ["--input", "hello", "--alias", scenario.alias],
        scenario,
      );

      expect(positional).toEqual(longForm);
      expect(positional).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: `${scenario.kind === "store" ? "config: " : ""}${scenario.message}\n`,
        runtimeCalls: {
          discover: 0,
          list: 0,
          generate: scenario.kind === "stale" ? 1 : 0,
        },
        calls: scenario.kind === "stale"
          ? [
            `resolve:/config/aliases.json:${scenario.alias}`,
            "generate:ollama:missing:hello",
          ]
          : [`resolve:/config/aliases.json:${scenario.alias}`],
      });
    }
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
    const credentials = BYOK_API_KEY_ENV_VARS.map((name, index) => ({
      name,
      secret: `${name}-secret-${index}`,
    }));
    const secrets = credentials.map(({ secret }) => secret);
    const env = Object.fromEntries(
      credentials.map(({ name, secret }) => [name, secret]),
    );
    const hostile = `bad\r\n\u001b[31m${secrets.join(" ")}\u0000${"x".repeat(2_000)}`;
    const app = dependencies({
      args: ["--input", "hello", "--provider", "openai", "--model", "gpt"],
      env,
      runtime: runtime({
        generate: async () => {
          throw new RuntimeStageError("generation", "openai", hostile);
        },
      }),
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(app.stdout.text()).toBe("");
    for (const secret of secrets) expect(app.stderr.text()).not.toContain(secret);
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

  test("does not put a synthetic timeout around discovery that may read the native vault", async () => {
    const discovery = dependencies({
      args: ["--input", "hello"],
      stdin: input("", true),
      stderrTty: true,
      runtime: runtime({
        discover: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return ["ollama"];
        },
      }),
      prompter: prompts({ choices: ["ollama", "qwen"], names: [""] }),
    });
    expect(await runApplication(discovery.value)).toBe(0);
  });

  test("bounds model-list stages", async () => {
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

  test("reports a saved alias with the alias and next-time command in white", async () => {
    const app = dependencies({
      args: ["--input", "hello", "--provider", "openai", "--model", "gpt-5"],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({ names: ["fast"] }),
      saveAlias: async () => "saved",
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.stdout.text()).toBe("response");
    expect(app.stderr.text()).toContain(
      "\u001b[32m◆ Saved alias \u001b[39m\u001b[37mfast\u001b[39m",
    );
    expect(app.stderr.text()).toContain(
      "\u001b[32m → OpenAI · gpt-5\n  Next time, use \u001b[39m"
      + "\u001b[37mllm-now fast --input \"<prompt>\"\u001b[39m",
    );
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

describe("API-key management", () => {
  function vaultFixture(
    initial: string | null = null,
    options: { getError?: Error; setError?: Error; deleteError?: Error } = {},
    events: string[] = [],
  ) {
    let stored = initial;
    const vault: CredentialVault = {
      async get(provider) {
        events.push(`get:${provider}`);
        if (options.getError) throw options.getError;
        return stored;
      },
      async set(provider, value) {
        events.push(`set:${provider}`);
        if (options.setError) throw options.setError;
        stored = value;
      },
      async delete(provider) {
        events.push(`delete:${provider}`);
        if (options.deleteError) throw options.deleteError;
        const existed = stored !== null;
        stored = null;
        return existed;
      },
    };
    return { vault, events, stored: () => stored };
  }

  function management(options: {
    initial?: string | null;
    getError?: Error;
    setError?: Error;
    deleteError?: Error;
    env?: Record<string, string>;
    prompter: ApplicationPrompter;
    runtime?: ReturnType<typeof runtime>;
    saveAlias?: Parameters<typeof dependencies>[0]["saveAlias"];
    loadAliases?: Parameters<typeof dependencies>[0]["loadAliases"];
    enabled?: boolean;
    events?: string[];
  }) {
    const fixture = vaultFixture(
      options.initial ?? null,
      {
        getError: options.getError,
        setError: options.setError,
        deleteError: options.deleteError,
      },
      options.events,
    );
    const sensitive = createSensitiveValueRegistry();
    const resolver = createCredentialResolver({
      env: options.env ?? {},
      vault: fixture.vault,
      vaultEnabled: true,
    });
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      env: options.env,
      prompter: options.prompter,
      runtime: options.runtime,
      saveAlias: options.saveAlias,
      loadAliases: options.loadAliases,
      credentialVault: fixture.vault,
      credentialResolver: resolver,
      sensitive,
      nativeVaultEnabled: options.enabled ?? true,
    });
    return { ...app, ...fixture, sensitive, resolver };
  }

  test("validates before one provider-scoped write, invalidates, and keeps all sentinels secret", async () => {
    const candidate = "u4-add-candidate-sentinel";
    const events: string[] = [];
    const seen: Array<{ message: string; options: PromptOption[] }> = [];
    const confirmInitialValues: Array<boolean | undefined> = [];
    const app = management({
      events,
      prompter: prompts({
        choices: ["setup:manage-api-keys", "openai", "gpt-5"],
        passwords: [candidate],
        names: ["fast"],
        confirms: [true],
        seen,
        confirmInitialValues,
      }),
      runtime: runtime({
        providers: [],
        validateCredential: async (_provider, value) => {
          events.push(`validate:${value}`);
          return [{ id: "gpt-5", label: "GPT-5" }];
        },
      }),
      saveAlias: async (_path, name, selection) => {
        events.push(`alias:${name}:${selection.provider}:${selection.model}`);
        expect(Object.keys(selection).sort()).toEqual(["model", "provider"]);
        expect(JSON.stringify(selection)).not.toContain(candidate);
        return "saved";
      },
    });
    const invalidations: string[] = [];
    const invalidate = app.resolver.invalidate?.bind(app.resolver);
    app.resolver.invalidate = (provider) => {
      invalidations.push(provider);
      invalidate?.(provider);
    };

    expect(await runApplication(app.value)).toBe(0);
    expect(events).toEqual([
      "get:openai",
      `validate:${candidate}`,
      "set:openai",
      "alias:fast:openai:gpt-5",
    ]);
    expect(app.events.filter((event) => event === "set:openai")).toHaveLength(1);
    expect(invalidations).toEqual(["openai"]);
    expect(confirmInitialValues).toEqual([false]);
    expect(app.stored()).toBe(candidate);
    const visible = `${app.stdout.text()}${app.stderr.text()}${seen.flatMap((item) => [item.message, ...item.options.map((option) => `${option.label}${option.hint ?? ""}`)]).join("\n")}`;
    expect(visible).not.toContain(candidate);
    expect(app.stdout.text()).toBe("");
  });

  test("redacts hostile model metadata and refuses credential-bearing alias data", async () => {
    const candidate = "u4-hostile-model-sentinel";
    const seen: Array<{ message: string; options: PromptOption[] }> = [];
    let saved: { name: string; model: string | null } | undefined;
    const app = management({
      prompter: prompts({
        choices: ["setup:manage-api-keys", "openai", "safe-model"],
        passwords: [candidate],
        names: [candidate, "safe-alias"],
        confirms: [true],
        seen,
      }),
      runtime: runtime({
        providers: [],
        validateCredential: async () => [
          { id: candidate, label: "Unsafe" },
          { id: "unsafe\nmodel", label: "Unsafe control model" },
          { id: "safe-model", label: `Safe ${candidate}` },
        ],
      }),
      saveAlias: async (_path, name, selection) => {
        saved = { name, model: selection.model };
        return "saved";
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(saved).toEqual({ name: "safe-alias", model: "safe-model" });
    const visible = `${app.stdout.text()}${app.stderr.text()}${JSON.stringify(seen)}`;
    expect(visible).not.toContain(candidate);
    expect(visible).toContain("[REDACTED]");
    expect(seen.flatMap((item) => item.options).some((option) => option.value === "unsafe\nmodel")).toBe(false);
    expect(JSON.stringify(saved)).not.toContain(candidate);
  });

  test("redacts credential values embedded in existing alias targets", async () => {
    const envSecret = "u4-existing-alias-env-sentinel";
    const seen: Array<{ message: string; options: PromptOption[] }> = [];
    const app = management({
      env: { OPENAI_API_KEY: envSecret },
      prompter: prompts({ choices: [null], seen }),
      loadAliases: async () => ({
        version: 1,
        aliases: { unsafe: { provider: "openai", model: `model-${envSecret}` } },
      }),
    });

    expect(await runApplication(app.value)).toBe(130);
    expect(JSON.stringify(seen)).not.toContain(envSecret);
    expect(JSON.stringify(seen)).toContain("[REDACTED]");
  });

  test("invalid candidate and validation failure perform zero writes and preserve an old record", async () => {
    const invalid = management({
      prompter: prompts({
        choices: ["setup:manage-api-keys", "openai"],
        passwords: [" bad-secret ", null],
      }),
      runtime: runtime({ providers: [] }),
    });
    expect(await runApplication(invalid.value)).toBe(130);
    expect(invalid.events).toEqual(["get:openai"]);

    const old = "u4-old-validation-sentinel";
    const candidate = "u4-invalid-provider-sentinel";
    const failed = management({
      initial: old,
      prompter: prompts({
        choices: ["setup:manage-api-keys", "openai", "replace"],
        confirms: [true],
        passwords: [candidate],
      }),
      runtime: runtime({
        providers: [],
        validateCredential: async () => { throw new Error(`rejected ${candidate}`); },
      }),
    });
    expect(await runApplication(failed.value)).toBe(1);
    expect(failed.stored()).toBe(old);
    expect(failed.events).toEqual(["get:openai"]);
    expect(failed.stderr.text()).not.toContain(old);
    expect(failed.stderr.text()).not.toContain(candidate);
  });

  test("declining replacement intent requests no password, while set failure preserves the old key", async () => {
    const passwordMessages: string[] = [];
    const declined = management({
      initial: "u4-old-decline-sentinel",
      prompter: prompts({
        choices: ["setup:manage-api-keys", "openai", "replace"],
        confirms: [false],
        passwordMessages,
      }),
      runtime: runtime({ providers: [] }),
    });
    expect(await runApplication(declined.value)).toBe(0);
    expect(passwordMessages).toEqual([]);
    expect(declined.events).toEqual(["get:openai"]);

    const old = "u4-old-set-failure-sentinel";
    const replacement = "u4-replacement-set-failure-sentinel";
    const failed = management({
      initial: old,
      setError: new CredentialVaultError(
        "set",
        "openai",
        new Error(`backend included ${replacement}`),
      ),
      prompter: prompts({
        choices: ["setup:manage-api-keys", "openai", "replace", "qwen"],
        confirms: [true, true],
        passwords: [replacement],
        names: [""],
      }),
      runtime: runtime({ providers: [] }),
    });
    expect(await runApplication(failed.value)).toBe(1);
    expect(failed.stored()).toBe(old);
    expect(failed.events).toEqual(["get:openai", "set:openai"]);
    expect(failed.stderr.text()).toContain(
      "Secure API-key storage isn’t available in this Linux session.",
    );
    expect(failed.stderr.text()).toContain(
      "llm-now couldn’t save the API key securely.",
    );
    expect(failed.stderr.text()).toContain("Use a key now (not saved by llm-now):");
    expect(failed.stderr.text()).toContain("To save API keys securely:");
    expect(failed.stderr.text()).not.toContain(
      "credential vault set (openai): unavailable",
    );
    expect(failed.stderr.text()).toContain("OPENAI_API_KEY");
    expect(failed.stderr.text()).toContain("Secret Service");
    expect(failed.stderr.text()).not.toContain(old);
    expect(failed.stderr.text()).not.toContain(replacement);
  });

  test("offers safe Linux remediation when the credential vault is unavailable", async () => {
    const backendDetail = "cannot open display: vault-backend-detail";
    const app = management({
      getError: new CredentialVaultError(
        "get",
        "openrouter",
        new Error(backendDetail),
      ),
      prompter: prompts({ choices: ["setup:manage-api-keys", "openrouter"] }),
      runtime: runtime({ providers: [] }),
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(app.events).toEqual(["get:openrouter"]);
    expect(app.stderr.text()).toContain(
      "Secure API-key storage isn’t available in this Linux session.",
    );
    expect(app.stderr.text()).toContain(
      "llm-now couldn’t access the saved API key.",
    );
    expect(app.stderr.text()).toContain("Use a key now (not saved by llm-now):");
    expect(app.stderr.text()).toContain("OPENROUTER_API_KEY");
    expect(app.stderr.text()).toContain(
      "read -r -s OPENROUTER_API_KEY && export OPENROUTER_API_KEY",
    );
    expect(app.stderr.text()).toContain("Secret Service");
    expect(app.stderr.text()).toContain("GNOME Keyring");
    expect(app.stderr.text()).toContain("user session");
    expect(app.stderr.text()).toContain("Then retry your command in this shell.");
    expect(app.stderr.text()).toContain("To save API keys securely:");
    expect(app.stderr.text()).toContain("retry the command that failed");
    expect(app.stderr.text()).not.toContain(
      "credential vault get (openrouter): unavailable",
    );
    expect(app.stderr.text()).not.toContain("OPENROUTER_API_KEY=");
    expect(app.stderr.text()).not.toContain(backendDetail);
  });

  test("preserves vault remediation through the production runtime boundary", async () => {
    const backendDetail = "runtime vault-backend-detail";
    const sensitive = createSensitiveValueRegistry();
    const gateway = createRuntimeGateway({
      env: {},
      credentialResolver: {
        resolve: async (provider) => {
          throw new CredentialVaultError(
            "get",
            provider,
            new Error(backendDetail),
          );
        },
      },
      sensitive,
      createProvider: () => {
        throw new Error("provider construction must not run");
      },
    });
    const app = dependencies({
      args: [
        "--input",
        "hello",
        "--provider",
        "openrouter",
        "--model",
        "qwen/qwen3-32b",
      ],
      runtime: {
        value: gateway,
        calls: { discover: 0, list: 0, generate: 0 },
      },
      sensitive,
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(app.stderr.text()).toContain(
      "Secure API-key storage isn’t available in this Linux session.",
    );
    expect(app.stderr.text()).toContain(
      "llm-now couldn’t access the saved API key.",
    );
    expect(app.stderr.text()).toContain("OPENROUTER_API_KEY");
    expect(app.stderr.text()).toContain("Secret Service");
    expect(app.stderr.text()).not.toContain(backendDetail);
  });

  test("uses careful Linux recovery copy when saved-key removal fails", async () => {
    const backendDetail = "delete vault-backend-detail";
    const app = management({
      initial: "u4-delete-failure-sentinel",
      deleteError: new CredentialVaultError(
        "delete",
        "openai",
        new Error(backendDetail),
      ),
      prompter: prompts({
        choices: ["setup:manage-api-keys", "openai", "delete"],
        confirms: [true],
      }),
      runtime: runtime({ providers: [] }),
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(app.events).toEqual(["get:openai", "delete:openai"]);
    expect(app.stderr.text()).toContain(
      "Secure API-key storage isn’t available in this Linux session.",
    );
    expect(app.stderr.text()).toContain(
      "llm-now couldn’t complete removal of the saved API key.",
    );
    expect(app.stderr.text()).toContain("OPENAI_API_KEY");
    expect(app.stderr.text()).not.toContain(
      "credential vault delete (openai): unavailable",
    );
    expect(app.stderr.text()).not.toContain(backendDetail);
    expect(app.stderr.text()).not.toContain("No Linux Secret Service provider found");
    expect(app.stderr.text()).not.toContain("no key was saved or changed");
  });

  test("successfully replaces once, invalidates once, and never exposes either credential", async () => {
    const old = "u4-old-success-sentinel";
    const replacement = "u4-new-success-sentinel";
    const app = management({
      initial: old,
      prompter: prompts({
        choices: ["setup:manage-api-keys", "openai", "replace", "qwen"],
        confirms: [true, true],
        passwords: [replacement],
        names: [""],
      }),
      runtime: runtime({ providers: [] }),
    });
    const invalidations: string[] = [];
    app.resolver.invalidate = (provider) => { invalidations.push(provider); };

    expect(await runApplication(app.value)).toBe(0);
    expect(app.events).toEqual(["get:openai", "set:openai"]);
    expect(app.stored()).toBe(replacement);
    expect(invalidations).toEqual(["openai"]);
    expect(`${app.stdout.text()}${app.stderr.text()}`).not.toContain(old);
    expect(`${app.stdout.text()}${app.stderr.text()}`).not.toContain(replacement);
  });

  test("cancellation at operation and replacement/delete consent mutates nothing", async () => {
    const scenarios = [
      { choices: ["setup:manage-api-keys", "openai", null], confirms: [] },
      { choices: ["setup:manage-api-keys", "openai", "replace"], confirms: [null] },
      { choices: ["setup:manage-api-keys", "openai", "delete"], confirms: [null] },
    ] as const;
    for (const scenario of scenarios) {
      const app = management({
        initial: "u4-cancel-old-sentinel",
        prompter: prompts({
          choices: [...scenario.choices],
          confirms: [...scenario.confirms],
        }),
        runtime: runtime({ providers: [] }),
      });
      expect(await runApplication(app.value)).toBe(130);
      expect(app.events).toEqual(["get:openai"]);
      expect(app.stored()).toBe("u4-cancel-old-sentinel");
    }
  });

  test("final save decline and cancellation mutate nothing", async () => {
    for (const decision of [false, null] as const) {
      const app = management({
        prompter: prompts({
          choices: ["setup:manage-api-keys", "openai", "qwen"],
          passwords: ["u4-final-decision-sentinel"],
          names: [""],
          confirms: [decision],
        }),
        runtime: runtime({ providers: [] }),
      });
      expect(await runApplication(app.value)).toBe(decision === null ? 130 : 0);
      expect(app.events).toEqual(["get:openai"]);
      expect(app.stored()).toBeNull();
    }
  });

  test("cancelling optional alias decisions returns 130 before credential commit", async () => {
    const candidate = "u4-alias-cancel-sentinel";
    const cases = [
      {
        prompter: prompts({
          choices: ["setup:manage-api-keys", "openai", null],
          passwords: [candidate],
        }),
      },
      {
        prompter: prompts({
          choices: ["setup:manage-api-keys", "openai", "qwen"],
          passwords: [candidate],
          names: [null],
        }),
      },
      {
        prompter: prompts({
          choices: ["setup:manage-api-keys", "openai", "qwen"],
          passwords: [candidate],
          names: ["fast"],
          confirms: [null],
        }),
        loadAliases: async () => ({
          version: 1 as const,
          aliases: { fast: { provider: "openai" as const, model: "old-model" } },
        }),
      },
    ];

    for (const testCase of cases) {
      const app = management({
        prompter: testCase.prompter,
        loadAliases: testCase.loadAliases,
        runtime: runtime({ providers: [] }),
      });
      expect(await runApplication(app.value)).toBe(130);
      expect(app.events).toEqual(["get:openai"]);
      expect(app.stored()).toBeNull();
    }
  });

  test("an empty model list is authentication success and saves without alias prompts", async () => {
    const inputMessages: string[] = [];
    let aliasSaves = 0;
    const app = management({
      prompter: prompts({
        choices: ["setup:manage-api-keys", "openai"],
        passwords: ["u4-empty-model-sentinel"],
        confirms: [true],
        inputMessages,
      }),
      runtime: runtime({
        providers: [],
        validateCredential: async () => [],
      }),
      saveAlias: async () => {
        aliasSaves += 1;
        return "saved";
      },
    });
    expect(await runApplication(app.value)).toBe(0);
    expect(app.events).toEqual(["get:openai", "set:openai"]);
    expect(inputMessages).toEqual([]);
    expect(aliasSaves).toBe(0);
    expect(app.stderr.text()).toContain("returned no models");
  });

  test("delete is default-No, provider-scoped, idempotent, invalidates, and explains env precedence", async () => {
    const initialValues: Array<boolean | undefined> = [];
    const declined = management({
      initial: "u4-delete-decline-sentinel",
      prompter: prompts({
        choices: ["setup:manage-api-keys", "openai", "delete"],
        confirms: [false],
        confirmInitialValues: initialValues,
      }),
      runtime: runtime({ providers: [] }),
    });
    expect(await runApplication(declined.value)).toBe(0);
    expect(declined.events).toEqual(["get:openai"]);
    expect(initialValues).toEqual([false]);

    const env = { OPENAI_API_KEY: "u4-env-delete-sentinel" };
    const deleted = management({
      initial: "u4-delete-stored-sentinel",
      env,
      prompter: prompts({
        choices: ["setup:manage-api-keys", "openai", "delete"],
        confirms: [true],
      }),
      runtime: runtime({ providers: [] }),
    });
    const invalidations: string[] = [];
    deleted.resolver.invalidate = (provider) => { invalidations.push(provider); };
    expect(await runApplication(deleted.value)).toBe(0);
    expect(deleted.events).toEqual(["get:openai", "delete:openai"]);
    expect(invalidations).toEqual(["openai"]);
    expect(deleted.stderr.text()).toContain("OPENAI_API_KEY");
    expect(deleted.stderr.text()).toContain("continues to be available");
    expect(deleted.stderr.text()).not.toContain(env.OPENAI_API_KEY);

    let deleteCalls = 0;
    deleted.value.credentialVault = {
      get: async () => "stored",
      set: async () => undefined,
      delete: async () => { deleteCalls += 1; return false; },
    };
    deleted.value.prompter = prompts({
      choices: ["setup:manage-api-keys", "openai", "delete"],
      confirms: [true],
    });
    expect(await runApplication(deleted.value)).toBe(0);
    expect(deleteCalls).toBe(1);
    expect(deleted.stderr.text()).toContain("already absent");
  });

  test("post-commit alias failure retains the key, reports partial success, and performs no prompt afterward", async () => {
    const candidate = "u4-partial-success-sentinel";
    const promptEvents: string[] = [];
    const base = prompts({
      choices: ["setup:manage-api-keys", "openai", "qwen"],
      passwords: [candidate],
      names: ["fast"],
      confirms: [true],
    });
    const wrapped: ApplicationPrompter = {
      select: async (...args) => { promptEvents.push("select"); return base.select(...args); },
      input: async (...args) => { promptEvents.push("input"); return base.input(...args); },
      password: async (...args) => { promptEvents.push("password"); return base.password(...args); },
      confirm: async (...args) => { promptEvents.push("confirm"); return base.confirm(...args); },
    };
    const app = management({
      prompter: wrapped,
      runtime: runtime({ providers: [] }),
      saveAlias: async () => {
        promptEvents.push("alias-write");
        throw new Error(`disk rejected ${candidate}`);
      },
    });
    expect(await runApplication(app.value)).toBe(1);
    expect(app.stored()).toBe(candidate);
    expect(promptEvents.at(-1)).toBe("alias-write");
    expect(app.stderr.text()).toContain("API key was saved");
    expect(app.stderr.text()).toContain("alias was not saved");
    expect(app.stderr.text()).not.toContain(candidate);
  });

  test("preflights alias overwrite before final consent and reuses that decision without a post-commit prompt", async () => {
    const confirmMessages: string[] = [];
    const app = management({
      prompter: prompts({
        choices: ["setup:manage-api-keys", "openai", "qwen"],
        passwords: ["u4-alias-preflight-sentinel"],
        names: ["fast"],
        confirms: [true, true],
        confirmMessages,
      }),
      runtime: runtime({ providers: [] }),
      loadAliases: async () => ({
        version: 1,
        aliases: { fast: { provider: "openai", model: "old-model" } },
      }),
      saveAlias: async (_path, _name, _selection, options) => {
        expect(await options?.confirmOverwrite?.(
          "fast",
          { provider: "openai", model: "old-model" },
        )).toBe(true);
        return "saved";
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(confirmMessages).toHaveLength(2);
    expect(confirmMessages[0]).toContain("Overwrite alias fast?");
    expect(confirmMessages[1]).toContain("Save this verified OpenAI API key and alias fast?");
    expect(app.events).toEqual(["get:openai", "set:openai"]);
  });

  test("disabled target returns environment-only guidance without reading the vault", async () => {
    const app = management({
      enabled: false,
      prompter: prompts({ choices: ["setup:manage-api-keys", "openai"] }),
      runtime: runtime({ providers: [] }),
    });
    expect(await runApplication(app.value)).toBe(1);
    expect(app.events).toEqual([]);
    expect(app.stderr.text()).toContain("native credential storage unavailable");
    expect(app.stderr.text()).toContain("OPENAI_API_KEY");
  });

  test("integrates one shared vault, resolver, and redaction registry through runApplication", async () => {
    const candidate = "u4-real-boundary-sentinel";
    const fixture = vaultFixture();
    const sensitive = createSensitiveValueRegistry();
    const resolver = createCredentialResolver({ env: {}, vault: fixture.vault, vaultEnabled: true });
    const gateway = createRuntimeGateway({
      env: {},
      credentialResolver: resolver,
      sensitive,
      findProviders: async () => [],
      createProvider: (config) => ({
        id: config.provider,
        label: "Fake",
        requiresNetwork: true,
        requiresDownload: false,
        async testConnection() { return { ok: true, message: "ok" }; },
        async listModels() {
          if (!("apiKey" in config) || config.apiKey !== candidate) {
            throw new Error(`wrong candidate ${candidate}`);
          }
          return [{ id: "gpt-5", label: "GPT-5" }];
        },
        async generateText() { return { text: "unused" }; },
      }),
    });
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      runtime: { value: gateway, calls: { discover: 0, list: 0, generate: 0 } },
      prompter: prompts({
        choices: ["setup:manage-api-keys", "openai", "gpt-5"],
        passwords: [candidate],
        names: [""],
        confirms: [true],
      }),
      credentialVault: fixture.vault,
      credentialResolver: resolver,
      sensitive,
      nativeVaultEnabled: true,
    });
    expect(await runApplication(app.value)).toBe(0);
    expect(fixture.stored()).toBe(candidate);
    expect(`${app.stdout.text()}${app.stderr.text()}`).not.toContain(candidate);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  BYOK_API_KEY_ENV_VARS,
  type ByokProviderId,
} from "@swartzrock/byok-runtime";
import pc from "picocolors";
import {
  AliasStoreError,
  type AliasRecord,
  type AliasDocument,
  type SaveAliasResult,
} from "../src/aliases.ts";
import { renderHelpText } from "../src/args.ts";
import { resolveInputSource } from "../src/io.ts";
import { RuntimeStageError, type RuntimeGateway } from "../src/runtime.ts";
import { createRuntimeGateway } from "../src/runtime.ts";
import { runApplication, type ApplicationPrompter } from "../src/app.ts";
import {
  CredentialVaultError,
  createCredentialResolver,
  createSensitiveValueRegistry,
  type CredentialMutationLock,
  type CredentialResolver,
  type CredentialVault,
  type SensitiveValueRegistry,
} from "../src/credentials.ts";
import {
  CLOUD_CREDENTIAL_PROVIDERS,
  stripTerminalSequences,
  type PromptOption,
  type TextPromptOptions,
  type PromptValue,
} from "../src/prompts.ts";

const temporaryDirectories: string[] = [];
const conflictingAliasDocument = JSON.stringify({
  version: 1,
  aliases: {
    Fred: { provider: "openai", model: "gpt-5" },
    FRED: { provider: "ollama", model: "qwen" },
  },
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(process.cwd(), ".tmp-app-aliases-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

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
  instructions?: Array<string | null>;
  passwords?: Array<string | null>;
  seen?: Array<{ message: string; options: PromptOption[] }>;
  inputMessages?: string[];
  inputOptions?: TextPromptOptions[];
  instructionMessages?: string[];
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
    input: async (message, promptOptions = {}) => {
      options.inputMessages?.push(message);
      options.inputOptions?.push(promptOptions);
      return options.names?.shift() ?? null;
    },
    instruction: async (message) => {
      options.instructionMessages?.push(message);
      const answer = options.instructions?.shift();
      return answer === undefined ? "" : answer;
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
    version: 1 | 2;
    aliases: Record<string, AliasRecord>;
  }>;
  resolveAlias?: (path: string, name: string) => Promise<AliasRecord>;
  saveAlias?: (...args: Parameters<NonNullable<Parameters<typeof runApplication>[0]["saveAlias"]>>) => Promise<SaveAliasResult>;
  generationTimeoutMs?: number;
  modelListTimeoutMs?: number;
  credentialVault?: CredentialVault;
  credentialResolver?: CredentialResolver;
  sensitive?: SensitiveValueRegistry;
  nativeVaultEnabled?: boolean;
  platform?: NodeJS.Platform;
  home?: string;
  aliasPath?: string;
  credentialMutationLock?: CredentialMutationLock;
  runVoice?: NonNullable<Parameters<typeof runApplication>[0]["runVoice"]>;
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
      platform: options.platform ?? "linux",
      home: options.home ?? "/home/test",
      version: "1.2.3",
      aliasPath: options.aliasPath ?? "/config/aliases.json",
      loadAliases: options.loadAliases,
      resolveAlias: options.resolveAlias,
      saveAlias: options.saveAlias,
      generationTimeoutMs: options.generationTimeoutMs,
      modelListTimeoutMs: options.modelListTimeoutMs,
      credentialVault,
      credentialResolver,
      sensitive,
      nativeVaultEnabled: options.nativeVaultEnabled ?? true,
      runVoice: options.runVoice,
      credentialMutationLock: options.credentialMutationLock
        ?? (async (_directory, _provider, operation) => operation()),
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
    expect(stripTerminalSequences(app.stdout.text())).toBe(
      `${renderHelpText(pc.createColors(false), BYOK_API_KEY_ENV_VARS, "linux")}\n`,
    );
    expect(app.stderr.text()).toBe("");
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 0 });
  });

  test("keeps non-TTY and capability-missing stdout byte-plain", async () => {
    const nonTty = dependencies({ args: ["--help"], stdoutTty: false });

    expect(await runApplication(nonTty.value)).toBe(0);
    const linuxHelp = renderHelpText(pc.createColors(false), BYOK_API_KEY_ENV_VARS, "linux");
    expect(nonTty.stdout.text()).toBe(`${linuxHelp}\n`);
    expect(nonTty.stdout.text()).not.toContain("\u001b");
    expect(nonTty.stderr.text()).toBe("");
    expect(nonTty.runtime.calls).toEqual({ discover: 0, list: 0, generate: 0 });

    const missingCapability = dependencies({ args: ["--help"] });
    const { isTTY: _isTTY, ...stdoutWithoutTty } = missingCapability.stdout;

    expect(await runApplication({
      ...missingCapability.value,
      stdout: stdoutWithoutTty,
    })).toBe(0);
    expect(missingCapability.stdout.text()).toBe(`${linuxHelp}\n`);
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
      expect(app.stdout.text(), scenario.name).toBe(
        `${renderHelpText(pc.createColors(false), BYOK_API_KEY_ENV_VARS, "linux")}\n`,
      );
      expect(app.stdout.text(), scenario.name).not.toContain("\u001b");
      expect(app.stderr.text(), scenario.name).toBe("");
      expect(app.runtime.calls, scenario.name).toEqual({ discover: 0, list: 0, generate: 0 });
    }
  });

  test("renders secure credential guidance for the application platform", async () => {
    const mac = dependencies({ args: ["--help"], platform: "darwin" });
    const linux = dependencies({ args: ["--help"], platform: "linux" });

    expect(await runApplication(mac.value)).toBe(0);
    expect(mac.stdout.text()).toContain("macOS Keychain");
    expect(mac.stdout.text()).not.toContain("GNOME Keyring");

    expect(await runApplication(linux.value)).toBe(0);
    expect(linux.stdout.text()).toContain("GNOME Keyring or KWallet");
    expect(linux.stdout.text()).not.toContain("macOS Keychain");
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

describe("voice boundary", () => {
  test("rejects non-macOS before stdin, aliases, runtime, or injected voice work", async () => {
    let stdinReads = 0;
    let voiceCalls = 0;
    const app = dependencies({
      args: ["--voice"],
      platform: "linux",
      stdin: {
        isTTY: false,
        async *[Symbol.asyncIterator]() {
          stdinReads += 1;
          yield new TextEncoder().encode("do not read");
        },
      },
      loadAliases: async () => {
        throw new Error("voice platform guard must not load aliases");
      },
      runtime: runtime({
        generate: async () => {
          throw new Error("voice platform guard must not generate");
        },
      }),
      runVoice: async () => {
        voiceCalls += 1;
        throw new Error("voice platform guard must not initialize voice work");
      },
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(app.stdout.text()).toBe("");
    expect(app.stderr.text()).toBe("voice: llm-now --voice currently supports macOS only.\n");
    expect(stdinReads).toBe(0);
    expect(voiceCalls).toBe(0);
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 0 });
  });

  test("passes exactly one macOS voice input source to injected voice work", async () => {
    const transcripts: string[] = [];
    const runVoice: NonNullable<Parameters<typeof runApplication>[0]["runVoice"]> = async (
      inputFlag,
      stdin,
    ) => {
      transcripts.push(await resolveInputSource(inputFlag, stdin));
      return 0;
    };
    const flag = dependencies({
      args: ["--voice", "--input", "flag transcript"],
      platform: "darwin",
      stdin: input("", true),
      runVoice,
    });
    const piped = dependencies({
      args: ["--voice"],
      platform: "darwin",
      stdin: input("piped transcript"),
      runVoice,
    });
    const both = dependencies({
      args: ["--voice", "--input", "flag transcript"],
      platform: "darwin",
      stdin: input("piped transcript"),
      runVoice,
    });

    expect(await runApplication(flag.value)).toBe(0);
    expect(await runApplication(piped.value)).toBe(0);
    expect(await runApplication(both.value)).toBe(2);
    expect(transcripts).toEqual(["flag transcript", "piped transcript"]);
    expect(both.stderr.text()).toContain("exactly one input source");
  });
});

describe("alias inventory", () => {
  test("prints one sorted capture-safe roster after one load and performs no other work", async () => {
    const operations: string[] = [];
    let stdinReads = 0;
    const app = dependencies({
      args: ["--aliases"],
      stdin: {
        isTTY: false,
        async *[Symbol.asyncIterator]() {
          stdinReads += 1;
          yield new TextEncoder().encode("ignored piped prompt");
        },
      },
      stdoutTty: true,
      runtime: runtime({
        discover: async () => {
          operations.push("discover");
          return [];
        },
        listModels: async () => {
          operations.push("list-models");
          return [];
        },
        validateCredential: async () => {
          operations.push("validate-credential");
          return [];
        },
        generate: async () => {
          operations.push("generate");
          return "unexpected";
        },
      }),
      prompter: {
        select: async () => {
          operations.push("select");
          return null;
        },
        input: async () => {
          operations.push("input");
          return null;
        },
        instruction: async () => {
          operations.push("instruction");
          return null;
        },
        password: async () => {
          operations.push("password");
          return null;
        },
        confirm: async () => {
          operations.push("confirm");
          return null;
        },
      },
      loadAliases: async (path) => {
        operations.push(`load:${path}`);
        return {
          version: 2,
          aliases: {
            zeta: { provider: "openai", model: "gpt-\u001b[31m5" },
            alpha: {
              provider: "google",
              model: "gemini-2.5-pro",
              instructions: "hidden inventory role",
            },
            middle: { provider: "claude-cli", model: null },
          },
        };
      },
      resolveAlias: async () => {
        operations.push("resolve-alias");
        return { provider: "ollama", model: "qwen" };
      },
      saveAlias: async () => {
        operations.push("save-alias");
        return "saved";
      },
      credentialVault: {
        get: async () => {
          operations.push("vault-get");
          return null;
        },
        set: async () => {
          operations.push("vault-set");
        },
        delete: async () => {
          operations.push("vault-delete");
          return false;
        },
      },
      credentialResolver: {
        resolve: async () => {
          operations.push("credential-resolve");
          return { source: "missing" };
        },
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.stdout.text()).toBe(
      "alpha → Gemini · gemini-2.5-pro\n"
      + "middle → Claude CLI · provider default\n"
      + "zeta → OpenAI · gpt-5\n",
    );
    expect(app.stdout.text()).not.toContain("\u001b");
    expect(app.stdout.text()).not.toContain("hidden inventory role");
    expect(app.stderr.text()).toBe("");
    expect(stdinReads).toBe(0);
    expect(operations).toEqual(["load:/config/aliases.json"]);
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 0 });
  });

  test("a missing store is an empty zero-byte inventory and closed stdin is ignored", async () => {
    const directory = await temporaryDirectory();
    const aliasPath = join(directory, "missing.json");
    const app = dependencies({
      args: ["--aliases"],
      aliasPath,
      stdin: {
        isTTY: false,
        async *[Symbol.asyncIterator]() {
          throw new Error("inventory must not read closed stdin");
        },
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.stdout.text()).toBe("");
    expect(app.stderr.text()).toBe("");
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 0 });
  });

  test("rejects every aliases combination before loading or runtime work", async () => {
    let loads = 0;
    for (const args of [
      ["--aliases", "--input", "hello"],
      ["--aliases", "daily"],
      ["--aliases", "--alias", "daily"],
      ["--aliases", "--provider", "ollama"],
      ["--aliases", "--model", "qwen"],
      ["--aliases", "--help"],
      ["--aliases", "-h"],
      ["--aliases", "--version"],
    ]) {
      const app = dependencies({
        args,
        loadAliases: async () => {
          loads += 1;
          return { version: 1, aliases: {} };
        },
      });

      expect(await runApplication(app.value), args.join(" ")).toBe(2);
      expect(app.stdout.text(), args.join(" ")).toBe("");
      expect(app.stderr.text(), args.join(" ")).toStartWith("usage:");
      expect(app.runtime.calls, args.join(" ")).toEqual({ discover: 0, list: 0, generate: 0 });
    }
    expect(loads).toBe(0);
  });

  test("fails closed for corrupt, conflicting, and unreadable stores", async () => {
    const directory = await temporaryDirectory();
    const corruptPath = join(directory, "corrupt.json");
    const conflictPath = join(directory, "conflict.json");
    await Bun.write(corruptPath, "{");
    await Bun.write(conflictPath, conflictingAliasDocument);

    for (const scenario of [
      { aliasPath: corruptPath, diagnostic: "failed to load alias store" },
      { aliasPath: conflictPath, diagnostic: 'conflicting case-insensitive alias "fred"' },
    ]) {
      const app = dependencies({ args: ["--aliases"], aliasPath: scenario.aliasPath });
      expect(await runApplication(app.value)).toBe(1);
      expect(app.stdout.text()).toBe("");
      expect(app.stderr.text()).toStartWith("config:");
      expect(app.stderr.text()).toContain(scenario.diagnostic);
      expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 0 });
    }

    const unreadable = dependencies({
      args: ["--aliases"],
      loadAliases: async () => {
        throw new AliasStoreError("failed to load alias store: permission denied");
      },
    });
    expect(await runApplication(unreadable.value)).toBe(1);
    expect(unreadable.stdout.text()).toBe("");
    expect(unreadable.stderr.text()).toBe(
      "config: failed to load alias store: permission denied\n",
    );
    expect(unreadable.runtime.calls).toEqual({ discover: 0, list: 0, generate: 0 });
  });

  test("collapses same-target legacy variants into one canonical roster row", async () => {
    const directory = await temporaryDirectory();
    const aliasPath = join(directory, "aliases.json");
    await Bun.write(aliasPath, JSON.stringify({
      version: 1,
      aliases: {
        ZED: { provider: "ollama", model: "qwen" },
        Fred: { provider: "claude-cli", model: null },
        FRED: { provider: "claude-cli", model: null },
      },
    }));
    const app = dependencies({ args: ["--aliases"], aliasPath });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.stdout.text()).toBe(
      "fred → Claude CLI · provider default\n"
      + "zed → Ollama · qwen\n",
    );
    expect(app.stderr.text()).toBe("");
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 0 });
  });

  test("keeps the positional alias named aliases on the generation path", async () => {
    const app = dependencies({
      args: ["aliases", "--input", "hello"],
      runtime: runtime({ response: "generated" }),
      loadAliases: async () => {
        throw new Error("positional alias must not list the roster");
      },
      resolveAlias: async (_path, name) => {
        expect(name).toBe("aliases");
        return { provider: "ollama", model: "qwen" };
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.stdout.text()).toBe("generated");
    expect(app.stderr.text()).toBe("");
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 1 });
  });
});

describe("one-shot application", () => {
  test("shows the exact configured adaptive root without starting discovery or work", async () => {
    const seen: Array<{ message: string; options: PromptOption[] }> = [];
    const stdin = {
      isTTY: true,
      async *[Symbol.asyncIterator]() {
        throw new Error("the root must not resolve a generation prompt");
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
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 0 });
    expect(seen).toEqual([{
      message: "What would you like to do?",
      options: [
        { value: "launcher:run-shortcut", label: "Run with a saved shortcut…" },
        { value: "launcher:create-shortcut", label: "Create a new shortcut…" },
        {
          value: "launcher:run-once",
          label: "Run once with another provider and model…",
        },
        { value: "launcher:manage-connections", label: "Manage connections…" },
      ],
    }]);
  });

  test("shows the exact unconfigured adaptive root without starting discovery", async () => {
    const seen: Array<{ message: string; options: PromptOption[] }> = [];
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({ choices: [null], seen }),
      loadAliases: async () => ({ version: 1, aliases: {} }),
      runtime: runtime({
        discover: async () => {
          throw new Error("rendering the root must not discover providers");
        },
      }),
    });

    expect(await runApplication(app.value)).toBe(130);
    expect(app.stdout.text()).toBe("");
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 0 });
    expect(seen).toEqual([{
      message: "What would you like to do?",
      options: [
        { value: "launcher:create-shortcut", label: "Create a new shortcut…" },
        { value: "launcher:run-once", label: "Run once with a provider and model…" },
        { value: "launcher:manage-connections", label: "Manage connections…" },
      ],
    }]);
  });

  test("opens the exact static shortcut source menu without starting side effects", async () => {
    const seen: Array<{ message: string; options: PromptOption[] }> = [];
    let loads = 0;
    let saves = 0;
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({
        choices: ["launcher:create-shortcut", null],
        seen,
      }),
      loadAliases: async () => {
        loads += 1;
        return { version: 1, aliases: {} };
      },
      saveAlias: async () => {
        saves += 1;
        return "saved";
      },
      runtime: runtime({
        discover: async () => {
          throw new Error("opening shortcut creation must not discover providers");
        },
        listModels: async () => {
          throw new Error("opening shortcut creation must not list models");
        },
        generate: async () => {
          throw new Error("opening shortcut creation must not generate");
        },
      }),
      credentialVault: {
        get: async () => {
          throw new Error("opening shortcut creation must not read the vault");
        },
        set: async () => {
          throw new Error("opening shortcut creation must not write the vault");
        },
        delete: async () => {
          throw new Error("opening shortcut creation must not delete from the vault");
        },
      },
      credentialResolver: {
        resolve: async () => {
          throw new Error("opening shortcut creation must not resolve credentials");
        },
      },
    });

    expect(await runApplication(app.value)).toBe(130);
    expect(loads).toBe(1);
    expect(saves).toBe(0);
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 0 });
    expect(app.stdout.text()).toBe("");
    expect(seen).toEqual([
      {
        message: "What would you like to do?",
        options: [
          { value: "launcher:create-shortcut", label: "Create a new shortcut…" },
          { value: "launcher:run-once", label: "Run once with a provider and model…" },
          { value: "launcher:manage-connections", label: "Manage connections…" },
        ],
      },
      {
        message: "How should this shortcut connect?",
        options: [
          {
            value: "shortcut-source:available-provider",
            label: "Use an available provider…",
          },
          {
            value: "shortcut-source:add-api-key",
            label: "Add a provider with an API key…",
          },
        ],
      },
    ]);
  });

  test("creates an available-provider shortcut before its first prompt and generates once", async () => {
    const events: string[] = [];
    const seen: Array<{ message: string; options: PromptOption[] }> = [];
    const instructionMessages: string[] = [];
    const appRuntime = runtime({
      providers: ["ollama"],
      listModels: async () => {
        events.push("models");
        return [{ id: "qwen", label: "Qwen" }];
      },
      generate: async (provider, model, prompt, signal, instructions) => {
        events.push(`generate:${provider}:${model}:${prompt}:${signal !== undefined}:${instructions}`);
        return "first response";
      },
    });
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1", OPENAI_API_KEY: "u2-environment-blocker" },
      runtime: appRuntime,
      prompter: prompts({
        choices: [
          "launcher:create-shortcut",
          "shortcut-source:available-provider",
          "ollama",
          "qwen",
        ],
        names: ["daily", "first prompt"],
        instructions: ["You are an architect.\nFocus on realtime voice systems."],
        instructionMessages,
        seen,
      }),
      loadAliases: async () => ({ version: 1, aliases: {} }),
      saveAlias: async (_path, name, selection, options) => {
        events.push(`save:${name}:${selection.provider}:${selection.model}:${selection.instructions}`);
        expect(options?.persistenceBlocker?.blocks("u2-environment-blocker")).toBe(true);
        return "saved";
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(events).toEqual([
      "models",
      "save:daily:ollama:qwen:You are an architect.\nFocus on realtime voice systems.",
      "generate:ollama:qwen:first prompt:true:You are an architect.\nFocus on realtime voice systems.",
    ]);
    expect(instructionMessages).toEqual([
      "Optional instructions for this shortcut (press Enter to skip)",
    ]);
    expect(app.stdout.text()).toBe("first response");
    expect(appRuntime.calls.generate).toBe(1);
    expect(seen.map(({ message }) => message)).toEqual([
      "What would you like to do?",
      "How should this shortcut connect?",
      "Choose a provider",
      "Choose a model",
    ]);
    expect(app.stderr.text()).toContain("◆ Saved shortcut daily → Ollama · qwen");
  });

  test("rejects Unicode line separators before saving shortcut instructions", async () => {
    let savedInstructions: string | undefined;
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1" },
      nativeVaultEnabled: false,
      prompter: prompts({
        choices: [
          "launcher:create-shortcut",
          "shortcut-source:available-provider",
          "ollama",
          "qwen",
        ],
        names: ["daily", "first prompt"],
        instructions: ["first\u2028second", "safe role"],
      }),
      loadAliases: async () => ({ version: 1, aliases: {} }),
      saveAlias: async (_path, _name, selection, options) => {
        const persist = async (): Promise<SaveAliasResult> => {
          savedInstructions = selection.instructions;
          return "saved";
        };
        return options?.persistenceGuard?.(persist) ?? persist();
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(savedInstructions).toBe("safe role");
    expect(app.stderr.text()).toContain(
      "config: instructions must use ordinary line breaks and contain no other control characters.",
    );
    expect(app.stderr.text()).not.toContain("first\u2028second");
  });

  test("rechecks vault credentials under fixed-order locks before alias persistence", async () => {
    const candidate = "u2-save-time-vault-key";
    const lockProviders: string[] = [];
    let vaultReads = 0;
    let savedInstructions: string | undefined;
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1" },
      credentialVault: {
        get: async (provider) => {
          vaultReads += 1;
          return vaultReads > CLOUD_CREDENTIAL_PROVIDERS.length
              && provider === CLOUD_CREDENTIAL_PROVIDERS[0]
            ? candidate
            : null;
        },
        set: async () => undefined,
        delete: async () => false,
      },
      credentialMutationLock: async (_directory, provider, operation) => {
        lockProviders.push(provider);
        return operation();
      },
      prompter: prompts({
        choices: [
          "launcher:create-shortcut",
          "shortcut-source:available-provider",
          "ollama",
          "qwen",
        ],
        names: ["daily", "first prompt"],
        instructions: [candidate, "safe role"],
      }),
      loadAliases: async () => ({ version: 1, aliases: {} }),
      saveAlias: async (_path, _name, selection, options) => {
        const persist = async (): Promise<SaveAliasResult> => {
          savedInstructions = selection.instructions;
          return "saved";
        };
        return options?.persistenceGuard?.(persist) ?? persist();
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(savedInstructions).toBe("safe role");
    expect(lockProviders).toEqual([
      ...CLOUD_CREDENTIAL_PROVIDERS,
      ...CLOUD_CREDENTIAL_PROVIDERS,
    ]);
    expect(app.stderr.text()).toContain("instructions must not contain an API key");
    expect(app.stderr.text()).not.toContain(candidate);
  });

  test("fails closed when the save-time vault refresh fails", async () => {
    let vaultReads = 0;
    let saves = 0;
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1" },
      credentialVault: {
        get: async () => {
          vaultReads += 1;
          if (vaultReads > CLOUD_CREDENTIAL_PROVIDERS.length) {
            throw new Error("u2-save-time-vault-detail");
          }
          return null;
        },
        set: async () => undefined,
        delete: async () => false,
      },
      prompter: prompts({
        choices: [
          "launcher:create-shortcut",
          "shortcut-source:available-provider",
          "ollama",
          "qwen",
        ],
        names: ["daily"],
        instructions: ["safe role"],
      }),
      loadAliases: async () => ({ version: 1, aliases: {} }),
      saveAlias: async (_path, _name, _selection, options) => {
        const persist = async (): Promise<SaveAliasResult> => {
          saves += 1;
          return "saved";
        };
        return options?.persistenceGuard?.(persist) ?? persist();
      },
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(saves).toBe(0);
    expect(app.stderr.text()).toContain(
      "config: instructions could not be checked against saved API keys; the shortcut was not saved.",
    );
    expect(app.stderr.text()).not.toContain("u2-save-time-vault-detail");
    expect(app.stderr.text()).not.toContain("safe role");
  });

  test("skips vault reads when instruction capture is blank or native vaults are disabled", async () => {
    let vaultReads = 0;
    let saved: { instructions?: string } | undefined;
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1", OPENAI_API_KEY: "u2-disabled-env-key" },
      nativeVaultEnabled: false,
      credentialVault: {
        get: async () => {
          vaultReads += 1;
          throw new Error("disabled vault must not be read");
        },
        set: async () => undefined,
        delete: async () => false,
      },
      prompter: prompts({
        choices: [
          "launcher:create-shortcut",
          "shortcut-source:available-provider",
          "ollama",
          "qwen",
        ],
        names: ["daily", "first prompt"],
        instructions: ["contains u2-disabled-env-key", "safe role"],
      }),
      loadAliases: async () => ({ version: 1, aliases: {} }),
      saveAlias: async (_path, _name, selection) => {
        saved = selection;
        return "saved";
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(vaultReads).toBe(0);
    expect(saved?.instructions).toBe("safe role");
    expect(app.stderr.text()).toContain("instructions must not contain an API key");
    expect(app.stderr.text()).not.toContain("u2-disabled-env-key");
  });

  test("fails instruction capture closed when an enabled vault read fails", async () => {
    let saves = 0;
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1" },
      credentialVault: {
        get: async () => {
          throw new Error("backend leaked u2-vault-detail");
        },
        set: async () => undefined,
        delete: async () => false,
      },
      prompter: prompts({
        choices: [
          "launcher:create-shortcut",
          "shortcut-source:available-provider",
          "ollama",
          "qwen",
        ],
        names: ["daily"],
        instructions: ["safe role"],
      }),
      loadAliases: async () => ({ version: 1, aliases: {} }),
      saveAlias: async () => {
        saves += 1;
        return "saved";
      },
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(saves).toBe(0);
    expect(app.stderr.text()).toContain(
      "config: instructions could not be checked against saved API keys; the shortcut was not saved.",
    );
    expect(app.stderr.text()).not.toContain("u2-vault-detail");
    expect(app.stderr.text()).not.toContain("safe role");
  });

  test("uses state-only instruction transitions for shortcut overwrite confirmation", async () => {
    const scenarios = [
      {
        name: "add",
        current: { provider: "ollama", model: "old" },
        instructions: "u2-new-add-value",
        transition: "none → set",
      },
      {
        name: "remove",
        current: { provider: "ollama", model: "old", instructions: "u2-old-remove-value" },
        instructions: "   ",
        transition: "set → none",
      },
      {
        name: "change",
        current: { provider: "ollama", model: "old", instructions: "u2-old-change-value" },
        instructions: "u2-new-change-value",
        transition: "set → changed",
      },
      {
        name: "retain",
        current: { provider: "ollama", model: "old", instructions: "u2-unchanged-value" },
        instructions: "u2-unchanged-value",
        transition: "unchanged",
      },
    ] as const;

    for (const scenario of scenarios) {
      const confirmMessages: string[] = [];
      const app = dependencies({
        args: [],
        stdin: input("", true),
        stderrTty: true,
        env: { NO_COLOR: "1" },
        nativeVaultEnabled: false,
        prompter: prompts({
          choices: [
            "launcher:create-shortcut",
            "shortcut-source:available-provider",
            "ollama",
            "qwen",
          ],
          names: ["daily", "first prompt"],
          instructions: [scenario.instructions],
          confirms: [true],
          confirmMessages,
        }),
        loadAliases: async () => ({ version: 1, aliases: { daily: scenario.current } }),
        saveAlias: async (_path, name, _selection, options) => {
          expect(await options?.confirmOverwrite?.(name, scenario.current)).toBe(true);
          return "saved";
        },
      });

      expect(await runApplication(app.value), scenario.name).toBe(0);
      expect(confirmMessages, scenario.name).toHaveLength(1);
      expect(confirmMessages[0], scenario.name).toContain(`Instructions: ${scenario.transition}`);
      expect(confirmMessages[0], scenario.name).not.toContain("u2-old-");
      expect(confirmMessages[0], scenario.name).not.toContain("u2-new-");
      expect(confirmMessages[0], scenario.name).not.toContain("u2-unchanged-value");
    }
  });

  test("adds a missing API-key provider, saves its shortcut, then generates without relisting", async () => {
    const candidate = "u2-hidden-candidate";
    const events: string[] = [];
    let vaultValue: string | null = null;
    const vault: CredentialVault = {
      get: async () => vaultValue,
      set: async (provider, value) => {
        events.push(`key:${provider}`);
        vaultValue = value;
      },
      delete: async () => false,
    };
    const appRuntime = runtime({
      validateCredential: async (provider, value) => {
        events.push(`validate:${provider}:${value === candidate}`);
        return [{ id: "gpt-5", label: "GPT-5" }];
      },
      generate: async (provider, model, prompt, signal, instructions) => {
        events.push(`generate:${provider}:${model}:${prompt}:${signal !== undefined}:${instructions}`);
        return "credential response";
      },
    });
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1" },
      credentialVault: vault,
      runtime: appRuntime,
      prompter: prompts({
        choices: [
          "launcher:create-shortcut",
          "shortcut-source:add-api-key",
          "openai",
          "gpt-5",
        ],
        passwords: [candidate],
        confirms: [true],
        names: ["fast", "credential prompt"],
        instructions: [candidate, "future role"],
      }),
      loadAliases: async () => ({ version: 1, aliases: {} }),
      saveAlias: async (_path, name, selection) => {
        events.push(`shortcut:${name}:${selection.provider}:${selection.model}:${selection.instructions}`);
        return "saved";
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(events).toEqual([
      "validate:openai:true",
      "key:openai",
      "shortcut:fast:openai:gpt-5:future role",
      "generate:openai:gpt-5:credential prompt:true:future role",
    ]);
    expect(appRuntime.calls.list).toBe(0);
    expect(appRuntime.calls.generate).toBe(1);
    expect(app.stdout.text()).toBe("credential response");
    expect(app.stderr.text()).toContain("instructions must not contain an API key");
    expect(`${app.stdout.text()}${app.stderr.text()}`).not.toContain(candidate);
  });

  test("keeps a saved shortcut and exits successfully when its first prompt is cancelled", async () => {
    let saves = 0;
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1" },
      prompter: prompts({
        choices: [
          "launcher:create-shortcut",
          "shortcut-source:available-provider",
          "ollama",
          "qwen",
        ],
        names: ["daily", null],
      }),
      loadAliases: async () => ({ version: 1, aliases: {} }),
      saveAlias: async () => {
        saves += 1;
        return "saved";
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(saves).toBe(1);
    expect(app.runtime.calls.generate).toBe(0);
    expect(app.stderr.text()).toContain("◆ Saved shortcut daily");
    expect(app.stderr.text()).toContain("shortcut was saved");
  });

  test("cancels available-provider shortcut creation at instruction entry before saving", async () => {
    let saves = 0;
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({
        choices: [
          "launcher:create-shortcut",
          "shortcut-source:available-provider",
          "ollama",
          "qwen",
        ],
        names: ["daily"],
        instructions: [null],
      }),
      loadAliases: async () => ({ version: 1, aliases: {} }),
      saveAlias: async () => {
        saves += 1;
        return "saved";
      },
    });

    expect(await runApplication(app.value)).toBe(130);
    expect(saves).toBe(0);
    expect(app.runtime.calls.generate).toBe(0);
  });

  test("withholds an entire generated response containing a registered sensitive value", async () => {
    const sensitive = createSensitiveValueRegistry(["u2-output-secret"]);
    let saves = 0;
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1" },
      sensitive,
      runtime: runtime({ response: "prefix u2-output-secret suffix" }),
      prompter: prompts({
        choices: [
          "launcher:create-shortcut",
          "shortcut-source:available-provider",
          "ollama",
          "qwen",
        ],
        names: ["daily", "first prompt"],
      }),
      loadAliases: async () => ({ version: 1, aliases: {} }),
      saveAlias: async () => {
        saves += 1;
        return "saved";
      },
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(saves).toBe(1);
    expect(app.stdout.text()).toBe("");
    expect(app.stderr.text()).toContain("response withheld");
    expect(app.stderr.text()).not.toContain("u2-output-secret");
  });

  test("withholds a registered sensitive value split by terminal control sequences", async () => {
    const sensitive = createSensitiveValueRegistry(["u2-output-secret"]);
    const app = dependencies({
      args: ["--provider", "ollama", "--model", "qwen", "--input", "hello"],
      sensitive,
      runtime: runtime({ response: "prefix u2-output-\u001b[31msecret suffix" }),
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(app.stdout.text()).toBe("");
    expect(app.stderr.text()).toContain("response withheld");
    expect(stripTerminalSequences(app.stderr.text())).not.toContain("u2-output-secret");
  });

  test("uses one user-wide credential lock namespace across alias config roots", async () => {
    const lockDirectories: string[] = [];
    for (const aliasPath of [
      "/config-one/aliases.json",
      "/config-two/aliases.json",
    ]) {
      const app = dependencies({
        args: [],
        stdin: input("", true),
        stderrTty: true,
        home: "/home/shared",
        aliasPath,
        credentialVault: {
          get: async () => "saved-key",
          set: async () => {},
          delete: async () => true,
        },
        credentialMutationLock: async (directory, _provider, operation) => {
          lockDirectories.push(directory);
          return operation();
        },
        prompter: prompts({
          choices: [
            "launcher:manage-connections",
            "setup:manage-api-keys",
            "openai",
            "delete",
          ],
          confirms: [true],
        }),
        loadAliases: async () => ({ version: 1, aliases: {} }),
      });

      expect(await runApplication(app.value)).toBe(0);
    }

    expect(lockDirectories).toEqual([
      "/home/shared/.llm-now/credential-locks",
      "/home/shared/.llm-now/credential-locks",
    ]);
  });

  test("rejects a stale management replacement inside the provider mutation lock", async () => {
    const candidate = "u2-replacement-candidate";
    let gets = 0;
    let sets = 0;
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1" },
      credentialVault: {
        get: async () => ++gets === 1 ? "observed-key" : "concurrent-key",
        set: async () => {
          sets += 1;
        },
        delete: async () => false,
      },
      prompter: prompts({
        choices: [
          "launcher:manage-connections",
          "setup:manage-api-keys",
          "openai",
          "replace",
        ],
        confirms: [true, true],
        passwords: [candidate],
      }),
      runtime: runtime({
        validateCredential: async () => [{ id: "gpt-5", label: "GPT-5" }],
      }),
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(sets).toBe(0);
    expect(app.stderr.text()).toContain("changed concurrently");
    expect(app.stderr.text()).not.toContain(candidate);
    expect(app.stderr.text()).not.toContain("observed-key");
    expect(app.stderr.text()).not.toContain("concurrent-key");
  });

  test("offers only credential-missing providers after the add source is selected", async () => {
    const seen: Array<{ message: string; options: PromptOption[] }> = [];
    const sensitive = createSensitiveValueRegistry();
    const resolver: CredentialResolver = {
      resolve: async (provider) => {
        if (provider === "anthropic") {
          return {
            source: "environment",
            apiKey: "u2-environment-secret",
            envName: "ANTHROPIC_API_KEY",
          };
        }
        if (provider === "openai") {
          return { source: "vault", apiKey: "u2-vault-secret" };
        }
        if (provider === "google") return { source: "missing" };
        return { source: "unavailable", reason: "target-disabled" };
      },
    };
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      sensitive,
      credentialResolver: resolver,
      prompter: prompts({
        choices: [
          "launcher:create-shortcut",
          "shortcut-source:add-api-key",
          null,
        ],
        seen,
      }),
      loadAliases: async () => ({ version: 1, aliases: {} }),
    });

    expect(await runApplication(app.value)).toBe(130);
    expect(seen[2]).toEqual({
      message: "Choose a provider to add",
      options: [{ value: "google", label: "Gemini", hint: "API key" }],
    });
    expect(sensitive.redact("u2-environment-secret u2-vault-secret")).toBe(
      "[REDACTED] [REDACTED]",
    );
  });

  test("requires a valid non-sensitive shortcut name before saving", async () => {
    const nameSecret = "u2-sensitive-name";
    const sensitive = createSensitiveValueRegistry([nameSecret]);
    const savedNames: string[] = [];
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1" },
      sensitive,
      prompter: prompts({
        choices: [
          "launcher:create-shortcut",
          "shortcut-source:available-provider",
          "ollama",
          "qwen",
        ],
        names: ["", "bad name", nameSecret, "daily", "first prompt"],
      }),
      loadAliases: async () => ({ version: 1, aliases: {} }),
      saveAlias: async (_path, name) => {
        savedNames.push(name);
        return "saved";
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(savedNames).toEqual(["daily"]);
    expect(app.stderr.text()).toContain("enter a shortcut name");
    expect(app.stderr.text()).toContain("invalid shortcut name");
    expect(app.stderr.text()).toContain("must not contain an API key");
    expect(app.stderr.text()).not.toContain(nameSecret);
  });

  test("returns to required naming when overwrite is declined", async () => {
    const confirmInitialValues: Array<boolean | undefined> = [];
    const savedNames: string[] = [];
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1" },
      prompter: prompts({
        choices: [
          "launcher:create-shortcut",
          "shortcut-source:available-provider",
          "ollama",
          "qwen",
        ],
        names: ["daily", "new-daily", "first prompt"],
        confirms: [false],
        confirmInitialValues,
      }),
      loadAliases: async () => ({
        version: 1,
        aliases: { daily: { provider: "openai", model: "gpt-5" } },
      }),
      saveAlias: async (_path, name, selection, options) => {
        savedNames.push(name);
        if (name === "daily") {
          const overwrite = await options?.confirmOverwrite?.(
            name,
            { provider: "openai", model: "gpt-5" },
          );
          return overwrite ? "saved" : "declined";
        }
        expect(selection).toEqual({ provider: "ollama", model: "qwen" });
        return "saved";
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(savedNames).toEqual(["daily", "new-daily"]);
    expect(confirmInitialValues).toEqual([false]);
    expect(app.stderr.text()).toContain("◆ Saved shortcut new-daily");
  });

  test("fails a same-provider add race without overwriting the winning key", async () => {
    const candidate = "u2-losing-candidate";
    let openAiResolutions = 0;
    let sets = 0;
    const resolver: CredentialResolver = {
      resolve: async (provider) => {
        if (provider === "openai") {
          openAiResolutions += 1;
          return openAiResolutions === 1
            ? { source: "missing" }
            : { source: "vault", apiKey: "u2-winning-key" };
        }
        return { source: "unavailable", reason: "target-disabled" };
      },
      invalidate: () => {},
    };
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1" },
      credentialResolver: resolver,
      credentialVault: {
        get: async () => null,
        set: async () => {
          sets += 1;
        },
        delete: async () => false,
      },
      prompter: prompts({
        choices: [
          "launcher:create-shortcut",
          "shortcut-source:add-api-key",
          "openai",
        ],
        passwords: [candidate],
        confirms: [true],
      }),
      loadAliases: async () => ({ version: 1, aliases: {} }),
      runtime: runtime({
        validateCredential: async () => [{ id: "gpt-5", label: "GPT-5" }],
      }),
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(sets).toBe(0);
    expect(app.stderr.text()).toContain("changed concurrently");
    expect(app.stderr.text()).not.toContain(candidate);
    expect(app.stderr.text()).not.toContain("u2-winning-key");
  });

  test("keeps a saved key when later model selection is cancelled", async () => {
    const candidate = "u2-post-key-candidate";
    let vaultValue: string | null = null;
    let aliasSaves = 0;
    const vault: CredentialVault = {
      get: async () => vaultValue,
      set: async (_provider, value) => {
        vaultValue = value;
      },
      delete: async () => false,
    };
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1" },
      credentialVault: vault,
      prompter: prompts({
        choices: [
          "launcher:create-shortcut",
          "shortcut-source:add-api-key",
          "openai",
          null,
        ],
        passwords: [candidate],
        confirms: [true],
      }),
      loadAliases: async () => ({ version: 1, aliases: {} }),
      saveAlias: async () => {
        aliasSaves += 1;
        return "saved";
      },
      runtime: runtime({
        validateCredential: async () => [{ id: "gpt-5", label: "GPT-5" }],
      }),
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(vaultValue === candidate).toBe(true);
    expect(aliasSaves).toBe(0);
    expect(app.runtime.calls.generate).toBe(0);
    expect(app.stderr.text()).toContain("API key verified");
    expect(app.stderr.text()).toContain("shortcut creation was cancelled");
    expect(app.stderr.text()).not.toContain(candidate);
  });

  test("keeps a saved key when required shortcut instruction entry is cancelled", async () => {
    const candidate = "u2-instruction-cancel-candidate";
    let vaultValue: string | null = null;
    let aliasSaves = 0;
    const vault: CredentialVault = {
      get: async () => vaultValue,
      set: async (_provider, value) => {
        vaultValue = value;
      },
      delete: async () => false,
    };
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1" },
      credentialVault: vault,
      prompter: prompts({
        choices: [
          "launcher:create-shortcut",
          "shortcut-source:add-api-key",
          "openai",
          "gpt-5",
        ],
        passwords: [candidate],
        confirms: [true],
        names: ["fast"],
        instructions: [null],
      }),
      loadAliases: async () => ({ version: 1, aliases: {} }),
      saveAlias: async () => {
        aliasSaves += 1;
        return "saved";
      },
      runtime: runtime({
        validateCredential: async () => [{ id: "gpt-5", label: "GPT-5" }],
      }),
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(vaultValue === candidate).toBe(true);
    expect(aliasSaves).toBe(0);
    expect(app.stderr.text()).toContain("API key verified");
    expect(app.stderr.text()).toContain("shortcut creation was cancelled");
    expect(app.stderr.text()).not.toContain(candidate);
  });

  test("keeps a saved key and fails when validation returns no shortcut-safe model", async () => {
    const candidate = "u2-model-secret";
    let vaultValue: string | null = null;
    let aliasSaves = 0;
    const vault: CredentialVault = {
      get: async () => vaultValue,
      set: async (_provider, value) => {
        vaultValue = value;
      },
      delete: async () => false,
    };
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1" },
      credentialVault: vault,
      prompter: prompts({
        choices: [
          "launcher:create-shortcut",
          "shortcut-source:add-api-key",
          "openai",
        ],
        passwords: [candidate],
        confirms: [true],
      }),
      loadAliases: async () => ({ version: 1, aliases: {} }),
      saveAlias: async () => {
        aliasSaves += 1;
        return "saved";
      },
      runtime: runtime({
        validateCredential: async () => [{ id: candidate, label: "Unsafe" }],
      }),
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(vaultValue === candidate).toBe(true);
    expect(aliasSaves).toBe(0);
    expect(app.runtime.calls.generate).toBe(0);
    expect(app.stderr.text()).toContain("API key was saved without a shortcut");
    expect(app.stderr.text()).not.toContain(candidate);
  });

  test("fails available-provider creation before naming when every model is unsafe", async () => {
    const modelSecret = "u2-unsafe-model";
    let aliasSaves = 0;
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      sensitive: createSensitiveValueRegistry([modelSecret]),
      prompter: prompts({
        choices: [
          "launcher:create-shortcut",
          "shortcut-source:available-provider",
          "openai",
        ],
      }),
      loadAliases: async () => ({ version: 1, aliases: {} }),
      saveAlias: async () => {
        aliasSaves += 1;
        return "saved";
      },
      runtime: runtime({
        providers: ["openai"],
        listModels: async () => [{ id: modelSecret, label: "Unsafe" }],
      }),
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(aliasSaves).toBe(0);
    expect(app.runtime.calls.generate).toBe(0);
    expect(app.stderr.text()).toContain("no eligible models");
    expect(app.stderr.text()).not.toContain(modelSecret);
  });

  test("does not inspect credentials when native storage is unavailable", async () => {
    let resolves = 0;
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      nativeVaultEnabled: false,
      credentialResolver: {
        resolve: async () => {
          resolves += 1;
          return { source: "missing" };
        },
      },
      prompter: prompts({
        choices: [
          "launcher:create-shortcut",
          "shortcut-source:add-api-key",
        ],
      }),
      loadAliases: async () => ({ version: 1, aliases: {} }),
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(resolves).toBe(0);
    expect(app.stderr.text()).toContain("native credential storage unavailable");
  });

  test("reports when every cloud provider is already connected without asking for a key", async () => {
    let passwords = 0;
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      credentialResolver: {
        resolve: async (provider) => ({
          source: "vault",
          apiKey: `connected-${provider}`,
        }),
      },
      prompter: {
        ...prompts({
          choices: [
            "launcher:create-shortcut",
            "shortcut-source:add-api-key",
          ],
        }),
        password: async () => {
          passwords += 1;
          return null;
        },
      },
      loadAliases: async () => ({ version: 1, aliases: {} }),
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(passwords).toBe(0);
    expect(app.stderr.text()).toContain("no API-key provider needs a saved credential");
  });

  test("preserves pre-write consent decline and cancellation exits in API-key creation", async () => {
    for (const scenario of [
      { consent: false, exitCode: 0 },
      { consent: null, exitCode: 130 },
    ] as const) {
      let sets = 0;
      const candidate = `u2-consent-${String(scenario.consent)}`;
      const app = dependencies({
        args: [],
        stdin: input("", true),
        stderrTty: true,
        credentialVault: {
          get: async () => null,
          set: async () => {
            sets += 1;
          },
          delete: async () => false,
        },
        prompter: prompts({
          choices: [
            "launcher:create-shortcut",
            "shortcut-source:add-api-key",
            "openai",
          ],
          passwords: [candidate],
          confirms: [scenario.consent],
        }),
        loadAliases: async () => ({ version: 1, aliases: {} }),
        runtime: runtime({
          validateCredential: async () => [{ id: "gpt-5", label: "GPT-5" }],
        }),
      });

      expect(await runApplication(app.value)).toBe(scenario.exitCode);
      expect(sets).toBe(0);
      expect(`${app.stdout.text()}${app.stderr.text()}`).not.toContain(candidate);
    }
  });

  test("reports key-only partial success when shortcut persistence fails", async () => {
    const candidate = "u2-alias-failure-candidate";
    let vaultValue: string | null = null;
    const vault: CredentialVault = {
      get: async () => vaultValue,
      set: async (_provider, value) => {
        vaultValue = value;
      },
      delete: async () => false,
    };
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1" },
      credentialVault: vault,
      prompter: prompts({
        choices: [
          "launcher:create-shortcut",
          "shortcut-source:add-api-key",
          "openai",
          "gpt-5",
        ],
        passwords: [candidate],
        confirms: [true],
        names: ["fast"],
      }),
      loadAliases: async () => ({ version: 1, aliases: {} }),
      saveAlias: async () => {
        throw new Error(`alias backend rejected ${candidate}`);
      },
      runtime: runtime({
        validateCredential: async () => [{ id: "gpt-5", label: "GPT-5" }],
      }),
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(vaultValue === candidate).toBe(true);
    expect(app.runtime.calls.generate).toBe(0);
    expect(app.stderr.text()).toContain("API key was saved, but the shortcut was not saved");
    expect(app.stderr.text()).not.toContain(candidate);
  });

  test("rejects a stale management deletion inside the provider mutation lock", async () => {
    let gets = 0;
    let deletes = 0;
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1" },
      credentialVault: {
        get: async () => ++gets === 1 ? "observed-key" : "concurrent-key",
        set: async () => {},
        delete: async () => {
          deletes += 1;
          return true;
        },
      },
      prompter: prompts({
        choices: [
          "launcher:manage-connections",
          "setup:manage-api-keys",
          "openai",
          "delete",
        ],
        confirms: [true],
      }),
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(deletes).toBe(0);
    expect(app.stderr.text()).toContain("changed concurrently");
    expect(app.stderr.text()).not.toContain("observed-key");
    expect(app.stderr.text()).not.toContain("concurrent-key");
  });

  test("runs a selected shortcut with one alias snapshot through the shared output tail", async () => {
    const seen: Array<{ message: string; options: PromptOption[] }> = [];
    const inputMessages: string[] = [];
    let loads = 0;
    let saves = 0;
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1" },
      prompter: prompts({
        choices: ["launcher:run-shortcut", "daily"],
        names: ["hello"],
        seen,
        inputMessages,
      }),
      loadAliases: async () => {
        loads += 1;
        return {
          version: 1,
          aliases: {
            daily: loads === 1
              ? { provider: "openai", model: "gpt-5" }
              : { provider: "ollama", model: "qwen" },
          },
        };
      },
      runtime: runtime({
        generate: async (provider, model, prompt) => {
          expect({ provider, model, prompt }).toEqual({
            provider: "openai",
            model: "gpt-5",
            prompt: "hello",
          });
          return "shortcut response";
        },
      }),
      saveAlias: async () => {
        saves += 1;
        return "saved";
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(loads).toBe(1);
    expect(saves).toBe(0);
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 1 });
    expect(app.stdout.text()).toBe("shortcut response");
    expect(app.stderr.text()).toBe("\u001b[0m\n\n");
    expect(seen.map(({ message }) => message)).toEqual([
      "What would you like to do?",
      "Choose a saved shortcut",
    ]);
    expect(seen[1]?.options).toEqual([
      { value: "daily", label: "daily", hint: "OpenAI · gpt-5" },
    ]);
    expect(inputMessages).toEqual(["Prompt for daily · OpenAI · gpt-5"]);
  });

  test("cancels the shortcut picker or prompt without generating response bytes", async () => {
    const scenarios = [
      {
        name: "shortcut picker",
        choices: ["launcher:run-shortcut", null],
        names: [] as Array<string | null>,
      },
      {
        name: "shortcut prompt",
        choices: ["launcher:run-shortcut", "daily"],
        names: [null],
      },
    ];

    for (const scenario of scenarios) {
      const app = dependencies({
        args: [],
        stdin: input("", true),
        stderrTty: true,
        prompter: prompts({ choices: scenario.choices, names: scenario.names }),
        loadAliases: async () => ({
          version: 1,
          aliases: { daily: { provider: "openai", model: "gpt-5" } },
        }),
      });

      expect(await runApplication(app.value), scenario.name).toBe(130);
      expect(app.stdout.text(), scenario.name).toBe("");
      expect(app.runtime.calls, scenario.name).toEqual({ discover: 0, list: 0, generate: 0 });
    }
  });

  test("opens the exact static management submenu without starting either operation", async () => {
    const seen: Array<{ message: string; options: PromptOption[] }> = [];
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({
        choices: ["launcher:manage-connections", null],
        seen,
      }),
      loadAliases: async () => ({ version: 1, aliases: {} }),
      runtime: runtime({
        discover: async () => {
          throw new Error("opening management must not discover providers");
        },
      }),
      credentialVault: {
        get: async () => {
          throw new Error("opening management must not read the vault");
        },
        set: async () => {
          throw new Error("opening management must not write the vault");
        },
        delete: async () => {
          throw new Error("opening management must not delete from the vault");
        },
      },
    });

    expect(await runApplication(app.value)).toBe(130);
    expect(app.stdout.text()).toBe("");
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 0 });
    expect(seen[1]).toEqual({
      message: "What would you like to manage?",
      options: [
        { value: "setup:discover-providers", label: "Discover available providers…" },
        { value: "setup:manage-api-keys", label: "Add or manage API keys…" },
      ],
    });
  });

  test("configured and unconfigured run-once actions generate once without save offers", async () => {
    const scenarios: Array<{
      name: string;
      aliases: AliasDocument["aliases"];
      actionLabel: string;
      names: string[];
      expectedInputMessages: string[];
    }> = [
      {
        name: "configured",
        aliases: { daily: { provider: "ollama" as const, model: "qwen" } },
        actionLabel: "Run once with another provider and model…",
        names: ["hello"],
        expectedInputMessages: ["Prompt for Ollama · qwen"],
      },
      {
        name: "unconfigured",
        aliases: {},
        actionLabel: "Run once with a provider and model…",
        names: ["hello"],
        expectedInputMessages: ["Prompt for Ollama · qwen"],
      },
    ];

    for (const scenario of scenarios) {
      const seen: Array<{ message: string; options: PromptOption[] }> = [];
      const inputMessages: string[] = [];
      let loads = 0;
      let saves = 0;
      const app = dependencies({
        args: [],
        stdin: input("", true),
        stderrTty: true,
        env: { NO_COLOR: "1" },
        prompter: prompts({
          choices: ["launcher:run-once", "ollama", "qwen"],
          names: scenario.names,
          seen,
          inputMessages,
        }),
        loadAliases: async () => {
          loads += 1;
          return { version: 1, aliases: scenario.aliases };
        },
        runtime: runtime({
          providers: ["ollama"],
          generate: async (provider, model, prompt, _signal, instructions) => {
            expect({ provider, model, prompt }, scenario.name).toEqual({
              provider: "ollama",
              model: "qwen",
              prompt: "hello",
            });
            expect(instructions, scenario.name).toBeUndefined();
            return `${scenario.name} response`;
          },
        }),
        saveAlias: async () => {
          saves += 1;
          return "saved";
        },
      });

      expect(await runApplication(app.value), scenario.name).toBe(0);
      expect(loads, scenario.name).toBe(1);
      expect(saves, scenario.name).toBe(0);
      expect(app.runtime.calls, scenario.name).toEqual({ discover: 1, list: 1, generate: 1 });
      expect(app.stdout.text(), scenario.name).toBe(`${scenario.name} response`);
      expect(seen[0]?.options.find(({ value }) => value === "launcher:run-once")?.label)
        .toBe(scenario.actionLabel);
      expect(seen.slice(1).map(({ message }) => message), scenario.name).toEqual([
        "Choose a provider",
        "Choose a model",
      ]);
      expect(inputMessages, scenario.name).toEqual(scenario.expectedInputMessages);
      if (scenario.name === "configured") {
        expect(app.stderr.text()).toContain(
          "◆ Ollama · qwen is already saved as alias daily",
        );
      }
    }
  });

  test("passes a CLI default model through contextual input and generation as null", async () => {
    const inputMessages: string[] = [];
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({
        choices: ["launcher:run-once", "codex-cli", false],
        names: ["hello"],
        inputMessages,
      }),
      loadAliases: async () => ({ version: 1, aliases: {} }),
      runtime: runtime({
        providers: ["codex-cli"],
        listModels: async () => [],
        generate: async (provider, model, prompt) => {
          expect({ provider, model, prompt }).toEqual({
            provider: "codex-cli",
            model: null,
            prompt: "hello",
          });
          return "default response";
        },
      }),
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.stdout.text()).toBe("default response");
    expect(inputMessages).toEqual(["Prompt for Codex CLI · default model"]);
  });

  test("cancels fresh provider, model, or target prompts before generation", async () => {
    const scenarios = [
      {
        name: "provider",
        choices: ["launcher:run-once", null],
        names: [] as Array<string | null>,
      },
      {
        name: "model",
        choices: ["launcher:run-once", "ollama", null],
        names: [] as Array<string | null>,
      },
      {
        name: "target prompt",
        choices: ["launcher:run-once", "ollama", "qwen"],
        names: [null],
      },
    ];

    for (const scenario of scenarios) {
      const app = dependencies({
        args: [],
        stdin: input("", true),
        stderrTty: true,
        prompter: prompts({ choices: scenario.choices, names: scenario.names }),
        loadAliases: async () => ({ version: 1, aliases: {} }),
        runtime: runtime({ providers: ["ollama"] }),
      });

      expect(await runApplication(app.value), scenario.name).toBe(130);
      expect(app.runtime.calls.generate, scenario.name).toBe(0);
      expect(app.stdout.text(), scenario.name).toBe("");
    }
  });

  test("runs provider discovery only after the explicit setup choice", async () => {
    const seen: Array<{ message: string; options: PromptOption[] }> = [];
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({
        choices: ["launcher:manage-connections", "setup:discover-providers", "ollama"],
        seen,
      }),
      runtime: runtime({ providers: ["ollama", "codex-cli"] }),
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.runtime.calls).toEqual({ discover: 1, list: 0, generate: 0 });
    expect(seen[2]?.message).toBe("Choose an available provider");
    expect(seen[2]?.options).toEqual([
      { value: "codex-cli", label: "Codex CLI", hint: "authenticated CLI · available" },
      { value: "ollama", label: "Ollama", hint: "local server · available" },
    ]);
    expect(app.stderr.text()).toContain("Provider Ollama is available");
  });

  test("reuses secure vault remediation when provider discovery cannot read saved keys", async () => {
    const vaultError = new CredentialVaultError(
      "get",
      "anthropic",
      new Error("discovery backend detail"),
    );
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({
        choices: ["launcher:manage-connections", "setup:discover-providers"],
      }),
      runtime: runtime({
        discover: async () => {
          throw new RuntimeStageError("discovery", null, vaultError.message, vaultError);
        },
      }),
    });

    expect(await runApplication(app.value)).toBe(1);
    const plain = stripTerminalSequences(app.stderr.text());
    expect(plain).toContain("Secure API-key storage isn’t available in this Linux session.");
    expect(plain).toContain("llm-now couldn’t access the saved API key.");
    expect(plain).toContain("ANTHROPIC_API_KEY");
    expect(plain).toContain("Secret Service");
    expect(plain).not.toContain("discovery: credential vault get (anthropic): unavailable");
    expect(plain).not.toContain("discovery backend detail");
  });

  test("uses the static cloud catalog for API-key management and cancels without validation", async () => {
    const seen: Array<{ message: string; options: PromptOption[] }> = [];
    const app = dependencies({
      args: [],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({
        choices: ["launcher:manage-connections", "setup:manage-api-keys", null],
        seen,
      }),
      runtime: runtime({ providers: [] }),
    });

    expect(await runApplication(app.value)).toBe(130);
    expect(app.stdout.text()).toBe("");
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 0 });
    expect(seen[2]?.options).toEqual([
      { value: "anthropic", label: "Anthropic", hint: "API key" },
      { value: "deepinfra", label: "DeepInfra", hint: "API key" },
      { value: "deepseek", label: "DeepSeek", hint: "API key" },
      { value: "google", label: "Gemini", hint: "API key" },
      { value: "groq", label: "Groq", hint: "API key" },
      { value: "mistral", label: "Mistral", hint: "API key" },
      { value: "openai", label: "OpenAI", hint: "API key" },
      { value: "openrouter", label: "OpenRouter", hint: "API key" },
      { value: "xai", label: "xAI", hint: "API key" },
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
        choices: ["launcher:manage-connections", "setup:manage-api-keys", "openai"],
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

  test("renders the exact plain saved-credential receipt without credential provenance", async () => {
    const candidate = "u3-valid-hidden-sentinel";
    const environmentCredential = "u3-environment-sentinel";
    const passwordMessages: string[] = [];
    const validated: string[] = [];
    const terminalEnvironments: Array<Record<string, string>> = [
      { NO_COLOR: "1" },
      { TERM: "dumb" },
    ];
    for (const terminalEnv of terminalEnvironments) {
      const app = dependencies({
        args: [],
        stdin: input("", true),
        stderrTty: true,
        env: { ...terminalEnv, OPENAI_API_KEY: environmentCredential },
        prompter: prompts({
          choices: ["launcher:manage-connections", "setup:manage-api-keys", "openai", false],
          passwords: [candidate],
          confirms: [true],
          passwordMessages,
        }),
        runtime: runtime({
          providers: [],
          validateCredential: async (_provider, apiKey) => {
            validated.push(apiKey);
            return [{ id: "qwen", label: "Qwen" }];
          },
        }),
      });

      expect(await runApplication(app.value)).toBe(0);
      expect(app.stdout.text()).toBe("");
      expect(app.stderr.text()).toBe(
        "◆ OpenAI · API key verified\n  stored as: saved credential\n",
      );
      expect(`${app.stdout.text()}${app.stderr.text()}${passwordMessages.join("\n")}`).not.toContain(
        candidate,
      );
      expect(app.stderr.text()).not.toContain(environmentCredential);
      expect(app.stderr.text()).not.toContain("OPENAI_API_KEY");
    }
    expect(validated).toEqual([candidate, candidate]);
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

  test("applies a request instruction after selectorless interactive alias selection", async () => {
    const seen: Array<{ message: string; options: PromptOption[] }> = [];
    let loads = 0;
    const app = dependencies({
      args: ["--input", "hello", "--instruction", "interactive request role"],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({ choices: ["fast"], seen }),
      loadAliases: async (path) => {
        loads += 1;
        expect(path).toBe("/config/aliases.json");
        return {
          version: 2,
          aliases: {
            fast: {
              provider: "openai",
              model: "gpt-5",
              instructions: "interactive picker role",
            },
            Daily: { provider: "ollama", model: "llama3" },
            assistant: { provider: "claude-cli", model: null },
          },
        };
      },
      runtime: runtime({
        generate: async (provider, model, _prompt, _signal, instructions) => {
          expect({ provider, model }).toEqual({ provider: "openai", model: "gpt-5" });
          expect(instructions).toBe("interactive request role");
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
        { value: "assistant", label: "assistant", hint: "Claude CLI · default model" },
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
          daily: { provider: "ollama", model: "qwen" },
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
      "◆ Ollama · qwen is already saved as alias daily\n"
      + "  Next time, use llm-now daily --input \"<prompt>\"\n",
    );
  });

  test("does not treat an instructed alias as equivalent to an instruction-free fresh run", async () => {
    const inputMessages: string[] = [];
    let saved: AliasRecord | undefined;
    const app = dependencies({
      args: ["--input", "hello"],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1" },
      nativeVaultEnabled: false,
      prompter: prompts({
        choices: [false, "ollama", "qwen"],
        names: ["plain"],
        instructions: [""],
        inputMessages,
      }),
      loadAliases: async () => ({
        version: 2,
        aliases: {
          instructed: {
            provider: "ollama",
            model: "qwen",
            instructions: "u2-existing-role",
          },
        },
      }),
      saveAlias: async (_path, _name, selection) => {
        saved = selection;
        return "saved";
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(inputMessages).toEqual([
      "Enter an alias name for Ollama · qwen (Enter to exit)",
    ]);
    expect(saved).toEqual({ provider: "ollama", model: "qwen" });
    expect(app.stderr.text()).not.toContain("is already saved as alias instructed");
    expect(app.stderr.text()).not.toContain("u2-existing-role");
  });

  test("keeps a request instruction independent from fresh-selection alias saving", async () => {
    const inputMessages: string[] = [];
    const instructionMessages: string[] = [];
    let saved: AliasRecord | undefined;
    const app = dependencies({
      args: ["--input", "hello", "--instruction", "request-only role"],
      stdin: input("", true),
      stderrTty: true,
      env: { NO_COLOR: "1" },
      nativeVaultEnabled: false,
      prompter: prompts({
        choices: [false, "ollama", "qwen"],
        names: ["new-alias"],
        instructions: ["separately saved role"],
        inputMessages,
        instructionMessages,
      }),
      loadAliases: async () => ({
        version: 1,
        aliases: { daily: { provider: "ollama", model: "qwen" } },
      }),
      runtime: runtime({
        generate: async (_provider, _model, prompt, _signal, instructions) => {
          expect(prompt).toBe("hello");
          expect(instructions).toBe("request-only role");
          return "exact response";
        },
      }),
      saveAlias: async (_path, _name, selection) => {
        saved = selection;
        return "saved";
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.stdout.text()).toBe("exact response");
    expect(inputMessages).toEqual([
      "Enter an alias name for Ollama · qwen (Enter to exit)",
    ]);
    expect(instructionMessages).toEqual([
      "Optional instructions for this shortcut (press Enter to skip)",
    ]);
    expect(saved).toEqual({
      provider: "ollama",
      model: "qwen",
      instructions: "separately saved role",
    });
    expect(app.stderr.text()).not.toContain("is already saved as alias daily");
    expect(app.stderr.text()).not.toContain("request-only role");
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
      "◆ Claude CLI · default model is already saved as alias quick\n"
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
        aliases: { daily: { provider: "ollama", model: "qwen" } },
      }),
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.stderr.text()).toContain(
      "\u001b[37mllm-now daily --input \"<prompt>\"\u001b[39m",
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

  test("explicit interactive provider selection forwards a request instruction without loading aliases", async () => {
    const app = dependencies({
      args: [
        "--input",
        "hello",
        "--provider",
        "openai",
        "--model",
        "gpt-5",
        "--instruction",
        "explicit request role",
      ],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({ confirms: [false] }),
      runtime: runtime({
        generate: async (_provider, _model, _prompt, _signal, instructions) => {
          expect(instructions).toBe("explicit request role");
          return "response";
        },
      }),
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

  test("positional and long-form aliases preserve default and override parity", async () => {
    for (const scenario of [
      { instructionArgs: [] as string[], expected: "shared alias role" },
      {
        instructionArgs: ["--instruction", "request alias role"],
        expected: "request alias role",
      },
    ]) {
      const results = [];
      for (const args of [
        ["Daily", "--input", "hello", ...scenario.instructionArgs],
        ["--input", "hello", "--alias", "Daily", ...scenario.instructionArgs],
      ]) {
        const calls: string[] = [];
        const resolved = Object.freeze({
          provider: "claude-cli" as const,
          model: null,
          instructions: "shared alias role",
        });
        const app = dependencies({
          args,
          runtime: runtime({
            generate: async (provider, model, prompt, signal, instructions) => {
              calls.push(`${provider}:${model}:${prompt}:${signal !== undefined}:${instructions}`);
              return "alias-result";
            },
          }),
          resolveAlias: async (_path, name) => {
            calls.push(`resolve:${name}`);
            return resolved;
          },
        });

        results.push({
          exitCode: await runApplication(app.value),
          stdout: app.stdout.text(),
          stderr: app.stderr.text(),
          runtimeCalls: app.runtime.calls,
          calls,
          resolved,
        });
      }

      expect(results[0]).toEqual(results[1]);
      expect(results[0]).toEqual({
        exitCode: 0,
        stdout: "alias-result",
        stderr: "",
        runtimeCalls: { discover: 0, list: 0, generate: 1 },
        calls: [`resolve:Daily`, `claude-cli:null:hello:true:${scenario.expected}`],
        resolved: {
          provider: "claude-cli",
          model: null,
          instructions: "shared alias role",
        },
      });
    }
  });

  test("does not persist a request instruction in the real alias store", async () => {
    const directory = await temporaryDirectory();
    const aliasPath = join(directory, "aliases.json");
    const stored = JSON.stringify({
      version: 2,
      aliases: {
        daily: {
          provider: "ollama",
          model: "qwen",
          instructions: "saved alias role",
        },
      },
    });
    await Bun.write(aliasPath, stored);
    const app = dependencies({
      args: ["daily", "--input", "hello", "--instruction", "request alias role"],
      aliasPath,
      runtime: runtime({
        generate: async (_provider, _model, _prompt, _signal, instructions) => {
          expect(instructions).toBe("request alias role");
          return "alias-result";
        },
      }),
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(await Bun.file(aliasPath).text()).toBe(stored);
  });

  test("resolves positional and long-form aliases case-insensitively through the real store", async () => {
    const directory = await temporaryDirectory();
    const aliasPath = join(directory, "aliases.json");
    await Bun.write(aliasPath, JSON.stringify({
      version: 1,
      aliases: { Fred: { provider: "claude-cli", model: null } },
    }));

    for (const args of [
      ["FRED", "--input", "hello"],
      ["--input", "hello", "--alias", "fReD"],
    ]) {
      const app = dependencies({
        args,
        aliasPath,
        runtime: runtime({ response: "alias-result" }),
      });

      expect(await runApplication(app.value)).toBe(0);
      expect(app.stdout.text()).toBe("alias-result");
      expect(app.stderr.text()).toBe("");
      expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 1 });
    }
  });

  test("reports conflicting legacy aliases before any runtime work", async () => {
    const directory = await temporaryDirectory();
    const aliasPath = join(directory, "aliases.json");
    await Bun.write(aliasPath, conflictingAliasDocument);

    for (const args of [
      ["fred", "--input", "hello"],
      ["--input", "hello", "--alias", "Fred"],
    ]) {
      const app = dependencies({ args, aliasPath });

      expect(await runApplication(app.value)).toBe(1);
      expect(app.stdout.text()).toBe("");
      expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 0 });
      expect(app.stderr.text()).toContain('conflicting case-insensitive alias "fred"');
      expect(app.stderr.text()).toContain('"FRED" -> ollama/qwen');
      expect(app.stderr.text()).toContain('"Fred" -> openai/gpt-5');
      expect(app.stderr.text()).toContain(`Edit the alias store manually at ${aliasPath}`);
    }
  });

  test("preserves conflict repair guidance when legacy model identifiers are oversized", async () => {
    const directory = await temporaryDirectory();
    const aliasPath = join(directory, "aliases.json");
    await Bun.write(aliasPath, JSON.stringify({
      version: 1,
      aliases: {
        FRED: { provider: "openai", model: `prefix-${"x".repeat(2_000)}-suffix` },
        Fred: { provider: "ollama", model: "qwen" },
      },
    }));
    const app = dependencies({ args: ["fred", "--input", "hello"], aliasPath });

    expect(await runApplication(app.value)).toBe(1);
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 0 });
    expect(app.stderr.text()).toContain('"FRED" -> openai/prefix-');
    expect(app.stderr.text()).toContain("-suffix");
    expect(app.stderr.text()).toContain('"Fred" -> ollama/qwen');
    expect(app.stderr.text()).toContain(`Edit the alias store manually at ${aliasPath}`);
    expect(app.stderr.text()).toContain('keep only one target for "fred"');
    expect(app.stderr.text().length).toBeLessThanOrEqual(1_025);
  });

  test("explicit provider and model bypass an unrelated conflicting alias store", async () => {
    const directory = await temporaryDirectory();
    const aliasPath = join(directory, "aliases.json");
    await Bun.write(aliasPath, conflictingAliasDocument);
    const app = dependencies({
      args: ["--input", "hello", "--provider", "ollama", "--model", "qwen"],
      aliasPath,
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.stdout.text()).toBe("response");
    expect(app.stderr.text()).toBe("");
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 1 });
  });

  test("positional and long-form alias-only TTY calls prompt once with target context", async () => {
    const results = [];
    for (const args of [
      ["Daily", "--instruction", "prompted request role"],
      ["--alias", "Daily", "--instruction", "prompted request role"],
    ]) {
      const events: string[] = [];
      const inputMessages: string[] = [];
      const inputOptions: TextPromptOptions[] = [];
      const app = dependencies({
        args,
        stdin: input("", true),
        stderrTty: true,
        prompter: prompts({
          names: ["  exact prompt  "],
          inputMessages,
          inputOptions,
        }),
        resolveAlias: async (_path, name) => {
          events.push(`resolve:${name}`);
          return { provider: "claude-cli", model: null };
        },
        runtime: runtime({
          generate: async (provider, model, prompt, _signal, instructions) => {
            events.push(`generate:${provider}:${model}:${prompt}:${instructions}`);
            return "alias-result";
          },
        }),
      });

      results.push({
        exitCode: await runApplication(app.value),
        stdout: app.stdout.text(),
        stderr: app.stderr.text(),
        runtimeCalls: app.runtime.calls,
        inputMessages,
        validatesBlank: inputOptions[0]?.validate?.(" \n "),
        events,
      });
    }

    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toEqual({
      exitCode: 0,
      stdout: "alias-result",
      stderr: "\u001b[0m\n\n",
      runtimeCalls: { discover: 0, list: 0, generate: 1 },
      inputMessages: ["Prompt for Daily · Claude CLI · default model"],
      validatesBlank: "prompt must not be blank.",
      events: [
        "resolve:Daily",
        "generate:claude-cli:null:  exact prompt  :prompted request role",
      ],
    });
  });

  test("keeps prompting when an injected prompter returns blank text", async () => {
    const inputMessages: string[] = [];
    const app = dependencies({
      args: ["daily"],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({
        names: [" \n ", "accepted"],
        inputMessages,
      }),
      resolveAlias: async () => ({ provider: "anthropic", model: "claude-sonnet" }),
      runtime: runtime({
        generate: async (_provider, _model, prompt) => {
          expect(prompt).toBe("accepted");
          return "alias-result";
        },
      }),
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(inputMessages).toEqual([
      "Prompt for daily · Anthropic · claude-sonnet",
      "Prompt for daily · Anthropic · claude-sonnet",
    ]);
    expect(app.runtime.calls.generate).toBe(1);
  });

  test("resolves alias failures before opening the one-shot input prompt", async () => {
    const inputMessages: string[] = [];
    const app = dependencies({
      args: ["missing"],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({ names: ["must not be read"], inputMessages }),
      resolveAlias: async () => {
        throw new AliasStoreError("alias not found: missing");
      },
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(inputMessages).toEqual([]);
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 0 });
    expect(app.stdout.text()).toBe("");
    expect(app.stderr.text()).toBe("config: alias not found: missing\n");
  });

  test("cancels alias-only input with exit 130 before generation", async () => {
    const app = dependencies({
      args: ["daily"],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({ names: [null] }),
      resolveAlias: async () => ({ provider: "openai", model: "gpt-5" }),
    });

    expect(await runApplication(app.value)).toBe(130);
    expect(app.runtime.calls).toEqual({ discover: 0, list: 0, generate: 0 });
    expect(app.stdout.text()).toBe("");
    expect(app.stderr.text()).toBe("");
  });

  test("does not prompt alias-only calls outside the stdin-and-stderr TTY contract", async () => {
    for (const tty of [
      { stdin: true, stderr: false },
      { stdin: false, stderr: true },
    ]) {
      const inputMessages: string[] = [];
      let resolves = 0;
      const app = dependencies({
        args: ["daily"],
        stdin: input("", tty.stdin),
        stderrTty: tty.stderr,
        prompter: prompts({ names: ["must not be read"], inputMessages }),
        resolveAlias: async () => {
          resolves += 1;
          return { provider: "openai", model: "gpt-5" };
        },
      });

      expect(await runApplication(app.value)).toBe(2);
      expect(inputMessages).toEqual([]);
      expect(resolves).toBe(0);
      expect(app.runtime.calls.generate).toBe(0);
      expect(app.stderr.text()).toContain("usage:");
    }
  });

  test("piped input keeps a request instruction separate from the prompt", async () => {
    const app = dependencies({
      args: ["Daily", "--instruction", "piped request role"],
      stdin: input("piped prompt"),
      runtime: runtime({
        generate: async (_provider, _model, prompt, _signal, instructions) => {
          expect(prompt).toBe("piped prompt");
          expect(instructions).toBe("piped request role");
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

  test("redacts raw and serialized request instructions from runtime failures", async () => {
    const instruction = 'temporary\n  Use "quotes" and \\slashes.  ';
    const serialized = JSON.stringify(instruction);
    const escaped = serialized.slice(1, -1);
    const sensitive = createSensitiveValueRegistry();
    const gateway = createRuntimeGateway({
      env: {},
      credentialResolver: createCredentialResolver({
        env: {},
        vault: {
          get: async () => null,
          set: async () => undefined,
          delete: async () => false,
        },
        vaultEnabled: false,
      }),
      sensitive,
      createProvider: (config) => ({
        id: config.provider,
        label: "Fake",
        requiresNetwork: false,
        requiresDownload: false,
        async testConnection() { return { ok: true, message: "ok" }; },
        async listModels() { return []; },
        async generateText() {
          throw new Error(`raw=${instruction} serialized=${serialized} escaped=${escaped}`);
        },
      }),
    });
    const app = dependencies({
      args: [
        "--input",
        "hello",
        "--provider",
        "ollama",
        "--model",
        "qwen",
        "--instruction",
        instruction,
      ],
      runtime: { value: gateway, calls: { discover: 0, list: 0, generate: 0 } },
      sensitive,
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(app.stdout.text()).toBe("");
    expect(app.stderr.text()).not.toContain(instruction);
    expect(app.stderr.text()).not.toContain(serialized);
    expect(app.stderr.text()).not.toContain(escaped);
    expect(app.stderr.text()).toContain("generation (ollama):");
    expect(app.stderr.text()).toContain("[REDACTED]");
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

  test("cancelling post-generation instruction entry preserves the response without saving", async () => {
    let saves = 0;
    const app = dependencies({
      args: ["--input", "hello"],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({
        choices: ["ollama", "qwen"],
        names: ["daily"],
        instructions: [null],
      }),
      saveAlias: async () => {
        saves += 1;
        return "saved";
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(app.stdout.text()).toBe("response");
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
    const savedNames: string[] = [];
    const app = dependencies({
      args: ["--input", "hello", "--provider", "openai", "--model", "gpt-5"],
      stdin: input("", true),
      stderrTty: true,
      prompter: prompts({ names: ["FAST"], instructions: ["post generation role"] }),
      saveAlias: async (_path, name, selection) => {
        savedNames.push(name);
        expect(selection.instructions).toBe("post generation role");
        return "saved";
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(savedNames).toEqual(["fast"]);
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
      prompter: prompts({ names: ["Fast"] }),
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
      "Overwrite alias daily?\nOld: Ollama · old\nNew: Ollama · qwen\nInstructions: unchanged",
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

  test("saves the provider key before offering an optional model shortcut", async () => {
    const candidate = "u4-add-candidate-sentinel";
    const events: string[] = [];
    const seen: Array<{ message: string; options: PromptOption[] }> = [];
    const confirmInitialValues: Array<boolean | undefined> = [];
    const promptFlow: string[] = [];
    const basePrompter = prompts({
      choices: ["launcher:manage-connections", "setup:manage-api-keys", "openai", true, "gpt-5"],
      passwords: [candidate],
      names: ["FAST"],
      instructions: ["managed role"],
      confirms: [true],
      seen,
      confirmInitialValues,
    });
    const app = management({
      events,
      prompter: {
        ...basePrompter,
        select: async (...args) => {
          promptFlow.push(`select:${args[0]}`);
          return basePrompter.select(...args);
        },
        confirm: async (...args) => {
          promptFlow.push(`confirm:${args[0]}`);
          return basePrompter.confirm(...args);
        },
      },
      runtime: runtime({
        providers: [],
        validateCredential: async (_provider, value) => {
          events.push(`validate:${value}`);
          return [{ id: "gpt-5", label: "GPT-5" }];
        },
      }),
      saveAlias: async (_path, name, selection, options) => {
        const persist = async (): Promise<SaveAliasResult> => {
          events.push(`alias:${name}:${selection.provider}:${selection.model}:${selection.instructions}`);
          expect(Object.keys(selection).sort()).toEqual(["instructions", "model", "provider"]);
          expect(JSON.stringify(selection)).not.toContain(candidate);
          return "saved";
        };
        return options?.persistenceGuard?.(persist) ?? persist();
      },
    });
    const invalidations: string[] = [];
    const invalidate = app.resolver.invalidate?.bind(app.resolver);
    app.resolver.invalidate = (provider) => {
      invalidations.push(provider);
      invalidate?.(provider);
    };
    const writeStderr = app.stderr.write.bind(app.stderr);
    app.stderr.write = (chunk, callback) => {
      if (chunk.includes("API key verified")) promptFlow.push("receipt");
      writeStderr(chunk, callback);
    };

    expect(await runApplication(app.value)).toBe(0);
    expect(events.slice(0, 4)).toEqual([
      "get:openai",
      `validate:${candidate}`,
      "get:openai",
      "set:openai",
    ]);
    expect(events.at(-1)).toBe("alias:fast:openai:gpt-5:managed role");
    expect(events.filter((event) => event.startsWith("get:"))).toHaveLength(
      11 + CLOUD_CREDENTIAL_PROVIDERS.length,
    );
    expect(app.events.filter((event) => event === "set:openai")).toHaveLength(1);
    expect(invalidations).toEqual(["openai"]);
    expect(confirmInitialValues).toEqual([false]);
    expect(promptFlow).toEqual([
      "select:What would you like to do?",
      "select:What would you like to manage?",
      "select:Choose an API-key provider",
      "confirm:Save this verified OpenAI API key?",
      "receipt",
      "select:Create a model shortcut now?",
      "select:Choose a model for the shortcut",
    ]);
    expect(
      seen.find((prompt) => prompt.message === "Create a model shortcut now?")?.options,
    ).toEqual([
      { value: false, label: "Not now" },
      { value: true, label: "Choose a model…" },
    ]);
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
        choices: [
          "launcher:manage-connections",
          "setup:manage-api-keys",
          "openai",
          true,
          "safe-model",
        ],
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
      prompter: prompts({ choices: ["launcher:run-shortcut", null], seen }),
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
        choices: ["launcher:manage-connections", "setup:manage-api-keys", "openai"],
        passwords: [" bad-secret ", null],
      }),
      runtime: runtime({ providers: [] }),
    });
    expect(await runApplication(invalid.value)).toBe(130);
    expect(invalid.events).toEqual(["get:openai"]);
    expect(invalid.stderr.text()).not.toContain("API key verified");

    const old = "u4-old-validation-sentinel";
    const candidate = "u4-invalid-provider-sentinel";
    const failed = management({
      initial: old,
      prompter: prompts({
        choices: [
          "launcher:manage-connections",
          "setup:manage-api-keys",
          "openai",
          "replace",
        ],
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
    expect(failed.stderr.text()).not.toContain("API key verified");
  });

  test("declining replacement intent requests no password, while set failure preserves the old key", async () => {
    const passwordMessages: string[] = [];
    const declined = management({
      initial: "u4-old-decline-sentinel",
      prompter: prompts({
        choices: [
          "launcher:manage-connections",
          "setup:manage-api-keys",
          "openai",
          "replace",
        ],
        confirms: [false],
        passwordMessages,
      }),
      runtime: runtime({ providers: [] }),
    });
    expect(await runApplication(declined.value)).toBe(0);
    expect(passwordMessages).toEqual([]);
    expect(declined.events).toEqual(["get:openai"]);
    expect(declined.stderr.text()).not.toContain("API key verified");

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
        choices: [
          "launcher:manage-connections",
          "setup:manage-api-keys",
          "openai",
          "replace",
        ],
        confirms: [true, true],
        passwords: [replacement],
      }),
      runtime: runtime({ providers: [] }),
    });
    expect(await runApplication(failed.value)).toBe(1);
    expect(failed.stored()).toBe(old);
    expect(failed.events).toEqual(["get:openai", "get:openai", "set:openai"]);
    expect(failed.stderr.text()).toContain(
      "Secure API-key storage isn’t available in this Linux session.",
    );
    expect(failed.stderr.text()).toContain(
      "llm-now couldn’t save the API key securely.",
    );
    expect(failed.stderr.text()).toContain("Use an api key (not saved by llm-now):");
    expect(failed.stderr.text()).toContain("To save API keys securely:");
    expect(failed.stderr.text()).not.toContain(
      "credential vault set (openai): unavailable",
    );
    expect(failed.stderr.text()).toContain("OPENAI_API_KEY");
    expect(failed.stderr.text()).toContain("Secret Service");
    expect(failed.stderr.text()).not.toContain(old);
    expect(failed.stderr.text()).not.toContain(replacement);
    expect(failed.stderr.text()).not.toContain("API key verified");
  });

  test("offers safe Linux remediation when the credential vault is unavailable", async () => {
    const backendDetail = "cannot open display: vault-backend-detail";
    const app = management({
      getError: new CredentialVaultError(
        "get",
        "openrouter",
        new Error(backendDetail),
      ),
      prompter: prompts({
        choices: ["launcher:manage-connections", "setup:manage-api-keys", "openrouter"],
      }),
      runtime: runtime({ providers: [] }),
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(app.events).toEqual(["get:openrouter"]);
    const colors = pc.createColors(true);
    expect(app.stderr.text()).toContain(colors.bold(colors.red("Error:")));
    expect(app.stderr.text()).toContain(colors.bold(colors.greenBright("Tip:")));
    expect(app.stderr.text()).toContain(
      "Secure API-key storage isn’t available in this Linux session.",
    );
    expect(app.stderr.text()).toContain(
      "llm-now couldn’t access the saved API key.",
    );
    expect(app.stderr.text()).toContain("Use an api key (not saved by llm-now):");
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

    const plain = management({
      getError: new CredentialVaultError("get", "openrouter", new Error("unavailable")),
      env: { NO_COLOR: "1" },
      prompter: prompts({
        choices: ["launcher:manage-connections", "setup:manage-api-keys", "openrouter"],
      }),
      runtime: runtime({ providers: [] }),
    });
    expect(await runApplication(plain.value)).toBe(1);
    expect(plain.stderr.text()).not.toContain("\u001b");
    expect(plain.stderr.text()).toContain("Error:");
    expect(plain.stderr.text()).toContain("Tip:");
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
        choices: [
          "launcher:manage-connections",
          "setup:manage-api-keys",
          "openai",
          "delete",
        ],
        confirms: [true],
      }),
      runtime: runtime({ providers: [] }),
    });

    expect(await runApplication(app.value)).toBe(1);
    expect(app.events).toEqual(["get:openai", "get:openai", "delete:openai"]);
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
        choices: [
          "launcher:manage-connections",
          "setup:manage-api-keys",
          "openai",
          "replace",
          false,
        ],
        confirms: [true, true],
        passwords: [replacement],
      }),
      runtime: runtime({ providers: [] }),
    });
    const invalidations: string[] = [];
    app.resolver.invalidate = (provider) => { invalidations.push(provider); };

    expect(await runApplication(app.value)).toBe(0);
    expect(app.events).toEqual(["get:openai", "get:openai", "set:openai"]);
    expect(app.stored()).toBe(replacement);
    expect(invalidations).toEqual(["openai"]);
    expect(`${app.stdout.text()}${app.stderr.text()}`).not.toContain(old);
    expect(`${app.stdout.text()}${app.stderr.text()}`).not.toContain(replacement);
  });

  test("cancellation at operation and replacement/delete consent mutates nothing", async () => {
    const scenarios = [
      {
        choices: ["launcher:manage-connections", "setup:manage-api-keys", "openai", null],
        confirms: [],
      },
      {
        choices: [
          "launcher:manage-connections",
          "setup:manage-api-keys",
          "openai",
          "replace",
        ],
        confirms: [null],
      },
      {
        choices: [
          "launcher:manage-connections",
          "setup:manage-api-keys",
          "openai",
          "delete",
        ],
        confirms: [null],
      },
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
      expect(app.stderr.text()).not.toContain("API key verified");
    }
  });

  test("final save decline and cancellation mutate nothing", async () => {
    for (const decision of [false, null] as const) {
      const app = management({
        prompter: prompts({
          choices: ["launcher:manage-connections", "setup:manage-api-keys", "openai"],
          passwords: ["u4-final-decision-sentinel"],
          confirms: [decision],
        }),
        runtime: runtime({ providers: [] }),
      });
      expect(await runApplication(app.value)).toBe(decision === null ? 130 : 0);
      expect(app.events).toEqual(["get:openai"]);
      expect(app.stored()).toBeNull();
      expect(app.stderr.text()).not.toContain("API key verified");
    }
  });

  test("cancelling optional shortcut decisions keeps the committed provider credential", async () => {
    const candidate = "u4-alias-cancel-sentinel";
    const cases = [
      {
        prompter: prompts({
          choices: ["launcher:manage-connections", "setup:manage-api-keys", "openai", null],
          passwords: [candidate],
          confirms: [true],
        }),
      },
      {
        prompter: prompts({
          choices: [
            "launcher:manage-connections",
            "setup:manage-api-keys",
            "openai",
            true,
            null,
          ],
          passwords: [candidate],
          confirms: [true],
        }),
      },
      {
        prompter: prompts({
          choices: [
            "launcher:manage-connections",
            "setup:manage-api-keys",
            "openai",
            true,
            "qwen",
          ],
          passwords: [candidate],
          names: [null],
          confirms: [true],
        }),
      },
      {
        prompter: prompts({
          choices: [
            "launcher:manage-connections",
            "setup:manage-api-keys",
            "openai",
            true,
            "qwen",
          ],
          passwords: [candidate],
          names: ["fast"],
          instructions: [null],
          confirms: [true],
        }),
      },
      {
        prompter: prompts({
          choices: [
            "launcher:manage-connections",
            "setup:manage-api-keys",
            "openai",
            true,
            "qwen",
          ],
          passwords: [candidate],
          names: ["fast"],
          confirms: [true, null],
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
      expect(await runApplication(app.value)).toBe(0);
      expect(app.events).toEqual(["get:openai", "get:openai", "set:openai"]);
      expect(app.stored()).toBe(candidate);
      expect(app.stderr.text()).toContain("API key verified");
    }
  });

  test("an empty model list is authentication success and saves without alias prompts", async () => {
    const inputMessages: string[] = [];
    let aliasSaves = 0;
    const app = management({
      prompter: prompts({
        choices: ["launcher:manage-connections", "setup:manage-api-keys", "openai"],
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
    expect(app.events).toEqual(["get:openai", "get:openai", "set:openai"]);
    expect(inputMessages).toEqual([]);
    expect(aliasSaves).toBe(0);
    expect(app.stderr.text()).toContain("returned no models");
  });

  test("delete is default-No, provider-scoped, idempotent, invalidates, and explains env precedence", async () => {
    const initialValues: Array<boolean | undefined> = [];
    const declined = management({
      initial: "u4-delete-decline-sentinel",
      prompter: prompts({
        choices: [
          "launcher:manage-connections",
          "setup:manage-api-keys",
          "openai",
          "delete",
        ],
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
        choices: [
          "launcher:manage-connections",
          "setup:manage-api-keys",
          "openai",
          "delete",
        ],
        confirms: [true],
      }),
      runtime: runtime({ providers: [] }),
    });
    const invalidations: string[] = [];
    deleted.resolver.invalidate = (provider) => { invalidations.push(provider); };
    expect(await runApplication(deleted.value)).toBe(0);
    expect(deleted.events).toEqual(["get:openai", "get:openai", "delete:openai"]);
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
      choices: [
        "launcher:manage-connections",
        "setup:manage-api-keys",
        "openai",
        "delete",
      ],
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
      choices: [
        "launcher:manage-connections",
        "setup:manage-api-keys",
        "openai",
        true,
        "qwen",
      ],
      passwords: [candidate],
      names: ["fast"],
      confirms: [true],
    });
    const wrapped: ApplicationPrompter = {
      select: async (...args) => { promptEvents.push("select"); return base.select(...args); },
      input: async (...args) => { promptEvents.push("input"); return base.input(...args); },
      instruction: async (...args) => {
        promptEvents.push("instruction");
        return base.instruction(...args);
      },
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
    expect((app.stderr.text().match(/API key verified/g) ?? [])).toHaveLength(1);
    expect(app.stderr.text()).toContain("◆ OpenAI · API key verified");
    expect(app.stderr.text()).toContain("  stored as: saved credential\n");
    expect(app.stderr.text()).toContain("alias was not saved");
    expect(app.stderr.text()).not.toContain(candidate);
  });

  test("confirms alias overwrite after saving the provider credential", async () => {
    const confirmMessages: string[] = [];
    const app = management({
      prompter: prompts({
        choices: [
          "launcher:manage-connections",
          "setup:manage-api-keys",
          "openai",
          true,
          "qwen",
        ],
        passwords: ["u4-alias-preflight-sentinel"],
        names: ["FAST"],
        confirms: [true, true],
        confirmMessages,
      }),
      runtime: runtime({ providers: [] }),
      loadAliases: async () => ({
        version: 1,
        aliases: { fast: { provider: "openai", model: "old-model" } },
      }),
      saveAlias: async (_path, name, _selection, options) => {
        expect(name).toBe("fast");
        expect(await options?.confirmOverwrite?.(
          "fast",
          { provider: "openai", model: "old-model" },
        )).toBe(true);
        return "saved";
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(confirmMessages).toHaveLength(2);
    expect(confirmMessages[0]).toBe("Save this verified OpenAI API key?");
    expect(confirmMessages[1]).toContain("Overwrite alias fast?");
    expect(app.events).toEqual(["get:openai", "get:openai", "set:openai"]);
  });

  test("treats inherited alias names as absent during credential preflight", async () => {
    const confirmMessages: string[] = [];
    const savedNames: string[] = [];
    const app = management({
      prompter: prompts({
        choices: [
          "launcher:manage-connections",
          "setup:manage-api-keys",
          "openai",
          true,
          "qwen",
        ],
        passwords: ["prototype-alias-sentinel"],
        names: ["constructor"],
        confirms: [true],
        confirmMessages,
      }),
      runtime: runtime({ providers: [] }),
      loadAliases: async () => ({ version: 1, aliases: {} }),
      saveAlias: async (_path, name) => {
        savedNames.push(name);
        return "saved";
      },
    });

    expect(await runApplication(app.value)).toBe(0);
    expect(confirmMessages).toHaveLength(1);
    expect(confirmMessages[0]).toBe("Save this verified OpenAI API key?");
    expect(savedNames).toEqual(["constructor"]);
  });

  test("disabled target returns environment-only guidance without reading the vault", async () => {
    const app = management({
      enabled: false,
      prompter: prompts({
        choices: ["launcher:manage-connections", "setup:manage-api-keys", "openai"],
      }),
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
        choices: [
          "launcher:manage-connections",
          "setup:manage-api-keys",
          "openai",
          false,
        ],
        passwords: [candidate],
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

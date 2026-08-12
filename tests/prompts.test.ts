import { describe, expect, test } from "bun:test";
import type { ByokModelOption, ByokProviderId } from "@swartzrock/byok-runtime";
import { PassThrough } from "node:stream";
import { RuntimeStageError, type RuntimeGateway } from "../src/runtime.ts";
import { promptValidationMessage } from "../src/io.ts";
import {
  createSearchablePrompter,
  createTerminalColors,
  formatAliasInventory,
  formatSelection,
  NO_PROVIDER_DIAGNOSTIC,
  selectAlias,
  selectAliasOrFresh,
  selectProviderAndModel,
  stripTerminalSequences,
  validateCredentialCandidate,
  type PromptOption,
  type PromptValue,
  type SearchablePrompter,
} from "../src/prompts.ts";

function gateway(options: {
  providers?: ByokProviderId[];
  models?: Partial<Record<ByokProviderId, ByokModelOption[] | Error>>;
}) {
  const listed: ByokProviderId[] = [];
  const value: RuntimeGateway = {
    discover: async () => options.providers ?? [],
    listModels: async (provider) => {
      listed.push(provider);
      const result = options.models?.[provider] ?? [];
      if (result instanceof Error) throw result;
      return result;
    },
    validateCredential: async () => [],
    generate: async () => "unused",
  };
  return { value, listed };
}

function choices(
  ...answers: Array<PromptValue | null>
): SearchablePrompter & { messages: string[]; seen: PromptOption[][] } {
  const messages: string[] = [];
  const seen: PromptOption[][] = [];
  return {
    messages,
    seen,
    select: async (message, options) => {
      messages.push(message);
      seen.push([...options]);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("unexpected prompt");
      return answer;
    },
    input: async () => {
      throw new Error("unexpected input prompt");
    },
    instruction: async () => {
      throw new Error("unexpected instruction prompt");
    },
    password: async () => {
      throw new Error("unexpected password prompt");
    },
    confirm: async () => {
      throw new Error("unexpected confirmation prompt");
    },
  };
}

describe("terminal alias selection", () => {
  test("shows workspace state without exposing saved paths", () => {
    const workspace = {
      primaryDirectory: "/Users/test/secret-project",
      additionalDirectories: ["/Users/test/shared-one", "/Users/test/shared two"],
    };

    expect(formatSelection({ provider: "codex-cli", model: null, workspace })).toBe(
      "Codex CLI · default model · workspace +2",
    );
    const inventory = formatAliasInventory({
      daily: { provider: "codex-cli", model: null, workspace },
      plain: { provider: "ollama", model: "llama3" },
    });
    expect(inventory).toContain("daily → Codex CLI · provider default · workspace +2");
    expect(inventory).toContain("plain → Ollama · llama3");
    expect(inventory).not.toContain("/Users/test");
  });

  test("presents sorted sanitized aliases only and returns the exact alias snapshot", async () => {
    const unsafeAlias = "\u001b[31mZulu-secret";
    const aliases = {
      [unsafeAlias]: { provider: "openai", model: "gpt-secret\u0000" },
      Alpha: { provider: "claude-cli", model: null },
    } as const;
    const prompter = choices(unsafeAlias);

    const result = await selectAlias(
      aliases,
      prompter,
      (alias, selection) => ({
        label: alias.replaceAll("secret", "[redacted]"),
        hint: formatSelection(selection).replaceAll("secret", "[redacted]"),
      }),
    );

    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") throw new Error("expected selected alias");
    expect(result.alias).toBe(unsafeAlias);
    expect(result.selection).toBe(aliases[unsafeAlias]);
    expect(prompter.messages).toEqual(["Choose a saved shortcut"]);
    expect(prompter.seen).toEqual([[
      { value: "Alpha", label: "Alpha", hint: "Claude CLI · default model" },
      {
        value: unsafeAlias,
        label: "Zulu-[redacted]",
        hint: "OpenAI · gpt-[redacted]",
      },
    ]]);
  });

  test("normalizes cancellation and rejects values outside the offered aliases", async () => {
    const aliases = {
      daily: { provider: "anthropic", model: "claude-sonnet" },
    } as const;

    expect(await selectAlias(aliases, choices(null))).toEqual({
      kind: "cancelled",
      exitCode: 130,
    });
    expect(selectAlias(aliases, choices("missing"))).rejects.toThrow(
      "Prompter returned an invalid alias choice.",
    );
  });

  test("keeps the mixed alias picker fresh-model escape path", async () => {
    const prompter = choices(false);

    expect(
      await selectAliasOrFresh(
        { daily: { provider: "anthropic", model: "claude-sonnet" } },
        prompter,
      ),
    ).toEqual({ kind: "fresh" });
    expect(prompter.messages).toEqual(["Choose an alias"]);
    expect(prompter.seen[0]?.at(-1)).toEqual({
      value: false,
      label: "Select a new provider and model…",
    });
  });

  test("returns the canonical alias with a mixed-picker selection", async () => {
    const aliases = {
      Daily: { provider: "anthropic", model: "claude-sonnet" },
    } as const;

    expect(await selectAliasOrFresh(aliases, choices("Daily"))).toEqual({
      kind: "selected",
      alias: "Daily",
      selection: aliases.Daily,
    });
  });
});

describe("terminal provider and model selection", () => {
  test("presents provider then model choices and returns the selected pair", async () => {
    const runtime = gateway({
      providers: ["ollama", "claude-cli"],
      models: { "claude-cli": [{ id: "sonnet", label: "Claude Sonnet" }] },
    });
    const diagnostics: string[] = [];
    const prompter = choices("claude-cli", "sonnet");

    const result = await selectProviderAndModel({
      runtime: runtime.value,
      prompter,
      diagnostic: (text) => diagnostics.push(text),
    });

    expect(result).toEqual({
      kind: "selected",
      provider: "claude-cli",
      model: "sonnet",
    });
    expect(runtime.listed).toEqual(["claude-cli"]);
    expect(prompter.seen).toEqual([
      [
        { value: "claude-cli", label: "Claude CLI", hint: "authenticated CLI · available" },
        { value: "ollama", label: "Ollama", hint: "local server · available" },
      ],
      [{ value: "sonnet", label: "Claude Sonnet", hint: "sonnet" }],
    ]);
    expect(diagnostics).toEqual([]);
  });

  test("preserves the established Gemini label after runtime metadata removal", async () => {
    const prompter = choices("google", "gemini-2.5-pro");

    await selectProviderAndModel({
      runtime: gateway({
        providers: ["google"],
        models: { google: [{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }] },
      }).value,
      prompter,
      diagnostic: () => {},
    });

    expect(prompter.seen[0]?.[0]?.label).toBe("Gemini");
    expect(formatSelection({ provider: "google", model: "gemini-2.5-pro" })).toBe(
      "Gemini · gemini-2.5-pro",
    );
  });

  test("empty discovery emits every required checked state and next step", async () => {
    const diagnostics: string[] = [];
    const result = await selectProviderAndModel({
      runtime: gateway({}).value,
      prompter: choices(),
      diagnostic: (text) => diagnostics.push(text),
    });

    expect(result).toEqual({ kind: "failed", exitCode: 1, stage: "discovery" });
    expect(diagnostics.join("\n")).toBe(NO_PROVIDER_DIAGNOSTIC);
    expect(NO_PROVIDER_DIAGNOSTIC).toContain("127.0.0.1:11434");
    expect(NO_PROVIDER_DIAGNOSTIC).toContain("127.0.0.1:1234");
    expect(NO_PROVIDER_DIAGNOSTIC).toContain("codex");
    expect(NO_PROVIDER_DIAGNOSTIC).toContain("claude");
    for (const provider of [
      "Anthropic",
      "OpenAI",
      "Google",
      "xAI",
      "OpenRouter",
      "Groq",
      "Mistral",
      "DeepSeek",
      "DeepInfra",
    ]) {
      expect(NO_PROVIDER_DIAGNOSTIC).toContain(provider);
    }
    expect(NO_PROVIDER_DIAGNOSTIC).toContain("without printing values");
  });

  test("cancellation at either menu returns 130", async () => {
    const runtime = gateway({
      providers: ["ollama"],
      models: { ollama: [{ id: "qwen", label: "Qwen" }] },
    });
    expect(
      await selectProviderAndModel({
        runtime: runtime.value,
        prompter: choices(null),
        diagnostic: () => {},
      }),
    ).toEqual({ kind: "cancelled", exitCode: 130 });
    expect(
      await selectProviderAndModel({
        runtime: runtime.value,
        prompter: choices("ollama", null),
        diagnostic: () => {},
      }),
    ).toEqual({ kind: "cancelled", exitCode: 130 });
  });

  test("model-list failure returns to remaining provider choices", async () => {
    const runtime = gateway({
      providers: ["ollama", "openai"],
      models: {
        ollama: new RuntimeStageError("model-list", "ollama", "offline"),
        openai: [{ id: "gpt-5", label: "GPT-5" }],
      },
    });
    const diagnostics: string[] = [];

    const prompter = choices("ollama", "openai", "gpt-5");
    const result = await selectProviderAndModel({
      runtime: runtime.value,
      prompter,
      diagnostic: (text) => diagnostics.push(text),
    });

    expect(result).toEqual({ kind: "selected", provider: "openai", model: "gpt-5" });
    expect(runtime.listed).toEqual(["ollama", "openai"]);
    expect(prompter.seen[0]).toEqual([
      { value: "ollama", label: "Ollama", hint: "local server · available" },
      { value: "openai", label: "OpenAI", hint: "API key · available" },
    ]);
    expect(prompter.seen[1]).toEqual([
      { value: "openai", label: "OpenAI", hint: "API key · available" },
    ]);
    expect(diagnostics.join("\n")).toContain("model-list (ollama)");
  });

  test("offers default model only for supported CLI providers", async () => {
    const prompter = choices("codex-cli", false);
    const cli = await selectProviderAndModel({
      runtime: gateway({ providers: ["codex-cli"] }).value,
      prompter,
      diagnostic: () => {},
    });
    expect(cli).toEqual({ kind: "selected", provider: "codex-cli", model: null });
    expect(prompter.seen[1]).toEqual([{ value: false, label: "default model" }]);
    expect(formatSelection({ provider: "codex-cli", model: null })).toBe(
      "Codex CLI · default model",
    );
    expect(formatSelection({ provider: "codex-cli", model: "gpt-5" })).toBe(
      "Codex CLI · gpt-5",
    );

    const diagnostics: string[] = [];
    const requiredModel = await selectProviderAndModel({
      runtime: gateway({ providers: ["ollama"] }).value,
      prompter: choices("ollama"),
      diagnostic: (text) => diagnostics.push(text),
    });
    expect(requiredModel).toEqual({ kind: "failed", exitCode: 1, stage: "model-list" });
    expect(diagnostics.join("\n")).toContain("returned no models");
  });

  test("sorts copied provider/model options and preserves canonical model identity", async () => {
    const runtime = gateway({
      providers: ["openai", "anthropic"],
      models: {
        openai: [
          { id: "z-model", label: "Same" },
          { id: "a-model", label: "same" },
        ],
      },
    });
    const prompter = choices("openai", "z-model");

    expect(
      await selectProviderAndModel({
        runtime: runtime.value,
        prompter,
        diagnostic: () => {},
      }),
    ).toEqual({ kind: "selected", provider: "openai", model: "z-model" });

    expect(prompter.seen[0]).toEqual([
      { value: "anthropic", label: "Anthropic", hint: "API key · available" },
      { value: "openai", label: "OpenAI", hint: "API key · available" },
    ]);
    expect(prompter.seen[1]?.map((option) => option.value)).toEqual(["a-model", "z-model"]);
  });

  test("shows a model id as a hint only when it adds information", async () => {
    const prompter = choices("ollama", "qwen3.5:9b");
    await selectProviderAndModel({
      runtime: gateway({
        providers: ["ollama"],
        models: {
          ollama: [
            { id: "qwen3.5:9b", label: "QWEN3.5:9B" },
            { id: "deepcoder:1.5b", label: "DeepCoder" },
          ],
        },
      }).value,
      prompter,
      diagnostic: () => {},
    });

    expect(prompter.seen[1]).toEqual([
      { value: "deepcoder:1.5b", label: "DeepCoder", hint: "deepcoder:1.5b" },
      { value: "qwen3.5:9b", label: "QWEN3.5:9B" },
    ]);
  });

  test("removes terminal controls from runtime-owned option text", async () => {
    const prompter = choices("openai", "gpt");
    await selectProviderAndModel({
      runtime: gateway({
        providers: ["openai"],
        models: { openai: [{ id: "gpt", label: "\u001b[31mGPT\u0000" }] },
      }).value,
      prompter,
      diagnostic: () => {},
    });

    expect(prompter.seen[1]?.[0]?.label).toBe("GPT");
  });

  test("applies an optional model predicate before constructing creation options", async () => {
    const prompter = choices("openai", "safe-model");
    const diagnostics: string[] = [];
    const result = await selectProviderAndModel({
      runtime: gateway({
        providers: ["openai"],
        models: {
          openai: [
            { id: "unsafe-secret", label: "Unsafe secret" },
            { id: "safe-model", label: "Safe model" },
          ],
        },
      }).value,
      prompter,
      diagnostic: (text) => diagnostics.push(text),
      modelEligible: (model) => !model.id.includes("secret"),
    });

    expect(result).toEqual({ kind: "selected", provider: "openai", model: "safe-model" });
    expect(prompter.seen[1]).toEqual([
      { value: "safe-model", label: "Safe model", hint: "safe-model" },
    ]);
    expect(diagnostics).toEqual([]);
  });

  test("reports an explicit failure when creation has no eligible model", async () => {
    const prompter = choices("openai");
    const diagnostics: string[] = [];
    const result = await selectProviderAndModel({
      runtime: gateway({
        providers: ["openai"],
        models: { openai: [{ id: "unsafe-secret", label: "Unsafe secret" }] },
      }).value,
      prompter,
      diagnostic: (text) => diagnostics.push(text),
      modelEligible: () => false,
    });

    expect(result).toEqual({ kind: "failed", exitCode: 1, stage: "model-list" });
    expect(prompter.seen).toHaveLength(1);
    expect(diagnostics).toEqual([
      "model-list (openai): provider returned no eligible models.",
    ]);
  });

  test("keeps legacy model choices unchanged when no predicate is supplied", async () => {
    const prompter = choices("openai", "unsafe-secret");
    const result = await selectProviderAndModel({
      runtime: gateway({
        providers: ["openai"],
        models: { openai: [{ id: "unsafe-secret", label: "Unsafe secret" }] },
      }).value,
      prompter,
      diagnostic: () => {},
    });

    expect(result).toEqual({
      kind: "selected",
      provider: "openai",
      model: "unsafe-secret",
    });
    expect(prompter.seen[1]).toEqual([
      { value: "unsafe-secret", label: "Unsafe secret", hint: "unsafe-secret" },
    ]);
  });

  test("real Clack adapter filters provider hints and renders only to its output stream", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk) => rendered += chunk.toString());

    const selected = createSearchablePrompter(input, output).select("Pick a provider", [
      { value: "alpha", label: "Alpha" },
      { value: "openai", label: "OpenAI", hint: "API key · available" },
    ]);
    setTimeout(() => input.write("o\r"), 1);

    expect(await selected).toBe("openai");
    const plain = stripTerminalSequences(rendered);
    expect(plain).toContain("Pick a provider");
    expect(plain).toContain("OpenAI");
    expect(plain).toContain("API key · available");
  });

  test("real Clack adapter normalizes cancellation", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const selected = createSearchablePrompter(input, output).select("Pick", [
      { value: "alpha", label: "Alpha" },
    ]);
    setTimeout(() => input.write("\u0003"), 1);
    expect(await selected).toBeNull();
  });

  test("real Clack adapter normalizes programmatic aborts", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const root = new AbortController();
    const selected = createSearchablePrompter(input, output).select(
      "Pick",
      [{ value: "alpha", label: "Alpha" }],
      root.signal,
    );
    setTimeout(() => root.abort(), 1);

    expect(await selected).toBeNull();
  });

  test("real Clack text input returns blank Enter as the exit value", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const entered = createSearchablePrompter(input, output).input("Alias name");
    setTimeout(() => input.write("\r"), 1);
    expect(await entered).toBe("");
  });

  test("real Clack text input keeps blank validation active until submission", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk) => rendered += chunk.toString());
    const entered = createSearchablePrompter(input, output).input("Prompt", {
      validate: promptValidationMessage,
    });
    setTimeout(() => input.write("\r"), 1);
    setTimeout(() => input.write("  exact prompt  \r"), 10);

    expect(await entered).toBe("  exact prompt  ");
    expect(stripTerminalSequences(rendered)).toContain("prompt must not be blank.");
  });

  test("real instruction input preserves pasted blank lines and a trailing newline", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = "";
    let submitOffset = 0;
    output.on("data", (chunk) => rendered += chunk.toString());
    const candidate = "First instruction paragraph\n\nSecond instruction paragraph\n";
    const entered = createSearchablePrompter(input, output).instruction("Optional instructions");
    setTimeout(() => {
      input.write(candidate.replaceAll("\n", "\r"));
      submitOffset = rendered.length;
      input.write("\t\r");
    }, 1);

    expect(await entered).toBe(candidate);
    expect(stripTerminalSequences(rendered.slice(0, submitOffset))).toContain(
      "Press Tab to select [ save ], then Enter to save",
    );
    expect(stripTerminalSequences(rendered)).toContain(
      "[ save ] selected — press Enter to save",
    );
    expect(stripTerminalSequences(rendered.slice(0, submitOffset))).toContain("First instruction paragraph");
    expect(stripTerminalSequences(rendered.slice(0, submitOffset))).toContain("Second instruction paragraph");
    expect(stripTerminalSequences(rendered.slice(submitOffset))).not.toContain("First instruction paragraph");
    expect(stripTerminalSequences(rendered.slice(submitOffset))).not.toContain("Second instruction paragraph");
  });

  test("real instruction input submits blank with one Enter", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const entered = createSearchablePrompter(input, output).instruction("Optional instructions");
    setTimeout(() => input.write("\r"), 1);

    expect(await entered).toBe("");
  });

  test("real instruction input clears the active value before cancellation renders", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = "";
    let cancelOffset = 0;
    output.on("data", (chunk) => rendered += chunk.toString());
    const candidate = "u2-cancelled-instruction";
    const entered = createSearchablePrompter(input, output).instruction("Optional instructions");
    setTimeout(() => input.write(candidate), 1);
    setTimeout(() => {
      cancelOffset = rendered.length;
      input.write("\u0003");
    }, 20);

    expect(await entered).toBeNull();
    expect(stripTerminalSequences(rendered.slice(0, cancelOffset))).toContain(candidate);
    expect(stripTerminalSequences(rendered.slice(cancelOffset))).not.toContain(candidate);
  });

  for (const [name, key] of [
    ["Ctrl-C", "\u0003"],
    ["Escape", "\u001b"],
  ] as const) {
    test(`real Clack text input normalizes ${name} cancellation`, async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      const entered = createSearchablePrompter(input, output).input("Prompt", {
        validate: promptValidationMessage,
      });
      setTimeout(() => input.write(key), 1);
      expect(await entered).toBeNull();
    });
  }

  test("validates hidden credential candidates without transforming opaque values", () => {
    expect(validateCredentialCandidate("opaque-key value")).toBeUndefined();
    for (const value of [
      undefined,
      "",
      " leading",
      "trailing ",
      "line\nbreak",
      "nul\0byte",
      "x".repeat(2_049),
      "🙂".repeat(513),
    ]) {
      expect(validateCredentialCandidate(value)).toBeString();
    }
    expect(validateCredentialCandidate("🙂".repeat(512))).toBeUndefined();
  });

  test("real Clack password input returns the candidate without rendering it", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk) => rendered += chunk.toString());
    const candidate = "u3-hidden-sentinel";
    const entered = createSearchablePrompter(input, output).password("API key", {
      validate: validateCredentialCandidate,
    });
    setTimeout(() => input.write(`${candidate}\r`), 1);

    expect(await entered).toBe(candidate);
    expect(rendered).toContain("API key");
    expect(rendered).not.toContain(candidate);
  });

  test("Picocolors follows stderr capability and NO_COLOR", () => {
    expect(createTerminalColors({ isTTY: true }, {}).green("saved")).toContain("\u001b[");
    expect(createTerminalColors({ isTTY: true }, { NO_COLOR: "1" }).green("saved")).toBe("saved");
    expect(createTerminalColors({ isTTY: false }, {}).dim("hint")).toBe("hint");
  });
});

import { describe, expect, test } from "bun:test";
import type { ByokModelOption, ByokProviderId } from "@swartzrock/byok-runtime";
import { PassThrough } from "node:stream";
import { RuntimeStageError, type RuntimeGateway } from "../src/runtime.ts";
import {
  createSearchablePrompter,
  createTerminalColors,
  NO_PROVIDER_DIAGNOSTIC,
  selectProviderAndModel,
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
    generate: async () => "unused",
  };
  return { value, listed };
}

function choices(
  ...answers: Array<PromptValue | null>
): SearchablePrompter & { seen: PromptOption[][] } {
  const seen: PromptOption[][] = [];
  return {
    seen,
    select: async (_message, options) => {
      seen.push([...options]);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("unexpected prompt");
      return answer;
    },
    input: async () => {
      throw new Error("unexpected input prompt");
    },
    confirm: async () => {
      throw new Error("unexpected confirmation prompt");
    },
  };
}

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
    expect(prompter.seen.map((options) => options.map((option) => option.label))).toEqual([
      ["Claude CLI", "Ollama"],
      ["Claude Sonnet"],
    ]);
    expect(diagnostics).toEqual([]);
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
    expect(NO_PROVIDER_DIAGNOSTIC).toContain("Anthropic");
    expect(NO_PROVIDER_DIAGNOSTIC).toContain("OpenRouter");
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

    const result = await selectProviderAndModel({
      runtime: runtime.value,
      prompter: choices("ollama", "openai", "gpt-5"),
      diagnostic: (text) => diagnostics.push(text),
    });

    expect(result).toEqual({ kind: "selected", provider: "openai", model: "gpt-5" });
    expect(runtime.listed).toEqual(["ollama", "openai"]);
    expect(diagnostics.join("\n")).toContain("model-list (ollama)");
  });

  test("offers provider default only for supported CLI providers", async () => {
    const cli = await selectProviderAndModel({
      runtime: gateway({ providers: ["codex-cli"] }).value,
      prompter: choices("codex-cli", false),
      diagnostic: () => {},
    });
    expect(cli).toEqual({ kind: "selected", provider: "codex-cli", model: null });

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

    expect(prompter.seen[0]?.map((option) => option.label)).toEqual(["Anthropic", "OpenAI"]);
    expect(prompter.seen[1]?.map((option) => option.value)).toEqual(["a-model", "z-model"]);
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

  test("real Clack adapter filters by typing and renders only to its output stream", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk) => rendered += chunk.toString());

    const selected = createSearchablePrompter(input, output).select("Pick a model", [
      { value: "alpha", label: "Alpha" },
      { value: "beta", label: "Beta", hint: "b-model" },
    ]);
    setTimeout(() => input.write("b\r"), 1);

    expect(await selected).toBe("beta");
    expect(rendered).toContain("Pick a model");
    expect(rendered).toContain("Beta");
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

  test("real Clack text input returns blank Enter as the exit value", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const entered = createSearchablePrompter(input, output).input("Alias name");
    setTimeout(() => input.write("\r"), 1);
    expect(await entered).toBe("");
  });

  test("Picocolors follows stderr capability and NO_COLOR", () => {
    expect(createTerminalColors({ isTTY: true }, {}).green("saved")).toContain("\u001b[");
    expect(createTerminalColors({ isTTY: true }, { NO_COLOR: "1" }).green("saved")).toBe("saved");
    expect(createTerminalColors({ isTTY: false }, {}).dim("hint")).toBe("hint");
  });
});

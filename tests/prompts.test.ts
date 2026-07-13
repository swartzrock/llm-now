import { describe, expect, test } from "bun:test";
import type { ByokModelOption, ByokProviderId } from "@swartzrock/byok-runtime";
import { RuntimeStageError, type RuntimeGateway } from "../src/runtime.ts";
import {
  NO_PROVIDER_DIAGNOSTIC,
  selectProviderAndModel,
  type NumberedPrompter,
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

function choices(...answers: Array<number | null>): NumberedPrompter {
  return {
    choose: async () => {
      const answer = answers.shift();
      if (answer === undefined) throw new Error("unexpected prompt");
      return answer;
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

    const result = await selectProviderAndModel({
      runtime: runtime.value,
      prompter: choices(1, 0),
      diagnostic: (text) => diagnostics.push(text),
    });

    expect(result).toEqual({
      kind: "selected",
      provider: "claude-cli",
      model: "sonnet",
    });
    expect(runtime.listed).toEqual(["claude-cli"]);
    expect(diagnostics.join("\n")).toContain("Choose a provider");
    expect(diagnostics.join("\n")).toContain("Choose a model");
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
        prompter: choices(0, null),
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
      prompter: choices(0, 0, 0),
      diagnostic: (text) => diagnostics.push(text),
    });

    expect(result).toEqual({ kind: "selected", provider: "openai", model: "gpt-5" });
    expect(runtime.listed).toEqual(["ollama", "openai"]);
    expect(diagnostics.join("\n")).toContain("model-list (ollama)");
  });

  test("offers provider default only for supported CLI providers", async () => {
    const cli = await selectProviderAndModel({
      runtime: gateway({ providers: ["codex-cli"] }).value,
      prompter: choices(0, 0),
      diagnostic: () => {},
    });
    expect(cli).toEqual({ kind: "selected", provider: "codex-cli", model: null });

    const diagnostics: string[] = [];
    const requiredModel = await selectProviderAndModel({
      runtime: gateway({ providers: ["ollama"] }).value,
      prompter: choices(0),
      diagnostic: (text) => diagnostics.push(text),
    });
    expect(requiredModel).toEqual({ kind: "failed", exitCode: 1, stage: "model-list" });
    expect(diagnostics.join("\n")).toContain("returned no models");
  });
});

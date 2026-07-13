import type { ByokProviderId } from "@swartzrock/byok-runtime";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { RuntimeGateway } from "./runtime.ts";

export const NO_PROVIDER_DIAGNOSTIC = `llm-now: discovery: no available provider found.
Local servers: checked Ollama on 127.0.0.1:11434 and LM Studio on 127.0.0.1:1234. Start an already-installed server with a model, then retry.
Authenticated AI CLIs: checked codex and claude on PATH. Install and authenticate a supported CLI separately, then retry.
Environment-backed cloud providers: checked recognized Anthropic, OpenAI, Google, xAI, and OpenRouter key variables without printing values. Export a supported provider key in the shell, then retry.`;

export interface NumberedPrompter {
  choose(message: string, choices: readonly string[]): Promise<number | null>;
}

export type InteractiveSelectionResult =
  | { kind: "selected"; provider: ByokProviderId; model: string | null }
  | { kind: "cancelled"; exitCode: 130 }
  | { kind: "failed"; exitCode: 1; stage: "discovery" | "model-list" };

export interface SelectionDependencies {
  runtime: RuntimeGateway;
  prompter: NumberedPrompter;
  diagnostic(text: string): void;
}

function supportsDefault(provider: ByokProviderId): boolean {
  return provider === "codex-cli" || provider === "claude-cli";
}

function renderMenu(
  diagnostic: (text: string) => void,
  title: string,
  choices: readonly string[],
): void {
  diagnostic(`${title}\n${choices.map((choice, index) => `  ${index + 1}. ${choice}`).join("\n")}`);
}

function validChoice(choice: number | null, length: number): choice is number {
  return choice !== null && Number.isInteger(choice) && choice >= 0 && choice < length;
}

export async function selectProviderAndModel(
  deps: SelectionDependencies,
): Promise<InteractiveSelectionResult> {
  let providers: ByokProviderId[];
  try {
    providers = [...(await deps.runtime.discover())];
  } catch (error) {
    deps.diagnostic(error instanceof Error ? error.message : String(error));
    return { kind: "failed", exitCode: 1, stage: "discovery" };
  }

  if (providers.length === 0) {
    deps.diagnostic(NO_PROVIDER_DIAGNOSTIC);
    return { kind: "failed", exitCode: 1, stage: "discovery" };
  }

  while (providers.length > 0) {
    const providerLabels = providers.map((provider) => provider);
    renderMenu(deps.diagnostic, "Choose a provider:", providerLabels);
    const providerChoice = await deps.prompter.choose("Choose a provider:", providerLabels);
    if (providerChoice === null) return { kind: "cancelled", exitCode: 130 };
    if (!validChoice(providerChoice, providers.length)) {
      throw new RangeError("Prompter returned an invalid provider choice.");
    }

    const provider = providers[providerChoice];
    if (provider === undefined) throw new RangeError("Provider choice was unavailable.");

    let models;
    try {
      models = await deps.runtime.listModels(provider);
    } catch (error) {
      deps.diagnostic(error instanceof Error ? error.message : String(error));
      providers = providers.filter((candidate) => candidate !== provider);
      if (providers.length === 0) {
        return { kind: "failed", exitCode: 1, stage: "model-list" };
      }
      continue;
    }

    if (models.length === 0) {
      if (!supportsDefault(provider)) {
        deps.diagnostic(`model-list (${provider}): provider returned no models.`);
        providers = providers.filter((candidate) => candidate !== provider);
        if (providers.length === 0) {
          return { kind: "failed", exitCode: 1, stage: "model-list" };
        }
        continue;
      }

      const defaultChoices = ["provider default"];
      renderMenu(deps.diagnostic, "Choose a model:", defaultChoices);
      const defaultChoice = await deps.prompter.choose("Choose a model:", defaultChoices);
      if (defaultChoice === null) return { kind: "cancelled", exitCode: 130 };
      if (!validChoice(defaultChoice, defaultChoices.length)) {
        throw new RangeError("Prompter returned an invalid model choice.");
      }
      return { kind: "selected", provider, model: null };
    }

    const modelLabels = models.map((model) => model.label);
    renderMenu(deps.diagnostic, "Choose a model:", modelLabels);
    const modelChoice = await deps.prompter.choose("Choose a model:", modelLabels);
    if (modelChoice === null) return { kind: "cancelled", exitCode: 130 };
    if (!validChoice(modelChoice, models.length)) {
      throw new RangeError("Prompter returned an invalid model choice.");
    }
    const model = models[modelChoice];
    if (model === undefined) throw new RangeError("Model choice was unavailable.");
    return { kind: "selected", provider, model: model.id };
  }

  return { kind: "failed", exitCode: 1, stage: "model-list" };
}

export function createNumberedPrompter(input: Readable, output: Writable): NumberedPrompter {
  return {
    async choose(_message, choices) {
      const readline = createInterface({ input, output });
      try {
        while (true) {
          let answer: string;
          try {
            answer = (await readline.question("Selection (q to cancel): ")).trim();
          } catch {
            return null;
          }
          if (answer === "q" || answer === "quit") return null;
          const selected = Number(answer);
          if (Number.isInteger(selected) && selected >= 1 && selected <= choices.length) {
            return selected - 1;
          }
          output.write(`Choose a number from 1 to ${choices.length}, or q to cancel.\n`);
        }
      } finally {
        readline.close();
      }
    },
  };
}

import {
  byokProviderDefinition,
  type ByokProviderId,
} from "@swartzrock/byok-runtime";
import {
  autocomplete,
  confirm as clackConfirm,
  isCancel,
  text as clackText,
} from "@clack/prompts";
import pc from "picocolors";
import type { Readable, Writable } from "node:stream";
import type { AliasRecord } from "./aliases.ts";
import type { RuntimeGateway } from "./runtime.ts";

export const NO_PROVIDER_DIAGNOSTIC = `llm-now: discovery: no available provider found.
Local servers: checked Ollama on 127.0.0.1:11434 and LM Studio on 127.0.0.1:1234. Start an already-installed server with a model, then retry.
Authenticated AI CLIs: checked codex and claude on PATH. Install and authenticate a supported CLI separately, then retry.
Environment-backed cloud providers: checked recognized Anthropic, OpenAI, Google, xAI, and OpenRouter key variables without printing values. Export a supported provider key in the shell, then retry.`;

export type PromptValue = string | number | boolean;

export interface PromptOption {
  value: PromptValue;
  label: string;
  hint?: string;
}

export interface TextPromptOptions {
  placeholder?: string;
  validate?: (value: string | undefined) => string | undefined;
}

export interface ConfirmPromptOptions {
  initialValue?: boolean;
}

export interface SearchablePrompter {
  select(message: string, options: readonly PromptOption[]): Promise<PromptValue | null>;
  input(message: string, options?: TextPromptOptions): Promise<string | null>;
  confirm(message: string, options?: ConfirmPromptOptions): Promise<boolean | null>;
}

export type InteractiveSelectionResult =
  | { kind: "selected"; provider: ByokProviderId; model: string | null }
  | { kind: "cancelled"; exitCode: 130 }
  | { kind: "failed"; exitCode: 1; stage: "discovery" | "model-list" };

export type InteractiveAliasResult =
  | { kind: "selected"; selection: AliasRecord }
  | { kind: "fresh" }
  | { kind: "cancelled"; exitCode: 130 };

export interface SelectionDependencies {
  runtime: RuntimeGateway;
  prompter: SearchablePrompter;
  diagnostic(text: string): void;
}

function supportsDefault(provider: ByokProviderId): boolean {
  return provider === "codex-cli" || provider === "claude-cli";
}

function compareFoldedText(left: string, right: string): number {
  const foldedLeft = left.toLowerCase();
  const foldedRight = right.toLowerCase();
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  return 0;
}

function compareRawText(left: string, right: string): number {
  const foldedOrder = compareFoldedText(left, right);
  if (foldedOrder !== 0) return foldedOrder;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortPromptOptions(options: readonly PromptOption[]): PromptOption[] {
  return [...options].sort((left, right) => {
    const labelOrder = compareFoldedText(left.label, right.label);
    return labelOrder !== 0
      ? labelOrder
      : compareRawText(String(left.value), String(right.value));
  });
}

export function stripTerminalSequences(text: string): string {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

export function sanitizePromptText(text: string): string {
  return stripTerminalSequences(text)
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .trim();
}

export function formatSelection(selection: AliasRecord): string {
  const provider = sanitizePromptText(
    byokProviderDefinition(selection.provider).shortLabel,
  );
  const model = selection.model === null
    ? "provider default"
    : sanitizePromptText(selection.model);
  return `${provider} · ${model}`;
}

export async function selectAliasOrFresh(
  aliases: Readonly<Record<string, AliasRecord>>,
  prompter: SearchablePrompter,
): Promise<InteractiveAliasResult> {
  const aliasOptions = sortPromptOptions(Object.entries(aliases).map(([alias, selection]) => {
    return {
      value: alias,
      label: sanitizePromptText(alias),
      hint: formatSelection(selection),
    };
  }));
  const options: PromptOption[] = [
    ...aliasOptions,
    { value: false, label: "Select a new provider and model…" },
  ];
  const value = await prompter.select("Choose an alias", options);
  if (value === null) return { kind: "cancelled", exitCode: 130 };
  if (value === false) return { kind: "fresh" };
  if (typeof value !== "string" || !Object.hasOwn(aliases, value)) {
    throw new RangeError("Prompter returned an invalid alias choice.");
  }
  const selection = aliases[value];
  if (selection === undefined) throw new RangeError("Alias choice was unavailable.");
  return { kind: "selected", selection };
}

function selectedString(
  value: PromptValue | null,
  options: readonly PromptOption[],
  kind: "provider" | "model",
): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !options.some((option) => option.value === value)) {
    throw new RangeError(`Prompter returned an invalid ${kind} choice.`);
  }
  return value;
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
    const providerOptions = sortPromptOptions(providers.map((provider) => ({
      value: provider,
      label: sanitizePromptText(byokProviderDefinition(provider).shortLabel),
    })));
    const providerValue = selectedString(
      await deps.prompter.select("Choose a provider", providerOptions),
      providerOptions,
      "provider",
    );
    if (providerValue === null) return { kind: "cancelled", exitCode: 130 };
    const provider = providers.find((candidate) => candidate === providerValue);
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

      const defaultOptions: PromptOption[] = [{ value: false, label: "provider default" }];
      const defaultChoice = await deps.prompter.select("Choose a model", defaultOptions);
      if (defaultChoice === null) return { kind: "cancelled", exitCode: 130 };
      if (defaultChoice !== false) throw new RangeError("Prompter returned an invalid model choice.");
      return { kind: "selected", provider, model: null };
    }

    const modelOptions = sortPromptOptions(models.map((model) => {
      const id = sanitizePromptText(model.id);
      const label = sanitizePromptText(model.label) || id;
      return {
        value: model.id,
        label,
        ...(id !== "" && compareFoldedText(label, id) !== 0 ? { hint: id } : {}),
      };
    }));
    const modelValue = selectedString(
      await deps.prompter.select("Choose a model", modelOptions),
      modelOptions,
      "model",
    );
    if (modelValue === null) return { kind: "cancelled", exitCode: 130 };
    return { kind: "selected", provider, model: modelValue };
  }

  return { kind: "failed", exitCode: 1, stage: "model-list" };
}

export function createSearchablePrompter(
  input: Readable,
  output: Writable,
): SearchablePrompter {
  return {
    async select(message, options) {
      const result = await autocomplete<PromptValue>({
        message,
        options: [...options],
        placeholder: "Type to search…",
        input,
        output,
      });
      return isCancel(result) ? null : result;
    },
    async input(message, options = {}) {
      const result = await clackText({
        message,
        placeholder: options.placeholder,
        validate: options.validate,
        input,
        output,
      });
      return isCancel(result) ? null : result;
    },
    async confirm(message, options = {}) {
      const result = await clackConfirm({
        message,
        initialValue: options.initialValue ?? false,
        input,
        output,
      });
      return isCancel(result) ? null : result;
    },
  };
}

export function createTerminalColors(
  output: { isTTY?: boolean },
  env: Readonly<Record<string, string | undefined>>,
): ReturnType<typeof pc.createColors> {
  const disabled = Boolean(env.NO_COLOR) || env.TERM === "dumb";
  const forced = Boolean(env.FORCE_COLOR);
  return pc.createColors(!disabled && (forced || output.isTTY === true));
}

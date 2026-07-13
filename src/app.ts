import {
  BYOK_PROVIDER_API_KEY_ENV_VARS,
  type ByokEnvironment,
  type ByokProviderId,
} from "@swartzrock/byok-runtime";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import {
  type AliasRecord,
  AliasStoreError,
  isValidAliasName,
  resolveAlias as resolveStoredAlias,
  resolveAliasPath,
  saveAlias as saveStoredAlias,
} from "./aliases.ts";
import {
  HELP_TEXT,
  UsageError,
  parseArguments,
  requireDeterministicSelection,
  type Selection,
} from "./args.ts";
import { isInteractive, resolvePrompt, type PromptInput, type TextOutput } from "./io.ts";
import {
  createNumberedPrompter,
  selectProviderAndModel,
  type NumberedPrompter,
} from "./prompts.ts";
import { RuntimeStageError, type RuntimeGateway } from "./runtime.ts";

const DEFAULT_GENERATION_TIMEOUT_MS = 45_000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
const DEFAULT_MODEL_LIST_TIMEOUT_MS = 10_000;
const MAX_DIAGNOSTIC_LENGTH = 1_024;

export interface ApplicationPrompter extends NumberedPrompter {
  confirm(message: string): Promise<boolean | null>;
  input(message: string): Promise<string | null>;
}

export interface ApplicationDependencies {
  args: string[];
  stdin: PromptInput;
  stdout: TextOutput;
  stderr: TextOutput;
  runtime: RuntimeGateway;
  prompter: ApplicationPrompter;
  env: ByokEnvironment;
  platform: NodeJS.Platform;
  home: string;
  version: string;
  aliasPath?: string;
  resolveAlias?: typeof resolveStoredAlias;
  saveAlias?: typeof saveStoredAlias;
  generationTimeoutMs?: number;
  discoveryTimeoutMs?: number;
  modelListTimeoutMs?: number;
}

function recognizedCredentialValues(env: ByokEnvironment): string[] {
  return [...new Set(
    Object.values(BYOK_PROVIDER_API_KEY_ENV_VARS)
      .flat()
      .map((name) => env[name])
      .filter((value): value is string => Boolean(value)),
  )].sort((left, right) => right.length - left.length);
}

export function sanitizeDiagnostic(text: string, env: ByokEnvironment): string {
  let sanitized = text.replace(/\r\n?|\u2028|\u2029/g, "\n");
  sanitized = sanitized.replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "");
  sanitized = sanitized.replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
  sanitized = sanitized.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
  for (const value of recognizedCredentialValues(env)) {
    sanitized = sanitized.replaceAll(value, "[REDACTED]");
  }
  return sanitized.length <= MAX_DIAGNOSTIC_LENGTH
    ? sanitized
    : `${sanitized.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…`;
}

function diagnosticWriter(deps: ApplicationDependencies): (text: string) => void {
  return (text) => {
    const sanitized = sanitizeDiagnostic(text, deps.env);
    deps.stderr.write(`${sanitized}${sanitized.endsWith("\n") ? "" : "\n"}`);
  };
}

async function generateWithTimeout(
  deps: ApplicationDependencies,
  provider: ByokProviderId,
  model: string | null,
  prompt: string,
): Promise<string> {
  const timeoutMs = deps.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await deps.runtime.generate(provider, model, prompt, controller.signal);
  } catch (error) {
    if (timedOut) {
      throw new RuntimeStageError("generation", provider, `timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function withStageTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  stage: "discovery" | "model-list",
  provider: ByokProviderId | null,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new RuntimeStageError(stage, provider, `timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function resolveSelection(
  deps: ApplicationDependencies,
  selection: Selection,
  interactive: boolean,
  diagnostic: (text: string) => void,
): Promise<AliasRecord | number> {
  const deterministic = requireDeterministicSelection(selection, interactive);
  if (deterministic.kind === "alias") {
    const path = deps.aliasPath ?? resolveAliasPath({
      platform: deps.platform,
      home: deps.home,
      env: deps.env,
    });
    return await (deps.resolveAlias ?? resolveStoredAlias)(path, deterministic.alias);
  }
  if (deterministic.kind === "explicit") {
    return { provider: deterministic.provider, model: deterministic.model };
  }

  const result = await selectProviderAndModel({
    runtime: {
      ...deps.runtime,
      discover: () => withStageTimeout(
        deps.runtime.discover(),
        deps.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
        "discovery",
        null,
      ),
      listModels: (provider) => withStageTimeout(
        deps.runtime.listModels(provider),
        deps.modelListTimeoutMs ?? DEFAULT_MODEL_LIST_TIMEOUT_MS,
        "model-list",
        provider,
      ),
    },
    prompter: deps.prompter,
    diagnostic,
  });
  return result.kind === "selected"
    ? { provider: result.provider, model: result.model }
    : result.exitCode;
}

async function offerAliasSave(
  deps: ApplicationDependencies,
  selection: AliasRecord,
  diagnostic: (text: string) => void,
): Promise<void> {
  if ((await deps.prompter.confirm("Save this provider and model as an alias?")) !== true) return;
  const path = deps.aliasPath ?? resolveAliasPath({
    platform: deps.platform,
    home: deps.home,
    env: deps.env,
  });
  const save = deps.saveAlias ?? saveStoredAlias;

  while (true) {
    const name = await deps.prompter.input("Alias name (cancel to skip):");
    if (name === null) return;
    if (!isValidAliasName(name)) {
      diagnostic("config: invalid alias name; use 1-64 ASCII letters, numbers, hyphens, or underscores.");
      continue;
    }
    try {
      await save(path, name, selection, {
        confirmOverwrite: async () =>
          (await deps.prompter.confirm(`Alias ${name} exists. Overwrite it?`)) === true,
      });
      return;
    } catch (error) {
      diagnostic(`config: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }
}

export async function runApplication(deps: ApplicationDependencies): Promise<number> {
  const diagnostic = diagnosticWriter(deps);
  try {
    const parsed = parseArguments(deps.args);
    if (parsed.kind === "help") {
      deps.stdout.write(`${HELP_TEXT}\n`);
      return 0;
    }
    if (parsed.kind === "version") {
      deps.stdout.write(`${deps.version}\n`);
      return 0;
    }

    const interactive = isInteractive(deps.stdin, deps.stderr);
    const prompt = await resolvePrompt(parsed.input, deps.stdin);
    const selection = await resolveSelection(deps, parsed.selection, interactive, diagnostic);
    if (typeof selection === "number") return selection;

    const response = await generateWithTimeout(
      deps,
      selection.provider,
      selection.model,
      prompt,
    );
    deps.stdout.write(response);

    if (interactive && parsed.selection.kind !== "alias") {
      await offerAliasSave(deps, selection, diagnostic);
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      diagnostic(`usage: ${error.message}`);
      return error.exitCode;
    }
    if (error instanceof AliasStoreError) {
      diagnostic(`config: ${error.message}`);
      return 1;
    }
    diagnostic(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function createApplicationPrompter(
  input: Readable,
  output: Writable,
): ApplicationPrompter {
  const numbered = createNumberedPrompter(input, output);

  async function ask(message: string): Promise<string | null> {
    const readline = createInterface({ input, output });
    try {
      return await readline.question(`${message} `);
    } catch {
      return null;
    } finally {
      readline.close();
    }
  }

  return {
    choose: numbered.choose,
    input: ask,
    async confirm(message) {
      while (true) {
        const answer = await ask(`${message} [y/N]`);
        if (answer === null) return null;
        const normalized = answer.trim().toLowerCase();
        if (normalized === "y" || normalized === "yes") return true;
        if (normalized === "" || normalized === "n" || normalized === "no") return false;
        output.write("Enter y or n.\n");
      }
    },
  };
}

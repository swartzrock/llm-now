import {
  BYOK_PROVIDER_API_KEY_ENV_VARS,
  type ByokEnvironment,
  type ByokProviderId,
} from "@swartzrock/byok-runtime";
import type { Readable, Writable } from "node:stream";
import {
  type AliasRecord,
  AliasStoreError,
  isValidAliasName,
  loadAliases as loadStoredAliases,
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
  createSearchablePrompter,
  createTerminalColors,
  formatSelection,
  selectAliasOrFresh,
  selectProviderAndModel,
  sortPromptOptions,
  stripTerminalSequences,
  type SearchablePrompter,
} from "./prompts.ts";
import { RuntimeStageError, type RuntimeGateway } from "./runtime.ts";

const DEFAULT_GENERATION_TIMEOUT_MS = 45_000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
const DEFAULT_MODEL_LIST_TIMEOUT_MS = 10_000;
const MAX_DIAGNOSTIC_LENGTH = 1_024;

export type ApplicationPrompter = SearchablePrompter;

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
  loadAliases?: typeof loadStoredAliases;
  resolveAlias?: typeof resolveStoredAlias;
  saveAlias?: typeof saveStoredAlias;
  generationTimeoutMs?: number;
  discoveryTimeoutMs?: number;
  modelListTimeoutMs?: number;
}

interface ResolvedSelection {
  selection: AliasRecord;
  named: boolean;
  existingAlias?: string;
}

function recognizedCredentialValues(env: ByokEnvironment): string[] {
  return [...new Set(
    Object.values(BYOK_PROVIDER_API_KEY_ENV_VARS)
      .flat()
      .map((name) => env[name])
      .filter((value): value is string => Boolean(value)),
  )].sort((left, right) => right.length - left.length);
}

function sanitizeDiagnostic(text: string, env: ByokEnvironment): string {
  let sanitized = stripTerminalSequences(text.replace(/\r\n?|\u2028|\u2029/g, "\n"));
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

function applicationAliasPath(deps: ApplicationDependencies): string {
  return deps.aliasPath ?? resolveAliasPath({
    platform: deps.platform,
    home: deps.home,
    env: deps.env,
  });
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
): Promise<ResolvedSelection | number> {
  const deterministic = requireDeterministicSelection(selection, interactive);
  if (deterministic.kind === "alias") {
    return {
      selection: await (deps.resolveAlias ?? resolveStoredAlias)(
        applicationAliasPath(deps),
        deterministic.alias,
      ),
      named: true,
    };
  }
  if (deterministic.kind === "explicit") {
    return {
      selection: { provider: deterministic.provider, model: deterministic.model },
      named: false,
    };
  }

  const aliases = (await (deps.loadAliases ?? loadStoredAliases)(
    applicationAliasPath(deps),
  )).aliases;
  if (Object.keys(aliases).length > 0) {
    const aliasResult = await selectAliasOrFresh(aliases, deps.prompter);
    if (aliasResult.kind === "cancelled") return aliasResult.exitCode;
    if (aliasResult.kind === "selected") {
      return {
        selection: aliasResult.selection,
        named: true,
      };
    }
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
  if (result.kind !== "selected") return result.exitCode;

  const resolved = { provider: result.provider, model: result.model };
  const existingAlias = sortPromptOptions(Object.entries(aliases)
    .filter(([, candidate]) =>
      candidate.provider === resolved.provider && candidate.model === resolved.model
    )
    .map(([alias]) => ({ value: alias, label: alias })))[0]?.value;
  return {
    selection: resolved,
    named: false,
    existingAlias: typeof existingAlias === "string" ? existingAlias : undefined,
  };
}

async function offerAliasSave(
  deps: ApplicationDependencies,
  selection: AliasRecord,
  diagnostic: (text: string) => void,
): Promise<boolean> {
  const save = deps.saveAlias ?? saveStoredAlias;
  const colors = createTerminalColors(deps.stderr, deps.env);
  const target = formatSelection(selection);

  while (true) {
    const name = await deps.prompter.input(
      `${colors.green("Enter an alias name for ")}${colors.bold(target)}${colors.green(" (Enter to exit)")}`,
      {
        validate: (value) => value === undefined || value === "" || isValidAliasName(value)
          ? undefined
          : "Use 1-64 ASCII letters, numbers, hyphens, or underscores.",
      },
    );
    if (name === null || name === "") return true;
    if (!isValidAliasName(name)) {
      diagnostic("config: invalid alias name; use 1-64 ASCII letters, numbers, hyphens, or underscores.");
      continue;
    }
    try {
      const result = await save(applicationAliasPath(deps), name, selection, {
        confirmOverwrite: async (_alias, current) =>
          (await deps.prompter.confirm(
            `Overwrite alias ${name}?\nOld: ${current === undefined ? "(not present)" : formatSelection(current)}\nNew: ${target}`,
            { initialValue: false },
          )) === true,
      });
      if (result === "saved") {
        deps.stderr.write(`${colors.green(`◆ Saved alias ${name} → ${target}`)}\n`);
      } else if (result === "already-saved") {
        deps.stderr.write(`${colors.green(`◆ Already saved ${name} → ${target}`)}\n`);
      }
      return true;
    } catch (error) {
      diagnostic(`config: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}

function writeInteractiveBoundary(stderr: TextOutput, response: string): void {
  stderr.write(`\u001b[0m${response.endsWith("\n") ? "\n" : "\n\n"}`);
}

function writeResponse(stdout: TextOutput, response: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stdout.write(response, (error) => error ? reject(error) : resolve());
  });
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
      selection.selection.provider,
      selection.selection.model,
      prompt,
    );
    await writeResponse(deps.stdout, response);

    if (interactive) writeInteractiveBoundary(deps.stderr, response);
    if (interactive && selection.existingAlias !== undefined) {
      const colors = createTerminalColors(deps.stderr, deps.env);
      const target = formatSelection(selection.selection);
      deps.stderr.write(colors.green(
        `◆ ${target} is already saved as alias ${selection.existingAlias}\n`
        + `  Next time, use llm-now ${selection.existingAlias} --input "<prompt>"\n`,
      ));
    } else if (interactive && !selection.named) {
      if (!(await offerAliasSave(deps, selection.selection, diagnostic))) return 1;
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
  return createSearchablePrompter(input, output);
}

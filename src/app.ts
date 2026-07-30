import {
  BYOK_API_KEY_ENV_VARS,
  BYOK_PROVIDER_API_KEY_ENV_VARS,
  type ByokCloudProviderId,
  type ByokEnvironment,
  type ByokModelOption,
  type ByokProviderId,
} from "@swartzrock/byok-runtime";
import pc from "picocolors";
import type { Readable, Writable } from "node:stream";
import {
  type AliasRecord,
  AliasStoreError,
  isValidAliasName,
  loadAliases as loadStoredAliases,
  normalizeAliasName,
  resolveAlias as resolveStoredAlias,
  resolveAliasPath,
  saveAlias as saveStoredAlias,
} from "./aliases.ts";
import {
  UsageError,
  parseArguments,
  renderHelpText,
  requireDeterministicSelection,
  type Selection,
} from "./args.ts";
import {
  isInteractive,
  promptValidationMessage,
  resolvePrompt,
  type PromptInput,
  type TextOutput,
} from "./io.ts";
import {
  CredentialVaultError,
  type CredentialResolver,
  type CredentialVault,
  type SensitiveValueRegistry,
} from "./credentials.ts";
import {
  cloudCredentialProviderOptions,
  createSearchablePrompter,
  createTerminalColors,
  discoveredProviderOptions,
  formatAliasInventory,
  formatSelection,
  NO_PROVIDER_DIAGNOSTIC,
  providerLabel,
  selectAlias,
  selectAliasOrFresh,
  selectProviderAndModel,
  sanitizePromptText,
  sortPromptOptions,
  stripTerminalSequences,
  validateCredentialCandidate,
  type SearchablePrompter,
} from "./prompts.ts";
import { RuntimeStageError, type RuntimeGateway } from "./runtime.ts";

const DEFAULT_GENERATION_TIMEOUT_MS = 45_000;
const DEFAULT_MODEL_LIST_TIMEOUT_MS = 10_000;
const MAX_DIAGNOSTIC_LENGTH = 1_024;
const MANAGE_API_KEYS_VALUE = "setup:manage-api-keys";
const DISCOVER_PROVIDERS_VALUE = "setup:discover-providers";
const RUN_SHORTCUT_VALUE = "launcher:run-shortcut";
const CREATE_SHORTCUT_VALUE = "launcher:create-shortcut";
const RUN_ONCE_VALUE = "launcher:run-once";
const MANAGE_CONNECTIONS_VALUE = "launcher:manage-connections";
const AVAILABLE_PROVIDER_SOURCE_VALUE = "shortcut-source:available-provider";
const ADD_API_KEY_SOURCE_VALUE = "shortcut-source:add-api-key";

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
  modelListTimeoutMs?: number;
  credentialVault: CredentialVault;
  credentialResolver: CredentialResolver;
  sensitive: SensitiveValueRegistry;
  nativeVaultEnabled: boolean;
}

type ShortcutFollowUp = "none" | "existing-only" | "legacy";

interface ResolvedSelection {
  selection: AliasRecord;
  shortcutFollowUp: ShortcutFollowUp;
  existingAlias?: string;
}

interface LauncherWork {
  prompt: string;
  selection: ResolvedSelection;
}

function recognizedCredentialValues(env: ByokEnvironment): string[] {
  return [...new Set(
    BYOK_API_KEY_ENV_VARS
      .map((name) => env[name])
      .filter((value): value is string => Boolean(value)),
  )].sort((left, right) => right.length - left.length);
}

function sanitizeDiagnostic(
  text: string,
  env: ByokEnvironment,
  sensitive: SensitiveValueRegistry,
): string {
  let sanitized = stripTerminalSequences(text.replace(/\r\n?|\u2028|\u2029/g, "\n"));
  sanitized = sanitized.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
  sanitized = sensitive.redact(sanitized);
  for (const value of recognizedCredentialValues(env)) {
    sanitized = sanitized.replaceAll(value, "[REDACTED]");
  }
  return sanitized.length <= MAX_DIAGNOSTIC_LENGTH
    ? sanitized
    : `${sanitized.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…`;
}

function diagnosticWriter(deps: ApplicationDependencies): (text: string) => void {
  return (text) => {
    const sanitized = sanitizeDiagnostic(text, deps.env, deps.sensitive);
    deps.stderr.write(`${sanitized}${sanitized.endsWith("\n") ? "" : "\n"}`);
  };
}

function credentialVaultUnavailableMessage(
  error: CredentialVaultError,
  platform: NodeJS.Platform,
  colors: ReturnType<typeof pc.createColors>,
): string {
  const envNames = BYOK_PROVIDER_API_KEY_ENV_VARS[error.provider];
  const primaryEnvName = envNames[0];

  if (platform === "linux") {
    const action = {
      get: "llm-now couldn’t access the saved API key.",
      set: "llm-now couldn’t save the API key securely.",
      delete: "llm-now couldn’t complete removal of the saved API key.",
    }[error.operation];
    const errorHeading = colors.bold(colors.red("Error:"));
    const tipHeading = colors.bold(colors.greenBright("Tip:"));
    const credentialNames = envNames.map((name) => colors.bold(colors.cyanBright(name)));
    const shellCommand = `read -r -s ${primaryEnvName} && export ${primaryEnvName}`;

    return [
      `${errorHeading} Secure API-key storage isn’t available in this Linux session.`,
      action,
      "",
      `${tipHeading} Use an api key (not saved by llm-now):`,
      `  Use ${credentialNames.join(" or ")} in this shell.`,
      "  In bash/zsh, enter it without echoing:",
      `    ${colors.cyan(shellCommand)}`,
      "  Then retry your command in this shell.",
      "",
      `${tipHeading} To save API keys securely:`,
      "  Start or unlock a Secret Service provider (for example, GNOME Keyring or KWallet) in your user session, then retry the command that failed.",
    ].join("\n");
  }

  const lines = [
    error.message,
    `Use ${envNames.join(" or ")} for this process instead.`,
  ];

  if (platform !== "win32") {
    lines.push(
      `In bash/zsh, enter it without echoing: read -r -s ${primaryEnvName} && export ${primaryEnvName}`,
    );
  }
  return lines.join("\n");
}

function credentialVaultError(error: unknown): CredentialVaultError | null {
  if (error instanceof CredentialVaultError) return error;
  if (error instanceof RuntimeStageError && error.cause instanceof CredentialVaultError) {
    return error.cause;
  }
  return null;
}

function safeFormatSelection(deps: ApplicationDependencies, selection: AliasRecord): string {
  return sanitizeDiagnostic(formatSelection(selection), deps.env, deps.sensitive);
}

function aliasPromptMessage(
  deps: ApplicationDependencies,
  alias: string,
  selection: AliasRecord,
): string {
  const model = selection.model === null
    ? "default model"
    : sanitizePromptText(selection.model);
  return sanitizeDiagnostic(
    `Prompt for ${sanitizePromptText(alias)} · ${providerLabel(selection.provider)} · ${model}`,
    deps.env,
    deps.sensitive,
  );
}

function freshPromptMessage(
  deps: ApplicationDependencies,
  selection: AliasRecord,
): string {
  return sanitizeDiagnostic(
    `Prompt for ${formatSelection(selection)}`,
    deps.env,
    deps.sensitive,
  );
}

async function collectOneShotPrompt(
  deps: ApplicationDependencies,
  message: string,
): Promise<string | null> {
  while (true) {
    const prompt = await deps.prompter.input(message, {
      validate: promptValidationMessage,
    });
    if (prompt === null) return null;
    if (promptValidationMessage(prompt) === undefined) return prompt;
  }
}

function sameAliasRecord(left: AliasRecord, right: AliasRecord): boolean {
  return left.provider === right.provider && left.model === right.model;
}

function selectedCredentialModel(
  value: string | number | boolean | null,
  models: readonly ByokModelOption[],
): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !models.some((model) => model.id === value)) {
    throw new RangeError("Prompter returned an invalid credential model choice.");
  }
  return value;
}

function selectedShortcutChoice(
  value: string | number | boolean | null,
): boolean | null {
  if (value === null) return null;
  if (typeof value !== "boolean") {
    throw new RangeError("Prompter returned an invalid model shortcut choice.");
  }
  return value;
}

interface PendingAlias {
  name: string;
  selection: AliasRecord;
  expectedCurrent?: AliasRecord;
}

async function prepareCredentialAlias(
  deps: ApplicationDependencies,
  aliases: Readonly<Record<string, AliasRecord>>,
  provider: ByokCloudProviderId,
  models: readonly ByokModelOption[],
  diagnostic: (text: string) => void,
): Promise<PendingAlias | null> {
  const safeModels = models.filter((model) =>
    sanitizePromptText(model.id) === model.id
    && deps.sensitive.redact(model.id) === model.id
  );
  if (safeModels.length === 0) {
    diagnostic(
      `model-list (${provider}): provider returned ${models.length === 0 ? "no models" : "no alias-safe models"}; the API key was saved without an alias.`,
    );
    return null;
  }

  const createShortcut = selectedShortcutChoice(
    await deps.prompter.select("Create a model shortcut now?", [
      { value: false, label: "Not now" },
      { value: true, label: "Choose a model…" },
    ]),
  );
  if (createShortcut !== true) return null;

  const modelOptions = sortPromptOptions(safeModels.map((model) => {
    const id = deps.sensitive.redact(sanitizePromptText(model.id));
    const label = deps.sensitive.redact(sanitizePromptText(model.label)) || id;
    return {
      value: model.id,
      label,
      ...(label !== id ? { hint: id } : {}),
    };
  }));
  const model = selectedCredentialModel(
    await deps.prompter.select("Choose a model for the shortcut", modelOptions),
    safeModels,
  );
  if (model === null) return null;
  const selection = { provider, model } satisfies AliasRecord;

  while (true) {
    const name = await deps.prompter.input("Name this model shortcut (Enter to skip)", {
      validate: (value) => {
        if (value === undefined || value === "") return undefined;
        if (deps.sensitive.redact(value) !== value) return "Alias names must not contain an API key.";
        return isValidAliasName(value)
          ? undefined
          : "Use 1-64 ASCII letters, numbers, hyphens, or underscores.";
      },
    });
    if (name === null) return null;
    if (name === "") return null;
    if (deps.sensitive.redact(name) !== name) {
      diagnostic("config: alias names must not contain an API key.");
      continue;
    }
    if (!isValidAliasName(name)) {
      diagnostic("config: invalid alias name; use 1-64 ASCII letters, numbers, hyphens, or underscores.");
      continue;
    }

    const canonicalName = normalizeAliasName(name);
    const current = Object.hasOwn(aliases, canonicalName) ? aliases[canonicalName] : undefined;
    if (current !== undefined && !sameAliasRecord(current, selection)) {
      const overwrite = await deps.prompter.confirm(
        `Overwrite alias ${canonicalName}?\nOld: ${safeFormatSelection(deps, current)}\nNew: ${safeFormatSelection(deps, selection)}`,
        { initialValue: false },
      );
      if (overwrite === null) return null;
      if (!overwrite) continue;
    }
    return { name: canonicalName, selection, expectedCurrent: current };
  }
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
  stage: "model-list",
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
      shortcutFollowUp: "none",
    };
  }
  if (deterministic.kind === "explicit") {
    return {
      selection: { provider: deterministic.provider, model: deterministic.model },
      shortcutFollowUp: "legacy",
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
        shortcutFollowUp: "none",
      };
    }
  }

  return resolveFreshSelection(deps, aliases, diagnostic, "legacy");
}

async function resolveFreshSelection(
  deps: ApplicationDependencies,
  aliases: Readonly<Record<string, AliasRecord>>,
  diagnostic: (text: string) => void,
  shortcutFollowUp: ShortcutFollowUp,
): Promise<ResolvedSelection | number> {
  const result = await selectProviderAndModel({
    runtime: {
      ...deps.runtime,
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
    shortcutFollowUp,
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
  const target = safeFormatSelection(deps, selection);

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
    const canonicalName = normalizeAliasName(name);
    try {
      const result = await save(applicationAliasPath(deps), canonicalName, selection, {
        confirmOverwrite: async (_alias, current) =>
          (await deps.prompter.confirm(
            `Overwrite alias ${canonicalName}?\nOld: ${current === undefined ? "(not present)" : safeFormatSelection(deps, current)}\nNew: ${target}`,
            { initialValue: false },
          )) === true,
      });
      if (result === "saved") {
        deps.stderr.write(
          colors.green("◆ Saved alias ")
          + colors.white(canonicalName)
          + colors.green(` → ${target}\n  Next time, use `)
          + colors.white(`llm-now ${canonicalName} --input "<prompt>"`)
          + "\n",
        );
      } else if (result === "already-saved") {
        deps.stderr.write(`${colors.green(`◆ Already saved ${canonicalName} → ${target}`)}\n`);
      }
      return true;
    } catch (error) {
      diagnostic(`config: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}

async function runCredentialManagement(
  deps: ApplicationDependencies,
  provider: ByokCloudProviderId,
  aliases: Readonly<Record<string, AliasRecord>>,
  diagnostic: (text: string) => void,
): Promise<number> {
  const vault = deps.credentialVault;
  const resolver = deps.credentialResolver;
  const sensitive = deps.sensitive;

  if (deps.nativeVaultEnabled !== true) {
    diagnostic(
      `native credential storage unavailable on this target; use environment variable ${BYOK_PROVIDER_API_KEY_ENV_VARS[provider].join(" or ")}.`,
    );
    return 1;
  }

  const stored = await vault.get(provider);
  if (stored !== null) sensitive.register(stored);

  if (stored !== null) {
    const operation = await deps.prompter.select(
      `Manage the saved ${providerLabel(provider)} API key`,
      [
        { value: "replace", label: "Replace saved API key" },
        { value: "delete", label: "Delete saved API key" },
      ],
    );
    if (operation === null) return 130;
    if (operation !== "replace" && operation !== "delete") {
      throw new RangeError("Prompter returned an invalid credential operation.");
    }

    if (operation === "delete") {
      const confirmed = await deps.prompter.confirm(
        `Delete the saved ${providerLabel(provider)} API key?`,
        { initialValue: false },
      );
      if (confirmed === null) return 130;
      if (!confirmed) return 0;
      const deleted = await vault.delete(provider);
      resolver.invalidate?.(provider);
      const activeEnv = BYOK_PROVIDER_API_KEY_ENV_VARS[provider]
        .find((name) => Boolean(deps.env[name]));
      if (!deleted) {
        deps.stderr.write(`The saved ${providerLabel(provider)} API key was already absent.\n`);
      } else {
        deps.stderr.write(`Deleted the saved ${providerLabel(provider)} API key.\n`);
      }
      if (activeEnv !== undefined) {
        deps.stderr.write(
          `${providerLabel(provider)} continues to be available through ${activeEnv}; environment credentials take precedence.\n`,
        );
      }
      return 0;
    }

    const replace = await deps.prompter.confirm(
      `Replace the saved ${providerLabel(provider)} API key? The old key remains until the replacement is verified and saved.`,
      { initialValue: false },
    );
    if (replace === null) return 130;
    if (!replace) return 0;
  }

  let candidate: string;
  while (true) {
    const value = await deps.prompter.password(`Enter the ${providerLabel(provider)} API key`, {
      validate: validateCredentialCandidate,
    });
    if (value === null) return 130;
    sensitive.register(value);
    const validationMessage = validateCredentialCandidate(value);
    if (validationMessage !== undefined) {
      diagnostic(`credential: ${validationMessage}`);
      continue;
    }
    candidate = value;
    break;
  }

  const models = await withStageTimeout(
    deps.runtime.validateCredential(provider, candidate),
    deps.modelListTimeoutMs ?? DEFAULT_MODEL_LIST_TIMEOUT_MS,
    "model-list",
    provider,
  );

  const save = await deps.prompter.confirm(
    `Save this verified ${providerLabel(provider)} API key?`,
    { initialValue: false },
  );
  if (save === null) return 130;
  if (!save) return 0;

  await vault.set(provider, candidate);
  resolver.invalidate?.(provider);
  const colors = createTerminalColors(deps.stderr, deps.env);
  deps.stderr.write(
    colors.green(`◆ ${providerLabel(provider)} · API key verified\n`)
    + "  stored as: saved credential\n",
  );

  const pendingAlias = await prepareCredentialAlias(deps, aliases, provider, models, diagnostic);
  if (pendingAlias === null) return 0;
  try {
    const saveAlias = deps.saveAlias ?? saveStoredAlias;
    const result = await saveAlias(
      applicationAliasPath(deps),
      pendingAlias.name,
      pendingAlias.selection,
      pendingAlias.expectedCurrent === undefined
        ? undefined
        : {
          confirmOverwrite: async (_name, current) =>
            current !== undefined && sameAliasRecord(current, pendingAlias.expectedCurrent!),
        },
    );
    if (result === "declined") {
      diagnostic("API key was saved, but the alias was not saved because it changed concurrently.");
      return 1;
    }
    deps.stderr.write(
      `${result === "already-saved" ? "Alias already saved" : "Saved alias"} `
      + `${pendingAlias.name} → ${safeFormatSelection(deps, pendingAlias.selection)}.\n`,
    );
    return 0;
  } catch (error) {
    diagnostic(
      `API key was saved, but the alias was not saved: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

async function runProviderDiscovery(
  deps: ApplicationDependencies,
  diagnostic: (text: string) => void,
): Promise<number> {
  const providers: readonly ByokProviderId[] = [...new Set(await deps.runtime.discover())];
  if (providers.length === 0) {
    diagnostic(NO_PROVIDER_DIAGNOSTIC);
    return 1;
  }
  const providerOptions = discoveredProviderOptions(providers);
  const provider = await deps.prompter.select("Choose an available provider", providerOptions);
  if (provider === null) return 130;
  if (typeof provider !== "string" || !providers.includes(provider as ByokProviderId)) {
    throw new RangeError("Provider choice was unavailable.");
  }
  deps.stderr.write(
    `Provider ${providerLabel(provider as ByokProviderId)} is available. `
    + `Run llm-now --provider ${provider} --model <id> --input "<prompt>".\n`,
  );
  return 0;
}

async function runApiKeyManagement(
  deps: ApplicationDependencies,
  aliases: Readonly<Record<string, AliasRecord>>,
  diagnostic: (text: string) => void,
): Promise<number> {
  const cloudOptions = cloudCredentialProviderOptions();
  const providerValue = await deps.prompter.select("Choose an API-key provider", cloudOptions);
  if (providerValue === null) return 130;
  if (
    typeof providerValue !== "string"
    || !cloudOptions.some((option) => option.value === providerValue)
  ) {
    throw new RangeError("Prompter returned an invalid credential provider choice.");
  }
  return runCredentialManagement(
    deps,
    providerValue as ByokCloudProviderId,
    aliases,
    diagnostic,
  );
}

async function runManagement(
  deps: ApplicationDependencies,
  aliases: Readonly<Record<string, AliasRecord>>,
  diagnostic: (text: string) => void,
): Promise<number> {
  const selected = await deps.prompter.select("What would you like to manage?", [
    { value: DISCOVER_PROVIDERS_VALUE, label: "Discover available providers…" },
    { value: MANAGE_API_KEYS_VALUE, label: "Add or manage API keys…" },
  ]);
  if (selected === null) return 130;
  if (selected === DISCOVER_PROVIDERS_VALUE) {
    return runProviderDiscovery(deps, diagnostic);
  }
  if (selected === MANAGE_API_KEYS_VALUE) {
    return runApiKeyManagement(deps, aliases, diagnostic);
  }
  throw new RangeError("Prompter returned an invalid management choice.");
}

async function runLauncher(
  deps: ApplicationDependencies,
  diagnostic: (text: string) => void,
): Promise<LauncherWork | number> {
  const aliases = (await (deps.loadAliases ?? loadStoredAliases)(
    applicationAliasPath(deps),
  )).aliases;
  const hasAliases = Object.keys(aliases).length > 0;
  const selected = await deps.prompter.select(
    "What would you like to do?",
    hasAliases
      ? [
        { value: RUN_SHORTCUT_VALUE, label: "Run with a saved shortcut…" },
        { value: CREATE_SHORTCUT_VALUE, label: "Create a new shortcut…" },
        {
          value: RUN_ONCE_VALUE,
          label: "Run once with another provider and model…",
        },
        { value: MANAGE_CONNECTIONS_VALUE, label: "Manage connections…" },
      ]
      : [
        { value: CREATE_SHORTCUT_VALUE, label: "Create a new shortcut…" },
        { value: RUN_ONCE_VALUE, label: "Run once with a provider and model…" },
        { value: MANAGE_CONNECTIONS_VALUE, label: "Manage connections…" },
      ],
  );
  if (selected === null) return 130;

  if (selected === MANAGE_CONNECTIONS_VALUE) {
    return runManagement(deps, aliases, diagnostic);
  }
  if (selected === CREATE_SHORTCUT_VALUE) {
    const source = await deps.prompter.select("How should this shortcut connect?", [
      {
        value: AVAILABLE_PROVIDER_SOURCE_VALUE,
        label: "Use an available provider…",
      },
      {
        value: ADD_API_KEY_SOURCE_VALUE,
        label: "Add a provider with an API key…",
      },
    ]);
    if (source === null) return 130;
    if (
      source !== AVAILABLE_PROVIDER_SOURCE_VALUE
      && source !== ADD_API_KEY_SOURCE_VALUE
    ) {
      throw new RangeError("Prompter returned an invalid shortcut connection source.");
    }
    throw new RangeError("Shortcut creation source is not implemented.");
  }
  if (selected === RUN_SHORTCUT_VALUE && hasAliases) {
    const aliasResult = await selectAlias(
      aliases,
      deps.prompter,
      (alias, selection) => ({
        label: sanitizeDiagnostic(alias, deps.env, deps.sensitive),
        hint: safeFormatSelection(deps, selection),
      }),
    );
    if (aliasResult.kind === "cancelled") return aliasResult.exitCode;
    const prompt = await collectOneShotPrompt(
      deps,
      aliasPromptMessage(deps, aliasResult.alias, aliasResult.selection),
    );
    if (prompt === null) return 130;
    return {
      prompt,
      selection: {
        selection: aliasResult.selection,
        shortcutFollowUp: "none",
      },
    };
  }
  if (selected !== RUN_ONCE_VALUE) {
    throw new RangeError("Prompter returned an invalid launcher choice.");
  }

  const selection = await resolveFreshSelection(
    deps,
    aliases,
    diagnostic,
    "existing-only",
  );
  if (typeof selection === "number") return selection;
  const prompt = await collectOneShotPrompt(
    deps,
    freshPromptMessage(deps, selection.selection),
  );
  if (prompt === null) return 130;
  return { prompt, selection };
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
      const colors = pc.createColors(
        deps.stdout.isTTY === true
        && !deps.env.NO_COLOR
        && deps.env.TERM !== "dumb",
      );
      deps.stdout.write(`${renderHelpText(colors, BYOK_API_KEY_ENV_VARS, deps.platform)}\n`);
      return 0;
    }
    if (parsed.kind === "version") {
      deps.stdout.write(`${deps.version}\n`);
      return 0;
    }
    if (parsed.kind === "aliases") {
      const aliases = (await (deps.loadAliases ?? loadStoredAliases)(
        applicationAliasPath(deps),
      )).aliases;
      const roster = formatAliasInventory(aliases);
      if (roster.length > 0) deps.stdout.write(`${roster}\n`);
      return 0;
    }

    const interactive = isInteractive(deps.stdin, deps.stderr);
    let prompt: string;
    let selection: ResolvedSelection;
    if (deps.args.length === 0 && interactive) {
      const outcome = await runLauncher(deps, diagnostic);
      if (typeof outcome === "number") return outcome;
      prompt = outcome.prompt;
      selection = outcome.selection;
    } else if (
      parsed.selection.kind === "alias"
      && parsed.input === undefined
      && interactive
    ) {
      const resolved = await resolveSelection(
        deps,
        parsed.selection,
        interactive,
        diagnostic,
      );
      if (typeof resolved === "number") return resolved;
      selection = resolved;
      const entered = await collectOneShotPrompt(
        deps,
        aliasPromptMessage(deps, parsed.selection.alias, resolved.selection),
      );
      if (entered === null) return 130;
      prompt = entered;
    } else {
      prompt = await resolvePrompt(parsed.input, deps.stdin);
      const resolved = await resolveSelection(
        deps,
        parsed.selection,
        interactive,
        diagnostic,
      );
      if (typeof resolved === "number") return resolved;
      selection = resolved;
    }

    const response = await generateWithTimeout(
      deps,
      selection.selection.provider,
      selection.selection.model,
      prompt,
    );
    await writeResponse(deps.stdout, response);

    if (interactive) writeInteractiveBoundary(deps.stderr, response);
    if (
      interactive
      && selection.shortcutFollowUp !== "none"
      && selection.existingAlias !== undefined
    ) {
      const colors = createTerminalColors(deps.stderr, deps.env);
      const target = safeFormatSelection(deps, selection.selection);
      deps.stderr.write(
        colors.green(
          `◆ ${target} is already saved as alias ${selection.existingAlias}\n`
          + "  Next time, use ",
        )
        + colors.white(`llm-now ${selection.existingAlias} --input "<prompt>"`)
        + "\n",
      );
    } else if (interactive && selection.shortcutFollowUp === "legacy") {
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
    const vaultError = credentialVaultError(error);
    if (vaultError !== null) {
      const colors = createTerminalColors(deps.stderr, deps.env);
      deps.stderr.write(
        `${credentialVaultUnavailableMessage(vaultError, deps.platform, colors)}\n`,
      );
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    const setupGuidance = isInteractive(deps.stdin, deps.stderr)
      && (message.includes("missing credential")
        || message.includes("native credential storage unavailable"));
    diagnostic(
      setupGuidance
        ? `${message}\nRun llm-now with no arguments to manage API keys.`
        : message,
    );
    return 1;
  }
}

export function createApplicationPrompter(
  input: Readable,
  output: Writable,
): ApplicationPrompter {
  return createSearchablePrompter(input, output);
}

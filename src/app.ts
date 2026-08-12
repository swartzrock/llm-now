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
  type SaveAliasResult,
  AliasStoreError,
  hasInvalidInstructionCharacters,
  isValidAliasName,
  loadAliases as loadStoredAliases,
  normalizeAliasName,
  resolveAlias as resolveStoredAlias,
  resolveAliasPath,
  sameAliasRecord,
} from "./aliases.ts";
import {
  UsageError,
  parseArguments,
  renderHelpText,
  requireDeterministicSelection,
  type Selection,
} from "./args.ts";
import {
  loadConfigSnapshot,
  loadUnifiedConfigSnapshot,
  migrateConfig as migrateStoredConfig,
  resolveConfigPaths,
  saveConfigAlias as saveStoredAlias,
  type ConfigSnapshot,
} from "./config.ts";
import {
  InvalidUtf8Error,
  isInteractive,
  promptValidationMessage,
  resolveInputSource,
  resolvePrompt,
  type PromptInput,
  type TextOutput,
} from "./io.ts";
import {
  CredentialVaultError,
  createPersistenceBlocker,
  resolveCredentialLockDirectory,
  withCredentialMutationLock,
  type CredentialMutationLock,
  type CredentialResolver,
  type CredentialVault,
  type PersistenceBlocker,
  type SensitiveValueRegistry,
} from "./credentials.ts";
import {
  cloudCredentialProviderOptions,
  CLOUD_CREDENTIAL_PROVIDERS,
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
import {
  CONFIG_FAILED_NOTICE,
  CREATE_ALIAS_NOTICE,
  REQUEST_FAILED_NOTICE,
  RETRY_NOTICE,
  VOICE_PROMPT,
  createBunVoiceProcessRunner,
  prepareVoiceSpeech,
  redactVoiceRequestValues,
  routeVoiceTranscript,
  speakVoiceAnswer,
  speakVoiceNotice,
  type PreparedVoiceSpeech,
  type VoiceCancellation,
  type VoiceNotice,
  type VoiceProcessRunner,
  type VoiceSpeechPreflightOutcome,
} from "./voice.ts";
import {
  normalizeWorkspace,
  preflightWorkspace,
  sameWorkspace,
  workspaceCapabilities,
  WorkspaceError,
  type WorkspaceConfig,
} from "./workspace.ts";

const DEFAULT_GENERATION_TIMEOUT_MS = 45_000;
const DEFAULT_GENERATION_CLEANUP_TIMEOUT_MS = 500;
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
const INSTRUCTION_PROMPT_MESSAGE =
  "Optional instructions for this shortcut (press Enter to skip)";
const INSTRUCTION_CREDENTIAL_DIAGNOSTIC = "config: instructions must not contain an API key.";
const INSTRUCTION_VAULT_DIAGNOSTIC =
  "config: instructions could not be checked against saved API keys; the shortcut was not saved.";

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
  cwd: string;
  version: string;
  aliasPath?: string;
  configPath?: string;
  voiceConfigPath?: string;
  loadAliases?: typeof loadStoredAliases;
  resolveAlias?: typeof resolveStoredAlias;
  saveAlias?: typeof saveStoredAlias;
  migrateConfig?: typeof migrateStoredConfig;
  generationTimeoutMs?: number;
  generationCleanupTimeoutMs?: number;
  modelListTimeoutMs?: number;
  credentialVault: CredentialVault;
  credentialResolver: CredentialResolver;
  sensitive: SensitiveValueRegistry;
  nativeVaultEnabled: boolean;
  installVoiceCancellation: () => VoiceCancellation;
  voiceRunner?: VoiceProcessRunner;
  readVoiceConfig?: (path: string) => Promise<Uint8Array | null>;
  credentialMutationLock?: CredentialMutationLock;
}

type ShortcutFollowUp = "none" | "existing-only" | "legacy";

interface ResolvedSelection {
  selection: AliasRecord;
  shortcutFollowUp: ShortcutFollowUp;
  alias?: string;
  existingAlias?: string;
}

interface LauncherWork {
  prompt: string;
  selection: ResolvedSelection;
}

async function preflightAliasWorkspace(selection: AliasRecord): Promise<AliasRecord> {
  if (selection.workspace === undefined) return selection;
  return withWorkspace(
    selection,
    await preflightWorkspace(selection.provider, selection.workspace),
  );
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

function diagnosticWriter(
  deps: ApplicationDependencies,
  requestValues: readonly string[] = [],
): (text: string) => void {
  return (text) => {
    const sanitized = sanitizeDiagnostic(
      redactVoiceRequestValues(text, requestValues),
      deps.env,
      deps.sensitive,
    );
    deps.stderr.write(`${sanitized}${sanitized.endsWith("\n") ? "" : "\n"}`);
  };
}

function withPromptSignal(
  prompter: SearchablePrompter,
  signal: AbortSignal,
): SearchablePrompter {
  return {
    select: (message, options) => prompter.select(message, options, signal),
    input: (message, options) => prompter.input(message, options, signal),
    instruction: (message) => prompter.instruction(message, signal),
    password: (message, options) => prompter.password(message, options, signal),
    confirm: (message, options) => prompter.confirm(message, options, signal),
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
  return sanitizeDiagnostic(
    `Prompt for ${sanitizePromptText(alias)} · ${formatSelection(selection)}`,
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

type InstructionCaptureResult =
  | { kind: "ready"; instructions?: string; persistenceBlocker?: PersistenceBlocker }
  | { kind: "cancelled" }
  | { kind: "failed" };

class InstructionCredentialBlockedError extends Error {}
class InstructionCredentialRefreshError extends Error {}

async function captureShortcutInstructions(
  deps: ApplicationDependencies,
  diagnostic: (text: string) => void,
  validatedCredentials: readonly string[] = [],
): Promise<InstructionCaptureResult> {
  while (true) {
    const value = await deps.prompter.instruction(INSTRUCTION_PROMPT_MESSAGE);
    if (value === null) return { kind: "cancelled" };
    if (hasInvalidInstructionCharacters(value)) {
      diagnostic("config: instructions must use ordinary line breaks and contain no other control characters.");
      continue;
    }
    if (value.trim().length === 0) return { kind: "ready" };

    const persistenceBlocker = createPersistenceBlocker(deps.env);
    for (const credential of validatedCredentials) {
      persistenceBlocker.register(credential, "validated");
    }
    if (deps.nativeVaultEnabled === true) {
      try {
        for (const provider of CLOUD_CREDENTIAL_PROVIDERS) {
          const credential = await deps.credentialVault.get(provider);
          if (credential !== null) {
            deps.sensitive.register(credential);
            persistenceBlocker.register(credential, "vault");
          }
        }
      } catch {
        diagnostic(INSTRUCTION_VAULT_DIAGNOSTIC);
        return { kind: "failed" };
      }
    }
    if (persistenceBlocker.blocks(value)) {
      diagnostic(INSTRUCTION_CREDENTIAL_DIAGNOSTIC);
      continue;
    }
    return { kind: "ready", instructions: value, persistenceBlocker };
  }
}

type WorkspaceCaptureResult =
  | { kind: "ready"; workspace?: WorkspaceConfig }
  | { kind: "cancelled" };

async function captureShortcutWorkspace(
  deps: ApplicationDependencies,
  provider: ByokProviderId,
  diagnostic: (text: string) => void,
): Promise<WorkspaceCaptureResult> {
  if (!workspaceCapabilities(provider).primaryDirectory) return { kind: "ready" };

  while (true) {
    const primary = await deps.prompter.input(
      "Primary workspace directory (press Enter to skip)",
    );
    if (primary === null) return { kind: "cancelled" };
    if (primary === "") return { kind: "ready" };

    let workspace: WorkspaceConfig;
    try {
      workspace = normalizeWorkspace(primary, [], deps.cwd);
      await preflightWorkspace(provider, workspace);
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
      diagnostic(`config: ${error.message}`);
      continue;
    }

    while (true) {
      const additional = await deps.prompter.input(
        "Additional workspace directory (press Enter when finished)",
      );
      if (additional === null) return { kind: "cancelled" };
      if (additional === "") return { kind: "ready", workspace };

      try {
        const candidate = normalizeWorkspace(
          workspace.primaryDirectory,
          [...workspace.additionalDirectories, additional],
          deps.cwd,
        );
        await preflightWorkspace(provider, candidate);
        workspace = candidate;
      } catch (error) {
        if (!(error instanceof WorkspaceError)) throw error;
        diagnostic(`config: ${error.message}`);
      }
    }
  }
}

type ShortcutConfigurationResult =
  | { kind: "ready"; selection: AliasRecord; persistenceBlocker?: PersistenceBlocker }
  | { kind: "cancelled" }
  | { kind: "failed" };

async function captureShortcutConfiguration(
  deps: ApplicationDependencies,
  selection: AliasRecord,
  diagnostic: (text: string) => void,
  validatedCredentials: readonly string[] = [],
): Promise<ShortcutConfigurationResult> {
  const instructions = await captureShortcutInstructions(
    deps,
    diagnostic,
    validatedCredentials,
  );
  if (instructions.kind !== "ready") return instructions;
  const workspace = await captureShortcutWorkspace(deps, selection.provider, diagnostic);
  if (workspace.kind === "cancelled") return workspace;
  return {
    kind: "ready",
    selection: withWorkspace(
      withInstructions(selection, instructions.instructions),
      workspace.workspace,
    ),
    persistenceBlocker: instructions.persistenceBlocker,
  };
}

function runWithAllCredentialMutationLocks<T>(
  deps: ApplicationDependencies,
  operation: () => Promise<T>,
  index = 0,
): Promise<T> {
  if (index === CLOUD_CREDENTIAL_PROVIDERS.length) return operation();
  return runWithCredentialMutationLock(
    deps,
    CLOUD_CREDENTIAL_PROVIDERS[index]!,
    () => runWithAllCredentialMutationLocks(deps, operation, index + 1),
  );
}

function instructionPersistenceGuard(
  deps: ApplicationDependencies,
  instructions: string | undefined,
  persistenceBlocker: PersistenceBlocker | undefined,
): (<T>(operation: () => Promise<T>) => Promise<T>) | undefined {
  if (instructions === undefined || deps.nativeVaultEnabled !== true) {
    return undefined;
  }

  const blocker = persistenceBlocker ?? createPersistenceBlocker(deps.env);
  return (operation) => runWithAllCredentialMutationLocks(deps, async () => {
    for (const name of BYOK_API_KEY_ENV_VARS) {
      const value = deps.env[name];
      if (value !== undefined) blocker.register(value, "environment");
    }
    for (const provider of CLOUD_CREDENTIAL_PROVIDERS) {
      let credential: string | null;
      try {
        credential = await deps.credentialVault.get(provider);
      } catch (error) {
        throw new InstructionCredentialRefreshError(undefined, { cause: error });
      }
      if (credential !== null) {
        deps.sensitive.register(credential);
        blocker.register(credential, "vault");
      }
    }
    if (blocker.blocks(instructions)) throw new InstructionCredentialBlockedError();
    return operation();
  });
}

function withInstructions(
  selection: AliasRecord,
  instructions: string | undefined,
): AliasRecord {
  const { instructions: _instructions, ...rest } = selection;
  return {
    ...rest,
    ...(instructions === undefined ? {} : { instructions }),
  };
}

function withWorkspace(
  selection: AliasRecord,
  workspace: WorkspaceConfig | undefined,
): AliasRecord {
  const { workspace: _workspace, ...rest } = selection;
  return {
    ...rest,
    ...(workspace === undefined ? {} : { workspace }),
  };
}

function instructionTransition(
  current: AliasRecord | undefined,
  next: AliasRecord,
): "none → set" | "set → none" | "set → changed" | "unchanged" {
  const currentValue = current?.instructions;
  const nextValue = next.instructions;
  if (currentValue === nextValue) return "unchanged";
  if (currentValue === undefined) return "none → set";
  if (nextValue === undefined) return "set → none";
  return "set → changed";
}

function workspaceTransition(
  current: AliasRecord | undefined,
  next: AliasRecord,
): "none → set" | "set → none" | "set → changed" | "unchanged" {
  if (sameWorkspace(current?.workspace, next.workspace)) return "unchanged";
  if (current?.workspace === undefined) return "none → set";
  if (next.workspace === undefined) return "set → none";
  return "set → changed";
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
  persistenceBlocker?: PersistenceBlocker;
}

type CredentialAliasResult =
  | { kind: "ready"; alias: PendingAlias }
  | { kind: "none" }
  | { kind: "failed" };

async function prepareCredentialAlias(
  deps: ApplicationDependencies,
  aliases: Readonly<Record<string, AliasRecord>>,
  provider: ByokCloudProviderId,
  models: readonly ByokModelOption[],
  diagnostic: (text: string) => void,
  validatedCredentials: readonly string[] = [],
): Promise<CredentialAliasResult> {
  const safeModels = models.filter((model) =>
    sanitizePromptText(model.id) === model.id
    && deps.sensitive.redact(model.id) === model.id
  );
  if (safeModels.length === 0) {
    diagnostic(
      `model-list (${provider}): provider returned ${models.length === 0 ? "no models" : "no alias-safe models"}; the API key was saved without an alias.`,
    );
    return { kind: "none" };
  }

  const createShortcut = selectedShortcutChoice(
    await deps.prompter.select("Create a model shortcut now?", [
      { value: false, label: "Not now" },
      { value: true, label: "Choose a model…" },
    ]),
  );
  if (createShortcut !== true) return { kind: "none" };

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
  if (model === null) return { kind: "none" };
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
    if (name === null) return { kind: "none" };
    if (name === "") return { kind: "none" };
    if (deps.sensitive.redact(name) !== name) {
      diagnostic("config: alias names must not contain an API key.");
      continue;
    }
    if (!isValidAliasName(name)) {
      diagnostic("config: invalid alias name; use 1-64 ASCII letters, numbers, hyphens, or underscores.");
      continue;
    }

    const capture = await captureShortcutConfiguration(
      deps,
      selection,
      diagnostic,
      validatedCredentials,
    );
    if (capture.kind === "cancelled") return { kind: "none" };
    if (capture.kind === "failed") return { kind: "failed" };
    const pendingSelection = capture.selection;

    const canonicalName = normalizeAliasName(name);
    const current = Object.hasOwn(aliases, canonicalName) ? aliases[canonicalName] : undefined;
    if (current !== undefined && !sameAliasRecord(current, pendingSelection)) {
      const overwrite = await deps.prompter.confirm(
        `Overwrite alias ${canonicalName}?\nOld: ${safeFormatSelection(deps, current)}\nNew: ${safeFormatSelection(deps, pendingSelection)}\nInstructions: ${instructionTransition(current, pendingSelection)}\nWorkspace: ${workspaceTransition(current, pendingSelection)}`,
        { initialValue: false },
      );
      if (overwrite === null) return { kind: "none" };
      if (!overwrite) continue;
    }
    return {
      kind: "ready",
      alias: {
        name: canonicalName,
        selection: pendingSelection,
        expectedCurrent: current,
        persistenceBlocker: capture.persistenceBlocker,
      },
    };
  }
}

function isShortcutSafeModel(
  deps: ApplicationDependencies,
  model: ByokModelOption,
): boolean {
  return sanitizePromptText(model.id) === model.id
    && deps.sensitive.redact(model.id) === model.id
    && deps.sensitive.redact(sanitizePromptText(model.label)) === sanitizePromptText(model.label);
}

type RequiredShortcutTarget =
  | { kind: "selected"; selection: AliasRecord }
  | {
    kind: "validated-models";
    provider: ByokCloudProviderId;
    models: readonly ByokModelOption[];
  };

type RequiredShortcutResult =
  | { kind: "saved"; name: string; selection: AliasRecord }
  | { kind: "cancelled" }
  | { kind: "failed"; reason: "models" | "instructions" };

async function prepareRequiredShortcut(
  deps: ApplicationDependencies,
  target: RequiredShortcutTarget,
  diagnostic: (text: string) => void,
  validatedCredentials: readonly string[] = [],
): Promise<RequiredShortcutResult> {
  let selection: AliasRecord;
  if (target.kind === "selected") {
    selection = target.selection;
  } else {
    const models = target.models.filter((model) => isShortcutSafeModel(deps, model));
    if (models.length === 0) {
      return { kind: "failed", reason: "models" };
    }
    const options = sortPromptOptions(models.map((model) => {
      const id = sanitizePromptText(model.id);
      const label = sanitizePromptText(model.label) || id;
      return {
        value: model.id,
        label,
        ...(label.toLowerCase() !== id.toLowerCase() ? { hint: id } : {}),
      };
    }));
    const model = selectedCredentialModel(
      await deps.prompter.select("Choose a model for the shortcut", options),
      models,
    );
    if (model === null) return { kind: "cancelled" };
    selection = { provider: target.provider, model };
  }

  const save = deps.saveAlias ?? saveStoredAlias;
  namePrompt: while (true) {
    const name = await deps.prompter.input("Name this shortcut", {
      validate: (value) => {
        if (value === undefined || value === "") return "Enter a shortcut name.";
        if (deps.sensitive.redact(value) !== value) {
          return "Shortcut names must not contain an API key.";
        }
        return isValidAliasName(value)
          ? undefined
          : "Use 1-64 ASCII letters, numbers, hyphens, or underscores.";
      },
    });
    if (name === null) return { kind: "cancelled" };
    if (name === "") {
      diagnostic("config: enter a shortcut name.");
      continue;
    }
    if (deps.sensitive.redact(name) !== name) {
      diagnostic("config: shortcut names must not contain an API key.");
      continue;
    }
    if (!isValidAliasName(name)) {
      diagnostic("config: invalid shortcut name; use 1-64 ASCII letters, numbers, hyphens, or underscores.");
      continue;
    }

    while (true) {
      const capture = await captureShortcutConfiguration(
        deps,
        selection,
        diagnostic,
        validatedCredentials,
      );
      if (capture.kind === "cancelled") return { kind: "cancelled" };
      if (capture.kind === "failed") return { kind: "failed", reason: "instructions" };
      const pendingSelection = capture.selection;
      const pendingTargetLabel = safeFormatSelection(deps, pendingSelection);

      let overwriteCancelled = false;
      let result: SaveAliasResult;
      try {
        result = await save(applicationConfigPaths(deps), name, pendingSelection, {
          persistenceBlocker: capture.persistenceBlocker,
          onStaleProfiles: staleProfileReporter(diagnostic),
          persistenceGuard: instructionPersistenceGuard(
            deps,
            pendingSelection.instructions,
            capture.persistenceBlocker,
          ),
          confirmOverwrite: async (_name, current) => {
            const overwrite = await deps.prompter.confirm(
              `Overwrite shortcut ${name}?\nOld: ${
                current === undefined ? "(not present)" : safeFormatSelection(deps, current)
              }\nNew: ${pendingTargetLabel}\nInstructions: ${instructionTransition(current, pendingSelection)}\nWorkspace: ${workspaceTransition(current, pendingSelection)}`,
              { initialValue: false },
            );
            overwriteCancelled = overwrite === null;
            return overwrite === true;
          },
        });
      } catch (error) {
        if (error instanceof InstructionCredentialBlockedError) {
          diagnostic(INSTRUCTION_CREDENTIAL_DIAGNOSTIC);
          continue;
        }
        if (error instanceof InstructionCredentialRefreshError) {
          diagnostic(INSTRUCTION_VAULT_DIAGNOSTIC);
          return { kind: "failed", reason: "instructions" };
        }
        throw error;
      }
      if (result === "declined") {
        if (overwriteCancelled) return { kind: "cancelled" };
        continue namePrompt;
      }

      const colors = createTerminalColors(deps.stderr, deps.env);
      deps.stderr.write(
        result === "already-saved"
          ? `${colors.green(`◆ Shortcut already saved ${name} → ${pendingTargetLabel}`)}\n`
          : `${colors.green(`◆ Saved shortcut ${name} → ${pendingTargetLabel}`)}\n`,
      );
      return { kind: "saved", name, selection: pendingSelection };
    }
  }
}

function applicationAliasPath(deps: ApplicationDependencies): string {
  return deps.aliasPath ?? resolveAliasPath({
    platform: deps.platform,
    home: deps.home,
    env: deps.env,
  });
}

function applicationConfigPaths(deps: ApplicationDependencies) {
  const paths = resolveConfigPaths({
    platform: deps.platform,
    home: deps.home,
    env: deps.env,
  });
  return {
    ...paths,
    configPath: deps.configPath ?? paths.configPath,
    legacyAliasPath: applicationAliasPath(deps),
    legacyVoicePath: deps.voiceConfigPath ?? paths.legacyVoicePath,
  };
}

function loadApplicationConfigSnapshot(
  deps: ApplicationDependencies,
  includeLegacyVoice = false,
): Promise<ConfigSnapshot> {
  return loadConfigSnapshot(applicationConfigPaths(deps), {
    loadLegacyAliases: deps.loadAliases ?? loadStoredAliases,
    readLegacyVoiceConfig: deps.readVoiceConfig,
    includeLegacyVoice,
  });
}

function preflightUnifiedConfig(deps: ApplicationDependencies): Promise<ConfigSnapshot | null> {
  return loadUnifiedConfigSnapshot(applicationConfigPaths(deps).configPath);
}

function staleProfileReporter(
  diagnostic: (text: string) => void,
): (names: readonly string[]) => void {
  return (names) => {
    if (names.length > 0) {
      diagnostic(`config: stale voice profiles not attached: ${[...names].sort().join(", ")}`);
    }
  };
}

function runWithCredentialMutationLock<T>(
  deps: ApplicationDependencies,
  provider: ByokCloudProviderId,
  operation: () => Promise<T>,
): Promise<T> {
  return (deps.credentialMutationLock ?? withCredentialMutationLock)(
    resolveCredentialLockDirectory(deps.home),
    provider,
    operation,
  );
}

type GenerationOutcome =
  | Readonly<{ kind: "completed"; response: string }>
  | Readonly<{ kind: "failed"; error: unknown }>
  | Readonly<{ kind: "timed_out" }>
  | Readonly<{ kind: "cancelled" }>;

async function waitForSettlement(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    operation.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

async function generateWithTimeout(
  deps: ApplicationDependencies,
  provider: ByokProviderId,
  model: string | null,
  prompt: string,
  instructions?: string,
  workspace?: WorkspaceConfig,
  rootSignal?: AbortSignal,
): Promise<GenerationOutcome> {
  const timeoutMs = deps.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS;
  const controller = new AbortController();
  let interrupt: (outcome: GenerationOutcome) => void = () => undefined;
  const interrupted = new Promise<GenerationOutcome>((resolve) => {
    interrupt = resolve;
  });
  const cancel = () => {
    controller.abort(rootSignal?.reason);
    interrupt({ kind: "cancelled" });
  };
  rootSignal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error("generation timed out"));
    interrupt({ kind: "timed_out" });
  }, timeoutMs);
  const generation = Promise.resolve().then(() => deps.runtime.generate(
      provider,
      model,
      prompt,
      controller.signal,
      instructions,
      workspace,
    )).then<GenerationOutcome, GenerationOutcome>(
      (response) => ({ kind: "completed", response }),
      (error) => ({ kind: "failed", error }),
    );
  if (rootSignal?.aborted) cancel();
  const outcome = await Promise.race([generation, interrupted]);
  clearTimeout(timer);
  rootSignal?.removeEventListener("abort", cancel);

  if (outcome.kind === "cancelled" || outcome.kind === "timed_out") {
    if (provider === "codex-cli" || provider === "claude-cli") {
      await generation;
    } else {
      await waitForSettlement(
        generation,
        deps.generationCleanupTimeoutMs ?? DEFAULT_GENERATION_CLEANUP_TIMEOUT_MS,
      );
    }
  }
  return rootSignal?.aborted ? { kind: "cancelled" } : outcome;
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
  snapshot: ConfigSnapshot | null,
  interactive: boolean,
  diagnostic: (text: string) => void,
): Promise<ResolvedSelection | number> {
  const deterministic = requireDeterministicSelection(selection, interactive);
  if (deterministic.kind === "alias") {
    if (snapshot === null || (snapshot.authority === "legacy" && deps.resolveAlias !== undefined)) {
      if (deps.resolveAlias === undefined) {
        throw new AliasStoreError(`alias not found: ${deterministic.alias}`);
      }
      return {
        selection: await preflightAliasWorkspace(
          await deps.resolveAlias(applicationAliasPath(deps), deterministic.alias),
        ),
        shortcutFollowUp: "none",
        alias: normalizeAliasName(deterministic.alias),
      };
    }
    const canonicalName = normalizeAliasName(deterministic.alias);
    const resolved = snapshot.aliases[canonicalName];
    if (resolved === undefined) throw new AliasStoreError(`alias not found: ${deterministic.alias}`);
    return {
      selection: await preflightAliasWorkspace(resolved),
      shortcutFollowUp: "none",
      alias: canonicalName,
    };
  }
  if (deterministic.kind === "explicit") {
    return {
      selection: { provider: deterministic.provider, model: deterministic.model },
      shortcutFollowUp: "legacy",
    };
  }

  if (snapshot === null) throw new AliasStoreError("alias configuration snapshot is unavailable");
  const aliases = snapshot.aliases;
  if (Object.keys(aliases).length > 0) {
    const aliasResult = await selectAliasOrFresh(aliases, deps.prompter);
    if (aliasResult.kind === "cancelled") return aliasResult.exitCode;
    if (aliasResult.kind === "selected") {
      return {
        selection: await preflightAliasWorkspace(aliasResult.selection),
        shortcutFollowUp: "none",
        alias: aliasResult.alias,
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
  modelEligible?: (model: ByokModelOption) => boolean,
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
    modelEligible,
  });
  if (result.kind !== "selected") return result.exitCode;

  const resolved = { provider: result.provider, model: result.model };
  const existingAlias = sortPromptOptions(Object.entries(aliases)
    .filter(([, candidate]) =>
      candidate.provider === resolved.provider
      && candidate.model === resolved.model
      && candidate.instructions === undefined
      && candidate.workspace === undefined
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
    while (true) {
      const capture = await captureShortcutConfiguration(deps, selection, diagnostic);
      if (capture.kind === "cancelled") return true;
      if (capture.kind === "failed") return false;
      const pendingSelection = capture.selection;
      const pendingTarget = safeFormatSelection(deps, pendingSelection);
      const canonicalName = normalizeAliasName(name);
      try {
        const result = await save(applicationConfigPaths(deps), canonicalName, pendingSelection, {
          persistenceBlocker: capture.persistenceBlocker,
          onStaleProfiles: staleProfileReporter(diagnostic),
          persistenceGuard: instructionPersistenceGuard(
            deps,
            pendingSelection.instructions,
            capture.persistenceBlocker,
          ),
          confirmOverwrite: async (_alias, current) =>
            (await deps.prompter.confirm(
              `Overwrite alias ${canonicalName}?\nOld: ${current === undefined ? "(not present)" : safeFormatSelection(deps, current)}\nNew: ${pendingTarget}\nInstructions: ${instructionTransition(current, pendingSelection)}\nWorkspace: ${workspaceTransition(current, pendingSelection)}`,
              { initialValue: false },
            )) === true,
        });
        if (result === "saved") {
          deps.stderr.write(
            colors.green("◆ Saved alias ")
            + colors.white(canonicalName)
            + colors.green(` → ${pendingTarget}\n  Next time, use `)
            + colors.white(`llm-now ${canonicalName} --input "<prompt>"`)
            + "\n",
          );
        } else if (result === "already-saved") {
          deps.stderr.write(`${colors.green(`◆ Already saved ${canonicalName} → ${pendingTarget}`)}\n`);
        }
        return true;
      } catch (error) {
        if (error instanceof InstructionCredentialBlockedError) {
          diagnostic(INSTRUCTION_CREDENTIAL_DIAGNOSTIC);
          continue;
        }
        if (error instanceof InstructionCredentialRefreshError) {
          diagnostic(INSTRUCTION_VAULT_DIAGNOSTIC);
          return false;
        }
        diagnostic(`config: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    }
  }
}

function registerResolvedCredential(
  sensitive: SensitiveValueRegistry,
  credential: Awaited<ReturnType<CredentialResolver["resolve"]>>,
): void {
  if (credential.source === "environment" || credential.source === "vault") {
    sensitive.register(credential.apiKey);
  }
}

type AddCredentialResult =
  | { kind: "saved"; models: readonly ByokModelOption[]; validatedCredential: string }
  | { kind: "stopped"; exitCode: number };

type VerifiedCredentialResult =
  | { kind: "ready"; candidate: string; models: readonly ByokModelOption[] }
  | { kind: "stopped"; exitCode: number };

async function promptAndVerifyCredential(
  deps: ApplicationDependencies,
  provider: ByokCloudProviderId,
  diagnostic: (text: string) => void,
): Promise<VerifiedCredentialResult> {
  let candidate: string;
  while (true) {
    const value = await deps.prompter.password(`Enter the ${providerLabel(provider)} API key`, {
      validate: validateCredentialCandidate,
    });
    if (value === null) return { kind: "stopped", exitCode: 130 };
    deps.sensitive.register(value);
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
  if (save === null) return { kind: "stopped", exitCode: 130 };
  if (!save) return { kind: "stopped", exitCode: 0 };
  return { kind: "ready", candidate, models };
}

async function addCredential(
  deps: ApplicationDependencies,
  provider: ByokCloudProviderId,
  diagnostic: (text: string) => void,
): Promise<AddCredentialResult> {
  const verified = await promptAndVerifyCredential(deps, provider, diagnostic);
  if (verified.kind === "stopped") return verified;
  const written = await runWithCredentialMutationLock(deps, provider, async () => {
    deps.credentialResolver.invalidate?.(provider);
    const current = await deps.credentialResolver.resolve(provider);
    registerResolvedCredential(deps.sensitive, current);
    if (current.source !== "missing") return false;
    await deps.credentialVault.set(provider, verified.candidate);
    deps.credentialResolver.invalidate?.(provider);
    return true;
  });
  if (!written) {
    diagnostic(
      `credential: the ${providerLabel(provider)} credential changed concurrently; the new API key was not saved.`,
    );
    return { kind: "stopped", exitCode: 1 };
  }

  const colors = createTerminalColors(deps.stderr, deps.env);
  deps.stderr.write(
    colors.green(`◆ ${providerLabel(provider)} · API key verified\n`)
    + "  stored as: saved credential\n",
  );
  return {
    kind: "saved",
    models: verified.models,
    validatedCredential: verified.candidate,
  };
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
      const deleted = await runWithCredentialMutationLock(deps, provider, async () => {
        const current = await vault.get(provider);
        if (current !== null) sensitive.register(current);
        if (current !== stored) return null;
        const result = await vault.delete(provider);
        resolver.invalidate?.(provider);
        return result;
      });
      if (deleted === null) {
        diagnostic(
          `credential: the saved ${providerLabel(provider)} API key changed concurrently; it was not deleted.`,
        );
        return 1;
      }
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

  const verified = await promptAndVerifyCredential(deps, provider, diagnostic);
  if (verified.kind === "stopped") return verified.exitCode;

  const written = await runWithCredentialMutationLock(deps, provider, async () => {
    const current = await vault.get(provider);
    if (current !== null) sensitive.register(current);
    if (current !== stored) return false;
    await vault.set(provider, verified.candidate);
    resolver.invalidate?.(provider);
    return true;
  });
  if (!written) {
    diagnostic(
      `credential: the saved ${providerLabel(provider)} API key changed concurrently; the new API key was not saved.`,
    );
    return 1;
  }
  const colors = createTerminalColors(deps.stderr, deps.env);
  deps.stderr.write(
    colors.green(`◆ ${providerLabel(provider)} · API key verified\n`)
    + "  stored as: saved credential\n",
  );

  const aliasResult = await prepareCredentialAlias(
    deps,
    aliases,
    provider,
    verified.models,
    diagnostic,
    [verified.candidate],
  );
  if (aliasResult.kind === "none") return 0;
  if (aliasResult.kind === "failed") return 1;
  const pendingAlias = aliasResult.alias;
  try {
    const saveAlias = deps.saveAlias ?? saveStoredAlias;
    const persistenceGuard = instructionPersistenceGuard(
      deps,
      pendingAlias.selection.instructions,
      pendingAlias.persistenceBlocker,
    );
    const result = await saveAlias(
      applicationConfigPaths(deps),
      pendingAlias.name,
      pendingAlias.selection,
      pendingAlias.expectedCurrent === undefined
        ? {
          persistenceBlocker: pendingAlias.persistenceBlocker,
          persistenceGuard,
          onStaleProfiles: staleProfileReporter(diagnostic),
        }
        : {
          persistenceBlocker: pendingAlias.persistenceBlocker,
          persistenceGuard,
          onStaleProfiles: staleProfileReporter(diagnostic),
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
    if (error instanceof InstructionCredentialBlockedError) {
      diagnostic(INSTRUCTION_CREDENTIAL_DIAGNOSTIC);
      return 1;
    }
    if (error instanceof InstructionCredentialRefreshError) {
      diagnostic(INSTRUCTION_VAULT_DIAGNOSTIC);
      return 1;
    }
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

async function eligibleCredentialProviders(
  deps: ApplicationDependencies,
): Promise<ByokCloudProviderId[]> {
  const eligible: ByokCloudProviderId[] = [];
  for (const provider of CLOUD_CREDENTIAL_PROVIDERS) {
    const credential = await deps.credentialResolver.resolve(provider);
    registerResolvedCredential(deps.sensitive, credential);
    if (credential.source === "missing") eligible.push(provider);
  }
  return eligible;
}

async function finishCreatedShortcut(
  deps: ApplicationDependencies,
  shortcut: Extract<RequiredShortcutResult, { kind: "saved" }>,
  diagnostic: (text: string) => void,
): Promise<LauncherWork | number> {
  const selection = await preflightAliasWorkspace(shortcut.selection);
  const prompt = await collectOneShotPrompt(
    deps,
    aliasPromptMessage(deps, shortcut.name, selection),
  );
  if (prompt === null) {
    diagnostic("The shortcut was saved, but its first prompt was cancelled; no generation ran.");
    return 0;
  }
  return {
    prompt,
    selection: {
      selection,
      shortcutFollowUp: "none",
      alias: shortcut.name,
    },
  };
}

async function createShortcutFromAvailableProvider(
  deps: ApplicationDependencies,
  aliases: Readonly<Record<string, AliasRecord>>,
  diagnostic: (text: string) => void,
): Promise<LauncherWork | number> {
  const selection = await resolveFreshSelection(
    deps,
    aliases,
    diagnostic,
    "none",
    (model) => isShortcutSafeModel(deps, model),
  );
  if (typeof selection === "number") return selection;
  const shortcut = await prepareRequiredShortcut(
    deps,
    { kind: "selected", selection: selection.selection },
    diagnostic,
  );
  if (shortcut.kind === "cancelled") return 130;
  if (shortcut.kind === "failed") return 1;
  return finishCreatedShortcut(deps, shortcut, diagnostic);
}

async function createShortcutWithApiKey(
  deps: ApplicationDependencies,
  diagnostic: (text: string) => void,
): Promise<LauncherWork | number> {
  if (deps.nativeVaultEnabled !== true) {
    diagnostic(
      `native credential storage unavailable on this target; use environment variable ${
        BYOK_API_KEY_ENV_VARS.join(" or ")
      }.`,
    );
    return 1;
  }

  const eligible = await eligibleCredentialProviders(deps);
  if (eligible.length === 0) {
    diagnostic(
      "credential: no API-key provider needs a saved credential; use an available provider or manage an existing credential.",
    );
    return 1;
  }
  const options = cloudCredentialProviderOptions(eligible);
  const selected = await deps.prompter.select("Choose a provider to add", options);
  if (selected === null) return 130;
  if (
    typeof selected !== "string"
    || !options.some((option) => option.value === selected)
  ) {
    throw new RangeError("Prompter returned an invalid credential provider choice.");
  }
  const provider = selected as ByokCloudProviderId;
  const credential = await addCredential(deps, provider, diagnostic);
  if (credential.kind === "stopped") return credential.exitCode;

  let shortcut: RequiredShortcutResult;
  try {
    shortcut = await prepareRequiredShortcut(
      deps,
      {
        kind: "validated-models",
        provider,
        models: credential.models,
      },
      diagnostic,
      [credential.validatedCredential],
    );
  } catch (error) {
    diagnostic(
      `The API key was saved, but the shortcut was not saved: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }
  if (shortcut.kind === "cancelled") {
    diagnostic("The API key was saved, but shortcut creation was cancelled.");
    return 0;
  }
  if (shortcut.kind === "failed") {
    if (shortcut.reason === "models") {
      diagnostic(
        `model-list (${provider}): provider returned ${
          credential.models.length === 0 ? "no models" : "no shortcut-safe models"
        }; the API key was saved without a shortcut.`,
      );
    }
    return 1;
  }
  return finishCreatedShortcut(deps, shortcut, diagnostic);
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
  aliases: Readonly<Record<string, AliasRecord>>,
  diagnostic: (text: string) => void,
): Promise<LauncherWork | number> {
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
    return source === AVAILABLE_PROVIDER_SOURCE_VALUE
      ? createShortcutFromAvailableProvider(deps, aliases, diagnostic)
      : createShortcutWithApiKey(deps, diagnostic);
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
    const selection = await preflightAliasWorkspace(aliasResult.selection);
    const prompt = await collectOneShotPrompt(
      deps,
      aliasPromptMessage(deps, aliasResult.alias, selection),
    );
    if (prompt === null) return 130;
    return {
      prompt,
      selection: {
        selection,
        shortcutFollowUp: "none",
        alias: aliasResult.alias,
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

async function voiceNoticeExit(
  speech: PreparedVoiceSpeech,
  notice: VoiceNotice,
  successfulExit: 0 | 1,
  cancelled: () => 130,
): Promise<number> {
  const outcome = await speakVoiceNotice(speech, notice);
  if (outcome.kind === "cancelled") return cancelled();
  return outcome.kind === "completed" ? successfulExit : 1;
}

async function voicePreflightFailureExit(
  outcome: Exclude<VoiceSpeechPreflightOutcome, { kind: "ready" }>,
  cancelled: () => 130,
): Promise<number> {
  if (outcome.kind === "cancelled") return cancelled();
  if (outcome.noticeSpeech === undefined) return 1;
  return voiceNoticeExit(outcome.noticeSpeech, CONFIG_FAILED_NOTICE, 1, cancelled);
}

export async function runApplication(deps: ApplicationDependencies): Promise<number> {
  const requestValues: string[] = [];
  const diagnostic = diagnosticWriter(deps, requestValues);
  try {
    const parsed = parseArguments(deps.args);
    if (parsed.kind === "help") {
      const colors = pc.createColors(
        deps.stdout.isTTY === true
        && !deps.env.NO_COLOR
        && deps.env.TERM !== "dumb",
      );
      deps.stdout.write(`${renderHelpText(colors, BYOK_API_KEY_ENV_VARS)}\n`);
      return 0;
    }
    if (parsed.kind === "version") {
      deps.stdout.write(`${deps.version}\n`);
      return 0;
    }
    if (parsed.kind === "config-path") {
      deps.stdout.write(`${applicationConfigPaths(deps).configPath}\n`);
      return 0;
    }
    if (parsed.kind === "migrate-config") {
      const paths = applicationConfigPaths(deps);
      const result = await (deps.migrateConfig ?? migrateStoredConfig)(paths);
      staleProfileReporter(diagnostic)(result.staleProfiles);
      deps.stdout.write(
        result.kind === "already-unified"
          ? `Configuration already unified at ${paths.configPath}.\n`
          : result.kind === "created-empty"
          ? `Created empty configuration at ${paths.configPath}.\n`
          : `Migrated configuration to ${paths.configPath}.\n`,
      );
      return 0;
    }
    if (parsed.kind === "aliases") {
      const snapshot = await loadApplicationConfigSnapshot(deps);
      const roster = formatAliasInventory(snapshot.aliases);
      if (roster.length > 0) deps.stdout.write(`${roster}\n`);
      return 0;
    }
    if (parsed.speak && deps.platform !== "darwin") {
      diagnostic("voice: llm-now --speak currently supports macOS only.");
      return 1;
    }

    const cancellation = parsed.speak ? deps.installVoiceCancellation() : undefined;
    let cancellationReported = false;
    const cancelled = (): 130 => {
      if (!cancellationReported) {
        cancellationReported = true;
        diagnostic("voice request cancelled");
      }
      return 130;
    };
    try {
      const signal = cancellation?.signal;
      if (signal?.aborted) return cancelled();
      const interactive = isInteractive(deps.stdin, deps.stderr);
      const requestDeps = signal === undefined
        ? deps
        : { ...deps, prompter: withPromptSignal(deps.prompter, signal) };
      const runner = parsed.speak
        ? deps.voiceRunner ?? createBunVoiceProcessRunner()
        : undefined;
      const preflightSpeech = (
        profile: ConfigSnapshot["voice"]["profiles"][string] | undefined,
      ) => prepareVoiceSpeech({
        sensitive: deps.sensitive,
        env: deps.env,
        runner: runner!,
        signal: signal!,
        diagnostic,
        requestValues,
      }, profile);
      const rejectedRoute = async (
        message: string,
        notice: VoiceNotice,
        successfulExit: 0 | 1,
      ): Promise<number> => {
        diagnostic(message);
        if (!parsed.speak) return 1;
        const preflight = await preflightSpeech(undefined);
        if (preflight.kind !== "ready") {
          return voicePreflightFailureExit(preflight, cancelled);
        }
        return voiceNoticeExit(preflight.speech, notice, successfulExit, cancelled);
      };

      let prompt: string;
      let selection: ResolvedSelection;
      let snapshot: ConfigSnapshot | null = null;
      if (parsed.voiceRoute) {
        snapshot = await loadApplicationConfigSnapshot(deps, true);
        if (signal?.aborted) return cancelled();
        let transcript: string;
        try {
          transcript = await resolveInputSource(parsed.input, deps.stdin, signal);
        } catch (error) {
          if (signal?.aborted) return cancelled();
          if (error instanceof InvalidUtf8Error) {
            return rejectedRoute("voice input rejected: invalid UTF-8", RETRY_NOTICE, 0);
          }
          throw error;
        }
        requestValues.push(transcript);
        if (transcript.trim().length === 0) {
          return rejectedRoute("voice input rejected: dictated transcript is blank", RETRY_NOTICE, 0);
        }
        const route = routeVoiceTranscript(transcript, snapshot);
        if (route.kind === "rejected") {
          if (route.reason === "empty_aliases") {
            return rejectedRoute("voice alias store is empty", CREATE_ALIAS_NOTICE, 1);
          }
          if (route.reason === "invalid_snapshot") {
            return rejectedRoute("voice configuration failed: invalid routing snapshot", CONFIG_FAILED_NOTICE, 1);
          }
          return rejectedRoute(`voice request rejected: ${route.reason}`, RETRY_NOTICE, 0);
        }
        prompt = route.question;
        selection = {
          selection: await preflightAliasWorkspace(route.aliasRecord),
          shortcutFollowUp: "none",
          alias: route.alias,
        };
      } else if (
        interactive
        && (deps.args.length === 0 || (parsed.speak && deps.args.length === 1))
      ) {
        snapshot = await loadApplicationConfigSnapshot(deps, parsed.speak);
        if (signal?.aborted) return cancelled();
        const outcome = await runLauncher(requestDeps, snapshot.aliases, diagnostic);
        if (typeof outcome === "number") {
          return signal?.aborted ? cancelled() : outcome;
        }
        prompt = outcome.prompt;
        selection = outcome.selection;
      } else if (
        parsed.selection.kind === "alias"
        && parsed.input === undefined
        && interactive
      ) {
        snapshot = parsed.speak || deps.resolveAlias === undefined
          ? await loadApplicationConfigSnapshot(deps, parsed.speak)
          : await preflightUnifiedConfig(deps);
        if (signal?.aborted) return cancelled();
        const resolved = await resolveSelection(
          requestDeps,
          parsed.selection,
          snapshot,
          interactive,
          diagnostic,
        );
        if (typeof resolved === "number") {
          return signal?.aborted ? cancelled() : resolved;
        }
        selection = resolved;
        const entered = await collectOneShotPrompt(
          requestDeps,
          aliasPromptMessage(deps, parsed.selection.alias, resolved.selection),
        );
        if (entered === null) return signal?.aborted ? cancelled() : 130;
        prompt = entered;
      } else {
        if (!interactive && parsed.selection.kind === "interactive") {
          requireDeterministicSelection(parsed.selection, false);
        }
        if (
          parsed.input === undefined
          && !interactive
          && deps.stdin.isTTY === true
        ) {
          throw new UsageError("provide --input or pipe prompt text on stdin.");
        }
        let resolvedBeforePrompt: ResolvedSelection | undefined;
        if (parsed.selection.kind === "alias") {
          snapshot = parsed.speak || deps.resolveAlias === undefined
            ? await loadApplicationConfigSnapshot(deps, parsed.speak)
            : await preflightUnifiedConfig(deps);
          if (signal?.aborted) return cancelled();
          const resolved = await resolveSelection(
            requestDeps,
            parsed.selection,
            snapshot,
            interactive,
            diagnostic,
          );
          if (typeof resolved === "number") {
            return signal?.aborted ? cancelled() : resolved;
          }
          resolvedBeforePrompt = resolved;
        }
        if (signal === undefined) {
          prompt = await resolvePrompt(parsed.input, deps.stdin);
        } else {
          try {
            prompt = await resolveInputSource(parsed.input, deps.stdin, signal);
          } catch (error) {
            if (signal.aborted) return cancelled();
            if (error instanceof InvalidUtf8Error) throw new UsageError(error.message);
            throw error;
          }
          const validationMessage = promptValidationMessage(prompt);
          if (validationMessage !== undefined) throw new UsageError(validationMessage);
        }
        if (signal?.aborted) return cancelled();
        if (resolvedBeforePrompt !== undefined) {
          selection = resolvedBeforePrompt;
        } else {
          snapshot = parsed.selection.kind === "explicit"
            ? await preflightUnifiedConfig(deps)
            : await loadApplicationConfigSnapshot(deps, parsed.speak);
          if (signal?.aborted) return cancelled();
          const resolved = await resolveSelection(
            requestDeps,
            parsed.selection,
            snapshot,
            interactive,
            diagnostic,
          );
          if (typeof resolved === "number") {
            return signal?.aborted ? cancelled() : resolved;
          }
          selection = resolved;
        }
      }

      const effectiveInstructions = parsed.instruction ?? selection.selection.instructions;
      requestValues.push(prompt);
      if (effectiveInstructions !== undefined) requestValues.push(effectiveInstructions);
      let speech: PreparedVoiceSpeech | undefined;
      if (parsed.speak) {
        const profile = selection.alias === undefined
          ? undefined
          : snapshot?.voice.profiles[selection.alias];
        const preflight = await preflightSpeech(profile);
        if (preflight.kind !== "ready") {
          return voicePreflightFailureExit(preflight, cancelled);
        }
        speech = preflight.speech;
        prompt = `${VOICE_PROMPT}\n\n${prompt}`;
      }

      const generated = await generateWithTimeout(
        deps,
        selection.selection.provider,
        selection.selection.model,
        prompt,
        effectiveInstructions,
        selection.selection.workspace,
        signal,
      );
      if (generated.kind === "cancelled") return cancelled();
      if (generated.kind === "timed_out") {
        if (speech === undefined) {
          throw new RuntimeStageError(
            "generation",
            selection.selection.provider,
            `timed out after ${deps.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS}ms`,
          );
        }
        diagnostic("voice generation timed out");
        return voiceNoticeExit(speech, REQUEST_FAILED_NOTICE, 0, cancelled);
      }
      if (generated.kind === "failed") {
        if (speech === undefined) throw generated.error;
        diagnostic("voice generation failed");
        return voiceNoticeExit(speech, REQUEST_FAILED_NOTICE, 0, cancelled);
      }
      const response = generated.response;
      if (speech !== undefined) {
        const spoken = await speakVoiceAnswer(speech, response);
        if (spoken.kind === "cancelled") return cancelled();
        if (spoken.kind === "rejected") {
          return voiceNoticeExit(speech, REQUEST_FAILED_NOTICE, 0, cancelled);
        }
        if (spoken.kind === "failed") return 1;
      } else {
        const terminalResponse = stripTerminalSequences(response);
        if (
          deps.sensitive.redact(response) !== response
          || deps.sensitive.redact(terminalResponse) !== terminalResponse
        ) {
          diagnostic("generation: response withheld because it contained a registered credential.");
          return 1;
        }
        await writeResponse(deps.stdout, response);
        if (interactive) writeInteractiveBoundary(deps.stderr, response);
      }

      if (signal?.aborted) return cancelled();
      if (
        interactive
        && selection.shortcutFollowUp !== "none"
        && selection.existingAlias !== undefined
        && parsed.instruction === undefined
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
    } finally {
      cancellation?.dispose();
    }
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

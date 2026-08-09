import {
  BYOK_API_KEY_ENV_VARS,
  isByokProviderId,
  type ByokProviderId,
} from "@swartzrock/byok-runtime";
import pc from "picocolors";
import { parseArgs as parseNodeArgs } from "node:util";
import { hasInvalidInstructionCharacters } from "./aliases.ts";

type TerminalColors = ReturnType<typeof pc.createColors>;

export function renderHelpText(
  colors: TerminalColors,
  credentialNames: readonly string[],
  platform: NodeJS.Platform,
): string {
  const heading = (text: string) => colors.bold(colors.greenBright(text));
  const literal = (text: string) => colors.bold(colors.cyanBright(text));
  const metadata = (text: string) => colors.cyan(text);
  const credentialRows = [...credentialNames]
    .sort()
    .map((name) => `  ${metadata(name)}`)
    .join("\n");
  const secureStorageDetail = platform === "darwin"
    ? `  On macOS, llm-now stores API keys in ${metadata("macOS Keychain")}.`
    : platform === "linux"
      ? `  Linux requires ${metadata("GNOME Keyring")} or ${metadata("KWallet")} in your user session.`
      : "  This platform must provide a supported native credential store.";

  return `A tiny CLI to send text-generation prompts to the models you already run.

${heading("Usage:")}
  ${literal("llm-now")}
  ${literal("llm-now")} ${literal("--aliases")}
  ${literal("llm-now")} ${literal("--config-path")}
  ${literal("llm-now")} ${literal("--migrate-config")}
  ${literal("llm-now")} ${literal("--voice")} [${literal("--input")} ${metadata("<text>")}]
  ${literal("llm-now")} ${literal("--input")} ${metadata("<text>")}
  ${literal("llm-now")} ${metadata("<alias>")}
  ${literal("llm-now")} ${metadata("<alias>")} ${literal("--input")} ${metadata("<text>")}
  ${literal("llm-now")} ${metadata("<alias>")} ${literal("--instruction")} ${metadata("<text>")} ${literal("--input")} ${metadata("<text>")}
  ${literal("llm-now")} ${literal("--provider")} ${metadata("<id>")} ${literal("--model")} ${metadata("<id|default>")} ${literal("--input")} ${metadata("<text>")}

${heading("Rules:")}
  Run ${literal("llm-now")} with no arguments in a terminal to open the adaptive launcher.
  With shortcuts: “Run with a saved shortcut…”, “Create a new shortcut…”,
  “Run once with another provider and model…”, then “Manage connections…”.
  Without shortcuts: “Create a new shortcut…”, “Run once with a provider and model…”,
  then “Manage connections…”.
  Creation uses “Use an available provider…” or “Add a provider with an API key…”.
  Creation saves the provider/model target and optional instructions before its first prompt.
  Saved instructions are sent separately on every shortcut run.
  Run once generates without saving or offering a shortcut.
  Manage connections owns discovery and API-key addition, replacement, and deletion.
  Opening a launcher menu performs no provider discovery or credential access.
  A terminal alias with no input source also asks for one prompt.
  Otherwise, input comes from exactly one of ${literal("--input")} or stdin.
  On macOS, ${literal("--voice")} routes one dictated transcript without changing positional aliases.
  ${literal("--instruction")} is separate from prompt input and applies only to the current request.
  A command-line instruction replaces saved shortcut instructions for that request.
  Arguments, ${literal("--input")}, piped input, and noninteractive calls bypass the launcher.
  Deterministic calls use an alias or both ${literal("--provider")} and ${literal("--model")}.
  Model "default" is available only for codex-cli and claude-cli.

${heading("Options:")}
  ${literal("--aliases")}            List saved aliases
  ${literal("--config-path")}        Print the unified configuration path
  ${literal("--migrate-config")}     Migrate legacy configuration without changing aliases
  ${literal("--voice")}              Route one dictated transcript on macOS
  ${literal("--input")} ${metadata("<text>")}       Prompt text
  ${literal("--instruction")} ${metadata("<text>")} Request-scoped behavioral instruction
  ${literal("--alias")} ${metadata("<name>")}       Saved shortcut selection
  ${literal("--provider")} ${metadata("<id>")}      Explicit provider
  ${literal("--model")} ${metadata("<id>")}         Explicit model, or default for a supported CLI provider
  ${literal("-h, --help")}           Show help
  ${literal("--version")}            Show version

${heading("API key environment variables:")}
${credentialRows}

${heading("Secure API-key storage:")}
  llm-now can save provider API keys securely for reuse.
${secureStorageDetail}`;
}

export const HELP_TEXT = renderHelpText(
  pc.createColors(false),
  BYOK_API_KEY_ENV_VARS,
  process.platform,
);

export class UsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type Selection =
  | { kind: "interactive" }
  | { kind: "alias"; alias: string }
  | { kind: "explicit"; provider: ByokProviderId; model: string | null };

export type ParsedArguments =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "aliases" }
  | { kind: "config-path" }
  | { kind: "migrate-config" }
  | { kind: "voice"; input?: string }
  | { kind: "run"; input?: string; instruction?: string; selection: Selection };

const DEFAULT_MODEL_PROVIDERS = new Set<ByokProviderId>(["codex-cli", "claude-cli"]);

function nonBlankArgument(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim().length === 0) throw new UsageError(`${name} must not be blank.`);
  return value;
}

function instructionArgument(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (hasInvalidInstructionCharacters(value)) {
    throw new UsageError(
      "--instruction must use ordinary line breaks and contain no other control characters.",
    );
  }
  return nonBlankArgument("--instruction", value);
}

export function parseArguments(args: string[]): ParsedArguments {
  let values: {
    input?: string;
    instruction?: string;
    alias?: string;
    provider?: string;
    model?: string;
    aliases?: boolean;
    "config-path"?: boolean;
    "migrate-config"?: boolean;
    voice?: boolean;
    help?: boolean;
    version?: boolean;
  };

  let positionals: string[];

  try {
    ({ values, positionals } = parseNodeArgs({
      args,
      options: {
        input: { type: "string" },
        instruction: { type: "string" },
        alias: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
        aliases: { type: "boolean" },
        "config-path": { type: "boolean" },
        "migrate-config": { type: "boolean" },
        voice: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
      },
      strict: true,
      allowPositionals: true,
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  const supplied = Object.entries(values).filter(([, value]) => value !== undefined && value !== false);
  if (values["config-path"] || values["migrate-config"]) {
    if (supplied.length !== 1 || positionals.length > 0) {
      throw new UsageError("--config-path and --migrate-config must be used alone.");
    }
    return values["config-path"] ? { kind: "config-path" } : { kind: "migrate-config" };
  }
  if (values.aliases) {
    if (supplied.length !== 1 || positionals.length > 0) {
      throw new UsageError("--aliases must be used without other options.");
    }
    return { kind: "aliases" };
  }
  if (values.help || values.version) {
    if (supplied.length !== 1 || positionals.length > 0) {
      throw new UsageError("--help and --version must be used without other options.");
    }
    return values.help ? { kind: "help" } : { kind: "version" };
  }
  if (values.voice) {
    const hasConflictingOption = supplied.some(([name]) => name !== "voice" && name !== "input");
    if (hasConflictingOption || positionals.length > 0) {
      throw new UsageError("--voice may be combined only with --input.");
    }
    return {
      kind: "voice",
      ...(values.input === undefined ? {} : { input: values.input }),
    };
  }

  if (positionals.length > 1) {
    throw new UsageError("only one positional alias may be supplied.");
  }
  if (
    positionals.length === 1
    && (values.alias !== undefined || values.provider !== undefined || values.model !== undefined)
  ) {
    throw new UsageError(
      "positional alias cannot be combined with --alias, --provider, or --model.",
    );
  }

  const input = values.input;
  const instruction = instructionArgument(values.instruction);
  const positionalAlias = nonBlankArgument("alias", positionals[0]);
  const alias = positionalAlias ?? nonBlankArgument("--alias", values.alias);
  const providerValue = nonBlankArgument("--provider", values.provider);
  const modelValue = nonBlankArgument("--model", values.model);

  if (alias !== undefined && (providerValue !== undefined || modelValue !== undefined)) {
    throw new UsageError("--alias cannot be combined with --provider or --model.");
  }
  if ((providerValue === undefined) !== (modelValue === undefined)) {
    throw new UsageError("--provider and --model must be supplied together.");
  }

  let selection: Selection = { kind: "interactive" };
  if (alias !== undefined) {
    selection = { kind: "alias", alias };
  } else if (providerValue !== undefined && modelValue !== undefined) {
    if (!isByokProviderId(providerValue)) {
      throw new UsageError(`Unknown provider: ${providerValue}.`);
    }
    if (modelValue === "default") {
      if (!DEFAULT_MODEL_PROVIDERS.has(providerValue)) {
        throw new UsageError("provider default is supported only by codex-cli and claude-cli.");
      }
      selection = { kind: "explicit", provider: providerValue, model: null };
    } else {
      selection = { kind: "explicit", provider: providerValue, model: modelValue };
    }
  }

  return {
    kind: "run",
    ...(input === undefined ? {} : { input }),
    ...(instruction === undefined ? {} : { instruction }),
    selection,
  };
}

export function requireDeterministicSelection(
  selection: Selection,
  interactive: boolean,
): Selection {
  if (!interactive && selection.kind === "interactive") {
    throw new UsageError(
      "non-interactive calls require a positional alias, --alias, or --provider and --model.",
    );
  }
  return selection;
}

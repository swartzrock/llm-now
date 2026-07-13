import { isByokProviderId, type ByokProviderId } from "@swartzrock/byok-runtime";
import { parseArgs as parseNodeArgs } from "node:util";

export const HELP_TEXT = `Usage:
  llm-now --input <text>
  llm-now --input <text> --alias <name>
  llm-now --input <text> --provider <provider> --model <model|default>
  printf <text> | llm-now --alias <name>
  printf <text> | llm-now --provider <provider> --model <model|default>

Selection:
  Interactive calls choose a provider and model from numbered menus.
  Non-interactive calls require --alias or both --provider and --model.
  --model default is supported only by codex-cli and claude-cli.

Input:
  Supply exactly one source: --input or stdin.

Aliases:
  Saved aliases contain only provider/model selection data.
  macOS/Linux: $XDG_CONFIG_HOME/llm-now/aliases.json or ~/.config/llm-now/aliases.json.
  Windows: %APPDATA%\\llm-now\\aliases.json or the roaming directory under %USERPROFILE%.

Output and diagnostics:
  Successful response text is written byte-for-byte to stdout.
  Menus and stage-labelled diagnostics are written to stderr.

Exit codes:
  0 success/help/version, 1 runtime/configuration failure, 2 invalid usage,
  130 provider/model selection cancelled before generation.

Options:
  --input <text>       Prompt text
  --alias <name>       Saved provider/model selection
  --provider <id>      Explicit provider
  --model <id>         Explicit model, or default for a supported CLI provider
  -h, --help           Show help
  --version            Show version`;

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
  | { kind: "run"; input?: string; selection: Selection };

const DEFAULT_MODEL_PROVIDERS = new Set<ByokProviderId>(["codex-cli", "claude-cli"]);

function nonBlankFlag(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim().length === 0) throw new UsageError(`${name} must not be blank.`);
  return value;
}

export function parseArguments(args: string[]): ParsedArguments {
  let values: {
    input?: string;
    alias?: string;
    provider?: string;
    model?: string;
    help?: boolean;
    version?: boolean;
  };

  try {
    ({ values } = parseNodeArgs({
      args,
      options: {
        input: { type: "string" },
        alias: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  const supplied = Object.entries(values).filter(([, value]) => value !== undefined && value !== false);
  if (values.help || values.version) {
    if (supplied.length !== 1) {
      throw new UsageError("--help and --version must be used without other options.");
    }
    return values.help ? { kind: "help" } : { kind: "version" };
  }

  const input = values.input;
  const alias = nonBlankFlag("--alias", values.alias);
  const providerValue = nonBlankFlag("--provider", values.provider);
  const modelValue = nonBlankFlag("--model", values.model);

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

  return { kind: "run", ...(input === undefined ? {} : { input }), selection };
}

export function requireDeterministicSelection(
  selection: Selection,
  interactive: boolean,
): Selection {
  if (!interactive && selection.kind === "interactive") {
    throw new UsageError(
      "non-interactive calls require --alias or --provider and --model.",
    );
  }
  return selection;
}

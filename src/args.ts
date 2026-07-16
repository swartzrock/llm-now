import {
  BYOK_API_KEY_ENV_VARS,
  isByokProviderId,
  type ByokProviderId,
} from "@swartzrock/byok-runtime";
import pc from "picocolors";
import { parseArgs as parseNodeArgs } from "node:util";

type TerminalColors = ReturnType<typeof pc.createColors>;

export function renderHelpText(
  colors: TerminalColors,
  credentialNames: readonly string[],
): string {
  const heading = (text: string) => colors.bold(colors.greenBright(text));
  const literal = (text: string) => colors.bold(colors.cyanBright(text));
  const metadata = (text: string) => colors.cyan(text);
  const credentialRows = [...credentialNames]
    .sort()
    .map((name) => `  ${metadata(name)}`)
    .join("\n");

  return `Send a prompt to a selected model.

${heading("Usage:")}
  ${literal("llm-now")} ${literal("--input")} ${metadata("<text>")}
  ${literal("llm-now")} ${metadata("<alias>")} ${literal("--input")} ${metadata("<text>")}
  ${literal("llm-now")} ${literal("--provider")} ${metadata("<id>")} ${literal("--model")} ${metadata("<id|default>")} ${literal("--input")} ${metadata("<text>")}

${heading("Rules:")}
  Input comes from exactly one of ${literal("--input")} or stdin.
  Omit selection for interactive choice; otherwise use an alias or provider/model.
  Model "default" is available only for codex-cli and claude-cli.

${heading("Options:")}
  ${literal("--input")} ${metadata("<text>")}       Prompt text
  ${literal("--alias")} ${metadata("<name>")}       Saved provider/model selection
  ${literal("--provider")} ${metadata("<id>")}      Explicit provider
  ${literal("--model")} ${metadata("<id>")}         Explicit model, or default for a supported CLI provider
  ${literal("-h, --help")}           Show help
  ${literal("--version")}            Show version

${heading("API key environment variables:")}
${credentialRows}`;
}

export const HELP_TEXT = renderHelpText(pc.createColors(false), BYOK_API_KEY_ENV_VARS);

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

function nonBlankArgument(name: string, value: string | undefined): string | undefined {
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

  let positionals: string[];

  try {
    ({ values, positionals } = parseNodeArgs({
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
      allowPositionals: true,
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  const supplied = Object.entries(values).filter(([, value]) => value !== undefined && value !== false);
  if (values.help || values.version) {
    if (supplied.length !== 1 || positionals.length > 0) {
      throw new UsageError("--help and --version must be used without other options.");
    }
    return values.help ? { kind: "help" } : { kind: "version" };
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

  return { kind: "run", ...(input === undefined ? {} : { input }), selection };
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

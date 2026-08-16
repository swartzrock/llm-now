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
): string {
  const heading = (text: string) => colors.bold(colors.greenBright(text));
  const literal = (text: string) => colors.bold(colors.cyanBright(text));
  const metadata = (text: string) => colors.cyan(text);
  const sortedCredentialNames = [...credentialNames].sort();
  const credentialColumnWidth = Math.max(
    0,
    ...sortedCredentialNames.map((name) => name.length),
  ) + 4;
  const credentialRows: string[] = [];
  for (let index = 0; index < sortedCredentialNames.length; index += 2) {
    const left = sortedCredentialNames[index] ?? "";
    const right = sortedCredentialNames[index + 1];
    credentialRows.push(
      right === undefined
        ? `  ${metadata(left)}`
        : `  ${metadata(left)}${" ".repeat(credentialColumnWidth - left.length)}${metadata(right)}`,
    );
  }

  return `A tiny CLI for prompting models you already use.

${heading("Usage:")}
  ${literal("llm-now")} [${metadata("<alias>")} | ${literal("--alias")} ${metadata("<name>")}] [${literal("--input")} ${metadata("<text>")}]
          [${literal("--instruction")} ${metadata("<text>")}] [${literal("--stream")}] [${literal("--speak")}]
  ${literal("llm-now")} ${literal("--provider")} ${metadata("<id>")} ${literal("--model")} ${metadata("<id|default>")} [${literal("--input")} ${metadata("<text>")}]
          [${literal("--instruction")} ${metadata("<text>")}] [${literal("--stream")}] [${literal("--speak")}]
  ${literal("llm-now")} ${literal("--voice-route")} [${literal("--input")} ${metadata("<text>")}] [${literal("--instruction")} ${metadata("<text>")}] [${literal("--stream")}] [${literal("--speak")}]
  ${literal("llm-now")} ${literal("--aliases")}
  ${literal("llm-now")} ${literal("--config-path")}
  ${literal("llm-now")} ${literal("--migrate-config")}

${heading("Notes:")}
  Run without arguments to open the interactive launcher.
  Read input from ${literal("--input")}, stdin, or a terminal prompt; choose one.
  A workspace fixes execution to one primary directory plus ordered additional directories.
  Saved shortcuts remain global; a stored workspace does not restrict where you can call one.
  Codex CLI and Claude CLI support workspaces; local HTTP servers and cloud APIs reject them.
  Workspace access must be declared as read-only or read-write; only Codex CLI supports read-write. Paths are plaintext local configuration, and files read by the CLI may be sent to its selected service.

${heading("Options:")}
  ${literal("--aliases")}            List saved shortcuts
  ${literal("--config-path")}        Print the config.toml path
  ${literal("--migrate-config")}     Migrate legacy configuration to config.toml
  ${literal("--voice-route")}        Parse “[wake word] <shortcut> <question>” from input
  ${literal("--speak")}              Speak the response on macOS instead of using stdout
  ${literal("--stream")}             Write response chunks to stdout as they arrive
  ${literal("--input")} ${metadata("<text>")}       Prompt or dictated input
  ${literal("--instruction")} ${metadata("<text>")} Replace shared alias guidance for this request
  ${literal("--alias")} ${metadata("<name>")}       Select a saved shortcut
  ${literal("--provider")} ${metadata("<id>")}      Select a provider
  ${literal("--model")} ${metadata("<id|default>")} Select a model; default supports codex-cli and claude-cli
  ${literal("-h, --help")}           Show help
  ${literal("--version")}            Show version

${heading("API key environment variables:")}
${credentialRows.join("\n")}

API keys can also be stored securely through the interactive launcher.`;
}

export const HELP_TEXT = renderHelpText(
  pc.createColors(false),
  BYOK_API_KEY_ENV_VARS,
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
  | {
    kind: "run";
    input?: string;
    instruction?: string;
    voiceRoute?: boolean;
    speak?: boolean;
    stream?: boolean;
    selection: Selection;
  };

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
    "voice-route"?: boolean;
    speak?: boolean;
    stream?: boolean;
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
        "voice-route": { type: "boolean" },
        speak: { type: "boolean" },
        stream: { type: "boolean" },
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
  if (positionals.length > 1) {
    throw new UsageError("only one positional alias may be supplied.");
  }
  const voiceRoute = values["voice-route"] === true;
  const speak = values.speak === true;
  const stream = values.stream === true;
  if (speak && stream) {
    throw new UsageError("--stream cannot be combined with --speak.");
  }
  if (
    voiceRoute
    && (
      positionals.length > 0
      || values.alias !== undefined
      || values.provider !== undefined
      || values.model !== undefined
    )
  ) {
    throw new UsageError(
      "--voice-route cannot be combined with an alias, --provider, or --model.",
    );
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
    ...(voiceRoute ? { voiceRoute: true } : {}),
    ...(speak ? { speak: true } : {}),
    ...(stream ? { stream: true } : {}),
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

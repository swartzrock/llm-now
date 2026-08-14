import { describe, expect, test } from "bun:test";
import { BYOK_API_KEY_ENV_VARS } from "@swartzrock/byok-runtime";
import pc from "picocolors";
import {
  HELP_TEXT,
  type Selection,
  UsageError,
  parseArguments,
  renderHelpText,
  requireDeterministicSelection,
} from "../src/args.ts";
import {
  InvalidUtf8Error,
  isInteractive,
  promptValidationMessage,
  readUtf8,
  resolveInputSource,
  resolvePrompt,
} from "../src/io.ts";
import { stripTerminalSequences } from "../src/prompts.ts";

const APPROVED_HELP_TEXT = `A tiny CLI for prompting models you already use.

Usage:
  llm-now [<alias> | --alias <name>] [--input <text>]
          [--instruction <text>] [--stream] [--speak]
  llm-now --provider <id> --model <id|default> [--input <text>]
          [--instruction <text>] [--stream] [--speak]
  llm-now --voice-route [--input <text>] [--instruction <text>] [--stream] [--speak]
  llm-now --aliases
  llm-now --config-path
  llm-now --migrate-config

Notes:
  Run without arguments to open the interactive launcher.
  Read input from --input, stdin, or a terminal prompt; choose one.
  A workspace fixes execution to one primary directory plus ordered additional directories.
  Saved shortcuts remain global; a stored workspace does not restrict where you can call one.
  Codex CLI and Claude CLI support workspaces; local HTTP servers and cloud APIs reject them.
  Workspace access must be declared as read-only or read-write; only Codex CLI supports read-write. Paths are plaintext local configuration, and files read by the CLI may be sent to its selected service.

Options:
  --aliases            List saved shortcuts
  --config-path        Print the config.toml path
  --migrate-config     Migrate legacy configuration to config.toml
  --voice-route        Parse “[wake word] <shortcut> <question>” from input
  --speak              Speak the response on macOS instead of using stdout
  --stream             Write response chunks to stdout as they arrive
  --input <text>       Prompt or dictated input
  --instruction <text> Replace shared alias guidance for this request
  --alias <name>       Select a saved shortcut
  --provider <id>      Select a provider
  --model <id|default> Select a model; default supports codex-cli and claude-cli
  -h, --help           Show help
  --version            Show version

API key environment variables:
  ANTHROPIC_API_KEY     DEEPINFRA_TOKEN
  DEEPSEEK_API_KEY      GEMINI_API_KEY
  GOOGLE_API_KEY        GROQ_API_KEY
  MISTRAL_API_KEY       OPENAI_API_KEY
  OPENROUTER_API_KEY    XAI_API_KEY

API keys can also be stored securely through the interactive launcher.`;

function input(text: string, isTTY = false) {
  return {
    isTTY,
    async *[Symbol.asyncIterator]() {
      yield new TextEncoder().encode(text);
    },
  };
}

describe("arguments and input", () => {
  test("preserves exact --input text when stdin is a TTY", async () => {
    const parsed = parseArguments(["--input", "  exact prompt  "]);
    expect(parsed).toMatchObject({ kind: "run", input: "  exact prompt  " });
    if (parsed.kind !== "run") throw new Error("expected run arguments");
    expect(await resolvePrompt(parsed.input, input("", true))).toBe("  exact prompt  ");
  });

  test("accepts --input when non-TTY stdin is empty", async () => {
    const parsed = parseArguments(["--input", "prompt"]);
    if (parsed.kind !== "run") throw new Error("expected run arguments");
    expect(await resolvePrompt(parsed.input, input(""))).toBe("prompt");
  });

  test("preserves exact piped stdin text", async () => {
    const parsed = parseArguments(["--alias", "daily"]);
    if (parsed.kind !== "run") throw new Error("expected run arguments");
    expect(await resolvePrompt(parsed.input, input("line one\nline two\n"))).toBe(
      "line one\nline two\n",
    );
  });

  test("exposes strict UTF-8 and source resolution without applying prompt blank rules", async () => {
    await expect(readUtf8(input(""))).resolves.toBe("");
    await expect(resolveInputSource("  exact flag  ", input(""))).resolves.toBe(
      "  exact flag  ",
    );
    await expect(resolveInputSource(undefined, input("  exact stdin  "))).resolves.toBe(
      "  exact stdin  ",
    );
    await expect(resolveInputSource("flag", input("stdin"))).rejects.toThrow(
      "exactly one input source",
    );

    const invalid = {
      isTTY: false,
      async *[Symbol.asyncIterator]() {
        yield Uint8Array.from([0xc3, 0x28]);
      },
    };
    await expect(readUtf8(invalid)).rejects.toBeInstanceOf(InvalidUtf8Error);
    await expect(resolvePrompt(undefined, invalid)).rejects.toThrow("valid UTF-8");
  });

  test("normalizes one exact positional alias before or after options", () => {
    expect(parseArguments(["Daily", "--input", "hello"])).toEqual({
      kind: "run",
      input: "hello",
      selection: { kind: "alias", alias: "Daily" },
    });
    expect(parseArguments(["--input", "hello", "Daily"])).toEqual({
      kind: "run",
      input: "hello",
      selection: { kind: "alias", alias: "Daily" },
    });
    expect(parseArguments(["Daily"])).toEqual({
      kind: "run",
      selection: { kind: "alias", alias: "Daily" },
    });
  });

  test("parses voice routing and speech as independent run modifiers", () => {
    expect(parseArguments(["--voice-route"])).toEqual({
      kind: "run",
      voiceRoute: true,
      selection: { kind: "interactive" },
    });
    expect(parseArguments(["--speak"])).toEqual({
      kind: "run",
      speak: true,
      selection: { kind: "interactive" },
    });
    expect(
      parseArguments([
        "--voice-route",
        "--speak",
        "--instruction",
        "  temporary\nrule  ",
        "--input",
        "  dictated text  ",
      ]),
    ).toEqual({
      kind: "run",
      input: "  dictated text  ",
      instruction: "  temporary\nrule  ",
      voiceRoute: true,
      speak: true,
      selection: { kind: "interactive" },
    });
  });

  test("parses streaming as a run modifier and rejects speech composition", () => {
    expect(parseArguments(["daily", "--stream", "--input", "hello"])).toEqual({
      kind: "run",
      input: "hello",
      stream: true,
      selection: { kind: "alias", alias: "daily" },
    });
    expect(() => parseArguments(["daily", "--stream", "--speak"])).toThrow(
      "--stream cannot be combined with --speak",
    );
  });

  test("composes speech with every ordinary selection surface", () => {
    expect(parseArguments(["daily", "--speak", "--input", "hello"])).toEqual({
      kind: "run",
      input: "hello",
      speak: true,
      selection: { kind: "alias", alias: "daily" },
    });
    expect(parseArguments(["--alias", "daily", "--speak"])).toEqual({
      kind: "run",
      speak: true,
      selection: { kind: "alias", alias: "daily" },
    });
    expect(
      parseArguments([
        "--provider",
        "ollama",
        "--model",
        "qwen",
        "--speak",
      ]),
    ).toEqual({
      kind: "run",
      speak: true,
      selection: { kind: "explicit", provider: "ollama", model: "qwen" },
    });
  });

  test("rejects routing combined with another selection", () => {
    const conflicts = [
      ["--voice-route", "daily"],
      ["--voice-route", "--alias", "daily"],
      ["--voice-route", "--provider", "ollama", "--model", "qwen"],
      ["--voice-route", "--provider", "ollama"],
      ["--voice-route", "--model", "qwen"],
    ];
    for (const args of conflicts) {
      expect(() => parseArguments(args)).toThrow(
        "--voice-route cannot be combined with an alias, --provider, or --model",
      );
    }
  });

  test("retires --voice while preserving voice-related positional aliases", () => {
    try {
      parseArguments(["--voice"]);
      throw new Error("expected retired option to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).exitCode).toBe(2);
      expect((error as Error).message).toContain("Unknown option '--voice'");
    }

    for (const alias of ["voice", "voice-route", "speak", "stream"]) {
      expect(parseArguments([alias, "--input", "hello"])).toEqual({
        kind: "run",
        input: "hello",
        selection: { kind: "alias", alias },
      });
    }
  });

  test("preserves an exact request instruction across every selection surface", () => {
    const instruction = "  temporary\nrule  ";
    const cases: Array<{ args: string[]; selection: Selection }> = [
      {
        args: ["Daily", "--instruction", instruction],
        selection: { kind: "alias", alias: "Daily" },
      },
      {
        args: ["--alias", "Daily", "--instruction", instruction],
        selection: { kind: "alias", alias: "Daily" },
      },
      {
        args: [
          "--provider",
          "ollama",
          "--model",
          "qwen",
          "--instruction",
          instruction,
        ],
        selection: { kind: "explicit", provider: "ollama", model: "qwen" },
      },
      {
        args: ["--instruction", instruction],
        selection: { kind: "interactive" },
      },
    ];

    for (const { args, selection } of cases) {
      expect(parseArguments(args)).toEqual({
        kind: "run",
        instruction,
        selection,
      });
    }
  });

  test("rejects blank and prohibited instruction text with fixed value-free errors", () => {
    const invalid = [
      ["", "--instruction must not be blank."],
      [" \n ", "--instruction must not be blank."],
      ["\t", "--instruction must use ordinary line breaks and contain no other control characters."],
      ["one\rtwo", "--instruction must use ordinary line breaks and contain no other control characters."],
      ["one\u0000two", "--instruction must use ordinary line breaks and contain no other control characters."],
      ["one\u0085two", "--instruction must use ordinary line breaks and contain no other control characters."],
      ["one\u2028two", "--instruction must use ordinary line breaks and contain no other control characters."],
      ["one\u2029two", "--instruction must use ordinary line breaks and contain no other control characters."],
    ] as const;

    for (const [value, message] of invalid) {
      try {
        parseArguments(["--instruction", value]);
        throw new Error("expected instruction validation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(UsageError);
        expect((error as UsageError).exitCode).toBe(2);
        expect((error as Error).message).toBe(message);
        if (value.length > 0) expect((error as Error).message).not.toContain(value);
      }
    }
  });

  test("uses the last instruction and accepts a dash-leading equals value", () => {
    expect(
      parseArguments([
        "Daily",
        "--instruction",
        "first",
        "--instruction",
        "second",
      ]),
    ).toMatchObject({ kind: "run", instruction: "second" });
    expect(parseArguments(["Daily", "--instruction=-brief"])).toMatchObject({
      kind: "run",
      instruction: "-brief",
    });
  });

  test("treats bare help, version, and run as alias names", () => {
    for (const alias of ["help", "version", "run"]) {
      expect(parseArguments([alias])).toEqual({
        kind: "run",
        selection: { kind: "alias", alias },
      });
    }
  });

  test("rejects blank and multiple positional aliases", () => {
    for (const alias of ["", "   "]) {
      expect(() => parseArguments([alias])).toThrow("alias must not be blank");
    }
    expect(() => parseArguments(["daily", "prompt"])).toThrow(
      "only one positional alias may be supplied",
    );
  });

  test("rejects positional aliases combined with another selector", () => {
    const conflicting = [
      ["Daily", "--alias", "daily"],
      ["Daily", "--provider", "ollama", "--model", "qwen"],
      ["Daily", "--provider", "ollama"],
      ["Daily", "--model", "qwen"],
    ];
    for (const args of conflicting) {
      expect(() => parseArguments(args)).toThrow(
        "positional alias cannot be combined with --alias, --provider, or --model",
      );
    }
  });

  test("rejects both input sources, neither source, and blank input", async () => {
    const parsed = parseArguments(["--input", "prompt"]);
    if (parsed.kind !== "run") throw new Error("expected run arguments");
    await expect(resolvePrompt(parsed.input, input("piped"))).rejects.toThrow(
      "exactly one input source",
    );
    await expect(resolvePrompt(undefined, input("", true))).rejects.toThrow(
      "provide --input or pipe prompt text",
    );
    await expect(resolvePrompt(" \n ", input("", true))).rejects.toThrow(
      "prompt must not be blank",
    );
  });

  test("shares blank validation without transforming accepted prompt text", () => {
    for (const value of [undefined, "", " \n "]) {
      expect(promptValidationMessage(value)).toBe("prompt must not be blank.");
    }
    expect(promptValidationMessage("  exact prompt  ")).toBeUndefined();
  });

  test("rejects invalid UTF-8 from stdin", async () => {
    const stdin = {
      isTTY: false,
      async *[Symbol.asyncIterator]() {
        yield Uint8Array.from([0xc3, 0x28]);
      },
    };
    await expect(resolvePrompt(undefined, stdin)).rejects.toThrow("valid UTF-8");
  });

  test("preserves stdin I/O errors as operational failures", async () => {
    const failure = new Error("stdin read failed");
    const stdin = {
      isTTY: false,
      async *[Symbol.asyncIterator]() {
        throw failure;
      },
    };
    await expect(resolvePrompt(undefined, stdin)).rejects.toBe(failure);
  });

  test("rejects alias and explicit selection ambiguity", () => {
    expect(() =>
      parseArguments([
        "--input",
        "hello",
        "--alias",
        "daily",
        "--provider",
        "ollama",
        "--model",
        "llama3",
      ]),
    ).toThrow("--alias cannot be combined");
  });

  test("requires a complete explicit provider and model selection", () => {
    expect(() => parseArguments(["--input", "hello", "--provider", "ollama"])).toThrow(
      "--provider and --model must be supplied together",
    );
    expect(() => parseArguments(["--input", "hello", "--model", "llama3"])).toThrow(
      "--provider and --model must be supplied together",
    );
  });

  test("maps default only for runtime-supported CLI providers", () => {
    expect(
      parseArguments([
        "--input",
        "hello",
        "--provider",
        "codex-cli",
        "--model",
        "default",
      ]),
    ).toMatchObject({
      kind: "run",
      selection: { kind: "explicit", provider: "codex-cli", model: null },
    });
    expect(() =>
      parseArguments([
        "--input",
        "hello",
        "--provider",
        "ollama",
        "--model",
        "default",
      ]),
    ).toThrow("provider default is supported only");
  });

  test("requires deterministic selection outside an interactive terminal", () => {
    const interactive = parseArguments(["--input", "hello"]);
    if (interactive.kind !== "run") throw new Error("expected run arguments");
    expect(() => requireDeterministicSelection(interactive.selection, false)).toThrow(
      "non-interactive calls require a positional alias, --alias, or --provider and --model",
    );

    const aliased = parseArguments(["--input", "hello", "--alias", "daily"]);
    if (aliased.kind !== "run") throw new Error("expected run arguments");
    expect(requireDeterministicSelection(aliased.selection, false)).toEqual({
      kind: "alias",
      alias: "daily",
    });

    const instructed = parseArguments([
      "--input",
      "hello",
      "--instruction",
      "temporary",
    ]);
    if (instructed.kind !== "run") throw new Error("expected run arguments");
    expect(() => requireDeterministicSelection(instructed.selection, false)).toThrow(
      "non-interactive calls require a positional alias, --alias, or --provider and --model",
    );
  });

  test("keeps instruction separate from prompt-source validation", async () => {
    const parsed = parseArguments([
      "--input",
      "prompt",
      "--instruction",
      "temporary",
    ]);
    if (parsed.kind !== "run") throw new Error("expected run arguments");
    await expect(resolvePrompt(parsed.input, input("piped"))).rejects.toThrow(
      "exactly one input source",
    );

    const instructionOnly = parseArguments(["--instruction", "temporary"]);
    if (instructionOnly.kind !== "run") throw new Error("expected run arguments");
    await expect(resolvePrompt(instructionOnly.input, input("", true))).rejects.toThrow(
      "provide --input or pipe prompt text",
    );
  });

  test("interactivity requires both readable stdin and diagnostic TTY", () => {
    expect(isInteractive({ isTTY: true }, { isTTY: true })).toBe(true);
    expect(isInteractive({ isTTY: false }, { isTTY: true })).toBe(false);
    expect(isInteractive({ isTTY: true }, { isTTY: false })).toBe(false);
  });

  test("help and version remain stable standalone modes", () => {
    expect(parseArguments(["--help"])).toEqual({ kind: "help" });
    expect(parseArguments(["--version"])).toEqual({ kind: "version" });
    expect(() => parseArguments(["--help", "--alias", "daily"])).toThrow(UsageError);
    expect(() => parseArguments(["--help", "daily"])).toThrow(UsageError);
    expect(() => parseArguments(["daily", "--help"])).toThrow(UsageError);
    expect(() => parseArguments(["--version", "daily"])).toThrow(UsageError);
    expect(() => parseArguments(["daily", "--version"])).toThrow(UsageError);
    expect(() => parseArguments(["--help", "--instruction", "temporary"])).toThrow(
      UsageError,
    );
    expect(() => parseArguments(["--version", "--instruction", "temporary"])).toThrow(
      UsageError,
    );
    for (const option of ["--voice-route", "--speak", "--stream"]) {
      expect(() => parseArguments(["--help", option])).toThrow(UsageError);
      expect(() => parseArguments(["--version", option])).toThrow(UsageError);
    }
  });

  test("aliases is a standalone option while the bare word remains an alias", () => {
    expect(parseArguments(["--aliases"])).toEqual({ kind: "aliases" });
    expect(parseArguments(["aliases"])).toEqual({
      kind: "run",
      selection: { kind: "alias", alias: "aliases" },
    });
    expect(() => parseArguments(["--aliases", "--input", "hello"])).toThrow(UsageError);
    expect(() => parseArguments(["--aliases", "--instruction", "temporary"])).toThrow(
      UsageError,
    );
    expect(() => parseArguments(["--aliases", "--voice-route"])).toThrow(UsageError);
    expect(() => parseArguments(["--aliases", "--speak"])).toThrow(UsageError);
    expect(() => parseArguments(["--aliases", "--stream"])).toThrow(UsageError);
  });

  test("configuration maintenance flags are standalone and mutually exclusive", () => {
    expect(parseArguments(["--config-path"])).toEqual({ kind: "config-path" });
    expect(parseArguments(["--migrate-config"])).toEqual({ kind: "migrate-config" });
    for (const args of [
      ["--config-path", "daily"],
      ["--config-path", "--aliases"],
      ["--migrate-config", "--input", "prompt"],
      ["--migrate-config", "--config-path"],
      ["--migrate-config", "--provider", "ollama", "--model", "qwen"],
    ]) expect(() => parseArguments(args)).toThrow(UsageError);
    for (const mode of ["--config-path", "--migrate-config"]) {
      for (const option of ["--voice-route", "--speak", "--stream"]) {
        expect(() => parseArguments([mode, option])).toThrow(UsageError);
      }
    }
  });

  test("renders the exact approved compact plain help", () => {
    const linuxHelp = renderHelpText(
      pc.createColors(false),
      BYOK_API_KEY_ENV_VARS,
    );
    expect(linuxHelp).toBe(APPROVED_HELP_TEXT);
    expect(linuxHelp).not.toContain("llm-now --voice [");
    expect(linuxHelp).not.toContain("\n  --voice              ");
    expect(HELP_TEXT).toBe(
      renderHelpText(pc.createColors(false), BYOK_API_KEY_ENV_VARS),
    );
    for (const rejectedCopy of [
      "printf",
      "Selection:",
      "Input:",
      "Aliases:",
      "Output and diagnostics:",
      "Exit codes:",
      "XDG_CONFIG_HOME",
    ]) {
      expect(linuxHelp).not.toContain(rejectedCopy);
    }
  });

  test("copies and ASCII-sorts credential names without mutating the input", () => {
    const credentialNames = Object.freeze([
      "ZETA_API_KEY",
      "ALPHA_API_KEY",
      "MIDDLE_TOKEN",
    ]);
    const originalOrder = [...credentialNames];
    const rendered = renderHelpText(pc.createColors(false), credentialNames);

    expect(credentialNames).toEqual(originalOrder);
    expect(rendered).toContain(
      `API key environment variables:\n  ALPHA_API_KEY    MIDDLE_TOKEN\n  ZETA_API_KEY`,
    );
    for (const name of credentialNames) {
      expect(rendered.split(name)).toHaveLength(2);
    }
  });

  test("lists every runtime-supported credential name exactly once", () => {
    for (const name of BYOK_API_KEY_ENV_VARS) {
      expect(HELP_TEXT.split(name)).toHaveLength(2);
    }
  });

  test("applies semantic ANSI roles without changing the plain layout", () => {
    const colors = pc.createColors(true);
    const rendered = renderHelpText(colors, BYOK_API_KEY_ENV_VARS);

    expect(rendered).toContain(colors.bold(colors.greenBright("Usage:")));
    expect(rendered).toContain(colors.bold(colors.cyanBright("llm-now")));
    expect(rendered).toContain(colors.bold(colors.cyanBright("--voice-route")));
    expect(rendered).toContain(colors.bold(colors.cyanBright("--speak")));
    expect(rendered).toContain(colors.bold(colors.cyanBright("--stream")));
    expect(rendered).toContain(colors.bold(colors.cyanBright("--input")));
    expect(rendered).toContain(colors.bold(colors.cyanBright("--instruction")));
    expect(rendered).toContain(colors.cyan("<text>"));
    expect(rendered).toContain(colors.cyan("ANTHROPIC_API_KEY"));
    expect(rendered).toContain(colors.bold(colors.greenBright("Notes:")));
    expect(rendered).toContain("Prompt or dictated input");
    expect(rendered).toContain("stored securely through the interactive launcher");
    expect(stripTerminalSequences(rendered)).toBe(APPROVED_HELP_TEXT);
  });

  test("rejects test-only runtime smoke arguments", () => {
    expect(() => parseArguments(["--runtime-smoke", "/tmp/program"])).toThrow(UsageError);
  });
});

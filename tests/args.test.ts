import { describe, expect, test } from "bun:test";
import { BYOK_API_KEY_ENV_VARS } from "@swartzrock/byok-runtime";
import pc from "picocolors";
import {
  HELP_TEXT,
  UsageError,
  parseArguments,
  renderHelpText,
  requireDeterministicSelection,
} from "../src/args.ts";
import { isInteractive, resolvePrompt } from "../src/io.ts";
import { stripTerminalSequences } from "../src/prompts.ts";

const APPROVED_HELP_TEXT = `Send a prompt to a selected model.

Usage:
  llm-now
  llm-now --input <text>
  llm-now <alias> --input <text>
  llm-now --provider <id> --model <id|default> --input <text>

Rules:
  Run llm-now with no arguments in a terminal to set up providers and API keys.
  Input comes from exactly one of --input or stdin.
  Omit selection for interactive choice; otherwise use an alias or provider/model.
  Model "default" is available only for codex-cli and claude-cli.

Options:
  --input <text>       Prompt text
  --alias <name>       Saved provider/model selection
  --provider <id>      Explicit provider
  --model <id>         Explicit model, or default for a supported CLI provider
  -h, --help           Show help
  --version            Show version

API key environment variables:
  ANTHROPIC_API_KEY
  DEEPINFRA_TOKEN
  DEEPSEEK_API_KEY
  GEMINI_API_KEY
  GOOGLE_API_KEY
  GROQ_API_KEY
  MISTRAL_API_KEY
  OPENAI_API_KEY
  OPENROUTER_API_KEY
  XAI_API_KEY

Secure API-key storage:
  llm-now can save provider API keys securely for reuse.
  Linux requires GNOME Keyring or KWallet in your user session.`;

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
  });

  test("renders the exact approved compact plain help", () => {
    const linuxHelp = renderHelpText(
      pc.createColors(false),
      BYOK_API_KEY_ENV_VARS,
      "linux",
    );
    expect(linuxHelp).toBe(APPROVED_HELP_TEXT);
    expect(HELP_TEXT).toBe(
      renderHelpText(pc.createColors(false), BYOK_API_KEY_ENV_VARS, process.platform),
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

  test("describes the native secure credential store for the running platform", () => {
    const colors = pc.createColors(false);
    const macHelp = renderHelpText(colors, BYOK_API_KEY_ENV_VARS, "darwin");
    const linuxHelp = renderHelpText(colors, BYOK_API_KEY_ENV_VARS, "linux");

    expect(macHelp).toContain("llm-now can save provider API keys securely for reuse.");
    expect(macHelp).toContain("macOS Keychain");
    expect(macHelp).not.toContain("GNOME Keyring");
    expect(linuxHelp).toContain("GNOME Keyring or KWallet");
    expect(linuxHelp).not.toContain("macOS Keychain");
  });

  test("copies and ASCII-sorts credential names without mutating the input", () => {
    const credentialNames = Object.freeze([
      "ZETA_API_KEY",
      "ALPHA_API_KEY",
      "MIDDLE_TOKEN",
    ]);
    const originalOrder = [...credentialNames];
    const rendered = renderHelpText(pc.createColors(false), credentialNames, "linux");

    expect(credentialNames).toEqual(originalOrder);
    expect(rendered).toContain(
      `API key environment variables:\n  ALPHA_API_KEY\n  MIDDLE_TOKEN\n  ZETA_API_KEY`,
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
    const rendered = renderHelpText(colors, BYOK_API_KEY_ENV_VARS, "linux");

    expect(rendered).toContain(colors.bold(colors.greenBright("Usage:")));
    expect(rendered).toContain(colors.bold(colors.cyanBright("llm-now")));
    expect(rendered).toContain(colors.bold(colors.cyanBright("--input")));
    expect(rendered).toContain(colors.cyan("<text>"));
    expect(rendered).toContain(colors.cyan("ANTHROPIC_API_KEY"));
    expect(rendered).toContain(
      colors.bold(colors.greenBright("Secure API-key storage:")),
    );
    expect(rendered).toContain("Prompt text");
    expect(stripTerminalSequences(rendered)).toBe(APPROVED_HELP_TEXT);
  });

  test("rejects test-only runtime smoke arguments", () => {
    expect(() => parseArguments(["--runtime-smoke", "/tmp/program"])).toThrow(UsageError);
  });
});

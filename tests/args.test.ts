import { describe, expect, test } from "bun:test";
import { BYOK_API_KEY_ENV_VARS } from "@swartzrock/byok-runtime";
import {
  HELP_TEXT,
  UsageError,
  parseArguments,
  requireDeterministicSelection,
} from "../src/args.ts";
import { isInteractive, resolvePrompt } from "../src/io.ts";

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

  test("help and version are stable standalone modes", () => {
    expect(parseArguments(["--help"])).toEqual({ kind: "help" });
    expect(parseArguments(["--version"])).toEqual({ kind: "version" });
    expect(HELP_TEXT).toContain("--alias");
    expect(HELP_TEXT).toContain("--provider");
    expect(HELP_TEXT).toContain("stdin");
    expect(HELP_TEXT).toContain("offer saved aliases first");
    expect(HELP_TEXT).toContain("filter its sorted choices");
    expect(HELP_TEXT).toContain("press Enter to exit");
    expect(HELP_TEXT).toContain("alias/provider/model selection cancelled");
    expect(HELP_TEXT).toContain("XDG_CONFIG_HOME");
    expect(HELP_TEXT).toContain("Exit codes:");
    expect(() => parseArguments(["--help", "--alias", "daily"])).toThrow(UsageError);
    expect(() => parseArguments(["--help", "daily"])).toThrow(UsageError);
    expect(() => parseArguments(["daily", "--help"])).toThrow(UsageError);
    expect(() => parseArguments(["--version", "daily"])).toThrow(UsageError);
    expect(() => parseArguments(["daily", "--version"])).toThrow(UsageError);
    expect(HELP_TEXT).toContain("llm-now <alias> --input <text>");
    expect(HELP_TEXT).toContain("printf <text> | llm-now <alias>");
  });

  test("lists the runtime-supported API key environment variables in help", () => {
    const rows = BYOK_API_KEY_ENV_VARS.map((name) => `  ${name}`).join("\n");

    expect(HELP_TEXT).toContain(
      `Supported API keys:\n  Environment variable\n  --------------------\n${rows}\n\nOptions:`,
    );
  });

  test("rejects test-only runtime smoke arguments", () => {
    expect(() => parseArguments(["--runtime-smoke", "/tmp/program"])).toThrow(UsageError);
  });
});

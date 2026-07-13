import { describe, expect, test } from "bun:test";
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
      "non-interactive calls require --alias or --provider and --model",
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
    expect(HELP_TEXT).toContain("XDG_CONFIG_HOME");
    expect(HELP_TEXT).toContain("Exit codes:");
    expect(() => parseArguments(["--help", "--alias", "daily"])).toThrow(UsageError);
  });
});

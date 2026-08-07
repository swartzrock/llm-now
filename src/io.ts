import { UsageError } from "./args.ts";

export interface TtyState {
  isTTY?: boolean;
}

export interface PromptInput extends TtyState, AsyncIterable<string | Uint8Array> {}

export interface TextOutput extends TtyState {
  write(text: string, callback?: (error?: Error | null) => void): unknown;
}

export class InvalidUtf8Error extends Error {
  constructor() {
    super("stdin must contain valid UTF-8 text.");
    this.name = "InvalidUtf8Error";
  }
}

export function isInteractive(stdin: TtyState, stderr: TtyState): boolean {
  return stdin.isTTY === true && stderr.isTTY === true;
}

export async function readUtf8(input: PromptInput): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  for await (const chunk of input) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    try {
      text += decoder.decode(bytes, { stream: true });
    } catch {
      throw new InvalidUtf8Error();
    }
  }
  try {
    return text + decoder.decode();
  } catch {
    throw new InvalidUtf8Error();
  }
}

export async function resolveInputSource(
  inputFlag: string | undefined,
  stdin: PromptInput,
): Promise<string> {
  if (stdin.isTTY === true) {
    if (inputFlag !== undefined) return inputFlag;
    throw new UsageError("provide --input or pipe prompt text on stdin.");
  }

  const stdinText = await readUtf8(stdin);
  if (inputFlag !== undefined && stdinText.length > 0) {
    throw new UsageError("provide exactly one input source: --input or stdin.");
  }
  return inputFlag ?? stdinText;
}

export function promptValidationMessage(
  prompt: string | undefined,
): string | undefined {
  return prompt === undefined || prompt.trim().length === 0
    ? "prompt must not be blank."
    : undefined;
}

function validatePrompt(prompt: string): string {
  const validationMessage = promptValidationMessage(prompt);
  if (validationMessage !== undefined) throw new UsageError(validationMessage);
  return prompt;
}

export async function resolvePrompt(
  inputFlag: string | undefined,
  stdin: PromptInput,
): Promise<string> {
  try {
    return validatePrompt(await resolveInputSource(inputFlag, stdin));
  } catch (error) {
    if (error instanceof InvalidUtf8Error) throw new UsageError(error.message);
    throw error;
  }
}

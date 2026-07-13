import { UsageError } from "./args.ts";

export interface TtyState {
  isTTY?: boolean;
}

export interface PromptInput extends TtyState, AsyncIterable<string | Uint8Array> {}

export interface TextOutput extends TtyState {
  write(text: string): unknown;
}

export function isInteractive(stdin: TtyState, stderr: TtyState): boolean {
  return stdin.isTTY === true && stderr.isTTY === true;
}

async function readUtf8(input: PromptInput): Promise<string> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of input) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    chunks.push(bytes);
    length += bytes.byteLength;
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new UsageError("stdin must contain valid UTF-8 text.");
  }
}

function validatePrompt(prompt: string): string {
  if (prompt.trim().length === 0) throw new UsageError("prompt must not be blank.");
  return prompt;
}

export async function resolvePrompt(
  inputFlag: string | undefined,
  stdin: PromptInput,
): Promise<string> {
  if (stdin.isTTY === true) {
    if (inputFlag !== undefined) return validatePrompt(inputFlag);
    throw new UsageError("provide --input or pipe prompt text on stdin.");
  }

  const stdinText = await readUtf8(stdin);
  if (inputFlag !== undefined && stdinText.length > 0) {
    throw new UsageError("provide exactly one input source: --input or stdin.");
  }
  return validatePrompt(inputFlag ?? stdinText);
}

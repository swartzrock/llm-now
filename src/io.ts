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

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

export async function readUtf8(
  input: PromptInput,
  signal?: AbortSignal,
): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const iterator = input[Symbol.asyncIterator]();
  let text = "";
  let iteratorClosed = false;
  const closeIterator = () => {
    if (iteratorClosed) return;
    iteratorClosed = true;
    try {
      const closing = iterator.return?.();
      if (closing !== undefined) void closing.catch(() => undefined);
    } catch {
      // Cancellation still wins when an input adapter rejects cleanup.
    }
  };
  const next = async (): Promise<IteratorResult<string | Uint8Array>> => {
    if (signal === undefined) return await iterator.next();
    if (signal.aborted) {
      closeIterator();
      throw abortReason(signal);
    }

    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => finish(() => {
        closeIterator();
        reject(abortReason(signal));
      });
      signal.addEventListener("abort", onAbort, { once: true });
      let pending: Promise<IteratorResult<string | Uint8Array>>;
      try {
        pending = iterator.next();
      } catch (error) {
        finish(() => reject(error));
        return;
      }
      pending.then(
        (result) => finish(() => resolve(result)),
        (error) => finish(() => reject(error)),
      );
      if (signal.aborted) onAbort();
    });
  };

  while (true) {
    let result: IteratorResult<string | Uint8Array>;
    try {
      result = await next();
    } catch (error) {
      closeIterator();
      throw error;
    }
    if (result.done) {
      iteratorClosed = true;
      break;
    }
    const bytes = typeof result.value === "string"
      ? new TextEncoder().encode(result.value)
      : result.value;
    try {
      text += decoder.decode(bytes, { stream: true });
    } catch {
      closeIterator();
      throw new InvalidUtf8Error();
    }
  }
  try {
    return text + decoder.decode();
  } catch {
    closeIterator();
    throw new InvalidUtf8Error();
  }
}

export async function resolveInputSource(
  inputFlag: string | undefined,
  stdin: PromptInput,
  signal?: AbortSignal,
): Promise<string> {
  if (stdin.isTTY === true) {
    if (inputFlag !== undefined) return inputFlag;
    throw new UsageError("provide --input or pipe prompt text on stdin.");
  }

  const stdinText = await readUtf8(stdin, signal);
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

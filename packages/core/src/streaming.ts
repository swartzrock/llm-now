import { LlmNowError } from "./errors.ts";
import type { ProviderId } from "./types.ts";

const DEFAULT_SETTLEMENT_TIMEOUT_MS = 500;

export interface LinkedAbortController {
  readonly controller: AbortController;
  dispose(): void;
}

export function createLinkedAbortController(parent?: AbortSignal): LinkedAbortController {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent?.aborted) abort();
  else if (parent !== undefined) {
    parent.addEventListener("abort", abort, { once: true });
    if (parent.aborted) abort();
  }
  return {
    controller,
    dispose() {
      try {
        parent?.removeEventListener("abort", abort);
      } catch {
        // Cleanup cannot replace the operation's primary outcome.
      }
    },
  };
}

export function raceWithCancellation<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  const settled = Promise.resolve(operation);
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const cleanup = () => {
      try {
        signal.removeEventListener("abort", abort);
      } catch {
        // Cleanup cannot replace the operation's primary outcome.
      }
    };
    const finish = (callback: () => void) => {
      if (finished) return;
      finished = true;
      cleanup();
      callback();
    };
    const abort = () => finish(() => reject(new DOMException("Aborted", "AbortError")));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    settled.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export async function awaitDeltaHandler(
  handler: (delta: string) => void | Promise<void>,
  delta: string,
  signal: AbortSignal,
  provider?: ProviderId,
): Promise<void> {
  const handling = Promise.resolve().then(() => handler(delta));
  const handlerOutcome = handling.then(
    () => ({ kind: "handled" as const }),
    () => ({ kind: "handler-failed" as const }),
  );
  if (signal.aborted) {
    void handlerOutcome.then(() => undefined);
    throw new LlmNowError("ABORTED", "streaming", provider);
  }
  let removeAbortListener: () => void = () => undefined;
  const cancelled = new Promise<{ kind: "aborted" }>((resolve) => {
    const abort = () => resolve({ kind: "aborted" });
    removeAbortListener = () => {
      try {
        signal.removeEventListener("abort", abort);
      } catch {
        // Cleanup cannot replace the operation's primary outcome.
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  const outcome = await Promise.race([handlerOutcome, cancelled]);
  removeAbortListener();
  if (outcome.kind === "handled") return;
  if (outcome.kind === "handler-failed") {
    throw new LlmNowError("DELTA_HANDLER_FAILED", "streaming", provider);
  }
  void handlerOutcome.then(() => undefined);
  throw new LlmNowError("ABORTED", "streaming", provider);
}

export async function settleOperation(
  operation: PromiseLike<unknown> | undefined,
  mode: "full" | "bounded",
  timeoutMs = DEFAULT_SETTLEMENT_TIMEOUT_MS,
): Promise<void> {
  if (operation === undefined) return;
  const drained = Promise.resolve(operation).then(() => undefined, () => undefined);
  if (mode === "full") {
    await drained;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      drained,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function finalizeIterator(
  iterator: AsyncIterator<unknown> | undefined,
): PromiseLike<unknown> | undefined {
  if (iterator === undefined) return undefined;
  try {
    const finalize = iterator.return;
    return typeof finalize === "function"
      ? Promise.resolve().then(() => finalize.call(iterator))
      : undefined;
  } catch (error) {
    return Promise.reject(error);
  }
}

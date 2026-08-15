const REDACTED = "[REDACTED]";

export type BufferedResponseCheck =
  | Readonly<{ safe: true; text: string }>
  | Readonly<{ safe: false }>;

export type StreamingDeltaCheck =
  | Readonly<{ safe: true; delta: string }>
  | Readonly<{ safe: false }>;

export interface RequestSafety {
  registerResponseSensitive(value: string): void;
  registerDiagnosticSensitive(value: string): void;
  checkBufferedResponse(value: string): BufferedResponseCheck;
  checkStreamingDelta(value: string): StreamingDeltaCheck;
  redactDiagnostic(value: string): string;
  clear(): void;
}

export interface RequestSafetyInput {
  readonly responseSensitiveValues?: readonly string[];
  readonly diagnosticSensitiveValues?: readonly string[];
}

export function sanitizeModelText(value: string): string {
  return value
    .replace(/\r\n?|\u2028|\u2029/g, "\n")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

function diagnosticVariants(value: string): readonly string[] {
  if (value.length === 0) return [];
  const serialized = JSON.stringify(value);
  const escaped = serialized.slice(1, -1);
  const transportEscaped = JSON.stringify(escaped).slice(1, -1);
  return [value, serialized, escaped, transportEscaped];
}

function sorted(values: ReadonlySet<string>): readonly string[] {
  return [...values].sort((left, right) => right.length - left.length);
}

class RequestSafetyOverlay implements RequestSafety {
  readonly #responseValues = new Set<string>();
  readonly #diagnosticValues = new Set<string>();
  #cumulativeResponse = "";
  #unsafe = false;

  constructor(input: RequestSafetyInput) {
    for (const value of input.responseSensitiveValues ?? []) {
      this.registerResponseSensitive(value);
    }
    for (const value of input.diagnosticSensitiveValues ?? []) {
      this.registerDiagnosticSensitive(value);
    }
  }

  registerResponseSensitive(value: string): void {
    if (value.length === 0) return;
    this.#responseValues.add(value);
    this.registerDiagnosticSensitive(value);
  }

  registerDiagnosticSensitive(value: string): void {
    for (const variant of diagnosticVariants(value)) {
      if (variant.length > 0) this.#diagnosticValues.add(variant);
    }
  }

  checkBufferedResponse(value: string): BufferedResponseCheck {
    const text = sanitizeModelText(value);
    return this.#containsResponseValue(text)
      ? Object.freeze({ safe: false })
      : Object.freeze({ safe: true, text });
  }

  checkStreamingDelta(value: string): StreamingDeltaCheck {
    if (this.#unsafe) return Object.freeze({ safe: false });
    const delta = sanitizeModelText(value);
    const next = this.#cumulativeResponse + value;
    if (this.#containsResponseValue(sanitizeModelText(next))) {
      this.#unsafe = true;
      return Object.freeze({ safe: false });
    }
    this.#cumulativeResponse = next;
    return Object.freeze({ safe: true, delta });
  }

  redactDiagnostic(value: string): string {
    let result = value;
    for (const sensitive of sorted(this.#diagnosticValues)) {
      result = result.replaceAll(sensitive, REDACTED);
    }
    return result;
  }

  clear(): void {
    this.#responseValues.clear();
    this.#diagnosticValues.clear();
    this.#cumulativeResponse = "";
    this.#unsafe = false;
  }

  #containsResponseValue(value: string): boolean {
    for (const sensitive of this.#responseValues) {
      if (value.includes(sensitive)) return true;
    }
    return false;
  }
}

export function createRequestSafety(input: RequestSafetyInput = {}): RequestSafety {
  return new RequestSafetyOverlay(input);
}

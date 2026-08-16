const REDACTED = "[REDACTED]";

export type BufferedResponseCheck =
  | Readonly<{ safe: true; text: string }>
  | Readonly<{ safe: false }>;

export type StreamingDeltaCheck =
  | Readonly<{ safe: true; delta: string }>
  | Readonly<{ safe: false }>;

export type StreamingResponseCheck =
  | Readonly<{ safe: true; delta: string; text: string }>
  | Readonly<{ safe: false }>;

export interface RequestSafety {
  registerResponseSensitive(value: string): void;
  registerDiagnosticSensitive(value: string): void;
  checkBufferedResponse(value: string): BufferedResponseCheck;
  checkStreamingDelta(value: string): StreamingDeltaCheck;
  checkStreamingResponse(): StreamingResponseCheck;
  redactDiagnostic(value: string): string;
  clear(): void;
}

export interface RequestSafetyInput {
  readonly responseSensitiveValues?: readonly string[];
  readonly diagnosticSensitiveValues?: readonly string[];
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

type TerminalSanitizerMode =
  | "text"
  | "escape"
  | "csi-parameters"
  | "csi-intermediates";

type OscSanitizerMode = "text" | "escape" | "osc" | "osc-escape";

function isSingleEscapeFinal(value: string): boolean {
  return /[@-Z\\-_]/u.test(value);
}

function isCsiParameter(value: string): boolean {
  const code = value.charCodeAt(0);
  return code >= 0x30 && code <= 0x3f;
}

function isCsiIntermediate(value: string): boolean {
  const code = value.charCodeAt(0);
  return code >= 0x20 && code <= 0x2f;
}

function isCsiFinal(value: string): boolean {
  const code = value.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

function isUnsafeControl(value: string): boolean {
  const code = value.charCodeAt(0);
  return code <= 0x08
    || code === 0x0b
    || code === 0x0c
    || (code >= 0x0e && code <= 0x1f)
    || (code >= 0x7f && code <= 0x9f);
}

class TerminalTextSanitizer {
  #mode: TerminalSanitizerMode = "text";
  readonly #sequence: string[] = [];

  write(value: string): string {
    const output: string[] = [];
    for (const character of value) this.#consume(character, output);
    return output.join("");
  }

  finish(): string {
    let output = "";
    if (this.#mode === "csi-parameters" || this.#mode === "csi-intermediates") {
      output = `[${this.#sequence.join("")}`;
    }
    this.#reset();
    return output;
  }

  clear(): void {
    this.#reset();
  }

  #consume(character: string, output: string[]): void {
    if (this.#mode === "escape") {
      if (character === "[") {
        this.#mode = "csi-parameters";
        return;
      }
      this.#mode = "text";
      if (!isSingleEscapeFinal(character)) this.#consume(character, output);
      return;
    }

    if (this.#mode === "csi-parameters") {
      if (isCsiParameter(character)) {
        this.#sequence.push(character);
        return;
      }
      if (isCsiIntermediate(character)) {
        this.#sequence.push(character);
        this.#mode = "csi-intermediates";
        return;
      }
      if (isCsiFinal(character)) {
        this.#reset();
        return;
      }
      output.push("[", this.#sequence.join(""));
      this.#reset();
      this.#consume(character, output);
      return;
    }

    if (this.#mode === "csi-intermediates") {
      if (isCsiIntermediate(character)) {
        this.#sequence.push(character);
        return;
      }
      if (isCsiFinal(character)) {
        this.#reset();
        return;
      }
      output.push("[", this.#sequence.join(""));
      this.#reset();
      this.#consume(character, output);
      return;
    }

    if (character === "\u001b") {
      this.#mode = "escape";
    } else if (!isUnsafeControl(character)) {
      output.push(character);
    }
  }

  #reset(): void {
    this.#mode = "text";
    this.#sequence.length = 0;
  }
}

class StreamingModelTextSanitizer {
  #mode: OscSanitizerMode = "text";
  readonly #sequence: string[] = [];
  readonly #terminal = new TerminalTextSanitizer();
  #carriageReturn = false;

  write(value: string): string {
    const output: string[] = [];
    for (const character of value) this.#normalize(character, output);
    return this.#terminal.write(output.join(""));
  }

  finish(): string {
    const output: string[] = [];
    if (this.#carriageReturn) this.#consume("\n", output);
    this.#carriageReturn = false;
    let pending = "";
    if (this.#mode === "escape") pending = "\u001b";
    else if (this.#mode === "osc" || this.#mode === "osc-escape") {
      pending = `\u001b]${this.#sequence.join("")}`;
    }
    this.#reset();
    return this.#terminal.write(output.join("") + pending) + this.#terminal.finish();
  }

  clear(): void {
    this.#carriageReturn = false;
    this.#reset();
    this.#terminal.clear();
  }

  #normalize(character: string, output: string[]): void {
    if (this.#carriageReturn) {
      this.#consume("\n", output);
      this.#carriageReturn = false;
      if (character === "\n") return;
    }
    if (character === "\r") this.#carriageReturn = true;
    else if (character === "\u2028" || character === "\u2029") this.#consume("\n", output);
    else this.#consume(character, output);
  }

  #consume(character: string, output: string[]): void {
    if (this.#mode === "escape") {
      if (character === "]") {
        this.#mode = "osc";
        return;
      }
      output.push("\u001b");
      this.#mode = "text";
      this.#consume(character, output);
      return;
    }

    if (this.#mode === "osc") {
      if (character === "\u0007") {
        this.#reset();
        return;
      }
      this.#sequence.push(character);
      if (character === "\u001b") this.#mode = "osc-escape";
      return;
    }

    if (this.#mode === "osc-escape") {
      if (character === "\\" || character === "\u0007") {
        this.#reset();
        return;
      }
      this.#sequence.push(character);
      this.#mode = character === "\u001b" ? "osc-escape" : "osc";
      return;
    }

    if (character === "\u001b") this.#mode = "escape";
    else output.push(character);
  }

  #reset(): void {
    this.#mode = "text";
    this.#sequence.length = 0;
  }
}

export function sanitizeModelText(value: string): string {
  const sanitizer = new StreamingModelTextSanitizer();
  return sanitizer.write(value) + sanitizer.finish();
}

class RequestSafetyOverlay implements RequestSafety {
  readonly #responseValues = new Set<string>();
  readonly #diagnosticValues = new Set<string>();
  readonly #responseChunks: string[] = [];
  readonly #streamingSanitizer = new StreamingModelTextSanitizer();
  #responseSuffix = "";
  #maximumResponseValueLength = 0;
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
    if (value.length > this.#maximumResponseValueLength) {
      this.#maximumResponseValueLength = value.length;
      this.#responseSuffix = this.#responseTail(value.length - 1);
    }
    this.registerDiagnosticSensitive(value);
  }

  registerDiagnosticSensitive(value: string): void {
    if (value.length > 0) this.#diagnosticValues.add(value);
  }

  checkBufferedResponse(value: string): BufferedResponseCheck {
    const text = sanitizeModelText(value);
    return this.#containsResponseValue(text)
      ? Object.freeze({ safe: false })
      : Object.freeze({ safe: true, text });
  }

  checkStreamingDelta(value: string): StreamingDeltaCheck {
    if (this.#unsafe) return Object.freeze({ safe: false });
    const delta = this.#streamingSanitizer.write(value);
    if (!this.#appendStreamingDelta(delta)) {
      this.#unsafe = true;
      return Object.freeze({ safe: false });
    }
    return Object.freeze({ safe: true, delta });
  }

  checkStreamingResponse(): StreamingResponseCheck {
    if (this.#unsafe) return Object.freeze({ safe: false });
    const delta = this.#streamingSanitizer.finish();
    if (!this.#appendStreamingDelta(delta)) {
      this.#unsafe = true;
      return Object.freeze({ safe: false });
    }
    return Object.freeze({ safe: true, delta, text: this.#responseChunks.join("") });
  }

  redactDiagnostic(value: string): string {
    let result = value;
    const variants = new Set([...this.#diagnosticValues].flatMap(diagnosticVariants));
    for (const sensitive of sorted(variants)) {
      result = result.replaceAll(sensitive, REDACTED);
    }
    return result;
  }

  clear(): void {
    this.#responseValues.clear();
    this.#diagnosticValues.clear();
    this.#responseChunks.length = 0;
    this.#streamingSanitizer.clear();
    this.#responseSuffix = "";
    this.#maximumResponseValueLength = 0;
    this.#unsafe = false;
  }

  #appendStreamingDelta(delta: string): boolean {
    if (this.#responseValues.size > 0) {
      const boundary = this.#responseSuffix + delta;
      if (this.#containsResponseValue(boundary)) return false;
      this.#responseSuffix = this.#boundedSuffix(boundary);
    }
    if (delta.length > 0) this.#responseChunks.push(delta);
    return true;
  }

  #boundedSuffix(value: string): string {
    const length = this.#maximumResponseValueLength - 1;
    return length <= 0 ? "" : value.slice(-length);
  }

  #responseTail(length: number): string {
    if (length <= 0) return "";
    let result = "";
    for (let index = this.#responseChunks.length - 1; index >= 0 && result.length < length; index -= 1) {
      result = this.#responseChunks[index] + result;
    }
    return result.slice(-length);
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

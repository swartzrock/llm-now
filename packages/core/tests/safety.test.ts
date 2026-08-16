import { describe, expect, test } from "bun:test";
import { createRequestSafety, sanitizeModelText } from "../src/safety.ts";

describe("request-local response and diagnostic safety", () => {
  function sanitizeStreaming(chunks: readonly string[]): { deltas: string[]; text: string } {
    const safety = createRequestSafety();
    const deltas: string[] = [];
    for (const chunk of chunks) {
      const checked = safety.checkStreamingDelta(chunk);
      if (!checked.safe) throw new Error("unexpected unsafe response");
      deltas.push(checked.delta);
    }
    const final = safety.checkStreamingResponse();
    if (!final.safe) throw new Error("unexpected unsafe response");
    deltas.push(final.delta);
    return { deltas, text: final.text };
  }

  test("keeps response and diagnostic scopes distinct", () => {
    const safety = createRequestSafety({
      responseSensitiveValues: ["response-secret"],
      diagnosticSensitiveValues: ["diagnostic-only"],
    });

    expect(safety.checkBufferedResponse("diagnostic-only is allowed")).toEqual({
      safe: true,
      text: "diagnostic-only is allowed",
    });
    expect(safety.checkBufferedResponse("response-secret")).toEqual({ safe: false });
    expect(safety.redactDiagnostic("response-secret diagnostic-only"))
      .toBe("[REDACTED] [REDACTED]");
  });

  test("sanitizes terminal control sequences before cumulative response checks", () => {
    const safety = createRequestSafety({ responseSensitiveValues: ["secret"] });
    expect(safety.checkStreamingDelta("se\u001b[31m")).toEqual({ safe: true, delta: "se" });
    expect(safety.checkStreamingDelta("cret\u001b[0m")).toEqual({ safe: false });
    expect(safety.checkStreamingDelta("later")).toEqual({ safe: false });

    const splitControl = createRequestSafety({ responseSensitiveValues: ["secret"] });
    expect(splitControl.checkStreamingDelta("se\u001b[")).toMatchObject({ safe: true });
    expect(splitControl.checkStreamingDelta("31mcret")).toEqual({ safe: false });
  });

  test("withholds the completing delta but preserves earlier safe prefixes", () => {
    for (let split = 1; split < "credential".length; split += 1) {
      const safety = createRequestSafety({ responseSensitiveValues: ["credential"] });
      const first = safety.checkStreamingDelta("credential".slice(0, split));
      const second = safety.checkStreamingDelta("credential".slice(split));
      expect(first).toEqual({ safe: true, delta: "credential".slice(0, split) });
      expect(second).toEqual({ safe: false });
    }
  });

  test("redacts raw, JSON, and transport-escaped diagnostic variants", () => {
    const value = 'line one\n"line two"';
    const serialized = JSON.stringify(value);
    const escaped = serialized.slice(1, -1);
    const transportEscaped = JSON.stringify(escaped).slice(1, -1);
    const safety = createRequestSafety({ diagnosticSensitiveValues: [value] });

    for (const variant of [value, serialized, escaped, transportEscaped]) {
      expect(safety.redactDiagnostic(`before ${variant} after`)).toBe("before [REDACTED] after");
    }
  });

  test("does not share values between request overlays", () => {
    const first = createRequestSafety({ responseSensitiveValues: ["first"] });
    const second = createRequestSafety({ responseSensitiveValues: ["second"] });
    expect(first.checkBufferedResponse("second")).toEqual({ safe: true, text: "second" });
    expect(second.checkBufferedResponse("first")).toEqual({ safe: true, text: "first" });
  });

  test("normalizes newlines and strips OSC, CSI, and unsafe controls", () => {
    expect(sanitizeModelText("one\r\ntwo\u001b]0;title\u0007\u001b[31mthree\u001b[0m\u0000"))
      .toBe("one\ntwothree");
  });

  test("preserves whole-response sanitization across split control sequences", () => {
    const values = [
      "one\r\ntwo",
      "one\u001b[31mtwo\u001b[0mthree",
      "one\u001b]0;title\u0007two",
      "one\u001b]0;title\u001b\\two",
      "one\u001b]first\u001b\\second\u001b\\three",
      "one\u001b]first\u001b\\second\u0007three",
      "one\u001b[31",
      "one\u001b]unfinished",
    ] as const;

    for (const value of values) {
      for (let split = 1; split < value.length; split += 1) {
        const streamed = sanitizeStreaming([value.slice(0, split), value.slice(split)]);
        expect(streamed.deltas.join("")).toBe(streamed.text);
        expect(streamed.text).toBe(sanitizeModelText(value));
      }
    }
  });

  test("uses one sanitizer authority for interacting incomplete control sequences", () => {
    const value = "pre\u001b[ \u001b]x\u0007Asecret";
    const buffered = createRequestSafety({ responseSensitiveValues: ["presecret"] });
    const streaming = createRequestSafety({ responseSensitiveValues: ["presecret"] });

    expect(buffered.checkBufferedResponse(value)).toEqual({ safe: false });
    expect(streaming.checkStreamingDelta(value)).toEqual({ safe: false });
  });

  test("resumes early delivery after an OSC string terminates", () => {
    const safety = createRequestSafety();
    expect(safety.checkStreamingDelta("\u001b]title\u001b\\first"))
      .toEqual({ safe: true, delta: "first" });
    expect(safety.checkStreamingDelta(" second"))
      .toEqual({ safe: true, delta: " second" });
    expect(safety.checkStreamingResponse()).toEqual({
      safe: true,
      delta: "",
      text: "first second",
    });
  });

  test("normalizes line breaks before removing intervening OSC strings", () => {
    const value = "a\r\u001b]x\u0007\nb";
    expect(sanitizeModelText(value)).toBe("a\n\nb");
    expect(sanitizeStreaming(["a\r\u001b]x", "\u0007\nb"]).text).toBe("a\n\nb");
  });

  test("handles many small deltas without changing final text", () => {
    const chunks = Array.from({ length: 20_000 }, (_, index) => `${index % 10}`);
    const streamed = sanitizeStreaming(chunks);
    expect(streamed.deltas.join("")).toBe(chunks.join(""));
    expect(streamed.text).toBe(chunks.join(""));
  });

  test("handles a long invalid CSI sequence without spreading buffered characters", () => {
    const parameters = "1".repeat(1_000_000);
    expect(sanitizeModelText(`\u001b[${parameters}\u001b`)).toBe(`[${parameters}`);
  });
});

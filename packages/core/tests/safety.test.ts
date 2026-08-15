import { describe, expect, test } from "bun:test";
import { createRequestSafety, sanitizeModelText } from "../src/safety.ts";

describe("request-local response and diagnostic safety", () => {
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
});

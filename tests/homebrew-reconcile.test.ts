import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  HOMEBREW_TAP,
  MAX_FORMULA_BYTES,
  classifyHomebrewFormula,
  parseManagedHomebrewFormula,
  reconcileHomebrewFormula,
  type ReconciliationReceipt,
} from "../scripts/homebrew-reconcile.ts";

const template = await Bun.file(
  new URL("../packaging/homebrew/llm-now.rb", import.meta.url),
).text();
const releaseSha = "a".repeat(40);
const token = "github_pat_safe-test-token";

function formula(version: string, checksumCharacter = "1"): string {
  const replacements = new Map([
    ["__PACKAGE_VERSION__", version],
    ["__MACOS_ARM64_URL__", `https://github.com/swartzrock/llm-now/releases/download/v${version}/llm-now-v${version}-macos-arm64.zip`],
    ["__MACOS_ARM64_SHA256__", checksumCharacter.repeat(64)],
    ["__MACOS_X64_URL__", `https://github.com/swartzrock/llm-now/releases/download/v${version}/llm-now-v${version}-macos-x64.zip`],
    ["__MACOS_X64_SHA256__", checksumCharacter.repeat(64)],
    ["__LINUX_ARM64_URL__", `https://github.com/swartzrock/llm-now/releases/download/v${version}/llm-now-v${version}-linux-arm64.zip`],
    ["__LINUX_ARM64_SHA256__", checksumCharacter.repeat(64)],
    ["__LINUX_X64_URL__", `https://github.com/swartzrock/llm-now/releases/download/v${version}/llm-now-v${version}-linux-x64.zip`],
    ["__LINUX_X64_SHA256__", checksumCharacter.repeat(64)],
  ]);
  let rendered = template;
  for (const [placeholder, value] of replacements) rendered = rendered.replaceAll(placeholder, value);
  return rendered;
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  signal: AbortSignal;
}

type FetchStep = Response | Error | ((request: CapturedRequest) => Response | Promise<Response>);

function fakeFetch(...steps: FetchStep[]): {
  fetch: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request
      ? new Request(input, init)
      : new Request(input.toString(), init);
    const captured = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: await request.text(),
      signal: request.signal,
    };
    requests.push(captured);
    const step = steps.shift();
    if (step === undefined) throw new Error("unexpected fetch");
    if (step instanceof Error) throw step;
    return typeof step === "function" ? await step(captured) : step;
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

function contentBody(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "file",
    path: HOMEBREW_TAP.path,
    encoding: "base64",
    sha: "b".repeat(40),
    content: Buffer.from(text).toString("base64"),
    ...overrides,
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  requestId = `request-${status}`,
): Response {
  return Response.json(body, {
    status,
    headers: { "x-github-request-id": requestId },
  });
}

function contentResponse(
  text: string,
  overrides: Record<string, unknown> = {},
  requestId = "read-request",
): Response {
  return jsonResponse(contentBody(text, overrides), 200, requestId);
}

function options(
  fetchImpl: typeof fetch,
  overrides: Partial<Parameters<typeof reconcileHomebrewFormula>[0]> = {},
): Parameters<typeof reconcileHomebrewFormula>[0] {
  return {
    desiredFormula: formula("2.3.0", "3"),
    template,
    tag: "v2.3.0",
    releaseSha,
    token,
    fetchImpl,
    apiUrl: "https://api.github.test",
    ...overrides,
  };
}

function safeReceipt(receipt: ReconciliationReceipt): string {
  return JSON.stringify(receipt);
}

describe("managed Homebrew formula parsing", () => {
  test("classifies exact, older, divergent, newer, and invalid whole files", () => {
    const desired = formula("2.3.0", "3");
    expect(parseManagedHomebrewFormula(desired, template)).toEqual({ version: "2.3.0" });
    expect(classifyHomebrewFormula(desired, desired, template)).toEqual({ kind: "exact", version: "2.3.0" });
    expect(classifyHomebrewFormula(desired, formula("2.2.0", "2"), template))
      .toEqual({ kind: "older-valid", version: "2.2.0" });
    expect(classifyHomebrewFormula(desired, formula("2.3.0", "4"), template))
      .toEqual({ kind: "same-version-divergent", version: "2.3.0" });
    expect(classifyHomebrewFormula(desired, formula("2.4.0", "4"), template))
      .toEqual({ kind: "newer", version: "2.4.0" });
    expect(classifyHomebrewFormula(desired, formula("2.2.0").replace("swartzrock/llm-now", "attacker/repo"), template))
      .toEqual({ kind: "invalid" });
  });

  test("rejects structure, filename, checksum, control-character, and version drift", () => {
    const valid = formula("2.2.0");
    const hostile = [
      valid.replace("class LlmNow < Formula", "class Other < Formula"),
      valid.replace("-macos-arm64.zip", "-macos-x64.zip"),
      valid.replace("1".repeat(64), "g".repeat(64)),
      valid.replace("version \"2.2.0\"", "version \"2.2.0\"\u001b]8;;https://evil.invalid\u0007"),
      valid.replace("download/v2.2.0", "download/v2.1.0"),
    ];
    for (const candidate of hostile) expect(parseManagedHomebrewFormula(candidate, template)).toBeNull();
  });
});

describe("Homebrew tap reconciliation", () => {
  test("returns already-current without a write for exact bytes", async () => {
    const desired = formula("2.3.0", "3");
    const api = fakeFetch(contentResponse(desired, {}, "exact-read"));
    const receipt = await reconcileHomebrewFormula(options(api.fetch, { desiredFormula: desired }));

    expect(receipt).toMatchObject({
      disposition: "already-current",
      phase: "read-live",
      reason: "exact",
      tag: "v2.3.0",
      releaseSha,
      tap: HOMEBREW_TAP,
      httpStatus: 200,
      requestId: "exact-read",
    });
    expect(api.requests.map((request) => request.method)).toEqual(["GET"]);
  });

  test("advances an older managed formula with one SHA-guarded PUT and exact read-back", async () => {
    const desired = formula("2.3.0", "3");
    const api = fakeFetch(
      contentResponse(formula("2.2.0", "2"), { sha: "c".repeat(40) }),
      jsonResponse({ content: { sha: "d".repeat(40) } }, 200, "write-request"),
      contentResponse(desired, { sha: "d".repeat(40) }, "read-back-request"),
    );
    const receipt = await reconcileHomebrewFormula(options(api.fetch, { desiredFormula: desired }));

    expect(receipt).toMatchObject({
      disposition: "updated",
      phase: "read-back",
      reason: "exact-after-update",
      httpStatus: 200,
      requestId: "write-request",
    });
    expect(api.requests.map((request) => request.method)).toEqual(["GET", "PUT", "GET"]);
    const update = JSON.parse(api.requests[1]!.body);
    expect(update).toEqual({
      message: "Update llm-now to 2.3.0",
      content: Buffer.from(desired).toString("base64"),
      sha: "c".repeat(40),
      branch: "main",
    });
    expect(api.requests[1]!.url).toBe(
      "https://api.github.test/repos/swartzrock/homebrew-tap/contents/Formula/llm-now.rb",
    );
    expect(api.requests[1]!.headers.get("authorization")).toBe(`Bearer ${token}`);
  });

  test("refuses divergent, newer, invalid, and missing live state before PUT", async () => {
    const desired = formula("2.3.0", "3");
    const cases = [
      { response: contentResponse(formula("2.3.0", "4")), reason: "same-version-divergent" },
      { response: contentResponse(formula("2.4.0", "4")), reason: "newer-live-formula" },
      { response: contentResponse("class LlmNow < Formula\nend\n"), reason: "invalid-live-formula" },
      { response: jsonResponse({ message: "not found" }, 404), reason: "live-formula-missing" },
    ];
    for (const testCase of cases) {
      const api = fakeFetch(testCase.response);
      const receipt = await reconcileHomebrewFormula(options(api.fetch, { desiredFormula: desired }));
      expect(receipt).toMatchObject({ disposition: "failed-before-write", reason: testCase.reason });
      expect(api.requests.map((request) => request.method)).toEqual(["GET"]);
    }
  });

  test("rejects hostile Contents response shapes without writing", async () => {
    const invalidUtf8 = Buffer.from([0xc3, 0x28]).toString("base64");
    const variants: unknown[] = [
      { ...contentBody(formula("2.2.0")), type: "dir" },
      { ...contentBody(formula("2.2.0")), path: "Formula/other.rb" },
      { ...contentBody(formula("2.2.0")), encoding: "utf-8" },
      { ...contentBody(formula("2.2.0")), sha: "not-a-sha" },
      { ...contentBody(formula("2.2.0")), content: "%%%not-base64%%%" },
      { ...contentBody(formula("2.2.0")), content: invalidUtf8 },
      contentBody(""),
      contentBody("x".repeat(MAX_FORMULA_BYTES + 1)),
      [contentBody(formula("2.2.0"))],
      null,
    ];
    for (const variant of variants) {
      const api = fakeFetch(jsonResponse(variant));
      const receipt = await reconcileHomebrewFormula(options(api.fetch));
      expect(receipt).toMatchObject({ disposition: "failed-before-write", reason: "invalid-live-response" });
      expect(api.requests.map((request) => request.method)).toEqual(["GET"]);
    }
  });

  test("rejects oversized declared and streamed Contents responses without writing", async () => {
    for (const contentLength of [String(256 * 1024 + 1), "invalid"]) {
      const declared = fakeFetch(new Response("{}", {
        status: 200,
        headers: { "content-length": contentLength },
      }));
      const declaredReceipt = await reconcileHomebrewFormula(options(declared.fetch));
      expect(declaredReceipt).toMatchObject({
        disposition: "failed-before-write",
        reason: "invalid-live-response",
      });
      expect(declared.requests.map((request) => request.method)).toEqual(["GET"]);
    }

    const streamed = fakeFetch(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(256 * 1024 + 1));
        controller.close();
      },
    }), { status: 200 }));
    const streamedReceipt = await reconcileHomebrewFormula(options(streamed.fetch));
    expect(streamedReceipt).toMatchObject({
      disposition: "failed-before-write",
      reason: "invalid-live-response",
    });
    expect(streamed.requests.map((request) => request.method)).toEqual(["GET"]);
  });

  test("accepts exact read-back after success, conflict, server ambiguity, or transport ambiguity", async () => {
    const desired = formula("2.3.0", "3");
    const writeSteps: Array<{ step: FetchStep; disposition: ReconciliationReceipt["disposition"] }> = [
      { step: jsonResponse({}, 201, "created"), disposition: "updated" },
      { step: jsonResponse({}, 409, "conflict"), disposition: "already-current" },
      { step: jsonResponse({}, 503, "server-error"), disposition: "already-current" },
      { step: new Error(`transport exposed ${token}`), disposition: "already-current" },
    ];
    for (const { step, disposition } of writeSteps) {
      const api = fakeFetch(
        contentResponse(formula("2.2.0", "2")),
        step,
        contentResponse(desired),
      );
      const receipt = await reconcileHomebrewFormula(options(api.fetch, { desiredFormula: desired }));
      expect(receipt.disposition).toBe(disposition);
      expect(api.requests.map((request) => request.method)).toEqual(["GET", "PUT", "GET"]);
      expect(safeReceipt(receipt)).not.toContain(token);
    }
  });

  test("reports unconfirmed outcome after every non-exact or unavailable read-back", async () => {
    const readBacks: FetchStep[] = [
      contentResponse(formula("2.2.0", "2")),
      contentResponse(formula("2.3.0", "4")),
      contentResponse(formula("2.4.0", "4")),
      jsonResponse({ message: "gone" }, 404),
      jsonResponse({ message: "unavailable" }, 503),
      new Error("read-back transport failed"),
    ];
    for (const readBack of readBacks) {
      const api = fakeFetch(
        contentResponse(formula("2.2.0", "2")),
        jsonResponse({}, 200, "write-id"),
        readBack,
      );
      const receipt = await reconcileHomebrewFormula(options(api.fetch));
      expect(receipt).toMatchObject({
        disposition: "write-outcome-unconfirmed",
        phase: "read-back",
        httpStatus: 200,
        requestId: "write-id",
      });
      expect(api.requests.map((request) => request.method)).toEqual(["GET", "PUT", "GET"]);
    }
  });

  test("bounds stalled reads and preserves one read-back after a stalled write", async () => {
    const stallUntilAbort = ({ signal }: CapturedRequest) => new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });

    const initialStall = fakeFetch(stallUntilAbort);
    const initialReceipt = await reconcileHomebrewFormula(options(initialStall.fetch, {
      requestTimeoutMs: 5,
    }));
    expect(initialReceipt).toMatchObject({
      disposition: "failed-before-write",
      phase: "read-live",
      reason: "live-read-transport-failed",
    });
    expect(initialStall.requests.map((request) => request.method)).toEqual(["GET"]);

    const desired = formula("2.3.0", "3");
    const writeStall = fakeFetch(
      contentResponse(formula("2.2.0", "2")),
      stallUntilAbort,
      contentResponse(desired),
    );
    const writeReceipt = await reconcileHomebrewFormula(options(writeStall.fetch, {
      desiredFormula: desired,
      requestTimeoutMs: 5,
    }));
    expect(writeReceipt).toMatchObject({
      disposition: "already-current",
      phase: "read-back",
      reason: "exact-after-ambiguous-update",
      httpStatus: null,
      requestId: null,
    });
    expect(writeStall.requests.map((request) => request.method)).toEqual(["GET", "PUT", "GET"]);

    const readBackStall = fakeFetch(
      contentResponse(formula("2.2.0", "2")),
      jsonResponse({}, 200, "write-id"),
      stallUntilAbort,
    );
    const readBackReceipt = await reconcileHomebrewFormula(options(readBackStall.fetch, {
      requestTimeoutMs: 5,
    }));
    expect(readBackReceipt).toMatchObject({
      disposition: "write-outcome-unconfirmed",
      phase: "read-back",
      reason: "read-back-unavailable",
      httpStatus: 200,
      requestId: "write-id",
    });
    expect(readBackStall.requests.map((request) => request.method)).toEqual(["GET", "PUT", "GET"]);
  });

  test("bounds stalled Contents response bodies", async () => {
    const api = fakeFetch(({ signal }) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    }), { status: 200 }));
    const receipt = await reconcileHomebrewFormula(options(api.fetch, { requestTimeoutMs: 5 }));
    expect(receipt).toMatchObject({
      disposition: "failed-before-write",
      phase: "read-live",
      reason: "invalid-live-response",
    });
    expect(api.requests.map((request) => request.method)).toEqual(["GET"]);
  });

  test("fails auth, rate-limit, validation, malformed, and transport reads before PUT", async () => {
    const failures: FetchStep[] = [
      jsonResponse({ message: "bad credentials" }, 401, "auth"),
      jsonResponse({ message: "forbidden" }, 403, "forbidden"),
      jsonResponse({ message: "rate limited" }, 429, "rate"),
      jsonResponse({ message: "validation" }, 422, "validation"),
      new Response("not json", { status: 200, headers: { "x-github-request-id": "malformed" } }),
      new Error(`transport leaked ${token}`),
    ];
    for (const failure of failures) {
      const api = fakeFetch(failure);
      const receipt = await reconcileHomebrewFormula(options(api.fetch));
      expect(receipt.disposition).toBe("failed-before-write");
      expect(api.requests.map((request) => request.method)).toEqual(["GET"]);
      expect(safeReceipt(receipt)).not.toContain(token);
      expect(safeReceipt(receipt)).not.toContain("bad credentials");
      expect(safeReceipt(receipt)).not.toContain("rate limited");
    }
  });

  test("fails missing tokens and invalid desired formulas without a request", async () => {
    const missingTokenApi = fakeFetch();
    const missingToken = await reconcileHomebrewFormula(options(missingTokenApi.fetch, { token: undefined }));
    expect(missingToken).toMatchObject({
      disposition: "failed-before-write",
      phase: "input-validation",
      reason: "missing-token",
      httpStatus: null,
      requestId: null,
    });
    expect(missingTokenApi.requests).toHaveLength(0);

    const invalidDesiredApi = fakeFetch();
    const invalidDesired = await reconcileHomebrewFormula(options(invalidDesiredApi.fetch, {
      desiredFormula: formula("2.2.0"),
    }));
    expect(invalidDesired).toMatchObject({
      disposition: "failed-before-write",
      phase: "input-validation",
      reason: "invalid-desired-formula",
    });
    expect(invalidDesiredApi.requests).toHaveLength(0);

    const invalidShaApi = fakeFetch();
    const invalidSha = await reconcileHomebrewFormula(options(invalidShaApi.fetch, {
      releaseSha: "A".repeat(40),
    }));
    expect(invalidSha).toMatchObject({
      disposition: "failed-before-write",
      phase: "input-validation",
      reason: "invalid-release-sha",
    });
    expect(invalidShaApi.requests).toHaveLength(0);

    const invalidTagApi = fakeFetch();
    const invalidTag = await reconcileHomebrewFormula(options(invalidTagApi.fetch, {
      tag: "v02.3.0",
    }));
    expect(invalidTag).toMatchObject({
      disposition: "failed-before-write",
      phase: "input-validation",
      reason: "invalid-desired-formula",
    });
    expect(invalidTagApi.requests).toHaveLength(0);
  });

  test("never places hostile external text, API bodies, or tokens in receipts", async () => {
    const hostile = "\u001b]8;;https://evil.invalid\u0007[click](javascript:alert(1))";
    const api = fakeFetch(jsonResponse({ message: `${hostile} ${token}`, documentation_url: hostile }, 500, hostile));
    const receipt = await reconcileHomebrewFormula(options(api.fetch));
    const serialized = safeReceipt(receipt);
    expect(serialized).not.toContain(hostile);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("javascript");
    expect(receipt.requestId).toBeNull();
  });
});

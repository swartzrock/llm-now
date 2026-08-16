import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import {
  LLM_NOW_ERROR_CODES,
  LLM_NOW_OPERATIONS,
  LlmNowError,
  isErrorCodeAllowedForOperation,
  safeErrorFromUnknown,
} from "../src/errors.ts";
import { validateCliExecutionDescriptor } from "../src/cli-execution.ts";

describe("public error contract", () => {
  test("keeps every code and operation closed with fixed messages", () => {
    expect(LLM_NOW_ERROR_CODES).toEqual([
      "INVALID_REQUEST", "PROVIDER_UNAVAILABLE", "CREDENTIAL_UNAVAILABLE",
      "CREDENTIAL_RESOLUTION_FAILED", "EXECUTION_UNAVAILABLE", "WORKSPACE_UNAVAILABLE",
      "DISCOVERY_FAILED", "MODEL_LIST_FAILED", "VALIDATION_FAILED", "GENERATION_FAILED",
      "ABORTED", "UNSAFE_RESPONSE", "DELTA_HANDLER_FAILED", "INTERNAL_ERROR",
    ]);
    expect(LLM_NOW_OPERATIONS).toEqual([
      "discovery", "model-list", "validation", "generation", "streaming",
    ]);

    for (const operation of LLM_NOW_OPERATIONS) {
      const error = new LlmNowError("INTERNAL_ERROR", operation, "openai");
      expect(error.message).toBe("The core operation failed safely.");
      expect(error).toMatchObject({ code: "INTERNAL_ERROR", operation, provider: "openai" });
    }
  });

  test("enforces the normative operation-to-code mapping", () => {
    const expected = {
      discovery: ["INVALID_REQUEST", "CREDENTIAL_RESOLUTION_FAILED", "DISCOVERY_FAILED", "ABORTED", "INTERNAL_ERROR"],
      "model-list": ["INVALID_REQUEST", "PROVIDER_UNAVAILABLE", "CREDENTIAL_UNAVAILABLE", "CREDENTIAL_RESOLUTION_FAILED", "EXECUTION_UNAVAILABLE", "MODEL_LIST_FAILED", "ABORTED", "INTERNAL_ERROR"],
      validation: ["INVALID_REQUEST", "PROVIDER_UNAVAILABLE", "CREDENTIAL_UNAVAILABLE", "CREDENTIAL_RESOLUTION_FAILED", "EXECUTION_UNAVAILABLE", "VALIDATION_FAILED", "ABORTED", "INTERNAL_ERROR"],
      generation: ["INVALID_REQUEST", "PROVIDER_UNAVAILABLE", "CREDENTIAL_UNAVAILABLE", "CREDENTIAL_RESOLUTION_FAILED", "EXECUTION_UNAVAILABLE", "WORKSPACE_UNAVAILABLE", "GENERATION_FAILED", "ABORTED", "UNSAFE_RESPONSE", "INTERNAL_ERROR"],
      streaming: ["INVALID_REQUEST", "PROVIDER_UNAVAILABLE", "CREDENTIAL_UNAVAILABLE", "CREDENTIAL_RESOLUTION_FAILED", "EXECUTION_UNAVAILABLE", "WORKSPACE_UNAVAILABLE", "GENERATION_FAILED", "ABORTED", "UNSAFE_RESPONSE", "DELTA_HANDLER_FAILED", "INTERNAL_ERROR"],
    } as const;

    for (const operation of LLM_NOW_OPERATIONS) {
      expect(LLM_NOW_ERROR_CODES.filter((code) => isErrorCodeAllowedForOperation(operation, code)))
        .toEqual([...expected[operation]]);
    }
  });

  test("does not expose causes or caller data through common serialization paths", () => {
    const secret = "should-never-appear";
    const hostile = new Proxy(Object.create(null), {
      get() {
        throw new Error(secret);
      },
      ownKeys() {
        throw new Error(secret);
      },
    });
    const error = safeErrorFromUnknown(
      "generation",
      "GENERATION_FAILED",
      "openai",
      hostile,
    );
    const renderings = [
      String(error),
      JSON.stringify(error),
      JSON.stringify({ ...error }),
      inspect(error),
      Bun.inspect(error),
    ];
    for (const rendering of renderings) expect(rendering).not.toContain(secret);
    expect(Object.keys(error)).toEqual(["code", "operation", "provider"]);
    expect("cause" in error).toBeFalse();
    expect(Object.getOwnPropertyNames(error).sort()).toEqual([
      "code", "message", "name", "operation", "provider",
    ]);
  });

  test("fails closed for invalid runtime code, operation, and provider values", () => {
    const error = new LlmNowError("not-a-code" as never, "not-an-operation" as never, "secret" as never);
    expect(error).toMatchObject({ code: "INTERNAL_ERROR", operation: "generation" });
    expect("provider" in error).toBeFalse();
  });
});

describe("host-approved CLI execution descriptors", () => {
  test("copies and freezes direct and Windows command-shim descriptors", () => {
    const env = { TOKEN: "caller-owned" };
    const argsPrefix = ["exec", "--json"];
    const direct = validateCliExecutionDescriptor({
      mode: "direct",
      executable: "/opt/bin/codex",
      argsPrefix,
      env,
    });
    argsPrefix.push("changed");
    env.TOKEN = "changed";
    expect(direct).toEqual({
      mode: "direct",
      executable: "/opt/bin/codex",
      argsPrefix: ["exec", "--json"],
      env: { TOKEN: "caller-owned" },
    });
    expect(Object.isFrozen(direct)).toBeTrue();
    expect(Object.isFrozen(direct?.argsPrefix)).toBeTrue();
    expect(Object.isFrozen(direct?.env)).toBeTrue();

    expect(validateCliExecutionDescriptor({
      mode: "windows-command-shim",
      commandProcessor: "C:\\Windows\\System32\\cmd.exe",
      shim: "C:\\Tools\\codex.cmd",
      argsPrefix: ["exec"],
      env: { USERPROFILE: "C:\\Users\\host" },
    })).toMatchObject({ mode: "windows-command-shim" });
  });

  test("rejects relative paths, malformed environments, and hostile inputs", () => {
    for (const value of [
      null,
      { mode: "direct", executable: "codex", argsPrefix: [], env: {} },
      { mode: "direct", executable: "/bin/codex", argsPrefix: [1], env: {} },
      { mode: "direct", executable: "/bin/codex", argsPrefix: [], env: { TOKEN: undefined } },
      { mode: "windows-command-shim", commandProcessor: "cmd.exe", shim: "codex.cmd", argsPrefix: [], env: {} },
      new Proxy({}, { get() { throw new Error("hostile"); } }),
    ]) {
      expect(validateCliExecutionDescriptor(value)).toBeNull();
    }
  });
});

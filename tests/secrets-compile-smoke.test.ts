import { describe, expect, test } from "bun:test";
import type { NativeSecretAdapter } from "../src/credentials.ts";
import { runNativeSecretLifecycle } from "./fixtures/secrets-compile-smoke.ts";

function adapter(options: { failReplace?: boolean } = {}) {
  const values = new Map<string, string>();
  const operations: string[] = [];
  const value = {
    async get(identity) {
      operations.push("get");
      return values.get(`${identity.service}/${identity.name}`) ?? null;
    },
    async set(identity, secret) {
      operations.push("set");
      if (options.failReplace && values.size > 0) throw new Error("synthetic failure");
      values.set(`${identity.service}/${identity.name}`, secret);
    },
    async delete(identity) {
      operations.push("delete");
      return values.delete(`${identity.service}/${identity.name}`);
    },
  } satisfies NativeSecretAdapter;
  return { value, values, operations };
}

describe("compiled native credential lifecycle", () => {
  test("imports the production adapter but never names a provider credential record", async () => {
    const lifecycleSource = await Bun.file(
      new URL("./fixtures/secrets-compile-smoke.ts", import.meta.url),
    ).text();
    const entrySource = await Bun.file(
      new URL("./fixtures/secrets-compile-entry.ts", import.meta.url),
    ).text();
    const compiledSources = lifecycleSource + entrySource;
    expect(entrySource).toContain("createBunNativeSecretAdapter");
    expect(entrySource).toContain("runNativeSecretLifecycle");
    expect(lifecycleSource).toContain("crypto.randomUUID()");
    expect(compiledSources).not.toContain("api-key:");
    expect(compiledSources).not.toMatch(/anthropic|openai|google|xai|openrouter|groq|mistral|deepseek|deepinfra/);
  });

  test("proves missing, set/get, replace/get, delete, missing without printing values", async () => {
    const fixture = adapter();
    const output: string[] = [];
    await runNativeSecretLifecycle(fixture.value, (stage) => output.push(stage));

    expect(output).toEqual([
      "missing",
      "set",
      "get",
      "replace",
      "get-replacement",
      "delete",
      "missing-after-delete",
      "cleanup",
    ]);
    expect(fixture.values.size).toBe(0);
    expect(output.join(" ")).not.toContain("synthetic-native-secret");
  });

  test("cleans up after an intermediate replacement failure", async () => {
    const fixture = adapter({ failReplace: true });
    await expect(runNativeSecretLifecycle(fixture.value, () => {})).rejects.toThrow(
      "native credential lifecycle failed: replace",
    );
    expect(fixture.operations.slice(-2)).toEqual(["delete", "get"]);
    expect(fixture.values.size).toBe(0);
  });
});

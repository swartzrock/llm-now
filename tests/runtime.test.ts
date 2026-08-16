import { afterEach, describe, expect, test } from "bun:test";
import type { LlmNowCoreClient } from "../packages/core/src/client.ts";
import { LlmNowError } from "../packages/core/dist/index.js";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import {
  CredentialVaultError,
  createSensitiveValueRegistry,
} from "../packages/cli/src/credentials.ts";
import {
  RuntimeStageError,
  createCliExecutionResolver,
  createCoreRuntimeGateway,
} from "../packages/cli/src/runtime.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(process.cwd(), ".tmp-runtime-workspace-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function executable(directory: string, name: string): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, "fixture");
  if (process.platform !== "win32") await chmod(path, 0o755);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("core runtime adapter", () => {
  test("routes buffered and streaming operations through core", async () => {
    const calls: string[] = [];
    const responseSecrets: string[][] = [];
    const coreClient: LlmNowCoreClient = {
      discoverProviders: async () => {
        calls.push("core-discover");
        return { degraded: false, providers: [{
          provider: "ollama",
          family: "local",
          available: true,
        }] };
      },
      listModels: async ({ provider }) => {
        calls.push(`core-list:${provider}`);
        return { provider, models: [{ id: "core-model", label: "Core model" }] };
      },
      validateConnection: async ({ provider }) => {
        calls.push(`core-validate:${provider}`);
        return { provider, models: [] };
      },
      generateText: async ({ provider, model, prompt, instructions, responseSensitiveValues }) => {
        calls.push(`core-generate:${prompt}:${instructions}`);
        responseSecrets.push([...(responseSensitiveValues ?? [])]);
        return { provider, model, text: "core-buffered" };
      },
      streamText: async ({ provider, model, prompt, responseSensitiveValues }, onTextDelta) => {
        calls.push(`core-stream:${prompt}`);
        responseSecrets.push([...(responseSensitiveValues ?? [])]);
        await onTextDelta("core-streamed");
        return { provider, model, delivery: "native", text: "core-streamed" };
      },
    };
    const gateway = createCoreRuntimeGateway({
      env: { OPENAI_API_KEY: "adapter-response-secret" },
      credentialResolver: { resolve: async () => ({ source: "missing" }) },
      sensitive: createSensitiveValueRegistry(),
      coreClient,
    });

    expect(await gateway.discover()).toEqual(["ollama"]);
    expect(await gateway.listModels("ollama")).toEqual([{ id: "core-model", label: "Core model" }]);
    await gateway.validateCredential("openai", "candidate");
    expect(await gateway.generate("ollama", "qwen", "buffered", undefined, "brief"))
      .toBe("core-buffered");
    const deltas: string[] = [];
    expect(await gateway.generate(
      "ollama",
      "qwen",
      "streamed",
      undefined,
      undefined,
      undefined,
      (delta) => { deltas.push(delta); },
    )).toBe("core-streamed");
    expect(deltas).toEqual(["core-streamed"]);
    expect(calls).toEqual([
      "core-discover",
      "core-list:ollama",
      "core-validate:openai",
      "core-generate:buffered:brief",
      "core-stream:streamed",
    ]);
    expect(responseSecrets).toEqual([
      ["adapter-response-secret"],
      ["adapter-response-secret"],
    ]);
  });

  test("preserves buffered and streaming unsafe-response diagnostics", async () => {
    const coreClient: LlmNowCoreClient = {
      discoverProviders: async () => ({ degraded: false, providers: [] }),
      listModels: async ({ provider }) => ({ provider, models: [] }),
      validateConnection: async ({ provider }) => ({ provider, models: [] }),
      generateText: async () => {
        throw new LlmNowError("UNSAFE_RESPONSE", "generation", "ollama");
      },
      streamText: async () => {
        throw new LlmNowError("UNSAFE_RESPONSE", "streaming", "ollama");
      },
    };
    const gateway = createCoreRuntimeGateway({
      env: {},
      credentialResolver: { resolve: async () => ({ source: "missing" }) },
      sensitive: createSensitiveValueRegistry(),
      coreClient,
    });

    await expect(gateway.generate("ollama", "qwen", "buffered")).rejects.toThrow(
      "generation: response withheld because it contained a registered credential.",
    );
    await expect(gateway.generate(
      "ollama",
      "qwen",
      "streamed",
      undefined,
      undefined,
      undefined,
      () => undefined,
    )).rejects.toThrow(
      "generation (ollama): response stream stopped because it contained a registered credential",
    );
  });

  test("uses a core-sanitized provider diagnostic without changing the public error", async () => {
    const coreClient: LlmNowCoreClient = {
      discoverProviders: async () => ({ degraded: false, providers: [] }),
      listModels: async ({ provider }) => ({ provider, models: [] }),
      validateConnection: async ({ provider }) => ({ provider, models: [] }),
      generateText: async ({ onDiagnostic }) => {
        onDiagnostic?.("provider detail with [REDACTED]");
        throw new LlmNowError("GENERATION_FAILED", "generation", "ollama");
      },
      streamText: async () => { throw new Error("unused"); },
    };
    const gateway = createCoreRuntimeGateway({
      env: {},
      credentialResolver: { resolve: async () => ({ source: "missing" }) },
      sensitive: createSensitiveValueRegistry(),
      coreClient,
    });

    await expect(gateway.generate("ollama", "qwen", "prompt")).rejects.toThrow(
      "generation (ollama): provider detail with [REDACTED]",
    );
  });

  test("keeps command discovery caches and approved child environments adapter-local", async () => {
    const firstDirectory = await temporaryDirectory();
    const secondDirectory = await temporaryDirectory();
    const name = process.platform === "win32" ? "codex.exe" : "codex";
    const firstExecutable = await executable(firstDirectory, name);
    const secondExecutable = await executable(secondDirectory, name);
    let firstLoads = 0;
    let secondLoads = 0;
    const firstEnv = { PATH: "", OPENAI_API_KEY: "first-child-secret", FIRST: "yes" };
    const first = createCliExecutionResolver({
      env: firstEnv,
      loginShellPathLoader: async () => {
        firstLoads += 1;
        return firstDirectory;
      },
    });
    const second = createCliExecutionResolver({
      env: { PATH: "", OPENAI_API_KEY: "second-child-secret", SECOND: "yes" },
      loginShellPathLoader: async () => {
        secondLoads += 1;
        return secondDirectory;
      },
    });
    firstEnv.PATH = secondDirectory;
    firstEnv.OPENAI_API_KEY = "mutated-secret";

    const [firstDescriptor, secondDescriptor] = await Promise.all([
      first.resolve("codex-cli"),
      second.resolve("codex-cli"),
    ]);
    await first.resolve("codex-cli");
    expect(firstDescriptor).toMatchObject({
      mode: "direct",
      executable: firstExecutable,
      env: { PATH: "", OPENAI_API_KEY: "first-child-secret", FIRST: "yes" },
      responseSensitiveValues: ["first-child-secret"],
    });
    expect(secondDescriptor).toMatchObject({
      mode: "direct",
      executable: secondExecutable,
      env: { PATH: "", OPENAI_API_KEY: "second-child-secret", SECOND: "yes" },
      responseSensitiveValues: ["second-child-secret"],
    });
    expect(firstLoads).toBe(1);
    expect(secondLoads).toBe(1);
  });

  test("uses the injected Windows platform for command shims and frozen environment authority", async () => {
    const directory = await temporaryDirectory();
    const shim = await executable(directory, "codex.CMD");
    const processor = await executable(directory, "cmd.exe");
    const env = {
      PATH: directory,
      PATHEXT: ".CMD",
      ComSpec: processor,
      openai_api_key: "windows-secret",
    };
    const resolver = createCliExecutionResolver({
      env,
      platform: "win32",
      loginShellPathLoader: async () => "",
    });
    env.PATH = "relative-after-construction";
    env.openai_api_key = "mutated-secret";

    expect(await resolver.resolve("codex-cli")).toEqual({
      mode: "windows-command-shim",
      commandProcessor: await realpath(processor),
      shim: await realpath(shim),
      argsPrefix: [],
      env: {
        PATH: directory,
        PATHEXT: ".CMD",
        ComSpec: processor,
        openai_api_key: "windows-secret",
      },
      responseSensitiveValues: ["windows-secret"],
    });
  });

  test("ignores relative PATH entries when resolving approved executables", async () => {
    const directory = await temporaryDirectory();
    const name = process.platform === "win32" ? "claude.exe" : "claude";
    const path = await executable(directory, name);
    const resolver = createCliExecutionResolver({
      env: { PATH: `relative-bin${delimiter}${directory}` },
      loginShellPathLoader: async () => "",
    });

    expect(await resolver.resolve("claude-cli")).toMatchObject({ executable: path });
  });

  test("preserves static credential guidance and operation-local vault remediation", async () => {
    const backendDetail = "core-adapter-vault-backend-detail";
    let calls = 0;
    const gateway = createCoreRuntimeGateway({
      env: {},
      credentialResolver: {
        async resolve(provider) {
          calls += 1;
          if (calls === 1) {
            throw new CredentialVaultError("get", provider, new Error(backendDetail));
          }
          return { source: "missing" };
        },
      },
      sensitive: createSensitiveValueRegistry(),
    });

    try {
      await gateway.listModels("openai");
      throw new Error("expected vault failure");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeStageError);
      expect((error as RuntimeStageError).cause).toBeInstanceOf(CredentialVaultError);
      expect(String(error)).toContain("credential vault get (openai): unavailable");
      expect(String(error)).not.toContain(backendDetail);
    }

    try {
      await gateway.listModels("openai");
      throw new Error("expected missing credential");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeStageError);
      expect((error as RuntimeStageError).cause).toBeUndefined();
      expect(String(error)).toContain("missing credential; set OPENAI_API_KEY");
      expect(String(error)).not.toContain(backendDetail);
    }

    const unavailable = createCoreRuntimeGateway({
      env: {},
      credentialResolver: {
        resolve: async () => ({ source: "unavailable", reason: "target-disabled" }),
      },
      sensitive: createSensitiveValueRegistry(),
    });
    await expect(unavailable.listModels("openai")).rejects.toThrow(
      "native credential storage unavailable on this target; set OPENAI_API_KEY",
    );
  });
});

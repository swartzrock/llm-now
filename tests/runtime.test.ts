import { afterEach, describe, expect, test } from "bun:test";
import {
  BYOK_API_KEY_ENV_VARS,
  BYOK_PROVIDER_IDS,
  type ByokEnvironment,
  type ByokModelOption,
  type ByokProviderConfig,
  type ByokProviderId,
  type ByokProviderRuntime,
} from "@swartzrock/byok-runtime";
import type { LocalCommandRequest } from "@swartzrock/byok-runtime/node";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import {
  createBunCredentialVault,
  createCredentialResolver,
  createSensitiveValueRegistry,
} from "../src/credentials.ts";
import {
  RuntimeStageError,
  createRuntimeGateway,
  type RuntimeGatewayDependencies,
} from "../src/runtime.ts";

const providerIds: ByokProviderId[] = [...BYOK_PROVIDER_IDS];
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(process.cwd(), ".tmp-runtime-workspace-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function runtime(overrides: Partial<ByokProviderRuntime> & {
  streamText?: (
    input: { prompt: string; instructions?: string },
    signal?: AbortSignal,
  ) => { textStream: AsyncIterable<string> };
} = {}): ByokProviderRuntime {
  return {
    id: "ollama",
    label: "Fake",
    requiresNetwork: false,
    requiresDownload: false,
    testConnection: async () => ({ ok: true, message: "ok" }),
    listModels: async () => [],
    generateText: async () => ({ text: "generated" }),
    ...overrides,
  };
}

function createTestGateway(
  deps: Omit<RuntimeGatewayDependencies, "credentialResolver" | "sensitive">
    & Partial<Pick<RuntimeGatewayDependencies, "credentialResolver" | "sensitive">>,
) {
  const sensitive = deps.sensitive ?? createSensitiveValueRegistry();
  const credentialResolver = deps.credentialResolver ?? createCredentialResolver({
    env: deps.env,
    vault: createBunCredentialVault({
      get: async () => null,
      set: async () => {},
      delete: async () => false,
    }),
    vaultEnabled: false,
  });
  return createRuntimeGateway({ ...deps, sensitive, credentialResolver });
}

describe("runtime gateway", () => {
  if (process.platform === "win32") {
    test("launches workspace CLIs installed as Windows command shims", async () => {
      const directory = await temporaryDirectory();
      const primary = join(directory, "workspace");
      const commands = join(directory, "commands");
      await Promise.all([mkdir(primary), mkdir(commands)]);
      await writeFile(
        join(commands, "codex.cmd"),
        '@echo off\r\n@echo {"type":"item.completed","item":{"type":"agent_message","text":"cmd-result"}}\r\n',
      );
      const gateway = createTestGateway({
        env: { PATH: commands, PATHEXT: ".CMD" },
        workspaceLoginShellPathLoader: async () => "",
      });

      await expect(gateway.generate("codex-cli", null, "prompt", undefined, undefined, {
        primaryDirectory: primary,
        additionalDirectories: [],
        directoryAccess: "read-only",
      })).resolves.toBe("cmd-result");
    });
  }

  test("preserves runtime discovery order without probing providers itself", async () => {
    let calls = 0;
    const gateway = createTestGateway({
      env: {},
      findProviders: async () => {
        calls += 1;
        return providerIds;
      },
    });

    expect(await gateway.discover()).toEqual(providerIds);
    expect(calls).toBe(1);
  });

  test("maps every provider class to public runtime config", async () => {
    const env: ByokEnvironment = Object.fromEntries(
      BYOK_API_KEY_ENV_VARS.map((name) => [name, `${name}-secret`]),
    );
    const configs: ByokProviderConfig[] = [];
    const gateway = createTestGateway({
      env,
      createProvider: (config) => {
        configs.push(config);
        return runtime({ id: config.provider });
      },
    });

    for (const provider of providerIds) await gateway.listModels(provider);

    expect(configs).toEqual([
      { provider: "anthropic", apiKey: "ANTHROPIC_API_KEY-secret", model: "" },
      { provider: "openai", apiKey: "OPENAI_API_KEY-secret", model: "" },
      { provider: "google", apiKey: "GOOGLE_API_KEY-secret", model: "" },
      { provider: "xai", apiKey: "XAI_API_KEY-secret", model: "" },
      { provider: "openrouter", apiKey: "OPENROUTER_API_KEY-secret", model: "" },
      { provider: "groq", apiKey: "GROQ_API_KEY-secret", model: "" },
      { provider: "mistral", apiKey: "MISTRAL_API_KEY-secret", model: "" },
      { provider: "deepseek", apiKey: "DEEPSEEK_API_KEY-secret", model: "" },
      { provider: "deepinfra", apiKey: "DEEPINFRA_TOKEN-secret", model: "" },
      { provider: "ollama", model: "" },
      { provider: "lm-studio", model: "" },
      { provider: "codex-cli", command: "codex" },
      { provider: "claude-cli", command: "claude" },
    ]);
  });

  test("merges vault-only cloud providers without reading vault for environment providers", async () => {
    const calls: string[] = [];
    const sensitive = createSensitiveValueRegistry();
    const vault = createBunCredentialVault({
      get: async ({ name }) => {
        calls.push(name);
        return name === "api-key:openai" ? "stored-openai" : null;
      },
      set: async () => {},
      delete: async () => false,
    });
    const env = { ANTHROPIC_API_KEY: "env-anthropic" };
    const gateway = createTestGateway({
      env,
      sensitive,
      credentialResolver: createCredentialResolver({
        env,
        vault,
        vaultEnabled: true,
      }),
      findProviders: async () => ["anthropic", "ollama"],
    });

    expect(await gateway.discover()).toEqual(["anthropic", "ollama", "openai"]);
    expect(calls).not.toContain("api-key:anthropic");
    expect(calls).toContain("api-key:openai");
  });

  test("reuses one successful vault read across discovery, listing, and generation", async () => {
    const vaultReads: string[] = [];
    const configs: ByokProviderConfig[] = [];
    const sensitive = createSensitiveValueRegistry();
    const env = {};
    const gateway = createTestGateway({
      env,
      sensitive,
      credentialResolver: createCredentialResolver({
        env,
        vaultEnabled: true,
        vault: createBunCredentialVault({
          get: async ({ name }) => {
            vaultReads.push(name);
            return name === "api-key:openai" ? "stored-openai" : null;
          },
          set: async () => {},
          delete: async () => false,
        }),
      }),
      findProviders: async () => [],
      createProvider: (config) => {
        configs.push(config);
        return runtime({ id: config.provider });
      },
    });

    expect(await gateway.discover()).toEqual(["openai"]);
    await gateway.listModels("openai");
    await gateway.generate("openai", "gpt-test", "hello");
    expect(vaultReads).toHaveLength(BYOK_PROVIDER_IDS.length - 4);
    expect(vaultReads.filter((name) => name === "api-key:openai")).toHaveLength(1);
    expect(configs).toEqual([
      { provider: "openai", apiKey: "stored-openai", model: "" },
      { provider: "openai", apiKey: "stored-openai", model: "gpt-test" },
    ]);
  });

  test("forwards exact instructions after the positional abort signal and omits them when absent", async () => {
    const calls: Array<{
      input: { prompt: string; instructions?: string };
      signal?: AbortSignal;
    }> = [];
    const gateway = createTestGateway({
      env: {},
      createProvider: () => runtime({
        generateText: async (input, signal) => {
          calls.push({ input, signal });
          return { text: "generated" };
        },
      }),
    });
    const controller = new AbortController();

    await gateway.generate(
      "ollama",
      "qwen",
      "first prompt",
      controller.signal,
      '  Use "quotes" and \\slashes.  ',
    );
    await gateway.generate("ollama", "qwen", "second prompt", controller.signal);

    expect(calls).toEqual([
      {
        input: {
          prompt: "first prompt",
          instructions: '  Use "quotes" and \\slashes.  ',
        },
        signal: controller.signal,
      },
      {
        input: { prompt: "second prompt" },
        signal: controller.signal,
      },
    ]);
  });

  test("uses streamText and handles each chunk before reading the next one", async () => {
    const events: string[] = [];
    let bufferedCalls = 0;
    const controller = new AbortController();
    const gateway = createTestGateway({
      env: {},
      createProvider: () => runtime({
        generateText: async () => {
          bufferedCalls += 1;
          return { text: "unexpected" };
        },
        streamText: (input, signal) => {
          expect(input).toEqual({
            prompt: "stream prompt",
            instructions: "Be concise.",
          });
          expect(signal).toBe(controller.signal);
          return {
            delivery: "native" as const,
            textStream: {
              async *[Symbol.asyncIterator]() {
                events.push("yield:first");
                yield "first";
                events.push("yield:second");
                yield " second";
              },
            },
          };
        },
      }),
    });

    await expect(gateway.generate(
      "ollama",
      "qwen",
      "stream prompt",
      controller.signal,
      "Be concise.",
      undefined,
      async (chunk) => {
        events.push(`write:${chunk}`);
      },
    )).resolves.toBe("first second");
    expect(events).toEqual([
      "yield:first",
      "write:first",
      "yield:second",
      "write: second",
    ]);
    expect(bufferedCalls).toBe(0);
  });

  test("rejects a pre-aborted generation before provider setup", async () => {
    let providerCalls = 0;
    const gateway = createTestGateway({
      env: {},
      createProvider: () => {
        providerCalls += 1;
        return runtime();
      },
    });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(
      gateway.generate("ollama", "qwen", "prompt", controller.signal),
    ).rejects.toThrow("cancelled");
    expect(providerCalls).toBe(0);
  });

  test("re-checks generation cancellation after async credential setup", async () => {
    let providerCalls = 0;
    let generationCalls = 0;
    const controller = new AbortController();
    const gateway = createTestGateway({
      env: {},
      credentialResolver: {
        resolve: async () => {
          controller.abort(new Error("cancelled after setup"));
          return { source: "environment", apiKey: "secret", envName: "OPENAI_API_KEY" };
        },
      },
      createProvider: () => {
        providerCalls += 1;
        return runtime({
          generateText: async () => {
            generationCalls += 1;
            return { text: "unexpected" };
          },
        });
      },
    });

    await expect(
      gateway.generate("openai", "gpt-test", "prompt", controller.signal),
    ).rejects.toThrow("cancelled after setup");
    expect(providerCalls).toBe(1);
    expect(generationCalls).toBe(0);
  });

  test("rejects unsupported workspaces before credentials or provider construction", async () => {
    let credentialReads = 0;
    let providerCalls = 0;
    const gateway = createTestGateway({
      env: {},
      credentialResolver: {
        resolve: async () => {
          credentialReads += 1;
          return { source: "missing" as const };
        },
      },
      createProvider: () => {
        providerCalls += 1;
        return runtime();
      },
    });

    await expect(gateway.generate("openai", "gpt-test", "prompt", undefined, undefined, {
      primaryDirectory: "/project",
      additionalDirectories: [],
      directoryAccess: "read-only",
    })).rejects.toThrow("provider openai does not support alias workspaces");
    expect(credentialReads).toBe(0);
    expect(providerCalls).toBe(0);
  });

  test("runs Codex and Claude in canonical multi-directory workspaces", async () => {
    const directory = await temporaryDirectory();
    const primary = join(directory, "primary project");
    const first = join(directory, "additional one");
    const second = join(directory, "additional two");
    await Promise.all([primary, first, second].map((path) => mkdir(path)));
    const requests: LocalCommandRequest[] = [];
    const gateway = createTestGateway({
      env: {},
      workspaceCommandResolver: async (command) => `/trusted/${command}`,
      workspaceRunner: {
        run: async (request) => {
          requests.push(request);
          return request.command.endsWith("/codex")
            ? {
              stdout: `${JSON.stringify({
                type: "item.completed",
                item: { type: "agent_message", text: "codex-result" },
              })}\n`,
              stderr: "",
              exitCode: 0,
            }
            : {
              stdout: JSON.stringify({ result: "claude-result" }),
              stderr: "",
              exitCode: 0,
            };
        },
      },
      createProvider: () => {
        throw new Error("workspace generation must not use the provider factory");
      },
    });
    const writableWorkspace = {
      primaryDirectory: primary,
      additionalDirectories: [first, second],
      directoryAccess: "read-write" as const,
    };
    const readOnlyWorkspace = { ...writableWorkspace, directoryAccess: "read-only" as const };

    await expect(gateway.generate(
      "codex-cli",
      "gpt-test",
      "prompt",
      undefined,
      "Be concise.",
      writableWorkspace,
    )).resolves.toBe("codex-result");
    await expect(gateway.generate(
      "claude-cli",
      "claude-test",
      "prompt",
      undefined,
      "Be concise.",
      readOnlyWorkspace,
    )).resolves.toBe("claude-result");
    await expect(gateway.generate(
      "codex-cli",
      "gpt-test",
      "prompt",
      undefined,
      "Be concise.",
      readOnlyWorkspace,
    )).resolves.toBe("codex-result");

    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.command)).toEqual([
      "/trusted/codex",
      "/trusted/claude",
      "/trusted/codex",
    ]);
    expect(requests[0]?.cwd).toBe(primary);
    expect(requests[0]?.args).toEqual([
      "exec",
      "--add-dir",
      first,
      "--add-dir",
      second,
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "--json",
      "-c",
      'developer_instructions="Be concise."',
      "--model",
      "gpt-test",
    ]);
    expect(requests[1]?.cwd).toBe(primary);
    expect(requests[1]?.args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--input-format",
      "text",
      "--no-session-persistence",
      "--no-chrome",
      "--safe-mode",
      "--setting-sources",
      "user",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Read,Glob,Grep",
      "--append-system-prompt",
      "Be concise.",
      "--model",
      "claude-test",
      "--add-dir",
      first,
      "--add-dir",
      second,
    ]);
    expect(requests[2]?.args).toEqual([
      "exec",
      "--add-dir",
      first,
      "--add-dir",
      second,
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--json",
      "-c",
      'developer_instructions="Be concise."',
      "--model",
      "gpt-test",
    ]);

    await expect(gateway.generate(
      "claude-cli",
      "claude-test",
      "prompt",
      undefined,
      undefined,
      writableWorkspace,
    )).rejects.toThrow("provider claude-cli does not support read-write alias workspaces");
    expect(requests).toHaveLength(3);
  });

  test("ignores relative PATH entries before running a workspace CLI", async () => {
    const directory = await temporaryDirectory();
    const primary = join(directory, "workspace");
    const trusted = join(directory, "trusted");
    const executableName = process.platform === "win32" ? "codex.exe" : "codex";
    const workspaceExecutable = join(primary, executableName);
    const trustedExecutable = join(trusted, executableName);
    await Promise.all([mkdir(primary), mkdir(trusted)]);
    await Promise.all([
      writeFile(workspaceExecutable, "workspace executable"),
      writeFile(trustedExecutable, "trusted executable"),
    ]);
    if (process.platform !== "win32") {
      await Promise.all([chmod(workspaceExecutable, 0o755), chmod(trustedExecutable, 0o755)]);
    }
    const requests: LocalCommandRequest[] = [];
    const gateway = createTestGateway({
      env: { PATH: `.${delimiter}${trusted}` },
      workspaceLoginShellPathLoader: async () => "",
      workspaceRunner: {
        run: async (request) => {
          requests.push(request);
          return {
            stdout: `${JSON.stringify({
              type: "item.completed",
              item: { type: "agent_message", text: "trusted-result" },
            })}\n`,
            stderr: "",
            exitCode: 0,
          };
        },
      },
    });

    await expect(gateway.generate("codex-cli", null, "prompt", undefined, undefined, {
      primaryDirectory: primary,
      additionalDirectories: [],
      directoryAccess: "read-only",
    })).resolves.toBe("trusted-result");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.command).toBe(trustedExecutable);

    const relativeOnly = createTestGateway({
      env: { PATH: "." },
      workspaceLoginShellPathLoader: async () => "",
      workspaceRunner: {
        run: async () => {
          throw new Error("relative workspace executable must not run");
        },
      },
    });
    await expect(relativeOnly.generate("codex-cli", null, "prompt", undefined, undefined, {
      primaryDirectory: primary,
      additionalDirectories: [],
      directoryAccess: "read-only",
    })).rejects.toThrow("codex was not found in an absolute PATH directory");
  });

  test("resolves workspace CLIs from the login-shell PATH used by ordinary aliases", async () => {
    const directory = await temporaryDirectory();
    const primary = join(directory, "workspace");
    const trusted = join(directory, "login-shell-bin");
    const executableName = process.platform === "win32" ? "codex.exe" : "codex";
    const trustedExecutable = join(trusted, executableName);
    await Promise.all([mkdir(primary), mkdir(trusted)]);
    await writeFile(trustedExecutable, "trusted executable");
    if (process.platform !== "win32") await chmod(trustedExecutable, 0o755);
    const requests: LocalCommandRequest[] = [];
    const gateway = createTestGateway({
      env: { PATH: "." },
      workspaceLoginShellPathLoader: async () => `${trusted}${delimiter}.`,
      workspaceRunner: {
        run: async (request) => {
          requests.push(request);
          return {
            stdout: `${JSON.stringify({
              type: "item.completed",
              item: { type: "agent_message", text: "login-shell-result" },
            })}\n`,
            stderr: "",
            exitCode: 0,
          };
        },
      },
    });

    await expect(gateway.generate("codex-cli", null, "prompt", undefined, undefined, {
      primaryDirectory: primary,
      additionalDirectories: [],
      directoryAccess: "read-only",
    })).resolves.toBe("login-shell-result");
    expect(requests[0]?.command).toBe(trustedExecutable);
  });

  test("aborts a pending workspace preflight before command resolution", async () => {
    const root = new AbortController();
    let resolverCalls = 0;
    let runnerCalls = 0;
    const gateway = createTestGateway({
      env: {},
      workspacePreflight: async () => new Promise(() => undefined),
      workspaceCommandResolver: async () => {
        resolverCalls += 1;
        return "/trusted/codex";
      },
      workspaceRunner: {
        run: async () => {
          runnerCalls += 1;
          throw new Error("runner must not start");
        },
      },
    });
    const generation = gateway.generate("codex-cli", null, "prompt", root.signal, undefined, {
      primaryDirectory: "/pending/primary",
      additionalDirectories: [],
      directoryAccess: "read-only",
    });
    root.abort(new Error("cancel pending preflight"));

    await expect(generation).rejects.toThrow("cancel pending preflight");
    expect(resolverCalls).toBe(0);
    expect(runnerCalls).toBe(0);
  });

  test("requires write permission only for read-write workspaces", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const directory = await temporaryDirectory();
    const primary = join(directory, "read-only-root");
    await mkdir(primary, { mode: 0o555 });
    await chmod(primary, 0o555);
    let resolverCalls = 0;
    let runnerCalls = 0;
    const gateway = createTestGateway({
      env: {},
      workspaceCommandResolver: async () => {
        resolverCalls += 1;
        return "/trusted/codex";
      },
      workspaceRunner: {
        run: async () => {
          runnerCalls += 1;
          return {
            stdout: `${JSON.stringify({
              type: "item.completed",
              item: { type: "agent_message", text: "read-only-result" },
            })}\n`,
            stderr: "",
            exitCode: 0,
          };
        },
      },
    });
    const readOnlyWorkspace = {
      primaryDirectory: primary,
      additionalDirectories: [],
      directoryAccess: "read-only" as const,
    };

    await expect(gateway.generate(
      "codex-cli",
      null,
      "prompt",
      undefined,
      undefined,
      readOnlyWorkspace,
    )).resolves.toBe("read-only-result");
    await expect(gateway.generate(
      "codex-cli",
      null,
      "prompt",
      undefined,
      undefined,
      { ...readOnlyWorkspace, directoryAccess: "read-write" },
    )).rejects.toThrow("workspace primary directory is unavailable");
    expect(resolverCalls).toBe(1);
    expect(runnerCalls).toBe(1);
    await chmod(primary, 0o755);
  });

  test("preflights live roots and redacts paths from CLI failures", async () => {
    const directory = await temporaryDirectory();
    const primary = join(directory, "secret primary");
    const additional = join(directory, "secret additional");
    await Promise.all([primary, additional].map((path) => mkdir(path)));
    let runnerCalls = 0;
    const gateway = createTestGateway({
      env: {},
      workspaceCommandResolver: async () => "/trusted/codex",
      workspaceRunner: {
        run: async () => {
          runnerCalls += 1;
          throw new Error(`failed for ${primary} and ${JSON.stringify(additional)}`);
        },
      },
    });

    try {
      await gateway.generate("codex-cli", null, "prompt", undefined, undefined, {
        primaryDirectory: primary,
        additionalDirectories: [additional],
        directoryAccess: "read-only",
      });
      throw new Error("expected generation to fail");
    } catch (error) {
      expect(String(error)).not.toContain(primary);
      expect(String(error)).not.toContain(additional);
      expect(String(error)).toContain("[REDACTED]");
    }
    expect(runnerCalls).toBe(1);

    await writeFile(join(directory, "not-a-directory"), "file");
    await expect(gateway.generate("codex-cli", null, "prompt", undefined, undefined, {
      primaryDirectory: join(directory, "not-a-directory"),
      additionalDirectories: [],
      directoryAccess: "read-only",
    })).rejects.toThrow("workspace primary directory is not a directory");
    expect(runnerCalls).toBe(1);

    await expect(gateway.generate("codex-cli", null, "prompt", undefined, undefined, {
      primaryDirectory: join(directory, "missing"),
      additionalDirectories: [],
      directoryAccess: "read-only",
    })).rejects.toThrow("workspace primary directory is unavailable");
    expect(runnerCalls).toBe(1);
  });

  test("redacts raw and JSON-escaped instructions only from generation failures", async () => {
    const instructions = 'First instruction line.\n  Use "quotes" and \\slashes.  ';
    const jsonEscaped = JSON.stringify(instructions).slice(1, -1);
    const transportEscaped = JSON.stringify(jsonEscaped).slice(1, -1);
    const failing = createTestGateway({
      env: {},
      createProvider: () => runtime({
        generateText: async () => {
          throw new Error(
            `raw=${instructions} serialized=${jsonEscaped} transport=${transportEscaped}`,
          );
        },
      }),
    });

    try {
      await failing.generate("ollama", "qwen", "prompt", undefined, instructions);
      throw new Error("expected generation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeStageError);
      expect(String(error)).not.toContain(instructions);
      expect(String(error)).not.toContain(jsonEscaped);
      expect(String(error)).not.toContain(transportEscaped);
      expect(String(error)).toContain("[REDACTED]");
    }

    const successful = createTestGateway({
      env: {},
      createProvider: () => runtime({
        generateText: async () => ({ text: `model echoed ${instructions}` }),
      }),
    });
    expect(
      await successful.generate("ollama", "qwen", "prompt", undefined, instructions),
    ).toBe(`model echoed ${instructions}`);
  });

  test("preserves usable providers on vault failure and fails when none are usable", async () => {
    const cause = new Error("backend detail");
    const resolver = createCredentialResolver({
      env: {},
      vaultEnabled: true,
      vault: createBunCredentialVault({
        get: async () => {
          throw cause;
        },
        set: async () => {},
        delete: async () => false,
      }),
    });

    const degraded = createTestGateway({
      env: {},
      credentialResolver: resolver,
      findProviders: async () => ["ollama"],
    });
    expect(await degraded.discover()).toEqual(["ollama"]);

    const failed = createTestGateway({
      env: {},
      credentialResolver: createCredentialResolver({
        env: {},
        vaultEnabled: true,
        vault: createBunCredentialVault({
          get: async () => {
            throw cause;
          },
          set: async () => {},
          delete: async () => false,
        }),
      }),
      findProviders: async () => [],
    });
    try {
      await failed.discover();
      throw new Error("expected discovery to fail");
    } catch (error) {
      expect(error).toMatchObject({ stage: "discovery", provider: null });
      expect(String(error)).not.toContain(cause.message);
    }
  });

  test("redacts a vault-selected key and never constructs an alternate provider", async () => {
    let vaultReads = 0;
    let providerCalls = 0;
    const gateway = createTestGateway({
      env: {},
      credentialResolver: createCredentialResolver({
        env: {},
        vaultEnabled: true,
        vault: createBunCredentialVault({
          get: async () => {
            vaultReads += 1;
            return "stored-openai";
          },
          set: async () => {},
          delete: async () => false,
        }),
      }),
      createProvider: (config) => {
        providerCalls += 1;
        expect(config).toEqual({ provider: "openai", apiKey: "stored-openai", model: "" });
        return runtime({
          listModels: async () => {
            throw new Error("rejected stored-openai");
          },
        });
      },
    });

    await expect(gateway.listModels("openai")).rejects.toThrow("rejected [REDACTED]");
    expect(vaultReads).toBe(1);
    expect(providerCalls).toBe(1);
  });

  test("distinguishes missing credentials from disabled native storage", async () => {
    let providerCalls = 0;
    const disabled = createTestGateway({
      env: {},
      createProvider: () => {
        providerCalls += 1;
        return runtime();
      },
    });
    await expect(disabled.listModels("openai")).rejects.toThrow(
      "native credential storage unavailable on this target; set OPENAI_API_KEY",
    );

    const missing = createTestGateway({
      env: {},
      credentialResolver: createCredentialResolver({
        env: {},
        vaultEnabled: true,
        vault: createBunCredentialVault({
          get: async () => null,
          set: async () => {},
          delete: async () => false,
        }),
      }),
      createProvider: () => {
        providerCalls += 1;
        return runtime();
      },
    });
    await expect(missing.listModels("openai")).rejects.toThrow(
      "missing credential; set OPENAI_API_KEY",
    );
    expect(providerCalls).toBe(0);
  });

  test("does not retry another source after the selected environment key is rejected", async () => {
    let vaultReads = 0;
    let providers = 0;
    const env = { OPENAI_API_KEY: "selected-env-secret" };
    const sensitive = createSensitiveValueRegistry();
    const gateway = createTestGateway({
      env,
      sensitive,
      credentialResolver: createCredentialResolver({
        env,
        vaultEnabled: true,
        vault: createBunCredentialVault({
          get: async () => {
            vaultReads += 1;
            return "valid-vault-fallback";
          },
          set: async () => {},
          delete: async () => false,
        }),
      }),
      createProvider: (config) => {
        providers += 1;
        expect(config).toEqual({
          provider: "openai",
          apiKey: "selected-env-secret",
          model: "",
        });
        return runtime({
          listModels: async () => {
            throw new Error("rejected selected-env-secret");
          },
        });
      },
    });

    expect(gateway.listModels("openai")).rejects.toThrow("[REDACTED]");
    expect(vaultReads).toBe(0);
    expect(providers).toBe(1);
  });

  test("validates and redacts the exact candidate despite an environment override", async () => {
    const configs: ByokProviderConfig[] = [];
    const gateway = createTestGateway({
      env: { OPENAI_API_KEY: "environment-secret" },
      createProvider: (config) => {
        configs.push(config);
        return runtime({
          listModels: async () => {
            throw new Error("provider echoed candidate-secret");
          },
        });
      },
    });

    expect(gateway.validateCredential("openai", "candidate-secret")).rejects.toThrow(
      "provider echoed [REDACTED]",
    );
    expect(configs).toEqual([{
      provider: "openai",
      apiKey: "candidate-secret",
      model: "",
    }]);
  });

  test("retains the failing stage and redacts environment values", async () => {
    const credentials = BYOK_API_KEY_ENV_VARS.map((name, index) => ({
      name,
      secret: `${name}-secret-${index}`,
    }));
    const secrets = credentials.map(({ secret }) => secret);
    const ordinaryEnvironmentValue = "/custom/bin";
    const env = {
      ...Object.fromEntries(
        credentials.map(({ name, secret }) => [name, secret]),
      ),
      PATH: ordinaryEnvironmentValue,
    };
    const gateway = createTestGateway({
      env,
      createProvider: () =>
        runtime({
          listModels: async () => {
            throw new Error(
              `upstream rejected ${secrets.join(" ")} from ${ordinaryEnvironmentValue}`,
            );
          },
        }),
    });

    try {
      await gateway.listModels("openai");
      throw new Error("expected listModels to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeStageError);
      expect(error).toMatchObject({ stage: "model-list", provider: "openai" });
      for (const secret of secrets) expect(String(error)).not.toContain(secret);
      expect(String(error)).toContain("[REDACTED]");
      expect(String(error)).toContain(ordinaryEnvironmentValue);
    }
  });
});

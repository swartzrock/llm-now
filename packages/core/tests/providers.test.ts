import { describe, expect, test } from "bun:test";
import { BYOK_PROVIDER_IDS } from "@swartzrock/byok-runtime";
import type { LocalProcess, LocalProcessSpawner } from "@swartzrock/byok-runtime/node";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createLlmNowCoreWithInternals } from "../src/client.ts";
import { ApprovedExecutionRunner, windowsCommandShimArguments } from "../src/providers.ts";

function fakeProcess(onKill?: () => void) {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const child = {
    stdout,
    stderr,
    stdin,
    once: events.once.bind(events),
    kill: () => {
      onKill?.();
      return true;
    },
  } as unknown as LocalProcess;
  return { child, events, stdout, stderr, stdin };
}

describe("provider discovery", () => {
  test("returns records in the existing provider order", async () => {
    const client = createLlmNowCoreWithInternals({
      environment: {},
      credentialResolver: { resolve: async () => ({ status: "missing" }) },
    }, {
      findAvailableProviders: async () => ["ollama"],
      createProvider: () => { throw new Error("unused"); },
    });

    expect((await client.discoverProviders()).providers.map(({ provider }) => provider))
      .toEqual([...BYOK_PROVIDER_IDS]);
  });

  test("preserves usable local providers when later credential resolution fails", async () => {
    const client = createLlmNowCoreWithInternals({
      environment: {},
      credentialResolver: { resolve: async () => { throw new Error("vault-secret"); } },
    }, {
      findAvailableProviders: async () => ["ollama"],
      createProvider: () => { throw new Error("unused"); },
    });

    const result = await client.discoverProviders();
    expect(result.degraded).toBeTrue();
    expect(result.providers.find(({ provider }) => provider === "ollama"))
      .toMatchObject({ available: true, family: "local" });
  });

  test("fails safely when credential resolution fails before any provider is usable", async () => {
    const client = createLlmNowCoreWithInternals({
      environment: {},
      credentialResolver: { resolve: async () => { throw new Error("vault-secret"); } },
    }, {
      findAvailableProviders: async () => [],
      createProvider: () => { throw new Error("unused"); },
    });

    await expect(client.discoverProviders()).rejects.toMatchObject({
      code: "CREDENTIAL_RESOLUTION_FAILED",
      operation: "discovery",
    });
  });

  test("reports missing and unavailable cloud credentials without making them usable", async () => {
    let calls = 0;
    const client = createLlmNowCoreWithInternals({
      environment: {},
      credentialResolver: { resolve: async () => {
        calls += 1;
        return calls === 1 ? { status: "missing" } : { status: "unavailable" };
      } },
    }, {
      findAvailableProviders: async () => ["ollama"],
      createProvider: () => { throw new Error("unused"); },
    });

    const result = await client.discoverProviders();
    expect(result.providers.find(({ provider }) => provider === "anthropic"))
      .toMatchObject({ available: false, reason: "credential-missing" });
    expect(result.providers.find(({ provider }) => provider === "openai"))
      .toMatchObject({ available: false, reason: "credential-unavailable" });
  });

  test("does not treat ambient cloud keys or PATH as routing authority", async () => {
    let resolverCalls = 0;
    const client = createLlmNowCoreWithInternals({
      environment: {
        OPENAI_API_KEY: "ambient-key-must-not-win",
        PATH: "/ambient/command/path",
        SHELL: "/ambient/shell",
        COMSPEC: "C:\\ambient\\cmd.exe",
      },
      credentialResolver: { resolve: async () => {
        resolverCalls += 1;
        return { status: "missing" };
      } },
    }, {
      findAvailableProviders: async () => ["codex-cli"],
      createProvider: () => { throw new Error("unused"); },
    });

    const result = await client.discoverProviders();
    expect(result.providers.find(({ provider }) => provider === "openai"))
      .toMatchObject({ available: false, reason: "credential-missing" });
    expect(result.providers.find(({ provider }) => provider === "codex-cli"))
      .toMatchObject({ available: false, reason: "execution-unavailable" });
    expect(resolverCalls).toBe(9);
  });
});

describe("approved CLI execution", () => {
  test("uses the approved absolute executable, immutable prefix, and exact environment", async () => {
    const process = fakeProcess();
    let captured: Parameters<LocalProcessSpawner> | undefined;
    let stdin = "";
    process.stdin.on("data", (chunk) => { stdin += chunk.toString(); });
    const runner = new ApprovedExecutionRunner({
      mode: "direct",
      executable: "/approved/bin/codex",
      argsPrefix: ["fixed-prefix"],
      env: { APPROVED: "only" },
    }, ((...args: Parameters<LocalProcessSpawner>) => {
      captured = args;
      queueMicrotask(() => {
        process.stdout.write("ok");
        process.events.emit("close", 0);
      });
      return process.child;
    }) as LocalProcessSpawner);

    await expect(runner.run({
      command: "/ambient/must-not-run",
      args: ["request-arg"],
      stdin: "prompt",
      cwd: "/workspace",
      env: { AMBIENT: "must-not-merge" },
    })).resolves.toEqual({ stdout: "ok", stderr: "", exitCode: 0 });
    expect(captured).toEqual([
      "/approved/bin/codex",
      ["fixed-prefix", "request-arg"],
      { cwd: "/workspace", shell: false, env: { APPROVED: "only" } },
    ]);
    expect(stdin).toBe("prompt");
  });

  test("waits for an aborted owned child to close before rejecting", async () => {
    let killed = false;
    const process = fakeProcess(() => { killed = true; });
    const runner = new ApprovedExecutionRunner({
      mode: "direct",
      executable: "/approved/bin/claude",
      argsPrefix: [],
      env: {},
    }, (() => process.child) as LocalProcessSpawner);
    const controller = new AbortController();
    let settled = false;
    const running = runner.run({ command: "ignored", signal: controller.signal })
      .finally(() => { settled = true; });
    controller.abort(new Error("cancelled"));
    await Promise.resolve();
    expect(killed).toBeTrue();
    expect(settled).toBeFalse();
    process.events.emit("close", null);
    await expect(running).rejects.toThrow("cancelled");
    expect(settled).toBeTrue();
  });

  test("waits for a child error to close before rejecting", async () => {
    const process = fakeProcess();
    const runner = new ApprovedExecutionRunner({
      mode: "direct",
      executable: "/approved/bin/codex",
      argsPrefix: [],
      env: {},
    }, (() => process.child) as LocalProcessSpawner);
    let settled = false;
    const running = runner.run({ command: "ignored" }).finally(() => { settled = true; });

    process.events.emit("error", new Error("child failed before close"));
    await Promise.resolve();
    expect(settled).toBeFalse();
    process.events.emit("close", null);
    await expect(running).rejects.toThrow("child failed before close");
    expect(settled).toBeTrue();
  });

  test("ignores an aborted child error, escalates termination, and still waits for close", async () => {
    const kills: Array<NodeJS.Signals | undefined> = [];
    const process = fakeProcess();
    process.child.kill = ((signal?: NodeJS.Signals) => {
      kills.push(signal);
      return true;
    });
    const controller = new AbortController();
    const runner = new ApprovedExecutionRunner({
      mode: "direct",
      executable: "/approved/bin/codex",
      argsPrefix: [],
      env: {},
    }, (() => {
      controller.abort();
      return process.child;
    }) as LocalProcessSpawner);
    let settled = false;
    const running = runner.run({ command: "ignored", signal: controller.signal })
      .finally(() => { settled = true; });
    process.events.emit("error", new Error("error before close"));
    await Bun.sleep(275);
    expect(kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(settled).toBeFalse();
    process.events.emit("close", null);
    await expect(running).rejects.toBeDefined();
    expect(settled).toBeTrue();
  });

  test("uses one fixed Windows command-shim argument shape", () => {
    expect(windowsCommandShimArguments("C:\\Tools\\codex.cmd", [
      "exec",
      "--model",
      "gpt %MODEL% & safe",
    ])).toEqual([
      "/d",
      "/v:off",
      "/s",
      "/c",
      '"C:\\Tools\\codex.cmd ^^^"exec^^^" ^^^"--model^^^" ^^^"gpt^^^ ^^^%MODEL^^^%^^^ ^^^&^^^ safe^^^""',
    ]);
  });

  test("escapes cmd metacharacters in every Windows command-shim argument", () => {
    expect(windowsCommandShimArguments("C:\\Tools\\codex.cmd", [
      'quote" & whoami | type < input > output (group) ^ %PATH% !delayed!',
    ])).toEqual([
      "/d",
      "/v:off",
      "/s",
      "/c",
      '"C:\\Tools\\codex.cmd ^^^"quote\\^^^"^^^ ^^^&^^^ whoami^^^ ^^^|^^^ type^^^ ^^^<^^^ input^^^ ^^^>^^^ output^^^ ^^^(group^^^)^^^ ^^^^^^^ ^^^%PATH^^^%^^^ ^^^!delayed^^^!^^^""',
    ]);
  });

  test("rejects line breaks in Windows command-shim inputs", () => {
    expect(() => windowsCommandShimArguments("C:\\Tools\\codex.cmd", ["safe\nunsafe"])).toThrow(
      "Windows CLI arguments cannot contain line breaks",
    );
    expect(() => windowsCommandShimArguments("C:\\Tools\\codex\r.cmd", [])).toThrow(
      "Windows CLI arguments cannot contain line breaks",
    );
  });

  test("does not execute a hostile adjacent command through a real Windows shim", async () => {
    if (process.platform !== "win32") return;
    const processor = process.env.ComSpec ?? process.env.COMSPEC;
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (processor === undefined || systemRoot === undefined) {
      throw new Error("Windows command processor environment is unavailable");
    }
    const directory = await mkdtemp(join(tmpdir(), "llm-now-command-shim-"));
    const shim = join(directory, "fixture.cmd");
    const marker = join(directory, "injected.txt");
    await writeFile(shim, "@echo off\r\nexit /b 0\r\n");
    try {
      const runner = new ApprovedExecutionRunner({
        mode: "windows-command-shim",
        commandProcessor: processor,
        shim,
        argsPrefix: [],
        env: {
          ComSpec: processor,
          SystemRoot: systemRoot,
          TEMP: process.env.TEMP ?? directory,
          TMP: process.env.TMP ?? directory,
        },
      }, spawn as unknown as LocalProcessSpawner);

      await runner.run({
        command: "ignored",
        args: [`safe\" & (echo injected)>\"${marker}\" & rem \" %PATH% !PATH! ^|`],
      });
      expect(await Bun.file(marker).exists()).toBeFalse();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

import {
  BYOK_PROVIDER_API_KEY_ENV_VARS,
  BYOK_PROVIDER_IDS,
  type ByokProviderConfig,
  type ByokProviderId,
  type ByokProviderRuntime,
} from "@swartzrock/byok-runtime";
import {
  ClaudeCliProvider,
  CodexCliProvider,
  createByokNodeProvider,
  findAvailableProviders,
  type LocalCommandRequest,
  type LocalCommandResult,
  type LocalProcessSpawner,
} from "@swartzrock/byok-runtime/node";
import { spawn } from "node:child_process";
import type { CliExecutionDescriptor, CliExecutionResolver } from "./cli-execution.js";
import { validateCliExecutionDescriptor } from "./cli-execution.js";
import { LlmNowError } from "./errors.js";
import { raceWithCancellation } from "./streaming.js";
import type {
  CliProviderId,
  CloudProviderId,
  ProviderFamily,
  ProviderId,
  WorkspaceRequest,
} from "./types.js";

export const CLOUD_PROVIDERS = Object.freeze(
  Object.keys(BYOK_PROVIDER_API_KEY_ENV_VARS) as CloudProviderId[],
);
export const CLI_PROVIDERS = Object.freeze(["codex-cli", "claude-cli"] as const);
export const DISCOVERY_ORDER = Object.freeze([...BYOK_PROVIDER_IDS] as ProviderId[]);

export function providerFamily(provider: ProviderId): ProviderFamily {
  if (CLOUD_PROVIDERS.includes(provider as CloudProviderId)) return "cloud";
  if (CLI_PROVIDERS.includes(provider as CliProviderId)) return "cli";
  return "local";
}

export function isCloudProvider(provider: ProviderId): provider is CloudProviderId {
  return providerFamily(provider) === "cloud";
}

export function isCliProvider(provider: ProviderId): provider is CliProviderId {
  return providerFamily(provider) === "cli";
}

export interface ProviderDiscoveryContext {
  readonly executionResolver?: CliExecutionResolver;
  readonly signal?: AbortSignal;
}

export interface CoreInternalDependencies {
  readonly findAvailableProviders: (
    context: ProviderDiscoveryContext,
  ) => Promise<readonly ByokProviderId[]>;
  readonly createProvider: (config: ByokProviderConfig) => ByokProviderRuntime;
  readonly preflightWorkspace?: (
    provider: ProviderId,
    workspace: WorkspaceRequest,
    operation: "generation" | "streaming",
  ) => Promise<WorkspaceRequest>;
  readonly spawnProcess?: LocalProcessSpawner;
  readonly settlementTimeoutMs?: number;
}

export const DEFAULT_CORE_INTERNALS: CoreInternalDependencies = Object.freeze({
  async findAvailableProviders(context: ProviderDiscoveryContext) {
    return findAvailableProviders({ env: {} }, {
      commandExists: async (command) => {
        const provider = command === "codex"
          ? "codex-cli"
          : command === "claude"
            ? "claude-cli"
            : null;
        if (provider === null || context.executionResolver === undefined) return false;
        const descriptor = await context.executionResolver.resolve(provider, context.signal);
        return validateCliExecutionDescriptor(descriptor) !== null;
      },
    });
  },
  createProvider: createByokNodeProvider,
  spawnProcess: spawn as unknown as LocalProcessSpawner,
});

interface CommandRunner {
  run(request: LocalCommandRequest): Promise<LocalCommandResult>;
}

const WINDOWS_COMMAND_META = /([()\][%!^"`<>&|;, *?])/g;

function validWindowsCommandValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("Windows CLI arguments cannot contain line breaks");
  return value;
}

function windowsCommand(value: string): string {
  return validWindowsCommandValue(value).replace(WINDOWS_COMMAND_META, "^$1");
}

function windowsCommandArgument(value: string): string {
  let argument = validWindowsCommandValue(value)
    .replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
    .replace(/(?=(\\+?)?)\1$/g, "$1$1");
  argument = `"${argument}"`.replace(WINDOWS_COMMAND_META, "^$1");
  // A .cmd shim parses forwarded arguments a second time.
  return argument.replace(WINDOWS_COMMAND_META, "^$1");
}

export function windowsCommandShimArguments(
  shim: string,
  args: readonly string[],
): readonly string[] {
  const command = [windowsCommand(shim), ...args.map(windowsCommandArgument)].join(" ");
  return Object.freeze(["/d", "/v:off", "/s", "/c", `"${command}"`]);
}

export class ApprovedExecutionRunner implements CommandRunner {
  constructor(
    private readonly descriptor: CliExecutionDescriptor,
    private readonly spawnProcess: LocalProcessSpawner,
    private readonly defaultSignal?: AbortSignal,
  ) {}

  run(request: LocalCommandRequest): Promise<LocalCommandResult> {
    const signal = request.signal ?? this.defaultSignal;
    signal?.throwIfAborted();
    const requestArgs = request.args ?? [];
    const providerArgs = [...this.descriptor.argsPrefix, ...requestArgs];
    const command = this.descriptor.mode === "direct"
      ? this.descriptor.executable
      : this.descriptor.commandProcessor;
    const args = this.descriptor.mode === "direct"
      ? providerArgs
      : [...windowsCommandShimArguments(this.descriptor.shim, providerArgs)];
    const child = this.spawnProcess(command, args, {
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      shell: false,
      env: { ...this.descriptor.env },
      ...(this.descriptor.mode === "windows-command-shim"
        ? { windowsVerbatimArguments: true }
        : {}),
    });

    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let aborted = false;
      let interruption: unknown;
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let childError: unknown;
      const cleanup = () => {
        signal?.removeEventListener("abort", abort);
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      };
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        operation();
      };
      const interrupt = (error: unknown) => {
        if (settled || aborted) return;
        aborted = true;
        interruption = error;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, 250);
      };
      const abort = () => interrupt(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.stdin.once("error", (error) => interrupt(error));
      child.once("error", (error) => {
        if (!aborted) childError ??= error;
      });
      child.once("close", (code) => finish(() => aborted
        ? reject(interruption)
        : childError !== undefined
          ? reject(childError)
        : resolve({ stdout, stderr, exitCode: code ?? 1 })));
      if (request.timeoutMs !== undefined) {
        timeoutTimer = setTimeout(
          () => interrupt(new Error("approved CLI execution timed out")),
          request.timeoutMs,
        );
      }
      if (signal?.aborted) abort();
      if (!aborted) {
        try {
          child.stdin.end(request.stdin);
        } catch (error) {
          interrupt(error);
        }
      }
    });
  }
}

class WorkspaceCommandRunner implements CommandRunner {
  constructor(
    private readonly provider: CliProviderId,
    private readonly workspace: WorkspaceRequest,
    private readonly runner: CommandRunner,
  ) {}

  run(request: LocalCommandRequest): Promise<LocalCommandResult> {
    const args = [...(request.args ?? [])];
    const generation = this.provider === "codex-cli" ? args[0] === "exec" : args[0] === "-p";
    if (!generation) return this.runner.run(request);
    if (this.provider === "codex-cli") {
      const sandbox = args.indexOf("--sandbox");
      if (sandbox < 0 || sandbox + 1 >= args.length) {
        return Promise.reject(new Error("invalid Codex workspace arguments"));
      }
      args[sandbox + 1] = this.workspace.directoryAccess === "read-write"
        ? "workspace-write"
        : "read-only";
      args.splice(1, 0, ...this.workspace.additionalDirectories.flatMap(
        (directory) => ["--add-dir", directory],
      ));
    } else {
      const tools = args.indexOf("--tools");
      if (tools < 0 || tools + 1 >= args.length) {
        return Promise.reject(new Error("invalid Claude workspace arguments"));
      }
      args[tools + 1] = "Read,Glob,Grep";
      args.push(...this.workspace.additionalDirectories.flatMap(
        (directory) => ["--add-dir", directory],
      ));
    }
    return this.runner.run({ ...request, args, cwd: this.workspace.primaryDirectory });
  }
}

export async function resolveCliExecution(
  resolver: CliExecutionResolver | undefined,
  provider: CliProviderId,
  signal: AbortSignal | undefined,
  operation: "model-list" | "validation" | "generation" | "streaming",
): Promise<CliExecutionDescriptor> {
  if (resolver === undefined) throw new LlmNowError("EXECUTION_UNAVAILABLE", operation, provider);
  let resolved: unknown;
  try {
    signal?.throwIfAborted();
    const resolving = Promise.resolve().then(() => resolver.resolve(provider, signal));
    resolved = signal === undefined
      ? await resolving
      : await raceWithCancellation(resolving, signal);
    signal?.throwIfAborted();
  } catch {
    if (signal?.aborted) throw new LlmNowError("ABORTED", operation, provider);
    throw new LlmNowError("EXECUTION_UNAVAILABLE", operation, provider);
  }
  const descriptor = validateCliExecutionDescriptor(resolved);
  if (descriptor === null) throw new LlmNowError("EXECUTION_UNAVAILABLE", operation, provider);
  return descriptor;
}

export function createCliRuntime(
  provider: CliProviderId,
  model: string | null,
  descriptor: CliExecutionDescriptor,
  internals: CoreInternalDependencies,
  workspace?: WorkspaceRequest,
  operationSignal?: AbortSignal,
): ByokProviderRuntime {
  let runner: CommandRunner = new ApprovedExecutionRunner(
    descriptor,
    internals.spawnProcess ?? (spawn as unknown as LocalProcessSpawner),
    operationSignal,
  );
  if (workspace !== undefined) runner = new WorkspaceCommandRunner(provider, workspace, runner);
  const options = {
    command: descriptor.mode === "direct" ? descriptor.executable : descriptor.shim,
    ...(model === null ? {} : { model }),
    ...(workspace === undefined ? {} : { cwd: workspace.primaryDirectory }),
    runner,
  };
  return provider === "codex-cli"
    ? new CodexCliProvider(options)
    : new ClaudeCliProvider(options);
}

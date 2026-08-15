import {
  BYOK_API_KEY_ENV_VARS,
  BYOK_PROVIDER_API_KEY_ENV_VARS,
  type ByokCloudProviderId,
  type ByokEnvironment,
  type ByokModelOption,
  type ByokProviderConfig,
  type ByokProviderId,
  type ByokProviderRuntime,
} from "@swartzrock/byok-runtime";
import {
  ClaudeCliProvider,
  CodexCliProvider,
  LocalCommandRunner,
  createByokNodeProvider,
  findAvailableProviders,
  type LoginShellPathLoader,
  type LocalCommandRequest,
  type LocalCommandResult,
  type LocalProcessSpawner,
} from "@swartzrock/byok-runtime/node";
import {
  LlmNowError,
  createLlmNowCore,
  type CliExecutionDescriptor,
  type CliExecutionResolver,
  type LlmNowCoreClient,
  type LlmNowOperation,
} from "@swartzrock/llm-now-core";
import { spawn } from "node:child_process";
import crossSpawn from "cross-spawn";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import {
  CredentialVaultError,
  adaptCredentialResolverForCore,
  createSensitiveValueRegistry,
  type CredentialResolver,
  type ResolvedCredential,
  type SensitiveValueRegistry,
} from "./credentials.ts";
import {
  preflightWorkspace,
  workspacePathVariants,
  type WorkspaceConfig,
} from "./workspace.ts";

export type RuntimeStage = "discovery" | "model-list" | "generation";

export class RuntimeStageError extends Error {
  constructor(
    readonly stage: RuntimeStage,
    readonly provider: ByokProviderId | null,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(`${stage}${provider ? ` (${provider})` : ""}: ${message}`);
    this.name = "RuntimeStageError";
  }
}

type FindProviders = typeof findAvailableProviders;
type CreateProvider = typeof createByokNodeProvider;
type CommandRunner = { run(request: LocalCommandRequest): Promise<LocalCommandResult> };
type WorkspaceProvider = "codex-cli" | "claude-cli";
type WorkspaceCommandResolver = (
  command: "codex" | "claude",
  env: ByokEnvironment,
) => Promise<string>;
type WorkspacePreflight = typeof preflightWorkspace;
const CLOUD_PROVIDERS = Object.keys(
  BYOK_PROVIDER_API_KEY_ENV_VARS,
) as ByokCloudProviderId[];

export interface CliExecutionResolverDependencies {
  readonly env: ByokEnvironment;
  readonly platform?: NodeJS.Platform;
  readonly loginShellPathLoader?: LoginShellPathLoader;
}

function isCloudProvider(provider: ByokProviderId): provider is ByokCloudProviderId {
  return CLOUD_PROVIDERS.includes(provider as ByokCloudProviderId);
}

export interface RuntimeGatewayDependencies {
  env: ByokEnvironment;
  findProviders?: FindProviders;
  createProvider?: CreateProvider;
  workspaceRunner?: CommandRunner;
  workspaceCommandResolver?: WorkspaceCommandResolver;
  workspaceLoginShellPathLoader?: LoginShellPathLoader;
  workspacePreflight?: WorkspacePreflight;
  credentialResolver: CredentialResolver;
  sensitive: SensitiveValueRegistry;
  coreClient?: LlmNowCoreClient;
}

export interface RuntimeGateway {
  discover(): Promise<ByokProviderId[]>;
  listModels(provider: ByokProviderId): Promise<ByokModelOption[]>;
  validateCredential(
    provider: ByokCloudProviderId,
    apiKey: string,
  ): Promise<ByokModelOption[]>;
  generate(
    provider: ByokProviderId,
    model: string | null,
    prompt: string,
    signal?: AbortSignal,
    instructions?: string,
    workspace?: WorkspaceConfig,
    onChunk?: (chunk: string) => void | Promise<void>,
  ): Promise<string>;
}

type StreamingProviderRuntime = ByokProviderRuntime & {
  streamText(
    input: { prompt: string; instructions?: string },
    signal?: AbortSignal,
  ): { textStream: AsyncIterable<string> };
};

function supportsStreaming(runtime: ByokProviderRuntime): runtime is StreamingProviderRuntime {
  return typeof (runtime as Partial<StreamingProviderRuntime>).streamText === "function";
}

async function providerConfig(
  provider: ByokProviderId,
  model: string | null,
  resolveCredential: (provider: ByokCloudProviderId) => Promise<ResolvedCredential>,
): Promise<ByokProviderConfig> {
  if (isCloudProvider(provider)) {
    const credential = await resolveCredential(provider);
    if (credential.source === "missing") {
      const names = BYOK_PROVIDER_API_KEY_ENV_VARS[provider].join(" or ");
      throw new Error(`missing credential; set ${names}`);
    }
    if (credential.source === "unavailable") {
      const names = BYOK_PROVIDER_API_KEY_ENV_VARS[provider].join(" or ");
      throw new Error(`native credential storage unavailable on this target; set ${names}`);
    }
    return { provider, apiKey: credential.apiKey, model: model ?? "" };
  }

  switch (provider) {
    case "ollama":
    case "lm-studio":
      return { provider, model: model ?? "" };
    case "codex-cli":
      return {
        provider,
        command: "codex",
        ...(model === null ? {} : { model }),
      };
    case "claude-cli":
      return {
        provider,
        command: "claude",
        ...(model === null ? {} : { model }),
      };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactInstruction(text: string, instructions: string | undefined): string {
  if (instructions === undefined) return text;

  const serialized = JSON.stringify(instructions);
  const escaped = serialized.slice(1, -1);
  const transportEscaped = JSON.stringify(escaped).slice(1, -1);
  return createSensitiveValueRegistry([
    instructions,
    serialized,
    escaped,
    transportEscaped,
  ]).redact(text);
}

function redactWorkspace(text: string, workspaces: readonly (WorkspaceConfig | undefined)[]): string {
  const values = workspaces.flatMap((workspace) =>
    workspace === undefined ? [] : workspacePathVariants(workspace)
  );
  return values.length === 0 ? text : createSensitiveValueRegistry(values).redact(text);
}

function runtimeStageError(
  stage: RuntimeStage,
  provider: ByokProviderId | null,
  error: unknown,
  sensitive: SensitiveValueRegistry,
  instructions?: string,
  workspaces: readonly (WorkspaceConfig | undefined)[] = [],
): RuntimeStageError {
  return new RuntimeStageError(
    stage,
    provider,
    sensitive.redact(redactWorkspace(redactInstruction(errorMessage(error), instructions), workspaces)),
    error instanceof CredentialVaultError ? error : undefined,
  );
}

class WorkspaceCommandRunner implements CommandRunner {
  constructor(
    private readonly provider: WorkspaceProvider,
    private readonly additionalDirectories: readonly string[],
    private readonly directoryAccess: WorkspaceConfig["directoryAccess"],
    private readonly runner: CommandRunner,
  ) {}

  run(request: LocalCommandRequest): Promise<LocalCommandResult> {
    const args = request.args === undefined ? undefined : [...request.args];
    if (args !== undefined && this.isGeneration(args)) {
      request = {
        ...request,
        args: this.provider === "codex-cli"
          ? this.codexArgs(args)
          : this.claudeArgs(args),
      };
    }
    return this.runner.run(request);
  }

  private isGeneration(args: readonly string[]): boolean {
    return this.provider === "codex-cli" ? args[0] === "exec" : args[0] === "-p";
  }

  private codexArgs(args: string[]): string[] {
    const sandbox = args.indexOf("--sandbox");
    if (sandbox === -1 || sandbox + 1 >= args.length) {
      throw new Error("Codex CLI workspace runtime did not expose a sandbox mode");
    }
    args[sandbox + 1] = this.directoryAccess === "read-write"
      ? "workspace-write"
      : "read-only";
    return [
      args[0]!,
      ...this.additionalDirectoryArgs(),
      ...args.slice(1),
    ];
  }

  private claudeArgs(args: string[]): string[] {
    const tools = args.indexOf("--tools");
    if (tools === -1 || tools + 1 >= args.length) {
      throw new Error("Claude CLI workspace runtime did not expose a tool allowlist");
    }
    args[tools + 1] = "Read,Glob,Grep";
    return [...args, ...this.additionalDirectoryArgs()];
  }

  private additionalDirectoryArgs(): string[] {
    return this.additionalDirectories.flatMap((directory) => ["--add-dir", directory]);
  }
}

function workspaceProvider(provider: ByokProviderId): WorkspaceProvider {
  if (provider === "codex-cli" || provider === "claude-cli") return provider;
  throw new Error(`provider ${provider} does not support alias workspaces`);
}

function commandCandidates(command: "codex" | "claude", env: ByokEnvironment): string[] {
  if (process.platform !== "win32") return [command];
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  return extensions.map((extension) => `${command}${extension}`);
}

const LOGIN_SHELL_PATH_MARKER = "__LLM_NOW_LOGIN_SHELL_PATH__";
const LOGIN_SHELL_PATH_TIMEOUT_MS = 3_000;
const LOGIN_SHELL_PATH_MAX_CHARS = 65_536;

function parseLoginShellPath(stdout: string): string {
  const escapedMarker = LOGIN_SHELL_PATH_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = stdout.matchAll(
    new RegExp(`${escapedMarker}([\\s\\S]*?)${escapedMarker}`, "g"),
  );
  let path = "";
  for (const match of matches) path = match[1]?.trim() ?? "";
  return path;
}

function createLoginShellPathLoader(platform: NodeJS.Platform): LoginShellPathLoader {
  let cachedLoginShellPath: string | undefined;
  let pendingLoginShellPath: Promise<string> | undefined;
  return (env: NodeJS.ProcessEnv): Promise<string> => {
    if (platform === "win32") return Promise.resolve("");
    if (cachedLoginShellPath !== undefined) return Promise.resolve(cachedLoginShellPath);
    if (pendingLoginShellPath !== undefined) return pendingLoginShellPath;

    pendingLoginShellPath = new Promise((resolve) => {
      const configuredShell = env.SHELL?.trim();
      const fallbackShell = platform === "darwin" ? "/bin/zsh" : "/bin/sh";
      const shell = configuredShell !== undefined && isAbsolute(configuredShell)
        ? configuredShell
        : fallbackShell;
      const child = spawn(
        shell,
        ["-l", "-c", `printf '\\n${LOGIN_SHELL_PATH_MARKER}%s${LOGIN_SHELL_PATH_MARKER}\\n' "$PATH"`],
        { env, shell: false, stdio: ["ignore", "pipe", "ignore"] },
      );
      let stdout = "";
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (path: string) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (path !== "") cachedLoginShellPath = path;
        pendingLoginShellPath = undefined;
        resolve(path);
      };
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (stdout.length > LOGIN_SHELL_PATH_MAX_CHARS) {
          child.kill("SIGTERM");
          settle("");
        }
      });
      child.once("error", () => settle(""));
      child.once("close", (code) => settle(code === 0 ? parseLoginShellPath(stdout) : ""));
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        settle("");
      }, LOGIN_SHELL_PATH_TIMEOUT_MS);
    });
    return pendingLoginShellPath;
  };
}

const loadLoginShellPath = createLoginShellPathLoader(process.platform);

function mergePathValues(...paths: string[]): string {
  const seen = new Set<string>();
  return paths
    .flatMap((path) => path.split(delimiter))
    .map((directory) => directory.trim())
    .filter((directory) => {
      if (directory === "" || seen.has(directory)) return false;
      seen.add(directory);
      return true;
    })
    .join(delimiter);
}

async function resolveWorkspaceCommand(
  command: "codex" | "claude",
  env: ByokEnvironment,
  loginShellPathLoader: LoginShellPathLoader = loadLoginShellPath,
): Promise<string> {
  const environmentPath = env.PATH ?? env.Path ?? env.path ?? "";
  const pathValue = mergePathValues(await loginShellPathLoader(env), environmentPath);
  const directories = pathValue
    .split(delimiter)
    .map((directory) => directory.trim())
    .filter(isAbsolute);
  for (const directory of directories) {
    for (const candidate of commandCandidates(command, env)) {
      const executable = join(directory, candidate);
      try {
        await access(executable, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        if ((await stat(executable)).isFile()) return await realpath(executable);
      } catch {
        // Try the next trusted PATH entry.
      }
    }
  }
  throw new Error(`${command} was not found in an absolute PATH directory`);
}

function exactChildEnvironment(env: ByokEnvironment): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  ));
}

function recognizedCredentialValues(env: ByokEnvironment): readonly string[] {
  return Object.freeze([...new Set(BYOK_API_KEY_ENV_VARS.flatMap((name) => {
    const value = env[name];
    return typeof value === "string" && value.length > 0 ? [value] : [];
  }))]);
}

export function createCliExecutionResolver(
  deps: CliExecutionResolverDependencies,
): CliExecutionResolver {
  const platform = deps.platform ?? process.platform;
  const loginShellPathLoader = deps.loginShellPathLoader
    ?? createLoginShellPathLoader(platform);
  const descriptorCache = new Map<ByokProviderId, CliExecutionDescriptor>();
  const env = exactChildEnvironment(deps.env);
  const responseSensitiveValues = recognizedCredentialValues(deps.env);

  const resolver: CliExecutionResolver = {
    async resolve(provider, signal) {
      const cached = descriptorCache.get(provider);
      if (cached !== undefined) return cached;
      signal?.throwIfAborted();
      const command = provider === "codex-cli" ? "codex" : "claude";
      const executable = await resolveWorkspaceCommand(
        command,
        deps.env,
        loginShellPathLoader,
      );
      signal?.throwIfAborted();
      let descriptor: CliExecutionDescriptor;
      if (platform === "win32" && executable.toLowerCase().endsWith(".cmd")) {
        const configuredProcessor = deps.env.ComSpec ?? deps.env.COMSPEC;
        const systemRoot = deps.env.SystemRoot ?? deps.env.SYSTEMROOT;
        const processor = configuredProcessor
          ?? (systemRoot === undefined ? undefined : join(systemRoot, "System32", "cmd.exe"));
        if (processor === undefined || !isAbsolute(processor)) return null;
        descriptor = Object.freeze({
          mode: "windows-command-shim",
          commandProcessor: await realpath(processor),
          shim: executable,
          argsPrefix: Object.freeze([]),
          env,
          responseSensitiveValues,
        });
      } else {
        descriptor = Object.freeze({
          mode: "direct",
          executable,
          argsPrefix: Object.freeze([]),
          env,
          responseSensitiveValues,
        });
      }
      descriptorCache.set(provider, descriptor);
      return descriptor;
    },
  };
  return Object.freeze(resolver);
}

function waitForAbort<T>(operation: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  signal?.throwIfAborted();
  const running = operation();
  if (signal === undefined) return running;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    running.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function workspaceRuntime(
  provider: WorkspaceProvider,
  model: string | null,
  workspace: WorkspaceConfig,
  command: string,
  runner: CommandRunner,
): ByokProviderRuntime {
  const wrappedRunner = new WorkspaceCommandRunner(
    provider,
    workspace.additionalDirectories,
    workspace.directoryAccess,
    runner,
  );
  const options = {
    command,
    ...(model === null ? {} : { model }),
    cwd: workspace.primaryDirectory,
    runner: wrappedRunner,
  };
  return provider === "codex-cli"
    ? new CodexCliProvider(options)
    : new ClaudeCliProvider(options);
}

export function createRuntimeGateway(deps: RuntimeGatewayDependencies): RuntimeGateway {
  const findProviders = deps.findProviders ?? findAvailableProviders;
  const createProvider: CreateProvider = deps.createProvider ?? createByokNodeProvider;
  const sensitive = deps.sensitive;
  for (const name of BYOK_API_KEY_ENV_VARS) {
    const value = deps.env[name];
    if (value) sensitive.register(value);
  }
  const credentialResolver = deps.credentialResolver;

  async function resolveCredential(provider: ByokCloudProviderId) {
    const credential = await credentialResolver.resolve(provider);
    if (credential.source === "environment" || credential.source === "vault") {
      sensitive.register(credential.apiKey);
    }
    return credential;
  }

  async function runtime(
    provider: ByokProviderId,
    model: string | null,
  ): Promise<ByokProviderRuntime> {
    return createProvider(await providerConfig(provider, model, resolveCredential));
  }

  return {
    async discover() {
      try {
        const providers = [...await findProviders({ env: deps.env })];
        const available = new Set(providers);
        for (const provider of CLOUD_PROVIDERS) {
          if (available.has(provider)) continue;
          try {
            const credential = await resolveCredential(provider);
            if (credential.source === "environment" || credential.source === "vault") {
              providers.push(provider);
            }
          } catch (error) {
            if (providers.length === 0) throw error;
            break;
          }
        }
        return providers;
      } catch (error) {
        throw runtimeStageError("discovery", null, error, sensitive);
      }
    },

    async listModels(provider) {
      try {
        return await (await runtime(provider, null)).listModels();
      } catch (error) {
        throw runtimeStageError("model-list", provider, error, sensitive);
      }
    },

    async validateCredential(provider, apiKey) {
      sensitive.register(apiKey);
      try {
        return await createProvider({ provider, apiKey, model: "" }).listModels();
      } catch (error) {
        throw runtimeStageError("model-list", provider, error, sensitive);
      }
    },

    async generate(provider, model, prompt, signal, instructions, workspace, onChunk) {
      let verifiedWorkspace: WorkspaceConfig | undefined;
      try {
        signal?.throwIfAborted();
        verifiedWorkspace = workspace === undefined
          ? undefined
          : await waitForAbort(
            () => (deps.workspacePreflight ?? preflightWorkspace)(provider, workspace),
            signal,
          );
        signal?.throwIfAborted();
        const command = provider === "codex-cli" ? "codex" : "claude";
        const providerRuntime = verifiedWorkspace === undefined
          ? await runtime(provider, model)
          : workspaceRuntime(
            workspaceProvider(provider),
            model,
            verifiedWorkspace,
            await waitForAbort(
              () => deps.workspaceCommandResolver === undefined
                ? resolveWorkspaceCommand(
                  command,
                  deps.env,
                  deps.workspaceLoginShellPathLoader,
                )
                : deps.workspaceCommandResolver(command, deps.env),
              signal,
            ),
            deps.workspaceRunner ?? new LocalCommandRunner(
              crossSpawn as LocalProcessSpawner,
              deps.env,
            ),
          );
        signal?.throwIfAborted();
        const input = {
          prompt,
          ...(instructions === undefined ? {} : { instructions }),
        };
        if (onChunk === undefined) {
          return (await providerRuntime.generateText(input, signal)).text;
        }
        if (!supportsStreaming(providerRuntime)) {
          throw new Error("installed @swartzrock/byok-runtime does not support text streaming");
        }

        let response = "";
        for await (const chunk of providerRuntime.streamText(input, signal).textStream) {
          response += chunk;
          await onChunk(chunk);
        }
        return response;
      } catch (error) {
        throw runtimeStageError(
          "generation",
          provider,
          error,
          sensitive,
          instructions,
          [workspace, verifiedWorkspace],
        );
      }
    },
  };
}

function coreStage(operation: LlmNowOperation): RuntimeStage {
  if (operation === "discovery") return "discovery";
  if (operation === "model-list" || operation === "validation") return "model-list";
  return "generation";
}

interface CliCoreOperationContext {
  credentialProvider?: ByokCloudProviderId;
  credentialStatus?: "missing" | "unavailable";
  vaultError?: CredentialVaultError;
}

function clearCoreOperationContext(context: CliCoreOperationContext): void {
  context.credentialProvider = undefined;
  context.credentialStatus = undefined;
  context.vaultError = undefined;
}

function rethrowCoreError(
  error: unknown,
  fallbackStage: RuntimeStage,
  provider: ByokProviderId | null,
  context: CliCoreOperationContext,
  responseMode?: "buffered" | "streaming",
): never {
  if (error instanceof LlmNowError) {
    const stage = coreStage(error.operation);
    const errorProvider = error.provider ?? provider;
    if (context.vaultError !== undefined) {
      throw new RuntimeStageError(
        stage,
        errorProvider,
        context.vaultError.message,
        context.vaultError,
      );
    }
    if (
      error.code === "CREDENTIAL_UNAVAILABLE"
      && context.credentialProvider !== undefined
      && context.credentialStatus !== undefined
    ) {
      const names = BYOK_PROVIDER_API_KEY_ENV_VARS[context.credentialProvider].join(" or ");
      const message = context.credentialStatus === "missing"
        ? `missing credential; set ${names}`
        : `native credential storage unavailable on this target; set ${names}`;
      throw new RuntimeStageError(stage, errorProvider, message);
    }
    if (error.code === "UNSAFE_RESPONSE") {
      if (responseMode === "buffered") {
        throw new Error("generation: response withheld because it contained a registered credential.");
      }
      if (responseMode === "streaming") {
        throw new RuntimeStageError(
          "generation",
          errorProvider,
          "response stream stopped because it contained a registered credential",
        );
      }
    }
    throw new RuntimeStageError(
      stage,
      errorProvider,
      error.message,
    );
  }
  throw new RuntimeStageError(fallbackStage, provider, "The core operation failed safely.");
}

export function createCoreRuntimeGateway(deps: RuntimeGatewayDependencies): RuntimeGateway {
  const adaptedCredentialResolver = adaptCredentialResolverForCore(deps.credentialResolver);
  const cliExecutionResolver = createCliExecutionResolver({
    env: deps.env,
    loginShellPathLoader: deps.workspaceLoginShellPathLoader,
  });
  const operationCore = (context: CliCoreOperationContext): LlmNowCoreClient =>
    deps.coreClient ?? createLlmNowCore({
      environment: deps.env,
      credentialResolver: {
        async resolve(provider, signal) {
          try {
            const resolution = await adaptedCredentialResolver.resolve(provider, signal);
            if (resolution.status === "resolved") {
              deps.sensitive.register(resolution.credential);
            } else {
              context.credentialProvider = provider;
              context.credentialStatus = resolution.status;
            }
            return resolution;
          } catch (error) {
            if (error instanceof CredentialVaultError) context.vaultError = error;
            throw error;
          }
        },
      },
      cliExecutionResolver,
    });

  const gateway: RuntimeGateway = {
    async discover() {
      const context: CliCoreOperationContext = {};
      try {
        const result = await operationCore(context).discoverProviders();
        return result.providers
          .filter(({ available }) => available)
          .map(({ provider }) => provider);
      } catch (error) {
        rethrowCoreError(error, "discovery", null, context);
      } finally {
        clearCoreOperationContext(context);
      }
    },
    async listModels(provider) {
      const context: CliCoreOperationContext = {};
      try {
        return [...(await operationCore(context).listModels({ provider })).models];
      } catch (error) {
        rethrowCoreError(error, "model-list", provider, context);
      } finally {
        clearCoreOperationContext(context);
      }
    },
    async validateCredential(provider, apiKey) {
      const context: CliCoreOperationContext = {};
      deps.sensitive.register(apiKey);
      try {
        return [...(await operationCore(context).validateConnection({
          provider,
          candidateCredential: apiKey,
        })).models];
      } catch (error) {
        rethrowCoreError(error, "model-list", provider, context);
      } finally {
        clearCoreOperationContext(context);
      }
    },
    async generate(provider, model, prompt, signal, instructions, workspace, onChunk) {
      const context: CliCoreOperationContext = {};
      try {
        const request = {
          provider,
          model,
          prompt,
          ...(instructions === undefined ? {} : { instructions }),
          ...(workspace === undefined ? {} : { workspace }),
          ...(signal === undefined ? {} : { signal }),
          responseSensitiveValues: recognizedCredentialValues(deps.env),
        };
        return onChunk === undefined
          ? (await operationCore(context).generateText(request)).text
          : (await operationCore(context).streamText(request, onChunk)).text;
      } catch (error) {
        rethrowCoreError(
          error,
          "generation",
          provider,
          context,
          onChunk === undefined ? "buffered" : "streaming",
        );
      } finally {
        clearCoreOperationContext(context);
      }
    },
  };
  return Object.freeze(gateway);
}

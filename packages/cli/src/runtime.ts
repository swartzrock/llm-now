import {
  BYOK_PROVIDER_API_KEY_ENV_VARS,
  type ByokCloudProviderId,
  type ByokEnvironment,
  type ByokModelOption,
  type ByokProviderId,
} from "@swartzrock/byok-runtime";
import {
  type LoginShellPathLoader,
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
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import {
  CredentialVaultError,
  adaptCredentialResolverForCore,
  recognizedEnvironmentCredentialValues,
  type CredentialResolver,
  type SensitiveValueRegistry,
} from "./credentials.ts";
import {
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

export interface CliExecutionResolverDependencies {
  readonly env: ByokEnvironment;
  readonly platform?: NodeJS.Platform;
  readonly loginShellPathLoader?: LoginShellPathLoader;
}

export interface RuntimeGatewayDependencies {
  env: ByokEnvironment;
  workspaceLoginShellPathLoader?: LoginShellPathLoader;
  credentialResolver: CredentialResolver;
  sensitive: SensitiveValueRegistry;
  coreClient?: LlmNowCoreClient;
}

export interface RuntimeGateway {
  discover(signal?: AbortSignal): Promise<ByokProviderId[]>;
  listModels(provider: ByokProviderId, signal?: AbortSignal): Promise<ByokModelOption[]>;
  validateCredential(
    provider: ByokCloudProviderId,
    apiKey: string,
    signal?: AbortSignal,
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

function commandCandidates(
  command: "codex" | "claude",
  env: ByokEnvironment,
  platform: NodeJS.Platform,
): string[] {
  if (platform !== "win32") return [command];
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

function mergePathValues(separator: string, ...paths: string[]): string {
  const seen = new Set<string>();
  return paths
    .flatMap((path) => path.split(separator))
    .map((directory) => directory.trim())
    .filter((directory) => {
      if (directory === "" || seen.has(directory)) return false;
      seen.add(directory);
      return true;
    })
    .join(separator);
}

async function resolveWorkspaceCommand(
  command: "codex" | "claude",
  env: ByokEnvironment,
  loginShellPathLoader: LoginShellPathLoader = loadLoginShellPath,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const environmentPath = env.PATH ?? env.Path ?? env.path ?? "";
  const pathValue = mergePathValues(
    pathDelimiter,
    await loginShellPathLoader(env),
    environmentPath,
  );
  const directories = pathValue
    .split(pathDelimiter)
    .map((directory) => directory.trim())
    .filter(isAbsolute);
  for (const directory of directories) {
    for (const candidate of commandCandidates(command, env, platform)) {
      const executable = join(directory, candidate);
      try {
        await access(executable, platform === "win32" ? constants.F_OK : constants.X_OK);
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

export function createCliExecutionResolver(
  deps: CliExecutionResolverDependencies,
): CliExecutionResolver {
  const platform = deps.platform ?? process.platform;
  const loginShellPathLoader = deps.loginShellPathLoader
    ?? createLoginShellPathLoader(platform);
  const descriptorCache = new Map<ByokProviderId, CliExecutionDescriptor>();
  const env = exactChildEnvironment(deps.env);
  const responseSensitiveValues = recognizedEnvironmentCredentialValues(env, platform);

  const resolver: CliExecutionResolver = {
    async resolve(provider, signal) {
      const cached = descriptorCache.get(provider);
      if (cached !== undefined) return cached;
      signal?.throwIfAborted();
      const command = provider === "codex-cli" ? "codex" : "claude";
      const executable = await resolveWorkspaceCommand(
        command,
        env,
        loginShellPathLoader,
        platform,
      );
      signal?.throwIfAborted();
      let descriptor: CliExecutionDescriptor;
      if (platform === "win32" && executable.toLowerCase().endsWith(".cmd")) {
        const configuredProcessor = env.ComSpec ?? env.COMSPEC;
        const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
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

function coreStage(operation: LlmNowOperation): RuntimeStage {
  if (operation === "discovery") return "discovery";
  if (operation === "model-list" || operation === "validation") return "model-list";
  return "generation";
}

interface CliCoreOperationContext {
  credentialProvider?: ByokCloudProviderId;
  credentialStatus?: "missing" | "unavailable";
  diagnostic?: string;
  vaultError?: CredentialVaultError;
}

function clearCoreOperationContext(context: CliCoreOperationContext): void {
  context.credentialProvider = undefined;
  context.credentialStatus = undefined;
  context.diagnostic = undefined;
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
      context.diagnostic ?? error.message,
    );
  }
  throw new RuntimeStageError(
    fallbackStage,
    provider,
    context.diagnostic ?? "The core operation failed safely.",
  );
}

export function createCoreRuntimeGateway(deps: RuntimeGatewayDependencies): RuntimeGateway {
  const adaptedCredentialResolver = adaptCredentialResolverForCore(deps.credentialResolver);
  const responseSensitiveValues = recognizedEnvironmentCredentialValues(deps.env);
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
    async discover(signal) {
      const context: CliCoreOperationContext = {};
      try {
        const result = await operationCore(context).discoverProviders({
          ...(signal === undefined ? {} : { signal }),
          onDiagnostic: (diagnostic) => { context.diagnostic = diagnostic; },
        });
        return result.providers
          .filter(({ available }) => available)
          .map(({ provider }) => provider);
      } catch (error) {
        rethrowCoreError(error, "discovery", null, context);
      } finally {
        clearCoreOperationContext(context);
      }
    },
    async listModels(provider, signal) {
      const context: CliCoreOperationContext = {};
      try {
        return [...(await operationCore(context).listModels({
          provider,
          ...(signal === undefined ? {} : { signal }),
          onDiagnostic: (diagnostic) => { context.diagnostic = diagnostic; },
        })).models];
      } catch (error) {
        rethrowCoreError(error, "model-list", provider, context);
      } finally {
        clearCoreOperationContext(context);
      }
    },
    async validateCredential(provider, apiKey, signal) {
      const context: CliCoreOperationContext = {};
      deps.sensitive.register(apiKey);
      try {
        return [...(await operationCore(context).validateConnection({
          provider,
          candidateCredential: apiKey,
          ...(signal === undefined ? {} : { signal }),
          onDiagnostic: (diagnostic) => { context.diagnostic = diagnostic; },
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
          responseSensitiveValues,
          onDiagnostic: (diagnostic: string) => { context.diagnostic = diagnostic; },
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

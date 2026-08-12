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
  type LocalCommandRequest,
  type LocalCommandResult,
} from "@swartzrock/byok-runtime/node";
import {
  CredentialVaultError,
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
const CLOUD_PROVIDERS = Object.keys(
  BYOK_PROVIDER_API_KEY_ENV_VARS,
) as ByokCloudProviderId[];

function isCloudProvider(provider: ByokProviderId): provider is ByokCloudProviderId {
  return CLOUD_PROVIDERS.includes(provider as ByokCloudProviderId);
}

export interface RuntimeGatewayDependencies {
  env: ByokEnvironment;
  findProviders?: FindProviders;
  createProvider?: CreateProvider;
  workspaceRunner?: CommandRunner;
  credentialResolver: CredentialResolver;
  sensitive: SensitiveValueRegistry;
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
  ): Promise<string>;
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
    private readonly provider: "codex-cli" | "claude-cli",
    private readonly additionalDirectories: readonly string[],
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
    return [
      args[0]!,
      ...this.additionalDirectoryArgs(),
      ...args.slice(1),
    ];
  }

  private claudeArgs(args: string[]): string[] {
    const tools = args.indexOf("--tools");
    if (tools !== -1 && tools + 1 < args.length) args[tools + 1] = "Read,Glob,Grep";
    return [...args, ...this.additionalDirectoryArgs()];
  }

  private additionalDirectoryArgs(): string[] {
    return this.additionalDirectories.flatMap((directory) => ["--add-dir", directory]);
  }
}

function workspaceRuntime(
  provider: ByokProviderId,
  model: string | null,
  workspace: WorkspaceConfig,
  runner: CommandRunner,
): ByokProviderRuntime {
  const wrappedRunner = new WorkspaceCommandRunner(
    provider as "codex-cli" | "claude-cli",
    workspace.additionalDirectories,
    runner,
  );
  const options = {
    command: provider === "codex-cli" ? "codex" : "claude",
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

    async generate(provider, model, prompt, signal, instructions, workspace) {
      let verifiedWorkspace: WorkspaceConfig | undefined;
      try {
        signal?.throwIfAborted();
        verifiedWorkspace = workspace === undefined
          ? undefined
          : await preflightWorkspace(provider, workspace);
        signal?.throwIfAborted();
        const providerRuntime = verifiedWorkspace === undefined
          ? await runtime(provider, model)
          : workspaceRuntime(
            provider,
            model,
            verifiedWorkspace,
            deps.workspaceRunner ?? new LocalCommandRunner(),
          );
        signal?.throwIfAborted();
        const result = await providerRuntime.generateText(
          {
            prompt,
            ...(instructions === undefined ? {} : { instructions }),
          },
          signal,
        );
        return result.text;
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

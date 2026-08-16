import type {
  ByokCliProviderId,
  ByokCloudProviderId,
  ByokEnvironment,
  ByokModelOption,
  ByokProviderId,
} from "@swartzrock/byok-runtime";

export type ProviderId = ByokProviderId;
export type CloudProviderId = ByokCloudProviderId;
export type CliProviderId = ByokCliProviderId;
export type EnvironmentSnapshot = ByokEnvironment;
export type ModelOption = ByokModelOption;

export type ProviderFamily = "cloud" | "local" | "cli";

export type DiagnosticHandler = (diagnostic: string) => void | Promise<void>;

export type ProviderUnavailabilityReason =
  | "credential-missing"
  | "credential-unavailable"
  | "credential-resolution-failed"
  | "connection-unavailable"
  | "execution-unavailable";

export interface ProviderAvailability {
  readonly provider: ProviderId;
  readonly family: ProviderFamily;
  readonly available: boolean;
  readonly reason?: ProviderUnavailabilityReason;
}

export interface ProviderDiscoveryResult {
  readonly providers: readonly ProviderAvailability[];
  readonly degraded: boolean;
}

export interface ProviderDiscoveryRequest {
  readonly onDiagnostic?: DiagnosticHandler;
  readonly signal?: AbortSignal;
}

export interface ModelListRequest {
  readonly provider: ProviderId;
  readonly onDiagnostic?: DiagnosticHandler;
  readonly signal?: AbortSignal;
}

export interface ModelListResult {
  readonly provider: ProviderId;
  readonly models: readonly ModelOption[];
}

export interface ValidateConnectionRequest {
  readonly provider: ProviderId;
  readonly candidateCredential?: string;
  readonly onDiagnostic?: DiagnosticHandler;
  readonly signal?: AbortSignal;
}

export interface ValidationResult {
  readonly provider: ProviderId;
  readonly models: readonly ModelOption[];
}

export interface GenerateTextRequest {
  readonly provider: ProviderId;
  readonly model: string | null;
  readonly prompt: string;
  readonly instructions?: string;
  readonly workspace?: WorkspaceRequest;
  readonly responseSensitiveValues?: readonly string[];
  readonly onDiagnostic?: DiagnosticHandler;
  readonly signal?: AbortSignal;
}

export interface GenerateTextResult {
  readonly provider: ProviderId;
  readonly model: string | null;
  readonly text: string;
}

export type TextStreamDelivery = "native" | "buffered";

export type TextDeltaHandler = (delta: string) => void | Promise<void>;

export interface StreamTextResult extends GenerateTextResult {
  readonly delivery: TextStreamDelivery;
}

export type DirectoryAccess = "read-only" | "read-write";

export interface WorkspaceRequest {
  readonly primaryDirectory: string;
  readonly additionalDirectories: readonly string[];
  readonly directoryAccess: DirectoryAccess;
}

export interface WorkspaceCapabilities {
  readonly primaryDirectory: boolean;
  readonly additionalDirectories: boolean;
  readonly readWrite: boolean;
}

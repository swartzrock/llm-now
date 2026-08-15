import type { CloudProviderId } from "./types.ts";

export type CredentialResolution =
  | Readonly<{ status: "resolved"; credential: string }>
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "unavailable" }>;

export interface CredentialResolver {
  resolve(provider: CloudProviderId, signal?: AbortSignal): Promise<CredentialResolution>;
}

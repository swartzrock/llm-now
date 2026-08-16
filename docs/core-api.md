# Headless core API

`@swartzrock/llm-now-core` is the ESM-only library behind `llm-now`. It supports
Node 20 or later and Bun 1.3.14 or later. Import only the package root; deep
imports are not public.

```bash
npm install "https://github.com/swartzrock/llm-now/releases/download/core-vX.Y.Z/swartzrock-llm-now-core-X.Y.Z.tgz"
# or: bun add "https://github.com/swartzrock/llm-now/releases/download/core-vX.Y.Z/swartzrock-llm-now-core-X.Y.Z.tgz"
```

Replace every `X.Y.Z` with one exact version from a GitHub core Release and
commit the lockfile. Never use a floating latest-Release URL for the core.
Before installing, follow the checksum, action-attestation, and
immutable-Release verification in the
[package README](../packages/core/README.md). The package manifest's
`private: true` prevents npm publication, while the source and GitHub Release
assets remain public. Its transitive dependencies may still come from your
package manager's configured registries.

The package exports these runtime values: `createLlmNowCore`, `LlmNowError`,
`RoutingInputError`, `compactRoutingKey`, `routeTranscript`, `routingSimilarity`, and
`workspaceCapabilities`.

It exports these TypeScript types:

- client: `LlmNowCoreClient`, `LlmNowCoreDependencies`;
- errors: `LlmNowErrorCode`, `LlmNowOperation`;
- credentials and CLI execution: `CredentialResolution`, `CredentialResolver`,
  `CliExecutionDescriptor`, `CliExecutionResolver`,
  `DirectCliExecutionDescriptor`, `WindowsCommandShimExecutionDescriptor`;
- routing: `RouteMatch`, `RouteMatchReason`, `RouteRejection`,
  `RouteRejectionReason`, `RouteTranscriptInput`, `RouteTranscriptResult`, and
  `RoutingCandidate`; and
- providers and requests: `CliProviderId`, `CloudProviderId`, `ProviderId`,
  `ProviderFamily`, `ProviderAvailability`, `ProviderUnavailabilityReason`,
  `ProviderDiscoveryRequest`, `ProviderDiscoveryResult`, `ModelListRequest`,
  `ModelListResult`, `ValidateConnectionRequest`, `ValidationResult`,
  `GenerateTextRequest`, `GenerateTextResult`, `StreamTextResult`,
  `TextStreamDelivery`, `TextDeltaHandler`, `DiagnosticHandler`, `ModelOption`,
  `EnvironmentSnapshot`, `DirectoryAccess`, `WorkspaceRequest`, and
  `WorkspaceCapabilities`.

## Create a client

Create the client in a trusted host process. Pass an explicit environment
snapshot and a caller-owned credential resolver. The core does not read
`process.env`, configuration files, native secret stores, or the network during
import or construction.

```ts
import {
  createLlmNowCore,
  type CloudProviderId,
  type CredentialResolver,
  type EnvironmentSnapshot,
} from "@swartzrock/llm-now-core";

const environment: EnvironmentSnapshot = Object.freeze({ ...process.env });
const variableFor: Readonly<Record<CloudProviderId, string>> = Object.freeze({
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  deepinfra: "DEEPINFRA_TOKEN",
});

const credentialResolver: CredentialResolver = {
  async resolve(provider, signal) {
    signal?.throwIfAborted();
    const value = environment[variableFor[provider]];
    return typeof value === "string" && value.trim() !== ""
      ? { status: "resolved", credential: value }
      : { status: "missing" };
  },
};

const core = createLlmNowCore({ environment, credentialResolver });
const result = await core.generateText({
  provider: "openai",
  model: "gpt-5-mini",
  prompt: "Summarize the request.",
});
```

The example is one possible host policy. A desktop application can instead
resolve credentials from its own native process and native store. See the
[security contract](core-security.md) before implementing a resolver.

## Operations and credentials

The client has five operations. All take an optional `AbortSignal`; all except
streaming return one frozen result. `streamText` also takes an `onTextDelta`
callback and returns the complete final text with a `native` or `buffered`
delivery label.

| Method | Operation | Cloud credential rule | Local provider rule | CLI provider rule |
| --- | --- | --- | --- | --- |
| `discoverProviders` | `discovery` | Call the credential resolver for each cloud provider | Probe connections | Use only the optional CLI execution resolver; without it CLI providers are unavailable |
| `listModels` | `model-list` | Resolver only | No credential | Approved CLI execution descriptor required |
| `validateConnection` | `validation` | candidate-or-resolver: use `candidateCredential` when supplied, otherwise call the resolver once | No credential; a candidate is invalid | Approved CLI execution descriptor required; a candidate is invalid |
| `generateText` | `generation` | Resolver only | No credential | Approved CLI execution descriptor required |
| `streamText` | `streaming` | Resolver only | No credential | Approved CLI execution descriptor required |

No fallback occurs after a supplied candidate fails validation. The core does
not inspect another credential source, and it does not cache credentials.
Each operation resolves what it needs for that invocation. A resolver returns
`resolved`, `missing`, or `unavailable`; an exception or malformed resolution
becomes `CREDENTIAL_RESOLUTION_FAILED`.

## Streaming, cancellation, and cleanup

`streamText` awaits each `onTextDelta` call before requesting or delivering the
next delta. This is the callback backpressure contract. If a provider has no
native stream, the core buffers generation, checks the complete response, calls
the handler once, and reports `delivery: "buffered"`.

The rule is that cancellation wins over a pending or never-settling delta handler. After abort,
the operation emits no later delta, drains a later callback rejection, requests
iterator cleanup, and terminates approved CLI work. A callback failure without
cancellation becomes `DELTA_HANDLER_FAILED`. The complete text returned by a
successful stream equals the concatenated delivered text.

| Work at failure or cancellation | Cleanup before settlement |
| --- | --- |
| Discovery or non-CLI provider work | Abort linked work and perform a bounded drain |
| Approved CLI listing, validation, or generation | Signal the child, escalate termination when needed, and wait for child close |
| Native stream | Abort provider work, call the iterator's return path, and drain pending work |
| Pending delta callback | Let cancellation settle the operation; drain a later callback rejection and emit no later delta |

Implement a host timeout by aborting the signal. Treat the resulting core
`ABORTED` error as the host's timeout result; do not translate it to a provider
or internal failure.

```ts
import { LlmNowError } from "@swartzrock/llm-now-core";

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 15_000);
try {
  await core.generateText({
    provider: "ollama",
    model: "llama3",
    prompt: "Summarize this.",
    signal: controller.signal,
  });
} catch (error) {
  if (error instanceof LlmNowError && error.code === "ABORTED") {
    // Report the host timeout or cancellation.
  } else {
    throw error;
  }
} finally {
  clearTimeout(timeout);
}
```

## Routing caller-owned candidates

`routeTranscript` is pure. It accepts the transcript, stable candidate IDs,
canonical names, alternate spoken names, caller-supplied wake words and fuzzy
thresholds, and an optional default candidate ID. It returns an accepted
candidate ID, extracted question, reason, similarity values, matched name, wake
word, and question offset, or a structured rejection. It does not read
configuration, invoke speech, or call a provider.

```ts
const route = routeTranscript({
  transcript: "hey panel, ask the skeptic about risk",
  candidates: [
    { id: "skeptic", canonicalName: "Skeptic", alternateSpokenNames: ["the skeptic"] },
    { id: "builder", canonicalName: "Builder" },
  ],
  wakeWords: ["hey panel"],
  minFuzzyPhraseLength: 4,
  minSimilarity: 85,
  minMargin: 8,
});
```

The `llm-now` CLI adapts its persisted aliases into these generic candidates.
Talk Show characters remain separate: Talk Show owns their IDs, names, routing
policy, and speech settings. Talk Show does not read or synchronize llm-now's
configuration. Routing never implies voice selection; each caller applies its
own speech behavior after a match.

Structured routing rejections describe well-formed requests that do not route.
Malformed routing input instead throws the public, catchable
`RoutingInputError`. Catch it separately from `LlmNowError`, which is reserved
for client operations.

## Workspace support

Use `workspaceCapabilities(provider)` before sending a `WorkspaceRequest`.
Codex CLI supports a primary directory, additional directories, and read-write
access. Claude CLI supports the same directory list read-only. Other providers
do not support workspaces. The core canonicalizes and checks every requested
directory before credentials, CLI execution, or provider construction.

## Public Error Contract

For client operations, catch only `LlmNowError`. Its enumerable data is `code`,
`operation`, and an optional allowlisted `provider`. Its message is fixed. It
has no public cause and does not retain the unknown provider failure. These are
the only permitted codes for each operation, in precedence order:

| Operation | Allowed codes |
| --- | --- |
| `discovery` | `INVALID_REQUEST`, `CREDENTIAL_RESOLUTION_FAILED`, `DISCOVERY_FAILED`, `ABORTED`, `INTERNAL_ERROR` |
| `model-list` | `INVALID_REQUEST`, `PROVIDER_UNAVAILABLE`, `CREDENTIAL_UNAVAILABLE`, `CREDENTIAL_RESOLUTION_FAILED`, `EXECUTION_UNAVAILABLE`, `MODEL_LIST_FAILED`, `ABORTED`, `INTERNAL_ERROR` |
| `validation` | `INVALID_REQUEST`, `PROVIDER_UNAVAILABLE`, `CREDENTIAL_UNAVAILABLE`, `CREDENTIAL_RESOLUTION_FAILED`, `EXECUTION_UNAVAILABLE`, `VALIDATION_FAILED`, `ABORTED`, `INTERNAL_ERROR` |
| `generation` | `INVALID_REQUEST`, `PROVIDER_UNAVAILABLE`, `CREDENTIAL_UNAVAILABLE`, `CREDENTIAL_RESOLUTION_FAILED`, `EXECUTION_UNAVAILABLE`, `WORKSPACE_UNAVAILABLE`, `GENERATION_FAILED`, `ABORTED`, `UNSAFE_RESPONSE`, `INTERNAL_ERROR` |
| `streaming` | `INVALID_REQUEST`, `PROVIDER_UNAVAILABLE`, `CREDENTIAL_UNAVAILABLE`, `CREDENTIAL_RESOLUTION_FAILED`, `EXECUTION_UNAVAILABLE`, `WORKSPACE_UNAVAILABLE`, `GENERATION_FAILED`, `ABORTED`, `UNSAFE_RESPONSE`, `DELTA_HANDLER_FAILED`, `INTERNAL_ERROR` |

| Code | Fixed message |
| --- | --- |
| `INVALID_REQUEST` | The request is invalid. |
| `PROVIDER_UNAVAILABLE` | The provider is unavailable. |
| `CREDENTIAL_UNAVAILABLE` | A required credential is unavailable. |
| `CREDENTIAL_RESOLUTION_FAILED` | Credential resolution failed. |
| `EXECUTION_UNAVAILABLE` | CLI execution is unavailable. |
| `WORKSPACE_UNAVAILABLE` | The requested workspace is unavailable. |
| `DISCOVERY_FAILED` | Provider discovery failed. |
| `MODEL_LIST_FAILED` | Model listing failed. |
| `VALIDATION_FAILED` | Connection validation failed. |
| `GENERATION_FAILED` | Text generation failed. |
| `ABORTED` | The operation was aborted. |
| `UNSAFE_RESPONSE` | The provider response was withheld. |
| `DELTA_HANDLER_FAILED` | The text delta handler failed. |
| `INTERNAL_ERROR` | The core operation failed safely. |

Invalid input fails before work. Workspace checks precede credentials and CLI
execution. An observed abort takes precedence over concurrent callback or
provider failure. Diagnostic callback failures never replace the primary
outcome.

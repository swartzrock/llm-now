# Headless core security contract

`@swartzrock/llm-now-core` is for a trusted host process. It is not a sandbox
or a credential broker. Import it only in a server, CLI process, desktop main
process, or another process that already has authority to call providers.
Never expose its resolver objects or provider methods directly to untrusted UI
code. A desktop renderer must send a narrow, validated request to its native
host; the native host owns credentials, provider access, routing policy, and
text-to-speech.

## Explicit authority

The host supplies an immutable environment snapshot and a `CredentialResolver`.
The core never reads `process.env`, `HOME`, XDG paths, config files, or native
credential stores. It never invokes `Bun.secrets`. The `llm-now` vault service
identity and all `Bun.secrets` add, replace, and delete behavior are strictly
CLI-owned and are not accessible through the core package.

For a Talk Show integration, implement the resolver in Talk Show's native
process and use Talk Show's own native store. Do not read the llm-now vault,
copy its service identity, expose a general credential endpoint to the
renderer, or place a credential in character data. Talk Show also applies its
own character voices through its native TTS implementation.

The resolver follows the operation matrix in the [API contract](core-api.md#operations-and-credentials).
It returns one result for the requested provider and signal. The core performs
no implicit fallback and keeps no credential cache.

## Approved CLI execution

CLI-provider authority is optional and caller-owned. A `CliExecutionResolver`
must return an approved descriptor with absolute paths, a fixed argument prefix,
and the exact child environment. Do not derive a command from `PATH`, `SHELL`,
`COMSPEC`, a login shell, or ambient command discovery.

Direct execution names one approved executable. The core adds provider
arguments and always spawns with `shell: false`:

```ts
const cliExecutionResolver = {
  async resolve(provider: "codex-cli" | "claude-cli") {
    if (provider !== "codex-cli") return null;
    return {
      mode: "direct" as const,
      executable: "/opt/approved/bin/codex",
      argsPrefix: ["exec"],
      env: Object.freeze({ LANG: "C.UTF-8" }),
      responseSensitiveValues: [],
    };
  },
};
```

On Windows, approve both the canonical command processor and the exact `.cmd`
shim. Do not search for either path:

```ts
const descriptor = {
  mode: "windows-command-shim" as const,
  commandProcessor: "C:\\Windows\\System32\\cmd.exe",
  shim: "C:\\approved\\codex.cmd",
  argsPrefix: ["exec"],
  env: Object.freeze({ SystemRoot: "C:\\Windows" }),
  responseSensitiveValues: [],
};
```

The core validates those paths, uses fixed escaping and
`windowsVerbatimArguments`, and still spawns with `shell: false`. It passes only
the descriptor's `env`, not a merge with the core process environment. The host
must put every recognized credential in that approved child environment into
`responseSensitiveValues`, even when it is not the credential selected for the
current provider.

## Response and diagnostic safety scopes

Safety has two distinct scopes:

- A **response-sensitive** value is blocked from model text and model metadata.
  This set includes each resolved or candidate cloud credential, every value
  supplied by `GenerateTextRequest.responseSensitiveValues`, and every value in
  an approved CLI descriptor's `responseSensitiveValues`. Each such value is
  also diagnostic-sensitive.
- A **diagnostic-sensitive** value is redacted only from best-effort diagnostic
  callback text. Prompts, instructions, and canonical workspace paths enter
  this scope. They are valid provider input and can appear in a successful
  model response; response filtering does not treat them as secrets unless the
  host also lists them as response-sensitive.

Buffered output is checked before delivery and is entirely withheld as
`UNSAFE_RESPONSE` on a match. Streaming checks matches across chunk boundaries,
but already-delivered deltas cannot be retracted. If a later delta completes a
sensitive value, the stream stops with `UNSAFE_RESPONSE`; the host must treat
the earlier text as irrevocably delivered. Do not use streaming when policy
requires inspection of the complete response before any disclosure.

The core also strips terminal escape sequences and unsafe control characters.
This safety layer is not a general data-loss-prevention system. The host remains
responsible for authorization, provider retention policy, logs, analytics,
renderer IPC, persistence, and TTS output.

## Cancellation and cleanup

Pass an `AbortSignal` for user cancellation and host timeouts. The core maps an
observed abort to `ABORTED`, stops delta delivery, drains late provider and
handler rejections, closes an active iterator, and terminates approved CLI
children. A CLI operation does not report completion until its child is reaped.
Do not race the core promise against a separate timeout and abandon it; abort
the supplied controller and await settlement.

See the [Public Error Contract](core-api.md#public-error-contract) for the closed
error taxonomy and cleanup precedence.

# Credentials

This guide explains API-key precedence, interactive management, native record
behavior, compiled-target support, platform prerequisites, and recovery when a
native credential store is unavailable. For installation and first use, return
to the [README](../README.md).

## Credential precedence

Recognized environment variables are always authoritative. They are the
recommended source for scripts, automation, containers, remote sessions, and
other headless use. For each cloud provider, `llm-now` uses the first nonempty
recognized value in this order:

| Provider | Environment variables, in precedence order |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Gemini | `GOOGLE_API_KEY`, then `GEMINI_API_KEY` |
| xAI | `XAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| DeepInfra | `DEEPINFRA_TOKEN` |

When no recognized environment credential is set, an enabled release target
may use one provider-specific fallback from the operating system's native
credential store. A disabled target does not read the native store.

`llm-now --help` lists the recognized environment-variable names and says that
keys can also be stored through the interactive launcher. Platform-specific
storage requirements and recovery guidance live in this guide, not in help.

## Add, replace, or delete a stored key

Run the bare command in an interactive terminal, choose
`Manage connections…`, then `Add or manage API keys…`. Select a cloud provider
to add, replace, or delete its stored fallback.

API keys are entered through hidden terminal input. `llm-now` validates a
candidate with the selected provider before asking
`Save this verified <provider> API key?`; the save confirmation defaults to No.
Keys are never accepted through command-line arguments or generation stdin.

When a record already exists, management offers `Replace saved API key` and
`Delete saved API key`:

- Replacement requires a second confirmation, also defaulting to No. The old
  record remains in place until the replacement has been validated and saved.
- Deletion requires confirmation defaulting to No. It removes only the native
  record. An active environment credential remains available and continues to
  take precedence.

Shortcut creation's `Add a provider with an API key…` route lists only eligible
providers that currently lack both an environment credential and a stored
fallback. It can add a missing key, then continue through model selection and
required shortcut creation. Replacement and deletion remain management
operations. If later shortcut creation is cancelled after the key is saved,
the stored key remains; the command reports the completed write and exits
without generation.

Credential mutations for the same provider are serialized and re-check the
record before writing. A concurrent change fails closed instead of overwriting
or deleting the newer value.

## Native record format and security boundary

For each cloud provider, `llm-now` creates at most one native credential record
under the service `llm-now`, using this non-secret record name:

```text
api-key:<provider>
```

For example, OpenAI uses `api-key:openai`. The API key itself is passed to the
operating system's credential API. `llm-now` does not write it to `config.toml`
or another configuration file. Encryption, locking, and access control are
delegated to the native credential service for the logged-in user.

Saved shortcut records contain no API keys or credential identifiers. Optional
shortcut instructions are plaintext configuration rather than credential
storage; see the [configuration guide](configuration.md).

There is no plaintext or self-encrypted credential fallback. A native-store
failure does not cause `llm-now` to save the key elsewhere.

## Compiled-target policy

Native storage is capability-gated per compiled release target. The target and
pinned Bun version must both match the tested policy exactly.

| Compiled target | Native store | Bun 1.3.14 policy |
| --- | --- | --- |
| macOS ARM64 | Keychain | Enabled after compiled lifecycle gate |
| macOS x64 | Keychain | Environment-only; Bun 1.3.14 failed the compiled lifecycle gate |
| Linux x64 / ARM64 glibc | Secret Service | Enabled after compiled lifecycle gate; requires an available user-session service |
| Windows x64 baseline | Credential Manager | Enabled after compiled lifecycle gate |

If native storage is not enabled for the current target, setup performs no
credential-store read and directs you to the selected provider's environment
variable instead.

### macOS Keychain

On the enabled macOS ARM64 release target, the native record is stored in the
current user's macOS Keychain. Keychain owns encrypted storage and user-session
access controls. `llm-now` retrieves a record only when a command needs that
provider and no recognized environment variable is set.

The macOS x64 release target is environment-only under the Bun 1.3.14 policy.

### Linux Secret Service

On enabled Linux x64 and ARM64 glibc targets, the native record is stored
through Secret Service in the current user's D-Bus session. GNOME Keyring and
KWallet are common providers. A Secret Service provider must be running and
unlocked; a Linux kernel or desktop package alone is not enough.

Minimal containers, servers, SSH sessions, WSL sessions, and locked desktops
may not expose a usable Secret Service. Use an environment credential in these
contexts unless you deliberately provide an unlocked user-session service.

### Windows Credential Manager

On the enabled Windows x64 baseline target, the native record is stored through
Credential Manager. If the compiled target does not match the tested policy,
use the provider's environment variable instead.

## Recover when native storage is unavailable

If Linux Secret Service is unavailable, `llm-now` reports the failure without
exposing backend detail and does not save the key elsewhere. Choose one of
these recovery paths:

1. Set a recognized environment variable for the current shell. In bash or
   zsh, enter the primary value without echoing, then retry in that shell:

   ```bash
   read -r -s OPENAI_API_KEY && export OPENAI_API_KEY
   ```

   Replace `OPENAI_API_KEY` with the variable for your provider. Gemini also
   recognizes `GEMINI_API_KEY` after `GOOGLE_API_KEY`.
2. Start or unlock a Secret Service provider such as GNOME Keyring or KWallet
   in the current user session, then retry the command that failed.

On other platforms, a native-store failure reports the provider-specific
environment variable to use for that process. On macOS and other Unix shells,
the diagnostic also provides the same `read -r -s … && export …` pattern.

Provider discovery and API-key management use the same recovery guidance.
On Linux, unavailable native storage appears with colored `Error:` and `Tip:`
headings in an interactive terminal; `NO_COLOR` and non-terminal output remain
plain.

## Failure and privacy behavior

Credential resolution reads a native record only when no recognized
environment credential is present. Stored values may be cached for the current
invocation and are invalidated after a credential mutation.

Candidate, environment, and stored credential values are registered for
diagnostic redaction. Native backend details are not exposed in the user-facing
error. A generated response that contains a registered credential is withheld
instead of being written or spoken.

Native-store and missing-credential failures exit `1`. Declining a save or
delete confirmation is a completed action and exits `0`. Cancelling before a
durable write exits `130`; completed key writes are preserved if a later
shortcut step is cancelled or fails.

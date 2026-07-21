---
title: Friendly Secret Service Failure Copy - Plan
type: fix
date: 2026-07-20
topic: friendly-secret-service-errors
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: legacy-requirements
origin: docs/ideation/2026-07-16-llm-now-secure-api-key-onboarding-ideation.html
execution: code
deepened: 2026-07-20
---

# Friendly Secret Service Failure Copy - Plan

## Goal Capsule

- **Objective:** Replace Linux's implementation-shaped credential-vault failure with concise, human copy that explains secure storage is unavailable and gives two safe recovery paths.
- **Authority:** The “Friendly Secret Service Failure Copy” section in the origin ideation artifact defines the product direction and rejected claims.
- **Execution profile:** One focused implementation phase on the existing native-gates branch and pull request.
- **Stop conditions:** Do not expose backend causes, claim a Secret Service provider is absent, prescribe a universal daemon command, imply a failed write/delete left durable state unchanged, or introduce a plaintext persistence path.

---

## Product Contract

### Problem

When Bun's Linux Secret Service integration rejects a credential operation, `llm-now` currently leads with internal vocabulary such as `credential vault get (openrouter): unavailable`. Users need to know what capability is unavailable and how to proceed safely without being asked to diagnose a normalized backend failure.

### Requirements

- R1. On Linux, a normalized credential-vault failure must lead with: `Secure API-key storage isn’t available in this Linux session.`
- R2. The message must offer a temporary current-shell path using the exact provider-specific environment variable and the existing Bash/zsh hidden-input command.
- R3. The message must offer a durable path that tells the user to start or unlock a Secret Service provider, names GNOME Keyring and KWallet as examples, scopes it to the user session, and tells the user to retry the command that failed.
- R4. The raw `credential vault get/set/delete (<provider>): unavailable` text and backend cause must not appear in Linux user output.
- R5. Get, set, delete, and runtime-wrapped credential errors must retain exit status `1` and use the same sanitized Linux recovery structure.
- R6. Non-Linux behavior and the separate disabled-target message remain unchanged.
- R7. The message must describe the failed action in product language—accessing a saved key, saving a key securely, or completing saved-key removal—without exposing internal get/set/delete vocabulary or claiming a durable outcome.

### Acceptance Examples

- AE1. A direct OpenRouter get failure prints the Linux headline, `OPENROUTER_API_KEY`, the hidden Bash/zsh command, and both recovery paths; it does not print the raw vault diagnostic, an inline secret assignment, or the backend cause.
- AE2. OpenAI set and delete failures use the same structure with `OPENAI_API_KEY` and never claim that no durable state changed.
- AE3. A runtime-wrapped OpenRouter get failure produces the same sanitized output, tells the user to retry the failed command after recovery, and exits `1`.
- AE4. The temporary-key path says the value is not saved by `llm-now`, instructs the user to retry in the current shell, and does not claim the exported value is restricted to one process.
- AE5. Get, set, and delete failures each render their matching human action line; the delete wording says removal could not be completed rather than asserting whether the saved value remains.

### Scope Boundaries

#### In scope

- Static Linux terminal copy in the existing application error formatter.
- Focused application tests for direct get/set/delete and runtime-wrapped errors.

#### Out of scope

- Interactive recovery menus, automatic retry, support/error codes, backend-cause classification, distribution-specific setup commands, vault preflight checks, or changes to credential storage and resolution.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Lead with the capability boundary** (session-settled: user-directed — chosen over `credential vault get/set/delete (<provider>): unavailable`: users need a high-level explanation rather than an internal API failure).
- KTD2. **Describe unavailability without diagnosing absence** (session-settled: user-approved — chosen over “No Linux Secret Service provider found”: a normalized failure cannot distinguish absent, stopped, locked, denied, disabled, unreachable, or failed providers).
- KTD3. **Offer two explicit recovery paths** (session-settled: user-directed — chosen over a single generic remediation paragraph: users should be able either to continue with a provider key now or restore secure saved credentials).
- KTD4. **Use hidden shell input with the provider's real environment variable** (session-settled: user-directed — chosen over an inline `ENV=value llm-now` example: the secret must not be placed directly in shell history, and provider metadata already supplies the correct variable).
- KTD5. **Keep the change static and localized** (session-settled: user-approved — chosen over an interactive recovery menu or support code: the requested first step is friendlier copy with deterministic exit behavior).
- KTD6. **Do not state an indeterminate durable outcome** (session-settled: user-approved — chosen over “no key was saved or changed”: a rejected set/delete operation does not prove whether durable state changed).
- KTD7. **Preserve operation context in product language** (session-settled: user-approved — chosen over dropping operation context or retaining raw get/set/delete vocabulary: the typed operation can explain what the user was doing without exposing internals or guessing the durable result).

### Implementation Approach

Keep `CredentialVaultError` as the typed, sanitized internal boundary. Update only `credentialVaultUnavailableMessage` in `src/app.ts` so Linux replaces `error.message` with a fixed human headline, maps the typed operation to one careful human action line, and groups its existing provider-specific environment guidance into two labeled recovery paths. Continue to derive environment names from `BYOK_PROVIDER_API_KEY_ENV_VARS`, use the first recognized variable in the hidden-input command, and omit `error.cause` entirely. Preserve the current formatter on macOS and Windows.

### Sources and Grounding

- Existing application boundary: `src/app.ts` recognizes both direct and runtime-wrapped `CredentialVaultError` instances and sends them through one diagnostic formatter with exit status `1`.
- Existing storage boundary: `src/credentials.ts` normalizes get, set, and delete rejections while preserving typed operation/provider metadata and keeping the backend error in `cause`.
- [Bun Secrets documentation](https://bun.sh/docs/runtime/secrets): Linux uses libsecret with Secret Service implementations such as GNOME Keyring and KWallet; a daemon must be running and a locked keyring may need an unlock prompt. Bun does not document a stable Linux error taxonomy for distinguishing those states.
- [Secret Service specification](https://specifications.freedesktop.org/secret-service/latest-single/): the service and sessions are scoped to the caller's D-Bus login session, while locking, prompting, and access policy vary by implementation.
- [Bash manual](https://www.gnu.org/software/bash/manual/bash.html) and [zsh builtins](https://zsh.sourceforge.io/Doc/Release/Shell-Builtin-Commands.html): `read -r -s` is appropriate when explicitly labeled for Bash/zsh interactive terminal entry.

### Delivery Strategy

- **Phase 1:** Implement the formatter and tests on `codex/secure-api-key-native-gates`, then commit, push, update the existing pull request, and verify CI.

---

## Implementation Units

### U1. Render friendly Linux Secret Service recovery copy

- **Goal:** Give Linux users a clear failure explanation and two safe next actions without overclaiming the backend state.
- **Requirements:** R1-R7; AE1-AE5.
- **Files:** `src/app.ts`; `tests/app.test.ts`.
- **Approach:** For Linux, render the fixed headline, map get/set/delete to careful user-action wording, add a “Use a key now (not saved by llm-now)” lane with the provider-specific environment variable and Bash/zsh hidden-input command, add a current-shell retry instruction, then add a “To save API keys securely” lane with portable Secret Service guidance and an instruction to retry the failed command. Leave non-Linux formatting untouched.
- **Test scenarios:** Direct set/get/delete errors each use the correct human action line; runtime-wrapped get error; exact provider environment variables; raw typed error and hostile backend cause absent; inline secret assignment absent; exit status remains `1`; disabled-target behavior unaffected.
- **Verification:** `bun test tests/app.test.ts`; `bun run typecheck`; `bun run check`.

---

## Verification Contract

### Automated gates

- `bun test tests/app.test.ts`
- `bun run typecheck`
- `bun run check`

### Manual acceptance

In a Linux runtime without an available Secret Service session, run the compiled executable through a credential-backed flow and confirm the terminal shows the high-level headline and both recovery paths. Confirm that it does not show the raw vault diagnostic or any backend D-Bus/GTK cause, and that the process exits `1`.

### Security assertions

- No API-key value is added to argv, command examples, output, files, or error causes.
- The temporary environment value is entered with shell echo disabled and is explicitly described as not saved by `llm-now`.
- The error does not infer provider absence or promise an unchanged durable result.

---

## Definition of Done

- Linux direct get, set, and delete failures and runtime-wrapped get failures use the friendly recovery message and exit `1`.
- Each operation retains useful context in product language without implying the set/delete outcome.
- Provider-specific environment guidance remains exact and safe for Bash/zsh.
- Raw internal vault diagnostics and backend causes are absent from user output.
- Non-Linux and disabled-target behavior are unchanged.
- Focused and full repository checks pass.
- The plan and origin ideation update ship with the implementation on the existing pull request.

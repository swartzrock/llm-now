# llm-now

## 2.2.0

### Minor Changes

- 5b31c09: Add optional saved shortcut instructions that are sent separately on every shortcut invocation.

## 2.1.0

### Minor Changes

- 52fce1a: Add first-class shortcut creation from available or newly credentialed providers, save the shortcut before its same-invocation first run, and make run once generate without offering to save.

## 2.0.0

### Major Changes

- 2e1745d: Make aliases ASCII case-insensitive while keeping spelling exact. Saved aliases
  are canonical lowercase. Same-target case-only entries in legacy alias files
  collapse in memory and are persisted canonically on the next successful save;
  different-target conflicts fail closed with an actionable repair diagnostic.

### Minor Changes

- c7c3e95: Make bare interactive launch adaptive: run saved shortcuts or freshly selected models in the same invocation, while keeping provider and API-key management in a separate route.
- dc39189: Prompt once for input when a saved alias is invoked interactively without `--input`.
- ac7c6ab: Add `llm-now --aliases` to print a sorted human-readable inventory of saved
  aliases with provider labels and configured or provider-default models.

## 1.0.0

### Major Changes

- d3bf2dd: Added operating-system-backed API-key storage and guided setup for macOS and Linux.

  Run bare `llm-now` to add, replace, or delete one saved fallback key per cloud provider. Keys are entered through hidden terminal input and verified with the provider before they are saved. Recognized environment variables remain authoritative, so scripts, CI, containers, and other headless sessions can continue to supply credentials without reading the native store.

  - On supported macOS builds, `llm-now` stores provider keys in the current user's macOS Keychain.
  - On Linux glibc builds, `llm-now` uses the Secret Service available in the current user D-Bus session, such as GNOME Keyring or KWallet. The service must be running and unlocked.

  Keys are never written to the alias file or another plaintext configuration file, and there is no self-encrypted fallback when native storage is unavailable. `llm-now --help` now explains the credential store used by the current platform. Credential-management and provider-discovery failures also show the same actionable guidance: use the provider's environment variable for the current shell, or start and unlock a Linux Secret Service provider before retrying.

## 0.2.1

### Patch Changes

- 78b9a9a: Simplify generated release notes by removing download verification instructions.

## 0.2.0

### Minor Changes

- c713fb9: Add reviewed Changesets release automation for protected cross-platform binaries.

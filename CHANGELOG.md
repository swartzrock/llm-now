# llm-now

## 2.4.0

### Minor Changes

- 44cbe30: Add composable native voice routing and speech. `--voice-route` maps one
  dictated transcript to a saved alias and question on every supported platform,
  while macOS-only `--speak` adds concise speech guidance and speaks the validated
  answer instead of writing it to stdout. They combine for a two-action global
  Shortcut and `--speak` also works with ordinary alias or provider/model
  selection. Optional per-alias voice, rate, and validated baseline-pitch
  settings remain available without Python, uv, a repository checkout, or
  clipboard mutation. Native input reads the file-backed stdin supplied by macOS
  Shortcuts directly, without a `/bin/cat` adapter. Retain the locked uv-managed
  Python example as an independent combined routing and speech oracle for
  contributors.
- 40e0b5a: Unify aliases and voice settings in one editable, versioned `config.toml` with
  cross-platform path discovery, explicit or automatic legacy migration,
  recoverable backups, sparse canonical rewrites, and configurable voice-routing
  thresholds. Keep installed execution native and Python-free while retaining the
  Python voice-router example as an independent contributor parity oracle.

## 2.3.0

### Minor Changes

- 57c6768: Add request-scoped behavioral instructions for alias and explicit provider/model runs.

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

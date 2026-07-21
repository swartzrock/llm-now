# llm-now

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

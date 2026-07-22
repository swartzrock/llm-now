# README proof-first decision

Status: selected for implementation on 2026-07-21.

## Direction

Combine the “Proof-first narrative” structure with the headline “A tiny CLI for the local models you already run.” The first viewport should make the product understandable and credible before installation detail begins.

## First-viewport order

1. Repository name and dynamic status badges.
2. The selected product promise.
3. One real, provider-neutral command with all required context inside the prompt.
4. A compact Truth Bar covering native releases, passive discovery, credential handling, and clean stdout.

## Accuracy constraints

- `llm-now` passes plain prompt text; it does not give providers repository or working-directory context.
- The proof prompt uses port `5432`, not Ollama's default `11434`, so an Ollama-backed demonstration is not self-contradictory.
- The release badge displays the current version dynamically, and installation snippets resolve the latest release instead of hardcoding it.
- Environment credentials remain authoritative. Native credential storage is a fallback only on enabled targets.
- macOS ARM64 uses Keychain; macOS x64 is environment-only under the current compiled lifecycle policy.
- Linux glibc targets use an available, unlocked Secret Service such as GNOME Keyring or KWallet.
- Successful generation writes only the model response to stdout; interactive UI and diagnostics use stderr.
- Installation stays concise: link to the latest release, identify the correct platform/architecture suffixes, and retain only material trust or compatibility caveats.

## Deferred assets

A recorded terminal demo, logo, and social-preview image remain separate launch assets. The README structure must work without them.

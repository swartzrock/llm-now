# llm-now

`llm-now` makes one text-generation call through an LLM provider already available on your machine. It uses [`@swartzrock/byok-runtime`](https://github.com/swartzrock/byok-runtime) for discovery, model listing, and generation; it does not install providers or store credentials.

## Development

```bash
bun install --frozen-lockfile
bun run index.ts --help
bun test
bun run typecheck
```

Native binaries are built for the supported platforms but are not published yet. Source development currently requires Bun 1.3.14.

Use the [manual testing guide](docs/manual-testing.md) to validate native artifacts, provider integrations, aliases, and release candidates.

## Distribution status

The repository builds and tests self-contained archives for macOS x64/ARM64, glibc Linux x64/ARM64, and Windows x64. Each archive contains one executable and is covered by the release checksum manifest.

Homebrew and Chocolatey integration is intentionally deferred. A custom Homebrew tap and a Chocolatey package may be added in a future version if adoption justifies their ongoing maintenance; neither package manager is part of the current CI or release workflow.

Release candidates are started manually with the `Release candidate` GitHub Actions workflow and an existing `v<package-version>` tag reachable from `main`. Its default `publish: false` path builds unsigned artifacts without publishing anything. The `publish: true` path additionally requires reviewer approval for both protected environments:

- `release-signing`: Apple signing identity, base64 PKCS#12 certificate and password, notarization Apple ID/team/app password, plus a base64 Windows PFX certificate and password
- `release-publication`: final approval to create the GitHub Release after native signing and asset validation pass

The macOS CI executable is ad-hoc signed so its code signature is structurally valid, but an unsigned `publish: false` artifact is not Apple-notarized. After verifying its checksum, macOS testers must remove browser quarantine as described in the [manual testing guide](docs/manual-testing.md). A `publish: true` release must pass Gatekeeper without that workaround.

The repository owner must configure those environments with required reviewers and protect release tags from mutation. Every release job checks out the commit SHA established by the initial tag/version/main-ancestry gate, and publication rechecks that the tag still resolves to that SHA. Missing credentials fail the authorized signing job with the missing secret's name; they do not weaken pull-request verification or publish partial assets.

## Usage

Choose a discovered provider and model interactively:

```bash
llm-now --input "Write a two-line poem about rain"
```

Use a saved global alias:

```bash
llm-now --input "Summarize this idea" --alias daily
printf 'Explain this diff' | llm-now --alias daily
```

Choose deterministically, including a supported CLI provider's default model:

```bash
llm-now --input "Hello" --provider ollama --model llama3
printf 'Hello' | llm-now --provider claude-cli --model default
```

Exactly one prompt source is required: `--input` or stdin. Non-interactive calls require `--alias` or both `--provider` and `--model`. Successful generation writes the model response, byte-for-byte, to stdout. Menus and diagnostics use stderr.

## Aliases and configuration

After a successful interactive call, `llm-now` offers to save the provider/model selection. Aliases contain no credentials and are available from every working directory.

- macOS/Linux: `$XDG_CONFIG_HOME/llm-now/aliases.json`, otherwise `~/.config/llm-now/aliases.json`
- Windows: `%APPDATA%\\llm-now\\aliases.json`, otherwise `%USERPROFILE%\\AppData\\Roaming\\llm-now\\aliases.json`

Existing aliases require overwrite confirmation. A stale alias fails without selecting a replacement.

## Discovery and diagnostics

Discovery checks already-running Ollama and LM Studio servers, installed `codex` and `claude` commands on `PATH`, and recognized cloud-provider environment variables. A candidate is verified only when selected. Discovery never starts software, downloads models, creates credentials, or changes machine configuration.

If no provider is found, stderr lists every checked provider class and manual setup steps. Runtime failures identify the discovery, model-list, or generation stage. Diagnostic text removes terminal controls, normalizes line endings, bounds runtime detail, and redacts recognized credential values.

Exit codes:

- `0`: successful generation, help, or version (including declined/cancelled post-success alias saving)
- `1`: discovery, model-list, generation, or configuration failure
- `2`: invalid usage
- `130`: interactive provider/model selection cancelled before generation

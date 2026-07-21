# llm-now

`llm-now` makes one text-generation call through an LLM provider already available on your machine. It uses [`@swartzrock/byok-runtime`](https://github.com/swartzrock/byok-runtime) for discovery, model listing, and generation; it does not install providers. On supported release targets, it can store one fallback API key per cloud provider in the operating system's native credential store.

## Install a release

Choose the archive for your machine:

| Platform | Archive | Trust and compatibility |
| --- | --- | --- |
| macOS Intel | `llm-now-v<version>-macos-x64.zip` | Signed and notarized |
| macOS Apple silicon | `llm-now-v<version>-macos-arm64.zip` | Signed and notarized |
| Linux x64 | `llm-now-v<version>-linux-x64.zip` | glibc build; not Alpine/musl |
| Linux ARM64 | `llm-now-v<version>-linux-arm64.zip` | glibc build; not Alpine/musl |
| Windows x64 | `llm-now-v<version>-windows-x64.zip` | **Unsigned early access** |

For macOS, set `TARGET` to `macos-arm64` or `macos-x64`. Download, verify, and extract one archive:

```bash
VERSION=0.1.0
TARGET=macos-arm64
ARCHIVE="llm-now-v${VERSION}-${TARGET}.zip"
BASE="https://github.com/swartzrock/llm-now/releases/download/v${VERSION}"
SOURCE_DIGEST="<release source digest shown in the release notes>"

curl -LO "$BASE/$ARCHIVE" -LO "$BASE/SHA256SUMS"
CHECKSUM="$(grep "  $ARCHIVE$" SHA256SUMS)"
test -n "$CHECKSUM" && printf '%s\n' "$CHECKSUM" | shasum -a 256 -c -
gh attestation verify "$ARCHIVE" --repo swartzrock/llm-now \
  --signer-workflow swartzrock/llm-now/.github/workflows/release.yml \
  --source-digest "$SOURCE_DIGEST"
mkdir -p "$HOME/.local/bin"
unzip -o "$ARCHIVE" -d "$HOME/.local/bin"
chmod +x "$HOME/.local/bin/llm-now"
```

For Linux, set `TARGET` to `linux-x64` or `linux-arm64`. These are glibc builds; Alpine and other musl systems are not supported.

```bash
VERSION=0.1.0
TARGET=linux-x64
ARCHIVE="llm-now-v${VERSION}-${TARGET}.zip"
BASE="https://github.com/swartzrock/llm-now/releases/download/v${VERSION}"
SOURCE_DIGEST="<release source digest shown in the release notes>"

curl -LO "$BASE/$ARCHIVE" -LO "$BASE/SHA256SUMS"
CHECKSUM="$(grep "  $ARCHIVE$" SHA256SUMS)"
test -n "$CHECKSUM" && printf '%s\n' "$CHECKSUM" | sha256sum --check -
gh attestation verify "$ARCHIVE" --repo swartzrock/llm-now \
  --signer-workflow swartzrock/llm-now/.github/workflows/release.yml \
  --source-digest "$SOURCE_DIGEST"
mkdir -p "$HOME/.local/bin"
unzip -o "$ARCHIVE" -d "$HOME/.local/bin"
chmod +x "$HOME/.local/bin/llm-now"
```

The Windows x64 executable is **unsigned early access**. Windows may show a SmartScreen warning and, where policy permits, offer **Run anyway**. Smart App Control or enterprise policy may block the executable with no supported user bypass. Do not disable or weaken security controls to run `llm-now`.

If your policy permits the executable, download and verify it before the first run:

```powershell
$Version = "0.1.0"
$Archive = "llm-now-v$Version-windows-x64.zip"
$Base = "https://github.com/swartzrock/llm-now/releases/download/v$Version"
$SourceDigest = "<release source digest shown in the release notes>"

Invoke-WebRequest "$Base/$Archive" -OutFile $Archive
Invoke-WebRequest "$Base/SHA256SUMS" -OutFile SHA256SUMS
$ChecksumLines = @(Get-Content SHA256SUMS | Where-Object { $_.EndsWith("  $Archive") })
if ($ChecksumLines.Count -ne 1) { throw "Expected one checksum for $Archive" }
$Expected = ($ChecksumLines[0] -split '\s+')[0].ToLowerInvariant()
$Actual = (Get-FileHash $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($Expected -ne $Actual) { throw "SHA-256 mismatch for $Archive" }
"SHA-256 verified: $Actual"
gh attestation verify $Archive --repo swartzrock/llm-now `
  --signer-workflow swartzrock/llm-now/.github/workflows/release.yml `
  --source-digest $SourceDigest
Expand-Archive $Archive -DestinationPath .\llm-now-windows -Force
& .\llm-now-windows\llm-now.exe --help
```

## Usage

Run the bare command in an interactive terminal to open setup:

```bash
llm-now
```

Setup lists saved aliases, discovered providers, and cloud-provider API-key management. API keys are entered through hidden terminal input, authenticated before saving, and never accepted through command-line arguments or generation stdin.

Choose a discovered provider and model interactively:

```bash
llm-now --input "Write a two-line poem about rain"
```

If you have saved aliases, an interactive call offers those first. Choose “Select a new provider and model…” for a fresh selection. Alias, provider, and model lists are sorted and filter as you type.

Use a saved global alias:

```bash
llm-now daily --input "Summarize this idea"
printf 'Explain this diff' | llm-now daily
```

Alias names are exact and case-sensitive. Options may appear before or after the alias,
though the alias-first form above is recommended. The explicit
`--alias daily` form remains available for scripts and for resolving any future command-name
ambiguity.

Choose deterministically, including a supported CLI provider's default model:

```bash
llm-now --input "Hello" --provider ollama --model llama3
printf 'Hello' | llm-now --provider claude-cli --model default
```

Exactly one prompt source is required: `--input` or stdin. Non-interactive calls require a positional alias, `--alias`, or both `--provider` and `--model`. A second positional argument is never treated as prompt text. Successful generation writes the model response, byte-for-byte, to stdout. Interactive UI and diagnostics use stderr, so the response remains safe to redirect or pipe. After an interactive response, stderr resets terminal styling and adds a clean visual boundary without changing stdout.

## Aliases and configuration

After a successful unnamed interactive call, `llm-now` shows a green contextual field such as `Enter an alias name for OpenAI · gpt-3.5 (Enter to exit)`, with the provider and model emphasized. Type a name to save that exact provider/model pair, or press Enter to exit. If the selected provider/model is already saved, it reports the existing alias and suggests an executable command such as `llm-now daily --input "<prompt>"` for next time instead of asking for a duplicate. A call that selected an existing alias does not ask again. Aliases contain no credentials and are available from every working directory.

- macOS/Linux: `$XDG_CONFIG_HOME/llm-now/aliases.json`, otherwise `~/.config/llm-now/aliases.json`
- Windows: `%APPDATA%\\llm-now\\aliases.json`, otherwise `%USERPROFILE%\\AppData\\Roaming\\llm-now\\aliases.json`

Saving the same name and target reports that it is already saved. Reusing a name for a different target requires overwrite confirmation, defaulting to No. A stale alias fails without selecting a replacement.

## API keys

Recognized environment variables are always authoritative. They are the recommended credential source for scripts, automation, and headless systems. When no recognized environment credential is set, an enabled release target may use one provider-specific key from the operating system's native credential store.

Use bare `llm-now` to add, replace, or delete a stored fallback. Replacement verifies the new key before changing the existing record, and save/delete confirmations default to No. Deleting a stored fallback does not remove an active environment credential. Aliases remain version 1 provider/model records and never contain keys or credential identifiers.

Native storage is capability-gated per compiled release target. If it is not enabled for the current target, setup performs no credential-store read and directs you to the provider's environment variable instead. There is no plaintext or self-encrypted fallback.

## Discovery and diagnostics

Discovery checks already-running Ollama and LM Studio servers, installed `codex` and `claude` commands on `PATH`, recognized cloud-provider environment variables, and—on enabled targets—stored cloud-provider fallbacks. A candidate is verified only when selected. Discovery never starts software, downloads models, or changes machine configuration.

If no provider is found, stderr lists every checked provider class and manual setup steps. Runtime failures identify the discovery, model-list, generation, or credential-store operation. Diagnostic text removes terminal controls, normalizes line endings, bounds runtime detail, and redacts recognized environment, stored, and candidate credential values.

Exit codes:

- `0`: successful generation, help, version, or completed/declined setup action (including declined/cancelled post-success alias saving)
- `1`: discovery, model-list, generation, configuration, credential-store, or post-credential alias failure
- `2`: invalid usage
- `130`: interactive setup or alias/provider/model selection cancelled before a durable action

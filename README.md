# llm-now

`llm-now` makes one text-generation call through an LLM provider already available on your machine. It uses [`@swartzrock/byok-runtime`](https://github.com/swartzrock/byok-runtime) for discovery, model listing, and generation; it does not install providers or store credentials.

## Development

```bash
bun install --frozen-lockfile
bun run index.ts --help
bun test
bun run typecheck
```

Native binaries and Homebrew/Chocolatey packages are planned but are not published yet. Source development currently requires Bun 1.3.14.

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

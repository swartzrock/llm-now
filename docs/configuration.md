# Configuration

`llm-now` keeps saved shortcuts and voice settings in one `config.toml` file.
For installation and first use, see the [README](../README.md).

## Edit `config.toml`

The shortest path to the file is:

```bash
llm-now --config-path
```

Open the printed path in a text editor, make your changes, and save it. The next
`llm-now` command reloads the file. If it does not exist yet, run `llm-now` and
save your first shortcut from the launcher.

A later shortcut save may rewrite the entire file in a consistent order. Valid
settings are preserved, but comments and custom formatting may be removed.

## Configure saved shortcuts

Each `[aliases.<name>]` table needs a `provider` and `model`. Add
`instructions` when you want reusable behavior for that shortcut.

```toml
version = 1

[aliases.local]
provider = "ollama"
model = "llama3.1:latest"
instructions = "Answer concisely."

[aliases.codex]
provider = "codex-cli"
model = "default"
```

Common edits include changing the provider or model behind a shortcut, adding
instructions, or using `model = "default"` with `codex-cli` or `claude-cli` to
let the authenticated CLI choose its model.

Supported providers are `ollama`, `lm-studio`, `codex-cli`, `claude-cli`,
`anthropic`, `openai`, `google`, `xai`, `openrouter`, `groq`, `mistral`,
`deepseek`, and `deepinfra`.

Alias names are case-insensitive, may contain up to 64 ASCII letters, digits,
`_`, and `-`, and must begin with a letter or digit. `llm-now` stores them in
lowercase.

Instructions are plaintext. `--instruction` replaces saved instructions for
one request without changing the file. Never put credentials or secrets in
`config.toml`; see the [credentials guide](credentials.md).

## Configure voice

Voice routing uses the same aliases. Add global routing settings under
`[voice]` and speech settings directly to an alias:

```toml
[voice]
wake_words = ["hey", "computer"]

[aliases.local]
provider = "ollama"
model = "llama3.1:latest"
spoken_names = ["local model", "home model"]
voice = "Samantha"
rate = 205
pitch = 50
```

If `aliases.local` already exists, add the new fields to its existing table;
do not create a second table with the same name.

### Common voice changes

- **Recognize alternate names:** add `spoken_names` when dictation produces a
  natural name or alternate pronunciation. For example, `"local model"`
  selects the `local` alias.
- **Change the greeting:** set `wake_words` to one or more phrases. Omit it to
  use `["hey"]`, or set `wake_words = []` to disable wake-word stripping.
- **Customize speech on macOS:** set `voice`, `rate`, or `pitch` on an alias.
  Omitted fields use the current system voice settings.
- **Tune fuzzy matching:** change the optional thresholds only if routing
  repeatedly rejects or confuses a spoken alias.

| Setting | Default | Allowed values |
| --- | --- | --- |
| `min_fuzzy_phrase_length` | `4` | Integer from `1` to `64` |
| `min_similarity` | `65` | Integer from `0` to `100` |
| `min_margin` | `15` | Integer from `0` to `100` |
| `rate` | System setting | Integer from `80` to `500` |
| `pitch` | System setting | Number from `1` to `127` |

Voice routing checks the alias name first, then `spoken_names`, then fuzzy
matches. Ambiguous or weak matches are rejected instead of guessing. Routing
works across supported platforms; `--speak` applies the speech settings on
macOS.

For setup, installed voice lookup, privacy, and troubleshooting, see
[Talk to an llm-now alias from a macOS shortcut](../examples/macos-voice-shortcut.md).

## Rules worth knowing

- The file requires `version = 1` and an aliases table; an empty `[aliases]` is
  valid.
- Unknown fields, invalid values, and conflicting alias or spoken names are
  rejected.
- `spoken_names` must be unique and cannot duplicate another alias or spoken
  name after normalization.
- Generated files omit optional values. Removing an override restores the
  documented default or system behavior.

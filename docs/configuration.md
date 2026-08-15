# Configuration

`llm-now` keeps shared instructions, saved shortcuts, and voice settings in one
`config.toml` file. For installation and first use, see the
[README](../README.md).

## Edit `config.toml`

The shortest path to the file is:

```bash
llm-now --config-path
```

Open the printed path in a text editor, make your changes, and save it. The next
`llm-now` command reloads the file. If it does not exist yet, run `llm-now` and
save your first shortcut from the launcher.

A later shortcut save may rewrite the entire file in a consistent order. Valid
settings, including `shared_instructions`, are preserved, but comments and
custom formatting may be removed.

## Configure instructions shared by aliases

Add optional `shared_instructions` at the root when every saved alias should
start with the same guidance:

```toml
version = 1
shared_instructions = "Be concise and distinguish facts from assumptions."

[aliases.local]
provider = "ollama"
model = "llama3.1:latest"
instructions = "Use examples that fit a local development workflow."
```

For an alias request, shared guidance comes first, followed by a blank line and
the alias's local `instructions`. If only one value exists, it is used exactly
as written. `--instruction` replaces `shared_instructions` for one alias
request, but the alias-local value still follows. Explicit provider/model and
fresh run-once requests do not inherit `shared_instructions`; for those calls,
`--instruction` is the complete one-shot instruction.

Changing this root value affects every saved alias on its next invocation.
Keep shared and local guidance compatible: ordering does not guarantee how a
model resolves contradictory text.

Older `llm-now` versions whose strict version 1 schema predates this setting
reject a file containing `shared_instructions`. Before downgrading, preserve
the text elsewhere, remove the root field, and then run the older binary.

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

Instructions are plaintext. `--instruction` never changes the file. Never put
credentials or secrets in `config.toml`; see the
[credentials guide](credentials.md).

### Configure a shortcut workspace

Codex CLI and Claude CLI shortcuts may store an ordered, nonempty list of
directories:

```toml
[aliases.codex]
provider = "codex-cli"
model = "default"
directories = ["/absolute/project", "/absolute/shared", "/absolute/reference material"]
directory_access = "read-write"
```

`directories` must contain at least one absolute, unique path. The first path is
the CLI working directory. Remaining entries are additional directories, in
their listed order. `directory_access` may be `"read-only"` or `"read-write"`;
omitting it defaults the workspace to read-only. Setting
`directory_access` without `directories` is invalid. Omit `directories` when
the shortcut has no workspace.

Codex supports both access modes. `"read-write"` allows Codex to create, edit,
rename, and delete files in every configured directory, including the first
working directory and every additional root. `"read-only"` keeps the Codex
read-only sandbox. Claude supports only `"read-only"` and receives only the
`Read`, `Glob`, and `Grep` file tools; a Claude `"read-write"` workspace is
rejected. Ollama, LM Studio, and cloud API providers reject workspace fields.

A workspace controls CLI execution context; it does not restrict where the
shortcut is visible or callable. Workspace paths are machine-local plaintext,
and files read from those roots may still be sent to the selected service.
Missing, inaccessible, duplicate, or non-directory roots fail before the prompt
is read or the provider is started. Read-write roots must also be writable.

## Configure voice

Voice routing uses the same aliases. Add global routing settings under
`[voice]` and speech settings directly to an alias:

```toml
[default]
alias = "local"

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

- **Choose a routing fallback:** set `[default] alias = "local"` to use an
  existing alias when no canonical, spoken-name, or fuzzy alias matches. The
  fallback receives the original transcript after any leading wake word.
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
matches. A configured `default.alias` is used only after those stages produce
no match; ambiguous matches and missing questions remain rejected instead of
guessing. `default.alias` must name an alias in the same file. Routing works
across supported platforms; `--speak` applies the speech settings on macOS.

For setup, installed voice lookup, privacy, and troubleshooting, see
[Talk to an llm-now alias from a macOS shortcut](../examples/macos-voice-shortcut.md).

## Rules worth knowing

- The file requires `version = 1` and an aliases table; an empty `[aliases]` is
  valid.
- Unknown fields, invalid values, missing default targets, and conflicting
  alias or spoken names are rejected.
- `spoken_names` must be unique and cannot duplicate another alias or spoken
  name after normalization.
- Generated files omit optional values. Removing an override restores the
  documented default or system behavior.

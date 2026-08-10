# Configuration

This guide describes how `llm-now` saves shortcuts, resolves and validates
`config.toml`, rewrites it, migrates legacy files, and supports deliberate
downgrades. For installation and first use, return to the
[README](../README.md).

## Save and update shortcuts

The launcher's `Create a new shortcut…` route saves a required shortcut before
its first run. The saved record contains a provider, a model, and optional
instructions; it never contains credentials or credential identifiers. Saved
shortcuts are user-global and work from every directory.

Direct interactive provider/model selection retains a separate optional save
flow. After a successful unnamed call, `llm-now` shows a contextual field such
as `Enter an alias name for OpenAI · gpt-3.5 (Enter to exit)`. Enter a name,
then optionally enter visible multiline instructions and use the `[ save ]`
action to persist that provider/model pair. Press Enter at the name field to
exit.

If the selected provider/model is already saved, `llm-now` reports the existing
alias and suggests an executable command such as
`llm-now daily --input "<prompt>"` instead of asking for a duplicate. A launcher
`Run once…` call and a call that selected an existing saved shortcut never
offer this follow-up.

Saving the same alias name, target, and instructions in any capitalization
reports that it is already saved. Recreate a shortcut with the same name to
add, change, or remove its instructions. Any change to its target or
instructions requires overwrite confirmation, which defaults to No. A stale
alias fails without selecting a replacement.

## Locate `config.toml`

All saved-shortcut and voice settings share one versioned TOML file.
Print the exact path without reading or changing application configuration:

```bash
llm-now --config-path
```

The platform paths are:

- macOS and Linux: `$XDG_CONFIG_HOME/llm-now/config.toml` when
  `XDG_CONFIG_HOME` is absolute; otherwise
  `~/.config/llm-now/config.toml`.
- Windows: `%APPDATA%\llm-now\config.toml` when `APPDATA` is absolute;
  otherwise `%USERPROFILE%\AppData\Roaming\llm-now\config.toml`.

Relative `XDG_CONFIG_HOME` and `APPDATA` values are ignored in favor of the
platform fallback. `--config-path` must be used alone. It does not read stdin,
configuration, providers, credentials, or voice state.

## Version 1 format

The closed version 1 grammar requires `version` and an `[aliases]` table, which
may be empty. It accepts an optional global `[voice]` table and one
`[aliases.<name>]` table per alias. Unknown fields are invalid. This example
shows every supported field; these are examples, not generated defaults:

```toml
version = 1

[voice]
wake_words = ["hey", "computer"]
min_fuzzy_phrase_length = 4
min_similarity = 65
min_margin = 15

[aliases.daily]
provider = "openai"
model = "gpt-5"
instructions = "Answer concisely."
spoken_names = ["day lee"]
voice = "Samantha"
rate = 205
pitch = 50.5

[aliases.local]
provider = "codex-cli"
model = "default"
```

### Required alias fields

Every `[aliases.<name>]` table requires:

- `provider`: one of `ollama`, `lm-studio`, `codex-cli`, `claude-cli`,
  `anthropic`, `openai`, `google`, `xai`, `openrouter`, `groq`, `mistral`,
  `deepseek`, or `deepinfra`.
- `model`: a nonblank string. `model = "default"` delegates model choice to
  the authenticated CLI and is valid only for `codex-cli` and `claude-cli`.

Alias names are ASCII case-insensitive, contain at most 64 characters, start
with a letter or digit, and otherwise use only letters, digits, `_`, or `-`.
`llm-now` saves and displays them in lowercase. A unified file cannot define
more than one capitalization of the same name. Legacy same-record variants are
collapsed; conflicting legacy variants are invalid. Names that collide after
routing normalization are also invalid.

### Global voice fields

Every `[voice]` field is optional:

- `wake_words` is a list of unique, nonblank normalized strings. Omit it to use
  `["hey"]`; set it to `[]` to disable wake-word stripping.
- `min_fuzzy_phrase_length` is an integer from `1` through `64`. Omit it to use
  `4`.
- `min_similarity` is an integer from `0` through `100`. Omit it to use `65`.
- `min_margin` is an integer from `0` through `100`. Omit it to use `15`.

### Optional per-alias fields

- `instructions` is a nonblank plaintext string. Ordinary line breaks are
  supported. Tabs, other unsupported control characters, and Unicode line or
  paragraph separators are rejected.
- `spoken_names` lists additional exact spoken names that select this alias
  during voice routing. It is a list of unique, nonblank normalized strings.
  A spoken name cannot collide with another alias's canonical name or spoken
  name. Omit it to use canonical and fuzzy matching only; set it to `[]` for no
  additional spoken names.
- `voice` is a nonblank installed macOS voice name.
- `rate` is an integer from `80` through `500`.
- `pitch` is an integer or fractional number from `1` through `127`, inclusive.

Omitting `voice`, `rate`, or `pitch` lets `/usr/bin/say` inherit the current
system voice, speech rate, or that voice's normal baseline pitch independently.
Voice fields are portable: macOS executes them, while Linux and Windows retain
them across shortcut saves. Route-only execution remains available there,
while `--speak` rejects before reading input or configuration.

The router always tries canonical aliases, then configured `spoken_names`, then
fuzzy matching. Configurable thresholds do not remove its safety gates: fuzzy
candidates must have a compatible length, preserve digit sequences, clear the
minimum similarity, and beat the runner-up by the configured margin. Weak,
tied, and ambiguous input fails closed.

For macOS setup, installed-voice lookup, privacy, and troubleshooting, see
[Talk to a saved shortcut from a macOS keyboard shortcut](../examples/macos-voice-shortcut.md).

## Canonical rewrites and field preservation

A shortcut save rewrites the complete TOML document canonically. It preserves
valid unrelated alias, routing, and speech values, sorts alias tables, fixes
field order, and may remove comments or custom formatting.

Files generated by `llm-now` are deliberately sparse and comment-free. Omitted
wake-word, fuzzy-routing, speech, and example values are not written. Deleting
an override therefore resumes the documented compiled or system behavior
instead of pinning today's value.

Routing and speech may read the selected authority but never create
`config.toml`, migrate legacy files, write a backup, or change configuration.
`--config-path` and the early non-macOS `--speak` rejection do not read
application configuration.

## Instructions and secrets

Instructions are plaintext in `config.toml`. Migration backups are exact
plaintext copies and may contain legacy instructions. Protect the configuration
directory accordingly.

Each shortcut invocation passes its stored instructions to the provider
separately from that invocation's prompt. Explicit provider/model calls and
launcher `Run once…` calls do not inherit shortcut instructions. A
`--instruction` value replaces stored instructions for only that request and is
not written back. Provider behavior, retention, and precedence remain subject
to the selected provider's policies. For CLI-backed providers, instructions may
be transmitted in child-process arguments and therefore visible to local
process inspection or audit tools.

Do not store secrets, credentials, or data you are not permitted to disclose as
shortcut instructions. Recognized credentials and provider authentication stay
outside `config.toml`; see the [credentials guide](credentials.md).

## Authority and legacy compatibility

Until `config.toml` exists, `llm-now` reads the legacy `aliases.json` and
`voice-router.toml` files without changing them. Their paths use the same
platform directory as `config.toml`:

- `$XDG_CONFIG_HOME/llm-now/aliases.json` and
  `$XDG_CONFIG_HOME/llm-now/voice-router.toml` when `XDG_CONFIG_HOME` is
  absolute on macOS or Linux, otherwise the files live under
  `~/.config/llm-now/`;
- `%APPDATA%\llm-now\aliases.json` and
  `%APPDATA%\llm-now\voice-router.toml` when `APPDATA` is absolute on Windows,
  otherwise the files live under
  `%USERPROFILE%\AppData\Roaming\llm-now\`.

Once `config.toml` exists, it is the sole automatic authority. If it is
malformed, invalid UTF-8, unreadable, or uses an unsupported version or field,
configuration-backed commands fail closed instead of falling back to legacy
files or backups.

## Migrate legacy configuration

The next successful shortcut save migrates both legacy stores after any
overwrite approval. To migrate sooner without changing a saved shortcut, run:

```bash
llm-now --migrate-config
```

`--migrate-config` is standalone. Migration validates one coherent snapshot,
creates exact deterministic backups before publishing unified authority, and
leaves the legacy source files in place. The backup filenames are exactly:

- `aliases.json.pre-unified-v1.bak`
- `voice-router.toml.pre-unified-v1.bak`

A missing legacy source produces no backup. If both legacy sources are absent,
explicit migration creates an empty version 1 configuration. Repeating the
command is safe and reports that configuration is already unified, after
validating the existing unified document.

A valid legacy voice profile for a removed alias is not invented as an
incomplete alias. Migration exits successfully and reports all such profile
names once on stderr in sorted order. Profiles attached to active aliases are
migrated with those aliases.

Installed and packaged execution is native and requires no Python, uv, or
repository checkout. The Python example remains a contributor-only independent
parity oracle in the
[`macos-voice-router` example](../examples/macos-voice-router/).

## Deliberate downgrade recovery

An older binary may not understand `config.toml`, and changes made after
migration are not mirrored into legacy files or backups. Prefer installing a
compatible version. If a deliberate downgrade is unavoidable, use the newer
binary to print the path, close other `llm-now` processes, and recover in this
order:

1. Move `config.toml` to a new preserved filename outside the authoritative
   path, such as `config.toml.pre-downgrade`. Do not overwrite an existing moved
   copy.
2. For each backup that exists, copy
   `aliases.json.pre-unified-v1.bak` to `aliases.json` and
   `voice-router.toml.pre-unified-v1.bak` to `voice-router.toml`. A missing
   backup means that legacy source did not exist at migration time and should
   remain absent.
3. Keep the moved unified file. It is the only copy of valid post-migration
   aliases, instructions, routing thresholds, or speech changes. Verify the
   restored files before installing the older binary.

Backups are never restored automatically, and this release has no first-class
recovery command. Move `config.toml` out of authority before copying legacy
backups; otherwise the current binary continues to use the unified document.

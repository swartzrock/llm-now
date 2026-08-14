# CLI reference

This guide is the exact command-line reference for `llm-now`: selection,
input, instructions, voice modifiers, output, diagnostics, and exit behavior.
For installation and the shortest path to a first prompt, return to the
[README](../README.md).

## Invocation forms

```text
llm-now [<alias> | --alias <name>] [--input <text>]
        [--instruction <text>] [--speak]
llm-now --provider <id> --model <id|default> [--input <text>]
        [--instruction <text>] [--speak]
llm-now --voice-route [--input <text>] [--instruction <text>] [--speak]
llm-now --aliases
llm-now --config-path
llm-now --migrate-config
```

Run `llm-now` without arguments in an interactive terminal to open the
launcher. `--help` shows the invocation forms, option summaries, recognized
API-key environment-variable names, and a generic secure-storage note. See the
[credentials guide](credentials.md) for platform-specific storage requirements.

## Select a provider and model

There are four selection modes:

- `llm-now` opens the interactive launcher.
- `llm-now <alias>` or `llm-now --alias <name>` selects a saved shortcut.
- `llm-now --provider <id> --model <id>` selects an exact provider and model.
- `llm-now --voice-route` extracts a leading alias handle from the request and
  selects the matching saved shortcut.

The explicit provider and model options must be supplied together. Supported
provider IDs are `ollama`, `lm-studio`, `codex-cli`, `claude-cli`, `anthropic`,
`openai`, `google`, `xai`, `openrouter`, `groq`, `mistral`, `deepseek`, and
`deepinfra`. `--model default` delegates model choice to the provider and is
valid only for `codex-cli` and `claude-cli`.

```bash
llm-now --input "Hello" --provider ollama --model llama3
printf 'Hello' | llm-now --provider claude-cli --model default
```

Only one positional alias is accepted. Options may appear before or after it,
although the alias-first form is recommended. A second positional value is
never prompt text. A positional alias cannot be combined with `--alias`,
`--provider`, or `--model`; `--alias` cannot be combined with `--provider` or
`--model`.

Alias lookup is ASCII case-insensitive but spelling-exact: `local`, `Local`,
and `LOCAL` select the same entry, while `locall` does not. The explicit
`--alias local` form is available for scripts and future command-name
ambiguities.

```bash
llm-now local
llm-now local --input "Summarize this idea"
printf 'Explain this diff' | llm-now local
```

### Interactive launcher

With at least one saved shortcut, the launcher offers these actions in order:

1. `Run with a saved shortcut…`
2. `Create a new shortcut…`
3. `Run once with another provider and model…`
4. `Manage connections…`

Without saved shortcuts, it omits the unusable first action and offers
`Create a new shortcut…`, `Run once with a provider and model…`, and
`Manage connections…`. Opening either root menu performs no provider discovery
or credential access.

`Create a new shortcut…` asks `How should this shortcut connect?` and offers
`Use an available provider…` before `Add a provider with an API key…`. The
first route discovers providers only after selection. The second can validate
and securely store a missing cloud-provider key before model selection. See the
[credentials guide](credentials.md) for management and storage behavior.

Both creation routes require a shortcut name, then show the multiline
`Optional instructions for this shortcut (press Enter to skip)` field. The
editor keeps `Press Tab to select [ save ], then Enter to save` visible beneath
the text and changes it to `[ save ] selected — press Enter to save` after Tab.
Press Enter on a blank field for no instructions. Type or paste reusable
guidance, then use the save action to preserve its line breaks.

The shortcut is saved before
`Prompt for <shortcut> · <provider> · <model>` appears. A nonblank prompt runs
it once in the same invocation. Cancelling after a key or shortcut is saved
preserves that completed work; cancelling before any durable write leaves the
store unchanged.

`Run once…` discovers an available provider and model, asks
`Prompt for <provider> · <model>`, generates once, and exits without saving or
offering a shortcut. Shortcut, provider, and model lists are sorted and filter
as you type.

Connection management remains a separate `What would you like to manage?`
menu for passive provider discovery and API-key addition, replacement, or
deletion. API keys use hidden terminal input and are never accepted through
command-line arguments or generation stdin.

## Supply one prompt

Prompt text comes from one source:

- `--input <text>`;
- stdin; or
- the terminal prompt shown for an interactive launcher or alias-only call.

Except for a sole `--speak` in an interactive terminal, arguments, `--input`,
piped input, and noninteractive execution bypass the launcher. That exception
opens the launcher with speech enabled, including its shortcut-creation routes.
A noninteractive call requires a positional alias, `--alias`, or both
`--provider` and `--model`. It also requires one nonblank prompt from `--input`
or stdin. Supplying nonempty stdin together with `--input` or supplying neither
source is a usage error. On calls without `--voice-route`, a blank prompt or
invalid-UTF-8 stdin is also a usage error. Accepted prompt text is not trimmed
or otherwise transformed.

In an interactive terminal, `llm-now local` resolves the saved shortcut, shows
its alias, provider, and model in
`Prompt for <alias> · <provider> · <model>`, collects one prompt, generates
once, and exits. A delegated model is labeled `default model`; a pinned model
shows its model ID. Blank input stays at the prompt. Escape or Ctrl-C cancels.

## Override instructions for one request

`--instruction <text>` sends nonblank behavioral guidance separately from the
prompt and does not count as a prompt source:

```bash
llm-now local --instruction "Answer as a concise editor" --input "Revise this"
llm-now --alias local --instruction "Answer as a skeptical reviewer" --input "Review this"
llm-now --provider ollama --model llama3 --instruction "Use plain language" --input "Explain closures"
llm-now local --instruction=-brief --input "Summarize this"
```

Instruction precedence depends on what the request selects:

| Selection | No `--instruction` | With `--instruction` |
| --- | --- | --- |
| Saved alias | configured `shared_instructions`, then alias-local `instructions` | command-line value, then alias-local `instructions` |
| Explicit provider/model or fresh run once | no configured instruction | command-line value only |

When both alias layers are present, `llm-now` inserts `\n\n` between their
exact accepted values. The option never writes to `config.toml` or mutates the
selected alias. If a fresh interactive selection later offers to save a
shortcut, that save flow's instruction field starts independently and persists
only what is entered there.

Instruction text may use ordinary line breaks. Blank text, tabs, other
unsupported control characters, and Unicode line or paragraph separators are
rejected.

`--instruction` is not a secret-input mechanism. Its value may be visible in
shell history and local process inspection, in child-process arguments for
CLI-backed providers, under the selected provider's handling and retention
policies, and in successful model output. Runtime failures redact active
shared, command-line, alias-local, and composed instruction values from
`llm-now` diagnostics in raw and serialized forms, but successful model output
is intentionally not filtered. Do not pass secrets, credentials, or data you
are not permitted to disclose.

## List the alias inventory

`--aliases` lists configured targets without prompting or contacting a
provider:

```console
$ llm-now --aliases
aliases → Codex CLI · provider default
local → OpenAI · gpt-5
```

Output has one uncolored, unpadded
`alias → Provider Label · model` row per canonical lowercase alias, sorted by
canonical alias, with no header. A delegated model is shown as
`provider default`. Instruction text and whether instructions exist are never
included.

A missing or empty configuration exits `0` with zero stdout bytes. Successful
inventory writes only to stdout and leaves stderr empty. `--aliases` ignores
stdin and returns before prompt handling, provider discovery, runtime calls,
credential access, or alias mutation.

`--aliases` is standalone. Combining it with another option or positional
value exits `2`, leaves stdout empty, and writes a `usage:` diagnostic to
stderr. An invalid, unreadable, or case-conflicting configuration exits `1`,
leaves stdout empty, and writes a `config:` diagnostic to stderr. The bare word
`aliases` remains a positional alias and generates normally when configured.

## Route voice input and speak output

Voice routing and audible output are independent modifiers:

```bash
# Route a dictated transcript and write the answer to stdout on any supported OS.
llm-now --voice-route --input "hey local, summarize this"

# Select the shortcut normally, but speak its answer on macOS.
llm-now --alias local --speak --input "Summarize this"

# Route the transcript and speak the answer on macOS.
printf 'hey local, summarize this' | llm-now --voice-route --speak
```

`--voice-route` treats its single prompt input as an alias handle followed by a
question. It selects from saved shortcuts, then uses the ordinary generation
and stdout contract unless `--speak` is also present. It cannot be combined
with a positional alias, `--alias`, `--provider`, or `--model`.
`--instruction` remains available and replaces the configured shared layer for
that request; the routed shortcut's local instructions still follow.

Routing checks canonical aliases, configured `spoken_names`, and fuzzy
matching in that order. Every accepted route completes this one fixed,
human-readable stderr write before provider generation begins:

```text
Selecting alias '<canonical-alias>'
```

| Route result | stderr | Provider and stdout |
| --- | --- | --- |
| Accepted | One selection line; existing sanitized diagnostics may follow if later work fails | Generation starts after the write; stdout remains response-only, or answer-empty with `--speak` |
| Rejected | No selection line; existing bounded rejection diagnostic | No provider call; stdout remains empty |

The line includes its terminating newline. The value is always the normalized
canonical alias, including when a configured spoken name or fuzzy match was
accepted. The alias is the line's only variable data: it never includes the
transcript, extracted question, prompt, provider, credential, response, or any
other request content.

A route-only mismatch exits `1`, leaves stdout empty, reports a bounded
value-free reason on stderr, writes no selection line, and makes no provider or
speech call. Blank or invalid-UTF-8 routed input is also a voice rejection and
writes no selection line: route-only calls exit `1`, while `--speak` calls exit
`0` when the stable retry notice is spoken successfully. Routing without speech
works on every supported platform.

`--speak` composes with positional-alias, `--alias`, explicit provider/model,
voice-routing, and interactive selection flows. It adds this plain-text speech
guidance to the prompt:

```text
Answer concisely in plain text suitable for speech. Do not use Markdown or code fences unless the question requires code.
```

It validates one answer and sends it to macOS `/usr/bin/say` instead of stdout.
A saved shortcut uses its optional speech profile; an explicit provider/model
selection uses the current macOS system voice, rate, and baseline pitch.
`--speak` is macOS-only and rejects on other platforms before reading input or
configuration. Neither modifier reads or changes the clipboard.

When speech is enabled, ordinary routing mismatches and handled generation
failures speak stable notices and exit `0` if the notice succeeds.
Empty-inventory, configuration, missing-`say`, and answer-speech process
failures exit `1`; an answer-speech process failure does not trigger a
replacement notice.
Cancellation exits `130`. See
[Talk to a saved shortcut from a macOS keyboard shortcut](../examples/macos-voice-shortcut.md)
for setup, routing examples, privacy notes, and troubleshooting.

## Standalone information and maintenance commands

- `--help` prints help to stdout and exits `0`.
- `--version` prints the version to stdout and exits `0`.
- `--config-path` prints the exact `config.toml` path without reading stdin,
  configuration, providers, credentials, or voice state. See the
  [configuration guide](configuration.md).
- `--migrate-config` migrates legacy configuration or reports that the unified
  file already exists. See the [configuration guide](configuration.md).

Each option in this section must be used alone. A combination with any other
option or positional value is a usage error.

## Output and diagnostics

Successful generation writes the model response byte-for-byte to stdout.
Interactive UI and diagnostics use stderr, so stdout remains safe to redirect
or pipe. After an interactive response, stderr resets terminal styling and adds
a clean visual boundary without changing stdout. With `--speak`, a successfully
spoken answer leaves answer stdout empty. An accepted `--voice-route` request is
the exception to otherwise-empty noninteractive generation stderr: its exact
canonical-alias selection line appears before generation. If provider or
generation work later fails, that completed selection remains the first stderr
line and the existing sanitized diagnostic follows it. A later failure does not
invalidate or repeat the earlier selection.

If a generated response contains a registered credential, `llm-now` withholds
it from stdout, emits a redacted diagnostic, and exits `1`. Diagnostics remove
terminal controls, normalize line endings, limit runtime detail, and redact
recognized environment, stored, candidate, prompt, and instruction values as
appropriate. Interactive color is suppressed by `NO_COLOR`, `TERM=dumb`, and
non-terminal output.

Discovery checks already-running Ollama and LM Studio servers, installed
`codex` and `claude` commands on `PATH`, recognized cloud-provider environment
variables, and stored cloud-provider fallbacks on enabled targets. A candidate
is verified only when selected. Discovery never starts software, downloads
models, or changes machine configuration. If no provider is found, stderr
lists every checked provider class and manual setup steps. Runtime failures
identify the discovery, model-list, generation, or credential-store operation.

## Exit codes

- `0`: successful generation, alias inventory, config-path discovery,
  migration, help, version, or a completed or declined setup action;
  cancellation after a durable key or shortcut write preserves that work and
  can exit without generation. With `--speak`, blank or invalid-UTF-8 routed
  input and ordinary routing mismatches also exit `0` when their stable retry
  notice is spoken successfully. Handled speech-mode generation failures use
  the same exit code when their stable notice is spoken successfully.
- `1`: discovery, model-list, generation, configuration, credential-store,
  route-only voice rejection (including mismatch, blank input, or invalid
  UTF-8), or post-credential shortcut failure. Invalid, unreadable, and
  case-conflicting unified configuration also use `1`.
- `2`: invalid usage, including illegal option combinations and combining
  `--aliases`, `--config-path`, or `--migrate-config` with another option or
  positional value. For calls without `--voice-route`, blank prompts and
  invalid-UTF-8 input are also usage errors.
- `130`: launcher, management, prompt, alias, provider, or model selection
  cancelled before a durable action; voice cancellation also uses `130`.

# llm-now

[![CI](https://github.com/swartzrock/llm-now/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/swartzrock/llm-now/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/swartzrock/llm-now?sort=semver&display_name=tag)](https://github.com/swartzrock/llm-now/releases/latest)
[![License](https://img.shields.io/github/license/swartzrock/llm-now)](https://github.com/swartzrock/llm-now/blob/main/LICENSE)
[![macOS](https://img.shields.io/badge/macOS-signed%20%26%20notarized-brightgreen)](https://github.com/swartzrock/llm-now/releases/latest)
[![Linux](https://img.shields.io/badge/Linux-x64%20%7C%20ARM64%20%28glibc%29-blue)](https://github.com/swartzrock/llm-now/releases/latest)
[![Windows](https://img.shields.io/badge/Windows-x64%20unsigned%20early%20access-orange)](https://github.com/swartzrock/llm-now/releases/latest)

## A tiny CLI for the local models you already run.

`llm-now` sends one text-generation prompt through an LLM provider already available on your machine. It uses [`@swartzrock/byok-runtime`](https://github.com/swartzrock/byok-runtime) for discovery, model listing, and generation; it does not install or start providers.

```console
$ llm-now --input "Explain this error in plain English: ECONNREFUSED 127.0.0.1:5432"
```

| Native releases | Passive discovery | Secure credentials | Scriptable output |
| --- | --- | --- | --- |
| macOS, Linux, and Windows | Installs and starts nothing | Environment first; native fallback on enabled targets | Model response only on stdout |

## See llm-now in action

![Animated terminal demo of llm-now discovering available providers and using model aliases](docs/demos/demo.gif)

On macOS, the installed `llm-now --voice-route --speak` command can power a
two-action global Shortcut without Python, uv, or a repository checkout. See
[Talk to a saved alias from a macOS keyboard shortcut](examples/macos-voice-shortcut.md).

## Install

### Homebrew (macOS and Linux)

```bash
brew install swartzrock/tap/llm-now
```

### Direct download

[Download the latest release](https://github.com/swartzrock/llm-now/releases/latest), choose the archive for your platform and architecture, then place the extracted executable somewhere on your `PATH`.

- **macOS:** choose Apple silicon (`llm-now-v<version>-macos-arm64.zip`) or Intel (`llm-now-v<version>-macos-x64.zip`). Both builds are signed and notarized.
- **Linux:** choose `llm-now-v<version>-linux-arm64.zip` or `llm-now-v<version>-linux-x64.zip`. These are glibc builds; Alpine and other musl systems are not supported.
- **Windows:** choose `llm-now-v<version>-windows-x64.zip`. This is unsigned early access, so Windows may warn or block it according to local security policy. Do not weaken security controls to run `llm-now`.

Each release includes `SHA256SUMS` and GitHub artifact attestations alongside the archives.

## Usage

Run the bare command in an interactive terminal to open the adaptive launcher:

```bash
llm-now
```

![Rendered llm-now help screen showing usage, options, API-key environment variables, and secure storage guidance](docs/demos/help-screen.jpg)

The launcher separates reusable setup, one-off work, and connection management. With saved shortcuts it offers “Run with a saved shortcut…”, “Create a new shortcut…”, “Run once with another provider and model…”, and “Manage connections…” in that order. Without saved shortcuts it omits the unusable saved-shortcut action and offers “Create a new shortcut…”, “Run once with a provider and model…”, and “Manage connections…”. Merely opening either root performs no provider discovery or credential access.

“Create a new shortcut…” asks “How should this shortcut connect?” and offers “Use an available provider…” followed by “Add a provider with an API key…”. The first route discovers providers only after it is selected. The second can validate and securely save a missing cloud-provider key before model selection. Both routes require a shortcut name, then show a visible multiline `Optional instructions for this shortcut (press Enter to skip)` field. The editor keeps `Press Tab to select [ save ], then Enter to save` visible beneath the text and changes it to `[ save ] selected — press Enter to save` after Tab. Press Enter on a blank field for no instructions. Type or paste reusable guidance, then follow that save callout to preserve its line breaks. The shortcut is saved before `Prompt for <shortcut> · <provider> · <model>` appears, and a nonblank prompt runs it exactly once in the same invocation. Cancelling after a key or shortcut is saved preserves that completed work; cancelling before any durable write leaves the store unchanged.

“Run once…” discovers an available provider and model, asks `Prompt for <provider> · <model>`, generates once, and exits without saving or offering a shortcut. Shortcut, provider, and model lists are sorted and filter as you type.

Connection management remains a separate “What would you like to manage?” menu for passive provider discovery plus API-key addition, replacement, and deletion. API keys are entered through hidden terminal input, authenticated before saving, and never accepted through command-line arguments or generation stdin.

Use a saved global alias:

```bash
llm-now daily
llm-now daily --input "Summarize this idea"
printf 'Explain this diff' | llm-now daily
```

List the saved alias inventory without prompting or contacting a provider:

```console
$ llm-now --aliases
aliases → Codex CLI · provider default
daily → OpenAI · gpt-5
```

Inventory output has one uncolored, unpadded `alias → Provider Label · model`
row per canonical lowercase alias, sorted by canonical alias, with no header. A
delegated model is shown as `provider default`. A missing or empty configuration exits
`0` with zero stdout bytes. Successful inventory writes only to stdout and
leaves stderr empty. Inventory intentionally reveals neither instruction text
nor whether a shortcut has instructions.

`--aliases` is standalone and ignores stdin. Combining it with any other option
or positional value exits `2`, leaves stdout empty, and writes a `usage:`
diagnostic to stderr. An invalid, unreadable, or case-conflicting configuration
exits `1`, leaves stdout empty, and writes the existing `config:` diagnostic to
stderr. Inventory returns before prompt handling, provider discovery or runtime
calls, credential access, and alias mutation. The bare word `aliases` remains a
positional alias and generates normally when that alias is configured.

In a terminal, the alias-only form shows the resolved alias, provider, and model,
asks for one prompt, generates once, and exits. A delegated model is labeled
`default model`; a pinned alias shows its model ID. Blank input stays at the
prompt, while Escape or Ctrl-C cancels.

Alias names are ASCII case-insensitive but spelling-exact: `daily`, `Daily`, and
`DAILY` select the same alias, while `dailly` does not. Aliases are stored and
displayed in lowercase. Options may appear before or after the alias, though the alias-first form above is recommended. The explicit
`--alias daily` form remains available for scripts and for resolving any future command-name
ambiguity.

Choose deterministically, including a supported CLI provider's default model:

```bash
llm-now --input "Hello" --provider ollama --model llama3
printf 'Hello' | llm-now --provider claude-cli --model default
```

Supply a behavioral instruction for one request with any selection form:

```bash
llm-now daily --instruction "Answer as a concise editor" --input "Revise this"
llm-now --alias daily --instruction "Answer as a skeptical reviewer" --input "Review this"
llm-now --provider ollama --model llama3 --instruction "Use plain language" --input "Explain closures"
llm-now daily --instruction=-brief --input "Summarize this"
```

`--instruction` is sent separately from the prompt and does not count as prompt
input. The prompt must still come from exactly one existing source: `--input`,
stdin, or the alias-only terminal prompt. For an alias with saved instructions,
the command-line value replaces the saved value for that request; omitting the
option keeps the saved value. `llm-now` does not write the command-line value to
`config.toml` or mutate the selected alias. If a fresh interactive selection
later offers to save an alias, its instruction field starts independently and
only a value entered in that save flow is persisted.

The option is not a secret-input mechanism. Its value may be visible in shell
history and local process inspection, in child-process arguments for CLI-backed
providers, under the selected provider's handling and retention policies, and
in successful model output. Runtime failures redact the active command-line
instruction from `llm-now` diagnostics in raw and serialized forms, but
successful model output is intentionally not filtered. Do not pass secrets,
credentials, or data you are not permitted to disclose.

Arguments, `--input`, piped input, and noninteractive execution bypass the launcher. For scripts and non-interactive calls, exactly one prompt source is required: `--input` or stdin. Non-interactive calls require a positional alias, `--alias`, or both `--provider` and `--model`. A second positional argument is never treated as prompt text. Successful generation writes the model response, byte-for-byte, to stdout. Interactive UI and diagnostics use stderr, so the response remains safe to redirect or pipe. After an interactive response, stderr resets terminal styling and adds a clean visual boundary without changing stdout.

## Voice routing and speech

Voice routing and audible output are independent modifiers:

```bash
# Route a dictated transcript and write the answer to stdout on any supported OS.
llm-now --voice-route --input "hey daily, summarize this"

# Select the shortcut normally, but speak its answer on macOS.
llm-now --alias daily --speak --input "Summarize this"

# Route the transcript and speak the answer on macOS (the Shortcut form).
printf 'hey daily, summarize this' | llm-now --voice-route --speak
```

`--voice-route` treats its single input as an alias handle followed by a
question. It selects from saved shortcuts, then follows the ordinary generation
and stdout contract unless `--speak` is also present. It cannot be combined
with another alias, provider, or model selection. `--instruction` remains
available and replaces the routed shortcut's saved instructions for that one
request.

A route-only mismatch exits `1`, leaves stdout empty, reports a value-free
reason on stderr, and makes no provider or speech call.

`--speak` keeps the normal positional-alias, `--alias`, explicit
provider/model, and interactive selection flows. It adds concise plain-text
speech guidance to the prompt and sends one validated answer to macOS
`/usr/bin/say` instead of stdout. A saved alias uses its optional speech
profile; an explicit provider/model selection uses the current macOS speech
defaults. Speech is macOS-only, while routing without speech works on every
supported platform. Neither modifier reads or changes the clipboard.

## Aliases and configuration

The launcher’s creation route saves a required shortcut before its first run. Existing direct interactive provider/model selection retains its established optional alias follow-up: after a successful unnamed call, `llm-now` shows a green contextual field such as `Enter an alias name for OpenAI · gpt-3.5 (Enter to exit)`. Type a name, then optionally enter visible multiline instructions and use its `[ save ]` action, to save that provider/model pair; press Enter at the name field to exit. If the selected provider/model is already saved, it reports the existing alias and suggests an executable command such as `llm-now daily --input "<prompt>"` for next time instead of asking for a duplicate. A launcher run-once call and a call that selected an existing alias never offer this follow-up. Aliases contain no credentials and are available from every working directory.

All alias and voice settings share one versioned TOML file. Print its exact path
without reading or changing configuration:

```bash
llm-now --config-path
```

The platform paths are:

- macOS/Linux: `$XDG_CONFIG_HOME/llm-now/config.toml` when
  `XDG_CONFIG_HOME` is absolute, otherwise `~/.config/llm-now/config.toml`;
- Windows: `%APPDATA%\llm-now\config.toml` when `APPDATA` is absolute,
  otherwise `%USERPROFILE%\AppData\Roaming\llm-now\config.toml`.

Relative `XDG_CONFIG_HOME` and `APPDATA` values are ignored in favor of the
platform fallback. `--config-path` must be used alone.

### Configuration format

The closed version 1 grammar has a required `version`, a required `[aliases]`
table (which may be empty), an optional global `[voice]` table, and one
`[aliases.<name>]` table per alias. This example shows every supported field;
the values are examples, not generated defaults:

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

`provider` and a nonblank `model` are required for every alias. Valid provider
IDs are `ollama`, `lm-studio`, `codex-cli`, `claude-cli`, `anthropic`,
`openai`, `google`, `xai`, `openrouter`, `groq`, `mistral`, `deepseek`, and
`deepinfra`. `model = "default"` means the authenticated CLI's delegated model
and is valid only for `codex-cli` and `claude-cli`. Alias names are ASCII
case-insensitive, at most 64 characters, start with a letter or digit, and
otherwise use letters, digits, `_`, or `-`; llm-now saves them in lowercase.

Every other field is optional:

- `[voice].wake_words` is a list of unique, nonblank normalized strings. Omit
  it to use `["hey"]`; set it to `[]` to disable wake-word stripping.
- `[voice].min_fuzzy_phrase_length` is an integer from `1` through `64`; omit it
  to use `4`.
- `[voice].min_similarity` is an integer from `0` through `100`; omit it to use
  `65`.
- `[voice].min_margin` is an integer from `0` through `100`; omit it to use
  `15`.
- `instructions` is a nonblank plaintext string. Ordinary line breaks are
  supported; tabs, other unsupported control characters, and Unicode line or
  paragraph separators are rejected.
- `spoken_names` lists additional exact spoken names that select this alias
  during voice routing. It is a list of unique, nonblank normalized strings;
  a spoken name cannot collide with another alias's canonical name or spoken
  name. Omit it to use canonical and fuzzy matching only; set it to `[]` for no
  additional spoken names.
- `voice` is a nonblank installed macOS voice name.
- `rate` is an integer from `80` through `500`.
- `pitch` is an integer or fractional number from `1` through `127`, inclusive.

Omitting `voice`, `rate`, or `pitch` lets `/usr/bin/say` inherit the current
system voice, speech rate, or that voice's normal baseline pitch independently.
Voice fields are portable: macOS executes them, while Linux and Windows retain
them across alias saves. Route-only execution remains available there, while
`--speak` rejects before reading input or configuration.

The router always tries canonical aliases, then configured spoken names, then
fuzzy matching. Configurable thresholds do not remove its safety gates: fuzzy
candidates must have a compatible length, preserve digit sequences, clear the
minimum similarity, and beat the runner-up by the configured margin. Weak or
ambiguous input fails closed.

Saving the same name, target, and instructions, in any capitalization, reports
that it is already saved. Recreate a shortcut with the same name to add,
change, or remove its instructions; any change to its target or instructions
requires overwrite confirmation, defaulting to No. A stale alias fails without
selecting a replacement.

An alias save rewrites the complete TOML document canonically. It preserves all
valid unrelated alias, routing, and speech values, sorts aliases, and may remove
comments or custom formatting. Files generated by llm-now are deliberately
sparse and comment-free: omitted wake-word, fuzzy-routing, speech, and example
values are not written, so deleting an override resumes the documented compiled
or system behavior instead of pinning today's value.

Instructions are plaintext in `config.toml`. Migration backups are also exact
plaintext copies and may contain legacy instructions. Protect the configuration
directory accordingly. Each shortcut invocation passes its saved instructions
to the provider separately from that invocation’s prompt. Explicit
provider/model calls and launcher “Run once…” calls do not inherit shortcut
instructions. Provider behavior, retention, and precedence remain subject to
the selected provider’s policies. For CLI-backed providers, instructions may be
transmitted in child-process arguments and therefore may be visible to local
process inspection or audit tools. Do not store secrets, credentials, or data
you are not permitted to disclose as shortcut instructions. Recognized
credentials and provider authentication remain outside `config.toml`.

### Migration and downgrade recovery

Until `config.toml` exists, llm-now reads the legacy `aliases.json` and
`voice-router.toml` files without changing them. The next successful alias save
migrates both legacy stores after any overwrite approval. To migrate sooner
without changing an alias, run this standalone command:

```bash
llm-now --migrate-config
```

Migration validates one snapshot, creates exact deterministic backups before
publishing unified authority, and leaves the legacy source files in place. The
backups are named `aliases.json.pre-unified-v1.bak` and
`voice-router.toml.pre-unified-v1.bak`; a missing legacy source produces no
backup. A valid voice profile for a removed alias is not invented as an
incomplete alias: the command exits successfully and reports all such profile
names once on stderr in sorted order. Repeating explicit migration is safe and
reports that configuration is already unified.

Once `config.toml` exists, it is the sole automatic authority. If it is
malformed or unsupported, configuration-backed commands fail closed rather
than falling back to legacy files or backups. `--config-path` and the early
non-macOS `--speak` rejection do not read application configuration. Routing
and speech may read the selected authority but never create `config.toml`,
migrate legacy files, write a backup, or change configuration.
Installed and packaged execution is native and requires no
Python, uv, or repository checkout; the Python example remains a
contributor-only independent parity oracle.

An older binary may not understand `config.toml`, and changes made after
migration are not mirrored into the legacy files or backups. Prefer installing
a compatible version. If a deliberate downgrade is unavoidable, use the newer
binary to print the path, close other llm-now processes, and recover in this
order:

1. Move `config.toml` to a new preserved filename outside the authoritative
   path, such as `config.toml.pre-downgrade`. Do not overwrite an existing moved
   copy.
2. For each backup that exists, copy
   `aliases.json.pre-unified-v1.bak` to `aliases.json` and
   `voice-router.toml.pre-unified-v1.bak` to `voice-router.toml`. A missing
   backup means that legacy source did not exist at migration time and should
   remain absent.
3. Keep the moved unified file: it is the only copy of any valid post-migration
   aliases, instructions, routing thresholds, or speech changes. Verify the
   restored files before installing the older binary.

Backups are never restored automatically, and there is no first-class recovery
command in this release. Moving `config.toml` out of authority must happen
before copying legacy backups; otherwise the current binary continues to use
the unified document.

## Secure API-key storage

Recognized environment variables are always authoritative. They are the recommended credential source for scripts, automation, and headless systems. When no recognized environment credential is set, an enabled release target may use one provider-specific key from the operating system's native credential store.

Use bare `llm-now`, choose “Manage connections…”, then “Add or manage API keys…” to add, replace, or delete a stored fallback. Shortcut creation can add only a currently missing eligible provider; replacement and deletion remain management operations. Replacement verifies the new key before changing the existing record, and save/delete confirmations default to No. Deleting a stored fallback does not remove an active environment credential. Alias records never contain keys or credential identifiers; optional shortcut instructions are plaintext configuration, not credential storage.

### How secure storage works

For each cloud provider, `llm-now` creates at most one native credential record under the service `llm-now`, using the non-secret record name `api-key:<provider>`. The API key itself is passed to the operating system's credential API; `llm-now` does not write it to `config.toml` or another configuration file. Encryption, locking, and access control are delegated to the native credential service for the logged-in user.

When resolving a provider credential, `llm-now` checks the provider's recognized environment variables first. It reads the native record only when no environment credential is present. A successful replacement is verified before the old native record changes, and deleting a native record does not affect an environment variable. There is no plaintext or self-encrypted fallback.

### macOS Keychain

On a supported macOS release target, the native record is stored in the current user's macOS Keychain. Keychain owns the encrypted storage and user-session access controls. `llm-now` retrieves the record only when a command needs that provider and no recognized environment variable is set.

### Linux Secret Service

On supported Linux glibc targets, the native record is stored through the Secret Service in the current user D-Bus session. GNOME Keyring and KWallet are common providers. A provider must be running and unlocked; a Linux kernel or desktop package alone is not enough. Minimal containers, servers, SSH sessions, WSL sessions, and locked desktops may not expose a usable Secret Service.

If Secret Service is unavailable, `llm-now` does not save the key elsewhere. It reports the failure without exposing backend details and suggests either setting the provider's environment variable for the current shell or starting and unlocking GNOME Keyring or KWallet before retrying.

### Target support and help

Native storage is capability-gated per compiled release target. If it is not enabled for the current target, setup performs no credential-store read and directs you to the provider's environment variable instead.

| Compiled target | Native store | Bun 1.3.14 policy |
| --- | --- | --- |
| macOS ARM64 | Keychain | Enabled after compiled lifecycle gate |
| macOS x64 | Keychain | Environment-only; Bun 1.3.14 failed the compiled lifecycle gate |
| Linux x64 / ARM64 glibc | Secret Service | Enabled after compiled lifecycle gate; requires an available user-session service |
| Windows x64 baseline | Credential Manager | Enabled after compiled lifecycle gate |

The target and pinned Bun version must both match the tested policy. Run `llm-now --help` for platform-specific storage requirements and the complete list of recognized API-key environment variables. In an interactive terminal, unavailable native storage is presented with colored `Error:` and `Tip:` headings; `NO_COLOR` and non-terminal output remain plain. Provider discovery and API-key management reuse the same recovery guidance.

## Discovery and diagnostics

Discovery checks already-running Ollama and LM Studio servers, installed `codex` and `claude` commands on `PATH`, recognized cloud-provider environment variables, and—on enabled targets—stored cloud-provider fallbacks. A candidate is verified only when selected. Discovery never starts software, downloads models, or changes machine configuration.

If no provider is found, stderr lists every checked provider class and manual setup steps. Runtime failures identify the discovery, model-list, generation, or credential-store operation. Diagnostic text removes terminal controls, normalizes line endings, bounds runtime detail, and redacts recognized environment, stored, and candidate credential values.

Exit codes:

- `0`: successful generation, alias inventory, config-path discovery, migration,
  help, version, or a completed/declined setup action; cancellation after a
  durable key or shortcut write preserves that completed work and exits without
  generation
- `1`: discovery, model-list, generation, configuration (including an invalid, unreadable, or case-conflicting unified document), credential-store, or post-credential alias failure
- `2`: invalid usage, including combining `--aliases`, `--config-path`, or
  `--migrate-config` with another option or positional value
- `130`: launcher, management, prompt, alias, provider, or model selection cancelled before a durable action

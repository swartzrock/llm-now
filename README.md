# llm-now

[![CI](https://github.com/swartzrock/llm-now/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/swartzrock/llm-now/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/swartzrock/llm-now?sort=semver&display_name=tag)](https://github.com/swartzrock/llm-now/releases/latest)
[![License](https://img.shields.io/github/license/swartzrock/llm-now)](https://github.com/swartzrock/llm-now/blob/main/LICENSE)
[![macOS](https://img.shields.io/badge/macOS-signed%20%26%20notarized-brightgreen)](https://github.com/swartzrock/llm-now/releases/latest)
[![Linux](https://img.shields.io/badge/Linux-x64%20%7C%20ARM64%20%28glibc%29-blue)](https://github.com/swartzrock/llm-now/releases/latest)
[![Windows](https://img.shields.io/badge/Windows-x64%20unsigned%20early%20access-orange)](https://github.com/swartzrock/llm-now/releases/latest)

## A tiny CLI for prompting models you already use.

`llm-now` sends one text-generation prompt through a provider you already use: an already-running local server, an authenticated CLI, or a cloud API. It uses [`@swartzrock/byok-runtime`](https://github.com/swartzrock/byok-runtime) for discovery, model listing, and generation; it does not install or start providers.

```console
$ llm-now local --input "Explain this error in plain English: ECONNREFUSED 127.0.0.1:5432"
```

| Native releases | Passive discovery | Secure credentials | Scriptable output |
| --- | --- | --- | --- |
| macOS, Linux, and Windows | Installs and starts nothing | Environment first; native fallback on enabled targets | Model response only on stdout |

## Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [Common commands](#common-commands)
- [Voice](#voice)
- [Configuration](#configuration)
- [Credentials](#credentials)
- [CLI reference](docs/cli-reference.md)

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

## Quick Start

Before starting, make sure at least one provider is available: an Ollama or LM
Studio server is running, `codex` or `claude` is installed and authenticated,
or a supported cloud API credential is configured.

Open the interactive launcher:

```bash
llm-now
```

Then follow this path without choosing another launcher branch:

1. Select `Create a new shortcut…`.
2. Select `Use an available provider…`.
3. Choose a provider, then choose its model.
4. At `Name this shortcut`, enter a name such as `local`.
5. At `Optional instructions for this shortcut (press Enter to skip)`, enter
   reusable guidance or press Enter to skip it. If you entered guidance, press
   Tab to select `[ save ]`, then press Enter to save.
6. For Codex CLI or Claude CLI, optionally enter one primary workspace
   directory and any additional directories. Press Enter at the primary prompt
   to skip the workspace or at an additional prompt to finish the list. Codex
   then asks whether to grant read-write access and defaults to No.
7. After the shortcut is saved, enter your first prompt at
   `Prompt for local · <provider> · <model>` and receive the response.

Reuse the saved shortcut from any directory:

```bash
llm-now local --input "Summarize the three most important points"
```

## See llm-now in action

![Animated terminal demo of llm-now discovering available providers and using model aliases](docs/demos/demo.gif)

## Common commands

| Task | Command |
| --- | --- |
| Open the interactive launcher | `llm-now` |
| Run a saved shortcut | `llm-now local --input "Summarize this idea"` |
| Pipe a prompt to a saved shortcut | <code>printf 'Explain this diff' &#124; llm-now local</code> |
| Choose a provider and model explicitly | `llm-now --provider ollama --model llama3 --input "Hello"` |
| Stream a response | `llm-now local --stream --input "Summarize this idea"` |
| List the alias inventory | `llm-now --aliases` |
| Print the configuration path | `llm-now --config-path` |
| Route a dictated prompt | `llm-now --voice-route --input "hey local, summarize this"` |
| Speak a response on macOS | `llm-now --alias local --speak --input "Summarize this"` |

Except for a sole `--speak` or `--stream` in an interactive terminal, arguments, `--input`,
piped input, and noninteractive execution bypass the launcher. Noninteractive
generation needs exactly one prompt source (`--input` or stdin) plus a saved
shortcut or an explicit provider and model. Successful generation writes only
the model response to stdout; interactive UI and diagnostics use stderr.
With `--stream`, response chunks are written and flushed as they arrive. Model
responses are stripped of terminal escape sequences and unsafe control
characters before stdout in both streaming and buffered modes. `--stream`
cannot be combined with `--speak`.
`--aliases` and `--config-path` are standalone commands.

`llm-now --help` shows command syntax, option summaries, recognized API-key
environment variables, and a generic secure-storage note. Platform-specific
storage requirements are in the [credentials guide](docs/credentials.md).
See the [CLI reference](docs/cli-reference.md) for exact invocation, selection,
input, instruction, output, diagnostic, and exit-code behavior.

## Voice

### Speaking

On macOS, `--speak` sends the output to `/usr/bin/say`, with an optional voice configured for your alias (see the 
[configuration guide](docs/configuration.md))

If you have access to dictation software, use `--voice-route` with a configured "wake word" () to have llm-now select a matching shortcut. For example, if you configured a wake word of "hey" and an alias named "haiku", use `llm-now --voice-route --input 'hey haiku, write a one-line love poem'` to route the prompt to the "haiku" alias.

When routing accepts the request, llm-now writes exactly
`Selecting alias 'haiku'\n` to stderr using the canonical alias, then begins
provider generation. The generated response remains the only stdout content;
with `--speak`, answer stdout remains empty. A rejected route writes no
selection line and makes no provider call.

For a two-action global Apple Shortcut, optional spoken names, routing and
speech settings, privacy guidance, and troubleshooting, see
[Talk to an llm-now alias from a macOS shortcut](examples/macos-voice-shortcut.md).

## Configuration

Saved shortcuts, shared alias instructions, and voice settings use one
`config.toml`. Shortcut saves may rewrite it in a consistent order while
preserving valid settings. Instructions are plaintext and credentials never
belong in this file. See the
[configuration guide](docs/configuration.md) to find and edit the file,
configure aliases, and customize voice routing and speech.

### Workspace shortcuts

Add one or more absolute directories to a Codex CLI or Claude CLI alias:

```toml
[aliases.terra]
provider = "codex-cli"
model = "default"
directories = ["/absolute/project", "/absolute/shared"]
directory_access = "read-write"
```

The first path is the working directory; the rest are additional directories.
Omit `directory_access` for `read-only`; `read-write` lets Codex modify every
listed directory, while Claude CLI supports read-only only. Paths are plaintext
in `config.toml`. The workspace is execution context, not an availability rule,
so the alias remains callable from any directory.

## Credentials

Recognized environment variables take precedence and are recommended for
scripts and headless use. When no recognized environment credential is set, an
enabled release target may use the operating system's native credential store;
saved shortcut records never contain keys or credential identifiers.

Use the launcher's `Manage connections…` path to add, replace, or delete stored
fallbacks. See the [credentials guide](docs/credentials.md) for recognized
variables, native record behavior, compiled-target support, platform
prerequisites, and recovery when secure storage is unavailable.

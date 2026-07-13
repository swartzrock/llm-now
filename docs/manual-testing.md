# Manual testing guide

Use this guide to validate an `llm-now` release candidate from the native archives through provider calls, aliases, and the release workflow. Test the combined distribution branch or a tag reachable from `main`; do not treat source execution as a substitute for testing the packaged executables.

## Release criteria

A candidate is ready when:

- all five native executables launch without Bun or Node.js installed;
- help, version, prompt input, provider selection, aliases, output separation, diagnostics, and exit codes match the documented CLI contract;
- each supported provider completes at least one successful generation on a reference platform;
- no credential appears in stdout, stderr, alias files, or captured shell logs;
- no unexplained release-blocking manual failure remains.

Homebrew and Chocolatey are intentionally outside the current release scope. Do not test or publish package-manager integration unless a future version explicitly reintroduces it.

## Coverage matrix

### Native targets

| Target | Required coverage |
| --- | --- |
| macOS ARM64 | Full functional pass |
| macOS x64 | Native smoke |
| Linux x64 glibc | Full functional pass |
| Linux ARM64 glibc | Native smoke |
| Windows x64 baseline | Full functional pass |

A native smoke consists of checksum verification, extraction, `--help`, `--version`, invalid-usage behavior, one real generation, and operation without Bun or Node.js.

### Providers

Before general availability, complete one successful explicit generation for every supported provider:

- `ollama`
- `lm-studio`
- `codex-cli`
- `claude-cli`
- `anthropic`
- `openai`
- `google`
- `xai`
- `openrouter`

It is not necessary to test all nine providers on all five operating-system targets. Test every provider on one reference platform, then use one representative provider for the native smoke on each other target. Use a short, inexpensive prompt and do not classify normal model wording variation as an `llm-now` failure.

## Prepare an isolated test environment

Download the `release-assets` artifact from the successful workflow run for the exact commit under test. Perform functional tests outside the source checkout and never use the tester's real alias store.

### macOS and Linux

```bash
TEST_ROOT="$(mktemp -d)"
export XDG_CONFIG_HOME="$TEST_ROOT/config"
mkdir -p "$TEST_ROOT/work" "$TEST_ROOT/bin"
cd "$TEST_ROOT/work"

BIN="$TEST_ROOT/bin/llm-now"
```

Extract the matching executable to `$BIN`, then make it executable:

```bash
chmod +x "$BIN"
```

The default CI and `publish: false` artifacts are not Developer ID signed or notarized. On macOS, first verify the checksum, then remove the browser-applied quarantine attribute from that trusted test binary:

```bash
xattr -d com.apple.quarantine "$BIN"
```

Do not use this workaround for a `publish: true` public release. A signed and notarized release must pass Gatekeeper with its quarantine attribute intact.

### Windows PowerShell

```powershell
$TestRoot = Join-Path $env:TEMP ("llm-now-manual-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force $TestRoot | Out-Null
$env:APPDATA = Join-Path $TestRoot "Roaming"
$Bin = Join-Path $TestRoot "llm-now.exe"
```

Use a disposable VM or shell profile for tests that require no provider to be available. Do not uninstall or alter a developer's working CLI authentication.

## Artifact integrity and portability

### MT-01: Verify checksums

Verify every archive against `SHA256SUMS`.

Linux:

```bash
sha256sum -c SHA256SUMS
```

macOS:

```bash
shasum -a 256 -c SHA256SUMS
```

Windows:

```powershell
Get-FileHash .\llm-now-*.zip -Algorithm SHA256
```

Expected results:

- every archive matches the manifest;
- there is one archive for each supported target; and
- each archive contains only the expected `llm-now` or `llm-now.exe` executable;
- each archive entry has the source commit time, within ZIP's two-second timestamp precision, rather than January 1, 1980; and
- each macOS executable passes `codesign --verify --strict --verbose=2 "$BIN"` before it is run.

### MT-02: Run without Bun or Node.js

Use a VM or clean shell where Bun and Node.js are absent from `PATH`.

```bash
command -v bun
command -v node
"$BIN" --version
```

The first two commands should find no runtime. `llm-now --version` must still exit `0` and report the candidate version.

### MT-03: Run from arbitrary locations

Move the executable to a directory containing spaces and run it from a working directory outside the repository. Repeat `--help`, `--version`, and one generation. Behavior must not depend on the source checkout or current directory.

## Static CLI behavior

### MT-04: Help

```bash
"$BIN" --help >stdout.txt 2>stderr.txt
```

Repeat with `-h`. Both forms must exit `0`, write help only to stdout, leave stderr empty, and document input, selection, aliases, output channels, config locations, and exit codes.

### MT-05: Version

```bash
"$BIN" --version >stdout.txt 2>stderr.txt
```

The command must exit `0`, write exactly the version and its terminating newline to stdout, and leave stderr empty.

### MT-06: Invalid arguments

Run every case below. Each must exit `2`, leave stdout empty, write a useful `usage:` diagnostic to stderr, and make no provider call.

| Case |
| --- |
| Unknown flag |
| Positional argument |
| `--provider` without `--model` |
| `--model` without `--provider` |
| `--alias` combined with provider or model |
| Unknown provider |
| `--model default` with a non-CLI provider |
| Empty `--alias`, `--provider`, or `--model` |
| `--help` combined with another option |
| `--version` combined with another option |
| Both `--input` and piped stdin |
| Empty or whitespace-only stdin |
| Noninteractive input without an alias or explicit provider/model |

Representative command:

```bash
printf 'hello' | "$BIN" >stdout.txt 2>stderr.txt
status=$?
```

## Successful generation and output channels

### MT-07: Explicit provider and model

```bash
"$BIN" \
  --input "Reply briefly that the test succeeded." \
  --provider ollama \
  --model YOUR_MODEL \
  >stdout.bin 2>stderr.txt
```

The command must exit `0`, write only the model response to stdout, and leave stderr empty. Repeat on the reference platform for every provider in the provider matrix.

### MT-08: Piped input

```bash
printf 'Explain what a CLI is in one sentence.' |
  "$BIN" --provider ollama --model YOUR_MODEL \
  >stdout.bin 2>stderr.txt
```

The command must exit `0`, produce a nonempty stdout response, leave stderr empty, and ask no interactive question.

### MT-09: CLI-provider default model

```bash
printf 'Reply with a short greeting.' |
  "$BIN" --provider claude-cli --model default
```

Repeat with `codex-cli`. Both must use the authenticated CLI's default model. Confirm that `default` remains a usage error for every non-CLI provider.

### MT-10: Interactive discovery

Make at least two providers available, then run:

```bash
"$BIN" --input "Write a two-line poem about rain." >stdout.txt
```

Keep stderr attached to the terminal. Confirm that:

- with no saved aliases, the provider picker opens directly on stderr;
- providers and models are sorted deterministically, and typing filters each list without changing the selected raw identifier;
- selecting a provider displays its filtered model picker;
- arrow keys and Enter select the highlighted option, while Ctrl-C cancels;
- the final response appears only in `stdout.txt`;
- the response is followed by a clean terminal boundary on stderr even when it has no trailing newline or leaves SGR styling active;
- the green contextual alias field names the selected provider and raw model, shows dim `e.g. fast`, and explains that Enter exits; and
- machine-controlled work completes within approximately 60 seconds, excluding human menu time.

## Alias lifecycle

### MT-11: Save an alias

After an unnamed interactive success, enter `daily` in the contextual alias field. Confirm the green success message names `daily` and the exact provider/model target, then inspect the isolated alias file. It must have this shape:

```json
{
  "version": 1,
  "aliases": {
    "daily": {
      "provider": "PROVIDER_ID",
      "model": "MODEL_ID"
    }
  }
}
```

The model value is `null` when a supported CLI provider uses its default. Confirm that no key, token, endpoint credential, prompt, or generated text is stored. On Unix, the directory must have mode `700` and the file mode `600`. No lock or temporary file should remain.

### MT-12: Use an alias from another directory

First run an interactive call with no explicit selection. Confirm that the sorted alias picker appears before discovery, typing `dai` filters to `daily`, and selecting it bypasses provider/model discovery and does not show another alias field. Then verify deterministic non-interactive reuse from another directory:

```bash
cd /
printf 'Summarize the idea of gravity.' |
  "$BIN" --alias daily >stdout.txt 2>stderr.txt
```

The command must exit `0`, resolve the alias independently of the working directory, write only the response to stdout, and skip the alias-save prompt.

### MT-13: Decline alias saving

Complete an unnamed interactive generation and press Enter without typing a name. Repeat and cancel the field with Ctrl-C. Both commands must exit `0` without creating or modifying the alias file.

### MT-14: Validate alias names

Try these names through the save prompt:

- valid: `daily`, `Daily`, and `work_model-2`;
- invalid: ` bad`, `with space`, `a/b`, and a name longer than 64 characters.

Invalid names must show Clack's alias-name validation guidance and reprompt. An empty field exits without saving. Names are case-sensitive, so `daily` and `Daily` may coexist.

### MT-15: Handle alias collisions

Save `daily`, then complete another unnamed call with the same provider/model and enter `daily`. The CLI must report that the target is already saved without asking to overwrite it. Next complete a call with another provider/model and enter `daily`. Confirm the prompt shows the old and new targets and defaults to No. First decline the overwrite: the command must exit `0` and leave the record unchanged. Repeat and accept the overwrite: only `daily` should change, with every other alias preserved.

### MT-16: Fail closed on missing or stale aliases

```bash
printf 'hello' | "$BIN" --alias missing
```

Then edit an isolated alias to reference a nonexistent model and run it. A missing alias must exit `1` with a `config:` diagnostic. A stale model must exit `1` with a `generation (provider):` diagnostic. Neither case may select or invoke a replacement provider.

### MT-17: Reject corrupt alias files

Replace the isolated alias file first with malformed JSON, then with a structurally invalid record containing an extra `apiKey` field. Both calls must exit `1`, identify a configuration load failure, preserve the corrupt content for diagnosis, and avoid generation.

### MT-18: Resolve platform config paths

Verify that:

- an absolute `XDG_CONFIG_HOME` is used on macOS and Linux;
- an absolute `APPDATA` is used on Windows;
- when those variables are absent, the documented home-directory fallback is used; and
- relative `XDG_CONFIG_HOME` or `APPDATA` values are ignored in favor of the fallback.

Use a temporary `HOME` or `USERPROFILE` for fallback tests.

## Discovery and failure behavior

### MT-19: Report no available providers

In a clean VM or profile, ensure there is no Ollama server on port 11434, no LM Studio server on port 1234, no authenticated `codex` or `claude` command on `PATH`, and no recognized cloud-provider key variable. Run:

```bash
"$BIN" --input "hello"
```

The command must exit `1`, leave stdout empty, list every checked provider category and manual setup guidance on stderr, and avoid starting software, downloading models, creating credentials, or creating aliases.

### MT-20: Cancel provider or model selection

Press Ctrl-C at the alias picker. The command must exit `130`, leave stdout empty, and perform no generation or alias save. Repeat at the provider picker, then again at the model picker after choosing a provider. If the isolated store has no aliases, skip the alias-picker case.

### MT-21: Recover from a model-list failure

Make two providers discoverable, with the first unable to list models. Selecting the failing provider must produce a `model-list (provider):` diagnostic, remove that provider from the current selection set, and offer the remaining provider. If no provider remains, the command must exit `1`.

### MT-22: Do not fall back after explicit generation failure

Call a valid provider with a deliberately nonexistent model. The command must exit `1`, leave stdout empty, identify `generation (provider):` on stderr, and avoid calling another available provider.

### MT-23: Redact credentials

Use a fake sentinel credential in an isolated shell, never a real secret:

```bash
export OPENAI_API_KEY="LLM_NOW_SECRET_SENTINEL_93842"
```

Force an OpenAI failure and capture stderr. The sentinel must not appear in stdout or stderr; if an underlying message contains it, the diagnostic must show `[REDACTED]`.

## Release workflow

These tests are maintainer-only and occur after the implementation branches merge in order.

### MT-24: Unsigned release candidate

1. Confirm the package version.
2. Create an existing `vX.Y.Z` tag reachable from `main`.
3. Dispatch the `Release candidate` workflow with `tag: vX.Y.Z` and `publish: false`.
4. Download `release-assets` and repeat the checksum and native smoke tests.

The workflow must validate the tag/version/main ancestry, build all five targets, generate `SHA256SUMS`, and publish no GitHub Release or signed artifact.

The macOS executable must have a valid ad-hoc signature, but it is not trusted by Gatekeeper as a public download. After checksum verification, use the quarantine-removal step in the preparation section for this unsigned test artifact.

### MT-25: Signed public release

Run only when publication is explicitly authorized. Confirm that:

- macOS executables pass `codesign --verify` and `spctl --assess`;
- Windows reports a valid Authenticode signature;
- GitHub Release assets match `SHA256SUMS`;
- browser-downloaded macOS artifacts pass Gatekeeper without manual quarantine removal; and
- each downloaded executable passes `--help` and `--version` on a clean target machine.

## Automation-backed coverage

Keep the Bun test suite as the authority for behavior that is difficult or unreliable to verify manually:

- exact 5/10/45-second timeout boundaries;
- byte-for-byte output fidelity, including an absent trailing newline;
- exact stderr boundary behavior for responses with and without trailing newlines;
- sorted, canonical alias/provider/model option identity and Clack type-ahead behavior;
- Picocolors output under TTY, `NO_COLOR`, and non-TTY conditions;
- ANSI and control-sequence stripping;
- diagnostic truncation at 1,024 characters;
- concurrent alias writers and stale-lock recovery; and
- atomic rename failure handling.

## Test report

Record the following for every test session:

```text
Candidate commit:
Artifact filename:
Artifact SHA-256:
OS and version:
Architecture:
Install method:
Provider/model:
Test IDs:
Pass/fail:
Observed exit code:
stdout evidence:
stderr evidence:
Alias-file evidence:
Duration:
Cleanup completed:
Notes/issues:
```

Any secret leakage, wrong-provider fallback, stdout contamination, corrupt-alias replacement, checksum mismatch, or inability to run without Bun or Node.js blocks release.

See the [README](../README.md), [CLI argument contract](../src/args.ts), and [release workflow](../.github/workflows/release.yml) for the source-of-truth behavior.

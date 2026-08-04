# Manual testing guide

Use this guide to validate an `llm-now` release candidate from the native archives through provider calls, aliases, and the release workflow. Test the combined distribution branch or a tag reachable from `main`; do not treat source execution as a substitute for testing the packaged executables.

## Release criteria

A candidate is ready when:

- all five native executables launch without Bun or Node.js installed;
- help, version, prompt input, provider selection, aliases, output separation, diagnostics, and exit codes match the documented CLI contract;
- every target with native credential storage enabled passes the compiled production-adapter lifecycle gate in its representative user session;
- each supported provider completes at least one successful generation on a reference platform;
- no credential appears in stdout, stderr, alias files, or captured shell logs;
- shortcut inventory and diagnostics do not disclose saved instruction text or instruction-bearing child-process arguments;
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

A native smoke consists of checksum verification, extraction, `--help`, `--version`, alias inventory, invalid-usage behavior, one real generation, and operation without Bun or Node.js.

Native credential storage is additionally gated on each explicitly enabled target for Bun 1.3.14. macOS uses Keychain, Windows uses Credential Manager, and Linux uses Secret Service. Linux coverage requires a real isolated D-Bus user session and unlocked test collection; a platform name without that session is not evidence of availability. macOS x64 remains buildable but environment-only because its Bun 1.3.14 lifecycle gate failed.

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

## Branch-built PTY launcher acceptance

Run these supplemental scenarios from the exact implementation branch before packaging. They exercise a real terminal against an explicit compiled executable; they do not replace the native-archive checks below. Do not start a development server.

On macOS or Linux, from the repository root:

```bash
PTY_ROOT="$(mktemp -d)"
mkdir -p "$PTY_ROOT/bin" "$PTY_ROOT/config" "$PTY_ROOT/work"
BRANCH_SHA="$(git rev-parse HEAD)"
BRANCH_BIN="$PTY_ROOT/bin/llm-now-$BRANCH_SHA"
FAKE_CODEX="$PTY_ROOT/bin/codex"

bun build ./index.ts --compile --outfile "$BRANCH_BIN"
bun build ./tests/fixtures/fake-cli.ts --compile --outfile "$FAKE_CODEX"
chmod +x "$BRANCH_BIN" "$FAKE_CODEX"

export XDG_CONFIG_HOME="$PTY_ROOT/config"
export PATH="$PTY_ROOT/bin"
export SHELL="$PTY_ROOT/bin/missing-login-shell"
cd "$PTY_ROOT/work"
```

The maintained fake `codex` fixture provides credential-free provider discovery, model listing, and generation. Keep stdin and stderr attached to the PTY; redirect stdout where each scenario says to do so. Use a fresh `PTY_ROOT` when an empty store is required.

### SC-01: Empty root is exact and lazy

Run `"$BRANCH_BIN" >stdout.bin`, without selecting an action. The root must contain exactly, in order:

1. `Create a new shortcut…`
2. `Run once with a provider and model…`
3. `Manage connections…`

It must not show a saved-shortcut row. Merely rendering the root must perform no discovery, model listing, generation, credential read, or write. Cancel with Escape, then repeat with Ctrl-C. Each must exit `130`, leave stdout empty, and leave the isolated config unchanged.

### SC-02: Create from an available provider and run it once

From the empty root, choose `Create a new shortcut…`. Confirm `How should this shortcut connect?` offers exactly `Use an available provider…` followed by `Add a provider with an API key…`, with no discovery before a source is chosen. Select the available-provider route, then the fake Codex provider and its safe model. At `Name this shortcut`, enter `daily`. Confirm the visible `Optional instructions for this shortcut (blank for none; Tab then Enter to save text)` field and `[ save ]` action appear next. Paste `Use "quoted" runtime smoke \ transport.` followed by a newline and `Keep each answer concise.`, press Tab to focus `[ save ]`, then press Enter to submit it.

When `Prompt for daily · Codex CLI · MODEL` appears, inspect the isolated alias file from a second terminal before entering a prompt. It must be a version 2 document whose `daily` record contains only `provider`, `model`, and the exact `instructions` string; no prompt, response, or credential may be present. Enter `smoke`. The command must generate exactly once, exit `0`, and write only `fake:instruction-present` to `stdout.bin`. The shortcut-save receipt must precede the work prompt on stderr.

### SC-03: Configured root and saved-shortcut route

Run bare `"$BRANCH_BIN" >stdout.bin` after SC-02. The configured root must contain exactly, in order:

1. `Run with a saved shortcut…`
2. `Create a new shortcut…`
3. `Run once with another provider and model…`
4. `Manage connections…`

Choose the saved-shortcut route, filter to `daily`, and confirm `Prompt for daily · Codex CLI · MODEL`. Enter `smoke`. It must write only `fake:instruction-present` to stdout and generate once without discovery, model listing, or another shortcut offer. Neither the prompt UI nor the root inventory may display the saved instruction text or an instruction-presence marker.

### SC-04: True run once never saves

Record a checksum or byte-for-byte copy of the alias file. From both empty and configured roots, choose the state-appropriate `Run once…` action, select the fake provider/model, and enter `smoke` at `Prompt for Codex CLI · MODEL`.

Each invocation must write only `fake:instruction-absent`, generate exactly once, and exit without showing an instruction, naming, save, or overwrite prompt. The alias file must remain byte-for-byte unchanged, including when the selected target already belongs to instructed shortcut `daily`.

### SC-05: Cancellation before durable work

With a fresh empty store, repeat shortcut creation and cancel separately at the root, `How should this shortcut connect?`, provider picker, model picker, `Name this shortcut`, and the optional-instructions field. Each cancellation must exit `130`, generate nothing, leave stdout empty, and create neither a credential nor a shortcut. Repeat at the run-once provider, model, and work prompts with the same result.

### SC-06: Cancellation after a shortcut write

Create a shortcut, submit its optional instructions, and wait until its save receipt and contextual first prompt appear. Cancel that prompt with Escape, then repeat with Ctrl-C using another name. Each invocation must exit `0`, preserve the complete saved shortcut including instructions, report that creation completed but generation did not, and leave stdout empty. Running the saved shortcut with `smoke` on a later invocation must write `fake:instruction-present`.

### SC-07: Required naming and collision handling

Create the same name, target, and instructions again. It must report the identical saved shortcut and continue to the first prompt without rewriting unrelated aliases. Recreate it three more times to add instructions to an instruction-free record, change the existing text, and remove it by submitting a blank field. Each change must show an overwrite confirmation whose `Instructions:` line says `none → set`, `set → changed`, or `set → none`, and defaults to No. Declining must return to `Name this shortcut` with the existing record unchanged; accepting must replace only that shortcut before its first prompt. Also repeat with a different safe provider/model and confirm the old and new targets are shown.

### SC-08: API-key creation without credential exposure

First use the maintained test suite’s injected fake candidate to exercise the full successful transaction without a network credential:

From the repository root in a separate terminal with its normal Bun `PATH`:

```bash
bun test tests/app.test.ts --test-name-pattern "adds a missing API-key provider"
```

For the real PTY boundary, use only a dedicated disposable provider test account and a temporary revocable key. Disable terminal recording before entry. Never assign the key to a shell variable, put it in arguments/stdin, paste it into notes, or include it in the test report. Select `Create a new shortcut…`, `Add a provider with an API key…`, and an eligible provider, then paste the key only into the hidden field.

Confirm validation happens before the default-No save consent. Accept saving, then cancel once at model selection or naming: the key receipt must remain visible, the invocation must exit `0`, no shortcut may exist, and no secret may appear in stdout, stderr, config files, or shell logs. Repeat with a new isolated account/store through model choice, shortcut save, and one first prompt; the key must be durable before the shortcut, the shortcut before generation, and the response must be the only stdout bytes. Revoke the temporary key and delete the disposable native-vault record immediately afterward.

### SC-09: Management remains separate

Choose `Manage connections…` from either root. Its menu must contain only `Discover available providers…` and `Add or manage API keys…`. Opening either the root or management menu alone must not discover providers or access the credential store. Addition, replacement, and deletion remain available here; replacement and deletion must not appear inside shortcut creation.

### SC-10: Direct invocation, bypass, and redirected stdout

With instructed shortcut `daily` configured, run the maintained fake fixture’s exact prompt:

```bash
"$BRANCH_BIN" daily --input "smoke" >stdout.bin 2>stderr.txt
printf 'smoke' | "$BRANCH_BIN" daily >stdout.bin 2>stderr.txt
"$BRANCH_BIN" --alias daily --input "smoke" >stdout.bin 2>stderr.txt
"$BRANCH_BIN" --provider codex-cli --model default --input "smoke" >stdout.bin 2>stderr.txt
```

Arguments, `--input`, piped stdin, and noninteractive execution must bypass the launcher deterministically. The three alias calls must each write only `fake:instruction-present`; the explicit call must write only `fake:instruction-absent`. Existing alias/direct terminology, diagnostics, exit codes, and redaction remain unchanged. Fail one fixture call deliberately and confirm the fixed diagnostic does not echo child-process arguments or saved instructions. Also run bare `"$BRANCH_BIN" >stdout.bin` with stderr attached to the PTY and complete one launcher action; menus and prompts must remain on stderr while only the model response reaches the redirected file.

### User-owned visual gate

The implementation may open as a draft pull request with only the updated VHS source. Before that draft is marked ready, merged, or released, the user must render `docs/demos/demo.gif` from the committed tape against the explicit branch-built executable, review the animation for exact copy and credential-free behavior, and commit the refreshed GIF. Agents must not render or modify the GIF or other binary media for this change.

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
$Manifest = Get-Content .\SHA256SUMS
foreach ($Line in $Manifest) {
  $Expected, $Archive = $Line -split '\s+', 2
  $Actual = (Get-FileHash (".\" + $Archive) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Expected.ToLowerInvariant() -ne $Actual) { throw "SHA-256 mismatch for $Archive" }
  "SHA-256 verified: $Archive"
}
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
| Empty or whitespace-only positional alias |
| Two positional aliases (the second is never prompt text) |
| Positional alias combined with `--alias`, `--provider`, or `--model` |
| `--provider` without `--model` |
| `--model` without `--provider` |
| `--alias` combined with provider or model |
| Unknown provider |
| `--model default` with a non-CLI provider |
| Empty `--alias`, `--provider`, or `--model` |
| `--help` combined with another option |
| `--version` combined with another option |
| `--help` or `--version` combined with a positional alias, in either order |
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

### MT-10: Adaptive launcher and interactive discovery

Repeat SC-01 through SC-10 against the packaged candidate, starting with an isolated empty alias store and at least two available providers. Run the bare executable with stdout redirected:

```bash
"$BIN" >stdout.txt
```

Keep stderr attached to the terminal. Confirm the empty root asks `What would you like to do?` and contains, in exact order, `Create a new shortcut…`, `Run once with a provider and model…`, and `Manage connections…`. After creating `daily`, the configured root must contain, in exact order, `Run with a saved shortcut…`, `Create a new shortcut…`, `Run once with another provider and model…`, and `Manage connections…`.

Opening either root and opening the creation-source menu must not display discovery progress or access a provider or credential. Exercise both `Use an available provider…` and `Add a provider with an API key…`, and confirm that:

- providers and models are sorted deterministically, and typing filters each list without changing the selected raw identifier;
- selecting a provider displays its filtered model picker;
- arrow keys and Enter select the highlighted option;
- the final response appears only in `stdout.txt`;
- the response is followed by a clean terminal boundary on stderr even when it has no trailing newline or leaves SGR styling active;
- shortcut creation visibly requests optional multiline instructions after naming, preserves pasted line breaks, saves before its contextual first prompt, and generates exactly once;
- each saved-shortcut call transmits its instructions separately from the prompt, subject to the selected provider's policies;
- run once generates without an instruction, shortcut naming, or save offer;
- connection management retains only discovery and API-key management; and
- machine-controlled work completes within approximately 60 seconds, excluding human menu time.

Cancel before and after each durable boundary. Pre-write cancellation must exit `130` without mutation. Cancellation after a key or shortcut receipt must preserve the completed write, report the incomplete later step, exit `0`, and generate nothing. A delegated CLI model must appear as `default model`.

## Alias lifecycle

### MT-11: Save an alias

Run an interactive direct fresh selection such as `"$BIN" --input "Save this target"` with no alias or explicit provider/model. After generation, enter `daily` in the optional contextual alias field. Confirm the green success message names `daily` and the exact provider/model target, then inspect the isolated alias file. It must have this shape:

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

Submit a blank value at the visible optional-instructions field for this first save. The model value is `null` when a supported CLI provider uses its default. Confirm that no key, token, endpoint credential, prompt, generated text, or `instructions` key is stored and that the file remains version 1.

Next recreate `daily` and paste two visible instruction lines: `You are a Realtime Voice Agent Architect` and `Focus on interruption handling.` Accept the default-No overwrite only after confirming the transition is `none → set`. The alias file must become version 2 and preserve the exact line break:

```json
{
  "version": 2,
  "aliases": {
    "daily": {
      "provider": "PROVIDER_ID",
      "model": "MODEL_ID",
      "instructions": "You are a Realtime Voice Agent Architect\nFocus on interruption handling."
    }
  }
}
```

Confirm that ordinary multiline input is accepted, while tabs, non-newline control characters, and Unicode line separators are rejected. Do not enter a secret or data that cannot be disclosed to the provider: instructions are plaintext configuration. On Unix, the directory must have mode `700` and the file mode `600`. No lock or temporary file should remain.

### MT-12: Use an alias from another directory

First run the bare command and choose “Run with a saved shortcut…”. Confirm that the focused
“Choose a saved shortcut” picker is sorted, typing `dai` filters to `daily`, and selecting it
bypasses provider/model discovery and does not show another alias field. Repeat through
`Run once with another provider and model…`, choose the provider/model already stored as
`daily`, and confirm the CLI may report that existing alias but does not show a naming, save,
or overwrite field. Then verify deterministic non-interactive reuse from another directory:

```bash
mkdir -p "$TEST_ROOT/alias-reuse"
cd "$TEST_ROOT/alias-reuse"
rm -f stdout.txt stderr.txt
"$BIN" daily >stdout.txt
```

The terminal must show `Prompt for daily · PROVIDER · MODEL`, using `default model` only when the alias has no pinned model. It must not display the saved instruction text. Submit whitespace first and confirm validation keeps the field open, then enter `Summarize the idea of gravity.`. The command must transmit the saved instruction separately from that prompt, generate exactly once, exit `0`, and leave `stdout.txt` containing only the response even though stdout was redirected. Repeat the alias-only command with Escape and Ctrl-C; each cancellation must exit `130`, generate nothing, and leave stdout empty.

Then verify deterministic reuse:

```bash
printf 'Summarize the idea of gravity.' |
  "$BIN" daily >stdout.txt 2>stderr.txt
```

Repeat as `"$BIN" daily --input 'Summarize the idea of gravity.'` and with the
long form `"$BIN" --alias daily --input 'Summarize the idea of gravity.'`. The commands
must exit `0`, resolve the spelling-exact alias independently of option order and the
working directory, write only the response to stdout, and skip the alias-save prompt. Repeat
with `Daily` and `DAILY`; both must resolve the same lowercase `daily` record. A misspelling
such as `dailly` must fail instead of selecting `daily`. Also
verify that aliases named `help`, `version`, and `run` work when supplied as bare positional
names; only `--help` and `--version` select those standalone modes. Finally, run an explicit
provider/model selection without `--input` and confirm it retains the usage error instead of
opening the alias-only prompt.

### MT-13: List configured aliases

Write this document to the isolated alias path (`$XDG_CONFIG_HOME/llm-now/aliases.json`
on macOS/Linux or `$env:APPDATA\llm-now\aliases.json` on Windows), preserving
the deliberately unsorted source order:

```json
{
  "version": 2,
  "aliases": {
    "zeta": { "provider": "openai", "model": "gpt-5" },
    "aliases": {
      "provider": "codex-cli",
      "model": null,
      "instructions": "inventory must not print this"
    }
  }
}
```

Run the standalone inventory with piped input to prove stdin is ignored:

```bash
printf 'ignored prompt' | "$BIN" --aliases >stdout.txt 2>stderr.txt
status=$?
```

The command must exit `0`, leave stderr empty, and write exactly these sorted,
uncolored rows plus the final newline to stdout, with no header or alignment
padding:

```text
aliases → Codex CLI · provider default
zeta → OpenAI · gpt-5
```

It must not print instruction text or an instruction-presence marker, prompt,
discover providers, list models, access credentials, generate text, or mutate
the alias file.

### MT-14: List an empty inventory

Remove the alias file from the isolated config directory and run:

```bash
"$BIN" --aliases >stdout.bin 2>stderr.txt
status=$?
test "$status" -eq 0
test ! -s stdout.bin
test ! -s stderr.txt
```

A missing store and a valid store with an empty `aliases` object must both exit
`0` with zero stdout and stderr bytes and no prompt, provider, runtime,
credential, or mutation work.

### MT-15: Reject alias-inventory combinations

Run `--aliases` separately with `--input`, a positional alias, `--alias`,
`--provider`, `--model`, `--help`, `-h`, and `--version`. Representative cases:

```bash
"$BIN" --aliases --input hello >stdout.txt 2>stderr.txt
"$BIN" --aliases daily >stdout.txt 2>stderr.txt
```

Every combination must exit `2`, leave stdout empty, write a `usage:`
diagnostic to stderr, and perform no alias load, prompt, provider, runtime,
credential, or mutation work.

### MT-16: Reject invalid alias stores during inventory

Replace the isolated alias file with malformed JSON and run `"$BIN" --aliases`.
Then repeat with case-only entries that point to different targets:

```json
{
  "version": 1,
  "aliases": {
    "Fred": { "provider": "claude-cli", "model": null },
    "FRED": { "provider": "openai", "model": "gpt-5" }
  }
}
```

Where the operating system supports a reliable permission-denied fixture,
repeat once with an unreadable alias file. Every invalid, unreadable, or
case-conflicting store must exit `1`, leave stdout empty, write the existing
actionable `config:` diagnostic to stderr, preserve the store, and perform no
prompt, provider, runtime, credential, or mutation work.

### MT-17: Preserve a positional alias named aliases

Restore the MT-13 alias document, make the configured Codex CLI available, and
run:

```bash
"$BIN" aliases --input "Reply briefly that positional alias generation succeeded." \
  >stdout.txt 2>stderr.txt
```

The command must exit `0`, invoke generation through the saved `aliases`
record, write only the generated response to stdout, and leave stderr empty. It
must not print the inventory; only the standalone `--aliases` option selects
inventory mode.

### MT-18: Decline alias saving

Complete an interactive direct fresh selection using `--input`, then press Enter without typing a name in its legacy optional alias follow-up. Repeat and cancel the field with Ctrl-C. Both commands must exit `0` without creating or modifying the alias file. Launcher run-once work must not show this field at all.

### MT-19: Validate alias names

Try these names through the save prompt, using a fresh isolated store when
needed:

- valid: `daily`, `Daily`, and `work_model-2`;
- invalid: ` bad`, `with space`, `a/b`, and a name longer than 64 characters.

Invalid names must show Clack's alias-name validation guidance and reprompt. An
empty field exits without saving. Valid mixed-case input is accepted but stored
and displayed in lowercase. `daily` and `Daily` are one logical alias and cannot
coexist as separate targets.

### MT-20: Handle alias collisions

Save `Daily` and confirm the file contains the canonical key `daily`. Complete
`Create a new shortcut…` with the same provider/model, instructions, and the
name `DAILY`. The CLI must report that the shortcut is already saved and
continue to the first prompt without asking to overwrite it. Repeat with the
same target while adding, changing, and removing instructions. Confirm the
prompt identifies canonical alias `daily`, reports the matching `none → set`,
`set → changed`, or `set → none` instruction transition, and defaults to No. First
decline each overwrite and confirm the record is unchanged; then accept and
confirm only `daily` changes. Finally repeat for another provider/model. The
durable receipt must precede its first prompt, and every other alias must remain
preserved.

### MT-21: Fail closed on missing or stale aliases

```bash
printf 'hello' | "$BIN" --alias missing
```

Then edit an isolated alias to reference a nonexistent model and run it. A missing alias must exit `1` with a `config:` diagnostic. A stale model must exit `1` with a `generation (provider):` diagnostic. Neither case may select or invoke a replacement provider.

### MT-22: Reject corrupt alias files

Replace the isolated alias file first with malformed JSON, then with a
structurally invalid record containing an extra `apiKey` field. Both calls must
exit `1`, identify a configuration load failure, preserve the corrupt content
for diagnosis, and avoid generation.

Next write a valid legacy file containing `fred` and `Fred` with identical
provider/model records. Loading or invoking either capitalization must succeed
without rewriting the file. Save an unrelated alias, then confirm that the
successful write persists `fred` and the new alias as lowercase keys with only
one `fred` record.

Restore a clean version 1 file and save a shortcut with blank instructions;
the file must remain version 1. Add instructions to any shortcut and confirm
the whole document upgrades to version 2 while all provider/model records are
preserved. Remove the final instruction and confirm the document remains
version 2 rather than silently downgrading.

Exercise downgrade recovery without risking the only copy: copy the version 2
file while preserving its original mode, leave that backup untouched, and
manually create a restrictive-permission version 1 file containing only each
alias's `provider` and `model`. Confirm this intentionally drops every
instruction and works with the older binary under test. Prefer reinstalling a
version-2-compatible binary instead; a pre-version-2 binary may reject alias
operations while the version 2 file is present. Confirm an explicit
`--provider`/`--model` call remains available for recovery without using an
alias.

Finally, give `fred` and `Fred` different provider/model records. Any command
that loads aliases must exit `1` before generation, preserve the file, and
report a configuration diagnostic that identifies both conflicting entries,
their targets, the canonical name `fred`, and the alias-file path with repair
guidance. It must never select either target.

### MT-23: Resolve platform config paths

Verify that:

- an absolute `XDG_CONFIG_HOME` is used on macOS and Linux;
- an absolute `APPDATA` is used on Windows;
- when those variables are absent, the documented home-directory fallback is used; and
- relative `XDG_CONFIG_HOME` or `APPDATA` values are ignored in favor of the fallback.

Use a temporary `HOME` or `USERPROFILE` for fallback tests.

### MT-23A: Verify safe instruction transport boundaries

Use only the maintained fake Codex fixture and the non-secret multiline instruction
`Use "quoted" runtime smoke \ transport.\nKeep each answer concise.`. The packaged smoke must pass that
instruction per invocation for an alias call and receive
`fake:instruction-present`; the otherwise identical explicit call must receive
`fake:instruction-absent`. The fixture `PATH` must contain only the temporary
fixture directory, and non-Windows runs must set `SHELL` to a nonexistent file,
so no real CLI or LLM can be selected. The loopback fake Ollama check may still
run, but no external network request is permitted.

Confirm failure diagnostics are fixed text and do not echo child-process
arguments. CLI-backed providers may nevertheless place instructions in their
child-process arguments, where local process inspection or audit tools can see
them. Provider-side use, retention, and precedence are governed by each
provider's policies; do not treat the credential blocker or diagnostic
redaction as authorization to store secrets or undisclosable data.

## Discovery and failure behavior

### MT-24: Report no available providers

In a clean VM or profile, ensure there is no Ollama server on port 11434, no LM Studio server on port 1234, no authenticated `codex` or `claude` command on `PATH`, and no recognized cloud-provider key variable. Run:

```bash
"$BIN" --input "hello"
```

The command must exit `1`, leave stdout empty, list every checked provider category and manual setup guidance on stderr, and avoid starting software, downloading models, creating credentials, or creating aliases.

### MT-25: Cancel provider or model selection

Press Ctrl-C at the alias picker. The command must exit `130`, leave stdout empty, and perform no generation or alias save. Repeat at the provider picker, then again at the model picker after choosing a provider. If the isolated store has no aliases, skip the alias-picker case.

### MT-26: Recover from a model-list failure

Make two providers discoverable, with the first unable to list models. Selecting the failing provider must produce a `model-list (provider):` diagnostic, remove that provider from the current selection set, and offer the remaining provider. If no provider remains, the command must exit `1`.

### MT-27: Do not fall back after explicit generation failure

Call a valid provider with a deliberately nonexistent model. The command must exit `1`, leave stdout empty, identify `generation (provider):` on stderr, and avoid calling another available provider.

### MT-28: Redact credentials

Use a fake sentinel credential in an isolated shell, never a real secret:

```bash
export OPENAI_API_KEY="LLM_NOW_SECRET_SENTINEL_93842"
```

Force an OpenAI failure and capture stderr. The sentinel must not appear in stdout or stderr; if an underlying message contains it, the diagnostic must show `[REDACTED]`.

## Release workflow

These tests are maintainer-only. Run them in order while commissioning the reviewed release train, and do not merge another `chore: release` pull request until the previous promotion finishes.

Keep this feature pull request draft while local verification resolves
`file:../cuecraft/byok-runtime` at sibling commit
`f4dfa32ab27ce881cd9aa42203e42e6d8ad65396`; hosted CI cannot install that
sibling path. After the compatible runtime minor is published, restore the
registry dependency, regenerate and audit `bun.lock` to remove sibling-only
resolution, and run the full five-target native matrix. Only then may the pull
request be marked ready.

### MT-29: Unsigned release candidate

1. Fetch protected `main` and select any full commit SHA reachable from it. No tag is needed.
2. Dispatch `release.yml` with that SHA and `publish: false`:

   ```bash
   git fetch origin main
   RELEASE_SHA="$(git rev-parse origin/main~0)"
   test "$(printf '%s' "$RELEASE_SHA" | wc -c | tr -d ' ')" = 40
   git merge-base --is-ancestor "$RELEASE_SHA" origin/main
   gh workflow run release.yml --ref main \
     -f release-sha="$RELEASE_SHA" \
     -f publish=false
   ```

3. Download `release-assets` from the completed run and repeat the checksum and native smoke tests.

The workflow must validate the SHA and protected-`main` ancestry, build all five targets, generate `SHA256SUMS`, and request neither protected environment. It must create no tag, attestation, or GitHub Release.

The macOS executable must have a valid ad-hoc signature, but it is not trusted by Gatekeeper as a public download. After checksum verification, use the quarantine-removal step in the preparation section for this unsigned test artifact.

### MT-30: First generated release PR CI

1. In repository Actions settings, allow GitHub Actions to create pull requests with the repository token.
2. Merge a feature pull request containing a non-empty `.changeset/*.md` file.
3. Confirm the `Changesets` workflow creates or updates exactly one `chore: release` pull request.
4. Review its `package.json` bump, matching `CHANGELOG.md` section, and deletion of the consumed Changeset. Confirm it contains no npm publication or release tag.
5. Confirm the repository-token-created pull request checks appear as approval-required. Have a maintainer explicitly approve the workflow runs.
6. Wait for the normal source checks, all five native target checks, and exact-asset assembly to pass. Confirm branch protection treats them like the checks on an ordinary pull request.

Leave the reviewed release pull request open until MT-31 is ready. If its checks do not appear, cannot be approved, or do not satisfy branch protection, stop and correct repository settings before merging it.

### MT-31: First tag-last public release

Run only when publication is explicitly authorized. Before dispatch:

1. Confirm the repository is public and eligible to issue GitHub artifact attestations.
2. Confirm the `release-signing` and `release-publication` environments have the intended required reviewers and only the signing environment contains Apple credentials.
3. Commission the `v*` tag rule: the protected publication actor may create a new tag, while other actors cannot move or delete release tags.
4. Confirm the intended `vX.Y.Z` tag and Release do not exist and no higher stable Release is public.
5. Merge the approved `chore: release` pull request from MT-30. Record its exact merge SHA and version:

   ```bash
   git fetch origin main
   RELEASE_SHA="$(git rev-parse origin/main)"
   VERSION="$(git show "$RELEASE_SHA:package.json" | bun -p 'JSON.parse(await Bun.stdin.text()).version')"
   TAG="v$VERSION"
   ```

6. Confirm the push starts `Release`, and its classifier promotes the exact release SHA with publication enabled. The event's `before` SHA must be the release commit's first parent, and the diff must contain the stable version increase, matching changelog section, and a consumed Changeset deletion.
7. Confirm both macOS jobs wait for and receive `release-signing` approval. Before granting `release-publication` approval, confirm the release tag still does not exist.
8. Grant `release-publication` approval. Confirm checksum verification and artifact attestation finish before the workflow creates the tag, verifies it at `RELEASE_SHA`, and creates the GitHub Release.

If automatic promotion fails before creating the tag and newer commits later reach `main`, rerun the original automatic workflow run. Do not manually dispatch from the newer `main` ref: a public run requires `release-sha` to equal the selected ref's `GITHUB_SHA`, preserving attestation provenance.

After publication, confirm the tag peels to the exact release commit:

```bash
git fetch origin --tags
test "$(git rev-parse "${TAG}^{commit}")" = "$RELEASE_SHA"
```

Download the public assets to an empty directory and confirm there are exactly six: five ZIPs plus `SHA256SUMS`.

- `llm-now-vX.Y.Z-macos-x64.zip`
- `llm-now-vX.Y.Z-macos-arm64.zip`
- `llm-now-vX.Y.Z-linux-x64.zip`
- `llm-now-vX.Y.Z-linux-arm64.zip`
- `llm-now-vX.Y.Z-windows-x64.zip`
- `SHA256SUMS`

`RELEASE_NOTES.md` must not be a public asset; it is the private workflow artifact used as the GitHub Release body.

Complete these trust and integrity gates:

- verify all five final archives against `SHA256SUMS` using MT-01;
- run `codesign --verify --strict --verbose=2` and `codesign -vvvv -R="notarized" --check-notarization` for both macOS executables;
- confirm browser-downloaded macOS executables pass Gatekeeper with quarantine intact; and
- verify every ZIP's attestation names this repository's release workflow and exact `RELEASE_SHA`:

```bash
for archive in llm-now-*.zip; do
  gh attestation verify "$archive" \
    --repo swartzrock/llm-now \
    --signer-workflow swartzrock/llm-now/.github/workflows/release.yml \
    --source-digest "$RELEASE_SHA"
done
```

On Windows, verify the declared unsigned status before running the executable:

```powershell
(Get-AuthenticodeSignature $Bin).Status
```

The expected status is `NotSigned`. The Windows x64 archive is **unsigned early access**: SmartScreen may offer **Run anyway** where policy permits, while Smart App Control or enterprise policy may block execution with no supported user bypass. Do not disable or weaken security controls.

Finally, record:

- a full functional pass on Linux x64 glibc;
- a native smoke on Linux ARM64 glibc;
- a full functional pass on Windows x64; and
- operation without Bun or Node.js on every tested target.

The Linux artifacts do not claim Alpine or other musl compatibility. Windows signing, Homebrew, and Chocolatey remain deferred.

### MT-32: Completed release no-op

After MT-31 succeeds, dispatch the same exact tag and peeled commit again with `publish: true`:

```bash
RELEASE_SHA="$(git rev-parse "${TAG}^{commit}")"
gh workflow run release.yml --ref "$TAG" \
  -f release-sha="$RELEASE_SHA" \
  -f publish=true
```

The preflight must download exactly the five ZIPs and `SHA256SUMS`, validate all checksums, and verify every archive attestation against this repository, `.github/workflows/release.yml`, and `RELEASE_SHA`. It must then report a completed no-op: no native build, signing, publication approval, tag mutation, asset replacement, or duplicate Release.

### MT-33: Exact-tag/no-Release resume

Exercise this state only after a real interrupted publication leaves an exact tag without a Release, or in a disposable repository that mirrors the production environments and tag rules. Do not manufacture it by deleting a production Release.

1. Confirm the tag peels to the intended release-shaped commit and no Release exists for it.
2. Dispatch at the tag ref, passing its peeled commit exactly:

   ```bash
   TAG=vX.Y.Z
   RELEASE_SHA="$(git rev-parse "${TAG}^{commit}")"
   gh workflow run release.yml --ref "$TAG" \
     -f release-sha="$RELEASE_SHA" \
     -f publish=true
   ```

3. Complete the protected approvals and verify the workflow rebuilds, signs, checksums, and attests the same source, leaves the tag unmoved, and creates the Release with exactly the six public assets from MT-31.

The selected tag ref and `release-sha` must both resolve to the same exact commit. An older tag that points elsewhere is not a recovery mechanism.

### MT-34: Conflict refusal

Use a disposable repository with the same workflow and protection settings; never create conflicting public state in production. Exercise each of these cases:

- `vX.Y.Z` points to a commit other than `release-sha`;
- a Release exists without the matching tag;
- a Release is draft or prerelease;
- the Release has a missing or extra asset;
- `SHA256SUMS` does not verify every archive;
- an archive attestation does not bind to this repository, release workflow, and source SHA; and
- no tag exists for the requested version while a higher stable Release is already public.

Each run must fail before public mutation with a diagnostic that identifies the conflicting state. Confirm the workflow never moves or deletes a tag, replaces an asset, edits the existing Release, or creates a lower-version tag. Maintainers must investigate and repair public state explicitly; rerunning automation must not overwrite it.

## Native credential storage

Use disposable OS accounts or VMs for these tests. Never test lifecycle mutations in a developer's normal account, and never put an API key in arguments, generation stdin, shell history, screenshots, reports, or workflow output.

### MT-35: Run the compiled production-adapter gate

On each matching native runner, from the exact candidate commit, run:

```bash
bun scripts/release-validate.ts secrets TARGET_ID
```

Replace `TARGET_ID` with the exact candidate target, such as `macos-arm64` or `linux-x64`. The gate must use Bun 1.3.14, reject a host/target mismatch, compile the production adapter with the same Bun target as the archive, and pass missing, set/get, replace/get, delete, and final-missing checks. It may print lifecycle stage names but no value. Confirm cleanup runs after success and after a deliberately injected intermediate failure. Linux must run inside the same isolated D-Bus/Secret Service session used by CI. A skip, warning-only failure, target mismatch, Bun mismatch, or leftover probe record is a release blocker.

### MT-36: Add, replace, and delete a provider fallback

In a disposable logged-in user account, obtain a temporary revocable provider credential and keep it out of the shell environment. Run bare `"$BIN"`, choose “Manage connections…”, then choose “Add or manage API keys…”, select the provider, and paste the value only into the hidden field.

Confirm that invalid input and failed authentication write nothing; final save defaults to No; acceptance creates one provider record; and stdout, stderr, terminal capture, aliases, and config files contain no credential. Repeat with a second temporary credential. Declining or failing replacement must preserve the old record; accepting a verified replacement must change it once. Finally delete the record, confirming deletion defaults to No and a concurrent/already-absent delete remains successful. Revoke both temporary credentials after testing.

### MT-37: Verify environment precedence and fallback behavior

With both a stored fallback and a recognized environment credential present, make the two credentials distinguishable through provider-side test-account evidence without printing either value. Generation must use the environment credential and make no vault read. Remove the environment variable and repeat; generation must use the stored fallback. Restore the environment variable, delete the stored fallback through “Manage connections…”, and confirm the CLI explains that the provider remains available through the environment source.

An authentication failure from the selected source must fail closed. The CLI must not retry the other source, switch provider, or overwrite/delete a stored record.

### MT-38: Verify unavailable-store behavior and cleanup

On Linux, repeat setup in a session without Secret Service. On other platforms, use a disposable test session where access to the native store is unavailable or denied. The operation must exit `1`, identify the credential-store operation as unavailable without exposing backend detail, create no plaintext/self-encrypted fallback, and preserve existing aliases and provider records. A recognized environment credential must remain usable.

After every session, verify that the probe identity and every `llm-now` test-provider record are absent, the temporary credentials are revoked, the isolated alias/config directory is removed, and the disposable OS session is destroyed.

## Automation-backed coverage

Keep the Bun test suite as the authority for behavior that is difficult or unreliable to verify manually:

- exact 5/10/45-second timeout boundaries;
- byte-for-byte output fidelity, including an absent trailing newline;
- exact stderr boundary behavior for responses with and without trailing newlines;
- sorted, canonical alias/provider/model option identity and Clack type-ahead behavior;
- Picocolors output under TTY, `NO_COLOR`, and non-TTY conditions;
- ANSI and control-sequence stripping;
- diagnostic truncation at 1,024 characters;
- v1-to-v2 instruction migration, add/change/remove transitions, and plaintext validation;
- exact per-invocation instruction forwarding with absent instructions on explicit and run-once calls;
- fixed fake-CLI diagnostics that never echo instruction-bearing arguments;
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
Native target ID and Bun version:
Credential-store backend:
User/session isolation:
Credential lifecycle stages:
Environment-precedence evidence:
Store-unavailable evidence:
Test IDs:
Pass/fail:
Observed exit code:
stdout evidence:
stderr evidence:
Alias-file evidence:
Duration:
Cleanup completed:
Credential-store cleanup evidence:
Notes/issues:
```

Any secret leakage, wrong-source/provider fallback, stdout contamination, corrupt-alias replacement, credential-store unavailability misclassification, missing store cleanup, absent compiled lifecycle evidence, checksum mismatch, or inability to run without Bun or Node.js blocks release.

See the [README](../README.md), [CLI argument contract](../src/args.ts), and [release workflow](../.github/workflows/release.yml) for the source-of-truth behavior.

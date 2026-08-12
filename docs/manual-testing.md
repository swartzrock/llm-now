# Manual testing guide

Use this guide to validate an `llm-now` release candidate from the native archives through provider calls, aliases, and the release workflow. Test the combined distribution branch or a tag reachable from `main`; do not treat source execution as a substitute for testing the packaged executables.

## Release criteria

A candidate is ready when:

- all five native executables launch without Bun or Node.js installed;
- help, version, prompt input, provider selection, aliases, output separation, diagnostics, and exit codes match the documented CLI contract;
- accepted voice routes report only the canonical alias on stderr before generation, without changing response stdout;
- every target with native credential storage enabled passes the compiled production-adapter lifecycle gate in its representative user session;
- each supported provider completes at least one successful generation on a reference platform;
- no credential appears in stdout, stderr, unified or legacy configuration, or captured shell logs;
- shortcut inventory and diagnostics do not disclose saved instruction text or instruction-bearing child-process arguments;
- no unexplained release-blocking manual failure remains.

Homebrew is a post-publication projection of each verified public Release and has dedicated commissioning cases below. Chocolatey remains outside the current release scope.

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

Download the `release-assets` artifact from the successful workflow run for the exact commit under test. Perform functional tests outside the source checkout and never use the tester's real configuration directory.

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

From the empty root, choose `Create a new shortcut…`. Confirm `How should this shortcut connect?` offers exactly `Use an available provider…` followed by `Add a provider with an API key…`, with no discovery before a source is chosen. Select the available-provider route, then the fake Codex provider and its safe model. At `Name this shortcut`, enter `daily`. Confirm the visible `Optional instructions for this shortcut (press Enter to skip)` field and `Press Tab to select [ save ], then Enter to save` callout appear next. Paste `Use "quoted" runtime smoke \ transport.` followed by a newline and `Keep each answer concise.`, press Tab, confirm the callout changes to `[ save ] selected — press Enter to save`, then press Enter to submit it.

When `Prompt for daily · Codex CLI · MODEL` appears, inspect the isolated
`config.toml` from a second terminal before entering a prompt. It must be a
version 1 TOML document whose `[aliases.daily]` table contains only `provider`,
`model`, and the exact `instructions` string; no comment, default voice field,
prompt, response, or credential may be present. Enter `smoke`. The command must
generate exactly once, exit `0`, and write only `fake:instruction-present` to
`stdout.bin`. The shortcut-save receipt must precede the work prompt on stderr.

### SC-03: Configured root and saved-shortcut route

Run bare `"$BRANCH_BIN" >stdout.bin` after SC-02. The configured root must contain exactly, in order:

1. `Run with a saved shortcut…`
2. `Create a new shortcut…`
3. `Run once with another provider and model…`
4. `Manage connections…`

Choose the saved-shortcut route, filter to `daily`, and confirm `Prompt for daily · Codex CLI · MODEL`. Enter `smoke`. It must write only `fake:instruction-present` to stdout and generate once without discovery, model listing, or another shortcut offer. Neither the prompt UI nor the root inventory may display the saved instruction text or an instruction-presence marker.

### SC-04: True run once never saves

Record a checksum or byte-for-byte copy of `config.toml`. From both empty and configured roots, choose the state-appropriate `Run once…` action, select the fake provider/model, and enter `smoke` at `Prompt for Codex CLI · MODEL`.

Each invocation must write only `fake:instruction-absent`, generate exactly once, and exit without showing an instruction, naming, save, or overwrite prompt. `config.toml` must remain byte-for-byte unchanged, including when the selected target already belongs to instructed shortcut `daily`.

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

### SC-11: Request-scoped instruction isolation

Keep the instructed `daily` shortcut from SC-02 and record `config.toml` byte-for-byte. The maintained fixture accepts this second, distinct multiline sentinel:

```bash
OVERRIDE=$'  Replace saved smoke instructions.\nUse the one-run override.  '
"$BRANCH_BIN" daily --instruction "$OVERRIDE" --input "smoke" >stdout.bin 2>stderr.txt
"$BRANCH_BIN" --alias daily --instruction "$OVERRIDE" --input "smoke" >stdout.bin 2>stderr.txt
"$BRANCH_BIN" --provider codex-cli --model default --instruction "$OVERRIDE" --input "smoke" >stdout.bin 2>stderr.txt
```

Each call must exit `0`, leave stderr empty, and write only `fake:instruction-override`. This proves the exact leading/trailing spaces and line feed survive argv and remain separate from the `smoke` prompt. The two alias calls must replace the different saved sentinel for one request, not append to it. `config.toml` must remain byte-for-byte unchanged, and a later `daily` call without the option must again write `fake:instruction-present`. Also verify `--instruction=-brief` is accepted with a real provider; a separated dash-leading value is standard option syntax and is not accepted.

Run representative parser failures with a blank-after-trimming value, a tab-bearing value, and a Unicode line-separator-bearing value. Each must exit `2`, leave stdout empty, emit a fixed `usage:` diagnostic without either the raw or JSON-serialized submitted value, and perform no prompt, alias, provider, or generation work. Separately confirm that `--instruction` alone does not supply a prompt, simultaneous `--input` and piped stdin remains invalid, and a selectorless noninteractive call remains nondeterministic.

With stderr attached to the PTY, run `"$BRANCH_BIN" --instruction "$OVERRIDE" --input "smoke"`, select the fake Codex target already used by `daily`, and confirm the request produces `fake:instruction-override`. The command-line value must prevent a provider/model-only match from being reported as equivalent to `daily`; the normal post-generation alias-save offer must remain available. Its instruction field must start empty. Save a new alias with the original saved sentinel entered separately, then inspect the store: `daily` is unchanged, the new alias contains only the independently entered value, and neither record contains the command-line override.

Finally, repeat an override call with a prompt other than the fixture's exact `smoke` value to force its fixed failure. The runtime diagnostic must contain neither the raw override nor its JSON-serialized form, and it must not print instruction-bearing child arguments. This boundary does not make the option secret: the value remains visible to shell history, local process inspection, CLI-provider child arguments, provider handling or retention, and potentially successful model output, which `llm-now` intentionally does not filter.

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

Repeat SC-01 through SC-10 against the packaged candidate, starting with an isolated empty configuration directory and at least two available providers. Run the bare executable with stdout redirected:

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

### MT-10A: Observe packaged voice selection before fake generation

On macOS or Linux, use the packaged `$BIN`, isolated fake `daily` shortcut, and
compiled maintained fake Codex fixture from MT-10. Move the fixture behind a
temporary gate wrapper:

```bash
mv "$TEST_ROOT/bin/codex" "$TEST_ROOT/bin/codex-fixture"
export LLM_NOW_TEST_FAKE_CODEX="$TEST_ROOT/bin/codex-fixture"
export LLM_NOW_TEST_GENERATION_GATE="$TEST_ROOT/release-generation"
export LLM_NOW_TEST_GENERATION_STARTED="$TEST_ROOT/generation-started"

cat >"$TEST_ROOT/bin/codex" <<'SH'
#!/bin/sh
if [ "$1" = "exec" ]; then
  : >"$LLM_NOW_TEST_GENERATION_STARTED"
  while [ ! -e "$LLM_NOW_TEST_GENERATION_GATE" ]; do
    /bin/sleep 0.05
  done
fi
exec "$LLM_NOW_TEST_FAKE_CODEX" "$@"
SH
chmod +x "$TEST_ROOT/bin/codex"
```

From the isolated work directory, start a fuzzy route in the background and
wait only for its stderr output:

```bash
rm -f "$LLM_NOW_TEST_GENERATION_GATE" "$LLM_NOW_TEST_GENERATION_STARTED" stdout.bin stderr.txt
"$BIN" --voice-route --input "dail, smoke" >stdout.bin 2>stderr.txt &
ROUTE_PID=$!

ATTEMPTS=0
while { [ ! -s stderr.txt ] || [ ! -e "$LLM_NOW_TEST_GENERATION_STARTED" ]; } \
  && [ "$ATTEMPTS" -lt 100 ]; do
  ATTEMPTS=$((ATTEMPTS + 1))
  /bin/sleep 0.05
done

printf "Selecting alias 'daily'\n" >expected-stderr.txt
test -e "$LLM_NOW_TEST_GENERATION_STARTED"
/usr/bin/cmp expected-stderr.txt stderr.txt
test ! -s stdout.bin
kill -0 "$ROUTE_PID"
```

The exact canonical-alias line must be complete while the fake response remains
blocked and stdout is empty. Release the fake generation and verify the final
streams:

```bash
/usr/bin/touch "$LLM_NOW_TEST_GENERATION_GATE"
wait "$ROUTE_PID"
STATUS=$?

printf 'fake:instruction-present' >expected-stdout.bin
test "$STATUS" -eq 0
/usr/bin/cmp expected-stdout.bin stdout.bin
/usr/bin/cmp expected-stderr.txt stderr.txt
```

The selection line must not repeat or gain transcript, question, prompt,
provider, instruction, credential, or response content. Repeat with a rejected
route: it must write no selection line, keep stdout empty, and never reach the
gate wrapper's `exec` branch:

```bash
rm -f "$LLM_NOW_TEST_GENERATION_GATE" "$LLM_NOW_TEST_GENERATION_STARTED" stdout.bin stderr.txt
"$BIN" --voice-route --input "unknown smoke" >stdout.bin 2>stderr.txt
STATUS=$?

test "$STATUS" -eq 1
test ! -s stdout.bin
test ! -e "$LLM_NOW_TEST_GENERATION_STARTED"
if /usr/bin/grep -q "Selecting alias" stderr.txt; then exit 1; fi
```

## Alias lifecycle

### MT-11: Save an alias

Run an interactive direct fresh selection such as `"$BIN" --input "Save this target"` with no alias or explicit provider/model. After generation, enter `daily` in the optional contextual alias field. Submit a blank value at the visible optional-instructions field. Confirm the green success message names `daily` and the exact provider/model target, then inspect the isolated path printed by `"$BIN" --config-path`. It must be a sparse, comment-free document with this semantic shape:

```toml
version = 1

[aliases.daily]
provider = "PROVIDER_ID"
model = "MODEL_ID"
```

For a supported CLI provider's default model, the stored value must be the
string `"default"`, never TOML null. Confirm that no key, token, endpoint
credential, prompt, generated text, `instructions`, `[voice]`, routing default,
speech default, or example alias is stored.

Next recreate `daily` and paste two visible instruction lines: `You are a Realtime Voice Agent Architect` and `Focus on interruption handling.` Accept the default-No overwrite only after confirming the transition is `none → set`. The document must remain version 1 and preserve the exact line break in a TOML multiline or escaped string accepted by both Bun and Python `tomllib`:

```toml
version = 1

[aliases.daily]
provider = "PROVIDER_ID"
model = "MODEL_ID"
instructions = "You are a Realtime Voice Agent Architect\nFocus on interruption handling."
```

Confirm that ordinary multiline input is accepted, while tabs, non-newline
control characters, and Unicode line or paragraph separators are rejected. Do
not enter a secret or data that cannot be disclosed to the provider:
instructions and exact migration backups are plaintext configuration. On Unix,
the directory must have mode `700` and unified, backup, lock, and temporary
files mode `600`. No lock or temporary file should remain.

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

Write this document to the isolated unified path printed by
`"$BIN" --config-path`, preserving the deliberately unsorted source order:

```toml
version = 1

[aliases.zeta]
provider = "openai"
model = "gpt-5"

[aliases.aliases]
provider = "codex-cli"
model = "default"
instructions = "inventory must not print this"
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
`config.toml`.

### MT-14: List an empty inventory

Remove `config.toml` and both legacy files from the isolated config directory and run:

```bash
"$BIN" --aliases >stdout.bin 2>stderr.txt
status=$?
test "$status" -eq 0
test ! -s stdout.bin
test ! -s stderr.txt
```

A missing store and a valid version 1 TOML document with an empty `[aliases]`
table must both exit
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

### MT-16: Reject invalid unified configuration during inventory

Replace the isolated `config.toml` with malformed TOML and run
`"$BIN" --aliases`. Then repeat with case-only entries that point to different
targets:

```toml
version = 1

[aliases.Fred]
provider = "claude-cli"
model = "default"

[aliases.FRED]
provider = "openai"
model = "gpt-5"
```

Where the operating system supports a reliable permission-denied fixture,
repeat once with an unreadable `config.toml`. Every invalid, unreadable, or
case-conflicting document must exit `1`, leave stdout empty, write an actionable
sanitized `config:` diagnostic to stderr, preserve the document, and perform no
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

Complete an interactive direct fresh selection using `--input`, then press Enter without typing a name in its legacy optional alias follow-up. Repeat and cancel the field with Ctrl-C. Both commands must exit `0` without creating or modifying `config.toml` or legacy configuration. Launcher run-once work must not show this field at all.

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

Save `Daily` and confirm `config.toml` contains the canonical table `[aliases.daily]`. Complete
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

### MT-22: Fail closed on corrupt unified configuration

Keep valid legacy `aliases.json` and `voice-router.toml` files in the isolated
directory, then create malformed `config.toml`. Run inventory, an explicit
provider/model generation, a routed generation, and, on macOS, a speech-enabled
invocation. Repeat with
version `2`, an unknown root field, an alias `api_key` field, an invalid model
`"default"` for a non-CLI provider, and out-of-range routing or speech values.

Every configuration-backed command must exit `1`, leave stdout empty, preserve
all files byte-for-byte, and perform no provider call, generation,
configuration change, speech, alias mutation, backup, or temporary publication.
Existing `config.toml` is the sole authority even when invalid: none of these cases may
fall back to the valid legacy files or migration backups. Put non-secret
credential-shaped and instruction sentinels in the malformed document and
confirm diagnostics identify only the sanitized path, field, source location,
or error category, never a raw TOML line or value.

### MT-22A: Migrate automatically and explicitly

In a fresh isolated directory, create a valid legacy `aliases.json` with active
aliases and a valid legacy `voice-router.toml` containing `wake_words`, settings
for an active alias, and structurally valid profiles named `zed` and `alpha`
that have no alias. Preserve exact byte copies of both sources. Trigger an
otherwise successful alias save and accept any required overwrite.

The save must merge the requested alias change and active voice settings into
`config.toml`, leave the legacy files untouched, and first create exact backups
named `aliases.json.pre-unified-v1.bak` and
`voice-router.toml.pre-unified-v1.bak`. The backup bytes must match the saved
source copies. `config.toml` must be sparse and comment-free, omit `zed` and
`alpha`, and become the only automatic authority. Stderr must contain one
successful warning with the names sorted exactly as `alpha, zed`; no incomplete
aliases may be invented. On Unix, verify the directory is mode `700` and all
unified, backup, lock, and temporary files are owner-only mode `600`.

Repeat in a separate fresh directory with the same two legacy sources, but run:

```bash
"$BIN" --migrate-config >stdout.txt 2>stderr.txt
```

It must perform the same merge and backup sequence without adding, removing, or
changing an alias, contact no provider or credential store, and report the
unified path on stdout. Stale profiles must again be reported once and sorted on
stderr. Repeat the command; it must exit `0`, report that configuration is
already unified, and leave every file byte-for-byte unchanged. Also verify that
explicit migration with no legacy files creates only a minimal version 1
document with an empty `[aliases]` table, while a missing single legacy source
creates no backup for that source.

### MT-22B: Canonically rewrite without pinning defaults

Manually edit valid `config.toml` to add comments, irregular spacing, two
unsorted aliases, explicit empty `wake_words` and `spoken_names`, routing
thresholds, instructions, and per-alias voice, rate, and pitch. Save one alias
through llm-now. The result may remove every comment and normalize all spacing,
but it must preserve every valid unrelated value, retain explicitly configured
empty lists, sort aliases, and remain valid TOML. A second semantically
unchanged rewrite must be byte-identical.

Delete each optional field separately and verify only that field resumes its
fallback: `wake_words = ["hey"]`, minimum fuzzy phrase length `4`, minimum
similarity `65`, minimum runner-up margin `15`, empty additional spoken names,
and the current macOS system voice, speech rate, or selected voice's normal
baseline pitch. Generated output must not materialize any of those omitted
values, comments, or example aliases. Check the accepted boundaries
`min_fuzzy_phrase_length = 1` and `64`, `min_similarity = 0` and `100`,
`min_margin = 0` and `100`, `rate = 80` and `500`, and `pitch = 1` and `127`;
each value just outside a boundary must fail before mutation.

Confirm routing still tries canonical aliases before configured spoken names
and configured spoken names before fuzzy matching. Threshold changes must not bypass
candidate-length compatibility, exact digit-sequence equality, the minimum
score, or the runner-up margin; weak and ambiguous requests remain rejected.

### MT-22C: Keep voice routing and speech read-only and native

In a fresh isolated directory with only valid legacy alias and voice files,
record directory contents and checksums, then run one successful exact-alias
`--voice-route` request and one rejected route. On macOS, also run one direct
alias `--speak` request and one combined `--voice-route --speak` request. None
may create `config.toml`, a migration backup, lock, temporary file, or changed
legacy file. Repeat with valid unified configuration and confirm it too remains
byte-for-byte unchanged. On Linux and Windows, route-only execution must retain
the ordinary response-only stdout contract and write exactly one canonical
alias selection line to stderr before generation, while `--speak` must reject
before reading input or configuration. A normal alias save must continue to
retain configured voice fields on those platforms.

Run the packaged executable with Python and uv absent from `PATH` and outside a
repository checkout. Config discovery, migration, alias save, native routing,
and macOS speech must remain available without launching Python. The
source-only Python example remains an independent contributor parity oracle,
not an installed runtime dependency.

### MT-22D: Recover deliberately before a downgrade

Use a disposable directory in which both legacy sources were migrated, so both
deterministic backups exist. After migration, make a recognizable valid change
only in `config.toml`; confirm the change is not mirrored to either legacy file
or backup. Close other llm-now processes and record the path from the newer
binary before installing an older one.

On macOS or Linux, recover in this exact order:

```bash
CONFIG_PATH="$("$BIN" --config-path)"
CONFIG_DIR="$(dirname "$CONFIG_PATH")"
test ! -e "$CONFIG_DIR/config.toml.pre-downgrade"
mv "$CONFIG_PATH" "$CONFIG_DIR/config.toml.pre-downgrade"
cp -p "$CONFIG_DIR/aliases.json.pre-unified-v1.bak" "$CONFIG_DIR/aliases.json"
cp -p "$CONFIG_DIR/voice-router.toml.pre-unified-v1.bak" "$CONFIG_DIR/voice-router.toml"
```

On Windows PowerShell, perform the same ordered transition:

```powershell
$ConfigPath = & $Bin --config-path
$ConfigDir = Split-Path $ConfigPath
$MovedConfig = Join-Path $ConfigDir "config.toml.pre-downgrade"
if (Test-Path $MovedConfig) { throw "preserved config already exists" }
Move-Item $ConfigPath $MovedConfig
Copy-Item (Join-Path $ConfigDir "aliases.json.pre-unified-v1.bak") (Join-Path $ConfigDir "aliases.json") -Force
Copy-Item (Join-Path $ConfigDir "voice-router.toml.pre-unified-v1.bak") (Join-Path $ConfigDir "voice-router.toml") -Force
```

The first mutation must move `config.toml` out of its authoritative path; never
copy backups over legacy files while unified authority is still active. Verify
the moved file still contains the post-migration-only change, the restored
legacy files exactly match their deterministic backups, and the older binary
reads the restored state. Keep the moved unified file: post-migration aliases,
instructions, routing thresholds, and speech changes were never mirrored and
would otherwise be lost. If one legacy source was absent during migration, its
backup is absent too; leave that legacy path absent rather than inventing it.

### MT-23: Resolve platform config paths

Verify that:

- `"$BIN" --config-path` prints exactly the resolved `config.toml` path with a
  trailing newline, reads no application configuration, writes nothing, and
  rejects all other options and positionals;
- an absolute `XDG_CONFIG_HOME` is used on macOS and Linux;
- an absolute `APPDATA` is used on Windows;
- when those variables are absent, the documented home-directory fallback is used; and
- relative `XDG_CONFIG_HOME` or `APPDATA` values are ignored in favor of the fallback.

Use a temporary `HOME` or `USERPROFILE` for fallback tests.

### MT-23A: Verify safe instruction transport boundaries

Use only the maintained fake Codex fixture and its two non-secret multiline
sentinels. The packaged smoke must pass the saved sentinel for an alias call and
receive `fake:instruction-present`; the otherwise identical explicit call must
receive `fake:instruction-absent`. A second alias call supplies the distinct
command-line sentinel and must receive `fake:instruction-override`, proving
replacement rather than mere presence. `config.toml` must remain unchanged.
The fixture `PATH` must contain only the temporary fixture directory, and
non-Windows runs must set `SHELL` to a nonexistent file, so no real CLI or LLM
can be selected. The loopback fake Ollama check may still run, but no external
network request is permitted.

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
2. Confirm the `release-signing` and `release-publication` environments have the intended required reviewers and only the signing environment contains Apple credentials. Confirm `homebrew-publication` is restricted to protected `main` and trusted stable `v*` tags; it is reviewer-free by default unless maintainers deliberately accept approval-gated Homebrew projection.
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
9. After the GitHub Release is public, confirm the Homebrew job downloads and reverifies the exact six-asset set before it reads or updates the tap formula. Use MT-39 and MT-40 for baseline and first-write commissioning; reserve MT-41 for credential/ref denial and recovery commissioning.

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

The Linux artifacts do not claim Alpine or other musl compatibility. Windows signing and Chocolatey remain deferred; Homebrew projection is verified separately in MT-39 through MT-41.

### MT-32: Completed release no-op

After MT-31 succeeds, dispatch the same exact tag and peeled commit again with `publish: true`:

```bash
RELEASE_SHA="$(git rev-parse "${TAG}^{commit}")"
gh workflow run release.yml --ref "$TAG" \
  -f release-sha="$RELEASE_SHA" \
  -f publish=true
```

The preflight must download exactly the five ZIPs and `SHA256SUMS`, validate all checksums, and verify every archive attestation against this repository, `.github/workflows/release.yml`, and `RELEASE_SHA`. It must then skip native build, signing, and GitHub publication mutation while still entering Homebrew reconciliation. An exact tap formula reports `already-current`; a safe older formula may update once. The run must never mutate the tag, Release, assets, or attestations.

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

### MT-39: Static public v2.2.0 formula baseline

This is a static convergence check, not live commissioning. The `v2.2.0` tag predates the Homebrew job, so dispatching that historical tag cannot execute or recover the new projection.

1. Download the current public tap formula into an isolated temporary directory:

   ```bash
   HOMEBREW_BASELINE_DIR="$(mktemp -d)"
   gh api \
     -H 'Accept: application/vnd.github.raw+json' \
     'repos/swartzrock/homebrew-tap/contents/Formula/llm-now.rb?ref=main' \
     > "$HOMEBREW_BASELINE_DIR/live.rb"
   ```

2. Run the focused golden test. It renders from the authoritative five-entry public `v2.2.0` manifest data and requires byte equality with the checked-in baseline:

   ```bash
   bun test tests/packaging.test.ts --test-name-pattern \
     'renders the public 2.2.0 Homebrew formula byte-for-byte'
   ```

3. Compare that rendered baseline with public tap `main`:

   ```bash
   cmp tests/fixtures/homebrew/llm-now-2.2.0.rb \
     "$HOMEBREW_BASELINE_DIR/live.rb"
   ```

Both checks must pass without changing `swartzrock/homebrew-tap`. Remove the temporary directory after recording the result.

### MT-40: First post-merge Homebrew write commissioning

Run this with the first release whose exact tag contains the Homebrew job.

1. Create a fine-grained PAT that selects only `swartzrock/homebrew-tap`, grants repository **Contents: Read and write**, and grants no Workflow, Administration, Actions, organization, or `swartzrock/llm-now` access. Record that Contents write still covers every non-workflow file in the tap; it is not path-scoped.
2. Store it as `HOMEBREW_TAP_TOKEN` in `homebrew-publication`. Confirm selected deployment refs admit only protected `main` and trusted stable `v*` tags. Keep no reviewer by default for automatic synchronization, or record the stricter approval policy if maintainers intentionally enable one.
3. While authenticated, inspect `swartzrock/homebrew-tap/main` branch protection and rulesets. Confirm the fine-grained identity may make the intended direct Contents update. Stop if a pull request or different identity is required; do not broaden permissions or bypass policy.
4. Record the current tap formula commit, then complete the normal release through MT-31. After the GitHub Release is public, confirm the Homebrew job independently verifies the remote tag SHA, non-draft/non-prerelease state, exact six assets, all manifest checksums, and every archive attestation before mutation.
5. Confirm exactly one new tap commit changes only `Formula/llm-now.rb`. Its version, four immutable URLs, and four checksums must match the public Release manifest and the source renderer byte-for-byte. No second write may occur, and the source tag and Release must remain unchanged.
6. Record the terminal disposition. A successful first advance is `updated`; a repeated run is `already-current`. HTTP status and request ID may be null when no response supplied them. The summary must contain no raw formula, manifest, API body, header, or credential.

Do not create production same-version drift, downgrade, malformed formula, stale-SHA, or ambiguous transport states. `tests/homebrew-reconcile.test.ts` supplies the U2 automated fixtures for those refusal and one-read-back cases.

### MT-41: Homebrew credential and deployment-ref denial recovery

Use a release whose stable tag contains the Homebrew job; `v2.2.0` and other older tags cannot exercise this recovery path.

1. Verify the environment boundary before using the real token. From a temporary reviewed diagnostic workflow, attempt an environment deployment from a disposable feature branch and a same-repository pull request using a non-sensitive sentinel secret in `homebrew-publication`. GitHub must reject both refs before the job starts, proving those refs receive no environment secret, including `HOMEBREW_TAP_TOKEN`. Remove the diagnostic workflow and sentinel after review; never print or probe the PAT value.
2. For a later commissioning release, remove, expire, or replace `HOMEBREW_TAP_TOKEN` with a deliberately denied token before the Homebrew mutation step. Let GitHub Release publication complete. Homebrew must report `failed-before-write`; the exact tag, Release, six assets, checksums, and attestations must remain unchanged.
3. Restore the correctly scoped token, peel the exact stable tag, and dispatch that tag's committed workflow:

   ```bash
   TAG=vX.Y.Z
   RELEASE_SHA="$(git rev-parse "${TAG}^{commit}")"
   gh workflow run release.yml --ref "$TAG" \
     -f release-sha="$RELEASE_SHA" \
     -f publish=true
   ```

4. Confirm the run reverifies the existing public Release, performs no build or GitHub publication mutation, and retries only the Homebrew projection. It may issue one blob-SHA-guarded write. After every attempted write it must read once; exact desired bytes report `updated` or `already-current`, while a non-exact or unavailable read-back reports `write-outcome-unconfirmed`. It must never issue a second write in that run.
5. Confirm a same-version divergent formula, newer formula, or missing or invalid formula would refuse mutation as `failed-before-write` using the U2 automated fixtures; do not manufacture those states in the public tap.

## Native macOS voice Shortcut

### MT-42: Complete the two-action voice Shortcut matrix

On a Mac with Dictation enabled, follow the authoritative
[macOS voice shortcut guide](../examples/macos-voice-shortcut.md) from its Text
smoke test through the global keyboard shortcut. Start with installed `llm-now`
and one working alias. Confirm the selected alias's ordinary network, credential,
local-service, or CLI-runtime prerequisites separately. Record the time from
opening the setup section to the first spoken answer. Under ordinary provider
conditions, it must take less than three minutes without Python, uv, or a
repository checkout.

The finished Shortcut must contain only `Dictate Text` followed by
`Run Shell Script`. It must pass `Dictated Text` to stdin, and the shell action
must invoke the absolute installed path to `llm-now --voice-route --speak`. No
`--input`, marker parser, separate `Speak Text` action, or Python/uv launcher
may remain.

Complete the guide's exact, configured-phrase, unique-fuzzy, poor, and ambiguous
routes; optional/omitted/configured wake words; per-alias voice/rate/pitch;
audible pitch A/B; one local and one hosted alias; provider and configuration
failures; permissions; and recovery.
A successful process exit alone is not evidence that an installed voice honored
the pitch setting. Confirm failed or ambiguous routing does not invoke a model,
and a speech failure does not trigger a replacement notice.

From Terminal, also complete each independent composition boundary:

```bash
"$BIN" --voice-route --input "haiku, explain a perfect chord" >stdout.txt 2>stderr.txt
"$BIN" --alias haiku --speak --input "Explain a perfect chord" >stdout.txt 2>stderr.txt
"$BIN" --provider ollama --model llama3 --speak --input "Explain a perfect chord" >stdout.txt 2>stderr.txt
```

Route-only execution must generate once, write the answer only to stdout, and
write exactly `Selecting alias 'haiku'\n` to stderr before generation, and start
no speech process. Direct alias speech must use that alias's optional voice
profile; explicit provider/model speech must use system speech defaults. Both
speech calls must generate once, speak once, and leave answer stdout empty. The
combined routed speech path must also write the canonical selection line; the
direct and explicit speech paths must not. On Linux and Windows, repeat
route-only successfully and confirm either speech call returns the fixed
macOS-only failure before reading stdin, configuration, credentials, or routing
state.

For the clipboard-negative check, copy a distinctive sentinel in another
application before the combined Shortcut run. After it finishes, paste into a
blank document. The sentinel must remain unchanged: neither routing nor speech
uses the clipboard.

For cancellation, start a slow request and use the Shortcut's stop control. The
command must handle its root interrupt, reap the active operation, exit `130`,
report `voice request cancelled`, and start no later notice or speech.
Run only one invocation at a time; overlapping invocations are unsupported
because audible speech can interleave.

Record the macOS version, Dictation mode, shortcut key, absolute binary path,
aliases/providers and their prerequisites, installed voices, elapsed setup time,
pitch values and audible comparison, cancellation exit/diagnostic, and
permission prompts. Also record that Dictation may use Apple services, hosted
aliases send accepted question content to their provider, and speech is audible.

## Automation-backed coverage

Keep the Bun test suite as the authority for behavior that is difficult or unreliable to verify manually:

- exact 5/10/45-second timeout boundaries;
- byte-for-byte output fidelity, including an absent trailing newline;
- exact stderr boundary behavior for responses with and without trailing newlines;
- sorted, canonical alias/provider/model option identity and Clack type-ahead behavior;
- Picocolors output under TTY, `NO_COLOR`, and non-TTY conditions;
- ANSI and control-sequence stripping;
- diagnostic truncation at 1,024 characters;
- unified TOML validation, sparse canonical rewrites, omission preservation,
  deterministic legacy backups, migration retries, and add/change/remove
  instruction transitions;
- exact per-invocation instruction forwarding with absent instructions on explicit and run-once calls;
- Homebrew exact/older/drift/newer/invalid classification, one-write concurrency, nullable response metadata, and credential-safe diagnostics in `tests/homebrew-reconcile.test.ts`;
- fixed fake-CLI diagnostics that never echo instruction-bearing arguments;
- concurrent alias writers and ownership-aware stale-lock recovery; and
- no-clobber first publication, atomic replacement, and injected migration
  failure handling.

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
Configuration-file evidence:
Duration:
Cleanup completed:
Credential-store cleanup evidence:
Notes/issues:
```

Any secret leakage, wrong-source/provider fallback, stdout contamination,
corrupt unified replacement or legacy fallback, credential-store unavailability
misclassification, missing store cleanup, absent compiled lifecycle evidence,
checksum mismatch, or inability to run without Bun or Node.js blocks release.

See the [README](../README.md), [CLI argument contract](../src/args.ts), and [release workflow](../.github/workflows/release.yml) for the source-of-truth behavior.

# Manual testing guide

Use this guide to validate an `llm-now` release candidate from the native archives through provider calls, aliases, and the release workflow. Test the combined distribution branch or a tag reachable from `main`; do not treat source execution as a substitute for testing the packaged executables.

## Release criteria

A candidate is ready when:

- all five native executables launch without Bun or Node.js installed;
- help, version, prompt input, provider selection, aliases, output separation, diagnostics, and exit codes match the documented CLI contract;
- every target with native credential storage enabled passes the compiled production-adapter lifecycle gate in its representative user session;
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

Native credential storage is additionally gated on all five targets for Bun 1.3.14. macOS uses Keychain, Windows uses Credential Manager, and Linux uses Secret Service. Linux coverage requires a real isolated D-Bus user session and unlocked test collection; a platform name without that session is not evidence of availability.

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
- the green contextual alias field emphasizes the selected provider and raw model and explains that Enter exits; and
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

First run an interactive call with no explicit selection. Confirm that the sorted alias picker appears before discovery, typing `dai` filters to `daily`, and selecting it bypasses provider/model discovery and does not show another alias field. Repeat through “Select a new provider and model…”, choose the provider/model already stored as `daily`, and confirm the CLI reports that existing alias, suggests `llm-now daily --input "<prompt>"`, and does not show the alias field. Then verify deterministic non-interactive reuse from another directory:

```bash
cd /
printf 'Summarize the idea of gravity.' |
  "$BIN" daily >stdout.txt 2>stderr.txt
```

Repeat as `"$BIN" daily --input 'Summarize the idea of gravity.'` and with the
long form `"$BIN" --alias daily --input 'Summarize the idea of gravity.'`. The commands
must exit `0`, resolve the exact case-sensitive alias independently of option order and the
working directory, write only the response to stdout, and skip the alias-save prompt. Also
verify that aliases named `help`, `version`, and `run` work when supplied as bare positional
names; only `--help` and `--version` select those standalone modes.

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

These tests are maintainer-only. Run them in order while commissioning the reviewed release train, and do not merge another `chore: release` pull request until the previous promotion finishes.

### MT-24: Unsigned release candidate

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

### MT-25: First generated release PR CI

1. In repository Actions settings, allow GitHub Actions to create pull requests with the repository token.
2. Merge a feature pull request containing a non-empty `.changeset/*.md` file.
3. Confirm the `Changesets` workflow creates or updates exactly one `chore: release` pull request.
4. Review its `package.json` bump, matching `CHANGELOG.md` section, and deletion of the consumed Changeset. Confirm it contains no npm publication or release tag.
5. Confirm the repository-token-created pull request checks appear as approval-required. Have a maintainer explicitly approve the workflow runs.
6. Wait for the normal source checks, all five native target checks, and exact-asset assembly to pass. Confirm branch protection treats them like the checks on an ordinary pull request.

Leave the reviewed release pull request open until MT-26 is ready. If its checks do not appear, cannot be approved, or do not satisfy branch protection, stop and correct repository settings before merging it.

### MT-26: First tag-last public release

Run only when publication is explicitly authorized. Before dispatch:

1. Confirm the repository is public and eligible to issue GitHub artifact attestations.
2. Confirm the `release-signing` and `release-publication` environments have the intended required reviewers and only the signing environment contains Apple credentials.
3. Commission the `v*` tag rule: the protected publication actor may create a new tag, while other actors cannot move or delete release tags.
4. Confirm the intended `vX.Y.Z` tag and Release do not exist and no higher stable Release is public.
5. Merge the approved `chore: release` pull request from MT-25. Record its exact merge SHA and version:

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

### MT-27: Completed release no-op

After MT-26 succeeds, dispatch the same exact tag and peeled commit again with `publish: true`:

```bash
RELEASE_SHA="$(git rev-parse "${TAG}^{commit}")"
gh workflow run release.yml --ref "$TAG" \
  -f release-sha="$RELEASE_SHA" \
  -f publish=true
```

The preflight must download exactly the five ZIPs and `SHA256SUMS`, validate all checksums, and verify every archive attestation against this repository, `.github/workflows/release.yml`, and `RELEASE_SHA`. It must then report a completed no-op: no native build, signing, publication approval, tag mutation, asset replacement, or duplicate Release.

### MT-28: Exact-tag/no-Release resume

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

3. Complete the protected approvals and verify the workflow rebuilds, signs, checksums, and attests the same source, leaves the tag unmoved, and creates the Release with exactly the six public assets from MT-26.

The selected tag ref and `release-sha` must both resolve to the same exact commit. An older tag that points elsewhere is not a recovery mechanism.

### MT-29: Conflict refusal

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

### MT-26: Run the compiled production-adapter gate

On each matching native runner, from the exact candidate commit, run:

```bash
bun scripts/release-validate.ts secrets TARGET_ID
```

Replace `TARGET_ID` with the exact candidate target, such as `macos-arm64` or `linux-x64`. The gate must use Bun 1.3.14, reject a host/target mismatch, compile the production adapter with the same Bun target as the archive, and pass missing, set/get, replace/get, delete, and final-missing checks. It may print lifecycle stage names but no value. Confirm cleanup runs after success and after a deliberately injected intermediate failure. Linux must run inside the same isolated D-Bus/Secret Service session used by CI. A skip, warning-only failure, target mismatch, Bun mismatch, or leftover probe record is a release blocker.

### MT-27: Add, replace, and delete a provider fallback

In a disposable logged-in user account, obtain a temporary revocable provider credential and keep it out of the shell environment. Run bare `"$BIN"`, choose “Add or manage API keys…”, select the provider, and paste the value only into the hidden field.

Confirm that invalid input and failed authentication write nothing; final save defaults to No; acceptance creates one provider record; and stdout, stderr, terminal capture, aliases, and config files contain no credential. Repeat with a second temporary credential. Declining or failing replacement must preserve the old record; accepting a verified replacement must change it once. Finally delete the record, confirming deletion defaults to No and a concurrent/already-absent delete remains successful. Revoke both temporary credentials after testing.

### MT-28: Verify environment precedence and fallback behavior

With both a stored fallback and a recognized environment credential present, make the two credentials distinguishable through provider-side test-account evidence without printing either value. Generation must use the environment credential and make no vault read. Remove the environment variable and repeat; generation must use the stored fallback. Restore the environment variable, delete the stored fallback through setup, and confirm the CLI explains that the provider remains available through the environment source.

An authentication failure from the selected source must fail closed. The CLI must not retry the other source, switch provider, or overwrite/delete a stored record.

### MT-29: Verify unavailable-store behavior and cleanup

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

# Talk to an llm-now alias from a macOS shortcut

Press a keyboard shortcut, dictate an alias and question, then hear the answer.
The same answer is copied to the clipboard. The Shortcut itself has only two
actions:

1. `Dictate Text`
2. `Run Shell Script`

The shell action passes the dictated text through stdin to the installed
`llm-now --voice` command. The native command loads the current aliases, rejects
uncertain matches, calls the selected alias once, copies the answer, and speaks
it with macOS `say`. Normal use does not require Python, uv, this repository, or
a second launcher.

## Before you start

You need:

- macOS Dictation enabled in **System Settings → Keyboard → Dictation**;
- `llm-now` installed; and
- at least one working saved alias.

The selected alias still needs everything it normally needs. A hosted alias may
need network access and its usual provider credential. An Ollama or LM Studio
alias needs that local service running. A CLI-backed alias needs its CLI
installed and authenticated.

Confirm the command-line pieces in Terminal:

```bash
command -v llm-now
llm-now --aliases
```

Keep the absolute path printed by `command -v llm-now`. Test one alias normally
before building the Shortcut so its provider, credential, network, or local
service prerequisites are already known to work.

## Set up the Shortcut

### 1. Start with a Text smoke test

Open Shortcuts, create a shortcut named `Ask llm-now`, and add a **Text** action.
Enter a real alias followed by a question, for example:

```text
haiku, write one sentence about smoked brisket
```

Add **Run Shell Script** immediately after Text. Set:

- **Shell:** `zsh`
- **Input:** the `Text` magic variable
- **Pass Input:** `to stdin`

Paste one command, replacing the example with the absolute path printed by
`command -v llm-now`:

```zsh
/opt/homebrew/bin/llm-now --voice
```

Intel Homebrew commonly installs the binary at `/usr/local/bin/llm-now`; direct
downloads may use another location. Use the path from your Mac instead of
assuming either example.

Do not put API keys in this script. Shortcuts does not reliably inherit
variables from an interactive shell. Use a local or authenticated CLI-backed
alias, a provider environment available to GUI apps, or llm-now's supported
native credential storage.

Run the Shortcut from the editor. Success means:

- the answer is spoken;
- the identical answer is on the clipboard; and
- the shell action needs no `Speak Text` or clipboard action after it.

Paste somewhere to confirm the clipboard. Fix this Text test before involving
the microphone; it isolates paths, dependencies, aliases, and providers from
Dictation permissions.

For manual Terminal testing, `--input` is also available:

```bash
/absolute/path/to/llm-now --voice --input 'haiku, explain a perfect chord'
```

The Shortcut must use stdin. Command-line input can be visible in shell history
and local process inspection, so do not use `--input` for sensitive text.

### 2. Switch Text to Dictate Text

Delete the Text action and put **Dictate Text** in its place. Keep its
`Dictated Text` output connected to the existing shell action, still passed to
stdin. The final Shortcut must contain only:

```text
Dictate Text → Run Shell Script
```

Run it from the editor and say:

```text
Hey haiku, write a haiku about smoked brisket
```

Pause so Dictation finishes. `hey` is optional; the default configuration
accepts both `Hey haiku, ...` and `haiku, ...`.

### 3. Assign a global keyboard shortcut

Open the Shortcut's details, choose **Add Keyboard Shortcut**, and press an
unused key combination. Switch to another application and invoke it. Wait for
the current run to finish before starting another one. Only one active voice
invocation is supported: overlapping runs can interleave writes to the global
clipboard and audible speech.

If macOS asks whether Shortcuts may run shell scripts, allow it. Managed Macs
may require an administrator to permit that capability.

## How alias matching works

Aliases are loaded on every request, so adding an llm-now alias does not require
editing the Shortcut or copying an alias roster into another file.

The router examines only the leading spoken phrase and tries these stages:

1. normalized canonical alias;
2. configured `match_phrases`; and
3. conservative native similarity scoring.

Normalization is case-insensitive and removes punctuation and spacing for the
comparison, so `Deep seek 32` can select `deepseek32`. The original question is
preserved. Similarity is a deterministic string score, not a probability or an
AI confidence score. A fuzzy result must clear both a minimum score and a
runner-up margin; weak, tied, and ambiguous inputs are rejected rather than sent
to the nearest model.

With matching aliases and the optional profile below, these phrases route as
follows:

| Dictated phrase | Alias | Match stage |
| --- | --- | --- |
| `Deep seek 32, explain mixture of experts` | `deepseek32` | normalized canonical |
| `haiku, write a love poem` | `haiku` | canonical |
| `Tara, write a haiku about smoked brisket` | `terra` | unique fuzzy |
| `Op. 47, explain this chord` | `opus47` | configured phrase |
| `Kwen, explain perfect chords` | `qwen` | unique fuzzy |

`Tara` and `Kwen` work only when no competing alias makes the result ambiguous.

## Optional names, routing, and speech

Aliases and voice settings share llm-now's unified configuration. Print its
exact location with this read-only command:

```bash
llm-now --config-path
```

On macOS the path is `$XDG_CONFIG_HOME/llm-now/config.toml` when
`XDG_CONFIG_HOME` is absolute, otherwise `~/.config/llm-now/config.toml`.
Relative `XDG_CONFIG_HOME` values use the home-directory fallback.

Each voice profile lives with its canonical lowercase alias rather than in a
separate voice file. For example, add the optional values to existing alias
tables:

```toml
version = 1

[voice]
wake_words = ["hey", "computer"]
min_fuzzy_phrase_length = 4
min_similarity = 65
min_margin = 15

[aliases.terra]
provider = "openai"
model = "gpt-5"
match_phrases = ["tara"]
voice = "Samantha"
rate = 205

[aliases.opus47]
provider = "claude-cli"
model = "default"
match_phrases = ["op 47"]

[aliases.slug]
provider = "ollama"
model = "qwen3"
voice = "Eddy (English (US))"
rate = 180
pitch = 50
```

`version = 1`, `[aliases]`, and each alias's `provider` and `model` are required.
`model = "default"` is valid only for `codex-cli` and `claude-cli`. The example
shows every global voice field and every per-alias speech or routing field;
`instructions` is the remaining optional alias field and contains the same
plaintext reusable guidance described in the main README.

Omission applies independently to every optional voice field:

- omit `wake_words` to use `["hey"]`; use `wake_words = []` to disable
  wake-word stripping;
- omit `min_fuzzy_phrase_length` to use `4`; configured values must be integers
  from 1 through 64;
- omit `min_similarity` to use `65`; configured values must be integers from 0
  through 100;
- omit `min_margin` to use `15`; configured values must be integers from 0
  through 100;
- omit `match_phrases` to rely on canonical and fuzzy matching, or set it to
  `[]` for no configured phrases;
- omit `voice`, `rate`, or `pitch` to inherit the current macOS system voice,
  system speech rate, or selected voice's normal baseline pitch independently;
- keep `rate` at an integer from 80 through 500; and
- keep `pitch` between 1 and 127, inclusive. Integers and fractional values such
  as `50.5` are accepted.

Routing always checks the canonical alias, configured phrases, and then fuzzy
similarity in that order. Threshold changes do not disable the digit-equality,
candidate-length, minimum-score, or runner-up-margin safety gates; ambiguous
input remains rejected. Empty or duplicate normalized phrases and phrase
collisions between aliases are invalid.

`pitch` uses Apple's legacy unsigned, absolute baseline-pitch (`pbas`) scale; it
is not a percentage or a relative adjustment. The router turns `pitch = 50`
into a trusted `[[pbas 50]]` command for `/usr/bin/say` only. The original model
answer is still copied to the clipboard without that command. Raw embedded
speech commands are not configurable, and model output containing `[[...]]` is
rejected before copying or speaking.

List the exact voices installed on this Mac:

```bash
/usr/bin/say -v '?'
```

Voice lookup is case-insensitive and speech uses the installed canonical name.
An unavailable selected voice fails before model generation instead of silently
changing the voice or alias.

An alias save may canonically rewrite all of `config.toml`, removing comments
and custom spacing while preserving valid unrelated values. Generated and
migrated files remain sparse and comment-free; llm-now does not write the
omitted defaults or example aliases. Running `llm-now --voice` is read-only with
respect to configuration: it never creates the unified file, migrates legacy
files, creates backups, or saves inferred speech settings. Use
`llm-now --migrate-config` if you want to migrate legacy `aliases.json` and
`voice-router.toml` before the next successful alias save. Any structurally
valid legacy voice profiles that cannot attach to an active alias are reported
once in sorted order and retained in the exact plaintext legacy backup.

## Manual verification

Keep a working exact-alias request as the control case, then check the behaviors
that apply to your alias inventory.

### Routing and output

1. Run the Text smoke test, then Dictate Text, then the global keyboard shortcut.
2. Try the five phrases in the table for aliases that exist on your machine.
3. Try the same request with `Hey`, without a wake word, and with a configured
   wake word in different capitalization.
4. Configure different voices, rates, or pitches for two aliases that point to
   the same model. Confirm the profile follows the alias, not the model.
5. Ask one local Ollama alias and one hosted API- or CLI-backed alias. Ordinary
   unmarked text from both must follow the same clipboard-and-speech path.
6. After each success, paste the clipboard and confirm it contains the original
   answer text with no `[[pbas ...]]` command.

### Pitch A/B check

Pitch support can vary by installed voice, so a successful Shortcut run does
not prove that the selected voice changed audibly.

1. Choose an exact name from `/usr/bin/say -v '?'`, configure it for `slug` (or
   substitute one of your aliases), omit `pitch`, and ask for a short repeatable
   sentence. Treat that listening pass as the control.
2. Add one legal pitch such as `pitch = 40`, repeat the same request, and compare
   it with the control. Paste the clipboard and confirm that it contains only
   the model answer, with no speech command.
3. Repeat with a substantially different legal value such as `pitch = 80`.
   Record the voice, values, and whether the difference was audible.
4. If the two legal values sound unchanged, repeat with another installed
   voice. Treat the result as voice-dependent rather than assuming process
   success guarantees modulation.

### Rejection and failure safety

Put a recognizable sentinel on the clipboard:

```bash
printf 'VOICE-ROUTER-SENTINEL' | /usr/bin/pbcopy
```

Dictate `Bananas, answer this question` or another deliberately poor alias.
You should hear a retry notice, no model should run, and `pbpaste` should still
print the sentinel.

For an ambiguity check, use a disposable unified configuration containing two harmless
near neighbors such as `qwen` and `when`, then say `Kwen, answer this`. The
router must reject instead of choosing row order. Do not alter a production
configuration only to run this check.

Stop a local provider or otherwise make a test alias fail, reset the clipboard
sentinel, and ask it a question. You should hear only the stable request-failed
notice. Provider stderr must not enter speech or the clipboard.

Start a deliberately slow request and press the Shortcut's stop button. Wait
past the provider's normal response time. The stop control is the supported
cancellation affordance: `llm-now` handles the interrupt as one root request,
terminates and reaps the active operation, exits `130`, and writes
`voice request cancelled` to the Shortcut result. There must be no later notice,
speech, or downstream action. If cancellation occurs after copying completed,
the clipboard may already contain the answer; the command does not attempt an
unsafe restore.

## Troubleshooting

### Dictate Text never finishes or produces no transcript

1. Confirm Dictation is enabled in **System Settings → Keyboard** and that the
   intended input microphone responds in Voice Memos.
2. Run the Shortcut once from the editor so macOS can request permission.
3. Open **System Settings → Privacy & Security → Microphone** and enable
   Shortcuts if it appears. If it does not appear, toggle Dictation off and on,
   quit and reopen Shortcuts, then run it again.
4. In Dictate Text's expanded options, use the normal stop-after-pause behavior
   and pause after speaking.
5. Temporarily replace the shell action with **Show Result** using the
   `Dictated Text` variable. The transcript appears in the result panel only
   after Dictation completes. Restore Run Shell Script afterward so the
   supported Shortcut returns to two actions.

### Text works but Dictate Text returns the retry notice

Use the temporary Show Result check above and inspect the leading words macOS
actually produced. Add a narrow `match_phrases` entry for a repeatable
transcription. Do not add broad phrases just to force a match; rejection is the
safe outcome.

### The shell action fails immediately

Recheck the absolute `llm-now` path, **Pass Input: to stdin**, the selected
alias's ordinary provider prerequisites, and the shell's script-running
permission. Paths in Shortcuts do not use your interactive shell aliases or
startup files.

Run the same installed binary from Terminal with a transcript to see local
diagnostics:

```bash
printf 'haiku, explain a perfect chord' | /absolute/path/to/llm-now --voice
```

Rejected input says `I couldn't match an alias and question. Please try again.`
A generation failure says `The request failed. Please try again.` Configuration
problems say `The voice router needs attention. Check the Shortcut result.` A
clipboard failure says `I couldn't copy the answer. Check the Shortcut result.`
These notices use the unconfigured system speech defaults and never include
provider or request detail.

Handled routing and generation failures exit `0` only when their notice is
spoken successfully. Configuration, missing-command, clipboard, and answer
speech failures exit `1`; if answer speech fails after copying, the answer stays
on the clipboard and no replacement notice is spoken. Cancellation exits `130`.
Shortcuts may otherwise show little beyond the sanitized diagnostic in the
shell action result.

### A custom speech profile fails

Run `/usr/bin/say -v '?'` again and copy the voice name exactly. Check that the
profile section uses the canonical lowercase alias printed by
`llm-now --aliases`, that TOML strings are quoted, and that `rate` is an integer
from 80 through 500. `pitch` must be an integer or fractional number from 1
through 127; do not put `[[...]]` commands in the profile.

### A local model returns plain text without markers

That is supported. The router never asks a model for control markers, JSON, or a
separate summary. It makes one generation request and copies the safe UTF-8
response unchanged. If `pitch` is configured, the router adds its validated
command only to the separate speech input.

## Privacy and state

- macOS Dictation handles the transcript before `llm-now` receives it and may
  use Apple services. Review Apple's Dictation settings and policy for the
  selected mode.
- A hosted alias sends the accepted question content to its selected provider.
  Use a suitable local alias for material that should not leave the Mac, and do
  not dictate sensitive material in an unsuitable setting.
- Speech is audible to people and devices nearby.
- The unified TOML contains plaintext alias targets, optional instructions,
  routing settings, and speech preferences, but never credentials. Migration
  backups are plaintext too; protect the configuration directory.
- A successful answer replaces the clipboard before speech begins and remains
  there until another application replaces it; `llm-now` does not clear it.
- Only one invocation is supported at a time. Overlapping requests can
  interleave global clipboard writes and audible speech.
- Technical diagnostics stay on stderr and are never copied or spoken. Model
  output containing terminal controls or macOS `[[...]]` speech commands is
  rejected before either side effect.

## Contributor-only Python parity oracle

Release users do not need Python, uv, or a repository checkout. Contributors
keep the complete [`macos-voice-router`](macos-voice-router) Python example as
an independent routing and score oracle. It uses its locked RapidFuzz reference
and the shared parity corpus; native production code does not launch it.

From a repository checkout with uv installed, run the complete locked reference
suite exactly as source CI does:

```bash
uv run --project examples/macos-voice-router --locked \
  python -m unittest discover -s examples/macos-voice-router/tests
```

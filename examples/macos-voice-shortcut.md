# Talk to an llm-now alias from a macOS shortcut

Press a keyboard shortcut, dictate an alias and question, then hear the answer.
The same answer is copied to the clipboard. The Shortcut itself has only two
actions:

1. `Dictate Text`
2. `Run Shell Script`

The shell action starts the uv-managed router in
[`macos-voice-router`](macos-voice-router). The router reads the current aliases
from `llm-now --aliases`, rejects uncertain matches, calls the selected alias
once, copies the answer, and speaks it with macOS `say`.

## Before you start

You need:

- macOS Dictation enabled in **System Settings → Keyboard → Dictation**;
- `uv` installed;
- `llm-now` installed and available on `PATH`;
- this repository checkout; and
- at least one working saved alias.

Confirm the command-line pieces in Terminal:

```bash
command -v uv
command -v llm-now
llm-now --aliases
cd /path/to/llm-now
pwd
```

Keep the three absolute paths printed by those commands. The first uv run may
download RapidFuzz from PyPI. The three-minute setup target assumes ordinary
network access for that first run; run this once before starting an offline or
timed setup:

```bash
uv sync --project /absolute/path/to/llm-now/examples/macos-voice-router \
  --locked --no-dev
```

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

Paste this launcher and replace all three example paths:

```zsh
#!/bin/zsh
set -euo pipefail

UV="/opt/homebrew/bin/uv"
PROJECT="/Users/you/Code/llm-now/examples/macos-voice-router"
LLM_NOW_DIR="/opt/homebrew/bin"

export PATH="$LLM_NOW_DIR:/usr/bin:/bin:/usr/sbin:/sbin"
exec "$UV" run \
  --project "$PROJECT" \
  --locked \
  --no-dev \
  llm-now-voice
```

`UV` is the full `command -v uv` result. `PROJECT` ends at
`examples/macos-voice-router`. `LLM_NOW_DIR` is the directory containing the
full `command -v llm-now` result, not the executable itself.

Do not put API keys in this script. Shortcuts does not reliably inherit
variables from an interactive shell. Use a local or CLI-backed alias, a normal
provider environment available to GUI apps, or llm-now's supported native
credential storage.

Run the Shortcut from the editor. The first run can take longer while uv creates
the isolated environment. Success means:

- the answer is spoken;
- the identical answer is on the clipboard; and
- the shell action needs no `Speak Text` or clipboard action after it.

Paste somewhere to confirm the clipboard. Fix this Text test before involving
the microphone; it isolates paths, dependencies, aliases, and providers from
Dictation permissions.

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
the current run to finish before starting another one; the Shortcut remains
active while the provider and speech processes run.

If macOS asks whether Shortcuts may run shell scripts, allow it. Managed Macs
may require an administrator to permit that capability.

## How alias matching works

Aliases are discovered on every request, so adding an llm-now alias does not
require editing the Shortcut or copying an alias roster into another file.

The router examines only the leading spoken phrase and tries these stages:

1. normalized canonical alias;
2. configured `match_phrases`; and
3. conservative RapidFuzz similarity.

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

## Optional names and speech

The zero-configuration path is usually enough. To customize it, create:

```text
~/.config/llm-now/voice-router.toml
```

If `XDG_CONFIG_HOME` is available to Shortcuts, the file instead lives at
`$XDG_CONFIG_HOME/llm-now/voice-router.toml`.

Use one flat section per canonical lowercase alias:

```toml
wake_words = ["hey", "computer"]

[terra]
match_phrases = ["tara"]
voice = "Samantha"
rate = 205

[opus47]
match_phrases = ["op 47"]

[slug]
voice = "Eddy (English (US))"
rate = 180
pitch = 50
```

Every field is optional:

- omit `wake_words` to use `["hey"]`;
- use `wake_words = []` to disable wake-word stripping;
- omit `match_phrases` to rely on canonical and fuzzy matching;
- omit `voice` and `rate` to inherit the current macOS defaults;
- omit `pitch` to use the voice's normal baseline pitch;
- keep `rate` between 80 and 500; and
- keep `pitch` between 1 and 127, inclusive. Integers and fractional values such
  as `50.5` are accepted.

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
changing the voice or alias. A profile for a removed alias is inert, but its TOML
must still be structurally valid.

The root name `wake_words` is reserved by this flat format. A literal llm-now
alias named `wake_words` still routes with system speech defaults, but cannot
have a profile in this version.

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

For an ambiguity check, use a disposable alias store containing two harmless
near neighbors such as `qwen` and `when`, then say `Kwen, answer this`. The
router must reject instead of choosing row order. Do not alter a production
alias store only to run this check.

Stop a local provider or otherwise make a test alias fail, reset the clipboard
sentinel, and ask it a question. You should hear only the stable request-failed
notice. Provider stderr must not enter speech or the clipboard.

Start a deliberately slow request and press the Shortcut's stop button. Wait
past the provider's normal response time. There must be no delayed speech or
new downstream action. If cancellation occurs after copying has begun, macOS
may already have partially or fully changed the clipboard; the router does not
attempt an unsafe restore.

Automated tests cover otherwise destructive failure injection for `pbcopy`,
`say`, timeouts, invalid UTF-8, control bytes, and process-group force-kill:

```bash
uv run --project examples/macos-voice-router --locked \
  python -m unittest discover -s examples/macos-voice-router/tests
```

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

Recheck `UV`, `PROJECT`, `LLM_NOW_DIR`, **Pass Input: to stdin**, and the shell's
script-running permission. Paths in Shortcuts do not use your interactive
shell aliases or startup files.

Run the same launcher from Terminal with a transcript to see local diagnostics:

```bash
printf 'haiku, explain a perfect chord' | /bin/zsh /path/to/copied-launcher.zsh
```

Handled routing and provider failures return after a spoken notice, so the shell
action may otherwise show no useful result. Configuration, missing-command,
clipboard, and speech failures return nonzero so Shortcuts exposes the action
error.

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

- macOS Dictation handles the transcript before the router receives it; review
  Apple's Dictation settings and policy for the selected mode.
- An accepted question and answer cross the local or hosted provider selected by
  the alias. Use a local alias for material that should not leave the Mac.
- The optional TOML file contains presentation preferences, not credentials.
- A successful answer replaces the clipboard before speech begins and remains
  there after the Shortcut finishes.
- Technical diagnostics stay on stderr and are never copied or spoken. Model
  output containing terminal controls or macOS `[[...]]` speech commands is
  rejected before either side effect.

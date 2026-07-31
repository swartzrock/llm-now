# Talk to an `llm-now` alias with macOS Dictation

Press one keyboard shortcut, say “Hey qwen, what is a perfect chord in music
theory?”, and hear a short answer. The same request’s detailed answer is copied
to the clipboard so you can paste it later.

This guide targets macOS Sequoia 15.7 and ends with the manual checks needed to
validate the workflow on your Mac. It uses only `llm-now` and the Dictation,
Shortcuts, clipboard, and speech features included with macOS. Later macOS
versions may use different action names or settings.

## Before you dictate

This Shortcut moves data across several trust boundaries:

- Dictation may send audio or a transcript to Apple, depending on your language
  and Dictation settings.
- The alias spelling selects the provider that receives your transcribed question.
  That provider may retain or use questions and responses according to its
  account settings and policies.
- The script briefly stores the prompt, response, and diagnostics in a private
  temporary directory. It removes them after normal completion and handled
  failures, but a forced termination can leave private temporary files behind.
- The detailed answer replaces the general macOS clipboard. Universal Clipboard
  may make it available to your other signed-in Apple devices.
- The short answer is spoken aloud.
- Model output is untrusted. Inspect it before pasting it into a terminal,
  script, configuration file, or privileged application.

Check Apple’s Dictation terms and your provider’s retention settings before
dictating sensitive material. Use private audio when other people should not hear
the answer.

Never paste an API key, token, or other secret into the Shortcut or the script
below. Configure credentials through `llm-now` or the provider’s supported
credential mechanism first.

## Prerequisites

You need:

1. macOS Sequoia 15.7.
2. A working `llm-now` installation.
3. One short, speech-friendly alias, such as `qwen` or `codex`. `llm-now`
   stores and displays it in lowercase.
4. Provider credentials that work outside an interactive Terminal session.

Alias matching is case-insensitive but spelling-exact. `qwen`, `Qwen`, and
`QWEN` select the same saved alias, while `kwen` does not. There is no fuzzy,
proximity, or pronunciation matching. The Shortcut passes Dictation's alias
unchanged and `llm-now` owns the case normalization, so do not create duplicate
case-only aliases or add lowercasing to the Shortcut.

In Terminal, resolve the executable and test your alias:

```bash
command -v llm-now
printf 'Reply with the word ready.' |
  /absolute/path/from-the-command-above --alias Qwen
```

Keep the absolute path from the first command. Replace `Qwen` with any
capitalization of your saved alias. If the second command fails, finish `llm-now` or provider setup before
continuing. A Terminal success is preliminary; you will also test the provider
inside Shortcuts.

## Enable the macOS features

1. Open **System Settings > Keyboard**. Turn on **Dictation**, select the
   language and microphone you plan to use, and note the configured Dictation
   keyboard shortcut.
2. If Voice Control is enabled, turn it off while using this workflow. Voice
   Control replaces standard Dictation.
3. Open Shortcuts, then choose **Shortcuts > Settings > Advanced** and enable
   **Allow Running Scripts**. Apple warns that untrusted scripts can cause data
   loss; use only the fixed script you have reviewed below.

Dictation availability and on-device processing vary by language and settings.
Standard Dictation also stops after about 30 seconds without speech.

## Build the Shortcut

Create a Shortcut named **Talk to llm-now** with these three actions, in order:

1. **Dictate Text**
   - Use the language and microphone you just verified.
2. **Run Shell Script**
   - Shell: `/bin/zsh`
   - Pass Input: `to stdin`
   - Input: the result of **Dictate Text**
   - Paste the script below.
3. **Speak Text**
   - Text: the result of **Run Shell Script**
   - Leave **Wait Until Finished** enabled.

The visible connection between each action should carry Text to the next action.
Do not insert Dictated Text into the shell source as a variable or Magic
Variable. The fixed script receives it only through stdin.

Replace only the `LLM_NOW` value with the absolute path you found in Terminal:

```zsh
#!/bin/zsh
set -u
umask 077

LLM_NOW="/absolute/path/to/llm-now"

INPUT_ERROR="I couldn't understand the alias and question. Please try again."
REQUEST_ERROR="The request failed. Check the alias and provider, then try again."
COPY_ERROR="I couldn't copy the answer. The clipboard was not changed."
FORMAT_WARNING="I copied an unvalidated response. Review it before pasting."

SPEAK_MARKER="<<<LLM_NOW_SPEAK_V1>>>"
FULL_MARKER="<<<LLM_NOW_FULL_V1>>>"
END_MARKER="<<<LLM_NOW_END_V1>>>"

emit() {
  /usr/bin/printf '%s\n' "$1"
}

speech_is_safe() {
  local speech="$1"
  local lower line without_end
  local line_prefix='^[[:space:]]*(#{1,6}[[:space:]]|>|[-+*][[:space:]]|[0-9]+[.)][[:space:]]|\|)'
  local horizontal_rule='^[[:space:]]*(-{3,}|\*{3,}|_{3,})[[:space:]]*$'
  local sentence_break='[.!?][[:space:]]+'
  local uri_scheme='(^|[[:space:](])([[:alpha:]][[:alnum:]+.-]*://|mailto:|file:|tel:|sms:)'
  local bare_domain='(^|[[:space:](])([[:alnum:]-]+\.)+[[:alpha:]]{2,}([/:?#]|[[:space:]),.!?]|$)'
  local email_address='[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}'
  local install_command='(^|[[:space:]])((python(3)?[[:space:]]+-m[[:space:]]+)?pip(3)?[[:space:]]+install|(npm|pnpm|yarn)[[:space:]]+(add|install)|bun[[:space:]]+add|(brew|gem|cargo|apt|apt-get|dnf|yum)[[:space:]]+install)([[:space:]]|$)'
  local -a lines

  [[ -n "$speech" ]] || return 1
  [[ "$speech" != $'\n'* && "$speech" != *$'\n' ]] || return 1
  [[ "$speech" != *$'\n\n'* ]] || return 1

  lines=("${(@f)speech}")
  (( ${#lines[@]} >= 1 && ${#lines[@]} <= 3 )) || return 1

  lower="${speech:l}"
  [[ "$lower" != *'http://'* && "$lower" != *'https://'* &&
     "$lower" != *'www.'* ]] || return 1
  [[ ! "$lower" =~ $uri_scheme && ! "$lower" =~ $bare_domain &&
     ! "$lower" =~ $email_address &&
     ! "$lower" =~ $install_command ]] || return 1
  [[ "$speech" != *'`'* && "$speech" != *'*'* &&
     "$speech" != *'_'* && "$speech" != *'<'* &&
     "$speech" != *'>'* && "$speech" != *'['* &&
     "$speech" != *']'* && "$speech" != *'#'* &&
     "$speech" != *'|'* && "$speech" != *'~'* ]] || return 1

  for line in "${lines[@]}"; do
    [[ -n "$line" && ${#line} -le 200 ]] || return 1
    [[ "$line" == *[.!?] ]] || return 1
    [[ ! "$line" =~ $line_prefix ]] || return 1
    [[ ! "$line" =~ $horizontal_rule ]] || return 1
    without_end="${line[1,-2]}"
    [[ ! "$without_end" =~ $sentence_break ]] || return 1
  done
}

input=$(/bin/cat)

if [[ -z "$input" || ${#input} -gt 4208 ]]; then
  emit "$INPUT_ERROR"
  exit 0
fi

if [[ "$input" == *$'\n'* || "$input" == *$'\r'* ||
      "$input" == *$'\t'* ]] ||
   /usr/bin/printf '%s' "$input" |
     LC_ALL=C /usr/bin/grep -q '[[:cntrl:]]'; then
  emit "$INPUT_ERROR"
  exit 0
fi

request_pattern='^[Hh][Ee][Yy][[:space:]]+([A-Za-z0-9][A-Za-z0-9_-]{0,63})[,;:]?[[:space:]]+(.+)$'
if [[ ! "$input" =~ $request_pattern ]]; then
  emit "$INPUT_ERROR"
  exit 0
fi

alias_name="${match[1]}"
question="${match[2]}"
question="${question#"${question%%[![:space:]]*}"}"
question="${question%"${question##*[![:space:]]}"}"

if [[ -z "$question" || ${#question} -gt 4096 || ! -x "$LLM_NOW" ]]; then
  if [[ ! -x "$LLM_NOW" ]]; then
    emit "$REQUEST_ERROR"
  else
    emit "$INPUT_ERROR"
  fi
  exit 0
fi

workdir=$(/usr/bin/mktemp -d -t llm-now-voice 2>/dev/null)
if [[ -z "$workdir" || ! -d "$workdir" ]]; then
  emit "$REQUEST_ERROR"
  exit 0
fi

prompt_file="$workdir/prompt.txt"
stdout_file="$workdir/stdout.txt"
stderr_file="$workdir/stderr.txt"

cleanup() {
  /bin/rm -f "$prompt_file" "$stdout_file" "$stderr_file"
  /bin/rmdir "$workdir" 2>/dev/null || true
}

trap cleanup EXIT
trap 'cleanup; trap - EXIT; exit 130' HUP INT TERM

{
  /usr/bin/printf '%s\n' \
    'You are answering a question for a voice shortcut.' \
    'Return exactly the three marker lines and two content blocks shown below.' \
    "First print $SPEAK_MARKER" \
    'Then print one to three short sentences, one per line.' \
    'The spoken sentences must contain no code, URLs, Markdown, lists, or marker text.' \
    "Then print $FULL_MARKER" \
    'Then print the complete useful answer. Markdown is allowed in this block.' \
    "Finally print $END_MARKER" \
    'Print nothing before the first marker or after the final marker.' \
    '' \
    'Question:'
  /usr/bin/printf '%s\n' "$question"
} > "$prompt_file"

"$LLM_NOW" --alias "$alias_name" \
  < "$prompt_file" > "$stdout_file" 2> "$stderr_file"
exit_status=$?

if (( exit_status != 0 )); then
  emit "$REQUEST_ERROR"
  exit 0
fi

response=$(<"$stdout_file")
if [[ -z "$response" ]]; then
  emit "$REQUEST_ERROR"
  exit 0
fi

full_separator=$'\n'"$FULL_MARKER"$'\n'
end_suffix=$'\n'"$END_MARKER"
envelope_ok=1

if [[ "$response" != "$SPEAK_MARKER"$'\n'* ||
      "$response" != *"$full_separator"* ||
      "$response" != *"$end_suffix" ]]; then
  envelope_ok=0
else
  body="${response#"$SPEAK_MARKER"$'\n'}"
  spoken="${body%%"$full_separator"*}"
  remainder="${body#*"$full_separator"}"
  full_answer="${remainder%"$end_suffix"}"

  if [[ -z "$spoken" || -z "$full_answer" ||
        "$spoken" == *"$SPEAK_MARKER"* ||
        "$spoken" == *"$FULL_MARKER"* ||
        "$spoken" == *"$END_MARKER"* ||
        "$full_answer" == *"$SPEAK_MARKER"* ||
        "$full_answer" == *"$FULL_MARKER"* ||
        "$full_answer" == *"$END_MARKER"* ]] ||
     ! speech_is_safe "$spoken"; then
    envelope_ok=0
  fi
fi

if (( envelope_ok == 0 )); then
  if /usr/bin/printf '%s' "$response" | /usr/bin/pbcopy; then
    emit "$FORMAT_WARNING"
  else
    emit "$COPY_ERROR"
  fi
  exit 0
fi

if /usr/bin/printf '%s' "$full_answer" | /usr/bin/pbcopy; then
  /usr/bin/printf '%s\n' "$spoken"
else
  emit "$COPY_ERROR"
fi
```

The script treats the dictated phrase as data, never shell source. It accepts
`Hey` in any capitalization and passes the extracted alias to `llm-now`
unchanged. `llm-now` resolves ASCII capitalization; the Shortcut does not.
Questions are limited to 4,096 characters. A valid response is copied before
the script returns the short speech text.

If the model ignores the response markers or emits unsafe speech text, the raw
response is copied and the Shortcut says, “I copied an unvalidated response.
Review it before pasting.” Provider errors, unknown aliases, timeouts, and empty
responses leave the clipboard unchanged.

## Test the real provider inside Shortcuts

Do this after reading the privacy notes and before assigning a global hotkey:

1. Temporarily replace **Dictate Text** with a **Text** action.
2. Enter `hey Qwen, explain a perfect chord in one sentence`, using a
   capitalization that differs from the lowercase saved alias.
3. Run the Shortcut from the editor.
4. Confirm you hear a short answer and can paste a more detailed answer.
5. Restore **Dictate Text**.

This uses the actual **Run Shell Script** action and therefore catches
credentials or executable paths that work in Terminal but not in Shortcuts.
Treat a failure here as an unmet prerequisite; do not add credentials to the
script to make it pass.

## Add the global keyboard shortcut

Open the Shortcut’s **Details**, choose **Add Keyboard Shortcut**, and enter an
unused combination. `Control-Option-Command-V` is one reasonable starting point,
but your installed apps may already use it. macOS cannot override a reserved
system shortcut.

Press the shortcut from an unrelated app, then say:

> Hey Qwen, what is a perfect chord in music theory?

Pause after the alias so Dictation inserts a comma. The comma is optional to the
parser. Alias spelling must match, but capitalization may differ. Wait for spoken success
or failure before invoking the Shortcut again. On macOS 15.7, also confirm the
Shortcuts running control remains visible while the request is active.

## Manual verification

Preload a recognizable clipboard sentinel before every failure test:

```bash
printf 'VOICE-SENTINEL' | /usr/bin/pbcopy
```

Record the spoken text, pasted clipboard text, and pass or fail result for each
check.

| Check | Action | Expected result |
| --- | --- | --- |
| Deterministic success | Replace **Dictate Text** with **Text** and enter a capitalized form of your lowercase saved alias. | A short prose answer is spoken. The detailed answer is already on the clipboard, with no response markers. |
| Live Dictation | Restore **Dictate Text**, invoke the hotkey from two unrelated apps, and dictate a valid phrase, allowing Dictation to capitalize the alias. | Dictation starts globally, one answer is spoken, and the detailed answer is copied. |
| Wrong alias | Use a misspelling such as an added, removed, or changed letter. | The request-failure message is spoken. No nearby alias is selected and `VOICE-SENTINEL` remains. |
| Invalid input | Try no wake word, no alias, no question, a line break, and a question longer than 4,096 characters. | The input-failure message is spoken. The provider is not called and the sentinel remains. |
| Spoken safety | Ask for a Python library that prints colored terminal text. | Speech contains no install command, code, URL, Markdown, marker, or raw diagnostic. The clipboard retains useful package details. |
| Malformed model output | Use the disposable test copy described below with `TEST_MALFORMED`. | Raw output is copied. Only the fixed unvalidated-response warning is spoken. |
| Provider failure | Use the disposable test copy with `TEST_FAIL` and then `TEST_EMPTY`. | The request-failure message is spoken and the sentinel remains. |
| Cancellation | Start a slow request, cancel it from Shortcuts, and wait through the normal `llm-now` timeout window. | No later speech or clipboard change occurs. Record any provider process that survives. Cancellation does not revoke data already sent to a provider. |
| Hotkey conflict | Invoke the chosen combination from at least two unrelated apps. | The Shortcut starts each time and no app or reserved system action wins the key combination. |
| Setup time | Repeat setup with prerequisites already satisfied. | The Shortcut is usable in under ten minutes. |

For the response-format reliability check, the first three live questions after
setup are one fixed window. All three must produce valid spoken and clipboard
channels without the unvalidated-response warning. A fallback fails the window
and marks that alias/model unvalidated. Record and change a likely cause before
starting a new window; do not discard failures or keep retrying merely to obtain
a passing streak.

### Deterministic failure checks

These optional checks use only built-in shell tools. They do not contact a
provider or replace the real clipboard.

In Terminal, create two temporary fake commands:

```bash
TEST_DIR=$(/usr/bin/mktemp -d -t llm-now-voice-test)

/bin/cat > "$TEST_DIR/llm-now" <<'ZSH'
#!/bin/zsh
prompt=$(/bin/cat)
/usr/bin/printf '1\n' >> "${0:A:h}/calls.txt"
[[ "$1" == "--alias" && "${2:l}" == "testalias" ]] || exit 1

envelope() {
  /usr/bin/printf '%s\n' \
    '<<<LLM_NOW_SPEAK_V1>>>' "$1" \
    '<<<LLM_NOW_FULL_V1>>>' "$2" \
    '<<<LLM_NOW_END_V1>>>'
}

case "$prompt" in
  (*TEST_MALFORMED_COPY_FAIL*)
    /usr/bin/printf 'raw TEST_COPY_FAIL response'
    ;;
  (*TEST_MALFORMED*)
    /usr/bin/printf 'raw **Markdown** response'
    ;;
  (*TEST_EMPTY_SPEAK*)
    envelope '' 'Detailed clipboard answer.'
    ;;
  (*TEST_MARKER_COLLISION*)
    envelope 'This begins as safe prose.' \
      'Detailed answer with <<<LLM_NOW_SPEAK_V1>>> collision.'
    ;;
  (*TEST_TRAILING*)
    /usr/bin/printf '%s\n' \
      '<<<LLM_NOW_SPEAK_V1>>>' \
      'This begins as safe prose.' \
      '<<<LLM_NOW_FULL_V1>>>' \
      'Detailed clipboard answer.' \
      '<<<LLM_NOW_END_V1>>>' \
      'Unexpected trailing text.'
    ;;
  (*TEST_UNSAFE_MARKDOWN*)
    envelope 'Use **Rich** for color.' 'Detailed clipboard answer.'
    ;;
  (*TEST_UNSAFE_URL*)
    envelope 'Read ftp://example.com/docs.' 'Detailed clipboard answer.'
    ;;
  (*TEST_UNSAFE_FILE_URL*)
    envelope 'Open file:///tmp/example.' 'Detailed clipboard answer.'
    ;;
  (*TEST_UNSAFE_MAILTO*)
    envelope 'Write to mailto:user@example.com.' \
      'Detailed clipboard answer.'
    ;;
  (*TEST_UNSAFE_DOMAIN*)
    envelope 'Read example.com for details.' 'Detailed clipboard answer.'
    ;;
  (*TEST_UNSAFE_COMMAND*)
    envelope 'Run pip install rich.' 'Detailed clipboard answer.'
    ;;
  (*TEST_FAIL*)
    exit 1
    ;;
  (*TEST_EMPTY*)
    ;;
  (*TEST_COPY_FAIL*)
    envelope 'This is a safe spoken answer.' 'TEST_COPY_FAIL'
    ;;
  (*)
    envelope 'This is a safe spoken answer.' \
      'Detailed **clipboard** answer.'
    ;;
esac
ZSH

/bin/cat > "$TEST_DIR/pbcopy" <<'ZSH'
#!/bin/zsh
payload=$(/bin/cat)
[[ "$payload" != *TEST_COPY_FAIL* ]] || exit 1
/usr/bin/printf '%s' "$payload" > "${0:A:h}/clipboard.txt"
ZSH

/bin/chmod 700 "$TEST_DIR/llm-now" "$TEST_DIR/pbcopy"
/usr/bin/printf '%s\n' "$TEST_DIR"
```

Duplicate the Shortcut and name the duplicate **Talk to llm-now - Test**. In
that disposable copy only:

1. Replace `LLM_NOW` with the printed temporary `llm-now` path.
2. Replace both occurrences of `/usr/bin/pbcopy` with the printed temporary
   `pbcopy` path.
3. Replace **Dictate Text** with a **Text** action.

Before every row, reset the fake clipboard and call log in Terminal:

```bash
printf 'VOICE-SENTINEL' > "$TEST_DIR/clipboard.txt"
rm -f "$TEST_DIR/calls.txt"
```

Run the row once through the Text action. Then inspect the fake clipboard and
count calls:

```bash
cat "$TEST_DIR/clipboard.txt"
wc -l < "$TEST_DIR/calls.txt" 2>/dev/null || printf '0\n'
```

| Text value | Expected speech | Expected fake clipboard | Calls |
| --- | --- | --- | --- |
| `hey testalias, TEST_OK` | `This is a safe spoken answer.` | `Detailed **clipboard** answer.` | 1 |
| `hello testalias, TEST_OK` | The fixed input-failure message | `VOICE-SENTINEL` | 0 |
| `hey TestAlias, TEST_OK` | `This is a safe spoken answer.` | `Detailed **clipboard** answer.` | 1 |
| `hey testaliass, TEST_OK` | The fixed request-failure message | `VOICE-SENTINEL` | 1 |
| `hey testalias, TEST_MALFORMED` | The fixed unvalidated-response warning | `raw **Markdown** response` | 1 |
| `hey testalias, TEST_EMPTY_SPEAK` | The fixed unvalidated-response warning | Raw fake envelope, including markers | 1 |
| `hey testalias, TEST_MARKER_COLLISION` | The fixed unvalidated-response warning | Raw fake envelope, including markers | 1 |
| `hey testalias, TEST_TRAILING` | The fixed unvalidated-response warning | Raw fake envelope, including markers | 1 |
| `hey testalias, TEST_UNSAFE_MARKDOWN` | The fixed unvalidated-response warning | Raw fake envelope, including markers | 1 |
| `hey testalias, TEST_UNSAFE_URL` | The fixed unvalidated-response warning | Raw fake envelope, including markers | 1 |
| `hey testalias, TEST_UNSAFE_FILE_URL` | The fixed unvalidated-response warning | Raw fake envelope, including markers | 1 |
| `hey testalias, TEST_UNSAFE_MAILTO` | The fixed unvalidated-response warning | Raw fake envelope, including markers | 1 |
| `hey testalias, TEST_UNSAFE_DOMAIN` | The fixed unvalidated-response warning | Raw fake envelope, including markers | 1 |
| `hey testalias, TEST_UNSAFE_COMMAND` | The fixed unvalidated-response warning | Raw fake envelope, including markers | 1 |
| `hey testalias, TEST_COPY_FAIL` | The fixed clipboard-failure message | `VOICE-SENTINEL` | 1 |
| `hey testalias, TEST_MALFORMED_COPY_FAIL` | The fixed clipboard-failure message | `VOICE-SENTINEL` | 1 |
| `hey testalias, TEST_FAIL` | The fixed request-failure message | `VOICE-SENTINEL` | 1 |
| `hey testalias, TEST_EMPTY` | The fixed request-failure message | `VOICE-SENTINEL` | 1 |

Use a Text value containing quotes, dollar signs, backticks, semicolons, pipes,
and redirections; those characters must appear only in the fake prompt and must
not execute another command. Its call count must still be exactly one.

Delete the disposable test Shortcut, then remove the printed temporary test
directory. Do not copy either fake-command path into the production Shortcut.

## Troubleshooting and permission recovery

| Symptom | Repair on macOS 15.7 | Rerun and recovery sign |
| --- | --- | --- |
| Dictation never starts or uses the wrong input | Open **System Settings > Keyboard**. Turn on Dictation and select the intended language and microphone. If Voice Control is enabled, turn it off. | Run **Dictate Text** alone. The live transcript appears from the selected microphone. |
| Shortcuts cannot use the microphone | Open **System Settings > Privacy & Security > Microphone** and allow Shortcuts when it appears. | Run the Shortcut again. macOS records speech instead of immediately denying access. |
| **Run Shell Script** is blocked | Open **Shortcuts > Settings > Advanced** and enable **Allow Running Scripts**. | Rerun the Text-action preflight. The shell action returns speech text. |
| A permission was denied for this Shortcut | Open the Shortcut editor, choose **Details > Privacy**, and reset the relevant decision. If no Privacy tab appears, run once to trigger the request. | Rerun and choose **Allow Once** or **Always Allow** only for access you understand. The blocked action completes. |
| The request works in Terminal but fails in Shortcuts | Recheck the absolute executable path and use the real-provider Text-action preflight. Configure credentials through `llm-now` or the provider’s supported mechanism, never in the script. | The same fixed script succeeds from **Run Shell Script** before a hotkey is assigned. |
| A capitalized alias works but a similar spelling fails | This is expected. Keep one lowercase saved alias and use any capitalization of that spelling. Correct Dictation or rename the alias if it changes letters; do not add case-only duplicates or lowercase inside the Shortcut. | The corrected spelling reaches the saved alias. A misspelling still produces the fixed request-failure message without changing the clipboard. |
| The warning is frequent | The model is not reliably following the response envelope. Try a clearer model or repair the prompt contract, then start a new fixed three-run window. | Three first-attempt runs complete without fallback. |
| Speech fails after a successful copy | Paste into a safe text editor and inspect the answer before deciding whether to retry. | The detailed answer is present even though speech did not finish. |

Canceling Shortcuts cannot recall a request already transmitted to a provider,
and macOS does not promise immediate termination of every provider child
process. Do not use cancellation as a privacy control.

## Apple references

- [Run a Shortcut while working on macOS 15](https://support.apple.com/guide/shortcuts-mac/launch-a-shortcut-from-another-app-apd163eb9f95/7.0/mac/15.0)
- [Use Dictation on macOS 15](https://support.apple.com/guide/mac-help/use-dictation-mh40584/15.0/mac/15.0)
- [Action connections in Shortcuts](https://support.apple.com/guide/shortcuts-mac/action-connections-apda850ab0e1/7.0/mac/15.0)
- [Advanced Shortcuts settings](https://support.apple.com/guide/shortcuts-mac/advanced-shortcuts-settings-apdfeb05586f/7.0/mac/15.0)
- [Shortcut privacy settings](https://support.apple.com/guide/shortcuts-mac/adjust-privacy-settings-apd961a4fc65/7.0/mac/15.0)

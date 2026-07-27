# The llm-now cookbook

Twenty small workflows built from one idea: put useful context on stdin, get only
the model response on stdout, and hand that response to the next ordinary command.

The examples use saved aliases named `haiku` and `local`. Replace those names with
your own aliases. Run bare `llm-now` in an interactive terminal if you need to
create one.

## Before you start

The functions in this cookbook work in Bash and Zsh. Add the ones you like to
`~/.bashrc`, `~/.zshrc`, or a separate file sourced by either shell.

Several recipes produce Markdown. Add this helper once to get syntax-highlighted
output when [`bat`](https://github.com/sharkdp/bat) is installed and readable raw
Markdown when it is not:

```bash
llm_markdown() {
  if command -v bat >/dev/null 2>&1; then
    bat --language markdown
  else
    cat
  fi
}
```

Most functions write the raw model response to stdout. Pipe that response through
`llm_markdown` for display, redirect it to a file, or compose it with another
command. `batman` renders internally, while the clipboard, Stickies, and speech
recipes explicitly describe their side effects.

```bash
some_recipe | llm_markdown
some_recipe > draft.md
```

Keep three rules in mind:

1. The selected model receives everything you pipe into `llm-now`. Use a local
   alias or sanitize the input when it may contain secrets, customer data, private
   filenames, or proprietary code.
2. Treat every response as a draft. Confirm commands, technical claims, owners,
   dates, and safety-sensitive advice against the original source.
3. Never pipe generated shell commands directly into a shell. Review them first.

## Recipes at a glance

| # | Recipe | Audience | Extra tools |
| --- | --- | --- | --- |
| 1 | [A commit message from the staged diff](#1-let-the-staged-diff-write-its-own-commit-message) | Developer | Git |
| 1b | [The same commit-message feature in lazygit](#1b-add-the-same-feature-to-lazygit) | Developer | Git, lazygit |
| 2 | [A tone dial for the clipboard](#2-add-a-tone-dial-to-the-clipboard) | Power user | macOS |
| 3 | [A patient man-page tutor](#3-turn-any-man-page-into-a-patient-tutor) | New to LLMs | `man`, `col` |
| 4 | [A test-failure doctor](#4-make-a-red-test-run-explain-itself) | Developer | Your test runner |
| 5 | [A pep talk in Stickies](#5-leave-future-you-a-pep-talk-in-stickies) | Power user | macOS |
| 6 | [A quiz made from your notes](#6-make-your-own-notes-quiz-you) | New to LLMs | — |
| 7 | [A skeptical diff preflight](#7-ask-a-skeptical-maintainer-to-preflight-your-diff) | Developer | Git |
| 8 | [A spoken focus reset](#8-let-the-terminal-talk-you-through-a-reset) | Power user | macOS |
| 9 | [A decision pre-mortem](#9-run-a-pre-mortem-before-you-make-the-decision) | New to LLMs | — |
| 10 | [Release notes from Git history](#10-turn-the-commit-trail-into-release-notes) | Developer | Git |
| 11 | [Action items from meeting notes](#11-turn-meeting-notes-into-commitments) | Power user | — |
| 12 | [Dinner from the pantry](#12-let-the-pantry-propose-dinner) | New to LLMs | — |
| 13 | [An incident handoff from logs](#13-turn-200-log-lines-into-an-incident-handoff) | Developer / SRE | `tail` |
| 14 | [A Downloads cleanup plan](#14-let-your-downloads-folder-propose-a-cleanup-plan) | Power user | `find` |
| 15 | [TODO archaeology](#15-do-todo-archaeology-instead-of-todo-counting) | Developer | `rg` |
| 16 | [A checklist from a rough note](#16-turn-a-messy-note-into-an-actionable-checklist) | Power user | — |
| 17 | [A lazygit commit explainer](#17-give-lazygit-an-explain-this-commit-command) | Developer | Git, optional lazygit |
| 18 | [A local-versus-cloud comparison](#18-ask-the-same-prompt-locally-and-in-the-cloud) | LLM-curious | Bash or Zsh |
| 19 | [An Emacs text filter](#19-give-emacs-a-model-without-an-ai-plugin) | Developer | Emacs |
| 20 | [Mission control for your laptop](#20-have-mission-control-narrate-your-laptop) | Power user | `uptime` |

## 1. Let the staged diff write its own commit message

**Audience:** Developers using Git

This sends only the staged diff and asks for a reviewable Conventional Commit
message. It never runs `git commit`.

```bash
llm_commit_message() {
  local diff

  if ! diff=$(git diff --cached); then
    return 1
  fi

  if [ -z "$diff" ]; then
    printf 'llm_commit_message: no staged changes\n' >&2
    return 1
  fi

  {
    printf '%s\n\n' \
      'Write a Conventional Commit message for this staged diff. Return only the message.'
    printf '%s\n' "$diff"
  } | llm-now haiku
}

llm_commit_message | llm_markdown
```

Stage a small change, run the function, and compare the message with
`git diff --cached`. Review and edit the result before using it.

### 1b. Add the same feature to lazygit

**Audience:** Lazygit users

This custom command reuses `llm_commit_message` and `llm_markdown` from above. It
shows a draft for the staged changes, but never runs `git commit`.

1. Put both functions in a small shell file, such as
   `~/.config/lazygit/llm-now-functions.sh`, and source that file from your normal
   Bash or Zsh startup file.
2. Merge the following settings into lazygit's `config.yml`. If `os` or
   `customCommands` already exists, add to those sections instead of creating a
   duplicate key.

```yaml
os:
  shellFunctionsFile: ~/.config/lazygit/llm-now-functions.sh

customCommands:
  - key: G
    context: files
    description: Draft commit message with llm-now
    command: "llm_commit_message | llm_markdown"
    output: terminal
```

Stage a change, focus lazygit's Files panel, and press `G`. Review the generated
message, return to lazygit, then press `c` and enter the message you actually want
to commit.

`G` is unused in lazygit's current default Files-panel keybindings, but press `?`
to check your installed version and personal configuration. Choose another unused
key if needed. Lazygit's
[custom-command guide](https://github.com/jesseduffield/lazygit/blob/master/docs/Custom_Command_Keybindings.md)
documents the `files` context and `output: terminal`; its
[configuration guide](https://github.com/jesseduffield/lazygit/blob/master/docs/Config.md#using-aliases-or-functions-in-shell-commands)
documents `shellFunctionsFile`.

## 2. Add a tone dial to the clipboard

**Audience:** Writers, managers, and support responders

**Platform:** macOS

Copy a paragraph, then pass a tone such as `friendly and concise`. The function
replaces the clipboard only after generation succeeds and also prints the rewrite
to stdout.

```bash
llm_tone_clipboard() {
  local tone="${*:-warm, direct, and concise}"
  local original rewrite

  if ! command -v pbpaste >/dev/null 2>&1 ||
     ! command -v pbcopy >/dev/null 2>&1; then
    printf 'llm_tone_clipboard: requires pbpaste and pbcopy\n' >&2
    return 1
  fi

  original=$(pbpaste)
  if [ -z "$original" ]; then
    printf 'llm_tone_clipboard: clipboard is empty\n' >&2
    return 1
  fi

  if ! rewrite=$(
    {
      printf 'Rewrite this to sound %s. Preserve every factual claim. Return only the rewrite.\n\n' "$tone"
      printf '%s\n' "$original"
    } | llm-now haiku
  ); then
    return 1
  fi

  printf '%s\n' "$rewrite" | pbcopy
  printf '%s\n' "$rewrite"
}

llm_tone_clipboard "friendly, confident, and concise" | llm_markdown
```

Try it on disposable text first: this intentionally overwrites the clipboard.
Use a local alias when the copied text is sensitive.

## 3. Turn any man page into a patient tutor

**Audience:** People learning shell tools

**Platform:** Unix-like systems with `man` and `col`

`batman tar` turns the installed `tar` manual into a short beginner lesson.
Section-qualified pages work too, for example `batman 5 passwd`.

```bash
batman() {
  if [ "$#" -eq 0 ]; then
    printf 'usage: batman [section] page\n' >&2
    return 2
  fi

  local page lesson requested
  requested="$*"

  # Capture the man page without opening a pager; stop if `man` fails.
  if ! page=$(MANPAGER=cat PAGER=cat man "$@"); then
    return 1
  fi

  if ! lesson=$(
    {
      printf '%s\n\n' \
        "Teach the '$requested' man page to a beginner.

Return Markdown only. Include:
- a concise mental model
- five useful flags or concepts
- two safe, practical examples
- one common mistake

Use only facts supported by the supplied man page.
If the page does not define five command-line flags, explain five useful concepts instead."
      printf '%s\n' "$page" | col -b
    } | llm-now haiku
  ); then
    return 1
  fi

  printf '%s\n' "$lesson" | llm_markdown
}

batman tar
```

The local manual grounds the lesson, but confirm any flag you plan to use against
the original man page.

## 4. Make a red test run explain itself

**Audience:** Developers debugging a failed test run

Pass the test command as separate arguments. Only its last 200 combined output
lines go to the model.

```bash
llm_test_doctor() {
  if [ "$#" -eq 0 ]; then
    printf 'usage: llm_test_doctor command [args...]\n' >&2
    return 2
  fi

  {
    printf '%s\n\n' \
      'Diagnose the likely root cause. Separate evidence from hypotheses and suggest the smallest next check.'
    "$@" 2>&1 | tail -n 200
  } | llm-now local
}

llm_test_doctor bun test | llm_markdown
```

This is a debugging lead, not a verdict. Check the complete test output if the
important error may have occurred earlier.

## 5. Leave future-you a pep talk in Stickies

**Audience:** Mac automation fans and productivity tinkerers

**Platform:** macOS

The model writes two sentences; AppleScript creates a new Stickies note containing
them. The generated text is passed as data, not interpolated into the script.

```bash
llm_sticky_pep_talk() {
  local task="${*:-finishing a difficult project}"
  local note

  if ! note=$(
    llm-now haiku --input \
      "Write a specific two-sentence pep talk for someone ${task}. Return plain text only."
  ); then
    return 1
  fi

  if ! osascript - "$note" <<'APPLESCRIPT'
on run argv
  tell application "Stickies"
    make new note with properties {body:item 1 of argv}
  end tell
end run
APPLESCRIPT
  then
    return 1
  fi

  printf '%s\n' "$note"
}

llm_sticky_pep_talk "shipping their first open-source release"
```

macOS may ask for automation permission the first time. This creates one note and
does not give `llm-now` control of Stickies.

## 6. Make your own notes quiz you

**Audience:** Students, self-learners, and documentation readers

The questions and answer key must be grounded only in the file you supply.

```bash
llm_study_quiz() {
  if [ "$#" -ne 1 ] || [ ! -r "$1" ]; then
    printf 'usage: llm_study_quiz readable-notes-file\n' >&2
    return 2
  fi

  {
    printf '%s\n\n' \
      'Create ten questions using only these notes. Mix recall and application. Put the answer key after a clear divider. Return Markdown.'
    cat < "$1"
  } | llm-now local
}

llm_study_quiz notes.md | llm_markdown
```

Check the answer key against your notes. A local model is a natural default for
private study material.

## 7. Ask a skeptical maintainer to preflight your diff

**Audience:** Developers preparing pull requests

This is deliberately narrower than a code review: it asks for the three risks most
likely to waste reviewer time.

```bash
llm_pr_preflight() {
  local diff

  if ! diff=$(git diff --cached); then
    return 1
  fi

  if [ -z "$diff" ]; then
    printf 'llm_pr_preflight: no staged changes\n' >&2
    return 1
  fi

  {
    printf '%s\n\n' \
      'Act as a skeptical maintainer. Name only the three highest-risk issues in this staged diff. Cite the relevant file or hunk and do not invent missing context. Return Markdown.'
    printf '%s\n' "$diff"
  } | llm-now local
}

llm_pr_preflight | llm_markdown
```

Large diffs may exceed a model's input limit. Narrow the staged diff when needed,
and never substitute this preflight for tests or human review.

## 8. Let the terminal talk you through a reset

**Audience:** People who enjoy lightweight personal automation

**Platform:** macOS

The model writes a short script and the built-in `say` command speaks it.

```bash
llm_focus_reset() {
  llm-now haiku --input \
    'Write a calm 60-second spoken reset before a difficult task. Use short sentences, no headings, and no medical claims.'
}

llm_focus_reset | say
```

Run `llm_focus_reset` without `say` first if you want to preview the script. This
is a focus prompt, not mental-health or medical advice.

## 9. Run a pre-mortem before you make the decision

**Audience:** Founders, managers, and anyone facing a consequential choice

Write the context, constraints, and proposed decision in a file. The function asks
for failure hypotheses and cheap tests without asking the model to decide for you.

```bash
llm_premortem() {
  if [ "$#" -ne 1 ] || [ ! -r "$1" ]; then
    printf 'usage: llm_premortem readable-decision-file\n' >&2
    return 2
  fi

  {
    printf '%s\n\n' \
      'Assume this decision failed six months from now. Write a pre-mortem with plausible causes, early warning signs, and one cheap test for each. Separate supplied facts from hypotheses. Do not decide for me. Return Markdown.'
    cat < "$1"
  } | llm-now haiku
}

llm_premortem decision.md | llm_markdown
```

Use the result to widen the discussion, not as legal, medical, financial, or other
professional advice.

## 10. Turn the commit trail into release notes

**Audience:** Maintainers and release engineers

Pass the previous release tag and, optionally, an ending revision. The function
uses commit subjects as raw material and returns a user-facing draft.

```bash
llm_release_notes() {
  if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    printf 'usage: llm_release_notes from-ref [to-ref]\n' >&2
    return 2
  fi

  local from_ref="$1"
  local to_ref="${2:-HEAD}"
  local commits

  if ! commits=$(git log --oneline --no-merges "${from_ref}..${to_ref}"); then
    return 1
  fi

  if [ -z "$commits" ]; then
    printf 'llm_release_notes: no commits in range\n' >&2
    return 1
  fi

  {
    printf '%s\n\n' \
      'Draft concise user-facing release notes from these commit subjects. Group changes by user impact, omit merge noise, and mark anything that needs confirmation. Return Markdown.'
    printf '%s\n' "$commits"
  } | llm-now haiku
}

llm_release_notes v1.2.0 | llm_markdown
llm_release_notes v1.2.0 > release-notes-draft.md
```

Commit subjects are incomplete evidence. Fact-check the draft against the actual
diff before publishing it.

## 11. Turn meeting notes into commitments

**Audience:** Team leads, project managers, and individual contributors

This asks for decisions and follow-through rather than another prose summary.

```bash
llm_meeting_actions() {
  if [ "$#" -ne 1 ] || [ ! -r "$1" ]; then
    printf 'usage: llm_meeting_actions readable-notes-file\n' >&2
    return 2
  fi

  {
    printf '%s\n\n' \
      'Extract decisions, action items, stated owners, stated dates, and unresolved questions. Mark anything missing instead of guessing. Return Markdown.'
    cat < "$1"
  } | llm-now local
}

llm_meeting_actions meeting-notes.txt | llm_markdown
```

Meeting notes may be confidential. Confirm every owner and date with the people
involved before treating the output as a commitment.

## 12. Let the pantry propose dinner

**Audience:** Home users trying a local model

Put one ingredient per line in `pantry.txt`. The model separates what you already
have from the smallest proposed shopping list.

```bash
llm_pantry_plan() {
  if [ "$#" -ne 1 ] || [ ! -r "$1" ]; then
    printf 'usage: llm_pantry_plan readable-pantry-file\n' >&2
    return 2
  fi

  {
    printf '%s\n\n' \
      'Suggest three simple dinners using mostly these ingredients. Separate what I have from the smallest shopping list. State assumptions and ask no follow-up questions. Return Markdown.'
    cat < "$1"
  } | llm-now local
}

llm_pantry_plan pantry.txt | llm_markdown
```

Check allergies, expiration dates, cooking temperatures, and ordinary food-safety
requirements yourself.

## 13. Turn 200 log lines into an incident handoff

**Audience:** Developers, operators, and support engineers

The function sends a bounded tail of one log file and asks for a handoff that
preserves uncertainty.

```bash
llm_incident_handoff() {
  if [ "$#" -ne 1 ] || [ ! -r "$1" ]; then
    printf 'usage: llm_incident_handoff readable-log-file\n' >&2
    return 2
  fi

  {
    printf '%s\n\n' \
      'Create an incident handoff: timeline, strongest hypotheses, evidence gaps, and next checks. Distinguish observations from inference and do not invent facts. Return Markdown.'
    tail -n 200 "$1"
  } | llm-now local
}

llm_incident_handoff app.log | llm_markdown
```

Logs commonly contain tokens, personal data, internal hostnames, and customer
content. Redact them first or keep the entire workflow local.

## 14. Let your Downloads folder propose a cleanup plan

**Audience:** Desktop organizers and local-model users

**Platform:** macOS and Linux

Only filenames are listed. The function asks for a review plan and never moves or
deletes anything.

```bash
llm_downloads_plan() {
  local directory="${1:-$HOME/Downloads}"

  if [ ! -d "$directory" ]; then
    printf 'llm_downloads_plan: not a directory: %s\n' "$directory" >&2
    return 2
  fi

  {
    printf '%s\n\n' \
      'Propose categories for reviewing these filenames. Flag likely duplicates by name only. Do not invent file contents and do not output shell commands. Return Markdown.'
    find "$directory" -maxdepth 1 -type f -print
  } | llm-now local
}

llm_downloads_plan | llm_markdown
llm_downloads_plan "$HOME/Desktop" | llm_markdown
```

Filenames can still reveal private information. Treat every proposed duplicate as
a guess and review files manually.

## 15. Do TODO archaeology instead of TODO counting

**Audience:** Maintainers inheriting or cleaning a codebase

`rg` inventories TODO and FIXME comments; the model clusters the comments into
possible project themes.

```bash
llm_todo_archaeology() {
  if ! command -v rg >/dev/null 2>&1; then
    printf 'llm_todo_archaeology: requires rg (ripgrep)\n' >&2
    return 1
  fi

  if [ "$#" -eq 0 ]; then
    set -- src tests
  fi

  local matches
  if ! matches=$(rg -n 'TODO|FIXME' "$@"); then
    printf 'llm_todo_archaeology: no matches found, or rg failed\n' >&2
    return 1
  fi

  {
    printf '%s\n\n' \
      'Group these TODOs by underlying theme. Identify likely clusters, risk signals, and the first three items worth investigating. Treat comments as possibly stale and return Markdown.'
    printf '%s\n' "$matches"
  } | llm-now local
}

llm_todo_archaeology src tests | llm_markdown
```

The model sees the matching lines, not the surrounding implementation. Use the
result as an investigation map, not a backlog rewrite.

## 16. Turn a messy note into an actionable checklist

**Audience:** Knowledge workers and Markdown users

The model preserves unknowns as questions instead of silently filling them in.

```bash
llm_checklist() {
  if [ "$#" -ne 1 ] || [ ! -r "$1" ]; then
    printf 'usage: llm_checklist readable-note-file\n' >&2
    return 2
  fi

  {
    printf '%s\n\n' \
      'Convert this rough note into a prioritized Markdown checklist. Preserve uncertainties as questions. Do not invent owners or dates. Return only Markdown.'
    cat < "$1"
  } | llm-now haiku
}

llm_checklist rough-note.txt | llm_markdown
llm_checklist rough-note.txt > checklist-draft.md
```

Preview before redirecting to a filename that may already exist; shell redirection
overwrites files without asking.

## 17. Give lazygit an “explain this commit” command

**Audience:** Lazygit and terminal-Git users

Start with a normal shell function. It accepts any commit-ish and defaults to
`HEAD`.

```bash
llm_explain_commit() {
  local commit="${1:-HEAD}"
  local details

  if ! details=$(git show --stat --patch "$commit"); then
    return 1
  fi

  {
    printf '%s\n\n' \
      'Explain this commit in plain English: intent, behavior change, and review risk. Distinguish evidence from inference and return Markdown.'
    printf '%s\n' "$details"
  } | llm-now haiku
}

llm_explain_commit HEAD | llm_markdown
```

To call the same function from lazygit:

1. Put `llm_markdown` and `llm_explain_commit` in a small shell file such as
   `~/.config/lazygit/llm-now-functions.sh`, and source that file from your normal
   Bash or Zsh startup file.
2. Add the following entries to lazygit's `config.yml`.

```yaml
os:
  shellFunctionsFile: ~/.config/lazygit/llm-now-functions.sh

customCommands:
  - key: E
    context: commits
    description: Explain selected commit with llm-now
    command: "llm_explain_commit {{.SelectedCommit.Hash | quote}} | llm_markdown"
    output: terminal
```

Focus a commit and press `E`. Lazygit's current documentation defines the
`commits` context, `output: terminal`, `shellFunctionsFile`, and the
`SelectedCommit` placeholder in its
[custom-command guide](https://github.com/jesseduffield/lazygit/blob/master/docs/Custom_Command_Keybindings.md)
and [configuration guide](https://github.com/jesseduffield/lazygit/blob/master/docs/Config.md#using-aliases-or-functions-in-shell-commands).

## 18. Ask the same prompt locally and in the cloud

**Audience:** People comparing privacy, speed, style, or cost

**Platform:** Bash or Zsh

Because this function asks for one line from each model, `paste` can display the
answers side by side.

```bash
llm_compare_models() {
  if [ "$#" -eq 0 ]; then
    printf 'usage: llm_compare_models prompt\n' >&2
    return 2
  fi

  local prompt="$*"

  printf '%-48s | %s\n' 'LOCAL' 'HAIKU'
  printf '%s\n' '------------------------------------------------ | ------------------------------------------------'
  paste -d '|' \
    <(llm-now local --input "Answer in exactly one line: $prompt") \
    <(llm-now haiku --input "Answer in exactly one line: $prompt")
}

llm_compare_models "Explain recursion in one sentence."
```

This is a qualitative demonstration, not a benchmark. A cloud provider receives
the prompt even though the local provider receives it too.

## 19. Give Emacs a model without an AI plugin

**Audience:** Emacs users and Unix-tool purists

Select a region, type `C-u M-|`, enter the following shell command, and press
Return:

```bash
{ printf '%s\n\n' 'Rewrite this region for clarity without changing its meaning. Return only replacement text.'; cat; } | llm-now haiku
```

`M-|` runs `shell-command-on-region`; the `C-u` prefix replaces the selected text
with stdout. Review the region first and remember that normal Emacs undo remains
available. Omit `C-u` to preview the result without replacing the region.

## 20. Have mission control narrate your laptop

**Audience:** Terminal tinkerers and anyone who enjoys a playful tool

**Platform:** Unix-like systems with `uptime`

This sends the one-line `uptime` status to a local model and asks it to preserve
the numbers.

```bash
llm_mission_control() {
  {
    printf '%s\n\n' \
      'Turn this computer status into a calm two-sentence NASA mission-control update. Preserve the numbers and do not claim to be monitoring the system.'
    uptime
  } | llm-now local
}

llm_mission_control | llm_markdown
```

This is narration, not system monitoring or diagnosis—which is exactly why it is
a satisfying final demo.

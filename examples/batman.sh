#!/usr/bin/env bash

_batman_markdown() {
  if command -v bat >/dev/null 2>&1; then
    bat --language markdown
  else
    cat
  fi
}

batman() {
  if [ "$#" -eq 0 ]; then
    printf 'usage: batman [section] page\n' >&2
    return 2
  fi

  local command_name page lesson requested tldr_output
  requested="$*"

  # The final argument is the page name in both `batman tar` and
  # section-qualified calls such as `batman 5 passwd`.
  for command_name do :; done

  # Capture the man page without opening a pager; stop if `man` fails.
  if ! page=$(MANPAGER=cat PAGER=cat man "$@"); then
    return 1
  fi

  tldr_output=
  if command -v tldr >/dev/null 2>&1; then
    if ! tldr_output=$(NO_COLOR=1 tldr "$command_name" 2>/dev/null); then
      tldr_output=
    fi
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

  {
    if [ -n "$tldr_output" ]; then
      printf '## TL;DR\n\n```text\n%s\n```\n\n---\n\n' "$tldr_output"
    fi
    printf '%s\n' "$lesson"
  } | _batman_markdown
}

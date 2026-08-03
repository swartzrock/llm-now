# A short, credential-free instructed-shortcut demo:
# hook → create with instructions → first run → saved reuse → install CTA.
#
# Render from the repository root with:
#   mkdir -p .tmp-llm-now-demo
#   bun build ./index.ts --compile --outfile .tmp-llm-now-demo/llm-now
#   bun build ./tests/fixtures/fake-cli.ts --compile --outfile .tmp-llm-now-demo/codex
#   LLM_NOW_DEMO_BIN="$PWD/.tmp-llm-now-demo/llm-now" \
#     LLM_NOW_DEMO_FAKE_CODEX="$PWD/.tmp-llm-now-demo/codex" \
#     vhs docs/demos/llm-now-demo.tape
#   rm -rf .tmp-llm-now-demo
#
# The explicit executable and fake Codex provider are both built from the
# current branch. The isolated demo never reads a real alias store or credential.

Output docs/demos/demo.gif

Require clear
Require dirname
Require mktemp
Require rm
Require bash

Set Shell bash
Set FontFamily "Hack Nerd Font Mono"
Set FontSize 22
Set Width 1200
Set Height 620
Set Padding 24
Set Theme { "name": "Lime Spark Graphite", "black": "#181A20", "red": "#FF6B7A", "green": "#B6FF2E", "yellow": "#FFD166", "blue": "#79A8FF", "magenta": "#C6A6FF", "cyan": "#5DE4C7", "white": "#E7EAF0", "brightBlack": "#626875", "brightRed": "#FF8A96", "brightGreen": "#CEFF73", "brightYellow": "#FFE08A", "brightBlue": "#9ABEFF", "brightMagenta": "#D7BDFF", "brightCyan": "#85EBD8", "brightWhite": "#FFFFFF", "background": "#23262F", "foreground": "#B6FF2E", "selection": "#483565", "cursor": "#B6FF2E" }
# Set Theme "Catppuccin Macchiato"
Set TypingSpeed 24 ms
Set Framerate 30
Set CursorBlink false
Set Margin 32
Set MarginFill "#111122"
# Set MarginFill "#483565"

Set BorderRadius 14
Set WindowBar Colorful
Set WindowBarSize 40

# Prepare the isolated credential-free fixture without showing setup commands.
Hide
Type `unset PROMPT_COMMAND; PS1='$ '; clear`
Enter
Type `test -x "$LLM_NOW_DEMO_BIN" || exit 1; test -x "$LLM_NOW_DEMO_FAKE_CODEX" || exit 1`
Enter
Type `DEMO_ORIG_DIR="$PWD"; DEMO_DIR="$(mktemp -d)"; cd "$DEMO_DIR"`
Enter
Type `export XDG_CONFIG_HOME="$DEMO_DIR/config"; export PATH="$(dirname "$LLM_NOW_DEMO_FAKE_CODEX"):$PATH"; export SHELL="$DEMO_DIR/missing-login-shell"`
Enter
Type `llm-now() { "$LLM_NOW_DEMO_BIN" "$@"; }`
Enter

# Create a shortcut from a maintained, credential-free available provider.
Type `clear; printf '\033[1;35m%s\033[0m\n' "Create a reusable LLM shortcut—and run it immediately."`
Enter
Show
Sleep 1500 ms

Type `llm-now`
Enter
Wait+Screen@10 s /What would you like to do\?/
Wait+Screen@10 s /Create a new shortcut…/
Wait+Screen@10 s /Run once with a provider and model…/
Wait+Screen@10 s /Manage connections…/
Type "Create"
Sleep 500 ms
Enter
Wait+Screen@10 s /How should this shortcut connect\?/
Wait+Screen@10 s /Use an available provider…/
Wait+Screen@10 s /Add a provider with an API key…/
Type "Use"
Sleep 500 ms
Enter
Wait+Screen@30 s /Choose a provider/
Type "Codex"
Sleep 500 ms
Enter
Wait+Screen@10 s /Choose a model/
Type "fake-model"
Sleep 500 ms
Enter
Wait+Screen@10 s /Name this shortcut/
Type "explain"
Enter
Wait+Screen@10 s /Optional instructions for this shortcut/
Type `Use "quoted" runtime smoke \ transport.`
Enter
Wait+Screen@10 s /Saved shortcut explain → Codex CLI · fake-model/
Sleep 1500 ms
Type "smoke"
Enter
Wait+Screen@30 s /fake:instruction-present/
Sleep 3 s

# Reuse the configured shortcut through the exact configured root action.
Type `llm-now`
Enter
Wait+Screen@10 s /Run with a saved shortcut…/
Wait+Screen@10 s /Create a new shortcut…/
Wait+Screen@10 s /Run once with another provider and model…/
Wait+Screen@10 s /Manage connections…/
Type "Run with"
Sleep 500 ms
Enter
Wait+Screen@10 s /Choose a saved shortcut/
Type "explain"
Enter
Sleep 1500 ms
Type "smoke"
Enter
Wait+Screen@30 s /fake:instruction-present/
Sleep 3 s

# Finish on a low-friction call to action. Do not execute the install command.
Hide
Type `clear; printf '\033[1;35m%s\033[0m\n' "One shortcut. Any working directory."`
Enter
Show
Sleep 1 s
Type `brew install swartzrock/tap/llm-now`
Sleep 8 s

# Remove the temporary fixture without changing the final captured frame.
Hide
Ctrl+C
Type `cd "$DEMO_ORIG_DIR"; rm -rf "$DEMO_DIR"`
Enter

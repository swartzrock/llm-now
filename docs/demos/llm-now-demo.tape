# A short, conversion-focused demo:
# hook → provider discovery → local utility → cloud switch → install CTA.
#
# Render from the repository root with:
#   vhs docs/llm-now-viral-demo.tape
#
# Prerequisites:
# - Save a fast, warmed-up local model as the alias `local`.
# - Save an Anthropic Haiku model as the alias `haiku`.

Output docs/llm-now-viral-demo.gif

Require llm-now
Require gum
Require cat
Require clear
Require mktemp
Require rm
Require zsh

Set Shell zsh
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

# Prepare a deterministic prompt without showing setup commands.
Hide
Type `unfunction precmd 2>/dev/null; precmd_functions=(); RPROMPT=''; PS1='$ '; clear`
Enter
Type `DEMO_ORIG_DIR="$PWD"; DEMO_DIR="$(mktemp -d)"; cd "$DEMO_DIR"`
Enter
Type `printf '%s\n' 'Explain this error in one sentence and give the most likely fix:' 'ECONNREFUSED 127.0.0.1:5432' > postgres-error.txt`
Enter

# Hook and discovery: keep the promise visible while the command is typed.
Type `clear; gum style --foreground "#C6A6FF" --bold "One command for every LLM already on your machine."`
Enter
Show
Sleep 1500 ms

Type `llm-now`
Enter
Wait+Screen@10 s /What would you like to set up\?/
Type "Discover"
Sleep 500 ms
Enter
Wait+Screen@30 s /Choose an available provider/
Sleep 2 s
Escape
Wait+Line@10 s /^\$$/
Sleep 800 ms

# Solve a recognizable problem using a local model.
Hide
Type `clear; gum style --foreground "#C6A6FF" --bold "Postgres won't connect? Get unstuck without leaving your terminal."`
Enter
Show
Sleep 1 s

Type `cat postgres-error.txt`
Enter
Sleep 1 s
Type `llm-now local < postgres-error.txt`
Enter
Wait+Line@30 s /^\$$/
Sleep 4 s

# Switch providers without changing the surrounding workflow.
Hide
Type `clear; gum style --foreground "#C6A6FF" --bold "Local or cloud? It's the same command."`
Enter
Show
Sleep 1 s

Type `llm-now haiku < postgres-error.txt`
Enter
Wait+Line@30 s /^\$$/
Sleep 4 s

# Finish on a low-friction call to action. Do not execute the install command.
Hide
Type `clear; gum style --foreground "#C6A6FF" --bold "Try it with the models already on your machine."`
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

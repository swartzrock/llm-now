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
Set FontSize 26
Set Width 1200
Set Height 620
Set Padding 24
Set Theme "Catppuccin Macchiato"
Set TypingSpeed 24 ms
Set Framerate 30
Set CursorBlink false
Set Margin 32
Set MarginFill "#111122"
Set BorderRadius 14
Set WindowBar Colorful
Set WindowBarSize 52

# Prepare a deterministic prompt without showing setup commands.
Hide
Type `unfunction precmd 2>/dev/null; precmd_functions=(); RPROMPT=''; PS1='$ '; clear`
Enter
Type `DEMO_ORIG_DIR="$PWD"; DEMO_DIR="$(mktemp -d)"; cd "$DEMO_DIR"`
Enter
Type `printf '%s\n' 'Explain this error in one sentence and give the most likely fix:' 'ECONNREFUSED 127.0.0.1:5432' > postgres-error.txt`
Enter

# Hook and discovery: keep the promise visible while the command is typed.
Type `clear; gum style --foreground "#A6E3A1" --bold "One command for every LLM already on your machine."`
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
Type `clear; gum style --foreground "#A6E3A1" --bold "Private problem. Local model. Immediate answer."`
Enter
Show
Sleep 1 s

Type `cat postgres-error.txt`
Enter
Sleep 1 s
Type `llm-now local < postgres-error.txt`
Enter
Wait+Line@30 s /^\$$/
Sleep 2 s

# Switch providers without changing the surrounding workflow.
Hide
Type `clear; gum style --foreground "#A6E3A1" --bold "Local or cloud. Same command."`
Enter
Show
Sleep 1 s

Type `llm-now haiku < postgres-error.txt`
Enter
Wait+Line@30 s /^\$$/
Sleep 2 s

# Finish on a low-friction call to action. Do not execute the install command.
Hide
Type `clear; gum style --foreground "#A6E3A1" --bold "Try it with the models already on your machine."`
Enter
Show
Sleep 1 s
Type `brew install swartzrock/tap/llm-now`
Sleep 4 s

# Remove the temporary fixture without changing the final captured frame.
Hide
Ctrl+C
Type `cd "$DEMO_ORIG_DIR"; rm -rf "$DEMO_DIR"`
Enter

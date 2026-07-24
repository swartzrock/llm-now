
# VHS documentation
#
# Output:
#   Output <path>.gif               Create a GIF output at the given <path>
#   Output <path>.mp4               Create an MP4 output at the given <path>
#   Output <path>.webm              Create a WebM output at the given <path>
#
# Require:
#   Require <string>                Ensure a program is on the $PATH to proceed
#
# Settings:
#   Set FontSize <number>           Set the font size of the terminal
#   Set FontFamily <string>         Set the font family of the terminal
#   Set Height <number>             Set the height of the terminal
#   Set Width <number>              Set the width of the terminal
#   Set LetterSpacing <float>       Set the font letter spacing (tracking)
#   Set LineHeight <float>          Set the font line height
#   Set LoopOffset <float>%         Set the starting frame offset for the GIF loop
#   Set Theme <json|string>         Set the theme of the terminal
#   Set Padding <number>            Set the padding of the terminal
#   Set Framerate <number>          Set the framerate of the recording
#   Set PlaybackSpeed <float>       Set the playback speed of the recording
#   Set MarginFill <file|#000000>   Set the file or color the margin will be filled with.
#   Set Margin <number>             Set the size of the margin. Has no effect if MarginFill isn't set.
#   Set BorderRadius <number>       Set terminal border radius, in pixels.
#   Set WindowBar <string>          Set window bar type. (one of: Rings, RingsRight, Colorful, ColorfulRight)
#   Set WindowBarSize <number>      Set window bar size, in pixels. Default is 40.
#   Set TypingSpeed <time>          Set the typing speed of the terminal. Default is 50ms.
#
# Sleep:
#   Sleep <time>                    Sleep for a set amount of <time> in seconds
#
# Type:
#   Type[@<time>] "<characters>"    Type <characters> into the terminal with a
#                                   <time> delay between each character
#
# Keys:
#   Escape[@<time>] [number]        Press the Escape key
#   Backspace[@<time>] [number]     Press the Backspace key
#   Delete[@<time>] [number]        Press the Delete key
#   Insert[@<time>] [number]        Press the Insert key
#   Down[@<time>] [number]          Press the Down key
#   Enter[@<time>] [number]         Press the Enter key
#   Space[@<time>] [number]         Press the Space key
#   Tab[@<time>] [number]           Press the Tab key
#   Left[@<time>] [number]          Press the Left Arrow key
#   Right[@<time>] [number]         Press the Right Arrow key
#   Up[@<time>] [number]            Press the Up Arrow key
#   Down[@<time>] [number]          Press the Down Arrow key
#   PageUp[@<time>] [number]        Press the Page Up key
#   PageDown[@<time>] [number]      Press the Page Down key
#   Ctrl+<key>                      Press the Control key + <key> (e.g. Ctrl+C)
#
# Display:
#   Hide                            Hide the subsequent commands from the output
#   Show                            Show the subsequent commands in the output
#   ScrollUp[@<time>] [number]      Scroll terminal viewport up by rows
#   ScrollDown[@<time>] [number]    Scroll terminal viewport down by rows


# Render from the repository root with: vhs docs/llm-now-demo.tape
# Prerequisite: save a fast, warmed-up provider/model as the alias `local`.

# Output docs/llm-now-demo3.gif
Require llm-now
Require gum

Set Shell zsh
Set FontFamily "Hack Nerd Font Mono"

Set FontSize 18
Set Width 1080
Set Height 768
Set Padding 20
#Set Theme "Dracula"
Set Theme "Catppuccin Macchiato"
Set TypingSpeed 40 ms

Set Margin 40
Set MarginFill "#111122"
Set BorderRadius 14
Set WindowBar Colorful
Set WindowBarSize 60


Hide
Type `unfunction precmd 2>/dev/null; precmd_functions=(); RPROMPT=''; PS1='$ '; clear`
Enter
Sleep 500 ms
Show

# Start with an introduction
Hide
Type `clear; gum style --foreground "#A6E3A1" --bold "A tiny CLI for the local models you already run."`
Enter
Show
Sleep 2s

Sleep 1 s
Type `llm-now local --input "In one sentence, explain: ECONNREFUSED 127.0.0.1:5432"`
Sleep 500 ms
Enter
Wait+Line@30 s /^\$$/
Sleep 4 s

# Demonstrate finding local providers (ollama), cli's (codex), and cloud providers (api keys)
Hide
Type `clear; gum style --foreground "#A6E3A1" --bold "Discover local, cli, and cloud-based llm providers"`
Enter
Show
Sleep 2s

# Add haiku as an alias using an api key in your environment
Hide
Type `clear; gum style --foreground "#A6E3A1" --bold "Add Anthropic's haiku model using your existing api key"`
Enter
Show
Sleep 2s

Type `{ printf 'Write a git commit command with a message for this diff, no comments\n\n'; git diff README.md } | llm-now haiku`
Sleep 500 ms
Enter
Wait+Line@30 s /^\$$/
Sleep 4 s

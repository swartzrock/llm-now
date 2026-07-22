# Render from the repository root with: vhs docs/llm-now-demo.tape
# Prerequisite: save a fast, warmed-up provider/model as the alias `local`.

Output docs/llm-now-demo.gif
Require llm-now

Set Shell zsh
Set FontFamily "Menlo"
Set FontSize 28
Set Width 1200
Set Height 500
Set Padding 32
Set Margin 24
Set MarginFill "#181825"
Set BorderRadius 12
Set WindowBar Rings
Set Theme "Catppuccin Mocha"
Set TypingSpeed 22 ms
Set Framerate 30
Set CursorBlink false
Set LoopOffset 70%

Hide
Type `unfunction precmd 2>/dev/null; precmd_functions=(); RPROMPT=''; PS1='$ '; clear`
Enter
Sleep 500 ms
Show

Sleep 1 s
Type `llm-now local --input "In one sentence, explain: ECONNREFUSED 127.0.0.1:5432"`
Sleep 500 ms
Enter
Wait+Line@30 s /\$ $/
Sleep 4 s

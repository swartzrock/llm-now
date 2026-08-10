---
"llm-now": minor
---

Add composable native voice routing and speech. `--voice-route` maps one
dictated transcript to a saved alias and question on every supported platform,
while macOS-only `--speak` adds concise speech guidance and speaks the validated
answer instead of writing it to stdout. They combine for a two-action global
Shortcut and `--speak` also works with ordinary alias or provider/model
selection. Optional per-alias voice, rate, and validated baseline-pitch
settings remain available without Python, uv, a repository checkout, or
clipboard mutation. Retain the locked uv-managed Python example as an
independent combined routing and speech oracle for contributors.

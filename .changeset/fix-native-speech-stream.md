---
"llm-now": patch
---

Fix macOS speech in native executables by reading child-process streams without relying on `SharedArrayBuffer`.

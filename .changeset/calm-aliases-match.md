---
"llm-now": major
---

Make aliases ASCII case-insensitive while keeping spelling exact. Saved aliases
are canonical lowercase. Same-target case-only entries in legacy alias files
collapse in memory and are persisted canonically on the next successful save;
different-target conflicts fail closed with an actionable repair diagnostic.

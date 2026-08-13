---
title: Voice Route Alias Selection Output - Plan
type: feat
date: 2026-08-11
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Voice Route Alias Selection Output - Plan

**Target repository:** `llm-now2`. All paths are relative to this repository.

## Goal Capsule

- **Objective:** When `--voice-route` accepts a transcript, emit the selected canonical alias as one stable, human-readable stderr line before provider generation starts.
- **Authority:** `llm-now` continues to own voice routing and provider execution. This plan changes only how an accepted routing decision is exposed by the CLI process.
- **Execution profile:** One focused pull request in `llm-now2` covering behavior, tests, active documentation, and a patch Changeset.
- **Stop conditions:** Stop if implementation changes routing semantics, adds a second output mode, writes alias metadata to response stdout, emits transcript or prompt content, or introduces knowledge of any consuming application.
- **Completion signal:** A successful route emits exactly `Selecting alias '<canonical-alias>'` on stderr before generation; existing response and failure contracts remain intact.

---

## Product Contract

### Summary

Expose the result of existing voice routing through one fixed stderr line. The line is useful to a person watching the command and simple for another local process to recognize, while stdout remains dedicated to the generated response.

### Problem Frame

`llm-now` resolves the canonical alias before generation, but that decision is not currently visible outside the routing implementation. A caller can observe the final response and diagnostics but cannot reliably identify the accepted alias without duplicating routing logic or parsing unrelated output.

### Requirements

- R1. `llm-now` must remain the only owner of wake-word parsing, configured and fuzzy matching, canonical alias selection, question extraction, and provider execution.
- R2. After `--voice-route` accepts a route, the CLI must attempt to write exactly `Selecting alias '<canonical-alias>'\n` to stderr and must not begin provider generation until that write completes successfully.
- R3. Successful response stdout must remain byte-for-byte response-only, with no alias prefix, framing, or other metadata.
- R4. The emitted value must be the normalized canonical alias key returned by routing, including when selection originated from a configured spoken name or fuzzy match.
- R5. Routing rejection must emit no selection line. If generation fails after an accepted route, the already-emitted selection line remains valid as a routing decision and existing failure behavior remains authoritative.
- R6. The canonical alias must be the selection line's only variable data. The line must not contain dictated text, the extracted question, prompt instructions, provider details, credentials, or generated output.
- R7. The behavior must apply to every accepted `--voice-route` invocation, including `--voice-route --speak`, without adding a flag or changing standalone and non-routed commands.

### Key Flows

- F1. **Accepted route:** `llm-now` resolves the transcript to a canonical alias, completes the stderr selection write, then starts the existing provider generation path and returns the response through its existing output path. Covers R1-R4, R6-R7.
- F2. **Rejected route:** Routing fails before a canonical alias is selected, so no selection line or provider call occurs and the existing bounded diagnostic and exit behavior remain unchanged. Covers R1, R5-R6.
- F3. **Failure after selection:** The canonical alias line is emitted, generation starts, and a later timeout, provider error, cancellation, speech failure, or output failure follows its current error path without reinterpreting the earlier routing decision. Covers R2-R3, R5-R7.

### Acceptance Examples

- AE1. `hey amelie, explain this` resolving to canonical alias `amelie` writes exactly `Selecting alias 'amelie'\n` to stderr before a gated fake provider is allowed to begin.
- AE2. A configured spoken name or fuzzy input that resolves to `amelie` emits `amelie`, not the spoken or misspelled text.
- AE3. The generated response on stdout is unchanged from the same successful routed request before this feature.
- AE4. Blank input, a missing question, no match, ambiguity, no configured aliases, or an invalid routing snapshot emits no selection line and makes no provider call.
- AE5. A provider failure after selection leaves the selection line as the first stderr record and preserves the existing sanitized failure diagnostic and nonzero exit status.
- AE6. A selection-line write failure prevents provider generation and follows the existing output-error path rather than silently losing the routing signal.

### Scope Boundaries

#### Included

- One fixed selection line on stderr for accepted voice routes.
- An ordering guarantee that the write completes before provider generation.
- Source and compiled-runtime tests, active CLI documentation, and a patch Changeset.

#### Outside This Change

- JSON, JSON Lines, versioned events, a new output flag, or response framing.
- Importing or exposing the routing implementation as a library.
- Consumer-specific parsing, state, IPC, UI, or speech behavior.
- Changes to wake words, fuzzy thresholds, configured spoken names, alias grammar, providers, prompts, cancellation, or generated responses.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Keep the CLI process as the public boundary.** `llm-now` exposes its routing decision without knowing which human or process observes it. (session-settled: user-directed — chosen over coupling the CLI to a consuming app or embedding the CLI as a library: routing and execution remain owned by `llm-now`.) Governs R1, R6.
- KTD2. **Use stderr progress text instead of a structured output mode.** R2 owns the exact selection-line bytes, and R3 preserves response-only stdout. A structured mode is deferred until the contract needs more than this single value. (session-settled: user-directed — chosen over an opt-in JSON or JSON Lines mode: one canonical alias value does not justify a second output protocol.) Governs R2-R7.
- KTD4. **Await the stderr write before generation.** Use the existing callback-capable output seam so an ordering test can prove the provider is not invoked until the newline-terminated selection write completes. Governs R2, AE1, AE6.

### Output Contract

| Stream | Accepted route | Rejected route | Stability |
|---|---|---|---|
| `stderr` | One exact `Selecting alias '<canonical-alias>'\n` line before generation, followed by existing diagnostics only if later work fails | No selection line; existing rejection diagnostic | The selection line's capitalization, spaces, quotes, alias normalization, and newline are public contract |
| `stdout` | Existing generated response bytes | Existing behavior | Unchanged |

Canonical aliases already use a lowercase ASCII key grammar without apostrophes, so the quoted field is unambiguous. A consumer may recognize only the complete anchored line; other stderr diagnostics are not part of this selection contract.

### Sequencing and Delivery

1. Implement the write at the existing post-route, pre-generation seam and pin its exact bytes and ordering in application and compiled-runtime tests.
2. Update active CLI documentation and release metadata to define the stable line and unchanged stdout contract.

### Risks and Dependencies

- **Accidental stdout break:** Writing the line to stdout would corrupt the response contract. Exact stream assertions prevent this.
- **Timing illusion:** A line visible only after generation would not expose early selection. A gated fake provider must prove write-before-generation ordering.
- **Diagnostic ambiguity:** Other stderr lines may exist on failure. The fixed prefix, alias grammar, and complete-line match keep selection recognition narrow.
- **Future protocol growth:** Human-readable text is suitable for this one-field event but not an extensible event stream. If more fields or lifecycle events are required later, add an opt-in structured mode without changing this contract casually.

### Sources and Research

- `src/app.ts` already holds the canonical route result before provider generation and provides callback-based stdout writing plus a sanitized stderr writer.
- `src/aliases.ts` defines the canonical alias grammar and lowercase normalization.
- `tests/app.test.ts` contains the routed success, rejection, redaction, speech, and provider-failure boundaries needed to pin the new line.
- `tests/runtime-compile-smoke.ts` proves routed behavior through the compiled executable rather than source-only execution.
- External research is not load-bearing because the repository's implementation and tests define the complete boundary changed by this plan.

---

## Implementation Units

### U2. Emit the selected alias before generation

- **Goal:** Add the exact stderr selection line at the existing accepted-route seam without changing routing or response output.
- **Requirements:** R1-R7; AE1-AE6.
- **Dependencies:** None.
- **Files:** `src/app.ts`, `tests/app.test.ts`, `tests/runtime-compile-smoke.ts`.
- **Approach:**
  1. Add a narrow writer for the fixed selection line using the canonical `route.alias` already returned by voice routing.
  2. Await the write callback immediately after route acceptance and before invoking the provider path.
  3. Leave routing rejection, response stdout, diagnostics, speech, cancellation, and provider execution on their existing paths.
- **Patterns to follow:** Existing `diagnosticWriter`, `writeResponse`, immutable route selection, exact-output assertions, and fake runtime gates.
- **Test scenarios:**
  - A gated fake runtime cannot observe provider invocation until the exact selection line write completes.
  - Exact, configured-spoken-name, and fuzzy matches emit their canonical alias.
  - Routed non-speech and speech paths both emit one selection line after acceptance.
  - Routed success preserves exact response stdout.
  - Every existing route-rejection case emits no selection line and makes no provider call.
  - Provider failure after selection retains the selection line and existing sanitized diagnostic behavior.
  - A stderr write error prevents provider invocation and returns through the existing output-error handling.
  - Compiled-runtime smoke observes the same exact stderr line and unchanged stdout bytes.
- **Verification:** Focused application tests prove bytes, stream, and ordering; compiled-runtime smoke proves the installed executable boundary.

### U3. Document and release the output contract

- **Goal:** Make the line's exact syntax, timing, stream, and compatibility implications explicit to CLI users and process consumers.
- **Requirements:** R2-R7; AE1-AE5.
- **Dependencies:** U2.
- **Files:** `README.md`, `docs/cli-reference.md`, `docs/manual-testing.md`, `.changeset/voice-route-alias-selection-output.md`.
- **Approach:**
  1. Document stderr selection output separately from response stdout and existing failure diagnostics.
  2. State that the alias is canonical, the write completes before generation, rejected routes emit no line, and downstream failure does not invalidate a prior selection.
  3. Add a patch Changeset and one packaged manual case that holds generation long enough to observe the selection line first.
- **Patterns to follow:** Existing CLI output tables, voice-route examples, manual release checks, and Changeset format.
- **Test scenarios:** Test expectation: none — this unit documents and releases behavior already proved by U2.
- **Verification:** Active docs agree with tests and the Changeset/release validation passes.

---

## Verification Contract

| Gate | Applies to | Done signal |
|---|---|---|
| `bun test tests/app.test.ts` | U2 | Exact stderr bytes, write ordering, rejection, failure, speech, and response compatibility scenarios pass. |
| `bun run check` | U2-U3 | Full tests, typecheck, and compiled-runtime smoke pass. |
| Release validation workflow | U3 | Documentation and Changeset policy pass for the packaged CLI. |
| Packaged manual ordering check | U3 | The alias line is visible while fake generation remains blocked, and the final response still uses its existing output path. |

Implementation must not start a consuming app or development server as part of these gates.

---

## Definition of Done

- Every accepted `--voice-route` invocation attempts exactly one canonical alias selection-line write; provider generation starts only after the write completes successfully.
- Route rejection emits no selection line, and a selection-line write failure starts no provider work.
- Response stdout remains byte-for-byte compatible; routing, diagnostics, redaction, cancellation, speech, and provider semantics otherwise remain unchanged.
- No dictated text, question, prompt, response, credential, or provider detail is added to the selection line.
- Application and compiled-runtime tests cover exact, configured, fuzzy, rejected, speech, downstream-failure, and write-failure cases.
- Active documentation and a patch Changeset describe the stable line and its compatibility boundary.
- All Verification Contract gates pass, and the pull request contains only scope-traceable `llm-now2` changes.

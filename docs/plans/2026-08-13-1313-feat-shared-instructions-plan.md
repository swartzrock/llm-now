---
title: Shared Alias Instructions - Plan
type: feat
date: 2026-08-13
topic: shared-instructions
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
origin: docs/ideation/2026-08-13-general-instruction-ideation.html
---

# Shared Alias Instructions - Plan

## Goal Capsule

- **Objective:** Add an optional root `shared_instructions` configuration value that prefixes every saved alias's local instructions, while retaining `--instruction` as a one-request replacement for that shared layer.
- **Authority:** The Product Contract owns observable configuration, composition, selection-scope, privacy, and compatibility behavior. The Planning Contract owns schema integration, preservation through canonical rewrites, alias detection, composition at the generation seam, tests, documentation, and release mechanics. Repository instructions and tests remain binding where this plan is silent.
- **Execution profile:** One implementation phase and one pull request based on current `origin/main`. The pull request includes the originating ideation artifact, this plan, schema and application changes, focused tests, active documentation, and a minor changeset.
- **Stop conditions:** Stop if resolved selections cannot reliably distinguish saved aliases from explicit or fresh targets, if preserving the root value requires changing the alias file authority model, if the runtime requires separate instruction layers, or if composed values cannot use the existing redaction path.
- **Tail ownership:** LFG implements and verifies the plan, simplifies and reviews the diff, applies eligible review fixes, opens the pull request, and watches CI to a decided state.

---

## Product Contract

### Summary

`config.toml` gains an optional root `shared_instructions` string for guidance shared by saved aliases. Alias requests use a request-scoped `--instruction` value when present or the configured shared value otherwise, then append the alias's local `instructions` value.

Explicit provider/model and fresh run-once requests never inherit the configured shared value. Their explicit `--instruction` value remains a complete one-shot instruction.

### Problem Frame

Aliases can carry reusable instructions, but users currently have to repeat common policy in every alias. Updating a common preamble means editing each alias independently and keeping those copies synchronized.

The shipped `--instruction` option currently replaces an alias's complete saved instruction. Adding a shared layer requires a narrower override contract so temporary guidance can replace the common policy without discarding alias specialization.

### Requirements

#### Configuration contract

- R1. The version 1 root schema accepts one optional `shared_instructions` string and continues to reject unknown root fields.
- R2. A present shared value uses the existing instruction character rules: it must be nonblank, may contain ordinary LF line breaks and Unicode text, rejects unsupported controls, and preserves the exact accepted string.
- R3. Canonical serialization writes `shared_instructions` immediately after `version`, preserves omission, and produces stable parse-serialize output.
- R4. Creating or updating an unrelated alias preserves the current shared value exactly, while legacy migration and empty configuration creation leave it absent.
- R5. A schema or parse failure remains fail-closed for every command that currently loads unified configuration, including explicit and fresh requests, before provider access or generation and without disclosing rejected instruction text; config-independent standalone modes remain unchanged.

#### Request composition

- R6. For a resolved saved alias, the general layer is the parsed `--instruction` value when present or `shared_instructions` otherwise, followed by the alias-local `instructions` value when present.
- R7. Two present layers are joined with the exact inserted delimiter `"\n\n"`; one present layer is forwarded unchanged; no present layer produces `undefined`; accepted layer text is not trimmed or normalized.
- R8. Alias behavior is consistent for positional aliases, `--alias`, selectorless interactive alias selection, launcher shortcuts, voice routes, and a newly saved shortcut's first request using the invocation's loaded shared value.
- R9. Explicit provider/model and fresh run-once selections never inherit configured shared instructions; with `--instruction` they forward only that command-line value, and without it they forward no instruction.
- R10. `--instruction` remains request-scoped, preserves its existing syntax and validation, does not become a prompt source, and never mutates `config.toml` or resolved alias state.

#### Runtime, documentation, and release contract

- R11. The application composes the final value before the runtime boundary, and BYOK Runtime continues to receive one opaque optional instruction with no provider-adapter changes.
- R12. Runtime failures redact each active source layer and the final composed instruction in raw, serialized, and transport-escaped forms.
- R13. Help, configuration guidance, CLI reference, README, and manual testing describe `shared_instructions`, alias-only inheritance, layer order, the exact request override scope, plaintext risk, and file-rewrite preservation.
- R14. The user-visible behavior ships with a minor changeset and passes the repository's focused, full, static, compiled, and release-metadata checks.

### Key Decisions

- **Use the root name `shared_instructions`.** (session-settled: user-directed — chosen over `instruction` and `global_instruction` because the plural name matches alias `instructions` and states that the value is shared across aliases.) Governs R1-R4 and R13.
- **Limit configured inheritance to saved aliases.** (session-settled: user-approved — chosen over applying the configured value to every provider/model request because explicit and fresh selection remain neutral escape hatches.) Governs R6-R9 and R11.
- **Let `--instruction` replace only the shared layer for alias requests.** (session-settled: user-directed — chosen over removing the option or replacing the complete composed alias instruction because temporary guidance must not discard alias specialization.) Governs R6-R10 and R13.
- **Place general guidance before alias specialization.** (session-settled: user-approved — chosen over replacement semantics or labeled provider-specific layers because one deterministic provider-neutral string preserves the current runtime boundary.) Governs R6-R8, R11, and R12.

### Acceptance Examples

- AE1. **Covers R1-R3, R6, and R7.** Given root `shared_instructions = "shared"` and alias-local `instructions = "local"`, an alias request without `--instruction` sends exactly `shared\n\nlocal`.
- AE2. **Covers R6, R7, and R10.** Given the same config, an alias request with `--instruction "temporary"` sends exactly `temporary\n\nlocal`, does not send `shared`, and leaves the file unchanged.
- AE3. **Covers R6 and R7.** Shared-only and alias-only requests forward their accepted layer unchanged, while an alias with neither layer forwards `undefined` with no separator.
- AE4. **Covers R8.** Positional alias, `--alias`, selector-selected alias, launcher shortcut, voice route, and a newly saved shortcut's first request all apply the same two-layer contract.
- AE5. **Covers R9 and R10.** With shared configuration present, an explicit or fresh run-once request sends no instruction when the option is absent and sends only the exact command-line value when it is present.
- AE6. **Covers R3-R5.** An unrelated alias create or overwrite retains the shared value through canonical rewrite, while invalid shared text fails before any prompt, provider, generation, or mutation dependency is used and is absent from diagnostics.
- AE7. **Covers R11 and R12.** A runtime failure involving a composed instruction exposes neither source layer nor raw, serialized, or transport-escaped forms of either source or the composed value.
- AE8. **Covers R13 and R14.** Public documentation and the changeset use the same precedence table as the tested behavior and no longer claim that `--instruction` replaces alias-local instructions.

### Scope Boundaries

- No configuration editor, launcher control, or command that persists `shared_instructions`; manual TOML editing is the supported management path.
- No `--no-instruction`, instruction-file option, semantic conflict detector, precedence labels, or provider-specific composition.
- No change to alias-local capture, credential screening, workspaces, voice profiles, provider adapters, or the runtime gateway contract.
- Plaintext instructions remain unsuitable for secrets. Successful model output is not filtered.
- Existing comments and custom TOML formatting may still be removed by canonical rewrites; semantic field preservation is the guarantee.

---

## Planning Contract

### Assumptions

- Retaining `version = 1` is the smallest compatible representation for the current release. Older binaries will reject the newly recognized root field because their version 1 schema is closed; this is fail-closed rather than silent misinterpretation.
- “Exactly one blank line” means inserting the exact delimiter `"\n\n"` between two accepted layers. The application does not remove newlines already present at either boundary.
- Manually edited shared instructions follow the same schema-level credential posture as manually edited alias instructions. Interactive vault screening remains limited to shortcut-save flows.
- A command uses one loaded configuration snapshot. If the launcher saves a new shortcut before its first request, that request uses the snapshot's shared value and the newly saved record's local value; concurrent shared edits take effect on the next invocation.

### Key Technical Decisions

- KTD1. **Extend the strict sparse config document.** Add `sharedInstructions?: string` to `ConfigDocumentV1`, admit `shared_instructions` in `ROOT_FIELDS`, parse it with the instruction validator, and emit it after `version`. Parameterize field-aware diagnostics only as needed to keep rejected values out of errors. This implements R1-R3 and R5 without a parallel config model.
- KTD2. **Conserve document policy during alias mutation.** Copy `document.sharedInstructions` in `applyAliasMutation` before canonical serialization. Leave legacy projections and empty migration documents without the field. This implements R3-R4 at the full-document rewrite seam rather than in individual save callers.
- KTD3. **Use resolved alias identity as the scope gate.** (session-settled: user-approved — chosen over parsed selector kind or loaded-config presence because `ResolvedSelection.alias` consistently identifies launcher, voice, selector, positional, and newly saved aliases while excluding explicit and fresh targets.) Compose shared policy only when `selection.alias !== undefined`. This implements R6, R8-R9, and the saved-alias Key Decision.
- KTD4. **Compose once at the application generation seam.** (session-settled: user-directed — chosen over whole-envelope replacement or runtime-layer expansion because the command-line value replaces only the shared source and alias specialization still follows.) Introduce one small helper that joins defined layers with `"\n\n"` without trimming, compute the final value beside the current `effectiveInstructions` expression, and register the active general layer, alias-local layer, and final value for request redaction. This implements R6-R7 and R10-R12.
- KTD5. **Keep parser and runtime contracts stable.** Change the `--instruction` help description and precedence tests, but do not change parsing, the runtime gateway signature, BYOK Runtime, or provider adapters. This implements R9-R13 and limits the feature to configuration plus application composition.
- KTD6. **Use behavior-distinguishing fixtures.** Config tests own schema, canonical order, migration absence, and alias-save preservation. Application tests own alias entry-point parity, explicit/fresh neutrality, composition, non-mutation, and redaction. Help snapshots, manual tests, and a minor changeset own the public contract. This implements R1-R14 without duplicating provider-level tests.

### System-Wide Impact and Risks

- **Configuration durability:** Alias saves replace the whole document. Omitting the new field from any reconstruction path would silently erase manually maintained policy; preservation tests are release-blocking.
- **Behavioral transition:** Existing alias tests and documentation assert that `--instruction` replaces alias-local instructions. They must change together so shipped help and tests do not preserve the old meaning.
- **Selection parity:** Gating on parsed selector kind would miss aliases chosen through launcher or voice flows. Gating on a loaded snapshot would leak shared policy into explicit requests that load config only for fail-closed validation.
- **Snapshot consistency:** A launcher may save an alias after loading configuration. Reloading only the shared field would mix snapshots; the immediate first run must use the invocation's existing shared value.
- **Text boundaries:** Accepted values may contain leading or trailing newlines. Normalizing boundaries would violate exact-text preservation; tests must distinguish the inserted delimiter from user-owned text.
- **Prompt privacy and cost:** A shared prefix reaches every saved alias and may change provider cache prefixes and token usage. Documentation must present edits as a broad alias-policy change and repeat the plaintext warning.

### Implementation Sequencing

All work forms Phase 1 and ships in one pull request. U1 establishes the durable field before U2 consumes it. U3 follows both so public documentation and release intent describe tested behavior.

---

## Implementation Units

### U1. Add and preserve the root configuration field

- **Goal:** Make `shared_instructions` a validated, canonical, durable part of unified configuration.
- **Requirements:** R1-R5.
- **Files:** `src/config-schema.ts`, `src/config.ts`, `tests/config.test.ts`.
- **Dependencies:** None.
- **Approach:** Extend the immutable version 1 document, parse and serialize the optional field with exact accepted text, preserve it in alias mutation, and leave legacy/empty migration projections absent. Reuse current canonical round-trip and mutation fixtures.
- **Test scenarios:** Omitted, simple, multiline Unicode, exact boundary whitespace, blank and unsupported-control rejection, value-free diagnostics, canonical ordering/idempotence, unrelated alias create/overwrite preservation, and migration absence.
- **Verification:** `bun test tests/config.test.ts`.

### U2. Compose instructions at the resolved request boundary

- **Goal:** Apply shared configuration to every saved-alias request and no explicit or fresh request.
- **Requirements:** R5-R12.
- **Files:** `src/app.ts`, `tests/app.test.ts`.
- **Dependencies:** U1.
- **Approach:** Add one pure optional-layer composition helper. At the existing generation seam, use `selection.alias` to choose between the alias formula and the explicit/fresh formula, register every active source and the final value for redaction, and leave `ResolvedSelection`, `AliasRecord`, save follow-ups, and runtime signatures unchanged.
- **Test scenarios:** Shared plus local, CLI plus local, each single layer, no layer, exact newline boundaries, positional alias, `--alias`, selector alias, launcher alias, voice route, newly saved alias with snapshot-consistent shared text, explicit provider/model, fresh run-once, non-mutation, invalid-config fail-closed behavior, and source-plus-composed failure redaction.
- **Verification:** `bun test tests/app.test.ts`.

### U3. Align public contracts and release intent

- **Goal:** Make the new field and revised override meaning discoverable and release-ready.
- **Requirements:** R13-R14.
- **Files:** `src/args.ts`, `tests/args.test.ts`, `README.md`, `docs/configuration.md`, `docs/cli-reference.md`, `docs/manual-testing.md`, `.changeset/<generated-name>.md`.
- **Dependencies:** U1 and U2.
- **Approach:** Update compact help text, add a configuration example and four-case precedence table, explain alias-only blast radius and rewrite preservation, revise voice-route wording, add packaged manual scenarios, and record minor release intent without changing package versions directly.
- **Test scenarios:** Exact help fixture, every active statement about override precedence, manual shared/local/CLI/explicit cases, and valid changeset status.
- **Verification:** `bun test tests/args.test.ts`; `bun run changeset:status`.

---

## Verification Contract

| Gate | Command | Done signal |
|---|---|---|
| Focused configuration | `bun test tests/config.test.ts` | Schema, exact text, canonical ordering, mutation preservation, and migration cases pass |
| Focused application | `bun test tests/app.test.ts` | Alias composition, entry-point parity, explicit neutrality, non-mutation, and redaction pass |
| Focused help contract | `bun test tests/args.test.ts` | Updated option wording matches the approved help output and parser behavior remains green |
| Static and compiled project contract | `bun run check` | Full tests, typecheck, and compiled runtime smoke pass |
| Release metadata | `bun run changeset:status` | A valid minor changeset covers the user-visible feature |
| Diff hygiene | `git diff --check` | No patch-format or whitespace defects remain |

---

## Definition of Done

- Every requirement and acceptance example is implemented or proven by its owning unit.
- Unified version 1 configuration accepts, preserves, rewrites, and validates `shared_instructions` without changing legacy defaults.
- Every saved-alias entry point composes the winning shared or command-line layer before alias-local instructions with the exact inserted delimiter.
- Explicit provider/model and fresh run-once requests remain neutral to configured shared instructions, while their explicit `--instruction` behavior remains intact.
- The runtime receives one opaque optional instruction, and failures redact the complete active value.
- Help, README, configuration guidance, CLI reference, manual tests, and the minor changeset match the tested precedence table.
- Every gate in the Verification Contract passes.
- The pull request contains the ideation artifact, this plan, and only files required by this feature; unrelated user-owned files remain unstaged and untouched.
- No abandoned, experimental, or duplicate composition code remains in the diff.

## Sources

- `docs/ideation/2026-08-13-general-instruction-ideation.html` — user-selected alias envelope, CLI substitution, configuration durability, and provider-neutral runtime boundary.
- `docs/plans/2026-08-05-001-feat-command-line-instruction-plan.md` — the shipped request-scoped option contract whose alias precedence changes here.
- `src/config-schema.ts`, `src/config.ts`, and `tests/config.test.ts` — strict unified schema, canonical serialization, migration, alias mutation, and preservation tests.
- `src/app.ts` and `tests/app.test.ts` — resolved alias identity, launcher and voice flows, generation convergence, request redaction, and current replacement assertions.
- `src/args.ts` and `tests/args.test.ts` — existing option parsing and exact help contract.
- `src/runtime.ts`, `tests/runtime.test.ts`, and `tests/runtime-compile-smoke.ts` — single opaque instruction forwarding and provider-neutral failure handling.
- `README.md`, `docs/configuration.md`, `docs/cli-reference.md`, `docs/manual-testing.md`, and `.changeset/` — active public behavior, manual release checks, and release intent.
- No applicable repository learning was found under `docs/solutions/`; that directory does not exist.

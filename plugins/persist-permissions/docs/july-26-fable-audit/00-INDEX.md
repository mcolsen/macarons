# Audit tickets — 2026-07 (Fable audit)

Implementation tickets from the architecture/code-quality audit. Each ticket is
fully self-contained: an implementer with no other repo context should be able
to execute it literally.

## Execution order

| Ticket | From finding | Title | Size | Depends on |
|---|---|---|---|---|
| [T1](T1-duplication-guard.md) | F1 | Sync-guard test for the duplicated helper core | M | — |
| [T2](T2-matching-engine-spec.md) | F2 (+F1) | Table-driven spec for the matching engine, run against both copies | M | T1 |
| [T3](T3-cross-half-contract.md) | F1 | Cross-half agreement fixtures for "what gets persisted" | M | — |
| [T4](T4-error-containment.md) | F3 | Contain write-path and malformed-store failures | M | T1 |
| [T5](T5-no-synthesized-blanket.md) | F4 | Never persist a synthesized `"*"` pattern | S | — |
| [T6](T6-concurrency-caveat.md) | F5 | Document the last-writer-wins store concurrency model | S | — |
| [T7](T7-tui-redundancy-skip.md) | F6 | TUI edit flow: skip already-allowed unedited suggestions | M | T4 |
| [T8](T8-typed-tui-mock.md) | F7 | Type the TUI test harness against real SDK/plugin types | M | T7 |

T3, T5, T6 are independent and can land in any order relative to the others,
but the same-file orderings (T1→T2, T1→T4→T7→T8) are hard requirements.

## Open questions for the human

1. **Toast wording (T4, T7).** Both tickets introduce or change user-facing
   strings (`Not saved: could not write …`, `Saved X, but the prompt could not
   be answered — it may already have been resolved.`, `Already covered by
   permissions.local.json — request approved.`). This repo's git history shows
   toast wording is deliberately curated — review these exact strings before or
   after landing; the tests pin them.
2. **T6 direction.** The audit recommended *documenting* the last-writer-wins
   concurrency model rather than building merge-on-write or locking (windows
   are milliseconds; cost of a lost rule is one extra prompt). T6 implements
   the documentation option. Say the word if you want merge-on-write instead.
3. **No-new-exports invariant.** T1/T2 avoid exporting the shared helpers from
   `src/index.ts` on the assumption that OpenCode's V1 server-plugin loader
   iterates a module's exports and may invoke stray function exports as
   plugins. If you can confirm the loader only calls exports that look like
   plugin factories, T2's source-extraction machinery could be replaced by
   plain exports + imports in a follow-up.

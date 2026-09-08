# Vendored betterleaks rule set

- Upstream: https://github.com/betterleaks/betterleaks
- License: MIT (see `LICENSE` in this directory, © 2026 Zachary Rice)
- Vendored commit: `0b4063d7990e0ab6366a5b4eb58789584af5f945` (2026-07-10)
- Files: `betterleaks.toml` (the default rule database, verbatim), `LICENSE`

`scripts/vendor-rules.ts` compiles `betterleaks.toml` into
`src/engine/rules.generated.ts`: Go RE2 patterns are mechanically transformed
into JavaScript `RegExp` sources, and the Expr filter programs are folded into
plain data (entropy ceilings, allow-regexes, stopword lists). The script fails
loudly on any rule or filter shape it does not recognize, so upstream format
changes are surfaced instead of silently dropped.

To update: replace `betterleaks.toml` with the newer upstream copy, update the
commit hash above, and run `bun run vendor` in the plugin directory. The diff
of `rules.generated.ts` is the review surface.

Deliberate deviations from upstream detection behavior are listed in the
plugin README ("Differences from betterleaks").

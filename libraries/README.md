# Macarons shared libraries

Packages used by multiple Macarons plugins live here under the `@macarons`
scope.

Keep code inside its plugin until a second package demonstrates the same API.
That first happened when `approve-for-me` needed the exact
permission-matching semantics `persist-permissions` already carried, and
[`permission-rules`](permission-rules) was extracted — wildcard matching,
last-rule-wins evaluation, the store shape and I/O, and the OpenCode v1
version guard. The 2026-07 audit (issue #37) then consolidated the
suite-common helpers the plugins had forked — trust-boundary path
containment, server locality, the app logger, and the version-gate
boilerplate of both plugin halves — into the same package rather than a
second one: every plugin already depended on it, and one package keeps one
definition-site guard surface. Persistence *policy* (what gets saved, when,
and how narrow) remains plugin-local.

The second extraction is [`usage-limits`](usage-limits): Codex and Synthetic
share quota snapshot shapes, polling, session/classifier relevance, and TUI
lifecycle, while each plugin keeps provider auth and API semantics local. JSX
also remains entry-local because OpenCode substitutes its Solid runtime only
for a TUI entry module.

The engine's behavior spec deliberately stays in
`plugins/persist-permissions/test/matching-spec.test.ts`, running against this
single copy through that plugin's re-exports; a guard there asserts no
consumer keeps a private duplicate of the engine, and the library's own
`test/sole-definition-site.test.ts` extends that to every shared helper across
every plugin.

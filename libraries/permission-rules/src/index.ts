/**
 * @macarons/permission-rules
 *
 * The OpenCode V1 permission-rule engine shared by the plugins in
 * this monorepo — store shape, wildcard matching, last-rule-wins evaluation,
 * decision helpers, store I/O, and the supported-version guard — plus the
 * suite-common plumbing every plugin otherwise forks: trust-boundary path
 * containment (isInside/canonicalPath), server-locality classification, the
 * app logger, and the boot-time version gates for both plugin halves. The
 * engine was extracted verbatim from persist-permissions' src/shared.ts when
 * a second plugin (approve-for-me) needed the exact same
 * semantics — the extraction point the repository README anticipated; the
 * suite-common helpers followed (issue #37) because every package already
 * depended on this library and a second shared package would only have split
 * one definition-site guard surface into two.
 *
 * This package is the sole definition site for everything it exports. The
 * behavior spec that pins the engine's semantics lives in
 * plugins/persist-permissions/test/matching-spec.test.ts and runs against
 * this copy through that package's re-exports; a guard there asserts no
 * consumer keeps a private duplicate of the engine, and
 * test/sole-definition-site.test.ts in this package extends that guard to
 * the suite-common helpers across every plugin.
 *
 * Everything here replicates OpenCode's own permission semantics: `*` / `?`
 * wildcards, `~` and `$HOME` expansion, and last matching rule wins. When
 * OpenCode's V2 permission engine (which persists approvals natively and
 * reshapes the permission API) becomes the default, this library retires with
 * the plugins that consume it.
 */

export * from "./async"
export * from "./compat"
export * from "./engine"
export * from "./filesystem"
export * from "./filesystem-locality"
export * from "./sdk-auth"
export * from "./source-redaction"
export * from "./store-keying"

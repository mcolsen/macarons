/**
 * Shared Macarons policy and trusted-storage helpers. V2 permission decisions
 * are evaluated by the host; the internal rule vocabulary also supports
 * conservative vetoes from existing approval data. Legacy compatibility
 * helpers remain available for historical tests, but active V2 plugins use
 * native context APIs rather than V1 version gates or TUI event bridges.
 */

export * from "./async"
export * from "./compat"
export * from "./engine"
export * from "./filesystem"
export * from "./filesystem-locality"
export * from "./isolated-generation"
export * from "./sdk-auth"
export * from "./source-redaction"
export * from "./store-keying"

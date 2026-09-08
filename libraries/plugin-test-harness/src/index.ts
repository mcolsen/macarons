// Server-safe surface only: nothing here (transitively) types against
// @opentui or solid-js, so server-only plugins' packaging/bundle tests stay
// clear of the TUI machinery. The api mock core and the gating triad live in
// ./tui; the solid test-renderer helpers live in ./view.
export { flush, tick, until } from "./async"
export {
  type BundleContext,
  type BundleOptions,
  describeBundle,
} from "./bundle"
export { describePackaging, type PackagingOptions } from "./packaging"

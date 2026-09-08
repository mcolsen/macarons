// Bun imports .toml files natively; give TypeScript the module shape.
declare module "*.toml" {
  const value: unknown
  export default value
}

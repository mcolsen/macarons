# Macarons shared libraries

Keep code inside its plugin until two consumers need the same mechanism.

- [permission-rules](permission-rules/README.md) contains internal approval
  policy, trusted filesystem and storage helpers, bounded async work, and
  cooperative source-redaction / isolated-generation registries. Native v2
  owns permission evaluation and persisted approvals.
- [usage-limits](usage-limits/README.md) shares quota snapshot contracts,
  server-side polling/RPC, session/classifier relevance, and native terminal
  lifecycle. Codex and Synthetic keep provider-specific authentication and
  response parsing in their own packages.
- [plugin-test-harness](plugin-test-harness/README.md) provides development-only
  native package, build, async, and headless-render checks.

No library registers a plugin on its own. Plugin policy remains local to the
consumer; libraries share mechanisms and explicit contracts.

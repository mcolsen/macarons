# @macarons/permission-rules

Shared internal mechanisms used by Macarons: permission-pattern evaluation for
conservative approval vetoes, trusted storage/path checks, atomic writes,
filesystem-locality proofs, source redaction, and bounded async operations.
OpenCode v2 evaluates its own native permission rules and persists approvals.
This library does not reimplement those host features as an installed plugin.

Approve for Me continues to read existing local rule data conservatively so an
old denial cannot silently become an automatic approval. Native requests are
translated to its internal `permission/pattern/action` vocabulary at the plugin
boundary. New user approvals belong to native v2 permissions.

`verifyFilesystemLocality` and its server responder prove bidirectional access
to every required trusted directory. Native read-only RPC transports temporary
challenge markers; it cannot change policy. URL names and loopback addresses
alone never authorize local controls. Marker responses and acknowledgements
are owner-only and cleaned up after use.

`registerSourceRedactor` / `redactSourceValue` share the active redaction engine
across separately bundled plugins in the same process. Registrations are scoped
by directory and workspace. Failures abort without exposing raw source text.
`isolateGeneration` lets the classifier mark its temporary session so scoped
prompt rules cannot overwrite its fixed policy regardless of plugin order.
These are cooperative plugin contracts, not a sandbox against arbitrary code.

Legacy host-compatibility helpers remain for historical regression coverage.
The active v2 plugins do not use the V1 compatibility gates or event bridges.

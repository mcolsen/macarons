# @macarons/synthetic-limits

Shows Synthetic five-hour and weekly quotas, including incremental regeneration
times, in the OpenCode v2 sidebar. The section appears for a Synthetic session
or an enabled Approve for Me classifier using Synthetic. Child sessions do not
display quotas.

Install with `bun setup` from the repository root. OpenCode v2 requires both the
server companion and the TUI entry. Add the package directory to `plugins` in
`opencode.json[c]` and global `cli.json`:

```json
{
  "plugins": ["file:///absolute/path/to/macarons/plugins/synthetic-limits"]
}
```

The wizard upgrades older TUI-only installations. Restart the server and TUI.

The server obtains the effective API key through OpenCode's active Synthetic
integration connection and reads `https://api.synthetic.new/v2/quotas`. Remote
TUIs receive quota snapshots over OpenCode RPC; credentials stay on the server.
Account changes clear old snapshots, rejected keys suspend reads until they
change, and repeated failures hide stale values.

Polling defaults to 60 seconds with a 15-second minimum. Set `options.interval`
on the plugin declaration to adjust it. Server endpoint overrides for controlled
tests use `options.providers.synthetic.endpoint`; that endpoint receives the
server's authorization header.

```sh
bun run --cwd plugins/synthetic-limits test
bun run --cwd plugins/synthetic-limits typecheck
```

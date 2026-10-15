# @macarons/codex-limits

Shows ChatGPT/Codex subscription usage windows and reset times in the OpenCode
v2 sidebar. The section appears for an OpenAI session or an enabled Approve for
Me classifier using OpenAI. Child sessions do not display quotas.

Install with `bun setup` from the repository root. Both the server and TUI
halves are required. Native configuration points to the package directory:

```json
{
  "plugins": ["file:///absolute/path/to/macarons/plugins/codex-limits"]
}
```

Add that entry to `opencode.json[c]` for the server and `cli.json` for the TUI.
The wizard migrates old source-file entries. Restart the server and attached
TUIs after updating.

The server resolves OpenCode's active OpenAI integration connection and accepts
ChatGPT browser or headless OAuth credentials. It reads quota information from
`https://chatgpt.com/backend-api/wham/usage`. OpenCode owns credential refresh.
The newer `chatgpt-token-sharing` login is not sent to this legacy quota
endpoint; the widget stays hidden for that method.
No local TUI auth file is consulted, and credentials or account identifiers are
never returned to the TUI. Remote TUIs display the connected server's quotas.

Account changes discard stale responses. A rejected token suspends requests
until credentials change; repeated transient failures hide stale data. Polling
defaults to 60 seconds, with a 15-second minimum. Optional server configuration:

```json
{
  "plugins": [{
    "package": "file:///absolute/path/to/macarons/plugins/codex-limits",
    "options": {"interval": 60}
  }]
}
```

Provider endpoint overrides remain available under
`providers.openai.endpoint` for controlled test deployments. These endpoints
receive authorization headers, so configure them only on the server you own.

```sh
bun run --cwd plugins/codex-limits test
bun run --cwd plugins/codex-limits typecheck
```

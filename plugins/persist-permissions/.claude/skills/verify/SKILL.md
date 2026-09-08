---
name: verify
description: Drive the real OpenCode TUI headlessly (tmux + fake LLM) to verify plugin changes end-to-end
---

# Verifying this plugin end-to-end

Both halves load into a real `opencode` (the compiled binary at `~/.opencode/bin/opencode`).
No paid tokens needed: a fake OpenAI-compatible server stands in for the LLM.

## Recipe (verified on the pinned OpenCode in `.opencode-version`)

1. **Fake LLM**: a Bun script serving `/v1/chat/completions` that streams one hardcoded
   `bash` tool call (env `FAKE_LLM_COMMAND`), then answers "done" once a tool result
   follows the *last user message* (older tool results must not count — multi-turn gotcha).
   Minimal SSE sequence: role delta → tool_calls name delta → arguments delta →
   finish_reason `"tool_calls"` → `[DONE]`.
2. **Scratch project** (git-init it; also test a non-git dir — worktree is reported as `/` there):
   - `opencode.json`: provider `fake` with `"npm": "@ai-sdk/openai-compatible"` (statically
     bundled in the binary), `options.baseURL` → the fake server, `"model": "fake/test"`,
     `"permission": { "bash": "ask" }`, and `"plugin": ["file://<plugin-dir>/src/index.ts"]`.
   - `.opencode/tui.json`: `{ "plugin": ["file://<plugin-dir>/src/tui.tsx"] }`.
3. **Launch the TUI headlessly** — override ALL XDG dirs to a scratch area (sidesteps the
   user's global config and any offline-provider boot stall; fresh boot ≈ 10 s):

   ```sh
   tmux -L ocverify new-session -d -x 200 -y 50 -c <proj> \
     "env XDG_CONFIG_HOME=... XDG_DATA_HOME=... XDG_STATE_HOME=... XDG_CACHE_HOME=... opencode"
   ```

4. **Drive**: `tmux -L ocverify send-keys "any message" Enter` → permission prompt appears
   (~6 s). `send-keys C-o` opens the edit dialog; `C-u` clears the prefilled field;
   `Escape` cancels; `Enter` confirms. Assert with `capture-pane -p`.
5. **Assert on disk**: `<proj>/.opencode/permissions.local.json` and `.opencode/.gitignore`.

## Gotchas

- Success toasts live only ~2 s — capture within ~1 s of the action or you'll miss them.
- Never `pkill -f` a pattern that appears literally in your own compound command (kills your
  shell, exit 144). Record PIDs at spawn and `kill $(cat pidfile)` in a separate call.
- Re-prompting needs a command not covered by saved/in-memory rules: restart the fake LLM
  with a different `FAKE_LLM_COMMAND`; the TUI can stay up.

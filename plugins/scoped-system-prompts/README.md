# @macarons/scoped-system-prompts

Ordered system-prompt rules for exact provider/model pairs in OpenCode
**2.0.29+**. Native agent-level system prompts do not supply this model-level
selection. No matching rules means no changes.

Run `bun setup`, or add the local package directory to `opencode.json`:

```jsonc
{
  "plugins": [{
    "package": "file:///path/to/macarons/plugins/scoped-system-prompts",
    "options": { "prompts": [{
      "model": "openai/gpt-6.1-sol",
      "mode": "append",
      "content": "Be concise and show concrete examples."
    }] }
  }]
}
```

`model` matches the selectable provider/model ID exactly, including aliases;
matching is case-sensitive. `content` is a nonempty string or an array of nonempty
strings. Rules run in declaration order. `replace` replaces all system parts,
`prepend` inserts before them, and `append` inserts after them. Untouched parts
retain their cache hints and metadata. Invalid rules warn and are ignored.

The native `context`, `compaction`, `title`, and `generate` session hooks apply
these rules to the agent loop and auxiliary session requests. Independent
sessionless generation APIs do not pass through session hooks. Use replacement
carefully because it also replaces host instructions. Restart the server after
editing options. There is no TUI plugin.

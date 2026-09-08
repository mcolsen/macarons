# @macarons/scoped-system-prompts

A server-only OpenCode plugin for changing the system prompt for exact
provider/model pairs. It has no built-in or default prompt: without matching
configuration, it is inert.

## Install

Clone the repository as described in the [root README](../../README.md), then
run the installer from the checkout root:

```sh
bun install && bun setup
```

After installing dependencies, you can instead reference the local server
source directly from `opencode.json`; no published package is required:

```jsonc
{
  "plugin": [
    "file:///path/to/macarons/plugins/scoped-system-prompts/src/index.ts"
  ]
}
```

Restart OpenCode after installing or changing the configuration. Configuration
changes are read when the server plugin loads; they do not take effect in an
already-running server.

## Configuration

Options use the standard `[spec, options]` plugin tuple:

```jsonc
{
  "plugin": [
    [
      "file:///path/to/macarons/plugins/scoped-system-prompts/src/index.ts",
      {
        "prompts": [
          {
            "model": "anthropic/claude-sonnet-4",
            "mode": "prepend",
            "content": "Be concise and show concrete examples."
          }
        ]
      }
    ]
  ]
}
```

Each rule has this shape:

| Field | Values | Meaning |
| --- | --- | --- |
| `model` | exact `"provider/model"` string | The final resolved provider/model to match. Matching is case-sensitive. Model IDs may contain additional `/` characters. |
| `mode` | `"replace"`, `"prepend"`, or `"append"` | How to change the current system-prompt array. |
| `content` | non-empty string or non-empty string array | The content to insert or use as the replacement. Blank strings are invalid, including array entries. |

Rules are evaluated in declaration order. Each matching rule mutates the
current system-prompt array before the next rule runs:

- **`replace`** replaces the current system-prompt array with the rule's
  content.
- **`prepend`** puts the rule's content before the current array.
- **`append`** puts the rule's content after the current array.

For example, this configuration appends a delegation policy only when the
resolved model is `openai/gpt-5.6-sol`:

```jsonc
{
  "plugin": [
    [
      "file:///path/to/macarons/plugins/scoped-system-prompts/src/index.ts",
      {
        "prompts": [
          {
            "model": "openai/gpt-5.6-sol",
            "mode": "append",
            "content": "Decompose tasks into smaller pieces. Delegate only the most difficult tasks to openai/gpt-5.6-sol; use openai/gpt-5.6-terra and openai/gpt-5.6-luna for less difficult tasks."
          }
        ]
      }
    ]
  ]
}
```

The delegation text above is only an example of configuration. The plugin does
not know those models, assign work, or otherwise implement a delegation policy.

An omitted `prompts` option, or an empty array, does nothing. Invalid rules are
skipped and logged; valid rules in the same configuration continue to apply.

## Matching and scope

Matching uses OpenCode's final resolved provider/model, not an earlier raw
request field. It is exact and case-sensitive. There is no wildcard matching,
and model variants cannot be targeted separately: a rule applies to every
variant of its exact provider/model pair.

The hook has no agent discriminator. Consequently, matching applies equally to
ordinary requests and to hidden title-generation, compaction, and
agent-generation calls whenever their resolved provider/model matches.

`replace` operates at this plugin's point in the host's configuration order.
Other plugins loaded later may modify the replacement, just as they may modify
any current system-prompt array. When that order matters, list this plugin and
the interacting plugins explicitly in the desired `plugin` array order instead
of relying on auto-discovery order.

## Server-only export

The package exposes the `./server` install target. It is intended for
`opencode.json` and does not provide a TUI companion.

import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "macarons.fixture.redaction-tool",
  async setup(context) {
    await context.tool.transform((editor) => {
      editor.add({
        name: "deploy_ghp_x7K2mQ9pL4vN8rT3wY6bJ1hF5dS0aZcE2gUq",
        description: "Return a fixed test marker without changing any files.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false },
        execute: async () => ({ content: "MACARONS_ALIAS_EXECUTED" }),
      })
    })
  },
})

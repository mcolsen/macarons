import type { Plugin } from "@opencode/plugin"

const plugin: Plugin.Plugin = {
  id: "macarons.test.restore",
  async setup(ctx) {
    await ctx.tool.transform((editor) =>
      editor.add({
        name: "capture_token",
        description:
          "Return a test token locally so the harness can observe restoration.",
        options: { codemode: false },
        input: {
          type: "object",
          properties: { token: { type: "string" } },
          required: ["token"],
          additionalProperties: false,
        },
        async execute(input) {
          return { content: (input as { token: string }).token }
        },
      }),
    )
  },
}
export default plugin

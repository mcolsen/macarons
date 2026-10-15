import { Rpc } from "@opencode/plugin"

/** Public RPC contains quota values only; credentials never cross into the UI. */
export function usageLimitsRpc(providerID: string) {
  return Rpc.define({
    id: `macarons.${providerID}-limits`,
    methods: {
      snapshot: {
        input: { type: "object", properties: {}, additionalProperties: false },
        output: {
          type: "object",
          properties: {
            snapshot: {
              anyOf: [
                { type: "null" },
                {
                  type: "object",
                  properties: {
                    planType: { type: "string" },
                    windows: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          key: { type: "string" },
                          label: { type: "string" },
                          usedPercent: {
                            type: "number",
                            minimum: 0,
                            maximum: 100,
                          },
                          resetsAt: { type: "number" },
                          resetVerb: { type: "string" },
                        },
                        required: ["key", "label", "usedPercent"],
                        additionalProperties: false,
                      },
                    },
                  },
                  required: ["windows"],
                  additionalProperties: false,
                },
              ],
            },
          },
          required: ["snapshot"],
          additionalProperties: false,
        },
      },
    },
    events: {},
  })
}

export const classifierProviderRpc = Rpc.define({
  id: "macarons.approve-for-me",
  methods: {
    classifierProvider: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { providerID: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
  events: {},
})

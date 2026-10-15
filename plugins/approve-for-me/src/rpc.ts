import { Rpc } from "@opencode/plugin"
import { Schema } from "effect"
import type {
  Activity,
  ResolvedSettings,
  ServerStatus,
  TrustedSettingsPaths,
} from "./shared"

const portable = Schema.toStandardSchemaV1

/** Only observations and temporary filesystem proofs are exposed over RPC. */
export const rpcDefinition = Rpc.define({
  id: "macarons.approve-for-me",
  methods: {
    snapshot: {
      input: portable(Schema.Struct({})),
      output: portable(
        Schema.Struct({
          instanceID: Schema.String,
          directory: Schema.String,
          projectRoot: Schema.String,
          configRoot: Schema.String,
          paths: Schema.optional(Schema.Unknown),
          enabled: Schema.Boolean,
          settings: Schema.optional(Schema.Unknown),
          server: Schema.optional(Schema.Unknown),
          requests: Schema.Unknown,
        }),
      ),
    },
    classifierProvider: {
      input: portable(Schema.Struct({ sessionID: Schema.String })),
      output: portable(
        Schema.Struct({ providerID: Schema.optional(Schema.String) }),
      ),
    },
    locality: {
      input: portable(Schema.Struct({ command: Schema.String })),
      output: portable(Schema.Struct({ handled: Schema.Boolean })),
    },
  },
  events: {},
})

export type ApprovalSnapshot = {
  instanceID: string
  directory: string
  projectRoot: string
  configRoot: string
  paths?: TrustedSettingsPaths
  enabled: boolean
  settings?: ResolvedSettings
  server?: ServerStatus
  requests: Activity
}

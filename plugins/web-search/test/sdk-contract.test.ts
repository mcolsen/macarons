import { expect, test } from "bun:test"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
import type { Model, Path, Provider } from "@opencode-ai/sdk"
import type { ProvidersClient } from "../src/backends/native/resolve"

// Compile-time pins for the host surfaces this plugin reads outside its own
// hand-rolled types. The native backend consumes client.config.providers()
// through a structural ProviderData type (so unit tests can stub it), which
// means SDK drift would otherwise surface only at runtime as "no native
// provider found". These pins put the check back at typecheck.

// ToolContext names the executing assistant, not the latest user message.
// Pin the injected legacy client's request and response, not the v2 SDK.
type Client = PluginInput["client"]
const providersRequest = (signal: AbortSignal) =>
  ({ signal }) satisfies Parameters<Client["config"]["providers"]>[0]
const providersClient = (client: Client) => client satisfies ProvidersClient
const messageRequest = (
  ctx: ToolContext,
  directory: PluginInput["directory"],
) =>
  ({
    path: { id: ctx.sessionID, messageID: ctx.messageID },
    query: { directory },
    signal: ctx.abort,
  }) satisfies Parameters<Client["session"]["message"]>[0]
type Message = NonNullable<
  Awaited<ReturnType<Client["session"]["message"]>>["data"]
>["info"]
const assistantModel = (message: Message) => {
  if (message.role !== "assistant") return undefined
  return {
    id: message.id,
    sessionID: message.sessionID,
    providerID: message.providerID,
    modelID: message.modelID,
  } satisfies Record<string, string>
}

// The provider scan reads id/key/options/models, each model's api.npm (for
// renamed-provider detection), headers, and options (for the websearch flags). A
// fresh literal under `satisfies` keeps excess-property checking alive.
const providerFields = (provider: Provider, model: Model) =>
  ({
    id: provider.id,
    key: provider.key,
    options: provider.options,
    models: provider.models,
    npm: model.api.npm,
    modelOptions: model.options,
    modelHeaders: model.headers satisfies Record<string, string>,
  }) satisfies Record<string, unknown>

// The search-activity channel writes under the host's state dir. (The OAuth
// reader used to derive auth.json from this same field; it now resolves the
// store the way the host does, from the environment of the process they
// share — see backends/native/auth.ts.)
const statePath = (info: Path) => info.state satisfies string

test("the SDK shapes this plugin depends on still line up", () => {
  expect(typeof providersRequest).toBe("function")
  expect(typeof providersClient).toBe("function")
  expect(typeof messageRequest).toBe("function")
  expect(typeof assistantModel).toBe("function")
  expect(typeof providerFields).toBe("function")
  expect(typeof statePath).toBe("function")
})

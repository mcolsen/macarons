import { makeTuiApi } from "@macarons/plugin-test-harness/tui"
import type { TuiDialogPromptProps, TuiPlugin } from "@opencode-ai/plugin/tui"
import { tui } from "../src/tui"

type Api = Parameters<TuiPlugin>[0]
export type Call = { method: string; params: Record<string, unknown> }
export type CapturedPrompt = TuiDialogPromptProps & {
  onConfirm: (value: string) => void
  onCancel: () => void
}

type MessageSeed = {
  info: {
    id: string
    role: string
    time?: { completed?: number }
    model?: { providerID: string; modelID: string; variant?: string }
  }
}

const idleMessages: MessageSeed[] = [
  { info: { id: "msg_01", role: "user" } },
  { info: { id: "msg_02", role: "assistant", time: { completed: 5 } } },
]

// The fork's copies of the parent history — fresh IDs, like the real host.
const forkCopies: MessageSeed[] = [
  { info: { id: "msg_10", role: "user" } },
  { info: { id: "msg_11", role: "assistant", time: { completed: 5 } } },
]

/**
 * btw's api mock — the shared core plus what this plugin's entry actually
 * touches: a recording client dispatcher over session.* + permission.reply
 * with fault injection (during/failWith/delayOnce), the host-faithful dialog
 * stack (modeled on OpenCode 1.17.18's ui/dialog.tsx), the DialogPrompt
 * capture, and the OSC52 clipboard. Shared by the engine tests (tui.test.ts)
 * and the rendering tests (view.test.tsx), which used to carry two divergent
 * copies; the dialog stack stores every render thunk it is handed (exposed
 * via `render()`) so the view tests can mount the panel under the real
 * renderer — storing is side-effect-free for the engine tests.
 */
export function makeApi(
  input: {
    version?: string | null
    baseUrl?: string
    /** `null` puts the route on "home" — no session to ask about. */
    routeSessionID?: string | null
    messages?: MessageSeed[]
    forkMessages?: MessageSeed[]
    parentModel?: { id: string; providerID: string; variant?: string }
    forkID?: string
    copySupported?: boolean
    /** Mint ses_fork_1, ses_fork_2, … so overlapping starts get distinct forks. */
    dynamicForks?: boolean
    /** What session.list returns — pre-existing sessions the sweep sees. */
    sessions?: { id: string; metadata?: unknown }[]
  } = {},
) {
  const base = makeTuiApi({
    version: input.version,
    baseUrl: input.baseUrl,
    routeName: input.routeSessionID === null ? "home" : "session",
    routeSessionID: input.routeSessionID ?? "ses_parent",
    paths: { worktree: "/repo", directory: "/repo" },
    // The core's theme is hex already (the renderer rejects non-color
    // garbage); the panel additionally reads markdownText.
    theme: { markdownText: "#e0e0e0" },
  })

  const forkID = input.forkID ?? "ses_fork"
  let forkCount = 0
  const calls: Call[] = []
  const replies: Record<string, unknown>[] = []
  const copied: string[] = []
  let prompt: CapturedPrompt | undefined
  let dialogStack: { onClose?: () => void }[] = []
  // The latest render fn handed to dialog.replace. After a full drive-to-state
  // the panel is the frontmost dialog, so this is the panel render — kept so a
  // rendering test can mount it under the real renderer via testRender.
  let latestRender: (() => unknown) | undefined
  let duringPromptAsync: ((messageID: string) => void) | undefined

  // Injected mid-call behavior: `during` runs a callback synchronously while
  // the named request is "in flight" (the user acting mid-start); `failWith`
  // makes the named method resolve { error }; `rejectOnce` models a lost
  // transport response; `delayOnce` holds the NEXT call of a method for n
  // microtask hops; `holdOnce` waits for an explicit release instead.
  const duringCalls = new Map<string, () => void>()
  const failures = new Map<string, unknown>()
  const rejectedOnce = new Map<string, unknown>()
  const delayedOnce = new Map<string, number>()
  const heldOnce = new Map<string, Promise<void>>()
  const persistedPromptIDs = new Set<string>()
  let persistPrompts = false

  const record = async (
    method: string,
    params: Record<string, unknown>,
    data: unknown,
  ) => {
    calls.push({ method, params })
    const held = heldOnce.get(method)
    heldOnce.delete(method)
    duringCalls.get(method)?.()
    if (held) await held
    const hops = delayedOnce.get(method)
    if (hops !== undefined) {
      delayedOnce.delete(method)
      for (let i = 0; i < hops; i++) await Promise.resolve()
    }
    const failure = failures.get(method)
    if (failure !== undefined) return { error: failure }
    const rejection = rejectedOnce.get(method)
    if (rejection !== undefined) {
      rejectedOnce.delete(method)
      throw rejection
    }
    return { data }
  }

  const isFork = (id: unknown) =>
    id === forkID || (typeof id === "string" && id.startsWith("ses_fork"))
  const session = {
    get: (params: Record<string, unknown>) =>
      record("session.get", params, {
        id: params.sessionID,
        agent: "build",
        model: input.parentModel,
      }),
    messages: (params: Record<string, unknown>) =>
      record(
        "session.messages",
        params,
        isFork(params.sessionID)
          ? (input.forkMessages ?? forkCopies)
          : (input.messages ?? idleMessages),
      ),
    fork: (params: Record<string, unknown>) =>
      record("session.fork", params, {
        id: input.dynamicForks ? `ses_fork_${++forkCount}` : forkID,
      }),
    update: (params: Record<string, unknown>) =>
      record("session.update", params, { id: params.sessionID }),
    promptAsync: (params: Record<string, unknown>) => {
      // Fired while the request is in flight: the real host's runner starts
      // streaming as soon as the prompt is admitted, so events can land
      // before the promptAsync response does.
      duringPromptAsync?.(String(params.messageID))
      if (persistPrompts && typeof params.messageID === "string")
        persistedPromptIDs.add(params.messageID)
      return record("session.promptAsync", params, {})
    },
    message: (params: Record<string, unknown>) =>
      record(
        "session.message",
        params,
        persistedPromptIDs.has(String(params.messageID))
          ? { info: { id: params.messageID } }
          : undefined,
      ),
    delete: (params: Record<string, unknown>) =>
      record("session.delete", params, true),
    abort: (params: Record<string, unknown>) =>
      record("session.abort", params, true),
    list: (params: Record<string, unknown>) =>
      record("session.list", params, input.sessions ?? []),
  }

  const dialog = {
    // Faithful to 1.17.18 ui/dialog.tsx: the outgoing dialogs' close
    // callbacks run synchronously BEFORE the stack is swapped, popped, or
    // cleared — a callback that calls replace() re-enters itself.
    replace: (render: () => unknown, close?: () => void) => {
      for (const item of dialogStack) item.onClose?.()
      dialogStack = [{ onClose: close }]
      latestRender = render
      try {
        render()
      } catch {
        // Panel renders raw JSX intrinsics that need a live renderer; the
        // engine tests observe client/side effects, not the rendered tree —
        // the view tests mount latestRender properly via testRender.
      }
    },
    clear: () => {
      for (const item of dialogStack) item.onClose?.()
      dialogStack = []
    },
    setSize: () => {},
    get open() {
      return dialogStack.length > 0
    },
  }

  const api = {
    ...base.api,
    ui: {
      ...base.api.ui,
      DialogPrompt: (props: TuiDialogPromptProps) => {
        prompt = props as CapturedPrompt
        return null
      },
      dialog,
    },
    client: {
      ...base.api.client,
      app: {
        agents: () =>
          Promise.resolve({
            data: [
              {
                name: "build",
                permission: [
                  { permission: "*", pattern: "*", action: "allow" },
                ],
              },
            ],
          }),
      },
      session,
      permission: {
        reply: (params: Record<string, unknown>) => {
          replies.push(params)
          return Promise.resolve({ data: undefined })
        },
      },
    },
    renderer: {
      copyToClipboardOSC52: (text: string) => {
        copied.push(text)
        return input.copySupported !== false
      },
    },
  }

  return {
    ...base,
    api,
    load: (options?: Record<string, unknown>) =>
      tui(api as unknown as Api, options, {} as never),
    calls,
    replies,
    copied,
    emitDuringPromptAsync: (fn: (messageID: string) => void) => {
      duringPromptAsync = fn
    },
    during: (method: string, fn: () => void) => duringCalls.set(method, fn),
    failWith: (method: string, error: unknown) => failures.set(method, error),
    clearFailure: (method: string) => failures.delete(method),
    rejectOnce: (method: string, error: unknown) =>
      rejectedOnce.set(method, error),
    persistPromptMessages: (enabled = true) => {
      persistPrompts = enabled
    },
    delayOnce: (method: string, hops: number) => delayedOnce.set(method, hops),
    holdOnce: (method: string) => {
      const { promise, resolve } = Promise.withResolvers<void>()
      heldOnce.set(method, promise)
      return resolve
    },
    prompt: () => prompt,
    dialogOpen: () => dialogStack.length > 0,
    closeDialog: () => dialog.clear(),
    // The host's Escape binding: current dialog's onClose, THEN pop.
    escapeDialog: () => {
      const current = dialogStack.at(-1)
      current?.onClose?.()
      dialogStack = dialogStack.slice(0, -1)
    },
    render: () => latestRender,
  }
}

/** Run the entry and return the registered command layer (throws if none). */
export async function load(
  harness: ReturnType<typeof makeApi>,
  options?: Record<string, unknown>,
) {
  await harness.load(options)
  const layer = harness.layers[0]
  if (layer === undefined) throw new Error("no layer registered")
  return layer
}

export const command = (layer: Record<string, any>, name: string) =>
  layer.commands.find((c: { name: string }) => c.name === name)
    .run as () => void | Promise<void>

import { type PermissionAsk, trim } from "@macarons/permission-rules"
import {
  compareStackOrder,
  type ProcessingMode,
  type StackPosition,
} from "../shared"

export type BatchJob = {
  request: PermissionAsk
  controller: AbortController
  settle: () => void
}

type BatchTree = {
  queue: Map<string, BatchJob>
  holding: Map<string, StackPosition>
  parked: Map<
    string,
    { position: StackPosition; release: (proceed: boolean) => void }
  >
  active: Map<string, StackPosition>
  activeBatch?: string
}

type JobOutcome = "approved" | "left"
type FinishedJobOutcome = JobOutcome | "resolved"

type BatchSchedulerDependencies = {
  handle: (
    request: PermissionAsk,
    controller: AbortController,
    treeKey: string,
    releaseTurn: () => boolean | Promise<boolean>,
  ) => Promise<JobOutcome>
  headline: (request: PermissionAsk) => string
  log: (level: "error" | "info", message: string) => void
  readProcessingMode: () => Promise<ProcessingMode>
  onJobFinished: (request: PermissionAsk) => void
  onAncestryBlockedChange: (blocked: boolean) => void
  maxQueued: number
}

type ProvisionalAncestry = {
  request: PermissionAsk
  controller: AbortController
}

type AncestryResolution =
  | { state: "queued"; settled: Promise<void> }
  | { state: "held" }
  | { state: "cancelled" }

export const batchKeyOf = (request: PermissionAsk): string =>
  request.toolCall
    ? `${request.sessionID}\u0000${request.toolCall.messageID}`
    : `solo\u0000${request.id}`

const positionOf = (request: PermissionAsk): StackPosition => ({
  sessionID: request.sessionID,
  requestID: request.id,
})

/**
 * Schedules classifier jobs one turn-batch at a time per root-session tree,
 * while releasing accepted approvals strictly in host stack order.
 */
export function createBatchScheduler(deps: BatchSchedulerDependencies) {
  const trees = new Map<string, BatchTree>()
  const treeKeys = new Map<string, string>()
  const answered = new Set<string>()
  const unresolvedAncestry = new Set<string>()
  const provisionalAncestry = new Map<string, ProvisionalAncestry>()
  const controllers = new Map<string, AbortController>()
  const decided = new Set<string>()
  const runningJobs = new Set<Promise<void>>()
  let stopped = false
  let processingMode: ProcessingMode = "serial"
  let processingModeRead: Promise<void> | undefined
  let processingModeRefreshPending = false

  const treeFor = (key: string): BatchTree => {
    let tree = trees.get(key)
    if (!tree) {
      tree = {
        queue: new Map(),
        holding: new Map(),
        parked: new Map(),
        active: new Map(),
      }
      trees.set(key, tree)
    }
    return tree
  }

  const dropTreeIfEmpty = (key: string, tree: BatchTree) => {
    if (
      !tree.queue.size &&
      !tree.holding.size &&
      !tree.parked.size &&
      !tree.active.size
    )
      trees.delete(key)
  }

  const ancestryBlocked = () => unresolvedAncestry.size > 0
  const addAncestryBarrier = (requestID: string) => {
    const blocked = ancestryBlocked()
    unresolvedAncestry.add(requestID)
    if (!blocked) deps.onAncestryBlockedChange(true)
  }
  const removeAncestryBarrier = (requestID: string): boolean => {
    const blocked = ancestryBlocked()
    const removed = unresolvedAncestry.delete(requestID)
    if (removed && blocked && !ancestryBlocked())
      deps.onAncestryBlockedChange(false)
    return removed
  }

  const blockedAbove = (
    tree: BatchTree,
    position: StackPosition,
    selfID: string,
  ): boolean => {
    for (const judging of tree.active.values()) {
      if (
        judging.requestID !== selfID &&
        compareStackOrder(judging, position) < 0
      )
        return true
    }
    for (const held of tree.holding.values()) {
      if (held.requestID !== selfID && compareStackOrder(held, position) < 0)
        return true
    }
    for (const job of tree.queue.values()) {
      if (
        job.request.id !== selfID &&
        compareStackOrder(positionOf(job.request), position) < 0
      )
        return true
    }
    return false
  }

  const finishJob = (
    tree: BatchTree,
    job: BatchJob,
    outcome: FinishedJobOutcome,
  ) => {
    controllers.delete(job.request.id)
    deps.onJobFinished(job.request)
    decided.add(job.request.id)
    trim(decided)
    if (outcome === "left" && !answered.has(job.request.id)) {
      tree.holding.set(job.request.id, positionOf(job.request))
    } else {
      // A parked release keeps its holding entry until the reply's fate is
      // known, so nothing below starts early.
      tree.holding.delete(job.request.id)
      treeKeys.delete(job.request.id)
    }
    job.settle()
  }

  const releaseParked = (tree: BatchTree) => {
    for (const [id, entry] of tree.parked) {
      if (unresolvedAncestry.size || blockedAbove(tree, entry.position, id))
        continue
      tree.parked.delete(id)
      entry.release(true)
    }
  }

  const pump = (key: string) => {
    if (stopped) return
    const tree = trees.get(key)
    if (!tree) return
    // Jobs settled or superseded while waiting leave without a model call.
    for (const [id, job] of tree.queue) {
      if (!job.controller.signal.aborted && !decided.has(id)) continue
      tree.queue.delete(id)
      finishJob(tree, job, answered.has(id) ? "resolved" : "left")
    }
    releaseParked(tree)
    // A prompt whose tree is unknown could sort above any prompt anywhere.
    if (unresolvedAncestry.size) {
      dropTreeIfEmpty(key, tree)
      return
    }
    const queued = [...tree.queue.values()].sort((a, b) =>
      compareStackOrder(positionOf(a.request), positionOf(b.request)),
    )
    if (!tree.active.size) {
      const top = queued[0]
      if (!top) {
        dropTreeIfEmpty(key, tree)
        return
      }
      for (const heldPosition of tree.holding.values()) {
        if (compareStackOrder(heldPosition, positionOf(top.request)) < 0) return
      }
      const nextBatch = batchKeyOf(top.request)
      if (tree.activeBatch !== nextBatch) {
        tree.activeBatch = nextBatch
        // A completion-driven pump can reach a queued batch without a fresh
        // ask. Refresh here too so a live parallel -> serial edit is observed
        // before that new batch fans out.
        if (!processingModeRead) {
          void refreshProcessingMode()
          return
        }
      }
    }
    for (const job of queued) {
      // Do not expand a batch while the mode value may be stale.
      if (
        tree.active.size &&
        (processingMode === "serial" || processingModeRead)
      )
        break
      if (batchKeyOf(job.request) !== tree.activeBatch) continue
      const position = positionOf(job.request)
      let held = false
      for (const heldPosition of tree.holding.values()) {
        if (compareStackOrder(heldPosition, position) < 0) {
          held = true
          break
        }
      }
      if (held) continue
      tree.queue.delete(job.request.id)
      tree.active.set(job.request.id, position)
      const running = runJob(key, tree, job)
      runningJobs.add(running)
      void running.then(
        () => runningJobs.delete(running),
        () => runningJobs.delete(running),
      )
    }
    dropTreeIfEmpty(key, tree)
  }

  const pumpAll = () => {
    for (const key of [...trees.keys()]) pump(key)
  }

  const finishProvisional = (requestID: string): PermissionAsk | undefined => {
    const entry = provisionalAncestry.get(requestID)
    if (!entry) return undefined
    provisionalAncestry.delete(requestID)
    controllers.delete(requestID)
    deps.onJobFinished(entry.request)
    if (removeAncestryBarrier(requestID)) pumpAll()
    return entry.request
  }

  const holdAfterAncestry = (
    request: PermissionAsk,
    key: string,
    unresolved: boolean,
  ) => {
    provisionalAncestry.delete(request.id)
    controllers.delete(request.id)
    decided.add(request.id)
    trim(decided)
    treeKeys.set(request.id, key)
    treeFor(key).holding.set(request.id, positionOf(request))
    deps.onJobFinished(request)
    if (!unresolved && removeAncestryBarrier(request.id)) pumpAll()
  }

  const awaitTopOfStack = (
    key: string,
    tree: BatchTree,
    job: BatchJob,
  ): boolean | Promise<boolean> => {
    const position = positionOf(job.request)
    if (
      !unresolvedAncestry.size &&
      !blockedAbove(tree, position, job.request.id)
    )
      return true
    deps.log(
      "info",
      `parking the approval of ${deps.headline(job.request)} beneath the undecided prompt stack`,
    )
    return new Promise<boolean>((resolve) => {
      const release = (proceed: boolean) => {
        job.controller.signal.removeEventListener("abort", onAbort)
        resolve(proceed)
      }
      const onAbort = () => {
        tree.parked.delete(job.request.id)
        release(false)
      }
      job.controller.signal.addEventListener("abort", onAbort, { once: true })
      tree.parked.set(job.request.id, { position, release })
      tree.holding.set(job.request.id, position)
      tree.active.delete(job.request.id)
      pump(key)
    })
  }

  const runJob = async (key: string, tree: BatchTree, job: BatchJob) => {
    let outcome: FinishedJobOutcome = "left"
    try {
      if (answered.has(job.request.id)) outcome = "resolved"
      else if (!job.controller.signal.aborted) {
        outcome = await deps.handle(job.request, job.controller, key, () =>
          awaitTopOfStack(key, tree, job),
        )
      }
    } catch (error) {
      deps.log(
        "error",
        `auto-approve failed for ${job.request.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      tree.active.delete(job.request.id)
      finishJob(tree, job, outcome)
      dropTreeIfEmpty(key, tree)
      pump(key)
    }
  }

  const refreshProcessingMode = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (processingModeRead) {
      // The in-flight read began before this ask. Run one more after it so a
      // live parallel -> serial edit cannot fan out this ask's batch using the
      // older snapshot. Many asks coalesce into the same follow-up read.
      processingModeRefreshPending = true
      return processingModeRead
    }
    processingModeRead = (async () => {
      let mode: ProcessingMode = "serial"
      do {
        processingModeRefreshPending = false
        try {
          mode = await Promise.resolve().then(() => deps.readProcessingMode())
        } catch {
          mode = "serial"
        }
      } while (processingModeRefreshPending)
      processingMode = mode
      // Re-pump even when unchanged: expansion may have waited for this read.
      processingModeRead = undefined
      pumpAll()
    })()
    return processingModeRead
  }

  const resolveRequest = (requestID: string, abort = false) => {
    decided.add(requestID)
    trim(decided)
    answered.add(requestID)
    trim(answered)
    if (abort)
      controllers
        .get(requestID)
        ?.abort(new Error("the request's session was deleted"))
    finishProvisional(requestID)
    const key = treeKeys.get(requestID)
    if (key) {
      const tree = trees.get(key)
      if (tree) {
        tree.holding.delete(requestID)
        const parked = tree.parked.get(requestID)
        if (parked) {
          tree.parked.delete(requestID)
          parked.release(false)
        }
        const queued = tree.queue.get(requestID)
        if (queued) {
          tree.queue.delete(requestID)
          controllers.delete(requestID)
          deps.onJobFinished(queued.request)
          queued.settle()
        }
        dropTreeIfEmpty(key, tree)
        pump(key)
      }
      if (!trees.get(key)?.active.has(requestID)) treeKeys.delete(requestID)
    }
    if (removeAncestryBarrier(requestID)) pumpAll()
  }

  const cancelSession = (sessionID: string): string[] => {
    const requestIDs = new Set<string>()
    for (const [id, entry] of provisionalAncestry) {
      if (entry.request.sessionID === sessionID) requestIDs.add(id)
    }
    for (const tree of trees.values()) {
      for (const [id, job] of tree.queue) {
        if (job.request.sessionID === sessionID) requestIDs.add(id)
      }
      for (const [id, position] of tree.holding) {
        if (position.sessionID === sessionID) requestIDs.add(id)
      }
      for (const [id, entry] of tree.parked) {
        if (entry.position.sessionID === sessionID) requestIDs.add(id)
      }
      for (const [id, position] of tree.active) {
        if (position.sessionID === sessionID) requestIDs.add(id)
      }
    }
    for (const requestID of requestIDs) resolveRequest(requestID, true)
    return [...requestIDs]
  }

  const dispose = async () => {
    stopped = true
    for (const requestID of [...controllers.keys()])
      resolveRequest(requestID, true)
    while (runningJobs.size) await Promise.allSettled([...runningJobs])
  }

  return {
    refreshProcessingMode,

    isDecided: (requestID: string) => decided.has(requestID),
    isAnswered: (requestID: string) => answered.has(requestID),
    treeKeyFor: (requestID: string) => treeKeys.get(requestID),

    /** Globally blocks release while this request's prompt tree is resolved. */
    beginAncestry: (
      request: PermissionAsk,
      controller: AbortController,
    ): boolean => {
      if (
        stopped ||
        controller.signal.aborted ||
        answered.has(request.id) ||
        decided.has(request.id) ||
        provisionalAncestry.has(request.id)
      )
        return false
      provisionalAncestry.set(request.id, { request, controller })
      controllers.set(request.id, controller)
      addAncestryBarrier(request.id)
      return true
    },

    /**
     * Atomically replaces a provisional ancestry barrier with an authoritative
     * queue position (or a fail-closed hold when the queue is full).
     */
    resolveAncestry: (
      request: PermissionAsk,
      key: string,
      controller: AbortController,
    ): AncestryResolution => {
      const provisional = provisionalAncestry.get(request.id)
      if (
        !provisional ||
        provisional.controller !== controller ||
        answered.has(request.id)
      )
        return { state: "cancelled" }
      if (controller.signal.aborted) {
        holdAfterAncestry(request, key, false)
        return { state: "held" }
      }
      provisionalAncestry.delete(request.id)
      treeKeys.set(request.id, key)
      const tree = treeFor(key)
      if (tree.queue.size + tree.active.size > deps.maxQueued) {
        holdAfterAncestry(request, key, false)
        return { state: "held" }
      }
      let settle!: () => void
      const settled = new Promise<void>((resolve) => {
        settle = resolve
      })
      tree.queue.set(request.id, { request, controller, settle })
      if (tree.active.size || tree.holding.size || tree.queue.size > 1) {
        deps.log(
          "info",
          `queueing ${deps.headline(request)} behind the prompt stack`,
        )
      }
      removeAncestryBarrier(request.id)
      pumpAll()
      return { state: "queued", settled }
    },

    /** Converts a provisional barrier into a durable unresolved prompt hold. */
    holdUnresolvedAncestry: (
      request: PermissionAsk,
      key: string,
      controller: AbortController,
    ): boolean => {
      const provisional = provisionalAncestry.get(request.id)
      if (
        !provisional ||
        provisional.controller !== controller ||
        answered.has(request.id)
      )
        return false
      holdAfterAncestry(request, key, true)
      return true
    },

    /** Resolves terminal work without assigning human-presence semantics. */
    resolveRequest,

    /** Records a host reply; caller separately decides whether it was human. */
    replied: resolveRequest,

    /** Cancels every scheduler-owned request from one deleted session. */
    cancelSession,

    /** Aborts queued and active work, then waits for every handler to stop. */
    dispose,

    /** True when the request is an active scheduler-owned batch-mate. */
    isManagedBatchMember: (requestID: string, key: string) => {
      const tree = trees.get(key)
      return (
        treeKeys.get(requestID) === key &&
        !!tree &&
        (tree.queue.has(requestID) ||
          tree.active.has(requestID) ||
          tree.parked.has(requestID))
      )
    },
  }
}

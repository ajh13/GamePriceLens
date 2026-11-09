import {
  ConnectedRunInbound,
  RENDEZVOUS_ARRIVED,
  CONNECTED_RUN_ABORTED,
  PARTICIPANT_RESULT,
} from "./ConnectedMessages"
import {ParticipantTransport} from "./ParticipantTransport"
import {Logger} from "Leaf.lspkg/Utils/common/Logger"

const LOG = new Logger("ParticipantAgent")

interface PendingRendezvous {
  resolve: () => void
  reject: (error: Error) => void
}

/**
 * The in-lens half of a ConnectedRun. It reaches Rendezvous points by sending a
 * `RendezvousArrived` and holding a promise until a matching `RendezvousRelease`
 * comes back from the plugin - never from a peer. One per lens
 * runtime, constructed by {@link MessagingBridge}; the scenario manager reaches
 * it through {@link requireInstance} and passes a run-scoped
 * {@link ParticipantContext} to each Scenario.
 */
export class ParticipantAgent {
  private static instance: ParticipantAgent | null = null

  private runId = ""
  private handle = ""
  /** Keep occurrence counters after release so repeated names cannot consume stale releases. */
  private readonly rendezvousByName = new Map<
    string,
    {nextSeq: number; pending: Map<number, PendingRendezvous>}
  >()
  /** The current run's abort signal; rejects in {@link abortRun}. */
  private abortSignal: {
    promise: Promise<never>
    reject: (error: Error) => void
  } | null = null
  /** The last orchestrator abort, so a late `rendezvous()` gets the real reason. */
  private lastAbort: {runId: string; reason: string} | null = null
  private epoch = ""
  private readonly retiredEpochs = new Set<string>()
  private readonly seenSequences = new Map<string, number>()

  constructor(private transport: ParticipantTransport) {
    this.transport.onMessage((message) => this.onInbound(message))
  }

  /** Install the process-wide agent (called once by the MessagingBridge). */
  static installInstance(agent: ParticipantAgent): void {
    this.instance = agent
  }

  /** @throws if no agent is installed - the LEAF bridge is not in the scene. */
  static requireInstance(): ParticipantAgent {
    if (!this.instance) {
      throw new Error(
        "LEAF ParticipantAgent not initialized. Is the LEAF messaging bridge present in the scene?",
      )
    }
    return this.instance
  }

  /** Admit a fresh run; duplicate, retired, and previously aborted starts are ignored. */
  beginRun(runId: string, handle: string): boolean {
    const {epoch, sequence} = this.identity(runId)
    if (!this.isFreshStart(runId)) return false
    this.seenSequences.set(epoch, sequence)
    this.rejectAllPending(new Error("A new ConnectedRun started."))
    /* Abort the previous body even when it is not waiting at a Rendezvous. */
    this.abortSignal?.reject(
      new Error(`ConnectedRun ${this.runId} was superseded by ${runId}.`),
    )
    this.runId = runId
    this.handle = handle
    this.rendezvousByName.clear()
    this.lastAbort = null
    let reject!: (error: Error) => void
    const promise = new Promise<never>((_, rej) => {
      reject = rej
    })
    /* Observe cancellation even when no caller is awaiting the abort signal. */
    promise.catch(() => {})
    this.abortSignal = {promise, reject}
    this.transport.beginRun?.(runId)
    return true
  }

  /** Commit coordinator ownership only after its run-start barrier releases. */
  confirmRun(runId: string): void {
    if (this.runId !== runId)
      throw new Error(`ConnectedRun ${runId} is no longer running.`)
    const {epoch} = this.identity(runId)
    if (this.epoch && this.epoch !== epoch) this.retiredEpochs.add(this.epoch)
    this.epoch = epoch
  }

  /** Whether a duplicate start refers to this participant's active run. */
  isCurrentRun(runId: string): boolean {
    return this.runId === runId
  }

  /** Whether a start is newer than this participant's admitted or aborted runs. */
  isFreshStart(runId: string): boolean {
    const {epoch, sequence} = this.identity(runId)
    return (
      !this.retiredEpochs.has(epoch) &&
      sequence > (this.seenSequences.get(epoch) ?? 0)
    )
  }

  /** Reserve a valid start's admission response without changing the active run. */
  prepareRun(runId: string): boolean {
    if (!this.isFreshStart(runId)) {
      LOG.warn(this.refusedStartReason(runId), false)
      return false
    }
    this.transport.prepareRun?.(runId)
    return true
  }

  /** Explain a refused replay, including how to recover from legacy ID reuse. */
  refusedStartReason(runId: string): string {
    if (this.identity(runId).epoch === runId) {
      return `ConnectedRun ${runId}: this legacy run ID was already used or aborted. Update the LEAF plugin to generate fresh epoch/sequence run IDs, then reset this lens before retrying.`
    }
    return `ConnectedRun ${runId}: stale or previously aborted start was ignored.`
  }

  /** Report a refused start without replacing the participant's current run. */
  reportRefusedStart(runId: string, handle: string, reason: string): void {
    const {epoch, sequence} = this.identity(runId)
    this.seenSequences.set(
      epoch,
      Math.max(sequence, this.seenSequences.get(epoch) ?? 0),
    )
    LOG.error(
      `ConnectedRun ${runId}: refused Participant ${handle} - ${reason}`,
      false,
    )
    try {
      this.transport.send({
        type: PARTICIPANT_RESULT,
        runId,
        participant: handle,
        status: "failed",
        detail: reason,
      })
    } catch (error) {
      LOG.error(
        `ConnectedRun ${runId}: could not report refusal - ${error}`,
        false,
      )
    }
  }

  /**
   * The current run's abort signal: never resolves; rejects when the run is
   * aborted or superseded. Captured by the manager at run start.
   * @throws outside a run.
   */
  currentAbortSignal(): Promise<never> {
    if (!this.abortSignal) {
      throw new Error("currentAbortSignal() was called outside a ConnectedRun.")
    }
    return this.abortSignal.promise
  }

  /**
   * Record the abort to reject delayed starts. If this is the current run,
   * reject its Rendezvous and abort signal, then suppress its later results.
   */
  abortRun(runId: string, reason: string): void {
    const {epoch, sequence} = this.identity(runId)
    this.seenSequences.set(
      epoch,
      Math.max(sequence, this.seenSequences.get(epoch) ?? 0),
    )
    if (this.runId !== runId) {
      LOG.debug(
        `Ignoring an abort for ConnectedRun ${runId}; current run is ${this.runId || "(none)"}.`,
        false,
      )
      return
    }
    const error = new Error(
      `ConnectedRun ${runId} was aborted by the orchestrator: ${reason}`,
    )
    LOG.warn(error.message, false)
    this.lastAbort = {runId, reason}
    this.rejectAllPending(error)
    this.abortSignal?.reject(error)
    this.abortSignal = null
    this.runId = ""
  }

  /**
   * End a run; any still-pending Rendezvous points reject. Scoped by `runId`:
   * if a newer run has already superseded this one (its Scenario is unwinding
   * after `beginRun` rejected its waits), this is a no-op so the stale run's
   * cleanup cannot reject the active run's pending Rendezvous.
   */
  endRun(runId: string): void {
    if (this.runId !== runId) {
      return
    }
    this.rejectAllPending(
      new Error("The ConnectedRun ended before the Rendezvous released."),
    )
    this.abortSignal = null
    this.runId = ""
  }

  /**
   * Reach a Rendezvous: announce arrival and hold until the plugin releases
   * everyone. Resolves on `status: "ok"`, rejects on `status: "error"`.
   * @param runId - The run the calling Scenario belongs to. A Scenario detached
   *   by an abort or superseded by a newer run keeps executing; scoping here is
   *   what stops it arriving on the wire on behalf of the run that replaced it.
   * @throws if `runId` is not the current run (aborted, superseded, or ended).
   */
  async rendezvous(name: string, runId: string): Promise<void> {
    if (this.runId !== runId) {
      if (this.lastAbort?.runId === runId) {
        throw new Error(
          `rendezvous("${name}"): ConnectedRun ${runId} was aborted by the orchestrator: ${this.lastAbort.reason}`,
        )
      }
      throw new Error(
        `rendezvous("${name}"): ConnectedRun ${runId} is not running${this.runId ? ` (current run is ${this.runId})` : ""}.`,
      )
    }
    let state = this.rendezvousByName.get(name)
    if (!state) {
      state = {nextSeq: 0, pending: new Map()}
      this.rendezvousByName.set(name, state)
    }
    const {pending} = state
    const seq = state.nextSeq++
    const promise = new Promise<void>((resolve, reject) => {
      pending.set(seq, {resolve, reject})
    })
    try {
      this.transport.send({
        type: RENDEZVOUS_ARRIVED,
        runId: this.runId,
        participant: this.handle,
        rendezvous: name,
        seq,
      })
    } catch (error) {
      /* An unsent arrival cannot be released; remove its waiter and surface the send failure. */
      pending.delete(seq)
      throw error instanceof Error ? error : new Error(String(error))
    }
    LOG.debug(
      `Arrived at Rendezvous "${name}" (seq ${seq}); awaiting release.`,
      false,
    )
    return promise
  }

  /**
   * Report this Participant's final outcome to the plugin, tagged with the
   * Handle so the orchestrator can attribute it. Sent by the
   * scenario manager when the Scenario resolves or throws. Scoped by
   * `runId` so a superseded run's outcome cannot be reported against the run
   * that replaced it.
   */
  reportResult(
    runId: string,
    status: "succeeded" | "failed",
    detail?: string,
  ): void {
    if (!this.runId || this.runId !== runId) {
      return
    }
    this.transport.send({
      type: PARTICIPANT_RESULT,
      runId: this.runId,
      participant: this.handle,
      status,
      detail,
    })
  }

  private identity(runId: string): {epoch: string; sequence: number} {
    const match = /^(.*)\/([1-9][0-9]*)$/.exec(runId)
    if (match && Number.isSafeInteger(Number(match[2]))) {
      return {epoch: match[1], sequence: Number(match[2])}
    }
    /* Opaque IDs from older plugins are single-run epochs. */
    return {epoch: runId, sequence: 1}
  }

  private onInbound(message: ConnectedRunInbound): void {
    if (message.type === CONNECTED_RUN_ABORTED) {
      this.abortRun(message.runId, message.reason)
      return
    }
    if (message.runId !== this.runId) {
      // Stale release from a prior run: ignore, but leave a trace.
      LOG.debug(
        `Ignoring a release for ConnectedRun ${message.runId}; current run is ${this.runId || "(none)"}.`,
        false,
      )
      return
    }
    const state = this.rendezvousByName.get(message.rendezvous)
    const pending = state?.pending.get(message.seq)
    if (!pending) {
      // Unknown or already-resolved Rendezvous; nothing to do.
      return
    }
    state?.pending.delete(message.seq)
    if (message.status === "ok") {
      pending.resolve()
    } else {
      pending.reject(
        new Error(
          message.reason ?? `Rendezvous "${message.rendezvous}" failed.`,
        ),
      )
    }
  }

  private rejectAllPending(error: Error): void {
    for (const state of this.rendezvousByName.values()) {
      for (const pending of state.pending.values()) pending.reject(error)
      state.pending.clear()
    }
  }
}

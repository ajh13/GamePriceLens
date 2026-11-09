import {
  ConnectedRunInbound,
  ConnectedRunOutbound,
  StepRelease,
  StepStop,
  RENDEZVOUS_ARRIVED,
  RENDEZVOUS_RELEASE,
  CONNECTED_RUN_ABORTED,
  PARTICIPANT_RESULT,
  LEAF_HANDLE_KEY,
  LEAF_RUN_ID_KEY,
} from "./ConnectedMessages"
import {Logger} from "Leaf.lspkg/Utils/common/Logger"

const LOG = new Logger("ParticipantTransport")

/**
 * The channel a {@link ParticipantAgent} uses to exchange ConnectedRun messages
 * with the plugin. The two legs differ sharply: the preview leg
 * pushes freely, while a device Participant can only reply inside an inbound
 * callback and is driven by the orchestrator's step requests. Both
 * satisfy this interface so the agent is leg-agnostic.
 */
export interface ParticipantTransport {
  /** A valid start is awaiting admission while the previous run finishes cleanup. */
  prepareRun?(runId: string): void
  /** Bind an admitted start, preserving any step already waiting for that run. */
  beginRun?(runId: string): void
  /** Register the (single) handler for inbound plugin messages (Rendezvous releases). */
  onMessage(handler: (message: ConnectedRunInbound) => void): void
  /** Send a message to the plugin. */
  send(message: ConnectedRunOutbound): void
}

/**
 * Report a ConnectedRun start the manager refused synchronously (not opted in,
 * unknown Ensemble or Role, missing bridge) as an attributed failure, so the
 * plugin sees the real reason at once instead of a run-start watchdog expiry
 * with a generic hint. Called by both message handlers from their start-request
 * catch blocks. A start with no run id or Handle cannot be attributed and is
 * left to the plugin's start-error handling.
 */
export function reportRefusedStart(
  transport: ParticipantTransport,
  config: Record<string, string> | undefined,
  error: unknown,
): void {
  const runId = config?.[LEAF_RUN_ID_KEY]
  const handle = config?.[LEAF_HANDLE_KEY]
  if (!runId || !handle) {
    // The plugin attributes results by Handle only; nothing else would match.
    return
  }
  try {
    transport.send({
      type: PARTICIPANT_RESULT,
      runId,
      participant: handle,
      status: "failed",
      detail: `Start refused: ${error instanceof Error ? error.message : String(error)}`,
    })
  } catch (sendError) {
    LOG.error(`Could not report the refused ConnectedRun start: ${sendError}`)
  }
}

/** The one thing the preview transport needs from the lens's plugin channel. */
export interface ConnectedRunSender {
  notify(message: ConnectedRunOutbound): void
}

/**
 * Preview-leg transport. Outbound rides the lens's one plugin channel (the same
 * broker the scenario handler publishes through); inbound Rendezvous releases
 * arrive on that channel too, and the {@link MessageScenarioHandler} dispatches
 * them into {@link deliver} - the same shape as the device leg, where
 * DeviceMessageReceiver drives {@link DeviceParticipantTransport}.
 */
export class PreviewParticipantTransport implements ParticipantTransport {
  private releaseHandler: ((message: ConnectedRunInbound) => void) | null = null

  constructor(private sender: ConnectedRunSender) {}

  onMessage(handler: (message: ConnectedRunInbound) => void): void {
    this.releaseHandler = handler
  }

  send(message: ConnectedRunOutbound): void {
    this.sender.notify(message)
  }

  /** Deliver an inbound release from the handler's channel into the agent. */
  deliver(message: ConnectedRunInbound): void {
    this.releaseHandler?.(message)
  }
}

/**
 * The device transport's one slot, as a state union so "a waiter and a buffered
 * stop at once" is unrepresentable. Every state is tagged with the run it
 * belongs to, so a stop or waiter left behind by a run that ended abnormally
 * (refused start, orchestrator abort, Scenario timing out long after) can be
 * recognised and discarded instead of being delivered to the next run.
 */
type StepSlot =
  | {kind: "idle"}
  | {kind: "awaiting"; runId: string; resolve: (stop: StepStop) => void}
  | {kind: "buffered"; runId: string; stop: StepStop}

/**
 * Device-leg transport. The device channel is reply-only, so this
 * cannot push an arrival or await an unsolicited release like the preview leg;
 * instead it adapts the {@link ParticipantAgent}'s push model to the
 * orchestrator's polling. The agent's outbound `send` becomes a *stop* the next
 * step reply reports; an inbound release is *applied* when a step request
 * delivers it. The {@link DeviceMessageReceiver} drives it via
 * {@link applyReleases} / {@link awaitNextStop}.
 *
 * One step request may wait at a time. A park remains readable until released
 * or replaced by a terminal result. Slots are scoped by runId.
 */
export class DeviceParticipantTransport implements ParticipantTransport {
  private releaseHandler: ((message: ConnectedRunInbound) => void) | null = null
  private slot: StepSlot = {kind: "idle"}
  private acceptedRunId: string | null = null
  private abortedStop?: {runId: string; stop: StepStop}
  private refusedStop?: {runId: string; stop: StepStop}
  private admission?: {runId: string; ready: Promise<void>; resolve: () => void}

  /** Hold early device steps until their start is admitted or refused. */
  prepareRun(runId: string): void {
    this.admission?.resolve()
    let resolve!: () => void
    const ready = new Promise<void>((done) => {
      resolve = done
    })
    this.admission = {runId, ready, resolve}
  }

  private finishAdmission(runId: string): void {
    if (this.admission?.runId !== runId) return
    this.admission.resolve()
    this.admission = undefined
  }

  /** Preserve this run's waiting step; discard prior slots and settle abandoned waiters. */
  beginRun(runId: string): void {
    if (this.slot.kind !== "awaiting" || this.slot.runId !== runId) {
      if (this.slot.kind === "awaiting") {
        this.slot.resolve({
          state: "done",
          status: "failed",
          detail: `superseded by ConnectedRun ${runId}`,
        })
      }
      this.slot = {kind: "idle"}
    }
    this.acceptedRunId = runId
    this.abortedStop = undefined
    this.refusedStop = undefined
    this.finishAdmission(runId)
  }

  onMessage(handler: (message: ConnectedRunInbound) => void): void {
    this.releaseHandler = handler
  }

  send(message: ConnectedRunOutbound): void {
    switch (message.type) {
      case RENDEZVOUS_ARRIVED:
        this.resolveStop(message.runId, {
          state: "parked",
          rendezvous: message.rendezvous,
          seq: message.seq,
        })
        break
      case PARTICIPANT_RESULT:
        /* Omit undefined fields because the native reply serializer emits them as invalid JSON. */
        this.resolveStop(
          message.runId,
          message.detail !== undefined
            ? {state: "done", status: message.status, detail: message.detail}
            : {state: "done", status: message.status},
        )
        break
    }
  }

  /**
   * Deliver an orchestrator abort into the agent (it ends the running Scenario)
   * and close this run's step. The dying Scenario produces no stop - the agent
   * has closed the run, so its report is a no-op - so a step waiting on this
   * run is answered here, or it would hang to the transport timeout; a stop it
   * had buffered is moot.
   */
  deliverAbort(runId: string, reason: string): void {
    if (
      this.acceptedRunId === runId ||
      this.admission?.runId === runId ||
      (this.slot.kind !== "idle" && this.slot.runId === runId) ||
      (this.acceptedRunId === null && !this.admission)
    ) {
      this.abortedStop = {
        runId,
        stop: {
          state: "done",
          status: "failed",
          detail: `aborted by the orchestrator: ${reason}`,
        },
      }
    }
    if (this.admission?.runId === runId) {
      this.refusedStop = {
        runId,
        stop: {
          state: "done",
          status: "failed",
          detail: `aborted by the orchestrator: ${reason}`,
        },
      }
      this.finishAdmission(runId)
    }
    if (!this.releaseHandler) {
      LOG.error(
        "deliverAbort: no agent is listening on this transport (bridge wiring error).",
      )
    }
    this.releaseHandler?.({type: CONNECTED_RUN_ABORTED, runId, reason})
    const slot = this.slot
    if (slot.kind === "awaiting" && slot.runId === runId) {
      this.slot = {kind: "idle"}
      slot.resolve({
        state: "done",
        status: "failed",
        detail: `aborted by the orchestrator: ${reason}`,
      })
    } else if (slot.kind === "buffered" && slot.runId === runId) {
      this.slot = {kind: "idle"}
    }
  }

  /** Deliver the orchestrator's releases into the suspended Scenario. */
  applyReleases(runId: string, releases: StepRelease[]): void {
    if (!this.releaseHandler) {
      LOG.error(
        "applyReleases: no agent is listening on this transport (bridge wiring error).",
      )
    }
    for (const release of releases) {
      const slot = this.slot
      if (
        slot.kind === "buffered" &&
        slot.runId === runId &&
        slot.stop.state === "parked" &&
        slot.stop.rendezvous === release.rendezvous &&
        slot.stop.seq === release.seq
      ) {
        this.slot = {kind: "idle"}
      }
      this.releaseHandler?.({
        type: RENDEZVOUS_RELEASE,
        runId,
        rendezvous: release.rendezvous,
        seq: release.seq,
        status: release.status,
        reason: release.reason,
      })
    }
  }

  /**
   * Read the current park, or wait until `runId`'s Scenario parks or finishes.
   * @throws if a step for the same run is already waiting (protocol violation).
   */
  awaitNextStop(runId: string): Promise<StepStop> {
    if (this.abortedStop?.runId === runId)
      return Promise.resolve(this.abortedStop.stop)
    if (this.admission?.runId === runId) {
      return this.admission.ready.then(() => this.awaitNextStop(runId))
    }
    if (this.refusedStop?.runId === runId) {
      const stop = this.refusedStop.stop
      this.refusedStop = undefined
      return Promise.resolve(stop)
    }
    if (this.acceptedRunId !== null && this.acceptedRunId !== runId) {
      return Promise.resolve({
        state: "done",
        status: "failed",
        detail: `ConnectedRun ${runId} is not the admitted run`,
      })
    }
    const slot = this.slot
    if (slot.kind === "awaiting") {
      if (slot.runId === runId) {
        throw new Error(
          `Step protocol violation: overlapping step requests for ConnectedRun ${runId}.`,
        )
      }
      /* Fail the abandoned waiter before accepting a step for another run. */
      LOG.warn(
        `Failing a stale step waiter for ConnectedRun ${slot.runId}; superseded by ${runId}.`,
      )
      slot.resolve({
        state: "done",
        status: "failed",
        detail: `superseded by ConnectedRun ${runId}`,
      })
      this.slot = {kind: "idle"}
    } else if (slot.kind === "buffered") {
      if (slot.runId === runId) {
        if (slot.stop.state === "done") this.slot = {kind: "idle"}
        return Promise.resolve(slot.stop)
      }
      LOG.warn(
        `Dropping a stale stop from ConnectedRun ${slot.runId} (${slot.stop.state}); current run is ${runId}.`,
      )
      this.slot = {kind: "idle"}
    }
    return new Promise<StepStop>((resolve) => {
      this.slot = {kind: "awaiting", runId, resolve}
    })
  }

  /** @throws if `runId` already has a buffered stop this step (protocol violation). */
  private resolveStop(runId: string, stop: StepStop): void {
    if (this.abortedStop?.runId === runId) return
    this.finishAdmission(runId)
    if (this.acceptedRunId !== null && this.acceptedRunId !== runId) {
      if (stop.state === "done" && stop.status === "failed")
        this.refusedStop = {runId, stop}
      return
    }
    const slot = this.slot
    if (slot.kind === "awaiting") {
      if (slot.runId !== runId) {
        /* Ignore stops from a superseded body that is still unwinding. */
        LOG.warn(
          `Dropping a stop from stale ConnectedRun ${runId} (${stop.state}); a step for ${slot.runId} is waiting.`,
        )
        return
      }
      this.slot =
        stop.state === "parked"
          ? {kind: "buffered", runId, stop}
          : {kind: "idle"}
      slot.resolve(stop)
      return
    }
    if (slot.kind === "buffered") {
      if (slot.runId === runId) {
        if (slot.stop.state === "parked" && stop.state === "done") {
          /* A terminal result replaces the park even if it was already read. */
          this.slot = {kind: "buffered", runId, stop}
          return
        }
        throw new Error(
          `Step protocol violation: ConnectedRun ${runId} produced two stops in one step (${slot.stop.state} then ${stop.state}).`,
        )
      }
      /* Only the current run may retain a buffered stop. */
      LOG.warn(
        `Replacing a stale buffered stop from ConnectedRun ${slot.runId} with one from ${runId}.`,
      )
    }
    // Parked before the next step arrived; hand it to the next awaitNextStop.
    this.slot = {kind: "buffered", runId, stop}
  }
}

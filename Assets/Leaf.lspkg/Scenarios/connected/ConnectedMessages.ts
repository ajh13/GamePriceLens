import type {EnsembleInfo} from "./EnsembleMetadata"

/** Config key carrying the Role the orchestrator assigned this Participant. */
export const LEAF_ROLE_KEY = "__leaf__role"
/** Config key carrying the stable Handle (e.g. "p1") for this Participant. */
export const LEAF_HANDLE_KEY = "__leaf__handle"
/** Run identity: coordinator nonce / positive decimal safe-integer sequence. Echoed unchanged. */
export const LEAF_RUN_ID_KEY = "__leaf__run_id"
/** Config key carrying the coordinator's run-start admission budget in milliseconds. */
export const LEAF_RUN_START_TIMEOUT_MS_KEY = "__leaf__run_start_timeout_ms"
/** Default admission budget in milliseconds when the coordinator does not provide a valid positive value. */
export const DEFAULT_RUN_START_TIMEOUT_MS = 15000

/** Whether the orchestrator marked a ConnectedRun start by supplying a Role. */
export function isConnectedRunStart(
  config: Record<string, string> | undefined,
): boolean {
  return config?.[LEAF_ROLE_KEY] !== undefined
}

/**
 * The implicit Rendezvous that holds Scenario bodies until every Participant
 * has been admitted.
 */
export const RUN_START_RENDEZVOUS = "__leaf__run_start__"

export const RENDEZVOUS_ARRIVED = "leaf.connected.rendezvousArrived"
export const RENDEZVOUS_RELEASE = "leaf.connected.rendezvousRelease"
/** Plugin -> Participant: the orchestrator aborted the run; stop now. Pushed to previews, sent as a request to the device. */
export const CONNECTED_RUN_ABORTED = "leaf.connected.runAborted"
export const PARTICIPANT_RESULT = "leaf.connected.participantResult"
export const ENSEMBLE_LIST_REQUEST = "leaf.connected.ensembleListRequest"
export const ENSEMBLE_LIST_RESPONSE = "leaf.connected.ensembleListResponse"
/**
 * Device steps carry releases and reply with a park or terminal result.
 * A park remains readable until released, so polling also collects failures
 * while the device waits for its peers.
 */
export const RENDEZVOUS_STEP_REQUEST = "leaf.connected.rendezvousStepRequest"
export const RENDEZVOUS_STEP_RESPONSE = "leaf.connected.rendezvousStepResponse"

/** Plugin -> lens: "what Ensembles do you declare?" (discovery, before any run). */
export interface EnsembleListRequestMessage {
  type: typeof ENSEMBLE_LIST_REQUEST
  /** Echoed token identifying the probed preview. */
  probeId?: string
}

/** Lens -> plugin: the declared Ensembles, for the plugin to display and bind. */
export interface EnsembleListResponseMessage {
  type: typeof ENSEMBLE_LIST_RESPONSE
  ensembles: EnsembleInfo[]
  /** Echo of the request's {@link EnsembleListRequestMessage.probeId}, if any. */
  probeId?: string
}

/** Participant -> plugin: "I have reached Rendezvous `rendezvous` (occurrence `seq`)." */
export interface RendezvousArrivedMessage {
  type: typeof RENDEZVOUS_ARRIVED
  runId: string
  participant: string
  rendezvous: string
  seq: number
}

/**
 * Participant -> plugin: this Participant's Scenario finished. Carries the
 * Handle so the orchestrator can attribute the outcome without relying on
 * preview-panel object identity.
 */
export interface ParticipantResultMessage {
  type: typeof PARTICIPANT_RESULT
  runId: string
  participant: string
  status: "succeeded" | "failed"
  detail?: string
}

/** Messages a Participant sends to the plugin. */
export type ConnectedRunOutbound =
  | RendezvousArrivedMessage
  | ParticipantResultMessage

/**
 * Plugin -> Participant: everyone reached `rendezvous` (occurrence `seq`), so
 * proceed. `status: "error"` aborts the pending wait with `reason` - e.g. a
 * peer's Scenario threw.
 */
export interface RendezvousReleaseMessage {
  type: typeof RENDEZVOUS_RELEASE
  runId: string
  rendezvous: string
  seq: number
  status: "ok" | "error"
  reason?: string
}

/**
 * Plugin -> Participant: cancel the run and its pending Rendezvous with this
 * reason. Sent as a request on the device leg; cancellation cannot stop
 * arbitrary external promises in the Scenario body.
 */
export interface RunAbortedMessage {
  type: typeof CONNECTED_RUN_ABORTED
  runId: string
  reason: string
}

/** Validate an orchestrator abort received from the transport. */
export function isRunAborted(message: unknown): message is RunAbortedMessage {
  return (
    isRecord(message) &&
    message.type === CONNECTED_RUN_ABORTED &&
    typeof message.runId === "string" &&
    message.runId.length > 0 &&
    typeof message.reason === "string"
  )
}

/** Messages a Participant receives from the plugin. */
export type ConnectedRunInbound = RendezvousReleaseMessage | RunAbortedMessage

/** One release the orchestrator hands a device Participant on a step. */
export interface StepRelease {
  rendezvous: string
  seq: number
  status: "ok" | "error"
  reason?: string
}

/**
 * Plugin -> device: apply releases and read the current park or completion.
 * An unreleased park may be polled repeatedly.
 */
export interface RendezvousStepRequest {
  type: typeof RENDEZVOUS_STEP_REQUEST
  runId: string
  releases: StepRelease[]
}

/** Where a device Participant's Scenario has stopped between steps. */
export type StepStop =
  | {state: "parked"; rendezvous: string; seq: number}
  | {state: "done"; status: "succeeded" | "failed"; detail?: string}

/** Device -> plugin: the current park or terminal result, attributed to its run. */
export type RendezvousStepResponse = {
  type: typeof RENDEZVOUS_STEP_RESPONSE
  runId: string
} & StepStop

/** Narrow an unknown inbound payload to a device step request. */
export function isRendezvousStepRequest(
  message: unknown,
): message is RendezvousStepRequest {
  return (
    isRecord(message) &&
    message.type === RENDEZVOUS_STEP_REQUEST &&
    typeof message.runId === "string" &&
    message.runId.length > 0 &&
    Array.isArray(message.releases) &&
    message.releases.every(isStepRelease)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isStepRelease(value: unknown): value is StepRelease {
  return (
    isRecord(value) &&
    typeof value.rendezvous === "string" &&
    value.rendezvous.length > 0 &&
    typeof value.seq === "number" &&
    Number.isSafeInteger(value.seq) &&
    value.seq >= 0 &&
    (value.status === "ok" || value.status === "error") &&
    (value.reason === undefined || typeof value.reason === "string")
  )
}

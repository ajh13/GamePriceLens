/** Where a Participant runs: a Lens Studio preview panel, or a device. */
export type ParticipantEnvironment = "preview" | "device"

/** The Participant identity supplied to a Scenario's run context. */
export interface ParticipantInfo {
  /** Stable run-assigned id, e.g. "p1". */
  readonly handle: string
  /** Assigned Role, e.g. "host"; independent of connected-lens host election. */
  readonly role: string
  readonly environment: ParticipantEnvironment
}

/** A Scenario's immutable identity and Rendezvous API for one ConnectedRun. */
export class ParticipantContext {
  readonly participant: ParticipantInfo
  /**
   * Wait until every Participant reaches this named Rendezvous.
   * Confirms peer progress, not replicated state; use waitUntil for networked state.
   * Rejects if this context's run was aborted, superseded, or ended.
   */
  readonly rendezvous: (name: string) => Promise<void>

  constructor(
    participant: ParticipantInfo,
    rendezvous: (name: string) => Promise<void>,
  ) {
    this.participant = Object.freeze({...participant})
    this.rendezvous = rendezvous
    Object.freeze(this)
  }
}

import {Singleton} from "InteractionKit.lspkg/Decorators/Singleton"
import Event, {PublicApi} from "InteractionKit.lspkg/Utils/Event"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import {FocusFrameParticipant, FocusFramePose, FocusFrameSource} from "./FocusFrameTypes"

const log = new NativeLogger("FocusFrameManager")

/**
 * FocusFrameManager
 *
 * Singleton that arbitrates focus-frame focus across the whole lens. It guarantees that
 * at most one {@link FocusFrameParticipant} is docked to the keyboard at a time, and
 * bridges the external {@link FocusFrameSource} (keyboard enabled/disabled, streamed
 * anchor pose, keyboard-drag signals) to whichever participant currently holds focus.
 *
 * Two independent axes drive the motion:
 *  1. Which participant is *designated* focused — set by `requestFocus` (typically from a
 *     text input entering edit mode). `requestFocus` enforces exclusivity: designating a
 *     new participant revokes the previous one.
 *  2. Whether the focus frame is *enabled* by the source, with a current anchor pose.
 *
 * A participant only docks (receives `onFocusGranted`) when both a designation exists and
 * the source reports an enabled anchor pose. Either condition dropping revokes the dock
 * (`onFocusRevoked`), so the participant returns to rest.
 *
 * This is deliberately independent of `TextInputComponentManager` (which arbitrates text
 * *edit* focus): a participant may be any element, not just a text input.
 */
@Singleton
export class FocusFrameManager {
  public static getInstance: () => FocusFrameManager

  private participants: Map<string, FocusFrameParticipant> = new Map()

  // The participant designated by requestFocus (intent to focus). Exclusivity operates
  // on this. Distinct from whether that participant is currently docked.
  private _focusedId: string | null = null

  // Whether the currently focused participant has been told to dock (onFocusGranted
  // called and not yet revoked). True only when a designation and an enabled anchor
  // pose coexist.
  private _docked: boolean = false

  // Source state.
  private _source: FocusFrameSource | null = null
  private _sourceUnsubscribes: (() => void)[] = []
  private _isEnabled: boolean = false
  private _latestAnchorPose: FocusFramePose | null = null
  private _isAnchorMoving: boolean = false

  private onFocusChangedEvent = new Event<FocusFrameParticipant | null>()
  /**
   * Fires when the designated focused participant changes (including to `null`). Useful
   * for observers/tests. Note this tracks *designation*, not the docked transition.
   */
  public readonly onFocusChanged: PublicApi<FocusFrameParticipant | null> = this.onFocusChangedEvent.publicApi()

  public constructor() {
    log.d("FocusFrameManager initialized")
  }

  // --- Registration -------------------------------------------------------------------

  /**
   * Registers a participant. Call during the participant's initialization. Registration
   * does not grant focus — call `requestFocus` for that.
   */
  public registerParticipant(participant: FocusFrameParticipant): void {
    if (this.participants.has(participant.focusFrameId)) {
      log.w(`Participant "${participant.focusFrameId}" is already registered`)
      return
    }
    this.participants.set(participant.focusFrameId, participant)
    log.d(`Registered participant: ${participant.focusFrameId} (${participant.getSceneObject().name})`)
  }

  /**
   * Unregisters a participant. If it currently holds focus, focus is released (and the
   * participant revoked) first. Call on teardown.
   */
  public unregisterParticipant(participant: FocusFrameParticipant): void {
    if (!this.participants.has(participant.focusFrameId)) {
      return
    }
    if (this._focusedId === participant.focusFrameId) {
      this.setFocused(null)
    }
    this.participants.delete(participant.focusFrameId)
    log.d(`Unregistered participant: ${participant.focusFrameId}`)
  }

  // --- Focus arbitration --------------------------------------------------------------

  /**
   * Designates `participant` as the focused one. If another participant is focused, it is
   * revoked first. If the focus frame is already enabled, the participant docks
   * immediately; otherwise it docks when the source next reports an enabled anchor pose.
   *
   * @returns true if the participant is registered and now designated, false otherwise.
   */
  public requestFocus(participant: FocusFrameParticipant): boolean {
    if (!this.participants.has(participant.focusFrameId)) {
      log.e(`Cannot request focus for unregistered participant: ${participant.focusFrameId}`)
      return false
    }
    if (this._focusedId === participant.focusFrameId) {
      return true
    }
    this.setFocused(participant.focusFrameId)
    return true
  }

  /**
   * Releases focus held by `participant` (if it is the focused one), returning it to rest.
   * No-op if the participant is not currently focused.
   */
  public releaseFocus(participant: FocusFrameParticipant): void {
    if (this._focusedId !== participant.focusFrameId) {
      return
    }
    this.setFocused(null)
  }

  private setFocused(id: string | null): void {
    if (this._focusedId === id) {
      return
    }
    const previous = this.focused
    // Publish the new designation before revoking, including when suspended. A release
    // from the previous participant's callback must not recursively revoke it again.
    this._focusedId = id
    this._docked = false
    previous?.onFocusRevoked()
    if (this._focusedId !== id) return
    const participant = id !== null ? (this.participants.get(id) ?? null) : null
    this.onFocusChangedEvent.invoke(participant)
    // Dock immediately if the source is already enabled.
    this.reconcile()
  }

  /**
   * Reconciles the docked state against the two axes (designation + enabled anchor pose).
   * Docks or revokes the focused participant as needed.
   */
  private reconcile(): void {
    const shouldDock = this._focusedId !== null && this._isEnabled && this._latestAnchorPose !== null
    if (shouldDock && !this._docked) {
      const participant = this.participants.get(this._focusedId!)
      if (participant) {
        // Flip the flag BEFORE the callback: onFocusGranted (via onFocusStart) may release
        // or destroy the participant and re-enter, which must see _docked = true so it can
        // revoke cleanly rather than leaving _docked stuck true with no focused participant.
        this._docked = true
        participant.onFocusGranted(this._latestAnchorPose)
      }
    } else if (!shouldDock && this._docked) {
      const participant = this._focusedId !== null ? this.participants.get(this._focusedId) : null
      this._docked = false
      participant?.onFocusRevoked(true)
    }
  }

  private get focused(): FocusFrameParticipant | null {
    return this._focusedId !== null ? (this.participants.get(this._focusedId) ?? null) : null
  }

  // --- Source wiring ------------------------------------------------------------------

  /**
   * Installs (or clears, with `null`) the external focus-frame source. The manager
   * unsubscribes from any previous source first. In production this is the runtime-backed
   * adapter; in tests it is a simulated source.
   */
  public setSource(source: FocusFrameSource | null): void {
    // Tear down the previous subscription.
    this._sourceUnsubscribes.forEach((unsub) => unsub())
    this._sourceUnsubscribes = []

    // A source change ends any active focus-frame state.
    this._isEnabled = false
    this._latestAnchorPose = null
    this._isAnchorMoving = false
    this.reconcile()

    this._source = source
    if (source === null) {
      log.d("Focus frame source cleared")
      return
    }

    this._sourceUnsubscribes.push(
      source.onFocusFrameEnabled.add((pose) => this.handleEnabled(pose)),
      source.onFocusFrameDisabled.add(() => this.handleDisabled()),
      source.onFocusFrameAnchorPoseUpdated.add((pose) => this.handlePoseUpdated(pose)),
      source.onFocusFrameAnchorMovementStarted.add(() => this.handleMovementStarted()),
      source.onFocusFrameAnchorMovementEnded.add(() => this.handleMovementEnded())
    )
    log.d("Focus frame source installed")
  }

  private handleEnabled(pose: FocusFramePose): void {
    this._isEnabled = true
    this._latestAnchorPose = pose
    this.reconcile()
  }

  private handleDisabled(): void {
    this._isEnabled = false
    this._latestAnchorPose = null
    this._isAnchorMoving = false
    // Leaving AR suspends docking, but the field may still be editing on Mobile.
    // The owner releases its designation when editing ends.
    this.reconcile()
  }

  private handlePoseUpdated(pose: FocusFramePose): void {
    this._latestAnchorPose = pose
    if (this._docked) {
      this.focused?.onAnchorPoseUpdated(pose)
    } else if (this._isEnabled) {
      // Enabled but not yet docked (e.g. enabled fired before a participant was focused,
      // or before a pose existed) — reconcile now that we have a pose. A pose update never
      // manufactures the enabled state on its own; only onFocusFrameEnabled does that.
      this.reconcile()
    }
  }

  private handleMovementStarted(): void {
    this._isAnchorMoving = true
    if (this._docked) {
      this.focused?.onAnchorMovementStarted()
    }
  }

  private handleMovementEnded(): void {
    this._isAnchorMoving = false
    if (this._docked) {
      this.focused?.onAnchorMovementEnded()
    }
  }

  // --- State getters ------------------------------------------------------------------

  /** The participant currently designated focused, if any. */
  public get focusedParticipant(): FocusFrameParticipant | null {
    return this.focused
  }

  /** Whether any participant is currently designated focused. */
  public get hasFocus(): boolean {
    return this._focusedId !== null
  }

  /** Whether the source currently reports the focus frame as enabled (keyboard open). */
  public get isEnabled(): boolean {
    return this._isEnabled
  }

  /** The most recent anchor pose reported by the source, or null. */
  public get latestAnchorPose(): FocusFramePose | null {
    return this._latestAnchorPose
  }

  /** The source currently installed, or null. Lets a would-be source avoid clobbering another. */
  public get currentSource(): FocusFrameSource | null {
    return this._source
  }

  /** Whether the user is currently dragging the keyboard. */
  public get isAnchorMoving(): boolean {
    return this._isAnchorMoving
  }

  /** Debug snapshot of the manager's state. */
  public getDebugInfo(): string {
    const names = Array.from(this.participants.values())
      .map((p) => `${p.focusFrameId} (${p.getSceneObject().name})`)
      .join(", ")
    return `focused=${this._focusedId ?? "none"}, docked=${this._docked}, enabled=${this._isEnabled}, registered=[${names}]`
  }
}

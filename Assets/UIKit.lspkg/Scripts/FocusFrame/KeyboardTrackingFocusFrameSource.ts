import {Singleton} from "InteractionKit.lspkg/Decorators/Singleton"
import Event from "InteractionKit.lspkg/Utils/Event"
import {FocusFrameManager} from "./FocusFrameManager"
import {FocusFramePose, FocusFrameSource} from "./FocusFrameTypes"

/**
 * Shape of the keyboard-tracking callbacks this source installs on the keyboard options it
 * owns. Typed locally; unrecognized callbacks are inert on runtimes that do not provide
 * keyboard tracking.
 */
interface KeyboardTrackingCallbacks {
  onKeyboardKindChanged?: (kind: unknown) => void
  // Invoked with three positional args: the pose position, rotation, and the suggested view
  // size (cm), NOT a single payload object.
  onTextInputPoseSuggestionChanged?: (position: vec3, rotation: quat, size: vec2) => void
  onVirtualKeyboardMoveStarted?: () => void
  onVirtualKeyboardMoveEnded?: () => void
}

/**
 * KeyboardTrackingFocusFrameSource
 *
 * Production {@link FocusFrameSource} backed by TextInputSystem keyboard tracking. UIKit
 * owns the text-editing session, so it uses the "owner" path: the tracking callbacks are
 * installed on the same `KeyboardOptions` that {@link SystemKeyboardModule} passes to
 * `requestKeyboard`. The runtime then streams the keyboard pose, already resolved into Lens
 * world space, to those callbacks.
 *
 * Mapping onto the FocusFrameSource contract:
 *  - Pose suggestions arrive only while the keyboard kind is AR. The first pose while AR
 *    raises `onFocusFrameEnabled`; subsequent poses raise `onFocusFrameAnchorPoseUpdated`.
 *  - Leaving AR, or the keyboard being dismissed, raises `onFocusFrameDisabled`.
 *  - Virtual-keyboard move start/end map straight through.
 *
 * Singleton: one instance is shared across all fields' KeyboardOptions and installed as the
 * manager's source, so whichever field's keyboard is currently open drives the focused
 * participant.
 */
@Singleton
export class KeyboardTrackingFocusFrameSource implements FocusFrameSource {
  public static getInstance: () => KeyboardTrackingFocusFrameSource

  private enabledEvent = new Event<FocusFramePose>()
  private disabledEvent = new Event<void>()
  private poseUpdatedEvent = new Event<FocusFramePose>()
  private movementStartedEvent = new Event<void>()
  private movementEndedEvent = new Event<void>()

  public readonly onFocusFrameEnabled = this.enabledEvent.publicApi()
  public readonly onFocusFrameDisabled = this.disabledEvent.publicApi()
  public readonly onFocusFrameAnchorPoseUpdated = this.poseUpdatedEvent.publicApi()
  public readonly onFocusFrameAnchorMovementStarted = this.movementStartedEvent.publicApi()
  public readonly onFocusFrameAnchorMovementEnded = this.movementEndedEvent.publicApi()

  private arActive: boolean = false
  private enabledEmitted: boolean = false
  // The KeyboardOptions of the session whose keyboard is currently requested. Each field
  // owns its own KeyboardOptions but they all feed this one singleton, so callbacks are
  // scoped to the active session: a stale callback from a previously-active options (e.g. a
  // delayed `None` during a field switch) is ignored so it can't clear the new session.
  private activeOptions: object | null = null

  /**
   * Installs the keyboard-tracking callbacks on a KeyboardOptions object and ensures this
   * source is registered with the FocusFrameManager. Safe to call for every field; a no-op if
   * the options are missing.
   * Callbacks only take effect while their options is the active session (see {@link activate}).
   */
  public attachTo(keyboardOptions: unknown): void {
    // `keyboardOptions` is typed unknown because callers pass the platform options object through.
    if (!keyboardOptions || typeof keyboardOptions !== "object") return
    const options = keyboardOptions as KeyboardTrackingCallbacks
    const isActive = () => this.activeOptions === options

    options.onKeyboardKindChanged = (kind: unknown) => {
      if (isActive()) this.handleKindChanged(kind)
    }
    options.onTextInputPoseSuggestionChanged = (position: vec3, rotation: quat, size: vec2) => {
      if (isActive()) this.handlePoseSuggestion(position, rotation, size)
    }
    options.onVirtualKeyboardMoveStarted = () => {
      if (isActive()) this.movementStartedEvent.invoke()
    }
    options.onVirtualKeyboardMoveEnded = () => {
      if (isActive()) this.movementEndedEvent.invoke()
    }

    // Install as the manager's source only when nothing else holds it. This avoids
    // clobbering a source set explicitly elsewhere (e.g. a test's SimulatedFocusFrameSource),
    // and — unlike a permanent latch — lets us re-install after the source is cleared.
    const manager = FocusFrameManager.getInstance()
    if (manager.currentSource === null) {
      manager.setSource(this)
    }
  }

  /**
   * Marks `keyboardOptions` as the active session — called by SystemKeyboardModule when it
   * requests the keyboard. Only this options' tracking callbacks are honored afterward, so a
   * late callback from a previously-active session can't clobber the new one. Resets the
   * per-session state; the new keyboard's first pose re-enables with a fresh anchor.
   */
  public activate(keyboardOptions: unknown): void {
    if (!keyboardOptions || typeof keyboardOptions !== "object") return
    this.activeOptions = keyboardOptions as object
    this.arActive = false
    this.enabledEmitted = false
  }

  private handleKindChanged(kind: unknown): void {
    if (this.isArKind(kind)) {
      // Do NOT dedupe repeated AR notifications: each one may signal a new keyboard
      // instance, which invalidates the previous pose. Re-arm so the next pose
      // suggestion re-enables with a fresh anchor rather than reusing a stale one.
      this.arActive = true
      this.enabledEmitted = false
    } else {
      // Left AR (KeyboardKind.None / physical / mobile): tear down the focus frame.
      this.arActive = false
      if (this.enabledEmitted) {
        this.enabledEmitted = false
        this.disabledEvent.invoke()
      }
    }
  }

  private handlePoseSuggestion(position: vec3, rotation: quat, size: vec2): void {
    if (!this.arActive) return
    // Position and rotation arrive already resolved into Lens world space. Carry the
    // suggested size so the follower uses the runtime's height instead of its own default.
    const pose: FocusFramePose = {position, rotation, suggestedSize: size}
    if (!this.enabledEmitted) {
      this.enabledEmitted = true
      this.enabledEvent.invoke(pose)
    } else {
      this.poseUpdatedEvent.invoke(pose)
    }
  }

  /**
   * Whether the reported keyboard kind is AR (the only kind that streams a pose).
   *
   * Instance method, not static: the `@Singleton` decorator replaces the class with a
   * wrapper that copies the prototype and `getInstance` but NOT own static methods, so a
   * static here would be undefined at runtime.
   */
  private isArKind(kind: unknown): boolean {
    // Guard the enum lookup: TextInputSystem.KeyboardKind may be absent in this build, and
    // reading an unknown property off the native namespace can throw.
    let arValue: unknown
    try {
      arValue = (TextInputSystem as unknown as {KeyboardKind?: {AR?: unknown}})?.KeyboardKind?.AR
    } catch {
      arValue = undefined
    }
    if (arValue !== undefined) return kind === arValue
    // Fallback while bindings are absent: accept a string/label form.
    return kind === "AR"
  }
}

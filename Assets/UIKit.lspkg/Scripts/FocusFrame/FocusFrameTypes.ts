import {PublicApi} from "InteractionKit.lspkg/Utils/Event"

/**
 * Focus Frame
 *
 * When the system keyboard opens for a text-editing session, the system computes a
 * "Focus Frame anchor" — a world-space pose (position + rotation) slightly above the
 * keyboard where the focused text input view should sit so the user can see what they
 * are typing. The anchor pose is streamed to the lens while the keyboard is open.
 *
 * This module defines the UIKit-side contract for that behavior. UIKit codes against
 * {@link FocusFrameSource} rather than any one binding, so a simulated source can stand in
 * for testing and an adapter can wrap a concrete runtime API without changes elsewhere.
 */

/**
 * A world-space target pose for the focused element: where it should move to, and how it
 * should be oriented. Rotation is applied as-is (the system owns the facing logic).
 */
export interface FocusFramePose {
  position: vec3
  rotation: quat
  /**
   * Optional keyboard-suggested view size in centimeters (x = width, y = height). When
   * present, the follower uses the suggested height as the docked height limit instead of
   * its own configured max. Supplied with the keyboard-tracking pose.
   */
  suggestedSize?: vec2
}

/**
 * The external producer of focus-frame signals for the current text-editing session.
 *
 * Exactly one source is installed on the {@link FocusFrameManager} at a time via
 * `setSource`. The manager subscribes to these events and drives the currently focused
 * {@link FocusFrameParticipant} accordingly.
 *
 * All events are exposed as {@link PublicApi} so the manager can subscribe without being
 * able to invoke them — the source owns invocation.
 */
export interface FocusFrameSource {
  /**
   * The focus frame became active. The payload is the initial anchor pose. In platform
   * terms this corresponds to the AR/surface keyboard being displayed for the session.
   */
  readonly onFocusFrameEnabled: PublicApi<FocusFramePose>

  /**
   * The focus frame is no longer active (keyboard hidden / switched away from AR). The
   * element returns to rest; its owner releases focus separately when editing ends.
   */
  readonly onFocusFrameDisabled: PublicApi<void>

  /**
   * The anchor pose changed. Emitted after the keyboard's pose is updated (LateUpdate).
   * Callback-driven, not a fixed cadence: delivery stops once the keyboard settles.
   */
  readonly onFocusFrameAnchorPoseUpdated: PublicApi<FocusFramePose>

  /**
   * The user began actively moving the keyboard. Exposed for consumers that want to
   * react (e.g. tint/hide); the default follow behavior keeps tracking through it.
   */
  readonly onFocusFrameAnchorMovementStarted: PublicApi<void>

  /**
   * The user stopped actively moving the keyboard.
   */
  readonly onFocusFrameAnchorMovementEnded: PublicApi<void>
}

/**
 * Something that can hold focus-frame focus — typically a {@link FocusFrameFollower}
 * attached to a text input, a Frame, or any element that should dock to the keyboard.
 *
 * Participants register with the {@link FocusFrameManager}. The manager guarantees that
 * at most one participant is focused at a time and calls these lifecycle hooks to drive
 * the docking motion. The participant owns its own target transform and motion; the
 * manager only arbitrates focus and forwards the source's signals.
 */
export interface FocusFrameParticipant {
  /**
   * Stable identifier, unique per participant instance. Used by the manager to track
   * which participant currently holds focus.
   */
  readonly focusFrameId: string

  /**
   * The scene object this participant is associated with. Used for debug/logging and to
   * detect teardown.
   */
  getSceneObject(): SceneObject

  /**
   * Focus was granted to this participant. Any previously focused participant has already
   * been revoked. `initialPose` is the current anchor pose if the focus frame is enabled,
   * or `null` if focus was requested before the source reported an enabled anchor.
   */
  onFocusGranted(initialPose: FocusFramePose | null): void

  /**
   * The anchor pose changed while this participant is focused.
   */
  onAnchorPoseUpdated(pose: FocusFramePose): void

  /**
   * Return to rest. When `suspended` is true, the source is unavailable but the participant
   * retains focus demand for the next AR pose. Otherwise, its focus has been released.
   */
  onFocusRevoked(suspended?: boolean): void

  /**
   * The user began actively moving the keyboard while this participant is focused.
   */
  onAnchorMovementStarted(): void

  /**
   * The user stopped actively moving the keyboard while this participant is focused.
   */
  onAnchorMovementEnded(): void
}

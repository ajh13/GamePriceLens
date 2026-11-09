import {NewtonianController} from "./NewtonianController"
import {DampedRotationController} from "./DampedRotationController"
import {JointPose} from "./Pose"

const WRIST_REST_DELAY_S = 1.0
const WRIST_REST_THRESHOLD_CM = 2.0
const WRIST_ROTATION_TAU_SECONDS = 0.08

/**
 * Body-part controller for the IK wrist. Owns the wrist's position physics
 * (via {@link NewtonianController} with rest-pose lifecycle) and rotation
 * smoothing (via {@link DampedRotationController}).
 *
 * Position is gated by an active/rest lifecycle: targets drive the wrist via
 * physics; clearing the target starts a delay before the wrist returns to its
 * rest pose. Rotation is always integrated — there is no "rotation at rest"
 * concept, so the smoothed rotation is always available.
 */
export class WristController {
  private readonly _position = new NewtonianController(vec3.zero())
  private readonly _rotation = new DampedRotationController(
    quat.quatIdentity(),
    WRIST_ROTATION_TAU_SECONDS,
  )
  private _positionTarget?: vec3
  private _rotationTarget = quat.quatIdentity()
  private _rotationInitialized = false
  private _restCountdown?: number
  private _positionActive = false

  /**
   * Latch partial position/rotation targets. Missing fields preserve the
   * prior latched value; passing `position: undefined` starts the
   * return-to-rest countdown for the position channel.
   *
   * @param target - Position / rotation fields to update.
   */
  setTarget(target: Partial<JointPose> = {}): void {
    if ("position" in target) {
      if (target.position !== undefined) {
        this._restCountdown = undefined
        this._positionTarget = target.position
      } else if (
        this._positionTarget !== undefined &&
        this._restCountdown === undefined
      ) {
        this._restCountdown = WRIST_REST_DELAY_S
      }
    }
    if (target.rotation !== undefined) {
      if (!this._rotationInitialized) {
        this._rotation.reset(target.rotation)
        this._rotationInitialized = true
      }
      this._rotationTarget = target.rotation
    }
  }

  /**
   * Integrate one frame. Rotation is always present in the returned pose;
   * position is present only while the wrist is actively reaching.
   *
   * @param restPosition    - Natural arm-at-side rest position; used as the
   *   steering target when no explicit position is set.
   * @param deltaTime       - Frame delta in seconds.
   * @param trackedPosition - Live tracked wrist position; used to seed
   *   physics when the position channel first activates.
   * @returns Smoothed wrist pose. `rotation` is always defined; `position`
   *   is defined only while reaching.
   */
  update(
    restPosition: vec3,
    deltaTime: number,
    trackedPosition: vec3,
  ): Partial<JointPose> {
    const rotation = this._rotation.update(this._rotationTarget, deltaTime)

    if (this._restCountdown !== undefined) {
      this._restCountdown -= deltaTime
      if (this._restCountdown <= 0) {
        this._positionTarget = undefined
        this._restCountdown = undefined
      }
    }

    if (!this._positionActive && this._positionTarget === undefined) {
      return {rotation}
    }

    if (!this._positionActive) {
      this._position.reset(trackedPosition)
      this._positionActive = true
    }

    const target = this._positionTarget ?? restPosition
    const position = this._position.update(target, deltaTime)

    if (
      this._positionTarget === undefined &&
      position.distance(restPosition) < WRIST_REST_THRESHOLD_CM
    ) {
      this._positionActive = false
      return {rotation}
    }

    return {position, rotation}
  }
}

import {NewtonianController} from "./NewtonianController"
import {ProportionalController} from "./ProportionalController"
import {JointPose} from "./Pose"
import {lookAtRotation, nearlyEqual} from "./MathUtils"

const HEAD_REST_THRESHOLD_CM = 1.0
const HEAD_REST_DELAY_S = 0.5

// Rotation physics constants (same approach as CameraController).
const ROTATION_SPEED_GAIN = 5 // s⁻¹: proportional gain on angle
const ROTATION_MAX_SPEED_RAD_PER_SEC = 3.0
const ROTATION_MAX_ACCELERATION_RAD_PER_SEC2 = 10

/**
 * Physics controller for the head end-effector.
 *
 * Position is driven by a {@link NewtonianController}.
 * Rotation uses a proportional velocity controller with {@link quat.slerp},
 * mirroring the approach used in CameraController — smooth turn physics
 * with a configurable look-at target.
 *
 * Use {@link setTarget} to rotate the head toward a world-space position.
 */
export class HeadController {
  private readonly _positionController = new NewtonianController(vec3.zero())
  private readonly _rotationController = new ProportionalController(
    ROTATION_SPEED_GAIN,
    ROTATION_MAX_SPEED_RAD_PER_SEC,
    ROTATION_MAX_ACCELERATION_RAD_PER_SEC2,
  )
  private _positionTarget?: vec3
  private _lookAtTarget?: vec3
  private _restCountdown?: number
  private _positioning = false

  private _rotation?: quat

  /**
   * Set head targets.
   *
   * - When at least one argument is defined, the corresponding target is updated
   *   immediately and any pending rest countdown is cancelled.
   * - When both are `undefined`, a brief rest delay ({@link HEAD_REST_DELAY_S})
   *   starts before the head returns to the tracked pose — matching the behaviour
   *   of {@link WristController}.
   *
   * @param lookAt   - World-space point to rotate toward.
   * @param position - World-space position to move to.
   */
  setTarget(lookAt?: vec3, position?: vec3): void {
    if (lookAt !== undefined || position !== undefined) {
      this._restCountdown = undefined
      this._lookAtTarget = lookAt
      this._positionTarget = position
      if (lookAt === undefined) {
        this._rotationController.reset()
      }
    } else if (
      (this._lookAtTarget !== undefined || this._positionTarget !== undefined) &&
      this._restCountdown === undefined
    ) {
      this._restCountdown = HEAD_REST_DELAY_S
    }
  }

  /**
   * Integrate one frame of head physics.
   *
   * @param deltaTime   - Frame delta in seconds.
   * @param trackedHead - Live head pose; used as the rest pose and to seed the
   *   position controller when it first activates.
   * @returns Updated head pose, or `undefined` when fully at rest.
   */
  update(
    deltaTime: number,
    trackedHead: JointPose,
  ): JointPose | undefined {
    if (this._restCountdown !== undefined) {
      this._restCountdown -= deltaTime
      if (this._restCountdown <= 0) {
        this._lookAtTarget = undefined
        this._positionTarget = undefined
        this._restCountdown = undefined
      }
    }

    const position = this.updatePosition(trackedHead, deltaTime)
    this.updateRotation(trackedHead, position, deltaTime)

    if (!this._positioning && this._rotation === undefined) {
      return undefined
    }

    return {position, rotation: this._rotation ?? trackedHead.rotation}
  }

  private updatePosition(trackedHead: JointPose, deltaTime: number): vec3 {
    if (!this._positioning && this._positionTarget === undefined) {
      return trackedHead.position
    }

    if (!this._positioning) {
      this._positionController.reset(trackedHead.position)
      this._positioning = true
    }

    const targetPosition = this._positionTarget ?? trackedHead.position
    const position = this._positionController.update(targetPosition, deltaTime)

    if (
      this._positionTarget === undefined &&
      position.distance(trackedHead.position) < HEAD_REST_THRESHOLD_CM
    ) {
      this._positioning = false
      return trackedHead.position
    }

    return position
  }

  private updateRotation(trackedHead: JointPose, position: vec3, deltaTime: number): void {
    const targetRotation =
      this._lookAtTarget !== undefined
        ? lookAtRotation(this._lookAtTarget, position)
        : trackedHead.rotation

    if (this._rotation === undefined) {
      this._rotation = trackedHead.rotation
    }

    const angle = quat.angleBetween(this._rotation, targetRotation)
    const slerpFraction = this._rotationController.update(angle, deltaTime)
    this._rotation = quat.slerp(this._rotation, targetRotation, slerpFraction)

    if (
      this._lookAtTarget === undefined &&
      nearlyEqual(quat.angleBetween(this._rotation, trackedHead.rotation), 0)
    ) {
      this._rotation = undefined
    }
  }
}

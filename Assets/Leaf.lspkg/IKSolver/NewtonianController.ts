import {MotionController} from "./MotionController"
import {nearlyEqual} from "./MathUtils"

// Terminal velocity = MAX_ACCEL_CM_PER_S2 / DRAG_PER_S = 500 / 5 = 100 cm/s at full extension.
const DRIVE_GAIN_PER_S2 = 10 // s⁻²:   acceleration per cm of distance to target
const MAX_ACCEL_CM_PER_S2 = 500 // cm/s²: drive force cap
const DRAG_PER_S = 5 // s⁻¹:   velocity decay rate
/** Sub-step cap. Keeps semi-implicit Euler stable while letting one update() call eat a long wall-clock frame in multiple stable substeps. */
const MAX_STEP_SECONDS = 1 / 30

/**
 * Newtonian particle controller: integrates acceleration → velocity → position.
 *
 * A proportional drive force steers toward the target; a drag force damps
 * velocity so the particle settles without oscillating.
 *
 * ```
 * acceleration = clamp(dist × DRIVE_GAIN_PER_S2, MAX_ACCEL_CM_PER_S2) × dir  −  velocity × DRAG_PER_S
 * velocity    += acceleration × dt
 * position    += velocity    × dt
 * ```
 *
 * Terminal velocity at a given distance: `dist × DRIVE_GAIN_PER_S2 / DRAG_PER_S`.
 * At 50 cm that is 100 cm/s; the arm naturally decelerates as it arrives.
 */
export class NewtonianController extends MotionController {
  private _velocity: vec3 = vec3.zero()

  /** @returns Current velocity in cm/s. */
  get velocity(): vec3 {
    return this._velocity
  }

  constructor(initialPosition: vec3) {
    super(initialPosition)
  }

  /**
   * @param target    - Desired world-space position.
   * @param deltaTime - Frame delta in seconds.
   * @returns Updated position after integrating one frame of physics.
   */
  override update(target: vec3, deltaTime: number): vec3 {
    /** Sub-step semi-implicit Euler so a long frame (e.g. low LS preview FPS or a stalled tick) still produces full-speed traversal. Without sub-stepping, the caller-side clamp on `deltaTime` would throttle physics to ~30% real-time when frames are slow — the wrist would crawl toward the target and the convergence loop would time out before the wrist arrives. Step size kept ≤ {@link MAX_STEP_SECONDS} for numeric stability (the proportional drive + drag is stiff at high dt). */
    let remaining = deltaTime
    while (remaining > 0) {
      const step = Math.min(remaining, MAX_STEP_SECONDS)
      const toTarget = target.sub(this._position)
      const dist = toTarget.length
      const drive = nearlyEqual(dist, 0)
        ? vec3.zero()
        : toTarget
            .normalize()
            .uniformScale(
              Math.min(dist * DRIVE_GAIN_PER_S2, MAX_ACCEL_CM_PER_S2),
            )
      const drag = this._velocity.uniformScale(DRAG_PER_S)
      this._velocity = this._velocity.add(drive.sub(drag).uniformScale(step))
      this._position = this._position.add(this._velocity.uniformScale(step))
      remaining -= step
    }
    return this._position
  }

  /**
   * @param position - Starting position; velocity is reset to zero.
   */
  override reset(position: vec3): void {
    this._position = position
    this._velocity = vec3.zero()
  }
}

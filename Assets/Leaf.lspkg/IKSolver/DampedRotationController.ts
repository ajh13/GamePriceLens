import {Controller} from "./Controller"

/**
 * Frame-rate-independent damped-rotation controller. Each {@link update}
 * blends the current rotation toward `target` via exponential decay
 * `1 − exp(−dt / tau)`; after ~5τ the current is within ~1% of the target.
 */
export class DampedRotationController implements Controller<quat> {
  private _current: quat

  /**
   * @param initial - Starting rotation.
   * @param _tau    - Time constant in seconds. Smaller = faster convergence.
   */
  constructor(
    initial: quat,
    private readonly _tau: number,
  ) {
    this._current = initial
  }

  /**
   * Integrate one frame toward `target`.
   *
   * @param target    - Desired rotation this frame.
   * @param deltaTime - Frame delta in seconds.
   * @returns Updated rotation.
   */
  update(target: quat, deltaTime: number): quat {
    const blend = 1 - Math.exp(-deltaTime / this._tau)
    this._current = quat.slerp(this._current, target, blend)
    return this._current
  }

  /**
   * Snap the current rotation to `rotation` — useful at initialization or
   * after teleports.
   *
   * @param rotation - Rotation to anchor the controller to.
   */
  reset(rotation: quat): void {
    this._current = rotation
  }
}

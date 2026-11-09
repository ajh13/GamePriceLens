const REST_THRESHOLD = 0.001

/**
 * Proportional scalar controller with acceleration clamping.
 *
 * Given a remaining displacement magnitude, computes a step fraction [0, 1]
 * that advances a value toward its target at proportional speed, with a
 * max-acceleration guard so motion ramps up and down smoothly.
 *
 * The caller supplies the magnitude on each frame and applies the returned
 * fraction (e.g. as a slerp parameter) to advance the controlled value.
 */
export class ProportionalController {
  private _velocity = 0

  constructor(
    private readonly _speedGain: number,
    private readonly _maxSpeed: number,
    private readonly _maxAcceleration: number,
  ) {}

  /**
   * Advance one frame.
   *
   * @param magnitude - Remaining displacement magnitude (always ≥ 0).
   * @param deltaTime - Frame delta in seconds.
   * @returns Step fraction in [0, 1] to apply via lerp/slerp.
   */
  update(magnitude: number, deltaTime: number): number {
    if (magnitude <= REST_THRESHOLD || deltaTime <= 0) {
      this._velocity = 0
      return 1
    }
    const desiredSpeed = Math.min(magnitude * this._speedGain, this._maxSpeed)
    const deltaVelocity = desiredSpeed - this._velocity
    const maxDeltaVelocity = this._maxAcceleration * deltaTime
    this._velocity =
      Math.abs(deltaVelocity) > maxDeltaVelocity
        ? this._velocity + Math.sign(deltaVelocity) * maxDeltaVelocity
        : desiredSpeed
    return Math.min((this._velocity * deltaTime) / magnitude, 1)
  }

  /** Resets velocity to zero. Call when a new interaction begins or the target is cleared. */
  reset(): void {
    this._velocity = 0
  }
}

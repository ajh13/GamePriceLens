import {Controller} from "./Controller"

/**
 * Base class for physics-based position controllers. Concrete subclasses
 * (e.g. {@link NewtonianController}) implement the integration policy.
 */
export abstract class MotionController implements Controller<vec3> {
  protected _position: vec3

  constructor(initialPosition: vec3) {
    this._position = initialPosition
  }

  /** @returns Current position. */
  get position(): vec3 {
    return this._position
  }

  /**
   * Integrate one frame toward `target`.
   *
   * @param target    - Desired position this frame.
   * @param deltaTime - Frame delta in seconds.
   * @returns Updated position.
   */
  abstract update(target: vec3, deltaTime: number): vec3

  /**
   * Snap state to `position` (teleport / re-anchor). Subclasses should also
   * clear any derived state (e.g. velocity).
   *
   * @param position - Position to anchor the controller to.
   */
  abstract reset(position: vec3): void
}

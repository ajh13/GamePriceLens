/**
 * Single-target controller contract.
 *
 * Each frame the caller invokes {@link update} with the desired `target`
 * value; the controller integrates one frame of its internal dynamics and
 * returns the new value. {@link reset} re-anchors the controlled state
 * (e.g. on teleport or when a new interaction begins).
 */
export interface Controller<T> {
  /**
   * Integrate one frame toward `target`.
   *
   * @param target    - Desired value this frame.
   * @param deltaTime - Frame delta in seconds.
   * @returns Updated value.
   */
  update(target: T, deltaTime: number): T

  /**
   * Snap state to `value`. Use after teleports or when starting a new
   * interaction so the next {@link update} integrates from a known anchor.
   */
  reset(value: T): void
}

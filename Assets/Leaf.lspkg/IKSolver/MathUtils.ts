const DEFAULT_EPSILON = 0.001

/** @returns True if `a` and `b` are within `epsilon` of each other. */
export function nearlyEqual(
  a: number,
  b: number,
  epsilon: number = DEFAULT_EPSILON,
): boolean {
  return Math.abs(a - b) < epsilon
}

/**
 * Returns the rotation that faces `from` toward `to`, keeping world-up as up.
 * Returns a forward-facing rotation when `from` and `to` are coincident.
 */
export function lookAtRotation(from: vec3, to: vec3): quat {
  const forward = to.sub(from)
  const dist = forward.length
  if (nearlyEqual(dist, 0)) return quat.lookAt(vec3.forward(), vec3.up())
  return quat.lookAt(forward.uniformScale(1 / dist), vec3.up())
}

/**
 * Normalize `vector` if its length is meaningfully non-zero.
 *
 * @param vector - The vector to normalize.
 * @param epsilon - Lengths at or below this are treated as zero.
 * @returns The unit-length vector, or `undefined` when `vector` is
 *   degenerate (near-zero length).
 */
export function safeNormalize(
  vector: vec3,
  epsilon: number = DEFAULT_EPSILON,
): vec3 | undefined {
  const length = vector.length
  return length > epsilon ? vector.uniformScale(1 / length) : undefined
}

/**
 * Analytical closed-form 2-bone IK solver.
 *
 * Computes the mid-joint (elbow or knee) world position given:
 *   - A fixed root joint (shoulder or hip)
 *   - A desired end-effector position (wrist or ankle)
 *   - The lengths of the two bones
 *   - A pole vector hinting which half-plane the mid-joint bends toward
 *
 * ## Algorithm
 *
 * 1. Use the **law of cosines** to find the angle at the root joint:
 *      cos(A) = (a² + d² − b²) / (2·a·d)
 *    where a = upperLength, b = lowerLength, d = distance(root, endEffector).
 *
 * 2. Project the pole vector perpendicular to the root→endEffector axis
 *    to obtain the bend-plane normal. This avoids the IK flip problem
 *    that occurs when the limb passes through the pole vector axis.
 *
 * 3. Place the mid-joint at:
 *      axisPoint + perpendicularDirection · (a · sin(A))
 *    where axisPoint = root + direction · (a · cos(A)).
 *
 * ## Edge cases
 *
 * - **Target at root (d ≈ 0)**: mid-joint placed along the pole vector.
 * - **Fully extended (d ≥ a + b)**: mid-joint lies on the root→target line
 *   at distance `a` from the root. The chain stretches fully but does not
 *   over-extend.
 * - **Pole vector parallel to limb axis**: a fallback perpendicular is
 *   computed automatically.
 *
 * @module Solve2Bone
 */

/** Below this magnitude (cm) we treat a vector as effectively zero. */
const MIN_VECTOR_LENGTH = 0.001
/**
 * Above this absolute component magnitude, the limb axis is considered too
 * aligned with a coordinate axis to use it as a cross-product partner — pick
 * a different axis to avoid a degenerate cross product.
 */
const AXIS_ALIGNMENT_THRESHOLD = 0.9

/**
 * Compute the world-space position of the mid-joint (elbow or knee) for a
 * 2-bone IK chain.
 *
 * @param root        - Root joint world position (shoulder or hip).
 * @param endEffector - Desired end-effector world position (wrist or ankle).
 *                      Should already be clamped to arm/leg reach by the caller.
 * @param upperLength - Length of the first bone (upper arm or thigh), in cm.
 * @param lowerLength - Length of the second bone (forearm or shin), in cm.
 * @param poleVector  - World-space hint direction for the mid-joint bend.
 *                      For elbows: world-down, body-back, or tracked elbow hint.
 *                      For knees: body-forward.
 *                      Does not need to be normalized.
 * @returns World-space position of the mid-joint.
 */
export function solve2Bone(
  root: vec3,
  endEffector: vec3,
  upperLength: number,
  lowerLength: number,
  poleVector: vec3,
): vec3 {
  const toTarget = endEffector.sub(root)
  const targetDistance = toTarget.length

  if (targetDistance < MIN_VECTOR_LENGTH) {
    const pole = normalizeSafe(poleVector, vec3.down())
    return root.add(pole.uniformScale(upperLength))
  }

  const direction = toTarget.normalize()

  if (targetDistance >= upperLength + lowerLength) {
    return root.add(direction.uniformScale(upperLength))
  }

  /**
   * Law of cosines for the angle at the root joint:
   *   cos(A) = (upperLength² + d² − lowerLength²) / (2 · upperLength · d)
   *
   * Clamp to [-1, 1]: if the wrist sits closer to the shoulder than
   * |upperLength − lowerLength|, the triangle inequality is violated and
   * the raw expression overshoots ±1. Without the clamp, the elbow gets
   * catapulted hundreds of cm by `upperLength · cosine` below.
   */
  const rawCosine =
    (upperLength * upperLength +
      targetDistance * targetDistance -
      lowerLength * lowerLength) /
    (2 * upperLength * targetDistance)
  const rootCosine = Math.max(-1, Math.min(1, rawCosine))
  const rootSine = Math.sqrt(Math.max(0, 1 - rootCosine * rootCosine))

  const axisPoint = root.add(direction.uniformScale(upperLength * rootCosine))

  const pole = normalizeSafe(poleVector, vec3.down())
  const perpendicularDirection = projectPerpendicular(pole, direction)

  return axisPoint.add(
    perpendicularDirection.uniformScale(upperLength * rootSine),
  )
}

/**
 * If `vector` is nearly parallel to `axis` the projection collapses to zero;
 * fall back to {@link fallbackPerpendicular} so callers always get a valid
 * unit vector.
 */
function projectPerpendicular(vector: vec3, axis: vec3): vec3 {
  const projection = vector.sub(axis.uniformScale(vector.dot(axis)))
  const projectionLength = projection.length
  if (projectionLength > MIN_VECTOR_LENGTH) {
    return projection.uniformScale(1 / projectionLength)
  }
  return fallbackPerpendicular(axis)
}

/**
 * Cross with world-right when the limb isn't too aligned with the X axis,
 * otherwise cross with world-up — avoids a near-zero cross product when the
 * limb is parallel to the first candidate.
 */
function fallbackPerpendicular(direction: vec3): vec3 {
  const candidate =
    Math.abs(direction.x) < AXIS_ALIGNMENT_THRESHOLD ? vec3.right() : vec3.up()
  return direction.cross(candidate).normalize()
}

/** Normalize `vector`, returning `fallback` if `vector` is near-zero. */
function normalizeSafe(vector: vec3, fallback: vec3): vec3 {
  return vector.length > MIN_VECTOR_LENGTH ? vector.normalize() : fallback
}

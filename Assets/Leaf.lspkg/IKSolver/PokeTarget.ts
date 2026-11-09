export type IndexFingerKeypoints = {
  tipPosition: vec3
  upperJointPosition: vec3
  fingerDirection: vec3
  tipUp: vec3
  wristPosition: vec3
}

const FORWARD_FALLBACK = new vec3(0, 0, -1)

function safeNormalize(vector: vec3): vec3 {
  const length = vector.length
  return length > 0.001 ? vector.uniformScale(1 / length) : FORWARD_FALLBACK
}

/**
 * Computes the spherecast endpoint for a poke interaction.
 *
 * When a target position is provided, the endpoint is aimed toward it and
 * extended by spherecastRadius so the sphere sweeps through the collider surface.
 * Without a target, the endpoint follows the natural finger axis.
 *
 * @param fingerKeypoints       - Current index finger geometry.
 * @param spherecastRadius - Radius of the spherecast in cm.
 * @param targetPosition   - World-space target to aim toward, or `undefined` to use the finger axis.
 * @returns World-space spherecast endpoint.
 */
export function computePokeEndPoint(
  fingerKeypoints: IndexFingerKeypoints,
  spherecastRadius: number,
  targetPosition?: vec3,
): vec3 {
  const direction =
    targetPosition !== undefined
      ? safeNormalize(targetPosition.sub(fingerKeypoints.tipPosition))
      : safeNormalize(fingerKeypoints.tipPosition.sub(fingerKeypoints.upperJointPosition))
  return fingerKeypoints.tipPosition.add(direction.uniformScale(spherecastRadius))
}

/**
 * Computes the arm wrist target that places the index tip at the position where
 * the spherecast endpoint will land on targetPosition.
 *
 * Inverse of the PhysicalInteractionProvider endpoint formula:
 *   endpoint = tipPosition - tipUp * upOffset + fingerDirection * (spherecastRadius - forwardOffset)
 * So:
 *   tipPosition = targetPosition - tipUp * upOffset + fingerDirection * (spherecastRadius - forwardOffset)
 *
 * The wrist target is offset from tipPosition by the current wrist-to-tip delta so
 * ArmModel drives the wrist to the right place.
 *
 * @param targetPosition   - World-space position of the poke target.
 * @param fingerKeypoints       - Current index finger geometry.
 * @param spherecastRadius - Radius of the spherecast in cm.
 * @param forwardOffset    - Forward offset applied by PhysicalInteractionProvider.
 * @param upOffset         - Upward offset applied by PhysicalInteractionProvider.
 * @returns World-space wrist target for ArmModel.
 */
export function computePokeArmTarget(
  targetPosition: vec3,
  fingerKeypoints: IndexFingerKeypoints,
  spherecastRadius: number,
  forwardOffset: number,
  upOffset: number,
): vec3 {
  const pokeTarget = targetPosition
    .sub(fingerKeypoints.tipUp.uniformScale(upOffset))
    .add(fingerKeypoints.fingerDirection.uniformScale(spherecastRadius - forwardOffset))

  const wristToTipOffset = fingerKeypoints.tipPosition.sub(fingerKeypoints.wristPosition)
  return pokeTarget.sub(wristToTipOffset)
}

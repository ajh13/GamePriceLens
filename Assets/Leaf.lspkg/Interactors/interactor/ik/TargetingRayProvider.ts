import {BodyAnchors} from "Leaf.lspkg/IKSolver/ArmModel"

/**
 * Targeting-ray constants — mirror TargetingRayPipeline.cpp.
 * These describe the geometry of the simulated arm/head linkage used to
 * project a stable ray from the user's hand pose, and are not tunable.
 */
/** Cervical anchor offset from the head, forward axis (cm). */
const CERVICAL_FORWARD_CM = 8
/** Cervical anchor offset from the head, down axis (cm). */
const CERVICAL_DOWN_CM = 15
/** Locus is the cast anchor placed past the wrist along the forearm (cm). */
const LOCUS_OFFSET_CM = 5
/** Amplifies the forearm contribution in the raw ray direction. */
const WRIST_AMPLIFICATION = 6.5
/** Pitch the ray up by this many degrees (ergonomic bias). */
const PITCH_UP_DEG = 2
/** Yaw the ray outward (away from body midline) by this many degrees. */
const YAW_OUT_DEG = 3
/** Below this vector length we treat magnitudes as zero (cm). */
const MIN_VECTOR_LENGTH = 0.001
/** Reach used when the analytical solve degenerates, as a fraction of max reach. */
const FALLBACK_REACH_FRACTION = 0.75

/** Targeting ray: a world-space ray with anchor + unit direction. */
export type TargetingRay = {
  locus: vec3
  direction: vec3
}

/**
 * Targeting-ray model.
 *
 * Lives in `interactor/ik/` because the ray model is interaction-specific
 * (it's the input to IK's `HandRayProvider`), not generic arm IK. Pairs
 * `compute` (forward — pose to ray) with `solveReach` (inverse — given a
 * target, find the wrist reach distance whose raw ray hits it). The
 * convergence loop's feedback step lives in {@link IndirectInteraction}.
 */
export class TargetingRayProvider {
  /**
   * Compute the targeting ray from current hand/head state.
   *
   * Algorithm mirrors TargetingRayPipeline.cpp:
   *   - Cervical link = head offset (slightly forward + below).
   *   - Cast anchor (locus) = wrist + forearm-dir × {@link LOCUS_OFFSET_CM}.
   *   - rawDir = (locus − cervical) + (locus − wrist) × {@link WRIST_AMPLIFICATION}.
   *   - {@link PITCH_UP_DEG} pitch-up and {@link YAW_OUT_DEG} outward-yaw biases.
   *
   * The yaw bias is signed by `isLeftHand` so each hand yaws *outward* (away
   * from the body midline) rather than always in the same world direction.
   *
   * @param body          - Head/shoulder/body-forward anchors driving the ray.
   * @param elbowPosition - World-space elbow position; used to derive forearm direction.
   * @param wristPosition - World-space wrist position; sets the locus.
   * @param isLeftHand    - True for the left hand; flips the yaw-out sign.
   * @returns The world-space ray, or `undefined` when the raw direction collapses to zero.
   */
  compute(
    body: BodyAnchors,
    elbowPosition: vec3,
    wristPosition: vec3,
    isLeftHand: boolean,
  ): TargetingRay | undefined {
    const cervical = new vec3(
      body.headPosition.x + body.bodyForward.x * CERVICAL_FORWARD_CM,
      body.headPosition.y - CERVICAL_DOWN_CM,
      body.headPosition.z + body.bodyForward.z * CERVICAL_FORWARD_CM,
    )

    const forearm = wristPosition.sub(elbowPosition)
    const armDirection =
      forearm.length > MIN_VECTOR_LENGTH
        ? forearm.normalize()
        : body.bodyForward
    const locus = wristPosition.add(armDirection.uniformScale(LOCUS_OFFSET_CM))

    const farComponent = locus.sub(cervical)
    const closeComponent = locus.sub(wristPosition)
    const rawDirection = farComponent.add(
      closeComponent.uniformScale(WRIST_AMPLIFICATION),
    )
    if (rawDirection.length < MIN_VECTOR_LENGTH) return undefined

    let direction = rawDirection.normalize()
    const bodyRight = new vec3(-body.bodyForward.z, 0, body.bodyForward.x)
    direction = quat
      .angleAxis(PITCH_UP_DEG * MathUtils.DegToRad, bodyRight)
      .multiplyVec3(direction)
    const yawSign = isLeftHand ? 1 : -1
    direction = quat
      .angleAxis(yawSign * YAW_OUT_DEG * MathUtils.DegToRad, vec3.up())
      .multiplyVec3(direction)

    return {locus, direction}
  }

  /**
   * Analytical solve for the wrist reach distance `d` such that placing
   * `wrist = shoulder + forearmDirection*d` produces a targeting ray that
   * passes exactly through `targetPosition` — but only for the *raw* ray;
   * the pitch/yaw biases in {@link compute} are not accounted for, so the
   * resulting ray still misses by ~2-3°. That residual is corrected in the
   * convergence loop.
   *
   * Derivation:
   *   - Let `locusReach = d + LOCUS_OFFSET` so `locus = shoulder + forearmUnit · locusReach`.
   *   - `rawDir = base + forearmUnit · (locusReach + LOCUS_OFFSET · WRIST_AMPLIFICATION)`,
   *     where `base = shoulder − cervical`.
   *   - For the ray (locus, rawDir) to pass through target T, require
   *     `rawDir × (T − locus) = 0`. Expanding and grouping by `locusReach`:
   *
   *         crossOffset + locusReach · crossSlope = 0, where
   *           crossOffset = base × toTarget + (LOCUS_OFFSET · WRIST_AMPLIFICATION) · (forearmUnit × toTarget)
   *           crossSlope  = forearmUnit × (toTarget + base)
   *           toTarget    = T − shoulder
   *
   *     (`crossOffset` is the cross-product when locusReach = 0; `crossSlope` is
   *     its rate of change per unit locusReach.)
   *   - Three equations (cross product is a 3-vector), one unknown — solve
   *     least-squares: `locusReach = −(crossOffset · crossSlope) / |crossSlope|²`.
   *     Then `d = locusReach − LOCUS_OFFSET`, clamped to `[0, wristReachCm]`.
   *
   * @param body              - Body keypoints (head + bodyForward + shoulder).
   * @param targetPosition    - World-space target position to aim at.
   * @param wristReachCm      - Maximum wrist reach used to clamp the result.
   * @param forearmDirection  - Unit forearm direction; defaults to
   *   `normalize(targetPosition − shoulder)` when omitted.
   * @returns Reach distance clamped to [0, wristReachCm].
   */
  solveReach(
    body: BodyAnchors,
    targetPosition: vec3,
    wristReachCm: number,
    forearmDirection?: vec3,
  ): number {
    const toTarget = targetPosition.sub(body.shoulder)
    if (toTarget.length < MIN_VECTOR_LENGTH)
      return wristReachCm * FALLBACK_REACH_FRACTION

    const forearmUnit = forearmDirection ?? toTarget.normalize()

    const cervical = new vec3(
      body.headPosition.x + body.bodyForward.x * CERVICAL_FORWARD_CM,
      body.headPosition.y - CERVICAL_DOWN_CM,
      body.headPosition.z + body.bodyForward.z * CERVICAL_FORWARD_CM,
    )
    const base = body.shoulder.sub(cervical)

    const locusWristContribution = LOCUS_OFFSET_CM * WRIST_AMPLIFICATION
    const crossOffset = base
      .cross(toTarget)
      .add(forearmUnit.cross(toTarget).uniformScale(locusWristContribution))
    const crossSlope = forearmUnit.cross(toTarget.add(base))
    if (crossSlope.length < MIN_VECTOR_LENGTH)
      return wristReachCm * FALLBACK_REACH_FRACTION

    const locusReach =
      -crossOffset.dot(crossSlope) / (crossSlope.length * crossSlope.length)
    return Math.max(0, Math.min(wristReachCm, locusReach - LOCUS_OFFSET_CM))
  }
}

import {ArmKeypoints} from "Leaf.lspkg/IKSolver/ArmModel"
import {safeNormalize} from "Leaf.lspkg/IKSolver/MathUtils"
import {solve2Bone} from "Leaf.lspkg/IKSolver/Solve2Bone"
import {BodyPose, HandFingerKeypoints} from "Leaf.lspkg/IKSolver/BodyController"
import {
  FINGER_NAMES,
  FingerName,
  FingerSegment,
  JointPose,
  Side,
  SIDES,
} from "Leaf.lspkg/IKSolver/Pose"
import {
  BitmojiJoint,
  BitmojiProvider,
  bitmojiJointKey,
} from "./BitmojiProvider"

/** Segments that bend on a curl. The tip is rigid relative to its parent. */
const CURL_SEGMENTS: readonly FingerSegment[] = [
  "knuckle",
  "midJoint",
  "upperJoint",
]

/** Non-zero scale to hide the Bitmoji wrist — zero would collapse skin-weighted vertices and flip cloth normals. */
const HIDDEN_HAND_SCALE = new vec3(0.001, 0.001, 0.001)

/**
 * Per-side arm joint names — co-located here so the apply loop iterates
 * sides rather than repeating the same call with mirrored string literals.
 */
type ArmJoints = {
  clavicle: BitmojiJoint
  wrist: BitmojiJoint
  upperArm: BitmojiJoint
  foreArm: BitmojiJoint
}
const ARM_JOINTS_BY_SIDE: Record<Side, ArmJoints> = {
  left: {
    clavicle: "leftClavicle",
    wrist: "leftWrist",
    upperArm: "leftUpperArm",
    foreArm: "leftForeArm",
  },
  right: {
    clavicle: "rightClavicle",
    wrist: "rightWrist",
    upperArm: "rightUpperArm",
    foreArm: "rightForeArm",
  },
}

/** Fraction of the arm rotation propagated to the clavicle. */
const CLAVICLE_BLEND_FACTOR = 0.3

/**
 * Per-finger per-segment curl angle (radians) at full pinch. The bend
 * axis is derived from each bone's rest geometry (see {@link curlAxisLocal})
 * so the rotation always stays in the bone's anatomical curl plane —
 * positive angles curl the finger toward the palm. Tune these to author
 * the pinch end-pose visually: at strength 1 the thumb tip should land
 * on the index tip.
 */
const PINCH_ANGLES: Partial<
  Record<FingerName, Partial<Record<FingerSegment, number>>>
> = {
  thumb: {knuckle: 0.5, midJoint: 0.8, upperJoint: 0.3},
  index: {knuckle: 0.3, midJoint: 0.5, upperJoint: 0.5},
}

/**
 * Applies a {@link BodyPose} to a Bitmoji rig each frame.
 *
 * - Head rotation comes from the IK head pose.
 * - Upper arm + forearm bones are driven via 2-bone IK from
 *   {@link ArmKeypoints} so the chain follows the IK target instead of
 *   staying in T-pose.
 * - The bitmoji wrist is collapsed (scale 0) — IK's hand mesh stands
 *   in for the avatar's hand, so the wrist rotation isn't applied here.
 *
 * Missing pose channels and joints not exposed by the provider are
 * silently skipped — a partially-loaded avatar renders fewer joints
 * rather than failing.
 */
export class BitmojiBodyVisualizer {
  /**
   * @param _provider - Bitmoji rig accessor.
   * @param _forearmExtensionCm - Centimeters to extend the bitmoji
   *   forearm IK target past the tracked wrist — lets the sleeve
   *   overlap the IK hand to hide the seam without offsetting the IK
   *   fingertips.
   */
  constructor(
    private readonly _provider: BitmojiProvider,
    private readonly _forearmExtensionCm: number = 0,
  ) {}

  /**
   * Apply the latest pose to the rig's joints.
   *
   * @param pose - Latest IK-driven body pose.
   */
  apply(pose: BodyPose): void {
    this.setHeadWorld(pose.head)

    for (const side of SIDES) {
      const joints = ARM_JOINTS_BY_SIDE[side]
      /**
       * Re-zero the wrist scale each frame so AnimationPlayer scale tracks
       * don't restore the Bitmoji hand — the IK hand mesh is the visible
       * hand; the Bitmoji wrist only exists to read its world position.
       */
      this.hideHand(joints.wrist)
      this.applyArm(
        side,
        joints.clavicle,
        joints.upperArm,
        joints.foreArm,
        side === "left" ? pose.leftArm : pose.rightArm,
      )
      this.applyContinuousCurl(
        side,
        side === "left" ? pose.leftFingers : pose.rightFingers,
      )
    }
  }

  private hideHand(joint: BitmojiJoint): void {
    const node = this._provider.getJoint(joint)
    node?.getTransform().setLocalScale(HIDDEN_HAND_SCALE)
  }

  /**
   * Blend the avatar between rest pose and {@link PINCH_ANGLES} by
   * pinch strength. Middle/ring/pinky stay at rest — populate them in
   * {@link PINCH_ANGLES} to extend.
   */
  private applyContinuousCurl(
    side: Side,
    fingers?: HandFingerKeypoints,
  ): void {
    if (!fingers) return
    const pinchStrength = fingers.pinchStrength ?? 0

    for (const name of FINGER_NAMES) {
      const fingerAngles = PINCH_ANGLES[name]

      for (const segment of CURL_SEGMENTS) {
        const joint = bitmojiJointKey(side, {name, segment})
        const node = this._provider.getJoint(joint)
        if (isNull(node)) continue

        const restLocalRotation =
          this._provider.restPose?.localRotations[joint]
        if (!restLocalRotation) continue

        const angle = fingerAngles?.[segment]
        const axis = angle === undefined ? undefined : this.curlAxisLocal(joint)
        const bend =
          angle === undefined || !axis
            ? quat.quatIdentity()
            : quat.angleAxis(angle * pinchStrength, axis)
        node.getTransform().setLocalRotation(restLocalRotation.multiply(bend))
      }
    }
  }

  /**
   * Anatomical curl axis for `joint` in the bone's local frame, so it
   * composes as `restLocal × angleAxis(angle, axis)`. Built as
   * `up × boneDirection` in world space (Mixamo bind pose has palms
   * roughly horizontal), then rotated into the bone's local frame.
   * Returns `undefined` when bone direction is parallel to `up`.
   */
  private curlAxisLocal(joint: BitmojiJoint): vec3 | undefined {
    const restPose = this._provider.restPose
    const boneDirectionWorld = restPose?.boneDirections[joint]
    const restWorldRotation = restPose?.worldRotations[joint]
    if (!boneDirectionWorld || !restWorldRotation) return undefined

    const worldAxis = safeNormalize(vec3.up().cross(boneDirectionWorld))
    if (!worldAxis) return undefined
    return restWorldRotation.invert().multiplyVec3(worldAxis)
  }

  private setHeadWorld(pose?: JointPose): void {
    if (!pose) return
    const node = this._provider.getJoint("head")
    if (isNull(node)) return

    const restWorldRotation = this._provider.restPose?.worldRotations["head"]
    if (!restWorldRotation) return

    node
      .getTransform()
      .setWorldRotation(pose.rotation.multiply(restWorldRotation))
  }

  private applyArm(
    side: Side,
    clavicle: BitmojiJoint,
    upperArm: BitmojiJoint,
    foreArm: BitmojiJoint,
    arm?: ArmKeypoints,
  ): void {
    if (!arm || !arm.elbow || !arm.wrist.position) return

    /**
     * Extend the IK target past the wrist so the sleeve overlaps the
     * IK hand. IK fingertips stay at their tracked positions so
     * interactable reach is unaffected.
     *
     * No reach clamp here even though we push outward: {@link solve2Bone}
     * is self-defending — it short-circuits to a fully-extended chain
     * when `|root → endEffector| >= upperLength + lowerLength` and
     * clamps the cosine to `[-1, 1]` otherwise, so an over-extended
     * target never produces NaN or absurd elbow positions.
     */
    let wristTarget = arm.wrist.position
    if (this._forearmExtensionCm > 0) {
      const forearmDirection = safeNormalize(arm.wrist.position.sub(arm.elbow))
      if (forearmDirection) {
        wristTarget = arm.wrist.position.add(
          forearmDirection.uniformScale(this._forearmExtensionCm),
        )
      }
    }

    /** Must run before reading the upper arm world position. */
    this.applySympatheticClavicle(clavicle, wristTarget)

    const upperArmNode = this._provider.getJoint(upperArm)
    if (isNull(upperArmNode)) {
      this.aimBoneAt(upperArm, arm.elbow.sub(arm.shoulder))
      this.aimBoneAt(foreArm, wristTarget.sub(arm.elbow))
      return
    }

    const rigShoulderWorld = upperArmNode.getTransform().getWorldPosition()
    const boneLengths = this._provider.restPose?.boneLengths
    const upperArmLength = boneLengths?.[upperArm]
    const foreArmLength = boneLengths?.[foreArm]
    if (upperArmLength === undefined || foreArmLength === undefined) {
      this.aimBoneAt(upperArm, arm.elbow.sub(arm.shoulder))
      this.aimBoneAt(foreArm, wristTarget.sub(arm.elbow))
      return
    }

    const sign = side === "left" ? -1 : 1
    /** Lateral component keeps the pole non-parallel to the limb when reaching down. */
    const poleVector = arm.bodyDown.add(arm.bodyRight.uniformScale(sign))
    const solvedElbow = solve2Bone(
      rigShoulderWorld,
      wristTarget,
      upperArmLength,
      foreArmLength,
      poleVector,
    )
    this.aimBoneAt(upperArm, solvedElbow.sub(rigShoulderWorld))
    this.aimBoneAt(foreArm, wristTarget.sub(solvedElbow))
  }

  private applySympatheticClavicle(
    clavicle: BitmojiJoint,
    wristTargetWorld: vec3,
  ): void {
    const node = this._provider.getJoint(clavicle)
    if (isNull(node)) return

    const restPose = this._provider.restPose
    const restRotation = restPose?.worldRotations[clavicle]
    const restDirection = restPose?.boneDirections[clavicle]
    if (!restRotation || !restDirection) return

    const clavicleWorld = node.getTransform().getWorldPosition()
    const desired = safeNormalize(wristTargetWorld.sub(clavicleWorld))
    if (!desired) return

    const fullDelta = quat.rotationFromTo(restDirection, desired)
    const partialDelta = quat.slerp(
      quat.quatIdentity(),
      fullDelta,
      CLAVICLE_BLEND_FACTOR,
    )
    node.getTransform().setWorldRotation(partialDelta.multiply(restRotation))
  }

  /**
   * Rotate a bone so its rest direction aligns with `desiredWorldVector`.
   * Applies the minimum-arc rotation as a world-space delta on top of
   * the bone's rest world rotation, so we don't need to know which local
   * axis runs along the Mixamo bone.
   */
  private aimBoneAt(joint: BitmojiJoint, desiredWorldVector: vec3): void {
    const desired = safeNormalize(desiredWorldVector)
    if (!desired) return

    const node = this._provider.getJoint(joint)
    if (isNull(node)) return

    const restPose = this._provider.restPose
    const restRotation = restPose?.worldRotations[joint]
    const restDirection = restPose?.boneDirections[joint]
    if (!restRotation || !restDirection) return

    const delta = quat.rotationFromTo(restDirection, desired)
    node.getTransform().setWorldRotation(delta.multiply(restRotation))
  }
}

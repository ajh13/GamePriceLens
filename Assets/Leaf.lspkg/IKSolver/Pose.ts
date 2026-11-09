import {nearlyEqual} from "./MathUtils"

/**
 * World-space pose of a single joint: position and orientation.
 */
export type JointPose = {
  position: vec3
  rotation: quat
}

/** Off-axis angle (degrees) from the head's forward axis to `position`. Returns 0 for a degenerate offset. */
export function angleFromHeadForwardDeg(
  headPose: JointPose,
  position: vec3,
): number {
  const offset = position.sub(headPose.position)
  const length = offset.length
  if (nearlyEqual(length, 0)) return 0
  const headForward = headPose.rotation.multiplyVec3(vec3.back())
  const cos = Math.max(-1, Math.min(1, headForward.dot(offset) / length))
  return Math.acos(cos) * MathUtils.RadToDeg
}

export const SIDES = ["left", "right"] as const
/** Body side for paired joints (hands, feet, arms). */
export type Side = (typeof SIDES)[number]

export const FINGER_NAMES = [
  "thumb",
  "index",
  "middle",
  "ring",
  "pinky",
] as const
/** Anatomical finger name. */
export type FingerName = (typeof FINGER_NAMES)[number]

export const FINGER_SEGMENTS = [
  "knuckle",
  "midJoint",
  "upperJoint",
  "tip",
] as const
/**
 * Position along a finger from palm outward. Same names as
 * {@link FingerKeypoints} so the segment vocabulary stays consistent
 * across IK consumers.
 */
export type FingerSegment = (typeof FINGER_SEGMENTS)[number]

/** Side-agnostic finger joint identifier. */
export type FingerJoint = {
  name: FingerName
  segment: FingerSegment
}

/** All (finger, segment) pairs — precomputed for iteration. */
export const FINGER_JOINTS: readonly FingerJoint[] = FINGER_NAMES.flatMap(
  (name) => FINGER_SEGMENTS.map((segment) => ({name, segment})),
)

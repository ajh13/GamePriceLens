import {FingerName, FingerSegment, JointPose} from "./Pose"
import {HeadController} from "./HeadController"
import {ArmKeypoints, ArmModel} from "./ArmModel"

/**
 * Per-finger keypoint positions (world-space) as reported by hand tracking,
 * indexed by {@link FingerSegment} (palm outward).
 */
export type FingerKeypoints = Record<FingerSegment, vec3>

export type HandFingerKeypoints = Partial<
  Record<FingerName, FingerKeypoints>
> & {
  /** 0 when relaxed, 1 when thumb+index tips are touching. */
  pinchStrength?: number
}

export type BodyPose = {
  head: JointPose
  leftWrist?: JointPose
  rightWrist?: JointPose
  /** Full arm IK chain (shoulder + elbow + wrist) for driving an external rig. */
  leftArm?: ArmKeypoints
  /** Full arm IK chain (shoulder + elbow + wrist) for driving an external rig. */
  rightArm?: ArmKeypoints
  leftFingers?: HandFingerKeypoints
  rightFingers?: HandFingerKeypoints
}

/**
 * Coordinates head and both arms as a single physics-driven body.
 *
 * The head is driven by a {@link HeadController}; each arm's wrist is driven
 * by an {@link ArmModel} whose shoulder geometry is derived from the active
 * head pose each frame.
 *
 * The caller provides live tracked poses (camera, hand keypoints) and decides
 * what to do with the returned {@link BodyPose} — apply it to a scene object,
 * a Bitmoji skeleton, the camera, etc.
 *
 * Returns `undefined` from {@link update} when the full body is at rest
 * (no active targets, all controllers have settled).
 */
export class BodyController {
  private readonly _head = new HeadController()
  private readonly _leftArm = new ArmModel(true)
  private readonly _rightArm = new ArmModel(false)

  /**
   * @param position - World-space target for the head, or `undefined` to return to rest.
   * @param lookAt   - World-space point to face toward while moving.
   */
  setHeadTarget(position?: vec3, lookAt?: vec3): void {
    this._head.setTarget(lookAt, position)
  }

  /**
   * @param target - Position / rotation latches for the wrist.
   * @param hand   - Which wrist to target. Defaults to `"right"`.
   */
  setWristTarget(
    target: Partial<JointPose> = {},
    hand: "left" | "right" = "right",
  ): void {
    if (hand === "left") {
      this._leftArm.setTarget(target)
    } else {
      this._rightArm.setTarget(target)
    }
  }

  /**
   * Integrate one frame and return the full body keypoints.
   *
   * Returns `undefined` only when all three controllers are fully at rest —
   * a partial active state (e.g. one arm targeting, head at rest) still
   * produces {@link BodyPose}.
   *
   * @param deltaTime         - Frame delta in seconds.
   * @param trackedHead       - Live head pose.
   * @param trackedLeftWrist  - Live left wrist position.
   * @param trackedRightWrist - Live right wrist position.
   * @returns Full body keypoints, or `undefined` when everything is at rest.
   */
  update(
    deltaTime: number,
    trackedHead: JointPose,
    trackedLeftWrist: vec3,
    trackedRightWrist: vec3,
  ): BodyPose | undefined {
    const headPose = this._head.update(deltaTime, trackedHead)
    const activeHead = headPose ?? trackedHead

    const leftArm = this._leftArm.update(
      activeHead,
      deltaTime,
      trackedLeftWrist,
    )
    const rightArm = this._rightArm.update(
      activeHead,
      deltaTime,
      trackedRightWrist,
    )

    const leftWrist = armToWristPose(leftArm)
    const rightWrist = armToWristPose(rightArm)

    if (
      headPose === undefined &&
      leftWrist === undefined &&
      rightWrist === undefined
    ) {
      return undefined
    }

    return {head: activeHead, leftWrist, rightWrist}
  }
}

function armToWristPose(arm: {
  wrist: Partial<JointPose>
}): JointPose | undefined {
  return arm.wrist.position === undefined || arm.wrist.rotation === undefined
    ? undefined
    : {position: arm.wrist.position, rotation: arm.wrist.rotation}
}

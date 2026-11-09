import {WristController} from "./WristController"
import {nearlyEqual, safeNormalize} from "./MathUtils"
import {JointPose} from "./Pose"
import {solve2Bone} from "./Solve2Bone"

// Approximate human body proportions (cm), empirically tuned for comfort.
const NECK_BELOW_CAM_CM = 37
const SHOULDER_LATERAL_CM = 20
const WRIST_INSET_CM = 15
const WRIST_REACH_CM = 75
const MAX_REACH_FRACTION = 0.9
const REST_DROP_FRACTION = 0.97
export const UPPER_ARM_LENGTH_CM = 40
export const FOREARM_LENGTH_CM = 30
/** Below this length the horizontal head-back vector is treated as degenerate. */
const MIN_BODY_FORWARD_LENGTH = 0.01
/** Outward bias along bodyRight × sign for the reach-cone center. */
const REACH_CONE_OUTWARD_BIAS = 0.3
/** Reach-cone half-angle — targets outside are projected onto its surface. */
const REACH_CONE_HALF_ANGLE_RAD = 90 * MathUtils.DegToRad
const REACH_CONE_COS = Math.cos(REACH_CONE_HALF_ANGLE_RAD)
const REACH_CONE_SIN = Math.sin(REACH_CONE_HALF_ANGLE_RAD)

export const WRIST_MAX_REACH_CM = WRIST_REACH_CM * MAX_REACH_FRACTION

export type BodyAnchors = {
  neck: vec3
  shoulder: vec3
  restWrist: vec3
  headPosition: vec3
  /** Horizontal gaze direction (XZ plane). */
  bodyForward: vec3
  /** Head's world-space down axis. */
  bodyDown: vec3
  /** Horizontal head-right axis (XZ plane). */
  bodyRight: vec3
}

export type ArmKeypoints = BodyAnchors & {
  /** Rotation is always present; position is set only while reaching. */
  wrist: Partial<JointPose>
  /** Solved elbow; present only while reaching. */
  elbow?: vec3
}

/**
 * IK arm model. Derives body anchors from the head pose, delegates wrist
 * smoothing to a {@link WristController}, then solves the elbow via 2-bone IK.
 */
export class ArmModel {
  private readonly _wrist = new WristController()

  constructor(private readonly _isLeft: boolean = false) {}

  /**
   * Latch position/rotation targets. Missing fields preserve their prior
   * value; `position: undefined` starts the return-to-rest countdown.
   *
   * @param target - Position / rotation fields to update.
   */
  setTarget(target: Partial<JointPose> = {}): void {
    this._wrist.setTarget(target)
  }

  /**
   * Body anchors derived from the head pose alone — no IK physics.
   *
   * @param headPose - Current head pose.
   * @returns Skeletal anchors + body axes for downstream consumers.
   */
  bodyAnchors(headPose: JointPose): BodyAnchors {
    return this.computeBodyAnchors(headPose)
  }

  /**
   * Integrate one frame. Wrist rotation is always returned; position and
   * elbow are set only while reaching.
   *
   * @param headPose             - Current head pose.
   * @param deltaTime            - Frame delta in seconds.
   * @param trackedWristPosition - Live tracked wrist position; seeds physics
   *   when the wrist first activates.
   * @returns Full arm keypoints for this frame.
   */
  update(
    headPose: JointPose,
    deltaTime: number,
    trackedWristPosition: vec3,
  ): ArmKeypoints {
    const anchors = this.computeBodyAnchors(headPose)
    const wrist = this._wrist.update(
      anchors.restWrist,
      deltaTime,
      trackedWristPosition,
    )
    if (wrist.position === undefined) return {...anchors, wrist}
    const wristPosition = this.applyReachConstraints(wrist.position, anchors)
    const sign = this._isLeft ? -1 : 1
    /** Lateral component keeps the pole non-parallel to the limb when reaching down. */
    const poleVector = anchors.bodyDown.add(
      anchors.bodyRight.uniformScale(sign),
    )
    const elbow = solve2Bone(
      anchors.shoulder,
      wristPosition,
      UPPER_ARM_LENGTH_CM,
      FOREARM_LENGTH_CM,
      poleVector,
    )
    return {
      ...anchors,
      wrist: {position: wristPosition, rotation: wrist.rotation},
      elbow,
    }
  }

  private computeBodyAnchors(headPose: JointPose): BodyAnchors {
    const headPosition = headPose.position
    const right = headPose.rotation.multiplyVec3(vec3.right())
    const forward = headPose.rotation.multiplyVec3(vec3.forward())
    const back = headPose.rotation.multiplyVec3(vec3.back())
    const bodyDown = headPose.rotation.multiplyVec3(vec3.down())

    let horizontalRight = new vec3(right.x, 0, right.z)
    if (nearlyEqual(horizontalRight.length, 0)) {
      horizontalRight = new vec3(-forward.z, 0, forward.x)
    }
    const bodyRight = nearlyEqual(horizontalRight.length, 0)
      ? vec3.right()
      : horizontalRight.normalize()

    const horizontalBack = new vec3(back.x, 0, back.z)
    const bodyForward =
      horizontalBack.length > MIN_BODY_FORWARD_LENGTH
        ? horizontalBack.normalize()
        : vec3.back()

    const sign = this._isLeft ? -1 : 1
    const neck = new vec3(
      headPosition.x,
      headPosition.y - NECK_BELOW_CAM_CM,
      headPosition.z,
    )
    const shoulder = neck.add(
      bodyRight.uniformScale(SHOULDER_LATERAL_CM * sign),
    )
    const inset = shoulder.sub(bodyRight.uniformScale(WRIST_INSET_CM * sign))
    const restWrist = new vec3(
      inset.x,
      shoulder.y - WRIST_REACH_CM * REST_DROP_FRACTION,
      inset.z,
    )
    const partialAnchors = {
      neck,
      shoulder,
      headPosition,
      bodyForward,
      bodyDown,
      bodyRight,
    }
    return {
      ...partialAnchors,
      restWrist: this.applyReachConstraints(restWrist, partialAnchors),
    }
  }

  /**
   * Clamp `wristPos` to the reachable region: a sphere of radius
   * {@link WRIST_MAX_REACH_CM} intersected with a cone around `bodyForward`
   * (biased outward) so the arm can't reach behind the back or across the chest.
   */
  private applyReachConstraints(
    wristPos: vec3,
    anchors: Omit<BodyAnchors, "restWrist">,
  ): vec3 {
    const toWrist = wristPos.sub(anchors.shoulder)
    const distance = toWrist.length
    if (distance < MIN_BODY_FORWARD_LENGTH) return wristPos

    const sign = this._isLeft ? -1 : 1
    const coneCenter = anchors.bodyForward
      .add(anchors.bodyRight.uniformScale(REACH_CONE_OUTWARD_BIAS * sign))
      .normalize()
    const direction = toWrist.uniformScale(1 / distance)
    const cosAngle = direction.dot(coneCenter)
    let clampedDirection = direction
    if (cosAngle < REACH_CONE_COS) {
      const tangent = safeNormalize(
        direction.sub(coneCenter.uniformScale(cosAngle)),
      )
      clampedDirection = tangent
        ? coneCenter
            .uniformScale(REACH_CONE_COS)
            .add(tangent.uniformScale(REACH_CONE_SIN))
        : coneCenter
    }
    return anchors.shoulder.add(
      clampedDirection.uniformScale(Math.min(distance, WRIST_MAX_REACH_CM)),
    )
  }
}

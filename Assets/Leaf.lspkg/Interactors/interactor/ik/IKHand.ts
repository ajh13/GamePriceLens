import {Hand} from "../handInput/Hand"
import {
  GESTURE_CONFIG,
  PINCH_STRENGTH_THRESHOLD,
  RELAXED_THUMB_INDEX_DISTANCE,
} from "../handInput/Gestures"
import type {GestureType} from "../handInput/Gestures"
import {HandType} from "InteractionKit.lspkg/Providers/HandInputData/HandType"
import {Keypoint} from "InteractionKit.lspkg/Providers/HandInputData/Keypoint"
import {ArmModel} from "Leaf.lspkg/IKSolver/ArmModel"
import {rigRootRotation} from "../handInput/HandRig"

/** Shared by direct and indirect strategies so the visual transition feels consistent. */
export const PINCH_GESTURE_DURATION_MS = 150

/**
 * Bypass `KeypointWrapper`'s private `keypoint` field to reach the underlying
 * joint transform — needed to apply joint rotations directly (no animation
 * tween) when computing the pinch midpoint via forward kinematics.
 */
function getJointTransform(keypoint: unknown): Transform {
  return (
    keypoint as {keypoint: {getAttachmentPoint(): {getTransform(): Transform}}}
  ).keypoint
    .getAttachmentPoint()
    .getTransform()
}

export class IKHand extends Hand {
  private _pinching = false
  private _pinchEndpointLocal?: vec3

  constructor(
    sikKeypoints: Map<string, Keypoint>,
    private readonly _handType: HandType,
    handRoot: SceneObject,
    private readonly _armModel: ArmModel,
  ) {
    super(sikKeypoints, _handType, handRoot)
  }

  /** Position is applied immediately; arm IK drives the wrist every frame so a tween would fight it. */
  override async setPosition(
    position: vec3,
    durationMs?: number,
  ): Promise<void> {
    this.handRoot.getTransform().setWorldPosition(position)
  }

  /** Latches a rotation target on {@link ArmModel}; the smoothed rotation is applied each frame via {@link applyRotation}. */
  override async setRotation(
    rotation: quat,
    durationMs?: number,
  ): Promise<void> {
    this._armModel.setTarget({rotation})
  }

  /** Snap the hand-root world rotation. Used by {@link IKHandInteractor.updateArm} to apply the rotation produced by ArmModel. */
  applyRotation(rotation: quat): void {
    this.handRoot.getTransform().setWorldRotation(rigRootRotation(rotation))
  }

  /** Snaps joints to the target pose by default (durationMs=1). */
  override makeGesture(
    gesture: GestureType,
    position?: vec3,
    durationMs?: number,
  ): Promise<void> {
    return super.makeGesture(gesture, position, durationMs ?? 1)
  }

  /** Always true — frustum checks break when the simulator camera is at origin. */
  override inFOV(): boolean {
    return true
  }

  override getPinchStrength(): number {
    const distance = this.thumbTip.position.distance(this.indexTip.position)
    return 1.0 - Math.min(distance / RELAXED_THUMB_INDEX_DISTANCE, 1.0)
  }

  /** Gated by {@link setPinching} so the trigger only activates after hoverEnter. */
  override isPinching(): boolean {
    return this._pinching && this.getPinchStrength() >= PINCH_STRENGTH_THRESHOLD
  }

  setPinching(pinching: boolean): void {
    this._pinching = pinching
  }

  get worldPosition(): vec3 {
    return this.handRoot.getTransform().getWorldPosition()
  }

  get worldRotation(): quat {
    return this.handRoot.getTransform().getWorldRotation()
  }

  /** World-space pinch midpoint predicted from the current hand-root transform. */
  get pinchEndpointWorld(): vec3 {
    const offset = this.pinchEndpointLocal()
    const root = this.handRoot.getTransform()
    return root
      .getWorldPosition()
      .add(root.getWorldRotation().multiplyVec3(offset))
  }

  /**
   * Inverse of pinch-pose forward kinematics: world-space hand-root position
   * required for the pinch midpoint to land at `targetPosition`, assuming the
   * hand keeps its current world rotation.
   */
  wristPositionForPinchAt(targetPosition: vec3): vec3 {
    return targetPosition.sub(
      this.worldRotation.multiplyVec3(this.pinchEndpointLocal()),
    )
  }

  /**
   * Pinch midpoint in hand-root local space — constant across the hand's
   * lifetime once captured. Lazily computed by temporarily applying the pinch
   * pose to the underlying joints, reading the tip positions, and restoring.
   */
  private pinchEndpointLocal(): vec3 {
    if (this._pinchEndpointLocal !== undefined) return this._pinchEndpointLocal

    const pinch = GESTURE_CONFIG.pinch[this._handType]
    const pinchedJoints: Array<{keypoint: unknown; target: quat}> = [
      {keypoint: this.thumbKnuckle, target: pinch.thumb.knuckleAngle},
      {keypoint: this.thumbMidJoint, target: pinch.thumb.midjointAngle},
      {keypoint: this.indexKnuckle, target: pinch.index.knuckleAngle},
      {keypoint: this.indexMidJoint, target: pinch.index.midjointAngle},
      {keypoint: this.indexUpperJoint, target: pinch.index.upperAngle},
    ]

    const savedRotations: quat[] = []
    for (const {keypoint, target} of pinchedJoints) {
      const transform = getJointTransform(keypoint)
      savedRotations.push(transform.getLocalRotation())
      transform.setLocalRotation(target)
    }

    const pinchMidWorld = this.thumbTip.position
      .add(this.indexTip.position)
      .uniformScale(0.5)

    const root = this.handRoot.getTransform()
    const offsetWorld = pinchMidWorld.sub(root.getWorldPosition())
    this._pinchEndpointLocal = root
      .getWorldRotation()
      .invert()
      .multiplyVec3(offsetWorld)

    pinchedJoints.forEach(({keypoint}, i) => {
      getJointTransform(keypoint).setLocalRotation(savedRotations[i])
    })

    return this._pinchEndpointLocal
  }
}

import {JointPose} from "./Pose"

/**
 * Bridges a Lens Studio {@link Transform} and {@link JointPose}.
 *
 * Reads world-space position and rotation from the transform via {@link toPose},
 * and writes a {@link JointPose} back to it via {@link apply}.
 */
export class PoseTransform {
  constructor(private readonly _transform: Transform) {}

  /**
   * Reads the current world-space transform as a pose snapshot.
   *
   * @returns A {@link JointPose} with the transform's world position and rotation.
   */
  toPose(): JointPose {
    return {
      position: this._transform.getWorldPosition(),
      rotation: this._transform.getWorldRotation(),
    }
  }

  /**
   * Writes a pose back to the transform.
   *
   * @param pose - The {@link JointPose} to apply.
   */
  apply(pose: JointPose): void {
    this._transform.setWorldPosition(pose.position)
    this._transform.setWorldRotation(pose.rotation)
  }
}

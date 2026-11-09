import {IndexFingerKeypoints} from "./PokeTarget"

const MIN_FINGER_VECTOR_LENGTH = 0.001

/**
 * Snapshots and normalizes index finger geometry each frame, parallel to {@link ArmModel}.
 *
 * Decoupled from IK and hand tracking — callers read bone positions and pass them in.
 * The snapshot is consumed by poke endpoint overrides that run in the next frame, before
 * ObjectTracking3D has reset the bones.
 */
export class IndexFingerModel {
  private _keypoints?: IndexFingerKeypoints

  get keypoints(): IndexFingerKeypoints | undefined {
    return this._keypoints
  }

  /**
   * Records the current finger geometry as a snapshot.
   *
   * @param tipPosition        - World position of the index tip.
   * @param upperJointPosition - World position of the index upper joint.
   * @param tipUp              - Up vector of the tip attachment point.
   * @param wristPosition      - World position of the wrist / hand root.
   */
  update(tipPosition: vec3, upperJointPosition: vec3, tipUp: vec3, wristPosition: vec3): void {
    const fingerVector = tipPosition.sub(upperJointPosition)
    this._keypoints = {
      tipPosition,
      upperJointPosition,
      fingerDirection: fingerVector.length > MIN_FINGER_VECTOR_LENGTH ? fingerVector.normalize() : vec3.back(),
      tipUp,
      wristPosition,
    }
  }
}

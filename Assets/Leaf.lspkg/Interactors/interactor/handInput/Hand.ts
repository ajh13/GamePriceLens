import {
  ignoreAnimationCancellationError,
  rotate,
  translate,
} from "Leaf.lspkg/Utils/common/Animate"
import {Keypoint} from "InteractionKit.lspkg/Providers/HandInputData/Keypoint"
import {LandmarkName} from "InteractionKit.lspkg/Providers/HandInputData/LandmarkNames"
import {HandType} from "InteractionKit.lspkg/Providers/HandInputData/HandType"

import {
  GESTURE_CONFIG,
  GestureType,
  HAND_TRANSFORMS,
  HandConfig,
  PINCH_STRENGTH_THRESHOLD,
  RELAXED_THUMB_INDEX_DISTANCE,
} from "./Gestures"
import WorldCameraFinderProvider from "InteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import {DEG_TO_RAD} from "Leaf.lspkg/Utils/common/Constants"
import {clamp} from "InteractionKit.lspkg/Utils/mathUtils"
import {CancellablePromise} from "Leaf.lspkg/Utils/common/CancellablePromise"
import {rigRootRotation} from "./HandRig"

// TODO (SAP-841): Move constants and configs to separate files
const DEFAULT_ANIMATION_DURATION_MS = 500

const DEFAULT_CONFIG = {
  palm: {
    rotation: quat.fromEulerAngles(180 * DEG_TO_RAD, 0, 90 * DEG_TO_RAD),
  },
  back: {
    rotation: quat.fromEulerAngles(0, 0, 90 * DEG_TO_RAD),
  },
}

export const HAND_CONFIG = {
  left: {
    ...DEFAULT_CONFIG,
    shownPosition: new vec3(-10, 0, -70),
    hiddenPosition: new vec3(-10, -80, 0),
  },
  right: {
    ...DEFAULT_CONFIG,
    shownPosition: new vec3(10, 0, -70),
    hiddenPosition: new vec3(10, -80, 0),
    // TODO (SAP-935): Make rotations part of the gestures
    palm: {
      rotation: quat.fromEulerAngles(-90 * DEG_TO_RAD, 0, -90 * DEG_TO_RAD),
    },
    back: {
      rotation: quat.fromEulerAngles(90 * DEG_TO_RAD, 0, -90 * DEG_TO_RAD),
    },
  },
}
/**
 * Wrapper class for Keypoint providing an interface to set the local
 * rotation of keypoints (joints).
 */
class KeypointWrapper {
  originalLocalRotation: quat = this.keypoint
    .getAttachmentPoint()
    .getTransform()
    .getLocalRotation()

  constructor(private keypoint: Keypoint) {}

  /**
   * Set the local rotation of the keypoint.
   * @param rotation - The rotation to set
   * @param animationDurationMs - Duration to transition to {@link rotation}, in milliseconds.
   */
  setLocalRotation(
    rotation: quat,
    animationDurationMs: number = DEFAULT_ANIMATION_DURATION_MS,
  ): CancellablePromise<void> {
    return rotate(
      this.keypoint.getAttachmentPoint().getTransform(),
      rotation,
      animationDurationMs,
      true,
    )
  }

  /**
   * Reset the local rotation of the keypoint to its original value.
   * Doing this for all keypoints will reset the hand to its original pose.
   * @param animationDurationMs - The duration to transition to the original rotation, in milliseconds.
   */
  resetLocalRotation(
    animationDurationMs: number = DEFAULT_ANIMATION_DURATION_MS,
  ): CancellablePromise<void> {
    return rotate(
      this.keypoint.getAttachmentPoint().getTransform(),
      this.originalLocalRotation,
      animationDurationMs,
      true,
    )
  }

  /**
   * The world position of the keypoint (readonly).
   */
  get position(): Readonly<vec3> {
    return this.keypoint
      .getAttachmentPoint()
      .getTransform()
      .getWorldPosition() as Readonly<vec3>
  }
}

/**
 * Wrapper class for managing and manipulating the hand.
 * Contains all accessible keypoints of the hand.
 */
export class Hand {
  private keypoints: Map<string, KeypointWrapper> = new Map()
  private _lastGesture: GestureType = "neutral"
  private camera: Camera

  private _animationPromises: {
    position?: CancellablePromise<void>
    rotation?: CancellablePromise<void>
    gesture: CancellablePromise<void>[]
  } = {
    position: undefined,
    rotation: undefined,
    gesture: [],
  }

  protected get animationPromises() {
    return this._animationPromises
  }

  protected get handRoot(): SceneObject {
    return this._handRoot
  }

  constructor(
    private sikKeypoints: Map<string, Keypoint>,
    private handType: HandType,
    private _handRoot: SceneObject,
  ) {
    this.sikKeypoints.forEach((keypoint, name) => {
      this.keypoints.set(name, new KeypointWrapper(keypoint))
      this.keypoints
        .get(name)
        // Manually modifying joints will result in unknown gesture
        .setLocalRotation.bind(() => (this._lastGesture = "unknown"))
    })
    this.camera = WorldCameraFinderProvider.getInstance().getComponent()

    // Initialize the hands in their hidden position
    this.handRoot
      .getTransform()
      .setWorldPosition(HAND_TRANSFORMS[this.handType].hiddenPosition)
    this.handRoot
      .getTransform()
      .setWorldRotation(
        rigRootRotation(HAND_TRANSFORMS[this.handType].initialRotation),
      )
    this.makeGesture("neutral").catch(ignoreAnimationCancellationError)
  }

  /** Cancels pending movement and gesture animations before the hand rig is released. */
  cancelAllAnimations(): void {
    this.animationPromises.position?.cancel()
    this.animationPromises.rotation?.cancel()
    this.animationPromises.gesture.forEach((animation) => animation.cancel())
    this.animationPromises.position = undefined
    this.animationPromises.rotation = undefined
    this.animationPromises.gesture = []
  }

  /**
   * Hide the hand.
   * @param animationdurationMs - Duration to transition to hidden position, in milliseconds.
   */
  async hide(
    animationdurationMs: number = DEFAULT_ANIMATION_DURATION_MS,
  ): Promise<void> {
    await this.setPosition(
      HAND_TRANSFORMS[this.handType].hiddenPosition,
      animationdurationMs,
    )
  }

  /**
   * Move the hand to a given world position (based on the wrist).
   * @param position - The target position to move the hand scene object to.
   * @param transitionDurationMs - The duration to transition to {@link position}.
   */
  async setPosition(
    position: vec3,
    transitionDurationMs: number = DEFAULT_ANIMATION_DURATION_MS,
  ): Promise<void> {
    // Cancel any ongoing position animation
    this.animationPromises.position?.cancel()
    if (transitionDurationMs <= 0) {
      /** `animate(duration=0)` produces NaN positions and no-ops; bypass so per-frame drag updates actually move the hand. */
      this.handRoot.getTransform().setWorldPosition(position)
      return
    }
    this.animationPromises.position = translate(
      this.handRoot.getTransform(),
      position,
      transitionDurationMs,
    )
    await this.animationPromises.position
  }

  /**
   * Sets the hand {@link Transform} world position by a screen position.
   * @param screenPosition - Screen position, values between 0 and 1.
   * @param depth - Depth in world space, in centimeters.
   * @param animationDurationMs - Duration to transition to {@link screenPosition}, in seconds.
   * @returns
   */
  async setScreenPosition(
    screenPosition: vec2,
    depth: number,
    animationDurationMs: number = DEFAULT_ANIMATION_DURATION_MS,
  ): Promise<void> {
    const position = this.camera.screenSpaceToWorldSpace(screenPosition, depth)
    await this.setPosition(position, animationDurationMs)
  }

  /**
   * Sets the hand {@link Transform} world rotation.
   * @param rotation - Rotation to place the hand.
   * @param animationdurationMs - Duration to transition to {@link rotation}, in milliseconds.
   */
  async setRotation(
    rotation: quat,
    animationdurationMs: number = DEFAULT_ANIMATION_DURATION_MS,
  ): Promise<void> {
    this.animationPromises.rotation?.cancel()
    this.animationPromises.rotation = rotate(
      this.handRoot.getTransform(),
      rigRootRotation(rotation),
      animationdurationMs,
    )
    await this.animationPromises.rotation
  }

  private getKeypoint(landmarkName: LandmarkName): KeypointWrapper {
    const keypoint = this.keypoints.get(landmarkName as string)
    if (!keypoint) {
      throw new Error(`Keypoint ${landmarkName} is not supported.`)
    }

    return keypoint
  }

  /**
   * @returns All keypoints of the hand as a readonly-map of string to KeypointWrapper.
   */
  get allKeypoints(): ReadonlyMap<string, KeypointWrapper> {
    return this.keypoints as ReadonlyMap<string, KeypointWrapper>
  }

  /**
   * @returns The current gesture of the hand.
   */
  get lastGesture(): GestureType {
    return this._lastGesture
  }

  /**
   * Sets the hand to a specific gesture.
   * @param gesture - The gesture to perform. Must me {@link GestureType}.
   * @param position - [Optional] The world position to set the hand to.
   * Setting a position will override the default position for this gesture (if any).
   * @param durationMs - [Optional] The duration to transition to {@link gesture}, in milliseconds. Defaults to 500ms.
   */
  async makeGesture(
    gesture: GestureType,
    position?: vec3,
    durationMs: number = DEFAULT_ANIMATION_DURATION_MS,
  ): Promise<void> {
    // Cancel ongoing gesture changes
    this.animationPromises.gesture.forEach((cancellablePromise) =>
      cancellablePromise.cancel(),
    )
    this.animationPromises.gesture = []

    if (gesture == "neutral") {
      return this.resetHandGesture(durationMs)
    }
    const handConfig: HandConfig = GESTURE_CONFIG[gesture][this.handType]
    const promises: Promise<void>[] = []

    // Set the hand world rotation if specified in the gesture config
    // Cancellations are handled by setRotation directly
    if (handConfig.handRotation) {
      promises.push(this.setRotation(handConfig.handRotation, durationMs))
    }

    // Set the hand position if specified in the gesture config or if a position is provided
    // Cancellations are handled by setPosition directly
    if (handConfig.handPosition || position) {
      if (position) {
        promises.push(this.setPosition(position, durationMs))
      } else if (
        handConfig.handPosition &&
        handConfig.handPosition.coordinates === "world"
      ) {
        promises.push(
          this.setPosition(handConfig.handPosition.value, durationMs),
        )
      } else if (
        handConfig.handPosition &&
        handConfig.handPosition.coordinates === "screen"
      ) {
        promises.push(
          this.setScreenPosition(
            handConfig.handPosition.value,
            handConfig.handPosition.depth,
            durationMs,
          ),
        )
      }
    }

    // Thumb Configuration
    this.animationPromises.gesture.push(
      this.thumbKnuckle.setLocalRotation(
        handConfig.thumb.knuckleAngle,
        durationMs,
      ),
      this.thumbMidJoint.setLocalRotation(
        handConfig.thumb.midjointAngle,
        durationMs,
      ),
    )
    // Index Finger Configuration
    this.animationPromises.gesture.push(
      this.indexKnuckle.setLocalRotation(
        handConfig.index.knuckleAngle,
        durationMs,
      ),
      this.indexMidJoint.setLocalRotation(
        handConfig.index.midjointAngle,
        durationMs,
      ),
      this.indexUpperJoint.setLocalRotation(
        handConfig.index.upperAngle,
        durationMs,
      ),
    )
    // Middle Finger Configuration
    this.animationPromises.gesture.push(
      this.middleKnuckle.setLocalRotation(
        handConfig.middle.knuckleAngle,
        durationMs,
      ),
      this.middleMidJoint.setLocalRotation(
        handConfig.middle.midjointAngle,
        durationMs,
      ),
      this.middleUpperJoint.setLocalRotation(
        handConfig.middle.upperAngle,
        durationMs,
      ),
    )
    // Ring Finger Configuration
    this.animationPromises.gesture.push(
      this.ringKnuckle.setLocalRotation(
        handConfig.ring.knuckleAngle,
        durationMs,
      ),
      this.ringMidJoint.setLocalRotation(
        handConfig.ring.midjointAngle,
        durationMs,
      ),
      this.ringUpperJoint.setLocalRotation(
        handConfig.ring.upperAngle,
        durationMs,
      ),
    )
    // Pinky Finger Configuration
    this.animationPromises.gesture.push(
      this.pinkyKnuckle.setLocalRotation(
        handConfig.pinky.knuckleAngle,
        durationMs,
      ),
      this.pinkyMidJoint.setLocalRotation(
        handConfig.pinky.midjointAngle,
        durationMs,
      ),
      this.pinkyUpperJoint.setLocalRotation(
        handConfig.pinky.upperAngle,
        durationMs,
      ),
    )
    // Split into promises and cancellation functions
    this.animationPromises.gesture.forEach((cancellableAnimationPromise) => {
      promises.push(cancellableAnimationPromise)
    })
    // Wait for all rotations to complete
    await Promise.all(promises)
    this._lastGesture = gesture
  }

  /**
   * Resets all the joints of the hand to the position when initializing Hand.
   * @returns A promise that resolves when the hand is reset.
   */
  async resetHandGesture(
    durationMs: number = DEFAULT_ANIMATION_DURATION_MS,
  ): Promise<void> {
    this.allKeypoints.forEach((keypoint) => {
      this.animationPromises.gesture.push(
        keypoint.resetLocalRotation(durationMs),
      )
    })
    await Promise.all(this.animationPromises.gesture)

    this._lastGesture = "neutral"
  }

  private get middleFingerLength(): number {
    return this.middleTip.position.distance(this.middleKnuckle.position)
  }

  private get thumbIndexDistance(): number {
    return this.thumbTip.position.distance(this.indexTip.position)
  }

  getPinchStrength(): number {
    return clamp(
      1 - this.thumbIndexDistance / RELAXED_THUMB_INDEX_DISTANCE,
      0,
      1,
    )
  }

  /**
   * @returns true if the hand is currently pinching based on the current gesture.
   */
  isPinching(): boolean {
    return (
      this._lastGesture === "pinch" &&
      this.getPinchStrength() > PINCH_STRENGTH_THRESHOLD
    )
  }

  /**
   * @returns true if the hand is visible in the camera's field of view.
   * Approximates the hand as a sphere with the radius of the middle finger length.
   */
  inFOV(): boolean {
    return this.camera.isSphereVisible(
      this.middleKnuckle.position,
      this.middleFingerLength,
    )
  }

  /**
   * The Keypoint of the wrist joint
   */
  get wrist(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.WRIST)
  }

  /**
   * The Keypoint of the thumbToWrist joint (Wrist Joint)
   */
  get thumbToWrist(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.WRIST_TO_THUMB)
  }

  /**
   * The Keypoint of the thumbBaseJoint joint (Thumb Carpometacarpal (CMC) Joint)
   */
  get thumbBaseJoint(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.THUMB_0)
  }

  /**
   * The Keypoint of the thumbKnuckle joint (Thumb Metacarpophalangeal (MCP) Joint)
   */
  get thumbKnuckle(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.THUMB_1)
  }

  /**
   * The Keypoint of the thumbMidJoint joint (Thumb Interphalangeal (IP) Joint)
   */
  get thumbMidJoint(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.THUMB_2)
  }

  /**
   * The Keypoint of the thumbTip joint (Thumb Tip Joint)
   */
  get thumbTip(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.THUMB_3)
  }

  /**
   * The Keypoint of the indexToWrist joint (Wrist Joint)
   */
  get indexToWrist(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.WRIST_TO_INDEX)
  }

  /**
   * The Keypoint of the indexKnuckle joint (Index Metacarpophalangeal (MCP) Joint)
   */
  get indexKnuckle(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.INDEX_0)
  }

  /**
   * The Keypoint of the indexMidJoint joint (Index Proximal Interphalangeal (PIP) Joint)
   */
  get indexMidJoint(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.INDEX_1)
  }
  /**
   * The Keypoint of the indexUpperJoint joint (Index Distal Interphalangeal (DIP) Joint)
   */
  get indexUpperJoint(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.INDEX_2)
  }

  /**
   * The Keypoint of the indexTip joint (Index Tip Joint)
   */
  get indexTip(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.INDEX_3)
  }

  /**
   * The Keypoint of the middleToWrist joint (Wrist Joint)
   */
  get middleToWrist(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.WRIST_TO_MIDDLE)
  }

  /**
   * The Keypoint of the middleKnuckle joint (Middle Metacarpophalangeal (MCP) Joint)
   */
  get middleKnuckle(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.MIDDLE_0)
  }
  /**
   * The Keypoint of the middleMidJoint joint (Middle Proximal Interphalangeal (PIP) Joint)
   */
  get middleMidJoint(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.MIDDLE_1)
  }

  /**
   * The Keypoint of the middleUpperJoint joint (Middle Distal Interphalangeal (DIP) Joint)
   */
  get middleUpperJoint(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.MIDDLE_2)
  }

  /**
   * The Keypoint of the middleTip joint (Middle Tip Joint)
   */
  get middleTip(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.MIDDLE_3)
  }
  /**
   * The Keypoint of the ringToWrist joint (Wrist Joint)
   */
  get ringToWrist(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.WRIST_TO_RING)
  }
  /**
   * The Keypoint of the ringKnuckle joint (Ring Metacarpophalangeal (MCP) Joint)
   */
  get ringKnuckle(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.RING_0)
  }

  /**
   * The Keypoint of the ringMidJoint joint (Ring Proximal Interphalangeal (PIP) Joint)
   */
  get ringMidJoint(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.RING_1)
  }

  /**
   * The Keypoint of the ringUpperJoint joint (Ring Distal Interphalangeal (DIP) Joint)
   */
  get ringUpperJoint(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.RING_2)
  }

  /**
   * The Keypoint of the ringTip joint (Ring Tip Joint)
   */
  get ringTip(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.RING_3)
  }

  /**
   * The Keypoint of the pinkyToWrist joint (Wrist Joint)
   */
  get pinkyToWrist(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.WRIST_TO_PINKY)
  }

  /**
   * The Keypoint of the pinkyKnuckle joint (Pinky Metacarpophalangeal (MCP) Joint)
   */
  get pinkyKnuckle(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.PINKY_0)
  }

  /**
   * The Keypoint of the pinkyMidJoint joint (Pinky Proximal Interphalangeal (PIP) Joint)
   */
  get pinkyMidJoint(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.PINKY_1)
  }

  /**
   * The Keypoint of the pinkyUpperJoint joint (Pinky Distal Interphalangeal (DIP) Joint)
   */
  get pinkyUpperJoint(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.PINKY_2)
  }

  /**
   * The Keypoint of the pinkyTip joint (Pinky Tip Joint)
   */
  get pinkyTip(): KeypointWrapper {
    return this.getKeypoint(LandmarkName.PINKY_3)
  }
}

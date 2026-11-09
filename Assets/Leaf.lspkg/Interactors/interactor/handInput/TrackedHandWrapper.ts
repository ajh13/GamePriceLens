import TrackedHand from "InteractionKit.lspkg/Providers/HandInputData/TrackedHand"
import SIKEvent from "InteractionKit.lspkg/Utils/Event"
import {Hand} from "./Hand"
import {PropertyStore} from "Leaf.lspkg/Utils/common/PropertyStore"
import {INITIAL_HAND_WORLD_TRANSFORMS} from "./handMesh/HandInitialization"
import {setSceneObjectHierarchyTransform} from "Leaf.lspkg/Utils/common/Serialize"
import {setTimeout} from "InteractionKit.lspkg/Utils/FunctionTimingUtils"
import {
  HandMeshType,
  HandVisualSelection,
} from "InteractionKit.lspkg/Components/Interaction/HandVisual/HandVisual"
import {HandVisuals} from "InteractionKit.lspkg/Providers/HandInputData/HandVisuals"
import {UpdateDispatcher} from "Leaf.lspkg/Utils/common/UpdateDispatcher"
import {requireHandRig} from "./HandRig"

const UPDATE_WAIT_MS = 500

interface TrackedHandWrapperHandle {
  hand: TrackedHandWrapper
  destroy: () => void
}

type HandMeshConfig = {
  handMeshType: HandMeshType
  visualSelection: HandVisualSelection
  fullMeshMaterial?: Material
  initialParent: SceneObject
}

/**
 * Wrapper class for managing and manipulating a tracked hand in Leaf.
 */
export default class TrackedHandWrapper {
  private handVisuals: HandVisuals
  private handVisualsRoot: SceneObject

  private initialHandMeshConfig: HandMeshConfig
  private handVisible: boolean = false
  private initialTrackedHand: PropertyStore<TrackedHand>
  private leafHand: Hand
  private unsubscribeTrackingTick: () => void = () => {}

  private constructor(
    private trackedHand: TrackedHand,
    debugMode: boolean = true,
    hand?: Hand,
  ) {
    /* IK can expose the hand rig lazily. */
    const rig = requireHandRig(trackedHand, trackedHand.handType)
    this.handVisuals = rig.visuals
    this.handVisualsRoot = rig.root

    this.initialTrackedHand = new PropertyStore<TrackedHand>(trackedHand)

    this.initialHandMeshConfig = {
      handMeshType: this.handVisuals.meshType,
      visualSelection: this.handVisuals.visualSelection,
      fullMeshMaterial: this.handVisuals.handMeshFull?.mainMaterial,
      initialParent: this.handVisualsRoot.getParent(),
    }
    this.initializeHandVisuals()
    if (debugMode) {
      this.showHandMesh()
    }

    this.leafHand =
      hand ??
      new Hand(
        (this.trackedHand as any).keypoints,
        trackedHand.handType,
        this.handVisualsRoot,
      )

    // Override trackedHand properties to use the leaf hand
    this.trackedHand.getPinchStrength = () => this.hand.getPinchStrength()
    this.trackedHand.isPinching = () => this.hand.isPinching()
    this.trackedHand.isTracked = () => this.isTracked()
    this.trackedHand.isInTargetingPose = () => true

    /* `isTracked` raises IK's onHandFound/onHandLost. IK's mouse-only
     * preview runtime never polls it, which leaves the hand mesh switched
     * off. */
    this.unsubscribeTrackingTick = UpdateDispatcher.getInstance().onUpdate.add(
      () => {
        this.isTracked()
      },
    )
    this.isTracked()
  }

  /**
   * Creates a new instance of TrackedHandWrapper, wrapping the provided TrackedHand instance.
   *
   * @param trackedHand - The TrackedHand instance to wrap.
   * @param debugMode - If true, the hand mesh will be displayed for debugging purposes.
   * @param hand - Optional pre-built {@link Hand} instance to use. When omitted, a plain
   *               {@link Hand} is created from the tracked hand's keypoints.
   *               The caller can obtain the hand visuals root via
   *               `requireHandRig` before calling this method.
   * @returns
   */
  static create(
    trackedHand: TrackedHand,
    debugMode: boolean = true,
    hand?: Hand,
  ): TrackedHandWrapperHandle {
    const handWrapper = new TrackedHandWrapper(trackedHand, debugMode, hand)
    return {
      hand: handWrapper,
      destroy: () => handWrapper.destroy(),
    }
  }

  /**
   * Destroys the tracked hand wrapper, resetting the hand visuals and properties.
   * This method should be called when the hand is no longer needed or before reinitializing it.
   */
  private destroy() {
    this.unsubscribeTrackingTick()
    this.hand.cancelAllAnimations()
    this.handVisuals.visualSelection =
      this.initialHandMeshConfig.visualSelection
    this.handVisuals.handMeshFull.mainMaterial =
      this.initialHandMeshConfig.fullMeshMaterial
    this.handVisuals.meshType = this.initialHandMeshConfig.handMeshType
    this.handVisualsRoot.setParent(this.initialHandMeshConfig.initialParent)

    this.initialTrackedHand.resetProperties()

    /* Reset joints synchronously: restoreHandRigs unloads them after cleanup,
     * so an animated reset would update destroyed transforms. */
    setSceneObjectHierarchyTransform(
      this.handVisualsRoot.getParent(),
      INITIAL_HAND_WORLD_TRANSFORMS[this.trackedHand.handType],
    )

    // Re-enable the ObjectTracking3D component
    this.handVisualsRoot.getParent().getComponent("ObjectTracking3D").enabled =
      true

    // Delay for hand tracking to start again, then fire onTrackingStarted if needed
    setTimeout(() => {
      if (this.trackedHand.isTracked()) {
        this.trackedHand.objectTracking3D.onTrackingStarted()
      }
    }, UPDATE_WAIT_MS)
  }

  private initializeHandVisuals() {
    // Ensure we don't keep reparenting the hand mesh
    if (this.handVisualsRoot.getParent().getComponent("ObjectTracking3D")) {
      // Disable hand tracking
      this.handVisualsRoot
        .getParent()
        .getComponent("ObjectTracking3D").enabled = false
      this.trackedHand.objectTracking3D.onTrackingLost()

      // Ensure hand mesh is reset properly (needed to reset after hand tracking has been used)
      setSceneObjectHierarchyTransform(
        this.handVisualsRoot.getParent(),
        INITIAL_HAND_WORLD_TRANSFORMS[this.trackedHand.handType],
      )
      // Move the hand mesh outside of the hand tracking to ensure it
      this.handVisualsRoot.setParent(
        this.handVisualsRoot.getParent().getParent(),
      )
    }
  }

  /**
   * Displays the hand mesh by setting the main material of the hand mesh to a specified material.
   * Moves the hand outside of hand tracking to ensure the mesh is visible.
   */
  private showHandMesh() {
    this.handVisuals.meshType = HandMeshType.Full
    /* The default selection only renders the mesh near an interactable. Set
     * before the material, because this setter rewrites `mainMaterial`. */
    this.handVisuals.visualSelection = HandVisualSelection.AlwaysOn
    this.handVisuals.handMeshFull.mainMaterial = requireAsset(
      "./handMesh/materials/HandMaterial.mat",
    ) as Material
  }

  /**
   * @returns The hand wrapper that can be used to manipulate the hand gesture.
   */
  get hand(): Hand {
    return this.leafHand
  }

  /**
   * @returns True if the hand is currently tracked (visible in camera FOV), false otherwise.
   * This method also triggers the appropriate events when the hand is found or lost.
   */
  private isTracked(): boolean {
    if (!this.hand) {
      return false
    }
    const visible = this.hand.inFOV()
    if (this.handVisible === visible) {
      return visible
    }
    this.handVisible = visible
    const event = (
      visible ? this.trackedHand.onHandFound : this.trackedHand.onHandLost
    ) as SIKEvent
    event.invoke()
    return visible
  }

  /**
   * Move the hand to a given world position (based on the wrist).
   * @param position - The target position to move the hand scene object to.
   * @param transitionDurationMs - The duration to transition to {@link position}.
   */
  setPosition(position: vec3, transitionDurationMs: number): Promise<void> {
    return this.hand.setPosition(position, transitionDurationMs)
  }

  /**
   * Set the world rotation of the hand (based on the wrist).
   * @param rotation - The target local rotation as a quat.
   * @param durationMs - The duration to transition to {@link rotation}.
   */
  setRotation(rotation: quat, durationMs: number): Promise<void> {
    return this.hand.setRotation(rotation, durationMs)
  }
}

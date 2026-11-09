import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {HandType} from "InteractionKit.lspkg/Providers/HandInputData/HandType"
import {InteractorInputType} from "InteractionKit.lspkg/Core/Interactor/Interactor"
import {Keypoint} from "InteractionKit.lspkg/Providers/HandInputData/Keypoint"
import {IK} from "InteractionKit.lspkg/IK"
import TrackedHand from "InteractionKit.lspkg/Providers/HandInputData/TrackedHand"
import WorldCameraFinderProvider from "InteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import {FINGERTIP_SPHERECAST_RADIUS} from "InteractionKit.lspkg/Core/Interactor/FingertipConstants"
import {RaycastInfo} from "InteractionKit.lspkg/Core/Interactor/RayProvider"

import {UserInputSuppressor} from "../UserInputSuppressor"
import {IKHand} from "./IKHand"
import {DirectInteraction} from "./DirectInteraction"
import {IndirectInteraction} from "./IndirectInteraction"
import TrackedHandWrapper from "../handInput/TrackedHandWrapper"
import {requireHandRig} from "../handInput/HandRig"
import {VERTICAL_HAND_ROTATION} from "../handInput/Gestures"
import {makeEventPromise, nextFrame} from "Leaf.lspkg/Utils/common/Utils"
import {
  CheckableDiagnostic,
  DiagnosticRecorder,
  InteractionStrategy,
} from "Leaf.lspkg/Diagnostic/DiagnosticRecorder"
import {withTimeoutOrRecord} from "Leaf.lspkg/Diagnostic/categories/ConvergenceTimeout"
import {ReachContext} from "Leaf.lspkg/Diagnostic/ReachContext"
import {TargetMissing} from "Leaf.lspkg/Diagnostic/categories/TargetMissing"
import {TargetOverlap} from "Leaf.lspkg/Diagnostic/categories/TargetOverlap"
import {ReachMarginal} from "Leaf.lspkg/Diagnostic/categories/ReachMarginal"
import {UnreachableBehind} from "Leaf.lspkg/Diagnostic/categories/UnreachableBehind"
import {UnreachableFarDirect} from "Leaf.lspkg/Diagnostic/categories/UnreachableFarDirect"
import {UnreachableFarIndirect} from "Leaf.lspkg/Diagnostic/categories/UnreachableFarIndirect"
import {UnreachableCrossBody} from "Leaf.lspkg/Diagnostic/categories/UnreachableCrossBody"
import {
  ArmKeypoints,
  ArmModel,
  FOREARM_LENGTH_CM,
  UPPER_ARM_LENGTH_CM,
  WRIST_MAX_REACH_CM,
} from "Leaf.lspkg/IKSolver/ArmModel"
import {IndexFingerModel} from "Leaf.lspkg/IKSolver/IndexFingerModel"
import {HandFingerKeypoints} from "Leaf.lspkg/IKSolver/BodyController"
import {JointPose} from "Leaf.lspkg/IKSolver/Pose"
import {computePokeEndPoint} from "Leaf.lspkg/IKSolver/PokeTarget"
import {TargetingRayProvider} from "./TargetingRayProvider"

const HOVER_ENTER_TIMEOUT_MS = 3000
const TRIGGER_END_TIMEOUT_MS = 1000
/** Frames to hold the pinch so IK can register trigger start/end. */
const PINCH_HOLD_FRAMES = 3
/** Duration over which fingers relax back from a pinch after the trigger completes (ms). */
const RELAX_GESTURE_MS = 200
/** Lateral offset (cm) past the body midline before flagging through-body. */
const MIDLINE_CROSS_THRESHOLD_CM = 25
/** Elbow angle (degrees) at or above which a target is flagged as marginal — 180° = fully locked. */
const MARGINAL_ELBOW_DEG = 165
/** Mirrors IK's `BaseInteractor._maxRaycastDistance` default — beyond this, indirect targeting can't ray-hit. */
const INDIRECT_MAX_DISTANCE_CM = 500

type ProximitySensor = {
  getOverlappingColliders(): ColliderComponent[]
  onOverlapStay?: {
    add?(
      callback: (overlap: ColliderComponent) => void,
    ): (() => void) | undefined
  }
  onOverlapExit?: {
    add?(
      callback: (overlap: ColliderComponent) => void,
    ): (() => void) | undefined
  }
}

type PhysicalInteractionProvider = {
  ownerSceneObject?: SceneObject
  getHandNearbyPosition(): vec3
  getPokeEndPoint?(): vec3
  getPokeStartPoint?(): vec3
  nearbyInteractables?: Set<Interactable>
  indexFingerProximitySensor?: ProximitySensor
}

type SIKHandInteractor = {
  preventTargetUpdate?: () => boolean
  physicalInteractionProvider?: PhysicalInteractionProvider
  handRayProvider?: {
    getRaycastInfo(): RaycastInfo
    isAvailable(): boolean
    reset(): void
  }
  currentInteractable?: Interactable | null
}

/**
 * Wraps a proximity sensor's {@link ProximitySensor.getOverlappingColliders} so that
 * colliders which have entered remain reported until they explicitly exit — survives
 * brief gaps in the underlying overlap query. Used to keep direct-target proximity
 * stable while the IK arm settles.
 */
class ProximitySensorPatch {
  private readonly _stayingColliders = new Set<ColliderComponent>()
  private readonly _originalGetOverlappingColliders: () => ColliderComponent[]
  private readonly _unsubscribeStay?: () => void
  private readonly _unsubscribeExit?: () => void

  constructor(private readonly _sensor: ProximitySensor) {
    this._originalGetOverlappingColliders =
      _sensor.getOverlappingColliders.bind(_sensor)
    this._unsubscribeStay = _sensor.onOverlapStay?.add?.(
      (overlap: ColliderComponent) => {
        this._stayingColliders.add(overlap)
      },
    )
    this._unsubscribeExit = _sensor.onOverlapExit?.add?.(
      (overlap: ColliderComponent) => {
        this._stayingColliders.delete(overlap)
      },
    )
    _sensor.getOverlappingColliders = (): ColliderComponent[] =>
      this._stayingColliders.size > 0
        ? Array.from(this._stayingColliders)
        : this._originalGetOverlappingColliders()
  }

  dispose(): void {
    this._unsubscribeStay?.()
    this._unsubscribeExit?.()
    this._stayingColliders.clear()
    this._sensor.getOverlappingColliders = this._originalGetOverlappingColliders
  }
}

/**
 * IK-driven hand interactor. Owns the {@link ArmModel} simulation, patches the
 * IK side (hand interactor + physical/indirect providers) so it can drive
 * triggers in preview without real hand tracking, and dispatches each trigger
 * to {@link DirectInteraction} or {@link IndirectInteraction} based on whether the
 * target is within arm reach.
 *
 * The two strategies receive their state/setters through host structs built in
 * the constructor — no public mutators leak from this class.
 */
export class IKHandInteractor {
  private readonly _hand: IKHand
  private readonly _armModel: ArmModel
  private readonly _cameraProvider = WorldCameraFinderProvider.getInstance()
  private readonly _targetingRayProvider = new TargetingRayProvider()
  private readonly _fingerModel = new IndexFingerModel()
  private readonly _cleanup: (() => void)[] = []
  private readonly _directInteraction: DirectInteraction
  private readonly _indirectInteraction: IndirectInteraction
  private readonly _trackedHand: TrackedHand
  private _handWrapperDestroy?: () => void
  /** Latest keypoints from {@link ArmModel.update}; `undefined` until the wrist is active. */
  private _lastKeypoints?: ArmKeypoints
  private _provider?: PhysicalInteractionProvider
  private _handInteractor?: SIKHandInteractor
  private _proximitySensorPatch?: ProximitySensorPatch
  private _shouldPreventTargetUpdate = false
  private _indexTipAttachTransform?: Transform
  private _idleWristPose?: () => JointPose | undefined
  private _triggerInFlight = false

  constructor(readonly handType: HandType) {
    const trackedHand = IK.HandInputData.getHand(handType) as TrackedHand
    if (!trackedHand) throw new Error(`Hand of type ${handType} not found`)
    this._trackedHand = trackedHand

    const {root: handVisualsRoot} = requireHandRig(trackedHand, handType)
    this._armModel = new ArmModel(handType === "left")
    // `TrackedHand.keypoints` is declared `private` in IK but we need
    // the keypoint map to drive `IKHand` (which extends IK's `Hand`).
    const sikKeypoints = (
      trackedHand as unknown as {keypoints: Map<string, Keypoint>}
    ).keypoints
    this._hand = new IKHand(
      sikKeypoints,
      handType,
      handVisualsRoot,
      this._armModel,
    )
    ;({destroy: this._handWrapperDestroy} = TrackedHandWrapper.create(
      trackedHand,
      true,
      this._hand,
    ))
    this._hand.hide()
    this._hand.setRotation(VERTICAL_HAND_ROTATION[handType])
    this._hand.makeGesture("relaxed")

    this._directInteraction = new DirectInteraction({
      hand: this._hand,
      cameraProvider: this._cameraProvider,
      handType: this.handType,
      isAlive: () => this._handWrapperDestroy !== undefined,
      removeFromNearbyInteractables: (target: Interactable) => {
        this._provider?.nearbyInteractables?.delete(target)
      },
      pinchAndAwaitTriggerEnd: (target, hoverEntered) =>
        this.pinchAndAwaitTriggerEnd(target, hoverEntered),
      finishTrigger: () => this.finishTrigger(),
    })

    const self = this
    this._indirectInteraction = new IndirectInteraction({
      hand: this._hand,
      armModel: this._armModel,
      cameraProvider: this._cameraProvider,
      handType: this.handType,
      targetingRayProvider: this._targetingRayProvider,
      get lastKeypoints() {
        return self._lastKeypoints
      },
      get currentInteractable() {
        return self._handInteractor?.currentInteractable ?? undefined
      },
      isAlive: () => this._handWrapperDestroy !== undefined,
      pinchAndAwaitTriggerEnd: (target, hoverEntered) =>
        this.pinchAndAwaitTriggerEnd(target, hoverEntered),
      finishTrigger: () => this.finishTrigger(),
    })
    this._cleanup.push(() => this._indirectInteraction.dispose())

    this.patchSIKHandInteractor()
  }

  /**
   * Run `fn` over every IK hand-visual mesh. Logs a warning and
   * no-ops if IK hand visuals haven't initialized yet (a footgun: a
   * customization would silently vanish if called before IK's setup).
   *
   * @param callerName - Name of the public method, used in the warning.
   * @param fn - Invoked once per mesh.
   */
  private forEachHandMesh(
    callerName: string,
    fn: (mesh: RenderMeshVisual) => void,
  ): void {
    const handVisuals = this._trackedHand.getHandVisuals?.()
    if (isNull(handVisuals)) {
      print(
        `[IKHandInteractor:${this.handType}] ${callerName} skipped — IK hand visuals not initialized yet`,
      )
      return
    }
    for (const mesh of [
      handVisuals.handMesh,
      handVisuals.handMeshFull,
      handVisuals.handMeshIndexThumb,
      handVisuals.handMeshPin,
    ]) {
      if (!isNull(mesh)) fn(mesh)
    }
  }

  /**
   * Show or hide IK's tracked-hand visual meshes (`handMesh`,
   * `handMeshFull`, `handMeshIndexThumb`, `handMeshPin`). The tracking
   * hierarchy itself stays active — only the rendered meshes are
   * toggled, so IK position reads continue to work.
   *
   * @param enabled - `true` to show, `false` to hide.
   */
  setHandVisualsEnabled(enabled: boolean): void {
    this.forEachHandMesh("setHandVisualsEnabled", (mesh) => {
      mesh.enabled = enabled
    })
  }

  /**
   * Provide a callback that returns the desired wrist pose for this
   * hand when no direct target is active. Called every frame in
   * {@link updateArm}. Use this to make the IK hand follow an idle
   * animation on another rig (e.g. the Bitmoji avatar's wrist) when the
   * user isn't actively interacting.
   *
   * @param getter - Per-frame wrist-pose getter, or `undefined` to clear.
   */
  setIdleWristPoseGetter(
    getter: (() => JointPose | undefined) | undefined,
  ): void {
    this._idleWristPose = getter
  }

  /**
   * Tint IK's tracked-hand visual meshes by replacing each material with
   * a clone whose `baseColor` is set to `color`. Cloning ensures we don't
   * mutate shared IK materials that other hands rely on.
   *
   * @param color - RGBA tint applied to each mesh's `baseColor`.
   */
  setHandVisualsColor(color: vec4): void {
    this.forEachHandMesh("setHandVisualsColor", (mesh) =>
      tintMeshMaterials(mesh, color),
    )
  }

  /**
   * Replace each IK hand-visual mesh's materials so the IK hand uses
   * the same shader + texture as another rig (e.g. the Bitmoji body
   * skin). The same instance is shared across all four hand meshes.
   *
   * @param material - Shared material applied to every hand mesh.
   */
  setHandVisualsMaterial(material: Material): void {
    this.forEachHandMesh("setHandVisualsMaterial", (mesh) =>
      replaceMeshMaterials(mesh, material),
    )
  }

  /**
   * Set the render layer on every IK hand-visual mesh's SceneObject so
   * the hand renders on the given layer set (e.g. both the main camera
   * layer and an overlay-only debug layer).
   *
   * @param layer - Target layer set for every hand mesh.
   */
  setHandVisualsLayer(layer: LayerSet): void {
    this.forEachHandMesh("setHandVisualsLayer", (mesh) => {
      mesh.getSceneObject().layer = layer
    })
  }

  /**
   * @returns Latest wrist pose from the most recent {@link updateArm},
   *   or `undefined` while the arm is at rest.
   */
  get currentWristPose(): JointPose | undefined {
    const wrist = this._lastKeypoints?.wrist
    if (!wrist?.position || !wrist.rotation) return undefined
    return {position: wrist.position, rotation: wrist.rotation}
  }

  /**
   * Suitable for driving an external arm rig (e.g. Bitmoji) via 2-bone IK.
   *
   * @returns Latest full arm IK chain (shoulder + elbow + wrist) from
   *   the most recent {@link updateArm}, or `undefined` while the arm is
   *   at rest.
   */
  get currentArmKeypoints(): ArmKeypoints | undefined {
    return this._lastKeypoints
  }

  /**
   * Used to drive an external finger rig — direct read of IK's
   * TrackedHand keypoints without going through ArmModel.
   *
   * @returns Per-finger keypoint positions for the live tracked hand,
   *   or `undefined` when the tracked hand isn't enabled.
   */
  get currentFingerKeypoints(): HandFingerKeypoints | undefined {
    const trackedHand = this._trackedHand
    if (!trackedHand.enabled) return undefined
    return {
      /**
       * Thumb has only 3 bones (no proximal phalanx like other fingers),
       * so the IK keypoints are offset by one: thumbBaseJoint is the
       * analog of the other fingers' "knuckle" (start of Thumb1), and
       * the chain runs base → knuckle → midJoint → tip.
       */
      thumb: {
        knuckle: trackedHand.thumbBaseJoint.position,
        midJoint: trackedHand.thumbKnuckle.position,
        upperJoint: trackedHand.thumbMidJoint.position,
        tip: trackedHand.thumbTip.position,
      },
      index: {
        knuckle: trackedHand.indexKnuckle.position,
        midJoint: trackedHand.indexMidJoint.position,
        upperJoint: trackedHand.indexUpperJoint.position,
        tip: trackedHand.indexTip.position,
      },
      middle: {
        knuckle: trackedHand.middleKnuckle.position,
        midJoint: trackedHand.middleMidJoint.position,
        upperJoint: trackedHand.middleUpperJoint.position,
        tip: trackedHand.middleTip.position,
      },
      ring: {
        knuckle: trackedHand.ringKnuckle.position,
        midJoint: trackedHand.ringMidJoint.position,
        upperJoint: trackedHand.ringUpperJoint.position,
        tip: trackedHand.ringTip.position,
      },
      pinky: {
        knuckle: trackedHand.pinkyKnuckle.position,
        midJoint: trackedHand.pinkyMidJoint.position,
        upperJoint: trackedHand.pinkyUpperJoint.position,
        tip: trackedHand.pinkyTip.position,
      },
      pinchStrength: this._hand.getPinchStrength(),
    }
  }

  /**
   * Integrate one frame of arm physics. Called by {@link IKBodyInteractor} after
   * HeadController has produced the active head pose for this frame.
   *
   * @param headPose  - Current head pose (post HeadController smoothing).
   * @param deltaTime - Frame delta in seconds.
   */
  updateArm(headPose: JointPose, deltaTime: number): void {
    if (!this._handWrapperDestroy) return

    this.tryPatchProximitySensor()

    if (!this._indexTipAttachTransform) {
      this._indexTipAttachTransform = (this._hand.indexTip as any).keypoint
        ?.getAttachmentPoint?.()
        ?.getTransform?.()
    }
    const tipUp = this._indexTipAttachTransform
      ? this._indexTipAttachTransform.up
      : vec3.up()

    /** Aim per-frame — `wristPositionForPinchAt` needs the latest hand rotation. */
    const directAimPoint = this._directInteraction.currentAimPoint
    if (directAimPoint !== undefined) {
      this._armModel.setTarget({
        position: this._hand.wristPositionForPinchAt(directAimPoint),
      })
    }

    const arm = this._armModel.update(
      headPose,
      deltaTime,
      this._hand.worldPosition,
    )
    this._lastKeypoints = arm

    /**
     * When this hand has no interaction target and an idle wrist-pose
     * getter is registered (e.g. a Bitmoji wrist driven by an idle
     * animation), drive IK's hand state to that pose via
     * `_hand.setPosition` so the visual, attachment points, proximity
     * sensor, and pinch detector all move together.
     *
     * `_triggerInFlight` is hand-local, so the other side keeps idling
     * when this one is running a trigger (and vice versa).
     */
    const indirectRay = this._indirectInteraction.currentRay
    const hasInteractionTarget =
      this._triggerInFlight ||
      directAimPoint !== undefined ||
      indirectRay !== undefined
    const idlePose = hasInteractionTarget ? undefined : this._idleWristPose?.()
    if (idlePose !== undefined) {
      this._hand.setPosition(idlePose.position)
      this._hand.applyRotation(idlePose.rotation)
    } else {
      if (arm.wrist.position !== undefined)
        this._hand.setPosition(arm.wrist.position)
      this._hand.applyRotation(arm.wrist.rotation)
    }

    this._fingerModel.update(
      this._hand.indexTip.position,
      this._hand.indexUpperJoint.position,
      tipUp,
      this._hand.worldPosition,
    )

    /**
     * PhysicalInteractionProvider's update() runs before updateArm() each frame, so it
     * sets ownerSceneObject to the pre-arm-update indexTip position. Correct it here so
     * ownerSceneObject always sits at the post-arm-update indexTip for proximity detection.
     */
    this._provider?.ownerSceneObject
      ?.getTransform()
      .setWorldPosition(this._fingerModel.keypoints!.tipPosition)
  }

  /**
   * Triggers `target` with a pinch.
   *
   * Path is physics-driven, not a hard-coded distance: if the target is beyond
   * the arm's max reach, route to the indirect strategy (IK-aimed targeting
   * ray → IK indirect raycast). Otherwise use the direct strategy (poke
   * geometry → IK physical proximity).
   *
   * Shoulder for the reach test comes from {@link ArmModel.bodyAnchors} so we
   * don't depend on the wrist having been active yet.
   *
   * `hoverEntered` is set up here BEFORE any motion so we still catch the event
   * if IK fires it during the approach.
   *
   * @param target - The interactable to trigger.
   * @param isIndirect - Pre-computed strategy decision; pass it so a head
   *   turn between decision and trigger can't flip the strategy.
   * @returns `true` once the trigger sequence finished, `false` when reach
   *   checks recorded an error and the `fallback` policy aborted the arm
   *   motion. Callers (e.g. `IKBodyInteractor`) use the `false` return to
   *   route the action through the configured IK fallback instead.
   */
  async trigger(
    target: Interactable,
    isIndirect: boolean = this.isIndirect(target),
  ): Promise<boolean> {
    /** Reach checks record diagnostics; the recorder throws on `fail-fast` so we never see the return there. For `fallback`, `anyError` is true and the caller routes to the fallback so downstream events still fire. */
    const anyError = this.runReachChecks(
      target,
      "trigger",
      isIndirect ? "indirect" : "direct",
    )
    if (anyError) return false

    const strategy = isIndirect
      ? this._indirectInteraction
      : this._directInteraction

    const [hoverEntered, cancelHoverEnter] = makeEventPromise(
      target.onHoverEnter,
    )
    this._triggerInFlight = true
    try {
      await strategy.trigger(target, hoverEntered)
    } finally {
      this._triggerInFlight = false
      cancelHoverEnter()
    }
    return true
  }

  /**
   * Build the per-side reach context from the latest body anchors. Returns
   * `undefined` if the arm model hasn't produced anchors yet (first frame).
   */
  private reachContextFor(
    target: Interactable,
    operation: string,
    strategy: InteractionStrategy,
  ): ReachContext | undefined {
    const keypoints = this._lastKeypoints
    if (keypoints === undefined) return undefined
    return {
      target,
      handSide: this.handType,
      operation,
      strategy,
      shoulder: keypoints.shoulder,
      headPosition: keypoints.headPosition,
      bodyCenter: keypoints.neck,
      wristTargetWorld: this._hand.wristPositionForPinchAt(
        target.getSceneObject().getTransform().getWorldPosition(),
      ),
      bodyForward: keypoints.bodyForward,
      bodyDown: keypoints.bodyDown,
      bodyRight: keypoints.bodyRight,
    }
  }

  /**
   * Run the reachability checks for diagnostic reporting. Records any
   * matching category into {@link DiagnosticRecorder}.
   *
   * The check subset depends on `strategy` — chain/arm checks only apply
   * to direct interactions; indirect just verifies IK's raycast cap.
   *
   * @returns `true` when any error-severity reach diagnostic fired. The
   *   caller should treat this as "arm cannot serve this target" and skip
   *   the actual motion (so the avatar doesn't visibly reach for an
   *   unreachable point). Warnings like `ReachMarginal` don't trigger
   *   the abort.
   */
  private runReachChecks(
    target: Interactable,
    operation: string,
    strategy: InteractionStrategy,
  ): boolean {
    const context = this.reachContextFor(target, operation, strategy)
    if (context === undefined) return false
    const checks: CheckableDiagnostic[] =
      strategy === "direct"
        ? [
            new UnreachableFarDirect(context, WRIST_MAX_REACH_CM),
            new UnreachableBehind(context),
            new UnreachableCrossBody(context, MIDLINE_CROSS_THRESHOLD_CM),
            new ReachMarginal(
              context,
              UPPER_ARM_LENGTH_CM,
              FOREARM_LENGTH_CM,
              MARGINAL_ELBOW_DEG,
            ),
          ]
        : [new UnreachableFarIndirect(context, INDIRECT_MAX_DISTANCE_CM)]
    const recorder = DiagnosticRecorder.getInstance()
    let unreachable = false
    /** Run every check (no `break`) so one fired error doesn't mask a separate error category on the same target. */
    for (const check of checks) {
      if (recorder.checkAndRecord(check) && check.severity === "error") {
        unreachable = true
      }
    }
    return unreachable
  }

  /**
   * Pinch-and-drag `target` by `delta`.
   *
   * - `vec3` delta → world-space cm offset.
   * - `vec2` delta → target's `ScreenTransform` anchor frame; resolved to
   *   world via the target's local axes so it follows the panel orientation.
   *
   * Indirect drag is a first-order approximation — the hit-point shift on
   * `target` is scaled by `cervicalToTarget / cervicalToWrist`. Loop until
   * a widget-side predicate is met for precise endpoints.
   *
   * @param target - The interactable to drag.
   * @param delta  - Drag offset; world (vec3) or target-screen (vec2).
   * @returns `true` once the drag finished, `false` when reach checks
   *   recorded an error and the `fallback` policy aborted the arm motion.
   *   Callers route to the IK fallback on `false`.
   */
  async drag(
    target: Interactable,
    delta: vec2 | vec3,
    afterConvergence?: () => Promise<void>,
    gripOffset?: vec3,
  ): Promise<boolean> {
    const isIndirect = this.isIndirect(target)
    const anyError = this.runReachChecks(
      target,
      "drag",
      isIndirect ? "indirect" : "direct",
    )
    if (anyError) return false

    const strategy = isIndirect
      ? this._indirectInteraction
      : this._directInteraction
    const worldDelta = resolveWorldDelta(target, delta)
    const [hoverEntered, cancelHoverEnter] = makeEventPromise(
      target.onHoverEnter,
    )
    this._triggerInFlight = true
    try {
      await strategy.drag(
        target,
        worldDelta,
        hoverEntered,
        afterConvergence,
        gripOffset,
      )
    } finally {
      this._triggerInFlight = false
      cancelHoverEnter()
    }
    return true
  }

  /**
   * @param target - The interactable to test.
   * @returns `true` if `target` is beyond arm reach from the IK shoulder.
   */
  isIndirect(target: Interactable): boolean {
    const cameraTransform = this._cameraProvider.getComponent().getTransform()
    const headPose: JointPose = {
      position: cameraTransform.getWorldPosition(),
      rotation: cameraTransform.getWorldRotation(),
    }
    const {shoulder} = this._armModel.bodyAnchors(headPose)
    const targetPosition = target
      .getSceneObject()
      .getTransform()
      .getWorldPosition()
    return targetPosition.sub(shoulder).length > WRIST_MAX_REACH_CM
  }

  /**
   * Stops arm physics, restores patched IK internals, and releases all resources.
   * Idempotent.
   */
  destroy(): void {
    if (!this._handWrapperDestroy) return
    for (let i = this._cleanup.length - 1; i >= 0; i--) this._cleanup[i]()
    this._handWrapperDestroy()
    this._handWrapperDestroy = undefined
  }

  /**
   * Shared pinch + trigger-end sequence used by both trigger strategies:
   *
   *   1. Await `hoverEntered` (set up by {@link trigger} before any IK motion).
   *   2. Subscribe to `onTriggerEnd` + `onTriggerEndOutside` before pinching so
   *      we catch them even if the interactor briefly loses the target.
   *   3. Pinch and hold for {@link PINCH_HOLD_FRAMES}.
   *   4. Release, freeze the target for one IK frame, then await trigger end.
   */
  private async pinchAndAwaitTriggerEnd(
    target: Interactable,
    hoverEntered: Promise<void>,
  ): Promise<void> {
    const recorder = DiagnosticRecorder.getInstance()
    /** Target was destroyed before we got to await hoverEnter — record the destruction instead. */
    if (
      recorder.checkAndRecord(new TargetMissing(target, "pinch", this.handType))
    )
      return
    const targetName = target.getSceneObject().name
    await withTimeoutOrRecord(hoverEntered, HOVER_ENTER_TIMEOUT_MS, {
      handSide: this.handType,
      interactableName: targetName,
      message: `[IK ${this.handType}] hoverEnter timed out for "${targetName}"`,
    })

    /** IK fires trigger events on whatever it reports as currentInteractable (may be a descendant of `target` per rayHitMatches). Fall back to `target` if IK isn't reporting one yet. IK types this as `Interactable | null` — normalize null/undefined to undefined. */
    const sikCurrent = this._handInteractor?.currentInteractable
    const currentInteractable = isNull(sikCurrent)
      ? undefined
      : (sikCurrent as Interactable)
    const effectiveTarget = currentInteractable ?? target
    if (currentInteractable !== undefined && currentInteractable !== target) {
      const resolvedSceneObject = currentInteractable.getSceneObject()
      const resolvedName = isNull(resolvedSceneObject)
        ? "<unknown>"
        : resolvedSceneObject.name
      recorder.record(
        new TargetOverlap(this.handType, "pinch", targetName, resolvedName),
      )
    }
    const [triggerEnd, cancelTriggerEnd] = makeEventPromise(
      effectiveTarget.onTriggerEnd,
    )
    const [triggerEndOutside, cancelTriggerEndOutside] = makeEventPromise(
      effectiveTarget.onTriggerEndOutside,
    )
    const triggerEndPromise = Promise.race([triggerEnd, triggerEndOutside])
    /* The pinch frames can be cancelled before this race is awaited. */
    triggerEndPromise.catch(() => {})

    try {
      this._hand.setPinching(true)
      for (let i = 0; i < PINCH_HOLD_FRAMES; i++) await nextFrame()

      /**
       * Freeze PhysicalInteractionProvider for one IK frame after isPinching() goes false.
       * Without this, shouldPreventTargetUpdate becomes false and processTriggerEvents fires
       * onTriggerEnd on whichever interactable PhysicalInteractionProvider now sees — not
       * necessarily the button we just triggered.
       */
      this._shouldPreventTargetUpdate = true
      this._hand.setPinching(false)
      await nextFrame()
      this._shouldPreventTargetUpdate = false

      /** Target was destroyed between pinch and trigger-end — record the destruction; the trigger-end event won't fire. */
      if (
        recorder.checkAndRecord(
          new TargetMissing(effectiveTarget, "pinch", this.handType),
        )
      )
        return
      const effectiveName = effectiveTarget.getSceneObject().name
      await withTimeoutOrRecord(triggerEndPromise, TRIGGER_END_TIMEOUT_MS, {
        handSide: this.handType,
        interactableName: effectiveName,
        message: `[IK ${this.handType}] triggerEnd timed out for "${effectiveName}"`,
      })
    } finally {
      cancelTriggerEnd()
      cancelTriggerEndOutside()
    }
  }

  /**
   * Shared cleanup invoked by both strategies in their `finally` blocks. Resets
   * the target-update guard, releases any held pinch, clears the wrist target
   * so the arm returns to rest, restores the baseline vertical hand rotation
   * (so the hand isn't left at `PINCH_ROTATION` after a trigger), and animates
   * the fingers back to the relaxed baseline so IK sees a non-pinch before
   * the next {@link trigger}.
   */
  private async finishTrigger(): Promise<void> {
    this._shouldPreventTargetUpdate = false
    this._hand.setPinching(false)
    this._armModel.setTarget({position: undefined})
    await Promise.all([
      this._hand.setRotation(VERTICAL_HAND_ROTATION[this.handType]),
      this._hand.makeGesture("relaxed", undefined, RELAX_GESTURE_MS),
    ])
    await nextFrame()
  }

  // ── IK patches ───────────────────────────────────────────────────────

  private patchSIKHandInteractor(): void {
    const handInputType =
      this.handType === "left"
        ? InteractorInputType.LeftHand
        : InteractorInputType.RightHand
    const handInteractors =
      IK.InteractionManager.getInteractorsByType(handInputType)
    if (handInteractors.length === 0) {
      print(
        `[IKHandInteractor] No ${this.handType} hand interactors found — IK patches will not be applied`,
      )
      return
    }

    /* Same interactor, two views: the full IK type for the suppressor, the
     * narrow structural type below for patching. */
    const sikInteractor = handInteractors[0]
    const handInteractor = sikInteractor as SIKHandInteractor
    this._handInteractor = handInteractor
    /* IK drives IK's own targeting pipeline, so this interactor must stay
     * enabled while user input is suppressed. Real hands can't reach it: the
     * `TrackedHandWrapper` built above disables the hand's `ObjectTracking3D`
     * component and routes `isPinching`/`getPinchStrength`/`isTracked` to the
     * IK hand, so this interactor only ever sees LEAF-driven joint data. */
    UserInputSuppressor.getInstance().allow(sikInteractor)
    /** Compose with IK's pinch lock rather than replacing it — overriding alone dropped IK's `isPinching() || isPoking()` lock and let the cursor drift off the target during the hold. */
    const originalPreventTargetUpdate =
      handInteractor.preventTargetUpdate.bind(handInteractor)
    handInteractor.preventTargetUpdate = () =>
      this._shouldPreventTargetUpdate || originalPreventTargetUpdate()
    this._cleanup.push(() => {
      delete handInteractor.preventTargetUpdate
    })

    const provider = handInteractor.physicalInteractionProvider
    if (!provider) return

    this._provider = provider

    const originalGetHandNearbyPosition =
      provider.getHandNearbyPosition.bind(provider)
    provider.getHandNearbyPosition = () => this._hand.indexTip.position

    /**
     * ObjectTracking3D resets bone positions every frame before
     * PhysicalInteractionProvider runs, so its indexTip keypoint always
     * reflects the pre-update position. Use IK keypoints instead.
     */
    provider.getPokeEndPoint = (): vec3 => {
      /**
       * Aim the poke spherecast at the active direct aim point — the
       * target world position during a `trigger`, the moving waypoint
       * during a `drag`. {@link DirectInteraction.currentAimPoint}
       * unifies both.
       */
      const targetPosition = this._directInteraction.currentAimPoint
      return this._fingerModel.keypoints
        ? computePokeEndPoint(
            this._fingerModel.keypoints,
            FINGERTIP_SPHERECAST_RADIUS,
            targetPosition,
          )
        : this._hand.indexTip.position
    }

    provider.getPokeStartPoint = (): vec3 =>
      this._fingerModel.keypoints?.upperJointPosition ??
      this._hand.indexUpperJoint.position

    this._cleanup.push(() => {
      provider.getHandNearbyPosition = originalGetHandNearbyPosition
      delete provider.getPokeEndPoint
      delete provider.getPokeStartPoint
    })
  }

  /**
   * Created lazily once {@link PhysicalInteractionProvider.indexFingerProximitySensor}
   * becomes available (it's populated on the first call to the provider's
   * `updateIndexFingerDetection`). Called each frame from {@link updateArm}.
   */
  private tryPatchProximitySensor(): void {
    if (!this._provider || this._proximitySensorPatch) return
    const sensor = this._provider.indexFingerProximitySensor
    if (!sensor) return
    this._proximitySensorPatch = new ProximitySensorPatch(sensor)
    this._cleanup.push(() => this._proximitySensorPatch!.dispose())
  }
}

function replaceMeshMaterials(
  mesh: RenderMeshVisual,
  material: Material,
): void {
  mesh.clearMaterials()
  mesh.addMaterial(material)
}

/**
 * Material main-pass property names we'll set to apply a tint. We don't
 * know which shader the IK hand uses, so we try each property in turn.
 */
const COLOR_PASS_PROPERTIES = ["baseColor", "color"] as const

function tintMeshMaterials(mesh: RenderMeshVisual, color: vec4): void {
  const count = mesh.getMaterialsCount()
  const clones: Material[] = []
  for (let i = 0; i < count; i++) {
    const cloned = mesh.getMaterial(i).clone()
    const pass = cloned.mainPass as unknown as Record<string, unknown>
    for (const property of COLOR_PASS_PROPERTIES) {
      if (property in pass) pass[property] = color
    }
    clones.push(cloned)
  }
  mesh.clearMaterials()
  for (const c of clones) mesh.addMaterial(c)
}

/**
 * Convert a drag delta to a world-space vector.
 *
 * - `vec3` → world cm as-is.
 * - `vec2` → resolved through the target's `ScreenTransform` so the
 *   delta's X/Y follow the panel's local right/up axes (so a tilted
 *   panel still scrolls along its own axes).
 *
 * For a `vec2` delta on a target without a `ScreenTransform`, throws —
 * callers should pass a `vec3` for non-UI targets.
 */
export function resolveWorldDelta(
  target: Interactable,
  delta: vec2 | vec3,
): vec3 {
  if ("z" in delta) return delta
  const screenTransform = target
    .getSceneObject()
    .getComponent("Component.ScreenTransform") as ScreenTransform | null
  if (isNull(screenTransform)) {
    throw new Error(
      `[IKHandInteractor] vec2 drag delta requires a ScreenTransform on "${target.getSceneObject().name}"; pass vec3 for world-space targets.`,
    )
  }
  const center = screenTransform.localPointToWorldPoint(vec2.zero())
  const right = screenTransform.localPointToWorldPoint(vec2.right()).sub(center)
  const up = screenTransform.localPointToWorldPoint(vec2.up()).sub(center)
  return right.uniformScale(delta.x).add(up.uniformScale(delta.y))
}

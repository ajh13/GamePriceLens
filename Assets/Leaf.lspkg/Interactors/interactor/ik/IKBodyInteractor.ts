import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import WorldCameraFinderProvider from "InteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import {UpdateDispatcher} from "Leaf.lspkg/Utils/common/UpdateDispatcher"
import {LeafLifecycle} from "Leaf.lspkg/Utils/common/LeafLifecycle"
import {Logger} from "Leaf.lspkg/Utils/common/Logger"
import {getColliderSize, nextFrame} from "Leaf.lspkg/Utils/common/Utils"
import {createTwoHandPinchBarrier} from "Leaf.lspkg/Utils/common/TwoHandPinchBarrier"
import {BodyPose} from "Leaf.lspkg/IKSolver/BodyController"
import {HeadController} from "Leaf.lspkg/IKSolver/HeadController"
import {safeNormalize} from "Leaf.lspkg/IKSolver/MathUtils"
import {JointPose, angleFromHeadForwardDeg} from "Leaf.lspkg/IKSolver/Pose"
import {PoseTransform} from "Leaf.lspkg/IKSolver/PoseTransform"
import {DiagnosticRecorder} from "Leaf.lspkg/Diagnostic/DiagnosticRecorder"
import {OutOfFov} from "Leaf.lspkg/Diagnostic/categories/OutOfFov"
import {TargetMissing} from "Leaf.lspkg/Diagnostic/categories/TargetMissing"
import {BaseLeafInteractor} from "../BaseLeafInteractor"
import {AvatarVisualizer} from "./visualizer/AvatarVisualizer"
import {IKHandInteractor, resolveWorldDelta} from "./IKHandInteractor"

const LOG = new Logger("IKBodyInteractor")

/** Beyond this half-angle (degrees) from the user's gaze, the head re-aims toward the trigger target. */
const FOV_HALF_ANGLE_DEG = 15
const HEAD_AIMED_COS = Math.cos(5 * MathUtils.DegToRad)
/** Cap so a never-reachable target can't hang the trigger forever. */
const HEAD_AIM_TIMEOUT_MS = 1000
/** Past this angle the head can't realistically rotate; skip the aim entirely and let the reach diagnostics record what's wrong. */
const MAX_HEAD_AIM_ANGLE_DEG = 90

/** Wall-clock duration of the simulated-IK drag fallback when the IK drag aborts on OutOfFov. */
const FALLBACK_DRAG_DURATION_MS = 1000
/** Approximate `onDragUpdate` ticks during `FALLBACK_DRAG_DURATION_MS` at 60fps — used to split the IK total-displacement delta into a per-tick `dragVector`. */
const FALLBACK_DRAG_TICKS = 60

/**
 * Optional rendering hookups for an {@link IKBodyInteractor}. Pass an
 * {@link AvatarVisualizer} (e.g. the result of `createBitmojiAvatar`)
 * to render an avatar driven by the IK pose each frame.
 *
 * Avatar-specific tuning (rig source, skin material policy, debug
 * overlays, etc.) lives behind the avatar factory — the interactor
 * stays rig-agnostic.
 */
export type IKBodyInteractorConfig = {
  avatarVisualizer?: AvatarVisualizer
  /** IK tracked-hand visual customizations. */
  sikHandVisuals?: SikHandVisualsConfig
  /**
   * Optional fallback interactor used when an IK check (target missing,
   * out-of-fov, unreachable, etc.) aborts the IK trigger. The fallback runs
   * the interaction via simulated IK input so the scenario sees the expected
   * downstream events. The original IK failure stays in the diagnostic report.
   */
  fallback?: BaseLeafInteractor
}

/**
 * Customizations applied to IK's tracked-hand visual meshes
 * (`handMesh`, `handMeshFull`, `handMeshIndexThumb`, `handMeshPin`).
 * Applied once at {@link IKBodyInteractor} construction.
 */
export type SikHandVisualsConfig = {
  /** When `true`, the IK hand meshes are hidden. */
  hide?: boolean
  /**
   * If set, tints the IK hand meshes by replacing their material's
   * `baseColor` with this value.
   */
  color?: vec4
}

/**
 * Two-hand IK controller with head tracking.
 *
 * Owns a left and right {@link IKHandInteractor} and a {@link HeadController}
 * that rotates the head toward interaction targets. Use {@link left} /
 * {@link right} for single-hand operations that bypass head tracking.
 *
 * When {@link IKBodyInteractorConfig.avatarVisualizer} is supplied, the
 * latest {@link BodyPose} is applied to the visualizer each frame so the
 * avatar mirrors the IK-driven hands and head. Composing one of these per player
 * (user, AI, …) gives each its own independent body.
 *
 * Automatically destroyed when the scenario completes via {@link LeafLifecycle.onCleanup}.
 */
export class IKBodyInteractor {
  readonly left = new IKHandInteractor("left")
  readonly right = new IKHandInteractor("right")

  private readonly _headController = new HeadController()
  private readonly _head: PoseTransform
  private _activeHeadPose?: JointPose
  private _avatarVisualizer?: AvatarVisualizer
  private _unsubscribes: Array<() => void> = []
  private _ready: Promise<void> = Promise.resolve()
  private _fallback?: BaseLeafInteractor

  constructor(config: IKBodyInteractorConfig = {}) {
    this._fallback = config.fallback
    this._head = new PoseTransform(
      WorldCameraFinderProvider.getInstance().getComponent().getTransform(),
    )

    // IK hand visuals
    if (config.sikHandVisuals?.hide === true) {
      this.left.setHandVisualsEnabled(false)
      this.right.setHandVisualsEnabled(false)
    }

    const handColor = config.sikHandVisuals?.color
    if (handColor !== undefined) {
      this.left.setHandVisualsColor(handColor)
      this.right.setHandVisualsColor(handColor)
    }

    // Avatar visualizer + idle parking
    const visualizer = config.avatarVisualizer
    if (visualizer) {
      this._avatarVisualizer = visualizer
      this.left.setIdleWristPoseGetter(() => visualizer.idleWristPoses().left)
      this.right.setIdleWristPoseGetter(() => visualizer.idleWristPoses().right)

      /**
       * Fire-and-forget — the visualizer applies pre-load state itself
       * and resolves once everything is wired up. The interactor doesn't
       * need to await; the avatar simply renders nothing until ready.
       * Catch surfaces async failures (e.g. Bitmoji download failure,
       * missing critical joint) instead of becoming an unhandled
       * rejection that's invisible to the caller.
       */
      this._ready = visualizer
        .create({hands: {left: this.left, right: this.right}})
        .catch((error: unknown) => {
          LOG.error(`Failed to load avatar: ${error}`, false)
        })
    }

    /**
     * IK-driving work (head/arm physics, IK wrist patching) runs in
     * regular Update so IK reads the IK-driven wrist position in its
     * own tick. The avatar visualizer write runs in LateUpdate so it
     * overrides the Bitmoji idle Animation Player on the bones we drive.
     */
    this._unsubscribes.push(
      UpdateDispatcher.getInstance().onUpdate.add(() => {
        const deltaTime = getDeltaTime()
        if (!(deltaTime > 0)) return
        const currentHeadPose = this._head.toPose()
        const headPose = this._headController.update(deltaTime, currentHeadPose)
        if (headPose !== undefined) this._head.apply(headPose)

        const activeHeadPose = headPose ?? currentHeadPose
        this._activeHeadPose = activeHeadPose
        this.left.updateArm(activeHeadPose, deltaTime)
        this.right.updateArm(activeHeadPose, deltaTime)
      }),
    )

    this._unsubscribes.push(
      UpdateDispatcher.getInstance().onLateUpdate.add(() => {
        const headPoseForFrame = this._activeHeadPose
        if (headPoseForFrame === undefined) return
        this._avatarVisualizer?.apply(this.snapshotBodyPose(headPoseForFrame))
      }),
    )

    this._unsubscribes.push(
      LeafLifecycle.getInstance().onCleanup.add(() => this.destroy()),
    )
  }

  /**
   * Resolves once the avatar rig has finished loading (joints addressable).
   * Await this before the first interaction instead of a fixed delay; resolves
   * immediately when no avatar visualizer is configured.
   */
  get ready(): Promise<void> {
    return this._ready
  }

  /**
   * Triggers `target` with the given hand while rotating the head toward it.
   *
   * @param target - The interactable to trigger.
   * @param hand - Which hand performs the trigger. Defaults to `"right"`.
   * @returns Resolves when the trigger interaction completes.
   */
  async trigger(
    target: Interactable,
    hand: "left" | "right" = "right",
  ): Promise<void> {
    const recorder = DiagnosticRecorder.getInstance()
    /** Don't call the fallback on TargetMissing — `BaseLeafInteractor.executeTrigger` reads `target.getSceneObject().name`, which throws on a destroyed SceneObject. */
    if (recorder.checkAndRecord(new TargetMissing(target, "trigger", hand))) return
    const isIndirect = this[hand].isIndirect(target)
    this.setTarget(target, isIndirect)
    /** Indirect convergence reads shoulder from the head pose — wait for it to settle. */
    if (isIndirect) {
      await this.waitForHeadAimedAt(target)
      /** Re-check after the await — `waitForHeadAimedAt` yields each frame and the target may have been destroyed mid-aim. */
      if (recorder.checkAndRecord(new TargetMissing(target, "trigger", hand))) return
      /** Only check FOV when the system was explicitly asked to aim; direct interactions don't need the target in view. */
      if (recorder.checkAndRecord(new OutOfFov(target, "trigger", this._head.toPose(), FOV_HALF_ANGLE_DEG, hand))) {
        await this._fallback?.trigger(target)
        return
      }
    }
    /** Hand-level reach diagnostics (unreachable_*) live inside `IKHandInteractor.trigger`; when they fire under the `fallback` policy the hand returns `false` and we route to the fallback so downstream events still fire. */
    if (!(await this[hand].trigger(target, isIndirect))) {
      await this._fallback?.trigger(target)
    }
  }

  /**
   * Pinch and drag `target` by `delta` with the given hand. The wrist
   * travels at whatever speed the {@link ArmModel} physics permits.
   *
   * - `vec3` delta → world-space cm offset (3D draggable objects).
   * - `vec2` delta → target's `ScreenTransform` anchor frame (UI panels).
   *
   * Head turns toward the target on the same rules as {@link trigger}.
   *
   * @param target - The interactable to drag.
   * @param delta  - Drag offset; world (vec3) or target-screen (vec2).
   * @param hand   - Which hand performs the drag. Defaults to `"right"`.
   */
  async drag(
    target: Interactable,
    delta: vec2 | vec3,
    hand: "left" | "right" = "right",
  ): Promise<void> {
    const recorder = DiagnosticRecorder.getInstance()
    if (recorder.checkAndRecord(new TargetMissing(target, "drag", hand))) return
    const isIndirect = this[hand].isIndirect(target)
    this.setTarget(target, isIndirect)
    if (isIndirect) {
      await this.waitForHeadAimedAt(target)
      if (recorder.checkAndRecord(new TargetMissing(target, "drag", hand))) return
      if (recorder.checkAndRecord(new OutOfFov(target, "drag", this._head.toPose(), FOV_HALF_ANGLE_DEG, hand))) {
        await this.dragViaFallback(target, delta)
        return
      }
    }
    /** Same routing as `trigger`: a `false` return from the hand means a reach diagnostic recorded under the `fallback` policy, so simulate the drag via IK input. */
    if (!(await this[hand].drag(target, delta))) {
      await this.dragViaFallback(target, delta)
    }
  }

  /** IK drag is velocity-based (`dragVector` per `onDragUpdate`); IK delta is total displacement. Split the total over `FALLBACK_DRAG_TICKS` so total ≈ original delta at 60fps. */
  private async dragViaFallback(target: Interactable, delta: vec2 | vec3): Promise<void> {
    if (this._fallback === undefined) return
    const perTick = resolveWorldDelta(target, delta).uniformScale(1 / FALLBACK_DRAG_TICKS)
    await this._fallback.drag(target, perTick, FALLBACK_DRAG_DURATION_MS)
  }

  /**
   * Two-handed scale: pinch `target` with both hands at opposite grip points
   * on the target and spread them apart. Mirrors `LeafHandInteractor`'s
   * `interactionOffset` pattern — each hand aims at a different point on the
   * target's collider (left at -X half-extent, right at +X half-extent) so
   * IK's `InteractableManipulation` sees two distinct cursors and reads a
   * scale gesture rather than a translate.
   *
   * A barrier holds each hand at its converged grip pose until *both* have
   * converged, so the two cursors engage IK in the same frame.
   *
   * @param target     - The interactable to scale; must support multi-cursor
   *   manipulation (Interactable.allowMultipleInteractors + InteractableManipulation.canScale).
   * @param leftDelta  - World-space cm offset for the left wrist after grip.
   * @param rightDelta - World-space cm offset for the right wrist after grip.
   */
  async scale(
    target: Interactable,
    leftDelta: vec3,
    rightDelta: vec3,
  ): Promise<void> {
    const recorder = DiagnosticRecorder.getInstance()
    if (recorder.checkAndRecord(new TargetMissing(target, "scale"))) return
    const isIndirect = this.right.isIndirect(target)
    this.setTarget(target, isIndirect)
    if (isIndirect) {
      await this.waitForHeadAimedAt(target)
      if (recorder.checkAndRecord(new TargetMissing(target, "scale"))) return
      if (recorder.checkAndRecord(new OutOfFov(target, "scale", this._head.toPose(), FOV_HALF_ANGLE_DEG))) return
    }

    /** Grip cursors on opposite sides of the target along world X — kept world-frame so `worldDelta` widens/shrinks the cursor distance regardless of target rotation. */
    const colliderHalfExtent = computeColliderHalfExtent(target)
    const leftGrip = new vec3(-0.4, 0, 0).mult(colliderHalfExtent)
    const rightGrip = new vec3(0.4, 0, 0).mult(colliderHalfExtent)

    /** Shared barrier: both hands rendezvous before `setPinching(true)`, and the left hand awaits an extra frame so IK's per-frame triggering-interactor cache sees both hands. See {@link createTwoHandPinchBarrier} for the IK-cache rationale. */
    const barrier = createTwoHandPinchBarrier()

    /**
     * Each hand's rejection unblocks the other hand's barrier via
     * `barrier.abort` — so we wait for BOTH to settle (don't fail-fast
     * via `Promise.all` rejection) to avoid leaving the surviving hand's
     * convergence loop running into the next interaction. `failOnAbort`
     * converts a `false` (reach-check abort) into a throw so the shared
     * barrier teardown path is the same as for thrown errors. Scale has
     * no IK fallback (`BaseLeafInteractor` doesn't expose `scale`), so
     * a single hand's abort cancels the whole gesture.
     */
    const failOnAbort = (handLabel: "left" | "right") => (completed: boolean): boolean => {
      if (!completed) throw new Error(`scale: ${handLabel} hand aborted by reach check`)
      return completed
    }
    const runLeft = this.left
      .drag(target, leftDelta, () => barrier.wait("left"), leftGrip)
      .then(failOnAbort("left"))
      .catch((error: Error) => {
        barrier.abort(error)
        throw error
      })
    const runRight = this.right
      .drag(target, rightDelta, () => barrier.wait("right"), rightGrip)
      .then(failOnAbort("right"))
      .catch((error: Error) => {
        barrier.abort(error)
        throw error
      })
    let scaleError: Error | undefined
    await Promise.all([
      runLeft.catch((error: Error) => {
        scaleError = scaleError ?? error
      }),
      runRight.catch((error: Error) => {
        scaleError = scaleError ?? error
      }),
    ])
    if (scaleError !== undefined) throw scaleError
  }

  /**
   * Stops the update loop and restores all patched IK internals.
   * Automatically called on {@link LeafLifecycle.onCleanup}. Idempotent.
   */
  destroy(): void {
    if (this._unsubscribes.length === 0) return
    for (const unsubscribe of this._unsubscribes) unsubscribe()
    this._unsubscribes = []

    this.left.destroy()
    this.right.destroy()

    this._avatarVisualizer?.destroy()
    this._avatarVisualizer = undefined
  }

  private setTarget(target: Interactable, force: boolean): void {
    const targetPosition = target
      .getSceneObject()
      .getTransform()
      .getWorldPosition()
    const angle = angleFromHeadForwardDeg(this._head.toPose(), targetPosition)
    if (angle > MAX_HEAD_AIM_ANGLE_DEG) return
    if (force || angle > FOV_HALF_ANGLE_DEG) {
      this._headController.setTarget(targetPosition)
    }
  }

  /** Yield until the head is within ~5° of `target`, or {@link HEAD_AIM_TIMEOUT_MS}. Returns immediately when the target is past {@link MAX_HEAD_AIM_ANGLE_DEG} — OutOfFov will record the diagnostic. */
  private async waitForHeadAimedAt(target: Interactable): Promise<void> {
    const deadline = getTime() + HEAD_AIM_TIMEOUT_MS / 1000
    while (getTime() < deadline) {
      if (this._unsubscribes.length === 0) return
      const targetSceneObject = target.getSceneObject()
      if (isNull(targetSceneObject)) return
      const targetPosition = targetSceneObject
        .getTransform()
        .getWorldPosition()
      if (angleFromHeadForwardDeg(this._head.toPose(), targetPosition) > MAX_HEAD_AIM_ANGLE_DEG) return
      this._headController.setTarget(targetPosition)
      if (this.isHeadAimedAt(targetPosition)) return
      await nextFrame()
    }
  }

  private isHeadAimedAt(targetPosition: vec3): boolean {
    const {position, rotation} = this._head.toPose()
    const toTarget = safeNormalize(targetPosition.sub(position))
    if (toTarget === undefined) return true
    const forward = rotation.multiplyVec3(vec3.back())
    return forward.dot(toTarget) >= HEAD_AIMED_COS
  }

  private snapshotBodyPose(head: JointPose): BodyPose {
    return {
      head,
      leftWrist: this.left.currentWristPose,
      rightWrist: this.right.currentWristPose,
      leftArm: this.left.currentArmKeypoints,
      rightArm: this.right.currentArmKeypoints,
      leftFingers: this.left.currentFingerKeypoints,
      rightFingers: this.right.currentFingerKeypoints,
    }
  }
}

/**
 * Half-extent of the union of all `target.colliders` (largest along each
 * axis), scaled by the target's world scale. Matches the calculation in
 * IK's `LeafHandInteractor.scalePointByInteractableSize`.
 */
function computeColliderHalfExtent(target: Interactable): vec3 {
  let size = vec3.zero()
  for (const collider of target.colliders) {
    size = vec3.max(getColliderSize(collider), size)
  }
  return size
    .mult(target.getTransform().getWorldScale())
    .uniformScale(0.5)
}


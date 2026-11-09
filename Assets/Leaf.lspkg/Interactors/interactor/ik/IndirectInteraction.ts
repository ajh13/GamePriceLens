import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {findInteractables} from "../../InteractableUtils"
import {HandType} from "InteractionKit.lspkg/Providers/HandInputData/HandType"
import {InteractorInputType} from "InteractionKit.lspkg/Core/Interactor/Interactor"
import {RaycastInfo} from "InteractionKit.lspkg/Core/Interactor/RayProvider"
import {IK} from "InteractionKit.lspkg/IK"
import TrackedHand from "InteractionKit.lspkg/Providers/HandInputData/TrackedHand"
import WorldCameraFinderProvider from "InteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import {nextFrame, withTimeout} from "Leaf.lspkg/Utils/common/Utils"
import {Logger} from "Leaf.lspkg/Utils/common/Logger"
import {
  ArmKeypoints,
  ArmModel,
  BodyAnchors,
  WRIST_MAX_REACH_CM,
} from "Leaf.lspkg/IKSolver/ArmModel"
import {JointPose} from "Leaf.lspkg/IKSolver/Pose"

import {IKHand, PINCH_GESTURE_DURATION_MS} from "./IKHand"
import {TargetingRay, TargetingRayProvider} from "./TargetingRayProvider"

const LOG = new Logger("IndirectInteraction")

const CONVERGENCE_TIMEOUT_MS = 3000
const HOVER_ENTER_TIMEOUT_MS = 3000
/** Cold-start timeout for the wrist to traverse from idle (~1 m below shoulder) to the analytic target before iteration begins. */
const INITIAL_REACH_TIMEOUT_MS = 3000
const SCALE_INITIAL_REACH_TIMEOUT_MS = 3000
/** Per-iteration reach cap — same asymptotic plateau; iterate quickly. */
const ITER_WAIT_TIMEOUT_MS = 200
const CONVERGENCE_GAIN = 0.4
const WRIST_THRESHOLD_CM = 0.5
/** Below this absolute value of `ray.direction · bodyForward` we can't project the ray onto a forward-facing plane. */
const MIN_RAY_FORWARD_COMPONENT = 0.01
/** Cap on the drag slide phase. */
const DRAG_WRIST_WAIT_TIMEOUT_MS = 1500
/** Per-frame wrist motion under which the slide is "settled". */
const DRAG_SETTLED_MOTION_CM = 0.05
const DRAG_SETTLED_STABLE_FRAMES = 5

/** Surface that {@link IndirectInteraction} needs from its host (the IK hand interactor). */
export type IndirectInteractionHost = {
  readonly hand: IKHand
  readonly armModel: ArmModel
  readonly cameraProvider: WorldCameraFinderProvider
  readonly handType: HandType
  readonly targetingRayProvider: TargetingRayProvider
  readonly lastKeypoints?: ArmKeypoints
  readonly currentInteractable?: Interactable
  isAlive(): boolean
  pinchAndAwaitTriggerEnd(
    target: Interactable,
    hoverEntered: Promise<void>,
  ): Promise<void>
  finishTrigger(): Promise<void>
}

/** Minimal IK interactor shape needed to install the ray-provider patch. */
type SIKHandRayHost = {
  handRayProvider?: {
    getRaycastInfo(): RaycastInfo
    isAvailable(): boolean
    reset(): void
  }
}

/**
 * Beyond-reach interaction strategy: closed-loop converge the targeting
 * ray on `target`, feed it to IK's `IndirectTargetProvider` via patched
 * ray + targetingData, then pinch (and optionally slide for drag).
 */
export class IndirectInteraction {
  private _currentRay?: TargetingRay
  private _uninstallSIKPatches?: () => void

  constructor(private readonly _host: IndirectInteractionHost) {
    this.installSIKPatches()
  }

  /** Active targeting ray published to IK while {@link trigger} is in flight. */
  get currentRay(): TargetingRay | undefined {
    return this._currentRay
  }

  /** Remove IK patches. Idempotent. */
  dispose(): void {
    this._uninstallSIKPatches?.()
    this._uninstallSIKPatches = undefined
  }

  /**
   * Pinch-trigger `target` via the targeting ray.
   *
   * @param target       - The interactable to trigger; must lie beyond arm reach.
   * @param hoverEntered - Pre-armed promise that resolves on `target.onHoverEnter`.
   * @returns Resolves when the host's pinch + trigger-end sequence completes.
   * @throws When the ray fails to converge within {@link CONVERGENCE_TIMEOUT_MS}.
   */
  async trigger(
    target: Interactable,
    hoverEntered: Promise<void>,
  ): Promise<void> {
    let trackingActive = false
    let trackingDone: Promise<void> | undefined
    try {
      const ray = await this.convergeRayOnTarget(target)
      if (ray === undefined) {
        throw new Error(
          `[IK ${this._host.handType}] ray failed to converge on "${target.getSceneObject().name}"`,
        )
      }
      this._currentRay = ray

      /** Keep the wrist re-aimed at the target every frame during the gesture animation. The target's SceneObject identity is constant, but its world position can update each frame (e.g. an item carried by a ScrollView that continues to scroll under it). Without tracking, a static ray would slide off the moving target. */
      trackingActive = true
      trackingDone = this.trackTarget(target, () => trackingActive)

      await this._host.hand.makeGesture(
        "pinch",
        undefined,
        PINCH_GESTURE_DURATION_MS,
      )
      await this._host.pinchAndAwaitTriggerEnd(target, hoverEntered)
    } finally {
      trackingActive = false
      if (trackingDone !== undefined) await trackingDone
      this._currentRay = undefined
      await this._host.finishTrigger()
    }
  }

  /** Per-frame re-aim + ray republish during the gesture so the arm follows targets whose world position updates between frames. */
  private async trackTarget(
    target: Interactable,
    isActive: () => boolean,
  ): Promise<void> {
    /** Surface errors via `LOG.error` rather than rejecting — the primary gesture flow awaits this promise in `finally`, and a rejection here would shadow whatever error the gesture actually failed with. */
    try {
      /** Follow the target by the per-frame Δ rather than re-running `solveReach` each frame — that would overwrite convergence's ~2-3° pitch/yaw bias correction and drift the ray off target. */
      const initialTargetPosition = resolveAimPosition(target)
      let lastTargetPosition = initialTargetPosition
      let trackedWrist = this._host.hand.worldPosition
      while (isActive() && this._host.isAlive()) {
        const targetPosition = resolveAimPosition(target)
        const delta = targetPosition.sub(lastTargetPosition)
        if (delta.length > 0) {
          trackedWrist = trackedWrist.add(delta)
          this._host.armModel.setTarget({position: trackedWrist})
          lastTargetPosition = targetPosition
        }
        const updatedRay = this.computeRayForCurrentPose()
        if (updatedRay !== undefined) this._currentRay = updatedRay
        await nextFrame()
      }
    } catch (error) {
      LOG.error(`trackTarget aborted: ${error}`, false)
    }
  }

  /**
   * Pinch `target` then slide the wrist by `worldDelta`, republishing the
   * ray each frame so IK's indirect cursor sweeps across the target.
   *
   * Wrist motion is a first-order approximation: the actual hit translates
   * by roughly `worldDelta × (cervicalToTarget / cervicalToWrist)` due to
   * the lever-arm geometry — callers that need a precise endpoint should
   * loop until a widget-side predicate is satisfied.
   *
   * @param target       - The interactable to drag; must lie beyond arm reach.
   * @param worldDelta   - World-space wrist translation in cm.
   * @param hoverEntered - Pre-armed promise that resolves on `target.onHoverEnter`.
   * @throws When the ray fails to converge within {@link CONVERGENCE_TIMEOUT_MS}.
   */
  async drag(
    target: Interactable,
    worldDelta: vec3,
    hoverEntered: Promise<void>,
    afterConvergence?: () => Promise<void>,
    gripOffset?: vec3,
  ): Promise<void> {
    try {
      const ray = await this.convergeRayOnTarget(target, gripOffset)
      if (ray === undefined) {
        throw new Error(
          `[IK ${this._host.handType}] ray failed to converge on "${target.getSceneObject().name}"`,
        )
      }
      this._currentRay = ray

      /** Barrier before `setPinching` so two hands flip `isActive()` in the same IK frame; the 2-frame wait lets both interactors publish their per-frame rays + populate startPoint/endPoint/direction before `setInitialValues` reads them — without it, the first hand's pinch lands when the second's interactor still reports null and IK falls back to single-cursor (translate). */
      await this._host.hand.makeGesture(
        "pinch",
        undefined,
        PINCH_GESTURE_DURATION_MS,
      )
      if (afterConvergence !== undefined) await afterConvergence()
      await nextFrame()
      await nextFrame()
      this._host.hand.setPinching(true)
      /** `convergeRayOnTarget` already verified the hit matches `target` (or a descendant); IK fires `onHoverEnter` only on exact hits, so waiting for it would hang on valid descendant hits. */

      /** Republish the ray each frame so IK's indirect cursor sweeps across the target. */
      const endWrist = this._host.hand.worldPosition.add(worldDelta)
      this._host.armModel.setTarget({position: endWrist})

      const deadline = getTime() + DRAG_WRIST_WAIT_TIMEOUT_MS / 1000
      let previousWrist = this._host.hand.worldPosition
      let stableFrames = 0
      await nextFrame()
      while (this._host.isAlive() && getTime() < deadline) {
        const updatedRay = this.computeRayForCurrentPose()
        if (updatedRay !== undefined) this._currentRay = updatedRay
        const currentWrist = this._host.hand.worldPosition
        if (currentWrist.distance(previousWrist) < DRAG_SETTLED_MOTION_CM) {
          if (++stableFrames >= DRAG_SETTLED_STABLE_FRAMES) break
        } else {
          stableFrames = 0
        }
        previousWrist = currentWrist
        await nextFrame()
      }
    } finally {
      this._currentRay = undefined
      await this._host.finishTrigger()
    }
  }

  /** Targeting ray from the current head + arm pose. */
  private computeRayForCurrentPose(): TargetingRay | undefined {
    const cameraTransform = this._host.cameraProvider.getComponent().getTransform()
    const headPose: JointPose = {
      position: cameraTransform.getWorldPosition(),
      rotation: cameraTransform.getWorldRotation(),
    }
    const body = this._host.armModel.bodyAnchors(headPose)
    const elbow = this._host.lastKeypoints?.elbow ?? body.shoulder
    return this._host.targetingRayProvider.compute(
      body,
      elbow,
      this._host.hand.worldPosition,
      this._host.handType === "left",
    )
  }

  /** Drive the wrist until the targeting ray hits `target`; returns the verified ray or `undefined` on timeout. */
  private async convergeRayOnTarget(
    target: Interactable,
    gripOffset?: vec3,
  ): Promise<TargetingRay | undefined> {
    /** Re-evaluated each iteration so the ray tracks targets whose visible centroid moves between frames (e.g. ScrollView content sliding under a viewport, a tracked physics object). */
    const getAim = (): vec3 => {
      const center = resolveAimPosition(target)
      return gripOffset !== undefined ? center.add(gripOffset) : center
    }
    const cameraComponent = this._host.cameraProvider.getComponent()
    const getBody = (): BodyAnchors => {
      const cameraTransform = cameraComponent.getTransform()
      const headPose: JointPose = {
        position: cameraTransform.getWorldPosition(),
        rotation: cameraTransform.getWorldRotation(),
      }
      return this._host.armModel.bodyAnchors(headPose)
    }

    /** Initial wrist guess along `shoulder → aim` at analytic reach; loop corrects the ~2-3° pitch/yaw bias from `solveReach`. */
    const initialBody = getBody()
    const initialAim = getAim()
    const initialReach = this._host.targetingRayProvider.solveReach(
      initialBody,
      initialAim,
      WRIST_MAX_REACH_CM,
    )
    const initialDirection = initialAim.sub(initialBody.shoulder).normalize()
    let wristTarget = initialBody.shoulder.add(
      initialDirection.uniformScale(initialReach),
    )
    this._host.armModel.setTarget({position: wristTarget})
    const initialTimeoutMs =
      gripOffset !== undefined
        ? SCALE_INITIAL_REACH_TIMEOUT_MS
        : INITIAL_REACH_TIMEOUT_MS
    await this.waitForWristConvergence(
      wristTarget,
      getTime() + initialTimeoutMs / 1000,
    )

    const loopDeadline = getTime() + CONVERGENCE_TIMEOUT_MS / 1000
    while (getTime() < loopDeadline) {
      const liveKeypoints = this._host.lastKeypoints
      const currentBody = getBody()
      const currentWrist = this._host.hand.worldPosition
      const elbow = liveKeypoints?.elbow ?? currentBody.shoulder

      const ray = this._host.targetingRayProvider.compute(
        currentBody,
        elbow,
        currentWrist,
        this._host.handType === "left",
      )
      if (ray === undefined) break

      // Publish the ray to IK, let it run one frame, then read what it hit.
      this._currentRay = ray
      await nextFrame()
      if (rayHitMatches(this._host.currentInteractable, target)) return ray

      const correctedWrist = this.correctWristForRayMiss(
        currentWrist,
        ray,
        getAim(),
        currentBody.bodyForward,
      )
      if (correctedWrist === undefined) break

      /** Clamp to the reach sphere so corrections slide along it rather than getting snapped back to a fixed point. */
      const shoulderToWrist = correctedWrist.sub(currentBody.shoulder)
      wristTarget =
        shoulderToWrist.length > WRIST_MAX_REACH_CM
          ? currentBody.shoulder.add(
              shoulderToWrist.normalize().uniformScale(WRIST_MAX_REACH_CM),
            )
          : correctedWrist
      this._host.armModel.setTarget({position: wristTarget})
      await this.waitForWristConvergence(
        wristTarget,
        Math.min(getTime() + ITER_WAIT_TIMEOUT_MS / 1000, loopDeadline),
      )
    }
    return undefined
  }

  /**
   * Wait one frame, then poll until the hand is within {@link WRIST_THRESHOLD_CM}
   * of `target` or `deadline` elapses. Deadline is required since
   * `correctWristForRayMiss` can produce a wrist target beyond max reach,
   * which ArmModel clamps — the absolute distance would never be crossed.
   */
  private async waitForWristConvergence(
    target: vec3,
    deadline: number,
  ): Promise<void> {
    await nextFrame()
    while (
      this._host.isAlive() &&
      this._host.hand.worldPosition.distance(target) > WRIST_THRESHOLD_CM &&
      getTime() < deadline
    ) {
      await nextFrame()
    }
  }

  /** Project the missed ray onto the body-forward plane through `targetPosition` and return wrist + `miss × gain`. */
  private correctWristForRayMiss(
    currentWrist: vec3,
    ray: TargetingRay,
    targetPosition: vec3,
    bodyForward: vec3,
  ): vec3 | undefined {
    const dirDotForward = ray.direction.dot(bodyForward)
    if (Math.abs(dirDotForward) < MIN_RAY_FORWARD_COMPONENT) return undefined
    const t = targetPosition.sub(ray.locus).dot(bodyForward) / dirDotForward
    const hit = ray.locus.add(ray.direction.uniformScale(t))
    const miss = targetPosition.sub(hit)
    return currentWrist.add(miss.uniformScale(CONVERGENCE_GAIN))
  }

  /**
   * Hook the IK-derived ray into IK so its `IndirectTargetProvider` runs
   * in preview (no real hand tracking).
   * - `handRayProvider.getRaycastInfo` returns our ray instead of the
   *   zero-vector `GestureModule.getRay()`.
   * - `trackedHand.targetingData.intendsToTarget` is forced `true` so IK's
   *   provider-selection picks the indirect path.
   */
  private installSIKPatches(): void {
    const handInputType =
      this._host.handType === "left"
        ? InteractorInputType.LeftHand
        : InteractorInputType.RightHand
    const handInteractor = IK.InteractionManager.getInteractorsByType(
      handInputType,
    )[0] as SIKHandRayHost | undefined
    const trackedHand = IK.HandInputData.getHand(this._host.handType) as
      | TrackedHand
      | undefined
    if (!handInteractor || !trackedHand) return

    const cleanups: (() => void)[] = []

    const rayProvider = handInteractor.handRayProvider
    if (rayProvider) {
      const originalGetRaycastInfo =
        rayProvider.getRaycastInfo.bind(rayProvider)
      rayProvider.getRaycastInfo = (): RaycastInfo =>
        this._currentRay ?? originalGetRaycastInfo()
      cleanups.push(() => {
        rayProvider.getRaycastInfo = originalGetRaycastInfo
      })

      /** Force-available while our ray is published — the default `isAvailable` gates on real hand tracking, which doesn't hold in preview, so the IK-derived ray would be discarded. */
      const originalIsAvailable = rayProvider.isAvailable.bind(rayProvider)
      rayProvider.isAvailable = (): boolean =>
        this._currentRay !== undefined || originalIsAvailable()
      cleanups.push(() => {
        rayProvider.isAvailable = originalIsAvailable
      })
    }

    Object.defineProperty(trackedHand, "targetingData", {
      get: () =>
        this._currentRay !== undefined
          ? {
              targetingLocusInWorld: this._currentRay.locus,
              targetingDirectionInWorld: this._currentRay.direction,
              intendsToTarget: true,
            }
          : null,
      configurable: true,
    })
    cleanups.push(() => {
      delete (trackedHand as any).targetingData
    })

    this._uninstallSIKPatches = () => {
      for (let i = cleanups.length - 1; i >= 0; i--) cleanups[i]()
    }
  }
}

/** Accept descendant hits — IK often surfaces a child Interactable (e.g. ScrollView's Background) on a valid "on the panel" hit. */
function rayHitMatches(
  hit: Interactable | undefined,
  target: Interactable,
): boolean {
  if (hit === undefined) return false
  if (hit === target) return true
  const targetSceneObject = target.getSceneObject()
  let ancestor: SceneObject | null = hit.getSceneObject().getParent()
  while (!isNull(ancestor)) {
    if (ancestor!.isSame(targetSceneObject)) return true
    ancestor = ancestor!.getParent()
  }
  return false
}

/** Aim point for `target`: ScreenTransform's world position for UI panels (collider AABB would drag the aim to scrolled-out content); AABB centroid over enabled collider descendants otherwise; target's world position as fallback. */
function resolveAimPosition(target: Interactable): vec3 {
  const targetSceneObject = target.getSceneObject()
  const screenTransform = targetSceneObject.getComponent(
    "Component.ScreenTransform",
  ) as ScreenTransform | null
  if (!isNull(screenTransform)) {
    return targetSceneObject.getTransform().getWorldPosition()
  }

  const colliderInteractables = findInteractables(
    (sceneObject) => {
      const interactable = sceneObject.getComponent(
        Interactable.getTypeName(),
      ) as Interactable | null
      return !isNull(interactable) && interactable!.colliders.length > 0
        ? interactable!
        : undefined
    },
    targetSceneObject,
  )

  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  let found = false
  for (const interactable of colliderInteractables) {
    if (!interactable.getSceneObject().isEnabledInHierarchy) continue
    for (const collider of interactable.colliders) {
      const colliderObject = collider.getSceneObject()
      if (!colliderObject.isEnabledInHierarchy) continue
      const position = colliderObject.getTransform().getWorldPosition()
      if (position.x < minX) minX = position.x
      if (position.y < minY) minY = position.y
      if (position.z < minZ) minZ = position.z
      if (position.x > maxX) maxX = position.x
      if (position.y > maxY) maxY = position.y
      if (position.z > maxZ) maxZ = position.z
      found = true
    }
  }
  if (!found) {
    return targetSceneObject.getTransform().getWorldPosition()
  }
  return new vec3((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5)
}

import {
  InteractableManipulation,
  type TranslateEventArg
} from "InteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation"
import {Interactor} from "InteractionKit.lspkg/Core/Interactor/Interactor"
import WorldCameraFinderProvider from "InteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import {unsubscribe} from "InteractionKit.lspkg/Utils/Event"
import {SpringAnimate} from "InteractionKit.lspkg/Utils/springAnimate"
import DepthScaling from "./DepthScaling"
import {
  cameraForwardDepth,
  copyRay,
  normalizeDepthRange,
  resolveDepthClampedPosition,
  type DepthClampRay
} from "./FrameDepthClampMath"

const CLAMP_SPRING_DURATION = 0.35
const CORRECTION_POSITION_EPSILON = 0.01
const CORRECTION_VELOCITY_EPSILON = 0.1
// The initial recovery spring chases a hand-driven moving target, so the tight
// settle epsilons above can stay unreachable for as long as the pinch is held.
// While that recovery runs, the pose is proposed-hand + lagging correction: it
// reads as a dead zone when pulling back inward (the raw overshoot must be
// unwound by hand first) and as a rubber-band bounce past the wall when
// pushing further out. Hand the gesture back to the rigid clamp — and rebase
// the driver — once the remaining correction is within this many centimeters
// of the boundary, or once the spring has run its full nominal duration.
const INITIAL_CORRECTION_HANDOFF_EPSILON = 1
// Mirrors SpringAnimate's MAX_ACCUMULATION_TIME (springAnimate.ts): each
// evaluate simulates at most this much wall time and discards the rest of a
// long frame. The recovery deadline therefore counts SIMULATED time through
// the same cap — wall-clock elapsed would cross the deadline during a hitch
// and snap motion the spring never had time to simulate. Drift is safe in
// both directions: a raised IK cap under-counts (recovery slightly longer,
// still bounded per step), a lowered one over-counts (bounded by the delta).
const SPRING_MAX_ACCUMULATION_TIME = 0.2
// Reject an averaged dual-hand direction only near total cancellation (average
// length under 0.1 ≈ unit directions within ~12° of exactly opposite), where
// the normalized residual is noise. Normalization is well-conditioned above
// this, and resolveDepthClampedPosition's forward-ratio gate independently
// guards whether the direction is usable.
const MINIMUM_AVERAGE_RAY_LENGTH_SQUARED = 0.01

export type DepthBehaviorOptions = {
  frameObject: SceneObject
  frameTransform: Transform
  manipulation: InteractableManipulation
  getClampingEnabled: () => boolean
  getMinimumDepth: () => number
  getMaximumDepth: () => number
  getDepthScaling: () => DepthScaling | null
  getAppliedScaleFactor: () => number
}

/**
 * Shared manipulation driver for Frame depth clamping and distance scaling.
 * IK writes unconstrained motion to an invisible driver. In-range motion is
 * committed synchronously; out-of-range motion adds a critically damped spring
 * correction toward the allowed depth without rebasing the raw hand driver.
 * The exception is a grab that STARTS out of range: its recovery spring is
 * bounded (handoff epsilon / nominal duration) and ends by rebasing the driver
 * at the boundary, so wall departure is immediate afterwards.
 */
export default class DepthBehavior {
  private readonly camera = WorldCameraFinderProvider.getInstance()
  private readonly driverObject: SceneObject
  private readonly driverTransform: Transform
  private readonly unsubscribes: unsubscribe[] = []
  private anchorLocal: vec3 = vec3.zero()
  private gestureActive: boolean = false
  private driverScaleFactor: number = 1
  /**
   * Per-gesture eligibility latches: a behavior participates in a gesture
   * only if it was enabled when the grab started, has not been disabled
   * since, and is still enabled live. Mid-gesture enables therefore wait for
   * the next grab — matching the structurally deferred driver install, and
   * letting beginGesture arm the smooth initial correction instead of
   * rigid-snapping mid-drag — while a mid-gesture disable takes effect
   * immediately and is final for that grab: re-enabling cannot rejoin it.
   * The clamping latch persists through a released correction (a revoked
   * grab cannot be resurrected at release); the scaling latch is consulted
   * only while the grab is active — once it ends, scaling follows live
   * availability (see getEffectiveDepthScaling), so enables land the moment
   * the grab ends or at any point during a surviving correction. Both reset
   * in finishGesture.
   */
  private gestureClampingEnabled: boolean = true
  private gestureScalingEnabled: boolean = true
  private readonly clampSpring = SpringAnimate.smooth(CLAMP_SPRING_DURATION)
  private readonly currentCorrection = vec3.zero()
  private readonly targetCorrection = vec3.zero()
  private readonly rawAnchorWorld = vec3.zero()
  private lastClampRay: DepthClampRay | null = null
  private springAnimating: boolean = false
  private springInitialCorrection: boolean = false
  // Simulated spring time consumed by the current initial recovery (per-step
  // wall time capped like SpringAnimate's own accumulator), zeroed when a
  // mid-recovery range change retargets the spring; only read while
  // springInitialCorrection is true, stale otherwise.
  private initialCorrectionSimulatedTime: number = 0
  private clampingConfigurationDirty: boolean = false
  private lastSpringStepTime: number = -1

  /** True while a released clamp correction still needs Frame update ticks. */
  public get isAnimating(): boolean {
    return this.springAnimating
  }

  public constructor(private readonly options: DepthBehaviorOptions) {
    this.driverObject = global.scene.createSceneObject(`${options.frameObject.name} Depth Manipulation Driver`)
    this.driverObject.layer = options.frameObject.layer
    this.driverTransform = this.driverObject.getTransform()
    this.syncDriverToFrame()
    options.manipulation.setManipulateRoot(this.driverTransform)
    this.unsubscribes.push(options.manipulation.onTranslationUpdate.add(this.onTranslationUpdate))
  }

  public beginGesture(anchorLocal: vec3): void {
    this.gestureActive = true
    this.gestureClampingEnabled = this.options.getClampingEnabled()
    this.gestureScalingEnabled = this.options.getDepthScaling() !== null
    this.anchorLocal = new vec3(anchorLocal.x, anchorLocal.y, anchorLocal.z)
    this.syncDriverToFrame()
    this.driverScaleFactor = this.options.getAppliedScaleFactor()
    this.resetSpring()
    this.springInitialCorrection = this.anchorStartsOutsideDepthRange()
    this.initialCorrectionSimulatedTime = 0
    if (this.options.manipulation.isManipulating()) this.options.manipulation.updateStartValues()
  }

  public setAnchorLocal(anchorLocal: vec3): void {
    this.anchorLocal = new vec3(anchorLocal.x, anchorLocal.y, anchorLocal.z)
  }

  /**
   * End the active gesture, applying any clamping config that changed after
   * the last translation update before handing the correction to the released
   * spring.
   *
   * @returns true when a pending config change ended the correction
   * synchronously.
   */
  public endGesture(): boolean {
    this.gestureActive = false
    if (this.clampingConfigurationDirty) {
      return this.applyReleasedClampingConfigurationChange()
    }
    if (!this.springAnimating) this.finishGesture()
    return false
  }

  /**
   * Complete any in-flight correction at its target immediately and reset all
   * gesture state. For a Frame being disabled mid-correction: the gated update
   * loop stops ticking while disabled, and resuming the stranded spring after
   * re-enable would hard-write a world position captured against the camera
   * pose at release time — overwriting anything done to the frame meanwhile.
   */
  public settleNow(): void {
    if (this.springAnimating) {
      this.applyDisplayedAnchor(this.rawAnchorWorld.add(this.targetCorrection))
    }
    this.gestureActive = false
    this.finishGesture()
  }

  /**
   * Apply a live clamping configuration change to a correction that has
   * outlived its gesture. Disabling freezes the currently displayed pose;
   * changing the range retargets the existing spring from its current
   * correction so it remains continuous.
   *
   * Active gestures: a disable revokes the gesture's eligibility latch and
   * cancels any in-flight correction spring synchronously, so correction-
   * authored motion stops without depending on IK delivering per-frame
   * translation events; the next translation update then follows the raw
   * driver unconstrained. Range changes keep their existing path: the next
   * translation update reads the live range and rebases safely through the
   * manipulation driver; if release arrives first, endGesture applies the
   * recorded change. Mid-gesture enables are never applied to the grab in
   * flight — the eligibility latch keeps them inert until the next grab.
   * A range change landing during an initial recovery also refreshes that
   * recovery's duration window, so the retarget eases instead of being
   * snapped by the duration handoff.
   *
   * @returns true when the released correction ended synchronously.
   */
  public onClampingConfigurationChanged(): boolean {
    if (this.gestureActive && !this.options.getClampingEnabled()) {
      this.gestureClampingEnabled = false
      if (this.springAnimating) {
        // Stop correction-authored motion now rather than on the next
        // translation event — IK currently delivers one every frame while
        // the pinch is held, but that cadence is an external invariant this
        // module shouldn't lean on. The driver is deliberately NOT rebased:
        // the next translation update rejoins the raw grab position, the
        // documented un-clamp semantic shared with the rigid (no-spring)
        // disable path.
        this.springInitialCorrection = false
        this.resetSpring()
      }
      return false
    }
    if (!this.springAnimating) return false
    if (this.gestureActive) {
      this.clampingConfigurationDirty = true
      // A mid-recovery range change retargets the spring by the range delta,
      // which can dwarf the remaining correction. Grant the retarget a fresh
      // nominal duration so the duration handoff cannot snap the whole delta
      // one tick later. Hand motion never reaches this branch, and Frame's
      // range setters stay silent on same-value writes, so neither a held
      // gesture nor a per-frame config reapply can keep the recovery (and
      // its rubber-band rendering) alive past the deadline.
      if (this.springInitialCorrection) this.initialCorrectionSimulatedTime = 0
      return false
    }

    return this.applyReleasedClampingConfigurationChange()
  }

  /**
   * Latch a mid-gesture scaling disable so a later re-enable cannot rejoin
   * the same grab — the live read alone cannot enforce this because Frame
   * keeps the (reset) DepthScaling instance referenced until the gesture
   * ends. Post-grab application follows live availability directly (see
   * getEffectiveDepthScaling), so scaling resumes the moment the grab ends.
   * No-op outside an active gesture.
   */
  public onScalingConfigurationChanged(): void {
    if (this.gestureActive && this.options.getDepthScaling() === null) {
      this.gestureScalingEnabled = false
    }
  }

  private applyReleasedClampingConfigurationChange(): boolean {
    this.clampingConfigurationDirty = false
    // Effective (not just live) enablement, as a backstop: mid-gesture
    // disables now cancel the correction synchronously, so a dirty release
    // normally arrives latch-true — but a revoked grab that somehow reaches
    // here re-enabled must freeze rather than resurrect the correction.
    // The min/max reads below stay live.
    if (!this.isClampingEffective()) {
      this.finishGesture()
      return true
    }

    const cameraWorld = this.camera.getWorldTransform()
    const cameraInverse = this.camera.getInvertedWorldTransform()
    const result = resolveDepthClampedPosition({
      proposedOriginWorld: this.rawAnchorWorld,
      anchorOffsetWorld: vec3.zero(),
      cameraWorldTransform: cameraWorld,
      cameraInvertedWorldTransform: cameraInverse,
      minimumDepth: this.options.getMinimumDepth(),
      maximumDepth: this.options.getMaximumDepth(),
      ray: this.lastClampRay
    })
    this.targetCorrection.copyFrom(result.anchorWorldPosition.sub(this.rawAnchorWorld))
    this.springAnimating = !this.clampSpring.isSettled(
      this.currentCorrection,
      this.targetCorrection,
      CORRECTION_POSITION_EPSILON,
      CORRECTION_VELOCITY_EPSILON
    )
    if (this.springAnimating) return false

    // Close an epsilon-sized remainder at the exact updated boundary before
    // releasing pose ownership.
    this.currentCorrection.copyFrom(this.targetCorrection)
    this.applyDisplayedAnchor(this.rawAnchorWorld.add(this.currentCorrection), cameraInverse)
    this.finishGesture()
    return true
  }

  /**
   * Advance a correction that outlives the hand gesture. Returns true on the
   * frame where the released spring settles so Frame can resync configuration.
   */
  public update(): boolean {
    if (!this.springAnimating) return false
    this.stepSpringAndApply()
    if (this.springAnimating || this.gestureActive) return false
    this.finishGesture()
    return true
  }

  public destroy(): void {
    this.unsubscribes.forEach((unsubscribeCallback) => unsubscribeCallback())
    this.unsubscribes.length = 0
    // During whole-hierarchy teardown the manipulation component may already
    // be destroyed; touching it then throws and aborts the caller's remaining
    // OnDestroy cleanup.
    if (!isNull(this.options.manipulation)) {
      this.options.manipulation.setManipulateRoot(this.options.frameTransform)
    }
    if (!isNull(this.driverObject)) this.driverObject.destroy()
  }

  private readonly onTranslationUpdate = (event: TranslateEventArg): void => {
    if (!this.gestureActive) return
    // Any config recorded while the hand was stationary is consumed by this
    // update's live option reads. If release wins the race instead, endGesture
    // applies the same pending config before the released spring continues.
    this.clampingConfigurationDirty = false

    const frameTransform = this.options.frameTransform
    const currentOriginWorld = frameTransform.getWorldPosition()
    const liveAnchorOffset = frameTransform.getWorldTransform().multiplyPoint(this.anchorLocal).sub(currentOriginWorld)
    const currentScaleFactor = this.options.getAppliedScaleFactor()
    // The unconstrained driver keeps the scale it had at gesture start. Remove
    // distance scaling's feedback from the live Frame offset so the raw anchor
    // remains tied to IK's original manipulation baseline.
    const anchorOffsetAtDriverScale = liveAnchorOffset.uniformScale(this.driverScaleFactor / currentScaleFactor)
    const proposedAnchorWorld = event.currentPosition.add(anchorOffsetAtDriverScale)
    const clampingEffective = this.isClampingEffective()

    // Camera transforms and the interactor ray are clamp-only inputs; this is
    // the 45 Hz path, so scaling-only gestures must not pay for them. The one
    // inverse computed here is threaded through to applyDisplayedAnchor.
    let cameraInverse: mat4 | null = null
    let clampRay: DepthClampRay | null = null
    let targetAnchorWorld = proposedAnchorWorld
    if (clampingEffective) {
      cameraInverse = this.camera.getInvertedWorldTransform()
      clampRay = this.getAverageRay(event.interactors)
      const result = resolveDepthClampedPosition({
        proposedOriginWorld: event.currentPosition,
        anchorOffsetWorld: anchorOffsetAtDriverScale,
        cameraWorldTransform: this.camera.getWorldTransform(),
        cameraInvertedWorldTransform: cameraInverse,
        minimumDepth: this.options.getMinimumDepth(),
        maximumDepth: this.options.getMaximumDepth(),
        ray: clampRay
      })
      targetAnchorWorld = result.anchorWorldPosition
    }

    const targetCorrection = targetAnchorWorld.sub(proposedAnchorWorld)
    if (
      !this.springInitialCorrection ||
      !clampingEffective ||
      targetCorrection.lengthSquared <= INITIAL_CORRECTION_HANDOFF_EPSILON * INITIAL_CORRECTION_HANDOFF_EPSILON
    ) {
      // Restore the rigid clamp once the hand itself is near the wall (either
      // side) or back in range: the remaining correction is at most the
      // handoff epsilon, so the frame lands on the clamped target without a
      // visible jump and follows the hand without residual pull. A raw anchor
      // still outside the wall keeps its sub-epsilon overshoot in the driver,
      // so rebase it away — otherwise the next inward travel is consumed
      // unwinding it (the dead zone at a smaller scale, sized by the handoff
      // epsilon). An in-range ending has nothing to unwind, and a mid-gesture
      // clamp disable keeps the documented un-clamp semantic of never
      // rebasing the raw grab.
      const rebaseResidualOvershoot =
        this.springInitialCorrection &&
        clampingEffective &&
        targetCorrection.lengthSquared > CORRECTION_POSITION_EPSILON * CORRECTION_POSITION_EPSILON
      this.springInitialCorrection = false
      this.resetSpring()
      this.applyDisplayedAnchor(targetAnchorWorld, cameraInverse ?? undefined)
      if (rebaseResidualOvershoot) this.rebaseDriverAtBoundary()
      return
    }

    this.rawAnchorWorld.copyFrom(proposedAnchorWorld)
    this.targetCorrection.copyFrom(targetCorrection)
    this.lastClampRay = copyRay(clampRay)
    // Unconditionally animating: the settle/handoff decision lives in
    // stepSpringAndApply, so a spring that has caught up to the moving target
    // ends through the same path that owns the boundary rebase (a pre-step
    // settled check here would strand springInitialCorrection without one).
    this.springAnimating = true
    this.stepSpringAndApply(cameraInverse ?? undefined)
  }

  private stepSpringAndApply(cameraInvertedWorldTransform?: mat4): void {
    const stepTime = getTime()
    let rebaseAtSettledBoundary = false
    if (this.springAnimating) {
      if (stepTime !== this.lastSpringStepTime) {
        // Deadline bookkeeping mirrors what the spring actually simulates:
        // per-step wall time capped at the SpringAnimate accumulation limit,
        // with the first step after a reset contributing nothing (timing
        // starts at the first spring step).
        if (this.springInitialCorrection && this.lastSpringStepTime >= 0) {
          this.initialCorrectionSimulatedTime += Math.min(
            stepTime - this.lastSpringStepTime,
            SPRING_MAX_ACCUMULATION_TIME
          )
        }
        this.clampSpring.evaluate(this.currentCorrection, this.targetCorrection, this.currentCorrection)
        this.lastSpringStepTime = stepTime
      }
      // An active initial recovery must end even though its target moves with
      // the hand and the tight settle epsilons may never be reached: hand off
      // once the displayed pose is within the handoff epsilon of the wall, or
      // once the spring has simulated its full nominal duration. Released
      // corrections keep the tight settle only — their target is fixed, and
      // an early end would trade a guaranteed-converging ease for a snap.
      const initialRecoveryHandoff =
        this.springInitialCorrection &&
        this.gestureActive &&
        (this.currentCorrection.distanceSquared(this.targetCorrection) <=
          INITIAL_CORRECTION_HANDOFF_EPSILON * INITIAL_CORRECTION_HANDOFF_EPSILON ||
          this.initialCorrectionSimulatedTime >= CLAMP_SPRING_DURATION)
      if (
        initialRecoveryHandoff ||
        this.clampSpring.isSettled(
          this.currentCorrection,
          this.targetCorrection,
          CORRECTION_POSITION_EPSILON,
          CORRECTION_VELOCITY_EPSILON
        )
      ) {
        this.currentCorrection.copyFrom(this.targetCorrection)
        this.clampSpring.reset()
        this.springAnimating = false
        rebaseAtSettledBoundary = this.springInitialCorrection && this.gestureActive
        this.springInitialCorrection = false
      }
    }

    const displayedAnchorWorld = this.rawAnchorWorld.add(this.currentCorrection)
    this.applyDisplayedAnchor(displayedAnchorWorld, cameraInvertedWorldTransform)
    if (rebaseAtSettledBoundary) this.rebaseDriverAtBoundary()
  }

  private applyDisplayedAnchor(displayedAnchorWorld: vec3, cameraInvertedWorldTransform?: mat4): void {
    const frameTransform = this.options.frameTransform
    const anchorOffsetWorld = frameTransform
      .getWorldTransform()
      .multiplyPoint(this.anchorLocal)
      .sub(frameTransform.getWorldPosition())
    const depthScaling = this.getEffectiveDepthScaling()
    if (depthScaling) {
      const cameraInverse = cameraInvertedWorldTransform ?? this.camera.getInvertedWorldTransform()
      // The world anchor offset is linear in the distance factor, so this is
      // the offset at factor 1 (scaleFactor is clamped >= 1e-4 by
      // normalizeDepthScaleRange). Solving the factor against the origin's
      // depth keeps it consistent with the origin-based refresh() at release,
      // and positioning via unitOffset * factor keeps the displayed grabbed
      // point exactly under the fingers without re-reading the transform
      // after the scale write.
      const unitOffset = anchorOffsetWorld.uniformScale(1 / depthScaling.scaleFactor)
      const anchorDepth = cameraForwardDepth(displayedAnchorWorld, cameraInverse)
      const offsetDepthPerFactor = -cameraInverse.multiplyDirection(unitOffset).z
      const adoptedExternalScale = depthScaling.applyAnchorDepth(anchorDepth, offsetDepthPerFactor)
      if (adoptedExternalScale) {
        // A direct external scale write landed this tick and was adopted as a
        // new factor-1 baseline, so unitOffset's divisor (the pre-write
        // factor) is stale. Re-read the post-scale offset to keep the grabbed
        // point exact; the solved factor's offsetDepthPerFactor was off by the
        // same stale divisor for this one tick and self-corrects on the next
        // update (bounded — the curve output is clamped to the scale range).
        const anchorOffsetAfterScale = frameTransform
          .getWorldTransform()
          .multiplyPoint(this.anchorLocal)
          .sub(frameTransform.getWorldPosition())
        frameTransform.setWorldPosition(displayedAnchorWorld.sub(anchorOffsetAfterScale))
      } else {
        frameTransform.setWorldPosition(displayedAnchorWorld.sub(unitOffset.uniformScale(depthScaling.scaleFactor)))
      }
      depthScaling.recordWorldPosition()
    } else {
      frameTransform.setWorldPosition(displayedAnchorWorld.sub(anchorOffsetWorld))
    }
  }

  private finishGesture(): void {
    this.anchorLocal = vec3.zero()
    this.driverScaleFactor = 1
    this.gestureClampingEnabled = true
    this.gestureScalingEnabled = true
    this.resetSpring()
    this.springInitialCorrection = false
    this.syncDriverToFrame()
  }

  /**
   * The recovery spring may have covered a large distance that the raw hand
   * driver never traversed. Rebase once at the settled boundary so the next
   * inward hand movement leaves the wall immediately instead of first having
   * to unwind the original out-of-range distance.
   */
  private rebaseDriverAtBoundary(): void {
    this.syncDriverToFrame()
    this.driverScaleFactor = this.options.getAppliedScaleFactor()
    if (this.options.manipulation.isManipulating()) this.options.manipulation.updateStartValues()
  }

  private resetSpring(): void {
    this.clampSpring.reset()
    const vec3Zero = vec3.zero()
    this.currentCorrection.copyFrom(vec3Zero)
    this.targetCorrection.copyFrom(vec3Zero)
    this.rawAnchorWorld.copyFrom(vec3Zero)
    this.lastClampRay = null
    this.springAnimating = false
    this.clampingConfigurationDirty = false
    this.lastSpringStepTime = -1
  }

  /** Clamping participates only while gesture-eligible and still enabled. */
  private isClampingEffective(): boolean {
    return this.gestureClampingEnabled && this.options.getClampingEnabled()
  }

  /**
   * Scaling application is gated by the eligibility latch only while the
   * grab is active. A released correction follows live availability instead:
   * the release-time refresh is blocked while the spring animates and
   * settlement deliberately never refreshes scale, so this is the only path
   * that can apply an enable arriving at release or during the correction.
   */
  private getEffectiveDepthScaling(): DepthScaling | null {
    if (!this.gestureActive) return this.options.getDepthScaling()
    return this.gestureScalingEnabled ? this.options.getDepthScaling() : null
  }

  private anchorStartsOutsideDepthRange(): boolean {
    if (!this.isClampingEffective()) return false
    const anchorWorld = this.options.frameTransform.getWorldTransform().multiplyPoint(this.anchorLocal)
    const depth = cameraForwardDepth(anchorWorld, this.camera.getInvertedWorldTransform())
    if (!Number.isFinite(depth)) return false
    const range = normalizeDepthRange(this.options.getMinimumDepth(), this.options.getMaximumDepth())
    return depth < range.minimum || depth > range.maximum
  }

  private getAverageRay(interactors: Interactor[]): DepthClampRay | null {
    let start = vec3.zero()
    let direction = vec3.zero()
    let count = 0
    for (const interactor of interactors) {
      if (interactor.startPoint === null || interactor.direction === null) continue
      start = start.add(interactor.startPoint)
      direction = direction.add(interactor.direction)
      count++
    }
    if (count === 0) return null
    const averageDirection = direction.uniformScale(1 / count)
    if (averageDirection.lengthSquared < MINIMUM_AVERAGE_RAY_LENGTH_SQUARED) return null
    return {startWorld: start.uniformScale(1 / count), directionWorld: averageDirection.normalize()}
  }

  private syncDriverToFrame(): void {
    this.driverTransform.setWorldTransform(this.options.frameTransform.getWorldTransform())
  }
}

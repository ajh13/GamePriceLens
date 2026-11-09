import {SpringAnimate1D} from "InteractionKit.lspkg/Utils/springAnimate"

export type BaseScrollerBounds = {
  min: number
  max: number
  unbounded?: boolean
}

/** Flat physics tuning for one BaseScroller axis, typically produced by ScrollerPresets' makeScroller. */
export type BaseScrollerConfig = {
  /** Position tolerance for bounds/settle checks; also the default hasMotion velocity threshold. */
  epsilon: number
  /** Reference frame time (s) the friction/smoothing decay rates are expressed per; also scales fling-distance projection. */
  velocityBaseFrameTime: number
  /** Floor on sample deltaTime — guards against huge velocities from tiny frame deltas. */
  minVelocitySampleDeltaTime: number
  /** |sample velocity| above this refreshes the release-freshness window (see flingIdleTimeoutMs). */
  significantVelocityThreshold: number
  /** Base retention of prior accumulated velocity when releases chain, scaled down by elapsed window time. */
  velocityDecayFactor: number
  /** Scales the accumulated release velocity into the fling velocity. */
  flingMultiplier: number
  /** Coast decay per velocityBaseFrameTime; >= 1 never decays (infinite projected distance). */
  frictionFactor: number
  /** Coasting settles below this speed; 5% of it is the default spring-settle velocity threshold. */
  minimumScrollingVelocity: number
  /** EMA blend per velocityBaseFrameTime for velocity samples (0-1, lower = smoother but more lag). */
  velocitySmoothing: number
  /** Most-recent-first weights for the release-velocity average; length sets the history size. */
  velocityHistoryWeights: number[]
  /** Release velocity reads as zero when the last significant sample is older than this (ms). */
  flingIdleTimeoutMs: number
  /** Window (ms) within which successive same-direction releases chain their velocities. */
  gestureAccumulationTimeMs: number
  /** Steepens the overscroll resistance curve (curve exponent 0.5 + 0.2 * this). */
  edgeBounceStrength: number
  /** When finite, builds the settle spring via SpringAnimate1D.smooth — wins over springK/springDamp/springMass. */
  springDuration?: number
  /** Manual spring stiffness (default 150); used only when springDuration is not finite. */
  springK?: number
  /** Manual spring damping (default 21); used only when springDuration is not finite. */
  springDamp?: number
  /** Manual spring mass (default 1); used only when springDuration is not finite. */
  springMass?: number
}

export type BaseScrollerStepResult = {
  position: number
  shouldUpdate: boolean
  velocity: number
}

export type BaseScrollerSpringStepResult = {
  position: number
  settled: boolean
  velocity: number
}

/**
 * Pure 1D scroll-physics kernel — one instance per axis, no snap knowledge.
 * Owns weighted velocity sampling/smoothing, friction coasting, the settle
 * spring, and elastic overscroll resistance. Positions are consumer units,
 * velocities units/second, timestamps milliseconds. ScrollWindow composes one
 * instance per axis; NumberPickerFieldScroller extends it. Snap-target
 * selection sits beside it in SnapScrollPolicy (ScrollUtilities.ts).
 */
export class BaseScroller {
  private readonly velocityHistory: Float32Array
  private readonly velocityHistoryWeights: number[]
  private readonly velocityHistoryWeightSums: Float32Array
  private readonly spring: SpringAnimate1D

  private startPositionValue: number = 0
  private inputOffsetValue: number = 0
  private lastPositionValue: number = 0
  private velocitySamplingBaselineValid: boolean = true
  private velocityValue: number = 0
  private accumulatedVelocityValue: number = 0
  private flingVelocityValue: number = 0
  private hasPendingFlingVelocityValue: boolean = false
  private velocityHistoryHead: number = 0
  private velocityHistoryLength: number = 0
  private lastSignificantVelocitySampleTimeMs: number = 0
  private lastGestureEndTimeMs: number = 0
  private dragging: boolean = false

  public constructor(private readonly config: BaseScrollerConfig) {
    this.velocityHistoryWeights = config.velocityHistoryWeights.slice()
    this.velocityHistory = new Float32Array(this.velocityHistoryWeights.length)
    this.velocityHistoryWeightSums = new Float32Array(this.velocityHistoryWeights.length)

    let total = 0
    for (let i = 0; i < this.velocityHistoryWeights.length; i++) {
      total += this.velocityHistoryWeights[i] || 0
      this.velocityHistoryWeightSums[i] = total
    }

    if (Number.isFinite(config.springDuration)) {
      this.spring = SpringAnimate1D.smooth(config.springDuration as number)
    } else {
      this.spring = new SpringAnimate1D(config.springK ?? 150, config.springDamp ?? 21, config.springMass ?? 1)
    }
  }

  public get startPosition(): number {
    return this.startPositionValue
  }

  public set startPosition(position: number) {
    this.startPositionValue = position
  }

  public get lastPosition(): number {
    return this.lastPositionValue
  }

  public set lastPosition(position: number) {
    this.lastPositionValue = position
    this.velocitySamplingBaselineValid = true
  }

  public get inputOffset(): number {
    return this.inputOffsetValue
  }

  public get isDragging(): boolean {
    return this.dragging
  }

  public get velocity(): number {
    return this.velocityValue
  }

  public get accumulatedVelocity(): number {
    return this.accumulatedVelocityValue
  }

  public get flingVelocity(): number {
    return this.flingVelocityValue
  }

  /** True from release until the fling/snap decision consumes it — latched even for zero-velocity releases. */
  public get hasPendingFlingVelocity(): boolean {
    return this.hasPendingFlingVelocityValue
  }

  public get springVelocity(): number {
    return this.spring.velocity
  }

  public set springVelocity(velocity: number) {
    this.spring.velocity = velocity
  }

  public beginDrag(position: number, inputPosition: number): void {
    this.startPositionValue = position
    this.lastPositionValue = position
    this.velocitySamplingBaselineValid = true
    this.inputOffsetValue = inputPosition
    this.velocityValue = 0
    this.clearPendingFlingVelocity()
    this.dragging = true
    this.clearVelocityHistory()
    this.resetSpring()
  }

  public getDragPosition(inputPosition: number): number {
    return this.startPositionValue + inputPosition - this.inputOffsetValue
  }

  /**
   * Reference-frame-shift primitive: translates the gesture anchor AND the velocity
   * sampling baseline by the same delta, so shifting the coordinate frame mid-drag
   * produces no velocity spike. Deliberately does NOT touch inputOffset (interactor
   * input space), the accumulated/fling/spring velocities (translation-invariant),
   * or any spring state.
   */
  public offsetGestureAnchor(delta: number): void {
    this.startPositionValue += delta
    this.lastPositionValue += delta
  }

  public endDrag(currentTimeMs: number = getTime() * 1000): void {
    if (!this.dragging) {
      return
    }

    this.dragging = false
    this.applyAccumulatedVelocity(currentTimeMs)
  }

  public cancelMotion(): void {
    this.dragging = false
    this.velocityValue = 0
    this.accumulatedVelocityValue = 0
    this.lastGestureEndTimeMs = 0
    // A full cancellation ends the current sampling session. BaseScroller does
    // not know the consumer's authoritative pose, so the next position sample
    // must establish a new baseline instead of measuring from this stale one.
    this.velocitySamplingBaselineValid = false
    this.clearPendingFlingVelocity()
    this.clearVelocityHistory()
    this.resetSpring()
  }

  public clearVelocityHistory(): void {
    // A new history/EMA session must not blend with the prior samples. This
    // narrower reset deliberately preserves the continuous position baseline;
    // cancelMotion invalidates that baseline separately, while beginDrag and
    // external-controller setup explicitly re-seed it.
    this.velocityValue = 0
    this.velocityHistoryHead = 0
    this.velocityHistoryLength = 0
    this.lastSignificantVelocitySampleTimeMs = 0
  }

  public clearPendingFlingVelocity(): void {
    this.flingVelocityValue = 0
    this.hasPendingFlingVelocityValue = false
  }

  /**
   * Directly sets the fling velocity (non-finite coerces to 0). `pending`
   * latches only for a NONZERO resulting velocity — unlike endDrag's
   * applyAccumulatedVelocity, which latches even zero-velocity releases. Use
   * scaleFlingVelocity for coordinate-space changes that must preserve the
   * existing release latch.
   */
  public setFlingVelocity(velocity: number, pending: boolean = false): void {
    this.flingVelocityValue = Number.isFinite(velocity) ? velocity : 0
    this.hasPendingFlingVelocityValue = pending && Math.abs(this.flingVelocityValue) > 0
  }

  /**
   * Rescales only the fling velocity while preserving the pending-release
   * latch. A zero-velocity release still carries positional snap intent, so a
   * geometry rescale must not turn it into an ordinary nearest-page settle.
   */
  public scaleFlingVelocity(factor: number): void {
    if (!Number.isFinite(factor)) {
      return
    }
    this.flingVelocityValue *= factor
  }

  public scaleVelocity(factor: number): void {
    if (!Number.isFinite(factor)) {
      return
    }
    this.velocityValue *= factor
    this.accumulatedVelocityValue *= factor
    this.flingVelocityValue *= factor
    this.spring.velocity *= factor
  }

  public resetSpring(): void {
    this.spring.reset()
  }

  public updateVelocityFromPosition(
    newPosition: number,
    deltaTime: number = getDeltaTime(),
    currentTimeMs: number = getTime() * 1000,
    velocityScale: number = 1
  ): void {
    if (!this.velocitySamplingBaselineValid) {
      this.lastPositionValue = newPosition
      this.velocitySamplingBaselineValid = true
      return
    }

    const sampleDeltaTime = Math.max(deltaTime, this.config.minVelocitySampleDeltaTime)
    const safeVelocityScale = Number.isFinite(velocityScale) && velocityScale >= 0 ? velocityScale : 0
    // Normalize before every velocity-derived decision. Scaling only at
    // release would leave EMA/history and, critically, freshness thresholds in
    // the external controller's amplified coordinate space.
    const newVelocity = ((newPosition - this.lastPositionValue) / sampleDeltaTime) * safeVelocityScale
    const smoothing = this.getVelocitySmoothingFactor(sampleDeltaTime)
    this.velocityValue = this.velocityValue * (1 - smoothing) + newVelocity * smoothing
    this.addVelocityToHistory(this.velocityValue)

    if (Math.abs(newVelocity) > this.config.significantVelocityThreshold) {
      this.lastSignificantVelocitySampleTimeMs = currentTimeMs
    }

    this.lastPositionValue = newPosition
  }

  public getWeightedAverageVelocity(): number {
    const length = this.velocityHistoryLength
    if (length === 0) {
      return 0
    }

    let weightedVelocity = 0
    for (let i = 0; i < length; i++) {
      const weight = this.velocityHistoryWeights[i] || 0
      const index = (this.velocityHistoryHead + i) % this.velocityHistory.length
      weightedVelocity += this.velocityHistory[index] * weight
    }

    const totalWeight = this.velocityHistoryWeightSums[length - 1]
    return totalWeight > 0 ? weightedVelocity / totalWeight : 0
  }

  /**
   * Converts a release into a fling: samples the weighted average velocity
   * (zero when the last significant sample is older than flingIdleTimeoutMs),
   * chains it onto recent same-direction releases, and latches the pending fling.
   */
  public applyAccumulatedVelocity(currentTimeMs: number = getTime() * 1000): void {
    const weightedVelocity = this.isReleaseVelocityFresh(currentTimeMs) ? this.getWeightedAverageVelocity() : 0
    this.accumulateVelocity(weightedVelocity, currentTimeMs)
    this.flingVelocityValue = this.accumulatedVelocityValue * this.config.flingMultiplier
    this.hasPendingFlingVelocityValue = true
  }

  /**
   * Idealized coast distance for |velocity|: the full geometric series
   * (sum of v * f^n * dt from n = 0). Slightly overestimates the discrete
   * stepFriction integration (~4.5% at 60 fps on the smooth feel) — stepping
   * advances by the post-decay velocity and the coast truncates below
   * minimumScrollingVelocity — so consumers must treat it as a page-count
   * heuristic, never as exact.
   */
  public getProjectedFlingDistance(velocity: number = Math.abs(this.flingVelocityValue)): number {
    if (this.config.frictionFactor >= 1) {
      return Number.POSITIVE_INFINITY
    }
    return (Math.abs(velocity) * this.config.velocityBaseFrameTime) / (1 - this.config.frictionFactor)
  }

  /**
   * Advances one coasting frame: decays the fling velocity by frictionFactor.
   * Below minimumScrollingVelocity the motion ends by settling to clampedPosition;
   * shouldUpdate false means there was no fling to step.
   */
  public stepFriction(
    currentPosition: number,
    clampedPosition: number,
    deltaTime: number = getDeltaTime()
  ): BaseScrollerStepResult {
    const velocity = this.flingVelocityValue
    const stepDeltaTime = Math.max(deltaTime, 0)

    if (Math.abs(velocity) > this.config.minimumScrollingVelocity) {
      if (stepDeltaTime === 0) {
        return {
          position: currentPosition,
          shouldUpdate: false,
          velocity
        }
      }

      const decay = Math.pow(this.config.frictionFactor, stepDeltaTime / this.config.velocityBaseFrameTime)
      const newVelocity = velocity * decay
      this.flingVelocityValue = newVelocity
      this.hasPendingFlingVelocityValue = false
      return {
        position: currentPosition + newVelocity * stepDeltaTime,
        shouldUpdate: true,
        velocity: newVelocity
      }
    }

    if (Math.abs(velocity) > 0) {
      this.clearPendingFlingVelocity()
      return {
        position: clampedPosition,
        shouldUpdate: true,
        velocity: 0
      }
    }

    if (this.hasPendingFlingVelocityValue) {
      this.clearPendingFlingVelocity()
    }

    return {
      position: currentPosition,
      shouldUpdate: false,
      velocity: 0
    }
  }

  /**
   * Advances the settle spring and returns only its scalar position.
   * Use this on hot paths that perform their own settle check and do not need
   * the allocating {@link BaseScrollerSpringStepResult} convenience wrapper.
   */
  public evaluateSpringPosition(currentPosition: number, targetPosition: number): number {
    return this.spring.evaluate(currentPosition, targetPosition)
  }

  public evaluateSpring(
    currentPosition: number,
    targetPosition: number,
    positionThreshold: number = this.config.epsilon,
    velocityThreshold: number = this.config.minimumScrollingVelocity * 0.05
  ): BaseScrollerSpringStepResult {
    const position = this.evaluateSpringPosition(currentPosition, targetPosition)
    return {
      position,
      settled: this.spring.isSettled(position, targetPosition, positionThreshold, velocityThreshold),
      velocity: this.spring.velocity
    }
  }

  public isSpringSettled(
    currentPosition: number,
    targetPosition: number,
    positionThreshold: number = this.config.epsilon,
    velocityThreshold: number = this.config.minimumScrollingVelocity * 0.05
  ): boolean {
    return this.spring.isSettled(currentPosition, targetPosition, positionThreshold, velocityThreshold)
  }

  public getClampedPosition(position: number, bounds: BaseScrollerBounds): number {
    if (bounds.unbounded === true) {
      return position
    }
    const min = Math.min(bounds.min, bounds.max)
    const max = Math.max(bounds.min, bounds.max)
    return BaseScroller.clamp(position, min, max)
  }

  public isOutOfBounds(position: number, bounds: BaseScrollerBounds): boolean {
    return Math.abs(position - this.getClampedPosition(position, bounds)) > this.config.epsilon
  }

  public applyOverscroll(position: number, bounds: BaseScrollerBounds, maxOverscroll: number): number {
    const clampedPosition = this.getClampedPosition(position, bounds)
    if (Math.abs(position - clampedPosition) <= this.config.epsilon) {
      return position
    }
    return clampedPosition + this.calculateResistance(position - clampedPosition, maxOverscroll)
  }

  public calculateResistance(displacement: number, maxOverscroll: number): number {
    if (Math.abs(displacement) <= this.config.epsilon || maxOverscroll <= 0) {
      return 0
    }

    const normalized = Math.abs(displacement) / maxOverscroll
    const curveExponent = 0.5 + this.config.edgeBounceStrength * 0.2
    const resistanceFactor = Math.pow(1 - Math.min(normalized, 1), curveExponent)
    return Math.sign(displacement) * maxOverscroll * (1 - resistanceFactor)
  }

  /**
   * Recover raw drag displacement from the displayed resistance displacement.
   * For finite inputs and a positive curve exponent, this inverts the curve
   * outside the epsilon dead zone and below saturation. Saturation loses the raw distance:
   * values at or beyond the display limit return the signed limit instead.
   * Preserve near-zero displacement and disabled limits for drag-pose rebasing.
   */
  public calculateUnresistedDisplacement(displacement: number, maxOverscroll: number): number {
    if (Math.abs(displacement) <= this.config.epsilon || maxOverscroll <= 0) {
      return displacement
    }

    const normalized = Math.min(Math.abs(displacement) / maxOverscroll, 1)
    const curveExponent = 0.5 + this.config.edgeBounceStrength * 0.2
    return Math.sign(displacement) * maxOverscroll * (1 - Math.pow(1 - normalized, 1 / curveExponent))
  }

  public hasMotion(velocityThreshold: number = this.config.epsilon): boolean {
    return (
      this.dragging ||
      this.hasPendingFlingVelocityValue ||
      Math.abs(this.flingVelocityValue) > velocityThreshold ||
      Math.abs(this.spring.velocity) > velocityThreshold
    )
  }

  private getVelocitySmoothingFactor(deltaTime: number): number {
    return 1 - Math.pow(1 - this.config.velocitySmoothing, deltaTime / this.config.velocityBaseFrameTime)
  }

  private addVelocityToHistory(velocity: number): void {
    if (this.velocityHistory.length === 0) {
      return
    }

    this.velocityHistoryHead =
      (this.velocityHistoryHead + this.velocityHistory.length - 1) % this.velocityHistory.length
    this.velocityHistory[this.velocityHistoryHead] = velocity
    if (this.velocityHistoryLength < this.velocityHistory.length) {
      this.velocityHistoryLength++
    }
  }

  private isReleaseVelocityFresh(currentTimeMs: number): boolean {
    if (this.velocityHistoryLength === 0 || this.lastSignificantVelocitySampleTimeMs === 0) {
      return false
    }

    return currentTimeMs - this.lastSignificantVelocitySampleTimeMs <= this.config.flingIdleTimeoutMs
  }

  private accumulateVelocity(currentVelocity: number, currentTimeMs: number): void {
    const timeSinceLastGesture = currentTimeMs - this.lastGestureEndTimeMs

    if (timeSinceLastGesture > this.config.gestureAccumulationTimeMs) {
      this.accumulatedVelocityValue = currentVelocity
      this.lastGestureEndTimeMs = currentTimeMs
      return
    }

    const timeFactor = 1 - timeSinceLastGesture / this.config.gestureAccumulationTimeMs
    const decayFactor = this.config.velocityDecayFactor * timeFactor
    this.accumulatedVelocityValue = this.shouldAccumulate(this.accumulatedVelocityValue, currentVelocity)
      ? this.accumulatedVelocityValue * decayFactor + currentVelocity
      : currentVelocity
    this.lastGestureEndTimeMs = currentTimeMs
  }

  private shouldAccumulate(accumulated: number, current: number): boolean {
    return accumulated === 0 || Math.sign(current) === Math.sign(accumulated)
  }

  private static clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value))
  }
}

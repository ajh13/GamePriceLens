import WorldCameraFinderProvider from "InteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import {cameraForwardDepth, resolveAnchorPivotedScaleFactor, resolveDepthScaleFactor} from "./FrameDepthClampMath"

const SCALE_EPSILON_SQUARED = 1e-8
const POSITION_EPSILON_SQUARED = 1e-6

export type DepthScalingOptions = {
  sceneObject: SceneObject
  transform: Transform
  getMinimumDepth: () => number
  getMaximumDepth: () => number
  getMinimumScale: () => number
  getMaximumScale: () => number
}

/**
 * Owns Frame's distance-derived local scale without polling.
 *
 * The local scale present at construction is the authored 1x baseline. If an
 * external owner writes a different local scale between refreshes, that value
 * is adopted as the new authored baseline — unless the owning SceneObject was
 * reparented, in which case the write is treated as the engine's
 * world-preserving parent compensation and the baseline is re-expressed in
 * the new parent space instead. Suspension deliberately disables adoption so
 * Focus Frame's temporary animation scale cannot leak into the baseline.
 */
export default class DepthScaling {
  private readonly camera = WorldCameraFinderProvider.getInstance()
  private baselineLocalScale: vec3 = vec3.one()
  private expectedLocalScale: vec3 = vec3.one()
  private currentFactor: number = 1
  private lastWorldPosition: vec3 = vec3.zero()
  private lastKnownParent: SceneObject | null
  private suspended: boolean = false

  /** Last distance factor applied on top of the authored baseline. */
  public get scaleFactor(): number {
    return this.currentFactor
  }

  public constructor(private readonly options: DepthScalingOptions) {
    this.baselineLocalScale.copyFrom(options.transform.getLocalScale())
    this.expectedLocalScale.copyFrom(this.baselineLocalScale)
    this.lastWorldPosition.copyFrom(options.transform.getWorldPosition())
    this.lastKnownParent = options.sceneObject.getParent()
  }

  /** Force a recalculation, including after an external teleport. */
  public refresh(): void {
    if (this.suspended) return
    const worldPosition = this.options.transform.getWorldPosition()
    const depth = cameraForwardDepth(worldPosition, this.camera.getInvertedWorldTransform())
    this.applyDepth(depth)
    this.lastWorldPosition.copyFrom(worldPosition)
  }

  /** Recalculate only if UIKit actually changed the Frame's world position. */
  public refreshAfterMovement(): void {
    if (this.suspended) return
    const worldPosition = this.options.transform.getWorldPosition()
    if (worldPosition.distanceSquared(this.lastWorldPosition) <= POSITION_EPSILON_SQUARED) return
    const depth = cameraForwardDepth(worldPosition, this.camera.getInvertedWorldTransform())
    this.applyDepth(depth)
    this.lastWorldPosition.copyFrom(worldPosition)
  }

  /** Apply a shared resolved depth, used synchronously by manipulation. */
  public applyDepth(depth: number): void {
    if (this.suspended) return
    const adoptedExternalScale = this.adoptExternalScale()
    const factor = resolveDepthScaleFactor(
      depth,
      this.options.getMinimumDepth(),
      this.options.getMaximumDepth(),
      this.options.getMinimumScale(),
      this.options.getMaximumScale()
    )
    this.commitFactor(factor, adoptedExternalScale)
  }

  /**
   * Apply the factor for a manipulation pivoting around a grabbed anchor. The
   * factor is solved against the ORIGIN's depth (`anchorDepth - factor *
   * offsetDepthPerFactor`), so the origin-based refresh() at release resolves
   * to the same factor and the transition cannot pop the scale.
   *
   * Returns true when a direct external scale write was adopted as a new
   * authored baseline this call: the caller's offset-per-factor inputs were
   * derived against the pre-write factor and no longer match the transform,
   * so anchor-preserving positioning must re-read the post-scale offset.
   */
  public applyAnchorDepth(anchorDepth: number, offsetDepthPerFactor: number): boolean {
    if (this.suspended) return false
    const adoptedExternalScale = this.adoptExternalScale()
    const factor = resolveAnchorPivotedScaleFactor(
      anchorDepth,
      offsetDepthPerFactor,
      this.options.getMinimumDepth(),
      this.options.getMaximumDepth(),
      this.options.getMinimumScale(),
      this.options.getMaximumScale()
    )
    this.commitFactor(factor, adoptedExternalScale)
    return adoptedExternalScale
  }

  private commitFactor(factor: number, adoptedExternalScale: boolean): void {
    if (!adoptedExternalScale && Math.abs(factor - this.currentFactor) <= 1e-4) return

    this.currentFactor = factor
    this.expectedLocalScale = this.baselineLocalScale.uniformScale(factor)
    this.options.transform.setLocalScale(this.expectedLocalScale)
  }

  /** Keep movement detection synchronized after manipulation commits a pose. */
  public recordWorldPosition(): void {
    this.lastWorldPosition.copyFrom(this.options.transform.getWorldPosition())
  }

  /** Freeze the current distance factor while another system owns scale. */
  public suspend(): void {
    this.suspended = true
  }

  /** Resume without adopting scale writes made while suspended. */
  public resume(recalculate: boolean = true): void {
    if (!this.suspended) return
    this.suspended = false
    // Focus Frame has returned to the frozen scale by this point. Keep our
    // expected value authoritative, then resolve against the current pose.
    this.options.transform.setLocalScale(this.expectedLocalScale)
    if (recalculate) this.refresh()
  }

  /** Remove the distance factor and restore the current authored baseline. */
  public destroy(): void {
    if (!this.suspended) this.adoptExternalScale()
    this.currentFactor = 1
    this.expectedLocalScale.copyFrom(this.baselineLocalScale)
    this.options.transform.setLocalScale(this.expectedLocalScale)
  }

  /**
   * Classify an unexpected local-scale write. A reparent that preserves world
   * transform rewrites local scale purely to compensate the new parent — the
   * authored WORLD baseline is unchanged, so the baseline is re-expressed in
   * the new parent space instead of adopting the compensation as authoring.
   *
   * Residual: the parent cache refreshes only on these calls, so a plain
   * setParent followed by an authored setLocalScale before any applyDepth
   * tick is misclassified as compensation. Bounded (baseline off by
   * 1/factor), non-compounding, and self-correcting on the next authored
   * write under an unchanged parent; the runtime exposes no reparent event
   * that could close this window.
   */
  private adoptExternalScale(): boolean {
    const actual = this.options.transform.getLocalScale()
    // Defensive only: a null/destroyed sceneObject reference degrades the
    // compare to the authored branch. Not teardown protection — the transform
    // reads here assume the frame node is alive, which holds for every
    // current caller (destroy runs inside the Frame's own lifecycle events).
    const sceneObject = this.options.sceneObject
    const currentParent = isNull(sceneObject) ? this.lastKnownParent : sceneObject.getParent()
    if (actual.distanceSquared(this.expectedLocalScale) <= SCALE_EPSILON_SQUARED) {
      this.lastKnownParent = currentParent
      return false
    }

    if (currentParent !== this.lastKnownParent) {
      // Reparent compensation: preserve the authored world baseline by
      // dividing the engine-written local by the active factor (clamped to
      // >= 1e-4 by normalizeDepthScaleRange, so the division is safe).
      this.baselineLocalScale = actual.uniformScale(1 / this.currentFactor)
      this.expectedLocalScale.copyFrom(actual)
      this.lastKnownParent = currentParent
      return false
    }

    // A direct external write expresses a new authored 1x scale. Reapply the
    // active distance factor from that baseline instead of compounding it.
    this.baselineLocalScale.copyFrom(actual)
    this.expectedLocalScale.copyFrom(actual)
    return true
  }
}

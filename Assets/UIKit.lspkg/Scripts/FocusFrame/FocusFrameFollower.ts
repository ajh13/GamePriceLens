import animate, {CancelSet, easingFunctions, mix} from "InteractionKit.lspkg/Utils/animate"
import Event, {PublicApi} from "InteractionKit.lspkg/Utils/Event"
import {CancelToken, clearTimeout, setTimeout} from "InteractionKit.lspkg/Utils/FunctionTimingUtils"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import {FocusFrameManager} from "./FocusFrameManager"
import {FocusFrameParticipant, FocusFramePose} from "./FocusFrameTypes"

const log = new NativeLogger("FocusFrameFollower")

export interface FocusFrameFollowerOptions {
  /** The transform that actually moves (the field itself, or an ancestor Frame). */
  target: Transform

  /**
   * The scene object that MOVES — the target's own scene object. Also the sharing key:
   * followers acquired via {@link FocusFrameFollower.acquire} for the same target scene
   * object are shared, so multiple fields inside one Frame drive a single mover.
   */
  sceneObject: SceneObject

  /** Stable id; defaults to the scene object's unique identifier plus a random suffix. */
  focusFrameId?: string

  /** Dock/undock tween duration in milliseconds. */
  durationMs?: number

  /** Dock/undock easing curve. */
  easing?: keyof typeof easingFunctions

  /** Uniform scale applied while docked (relative to the original scale). */
  scaleFactor?: number

  /**
   * Maximum docked content height (in the target's own units). If scaling by
   * `scaleFactor` would exceed this, the scale is reduced to fit. Only applied when
   * `getContentHeight` is supplied.
   */
  maxHeight?: number

  /** Lower bound on the docked scale multiplier after max-height clamping. */
  minScale?: number

  /**
   * Optional supplier of the target's unscaled content height, used for the max-height
   * clamp AND to lift the element off the anchor so its bottom edge rests on it (rather
   * than its center sitting on the anchor). A Frame supplies its `totalSize.y`, a text
   * field its own height. Returns null/undefined when unknown (then no lift is applied).
   */
  getContentHeight?: () => number | null | undefined

  /**
   * Fraction of the (scaled) content height to lift the element above the anchor along the
   * anchor's up axis. Defaults to 0.5 (center pivot), which places the element's bottom
   * edge on the anchor. Use 0 for a bottom-pivoted target. Ignored without getContentHeight.
   */
  pivotHeightFraction?: number

  /**
   * Additional fixed offset from the anchor, expressed in anchor-local space (x = right,
   * y = up, z = forward), applied on top of the pivot lift. Use e.g. a small +z to hold a
   * gap in front of the keyboard. Defaults to zero.
   */
  anchorOffset?: vec3

  /**
   * Grace period, in milliseconds, to keep focus after the last release before actually
   * undocking. If a new request arrives within it, the undock is cancelled and the panel
   * stays put. Bridges the gap during a field switch, where the text-input manager blurs
   * the old field immediately but delays focusing the new one. Defaults to 0 (undock
   * immediately). The text-input integration passes the manager's switch delay.
   */
  releaseGraceMs?: number

  /** Called when the element starts docking (focus granted). */
  onFocusStart?: () => void

  /** Called after the element has fully returned to its resting pose (revoke complete). */
  onReturnComplete?: () => void

  /** Called when the user starts dragging the keyboard while this element is focused. */
  onAnchorMovementStarted?: () => void

  /** Called when the user stops dragging the keyboard while this element is focused. */
  onAnchorMovementEnded?: () => void
}

const DEFAULT_DURATION_MS = 700
const DEFAULT_EASING: keyof typeof easingFunctions = "ease-in-out-cubic"
const DEFAULT_SCALE_FACTOR = 0.9
const DEFAULT_MAX_HEIGHT = 35
const DEFAULT_MIN_SCALE = 0.5
const DEFAULT_PIVOT_HEIGHT_FRACTION = 0.5

/**
 * FocusFrameFollower
 *
 * Reusable behavior that docks a target transform to the focus-frame anchor while focused
 * and returns it to rest when unfocused. Implements {@link FocusFrameParticipant}, so it
 * is driven entirely by the {@link FocusFrameManager}.
 *
 * Motion has two phases:
 *  1. Dock-in — a fixed-duration eased tween (self-ticking via IK `animate`) from the
 *     recorded resting pose to the (live) anchor pose, tracking the anchor even if it
 *     moves during the tween.
 *  2. Tracking — while docked, the target's world pose is re-asserted every frame (via a
 *     LateUpdateEvent) from the latest anchor pose, and refreshed immediately whenever a new
 *     pose is streamed. The per-frame reassert is what keeps the element pinned to the
 *     keyboard even when its parent (e.g. a Frame it lives under) is moved: the pose stream
 *     itself quiesces once the keyboard settles, so without a per-frame tick a parent move
 *     would drag the docked element off the anchor with nothing to correct it. LateUpdate
 *     runs after interaction moves the parent, so the reassert overrides it in the same frame.
 *
 * On revoke it eases back to the recorded resting pose (recorded in local space so it is
 * correct even if the parent moved) and resumes the owner.
 *
 * ## Sharing
 * Multiple fields inside one Frame resolve to the same movable target. Use
 * {@link FocusFrameFollower.acquire} / {@link releaseShared} so they share ONE follower
 * keyed by the target scene object — a single recorded rest pose, a single tween on the
 * transform, and one suspend/resume owner. A focus reference count keeps the panel docked
 * while any field in it is being edited, so switching fields within a panel doesn't bounce.
 */
export class FocusFrameFollower implements FocusFrameParticipant {
  // Target-scene-object-keyed shared instances (see acquire/releaseShared).
  private static shared: Map<string, {follower: FocusFrameFollower; refCount: number}> = new Map()

  public readonly focusFrameId: string

  private readonly target: Transform
  private readonly sceneObject: SceneObject
  private readonly sharingKey: string

  private readonly durationMs: number
  private readonly easing: keyof typeof easingFunctions
  private readonly scaleFactor: number
  private readonly maxHeight: number
  private readonly minScale: number
  private readonly pivotHeightFraction: number
  private readonly anchorOffset: vec3
  private readonly releaseGraceMs: number
  private readonly getContentHeight?: () => number | null | undefined

  private readonly onFocusStart?: () => void
  private readonly onReturnComplete?: () => void
  private readonly onMovementStartedCb?: () => void
  private readonly onMovementEndedCb?: () => void

  private originalLocalPosition: vec3 | null = null
  private originalLocalRotation: quat | null = null
  private originalLocalScale: vec3 | null = null

  private latestPose: FocusFramePose | null = null
  private cancelSet: CancelSet | null = null
  private tracking: boolean = false
  private registered: boolean = false
  // Net number of fields currently requesting focus through this (possibly shared)
  // follower. The panel stays docked while > 0, so switching between fields in one panel
  // doesn't bounce it home and back.
  private focusWantCount: number = 0
  // Pending grace-period undock (see releaseGraceMs), cancelled if focus returns first.
  private pendingReleaseToken: CancelToken | null = null
  // True between onFocusStart and the matching resume, so the owner (e.g. a suspended
  // Frame) is always resumed exactly once even if the return tween is cancelled or the
  // follower is destroyed mid-motion. onFocusStart/onReturnComplete must be idempotent.
  private ownerSuspended: boolean = false
  private destroyed: boolean = false

  // Multicast "docked" state for observers (e.g. fields tucking in their mic slot while at
  // the keyboard). True from focus grant (docking imminent, even before the first anchor
  // pose) until undock STARTS, so observers can restore during the return flight. An
  // options callback can't serve this: acquire() ignores options after the first acquire
  // on a shared target, which would silently drop sibling fields' callbacks.
  private readonly dockStateEvent: Event<boolean> = new Event<boolean>()
  public readonly onDockStateChanged: PublicApi<boolean> = this.dockStateEvent.publicApi()
  private dockStateForEvent: boolean = false

  // Per-frame reassert of the docked world pose while tracking. Lazily created on first
  // dock and left in place (its event just toggled) so dock/undock cycles don't churn scene
  // objects. Runs in LateUpdate so it corrects a parent move within the same frame.
  private tickSceneObject: SceneObject | null = null
  private tickEvent: SceneEvent | null = null

  public constructor(options: FocusFrameFollowerOptions) {
    this.target = options.target
    this.sceneObject = options.sceneObject
    this.sharingKey = FocusFrameFollower.keyFor(options.sceneObject)
    this.focusFrameId = options.focusFrameId ?? `focusframe_${this.sharingKey}`

    this.durationMs = options.durationMs ?? DEFAULT_DURATION_MS
    this.easing = options.easing ?? DEFAULT_EASING
    this.scaleFactor = options.scaleFactor ?? DEFAULT_SCALE_FACTOR
    this.maxHeight = options.maxHeight ?? DEFAULT_MAX_HEIGHT
    this.minScale = options.minScale ?? DEFAULT_MIN_SCALE
    this.pivotHeightFraction = options.pivotHeightFraction ?? DEFAULT_PIVOT_HEIGHT_FRACTION
    this.anchorOffset = options.anchorOffset ?? vec3.zero()
    this.releaseGraceMs = Math.max(0, options.releaseGraceMs ?? 0)
    this.getContentHeight = options.getContentHeight

    this.onFocusStart = options.onFocusStart
    this.onReturnComplete = options.onReturnComplete
    this.onMovementStartedCb = options.onAnchorMovementStarted
    this.onMovementEndedCb = options.onAnchorMovementEnded
  }

  private static keyFor(sceneObject: SceneObject): string {
    return sceneObject.uniqueIdentifier || sceneObject.name
  }

  // --- Shared acquisition -------------------------------------------------------------

  /**
   * Returns a follower for `options.target`, shared across callers that resolve to the same
   * target scene object, and registered with the manager. Balance every acquire with
   * {@link releaseShared}. Options after the first acquire for a given target are ignored
   * (all fields in a Frame supply equivalent config).
   */
  public static acquire(options: FocusFrameFollowerOptions): FocusFrameFollower {
    const key = FocusFrameFollower.keyFor(options.sceneObject)
    const existing = FocusFrameFollower.shared.get(key)
    if (existing) {
      existing.refCount++
      return existing.follower
    }
    const follower = new FocusFrameFollower(options)
    follower.register()
    FocusFrameFollower.shared.set(key, {follower, refCount: 1})
    return follower
  }

  /**
   * Releases one reference acquired via {@link acquire}. Destroys the shared follower when
   * the last reference is released. Safe to call on a follower that wasn't shared (falls
   * back to destroy()).
   */
  public releaseShared(): void {
    const entry = FocusFrameFollower.shared.get(this.sharingKey)
    if (!entry || entry.follower !== this) {
      this.destroy()
      return
    }
    entry.refCount--
    if (entry.refCount <= 0) {
      FocusFrameFollower.shared.delete(this.sharingKey)
      this.destroy()
    }
  }

  // --- Registration convenience -------------------------------------------------------

  /** Registers this follower with the FocusFrameManager. */
  public register(): void {
    if (this.registered) return
    FocusFrameManager.getInstance().registerParticipant(this)
    this.registered = true
  }

  /** Unregisters this follower from the FocusFrameManager. */
  public unregister(): void {
    if (!this.registered) return
    FocusFrameManager.getInstance().unregisterParticipant(this)
    this.registered = false
  }

  /**
   * Requests focus (e.g. when an owning field enters edit mode). Reference-counted: the
   * panel docks on the first request and stays docked until the matching number of
   * releases, so switching between fields that share this follower keeps it docked.
   */
  public requestFocus(): void {
    // Cancel a pending grace-period undock — focus came back (e.g. the next field in a
    // switch) before the panel undocked.
    this.cancelPendingRelease()
    this.focusWantCount++
    // Idempotent at the manager if we already hold focus.
    FocusFrameManager.getInstance().requestFocus(this)
  }

  /**
   * Releases one focus request. When no field still wants focus, releases manager focus —
   * immediately if the effective grace is 0, otherwise after the grace period so a field
   * switch (blur-then-refocus) doesn't bounce the panel home and back.
   * @param graceMsOverride - Per-call grace override; callers that KNOW no refocus is
   * coming (a plain deselect rather than a field switch) pass 0 to fly home immediately.
   */
  public releaseFocus(graceMsOverride?: number): void {
    this.focusWantCount = Math.max(0, this.focusWantCount - 1)
    if (this.focusWantCount > 0) return

    const graceMs = graceMsOverride ?? this.releaseGraceMs
    if (graceMs <= 0) {
      this.cancelPendingRelease()
      FocusFrameManager.getInstance().releaseFocus(this)
      return
    }
    this.cancelPendingRelease()
    this.pendingReleaseToken = setTimeout(() => {
      this.pendingReleaseToken = null
      if (this.focusWantCount === 0) {
        FocusFrameManager.getInstance().releaseFocus(this)
      }
    }, graceMs)
  }

  private cancelPendingRelease(): void {
    if (this.pendingReleaseToken) {
      clearTimeout(this.pendingReleaseToken)
      this.pendingReleaseToken = null
    }
  }

  // --- FocusFrameParticipant ----------------------------------------------------------

  public getSceneObject(): SceneObject {
    return this.sceneObject
  }

  public onFocusGranted(initialPose: FocusFramePose | null): void {
    if (this.destroyed) return
    this.latestPose = initialPose
    this.setTracking(false)
    this.cancelTween()

    // Suspend the owner BEFORE recording the rest pose: the owner's onFocusStart may move
    // the target (Frame's suspendForFocusFrame settles an in-flight released depth-clamp
    // correction). Capturing first would record the transient mid-correction pose and
    // return the panel to it on undock, undoing the settled correction.
    this.onFocusStart?.()
    this.ownerSuspended = true
    this.setDockState(true)

    // Record the resting pose in LOCAL space so the return is correct even if the parent
    // moved while docked. If a previous return tween is still in flight (rapid refocus),
    // originalLocal* is still set — keep it so we don't capture a mid-return pose as rest.
    const transform = this.target
    if (this.originalLocalPosition === null) {
      this.originalLocalPosition = transform.getLocalPosition()
      this.originalLocalRotation = transform.getLocalRotation()
      this.originalLocalScale = transform.getLocalScale()
    }

    if (!initialPose) {
      // No anchor pose yet; wait for the first pose update to begin docking.
      log.d(`${this.focusFrameId}: focus granted before anchor pose available`)
      return
    }

    this.dockIn()
  }

  public onAnchorPoseUpdated(pose: FocusFramePose): void {
    if (this.destroyed) return
    this.latestPose = pose
    if (this.tracking) {
      // Continuous tracking: damp toward the latest pose. Driven by the pose stream itself.
      this.applyTracking(pose)
    } else if (this.cancelSet === null && this.originalLocalPosition !== null) {
      // Granted focus before a pose existed; begin docking now that we have one.
      this.dockIn()
    }
  }

  public onFocusRevoked(suspended: boolean = false): void {
    if (this.destroyed) return
    // Keyboard-kind changes retain field demand and any pending edit-mode release.
    if (!suspended) {
      this.focusWantCount = 0
      this.cancelPendingRelease()
    }
    // Releasing focus while suspended must not restart the return animation.
    if (!this.dockStateForEvent) return
    this.setTracking(false)
    this.cancelTween()
    this.setDockState(false)
    this.returnToRest()
  }

  public onAnchorMovementStarted(): void {
    // Keep-following: no motion change; just surface the event.
    this.onMovementStartedCb?.()
  }

  public onAnchorMovementEnded(): void {
    this.onMovementEndedCb?.()
  }

  // --- Motion -------------------------------------------------------------------------

  private dockIn(): void {
    const transform = this.target
    const startWorldPos = transform.getWorldPosition()
    const startWorldRot = transform.getWorldRotation()
    const startLocalScale = transform.getLocalScale()

    this.cancelSet = new CancelSet()
    animate({
      cancelSet: this.cancelSet,
      duration: this.durationMs / 1000,
      easing: this.easing,
      update: (t: number) => {
        const pose = this.latestPose
        if (!pose) return
        transform.setWorldPosition(mix(startWorldPos, this.computeTargetPosition(pose), t))
        transform.setWorldRotation(mix(startWorldRot, pose.rotation, t))
        transform.setLocalScale(mix(startLocalScale, this.computeDockedScale(), t))
      },
      ended: () => {
        this.cancelSet = null
        // Hand off to continuous tracking (driven by subsequent pose updates + the
        // per-frame reassert).
        this.setTracking(true)
      }
    })
  }

  private applyTracking(pose: FocusFramePose): void {
    // Follow the pose exactly. The anchor arrives already smoothed, so no extra damping is
    // needed — and damping would leave residual error: pose delivery stops once the keyboard
    // settles, so there is no trailing tick to finish an exponential convergence. Setting
    // directly lands the element on each delivered pose and rests where the last one left it.
    const transform = this.target
    transform.setWorldPosition(this.computeTargetPosition(pose))
    transform.setWorldRotation(pose.rotation)
    transform.setLocalScale(this.computeDockedScale())
  }

  /**
   * The world position the target should occupy for a given anchor pose: the anchor lifted
   * along its up axis by the (scaled) pivot height so the element's bottom edge rests on
   * the anchor, plus any fixed anchor-local offset. Both are rotated into world space by
   * the anchor rotation so the offset tracks the anchor's orientation.
   */
  private computeTargetPosition(pose: FocusFramePose): vec3 {
    const contentHeight = this.getContentHeight?.()
    let lift = 0
    if (contentHeight != null && contentHeight > 0) {
      // World-space lift: docked local scale * parent world scale = world height per unit of
      // content; lift the pivot by the pivot fraction of the world content height.
      lift = contentHeight * this.computeDockedScale().y * this.parentWorldScaleY() * this.pivotHeightFraction
    }
    const localOffset = new vec3(this.anchorOffset.x, this.anchorOffset.y + lift, this.anchorOffset.z)
    if (localOffset.equal(vec3.zero())) {
      return pose.position
    }
    return pose.position.add(pose.rotation.multiplyVec3(localOffset))
  }

  private returnToRest(): void {
    const transform = this.target
    const targetPos = this.originalLocalPosition
    const targetRot = this.originalLocalRotation
    const targetScale = this.originalLocalScale

    if (!targetPos || !targetRot || !targetScale) {
      // Nothing recorded; nothing to return to.
      this.clearOriginal()
      this.resumeOwner()
      return
    }

    const startLocalPos = transform.getLocalPosition()
    const startLocalRot = transform.getLocalRotation()
    const startLocalScale = transform.getLocalScale()

    this.cancelSet = new CancelSet()
    animate({
      cancelSet: this.cancelSet,
      duration: this.durationMs / 1000,
      easing: this.easing,
      update: (t: number) => {
        transform.setLocalPosition(mix(startLocalPos, targetPos, t))
        transform.setLocalRotation(mix(startLocalRot, targetRot, t))
        transform.setLocalScale(mix(startLocalScale, targetScale, t))
      },
      ended: () => {
        this.cancelSet = null
        this.clearOriginal()
        this.resumeOwner()
      }
    })
  }

  /**
   * Resumes the owner (e.g. a suspended Frame's follow) exactly once per suspend. Called on
   * return completion and on teardown, so a cancelled return tween can never leave the
   * owner permanently suspended.
   */
  private resumeOwner(): void {
    if (this.ownerSuspended) {
      this.ownerSuspended = false
      this.onReturnComplete?.()
    }
  }

  /**
   * Computes the docked LOCAL scale: base scale times `scaleFactor`, reduced if the
   * resulting WORLD content height would exceed the height limit, floored at `minScale`.
   * The limit is the keyboard-suggested height (`suggestedSize.y` from the current pose)
   * when the platform supplies one, otherwise the configured `maxHeight`. The clamp uses
   * the parent's world scale so the visible height fits even under a scaled ancestor; the
   * returned value is still a local scale (restored to the original local scale on unfocus).
   */
  private computeDockedScale(): vec3 {
    const base = this.originalLocalScale ?? this.target.getLocalScale()
    let multiplier = this.scaleFactor

    const heightLimit = this.latestPose?.suggestedSize?.y ?? this.maxHeight
    const parentScaleY = this.parentWorldScaleY()
    const contentHeight = this.getContentHeight?.()
    if (contentHeight != null && contentHeight > 0) {
      const worldHeight = contentHeight * base.y * multiplier * parentScaleY
      if (worldHeight > heightLimit) {
        multiplier = heightLimit / (contentHeight * base.y * parentScaleY)
      }
    }
    if (multiplier < this.minScale) {
      multiplier = this.minScale
    }
    return base.uniformScale(multiplier)
  }

  /**
   * The target parent's world Y scale (1 if no parent). Converts the target's local content
   * height and docked local scale into world units for the clamp and the world-space lift.
   */
  private parentWorldScaleY(): number {
    const parent = this.sceneObject.getParent()
    if (!parent) return 1
    const scaleY = parent.getTransform().getWorldScale().y
    return scaleY !== 0 ? scaleY : 1
  }

  /**
   * Sets the tracking flag and enables/disables the per-frame reassert to match. The reassert
   * only does work while tracking; when idle its event is disabled so undocked followers cost
   * nothing per frame.
   */
  private setTracking(tracking: boolean): void {
    this.tracking = tracking
    if (tracking) {
      this.ensureTick()
    }
    if (this.tickEvent) {
      this.tickEvent.enabled = tracking
    }
  }

  /**
   * Lazily creates the LateUpdate tick that re-asserts the docked world pose each frame. Owns
   * a dedicated scene object (mirroring IK's animate dispatcher) so it doesn't depend on the
   * target's component lifecycle; destroyed in {@link destroy}.
   */
  private ensureTick(): void {
    if (this.tickEvent || this.destroyed) return
    this.tickSceneObject = global.scene.createSceneObject(`focusframe-tick-${this.focusFrameId}`)
    const script = this.tickSceneObject.createComponent("ScriptComponent")
    this.tickEvent = script.createEvent("LateUpdateEvent")
    this.tickEvent.bind(() => this.reassertDockedPose())
    this.tickEvent.enabled = false
  }

  /**
   * Re-applies the latest anchor pose to the target in world space. Runs every frame while
   * tracking so a parent move (e.g. dragging the Frame the field lives under) can't drag the
   * docked element off the keyboard anchor — the pose stream alone quiesces when the keyboard
   * is still and would leave the element stuck to its moving parent.
   */
  private reassertDockedPose(): void {
    if (this.destroyed || !this.tracking) return
    const pose = this.latestPose
    if (!pose) return
    this.applyTracking(pose)
  }

  private cancelTween(): void {
    if (this.cancelSet) {
      this.cancelSet.cancel()
      this.cancelSet = null
    }
  }

  private clearOriginal(): void {
    this.originalLocalPosition = null
    this.originalLocalRotation = null
    this.originalLocalScale = null
  }

  // --- Teardown -----------------------------------------------------------------------

  /**
   * Cancels motion, snaps the target back to rest, resumes the owner, and unregisters. For
   * shared followers prefer {@link releaseShared}; call destroy() directly only for a
   * follower you constructed yourself.
   */
  public destroy(): void {
    this.destroyed = true
    this.setDockState(false)
    this.setTracking(false)
    this.cancelPendingRelease()
    this.cancelTween()
    // Snap the target back to its recorded rest pose — there is no time to animate on
    // teardown, and a shared target (e.g. a Frame still used by sibling fields) must not be
    // left docked or frozen mid-return.
    if (this.originalLocalPosition && this.originalLocalRotation && this.originalLocalScale) {
      const transform = this.target
      transform.setLocalPosition(this.originalLocalPosition)
      transform.setLocalRotation(this.originalLocalRotation)
      transform.setLocalScale(this.originalLocalScale)
    }
    // Clear before unregistering so the manager's revoke (if we were focused) finds no
    // recorded pose and starts no return tween; resume the owner directly instead.
    this.clearOriginal()
    this.resumeOwner()
    this.unregister()
    // Tear down the per-frame tick's scene object; disabling the event first is redundant
    // once the object is destroyed but keeps intent clear.
    if (this.tickEvent) {
      this.tickEvent.enabled = false
      this.tickEvent = null
    }
    if (this.tickSceneObject) {
      this.tickSceneObject.destroy()
      this.tickSceneObject = null
    }
  }

  private setDockState(docked: boolean): void {
    if (this.dockStateForEvent === docked) return
    this.dockStateForEvent = docked
    this.dockStateEvent.invoke(docked)
  }

  // --- State (for tests / observers) --------------------------------------------------

  /** Whether the follower is currently docked/docking (focused with an anchor). */
  public get isFocused(): boolean {
    return this.originalLocalPosition !== null
  }

  /**
   * The state last emitted by {@link onDockStateChanged}. Unlike {@link isFocused}, this
   * flips false at undock START (isFocused stays true through the whole return flight), so
   * late subscribers seeding from it can't latch a docked state whose false event already
   * fired.
   */
  public get isDocked(): boolean {
    return this.dockStateForEvent
  }

  /** Whether the follower is in the continuous tracking phase. */
  public get isTracking(): boolean {
    return this.tracking
  }
}

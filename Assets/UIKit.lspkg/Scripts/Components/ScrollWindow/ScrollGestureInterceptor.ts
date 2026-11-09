/**
 * Tests whether the line segment between `knuckle` and `tip` straddles the
 * plane defined by `planeOrigin` and `planeNormal`, with a per-point hysteresis
 * margin so hand-tracker noise around the plane doesn't flicker the result.
 *
 * Used by ScrollWindow to keep a poke-scroll gesture engaged as long as the
 * user's index finger is still piercing the engagement plane that was captured
 * at gesture start. The criterion is PERMISSIVE — it stays engaged unless we
 * see clear evidence that BOTH points are on the same side of the plane:
 *
 *   dK = (knuckle - planeOrigin) · planeNormal
 *   dT = (tip - planeOrigin) · planeNormal
 *
 *   engaged := !(dK >  +H && dT >  +H)    // not "both clearly behind plane"
 *           && !(dK < -H && dT < -H)      // not "both clearly past plane"
 *
 * The sign convention is symmetric: whether `planeNormal` points toward or away
 * from the user, the "both clearly on the same side" disengagement check holds
 * either way. Consumers can interpret the sign of dK / dT diagnostically by
 * inspecting the values directly.
 *
 * The hysteresis band `[-H, +H]` defines an "ambiguous middle" near the plane.
 * Points whose signed distance falls inside that band don't contribute to
 * disengagement, so a finger held right at the surface (where hand-tracker
 * noise could flip the sign frame-to-frame) doesn't flicker the gesture off.
 *
 * @param planeOrigin - world-space anchor point ON the plane (typically the
 *   initial collision point captured at the start of the gesture).
 * @param planeNormal - world-space unit-ish normal of the plane (typically the
 *   ScrollWindow's `transform.forward`).
 * @param knuckle - world-space position of the index MCP joint.
 * @param tip - world-space position of the index fingertip.
 * @param hysteresisCm - margin around the plane within which a single point's
 *   sign is treated as "ambiguous." Set to 0 for a strict sign check.
 * @returns true if the segment is considered to still cross the plane; false
 *   if both endpoints are clearly on the same side.
 */
export function evaluatePlaneSideEngagement(
  planeOrigin: vec3,
  planeNormal: vec3,
  knuckle: vec3,
  tip: vec3,
  hysteresisCm: number
): boolean {
  const dKx = knuckle.x - planeOrigin.x
  const dKy = knuckle.y - planeOrigin.y
  const dKz = knuckle.z - planeOrigin.z
  const dK = dKx * planeNormal.x + dKy * planeNormal.y + dKz * planeNormal.z

  const dTx = tip.x - planeOrigin.x
  const dTy = tip.y - planeOrigin.y
  const dTz = tip.z - planeOrigin.z
  const dT = dTx * planeNormal.x + dTy * planeNormal.y + dTz * planeNormal.z

  const H = hysteresisCm
  const bothClearlyBehind = dK > +H && dT > +H
  const bothClearlyPast = dK < -H && dT < -H
  return !(bothClearlyBehind || bothClearlyPast)
}

/**
 * Pure state machine that governs how ScrollWindow captures, holds, and releases a
 * pointer/finger gesture.
 *
 * Why a separate class:
 * - Keeps the decision logic free of SceneObject / Interactor references so it can be
 *   unit-tested with plain numbers (no Lens Studio runtime needed).
 * - Decouples scroll-gesture continuity from IK's spherecast hit set. ScrollWindow drives
 *   the tick from its own LateUpdate and decides on its own when the gesture ends, rather
 *   than inheriting that decision from IK's frame-by-frame poke validation.
 *
 * Why we can't just subscribe to IK's onDragUpdate / onTriggerEnd directly for poke:
 *
 * IK's drag lifecycle was designed for indirect input — shoulder-to-cursor ray, mouse,
 * mobile touch. Its `indirectDragThreshold` engages as soon as any sub-threshold motion
 * is detected, which is correct for cursor-driven input but wrong for fingertip-physical
 * input on device. The noise profiles are fundamentally different:
 *
 * - Tap-arc wobble: a natural tap-then-retract motion drifts laterally ~1–2 cm for
 *   3–4 consecutive frames before the user retracts (residual arm-arc motion). IK
 *   treats this as drag and fires onDragUpdate, leading to false scroll engagement on
 *   what the user intended as a button tap. The deadzone + dwell window here requires
 *   lateral motion past the deadzone to be sustained for N consecutive frames before
 *   engaging, filtering the tap-arc artifact.
 *
 * - Forward-velocity artifacts: during a fast poke, the spherecast intersection on the
 *   plane drifts briefly as the finger pushes inward (finger-cone geometry + tracking
 *   jitter). IK fires drag updates for the artifact. The forward-velocity gate holds
 *   the dwell counter at zero and re-anchors `gestureStartWorld` while the user is
 *   pushing inward, then releases the gate once the finger lands.
 *
 * - Spherecast hit-loss as drag starts: this is the load-bearing one. The user pokes
 *   a child Interactable (e.g., a button inside the ScrollWindow), then drags laterally
 *   to scroll. The lateral motion takes the child out of IK's spherecast envelope
 *   almost immediately — IK fires `triggerEnd` (or `triggerEndOutside`) on the child
 *   well before our deadzone+dwell window would engage. Under naive IK subscription
 *   this end signal would tear down the gesture before it ever became a scroll, and
 *   the user would see "I started to drag but nothing happened." The state machine's
 *   tick is the authority on whether the gesture has actually ended — `onEndCandidate`
 *   ignores IK's end signal whenever `isFingerStillEngaged` reports the finger is
 *   still inside the ScrollWindow's hierarchy (via `isHoveringInteractableHierarchy`
 *   / line-segment-crosses-plane with hysteresis on the fingertip-anchored engagement
 *   plane). The tick decides on the real retract or hand-lost end.
 *
 * - Spherecast envelope collapse on depth approach: a related but distinct case. As the
 *   fingertip approaches a surface, the spherecast distance |tip − upperJoint| shrinks
 *   below the forward-offset radius and the cast can no-op or sweep backward, dropping
 *   the target with no lateral motion involved. Same fix — `isFingerStillEngaged`
 *   overrides the spurious end.
 *
 * - End-of-gesture hook: at the end of a real scroll, users naturally curl the finger
 *   on release, which briefly reverses lateral direction. IK's velocity bank picks up
 *   the reversal and would fling backward. The anti-hook filter masks reversal frames
 *   so fling tracks the user's actual intent.
 *
 * - Target swap mid-gesture: PIP's CASE 0 can swap the active target mid-gesture (finger
 *   drifts from one child of the ScrollWindow onto another, or onto the ScrollWindow's
 *   own back plane). IK fires a fresh triggerStart on the new target, but ScrollWindow
 *   needs to keep the original gesture continuous and cancel the new child's pending
 *   action at engagement time. The state machine owns this arbitration; IK only sees
 *   individual targets in isolation.
 *
 * The indirect path bypasses all of this — ScrollWindow uses IK's onDragUpdate directly
 * for HandInteractor far-field, Mouse, and Mobile input, inheriting indirectDragThreshold
 * for engagement. That works because none of those inputs exhibit the poke-specific noise
 * profile.
 *
 * Lifecycle:
 *
 *   Idle
 *    │  start(startX, startY)
 *    ▼
 *   Intercepting ──── tick: lateral motion ≥ deadzone ───▶ Engaged
 *    │                                                       │
 *    │  tick: hand lost / retracted                          │  tick: hand lost / retracted
 *    │                          cancel()                     │                          cancel()
 *    ▼                                                       ▼
 *   Ended ──── reset() ──▶ Idle
 *
 * Intent gates beyond pure lateral distance:
 *
 * - Forward-velocity gate (Intercepting phase): while the fingertip is moving
 *   forward (toward the plane) or retracting fast, the dwell counter is held at
 *   zero and the caller is told to re-anchor `gestureStartWorld` each frame.
 *   Prevents fast-poke trajectories from accumulating lateral distance against a
 *   stale origin and false-engaging the scroll. Once the user "lands" on the
 *   surface and forward velocity drops, the gate releases and the dwell counter
 *   begins counting from the landing point.
 *
 * - Filtered-velocity anti-hook (Engaged phase): a moving-average filter over
 *   per-frame XY lateral deltas tracks the user's dominant scroll direction. Any
 *   single frame whose lateral delta opposes the filtered sign on an axis is
 *   reported as `applyAxis.{x,y} = false` so the consumer can drop it from both
 *   the position update and the velocity bank that feeds the fling. Eliminates
 *   the "hook" where arm-retract during a fast flick reverses the scroll just
 *   before release. Sustained direction changes auto-recover as the moving
 *   average catches up.
 *
 * The consumer (ScrollWindow) is responsible for:
 * - Calling `start()` once an inbound gesture should be captured (after checking that no
 *   drag-consuming child wants the event).
 * - Calling `tick()` every frame with the current projection of the interactor onto the
 *   ScrollWindow's plane and the signed distance from the plane.
 * - Reacting to `enteredEngaged` (cancel child interactions, prime scroll position),
 *   `enteredEnded` (apply fling, clear interactor reference), `reCaptureOrigin`
 *   (re-anchor gestureStartWorld), and `applyAxis` (per-axis delta mask) by
 *   reading the output.
 * - Calling `reset()` once it has processed the Ended transition.
 */
export enum GestureState {
  Idle = 0,
  Intercepting = 1,
  Engaged = 2,
  Ended = 3
}

/**
 * Why a scroll gesture transitioned out of `Intercepting` or `Engaged`.
 * Carried in `ScrollGestureEndArg` for `onScrollDisengaged` / `onScrollRejected`.
 */
export enum ScrollGestureEndReason {
  /** Spherecast cache reported finger no longer touches the target past the grace window. */
  FingerLifted = "finger-lifted",
  /** PIP / interactor lost projection (hand tracking dropped). */
  HandTrackingLost = "hand-tracking-lost",
  /** IK fired triggerCanceled on the active interactor. */
  Canceled = "canceled",
  /** `scrollingPaused` setter was flipped to `true` mid-gesture. */
  Paused = "paused",
  /** Active interactor was replaced before the gesture finished. */
  InteractorSwapped = "interactor-swapped",
  /** Indirect-mode IK delivered a clean end signal (mouse-up, mobile touch up). */
  IndirectInputReleased = "indirect-input-released",
  /** Direct pinch released (PIP CASE 3 — independent of spherecast). */
  PinchReleased = "pinch-released",
  /** Trigger ended outside the interactable (IK triggerEndOutside). */
  EndedOutside = "ended-outside"
}

/**
 * Classifies a state-machine-driven gesture end (`tick.enteredEnded`) into a
 * reason + designer-friendly message. Two ways the interceptor reaches Ended:
 *   - `!hasProjection`: PIP / interactor lost projection (hand tracking dropped).
 *   - `!pokeStillTouching` past the not-touching grace window (real retract).
 * No other paths produce `enteredEnded`.
 *
 * @param hasProjection      Whether the interactor still has a plane intersection
 *                           this frame. False classifies as HandTrackingLost.
 * @param stateBeforeTick    Interceptor state captured BEFORE the tick that
 *                           transitioned to Ended. Drives the FingerLifted
 *                           message variant (with-deadzone vs without).
 * @param lateralDeadzoneCm  The interceptor's `lateralDeadzoneCm`, inlined into
 *                           the pre-engagement variant of the FingerLifted message.
 */
export function classifyTickEndReason(
  hasProjection: boolean,
  stateBeforeTick: GestureState,
  lateralDeadzoneCm: number
): {reason: ScrollGestureEndReason; message: string} {
  const reason = !hasProjection ? ScrollGestureEndReason.HandTrackingLost : ScrollGestureEndReason.FingerLifted
  const message =
    reason === ScrollGestureEndReason.HandTrackingLost
      ? "hand tracking lost mid-gesture"
      : stateBeforeTick === GestureState.Engaged
        ? "finger lifted off the panel"
        : `finger lifted off the panel before lateral motion crossed the ${lateralDeadzoneCm.toFixed(1)} cm threshold`
  return {reason, message}
}

/**
 * Result of {@link classifyScrollEnd}. `null` means no public lifecycle event
 * should fire (the gesture either never engaged AND never hit Intercepting, or
 * hit Engaged without isDragging being set — a defensive null that shouldn't
 * occur in practice).
 */
export type ScrollEndClassification = "disengaged" | "rejected" | null

/**
 * Pure classifier for the ScrollWindow public lifecycle events at gesture end.
 * Decoupled from the ScrollWindow instance so the truth table is unit-testable.
 *
 * Invariant: once `wasDragging` is set (via primeEngagement, called from both
 * physical and indirect paths), only "disengaged" can fire. "rejected" is
 * exclusively a physical-path pre-engagement signal — the indirect path has
 * no Intercepting state, so it can only produce "disengaged" or null.
 *
 * @param priorState   Interceptor state captured BEFORE reset. Drives the
 *                     Rejected signal (Intercepting → Idle without Engaged).
 * @param wasDragging  ScrollWindow.isDragging captured BEFORE reset. The
 *                     path-agnostic engagement signal.
 */
export function classifyScrollEnd(priorState: GestureState, wasDragging: boolean): ScrollEndClassification {
  if (wasDragging) return "disengaged"
  if (priorState === GestureState.Intercepting) return "rejected"
  return null
}

export type GestureTickInput = {
  /**
   * True if the interactor produced a valid plane projection this frame.
   * Set to false to signal hand-tracking loss, interactor disconnection, or any
   * other condition that should end the gesture immediately.
   */
  hasProjection: boolean
  /**
   * Lateral distance (in real world centimeters) between the current intersection
   * point on the plane and the intersection point captured at `start()`. Caller is
   * responsible for computing this in world space so it's invariant under scene
   * scale — comparing local-space coordinates to a cm-typed deadzone produces
   * scene-scale-dependent bugs.
   *
   * Only read when `hasProjection` is true.
   */
  lateralDistanceFromStartCm: number
  /**
   * Whether the user is still physically engaged with the scroll surface this
   * frame. The caller should set this true if PIP's spherecast envelope intersects
   * any Interactable within the scroll surface's hierarchy (not just the scroll
   * surface's own Interactable — children typically own the actual touched colliders).
   * For non-hand interactors (Mouse/Mobile) pass `true` so this signal stays inactive
   * and end events come exclusively from IK's lifecycle.
   *
   * When this stays `false` for more than `notTouchingGraceFrames` consecutive ticks
   * the gesture is treated as released — this is the authoritative "user has
   * retracted" signal and is robust to panel orientation.
   */
  pokeStillTouching: boolean
  /**
   * Signed velocity (world cm/sec) of the fingertip along the scroll plane's
   * normal axis. Positive = moving toward the +normal side, negative = away. Fed
   * into the forward-velocity gate during the Intercepting phase to suppress
   * engagement while the user is poking forward or retracting fast (neither is
   * a scroll). Optional — defaults to 0 (gate inactive) for legacy callers.
   */
  forwardVelocityCmPerSec?: number
  /**
   * Per-frame XY motion of the projected scroll position on the plane, in world
   * cm, expressed in plane-local axes. Feeds the post-engagement anti-hook
   * filter (moving-average velocity → per-axis sign check). Optional — defaults
   * to (0, 0) (filter stays neutral, hook mask never engages) for legacy callers.
   */
  lateralDeltaCm?: {x: number; y: number}
}

export type GestureTickOutput = {
  /** Current state after this tick. */
  state: GestureState
  /** True only on the frame the machine transitions Intercepting → Engaged. */
  enteredEngaged: boolean
  /** True only on the frame the machine transitions Intercepting/Engaged → Ended. */
  enteredEnded: boolean
  /**
   * True on frames where the forward-velocity gate is active — caller should
   * re-anchor `gestureStartWorld` to the current intersection so the next
   * frame's `lateralDistanceFromStartCm` is measured from "landing" rather than
   * from the original triggerStart point. Only meaningful while Intercepting.
   */
  reCaptureOrigin: boolean
  /**
   * Per-axis anti-hook mask. `false` means the current frame's lateral delta on
   * that axis should be REJECTED — applied filtered-velocity sign disagrees with
   * the raw delta sign (typically arm-retract hooking back during fast flick).
   * Always `{x: true, y: true}` outside the Engaged state.
   */
  applyAxis: {x: boolean; y: boolean}
}

/**
 * Internal: simple ring-buffer moving average over 2D values. Used to track
 * smoothed lateral velocity for anti-hook sign checking. Kept inside this file
 * to preserve the interceptor's "no LS runtime types" property — the existing
 * IK MovingAverageFilter pulls in vec2 which would force LS dependencies.
 */
class MovingAverageFilter2D {
  private bufferX: number[]
  private bufferY: number[]
  private index: number = 0
  private filled: boolean = false
  private sumX: number = 0
  private sumY: number = 0

  public constructor(public readonly windowSize: number) {
    if (windowSize < 1) {
      throw new Error("MovingAverageFilter2D: windowSize must be ≥ 1")
    }
    this.bufferX = new Array<number>(windowSize).fill(0)
    this.bufferY = new Array<number>(windowSize).fill(0)
  }

  public push(x: number, y: number): void {
    this.sumX -= this.bufferX[this.index]
    this.sumY -= this.bufferY[this.index]
    this.bufferX[this.index] = x
    this.bufferY[this.index] = y
    this.sumX += x
    this.sumY += y
    this.index = (this.index + 1) % this.windowSize
    if (this.index === 0) {
      this.filled = true
    }
  }

  public get average(): {x: number; y: number} {
    const count = this.filled ? this.windowSize : this.index === 0 ? 1 : this.index
    return {x: this.sumX / count, y: this.sumY / count}
  }

  public clear(): void {
    for (let i = 0; i < this.windowSize; i++) {
      this.bufferX[i] = 0
      this.bufferY[i] = 0
    }
    this.index = 0
    this.filled = false
    this.sumX = 0
    this.sumY = 0
  }
}

export class ScrollGestureInterceptor {
  private _state: GestureState = GestureState.Idle
  // Consecutive ticks where `pokeStillTouching` has been false. Resets to 0 whenever
  // the input arrives as true. Crossing `notTouchingGraceFrames` ends the gesture.
  private _consecutiveNotTouchingFrames: number = 0
  // Consecutive ticks while Intercepting where lateral motion has stayed past the
  // deadzone AND `pokeStillTouching` is true. Resets to 0 if either condition
  // fails or if the forward-velocity gate is active. Crossing `engageDwellFrames`
  // is what actually transitions to Engaged. The pokeStillTouching gate is
  // important: without it the counter could build up on frames where the user's
  // finger isn't geometrically engaged with the plane (e.g. reaching toward a
  // protruding child), causing engagement on a frame that immediately starts
  // the not-touching grace countdown — a microscroll that ends itself.
  private _consecutiveBeyondDeadzoneFrames: number = 0
  // Latched true once lateral motion has passed the deadzone at any point this
  // gesture (even if the dwell counter later reset, or engagement never
  // committed). Unlike `state === Engaged`, this is a sticky "scroll intent was
  // shown" signal: it lets a consumer distinguish a real (possibly quick) drag
  // from a stationary tap at the moment a trigger ends, before the LateUpdate
  // tick has promoted the state to Engaged.
  private _everCrossedDeadzone: boolean = false
  // Moving average of per-frame lateral deltas (X, Y in plane coords). Drives the
  // post-engagement anti-hook sign check.
  private _lateralFilter: MovingAverageFilter2D

  /**
   * @param lateralDeadzoneCm - Required lateral distance from the captured start
   *   position (in ScrollWindow local space) before the machine commits to a scroll.
   * @param notTouchingGraceFrames - Number of consecutive ticks `pokeStillTouching`
   *   may stay false before the gesture ends. Provides tolerance for transient
   *   spherecast misses during fast lateral motion (the original motivation for
   *   this state machine). Default 5 (~80ms at 60fps).
   * @param engageDwellFrames - Number of consecutive ticks the interactor must stay
   *   past the lateral deadzone before engagement. Filters out brief wobble during a
   *   poke (where natural finger-trajectory and hand-tracking noise can spike past
   *   the deadzone for one tick and immediately retreat). Default 3 (~50ms at 60fps).
   *   Set to 0 to disable (engage on the first tick that crosses the deadzone).
   * @param forwardVelGateCmPerSec - Forward-velocity threshold (in world cm/sec)
   *   above which the dwell counter is held at zero and the caller is told to
   *   re-anchor the gesture origin. Discriminates fast pokes (high |forwardVel|,
   *   lateral motion is trajectory noise) from scrolls (|forwardVel| ≈ 0,
   *   lateral motion is intent). Default 25 cm/sec. Set to a very large value
   *   (e.g. `Number.POSITIVE_INFINITY`) to disable the gate entirely.
   * @param filterWindowFrames - Window length of the lateral-velocity moving
   *   average used for post-engagement anti-hook. Larger window = more smoothing
   *   = slower direction-change recovery. Default 10 frames (~167ms at 60fps,
   *   matching IK's deprecated ScrollProvider).
   */
  public constructor(
    public readonly lateralDeadzoneCm: number,
    public readonly notTouchingGraceFrames: number = 5,
    public readonly engageDwellFrames: number = 3,
    public readonly forwardVelGateCmPerSec: number = 25,
    public readonly filterWindowFrames: number = 10
  ) {
    if (lateralDeadzoneCm < 0) {
      throw new Error("ScrollGestureInterceptor: lateralDeadzoneCm must be ≥ 0")
    }
    if (notTouchingGraceFrames < 0) {
      throw new Error("ScrollGestureInterceptor: notTouchingGraceFrames must be ≥ 0")
    }
    if (engageDwellFrames < 0) {
      throw new Error("ScrollGestureInterceptor: engageDwellFrames must be ≥ 0")
    }
    if (forwardVelGateCmPerSec < 0) {
      throw new Error("ScrollGestureInterceptor: forwardVelGateCmPerSec must be ≥ 0")
    }
    if (filterWindowFrames < 1) {
      throw new Error("ScrollGestureInterceptor: filterWindowFrames must be ≥ 1")
    }
    this._lateralFilter = new MovingAverageFilter2D(filterWindowFrames)
  }

  public get state(): GestureState {
    return this._state
  }

  /** True while the machine should be driven each frame (Intercepting or Engaged). */
  public get isActive(): boolean {
    return this._state === GestureState.Intercepting || this._state === GestureState.Engaged
  }

  /**
   * Current filtered lateral velocity (world cm/sec, plane-local axes). Exposed
   * for diagnostic logging — not part of the normal control flow.
   */
  public get filteredLateralVelocity(): {x: number; y: number} {
    return this._lateralFilter.average
  }

  /**
   * Begin intercepting a new gesture from Idle (or restart from Ended). The caller
   * is responsible for tracking the gesture's origin position externally and feeding
   * `lateralDistanceFromStartCm` to `tick()` each frame.
   */
  public start(): void {
    this._state = GestureState.Intercepting
    this._consecutiveNotTouchingFrames = 0
    this._consecutiveBeyondDeadzoneFrames = 0
    this._everCrossedDeadzone = false
    this._lateralFilter.clear()
  }

  /** True once lateral motion passed the deadzone at any point this gesture. */
  public get everCrossedDeadzone(): boolean {
    return this._everCrossedDeadzone
  }

  /**
   * Process a single tick. Idempotent in Idle/Ended (no-op).
   */
  public tick(input: GestureTickInput): GestureTickOutput {
    // Pre-built no-op output for early returns (Idle/Ended). Built fresh because
    // the consumer reads its fields and we don't want shared state across ticks.
    if (this._state === GestureState.Idle || this._state === GestureState.Ended) {
      return {
        state: this._state,
        enteredEngaged: false,
        enteredEnded: false,
        reCaptureOrigin: false,
        applyAxis: {x: true, y: true}
      }
    }

    // Hand lost / interactor invalid → end immediately
    if (!input.hasProjection) {
      this._state = GestureState.Ended
      this._lateralFilter.clear()
      return {
        state: this._state,
        enteredEngaged: false,
        enteredEnded: true,
        reCaptureOrigin: false,
        applyAxis: {x: true, y: true}
      }
    }

    // "Released" signal: PIP spherecast no longer touches the target. Allow a small
    // grace window so transient misses during fast lateral motion don't end the
    // gesture. Once the user clearly retracts, the cache stays false past the grace
    // and we transition to Ended.
    if (input.pokeStillTouching) {
      this._consecutiveNotTouchingFrames = 0
    } else {
      this._consecutiveNotTouchingFrames++
      if (this._consecutiveNotTouchingFrames > this.notTouchingGraceFrames) {
        this._state = GestureState.Ended
        this._lateralFilter.clear()
        return {
          state: this._state,
          enteredEngaged: false,
          enteredEnded: true,
          reCaptureOrigin: false,
          applyAxis: {x: true, y: true}
        }
      }
    }

    const forwardVel = input.forwardVelocityCmPerSec ?? 0
    const lateralDelta = input.lateralDeltaCm ?? {x: 0, y: 0}
    const forwardGateActive = Math.abs(forwardVel) > this.forwardVelGateCmPerSec

    // Intercepting: engagement decision is the only thing that happens here.
    if (this._state === GestureState.Intercepting) {
      if (forwardGateActive) {
        // While the user is poking forward (or retracting), suppress engagement
        // and re-anchor the origin each frame. The lateral motion this frame is
        // poke trajectory, not scroll intent — do NOT feed the filter (we want
        // it to start fresh from landing) and do NOT increment the dwell.
        this._consecutiveBeyondDeadzoneFrames = 0
        return {
          state: this._state,
          enteredEngaged: false,
          enteredEnded: false,
          reCaptureOrigin: true,
          applyAxis: {x: true, y: true}
        }
      }

      // Gate is inactive — actual engagement check.
      this._lateralFilter.push(lateralDelta.x, lateralDelta.y)
      const beyondDeadzone = input.lateralDistanceFromStartCm >= this.lateralDeadzoneCm
      if (beyondDeadzone) {
        this._everCrossedDeadzone = true
      }
      // Require BOTH beyondDeadzone AND pokeStillTouching to count toward dwell.
      // Without the pokeStillTouching gate, the counter can build up on frames
      // where the user's finger isn't geometrically engaged with the plane
      // (e.g. while reaching toward a child UI element that protrudes forward
      // — the engagement signal is LOST for those frames). Engaging on such a
      // frame immediately runs the not-touching grace countdown and ends the
      // gesture → "microscroll that goes nowhere". Reset on either condition
      // failing so a transient un-touch wipes the buildup.
      if (beyondDeadzone && input.pokeStillTouching) {
        this._consecutiveBeyondDeadzoneFrames++
        if (this._consecutiveBeyondDeadzoneFrames > this.engageDwellFrames) {
          this._state = GestureState.Engaged
          return {
            state: this._state,
            enteredEngaged: true,
            enteredEnded: false,
            reCaptureOrigin: false,
            applyAxis: {x: true, y: true}
          }
        }
      } else {
        this._consecutiveBeyondDeadzoneFrames = 0
      }
      return {
        state: this._state,
        enteredEngaged: false,
        enteredEnded: false,
        reCaptureOrigin: false,
        applyAxis: {x: true, y: true}
      }
    }

    // Engaged: feed the filter and compute per-axis anti-hook mask.
    this._lateralFilter.push(lateralDelta.x, lateralDelta.y)
    const filtered = this._lateralFilter.average
    // Sign-check: reject the delta on an axis only when its sign disagrees with
    // the filtered velocity's sign on that axis AND neither is zero. The "either
    // is zero" carve-out keeps us from rejecting deltas during the initial
    // post-engagement frames where the filter hasn't accumulated yet, or on
    // frames where the user isn't moving on that axis.
    const signsDisagreeX =
      filtered.x !== 0 && lateralDelta.x !== 0 && Math.sign(filtered.x) !== Math.sign(lateralDelta.x)
    const signsDisagreeY =
      filtered.y !== 0 && lateralDelta.y !== 0 && Math.sign(filtered.y) !== Math.sign(lateralDelta.y)

    return {
      state: this._state,
      enteredEngaged: false,
      enteredEnded: false,
      reCaptureOrigin: false,
      applyAxis: {x: !signsDisagreeX, y: !signsDisagreeY}
    }
  }

  /**
   * External cancellation — e.g., scrollingPaused became true, IK fired
   * onTriggerCanceled, or the active interactor switched. Moves Intercepting/Engaged →
   * Ended; no-op from Idle/Ended.
   */
  public cancel(): void {
    if (this._state === GestureState.Intercepting || this._state === GestureState.Engaged) {
      this._state = GestureState.Ended
      this._lateralFilter.clear()
    }
  }

  /**
   * Return to Idle. Should be called by the consumer after it has handled the Ended
   * transition (e.g., applied fling velocity, cleared its activeInteractor reference).
   */
  public reset(): void {
    this._state = GestureState.Idle
    this._consecutiveNotTouchingFrames = 0
    this._consecutiveBeyondDeadzoneFrames = 0
    this._lateralFilter.clear()
  }
}

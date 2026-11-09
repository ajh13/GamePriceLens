import type {BaseScroller} from "./BaseScroller"

/**
 * Pure scroll math shared by ScrollWindow and NumberPicker. Deliberately free
 * of Lens Studio types — scalar per-axis signatures keep every sign case
 * reachable from Jest. Two layers live here:
 *
 * 1. FRAME HELPERS (page grids and normalized position mapping) on the
 *    UNIFIED READING-ORDER FRAME: per axis, page indices and normalized
 *    position both originate at the reading-order start edge, passed in by
 *    the caller. The frame coordinate is `s = (P - startEdge) * direction`:
 *    - y: direction 1 — s grows scrolling DOWN through content (P increasing)
 *    - x: direction -1 — s grows scrolling RIGHT through content, which is P
 *      DECREASING (the x span endEdge - startEdge is NEGATIVE when scrollable;
 *      guards must use Math.abs, never a signed compare)
 *    ScrollWindow's frame is top-left anchored: both start edges sit at 0 and
 *    the end edges at ±(content - window), so the page origin never moves
 *    under resize.
 *
 * 2. SNAP-TARGET SELECTION AND SETTLE ORCHESTRATION ({@link SnapScrollPolicy}
 *    and the two fling-to-page projection flavors), shared by ScrollWindow's
 *    paging/detent modes and NumberPicker's detent wheel. Sits BESIDE BaseScroller:
 *    the engine stays pure physics; this layer owns the committed-target
 *    latch. The projection flavors are deliberately distinct — do not unify
 *    them.
 */

// ─── Frame helpers (page grids and normalized position mapping) ─────────

export type ScrollAxisDirection = 1 | -1

const NEAR_INTEGER_PAGE_EPSILON = 1e-9

/**
 * Nearest page index for a raw scroller position.
 * Bounded axes round in the reading-order frame (page 0 at the start edge).
 * Unbounded axes (`startEdgePos === null`) replicate V1 ScrollWindow's raw behavior
 * verbatim — page 0 at raw position 0, rounding half AWAY from zero
 * (`Math.round(Math.abs(f)) * Math.sign(f)`, which differs from `Math.round(f)` at
 * negative halves) and IGNORING direction.
 */
export function pageIndexFromPosition(
  position: number,
  startEdgePos: number | null,
  direction: ScrollAxisDirection,
  pitch: number
): number {
  if (pitch <= 0) return 0
  if (startEdgePos === null) {
    const currentPageFloat = position / pitch
    // + 0 folds IEEE-754 negative zero into positive zero.
    return Math.round(Math.abs(currentPageFloat)) * Math.sign(currentPageFloat) + 0
  }
  return Math.round(((position - startEdgePos) * direction) / pitch) + 0
}

/**
 * Raw scroller position of a page index — the inverse of {@link pageIndexFromPosition}.
 * Unbounded axes (`startEdgePos === null`) anchor pages at raw 0, direction ignored
 * (V1 parity).
 */
export function pagePositionForIndex(
  index: number,
  startEdgePos: number | null,
  direction: ScrollAxisDirection,
  pitch: number
): number {
  if (startEdgePos === null) return index * pitch
  return startEdgePos + index * pitch * direction
}

/** Highest valid page index for a bounded axis (page 0 is always valid). */
export function maxValidPageIndex(startEdgePos: number, endEdgePos: number, pitch: number): number {
  if (pitch <= 0) return 0
  const span = Math.abs(endEdgePos - startEdgePos)
  return Math.floor((span + pitch * NEAR_INTEGER_PAGE_EPSILON) / pitch)
}

/**
 * Fling-projection cap for detent mode: limits projected pages without ever pulling the
 * view back behind pages the finger already physically crossed.
 *
 * Retained as a public frame helper for consumers that use a start-relative
 * clamp. ScrollWindow's built-in Detent projection now preserves drag travel
 * directly, while Paging selects a gesture-start- or release-page-relative cap
 * through ScrollWindow.pagingSnapCapMode.
 */
export function detentMaxPagesFromStart(
  startPageIndex: number,
  currentPageIndex: number,
  maxSnapStepsPerFling: number
): number {
  return Math.max(maxSnapStepsPerFling, Math.abs(currentPageIndex - startPageIndex))
}

/**
 * Normalized scroll position: 0 at the reading-order start edge, 1 at the end edge.
 * Values extrapolate outside [0, 1] during elastic overscroll — callers must not clamp.
 * Degenerate spans (|endEdge - startEdge| <= epsilon, exact-fit content) read as 0.
 */
export function normalizedFromPosition(
  position: number,
  startEdgePos: number,
  endEdgePos: number,
  epsilon: number
): number {
  const span = endEdgePos - startEdgePos
  if (Math.abs(span) <= epsilon) return 0
  // + 0 folds IEEE-754 negative zero into positive zero (0 / negative span yields -0).
  return (position - startEdgePos) / span + 0
}

/** Inverse of {@link normalizedFromPosition}; degenerate spans collapse to the start edge. */
export function positionFromNormalized(
  normalized: number,
  startEdgePos: number,
  endEdgePos: number,
  epsilon: number
): number {
  const span = endEdgePos - startEdgePos
  if (Math.abs(span) <= epsilon) return startEdgePos
  return startEdgePos + normalized * span
}

/**
 * Whether an axis has scrollable range. Mirrors the bounds-clamp branch
 * (contentSize > windowSize) with an epsilon skirt. Content SMALLER than the window
 * inverts the edges, leaving |span| large — so this deliberately cannot be expressed as
 * a span check. Callers handle the unbounded -1 sentinel before calling.
 */
export function isAxisScrollable(contentSize: number, windowSize: number, epsilon: number): boolean {
  return contentSize - windowSize > epsilon
}

// ─── Snap-target selection and settle orchestration ─────────────────────

type SnapProjectionFromCurrentCommonArgs = {
  /** Page nearest the current position (consumer geometry). */
  currentPageIndex: number
  /** Page latched at drag start. */
  startPageIndex: number
  /** Current reading-order position. */
  currentPosition: number
  /** Fling velocity, read BEFORE the handoff consumes it. */
  velocity: number
  minFlingVelocity: number
  /** Coast distance for |velocity| (BaseScroller.getProjectedFlingDistance). */
  projectedDistance: number
  pitch: number
  /** Absolute distance; consumers pass pitch * deadzoneFraction. */
  deadzone: number
}

/** Continuous Paging projection arguments. */
export type ContinuousSnapProjectionFromCurrentArgs = SnapProjectionFromCurrentCommonArgs & {
  /** Reading-order position of currentPageIndex on the snap grid. */
  currentPagePosition: number
  /** Actual reading-order gesture/reseed position, which may be off-grid. */
  startPosition: number
  /** @deprecated Ignored for geometry when the continuous position pair is present. */
  startPagePosition?: number
  /** Max pages from the gesture's starting page. Defaults to Infinity. */
  maxPagesFromStart?: number
  /** Max pages from the page nearest release; takes precedence over maxPagesFromStart. */
  maxPagesFromRelease?: number
  /** @deprecated Use maxPagesFromRelease. */
  maxFlingPages?: number
}

/**
 * Pre-continuous-projection argument shape. Retained so existing direct
 * TypeScript and JavaScript consumers keep both their call shape and behavior.
 * @deprecated Use {@link ContinuousSnapProjectionFromCurrentArgs}.
 */
export type SnapProjectionFromCurrentArgs = SnapProjectionFromCurrentCommonArgs & {
  /** Starting page's grid position; use startPosition plus currentPagePosition for continuous projection. */
  startPagePosition: number
  /** Modern continuous geometry is intentionally excluded from the legacy shape. */
  startPosition?: never
  /** Modern continuous geometry is intentionally excluded from the legacy shape. */
  currentPagePosition?: never
  /** Max pages from the gesture's starting page. Defaults to Infinity. */
  maxPagesFromStart?: number
  /** Max pages from the page nearest release; takes precedence over maxPagesFromStart. */
  maxPagesFromRelease?: number
  /** @deprecated Use maxPagesFromRelease. */
  maxFlingPages?: number
}

type CompatibleSnapProjectionFromCurrentArgs = ContinuousSnapProjectionFromCurrentArgs | SnapProjectionFromCurrentArgs

/** Arguments for detent-style projection (from the gesture START). */
export type SnapProjectionFromStartArgs = {
  startPageIndex: number
  /** Page nearest the release position (consumer geometry). */
  releasePageIndex: number
  currentPosition: number
  /** Gesture anchor position (BaseScroller.startPosition). */
  startPosition: number
  velocity: number
  minFlingVelocity: number
  projectedDistance: number
  pitch: number
  deadzone: number
  /** Cap on fling-projected pages (wrap cap). Defaults to Infinity. */
  maxProjectedPages?: number
}

export type SnapSettleOptions = {
  /** Skip the spring entirely when |target - current| <= epsilon (ScrollWindow parity). */
  earlyExitEpsilon?: number
  /**
   * Allocation-free frame-coherence hook (NumberPicker wrap normalization).
   * Runs between spring evaluation and the settle check. The policy applies the
   * returned position's delta to both the local target and its committed latch.
   * Takes precedence over {@link normalizeFrame} when both are provided.
   */
  normalizePosition?: (position: number) => number
  /**
   * Frame-coherence hook retained for compatibility. The hook MUST keep the
   * committed latch coherent itself — i.e. call shiftTarget with the same delta
   * it applies to targetPosition — or the latch desyncs from the spring target.
   *
   * @deprecated Prefer {@link normalizePosition}, which lets the policy own the
   * target/latch shift and does not require a transient frame result object.
   */
  normalizeFrame?: (position: number, targetPosition: number) => {position: number; targetPosition: number}
}

export type SnapSettleResult = {
  position: number
  settled: boolean
  /** True only when the spring was never evaluated (early exit or no latch). */
  alreadyAtTarget: boolean
  velocity: number
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** @deprecated Pass {@link ContinuousSnapProjectionFromCurrentArgs}. */
export function projectSnapPageFromCurrent(args: SnapProjectionFromCurrentArgs): number
/**
 * Paging flavor: project the continuous CURRENT position through its remaining
 * coast, then quantize once in the fling direction. Pairing currentPageIndex
 * with currentPagePosition makes the projected page coordinate continuous when
 * the nearest release page changes at a half-pitch boundary.
 *
 * Below-deadzone snaps back to the starting page; past-deadzone + slow velocity
 * settles on the CURRENT page (the page dragged to), never back to start. The
 * `maxPagesFromStart` preserves the legacy one-page-per-gesture contract;
 * `maxPagesFromRelease` anchors the cap at the current page, so the cap itself
 * does not truncate drag travel. An opposing fling may still target an earlier page.
 */
export function projectSnapPageFromCurrent(args: ContinuousSnapProjectionFromCurrentArgs): number
export function projectSnapPageFromCurrent(args: CompatibleSnapProjectionFromCurrentArgs): number {
  const continuousArgs = args as Partial<ContinuousSnapProjectionFromCurrentArgs>
  const hasStartPosition = continuousArgs.startPosition !== undefined
  const hasCurrentPagePosition = continuousArgs.currentPagePosition !== undefined
  if (hasStartPosition !== hasCurrentPagePosition) {
    throw new TypeError("Paging projection requires startPosition and currentPagePosition together")
  }

  let targetPageIndex: number
  if (!hasStartPosition) {
    // Compatibility path for the original exported call shape. Keep the old
    // discrete current-page jump and start-relative cap rather than trying to
    // infer a continuous page frame that the caller never supplied.
    const legacyArgs = args as SnapProjectionFromCurrentArgs
    if (!Number.isFinite(legacyArgs.startPagePosition)) {
      throw new TypeError("Legacy Paging projection requires a finite startPagePosition")
    }
    const hasExceededDeadzone =
      Math.abs(legacyArgs.currentPosition - legacyArgs.startPagePosition) > legacyArgs.deadzone
    targetPageIndex = legacyArgs.currentPageIndex

    if (hasExceededDeadzone && Math.abs(legacyArgs.velocity) > legacyArgs.minFlingVelocity) {
      const pageJump =
        Math.max(1, Math.ceil(legacyArgs.projectedDistance / legacyArgs.pitch)) * Math.sign(legacyArgs.velocity)
      targetPageIndex = legacyArgs.currentPageIndex + pageJump
    } else if (!hasExceededDeadzone) {
      targetPageIndex = legacyArgs.startPageIndex
    }
  } else {
    if (!Number.isFinite(continuousArgs.startPosition) || !Number.isFinite(continuousArgs.currentPagePosition)) {
      throw new TypeError("Continuous Paging projection positions must be finite")
    }
    const modernArgs = args as ContinuousSnapProjectionFromCurrentArgs
    const hasExceededDeadzone = Math.abs(modernArgs.currentPosition - modernArgs.startPosition) > modernArgs.deadzone
    if (!hasExceededDeadzone) {
      targetPageIndex = modernArgs.startPageIndex
    } else if (Math.abs(modernArgs.velocity) <= modernArgs.minFlingVelocity || modernArgs.pitch <= 0) {
      targetPageIndex = modernArgs.currentPageIndex
    } else {
      const flingDirection = Math.sign(modernArgs.velocity)
      const projectedPosition = modernArgs.currentPosition + flingDirection * modernArgs.projectedDistance
      const projectedPage =
        modernArgs.currentPageIndex + (projectedPosition - modernArgs.currentPagePosition) / modernArgs.pitch
      // Directional quantization retains Paging's fast-flick bias. The epsilon
      // keeps an endpoint that should be exactly on a page from spilling one page
      // farther because of floating-point noise; +0 folds its exact-origin -0.
      targetPageIndex =
        (flingDirection > 0
          ? Math.ceil(projectedPage - NEAR_INTEGER_PAGE_EPSILON)
          : Math.floor(projectedPage + NEAR_INTEGER_PAGE_EPSILON)) + 0
    }
  }

  const maxPagesFromRelease = args.maxPagesFromRelease ?? args.maxFlingPages
  if (maxPagesFromRelease !== undefined) {
    return clampNumber(
      targetPageIndex,
      args.currentPageIndex - maxPagesFromRelease,
      args.currentPageIndex + maxPagesFromRelease
    )
  }

  const maxPagesFromStart = args.maxPagesFromStart ?? Number.POSITIVE_INFINITY
  return clampNumber(targetPageIndex, args.startPageIndex - maxPagesFromStart, args.startPageIndex + maxPagesFromStart)
}

/**
 * Detent drag rule: the released page if it moved with the drag,
 * else one page in the drag direction; the start page when there is no direction.
 */
export function resolveDragTargetPage(startPageIndex: number, releasePageIndex: number, dragDirection: number): number {
  if (dragDirection === 0) {
    return startPageIndex
  }

  const releasePageOffset = releasePageIndex - startPageIndex
  if (releasePageOffset !== 0 && Math.sign(releasePageOffset) === dragDirection) {
    return releasePageIndex
  }

  return startPageIndex + dragDirection
}

/**
 * Detent flavor: project from the START page. Four branches:
 * below-deadzone snaps back to the starting page; past-deadzone + slow fling
 * resolves via the drag rule; a fling agreeing with the drag advances
 * max(drag pages, capped projected pages), at least one; an opposing fling
 * falls back to the drag rule.
 */
export function projectSnapPageFromStart(args: SnapProjectionFromStartArgs): number {
  const maxProjectedPages = args.maxProjectedPages ?? Number.POSITIVE_INFINITY
  const gestureDisplacement = args.currentPosition - args.startPosition
  if (Math.abs(gestureDisplacement) <= args.deadzone) {
    return args.startPageIndex
  }

  const dragDirection = Math.sign(gestureDisplacement)
  const dragTargetPageIndex = resolveDragTargetPage(args.startPageIndex, args.releasePageIndex, dragDirection)
  if (Math.abs(args.velocity) <= args.minFlingVelocity || !Number.isFinite(args.pitch) || args.pitch <= 0) {
    return dragTargetPageIndex
  }

  const pagesFromDrag = Math.abs(dragTargetPageIndex - args.startPageIndex)
  const totalProjectedPages = Math.min(Math.floor(args.projectedDistance / args.pitch), maxProjectedPages)
  const flingDirection = Math.sign(args.velocity)
  const dragAgreesWithFling = dragDirection === flingDirection

  if (dragAgreesWithFling) {
    return args.startPageIndex + Math.max(1, Math.max(pagesFromDrag, totalProjectedPages)) * flingDirection
  }

  return dragTargetPageIndex
}

/**
 * Owns the committed snap-target latch and the Detent projection anchor for one axis.
 * ScrollWindow keeps the anchor's page index and raw axis position paired via
 * {@link setStartAnchor}; consumers such as NumberPicker may own their position
 * anchor separately and use {@link startingPageIndex} alone.
 * Never clears its own latch on settle — the consumer owns the clear, exactly
 * where it happened before the extraction.
 */
export class SnapScrollPolicy {
  private committedTargetPositionValue: number | null = null
  private startingPageIndexValue: number = 0
  private startingPositionValue: number = 0

  public constructor(private readonly snapVelocityHandoffScale: number) {}

  public get hasCommittedTarget(): boolean {
    return this.committedTargetPositionValue !== null
  }

  public get committedTargetPosition(): number | null {
    return this.committedTargetPositionValue
  }

  public get startingPageIndex(): number {
    return this.startingPageIndexValue
  }

  public set startingPageIndex(index: number) {
    this.startingPageIndexValue = index
  }

  /** Raw axis position paired with {@link startingPageIndex} for start-based projection. */
  public get startingPosition(): number {
    return this.startingPositionValue
  }

  /** Re-seeds both halves of the start-based projection anchor atomically. */
  public setStartAnchor(pageIndex: number, position: number): void {
    this.startingPageIndexValue = pageIndex
    this.startingPositionValue = position
  }

  /** Latches the target; returns it for call-site chaining. */
  public commitTarget(position: number): number {
    this.committedTargetPositionValue = position
    return position
  }

  public clearTarget(): void {
    this.committedTargetPositionValue = null
  }

  /** Shifts the latched target (wrap normalization); no-op when nothing is latched. */
  public shiftTarget(delta: number): void {
    if (this.committedTargetPositionValue !== null) {
      this.committedTargetPositionValue += delta
    }
  }

  /**
   * Seeds the snap spring from the pending fling velocity when the fling points
   * at the target, scaled and clamped. ALWAYS clears the scroller's pending fling
   * as a side effect — capture any reads of flingVelocity / projected distance
   * BEFORE calling this.
   */
  public consumeSnapVelocityHandoff(
    scroller: BaseScroller,
    targetPosition: number,
    currentPosition: number,
    maxHandoffVelocity: number
  ): number {
    let seedVelocity = 0
    if (
      scroller.hasPendingFlingVelocity &&
      Math.sign(targetPosition - currentPosition) === Math.sign(scroller.flingVelocity)
    ) {
      seedVelocity = clampNumber(
        scroller.flingVelocity * this.snapVelocityHandoffScale,
        -maxHandoffVelocity,
        maxHandoffVelocity
      )
    }

    scroller.clearPendingFlingVelocity()
    return seedVelocity
  }

  /**
   * Advances one spring frame toward the latch into caller-owned storage.
   * NEVER clears the latch. Fully overwrites `out` on every return path.
   * This method itself allocates nothing; a deprecated normalizeFrame callback
   * may still allocate its compatibility result.
   */
  public stepSettleInto(
    scroller: BaseScroller,
    currentPosition: number,
    positionThreshold: number,
    velocityThreshold: number,
    out: SnapSettleResult,
    options?: SnapSettleOptions
  ): SnapSettleResult {
    let targetPosition = this.committedTargetPositionValue
    if (targetPosition === null) {
      // Defensive: callers only step while latched.
      out.position = currentPosition
      out.settled = true
      out.alreadyAtTarget = true
      out.velocity = 0
      return out
    }

    if (
      options?.earlyExitEpsilon !== undefined &&
      Math.abs(targetPosition - currentPosition) <= options.earlyExitEpsilon
    ) {
      out.position = currentPosition
      out.settled = true
      out.alreadyAtTarget = true
      out.velocity = scroller.springVelocity
      return out
    }

    let position = scroller.evaluateSpringPosition(currentPosition, targetPosition)
    const normalizePosition = options?.normalizePosition
    if (normalizePosition !== undefined) {
      const normalizedPosition = normalizePosition(position)
      const normalizationDelta = normalizedPosition - position
      position = normalizedPosition
      if (normalizationDelta !== 0) {
        targetPosition += normalizationDelta
        this.shiftTarget(normalizationDelta)
      }
    } else {
      const normalizeFrame = options?.normalizeFrame
      if (normalizeFrame !== undefined) {
        const frame = normalizeFrame(position, targetPosition)
        position = frame.position
        targetPosition = frame.targetPosition
      }
    }

    const settled = scroller.isSpringSettled(position, targetPosition, positionThreshold, velocityThreshold)
    out.position = settled ? targetPosition : position
    out.settled = settled
    out.alreadyAtTarget = false
    out.velocity = scroller.springVelocity
    return out
  }

  /**
   * Allocating convenience wrapper for callers that do not provide scratch
   * storage. Prefer {@link stepSettleInto} on per-frame paths.
   */
  public stepSettle(
    scroller: BaseScroller,
    currentPosition: number,
    positionThreshold: number,
    velocityThreshold: number,
    options?: SnapSettleOptions
  ): SnapSettleResult {
    const out: SnapSettleResult = {
      position: currentPosition,
      settled: false,
      alreadyAtTarget: false,
      velocity: 0
    }
    return this.stepSettleInto(scroller, currentPosition, positionThreshold, velocityThreshold, out, options)
  }
}

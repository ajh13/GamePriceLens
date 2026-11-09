import type {BaseScrollerConfig} from "./BaseScroller"

/**
 * How the scroller chooses rest positions.
 * - "none": momentum coast, rests anywhere (free scrolling)
 * - "paging": always settles on a page boundary (page = snapPitch)
 * - "detent": paging where every item is a snap point and the resting item is the selection
 */
export type SnapMode = "none" | "paging" | "detent"

/**
 * What happens at the content edges.
 * - "elastic": rubber-band overscroll with resistance, then spring back
 * - "clamped": hard stop at bounds, no overscroll
 * - "unbounded": no edges (free infinite scroll)
 * - "wrapped": no edges, content loops (modulo indexing)
 */
export type EdgeMode = "elastic" | "clamped" | "unbounded" | "wrapped"

/**
 * Named deceleration/tuning bundle (analogous to UIScrollView.decelerationRate).
 * - "smooth": long glide, soft edge bounce — the classic ScrollWindow tuning
 * - "crisp": short glide, firm detent feel — the NumberPicker wheel tuning
 */
export type Feel = "smooth" | "crisp"

/**
 * Declarative description of a scroller's interaction contract. Expanded by
 * {@link makeScroller} into the flat physics config (and snap-policy data).
 *
 * `edgeMode`/`snapMode` are construction-time intent declarations: runtime-mutable
 * flags (`ScrollWindow.edgeMode`, `ScrollWindow.scrollSnapping`/`snapMode`/
 * `maxSnapStepsPerFling`, NumberPicker per-field `wrapAround`) continue to
 * override behavior at runtime.
 */
export type ScrollerBehaviorSpec = {
  snapMode: SnapMode
  edgeMode: EdgeMode
  feel: Feel
  /** Snap grid pitch (page size or row height). Omit when the consumer supplies it at runtime. */
  snapPitch?: number
  /** Fraction of snapPitch a release must travel to advance a page. Defaults to 0.25. */
  deadzoneFraction?: number
  /**
   * Finite snap-projection cap. Defaults to Infinity; the consumer/mode defines
   * whether the cap is anchored at gesture start or the page nearest release.
   */
  maxSnapStepsPerFling?: number
  /** Fraction of the viewport the content may overscroll before resistance saturates ("elastic" only). */
  maxOverscrollFraction?: number
  /** Raw low-level escape hatch — spread over the generated config last, wins over the feel bundle. */
  overrides?: Partial<BaseScrollerConfig>
}

/**
 * Snap-policy data derived from a spec, carried alongside the physics config
 * for the SnapScrollPolicy collaborator (in ScrollUtilities) to consume.
 */
export type SnapPolicyParams = {
  snapMode: Exclude<SnapMode, "none">
  /** null = consumer supplies pitch at runtime (ScrollWindow snapRegion / NumberPicker rowHeight). */
  snapPitch: number | null
  deadzoneFraction: number
  /** Consumer-defined snap-projection cap; see ScrollerBehaviorSpec. */
  maxSnapStepsPerFling: number
  /** Fraction of fling velocity seeded into the snap spring when fling and target direction agree. */
  snapVelocityHandoffScale: number
}

/** A named spec with the consumer-read edge/snap parameters made required. */
export type NamedScrollerPreset = ScrollerBehaviorSpec & {
  maxOverscrollFraction: number
  deadzoneFraction: number
}

export const DEFAULT_DEADZONE_FRACTION = 0.25
export const DEFAULT_MAX_SNAP_STEPS_PER_FLING = Number.POSITIVE_INFINITY

const VELOCITY_BASE_FRAME_TIME = 1 / 60

// Fields identical across both legacy constant sets — engine-invariant.
// epsilon deliberately matches NUMBER_PICKER_ROW_HEIGHT_EPSILON (UIKitUtilities);
const ENGINE_INVARIANTS = {
  epsilon: 0.0025,
  velocityBaseFrameTime: VELOCITY_BASE_FRAME_TIME,
  minVelocitySampleDeltaTime: 1 / 240,
  flingMultiplier: 1,
  flingIdleTimeoutMs: 100
}

/** Physics config plus the snap-policy scalar owned by the feel rather than the engine. */
type FeelBundle = {
  config: BaseScrollerConfig
  /** Fraction of release fling velocity handed to the snap spring when directions agree. */
  snapVelocityHandoffScale: number
}

// Verbatim from the pre-refactor ScrollWindow.ts SCROLL_WINDOW_SCROLLER_CONFIG.
// Keep the expressions unfolded (e.g. 0.08 / VELOCITY_BASE_FRAME_TIME, never 4.8) —
// the pinning tests assert bit-for-bit equality with the legacy values.
const SMOOTH_FEEL: FeelBundle = {
  config: {
    ...ENGINE_INVARIANTS,
    significantVelocityThreshold: 0.08 / VELOCITY_BASE_FRAME_TIME,
    velocityDecayFactor: 0.55,
    frictionFactor: 0.965,
    minimumScrollingVelocity: 0.08 / VELOCITY_BASE_FRAME_TIME,
    // 0-1, lower = smoother but more lag
    velocitySmoothing: 0.45,
    // Most-recent-first weights; sum to 1.0.
    velocityHistoryWeights: [0.45, 0.25, 0.15, 0.1, 0.05],
    gestureAccumulationTimeMs: 220,
    edgeBounceStrength: 0.6,
    springDuration: 0.32
  },
  snapVelocityHandoffScale: 0.4
}

// Verbatim from the pre-refactor NumberPickerFieldScroller.ts NUMBER_PICKER_SCROLLER_CONFIG.
const CRISP_FEEL: FeelBundle = {
  config: {
    ...ENGINE_INVARIANTS,
    significantVelocityThreshold: 0.1 / VELOCITY_BASE_FRAME_TIME,
    velocityDecayFactor: 0.7,
    frictionFactor: 0.95,
    minimumScrollingVelocity: 0.15 / VELOCITY_BASE_FRAME_TIME,
    velocitySmoothing: 0.3,
    velocityHistoryWeights: [0.35, 0.25, 0.2, 0.12, 0.08],
    gestureAccumulationTimeMs: 300,
    edgeBounceStrength: 1.0,
    springDuration: 0.35
  },
  snapVelocityHandoffScale: 0.5
}

const FEEL_BUNDLES: Record<Feel, FeelBundle> = {
  smooth: SMOOTH_FEEL,
  crisp: CRISP_FEEL
}

/**
 * Expands a declarative behavior spec into the artifacts a scroller needs:
 * the flat physics config for {@link BaseScroller} and the snap-policy data
 * (null when snapMode is "none"). Returns fresh objects on every call.
 */
export function makeScroller(spec: ScrollerBehaviorSpec): {
  config: BaseScrollerConfig
  snapPolicy: SnapPolicyParams | null
} {
  const feel = FEEL_BUNDLES[spec.feel]
  // Merge first, slice last — an override-supplied weights array must not be
  // returned by reference (fresh-objects contract).
  const merged: BaseScrollerConfig = {...feel.config, ...spec.overrides}
  const config: BaseScrollerConfig = {
    ...merged,
    velocityHistoryWeights: merged.velocityHistoryWeights.slice()
  }
  const snapPolicy: SnapPolicyParams | null =
    spec.snapMode === "none"
      ? null
      : {
          snapMode: spec.snapMode,
          snapPitch: spec.snapPitch ?? null,
          deadzoneFraction: spec.deadzoneFraction ?? DEFAULT_DEADZONE_FRACTION,
          maxSnapStepsPerFling: spec.maxSnapStepsPerFling ?? DEFAULT_MAX_SNAP_STEPS_PER_FLING,
          snapVelocityHandoffScale: feel.snapVelocityHandoffScale
        }
  return {config, snapPolicy}
}

/** ScrollWindow free/momentum scrolling: coast anywhere, elastic edge bounce. */
export const SCROLL_WINDOW_FREE_PRESET: NamedScrollerPreset = Object.freeze({
  snapMode: "none" as const,
  edgeMode: "elastic" as const,
  feel: "smooth" as const,
  maxOverscrollFraction: 0.25,
  deadzoneFraction: DEFAULT_DEADZONE_FRACTION
})

/**
 * ScrollWindow page-snap scrolling. Same feel (and therefore identical physics
 * config) as the free preset — snapPitch comes from the runtime snapRegion and
 * the runtime maxSnapStepsPerFling property caps projection. ScrollWindow's
 * pagingSnapCapMode chooses whether that finite cap is anchored at gesture
 * start (legacy default) or the page nearest release (so the cap itself does
 * not truncate drag travel; an opposing fling may still move backward).
 */
export const SCROLL_WINDOW_PAGING_PRESET: NamedScrollerPreset = Object.freeze({
  snapMode: "paging" as const,
  edgeMode: "elastic" as const,
  feel: "smooth" as const,
  maxOverscrollFraction: 0.25,
  deadzoneFraction: DEFAULT_DEADZONE_FRACTION
})

/**
 * NumberPicker wheel: mandatory detent per row, crisp feel. Per-field wrapAround
 * switches the effective edge to "wrapped" at runtime; snapPitch is the runtime rowHeight.
 */
export const NUMBER_PICKER_DETENT_PRESET: NamedScrollerPreset = Object.freeze({
  snapMode: "detent" as const,
  edgeMode: "elastic" as const,
  feel: "crisp" as const,
  maxOverscrollFraction: 0.45,
  deadzoneFraction: DEFAULT_DEADZONE_FRACTION
})

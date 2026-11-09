/**
 * Pure gradient math for `LongPressButton`'s hold fill.
 *
 * The fill is not a child mesh. `RoundedRectangle` exposes a single scalar
 * `cornerRadius` — there are no per-corner radii — so a child quad can't have
 * rounded left corners and a sharp right edge without a mask. Instead the wipe
 * is a hard-edged stop pushed into the button's OWN background gradient, which
 * clips to the squircle for free and costs no extra draw call.
 *
 * Everything here is pure (vec4/vec2 arithmetic only, no engine calls), so the
 * stop layout is unit-testable without a Lens Studio runtime.
 *
 * ## Faithfulness to the shader
 *
 * `Materials/CollapsedSquircleFragment.customCode` evaluates a linear gradient as
 *
 * ```glsl
 * result = colors[0]
 * result = mix(result, colors[1], smoothstep(a0, a1, t))
 * for (i = 1; i < stops - 1; i++)
 *     result = mix(result, colors[i+1], smoothstep(ai, ai+1, t))
 * ```
 *
 * with `t = uv.x * cos(angle) - uv.y * sin(angle)` and stop percents remapped
 * into `[linearGradientStart, linearGradientStart + linearGradientLength]`.
 *
 * Three consequences drive the code below:
 *
 * 1. **`smoothstep`, not `mix`.** Segments are S-curved, not linear. `sampleGradient`
 *    reproduces that curve so the color we plant at the leading edge matches what
 *    the shader would have drawn there. A linear lerp would be visibly off-hue
 *    mid-segment.
 * 2. **`smoothstep(a, a, t)` divides by zero.** GLSL leaves `edge0 >= edge1`
 *    undefined, so emitted percents must be STRICTLY increasing. That is what
 *    `epsilon` buys, and why near-coincident stops get collapsed rather than
 *    emitted as a pair.
 * 3. **RGB, not HSV.** The shader's `mix` is component-wise RGB. `GradientParameters.lerp`
 *    interpolates in HSV via `colorLerp`, so it is deliberately NOT used here.
 *
 * ## Known, accepted inexactness
 *
 * Truncating a segment at `progress` reshapes that segment's S-curve: the shader
 * renders `[0, progress]` as one smoothstep to the planted edge color rather than
 * as the first slice of the authored segment's curve. Endpoints are exact — the
 * leading edge is always the true palette color at `progress`, and at
 * `progress === 1` the authored palette is emitted verbatim — but the revealed
 * interior is re-eased slightly while the wipe is in flight. With the DS3 accent
 * palette (a modest purple → blue → teal hue walk) the peak error is a few percent
 * of one segment's hue shift on a moving edge. Making this exact would require
 * masking rather than restopping, which costs a draw call and a render target.
 */

import {GradientParameters, GradientStop} from "../../Visuals/RoundedRectangle/RoundedRectangleTypes"

/**
 * Width, in gradient-percent units, of the cut between the filled and unfilled
 * regions. The shader smoothsteps across it, so this is the softness of the
 * "hard" edge as a fraction of button width: on a 9 cm button 0.005 is ~0.45 mm.
 *
 * Also the floor on progress before the override engages at all — below it there
 * is no room to place a strictly-increasing stop pair, and visually there is
 * nothing to show.
 */
export const DEFAULT_FILL_EDGE_EPSILON: number = 0.005

/**
 * The axis every long-press gradient runs on — the wipe's, and every base
 * gradient in the `LongPressButton` theme entries.
 *
 * Horizontal so the cut edge is vertical. This lives here, and the theme files
 * import it, because a mismatch is invisible in review but very visible at
 * runtime: the base gradient is handed back to the theme when the fill empties or
 * the button latches, and `GradientParameters.lerp` does NOT interpolate
 * `start` / `end` — it takes the target's outright. So a theme authored on the
 * DS3 accent diagonal (`±0.2`) snaps ~11 degrees on a single frame at the end of
 * a horizontal wipe, which shifts the palette by roughly 10% between the top and
 * bottom edges. One shared constant makes that drift impossible to author.
 *
 * Treat as immutable — these instances are shared across every gradient built
 * from them.
 */
export const FILL_AXIS_START: vec2 = new vec2(-1, 0)
export const FILL_AXIS_END: vec2 = new vec2(1, 0)

/** Max stops the shader's uniform arrays hold. */
const MAX_GRADIENT_STOPS: number = 7

/** A resolved, ordered palette stop. */
export type FillPaletteStop = {
  percent: number
  color: vec4
}

/** Inputs for one frame of the hold fill. */
export type FillGradientRequest = {
  /** The authored palette being revealed (the button's accent gradient). */
  palette: readonly FillPaletteStop[]
  /** Flat color of the not-yet-filled region. */
  trackColor: vec4
  /** Hold progress in [0, 1]. */
  progress: number
  /** Cut width; defaults to {@link DEFAULT_FILL_EDGE_EPSILON}. */
  epsilon?: number
}

function clamp01(value: number): number {
  if (!(value > 0)) {
    // Catches NaN as well as negatives.
    return 0
  }
  return value < 1 ? value : 1
}

/** GLSL `smoothstep`, with the undefined `edge0 >= edge1` case pinned to a step. */
function smoothstep(edge0: number, edge1: number, t: number): number {
  if (!(edge1 > edge0)) {
    return t < edge0 ? 0 : 1
  }
  const x = clamp01((t - edge0) / (edge1 - edge0))
  return x * x * (3 - 2 * x)
}

/** Component-wise RGB mix — the shader's `mix`, not HSV `colorLerp`. */
function rgbMix(from: vec4, to: vec4, weight: number): vec4 {
  return new vec4(
    from.x + (to.x - from.x) * weight,
    from.y + (to.y - from.y) * weight,
    from.z + (to.z - from.z) * weight,
    from.w + (to.w - from.w) * weight
  )
}

/**
 * Reads a `GradientParameters` into an ordered stop list.
 *
 * Mirrors the shader's contiguity rule: a disabled stop terminates the run, so a
 * deserialized state with a hole (stop2 off, stop3 on) stops at the hole rather
 * than reading past it. Stops 0 and 1 are always shader-enabled.
 */
export function readPaletteStops(gradient: GradientParameters): FillPaletteStop[] {
  const ordered: (GradientStop | undefined)[] = [
    gradient.stop0,
    gradient.stop1,
    gradient.stop2,
    gradient.stop3,
    gradient.stop4,
    gradient.stop5,
    gradient.stop6
  ]
  const stops: FillPaletteStop[] = []
  for (let i = 0; i < MAX_GRADIENT_STOPS; i++) {
    const stop = ordered[i]
    if (stop === undefined || stop.color === undefined) {
      break
    }
    // Stops 0/1 ignore `enabled` in the shader; later ones terminate the run.
    if (i > 1 && stop.enabled === false) {
      break
    }
    stops.push({percent: stop.percent ?? 0, color: stop.color})
  }
  return stops
}

/**
 * Evaluates a stop list the way the fragment shader does: cumulative
 * `mix`-through-`smoothstep`, in RGB.
 *
 * The cumulative form is reproduced rather than the simpler
 * "find-the-segment-and-lerp" reduction so this can't drift from the shader if
 * it is ever handed non-monotonic stops (where the two forms differ).
 */
export function sampleGradient(stops: readonly FillPaletteStop[], t: number): vec4 {
  if (stops.length === 0) {
    return new vec4(0, 0, 0, 1)
  }
  let result = stops[0].color
  // No early-out on a zero weight: the loop runs to the end exactly as the
  // shader's does, so the two can't diverge on non-monotonic input.
  for (let i = 0; i < stops.length - 1; i++) {
    const weight = smoothstep(stops[i].percent, stops[i + 1].percent, t)
    result = rgbMix(result, stops[i + 1].color, weight)
  }
  return result
}

/**
 * Builds the stop list for a given hold progress.
 *
 * Layout (4 or 5 stops, always strictly increasing in percent):
 *
 * ```
 *   authored palette stops strictly left of the edge   [1..2 stops]
 *   sampleGradient(palette, progress)  @ progress      <- leading edge
 *   trackColor                         @ progress+eps  <- the cut
 *   trackColor                         @ 1
 * ```
 *
 * The stop count steps from 4 to 5 as the wipe crosses the palette's mid stop,
 * which costs one extra uniform-array upload on that single frame.
 *
 * @param request - Palette, track color, progress, and cut width.
 * @returns Ordered stops ready to write, never more than 5 entries.
 */
export function buildFillStops(request: FillGradientRequest): FillPaletteStop[] {
  const palette = request.palette
  const epsilon = request.epsilon !== undefined && request.epsilon > 0 ? request.epsilon : DEFAULT_FILL_EDGE_EPSILON
  const progress = clamp01(request.progress)
  const track = request.trackColor

  if (palette.length === 0) {
    return [
      {percent: 0, color: track},
      {percent: 1, color: track}
    ]
  }

  // Fully revealed: emit the authored palette untouched. No cut, so the completed
  // button is pixel-identical to a plain Button in the same state.
  if (progress >= 1 - epsilon) {
    const full: FillPaletteStop[] = []
    for (let i = 0; i < palette.length; i++) {
      full.push({percent: palette[i].percent, color: palette[i].color})
    }
    return full
  }

  // Nothing meaningful to reveal, and no room for a strictly-increasing pair.
  if (progress <= epsilon) {
    return [
      {percent: 0, color: track},
      {percent: 1, color: track}
    ]
  }

  const stops: FillPaletteStop[] = []
  // Keep only palette stops that clear the edge stop by a full epsilon, so the
  // emitted percents stay strictly increasing when the wipe passes over one.
  for (let i = 0; i < palette.length; i++) {
    if (palette[i].percent < progress - epsilon) {
      stops.push({percent: palette[i].percent, color: palette[i].color})
    }
  }
  if (stops.length === 0) {
    // The wipe is still left of the palette's first stop (or the palette starts
    // past 0). Anchor at 0 so the revealed sliver is a real color, not a hole.
    stops.push({percent: 0, color: sampleGradient(palette, 0)})
  }

  stops.push({percent: progress, color: sampleGradient(palette, progress)})
  stops.push({percent: progress + epsilon, color: track})
  stops.push({percent: 1, color: track})
  return stops
}

/**
 * Wraps {@link buildFillStops} into a `GradientParameters` ready for
 * `RoundedRectangleVisual.applyBaseGradientNow`.
 *
 * The axis is forced horizontal. The DS3 Primary palette is authored on a slight
 * diagonal (`start (-1, 0.2) -> end (1, -0.2)`), which would slant the wipe edge
 * about 11 degrees; the mock's edge is vertical. `applyBaseGradientNow` captures
 * and restores the authored positions, so the release path is unaffected.
 *
 * With a horizontal axis the shader reduces to `t = uv.x`, `linearGradientStart = -1`,
 * `linearGradientLength = 2`, and `uv.x` spans `[-1, 1]` across the width
 * regardless of aspect ratio — so a stop percent maps linearly across the button.
 *
 * @param request - Palette, track color, progress, and cut width.
 * @returns A Linear `GradientParameters` with 4 or 5 populated stops.
 */
export function buildFillGradient(request: FillGradientRequest): GradientParameters {
  const stops = buildFillStops(request)
  const gradient: GradientParameters = {
    enabled: true,
    type: "Linear",
    start: FILL_AXIS_START,
    end: FILL_AXIS_END
  }
  // Unused tail stops are left absent, not written as disabled:
  // `BaseRoundedRectangle.applyBackgroundGradientParameters` already disables any
  // stop the parameter set omits, so a shrinking stop count can't leave a stale
  // stop enabled from a previous, longer write.
  const keys = ["stop0", "stop1", "stop2", "stop3", "stop4", "stop5", "stop6"] as const
  for (let i = 0; i < stops.length && i < keys.length; i++) {
    gradient[keys[i]] = {color: stops[i].color, percent: stops[i].percent, enabled: true}
  }
  return gradient
}

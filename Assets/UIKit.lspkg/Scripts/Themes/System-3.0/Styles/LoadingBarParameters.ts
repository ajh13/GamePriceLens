// @module System-3.0/Styles/LoadingBarParameters — DO NOT REMOVE: prevents Lens Studio module collision
import {LoadingBarCometPurple, LoadingBarTeal, Transparent} from "../Colors"

/**
 * Themeable knobs for the LoadingBar component. Registered under
 * `componentData["LoadingBar"]` (no `styles` entry — the bar has no
 * interaction states). Motion numbers (sweep periods, band width, fill
 * smoothing) live in the Motion recipe (`recipes.loadingBar`), not here —
 * this is the LOOK: colors and the glow envelope per variant.
 *
 * All values are PROVISIONAL and may be retuned.
 */
export type LoadingBarComponentDataType = {
  /** Line variant (list-row streak): head color of the sweep. */
  lineColorHead: vec4
  /** Line variant: trailing color the streak fades through. */
  lineColorTail: vec4
  /** Comet variant (pill edge): head color of the sweep. */
  cometColorHead: vec4
  /** Comet variant: trailing iridescent color. */
  cometColorTail: vec4
  /** Vertical glow falloff exponent for the line variant (0 = the quad is
   * lit uniformly — the thin bar IS the line). */
  lineGlowShape: number
  /** Vertical glow falloff exponent for the comet variant (light hugs the
   * bottom edge, bleeding upward as pow(1 - v, shape)). */
  cometGlowShape: number
  /** Leading-edge bloom for the line variant, as a fraction of the band
   * width — how far ahead of the head the light ramps in. */
  lineHeadSoftness: number
  /** Leading-edge bloom for the comet variant. Larger than the line's: the
   * reference comet arrives as a soft glow, not a hard edge. */
  cometHeadSoftness: number
}

export const LoadingBarComponentData: LoadingBarComponentDataType = {
  lineColorHead: LoadingBarTeal,
  lineColorTail: new vec4(LoadingBarTeal.x, LoadingBarTeal.y, LoadingBarTeal.z, Transparent.w),
  cometColorHead: LoadingBarTeal,
  cometColorTail: new vec4(LoadingBarCometPurple.x, LoadingBarCometPurple.y, LoadingBarCometPurple.z, 0.0),
  lineGlowShape: 0,
  cometGlowShape: 2.2,
  lineHeadSoftness: 0.18,
  cometHeadSoftness: 0.45
}

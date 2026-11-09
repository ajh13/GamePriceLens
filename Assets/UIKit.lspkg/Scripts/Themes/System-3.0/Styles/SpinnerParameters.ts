// @module System-3.0/Styles/SpinnerParameters — DO NOT REMOVE: prevents Lens Studio module collision
import {SpinnerArcTeal} from "../Colors"

/**
 * Themeable knobs for the Spinner (circle loader) component. Registered
 * under `componentData["Spinner"]` (no `styles` entry — the Spinner has no
 * interaction states).
 *
 * Defaults describe the System 3.0 loading indicator: a constant ~200° teal
 * arc rotating clockwise at ~1 rev/s, intensity rising and falling
 * symmetrically along its length, the whole ring fading in/out over ~0.2 s
 * on start/stop.
 */
export type SpinnerComponentDataType = {
  /** Indeterminate rotation speed, revolutions per second (clockwise). */
  spinSpeed: number
  /** Seconds for one grow-shrink cycle of the indeterminate arc (no-op when min == max aperture). */
  apertureCycleSeconds: number
  /** Shortest indeterminate arc, as a fraction of the full circle (0..1). */
  minApertureFactor: number
  /** Longest indeterminate arc, as a fraction of the full circle (0..1). */
  maxApertureFactor: number
  /** Arc color at the tail end of the sweep. */
  colorTail: vec4
  /** Arc color at the head (leading) end of the sweep. */
  colorHead: vec4
  /**
   * Fraction of the arc length over which each end fades to transparent
   * (0 = hard ends, 0.5 = fades meet in the middle).
   */
  arcFadeFraction: number
  /** Seconds for the whole ring to fade in on start. */
  fadeInSeconds: number
  /** Seconds for the whole ring to fade out on stop. */
  fadeOutSeconds: number

  // Determinate progress mode.
  /** Each soft end of the progress arc, as a fraction of the full ring. */
  progressFadeFraction: number
  /** Time constant for the displayed progress easing toward the set value. */
  progressSmoothingSeconds: number

  // Completion sequence, section 1 — the TAIL end accelerates and catches
  // up toward the head, shrinking the arc; the shrunken, dimmed arc then
  // rides on at normal speed for a set number of revolutions.
  /** Section 1: revolutions the arc travels while the tail catches up. */
  completeShrinkRevolutions: number
  /** Section 1: settled arc length, as a fraction of the spinning arc. */
  completeSettleFraction: number
  /** Section 1: settled arc opacity. */
  completeSettleOpacity: number
  /** Section 1: extra revolutions the settled arc rides before section 2. */
  completeHoldRevolutions: number

  // Completion sequence, section 2 — the HEAD end accelerates and sweeps
  // all the way around, catching the still-moving tail to close a solid
  // ring, which then disappears.
  /** Section 2: seconds for the head to sweep around and close the ring. */
  completeFillSeconds: number
  /** Section 2: seconds for the soft seam to melt solid once closed. */
  completeSealSeconds: number
  /** Section 2: seconds the solid ring holds before fading. */
  completeSolidSeconds: number
  /** Section 2: final fade-out seconds once the ring is solid. */
  completeFadeSeconds: number
}

export const SpinnerComponentData: SpinnerComponentDataType = {
  spinSpeed: 1.05,
  apertureCycleSeconds: 1.6,
  minApertureFactor: 0.55,
  maxApertureFactor: 0.55,
  colorTail: SpinnerArcTeal,
  colorHead: SpinnerArcTeal,
  arcFadeFraction: 0.45,
  fadeInSeconds: 0.2,
  fadeOutSeconds: 0.25,
  progressFadeFraction: 0.03,
  progressSmoothingSeconds: 0.15,
  completeShrinkRevolutions: 1,
  completeSettleFraction: 0.22,
  completeSettleOpacity: 0.35,
  completeHoldRevolutions: 0.5,
  completeFillSeconds: 0.65,
  completeSealSeconds: 0.15,
  completeSolidSeconds: 0.35,
  completeFadeSeconds: 0.2
}

// @module TextInput/AsrVoiceAnimation — DO NOT REMOVE: prevents Lens Studio module collision

import animate, {CancelSet} from "InteractionKit.lspkg/Utils/animate"
import {
  TextInputFieldVoiceSweepBlue,
  TextInputFieldVoiceSweepDarkTeal,
  TextInputFieldVoiceSweepTeal,
  TextInputFieldVoiceSweepViolet
} from "../../Themes/System-3.0/Colors"
import {GradientParameters, GradientStop} from "../../Visuals/RoundedRectangle/RoundedRectangle"
import {RoundedRectangleVisual} from "../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {StateName} from "../Element"
import {STATE_ANIMATION_DURATION} from "./TextInputConsts"

/**
 * Shared "voice mode" background animation primitives for any component whose
 * body is a {@link RoundedRectangleVisual} — the text input field's background
 * and the standalone VoiceInputButton both drive the exact same look from here.
 *
 * The sweep modes themselves (loop / radial) and the bottom-edge scan live in
 * BaseTextInputComponent; this module owns the "hold" look (ramp gray -> static
 * color -> hold) and its finish pulse, plus the stateless gradient builders the
 * field reuses so the math has a single source of truth.
 */

// "loop": colors cycle along a fixed gradient axis.
// "hold": ramp to a static gradient and hold it.
// "radial": a Radial gradient whose center orbits the field over time (the glow
//           moves), using colors[0] at the center and colors[last] at the edge.
export type AsrVisualSweepMode = "loop" | "hold" | "radial"

// loop reads 3 colors; hold reads 4; radial reads center=colors[0], edge=colors[last].
// Require at least 3 (the loop minimum).
export type AsrVisualSweepColors = readonly [vec4, vec4, vec4, ...vec4[]]

export type AsrVisualSweepPalette = {
  start: vec2
  end: vec2
  stopPercents?: readonly number[]
  background: AsrVisualSweepColors
  border: AsrVisualSweepColors
}

export type AsrVisualSweepGradients = {
  background: GradientParameters
  border: GradientParameters
}

export const ASR_HOLD_STOP_PERCENTS = [0, 0.43, 0.66, 1] as const

// "hold" finish (matching TextInput_bg 5 / TextInputBehavior.ts): on final, the
// color bounces full -> gray -> full (revealing the message at the gray midpoint),
// then dims full -> gray.
export const ASR_FINISH_BOUNCE_DURATION = 1.3
export const ASR_FINISH_DIM_DURATION = 0.5

// Voice-input background: the static 4-stop linear gradient from the DS3.0
// "TextInput_bg 5" material (violet -> blue -> teal -> dark teal at 0/0.43/0.66/1
// along a ~170deg axis). Shown in "hold" mode (ramp in, hold, ramp out). Shared
// by TextInputField and the standalone VoiceInputButton so they match exactly.
export const TEXT_INPUT_FIELD_DS3_ASR_SWEEP_PALETTE: AsrVisualSweepPalette = {
  start: new vec2(1, -0.18),
  end: new vec2(-1, 0.18),
  stopPercents: [0, 0.43, 0.66, 1],
  background: [
    TextInputFieldVoiceSweepViolet,
    TextInputFieldVoiceSweepBlue,
    TextInputFieldVoiceSweepTeal,
    TextInputFieldVoiceSweepDarkTeal
  ],
  border: [
    TextInputFieldVoiceSweepViolet,
    TextInputFieldVoiceSweepBlue,
    TextInputFieldVoiceSweepTeal,
    TextInputFieldVoiceSweepDarkTeal
  ]
}

/**
 * Build a static (non-animated) gradient from a palette's color list at the
 * given stop percents. Used by both the hold ramp-in target and the finish
 * sequence.
 */
export function buildAsrStaticGradient(
  palette: AsrVisualSweepPalette,
  colors: AsrVisualSweepColors,
  stopPercents: readonly number[]
): GradientParameters {
  const stop3Color = colors[3] ?? colors[colors.length - 1]
  return {
    enabled: true,
    type: "Linear",
    start: palette.start,
    end: palette.end,
    stop0: {enabled: true, percent: stopPercents[0], color: colors[0]},
    stop1: {enabled: true, percent: stopPercents[1], color: colors[1]},
    stop2: {enabled: true, percent: stopPercents[2], color: colors[2]},
    stop3: {enabled: true, percent: stopPercents[3], color: stop3Color}
  }
}

/** The "hold" target: a static colored 4-stop gradient for background + border. */
export function buildAsrHoldGradients(palette: AsrVisualSweepPalette): AsrVisualSweepGradients {
  const stopPercents = palette.stopPercents ?? ASR_HOLD_STOP_PERCENTS
  return {
    background: buildAsrStaticGradient(palette, palette.background, stopPercents),
    border: buildAsrStaticGradient(palette, palette.border, stopPercents)
  }
}

/**
 * Copy a gradient's stop topology but force every stop to a single color, so a
 * color<->gray blend fades all stops uniformly (no per-stop alpha lag).
 */
export function gradientWithUniformColor(template: GradientParameters, color: vec4 | undefined): GradientParameters {
  const grayStop = (stop?: GradientStop): GradientStop | undefined =>
    stop === undefined ? undefined : {enabled: stop.enabled, percent: stop.percent, color: color ?? stop.color}
  return {
    enabled: template.enabled,
    type: template.type,
    start: template.start,
    end: template.end,
    stop0: grayStop(template.stop0),
    stop1: grayStop(template.stop1),
    stop2: grayStop(template.stop2),
    stop3: grayStop(template.stop3),
    stop4: grayStop(template.stop4)
  }
}

/** The visual's current per-state gradients (the "gray" the voice look returns to). */
export function stateGradientsFor(visual: RoundedRectangleVisual, stateName: StateName): AsrVisualSweepGradients {
  // Keep error mappings aligned with RoundedRectangleVisual.updateVisualStates().
  switch (stateName) {
    case StateName.hovered:
    case StateName.errorHovered:
      return {background: visual.hoveredGradient, border: visual.borderHoveredGradient}
    case StateName.triggered:
      return {background: visual.triggeredGradient, border: visual.borderTriggeredGradient}
    case StateName.inactive:
      return {background: visual.inactiveGradient, border: visual.borderInactiveGradient}
    case StateName.toggledDefault:
      return {background: visual.toggledDefaultGradient, border: visual.borderToggledDefaultGradient}
    case StateName.toggledHovered:
      return {background: visual.toggledHoveredGradient, border: visual.borderToggledHoveredGradient}
    case StateName.toggledTriggered:
      return {background: visual.toggledTriggeredGradient, border: visual.borderToggledTriggeredGradient}
    case StateName.error:
    case StateName.default:
    default:
      return {background: visual.defaultGradient, border: visual.borderDefaultGradient}
  }
}

/**
 * Gray gradients matching the color gradients' stop topology, every stop set to
 * the current idle background/border color, so a color<->gray blend fades
 * uniformly and ends at the same gray the visual restores to on state refresh.
 */
export function grayGradientsForState(
  colorGradients: AsrVisualSweepGradients,
  stateGradients: AsrVisualSweepGradients | null
): AsrVisualSweepGradients {
  const bgGray = stateGradients?.background.stop0?.color ?? stateGradients?.background.stop1?.color
  const borderGray = stateGradients?.border.stop0?.color ?? bgGray
  return {
    background: gradientWithUniformColor(colorGradients.background, bgGray),
    border: gradientWithUniformColor(colorGradients.border, borderGray ?? bgGray)
  }
}

/**
 * Drives the "hold" voice look + finish pulse on a single RoundedRectangleVisual.
 * Stateless gradient math is shared with the text input field (see the builders
 * above); this class owns only the per-target animation state, so a component
 * just constructs one with accessors for its visual / palette / current state.
 *
 * - {@link start}: ramp gray -> static color and hold (listening begins).
 * - {@link stop}: ramp color -> gray (listening cancelled, no final transcript).
 * - {@link runFinish}: on the final transcript, bounce color -> gray -> color
 *   (revealing at the gray midpoint), then dim color -> gray.
 */
export class AsrHoldAnimator {
  private readonly cancelSet = new CancelSet()
  private currentBackground: GradientParameters | null = null
  private currentBorder: GradientParameters | null = null
  private _active = false
  private rampingOut = false
  private finishing = false

  public constructor(
    private readonly getVisual: () => RoundedRectangleVisual | null,
    private readonly getPalette: () => AsrVisualSweepPalette,
    private readonly getStateName: () => StateName,
    // When true, this animator never touches the BORDER channel — neither
    // per-frame gradient writes nor the terminal state refresh (which runs
    // base-only via preserveBorderOverride). The host owns the border (e.g.
    // VoiceInputButton's listening border light) and performs its own full
    // refresh when it finishes. Default false preserves original behavior.
    private readonly skipBorder: boolean = false
  ) {}

  /** True while the colored hold is ramping in or holding (listening). */
  public get isActive(): boolean {
    return this._active
  }

  /** Ramp from the idle gray state up to the static colored hold. */
  public start(): void {
    const visual = this.getVisual()
    if (!visual) return
    this.cancelSet.cancel()
    this.rampingOut = false
    this.finishing = false
    this._active = true
    const color = buildAsrHoldGradients(this.getPalette())
    const gray = grayGradientsForState(color, stateGradientsFor(visual, this.getStateName()))
    this.crossfade(
      visual,
      this.currentBackground ?? gray.background,
      this.currentBorder ?? gray.border,
      color.background,
      color.border
    )
  }

  /** Ramp the colored hold back down to the idle gray state (cancel / non-final stop). */
  public stop(): void {
    // A finish pulse or an in-flight ramp-out owns the return to gray; don't
    // interrupt it (voice end can fire stop twice: final transcript, then toggle-off).
    if (this.finishing || this.rampingOut) return
    if (!this._active) return
    this._active = false
    const visual = this.getVisual()
    if (!visual) {
      this.currentBackground = null
      this.currentBorder = null
      return
    }
    this.cancelSet.cancel()
    this.rampingOut = true
    const color = buildAsrHoldGradients(this.getPalette())
    const gray = grayGradientsForState(color, stateGradientsFor(visual, this.getStateName()))
    this.crossfade(
      visual,
      this.currentBackground ?? color.background,
      this.currentBorder ?? color.border,
      gray.background,
      gray.border,
      () => {
        this.rampingOut = false
        this.currentBackground = null
        this.currentBorder = null
        visual.refreshRoundedRectangleState(this.skipBorder)
      }
    )
  }

  /**
   * Final-result finish: bounce color -> gray -> color over the bounce duration
   * (invoking `reveal` at the gray midpoint), then dim color -> gray.
   *
   * CURRENTLY UNUSED: VoiceInputButton dropped its finish pulse (visdev
   * decision — the body just ramps to grey while the border light fades).
   * Retained because the text field's finish path is the same choreography
   * and folding the field onto this animator is a planned follow-up; delete
   * if that plan is abandoned.
   */
  public runFinish(reveal: () => void): void {
    const visual = this.getVisual()
    if (!visual) {
      reveal()
      this.hardReset(null)
      return
    }
    this.cancelSet.cancel()
    this._active = false
    this.rampingOut = true
    this.finishing = true
    const color = buildAsrHoldGradients(this.getPalette())
    const gray = grayGradientsForState(color, stateGradientsFor(visual, this.getStateName()))
    let revealed = false
    const doReveal = (): void => {
      if (!revealed) {
        revealed = true
        reveal()
      }
    }
    // Anchor at full color before the bounce (a fast final can arrive before
    // the hold ramp-in finished, so the first frame must not jump).
    this.applyColorAmount(visual, gray, color, 1)
    animate({
      cancelSet: this.cancelSet,
      duration: ASR_FINISH_BOUNCE_DURATION,
      easing: "ease-in-out-cubic",
      update: (t) => {
        this.applyColorAmount(visual, gray, color, 1 - Math.sin(t * Math.PI))
        if (t >= 0.5) doReveal()
      },
      ended: () => {
        doReveal()
        animate({
          cancelSet: this.cancelSet,
          duration: ASR_FINISH_DIM_DURATION,
          easing: "ease-out-cubic",
          update: (t) => this.applyColorAmount(visual, gray, color, 1 - t),
          ended: () => {
            this.finishing = false
            this.rampingOut = false
            this.currentBackground = null
            this.currentBorder = null
            visual.refreshRoundedRectangleState(this.skipBorder)
          }
        })
      }
    })
  }

  /** Cancel any in-flight animation and snap back to the visual's state (release/destroy). */
  public cancel(): void {
    this.hardReset(this.getVisual())
  }

  private hardReset(visual: RoundedRectangleVisual | null): void {
    this.cancelSet.cancel()
    this._active = false
    this.rampingOut = false
    this.finishing = false
    this.currentBackground = null
    this.currentBorder = null
    visual?.refreshRoundedRectangleState(this.skipBorder)
  }

  private crossfade(
    visual: RoundedRectangleVisual,
    fromBackground: GradientParameters,
    fromBorder: GradientParameters,
    toBackground: GradientParameters,
    toBorder: GradientParameters,
    ended?: () => void
  ): void {
    animate({
      cancelSet: this.cancelSet,
      duration: STATE_ANIMATION_DURATION,
      update: (t) => {
        const background = GradientParameters.lerp(fromBackground, toBackground, t)
        const border = GradientParameters.lerp(fromBorder, toBorder, t)
        this.currentBackground = background
        this.currentBorder = border
        visual.applyBaseGradientNow(background)
        if (!this.skipBorder) visual.applyBorderGradientNow(border)
      },
      ended: () => {
        this.currentBackground = toBackground
        this.currentBorder = toBorder
        visual.applyBaseGradientNow(toBackground)
        if (!this.skipBorder) visual.applyBorderGradientNow(toBorder)
        ended?.()
      }
    })
  }

  // Blend between gray and color (same stop topology). amount: 1 = color, 0 = gray.
  private applyColorAmount(
    visual: RoundedRectangleVisual,
    grayGradients: AsrVisualSweepGradients,
    colorGradients: AsrVisualSweepGradients,
    amount: number
  ): void {
    const background = GradientParameters.lerp(grayGradients.background, colorGradients.background, amount)
    const border = GradientParameters.lerp(grayGradients.border, colorGradients.border, amount)
    this.currentBackground = background
    this.currentBorder = border
    visual.applyBaseGradientNow(background)
    if (!this.skipBorder) visual.applyBorderGradientNow(border)
  }
}

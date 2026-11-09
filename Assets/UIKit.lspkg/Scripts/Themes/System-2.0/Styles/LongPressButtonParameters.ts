import {FILL_AXIS_END, FILL_AXIS_START} from "../../../Components/Button/LongPressFillGradient"
import {GradientParameters} from "../../../Visuals/RoundedRectangle/RoundedRectangle"
import {Style} from "../../Style"
import {LongPressButtonComponentDataType} from "../../System-3.0/Styles/LongPressButtonParameters"
import {BrightYellow, DarkerGray, DarkerYellow, DarkestYellow, DarkGray, MediumYellow} from "../Colors"
import {System2Styles} from "../System2"

/**
 * `LongPressButton` theme data for System 2.0.
 *
 * The component's design reference is DS 3.0 only; this exists so an instance
 * pinned to the older theme reads correctly — a yellow-accent wipe over the
 * classic dark track — rather than showing DS3 teal inside a System2 button, or
 * going unstyled (a missing component key in `styles` has no fallback).
 *
 * Same shape as the 3.0 entry: idle tone, darker track on hover, fill while
 * holding. The outline tracks the FILL rather than the state, so no state here
 * authors `borderSize` except `default`. The hold timings are shared with 3.0
 * deliberately — how long you must hold is an interaction contract, not a visual
 * style.
 *
 * The no-pop invariant from the 3.0 file applies here too: `trackColor` must
 * equal the hovered/triggered background, and `fillPalette` must equal the
 * toggled background.
 */

// The wipe's own axis, imported rather than re-declared so the two cannot drift.
// See FILL_AXIS_START for why a mismatch pops instead of easing.
const AXIS_START = FILL_AXIS_START
const AXIS_END = FILL_AXIS_END

function flat(color: vec4): GradientParameters {
  return {
    type: "Linear",
    start: AXIS_START,
    end: AXIS_END,
    stop0: {enabled: true, percent: 0, color},
    stop1: {enabled: true, percent: 0.5, color},
    stop2: {enabled: true, percent: 1, color}
  }
}

/** Recessed tone a hovered or filling button sits on. Darker than the idle gray. */
const TRACK_COLOR = DarkerGray
const TRACK_GRADIENT = flat(TRACK_COLOR)

const IDLE_GRADIENT = flat(DarkGray)

/** Border width while holding and once completed; 0 in every other state. */
const BORDER_SIZE = 0.1

/** Palette the hold reveals, and the completed background. */
const FILL_PALETTE: GradientParameters = {
  type: "Linear",
  start: AXIS_START,
  end: AXIS_END,
  stop0: {enabled: true, percent: 0, color: DarkestYellow},
  stop1: {enabled: true, percent: 0.5, color: DarkerYellow},
  stop2: {enabled: true, percent: 1, color: MediumYellow}
}

/**
 * The outline colour — one gradient for every state, same reasoning as the 3.0
 * file's `HOLD_BORDER`: a second, brighter "completed" colour would crossfade at
 * the moment of completion and read as the outline dropping out. Bright enough to
 * carry against the full yellow fill, which also covers the dark track.
 */
const HOLD_BORDER: GradientParameters = {
  type: "Linear",
  start: new vec2(-1, 0.8),
  end: new vec2(1, -0.8),
  stop0: {enabled: true, percent: 0, color: BrightYellow},
  stop1: {enabled: true, percent: 1, color: MediumYellow}
}

export const LongPressButtonComponentData: LongPressButtonComponentDataType = {
  fillPalette: FILL_PALETTE,
  trackColor: TRACK_COLOR,
  edgeSoftness: 0.005,
  holdSeconds: 1.0,
  drainSeconds: 0.25,
  holdBorderSize: BORDER_SIZE
}

export const LongPressButtonParameters: Partial<Record<System2Styles, Style>> = {
  PrimaryNeutral: {
    default: {
      baseType: "Gradient",
      baseGradient: IDLE_GRADIENT,
      // Always on, same gradient in every state. The component drives
      // `borderSize` from the fill progress — see the 3.0 file's "The outline
      // follows the FILL". This is the only borderSize authored here: the
      // starting value.
      hasBorder: true,
      borderType: "Gradient",
      borderGradient: HOLD_BORDER,
      borderSize: 0,
      shouldScale: false,
      shouldPosition: true,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    hovered: {
      baseGradient: TRACK_GRADIENT,
      hasBorder: true,
      borderGradient: HOLD_BORDER,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    triggered: {
      baseGradient: TRACK_GRADIENT,
      hasBorder: true,
      borderGradient: HOLD_BORDER,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledDefault: {
      baseGradient: FILL_PALETTE,
      hasBorder: true,
      borderGradient: HOLD_BORDER,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledHovered: {
      baseGradient: FILL_PALETTE,
      hasBorder: true,
      borderGradient: HOLD_BORDER,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledTriggered: {
      baseGradient: FILL_PALETTE,
      hasBorder: true,
      borderGradient: HOLD_BORDER,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    inactive: {
      baseGradient: IDLE_GRADIENT,
      hasBorder: true,
      borderGradient: HOLD_BORDER,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    }
  }
}

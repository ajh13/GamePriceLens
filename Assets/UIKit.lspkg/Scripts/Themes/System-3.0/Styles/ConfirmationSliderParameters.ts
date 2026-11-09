// @module System-3.0/Styles/ConfirmationSliderParameters — DO NOT REMOVE: prevents Lens Studio module collision
import {GradientParameters} from "../../../Visuals/RoundedRectangle/RoundedRectangle"
import {RoundedRectangleVisualParameters} from "../../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {Style} from "../../Style"
import {
  TextInputFieldVoiceSweepBlue,
  TextInputFieldVoiceSweepDarkTeal,
  TextInputFieldVoiceSweepTeal,
  TextInputFieldVoiceSweepViolet
} from "../Colors"
import {PrimaryNeutralGradients} from "../Gradients/PrimaryNeutralGradients"
import {PRISM_ACTIVE_COLORS, PRISM_HOVER_COLORS, PRISM_IDLE_COLORS, PrismStateColors} from "../Gradients/PrismPalette"

// Progress-driven track fill: the TextInputField voice-sweep palette laid
// horizontally (the fill child is left-anchored and grows with drag
// progress, so the axis runs along the track rather than the ~170° full-face
// sweep the text field uses). The stops are written once at setup; drag
// progress only drives the fill's opacity (see `fillOpacity`), so the RGB
// ramp never has to be recomputed per frame.
const FILL_SWEEP_GRADIENT: GradientParameters = {
  type: "Linear",
  start: new vec2(-1, 0),
  end: new vec2(1, 0),
  stop0: {percent: 0, color: TextInputFieldVoiceSweepViolet, enabled: true},
  stop1: {percent: 0.43, color: TextInputFieldVoiceSweepBlue, enabled: true},
  stop2: {percent: 0.66, color: TextInputFieldVoiceSweepTeal, enabled: true},
  stop3: {percent: 1, color: TextInputFieldVoiceSweepDarkTeal, enabled: true}
}

export const ConfirmationSliderComponentData = {
  fillGradient: FILL_SWEEP_GRADIENT,
  // Fill opacity lerped by drag progress: `idle` is the faint hint peeking
  // out around the knob at rest, `full` the completed look. A single
  // opacityFactor write per frame instead of a whole gradient rebuild.
  fillOpacity: {
    idle: 0.4,
    full: 1
  },
  knob: {
    knobVisible: true
  }
}

// Grabbed knob face: the active prism palette with the master (face/side)
// stops darkened — the mockup's grabbed state reads as a large dark-faced
// prism, not the bright press look buttons use. Alpha channels pass through
// untouched (master alphas are shader gates, not color; see PrismPalette).
function darkenStop(color: vec4, factor: number): vec4 {
  return new vec4(color.x * factor, color.y * factor, color.z * factor, color.w)
}

const GRAB_FACE_DARKEN = 0.6
const GRAB_ACCENT_DARKEN = 0.75

const CONFIRMATION_GRAB_COLORS: PrismStateColors = {
  master0: darkenStop(PRISM_ACTIVE_COLORS.master0, GRAB_FACE_DARKEN),
  master1: darkenStop(PRISM_ACTIVE_COLORS.master1, GRAB_FACE_DARKEN),
  master2: darkenStop(PRISM_ACTIVE_COLORS.master2, GRAB_FACE_DARKEN),
  accent0: darkenStop(PRISM_ACTIVE_COLORS.accent0, GRAB_ACCENT_DARKEN),
  accent1: darkenStop(PRISM_ACTIVE_COLORS.accent1, GRAB_ACCENT_DARKEN),
  accent2: darkenStop(PRISM_ACTIVE_COLORS.accent2, GRAB_ACCENT_DARKEN),
  accent3: darkenStop(PRISM_ACTIVE_COLORS.accent3, GRAB_ACCENT_DARKEN)
}

// Prism knob states, mirroring SwitchKnobPrismParameters' shape.
// shouldScale / shouldPosition are false so the visual's state machine
// never touches the knob transform — Slider drives the knob's localPosition
// every frame. cornerRadius is intentionally omitted — ConfirmationSlider
// sets it to `size.y * cornerRadiusFactor` (matching the track formula) so
// knob and track silhouettes stay in sync at any track size.
const SHARED_BEVEL = 0.105

const FALSE_TRANSFORM = {
  shouldScale: false,
  shouldPosition: false
}

const PrismKnobStates: Style = {
  default: {
    prismColors: PRISM_IDLE_COLORS,
    extrusion: 0,
    matcapRotation: 0,
    bevelRadius: SHARED_BEVEL,
    ...FALSE_TRANSFORM
  },
  hovered: {
    prismColors: PRISM_HOVER_COLORS,
    extrusion: 0.3,
    matcapRotation: 0,
    ...FALSE_TRANSFORM
  },
  triggered: {
    prismColors: CONFIRMATION_GRAB_COLORS,
    extrusion: 0.1,
    matcapRotation: -100,
    ...FALSE_TRANSFORM
  },
  toggledDefault: {
    // Completed: the knob fades out while resting at the end of the track.
    prismColors: PRISM_HOVER_COLORS,
    extrusion: 0,
    matcapRotation: -60,
    ...FALSE_TRANSFORM
  },
  toggledHovered: {
    prismColors: PRISM_HOVER_COLORS,
    extrusion: 0.3,
    matcapRotation: -60,
    ...FALSE_TRANSFORM
  },
  toggledTriggered: {
    prismColors: CONFIRMATION_GRAB_COLORS,
    extrusion: 0.1,
    matcapRotation: -150,
    ...FALSE_TRANSFORM
  },
  inactive: {
    prismColors: PRISM_IDLE_COLORS,
    extrusion: 0,
    matcapRotation: 0,
    ...FALSE_TRANSFORM
  }
}

export const ConfirmationSliderParameters: {
  track: Record<string, Partial<RoundedRectangleVisualParameters>>
  knob: Record<string, Style>
} = {
  track: {
    default: {
      default: {
        baseType: "Gradient",
        baseGradient: PrimaryNeutralGradients.idleBackground,
        hasBorder: false
      }
    }
  },
  knob: {
    default: PrismKnobStates
  }
}

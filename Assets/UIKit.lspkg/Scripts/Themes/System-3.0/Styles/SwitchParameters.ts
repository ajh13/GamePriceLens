// @module System-3.0/Styles/SwitchParameters — DO NOT REMOVE: prevents Lens Studio module collision
import {GradientParameters} from "../../../Visuals/RoundedRectangle/RoundedRectangle"
import {
  RoundedRectangleVisualParameters,
  RoundedRectangleVisualState
} from "../../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {
  GhostHoverGray,
  GhostPressedGray,
  SwitchDimBlue,
  SwitchDimPurpleBlue,
  SwitchDimTeal,
  SwitchFlatHoverBackground,
  SwitchFlatTrackGray,
  SwitchFloatBorderGray,
  SwitchFloatBorderTeal,
  UIlevel0,
  WarmLightGray
} from "../Colors"
import {GhostGradients} from "../Gradients/GhostGradients"
import {PrimaryGradients} from "../Gradients/PrimaryGradients"
import {SecondaryGradients} from "../Gradients/SecondaryGradients"

export type SwitchStyle = "Flat" | "Prism" | "PrismWide" | "PrismSquare"

// Knob sizing strategy keyed by style. `Wide` produces a half-track-wide
// rectangular knob (PrismWide); `Square` forces a square knob (PrismSquare).
// Styles missing from the map leave Slider's default sizing in place
// (square pill at track height) — Flat and Prism use this.
export enum SwitchKnobAspect {
  Wide = "wide",
  Square = "square"
}

export const SwitchComponentData = {
  cornerRadiusFactor: {
    Flat: 0.5,
    Prism: 0.5,
    PrismWide: 0.2,
    PrismSquare: 0.2
  } as Record<SwitchStyle, number>
}

export const SwitchKnobComponentData = {
  knobVisible: {
    Flat: true,
    Prism: true,
    PrismWide: true,
    PrismSquare: true
  } as Record<SwitchStyle, boolean>,
  knobAspect: {
    PrismWide: SwitchKnobAspect.Wide,
    PrismSquare: SwitchKnobAspect.Square
  } as Partial<Record<SwitchStyle, SwitchKnobAspect>>
}

// Hover knob base = the hovered TRACK colour (SwitchFlatHoverBackground), so
// the knob keeps blending into the track on hover and toggledHover instead of
// showing its own fill (same gradient form as the idle one, hover tone).
const FlatKnobHoverTrackGradient: GradientParameters = {
  type: "Linear",
  start: new vec2(-1, 0.2),
  end: new vec2(1, -0.2),
  stop0: {enabled: true, color: SwitchFlatHoverBackground, percent: 0},
  stop1: {enabled: true, color: SwitchFlatHoverBackground, percent: 0.5},
  stop2: {enabled: true, color: SwitchFlatHoverBackground, percent: 1}
}

// Idle knob base = the track colour (SwitchFlatTrackGray), so the resting knob
// reads as the same grey as the track and only its border distinguishes it.
// Kept as a gradient (not a flat Color) so the idle→hover state still tweens
// rather than snapping (a Color↔Gradient baseType switch can't animate).
const FlatKnobIdleTrackGradient: GradientParameters = {
  type: "Linear",
  start: new vec2(-1, 0.2),
  end: new vec2(1, -0.2),
  stop0: {enabled: true, color: SwitchFlatTrackGray, percent: 0},
  stop1: {enabled: true, color: SwitchFlatTrackGray, percent: 0.5},
  stop2: {enabled: true, color: SwitchFlatTrackGray, percent: 1}
}

const SwitchWarmGrayBorderGradient: GradientParameters = {
  type: "Linear",
  start: new vec2(-1, 0.2),
  end: new vec2(1, -0.2),
  stop0: {enabled: true, color: WarmLightGray, percent: 0},
  stop1: {enabled: true, color: WarmLightGray, percent: 0.5},
  stop2: {enabled: true, color: WarmLightGray, percent: 1}
}

const FlatTrackHovered: RoundedRectangleVisualState = {
  baseType: "Color",
  baseColor: SwitchFlatHoverBackground,
  hasBorder: true,
  borderSize: 0.2,
  borderType: "Gradient",
  borderGradient: SecondaryGradients.hoverBorder
}

const FlatKnobHovered: RoundedRectangleVisualState = {
  baseType: "Gradient",
  baseGradient: FlatKnobHoverTrackGradient,
  hasBorder: true,
  borderSize: 0.2,
  borderType: "Gradient",
  borderGradient: SecondaryGradients.hoverBorder
}

const FlatKnobPressedBaseGradient: GradientParameters = {
  type: "Linear",
  start: new vec2(-1, 0.2),
  end: new vec2(1, -0.2),
  stop0: {enabled: true, color: SwitchDimPurpleBlue, percent: 0},
  stop1: {enabled: true, color: SwitchDimBlue, percent: 0.5},
  stop2: {enabled: true, color: SwitchDimTeal, percent: 1}
}

const FlatFillPressed: RoundedRectangleVisualState = {
  baseType: "Gradient",
  baseGradient: GhostGradients.idleBackground
}

const PrismPillTrackPressed: RoundedRectangleVisualState = {
  baseType: "Color",
  // Was SwitchNeutralDarkGray17 (#2B2B2B) — design feedback: track backgrounds
  // must use the UIlevel0 (#2F3231) surface color.
  baseColor: UIlevel0,
  hasBorder: true,
  borderSize: 0.2,
  borderType: "Color",
  borderColor: SwitchFloatBorderTeal
}

// Pill-prism track (capsule, transparent base with a thin border). Used by the
// Prism style; PrismWide / PrismSquare use the rectangular track below.
const PrismPillTrackParameters: Partial<RoundedRectangleVisualParameters> = {
  default: {
    baseType: "Color",
    // Was SwitchNeutralDarkGray15 (#262626) — track backgrounds use UIlevel0.
    baseColor: UIlevel0,
    hasBorder: true,
    borderSize: 0.2,
    borderType: "Color",
    borderColor: SwitchFloatBorderGray
  },
  hovered: {
    baseType: "Color",
    baseColor: SwitchFlatTrackGray,
    hasBorder: true,
    borderSize: 0.2,
    borderType: "Color",
    borderColor: SwitchFloatBorderGray
  },
  triggered: PrismPillTrackPressed,
  toggledDefault: {
    baseType: "Color",
    // Was SwitchNeutralDarkGray17 (#2B2B2B) — see PrismPillTrackPressed note.
    baseColor: UIlevel0,
    hasBorder: true,
    borderSize: 0.2,
    borderType: "Color",
    borderColor: SwitchFloatBorderGray
  },
  toggledHovered: {
    baseType: "Color",
    baseColor: SwitchFlatTrackGray,
    hasBorder: true,
    borderSize: 0.2,
    borderType: "Color",
    borderColor: SwitchFloatBorderGray
  },
  toggledTriggered: PrismPillTrackPressed
}

// Rectangular-prism track: per-state gray variation matching the PrismWide /
// PrismSquare reference. Inactive half visibly brightens on hover and darkens
// on press.
const PrismRectTrackParameters: Partial<RoundedRectangleVisualParameters> = {
  default: {
    baseType: "Color",
    // Was InactivePrimary — track backgrounds use UIlevel0.
    baseColor: UIlevel0,
    hasBorder: false,
    borderSize: 0
  },
  hovered: {
    baseType: "Color",
    baseColor: GhostHoverGray,
    hasBorder: false,
    borderSize: 0
  },
  triggered: {
    baseType: "Color",
    baseColor: GhostPressedGray,
    hasBorder: false,
    borderSize: 0
  },
  toggledDefault: {
    baseType: "Color",
    // Was InactivePrimary — track backgrounds use UIlevel0.
    baseColor: UIlevel0,
    hasBorder: false,
    borderSize: 0
  },
  toggledHovered: {
    baseType: "Color",
    baseColor: GhostHoverGray,
    hasBorder: false,
    borderSize: 0
  },
  toggledTriggered: {
    baseType: "Color",
    baseColor: GhostPressedGray,
    hasBorder: false,
    borderSize: 0
  }
}

export const SwitchParameters: {
  track: Record<SwitchStyle, Partial<RoundedRectangleVisualParameters>>
  knob: Partial<Record<SwitchStyle, Partial<RoundedRectangleVisualParameters>>>
  fill: Partial<Record<SwitchStyle, Partial<RoundedRectangleVisualParameters>>>
} = {
  track: {
    Flat: {
      default: {
        baseType: "Color",
        baseColor: SwitchFlatTrackGray,
        hasBorder: true,
        borderSize: 0.2,
        borderType: "Gradient",
        borderGradient: SwitchWarmGrayBorderGradient
      },
      hovered: FlatTrackHovered,
      triggered: {
        baseType: "Color",
        baseColor: SwitchFlatTrackGray,
        hasBorder: true,
        borderSize: 0.2,
        borderType: "Gradient",
        borderGradient: SwitchWarmGrayBorderGradient
      },
      toggledDefault: {
        baseType: "Color",
        baseColor: SwitchFlatTrackGray,
        hasBorder: true,
        borderSize: 0.2,
        borderType: "Gradient",
        borderGradient: SwitchWarmGrayBorderGradient
      },
      toggledHovered: FlatTrackHovered,
      toggledTriggered: {
        baseType: "Color",
        baseColor: SwitchFlatTrackGray,
        hasBorder: true,
        borderSize: 0.2,
        borderType: "Gradient",
        borderGradient: SwitchWarmGrayBorderGradient
      }
    },
    Prism: PrismPillTrackParameters,
    PrismWide: PrismRectTrackParameters,
    PrismSquare: PrismRectTrackParameters
  },
  knob: {
    Flat: {
      default: {
        baseType: "Gradient",
        baseGradient: FlatKnobIdleTrackGradient,
        hasBorder: true,
        borderSize: 0.2,
        borderType: "Gradient",
        borderGradient: SwitchWarmGrayBorderGradient
      },
      hovered: FlatKnobHovered,
      triggered: {
        baseType: "Gradient",
        baseGradient: FlatKnobPressedBaseGradient,
        hasBorder: true,
        borderSize: 0.2,
        borderType: "Gradient",
        borderGradient: SecondaryGradients.pressedBorder
      },
      toggledDefault: {
        baseType: "Gradient",
        baseGradient: PrimaryGradients.hoverBackground,
        hasBorder: true,
        borderSize: 0.2,
        borderType: "Gradient",
        borderGradient: SecondaryGradients.selectedBorder
      },
      toggledHovered: {
        baseType: "Gradient",
        baseGradient: FlatKnobHoverTrackGradient,
        hasBorder: true,
        borderSize: 0.2,
        borderType: "Gradient",
        borderGradient: SecondaryGradients.selectedBorder
      },
      toggledTriggered: {
        baseType: "Gradient",
        baseGradient: FlatKnobPressedBaseGradient,
        hasBorder: true,
        borderSize: 0.2,
        borderType: "Gradient",
        borderGradient: SecondaryGradients.pressedBorder
      }
    }
  },
  fill: {
    Flat: {
      default: {baseType: "Gradient", baseGradient: GhostGradients.idleBackground},
      hovered: {baseType: "Gradient", baseGradient: GhostGradients.idleBackground},
      triggered: FlatFillPressed,
      toggledDefault: {baseType: "Gradient", baseGradient: GhostGradients.idleBackground},
      toggledHovered: {baseType: "Gradient", baseGradient: GhostGradients.idleBackground},
      toggledTriggered: FlatFillPressed
    }
  }
}

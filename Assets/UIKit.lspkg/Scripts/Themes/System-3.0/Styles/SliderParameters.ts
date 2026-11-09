// @module System-3.0/Styles/SliderParameters — DO NOT REMOVE: prevents Lens Studio module collision
import {GradientParameters} from "../../../Visuals/RoundedRectangle/RoundedRectangle"
import {RoundedRectangleVisualParameters} from "../../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {
  SliderFillIdle,
  SliderHoverFillCyan,
  SliderHoverFillGrayBlue,
  SliderHoverFillPurple,
  SwitchFlatTrackGray
} from "../Colors"
import {GhostGradients} from "../Gradients/GhostGradients"

export const SliderGradients: Record<string, GradientParameters> = {
  // Solid-looking idle fill expressed as a gradient (all stops the same
  // colour) so the fill stays baseType "Gradient" across states. That lets
  // idle→hover tween smoothly instead of snapping — a Color→Gradient baseType
  // switch can't animate, which is why the fill was jumping instantly.
  idleFill: {
    type: "Linear",
    start: new vec2(-1, 0.1),
    end: new vec2(1, -0.1),
    stop0: {percent: 0, color: SliderFillIdle},
    stop1: {percent: 0.5, color: SliderFillIdle},
    stop2: {percent: 1, color: SliderFillIdle}
  },
  hoverBackground: {
    type: "Linear",
    start: new vec2(-1, 0.1),
    end: new vec2(1, -0.1),
    stop0: {
      percent: 0,
      color: SliderHoverFillPurple
    },
    stop1: {
      percent: 0.31,
      color: SliderHoverFillGrayBlue
    },
    stop2: {
      percent: 1,
      color: SliderHoverFillCyan
    }
  }
}

export const SliderComponentData = {
  cornerRadiusFactor: 0.1667,
  knob: {
    knobVisible: false
  }
}

export const SliderParameters: {
  track: Record<string, Partial<RoundedRectangleVisualParameters>>
  knob: Record<string, Partial<RoundedRectangleVisualParameters>>
  fill: Record<string, Partial<RoundedRectangleVisualParameters>>
} = {
  track: {
    default: {
      // Static track background. Reuses SwitchFlatTrackGray (the same colour
      // the flat switch track uses) — now UIlevel0 #2F3231 per design
      // feedback. The track stays constant across states — the fill carries
      // the interaction colour.
      default: {
        baseType: "Color",
        baseColor: SwitchFlatTrackGray,
        hasBorder: false
      }
    }
  },
  knob: {
    default: {
      default: {
        baseType: "Gradient",
        baseGradient: GhostGradients.idleBackground,
        hasBorder: false
      }
    }
  },
  fill: {
    default: {
      default: {
        baseType: "Gradient",
        baseGradient: SliderGradients.idleFill,
        hasBorder: false
      },
      hovered: {
        baseType: "Gradient",
        baseGradient: SliderGradients.hoverBackground
      },
      triggered: {
        baseType: "Gradient",
        baseGradient: SliderGradients.hoverBackground
      }
    }
  }
}

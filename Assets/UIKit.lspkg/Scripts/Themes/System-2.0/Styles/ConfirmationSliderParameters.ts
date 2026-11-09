import {RoundedRectangleVisualParameters} from "../../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {
  ConfirmationSliderFillDarkYellow,
  ConfirmationSliderFillLightGray,
  ConfirmationSliderFillMediumYellow,
  ConfirmationSliderKnobBorderBottom,
  ConfirmationSliderKnobBorderTop,
  ConfirmationSliderKnobBright,
  ConfirmationSliderKnobDark,
  ConfirmationSliderKnobHoverBorderBottom,
  ConfirmationSliderKnobHoverBorderTop,
  ConfirmationSliderKnobHoverBright,
  ConfirmationSliderKnobHoverDark,
  ConfirmationSliderKnobTriggeredBorderMid,
  ConfirmationSliderKnobTriggeredBorderYellow,
  ConfirmationSliderKnobTriggeredBright,
  ConfirmationSliderKnobTriggeredDark,
  ConfirmationSliderShineColor,
  ConfirmationSliderTrackBorderGray,
  ConfirmationSliderTrackBorderLight,
  ConfirmationSliderTrackBorderTransparent,
  ConfirmationSliderTrackDarkGray,
  ConfirmationSliderTrackGray
} from "../Colors"

export const ConfirmationSliderComponentData = {
  fill: {
    stop0Color0: ConfirmationSliderFillLightGray,
    stop0Color1: ConfirmationSliderFillDarkYellow,
    stop1Color0: ConfirmationSliderFillMediumYellow,
    stop1Color1: ConfirmationSliderFillMediumYellow
  } as Record<string, vec4>,
  shineColor: ConfirmationSliderShineColor,
  knob: {
    knobVisible: true
  }
}

export const ConfirmationSliderParameters: {
  track: Record<string, Partial<RoundedRectangleVisualParameters>>
  knob: Record<string, Partial<RoundedRectangleVisualParameters>>
} = {
  track: {
    default: {
      default: {
        baseType: "Gradient",
        baseGradient: {
          start: new vec2(0, 1),
          end: new vec2(0, -1),
          stop0: {percent: 0, color: ConfirmationSliderTrackDarkGray},
          stop1: {percent: 1, color: ConfirmationSliderTrackGray}
        },
        hasBorder: true,
        borderSize: 0.1,
        borderType: "Gradient",
        borderGradient: {
          start: new vec2(-0.9, 1),
          end: new vec2(0.9, -1),
          stop0: {percent: 0, color: ConfirmationSliderTrackBorderLight},
          stop1: {percent: 0.5, color: ConfirmationSliderTrackBorderTransparent},
          stop2: {percent: 1, color: ConfirmationSliderTrackBorderGray}
        }
      }
    }
  },
  knob: {
    default: {
      default: {
        baseType: "Gradient",
        baseGradient: {
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {percent: 0, color: ConfirmationSliderKnobDark},
          stop1: {percent: 1, color: ConfirmationSliderKnobBright}
        },
        hasBorder: true,
        borderType: "Gradient",
        borderGradient: {
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {percent: 0, color: ConfirmationSliderKnobBorderTop},
          stop1: {percent: 1, color: ConfirmationSliderKnobBorderBottom}
        }
      },
      hovered: {
        baseGradient: {
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {percent: 0, color: ConfirmationSliderKnobHoverDark},
          stop1: {percent: 1, color: ConfirmationSliderKnobHoverBright}
        },
        borderGradient: {
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {percent: 0, color: ConfirmationSliderKnobHoverBorderTop},
          stop1: {percent: 1, color: ConfirmationSliderKnobHoverBorderBottom}
        }
      },
      triggered: {
        baseGradient: {
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {percent: 0, color: ConfirmationSliderKnobTriggeredDark},
          stop1: {percent: 1, color: ConfirmationSliderKnobTriggeredBright}
        },
        borderGradient: {
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {percent: 0, color: ConfirmationSliderKnobTriggeredBorderYellow},
          stop1: {percent: 0.5, color: ConfirmationSliderKnobTriggeredBorderMid},
          stop2: {percent: 1, color: ConfirmationSliderKnobTriggeredBorderYellow}
        }
      }
    }
  }
}

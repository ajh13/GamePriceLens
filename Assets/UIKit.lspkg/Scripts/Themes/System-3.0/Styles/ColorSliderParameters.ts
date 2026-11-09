// @module System-3.0/Styles/ColorSliderParameters — DO NOT REMOVE: prevents Lens Studio module collision
import {RoundedRectangleVisualParameters} from "../../../Visuals/RoundedRectangle/RoundedRectangleVisual"

const KnobBorderTop = new vec4(0.45, 0.45, 0.45, 0.6)
const KnobBorderBottom = new vec4(0.25, 0.25, 0.25, 0.3)

export const ColorSliderComponentData = {
  knob: {
    knobVisible: true
  }
}

export const ColorSliderParameters: {
  track: Record<string, Partial<RoundedRectangleVisualParameters>>
  knob: Record<string, Partial<RoundedRectangleVisualParameters>>
} = {
  track: {
    default: {
      default: {
        baseType: "Gradient",
        baseGradient: {
          type: "Linear",
          start: new vec2(0, 0),
          end: new vec2(0, 0),
          stop0: {percent: 0, color: new vec4(0, 0, 0, 1)},
          stop1: {percent: 1, color: new vec4(0, 0, 0, 1)}
        },
        hasBorder: true,
        borderSize: 0.07,
        borderType: "Gradient",
        borderGradient: {
          type: "Linear",
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {
            percent: 0,
            color: KnobBorderTop
          },
          stop1: {
            percent: 1,
            color: KnobBorderBottom
          }
        }
      },
      hovered: {
        borderGradient: {
          type: "Linear",
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {
            percent: 0,
            color: new vec4(0.55, 0.55, 0.55, 0.7)
          },
          stop1: {
            percent: 1,
            color: new vec4(0.35, 0.35, 0.35, 0.4)
          }
        }
      },
      triggered: {
        borderGradient: {
          type: "Linear",
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {
            percent: 0,
            color: new vec4(0.6, 0.6, 0.6, 0.8)
          },
          stop1: {
            percent: 1,
            color: new vec4(0.4, 0.4, 0.4, 0.5)
          }
        }
      }
    }
  },
  knob: {
    default: {
      default: {
        // Fill color is updated at runtime from slider value; solid base avoids gradient shader cost.
        baseType: "Color",
        baseColor: new vec4(1, 0, 0, 1),
        hasBorder: true,
        borderSize: 0.07,
        borderType: "Gradient",
        borderGradient: {
          type: "Linear",
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {
            percent: 0,
            color: KnobBorderTop
          },
          stop1: {
            percent: 1,
            color: KnobBorderBottom
          }
        }
      },
      hovered: {
        baseType: "Color",
        borderGradient: {
          type: "Linear",
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {
            percent: 0,
            color: new vec4(0.55, 0.55, 0.55, 0.7)
          },
          stop1: {
            percent: 1,
            color: new vec4(0.35, 0.35, 0.35, 0.4)
          }
        }
      },
      triggered: {
        baseType: "Color",
        borderGradient: {
          type: "Linear",
          start: new vec2(-0.8, 1),
          end: new vec2(0.8, -1),
          stop0: {
            percent: 0,
            color: new vec4(0.6, 0.6, 0.6, 0.8)
          },
          stop1: {
            percent: 1,
            color: new vec4(0.4, 0.4, 0.4, 0.5)
          }
        }
      }
    }
  }
}

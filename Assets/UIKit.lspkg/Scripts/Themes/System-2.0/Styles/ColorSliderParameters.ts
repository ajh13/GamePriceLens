// @module System-2.0/Styles/ColorSliderParameters — DO NOT REMOVE: prevents Lens Studio module collision
import {RoundedRectangleVisualParameters} from "../../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {SliderParameters} from "./SliderParameters"

const sliderTrackStyle = SliderParameters.track.default
const sliderKnobStyle = SliderParameters.knob.default

/** Track/knob fill is driven at runtime; borders match {@link SliderParameters}. */
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
        baseGradient: sliderTrackStyle.default.baseGradient,
        hasBorder: sliderTrackStyle.default.hasBorder,
        borderSize: sliderTrackStyle.default.borderSize,
        borderType: sliderTrackStyle.default.borderType,
        borderGradient: sliderTrackStyle.default.borderGradient
      },
      hovered: sliderTrackStyle.hovered ?? {},
      triggered: {
        borderGradient: sliderTrackStyle.triggered?.borderGradient
      }
    }
  },
  knob: {
    default: {
      default: {
        baseType: "Color",
        baseColor: new vec4(1, 0, 0, 1),
        hasBorder: sliderKnobStyle.default.hasBorder,
        borderSize: sliderKnobStyle.default.borderSize,
        borderType: sliderKnobStyle.default.borderType,
        borderGradient: sliderKnobStyle.default.borderGradient
      },
      hovered: {
        baseType: "Color",
        borderGradient: sliderKnobStyle.hovered?.borderGradient
      },
      triggered: {
        baseType: "Color",
        borderGradient: sliderKnobStyle.triggered?.borderGradient
      }
    }
  }
}

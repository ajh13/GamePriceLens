// @module System-3.0/Styles/TooltipParameters — DO NOT REMOVE: prevents Lens Studio module collision
import {GradientParameters} from "../../../Visuals/RoundedRectangle/RoundedRectangle"
import {TooltipFillGray, TooltipTextGray} from "../Colors"

export const TooltipComponentData = {
  backingGradient: {
    enabled: true,
    type: "Rectangle",
    stop0: {enabled: true, percent: -1, color: TooltipFillGray},
    stop1: {enabled: true, percent: 1, color: TooltipFillGray}
  } as GradientParameters,
  borderGradient: {
    enabled: false
  } as GradientParameters,
  borderSize: 0,
  text: {
    color: TooltipTextGray,
    horizontalAlignment: HorizontalAlignment.Left,
    verticalAlignment: VerticalAlignment.Center,
    enableRichText: false
  },
  padding: new vec2(0.75, 0.75)
}

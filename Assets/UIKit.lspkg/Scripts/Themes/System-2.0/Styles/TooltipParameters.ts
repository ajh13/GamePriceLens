import {GradientParameters} from "../../../Visuals/RoundedRectangle/RoundedRectangle"
import {DarkerLessGray, MediumGray, TooltipBackingLight, TooltipBorderDark, TooltipTextGray} from "../Colors"

export const TooltipComponentData = {
  backingGradient: {
    enabled: true,
    type: "Rectangle",
    stop0: {enabled: true, percent: -1, color: DarkerLessGray},
    stop1: {enabled: true, percent: 1, color: TooltipBackingLight}
  } as GradientParameters,
  borderGradient: {
    enabled: true,
    type: "Linear",
    start: new vec2(1, 1),
    end: new vec2(-1, -1),
    stop0: {enabled: true, percent: -1, color: TooltipBorderDark},
    stop1: {enabled: true, percent: 1, color: MediumGray}
  } as GradientParameters,
  borderSize: 0.05,
  text: {
    color: TooltipTextGray,
    horizontalAlignment: HorizontalAlignment.Center,
    verticalAlignment: VerticalAlignment.Center,
    enableRichText: false
  },
  padding: new vec2(0.75, 0.75)
}

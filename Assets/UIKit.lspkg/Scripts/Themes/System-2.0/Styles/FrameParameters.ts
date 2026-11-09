import {HSVtoRGB} from "../../../Utility/UIKitUtilities"

export const FrameParameters = {
  containerGradientBright: HSVtoRGB(0, 0, 0.25, 0.85),
  containerGradientDark: HSVtoRGB(0, 0, 0.15, 0.85),
  containerGradientDarkest: HSVtoRGB(0, 0, 0.2, 0.85),
  borderColor: HSVtoRGB(0, 0, 0.7, 1),
  borderActiveColor: HSVtoRGB(55, 0.5, 0.8, 1),
  highlightColorStop1: HSVtoRGB(0, 0, 0.5, 1),
  highlightColorStop2: HSVtoRGB(0, 0, 0.35, 1),
  highlightActiveColorStop1: HSVtoRGB(50, 1, 0.7, 1),
  highlightActiveColorStop2: HSVtoRGB(40, 1, 0.6, 1)
}

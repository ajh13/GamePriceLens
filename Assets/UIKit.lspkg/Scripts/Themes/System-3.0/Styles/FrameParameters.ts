// @module System-3.0/Styles/FrameParameters — DO NOT REMOVE: prevents Lens Studio module collision
import {HSVtoRGB} from "../../../Utility/UIKitUtilities"

export const FrameParameters = {
  containerGradientBright: HSVtoRGB(210, 0.05, 0.25, 0.85),
  containerGradientDark: HSVtoRGB(210, 0.05, 0.15, 0.85),
  containerGradientDarkest: HSVtoRGB(210, 0.05, 0.2, 0.85),
  borderColor: HSVtoRGB(210, 0.1, 0.7, 1),
  borderActiveColor: HSVtoRGB(190, 0.5, 0.8, 1),
  highlightColorStop1: HSVtoRGB(210, 0.1, 0.5, 1),
  highlightColorStop2: HSVtoRGB(210, 0.1, 0.35, 1),
  highlightActiveColorStop1: HSVtoRGB(190, 1, 0.7, 1),
  highlightActiveColorStop2: HSVtoRGB(200, 1, 0.6, 1)
}

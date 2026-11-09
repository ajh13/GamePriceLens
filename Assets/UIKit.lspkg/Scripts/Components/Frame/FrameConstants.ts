import {HSVtoRGB} from "../../Utility/UIKitUtilities"
import {FrameAppearanceConfig} from "./FrameVisual"

/**
 * Shared Frame theme + timing constants, including the per-appearance preset
 * map (Large/Small). Lives in its own file so FrameRoundedRectVisual can depend
 * on the type without creating a circular import back to Frame.ts.
 */
export const FrameConstants = {
  contentOffset: 0.001,
  opacityTweenDuration: 0.4,
  cursorHighlightAnimationDuration: 0.3,
  squeezeTweenDuration: 0.4,
  nearFieldInteractionZoneDistance: 15,
  containerGradientBright: HSVtoRGB(0, 0, 0.25, 0.85),
  containerGradientDark: HSVtoRGB(0, 0, 0.15, 0.85),
  containerGradientDarkest: HSVtoRGB(0, 0, 0.2, 0.85),
  borderColor: HSVtoRGB(0, 0, 0.7, 1),
  borderActiveColor: HSVtoRGB(55, 0.5, 0.8, 1),
  highlightColorStop1: HSVtoRGB(0, 0, 0.5, 1),
  highlightColorStop2: HSVtoRGB(0, 0, 0.35, 1),
  highlightActiveColorStop1: HSVtoRGB(50, 1, 0.7, 1),
  highlightActiveColorStop2: HSVtoRGB(40, 1, 0.6, 1),
  // Drop shadow (opt-in via Frame's hasShadow), in CSS box-shadow terms:
  // offset (cm, y-up), blur = falloff band width (cm), spread = silhouette
  // growth (cm). Themes can override via componentData["Frame"].
  shadowColor: new vec4(0.05, 0.05, 0.05, 0.4),
  shadowOffset: new vec2(0.05, -0.05),
  shadowBlur: 1.5,
  shadowSpread: 0,
  appearances: {
    Large: {
      margin: 2.5,
      cornerRadius: 2.25,
      borderSize: 0.25,
      dotsHighlightStop1: 0.15,
      dotsScalar: 0.8
    },
    Small: {
      margin: 2.5,
      cornerRadius: 1.4,
      borderSize: 0.125,
      dotsHighlightStop1: 0.12,
      dotsScalar: 1.2
    }
  } as Record<string, FrameAppearanceConfig>
}

export type FrameConstantsType = typeof FrameConstants

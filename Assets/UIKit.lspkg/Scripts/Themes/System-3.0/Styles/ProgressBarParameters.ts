// @module System-3.0/Styles/ProgressBarParameters — DO NOT REMOVE: prevents Lens Studio module collision
import {RoundedRectangleVisualParameters} from "../../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {ProgressBarFillGreen, ProgressBarTrackGray} from "../Colors"

export const ProgressBarComponentData = {
  cornerRadiusFactor: 0.5
}

export const ProgressBarParameters: {
  track: Record<string, Partial<RoundedRectangleVisualParameters>>
  fill: Record<string, Partial<RoundedRectangleVisualParameters>>
} = {
  track: {
    default: {
      default: {
        baseType: "Color",
        baseColor: ProgressBarTrackGray,
        hasBorder: false
      }
    }
  },
  fill: {
    default: {
      default: {
        baseType: "Color",
        baseColor: ProgressBarFillGreen,
        hasBorder: false
      }
    }
  }
}

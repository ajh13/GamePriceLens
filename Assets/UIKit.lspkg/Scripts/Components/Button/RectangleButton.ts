import {RoundedRectangleVisual} from "../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {BaseRoundedRectButton} from "./BaseRoundedRectButton"

/**
 * @deprecated buttons with specified shapes will be removed
 * use Button.ts instead and select your specified shape from the Shape dropdown
 */
@component
export class RectangleButton extends BaseRoundedRectButton {
  protected configureDefaultRoundedRectVisual(visual: RoundedRectangleVisual): void {
    visual.cornerRadius = 0.5
  }
}

import {RoundedRectangleVisual} from "../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {BaseRoundedRectButton} from "./BaseRoundedRectButton"

/**
 * @deprecated buttons with specified shapes will be removed
 * use Button.ts instead and select your specified shape from the Shape dropdown
 */
@component
export class CapsuleButton extends BaseRoundedRectButton {
  @input
  protected _size: vec3 = new vec3(12, 3, 1)

  public get size(): vec3 {
    return this._size
  }

  public set size(size: vec3) {
    if (size === undefined) {
      return
    }
    super.size = size
    if (this._initialized) {
      this._visual.size = size
      const minSide = Math.min(this.size.x, this.size.y)
      ;(this.visual as RoundedRectangleVisual).cornerRadius = minSide * 0.5
    }
  }

  protected configureDefaultRoundedRectVisual(visual: RoundedRectangleVisual): void {
    visual.cornerRadius = Math.min(this._size.x, this._size.y) * 0.5
  }
}

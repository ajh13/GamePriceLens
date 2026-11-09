import {RoundedRectangleVisual} from "../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {BaseRoundedRectButton} from "./BaseRoundedRectButton"

/**
 * @deprecated buttons with specified shapes will be removed
 * use Button.ts instead and select your specified shape from the Shape dropdown
 */
@component
export class RoundButton extends BaseRoundedRectButton {
  @input
  private _width: number = 3

  protected _size: vec3 = new vec3(this._width, this._width, 1)

  /**
   * The width of the RoundButton, which also determines its height.
   */
  public get width(): number {
    return this._width
  }

  public set width(width: number) {
    if (width === undefined) {
      return
    }
    this._width = width
    if (this._initialized) {
      this.size = new vec3(width, width, 1)
      ;(this.visual as RoundedRectangleVisual).cornerRadius = width * 0.5
    }
  }

  public initialize(): boolean {
    if (!super.initialize()) {
      return false
    }
    this._size = new vec3(this._width, this._width, 1)
    return true
  }

  protected configureDefaultRoundedRectVisual(visual: RoundedRectangleVisual): void {
    visual.cornerRadius = this._width * 0.5
  }
}

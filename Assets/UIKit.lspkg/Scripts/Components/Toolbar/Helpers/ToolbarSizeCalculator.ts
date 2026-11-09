import {Frame} from "../../Frame/Frame"
import {mergePadding, ToolbarConfig, ToolbarDirections} from "../Types/ToolbarSchema"

export class ToolbarSizeCalculator {
  public constructor(
    private config: ToolbarConfig,
    private defaultSize: vec2,
    private fitToFrame: boolean,
    private frameSizeScaleX: number,
    private frameSizeScaleY: number,
    private frame: Frame | null
  ) {}

  public calculateToolbarSize(): vec2 {
    if (!this.fitToFrame || !this.frame) {
      const size = this.config.size ?? this.defaultSize
      return size
    }

    const referenceSize = this.config.isToolbarInsideFrame
      ? this.frame!.innerSize
      : new vec2(this.frame!.innerSize.x + this.frame!.margin * 2, this.frame!.innerSize.y + this.frame!.margin * 2)

    let size: vec2
    if (this.config.direction === ToolbarDirections.HORIZONTAL) {
      size = new vec2(referenceSize.x * this.frameSizeScaleX, this.defaultSize.y)
    } else {
      size = new vec2(this.defaultSize.x, referenceSize.y * this.frameSizeScaleY)
    }
    return size
  }

  public calculateAvailableContentSpace(): vec2 {
    const toolbarSize = this.calculateToolbarSize()
    const padding = mergePadding(this.config.padding)

    const contentWidth = toolbarSize.x - padding.left - padding.right
    const contentHeight = toolbarSize.y - padding.top - padding.bottom

    return new vec2(Math.max(0, contentWidth), Math.max(0, contentHeight))
  }
}

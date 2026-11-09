import {Frame} from "../../Frame/Frame"
import {ToolbarConfig, ToolbarFramePositionEnum} from "../Types/ToolbarSchema"

export class ToolbarFramePositioner {
  public constructor(
    private frame: Frame,
    private config: ToolbarConfig,
    private calculateToolbarSize: () => vec2
  ) {}

  public updateToolbarLocalPositionRelativeToFrame(transform: Transform): void {
    const position = this.config.framePosition ?? ToolbarFramePositionEnum.BOTTOM
    const gap = this.config.frameGap ?? 1
    const toolbarSize = this.calculateToolbarSize()
    const toolbarZ = 1
    let localPosition: vec3

    if (this.config.isToolbarInsideFrame) {
      const inner = this.frame.innerSize
      switch (position) {
        case ToolbarFramePositionEnum.BOTTOM:
          localPosition = new vec3(0, -0.5 * inner.y + gap + 0.5 * toolbarSize.y, toolbarZ)
          break
        case ToolbarFramePositionEnum.TOP:
          localPosition = new vec3(0, 0.5 * inner.y - gap - 0.5 * toolbarSize.y, toolbarZ)
          break
        case ToolbarFramePositionEnum.LEFT:
          localPosition = new vec3(-0.5 * inner.x + gap + 0.5 * toolbarSize.x, 0, toolbarZ)
          break
        case ToolbarFramePositionEnum.RIGHT:
          localPosition = new vec3(0.5 * inner.x - gap - 0.5 * toolbarSize.x, 0, toolbarZ)
          break
        default:
          localPosition = new vec3(0, -0.5 * inner.y + gap + 0.5 * toolbarSize.y, toolbarZ)
      }
    } else {
      const inner = this.frame.innerSize
      const margin = this.frame.margin
      switch (position) {
        case ToolbarFramePositionEnum.BOTTOM: {
          const offset = 0.5 * inner.y + margin + gap + 0.5 * toolbarSize.y
          localPosition = new vec3(0, -offset, toolbarZ)
          break
        }
        case ToolbarFramePositionEnum.TOP: {
          const offset = 0.5 * inner.y + margin + gap + 0.5 * toolbarSize.y
          localPosition = new vec3(0, offset, toolbarZ)
          break
        }
        case ToolbarFramePositionEnum.LEFT: {
          const offset = 0.5 * inner.x + margin + gap + 0.5 * toolbarSize.x
          localPosition = new vec3(-offset, 0, toolbarZ)
          break
        }
        case ToolbarFramePositionEnum.RIGHT: {
          const offset = 0.5 * inner.x + margin + gap + 0.5 * toolbarSize.x
          localPosition = new vec3(offset, 0, toolbarZ)
          break
        }
        default: {
          const offset = 0.5 * inner.y + margin + gap + 0.5 * toolbarSize.y
          localPosition = new vec3(0, -offset, toolbarZ)
          break
        }
      }
    }

    transform.setLocalPosition(localPosition)
  }
}

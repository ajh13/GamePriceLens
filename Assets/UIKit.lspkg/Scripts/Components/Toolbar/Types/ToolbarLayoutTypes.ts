import {ToolbarDirection} from "../Types/ToolbarSchema"

export interface AxisInfo {
  primary: "x" | "y"
  cross: "x" | "y"
  isHorizontal: boolean
}

export function getAxisInfo(direction: ToolbarDirection): AxisInfo {
  const isHorizontal = direction === "horizontal"
  return {
    primary: isHorizontal ? "x" : "y",
    cross: isHorizontal ? "y" : "x",
    isHorizontal
  }
}

export function getAxisSize(size: vec2, axis: "x" | "y"): number {
  return axis === "x" ? size.x : size.y
}

export function clampSizeWithConstraints(size: vec2, minSize?: vec2, maxSize?: vec2): vec2 {
  const minX = minSize?.x ?? 0
  const minY = minSize?.y ?? 0
  const maxX = maxSize?.x ?? Number.MAX_VALUE
  const maxY = maxSize?.y ?? Number.MAX_VALUE

  return new vec2(MathUtils.clamp(size.x, minX, maxX), MathUtils.clamp(size.y, minY, maxY))
}

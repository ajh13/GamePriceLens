export interface ToolbarItemLayoutContract {
  applyLayoutSize(size: vec2, transpose: boolean): void
  applyRenderOrder(renderOrder?: number): void
}

export function applyToolbarItemLayout(
  item: ToolbarItemLayoutContract,
  size: vec2,
  transpose: boolean,
  renderOrder?: number
): void {
  item.applyLayoutSize(size, transpose)
  item.applyRenderOrder(renderOrder)
}

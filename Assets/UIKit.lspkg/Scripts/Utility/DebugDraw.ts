/**
 * Draws a wireframe rectangle in world space using 4 lines.
 * Unlike drawBox (which is axis-aligned), this correctly handles
 * rotation and scale from the transform hierarchy.
 */
export function drawWorldBox(center: vec3, width: number, height: number, rot: quat, scale: vec3, color: vec4): void {
  const hw = width * scale.x * 0.5
  const hh = height * scale.y * 0.5
  const right = rot.multiplyVec3(new vec3(hw, 0, 0))
  const up = rot.multiplyVec3(new vec3(0, hh, 0))
  const tl = center.add(up).sub(right)
  const tr = center.add(up).add(right)
  const br = center.sub(up).add(right)
  const bl = center.sub(up).sub(right)
  global.debugRenderSystem.drawLine(tl, tr, color)
  global.debugRenderSystem.drawLine(tr, br, color)
  global.debugRenderSystem.drawLine(br, bl, color)
  global.debugRenderSystem.drawLine(bl, tl, color)
}

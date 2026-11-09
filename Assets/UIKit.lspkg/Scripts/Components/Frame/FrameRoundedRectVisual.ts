import {RoundedRectangle} from "../../Visuals/RoundedRectangle/RoundedRectangle"
import {FrameConstantsType} from "./FrameConstants"
import {FrameAppearanceConfig, FrameVisual} from "./FrameVisual"

const frameMaterial: Material = requireAsset("../../../Materials/Frame.mat") as Material

/**
 * FrameVisual implementation backed by the custom Frame.mat shader and the
 * RoundedRectangle primitive. This is the default Frame visual and the only
 * implementation that supports cursor tracking, glow, dots pattern, and
 * highlight gradients.
 *
 * Owns its SceneObject + RoundedRectangle component lifecycle.
 */
export class FrameRoundedRectVisual implements FrameVisual {
  private _sceneObject: SceneObject | null = null
  private _roundedRectangle: RoundedRectangle | null = null
  private _shader: Pass | null = null

  public constructor(private params: FrameConstantsType) {}

  /** Exposed so Frame can keep a backward-compat `roundedRectangle` getter. */
  public get roundedRectangle(): RoundedRectangle | null {
    return this._roundedRectangle
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  public initialize(parent: SceneObject, layer?: LayerSet): SceneObject {
    this._sceneObject = global.scene.createSceneObject("FrameObject")
    if (layer !== undefined) {
      this._sceneObject.layer = layer
    }
    this._sceneObject.setParent(parent)

    this._roundedRectangle = this._sceneObject.createComponent(RoundedRectangle.getTypeName())
    this._roundedRectangle.material = frameMaterial.clone()
    this._roundedRectangle.initialize()
    this._roundedRectangle.cornerRadius = 2.25
    this._roundedRectangle.border = true
    this._roundedRectangle.borderSize = 0.25
    this._roundedRectangle.borderColor = this.params.borderColor

    this._shader = this._roundedRectangle.renderMeshVisual.mainMaterial.mainPass
    this._shader.highlightColorStop1 = this.params.highlightColorStop1
    this._shader.highlightColorStop2 = this.params.highlightColorStop2
    this._shader.highlightActiveColorStop1 = this.params.highlightActiveColorStop1
    this._shader.highlightActiveColorStop2 = this.params.highlightActiveColorStop2
    this._shader.isActive = 0
    this._shader.grabZonesCount = 0
    this._shader.highlightSize = 40
    this._shader.highlightStop1 = 0.2
    this._shader.highlightStop2 = 0
    this._shader.edgeHighlightStop1 = 0.4
    this._shader.edgeHighlightStop2 = 0
    this._shader.dotsHighlightStop1 = 0.15
    this._shader.dotsHighlightStop2 = 0
    this._shader.dotsScalar = 0.8
    this._shader.cursorRadius = 40
    this._shader.cursorRadiusFactor = 1
    this._shader.blendMode = BlendMode.PremultipliedAlphaAuto
    this._shader.colorMask = new vec4b(true, true, true, true)
    this._shader.twoSided = true

    return this._sceneObject
  }

  public destroy(): void {
    if (!isNull(this._sceneObject) && this._sceneObject) {
      this._sceneObject.destroy()
    }
    this._roundedRectangle = null
    this._sceneObject = null
    this._shader = null
  }

  // ─── Geometry ───────────────────────────────────────────────────────

  public setSize(size: vec2): void {
    if (this._roundedRectangle) this._roundedRectangle.size = size
  }

  public get cornerRadius(): number {
    return this._roundedRectangle?.cornerRadius ?? 0
  }

  // ─── Appearance ─────────────────────────────────────────────────────

  public setCornerRadius(radius: number): void {
    if (this._roundedRectangle) this._roundedRectangle.cornerRadius = radius
  }

  public applyAppearance(config: FrameAppearanceConfig): void {
    if (!this._roundedRectangle || !this._shader) return
    this._roundedRectangle.cornerRadius = config.cornerRadius
    this._roundedRectangle.borderSize = config.borderSize
    this._shader.dotsHighlightStop1 = config.dotsHighlightStop1
    this._shader.dotsScalar = config.dotsScalar
  }

  // ─── Visibility / Opacity ───────────────────────────────────────────

  public setEnabled(enabled: boolean): void {
    if (this._roundedRectangle) this._roundedRectangle.renderMeshVisual.enabled = enabled
  }

  public setOpacity(opacity: number): void {
    if (this._shader) this._shader.opacityFactor = opacity
  }

  // ─── Render Order ───────────────────────────────────────────────────

  public getRenderOrder(): number {
    return this._roundedRectangle?.renderMeshVisual.getRenderOrder() ?? 0
  }

  public setRenderOrder(order: number): void {
    if (this._roundedRectangle) this._roundedRectangle.renderMeshVisual.setRenderOrder(order)
  }

  // ─── Frustum Culling ────────────────────────────────────────────────

  public setFrustumCullBounds(min: vec3, max: vec3): void {
    if (!this._shader) return
    this._shader.frustumCullMin = min
    this._shader.frustumCullMax = max
  }

  // ─── Interaction Feedback ───────────────────────────────────────────

  public setHoverIntensity(value: number): void {
    if (this._shader) this._shader.isHovered = value
  }

  public setActiveState(isActive: boolean, borderColor: vec4): void {
    if (!this._shader || !this._roundedRectangle) return
    this._shader.isActive = isActive ? 1 : 0
    this._roundedRectangle.borderColor = borderColor
  }

  public setFrameHovered(_hovered: boolean): void {
    // no-op: classic visual uses setHoverIntensity for its margin cursor highlight
  }

  public setCursorPosition(position: vec2): void {
    if (this._shader) this._shader.cursorPosition = position
  }

  public setCursorRadiusFactor(factor: number): void {
    if (this._shader) this._shader.cursorRadiusFactor = factor
  }

  public setGlowOpacityFactor(factor: number): void {
    if (this._shader) this._shader.glowOpacityFactor = factor
  }

  // ─── Margin / Interaction Regions ──────────────────────────────────

  public setFrameMargin(margin: number): void {
    if (this._shader) this._shader.frameBorder = margin
  }

  public setBorderOnly(borderOnly: boolean): void {
    if (this._shader) this._shader.borderOnly = borderOnly ? 1 : 0
  }

  public setCutOutCenter(cutOut: boolean): void {
    if (this._shader) this._shader.cutOutCenter = cutOut
  }

  public setCutOutFeather(_feather: number): void {
    // no-op: System2 frame shader does not expose a cutout feather uniform.
  }

  // ─── Grab Zones ─────────────────────────────────────────────────────

  public setGrabZones(zones: vec4[]): void {
    if (!this._shader) return
    this._shader.grabZonesCount = zones.length
    this._shader.grabZones = zones
  }

  // ─── Button Layout ──────────────────────────────────────────────────

  public getButtonAnchor(type: "close" | "follow", totalSize: vec2, buttonSize: number, offset: number): vec3 {
    const topY = totalSize.y * 0.5 - buttonSize * 0.5 - offset
    if (type === "close") {
      return new vec3(totalSize.x * -0.5 + buttonSize * 0.5 + offset, topY, 0.1)
    }
    return new vec3(totalSize.x * 0.5 - buttonSize * 0.5 - offset, topY, 0.1)
  }

  public getRightDrawerAnchor(totalSize: vec2, drawerWidth: number, offset: number): vec3 {
    // The classic frame visual doesn't host a drawer — follow stays as a
    // single button via getButtonAnchor("follow"). This anchor is provided
    // for interface completeness only.
    const drawerTopY = totalSize.y * 0.5 - offset
    return new vec3(totalSize.x * 0.5 + drawerWidth * 0.5, drawerTopY, 0.1)
  }
}

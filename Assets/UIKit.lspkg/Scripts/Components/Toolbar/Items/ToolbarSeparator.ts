import {RoundedRectangleVisual} from "../../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {ToolbarDirections, ToolbarItemSizeMode, ToolbarSeparatorConfig} from "../Types/ToolbarSchema"
import {ToolbarItem} from "./ToolbarItem"

/**
 * Toolbar separator (divider) item. Obtain via {@link Toolbar.getItem} or {@link Toolbar.allItems}.
 */
@component
export class ToolbarSeparator extends ToolbarItem {
  private readonly DEFAULT_THICKNESS = 0.1
  private readonly DEFAULT_HEIGHT = 3.0
  private readonly DEFAULT_COLOR = new vec4(0.5, 0.5, 0.5, 0.5)

  private visual: RoundedRectangleVisual
  private separatorConfig: ToolbarSeparatorConfig

  /** Separator color (RGBA). */
  public get color(): vec4 {
    return this.separatorConfig?.color ?? this.visual?.baseDefaultColor ?? this.DEFAULT_COLOR
  }

  public set color(value: vec4) {
    if (this.separatorConfig) this.separatorConfig.color = value
    if (this.visual) this.visual.baseDefaultColor = value
  }

  /** Separator thickness in centimeters. */
  public get thickness(): number {
    return this.separatorConfig?.thickness ?? this.DEFAULT_THICKNESS
  }

  public set thickness(value: number) {
    if (this.separatorConfig) {
      this.separatorConfig.thickness = value
      this.updateVisualSize()
    }
  }

  /** Overrides base to update separator visual size when layout assigns size. */
  public get computedSize(): vec2 {
    return super.computedSize
  }

  public set computedSize(size: vec2) {
    super.computedSize = size
    this.updateVisualSize()
  }

  /** Intrinsic size from thickness and height (or defaults). */
  public get intrinsicSize(): vec2 {
    const thickness = this.separatorConfig?.thickness ?? this.DEFAULT_THICKNESS
    const height = this.separatorConfig?.height ?? this.DEFAULT_HEIGHT
    const direction = this.getToolbarDirection()
    return direction === ToolbarDirections.VERTICAL ? new vec2(height, thickness) : new vec2(thickness, height)
  }

  /** Size mode: separator always uses explicit size (manual). */
  public getSizeMode(): ToolbarItemSizeMode {
    return ToolbarItemSizeMode.MANUAL
  }

  public applyLayoutSize(size: vec2, _transpose: boolean): void {
    this.computedSize = size
    this.transform.setLocalScale(vec3.one())
  }

  public applyRenderOrder(renderOrder?: number): void {
    if (renderOrder !== undefined && this.visual?.renderMeshVisual) {
      this.visual.renderMeshVisual.renderOrder = renderOrder
    }
  }

  /** Called by the toolbar when the item is created. Not intended for external callers. */
  public initializeWithConfig(config: ToolbarSeparatorConfig) {
    this.separatorConfig = config

    super.initializeWithConfig(config)

    this.createVisual(config)
    if (config.inactive) {
      this.updateDisabledVisuals(config.inactive)
    }
  }

  protected setVisualAlpha(_alpha: number, effectiveAlpha: number): void {
    if (this.visual?.renderMeshVisual?.mainMaterial?.mainPass) {
      this.visual.renderMeshVisual.mainMaterial.mainPass.opacityFactor = effectiveAlpha
      this.visual.renderMeshVisual.enabled = effectiveAlpha > 0
    }
  }

  private createVisual(config: ToolbarSeparatorConfig) {
    this.visual = new RoundedRectangleVisual({
      sceneObject: this.sceneObject,
      transparent: true
    })

    const color = config.color ?? this.DEFAULT_COLOR

    this.visual.cornerRadius = 0
    this.visual.baseDefaultColor = color
    this.visual.renderMeshVisual.renderOrder = this.renderOrder

    this.updateVisualSize()
  }

  private updateVisualSize() {
    if (!this.visual) return

    const computed = this._computedSize
    const size = computed && computed.x > 0 && computed.y > 0 ? computed : this.intrinsicSize

    this.visual.size = new vec3(size.x, size.y, 0)
    this.visual.cornerRadius = 0
  }
}

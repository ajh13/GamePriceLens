import {RoundedRectangleVisual} from "../../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {Visual} from "../../../Visuals/Visual"
import {Slider} from "../../Slider/Slider"
import {getSizeModeFromSize, ToolbarDirections, ToolbarItemConfig, ToolbarItemSizeMode} from "../Types/ToolbarSchema"
import {ToolbarItem} from "./ToolbarItem"

/**
 * Base for toolbar slider and toggle items. Obtain via {@link Toolbar.getItem} or {@link Toolbar.allItems}.
 */
export abstract class ToolbarSliderBase extends ToolbarItem {
  protected readonly DEFAULT_HEIGHT = 3.0
  private _sliderComponent: Slider

  /** Underlying Slider component (or Switch for toggle). */
  public get sliderComponent(): Slider {
    return this._sliderComponent
  }

  protected set sliderComponent(value: Slider) {
    this._sliderComponent = value
  }

  /** Intrinsic size from config or slider component size. */
  public get intrinsicSize(): vec2 {
    const componentSize = this.sliderComponent.size
    const sizeConfig = this.config?.size
    if (typeof sizeConfig === "object" && !(sizeConfig instanceof vec2)) {
      const x = typeof sizeConfig.x === "number" ? sizeConfig.x : componentSize.x
      const y = typeof sizeConfig.y === "number" ? sizeConfig.y : componentSize.y
      return new vec2(x, y)
    }
    return new vec2(componentSize.x, componentSize.y)
  }

  /** Called by the toolbar when the item is created. Not intended for external callers. */
  public initializeWithConfig(config: ToolbarItemConfig) {
    super.initializeWithConfig(config)
    this._sliderComponent.renderOrder = this.renderOrder

    this._sliderComponent.onHoverEnter.add((e) => this.invokeOnHoverEnter(e))
    this._sliderComponent.onHoverExit.add((e) => this.invokeOnHoverExit(e))
    this._sliderComponent.onTriggerUp.add((e) => this.invokeOnTriggerUp(e))
    this._sliderComponent.onTriggerDown.add((e) => this.invokeOnTriggerDown(e))
  }

  /** Called when the toolbar applies the item's final cell size. */
  public onLayoutSizeApplied() {
    this.updateSliderLayout()
  }

  /** Size mode: fill or manual from config.size. */
  public getSizeMode(): ToolbarItemSizeMode {
    return getSizeModeFromSize(this.config.size)
  }

  public applyLayoutSize(size: vec2, transpose: boolean): void {
    const contentSize = transpose ? new vec2(size.y, size.x) : size
    this.computedSize = size
    this.sliderComponent.size = new vec3(contentSize.x, contentSize.y, 0)
    this.transform.setLocalScale(vec3.one())
  }

  public applyRenderOrder(renderOrder?: number): void {
    if (renderOrder !== undefined) {
      this.sliderComponent.renderOrder = renderOrder
    }
  }

  public shouldTransposeLayout(): boolean {
    return this.getToolbarDirection() === ToolbarDirections.VERTICAL
  }

  protected updateSliderLayout() {
    const slider = this.sliderComponent
    if (!slider) return

    // The Content child's ElementHandler owns the Slider size; assigning it fires
    // the Slider's own onSizeChanged listener, which re-runs fill, knob position,
    // and theme-driven track corner radius. The one thing that listener cannot
    // derive is the square knob for the new cross thickness (it reuses the stale
    // _knobSize), so re-issue knobSize here from the applied cross (size.y — the
    // thickness in the Slider's own frame for both horizontal and transposed
    // vertical). Setting knobSize re-runs updateKnobSize + updateKnobPositionFromValue.
    // Switch sets customKnobSize=true and drives its own knob, so this no-ops for toggles.
    if (!slider.customKnobSize) {
      const cross = slider.size.y
      if (cross > 0) {
        slider.knobSize = new vec2(cross, cross)
      }
    }
  }

  protected onInactiveChanged(inactive: boolean): void {
    if (this.sliderComponent) {
      this.sliderComponent.inactive = inactive
    }
  }

  protected setVisualAlpha(_alpha: number, effectiveAlpha: number): void {
    this.setSliderVisualOpacity(effectiveAlpha)
  }

  private setSliderVisualOpacity(alpha: number): void {
    this.setVisualOpacity(this.sliderComponent?.visual, alpha)
    this.setVisualOpacity(this.sliderComponent?.knobVisual, alpha)
    this.setVisualOpacity(this.sliderComponent?.trackFillVisual, alpha)
  }

  private setVisualOpacity(visual: Visual | undefined, alpha: number): void {
    if (!visual) return
    const rmv = visual.renderMeshVisual
    if (rmv) {
      rmv.enabled = true
      if (rmv.mainMaterial?.mainPass) {
        rmv.mainMaterial.mainPass.blendMode = BlendMode.PremultipliedAlphaAuto
      }
    }
    ;(visual as RoundedRectangleVisual).opacity = alpha
  }
}

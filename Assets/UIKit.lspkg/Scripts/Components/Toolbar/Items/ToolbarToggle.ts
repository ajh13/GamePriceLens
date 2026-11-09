import {Switch} from "../../Switch/Switch"
import {ToolbarDirections, ToolbarItemSizeMode, ToolbarToggleConfig} from "../Types/ToolbarSchema"
import {ToolbarSliderBase} from "./ToolbarSliderBase"

/**
 * Toolbar item that wraps a Switch component. Obtain via {@link Toolbar.getItem} or {@link Toolbar.allItems}.
 */
@component
export class ToolbarToggle extends ToolbarSliderBase {
  /** Underlying Switch component. */
  public get switchComponent(): Switch {
    return this.sliderComponent as Switch
  }

  /** Whether the switch is on. Forwards to {@link switchComponent}. */
  public get isOn(): boolean {
    return this.switchComponent.isOn
  }

  public set isOn(value: boolean) {
    this.switchComponent.isOn = value
  }

  public shouldTransposeLayout(): boolean {
    return false
  }

  /** Called by the toolbar when the item is created. Not intended for external callers. */
  public initializeWithConfig(config: ToolbarToggleConfig) {
    this._config = config

    this.createSwitch(config)

    const size = this.intrinsicSize
    this._size = new vec3(size.x, size.y, 0)

    super.initializeWithConfig(config)
  }

  /** In vertical toolbars, fill-mode toggles need their width set to the full content space width. */
  public getFinalLayoutSize(layoutSize: vec2, contentSpace: vec2): vec2 {
    if (this.getSizeMode() === ToolbarItemSizeMode.FILL && this.getToolbarDirection() === ToolbarDirections.VERTICAL) {
      const crossAxisSize = layoutSize.x > 0 ? layoutSize.x : 3.0
      return new vec2(contentSpace.x, crossAxisSize)
    }
    return layoutSize
  }

  // Vertical FILL toggle: the canonical Switch spans the toolbar's content width
  // while its cell stays a primary-axis grow member. The ToolbarFlexItem applies
  // (contentSpace.x, allocated width) so the Switch size, computedSize, and
  // getFinalLayoutSize all agree — no wrapper size write. Matches the width axis
  // of getFinalLayoutSize above; the height (allocated width) is supplied by the
  // ToolbarFlexItem scalar-apply hook.
  public getContentApplyWidthOverride(contentSpace: vec2, isHorizontal: boolean): number {
    if (!isHorizontal && this.getSizeMode() === ToolbarItemSizeMode.FILL) {
      return contentSpace.x
    }
    return -1
  }

  private createSwitch(config: ToolbarToggleConfig) {
    // Canonical Switch lives on the Content child; its own onSizeChanged
    // (applyStyleKnobSize, customKnobSize=true) owns knob + corner radius, so the
    // wrapper keeps no post-size behavior (ToolbarSliderBase.onLayoutSizeApplied
    // no-ops here because customKnobSize is true).
    this.sliderComponent = this._contentObject!.createComponent(Switch.getTypeName()) as Switch
    this.managedComponents.add(this.sliderComponent)
    this.sliderComponent.initialize()

    const switchComponent = this.sliderComponent as Switch
    if (config.isOn !== undefined) {
      switchComponent.isOn = config.isOn
    }

    if (config.onToggled) {
      switchComponent.onValueChange.add((value: number) => {
        const isOn = value > 0
        config.onToggled?.(isOn)
      })
    }

    if (this.sliderComponent.visual && this.sliderComponent.visual.renderMeshVisual) {
      this.sliderComponent.visual.renderMeshVisual.mainMaterial.mainPass.blendMode = BlendMode.PremultipliedAlphaAuto
    }
  }
}

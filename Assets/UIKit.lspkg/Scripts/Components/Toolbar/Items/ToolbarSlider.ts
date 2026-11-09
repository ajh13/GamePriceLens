import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import {Slider} from "../../Slider/Slider"
import {ToolbarSliderConfig} from "../Types/ToolbarSchema"
import {ToolbarSliderBase} from "./ToolbarSliderBase"

const log = new NativeLogger("ToolbarSlider")

/**
 * Toolbar slider item. Obtain via {@link Toolbar.getItem} or {@link Toolbar.allItems}.
 */
@component
export class ToolbarSlider extends ToolbarSliderBase {
  /** Lower bound of the value range, from config. */
  public get min(): number {
    return this.sliderConfig.min
  }

  /** Upper bound of the value range, from config. */
  public get max(): number {
    return this.sliderConfig.max
  }

  /** Step the value snaps to, or undefined for a continuous slider. */
  public get step(): number | undefined {
    return this.sliderConfig.step
  }

  /**
   * The current value in the configured [min, max] range, snapped to `step` when
   * one is set. Read and write the value here rather than through
   * {@link sliderComponent}: the underlying Slider works in normalized 0..1 and
   * rejects anything outside it with a warning, so writing 50 to
   * `sliderComponent.currentValue` on a 0..100 slider is silently dropped.
   * A NaN write is ignored with a warning; ±Infinity clamps to max or min.
   */
  public get value(): number {
    const config = this.sliderConfig
    return this.denormalizeValue(this.sliderComponent.currentValue, config.min, config.max, config.step)
  }

  public set value(value: number) {
    const config = this.sliderConfig
    // Rejected here rather than left to the clamps: Lens Studio's native
    // MathUtils.clamp turns NaN into 0 first, so a NaN would silently move the
    // slider to wherever 0 clamps and fire onValueChanged.
    if (Number.isNaN(value)) {
      log.w(`ToolbarSlider "${config.id}": ignoring a NaN value`)
      return
    }
    this.sliderComponent.currentValue = this.normalizeValue(this.snapToRange(value, config), config.min, config.max)
  }

  /** Called by the toolbar when the item is created. Not intended for external callers. */
  public initializeWithConfig(config: ToolbarSliderConfig) {
    this._config = config

    this.createSlider(config)

    const intrinsicSize = this.intrinsicSize
    this._size = new vec3(intrinsicSize.x, intrinsicSize.y, 0)

    super.initializeWithConfig(config)
  }

  private createSlider(config: ToolbarSliderConfig) {
    // Canonical Slider lives on the Content child (its own ElementHandler owns
    // size); the 90° rotation for a vertical toolbar is applied to the Content
    // child by ToolbarFlexItem.transposeAxes, not the wrapper transform.
    this.sliderComponent = this._contentObject!.createComponent(Slider.getTypeName()) as Slider
    this.managedComponents.add(this.sliderComponent)
    this.sliderComponent.initialize()

    if (config.segmented) {
      this.sliderComponent.segmented = true
      const n = config.numberOfSegments ?? 2
      this.sliderComponent.numberOfSegments = Math.max(2, n)
    }

    let requestedValue = config.value ?? config.min
    if (Number.isNaN(requestedValue)) {
      log.w(`ToolbarSlider "${config.id}": config.value is NaN; starting at min (${config.min})`)
      requestedValue = config.min
    }
    const initialValue = this.snapToRange(requestedValue, config)
    const normalizedValue = this.normalizeValue(initialValue, config.min, config.max)
    this.sliderComponent.currentValue = normalizedValue

    if (config.onValueChanged) {
      this.sliderComponent.onValueChange.add((normalizedValue: number) => {
        const actualValue = this.denormalizeValue(normalizedValue, config.min, config.max, config.step)
        config.onValueChanged?.(actualValue)
      })
    }

    if (this.sliderComponent.visual && this.sliderComponent.visual.renderMeshVisual) {
      this.sliderComponent.visual.renderMeshVisual.mainMaterial.mainPass.blendMode = BlendMode.PremultipliedAlphaAuto
    }
  }

  private get sliderConfig(): ToolbarSliderConfig {
    return this._config as ToolbarSliderConfig
  }

  // Snaps to `step` when one is set, then clamps to [min, max]. Shared by the
  // initial value and the `value` setter so both round the same way. Clamped
  // with Math.min/Math.max, not MathUtils.clamp: the native clamp maps
  // ±Infinity to 0 before clamping, so Infinity on a 0..100 slider landed at 0.
  private snapToRange(value: number, config: ToolbarSliderConfig): number {
    if (config.step !== undefined && config.step > 0) {
      value = config.min + Math.round((value - config.min) / config.step) * config.step
    }
    return Math.min(Math.max(value, config.min), config.max)
  }

  private normalizeValue(value: number, min: number, max: number): number {
    if (max === min) return 0
    return MathUtils.clamp((value - min) / (max - min), 0, 1)
  }

  private denormalizeValue(normalized: number, min: number, max: number, step?: number): number {
    let value = min + normalized * (max - min)
    if (step !== undefined && step > 0) {
      value = min + Math.round((value - min) / step) * step
    }
    return MathUtils.clamp(value, min, max)
  }
}

import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import {OpacityControllable} from "../../Interfaces/OpacityControllable"
import {formatLensValue} from "../../Utility/UIKitUtilities"
import {Shape} from "../Shape"
import type {BaseGradientConfig, BaseRoundedRectangleConfig} from "./BaseRoundedRectangle"
import {BaseRoundedRectangle} from "./BaseRoundedRectangle"
import type {
  BorderType,
  GradientParameters,
  GradientStop,
  GradientType,
  RoundedRectangleBaseType,
  TextureMode,
  TextureWrap
} from "./RoundedRectangleTypes"
import {RoundedRectBlendMode} from "./RoundedRectangleTypes"

const log = new NativeLogger("RoundedRectangle")

export {GradientParameters, RoundedRectBlendMode} from "./RoundedRectangleTypes"
export type {
  BorderType,
  GradientStop,
  GradientType,
  RoundedRectangleBaseType,
  TextureMode,
  TextureWrap
} from "./RoundedRectangleTypes"

/**
 * Rounded Rectangle Component
 * Gives a Rounded Rectangle at a given size
 * Provides Background Color, Gradient or Texture
 * And an Optional Inset Border, with Color or Gradient
 */
@component
export class RoundedRectangle extends Shape implements OpacityControllable {
  @input("float", "1")
  @hint("Radius of rounding in Local Space Centimeters")
  private _cornerRadius: number

  @input("int")
  @widget(new ComboBoxWidget().addItem("Disabled", 0).addItem("Normal", 1))
  private _blendMode: RoundedRectBlendMode = 0

  @input("float")
  @widget(new SliderWidget(0, 1))
  private _opacity: number = 1.0

  @input
  @hint("Enable background gradient")
  private _gradient: boolean

  @input("vec4", "{.8,.8,.8,1.}")
  @hint("Solid color of background if not using gradient")
  @widget(new ColorWidget())
  @showIf("_gradient", false)
  private _backgroundColor: vec4

  @input
  @hint("Enable background texture")
  @showIf("_gradient", false)
  private _useTexture: boolean = false

  @input
  @hint("Background texture asset")
  @showIf("_useTexture", true)
  private _texture: Texture

  @input("string", "Stretch")
  @hint("Display mode for background texture.")
  @showIf("_useTexture", true)
  @widget(
    new ComboBoxWidget([new ComboBoxItem("Stretch"), new ComboBoxItem("Fill Height"), new ComboBoxItem("Fill Width")])
  )
  private _textureMode: TextureMode

  @input("string", "None")
  @hint("Wrap mode for background texture.")
  @showIf("_useTexture", true)
  @widget(new ComboBoxWidget([new ComboBoxItem("None"), new ComboBoxItem("Repeat"), new ComboBoxItem("Clamp")]))
  private _textureWrap: TextureWrap

  @input("string", "Linear")
  @hint("Gradient type: either Linear or Radial")
  @showIf("_gradient", true)
  @widget(new ComboBoxWidget([new ComboBoxItem("Linear"), new ComboBoxItem("Radial"), new ComboBoxItem("Rectangle")]))
  private _gradientType: GradientType = "Linear"

  @input("vec2", "{-1,-1}")
  @hint("Start Position for gradient. Use to define ratio of gradient stop percents.")
  @showIf("_gradient", true)
  private _gradientStartPosition: vec2

  @input("vec2", "{1,1}")
  @hint("End Position for gradient. Use to define ratio of gradient stop percents.")
  @showIf("_gradient", true)
  private _gradientEndPosition: vec2

  @input("vec4", "{.5,.5,.5,1}")
  @hint("Color for this stop.")
  @showIf("_gradient", true)
  @widget(new ColorWidget())
  private _gradientColor0: vec4

  @input("number", "0")
  @hint("Percent position within gradient that it fully reaches this stop color.")
  @showIf("_gradient", true)
  private _gradientPercent0: number

  @input("vec4", "{.75,.75,.7,1}")
  @hint("Color for this stop.")
  @showIf("_gradient", true)
  @widget(new ColorWidget())
  private _gradientColor1: vec4

  @input("number", "0")
  @hint("Percent position within gradient that it fully reaches this stop color.")
  @showIf("_gradient", true)
  private _gradientPercent1: number

  @input
  @hint("Enable or disable this stop.")
  @showIf("_gradient", true)
  private _gradientStop2: boolean = false

  @input("vec4", "{0,0,0,0}")
  @hint("Color for this stop.")
  @showIf("_gradientStop2", true)
  @widget(new ColorWidget())
  private _gradientColor2: vec4

  @input("number", "1")
  @hint("Percent position within gradient that it fully reaches this stop color.")
  @showIf("_gradientStop2", true)
  private _gradientPercent2: number

  @input
  @showIf("_gradientStop2", true)
  @hint("Enable or disable this stop.")
  private _gradientStop3: boolean = false

  @input("vec4", "{0,0,0,0}")
  @hint("Color for this stop.")
  @showIf("_gradientStop3", true)
  @widget(new ColorWidget())
  private _gradientColor3: vec4

  @input("number", "1")
  @hint("Percent position within gradient that it fully reaches this stop color.")
  @showIf("_gradientStop3", true)
  private _gradientPercent3: number

  @input
  @hint("Enable or disable this stop.")
  @showIf("_gradientStop3", true)
  private _gradientStop4: boolean = false

  @input("vec4", "{0,0,0,0}")
  @hint("Color for this stop.")
  @showIf("_gradientStop4", true)
  @widget(new ColorWidget())
  private _gradientColor4: vec4

  @input("number", "1")
  @hint("Percent position within gradient that it fully reaches this stop color.")
  @showIf("_gradientStop4", true)
  private _gradientPercent4: number

  @input
  @hint("Enable or disable this stop.")
  @showIf("_gradientStop4", true)
  private _gradientStop5: boolean = false

  @input("vec4", "{0,0,0,0}")
  @hint("Color for this stop.")
  @showIf("_gradientStop5", true)
  @widget(new ColorWidget())
  private _gradientColor5: vec4

  @input("number", "1")
  @hint("Percent position within gradient that it fully reaches this stop color.")
  @showIf("_gradientStop5", true)
  private _gradientPercent5: number

  @input
  @hint("Enable or disable this stop.")
  @showIf("_gradientStop5", true)
  private _gradientStop6: boolean = false

  @input("vec4", "{0,0,0,0}")
  @hint("Color for this stop.")
  @showIf("_gradientStop6", true)
  @widget(new ColorWidget())
  private _gradientColor6: vec4

  @input("number", "1")
  @hint("Percent position within gradient that it fully reaches this stop color.")
  @showIf("_gradientStop6", true)
  private _gradientPercent6: number

  @input
  @hint("Enable or disable inset border.")
  private _border: boolean

  @input("float", ".2")
  @hint("Border thickness in centimeters in Local Space.")
  @showIf("_border", true)
  private _borderSize: number

  // Width (local-space units, like borderSize) of the soft fade on the inner
  // edge of the border. Driven by style/code; 0.005 ≈ the prior hairline AA.
  private _borderSoftness: number = 0.005

  @input("string", "Color")
  @hint("Type of border fill. Either solid Color or Gradient.")
  @showIf("_border", true)
  @widget(new ComboBoxWidget([new ComboBoxItem("Color"), new ComboBoxItem("Gradient")]))
  private _borderType: BorderType = "Color"

  @input("vec4", "{.8,.8,.8,1.}")
  @hint("Color of border when set to Color type.")
  @widget(new ColorWidget())
  @showIf("_border", true)
  private _borderColor: vec4

  @input("string", "Linear")
  @hint("Type of gradient. Either Linear or Radial.")
  @showIf("_borderType", "Gradient")
  @widget(new ComboBoxWidget([new ComboBoxItem("Linear"), new ComboBoxItem("Radial"), new ComboBoxItem("Rectangle")]))
  private _borderGradientType: GradientType = "Linear"

  @input("vec2", "{-1,-1}")
  @hint("Start Position for border gradient. Use to define ratio of gradient stop percents.")
  @showIf("_borderType", "Gradient")
  private _borderGradientStartPosition: vec2

  @input("vec2", "{1,1}")
  @hint("End Position for border gradient. Use to define ratio of gradient stop percents.")
  @showIf("_borderType", "Gradient")
  private _borderGradientEndPosition: vec2

  @input("vec4", "{.5,.5,.5,1}")
  @hint("Color for this stop.")
  @showIf("_borderType", "Gradient")
  @widget(new ColorWidget())
  private _borderGradientColor0: vec4

  @input("number", "0")
  @hint("Percent position within gradient that it fully reaches this stop color.")
  @showIf("_borderType", "Gradient")
  private _borderGradientPercent0: number

  @input("vec4", "{.75,.75,.7,1}")
  @hint("Color for this stop.")
  @showIf("_borderType", "Gradient")
  @widget(new ColorWidget())
  private _borderGradientColor1: vec4

  @input("number", "1")
  @hint("Percent position within gradient that it fully reaches this stop color.")
  @showIf("_borderType", "Gradient")
  private _borderGradientPercent1: number

  @input
  @hint("Enable or disable this stop.")
  @showIf("_borderType", "Gradient")
  private _borderGradientStop2: boolean = false

  @input("vec4", "{.9,.9,.8,1}")
  @hint("Color for this stop.")
  @showIf("_borderGradientStop2", true)
  @widget(new ColorWidget())
  private _borderGradientColor2: vec4

  @input("number", "1")
  @hint("Percent position within gradient that it fully reaches this stop color.")
  @showIf("_borderGradientStop2", true)
  private _borderGradientPercent2: number

  @input
  @hint("Enable or disable this stop.")
  @showIf("_borderGradientStop2", true)
  private _borderGradientStop3: boolean = false

  @input("vec4", "{0,0,0,0}")
  @hint("Color for this stop.")
  @showIf("_borderGradientStop3", true)
  @widget(new ColorWidget())
  private _borderGradientColor3: vec4

  @input("number", "1")
  @hint("Percent position within gradient that it fully reaches this stop color.")
  @showIf("_borderGradientStop3", true)
  private _borderGradientPercent3: number

  @input
  @hint("Enable or disable this stop.")
  @showIf("_borderGradientStop3", true)
  private _borderGradientStop4: boolean = false

  @input("vec4", "{0,0,0,0}")
  @hint("Color for this stop.")
  @showIf("_borderGradientStop4", true)
  @widget(new ColorWidget())
  private _borderGradientColor4: vec4

  @input("number", "1")
  @hint("Percent position within gradient that it fully reaches this stop color.")
  @showIf("_borderGradientStop4", true)
  private _borderGradientPercent4: number

  @input
  @hint("Enable or disable this stop.")
  @showIf("_borderGradientStop4", true)
  private _borderGradientStop5: boolean = false

  @input("vec4", "{0,0,0,0}")
  @hint("Color for this stop.")
  @showIf("_borderGradientStop5", true)
  @widget(new ColorWidget())
  private _borderGradientColor5: vec4

  @input("number", "1")
  @hint("Percent position within gradient that it fully reaches this stop color.")
  @showIf("_borderGradientStop5", true)
  private _borderGradientPercent5: number

  @input
  @hint("Enable or disable this stop.")
  @showIf("_borderGradientStop5", true)
  private _borderGradientStop6: boolean = false

  @input("vec4", "{0,0,0,0}")
  @hint("Color for this stop.")
  @showIf("_borderGradientStop6", true)
  @widget(new ColorWidget())
  private _borderGradientColor6: vec4

  @input("number", "1")
  @hint("Percent position within gradient that it fully reaches this stop color.")
  @showIf("_borderGradientStop6", true)
  private _borderGradientPercent6: number

  private _baseRoundedRectangle: BaseRoundedRectangle | null = null

  // Pre-initialize buffers for the pass-through toggles below — like every
  // other property, writes before configureMesh() must survive to it.
  private _borderVisible: boolean = true
  private _materialVariantsEnabled: boolean = true
  private _cullWhenTransparent: boolean = false
  private _cullIncludesOpacity: boolean = false

  protected get materialSource(): Material {
    return BaseRoundedRectangle.getMaterialAsset()
  }

  public get depth(): number {
    return 1
  }

  public set depth(_: number) {
    log.w("RoundedRectangle is 2D and has no depth")
  }

  public override onAwake(): void {
    this.createEvent("OnDestroyEvent").bind(() => {
      this._baseRoundedRectangle?.dispose()
      this._baseRoundedRectangle = null
    })
    super.onAwake()
  }

  public set blendMode(blendMode: RoundedRectBlendMode) {
    this._blendMode = blendMode
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.blendMode = blendMode
    }
  }

  public get blendMode(): RoundedRectBlendMode {
    return this._baseRoundedRectangle?.blendMode ?? this._blendMode
  }

  /**
   * Controls the opacity of this rounded rectangle.
   *
   * @param opacity - The opacity factor to apply to the material (range [0, 1]).
   */
  public set opacity(opacity: number) {
    this._opacity = opacity
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.opacity = opacity
    }
  }

  /**
   * Gets the current opacity of this rounded rectangle.
   */
  public get opacity(): number {
    return this._baseRoundedRectangle?.opacity ?? this._opacity
  }

  protected configureMesh(): void {
    this._baseRoundedRectangle?.dispose()
    this._baseRoundedRectangle = new BaseRoundedRectangle(this._rmv, this._material, this.createBaseConfig())
    if (this._usesCustomMaterial || !this._materialVariantsEnabled) {
      // Bespoke compose materials (Frame body/panel) render their own
      // features in-shader — the variant ladder must never swap them away.
      this._baseRoundedRectangle.materialVariantsEnabled = false
    }
    this._baseRoundedRectangle.borderVisible = this._borderVisible
    this._baseRoundedRectangle.cullWhenTransparent = this._cullWhenTransparent
    this._baseRoundedRectangle.cullIncludesOpacity = this._cullIncludesOpacity
    this._baseRoundedRectangle.initialize()
  }

  /**
   * Skips the draw while every fill and border color is fully transparent instead of shading an
   * invisible quad every frame. Off by default for this component. Only applies to the stock
   * materials on a blended pass; opacity is not considered.
   */
  public get cullWhenTransparent(): boolean {
    return this._baseRoundedRectangle?.cullWhenTransparent ?? this._cullWhenTransparent
  }

  public set cullWhenTransparent(value: boolean) {
    if (value === undefined) {
      return
    }
    this._cullWhenTransparent = value
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.cullWhenTransparent = value
    }
  }

  /**
   * Also skips the draw at opacity 0. Only for owners that drive this shape's opacity
   * themselves; a layer that writes the pass opacity directly would not be seen.
   */
  public get cullIncludesOpacity(): boolean {
    return this._baseRoundedRectangle?.cullIncludesOpacity ?? this._cullIncludesOpacity
  }

  public set cullIncludesOpacity(value: boolean) {
    if (value === undefined) {
      return
    }
    this._cullIncludesOpacity = value
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.cullIncludesOpacity = value
    }
  }

  /**
   * Shows/hides an enabled border without touching the authored border state
   * (unlike `border = false`, which zeroes borderSize). The toggle for
   * hover-style borders.
   */
  public get borderVisible(): boolean {
    return this._baseRoundedRectangle?.borderVisible ?? this._borderVisible
  }

  public set borderVisible(visible: boolean) {
    if (visible === undefined) {
      return
    }
    this._borderVisible = visible
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.borderVisible = visible
    }
  }

  /**
   * Whether the material variant ladder may swap this shape's material.
   * Disable BEFORE overriding the bound material with a bespoke shader.
   */
  public get materialVariantsEnabled(): boolean {
    return this._baseRoundedRectangle?.materialVariantsEnabled ?? this._materialVariantsEnabled
  }

  public set materialVariantsEnabled(enabled: boolean) {
    if (enabled === undefined) {
      return
    }
    this._materialVariantsEnabled = enabled
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.materialVariantsEnabled = enabled
    }
  }

  protected updateSize(): void {
    this._baseRoundedRectangle?.updateSize(this._size)
  }

  /**
   * @returns current corner radius in centimeters in local space.
   */
  public get cornerRadius(): number {
    return this._baseRoundedRectangle?.cornerRadius ?? this._cornerRadius
  }

  /**
   * @param cornerRadius set corner radius in centimeters in local space.
   */
  public set cornerRadius(cornerRadius: number) {
    if (cornerRadius === undefined) {
      return
    }
    this._cornerRadius = cornerRadius
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.cornerRadius = cornerRadius
    }
  }

  /**
   * @returns vec4 of current background color. for solid color, not gradient.
   */
  public get backgroundColor(): vec4 {
    return this._baseRoundedRectangle?.backgroundColor ?? this._backgroundColor
  }

  /**
   * @param color set current solid background color.
   */
  public set backgroundColor(color: vec4) {
    if (color === undefined) {
      return
    }
    this._backgroundColor = color
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.backgroundColor = color
    }
  }

  /**
   * Controls the background fill mode.
   */
  public get baseType(): RoundedRectangleBaseType {
    return this._baseRoundedRectangle?.baseType ?? this.getBackingBaseType()
  }

  /**
   * Controls the background fill mode.
   */
  public set baseType(baseType: RoundedRectangleBaseType) {
    if (baseType === undefined || baseType === this.baseType) {
      return
    }
    this.applyBaseMaterialState(baseType)
  }

  /**
   * @returns boolean of whether this uses a background texture.
   */
  public get useTexture(): boolean {
    return this._baseRoundedRectangle?.useTexture ?? this._useTexture
  }

  /**
   * @param use boolean of whether to use a background texture.
   */
  public set useTexture(use: boolean) {
    if (use === undefined || use === this._useTexture) {
      return
    }
    this._useTexture = use
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.useTexture = use
    }
  }

  /**
   * @returns current background texture asset.
   */
  public get texture(): Texture {
    return this._baseRoundedRectangle?.texture ?? this._texture
  }

  /**
   * @param texture set asset for background texture.
   */
  public set texture(texture: Texture) {
    if (texture === undefined) {
      return
    }
    this._texture = texture
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.texture = texture
    }
  }

  /**
   * @returns current texture mode of background texture: Stretch, Fill Height or Fill Width.
   */
  public get textureMode(): TextureMode {
    return this._baseRoundedRectangle?.textureMode ?? this._textureMode
  }

  /**
   * @param mode set texture mode of background texture: Stretch: Fill Height or Fill Width.
   */
  public set textureMode(mode: TextureMode) {
    if (mode === undefined || mode === this._textureMode) {
      return
    }
    this._textureMode = mode
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.textureMode = mode
    }
  }

  /**
   * @returns current texture wrap method: None, Repeat or Clamp.
   */
  public get textureWrap(): TextureWrap {
    return this._baseRoundedRectangle?.textureWrap ?? this._textureWrap
  }

  /**
   * @param wrap sets current texture wrap method: None, Repeat or Clamp.
   */
  public set textureWrap(wrap: TextureWrap) {
    if (wrap === undefined) {
      return
    }
    this._textureWrap = wrap
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.textureWrap = wrap
    }
  }

  /**
   * @returns boolean of whether or not the background uses a gradient.
   */
  public get gradient(): boolean {
    return this._baseRoundedRectangle?.gradient ?? this._gradient
  }

  /**
   * @param enabled boolean to enable or disable background gradient.
   */
  public set gradient(enabled: boolean) {
    if (enabled === undefined || enabled === this._gradient) {
      return
    }
    this._gradient = enabled
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.gradient = enabled
    }
  }

  /**
   * @returns type of the background gradient: Linear, or Radial.
   */
  public get gradientType(): GradientType {
    return this._baseRoundedRectangle?.gradientType ?? this._gradientType
  }

  /**
   * @param type set type of the background gradient: Linear or Radial.
   */
  public set gradientType(type: GradientType) {
    if (type === undefined || type === this._gradientType) {
      return
    }
    this._gradientType = type
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.gradientType = type
    }
  }

  /**
   * @returns vec2 of the background starting position.
   * The start position defines the range for the stops.
   */
  public get gradientStartPosition(): vec2 {
    return this._baseRoundedRectangle?.gradientStartPosition ?? this._gradientStartPosition
  }

  /**
   * @param position set vec2 of the background starting position.
   * The start position defines the range for the stops.
   */
  public set gradientStartPosition(position: vec2) {
    if (position === undefined) {
      return
    }
    this._gradientStartPosition = position
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.gradientStartPosition = position
    }
  }

  /**
   * @returns vec2 of the background ending position.
   * The end position defines the range for the stops.
   */
  public get gradientEndPosition(): vec2 {
    return this._baseRoundedRectangle?.gradientEndPosition ?? this._gradientEndPosition
  }

  /**
   * @param position set vec2 of the background ending position.
   * The end position defines the range for the stops.
   */
  public set gradientEndPosition(position: vec2) {
    if (position === undefined) {
      return
    }
    this._gradientEndPosition = position
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.gradientEndPosition = position
    }
  }

  /**
   * @returns boolean whether or not the border is enabled.
   */
  public get border(): boolean {
    return this._baseRoundedRectangle?.border ?? this._border
  }

  /**
   * @param enabled boolean to show or hide the border.
   */
  public set border(enabled: boolean) {
    if (enabled === undefined || enabled === this._border) {
      return
    }
    this._border = enabled
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.border = enabled
    }
    if (!enabled && this._baseRoundedRectangle) {
      this._borderSize = this._baseRoundedRectangle.borderSize
    }
  }

  /**
   * @returns current border thickness in centimeters in local space.
   */
  public get borderSize(): number {
    return this._baseRoundedRectangle?.borderSize ?? this._borderSize
  }

  /**
   * @param borderSize set border thickness in centimeters in local space.
   */
  public set borderSize(borderSize: number) {
    if (borderSize === undefined) {
      return
    }
    // Skip the native write when unchanged — some callers re-assert the
    // size every frame (e.g. VoiceInputButton's listening border light).
    if (borderSize === this.borderSize) {
      return
    }
    this._borderSize = borderSize
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.borderSize = borderSize
    }
  }

  /**
   * @returns width of the inner-edge border fade in local-space units.
   */
  public get borderSoftness(): number {
    return this._baseRoundedRectangle?.borderSoftness ?? this._borderSoftness
  }

  /**
   * @param borderSoftness width of the soft fade on the inner edge of the
   * border, in local-space units (same as borderSize). Guarded so it is a
   * no-op until the material exposes the `borderSoftness` uniform.
   */
  public set borderSoftness(borderSoftness: number) {
    if (borderSoftness === undefined) {
      return
    }
    this._borderSoftness = borderSoftness
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.borderSoftness = borderSoftness
    }
  }

  /**
   * @returns vec4 of the solid border color (not gradient).
   */
  public get borderColor(): vec4 {
    return this._baseRoundedRectangle?.borderColor ?? this._borderColor
  }

  /**
   * @param color set vec4 of the solid border color (not gradient).
   */
  public set borderColor(color: vec4) {
    if (color === undefined) {
      return
    }
    this._borderColor = color
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.borderColor = color
    }
  }

  /**
   * @returns which type of border: either Color or Gradient.
   */
  public get borderType(): BorderType {
    return this._baseRoundedRectangle?.borderType ?? this._borderType
  }

  /**
   * @param type set border type: either Color or Gradient.
   */
  public set borderType(type: BorderType) {
    if (type === undefined || type === this._borderType) {
      return
    }
    this._borderType = type
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.borderType = type
    }
  }

  /**
   * @returns type of gradient for the border gradient: Linear or Radial.
   */
  public get borderGradientType(): GradientType {
    return this._baseRoundedRectangle?.borderGradientType ?? this._borderGradientType
  }

  /**
   * @param type set type of gradient for the border gradient: Linear or Radial.
   */
  public set borderGradientType(type: GradientType) {
    if (type === undefined || type === this._borderGradientType) {
      return
    }
    this._borderGradientType = type
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.borderGradientType = type
    }
  }

  /**
   * @returns vec2 of current border gradient start position.
   * The start position defines the range for the stops.
   */
  public get borderGradientStartPosition(): vec2 {
    return this._baseRoundedRectangle?.borderGradientStartPosition ?? this._borderGradientStartPosition
  }

  /**
   * @param position set vec2 of the border gradient start position.
   * The start position defines the range for the stops.
   */
  public set borderGradientStartPosition(position: vec2) {
    if (position === undefined) {
      return
    }
    this._borderGradientStartPosition = position
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.borderGradientStartPosition = position
    }
  }

  /**
   * @returns vec2 of current border gradient end position.
   * The end position defines the range for the stops.
   */
  public get borderGradientEndPosition(): vec2 {
    return this._baseRoundedRectangle?.borderGradientEndPosition ?? this._borderGradientEndPosition
  }

  /**
   * @param position set vec2 of the border gradient end position.
   * The end position defines the range for the stops.
   */
  public set borderGradientEndPosition(position: vec2) {
    if (position === undefined) {
      return
    }
    this._borderGradientEndPosition = position
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.borderGradientEndPosition = position
    }
  }

  /**
   * Sets both background gradient positions and updates material uniforms once.
   */
  public setBackgroundGradientPositions(gradientStartPosition: vec2, gradientEndPosition: vec2): void {
    if (gradientStartPosition !== undefined) {
      this._gradientStartPosition = gradientStartPosition
    }
    if (gradientEndPosition !== undefined) {
      this._gradientEndPosition = gradientEndPosition
    }
    this._baseRoundedRectangle?.setBackgroundGradientPositions(gradientStartPosition, gradientEndPosition)
  }

  /**
   * Sets both border gradient positions and updates material uniforms once.
   */
  public setBorderGradientPositions(gradientStartPosition: vec2, gradientEndPosition: vec2): void {
    if (gradientStartPosition !== undefined) {
      this._borderGradientStartPosition = gradientStartPosition
    }
    if (gradientEndPosition !== undefined) {
      this._borderGradientEndPosition = gradientEndPosition
    }
    this._baseRoundedRectangle?.setBorderGradientPositions(gradientStartPosition, gradientEndPosition)
  }

  /**
   * Applies the background fill mode (Color / Gradient / Texture) in one update,
   * setting the mode flags and (when texturing) the texture-detail uniforms. Used by
   * `set baseType`.
   */
  public applyBaseMaterialState(baseType: RoundedRectangleBaseType): void {
    this._gradient = baseType === "Gradient"
    this._useTexture = baseType === "Texture"
    this._baseRoundedRectangle?.applyBaseMaterialState(baseType)
  }

  /**
   * get a stop from the background gradient at index
   * @param index: number
   * @returns GradientStop
   */
  public getBackgroundGradientStop(index: number): GradientStop {
    if (this._baseRoundedRectangle) {
      return this._baseRoundedRectangle.getBackgroundGradientStop(index)
    }
    switch (index) {
      case 0:
        return {color: this._gradientColor0, percent: this._gradientPercent0}
      case 1:
        return {color: this._gradientColor1, percent: this._gradientPercent1}
      case 2:
        return {color: this._gradientColor2, percent: this._gradientPercent2, enabled: this._gradientStop2}
      case 3:
        return {color: this._gradientColor3, percent: this._gradientPercent3, enabled: this._gradientStop3}
      case 4:
        return {color: this._gradientColor4, percent: this._gradientPercent4, enabled: this._gradientStop4}
      case 5:
        return {color: this._gradientColor5, percent: this._gradientPercent5, enabled: this._gradientStop5}
      case 6:
        return {color: this._gradientColor6, percent: this._gradientPercent6, enabled: this._gradientStop6}
      default:
        return {}
    }
  }

  /**
   * set a stop in the background gradient
   * at given index, with parameters defined by GradientStop
   * @param index: number
   * @param stop: GradientStop
   */
  public setBackgroundGradientStop(index: number, stop: GradientStop, needsUpdate: boolean = true): void {
    // Static-key writes (switch) instead of `this["_gradientColor"+index]=`. _gradientStop0/1 are
    // intentionally NOT written: they're undeclared and never read (stops 0,1 are hardcoded enabled).
    this.setBackgroundGradientStopBacking(index, stop)
    this._baseRoundedRectangle?.setBackgroundGradientStop(index, stop, needsUpdate)
  }

  private setBackgroundGradientStopBacking(index: number, stop: GradientStop): void {
    const color = stop.color
    const percent = stop.percent
    const enabled = stop.enabled !== undefined ? stop.enabled : true
    switch (index) {
      case 0:
        if (color !== undefined) {
          this._gradientColor0 = color
        }
        if (percent !== undefined) {
          this._gradientPercent0 = percent
        }
        break
      case 1:
        if (color !== undefined) {
          this._gradientColor1 = color
        }
        if (percent !== undefined) {
          this._gradientPercent1 = percent
        }
        break
      case 2:
        if (color !== undefined) {
          this._gradientColor2 = color
        }
        if (percent !== undefined) {
          this._gradientPercent2 = percent
        }
        this._gradientStop2 = enabled
        break
      case 3:
        if (color !== undefined) {
          this._gradientColor3 = color
        }
        if (percent !== undefined) {
          this._gradientPercent3 = percent
        }
        this._gradientStop3 = enabled
        break
      case 4:
        if (color !== undefined) {
          this._gradientColor4 = color
        }
        if (percent !== undefined) {
          this._gradientPercent4 = percent
        }
        this._gradientStop4 = enabled
        break
      case 5:
        if (color !== undefined) {
          this._gradientColor5 = color
        }
        if (percent !== undefined) {
          this._gradientPercent5 = percent
        }
        this._gradientStop5 = enabled
        break
      case 6:
        if (color !== undefined) {
          this._gradientColor6 = color
        }
        if (percent !== undefined) {
          this._gradientPercent6 = percent
        }
        this._gradientStop6 = enabled
        break
    }
  }

  private applyBackgroundGradientParameters(gradientParameters: GradientParameters): void {
    if (gradientParameters.enabled !== undefined && gradientParameters.enabled !== this._gradient) {
      this._gradient = gradientParameters.enabled
    }
    if (gradientParameters.type !== undefined) this._gradientType = gradientParameters.type
    if (gradientParameters.stop0) this.setBackgroundGradientStopBacking(0, gradientParameters.stop0)
    if (gradientParameters.stop1) this.setBackgroundGradientStopBacking(1, gradientParameters.stop1)
    if (gradientParameters.stop2) this.setBackgroundGradientStopBacking(2, gradientParameters.stop2)
    else if (this._gradientStop2) {
      this._gradientStop2 = false
    }
    if (gradientParameters.stop3) this.setBackgroundGradientStopBacking(3, gradientParameters.stop3)
    else if (this._gradientStop3) {
      this._gradientStop3 = false
    }
    if (gradientParameters.stop4) this.setBackgroundGradientStopBacking(4, gradientParameters.stop4)
    else if (this._gradientStop4) {
      this._gradientStop4 = false
    }
    if (gradientParameters.stop5) this.setBackgroundGradientStopBacking(5, gradientParameters.stop5)
    else if (this._gradientStop5) {
      this._gradientStop5 = false
    }
    if (gradientParameters.stop6) this.setBackgroundGradientStopBacking(6, gradientParameters.stop6)
    else if (this._gradientStop6) {
      this._gradientStop6 = false
    }
    if (gradientParameters.start !== undefined) {
      this._gradientStartPosition = gradientParameters.start
    }
    if (gradientParameters.end !== undefined) this._gradientEndPosition = gradientParameters.end
  }

  /**
   * set background gradient using a GradientParameters input
   * @param gradientParameters: GradientParameters
   */
  public setBackgroundGradient(gradientParameters: GradientParameters): void {
    this.applyBackgroundGradientParameters(gradientParameters)
    this._baseRoundedRectangle?.setBackgroundGradient(gradientParameters)
  }

  /**
   * get a stop from the border gradient at index
   * @param index: number
   * @returns GradientStop
   */
  public getBorderGradientStop(index: number): GradientStop {
    if (this._baseRoundedRectangle) {
      return this._baseRoundedRectangle.getBorderGradientStop(index)
    }
    switch (index) {
      case 0:
        return {color: this._borderGradientColor0, percent: this._borderGradientPercent0}
      case 1:
        return {color: this._borderGradientColor1, percent: this._borderGradientPercent1}
      case 2:
        return {
          color: this._borderGradientColor2,
          percent: this._borderGradientPercent2,
          enabled: this._borderGradientStop2
        }
      case 3:
        return {
          color: this._borderGradientColor3,
          percent: this._borderGradientPercent3,
          enabled: this._borderGradientStop3
        }
      case 4:
        return {
          color: this._borderGradientColor4,
          percent: this._borderGradientPercent4,
          enabled: this._borderGradientStop4
        }
      case 5:
        return {
          color: this._borderGradientColor5,
          percent: this._borderGradientPercent5,
          enabled: this._borderGradientStop5
        }
      case 6:
        return {
          color: this._borderGradientColor6,
          percent: this._borderGradientPercent6,
          enabled: this._borderGradientStop6
        }
      default:
        return {}
    }
  }

  /**
   * set a stop in the border gradient
   * at given index, with parameters defined by GradientStop
   * @param index: number
   * @param stop: GradientStop
   */
  public setBorderGradientStop(index: number, stop: GradientStop, needsUpdate: boolean = true): void {
    // Static-key writes (see setBackgroundGradientStop). _borderGradientStop0/1 are undeclared + never
    // read (stops 0,1 hardcoded enabled), so their original writes were dead.
    this.setBorderGradientStopBacking(index, stop)
    this._baseRoundedRectangle?.setBorderGradientStop(index, stop, needsUpdate)
  }

  private setBorderGradientStopBacking(index: number, stop: GradientStop): void {
    const color = stop.color
    const percent = stop.percent
    const enabled = stop.enabled !== undefined ? stop.enabled : true
    switch (index) {
      case 0:
        if (color !== undefined) {
          this._borderGradientColor0 = color
        }
        if (percent !== undefined) {
          this._borderGradientPercent0 = percent
        }
        break
      case 1:
        if (color !== undefined) {
          this._borderGradientColor1 = color
        }
        if (percent !== undefined) {
          this._borderGradientPercent1 = percent
        }
        break
      case 2:
        if (color !== undefined) {
          this._borderGradientColor2 = color
        }
        if (percent !== undefined) {
          this._borderGradientPercent2 = percent
        }
        this._borderGradientStop2 = enabled
        break
      case 3:
        if (color !== undefined) {
          this._borderGradientColor3 = color
        }
        if (percent !== undefined) {
          this._borderGradientPercent3 = percent
        }
        this._borderGradientStop3 = enabled
        break
      case 4:
        if (color !== undefined) {
          this._borderGradientColor4 = color
        }
        if (percent !== undefined) {
          this._borderGradientPercent4 = percent
        }
        this._borderGradientStop4 = enabled
        break
      case 5:
        if (color !== undefined) {
          this._borderGradientColor5 = color
        }
        if (percent !== undefined) {
          this._borderGradientPercent5 = percent
        }
        this._borderGradientStop5 = enabled
        break
      case 6:
        if (color !== undefined) {
          this._borderGradientColor6 = color
        }
        if (percent !== undefined) {
          this._borderGradientPercent6 = percent
        }
        this._borderGradientStop6 = enabled
        break
    }
  }

  private applyBorderGradientParameters(gradientParameters: GradientParameters): void {
    if (gradientParameters.enabled !== undefined) {
      const borderType = gradientParameters.enabled ? "Gradient" : "Color"
      if (borderType !== this._borderType) {
        this._borderType = borderType
      }
    }
    if (gradientParameters.type !== undefined) this._borderGradientType = gradientParameters.type
    if (gradientParameters.stop0) this.setBorderGradientStopBacking(0, gradientParameters.stop0)
    if (gradientParameters.stop1) this.setBorderGradientStopBacking(1, gradientParameters.stop1)
    if (gradientParameters.stop2) this.setBorderGradientStopBacking(2, gradientParameters.stop2)
    else if (this._borderGradientStop2) {
      this._borderGradientStop2 = false
    }
    if (gradientParameters.stop3) this.setBorderGradientStopBacking(3, gradientParameters.stop3)
    else if (this._borderGradientStop3) {
      this._borderGradientStop3 = false
    }
    if (gradientParameters.stop4) this.setBorderGradientStopBacking(4, gradientParameters.stop4)
    else if (this._borderGradientStop4) {
      this._borderGradientStop4 = false
    }
    if (gradientParameters.stop5) this.setBorderGradientStopBacking(5, gradientParameters.stop5)
    else if (this._borderGradientStop5) {
      this._borderGradientStop5 = false
    }
    if (gradientParameters.stop6) this.setBorderGradientStopBacking(6, gradientParameters.stop6)
    else if (this._borderGradientStop6) {
      this._borderGradientStop6 = false
    }
    if (gradientParameters.start !== undefined) {
      this._borderGradientStartPosition = gradientParameters.start
    }
    if (gradientParameters.end !== undefined) this._borderGradientEndPosition = gradientParameters.end
  }

  /**
   * set border gradient using a GradientParameters input
   * @param gradientParameters: GradientParameters
   */
  public setBorderGradient(gradientParameters: GradientParameters): void {
    this.applyBorderGradientParameters(gradientParameters)
    this._baseRoundedRectangle?.setBorderGradient(gradientParameters)
  }

  /**
   * Set Material asset that is cloned on initialize
   */
  public set material(material: Material) {
    if (material === undefined) {
      return
    }
    this._material = material
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.material = material
    }
  }

  /**
   * Get Material asset that is cloned on initialize
   */
  public get material(): Material {
    return this._baseRoundedRectangle?.material ?? this._material
  }

  /**
   * Prints the current configuration of the RoundedRectangle
   * to the console in a readable format.
   * Useful for debugging and understanding the current state.
   */
  public printConfig(): void {
    if (this._baseRoundedRectangle) {
      this._baseRoundedRectangle.printConfig()
      return
    }

    const configOutput: any = {}

    configOutput.size = this.size
    configOutput.cornerRadius = this.cornerRadius

    configOutput.background = {}
    if (this.gradient) {
      configOutput.backgroundGradient = {}
      configOutput.backgroundGradient.type = this.gradientType
      configOutput.backgroundGradient.start = this.gradientStartPosition
      configOutput.backgroundGradient.end = this.gradientEndPosition
      configOutput.backgroundGradient.stop0 = this.getBackgroundGradientStop(0)
      configOutput.backgroundGradient.stop1 = this.getBackgroundGradientStop(1)
      configOutput.backgroundGradient.stop2 = this.getBackgroundGradientStop(2)
      configOutput.backgroundGradient.stop3 = this.getBackgroundGradientStop(3)
      configOutput.backgroundGradient.stop4 = this.getBackgroundGradientStop(4)
      configOutput.backgroundGradient.stop5 = this.getBackgroundGradientStop(5)
      configOutput.backgroundGradient.stop6 = this.getBackgroundGradientStop(6)
    } else if (this.useTexture) {
      configOutput.texture = this.texture
      configOutput.textureMode = this.textureMode
      configOutput.textureWrap = this.textureWrap
    } else {
      configOutput.backgroundColor = this.backgroundColor
    }

    if (this.border) {
      configOutput.border = {}
      configOutput.border.borderSize = this.borderSize
      if (this.borderType === "Gradient") {
        configOutput.borderGradient = {}
        configOutput.borderGradient.type = this.borderGradientType
        configOutput.borderGradient.start = this.borderGradientStartPosition
        configOutput.borderGradient.end = this.borderGradientEndPosition
        configOutput.borderGradient.stop0 = this.getBorderGradientStop(0)
        configOutput.borderGradient.stop1 = this.getBorderGradientStop(1)
        configOutput.borderGradient.stop2 = this.getBorderGradientStop(2)
        configOutput.borderGradient.stop3 = this.getBorderGradientStop(3)
        configOutput.borderGradient.stop4 = this.getBorderGradientStop(4)
        configOutput.borderGradient.stop5 = this.getBorderGradientStop(5)
        configOutput.borderGradient.stop6 = this.getBorderGradientStop(6)
      } else {
        configOutput.border.color = this.borderColor
      }
    }

    log.d("RoundedRectangle Configuration:")
    log.d(formatLensValue(configOutput))
  }

  private getBackingBaseType(): RoundedRectangleBaseType {
    if (this._useTexture) {
      return "Texture"
    }
    if (this._gradient) {
      return "Gradient"
    }
    return "Color"
  }

  private createBaseConfig(): BaseRoundedRectangleConfig {
    return {
      size: this._size,
      cornerRadius: this._cornerRadius,
      blendMode: this._blendMode,
      opacity: this._opacity,
      background: {
        color: this._backgroundColor,
        gradient: this._gradient,
        useTexture: this._useTexture,
        texture: this._texture,
        textureMode: this._textureMode,
        textureWrap: this._textureWrap,
        gradientConfig: this.createBackgroundGradientConfig()
      },
      border: {
        enabled: this._border,
        size: this._borderSize,
        softness: this._borderSoftness,
        color: this._borderColor,
        type: this._borderType,
        gradientConfig: this.createBorderGradientConfig()
      }
    }
  }

  private createBackgroundGradientConfig(): BaseGradientConfig {
    return {
      type: this._gradientType,
      start: this._gradientStartPosition,
      end: this._gradientEndPosition,
      stop0: {color: this._gradientColor0, percent: this._gradientPercent0, enabled: true},
      stop1: {color: this._gradientColor1, percent: this._gradientPercent1, enabled: true},
      stop2: {color: this._gradientColor2, percent: this._gradientPercent2, enabled: this._gradientStop2},
      stop3: {color: this._gradientColor3, percent: this._gradientPercent3, enabled: this._gradientStop3},
      stop4: {color: this._gradientColor4, percent: this._gradientPercent4, enabled: this._gradientStop4},
      stop5: {color: this._gradientColor5, percent: this._gradientPercent5, enabled: this._gradientStop5},
      stop6: {color: this._gradientColor6, percent: this._gradientPercent6, enabled: this._gradientStop6}
    }
  }

  private createBorderGradientConfig(): BaseGradientConfig {
    return {
      type: this._borderGradientType,
      start: this._borderGradientStartPosition,
      end: this._borderGradientEndPosition,
      stop0: {color: this._borderGradientColor0, percent: this._borderGradientPercent0, enabled: true},
      stop1: {color: this._borderGradientColor1, percent: this._borderGradientPercent1, enabled: true},
      stop2: {
        color: this._borderGradientColor2,
        percent: this._borderGradientPercent2,
        enabled: this._borderGradientStop2
      },
      stop3: {
        color: this._borderGradientColor3,
        percent: this._borderGradientPercent3,
        enabled: this._borderGradientStop3
      },
      stop4: {
        color: this._borderGradientColor4,
        percent: this._borderGradientPercent4,
        enabled: this._borderGradientStop4
      },
      stop5: {
        color: this._borderGradientColor5,
        percent: this._borderGradientPercent5,
        enabled: this._borderGradientStop5
      },
      stop6: {
        color: this._borderGradientColor6,
        percent: this._borderGradientPercent6,
        enabled: this._borderGradientStop6
      }
    }
  }
}

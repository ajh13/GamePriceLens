import {OpacityControllable} from "../../Interfaces/OpacityControllable"
import {SYSTEM_2_NAME, SYSTEM_3_NAME} from "../../Themes/Theme"
import {RoundedRectangleVisual} from "../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {BaseButton} from "./BaseButton"

export abstract class BaseRoundedRectButton extends BaseButton implements OpacityControllable {
  @input
  @showIf("_themeOverride", "System2")
  @label("Style")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("PrimaryNeutral", "PrimaryNeutral"),
      new ComboBoxItem("Primary", "Primary"),
      new ComboBoxItem("Secondary", "Secondary"),
      new ComboBoxItem("Special", "Special"),
      new ComboBoxItem("Ghost", "Ghost")
    ])
  )
  protected _styleSystem2: string = "PrimaryNeutral"

  @input
  @showIf("_themeOverride", "System3")
  @label("Style")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Primary", "Primary"),
      new ComboBoxItem("Secondary", "Secondary"),
      new ComboBoxItem("Ghost", "Ghost")
    ])
  )
  protected _styleSystem3: string = "Primary"

  protected get effectiveStyle(): string {
    switch (this.resolveTheme().name) {
      case SYSTEM_2_NAME:
        return this._styleSystem2
      case SYSTEM_3_NAME:
        return this._styleSystem3
      default:
        return this.resolveTheme().defaultStyleName
    }
  }

  @input
  @widget(new SliderWidget(0, 1))
  protected _opacity: number = 1.0

  /**
   * Controls the opacity of this button's visual.
   */
  public get opacity(): number {
    const visual = this.getVisualAsRoundedRectVisual()
    return visual ? visual.opacity : this._opacity
  }

  /**
   * Sets the opacity of this button's visual.
   *
   * @param opacity - Opacity value in the range [0, 1].
   * @see opacity
   */
  public set opacity(opacity: number) {
    this._opacity = opacity
    const visual = this.getVisualAsRoundedRectVisual()
    if (!visual) {
      return
    }
    if (!this.isAlwaysTransparent) {
      visual.transparencyEnabled = opacity < 1.0
    }
    visual.opacity = opacity
  }

  /**
   * Hook for concrete buttons to configure properties on the default rounded-rect visual
   * (e.g. corner radius).
   *
   * @param visual - The default rounded-rect visual instance created for this button.
   */
  protected abstract configureDefaultRoundedRectVisual(visual: RoundedRectangleVisual): void

  protected getVisualAsRoundedRectVisual(): RoundedRectangleVisual | undefined {
    if (!this._visual) {
      return undefined
    }
    if (!(this._visual instanceof RoundedRectangleVisual)) {
      throw new Error(
        `${this.typeString} expected visual to be RoundedRectangleVisual, got ${this._visual.constructor.name}`
      )
    }
    return this._visual as RoundedRectangleVisual
  }

  protected createDefaultVisual(): void {
    if (this._visual) {
      return
    }

    const alwaysTransparent = this.isAlwaysTransparent
    const defaultVisual: RoundedRectangleVisual = new RoundedRectangleVisual({
      sceneObject: this.sceneObject,
      style: {
        visualElementType: this.typeString,
        style: this.effectiveStyle,
        themeName: this.normalizedThemeOverride !== "Inherited" ? this.normalizedThemeOverride : undefined
      },
      transparent: alwaysTransparent || this._opacity < 1.0
    })
    this.configureDefaultRoundedRectVisual(defaultVisual)
    defaultVisual.opacity = this._opacity
    this._visual = defaultVisual
  }

  protected get isAlwaysTransparent(): boolean {
    const style = this.effectiveStyle
    // Ghost and Secondary are outline styles with a transparent fill, so they
    // need alpha blending (PremultipliedAlphaAuto) even at full opacity.
    // Otherwise the default Disabled (opaque) blend mode ignores the fill's
    // alpha and the transparent background renders as solid.
    return style === "Ghost" || style === "Secondary"
  }
}

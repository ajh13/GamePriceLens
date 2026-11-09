import {
  RoundedRectangleVisual,
  RoundedRectangleVisualParameters
} from "../../Visuals/RoundedRectangle/RoundedRectangleVisual"

import {unsubscribe} from "InteractionKit.lspkg/Utils/Event"
import {SecondaryGradients} from "../../../Scripts/Themes/System-2.0/Gradients/SecondaryGradients"
import {PrimaryGradients} from "../../Themes/System-2.0/Gradients/PrimaryGradients"
import {SYSTEM_3_NAME} from "../../Themes/Theme"
import {isEqual} from "../../Utility/UIKitUtilities"
import {Visual} from "../../Visuals/Visual"
import {StateName} from "../Element"
import {RadioButton} from "./RadioButton"

// Local +Z steps for the toggled fill and for the checkmark (a child of the
// fill, so its step is relative). Draw order comes from the button's Hierarchy
// Canvas — base, then fill, then mark, all at one flat renderOrder — so these
// steps only keep depth testing from rejecting a later, nearer layer.
const DEFAULT_TOGGLED_VISUAL_DEPTH = 0.01
const DEFAULT_CHECK_VISUAL_DEPTH = 0.02

// Fallback when the resolved theme does not provide a CheckboxMark style.
// Uses the System 2.0 textures so the legacy default theme keeps working when
// CheckboxMark is unregistered.
const FALLBACK_CHECK_TEXTURES: {default: Texture; hovered: Texture; toggled: Texture} = {
  default: requireAsset("../../../Textures/check_default.png") as Texture,
  hovered: requireAsset("../../../Textures/check_hovered.png") as Texture,
  toggled: requireAsset("../../../Textures/check_toggledHovered.png") as Texture
}

const DEFAULT_CHECK_VISUAL_PARAMETERS: Partial<RoundedRectangleVisualParameters> = {
  default: {
    baseType: "Texture",
    baseTexture: FALLBACK_CHECK_TEXTURES.default,
    hasBorder: false,
    shouldScale: false,
    shouldPosition: false,
    localScale: new vec3(1, 1, 1),
    localPosition: new vec3(0, 0, 0)
  },
  hovered: {
    baseTexture: FALLBACK_CHECK_TEXTURES.hovered
  },
  toggledDefault: {
    baseTexture: FALLBACK_CHECK_TEXTURES.default
  },
  toggledHovered: {
    baseTexture: FALLBACK_CHECK_TEXTURES.toggled
  },
  toggledTriggered: {
    baseTexture: FALLBACK_CHECK_TEXTURES.toggled
  }
}

const DEFAULT_VISUAL_PARAMETERS: Partial<RoundedRectangleVisualParameters> = {
  default: {
    baseType: "Gradient",
    baseGradient: SecondaryGradients.defaultBackground,
    hasBorder: true,
    borderType: "Gradient",
    borderGradient: SecondaryGradients.defaultBorder,
    shouldScale: false,
    shouldPosition: false,
    localScale: new vec3(1, 1, 1),
    localPosition: new vec3(0, 0, 0)
  },
  hovered: {
    baseGradient: SecondaryGradients.hoverBackground,
    borderGradient: SecondaryGradients.hoverBorder
  },
  toggledDefault: {
    baseGradient: PrimaryGradients.defaultBackground,
    borderGradient: PrimaryGradients.defaultBorder
  },
  toggledHovered: {
    baseGradient: PrimaryGradients.hoverBackground,
    borderGradient: PrimaryGradients.triggeredBorder
  }
}

const DEFAULT_TOGGLED_VISUAL_PARAMETERS: Partial<RoundedRectangleVisualParameters> = {
  default: {
    baseType: "Gradient",
    baseGradient: {
      enabled: true,
      type: "Linear",
      stop0: {
        enabled: false,
        percent: 0,
        color: vec4.zero()
      },
      stop1: {
        enabled: false,
        percent: 1,
        color: vec4.zero()
      }
    },
    hasBorder: false,
    shouldScale: false,
    shouldPosition: false,
    localScale: new vec3(1, 1, 1),
    localPosition: new vec3(0, 0, 0)
  },
  toggledDefault: {
    baseGradient: PrimaryGradients.triggeredBackground,
    hasBorder: true,
    borderSize: 0.05,
    borderType: "Gradient",
    borderGradient: PrimaryGradients.triggeredBorder
  }
}

const TOGGLED_WIDTH_RATIO = 0.8
const CHECK_MARK_SIZE_RATIO = 0.7

/**
 * Checkbox-style button derived from `RadioButton`.
 *
 * Composition:
 * - Base `RoundedRectangleVisual` (cornerRadius = cornerRadiusFactor × size)
 * - "Toggled" `RoundedRectangleVisual` above the base
 * - Checkmark `RoundedRectangleVisual` (child of the toggled visual) whose
 *   per-state `baseTexture` swaps between the pre-colored checkmark textures
 *   defined by the resolved theme's `CheckboxMark` style.
 *
 * Layering: all three share the button's `renderOrder`. The button's Canvas
 * (Hierarchy sorting, see BaseButton.managesDrawOrderCanvas) draws them in
 * tree order — base on this object, toggled fill as a child, checkmark as a
 * grandchild — and the small +Z steps only keep depth testing from rejecting
 * a later, nearer layer. No renderOrder bumps. Developer-owned children are
 * kept in the foreground (VisualElement.addChild); while any are present the
 * fill and the mark stop writing depth so hierarchy order decides.
 *
 * Sizing:
 * - `_width` controls the base size (`width` setter updates it)
 * - `_toggledWidth` controls the toggled visual size
 * - `_checkMarkSize` controls the checkmark size (`checkMarkWidth` mirrors it)
 */
@component
export class Checkbox extends RadioButton {
  @input
  @showIf("_themeOverride", "System3")
  @label("Style")
  @widget(
    new ComboBoxWidget([new ComboBoxItem("Default", "Default"), new ComboBoxItem("ListCheckbox", "ListCheckbox")])
  )
  protected _styleSystem3: string = "Default"

  protected get cornerRadiusFactor(): number {
    const data = this.resolveTheme()?.componentData?.["Checkbox"] as {cornerRadiusFactor?: number} | undefined
    return data?.cornerRadiusFactor ?? 0.25
  }

  /** Corner radius (cm) for the inner fill, concentric with the outer box. */
  protected override get toggledCornerRadius(): number {
    return this.getConcentricCornerRadius(this._toggledWidth)
  }

  /** Corner radius (cm) for the check-mark mask, concentric with the outer box. */
  protected get checkMarkCornerRadius(): number {
    return this.getConcentricCornerRadius(this._checkMarkSize)
  }

  private getConcentricCornerRadius(innerWidth: number): number {
    const outerRadius = this._width * this.cornerRadiusFactor
    const inset = (this._width - innerWidth) / 2
    return Math.max(0, outerRadius - inset)
  }

  protected get effectiveStyle(): string {
    const isSystem3 = this.normalizedThemeOverride === SYSTEM_3_NAME || this.resolveTheme()?.name === SYSTEM_3_NAME
    return isSystem3 ? this._styleSystem3 : "default"
  }

  @input
  @label("Size")
  protected _width: number = 2.5

  protected _toggledWidth: number = this._width * TOGGLED_WIDTH_RATIO

  protected _checkMarkSize: number = this._width * CHECK_MARK_SIZE_RATIO

  protected _checkMarkVisual: Visual | null = null
  private checkVisualEventHandlerUnsubscribes: unsubscribe[] = []

  /**
   * Gets the render order of the Checkbox.
   */
  public get renderOrder(): number {
    return this._renderOrder
  }

  /**
   * Sets the render order of the Checkbox and its toggled and check visuals.
   *
   * All three share the base order; the toggled fill and the checkmark draw
   * above the base by hierarchy order under the button's Canvas, not by a
   * renderOrder bump (a bump would outrank the Canvas and escape sibling
   * chrome such as edge fades).
   *
   * @param order - The base render order for the Checkbox.
   */
  public set renderOrder(order: number) {
    if (order === undefined) {
      return
    }
    super.renderOrder = order
    if (this._initialized && this._checkMarkVisual) {
      this._checkMarkVisual.renderMeshVisual.renderOrder = order
    }
  }

  /**
   * Gets the check visual of the Checkbox.
   *
   * @returns {Visual | null} The visual object representing the check visual.
   */
  public get checkVisual(): Visual | null {
    return this._checkMarkVisual
  }

  /**
   * Sets the check visual.
   *
   * Replaces any existing check visual, applies sizing, and syncs state. Draw
   * order is hierarchy order under the button's Canvas, so a replacement must
   * live under the toggled visual's SceneObject (or later in this object's
   * child order) to draw above the fill — it gets the flat base renderOrder,
   * not a bump.
   *
   * @param value - The new check visual.
   */
  public set checkVisual(value: Visual | null) {
    if (isEqual<Visual | null>(this._checkMarkVisual, value)) {
      return
    }
    this.destroyCheckVisual()
    this._checkMarkVisual = value
    if (this._initialized && this._checkMarkVisual) {
      this.configureCheckVisual()
      this._checkMarkVisual.renderMeshVisual.renderOrder = this._renderOrder
      this._checkMarkVisual.size = new vec3(this._checkMarkSize, this._checkMarkSize, 1)
      ;(this._checkMarkVisual as RoundedRectangleVisual).cornerRadius = this.checkMarkCornerRadius
      this._checkMarkVisual.setState(this.stateName)
      this.applyIntermediateFillDepthWritePolicy()
    }
  }

  /**
   * Gets the size of the Checkbox button.
   *
   * @returns {number} The width of the Checkbox.
   */
  public get width(): number {
    return this._width
  }

  /**
   * Sets the size of the Checkbox button.
   * Uses a corner radius of cornerRadiusFactor × size for a less rounded base than a radio button.
   *
   * @param width - The new size of the Checkbox.
   */
  public set width(width: number) {
    if (width === undefined) {
      return
    }
    this._width = width
    if (this._initialized) {
      this.size = new vec3(width, width, 1)
      ;(this.visual as RoundedRectangleVisual).cornerRadius = width * this.cornerRadiusFactor
    }
    this.toggledWidth = width * TOGGLED_WIDTH_RATIO
    this.checkMarkWidth = width * CHECK_MARK_SIZE_RATIO
  }

  /**
   * Sets the current visual state of the checkbox and its toggled / checkmark visuals.
   *
   * Forwards the state to `_checkMarkVisual` so it swaps between the
   * pre-colored textures resolved from the theme's `CheckboxMark` style.
   *
   * @param stateName - The state to apply.
   */
  public setState(stateName: StateName): void {
    super.setState(stateName)
    if (this._initialized && this._checkMarkVisual) {
      this._checkMarkVisual.setState(stateName)
    }
  }

  public initialize(): boolean {
    if (!super.initialize()) {
      return false
    }

    if (this._checkMarkVisual) {
      this._checkMarkVisual.renderMeshVisual.renderOrder = this._renderOrder
      this._checkMarkVisual.size = new vec3(this._checkMarkSize, this._checkMarkSize, 1)
      ;(this._checkMarkVisual as RoundedRectangleVisual).cornerRadius = this.checkMarkCornerRadius
    }

    this.configureCheckVisual()
    return true
  }

  protected createDefaultVisual(): void {
    const theme = this.resolveTheme()
    const styleName = this.effectiveStyle
    const baseStyle = theme.styles["Checkbox"]?.[styleName] ?? DEFAULT_VISUAL_PARAMETERS
    const toggledStyle = theme.styles["CheckboxToggled"]?.[styleName] ?? DEFAULT_TOGGLED_VISUAL_PARAMETERS
    const markStyle = theme.styles["CheckboxMark"]?.[styleName] ?? DEFAULT_CHECK_VISUAL_PARAMETERS

    if (!this._visual) {
      const defaultVisual: RoundedRectangleVisual = new RoundedRectangleVisual({
        sceneObject: this.sceneObject,
        style: baseStyle
      })
      defaultVisual.cornerRadius = this._width * this.cornerRadiusFactor
      this._visual = defaultVisual
    }

    if (!this._toggledVisual) {
      const toggledVisualObject = global.scene.createSceneObject("ToggledVisual")
      this.managedSceneObjects.add(toggledVisualObject)
      toggledVisualObject.setParent(this.sceneObject)
      toggledVisualObject.getTransform().setLocalPosition(new vec3(0, 0, DEFAULT_TOGGLED_VISUAL_DEPTH))
      const defaultToggledVisual = new RoundedRectangleVisual({
        sceneObject: toggledVisualObject,
        style: toggledStyle,
        transparent: true
      })
      defaultToggledVisual.cornerRadius = this.toggledCornerRadius
      this._toggledVisual = defaultToggledVisual
    }

    if (!this._checkMarkVisual) {
      const checkVisualObject = global.scene.createSceneObject("CheckVisual")
      this.managedSceneObjects.add(checkVisualObject)
      checkVisualObject.setParent(this._toggledVisual.sceneObject)
      checkVisualObject.getTransform().setLocalPosition(new vec3(0, 0, DEFAULT_CHECK_VISUAL_DEPTH))
      const visual = new RoundedRectangleVisual({
        sceneObject: checkVisualObject,
        style: markStyle,
        transparent: true
      })
      visual.cornerRadius = this.checkMarkCornerRadius
      visual.size = new vec3(this._checkMarkSize, this._checkMarkSize, 1)
      this._checkMarkVisual = visual
    }
  }

  protected onEnabled() {
    super.onEnabled()
    if (this._initialized) {
      this._checkMarkVisual?.enable()
    }
  }

  protected onDisabled() {
    super.onDisabled()
    if (this._initialized) {
      this._checkMarkVisual?.disable()
    }
  }

  protected release(): void {
    this.destroyCheckVisual()
    super.release()
  }

  /** @see RadioButton.applyIntermediateFillDepthWritePolicy — the mark is an intermediate layer too. */
  protected applyIntermediateFillDepthWritePolicy(): void {
    super.applyIntermediateFillDepthWritePolicy()
    if (!isNull(this._checkMarkVisual) && this._checkMarkVisual) {
      this._checkMarkVisual.depthWrite = this.intermediateFillDepthWrite
    }
  }

  private configureCheckVisual(): void {
    if (this._checkMarkVisual) {
      this.checkVisualEventHandlerUnsubscribes.push(
        this._checkMarkVisual.onDestroyed.add(() => {
          this._checkMarkVisual = null
        })
      )
    }
  }

  private destroyCheckVisual(): void {
    this.checkVisualEventHandlerUnsubscribes.forEach((unsubscribe) => unsubscribe())
    this.checkVisualEventHandlerUnsubscribes = []
    if (this._checkMarkVisual) {
      this._checkMarkVisual.destroy()
      this._checkMarkVisual = null
    }
  }

  /**
   * Gets the size of the toggled visual.
   *
   * @returns {number} The width of the toggled visual.
   */
  protected get toggledWidth(): number {
    return this._toggledWidth
  }

  /**
   * Sets the size of the toggled visual.
   * Uses an outer-radius-minus-inset corner radius so it stays concentric.
   *
   * @param width - The new size of the toggled visual.
   */
  protected set toggledWidth(width: number) {
    if (width === undefined) {
      return
    }
    if (isEqual<number>(this._toggledWidth, width)) {
      return
    }
    this._toggledWidth = width
    if (this._initialized && this._toggledVisual) {
      this._toggledVisual.size = new vec3(width, width, 1)
      ;(this._toggledVisual as RoundedRectangleVisual).cornerRadius = this.toggledCornerRadius
    }
  }

  /**
   * Gets the size of the checkmark.
   *
   * @returns {number} The width of the checkmark.
   */
  protected get checkMarkWidth(): number {
    return this._checkMarkSize
  }

  /**
   * Sets the size of the checkmark visual.
   *
   * @param width - The new width of the checkmark.
   */
  protected set checkMarkWidth(width: number) {
    if (width === undefined) {
      return
    }
    if (isEqual<number>(this._checkMarkSize, width)) {
      return
    }
    this._checkMarkSize = width
    if (!this._initialized) {
      return
    }
    if (this._checkMarkVisual) {
      this._checkMarkVisual.size = new vec3(width, width, 1)
      ;(this._checkMarkVisual as RoundedRectangleVisual).cornerRadius = this.checkMarkCornerRadius
    }
  }
}

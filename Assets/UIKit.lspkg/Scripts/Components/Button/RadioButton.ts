import {
  RoundedRectangleVisual,
  RoundedRectangleVisualParameters
} from "../../Visuals/RoundedRectangle/RoundedRectangleVisual"

import {unsubscribe} from "InteractionKit.lspkg/Utils/Event"
import {SecondaryGradients} from "../../../Scripts/Themes/System-2.0/Gradients/SecondaryGradients"
import {PrimaryGradients} from "../../Themes/System-2.0/Gradients/PrimaryGradients"
import {Z_LAYER_STEP} from "../../Utility/DrawOrderLayering"
import {isEqual} from "../../Utility/UIKitUtilities"
import {Visual} from "../../Visuals/Visual"
import {StateName} from "../Element"
import {BaseButton} from "./BaseButton"

// Local +Z step for the toggled dot. Draw order comes from the button's
// Hierarchy Canvas (base on this object, dot as a child) at one flat
// renderOrder; the step only keeps depth testing from rejecting the dot.
// Z_LAYER_STEP (0.05 cm) is the minimum that stays clear of z-fighting at
// panel distance — this is where that figure was first recorded.
const DEFAULT_TOGGLED_VISUAL_DEPTH = Z_LAYER_STEP

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
  },
  toggledHovered: {
    baseGradient: PrimaryGradients.triggeredBackground,
    hasBorder: true,
    borderSize: 0.05,
    borderType: "Gradient",
    borderGradient: PrimaryGradients.triggeredBorder
  },
  toggledTriggered: {
    baseGradient: PrimaryGradients.triggeredBackground,
    hasBorder: true,
    borderSize: 0.05,
    borderType: "Gradient",
    borderGradient: PrimaryGradients.triggeredBorder
  }
}

const TOGGLED_WIDTH_RATIO = 0.8

/**
 * A circular toggle-style button with an inner toggled visual (dot).
 *
 * The outer button size is controlled by `_width`; the inner dot size is
 * controlled by `_toggledWidth`. Both visuals are `RoundedRectangleVisual`s
 * with corner radii set to half of their widths. Both share the button's
 * `renderOrder`: the dot draws above the base by hierarchy order under the
 * button's Canvas (see BaseButton.managesDrawOrderCanvas), with a small +Z
 * step that only guards depth testing. Developer-owned children are kept in
 * the foreground (VisualElement.addChild); while any are present the dot stops
 * writing depth so hierarchy order — not the dot's depth — decides.
 */
@component
export class RadioButton extends BaseButton {
  /**
   *  add per-theme styles, add @input fields like:
   *
   * @input
   * @showIf("_themeOverride", "System3")
   * @label("Style")
   * @widget(new ComboBoxWidget([
   *   new ComboBoxItem("StyleName", "StyleName"),
   * ]))
   * protected _styleSystem3: string = "StyleName"
   */

  @input
  protected _width: number = 2.5

  protected _toggledWidth: number = this._width * TOGGLED_WIDTH_RATIO

  /** Corner radius for the inner toggled visual. */
  protected get toggledCornerRadius(): number {
    return this._toggledWidth * 0.5
  }

  protected _size: vec3 = new vec3(this._width, this._width, 1)

  protected _toggledVisual: Visual
  private toggledVisualEventHandlerUnsubscribes: unsubscribe[] = []

  /**
   * Gets the render order of the RadioButton.
   */
  public get renderOrder(): number {
    return this._renderOrder
  }

  /**
   * Sets the render order of the RadioButton and its toggled visual.
   *
   * The toggled visual shares the base render order; it draws above the base
   * by hierarchy order under the button's Canvas, not by a renderOrder bump.
   *
   * @param order - The base render order for the RadioButton.
   */
  public set renderOrder(order: number) {
    if (order === undefined) {
      return
    }
    super.renderOrder = order
    if (this._initialized) {
      if (this._toggledVisual) {
        this._toggledVisual.renderMeshVisual.renderOrder = order
      }
    }
  }

  /**
   * Controls whether the base visual writes depth. The base owns depth
   * occlusion for the whole button; the toggled dot follows it except while
   * developer-owned foreground children are present.
   *
   * @see applyIntermediateFillDepthWritePolicy
   */
  public get depthWrite(): boolean {
    return super.depthWrite
  }

  public set depthWrite(depthWrite: boolean) {
    super.depthWrite = depthWrite
    if (this._initialized) {
      this.applyIntermediateFillDepthWritePolicy()
    }
  }

  /**
   * Gets the visual representation of the RadioButton's toggled visual.
   *
   * @returns {Visual} The visual object representing the toggled visual.
   */
  public get toggledVisual(): Visual {
    return this._toggledVisual
  }

  /**
   * Sets the visual used when the RadioButton is in the toggled state.
   *
   * Replaces any existing toggled visual, applies sizing, and syncs state. Draw
   * order is hierarchy order under the button's Canvas, so a replacement must
   * live on a child of this SceneObject to draw above the base — it gets the
   * flat base renderOrder, not a bump.
   *
   * @param value - The new toggled visual.
   */
  public set toggledVisual(value: Visual) {
    if (value === undefined) {
      return
    }
    if (isEqual<Visual>(this._toggledVisual, value)) {
      return
    }
    this.destroyToggledVisual()
    this._toggledVisual = value
    if (this._initialized) {
      this.configureToggledVisual()
      this._toggledVisual.size = new vec3(this._toggledWidth, this._toggledWidth, 1)
      ;(this._toggledVisual as RoundedRectangleVisual).cornerRadius = this.toggledCornerRadius
      this._toggledVisual.setState(this.stateName)
      this.applyIntermediateFillDepthWritePolicy()
    }
  }

  /**
   * Gets the width (diameter) of the RadioButton.
   *
   * @returns {number} The width of the RadioButton.
   */
  public get width(): number {
    return this._width
  }

  /**
   * Sets the width (diameter) of the RadioButton.
   * Updates the base visual size and corner radius when initialized.
   *
   * @param width - The new width of the RadioButton.
   */
  public set width(width: number) {
    if (width === undefined) {
      return
    }
    this._width = width
    if (this._initialized) {
      this.size = new vec3(width, width, 1)
      ;(this.visual as RoundedRectangleVisual).cornerRadius = width * 0.5
    }
    this.toggledWidth = width * TOGGLED_WIDTH_RATIO
  }

  /**
   * Sets the current visual state of the RadioButton and its toggled visual.
   *
   * @param stateName - The state to apply.
   */
  public setState(stateName: StateName): void {
    super.setState(stateName)
    if (this._initialized) {
      this._toggledVisual.setState(stateName)
    }
  }

  /**
   * Initializes the RadioButton, creating and configuring visuals as needed.
   * Also sets the initial enabled state for the toggled visual.
   */
  public initialize(): boolean {
    if (!super.initialize()) {
      return false
    }
    this._size = new vec3(this._width, this._width, 1)

    if (this._toggledVisual) {
      this._toggledVisual.renderMeshVisual.renderOrder = this._renderOrder
    }

    this.configureToggledVisual()
    return true
  }

  protected createDefaultVisual(): void {
    const theme = this.resolveTheme()
    const baseStyle = theme.styles["RadioButton"]?.["default"] ?? DEFAULT_VISUAL_PARAMETERS
    const toggledStyle = theme.styles["RadioButtonToggled"]?.["default"] ?? DEFAULT_TOGGLED_VISUAL_PARAMETERS

    if (!this._visual) {
      const defaultVisual: RoundedRectangleVisual = new RoundedRectangleVisual({
        sceneObject: this.sceneObject,
        style: baseStyle
      })
      defaultVisual.cornerRadius = this._width * 0.5
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
      defaultToggledVisual.shouldColorChange = true
      this._toggledVisual = defaultToggledVisual
    }
  }

  protected configureVisual(): void {
    super.configureVisual()
    if (this._visual) {
      this.visualEventHandlerUnsubscribes.push(
        this._visual.onDestroyed.add(() => {
          this._toggledVisual = null
        })
      )

      this._visual.size = new vec3(this._width, this._width, 1)
    }
  }

  protected onContentChildrenChanged(): void {
    super.onContentChildrenChanged()
    this.applyIntermediateFillDepthWritePolicy()
  }

  /**
   * The base visual owns depth occlusion for the button. The toggled dot is an
   * intermediate layer: it writes depth like the base except while
   * developer-owned foreground children are present, so a child at z≈0 that
   * hierarchy order places above the dot is not depth-rejected by it. Checkbox
   * extends this to its checkmark.
   */
  protected applyIntermediateFillDepthWritePolicy(): void {
    if (!isNull(this._toggledVisual) && this._toggledVisual) {
      this._toggledVisual.depthWrite = this.intermediateFillDepthWrite
    }
  }

  private configureToggledVisual(): void {
    if (this._toggledVisual) {
      this.toggledVisualEventHandlerUnsubscribes.push(
        this._toggledVisual.onDestroyed.add(() => {
          this._toggledVisual = null
        })
      )

      this._toggledVisual.size = new vec3(this._toggledWidth, this._toggledWidth, 1)
    }
  }

  private destroyToggledVisual(): void {
    this.toggledVisualEventHandlerUnsubscribes.forEach((unsubscribe) => unsubscribe())
    this.toggledVisualEventHandlerUnsubscribes = []
    if (this._toggledVisual) {
      this._toggledVisual.destroy()
      this._toggledVisual = null
    }
  }

  protected enableVisuals() {
    super.enableVisuals()
    if (this._initialized) {
      if (!isNull(this._toggledVisual) && this._toggledVisual) {
        this._toggledVisual.enable()
      }
    }
  }

  protected disableVisuals() {
    super.disableVisuals()
    if (this._initialized) {
      if (!isNull(this._toggledVisual) && this._toggledVisual) {
        this._toggledVisual.disable()
      }
    }
  }

  protected release(): void {
    if (!isNull(this._toggledVisual) && this._toggledVisual) {
      this._toggledVisual.destroy()
    }
    this._toggledVisual = null
    super.release()
  }

  protected get isToggle(): boolean {
    return true
  }

  /**
   * Gets the width (diameter) of the toggled visual.
   *
   * @returns {number} The width of the toggled visual.
   */
  protected get toggledWidth(): number {
    return this._toggledWidth
  }

  /**
   * Sets the width (diameter) of the toggled visual.
   * If the new width is different from the current width, it updates the toggled visual.
   *
   * @param width - The new width of the toggled visual.
   */
  protected set toggledWidth(width: number) {
    if (width === undefined) {
      return
    }
    if (isEqual<number>(this._toggledWidth, width)) {
      return
    }
    this._toggledWidth = width
    if (this._initialized) {
      this._toggledVisual.size = new vec3(width, width, 1)
      ;(this._toggledVisual as RoundedRectangleVisual).cornerRadius = this.toggledCornerRadius
    }
  }
}

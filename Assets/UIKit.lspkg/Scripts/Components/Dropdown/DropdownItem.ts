import {InteractorEvent} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import {PublicApi} from "InteractionKit.lspkg/Utils/Event"
import {FlexItem} from "../Layout2D/Flex/FlexItem"
import {FlexAlignSelf} from "../Layout2D/Flex/FlexTypes"
import {Toggleable} from "../Toggle/Toggleable"
import {VisualElement} from "../VisualElement"

/**
 * Item wrapper for Dropdown. Defines cell size and delegates interaction
 * to a child UIKit component (Button, Toggle, Checkbox, etc.).
 *
 * **Scene-based discovery:** Add this component to any direct child SceneObject
 * under the Dropdown. The Dropdown collects items, sorts by `order`, and adds them.
 *
 * **Auto-detection:** On init, scans for a VisualElement subclass on this SceneObject
 * (or its descendants) and delegates interaction, collider, toggle, and opacity to it.
 * If no VisualElement is found, the item acts as a non-interactive spacer/separator.
 *
 * Extends {@link FlexItem} so the cell participates in the Dropdown's
 * internal FlexLayout. Override width / height via `width` / `height`
 * (mapped to `overrideWidth` / `overrideHeight` underneath), `stretchToFill`
 * controls `flexGrow`, and `alignment` maps to `alignSelf`.
 */
@component
export class DropdownItem extends FlexItem {
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Dropdown Cell</span>')
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Wrapper-specific options for items inside a Dropdown</span>'
  )
  @input
  @hint("When true, stretches the element to fill the cell (flexGrow=1). When false, the element keeps its own size.")
  protected _stretchToFill: boolean = true

  @input
  @showIf("_stretchToFill", false)
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Left", "Left"),
      new ComboBoxItem("Center", "Center"),
      new ComboBoxItem("Right", "Right")
    ])
  )
  @hint("Alignment of the element within the cell when stretchToFill is off.")
  protected _alignment: string = "Left"

  private resolvedElement: VisualElement | null = null
  private resolvedToggleable: Toggleable | null = null
  private _resolved: boolean = false

  // ─── Wrapper-specific accessors ──────────────────────────────────────

  /** The resolved child VisualElement, or null. */
  public get element(): VisualElement | null {
    if (!this._resolved) this.resolve()
    return this.resolvedElement
  }

  /** The child as Toggleable (e.g. Button, Switch), or null. */
  public get toggleable(): Toggleable | null {
    if (!this._resolved) this.resolve()
    return this.resolvedToggleable
  }

  /** The child element's collider, or null. */
  public get collider(): ColliderComponent | null {
    if (!this._resolved) this.resolve()
    return this.resolvedElement ? this.resolvedElement.collider : null
  }

  /** The child element's onTriggerUp event, or null if no element. */
  public get onTriggerUp(): PublicApi<InteractorEvent> | null {
    if (!this._resolved) this.resolve()
    return this.resolvedElement ? this.resolvedElement.onTriggerUp : null
  }

  /**
   * Set opacity on the child element's visual background.
   * Directly sets the `opacity` property — same as `button.opacity = alpha`.
   * Elements without an opacity setter silently ignore the assignment.
   * Descendant Text/Image alpha is handled separately by Dropdown.
   */
  public setOpacity(alpha: number): void {
    if (!this._resolved) this.resolve()
    if (this.resolvedElement) {
      ;(this.resolvedElement as any).opacity = alpha
    }
  }

  // ─── Backward-compat: cell size / stretch / alignment ────────────────

  /**
   * Cell width in cm. `> 0` pins the override; `0` (or unset) falls back to
   * the resolved child element's natural width. Setting writes through to
   * {@link FlexItem.overrideWidth}.
   */
  public get width(): number {
    if (this.hasOverrideWidth && this.overrideWidth > 0) return this.overrideWidth
    if (!this._resolved) this.resolve()
    return this.resolvedElement ? this.resolvedElement.width : 0
  }
  public set width(value: number) {
    if (value <= 0) this.clearOverrideWidth()
    else this.overrideWidth = value
  }

  /** Cell height in cm — symmetric to {@link width}. */
  public get height(): number {
    if (this.hasOverrideHeight && this.overrideHeight > 0) return this.overrideHeight
    if (!this._resolved) this.resolve()
    return this.resolvedElement ? this.resolvedElement.height : 0
  }
  public set height(value: number) {
    if (value <= 0) this.clearOverrideHeight()
    else this.overrideHeight = value
  }

  /**
   * Whether the wrapper should stretch the element to fill the cell. Mapped
   * to `flexGrow`: `true` → `flexGrow = 1`, `false` → `flexGrow = 0`.
   */
  public get stretchToFill(): boolean {
    return this._stretchToFill
  }
  public set stretchToFill(value: boolean) {
    this._stretchToFill = value
    this.flexGrow = value ? 1 : 0
  }

  /** Inspector alignment string. Mirrored into `alignSelf` on set. */
  public get alignment(): string {
    return this._alignment
  }
  public set alignment(value: string) {
    this._alignment = value
    this.alignSelf = this.flexAlignSelf
  }

  /** Maps the inspector `alignment` string to a {@link FlexAlignSelf} enum. */
  public get flexAlignSelf(): FlexAlignSelf {
    switch (this._alignment) {
      case "Left":
        return FlexAlignSelf.Start
      case "Center":
        return FlexAlignSelf.Center
      case "Right":
        return FlexAlignSelf.End
      default:
        return FlexAlignSelf.Start
    }
  }

  // ─── Resolution ──────────────────────────────────────────────────────

  /**
   * Resolves the child VisualElement and duck-types the Toggleable interface.
   * Uses instanceof since VisualElement is abstract (no @component decorator).
   */
  private resolve(): void {
    this._resolved = true
    const el = findVisualElement(this.sceneObject)
    if (!el) return
    this.resolvedElement = el

    // Duck-type Toggleable: Button/Switch etc. satisfy it structurally.
    const candidate = el as any
    if (
      "isOn" in candidate &&
      typeof candidate.toggle === "function" &&
      candidate.onFinished &&
      candidate.onValueChange
    ) {
      this.resolvedToggleable = candidate as Toggleable
    }
  }
}

/** Recursive find: first VisualElement on `root` or its descendants. */
function findVisualElement(root: SceneObject): VisualElement | null {
  const components = root.getComponents("ScriptComponent")
  for (let i = 0; i < components.length; i++) {
    if (components[i] instanceof VisualElement) return components[i] as VisualElement
  }
  for (let i = 0; i < root.getChildrenCount(); i++) {
    const found = findVisualElement(root.getChild(i))
    if (found) return found
  }
  return null
}

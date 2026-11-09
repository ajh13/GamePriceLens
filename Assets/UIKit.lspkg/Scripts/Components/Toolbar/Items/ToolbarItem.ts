import {InteractorEvent} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import Event, {PublicApi} from "InteractionKit.lspkg/Utils/Event"
import ReplayEvent from "InteractionKit.lspkg/Utils/ReplayEvent"
import {TailDirection, Tooltip} from "../../../Tooltip"
import {createChildSceneObjectWithParentLayer} from "../../../Utility/SceneUtilities"
import {ToolbarItemLayoutContract} from "../Helpers/ToolbarItemLayoutContract"
import {
  getToolbarDirectionFromSceneObject,
  ToolbarDirection,
  ToolbarDirections,
  ToolbarItemConfig,
  ToolbarItemSizeMode
} from "../Types/ToolbarSchema"

/**
 * Base class for toolbar items (button, text field, slider, toggle, separator, custom).
 * Obtained via {@link Toolbar.getItem} or {@link Toolbar.allItems}. Subclasses are created by the toolbar factory.
 */
export abstract class ToolbarItem extends BaseScriptComponent implements ToolbarItemLayoutContract {
  protected _config: ToolbarItemConfig
  protected _computedSize: vec2 = vec2.zero()
  protected readonly DISABLED_ALPHA = 0.2
  protected _size: vec3 = new vec3(6, 3, 3)
  protected _inactive: boolean = false
  protected managedSceneObjects: Set<SceneObject> = new Set<SceneObject>()
  protected managedComponents: Set<Component> = new Set<Component>()

  private _transform: Transform = this.sceneObject.getTransform()
  private _cachedDirection: ToolbarDirection = ToolbarDirections.HORIZONTAL

  // The toolbar's flat base render order (invariant 4 of the Canvas model):
  // every renderable this item creates carries it, so the toolbar's Hierarchy
  // Canvas orders items by tree order and z rather than by a per-item bump.
  // Set by the factory before initializeWithConfig and re-pushed by
  // Toolbar.renderOrder; an explicit config.renderOrder outranks it.
  private _baseRenderOrder: number = 0
  private _itemInitialized: boolean = false

  // The toolbar-level display alpha last pushed by Toolbar.applyDisplayAlpha():
  // the reveal gate times any auto-hide fade, WITHOUT this item's own
  // config.alpha. Stored because every later alpha write has to fold it back in.
  // Re-deriving from config.alpha alone made an `inactive` toggle REVEAL the item
  // on a hidden bar and leave it there, since applyDisplayAlpha() re-runs only on
  // the one-shot reveal flip or an explicit alpha/opacity write.
  private _toolbarAlpha: number = 1

  // Canonical-component host. The wrapper stays on the anchor SceneObject
  // (pinned at container-local origin); the Button / Slider / Switch /
  // TextInputField and its single ToolbarFlexItem live on this Content child so
  // the flow layout writes the child's local position in container-local space.
  // Null for Separator and Custom, which keep no Content-child canonical Element.
  protected _contentObject: SceneObject | null = null
  protected _contentTransform: Transform | null = null

  private _tooltip: Tooltip | null = null
  private _tooltipTransform: Transform | null = null
  private _tooltipSize: vec2 = vec2.zero()
  private static readonly TOOLTIP_GAP: number = 0.5
  // How far above its item a tooltip draws: the 1000 that Tooltip's field
  // initializer intends. A Tooltip created at runtime starts at 0 instead (its
  // int input's default), so the item sets the order itself.
  private static readonly TOOLTIP_RENDER_ORDER_OFFSET: number = 1000

  private onTriggerUpEvent: Event<InteractorEvent> = new Event<InteractorEvent>()
  /** Fires when the user completes a trigger interaction on this item. */
  public readonly onTriggerUp: PublicApi<InteractorEvent> = this.onTriggerUpEvent.publicApi()

  private onTriggerDownEvent: Event<InteractorEvent> = new Event<InteractorEvent>()
  /** Fires when the user begins a trigger interaction on this item. */
  public readonly onTriggerDown: PublicApi<InteractorEvent> = this.onTriggerDownEvent.publicApi()

  private onHoverEnterEvent: Event<InteractorEvent> = new Event<InteractorEvent>()
  /** Fires when the user's hand or pointer enters this item. */
  public readonly onHoverEnter: PublicApi<InteractorEvent> = this.onHoverEnterEvent.publicApi()

  private onHoverExitEvent: Event<InteractorEvent> = new Event<InteractorEvent>()
  /** Fires when the user's hand or pointer exits this item. */
  public readonly onHoverExit: PublicApi<InteractorEvent> = this.onHoverExitEvent.publicApi()

  private onInitializedEvent: ReplayEvent = new ReplayEvent()
  /** Fires once when the item has been fully initialized via initializeWithConfig. */
  public readonly onInitialized: PublicApi<void> = this.onInitializedEvent.publicApi()

  private onSizeChangedEvent: Event<vec3> = new Event<vec3>()
  /** Fires when the item's computed size changes. */
  public readonly onSizeChanged: PublicApi<vec3> = this.onSizeChangedEvent.publicApi()

  // --- ToolbarItem API ---

  /** Unique id of this item (from config or generated). */
  public get id(): string {
    return this._config.id!
  }

  /** Config used to create this item. */
  public get config(): ToolbarItemConfig {
    return this._config
  }

  /**
   * The draw order this item's renderables carry: `config.renderOrder` when the
   * consumer set one, else the toolbar's flat base order ({@link Toolbar.renderOrder}).
   */
  public get renderOrder(): number {
    return this._config?.renderOrder ?? this._baseRenderOrder
  }

  /**
   * Adopts the toolbar's base render order. Called by the toolbar factory before
   * {@link initializeWithConfig} and by the toolbar whenever its `renderOrder`
   * changes; not for external callers. A live item without an explicit
   * `config.renderOrder` re-applies the new order through its own visual hierarchy.
   */
  public setBaseRenderOrder(order: number): void {
    if (this._baseRenderOrder === order) {
      return
    }
    this._baseRenderOrder = order
    if (this._itemInitialized && this._config?.renderOrder === undefined) {
      this.applyRenderOrder(order)
    }
    this.syncTooltipRenderOrder()
  }

  /**
   * The hover tooltip for this item, or null when `config.tooltip` was unset.
   * Set its `tip` to change the text at runtime (e.g. refresh/cancel). Its render
   * order follows the item's, 1000 above it; an order set on the tooltip directly
   * lasts until the toolbar's `renderOrder` next changes.
   */
  public get tooltip(): Tooltip | null {
    return this._tooltip
  }

  /** Size assigned by layout in centimeters (width, height). */
  public get computedSize(): vec2 {
    return this._computedSize
  }

  public set computedSize(size: vec2) {
    this._computedSize = size
    this._size = new vec3(size.x, size.y, this._size.z)
    this.onSizeChangedEvent.invoke(this._size)
  }

  /** Transform of this item's scene object. */
  public get transform(): Transform {
    return this._transform
  }

  /**
   * The Content child hosting the canonical component and its ToolbarFlexItem,
   * or null for Separator / Custom (which keep no Content-child Element). Set by
   * the factory before {@link initializeWithConfig}.
   */
  public get contentObject(): SceneObject | null {
    return this._contentObject
  }

  /** Transform of the {@link contentObject}, or null when there is none. */
  public get contentTransform(): Transform | null {
    return this._contentTransform
  }

  /**
   * Assigns the Content child that hosts this item's canonical component. Called
   * by the toolbar factory before {@link initializeWithConfig}; not for external
   * callers.
   */
  public setContentObject(contentObject: SceneObject): void {
    this._contentObject = contentObject
    this._contentTransform = contentObject.getTransform()
  }

  /**
   * The width the canonical component must span at apply time, or -1 for the
   * flex-allocated width (identity). Overridden by items whose canonical size
   * differs from the flex cross allocation (vertical FILL toggle spans the
   * toolbar content width while its cell stays a primary-axis grow member).
   */
  public getContentApplyWidthOverride(_contentSpace: vec2, _isHorizontal: boolean): number {
    return -1
  }

  /** Current size of this item. */
  public get size(): vec3 {
    return this._size
  }

  /** When true, the item is visible but not interactive. */
  public get inactive(): boolean {
    return this._inactive
  }

  public set inactive(value: boolean) {
    this._inactive = value
    this._config.inactive = value
    if (value) {
      this._tooltip?.setOn(false)
    }
    this.onInactiveChanged(value)
    this.updateDisabledVisuals(value)
  }

  /** Intrinsic size of the item in centimeters before layout. */
  public abstract get intrinsicSize(): vec2

  /** Size mode: fill (takes available space) or manual (explicit size). */
  public abstract getSizeMode(): ToolbarItemSizeMode

  /** Applies a resolved toolbar cell size through this item's own component channel. */
  public abstract applyLayoutSize(size: vec2, transpose: boolean): void

  /** Applies an explicit render order through this item's own visual hierarchy. */
  public abstract applyRenderOrder(renderOrder?: number): void

  /** Whether this item's canonical content rotates for the current toolbar direction. */
  public shouldTransposeLayout(): boolean {
    return false
  }

  /** Final geometry used when another item is positioned relative to this item. */
  public getAttachmentTargetSize(): vec2 {
    const computed = this.computedSize
    if (computed.x > 0 && computed.y > 0) {
      return computed
    }
    const intrinsic = this.intrinsicSize
    return intrinsic.x > 0 && intrinsic.y > 0 ? intrinsic : new vec2(3, 3)
  }

  /**
   * Called by the toolbar when the item is created. Not intended for external callers.
   */
  public initializeWithConfig(config: ToolbarItemConfig) {
    this._config = config
    this._cachedDirection = getToolbarDirectionFromSceneObject(this.sceneObject)

    if (config.alpha !== undefined) {
      this.setAlpha(config.alpha)
    }

    this.setupCallbacks()
    this.initialize()

    if (this._config.tooltip) {
      this.createTooltip(this._config.tooltip)
    }

    if (config.inactive !== undefined) {
      this.inactive = config.inactive
    }

    this._itemInitialized = true
    this.onInitializedEvent.invoke()
  }

  /** Optional: called when the toolbar applies the item's final cell size. */
  public onLayoutSizeApplied?(): void

  /**
   * Called by the toolbar to determine the final layout size before positioning.
   * Override in subclasses to apply type-specific size corrections.
   */
  public getFinalLayoutSize(layoutSize: vec2, _contentSpace: vec2): vec2 {
    return layoutSize
  }

  /**
   * Adopts the toolbar's display alpha: the reveal gate times any auto-hide fade.
   * Called by Toolbar when that changes. This item folds in its own
   * `config.alpha`, so the caller passes the toolbar factor, NOT the product.
   */
  public applyAlpha(toolbarAlpha: number): void {
    this._toolbarAlpha = toolbarAlpha
    this.refreshVisualAlpha()
  }

  /** Returns the direction (horizontal or vertical) of the parent toolbar. */
  public getToolbarDirection(): ToolbarDirection {
    return this._cachedDirection
  }

  public onAwake() {
    this.createEvent("OnDestroyEvent").bind(() => this.release())
    // A disabled item keeps receiving the toolbar's alpha, but enabling it runs its
    // components' own OnEnable after this one (the engine enables top-down), and
    // those turn their renderables back on at any alpha (VisualElement.onEnabled).
    // So the alpha is re-applied in that frame's LateUpdate, once they have run.
    const reapplyAlpha = this.createEvent("LateUpdateEvent")
    reapplyAlpha.enabled = false
    reapplyAlpha.bind(() => {
      reapplyAlpha.enabled = false
      if (this._config) {
        this.refreshVisualAlpha()
      }
    })
    this.createEvent("OnEnableEvent").bind(() => {
      reapplyAlpha.enabled = true
    })
  }

  protected initialize(): void {}

  protected release(): void {
    this.managedComponents.forEach((component) => {
      if (!isNull(component) && component) {
        component.destroy()
      }
    })
    this.managedComponents.clear()
    this.managedSceneObjects.forEach((sceneObject) => {
      if (!isNull(sceneObject) && sceneObject) {
        sceneObject.destroy()
      }
    })
    this.managedSceneObjects.clear()
  }

  protected setupCallbacks() {
    if (this._config.onTriggerUp) {
      this.onTriggerUp.add(this._config.onTriggerUp)
    }

    if (this._config.onTriggerDown) {
      this.onTriggerDown.add(this._config.onTriggerDown)
    }

    if (this._config.onHoverEnter) {
      this.onHoverEnter.add(this._config.onHoverEnter)
    }

    if (this._config.onHoverExit) {
      this.onHoverExit.add(this._config.onHoverExit)
    }
  }

  /** The alpha this item's visuals carry: the toolbar's display alpha times `config.alpha`. */
  protected get composedAlpha(): number {
    return this._toolbarAlpha * (this._config?.alpha ?? 1)
  }

  /** Re-applies the composed alpha, folding in the inactive dim. */
  protected refreshVisualAlpha(): void {
    const alpha = this.composedAlpha
    this.setVisualAlpha(alpha, this._inactive ? alpha * this.DISABLED_ALPHA : alpha)
  }

  protected setAlpha(alpha: number) {
    this._config.alpha = alpha
    this.refreshVisualAlpha()
  }

  /**
   * Applies alpha to this item's visuals. `alpha` is the external value;
   * `effectiveAlpha` folds in the disabled dim for visuals that should fade
   * further while inactive.
   */
  protected abstract setVisualAlpha(alpha: number, effectiveAlpha: number): void

  /** Forwards inactive state to the wrapped component. */
  protected onInactiveChanged(_inactive: boolean): void {}

  /** Re-applies visual alpha for the disabled state; override for type-specific handling. */
  protected updateDisabledVisuals(_inactive: boolean): void {
    this.refreshVisualAlpha()
  }

  /** Forwards the inner component's trigger-up event to this item's subscribers. */
  protected invokeOnTriggerUp(event: InteractorEvent): void {
    this.onTriggerUpEvent.invoke(event)
  }

  /** Forwards the inner component's trigger-down event to this item's subscribers. */
  protected invokeOnTriggerDown(event: InteractorEvent): void {
    this.onTriggerDownEvent.invoke(event)
  }

  /** Forwards the inner component's hover-enter event to this item's subscribers. */
  protected invokeOnHoverEnter(event: InteractorEvent): void {
    if (this._tooltip && !this._inactive) {
      this._tooltip.setOn(true)
    }
    this.onHoverEnterEvent.invoke(event)
  }

  /** Forwards the inner component's hover-exit event to this item's subscribers. */
  protected invokeOnHoverExit(event: InteractorEvent): void {
    this._tooltip?.setOn(false)
    this.onHoverExitEvent.invoke(event)
  }

  /**
   * Builds the hover tooltip and places it outside the item on the toolbar's
   * cross axis: above a horizontal bar (tail down), to the right of a vertical
   * bar (tail left). Repositions when either the item or the tooltip changes
   * size. The SceneObject is managed, so it is torn down with the item.
   * A top/bottom-docked frame is not yet accounted for; the tail follows the
   * toolbar direction only.
   */
  private createTooltip(text: string): void {
    const tooltipObject = createChildSceneObjectWithParentLayer("ToolbarItemTooltip", this.sceneObject)
    this.managedSceneObjects.add(tooltipObject)

    const tooltip = tooltipObject.createComponent(Tooltip.getTypeName()) as Tooltip
    tooltip.tip = text
    tooltip.tailEnabled = true
    tooltip.tailDirection =
      this.getToolbarDirection() === ToolbarDirections.VERTICAL ? TailDirection.Left : TailDirection.Down
    this._tooltip = tooltip
    this._tooltipTransform = tooltipObject.getTransform()
    this.syncTooltipRenderOrder()

    tooltip.onSizeChanged.add((size: vec2) => {
      this._tooltipSize = size
      this.positionTooltip()
    })
    this.onSizeChanged.add(() => this.positionTooltip())
    this.positionTooltip()
  }

  // Keeps the tooltip above its item as the item's order moves.
  private syncTooltipRenderOrder(): void {
    if (this._tooltip && !isNull(this._tooltip)) {
      this._tooltip.renderOrder = this.renderOrder + ToolbarItem.TOOLTIP_RENDER_ORDER_OFFSET
    }
  }

  /**
   * Places the tooltip clear of the item on the cross axis, offset by both the
   * item's and the tooltip's half-size so the backing never overlaps the item.
   * The tooltip parents to the anchor, which stays at container-local origin for
   * canonical items, so the offset is measured from the Content child's laid-out
   * local position (the flow member the outer layout actually placed). Separator
   * and Custom have no Content child; their anchor is placed by the flow layout,
   * so the base is origin and the anchor-relative offset already tracks the item.
   */
  private positionTooltip(): void {
    if (!this._tooltipTransform) return
    const base = this._contentTransform ? this._contentTransform.getLocalPosition() : vec3.zero()
    if (this.getToolbarDirection() === ToolbarDirections.VERTICAL) {
      const x = base.x + this._size.x / 2 + this._tooltipSize.x / 2 + ToolbarItem.TOOLTIP_GAP
      this._tooltipTransform.setLocalPosition(new vec3(x, base.y, base.z + 0.1))
    } else {
      const y = base.y + this._size.y / 2 + this._tooltipSize.y / 2 + ToolbarItem.TOOLTIP_GAP
      this._tooltipTransform.setLocalPosition(new vec3(base.x, y, base.z + 0.1))
    }
  }
}

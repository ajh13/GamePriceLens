import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {invalidateCanvasBindingsIn} from "../../../Utility/CanvasController"
import {VisibilityGroup} from "../../../Utility/VisibilityGroup"
import {getSizeModeFromSize, ToolbarCustomItemConfig, ToolbarItemSizeMode} from "../Types/ToolbarSchema"
import {ToolbarItem} from "./ToolbarItem"

/**
 * Toolbar item that wraps a custom scene object. Obtain via {@link Toolbar.getItem} or {@link Toolbar.allItems}.
 *
 * Alpha: unless `config.onSetAlpha` takes it over, the custom subtree fades through a {@link VisibilityGroup}
 * rooted at the custom object. Every RenderMeshVisual, Image and Text under it has its AUTHORED alpha
 * multiplied by the item's effective alpha (content authored at 50% returns to 50%, not 100%), and
 * renderables are disabled while the effective alpha is exactly 0. Discovery runs when the item is created,
 * rescans over the next couple of frames (UIKit Shapes build their RenderMeshVisual at their own OnStart), and
 * rescans again after every layout pass; see {@link visibilityGroup} for content restructured at other times.
 */
@component
export class ToolbarCustomItem extends ToolbarItem {
  private customObject: SceneObject | null = null
  private customObjectTransform: Transform | null = null
  private cachedInteractables: Interactable[] = []
  private _visibilityGroup: VisibilityGroup | null = null
  // Short rescan window, armed at creation and re-armed by every layout pass.
  // A UIKit Shape realizes its RenderMeshVisual at its OWN OnStart, so content
  // handed to a custom item on the frame it was built has no fade surface when
  // the group first walks it. A couple of ticks covers both engine orderings
  // (this frame's Update still precedes that OnStart; the next one follows it)
  // without polling forever, the same shape as Frame's spawn-fade rescan.
  private _visibilityRescanEvent: UpdateEvent | null = null
  private _visibilityRescanTicksLeft: number = 0
  private static readonly VISIBILITY_RESCAN_TICKS = 2

  /** The custom scene object attached to this item. */
  public get customObjectRef(): SceneObject | null {
    return this.customObject
  }

  /**
   * The fade group over the custom object, or null when `config.onSetAlpha` owns the fade instead. Call its
   * `refresh()` after restructuring the custom content outside a layout pass (e.g. adding a child from an
   * event handler) so the new renderables adopt the toolbar's current alpha.
   */
  public get visibilityGroup(): VisibilityGroup | null {
    return this._visibilityGroup
  }

  /** Intrinsic size from config or custom object scale. */
  public get intrinsicSize(): vec2 {
    if (!this._config) {
      if (this.customObject) {
        const transform = this.customObjectTransform
        const scale = transform.getLocalScale()
        return new vec2(scale.x, scale.y)
      }
      return vec2.zero()
    }

    const sizeConfig = this._config.size
    if (sizeConfig instanceof vec2) {
      return new vec2(sizeConfig.x, sizeConfig.y)
    }

    if (typeof sizeConfig === "object") {
      if (this.customObject) {
        const transform = this.customObjectTransform
        const scale = transform.getLocalScale()
        const x = typeof sizeConfig.x === "number" ? sizeConfig.x : scale.x
        const y = typeof sizeConfig.y === "number" ? sizeConfig.y : scale.y
        return new vec2(x, y)
      }
      const x = typeof sizeConfig.x === "number" ? sizeConfig.x : 0
      const y = typeof sizeConfig.y === "number" ? sizeConfig.y : 0
      return new vec2(x, y)
    }

    if (this.customObject) {
      const transform = this.customObjectTransform
      const scale = transform.getLocalScale()
      return new vec2(scale.x, scale.y)
    }

    return vec2.zero()
  }

  /** Called by the toolbar when the item is created. Not intended for external callers. */
  public initializeWithConfig(config: ToolbarCustomItemConfig) {
    this._config = config

    const size = this.intrinsicSize
    this._size = new vec3(size.x, size.y, 0)

    this.createCustomObject(config)
    this.cacheComponents(this.customObject)
    // Before the base init: it applies config.alpha / config.inactive, which
    // must land on the group.
    this.createVisibilityGroup(config)

    super.initializeWithConfig(config)

    // Draw order: the custom subtree is developer-owned, so there are three cases.
    //  - `config.renderOrder` set, INCLUDING 0: written through every renderable,
    //    verbatim, per the ToolbarItemConfig contract. 0 is a real value here — it
    //    flattens the subtree's authored orders into the toolbar's Canvas bucket,
    //    and it is the only way to ask for that, since the unset default writes
    //    nothing. The `attachTo` path already honoured it (applyToolbarItemLayout
    //    forwards the raw optional into applyRenderOrder, guarded on `!== undefined`),
    //    as did a band reset back to 0 through setBaseRenderOrder.
    //  - unset, at the toolbar's flat default: nothing is written, so authored
    //    orders stand and the Canvas plus the +0.1 cm z step place the content over
    //    the item plane.
    //  - unset, under a non-zero toolbar band: the band is written so it reaches the
    //    content too.
    // The explicit-set test cannot be folded into `renderOrder !== 0`:
    // ToolbarItem.renderOrder collapses an explicit 0 and the unset default into the
    // same number, so a lone `!== 0` gate silently drops the explicit one.
    const renderOrder = this.renderOrder
    if (this._config.renderOrder !== undefined || renderOrder !== 0) {
      this.setupCustomObjectRenderProperties(this.customObject, renderOrder)
    }
  }

  /** Size mode: fill or manual from config.size. */
  public getSizeMode(): ToolbarItemSizeMode {
    return getSizeModeFromSize(this._config.size)
  }

  public applyLayoutSize(size: vec2, _transpose: boolean): void {
    this.computedSize = size
    this.transform.setLocalScale(vec3.one())
  }

  /**
   * Called after layout with the computed cell size so a consumer can fit its
   * custom content through its own size channel (config.onResize). The toolbar
   * never scales custom content itself.
   */
  public onLayoutSizeApplied() {
    const size = this.computedSize
    if (size.x <= 0 || size.y <= 0) {
      return
    }
    const customConfig = this._config as ToolbarCustomItemConfig
    customConfig.onResize?.(size)
    // onResize may have built or re-sized content: whatever already has a fade
    // surface joins the fade now, and whatever realizes at next frame's
    // OnStart is caught by the re-armed rescan.
    this.rescanVisibilityGroup()
  }

  /**
   * Applies an explicit render order to the custom object and its descendants.
   * Called by ToolbarAttachedItemPositioner when a consumer sets config.renderOrder;
   * not intended for external callers.
   */
  public applyRenderOrder(renderOrder?: number): void {
    if (renderOrder !== undefined) {
      this.setupCustomObjectRenderProperties(this.customObject, renderOrder)
    }
  }

  protected setVisualAlpha(_alpha: number, effectiveAlpha: number): void {
    const customConfig = this._config as ToolbarCustomItemConfig
    if (customConfig.onSetAlpha) {
      customConfig.onSetAlpha(effectiveAlpha)
    } else if (this._visibilityGroup) {
      this._visibilityGroup.opacity = effectiveAlpha
    }
  }

  protected updateDisabledVisuals(inactive: boolean) {
    const customConfig = this._config as ToolbarCustomItemConfig
    if (customConfig.onUpdateDisabledVisuals) {
      customConfig.onUpdateDisabledVisuals(inactive)
      return
    }

    super.updateDisabledVisuals(inactive)

    for (const interactable of this.cachedInteractables) {
      interactable.enabled = !inactive
    }
  }

  protected release(): void {
    if (this._visibilityRescanEvent) {
      this._visibilityRescanEvent.enabled = false
      this._visibilityRescanEvent = null
    }
    this._visibilityRescanTicksLeft = 0
    // Hands the subtree back at its authored alpha and enabled state before the
    // managed objects (the custom object among them) go down with the item.
    this._visibilityGroup?.release()
    this._visibilityGroup = null
    super.release()
  }

  private createVisibilityGroup(config: ToolbarCustomItemConfig): void {
    if (config.onSetAlpha || !this.customObject) {
      return
    }
    // disableRenderablesAtZero keeps the previous walker's contract: nothing
    // under a fully faded item stays renderable.
    this._visibilityGroup = new VisibilityGroup(this.customObject, {disableRenderablesAtZero: true})
    const rescan = this.createEvent("UpdateEvent")
    rescan.bind(() => {
      this._visibilityGroup?.refresh()
      if (--this._visibilityRescanTicksLeft <= 0) {
        rescan.enabled = false
      }
    })
    this._visibilityRescanEvent = rescan
    // A disabled object runs no events, so an item created (or parked) disabled
    // discovers nothing until it comes back. Re-arm on enable: the cached group
    // has no other way to learn about content realized while it was away.
    this.createEvent("OnEnableEvent").bind(() => this.armVisibilityRescan())
    this.armVisibilityRescan()
  }

  // Rescan now for content that already has a fade surface, and again over the
  // next frames for content whose surface realizes at its own OnStart.
  private rescanVisibilityGroup(): void {
    if (!this._visibilityGroup) {
      return
    }
    this._visibilityGroup.refresh()
    this.armVisibilityRescan()
  }

  private armVisibilityRescan(): void {
    if (!this._visibilityRescanEvent || isNull(this._visibilityRescanEvent)) {
      return
    }
    this._visibilityRescanTicksLeft = ToolbarCustomItem.VISIBILITY_RESCAN_TICKS
    this._visibilityRescanEvent.enabled = true
  }

  private cacheComponents(sceneObject: SceneObject | null) {
    if (!sceneObject) return

    const interactable = sceneObject.getComponent(Interactable.getTypeName()) as Interactable
    if (interactable) {
      this.cachedInteractables.push(interactable)
      // Forward the custom object's own hover so base-class features that key off
      // hover (tooltip, config.onHoverEnter/onHoverExit) work for custom items too.
      interactable.onHoverEnter.add((e) => this.invokeOnHoverEnter(e))
      interactable.onHoverExit.add((e) => this.invokeOnHoverExit(e))
    }

    const childCount = sceneObject.getChildrenCount()
    for (let i = 0; i < childCount; i++) {
      this.cacheComponents(sceneObject.getChild(i))
    }
  }

  private createCustomObject(config: ToolbarCustomItemConfig) {
    if (!config.customObject) {
      throw new Error("ToolbarCustomItem: customObject is required")
    }

    this.customObject = config.customObject
    this.customObject.setParent(this.sceneObject)
    // The subtree may have been built outside any Canvas and cached that answer
    // (an ElementContent's content bump, a nested ScrollWindow's fade order); it
    // now sits under the toolbar's Canvas, so re-resolve it — the same walk
    // ScrollWindow.addObject and Dropdown's item reparent sites do.
    invalidateCanvasBindingsIn(this.customObject)
    this.managedSceneObjects.add(this.customObject)

    this.customObjectTransform = this.customObject.getTransform()
    const transform = this.customObjectTransform
    const currentPos = transform.getLocalPosition()
    transform.setLocalPosition(new vec3(currentPos.x, currentPos.y, 0.1))

    const screenTransform = this.customObject.getComponent("ScreenTransform") as ScreenTransform
    if (screenTransform) {
      const screenPos = screenTransform.position
      screenTransform.position = new vec3(screenPos.x, screenPos.y, 0.1)
    }
  }

  private setupCustomObjectRenderProperties(sceneObject: SceneObject, renderOrder: number) {
    if (!sceneObject) return

    // Depth state is left at the material default: the custom object sits 0.1 cm
    // ahead of the item, which itself sits 0.1 cm ahead of the toolbar
    // background, so consumer content clears the bar in z rather than by draw
    // order. Content authored at a negative local z would sink behind the bar.
    // Plural, like the alpha walk in setAlphaOnSceneObject: one SceneObject can
    // carry several Images or an extra RenderMeshVisual, and the singular
    // getComponent used to band only the first of each, leaving its siblings on
    // the same object at their authored order.
    //
    // KNOWN LIMITATION (documented in the Toolbar README): these are raw component
    // writes. A UIKit component nested in the subtree keeps its OWN stored order
    // (VisualElement._renderOrder, ElementContent._explicitRenderOrder), so a later
    // re-push from that store reverts what we write here — ElementContent does this
    // from invalidateCanvasBinding() and for renderables it creates lazily, and
    // VisualElement's hasShadow setter writes the shadow at storedOrder - 1. Going
    // through those setters instead is the fix, but it makes a band invoke arbitrary
    // kit setters recursively inside developer-owned content, so it needs a probe
    // built around real nested kit components first. Consumers who nest a kit
    // component in a banded custom item should set its renderOrder themselves.
    sceneObject.getComponents("RenderMeshVisual").forEach((renderMeshVisual: RenderMeshVisual) => {
      renderMeshVisual.renderOrder = renderOrder
    })

    sceneObject.getComponents("Component.Text").forEach((textComponent: Text) => {
      textComponent.renderOrder = renderOrder
    })

    sceneObject.getComponents("Component.Image").forEach((imageComponent: Image) => {
      imageComponent.renderOrder = renderOrder
    })

    const childCount = sceneObject.getChildrenCount()
    for (let i = 0; i < childCount; i++) {
      const child = sceneObject.getChild(i)
      this.setupCustomObjectRenderProperties(child, renderOrder)
    }
  }
}

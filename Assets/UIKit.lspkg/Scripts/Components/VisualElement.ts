import {InteractorEvent} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import Event, {PublicApi, unsubscribe} from "InteractionKit.lspkg/Utils/Event"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import {findAllComponentsInSelfOrChildren} from "InteractionKit.lspkg/Utils/SceneObjectUtils"
import {DepthSettingsControllable} from "../Interfaces/DepthSettingsControllable"
import {normalizeThemeName, Theme} from "../Themes/Theme"
import {ThemeService} from "../Themes/ThemeService"
import {Tooltip} from "../Tooltip"
import {CanvasController, invalidateCanvasBindingsIn} from "../Utility/CanvasController"
import {
  createChildSceneObjectWithParentLayer,
  isSceneObjectAncestorOf,
  reappendChild,
  reparentExternalChild,
  unparentExternalChild
} from "../Utility/SceneUtilities"
import {isEqual} from "../Utility/UIKitUtilities"
import {DropShadowVisual, DropShadowVisualParameters} from "../Visuals/DropShadowVisual"
import {RoundedRectangleVisual} from "../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {Visual} from "../Visuals/Visual"
import {Element, StateName} from "./Element"

const log = new NativeLogger("VisualElement")

// CSS box-shadow terms (cm): blur = falloff band width, spreadRadius = silhouette
// growth. Values are the cm equivalents of the pre-CSS style (band = fraction of
// the standard 1.5 button corner radius; silhouette growth = old sizeOffset).
const DEFAULT_SHADOW_STYLE: Partial<DropShadowVisualParameters> = {
  default: {
    baseColor: new vec4(0.05, 0.05, 0.05, 0.4),
    shouldPosition: false,
    shouldScale: false,
    blur: 0.3,
    spreadRadius: -0.125
  },
  hovered: {
    blur: 0.75,
    spreadRadius: -0.2
  },
  triggered: {
    blur: 0.45,
    spreadRadius: -0.125
  },
  toggledHovered: {
    blur: 0.75,
    spreadRadius: -0.2
  },
  toggledTriggered: {
    blur: 0.45,
    spreadRadius: -0.125
  }
}

/**
 * Represents an abstract base class for visual elements in the UI framework.
 * This class extends the `Element` class and provides functionality for managing
 * a visual representation (`Visual`) and handles initialization and event binding for the visual element.
 *
 * @abstract
 */
export abstract class VisualElement extends Element implements DepthSettingsControllable {
  @input
  private _hasShadow: boolean = false

  @input("vec3", "{0.05,-0.05,-0.01}")
  @showIf("_hasShadow")
  private _shadowPositionOffset: vec3 = vec3.zero()

  @input
  @label("Theme")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Inherited", "Inherited"),
      new ComboBoxItem("System 2.0", "System2"),
      new ComboBoxItem("System 3.0", "System3")
    ])
  )
  protected _themeOverride: string = "Inherited"

  /**
   * The theme override in canonical form. Collapses the legacy "Default"
   * sentinel to "Inherited", and maps pre-rename theme names
   * ("SnapOS2"/"SnapOS3") to their System 2.0/3.0 equivalents — so direct
   * string comparisons against the canonical names hold for scenes serialized
   * before the rename.
   */
  protected get normalizedThemeOverride(): string {
    if (this._themeOverride === "Default") {
      return "Inherited"
    }
    return normalizeThemeName(this._themeOverride)
  }

  protected resolveTheme(): Theme {
    const mgr = ThemeService.getInstance()
    const override = this.normalizedThemeOverride
    if (override !== "Inherited") {
      return mgr.getTheme(override) ?? mgr.currentTheme
    }
    return mgr.currentTheme
  }

  /**
   * Programmatically set the theme override. Equivalent to picking the
   * Theme dropdown in the LS Inspector. Must be called before initialize()
   * for components that resolve theme at init time. Subclasses with style
   * choices (e.g. Button) typically wrap this in a `setTheme(theme, style)`
   * convenience that also writes their per-component style field.
   *
   * @param theme  "System 2.0", "System 3.0", or "Inherited"
   */
  public setThemeOverride(theme: string): void {
    this._themeOverride = theme
  }

  protected _visual: Visual
  protected visualEventHandlerUnsubscribes: unsubscribe[] = []
  private readonly onContentZOffsetChangedEvent: Event<number> = new Event<number>()
  private _onContentZOffsetChanged?: PublicApi<number>
  public get onContentZOffsetChanged(): PublicApi<number> {
    return (this._onContentZOffsetChanged ??= this.onContentZOffsetChangedEvent.publicApi())
  }

  private shadow: DropShadowVisual | undefined = undefined
  private shadowEventHandlerUnsubscribes: unsubscribe[] = []

  private _depthTest: boolean = true
  private _depthWrite: boolean = true

  private _colliderSizeScratch: vec3 = new vec3(0, 0, 0)
  protected _colliderPosScratch: vec3 = new vec3(0, 0, 0)

  private tooltip: Tooltip
  private tooltipDestroyUnsubscribe: (() => void) | null = null

  // Draw-order Canvas, see managesDrawOrderCanvas. Named apart from the
  // `canvasController` fields on NumberPicker / BaseTextInputComponent: those
  // run their own batched controllers and leave this one null.
  private drawOrderCanvasController: CanvasController | null = null

  protected get effectiveStyle(): string | undefined {
    return undefined
  }

  public get style(): string {
    return this.effectiveStyle ?? this.resolveTheme().defaultStyleName
  }

  /**
   * Gets the type string of the visual element.
   *
   * @returns {string} The type string of the visual element.
   */
  public get typeString(): string {
    return this.constructor.name
  }

  /**
   * Gets the associated `Visual` instance for this component.
   *
   * @returns {Visual} The `Visual` instance linked to this component.
   */
  public get visual(): Visual {
    return this._visual
  }

  /**
   * Additional local +Z offset companion content should use to avoid depth
   * rejection against the current visual.
   */
  public get contentZOffset(): number {
    return this._visual?.contentZOffset ?? 0
  }

  /**
   * Render-order delta companion content must add to composite above this
   * element's visual when no Canvas governs draw order.
   *
   * @see Visual.contentRenderOrderOffset
   */
  public get contentRenderOrderOffset(): number {
    return this._visual?.contentRenderOrderOffset ?? 0
  }

  /**
   * Controls whether this element participates in depth testing.
   */
  public get depthTest(): boolean {
    return this._visual ? this._visual.depthTest : this._depthTest
  }

  /**
   * @see depthTest
   */
  public set depthTest(depthTest: boolean) {
    this._depthTest = depthTest
    if (this._visual) {
      this._visual.depthTest = depthTest
    }
  }

  /**
   * Controls whether this element writes to the depth buffer.
   */
  public get depthWrite(): boolean {
    return this._visual ? this._visual.depthWrite : this._depthWrite
  }

  /**
   * @see depthWrite
   */
  public set depthWrite(depthWrite: boolean) {
    this._depthWrite = depthWrite
    if (this._visual) {
      this._visual.depthWrite = depthWrite
    }
  }

  /**
   * Sets the associated `Visual` instance for this component.
   *
   * @param value - The `Visual` instance to assign.
   */
  public set visual(value: Visual) {
    if (value === undefined) {
      return
    }
    if (isEqual<Visual>(this._visual, value)) {
      return
    }
    this.destroyVisual()
    this._visual = value
    if (this._initialized) {
      this.configureVisual()
      this.setState(this.stateName) // set the new visual to current state
    }
  }

  /**
   * Gets the size of the visual element.
   *
   * @returns {vec3} The size of the visual element.
   */
  public get size(): vec3 {
    return this._size
  }

  /**
   * Sets the size of the visual element.
   *
   * @param size - A `vec3` representing the dimensions of the visual element.
   */
  public set size(size: vec3) {
    if (size === undefined) {
      return
    }
    if (isEqual<vec3>(this.size, size)) {
      return
    }
    super.size = size
    this.syncDrawOrderCanvasSize()
    if (this._initialized) {
      this._visual.size = size
      if (this.shadow) {
        this.shadow.size = size
      }
      this.updateCollider()
    }
  }

  /**
   * Gets the render order of the visual element.
   *
   * @returns {number} The render order of the visual element.
   */
  public get renderOrder(): number {
    return this._renderOrder
  }

  /**
   * Sets the render order of the visual element.
   *
   * @param value - The render order of the visual element.
   */
  public set renderOrder(value: number) {
    if (value === undefined) {
      return
    }
    this._renderOrder = value
    if (this._initialized) {
      this._visual.renderMeshVisual.renderOrder = value
      this.applyShadowRenderOrder()
    }
  }

  /**
   * Whether this element keeps a Canvas (World units, Hierarchy sorting) on
   * its own SceneObject so draw order among its renderables is decided by
   * hierarchy order instead of renderOrder bumps or camera distance
   * (measured). The body visual on this object draws first, then children in
   * tree order — the visuals created at initialize (e.g. RadioButton's dot,
   * Checkbox's fill and mark), then a companion ElementContent's container
   * (built after onInitialized), and last the developer-owned children, which
   * this class keeps in the foreground (authored children are moved there in
   * beforeInitialized and again whenever a managed child is registered; see
   * addChild / removeChild) so they draw above everything the element creates.
   * Resolution follows CanvasController: an authored local Canvas is adopted,
   * a compatible ancestor Canvas is inherited untouched, otherwise a local one
   * is created and destroyed on release. The shadow keeps its renderOrder − 1
   * either way.
   *
   * Opt-in per subclass. The default keeps VisualElement behavior-neutral for
   * subclasses that run their own controller (NumberPicker,
   * BaseTextInputComponent) or whose child creation order has not been
   * audited for hierarchy layering yet. A subclass that runs its own
   * controller overrides {@link invalidateCanvasBinding} and MUST leave this
   * false — ensureDrawOrderCanvas() enforces that at runtime.
   */
  protected get managesDrawOrderCanvas(): boolean {
    return false
  }

  /**
   * Re-resolves the draw-order Canvas binding. Call after reparenting this
   * element or changing ancestor Canvas topology through raw Lens APIs; an
   * enable/disable cycle already covers itself. A live locally managed Canvas
   * stays authoritative. Same duck-typed protocol ScrollWindow walks on
   * reparented subtrees.
   *
   * Two kinds of subclass relate to this method differently:
   * - one that runs its OWN CanvasController (NumberPicker,
   *   BaseTextInputComponent) overrides it wholesale and keeps
   *   {@link managesDrawOrderCanvas} false;
   * - one that opts into the base Canvas and also owns other canvas-bound
   *   components (an ElementContent on a child object, a nested element) must
   *   NOT override this — implement {@link forwardCanvasBindingInvalidation}
   *   instead. An override is read as "own controller" and blocks the base one.
   */
  public invalidateCanvasBinding(): void {
    this.refreshDrawOrderCanvasBinding()
    this.forwardCanvasBindingInvalidation()
  }

  /**
   * Forwards {@link invalidateCanvasBinding} to canvas-bound components this
   * element owns on other SceneObjects. Default: nothing to forward.
   */
  protected forwardCanvasBindingInvalidation(): void {}

  // ─── Developer-owned children ───────────────────────────────────────

  /**
   * Adds a developer-owned SceneObject as a foreground child: under this
   * element's Canvas it draws above every visual the element creates. Before
   * initialization it simply becomes a root child — initialization moves root
   * children to the foreground. Non-ScreenTransform children keep their world
   * position, rotation, and scale.
   */
  public addChild(sceneObject: SceneObject): void {
    if (
      isNull(sceneObject) ||
      this.managedSceneObjects.has(sceneObject) ||
      isSceneObjectAncestorOf(sceneObject, this.sceneObject)
    ) {
      return
    }
    if (sceneObject.getParent() !== this.sceneObject) {
      reparentExternalChild(sceneObject, this.sceneObject)
      // The subtree crossed a Canvas boundary, so anything in it that cached a
      // governing-Canvas answer has to re-resolve: an ElementContent's content
      // bump, a nested ScrollWindow's fade order. A stale bump outranks this
      // element's Canvas and draws over nearer UI. Reordering WITHIN one parent
      // never changes the governing Canvas, which is why refreshChildren() and
      // moveContentChildrenToForeground() deliberately do not do this.
      invalidateCanvasBindingsIn(sceneObject)
    }
    this.refreshChildren()
  }

  /**
   * Removes a direct developer-owned child without destroying it.
   * Non-ScreenTransform children keep their world position, rotation, and scale.
   */
  public removeChild(sceneObject: SceneObject): void {
    if (
      isNull(sceneObject) ||
      this.managedSceneObjects.has(sceneObject) ||
      sceneObject.getParent() !== this.sceneObject
    ) {
      return
    }
    unparentExternalChild(sceneObject)
    // Leaving the Canvas is the same staleness in reverse: a suppressed (flat)
    // content order with no Canvas above it leaves coplanar blended quads to
    // distance-sort.
    invalidateCanvasBindingsIn(sceneObject)
    this.onContentChildrenChanged()
  }

  /**
   * Re-applies the foreground order and the child-dependent policies after the
   * child list was changed through raw Lens APIs. Prefer addChild / removeChild.
   */
  public refreshChildren(): void {
    if (this._initialized && this.managesDrawOrderCanvas) {
      this.moveContentChildrenToForeground()
    }
    this.onContentChildrenChanged()
  }

  /**
   * Hook for policies that depend on whether developer-owned children are
   * present — RadioButton / Checkbox / Slider stop their intermediate fills
   * writing depth while they are. Runs once at the end of initialize() and
   * after every addChild / removeChild / refreshChildren.
   */
  protected onContentChildrenChanged(): void {}

  /**
   * Developer-owned children as the layering policies see them. The foreground
   * move (invariant 7) and {@link intermediateFillDepthWrite} (invariant 6) run
   * on this list, not on the raw {@link contentChildren}: the two differ only by
   * the unregistered objects {@link hostsSuppliedVisual} claims.
   */
  protected get layeringContentChildren(): SceneObject[] {
    return this.contentChildren.filter((child) => !this.hostsSuppliedVisual(child))
  }

  /**
   * Whether an unregistered direct child carries a caller-supplied visual this
   * element currently displays (Slider's replacement fill or knob). Such an
   * object is one of the element's own layers and is layered as such without
   * the element taking destruction ownership of it: pushing it to the
   * foreground with the developer children would draw it over layers meant to
   * sit above it (a fill over the knob), and counting it as a child would
   * switch the depth-write policy for nothing. It stays out of
   * managedSceneObjects, so release() leaves it alone. Default: no such objects.
   */
  protected hostsSuppliedVisual(_child: SceneObject): boolean {
    return false
  }

  /**
   * Depth-write policy for an OPAQUE intermediate layer (a fill, a toggled dot,
   * an opaque knob) drawn between this element's body and its developer-owned
   * children: it writes depth like the body except while such children
   * ({@link layeringContentChildren}) are present, so a child at z≈0 that tree
   * order places above it is not depth-rejected. Transparent chrome is not an
   * intermediate layer in this sense — it never writes depth, regardless of
   * children.
   */
  protected get intermediateFillDepthWrite(): boolean {
    return this.depthWrite && this.layeringContentChildren.length === 0
  }

  public registerManagedChild(sceneObject: SceneObject): void {
    super.registerManagedChild(sceneObject)
    // A managed child registered after init (a companion ElementContent's
    // container) was appended last; developer children go back in front of it.
    if (this._initialized && this.managesDrawOrderCanvas) {
      this.moveContentChildrenToForeground()
    }
  }

  protected beforeInitialized(): void {
    super.beforeInitialized()
    if (this.managesDrawOrderCanvas) {
      this.moveContentChildrenToForeground()
    }
  }

  /**
   * Reparents every developer-owned child ({@link layeringContentChildren}) to
   * the end of this SceneObject's child list, preserving their relative order,
   * so that under Hierarchy sorting they draw above the element's own visuals.
   * Local transforms are kept as-is (see reappendChild). No-op when they
   * already form the tail.
   */
  private moveContentChildrenToForeground(): void {
    const content = this.layeringContentChildren
    if (content.length === 0) {
      return
    }
    const children = this.sceneObject.children
    const tail = children.slice(children.length - content.length)
    if (tail.every((child, index) => child === content[index])) {
      return
    }
    for (const child of content) {
      if (!isNull(child) && child.getParent() === this.sceneObject) {
        reappendChild(child)
      }
    }
  }

  /**
   * Gets whether the visual element has a shadow.
   *
   * @returns {boolean} Whether the visual element has a shadow.
   */
  public get hasShadow(): boolean {
    return this._hasShadow
  }

  /**
   * Sets whether the visual element has a shadow.
   * If the hasShadow is set to true, the shadowVisual object will be created and configured.
   *
   * @param value - Whether the visual element has a shadow.
   */
  public set hasShadow(value: boolean) {
    if (value === undefined) {
      return
    }
    if (isEqual<boolean>(this._hasShadow, value)) {
      return
    }
    this._hasShadow = value
    if (this._initialized) {
      if (value) {
        this.createShadow()
        this.applyShadowRenderOrder()
        this.configureShadow()
        this.shadow.setState(this.stateName)
      } else {
        this.destroyShadow()
      }
    }
  }

  /**
   * Gets the associated `DropShadowVisual` instance for this component.
   *
   * @returns {DropShadowVisual | undefined} The `DropShadowVisual` instance linked to this component, if any.
   */
  public get shadowVisual(): DropShadowVisual | undefined {
    return this.shadow
  }

  /**
   * Gets the position offset of the shadow.
   *
   * @returns {vec3} The position offset of the shadow.
   */
  public get shadowPositionOffset(): vec3 {
    return this._shadowPositionOffset
  }

  /**
   * Sets the position offset of the shadow.
   *
   * @param value - The position offset of the shadow.
   */
  public set shadowPositionOffset(value: vec3) {
    if (value === undefined) {
      return
    }
    if (isEqual<vec3>(this._shadowPositionOffset, value)) {
      return
    }
    this._shadowPositionOffset = value
    if (this._initialized && this.shadow) {
      this.shadow.transform.setLocalPosition(this.currentPosition.uniformScale(-1).add(this._shadowPositionOffset))
    }
  }

  /**
   * Initializes the visual element and its associated properties and events.
   *
   * @override
   */
  public initialize(): boolean {
    if (this._initialized) {
      return false
    }

    // Canvas before the body visual, matching NumberPicker / BaseTextInputComponent.
    this.ensureDrawOrderCanvas()
    this.createDefaultVisual()
    // createDefaultVisual may normalize _size (Button's Round shape squares it).
    this.syncDrawOrderCanvasSize()
    this.createShadow()

    this._visual.renderMeshVisual.renderOrder = this._renderOrder
    this.applyShadowRenderOrder()

    if (!super.initialize()) {
      return false
    }

    this.configureVisual()
    this.configureShadow()

    this.visual.onPositionChanged.add((args) => {
      this.currentPosition = args.current
      this.updateCollider()
    })

    this.visual.onScaleChanged.add((args) => {
      this.currentScale = args.current
      this.updateCollider()
    })

    if (!this.tooltip) {
      const tooltipComponents = findAllComponentsInSelfOrChildren(this.sceneObject, Tooltip.getTypeName())
      if (tooltipComponents.length > 0) {
        this.registerTooltip(tooltipComponents[0])
      }
    }

    this.setState(this.stateName)
    this.onContentChildrenChanged()
    return true
  }

  /**
   * Registers a tooltip instance with the current component
   *
   * @param tooltip - The Tooltip instance to associate with this component.
   */
  public registerTooltip(tooltip: Tooltip): void {
    if (this.tooltipDestroyUnsubscribe) {
      this.tooltipDestroyUnsubscribe()
      this.tooltipDestroyUnsubscribe = null
    }

    this.tooltip = tooltip
    this.tooltip.setOn(false)

    this.tooltipDestroyUnsubscribe = this.tooltip.onDestroy.add(() => {
      this.tooltip = null
      this.tooltipDestroyUnsubscribe = null
    })
  }

  /**
   * Sets the tooltip text for the visual element.
   *
   * @param text - The text to be displayed in the tooltip.
   */
  public setTooltip(text: string): void {
    if (this.tooltip) {
      if (this.tooltip.tip !== text) {
        this.tooltip.tip = text
      }
    }
  }

  protected abstract createDefaultVisual(): void

  protected configureVisual(): void {
    if (this._visual) {
      this.visualEventHandlerUnsubscribes.push(
        this._visual.onDestroyed.add(() => {
          this._visual = null
        }),
        this._visual.onContentZOffsetChanged.add((contentZOffset: number) => {
          this.onContentZOffsetChangedEvent.invoke(contentZOffset)
        }),
        this._visual.onColliderBoundsChanged.add(() => {
          this.updateCollider()
        }),
        // Bridge Element hover events down to the Visual so subclasses can
        // react (e.g. cursor-following highlight) without holding a back-
        // reference to the Element.
        this.onHoverEnter.add((event) => this._visual?.onHoverEnter(event)),
        this.onHoverExit.add((event) => this._visual?.onHoverExit(event))
      )

      this._visual.initialize()

      this._visual.size = this._size
      this._visual.depthTest = this._depthTest
      this._visual.depthWrite = this._depthWrite

      this.onContentZOffsetChangedEvent.invoke(this.contentZOffset)
      this.updateCollider()
    }
  }

  protected createShadow(): void {
    if (this._hasShadow) {
      // The layer is copied, as it is for every other object the kit creates for
      // an element (Tooltip's text, ElementContent's container, FlexContainer's
      // layout and background). A raw createSceneObject leaves the shadow on the
      // DEFAULT layer, where a camera rendering only this element's bespoke layer
      // culls it — the element draws and its shadow silently does not.
      const shadowObject = createChildSceneObjectWithParentLayer(this.sceneObject.name + " Shadow", this.sceneObject)
      this.managedSceneObjects.add(shadowObject)
      this.shadow = new DropShadowVisual({sceneObject: shadowObject, style: DEFAULT_SHADOW_STYLE})
    }
  }

  /**
   * renderOrder − 1 is intentional even under a Canvas: renderOrder outranks
   * Canvas Hierarchy sorting (measured), so the offset opts the shadow out of
   * the equal-order bucket and behaves identically with or without a canvas
   * ancestor. It matters more now that buttons carry their own Canvas: the
   * shadow is a CHILD of the object hosting the body visual, so at an equal
   * order hierarchy sorting would draw it in front of the body — a runtime
   * `hasShadow = true` used to leave it there. A canvas-NEUTRAL shadow (flat
   * order, hierarchy-sorted) would also need the shadow object created BEFORE
   * the visual — Frame's chrome does exactly that; migrating VisualElement is a
   * separate effort.
   */
  private applyShadowRenderOrder(): void {
    if (this._hasShadow && this.shadow) {
      this.shadow.renderMeshVisual.renderOrder = this._renderOrder - 1
    }
  }

  protected configureShadow(): void {
    if (this.shadow) {
      this.shadowEventHandlerUnsubscribes.push(
        this.shadow.onDestroyed.add(() => {
          this.shadow = undefined
        }),
        this.visual.onPositionChanged.add((args) => {
          this.shadow.transform.setLocalPosition(args.current.uniformScale(-1).add(this._shadowPositionOffset))
        })
      )
      this.shadow.size = this.size
      if (this.visual instanceof RoundedRectangleVisual) {
        this.shadow.cornerRadius = this.visual.cornerRadius
      }
      const shadowTransform = this.shadow.transform
      shadowTransform.setLocalPosition(this.currentPosition.uniformScale(-1).add(this._shadowPositionOffset))
      shadowTransform.setLocalRotation(quat.quatIdentity())
    }
  }

  protected onEnabled() {
    super.onEnabled()
    this.enableVisuals()
    // Reparenting fires no event of its own; the enable that usually follows
    // it is where an inherited Canvas binding gets re-resolved.
    this.refreshDrawOrderCanvasBinding()
  }

  protected onDisabled() {
    super.onDisabled()
    this.disableVisuals()
  }

  protected enableVisuals() {
    if (this._initialized) {
      if (!isNull(this.visual) && this.visual) {
        this.visual.enable()
      }
      if (!isNull(this.shadow) && this.shadow) {
        this.shadow.enable()
      }
    }
  }

  protected disableVisuals() {
    if (this._initialized) {
      if (!isNull(this.visual) && this.visual) {
        this.visual.disable()
      }
      if (!isNull(this.shadow) && this.shadow) {
        this.shadow.disable()
      }
    }
  }

  private destroyVisual(): void {
    this.visualEventHandlerUnsubscribes.forEach((unsubscribe) => unsubscribe())
    this.visualEventHandlerUnsubscribes = []
    if (this._visual) {
      this._visual.destroy()
    }
  }

  private destroyShadow(): void {
    this.shadowEventHandlerUnsubscribes.forEach((unsubscribe) => unsubscribe())
    this.shadowEventHandlerUnsubscribes = []
    if (this.shadow) {
      this.shadow.destroy()
    }
    // The onDestroyed handler that clears the field was just unsubscribed, so
    // clear it here, or shadowVisual keeps handing out the destroyed shadow.
    this.shadow = undefined
  }

  protected release(): void {
    try {
      if (!isNull(this._visual) && this._visual) {
        this._visual.destroy()
      }
      if (!isNull(this.shadow) && this.shadow) {
        this.shadow.destroy()
      }
      super.release()
    } finally {
      const canvasController = this.drawOrderCanvasController
      this.drawOrderCanvasController = null
      canvasController?.release()
    }
  }

  private ensureDrawOrderCanvas(): void {
    if (!this.managesDrawOrderCanvas) {
      return
    }
    // Same prototype check Element.onAwake uses for update(): a subclass that
    // overrides the protocol method runs its own CanvasController, and two
    // controllers on one SceneObject would fight over the authored-Canvas
    // snapshot. Leave the Canvas to the subclass and say so.
    if (this.invalidateCanvasBinding !== VisualElement.prototype.invalidateCanvasBinding) {
      log.e(
        `${this.typeString} on "${this.sceneObject.name}" overrides invalidateCanvasBinding() (its own ` +
          `CanvasController) yet sets managesDrawOrderCanvas — not minting a second Canvas. To forward ` +
          `invalidation to owned components, implement forwardCanvasBindingInvalidation() instead.`
      )
      return
    }
    this.drawOrderCanvasController ??= new CanvasController(this.sceneObject)
    this.drawOrderCanvasController.ensure(this.drawOrderCanvasSize)
  }

  // No-op before ensureDrawOrderCanvas() and for inherited Canvases (the
  // controller only resizes a Canvas it manages).
  private syncDrawOrderCanvasSize(): void {
    this.drawOrderCanvasController?.setSize(this.drawOrderCanvasSize)
  }

  private refreshDrawOrderCanvasBinding(): void {
    const controller = this.drawOrderCanvasController
    if (!controller) {
      return
    }
    controller.invalidate()
    if (this._initialized) {
      controller.reconcile()
    }
  }

  private get drawOrderCanvasSize(): vec2 {
    return new vec2(this._size.x, this._size.y)
  }

  protected setState(stateName: StateName): void {
    this._visual?.setState(stateName)
    if (this.shadow) {
      this.shadow.setState(stateName)
    }
    super.setState(stateName)
  }

  protected onHoverEnterHandler(event: InteractorEvent): void {
    this.setTooltipState(true)
    super.onHoverEnterHandler(event)
  }

  protected onHoverExitHandler(event: InteractorEvent): void {
    this.setTooltipState(false)
    super.onHoverExitHandler(event)
  }

  protected updateCollider(): void {
    if (!this._colliderFitElement) return
    const dp = this.deltaPosition
    const ds = this.deltaScale
    const sz = this._size
    const sizeScratch = this._colliderSizeScratch
    const posScratch = this._colliderPosScratch
    const sizeOff = this._visual?.colliderSizeOffset
    const centerOff = this._visual?.colliderCenterOffset
    const dx = dp.x / ds.x
    const dy = dp.y / ds.y
    const dz = dp.z / ds.z
    sizeScratch.x = sz.x + dx + (sizeOff?.x ?? 0)
    sizeScratch.y = sz.y + dy + (sizeOff?.y ?? 0)
    sizeScratch.z = sz.z + dz + (sizeOff?.z ?? 0)
    posScratch.x = -dx * 0.5 + (centerOff?.x ?? 0)
    posScratch.y = -dy * 0.5 + (centerOff?.y ?? 0)
    posScratch.z = -dz * 0.5 + (centerOff?.z ?? 0)
    this.colliderShape.size = sizeScratch
    this.collider.shape = this.colliderShape
    this.colliderTransform.setLocalPosition(posScratch)
  }

  private setTooltipState(isOn: boolean): void {
    if (this.tooltip) {
      this.tooltip.setOn(isOn)
    }
  }
}

import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {OpacityControllable} from "../../Interfaces/OpacityControllable"
import {CanvasController} from "../../Utility/CanvasController"
import {FlexContainer} from "../../Utility/FlexContainer"
import {createChildSceneObjectWithParentLayer} from "../../Utility/SceneUtilities"
import {RoundedRectangle, RoundedRectBlendMode} from "../../Visuals/RoundedRectangle/RoundedRectangle"
import {Frame} from "../Frame/Frame"
import {FlexItem} from "../Layout2D/Flex/FlexItem"
import {FlexLayout} from "../Layout2D/Flex/FlexLayout"
import {FlexAlign, FlexDirection, FlexJustify, FlexLayoutResult} from "../Layout2D/Flex/FlexTypes"
import {GridItem} from "../Layout2D/Grid/GridItem"
import {GridLayout} from "../Layout2D/Grid/GridLayout"
import {GridAlign} from "../Layout2D/Grid/GridTypes"
import {LayoutItem2D} from "../Layout2D/LayoutItem2D"
import {UIKitBrands} from "../Layout2D/UIKitBrands"
import {ToolbarAttachedItemPositioner} from "./Helpers/ToolbarAttachedItemPositioner"
import {ToolbarAutoHideManager} from "./Helpers/ToolbarAutoHideManager"
import {ToolbarFactory} from "./Helpers/ToolbarFactory"
import {ToolbarFlexItem} from "./Helpers/ToolbarFlexItem"
import {
  AttachmentReservationInput,
  computeAttachmentReservationInput,
  computeAttachmentReservations,
  computeCenterGridSideReserve,
  computeItemCellSize,
  fitCellMinsToContentSpace,
  planArrangement,
  resolveAlignment,
  resolveNormalizedAttachedItemSize,
  ToolbarCellSize,
  ToolbarJustify,
  ToolbarMargins
} from "./Helpers/ToolbarFlexMapping"
import {ToolbarFramePositioner} from "./Helpers/ToolbarFramePositioner"
// Side-effect import -- registers the priority-130 position-only handler. It now
// resolves only for Separator/Custom cells, whose ToolbarFlexItem shares the anchor
// with a ToolbarItem: canonical items carry their ToolbarFlexItem on a Content child
// (no ToolbarItem there), so those resolve their own ElementHandler and self-size.
import "./Helpers/ToolbarItemLayoutHandler"
import {ToolbarSizeCalculator} from "./Helpers/ToolbarSizeCalculator"
import {ToolbarItem} from "./Items/ToolbarItem"
import {ToolbarItemInput} from "./ToolbarItemInput"
import {
  AnyToolbarItemConfig,
  getDefaultBackgroundConfig,
  mergePadding,
  ToolbarAlignment,
  ToolbarAttachmentPosition,
  ToolbarConfig,
  ToolbarDirections,
  ToolbarFramePositionEnum,
  ToolbarItemType,
  ToolbarSizingMode,
  validateItemConfig,
  validateToolbarConfig
} from "./Types/ToolbarSchema"

const DEFAULT_CROSS_AXIS_SIZE = 3
const ITEM_Z_OFFSET = 0.1
// Tolerance for comparing a transform read-back against ITEM_Z_OFFSET. vec3
// components are float32-backed, so a z written as the float64 literal 0.1 reads
// back as 0.10000000149011612 and an exact `!==` is ALWAYS true — which silently
// turns a "skip when already placed" guard into dead code. That is the same
// hazard that defeated Slider's knob-moved contract (see Slider._appliedKnobZ).
// float32 relative error is <= 2^-24, about 7.5e-9 at this magnitude, so 1e-6
// has ample margin; the value matches ConfirmationSlider.applyPrismKnobDepth.
const ITEM_Z_EPSILON = 1e-6
const JUSTIFY_MAP: Record<ToolbarJustify, FlexJustify> = {
  start: FlexJustify.Start,
  center: FlexJustify.Center,
  end: FlexJustify.End
}

interface GridGroupHost {
  sceneObject: SceneObject
  gridItem: GridItem
  flex: FlexLayout
  unsubscribe: () => void
}

/**
 * Toolbar component: lays out buttons, text fields, sliders, toggles, separators, and custom items.
 * Can be attached to a Frame or used standalone. Call {@link Toolbar.initialize} before using
 * programmatic API (e.g. {@link Toolbar.addItem}); when using scene children with ToolbarItemInput,
 * initialization runs on start. Draw order comes from one Hierarchy Canvas on the toolbar's own
 * object (see {@link renderOrder}).
 */
@component
export class Toolbar extends FlexContainer implements OpacityControllable {
  @ui.group_start("Toolbar Settings")
  @input
  @allowUndefined
  @hint("Optional: Frame component to attach the toolbar to. Leave empty for standalone toolbar.")
  public frame: Frame | null = null

  @input
  @hint(
    "When enabled, toolbar fades when not targeted. With a Frame attached, targeting the Frame shows it; otherwise targeting the toolbar shows it."
  )
  public autoHideWhenFrameNotTargeted: boolean = false

  @input
  @widget(new ComboBoxWidget([new ComboBoxItem("Horizontal", "horizontal"), new ComboBoxItem("Vertical", "vertical")]))
  @hint("Direction items are laid out in the toolbar.")
  public direction: string = ToolbarDirections.HORIZONTAL
  @ui.group_end
  @ui.group_start("Size Settings")
  @input("vec2", "{25,5}")
  @hint("Size of the toolbar in centimeters (width, height).")
  public size: vec2 = new vec2(25, 5)

  @input
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Bottom", "bottom"),
      new ComboBoxItem("Top", "top"),
      new ComboBoxItem("Left", "left"),
      new ComboBoxItem("Right", "right")
    ])
  )
  @hint("Position of the toolbar relative to the Frame.")
  public framePosition: string = ToolbarFramePositionEnum.BOTTOM

  @input("number", "1")
  @hint("Gap between the toolbar and the Frame in centimeters.")
  public frameGap: number = 1

  @input
  @hint("Place toolbar inside frame (inner area) or outside. Gap applies in both cases.")
  public isToolbarInsideFrame: boolean = false

  @input
  @hint("Match toolbar size to Frame (scale factors below). Uses inner size when inside frame.")
  public fitToFrame: boolean = false

  @input("number", "1")
  @hint("Width scale relative to Frame (1.0 = same width, 0.5 = half width). Only for horizontal fit-to-frame mode.")
  @showIf("fitToFrame")
  public frameSizeScaleX: number = 1.0

  @input("number", "1")
  @hint("Height scale relative to Frame (1.0 = same height, 0.5 = half height). Only for vertical fit-to-frame mode.")
  @showIf("fitToFrame")
  public frameSizeScaleY: number = 1.0
  @ui.group_end
  @ui.group_start("Layout Settings")
  @input("number", "0.5")
  @hint("Spacing between items in centimeters.")
  public spacing: number = 0.5

  @input("number", "1")
  @hint("Left padding in centimeters.")
  public paddingLeft: number = 1

  @input("number", "1")
  @hint("Right padding in centimeters.")
  public paddingRight: number = 1

  @input("number", "0.5")
  @hint("Top padding in centimeters.")
  public paddingTop: number = 0.5

  @input("number", "0.5")
  @hint("Bottom padding in centimeters.")
  public paddingBottom: number = 0.5
  @ui.group_end
  @ui.group_start("Background")
  @input("vec4", "{0.173,0.173,0.173,1}")
  @hint("Toolbar background color (RGBA, 0-1).")
  @widget(new ColorWidget())
  public backgroundColor: vec4
  @ui.group_end
  private _config: ToolbarConfig
  private _factory: ToolbarFactory
  private _initialized: boolean = false
  private _destroyed: boolean = false
  /**
   * Type brand consumed by the Layout2D `LayoutContainerHandler`, the same one
   * FlexLayout, GridLayout, ElementGroup, Dropdown, Calendar, DatePicker and
   * ColorPicker carry. It lets a toolbar sit as an atomic item in a parent
   * FlexLayout / GridLayout / ElementGroup cell: the parent measures it through
   * {@link computeContentSizeAllModes} and sizes it through {@link width} /
   * {@link height}. Without it a toolbar in a layout cell resolved no handler,
   * measured zero, and logged the registry's naked-item warning.
   */
  public readonly __uikitBrand = UIKitBrands.LayoutContainer
  private _frameSizeUnsubscribe: (() => void) | null = null
  private _attachedItemPositioner: ToolbarAttachedItemPositioner
  private _framePositioner: ToolbarFramePositioner | null = null
  private _autoHideManager: ToolbarAutoHideManager | null = null
  private _sizeCalculator: ToolbarSizeCalculator
  private _alpha: number = 1
  // Gates visibility until the first layout pass settles: content is created at
  // default transforms in initialize(), so revealing before the first
  // finishLayoutPass shows a frame of unpositioned items. Effective alpha stays
  // 0 (independent of _alpha, so auto-hide and consumer opacity are preserved)
  // until reveal.
  private _displayReady: boolean = false
  private _layoutDirty: boolean = false
  private _appliedSize: vec2 = vec2.zero()
  // The size a parent Layout2D container last assigned through width/height.
  // Kept apart from `size`, so the parent keeps measuring the authored size.
  // Released when a consumer re-authors `size`, or in the LateUpdate once the
  // cell item that delivered it leaves its layout (releaseStaleAllocation).
  // Re-setting `size` to the value already applied is not a change and
  // releases nothing.
  private _layoutAllocation: vec2 | null = null
  // The cell item that governed this bar when the allocation arrived, or null
  // for a direct width/height write made while no layout governs it. Such a
  // write sticks: no layout delivered it, so none can take it back.
  private _allocationItem: LayoutItem2D | null = null
  private _hoverShape: BoxShape | null = null
  private _hoverCollider: ColliderComponent | null = null

  // --- Draw order: Canvas + hierarchy sorting ---
  //
  // The toolbar mints one Hierarchy Canvas on its own object (or inherits an
  // authored ancestor's), so every renderable it owns — the background plate,
  // each item's component and companions, separators, custom content — sits
  // flat at one order and tree order decides: the plate is created before the
  // item containers, and items sit +0.1 cm ahead of it in z. Descendant Buttons,
  // Sliders, Switches and TextInputFields inherit this Canvas instead of
  // minting their own (one per item before).
  //
  // What hierarchy sorting cannot do is lift the toolbar over content OUTSIDE
  // its subtree — an attached item hanging past the bar's edge over a Frame's
  // content, or two overlapping toolbars. Only renderOrder does that, and
  // renderOrder outranks every Canvas: `renderOrder` bands the whole toolbar and
  // a per-item `config.renderOrder` bands one item. Both default to 0.
  private canvasController: CanvasController | null = null
  // The controller still needs a reconcile, a given-up binding included.
  private canvasBindingDirty: boolean = false
  // Rest-disabled; armed while CanvasController.settle() asks for another attempt.
  private canvasReconcileEvent: LateUpdateEvent | null = null
  private _renderOrder: number = 0

  private _itemFlex: Map<ToolbarItem, ToolbarFlexItem> = new Map()
  private _flexToItem: Map<FlexItem, ToolbarItem> = new Map()
  private _backgroundObject: SceneObject | null = null
  private _backgroundRect: RoundedRectangle | null = null
  private _spacerObject: SceneObject | null = null
  private _spacerFlexItem: FlexItem | null = null
  private _usingGrid: boolean = false
  private _containersReady: boolean = false
  private _gridObject: SceneObject | null = null
  private _grid: GridLayout | null = null

  // Per-target flow-space reservations for primary-axis attached items, keyed by
  // target id. Recomputed each layout pass and applied as item margins so an
  // attached side button sits beside its target instead of overlapping the next
  // flow sibling. Empty when no item has a primary-axis attachment.
  private _attachmentReservations: Map<string, ToolbarMargins> = new Map()
  // The single per-rebuild attached-item size (id -> vec2), resolved once against
  // a stable pre-layout target reference and consumed by both the reservation and
  // the ToolbarAttachedItemPositioner so reserved and rendered sizes are equal.
  private _attachedItemSizes: Map<string, vec2> = new Map()
  private _gridGroups: Map<ToolbarAlignment, GridGroupHost> = new Map()

  /**
   * Toolbar background opacity (0-1). It overrides the alpha of the background
   * colour, and the toolbar's display alpha ({@link alpha}, the auto-hide fade,
   * the reveal before the first layout) scales it, so a write here survives the
   * next fade and stays hidden on a hidden bar.
   */
  public get backgroundAlpha(): number {
    return this._config?.background?.alpha ?? getDefaultBackgroundConfig().alpha
  }

  public set backgroundAlpha(value: number) {
    this.updateBackgroundConfig((bg) => (bg.alpha = value))
    this.applyBackgroundColor()
  }

  /** Toolbar background corner radius in centimeters. */
  public get backgroundCornerRadius(): number {
    return this._config?.background?.cornerRadius ?? getDefaultBackgroundConfig().cornerRadius
  }

  public set backgroundCornerRadius(value: number) {
    this.updateBackgroundConfig((bg) => (bg.cornerRadius = value))
    if (this._backgroundRect) {
      this._backgroundRect.cornerRadius = value
    }
  }

  /** Whether the toolbar background is drawn. */
  public get backgroundEnabled(): boolean {
    return this._config?.background?.enabled ?? getDefaultBackgroundConfig().enabled
  }

  public set backgroundEnabled(value: boolean) {
    this.updateBackgroundConfig((bg) => (bg.enabled = value))
    if (this._backgroundObject) {
      this._backgroundObject.enabled = value
    }
  }

  /**
   * Flat render order for every renderable the toolbar owns — the background
   * plate and each item without an explicit `config.renderOrder`. Zero (the
   * default) lets the toolbar's Hierarchy Canvas sort them by tree order and z.
   * A non-zero value is the escape hatch that lifts the whole bar out of the
   * governing Canvas bucket, over anything at a lower order — an ancestor
   * Frame's chrome, an overlapping toolbar. Set it only when the bar must cover
   * content outside its own subtree.
   */
  public get renderOrder(): number {
    return this._renderOrder
  }

  public set renderOrder(value: number) {
    if (value === undefined || value === this._renderOrder) {
      return
    }
    this._renderOrder = value
    this.applyRenderOrders()
  }

  public get backgroundRenderOrder(): number {
    return this._renderOrder
  }

  /**
   * @deprecated Use {@link renderOrder}. Kept for source compatibility, and it
   * now bands the whole toolbar rather than the plate alone: items sit flat at
   * the base order under the Canvas, so a plate-only lift would draw the plate
   * over its own items (the old plate band only stayed legible because items
   * were bumped above it).
   */
  public set backgroundRenderOrder(value: number) {
    this.renderOrder = value
  }

  /** All toolbar items in layout order. */
  public get allItems(): ToolbarItem[] {
    return this._factory?.getAllItems() ?? []
  }

  /** Current toolbar size in centimeters (width, height). */
  public get currentSize(): vec2 {
    return this._sizeCalculator?.calculateToolbarSize() ?? this._layoutAllocation ?? this.size
  }

  /** Toolbar opacity (0-1). Applied to background and items (multiplied with item alpha). */
  public get alpha(): number {
    return this._alpha
  }

  public set alpha(value: number) {
    this._alpha = value
    this.applyDisplayAlpha()
  }

  /** {@link alpha} under the kit-wide {@link OpacityControllable} name. */
  public get opacity(): number {
    return this._alpha
  }

  public set opacity(value: number) {
    this.alpha = value
  }

  // Applies the effective alpha (0 until the first layout settles, else _alpha)
  // to the background and every item. The single choke point for both the
  // reveal gate and the public alpha / auto-hide writes. Each item composes this
  // factor with its own config.alpha and REMEMBERS it (ToolbarItem.applyAlpha), so
  // a later inactive toggle can re-derive the same product instead of reverting to
  // config.alpha and revealing itself on a hidden bar. Disabled items are included
  // for the same reason: one hidden through its SceneObject comes back at the
  // bar's current alpha, not the one it was hidden at.
  private applyDisplayAlpha(): void {
    // Defense in depth for the fade: dispose() stops it on every destroy path, but
    // every toolbar-alpha write (alpha/opacity and the auto-hide fade) lands here,
    // so one that still reaches a dead toolbar stops before touching a destroyed
    // visual. Items are checked individually for the same reason — one destroyed
    // out from under the factory must not throw inside a fade.
    if (this._destroyed) {
      return
    }
    const effective = this._displayReady ? this._alpha : 0
    this.applyBackgroundAlpha(effective)
    this._factory?.getAllItems().forEach((item) => {
      if (!isNull(item)) {
        item.applyAlpha(effective)
      }
    })
  }

  public onAwake() {
    this.createEvent("OnStartEvent").bind(() => {
      this.initialize()
    })
    // A reparent fires no event of its own; OnEnable is where the governing
    // Canvas is re-resolved, inside invalidateCanvasBinding() itself.
    this.createEvent("OnEnableEvent").bind(() => this.invalidateCanvasBinding())
    // Rest-disabled retry for a binding that failed there, so the layout pump
    // carries no per-frame Canvas branch. That is hygiene, not protection: an
    // uncaught throw in any bound handler disables the whole ScriptComponent,
    // so what keeps the pump alive is that CanvasController.settle() never
    // throws. It also owns the retry budget and its logging.
    this.canvasReconcileEvent = this.createEvent("LateUpdateEvent")
    this.canvasReconcileEvent.enabled = false
    this.canvasReconcileEvent.bind(() => this.reconcileCanvasBinding())
    // Every destroy path lands here, including hierarchy destruction — a parent
    // Frame closing — which never calls destroy(). See onSceneObjectDestroyed().
    this.createEvent("OnDestroyEvent").bind(() => this.onSceneObjectDestroyed())
  }

  /**
   * Builds the toolbar from current config and discovers ToolbarItemInput children.
   * Idempotent. Required before {@link addItem}, {@link removeItem}, etc. when using the API only.
   *
   * A build that throws leaves the toolbar unbuilt, so a caller that catches the
   * error can fix the cause and call initialize() again. The toolbar's own OnStart
   * call doesn't catch: an authored toolbar that fails there (two items sharing an
   * id, say) is disabled by the uncaught throw. To recover it, fix the cause, call
   * initialize(), then set `enabled = true`.
   * @throws If the toolbar config or an authored item is invalid.
   */
  public initialize() {
    if (this._initialized) {
      return
    }

    this._config = this.buildConfigFromInputs()
    validateToolbarConfig(this._config)
    // Marked initialized only once the build has finished, so a throw leaves the
    // toolbar unbuilt and initialize() free to run again (see the JSDoc above).
    try {
      this.build()
    } catch (error) {
      this.abandonBuild()
      throw error
    }
    this._initialized = true
    // Bound last, so a build that threw leaves no pump running on a half-built bar.
    const updateEvent = this.createEvent("LateUpdateEvent")
    updateEvent.bind(this.onUpdate)
  }

  private build(): void {
    this._appliedSize = new vec2(this.size.x, this.size.y)

    this._sizeCalculator = new ToolbarSizeCalculator(
      this._config,
      this.size,
      this.fitToFrame,
      this.frameSizeScaleX,
      this.frameSizeScaleY,
      this.frame
    )
    // A parent layout may have sized the bar before it initialized.
    if (this._layoutAllocation) {
      this.syncFixedSize()
    }

    this._factory = new ToolbarFactory({root: this.sceneObject, baseRenderOrder: () => this._renderOrder})
    this._attachedItemPositioner = new ToolbarAttachedItemPositioner(this._factory)

    if (this.frame) {
      // Reparent before the Canvas resolves: an authored Canvas above the Frame
      // is then inherited instead of being shadowed by a local one minted here.
      this.sceneObject.setParent(this.frame.sceneObject)

      this._framePositioner = new ToolbarFramePositioner(this.frame, this._config, () =>
        this._sizeCalculator.calculateToolbarSize()
      )
      // The Frame announces every relayout (innerSize, margin, padding and
      // interactive scaling all end in scaleFrame), so the bar re-fits and
      // re-docks off that instead of polling innerSize every LateUpdate. The
      // Frame outlives a destroyed toolbar; both destroy paths drop this.
      this._frameSizeUnsubscribe = this.frame.onSizeChanged.add(() => this.onFrameSizeChanged())
    }

    // Invariant 1: the draw-order Canvas exists before any owned renderable, so
    // the plate and every item component resolve it as their governing Canvas
    // and mint none of their own.
    this.canvasController ??= new CanvasController(this.sceneObject)
    this.canvasController.ensure(this.canvasSize)

    // Tree order is draw order under the Canvas: the plate is created first so
    // the item containers that follow it draw over it (invariant 5).
    this.ensureBackground()
    this.buildContainers(false)
    this.updateBackgroundSize()

    if (this._framePositioner) {
      this._framePositioner.updateToolbarLocalPositionRelativeToFrame(this.getTransform())
    }

    if (this.autoHideWhenFrameNotTargeted) {
      const rootTarget = this.ensureHoverTarget()
      const hoverTarget = this.frame ? this.frame.sceneObject : rootTarget
      if (hoverTarget) {
        this._autoHideManager = new ToolbarAutoHideManager(hoverTarget, (a) => (this.alpha = a))
        this._autoHideManager.setup()
        this.alpha = this._autoHideManager.getInitialAlpha()
      }
    }

    this.discoverAndAddItems()

    // Hold the background and items hidden until the first finishLayoutPass; the
    // reveal gate stays down through the deferred first layout.
    this.applyDisplayAlpha()

    this._layoutDirty = true
  }

  // Undoes what a build that threw would leave behind for the next initialize():
  // the Frame size subscription and the auto-hide hover listeners would be added
  // twice, and items created before the throw would stay under the bar. The next
  // build reuses the plate, Canvas and hover target, and buildContainers()
  // replaces the containers.
  private abandonBuild(): void {
    this.unsubscribeFromFrame()
    this._autoHideManager?.dispose()
    this._autoHideManager = null
    this._factory?.reset()
    this._itemFlex.clear()
    this._flexToItem.clear()
  }

  // ─── Layout2D LayoutContainer participation ──────────────────────────────
  //
  // A toolbar sizes ITSELF: in "fixed" mode from `size`, in "frame-fit" mode
  // from its Frame on the main axis and `size` on the cross axis. Its items
  // shrink or grow to fit that. To a parent layout it is a rigid box at that
  // AUTHORED size, so preferred, min and max all report it. A parent's
  // allocation is kept apart in `_layoutAllocation` and drives the bar's own
  // layout in "fixed" mode; "frame-fit" never reads it, since a docked bar is
  // the Frame's to size. Writing the allocation back into `size` made every
  // pass's minimum the last allocation: a cell that grew the bar could never
  // shrink it again, because Flexbox2D floors an auto-basis item at its
  // content minimum, and the authored size was lost.

  /** The size a parent layout should reserve for this toolbar: its authored size, in every mode. */
  public computeContentSize(_opts?: {mode?: "preferred" | "min" | "max"}): {width: number; height: number} {
    const size = this.intrinsicLayoutSize()
    return {width: size.x, height: size.y}
  }

  /** All three modes at once, for `LayoutContainerHandler.measure`. */
  public computeContentSizeAllModes(): {
    preferred: {width: number; height: number}
    min: {width: number; height: number}
    max: {width: number; height: number}
  } {
    const size = this.computeContentSize()
    return {preferred: {...size}, min: {...size}, max: {...size}}
  }

  /** A toolbar's height does not depend on the width it is given. */
  public computeContentHeightForWidth(_width: number): number {
    return this.intrinsicLayoutSize().y
  }

  /**
   * Current toolbar width in centimeters. In "fixed" sizing that is a parent
   * layout's allocation when one sized the bar, else its own size. In
   * "frame-fit" it is the Frame-fitted size, and a parent's allocation is
   * ignored. A parent's apply writes the allocation here; to author the
   * toolbar's size, set {@link size}.
   */
  public get width(): number {
    return this.currentSize.x
  }

  public set width(value: number) {
    this.setLayoutAllocation(value, this.currentSize.y)
  }

  /** Current toolbar height in centimeters; see {@link width}. */
  public get height(): number {
    return this.currentSize.y
  }

  public set height(value: number) {
    this.setLayoutAllocation(this.currentSize.x, value)
  }

  // What the bar asks of a parent: the applied `size` in "fixed" mode, the
  // Frame-driven size in "frame-fit", never the allocation it was last given.
  private intrinsicLayoutSize(): vec2 {
    if (!this._initialized) {
      return this.size
    }
    return this._config.sizingMode === "frame-fit" ? this._sizeCalculator.calculateToolbarSize() : this._appliedSize
  }

  // A parent's apply runs forceLayout() right after writing width/height, so
  // the allocation has to reach the calculator synchronously here; a direct
  // write lays out on the next LateUpdate.
  private setLayoutAllocation(width: number, height: number): void {
    if (!isFinite(width) || !isFinite(height)) {
      return
    }
    this._layoutAllocation = new vec2(width, height)
    const item = this.findLayoutItem()
    this._allocationItem = item && item.parentLayout ? item : null
    if (this._initialized) {
      this.syncFixedSize()
      this._layoutDirty = true
    }
  }

  // A bar taken out of its layout would keep its last allocation for good:
  // nothing tells it, and only a changed `size` releases it. Every Layout2D
  // exit (removeItems, clearItems, rediscovery, the layout's own destroy)
  // clears the cell item's parentLayout, and destroying the item removes it,
  // so each LateUpdate checks the item that delivered the allocation and puts
  // the bar back at its authored size once that item no longer governs it.
  private releaseStaleAllocation(): void {
    const item = this._allocationItem
    if (item === null || (!isNull(item) && item.parentLayout !== null)) {
      return
    }
    this._allocationItem = null
    this._layoutAllocation = null
    this.syncFixedSize()
    this._layoutDirty = true
  }

  // In "fixed" mode the calculator reads config.size: the parent's allocation
  // when there is one, else the authored size. "frame-fit" never reads it.
  private syncFixedSize(): void {
    if (this._config.sizingMode === "fixed") {
      this._config.size = this._layoutAllocation ?? this._appliedSize
    }
  }

  // The parent layout's cell item on this bar's own SceneObject, or null
  // outside a layout. The bar's own items and inner layout live on children.
  private findLayoutItem(): LayoutItem2D | null {
    for (const component of this.sceneObject.getComponents("ScriptComponent")) {
      if (component instanceof LayoutItem2D) {
        return component
      }
    }
    return null
  }

  /** Immediately runs layout (useful when toolbar SO was disabled during the first deferred layout pass). */
  public forceLayout(): void {
    if (this._initialized) {
      this._layoutDirty = false
      this.rebuildLayout()
    }
  }

  /**
   * Adds an item from config and refreshes layout. Use {@link ToolbarItemType}, {@link ToolbarButtonType}, etc. in config.
   * @param config - Item config (e.g. ToolbarButtonConfig, ToolbarTextFieldConfig). If `id` is omitted, one is generated automatically.
   * @returns The created item instance (use its `id` for {@link getItem}, {@link removeItem}, etc.).
   * @throws If toolbar has not been initialized.
   */
  public addItem(config: AnyToolbarItemConfig): ToolbarItem {
    if (!this._initialized) {
      throw new Error("Toolbar: Must call initialize() before adding items")
    }

    const item = this._factory.createItem(config)
    this.registerItem(item)
    this._layoutDirty = true
    return item
  }

  /**
   * Removes an item by id and refreshes layout.
   * @param id - The item's id (e.g. `toolbarItem.id` from {@link addItem} return value).
   * @returns True if an item was found and removed.
   */
  public removeItem(id: string): boolean {
    if (!this._initialized) {
      return false
    }

    const item = this._factory.getItem(id)
    if (!item) {
      return false
    }

    this.unregisterItem(item)
    const removed = this._factory.destroyItem(id)
    if (removed) {
      this._layoutDirty = true
    }
    return removed
  }

  /** Returns the item with the given id, or undefined. */
  public getItem(id: string): ToolbarItem | undefined {
    return this._initialized ? this._factory.getItem(id) : undefined
  }

  /** Returns the item created from the given ToolbarItemInput, or undefined. */
  public getToolbarItem(input: ToolbarItemInput): ToolbarItem | undefined {
    return this.getItem(input.id)
  }

  /** Returns whether an item with the given id exists. */
  public hasItem(id: string): boolean {
    return this._initialized ? this._factory.hasItem(id) : false
  }

  /**
   * Runs on EVERY destroy, including a parent's, so it holds everything that must
   * stop when the toolbar dies rather than leaving it to destroy(). Two things
   * would otherwise keep writing to a dead toolbar: an in-flight auto-hide fade,
   * and — worse — the hover subscriptions on a docked bar's Frame, which survive a
   * toolbar destroyed while its Frame lives on and start a fresh fade on the next
   * hover. A fade that throws there takes down every animation in the lens (see
   * ToolbarAutoHideManager.dispose). The Frame's size subscription outlives the
   * bar the same way, so it is dropped here too. Also releases the draw-order
   * Canvas and marks the toolbar destroyed, which gates applyDisplayAlpha and
   * onFrameSizeChanged, and makes a later destroy() call a no-op instead of
   * destroying a SceneObject that is already gone. Idempotent.
   */
  private onSceneObjectDestroyed(): void {
    this._destroyed = true
    this._autoHideManager?.dispose()
    this.unsubscribeFromFrame()
    this.releaseDrawOrderCanvas()
  }

  private unsubscribeFromFrame(): void {
    this._frameSizeUnsubscribe?.()
    this._frameSizeUnsubscribe = null
  }

  /** Cleans up auto-hide, removes all items, and destroys the toolbar scene object. */
  public destroy() {
    if (this._destroyed) return
    this._destroyed = true
    this._autoHideManager?.dispose()
    this.unsubscribeFromFrame()
    this._factory?.reset()
    this._itemFlex.clear()
    this._flexToItem.clear()
    this._initialized = false
    // The items are gone (factory reset); release the Canvas before the object
    // that carries it so a created one is destroyed cleanly.
    this.releaseDrawOrderCanvas()
    this.sceneObject.destroy()
  }

  protected onFlexLayoutComplete(result: FlexLayoutResult): void {
    if (this._usingGrid) {
      return
    }
    this.applyItemLayouts(this.flexLayout, result)
    this.finishLayoutPass()
  }

  // ─── Draw order ─────────────────────────────────────────────────────

  /**
   * Re-resolves the governing Canvas after a reparent or an ancestor Canvas
   * change (the same protocol as VisualElement; the shared walker
   * `invalidateCanvasBindingsIn` calls it for subtrees moved through raw Lens
   * APIs). No-op before initialize().
   *
   * Reconciles on the spot, like Dropdown: the walker calls this on the toolbar
   * first and then descends into the items, where each Button's own controller
   * settles synchronously. A toolbar that inherited an ancestor Canvas and was
   * just moved out from under it has none at that moment; deferring the
   * reconcile would let every item mint a permanent Canvas of its own. The
   * dedicated LateUpdate retry ({@link reconcileCanvasBinding}) is only the
   * backstop for a binding that failed here. Not forwarded to descendants — the
   * walker and their own OnEnable handlers reach them.
   */
  public invalidateCanvasBinding(): void {
    if (!this.canvasController) {
      return
    }
    // Opens a fresh settle() episode, so a toolbar that gave up earlier tries
    // again on this reparent or enable.
    this.canvasController.invalidate()
    // Contained: this may run inside the walker's descent or an OnEnable
    // dispatch, and one failed binding must not abort either. A failure arms the
    // retry event.
    this.reconcileCanvasBinding()
  }

  /**
   * Settles the binding through CanvasController.settle(), which never throws
   * and owns the retry budget, and keeps the retry event armed while it asks for
   * another attempt.
   */
  private reconcileCanvasBinding(): void {
    const controller = this.canvasController
    const done = controller?.settle() ?? true
    this.canvasBindingDirty = controller?.needsReconcile ?? false
    if (this.canvasReconcileEvent) {
      this.canvasReconcileEvent.enabled = !done
    }
  }

  /**
   * Pushes the Canvas rect. This runs inside the layout container's
   * `onLayoutComplete` dispatch. `CanvasController.setSize()` re-resolves a
   * binding whose Canvas is no longer alive without throwing, and a failed
   * re-resolve joins the retry.
   */
  private syncCanvasSize(): void {
    const controller = this.canvasController
    if (!controller) {
      return
    }
    if (this.canvasBindingDirty) {
      // Settle an open or given-up binding first. setSize() takes its plain write
      // branch while the bound Canvas is alive, even if the controller is dirty,
      // and after a give-up this call is the only reconcile still running.
      this.reconcileCanvasBinding()
      if (this.canvasBindingDirty) {
        // Still unbound: nothing to size. The pass that recovers resizes.
        return
      }
    }
    if (!controller.setSize(this.canvasSize)) {
      this.canvasBindingDirty = true
      if (this.canvasReconcileEvent) {
        this.canvasReconcileEvent.enabled = true
      }
    }
  }

  private disarmCanvasRetry(): void {
    if (this.canvasReconcileEvent) {
      this.canvasReconcileEvent.enabled = false
    }
  }

  private releaseDrawOrderCanvas(): void {
    const canvasController = this.canvasController
    this.canvasController = null
    this.canvasBindingDirty = false
    this.disarmCanvasRetry()
    canvasController?.release()
  }

  // Hygiene rect for the sorting-only Canvas (plan §0.3): hierarchy sorting
  // never reads it, since nothing lays out by ScreenTransform under the toolbar.
  private get canvasSize(): vec2 {
    const size = this._sizeCalculator.calculateToolbarSize()
    return new vec2(size.x, size.y)
  }

  // Pushes the flat base order onto the plate and every item without an
  // explicit config.renderOrder (those keep theirs; see ToolbarItem.renderOrder).
  private applyRenderOrders(): void {
    if (this._backgroundRect) {
      this._backgroundRect.renderOrder = this._renderOrder
    }
    this._factory?.getAllItems().forEach((item) => item.setBaseRenderOrder(this._renderOrder))
  }

  // Hover collider on the toolbar root, not the background plate: the root is the
  // common ancestor of both the plate and the items, so hovering any item (or an
  // empty region) reaches this interactable via IK ancestor dispatch -- the same
  // aggregation a Frame provides. Hosting it on the plate instead misses item
  // hovers, since items are siblings of the plate, not descendants.
  private ensureHoverTarget(): SceneObject | null {
    const so = this.sceneObject
    if (!so) {
      return null
    }
    let collider = so.getComponent("ColliderComponent") as ColliderComponent
    if (!collider) {
      collider = so.createComponent("ColliderComponent") as ColliderComponent
    }
    if (!this._hoverShape) {
      this._hoverShape = Shape.createBoxShape() as BoxShape
      this._hoverCollider = collider
      collider.fitVisual = false
      this.updateHoverColliderSize()
    }
    if (!so.getComponent(Interactable.getTypeName())) {
      so.createComponent(Interactable.getTypeName())
    }
    return so
  }

  private updateHoverColliderSize(): void {
    if (this._hoverShape && this._hoverCollider) {
      const size = this._sizeCalculator.calculateToolbarSize()
      // Depth keeps the plate's front face (+0.05) BEHIND the item colliders'
      // front faces (z 0.1, zero depth) so item raycasts keep winning; a
      // deeper box put the plate in front and swallowed item taps.
      this._hoverShape.size = new vec3(size.x, size.y, 0.1)
      // Mutating a shape does not reach the live collider -- the shape must be
      // re-assigned after every size write (same pattern as Frame's collider).
      this._hoverCollider.shape = this._hoverShape
    }
  }

  private discoverAndAddItems() {
    const childCount = this.sceneObject.getChildrenCount()
    const inputs: ToolbarItemInput[] = []

    for (let i = 0; i < childCount; i++) {
      const child = this.sceneObject.getChild(i)
      const itemInput = child.getComponent(ToolbarItemInput.getTypeName()) as ToolbarItemInput
      if (itemInput && child.enabled && itemInput.enabled) {
        inputs.push(itemInput)
      }
    }

    // Every config is checked before any item exists. A custom item adopts the
    // developer's object, and a build that fails on a later item destroys it with
    // the rest (abandonBuild), so the factory's own rejections, an invalid config
    // or a repeated id, have to fire while nothing has been created.
    const configs: AnyToolbarItemConfig[] = []
    const ids = new Set<string>()
    for (const itemInput of inputs) {
      const config = itemInput.toConfig()
      if (!config) {
        if (itemInput.itemType === ToolbarItemType.CUSTOM) {
          const id = itemInput.id?.trim() || itemInput.sceneObject.name || "unknown"
          print(
            `WARNING: Toolbar item '${id}' is set to custom type but no customObject is attached. Skipping this item.`
          )
        }
        continue
      }
      validateItemConfig(config)
      const itemId = config.id!
      if (ids.has(itemId)) {
        throw new Error(`Toolbar item with id '${itemId}' already exists`)
      }
      ids.add(itemId)
      configs.push(config)
    }

    for (const config of configs) {
      this.registerItem(this._factory.createItem(config))
    }
  }

  private registerItem(item: ToolbarItem): void {
    // The flow member is the Content child for canonical items (its ElementHandler
    // owns size while the anchor stays pinned at origin) and the anchor itself for
    // Separator/Custom (which keep no Content-child Element; the priority-130
    // handler resolves there for position-only layout).
    const layoutObject = item.contentObject ?? item.sceneObject
    const flexItem = layoutObject.createComponent(ToolbarFlexItem.getTypeName()) as ToolbarFlexItem
    this._itemFlex.set(item, flexItem)
    this._flexToItem.set(flexItem, item)
    // Items can arrive while the toolbar is hidden (pre-reveal gate, or auto-hide
    // faded); they must adopt the current effective alpha immediately instead of
    // rendering at full opacity for a frame before the next fade or layout pass.
    const effective = this._displayReady ? this._alpha : 0
    if (effective !== 1) {
      item.applyAlpha(effective)
    }
  }

  private unregisterItem(item: ToolbarItem): void {
    const flexItem = this._itemFlex.get(item)
    if (!flexItem) {
      return
    }
    if (!this._usingGrid) {
      this.flexLayout.removeItems([flexItem])
    } else {
      this._gridGroups.forEach((group) => group.flex.removeItems([flexItem]))
    }
    this._itemFlex.delete(item)
    this._flexToItem.delete(flexItem)
  }

  private buildConfigFromInputs(): ToolbarConfig {
    let toolbarSize: vec2
    let sizingMode: ToolbarSizingMode

    if (this.fitToFrame && this.frame) {
      sizingMode = "frame-fit"
      const frameSize = this.frame.innerSize
      if (this.direction === ToolbarDirections.HORIZONTAL) {
        toolbarSize = new vec2(frameSize.x * this.frameSizeScaleX, this.size.y)
      } else {
        toolbarSize = new vec2(this.size.x, frameSize.y * this.frameSizeScaleY)
      }
    } else {
      sizingMode = "fixed"
      toolbarSize = this.size
    }

    return {
      sizingMode: sizingMode,
      size: toolbarSize,
      direction: this.direction as "horizontal" | "vertical",
      padding: {
        left: this.paddingLeft,
        right: this.paddingRight,
        top: this.paddingTop,
        bottom: this.paddingBottom
      },
      spacing: this.spacing,
      background: (() => {
        const defaults = getDefaultBackgroundConfig()
        const color = this.backgroundColor ?? defaults.color
        return {
          ...defaults,
          color,
          alpha: color.w
        }
      })(),
      framePosition: this.framePosition as ToolbarFramePositionEnum,
      frameGap: this.frameGap,
      isToolbarInsideFrame: this.isToolbarInsideFrame
    }
  }

  private updateBackgroundConfig(updater: (bg: ToolbarConfig["background"]) => void): void {
    if (this._config?.background) {
      updater(this._config.background)
    }
  }

  private onUpdate = () => {
    this.releaseStaleAllocation()
    this.refreshSizeInput()

    if (this._layoutDirty) {
      this._layoutDirty = false
      this.rebuildLayout()
    }
  }

  // Fires synchronously from inside the Frame's scaleFrame, with innerSize and
  // margin already current. The refit is only flagged here; rebuildLayout runs
  // batched in this toolbar's LateUpdate, so a scaling drag costs one pass per
  // frame, as the poll did. Re-docking is a single local-position write.
  private onFrameSizeChanged(): void {
    if (this._destroyed || !this.frame || !this._framePositioner) {
      return
    }
    if (this.fitToFrame) {
      this._layoutDirty = true
    }
    this._framePositioner.updateToolbarLocalPositionRelativeToFrame(this.getTransform())
  }

  // `size` is a plain input field, so post-init writes (and in-place mutations)
  // are detected by value each frame; the config snapshot and size calculator
  // are rebuilt so layout, background, and frame placement all follow. A
  // consumer's write re-authors the bar: it drops a parent's allocation so the
  // new size shows now, and tells the parent to re-measure, since nothing polls.
  private refreshSizeInput(): void {
    if (this._appliedSize.equal(this.size)) {
      return
    }
    this._appliedSize = new vec2(this.size.x, this.size.y)
    this._layoutAllocation = null
    this._allocationItem = null
    this.syncFixedSize()
    this._sizeCalculator = new ToolbarSizeCalculator(
      this._config,
      this._appliedSize,
      this.fitToFrame,
      this.frameSizeScaleX,
      this.frameSizeScaleY,
      this.frame
    )
    this._layoutDirty = true
    this.findLayoutItem()?.invalidateMeasure()
  }

  // ─── Layout rebuild ─────────────────────────────────────────────────

  private rebuildLayout(): void {
    if (!this._initialized) {
      return
    }

    const active = this._factory.getAllItems().filter((item) => item.sceneObject.enabled && !item.config.attachTo)
    const toolbarSize = this._sizeCalculator.calculateToolbarSize()
    const availableSpace = this._sizeCalculator.calculateAvailableContentSpace()

    const declaredCells = active.map((item) =>
      computeItemCellSize(
        {
          sizeConfig: item.config.size,
          sizeMode: item.getSizeMode(),
          intrinsicSize: item.intrinsicSize,
          minSize: item.config.minSize,
          maxSize: item.config.maxSize
        },
        this._config.direction,
        DEFAULT_CROSS_AXIS_SIZE,
        availableSpace
      )
    )

    const groups: Record<ToolbarAlignment, number[]> = {left: [], center: [], right: []}
    active.forEach((item, index) => {
      groups[resolveAlignment(item.config.alignment)].push(index)
    })

    const isHorizontalDirection = this._config.direction === ToolbarDirections.HORIZONTAL
    const spacing = this._config.spacing ?? 0.5
    const padding = mergePadding(this._config.padding)
    const primaryAxis = isHorizontalDirection ? toolbarSize.x : toolbarSize.y
    const primaryPadding = isHorizontalDirection ? padding.left + padding.right : padding.top + padding.bottom

    // Resolve each attached item's size once against a stable pre-layout target
    // reference, then reserve from those stored sizes. Reservations feed the
    // grid-fit check, so build them before planning: an attached item's
    // non-shrinkable margin is space the nested grid flex cannot reclaim, and must
    // count toward whether a side group fits its track.
    this._attachedItemSizes = this.computeAttachedItemSizes(active, declaredCells)
    this._attachmentReservations = this.buildAttachmentReservations()
    const marginByIndex = this.buildPrimaryMarginByIndex(active, isHorizontalDirection)

    // Planned before the min fit so the gap budget can count the spacer, which
    // occupies a gap of its own. The grid-fit context routes an over-stuffed
    // center-grid to the flex row using the same track budget rebuildGrid uses.
    const plan = planArrangement(
      {left: groups.left.length, center: groups.center.length, right: groups.right.length},
      declaredCells,
      {
        leftIndices: groups.left,
        centerIndices: groups.center,
        rightIndices: groups.right,
        trackBudget: primaryAxis - primaryPadding - 2 * spacing,
        spacing,
        isHorizontal: isHorizontalDirection,
        marginByIndex
      }
    )

    const gapCount = Math.max(0, active.length - 1) + (plan.needsSpacer ? 1 : 0)
    const cells = fitCellMinsToContentSpace(
      declaredCells,
      isHorizontalDirection ? availableSpace.x : availableSpace.y,
      spacing * gapCount
    )

    if (!this._containersReady || plan.useGrid !== this._usingGrid) {
      this.buildContainers(plan.useGrid)
    }

    if (this._usingGrid) {
      this.rebuildGrid(active, cells, groups, toolbarSize)
    } else {
      this.rebuildFlex(active, cells, groups, plan.needsSpacer, plan.justify, toolbarSize)
    }

    if (active.length === 0) {
      this.finishLayoutPass()
    }
  }

  private rebuildFlex(
    active: ToolbarItem[],
    cells: ToolbarCellSize[],
    groups: Record<ToolbarAlignment, number[]>,
    needsSpacer: boolean,
    justify: ToolbarJustify,
    toolbarSize: vec2
  ): void {
    const flex = this.flexLayout
    const padding = mergePadding(this._config.padding)
    const isHorizontal = this._config.direction === ToolbarDirections.HORIZONTAL
    const spacing = this._config.spacing ?? 0.5
    const contentSpace = this._sizeCalculator.calculateAvailableContentSpace()

    flex.width = toolbarSize.x
    flex.height = toolbarSize.y
    flex.direction = isHorizontal ? FlexDirection.Row : FlexDirection.ColumnReverse
    flex.columnGap = isHorizontal ? spacing : 0
    flex.rowGap = isHorizontal ? 0 : spacing
    flex.paddingTop = padding.top
    flex.paddingRight = padding.right
    flex.paddingBottom = padding.bottom
    flex.paddingLeft = padding.left
    flex.justifyContent = JUSTIFY_MAP[justify]

    const ordered: FlexItem[] = []
    const pushGroup = (indices: number[]) => {
      for (const index of indices) {
        const item = active[index]
        const flexItem = this._itemFlex.get(item)
        if (!flexItem) continue
        this.configureItemFlex(flexItem, cells[index], isHorizontal, item, contentSpace)
        this.hostItem(item, this.layoutObject)
        flexItem.order = ordered.length
        ordered.push(flexItem)
      }
    }

    pushGroup(groups.left)
    pushGroup(groups.center)
    if (needsSpacer) {
      const spacer = this.ensureSpacer()
      spacer.order = ordered.length
      ordered.push(spacer)
    }
    if (this._spacerObject) {
      this._spacerObject.enabled = needsSpacer
    }
    pushGroup(groups.right)

    this.hostInactiveItems(this.layoutObject)

    flex.clearItems()
    flex.addItems(ordered)
    flex.forceLayout()
  }

  private rebuildGrid(
    active: ToolbarItem[],
    cells: ToolbarCellSize[],
    groups: Record<ToolbarAlignment, number[]>,
    toolbarSize: vec2
  ): void {
    const grid = this._grid!
    const padding = mergePadding(this._config.padding)
    const isHorizontal = this._config.direction === ToolbarDirections.HORIZONTAL
    const spacing = this._config.spacing ?? 0.5
    const contentSpace = this._sizeCalculator.calculateAvailableContentSpace()

    grid.width = toolbarSize.x
    grid.height = toolbarSize.y
    grid.columnGap = isHorizontal ? spacing : 0
    grid.rowGap = isHorizontal ? 0 : spacing
    grid.paddingTop = padding.top
    grid.paddingRight = padding.right
    grid.paddingBottom = padding.bottom
    grid.paddingLeft = padding.left

    // Reserve equal side tracks floored at the larger side group's content, so
    // the center stays on the true midline (equal tracks) without an oversized
    // side being starved by a blind equal-share 1fr split. The reserve is capped
    // to the track budget so a genuinely narrow bar shrinks the sides to fit
    // rather than overflowing.
    const primaryAxis = isHorizontal ? toolbarSize.x : toolbarSize.y
    const primaryPadding = isHorizontal ? padding.left + padding.right : padding.top + padding.bottom
    const trackBudget = primaryAxis - primaryPadding - 2 * spacing
    const sideReserve = computeCenterGridSideReserve(
      cells,
      groups.left,
      groups.center,
      groups.right,
      trackBudget,
      isHorizontal,
      spacing,
      this.buildPrimaryMarginByIndex(active, isHorizontal)
    )
    const sideTrack = `minmax(${sideReserve}cm, 1fr)`
    if (isHorizontal) {
      grid.templateColumns = `${sideTrack} auto ${sideTrack}`
      grid.templateRows = "1fr"
    } else {
      grid.templateColumns = "1fr"
      grid.templateRows = `${sideTrack} auto ${sideTrack}`
    }

    const justifyByGroup: Record<ToolbarAlignment, FlexJustify> = {
      left: FlexJustify.Start,
      center: FlexJustify.Center,
      right: FlexJustify.End
    }

    for (const alignment of [ToolbarAlignment.LEFT, ToolbarAlignment.CENTER, ToolbarAlignment.RIGHT]) {
      const group = this._gridGroups.get(alignment)!
      const flex = group.flex
      flex.direction = isHorizontal ? FlexDirection.Row : FlexDirection.ColumnReverse
      flex.columnGap = isHorizontal ? spacing : 0
      flex.rowGap = isHorizontal ? 0 : spacing
      flex.justifyContent = justifyByGroup[alignment]

      const ordered: FlexItem[] = []
      for (const index of groups[alignment]) {
        const item = active[index]
        const flexItem = this._itemFlex.get(item)
        if (!flexItem) continue
        this.configureItemFlex(flexItem, cells[index], isHorizontal, item, contentSpace)
        this.hostItem(item, group.sceneObject)
        flexItem.order = ordered.length
        ordered.push(flexItem)
      }
      flex.clearItems()
      flex.addItems(ordered)
    }

    this.hostInactiveItems(this._gridObject!)
    grid.forceLayout()
  }

  // Resolve every enabled attached item's size once, against a stable pre-layout
  // reference for its target: the target's flow preferred cell (declaredCells)
  // normalized so a FILL target's zero primary falls back to its intrinsic width
  // rather than collapsing the attachment. This single vec2 is what both the
  // reservation below and the ToolbarAttachedItemPositioner consume, so reserved
  // and rendered sizes stay equal even after the target shrinks post-layout.
  // Only attachments whose target is an active flow item are resolved (targets
  // are keyed through declaredCells); others fall back in the positioner.
  private computeAttachedItemSizes(active: ToolbarItem[], declaredCells: ToolbarCellSize[]): Map<string, vec2> {
    const cellByItem = new Map<ToolbarItem, ToolbarCellSize>()
    active.forEach((item, index) => cellByItem.set(item, declaredCells[index]))

    const sizes = new Map<string, vec2>()
    for (const item of this._factory.getAllItems()) {
      const attachToId = item.config.attachTo
      if (!attachToId || !item.sceneObject.enabled) {
        continue
      }
      const target = this._factory.getItem(attachToId)
      const targetCell = target ? cellByItem.get(target) : undefined
      if (!target || !targetCell) {
        continue
      }
      const size = resolveNormalizedAttachedItemSize({
        sizeConfig: item.config.size,
        targetPreferredSize: targetCell.preferredSize,
        targetIntrinsicSize: target.intrinsicSize,
        direction: this._config.direction,
        minSize: item.config.minSize,
        maxSize: item.config.maxSize
      })
      sizes.set(item.config.id, size)
    }
    return sizes
  }

  // Reserve flow space beside each target for its primary-axis attached items so
  // an attached side button sits next to its target instead of overlapping the
  // next flow sibling. Each reservation projects the primary axis of the stored
  // attached size (computeAttachedItemSizes), so a FILL attachment reserves the
  // width it actually renders rather than the zero a flow-FILL cell reports. The
  // reservation plus the attachment gap is applied as a target margin in
  // configureItemFlex; the positioner then draws the item into that reserved gap.
  private buildAttachmentReservations(): Map<string, ToolbarMargins> {
    const inputs: AttachmentReservationInput[] = []
    for (const item of this._factory.getAllItems()) {
      const attachToId = item.config.attachTo
      if (!attachToId || !item.sceneObject.enabled) {
        continue
      }
      const attachedSize = this._attachedItemSizes.get(item.config.id)
      if (!attachedSize) {
        continue
      }
      const reservation = computeAttachmentReservationInput(
        {targetId: attachToId, position: item.config.attachmentPosition ?? ToolbarAttachmentPosition.RIGHT},
        attachedSize,
        this._config.direction
      )
      if (reservation) {
        inputs.push(reservation)
      }
    }
    return computeAttachmentReservations(inputs)
  }

  // Per-active-index non-shrinkable margin on the toolbar's primary axis, from
  // the attachment reservations. Aligned to the active[] order that the group
  // index arrays reference, so grid-fit and side-reserve count reserved space.
  private buildPrimaryMarginByIndex(active: ToolbarItem[], isHorizontal: boolean): number[] {
    return active.map((item) => {
      const margins = this._attachmentReservations.get(item.config.id)
      if (!margins) {
        return 0
      }
      return isHorizontal ? margins.left + margins.right : margins.top + margins.bottom
    })
  }

  private configureItemFlex(
    flexItem: ToolbarFlexItem,
    cell: ToolbarCellSize,
    isHorizontal: boolean,
    item: ToolbarItem,
    contentSpace: vec2
  ): void {
    // Rotate the Content child 90° for a vertical Slider / TextField, and pin the
    // canonical apply width for a vertical FILL toggle (its Switch spans the
    // content width while the cell stays a grow member). Both default off, so a
    // direction or config change that stops needing them resets to identity.
    flexItem.transposeAxes = item.shouldTransposeLayout()
    flexItem.applyWidthOverride = item.getContentApplyWidthOverride(contentSpace, isHorizontal)

    if (cell.wantsFillPrimary) {
      flexItem.setFlex(1, 1, 0)
    } else {
      flexItem.flexGrow = 0
      flexItem.flexShrink = 1
      flexItem.flexBasis = isHorizontal ? cell.preferredSize.x : cell.preferredSize.y
    }

    // Only a capped FILL item carries flex max constraints; everything else
    // shrinks freely so overflow always fits (legacy always-fits semantics).
    const primaryCap = cell.wantsFillPrimary && cell.fillPrimaryMax !== null ? cell.fillPrimaryMax : 0
    flexItem.maxWidth = isHorizontal ? primaryCap : 0
    flexItem.maxHeight = isHorizontal ? 0 : primaryCap
    // An item that declares minSize pins that floor against weighted shrink --
    // otherwise its neighbours' overflow silently narrows it (e.g. a Back button
    // shrinking when a center title group appears). Items without minSize keep
    // shrinking freely, so always-fits still holds by default.
    flexItem.minWidth = isHorizontal ? (cell.minPrimary ?? 0) : 0
    flexItem.minHeight = isHorizontal ? 0 : (cell.minPrimary ?? 0)

    if (isHorizontal) {
      flexItem.overrideHeight = cell.preferredSize.y
      flexItem.clearOverrideWidth()
    } else {
      flexItem.overrideWidth = cell.preferredSize.x
      flexItem.clearOverrideHeight()
    }

    // Reserve flow space for any primary-axis attached items so their footprint
    // is not packed over by the next sibling. Always written (0 when none) so a
    // removed attachment clears its reservation on the next pass.
    const reserved = this._attachmentReservations.get(item.id)
    flexItem.marginLeft = reserved?.left ?? 0
    flexItem.marginRight = reserved?.right ?? 0
    flexItem.marginTop = reserved?.top ?? 0
    flexItem.marginBottom = reserved?.bottom ?? 0
  }

  private hostItem(item: ToolbarItem, parent: SceneObject): void {
    if (item.sceneObject.getParent() !== parent) {
      item.sceneObject.setParent(parent)
    }
    if (item.contentObject) {
      // Canonical items: the anchor is an identity-transform parent of the flow
      // member (the Content child, which carries the ToolbarFlexItem). It must
      // stay pinned at container-local origin with identity rotation/scale so the
      // Content child's flex-written localPosition lands in container space; the
      // Content child carries the item z-offset.
      const pos = item.transform.getLocalPosition()
      if (pos.x !== 0 || pos.y !== 0 || pos.z !== 0) {
        item.transform.setLocalPosition(vec3.zero())
      }
    } else {
      // Separator/Custom: the anchor itself is the flow member (position-only via
      // the priority-130 handler), so it carries the item z-offset directly.
      const pos = item.transform.getLocalPosition()
      // Tolerance, not `!==`: see ITEM_Z_EPSILON. The x/y/z-against-zero compare
      // in the branch above is exact on purpose — 0 survives the float32 round
      // trip unchanged, so that guard works and needs no tolerance.
      if (Math.abs(pos.z - ITEM_Z_OFFSET) > ITEM_Z_EPSILON) {
        item.transform.setLocalPosition(new vec3(pos.x, pos.y, ITEM_Z_OFFSET))
      }
    }
  }

  // Attached and disabled items follow their target's container so attachment
  // math stays in one local frame.
  private hostInactiveItems(fallbackParent: SceneObject): void {
    for (const item of this._factory.getAllItems()) {
      if (item.sceneObject.enabled && !item.config.attachTo) {
        continue
      }
      const target = item.config.attachTo ? this._factory.getItem(item.config.attachTo) : undefined
      const parent = target ? (target.sceneObject.getParent() ?? fallbackParent) : fallbackParent
      this.hostItem(item, parent)
    }
  }

  private ensureSpacer(): FlexItem {
    if (this._spacerFlexItem && this._spacerObject && !isNull(this._spacerObject)) {
      if (this._spacerObject.getParent() !== this.layoutObject) {
        this._spacerObject.setParent(this.layoutObject)
      }
      this._spacerObject.enabled = true
      return this._spacerFlexItem
    }
    this._spacerObject = createChildSceneObjectWithParentLayer("ToolbarSpacer", this.layoutObject)
    this._spacerFlexItem = this._spacerObject.createComponent(FlexItem.getTypeName()) as FlexItem
    this._spacerFlexItem.setFlex(1, 1, 0)
    // A 1cm declared cross size keeps the no-handler apply path on the scale
    // branch instead of the naked-item warning; nothing renders either way.
    this._spacerFlexItem.overrideWidth = 1
    this._spacerFlexItem.overrideHeight = 1
    return this._spacerFlexItem
  }

  private buildContainers(useGrid: boolean): void {
    for (const item of this._factory.getAllItems()) {
      this.hostItem(item, this.sceneObject)
    }
    if (this._containersReady) {
      // Detach managed FlexItems before destroying their layout: item property
      // writes during the rebuild call _parentLayout.markDirty(), which would
      // dereference the destroyed layout's LateUpdate event and throw.
      if (this._usingGrid) {
        this._gridGroups.forEach((group) => group.flex.clearItems())
        this.teardownGrid()
      } else {
        this.flexLayout.clearItems()
        this.destroyFlexContainer()
      }
    }

    if (this._spacerObject && !isNull(this._spacerObject)) {
      this._spacerObject.destroy()
    }
    this._spacerObject = null
    this._spacerFlexItem = null

    if (useGrid) {
      this.buildGridContainers()
    } else {
      const isHorizontal = this._config.direction === ToolbarDirections.HORIZONTAL
      const toolbarSize = this._sizeCalculator.calculateToolbarSize()
      this.createFlexContainer(this.sceneObject, {
        direction: isHorizontal ? FlexDirection.Row : FlexDirection.ColumnReverse,
        alignItems: FlexAlign.Center,
        width: toolbarSize.x,
        height: toolbarSize.y,
        autoDiscoverItems: false
      })
    }

    this._usingGrid = useGrid
    this._containersReady = true
  }

  private buildGridContainers(): void {
    const isHorizontal = this._config.direction === ToolbarDirections.HORIZONTAL
    this._gridObject = createChildSceneObjectWithParentLayer("ToolbarGrid", this.sceneObject)
    this._grid = this._gridObject.createComponent(GridLayout.getTypeName()) as GridLayout
    const grid = this._grid
    // Track templates are owned by rebuildGrid, which sizes the side reserves per
    // layout pass; this method only builds the per-group containers.
    grid.justifyItems = GridAlign.Stretch
    grid.alignItems = GridAlign.Stretch

    const gridItems: GridItem[] = []
    const alignments = [ToolbarAlignment.LEFT, ToolbarAlignment.CENTER, ToolbarAlignment.RIGHT]
    alignments.forEach((alignment, index) => {
      const so = createChildSceneObjectWithParentLayer(`ToolbarGroup_${alignment}`, this._gridObject!)
      const gridItem = so.createComponent(GridItem.getTypeName()) as GridItem
      // The dirty bridge must exist before the FlexLayout starts so the nested
      // layout's sibling lookup finds it and content edits re-run the grid.
      const bridge = so.createComponent(FlexItem.getTypeName()) as FlexItem
      bridge.setParentLayout(grid)
      const flex = so.createComponent(FlexLayout.getTypeName()) as FlexLayout
      flex.autoDiscoverItemsOnStart = false
      flex.alignItems = FlexAlign.Center
      const unsubscribe = flex.onLayoutComplete.add((result: FlexLayoutResult) => {
        this.applyItemLayouts(flex, result)
      })
      // Vertical toolbars lay out bottom-up: left group in the bottom track.
      const primaryTrack = isHorizontal ? index : 2 - index
      if (isHorizontal) {
        grid.setItemPlacement(gridItem, {col: primaryTrack, row: 0})
      } else {
        grid.setItemPlacement(gridItem, {col: 0, row: primaryTrack})
      }
      this._gridGroups.set(alignment, {sceneObject: so, gridItem, flex, unsubscribe})
      gridItems.push(gridItem)
    })

    grid.addItems(gridItems)
    grid.onLayoutComplete.add(() => this.finishLayoutPass())
  }

  private teardownGrid(): void {
    this._gridGroups.forEach((group) => group.unsubscribe())
    this._gridGroups.clear()
    if (this._gridObject && !isNull(this._gridObject)) {
      this._gridObject.destroy()
    }
    this._gridObject = null
    this._grid = null
  }

  // ─── Layout application ─────────────────────────────────────────────

  private applyItemLayouts(layout: FlexLayout, result: FlexLayoutResult): void {
    const contentSpace = this._sizeCalculator.calculateAvailableContentSpace()
    const managed = layout.items
    // Size every item first, then fire the per-item size callbacks. A callback
    // may re-enter the toolbar (e.g. a consumer's onResize adds/removes items),
    // so it must not run while this loop is still indexing the live item set.
    const resized: ToolbarItem[] = []
    for (const output of result.items) {
      const flexItem = managed[output.index]
      const item = flexItem ? this._flexToItem.get(flexItem) : undefined
      if (!item) {
        continue
      }
      const finalSize = item.getFinalLayoutSize(new vec2(output.width, output.height), contentSpace)
      // Canonical items are sized by their Content-child ElementHandler during the
      // flex pass (matching finalSize via the ToolbarFlexItem apply hooks), so the
      // toolbar no longer writes their component size. Separator/Custom keep no
      // Content Element, so their visual is still sized from computedSize + this
      // manual pass (scale reset; separator visual follows computedSize).
      if (item.contentObject) {
        item.computedSize = finalSize
      } else {
        item.applyLayoutSize(finalSize, false)
      }
      if (item.onLayoutSizeApplied) {
        resized.push(item)
      }
    }
    for (const item of resized) {
      item.onLayoutSizeApplied!()
    }
  }

  private finishLayoutPass(): void {
    this.updateBackgroundSize()
    this._attachedItemPositioner.positionAttachedItems(this._factory.getAllItems(), this._attachedItemSizes)
    if (this._framePositioner) {
      this._framePositioner.updateToolbarLocalPositionRelativeToFrame(this.getTransform())
    }
    // Reveal after the first settled layout: items are now positioned and sized,
    // so lifting the alpha gate no longer exposes an unlaid-out frame.
    if (!this._displayReady) {
      this._displayReady = true
      this.applyDisplayAlpha()
    }
  }

  // ─── Background ─────────────────────────────────────────────────────

  private ensureBackground(): void {
    if (this._backgroundRect) {
      return
    }
    const bgConfig = this._config.background
    const defaults = getDefaultBackgroundConfig()

    // Created objects land on the default layer regardless of parent; copy the
    // toolbar's so the plate renders with the bar.
    this._backgroundObject = createChildSceneObjectWithParentLayer("ToolbarBackground", this.sceneObject)
    this._backgroundRect = this._backgroundObject.createComponent(RoundedRectangle.getTypeName()) as RoundedRectangle
    this._backgroundRect.gradient = false
    this._backgroundRect.border = false
    this._backgroundRect.blendMode = RoundedRectBlendMode.Normal
    // Auto-hide rests the plate at opacity 0; skip the draw there instead of shading it.
    this._backgroundRect.cullWhenTransparent = true
    this._backgroundRect.cullIncludesOpacity = true
    // Flat at the toolbar's order: the plate is the first child, so tree order
    // under the Canvas already draws it behind the items, and the items' +0.1 cm
    // z step keeps them clear of its depth. No plate/item band.
    this._backgroundRect.renderOrder = this._renderOrder
    this._backgroundRect.cornerRadius = bgConfig?.cornerRadius ?? defaults.cornerRadius
    this.applyBackgroundColor()
    this._backgroundObject.enabled = bgConfig?.enabled ?? defaults.enabled
    // Shape defers RenderMeshVisual creation to OnStart; force it now (size
    // must be finite first) so init-time alpha writes land on a real visual --
    // an auto-hide toolbar must start with the plate hidden, not just items.
    this._backgroundRect.size = this._sizeCalculator.calculateToolbarSize()
    this._backgroundRect.initialize()
    // Hidden until the first layout pass reveals the bar: that reveal
    // (applyDisplayAlpha) applies the display alpha, including one written before
    // the plate existed. A new plate starts at opacity 1, so this write is also
    // what keeps it hidden if the rest of the build throws.
    this.applyBackgroundAlpha(0)
  }

  private updateBackgroundSize(): void {
    if (this._backgroundRect) {
      this._backgroundRect.size = this._sizeCalculator.calculateToolbarSize()
    }
    this.syncCanvasSize()
    this.updateHoverColliderSize()
  }

  // ToolbarBackgroundConfig documents `alpha` as overriding color.w, so the
  // configured alpha goes into the plate's colour. The display alpha (the reveal
  // gate, alpha/opacity, the auto-hide fade) scales it through the plate's
  // opacity instead (applyBackgroundAlpha), so neither write undoes the other.
  private applyBackgroundColor(): void {
    if (this._destroyed || !this._backgroundRect || isNull(this._backgroundRect)) {
      return
    }
    const background = this._config?.background
    const color = background?.color ?? getDefaultBackgroundConfig().color
    this._backgroundRect.backgroundColor = new vec4(color.x, color.y, color.z, background?.alpha ?? color.w)
  }

  private applyBackgroundAlpha(alpha: number): void {
    if (this._backgroundRect?.renderMeshVisual) {
      // Route through the opacity setter so the rect's backing state stays in
      // sync -- a raw opacityFactor write is silently reverted if the material
      // is ever re-assigned (applyMaterial resets the pass from backing state).
      this._backgroundRect.opacity = alpha
      this._backgroundRect.renderMeshVisual.enabled = true
    }
  }
}

import Event, {PublicApi} from "InteractionKit.lspkg/Utils/Event"
import * as MotionChannels from "Motion.lspkg/Channels"
import {UIlevel0} from "../../Themes/System-3.0/Colors"
import {FlexContainer} from "../../Utility/FlexContainer"
import {DEFAULT_BUTTON_CORNER_RADIUS} from "../Button/Button"
import {Dropdown} from "../Dropdown/Dropdown"
import {FlexItem} from "../Layout2D/Flex/FlexItem"
import {FlexAlign, FlexAlignSelf, FlexDirection, FlexLayoutResult} from "../Layout2D/Flex/FlexTypes"
import {UIKitBrands} from "../Layout2D/UIKitBrands"
import {ScrollWindow} from "../ScrollWindow/ScrollWindow"
import {VisualElement} from "../VisualElement"

const BG_Z_OFFSET = -0.18
const DRAWER_BRIDGE_EXTENSION = 0.5
const MIN_SEGMENT_HEIGHT = 0.1
const BG_WRITE_EPSILON = 0.001

interface SegmentInfo {
  top: number
  height: number
}

interface BgWriteCache {
  w: number
  h: number
  cy: number
}

interface DropdownState {
  unsub: () => void
  flexItem: FlexItem
  /** Cached make-room margin channels, one per expand direction. */
  marginChannelUp?: MotionChannels.ChannelSelector<number>
  marginChannelDown?: MotionChannels.ChannelSelector<number>
}

/**
 * Per-cell options accepted by {@link ElementGroup.addItem}. None of the
 * fields are required — omit them to let the item's handler resolve a natural
 * size and use the group's default alignment.
 */
export interface CellOptions {
  /** Sort key. Lower order = earlier in the group. */
  order?: number
  /**
   * Free-axis size in cm. Omit (or pass 0) to use the item's handler-resolved
   * preferred size. The group-locked axis (vertical → group.width,
   * horizontal → group.height) always wins regardless of this value.
   */
  width?: number
  /** Symmetric to {@link width}. */
  height?: number
  /**
   * When true, the cell stretches the item to fill the cell bounds. When
   * false, the item keeps its natural size and is aligned with margins.
   * Defaults to `true` — matches the legacy ElementGroup look (items fill
   * the column / row) and scene-discovered items. Pass `false` explicitly
   * to opt out for natural-size items.
   */
  stretchToFill?: boolean
  /** Free-axis alignment when `stretchToFill` is off. `"Left" | "Center" | "Right"`. */
  alignment?: string
}

/**
 * Internal per-cell metadata stored alongside each FlexItem. Tracks the
 * group-specific knobs that don't live on the FlexItem itself (Dropdown
 * sibling, stretch/alignment policy).
 */
interface CellMeta {
  dropdown: Dropdown | null
  stretchToFill: boolean
  alignment: string
}

/**
 * ElementGroup — arranges items in a horizontal or vertical group with a shared background.
 *
 * **Content-agnostic.** Pass any SceneObject — a Button, a Text, an Image,
 * a Frame, a Slider, or a custom widget with a registered handler — to
 * `addItem()` and the group sizes it using the item's `ItemHandler`. For
 * widgets with a Dropdown component, the group still handles expansion /
 * collapse animation and background segmentation automatically.
 *
 * **Programmatic:**
 * ```ts
 * group.addItem(buttonObj)                          // handler-sized
 * group.addItem(buttonObj, {width: 6, alignment: "Center"})
 * group.addItem(buttonObj, {stretchToFill: true})   // fills the cell
 * group.addItems([objA, objB, objC])                // batch
 * ```
 *
 * **Scene-based:** Attach a `FlexItem` to any direct child SceneObject — the
 * group collects, sorts by `FlexItem.order`, and auto-adds them. Scene-based
 * items default to `stretchToFill: true` and left alignment; switch to the
 * programmatic API if you need other defaults.
 *
 * **Scroll mode:** Set the optional `Scroll Window` input (and place the
 * group under the ScrollWindow's SceneObject so it is adopted as scroller
 * content). The group fits its locked axis to the viewport, pins itself to
 * the viewport's top (vertical) / left (horizontal) edge, and pushes its
 * content size into `scrollWindow.scrollDimensions` after every layout pass
 * — no manual offsets or scroll-dimension bookkeeping needed.
 */
@component
export class ElementGroup extends FlexContainer {
  /**
   * Type brand consumed by the Layout2D `LayoutContainerHandler`. Lets
   * ElementGroup participate as an atomic item in a parent FlexLayout /
   * GridLayout / ElementGroup — the parent reads its size via
   * {@link computeContentSize} and positions it via the handler's apply.
   */
  public readonly __uikitBrand = UIKitBrands.LayoutContainer

  @input
  @label("Direction")
  @widget(new ComboBoxWidget([new ComboBoxItem("Horizontal", "Horizontal"), new ComboBoxItem("Vertical", "Vertical")]))
  @hint(
    "Init-only. Cannot be changed after start. In horizontal mode, child Dropdown drawers expand independently with their own drawer backgrounds (no background segmentation)."
  )
  private _direction: string = "Horizontal"

  @input
  @showIf("_direction", "Vertical")
  @hint("Init-only. Width applied to all items in vertical mode (centimeters)")
  private _width: number = 9.5

  @input
  @showIf("_direction", "Horizontal")
  @hint("Init-only. Height applied to all items in horizontal mode (centimeters)")
  private _height: number = 3

  @input
  @hint("Init-only. Gap between items in centimeters")
  private _spacing: number = 0.5

  @input("vec2", "{0.5, 0.5}")
  @hint("Per-side padding (horizontal, vertical) in centimeters")
  private _padding: vec2 = new vec2(0.5, 0.5)

  @input
  private _backgroundEnabled: boolean = true

  @input
  @allowUndefined
  @label("Scroll Window")
  @hint(
    "Optional. When set, the group becomes the window's scrolling content: it fits its locked axis to the viewport (minus padding), pins its leading edge to the viewport's leading edge, and drives the window's scrollDimensions from its own content size. The group owns its SceneObject's local position in this mode."
  )
  private _scrollWindow: ScrollWindow | undefined

  // --- Internal state ---
  private items: FlexItem[] = []
  private cellMeta: Map<FlexItem, CellMeta> = new Map()
  private pendingDropdownResizes: {dropdown: Dropdown; width: number; height: number}[] = []

  private dropdownStates: Map<Dropdown, DropdownState> = new Map()

  private lastLayoutResult: FlexLayoutResult | null = null
  private anchorOffset: number = 0
  private lastEmittedSize: vec2 | null = null

  // Reused across updateBackground / updateAnchorOffset calls to avoid per-frame
  // allocations during dropdown expand/collapse animation (called every tick).
  private scratchSegments: SegmentInfo[] = []
  private bgWriteCache: BgWriteCache[] = []
  private lastAppliedAnchorOffset: number = NaN
  private anchorPosScratch: vec3 = new vec3(0, 0, 0)

  // Scroll mode (see `_scrollWindow`). Unsubs stored for destroy (the window
  // outlives the group); NaN caches make the first pin/feed always write.
  private scrollModeActive: boolean = false
  private scrollWindowInitUnsub: (() => void) | null = null
  private scrollWindowSizeUnsub: (() => void) | null = null
  private lastScrollPin: number = NaN
  private lastScrollPinCross: number = NaN
  private lastFedExtent: number = NaN

  // --- Events ---
  private onItemAddedEvent = new Event<FlexItem>()
  public onItemAdded: PublicApi<FlexItem> = this.onItemAddedEvent.publicApi()

  private onItemRemovedEvent = new Event<FlexItem>()
  public onItemRemoved: PublicApi<FlexItem> = this.onItemRemovedEvent.publicApi()

  private onSizeChangedEvent = new Event<vec2>()
  public onSizeChanged: PublicApi<vec2> = this.onSizeChangedEvent.publicApi()

  // --- Getters/Setters ---
  public get direction(): string {
    return this._direction
  }
  public get width(): number {
    return this._width
  }
  /**
   * No-op setter. `_width` is init-only and the group's locked-axis size is
   * fixed once layout begins. The setter exists so `LayoutContainerHandler`
   * can write through here without throwing when ElementGroup participates
   * as an atomic item in a parent layout — the parent's allocation is
   * acknowledged but the group sizes itself.
   */
  public set width(_value: number) {
    // intentional no-op
  }
  public get height(): number {
    return this._height
  }
  /** No-op setter; symmetric to {@link width}. */
  public set height(_value: number) {
    // intentional no-op
  }
  public get spacing(): number {
    return this._spacing
  }
  public get padding(): vec2 {
    return this._padding
  }
  public get cornerRadius(): number {
    // Concentric with the inner buttons: extend the button's default corner
    // radius by the group padding so the visual gap stays uniform. min() keeps
    // it from over-rounding when padding is non-uniform.
    return DEFAULT_BUTTON_CORNER_RADIUS + Math.min(this._padding.x, this._padding.y)
  }
  public get backgroundEnabled(): boolean {
    return this._backgroundEnabled
  }
  private get isVertical(): boolean {
    return this._direction === "Vertical"
  }

  // --- Lifecycle ---

  public onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.initialize())
    this.createEvent("OnDestroyEvent").bind(() => this.destroy())
  }

  private initialize(): void {
    this.createFlexContainer(this.sceneObject, {
      direction: this.isVertical ? FlexDirection.Column : FlexDirection.Row,
      alignItems: FlexAlign.Stretch,
      width: this.isVertical ? this._width : -1,
      height: this.isVertical ? -1 : this._height,
      rowGap: this.isVertical ? this._spacing : undefined,
      columnGap: this.isVertical ? undefined : this._spacing,
      autoDiscoverItems: false
    })
    this.discoverItems()
    if (this._scrollWindow) this.enterScrollMode()
  }

  public destroy(): void {
    this.scrollWindowInitUnsub?.()
    this.scrollWindowInitUnsub = null
    this.scrollWindowSizeUnsub?.()
    this.scrollWindowSizeUnsub = null
    this.scrollModeActive = false
    this.lastScrollPin = NaN
    this.lastScrollPinCross = NaN
    this.lastFedExtent = NaN
    this.dropdownStates.forEach((state) => {
      state.unsub()
    })
    this.dropdownStates.clear()
    this.pendingDropdownResizes = []
    this.lastLayoutResult = null
    this.anchorOffset = 0
    this.lastEmittedSize = null
    this.items = []
    this.cellMeta.clear()
    this.destroyFlexContainer()
  }

  // --- FlexContainer override ---

  protected onFlexLayoutComplete(result: FlexLayoutResult): void {
    this.lastLayoutResult = result

    if (this.pendingDropdownResizes.length > 0) {
      for (const pending of this.pendingDropdownResizes) {
        pending.dropdown.resizeTriggerButton(pending.width, pending.height)
      }
      this.pendingDropdownResizes = []
    }

    this.updateAnchorOffset()
    this.updateBackground()
    if (this.scrollModeActive) this.syncScrollWindow(result)
  }

  // --- ScrollWindow integration (scroll mode) ---

  /**
   * Entered from `initialize()` when the optional `_scrollWindow` input is
   * set. The group becomes the window's content column/row: the locked axis
   * is fitted to the viewport, the group is pinned to the viewport's leading
   * edge, and every layout pass feeds the outer content size into
   * `scrollWindow.scrollDimensions` — the window never measures content
   * itself.
   */
  private enterScrollMode(): void {
    const scrollWindow = this._scrollWindow
    if (!scrollWindow) return
    // onInitialized is a ReplayEvent — the handler also runs (synchronously)
    // when the window initialized before this group did.
    this.scrollWindowInitUnsub = scrollWindow.onInitialized.add(() => this.onScrollWindowReady(scrollWindow))
  }

  private onScrollWindowReady(scrollWindow: ScrollWindow): void {
    this.scrollModeActive = true
    this.applyViewportLock(scrollWindow)
    this.scrollWindowSizeUnsub = scrollWindow.onSizeChanged.add(() => {
      this.applyViewportLock(scrollWindow)
      // The lock early-returns when the locked axis is unchanged (no layout
      // pass scheduled), but the pin and fed extent also depend on the
      // scroll-axis window size — re-sync from the last layout directly.
      if (this.lastLayoutResult) this.syncScrollWindow(this.lastLayoutResult)
    })
    // If a layout pass already completed, pin + feed from it now; otherwise
    // the pass triggered by applyViewportLock (or the initial one) will.
    if (this.lastLayoutResult) this.syncScrollWindow(this.lastLayoutResult)
  }

  /**
   * Fits the locked axis to the viewport's inner size: vertical groups take
   * `windowSize.x` minus horizontal padding, horizontal groups `windowSize.y`
   * minus vertical padding — so the background (content + padding) spans the
   * viewport exactly. Stretch cells added before the window was ready were
   * pinned to the authored size, so they are re-pinned here. (Dropdown
   * triggers configured at add time keep their configured size; wire the
   * window before adding dropdowns if the sizes must match.)
   */
  private applyViewportLock(scrollWindow: ScrollWindow): void {
    const windowSize = scrollWindow.windowSize
    if (this.isVertical) {
      const inner = windowSize.x - this._padding.x * 2
      if (inner <= 0 || Math.abs(inner - this._width) < BG_WRITE_EPSILON) return
      this._width = inner
      this.flexLayout.width = inner
      for (let i = 0; i < this.items.length; i++) {
        const flexItem = this.items[i]
        if (this.cellMeta.get(flexItem)?.stretchToFill) flexItem.overrideWidth = inner
      }
    } else {
      const inner = windowSize.y - this._padding.y * 2
      if (inner <= 0 || Math.abs(inner - this._height) < BG_WRITE_EPSILON) return
      this._height = inner
      this.flexLayout.height = inner
      for (let i = 0; i < this.items.length; i++) {
        const flexItem = this.items[i]
        if (this.cellMeta.get(flexItem)?.stretchToFill) flexItem.overrideHeight = inner
      }
    }
  }

  /**
   * Pins the group so its leading edge hugs the viewport's leading edge, and
   * feeds the outer size to the window. The group's visual block is centered
   * on its origin, so the pin places the block center relative to the
   * window's content frame: under the classic "Center" content origin that is
   * half the viewport minus half the content (window-relative); under
   * "TopLeft" it is simply half the content itself (content-relative — the
   * page origin IS (0,0)). `anchorOffset` (dropdown drawer compensation)
   * shifts the rendered block off the origin vertically, so the y pin folds
   * it in — in both directions' modes. All writes are value-gated: layout passes re-run on any
   * dirty flex state, but the window only hears about real changes.
   */
  private syncScrollWindow(result: FlexLayoutResult): void {
    const scrollWindow = this._scrollWindow
    if (!scrollWindow) return
    const windowSize = scrollWindow.windowSize
    const topLeft = scrollWindow.contentOrigin === "TopLeft"
    if (this.isVertical) {
      const outerHeight = result.containerHeight + this._padding.y * 2
      const outerWidth = this._width + this._padding.x * 2
      const pin = (topLeft ? 0 : windowSize.y * 0.5) - outerHeight * 0.5 - this.anchorOffset
      const pinCross = topLeft ? outerWidth * 0.5 : 0
      if (
        !(Math.abs(this.lastScrollPin - pin) < BG_WRITE_EPSILON) ||
        !(Math.abs(this.lastScrollPinCross - pinCross) < BG_WRITE_EPSILON)
      ) {
        this.lastScrollPin = pin
        this.lastScrollPinCross = pinCross
        const transform = this.sceneObject.getTransform()
        const position = transform.getLocalPosition()
        position.x = pinCross
        position.y = pin
        transform.setLocalPosition(position)
      }
      const extent = outerHeight > windowSize.y ? outerHeight : windowSize.y
      if (!(Math.abs(this.lastFedExtent - extent) < BG_WRITE_EPSILON)) {
        this.lastFedExtent = extent
        scrollWindow.scrollDimensions = new vec2(windowSize.x, extent)
      }
    } else {
      const outerWidth = result.containerWidth + this._padding.x * 2
      const outerHeight = this._height + this._padding.y * 2
      const pin = outerWidth * 0.5 - (topLeft ? 0 : windowSize.x * 0.5)
      // anchorOffset shifts the block vertically in horizontal mode too
      // (opt-out dropdown cells set top/bottom margins), so the y pin
      // compensates in both modes.
      const pinCross = (topLeft ? -outerHeight * 0.5 : 0) - this.anchorOffset
      if (
        !(Math.abs(this.lastScrollPin - pin) < BG_WRITE_EPSILON) ||
        !(Math.abs(this.lastScrollPinCross - pinCross) < BG_WRITE_EPSILON)
      ) {
        this.lastScrollPin = pin
        this.lastScrollPinCross = pinCross
        const transform = this.sceneObject.getTransform()
        const position = transform.getLocalPosition()
        position.x = pin
        position.y = pinCross
        transform.setLocalPosition(position)
      }
      const extent = outerWidth > windowSize.x ? outerWidth : windowSize.x
      if (!(Math.abs(this.lastFedExtent - extent) < BG_WRITE_EPSILON)) {
        this.lastFedExtent = extent
        scrollWindow.scrollDimensions = new vec2(extent, windowSize.y)
      }
    }
  }

  // --- Item Discovery ---

  /**
   * Scans direct children for a FlexItem and auto-adds each (sorted by
   * `FlexItem.order`). Items discovered this way default to
   * `stretchToFill: true` and `alignment: "Left"`.
   */
  private discoverItems(): void {
    const found: {order: number; idx: number; flexItem: FlexItem}[] = []
    const childCount = this.sceneObject.getChildrenCount()
    // `instanceof FlexItem` (not `getComponent(FlexItem.getTypeName())`)
    // so FlexItem subclasses — DropdownItem and any user composite — are
    // still auto-discovered.
    for (let i = 0; i < childCount; i++) {
      const child = this.sceneObject.getChild(i)
      const scripts = child.getComponents("ScriptComponent")
      for (const c of scripts) {
        if (c instanceof FlexItem) {
          found.push({order: c.order, idx: i, flexItem: c})
          break
        }
      }
    }
    // Sort by `order`, breaking ties on discovery (hierarchy) index so equal-
    // order items keep their hierarchy sequence regardless of sort stability.
    found.sort((a, b) => a.order - b.order || a.idx - b.idx)
    for (const entry of found) {
      entry.flexItem.sceneObject.getTransform().setLocalPosition(vec3.zero())
      entry.flexItem.sceneObject.getTransform().setLocalScale(vec3.one())
      // Scene-discovered items inherit the legacy "stretch to fill" default.
      this.addItem(entry.flexItem, {stretchToFill: true})
    }
  }

  // --- Public Item Management ---

  /**
   * Adds an item to the group.
   *
   * Accepts a `FlexItem` (or any `SceneObject`, in which case a `FlexItem` is
   * synthesized). With no `opts`, the item's `ItemHandler` resolves the
   * natural size — no `9×3 cm` defaults are imposed. Pass `opts` to override
   * size, stretch behavior, alignment, or order.
   *
   * Returns the resolved (or synthesized) FlexItem so callers can tweak
   * properties afterward (e.g. `flexItem.overrideWidth = 6`).
   */
  public addItem(input: FlexItem | SceneObject, opts?: CellOptions): FlexItem {
    const flexItem = this.resolveOrSynthesizeItem(input)
    const meta = this.createCellMeta(flexItem, opts)
    this.cellMeta.set(flexItem, meta)

    const dropdown = meta.dropdown
    if (dropdown) {
      this.configureDropdown(dropdown, flexItem, meta)
    }
    this.addItemInternal(flexItem, meta)
    if (dropdown) {
      if (meta.stretchToFill) {
        const cell = this.computeCellSize(flexItem, meta)
        // Guard 0: overrideWidth/Height = 0 pins the cell to 0 (collapse). A
        // computed cell size can be 0 before the content is measured, so only
        // pin a real size — matches the opts path and Dropdown's "0 = unset".
        if (cell.x > 0) flexItem.overrideWidth = cell.x
        if (cell.y > 0) flexItem.overrideHeight = cell.y
        this.pendingDropdownResizes.push({dropdown, width: cell.x, height: cell.y})
      } else {
        // Opt out: trigger keeps its own size, drawer follows dropdown's settings.
        // Still push to pendingDropdownResizes so resizeTriggerButton runs after
        // layout — it disables triggerContent.autoResize, which would otherwise
        // re-fit the auto-generated trigger to its content width and override
        // the user's `triggerButtonSize` @input.
        const triggerSize = this.applyDropdownOptOutLayout(flexItem, dropdown, meta)
        this.pendingDropdownResizes.push({dropdown, width: triggerSize.x, height: triggerSize.y})
      }

      // Don't force collapse: the dropdown fires onExpandedChanged on its first layout pass,
      // so its startExpanded state is honored and our handler syncs the margin.
      this.wireDropdownExpansion(dropdown, flexItem)
    }
    this.updateDropdownBridges()
    return flexItem
  }

  /**
   * Batch form of {@link addItem}. Returns the resolved FlexItems in input
   * order. Accepts a mix of FlexItems and raw SceneObjects. Each input can
   * carry its own `opts` by passing `[input, opts]` tuples; bare items
   * inherit the defaults (handler-resolved sizing, no stretch).
   */
  public addItems(inputs: ReadonlyArray<FlexItem | SceneObject | [FlexItem | SceneObject, CellOptions]>): FlexItem[] {
    const out: FlexItem[] = []
    for (const input of inputs) {
      if (Array.isArray(input)) {
        out.push(this.addItem(input[0], input[1]))
      } else {
        out.push(this.addItem(input))
      }
    }
    return out
  }

  /**
   * Resolves the input to a FlexItem. If the input is a FlexItem, returned
   * as-is. If it's a SceneObject, find an existing FlexItem or create one.
   */
  private resolveOrSynthesizeItem(input: FlexItem | SceneObject): FlexItem {
    if (input instanceof FlexItem) {
      return input
    }
    const sceneObj = input as SceneObject
    // Use `instanceof` so an existing FlexItem subclass on the SceneObject
    // (DropdownItem, LabeledBadge, …) is reused instead of synthesizing a
    // duplicate plain FlexItem alongside it.
    const scripts = sceneObj.getComponents("ScriptComponent")
    for (const c of scripts) {
      if (c instanceof FlexItem) {
        return c
      }
    }
    return sceneObj.createComponent(FlexItem.getTypeName()) as FlexItem
  }

  /**
   * Builds the {@link CellMeta} from the per-cell options + the FlexItem's
   * subtree. Also writes through opts to the FlexItem itself (overrideWidth,
   * order, alignSelf) so the layout pass uses them.
   */
  private createCellMeta(flexItem: FlexItem, opts?: CellOptions): CellMeta {
    if (opts?.width !== undefined && opts.width > 0) flexItem.overrideWidth = opts.width
    if (opts?.height !== undefined && opts.height > 0) flexItem.overrideHeight = opts.height
    if (opts?.order !== undefined) flexItem.order = opts.order

    const alignment = opts?.alignment ?? "Left"
    // Default to `stretchToFill: true` so programmatic `addItem(obj)` matches
    // the legacy ElementGroup look (items fill the column in vertical mode /
    // the row in horizontal mode). This also matches scene-discovered items'
    // default. Pass `{stretchToFill: false}` explicitly to opt out.
    const stretchToFill = opts?.stretchToFill ?? true
    flexItem.flexGrow = stretchToFill ? 1 : 0
    flexItem.alignSelf = alignmentToFlexAlignSelf(alignment)

    return {
      dropdown: findDropdownInSubtree(flexItem.sceneObject),
      stretchToFill,
      alignment
    }
  }

  public removeItemAt(index: number): void {
    if (index < 0 || index >= this.items.length) return
    const flexItem = this.items[index]
    const meta = this.cellMeta.get(flexItem)

    const dropdown = meta?.dropdown ?? null
    const state = dropdown ? this.dropdownStates.get(dropdown) : undefined
    if (dropdown && state) {
      state.unsub()
      dropdown.setExternalGrowth([])
      this.dropdownStates.delete(dropdown)
      flexItem.marginTop = 0
      flexItem.marginBottom = 0
    }

    this.flexLayout.removeItems([flexItem])
    // Release ownership: reparent out of the internal layout container. Caller
    // decides what to do next (destroy, hide, reparent, or re-add via addItem).
    if (!isNull(flexItem.sceneObject)) flexItem.sceneObject.setParent(this.sceneObject)
    this.items.splice(index, 1)
    this.cellMeta.delete(flexItem)
    this.updateAnchorOffset()
    this.updateDropdownBridges()
    this.onItemRemovedEvent.invoke(flexItem)
  }

  public getItems(): ReadonlyArray<FlexItem> {
    return this.items
  }
  public getItemCount(): number {
    return this.items.length
  }

  // --- Layout2D LayoutContainer participation ---

  /**
   * Reports the group's intrinsic size to a parent Layout2D container.
   * Delegates to the internal {@link flexLayout} so the parent sees the
   * actual content extent. Padding is added on top.
   *
   * Called by `LayoutContainerHandler` when this ElementGroup is itself
   * a child item in another FlexLayout / GridLayout / ElementGroup.
   */
  public computeContentSize(opts?: {mode?: "preferred" | "min" | "max"}): {width: number; height: number} {
    if (!this.flexLayout) {
      // OnStart hasn't fired yet — fall back to the inspector-authored
      // locked-axis size and zero for the free axis. The free axis will
      // become accurate on the next measure pass after initialize().
      return {width: this._width, height: this._height}
    }
    const inner = this.flexLayout.computeContentSize(opts)
    return {
      width: inner.width + this._padding.x * 2,
      height: inner.height + this._padding.y * 2
    }
  }

  /** All three modes via the inner layout's shared memo; padding added on top. */
  public computeContentSizeAllModes(): {
    preferred: {width: number; height: number}
    min: {width: number; height: number}
    max: {width: number; height: number}
  } {
    if (!this.flexLayout) {
      const s = {width: this._width, height: this._height}
      return {preferred: {...s}, min: {...s}, max: {...s}}
    }
    const pad = (sz: {width: number; height: number}) => ({
      width: sz.width + this._padding.x * 2,
      height: sz.height + this._padding.y * 2
    })
    const inner = this.flexLayout.computeContentSizeAllModes()
    return {preferred: pad(inner.preferred), min: pad(inner.min), max: pad(inner.max)}
  }

  /**
   * Re-runs the internal layout pass synchronously. Called by
   * `LayoutContainerHandler.apply` after the parent allocates a cell.
   */
  public forceLayout(): void {
    if (this.flexLayout) {
      this.flexLayout.forceLayout()
    }
  }

  // --- Internal ---

  /**
   * For `customTrigger`, true size lives on `topButton.size` (`triggerButtonSize` is
   * hidden in the inspector). Falls back to `triggerButtonSize` with a warning if
   * `topButton` isn't linked yet — alignment margins from the fallback will be wrong.
   */
  private getEffectiveTriggerSize(dropdown: Dropdown): vec2 {
    if (dropdown.customTrigger) {
      if (dropdown.topButton) {
        const size = dropdown.topButton.size
        return new vec2(size.x, size.y)
      }
      print("[ElementGroup] customTrigger dropdown missing topButton; alignment may be wrong")
    }
    return dropdown.triggerButtonSize
  }

  /**
   * The cell size reserved for an item. Locked axis comes from the group
   * (vertical → this._width, horizontal → this._height); free axis from the
   * item. The free-axis source falls back through:
   *   FlexItem override → handler-resolved preferred → dropdown trigger size
   * so non-VisualElement content (Text, Image, Frame, custom widget) gets a
   * natural cell, and Dropdown-only cells fall back to the trigger button.
   */
  private computeCellSize(flexItem: FlexItem, meta: CellMeta): vec2 {
    const intrinsic = flexItem.measureIntrinsic().preferred
    // Honor the override pin even when it's explicit zero — that's the whole
    // point of `hasOverrideWidth`/`Height`. The dropdown branch below still
    // backstops legitimately-empty cells (no override set, no intrinsic) by
    // falling back to the trigger button size.
    let itemW = flexItem.hasOverrideWidth ? flexItem.overrideWidth : intrinsic.width
    let itemH = flexItem.hasOverrideHeight ? flexItem.overrideHeight : intrinsic.height

    // Dropdown fallback: when the SceneObject has no recognized visual sibling
    // AND no override pin, intrinsic is 0/0 — use the Dropdown's
    // triggerButtonSize instead. Explicit-zero pins are NOT overridden here;
    // a caller that pins to zero gets zero.
    if (meta.dropdown) {
      if (itemW <= 0 && !flexItem.hasOverrideWidth) itemW = meta.dropdown.triggerButtonSize.x
      if (itemH <= 0 && !flexItem.hasOverrideHeight) itemH = meta.dropdown.triggerButtonSize.y
    }

    const targetWidth = this.isVertical ? this._width : itemW
    const targetHeight = this.isVertical ? itemH : this._height
    return new vec2(targetWidth, targetHeight)
  }

  /**
   * Layout for a dropdown when `stretchToFill` is off. The cell stays group-locked,
   * but the trigger keeps its natural (configured) size with alignment margins, and
   * the dropdown's own `overrideWidth`/`width` are left alone — the user controls the
   * drawer width via the Dropdown component directly.
   * `marginTop`/`marginBottom` are reserved for drawer expansion in vertical groups.
   * Returns the trigger size so the caller can apply it via `resizeTriggerButton`.
   */
  private applyDropdownOptOutLayout(flexItem: FlexItem, dropdown: Dropdown, meta: CellMeta): vec2 {
    const cell = this.computeCellSize(flexItem, meta)
    const triggerSize = this.getEffectiveTriggerSize(dropdown)
    const gapW = Math.max(0, cell.x - triggerSize.x)
    const gapH = Math.max(0, cell.y - triggerSize.y)

    // Guard 0 (see addItem): a trigger size of 0 before the dropdown measures
    // would otherwise pin the cell to 0 and collapse it.
    if (triggerSize.x > 0) flexItem.overrideWidth = triggerSize.x
    if (triggerSize.y > 0) flexItem.overrideHeight = triggerSize.y
    flexItem.alignSelf = alignmentToFlexAlignSelf(meta.alignment)

    const align = meta.alignment
    if (align === "Center") {
      flexItem.marginLeft = gapW / 2
      flexItem.marginRight = gapW / 2
    } else if (align === "Right") {
      flexItem.marginLeft = gapW
      flexItem.marginRight = 0
    } else {
      flexItem.marginLeft = 0
      flexItem.marginRight = gapW
    }

    if (!this.isVertical) {
      flexItem.marginTop = gapH / 2
      flexItem.marginBottom = gapH / 2
    } else {
      flexItem.marginTop = 0
      flexItem.marginBottom = 0
    }

    return triggerSize
  }

  /**
   * Sets each dropdown's `drawerBackgroundExtension` so its native drawer bg bridges
   * visually into the neighbouring trigger row in vertical mode. Extension is on the
   * far side from the trigger: above for `expandUp`, below otherwise. In horizontal
   * mode there's no segmented bg to bridge into, so the extension is 0.
   */
  private updateDropdownBridges(): void {
    for (let i = 0; i < this.items.length; i++) {
      const dropdown = this.cellMeta.get(this.items[i])?.dropdown ?? null
      if (!dropdown) continue
      if (!this.isVertical) {
        dropdown.drawerBackgroundExtension = 0
        continue
      }
      const hasNeighborOnFarSide = dropdown.expandUp ? i > 0 : i < this.items.length - 1
      dropdown.drawerBackgroundExtension = hasNeighborOnFarSide ? DRAWER_BRIDGE_EXTENSION : 0
    }
  }

  private configureDropdown(dropdown: Dropdown, flexItem: FlexItem, meta: CellMeta): void {
    dropdown.hasTriggerBackground = true
    dropdown.triggerPadding = new vec2(0, 0)
    dropdown.showTriggerBackground = false
    dropdown.parentHandlesAnchor = true

    if (meta.stretchToFill) {
      // ElementGroup owns the trigger width: trigger fills the cell. The drawer
      // matches the group column width unless the user already enabled
      // `dropdown.overrideWidth` — in that case their custom width wins.
      const cell = this.computeCellSize(flexItem, meta)
      dropdown.triggerButtonSize = cell
      if (this.isVertical && !dropdown.overrideWidth) {
        dropdown.overrideWidth = true
        dropdown.configureWidth(this._width)
      }
    }
    // stretchToFill === false: opt out — leave dropdown.triggerButtonSize,
    // dropdown.overrideWidth, and dropdown.width untouched so the user's settings win.
  }

  private addItemInternal(flexItem: FlexItem, meta: CellMeta): void {
    const obj = flexItem.sceneObject
    obj.setParent(this.layoutObject)

    if (meta.stretchToFill) {
      // Pin ONLY the locked axis (the one the group enforces via
      // `group._width` / `group._height`). The free axis is left to the
      // FlexItem's handler-resolved intrinsic — pinning it here would
      // freeze it at whatever value `measureIntrinsic()` returns RIGHT NOW.
      //
      // When `addItemInternal` runs from `ElementGroup.OnStart` →
      // `discoverItems`, the child's own OnStartEvent has NOT yet fired,
      // so `flexItem._handler` is null and `measureIntrinsic` returns
      // `{0, 0}`. Pinning the free axis to 0 made all scene-discovered
      // items collapse to zero on the free axis (invisible RoundedRectangles,
      // 0-tall Buttons, etc.). By only pinning the locked axis, the free
      // axis falls through to the handler at LateUpdate (when OnStarts
      // have completed and the handler is resolved).
      if (this.isVertical) {
        if (this._width > 0) flexItem.overrideWidth = this._width
      } else {
        if (this._height > 0) flexItem.overrideHeight = this._height
      }
    } else {
      this.applyNonStretchCellLayout(flexItem, meta)
    }

    this.flexLayout.addItems([flexItem])
    this.items.push(flexItem)
    this.onItemAddedEvent.invoke(flexItem)
  }

  /**
   * ElementGroup's local version of the non-stretch layout. Sources the
   * cell metadata from {@link CellMeta} and the VisualElement (if any) from
   * the FlexItem's own subtree. The base-class
   * `FlexContainer.applyNonStretchLayout` is still used by `Dropdown` and
   * any other subclass that has its own wrapper item type.
   */
  private applyNonStretchCellLayout(flexItem: FlexItem, meta: CellMeta): void {
    const intrinsic = flexItem.measureIntrinsic().preferred
    const opt = {width: flexItem.overrideWidth, height: flexItem.overrideHeight}
    const cellW = opt.width > 0 ? opt.width : intrinsic.width
    const cellH = opt.height > 0 ? opt.height : intrinsic.height

    const el = findVisualElementInSubtree(flexItem.sceneObject)
    const elW = el ? el.width : cellW
    const elH = el ? el.height : cellH
    const gapW = Math.max(0, cellW - elW)
    const gapH = Math.max(0, cellH - elH)

    // Guard 0 (see addItem): a 0 here would pin the cell to 0 and collapse it.
    if (elW > 0) flexItem.overrideWidth = elW
    if (elH > 0) flexItem.overrideHeight = elH
    flexItem.alignSelf = alignmentToFlexAlignSelf(meta.alignment)

    const align = meta.alignment
    if (align === "Center") {
      flexItem.marginLeft = gapW / 2
      flexItem.marginRight = gapW / 2
    } else if (align === "Right") {
      flexItem.marginLeft = gapW
      flexItem.marginRight = 0
    } else {
      flexItem.marginLeft = 0
      flexItem.marginRight = gapW
    }
    flexItem.marginTop = gapH / 2
    flexItem.marginBottom = gapH / 2
  }

  // --- Dropdown Expansion ---

  private wireDropdownExpansion(dropdown: Dropdown, flexItem: FlexItem): void {
    const index = this.items.indexOf(flexItem)
    if (index === -1) return

    // The make-room margin is contributed INTO the dropdown's own "expand"
    // timeline as a growth channel, so the drawer and the room it opens ride
    // one clock and cannot drift. onExpandedChanged fires before the drawer
    // animates, so refreshing the contribution here is early enough for the
    // timeline to pick up a changed expandedHeight or direction.
    const unsub = dropdown.onExpandedChanged.add(() => {
      if (this.isVertical) {
        // Refresh bridges in case `expandUp` changed since add.
        this.updateDropdownBridges()
        this.refreshDropdownGrowth(dropdown)
      }
    })

    this.dropdownStates.set(dropdown, {unsub, flexItem})
    if (this.isVertical) this.refreshDropdownGrowth(dropdown)
  }

  /**
   * (Re)contributes this group's make-room margin channel to the dropdown's
   * expand timeline. The margin write is a layout INPUT — every animated frame
   * re-runs the flex layout, exactly as the previous hand-rolled tween did.
   */
  private refreshDropdownGrowth(dropdown: Dropdown): void {
    const state = this.dropdownStates.get(dropdown)
    if (state === undefined) return
    const up = dropdown.expandUp
    const flexItem = state.flexItem
    let channel = up ? state.marginChannelUp : state.marginChannelDown
    if (channel === undefined) {
      channel = MotionChannels.custom<number>(up ? "elementGroup.marginTop" : "elementGroup.marginBottom", () => ({
        read: () => (up ? flexItem.marginTop : flexItem.marginBottom),
        write: (value: number) => {
          if (up) {
            flexItem.marginTop = value
          } else {
            flexItem.marginBottom = value
          }
          this.updateAnchorOffset()
          this.updateBackground()
        }
      }))
      if (up) state.marginChannelUp = channel
      else state.marginChannelDown = channel
    }
    dropdown.setExternalGrowth([{target: flexItem, channel, from: 0, to: dropdown.expandedHeight}])
  }

  /** True when item `i` is a Dropdown contributing drawer margin (expanded or mid-animation). */
  private isItemContributingMargin(i: number): boolean {
    const flexItem = this.items[i]
    if (!this.cellMeta.get(flexItem)?.dropdown) return false
    return flexItem.marginTop > 0 || flexItem.marginBottom > 0
  }

  private hasAnyContributingDropdown(): boolean {
    for (let i = 0; i < this.items.length; i++) {
      if (this.isItemContributingMargin(i)) return true
    }
    return false
  }

  // --- Anchor Offset ---

  private computeAnchorOffset(): number {
    let offset = 0
    for (let i = 0; i < this.items.length; i++) {
      if (!this.isItemContributingMargin(i)) continue
      const flexItem = this.items[i]
      const dropdown = this.cellMeta.get(flexItem)!.dropdown!
      const margin = flexItem.marginTop + flexItem.marginBottom
      const anchor = dropdown.expandAnchor
      if (anchor === "Top") offset -= margin / 2
      else if (anchor === "Bottom") offset += margin / 2
    }
    return offset
  }

  private updateAnchorOffset(): void {
    this.anchorOffset = this.computeAnchorOffset()
    if (Math.abs(this.lastAppliedAnchorOffset - this.anchorOffset) < BG_WRITE_EPSILON) return
    this.lastAppliedAnchorOffset = this.anchorOffset
    this.anchorPosScratch.y = this.anchorOffset
    this.layoutObject.getTransform().setLocalPosition(this.anchorPosScratch)
  }

  // --- Background ---

  private updateBackground(): void {
    if (!this.flexContainerLayoutReady || !this._backgroundEnabled || !this.lastLayoutResult) return
    const result = this.lastLayoutResult
    // Skip if layout is stale (item added/removed but engine hasn't caught up).
    // onFlexLayoutComplete will re-invoke updateBackground() once synced,
    // preventing computeSegments from mispairing this.items[i] with result.items[i].
    if (result.items.length !== this.items.length) return
    if (result.items.length === 0) {
      this.ensureBgSegmentCount(0, this.cornerRadius, false)
      return
    }

    const contentWidth = this.isVertical ? this._width : result.containerWidth
    const contentHeight = this.isVertical ? result.containerHeight : this._height

    if (!this.isVertical || !this.hasAnyContributingDropdown()) {
      this.ensureBgSegmentCount(1, this.cornerRadius, this._backgroundEnabled)
      const bgWidth = contentWidth + this._padding.x * 2
      const bgHeight = contentHeight + this._padding.y * 2
      this.bgSegments[0].rect.backgroundColor = UIlevel0
      this.writeSegmentBg(0, bgWidth, bgHeight, this.anchorOffset)
      this.emitSizeChanged(bgWidth, bgHeight)
      return
    }

    const segmentCount = this.computeSegments(result, this.scratchSegments)
    this.ensureBgSegmentCount(segmentCount, this.cornerRadius, this._backgroundEnabled)

    const halfContainer = result.containerHeight / 2
    const bgWidth = contentWidth + this._padding.x * 2

    // Trigger-area segments only — drawer areas are filled by each Dropdown's
    // own native drawer background, extended via `drawerBackgroundExtension`
    // (set in `addItem`/`updateDropdownBridges`).
    for (let i = 0; i < segmentCount; i++) {
      const seg = this.scratchSegments[i]
      const segHeight = seg.height + this._padding.y * 2
      const segCenterY = halfContainer - seg.top - seg.height / 2
      this.bgSegments[i].rect.backgroundColor = UIlevel0
      this.writeSegmentBg(i, bgWidth, segHeight, segCenterY + this.anchorOffset)
    }

    this.emitSizeChanged(bgWidth, result.containerHeight + this._padding.y * 2)
  }

  /**
   * Writes size and position to a bg segment, skipping each individual write
   * when the new value is within epsilon of the last applied. Cache values
   * start as NaN so the first write always goes through (NaN comparisons
   * return false, which inverts to "trigger write").
   */
  private writeSegmentBg(index: number, w: number, h: number, cy: number): void {
    while (this.bgWriteCache.length <= index) {
      this.bgWriteCache.push({w: NaN, h: NaN, cy: NaN})
    }
    const cache = this.bgWriteCache[index]
    const seg = this.bgSegments[index]
    if (!(Math.abs(cache.w - w) < BG_WRITE_EPSILON && Math.abs(cache.h - h) < BG_WRITE_EPSILON)) {
      seg.rect.size = new vec2(w, h)
      cache.w = w
      cache.h = h
    }
    if (!(Math.abs(cache.cy - cy) < BG_WRITE_EPSILON)) {
      seg.object.getTransform().setLocalPosition(new vec3(0, cy, BG_Z_OFFSET))
      cache.cy = cy
    }
  }

  /** Invoke onSizeChangedEvent only when the emitted size actually changed. */
  private emitSizeChanged(w: number, h: number): void {
    const last = this.lastEmittedSize
    if (last && Math.abs(last.x - w) < 0.001 && Math.abs(last.y - h) < 0.001) return
    const size = new vec2(w, h)
    this.lastEmittedSize = size
    this.onSizeChangedEvent.invoke(size)
  }

  /**
   * Computes the trigger-area segments — the parts of the column NOT covered by an
   * expanded drawer. Drawer areas are filled by each Dropdown's own native drawer
   * background (extended via `dropdown.drawerBackgroundExtension` in `addItem`).
   *
   * Fills `out` in place (reusing existing SegmentInfo entries; allocating only
   * when growing past max-seen) and returns the segment count.
   */
  private computeSegments(result: FlexLayoutResult, out: SegmentInfo[]): number {
    let count = 0
    if (result.items.length === 0) return count

    let segStartY = result.items[0].y

    for (let i = 0; i < this.items.length; i++) {
      const itemResult = result.items[i]
      if (!itemResult) continue

      if (this.isItemContributingMargin(i)) {
        const flexItem = this.items[i]
        const dropdown = this.cellMeta.get(flexItem)!.dropdown!
        const up = dropdown.expandUp

        if (up) {
          const drawerHeight = flexItem.marginTop
          const drawerTop = itemResult.y - drawerHeight

          const gapAbove = i > 0 ? this._spacing : 0
          const itemGroupEnd = drawerTop - gapAbove
          if (itemGroupEnd - segStartY >= MIN_SEGMENT_HEIGHT) {
            count = this.writeScratchSegment(out, count, segStartY, itemGroupEnd - segStartY)
          }

          segStartY = itemResult.y
        } else {
          const segEndY = itemResult.y + itemResult.height
          if (segEndY - segStartY >= MIN_SEGMENT_HEIGHT) {
            count = this.writeScratchSegment(out, count, segStartY, segEndY - segStartY)
          }

          const drawerHeight = flexItem.marginBottom
          segStartY = segEndY + drawerHeight
          if (i < this.items.length - 1) {
            segStartY += this._spacing
          }
        }
      }
    }

    const lastItem = result.items[result.items.length - 1]
    const segEndY = lastItem.y + lastItem.height
    if (segEndY - segStartY >= MIN_SEGMENT_HEIGHT) {
      count = this.writeScratchSegment(out, count, segStartY, segEndY - segStartY)
    }

    return count
  }

  private writeScratchSegment(out: SegmentInfo[], index: number, top: number, height: number): number {
    if (index >= out.length) {
      out.push({top, height})
    } else {
      out[index].top = top
      out[index].height = height
    }
    return index + 1
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Maps the inspector `alignment` string to a {@link FlexAlignSelf} enum. */
function alignmentToFlexAlignSelf(alignment: string): FlexAlignSelf {
  switch (alignment) {
    case "Center":
      return FlexAlignSelf.Center
    case "Right":
      return FlexAlignSelf.End
    case "Left":
    default:
      return FlexAlignSelf.Start
  }
}

/** Walks `root` and its descendants for a Dropdown component, returning the first hit. */
function findDropdownInSubtree(root: SceneObject): Dropdown | null {
  const components = root.getComponents("ScriptComponent")
  for (let i = 0; i < components.length; i++) {
    if (components[i] instanceof Dropdown) return components[i] as Dropdown
  }
  for (let i = 0; i < root.getChildrenCount(); i++) {
    const found = findDropdownInSubtree(root.getChild(i))
    if (found) return found
  }
  return null
}

/** Walks `root` and its descendants for a VisualElement component, returning the first hit. */
function findVisualElementInSubtree(root: SceneObject): VisualElement | null {
  const components = root.getComponents("ScriptComponent")
  for (let i = 0; i < components.length; i++) {
    if (components[i] instanceof VisualElement) return components[i] as VisualElement
  }
  for (let i = 0; i < root.getChildrenCount(); i++) {
    const found = findVisualElementInSubtree(root.getChild(i))
    if (found) return found
  }
  return null
}

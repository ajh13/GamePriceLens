// ═══════════════════════════════════════════════════════════════════════════
// GridLayout.ts — Thin orchestrator component for CSS Grid layout.
//
// Attach to a container SceneObject. Discovers child GridItems, calls the
// pure Grid2D engine, and applies results back to children.
//
// Layout is batched: property changes mark dirty → LateUpdateEvent runs
// the layout pass once per frame.
// ═══════════════════════════════════════════════════════════════════════════

import Event from "InteractionKit.lspkg/Utils/Event"
import ReplayEvent from "InteractionKit.lspkg/Utils/ReplayEvent"
import {drawWorldBox} from "../../../Utility/DebugDraw"
import {LayoutItem2D, PresentationRequest} from "../LayoutItem2D"
import {LayoutPreparation, LayoutPresentation} from "../LayoutPresentation"
import {ContentHorizontalAlignment, ContentVerticalAlignment, FIT_CONTENT_RETRY_FRAMES} from "../LayoutTypes"
import {getFrameToken} from "../TextMeasurement"
import {UIKitBrands} from "../UIKitBrands"
import {computeGridLayout} from "./Grid2D"
import {GridItem} from "./GridItem"
import {GridAlign, GridAutoFlow, GridContainerInput, GridItemInput, GridLayoutResult} from "./GridTypes"

/**
 * CSS Grid layout container for the Layout2D system.
 *
 * Attach to a SceneObject and add {@link GridItem} components to its direct children.
 * The container discovers children automatically, runs the pure {@link computeGridLayout}
 * engine, and applies positions/sizes back to each child via its resolved handler.
 *
 * Supports explicit column/row templates, named areas, auto-flow placement,
 * fr/cm/auto/minmax track sizing, and per-item alignment overrides.
 *
 * Layout is batched: property changes call {@link markDirty} and the layout pass runs
 * once per frame in LateUpdate.
 */
@component
export class GridLayout extends BaseScriptComponent {
  /**
   * Type brand consumed by the Layout2D `LayoutContainerHandler` finder.
   * Shared with FlexLayout. See `Layout2D/UIKitBrands.ts`.
   */
  public readonly __uikitBrand = UIKitBrands.LayoutContainer

  // ─── Container Size ──────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Container Size</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Dimensions of the grid container in local space</span>')
  @input
  @label("Width")
  @hint("Container width in cm. -1 = auto (shrink-to-fit content).")
  private _width: number = 20

  @input
  @label("Height")
  @hint("Container height in cm. -1 = auto (shrink-to-fit content).")
  private _height: number = 20

  // ─── Template ────────────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Template</span>')
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Track definitions, auto sizing, and named grid areas</span>'
  )
  @input
  @label("Template Columns")
  @hint("Column track definitions. E.g. '1fr 1fr', '3cm 1fr 2fr auto', 'repeat(3, 1fr)'")
  private _templateColumns: string = "1fr 1fr"

  @input
  @label("Template Rows")
  @hint("Row track definitions. E.g. '1fr', '2cm auto 1fr', 'repeat(2, 1fr)'")
  private _templateRows: string = "1fr"

  @input
  @label("Auto Rows")
  @hint("Sizing for implicitly created row tracks. E.g. '1fr', 'auto', '2cm'")
  private _autoRows: string = "1fr"

  @input
  @label("Auto Columns")
  @hint("Sizing for implicitly created column tracks. E.g. '1fr', 'auto', '2cm'")
  private _autoColumns: string = "1fr"

  @input
  @label("Template Areas")
  @widget(new TextAreaWidget())
  @hint("Named grid areas. Rows separated by '/'. E.g. 'header header / sidebar content / footer footer'")
  private _templateAreas: string = ""

  // ─── Flow ────────────────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Auto Flow</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">How auto-placed items fill empty grid cells</span>')
  @input
  @label("Auto Flow")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Row", "row"),
      new ComboBoxItem("Column", "column"),
      new ComboBoxItem("Row Dense", "rowDense"),
      new ComboBoxItem("Column Dense", "columnDense")
    ])
  )
  @hint("How auto-placed items fill the grid.")
  private _autoFlow: string = "row"

  // ─── Gap ─────────────────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Gap</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Spacing between rows and columns</span>')
  @input
  @label("Column Gap")
  @hint("Gap between columns in cm.")
  private _columnGap: number = 0

  @input
  @label("Row Gap")
  @hint("Gap between rows in cm.")
  private _rowGap: number = 0

  // ─── Padding ─────────────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Padding</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Inner spacing between container edges and content</span>')
  @input
  @label("Top")
  @hint("Top padding in cm.")
  private _paddingTop: number = 0

  @input
  @label("Right")
  @hint("Right padding in cm.")
  private _paddingRight: number = 0

  @input
  @label("Bottom")
  @hint("Bottom padding in cm.")
  private _paddingBottom: number = 0

  @input
  @label("Left")
  @hint("Left padding in cm.")
  private _paddingLeft: number = 0

  // ─── Alignment ───────────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Alignment</span>')
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Default alignment for all items within their grid cells</span>'
  )
  @input
  @label("Justify Items")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Start", "start"),
      new ComboBoxItem("Center", "center"),
      new ComboBoxItem("End", "end"),
      new ComboBoxItem("Stretch", "stretch")
    ])
  )
  @hint("Default horizontal alignment for all items in their cells.")
  private _justifyItems: string = "stretch"

  @input
  @label("Align Items")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Start", "start"),
      new ComboBoxItem("Center", "center"),
      new ComboBoxItem("End", "end"),
      new ComboBoxItem("Stretch", "stretch")
    ])
  )
  @hint("Default vertical alignment for all items in their cells.")
  private _alignItems: string = "stretch"

  // ─── Content Alignment ──────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Content Alignment</span>')
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Position of the grid content relative to the SceneObject center</span>'
  )
  @input
  @label("Horizontal")
  @hint("Horizontal alignment of the grid content relative to the SceneObject center.")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Left", "left"),
      new ComboBoxItem("Center", "center"),
      new ComboBoxItem("Right", "right")
    ])
  )
  private _horizontalAlignment: string = "center"

  @input
  @label("Vertical")
  @hint("Vertical alignment of the grid content relative to the SceneObject center.")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Top", "top"),
      new ComboBoxItem("Center", "center"),
      new ComboBoxItem("Bottom", "bottom")
    ])
  )
  private _verticalAlignment: string = "center"

  // ─── Debug ───────────────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Debug</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Visual debugging tools for layout inspection</span>')
  @input
  @label("Debug Visualization")
  @hint("Enable debug visualization (container and item bounds).")
  private _debug: boolean = false

  // ─── Internal State ──────────────────────────────────────────────────

  private _items: GridItem[] = []
  private _dirty: boolean = true
  private _isPerformingLayout: boolean = false
  private _initialized: boolean = false

  // Content-size memo, keyed by a markDirty-bumped generation: computeContentSize
  // is a pure function of config + children's intrinsics (both change only via
  // markDirty), so cache per mode and skip the engine on repeat same-gen calls.
  private _measureGen: number = 0
  private _contentSizeCache: {
    gen: number
    sizes: Partial<Record<string, {width: number; height: number}>>
  } = {gen: -1, sizes: {}}
  private _computedWidth: number = 0
  private _computedHeight: number = 0
  // Charge pending work once per host frame. Only external markDirty() resets the budget.
  private _fitContentPending: boolean = false
  private _notifyingLayout: boolean = false
  public readonly presentation = new LayoutPresentation(
    () => this._siblingGridItem?.parentLayout?.presentation ?? null,
    () => this._isPerformingLayout || this._notifyingLayout,
    () => {
      if (this._dirty) this.performLayout()
    },
    () => this.requestContinuation(),
    () => this.prepareLayout()
  )
  // Status of the most recent content-size PROBE (computeContentSize /
  // computeContentHeightForWidth), kept apart from the layout pass's flag: a
  // cache hit for one width must not inherit the pending status of an earlier
  // probe at another width.
  private _probePending: boolean = false
  private _fitContentExhausted: boolean = false
  private _pendingFrames: number = 0
  private _lastPendingFrame: number = -1

  /** Cached sibling GridItem (for dirty propagation to parent layout) */
  private _siblingGridItem: LayoutItem2D | null = null

  /** Pre-allocated input buffer — avoids per-pass allocations in performLayout(). */
  private _inputBuffer: GridItemInput[] = []

  /** Engine memoization — skip computeGridLayout when inputs are unchanged. */
  private _lastResult: GridLayoutResult | null = null
  private _lastInputSnapshot: GridItemInput[] = []
  private _lastContainerSnapshot: GridContainerInput | null = null

  private lateUpdateEvent: SceneEvent
  private debugUpdateEvent: SceneEvent

  // ─── Events ──────────────────────────────────────────────────────────

  private readonly onInitializedEvent = new ReplayEvent<void>()
  /** Fires once after the first child discovery and layout pass. Replays for late subscribers. */
  public readonly onInitialized = this.onInitializedEvent.publicApi()

  private readonly onLayoutCompleteEvent = new Event<GridLayoutResult>()
  /** Fires after every layout pass with the full {@link GridLayoutResult}. */
  public readonly onLayoutComplete = this.onLayoutCompleteEvent.publicApi()

  // ─── Public Getters / Setters ────────────────────────────────────────

  /** Container width in cm. Set to -1 for auto (shrink-to-fit content). */
  public get width(): number {
    return this._width
  }
  public set width(value: number) {
    if (this._width === value) return
    this._width = value
    this.markDirty()
  }

  /** Container height in cm. Set to -1 for auto (shrink-to-fit content). */
  public get height(): number {
    return this._height
  }
  public set height(value: number) {
    if (this._height === value) return
    this._height = value
    this.markDirty()
  }

  /**
   * Column track definitions as a string.
   * Supports `Ncm`, `Nfr`, `auto`, `minmax(min, max)`, and `repeat(N, pattern)`.
   * @example "1fr 1fr" // two equal columns
   * @example "3cm 1fr 2fr auto" // mixed fixed, fractional, and auto
   * @example "repeat(3, 1fr)" // three equal columns
   */
  public get templateColumns(): string {
    return this._templateColumns
  }
  public set templateColumns(value: string) {
    if (this._templateColumns === value) return
    this._templateColumns = value
    this.markDirty()
  }

  /**
   * Row track definitions as a string.
   * Same syntax as {@link templateColumns}.
   * @example "1fr" // single flexible row
   * @example "2cm auto 1fr" // mixed track types
   */
  public get templateRows(): string {
    return this._templateRows
  }
  public set templateRows(value: string) {
    if (this._templateRows === value) return
    this._templateRows = value
    this.markDirty()
  }

  /** Sizing for implicitly created row tracks (e.g. `"1fr"`, `"auto"`, `"2cm"`). */
  public get autoRows(): string {
    return this._autoRows
  }
  public set autoRows(value: string) {
    if (this._autoRows === value) return
    this._autoRows = value
    this.markDirty()
  }

  /** Sizing for implicitly created column tracks (e.g. `"1fr"`, `"auto"`, `"2cm"`). */
  public get autoColumns(): string {
    return this._autoColumns
  }
  public set autoColumns(value: string) {
    if (this._autoColumns === value) return
    this._autoColumns = value
    this.markDirty()
  }

  /**
   * Named grid areas. Rows separated by `"/"`, columns by spaces within each row.
   * Use `"."` for empty cells.
   * @example "header header / sidebar content / footer footer"
   */
  public get templateAreas(): string {
    return this._templateAreas
  }
  public set templateAreas(value: string) {
    if (this._templateAreas === value) return
    this._templateAreas = value
    this.markDirty()
  }

  /** How auto-placed items fill the grid (row, column, or dense variants). */
  public get autoFlow(): GridAutoFlow {
    return this._autoFlow as GridAutoFlow
  }
  public set autoFlow(value: GridAutoFlow) {
    if (this._autoFlow === value) return
    this._autoFlow = value
    this.markDirty()
  }

  /** Gap between columns in cm. */
  public get columnGap(): number {
    return this._columnGap
  }
  public set columnGap(value: number) {
    if (this._columnGap === value) return
    this._columnGap = Math.max(0, value)
    this.markDirty()
  }

  /** Gap between rows in cm. */
  public get rowGap(): number {
    return this._rowGap
  }
  public set rowGap(value: number) {
    if (this._rowGap === value) return
    this._rowGap = Math.max(0, value)
    this.markDirty()
  }

  /** Sets both columnGap and rowGap to the same value (in cm). */
  public set gap(value: number) {
    this._columnGap = Math.max(0, value)
    this._rowGap = Math.max(0, value)
    this.markDirty()
  }

  /** Top padding in cm. */
  public get paddingTop(): number {
    return this._paddingTop
  }
  public set paddingTop(value: number) {
    if (this._paddingTop === value) return
    this._paddingTop = value
    this.markDirty()
  }

  /** Right padding in cm. */
  public get paddingRight(): number {
    return this._paddingRight
  }
  public set paddingRight(value: number) {
    if (this._paddingRight === value) return
    this._paddingRight = value
    this.markDirty()
  }

  /** Bottom padding in cm. */
  public get paddingBottom(): number {
    return this._paddingBottom
  }
  public set paddingBottom(value: number) {
    if (this._paddingBottom === value) return
    this._paddingBottom = value
    this.markDirty()
  }

  /** Left padding in cm. */
  public get paddingLeft(): number {
    return this._paddingLeft
  }
  public set paddingLeft(value: number) {
    if (this._paddingLeft === value) return
    this._paddingLeft = value
    this.markDirty()
  }

  /** Default horizontal alignment for all items in their grid cells. */
  public get justifyItems(): GridAlign {
    return this._justifyItems as GridAlign
  }
  public set justifyItems(value: GridAlign) {
    if (this._justifyItems === value) return
    this._justifyItems = value
    this.markDirty()
  }

  /** Default vertical alignment for all items in their grid cells. */
  public get alignItems(): GridAlign {
    return this._alignItems as GridAlign
  }
  public set alignItems(value: GridAlign) {
    if (this._alignItems === value) return
    this._alignItems = value
    this.markDirty()
  }

  /** Horizontal alignment of the grid content relative to the SceneObject center. */
  public get horizontalAlignment(): ContentHorizontalAlignment {
    return this._horizontalAlignment as ContentHorizontalAlignment
  }
  public set horizontalAlignment(value: ContentHorizontalAlignment) {
    if (this._horizontalAlignment === value) return
    this._horizontalAlignment = value
    this.markDirty()
  }

  /** Vertical alignment of the grid content relative to the SceneObject center. */
  public get verticalAlignment(): ContentVerticalAlignment {
    return this._verticalAlignment as ContentVerticalAlignment
  }
  public set verticalAlignment(value: ContentVerticalAlignment) {
    if (this._verticalAlignment === value) return
    this._verticalAlignment = value
    this.markDirty()
  }

  /** Enables debug visualization (container and item bounds drawn each frame). */
  public get debug(): boolean {
    return this._debug
  }
  public set debug(value: boolean) {
    if (this._debug === value) return
    this._debug = value
    if (this.debugUpdateEvent) {
      this.debugUpdateEvent.enabled = value
    }
  }

  /** Number of discovered GridItem children currently managed by this layout. */
  public get itemCount(): number {
    return this._items.length
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  public onAwake(): void {
    // LateUpdate for deferred layout — starts disabled
    this.lateUpdateEvent = this.createEvent("LateUpdateEvent")
    this.lateUpdateEvent.enabled = false
    this.lateUpdateEvent.bind(() => {
      // Consume this dispatch BEFORE laying out. Anything the pass schedules —
      // a pending fit-content probe requesting another frame, or an
      // onLayoutComplete listener calling markDirty() — re-enables the event
      // and must survive; disabling afterwards used to drop those requests.
      this.lateUpdateEvent.enabled = false
      if (this._dirty) {
        this.performLayout()
      }
    })

    // UpdateEvent for settle-frame child detection and re-layout.
    // After settle, rely on addItems()/removeItems() for mutations —
    // Debug visualization event — starts disabled
    this.debugUpdateEvent = this.createEvent("UpdateEvent")
    this.debugUpdateEvent.enabled = this._debug
    this.debugUpdateEvent.bind(() => {
      this.renderDebug()
    })

    this.createEvent("OnDestroyEvent").bind(() => {
      this.presentation.dispose()
      for (const item of this._items) {
        if (!isNull(item) && item.parentLayout === this) item.setParentLayout(null)
      }
    })

    // OnStart: discover children and run first layout
    this.createEvent("OnStartEvent").bind(() => {
      // Cache sibling GridItem for dirty propagation to parent layout.
      // `instanceof GridItem` so a GridItem subclass (composite widget)
      // on the wrapping SceneObject is still picked up.
      const scripts = this.sceneObject.getComponents("ScriptComponent")
      for (const c of scripts) {
        // Any Layout2D item type: this container may be nested inside the
        // OTHER container kind (a FlexLayout inside a GridLayout is wrapped by
        // a GridItem), and its parent still needs the dirty bubble.
        if (c instanceof LayoutItem2D) {
          this._siblingGridItem = c
          break
        }
      }

      this.discoverChildren()
      this._initialized = true
      this.onInitializedEvent.invoke()
      this.markDirty()
    })
  }

  // ─── Public Methods ──────────────────────────────────────────────────

  /**
   * Marks the layout as dirty so it will be recalculated on the next LateUpdate.
   * Automatically bubbles upward when this layout is nested inside another layout.
   * No-op if a layout pass is currently in progress.
   */
  public markDirty(): void {
    if (this._isPerformingLayout) return
    this._dirty = true
    // New external state: the memoized engine result and the nested
    // content-size caches are no longer known to be valid (a stable
    // heightForWidth callback can change its answer with every compared input
    // equal), and pending fit-content work starts a fresh retry budget.
    this._measureGen++
    this._lastResult = null
    this._fitContentExhausted = false
    this._pendingFrames = 0
    this._lastPendingFrame = -1
    if (this.lateUpdateEvent) {
      this.lateUpdateEvent.enabled = true
    }
    // Bubble dirty upward: if this layout is nested inside another layout,
    // notify the parent via the sibling GridItem on the same SceneObject.
    if (this._siblingGridItem) {
      this._siblingGridItem["_parentLayout"]?.markDirty()
    }
  }

  /**
   * Schedules another pass for the SAME measurement generation: a fit-content
   * probe was rate-limited and wants the next frame. Unlike {@link markDirty}
   * this does not advance the generation, drop caches, reset the retry budget,
   * or notify the parent — the parent learns about it through its own probe of
   * this container returning pending.
   */
  private requestContinuation(): void {
    this._dirty = true
    if (this.lateUpdateEvent) {
      this.lateUpdateEvent.enabled = true
    }
  }

  /** Commits the label and settles all participating owners in one bounded transaction. */
  public presentSynchronously(request: PresentationRequest): "completed" | "queued" {
    return this.presentation.present(request)
  }

  /**
   * Immediately runs the layout pass synchronously, bypassing the LateUpdate batch.
   * Useful when you need layout results within the same frame.
   */
  public forceLayout(): void {
    if (this._isPerformingLayout) return
    this._dirty = true
    this.performLayout()
  }

  /**
   * Compute the intrinsic size of this grid container.
   *
   * `mode` selects which content axis drives sizing:
   * - `"preferred"` (default) — natural / max-content size to fit children
   * - `"min"` — shrink-fit minimum from each child's `min` content size
   * - `"max"` — grow-fit maximum from each child's `max` content size
   *
   * Used by LayoutContainerHandler so nested grids can report all three
   * intrinsic axes to a parent layout's CSS intrinsic-sizing pass.
   */
  public computeContentSize(opts?: {mode?: "preferred" | "min" | "max"}): {width: number; height: number} {
    const mode = opts?.mode ?? "preferred"
    if (LayoutPreparation.current) {
      return LayoutPreparation.current.visit(this, () => this.computeContentSizeUncached(mode), {width: 0, height: 0})
    }
    if (this._contentSizeCache.gen !== this._measureGen) {
      this._contentSizeCache = {gen: this._measureGen, sizes: {}}
    }
    const cached = this._contentSizeCache.sizes[mode]
    if (cached) {
      this._probePending = false
      return cached
    }
    const result = this.computeContentSizeUncached(mode)
    // A probe whose items could not measure this frame is provisional: cache
    // it and the parent would keep reading stale intrinsics for the rest of
    // the generation (retries never advance the generation). Leave it uncached,
    // request this container's own next frame, and report pending.
    this.resolveFitContentState()
    this._probePending = this._fitContentPending
    if (this._probePending) {
      this.requestContinuation()
    } else {
      this._contentSizeCache.sizes[mode] = result
    }
    return result
  }

  /**
   * All three intrinsic modes in one call, sharing the per-mode memo — used by
   * LayoutContainerHandler so a nested grid reports min/preferred/max without
   * three separate engine runs.
   */
  public computeContentSizeAllModes(): {
    preferred: {width: number; height: number}
    min: {width: number; height: number}
    max: {width: number; height: number}
  } {
    const preferred = this.computeContentSize()
    const preferredPending = this._probePending
    const min = this.computeContentSize({mode: "min"})
    const minPending = this._probePending
    const max = this.computeContentSize({mode: "max"})
    // The caller reads one status for the triple: provisional if any probe was.
    if (!LayoutPreparation.current) this._probePending = this._probePending || preferredPending || minPending
    return {preferred, min, max}
  }

  /**
   * Fit-content height of this container when its width is pinned to `width`
   * cm and its height is auto — the nested-layout answer to
   * `ItemHandler.measureHeightForWidth`. Children's own `heightForWidth`
   * callbacks run inside, so wrapped text several layers down still drives
   * the outermost row. Memoized per width alongside the intrinsic modes.
   */
  public computeContentHeightForWidth(width: number): number {
    if (LayoutPreparation.current) {
      return LayoutPreparation.current.visit(
        this,
        () =>
          computeGridLayout(
            this.buildContentSizeInput(width),
            this._items.map((item, index) => item.toInput(index, "preferred"))
          ).containerHeight,
        0
      )
    }
    if (this._items.length === 0) return 0
    if (this._contentSizeCache.gen !== this._measureGen) {
      this._contentSizeCache = {gen: this._measureGen, sizes: {}}
    }
    const cacheKey = `w:${width}`
    const cached = this._contentSizeCache.sizes[cacheKey]
    if (cached) {
      this._probePending = false
      return cached.height
    }
    const containerInput = this.buildContentSizeInput(width)
    const itemInputs = this._items.map((item, i) => item.toInput(i, "preferred"))
    const result = computeGridLayout(containerInput, itemInputs)
    const size = {width: result.containerWidth, height: result.containerHeight}
    this.resolveFitContentState()
    this._probePending = this._fitContentPending
    if (this._probePending) {
      // The parent sees pending through LayoutContainerHandler; this container
      // also needs its own next frame so its budget advances and its own
      // items get another measurement opportunity.
      this.requestContinuation()
    } else {
      this._contentSizeCache.sizes[cacheKey] = size
    }
    return size.height
  }

  /**
   * Whether the most recent content-size probe (`computeContentSize` or
   * `computeContentHeightForWidth`) was provisional. Read by
   * LayoutContainerHandler right after the probe; a cache hit reports false
   * regardless of what an earlier probe at another width reported.
   */
  public get fitContentProbePending(): boolean {
    return LayoutPreparation.current?.pending ?? this._probePending
  }

  private computeContentSizeUncached(mode: "preferred" | "min" | "max"): {width: number; height: number} {
    if (this._items.length === 0) {
      return {width: 0, height: 0}
    }
    const containerInput = this.buildContentSizeInput(-1)
    const itemInputs = this._items.map((item, i) => item.toInput(i, mode))
    const result = computeGridLayout(containerInput, itemInputs)
    return {width: result.containerWidth, height: result.containerHeight}
  }

  /** Engine input for an intrinsic-size probe: auto height, `width` (or -1 = auto) wide. */
  private buildContentSizeInput(width: number): GridContainerInput {
    return {
      width,
      height: -1,
      templateColumns: this._templateColumns,
      templateRows: this._templateRows,
      templateAreas: this._templateAreas,
      autoRows: this._autoRows,
      autoColumns: this._autoColumns,
      autoFlow: this._autoFlow as GridAutoFlow,
      columnGap: this._columnGap,
      rowGap: this._rowGap,
      padding: {
        top: this._paddingTop,
        right: this._paddingRight,
        bottom: this._paddingBottom,
        left: this._paddingLeft
      },
      justifyItems: this._justifyItems as GridAlign,
      alignItems: this._alignItems as GridAlign
    }
  }

  /**
   * Programmatically adds GridItem children to this layout.
   * Duplicates are ignored. Triggers a layout recalculation.
   * @param items - GridItem components to add.
   */
  public addItems(items: GridItem[]): void {
    for (const item of items) {
      if (this._items.indexOf(item) === -1) {
        this._items.push(item)
        item.setParentLayout(this)
      }
    }
    this.markDirty()
  }

  /**
   * Programmatically removes GridItem children from this layout.
   * Items not currently managed are ignored. Triggers a layout recalculation.
   * @param items - GridItem components to remove.
   */
  public removeItems(items: GridItem[]): void {
    for (const item of items) {
      const idx = this._items.indexOf(item)
      if (idx !== -1) {
        this._items.splice(idx, 1)
        item.setParentLayout(null)
      }
    }
    this.markDirty()
  }

  /**
   * Sets explicit placement for a GridItem, disabling auto-placement.
   * Only provided fields are updated; others remain unchanged.
   * @param item - The GridItem to place.
   * @param placement - Placement options (row, col, rowSpan, colSpan). All fields are optional.
   */
  public setItemPlacement(
    item: GridItem,
    placement: {row?: number; col?: number; rowSpan?: number; colSpan?: number}
  ): void {
    item.autoPlacement = false
    if (placement.row !== undefined) item.gridRow = placement.row
    if (placement.col !== undefined) item.gridColumn = placement.col
    if (placement.rowSpan !== undefined) item.gridRowSpan = placement.rowSpan
    if (placement.colSpan !== undefined) item.gridColumnSpan = placement.colSpan
  }

  /**
   * Clears explicit placement for a GridItem, reverting it to auto-placement
   * with default span of 1x1 and no named area.
   * @param item - The GridItem to reset.
   */
  public clearItemPlacement(item: GridItem): void {
    item.autoPlacement = true
    item.gridRow = 0
    item.gridColumn = 0
    item.gridRowSpan = 1
    item.gridColumnSpan = 1
    item.gridArea = ""
  }

  // ─── Child Discovery ─────────────────────────────────────────────────

  private discoverChildren(): void {
    const parent = this.sceneObject
    const childCount = parent.getChildrenCount()

    // Unregister old items
    for (const item of this._items) {
      item.setParentLayout(null)
    }
    this._items = []

    // Scan for GridItem components on direct children. `instanceof GridItem`
    // (not `getComponent(GridItem.getTypeName())`) so we catch GridItem
    // subclasses too — composite widgets that extend GridItem are still
    // auto-discovered.
    for (let i = 0; i < childCount; i++) {
      const child = parent.getChild(i)
      if (!child.enabled) continue
      const scripts = child.getComponents("ScriptComponent")
      for (const c of scripts) {
        if (c instanceof GridItem) {
          this._items.push(c)
          c.setParentLayout(this)
          break
        }
      }
    }
  }

  // ─── Layout Pass ─────────────────────────────────────────────────────

  /** Measure this subtree at its proposed size without applying geometry or emitting events. */
  public prepareLayout(width = this._width, height = this._height): void {
    const preparation = LayoutPreparation.current
    if (!preparation) return
    preparation.visit(
      this,
      () => {
        preparation.owners.add(this.presentation)
        const input = {...this.buildContentSizeInput(width), height}
        const result = computeGridLayout(
          input,
          this._items.map((item, index) => item.toInput(index, "preferred"))
        )
        for (let i = 0; i < this._items.length; i++) {
          const output = result.items[i]
          if (output) this._items[i].prepareLayout(output.width, output.height)
        }
      },
      undefined
    )
  }

  private performLayout(): void {
    if (this._items.length === 0) {
      this._dirty = false
      this._fitContentPending = false
      this.presentation.drain()
      return
    }

    this._isPerformingLayout = true

    let result: GridLayoutResult
    try {
      // Build engine inputs
      const containerInput: GridContainerInput = {
        width: this._width,
        height: this._height,
        templateColumns: this._templateColumns,
        templateRows: this._templateRows,
        templateAreas: this._templateAreas,
        autoRows: this._autoRows,
        autoColumns: this._autoColumns,
        autoFlow: this._autoFlow as GridAutoFlow,
        columnGap: this._columnGap,
        rowGap: this._rowGap,
        padding: {
          top: this._paddingTop,
          right: this._paddingRight,
          bottom: this._paddingBottom,
          left: this._paddingLeft
        },
        justifyItems: this._justifyItems as GridAlign,
        alignItems: this._alignItems as GridAlign
      }

      // Fill pre-allocated input buffer (avoids N allocations per pass)
      while (this._inputBuffer.length < this._items.length) {
        this._inputBuffer.push({} as GridItemInput)
      }
      this._inputBuffer.length = this._items.length

      for (let i = 0; i < this._items.length; i++) {
        this._items[i].fillInput(this._inputBuffer[i], i)
      }

      // Run pure layout engine — or return cached result if inputs are unchanged
      if (this._lastResult && this.inputsMatch(containerInput)) {
        result = this._lastResult
        this._fitContentPending = false
      } else {
        result = computeGridLayout(containerInput, this._inputBuffer)
        this.resolveFitContentState()
        if (this._fitContentPending) {
          // A wrapped Text (or nested layout) could not measure this frame; the
          // result carries its authored height for that item. Don't memoize it —
          // the inputs would compare equal next frame and the stale answer would
          // stick. (On budget exhaustion `resolveFitContentState` clears pending
          // and the result IS memoized as the accepted fallback.)
          this._lastResult = null
        } else {
          this._lastResult = result
          this.snapshotInputs(containerInput)
        }
      }

      // Compute content alignment offsets
      // Engine outputs top-left positions; we convert to Lens Studio center-based coords.
      const hAlign = this._horizontalAlignment as ContentHorizontalAlignment
      const hOffset =
        hAlign === ContentHorizontalAlignment.Left
          ? 0
          : hAlign === ContentHorizontalAlignment.Right
            ? -result.containerWidth
            : -result.containerWidth * 0.5

      const vAlign = this._verticalAlignment as ContentVerticalAlignment
      const vOffset =
        vAlign === ContentVerticalAlignment.Top
          ? 0
          : vAlign === ContentVerticalAlignment.Bottom
            ? result.containerHeight
            : result.containerHeight * 0.5

      // Apply results
      for (let i = 0; i < this._items.length; i++) {
        const output = result.items[i]
        if (output) {
          // Convert from top-left origin to center-based coordinates
          // In Lens Studio, Y+ is up and objects are positioned by center.
          const centerX = output.x + output.width * 0.5 + hOffset
          const centerY = vOffset - (output.y + output.height * 0.5)

          this._items[i].applyLayout(centerX, centerY, output.width, output.height)
        }
      }

      this._computedWidth = result.containerWidth
      this._computedHeight = result.containerHeight
      this._dirty = false
    } finally {
      this._isPerformingLayout = false
    }

    // Continue next frame while a fit-content probe is outstanding and the
    // budget allows (the handlers cache what they did measure, so each retry
    // needs fewer host calls). Not markDirty(): this is the same generation.
    if (this._fitContentPending) this.requestContinuation()

    this._notifyingLayout = true
    try {
      this.onLayoutCompleteEvent.invoke(result)
    } finally {
      this._notifyingLayout = false
    }
    // Presentations that arrived during this pass (from listeners, or from a
    // component whose owner was busy) land now, still under isCurrent().
    this.presentation.drain()
  }

  /**
   * True while a fit-content probe used by the current result is outstanding
   * and this generation still has retry budget. False once the budget is
   * exhausted, so ancestors stop treating this container as retryable (see
   * {@link fitContentExhausted}).
   */
  public get fitContentPending(): boolean {
    return this._fitContentPending
  }

  /**
   * True when this generation gave up waiting: the memoized result carries the
   * intrinsic fallback for whichever probes never answered. Cleared by the next
   * external {@link markDirty}. Diagnostic; "accepted fallback" is not
   * "measured".
   */
  public get fitContentExhausted(): boolean {
    return this._fitContentExhausted
  }

  /**
   * After an engine run: aggregate the items' pending flags for the result just
   * produced, charge the retry budget once per distinct frame, and decide
   * whether the container is still pending. Shared by the layout pass and the
   * width-pinned content probe so nested and top-level work draw on one budget.
   */
  private resolveFitContentState(): void {
    if (!this.anyFitContentPending() || this._fitContentExhausted) {
      this._fitContentPending = false
      return
    }
    const frame = getFrameToken()
    if (this._lastPendingFrame !== frame) {
      this._lastPendingFrame = frame
      this._pendingFrames++
    }
    // The first pending frame is the initial attempt; FIT_CONTENT_RETRY_FRAMES
    // more frames may follow before the fallback is accepted.
    if (this._pendingFrames > FIT_CONTENT_RETRY_FRAMES) {
      this._fitContentExhausted = true
      this._fitContentPending = false
      return
    }
    this._fitContentPending = true
  }

  private anyFitContentPending(): boolean {
    for (const item of this._items) {
      if (item.fitContentPending) return true
    }
    return false
  }

  // ─── Engine Memoization ──────────────────────────────────────────────

  private inputsMatch(container: GridContainerInput): boolean {
    const c = this._lastContainerSnapshot
    if (!c) return false
    if (this._inputBuffer.length !== this._lastInputSnapshot.length) return false

    if (
      container.width !== c.width ||
      container.height !== c.height ||
      container.templateColumns !== c.templateColumns ||
      container.templateRows !== c.templateRows ||
      container.templateAreas !== c.templateAreas ||
      container.autoRows !== c.autoRows ||
      container.autoColumns !== c.autoColumns ||
      container.autoFlow !== c.autoFlow ||
      container.columnGap !== c.columnGap ||
      container.rowGap !== c.rowGap ||
      container.padding.top !== c.padding.top ||
      container.padding.right !== c.padding.right ||
      container.padding.bottom !== c.padding.bottom ||
      container.padding.left !== c.padding.left ||
      container.justifyItems !== c.justifyItems ||
      container.alignItems !== c.alignItems
    ) {
      return false
    }

    for (let i = 0; i < this._inputBuffer.length; i++) {
      const a = this._inputBuffer[i]
      const b = this._lastInputSnapshot[i]
      if (
        a.index !== b.index ||
        a.intrinsicWidth !== b.intrinsicWidth ||
        a.intrinsicHeight !== b.intrinsicHeight ||
        a.contentMinWidth !== b.contentMinWidth ||
        a.contentMinHeight !== b.contentMinHeight ||
        a.contentMaxWidth !== b.contentMaxWidth ||
        a.contentMaxHeight !== b.contentMaxHeight ||
        a.minWidth !== b.minWidth ||
        a.maxWidth !== b.maxWidth ||
        a.minHeight !== b.minHeight ||
        a.maxHeight !== b.maxHeight ||
        a.autoPlacement !== b.autoPlacement ||
        a.gridRow !== b.gridRow ||
        a.gridColumn !== b.gridColumn ||
        a.rowSpan !== b.rowSpan ||
        a.columnSpan !== b.columnSpan ||
        a.gridArea !== b.gridArea ||
        a.justifySelf !== b.justifySelf ||
        a.alignSelf !== b.alignSelf ||
        a.heightForWidth !== b.heightForWidth
      ) {
        return false
      }
    }

    return true
  }

  private snapshotInputs(container: GridContainerInput): void {
    this._lastContainerSnapshot = {
      width: container.width,
      height: container.height,
      templateColumns: container.templateColumns,
      templateRows: container.templateRows,
      templateAreas: container.templateAreas,
      autoRows: container.autoRows,
      autoColumns: container.autoColumns,
      autoFlow: container.autoFlow,
      columnGap: container.columnGap,
      rowGap: container.rowGap,
      padding: {
        top: container.padding.top,
        right: container.padding.right,
        bottom: container.padding.bottom,
        left: container.padding.left
      },
      justifyItems: container.justifyItems,
      alignItems: container.alignItems
    }

    while (this._lastInputSnapshot.length < this._inputBuffer.length) {
      this._lastInputSnapshot.push({} as GridItemInput)
    }
    this._lastInputSnapshot.length = this._inputBuffer.length

    for (let i = 0; i < this._inputBuffer.length; i++) {
      const src = this._inputBuffer[i]
      const dst = this._lastInputSnapshot[i]
      dst.index = src.index
      dst.intrinsicWidth = src.intrinsicWidth
      dst.intrinsicHeight = src.intrinsicHeight
      dst.contentMinWidth = src.contentMinWidth
      dst.contentMinHeight = src.contentMinHeight
      dst.contentMaxWidth = src.contentMaxWidth
      dst.contentMaxHeight = src.contentMaxHeight
      dst.minWidth = src.minWidth
      dst.maxWidth = src.maxWidth
      dst.minHeight = src.minHeight
      dst.maxHeight = src.maxHeight
      dst.autoPlacement = src.autoPlacement
      dst.gridRow = src.gridRow
      dst.gridColumn = src.gridColumn
      dst.rowSpan = src.rowSpan
      dst.columnSpan = src.columnSpan
      dst.gridArea = src.gridArea
      dst.justifySelf = src.justifySelf
      dst.alignSelf = src.alignSelf
      dst.heightForWidth = src.heightForWidth
    }
  }

  // ─── Debug Visualization ─────────────────────────────────────────────

  private renderDebug(): void {
    if (!this._debug || !this._initialized) return

    const containerW = this._width < 0 ? this._computedWidth : this._width
    const containerH = this._height < 0 ? this._computedHeight : this._height
    const transform = this.sceneObject.getTransform()
    const worldPos = transform.getWorldPosition()
    const worldRot = transform.getWorldRotation()
    const worldScale = transform.getWorldScale()

    const hAlign = this._horizontalAlignment as ContentHorizontalAlignment
    const localCenterX =
      hAlign === ContentHorizontalAlignment.Left
        ? containerW * 0.5
        : hAlign === ContentHorizontalAlignment.Right
          ? -containerW * 0.5
          : 0

    const vAlign = this._verticalAlignment as ContentVerticalAlignment
    const localCenterY =
      vAlign === ContentVerticalAlignment.Top
        ? -containerH * 0.5
        : vAlign === ContentVerticalAlignment.Bottom
          ? containerH * 0.5
          : 0

    const containerCenter = worldPos.add(
      worldRot.multiplyVec3(new vec3(localCenterX * worldScale.x, localCenterY * worldScale.y, 0))
    )

    // Container bounds (yellow box)
    const cColor = new vec4(1, 1, 0, 1)
    drawWorldBox(containerCenter, containerW, containerH, worldRot, worldScale, cColor)

    // Origin marker (red diamond)
    const dSize = 0.3
    const dTop = worldPos.add(worldRot.multiplyVec3(new vec3(0, dSize, 0)))
    const dRight = worldPos.add(worldRot.multiplyVec3(new vec3(dSize, 0, 0)))
    const dBottom = worldPos.add(worldRot.multiplyVec3(new vec3(0, -dSize, 0)))
    const dLeft = worldPos.add(worldRot.multiplyVec3(new vec3(-dSize, 0, 0)))
    const dColor = new vec4(1, 0.2, 0.2, 1)
    global.debugRenderSystem.drawSolidTriangle(dTop, dLeft, dBottom, dColor)
    global.debugRenderSystem.drawSolidTriangle(dTop, dBottom, dRight, dColor)

    // Item bounds (green)
    // Sizes are in the container's local coordinate space, so use container's world transform
    const iColor = new vec4(0, 1, 0.5, 1)
    for (const item of this._items) {
      const itemPos = item.sceneObject.getTransform().getWorldPosition()
      const size = item.allocatedSize()
      drawWorldBox(itemPos, size.width, size.height, worldRot, worldScale, iColor)
    }
  }
}

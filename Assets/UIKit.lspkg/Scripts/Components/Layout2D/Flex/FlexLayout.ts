// ═══════════════════════════════════════════════════════════════════════════
// FlexLayout.ts — Thin orchestrator component.
//
// Attach to a container SceneObject. Discovers child FlexItems, calls the
// pure Flexbox2D engine, and applies results back to children.
//
// Layout is batched: property changes mark dirty → LateUpdateEvent runs
// the layout pass once per frame.
// ═══════════════════════════════════════════════════════════════════════════

import Event from "InteractionKit.lspkg/Utils/Event"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import ReplayEvent from "InteractionKit.lspkg/Utils/ReplayEvent"
import {drawWorldBox} from "../../../Utility/DebugDraw"
import {LayoutItem2D, PresentationRequest} from "../LayoutItem2D"
import {LayoutPreparation, LayoutPresentation} from "../LayoutPresentation"
import {FIT_CONTENT_RETRY_FRAMES} from "../LayoutTypes"
import {getFrameToken} from "../TextMeasurement"
import {UIKitBrands} from "../UIKitBrands"
import {computeFlexLayout} from "./Flexbox2D"
import {FlexItem} from "./FlexItem"
import {
  FLEX_BASIS_AUTO,
  FlexAlign,
  FlexAlignContent,
  FlexContainerInput,
  FlexContentHorizontalAlignment,
  FlexContentVerticalAlignment,
  FlexDirection,
  FlexItemInput,
  FlexJustify,
  FlexLayoutResult,
  FlexWrap
} from "./FlexTypes"

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const log = new NativeLogger("FlexLayout")

// Note: Enum values are used as string literals in @widget decorators (Lens Studio requirement)
// but the engine still uses the enum types internally via casts.

/**
 * CSS Flexbox layout container for the Layout2D system.
 *
 * Attach to a SceneObject and add {@link FlexItem} components to its direct children.
 * The container discovers children automatically, runs the pure {@link computeFlexLayout}
 * engine, and applies positions/sizes back to each child via its resolved handler.
 *
 * Layout is batched: property changes call {@link markDirty} and the layout pass runs
 * once per frame in LateUpdate.
 */
@component
export class FlexLayout extends BaseScriptComponent {
  /**
   * Type brand consumed by the Layout2D `LayoutContainerHandler` finder.
   * Shared with GridLayout. See `Layout2D/UIKitBrands.ts`.
   */
  public readonly __uikitBrand = UIKitBrands.LayoutContainer

  // ─── Container Size ──────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Container Size</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Dimensions of the flex container in local space</span>')
  @input
  @label("Width")
  @hint("Container width in cm. -1 = auto (shrink-to-fit content).")
  private _width: number = 20

  @input
  @label("Height")
  @hint("Container height in cm. -1 = auto (shrink-to-fit content).")
  private _height: number = 20

  // ─── Flex Properties ─────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Flex Properties</span>')
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Main axis direction, wrapping, and alignment behavior</span>'
  )
  @input
  @label("Direction")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Row", "row"),
      new ComboBoxItem("Row Reverse", "rowReverse"),
      new ComboBoxItem("Column", "column"),
      new ComboBoxItem("Column Reverse", "columnReverse")
    ])
  )
  @hint("Main axis direction for laying out items.")
  private _direction: string = "row"

  @input
  @label("Wrap")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("No Wrap", "nowrap"),
      new ComboBoxItem("Wrap", "wrap"),
      new ComboBoxItem("Wrap Reverse", "wrapReverse")
    ])
  )
  @hint("Whether items wrap to new lines when they overflow.")
  private _wrap: string = "nowrap"

  @input
  @label("Justify Content")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Start", "start"),
      new ComboBoxItem("Center", "center"),
      new ComboBoxItem("End", "end"),
      new ComboBoxItem("Space Between", "spaceBetween"),
      new ComboBoxItem("Space Around", "spaceAround"),
      new ComboBoxItem("Space Evenly", "spaceEvenly")
    ])
  )
  @hint("Distribution of items along the main axis.")
  private _justifyContent: string = "start"

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
  @hint("Alignment of items along the cross axis.")
  private _alignItems: string = "start"

  @input
  @label("Align Content")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Start", "start"),
      new ComboBoxItem("Center", "center"),
      new ComboBoxItem("End", "end"),
      new ComboBoxItem("Space Between", "spaceBetween"),
      new ComboBoxItem("Space Around", "spaceAround"),
      new ComboBoxItem("Space Evenly", "spaceEvenly"),
      new ComboBoxItem("Stretch", "stretch")
    ])
  )
  @hint("Distribution of wrapped lines along the cross axis (only applies when wrapping).")
  private _alignContent: string = "start"

  // ─── Gap ─────────────────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Gap</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Spacing between rows and columns</span>')
  @input
  @label("Row Gap")
  @hint(
    "Gap between rows in cm. Always separates horizontal rows of items — cross-axis gap when direction=Row, main-axis gap when direction=Column."
  )
  private _rowGap: number = 0

  @input
  @label("Column Gap")
  @hint(
    "Gap between columns in cm. Always separates vertical columns of items — main-axis gap when direction=Row, cross-axis gap when direction=Column."
  )
  private _columnGap: number = 0

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

  // ─── Content Alignment ──────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Content Alignment</span>')
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Position of the layout content relative to the SceneObject center</span>'
  )
  @input
  @label("Horizontal")
  @hint("Horizontal alignment of the layout content relative to the SceneObject center.")
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
  @hint("Vertical alignment of the layout content relative to the SceneObject center.")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Top", "top"),
      new ComboBoxItem("Center", "center"),
      new ComboBoxItem("Bottom", "bottom")
    ])
  )
  private _verticalAlignment: string = "center"

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Item Source</span>')
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Choose whether this layout manages direct children automatically or uses an explicit manual item list</span>'
  )

  /**
   * When enabled, the layout discovers its direct-child {@link FlexItem}s once
   * during OnStartEvent. If disabled, {@link FlexItem}s have to be set manually in inspector
   * or through other script using {@link FlexLayout.addItems}.
   */
  @input
  @label("Auto Discover Items On Start")
  @hint("Discovers direct-child FlexItems once during OnStartEvent. Disable to manage items manually")
  private _autoDiscoverItemsOnStart: boolean = true

  @ui.group_start("Flex Items Selection")
  @showIf("_autoDiscoverItemsOnStart", false)
  @input
  @label("Items")
  @hint("Choose initial flex item children for the layout")
  private _items: FlexItem[] = []
  @ui.group_end

  // ─── Debug ───────────────────────────────────────────────────────────
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Debug</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Visual debugging tools for layout inspection</span>')
  @input
  @label("Debug Visualization")
  @hint("Enable debug visualization (container and item bounds).")
  private _debug: boolean = false

  // ─── Internal State ──────────────────────────────────────────────────

  private _dirty: boolean = true
  private _isPerformingLayout: boolean = false
  private _initialized: boolean = false
  private _computedWidth: number = 0
  private _computedHeight: number = 0
  // Charge pending work once per host frame. Only external markDirty() resets the budget.
  private _fitContentPending: boolean = false
  private _notifyingLayout: boolean = false
  public readonly presentation = new LayoutPresentation(
    () => this._siblingFlexItem?.parentLayout?.presentation ?? null,
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

  /** Cached sibling FlexItem (for dirty propagation to parent layout) */
  private _siblingFlexItem: LayoutItem2D | null = null

  /** Pre-allocated input buffer — avoids per-pass allocations in performLayout(). */
  private _inputBuffer: FlexItemInput[] = []

  /** Engine memoization — skip computeFlexLayout when inputs are unchanged. */
  private _lastResult: FlexLayoutResult | null = null
  private _lastInputSnapshot: FlexItemInput[] = []
  private _lastContainerSnapshot: FlexContainerInput | null = null

  // Content-size memo, keyed by a markDirty-bumped generation: computeContentSize
  // is a pure function of config + children's intrinsics (both change only via
  // markDirty), so cache per mode and skip the engine on repeat same-gen calls.
  private _measureGen: number = 0
  private _contentSizeCache: {
    gen: number
    sizes: Partial<Record<string, {width: number; height: number}>>
  } = {gen: -1, sizes: {}}

  private lateUpdateEvent: SceneEvent
  private debugUpdateEvent: SceneEvent

  // ─── Events ──────────────────────────────────────────────────────────

  private readonly onInitializedEvent = new ReplayEvent<void>()
  /** Fires once after the first child discovery and layout pass. Replays for late subscribers. */
  public readonly onInitialized = this.onInitializedEvent.publicApi()

  private readonly onLayoutCompleteEvent = new Event<FlexLayoutResult>()
  /** Fires after every layout pass with the full {@link FlexLayoutResult}. */
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

  /** Main axis direction for laying out items. */
  public get direction(): FlexDirection {
    return this._direction as FlexDirection
  }
  public set direction(value: FlexDirection) {
    if (this._direction === value) return
    this._direction = value
    this.markDirty()
  }

  /** Whether items wrap onto multiple lines when they overflow the main axis. */
  public get wrap(): FlexWrap {
    return this._wrap as FlexWrap
  }
  public set wrap(value: FlexWrap) {
    if (this._wrap === value) return
    this._wrap = value
    this.markDirty()
  }

  /** Distribution of items along the main axis. */
  public get justifyContent(): FlexJustify {
    return this._justifyContent as FlexJustify
  }
  public set justifyContent(value: FlexJustify) {
    if (this._justifyContent === value) return
    this._justifyContent = value
    this.markDirty()
  }

  /** Default cross-axis alignment for all items. */
  public get alignItems(): FlexAlign {
    return this._alignItems as FlexAlign
  }
  public set alignItems(value: FlexAlign) {
    if (this._alignItems === value) return
    this._alignItems = value
    this.markDirty()
  }

  /** Distribution of wrapped lines along the cross axis. Only applies when wrapping is enabled. */
  public get alignContent(): FlexAlignContent {
    return this._alignContent as FlexAlignContent
  }
  public set alignContent(value: FlexAlignContent) {
    if (this._alignContent === value) return
    this._alignContent = value
    this.markDirty()
  }

  /** Gap between rows in cm. Cross-axis gap when direction=Row, main-axis gap when direction=Column. */
  public get rowGap(): number {
    return this._rowGap
  }
  public set rowGap(value: number) {
    if (this._rowGap === value) return
    this._rowGap = Math.max(0, value)
    this.markDirty()
  }

  /** Gap between columns in cm. Main-axis gap when direction=Row, cross-axis gap when direction=Column. */
  public get columnGap(): number {
    return this._columnGap
  }
  public set columnGap(value: number) {
    if (this._columnGap === value) return
    this._columnGap = Math.max(0, value)
    this.markDirty()
  }

  /** Sets both rowGap and columnGap to the same value (in cm). */
  public set gap(value: number) {
    this._rowGap = Math.max(0, value)
    this._columnGap = Math.max(0, value)
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

  /** Horizontal alignment of the layout content relative to the SceneObject center. */
  public get horizontalAlignment(): FlexContentHorizontalAlignment {
    return this._horizontalAlignment as FlexContentHorizontalAlignment
  }
  public set horizontalAlignment(value: FlexContentHorizontalAlignment) {
    if (this._horizontalAlignment === value) return
    this._horizontalAlignment = value
    this.markDirty()
  }

  /** Vertical alignment of the layout content relative to the SceneObject center. */
  public get verticalAlignment(): FlexContentVerticalAlignment {
    return this._verticalAlignment as FlexContentVerticalAlignment
  }
  public set verticalAlignment(value: FlexContentVerticalAlignment) {
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

  /** Whether the layout discovers direct-child FlexItems automatically during startup. */
  public get autoDiscoverItemsOnStart(): boolean {
    return this._autoDiscoverItemsOnStart
  }
  public set autoDiscoverItemsOnStart(value: boolean) {
    this._autoDiscoverItemsOnStart = value
  }

  /** Number of FlexItems currently managed by this layout. */
  public get itemCount(): number {
    return this._items.length
  }

  /** The FlexItems currently managed by this layout. */
  public get items(): ReadonlyArray<FlexItem> {
    return this._items
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
      // Cache sibling FlexItem for dirty propagation to parent layout.
      // `instanceof FlexItem` so a FlexItem subclass (composite widget)
      // on the wrapping SceneObject is still picked up.
      const scripts = this.sceneObject.getComponents("ScriptComponent")
      for (const c of scripts) {
        // Any Layout2D item type: this container may be nested inside the
        // OTHER container kind (a FlexLayout inside a GridLayout is wrapped by
        // a GridItem), and its parent still needs the dirty bubble.
        if (c instanceof LayoutItem2D) {
          this._siblingFlexItem = c
          break
        }
      }

      if (this._autoDiscoverItemsOnStart) {
        this._items = []
        this.refreshChildren()
      } else {
        for (const item of this._items) {
          item.setParentLayout(this)
        }
      }
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
    // notify the parent via the sibling FlexItem on the same SceneObject.
    if (this._siblingFlexItem) {
      this._siblingFlexItem["_parentLayout"]?.markDirty()
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
   * Compute the intrinsic size of this layout container.
   *
   * `mode` selects which content axis drives sizing:
   * - `"preferred"` (default) — natural / max-content size needed to fit
   *   children at their preferred sizes
   * - `"min"` — shrink-fit minimum: each child contributes its `min` content
   *   size, so the container reports the smallest it can be without
   *   violating any child's content-min
   * - `"max"` — grow-fit maximum: each child contributes its `max` content
   *   size (often Infinity for flexible content)
   *
   * Used by LayoutContainerHandler so nested layouts can report all three
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

  /** Natural content probe with an optional pinned item, without changing live item properties. */
  public computeContentSizeWithItem(
    item: FlexItem | null,
    size: {width: number; height: number},
    configuration: Partial<FlexContainerInput>
  ): {width: number; height: number} {
    const inputs = this._items.map((entry) => {
      if (entry !== item) return entry.toInput()
      const input = entry.toInput("preferred", {
        min: {width: 0, height: 0},
        preferred: size,
        max: {width: Infinity, height: Infinity}
      })
      input.flexGrow = 0
      input.flexBasis = FLEX_BASIS_AUTO
      input.heightForWidth = undefined
      return input
    })
    const result = computeFlexLayout({...this.buildContentSizeInput(-1), ...configuration}, inputs)
    return {width: result.containerWidth, height: result.containerHeight}
  }

  /**
   * All three intrinsic modes in one call, sharing the per-mode memo — used by
   * LayoutContainerHandler so a nested layout reports min/preferred/max without
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
          computeFlexLayout(
            this.buildContentSizeInput(width),
            this._items.map((item) => item.toInput("preferred"))
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
    const itemInputs = this._items.map((item) => item.toInput("preferred"))
    const result = computeFlexLayout(containerInput, itemInputs)
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
    const itemInputs = this._items.map((item) => item.toInput(mode))
    const result = computeFlexLayout(containerInput, itemInputs)
    return {width: result.containerWidth, height: result.containerHeight}
  }

  /** Engine input for an intrinsic-size probe: auto height, `width` (or -1 = auto) wide. */
  private buildContentSizeInput(width: number): FlexContainerInput {
    return {
      width,
      height: -1,
      direction: this._direction as FlexDirection,
      wrap: this._wrap as FlexWrap,
      justifyContent: this._justifyContent as FlexJustify,
      alignItems: this._alignItems as FlexAlign,
      alignContent: this._alignContent as FlexAlignContent,
      padding: {
        top: this._paddingTop,
        right: this._paddingRight,
        bottom: this._paddingBottom,
        left: this._paddingLeft
      },
      rowGap: this._rowGap,
      columnGap: this._columnGap
    }
  }

  /**
   * Programmatically adds FlexItem children to this layout.
   * Duplicates are ignored. Triggers a layout recalculation.
   * Note: If adding items before component is initialized,
   * make sure {@link autoDiscoverItemsOnStart} is disabled.
   * @throws Error if {@link autoDiscoverItemsOnStart} is enabled and the layout is not initialized.
   * @param items - FlexItem components to add.
   */
  public addItems(items: ReadonlyArray<FlexItem>): void {
    if (this._autoDiscoverItemsOnStart && !this._initialized) {
      throw new Error("Cannot add items while autoDiscoverItemsOnStart is enabled and the layout is not initialized")
    }
    if (items == this._items) {
      return
    }
    for (const item of items) {
      if (this._items.indexOf(item) === -1) {
        this._items.push(item)
        item.setParentLayout(this)
      }
    }
    this.markDirty()
  }

  /**
   * Programmatically removes FlexItem children from this layout.
   * Items not currently managed are ignored. Triggers a layout recalculation.
   * Note: If removing items before component is initialized,
   * make sure {@link autoDiscoverItemsOnStart} is disabled.
   * @throws Error if {@link autoDiscoverItemsOnStart} is enabled and the layout is not initialized.
   * @param items - FlexItem components to remove.
   */
  public removeItems(items: ReadonlyArray<FlexItem>): void {
    if (this._autoDiscoverItemsOnStart && !this._initialized) {
      throw new Error("Cannot remove items while autoDiscoverItemsOnStart is enabled and the layout is not initialized")
    }
    if (this._items == items) {
      this.clearItems()
      return
    }
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
   * Rebuilds the managed item list from direct-child {@link FlexItem}s.
   *
   * This is intended for layouts that use startup child discovery as their
   * ownership model and need an explicit rescan later in runtime.
   */
  public refreshChildren(): void {
    this.discoverChildren()
    this.markDirty()
  }

  /**
   * Reorders the existing managed items to match the given sequence. The set
   * of items must be exactly the currently managed set — no additions or
   * removals — only a permutation.
   */
  public reorderItems(orderedItems: FlexItem[]): void {
    if (orderedItems.length !== this._items.length) {
      log.e(`reorderItems: length mismatch (got ${orderedItems.length}, expected ${this._items.length})`)
      return
    }
    const seen = new Set<FlexItem>()
    for (const item of orderedItems) {
      if (this._items.indexOf(item) === -1) {
        log.e("reorderItems: item not in managed set")
        return
      }
      if (seen.has(item)) {
        log.e("reorderItems: duplicate item in order")
        return
      }
      seen.add(item)
    }
    this._items = orderedItems.slice()
    this.markDirty()
  }

  /**
   * Programmatically removes all FlexItem children from this layout.
   * Detaches each managed item from this layout and triggers a layout recalculation.
   * Note: If clearing items before component is initialized,
   * make sure {@link autoDiscoverItemsOnStart} is disabled.
   * @throws Error if {@link autoDiscoverItemsOnStart} is enabled and the layout is not initialized.
   */
  public clearItems(): void {
    if (this._autoDiscoverItemsOnStart && !this._initialized) {
      throw new Error("Cannot clear items while autoDiscoverItemsOnStart is enabled and the layout is not initialized")
    }
    const itemsToClear = this._items
    this._items = []
    for (const item of itemsToClear) {
      item.setParentLayout(null)
    }
    this.markDirty()
  }

  // ─── Child Discovery ─────────────────────────────────────────────────

  private discoverChildren(): void {
    const parent = this.sceneObject
    const childCount = parent.getChildrenCount()
    const discoveredItems: FlexItem[] = []

    // Scan for FlexItem components on direct children. `instanceof FlexItem`
    // (not `getComponent(FlexItem.getTypeName())`) so we catch FlexItem
    // subclasses too — composite widgets like `LabeledBadge` extend FlexItem
    // and need to be auto-discovered the same way.
    for (let i = 0; i < childCount; i++) {
      const child = parent.getChild(i)
      if (!child.enabled) continue
      const scripts = child.getComponents("ScriptComponent")
      for (const c of scripts) {
        if (c instanceof FlexItem) {
          discoveredItems.push(c)
          break
        }
      }
    }

    this.setManagedItems(discoveredItems)
  }

  /**
   * Replaces the currently managed items, updating parent-layout links to match.
   * @param items - New managed items in layout order.
   */
  private setManagedItems(items: FlexItem[]): void {
    for (const item of this._items) {
      if (items.indexOf(item) === -1) {
        item.setParentLayout(null)
      }
    }

    this._items = items.slice()

    for (const item of this._items) {
      item.setParentLayout(this)
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
        const result = computeFlexLayout(
          input,
          this._items.map((item) => item.toInput("preferred"))
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

    let result: FlexLayoutResult
    try {
      // Build engine inputs
      const containerInput: FlexContainerInput = {
        width: this._width,
        height: this._height,
        direction: this._direction as FlexDirection,
        wrap: this._wrap as FlexWrap,
        justifyContent: this._justifyContent as FlexJustify,
        alignItems: this._alignItems as FlexAlign,
        alignContent: this._alignContent as FlexAlignContent,
        padding: {
          top: this._paddingTop,
          right: this._paddingRight,
          bottom: this._paddingBottom,
          left: this._paddingLeft
        },
        rowGap: this._rowGap,
        columnGap: this._columnGap
      }

      // Fill pre-allocated input buffer (avoids N allocations per pass)
      while (this._inputBuffer.length < this._items.length) {
        this._inputBuffer.push({} as FlexItemInput)
      }
      this._inputBuffer.length = this._items.length

      for (let i = 0; i < this._items.length; i++) {
        this._items[i].fillInput(this._inputBuffer[i])
      }

      // Run pure layout engine — or return cached result if inputs are unchanged
      if (this._lastResult && this.inputsMatch(containerInput)) {
        result = this._lastResult
        this._fitContentPending = false
      } else {
        result = computeFlexLayout(containerInput, this._inputBuffer)
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
      // Horizontal: left = left edge at origin, center = centered, right = right edge at origin
      // Vertical: top = top edge at origin, center = centered, bottom = bottom edge at origin
      const hAlign = this._horizontalAlignment as FlexContentHorizontalAlignment
      const hOffset =
        hAlign === FlexContentHorizontalAlignment.Left
          ? 0
          : hAlign === FlexContentHorizontalAlignment.Right
            ? -result.containerWidth
            : -result.containerWidth * 0.5

      const vAlign = this._verticalAlignment as FlexContentVerticalAlignment
      const vOffset =
        vAlign === FlexContentVerticalAlignment.Top
          ? 0
          : vAlign === FlexContentVerticalAlignment.Bottom
            ? result.containerHeight
            : result.containerHeight * 0.5

      // Apply results
      for (let i = 0; i < this._items.length; i++) {
        const output = result.items[i]
        if (output) {
          // Convert from top-left origin to center-based coordinates
          // Engine outputs x,y as top-left positions.
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

  private inputsMatch(container: FlexContainerInput): boolean {
    const c = this._lastContainerSnapshot
    if (!c) return false
    if (this._inputBuffer.length !== this._lastInputSnapshot.length) return false

    if (
      container.width !== c.width ||
      container.height !== c.height ||
      container.direction !== c.direction ||
      container.wrap !== c.wrap ||
      container.justifyContent !== c.justifyContent ||
      container.alignItems !== c.alignItems ||
      container.alignContent !== c.alignContent ||
      container.rowGap !== c.rowGap ||
      container.columnGap !== c.columnGap ||
      container.padding.top !== c.padding.top ||
      container.padding.right !== c.padding.right ||
      container.padding.bottom !== c.padding.bottom ||
      container.padding.left !== c.padding.left
    ) {
      return false
    }

    for (let i = 0; i < this._inputBuffer.length; i++) {
      const a = this._inputBuffer[i]
      const b = this._lastInputSnapshot[i]
      if (
        a.intrinsicWidth !== b.intrinsicWidth ||
        a.intrinsicHeight !== b.intrinsicHeight ||
        a.contentMinWidth !== b.contentMinWidth ||
        a.contentMinHeight !== b.contentMinHeight ||
        a.contentMaxWidth !== b.contentMaxWidth ||
        a.contentMaxHeight !== b.contentMaxHeight ||
        a.flexGrow !== b.flexGrow ||
        a.flexShrink !== b.flexShrink ||
        a.flexBasis !== b.flexBasis ||
        a.order !== b.order ||
        a.alignSelf !== b.alignSelf ||
        a.minWidth !== b.minWidth ||
        a.maxWidth !== b.maxWidth ||
        a.minHeight !== b.minHeight ||
        a.maxHeight !== b.maxHeight ||
        a.marginTop !== b.marginTop ||
        a.marginRight !== b.marginRight ||
        a.marginBottom !== b.marginBottom ||
        a.marginLeft !== b.marginLeft ||
        a.aspectRatio !== b.aspectRatio ||
        a.heightForWidth !== b.heightForWidth
      ) {
        return false
      }
    }

    return true
  }

  private snapshotInputs(container: FlexContainerInput): void {
    this._lastContainerSnapshot = {
      width: container.width,
      height: container.height,
      direction: container.direction,
      wrap: container.wrap,
      justifyContent: container.justifyContent,
      alignItems: container.alignItems,
      alignContent: container.alignContent,
      padding: {
        top: container.padding.top,
        right: container.padding.right,
        bottom: container.padding.bottom,
        left: container.padding.left
      },
      rowGap: container.rowGap,
      columnGap: container.columnGap
    }

    // Grow snapshot array if needed, then deep-copy each item
    while (this._lastInputSnapshot.length < this._inputBuffer.length) {
      this._lastInputSnapshot.push({} as FlexItemInput)
    }
    this._lastInputSnapshot.length = this._inputBuffer.length

    for (let i = 0; i < this._inputBuffer.length; i++) {
      const src = this._inputBuffer[i]
      const dst = this._lastInputSnapshot[i]
      dst.intrinsicWidth = src.intrinsicWidth
      dst.intrinsicHeight = src.intrinsicHeight
      dst.contentMinWidth = src.contentMinWidth
      dst.contentMinHeight = src.contentMinHeight
      dst.contentMaxWidth = src.contentMaxWidth
      dst.contentMaxHeight = src.contentMaxHeight
      dst.flexGrow = src.flexGrow
      dst.flexShrink = src.flexShrink
      dst.flexBasis = src.flexBasis
      dst.order = src.order
      dst.alignSelf = src.alignSelf
      dst.minWidth = src.minWidth
      dst.maxWidth = src.maxWidth
      dst.minHeight = src.minHeight
      dst.maxHeight = src.maxHeight
      dst.marginTop = src.marginTop
      dst.marginRight = src.marginRight
      dst.marginBottom = src.marginBottom
      dst.marginLeft = src.marginLeft
      dst.aspectRatio = src.aspectRatio
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

    // Compute container center offset based on content alignment
    const hAlign = this._horizontalAlignment as FlexContentHorizontalAlignment
    const localCenterX =
      hAlign === FlexContentHorizontalAlignment.Left
        ? containerW * 0.5
        : hAlign === FlexContentHorizontalAlignment.Right
          ? -containerW * 0.5
          : 0

    const vAlign = this._verticalAlignment as FlexContentVerticalAlignment
    const localCenterY =
      vAlign === FlexContentVerticalAlignment.Top
        ? -containerH * 0.5
        : vAlign === FlexContentVerticalAlignment.Bottom
          ? containerH * 0.5
          : 0

    const containerCenter = worldPos.add(
      worldRot.multiplyVec3(new vec3(localCenterX * worldScale.x, localCenterY * worldScale.y, 0))
    )

    // Container bounds (yellow box) at alignment-adjusted position
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

    // Item bounds (cyan) — use allocated size from layout, not intrinsic measure
    // Sizes are in the container's local coordinate space, so use container's world transform
    const iColor = new vec4(0, 1, 1, 1)
    for (const item of this._items) {
      const itemPos = item.sceneObject.getTransform().getWorldPosition()
      const size = item.allocatedSize()
      drawWorldBox(itemPos, size.width, size.height, worldRot, worldScale, iColor)
    }
  }
}

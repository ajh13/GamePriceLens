import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {InteractionManager} from "InteractionKit.lspkg/Core/InteractionManager/InteractionManager"
import Event, {PublicApi, unsubscribe} from "InteractionKit.lspkg/Utils/Event"
import {setTimeout} from "InteractionKit.lspkg/Utils/FunctionTimingUtils"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import ReplayEvent from "InteractionKit.lspkg/Utils/ReplayEvent"
import {findAllComponentsInSelfOrChildren} from "InteractionKit.lspkg/Utils/SceneObjectUtils"
import {Element} from "../Element"
import {FlexItem} from "../Layout2D/Flex/FlexItem"
import {FlexLayout} from "../Layout2D/Flex/FlexLayout"
import {FlexContentHorizontalAlignment, FlexContentVerticalAlignment, FlexDirection} from "../Layout2D/Flex/FlexTypes"
import {ItemHandlerRegistry} from "../Layout2D/ItemHandlerRegistry"
import {ScrollWindow} from "../ScrollWindow/ScrollWindow"
import type {VirtualizedLayoutDebugStats} from "./VirtualizedLayoutStats"
import {clampVirtualizedWindowStart, VirtualizedLayoutMetadata, VirtualizedLayoutStats} from "./VirtualizedLayoutStats"

const TAG = "VirtualizedLayout"
const log = new NativeLogger(TAG)

const SCROLL_IDLE_TIMEOUT_MS = 500
// Per-frame grow cap for the post-scroll-idle deferred-grows drain.
const DRAIN_GROWS_PER_FRAME = 1
// Frames an align correction waits for an async-sized target row before
// accepting the estimate. ~1.5s at 60fps; bounds the per-frame LateUpdate pin.
const ALIGN_CORRECTION_MAX_WAIT_FRAMES = 90
const ALPHA_EPSILON = 0.001
const OFFSET_WRITE_EPSILON = 0.001
// Floor below which `intraItemFraction` snaps to 0 during anchor recompute.
const INTRA_ITEM_EPSILON = 1e-4
// Minimum seconds between successive `tickShrinkGC` passes.
const SHRINK_GC_TICK_INTERVAL_SEC = 1.0
// Max consecutive re-drains of `applyDataChange` when an `adapter.onBindView`
// subscriber synchronously mutates `totalItems`.
const MAX_DATA_CHANGE_REDRAIN = 4
// Tolerance used to detect "at start" / "at end" of scroll in the fade loop.
const FADE_EDGE_EPSILON = 0.001
// Floor for `_fadeZone`. With fadeDistance=0 the per-edge alpha math
// produces 0/0 = NaN and permanently corrupts the slot's color vec4.
const FADE_ZONE_MIN = 1e-3
// Below this scroll delta, the per-slot alpha pass in `updateFade` is a no-op.
const FADE_SCROLL_EPSILON = 0.05
const SUB_COLLIDER_AXIS_SCALE_EPSILON = 1e-5

// Fully-qualified component name. `getComponentsInDescendants` is namespace-strict.
const COLLIDER_COMPONENT_NAME = "Physics.ColliderComponent" as const

// Brand for elements that participate in collider clipping.
type ClippableElement = Element

/**
 * Optional provider contract for explicit sub-colliders clipped by
 * VirtualizedLayout. `clipColliders` is discovered only on structure refresh;
 * replacement colliders require `invalidate(..., "structure")`. Providers whose
 * existing collider transform, size, or enabled intent changes should expose
 * `onClipCollidersDirty` so VL can run one LateUpdate clip pass. When omitted,
 * explicit sub-colliders reclip only on scroll/layout/structure changes. Use
 * `isClipColliderEnabled` to report provider intent without relying on the
 * native `collider.enabled` bit, which VL also masks.
 */
type ClipColliderProvider = {
  readonly clipColliders: ColliderComponent[]
  readonly onClipCollidersDirty?: PublicApi<void>
  isClipColliderEnabled?(collider: ColliderComponent): boolean
}

type ClipBand = "hidden" | "fullyVisible" | "partial"

type SubColliderClipState = {
  band: ClipBand
  enabled: boolean
  debugDrawEnabled: boolean
}

function isClippableElement(sc: ScriptComponent): sc is ClippableElement {
  return sc instanceof Element
}

function getClipColliderProvider(sc: ScriptComponent): ClipColliderProvider | null {
  const provider = sc as unknown as ClipColliderProvider
  return Array.isArray(provider.clipColliders) ? provider : null
}

// Duck-type BoxShape because the BoxShape constructor is not runtime-global in
// every Lens Studio version.
function isBoxShapeLike(shape: unknown): shape is BoxShape {
  const candidate = shape as {size?: {x?: unknown; y?: unknown; z?: unknown}; radius?: unknown} | null
  return (
    candidate != null &&
    candidate.size != null &&
    typeof candidate.size.x === "number" &&
    typeof candidate.size.y === "number" &&
    typeof candidate.size.z === "number" &&
    candidate.radius === undefined
  )
}

export enum ScrollDirection {
  Vertical = "vertical",
  Horizontal = "horizontal"
}

/**
 * Sentinel type forwarded to `adapter.onCreateView` when `getItemType` is
 * unset or returns empty. Include in narrowed `TType` unions.
 */
export const VL_DEFAULT_TYPE = "default"

/** Literal type of `VL_DEFAULT_TYPE`. Include in narrowed `TType` unions. */
export type VLDefaultType = typeof VL_DEFAULT_TYPE

export interface VirtualizedScrollOptionsBase {
  align?: "start" | "center" | "end"
  offset?: number
  durationMs?: number
}

export interface VirtualizedScrollOptions extends VirtualizedScrollOptionsBase {
  index: number | "start" | "end"
}

export type DataIndexLookup = {kind: "bound"; index: number} | {kind: "unbound"} | {kind: "notSlot"}

export type InvalidateFields = "content" | "size" | "type" | "structure" | "all"

/**
 * Per-field invalidation flags. Pass to `invalidate` to combine several fields
 * precisely (e.g. content + size without structure). Invalidates exactly the
 * set flags; no flags set is a no-op. The `"all"` default applies only when the
 * `fields` argument is omitted entirely.
 */
export interface InvalidateOptions {
  content?: boolean
  size?: boolean
  type?: boolean
  structure?: boolean
}

type InvalidateFlags = {content: boolean; size: boolean; type: boolean; structure: boolean}

/**
 * Adapter consumed by `VirtualizedLayout`. The holder returned by
 * `onCreateView` is stored per pool slot and threaded into every subsequent
 * `onBindView` / `onUnbindView`. Include `VL_DEFAULT_TYPE` in narrowed `TType`
 * unions — VL falls back to it when `getItemType` is unset.
 */
export interface VirtualizedAdapter<TViewHolder, TType extends string = string> {
  itemCount(): number
  getItemKey?(dataIndex: number): string | number
  getItemType?(dataIndex: number): TType
  /**
   * Per-type slot floors for the current virtualized window. Returned types
   * are prewarmed even when their first row is outside bounded discovery.
   */
  getTypePoolMinimums?(windowSize: number): ReadonlyMap<TType, number>
  /**
   * Declare that `getItemSize` returns the same main-axis size for every row.
   * This keeps O(1) stride math while still allowing a callback-derived size.
   * When omitted, any `getItemSize` callback preserves the variable-size path.
   */
  isItemSizeUniform?: boolean
  /**
   * Per-item main-axis size in cm. Omit for static uniform lists. Pair with
   * `isItemSizeUniform: true` when every row shares one callback-derived size.
   */
  getItemSize?(dataIndex: number): number | undefined
  onCreateView(slot: SceneObject, type: TType): TViewHolder
  onBindView(slot: SceneObject, holder: TViewHolder, dataIndex: number): void
  /**
   * Optional lightweight update when a retained key moves index without changing
   * type, allocated size, or requested content. Update index-dependent holder
   * state here; omitting this callback preserves the full onBindView fallback.
   */
  onIndexChanged?(slot: SceneObject, holder: TViewHolder, dataIndex: number): void
  onUnbindView?(slot: SceneObject, holder: TViewHolder, dataIndex: number): void
  /**
   * Fired once when a pool slot is permanently reclaimed (shrink GC or resize),
   * distinct from `onUnbindView` which fires on every recycle. Release any
   * holder-owned resources (e.g. borrowed pooled primitives) here.
   */
  onDestroyView?(slot: SceneObject, holder: TViewHolder): void
}

// Restore target across a mutation. `key` lets a reorder/prepend remap the
// anchor to the row's new index instead of holding a stale data index.
type ViewportAnchor = {idx: number; frac: number; key: string | number | null; overscroll: number}

/**
 * Recycler-view-style scrolling list. Maintains a fixed pool of slots and
 * recycles them across data indices as the viewport scrolls. Assign an
 * `adapter`; configure via inspector inputs. Set `itemAlphaHandler` to take
 * over alpha ownership; otherwise the built-in fade pass writes alpha to
 * `Text` / `Image` components on the slot root.
 */
@component
export class VirtualizedLayout<TViewHolder, TType extends string = string> extends BaseScriptComponent {
  // ─── Inspector Inputs ──────────────────────────────────────────────

  @ui.group_start("Layout")
  @input("vec2", "{20, 30}")
  @label("Viewport Size")
  @hint("Visible viewport in cm. Items fill the cross-axis; main axis is the scroll direction.")
  private _viewportSize: vec2 = new vec2(20, 30)

  @input
  @label("Item Size")
  @hint(
    "Default item size in cm along the scroll axis (height for vertical, width for horizontal). `adapter.getItemSize` can override per item."
  )
  private _itemSize: number = 3

  @input
  @label("Buffer Count")
  @hint("Extra slots rendered above and below (or left and right of) the viewport.")
  private _bufferCount: number = 2

  @input
  @label("Gap")
  @hint("Spacing in cm between consecutive items along the scroll axis.")
  private _gap: number = 0

  @input
  @label("Scroll Direction")
  @widget(new ComboBoxWidget([new ComboBoxItem("Vertical", "vertical"), new ComboBoxItem("Horizontal", "horizontal")]))
  @hint("Scroll axis. Vertical stacks items top-to-bottom; horizontal stacks left-to-right.")
  private _scrollDirection: string = ScrollDirection.Vertical

  @input
  @label("Initial Index")
  @hint(
    "Data index the viewport opens at. Clamped to [0, totalItems-1]. Post-init writes scroll the viewport instantly."
  )
  private _initialIndex: number = 0
  @ui.group_end
  @ui.label("")
  @ui.group_start("Pool")
  @input
  @label("Min Slots Per Type")
  @hint(
    "Lower bound on per-type pool size after shrink GC. Setting to 2+ keeps spare slots warm so a single off-screen-back-into-view recycle doesn't fire adapter.onCreateView on the scroll hot path."
  )
  private _minSlotsPerType: number = 1

  @input
  @label("Shrink Delay (ms)")
  @hint(
    "Idle threshold before an unused pool slot is GC'd. 0 disables shrink entirely (pool only grows). Default 30000 = 30 seconds."
  )
  private _shrinkDelayMs: number = 30000

  @input
  @label("Prewarm Budget (ms)")
  @hint(
    "Per-frame budget for long-tail typed-pool prewarm — rare row types whose first occurrence is past the discovery limit. 0 = drain the long-tail synchronously instead of yielding. Visible and buffer types are always allocated synchronously at init regardless of this value."
  )
  private _prewarmBudgetMs: number = 10
  @ui.group_end
  @ui.label("")
  @ui.group_start("Fade")
  @input
  @label("Fade Enabled")
  @hint(
    'Built-in edge fade. Overwrites the color (RGBA) of Text and Image components directly on each pool slot\'s root SceneObject, reconstructing RGB from a baseline snapshotted at bind time — so RGB changes made after onBindView are clobbered on the next fade tick unless re-snapshotted via invalidate(range, "content"). For nested visuals, animated alpha, or zero-alpha placeholders, install a handler via the itemAlphaHandler setter instead (which transfers color ownership entirely to the consumer).'
  )
  private _fadeEnabled: boolean = false

  @input
  @showIf("_fadeEnabled", true)
  @label("Fade Distance")
  @hint("Distance in cm from viewport edge where fade begins.")
  private _fadeDistance: number = 1.0
  @ui.group_end
  @ui.label("")
  @ui.group_start("Callbacks")
  @input
  @label("Edge Reached Threshold")
  @hint(
    "Distance in cm from the start/end of the content at which onStartReached / onEndReached fire. 0 fires exactly at the edge. Fires once per crossing; re-arms after the viewport leaves the band."
  )
  private _edgeReachedThreshold: number = 0
  @ui.group_end

  // ─── Runtime Properties ────────────────────────────────────────────
  private _totalItems: number = 0

  // Once-per-crossing arming for the edge-reached callbacks. False while the
  // viewport sits inside the corresponding threshold band.
  private _endReachedArmed: boolean = true
  private _startReachedArmed: boolean = true

  private _poolSizeOverride: number | null = null

  // ─── Owned Dependencies ────────────────────────────────────────────

  private readonly _stats: VirtualizedLayoutStats = new VirtualizedLayoutStats(VL_DEFAULT_TYPE)
  private readonly _metadata: VirtualizedLayoutMetadata<TType> = new VirtualizedLayoutMetadata<TType>(
    VL_DEFAULT_TYPE,
    log
  )

  // Null only pre-onAwake and post-cleanup.
  private _scrollWindow: ScrollWindow | null = null
  private _layout: FlexLayout | null = null
  private _layoutTransform: Transform | null = null
  private _scrollWindowTransform: Transform | null = null

  // ─── Private State ─────────────────────────────────────────────────

  // Pool
  private _poolObjects: SceneObject[] = []
  private _poolItems: FlexItem[] = []
  private _dataIndices: number[] = []
  private _slotBySceneObject: Map<SceneObject, number> = new Map()
  private _poolHolders: (TViewHolder | null)[] = []
  // Cached `getItemKey(dataIndex)` per slot at bind time. Lets `applySnapshot`
  // redirect kept-key slots without unbind/bind cycling.
  private _slotKeys: (string | number | null)[] = []
  // Root-level Text/Image components, refreshed every bind.
  private _poolTexts: Text[][] = []
  private _poolImages: Image[][] = []
  // Resolved `.textFill` / `.mainPass` refs parallel to `_poolTexts` /
  // `_poolImages` so the fade tick writes through without re-crossing the bridge.
  private _poolTextFills: TextFill[][] = []
  private _poolImageMainPasses: Pass[][] = []
  // Per-slot subtree caches. Populated at spawn; refreshed only on
  // `invalidate(range, "structure")`.
  private _poolClippables: ClippableElement[][] = []
  private _poolClippableTransforms: Transform[][] = []
  private _poolClippableInteractables: Interactable[][] = []
  private _poolColliders: ColliderComponent[][] = []
  private _poolSubColliders: ColliderComponent[][] = []
  private _poolSubColliderTransforms: Transform[][] = []
  private _poolSubColliderProviders: ClipColliderProvider[][] = []
  private _poolSubColliderDirtyUnsubscribes: unsubscribe[][] = []
  // Baseline RGB packed as [r0,g0,b0,r1,g1,b1,…] so the fade tick avoids
  // reading `.color` / `.baseColor` through the bridge.
  private _poolTextRGB: number[][] = []
  private _poolImageRGB: number[][] = []
  // True iff the slot is in the visible window (not in the buffer).
  private _slotVisible: boolean[] = []
  // Seconds-since-lens-start when each slot last became unused.
  private _lastUsedTime: number[] = []
  private _lastShrinkTick: number = 0
  // Optimistic wake flag for shrink GC; the next shrink tick reconciles it
  // against ring, visibility, and per-type floor protections.
  private _hasPendingShrinkWork: boolean = false
  // Per-clippable band state, keyed by component instance so storage stays
  // private to VL and entries auto-reclaim with the slot SceneObject.
  private _clipBands: WeakMap<ClippableElement, ClipBand> = new WeakMap()
  private _subColliderClipStates: WeakMap<ColliderComponent, SubColliderClipState> = new WeakMap()
  private _subColliderProviders: WeakMap<ColliderComponent, ClipColliderProvider> = new WeakMap()

  // Long-tail prewarm queue drained across UpdateEvent frames.
  // _prewarmHead is the FIFO cursor (avoids O(n) Array.shift).
  private _prewarmQueue: string[] = []
  private _prewarmHead: number = 0
  private _prewarmComplete: boolean = true
  private _typePoolMinimums: Map<string, number> = new Map()

  // Scratch storage for tickShrinkGC compaction; length-clamped per tick.
  private _shrinkToDestroyScratch: number[] = []
  private _shrinkRemovedItemsScratch: FlexItem[] = []
  private _shrinkIndexMapScratch: number[] = []

  // Types that have triggered a once-per-session grow-on-miss warning.
  private _warnedGrowOnMissTypes: Set<string> | null = null

  // Data indices queued for deferred remeasure on the next LateUpdate.
  // Double-buffered: `drainPendingRemeasure` swaps buffers so a synchronous
  // re-add lands in the next frame without per-drain Set allocation.
  private _pendingRemeasure: Set<number> = new Set()
  private _pendingRemeasureSwap: Set<number> = new Set()

  // Scroll
  private _lastFirstVisibleDataIndex: number = -1
  private _isUpdatingData: boolean = false

  // Axis-neutral derived values in cm.
  private _viewportMain: number = 0
  private _totalContentSize: number = 0
  private _visibleSlots: number = 0
  private _containerCrossSize: number = 0
  // Conservative default stride for pool sizing and unresolved-size fallback.
  // Heterogeneous content positioning reads from _cumulativeSizes.
  private _stride: number = 0
  private _contentSizeChanged: boolean = false
  private _contentSizeNotificationsEnabled: boolean = false
  private _lastNotifiedContentSize: number = 0
  private _isVertical: boolean = true
  // How content underfilling the viewport sits along the main axis: "center"
  // centers it; "start"/"end" pin it to the near/far edge.
  private _contentAlign: "center" | "start" | "end" = "center"

  // Size/type metadata lives off-component to keep the already-large TS
  // component shape stable. Accessors below preserve compact call sites.
  // Lazy `getItemKey(i) → dataIndex` cache. Invalidated on any totalItems/order mutation.
  private _keyToIndex: Map<string | number, number> | null = null
  // During the initial-fill loop, `maybeMeasureSlot` writes `_sizes` but skips
  // the per-slot rebuild/apply/setDims ripple. `flushDeferredMeasures` applies
  // them in one pass after.
  private _deferMeasureSideEffects: boolean = false
  // Per-pool-slot type, set at creation; never changes for the slot's lifetime.
  private _slotTypes: string[] = []
  private _slotTypeCounts: Map<string, number> = new Map()

  // True between drag start and SCROLL_IDLE_TIMEOUT_MS after the last drag
  // tick. `notifyDataChanged` defers rebuilds via `_poolMetricsDirty` while set.
  private _isUserScrolling: boolean = false
  /** Only prepared snapshot publication may bypass the active-scroll mutation queue. */
  private _applyingPreparedSnapshot: boolean = false
  private _scrollIdleCounter: number = 0
  private _poolMetricsDirty: boolean = false
  // Set in `rebindRange` when per-tick grow cap exhausted; drained by
  // `tickDeferredGrowDrain` on idle.
  private _scrollDeferredGrowsPending: boolean = false
  // True while `tickDeferredGrowDrain` is inside `rebindRange` — selects the
  // `DRAIN_GROWS_PER_FRAME` cap instead of the full ringSize budget.
  private _drainingDeferredGrows: boolean = false
  // Re-entrancy guard for `applySnapshot` / `invalidate`.
  private _inMutation: boolean = false

  // Mutations issued while scrolling/binding; drain on idle or the next safe update.
  private _pendingSnapshot: boolean = false
  private _drainingPendingMutations: boolean = false
  private _preparedContentRanges: readonly {start: number; end: number}[] | null = null
  private _pendingInvalidate: {
    start: number
    end: number
    whole: boolean
    fields: InvalidateFlags
  } | null = null
  // While true, every slot's descendant colliders are forcibly disabled —
  // independent of `_slotVisible`. Re-armed on scroll idle.
  private _collidersForcedOff: boolean = false
  // Cached main-axis component of scroll position. Lets the LateUpdate clip
  // gate short-circuit without a bridge cross.
  private _lastScrollMain: number = 0
  // Pending `forceFlexLayout` + `updateSlotVisibilities` after a scroll-driven
  // rebindRange. Drained in LateUpdate, capping to one pass per frame.
  private _scrollLayoutDirty: boolean = false

  // Depth (not boolean): a binder may synchronously re-enter `fireBindItem`
  // via `invalidate` / `applySnapshot`.
  private _bindingDepth: number = 0

  // Lowest dataIndex whose `_sizes` cell was updated while
  // `_deferMeasureSideEffects` was true. `flushDeferredMeasures` rebuilds
  // cumulatives from here in one pass.
  private _pendingMeasureMinIdx: number = Number.MAX_SAFE_INTEGER
  // Anchor captured by `rebindRange` BEFORE its bind loop mutates `_sizes`, so
  // `flushDeferredMeasures` restores against pre-mutation geometry (capturing
  // inside flush would read new `_sizes` against old cumulatives).
  private _deferredMeasureAnchor: ViewportAnchor | null = null

  // Fade
  private _lastAlpha: number[] = []
  // Outer guard for `updateFade`: skip when scroll value and content size both
  // match the previous call. Invalidated to NaN on rebinds and fade-input changes.
  private _lastFadeScroll: number = NaN
  private _lastFadeContentSize: number = -1
  // Cached `updateFade` loop-invariants, recomputed by `recomputeFadeInvariants`.
  private _fadeHalfViewport: number = 0
  private _fadeZone: number = FADE_ZONE_MIN
  private _fadeMaxScroll: number = 0
  private _fadeLastDataIdx: number = -1
  // Outer guard for `clipVisibleInteractables`. Invalidated wherever
  // `_lastFadeScroll` is.
  private _lastClipScroll: number = NaN
  private _clipDirty: boolean = true
  private _subColliderClipDirty: boolean = true
  private _subColliderClipForceWriteProviders: Set<ClipColliderProvider> = new Set()
  // ScrollWindow inverse world transform, cached while its source world transform (_swWorld)
  // is unchanged; the inverse is invariant under scroll. See getScrollWindowInverted.
  private _swInverted: mat4 | null = null
  private _swWorld: mat4 | null = null

  // `_ringOrder[ringPosition] = pool slot index`. Ring position 0 is the topmost
  // visible slot. Boundary crosses shift positions; only the wrapping slot rebinds.
  private _ringOrder: number[] = []

  // rebindRange scratch buffers, sized via `ensureRebindScratch`.
  private _rebindInWindow: Map<number, number> = new Map()
  private _rebindUnusedByType: Map<string, number[]> = new Map()
  private _rebindNewRingOrder: number[] = []
  private _rebindOrderedItems: FlexItem[] = []
  // FlexItems created mid-loop via grow-on-miss. Added to FlexLayout after the loop.
  private _rebindGrownItems: FlexItem[] = []
  // Slots bound during the current mutation (or one ordinary scroll pass).
  // Survives anchor-driven rebinds so content and unkeyed refreshes deduplicate.
  private _rebindBoundThisPass: Set<number> = new Set()
  // Configuration can prewrite allocations before rebindRange sees the slots.
  private _retainedRefreshSlots: Set<number> = new Set()
  // Keyed reconciliation changes indices before rebindRange sees the slots.
  private _retainedIndexSlots: Set<number> = new Set()
  // Ring-membership set for O(1) spare-slot ordering; repopulated per pass.
  private _rebindRingSlots: Set<number> = new Set()

  // Per-frame scratch buffers. Callers MUST NOT retain — values are
  // overwritten in place on each use.
  private _offsetScratch: vec3 = new vec3(0, 0, 0)
  private _alphaScratch: vec4 = new vec4(0, 0, 0, 0)
  private _scrollPosScratch: vec2 = new vec2(0, 0)
  private _visibleRangeScratch: {first: number; last: number} = {first: 0, last: 0}
  private _scrollBoundsScratch: {scrollSize: number; topEdge: number; bottomEdge: number} = {
    scrollSize: 0,
    topEdge: 0,
    bottomEdge: 0
  }
  private _scrollTargetScratch: vec2 = new vec2(0, 0)
  private _clipSizeScratch: vec3 = new vec3(0, 0, 0)
  private _clipCenterScratch: vec3 = new vec3(0, 0, 0)
  private _subColliderAxisScratch: vec3 = new vec3(1, 0, 0)
  private _unusedListPool: number[][] = []
  // NaN sentinel: first write always goes through.
  private _lastAppliedOffset: number = NaN

  private _disposers: (() => void)[] = []
  // Lazily enabled/disabled when work appears.
  private _lateUpdateEvent: SceneEvent | null = null
  private _updateEvent: SceneEvent | null = null

  private _initialized: boolean = false
  // Terminal state, set in `cleanup`. Distinct from `_initialized` (also false
  // pre-init) so pre-init config writes don't trip `assertNotDestroyed`.
  private _destroyed: boolean = false

  // Pre-init `scrollToIndex` / `scrollToKey` queue. Applied during
  // `onLayoutInitialized`, overriding the `initialIndex` landing.
  private _pendingScroll: VirtualizedScrollOptionsBase | null = null
  private _pendingScrollIndex: number | "start" | "end" | null = null
  private _pendingScrollKey: string | number | null = null

  // Set when a center/end scrollToIndex snapped to an unmeasured row: the
  // alignment used the estimated size, so re-derive it once the real size lands.
  private _pendingAlignTarget: {index: number; align: "center" | "end"; offset: number} | null = null
  // Frames the pending correction has waited for its target to measure.
  private _alignWaitFrames: number = 0

  // ─── Adapter ───────────────────────────────────────────────────────

  private _adapter: VirtualizedAdapter<TViewHolder, TType> | null = null

  /**
   * Data + view-holder adapter. Assign before init. Call `applySnapshot()`
   * after post-init mutations; new-adapter assignment doesn't auto-refresh.
   */
  public get adapter(): VirtualizedAdapter<TViewHolder, TType> | null {
    return this._adapter
  }
  public set adapter(value: VirtualizedAdapter<TViewHolder, TType> | null) {
    this.assertNotDestroyed()
    this._adapter = value
  }

  // ─── Events / Callbacks ────────────────────────────────────────────

  private readonly onInitializedEvent = new ReplayEvent<void>()
  private _onInitialized?: PublicApi<void>
  public get onInitialized(): PublicApi<void> {
    return (this._onInitialized ??= this.onInitializedEvent.publicApi())
  }

  private _itemAlphaHandler:
    | ((slot: SceneObject, alpha: number, dataIndex: number, holder: TViewHolder | null) => void)
    | null = null

  /**
   * Single-owner alpha override. When set, the built-in fade pass is
   * bypassed and the handler receives `(slot, alpha, dataIndex, holder)`
   * once per visible slot per fade tick. Assign `null` to restore the built-in fade.
   */
  public get itemAlphaHandler():
    | ((slot: SceneObject, alpha: number, dataIndex: number, holder: TViewHolder | null) => void)
    | null {
    return this._itemAlphaHandler
  }
  public set itemAlphaHandler(
    handler: ((slot: SceneObject, alpha: number, dataIndex: number, holder: TViewHolder | null) => void) | null
  ) {
    this.assertNotDestroyed()
    this._itemAlphaHandler = handler
  }

  private readonly onScrollDragStartEvent = new Event<void>()
  private _onScrollDragStart?: PublicApi<void>
  /**
   * Fires once when the user begins a drag gesture.
   */
  public get onScrollDragStart(): PublicApi<void> {
    return (this._onScrollDragStart ??= this.onScrollDragStartEvent.publicApi())
  }

  private readonly onScrollDragEndEvent = new Event<void>()
  private _onScrollDragEnd?: PublicApi<void>
  /**
   * Fires once when scroll motion ends (drag released, spring settled, or
   * the SCROLL_IDLE_TIMEOUT_MS fallback elapses without further drag input).
   */
  public get onScrollDragEnd(): PublicApi<void> {
    return (this._onScrollDragEnd ??= this.onScrollDragEndEvent.publicApi())
  }

  private readonly onEndReachedEvent = new Event<void>()
  private _onEndReached?: PublicApi<void>
  /**
   * Fires when the viewport is within `edgeReachedThreshold` cm of the end of
   * the content. Once per crossing; re-arms after leaving the band. Fires once
   * at init if the viewport opens inside the band.
   */
  public get onEndReached(): PublicApi<void> {
    return (this._onEndReached ??= this.onEndReachedEvent.publicApi())
  }

  private readonly onStartReachedEvent = new Event<void>()
  private _onStartReached?: PublicApi<void>
  /**
   * Fires when the viewport is within `edgeReachedThreshold` cm of the start of
   * the content. Once per crossing; re-arms after leaving the band. Fires once
   * at init if the viewport opens inside the band (e.g. at index 0).
   */
  public get onStartReached(): PublicApi<void> {
    return (this._onStartReached ??= this.onStartReachedEvent.publicApi())
  }

  private readonly onContentSizeChangedEvent = new Event<number>()
  private _onContentSizeChanged?: PublicApi<number>
  /**
   * Fires when VL's total main-axis content size changes, not on scroll/window
   * slides. The payload is the new main-axis size in cm. Do not call
   * `applySnapshot`/`invalidate` synchronously from the handler.
   */
  public get onContentSizeChanged(): PublicApi<number> {
    return (this._onContentSizeChanged ??= this.onContentSizeChangedEvent.publicApi())
  }

  // ─── Public Getters / Setters ──────────────────────────────────────

  /**
   * Current scroll position in cm (both axes). `vec2(0, 0)` pre-init.
   */
  public get scrollPosition(): vec2 {
    if (!this._scrollWindow || isNull(this._scrollWindow)) return new vec2(0, 0)
    return this._scrollWindow.scrollPosition
  }

  /**
   * The owned ScrollWindow, for read-only consumers (drag/hover events).
   * `null` pre-init; do not mutate its dimensions or position - VL owns them.
   */
  public get scrollWindow(): ScrollWindow | null {
    if (this._scrollWindow === null || isNull(this._scrollWindow)) return null
    return this._scrollWindow
  }

  /**
   * Parent non-recycled decoration content into the scrollable/masked area.
   * It shares absolute content coordinates with rows, so do not offset it by
   * `layoutOffsetMain`; when `contentAlign` pins underfilled content, add
   * `contentAlignOffset` so the decoration tracks the rows.
   */
  public addBackgroundContent(object: SceneObject): void {
    this.assertNotDestroyed()
    if (!this._scrollWindow || isNull(this._scrollWindow) || isNull(object)) return
    this._scrollWindow.addObject(object)
  }

  /**
   * Scroller window size in cm, or `vec2(0, 0)` before init.
   */
  public get scrollerWindowSize(): vec2 {
    if (!this._scrollWindow || isNull(this._scrollWindow)) return new vec2(0, 0)
    return this._scrollWindow.windowSize
  }

  /**
   * Main-axis offset VL last applied to its windowed row layout, in cm.
   * Scroller-sibling decorations should not apply this windowing offset.
   */
  public get layoutOffsetMain(): number {
    return Number.isNaN(this._lastAppliedOffset) ? 0 : this._lastAppliedOffset
  }

  /**
   * Total scrollable content size in cm along the main scroll axis. Returns `0`
   * after `destroy()`.
   */
  public get contentSize(): number {
    return this._destroyed ? 0 : this._totalContentSize
  }

  /**
   * First/last visible data index, or `null` when nothing is visible.
   */
  public get visibleRange(): {first: number; last: number} | null {
    if (!this.computeVisibleRangeInto(this._visibleRangeScratch)) return null
    // Fresh object — internal scratch is reused.
    return {first: this._visibleRangeScratch.first, last: this._visibleRangeScratch.last}
  }

  /**
   * Data index the viewport opens at. Honored during the first
   * `onLayoutInitialized` pass. Clamped to `[0, totalItems-1]`. Defaults to 0.
   * Post-init, use `scrollToIndex({index, durationMs: 0})` instead.
   */
  public get initialIndex(): number {
    return this._initialIndex
  }

  public get viewportSize(): vec2 {
    return this._viewportSize
  }
  public set viewportSize(value: vec2) {
    this.assertNotDestroyed()
    if (!Number.isFinite(value.x) || !Number.isFinite(value.y) || value.x <= 0 || value.y <= 0) {
      log.w(`viewportSize must contain positive finite numbers; ignoring write of (${value.x}, ${value.y})`)
      return
    }
    if (this._viewportSize.x === value.x && this._viewportSize.y === value.y) return
    // Defensive copy: ScrollWindow.windowSize also stores by reference.
    const cloned = new vec2(value.x, value.y)
    this._viewportSize = cloned
    if (this._scrollWindow && !isNull(this._scrollWindow)) {
      this._scrollWindow.windowSize = cloned
    }
    if (!this._initialized) return
    if (!this.reapplyAxisConfig()) return
    this.notifyDataChanged()
  }

  public get itemSize(): number {
    return this._itemSize
  }
  public set itemSize(value: number) {
    this.assertNotDestroyed()
    if (value <= 0) {
      log.w(`itemSize must be > 0; ignoring write of ${value}`)
      return
    }
    if (this._itemSize === value) return
    this._itemSize = value
    if (!this._initialized) return
    this.rebuildSizes()
    if (!this.reapplyAxisConfig()) return
    this.notifyDataChanged()
  }

  public get bufferCount(): number {
    return this._bufferCount
  }
  public set bufferCount(value: number) {
    this.assertNotDestroyed()
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      log.w(`bufferCount must be a non-negative integer; ignoring write of ${value}`)
      return
    }
    if (this._bufferCount === value) return
    this._bufferCount = value
    if (this._initialized) this.notifyDataChanged()
  }

  public get scrollDirection(): ScrollDirection {
    return this._scrollDirection as ScrollDirection
  }
  public set scrollDirection(value: ScrollDirection) {
    this.assertNotDestroyed()
    // Enum is string-valued — TS won't catch arbitrary strings from JS call sites.
    if (!Object.values(ScrollDirection).includes(value)) {
      log.w(`scrollDirection: ignoring invalid value "${value}" (expected "vertical" or "horizontal")`)
      return
    }
    if (this._scrollDirection === value) return
    this._scrollDirection = value
    if (!this._initialized) return
    if (!this.reapplyAxisConfig()) return
    this.notifyDataChanged()
  }

  public get gap(): number {
    return this._gap
  }
  public set gap(value: number) {
    this.assertNotDestroyed()
    if (!Number.isFinite(value) || value < 0) {
      log.w(`gap must be a non-negative finite number; ignoring write of ${value}`)
      return
    }
    if (this._gap === value) return
    this._gap = value
    if (!this._initialized) return
    this._metadata.updateGap(value)
    if (!this.reapplyAxisConfig()) return
    this.notifyDataChanged()
  }

  public get contentAlign(): "center" | "start" | "end" {
    return this._contentAlign
  }
  public set contentAlign(value: "center" | "start" | "end") {
    this.assertNotDestroyed()
    if (this._contentAlign === value) return
    this._contentAlign = value
    if (!this._initialized) return
    this.notifyDataChanged()
  }

  /**
   * Main-axis shift applied when content underfills the viewport and
   * `contentAlign` pins it to an edge. Scroller-sibling decorations add this.
   */
  public get contentAlignOffset(): number {
    const slack = this._viewportMain - this._totalContentSize
    if (slack <= 0 || this._contentAlign === "center") return 0
    const startBias = this._contentAlign === "start" ? slack / 2 : -slack / 2
    return this._isVertical ? startBias : -startBias
  }

  /**
   * Number of data rows VL currently tracks (sourced from `adapter.itemCount()`).
   */
  public get totalItems(): number {
    return this._totalItems
  }

  public get fadeEnabled(): boolean {
    return this._fadeEnabled
  }
  public set fadeEnabled(value: boolean) {
    this.assertNotDestroyed()
    if (this._fadeEnabled === value) return
    this._fadeEnabled = value
    if (!this._initialized) return
    this._lastFadeScroll = NaN
    if (!value && this._itemAlphaHandler === null) {
      for (let i = 0; i < this._poolObjects.length; i++) {
        this.applyBuiltInAlpha(i, 1)
        this._lastAlpha[i] = 1
      }
    } else if (this._scrollWindow) {
      this.updateFade(this._scrollWindow.scrollPosition)
    }
  }

  public get fadeDistance(): number {
    return this._fadeDistance
  }
  public set fadeDistance(value: number) {
    this.assertNotDestroyed()
    // `Math.max(eps, NaN)` is NaN — reject up front so the alpha pass can't be corrupted.
    if (!Number.isFinite(value) || value < 0) {
      log.w(`fadeDistance must be a non-negative finite number; ignoring write of ${value}`)
      return
    }
    if (this._fadeDistance === value) return
    this._fadeDistance = value
    if (this._initialized && this._scrollWindow) {
      this.recomputeFadeInvariants()
      this._lastFadeScroll = NaN
      this.updateFade(this._scrollWindow.scrollPosition)
    }
  }

  /**
   * Distance in cm from the start/end of the content at which `onStartReached`
   * / `onEndReached` fire. `0` fires exactly at the edge.
   */
  public get edgeReachedThreshold(): number {
    return this._edgeReachedThreshold
  }
  public set edgeReachedThreshold(value: number) {
    this.assertNotDestroyed()
    if (!Number.isFinite(value) || value < 0) {
      log.w(`edgeReachedThreshold must be a non-negative finite number; ignoring write of ${value}`)
      return
    }
    if (this._edgeReachedThreshold === value) return
    this._edgeReachedThreshold = value
    if (this._initialized) this.requestLateUpdate()
  }

  public get poolSize(): number {
    return this._poolObjects.length
  }

  /**
   * Per-type pool slot counts, keyed by type, as a fresh Map.
   */
  public get poolSizesByType(): ReadonlyMap<string, number> {
    return new Map<string, number>(this._slotTypeCounts)
  }

  /**
   * Cumulative lifecycle diagnostics. Returned maps are fresh snapshots;
   * mutating them does not affect future reads.
   */
  public get debugStats(): VirtualizedLayoutDebugStats {
    return this._stats.snapshot(
      this._poolObjects.length,
      this._slotTypeCounts,
      this._totalItems,
      this._metadata.sizeMode,
      this._metadata.typedPooling
    )
  }

  /**
   * Opt in to the per-type debugStats breakdown (createCountByType,
   * recycleCountByType, growCountByType, shrinkCountByType). Off by default so
   * the scalar counters stay zero-cost on the recycle hot path. Enable before
   * binding to capture initial creates. Scalar counters are always recorded.
   */
  public get debugTypeBreakdownEnabled(): boolean {
    return this._stats.typeBreakdownEnabled
  }

  public set debugTypeBreakdownEnabled(value: boolean) {
    this._stats.typeBreakdownEnabled = value
  }

  public get isUserScrolling(): boolean {
    return this._isUserScrolling
  }

  /**
   * Lower bound on per-type pool size after shrink-GC. Setting to 2+ keeps
   * spare slots warm so a single off-screen-back-into-view recycle doesn't
   * fire `adapter.onCreateView` on the scroll hot path. Raising post-init
   * triggers a `prewarmTypePools` pass to top up below-floor types; lowering
   * makes more slots eligible for shrink-GC on the next tick.
   */
  public get minSlotsPerType(): number {
    return this._minSlotsPerType
  }
  public set minSlotsPerType(value: number) {
    this.assertNotDestroyed()
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      log.w(`minSlotsPerType must be a non-negative integer; ignoring write of ${value}`)
      return
    }
    if (this._minSlotsPerType === value) return
    const previous = this._minSlotsPerType
    this._minSlotsPerType = value
    if (!this._initialized) return
    if (value > previous) this.prewarmTypePools()
    this.refreshPendingShrinkWork()
  }

  /** Re-reads adapter per-type floors and tops up any missing typed slots. */
  public refreshTypePoolMinimums(): void {
    this.assertNotDestroyed()
    if (!this._initialized) return
    this.prewarmTypePools()
    this.refreshPendingShrinkWork()
  }

  /**
   * Per-frame budget for the long-tail typed-pool prewarm queue (rare row
   * types whose first occurrence sits past the discovery limit). `0` drains
   * the long-tail synchronously instead of yielding across frames. Visible
   * and buffer types are always allocated synchronously at init regardless
   * of this value. Post-init writes take effect on the next
   * `tickPrewarmQueue` call; in-flight queues are not re-evaluated.
   */
  public get prewarmBudgetMs(): number {
    return this._prewarmBudgetMs
  }
  public set prewarmBudgetMs(value: number) {
    this.assertNotDestroyed()
    if (!Number.isFinite(value) || value < 0) {
      log.w(`prewarmBudgetMs must be a non-negative finite number; ignoring write of ${value}`)
      return
    }
    if (this._prewarmBudgetMs === value) return
    this._prewarmBudgetMs = value
  }

  /**
   * Idle threshold (ms) before an unused pool slot becomes eligible for
   * shrink-GC. `0` disables shrink entirely — the pool only grows. Affects
   * the throttle threshold on the next `tickShrinkGC` call.
   */
  public get shrinkDelayMs(): number {
    return this._shrinkDelayMs
  }
  public set shrinkDelayMs(value: number) {
    this.assertNotDestroyed()
    if (!Number.isFinite(value) || value < 0) {
      log.w(`shrinkDelayMs must be a non-negative finite number; ignoring write of ${value}`)
      return
    }
    if (this._shrinkDelayMs === value) return
    this._shrinkDelayMs = value
    if (this._initialized) this.refreshPendingShrinkWork()
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  public onAwake(): void {
    // MUST precede VL's LateUpdate bind: registers ScrollWindow's LateUpdate first
    // so it settles scroll before VL's clip pass; reorder and scroll-idle leaks a hit-test.
    this.constructDependencies()

    if (this._layout) {
      const unsubLayoutInit = this._layout.onInitialized.add(() => this.onLayoutInitialized())
      this._disposers.push(unsubLayoutInit)
    }

    this.createEvent("OnDestroyEvent").bind(() => this.cleanup())
    this.createEvent("OnEnableEvent").bind(() => {
      if (!this._initialized) return
      // Re-enabling a cached VL subtree also re-enables Element colliders.
      this._lastClipScroll = NaN
      this.markClipDirty()
    })

    const update = this.createEvent("UpdateEvent")
    update.bind(() => {
      if (!this._initialized) return
      this.drainPendingMutations()
      if (!this._initialized) return
      // Prewarm first — a fresh spare may satisfy the drain's next grow.
      this.tickPrewarmQueue()
      this.tickDeferredGrowDrain()
      this.tickShrinkGC()
      if (this._updateEvent && this.isUpdateTickIdle()) this._updateEvent.enabled = false
    })
    // Lazily re-enabled via `requestUpdateTick` when UpdateEvent work appears.
    // LateUpdateEvent clip/collider work idles independently.
    update.enabled = false
    this._updateEvent = update

    // LateUpdate is the safe point to read world transforms — Lens Studio
    // propagates parent → child transforms at LateUpdate.
    const lateUpdate = this.createEvent("LateUpdateEvent")
    lateUpdate.bind(() => {
      if (!this._initialized) return
      // Drain queued scroll layout BEFORE clipVisibleInteractables so the
      // clip pass reads settled world transforms.
      if (this._scrollLayoutDirty && !this._collidersForcedOff) {
        this._scrollLayoutDirty = false
        this.forceFlexLayout()
        this.updateSlotVisibilities()
      }
      this.drainPendingRemeasure()
      this.applyPendingAlignCorrection()
      this.clipVisibleInteractables()
      this.detectEdgeReached()
      if (
        !this._scrollLayoutDirty &&
        this._pendingRemeasure.size === 0 &&
        this._pendingAlignTarget === null &&
        !this.hasPendingClipWork() &&
        this._lateUpdateEvent
      ) {
        this._lateUpdateEvent.enabled = false
      }
    })
    this._lateUpdateEvent = lateUpdate
  }

  private requestLateUpdate(): void {
    if (this._lateUpdateEvent && !this._lateUpdateEvent.enabled) {
      this._lateUpdateEvent.enabled = true
    }
  }

  private requestUpdateTick(): void {
    if (this._updateEvent && !this._updateEvent.enabled) {
      this._updateEvent.enabled = true
    }
  }

  private isUpdateTickIdle(): boolean {
    if (!this._isUserScrolling && (this._pendingSnapshot || this._pendingInvalidate !== null)) return false
    if (!this._prewarmComplete && this._prewarmHead < this._prewarmQueue.length) return false
    if (this._scrollDeferredGrowsPending) return false
    if (this._shrinkDelayMs > 0 && this._hasPendingShrinkWork) return false
    return true
  }

  private armShrinkWork(): void {
    if (this._shrinkDelayMs <= 0) return
    this._hasPendingShrinkWork = true
    this.requestUpdateTick()
  }

  private refreshPendingShrinkWork(requestTick: boolean = true, deferWhileScrolling: boolean = false): void {
    if (deferWhileScrolling && this._isUserScrolling) {
      if (requestTick && this._hasPendingShrinkWork) this.requestUpdateTick()
      return
    }
    if (this._shrinkDelayMs <= 0 || this._poolObjects.length === 0 || !this.hasUnboundPoolSlots()) {
      this._hasPendingShrinkWork = false
      return
    }
    const ringSlots = new Set<number>(this._ringOrder)
    const visibleTypes = this.collectVisibleTypesForShrink()
    const liveDataTypes = this.liveDataTypesForShrink()
    this._hasPendingShrinkWork = this.hasShrinkWorkPending(ringSlots, liveDataTypes, visibleTypes)
    if (requestTick && this._hasPendingShrinkWork) this.requestUpdateTick()
  }

  private hasUnboundPoolSlots(): boolean {
    for (let s = 0; s < this._poolObjects.length; s++) {
      if (this._dataIndices[s] < 0) return true
    }
    return false
  }

  private collectVisibleTypesForShrink(): Set<string> {
    const visibleTypes = new Set<string>()
    if (this.computeVisibleRangeInto(this._visibleRangeScratch)) {
      const vr = this._visibleRangeScratch
      for (let i = vr.first; i <= vr.last && i < this._totalItems; i++) {
        visibleTypes.add(this._metadata.typeAtIndex(i))
      }
    }
    return visibleTypes
  }

  private liveDataTypesForShrink(): ReadonlySet<string> | null {
    return this._metadata.typedPooling ? this._metadata.liveDataTypes : null
  }

  private isLiveDataTypeForShrink(type: string, liveDataTypes: ReadonlySet<string> | null): boolean {
    if (!this._metadata.typedPooling) return this._totalItems > 0 && type === VL_DEFAULT_TYPE
    return liveDataTypes !== null && liveDataTypes.has(type)
  }

  private hasShrinkWorkPending(
    ringSlots: ReadonlySet<number>,
    liveDataTypes: ReadonlySet<string> | null,
    visibleTypes: ReadonlySet<string>
  ): boolean {
    for (let s = 0; s < this._poolObjects.length; s++) {
      if (this._dataIndices[s] >= 0) continue
      const lastUsed = this._lastUsedTime[s]
      if (lastUsed < 0) continue
      const t = this._slotTypes[s] ?? VL_DEFAULT_TYPE
      const live = this.isLiveDataTypeForShrink(t, liveDataTypes)
      if (ringSlots.has(s) && live) continue
      if (visibleTypes.has(t)) continue
      if (live && this.slotTypeCount(t) <= this.slotTypeFloor(t)) continue
      return true
    }
    return false
  }

  private markClipDirty(): void {
    this._clipDirty = true
    this._subColliderClipDirty = true
    this.requestLateUpdate()
  }

  // Recompute the inverse only when the window's world transform changes (relayout or an
  // ancestor move); scroll moves the Scroller child, so a static panel computes it once.
  private getScrollWindowInverted(swTransform: Transform): mat4 {
    const world = swTransform.getWorldTransform()
    if (this._swInverted === null || this._swWorld === null || !this._swWorld.equal(world)) {
      this._swInverted = swTransform.getInvertedWorldTransform()
      this._swWorld = world
    }
    return this._swInverted
  }

  private markSubColliderClipDirty(provider?: ClipColliderProvider): void {
    if (this._destroyed) return
    this._subColliderClipDirty = true
    if (provider) this._subColliderClipForceWriteProviders.add(provider)
    this.requestLateUpdate()
  }

  private hasPendingClipWork(): boolean {
    return this._clipDirty || this._subColliderClipDirty || this._lastScrollMain !== this._lastClipScroll
  }

  private queueRemeasure(dataIndex: number): void {
    this._pendingRemeasure.add(dataIndex)
    this.requestLateUpdate()
  }

  private constructDependencies(): void {
    // Scene tree: VL SO > ScrollWindow SO > Scroller (created by ScrollWindow) > FlexLayout SO.
    const scrollObj = global.scene.createSceneObject("VL_ScrollWindow")
    scrollObj.setParent(this.sceneObject)
    scrollObj.layer = this.sceneObject.layer

    const scrollWindow = scrollObj.createComponent(ScrollWindow.getTypeName()) as ScrollWindow
    scrollWindow.windowSize = this._viewportSize
    // Suppresses only SW's boundary-driven collider enable/disable — VL owns that.
    // SW still fires triggerCanceled on slot interactables at drag-start (intended:
    // a scroll gesture shouldn't also tap a slot).
    scrollWindow.skipColliderManagement = true
    this._scrollWindow = scrollWindow
    this._scrollWindowTransform = scrollObj.getTransform()

    const layoutObj = global.scene.createSceneObject("VL_FlexLayout")
    layoutObj.setParent(scrollObj)
    layoutObj.layer = this.sceneObject.layer

    const layout = layoutObj.createComponent(FlexLayout.getTypeName()) as FlexLayout
    // Must be set BEFORE FlexLayout's OnStartEvent fires, or its start handler
    // replaces our addItems with discovered children.
    layout.autoDiscoverItemsOnStart = false
    this._layout = layout
    this._layoutTransform = layoutObj.getTransform()
  }

  // ─── Public Methods ────────────────────────────────────────────────

  private notifyDataChanged(): void {
    if (!this._initialized || !this._layout || !this._scrollWindow) return

    // Defer if applyDataChange is in flight (binder mutated totalItems) or the user is scrolling.
    if (this._isUpdatingData || this._isUserScrolling) {
      this._poolMetricsDirty = true
      return
    }

    this.applyDataChange()
  }

  /**
   * Scroll the viewport so the target row lands on screen. Pre-init calls
   * queue and apply during `onLayoutInitialized` (overriding `initialIndex`).
   * Throws only after `destroy()`.
   *
   * `index`: numeric row, or `"start"` / `"end"` sentinel.
   * `align`: `"start"` (default), `"center"`, or `"end"` — where the row
   *   sits inside the viewport.
   * `offset`: extra cm shift along the main axis on top of the alignment.
   * `durationMs`: tween duration. `0` jumps instantly. Default `200`.
   */
  public scrollToIndex(opts: VirtualizedScrollOptions): void {
    this.assertNotDestroyed()
    if (!this._initialized) {
      this._pendingScroll = opts
      this._pendingScrollIndex = opts.index
      this._pendingScrollKey = null
      return
    }
    this.doScrollToIndex(opts)
  }

  /**
   * Scroll to the row whose `adapter.getItemKey(i)` matches `key`. No-op if
   * the adapter doesn't define `getItemKey` or the key isn't found. Same
   * pre-init queueing as `scrollToIndex`.
   */
  public scrollToKey(key: string | number, opts?: VirtualizedScrollOptionsBase): void {
    this.assertNotDestroyed()
    if (!this._initialized) {
      this._pendingScroll = opts ?? {}
      this._pendingScrollIndex = null
      this._pendingScrollKey = key
      return
    }
    const resolved = this.resolveKeyToIndex(key)
    if (resolved < 0) return
    this.doScrollToIndex({...(opts ?? {}), index: resolved})
  }

  private resolveKeyToIndex(key: string | number): number {
    const getKey = this.adapter?.getItemKey?.bind(this.adapter)
    if (!getKey) return -1
    const map = this.ensureKeyToIndex(getKey)
    const idx = map.get(key)
    return idx === undefined ? -1 : idx
  }

  private ensureKeyToIndex(getKey: (i: number) => string | number): Map<string | number, number> {
    if (this._keyToIndex) return this._keyToIndex
    const map = this.buildKeyToIndexMap(getKey, this._totalItems)
    this._keyToIndex = map
    return map
  }

  /**
   * Walk `[0, count)` calling `getKey`, building a `key -> index` map. Throws
   * on the first duplicate key. The map is local and returned only on success,
   * so a throw leaves no half-built state.
   */
  private buildKeyToIndexMap(getKey: (i: number) => string | number, count: number): Map<string | number, number> {
    const map = new Map<string | number, number>()
    for (let i = 0; i < count; i++) {
      const k = getKey(i)
      if (map.has(k)) {
        throw new Error(
          `VirtualizedLayout: duplicate item key "${k}" at data indices ${map.get(k)} and ${i}; adapter.getItemKey must return a unique key per row`
        )
      }
      map.set(k, i)
    }
    return map
  }

  private doScrollToIndex(opts: VirtualizedScrollOptions): void {
    if (this._totalItems === 0) return
    if (this._itemSize <= 0) return
    if (!this._scrollWindow || this._totalContentSize <= 0) return

    // New request supersedes any in-flight alignment correction.
    this._pendingAlignTarget = null

    const resolved = this.resolveScrollIndex(opts.index)
    const align = opts.align ?? "start"
    const offset = opts.offset ?? 0
    const durationMs = opts.durationMs ?? 200

    // alignDelta = distance from item-near-edge to alignment anchor, in cm.
    // 0 = near edge, V-s = far edge. `offset` adds further along the same axis.
    const size = this.itemSizeForIndex(resolved)
    const alignDelta =
      align === "center" ? (this._viewportMain - size) / 2 : align === "end" ? this._viewportMain - size : 0

    const {topEdge, bottomEdge} = this.getScrollBounds()
    const top = this.topOfItem(resolved)
    const rawTarget = this._isVertical ? topEdge + top - alignDelta - offset : bottomEdge - top + alignDelta + offset
    const target = Math.max(topEdge, Math.min(rawTarget, bottomEdge))

    // Snap instantly when the target is past the resolved prefix — the
    // extrapolated offset can shift once those rows measure. Homogeneous
    // mode stays at the `-1` prefix sentinel, so guard explicitly.
    const targetUnresolved = this._metadata.sizeMode === "variable" && !this._metadata.hasResolvedSize(resolved)
    if (targetUnresolved || durationMs <= 0) {
      // center/end alignment used the estimated size; re-derive once `resolved`
      // measures (start has alignDelta 0, so it needs no correction).
      if (targetUnresolved && (align === "center" || align === "end")) {
        this._pendingAlignTarget = {index: resolved, align, offset}
        this._alignWaitFrames = 0
        this.requestLateUpdate()
      }
      this.setScrollPosition(target)
      return
    }
    const scratch = this._scrollTargetScratch
    if (this._isVertical) {
      scratch.x = 0
      scratch.y = target
    } else {
      scratch.x = target
      scratch.y = 0
    }
    this._scrollWindow.tweenTo(scratch, durationMs)
  }

  /**
   * Re-apply a center/end alignment once its target row's real size lands.
   * No-op until the row measures; cleared on a new scroll request or user drag.
   */
  private applyPendingAlignCorrection(): void {
    const pending = this._pendingAlignTarget
    if (pending === null || !this._scrollWindow) return
    const idx = pending.index
    if (idx >= this._totalItems) {
      this._pendingAlignTarget = null
      return
    }
    // Wait for the real size; alignDelta depends only on `idx`'s own size.
    // Bound the wait so an async row that never measures can't pin LateUpdate.
    if (!this._metadata.hasResolvedSize(idx)) {
      if (++this._alignWaitFrames >= ALIGN_CORRECTION_MAX_WAIT_FRAMES) this._pendingAlignTarget = null
      return
    }
    this._pendingAlignTarget = null

    const size = this.itemSizeForIndex(idx)
    const alignDelta = pending.align === "center" ? (this._viewportMain - size) / 2 : this._viewportMain - size
    const {topEdge, bottomEdge} = this.getScrollBounds()
    const top = this.topOfItem(idx)
    const rawTarget = this._isVertical
      ? topEdge + top - alignDelta - pending.offset
      : bottomEdge - top + alignDelta + pending.offset
    this.setScrollPosition(Math.max(topEdge, Math.min(rawTarget, bottomEdge)))
  }

  private resolveScrollIndex(index: number | "start" | "end"): number {
    if (index === "start") return 0
    if (index === "end") return Math.max(0, this._totalItems - 1)
    if (!Number.isFinite(index)) {
      log.w(`resolveScrollIndex: non-finite index ${index}; clamping to 0`)
      return 0
    }
    return Math.max(0, Math.min(Math.floor(index), this._totalItems - 1))
  }

  /**
   * Distinguishes three states for `sceneObject` lookups:
   *   - `{kind: "bound", index}` — pool slot, currently showing a data row.
   *   - `{kind: "unbound"}` — pool slot, past-end of data (no dataIndex).
   *   - `{kind: "notSlot"}` — `sceneObject` isn't a pool-slot root.
   */
  public dataIndexFor(sceneObject: SceneObject): DataIndexLookup {
    const slot = this._slotBySceneObject.get(sceneObject)
    if (slot === undefined) return {kind: "notSlot"}
    const idx = this._dataIndices[slot]
    return idx >= 0 ? {kind: "bound", index: idx} : {kind: "unbound"}
  }

  /**
   * Returns the currently mounted row root for `dataIndex`, or `null` when that
   * row is outside the active pool/window. The SceneObject remains owned by VL
   * and may be recycled on the next scroll or data mutation; do not retain it as
   * durable row identity.
   */
  public sceneObjectForDataIndex(dataIndex: number): SceneObject | null {
    if (!Number.isInteger(dataIndex) || dataIndex < 0 || dataIndex >= this._totalItems) return null
    for (let s = 0; s < this._dataIndices.length; s++) {
      if (this._dataIndices[s] === dataIndex) {
        const obj = this._poolObjects[s]
        return obj && !isNull(obj) ? obj : null
      }
    }
    return null
  }

  /**
   * Content-axis cm from content start to the top edge of `dataIndex`.
   * Uses the same cumulative/stride math VL lays slots out with, and
   * extrapolates for out-of-range indices.
   */
  public getItemTop(dataIndex: number): number {
    return this.topOfItem(dataIndex)
  }

  /**
   * Size VL lays out `dataIndex` at, in cm along the main axis. Falls back to
   * the configured item size for out-of-range indices.
   */
  public getItemSizeAt(dataIndex: number): number {
    return this.itemSizeForIndex(dataIndex)
  }

  private setTotalContentSize(size: number): void {
    if (this._totalContentSize === size) return
    this._totalContentSize = size
    this._contentSizeChanged = true
  }

  private notifyContentSizeChangedIfNeeded(): void {
    if (!this._contentSizeChanged) return
    if (!this._contentSizeNotificationsEnabled || !this._initialized || this._destroyed) return
    this._contentSizeChanged = false
    if (this._totalContentSize === this._lastNotifiedContentSize) return
    this._lastNotifiedContentSize = this._totalContentSize
    this.onContentSizeChangedEvent.invoke(this._totalContentSize)
  }

  private refreshAfterMutation(): void {
    if (!this._initialized || !this._scrollWindow) return
    this.setScrollDimensions(Math.max(this._totalContentSize, this._viewportMain))
    this.resizePool()
    if (this._poolObjects.length === 0) {
      this.notifyContentSizeChangedIfNeeded()
      return
    }
    const scroll = this.getScrollMainAxis(this._scrollWindow.scrollPosition)
    const firstVisible = this.computeFirstVisibleSlot(scroll)
    const startIndex = this.clampRebindStart(firstVisible - this._bufferCount)
    this.rebindRange(startIndex)
    if (!this._initialized || !this._scrollWindow) return
    this.updateLayoutOffset(startIndex)
    if (firstVisible !== this._lastFirstVisibleDataIndex) {
      this._lastFirstVisibleDataIndex = firstVisible
    }
    // Drain FlexLayout so post-reorder transforms are settled before
    // updateSlotVisibilities toggles colliders.
    this.forceFlexLayout()
    this.updateSlotVisibilities()
    this._lastFadeScroll = NaN
    this._lastClipScroll = NaN
    this.markClipDirty()
    this.updateFade(this._scrollWindow.scrollPosition)
    this.notifyContentSizeChangedIfNeeded()
  }

  /**
   * Publish a fully measured snapshot and refresh retained holder content during
   * free scrolling. The adapter must provide final item sizes before this call.
   * Call outside scroll event dispatch; optional alignment is applied instantly
   * in the same rebased coordinate frame. Ordinary mutations still defer.
   * contentRanges uses post-snapshot, half-open indices; omit to refresh all
   * content, or pass [] for index/size changes only. Already-bound rows are
   * refreshed at most once across the snapshot and these content ranges.
   * Returns false without publishing while a snapping window or active tween
   * owns a drag; retain the prepared snapshot and retry after the drag ends.
   */
  public applyPreparedSnapshot(
    alignment?: VirtualizedScrollOptions,
    contentRanges?: readonly {start: number; end: number}[]
  ): boolean {
    this.assertNotDestroyed()
    if (
      !this._initialized ||
      !this.adapter ||
      this._inMutation ||
      this._bindingDepth > 0 ||
      this._applyingPreparedSnapshot ||
      this._scrollWindow?.canRebaseScrollPosition === false
    )
      return false
    // Detach older work so callbacks cannot have their new requests consumed by
    // this publication. Restore it on failure; retire only covered work on success.
    const pendingSnapshot = this._pendingSnapshot
    const pendingInvalidate = this._pendingInvalidate
    this._pendingSnapshot = false
    this._pendingInvalidate = null
    let published = false
    this._applyingPreparedSnapshot = true
    this._preparedContentRanges = contentRanges ?? null
    try {
      if (!this.applySnapshot()) return false
      if (!this._initialized) return false
      this._inMutation = true
      try {
        if (contentRanges === undefined) {
          this.invalidateContent(0, this._totalItems, true)
        } else {
          for (let i = 0; i < contentRanges.length && this._initialized; i++) {
            const range = contentRanges[i]
            this.invalidateContent(Math.max(0, range.start), Math.min(this._totalItems, range.end), true)
          }
        }
      } finally {
        this._inMutation = false
      }
      if (!this._initialized) return false
      if (alignment) this.scrollToIndex({...alignment, durationMs: 0})
      published = true
      return true
    } finally {
      this._applyingPreparedSnapshot = false
      this._preparedContentRanges = null
      if (this._initialized) {
        if (!published) this._pendingSnapshot = this._pendingSnapshot || pendingSnapshot
        if (pendingInvalidate) {
          if (published) {
            pendingInvalidate.fields.size = false
            pendingInvalidate.fields.type = false
            // Old ranges refer to the old ordering. Preserve uncovered content
            // and subtree work conservatively across reorders/prepends.
            pendingInvalidate.whole = true
            pendingInvalidate.start = 0
            pendingInvalidate.end = this._totalItems
            if (contentRanges === undefined || this.contentRangesCoverAll(contentRanges)) {
              pendingInvalidate.fields.content = false
            }
          }
          const flags = pendingInvalidate.fields
          if (flags.content || flags.size || flags.type || flags.structure) {
            this.queueInvalidate(pendingInvalidate)
          }
        }
        if (this._pendingSnapshot || this._pendingInvalidate !== null) this.requestUpdateTick()
      }
    }
  }

  private contentRangesCoverAll(ranges: readonly {start: number; end: number}[]): boolean {
    let covered = 0
    while (covered < this._totalItems) {
      let end = covered
      for (let i = 0; i < ranges.length; i++) {
        if (ranges[i].start <= covered && ranges[i].end > end) end = ranges[i].end
      }
      if (end === covered) return false
      covered = end
    }
    return true
  }

  /**
   * Re-read `adapter.itemCount()` and diff against the current view. With
   * `getItemKey`, a surviving key keeps its slot + holder. A changed data
   * index uses onIndexChanged when available; an allocated-size change always
   * rebinds. Content-only edits require explicit invalidation. Without keys, every bound slot
   * is rebound by index.
   * Use for sort / filter / reshuffle. Throws on a duplicate `getItemKey`.
   * Returns `false` for no-ops (pre-init, no adapter, nested reentry).
   */
  public applySnapshot(): boolean {
    this.assertNotDestroyed()
    if (!this._initialized || !this.adapter) return false
    if (this._inMutation) {
      log.w("VirtualizedLayout.applySnapshot: nested mutation from inside a VL callback is unsupported; ignored")
      return false
    }
    if ((this._isUserScrolling && !this._applyingPreparedSnapshot) || this._bindingDepth > 0) {
      this._pendingSnapshot = true
      this.requestUpdateTick()
      return true
    }
    // Reorder/filter changes which row an index points to — drop a stale
    // alignment correction so it can't snap to the wrong row.
    this._pendingAlignTarget = null
    this.rearmEdgeReached()
    this._rebindBoundThisPass.clear()
    this._inMutation = true
    try {
      const newCount = this.adapter.itemCount()
      const getKey = this.adapter.getItemKey?.bind(this.adapter)
      if (!getKey) {
        this.applySnapshotUnkeyed(newCount)
        return true
      }
      this.applySnapshotKeyed(newCount, getKey)
      return true
    } finally {
      this._inMutation = false
      this._retainedRefreshSlots.clear()
      this._retainedIndexSlots.clear()
    }
  }

  /**
   * Invalidate cached state for `[range.start, range.end)` (defaults to whole data).
   * `fields`:
   *   - `"content"`: re-fire `adapter.onBindView`.
   *   - `"size"`: re-resolve sizes + types, rebuild cumulatives.
   *   - `"type"`: re-resolve types only.
   *   - `"structure"`: re-walk subtree component caches (binder added/removed components).
   *   - `"all"` (default): size + structure + content.
   *   - `{content, size, type, structure}`: invalidate exactly the set flags; e.g.
   *     `{content: true, size: true}` skips structure. No flags set is a no-op.
   */
  public invalidate(
    range?: {start: number; end: number},
    fields: InvalidateFields | InvalidateOptions = "all"
  ): boolean {
    this.assertNotDestroyed()
    if (!this._initialized) return false
    if (this._inMutation) {
      log.w("VirtualizedLayout.invalidate: nested mutation from inside a VL callback is unsupported; ignored")
      return false
    }
    const start = range ? Math.max(0, Math.floor(range.start)) : 0
    const end = range ? Math.min(this._totalItems, Math.floor(range.end)) : this._totalItems
    if (start >= end) {
      // `range.end` is exclusive. Warn on the common inclusive-end foot-gun.
      if (range) {
        log.w(
          `VirtualizedLayout.invalidate: range.end (${range.end}) <= range.start (${range.start}); end is exclusive, no rows refreshed`
        )
      }
      return false
    }

    const flags = this.resolveInvalidateFlags(fields)
    if (!flags.content && !flags.size && !flags.type && !flags.structure) {
      log.w("VirtualizedLayout.invalidate: options object set no fields; nothing to invalidate")
      return false
    }
    if ((this._isUserScrolling && !this._applyingPreparedSnapshot) || this._bindingDepth > 0) {
      this.queueInvalidate({start, end, whole: !range, fields: flags})
      return true
    }

    this._rebindBoundThisPass.clear()
    this._inMutation = true
    try {
      // Pick up post-init adapter shape changes (consumer added/removed
      // `getItemType` / `getItemSize`) so downstream paths see consistent state.
      const shapeChanged = this.reconcileAdapterShape()
      if (flags.size) {
        // `shapeChanged` means rebuildSizes already covered the whole range.
        if (!shapeChanged) this.invalidateSizes(start, end)
      } else if (flags.type) {
        // Type-only path; `size` already re-resolves types, so this is the else.
        // `shapeChanged` already rebuilt + refreshed via reconcileAdapterShape.
        if (this._metadata.typedPooling && !shapeChanged) {
          this.invalidateTypes(start, end)
          // Recycle in-window slots whose type no longer matches their row —
          // rebindRange's type check handles the swap.
          this.refreshAfterMutation()
        }
      }
      if (flags.structure) {
        this.invalidateStructure(start, end)
      }
      if (flags.content) {
        this.invalidateContent(start, end, true)
      }
    } finally {
      this._inMutation = false
    }
    if (this._pendingInvalidate !== null) this.requestUpdateTick()
    return true
  }

  private queueInvalidate(pending: {start: number; end: number; whole: boolean; fields: InvalidateFlags}): void {
    const p = this._pendingInvalidate
    if (p === null) this._pendingInvalidate = pending
    else {
      p.whole = p.whole || pending.whole
      p.start = Math.min(p.start, pending.start)
      p.end = Math.max(p.end, pending.end)
      p.fields.content = p.fields.content || pending.fields.content
      p.fields.size = p.fields.size || pending.fields.size
      p.fields.type = p.fields.type || pending.fields.type
      p.fields.structure = p.fields.structure || pending.fields.structure
    }
    this.requestUpdateTick()
  }

  /** One detached batch per safe point; callbacks leave fresh work for a later tick. */
  private drainPendingMutations(): void {
    if (
      !this._initialized ||
      this._isUserScrolling ||
      this._bindingDepth > 0 ||
      this._inMutation ||
      this._isUpdatingData ||
      this._applyingPreparedSnapshot ||
      this._drainingPendingMutations
    )
      return
    const snapshot = this._pendingSnapshot
    const invalidation = this._pendingInvalidate
    this._pendingSnapshot = false
    this._pendingInvalidate = null
    this._drainingPendingMutations = true
    try {
      if (snapshot) this.applySnapshot()
      if (this._initialized && invalidation) {
        this.invalidate(
          invalidation.whole ? undefined : {start: invalidation.start, end: invalidation.end},
          invalidation.fields
        )
      }
    } finally {
      this._drainingPendingMutations = false
    }
  }

  /**
   * Invalidate a single row `index`. Thin wrapper over `invalidate` with the
   * half-open range `[index, index + 1)`.
   */
  public invalidateItem(index: number, fields: InvalidateFields | InvalidateOptions = "all"): boolean {
    return this.invalidate({start: index, end: index + 1}, fields)
  }

  /**
   * Invalidate the half-open row range `[start, end)`. Thin wrapper over
   * `invalidate`.
   */
  public invalidateRange(start: number, end: number, fields: InvalidateFields | InvalidateOptions = "all"): boolean {
    return this.invalidate({start, end}, fields)
  }

  // Normalize `fields` (string or options object) to a full flag set; an
  // options object maps to exactly its set flags (no implicit all-true).
  private resolveInvalidateFlags(fields: InvalidateFields | InvalidateOptions): InvalidateFlags {
    if (typeof fields === "string") {
      if (fields === "all") return {content: true, size: true, type: true, structure: true}
      return {
        content: fields === "content",
        size: fields === "size",
        type: fields === "type",
        structure: fields === "structure"
      }
    }
    return {
      content: fields.content ?? false,
      size: fields.size ?? false,
      type: fields.type ?? false,
      structure: fields.structure ?? false
    }
  }

  /**
   * Re-derive size mode and typed-pooling mode from the current adapter. If
   * either flipped, rebuild metadata and downstream invariants.
   */
  private reconcileAdapterShape(): boolean {
    if (this._metadata.matchesAdapterShape(this.adapter)) return false
    // Bracket the content-size flip so the visible row holds position.
    const anchor = this.captureAnchor()
    this.rebuildSizes()
    this.setTotalContentSize(this.computeTotalContentSize(this._totalItems))
    this.recomputeFadeInvariants()
    this.restoreAnchor(anchor)
    this.refreshAfterMutation()
    return true
  }

  private rebindAllSlots(): void {
    if (this._poolObjects.length === 0) return
    // Ring rotates after scroll — each slot's actual binding is in _dataIndices.
    // Skip slots the immediately-preceding rebindRange already bound this pass
    // so a recycled slot isn't bound twice.
    for (let i = 0; i < this._poolObjects.length; i++) {
      if (this._rebindBoundThisPass.has(i)) continue
      const dataIndex = this._dataIndices[i]
      if (dataIndex >= 0 && dataIndex < this._totalItems) {
        this.fireBindItem(i, dataIndex)
        if (!this._initialized) return
        this._rebindBoundThisPass.add(i)
        this._lastAlpha[i] = -1
      }
    }
    this._lastFadeScroll = NaN
    if (this._scrollWindow) this.updateFade(this._scrollWindow.scrollPosition)
  }

  private applySnapshotUnkeyed(newCount: number): void {
    const anchor = this.captureAnchor()
    this._totalItems = newCount
    this._keyToIndex = null
    this.rebuildSizes()
    this.setTotalContentSize(this.computeTotalContentSize(this._totalItems))
    this.recomputeFadeInvariants()
    // Clamp dataIndices to the new range before refresh.
    for (let s = 0; s < this._dataIndices.length; s++) {
      if (this._dataIndices[s] >= newCount) {
        const oldDi = this._dataIndices[s]
        this._dataIndices[s] = -1
        this.fireUnbindItem(s, oldDi)
        this.parkSlot(s)
      }
    }
    this.restoreAnchor(anchor)
    this.refreshAfterMutation()
    this.rebindAllSlots()
  }

  private applySnapshotKeyed(newCount: number, getKey: (i: number) => string | number): void {
    const anchor = this.captureAnchor()
    this._totalItems = newCount
    this.rebuildSizes()
    this.setTotalContentSize(this.computeTotalContentSize(this._totalItems))
    this.recomputeFadeInvariants()

    // Detect-before-mutate: build the full map first (the only getKey walk) so
    // a duplicate throws before any _dataIndices redirect (no half-reconcile).
    const keyToIndex = this.buildKeyToIndexMap(getKey, newCount)
    this._keyToIndex = keyToIndex

    // Remap the anchor to its row's new index so the reconcile window and the
    // restore agree; absent key (deleted row) keeps the clamped raw idx.
    let restoreTarget = anchor
    if (anchor && anchor.key !== null) {
      const remapped = keyToIndex.get(anchor.key)
      if (remapped !== undefined) {
        restoreTarget = {idx: remapped, frac: anchor.frac, key: anchor.key, overscroll: anchor.overscroll}
      }
    }

    // Reconcile off the prebuilt map (no getKey calls): matching keys redirect
    // their slot to the new dataIndex; leftover bound slots are unbound.
    const slotKeyToSlot = new Map<string | number, number>()
    const slotsToUnbind: number[] = []
    for (let s = 0; s < this._poolObjects.length; s++) {
      const oldKey = this._slotKeys[s]
      if (oldKey !== null) slotKeyToSlot.set(oldKey, s)
      else if (this._dataIndices[s] >= 0) slotsToUnbind.push(s)
    }
    const ringSize = this.computeRingSize()
    let startIndex = 0
    if (this._initialized && this._scrollWindow) {
      // Window around where the viewport actually settles (remapped anchor's
      // clamped scroll), so surviving rows near an edge keep their slots.
      const firstVisible = restoreTarget
        ? this.computeFirstVisibleSlot(this.anchorScrollValue(restoreTarget))
        : this.computeFirstVisibleSlot(this.getScrollMainAxis(this._scrollWindow.scrollPosition))
      startIndex = this.clampRebindStart(firstVisible - this._bufferCount)
    }

    for (const [k, i] of keyToIndex) {
      if (slotKeyToSlot.size === 0) break
      const slot = slotKeyToSlot.get(k)
      if (slot !== undefined) {
        const typeMatches = (this._slotTypes[slot] ?? VL_DEFAULT_TYPE) === this._metadata.typeAtIndex(i)
        const inRing = i >= startIndex && i < startIndex + ringSize
        if (typeMatches && inRing) {
          if (this._dataIndices[slot] !== i) this._retainedIndexSlots.add(slot)
          this._dataIndices[slot] = i
          slotKeyToSlot.delete(k)
        }
      }
    }
    // Unbind slots the reconcile didn't preserve: unmatched keys, plus null-key
    // bound slots (e.g. after an unkeyed snapshot) that can't be identity-matched.
    for (const slot of slotKeyToSlot.values()) slotsToUnbind.push(slot)
    for (const slot of slotsToUnbind) {
      const oldDi = this._dataIndices[slot]
      if (oldDi >= 0) {
        this._dataIndices[slot] = -1
        this.fireUnbindItem(slot, oldDi)
        this.parkSlot(slot)
      }
    }

    this.restoreAnchor(restoreTarget)
    this.refreshAfterMutation()
  }

  private invalidateSizes(start: number, end: number): void {
    const anchor = this.captureAnchor()
    this._metadata.invalidateSizes(start, end, this.adapter, this._itemSize, this._gap)
    this.recomputeStrideFromMetadata()
    if (this._metadata.sizeMode === "variable") {
      for (let i = start; i < end; i++) {
        // Handlers whose `measure` reads post-reflow transforms get a LateUpdate retry.
        if (this._metadata.needsMeasureAt(i)) this.queueRemeasure(i)
      }
    }
    this.setTotalContentSize(this.computeTotalContentSize(this._totalItems))
    this.recomputeFadeInvariants()
    // rebindRange compares the previous allocation before applying the new
    // size, then refreshes size-dependent holder content once.
    this.restoreAnchor(anchor)
    this.refreshAfterMutation()
  }

  private invalidateTypes(start: number, end: number): void {
    this._metadata.invalidateTypes(start, end, this.adapter)
  }

  private invalidateStructure(start: number, end: number): void {
    let touched = false
    for (let s = 0; s < this._dataIndices.length; s++) {
      const di = this._dataIndices[s]
      if (di >= start && di < end) {
        this.refreshSlotSubtreeComponents(s)
        touched = true
      }
    }
    if (touched) this.markClipDirty()
  }

  private invalidateContent(start: number, end: number, skipAlreadyBound: boolean = false): void {
    let touched = false
    for (let s = 0; s < this._dataIndices.length; s++) {
      const di = this._dataIndices[s]
      if (di >= start && di < end && (!skipAlreadyBound || !this._rebindBoundThisPass.has(s))) {
        this.fireBindItem(s, di)
        if (!this._initialized) return
        if (skipAlreadyBound) this._rebindBoundThisPass.add(s)
        this._lastAlpha[s] = -1
        touched = true
      }
    }
    if (touched) {
      this._lastFadeScroll = NaN
      if (this._scrollWindow) this.updateFade(this._scrollWindow.scrollPosition)
    }
  }

  /**
   * Compute the current visible-row range into a caller-owned buffer. Returns
   * `false` when nothing is visible; `true` writes `out.first` / `out.last`.
   */
  private computeVisibleRangeInto(out: {first: number; last: number}): boolean {
    if (this._poolObjects.length === 0 || this._lastFirstVisibleDataIndex < 0) return false
    const first = this._lastFirstVisibleDataIndex
    // Include the intra-item offset so partial-bottom slots aren't excluded
    // when scroll sits mid-item.
    const intraOffset = this.computeIntraItemOffset(first)
    const target = this._viewportMain + intraOffset
    const metadata = this._metadata
    const resolvedLimit = Math.min(metadata.resolvedPrefixEnd, this._totalItems - 1)
    if (resolvedLimit >= first) {
      const sizes = metadata.sizes
      let running = 0
      for (let i = first; i <= resolvedLimit; i++) {
        running += sizes[i]
        if (running >= target) {
          out.first = first
          out.last = i
          return true
        }
        running += this._gap
      }
      if (resolvedLimit === this._totalItems - 1) {
        out.first = first
        out.last = this._totalItems - 1
        return true
      }
    }
    out.first = first
    // `+1` covers the partial-bottom slot when scroll is mid-item.
    const extra = intraOffset > 0 ? 1 : 0
    out.last = Math.min(first + this._visibleSlots - 1 + extra, this._totalItems - 1)
    return true
  }

  /**
   * Distance from the top of item `first` to the viewport top edge, in cm.
   * Positive when item `first` is partially hidden at the top.
   */
  private computeIntraItemOffset(first: number): number {
    if (!this._scrollWindow) return 0
    const {topEdge, bottomEdge} = this.getScrollBounds()
    const distFromStart = this._isVertical ? this._lastScrollMain - topEdge : bottomEdge - this._lastScrollMain
    return Math.max(0, distFromStart - this.topOfItem(first))
  }

  // Re-arm both edge callbacks. Data mutation can leave the viewport inside a
  // threshold band, where `detectEdgeReached` never re-arms on its own.
  private rearmEdgeReached(): void {
    this._endReachedArmed = true
    this._startReachedArmed = true
  }

  /**
   * Fire `onStartReached` / `onEndReached` once per crossing when the viewport
   * is within `edgeReachedThreshold` cm of the content edge.
   */
  private detectEdgeReached(): void {
    if (this._totalItems === 0 || !this._scrollWindow) return
    if (!this.computeVisibleRangeInto(this._visibleRangeScratch)) return
    const {topEdge, bottomEdge} = this.getScrollBounds()
    const distFromStart = this._isVertical ? this._lastScrollMain - topEdge : bottomEdge - this._lastScrollMain
    const distFromEnd = bottomEdge - topEdge - distFromStart
    const threshold = this._edgeReachedThreshold

    if (distFromStart <= threshold) {
      if (this._startReachedArmed) {
        this._startReachedArmed = false
        this.onStartReachedEvent.invoke()
        if (!this._initialized) return
      }
    } else {
      this._startReachedArmed = true
    }

    if (distFromEnd <= threshold) {
      if (this._endReachedArmed) {
        this._endReachedArmed = false
        this.onEndReachedEvent.invoke()
        if (!this._initialized) return
      }
    } else {
      this._endReachedArmed = true
    }
  }

  // ─── Private: Initialization ───────────────────────────────────────

  private onLayoutInitialized(): void {
    if (this._initialized) return
    if (!this._layout || !this._scrollWindow) return

    if (!this.reapplyAxisConfig()) return

    if (this.adapter) this._totalItems = this.adapter.itemCount()

    this.rebuildSizes()
    this.setTotalContentSize(this.computeTotalContentSize(this.totalItems))
    this.recomputeFadeInvariants()

    const calculatedPoolSize = this._visibleSlots + 2 * this._bufferCount
    // Clamp to 0 — `new Array(size)` throws on a negative.
    const actualPoolSize = Math.max(
      0,
      this._poolSizeOverride !== null
        ? Math.min(this._poolSizeOverride, this.totalItems)
        : Math.min(calculatedPoolSize, this.totalItems)
    )

    this.setScrollDimensions(this.getScrollBounds().scrollSize)

    if (actualPoolSize > 0) {
      // Compute startIndex BEFORE the pre-create loop so each slot is typed
      // for the dataIndex it will be bound to.
      const initialFirstVisible = this.clampedInitialIndex()
      const initialStartIndex = clampVirtualizedWindowStart(
        initialFirstVisible - this._bufferCount,
        this.totalItems,
        actualPoolSize
      )

      for (let i = 0; i < actualPoolSize; i++) {
        const initialIdxForSlot = initialStartIndex + i
        const t = initialIdxForSlot < this._totalItems ? this._metadata.typeAtIndex(initialIdxForSlot) : VL_DEFAULT_TYPE
        this.createPoolItem(t)
      }

      this._layout.addItems(this._poolItems)
      this.ensureRebindScratch(actualPoolSize)

      // Initial ring order = identity. Defer measure side effects across the
      // bind loop; `flushDeferredMeasures` applies them in one pass after.
      this._deferMeasureSideEffects = true
      this._ringOrder.length = actualPoolSize
      for (let i = 0; i < actualPoolSize; i++) {
        this._ringOrder[i] = i
        const dataIndex = initialStartIndex + i
        if (dataIndex < this.totalItems) {
          // Write `_dataIndices[i]` before the callback so synchronous
          // re-entries see consistent state.
          this._dataIndices[i] = dataIndex
          this.applyItemSizeToSlot(i, this.itemSizeForIndex(dataIndex))
          this.fireBindItem(i, dataIndex)
          // Mid-callback destroy guard: `_initialized` is still false at this
          // point, so sentinel on the owned dependency.
          if (this._scrollWindow === null) return
        } else {
          // Past end of data — hide so the SceneObject doesn't render as a ghost row.
          this.parkSlot(i)
        }
      }
      this._deferMeasureSideEffects = false
      this.flushDeferredMeasures()

      // Apply `initialIndex` AFTER measurements so the math reflects the final content size.
      const {topEdge, bottomEdge} = this.getScrollBounds()
      const topOfTarget = this.topOfItem(initialFirstVisible)
      const initialScrollVal = this._isVertical ? topEdge + topOfTarget : bottomEdge - topOfTarget
      this.setScrollPosition(initialScrollVal)

      this.updateLayoutOffset(initialStartIndex)
      this._lastFirstVisibleDataIndex = initialFirstVisible
      // Drain FlexLayout's initial pass so updateSlotVisibilities reads settled transforms.
      this.forceFlexLayout()
      this.updateSlotVisibilities()
      this.updateFade(this._scrollWindow.scrollPosition)

      this.prewarmTypePools()
    }

    const unsubScrollPos = this._scrollWindow.onScrollPositionUpdated.add((position: vec2) => {
      this.onScrollPositionUpdated(position)
    })
    const unsubScrollDrag = this._scrollWindow.onScrollDrag.add(() => {
      this.onScrollDragActivity()
    })
    // Authoritative "fully settled" signal — drops to idle immediately
    // instead of waiting on the SCROLL_IDLE_TIMEOUT_MS fallback.
    const unsubScrollEnd = this._scrollWindow.onScrollEnd.add(() => {
      this.onScrollSettled()
    })
    this._disposers.push(unsubScrollPos, unsubScrollDrag, unsubScrollEnd)

    this._initialized = true
    this.refreshPendingShrinkWork()

    // Apply pending pre-init `scrollToIndex` / `scrollToKey`, overriding `initialIndex`.
    if (this._pendingScroll) {
      const pending = this._pendingScroll
      const pendingKey = this._pendingScrollKey
      const pendingIndex = this._pendingScrollIndex
      this._pendingScroll = null
      this._pendingScrollKey = null
      this._pendingScrollIndex = null
      if (pendingKey !== null) {
        const resolved = this.resolveKeyToIndex(pendingKey)
        if (resolved >= 0) this.doScrollToIndex({...pending, index: resolved})
      } else if (pendingIndex !== null) {
        this.doScrollToIndex({...pending, index: pendingIndex})
      }
    }

    this.onInitializedEvent.invoke()
    if (this._destroyed) return
    this._contentSizeNotificationsEnabled = true
    this.notifyContentSizeChangedIfNeeded()
  }

  /**
   * Recompute axis-derived state and resync every pool item's overrides. On
   * axis flip, scroll position and axis-bound caches are reset. Returns
   * `false` on invalid stride.
   */
  private reapplyAxisConfig(): boolean {
    if (!this._layout || !this._scrollWindow) return false

    const wasVertical = this._isVertical
    this._isVertical = this._scrollDirection !== ScrollDirection.Horizontal
    const axisFlipped = this._initialized && wasVertical !== this._isVertical

    const crossSize = this._isVertical ? this._viewportSize.x : this._viewportSize.y
    this._viewportMain = this._isVertical ? this._viewportSize.y : this._viewportSize.x

    if (this._isVertical) {
      if (this._layout.direction !== FlexDirection.Column) {
        this._layout.direction = FlexDirection.Column
      }
      if (this._layout.verticalAlignment !== FlexContentVerticalAlignment.Top) {
        this._layout.verticalAlignment = FlexContentVerticalAlignment.Top
      }
      // Cross-axis alignment MUST be reset — stale edge alignment from a
      // prior axis shifts items and half-clips them.
      if (this._layout.horizontalAlignment !== FlexContentHorizontalAlignment.Center) {
        this._layout.horizontalAlignment = FlexContentHorizontalAlignment.Center
      }
      // Main axis grows from content (-1); cross axis is fixed at viewport.
      if (this._layout.width !== crossSize) this._layout.width = crossSize
      if (this._layout.height !== -1) this._layout.height = -1
      this._layout.rowGap = this._gap
    } else {
      if (this._layout.direction !== FlexDirection.Row) {
        this._layout.direction = FlexDirection.Row
      }
      if (this._layout.horizontalAlignment !== FlexContentHorizontalAlignment.Left) {
        this._layout.horizontalAlignment = FlexContentHorizontalAlignment.Left
      }
      if (this._layout.verticalAlignment !== FlexContentVerticalAlignment.Center) {
        this._layout.verticalAlignment = FlexContentVerticalAlignment.Center
      }
      if (this._layout.height !== crossSize) this._layout.height = crossSize
      if (this._layout.width !== -1) this._layout.width = -1
      this._layout.columnGap = this._gap
    }
    this._containerCrossSize = crossSize
    this._fadeHalfViewport = this._viewportMain / 2

    this._scrollWindow.vertical = this._isVertical
    this._scrollWindow.horizontal = !this._isVertical

    this.recomputeStrideFromMetadata()
    if (this._stride <= 0) {
      log.e("itemSize + gap must be positive")
      return false
    }

    for (let i = 0; i < this._poolItems.length; i++) {
      const di = this._dataIndices[i]
      const size = di >= 0 ? this.itemSizeForIndex(di) : 0
      if (this.applyItemSizeToSlot(i, size) && di >= 0) this._retainedRefreshSlots.add(i)
    }

    if (axisFlipped) {
      // Programmatic writes land on gesture-disabled axes (axis flags gate
      // input, not the API), and (0,0) in the top-left frame is content start
      // on both axes — the correct post-flip reset.
      this._scrollWindow.scrollPosition = new vec2(0, 0)

      this._lastFirstVisibleDataIndex = -1
      for (let i = 0; i < this._lastAlpha.length; i++) {
        this._lastAlpha[i] = -1
      }
      this._offsetScratch.x = 0
      this._offsetScratch.y = 0
      this._offsetScratch.z = 0
      this._lastAppliedOffset = NaN
      this._lastFadeScroll = NaN
      this._lastClipScroll = NaN
      this.markClipDirty()
      // Drop axis-bound deferred work — measured values are axis-specific.
      this._pendingRemeasure.clear()
      this._pendingRemeasureSwap.clear()
      this._pendingMeasureMinIdx = Number.MAX_SAFE_INTEGER
      this._deferredMeasureAnchor = null
      this._prewarmQueue.length = 0
      this._prewarmHead = 0
      this._prewarmComplete = true
    }

    this.recomputeFadeInvariants()
    return true
  }

  private recomputeFadeInvariants(): void {
    this._fadeHalfViewport = this._viewportMain / 2
    // Clamp to a small positive epsilon — 0 produces 0/0 = NaN at the edge.
    this._fadeZone = Math.max(FADE_ZONE_MIN, this._fadeDistance)
    // Full scrollable range in the top-left-anchored frame.
    this._fadeMaxScroll = Math.max(0, this._totalContentSize - this._viewportMain)
    this._fadeLastDataIdx = this.totalItems - 1
  }

  private recomputeStrideFromMetadata(): void {
    const activeItemSize = this._metadata.activeItemSize > 0 ? this._metadata.activeItemSize : this._itemSize
    this._stride = activeItemSize + this._gap
    this._visibleSlots = this._stride > 0 ? Math.ceil(this._viewportMain / this._stride) : 0
  }

  private itemSizeForIndex(dataIndex: number): number {
    return this._metadata.sizeAtIndex(dataIndex)
  }

  private ensureRebindScratch(poolSize: number): void {
    if (this._rebindNewRingOrder.length !== poolSize) {
      this._rebindNewRingOrder.length = poolSize
      this._rebindOrderedItems.length = poolSize
    }
  }

  /** Pop any unused slot regardless of type. Returns `-1` when empty. */
  private takeAnyUnusedSlot(unusedByType: Map<string, number[]>): number {
    for (const list of unusedByType.values()) {
      if (list.length > 0) return list.pop() as number
    }
    return -1
  }

  private fireCreateItem(slot: number, obj: SceneObject, type: string): void {
    if (!this.adapter) return
    this._poolHolders[slot] = this.adapter.onCreateView(obj, type as TType)
    this._stats.recordCreate(type)
  }

  private fireBindItem(slot: number, dataIndex: number): void {
    const slotObj = this._poolObjects[slot]
    try {
      this._bindingDepth++
      this.resetSlotSubColliderBands(slot)
      const holder = this._poolHolders[slot]
      if (this.adapter && holder !== null) {
        this.adapter.onBindView(slotObj, holder, dataIndex)
        if (dataIndex >= 0) this._stats.recordBind()
      }
      // Destroy guard: `cleanup` nulls `_scrollWindow` and wipes arrays. Cache
      // the key even during pre-`_initialized` fill so a pre-scroll snapshot anchors.
      if (this._scrollWindow === null) return
      const adapter = this.adapter
      if (adapter?.getItemKey) this._slotKeys[slot] = adapter.getItemKey(dataIndex)
      else this._slotKeys[slot] = null
      if (!this._initialized) return
      this.refreshSlotRootComponents(slot)
      this.maybeMeasureSlot(slot, dataIndex)
      if (this.resetSlotSubColliderBands(slot)) this.markClipDirty()
    } finally {
      this._bindingDepth--
    }
  }

  private preparedContentIncludes(dataIndex: number): boolean {
    if (!this._applyingPreparedSnapshot) return false
    const ranges = this._preparedContentRanges
    if (ranges === null) return true
    for (let i = 0; i < ranges.length; i++) {
      if (dataIndex >= ranges[i].start && dataIndex < ranges[i].end) return true
    }
    return false
  }

  private fireIndexChanged(slot: number, dataIndex: number): void {
    const holder = this._poolHolders[slot]
    if (holder === null) return
    try {
      this._bindingDepth++
      this.adapter?.onIndexChanged?.(this._poolObjects[slot], holder, dataIndex)
    } finally {
      this._bindingDepth--
    }
  }

  private fireUnbindItem(slot: number, dataIndex: number): void {
    this._retainedRefreshSlots.delete(slot)
    this._retainedIndexSlots.delete(slot)
    const slotObj = this._poolObjects[slot]
    const holder = this._poolHolders[slot]
    this.resetSlotSubColliderBands(slot)
    if (this.adapter?.onUnbindView && holder !== null) {
      this.adapter.onUnbindView(slotObj, holder, dataIndex)
      if (dataIndex >= 0) this._stats.recordUnbind()
    } else if (holder !== null && dataIndex >= 0) {
      this._stats.recordUnbind()
    }
    // Mid-callback destroy guard.
    if (!this._initialized) return
    this._slotKeys[slot] = null
    this._lastUsedTime[slot] = this.getTimeSec()
    this.armShrinkWork()
  }

  private fireDestroyItem(slot: number): void {
    const holder = this._poolHolders[slot]
    if (holder === null) return
    this._poolHolders[slot] = null
    const adapter = this.adapter
    if (!adapter?.onDestroyView) return
    // Bracket the callback so a consumer reentering applySnapshot/invalidate
    // from onDestroyView defers instead of splicing the pool mid-reclaim.
    const prevInMutation = this._inMutation
    const prevUpdating = this._isUpdatingData
    this._inMutation = true
    this._isUpdatingData = true
    try {
      adapter.onDestroyView(this._poolObjects[slot], holder)
    } finally {
      this._inMutation = prevInMutation
      this._isUpdatingData = prevUpdating
    }
  }

  /** Seconds since lens start. */
  private getTimeSec(): number {
    return getTime()
  }

  /**
   * Refresh root + subtree caches. Subtree mutations during `onBindView`
   * require `invalidate(range, "structure")`.
   */
  private refreshSlotComponents(slot: number): void {
    this.refreshSlotRootComponents(slot)
    this.refreshSlotSubtreeComponents(slot)
  }

  /**
   * Per-bind refresh of root-only Text/Image caches and their baseline RGB.
   * Picks up components added on the slot root inside `adapter.onBindView`.
   */
  private refreshSlotRootComponents(slot: number): void {
    const obj = this._poolObjects[slot]
    const texts = obj.getComponents("Component.Text")
    const images = obj.getComponents("Component.Image")
    this._poolTexts[slot] = texts
    this._poolImages[slot] = images
    // Reuse existing arrays when length matches to avoid per-rebind allocation.
    let textRGB = this._poolTextRGB[slot]
    if (!textRGB || textRGB.length !== texts.length * 3) {
      textRGB = new Array(texts.length * 3)
      this._poolTextRGB[slot] = textRGB
    }
    let textFills = this._poolTextFills[slot]
    if (!textFills || textFills.length !== texts.length) {
      textFills = new Array(texts.length)
      this._poolTextFills[slot] = textFills
    }
    for (let i = 0; i < texts.length; i++) {
      const fill = texts[i].textFill
      textFills[i] = fill
      const c = fill.color
      textRGB[i * 3] = c.r
      textRGB[i * 3 + 1] = c.g
      textRGB[i * 3 + 2] = c.b
    }
    let imageRGB = this._poolImageRGB[slot]
    if (!imageRGB || imageRGB.length !== images.length * 3) {
      imageRGB = new Array(images.length * 3)
      this._poolImageRGB[slot] = imageRGB
    }
    let imagePasses = this._poolImageMainPasses[slot]
    if (!imagePasses || imagePasses.length !== images.length) {
      imagePasses = new Array(images.length)
      this._poolImageMainPasses[slot] = imagePasses
    }
    for (let i = 0; i < images.length; i++) {
      const pass = images[i].mainPass
      imagePasses[i] = pass
      const c = pass.baseColor
      imageRGB[i * 3] = c.r
      imageRGB[i * 3 + 1] = c.g
      imageRGB[i * 3 + 2] = c.b
    }
  }

  /**
   * Subtree walks for the clippable-element and ColliderComponent caches.
   * `findAllComponentsInSelfOrChildren` calls `getComponentsInDescendants`
   * which is recursive. Walked once per slot at spawn (after `adapter.onCreateView`)
   * and on `invalidate(range, "structure")`; NOT on every bind, since the
   * subtree walk would otherwise dominate the boundary-cross hot path.
   */
  private clearSlotSubColliderDirtySubscriptions(slot: number): void {
    const unsubscribes = this._poolSubColliderDirtyUnsubscribes[slot]
    if (!unsubscribes || unsubscribes.length === 0) return
    for (let i = 0; i < unsubscribes.length; i++) {
      unsubscribes[i]()
    }
    unsubscribes.length = 0
  }

  private clearSlotSubColliderState(slot: number): void {
    const colliders = this._poolSubColliders[slot]
    if (colliders) {
      for (let i = 0; i < colliders.length; i++) {
        const collider = colliders[i]
        if (!collider || isNull(collider)) continue
        this._subColliderClipStates.delete(collider)
        this._subColliderProviders.delete(collider)
      }
    }
    this.clearSlotSubColliderDirtySubscriptions(slot)
  }

  private removeSlotSubColliderAt(slot: number, index: number): void {
    const colliders = this._poolSubColliders[slot]
    const transforms = this._poolSubColliderTransforms[slot]
    const providers = this._poolSubColliderProviders[slot]
    if (!colliders) return
    const collider = colliders[index]
    if (collider && !isNull(collider)) {
      this._subColliderClipStates.delete(collider)
      this._subColliderProviders.delete(collider)
    }
    colliders.splice(index, 1)
    if (transforms) transforms.splice(index, 1)
    if (providers) providers.splice(index, 1)
  }

  private pruneDeadSlotSubColliders(slot: number): void {
    const colliders = this._poolSubColliders[slot]
    if (!colliders || colliders.length === 0) return
    const transforms = this._poolSubColliderTransforms[slot]
    for (let i = colliders.length - 1; i >= 0; i--) {
      const collider = colliders[i]
      const transform = transforms?.[i]
      if (!collider || isNull(collider) || !transform || isNull(transform)) {
        this.removeSlotSubColliderAt(slot, i)
      }
    }
  }

  private refreshSlotSubtreeComponents(slot: number): void {
    this.clearSlotSubColliderState(slot)
    const obj = this._poolObjects[slot]
    if (!obj || isNull(obj)) {
      this._poolSubColliders[slot] = []
      this._poolSubColliderTransforms[slot] = []
      this._poolSubColliderProviders[slot] = []
      this._poolSubColliderDirtyUnsubscribes[slot] = []
      return
    }
    const scripts = findAllComponentsInSelfOrChildren(obj, "ScriptComponent")
    const clippables: ClippableElement[] = []
    const transforms: Transform[] = []
    const interactables: Interactable[] = []
    const explicitSubColliders: ColliderComponent[] = []
    const explicitSubColliderProviders: ClipColliderProvider[] = []
    const explicitSubColliderSet = new Set<ColliderComponent>()
    const subscribedProviders = new Set<ClipColliderProvider>()
    const dirtyUnsubscribes: unsubscribe[] = []
    for (let i = 0; i < scripts.length; i++) {
      const sc = scripts[i]
      if (isClippableElement(sc)) {
        clippables.push(sc)
        transforms.push(sc.sceneObject.getTransform())
        interactables.push(sc.interactable)
      }
      const provider = getClipColliderProvider(sc)
      if (provider) {
        const clipColliders = provider.clipColliders
        for (let c = 0; c < clipColliders.length; c++) {
          const collider = clipColliders[c]
          if (!collider || isNull(collider) || explicitSubColliderSet.has(collider)) continue
          explicitSubColliderSet.add(collider)
          explicitSubColliders.push(collider)
          explicitSubColliderProviders.push(provider)
        }
      }
    }
    this._poolClippables[slot] = clippables
    this._poolClippableTransforms[slot] = transforms
    this._poolClippableInteractables[slot] = interactables
    const elementOwnedColliders = new Set<ColliderComponent>()
    for (let i = 0; i < clippables.length; i++) {
      const collider = clippables[i].collider
      if (collider && !isNull(collider)) elementOwnedColliders.add(collider)
    }

    // Fully-qualified name — `getComponentsInDescendants` is namespace-strict.
    const colliders = findAllComponentsInSelfOrChildren(obj, COLLIDER_COMPONENT_NAME) as unknown as ColliderComponent[]
    this._poolColliders[slot] = colliders

    const subColliders: ColliderComponent[] = []
    const subColliderTransforms: Transform[] = []
    const subColliderProviders: ClipColliderProvider[] = []
    for (let i = 0; i < explicitSubColliders.length; i++) {
      const collider = explicitSubColliders[i]
      if (!collider || isNull(collider) || elementOwnedColliders.has(collider) || colliders.indexOf(collider) < 0)
        continue
      const shape = collider.shape
      if (!isBoxShapeLike(shape)) continue
      const colliderObject = collider.sceneObject
      if (!colliderObject || isNull(colliderObject)) continue
      const transform = colliderObject.getTransform()
      const provider = explicitSubColliderProviders[i]
      const dirtyEvent = provider.onClipCollidersDirty
      if (dirtyEvent && !subscribedProviders.has(provider)) {
        dirtyUnsubscribes.push(dirtyEvent.add(() => this.markSubColliderClipDirty(provider)))
        subscribedProviders.add(provider)
      }
      subColliders.push(collider)
      subColliderTransforms.push(transform)
      subColliderProviders.push(provider)
      this._subColliderProviders.set(collider, provider)
    }
    this._poolSubColliders[slot] = subColliders
    this._poolSubColliderTransforms[slot] = subColliderTransforms
    this._poolSubColliderProviders[slot] = subColliderProviders
    this._poolSubColliderDirtyUnsubscribes[slot] = dirtyUnsubscribes

    // Newly-walked Elements self-register with IM in their onAwake. Sync to
    // current visibility so off-window slots don't leak into IM's per-frame set.
    this.setSlotIMRegistered(slot, this._slotVisible[slot] ?? false)
  }

  private resetSlotSubColliderBands(slot: number): boolean {
    const colliders = this._poolSubColliders[slot]
    if (!colliders || colliders.length === 0) return false
    let touched = false
    for (let i = 0; i < colliders.length; i++) {
      const collider = colliders[i]
      if (!collider || isNull(collider)) {
        this.removeSlotSubColliderAt(slot, i)
        i--
        touched = true
        continue
      }
      const shape = collider.shape
      if (!isBoxShapeLike(shape)) continue
      const previous = this._subColliderClipStates.get(collider)
      if (previous) {
        this._subColliderClipStates.set(collider, {
          band: "fullyVisible",
          enabled: previous.enabled,
          debugDrawEnabled: previous.debugDrawEnabled
        })
      }
      touched = true
    }
    return touched
  }

  // ─── Private: Scroll Handler ───────────────────────────────────────

  private onScrollPositionUpdated(position: vec2): void {
    if (this._isUpdatingData) return
    if (this._poolObjects.length === 0) return

    const scrollMainAxis = this.getScrollMainAxis(position)
    if (scrollMainAxis !== this._lastScrollMain) this.requestLateUpdate()
    this._lastScrollMain = scrollMainAxis
    const firstVisibleSlot = this.computeFirstVisibleSlot(scrollMainAxis)
    const startIndex = this.clampRebindStart(firstVisibleSlot - this._bufferCount)

    this.updateLayoutOffset(startIndex)

    if (firstVisibleSlot !== this._lastFirstVisibleDataIndex) {
      this.rebindRange(startIndex)
      this._lastFirstVisibleDataIndex = firstVisibleSlot
      this.refreshPendingShrinkWork(true, true)
      // When colliders aren't forced off, batch `forceFlexLayout` +
      // `updateSlotVisibilities` to one LateUpdate pass per frame.
      if (!this._collidersForcedOff) {
        this._scrollLayoutDirty = true
        this.requestLateUpdate()
      }
    }

    this.updateFade(position)
    // Clip pass runs in LateUpdate — `getWorldPosition` here would be stale.
  }

  // ─── Private: Scroll-Drag Deferral ─────────────────────────────────

  private onScrollDragActivity(): void {
    // Edge false→true: first drag tick of a new gesture. Disable child
    // colliders so re-grips during scroll don't pay the SW cancel cascade.
    const dragStart = !this._isUserScrolling
    if (dragStart) {
      this.applyScrollMotionColliderState(true)
      // User took over — drop any queued alignment correction.
      this._pendingAlignTarget = null
    }
    this._isUserScrolling = true
    this._scrollIdleCounter++
    const myCounter = this._scrollIdleCounter
    setTimeout(() => {
      if (myCounter !== this._scrollIdleCounter) return
      this.onScrollIdle()
    }, SCROLL_IDLE_TIMEOUT_MS)
    if (dragStart) this.onScrollDragStartEvent.invoke()
  }

  /** Shared by the timer fallback and the authoritative settle path. */
  private onScrollIdle(): void {
    const wasScrolling = this._isUserScrolling
    this._isUserScrolling = false
    // Refresh the layout deferred during motion so collider state is correct
    // when applyScrollMotionColliderState restores them.
    if (this._collidersForcedOff) {
      this.forceFlexLayout()
      this.updateSlotVisibilities()
      this._scrollLayoutDirty = false
    }
    this.applyScrollMotionColliderState(false)

    // `applyDataChange` owns its own rebindRange — let it absorb the deferral
    // instead of racing `tickDeferredGrowDrain`.
    if (this._poolMetricsDirty) {
      this._poolMetricsDirty = false
      this._scrollDeferredGrowsPending = false
      this.applyDataChange()
    }

    this.drainPendingMutations()

    if (wasScrolling) this.onScrollDragEndEvent.invoke()
  }

  /**
   * Authoritative "drag ended" signal from ScrollWindow. Bypasses the
   * SCROLL_IDLE_TIMEOUT_MS fallback so colliders return immediately.
   */
  private onScrollSettled(): void {
    this._scrollIdleCounter++
    if (this._isUserScrolling) {
      this.onScrollIdle()
    }
  }

  /**
   * Enter or leave "scroll motion" mode for child colliders. While `motion`
   * is true, every slot's descendant colliders are forcibly off — independent
   * of `_slotVisible` — so the interactable graph that ScrollWindow walks on
   * each drag-start has nothing in a non-default state. On exit, restore each
   * slot's collider state to match `_slotVisible` and re-prime the clip pass
   * so the next LateUpdate writes correct band geometry against the now-settled
   * scroll position.
   */
  private applyScrollMotionColliderState(motion: boolean): void {
    if (this._collidersForcedOff === motion) return
    this._collidersForcedOff = motion
    // Hoist the debug-mode lookup — invariant for the loop's duration.
    const debugMode = InteractionManager.getInstance().debugModeEnabled
    for (let s = 0; s < this._poolObjects.length; s++) {
      const desired = motion ? false : this._slotVisible[s]
      this.setSlotCollidersEnabledRaw(s, desired, debugMode)
    }
    if (!motion) {
      this._lastClipScroll = NaN
      this.markClipDirty()
    }
  }

  // ─── Private: Fade ─────────────────────────────────────────────────

  private updateFade(scrollPos: vec2): void {
    const customAlpha = this._itemAlphaHandler !== null
    if (!this._fadeEnabled && !customAlpha) return
    if (this._poolObjects.length === 0) return

    const scrollVal = this.getScrollMainAxis(scrollPos)
    // Magnitude check (not strict equality) so spring-decay sub-pixel deltas
    // don't drag the per-slot loop along.
    if (
      Math.abs(scrollVal - this._lastFadeScroll) < FADE_SCROLL_EPSILON &&
      this._totalContentSize === this._lastFadeContentSize
    ) {
      return
    }
    this._lastFadeScroll = scrollVal
    this._lastFadeContentSize = this._totalContentSize

    const halfViewport = this._fadeHalfViewport
    const fadeZone = this._fadeZone
    const maxScroll = this._fadeMaxScroll
    const lastDataIdx = this._fadeLastDataIdx
    // Distance scrolled from content start: y grows scrolling down, x shrinks
    // scrolling right, so the horizontal axis negates. (This also fixes the
    // old center-frame test, whose horizontal isAtStart fired at the content
    // END.)
    const distFromStart = this._isVertical ? scrollVal : -scrollVal
    const isAtStart = distFromStart <= FADE_EDGE_EPSILON
    const isAtEnd = distFromStart >= maxScroll - FADE_EDGE_EPSILON

    const fadePositiveEdge = halfViewport - fadeZone
    const fadeNegativeEdge = -halfViewport + fadeZone

    for (let i = 0; i < this._poolObjects.length; i++) {
      const dataIdx = this._dataIndices[i]
      if (dataIdx < 0) continue

      const top = this.topOfItem(dataIdx)
      const halfSize = this.itemSizeForIndex(dataIdx) / 2
      // Content start is pinned at ±halfViewport (top-left frame), so item
      // centers anchor on the viewport half — viewportPos is numerically
      // identical to the old center-frame value.
      const itemCenter = this._isVertical ? halfViewport - top - halfSize : -halfViewport + top + halfSize
      const viewportPos = itemCenter + scrollVal

      let alpha: number
      if ((dataIdx === 0 && isAtStart) || (dataIdx === lastDataIdx && isAtEnd)) {
        alpha = 1.0
      } else if (viewportPos <= fadePositiveEdge && viewportPos >= fadeNegativeEdge) {
        alpha = 1.0
      } else {
        alpha = 1.0
        if (viewportPos > fadePositiveEdge) {
          alpha = Math.min(alpha, (halfViewport - viewportPos) / fadeZone)
        }
        if (viewportPos < fadeNegativeEdge) {
          alpha = Math.min(alpha, (viewportPos + halfViewport) / fadeZone)
        }
        alpha = Math.max(0, Math.min(1, alpha))
      }

      if (Math.abs(alpha - this._lastAlpha[i]) < ALPHA_EPSILON) continue
      this._lastAlpha[i] = alpha

      if (customAlpha && this._itemAlphaHandler !== null) {
        this._itemAlphaHandler(this._poolObjects[i], alpha, dataIdx, this._poolHolders[i])
        // Mid-callback destroy guard.
        if (!this._initialized) return
      } else {
        this.applyBuiltInAlpha(i, alpha)
      }
    }
  }

  private applyBuiltInAlpha(slotIndex: number, alpha: number): void {
    const scratch = this._alphaScratch
    scratch.w = alpha
    const textFills = this._poolTextFills[slotIndex]
    const textRGB = this._poolTextRGB[slotIndex]
    const imagePasses = this._poolImageMainPasses[slotIndex]
    const imageRGB = this._poolImageRGB[slotIndex]
    // Defensive: bail rather than crash if pool-shrink left arrays out of sync.
    if (!textFills || !textRGB || !imagePasses || !imageRGB) return
    for (let i = 0; i < textFills.length; i++) {
      const base = i * 3
      scratch.x = textRGB[base]
      scratch.y = textRGB[base + 1]
      scratch.z = textRGB[base + 2]
      textFills[i].color = scratch
    }
    for (let i = 0; i < imagePasses.length; i++) {
      const base = i * 3
      scratch.x = imageRGB[base]
      scratch.y = imageRGB[base + 1]
      scratch.z = imageRGB[base + 2]
      imagePasses[i].baseColor = scratch
    }
  }

  // ─── Private: Pool Management ──────────────────────────────────────

  private normalizeSlotType(type: string | undefined): string {
    return type !== undefined && type.length > 0 ? type : VL_DEFAULT_TYPE
  }

  private incrementSlotTypeCount(type: string): void {
    const t = this.normalizeSlotType(type)
    this._slotTypeCounts.set(t, (this._slotTypeCounts.get(t) ?? 0) + 1)
  }

  private decrementSlotTypeCount(type: string): void {
    const t = this.normalizeSlotType(type)
    const next = (this._slotTypeCounts.get(t) ?? 0) - 1
    if (next <= 0) {
      this._slotTypeCounts.delete(t)
    } else {
      this._slotTypeCounts.set(t, next)
    }
  }

  private slotTypeCount(type: string): number {
    return this._slotTypeCounts.get(this.normalizeSlotType(type)) ?? 0
  }

  private createPoolItem(type: string = VL_DEFAULT_TYPE, prewarm: boolean = false): number {
    if (!this._layout) return -1
    type = this.normalizeSlotType(type)

    const obj = global.scene.createSceneObject(`VLItem_${type}_${this._poolObjects.length}`)
    obj.setParent(this._layout.sceneObject)
    obj.layer = this._layout.sceneObject.layer

    const item = obj.createComponent(FlexItem.getTypeName()) as FlexItem
    // New pool entries start with no reserved row size until bound or assigned
    // a deferred in-ring row. Disabled SceneObjects remain managed FlexItems;
    // trailing spares affect the measured extent, not preceding row positions
    // with our Top/Left main-axis alignment.
    if (this._isVertical) {
      item.overrideWidth = this._containerCrossSize
      item.overrideHeight = 0
    } else {
      item.overrideWidth = 0
      item.overrideHeight = this._containerCrossSize
    }

    // Register the SceneObject in the reverse-lookup map before
    // adapter.onCreateView fires, so dataIndexFor works during the callback.
    this._poolObjects.push(obj)
    this._poolItems.push(item)
    this._dataIndices.push(-1)
    this._lastAlpha.push(-1)
    // Text/Image caches start empty; refreshSlotComponents repopulates them
    // after onCreateView has had a chance to add components.
    this._poolTexts.push([])
    this._poolImages.push([])
    this._poolTextFills.push([])
    this._poolImageMainPasses.push([])
    this._poolTextRGB.push([])
    this._poolImageRGB.push([])
    this._poolClippables.push([])
    this._poolClippableTransforms.push([])
    this._poolClippableInteractables.push([])
    this._poolColliders.push([])
    this._poolSubColliders.push([])
    this._poolSubColliderTransforms.push([])
    this._poolSubColliderProviders.push([])
    this._poolSubColliderDirtyUnsubscribes.push([])
    this._poolHolders.push(null)
    this._slotKeys.push(null)
    this._slotTypes.push(type)
    this.incrementSlotTypeCount(type)
    // Spawn-time timestamp (not `-1`) so never-bound slots become eligible
    // for shrink GC after `shrinkDelayMs`. Prewarmed slots get a one-window
    // grace period so they survive at least one idle period.
    const spawnTime = this.getTimeSec()
    this._lastUsedTime.push(prewarm && this._shrinkDelayMs > 0 ? spawnTime + this._shrinkDelayMs / 1000 : spawnTime)
    this._slotVisible.push(false)
    const newSlotIndex = this._poolObjects.length - 1
    this._slotBySceneObject.set(obj, newSlotIndex)

    this.fireCreateItem(newSlotIndex, obj, type)

    this.refreshSlotComponents(newSlotIndex)
    this.setSlotCollidersEnabled(newSlotIndex, false)
    // New slot starts unbound; wake the update tick so shrink GC can reclaim it.
    this.armShrinkWork()
    return newSlotIndex
  }

  private resizePool(): void {
    if (!this._layout) return

    const calculatedSize = this._visibleSlots + 2 * this._bufferCount
    // Clamp to 0 — `Array.splice(neg)` removes from the end, not truncates.
    const targetSize = Math.max(
      0,
      this._poolSizeOverride !== null
        ? Math.min(this._poolSizeOverride, this.totalItems)
        : Math.min(calculatedSize, this.totalItems)
    )
    const currentSize = this._poolObjects.length

    if (targetSize > currentSize) {
      const newItems: FlexItem[] = []
      for (let i = currentSize; i < targetSize; i++) {
        const slot = this.createPoolItem()
        if (slot >= 0) {
          this._stats.recordGrow(VL_DEFAULT_TYPE)
          newItems.push(this._poolItems[slot])
        }
      }
      this._layout.addItems(newItems)
      this.ensureRebindScratch(targetSize)
    } else if (targetSize < currentSize) {
      // Keyed reconciliation can keep a live row at a high pool index; trim
      // only the unbound tail and let shrink GC collect lower spares later.
      let trimTo = targetSize
      for (let s = currentSize - 1; s >= targetSize; s--) {
        if (this._dataIndices[s] >= 0) {
          trimTo = s + 1
          break
        }
      }
      for (let i = trimTo; i < currentSize; i++) {
        const removedType = this._slotTypes[i] ?? VL_DEFAULT_TYPE
        const oldIdx = this._dataIndices[i]
        if (oldIdx >= 0) {
          this._dataIndices[i] = -1
          this.fireUnbindItem(i, oldIdx)
          if (!this._initialized) return
        }
        this.clearSlotSubColliderState(i)
        this.fireDestroyItem(i)
        if (!this._initialized) return
        // Decrement after the unbind so a consumer reading poolSizesByType from
        // inside onUnbindView still sees this slot counted while it tears down.
        this.decrementSlotTypeCount(removedType)
        this._stats.recordShrink(removedType)
      }

      const removedItems = this._poolItems.splice(trimTo)
      const removedObjects = this._poolObjects.splice(trimTo)
      this._dataIndices.splice(trimTo)
      this._lastAlpha.splice(trimTo)
      this._poolTexts.splice(trimTo)
      this._poolImages.splice(trimTo)
      this._poolTextFills.splice(trimTo)
      this._poolImageMainPasses.splice(trimTo)
      this._poolTextRGB.splice(trimTo)
      this._poolImageRGB.splice(trimTo)
      this._poolClippables.splice(trimTo)
      this._poolClippableTransforms.splice(trimTo)
      this._poolClippableInteractables.splice(trimTo)
      this._poolColliders.splice(trimTo)
      this._poolSubColliders.splice(trimTo)
      this._poolSubColliderTransforms.splice(trimTo)
      this._poolSubColliderProviders.splice(trimTo)
      this._poolSubColliderDirtyUnsubscribes.splice(trimTo)
      this._poolHolders.splice(trimTo)
      this._slotKeys.splice(trimTo)
      this._slotTypes.splice(trimTo)
      this._lastUsedTime.splice(trimTo)
      this._slotVisible.splice(trimTo)
      // In-place compact: drop ring entries referring to removed slots.
      let writeIdx = 0
      for (let readIdx = 0; readIdx < this._ringOrder.length; readIdx++) {
        const s = this._ringOrder[readIdx]
        if (s < trimTo) {
          this._ringOrder[writeIdx++] = s
        }
      }
      this._ringOrder.length = writeIdx

      this._layout.removeItems(removedItems)
      for (const obj of removedObjects) {
        this._slotBySceneObject.delete(obj)
        if (obj && !isNull(obj)) {
          obj.destroy()
        }
      }
      this.ensureRebindScratch(trimTo)
    }
    // Pool changed shape — slot indices the clip pass iterates have shifted.
    this._lastClipScroll = NaN
    this.markClipDirty()
  }

  /**
   * Ring-buffer rebind. Ring position `k` must show `startIndex + k` (or -1
   * past data end). In-window slots stay bound and shift ring position;
   * out-of-window slots recycle. Pool may exceed ring; spares park in
   * `unusedByType`.
   */
  private rebindRange(requestedStartIndex: number): void {
    const poolSize = this._poolObjects.length
    if (poolSize === 0) return
    const ringSize = this.computeRingSize()
    if (ringSize === 0) return
    // Keep every ring position assigned to a valid data index near the end,
    // using the available slots for real rows instead of past-end entries.
    // When the ring can hold all rows, its start must stay at zero. Trailing
    // past-end FlexItems do not shift preceding rows under Top/Left alignment.
    const startIndex = clampVirtualizedWindowStart(requestedStartIndex, this.totalItems, ringSize)
    this.ensureRebindScratch(poolSize)

    const inWindow = this._rebindInWindow
    inWindow.clear()
    // Anchor restoration may synchronously rebind before the explicit refresh.
    // Keep the union until the enclosing snapshot/invalidation finishes.
    if (!this._inMutation && !this._applyingPreparedSnapshot) this._rebindBoundThisPass.clear()
    // Return last call's per-type arrays to the pool. Truncate before reuse
    // since a partial bail could leave entries behind.
    const unusedByType = this._rebindUnusedByType
    const listPool = this._unusedListPool
    if (unusedByType.size > 0) {
      for (const list of unusedByType.values()) {
        list.length = 0
        listPool.push(list)
      }
      unusedByType.clear()
    }
    for (let s = 0; s < poolSize; s++) {
      const di = this._dataIndices[s]
      const t = this._slotTypes[s] ?? VL_DEFAULT_TYPE
      // A type-mismatched slot can't keep its row even if the row is still in
      // window (the holder was built for the old type) — recycle it instead.
      const inRange = di >= 0 && di >= startIndex && di < startIndex + ringSize && di < this.totalItems
      if (inRange && t === this._metadata.typeAtIndex(di)) {
        inWindow.set(di, s)
      } else {
        let list = unusedByType.get(t)
        if (!list) {
          list = listPool.length > 0 ? (listPool.pop() as number[]) : []
          unusedByType.set(t, list)
        }
        list.push(s)
      }
    }

    // Defer measure-on-bind side-effects across the loop so back-to-back
    // binds don't ripple rebuildCumulativesFrom / setScrollDimensions per slot.
    const newRingOrder = this._rebindNewRingOrder
    const grownItems = this._rebindGrownItems
    grownItems.length = 0
    let anyChanged = false
    const prevDefer = this._deferMeasureSideEffects
    this._deferMeasureSideEffects = true

    // Pool growth caps. Active scroll: 1/call so a fling pays at most one
    // createPoolItem per boundary. Drain: DRAIN_GROWS_PER_FRAME. Other paths
    // (initial fill, applyDataChange): full ringSize.
    const growBudget = this._isUserScrolling ? 1 : this._drainingDeferredGrows ? DRAIN_GROWS_PER_FRAME : ringSize
    let growsUsed = 0
    let growsDeferred = false

    try {
      for (let k = 0; k < ringSize; k++) {
        const target = startIndex + k
        const targetValid = target < this.totalItems

        if (targetValid) {
          const existing = inWindow.get(target)
          if (existing !== undefined) {
            newRingOrder[k] = existing
            // A metadata rebuild can change a surviving row's size without
            // rebinding it (for example, the former last row loses an end
            // inset after append). Keep the physical FlexItem synchronized with
            // the newly rebuilt logical geometry even when identity is stable.
            const sizeChanged = this.applyItemSizeToSlot(existing, this.itemSizeForIndex(target))
            if (sizeChanged || this._retainedRefreshSlots.has(existing) || this._retainedIndexSlots.has(existing)) {
              const refreshContent =
                sizeChanged ||
                this._retainedRefreshSlots.has(existing) ||
                this.preparedContentIncludes(target) ||
                !this.adapter?.onIndexChanged
              this._retainedRefreshSlots.delete(existing)
              this._retainedIndexSlots.delete(existing)
              if (refreshContent) this.fireBindItem(existing, target)
              else this.fireIndexChanged(existing, target)
              if (!this._initialized) {
                this._deferMeasureSideEffects = prevDefer
                return
              }
              if (refreshContent) this._rebindBoundThisPass.add(existing)
              this._lastAlpha[existing] = -1
              anyChanged = true
            }
            continue
          }
        }

        // Need to recycle (or, for valid targets, possibly grow on type-miss).
        let slot: number = -1
        let useAsPastEnd = !targetValid
        if (targetValid) {
          const targetType = this._metadata.typeAtIndex(target)
          const matching = unusedByType.get(targetType)
          if (matching && matching.length > 0) {
            slot = matching.pop() as number
          } else if (growsUsed < growBudget) {
            // Dynamic grow-on-miss: no unused slot of `targetType`. Create one
            // and let it claim this ring position. The new slot is added to
            // FlexLayout's items array after the loop. Pool grows but the ring
            // stays at `ringSize` — extras live as off-ring spares.
            this.consumePendingPrewarmForType(targetType)
            this.maybeWarnGrowOnMiss(targetType)
            slot = this.createPoolItem(targetType)
            if (slot < 0) return
            this._stats.recordGrow(targetType)
            grownItems.push(this._poolItems[slot])
            this.ensureRebindScratch(this._poolObjects.length)
            growsUsed++
          } else {
            // Grow budget exhausted — fall through to past-end disable.
            // `_scrollDeferredGrowsPending` re-runs rebindRange on idle.
            useAsPastEnd = true
            growsDeferred = true
          }
        }
        if (slot < 0) {
          slot = this.takeAnyUnusedSlot(unusedByType)
          if (slot < 0) {
            // Pool starved below ringSize: every existing slot is committed to a
            // distinct ring position, so a create is the only valid+unique source.
            const growType = useAsPastEnd ? VL_DEFAULT_TYPE : this._metadata.typeAtIndex(target)
            slot = this.createPoolItem(growType)
            if (slot < 0) return
            this._stats.recordGrow(growType)
            grownItems.push(this._poolItems[slot])
            this.ensureRebindScratch(this._poolObjects.length)
            // Starved creates are mandatory and not budget-capped (a full ring
            // needs `ringSize` unique slots); count them so the type-miss path can't pile on.
            growsUsed++
          }
        }
        newRingOrder[k] = slot
        const oldIdx = this._dataIndices[slot]
        const countRecycle = oldIdx >= 0 && !useAsPastEnd

        // Write `_dataIndices[slot]` before the callback so synchronous
        // re-entries see consistent state.
        if (!useAsPastEnd) {
          if (oldIdx >= 0) {
            this._dataIndices[slot] = -1
            this.fireUnbindItem(slot, oldIdx)
            if (!this._initialized) return
          }
          this._poolObjects[slot].enabled = true
          this._dataIndices[slot] = target
          this.applyItemSizeToSlot(slot, this.itemSizeForIndex(target))
          this.fireBindItem(slot, target)
          // Mid-callback destroy guard.
          if (!this._initialized) return
          if (countRecycle) this._stats.recordRecycle(this._metadata.typeAtIndex(target))
          this._rebindBoundThisPass.add(slot)
          this._lastAlpha[slot] = -1
          anyChanged = true
        } else {
          // Hide both past-end slots and valid rows awaiting a typed holder.
          // Deferred in-ring rows still reserve their target size so later
          // bound rows stay aligned with the logical scroll geometry.
          // Only flip `anyChanged` when the slot was actually bound.
          this._dataIndices[slot] = -1
          if (oldIdx >= 0) {
            this.fireUnbindItem(slot, oldIdx)
            if (!this._initialized) return
            anyChanged = true
          }
          this.parkSlot(slot, targetValid ? this.itemSizeForIndex(target) : 0)
          this._lastAlpha[slot] = -1
        }
      }
    } finally {
      this._deferMeasureSideEffects = prevDefer
    }
    if (!prevDefer) {
      this.flushDeferredMeasures()
    }

    // Everything still unused is now off-ring. Previously bound slots must
    // unbind; already-unbound deferred placeholders must also lose their
    // reserved size now that they no longer occupy a ring position.
    for (const list of unusedByType.values()) {
      for (let i = 0; i < list.length; i++) {
        const s = list[i]
        const oldIdx = this._dataIndices[s]
        if (oldIdx >= 0) {
          this._dataIndices[s] = -1
          this.fireUnbindItem(s, oldIdx)
          if (!this._initialized) return
          anyChanged = true
        }
        this.parkSlot(s)
        this._lastAlpha[s] = -1
      }
    }

    if (grownItems.length > 0 && this._layout) {
      this._layout.addItems(grownItems)
    }

    // Reorder FlexLayout: ring slots first in ring order, spares trailing.
    // Spares are SceneObject-disabled so trailing position doesn't render.
    // A shorter replacement ring must drop stale tail entries or shrink GC
    // keeps treating those slots as ring-protected.
    let ringChanged = this._ringOrder.length !== ringSize
    const orderedItems = this._rebindOrderedItems
    for (let k = 0; k < ringSize; k++) {
      const slot = newRingOrder[k]
      if (this._ringOrder[k] !== slot) ringChanged = true
      orderedItems[k] = this._poolItems[slot]
    }
    // Append spares so `reorderItems` covers FlexLayout's full items list.
    const poolSizeNow = this._poolObjects.length
    if (poolSizeNow > ringSize) {
      const ringSlots = this._rebindRingSlots
      ringSlots.clear()
      for (let k = 0; k < ringSize; k++) {
        ringSlots.add(newRingOrder[k])
      }
      let outIdx = ringSize
      for (let s = 0; s < poolSizeNow; s++) {
        if (!ringSlots.has(s)) {
          orderedItems[outIdx++] = this._poolItems[s]
        }
      }
      orderedItems.length = outIdx
    } else {
      orderedItems.length = ringSize
    }
    if (ringChanged) {
      for (let k = 0; k < ringSize; k++) {
        this._ringOrder[k] = newRingOrder[k]
      }
      this._ringOrder.length = ringSize
      if (this._layout) this._layout.reorderItems(orderedItems)
    }

    if (anyChanged) {
      this._lastFadeScroll = NaN
      this._lastClipScroll = NaN
      this.markClipDirty()
    }
    if (growsDeferred) {
      this._scrollDeferredGrowsPending = true
      this.requestUpdateTick()
    }
    this.refreshPendingShrinkWork(true, true)
  }

  // ─── Private: Data Change ──────────────────────────────────────────

  private applyDataChange(): void {
    if (!this._layout || !this._scrollWindow) return

    this._isUpdatingData = true
    try {
      // Full rebuild wants the full grow budget — defends against a re-entry
      // inheriting `_drainingDeferredGrows`.
      this._drainingDeferredGrows = false
      this._keyToIndex = null
      // A count/config change shifts what each index means — drop a stale
      // alignment correction.
      this._pendingAlignTarget = null
      this.rearmEdgeReached()

      this.rebuildSizes()
      this.setTotalContentSize(this.computeTotalContentSize(this.totalItems))
      this.recomputeFadeInvariants()

      const {scrollSize, topEdge, bottomEdge} = this.getScrollBounds()
      this.setScrollDimensions(scrollSize)

      // The top-left-anchored frame is size-invariant: growth appends past the
      // end without moving the current view, so no center-shift compensation is
      // needed — only the shrink clamp back into the new range.
      const currentScroll = this.getScrollMainAxis(this._scrollWindow.scrollPosition)
      const clampedScroll = Math.max(topEdge, Math.min(currentScroll, bottomEdge))
      if (clampedScroll !== currentScroll) {
        this.setScrollPosition(clampedScroll)
      }

      this.resizePool()

      if (this._poolObjects.length > 0) {
        const scroll = this.getScrollMainAxis(this._scrollWindow.scrollPosition)
        const firstVisibleSlot = this.computeFirstVisibleSlot(scroll)
        this._lastFirstVisibleDataIndex = firstVisibleSlot
        const startIndex = this.clampRebindStart(firstVisibleSlot - this._bufferCount)

        this.rebindRange(startIndex)
        if (!this._initialized || !this._scrollWindow) return
        this.updateLayoutOffset(startIndex)
        this.forceFlexLayout()
        this.updateSlotVisibilities()
        this.updateFade(this._scrollWindow.scrollPosition)
      }
    } finally {
      this._isUpdatingData = false
    }

    // Drain re-entries from binders that mutate totalItems. Capped to
    // prevent infinite loops.
    let drainBudget = MAX_DATA_CHANGE_REDRAIN
    while (this._poolMetricsDirty && !this._isUserScrolling && drainBudget-- > 0) {
      this._poolMetricsDirty = false
      this.applyDataChange()
    }
    if (this._poolMetricsDirty && !this._isUserScrolling) {
      log.e("applyDataChange: drain budget exhausted; adapter.onBindView keeps mutating totalItems")
    }

    this.notifyContentSizeChangedIfNeeded()

    if (this._pendingInvalidate !== null || this._pendingSnapshot) this.requestUpdateTick()
    this.refreshPendingShrinkWork()
  }

  // ─── Private: Helpers ──────────────────────────────────────────────

  private getScrollMainAxis(pos: vec2): number {
    return this._isVertical ? pos.y : pos.x
  }

  private setScrollDimensions(mainAxisSize: number): void {
    if (!this._scrollWindow) return
    // Cross axis pinned to viewport — inactive axis can't scroll.
    if (this._isVertical) {
      this._scrollWindow.scrollDimensions = new vec2(this._viewportSize.x, mainAxisSize)
    } else {
      this._scrollWindow.scrollDimensions = new vec2(mainAxisSize, this._viewportSize.y)
    }
  }

  private setScrollPosition(mainAxisValue: number): void {
    if (!this._scrollWindow) return
    // Scratch reuse relies on ScrollWindow's setter copying components
    // synchronously and not retaining the vec2.
    const scratch = this._scrollPosScratch
    if (this._isVertical) {
      scratch.x = 0
      scratch.y = mainAxisValue
    } else {
      scratch.x = mainAxisValue
      scratch.y = 0
    }
    if (this._applyingPreparedSnapshot) {
      this._scrollWindow.rebaseScrollPosition(scratch)
    } else {
      this._scrollWindow.scrollPosition = scratch
    }
    // Mirror directly — the init's first synthetic write happens BEFORE we
    // subscribe to `onScrollPositionUpdated`.
    if (mainAxisValue !== this._lastScrollMain) this.requestLateUpdate()
    this._lastScrollMain = mainAxisValue
  }

  /**
   * Scroll bounds in the ScrollWindow's top-left-anchored scroller frame.
   * `topEdge` is the numeric MIN of the position range and `bottomEdge` the
   * MAX, with content-start at `topEdge` for vertical and at `bottomEdge` for
   * horizontal (x positions DECREASE scrolling right, so for horizontal
   * `topEdge` is the fully-scrolled-right end). `scrollSize` is clamped to at
   * least `_viewportMain` so edges stay ordered. Returns an internal scratch —
   * read fields before the next call.
   */
  private getScrollBounds(): {scrollSize: number; topEdge: number; bottomEdge: number} {
    const scrollSize = Math.max(this._totalContentSize, this._viewportMain)
    const range = scrollSize - this._viewportMain
    const bounds = this._scrollBoundsScratch
    bounds.scrollSize = scrollSize
    bounds.topEdge = this._isVertical ? 0 : -range
    bounds.bottomEdge = this._isVertical ? range : 0
    return bounds
  }

  /**
   * Largest item index whose top edge is at or before `scrollMainAxis`. Inside
   * the resolved prefix the lookup is a binary search over `_cumulativeSizes`;
   * past the prefix the unresolved tail uses default-stride extrapolation.
   */
  private computeFirstVisibleSlot(scrollMainAxis: number): number {
    if (this._stride <= 0 || this._totalItems === 0) return 0
    const {topEdge, bottomEdge} = this.getScrollBounds()
    const distFromStart = this._isVertical ? scrollMainAxis - topEdge : bottomEdge - scrollMainAxis

    let raw = 0
    if (distFromStart > 0) {
      const stride = this._stride
      const metadata = this._metadata
      const resolvedPrefixEnd = metadata.resolvedPrefixEnd
      if (metadata.sizeMode !== "variable" || resolvedPrefixEnd < 0) {
        // Uniform/static (or entirely-unresolved variable) — pure stride math.
        raw = Math.floor(distFromStart / stride)
      } else {
        // Top of item (resolvedPrefixEnd + 1) is the boundary between the
        // resolved prefix and the default-stride extrapolation region.
        const cumulativeSizes = metadata.cumulativeSizes
        const prefixTailTop = cumulativeSizes[resolvedPrefixEnd] + this._gap
        if (distFromStart >= prefixTailTop) {
          const remainder = distFromStart - prefixTailTop
          raw = resolvedPrefixEnd + 1 + Math.floor(remainder / stride)
        } else {
          // Binary search inside the resolved prefix.
          let lo = 0
          let hi = resolvedPrefixEnd
          while (lo < hi) {
            const mid = (lo + hi + 1) >>> 1
            if (this.topOfItem(mid) <= distFromStart) lo = mid
            else hi = mid - 1
          }
          raw = lo
        }
      }
    }
    return Math.max(0, Math.min(raw, this.computeMaxFirstVisibleIndex()))
  }

  /**
   * Largest valid value for the first-visible data index. Uses
   * `_cumulativeSizes` when the prefix covers the end of the list; falls
   * back to default-stride approximation otherwise.
   */
  private computeMaxFirstVisibleIndex(): number {
    if (this._totalItems === 0) return 0
    if (this._totalContentSize <= this._viewportMain) return 0
    if (this._metadata.sizeMode !== "variable") {
      return Math.max(0, this._totalItems - this._visibleSlots)
    }
    const cumulativeSizes = this._metadata.cumulativeSizes
    if (this._metadata.resolvedPrefixEnd >= this._totalItems - 1) {
      // Walk backward summing sizes — linear in visible-window count.
      // Defensive: bound by array length in case a mid-mutation caller hits
      // an entry past the resolved prefix.
      const target = this._totalContentSize - this._viewportMain
      let i = Math.min(this._totalItems - 1, cumulativeSizes.length - 1)
      while (i > 0 && cumulativeSizes[i - 1] + this._gap > target) {
        i--
      }
      return i
    }
    return Math.max(0, this._totalItems - this._visibleSlots)
  }

  private updateLayoutOffset(startIndex: number): void {
    if (!this._layout) return
    const top = this.topOfItem(startIndex)
    // FlexLayout packs Column+Top toward -y and Row+Left toward +x. Overflow
    // content stays pinned to the viewport edge in the top-left frame;
    // underfilled content starts centered, then applies its configured bias.
    const frameHalf = Math.min(this._totalContentSize, this._viewportMain) / 2
    const offset = (this._isVertical ? frameHalf - top : -frameHalf + top) + this.contentAlignOffset
    if (Math.abs(this._lastAppliedOffset - offset) < OFFSET_WRITE_EPSILON) return
    this._lastAppliedOffset = offset
    if (this._isVertical) {
      this._offsetScratch.y = offset
    } else {
      this._offsetScratch.x = offset
    }
    if (!this._layoutTransform) return
    this._layoutTransform.setLocalPosition(this._offsetScratch)
  }

  private computeTotalContentSize(totalSlots: number): number {
    return this._metadata.computeTotalContentSize(totalSlots)
  }

  /**
   * Capture `(firstVisibleDataIndex, intraItemFraction)` so a subsequent size
   * change can restore the same visible content position via `restoreAnchor`.
   */
  private captureAnchor(): ViewportAnchor | null {
    if (!this._scrollWindow) return null
    if (this._poolObjects.length === 0 || this._totalItems === 0) return null
    // Use the live scroll position — `_lastFirstVisibleDataIndex` only
    // refreshes on boundary crossings.
    const liveScroll = this.getScrollMainAxis(this._scrollWindow.scrollPosition)
    const {topEdge, bottomEdge} = this.getScrollBounds()
    // Preserve the elastic displacement separately from the row fraction.
    // Fractions are bounded, so they cannot represent a pull past either edge.
    const scrollVal = this.preservesPreparedOverscroll()
      ? Math.max(topEdge, Math.min(liveScroll, bottomEdge))
      : liveScroll
    const overscroll = liveScroll - scrollVal
    const distFromStart = this._isVertical ? scrollVal - topEdge : bottomEdge - scrollVal
    const firstVisible = this.computeFirstVisibleSlot(scrollVal)
    const idx = Math.max(0, Math.min(firstVisible, this._totalItems - 1))
    const topOf = this.topOfItem(idx)
    const size = this.itemSizeForIndex(idx)
    let frac = (distFromStart - topOf) / size
    if (frac < INTRA_ITEM_EPSILON) frac = 0
    if (frac > 1 - INTRA_ITEM_EPSILON) frac = 1
    frac = Math.max(0, Math.min(1, frac))
    return {idx, frac, key: this.keyOfBoundIndex(idx), overscroll}
  }

  // Key bound to the slot showing `dataIndex`, from cached `_slotKeys` (set at
  // bind time). Null when unkeyed or the index isn't bound to a live slot.
  private keyOfBoundIndex(dataIndex: number): string | number | null {
    for (let s = 0; s < this._dataIndices.length; s++) {
      if (this._dataIndices[s] === dataIndex) return this._slotKeys[s]
    }
    return null
  }

  /**
   * Write a scrollPosition that places the anchor at the same viewport
   * offset against the mutated content. Cancels any in-flight tween.
   */
  private restoreAnchor(anchor: ViewportAnchor | null): void {
    if (!anchor || !this._scrollWindow) return
    // ScrollWindow clamps scrollPosition to its current scrollDimensions; push
    // the updated content size first so a grown/remapped target isn't clamped.
    this.setScrollDimensions(this.getScrollBounds().scrollSize)
    this.setScrollPosition(this.anchorScrollValue(anchor))
  }

  // Position that lands `anchor` at its offset, retaining elastic displacement
  // only during prepared live updates. Shared with the reconcile window.
  private anchorScrollValue(anchor: ViewportAnchor): number {
    const idx = Math.max(0, Math.min(anchor.idx, Math.max(0, this._totalItems - 1)))
    const size = this.itemSizeForIndex(idx)
    const targetDist = this.topOfItem(idx) + anchor.frac * size
    const {topEdge, bottomEdge} = this.getScrollBounds()
    const raw = this._isVertical ? topEdge + targetDist : bottomEdge - targetDist
    const clamped = Math.max(topEdge, Math.min(raw, bottomEdge))
    return this.preservesPreparedOverscroll() ? clamped + anchor.overscroll : clamped
  }

  private preservesPreparedOverscroll(): boolean {
    return this._applyingPreparedSnapshot && this._scrollWindow?.edgeMode === "elastic"
  }

  private clampedInitialIndex(): number {
    if (this._totalItems <= 0) return 0
    return Math.max(0, Math.min(this._initialIndex, this._totalItems - 1))
  }

  /**
   * Number of data positions the ring covers (visible window + buffer,
   * clamped to `totalItems`). Pool may exceed this via grow-on-miss spares.
   */
  private computeRingSize(): number {
    const calculated = this._visibleSlots + 2 * this._bufferCount
    const cap =
      this._poolSizeOverride !== null
        ? Math.min(this._poolSizeOverride, this._totalItems)
        : Math.min(calculated, this._totalItems)
    return Math.max(0, cap)
  }

  /**
   * Rebuild size/type metadata for the full data range. Static/uniform modes
   * skip variable-size arrays; typed pooling keeps only type metadata.
   */
  private rebuildSizes(): void {
    this._metadata.rebuild(this.adapter, this._totalItems, this._itemSize, this._gap)
    this.recomputeStrideFromMetadata()
  }

  /**
   * Partial rebuild of cumulative sums from `fromIndex`; stops at the first
   * `-1` sentinel. No-op when there is an unresolved gap before `fromIndex`.
   */
  private rebuildCumulativesFrom(fromIndex: number): void {
    this._metadata.rebuildCumulativesFrom(fromIndex)
  }

  /**
   * Top-edge offset for the given data index. Inside the resolved prefix:
   * `_cumulativeSizes[i-1] + gap`. Past the prefix: default-stride extrapolation.
   */
  private topOfItem(dataIndex: number): number {
    return this._metadata.topOfItem(dataIndex)
  }

  /**
   * LateUpdate drain. Runs `forceFlexLayout` once so queued slots read
   * post-reflow transforms, re-measures each, then settles the layout
   * offset against the measured geometry before notifying.
   */
  private drainPendingRemeasure(): void {
    if (!this._initialized || this._pendingRemeasure.size === 0) return
    this.forceFlexLayout()
    // Swap so re-adds during measurement settle into the next frame's queue.
    const pending = this._pendingRemeasure
    this._pendingRemeasure = this._pendingRemeasureSwap
    this._pendingRemeasureSwap = pending
    // Hold per-slot notifications until the offset resettles: consumers must
    // not observe the measured content size while rows sit at the stale offset.
    const notifyEnabled = this._contentSizeNotificationsEnabled
    this._contentSizeNotificationsEnabled = false
    try {
      for (let s = 0; s < this._dataIndices.length; s++) {
        const di = this._dataIndices[s]
        if (di < 0 || di >= this._totalItems) continue
        if (pending.has(di)) {
          this.maybeMeasureSlot(s, di)
        }
      }
    } finally {
      this._contentSizeNotificationsEnabled = notifyEnabled
    }
    pending.clear()
    // Measured sizes moved the cumulative geometry; resettle so rows match
    // what contentAlignOffset and decoration consumers now derive from it.
    if (this._lastFirstVisibleDataIndex >= 0) {
      this.updateLayoutOffset(this.clampRebindStart(this._lastFirstVisibleDataIndex - this._bufferCount))
    }
    this.notifyContentSizeChangedIfNeeded()
  }

  /**
   * Priority-ordered prewarm: bucket types by first-occurrence — visible,
   * buffer, long-tail. Visible+buffer drain synchronously; long-tail yields
   * across frames when `prewarmBudgetMs > 0`.
   */
  private prewarmTypePools(): void {
    this.readTypePoolMinimums()
    if ((this._minSlotsPerType <= 0 && this._typePoolMinimums.size === 0) || this._totalItems === 0 || !this._layout) {
      this._prewarmComplete = true
      return
    }

    if (this.adapter?.getItemType === undefined) {
      this._prewarmComplete = true
      return
    }

    // Cap discovery at the first `visibleSlots * 4` rows; long-tail types
    // past this point are discovered lazily via grow-on-miss.
    const firstOccurrence = new Map<string, number>()
    const discoveryLimit = Math.min(this._totalItems, Math.max(this._visibleSlots * 4, this._visibleSlots + 1))
    for (let i = 0; i < discoveryLimit; i++) {
      const t = this._metadata.typeAtIndex(i)
      if (!firstOccurrence.has(t)) firstOccurrence.set(t, i)
    }
    for (const type of this._typePoolMinimums.keys()) {
      if (!firstOccurrence.has(type)) firstOccurrence.set(type, this._totalItems)
    }

    const firstVisible = this._lastFirstVisibleDataIndex >= 0 ? this._lastFirstVisibleDataIndex : 0
    const lastVisible = Math.min(firstVisible + this._visibleSlots - 1, this._totalItems - 1)
    const bufStart = Math.max(0, firstVisible - this._bufferCount)
    const bufEnd = Math.min(this._totalItems - 1, lastVisible + this._bufferCount)

    const visibleBucket: string[] = []
    const bufferBucket: string[] = []
    const longTailBucket: string[] = []
    for (const [t, idx] of firstOccurrence) {
      const count = this.slotTypeCount(t)
      const scalarNeed = Math.max(0, this._minSlotsPerType - count)
      const bucket =
        idx >= firstVisible && idx <= lastVisible
          ? visibleBucket
          : idx >= bufStart && idx <= bufEnd
            ? bufferBucket
            : longTailBucket
      for (let n = 0; n < scalarNeed; n++) bucket.push(t)
      const declaredNeed = Math.max(0, this.slotTypeFloor(t) - count - scalarNeed)
      for (let n = 0; n < declaredNeed; n++) longTailBucket.push(t)
    }

    const syncQueue = visibleBucket.concat(bufferBucket)
    this.drainPrewarmTypes(syncQueue)

    if (longTailBucket.length === 0 || this._prewarmBudgetMs <= 0) {
      this.drainPrewarmTypes(longTailBucket)
      this._prewarmComplete = true
      this._prewarmQueue.length = 0
      this._prewarmHead = 0
    } else {
      this._prewarmQueue = longTailBucket
      this._prewarmHead = 0
      this._prewarmComplete = false
      this.requestUpdateTick()
    }
  }

  private readTypePoolMinimums(): void {
    this._typePoolMinimums.clear()
    const getMinimums = this.adapter?.getTypePoolMinimums
    if (getMinimums === undefined || this._totalItems === 0) return
    const minimums = getMinimums.call(this.adapter, this.computeRingSize())
    for (const [type, minimum] of minimums) {
      if (!Number.isFinite(minimum) || minimum < 0 || !Number.isInteger(minimum)) {
        log.w(`getTypePoolMinimums returned an invalid minimum for ${type}: ${minimum}`)
        continue
      }
      if (minimum > 0) this._typePoolMinimums.set(type, minimum)
    }
  }

  private slotTypeFloor(type: string): number {
    return Math.max(this._minSlotsPerType, this._typePoolMinimums.get(type) ?? 0)
  }

  private drainPrewarmTypes(types: string[]): void {
    if (types.length === 0 || !this._layout) return
    const newItems: FlexItem[] = []
    for (const t of types) {
      const slot = this.createPoolItem(t, true)
      if (slot < 0) return
      this._stats.recordGrow(t)
      newItems.push(this._poolItems[slot])
      // Off-ring spare — park until the recycle path picks it up.
      this.parkSlot(slot)
    }
    this._layout.addItems(newItems)
    this.ensureRebindScratch(this._poolObjects.length)
  }

  /**
   * UpdateEvent tick: drain `_prewarmQueue` for up to `_prewarmBudgetMs`
   * per frame. Marks `_prewarmComplete` when empty.
   */
  private tickPrewarmQueue(): void {
    if (this._prewarmComplete || this._prewarmHead >= this._prewarmQueue.length || !this._layout) return
    // Hold off during active scroll — `createPoolItem` is heavy and steals
    // time from the input thread.
    if (this._isUserScrolling) return
    const budgetSec = this._prewarmBudgetMs / 1000
    const start = this.getTimeSec()
    const newItems: FlexItem[] = []
    while (this._prewarmHead < this._prewarmQueue.length) {
      const t = this._prewarmQueue[this._prewarmHead++]
      const slot = this.createPoolItem(t, true)
      if (slot < 0) break
      this._stats.recordGrow(t)
      // Off-ring spare — park until rebindRange recycles it (matches drainPrewarmTypes).
      this.parkSlot(slot)
      newItems.push(this._poolItems[slot])
      if (this.getTimeSec() - start >= budgetSec) break
    }
    if (newItems.length > 0) {
      this._layout.addItems(newItems)
      this.ensureRebindScratch(this._poolObjects.length)
    }
    if (this._prewarmHead >= this._prewarmQueue.length) {
      this._prewarmComplete = true
      this._prewarmQueue.length = 0
      this._prewarmHead = 0
    }
  }

  /**
   * Drain `_scrollDeferredGrowsPending` at `DRAIN_GROWS_PER_FRAME` per tick.
   * Paused during scroll and during `applyDataChange`.
   */
  private tickDeferredGrowDrain(): void {
    if (!this._scrollDeferredGrowsPending) return
    if (this._isUserScrolling) return
    if (this._isUpdatingData) return
    if (this._lastFirstVisibleDataIndex < 0) {
      this._scrollDeferredGrowsPending = false
      return
    }
    this._scrollDeferredGrowsPending = false
    this._drainingDeferredGrows = true
    try {
      const startIndex = this.clampRebindStart(this._lastFirstVisibleDataIndex - this._bufferCount)
      this.rebindRange(startIndex)
    } finally {
      // Reset even when `rebindRange` early-returned via `!_initialized`.
      this._drainingDeferredGrows = false
    }
  }

  private clampRebindStart(requestedStartIndex: number): number {
    return clampVirtualizedWindowStart(requestedStartIndex, this.totalItems, this.computeRingSize())
  }

  /**
   * Drop one pending prewarm entry for `type` so a synchronous grow-on-miss
   * doesn't race into double-allocating. Operates on the un-drained tail.
   */
  private consumePendingPrewarmForType(type: string): void {
    if (this._prewarmComplete) return
    for (let i = this._prewarmHead; i < this._prewarmQueue.length; i++) {
      if (this._prewarmQueue[i] === type) {
        this._prewarmQueue.splice(i, 1)
        if (this._prewarmHead >= this._prewarmQueue.length) {
          this._prewarmComplete = true
          this._prewarmQueue.length = 0
          this._prewarmHead = 0
        }
        return
      }
    }
  }

  /**
   * One-time warning (per type, per session) when `rebindRange` synthesizes
   * a pool slot mid-scroll. Actionable on the consumer side via wider
   * prewarm coverage.
   */
  private maybeWarnGrowOnMiss(type: string): void {
    if (!this._isUserScrolling) return
    if (this._warnedGrowOnMissTypes === null) this._warnedGrowOnMissTypes = new Set<string>()
    if (this._warnedGrowOnMissTypes.has(type)) return
    this._warnedGrowOnMissTypes.add(type)
    log.w(
      `VirtualizedLayout: synchronous grow-on-miss for type "${type}" during active scroll — ` +
        "expect a one-frame hitch. Widen prewarm coverage by ensuring this type appears within " +
        "the first visibleSlots*4 rows during discovery, or pre-touch via scrollToIndex before fling."
    )
  }

  /**
   * Destroy pool slots idle longer than `shrinkDelayMs`, subject to the
   * `minSlotsPerType` floor. Visible-type slots are preserved regardless of
   * idle time; types absent from current data bypass the floor entirely.
   */
  private tickShrinkGC(): void {
    if (this._shrinkDelayMs <= 0) {
      this._hasPendingShrinkWork = false
      return
    }
    if (this._poolObjects.length === 0) {
      this._hasPendingShrinkWork = false
      return
    }
    const now = this.getTimeSec()
    if (now - this._lastShrinkTick < SHRINK_GC_TICK_INTERVAL_SEC) return
    this._lastShrinkTick = now
    const shrinkDelaySec = this._shrinkDelayMs / 1000

    // Cheap pre-scan — fully-bound pools exit here with no heap touches.
    let anyEligible = false
    for (let s = 0; s < this._poolObjects.length; s++) {
      if (this._dataIndices[s] >= 0) continue
      const lastUsed = this._lastUsedTime[s]
      if (lastUsed >= 0 && now - lastUsed >= shrinkDelaySec) {
        anyEligible = true
        break
      }
    }
    if (!anyEligible) {
      this.refreshPendingShrinkWork(false)
      return
    }

    // Slots occupying a ring position must survive regardless of `_dataIndices`:
    // a past-end ring slot carries `di = -1` but destroying it drops the pool
    // below ringSize, leaving stale entries in `rebindRange`'s newRingOrder.
    const ringSlots = new Set<number>(this._ringOrder)

    const typeCounts = new Map<string, number>(this._slotTypeCounts)

    // Types currently visible — protect from shrink.
    const visibleTypes = this.collectVisibleTypesForShrink()

    // Types absent from this set are dead — destroy all of them, bypassing the floor.
    const liveDataTypes = this.liveDataTypesForShrink()

    // Identify candidates; compact in a single pass below. Indexed by
    // `destroyCount`, not `.length`, so length-clamping is fine.
    const toDestroy = this._shrinkToDestroyScratch
    let destroyCount = 0
    for (let s = 0; s < this._poolObjects.length; s++) {
      if (this._dataIndices[s] >= 0) continue
      const t = this._slotTypes[s] ?? VL_DEFAULT_TYPE
      const live = this.isLiveDataTypeForShrink(t, liveDataTypes)
      // Past-end ring placeholders can be reclaimed once their type is dead;
      // live placeholders still preserve ring shape until the next rebind.
      if (ringSlots.has(s) && live) continue
      const lastUsed = this._lastUsedTime[s]
      // `< 0` is a defensive opt-out for any future seeding path.
      if (lastUsed < 0 || now - lastUsed < shrinkDelaySec) continue
      if (visibleTypes.has(t)) continue
      const count = typeCounts.get(t) ?? 0
      // Floor only applies to live types.
      if (live && count <= this.slotTypeFloor(t)) continue
      toDestroy[destroyCount++] = s
      typeCounts.set(t, count - 1)
    }
    if (destroyCount === 0) {
      this._hasPendingShrinkWork = this.hasShrinkWorkPending(ringSlots, liveDataTypes, visibleTypes)
      return
    }

    // In-place compact: `keptCount` trails `readIdx` so overwrites never
    // clobber a slot we still need to read.
    const oldPoolSize = this._poolObjects.length
    const removedItems = this._shrinkRemovedItemsScratch
    removedItems.length = 0
    // Old → new slot index map for the ring-order remap.
    const indexMap = this._shrinkIndexMapScratch
    if (indexMap.length < oldPoolSize) indexMap.length = oldPoolSize
    // `toDestroy` is populated in ascending `readIdx` order, so a single forward cursor works.
    let destroyCursor = 0
    let keptCount = 0
    for (let readIdx = 0; readIdx < oldPoolSize; readIdx++) {
      if (destroyCursor < destroyCount && toDestroy[destroyCursor] === readIdx) {
        this._retainedRefreshSlots.delete(readIdx)
        this._retainedIndexSlots.delete(readIdx)
        destroyCursor++
        indexMap[readIdx] = -1
        const item = this._poolItems[readIdx]
        if (item) removedItems.push(item)
        const removedType = this._slotTypes[readIdx] ?? VL_DEFAULT_TYPE
        const obj = this._poolObjects[readIdx]
        this.fireDestroyItem(readIdx)
        if (!this._initialized) return
        this.clearSlotSubColliderState(readIdx)
        if (obj && !isNull(obj)) obj.destroy()
        this.decrementSlotTypeCount(removedType)
        this._stats.recordShrink(removedType)
        continue
      }
      indexMap[readIdx] = keptCount
      if (this._retainedRefreshSlots.delete(readIdx)) this._retainedRefreshSlots.add(keptCount)
      if (this._retainedIndexSlots.delete(readIdx)) this._retainedIndexSlots.add(keptCount)
      if (keptCount !== readIdx) {
        this._poolObjects[keptCount] = this._poolObjects[readIdx]
        this._poolItems[keptCount] = this._poolItems[readIdx]
        this._dataIndices[keptCount] = this._dataIndices[readIdx]
        this._lastAlpha[keptCount] = this._lastAlpha[readIdx]
        this._poolTexts[keptCount] = this._poolTexts[readIdx]
        this._poolImages[keptCount] = this._poolImages[readIdx]
        this._poolTextFills[keptCount] = this._poolTextFills[readIdx]
        this._poolImageMainPasses[keptCount] = this._poolImageMainPasses[readIdx]
        this._poolTextRGB[keptCount] = this._poolTextRGB[readIdx]
        this._poolImageRGB[keptCount] = this._poolImageRGB[readIdx]
        this._poolClippables[keptCount] = this._poolClippables[readIdx]
        this._poolClippableTransforms[keptCount] = this._poolClippableTransforms[readIdx]
        this._poolClippableInteractables[keptCount] = this._poolClippableInteractables[readIdx]
        this._poolColliders[keptCount] = this._poolColliders[readIdx]
        this._poolSubColliders[keptCount] = this._poolSubColliders[readIdx]
        this._poolSubColliderTransforms[keptCount] = this._poolSubColliderTransforms[readIdx]
        this._poolSubColliderProviders[keptCount] = this._poolSubColliderProviders[readIdx]
        this._poolSubColliderDirtyUnsubscribes[keptCount] = this._poolSubColliderDirtyUnsubscribes[readIdx]
        this._poolHolders[keptCount] = this._poolHolders[readIdx]
        // Clear the vacated source; until truncation the holder aliases two slots
        // and a reentrant teardown would fire onDestroyView on it twice.
        this._poolHolders[readIdx] = null
        this._slotKeys[keptCount] = this._slotKeys[readIdx]
        this._slotTypes[keptCount] = this._slotTypes[readIdx]
        this._lastUsedTime[keptCount] = this._lastUsedTime[readIdx]
        this._slotVisible[keptCount] = this._slotVisible[readIdx]
      }
      keptCount++
    }
    this._poolObjects.length = keptCount
    this._poolItems.length = keptCount
    this._dataIndices.length = keptCount
    this._lastAlpha.length = keptCount
    this._poolTexts.length = keptCount
    this._poolImages.length = keptCount
    this._poolTextFills.length = keptCount
    this._poolImageMainPasses.length = keptCount
    this._poolTextRGB.length = keptCount
    this._poolImageRGB.length = keptCount
    this._poolClippables.length = keptCount
    this._poolClippableTransforms.length = keptCount
    this._poolClippableInteractables.length = keptCount
    this._poolColliders.length = keptCount
    this._poolSubColliders.length = keptCount
    this._poolSubColliderTransforms.length = keptCount
    this._poolSubColliderProviders.length = keptCount
    this._poolSubColliderDirtyUnsubscribes.length = keptCount
    this._poolHolders.length = keptCount
    this._slotKeys.length = keptCount
    this._slotTypes.length = keptCount
    this._lastUsedTime.length = keptCount
    this._slotVisible.length = keptCount

    // In-place ring remap using the same trailing-write-pointer pattern.
    let ringKeptCount = 0
    for (let readIdx = 0; readIdx < this._ringOrder.length; readIdx++) {
      const mapped = indexMap[this._ringOrder[readIdx]]
      if (mapped >= 0) this._ringOrder[ringKeptCount++] = mapped
    }
    this._ringOrder.length = ringKeptCount

    // Compacting reshuffled every remaining slot's index; the SceneObject→slot
    // map needs a full rebuild rather than incremental updates.
    this._slotBySceneObject.clear()
    for (let i = 0; i < this._poolObjects.length; i++) {
      this._slotBySceneObject.set(this._poolObjects[i], i)
    }
    if (this._layout && removedItems.length > 0) {
      this._layout.removeItems(removedItems)
    }
    this.ensureRebindScratch(this._poolObjects.length)
    this._hasPendingShrinkWork = this.hasShrinkWorkPending(
      new Set<number>(this._ringOrder),
      liveDataTypes,
      visibleTypes
    )
    // Pool indices shifted under the clip pass — next LateUpdate must re-run.
    this._lastClipScroll = NaN
    this.markClipDirty()
  }

  /**
   * Measure-on-bind: if `_needsMeasure[dataIndex]` is set (adapter.getItemSize
   * returned undefined for this index), measure the slot's content via
   * ItemHandlerRegistry and update `_sizes` if the measurement differs.
   * Called from fireBindItem after adapter.onBindView has set up the content.
   *
   * Off-screen-shift caveat: measuring a buffer-zone item shifts items below
   * it; sub-pixel for measurements close to the default stride.
   */
  private maybeMeasureSlot(slot: number, dataIndex: number): void {
    if (!this._metadata.needsMeasureAt(dataIndex)) return
    const obj = this._poolObjects[slot]
    if (!obj || isNull(obj)) return
    const resolved = ItemHandlerRegistry.resolve(obj)
    if (!resolved) return
    const transform = obj.getTransform()
    const dims = resolved.handler.measure(obj, resolved.component, transform)
    const measured = this._isVertical ? dims.preferred.height : dims.preferred.width
    if (!(measured > 0)) return
    if (this._deferMeasureSideEffects) {
      // Capture the anchor on the first deferred measure of this window —
      // BEFORE mutating `_sizes` — so flushDeferredMeasures restores against
      // pre-mutation geometry.
      if (this._pendingMeasureMinIdx === Number.MAX_SAFE_INTEGER) {
        this._deferredMeasureAnchor = this.captureAnchor()
      }
    }
    const changed = this._metadata.setMeasuredSize(dataIndex, measured)
    if (!changed) return
    if (this._deferMeasureSideEffects) {
      // Track the lowest changed dataIndex so flushDeferredMeasures rebuilds
      // cumulatives from there in one pass.
      if (dataIndex < this._pendingMeasureMinIdx) {
        this._pendingMeasureMinIdx = dataIndex
      }
      return
    }
    this.rebuildCumulativesFrom(dataIndex)
    this.setTotalContentSize(this.computeTotalContentSize(this._totalItems))
    this.applyItemSizeToSlot(slot, measured)
    if (this._scrollWindow) {
      this.setScrollDimensions(Math.max(this._totalContentSize, this._viewportMain))
    }
    this.recomputeFadeInvariants()
    this._lastFadeScroll = NaN
    this._lastClipScroll = NaN
    this.markClipDirty()
    this.notifyContentSizeChangedIfNeeded()
  }

  /**
   * Batched apply after the initial-fill measure window: rebuild cumulatives
   * from the lowest measured index and push content size + fade invariants
   * in one pass.
   */
  private flushDeferredMeasures(): void {
    const minIndex = this._pendingMeasureMinIdx
    this._pendingMeasureMinIdx = Number.MAX_SAFE_INTEGER
    // Anchor was captured in maybeMeasureSlot on the first deferred measure,
    // before `_sizes` was mutated, so it reflects pre-mutation geometry;
    // restoring against it keeps the visible row from jumping when measured
    // sizes differ from the estimate.
    const anchor = this._deferredMeasureAnchor
    this._deferredMeasureAnchor = null
    if (minIndex === Number.MAX_SAFE_INTEGER) return
    for (let s = 0; s < this._dataIndices.length; s++) {
      const di = this._dataIndices[s]
      if (di < 0) continue
      // The -1 sentinel must not propagate into FlexItem overrides.
      this.applyItemSizeToSlot(s, this.itemSizeForIndex(di))
    }
    this.rebuildCumulativesFrom(minIndex)
    this.setTotalContentSize(this.computeTotalContentSize(this._totalItems))
    if (this._scrollWindow) {
      this.setScrollDimensions(Math.max(this._totalContentSize, this._viewportMain))
    }
    this.recomputeFadeInvariants()
    // restoreAnchor's setScrollPosition fires onScrollPositionUpdated synchronously;
    // this runs inside rebindRange, so suppress the re-entrant rebind that would
    // clobber its shared scratch, then resync the layout offset by hand.
    if (anchor !== null && this._scrollWindow) {
      const prevUpdating = this._isUpdatingData
      this._isUpdatingData = true
      this.restoreAnchor(anchor)
      this._isUpdatingData = prevUpdating
      const scroll = this.getScrollMainAxis(this._scrollWindow.scrollPosition)
      this.updateLayoutOffset(this.clampRebindStart(this.computeFirstVisibleSlot(scroll) - this._bufferCount))
    }
    this._lastFadeScroll = NaN
    this._lastClipScroll = NaN
    this.markClipDirty()
    // Fired from inside the suspended outer rebindRange; suppress a handler's
    // re-entrant scroll rebind so it cannot clobber the shared rebind scratch.
    const prevUpdatingNotify = this._isUpdatingData
    this._isUpdatingData = true
    try {
      this.notifyContentSizeChangedIfNeeded()
    } finally {
      this._isUpdatingData = prevUpdatingNotify
    }
  }

  /**
   * Enable/disable a slot's descendant colliders. Gated by `_collidersForcedOff`:
   * enable requests are no-ops during scroll motion. `applyScrollMotionColliderState`
   * is the only path that bypasses the gate.
   */
  private setSlotCollidersEnabled(s: number, enabled: boolean): void {
    if (this._collidersForcedOff && enabled) return
    this.setSlotCollidersEnabledRaw(s, enabled)
  }

  /** Batched variant — pre-resolved `debugMode` skips the per-slot IM lookup. */
  private setSlotCollidersEnabledBatched(s: number, enabled: boolean, debugMode: boolean): void {
    if (this._collidersForcedOff && enabled) return
    this.setSlotCollidersEnabledRaw(s, enabled, debugMode)
  }

  private applySlotSubColliderState(
    collider: ColliderComponent,
    provider: ClipColliderProvider,
    band: ClipBand,
    slotVisible: boolean,
    debugMode: boolean,
    forceWrite: boolean = false
  ): void {
    const providerEnabled = provider.isClipColliderEnabled ? provider.isClipColliderEnabled(collider) : true
    const effectiveEnabled = slotVisible && providerEnabled && band === "fullyVisible"
    const effectiveDebugDraw = effectiveEnabled && debugMode
    const previous = this._subColliderClipStates.get(collider)
    if (
      !forceWrite &&
      previous?.band === band &&
      previous.enabled === effectiveEnabled &&
      previous.debugDrawEnabled === effectiveDebugDraw
    ) {
      return
    }
    if (forceWrite || previous?.enabled !== effectiveEnabled) {
      collider.enabled = effectiveEnabled
    }
    if (forceWrite || previous?.debugDrawEnabled !== effectiveDebugDraw) {
      collider.debugDrawEnabled = effectiveDebugDraw
    }
    this._subColliderClipStates.set(collider, {
      band,
      enabled: effectiveEnabled,
      debugDrawEnabled: effectiveDebugDraw
    })
  }

  /**
   * Direct collider write (no `_collidersForcedOff` gating). Subtree
   * mutations require `invalidate(range, "structure")` to refresh the cache.
   */
  private setSlotCollidersEnabledRaw(s: number, enabled: boolean, debugMode?: boolean): void {
    const obj = this._poolObjects[s]
    if (!obj || isNull(obj)) return
    const colliders = this._poolColliders[s]
    if (!colliders) return
    const dbg = debugMode ?? InteractionManager.getInstance().debugModeEnabled
    const debugDraw = enabled && dbg
    for (let i = 0; i < colliders.length; i++) {
      const collider = colliders[i]
      if (!collider || isNull(collider)) continue
      const provider = this._subColliderProviders.get(collider)
      if (provider) {
        const band = this._subColliderClipStates.get(collider)?.band ?? "fullyVisible"
        this.applySlotSubColliderState(collider, provider, band, enabled, dbg, true)
        continue
      }
      collider.enabled = enabled
      collider.debugDrawEnabled = debugDraw
    }
  }

  /**
   * Mirror `_slotVisible[s]` into IM's interactables set so updateInteractors
   * cost scales with visible window, not pool size. Idempotent.
   */
  private setSlotIMRegistered(s: number, registered: boolean): void {
    const clippables = this._poolClippables[s]
    if (!clippables || clippables.length === 0) return
    const im = InteractionManager.getInstance()
    for (let i = 0; i < clippables.length; i++) {
      const interactable = clippables[i].interactable
      if (!interactable || isNull(interactable)) continue
      if (registered) {
        im.registerInteractable(interactable)
      } else {
        im.deregisterInteractable(interactable)
      }
    }
  }

  /**
   * Force every slot's colliders to match `_slotVisible`. Call after
   * `rebindRange` + `forceFlexLayout`. Always writes — Element's
   * OnEnableEvent can re-enable managed colliders, so we can't short-circuit.
   */
  private updateSlotVisibilities(): void {
    if (this._poolObjects.length === 0) return
    const hasRange = this.computeVisibleRangeInto(this._visibleRangeScratch)
    const first = hasRange ? this._visibleRangeScratch.first : 0
    const last = hasRange ? this._visibleRangeScratch.last : -1
    let anyFlipped = false
    let anyEnabledColliders = false
    const debugMode = InteractionManager.getInstance().debugModeEnabled
    for (let s = 0; s < this._poolObjects.length; s++) {
      const di = this._dataIndices[s]
      const visible = di >= 0 && di >= first && di <= last
      if (this._slotVisible[s] !== visible) {
        anyFlipped = true
        this.setSlotIMRegistered(s, visible)
      }
      this._slotVisible[s] = visible
      const colliders = this._poolColliders[s]
      // A visible-slot write can revive a physically clipped collider.
      if (visible && colliders && colliders.length > 0) anyEnabledColliders = true
      this.setSlotCollidersEnabledBatched(s, visible, debugMode)
    }
    if (anyFlipped || anyEnabledColliders) {
      this._lastClipScroll = NaN
      this.markClipDirty()
    }
    this.refreshPendingShrinkWork(true, true)
  }

  /** Run FlexLayout synchronously so slot transforms are settled before we return. */
  private forceFlexLayout(): void {
    if (!this._layout) return
    this._layout.forceLayout()
  }

  /**
   * Shrink each visible slot's Element interactables to the portion inside
   * viewport bounds when scroll/layout changes, and keep explicit sub-collider
   * gates in sync while their provider transforms move independently.
   */
  private clipVisibleInteractables(): void {
    if (!this._scrollWindow || this._poolObjects.length === 0) return
    if (this._collidersForcedOff) return
    const scrollMain = this._lastScrollMain
    const clipElements = this._clipDirty || scrollMain !== this._lastClipScroll
    const clipSubColliders = this._subColliderClipDirty || scrollMain !== this._lastClipScroll
    if (!clipElements && !clipSubColliders) return
    const swTransform = this._scrollWindowTransform
    if (!swTransform || isNull(swTransform)) return
    // Viewport bounds are centered on the ScrollWindow origin in its local
    // space; comparing there keeps local-space sizes consistent under world scale.
    const half = this._viewportMain * 0.5
    const mainPositive = half
    const mainNegative = -half
    const swInverted = this.getScrollWindowInverted(swTransform)
    const debugMode = InteractionManager.getInstance().debugModeEnabled

    for (let s = 0; s < this._poolObjects.length; s++) {
      const slotVisible = this._slotVisible[s]
      if (slotVisible && clipElements) {
        const clippables = this._poolClippables[s]
        const transforms = this._poolClippableTransforms[s]
        const interactables = this._poolClippableInteractables[s]
        for (let i = 0; i < clippables.length; i++) {
          let interactable = interactables[i]
          let hasInteractable = interactable != null && !isNull(interactable)
          if (!hasInteractable) {
            // Interactable may have been created after slot discovery (Element onStart).
            interactable = clippables[i].interactable
            hasInteractable = interactable != null && !isNull(interactable)
            if (hasInteractable) interactables[i] = interactable
          }
          this.applyClipBand(
            clippables[i],
            transforms[i],
            interactable,
            hasInteractable,
            swInverted,
            mainPositive,
            mainNegative
          )
        }
      }
      if (clipSubColliders && this._poolSubColliders[s]?.length > 0) {
        if (slotVisible) {
          this.clipSlotSubColliders(s, swInverted, mainPositive, mainNegative, debugMode)
        } else {
          this.applySlotSubColliderVisibilityMask(s, debugMode)
        }
      }
    }
    if (clipElements || clipSubColliders) {
      this._lastClipScroll = scrollMain
    }
    if (clipElements) {
      this._clipDirty = false
    }
    if (clipSubColliders) {
      this._subColliderClipDirty = false
      this._subColliderClipForceWriteProviders.clear()
    }
  }

  /**
   * Compute the band for a single clippable element and write its collider
   * state. `transform` / `interactable` are pre-resolved refs.
   */
  private applyClipBand(
    el: ClippableElement,
    transform: Transform,
    interactable: Interactable,
    hasInteractable: boolean,
    swInverted: mat4,
    mainPositive: number,
    mainNegative: number
  ): void {
    const lastBand = this._clipBands.get(el)
    // No scroll-delta hysteresis: rebindRange moves slot world position without a
    // proportional scroll delta, so a stale fullyVisible cache would leak colliders.
    if (!transform || isNull(transform)) return
    const localPos = swInverted.multiplyPoint(transform.getWorldPosition())
    const elSize = el.size
    const elHalf = (this._isVertical ? elSize.y : elSize.x) * 0.5
    const elMain = this._isVertical ? localPos.y : localPos.x
    const elPositive = elMain + elHalf
    const elNegative = elMain - elHalf

    let band: ClipBand
    if (elNegative >= mainPositive || elPositive <= mainNegative) {
      band = "hidden"
    } else if (elPositive <= mainPositive && elNegative >= mainNegative) {
      band = "fullyVisible"
    } else {
      band = "partial"
    }

    if (band === "hidden") {
      // Clamp every tick, NOT just on transition. `updateSlotVisibilities`
      // and `applyScrollMotionColliderState` re-write `collider.enabled = true`
      // whenever `_slotVisible[s]` is true, and `_slotVisible` is computed
      // from the data-index range — not actual world position. A slot whose
      // data sits in [first..last] but whose physical position is past the
      // viewport edge gets its collider re-enabled by VL each tick, defeating
      // a one-shot transition disable. IK's raycast resolves the collider
      // via `colliderToInteractableMap` and fires Interactable events
      // regardless of `interactable.enabled`, so a re-enabled collider is
      // fully hit-testable from a consumer's `onTriggerUp` handler.
      if (hasInteractable) {
        interactable.enabled = false
        const cols = interactable.colliders
        for (let i = 0; i < cols.length; i++) {
          const c = cols[i]
          if (!isNull(c) && !this._subColliderProviders.has(c)) c.enabled = false
        }
      }
      if (lastBand !== "hidden") this._clipBands.set(el, "hidden")
      return
    }

    // Back out of the hidden band, the slot takes input again unless its element is inactive:
    // Element keeps an inactive element's Interactable and collider off, and turning them on here
    // would give an inactive row hover, press and drag again until something re-applies inactive.
    if (hasInteractable && (lastBand === "hidden" || lastBand === undefined) && !el.inactive) {
      interactable.enabled = true
      const cols = interactable.colliders
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i]
        if (!isNull(c) && !this._subColliderProviders.has(c)) c.enabled = true
      }
    }

    if (band === "fullyVisible") {
      if (lastBand !== "fullyVisible") {
        el.colliderFitElement = true
        this._clipBands.set(el, "fullyVisible")
      }
      return
    }

    // Partial: visible band size depends on live scroll.
    const visiblePositive = Math.min(elPositive, mainPositive)
    const visibleNegative = Math.max(elNegative, mainNegative)
    const visibleSize = visiblePositive - visibleNegative
    const centerOffset = (visiblePositive + visibleNegative) * 0.5 - elMain

    el.colliderFitElement = false
    const sizeScratch = this._clipSizeScratch
    const centerScratch = this._clipCenterScratch
    if (this._isVertical) {
      sizeScratch.x = elSize.x
      sizeScratch.y = visibleSize
      sizeScratch.z = elSize.z
      centerScratch.x = 0
      centerScratch.y = centerOffset
      centerScratch.z = 0
    } else {
      sizeScratch.x = visibleSize
      sizeScratch.y = elSize.y
      sizeScratch.z = elSize.z
      centerScratch.x = centerOffset
      centerScratch.y = 0
      centerScratch.z = 0
    }
    el.colliderSize = sizeScratch
    el.colliderCenter = centerScratch
    this._clipBands.set(el, "partial")
  }

  private getSubColliderMainAxisScale(worldTransform: mat4, swInverted: mat4): number {
    const axis = this._subColliderAxisScratch
    axis.x = this._isVertical ? 0 : 1
    axis.y = this._isVertical ? 1 : 0
    axis.z = 0
    const worldAxis = worldTransform.multiplyDirection(axis)
    const swAxis = swInverted.multiplyDirection(worldAxis)
    return this._isVertical ? swAxis.y : swAxis.x
  }

  private clipSlotSubColliders(
    slot: number,
    swInverted: mat4,
    mainPositive: number,
    mainNegative: number,
    debugMode: boolean
  ): void {
    const colliders = this._poolSubColliders[slot]
    if (!colliders || colliders.length === 0) return
    const transforms = this._poolSubColliderTransforms[slot]
    if (!transforms) return
    const providers = this._poolSubColliderProviders[slot]
    this.pruneDeadSlotSubColliders(slot)
    for (let i = 0; i < colliders.length; i++) {
      const collider = colliders[i]
      const transform = transforms[i]
      const provider = providers?.[i]
      if (!collider || isNull(collider) || !transform || isNull(transform)) continue
      if (!provider) continue
      const forceWrite = this._subColliderClipForceWriteProviders.has(provider)
      const shape = collider.shape
      if (!isBoxShapeLike(shape)) continue
      const size = shape.size

      const worldTransform = transform.getWorldTransform()
      const localPos = swInverted.multiplyPoint(transform.getWorldPosition())
      // Provider colliders are axis-aligned with the ScrollWindow; this converts
      // local collider cm to ScrollWindow-local cm under parent scale/reversed axes.
      const axisScale = this.getSubColliderMainAxisScale(worldTransform, swInverted)
      const axisScaleAbs = Math.abs(axisScale)
      if (axisScaleAbs < SUB_COLLIDER_AXIS_SCALE_EPSILON) {
        this.setSlotSubColliderClipBand(slot, collider, provider, "hidden", debugMode, forceWrite)
        continue
      }
      const subHalf = Math.abs((this._isVertical ? size.y : size.x) * axisScale) * 0.5
      const subMain = this._isVertical ? localPos.y : localPos.x
      const subPositive = subMain + subHalf
      const subNegative = subMain - subHalf

      if (subPositive <= mainPositive && subNegative >= mainNegative) {
        this.setSlotSubColliderClipBand(slot, collider, provider, "fullyVisible", debugMode, forceWrite)
        continue
      }

      this.setSlotSubColliderClipBand(slot, collider, provider, "hidden", debugMode, forceWrite)
    }
  }

  private applySlotSubColliderVisibilityMask(slot: number, debugMode: boolean): void {
    const colliders = this._poolSubColliders[slot]
    if (!colliders || colliders.length === 0) return
    const providers = this._poolSubColliderProviders[slot]
    this.pruneDeadSlotSubColliders(slot)
    for (let i = 0; i < colliders.length; i++) {
      const collider = colliders[i]
      const provider = providers?.[i]
      if (!collider || isNull(collider) || !provider) continue
      const band = this._subColliderClipStates.get(collider)?.band ?? "fullyVisible"
      this.applySlotSubColliderState(
        collider,
        provider,
        band,
        false,
        debugMode,
        this._subColliderClipForceWriteProviders.has(provider)
      )
    }
  }

  private setSlotSubColliderClipBand(
    slot: number,
    collider: ColliderComponent,
    provider: ClipColliderProvider,
    band: ClipBand,
    debugMode: boolean,
    forceWrite: boolean
  ): void {
    this.applySlotSubColliderState(collider, provider, band, this._slotVisible[slot] ?? false, debugMode, forceWrite)
  }

  /** Write `size` into slot's main-axis override; cross axis stays pinned. */
  private applyItemSizeToSlot(s: number, size: number): boolean {
    const item = this._poolItems[s]
    if (!item) return false
    const width = this._isVertical ? this._containerCrossSize : size
    const height = this._isVertical ? size : this._containerCrossSize
    const changed = item.overrideWidth !== width || item.overrideHeight !== height
    if (item.overrideWidth !== width) item.overrideWidth = width
    if (item.overrideHeight !== height) item.overrideHeight = height
    return changed
  }

  /**
   * Hide an unbound pooled slot. A deferred in-ring row reserves its target
   * size so subsequent rows keep their positions; an off-ring spare has no
   * reserved row size. FlexLayout includes disabled managed items, so even
   * zero-size spares still add gaps to its measured extent. Trailing spares
   * do not shift live rows under our Top/Left main-axis alignment.
   */
  private parkSlot(s: number, reservedSize: number = 0): void {
    const object = this._poolObjects[s]
    if (object && !isNull(object)) object.enabled = false
    this.applyItemSizeToSlot(s, reservedSize)
  }

  /**
   * Imperative teardown for consumers that pool/reuse hosts or need
   * deterministic release. Fires `onUnbindView` for bound slots, cascade-
   * destroys owned SceneObjects, and clears pools. Idempotent: a second
   * `destroy()` (or the `OnDestroyEvent`) no-ops. After `destroy()`, mutating
   * methods/setters throw; reads return empty/zero values.
   */
  public destroy(): void {
    this.cleanup()
  }

  private assertNotDestroyed(): void {
    if (this._destroyed) {
      throw new Error("VirtualizedLayout: method called after destroy()")
    }
  }

  private cleanup(): void {
    if (this._destroyed) return
    // Flip first so re-entries from synchronous adapter callbacks bail on
    // their initialized-guard.
    this._initialized = false
    this._contentSizeNotificationsEnabled = false
    this._destroyed = true
    // Invalidate any pending onScrollIdle setTimeout via its captured counter.
    this._scrollIdleCounter++

    if (this._updateEvent) this._updateEvent.enabled = false
    if (this._lateUpdateEvent) this._lateUpdateEvent.enabled = false

    for (const dispose of this._disposers) {
      dispose()
    }
    this._disposers = []

    // Fire adapter.onUnbindView while SceneObjects are still alive so
    // consumers can release per-slot resources before cascade-destroy.
    for (let i = 0; i < this._poolObjects.length; i++) {
      const dataIndex = this._dataIndices[i]
      const obj = this._poolObjects[i]
      const holder = this._poolHolders[i]
      if (dataIndex >= 0 && obj && !isNull(obj) && holder !== null) {
        if (this.adapter?.onUnbindView) {
          this.adapter.onUnbindView(obj, holder, dataIndex)
        }
        this._stats.recordUnbind()
      }
    }
    // Every remaining slot is permanently reclaimed by the cascade destroy below.
    for (let i = 0; i < this._poolHolders.length; i++) {
      this.fireDestroyItem(i)
    }
    // Drop consumer-supplied references so a dangling consumer can't outlive VL.
    // Write the backing field directly; the `adapter` setter guards on
    // `_destroyed`, which is already true here.
    this._adapter = null
    this._itemAlphaHandler = null
    this._pendingScroll = null
    this._pendingScrollIndex = null
    this._pendingScrollKey = null
    this._pendingAlignTarget = null
    // Clear queued drains so a destroy() from a synchronous callback cannot leave
    // a post-notify drain calling invalidate()/applySnapshot() after teardown.
    this._pendingInvalidate = null
    this._pendingSnapshot = false

    for (let i = 0; i < this._poolSubColliderDirtyUnsubscribes.length; i++) {
      this.clearSlotSubColliderDirtySubscriptions(i)
    }

    // Cascade destroy: destroying the owned ScrollWindow SO takes the whole subtree.
    if (this._scrollWindow && !isNull(this._scrollWindow)) {
      const swObj = this._scrollWindow.sceneObject
      if (swObj && !isNull(swObj)) {
        swObj.destroy()
      }
    }
    this._scrollWindow = null
    this._layout = null
    this._layoutTransform = null
    this._scrollWindowTransform = null
    this._lateUpdateEvent = null
    this._updateEvent = null

    this._poolObjects = []
    this._poolItems = []
    this._dataIndices = []
    this._lastAlpha = []
    this._poolTexts = []
    this._poolImages = []
    this._poolTextFills = []
    this._poolImageMainPasses = []
    this._poolTextRGB = []
    this._poolImageRGB = []
    this._poolClippables = []
    this._poolClippableTransforms = []
    this._poolClippableInteractables = []
    this._poolColliders = []
    this._poolSubColliders = []
    this._poolSubColliderTransforms = []
    this._poolSubColliderProviders = []
    this._poolSubColliderDirtyUnsubscribes = []
    this._poolHolders = []
    this._slotKeys = []
    this._retainedRefreshSlots.clear()
    this._retainedIndexSlots.clear()
    this._slotTypes = []
    this._slotTypeCounts.clear()
    this._subColliderClipStates = new WeakMap()
    this._subColliderProviders = new WeakMap()
    this._lastUsedTime = []
    this._slotVisible = []
    this._slotBySceneObject.clear()
    this._ringOrder = []
    this._metadata.reset()
    this._keyToIndex = null
    // Reset so the `totalItems` getter (unguarded) doesn't report a stale count.
    this._totalItems = 0
    this._pendingRemeasure.clear()
    this._pendingRemeasureSwap.clear()
    this._prewarmQueue.length = 0
    this._prewarmHead = 0
    this._prewarmComplete = true
    this._typePoolMinimums.clear()
    this._hasPendingShrinkWork = false
    this._warnedGrowOnMissTypes = null
    this._scrollLayoutDirty = false
    this._clipDirty = true
    this._subColliderClipDirty = true
    this._swInverted = null
    this._swWorld = null
    this._subColliderClipForceWriteProviders.clear()
  }
}

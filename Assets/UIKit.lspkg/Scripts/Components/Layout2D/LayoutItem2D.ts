// ═══════════════════════════════════════════════════════════════════════════
// LayoutItem2D.ts — Abstract base class for per-item layout components.
//
// Shared between FlexItem and GridItem. Handles:
// - Handler resolution via ItemHandlerRegistry.resolve() on OnStart
// - Parent layout reference and dirty propagation
// - Allocated size tracking
// - measureIntrinsic() / measure() / applyLayout() delegation to handler
//
// Usage patterns:
// 1. **Recognized content** (Element, Shape, Text, Image, mesh, etc.) — drop
//    a FlexItem/GridItem on the SceneObject; the matching handler resolves
//    automatically and provides intrinsic sizing.
// 2. **Naked LayoutItem2D with overrides** — attach a FlexItem/GridItem to a
//    SceneObject that has *no* handler-recognizable content and set
//    `overrideWidth` / `overrideHeight`. Preferred falls back to those
//    overrides; min/max default to user clamps (or 0 / ∞). This is the
//    canonical pattern for shaping containers around content the registry
//    can't introspect.
// 3. **Custom handler** — implement `ItemHandler` and call
//    `ItemHandlerRegistry.register(handler, priority)` to teach the system
//    a new content type. See ItemHandlerRegistry.register's JSDoc.
// ═══════════════════════════════════════════════════════════════════════════

import {LayoutPreparation, LayoutPresentation, PresentationRequest} from "./LayoutPresentation"
export type {PresentationRequest} from "./LayoutPresentation"

import {ContentMeasurement, FIT_CONTENT_PENDING, ItemHandler, ItemHandlerRegistry, Size} from "./ItemHandlerRegistry"
// UIKit-specific handlers (Element, Shape, LayoutContainer, StandaloneContent,
// CustomFlexContainer) are NOT imported here. They register themselves via
// `Assets/UIKit/Scripts/UIKitBootstrap.ts`, which is imported in
// turn from UIKit's top-level component files (Element, Frame, ScrollWindow,
// ProgressBar, ElementContent). Keeping this layer free of UIKit imports
// lets Layout2D ship standalone — apps that only want native handlers
// (Text / Image / mesh / collider) don't pay for UIKit code they don't use.

/**
 * What an item knows about its owner. `markDirty` is the long-standing
 * contract every custom owner satisfies. `presentSynchronously` is the
 * optional presentation capability FlexLayout and GridLayout implement: run a
 * prepared commit and settle geometry from the outermost owner inward,
 * so a control's new label, its size, and its neighbours' positions land in
 * the same rendered frame regardless of which LateUpdate ran first.
 *
 * Returns `"completed"` when the commit and the geometry pass ran, or
 * `"queued"` when required measurements are pending or the owner is busy.
 * Pending measurements use the caller's bounded retries; busy owners drain
 * queued requests after their pass, under `isCurrent`. The caller keeps its old
 * coherent presentation. A cyclic chain or one exceeding eight participating
 * owners also returns `"queued"` without committing; the caller's bounded retry
 * lifecycle owns recovery. Custom owners can expose `presentation` to join the
 * same transaction when nested with Flex/Grid.
 */
export interface LayoutOwner {
  markDirty(): void
  readonly presentation?: LayoutPresentation
  presentSynchronously?(request: PresentationRequest): "completed" | "queued"
}

/** Shared handler resolution, ownership, measurement, and allocation for Flex/Grid items. */
export abstract class LayoutItem2D extends BaseScriptComponent {
  // ─── Internal State ──────────────────────────────────────────────────

  private _handler: ItemHandler | null = null
  private _handlerComponent: any = null
  private _transform: Transform | null = null
  protected _parentLayout: LayoutOwner | null = null
  private _initialized: boolean = false

  /** Last allocated size from the layout pass (for debug visualization). */
  private _allocatedWidth: number = -1
  private _allocatedHeight: number = -1

  /** Opt-in measurement caching — avoids repeated handler.measure() calls. */
  private _cacheMeasurement: boolean = false
  private _cachedIntrinsic: ContentMeasurement | null = null

  /**
   * Stable closure handed to the engines as `heightForWidth` — one identity per
   * item so container memoization (`inputsMatch`) sees it as unchanged.
   */
  private readonly _heightForWidth = (width: number): number | null => this.measureHeightForWidth(width)

  /** True when the last fit-content probe was rate-limited and must be retried. */
  private _fitContentPending: boolean = false

  // ─── Size Override & Constraints (shared fields) ────────────────────
  // Inspector decorators are in subclasses (FlexItem, GridItem) to control
  // visual ordering. The base class holds the fields, getters/setters, and logic.

  protected abstract _overrideWidth: number
  protected abstract _overrideHeight: number
  protected abstract _hasOverrideWidth: boolean
  protected abstract _hasOverrideHeight: boolean
  protected abstract _minWidth: number
  protected abstract _maxWidth: number
  protected abstract _minHeight: number
  protected abstract _maxHeight: number
  protected abstract _aspectRatio: number

  // ─── Public Accessors ─────────────────────────────────────────────────

  /** Whether this item's handler has been resolved (after OnStart). */
  public get initialized(): boolean {
    return this._initialized
  }

  /** The resolved content-type handler, or null if not yet initialized. */
  public get handler(): ItemHandler | null {
    return this._handler
  }

  /**
   * Explicit intrinsic width override in cm.
   *
   * Setting any value (including `0`) via this setter pins the width to that
   * value and ignores the handler's `preferred.width`. To stop overriding,
   * call {@link clearOverrideWidth} instead of setting `0` — `0` is now a
   * legitimate explicit size.
   *
   * Inspector-authored values follow a backward-compatible fallback: a value
   * of `0` in the @input field means "unset" (handler decides), any value
   * `> 0` means override. So existing prefabs continue to work without
   * migration. See {@link hasOverrideWidth} for the resolved flag.
   */
  public get overrideWidth(): number {
    return this._overrideWidth
  }
  public set overrideWidth(value: number) {
    const clamped = Math.max(0, value)
    if (this._overrideWidth === clamped && this._hasOverrideWidth) return
    this._overrideWidth = clamped
    this._hasOverrideWidth = true
    this._cachedIntrinsic = null
    this._parentLayout?.markDirty()
  }

  /** Symmetric to {@link overrideWidth}. */
  public get overrideHeight(): number {
    return this._overrideHeight
  }
  public set overrideHeight(value: number) {
    const clamped = Math.max(0, value)
    if (this._overrideHeight === clamped && this._hasOverrideHeight) return
    this._overrideHeight = clamped
    this._hasOverrideHeight = true
    this._cachedIntrinsic = null
    this._parentLayout?.markDirty()
  }

  /**
   * Whether the width override is currently active.
   *
   * `true` if the programmatic setter has been called OR if the inspector
   * @input value is `> 0` (the legacy sentinel — preserved so prefabs that
   * set a size in the inspector continue to behave the same).
   */
  public get hasOverrideWidth(): boolean {
    return this._hasOverrideWidth || this._overrideWidth > 0
  }

  /** Symmetric to {@link hasOverrideWidth}. */
  public get hasOverrideHeight(): boolean {
    return this._hasOverrideHeight || this._overrideHeight > 0
  }

  /**
   * Stops overriding the width. After this call {@link hasOverrideWidth} is
   * `false` and the handler's `preferred.width` is used. Use this instead of
   * `overrideWidth = 0` when you want to unset an override — `= 0` now means
   * "explicitly pin the width to 0."
   */
  public clearOverrideWidth(): void {
    if (!this._hasOverrideWidth && this._overrideWidth === 0) return
    this._hasOverrideWidth = false
    this._overrideWidth = 0
    this._cachedIntrinsic = null
    this._parentLayout?.markDirty()
  }

  /** Symmetric to {@link clearOverrideWidth}. */
  public clearOverrideHeight(): void {
    if (!this._hasOverrideHeight && this._overrideHeight === 0) return
    this._hasOverrideHeight = false
    this._overrideHeight = 0
    this._cachedIntrinsic = null
    this._parentLayout?.markDirty()
  }

  /**
   * Intrinsic aspect ratio (`width / height`), mirroring CSS `aspect-ratio`.
   *
   * When the ratio is active and the item's main axis is `auto` (flex-basis
   * auto, with neither grow nor shrink), the Flex engine derives the main-axis
   * size from the resolved cross size to preserve it — clamping bidirectionally,
   * so if the derived size hits a min/max the *other* axis follows instead of
   * distorting the ratio.
   *
   * Tri-state: `> 0` = explicit ratio (wins over any handler ratio); `< 0` =
   * disabled (no ratio, even if the content handler reports one); `0` (default)
   * = inherit the handler's intrinsic ratio (e.g. an Image's texture aspect).
   * An explicit `overrideWidth`/`overrideHeight` also suppresses the handler
   * ratio — the author is sizing that axis manually. Consumed by the Flex
   * engine; Grid currently ignores it.
   */
  public get aspectRatio(): number {
    return this._aspectRatio
  }
  public set aspectRatio(value: number) {
    // > 0 explicit ratio; < 0 disables (no ratio even if a handler reports one);
    // 0 inherits the handler's intrinsic ratio (e.g. an Image's texture).
    const clamped = value > 0 ? value : value < 0 ? -1 : 0
    if (this._aspectRatio === clamped) return
    this._aspectRatio = clamped
    this._cachedIntrinsic = null
    this._parentLayout?.markDirty()
  }

  /** Minimum width constraint in cm. 0 means no minimum. */
  public get minWidth(): number {
    return this._minWidth
  }
  public set minWidth(value: number) {
    if (this._minWidth === value) return
    this._minWidth = Math.max(0, value)
    this._cachedIntrinsic = null
    this._parentLayout?.markDirty()
  }

  /** Maximum width constraint in cm. 0 means no maximum. */
  public get maxWidth(): number {
    return this._maxWidth
  }
  public set maxWidth(value: number) {
    if (this._maxWidth === value) return
    this._maxWidth = Math.max(0, value)
    this._cachedIntrinsic = null
    this._parentLayout?.markDirty()
  }

  /** Minimum height constraint in cm. 0 means no minimum. */
  public get minHeight(): number {
    return this._minHeight
  }
  public set minHeight(value: number) {
    if (this._minHeight === value) return
    this._minHeight = Math.max(0, value)
    this._cachedIntrinsic = null
    this._parentLayout?.markDirty()
  }

  /** Maximum height constraint in cm. 0 means no maximum. */
  public get maxHeight(): number {
    return this._maxHeight
  }
  public set maxHeight(value: number) {
    if (this._maxHeight === value) return
    this._maxHeight = Math.max(0, value)
    this._cachedIntrinsic = null
    this._parentLayout?.markDirty()
  }

  /**
   * When true, `measure()` / `measureIntrinsic()` cache their result and return
   * the cached value on subsequent calls. The full {min, preferred, max} triple
   * is cached as a single object. The cache is cleared automatically when
   * override sizes or constraints change, or manually via {@link invalidateMeasure}.
   *
   * **Default is off.** Enable per-item when sizes are known to be stable
   * (pooled items, fixed-size tiles, static content).
   */
  public get cacheMeasurement(): boolean {
    return this._cacheMeasurement
  }
  public set cacheMeasurement(value: boolean) {
    this._cacheMeasurement = value
    if (!value) this._cachedIntrinsic = null
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  public onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => {
      this.ensureInitialized()
      if (this._parentLayout) {
        this._parentLayout.markDirty()
      }
    })
  }

  /**
   * Resolves the transform and content handler. Runs from OnStart in the
   * normal lifecycle, and lazily from measure/apply for pooled items that
   * are activated and laid out in the same frame, before their deferred
   * start phase runs — an item disabled before its first start phase never
   * starts until re-enabled, which would otherwise leave it unmeasured and
   * unplaced for that frame.
   */
  private ensureInitialized(): void {
    if (this._initialized) return

    this._transform = this.sceneObject.getTransform()
    const resolved = ItemHandlerRegistry.resolve(this.sceneObject)
    if (resolved) {
      this._handler = resolved.handler
      this._handlerComponent = resolved.component
    }
    this._initialized = true
  }

  // ─── Public Methods ─────────────────────────────────────────────────

  /**
   * Associates this item with a parent layout for dirty propagation.
   * Called automatically by the layout container during child discovery.
   * @param layout - The parent layout (must have a `markDirty()` method), or null to detach.
   */
  public setParentLayout(layout: LayoutOwner | null): void {
    this._parentLayout = layout
  }

  /** The layout that owns this item (set by the container's discovery / addItems), or null. */
  public get parentLayout(): LayoutOwner | null {
    return this._parentLayout
  }

  /**
   * Composite-widget extension point. Subclasses (e.g. a `LabeledSlider`
   * that wants to declare its measure as "slider width + label width" without
   * registering a custom ItemHandler) can override this to provide a
   * {@link ContentMeasurement} directly.
   *
   * Return `null` (the default) to fall through to the registered handler
   * (or to the no-handler `{0, 0}` fallback). User-facing overrides
   * (`overrideWidth`, `minWidth`, `maxWidth`) still apply on top of whatever
   * this returns — they're the user's clamps and pin axes as documented in
   * {@link measureIntrinsic}.
   *
   * Call `invalidateMeasure()` when the underlying composite state changes
   * if measurement caching is on.
   */
  protected measureOverride(): ContentMeasurement | null {
    return null
  }

  /**
   * Axis-frame hook for the *content* measurement. {@link measureIntrinsic} calls
   * it on the raw handler/subclass {@link ContentMeasurement} BEFORE the user
   * override/min/max merge, so the merged result — and the FlexItemInput exported
   * by `FlexItem.fillInput` — stay in one coherent (layout) frame.
   *
   * Default is identity. A subclass whose content is rotated relative to the
   * layout axes (e.g. a vertical toolbar slider / text field) overrides this to
   * transpose min/preferred/max and invert the aspect ratio, so the canonical
   * ItemHandler still owns measurement while the engine sees layout axes.
   */
  protected toLayoutMeasurement(measurement: ContentMeasurement): ContentMeasurement {
    return measurement
  }

  /**
   * Axis-frame hooks for the size handed to `handler.apply`. {@link applyLayout}
   * records the allocated size in layout axes first, then passes the allocation
   * through these before the handler writes it to the content — so `allocatedSize`
   * stays in layout axes while the handler receives the content's own axes.
   *
   * Scalar by contract: they return a single dimension each, so a transposing
   * subclass adds no per-apply allocation. Default is identity.
   */
  protected handlerApplyWidth(width: number, _height: number): number {
    return width
  }

  /** Height companion to {@link handlerApplyWidth}. Default identity, allocation-free. */
  protected handlerApplyHeight(_width: number, height: number): number {
    return height
  }

  /**
   * Measures the content's intrinsic size as a min / preferred / max triple in cm.
   *
   * Merge rules per axis:
   * - **preferred** ← `overrideWidth/Height` if {@link hasOverrideWidth}/{@link hasOverrideHeight},
   *   else `handler.preferred`. An explicit `overrideWidth = 0` pins to 0
   *   (distinct from "unset").
   * - **min** ← `max(user minWidth/Height clamp, handler.min)`. When the override is
   *   set on an axis, the handler's min for that axis is ignored — overrides
   *   pin the size to the user's value, so the user's clamp is the only floor.
   * - **max** ← `min(user maxWidth/Height clamp || ∞, handler.max)`. Same override rule.
   *
   * With no handler resolved, preferred falls back to the override values
   * if set, or `{0, 0}` if not — letting the parent layout decide what an
   * unspecified size means rather than inventing a `1×1` opinion.
   *
   * When {@link cacheMeasurement} is enabled the full {min, preferred, max}
   * triple is cached as a single object and returned on subsequent calls
   * until invalidated.
   */
  public measureIntrinsic(): ContentMeasurement {
    const preparation = LayoutPreparation.current
    if (!preparation && this._cacheMeasurement && this._cachedIntrinsic) {
      return this._cachedIntrinsic
    }

    this.ensureInitialized()

    // Drop stale handler if its component was destroyed.
    if (this._handler && this._handlerComponent && isNull(this._handlerComponent)) {
      this._handler = null
      this._handlerComponent = null
    }

    // Subclass override path: composite widgets (Tooltip, Dropdown, custom
    // composites) can implement `measureOverride()` to declare their own
    // intrinsics without going through the registry. The override result
    // *replaces* the handler-derived measurement; user overrides and clamps
    // (overrideWidth, minWidth, maxWidth) still apply on top.
    const subclassMeasurement = preparation?.measurements.get(this) ?? this.measureOverride()

    // With both axes pinned by overrides nothing from the handler survives the
    // merge (preferred = overrides, min/max dropped), so skip the measurement:
    // it would only spend rate-limited host calls and could flag the item
    // pending for a value the layout never uses.
    const fullyPinned = this.hasOverrideWidth && this.hasOverrideHeight
    const handlerMeasurement: ContentMeasurement = subclassMeasurement
      ? subclassMeasurement
      : this._handler && !fullyPinned
        ? this._handler.measure(this.sceneObject, this._handlerComponent, this._transform!)
        : {
            min: {width: 0, height: 0},
            preferred: {width: 0, height: 0},
            max: {width: Infinity, height: Infinity}
          }

    // Transform the raw handler/subclass measurement into layout axes before the
    // override/min/max merge, so the merged result — and the FlexItemInput
    // exported by FlexItem.fillInput — stay in one coherent (layout) frame.
    // Default identity; a transposed subclass swaps axes here.
    const layoutMeasurement = this.toLayoutMeasurement(handlerMeasurement)

    const hasOverrideW = this.hasOverrideWidth
    const hasOverrideH = this.hasOverrideHeight

    const preferredW = hasOverrideW ? this._overrideWidth : layoutMeasurement.preferred.width
    const preferredH = hasOverrideH ? this._overrideHeight : layoutMeasurement.preferred.height

    // Override pins the axis — drop the handler's opinion on min/max for that axis
    // so the layout engine doesn't squash an explicitly-sized item back to its
    // rigid content min/max.
    const handlerMinW = hasOverrideW ? 0 : layoutMeasurement.min.width
    const handlerMinH = hasOverrideH ? 0 : layoutMeasurement.min.height
    const handlerMaxW = hasOverrideW ? Infinity : layoutMeasurement.max.width
    const handlerMaxH = hasOverrideH ? Infinity : layoutMeasurement.max.height

    const userMaxW = this._maxWidth > 0 ? this._maxWidth : Infinity
    const userMaxH = this._maxHeight > 0 ? this._maxHeight : Infinity

    const result: ContentMeasurement = {
      min: {
        width: Math.max(this._minWidth, handlerMinW),
        height: Math.max(this._minHeight, handlerMinH)
      },
      preferred: {width: preferredW, height: preferredH},
      max: {
        width: Math.min(userMaxW, handlerMaxW),
        height: Math.min(userMaxH, handlerMaxH)
      },
      // Tri-state ratio: > 0 explicit author ratio (wins); < 0 disabled; an
      // explicit size override also suppresses the handler ratio (the author is
      // sizing that axis manually, so the transfer must not fight it); otherwise
      // inherit the handler's intrinsic ratio (e.g. an Image's texture aspect).
      aspectRatio:
        this._aspectRatio > 0
          ? this._aspectRatio
          : this._aspectRatio < 0 || hasOverrideW || hasOverrideH
            ? undefined
            : layoutMeasurement.aspectRatio
    }

    // A measurement built on a refused host call is provisional: flag the item
    // pending (containers then skip memoization and retry) and never cache it.
    if (layoutMeasurement.pending) {
      if (preparation) preparation.pending = true
      else this._fitContentPending = true
    } else if (!preparation && this._cacheMeasurement) {
      this._cachedIntrinsic = result
    }
    return result
  }

  /**
   * Fit-content height at a concrete `width`, or `null` when this item's height
   * does not depend on width. `null` when:
   * - `overrideHeight` pins the axis (the author's number wins), or
   * - no handler resolved / the handler has no `measureHeightForWidth`, or
   * - {@link supportsHeightForWidth} is false (e.g. a transposed subclass), or
   * - the handler has no opinion this frame.
   *
   * The result is clamped by the user's `minHeight` / `maxHeight`. Engines call
   * this after the horizontal axis is resolved (Grid: after column sizing;
   * Flex: after main-axis resolution in a row, or from the available cross
   * width in a column) and replace the item's preferred height with it.
   *
   * A handler answering {@link FIT_CONTENT_PENDING} (rate-limited this frame)
   * also yields `null` here, but sets {@link fitContentPending} so the parent
   * container skips memoization and lays out again next frame.
   */
  public measureHeightForWidth(width: number): number | null {
    if (this.hasOverrideHeight) return null
    this.ensureInitialized()
    if (!this._handler || !this._handler.measureHeightForWidth) return null
    if (!this.supportsHeightForWidth()) return null
    if (this._handlerComponent && isNull(this._handlerComponent)) return null
    const measured = this._handler.measureHeightForWidth(
      this.sceneObject,
      this._handlerComponent,
      this._transform!,
      width
    )
    if (measured === FIT_CONTENT_PENDING) {
      if (LayoutPreparation.current) LayoutPreparation.current.pending = true
      else this._fitContentPending = true
      return null
    }
    if (measured === null || !Number.isFinite(measured) || measured < 0) return null
    const userMaxH = this._maxHeight > 0 ? this._maxHeight : Infinity
    return Math.min(userMaxH, Math.max(this._minHeight, measured))
  }

  /**
   * True when any {@link measureHeightForWidth} call during the current layout
   * pass could not get its answer. Sticky within a pass: an engine may probe
   * the same item at more than one width (flex column estimate, then re-fit),
   * and a later success must not hide an earlier unresolved width the result
   * still depends on. Reset by {@link resetFitContentPending} at the start of
   * each `fillInput`, so a skipped, removed, or newly pinned item never carries
   * stale pending state into a later pass. Containers aggregate this after an
   * engine run to decide whether to memoize and whether to retry.
   */
  public get fitContentPending(): boolean {
    return this._fitContentPending
  }

  /** Start-of-pass reset; called by the subclass `fillInput` before the engine runs. */
  protected resetFitContentPending(): void {
    if (LayoutPreparation.current) return
    this._fitContentPending = false
  }

  /** Preflight nested containers at their proposed allocation without applying it. */
  public prepareLayout(width: number, height: number): void {
    this.ensureInitialized()
    const component = this._handlerComponent
    if (component && !isNull(component) && typeof component.prepareLayout === "function") {
      component.prepareLayout(width, height)
    }
  }

  /**
   * The engine-facing `heightForWidth` callback, or `undefined` when the item
   * can never answer (no capable handler / height pinned). Cheap to call every
   * `fillInput`; the closure identity is stable for the item's lifetime.
   */
  public heightForWidthProvider(): ((width: number) => number | null) | undefined {
    if (this.hasOverrideHeight) return undefined
    this.ensureInitialized()
    if (!this._handler || !this._handler.measureHeightForWidth) return undefined
    if (!this.supportsHeightForWidth()) return undefined
    return this._heightForWidth
  }

  /**
   * Whether the fit-content pass applies to this item. Default true. Subclasses
   * whose content axes are rotated relative to the layout axes (see
   * {@link toLayoutMeasurement}) return false, since "height for width" would
   * be measured in the wrong frame.
   */
  protected supportsHeightForWidth(): boolean {
    return true
  }

  /**
   * Returns the preferred intrinsic size in cm — a thin wrapper around
   * {@link measureIntrinsic} that drops the min / max components.
   *
   * Existing callers (FlexItem.fillInput, GridItem.fillInput) that only care
   * about the natural size keep using this. Layout engines that want CSS
   * intrinsic sizing should call {@link measureIntrinsic} directly.
   */
  public measure(): Size {
    return this.measureIntrinsic().preferred
  }

  /**
   * Clears every measurement cached for this item — the optional intrinsic
   * cache here and the handler's own caches (Text natural size, wrapped
   * heights) — and marks the parent layout dirty so its memoized engine result
   * is dropped too.
   *
   * This is the documented notification path after mutating host state the
   * layout cannot observe: `text.text`, font, size, spacing,
   * `horizontalOverflow`. Text caches self-invalidate on content and the
   * common style properties, and `markDirty()` alone drops the container memo,
   * so this call is only *required* for changes the fingerprint misses; it is
   * always safe. Nothing polls for host mutations.
   */
  public invalidateMeasure(): void {
    this._cachedIntrinsic = null
    // Handler-side caches (Text natural / wrapped heights) key on a content and
    // style fingerprint; this is the explicit path for changes it does not see.
    if (this._handler?.invalidateMeasurements && this._handlerComponent && !isNull(this._handlerComponent)) {
      this._handler.invalidateMeasurements(this.sceneObject, this._handlerComponent)
    }
    this._parentLayout?.markDirty()
  }

  /**
   * Applies the computed layout position and size to the underlying SceneObject.
   * Called by the parent layout container after running the layout algorithm.
   *
   * Behavior splits on whether a {@link ItemHandler} was resolved for this
   * SceneObject's content:
   *
   * **With handler (recognized content):** delegates to `handler.apply()`,
   * which writes the size into the appropriate native channel — Text
   * `layoutRect`, Image / BaseMeshVisual `Transform.localScale`, Shape
   * `width/height`, etc. — or `ScreenTransform.offsets` when a ScreenTransform
   * is present (it supersedes those channels). Position is written to
   * Transform.localPosition.
   *
   * **No handler ("naked" LayoutItem2D):** there is nothing the layer can
   * resize directly, so:
   * 1. Always writes Transform.localPosition.
   * 2. Writes Transform.localScale *only when* {@link overrideWidth} or
   *    {@link overrideHeight} were set (declaration: "I am N cm at scale 1").
   *    With no override there is no natural-size baseline, so localScale is
   *    left alone — preserves child meshes / text at their authored size.
   *
   * In particular, attaching a FlexItem/GridItem to a SceneObject with no
   * handler-recognizable content **and** no override means the layout pass
   * will treat its intrinsic size as zero (the default ContentMeasurement
   * returns `{0, 0}`), and a `print()` warning is emitted on the first such
   * apply. To suppress the warning, either:
   *   - drop a recognized component on the SceneObject (Element, Shape,
   *     Image, Text, mesh, …) — the handler will pick it up; or
   *   - set `overrideWidth` / `overrideHeight` to declare the intended size
   *     explicitly.
   *
   * @param x - Center X position in parent-local coordinates (cm).
   * @param y - Center Y position in parent-local coordinates (cm).
   * @param width - Allocated width (cm).
   * @param height - Allocated height (cm).
   */
  public applyLayout(x: number, y: number, width: number, height: number): void {
    // Resolve on demand rather than skipping: a pooled item activated and
    // laid out in the same frame hasn't started yet, and skipping placement
    // would strand it at its stale transform for that frame.
    this.ensureInitialized()
    this._allocatedWidth = width
    this._allocatedHeight = height
    const transform = this._transform ?? this.sceneObject.getTransform()
    if (this._handler && this._handlerComponent && isNull(this._handlerComponent)) {
      this._handler = null
      this._handlerComponent = null
    }
    if (this._handler) {
      // allocatedSize was recorded above in layout axes; the handler receives the
      // content's own axes via the scalar apply hooks (identity by default).
      this._handler.apply(
        this.sceneObject,
        x,
        y,
        this.handlerApplyWidth(width, height),
        this.handlerApplyHeight(width, height),
        this._handlerComponent,
        transform
      )
    } else {
      // No-handler fallback: position the object. Scale only when the
      // user explicitly declared a natural size via override — that
      // declaration means "I am N cm at scale 1," so the layout scales
      // to make the allocation match. Without an override the user has
      // no opinion on size, so we leave localScale alone (preserves
      // child meshes / text at their natural rendering size).
      const pos = transform.getLocalPosition()
      pos.x = x
      pos.y = y
      transform.setLocalPosition(pos)

      const wOpinion = this.hasOverrideWidth && this._overrideWidth > 0
      const hOpinion = this.hasOverrideHeight && this._overrideHeight > 0
      if (wOpinion || hOpinion) {
        const declaredW = wOpinion ? this._overrideWidth : 1
        const declaredH = hOpinion ? this._overrideHeight : 1
        const scale = transform.getLocalScale()
        scale.x = width / declaredW
        scale.y = height / declaredH
        transform.setLocalScale(scale)
      } else if (!this._warnedNakedZero) {
        // First time we apply a naked LayoutItem2D with no override and no
        // recognized content: warn so the user knows the layout sees this
        // item as zero-sized. Only printed once per item to avoid log spam.
        this._warnedNakedZero = true
        print(
          `WARNING: ${this.sceneObject.name} has a LayoutItem2D but no recognized ` +
            `content component and no overrideWidth/overrideHeight. The layout will ` +
            `treat its intrinsic size as 0×0. Set overrideWidth/Height, attach a ` +
            `content component (Element / Shape / Text / Image / mesh), or register ` +
            `a custom ItemHandler.`
        )
      }
    }
  }

  /** One-shot guard for the naked-LayoutItem2D warning printed by applyLayout. */
  private _warnedNakedZero: boolean = false

  /**
   * Returns the size allocated by the last layout pass.
   * Falls back to measure() if no layout has run yet.
   */
  public allocatedSize(): {width: number; height: number} {
    if (this._allocatedWidth >= 0 && this._allocatedHeight >= 0) {
      return {width: this._allocatedWidth, height: this._allocatedHeight}
    }
    return this.measure()
  }
}

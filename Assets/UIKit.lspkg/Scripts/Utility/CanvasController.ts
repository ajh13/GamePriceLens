import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import {isBeingDestroyedError, isComponentBeingDestroyed} from "./SceneUtilities"

const log = new NativeLogger("CanvasController")

// Retries one settle() episode allows after its first failure before it gives up and waits for the next
// invalidate() or ensure(). Bounded because each attempt walks the ancestor chain; the failure modes are
// destruction-adjacent, so a binding that has not resolved in this many attempts is not going to.
const RECONCILE_RETRY_LIMIT = 10

type CompatibleCanvas = {
  layoutRect?: Rect
  worldSpaceRect?: Rect
  offsetUnit?: Canvas.OffsetUnit
}

type CompatibleCanvasApi = {
  OffsetUnit?: {
    World: Canvas.OffsetUnit
  }
}

/** Canvas settings captured while a controller temporarily manages an authored Canvas. */
type CanvasStateSnapshot = {
  enabled: boolean
  unitType: Canvas.UnitType
  offsetUnit: Canvas.OffsetUnit | null
  sortingType: Canvas.SortingType
  layoutRect: Rect | null
  size: vec2
  pivot: vec2
}

function getCanvasLayoutRect(canvas: Canvas): Rect | null {
  const compatibleCanvas = canvas as unknown as CompatibleCanvas
  if ("layoutRect" in compatibleCanvas && compatibleCanvas.layoutRect) {
    return compatibleCanvas.layoutRect
  }
  if ("worldSpaceRect" in compatibleCanvas && compatibleCanvas.worldSpaceRect) {
    return compatibleCanvas.worldSpaceRect
  }

  return null
}

function setCanvasLayoutRect(canvas: Canvas, layoutRect: Rect): void {
  const compatibleCanvas = canvas as unknown as CompatibleCanvas
  if ("layoutRect" in compatibleCanvas) {
    compatibleCanvas.layoutRect = layoutRect
  } else if ("worldSpaceRect" in compatibleCanvas) {
    compatibleCanvas.worldSpaceRect = layoutRect
  }
}

/**
 * Captures Canvas settings the controller may temporarily reconfigure.
 * Rect and vector values are copied so later Canvas mutations do not affect the snapshot.
 * Canvas layoutRect and offsetUnit were added after the original Canvas API, so
 * they are feature-detected for compatibility with older runtimes.
 */
function snapshotCanvasState(canvas: Canvas): CanvasStateSnapshot {
  const compatibleCanvas = canvas as unknown as CompatibleCanvas
  const layoutRect = getCanvasLayoutRect(canvas)
  const size = canvas.getSize()
  const pivot = canvas.pivot
  return {
    enabled: canvas.enabled,
    unitType: canvas.unitType,
    offsetUnit: "offsetUnit" in compatibleCanvas ? (compatibleCanvas.offsetUnit ?? null) : null,
    sortingType: canvas.sortingType,
    layoutRect: layoutRect ? Rect.create(layoutRect.left, layoutRect.right, layoutRect.bottom, layoutRect.top) : null,
    size: new vec2(size.x, size.y),
    pivot: new vec2(pivot.x, pivot.y)
  }
}

/**
 * Restores a Canvas snapshot. The layout rectangle is restored before offset
 * units so descendant ScreenTransform offsets round-trip correctly.
 */
function restoreCanvasState(canvas: Canvas, snapshot: CanvasStateSnapshot): void {
  const compatibleCanvas = canvas as unknown as CompatibleCanvas
  if (!snapshot.enabled) {
    canvas.enabled = false
  }
  canvas.pivot = new vec2(snapshot.pivot.x, snapshot.pivot.y)
  if (snapshot.layoutRect) {
    setCanvasLayoutRect(
      canvas,
      Rect.create(
        snapshot.layoutRect.left,
        snapshot.layoutRect.right,
        snapshot.layoutRect.bottom,
        snapshot.layoutRect.top
      )
    )
  } else {
    canvas.setSize(new vec2(snapshot.size.x, snapshot.size.y))
  }
  if (snapshot.offsetUnit !== null && "offsetUnit" in compatibleCanvas) {
    compatibleCanvas.offsetUnit = snapshot.offsetUnit
  }
  canvas.unitType = snapshot.unitType
  canvas.sortingType = snapshot.sortingType
  canvas.enabled = snapshot.enabled
}

/** Sets world-space Canvas offsets when the runtime exposes the offset-unit API. */
function setCanvasWorldOffsetUnitIfSupported(canvas: Canvas): void {
  const compatibleCanvas = canvas as unknown as CompatibleCanvas
  const compatibleCanvasApi = Canvas as unknown as CompatibleCanvasApi
  if ("offsetUnit" in compatibleCanvas && compatibleCanvasApi.OffsetUnit) {
    compatibleCanvas.offsetUnit = compatibleCanvasApi.OffsetUnit.World
  }
}

/** Describes how a {@link CanvasController} obtained its current Canvas. */
export type CanvasSource = "created-local" | "authored-local" | "inherited"

function isCanvasUsable(canvas: Canvas | null): canvas is Canvas {
  return !!canvas && !isNull(canvas) && !isComponentBeingDestroyed(canvas) && canvas.enabled
}

/**
 * Finds the Canvas that governs draw order for `sceneObject`, or null when none
 * does. Checks a local Canvas first, then the nearest enabled ancestor — the
 * same resolution order {@link CanvasController} uses, minus the create-local
 * fallback, so callers can ask "is draw order already handled for me?" without
 * minting a Canvas (and a new ScreenTransform layout root) as a side effect.
 *
 * Only Hierarchy sorting counts: that is the mode that orders equal-renderOrder
 * renderables child-after-parent. Under any other sorting type the caller is
 * still on its own for draw order.
 */
export function findGoverningCanvas(sceneObject: SceneObject): Canvas | null {
  const local = sceneObject.getComponent("Component.Canvas") as Canvas | null
  if (isCanvasUsable(local)) {
    return local.sortingType === Canvas.SortingType.Hierarchy ? local : null
  }

  const ancestors = sceneObject.getComponentsInAncestors("Component.Canvas", false, false) as Canvas[]
  const nearest = ancestors.find(isCanvasUsable)
  if (!nearest) {
    return null
  }

  return nearest.sortingType === Canvas.SortingType.Hierarchy ? nearest : null
}

/**
 * Re-resolves cached Canvas bindings across a subtree that was just reparented
 * through raw Lens APIs. Every ScriptComponent exposing `invalidateCanvasBinding()`
 * receives the call — duck-typed so this file imports no component types (a type
 * import here would risk a require cycle). Implementers: every VisualElement
 * (Button, Checkbox, Slider, Switch, …), ProgressBar, Skeleton, ElementContent,
 * ScrollWindow (its edge-fade order), TextManipulationModule, Calendar,
 * NumberPicker, DatePicker, the text inputs, Dropdown and DialogPopup. Hoisted
 * from ScrollWindow.addObject, which walks the content it adopts; Dropdown walks
 * each item it reparents onto its layout object.
 */
export function invalidateCanvasBindingsIn(root: SceneObject): void {
  for (const component of root.getComponents("ScriptComponent")) {
    const invalidate = (component as unknown as {invalidateCanvasBinding?: () => void}).invalidateCanvasBinding
    if (typeof invalidate === "function") {
      invalidate.call(component)
    }
  }
  for (const child of root.children) {
    invalidateCanvasBindingsIn(child)
  }
}

/** Configuration required by inherited Canvases and applied to locally managed Canvases. */
export type CanvasControllerOptions = Readonly<{
  /**
   * Whether the nearest locally enabled ancestor Canvas may be used when compatible without modifying it.
   * Defaults to true.
   * Set this to false when the component needs its own ScreenTransform layout root.
   */
  allowInherited?: boolean
  /**
   * Unit type required from inherited Canvases and applied to managed local Canvases.
   * Defaults to World.
   */
  unitType?: Canvas.UnitType
  /**
   * Sorting type required from inherited Canvases and applied to managed local Canvases.
   * Defaults to Hierarchy.
   */
  sortingType?: Canvas.SortingType
  /** Pivot applied to managed local Canvases. Defaults to (0, 0). */
  pivot?: vec2
  /**
   * Whether inherited and managed Canvases should use world-space ScreenTransform offsets when supported.
   */
  useWorldOffsetUnit?: boolean
  /** Additional compatibility check for the otherwise compatible nearest locally enabled ancestor Canvas. */
  acceptInherited?: (canvas: Canvas) => boolean
}>

/**
 * Maintains a Canvas for a SceneObject without mutating a shared ancestor Canvas.
 *
 * Resolution order is an authored local Canvas, the nearest locally enabled ancestor Canvas when compatible,
 * then a newly created local Canvas. More distant Canvases are not considered when a nearer locally enabled
 * Canvas establishes the ScreenTransform layout root. Authored local state is restored on release;
 * a created Canvas is destroyed; an inherited Canvas is left untouched. Once acquired,
 * a live local Canvas remains authoritative until release.
 * An inherited Canvas must match the configured units and sorting; its size, pivot,
 * and layout rectangle remain authoritative for all ScreenTransform descendants.
 *
 * Only one active controller should manage an authored Canvas on a SceneObject;
 * overlapping controllers would otherwise restore competing snapshots.
 *
 * Inherited bindings remain stable until explicitly invalidated. Call {@link invalidate}
 * after reparenting the SceneObject or changing ancestor Canvas topology or configuration,
 * then call {@link settle} at a controlled update boundary and again on each later update
 * while it returns false. settle() owns the retry policy: it never throws, bounds the
 * retries, and logs. {@link reconcile} and {@link refresh} are the throwing primitives, for
 * callers that want a failure to propagate.
 */
export class CanvasController {
  private currentCanvas: Canvas | null = null
  private currentSource: CanvasSource | null = null
  private authoredSnapshot: CanvasStateSnapshot | null = null
  private requestedSize: vec2 | null = null
  private bindingDirty: boolean = true
  // The settle() episode: consecutive failures since it opened, and whether it gave up (sticky until it
  // closes, so the give-up is reported once).
  private reconcileFailures: number = 0
  private reconcileGaveUp: boolean = false
  // Read at construction: a failure's log line must not touch a SceneObject that may be mid-destruction.
  private readonly logName: string

  private readonly allowInherited: boolean
  private readonly unitType: Canvas.UnitType
  private readonly sortingType: Canvas.SortingType
  private readonly pivot: vec2
  private readonly useWorldOffsetUnit: boolean
  private readonly acceptInherited: (canvas: Canvas) => boolean

  public constructor(
    private readonly sceneObject: SceneObject,
    options: CanvasControllerOptions = {}
  ) {
    this.allowInherited = options.allowInherited ?? true
    this.unitType = options.unitType ?? Canvas.UnitType.World
    this.sortingType = options.sortingType ?? Canvas.SortingType.Hierarchy
    this.pivot = options.pivot ? new vec2(options.pivot.x, options.pivot.y) : vec2.zero()
    this.useWorldOffsetUnit = options.useWorldOffsetUnit ?? true
    this.acceptInherited = options.acceptInherited ?? (() => true)
    this.logName = sceneObject.name
  }

  /** The currently resolved Canvas, or null before ensure() and after release(). */
  public get canvas(): Canvas | null {
    return this.currentCanvas
  }

  /** How the current Canvas was obtained, or null when there is no current Canvas. */
  public get source(): CanvasSource | null {
    return this.currentSource
  }

  /** Whether this controller may configure, resize, and clean up the current Canvas. */
  public get managesCanvas(): boolean {
    return this.currentSource === "created-local" || this.currentSource === "authored-local"
  }

  /**
   * Whether the binding still needs a reconcile: invalidated, or its Canvas is no longer alive. False before
   * ensure() and after release(). A binding whose settle() episode gave up still needs one.
   */
  public get needsReconcile(): boolean {
    return this.requestedSize !== null && (this.bindingDirty || !this.isCanvasAlive(this.currentCanvas))
  }

  /**
   * Resolves a Canvas and applies the requested size when the Canvas is local. Throws when the binding
   * fails, so a component that cannot get a Canvas at build time fails loudly.
   */
  public ensure(size: vec2): Canvas {
    this.requestedSize = new vec2(size.x, size.y)
    this.invalidate()
    this.reconcile()
    return this.currentCanvas as Canvas
  }

  /**
   * Updates the desired local Canvas size without revalidating a stable binding.
   * Does nothing before ensure() or after release(). When the bound Canvas is no longer
   * alive it re-resolves through {@link settle}, so it never throws and returns what
   * settle() returns: false when the owner should call settle() on its next update.
   */
  public setSize(size: vec2): boolean {
    if (this.requestedSize === null) {
      return true
    }

    this.requestedSize = new vec2(size.x, size.y)
    if (!this.isCanvasAlive(this.currentCanvas)) {
      this.bindingDirty = true
      return this.settle()
    }

    if (this.managesCanvas) {
      this.currentCanvas.setSize(this.requestedSize)
    }
    return true
  }

  /**
   * Marks the current binding for re-resolution without performing a hierarchy search, and opens a
   * new {@link settle} episode, so a binding that gave up is tried again.
   */
  public invalidate(): void {
    this.bindingDirty = true
    this.reconcileFailures = 0
    this.reconcileGaveUp = false
  }

  /**
   * Re-resolves an invalidated binding and reapplies the requested local Canvas size. Throws when the
   * binding fails, leaving it dirty; owners that settle from an event handler call {@link settle}.
   */
  public reconcile(): void {
    if (!this.requestedSize || (!this.bindingDirty && this.isCanvasAlive(this.currentCanvas))) {
      return
    }

    this.bindingDirty = false
    try {
      this.reconcileBinding()
      if (this.managesCanvas && this.currentCanvas) {
        this.currentCanvas.setSize(this.requestedSize)
      }
    } catch (error) {
      this.bindingDirty = true
      throw error
    }
  }

  /**
   * {@link reconcile}, contained: never throws, so an owner can call it from a bound event handler,
   * where an uncaught throw disables the whole ScriptComponent. A failure leaves the binding dirty and
   * asks for another call on the owner's next update. The first failure of an episode is logged with
   * its error; after 10 retries the episode gives up and says so once.
   * Later calls still attempt a given-up binding, silently and without counting, so a success closes
   * the episode and a failure after that is reported again. {@link invalidate} opens a new episode.
   * @returns false while the owner should call again; true once the binding settled or gave up.
   */
  public settle(): boolean {
    try {
      this.reconcile()
    } catch (error) {
      return this.noteReconcileFailure(error)
    }
    this.reconcileFailures = 0
    this.reconcileGaveUp = false
    return true
  }

  /** Immediately invalidates and reconciles the binding. Throws like {@link reconcile}. */
  public refresh(): void {
    this.invalidate()
    this.reconcile()
  }

  /** Releases the current Canvas according to how it was acquired. */
  public release(): void {
    const canvas = this.currentCanvas
    const source = this.currentSource
    const snapshot = this.authoredSnapshot
    this.clearBinding()
    this.requestedSize = null
    this.bindingDirty = false

    if (source === null || source === "inherited" || !canvas || isNull(canvas) || isComponentBeingDestroyed(canvas)) {
      return
    }

    try {
      if (source === "created-local") {
        canvas.destroy()
      } else if (snapshot) {
        restoreCanvasState(canvas, snapshot)
      }
    } catch (error) {
      if (!isBeingDestroyedError(error)) {
        throw error
      }
    }
  }

  // Records one contained settle() failure; returns whether the owner can stop calling.
  private noteReconcileFailure(error: unknown): boolean {
    if (this.reconcileGaveUp) {
      // Reported already. Stay quiet and stop counting until the episode closes: an owner's size sync
      // may land here on every layout pass.
      return true
    }
    if (this.reconcileFailures === 0) {
      log.e(`Canvas binding failed on "${this.logName}", retrying: ${error}`)
    }
    this.reconcileFailures++
    if (this.reconcileFailures > RECONCILE_RETRY_LIMIT) {
      log.e(
        `Canvas binding still failing on "${this.logName}" after ${RECONCILE_RETRY_LIMIT} retries; giving up ` +
          `until the next enable or reparent. Draw order under it may be unsorted.`
      )
      this.reconcileGaveUp = true
      return true
    }
    return false
  }

  private reconcileBinding(): void {
    const currentCanvas = this.currentCanvas
    if (this.currentSource !== "inherited" && this.isCanvasAlive(currentCanvas)) {
      if (!currentCanvas.enabled) {
        this.configureManagedCanvas(currentCanvas)
      }
      return
    }

    const authoredCanvas = this.sceneObject.getComponent("Component.Canvas") as Canvas | null
    if (this.isCanvasAlive(authoredCanvas)) {
      this.clearBinding()
      this.currentCanvas = authoredCanvas
      this.currentSource = "authored-local"
      this.authoredSnapshot = snapshotCanvasState(authoredCanvas)
      this.configureManagedCanvas(authoredCanvas)
      return
    }

    if (this.allowInherited) {
      const nearestEnabledCanvas = (
        this.sceneObject.getComponentsInAncestors("Component.Canvas", false, false) as Canvas[]
      ).find((canvas) => this.isCanvasAlive(canvas) && canvas.enabled)
      if (nearestEnabledCanvas && this.isInheritedCanvasUsable(nearestEnabledCanvas)) {
        if (this.currentSource === "inherited" && this.currentCanvas === nearestEnabledCanvas) {
          return
        }

        this.clearBinding()
        this.currentCanvas = nearestEnabledCanvas
        this.currentSource = "inherited"
        return
      }
    }

    this.clearBinding()
    const createdCanvas = this.sceneObject.createComponent("Component.Canvas") as Canvas
    this.currentCanvas = createdCanvas
    this.currentSource = "created-local"
    this.configureManagedCanvas(createdCanvas)
  }

  private configureManagedCanvas(canvas: Canvas): void {
    canvas.unitType = this.unitType
    if (this.useWorldOffsetUnit) {
      setCanvasWorldOffsetUnitIfSupported(canvas)
    }
    canvas.sortingType = this.sortingType
    canvas.pivot = new vec2(this.pivot.x, this.pivot.y)
    canvas.enabled = true
  }

  private isInheritedCanvasUsable(canvas: Canvas | null): canvas is Canvas {
    if (!this.isCanvasAlive(canvas) || !canvas.enabled) {
      return false
    }

    const canvasSceneObject = canvas.getSceneObject()
    return (
      canvasSceneObject !== this.sceneObject &&
      this.hasCompatibleInheritedSettings(canvas) &&
      this.acceptInherited(canvas)
    )
  }

  private hasCompatibleInheritedSettings(canvas: Canvas): boolean {
    if (canvas.unitType !== this.unitType || canvas.sortingType !== this.sortingType) {
      return false
    }

    if (!this.useWorldOffsetUnit) {
      return true
    }

    const compatibleCanvas = canvas as unknown as CompatibleCanvas
    const compatibleCanvasApi = Canvas as unknown as CompatibleCanvasApi
    if (!("offsetUnit" in compatibleCanvas) || !compatibleCanvasApi.OffsetUnit) {
      return true
    }

    return compatibleCanvas.offsetUnit === compatibleCanvasApi.OffsetUnit.World
  }

  private isCanvasAlive(canvas: Canvas | null): canvas is Canvas {
    return !!canvas && !isNull(canvas) && !isComponentBeingDestroyed(canvas)
  }

  private clearBinding(): void {
    this.currentCanvas = null
    this.currentSource = null
    this.authoredSnapshot = null
  }
}

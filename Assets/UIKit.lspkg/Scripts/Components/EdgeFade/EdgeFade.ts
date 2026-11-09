import {CancelToken, clearTimeout, setTimeout} from "InteractionKit.lspkg/Utils/FunctionTimingUtils"
import {GradientParameters} from "../../Visuals/RoundedRectangle/RoundedRectangle"
import {RoundedRectangleVisual} from "../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {FlexItem} from "../Layout2D/Flex/FlexItem"
import {FlexLayout} from "../Layout2D/Flex/FlexLayout"

type unsubscribe = () => void
type Edge = "left" | "right" | "top" | "bottom"

/**
 * Duck type for an ancestor element whose background color the fade can track
 * (any VisualElement: has a Visual and a state machine). `visual.baseColor`
 * only reflects the live color for solid-color styles (baseType "Color", e.g.
 * Tag/Chip); gradient-filled styles don't write it, so matching is a no-op there.
 */
interface ColorSourceElement {
  visual?: {baseColor?: vec4}
  onStateChanged?: {add: (cb: (state: string) => void) => unsubscribe}
}

function isColorSourceElement(comp: unknown): comp is ColorSourceElement {
  if (!comp || typeof comp !== "object") return false
  const candidate = comp as Record<string, unknown>
  return "visual" in candidate && "onStateChanged" in candidate
}

// Recolor threshold — below ~1/255 per channel the gradient rewrite is invisible.
const COLOR_EPSILON = 1 / 255

// Content should never be layered right at the host's Z, or the fade z-fights
// with it. The lift is kept tiny — large forward offsets cross neighboring
// items' Canvas sort ranges and scramble draw order (the 0.6 list-item
// Content offset did exactly that).
const FADE_Z_OFFSET = 0.005

// Match Element Color: frames of unchanged source color before the poll goes
// to sleep. Woken again by the source's next state change, so steady-state
// instances cost nothing per frame.
const MATCH_SETTLE_FRAMES = 30

/**
 * Per-edge render state, created once (the enabled-edge set is fixed at author
 * time) and updated in place on refits/recolors — no native object churn.
 * The gradient object and its stop colors are owned and mutated directly.
 */
interface EdgeEntry {
  edge: Edge
  sceneObject: SceneObject
  visual: RoundedRectangleVisual
  gradient: GradientParameters
  clear: vec4
  half: vec4
  solid: vec4
}

/**
 * EdgeFade — a companion that ramps one or more edges of its host to a color.
 *
 * Attach it to the same SceneObject as the content you want to fade (e.g. a
 * list-item thumbnail Image). It draws a transparent→color linear gradient
 * strip on each enabled edge, so the content blends into `fadeColor` (usually
 * the item background) toward that edge. Each strip covers only the fade
 * distance, not the whole cell, so the fragment cost matches the visible ramp.
 *
 * Flex-native sizing: it reads the sibling {@link FlexItem}'s allocated size and
 * re-fits on the owning {@link FlexLayout}'s layout-complete, so it tracks the
 * flex cell automatically. With no FlexItem it falls back to `sizeOverride`.
 */
@component
export class EdgeFade extends BaseScriptComponent {
  @input
  @label("Fade Left")
  private _fadeLeft: boolean = false
  @input
  @label("Fade Right")
  private _fadeRight: boolean = true
  @input
  @label("Fade Top")
  private _fadeTop: boolean = false
  @input
  @label("Fade Bottom")
  private _fadeBottom: boolean = false

  @input
  @widget(new ColorWidget())
  @label("Fade Color")
  @hint("The color each enabled edge fades to (usually the list-item background).")
  // #202020 — matches PanelLevel0 in Themes/System-3.0/Colors.ts, the standard
  // panel background this normally fades over. Pure black used to be the
  // default, which reads as a dark hole on anything but a black backing.
  private _fadeColor: vec4 = new vec4(32 / 255, 32 / 255, 32 / 255, 1)

  @input
  @label("Match Element Color")
  @hint(
    "Track the nearest ancestor element's live background color (e.g. the list-item button) instead of the static Fade Color, following hover/press states and their animations. Solid-color styles only."
  )
  private _matchElementColor: boolean = false

  @input
  @label("Fade Distance (cm)")
  @hint("How far the ramp extends in from each enabled edge, in centimeters.")
  private _fadeDistance: number = 2

  @input
  @label("Corner Radius (cm)")
  @hint(
    "Match the content's corner radius so the fade respects rounded corners. Clamped to the fade strip's half-extent — radii larger than the fade distance can't be represented by the strip."
  )
  private _cornerRadius: number = 0

  @input
  @label("Inherit Render Order")
  @hint("Use the host content's render order (hierarchy sort then draws the fade above it).")
  private _inheritRenderOrder: boolean = true

  @input
  @showIf("_inheritRenderOrder", false)
  @label("Render Order")
  private _renderOrder: number = 0

  @input
  @label("Size Override")
  @hint("Width/height in cm, used only when there is no sibling FlexItem to size to.")
  private _sizeOverride: vec2 = new vec2(0, 0)

  private hostFlexItem: FlexItem | null = null
  private container: SceneObject | null = null
  private edgeEntries: EdgeEntry[] = []
  private unsubscribes: unsubscribe[] = []
  private pendingRefit: CancelToken | null = null
  private _initialized: boolean = false
  private _lastWidth: number = -1
  private _lastHeight: number = -1

  // Live fade color: _fadeColor by default; mirrors the color source when
  // Match Element Color is on. Alpha always comes from _fadeColor.
  private _activeColor: vec4 = new vec4(0, 0, 0, 1)
  private colorSource: ColorSourceElement | null = null
  private matchUpdateEvent: SceneEvent | null = null
  private _stableFrames: number = 0

  public onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.init())
    this.createEvent("OnDestroyEvent").bind(() => this.onDestroy())
  }

  private init(): void {
    this.hostFlexItem = this.sceneObject.getComponent(FlexItem.getTypeName()) as FlexItem | null
    this._activeColor = new vec4(this._fadeColor.r, this._fadeColor.g, this._fadeColor.b, this._fadeColor.a)

    const container = global.scene.createSceneObject(this.sceneObject.name + " EdgeFade")
    container.layer = this.sceneObject.layer
    container.setParent(this.sceneObject)
    container.getTransform().setLocalPosition(new vec3(0, 0, FADE_Z_OFFSET))
    this.container = container

    // Reflow whenever the owning layout re-lays-out.
    const layout = this.findOwningLayout()
    if (layout) {
      this.unsubscribes.push(layout.onLayoutComplete.add(() => this.refit()))
    }

    if (this._matchElementColor) {
      this.colorSource = this.findColorSource()
      if (this.colorSource) {
        // Poll the source's live color while it may be moving. The poll goes
        // to sleep once the color has been stable for MATCH_SETTLE_FRAMES and
        // is woken by the source's next state change, so a resting list costs
        // no per-frame work. Reading visual.baseColor is a JS-side backing-
        // field read (no bridge crossing).
        const update = this.createEvent("UpdateEvent")
        update.bind(() => this.pollSourceColor())
        update.enabled = true
        this.matchUpdateEvent = update
        const stateUnsub = this.colorSource.onStateChanged?.add(() => this.wakeMatchPoll())
        if (stateUnsub) this.unsubscribes.push(stateUnsub)
      }
    }

    this._initialized = true
    // onLayoutComplete is not a ReplayEvent, and the first frame's allocated
    // size can read < 0, so kick a deferred fit with a couple retries.
    this.scheduleRefit(3)
  }

  // Nearest ancestor VisualElement (duck-typed): the thing the fade blends into,
  // e.g. the list-item button that owns the background behind this content.
  private findColorSource(): ColorSourceElement | null {
    let parent = this.sceneObject.getParent()
    while (parent && !isNull(parent)) {
      for (const comp of parent.getComponents("ScriptComponent")) {
        if (isColorSourceElement(comp)) {
          return comp
        }
      }
      parent = parent.getParent()
    }
    return null
  }

  private wakeMatchPoll(): void {
    this._stableFrames = 0
    if (this.matchUpdateEvent) {
      this.matchUpdateEvent.enabled = true
    }
  }

  private pollSourceColor(): void {
    // visual may not exist until the source element initializes — read lazily.
    const color = this.colorSource?.visual?.baseColor
    if (!color) {
      return
    }
    const active = this._activeColor
    const unchanged =
      Math.abs(color.r - active.r) < COLOR_EPSILON &&
      Math.abs(color.g - active.g) < COLOR_EPSILON &&
      Math.abs(color.b - active.b) < COLOR_EPSILON
    if (unchanged) {
      // Sleep once settled; the source's onStateChanged wakes us again.
      this._stableFrames++
      if (this._stableFrames >= MATCH_SETTLE_FRAMES && this.matchUpdateEvent) {
        this.matchUpdateEvent.enabled = false
      }
      return
    }
    this._stableFrames = 0
    active.r = color.r
    active.g = color.g
    active.b = color.b
    this.recolorEntries()
  }

  private findOwningLayout(): FlexLayout | null {
    let parent = this.sceneObject.getParent()
    while (parent && !isNull(parent)) {
      const layout = parent.getComponent(FlexLayout.getTypeName()) as FlexLayout | null
      if (layout && !isNull(layout)) {
        return layout
      }
      parent = parent.getParent()
    }
    return null
  }

  private scheduleRefit(retries: number): void {
    this.pendingRefit = setTimeout(() => {
      this.pendingRefit = null
      const fitted = this.refit()
      if (!fitted && retries > 0) {
        this.scheduleRefit(retries - 1)
      }
    }, 0)
  }

  private resolveSize(): vec2 | null {
    if (this.hostFlexItem && !isNull(this.hostFlexItem)) {
      const allocated = this.hostFlexItem.allocatedSize()
      if (allocated.width > 0 && allocated.height > 0) {
        return new vec2(allocated.width, allocated.height)
      }
      return null
    }
    if (this._sizeOverride.x > 0 && this._sizeOverride.y > 0) {
      return this._sizeOverride
    }
    return null
  }

  /** Re-fit the fade strips to the current host size. Returns false when the size
   * isn't resolvable yet (so the caller can retry). */
  public refit(): boolean {
    if (!this._initialized || !this.container) {
      return false
    }
    const size = this.resolveSize()
    if (!size) {
      return false
    }
    const unchanged = Math.abs(size.x - this._lastWidth) < 0.001 && Math.abs(size.y - this._lastHeight) < 0.001
    if (unchanged && this.edgeEntries.length > 0) {
      return true
    }
    this._lastWidth = size.x
    this._lastHeight = size.y
    this.compensateHostScale()

    // Entries are created once (the enabled-edge set is fixed at author time)
    // and re-fitted in place afterwards — refits must not churn native objects.
    if (this.edgeEntries.length === 0) {
      const edges: Edge[] = []
      if (this._fadeLeft) edges.push("left")
      if (this._fadeRight) edges.push("right")
      if (this._fadeTop) edges.push("top")
      if (this._fadeBottom) edges.push("bottom")
      for (const edge of edges) {
        this.edgeEntries.push(this.createEdgeEntry(edge))
      }
    }
    for (const entry of this.edgeEntries) {
      this.fitEdgeEntry(entry, size.x, size.y)
    }
    return true
  }

  // Layout2D's Image/fallback handlers apply the allocated size by SCALING the
  // host SceneObject (ItemHandlerRegistry.apply -> setLocalScale). This container
  // is a child of the host, so it inherits that scale — invert it, or the fade
  // strips (sized in cm) render host-scale times too large. Hosts that size via
  // _size (Elements) keep scale 1, so the inverse is a no-op there.
  private compensateHostScale(): void {
    if (!this.container) {
      return
    }
    const hostScale = this.sceneObject.getTransform().getLocalScale()
    const sx = Math.abs(hostScale.x) > 1e-6 ? 1 / hostScale.x : 1
    const sy = Math.abs(hostScale.y) > 1e-6 ? 1 / hostScale.y : 1
    const sz = Math.abs(hostScale.z) > 1e-6 ? 1 / hostScale.z : 1
    this.container.getTransform().setLocalScale(new vec3(sx, sy, sz))
  }

  // Inherit from the host's renderable so the fade shares its bucket and
  // Canvas hierarchy sort (child after parent) draws it above the content.
  private resolveRenderOrder(): number {
    if (!this._inheritRenderOrder) {
      return this._renderOrder
    }
    const image = this.sceneObject.getComponent("Component.Image") as Image | null
    if (image && !isNull(image)) {
      return image.renderOrder
    }
    const rmv = this.sceneObject.getComponent("Component.RenderMeshVisual") as RenderMeshVisual | null
    if (rmv && !isNull(rmv)) {
      return rmv.renderOrder
    }
    return 0
  }

  private createEdgeEntry(edge: Edge): EdgeEntry {
    const object = global.scene.createSceneObject("EdgeFade_" + edge)
    object.layer = this.container!.layer
    object.setParent(this.container!)

    const visual = new RoundedRectangleVisual({sceneObject: object, transparent: true})
    visual.baseType = "Gradient"
    // Overlay depth settings: the strip must never write depth (its transparent
    // ramp would occlude content drawn later but sitting behind it).
    visual.depthTest = true
    visual.depthWrite = false
    visual.renderMeshVisual.renderOrder = this.resolveRenderOrder()

    // Owned stop colors, mutated in place on recolor. The ramp runs linearly
    // across the whole strip: clear at the inner side, solid at the edge.
    const clear = new vec4(0, 0, 0, 0)
    const half = new vec4(0, 0, 0, 0)
    const solid = new vec4(0, 0, 0, 1)
    const horizontal = edge === "left" || edge === "right"
    // Gradient axis: percent 0 at `start`, percent 1 at `end`.
    // Horizontal: start = left (-1), end = right (+1). Vertical: start = top, end = bottom.
    const start = horizontal ? new vec2(-1, 0) : new vec2(0, 1)
    const end = horizontal ? new vec2(1, 0) : new vec2(0, -1)
    const solidAtEnd = edge === "right" || edge === "bottom"
    const gradient: GradientParameters = {
      enabled: true,
      type: "Linear",
      start,
      end,
      stop0: {enabled: true, percent: 0, color: solidAtEnd ? clear : solid},
      stop1: {enabled: true, percent: 0.5, color: half},
      stop2: {enabled: true, percent: 1, color: solidAtEnd ? solid : clear}
    }

    const entry: EdgeEntry = {edge, sceneObject: object, visual, gradient, clear, half, solid}
    this.recolorEntry(entry)
    return entry
  }

  /** Size + position one edge strip against its edge for the given host size. */
  private fitEdgeEntry(entry: EdgeEntry, width: number, height: number): void {
    const horizontal = entry.edge === "left" || entry.edge === "right"
    const span = horizontal ? width : height
    const depth = Math.max(0.001, Math.min(this._fadeDistance, span))
    const stripW = horizontal ? depth : width
    const stripH = horizontal ? height : depth

    let cx = 0
    let cy = 0
    if (entry.edge === "left") cx = -(width - stripW) / 2
    if (entry.edge === "right") cx = (width - stripW) / 2
    if (entry.edge === "top") cy = (height - stripH) / 2
    if (entry.edge === "bottom") cy = -(height - stripH) / 2

    entry.visual.size = new vec3(stripW, stripH, 0)
    // The squircle SDF misbehaves when the radius exceeds the strip's half
    // extents — clamp. (Radii larger than the fade distance can't be fully
    // represented by an edge strip.)
    entry.visual.cornerRadius = Math.max(0, Math.min(this._cornerRadius, stripW / 2, stripH / 2))
    entry.sceneObject.getTransform().setLocalPosition(new vec3(cx, cy, 0))
    entry.visual.applyBaseGradientNow(entry.gradient)
  }

  /** Write _activeColor (rgb) + _fadeColor alpha into an entry's owned stops. */
  private recolorEntry(entry: EdgeEntry): void {
    const c = this._activeColor
    const a = this._fadeColor.a
    entry.clear.r = c.r
    entry.clear.g = c.g
    entry.clear.b = c.b
    entry.clear.a = 0
    entry.half.r = c.r
    entry.half.g = c.g
    entry.half.b = c.b
    entry.half.a = a * 0.5
    entry.solid.r = c.r
    entry.solid.g = c.g
    entry.solid.b = c.b
    entry.solid.a = a
  }

  private recolorEntries(): void {
    for (const entry of this.edgeEntries) {
      this.recolorEntry(entry)
      entry.visual.applyBaseGradientNow(entry.gradient)
    }
  }

  private destroyEdgeEntries(): void {
    for (const entry of this.edgeEntries) {
      entry.visual.destroy()
      // Visual.destroy() tears down its managed components, not the owning
      // SceneObject — destroy it too or refit/teardown leaks empty objects.
      if (!isNull(entry.sceneObject)) {
        entry.sceneObject.destroy()
      }
    }
    this.edgeEntries = []
  }

  private onDestroy(): void {
    this._initialized = false
    if (this.pendingRefit !== null) {
      clearTimeout(this.pendingRefit)
      this.pendingRefit = null
    }
    this.unsubscribes.forEach((unsub) => unsub())
    this.unsubscribes = []
    this.destroyEdgeEntries()
    if (this.container && !isNull(this.container)) {
      this.container.destroy()
      this.container = null
    }
  }
}

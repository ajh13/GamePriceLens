import Event, {PublicApi} from "InteractionKit.lspkg/Utils/Event"
import ReplayEvent from "InteractionKit.lspkg/Utils/ReplayEvent"
import * as Channels from "Motion.lspkg/Channels"
import {Timeline} from "Motion.lspkg/Timeline"
import {Tween} from "Motion.lspkg/Tween"
import {getActiveMotionProfile} from "../../../Motion/MotionTokens"
import {Intents} from "../../../Motion/SpecIntents"
import {SkeletonComponentData, SkeletonComponentDataType} from "../../../Themes/System-3.0/Styles/SkeletonParameters"
import {Theme} from "../../../Themes/Theme"
import {ThemeService} from "../../../Themes/ThemeService"
import {CanvasController} from "../../../Utility/CanvasController"
import {SkeletonBlockVisual} from "../../../Visuals/Skeleton/SkeletonBlockVisual"
import {ItemHandlerRegistry, ResolvedHandler} from "../../Layout2D/ItemHandlerRegistry"
import {UIKitBrands} from "../../Layout2D/UIKitBrands"
// Side-effect import — register UIKit Layout2D handlers (the measurement
// backbone of the skeleton scan).
import "../../../UIKitBootstrap"

const DEG_TO_RAD = Math.PI / 180

/**
 * Handlers whose match is a self-contained visual: the scan takes its rect
 * and PRUNES the subtree (an Element's own children are its content — one
 * placeholder covers them). Everything else (containers, screen transforms,
 * colliders, plain nodes) is descended through.
 */
const LEAF_HANDLERS = new Set([
  "ElementHandler",
  "StandaloneContentHandler",
  "ShapeHandler",
  "TextHandler",
  "ImageHandler",
  "BaseMeshVisualHandler"
])

/** Leaf kinds hidden by disabling the matched COMPONENT (the node may hold
 * siblings); composite kinds hide the whole SceneObject instead. */
const COMPONENT_HIDE_HANDLERS = new Set(["TextHandler", "ImageHandler", "BaseMeshVisualHandler"])

interface MeasuredRect {
  node: SceneObject
  /** Hide this component while skeletonized; null = hide the whole node.
   * Component-hiding covers Text/Image/mesh leaves (the node may hold
   * siblings) and container-riding Shapes (the node's CHILDREN must stay
   * visible and measurable). */
  hideComponent: {enabled: boolean} | null
  /** Text nodes get slimmer, gently-rounded placeholders. */
  isText: boolean
  /** Tree depth below the scan target — drives the cascade delay. */
  depth: number
  /** Rect center in group-root local space, cm. */
  center: vec3
  /** Rect size in group-root units, cm. */
  width: number
  height: number
}

interface RestoreEntry {
  object: SceneObject | null
  component: {enabled: boolean} | null
  /** The measured visual's own node — the handoff's scale bounce runs on
   * its transform (for component entries `object` is null). */
  node: SceneObject
  prevEnabled: boolean
  /** Cascade level (depth − minDepth) — the handoff staggers the reveal by it. */
  level: number
  /** Order among revealed siblings under the same parent (scan order) — the
   * handoff staggers within a level by it: 1st child first, 2nd next. */
  sibling: number
  /** Reveal group ordinal: the nearest level-0 chrome ancestor's scan-order
   * index — each tile arrives as a unit, one after another. A piece with no
   * such ancestor is its own group, so flat targets stagger item by item. */
  group: number
}

/** A revealed piece of content the handoff can fade: writer + its ORIGINAL
 * opacity (dimmed content must come back dimmed, not at 1). */
interface RevealTarget {
  fade: Channels.OpacityWriter
  to: number
}

interface BlockEntry {
  object: SceneObject
  visual: SkeletonBlockVisual
  material: Material | null
}

/**
 * Skeleton loader — the spec's "Group Pulses" (Loading Phase Animation).
 *
 * Point it at a target SceneObject and {@link start} it: the component
 * walks the target's hierarchy, finds every visual (UIKit Elements, Shapes,
 * Text, Images, mesh visuals) via the Layout2D handler registry, measures
 * each one, hides the originals, and overlays one generated rounded-rect
 * placeholder block per visual. ONE sheen wave then crosses the WHOLE group
 * in unison — a single looping Motion clock (`skeleton.pulse`) fans one
 * phase value out to every block's material, and the band field lives in
 * the TARGET's local space, so the sheen is spatially continuous across
 * every block (the spec's "grouped pulses" idea): a piece lights exactly
 * when the sweep line crosses it, never on a per-block clock of its own.
 * The blocks also breathe alpha together on the same clock.
 *
 * Three refinements ride the one clock (all recipe data):
 *  - direction: the wave runs along waveAngleDegrees (shipped top-left →
 *    bottom-right);
 *  - afterglow: a passed block stays a touch lighter and settles over the
 *    rest of the period (emberBoost);
 *  - cascade: each hierarchy level below the shallowest visual runs
 *    depthDelay later, so container chrome flashes first and its contents
 *    ripple after. A container that CARRIES a Shape (the FlexContainer
 *    background pattern) is skeletonized as chrome — only the shape
 *    component is hidden, and the scan still descends to its children.
 *
 * {@link complete} is the intended exit — the content arrived: the pulse
 * freezes, the blocks fade out, the real content fades back in level by
 * level at its original opacity, then everything is cleaned up and
 * {@link onCompleted} fires. {@link stop} is the immediate exit (instant
 * restore, no choreography); both leave a resting Skeleton that costs
 * nothing. {@link refresh} re-scans mid-pulse (content added/removed)
 * without restarting the clock, so new blocks join the wave in phase.
 *
 * Measurement notes (v1): rects come from each handler's layout measure
 * (preferred size) plus the node's pose relative to the target root;
 * blocks assume the target's visuals are axis-aligned with the root and
 * centered on their node origin. Text placeholders render at a themed
 * fraction of the text's measured height, centered, with gentle rounding.
 */
@component
export class Skeleton extends BaseScriptComponent {
  @input
  @hint("Root of the content to skeletonize; defaults to this SceneObject")
  @allowUndefined
  private _target: SceneObject | undefined

  @input
  @hint("Start pulsing automatically on start")
  private _autoStart: boolean = false

  @input
  @label("Theme")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Inherited", "Inherited"),
      new ComboBoxItem("System 2.0", "System2"),
      new ComboBoxItem("System 3.0", "System3")
    ])
  )
  private _themeOverride: string = "Inherited"

  private _initialized: boolean = false
  private _running: boolean = false
  private _phase: number = 0
  private _clock: Tween<number> | null = null
  private _container: SceneObject | null = null
  // Draw-order Canvas on the blocks container — the one object this component
  // owns under the target. N coplanar translucent blocks then sort by tree
  // order instead of by distance. Inherits a compatible ancestor Canvas rather
  // than nesting one. Lives and dies with the container (see destroyContainer).
  private canvasController: CanvasController | null = null
  // Disabled at rest; invalidateCanvasBinding() arms it for one reconcile.
  private canvasReconcileEvent: LateUpdateEvent | null = null
  private _blocks: BlockEntry[] = []
  private _restore: RestoreEntry[] = []
  private _warnedStaleMaterial: boolean = false
  private _handoff: Timeline | null = null

  private onInitializedEvent: ReplayEvent<void> = new ReplayEvent<void>()
  private _onInitialized?: PublicApi<void>
  public get onInitialized(): PublicApi<void> {
    return (this._onInitialized ??= this.onInitializedEvent.publicApi())
  }

  /**
   * Invoked when the handoff has fully finished: content revealed at its
   * original opacity, placeholder blocks destroyed.
   */
  private onCompletedEvent: Event<void> = new Event<void>()
  private _onCompleted?: PublicApi<void>
  public get onCompleted(): PublicApi<void> {
    return (this._onCompleted ??= this.onCompletedEvent.publicApi())
  }

  /**
   * Fired after every (re)scan with the number of blocks generated.
   */
  private onScannedEvent: Event<number> = new Event<number>()
  private _onScanned?: PublicApi<number>
  public get onScanned(): PublicApi<number> {
    return (this._onScanned ??= this.onScannedEvent.publicApi())
  }

  public get initialized(): boolean {
    return this._initialized
  }

  /**
   * True while the group pulse is running.
   */
  public get running(): boolean {
    return this._running
  }

  /**
   * The current loop phase (0..1) — the shared group clock. Exposed for
   * tests (band position and breathing derive from it deterministically).
   */
  public get phase(): number {
    return this._phase
  }

  /**
   * Number of placeholder blocks currently generated.
   */
  public get blockCount(): number {
    return this._blocks.length
  }

  /**
   * The scan target (defaults to this component's SceneObject). Settable
   * while stopped only.
   */
  public get target(): SceneObject {
    return this._target ?? this.sceneObject
  }

  public set target(value: SceneObject) {
    if (value === undefined || this._running) {
      return
    }
    this._target = value
  }

  /**
   * Re-resolves the blocks' governing Canvas at the next late update, after a
   * reparent or an ancestor Canvas change (VisualElement's protocol). No-op
   * while no blocks exist.
   *
   * Coverage caveat: the Canvas lives on the blocks container under {@link target},
   * but this hook is found on the Skeleton's OWN object — that is where the
   * OnEnableEvent fires and where ScrollWindow's duck-typed subtree walk finds
   * it. With the default target (this SceneObject) the two coincide. With an
   * authored target elsewhere, a reparent of the target's subtree never reaches
   * this hook, and an enable cycle here invalidates a binding that did not move.
   * A stale inherited binding then survives until the old Canvas is destroyed
   * (reconcile re-resolves a dead one), meanwhile the blocks distance-sort. If
   * that matters, call this directly after moving the target, or stop()/start()
   * to rebuild the container under the new ancestry.
   */
  public invalidateCanvasBinding(): void {
    if (!this.canvasController) {
      return
    }
    this.canvasController.invalidate()
    if (this.canvasReconcileEvent) {
      this.canvasReconcileEvent.enabled = true
    }
  }

  /**
   * Scan the target, hide its visuals, overlay placeholder blocks, and run
   * the group pulse until {@link stop}.
   */
  public start(): void {
    if (this._running) {
      return
    }
    // A restart during the handoff settles it first (content shown, blocks
    // cleaned up), so the new scan starts from a fully restored tree.
    if (this._handoff !== null) {
      this._handoff.complete()
    }
    this._running = true
    if (!this._initialized) {
      return
    }
    this.buildBlocks()
    const channel = Channels.custom<number>("skeleton.phase", () => ({
      read: () => this._phase,
      write: (value: number) => {
        this._phase = value
        const blocks = this._blocks
        for (let i = 0; i < blocks.length; i++) {
          const material = blocks[i].material
          if (material !== null) {
            material.mainPass.phase = value
          }
        }
      }
    }))
    this._clock = Intents.skeletonPulse({
      target: this,
      channel,
      // The cascade needs a period the beats FIT INSIDE — see the recipe's
      // wavePeriod note; the intent's default (durations.sweep) is too short.
      period: getActiveMotionProfile().recipes.skeletonPulse.wavePeriod
    })
  }

  /**
   * Stop pulsing: kill the clock, destroy the blocks, and restore every
   * hidden visual to its exact prior enabled state.
   */
  public stop(): void {
    this._running = false
    if (!this._initialized) {
      this._autoStart = false
      return
    }
    if (this._handoff !== null) {
      // A stop during the handoff finishes it instantly: content shown at
      // its original opacity, blocks cleaned up, onCompleted fired.
      this._handoff.complete()
      return
    }
    if (this._clock !== null) {
      this._clock.kill()
      this._clock = null
    }
    this._phase = 0
    this.teardownBlocks()
  }

  /**
   * The content has arrived — hand back to it. The pulse FREEZES where it
   * is, the placeholder blocks fade out together, then the original content
   * fades back in level by level (the same cascade language the loading
   * used), each piece landing on its ORIGINAL opacity. When the reveal
   * finishes the blocks are destroyed and {@link onCompleted} fires. All
   * timings come from the skeletonPulse recipe (handoffFadeOut / handoffFadeIn
   * / handoffStagger).
   *
   * Content kinds without a fade surface (composite Elements and Shapes with
   * no opacity property) pop in at their level's beat instead of fading —
   * still on the cascade, never early.
   */
  public complete(): void {
    if (!this._initialized || this._handoff !== null) {
      if (!this._initialized) {
        this._running = false
        this._autoStart = false
        this.onCompletedEvent.invoke()
      }
      return
    }
    if (!this._running) {
      this.onCompletedEvent.invoke()
      return
    }
    this._running = false
    // Pause: kill the clock but KEEP the phase — the blocks hold their
    // current pose while they fade.
    if (this._clock !== null) {
      this._clock.kill()
      this._clock = null
    }

    const reveals: {
      fade: Channels.OpacityWriter
      node: Transform
      baseScale: vec3
      group: number
      level: number
      sibling: number
      to: number
    }[] = []
    for (const entry of this._restore) {
      // Content that was hidden BEFORE the skeleton took over stays hidden;
      // content destroyed externally while the skeleton ran is skipped.
      if (
        !entry.prevEnabled ||
        isNull(entry.node) ||
        (entry.component !== null && isNull(entry.component)) ||
        (entry.object !== null && isNull(entry.object))
      ) {
        continue
      }
      // Re-enable FIRST, then zero the opacity: the fallback fade surface
      // (no fadeable material) writes opacity by flipping `enabled`, so the
      // opposite order would re-show those pieces at full strength here
      // instead of on their reveal beat.
      if (entry.component !== null) {
        entry.component.enabled = true
      } else if (entry.object !== null) {
        entry.object.enabled = true
      }
      const target = this.makeRevealTarget(entry)
      target.fade.opacity = 0
      // The bounce scales the piece's own node — its complete-time local
      // scale is the landing value, so authored scales come back exactly.
      const transform = entry.node.getTransform()
      reveals.push({
        fade: target.fade,
        node: transform,
        baseScale: transform.getLocalScale(),
        group: entry.group,
        level: entry.level,
        sibling: entry.sibling,
        to: target.to
      })
    }

    this._handoff = Intents.skeletonHandoff({
      blocks: this._blocks.map((block) => block.visual),
      reveals,
      onComplete: (forward: boolean) => {
        if (forward) {
          this.finishHandoff()
        }
      }
    })
  }

  /**
   * Handoff done: originals are visible at their original opacity, so the
   * restore ledger is settled — just destroy the blocks and announce.
   */
  private finishHandoff(): void {
    this._handoff = null
    this._restore = []
    this._phase = 0
    this._blocks = []
    this.destroyContainer()
    this.onCompletedEvent.invoke()
  }

  /**
   * A fade surface for one revealed original, with its ORIGINAL opacity:
   *  - anything exposing a numeric `opacity` (Shapes, RoundedRectangles);
   *  - Text, through its fill color's alpha;
   *  - otherwise a threshold writer that flips `enabled` on the first
   *    non-zero write — the content pops at its level's beat instead of
   *    fading, which keeps the cascade order even without a fade surface.
   */
  private makeRevealTarget(entry: RestoreEntry): RevealTarget {
    const carrier: unknown = entry.component ?? entry.object
    const withOpacity = carrier as {opacity?: number}
    if (typeof withOpacity.opacity === "number") {
      return {fade: withOpacity as Channels.OpacityWriter, to: withOpacity.opacity}
    }
    const asText = carrier as {textFill?: {color: vec4}}
    if (asText.textFill !== undefined) {
      const fill = asText.textFill
      const original = fill.color
      const to = original.w
      return {
        fade: {
          get opacity(): number {
            return isNull(carrier) ? 0 : fill.color.w
          },
          set opacity(value: number) {
            // Driven over many frames — the Text can be destroyed mid-fade.
            if (!isNull(carrier)) {
              fill.color = new vec4(original.x, original.y, original.z, value)
            }
          }
        },
        to
      }
    }
    const node = entry.object
    let shown = false
    return {
      fade: {
        get opacity(): number {
          return shown ? 1 : 0
        },
        set opacity(value: number) {
          shown = value > 0
          // The handoff timeline drives this over many frames — the piece
          // can be destroyed externally mid-fade.
          if (node !== null && !isNull(node)) {
            node.enabled = shown
          } else if (entry.component !== null && !isNull(entry.component)) {
            entry.component.enabled = shown
          }
        }
      },
      to: 1
    }
  }

  /**
   * Re-scan the target mid-pulse (content changed). The clock keeps
   * running — rebuilt blocks pick the wave up in phase from their new
   * group-space placement.
   */
  public refresh(): void {
    if (!this._running || !this._initialized) {
      return
    }
    this.teardownBlocks()
    this.buildBlocks()
  }

  public onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => {
      if (!this._initialized) {
        this.initialize()
      }
    })
    this.createEvent("OnDestroyEvent").bind(() => {
      this.stop()
    })
    this.createEvent("OnEnableEvent").bind(() => this.invalidateCanvasBinding())
    this.canvasReconcileEvent = this.createEvent("LateUpdateEvent")
    this.canvasReconcileEvent.enabled = false
    this.canvasReconcileEvent.bind(() => {
      // The container lives under `target`, which this component does not own. A
      // target subtree destroyed externally (no stop()/complete(), so
      // destroyContainer() never ran) takes the container and its Canvas with it,
      // and reconcile() then throws on a destroyed SceneObject. Measured in LS
      // 5.24: an uncaught throw here aborts the rest of that frame's lens
      // processing AND retires this handler for the life of the lens — so a later
      // start() over a live target would arm an event that never fires again. The
      // Canvas would go unbound with no way to recover. Nothing is left to rebind
      // when the container is gone, so disarm and return instead. ProgressBar and
      // Dropdown carry their Canvas on their own SceneObject, so OnDestroy always
      // releases first and neither can reach this.
      if (this._container === null || isNull(this._container)) {
        if (this.canvasReconcileEvent) {
          this.canvasReconcileEvent.enabled = false
        }
        return
      }
      // Disarm AFTER the call. This event's `enabled` bit IS the dirty flag, and
      // CanvasController.reconcile() re-arms its own bit and rethrows on failure,
      // so disarming first strands a dirty controller with no retry until the next
      // invalidateCanvasBinding(). Nothing in reconcile() calls back into this
      // component, so it cannot re-arm the event and a late disarm cannot swallow
      // one. Same ordering as Dropdown and ProgressBar.
      this.canvasController?.reconcile()
      if (this.canvasReconcileEvent) {
        this.canvasReconcileEvent.enabled = false
      }
    })
  }

  private initialize(): void {
    if (this._initialized) {
      return
    }
    this._initialized = true
    if (this._autoStart && !this._running) {
      this.start()
    } else if (this._running) {
      // start() was called pre-initialize; do the real work now.
      this._running = false
      this.start()
    }
    this.onInitializedEvent.invoke()
  }

  private resolveTheme(): Theme {
    const mgr = ThemeService.getInstance()
    const override = this._themeOverride === "Default" ? "Inherited" : this._themeOverride
    if (override !== "Inherited") {
      return mgr.getTheme(override) ?? mgr.currentTheme
    }
    return mgr.currentTheme
  }

  private get themeData(): SkeletonComponentDataType {
    const data = this.resolveTheme()?.componentData?.["Skeleton"] as Partial<SkeletonComponentDataType> | undefined
    return {...SkeletonComponentData, ...data}
  }

  // ─── Scan + spawn ────────────────────────────────────────────────────────

  private buildBlocks(): void {
    const root = this.target
    const rects: MeasuredRect[] = []
    this.collect(root, root, 0, rects)

    const data = this.themeData
    const recipe = getActiveMotionProfile().recipes.skeletonPulse
    const period = recipe.wavePeriod
    const duty = period > 0 ? Math.min(recipe.waveDuration / period, 1) : 1

    // A text's measured bounding box reads as a slab; its placeholder is a
    // slimmer bar on the same centerline. Shrunk BEFORE the span math so the
    // wave geometry sees the rects that actually render.
    for (const rect of rects) {
      if (rect.isText) {
        rect.height *= data.textHeightFactor
      }
    }

    // The cascade: each hierarchy level below the SHALLOWEST skeletonized
    // visual runs its wave a beat later, so a tile's chrome flashes first
    // and its contents ripple after. Normalizing to the shallowest level
    // keeps flat targets (every visual at one depth) delay-free.
    let minDepth = Infinity
    for (const rect of rects) {
      minDepth = Math.min(minDepth, rect.depth)
    }
    const delayPerLevel = period > 0 ? recipe.depthDelay / period : 0

    // ONE band field, in the TARGET's local space: every fragment keys off
    // its true position there, so the sheen is spatially continuous across
    // every block — a child piece lights exactly when the sweep line
    // crosses it, in lockstep with the chrome pixels next to it. Any
    // per-block uv remapping (anchor projections, per-extent normalization,
    // scaled bandDir) breaks that continuity and blocks start blinking as
    // units off the sweep line, which reads as an unintended stagger.
    const angle = recipe.waveAngleDegrees * DEG_TO_RAD
    const dirX = Math.cos(angle)
    const dirY = Math.sin(angle)
    let groupMin = Infinity
    let groupMax = -Infinity
    for (const rect of rects) {
      const centerProj = rect.center.x * dirX + rect.center.y * dirY
      const reach = Math.abs((rect.width / 2) * dirX) + Math.abs((rect.height / 2) * dirY)
      groupMin = Math.min(groupMin, centerProj - reach)
      groupMax = Math.max(groupMax, centerProj + reach)
    }
    const spanInv = groupMax > groupMin ? 1 / (groupMax - groupMin) : 1

    this._container = global.scene.createSceneObject("SkeletonBlocks")
    this._container.setParent(root)
    // createSceneObject does NOT inherit the render layer on setParent.
    this._container.layer = root.layer
    const containerTransform = this._container.getTransform()
    containerTransform.setLocalPosition(new vec3(0, 0, 0))
    containerTransform.setLocalRotation(quat.quatIdentity())
    containerTransform.setLocalScale(new vec3(1, 1, 1))

    // The Canvas exists before any block does (flatten + canvas is one atomic
    // change). Its rect is sorting-only — no ScreenTransform layout runs under
    // UIKit components. For legibility it is a rect centred on the container
    // origin (the Canvas pivot is (0, 0) = centre) that contains every block:
    // per axis, twice the farthest block edge from the origin. The raw extent
    // (max − min) would miss blocks whenever the group is not centred on the
    // target origin.
    let reachX = 0
    let reachY = 0
    for (const rect of rects) {
      reachX = Math.max(reachX, Math.abs(rect.center.x) + rect.width / 2)
      reachY = Math.max(reachY, Math.abs(rect.center.y) + rect.height / 2)
    }
    this.canvasController = new CanvasController(this._container)
    this.canvasController.ensure(new vec2(2 * reachX, 2 * reachY))

    const siblingCounts: Map<SceneObject, number> = new Map()
    // Reveal groups: each level-0 rect's NODE anchors a group, numbered in
    // scan order; every deeper rect belongs to its nearest anchoring
    // ancestor. Pieces with no anchor get their own group, so flat targets
    // (all rects level 0) simply stagger item by item.
    const groupRoots: Map<SceneObject, number> = new Map()
    let groupCount = 0
    for (const rect of rects) {
      if (rect.depth === minDepth) {
        groupRoots.set(rect.node, groupCount++)
      }
    }
    const groupOf = (rect: MeasuredRect): number => {
      let node: SceneObject | null = rect.node
      while (node !== null && !isNull(node)) {
        const found = groupRoots.get(node)
        if (found !== undefined) {
          return found
        }
        node = node.getParent()
      }
      return groupCount++
    }
    for (const rect of rects) {
      const blockObject = global.scene.createSceneObject("SkeletonBlock")
      blockObject.setParent(this._container)
      blockObject.layer = root.layer
      blockObject.getTransform().setLocalPosition(new vec3(rect.center.x, rect.center.y, rect.center.z + data.zLift))
      const visual = blockObject.createComponent(SkeletonBlockVisual.getTypeName()) as SkeletonBlockVisual
      visual.size = new vec2(rect.width, rect.height)
      visual.baseColor = data.baseColor
      // Text placeholders get their own gentler rounding — deliberately NOT
      // a capsule; everything else gets the themed block rounding.
      visual.cornerRadius = rect.isText ? data.textCornerRadius : data.cornerRadius
      const group = groupOf(rect)
      // blockProj re-bases the shared field into this block's local frame:
      // the block object sits at rect.center in target space, so the
      // fragment's target-space projection is centerProj + dot(pos, bandDir).
      const centerProj = rect.center.x * dirX + rect.center.y * dirY
      visual.setPulseParams({
        bandDirX: dirX,
        bandDirY: dirY,
        blockProj: centerProj - groupMin,
        spanInv,
        duty,
        bandWidth: recipe.bandWidth,
        waveBoost: recipe.waveBoost,
        emberBoost: recipe.emberBoost,
        emberFall: period > 0 ? recipe.emberFade / period : 1,
        phaseDelay: (rect.depth - minDepth) * delayPerLevel,
        // At idle only the top-level chrome is visible; deeper blocks exist
        // only while the wave is on them (alpha rides band + afterglow).
        waveReveal: rect.depth > minDepth ? 1 : 0,
        pulseMin: recipe.pulseMinAlpha,
        pulseMax: recipe.pulseMaxAlpha
      })
      visual.initialize()
      if (visual.material !== null) {
        visual.material.mainPass.phase = this._phase
        // A compiled shader that predates a uniform silently ignores its
        // writes — the cascade and afterglow would simply not render, with
        // nothing to see but "it looks flat". Say so once, loudly.
        // Checked against the NEWEST uniform, so it catches every stale
        // generation, not just the first.
        if (!this._warnedStaleMaterial && visual.material.mainPass.waveReveal === undefined) {
          this._warnedStaleMaterial = true
          print(
            "Skeleton: SkeletonBlock.mat is a stale import (no waveReveal uniform) — " +
              "the wave-reveal/cascade tuning will NOT render. Reload the project so Lens Studio reimports it."
          )
        }
      }
      this._blocks.push({object: blockObject, visual, material: visual.material})

      // Hide the original: the matched component where the node has other
      // duties (Text/Image/mesh leaves, container-riding chrome), otherwise
      // the whole SceneObject.
      // Sibling ordinal: position among this parent's REVEALED children, in
      // scan order (depth-first, so scan order IS sibling order).
      const parent = rect.node.getParent()
      const sibling = siblingCounts.get(parent) ?? 0
      siblingCounts.set(parent, sibling + 1)
      if (rect.hideComponent !== null) {
        this._restore.push({
          object: null,
          component: rect.hideComponent,
          node: rect.node,
          prevEnabled: rect.hideComponent.enabled,
          level: rect.depth - minDepth,
          sibling,
          group
        })
        rect.hideComponent.enabled = false
      } else {
        this._restore.push({
          object: rect.node,
          component: null,
          node: rect.node,
          prevEnabled: rect.node.enabled,
          level: rect.depth - minDepth,
          sibling,
          group
        })
        rect.node.enabled = false
      }
    }
    this.onScannedEvent.invoke(this._blocks.length)
  }

  /**
   * Depth-first scan: leaf-handler matches contribute a rect and prune;
   * everything else descends. A container node that also CARRIES a Shape
   * (the FlexContainer background pattern — card chrome on the layout
   * object) contributes a rect for that shape and still descends, hiding
   * only the shape component so the children stay visible and measurable.
   * The skeleton's own container is skipped.
   */
  private collect(node: SceneObject, root: SceneObject, depth: number, out: MeasuredRect[]): void {
    if (this._container !== null && node === this._container) {
      return
    }
    // Disabled subtrees are not part of the layout (content that should
    // skeletonize while empty should be enabled with a placeholder size).
    if (node !== root && !node.enabled) {
      return
    }
    if (node !== root) {
      const resolved = ItemHandlerRegistry.resolve(node)
      if (resolved !== null && LEAF_HANDLERS.has(resolved.handler.name)) {
        const rect = this.measureLeafRect(node, root, resolved, depth)
        if (rect !== null) {
          out.push(rect)
        }
        return
      }
      const shape = this.findRiddenShape(node)
      if (shape !== null) {
        const rect = this.makeRect(node, root, shape.width, shape.height, depth, shape, false)
        if (rect !== null) {
          out.push(rect)
        }
      }
    }
    const childCount = node.getChildrenCount()
    for (let i = 0; i < childCount; i++) {
      this.collect(node.getChild(i), root, depth + 1, out)
    }
  }

  /** A Shape component riding a non-leaf node (container background). */
  private findRiddenShape(node: SceneObject): {enabled: boolean; width: number; height: number} | null {
    const scripts = node.getComponents("Component.ScriptComponent")
    for (const script of scripts) {
      if ((script as unknown as {__uikitBrand?: string}).__uikitBrand === UIKitBrands.Shape) {
        return script as unknown as {enabled: boolean; width: number; height: number}
      }
    }
    return null
  }

  /**
   * A leaf's placeholder rect: the handler's preferred measure. Zero-area
   * content is skipped (e.g. empty Text) — give such nodes a real
   * placeholder size or exclude them.
   */
  private measureLeafRect(
    node: SceneObject,
    root: SceneObject,
    resolved: ResolvedHandler,
    depth: number
  ): MeasuredRect | null {
    const measurement = resolved.handler.measure(node, resolved.component, node.getTransform())
    const hideComponent = COMPONENT_HIDE_HANDLERS.has(resolved.handler.name)
      ? (resolved.component as {enabled: boolean})
      : null
    return this.makeRect(
      node,
      root,
      measurement.preferred.width,
      measurement.preferred.height,
      depth,
      hideComponent,
      resolved.handler.name === "TextHandler"
    )
  }

  /**
   * Rect in root-local space: size scaled by the node's world scale relative
   * to the root, centered on the node's origin.
   */
  private makeRect(
    node: SceneObject,
    root: SceneObject,
    rawWidth: number,
    rawHeight: number,
    depth: number,
    hideComponent: {enabled: boolean} | null,
    isText: boolean
  ): MeasuredRect | null {
    const transform = node.getTransform()
    const rootTransform = root.getTransform()
    const rootScale = rootTransform.getWorldScale()
    const nodeScale = transform.getWorldScale()
    const relX = rootScale.x !== 0 ? nodeScale.x / rootScale.x : 1
    const relY = rootScale.y !== 0 ? nodeScale.y / rootScale.y : 1
    // A mirrored visual (negative scale) still occupies its |size| — without
    // the abs it would silently fail the >0 check and get no placeholder.
    const width = Math.abs(rawWidth * relX)
    const height = Math.abs(rawHeight * relY)
    if (!(width > 0) || !(height > 0)) {
      return null
    }
    const center = rootTransform.getInvertedWorldTransform().multiplyPoint(transform.getWorldPosition())
    return {node, hideComponent, isText, depth, center, width, height}
  }

  /** Releases the blocks' Canvas, then the container that carried it. */
  private destroyContainer(): void {
    const canvasController = this.canvasController
    this.canvasController = null
    if (this.canvasReconcileEvent) {
      this.canvasReconcileEvent.enabled = false
    }
    canvasController?.release()
    if (this._container !== null && !isNull(this._container)) {
      this._container.destroy()
    }
    this._container = null
  }

  private teardownBlocks(): void {
    for (const entry of this._restore) {
      // Content destroyed externally while the skeleton ran has nothing to
      // restore — touching it would throw.
      if (entry.component !== null && !isNull(entry.component)) {
        entry.component.enabled = entry.prevEnabled
      } else if (entry.object !== null && !isNull(entry.object)) {
        entry.object.enabled = entry.prevEnabled
      }
    }
    this._restore = []
    this._blocks = []
    this.destroyContainer()
  }
}

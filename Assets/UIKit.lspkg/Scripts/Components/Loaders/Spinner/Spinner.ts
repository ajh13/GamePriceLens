import Event, {PublicApi} from "InteractionKit.lspkg/Utils/Event"
import {clamp, lerp} from "InteractionKit.lspkg/Utils/mathUtils"
import ReplayEvent from "InteractionKit.lspkg/Utils/ReplayEvent"
import {OpacityControllable} from "../../../Interfaces/OpacityControllable"
import {SpinnerComponentData, SpinnerComponentDataType} from "../../../Themes/System-3.0/Styles/SpinnerParameters"
import {Theme} from "../../../Themes/Theme"
import {ThemeService} from "../../../Themes/ThemeService"
import {SpinnerVisual} from "../../../Visuals/Spinner/SpinnerVisual"
import {Layoutable} from "../../Layout2D/Layoutable"
import {UIKitBrands} from "../../Layout2D/UIKitBrands"
// Side-effect import — register UIKit Layout2D handlers. Spinner
// doesn't extend Element, so it needs its own bootstrap reference.
import "../../../UIKitBootstrap"

const HALF_PI = Math.PI / 2
const TWO_PI = Math.PI * 2

/**
 * Frame-time clamp for the spin clock, so a hitch skips animation time
 * instead of teleporting the arc (same guard as the legacy loading
 * spinners).
 */
const MAX_FRAME_DT = 1 / 30

/**
 * Phases of the completion sequence (see {@link Spinner.complete}). Kept as
 * two explicitly separated sections that play back-to-back so each can be
 * retuned or redesigned independently.
 */
enum CompletionPhase {
  None,
  /** Section 1: one fast spin settling into a short, dimmed arc. */
  Spin,
  /** Section 2: the arc sweeps out into a full solid ring, then fades. */
  Fill
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/**
 * A circular loading indicator ("circle loader").
 *
 * Two modes:
 * - **Indeterminate** — {@link startSpinning}: an arc chases around the
 *   ring, rotating clockwise while its length breathes between the theme's
 *   min/max aperture.
 * - **Determinate** — set {@link progress} (0..1): the arc grows clockwise
 *   from 12 o'clock, reaching a full ring at 1. Setting progress leaves
 *   indeterminate mode; {@link startSpinning} returns to it.
 *
 * Rendering is a single {@link SpinnerVisual} (arc-strip mesh + SDF
 * shader): fragments are paid only over the lit arc, and the per-frame
 * cost while spinning is three uniform writes with zero allocation. When
 * neither spinning nor showing progress the visual is disabled and the
 * update handler early-returns.
 *
 * The current look is a DEBUG PLACEHOLDER (garish magenta-to-cyan
 * gradient from the theme's Spinner data) pending the visual-lock pass.
 */
@component
export class Spinner extends BaseScriptComponent implements Layoutable, OpacityControllable {
  /**
   * Type brand consumed by the Layout2D `ElementHandler` finder. Spinner
   * is `Layoutable` but doesn't extend Element. See
   * `Components/Layout2D/UIKitBrands.ts`.
   */
  public readonly __uikitBrand = UIKitBrands.Element

  @input
  @hint("Size of the spinner in centimeters; the ring diameter is min(x, y)")
  private _size: vec3 = new vec3(3, 3, 1)

  @input
  @hint("Ring thickness in centimeters")
  private _thickness: number = 0.15

  @input
  @hint("Start the indeterminate spin automatically on start")
  private _autoStart: boolean = true

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

  private _visual: SpinnerVisual | null = null
  // Owner opacity (see opacity), kept so a pre-initialize write reaches the visual.
  private _hostOpacity: number = 1
  private visualObject: SceneObject | null = null

  // Render order forwarded to the visual's mesh. Cached so a pre-initialize
  // write survives (applied in initialize()); mirrors the thickness pattern.
  private _renderOrder: number = 0

  private _initialized: boolean = false
  private _isSpinning: boolean = false
  private _stopping: boolean = false
  private _progress: number | null = null
  private _progressDisplay: number = 0
  private _spinTime: number = 0
  private _opacityTarget: number = 1

  // Theme-derived animation constants, cached at initialize() (theme swaps
  // only affect components created after the swap — see AGENTS.md).
  private _spinSpeed: number = SpinnerComponentData.spinSpeed
  private _apertureCycleSeconds: number = SpinnerComponentData.apertureCycleSeconds
  private _minAperture: number = Math.PI * SpinnerComponentData.minApertureFactor
  private _maxAperture: number = Math.PI * SpinnerComponentData.maxApertureFactor
  private _fadeInSeconds: number = SpinnerComponentData.fadeInSeconds
  private _fadeOutSeconds: number = SpinnerComponentData.fadeOutSeconds
  private _arcFadeFraction: number = SpinnerComponentData.arcFadeFraction
  private _themed: SpinnerComponentDataType = SpinnerComponentData

  // Completion-sequence state (see complete()).
  private _completePhase: CompletionPhase = CompletionPhase.None
  private _completeTime: number = 0
  private _completeStartAperture: number = 0
  private _completeStartOpacity: number = 1
  private _fillTailAngle: number = 0
  private _fillTailOffset: number = 0
  private _fillTailMoving: boolean = false
  private _fillStartAperture: number = 0
  private _fillStartOpacity: number = 1

  private onSizeChangedEvent: Event<vec3> = new Event<vec3>()
  private onInitializedEvent: ReplayEvent<void> = new ReplayEvent<void>()

  /**
   * Invoked when {@link progress} changes (determinate mode only).
   */
  private onProgressChangedEvent: Event<number> = new Event()
  private _onProgressChanged?: PublicApi<number>
  public get onProgressChanged(): PublicApi<number> {
    return (this._onProgressChanged ??= this.onProgressChangedEvent.publicApi())
  }

  /**
   * Invoked when the completion sequence ({@link complete}) has fully
   * finished and the spinner is hidden.
   */
  private onCompletedEvent: Event<void> = new Event()
  private _onCompleted?: PublicApi<void>
  public get onCompleted(): PublicApi<void> {
    return (this._onCompleted ??= this.onCompletedEvent.publicApi())
  }

  /**
   * Fired when the size of the spinner changes.
   * Used by Layout2D (ElementHandler) to detect size changes.
   */
  private _onSizeChanged?: PublicApi<vec3>
  public get onSizeChanged(): PublicApi<vec3> {
    return (this._onSizeChanged ??= this.onSizeChangedEvent.publicApi())
  }

  /**
   * Fired once when the spinner has finished initialization.
   */
  private _onInitialized?: PublicApi<void>
  public get onInitialized(): PublicApi<void> {
    return (this._onInitialized ??= this.onInitializedEvent.publicApi())
  }

  public get initialized(): boolean {
    return this._initialized
  }

  /**
   * Determinate progress in 0..1, or `null` while in indeterminate mode.
   * Setting a value switches to determinate mode: a soft-ended arc grows
   * clockwise from 12 o'clock, easing smoothly toward each new value.
   * When the displayed arc reaches 1 it finishes itself — seals solid,
   * holds a beat, dissolves, and fires {@link onCompleted} (the same
   * ending {@link complete} plays). Call {@link startSpinning} to return
   * to indeterminate.
   */
  public get progress(): number | null {
    return this._progress
  }

  public set progress(value: number | null) {
    if (value === undefined) {
      return
    }
    if (value === null) {
      this.startSpinning()
      return
    }
    value = clamp(value, 0, 1)
    const changed = value !== this._progress
    const entering = this._progress === null
    this._progress = value
    this._isSpinning = false
    this._stopping = false
    this._completePhase = CompletionPhase.None
    if (entering) {
      // Fresh entry fills up from empty.
      this._progressDisplay = 0
    }
    if (this._initialized && this._visual) {
      this._visual.opacity = 1
      this._visual.thickness = this._thickness
      this.applyProgressArc()
      this.refreshVisibility()
    }
    if (changed) {
      this.onProgressChangedEvent.invoke(value)
    }
  }

  /**
   * Enter (or resume) indeterminate mode: the ring fades in over the
   * theme's fadeInSeconds and spins until {@link stop} is called or
   * {@link progress} is set.
   */
  public startSpinning(): void {
    const wasHidden =
      this._initialized && this.visualObject !== null && !isNull(this.visualObject) && !this.visualObject.enabled
    this._progress = null
    this._progressDisplay = 0
    this._isSpinning = true
    this._stopping = false
    this._completePhase = CompletionPhase.None
    this._opacityTarget = 1
    if (this._initialized) {
      if (this._visual) {
        // Undo any in-flight completion dissolve.
        this._visual.thickness = this._thickness
        if (wasHidden) {
          // Starting from hidden fades in like the first auto-start.
          this._visual.opacity = 0
        }
      }
      this.applySpinArc()
      this.refreshVisibility()
    }
  }

  /**
   * Play the completion sequence, then hide and fire {@link onCompleted}.
   * The base rotation never changes — only the arc's two ends change speed.
   * Two sections play in strict order:
   * 1. the tail accelerates and catches up toward the head, shrinking the
   *    arc to a short, dimmed arc, which rides on at normal speed for a
   *    full revolution;
   * 2. the head accelerates and sweeps all the way around, catching the
   *    still-moving tail to close a solid ring, which then fades away.
   * Called while showing determinate progress it skips section 1 and fills
   * from the current arc. Called while hidden it just fires the event.
   */
  public complete(): void {
    if (!this._initialized || this._completePhase !== CompletionPhase.None) {
      if (!this._initialized) {
        this._isSpinning = false
        this._progress = null
        // An explicit pre-initialize call wins over the autoStart input.
        this._autoStart = false
        this.onCompletedEvent.invoke()
      }
      return
    }
    this._stopping = false
    this._completeTime = 0

    if (this._isSpinning) {
      this._isSpinning = false
      this._completePhase = CompletionPhase.Spin
      this._completeStartAperture = this.currentSpinAperture()
      this._completeStartOpacity = this._visual ? this._visual.opacity : 1
    } else if (this._progress !== null && this._progressDisplay > 0) {
      // No spin to resolve — go straight to section 2 from the arc as
      // currently displayed. A progress arc's tail is pinned at 12 o'clock.
      this._progress = null
      this._completePhase = CompletionPhase.Fill
      this._fillTailMoving = false
      this._fillTailAngle = HALF_PI
      this._fillStartAperture = Math.PI * this._progressDisplay
      this._fillStartOpacity = this._visual ? this._visual.opacity : 1
      this._progressDisplay = 0
    } else {
      this._progress = null
      this.onCompletedEvent.invoke()
      return
    }
    this.refreshVisibility()
  }

  /**
   * Stop the spinner (leaves determinate mode too). Indeterminate spin
   * keeps rotating while the ring fades out over the theme's
   * fadeOutSeconds, then the visual is disabled and the per-frame handler
   * goes idle — a stopped spinner costs nothing.
   */
  public stop(): void {
    this._progress = null
    this._progressDisplay = 0
    const wasActive = this._isSpinning || this._completePhase !== CompletionPhase.None
    this._completePhase = CompletionPhase.None
    if (!this._initialized) {
      this._isSpinning = false
      // An explicit pre-initialize call wins over the autoStart input.
      this._autoStart = false
      return
    }
    if (wasActive) {
      // Fade out, then hide (finalized in onUpdate). A cancelled completion
      // fades from wherever it was.
      this._isSpinning = true
      this._stopping = true
      this._opacityTarget = 0
    }
    this.refreshVisibility()
  }

  /**
   * Ring thickness in centimeters.
   */
  public get thickness(): number {
    return this._thickness
  }

  public set thickness(value: number) {
    if (value === undefined || value === this._thickness) {
      return
    }
    this._thickness = value
    if (this._initialized && this._visual) {
      this._visual.thickness = value
    }
  }

  /**
   * Opacity (0..1) of the whole spinner, multiplied with its own start / stop
   * fades, so a spinner fades with the panel it sits on. Safe to set before
   * or after initialization; 1 by default.
   */
  public get opacity(): number {
    return this._hostOpacity
  }

  public set opacity(value: number) {
    if (value === undefined) {
      return
    }
    this._hostOpacity = clamp(value, 0, 1)
    if (this._visual) {
      this._visual.hostOpacity = this._hostOpacity
    }
  }

  /**
   * Render order of the spinner's ring. Raise it above surrounding content to
   * draw the spinner on top (e.g. overlaid on results while loading).
   */
  public get renderOrder(): number {
    return this._renderOrder
  }

  public set renderOrder(value: number) {
    if (value === undefined || value === this._renderOrder) {
      return
    }
    this._renderOrder = value
    if (this._initialized && this._visual) {
      this._visual.renderOrder = value
    }
  }

  public get width(): number {
    return this._size.x
  }

  public set width(value: number) {
    this.size = new vec3(value, this._size.y, this._size.z)
  }

  public get height(): number {
    return this._size.y
  }

  public set height(value: number) {
    this.size = new vec3(this._size.x, value, this._size.z)
  }

  public get depth(): number {
    return this._size.z
  }

  public set depth(value: number) {
    this.size = new vec3(this._size.x, this._size.y, value)
  }

  public get layoutSize(): vec3 {
    return this._size
  }

  public get size(): vec3 {
    return this._size
  }

  public set size(size: vec3) {
    if (size === undefined) {
      return
    }
    if (this._size.x === size.x && this._size.y === size.y && this._size.z === size.z) {
      return
    }
    this._size = size
    if (this._initialized && this._visual) {
      this._visual.size = new vec2(this._size.x, this._size.y)
      this.onSizeChangedEvent.invoke(this._size)
    }
  }

  public onAwake(): void {
    this.createEvent("OnStartEvent").bind(this.onStart)
    this.createEvent("UpdateEvent").bind(this.onUpdateEvent)
    this.createEvent("OnDestroyEvent").bind(this.onDestroy)
    this.createEvent("OnEnableEvent").bind(this.onEnabled)
    this.createEvent("OnDisableEvent").bind(this.onDisabled)
  }

  private onStart = () => {
    if (!this._initialized) {
      this.initialize()
    }
  }

  private onUpdateEvent = () => {
    if (this._initialized) {
      this.onUpdate()
    }
  }

  private onDestroy = () => {
    this.release()
  }

  private onEnabled = () => {
    this.refreshVisibility()
  }

  private onDisabled = () => {
    if (this._initialized && this.visualObject && !isNull(this.visualObject)) {
      this.visualObject.enabled = false
    }
  }

  private resolveTheme(): Theme {
    const mgr = ThemeService.getInstance()
    const override = this._themeOverride === "Default" ? "Inherited" : this._themeOverride
    if (override !== "Inherited") {
      return mgr.getTheme(override) ?? mgr.currentTheme
    }
    return mgr.currentTheme
  }

  private get themeData(): Partial<SpinnerComponentDataType> {
    return (
      (this.resolveTheme()?.componentData?.["Spinner"] as Partial<SpinnerComponentDataType> | undefined) ??
      SpinnerComponentData
    )
  }

  private initialize(): void {
    if (this._initialized) {
      return
    }

    const data = this.themeData
    this._themed = {...SpinnerComponentData, ...data}
    this._spinSpeed = data.spinSpeed ?? SpinnerComponentData.spinSpeed
    this._apertureCycleSeconds = data.apertureCycleSeconds ?? SpinnerComponentData.apertureCycleSeconds
    this._minAperture = Math.PI * (data.minApertureFactor ?? SpinnerComponentData.minApertureFactor)
    this._maxAperture = Math.PI * (data.maxApertureFactor ?? SpinnerComponentData.maxApertureFactor)
    this._fadeInSeconds = data.fadeInSeconds ?? SpinnerComponentData.fadeInSeconds
    this._fadeOutSeconds = data.fadeOutSeconds ?? SpinnerComponentData.fadeOutSeconds
    this._arcFadeFraction = data.arcFadeFraction ?? SpinnerComponentData.arcFadeFraction

    this.visualObject = global.scene.createSceneObject("SpinnerVisual")
    // createSceneObject does NOT inherit the render layer on setParent —
    // copy it explicitly so the ring renders wherever its host renders.
    this.visualObject.layer = this.sceneObject.layer
    this.visualObject.setParent(this.sceneObject)
    // createComponent runs the visual's startup lifecycle inline, but every
    // SpinnerVisual property below also survives a pre-initialize write, so
    // ordering is safe either way.
    this._visual = this.visualObject.createComponent(SpinnerVisual.getTypeName()) as SpinnerVisual
    this._visual.size = new vec2(this._size.x, this._size.y)
    this._visual.thickness = this._thickness
    this._visual.renderOrder = this._renderOrder
    this._visual.hostOpacity = this._hostOpacity
    this._visual.colorTail = data.colorTail ?? SpinnerComponentData.colorTail
    this._visual.colorHead = data.colorHead ?? SpinnerComponentData.colorHead
    this._visual.arcFade = this._arcFadeFraction

    if (this._autoStart && this._progress === null) {
      this._isSpinning = true
    }
    if (this._isSpinning) {
      // First appearance fades in from nothing, like the reference.
      this._visual.opacity = 0
      this._opacityTarget = 1
    }

    this._initialized = true

    if (this._progress !== null) {
      this.applyProgressArc()
    } else if (this._isSpinning) {
      this.applySpinArc()
    }
    this.refreshVisibility()

    this.onInitializedEvent.invoke()

    if (this._progress !== null) {
      this.onProgressChangedEvent.invoke(this._progress)
    }
  }

  private onUpdate(): void {
    const progressAnimating = this._progress !== null && this._progressDisplay !== this._progress
    if (!this._isSpinning && !this._stopping && !progressAnimating && this._completePhase === CompletionPhase.None) {
      return
    }
    const dt = Math.min(getDeltaTime(), MAX_FRAME_DT)
    if (this._completePhase !== CompletionPhase.None) {
      this.updateCompletion(dt)
      return
    }
    if (this._progress !== null) {
      this.updateProgress(dt)
      return
    }
    this._spinTime += dt
    this.applySpinArc()
    this.updateFade(dt)
  }

  /**
   * Eases the displayed progress toward the set value; on reaching a full
   * ring, hands off to the completion ending (seal, solid beat, dissolve).
   */
  private updateProgress(dt: number): void {
    const target = this._progress
    if (target === null || !this._visual) {
      return
    }
    const tau = Math.max(this._themed.progressSmoothingSeconds, 0.001)
    let next = this._progressDisplay + (target - this._progressDisplay) * Math.min(dt / tau, 1)
    if (Math.abs(target - next) < 0.004) {
      next = target
    }
    this._progressDisplay = next
    this.applyProgressArc()
    if (next >= 1) {
      this.finishProgress()
    }
  }

  /**
   * The progress arc reached full — play the completion ending from the
   * seal onward. The fill-start aperture is chosen so the seal's fade
   * matches the progress arc's soft-end width exactly (no visual pop).
   */
  private finishProgress(): void {
    this._progress = null
    this._progressDisplay = 0
    this._completePhase = CompletionPhase.Fill
    this._completeTime = this._themed.completeFillSeconds
    this._fillTailMoving = false
    this._fillTailAngle = HALF_PI
    this._fillStartOpacity = 1
    this._fillStartAperture = (this._themed.progressFadeFraction * TWO_PI) / (2 * Math.max(this._arcFadeFraction, 1e-4))
  }

  private updateCompletion(dt: number): void {
    if (!this._visual) {
      return
    }
    this._completeTime += dt
    if (this._completePhase === CompletionPhase.Spin || this._fillTailMoving) {
      // The base rotation never stops during the completion — only the
      // arc's two ends change speed relative to it.
      this._spinTime += dt
    }
    if (this._completePhase === CompletionPhase.Spin) {
      this.updateCompleteSpin()
    }
    if (this._completePhase === CompletionPhase.Fill) {
      this.updateCompleteFill()
    }
  }

  /**
   * Completion section 1: the HEAD keeps cruising at base speed while the
   * TAIL accelerates to catch up, shrinking the arc to the settled size and
   * dimming it; the settled arc then rides on for a full revolution (or the
   * themed number of them).
   */
  private updateCompleteSpin(): void {
    const shrinkSeconds = this._themed.completeShrinkRevolutions / Math.max(this._spinSpeed, 0.01)
    const settleAperture = this._minAperture * this._themed.completeSettleFraction
    const holdSeconds = this._themed.completeHoldRevolutions / Math.max(this._spinSpeed, 0.01)
    const a0 = this._completeStartAperture
    if (this._completeTime < shrinkSeconds) {
      const k = easeInOutCubic(this._completeTime / shrinkSeconds)
      const aperture = lerp(a0, settleAperture, k)
      // Head angle rides the base rotation (center0 - a0); the center is
      // wherever head + current aperture puts it, so ALL of the shrink is
      // the tail end closing in.
      this._visual.setArc(this.currentSpinCenter() - a0 + aperture, aperture)
      this._visual.opacity = lerp(this._completeStartOpacity, this._themed.completeSettleOpacity, k)
      return
    }
    // Settled — ride at base speed for the hold revolution(s).
    this._visual.setArc(this.currentSpinCenter() - a0 + settleAperture, settleAperture)
    this._visual.opacity = this._themed.completeSettleOpacity
    if (this._completeTime >= shrinkSeconds + holdSeconds) {
      this._completePhase = CompletionPhase.Fill
      this._completeTime = 0
      // Section 2's tail keeps riding the base rotation from here: its
      // world angle stays currentSpinCenter() + this constant offset.
      this._fillTailMoving = true
      this._fillTailOffset = -a0 + 2 * settleAperture
      this._fillStartAperture = settleAperture
      this._fillStartOpacity = this._themed.completeSettleOpacity
    }
  }

  /**
   * Completion section 2: the TAIL keeps cruising at base speed while the
   * HEAD accelerates and sweeps all the way around, catching the tail to
   * close a solid full-opacity ring, which then fades away. (Entered from
   * determinate progress the tail is static at 12 o'clock instead.)
   */
  private updateCompleteFill(): void {
    const fillSeconds = this._themed.completeFillSeconds
    const sealSeconds = this._themed.completeSealSeconds
    const solidSeconds = this._themed.completeSolidSeconds
    const fadeSeconds = this._themed.completeFadeSeconds
    const tail = this._fillTailMoving ? this.currentSpinCenter() + this._fillTailOffset : this._fillTailAngle
    // arcFade is a fraction of the arc's LENGTH; holding fade * aperture
    // constant keeps the soft ends a constant angular size while the arc
    // grows — the ends stay soft all the way through the close, and only
    // the solid middle gets longer.
    const fadeAngle = this._arcFadeFraction * this._fillStartAperture
    if (this._completeTime < fillSeconds) {
      const k = easeInOutCubic(this._completeTime / fillSeconds)
      const aperture = lerp(this._fillStartAperture, Math.PI, k)
      this._visual.arcFade = fadeAngle / aperture
      this._visual.arcFadeLift = 0
      // Brightness returns much faster than the sweep in the reference —
      // full opacity by roughly a third of the way through the fill.
      this._visual.opacity = lerp(this._fillStartOpacity, 1, Math.min(k * 3, 1))
      // Keeping (center + aperture) glued to the tail means all growth
      // happens at the head, clockwise, closing exactly onto the tail.
      this._visual.setArc(tail - aperture, aperture)
      return
    }
    if (this._completeTime < fillSeconds + sealSeconds) {
      // Closed — flood the soft seam up to solid. The fade SHAPE stays
      // untouched (soft end to soft end); lift raises the whole valley, so
      // neither end ever sharpens to a flat edge.
      const k = (this._completeTime - fillSeconds) / sealSeconds
      this._visual.arcFade = fadeAngle / Math.PI
      this._visual.arcFadeLift = k
      this._visual.setArc(tail - Math.PI, Math.PI)
      this._visual.opacity = 1
      return
    }
    if (this._completeTime < fillSeconds + sealSeconds + solidSeconds) {
      // Fully solid ring holds for a beat.
      this._visual.arcFadeLift = 1
      this._visual.setArc(tail - Math.PI, Math.PI)
      this._visual.opacity = 1
      return
    }
    if (this._completeTime < fillSeconds + sealSeconds + solidSeconds + fadeSeconds) {
      // Dissolve from the center outward: the outer edge stays anchored
      // (outer radius derives from size, which doesn't change) while the
      // thickness collapses, so the inner edge recedes outward until the
      // ring is gone. Opacity follows in the back half to clean up the
      // final hairline.
      const k = (this._completeTime - fillSeconds - sealSeconds - solidSeconds) / fadeSeconds
      this._visual.arcFadeLift = 1
      this._visual.setArc(tail - Math.PI, Math.PI)
      this._visual.thickness = this._thickness * (1 - easeInOutCubic(k))
      this._visual.opacity = 1 - Math.max(0, (k - 0.5) * 2)
      return
    }
    // Done — hide, restore the ring for its next run, and announce.
    this._completePhase = CompletionPhase.None
    this._visual.opacity = 0
    this._visual.thickness = this._thickness
    this.refreshVisibility()
    this.onCompletedEvent.invoke()
  }

  /**
   * Moves the whole-ring opacity toward its target (start fade-in / stop
   * fade-out); finalizes a stop once fully faded.
   */
  private updateFade(dt: number): void {
    if (!this._visual) {
      return
    }
    const current = this._visual.opacity
    if (current === this._opacityTarget) {
      return
    }
    const seconds = this._opacityTarget > current ? this._fadeInSeconds : this._fadeOutSeconds
    const step = dt / Math.max(seconds, 0.001)
    const next =
      this._opacityTarget > current
        ? Math.min(current + step, this._opacityTarget)
        : Math.max(current - step, this._opacityTarget)
    this._visual.opacity = next
    if (this._stopping && next <= 0) {
      this._stopping = false
      this._isSpinning = false
      this.refreshVisibility()
    }
  }

  /**
   * Indeterminate choreography (placeholder): constant clockwise rotation
   * while the arc length breathes between the theme's min and max aperture.
   */
  private applySpinArc(): void {
    if (!this._visual) {
      return
    }
    this._visual.arcFade = this._arcFadeFraction
    this._visual.arcFadeLift = 0
    this._visual.setArc(this.currentSpinCenter(), this.currentSpinAperture())
  }

  private currentSpinCenter(): number {
    return HALF_PI - this._spinTime * this._spinSpeed * TWO_PI
  }

  private currentSpinAperture(): number {
    const pulse = 0.5 - 0.5 * Math.cos((this._spinTime / this._apertureCycleSeconds) * TWO_PI)
    return this._minAperture + (this._maxAperture - this._minAperture) * pulse
  }

  /**
   * Determinate arc: tail pinned at 12 o'clock, head sweeping clockwise;
   * progress 1 closes the ring exactly (aperture π).
   */
  private applyProgressArc(): void {
    if (!this._visual || this._progress === null) {
      return
    }
    const aperture = this._progressDisplay * Math.PI
    if (aperture <= 0) {
      return
    }
    // Soft ends of constant angular width (same visual language as the
    // completion fill); arcFade is a fraction of arc length, so convert.
    const fadeAngle = this._themed.progressFadeFraction * TWO_PI
    this._visual.arcFade = Math.min(0.5, fadeAngle / (2 * aperture))
    this._visual.arcFadeLift = 0
    this._visual.setArc(HALF_PI - aperture, aperture)
  }

  private refreshVisibility(): void {
    if (!this._initialized || !this.visualObject || isNull(this.visualObject)) {
      return
    }
    const showing =
      this._isSpinning ||
      this._stopping ||
      this._completePhase !== CompletionPhase.None ||
      (this._progress !== null && this._progress > 0)
    this.visualObject.enabled = showing && this.enabled
  }

  private release(): void {
    this._visual = null
    if (this.visualObject && !isNull(this.visualObject)) {
      this.visualObject.destroy()
    }
    this.visualObject = null
  }
}

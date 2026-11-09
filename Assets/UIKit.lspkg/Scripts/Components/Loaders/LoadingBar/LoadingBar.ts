import Event, {PublicApi} from "InteractionKit.lspkg/Utils/Event"
import {clamp} from "InteractionKit.lspkg/Utils/mathUtils"
import ReplayEvent from "InteractionKit.lspkg/Utils/ReplayEvent"
import * as Channels from "Motion.lspkg/Channels"
import {Timeline} from "Motion.lspkg/Timeline"
import {Tween} from "Motion.lspkg/Tween"
import {Intents} from "../../../Motion/SpecIntents"
import {
  LoadingBarComponentData,
  LoadingBarComponentDataType
} from "../../../Themes/System-3.0/Styles/LoadingBarParameters"
import {Theme} from "../../../Themes/Theme"
import {ThemeService} from "../../../Themes/ThemeService"
import {LoadingBarVisual} from "../../../Visuals/LoadingBar/LoadingBarVisual"
import {Layoutable} from "../../Layout2D/Layoutable"
import {UIKitBrands} from "../../Layout2D/UIKitBrands"
// Side-effect import — register UIKit Layout2D handlers. LoadingBar
// doesn't extend Element, so it needs its own bootstrap reference.
import "../../../UIKitBootstrap"

/**
 * Diagnostic switch. A blank bar has several possible causes that are
 * indistinguishable by eye, so this logs which layer is alive: the script
 * running at all, the material cloning, the sweep actually being built, the
 * uniforms animating, and the visual staying enabled. NB while on, every bar
 * binds a per-frame UpdateEvent — it suspends the zero-cost-at-rest rule.
 */
const DEBUG_LOADING_BAR = false

/**
 * An indeterminate/determinate loading bar (spec "Loading Phase Animation").
 *
 * A standalone attachable primitive: size it to a host edge (a list row's
 * separator line, a pill's bottom edge) and it sweeps a lit band along its
 * width. Two visual variants:
 * - **Line** — a thin streak; the bar quad IS the line (list-row demo).
 * - **Comet** — an iridescent head with a trailing falloff whose glow
 *   bleeds upward into the host body (pill demo).
 *
 * Two modes:
 * - **Indeterminate** — {@link start}: the band sweeps left→right forever,
 *   driven by the `loader.sweep` Motion intent (one looping phase tween →
 *   one shader uniform; per-frame cost is a single uniform write).
 * - **Determinate** — set {@link progress} (0..1): a solid fill eases
 *   toward the value (`loader.fill`). Reaching 1 finishes: the bar fades
 *   out and {@link onCompleted} fires. Setting progress leaves
 *   indeterminate mode; {@link start} returns to it.
 *
 * Stopped/at rest the visual is disabled and no tweens are live — a
 * resting LoadingBar costs nothing.
 */
@component
export class LoadingBar extends BaseScriptComponent implements Layoutable {
  /**
   * Type brand consumed by the Layout2D `ElementHandler` finder.
   */
  public readonly __uikitBrand = UIKitBrands.Element

  @input
  @hint("Size of the bar in centimeters (x = swept width, y = bar height)")
  private _size: vec3 = new vec3(6, 0.12, 1)

  @input
  @label("Variant")
  @widget(new ComboBoxWidget([new ComboBoxItem("Line", "Line"), new ComboBoxItem("Comet", "Comet")]))
  private _variant: string = "Line"

  @input
  @hint("Start the indeterminate sweep automatically on start")
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

  private _visual: LoadingBarVisual | null = null
  private visualObject: SceneObject | null = null

  private _initialized: boolean = false
  private _running: boolean = false
  private _hiding: boolean = false
  private _progress: number | null = null
  private _renderOrder: number = 0

  // Live motion (held so stop() releases everything — zero cost at rest).
  /** The sweep's looping drivers (head, tail, opacity) — killed as a set. */
  private _sweep: Tween<number>[] | null = null
  private _fill: Tween<number> | null = null
  private _fade: Timeline | null = null

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
   * Invoked when determinate progress reached 1 (the finish fade then
   * hides the bar).
   */
  private onCompletedEvent: Event<void> = new Event()
  private _onCompleted?: PublicApi<void>
  public get onCompleted(): PublicApi<void> {
    return (this._onCompleted ??= this.onCompletedEvent.publicApi())
  }

  /**
   * Fired when the size of the bar changes (Layout2D contract).
   */
  private _onSizeChanged?: PublicApi<vec3>
  public get onSizeChanged(): PublicApi<vec3> {
    return (this._onSizeChanged ??= this.onSizeChangedEvent.publicApi())
  }

  /**
   * Fired once when the bar has finished initialization.
   */
  private _onInitialized?: PublicApi<void>
  public get onInitialized(): PublicApi<void> {
    return (this._onInitialized ??= this.onInitializedEvent.publicApi())
  }

  public get initialized(): boolean {
    return this._initialized
  }

  /**
   * True while the indeterminate sweep is running.
   */
  public get running(): boolean {
    return this._running
  }

  /**
   * Determinate progress in 0..1, or `null` while indeterminate/stopped.
   * Setting a value switches to determinate mode; the displayed fill eases
   * toward it (`loader.fill` recipe smoothing). Reaching 1 plays the finish
   * fade and fires {@link onCompleted}. Setting `null` returns to the
   * indeterminate sweep (same contract as Spinner.progress).
   */
  public get progress(): number | null {
    return this._progress
  }

  public set progress(value: number | null) {
    if (value === undefined) {
      return
    }
    if (value === null) {
      this.start()
      return
    }
    value = clamp(value, 0, 1)
    const changed = value !== this._progress
    const entering = this._progress === null
    this._progress = value
    this.killSweep()
    // A finish/stop fade may still be driving opacity down — left alive it
    // would keep overwriting the fresh fill's opacity toward 0 (an active,
    // invisible bar).
    this.killFade()
    this._running = false
    if (this._initialized && this._visual !== null) {
      const material = this._visual.material
      if (entering) {
        // Determinate is the same lit span with its trail pinned at the left
        // edge (the shader does that from `solid`), so only the head moves;
        // a fresh entry fills up from empty.
        this._visual.solid = true
        this._visual.setSpan(0, 0)
        this._visual.opacity = 1
      }
      if (material !== null) {
        this._fill?.kill()
        this._fill = Intents.loaderFill({
          target: material,
          channel: Channels.shaderFloat(material, "headPos"),
          to: value,
          onComplete: () => {
            if (this._progress !== null && this._progress >= 1) {
              this.finishProgress()
            }
          }
        })
      }
      this.refreshVisibility()
    }
    if (changed) {
      this.onProgressChangedEvent.invoke(value)
    }
  }

  /**
   * Enter (or resume) indeterminate mode: the streak sweeps — stretching on
   * the way in, squashing as it lands — until {@link stop} is called or
   * {@link progress} is set. The sweep owns the bar's opacity while it runs
   * (per-cycle entry rise, exit fade and dark rest), so there is no separate
   * show fade to fight it.
   */
  public start(): void {
    this._progress = null
    this._running = true
    if (!this._initialized || this._visual === null) {
      return
    }
    this._visual.solid = false
    this.killFill()
    this.killFade()
    const material = this._visual.material
    if (this._sweep === null && material !== null) {
      this._sweep = Intents.loaderSweep({
        target: material,
        head: Channels.shaderFloat(material, "headPos"),
        lag: Channels.shaderFloat(material, "lagSpan"),
        alpha: this._visual
      })
    } else if (material === null) {
      // Silent-failure guard: without a material there is nothing to drive,
      // and the bar would sit invisible with no clue why.
      print(`LoadingBar[${this.sceneObject.name}]: no material — Materials/LoadingBar.mat did not resolve`)
    }
    this.refreshVisibility()
    if (DEBUG_LOADING_BAR) {
      print(`LoadingBar[${this.sceneObject.name}] start: sweep=${this._sweep !== null} enabled=${this.enabled}`)
    }
  }

  /**
   * Stop the bar (leaves determinate mode too): kills the sweep, hides the
   * visual and releases every tween — a stopped bar costs nothing. The
   * indeterminate sweep already fades itself out at the end of each cycle,
   * so stopping mid-sweep cuts rather than adding a second fade on top of
   * the one the choreography owns.
   */
  public stop(): void {
    this._progress = null
    if (!this._initialized) {
      this._running = false
      // An explicit pre-initialize call wins over the autoStart input.
      this._autoStart = false
      return
    }
    const wasFilling = this._fill !== null
    this._running = false
    this.killSweep()
    this.killFill()
    if (wasFilling) {
      // A determinate bar has no self-fade — give it one on the way out.
      this.fade(false)
      return
    }
    if (this._visual !== null) {
      this._visual.opacity = 0
    }
    this.refreshVisibility()
  }

  /**
   * Bar variant: "Line" (thin streak) or "Comet" (glowing head + bleed).
   */
  public get variant(): string {
    return this._variant
  }

  public set variant(value: string) {
    if (value === undefined || value === this._variant) {
      return
    }
    this._variant = value
    if (this._initialized) {
      // Variants differ only in look (colors, glow envelope, head bloom), so
      // a running sweep keeps its timeline — no rebuild, no phase reset.
      this.applyVariant()
    }
  }

  /**
   * Render order forwarded to the visual's mesh.
   */
  public get renderOrder(): number {
    return this._renderOrder
  }

  public set renderOrder(value: number) {
    if (value === undefined || value === this._renderOrder) {
      return
    }
    this._renderOrder = value
    if (this._initialized && this._visual !== null) {
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
    if (this._initialized && this._visual !== null) {
      this._visual.size = new vec2(this._size.x, this._size.y)
      this.onSizeChangedEvent.invoke(this._size)
    }
  }

  public onAwake(): void {
    this.createEvent("OnStartEvent").bind(this.onStart)
    this.createEvent("OnDestroyEvent").bind(this.onDestroy)
    this.createEvent("OnEnableEvent").bind(this.onEnabled)
    this.createEvent("OnDisableEvent").bind(this.onDisabled)
    if (DEBUG_LOADING_BAR) {
      print(`LoadingBar[${this.sceneObject.name}] onAwake`)
      this.createEvent("UpdateEvent").bind(this.debugTick)
    }
  }

  private debugElapsed: number = 0

  private debugTick = () => {
    this.debugElapsed += getDeltaTime()
    if (this.debugElapsed < 1) {
      return
    }
    this.debugElapsed = 0
    const visual = this._visual
    const pass = visual !== null && visual.material !== null ? visual.material.mainPass : null
    const visualEnabled =
      this.visualObject !== null && !isNull(this.visualObject) ? this.visualObject.enabled : "no-object"
    print(
      `LoadingBar[${this.sceneObject.name}] running=${this._running} sweep=${this._sweep !== null} ` +
        `visual=${visual !== null} material=${pass !== null} visualEnabled=${visualEnabled} ` +
        `size=${this._size.x}x${this._size.y} ` +
        (pass !== null
          ? `head=${(pass.headPos as number).toFixed(3)} lag=${(pass.lagSpan as number).toFixed(3)} ` +
            `opacity=${(pass.barOpacity as number).toFixed(3)} solid=${pass.solid}`
          : "(no material — the .mat never resolved)")
    )
  }

  private onStart = () => {
    if (!this._initialized) {
      this.initialize()
    }
  }

  private onDestroy = () => {
    this.release()
  }

  private onEnabled = () => {
    this.refreshVisibility()
  }

  private onDisabled = () => {
    if (this._initialized && this.visualObject !== null && !isNull(this.visualObject)) {
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

  private get themeData(): LoadingBarComponentDataType {
    const data = this.resolveTheme()?.componentData?.["LoadingBar"] as Partial<LoadingBarComponentDataType> | undefined
    return {...LoadingBarComponentData, ...data}
  }

  private initialize(): void {
    if (this._initialized) {
      return
    }

    this.visualObject = global.scene.createSceneObject("LoadingBarVisual")
    this.visualObject.setParent(this.sceneObject)
    // createSceneObject does NOT inherit the render layer on setParent —
    // copy it explicitly so the bar renders wherever its host renders.
    this.visualObject.layer = this.sceneObject.layer
    this._visual = this.visualObject.createComponent(LoadingBarVisual.getTypeName()) as LoadingBarVisual
    this._visual.size = new vec2(this._size.x, this._size.y)
    this._visual.renderOrder = this._renderOrder
    this.applyVariant()
    // Initialize the visual NOW (idempotent; its OnStartEvent may not have
    // fired yet) — start()/progress attach Motion channels to the cloned
    // material, so it must exist before they run. Without this, an
    // editor-added bar starts before the visual's own lifecycle and the
    // sweep is silently never created (an empty span renders nothing).
    this._visual.initialize()

    if (this._autoStart && this._progress === null) {
      this._running = true
    }
    if (this._running) {
      // The sweep's own entry rise takes it up from nothing.
      this._visual.opacity = 0
    }

    this._initialized = true

    if (this._progress !== null) {
      const restored = this._progress
      this._progress = null
      this.progress = restored
    } else if (this._running) {
      this._running = false
      this.start()
    }
    this.refreshVisibility()

    this.onInitializedEvent.invoke()
  }

  private applyVariant(): void {
    if (this._visual === null) {
      return
    }
    const data = this.themeData
    const comet = this._variant === "Comet"
    this._visual.colorHead = comet ? data.cometColorHead : data.lineColorHead
    this._visual.colorTail = comet ? data.cometColorTail : data.lineColorTail
    this._visual.glowShape = comet ? data.cometGlowShape : data.lineGlowShape
    this._visual.headSoftness = comet ? data.cometHeadSoftness : data.lineHeadSoftness
  }

  /**
   * Show/hide fade for the DETERMINATE path only — the indeterminate sweep
   * fades itself per cycle and owns the alpha channel while it runs, so the
   * two must never be live at once (they would fight over the same claim).
   */
  private fade(show: boolean): void {
    if (this._visual === null) {
      return
    }
    this._hiding = !show
    if (this._fade === null) {
      this._fade = Intents.panelFade({
        alpha: this._visual,
        onComplete: (forward: boolean) => {
          if (!forward) {
            this._hiding = false
            this.killFill()
            this.refreshVisibility()
          }
        }
      })
      // panelFade plays forward on creation; a hide-first call reverses
      // below — from the END, not from 0, or the reverse would complete on
      // the spot and the bar would vanish instead of fading out.
      if (show) {
        return
      }
      this._fade.scrub(1)
    }
    this._fade.play(show)
  }

  private killFade(): void {
    if (this._fade !== null) {
      this._fade.kill()
      this._fade = null
      this._hiding = false
    }
  }

  private finishProgress(): void {
    this._progress = null
    this.killFill()
    this.fade(false)
    this.onCompletedEvent.invoke()
  }

  private killSweep(): void {
    if (this._sweep !== null) {
      for (const driver of this._sweep) {
        driver.kill()
      }
      this._sweep = null
    }
  }

  private killFill(): void {
    if (this._fill !== null) {
      this._fill.kill()
      this._fill = null
    }
  }

  private refreshVisibility(): void {
    if (!this._initialized || this.visualObject === null || isNull(this.visualObject)) {
      return
    }
    const showing = this._running || this._progress !== null || this._hiding
    this.visualObject.enabled = showing && this.enabled
  }

  private release(): void {
    this.killSweep()
    this.killFill()
    if (this._fade !== null) {
      this._fade.kill()
      this._fade = null
    }
    this._visual = null
    if (this.visualObject !== null && !isNull(this.visualObject)) {
      this.visualObject.destroy()
    }
    this.visualObject = null
  }
}

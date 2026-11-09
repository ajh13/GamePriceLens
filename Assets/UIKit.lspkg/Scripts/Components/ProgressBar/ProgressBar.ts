import Event, {PublicApi} from "InteractionKit.lspkg/Utils/Event"
import {clamp, lerp} from "InteractionKit.lspkg/Utils/mathUtils"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import ReplayEvent from "InteractionKit.lspkg/Utils/ReplayEvent"
import {SpringAnimate} from "InteractionKit.lspkg/Utils/springAnimate"
import {ProgressBarFillGreen, ProgressBarTrackGray} from "../../Themes/System-3.0/Colors"
import {Theme} from "../../Themes/Theme"
import {ThemeService} from "../../Themes/ThemeService"
import {CanvasController} from "../../Utility/CanvasController"
import {applyFlatRenderOrder, Z_LAYER_STEP} from "../../Utility/DrawOrderLayering"
import {Callback, createCallbacks} from "../../Utility/SceneUtilities"
import {
  RoundedRectangleVisual,
  RoundedRectangleVisualParameters
} from "../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {Layoutable} from "../Layout2D/Layoutable"
import {UIKitBrands} from "../Layout2D/UIKitBrands"
// Side-effect import — register UIKit Layout2D handlers. ProgressBar
// doesn't extend Element, so it needs its own bootstrap reference.
import "../../UIKitBootstrap"

const log = new NativeLogger("ProgressBar")

const SPRING_EPSILON: number = 0.001
// Both renderables are opaque and write depth, so the fill (drawn after the
// track by Canvas tree order) must also be the nearer one for the depth test.
// Z_LAYER_STEP is the kit's minimum that stays clear of z-fighting; the old
// 0.01 was 5× under it and only ever worked by luck of depth precision.
const FILL_Z_OFFSET: number = Z_LAYER_STEP

// IK's clamp is Math.min(Math.max(v, min), max), which returns NaN for NaN —
// and every guard downstream of it (`value <= 0`, `value >= 1`, `value !== prev`)
// is a comparison that NaN fails, so a single bad value used to reach the shader
// as a NaN width and position. The usual source is a caller normalizing progress
// against a degenerate range: `(v - min) / (max - min)` with min === max is 0/0.
function sanitizeValue(value: number): number | null {
  // Only NaN is unusable. +/-Infinity has an unambiguous meaning here and clamp
  // already handles it correctly: +Infinity -> 1, -Infinity -> 0. A caller
  // computing x / 0 for positive x means "complete", so rejecting Infinity and
  // holding the previous value would leave a finished bar reading empty.
  if (isNaN(value)) {
    return null
  }
  return clamp(value, 0, 1)
}

const DEFAULT_TRACK_STYLE: Partial<RoundedRectangleVisualParameters> = {
  default: {
    baseType: "Color",
    baseColor: ProgressBarTrackGray,
    hasBorder: false
  }
}

const DEFAULT_FILL_STYLE: Partial<RoundedRectangleVisualParameters> = {
  default: {
    baseType: "Color",
    baseColor: ProgressBarFillGreen,
    hasBorder: false
  }
}

/**
 * Determinate progress bar: a track and a fill.
 *
 * Draw order: the bar owns a Hierarchy-sorting Canvas on its own SceneObject (or
 * inherits a compatible ancestor one) and keeps both renderables at one flat
 * {@link renderOrder}; the fill is created after the track, so tree order draws
 * it after the track. That alone does not put it on top: both quads are opaque
 * and write depth, so the depth test decides, and FILL_Z_OFFSET (the kit's
 * Z_LAYER_STEP) is what keeps that test from rejecting the fill. Tree order
 * still matters — it decides if a style ever makes either quad transparent
 * (blended quads sort by draw order), and the flat order keeps the bar inside a
 * host Canvas's bucket instead of outranking sibling chrome. The layering
 * model itself is written up in Utility/DrawOrderLayering.ts.
 */
@component
export class ProgressBar extends BaseScriptComponent implements Layoutable {
  /**
   * Type brand consumed by the Layout2D `ElementHandler` finder. ProgressBar
   * is `Layoutable` but doesn't extend Element. See
   * `Components/Layout2D/UIKitBrands.ts`.
   */
  public readonly __uikitBrand = UIKitBrands.Element

  @input
  @hint("Size of the progress bar in centimeters")
  private _size: vec3 = new vec3(6, 1.0, 1.0)

  @input
  @hint("The default value of the progress bar, between 0 and 1")
  @widget(new SliderWidget(0, 1, 0.01))
  private _defaultValue: number = 0

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

  @input
  @hint("Enable this to add functions from another script to this component's callbacks")
  private addCallbacks: boolean = false
  @input
  @showIf("addCallbacks")
  @label("On Value Changed Callbacks")
  private onValueChangeCallbacks: Callback[] = []
  @input
  @showIf("addCallbacks")
  @label("On Progress Finished Callbacks")
  private onProgressFinishedCallbacks: Callback[] = []

  private _trackVisual: RoundedRectangleVisual | null = null
  private _fillVisual: RoundedRectangleVisual | null = null

  private trackObject: SceneObject | null = null
  private fillObject: SceneObject | null = null

  // Render order shared by track and fill. Cached so a pre-initialize write
  // survives (applied in initialize()), like Spinner and LoadingBar.
  private _renderOrder: number = 0

  // Draw-order Canvas on this SceneObject: tree order (track, then fill) is the
  // draw order, so no renderOrder bump is needed. Which of the two opaque quads
  // is visible is still the depth test's call — see FILL_Z_OFFSET. Inherits a
  // compatible ancestor Canvas rather than nesting one. Reconciled at the
  // update boundary.
  private canvasController: CanvasController | null = null
  private canvasBindingDirty: boolean = false

  private _currentValue: number = this._defaultValue
  private _displayValue: number = this._defaultValue
  private _isAnimating: boolean = false
  private _initialized: boolean = false

  private _springAnimate = SpringAnimate.smooth()
  private _springCurrent = new vec3(0, 0, 0)
  private _springTarget = new vec3(0, 0, 0)
  private _springResult = new vec3(0, 0, 0)
  private _fillLocalPos = new vec3(0, 0, FILL_Z_OFFSET)

  private _progressFinishedFired: boolean = false
  // A consumer with a broken range drives a bad value every frame; log the
  // first one and stay quiet after that.
  private _warnedBadInput: boolean = false

  private onSizeChangedEvent: Event<vec3> = new Event<vec3>()
  private onInitializedEvent: ReplayEvent<void> = new ReplayEvent<void>()

  /**
   * Invoked when the progress bar value has changed.
   */
  private onValueChangedEvent: Event<number> = new Event()
  private _onValueChanged?: PublicApi<number>
  public get onValueChanged(): PublicApi<number> {
    return (this._onValueChanged ??= this.onValueChangedEvent.publicApi())
  }

  /**
   * Invoked when the progress bar has finished progress.
   */
  private onProgressFinishedEvent: Event<void> = new Event()
  private _onProgressFinished?: PublicApi<void>
  public get onProgressFinished(): PublicApi<void> {
    return (this._onProgressFinished ??= this.onProgressFinishedEvent.publicApi())
  }

  /**
   * Fired when the size of the progress bar changes.
   * Used by Layout2D (ElementHandler) and legacy LayoutItem to detect size changes.
   */
  private _onSizeChanged?: PublicApi<vec3>
  public get onSizeChanged(): PublicApi<vec3> {
    return (this._onSizeChanged ??= this.onSizeChangedEvent.publicApi())
  }

  /**
   * Fired once when the progress bar has finished initialization.
   * Used by legacy LayoutItem to defer size sync until ready.
   */
  private _onInitialized?: PublicApi<void>
  public get onInitialized(): PublicApi<void> {
    return (this._onInitialized ??= this.onInitializedEvent.publicApi())
  }

  public get initialized(): boolean {
    return this._initialized
  }

  /**
   * Render order shared by the track and the fill. Neither needs a bump: draw
   * order comes from the Canvas tree order and visibility from the depth step
   * (FILL_Z_OFFSET), so both sit at this one value.
   */
  public get renderOrder(): number {
    return this._renderOrder
  }

  public set renderOrder(value: number) {
    if (value === undefined || value === this._renderOrder) {
      return
    }
    this._renderOrder = value
    this.applyRenderOrder()
  }

  public get currentValue(): number {
    return this._currentValue
  }

  public set currentValue(value: number) {
    if (value === undefined) {
      return
    }
    this.updateValue(value, false)
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
    // A non-finite extent would propagate straight into the visuals' targetSize;
    // a negative one inverts the fill geometry. Hold on non-finite, floor
    // negatives at 0 (a collapsed bar is degenerate but renders sanely — see
    // updateFillSize, which hides the fill when the usable box is empty).
    if (!isFinite(size.x) || !isFinite(size.y) || !isFinite(size.z)) {
      this.warnOnce(`ignoring non-finite size (${size.x}, ${size.y}, ${size.z}); holding ${this._size}`)
      return
    }
    size = new vec3(Math.max(0, size.x), Math.max(0, size.y), Math.max(0, size.z))
    if (this._size.x === size.x && this._size.y === size.y && this._size.z === size.z) {
      return
    }
    this._size = size
    if (this._initialized && this._trackVisual) {
      this.canvasController?.setSize(new vec2(this._size.x, this._size.y))
      this._trackVisual.size = this._size
      this._trackVisual.cornerRadius = this._size.y * this.cornerRadiusFactor
      this.updateFillSize()
      this.onSizeChangedEvent.invoke(this._size)
    }
  }

  public updateValue(value: number, shouldAnimate: boolean = false): void {
    const sanitized = sanitizeValue(value)
    if (sanitized === null) {
      // Hold the last good value rather than snapping to empty: a consumer with
      // a broken range feeds this every frame, and a bar frozen at its last
      // reading degrades more gracefully than one that empties itself.
      this.warnOnce(`ignoring NaN progress value; holding ${this._currentValue}`)
      return
    }
    value = sanitized

    const valueChanged = value !== this._currentValue
    const needsCancelAnimation = !shouldAnimate && this._isAnimating
    if (!valueChanged && !needsCancelAnimation) {
      return
    }

    this._currentValue = value

    if (this._initialized) {
      if (shouldAnimate) {
        this._springAnimate.reset()
        this._isAnimating = true
      } else {
        this._displayValue = value
        this._isAnimating = false
        this.updateFillSize()
      }
    } else {
      this._displayValue = value
    }

    if (valueChanged) {
      this.onValueChangedEvent.invoke(this._currentValue)

      if (this._currentValue >= 1 && !this._progressFinishedFired) {
        this._progressFinishedFired = true
        this.onProgressFinishedEvent.invoke()
      } else if (this._currentValue < 1) {
        this._progressFinishedFired = false
      }
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
    if (this.canvasBindingDirty) {
      // Cleared AFTER the call: CanvasController.reconcile() re-arms its own dirty
      // bit and rethrows on failure, so clearing first strands a dirty controller
      // with no retry until the next invalidate(). Nothing in reconcile() calls
      // back into this component, so a late clear cannot swallow a re-entrant
      // invalidation. Same shape as Dropdown; the batched-flush components
      // (Calendar, NumberPicker, DatePicker, BaseTextInputComponent) clear first
      // and re-arm in a catch instead, because they run other work in the same try.
      this.canvasController?.reconcile()
      this.canvasBindingDirty = false
    }
    if (this._initialized) {
      this.onUpdate()
    }
  }

  private onDestroy = () => {
    this.release()
  }

  private onEnabled = () => {
    this.invalidateCanvasBinding()
    this.enableVisuals()
  }

  private onDisabled = () => {
    this.disableVisuals()
  }

  /**
   * Re-resolves the governing Canvas at the next update, after a reparent or an
   * ancestor Canvas change (the same protocol as VisualElement). No-op before
   * initialize.
   */
  public invalidateCanvasBinding(): void {
    if (!this.canvasController) {
      return
    }
    this.canvasController.invalidate()
    this.canvasBindingDirty = true
  }

  private warnOnce(message: string): void {
    if (this._warnedBadInput) {
      return
    }
    this._warnedBadInput = true
    log.w(`ProgressBar on ${this.sceneObject.name}: ${message}. Further warnings suppressed.`)
  }

  private resolveTheme(): Theme {
    const mgr = ThemeService.getInstance()
    const override = this._themeOverride === "Default" ? "Inherited" : this._themeOverride
    if (override !== "Inherited") {
      return mgr.getTheme(override) ?? mgr.currentTheme
    }
    return mgr.currentTheme
  }

  private get cornerRadiusFactor(): number {
    const data = this.resolveTheme()?.componentData?.["ProgressBar"] as {cornerRadiusFactor?: number} | undefined
    return data?.cornerRadiusFactor ?? 0.5
  }

  private get trackStyle(): Partial<RoundedRectangleVisualParameters> {
    const themed = this.resolveTheme()?.styles["ProgressBarTrack"]?.["default"]
    return themed ?? DEFAULT_TRACK_STYLE
  }

  private get fillStyle(): Partial<RoundedRectangleVisualParameters> {
    const themed = this.resolveTheme()?.styles["ProgressBarFill"]?.["default"]
    return themed ?? DEFAULT_FILL_STYLE
  }

  private initialize(): void {
    if (this._initialized) {
      return
    }

    // _currentValue / _displayValue are seeded from the _defaultValue @input at
    // field-init time, bypassing updateValue's guard. The Inspector's
    // SliderWidget keeps that in 0..1, but a hand-edited .meta doesn't have to.
    const seed = sanitizeValue(this._currentValue)
    if (seed === null) {
      this.warnOnce(`NaN default value; starting at 0`)
    }
    this._currentValue = seed ?? 0
    this._displayValue = this._currentValue

    // Same for size: an authored negative or non-finite extent would reach the
    // visuals before any setter ran.
    const authoredSize = this._size
    if (!isFinite(authoredSize.x) || !isFinite(authoredSize.y) || !isFinite(authoredSize.z)) {
      this.warnOnce(`non-finite authored size (${authoredSize.x}, ${authoredSize.y}, ${authoredSize.z}); using 0`)
    }
    this._size = new vec3(
      Math.max(0, isFinite(authoredSize.x) ? authoredSize.x : 0),
      Math.max(0, isFinite(authoredSize.y) ? authoredSize.y : 0),
      Math.max(0, isFinite(authoredSize.z) ? authoredSize.z : 0)
    )

    // The Canvas exists before either renderable, so the flat orders below are
    // never live without it (flatten + canvas is one atomic change).
    this.canvasController ??= new CanvasController(this.sceneObject)
    this.canvasController.ensure(new vec2(this._size.x, this._size.y))

    this.trackObject = global.scene.createSceneObject("ProgressBarTrack")
    // createSceneObject does NOT inherit the render layer on setParent.
    this.trackObject.layer = this.sceneObject.layer
    this.trackObject.setParent(this.sceneObject)
    this._trackVisual = new RoundedRectangleVisual({
      sceneObject: this.trackObject,
      style: this.trackStyle
    })
    this._trackVisual.initialize()
    this._trackVisual.size = this._size
    this._trackVisual.cornerRadius = this._size.y * this.cornerRadiusFactor

    this.fillObject = global.scene.createSceneObject("ProgressBarFill")
    this.fillObject.layer = this.sceneObject.layer
    this.fillObject.setParent(this.sceneObject)
    this._fillVisual = new RoundedRectangleVisual({
      sceneObject: this.fillObject,
      style: this.fillStyle
    })
    this._fillVisual.initialize()
    // Flat, no bump. The fill is the later child (draw order) and sits at
    // FILL_Z_OFFSET (depth test) — the step, not the Canvas, puts it on top.
    this.applyRenderOrder()

    this._initialized = true
    this.updateFillSize()

    if (this.addCallbacks) {
      this.onValueChanged.add(createCallbacks(this.onValueChangeCallbacks))
      this.onProgressFinished.add(createCallbacks(this.onProgressFinishedCallbacks))
    }

    this.onInitializedEvent.invoke()

    if (this._currentValue > 0) {
      this.onValueChangedEvent.invoke(this._currentValue)
      if (this._currentValue >= 1) {
        this._progressFinishedFired = true
        this.onProgressFinishedEvent.invoke()
      }
    }
  }

  private applyRenderOrder(): void {
    applyFlatRenderOrder(
      [this._trackVisual?.renderMeshVisual ?? null, this._fillVisual?.renderMeshVisual ?? null],
      this._renderOrder
    )
  }

  private updateFillSize(): void {
    if (!this._fillVisual || !this._trackVisual) {
      return
    }

    const value = this._displayValue

    // `!(value > 0)` rather than `value <= 0` so a NaN that slipped past the
    // entry-point guards (e.g. a garbage _defaultValue in the .meta) hides the
    // fill instead of falling through to NaN geometry.
    if (!(value > 0)) {
      this._fillVisual.renderMeshVisual.enabled = false
      return
    }

    const borderSize = this._trackVisual.borderSize
    // Floor at 0: a border thicker than the bar makes these negative, which
    // flips the fill inside out.
    const maxFillWidth = Math.max(0, this._size.x - borderSize * 2)
    const maxFillHeight = Math.max(0, this._size.y - borderSize * 2)

    // Nothing sensible to draw inside an empty box.
    if (maxFillWidth <= 0 || maxFillHeight <= 0) {
      this._fillVisual.renderMeshVisual.enabled = false
      return
    }

    this._fillVisual.renderMeshVisual.enabled = true

    // The pill's cap diameter is its height, but it must never exceed the track
    // width — otherwise a bar taller than it is wide (or one squeezed by a
    // layout) has its minimum-width fill hang out past both ends of the track.
    const cornerDiameter = Math.min(maxFillHeight, maxFillWidth)
    const radiusFactor = this.cornerRadiusFactor

    const fillWidth = lerp(cornerDiameter, maxFillWidth, value)
    const fillX = lerp(maxFillWidth * -0.5 + cornerDiameter * 0.5, 0, value)

    this._fillLocalPos.x = fillX
    this._fillVisual.transform.setLocalPosition(this._fillLocalPos)

    const fillSize = new vec3(fillWidth, maxFillHeight, this._size.z)
    this._fillVisual.size = fillSize
    // cornerDiameter, not maxFillHeight: they're equal for a normal bar (height
    // <= width), and on a narrower-than-tall one this keeps the radius from
    // exceeding half the fill's own width.
    this._fillVisual.cornerRadius = cornerDiameter * radiusFactor
  }

  private onUpdate(): void {
    if (!this._isAnimating || !this._initialized) {
      return
    }

    const min = Math.min(this._currentValue, this._displayValue)
    const max = Math.max(this._currentValue, this._displayValue)

    this._springCurrent.x = this._displayValue
    this._springTarget.x = this._currentValue
    this._springResult.x = this._displayValue

    this._springAnimate.evaluate(this._springCurrent, this._springTarget, this._springResult)

    this._displayValue = clamp(this._springResult.x, min, max)

    if (Math.abs(this._displayValue - this._currentValue) <= SPRING_EPSILON) {
      this._displayValue = this._currentValue
      this._isAnimating = false
    }

    this.updateFillSize()
  }

  private enableVisuals(): void {
    if (!this._initialized) {
      return
    }
    if (this._trackVisual && !isNull(this._trackVisual)) {
      this._trackVisual.enable()
    }
    if (this._fillVisual && !isNull(this._fillVisual)) {
      this._fillVisual.enable()
    }
    // Visual.enable() re-enables every managed component, including the fill's
    // RenderMeshVisual — which updateFillSize may have deliberately disabled
    // (value 0, or an empty usable box). Re-derive it from _displayValue so a
    // disable/enable cycle doesn't resurrect a phantom fill at its last size.
    this.updateFillSize()
  }

  private disableVisuals(): void {
    if (!this._initialized) {
      return
    }
    if (this._trackVisual && !isNull(this._trackVisual)) {
      this._trackVisual.disable()
    }
    if (this._fillVisual && !isNull(this._fillVisual)) {
      this._fillVisual.disable()
    }
  }

  private release(): void {
    if (this._fillVisual && !isNull(this._fillVisual)) {
      this._fillVisual.destroy()
    }
    this._fillVisual = null
    if (this._trackVisual && !isNull(this._trackVisual)) {
      this._trackVisual.destroy()
    }
    this._trackVisual = null
    if (this.fillObject && !isNull(this.fillObject)) {
      this.fillObject.destroy()
    }
    this.fillObject = null
    if (this.trackObject && !isNull(this.trackObject)) {
      this.trackObject.destroy()
    }
    this.trackObject = null
    // Last, so the Canvas outlives the renderables it governed.
    const canvasController = this.canvasController
    this.canvasController = null
    this.canvasBindingDirty = false
    canvasController?.release()
  }
}

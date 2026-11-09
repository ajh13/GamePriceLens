import Event, {PublicApi, unsubscribe} from "InteractionKit.lspkg/Utils/Event"
import {clamp} from "InteractionKit.lspkg/Utils/mathUtils"
import {createChildSceneObjectWithParentLayer} from "../../Utility/SceneUtilities"
import {
  getTransparencyCheckerboardTexture,
  HSVtoRGB,
  insetGradientStops,
  knobTravelInsetFraction
} from "../../Utility/UIKitUtilities"
import {RoundedRectangle} from "../../Visuals/RoundedRectangle/RoundedRectangle"
import type {GradientParameters, GradientStop} from "../../Visuals/RoundedRectangle/RoundedRectangleTypes"
import {
  RoundedRectangleVisual,
  RoundedRectangleVisualParameters
} from "../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {Visual} from "../../Visuals/Visual"
import {DEFAULT_CORNER_RADIUS_FACTOR, Slider} from "./Slider"

export enum ColorSliderMode {
  Hue = "Hue",
  Value = "Value",
  Alpha = "Alpha"
}

const BLACK = new vec4(0, 0, 0, 1)

// ─── Alpha checkerboard ───────────────────────────────────────────────
//
// Alpha mode's track fades to fully transparent, which on its own just
// shows whatever sits behind the slider — so a half-transparent red and a
// half-transparent grey background are indistinguishable. The checkerboard
// is the universal "this is transparency, not colour" backing, so Alpha
// mode paints one behind the track. The texture itself is kit-wide and
// shared (see getTransparencyCheckerboardTexture); what stays here is only
// how this component places it.
//
// Behind the track, matching the sign the rest of the kit uses for "one
// layer back" (see ColorPicker's PANEL_Z_OFFSET).
const CHECKER_Z_OFFSET = -0.01
const CHECKER_OBJECT_NAME = "ColorSliderAlphaCheckerboard"

const FULL_HUE_RANGE_DEGREES = 360
// One ramp stop per 60° of hue keeps every primary and secondary color a
// true stop, and caps the full 360° wrap at exactly the shader's 7-stop
// budget (0, 60, ..., 300, plus the range end).
const HUE_GRADIENT_STOP_INTERVAL_DEGREES = 60

/**
 * A color slider for selecting hue, value (brightness), or alpha (opacity).
 *
 * In Hue mode the track displays a rainbow gradient spanning
 * {@link hueRangeDegrees} and the slider value maps linearly onto it. At
 * the default 360° span both ends are red (hue is circular); a smaller
 * span ends the ramp early so the two ends select distinct hues.
 *
 * In Value mode the track displays a gradient from black to a given hue
 * color, and the slider value maps to brightness (0 = black, 1 = full color).
 *
 * In Alpha mode the track displays a gradient from fully transparent to a
 * given hue color, and the slider value maps to opacity (0 = transparent,
 * 1 = opaque).
 *
 * The knob dynamically reflects the color at the current slider position.
 * Fill is managed manually ({@link Visual.shouldColorChange} = false) while
 * borders continue to animate normally on hover/trigger.
 *
 * @extends Slider
 */
@component
export class ColorSlider extends Slider {
  @input("string")
  @hint(
    "Slider mode: Hue for full rainbow, Value for a black-to-color gradient, Alpha for a transparent-to-color gradient"
  )
  @widget(new ComboBoxWidget([new ComboBoxItem("Hue"), new ComboBoxItem("Value"), new ComboBoxItem("Alpha")]))
  private _mode: ColorSliderMode = ColorSliderMode.Hue

  @input
  @hint(
    "Hue span in degrees mapped across the slider (Hue mode only). 360 completes the wrap back to red; lower values end the ramp early so the two ends select distinct hues."
  )
  @widget(new SliderWidget(1, 360, 1))
  @showIf("_mode", "Hue")
  private _hueRangeDegrees: number = 360

  private _hueColor: vec4 = new vec4(1, 0, 0, 1)
  private _knobOverflow: boolean = true
  private _trackRoundedRectangleVisual: RoundedRectangleVisual | null = null
  private _knobRoundedRectangleVisual: RoundedRectangleVisual | null = null
  private _trackRoundedRectangleVisualDestroyUnsubscribe: unsubscribe | null = null
  private _knobRoundedRectangleVisualDestroyUnsubscribe: unsubscribe | null = null
  // Alpha-mode only; built on first use and then kept in sync with the
  // track it backs (see updateAlphaCheckerboard).
  private _checkerObject: SceneObject | null = null
  private _checkerRectangle: RoundedRectangle | null = null

  private onColorChangeEvent: Event<vec4> = new Event()
  private _onColorChange?: PublicApi<vec4>
  /**
   * Invoked whenever the color at the knob position is recomputed — from
   * dragging, a value reset, initialization, or a programmatic mode / hue
   * range / hue color change. Fires regardless of whether the knob visual
   * could be recolored, so a custom knob can be painted from here. Not
   * deduplicated: the payload can repeat the previous color byte-for-byte
   * (once from initialize(), or when a change doesn't move the resulting
   * color). The event payload is the RGBA color.
   */
  public get onColorChange(): PublicApi<vec4> {
    return (this._onColorChange ??= this.onColorChangeEvent.publicApi())
  }

  public readonly hasTrackVisual: boolean = false

  /**
   * The color at the current knob position.
   */
  public get selectedColor(): vec4 {
    return this.getColorAtValue(this.knobValue)
  }

  /**
   * The slider mode: "Hue", "Value", or "Alpha".
   */
  public get mode(): ColorSliderMode {
    return this._mode
  }

  public set mode(value: ColorSliderMode) {
    // Guarded like the other setters: a same-value write must not re-upload
    // the gradient and re-fire onColorChange, and an unrecognized string
    // must not reach the mode branches (whose fallbacks disagree —
    // applyTrackGradient's else paints Alpha, getColorAtValue's returns
    // Value).
    if (value !== ColorSliderMode.Hue && value !== ColorSliderMode.Value && value !== ColorSliderMode.Alpha) {
      return
    }
    if (value === this._mode) {
      return
    }
    this._mode = value
    if (this._initialized) {
      // A recolor, not a drag: onColorChange reads isDragging false.
      this.runProgrammaticWrite(() => {
        // Blend state is per-mode: Alpha needs the track and knob to
        // alpha-blend, and leaving Alpha must turn it back off or a reused
        // slider keeps blending in Hue/Value. This transition is the only
        // place that CLEARS the flag. applyAlphaGradient still ASSERTS it on
        // every Alpha rebuild, deliberately, not redundantly: that assert is
        // load-bearing for the pre-init mode write (the normal path; this
        // branch never runs then, and configureKnobRoundedRectangleVisual
        // covers only the knob) and for visual swaps while in Alpha, where
        // the fresh visual arrives with the flag unset and no mode
        // transition fires.
        const transparencyEnabled = value === ColorSliderMode.Alpha
        if (this._trackRoundedRectangleVisual) {
          this._trackRoundedRectangleVisual.transparencyEnabled = transparencyEnabled
        }
        if (this._knobRoundedRectangleVisual) {
          this._knobRoundedRectangleVisual.transparencyEnabled = transparencyEnabled
        }
        this.applyTrackGradient()
        // Separate from applyTrackGradient: a mode change flips the backing's
        // visibility without touching the track's size, so it is not covered
        // by the resize path in updateKnobSize.
        this.updateAlphaCheckerboard()
        this.updateKnobColor()
      })
    }
  }

  /**
   * The hue span in degrees mapped across the slider in Hue mode: the value
   * t selects hue `t * hueRangeDegrees`. Clamped to [1, 360]. At 360 the
   * ramp wraps back to red, so both ends select the same hue; smaller spans
   * end the ramp early, at the cost of the trailing hues not being
   * reachable by the knob.
   */
  public get hueRangeDegrees(): number {
    return this._hueRangeDegrees
  }

  public set hueRangeDegrees(value: number) {
    if (value === undefined || !isFinite(value)) {
      return
    }
    const range = clamp(value, 1, FULL_HUE_RANGE_DEGREES)
    if (range === this._hueRangeDegrees) {
      return
    }
    this._hueRangeDegrees = range
    if (this._initialized) {
      this.runProgrammaticWrite(() => {
        if (this._mode === ColorSliderMode.Hue) {
          this.applyTrackGradient()
        }
        this.updateKnobColor()
      })
    }
  }

  /**
   * The reference hue color used by the Value and Alpha mode track
   * gradients. Setting this rebuilds that gradient and refreshes the knob
   * color in real time. In Hue mode it has no visual effect — both the
   * track ramp and the knob color derive from the hue span rather than
   * from this color, so the gradient rebuild is skipped and the knob
   * recompute yields the same color — but {@link onColorChange} still
   * fires, per that event's not-deduplicated contract.
   */
  public get hueColor(): vec4 {
    return this._hueColor
  }

  public set hueColor(color: vec4) {
    if (color === undefined || color === null) {
      return
    }
    this._hueColor = color
    if (this._initialized) {
      this.runProgrammaticWrite(() => {
        if (this._mode !== ColorSliderMode.Hue) {
          this.applyTrackGradient()
        }
        this.updateKnobColor()
      })
    }
  }

  /**
   * When true the knob can travel past the track edges. When false
   * it stays inset by half the knob width (default Slider behavior).
   */
  public get knobOverflow(): boolean {
    return this._knobOverflow
  }

  public set knobOverflow(value: boolean) {
    if (value === this._knobOverflow) {
      return
    }
    this._knobOverflow = value
    if (this._initialized) {
      // The gradient's inset is a function of this flag, so it has to be
      // rebuilt alongside the knob's travel.
      this.applyTrackGradient()
      this.relayoutKnobPosition()
    }
  }

  protected override get defaultTrackStyle(): Partial<RoundedRectangleVisualParameters> {
    const themed = this.resolveTheme()?.styles["ColorSliderTrack"]?.["default"]
    return themed ?? super.defaultTrackStyle
  }

  protected override get defaultKnobStyle(): Partial<RoundedRectangleVisualParameters> {
    const themed = this.resolveTheme()?.styles["ColorSliderKnob"]?.["default"]
    return themed ?? super.defaultKnobStyle
  }

  protected override get cornerRadiusFactor(): number {
    const data = this.resolveTheme()?.componentData?.["ColorSlider"] as {cornerRadiusFactor?: number} | undefined
    return data?.cornerRadiusFactor ?? DEFAULT_CORNER_RADIUS_FACTOR
  }

  protected override get knobObjectName(): string {
    return "ColorSliderKnob"
  }

  protected override get trackFillObjectName(): string {
    return "ColorSliderTrackFill"
  }

  public override get visual(): Visual {
    return super.visual
  }

  public override set visual(value: Visual) {
    if (value === undefined) {
      return
    }
    if (this.visual === value) {
      return
    }
    // The knob cache is deliberately NOT cleared here: the knob lives on its
    // own child SceneObject and Visual.destroy() never destroys a
    // SceneObject, so it survives a track-visual swap intact. Clearing it
    // would strand it — configureVisual re-caches only the track, and
    // configureKnobVisual (the only knob re-cache) runs from initialize and
    // the knobVisual setter, never from this path — leaving updateKnobColor
    // to early-return forever: frozen knob fill and a dead onColorChange.
    super.visual = value
    if (!this._initialized) {
      this.cacheTrackRoundedRectangleVisual(this.visual)
    } else {
      this.applyTrackGradient()
    }
  }

  public override get knobVisual(): Visual {
    return super.knobVisual
  }

  public override set knobVisual(value: Visual) {
    if (value === undefined) {
      return
    }
    if (this.knobVisual === value) {
      return
    }
    super.knobVisual = value
    if (!this._initialized) {
      this.cacheKnobRoundedRectangleVisual(this.knobVisual)
    }
  }

  protected override createDefaultTrackVisual(): Visual {
    const visual = super.createDefaultTrackVisual() as RoundedRectangleVisual
    this.cacheTrackRoundedRectangleVisual(visual)
    return visual
  }

  protected override createDefaultKnobVisual(): Visual {
    const visual = super.createDefaultKnobVisual() as RoundedRectangleVisual
    this.cacheKnobRoundedRectangleVisual(visual)
    return visual
  }

  protected override configureVisual(): void {
    super.configureVisual()
    this.cacheTrackRoundedRectangleVisual(this.visual)
    this.configureTrackRoundedRectangleVisual()
  }

  protected override configureKnobVisual(): void {
    super.configureKnobVisual()
    this.cacheKnobRoundedRectangleVisual(this.knobVisual)
    this.configureKnobRoundedRectangleVisual()
  }

  protected override createDefaultVisual(): void {
    super.createDefaultVisual()
    this.configureKnobRoundedRectangleVisual()
    this.configureTrackRoundedRectangleVisual()
  }

  private configureKnobRoundedRectangleVisual(): void {
    const knobVisual = this._knobRoundedRectangleVisual
    if (knobVisual) {
      const knobData = this.resolveTheme()?.componentData?.["ColorSliderKnob"] as {knobVisible?: boolean} | undefined
      const knobVisible = knobData?.knobVisible ?? true
      this.setKnobRenderMeshEnabled(knobVisible, knobVisual)
      knobVisual.shouldColorChange = false
      if (this.defaultKnobStyle?.default?.baseType === "Color") {
        knobVisual.baseType = "Color"
      }
      if (this._mode === ColorSliderMode.Alpha) {
        knobVisual.transparencyEnabled = true
      }
    }
  }

  private configureTrackRoundedRectangleVisual(): void {
    const trackVisual = this._trackRoundedRectangleVisual
    if (trackVisual) {
      trackVisual.shouldColorChange = false
    }
  }

  private cacheTrackRoundedRectangleVisual(visual: Visual | null | undefined): void {
    this.clearTrackRoundedRectangleVisual()
    if (visual instanceof RoundedRectangleVisual) {
      this._trackRoundedRectangleVisual = visual
      this._trackRoundedRectangleVisualDestroyUnsubscribe = visual.onDestroyed.add(() => {
        this._trackRoundedRectangleVisual = null
        this._trackRoundedRectangleVisualDestroyUnsubscribe = null
        // Track destruction does not imply knob destruction (see the visual
        // setter): the knob's own onDestroyed handler owns that cache.
      })
    }
  }

  private cacheKnobRoundedRectangleVisual(visual: Visual | null | undefined): void {
    this.clearKnobRoundedRectangleVisual()
    if (visual instanceof RoundedRectangleVisual) {
      this._knobRoundedRectangleVisual = visual
      this._knobRoundedRectangleVisualDestroyUnsubscribe = visual.onDestroyed.add(() => {
        this._knobRoundedRectangleVisual = null
        this._knobRoundedRectangleVisualDestroyUnsubscribe = null
      })
    }
  }

  private clearTrackRoundedRectangleVisual(): void {
    if (this._trackRoundedRectangleVisualDestroyUnsubscribe) {
      this._trackRoundedRectangleVisualDestroyUnsubscribe()
      this._trackRoundedRectangleVisualDestroyUnsubscribe = null
    }
    this._trackRoundedRectangleVisual = null
  }

  private clearKnobRoundedRectangleVisual(): void {
    if (this._knobRoundedRectangleVisualDestroyUnsubscribe) {
      this._knobRoundedRectangleVisualDestroyUnsubscribe()
      this._knobRoundedRectangleVisualDestroyUnsubscribe = null
    }
    this._knobRoundedRectangleVisual = null
  }

  public override initialize(): boolean {
    if (!super.initialize()) {
      return false
    }

    // Serialized @input values bypass the setters' guards, so normalize
    // them here (Slider.initialize validates its own inputs the same way,
    // though it throws; these clamp because the inspector widgets already
    // bound them — an out-of-range value is stale data, not intent). An
    // unclamped 0 range would leave buildHueGradient's loop empty: stop1
    // undefined and every value mapping to red.
    this._hueRangeDegrees = isFinite(this._hueRangeDegrees)
      ? clamp(this._hueRangeDegrees, 1, FULL_HUE_RANGE_DEGREES)
      : FULL_HUE_RANGE_DEGREES
    if (
      this._mode !== ColorSliderMode.Hue &&
      this._mode !== ColorSliderMode.Value &&
      this._mode !== ColorSliderMode.Alpha
    ) {
      this._mode = ColorSliderMode.Hue
    }

    // Defensive only: a visual's first paint SNAPS rather than animating
    // (RoundedRectangleVisual.applyInitialVisualState — prevState is null
    // there), so there is normally no tween to cancel. Kept because the
    // manual gradient below must land on a settled visual, and a state
    // change on a pre-assigned visual is the one way a tween could be in
    // flight here.
    this._trackRoundedRectangleVisual?.cancelAnimations()

    this.applyTrackGradient()
    this.updateKnobColor()
    return true
  }

  /**
   * An inset gradient is laid out from the track AND knob widths, so it has
   * to be rebuilt whenever either changes. Hooking the knob-size refresh
   * rather than `onSizeChanged` covers every path that moves either one —
   * a track resize (the size listener calls this), a `knobSize` write, a
   * knob-visual swap, and a knob-size-only `resetDimensions`. `super` runs
   * first so the knob visual and collider are settled before the rebuild;
   * the width the rebuild reads is `_knobSize`, which callers assign before
   * invoking (`super` only reads it, never writes it). With an
   * overflowing knob the inset is 0 regardless of knob width, so there is
   * nothing to rebuild (the `knobOverflow` setter handles that transition).
   */
  protected override updateKnobSize(): void {
    super.updateKnobSize()
    if (!this.initialized) {
      return
    }
    if (!this._knobOverflow) {
      this.applyTrackGradient()
    }
    // OUTSIDE that branch on purpose. The gradient only needs rebuilding
    // when the knob travels inset, but the backing plate has to re-fit the
    // track on EVERY resize — and with knobOverflow true (the default) the
    // branch above never runs, so this is the only path that reaches it.
    // Also the creation trigger: Slider.initialize calls this before
    // attaching its size listener.
    this.updateAlphaCheckerboard()
  }

  /**
   * Keeps the backing plate one step behind the track. Slider's own setter
   * re-derives the fill and knob orders the same way; the plate needs the
   * same treatment or a later write — e.g. a host lowering the whole
   * picker's order — would leave it ordered AFTER the track, painting over
   * the gradient (or being depth-rejected at its z offset).
   */
  public override get renderOrder(): number {
    return super.renderOrder
  }

  public override set renderOrder(order: number) {
    super.renderOrder = order
    if (this.initialized) {
      this.updateAlphaCheckerboard()
    }
  }

  protected override getKnobPositionFromValue(value: number): number {
    if (this._knobOverflow) {
      return (value - 0.5) * this.size.x
    }
    return super.getKnobPositionFromValue(value)
  }

  protected override get trackLength(): number {
    if (this._knobOverflow) {
      return this.size.x
    }
    return super.trackLength
  }

  protected override updateKnobPositionFromValue(): void {
    super.updateKnobPositionFromValue()
    this.updateKnobColor()
  }

  /**
   * Applies the gradient to the track visual based on the current mode.
   */
  private applyTrackGradient(): void {
    if (!this._trackRoundedRectangleVisual) {
      return
    }
    if (this._mode === ColorSliderMode.Hue) {
      this.applyHueGradient()
    } else if (this._mode === ColorSliderMode.Value) {
      this.applyValueGradient()
    } else {
      this.applyAlphaGradient()
    }
  }

  /**
   * Brings the Alpha-mode checkerboard backing in line with the track:
   * creates it on first Alpha use, hides it in the other modes, and
   * re-fits its size, corner radius, and draw order.
   *
   * Kept as a plain {@link RoundedRectangle} rather than a
   * RoundedRectangleVisual because it is inert decoration — it has no
   * interaction states to animate, and only the raw rectangle exposes the
   * texture tiling this needs (the visual's style stores a texture but not
   * its mode or wrap).
   */
  private updateAlphaCheckerboard(): void {
    const wanted = this._mode === ColorSliderMode.Alpha
    if (!wanted && !this._checkerObject) {
      // Never been in Alpha mode: nothing built, nothing to hide.
      return
    }
    if (wanted && !this._checkerRectangle) {
      this.createAlphaCheckerboard()
    }

    const object = this._checkerObject
    const rectangle = this._checkerRectangle
    if (!object || isNull(object) || !rectangle || isNull(rectangle)) {
      return
    }
    if (object.enabled !== wanted) {
      object.enabled = wanted
    }
    if (!wanted) {
      return
    }

    const width = this.size.x
    const height = this.size.y
    if (rectangle.size.x !== width || rectangle.size.y !== height) {
      rectangle.size = new vec2(width, height)
      // The tile count is baked into the textureMode uniform, derived from
      // the texture-to-rect aspect when that uniform is written — and
      // RoundedRectangle's resize path does NOT rewrite it, so on its own a
      // resize keeps tiling for the old dimensions and the squares stretch.
      // Re-assigning the texture re-derives it; textureMode cannot, its
      // setter being equality-guarded.
      rectangle.texture = getTransparencyCheckerboardTexture()
    }
    rectangle.cornerRadius = height * this.cornerRadiusFactor
    // One step behind the track so the blended ramp composites over it.
    rectangle.renderOrder = this.renderOrder - 1
  }

  /** Mounts the checkerboard plate on its own child, once. */
  private createAlphaCheckerboard(): void {
    const texture = getTransparencyCheckerboardTexture()
    if (!texture) {
      return
    }

    // Inherits the component root's render layer, like the knob and fill.
    const object = createChildSceneObjectWithParentLayer(CHECKER_OBJECT_NAME, this.sceneObject)
    this.managedSceneObjects.add(object)
    object.getTransform().setLocalPosition(new vec3(0, 0, CHECKER_Z_OFFSET))

    const rectangle = object.createComponent(RoundedRectangle.getTypeName()) as RoundedRectangle
    rectangle.gradient = false
    rectangle.useTexture = true
    rectangle.texture = texture
    // The pair that turns one square tile into a two-row strip; see
    // getTransparencyCheckerboardTexture.
    rectangle.textureMode = "Fill Height"
    rectangle.textureWrap = "Repeat"

    this._checkerObject = object
    this._checkerRectangle = rectangle
  }

  /**
   * The fraction of the track each end gives up to the knob when the knob
   * travels inset ({@link knobOverflow} = false). The knob's center then
   * spans only `[inset, 1 - inset]` of the track, so a gradient laid out
   * across the full track would sit that far out of step with the value —
   * the knob would render one color while sitting over another.
   */
  private get knobTravelInset(): number {
    if (this._knobOverflow) {
      return 0
    }
    return knobTravelInsetFraction(this.knobSize.x, this.size.x)
  }

  /**
   * Remaps a gradient into the knob's travel range (see
   * {@link insetGradientStops}). The clamp-derived shoulders it relies on
   * are load-bearing here: the hue ramp can spend the entire 7-stop budget
   * (any span above 300°, per {@link buildHueGradient}), leaving none to
   * spell the shoulders out explicitly.
   */
  private insetGradientToKnobTravel(gradient: GradientParameters): GradientParameters {
    return insetGradientStops(gradient, this.knobTravelInset)
  }

  private applyHueGradient(): void {
    const trackVisual = this._trackRoundedRectangleVisual
    if (!trackVisual) {
      return
    }
    const gradient = this.insetGradientToKnobTravel(this.buildHueGradient())
    trackVisual.defaultBaseType = "Gradient"
    trackVisual.defaultGradient = gradient
    trackVisual.applyBaseGradientNow(gradient)
  }

  /**
   * Builds the rainbow ramp for the current hue range: a stop every 60° of
   * hue plus one at the range end — at most 7 stops, exactly the shader's
   * budget, spent by any range above 300° (the picker's 330 included, not
   * just the full 360° wrap).
   */
  private buildHueGradient(): GradientParameters {
    const range = this._hueRangeDegrees
    const stops: GradientStop[] = []
    for (let hue = 0; hue < range; hue += HUE_GRADIENT_STOP_INTERVAL_DEGREES) {
      stops.push({percent: hue / range, color: HSVtoRGB(hue, 1, 1, 1)})
    }
    stops.push({percent: 1, color: HSVtoRGB(range, 1, 1, 1)})

    // Static-key writes: GradientParameters spells out stop0..stop6, and
    // the range setter's [1, 360] clamp bounds the loop to at most 7 stops.
    const gradient: GradientParameters = {
      type: "Linear",
      start: vec2.left(),
      end: vec2.right(),
      stop0: stops[0],
      stop1: stops[1]
    }
    if (stops.length > 2) gradient.stop2 = stops[2]
    if (stops.length > 3) gradient.stop3 = stops[3]
    if (stops.length > 4) gradient.stop4 = stops[4]
    if (stops.length > 5) gradient.stop5 = stops[5]
    if (stops.length > 6) gradient.stop6 = stops[6]
    return gradient
  }

  private applyValueGradient(): void {
    const trackVisual = this._trackRoundedRectangleVisual
    if (!trackVisual) {
      return
    }
    const gradient = this.insetGradientToKnobTravel({
      type: "Linear",
      start: vec2.left(),
      end: vec2.right(),
      stop0: {percent: 0, color: BLACK},
      stop1: {percent: 1, color: this._hueColor}
    })
    trackVisual.defaultBaseType = "Gradient"
    trackVisual.defaultGradient = gradient
    trackVisual.applyBaseGradientNow(gradient)
  }

  private applyAlphaGradient(): void {
    const trackVisual = this._trackRoundedRectangleVisual
    if (!trackVisual) {
      return
    }
    // The alpha ramp only reads as transparency when the track and knob
    // actually blend with what's behind them; the default material state
    // would paint the transparent stop as opaque black.
    trackVisual.transparencyEnabled = true
    if (this._knobRoundedRectangleVisual) {
      this._knobRoundedRectangleVisual.transparencyEnabled = true
    }
    const gradient = this.insetGradientToKnobTravel({
      type: "Linear",
      start: vec2.left(),
      end: vec2.right(),
      stop0: {percent: 0, color: new vec4(this._hueColor.r, this._hueColor.g, this._hueColor.b, 0)},
      stop1: {percent: 1, color: new vec4(this._hueColor.r, this._hueColor.g, this._hueColor.b, 1)}
    })
    trackVisual.defaultBaseType = "Gradient"
    trackVisual.defaultGradient = gradient
    trackVisual.applyBaseGradientNow(gradient)
  }

  private updateKnobColor(): void {
    const color = this.getColorAtValue(this.knobValue)
    // Paint is optional, the event is not: onColorChange reports the
    // SELECTED COLOR, which changed whether or not a knob could display it.
    // The cache is empty whenever the knob visual isn't a
    // RoundedRectangleVisual (the BeveledPrismVisual pattern Switch uses),
    // and a consumer with such a knob subscribes to this event precisely to
    // paint it themselves — gating the invoke on the cache would break the
    // one workaround available to them. Mirrors ColorArea.updateKnobColor.
    this._knobRoundedRectangleVisual?.applyBaseColorNow(color)
    this.onColorChangeEvent.invoke(color)
  }

  private getColorAtValue(value: number): vec4 {
    if (this._mode === ColorSliderMode.Hue) {
      return HSVtoRGB(value * this._hueRangeDegrees, 1, 1, 1)
    }
    if (this._mode === ColorSliderMode.Alpha) {
      return new vec4(this._hueColor.r, this._hueColor.g, this._hueColor.b, value)
    }
    return new vec4(this._hueColor.r * value, this._hueColor.g * value, this._hueColor.b * value, 1)
  }
}

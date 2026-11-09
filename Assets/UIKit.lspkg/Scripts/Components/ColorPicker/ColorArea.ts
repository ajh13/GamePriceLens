import {DragInteractorEvent, InteractorEvent} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import Event, {PublicApi, unsubscribe} from "InteractionKit.lspkg/Utils/Event"
import {clamp} from "InteractionKit.lspkg/Utils/mathUtils"
import {createChildSceneObjectWithParentLayer} from "../../Utility/SceneUtilities"
import {HSVtoRGB, knobTravelInsetFraction} from "../../Utility/UIKitUtilities"
import type {GradientParameters} from "../../Visuals/RoundedRectangle/RoundedRectangleTypes"
import {
  RoundedRectangleVisual,
  RoundedRectangleVisualParameters
} from "../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {Visual} from "../../Visuals/Visual"
import {StateName} from "../Element"
import {VisualElement} from "../VisualElement"
import {clampHue, clampUnit} from "./ColorPickerUtilities"

const KNOB_Z_OFFSET: number = 0.015
const VALUE_OVERLAY_Z_OFFSET: number = 0.01
const MIN_KNOB_TRAVEL: number = 0.001
// The area is a large square, so it reads as barely-rounded in the spec —
// a much smaller radius than the plates that frame it.
const AREA_CORNER_RADIUS: number = 0.4
const KNOB_CORNER_RADIUS_FACTOR: number = 0.3

const WHITE = new vec4(1, 1, 1, 1)
const BLACK = new vec4(0, 0, 0, 1)
const TRANSPARENT_BLACK = new vec4(0, 0, 0, 0)

const KnobBorderTop = new vec4(0.45, 0.45, 0.45, 0.6)
const KnobBorderBottom = new vec4(0.25, 0.25, 0.25, 0.3)

// Vertical value ramp composited over the saturation gradient: transparent at
// the top (full brightness) to opaque black at the bottom (zero brightness).
// Seeds the overlay's style; applyValueOverlayGradient replaces it with the
// knob-inset version once the area initializes.
const VALUE_OVERLAY_GRADIENT: GradientParameters = {
  type: "Linear",
  start: new vec2(0, 1),
  end: new vec2(0, -1),
  stop0: {percent: 0, color: TRANSPARENT_BLACK},
  stop1: {percent: 1, color: BLACK}
}

const AreaTrackParameters: Partial<RoundedRectangleVisualParameters> = {
  default: {
    // Fill gradient is updated at runtime from the hue; solid placeholder
    // avoids painting a default gradient before the first hue applies.
    baseType: "Color",
    baseColor: BLACK,
    hasBorder: true,
    borderSize: 0.07,
    borderType: "Gradient",
    borderGradient: {
      type: "Linear",
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {percent: 0, color: KnobBorderTop},
      stop1: {percent: 1, color: KnobBorderBottom}
    }
  },
  hovered: {
    borderGradient: {
      type: "Linear",
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {percent: 0, color: new vec4(0.55, 0.55, 0.55, 0.7)},
      stop1: {percent: 1, color: new vec4(0.35, 0.35, 0.35, 0.4)}
    }
  },
  triggered: {
    borderGradient: {
      type: "Linear",
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {percent: 0, color: new vec4(0.6, 0.6, 0.6, 0.8)},
      stop1: {percent: 1, color: new vec4(0.4, 0.4, 0.4, 0.5)}
    }
  }
}

const ValueOverlayParameters: Partial<RoundedRectangleVisualParameters> = {
  default: {
    baseType: "Gradient",
    baseGradient: VALUE_OVERLAY_GRADIENT,
    hasBorder: false
  }
}

const AreaKnobParameters: Partial<RoundedRectangleVisualParameters> = {
  default: {
    // Fill color is updated at runtime from the selected color.
    baseType: "Color",
    baseColor: new vec4(1, 0, 0, 1),
    hasBorder: true,
    borderSize: 0.07,
    borderType: "Gradient",
    borderGradient: {
      type: "Linear",
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {percent: 0, color: KnobBorderTop},
      stop1: {percent: 1, color: KnobBorderBottom}
    }
  },
  hovered: {
    borderGradient: {
      type: "Linear",
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {percent: 0, color: new vec4(0.55, 0.55, 0.55, 0.7)},
      stop1: {percent: 1, color: new vec4(0.35, 0.35, 0.35, 0.4)}
    }
  },
  triggered: {
    borderGradient: {
      type: "Linear",
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {percent: 0, color: new vec4(0.6, 0.6, 0.6, 0.8)},
      stop1: {percent: 1, color: new vec4(0.4, 0.4, 0.4, 0.5)}
    }
  }
}

/**
 * A two-dimensional saturation/value picking area for a fixed hue.
 *
 * The body renders the classic color-picker square: a horizontal
 * white-to-hue saturation gradient with a vertical transparent-to-black
 * value ramp composited on top. The knob maps saturation to the x axis
 * (0 = left) and value to the y axis (0 = bottom), stays inset within the
 * area's edges at the extremes, and reflects the color at its
 * position. Dragging moves the knob relative to the drag start; triggering
 * anywhere on the area snaps the knob to that position when
 * {@link snapToTriggerPosition} is enabled.
 *
 * Fill colors are managed manually ({@link Visual.shouldColorChange} =
 * false) while borders continue to animate normally on hover/trigger.
 *
 * @extends VisualElement
 */
@component
export class ColorArea extends VisualElement {
  @input
  @hint("Size of the element in centimeters")
  protected _size: vec3 = new vec3(25, 25, 1)

  @input
  @hint("The default hue in degrees (0-360) rendered by the saturation gradient")
  @widget(new SliderWidget(0, 360, 1))
  private _defaultHue: number = 0

  @input
  @hint("The default saturation, should be between 0 and 1")
  @widget(new SliderWidget(0, 1, 0.01))
  private _defaultSaturation: number = 1

  @input
  @hint("The default value (brightness), should be between 0 and 1")
  @widget(new SliderWidget(0, 1, 0.01))
  private _defaultValue: number = 1

  @input
  @hint("Enable triggering anywhere on the area to snap the knob to that position")
  protected snapToTriggerPosition: boolean = true

  @input
  @hint("Size of the knob in centimeters")
  private _knobSize: vec2 = new vec2(1.5, 1.5)

  private _hue: number = clampHue(this._defaultHue)
  private _saturation: number = clampUnit(this._defaultSaturation, 1)
  private _value: number = clampUnit(this._defaultValue, 1)

  private _knobVisual: RoundedRectangleVisual | null = null
  private _valueOverlayVisual: RoundedRectangleVisual | null = null
  private _trackRoundedRectangleVisual: RoundedRectangleVisual | null = null
  private _trackRoundedRectangleVisualDestroyUnsubscribe: unsubscribe | null = null
  private knobVisualEventHandlerUnsubscribes: unsubscribe[] = []
  private overlayVisualEventHandlerUnsubscribes: unsubscribe[] = []

  private _initialDragPosition: vec3 | null = null
  private _saturationAtDragStart: number = 0
  private _valueAtDragStart: number = 0
  private _knobLocalPos = new vec3(0, 0, KNOB_Z_OFFSET)
  private _overlayLocalPos = new vec3(0, 0, VALUE_OVERLAY_Z_OFFSET)
  private sizeListenerAttached: boolean = false

  private onColorChangeEvent: Event<vec4> = new Event()
  private _onColorChange?: PublicApi<vec4>
  /**
   * Invoked whenever the color at the knob position is recomputed — from
   * dragging, triggering, initialization, or programmatic
   * hue/saturation/value updates. Not deduplicated: the payload can repeat
   * the previous color byte-for-byte (once from initialize(), or on a
   * hue-only change at zero saturation or value, where the RGBA is
   * unchanged). The event payload is the RGBA color.
   */
  public get onColorChange(): PublicApi<vec4> {
    return (this._onColorChange ??= this.onColorChangeEvent.publicApi())
  }

  /**
   * Gets the color at the current knob position.
   * @returns The selected RGBA color (alpha is always 1).
   */
  public get selectedColor(): vec4 {
    return HSVtoRGB(this._hue, this._saturation, this._value, 1)
  }

  /**
   * Gets the hue rendered by the saturation gradient, in degrees.
   * @returns The hue in degrees [0, 360].
   */
  public get hue(): number {
    return this._hue
  }

  /**
   * Sets the hue rendered by the saturation gradient.
   * @param value - The hue in degrees [0, 360].
   */
  public set hue(value: number) {
    if (value === undefined || !isFinite(value)) {
      return
    }
    this.setHSV(value, this._saturation, this._value)
  }

  /**
   * Gets the selected saturation — the knob's normalized x position.
   * @returns The saturation in [0, 1].
   */
  public get saturation(): number {
    return this._saturation
  }

  /**
   * Sets the selected saturation, moving the knob horizontally.
   * @param value - The saturation in [0, 1].
   */
  public set saturation(value: number) {
    if (value === undefined || !isFinite(value)) {
      return
    }
    this.setHSV(this._hue, value, this._value)
  }

  /**
   * Gets the selected value (brightness) — the knob's normalized y position.
   * @returns The value in [0, 1].
   */
  public get value(): number {
    return this._value
  }

  /**
   * Sets the selected value (brightness), moving the knob vertically.
   * @param value - The value in [0, 1].
   */
  public set value(value: number) {
    if (value === undefined || !isFinite(value)) {
      return
    }
    this.setHSV(this._hue, this._saturation, value)
  }

  /**
   * Gets the size of the knob.
   * @returns The knob size in centimeters.
   */
  public get knobSize(): vec2 {
    return this._knobSize
  }

  /**
   * Sets the size of the knob.
   * @param size - The knob size in centimeters.
   */
  public set knobSize(size: vec2) {
    if (size === undefined) {
      return
    }
    this._knobSize = size
    if (this._initialized) {
      this.updateKnobSize()
      this.updateKnobPosition()
      // The gradients are inset by half the knob, so they follow its size.
      this.applySaturationGradient()
      this.applyValueOverlayGradient()
    }
  }

  /**
   * Gets the visual representation of the area's knob.
   * @returns The knob visual, or null before initialization.
   */
  public get knobVisual(): Visual | null {
    return this._knobVisual
  }

  /**
   * Gets a value indicating whether the area is draggable — always true.
   * @returns True.
   */
  public get isDraggable(): boolean {
    return true
  }

  protected override get shouldEnableInstantDrag(): boolean {
    return !this.snapToTriggerPosition
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
    super.visual = value
    if (!this._initialized) {
      this.cacheTrackRoundedRectangleVisual(this.visual)
    } else {
      this.applySaturationGradient()
    }
  }

  /**
   * Sets the hue, saturation, and value in a single pass, updating the
   * gradient, knob position, and knob color once and firing at most one
   * {@link onColorChange} event.
   * @param hue - The hue in degrees [0, 360].
   * @param saturation - The saturation in [0, 1].
   * @param value - The value (brightness) in [0, 1].
   */
  public setHSV(hue: number, saturation: number, value: number): void {
    const nextHue = clampHue(hue, this._hue)
    const nextSaturation = clampUnit(saturation, this._saturation)
    const nextValue = clampUnit(value, this._value)
    const hueChanged = nextHue !== this._hue
    const positionChanged = nextSaturation !== this._saturation || nextValue !== this._value
    if (!hueChanged && !positionChanged) {
      return
    }

    this._hue = nextHue
    this._saturation = nextSaturation
    this._value = nextValue
    if (!this._initialized) {
      return
    }

    if (hueChanged) {
      this.applySaturationGradient()
    }
    if (positionChanged) {
      this.updateKnobPosition()
    }
    this.updateKnobColor()
  }

  /**
   * Initializes the color area: applies the saturation gradient for the
   * current hue and settles the knob on the stored saturation and value.
   */
  public initialize(): boolean {
    if (this.initialized) {
      return false
    }
    if (!super.initialize()) {
      return false
    }

    this.interactable.keepHoverOnTrigger = true

    // Defensive only: a visual's first paint SNAPS rather than animating
    // (RoundedRectangleVisual.applyInitialVisualState — prevState is null
    // there), so there is normally no tween to cancel. Kept so the manual
    // gradients below land on a settled visual.
    this._trackRoundedRectangleVisual?.cancelAnimations()
    this._valueOverlayVisual?.cancelAnimations()
    this.applySaturationGradient()
    this.applyValueOverlayGradient()
    this.updateOverlayLayout()
    this.updateKnobSize()
    this.updateKnobPosition()
    this.updateKnobColor()

    if (!this.sizeListenerAttached) {
      this.onSizeChanged.add(() => {
        if (this._visual instanceof RoundedRectangleVisual) {
          this._visual.cornerRadius = AREA_CORNER_RADIUS
        }
        this.updateOverlayLayout()
        this.updateKnobSize()
        this.updateKnobPosition()
        // Both gradients are laid out from the size and knob size, so they
        // are rebuilt after those settle above.
        this.applySaturationGradient()
        this.applyValueOverlayGradient()
      })
      this.sizeListenerAttached = true
    }
    return true
  }

  /**
   * Gets the render order of the color area.
   * @returns The render order.
   */
  public get renderOrder(): number {
    return this._renderOrder
  }

  /**
   * Sets the render order of the color area. The value overlay and knob
   * render above the body at +1 and +2.
   * @param order - The new render order.
   */
  public set renderOrder(order: number) {
    if (order === undefined) {
      return
    }
    super.renderOrder = order
    if (this._initialized) {
      if (this._valueOverlayVisual) {
        this._valueOverlayVisual.renderMeshVisual.renderOrder = order + 1
      }
      if (this._knobVisual) {
        this._knobVisual.renderMeshVisual.renderOrder = order + 2
      }
    }
  }

  protected createDefaultVisual(): void {
    if (!this._visual) {
      const visual = new RoundedRectangleVisual({
        sceneObject: this.sceneObject,
        style: this.defaultTrackStyle
      })
      visual.cornerRadius = AREA_CORNER_RADIUS
      this._visual = visual
      this.cacheTrackRoundedRectangleVisual(visual)
    }
    if (!this._valueOverlayVisual) {
      this._valueOverlayVisual = this.createValueOverlayVisual()
    }
    if (!this._knobVisual) {
      this._knobVisual = this.createDefaultKnobVisual()
    }

    this._valueOverlayVisual.renderMeshVisual.renderOrder = this._renderOrder + 1
    this._knobVisual.renderMeshVisual.renderOrder = this._renderOrder + 2
  }

  protected get defaultTrackStyle(): Partial<RoundedRectangleVisualParameters> {
    const themed = this.resolveTheme()?.styles["ColorAreaTrack"]?.["default"]
    return themed ?? AreaTrackParameters
  }

  protected get defaultKnobStyle(): Partial<RoundedRectangleVisualParameters> {
    const themed = this.resolveTheme()?.styles["ColorAreaKnob"]?.["default"]
    return themed ?? AreaKnobParameters
  }

  // The value ramp renders on a child so its alpha gradient composites over
  // the saturation gradient. Transparent blending is required — without it
  // the transparent stop would paint opaque black.
  private createValueOverlayVisual(): RoundedRectangleVisual {
    const overlayObject = createChildSceneObjectWithParentLayer("ColorAreaValueOverlay", this.sceneObject)
    this.managedSceneObjects.add(overlayObject)

    const visual = new RoundedRectangleVisual({
      sceneObject: overlayObject,
      style: ValueOverlayParameters,
      transparent: true
    })
    visual.shouldColorChange = false
    visual.cornerRadius = AREA_CORNER_RADIUS
    return visual
  }

  private createDefaultKnobVisual(): RoundedRectangleVisual {
    const knobObject = createChildSceneObjectWithParentLayer("ColorAreaKnob", this.sceneObject)
    this.managedSceneObjects.add(knobObject)

    const visual = new RoundedRectangleVisual({
      sceneObject: knobObject,
      style: this.defaultKnobStyle
    })
    visual.shouldColorChange = false
    return visual
  }

  protected override configureVisual(): void {
    super.configureVisual()
    this.cacheTrackRoundedRectangleVisual(this.visual)
    const trackVisual = this._trackRoundedRectangleVisual
    if (trackVisual) {
      trackVisual.shouldColorChange = false
    }
    // No body onDestroyed handler: VisualElement.destroyVisual drains its
    // subscriptions before destroying the visual, so one could never fire.
    // configureVisual re-runs on every post-init visual reassignment —
    // drain the overlay/knob subscriptions so they don't accumulate.
    this.overlayVisualEventHandlerUnsubscribes.forEach((unsubscribe) => unsubscribe())
    this.overlayVisualEventHandlerUnsubscribes = []
    this.knobVisualEventHandlerUnsubscribes.forEach((unsubscribe) => unsubscribe())
    this.knobVisualEventHandlerUnsubscribes = []
    if (this._valueOverlayVisual) {
      this.overlayVisualEventHandlerUnsubscribes.push(
        this._valueOverlayVisual.onDestroyed.add(() => {
          this._valueOverlayVisual = null
        })
      )
    }
    if (this._knobVisual) {
      this.knobVisualEventHandlerUnsubscribes.push(
        this._knobVisual.onDestroyed.add(() => {
          this._knobVisual = null
        })
      )
    }
  }

  private cacheTrackRoundedRectangleVisual(visual: Visual | null | undefined): void {
    this.clearTrackRoundedRectangleVisual()
    if (visual instanceof RoundedRectangleVisual) {
      this._trackRoundedRectangleVisual = visual
      this._trackRoundedRectangleVisualDestroyUnsubscribe = visual.onDestroyed.add(() => {
        this._trackRoundedRectangleVisual = null
        this._trackRoundedRectangleVisualDestroyUnsubscribe = null
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

  private clearOverlayVisual(): void {
    this.overlayVisualEventHandlerUnsubscribes.forEach((unsubscribe) => unsubscribe())
    this.overlayVisualEventHandlerUnsubscribes = []
    this._valueOverlayVisual = null
  }

  private clearKnobVisual(): void {
    this.knobVisualEventHandlerUnsubscribes.forEach((unsubscribe) => unsubscribe())
    this.knobVisualEventHandlerUnsubscribes = []
    this._knobVisual = null
  }

  protected setState(stateName: StateName): void {
    super.setState(stateName)
    this._knobVisual?.setState(stateName)
  }

  protected onTriggerUpHandler(stateEvent: InteractorEvent): void {
    super.onTriggerUpHandler(stateEvent)
    if (this._isDragged || !this.snapToTriggerPosition) {
      return
    }

    const interactionPosition = this.getInteractionPosition(stateEvent.interactor)
    if (!interactionPosition) {
      return
    }
    // Mapped through the inset travel and clamped, so a tap in the border
    // strip outside the knob's reach still resolves to the nearest edge
    // value rather than being unreachable.
    this.setHSV(
      this._hue,
      clamp(interactionPosition.x / this.knobTravelX + 0.5, 0, 1),
      clamp(interactionPosition.y / this.knobTravelY + 0.5, 0, 1)
    )
  }

  protected onInteractableDragStart(dragEvent: DragInteractorEvent): void {
    super.onInteractableDragStart(dragEvent)
    this._initialDragPosition = this.getInteractionPosition(dragEvent.interactor)
    this._saturationAtDragStart = this._saturation
    this._valueAtDragStart = this._value
  }

  protected onInteractableDragUpdate(dragEvent: DragInteractorEvent): void {
    if (this._isDragged && dragEvent.interactor && this._initialDragPosition) {
      const currentDragPosition = this.getInteractionPosition(dragEvent.interactor)
      if (currentDragPosition) {
        const dragDelta = currentDragPosition.sub(this._initialDragPosition)
        this.setHSV(
          this._hue,
          clamp(this._saturationAtDragStart + dragDelta.x / this.knobTravelX, 0, 1),
          clamp(this._valueAtDragStart + dragDelta.y / this.knobTravelY, 0, 1)
        )
      }
    }
    super.onInteractableDragUpdate(dragEvent)
  }

  /**
   * The fraction of each axis given up to the knob at both ends, since the
   * knob's center travels only the inset range (see {@link knobTravelX}).
   * The gradients are laid out over that same range so the color under the
   * knob is the color its position selects; without this they would sit
   * one half-knob out of step, rendering (for example) full saturation
   * while the knob sits over a slightly desaturated column.
   */
  private get gradientInsetX(): number {
    return knobTravelInsetFraction(this._knobSize.x, this.size.x)
  }

  private get gradientInsetY(): number {
    return knobTravelInsetFraction(this._knobSize.y, this.size.y)
  }

  /**
   * Applies the horizontal white-to-hue saturation gradient for the current
   * hue to the body visual, laid out over the knob's travel range. Columns
   * outside that range clamp to the end colors.
   */
  private applySaturationGradient(): void {
    const trackVisual = this._trackRoundedRectangleVisual
    if (!trackVisual) {
      return
    }
    const inset = this.gradientInsetX
    const gradient: GradientParameters = {
      type: "Linear",
      start: vec2.left(),
      end: vec2.right(),
      stop0: {percent: inset, color: WHITE},
      stop1: {percent: 1 - inset, color: HSVtoRGB(this._hue, 1, 1, 1)}
    }
    trackVisual.defaultBaseType = "Gradient"
    trackVisual.defaultGradient = gradient
    trackVisual.applyBaseGradientNow(gradient)
  }

  /**
   * Applies the vertical value ramp over the knob's vertical travel range,
   * for the same reason the saturation gradient is inset.
   */
  private applyValueOverlayGradient(): void {
    const overlayVisual = this._valueOverlayVisual
    if (!overlayVisual) {
      return
    }
    const inset = this.gradientInsetY
    const gradient: GradientParameters = {
      type: "Linear",
      start: new vec2(0, 1),
      end: new vec2(0, -1),
      stop0: {percent: inset, color: TRANSPARENT_BLACK},
      stop1: {percent: 1 - inset, color: BLACK}
    }
    overlayVisual.defaultBaseType = "Gradient"
    overlayVisual.defaultGradient = gradient
    overlayVisual.applyBaseGradientNow(gradient)
  }

  private updateOverlayLayout(): void {
    if (!this._valueOverlayVisual) {
      return
    }
    this._valueOverlayVisual.size = this.size
    this._valueOverlayVisual.cornerRadius = AREA_CORNER_RADIUS
    this._valueOverlayVisual.transform.setLocalPosition(this._overlayLocalPos)
  }

  private updateKnobSize(): void {
    if (!this._knobVisual) {
      return
    }
    this._knobVisual.size = new vec3(this._knobSize.x, this._knobSize.y, this.size.z)
    this._knobVisual.cornerRadius = this._knobSize.y * KNOB_CORNER_RADIUS_FACTOR
  }

  /**
   * Horizontal knob travel — the area width less the knob width, so the
   * knob stays inside the area's edges at saturation 0 and 1 instead of
   * hanging half-out. Position, dragging, and tap-to-snap all map through
   * this, so a drag tracks the knob rather than outrunning it.
   */
  private get knobTravelX(): number {
    return Math.max(this.size.x - this._knobSize.x, MIN_KNOB_TRAVEL)
  }

  /** Vertical knob travel. @see knobTravelX */
  private get knobTravelY(): number {
    return Math.max(this.size.y - this._knobSize.y, MIN_KNOB_TRAVEL)
  }

  private updateKnobPosition(): void {
    if (!this._knobVisual) {
      return
    }
    this._knobLocalPos.x = (this._saturation - 0.5) * this.knobTravelX
    this._knobLocalPos.y = (this._value - 0.5) * this.knobTravelY
    this._knobLocalPos.z = KNOB_Z_OFFSET
    this._knobVisual.transform.setLocalPosition(this._knobLocalPos)
  }

  private updateKnobColor(): void {
    const color = this.selectedColor
    this._knobVisual?.applyBaseColorNow(color)
    this.onColorChangeEvent.invoke(color)
  }

  protected enableVisuals(): void {
    super.enableVisuals()
    if (this._initialized) {
      if (!isNull(this._valueOverlayVisual) && this._valueOverlayVisual) {
        this._valueOverlayVisual.enable()
      }
      if (!isNull(this._knobVisual) && this._knobVisual) {
        this._knobVisual.enable()
      }
    }
  }

  protected disableVisuals(): void {
    super.disableVisuals()
    if (this._initialized) {
      if (!isNull(this._valueOverlayVisual) && this._valueOverlayVisual) {
        this._valueOverlayVisual.disable()
      }
      if (!isNull(this._knobVisual) && this._knobVisual) {
        this._knobVisual.disable()
      }
    }
  }

  protected release(): void {
    this.clearTrackRoundedRectangleVisual()
    if (!isNull(this._valueOverlayVisual) && this._valueOverlayVisual) {
      this._valueOverlayVisual.destroy()
    }
    this.clearOverlayVisual()
    if (!isNull(this._knobVisual) && this._knobVisual) {
      this._knobVisual.destroy()
    }
    this.clearKnobVisual()
    super.release()
  }
}

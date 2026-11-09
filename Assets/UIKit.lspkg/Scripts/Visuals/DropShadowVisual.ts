import * as MotionChannels from "Motion.lspkg/Channels"
import {power1} from "Motion.lspkg/Eases"
import {Motion} from "Motion.lspkg/Motion"
import {StateName} from "../Components/Element"
import {DropShadow} from "../DropShadow"
import {animateState} from "../Motion/StateMotion"
import {isEqual} from "../Utility/UIKitUtilities"
import {Visual, VisualArgs, VisualParameters, VisualState} from "./Visual"

/**
 * Style parameters for `DropShadowVisual` across all UI states.
 *
 * Extends `VisualParameters` and adds drop-shadow specific properties
 * that can be provided per-state.
 */
export type DropShadowVisualParameters = {
  default: DropShadowVisualState
  hovered: DropShadowVisualState
  triggered: DropShadowVisualState
  toggledDefault: DropShadowVisualState
  toggledHovered: DropShadowVisualState
  toggledTriggered: DropShadowVisualState
  inactive: DropShadowVisualState
} & VisualParameters

/**
 * Per-state visual values for a `DropShadowVisual`, in CSS box-shadow terms.
 *
 * - `blur` is the width of the soft falloff band in world units (cm).
 * - `spreadRadius` grows (+) or shrinks (-) the shadow silhouette relative
 *   to the element size, in world units (cm).
 * - `spread` / `sizeOffset` are the pre-CSS style keys, still accepted and
 *   converted (see normalizeLegacyStyleState). @deprecated — author in
 *   blur/spreadRadius.
 */
export type DropShadowVisualState = {
  blur?: number
  spreadRadius?: number
  /** @deprecated Legacy 0-1 fraction of the corner-radius band; converted to `blur`. */
  spread?: number
  /** @deprecated Legacy per-axis size growth; converted to `spreadRadius`. */
  sizeOffset?: vec2
} & VisualState

const DEFAULT_BLUR = 0.75
const DEFAULT_SPREAD_RADIUS = -0.125

// Reference radius for converting legacy style keys: the standard button
// corner radius the old fraction-based styles were designed against (the same
// constant used to convert VisualElement.DEFAULT_SHADOW_STYLE).
const LEGACY_REFERENCE_RADIUS = 1.5

/**
 * Visual implementation that renders a drop shadow quad using the
 * underlying `DropShadow` component. Adds support for stateful
 * `blur` and `spreadRadius` with animated transitions.
 */
export class DropShadowVisual extends Visual {
  private defaultBlur: number = DEFAULT_BLUR
  private hoveredBlur: number = DEFAULT_BLUR
  private triggeredBlur: number = DEFAULT_BLUR
  private inactiveBlur: number = DEFAULT_BLUR
  private toggledDefaultBlur: number = DEFAULT_BLUR
  private toggledHoveredBlur: number = DEFAULT_BLUR
  private toggledTriggeredBlur: number = DEFAULT_BLUR

  private defaultSpreadRadius: number = DEFAULT_SPREAD_RADIUS
  private hoveredSpreadRadius: number = DEFAULT_SPREAD_RADIUS
  private triggeredSpreadRadius: number = DEFAULT_SPREAD_RADIUS
  private inactiveSpreadRadius: number = DEFAULT_SPREAD_RADIUS
  private toggledDefaultSpreadRadius: number = DEFAULT_SPREAD_RADIUS
  private toggledHoveredSpreadRadius: number = DEFAULT_SPREAD_RADIUS
  private toggledTriggeredSpreadRadius: number = DEFAULT_SPREAD_RADIUS

  // State transitions on Motion channels ("ease-out-quad" ≙ power1.out).
  private readonly _blurChannel = MotionChannels.custom<number>("shadow.blur", () => ({
    read: () => this.dropShadow.blur,
    write: (value: number) => {
      this.dropShadow.blur = value
    }
  }))
  private readonly _spreadRadiusChannel = MotionChannels.custom<number>("shadow.spreadRadius", () => ({
    read: () => this.dropShadow.spreadRadius,
    write: (value: number) => {
      this.dropShadow.spreadRadius = value
    }
  }))

  private _dropShadowVisualStates: Map<StateName, DropShadowVisualState>
  protected _state: DropShadowVisualState = undefined
  protected prevState: DropShadowVisualState = undefined

  /**
   * Gets the size of the drop shadow visual.
   *
   * @returns {vec3} The size of the drop shadow visual.
   */
  public get size(): vec3 {
    return super.size
  }

  /**
   * Sets the size of the drop shadow visual.
   * Updates both the internal `_size` and the `dropShadow.size` properties.
   * State-driven growth is handled by the shadow's `spreadRadius`/`blur`.
   *
   * @param size - A `vec3` representing the dimensions of the drop shadow visual.
   */
  public set size(size: vec3) {
    if (size === undefined) {
      return
    }
    if (isEqual<vec3>(this.size, size)) {
      return
    }
    super.size = size
    if (this.initialized) {
      this.dropShadow.size = new vec2(size.x, size.y)
    }
  }

  /**
   * Gets the underlying render visual for the drop shadow visual.
   *
   * @returns {RenderMeshVisual} The render mesh visual used to render the shadow.
   */
  public get renderMeshVisual(): RenderMeshVisual {
    return this.dropShadow?.renderMeshVisual ?? null
  }

  /**
   * Gets whether the drop shadow visual supports a border.
   *
   * @returns {boolean} Whether the drop shadow visual supports a border.
   */
  public get hasBorder(): boolean {
    return false
  }

  /**
   * Gets the border size of the drop shadow visual.
   *
   * @returns {number} The border size of the drop shadow visual.
   */
  public get borderSize(): number {
    return 0
  }

  /**
   * Gets the corner radius of the drop shadow visual.
   *
   * @returns {number} The corner radius in world units.
   */
  public get cornerRadius(): number {
    return this.dropShadow?.cornerRadius ?? 0
  }

  /**
   * Sets the corner radius of the drop shadow visual.
   *
   * @param value - The corner radius in world units.
   */
  public set cornerRadius(value: number) {
    this.dropShadow.cornerRadius = value
  }

  /**
   * Gets the base color of the drop shadow visual.
   *
   * @returns {vec4} The RGBA color.
   */
  public get baseColor(): vec4 {
    return this.dropShadow?.color ?? undefined
  }

  /**
   * Sets the base color of the drop shadow visual.
   *
   * @param value - A `vec4` representing the RGBA color.
   */
  protected set baseColor(value: vec4) {
    this.dropShadow.color = value
  }

  /**
   * Creates a `DropShadow` component on the provided `sceneObject` and
   * initializes default state values.
   *
   * @param args - Visual construction arguments including `sceneObject`.
   */
  public constructor(args: VisualArgs) {
    super(args)
    this._sceneObject = args.sceneObject
    this.dropShadow = this._sceneObject.createComponent(DropShadow.getTypeName())
    // Explicit init: createComponent defers onAwake while the hierarchy is
    // disabled, and the base Visual (and VisualElement right after) touch
    // renderMeshVisual/property state synchronously.
    this.dropShadow.initialize()
    this.managedComponents.push(this.dropShadow)
    this._transform = this._sceneObject.getTransform()
    this.initialize()
  }

  /** Cancels in-flight animations and destroys base resources. */
  public destroy(): void {
    Motion.killTweensOf(this, "shadow.blur")
    Motion.killTweensOf(this, "shadow.spreadRadius")
    super.destroy()
  }

  /**
   * Applies a new visual state and animates stateful properties.
   *
   * Updates the current `blur` and `spreadRadius` based on the target state
   * using this visual's `animateDuration` easing.
   *
   * @param stateName - The visual state to apply.
   */
  public setState(stateName: StateName) {
    if (this._state === this.visualStates.get(stateName)) {
      // skip redundant calls
      return
    }
    super.setState(stateName)
    this.updateBlur(this._state.blur)
    this.updateSpreadRadius(this._state.spreadRadius)
  }

  protected override applyInitialVisualState(): boolean {
    if (!this._state) {
      return false
    }
    this.applyCurrentVisualState()
    this.updateBlur(this._state.blur)
    this.updateSpreadRadius(this._state.spreadRadius)
    return true
  }

  /**
   * Blur and spreadRadius both animate the same way: kill-and-snap when there
   * is nothing to animate from, otherwise a Motion tween whose duration is
   * scaled by how far is LEFT of the full state-to-state distance — so an
   * interrupted transition finishes in proportion rather than restarting.
   */
  protected updateBlur(blur: number) {
    // First apply (no prevState) or animation disabled: snap, don't animate.
    if (!this.prevState || this.animateDuration <= 0) {
      Motion.killTweensOf(this, "shadow.blur")
      this.dropShadow.blur = blur
      return
    }
    const remaining = Math.abs(this.dropShadow.blur - blur)
    if (remaining === 0) {
      // Already at the requested value, but a rapid A→B→A can land here with
      // B's tween still in flight — kill it or the visual keeps moving.
      Motion.killTweensOf(this, "shadow.sizeOffset")
      return
    }
    const full = Math.abs(this.prevState.blur - blur)
    animateState({
      intent: "state.shadow.blur",
      target: this,
      channel: this._blurChannel,
      value: blur,
      duration: full > 1e-6 ? (this.animateDuration * remaining) / full : this.animateDuration,
      ease: power1.out
    })
  }

  protected updateSpreadRadius(spreadRadius: number) {
    // First apply (no prevState) or animation disabled: snap, don't animate.
    if (!this.prevState || this.animateDuration <= 0) {
      Motion.killTweensOf(this, "shadow.spreadRadius")
      this.dropShadow.spreadRadius = spreadRadius
      return
    }
    const remaining = Math.abs(this.dropShadow.spreadRadius - spreadRadius)
    if (remaining === 0) {
      // Same A→B→A guard as sizeOffset above.
      Motion.killTweensOf(this, "shadow.spread")
      return
    }
    const full = Math.abs(this.prevState.spreadRadius - spreadRadius)
    animateState({
      intent: "state.shadow.spreadRadius",
      target: this,
      channel: this._spreadRadiusChannel,
      value: spreadRadius,
      duration: full > 1e-6 ? (this.animateDuration * remaining) / full : this.animateDuration,
      ease: power1.out
    })
  }

  /**
   * Back-compat for pre-CSS styles: a state authored with legacy
   * `spread` (fraction) / `sizeOffset` (per-axis growth) and no CSS keys gets
   * them converted in place — band width = fraction × the reference radius,
   * silhouette growth = (sizeOffset − blur) / 2 (the same conversion used for
   * the built-in default style).
   */
  private normalizeLegacyStyleState(state: DropShadowVisualState | undefined): void {
    if (!state) {
      return
    }
    if (state.blur === undefined && state.spread !== undefined) {
      state.blur = state.spread * LEGACY_REFERENCE_RADIUS
    }
    if (state.spreadRadius === undefined && state.sizeOffset !== undefined) {
      state.spreadRadius = (state.sizeOffset.x - (state.blur ?? 0)) / 2
    }
  }

  protected applyStyleParameters(parameters: Partial<DropShadowVisualParameters>) {
    this.normalizeLegacyStyleState(parameters.default)
    this.normalizeLegacyStyleState(parameters.hovered)
    this.normalizeLegacyStyleState(parameters.triggered)
    this.normalizeLegacyStyleState(parameters.inactive)
    this.normalizeLegacyStyleState(parameters.toggledDefault)
    this.normalizeLegacyStyleState(parameters.toggledHovered)
    this.normalizeLegacyStyleState(parameters.toggledTriggered)

    // First call the parent method to handle base VisualState properties
    super.applyStyleParameters(parameters)

    this.applyStyleProperty<Partial<DropShadowVisualParameters>, DropShadowVisualState, number>(parameters, "blur", {
      default: (value) => (this.defaultBlur = value),
      hovered: (value) => (this.hoveredBlur = value),
      triggered: (value) => (this.triggeredBlur = value),
      inactive: (value) => (this.inactiveBlur = value),
      toggledDefault: (value) => (this.toggledDefaultBlur = value),
      toggledHovered: (value) => (this.toggledHoveredBlur = value),
      toggledTriggered: (value) => (this.toggledTriggeredBlur = value)
    })

    this.applyStyleProperty<Partial<DropShadowVisualParameters>, DropShadowVisualState, number>(
      parameters,
      "spreadRadius",
      {
        default: (value) => (this.defaultSpreadRadius = value),
        hovered: (value) => (this.hoveredSpreadRadius = value),
        triggered: (value) => (this.triggeredSpreadRadius = value),
        inactive: (value) => (this.inactiveSpreadRadius = value),
        toggledDefault: (value) => (this.toggledDefaultSpreadRadius = value),
        toggledHovered: (value) => (this.toggledHoveredSpreadRadius = value),
        toggledTriggered: (value) => (this.toggledTriggeredSpreadRadius = value)
      }
    )
  }

  /**
   * Gets the map of visual states for the drop shadow visual.
   *
   * @returns {Map<StateName, DropShadowVisualState>} The map of visual states.
   */
  protected get visualStates(): Map<StateName, DropShadowVisualState> {
    return this._dropShadowVisualStates
  }

  protected updateVisualStates(): void {
    this._dropShadowVisualStates = new Map([
      [
        StateName.default,
        {
          baseColor: this.baseDefaultColor,
          shouldPosition: this.defaultShouldPosition,
          shouldScale: this.defaultShouldScale,
          localScale: this.defaultScale,
          localPosition: this.defaultPosition,
          blur: this.defaultBlur,
          spreadRadius: this.defaultSpreadRadius
        }
      ],
      [
        StateName.hovered,
        {
          baseColor: this.baseHoveredColor,
          shouldPosition: this.hoveredShouldPosition,
          shouldScale: this.hoveredShouldScale,
          blur: this.hoveredBlur,
          spreadRadius: this.hoveredSpreadRadius
        }
      ],
      [
        StateName.triggered,
        {
          baseColor: this.baseTriggeredColor,
          shouldPosition: this.triggeredShouldPosition,
          shouldScale: this.triggeredShouldScale,
          blur: this.triggeredBlur,
          spreadRadius: this.triggeredSpreadRadius
        }
      ],
      [
        StateName.toggledHovered,
        {
          baseColor: this.baseToggledHoveredColor,
          shouldPosition: this.toggledHoveredShouldPosition,
          shouldScale: this.toggledHoveredShouldScale,
          blur: this.toggledHoveredBlur,
          spreadRadius: this.toggledHoveredSpreadRadius
        }
      ],
      [
        StateName.toggledDefault,
        {
          baseColor: this.baseToggledDefaultColor,
          shouldPosition: this.toggledDefaultShouldPosition,
          shouldScale: this.toggledDefaultShouldScale,
          blur: this.toggledDefaultBlur,
          spreadRadius: this.toggledDefaultSpreadRadius
        }
      ],
      [
        StateName.toggledTriggered,
        {
          baseColor: this.baseToggledTriggeredColor,
          shouldPosition: this.toggledTriggeredShouldPosition,
          shouldScale: this.toggledTriggeredShouldScale,
          blur: this.toggledTriggeredBlur,
          spreadRadius: this.toggledTriggeredSpreadRadius
        }
      ],
      [
        StateName.error,
        {
          baseColor: this.baseErrorColor,
          shouldPosition: this.defaultShouldPosition,
          shouldScale: this.defaultShouldScale,
          localScale: this.errorScale,
          localPosition: this.errorPosition,
          blur: this.defaultBlur,
          spreadRadius: this.defaultSpreadRadius
        }
      ],
      [
        StateName.errorHovered,
        {
          baseColor: this.baseErrorColor,
          shouldPosition: this.hoveredShouldPosition,
          shouldScale: this.hoveredShouldScale,
          localScale: this.hoveredScale,
          localPosition: this.errorPosition,
          blur: this.hoveredBlur,
          spreadRadius: this.hoveredSpreadRadius
        }
      ],
      [
        StateName.inactive,
        {
          baseColor: this.baseInactiveColor,
          shouldPosition: this.inactiveShouldPosition,
          shouldScale: this.inactiveShouldScale,
          localScale: this.inactiveScale,
          localPosition: this.inactivePosition,
          blur: this.inactiveBlur,
          spreadRadius: this.inactiveSpreadRadius
        }
      ]
    ])
    super.updateVisualStates()
  }

  /**
   * Gets the underlying `DropShadow` component.
   *
   * @returns {DropShadow} The underlying drop shadow component.
   */
  private get dropShadow(): DropShadow {
    return this._visualComponent as DropShadow
  }

  /**
   * Sets the underlying `DropShadow` component.
   *
   * @param value - The drop shadow component.
   */
  private set dropShadow(value: DropShadow) {
    this._visualComponent = value
  }
}

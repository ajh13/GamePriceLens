import {withAlpha} from "InteractionKit.lspkg/Utils/color"
import * as MotionChannels from "Motion.lspkg/Channels"
import {linear} from "Motion.lspkg/Eases"
import {Motion} from "Motion.lspkg/Motion"
import {StateName} from "../../Components/Element"
import {OpacityControllable} from "../../Interfaces/OpacityControllable"
import {animateState} from "../../Motion/StateMotion"
import {colorDistance, colorLerp, isEqual} from "../../Utility/UIKitUtilities"
import {COLORS, INACTIVE_COLOR, Visual, VisualArgs, VisualParameters, VisualState} from "../Visual"
import {BaseRoundedRectangle} from "./BaseRoundedRectangle"
import {
  BorderType,
  createDefaultRoundedRectangleConfig,
  GradientParameters,
  RoundedRectangleBaseType,
  RoundedRectBlendMode
} from "./RoundedRectangleTypes"

// Border-thickness changes tween on their own (snappier) duration rather than
// the shared state fade, so size pops feel quick without speeding up colors.
const BORDER_SIZE_FADE_DURATION: number = 0.15

const BACKGROUND_GRADIENT_PARAMETERS: {[key: string]: GradientParameters} = {
  default: {
    enabled: true,
    type: "Rectangle",
    stop0: {enabled: true, percent: 0, color: COLORS.darkGray},
    stop1: {enabled: true, percent: 0.5, color: COLORS.darkGray},
    stop2: {enabled: true, percent: 0.95, color: COLORS.darkGray},
    stop3: {enabled: true, percent: 0.99, color: COLORS.darkGray}
  },
  hovered: {
    enabled: true,
    type: "Rectangle",
    stop0: {enabled: true, percent: 0, color: COLORS.darkGray},
    stop1: {enabled: true, percent: 0.5, color: COLORS.darkGray},
    stop2: {enabled: true, percent: 0.95, color: COLORS.darkGray},
    stop3: {enabled: true, percent: 0.99, color: COLORS.darkGray}
  },
  toggled: {
    enabled: true,
    type: "Rectangle",
    stop0: {enabled: true, percent: -1, color: withAlpha(COLORS.brightYellow.uniformScale(0.3), 1)},
    stop1: {enabled: true, percent: -1, color: withAlpha(COLORS.brightYellow.uniformScale(0.3), 1)},
    stop2: {enabled: true, percent: -1, color: withAlpha(COLORS.brightYellow.uniformScale(0.3), 1)},
    stop3: {enabled: true, percent: 3, color: withAlpha(COLORS.brightYellow.uniformScale(0.9), 1)}
  }
}

const BORDER_GRADIENT_PARAMETERS: {[key: string]: GradientParameters} = {
  default: {
    enabled: true,
    start: new vec2(-1, 0),
    end: new vec2(1, 0),
    stop0: {enabled: true, percent: 0, color: COLORS.lightGray},
    stop1: {enabled: true, percent: 0.5, color: withAlpha(COLORS.lightGray.uniformScale(0.66), 1)},
    stop2: {enabled: true, percent: 1, color: COLORS.lightGray}
  },
  hovered: {
    enabled: true,
    start: new vec2(-1, 0),
    end: new vec2(1, 0),
    stop0: {enabled: true, percent: 0, color: withAlpha(COLORS.brightYellow.uniformScale(0.9), 1)},
    stop1: {enabled: true, percent: 0.5, color: withAlpha(COLORS.brightYellow.uniformScale(0.66), 1)},
    stop2: {enabled: true, percent: 1, color: withAlpha(COLORS.brightYellow.uniformScale(0.9), 1)}
  },
  toggled: {
    enabled: true,
    start: new vec2(-1, 0),
    end: new vec2(1, 0),
    stop0: {enabled: true, percent: 0, color: COLORS.brightYellow},
    stop1: {enabled: true, percent: 0.5, color: COLORS.brightYellow},
    stop2: {enabled: true, percent: 1, color: COLORS.brightYellow}
  },
  toggledHovered: {
    enabled: true,
    start: new vec2(-1, 0),
    end: new vec2(1, 0),
    stop0: {enabled: true, percent: 0, color: withAlpha(COLORS.brightYellow.uniformScale(0.9), 1)},
    stop1: {enabled: true, percent: 0.5, color: withAlpha(COLORS.brightYellow.uniformScale(0.66), 1)},
    stop2: {enabled: true, percent: 1, color: withAlpha(COLORS.brightYellow.uniformScale(0.9), 1)}
  }
}

/**
 * Base Types for background
 */
export type BaseType = RoundedRectangleBaseType

export type RoundedRectangleVisualState = {
  baseType?: BaseType
  baseGradient?: GradientParameters
  baseTexture?: Texture
  borderColor?: vec4
  borderGradient?: GradientParameters
  borderSize?: number
  borderSoftness?: number
  hasBorder?: boolean
  borderType?: BorderType
} & VisualState

export type RoundedRectangleVisualParameters = {
  default: RoundedRectangleVisualState
  hovered: RoundedRectangleVisualState
  triggered: RoundedRectangleVisualState
  toggledDefault: RoundedRectangleVisualState
  toggledHovered: RoundedRectangleVisualState
  toggledTriggered: RoundedRectangleVisualState
  inactive: RoundedRectangleVisualState
} & VisualParameters

export type RoundedRectangleVisualArgs = {
  transparent?: boolean
} & VisualArgs

type RoundedRectangleStoredStateName =
  | "default"
  | "hovered"
  | "triggered"
  | "inactive"
  | "toggledDefault"
  | "toggledHovered"
  | "toggledTriggered"

type RoundedRectangleStoredState = {
  baseType: BaseType
  gradient: GradientParameters
  texture: Texture
  hasBorder: boolean
  borderType: BorderType
  borderSize: number
  borderColor: vec4
  borderGradient: GradientParameters
}

// Shape of the base (Visual-level) per-state source objects in `_states`.
type BaseVisualStateSource = {
  color: vec4
  scale: vec3
  position: vec3
  shouldPosition: boolean
  shouldScale: boolean
}

/**
 * The `RoundedRectangleVisual` class represents a visual component that renders a rounded rectangle
 * with customizable properties such as border, gradients, and colors. It extends the base `Visual` class
 * and provides additional functionality specific to rounded rectangles.
 *
 * @extends Visual
 */
export class RoundedRectangleVisual extends Visual implements OpacityControllable {
  // Per-state styling grouped into one object (was 56 separate fields) to keep the
  // instance's own-property count low. Pure storage relocation: every accessor below
  // reads/writes through this, render output unchanged. The uniform slot shape keeps
  // the object shape stable. Defaults transcribed 1:1 from the previous field
  // initializers.
  private readonly _rrStates: Record<RoundedRectangleStoredStateName, RoundedRectangleStoredState> = {
    default: {
      baseType: "Color",
      gradient: BACKGROUND_GRADIENT_PARAMETERS.default,
      texture: null,
      hasBorder: false,
      borderType: "Gradient",
      borderSize: 0.1,
      borderColor: COLORS.lightGray,
      borderGradient: BORDER_GRADIENT_PARAMETERS.default
    },
    hovered: {
      baseType: "Color",
      gradient: BACKGROUND_GRADIENT_PARAMETERS.default,
      texture: null,
      hasBorder: false,
      borderType: "Gradient",
      borderSize: 0.1,
      borderColor: COLORS.brightYellow,
      borderGradient: BORDER_GRADIENT_PARAMETERS.hovered
    },
    triggered: {
      baseType: "Color",
      gradient: BACKGROUND_GRADIENT_PARAMETERS.toggled,
      texture: null,
      hasBorder: false,
      borderType: "Gradient",
      borderSize: 0.1,
      borderColor: COLORS.brightYellow,
      borderGradient: BORDER_GRADIENT_PARAMETERS.toggled
    },
    inactive: {
      baseType: "Color",
      gradient: BACKGROUND_GRADIENT_PARAMETERS.default,
      texture: null,
      hasBorder: false,
      borderType: "Gradient",
      borderSize: 0.1,
      borderColor: INACTIVE_COLOR,
      borderGradient: BORDER_GRADIENT_PARAMETERS.default
    },
    toggledDefault: {
      baseType: "Color",
      gradient: BACKGROUND_GRADIENT_PARAMETERS.default,
      texture: null,
      hasBorder: false,
      borderType: "Gradient",
      borderSize: 0.1,
      borderColor: COLORS.brightYellow,
      borderGradient: BORDER_GRADIENT_PARAMETERS.toggled
    },
    toggledHovered: {
      baseType: "Color",
      gradient: BACKGROUND_GRADIENT_PARAMETERS.default,
      texture: null,
      hasBorder: false,
      borderType: "Gradient",
      borderSize: 0.1,
      borderColor: COLORS.brightYellow,
      borderGradient: BORDER_GRADIENT_PARAMETERS.toggledHovered
    },
    toggledTriggered: {
      baseType: "Color",
      gradient: BACKGROUND_GRADIENT_PARAMETERS.toggled,
      texture: null,
      hasBorder: false,
      borderType: "Gradient",
      borderSize: 0.1,
      borderColor: COLORS.brightYellow,
      borderGradient: BORDER_GRADIENT_PARAMETERS.toggled
    }
  }

  // Gradient state transitions ride a scalar progress channel — gradients
  // aren't an AnimatableValue, so Motion owns the clock and interruption
  // while the write lerps the captured endpoints. Ratio-scaled durations
  // preserve the legacy mid-flight-replay compensation.
  private _gradientTransition: {from: GradientParameters; to: GradientParameters} | null = null
  private _borderGradientTransition: {from: GradientParameters; to: GradientParameters} | null = null
  private _gradientProgress: number = 1
  private readonly _gradientChannel = MotionChannels.custom<number>("rr.gradient", () => ({
    read: () => this._gradientProgress,
    write: (t: number) => {
      this._gradientProgress = t
      const transition = this._gradientTransition
      if (transition === null) {
        return
      }
      this.currentGradient = GradientParameters.lerp(transition.from, transition.to, t)
      this.roundedRectangle.setBackgroundGradient(this.currentGradient)
    }
  }))
  private _borderGradientProgress: number = 1
  private readonly _borderGradientChannel = MotionChannels.custom<number>("rr.borderGradient", () => ({
    read: () => this._borderGradientProgress,
    write: (t: number) => {
      this._borderGradientProgress = t
      const transition = this._borderGradientTransition
      if (transition === null) {
        return
      }
      this.currentBorderGradient = GradientParameters.lerp(transition.from, transition.to, t)
      this.roundedRectangle.setBorderGradient(this.currentBorderGradient)
    }
  }))
  // Scalar progress channel so the write can use colorLerp (shortest-path
  // HSV, the legacy behavior, and the same metric colorDistance scales the
  // duration by) — Motion's built-in vec4 lerp is component-wise RGB.
  private _borderColorTransition: {from: vec4; to: vec4} | null = null
  private _borderColorProgress: number = 1
  private readonly _borderColorChannel = MotionChannels.custom<number>("rr.borderColor", () => ({
    read: () => this._borderColorProgress,
    write: (t: number) => {
      this._borderColorProgress = t
      const transition = this._borderColorTransition
      if (transition === null) {
        return
      }
      this.roundedRectangle.borderColor = colorLerp(transition.from, transition.to, t)
    }
  }))
  private readonly _borderSizeChannel = MotionChannels.custom<number>("rr.borderSize", () => ({
    read: () => this.roundedRectangle.borderSize,
    write: (value: number) => {
      this.roundedRectangle.borderSize = value
    }
  }))
  private currentGradient: GradientParameters = this.defaultGradient
  private baseTransientGradientOverrideActive: boolean = false
  private baseTransientGradientPositionsCaptured: boolean = false
  private readonly baseTransientGradientStartPosition: vec2 = new vec2(0, 0)
  private readonly baseTransientGradientEndPosition: vec2 = new vec2(0, 0)

  private _hasBorder: boolean = false
  private currentBorderGradient: GradientParameters = this.borderDefaultGradient
  private borderTransientGradientOverrideActive: boolean = false
  private borderTransientGradientPositionsCaptured: boolean = false
  private readonly borderTransientGradientStartPosition: vec2 = new vec2(0, 0)
  private readonly borderTransientGradientEndPosition: vec2 = new vec2(0, 0)

  private _renderMeshVisual: RenderMeshVisual
  private _baseRoundedRectangle: BaseRoundedRectangle
  private _syncVisualStateUpdateInProgress: boolean = false

  private readonly _roundedRectangleVisualStates: Map<StateName, RoundedRectangleVisualState> = new Map()
  protected _state: RoundedRectangleVisualState = undefined
  protected prevState: RoundedRectangleVisualState = undefined

  protected get visualStates(): Map<StateName, RoundedRectangleVisualState> {
    return this._roundedRectangleVisualStates
  }

  protected override get needsVisualStateUpdate(): boolean {
    return super.needsVisualStateUpdate
  }

  protected override set needsVisualStateUpdate(value: boolean) {
    super.needsVisualStateUpdate = value
    if (value) {
      // RRV owns no ScriptComponent host, so Visual's LateUpdateEvent batching is inert here -
      // drain visual-state updates synchronously (converges in one pass; the i < 4 cap is defensive).
      this.flushVisualStateUpdateNow()
    }
  }

  private flushVisualStateUpdateNow(): void {
    if (!this.initialized || this._syncVisualStateUpdateInProgress) {
      return
    }
    this._syncVisualStateUpdateInProgress = true
    try {
      for (let i = 0; i < 4 && super.needsVisualStateUpdate; i++) {
        super.needsVisualStateUpdate = false
        this.updateVisualStates()
      }
    } finally {
      this._syncVisualStateUpdateInProgress = false
    }
  }

  /**
   * Controls the opacity of this visual.
   */
  public get opacity(): number {
    return this.roundedRectangle.opacity
  }

  /**
   * @param opacity - Opacity value in the range [0, 1].
   * @see opacity
   */
  public set opacity(opacity: number) {
    this.roundedRectangle.opacity = opacity
  }

  public set transparencyEnabled(transparencyEnabled: boolean) {
    this.roundedRectangle.blendMode = transparencyEnabled ? RoundedRectBlendMode.Normal : RoundedRectBlendMode.Disabled
  }

  /**
   * Whether the material variant ladder may swap this visual's material.
   * Disable BEFORE overriding renderMeshVisual.mainMaterial with a bespoke
   * shader, or a later state change would swap the override away.
   */
  public get materialVariantsEnabled(): boolean {
    return this.roundedRectangle.materialVariantsEnabled
  }

  public set materialVariantsEnabled(enabled: boolean) {
    this.roundedRectangle.materialVariantsEnabled = enabled
  }

  public get transparencyEnabled(): boolean {
    return this.roundedRectangle.blendMode == RoundedRectBlendMode.Normal
  }

  /**
   * Gets the size of the RoundedRectangleVisual.
   *
   * @returns A `vec3` representing the dimensions of the RoundedRectangleVisual.
   */
  public get size(): vec3 {
    return super.size
  }

  /**
   * Sets the size of the RoundedRectangleVisual, propagating it to the underlying shape.
   *
   * @param size - A `vec3` object representing the dimensions of the RoundedRectangleVisual.
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
      this.roundedRectangle.size = new vec2(size.x, size.y)
    }
  }

  /**
   * Gets the `RenderMeshVisual` associated with the rounded rectangle.
   *
   * @returns {RenderMeshVisual} The visual representation of the rounded rectangle's mesh.
   */
  public get renderMeshVisual(): RenderMeshVisual {
    return this._renderMeshVisual
  }

  /**
   * Skips the draw while every fill and border color is fully transparent, for example an idle
   * Ghost button. On by default. Turn off for a transparent visual that must still write depth.
   */
  public get cullWhenTransparent(): boolean {
    return this.roundedRectangle.cullWhenTransparent
  }

  public set cullWhenTransparent(value: boolean) {
    this.roundedRectangle.cullWhenTransparent = value
  }

  /**
   * Also skips the draw at opacity 0. Only for owners that drive this visual's opacity
   * themselves; off by default because VisibilityGroup writes the pass opacity directly.
   */
  public get cullIncludesOpacity(): boolean {
    return this.roundedRectangle.cullIncludesOpacity
  }

  public set cullIncludesOpacity(value: boolean) {
    this.roundedRectangle.cullIncludesOpacity = value
  }

  /**
   * Retrieves the base color of the rounded rectangle visual.
   *
   * @returns {vec4} The background color of the rounded rectangle as a `vec4` value.
   */
  public get baseColor(): vec4 {
    return this.roundedRectangle.backgroundColor
  }

  /**
   * Indicates whether the rounded rectangle visual has a border.
   *
   * @returns `true` if the visual has a border; otherwise, `false`.
   */
  public get hasBorder(): boolean {
    return this._hasBorder
  }

  /**
   * Gets the size of the border for the rounded rectangle.
   *
   * @returns The border size as a number.
   */
  public get borderSize(): number {
    return this.roundedRectangle.borderSize
  }

  /**
   * Sets the border thickness (centimeters in local space). Note the border
   * only renders while it is enabled, and disabling the border forces the
   * size back to 0 — so when enabling transiently (e.g. via
   * applyBorderGradientNow on a borderless style), set the size AFTER.
   */
  public set borderSize(borderSize: number) {
    this.roundedRectangle.borderSize = borderSize
  }

  /**
   * Updates the visual state of the RoundedRectangleVisual component.
   *
   * This method overrides the base `setState` method to apply visual updates
   * specific to the RoundedRectangleVisual, such as gradients and border colors.
   *
   * @param stateName - The new state to apply, represented as a `stateName` object.
   */
  public setState(stateName: StateName) {
    if (this._state === this.visualStates.get(stateName)) {
      return
    }
    super.setState(stateName)
    if (this.initialized) {
      this.applyRoundedRectangleState()
    }
  }

  protected override applyInitialVisualState(): boolean {
    if (!this._state) {
      return false
    }
    // Push the resolved first state onto the shape through the same appliers as a state
    // change (base color/scale/position + fill/border). The shape is not yet initialized,
    // so its setters write backing fields without touching mainPass; initialize() then
    // paints the full themed state once via configureMesh — a single paint, no throwaway
    // default paint. prevState is null here, so the update* helpers snap instead of
    // animating — no fade-in on creation.
    this.applyCurrentVisualState()
    this.applyRoundedRectangleState()
    this.roundedRectangle.initialize()
    this.roundedRectangle.updateSize(new vec2(this.size.x, this.size.y))
    if ((this.visualArgs as RoundedRectangleVisualArgs).transparent === true) {
      this.renderMeshVisual.mainPass.colorMask = new vec4b(true, true, true, true)
    }
    return true
  }

  private applyRoundedRectangleState(
    includeBaseColor: boolean = false,
    forceRestoreBaseGradient: boolean = false,
    forceRestoreBorderGradient: boolean = false
  ): void {
    const state = this._state
    if (!state) {
      return
    }

    const shouldApplyBase = !this.baseTransientGradientOverrideActive && (this.shouldColorChange || includeBaseColor)
    if (shouldApplyBase) {
      // RoundedRectangle.baseType setter self-guards undefined.
      this.baseType = state.baseType
      if (includeBaseColor && state.baseColor !== undefined) {
        this.updateColors(state.baseColor)
      }
      if (state.baseGradient !== undefined) {
        if (forceRestoreBaseGradient) {
          this.forceRestoreBaseGradient(state.baseGradient)
        } else {
          this.updateGradient(state.baseGradient)
        }
      }
      this.updateBaseTexture(state.baseTexture)
    }

    if (!this.borderTransientGradientOverrideActive) {
      this.updateHasBorder(state.hasBorder)
      if (state.borderType !== undefined) {
        this.isBorderGradient = state.borderType === "Gradient"
      }
      this.updateBorderColors(state.borderColor)
      if (state.borderGradient !== undefined) {
        if (forceRestoreBorderGradient) {
          this.forceRestoreBorderGradient(state.borderGradient)
        } else {
          this.updateBorderGradient(state.borderGradient)
        }
      }
      this.updateBorderSize(state.borderSize)
    }
  }

  /**
   * Constructs a new instance of the `RoundedRectangleVisual` class.
   *
   * @param sceneObject - The parent `SceneObject` to which this visual will be attached.
   */
  public constructor(args: RoundedRectangleVisualArgs) {
    super(args)
    this._sceneObject = args.sceneObject
    this._transform = this._sceneObject.getTransform()
    this._renderMeshVisual = this._sceneObject.createComponent("RenderMeshVisual")
    this.managedComponents.push(this._renderMeshVisual)
    const material = BaseRoundedRectangle.cloneMaterialAsset()
    this._baseRoundedRectangle = new BaseRoundedRectangle(
      this._renderMeshVisual,
      material,
      createDefaultRoundedRectangleConfig(new vec2(this.size.x, this.size.y), RoundedRectBlendMode.Disabled)
    )
    // Element visuals rest fully transparent often (idle Ghost, unchecked toggle layers); skip those draws.
    this._baseRoundedRectangle.cullWhenTransparent = true
    // roundedRectangle.initialize() is deferred to applyInitialVisualState(): the resolved
    // theme state is pushed onto the base as plain fields first (its setters are no-ops on
    // mainPass until initialized), so Base.initialize() paints the themed state in a single pass
    // instead of painting defaults here and overwriting them once the theme resolves.
    // size/blendMode set backing fields now; configureMesh reads them on initialize().
    this.roundedRectangle.size = new vec2(this.size.x, this.size.y)
    this.transparencyEnabled = args.transparent === true
    this.initialize()
  }

  public destroy(): void {
    this.clearTransientGradientOverrides()
    this.cancelAnimations()
    this.roundedRectangle.dispose()
    super.destroy()
  }

  /**
   * Cancels any in-flight gradient and border color/gradient animations.
   */
  public override cancelAnimations(): void {
    Motion.killTweensOf(this, "rr.gradient")
    Motion.killTweensOf(this, "rr.borderColor")
    Motion.killTweensOf(this, "rr.borderGradient")
    Motion.killTweensOf(this, "rr.borderSize")
    super.cancelAnimations()
  }

  private clearTransientGradientOverrides(): void {
    this.baseTransientGradientOverrideActive = false
    this.borderTransientGradientOverrideActive = false
    this.baseTransientGradientPositionsCaptured = false
    this.borderTransientGradientPositionsCaptured = false
  }

  private copyVec2(from: vec2, to: vec2): void {
    to.x = from.x
    to.y = from.y
  }

  private cloneVec2(value: vec2): vec2 {
    return new vec2(value.x, value.y)
  }

  private captureBaseTransientGradientPositions(): void {
    const start = this.roundedRectangle.gradientStartPosition
    const end = this.roundedRectangle.gradientEndPosition
    if (start === undefined || end === undefined) {
      this.baseTransientGradientPositionsCaptured = false
      return
    }

    this.copyVec2(start, this.baseTransientGradientStartPosition)
    this.copyVec2(end, this.baseTransientGradientEndPosition)
    this.baseTransientGradientPositionsCaptured = true
  }

  private captureBorderTransientGradientPositions(): void {
    const start = this.roundedRectangle.borderGradientStartPosition
    const end = this.roundedRectangle.borderGradientEndPosition
    if (start === undefined || end === undefined) {
      this.borderTransientGradientPositionsCaptured = false
      return
    }

    this.copyVec2(start, this.borderTransientGradientStartPosition)
    this.copyVec2(end, this.borderTransientGradientEndPosition)
    this.borderTransientGradientPositionsCaptured = true
  }

  private restoreBaseTransientGradientPositions(): void {
    if (!this.baseTransientGradientPositionsCaptured) {
      return
    }

    const start = this.cloneVec2(this.baseTransientGradientStartPosition)
    const end = this.cloneVec2(this.baseTransientGradientEndPosition)
    this.roundedRectangle.setBackgroundGradientPositions(start, end)
    this.currentGradient = {
      ...this.currentGradient,
      start,
      end
    }
    this.baseTransientGradientPositionsCaptured = false
  }

  private restoreBorderTransientGradientPositions(): void {
    if (!this.borderTransientGradientPositionsCaptured) {
      return
    }

    const start = this.cloneVec2(this.borderTransientGradientStartPosition)
    const end = this.cloneVec2(this.borderTransientGradientEndPosition)
    this.roundedRectangle.setBorderGradientPositions(start, end)
    this.currentBorderGradient = {
      ...this.currentBorderGradient,
      start,
      end
    }
    this.borderTransientGradientPositionsCaptured = false
  }

  protected set baseColor(value: vec4) {
    this.roundedRectangle.backgroundColor = value
  }

  public applyBaseColorNow(color: vec4): void {
    if (color === undefined) {
      return
    }
    this._states.default.color = color
    this.baseColor = color
  }

  protected updateColors(meshColor: vec4) {
    if (this.baseType !== "Color") {
      return
    }
    super.updateColors(meshColor)
  }

  /****  Rounded Rectangle explicit  ******************/

  /**
   * Gets the corner radius of the rounded rectangle.
   *
   * @returns The current corner radius of the rounded rectangle in pixels.
   */
  public get cornerRadius(): number {
    return this.roundedRectangle.cornerRadius
  }

  /**
   * Sets the corner radius of the rounded rectangle.
   *
   * @param cornerRadius - The radius of the corners in pixels.
   */
  public set cornerRadius(cornerRadius: number) {
    if (cornerRadius === undefined) {
      return
    }
    this.roundedRectangle.cornerRadius = cornerRadius
  }

  /**
   * The background fill mode: "Color", "Gradient", or "Texture".
   */
  public get baseType(): BaseType {
    return this.roundedRectangle.baseType
  }

  /**
   * Sets the background fill mode.
   *
   * @param baseType - "Color" (solid), "Gradient", or "Texture".
   */
  public set baseType(baseType: BaseType) {
    if (baseType === undefined) {
      return
    }
    this.roundedRectangle.baseType = baseType
  }

  /**
   * Gets the default gradient parameters for the visual.
   *
   * @returns The default gradient parameters.
   */
  public get defaultGradient(): GradientParameters {
    return this._rrStates.default.gradient
  }

  /**
   * Sets the default gradient parameters for the visual and initializes the visual states.
   *
   * @param gradient - The gradient parameters to be set as the default.
   */
  public set defaultGradient(gradient: GradientParameters) {
    if (gradient === undefined) {
      return
    }
    if (isEqual<GradientParameters>(this._rrStates.default.gradient, gradient)) {
      return
    }
    this._rrStates.default.gradient = gradient
    if (!this.shouldColorChange && this.baseType === "Gradient") {
      this.roundedRectangle.setBackgroundGradient(gradient)
    } else if (this.shouldColorChange) {
      if (this.initialized) {
        this.needsVisualStateUpdate = true
      }
    }
  }

  /**
   * Gets the hovered gradient parameters for the visual.
   *
   * @returns The hovered gradient parameters.
   */
  public get hoveredGradient(): GradientParameters {
    return this._rrStates.hovered.gradient
  }

  /**
   * Sets the hovered gradient parameters for the visual and initializes the visual states.
   *
   * @param hoveredGradient - The gradient parameters to be set for the hovered state.
   */
  public set hoveredGradient(hoveredGradient: GradientParameters) {
    if (hoveredGradient === undefined) {
      return
    }
    if (isEqual<GradientParameters>(this._rrStates.hovered.gradient, hoveredGradient)) {
      return
    }
    this._rrStates.hovered.gradient = hoveredGradient
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the triggered gradient parameters for the visual.
   *
   * @returns The triggered gradient parameters.
   */
  public get triggeredGradient(): GradientParameters {
    return this._rrStates.triggered.gradient
  }

  /**
   * Sets the triggered gradient parameters for the visual and initializes the visual states.
   *
   * @param gradient - The gradient parameters to be set for the triggered state.
   */
  public set triggeredGradient(gradient: GradientParameters) {
    if (gradient === undefined) {
      return
    }
    if (isEqual<GradientParameters>(this._rrStates.triggered.gradient, gradient)) {
      return
    }
    this._rrStates.triggered.gradient = gradient
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the toggled default gradient parameters for the visual.
   *
   * @returns The toggled default gradient parameters.
   */
  public get toggledDefaultGradient(): GradientParameters {
    return this._rrStates.toggledDefault.gradient
  }

  /**
   * Sets the toggled default gradient parameters for the visual and initializes the visual states.
   *
   * @param gradient - The gradient parameters to be set for the toggled default state.
   */
  public set toggledDefaultGradient(gradient: GradientParameters) {
    if (gradient === undefined) {
      return
    }
    if (isEqual<GradientParameters>(this._rrStates.toggledDefault.gradient, gradient)) {
      return
    }
    this._rrStates.toggledDefault.gradient = gradient
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the toggled hovered gradient parameters for the visual.
   *
   * @returns The toggled hovered gradient parameters.
   */
  public get toggledHoveredGradient(): GradientParameters {
    return this._rrStates.toggledHovered.gradient
  }

  /**
   * Sets the toggled hovered gradient parameters for the visual and initializes the visual states.
   *
   * @param toggledHoveredGradient - The gradient parameters to be set for the toggled hovered state.
   */
  public set toggledHoveredGradient(toggledHoveredGradient: GradientParameters) {
    if (toggledHoveredGradient === undefined) {
      return
    }
    if (isEqual<GradientParameters>(this._rrStates.toggledHovered.gradient, toggledHoveredGradient)) {
      return
    }
    this._rrStates.toggledHovered.gradient = toggledHoveredGradient
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the toggled triggered gradient parameters for the visual.
   *
   * @returns The toggled triggered gradient parameters.
   */
  public get toggledTriggeredGradient(): GradientParameters {
    return this._rrStates.toggledTriggered.gradient
  }

  /**
   * Sets the toggled triggered gradient parameters for the visual and initializes the visual states.
   *
   * @param gradient - The gradient parameters to be set for the toggled triggered state.
   */
  public set toggledTriggeredGradient(gradient: GradientParameters) {
    if (gradient === undefined) {
      return
    }
    if (isEqual<GradientParameters>(this._rrStates.toggledTriggered.gradient, gradient)) {
      return
    }
    this._rrStates.toggledTriggered.gradient = gradient
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the inactive gradient parameters for the visual.
   *
   * @returns The inactive gradient parameters.
   */
  public get inactiveGradient(): GradientParameters {
    return this._rrStates.inactive.gradient
  }

  /**
   * Sets the inactive gradient parameters for the visual and initializes the visual states.
   *
   * @param gradient - The gradient parameters to be set for the inactive state.
   */
  public set inactiveGradient(gradient: GradientParameters) {
    if (gradient === undefined) {
      return
    }
    if (isEqual<GradientParameters>(this._rrStates.inactive.gradient, gradient)) {
      return
    }
    this._rrStates.inactive.gradient = gradient
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Sets the gradient start and end positions for the base of the rounded rectangle.
   *
   * @param gradientStartPosition - A 2D vector representing the starting position of the gradient.
   * @param gradientEndPosition - A 2D vector representing the ending position of the gradient.
   */
  public setBaseGradientPositions(gradientStartPosition: vec2, gradientEndPosition: vec2) {
    this.currentGradient = {
      ...this.currentGradient,
      start: gradientStartPosition,
      end: gradientEndPosition
    }
    this.roundedRectangle.setBackgroundGradientPositions(gradientStartPosition, gradientEndPosition)
  }

  /**
   * Applies a background gradient immediately, bypassing state-transition animation.
   * The transient override remains active until refreshRoundedRectangleState() or destroy().
   * Gradient positions are restored to their pre-override values on refresh.
   */
  public applyBaseGradientNow(gradient: GradientParameters): void {
    if (gradient === undefined) {
      return
    }
    if (!this.baseTransientGradientOverrideActive) {
      this.baseTransientGradientOverrideActive = true
      this.captureBaseTransientGradientPositions()
      Motion.killTweensOf(this, "rr.gradient")
    }
    if (this.baseType !== "Gradient") {
      this.baseType = "Gradient"
    }
    this.currentGradient = gradient
    this.roundedRectangle.setBackgroundGradient(gradient)
  }

  /**
   * Gets the default texture for the rounded rectangle.
   *
   * @returns The default texture as a `Texture` value.
   */
  public get defaultTexture(): Texture {
    return this._rrStates.default.texture
  }

  /**
   * Sets the default texture for the rounded rectangle.
   *
   * @param texture - The texture to be set for the default state.
   */
  public set defaultTexture(texture: Texture) {
    if (texture === undefined) {
      return
    }
    if (this._rrStates.default.texture?.isSame(texture)) {
      return
    }
    this._rrStates.default.texture = texture
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the hovered texture for the rounded rectangle.
   *
   * @returns The hovered texture as a `Texture` value.
   */
  public get hoveredTexture(): Texture {
    return this._rrStates.hovered.texture
  }

  /**
   * Sets the hovered texture for the rounded rectangle.
   *
   * @param hoveredTexture - The texture to be set for the hovered state.
   */
  public set hoveredTexture(hoveredTexture: Texture) {
    if (hoveredTexture === undefined) {
      return
    }
    if (this._rrStates.hovered.texture?.isSame(hoveredTexture)) {
      return
    }
    this._rrStates.hovered.texture = hoveredTexture
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the triggered texture for the rounded rectangle.
   *
   * @returns The triggered texture as a `Texture` value.
   */
  public get triggeredTexture(): Texture {
    return this._rrStates.triggered.texture
  }

  /**
   * Sets the triggered texture for the rounded rectangle.
   *
   * @param texture - The texture to be set for the triggered state.
   */
  public set triggeredTexture(texture: Texture) {
    if (texture === undefined) {
      return
    }
    if (this._rrStates.triggered.texture?.isSame(texture)) {
      return
    }
    this._rrStates.triggered.texture = texture
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the inactive texture for the rounded rectangle.
   *
   * @returns The inactive texture as a `Texture` value.
   */
  public get inactiveTexture(): Texture {
    return this._rrStates.inactive.texture
  }

  /**
   * Sets the inactive texture for the rounded rectangle.
   *
   * @param texture - The texture to be set for the inactive state.
   */
  public set inactiveTexture(texture: Texture) {
    if (texture === undefined) {
      return
    }
    if (this._rrStates.inactive.texture?.isSame(texture)) {
      return
    }
    this._rrStates.inactive.texture = texture
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the toggled default texture for the rounded rectangle.
   *
   * @returns The toggled default texture as a `Texture` value.
   */
  public get toggledDefaultTexture(): Texture {
    return this._rrStates.toggledDefault.texture
  }

  /**
   * Sets the toggled default texture for the rounded rectangle.
   *
   * @param texture - The texture to be set for the toggled default state.
   */
  public set toggledDefaultTexture(texture: Texture) {
    if (texture === undefined) {
      return
    }
    if (this._rrStates.toggledDefault.texture?.isSame(texture)) {
      return
    }
    this._rrStates.toggledDefault.texture = texture
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the toggled hovered texture for the rounded rectangle.
   *
   * @returns The toggled hovered texture as a `Texture` value.
   */
  public get toggledHoveredTexture(): Texture {
    return this._rrStates.toggledHovered.texture
  }

  /**
   * Sets the toggled hovered texture for the rounded rectangle.
   *
   * @param toggledHoveredTexture - The texture to be set for the toggled hovered state.
   */
  public set toggledHoveredTexture(toggledHoveredTexture: Texture) {
    if (toggledHoveredTexture === undefined) {
      return
    }
    if (this._rrStates.toggledHovered.texture?.isSame(toggledHoveredTexture)) {
      return
    }
    this._rrStates.toggledHovered.texture = toggledHoveredTexture
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the toggled triggered texture for the rounded rectangle.
   *
   * @returns The toggled triggered texture as a `Texture` value.
   */
  public get toggledTriggeredTexture(): Texture {
    return this._rrStates.toggledTriggered.texture
  }

  /**
   * Sets the toggled triggered texture for the rounded rectangle.
   *
   * @param texture - The texture to be set for the toggled triggered state.
   */
  public set toggledTriggeredTexture(texture: Texture) {
    if (texture === undefined) {
      return
    }
    if (this._rrStates.toggledTriggered.texture?.isSame(texture)) {
      return
    }
    this._rrStates.toggledTriggered.texture = texture
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Whether the border uses a gradient (vs a solid color).
   *
   * @returns True if the border type is "Gradient", false otherwise.
   */
  public get isBorderGradient(): boolean {
    return this.roundedRectangle.borderType === "Gradient"
  }

  /**
   * Sets whether the rounded rectangle uses a gradient for its border.
   *
   * @param gradient - A boolean indicating whether to use a gradient (`true`) or a solid color (`false`) for the border.
   */
  public set isBorderGradient(gradient: boolean) {
    if (gradient === undefined) {
      return
    }
    this.roundedRectangle.borderType = gradient ? "Gradient" : "Color"
  }

  /**
   * Gets the default color for the border of the rounded rectangle.
   *
   * @returns The default border color as a `vec4` value.
   */
  public get borderDefaultColor(): vec4 {
    return this._rrStates.default.borderColor
  }

  /**
   * Sets the default color for the border of the rounded rectangle and initializes the visual states.
   *
   * @param color - The default color to be set for the border.
   */
  public set borderDefaultColor(color: vec4) {
    if (color === undefined) {
      return
    }
    if (isEqual<vec4>(this._rrStates.default.borderColor, color)) {
      return
    }
    this._rrStates.default.borderColor = color
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the hovered color for the border of the rounded rectangle.
   *
   * @returns The hovered border color as a `vec4` value.
   */
  public get borderHoveredColor(): vec4 {
    return this._rrStates.hovered.borderColor
  }

  /**
   * Sets the hovered color for the border of the rounded rectangle and initializes the visual states.
   *
   * @param borderHoveredColor - The hovered color to be set for the border.
   */
  public set borderHoveredColor(borderHoveredColor: vec4) {
    if (borderHoveredColor === undefined) {
      return
    }
    if (isEqual<vec4>(this._rrStates.hovered.borderColor, borderHoveredColor)) {
      return
    }
    this._rrStates.hovered.borderColor = borderHoveredColor
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the triggered color for the border of the rounded rectangle.
   *
   * @returns The triggered border color as a `vec4` value.
   */
  public get borderTriggeredColor(): vec4 {
    return this._rrStates.triggered.borderColor
  }

  /**
   * Sets the triggered color for the border of the rounded rectangle and initializes the visual states.
   *
   * @param color - The triggered color to be set for the border.
   */
  public set borderTriggeredColor(color: vec4) {
    if (color === undefined) {
      return
    }
    if (isEqual<vec4>(this._rrStates.triggered.borderColor, color)) {
      return
    }
    this._rrStates.triggered.borderColor = color
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the gradient parameters for the toggled default state of the border.
   */
  public get borderToggledDefaultGradient(): GradientParameters {
    return this._rrStates.toggledDefault.borderGradient
  }

  /**
   * Sets the gradient parameters for the toggled default state of the border
   */
  public set borderToggledDefaultGradient(gradient: GradientParameters) {
    if (gradient === undefined) {
      return
    }
    if (isEqual<GradientParameters>(this._rrStates.toggledDefault.borderGradient, gradient)) {
      return
    }
    this._rrStates.toggledDefault.borderGradient = gradient
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the gradient parameters for the toggled hovered state of the border.
   */
  public get borderToggledHoveredGradient(): GradientParameters {
    return this._rrStates.toggledHovered.borderGradient
  }

  /**
   * Sets the gradient parameters for the toggled hovered state of the border and initializes the visual states.
   */
  public set borderToggledHoveredGradient(borderToggledHoveredGradient: GradientParameters) {
    if (borderToggledHoveredGradient === undefined) {
      return
    }
    if (isEqual<GradientParameters>(this._rrStates.toggledHovered.borderGradient, borderToggledHoveredGradient)) {
      return
    }
    this._rrStates.toggledHovered.borderGradient = borderToggledHoveredGradient
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the gradient parameters for the toggled triggered state of the border.
   */
  public get borderToggledTriggeredGradient(): GradientParameters {
    return this._rrStates.toggledTriggered.borderGradient
  }

  /**
   * Sets the gradient parameters for the toggled triggered state of the border and initializes the visual states.
   */
  public set borderToggledTriggeredGradient(gradient: GradientParameters) {
    if (gradient === undefined) {
      return
    }
    if (isEqual<GradientParameters>(this._rrStates.toggledTriggered.borderGradient, gradient)) {
      return
    }
    this._rrStates.toggledTriggered.borderGradient = gradient
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the inactive color for the border of the rounded rectangle.
   *
   * @returns The inactive border color as a `vec4` value.
   */
  public get borderInactiveColor(): vec4 {
    return this._rrStates.inactive.borderColor
  }

  /**
   * Sets the inactive color for the border of the rounded rectangle and initializes the visual states.
   *
   * @param color - The inactive color to be set for the border.
   */
  public set borderInactiveColor(color: vec4) {
    if (color === undefined) {
      return
    }
    if (isEqual<vec4>(this._rrStates.inactive.borderColor, color)) {
      return
    }
    this._rrStates.inactive.borderColor = color
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the toggled default color for the border of the rounded rectangle.
   *
   * @returns The toggled default border color as a `vec4` value.
   */
  public get borderToggledDefaultColor(): vec4 {
    return this._rrStates.toggledDefault.borderColor
  }

  /**
   * Sets the toggled default color for the border of the rounded rectangle and initializes the visual states.
   *
   * @param color - The toggled default color to be set for the border.
   */
  public set borderToggledDefaultColor(color: vec4) {
    if (color === undefined) {
      return
    }
    if (isEqual<vec4>(this._rrStates.toggledDefault.borderColor, color)) {
      return
    }
    this._rrStates.toggledDefault.borderColor = color
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the toggled hovered color for the border of the rounded rectangle.
   *
   * @returns The toggled hovered border color as a `vec4` value.
   */
  public get borderToggledHoveredColor(): vec4 {
    return this._rrStates.toggledHovered.borderColor
  }

  /**
   * Sets the toggled hovered color for the border of the rounded rectangle and initializes the visual states.
   *
   * @param borderToggledHoveredColor - The toggled hovered color to be set for the border.
   */
  public set borderToggledHoveredColor(borderToggledHoveredColor: vec4) {
    if (borderToggledHoveredColor === undefined) {
      return
    }
    if (isEqual<vec4>(this._rrStates.toggledHovered.borderColor, borderToggledHoveredColor)) {
      return
    }
    this._rrStates.toggledHovered.borderColor = borderToggledHoveredColor
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the toggled triggered color for the border of the rounded rectangle.
   *
   * @returns The toggled triggered border color as a `vec4` value.
   */
  public get borderToggledTriggeredColor(): vec4 {
    return this._rrStates.toggledTriggered.borderColor
  }

  /**
   * Sets the toggled triggered color for the border of the rounded rectangle and initializes the visual states.
   *
   * @param color - The toggled triggered color to be set for the border.
   */
  public set borderToggledTriggeredColor(color: vec4) {
    if (color === undefined) {
      return
    }
    if (isEqual<vec4>(this._rrStates.toggledTriggered.borderColor, color)) {
      return
    }
    this._rrStates.toggledTriggered.borderColor = color
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the default gradient parameters for the border of the rounded rectangle.
   *
   * @returns The default border gradient parameters.
   */
  public get borderDefaultGradient(): GradientParameters {
    return this._rrStates.default.borderGradient
  }

  /**
   * Sets the gradient parameters for the default state of the border and initializes the visual states.
   *
   * @param gradient - The gradient parameters to be set for the default state of the border.
   */
  public set borderDefaultGradient(gradient: GradientParameters) {
    if (gradient === undefined) {
      return
    }
    if (isEqual<GradientParameters>(this._rrStates.default.borderGradient, gradient)) {
      return
    }
    this._rrStates.default.borderGradient = gradient
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the gradient parameters for the hovered state of the border.
   *
   * @returns The hovered border gradient parameters.
   */
  public get borderHoveredGradient(): GradientParameters {
    return this._rrStates.hovered.borderGradient
  }

  /**
   * Sets the gradient parameters for the hovered state of the border and initializes the visual states.
   *
   * @param borderHoveredGradient - The gradient parameters to be set for the hovered state of the border.
   */
  public set borderHoveredGradient(borderHoveredGradient: GradientParameters) {
    if (borderHoveredGradient === undefined) {
      return
    }
    if (isEqual<GradientParameters>(this._rrStates.hovered.borderGradient, borderHoveredGradient)) {
      return
    }
    this._rrStates.hovered.borderGradient = borderHoveredGradient
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the gradient parameters for the triggered state of the border.
   *
   * @returns The triggered border gradient parameters.
   */
  public get borderTriggeredGradient(): GradientParameters {
    return this._rrStates.triggered.borderGradient
  }

  /**
   * Sets the gradient parameters for the triggered state of the border and initializes the visual states.
   *
   * @param gradient - The gradient parameters to be set for the triggered state of the border.
   */
  public set borderTriggeredGradient(gradient: GradientParameters) {
    if (gradient === undefined) {
      return
    }
    if (isEqual<GradientParameters>(this._rrStates.triggered.borderGradient, gradient)) {
      return
    }
    this._rrStates.triggered.borderGradient = gradient
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the gradient parameters for the inactive state of the border.
   *
   * @returns The inactive border gradient parameters.
   */
  public get borderInactiveGradient(): GradientParameters {
    return this._rrStates.inactive.borderGradient
  }

  /**
   * Sets the gradient parameters for the inactive state of the border and initializes the visual states.
   *
   * @param gradient - The gradient parameters to be set for the inactive state of the border.
   */
  public set borderInactiveGradient(gradient: GradientParameters) {
    if (gradient === undefined) {
      return
    }
    if (isEqual<GradientParameters>(this._rrStates.inactive.borderGradient, gradient)) {
      return
    }
    this._rrStates.inactive.borderGradient = gradient
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Sets the start and end positions for the border gradient of the rounded rectangle.
   *
   * @param gradientStartPosition - A 2D vector representing the starting position of the border gradient.
   * @param gradientEndPosition - A 2D vector representing the ending position of the border gradient.
   */
  public setBorderGradientPositions(gradientStartPosition: vec2, gradientEndPosition: vec2): void {
    this.currentBorderGradient = {
      ...this.currentBorderGradient,
      start: gradientStartPosition,
      end: gradientEndPosition
    }
    this.roundedRectangle.setBorderGradientPositions(gradientStartPosition, gradientEndPosition)
  }

  /**
   * Applies a border gradient immediately, bypassing state-transition animation.
   * The transient override remains active until refreshRoundedRectangleState() or destroy().
   * Gradient positions are restored to their pre-override values on refresh.
   */
  public applyBorderGradientNow(gradient: GradientParameters): void {
    if (gradient === undefined) {
      return
    }
    if (!this.borderTransientGradientOverrideActive) {
      this.borderTransientGradientOverrideActive = true
      this.captureBorderTransientGradientPositions()
      Motion.killTweensOf(this, "rr.borderGradient")
    }
    if (!this._hasBorder) {
      this.updateHasBorder(true)
    }
    this.currentBorderGradient = gradient
    this.roundedRectangle.setBorderGradient(gradient)
  }

  /**
   * Gets the base type for the default state.
   *
   * @returns The base type for the default state.
   */
  public get defaultBaseType(): BaseType {
    return this._rrStates.default.baseType
  }

  /**
   * Sets the base type for the default state and initializes the visual states.
   *
   * @param baseType - The base type to be set for the default state.
   */
  public set defaultBaseType(baseType: BaseType) {
    if (baseType === undefined) {
      return
    }
    if (isEqual<BaseType>(this._rrStates.default.baseType, baseType)) {
      return
    }
    this._rrStates.default.baseType = baseType
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the base type for the hovered state.
   *
   * @returns The base type for the hovered state.
   */
  public get hoveredBaseType(): BaseType {
    return this._rrStates.hovered.baseType
  }

  /**
   * Sets the base type for the hovered state and initializes the visual states.
   *
   * @param hoveredBaseType - The base type to be set for the hovered state.
   */
  public set hoveredBaseType(hoveredBaseType: BaseType) {
    if (hoveredBaseType === undefined) {
      return
    }
    if (isEqual<BaseType>(this._rrStates.hovered.baseType, hoveredBaseType)) {
      return
    }
    this._rrStates.hovered.baseType = hoveredBaseType
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the base type for the triggered state.
   *
   * @returns The base type for the triggered state.
   */
  public get triggeredBaseType(): BaseType {
    return this._rrStates.triggered.baseType
  }

  /**
   * Sets the base type for the triggered state and initializes the visual states.
   *
   * @param baseType - The base type to be set for the triggered state.
   */
  public set triggeredBaseType(baseType: BaseType) {
    if (baseType === undefined) {
      return
    }
    if (isEqual<BaseType>(this._rrStates.triggered.baseType, baseType)) {
      return
    }
    this._rrStates.triggered.baseType = baseType
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the base type for the inactive state.
   *
   * @returns The base type for the inactive state.
   */
  public get inactiveBaseType(): BaseType {
    return this._rrStates.inactive.baseType
  }

  /**
   * Sets the base type for the inactive state and initializes the visual states.
   *
   * @param baseType - The base type to be set for the inactive state.
   */
  public set inactiveBaseType(baseType: BaseType) {
    if (baseType === undefined) {
      return
    }
    if (isEqual<BaseType>(this._rrStates.inactive.baseType, baseType)) {
      return
    }
    this._rrStates.inactive.baseType = baseType
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the base type for the toggled default state.
   *
   * @returns The base type for the toggled default state.
   */
  public get toggledDefaultBaseType(): BaseType {
    return this._rrStates.toggledDefault.baseType
  }

  /**
   * Sets the base type for the toggled default state and initializes the visual states.
   *
   * @param baseType - The base type to be set for the toggled default state.
   */
  public set toggledDefaultBaseType(baseType: BaseType) {
    if (baseType === undefined) {
      return
    }
    if (isEqual<BaseType>(this._rrStates.toggledDefault.baseType, baseType)) {
      return
    }
    this._rrStates.toggledDefault.baseType = baseType
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the base type for the toggled hovered state.
   *
   * @returns The base type for the toggled hovered state.
   */
  public get toggledHoveredBaseType(): BaseType {
    return this._rrStates.toggledHovered.baseType
  }

  /**
   * Sets the base type for the toggled hovered state and initializes the visual states.
   *
   * @param toggledHoveredBaseType - The base type to be set for the toggled hovered state.
   */
  public set toggledHoveredBaseType(toggledHoveredBaseType: BaseType) {
    if (toggledHoveredBaseType === undefined) {
      return
    }
    if (isEqual<BaseType>(this._rrStates.toggledHovered.baseType, toggledHoveredBaseType)) {
      return
    }
    this._rrStates.toggledHovered.baseType = toggledHoveredBaseType
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the base type for the toggled triggered state.
   *
   * @returns The base type for the toggled triggered state.
   */
  public get toggledTriggeredBaseType(): BaseType {
    return this._rrStates.toggledTriggered.baseType
  }

  /**
   * Sets the base type for the toggled triggered state and initializes the visual states.
   *
   * @param baseType - The base type to be set for the toggled triggered state.
   */
  public set toggledTriggeredBaseType(baseType: BaseType) {
    if (baseType === undefined) {
      return
    }
    if (isEqual<BaseType>(this._rrStates.toggledTriggered.baseType, baseType)) {
      return
    }
    this._rrStates.toggledTriggered.baseType = baseType
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets whether the default state has a border.
   *
   * @returns `true` if the default state has a border; otherwise, `false`.
   */
  public get defaultHasBorder(): boolean {
    return this._rrStates.default.hasBorder
  }

  /**
   * Sets whether the default state has a border and initializes the visual states.
   *
   * @param hasBorder - A boolean indicating whether the default state should have a border.
   */
  public set defaultHasBorder(hasBorder: boolean) {
    if (hasBorder === undefined) {
      return
    }
    if (isEqual<boolean>(this._rrStates.default.hasBorder, hasBorder)) {
      return
    }
    this._rrStates.default.hasBorder = hasBorder
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets whether the hovered state has a border.
   *
   * @returns `true` if the hovered state has a border; otherwise, `false`.
   */
  public get hoveredHasBorder(): boolean {
    return this._rrStates.hovered.hasBorder
  }

  /**
   * Sets whether the hovered state has a border and initializes the visual states.
   *
   * @param hoveredHasBorder - A boolean indicating whether the hovered state should have a border.
   */
  public set hoveredHasBorder(hoveredHasBorder: boolean) {
    if (hoveredHasBorder === undefined) {
      return
    }
    if (isEqual<boolean>(this._rrStates.hovered.hasBorder, hoveredHasBorder)) {
      return
    }
    this._rrStates.hovered.hasBorder = hoveredHasBorder
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets whether the triggered state has a border.
   *
   * @returns `true` if the triggered state has a border; otherwise, `false`.
   */
  public get triggeredHasBorder(): boolean {
    return this._rrStates.triggered.hasBorder
  }

  /**
   * Sets whether the triggered state has a border and initializes the visual states.
   *
   * @param hasBorder - A boolean indicating whether the triggered state should have a border.
   */
  public set triggeredHasBorder(hasBorder: boolean) {
    if (hasBorder === undefined) {
      return
    }
    if (isEqual<boolean>(this._rrStates.triggered.hasBorder, hasBorder)) {
      return
    }
    this._rrStates.triggered.hasBorder = hasBorder
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets whether the inactive state has a border.
   *
   * @returns `true` if the inactive state has a border; otherwise, `false`.
   */
  public get inactiveHasBorder(): boolean {
    return this._rrStates.inactive.hasBorder
  }

  /**
   * Sets whether the inactive state has a border and initializes the visual states.
   *
   * @param hasBorder - A boolean indicating whether the inactive state should have a border.
   */
  public set inactiveHasBorder(hasBorder: boolean) {
    if (hasBorder === undefined) {
      return
    }
    if (isEqual<boolean>(this._rrStates.inactive.hasBorder, hasBorder)) {
      return
    }
    this._rrStates.inactive.hasBorder = hasBorder
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets whether the toggled default state has a border.
   *
   * @returns `true` if the toggled default state has a border; otherwise, `false`.
   */
  public get toggledDefaultHasBorder(): boolean {
    return this._rrStates.toggledDefault.hasBorder
  }

  /**
   * Sets whether the toggled default state has a border and initializes the visual states.
   *
   * @param hasBorder - A boolean indicating whether the toggled default state should have a border.
   */
  public set toggledDefaultHasBorder(hasBorder: boolean) {
    if (hasBorder === undefined) {
      return
    }
    if (isEqual<boolean>(this._rrStates.toggledDefault.hasBorder, hasBorder)) {
      return
    }
    this._rrStates.toggledDefault.hasBorder = hasBorder
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets whether the toggled hovered state has a border.
   *
   * @returns `true` if the toggled hovered state has a border; otherwise, `false`.
   */
  public get toggledHoveredHasBorder(): boolean {
    return this._rrStates.toggledHovered.hasBorder
  }

  /**
   * Sets whether the toggled hovered state has a border and initializes the visual states.
   *
   * @param toggledHoveredHasBorder - A boolean indicating whether the toggled hovered state should have a border.
   */
  public set toggledHoveredHasBorder(toggledHoveredHasBorder: boolean) {
    if (toggledHoveredHasBorder === undefined) {
      return
    }
    if (isEqual<boolean>(this._rrStates.toggledHovered.hasBorder, toggledHoveredHasBorder)) {
      return
    }
    this._rrStates.toggledHovered.hasBorder = toggledHoveredHasBorder
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets whether the toggled triggered state has a border.
   *
   * @returns `true` if the toggled triggered state has a border; otherwise, `false`.
   */
  public get toggledTriggeredHasBorder(): boolean {
    return this._rrStates.toggledTriggered.hasBorder
  }

  /**
   * Sets whether the toggled triggered state has a border and initializes the visual states.
   *
   * @param hasBorder - A boolean indicating whether the toggled triggered state should have a border.
   */
  public set toggledTriggeredHasBorder(hasBorder: boolean) {
    if (hasBorder === undefined) {
      return
    }
    if (isEqual<boolean>(this._rrStates.toggledTriggered.hasBorder, hasBorder)) {
      return
    }
    this._rrStates.toggledTriggered.hasBorder = hasBorder
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the border type for the default state.
   *
   * @returns The border type for the default state.
   */
  public get defaultBorderType(): BorderType {
    return this._rrStates.default.borderType
  }

  /**
   * Sets the border type for the default state and initializes the visual states.
   *
   * @param borderType - The border type to be set for the default state.
   */
  public set defaultBorderType(borderType: BorderType) {
    if (borderType === undefined) {
      return
    }
    if (isEqual<BorderType>(this._rrStates.default.borderType, borderType)) {
      return
    }
    this._rrStates.default.borderType = borderType
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the border type for the hovered state.
   *
   * @returns The border type for the hovered state.
   */
  public get hoveredBorderType(): BorderType {
    return this._rrStates.hovered.borderType
  }

  /**
   * Sets the border type for the hovered state and initializes the visual states.
   *
   * @param hoveredBorderType - The border type to be set for the hovered state.
   */
  public set hoveredBorderType(hoveredBorderType: BorderType) {
    if (hoveredBorderType === undefined) {
      return
    }
    if (isEqual<BorderType>(this._rrStates.hovered.borderType, hoveredBorderType)) {
      return
    }
    this._rrStates.hovered.borderType = hoveredBorderType
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the border type for the triggered state.
   *
   * @returns The border type for the triggered state.
   */
  public get triggeredBorderType(): BorderType {
    return this._rrStates.triggered.borderType
  }

  /**
   * Sets the border type for the triggered state and initializes the visual states.
   *
   * @param borderType - The border type to be set for the triggered state.
   */
  public set triggeredBorderType(borderType: BorderType) {
    if (borderType === undefined) {
      return
    }
    if (isEqual<BorderType>(this._rrStates.triggered.borderType, borderType)) {
      return
    }
    this._rrStates.triggered.borderType = borderType
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the border type for the inactive state.
   *
   * @returns The border type for the inactive state.
   */
  public get inactiveBorderType(): BorderType {
    return this._rrStates.inactive.borderType
  }

  /**
   * Sets the border type for the inactive state and initializes the visual states.
   *
   * @param borderType - The border type to be set for the inactive state.
   */
  public set inactiveBorderType(borderType: BorderType) {
    if (borderType === undefined) {
      return
    }
    if (isEqual<BorderType>(this._rrStates.inactive.borderType, borderType)) {
      return
    }
    this._rrStates.inactive.borderType = borderType
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the border type for the toggled default state.
   *
   * @returns The border type for the toggled default state.
   */
  public get toggledDefaultBorderType(): BorderType {
    return this._rrStates.toggledDefault.borderType
  }

  /**
   * Sets the border type for the toggled default state and initializes the visual states.
   *
   * @param borderType - The border type to be set for the toggled default state.
   */
  public set toggledDefaultBorderType(borderType: BorderType) {
    if (borderType === undefined) {
      return
    }
    if (isEqual<BorderType>(this._rrStates.toggledDefault.borderType, borderType)) {
      return
    }
    this._rrStates.toggledDefault.borderType = borderType
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the border type for the toggled hovered state.
   *
   * @returns The border type for the toggled hovered state.
   */
  public get toggledHoveredBorderType(): BorderType {
    return this._rrStates.toggledHovered.borderType
  }

  /**
   * Sets the border type for the toggled hovered state and initializes the visual states.
   *
   * @param toggledHoveredBorderType - The border type to be set for the toggled hovered state.
   */
  public set toggledHoveredBorderType(toggledHoveredBorderType: BorderType) {
    if (toggledHoveredBorderType === undefined) {
      return
    }
    if (isEqual<BorderType>(this._rrStates.toggledHovered.borderType, toggledHoveredBorderType)) {
      return
    }
    this._rrStates.toggledHovered.borderType = toggledHoveredBorderType
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the border type for the toggled triggered state.
   *
   * @returns The border type for the toggled triggered state.
   */
  public get toggledTriggeredBorderType(): BorderType {
    return this._rrStates.toggledTriggered.borderType
  }

  /**
   * Sets the border type for the toggled triggered state and initializes the visual states.
   *
   * @param borderType - The border type to be set for the toggled triggered state.
   */
  public set toggledTriggeredBorderType(borderType: BorderType) {
    if (borderType === undefined) {
      return
    }
    if (isEqual<BorderType>(this._rrStates.toggledTriggered.borderType, borderType)) {
      return
    }
    this._rrStates.toggledTriggered.borderType = borderType
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the border size for the default state.
   *
   * @returns The border size for the default state.
   */
  public get defaultBorderSize(): number {
    return this._rrStates.default.borderSize
  }

  /**
   * Sets the border size for the default state and initializes the visual states.
   *
   * @param borderSize - The border size to be set for the default state.
   */
  public set defaultBorderSize(borderSize: number) {
    if (borderSize === undefined) {
      return
    }
    if (isEqual<number>(this._rrStates.default.borderSize, borderSize)) {
      return
    }
    this._rrStates.default.borderSize = borderSize
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the border size for the hovered state.
   *
   * @returns The border size for the hovered state.
   */
  public get hoveredBorderSize(): number {
    return this._rrStates.hovered.borderSize
  }

  /**
   * Sets the border size for the hovered state and initializes the visual states.
   *
   * @param hoveredBorderSize - The border size to be set for the hovered state.
   */
  public set hoveredBorderSize(hoveredBorderSize: number) {
    if (hoveredBorderSize === undefined) {
      return
    }
    if (isEqual<number>(this._rrStates.hovered.borderSize, hoveredBorderSize)) {
      return
    }
    this._rrStates.hovered.borderSize = hoveredBorderSize
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the border size for the triggered state.
   *
   * @returns The border size for the triggered state.
   */
  public get triggeredBorderSize(): number {
    return this._rrStates.triggered.borderSize
  }

  /**
   * Sets the border size for the triggered state and initializes the visual states.
   *
   * @param borderSize - The border size to be set for the triggered state.
   */
  public set triggeredBorderSize(borderSize: number) {
    if (borderSize === undefined) {
      return
    }
    if (isEqual<number>(this._rrStates.triggered.borderSize, borderSize)) {
      return
    }
    this._rrStates.triggered.borderSize = borderSize
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the border size for the inactive state.
   *
   * @returns The border size for the inactive state.
   */
  public get inactiveBorderSize(): number {
    return this._rrStates.inactive.borderSize
  }

  /**
   * Sets the border size for the inactive state and initializes the visual states.
   *
   * @param borderSize - The border size to be set for the inactive state.
   */
  public set inactiveBorderSize(borderSize: number) {
    if (borderSize === undefined) {
      return
    }
    if (isEqual<number>(this._rrStates.inactive.borderSize, borderSize)) {
      return
    }
    this._rrStates.inactive.borderSize = borderSize
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the border size for the toggled default state.
   *
   * @returns The border size for the toggled default state.
   */
  public get toggledDefaultBorderSize(): number {
    return this._rrStates.toggledDefault.borderSize
  }

  /**
   * Sets the border size for the toggled default state and initializes the visual states.
   *
   * @param borderSize - The border size to be set for the toggled default state.
   */
  public set toggledDefaultBorderSize(borderSize: number) {
    if (borderSize === undefined) {
      return
    }
    if (isEqual<number>(this._rrStates.toggledDefault.borderSize, borderSize)) {
      return
    }
    this._rrStates.toggledDefault.borderSize = borderSize
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the border size for the toggled hovered state.
   *
   * @returns The border size for the toggled hovered state.
   */
  public get toggledHoveredBorderSize(): number {
    return this._rrStates.toggledHovered.borderSize
  }

  /**
   * Sets the border size for the toggled hovered state and initializes the visual states.
   *
   * @param toggledHoveredBorderSize - The border size to be set for the toggled hovered state.
   */
  public set toggledHoveredBorderSize(toggledHoveredBorderSize: number) {
    if (toggledHoveredBorderSize === undefined) {
      return
    }
    if (isEqual<number>(this._rrStates.toggledHovered.borderSize, toggledHoveredBorderSize)) {
      return
    }
    this._rrStates.toggledHovered.borderSize = toggledHoveredBorderSize
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  /**
   * Gets the border size for the toggled triggered state.
   *
   * @returns The border size for the toggled triggered state.
   */
  public get toggledTriggeredBorderSize(): number {
    return this._rrStates.toggledTriggered.borderSize
  }

  /**
   * Sets the border size for the toggled triggered state and initializes the visual states.
   *
   * @param borderSize - The border size to be set for the toggled triggered state.
   */
  public set toggledTriggeredBorderSize(borderSize: number) {
    if (borderSize === undefined) {
      return
    }
    if (isEqual<number>(this._rrStates.toggledTriggered.borderSize, borderSize)) {
      return
    }
    this._rrStates.toggledTriggered.borderSize = borderSize
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  protected updateGradient(gradient: GradientParameters) {
    if (this.baseTransientGradientOverrideActive || !this.shouldColorChange || this.baseType !== "Gradient") {
      return
    }
    // First apply or animation disabled: snap before identity/distance checks.
    if (!this.prevState || this.animateDuration <= 0) {
      Motion.killTweensOf(this, "rr.gradient")
      this.currentGradient = gradient
      this.roundedRectangle.setBackgroundGradient(gradient)
      return
    }
    if (gradient === this.currentGradient) {
      // Reference equality only holds when nothing has ticked since the last
      // settle (the channel write replaces currentGradient every frame), so
      // this is the SAME-FRAME A→B→A case: B's tween is created but hasn't
      // ticked — kill it and land on A exactly. A mid-flight A→B→A misses
      // this branch and tweens back smoothly from the intermediate value.
      Motion.killTweensOf(this, "rr.gradient")
      this.roundedRectangle.setBackgroundGradient(gradient)
      return
    }
    const initialGradient = this.currentGradient
    const remaining = GradientParameters.distance(gradient, initialGradient)
    if (remaining <= 1e-6) {
      // Already within 1e-6 of the target: push the exact target so the pass
      // lands on it, not the last animation frame.
      Motion.killTweensOf(this, "rr.gradient")
      this.currentGradient = gradient
      this.roundedRectangle.setBackgroundGradient(gradient)
      return
    }
    const full = this.prevState?.baseGradient
      ? GradientParameters.distance(gradient, this.prevState.baseGradient)
      : remaining

    const ratio = full > 1e-6 ? Math.min(Math.max(remaining / full, 0), 1) : 0
    this._gradientTransition = {from: initialGradient, to: gradient}
    animateState({
      intent: "state.rr.gradient",
      target: this,
      channel: this._gradientChannel,
      from: 0,
      value: 1,
      duration: ratio * this.animateDuration,
      ease: linear,
      onFinish: (forward: boolean) => {
        if (forward) {
          // Land on the exact target, not the last lerped frame.
          this.currentGradient = gradient
          this.roundedRectangle.setBackgroundGradient(gradient)
        }
      }
    })
  }

  private forceRestoreBaseGradient(gradient: GradientParameters): void {
    if (gradient === undefined || this.baseType !== "Gradient") {
      return
    }

    Motion.killTweensOf(this, "rr.gradient")
    this.currentGradient = gradient
    this.roundedRectangle.setBackgroundGradient(this.currentGradient)
  }

  protected updateBaseTexture(texture: Texture) {
    if (this.baseType !== "Texture") {
      return
    }
    this.roundedRectangle.texture = texture
  }

  protected updateBorderColors(borderColor: vec4) {
    if (!this.hasBorder || this.isBorderGradient) {
      return
    }
    // First apply (no prevState) or animation disabled: snap, don't fade in.
    if (!this.prevState || this.animateDuration <= 0) {
      Motion.killTweensOf(this, "rr.borderColor")
      this.roundedRectangle.borderColor = borderColor
      return
    }
    const live = this.roundedRectangle.borderColor
    const remaining = colorDistance(borderColor, live)
    const full = this.prevState?.borderColor ? colorDistance(borderColor, this.prevState.borderColor) : remaining
    const ratio = full > 1e-6 ? Math.min(Math.max(remaining / full, 0), 1) : 0
    this._borderColorTransition = {
      from: new vec4(live.x, live.y, live.z, live.w),
      to: new vec4(borderColor.x, borderColor.y, borderColor.z, borderColor.w)
    }
    animateState({
      intent: "state.rr.borderColor",
      target: this,
      channel: this._borderColorChannel,
      from: 0,
      value: 1,
      duration: ratio * this.animateDuration,
      ease: linear,
      onFinish: (forward: boolean) => {
        if (forward) {
          // Land on the exact target, not the last lerped frame.
          this.roundedRectangle.borderColor = borderColor
        }
      }
    })
  }

  protected updateBorderGradient(gradient: GradientParameters) {
    if (this.borderTransientGradientOverrideActive || !this.hasBorder || !this.isBorderGradient) {
      return
    }
    // First apply or animation disabled: snap before identity/distance checks.
    if (!this.prevState || this.animateDuration <= 0) {
      Motion.killTweensOf(this, "rr.borderGradient")
      this.currentBorderGradient = gradient
      this.roundedRectangle.setBorderGradient(gradient)
      return
    }
    if (gradient === this.currentBorderGradient) {
      // Same same-frame A→B→A guard as updateGradient above (mid-flight
      // interrupts miss this branch and tween back smoothly).
      Motion.killTweensOf(this, "rr.borderGradient")
      this.roundedRectangle.setBorderGradient(gradient)
      return
    }
    const initialGradient = this.currentBorderGradient
    const remaining = GradientParameters.distance(gradient, initialGradient)
    if (remaining <= 1e-6) {
      // Already within 1e-6 of the target: push the exact target so the pass
      // lands on it, not the last animation frame.
      Motion.killTweensOf(this, "rr.borderGradient")
      this.currentBorderGradient = gradient
      this.roundedRectangle.setBorderGradient(gradient)
      return
    }
    const full = this.prevState?.borderGradient
      ? GradientParameters.distance(gradient, this.prevState.borderGradient)
      : remaining

    const ratio = full > 1e-6 ? Math.min(Math.max(remaining / full, 0), 1) : 0
    this._borderGradientTransition = {from: initialGradient, to: gradient}
    animateState({
      intent: "state.rr.borderGradient",
      target: this,
      channel: this._borderGradientChannel,
      from: 0,
      value: 1,
      duration: ratio * this.animateDuration,
      ease: linear,
      onFinish: (forward: boolean) => {
        if (forward) {
          // Land on the exact target, not the last lerped frame.
          this.currentBorderGradient = gradient
          this.roundedRectangle.setBorderGradient(gradient)
        }
      }
    })
  }

  private forceRestoreBorderGradient(gradient: GradientParameters): void {
    if (gradient === undefined || !this.hasBorder || !this.isBorderGradient) {
      return
    }

    Motion.killTweensOf(this, "rr.borderGradient")
    this.currentBorderGradient = gradient
    this.roundedRectangle.setBorderGradient(this.currentBorderGradient)
  }

  protected updateBorderSize(borderSize: number) {
    if (!this.hasBorder || borderSize === undefined) {
      return
    }
    if (this.roundedRectangle.borderSize === borderSize) {
      Motion.killTweensOf(this, "rr.borderSize")
      return
    }
    // Snap on the first state application (no prior state) or when animation is
    // off; otherwise tween so border-thickness changes don't pop.
    if (!this.prevState || this.animateDuration <= 0) {
      Motion.killTweensOf(this, "rr.borderSize")
      this.roundedRectangle.borderSize = borderSize
      return
    }
    animateState({
      intent: "state.rr.borderSize",
      target: this,
      channel: this._borderSizeChannel,
      value: borderSize,
      duration: BORDER_SIZE_FADE_DURATION,
      ease: linear
    })
  }

  protected updateHasBorder(hasBorder: boolean) {
    if (hasBorder === undefined) {
      return
    }
    this._hasBorder = hasBorder
    if (this.initialized) {
      this.roundedRectangle.border = hasBorder
    }
  }

  /**
   * Re-applies the current visual state's rounded-rectangle styling.
   * This restores state-owned gradients after transient direct overrides.
   *
   * @param preserveBorderOverride - When true, the BORDER channel is left
   * untouched: an active border transient override (applyBorderGradientNow)
   * stays active and the state's border/hasBorder/borderSize are not
   * re-applied. Use when a separate animator owns the border (e.g. the
   * VoiceInputButton border light) and only the base should snap back to
   * its state style. The border owner performs its own full refresh when
   * it finishes.
   */
  public refreshRoundedRectangleState(preserveBorderOverride: boolean = false): void {
    if (!this._state) {
      return
    }

    const shouldForceRestoreBaseGradient = this.baseTransientGradientOverrideActive
    const shouldForceRestoreBorderGradient = !preserveBorderOverride && this.borderTransientGradientOverrideActive
    this.baseTransientGradientOverrideActive = false
    this.restoreBaseTransientGradientPositions()
    if (!preserveBorderOverride) {
      this.borderTransientGradientOverrideActive = false
      this.restoreBorderTransientGradientPositions()
    }
    this.applyRoundedRectangleState(true, shouldForceRestoreBaseGradient, shouldForceRestoreBorderGradient)
  }

  /**
   * Prints the configuration of the rounded rectangle visual to the console.
   */
  public printConfig(): void {
    this.roundedRectangle.printConfig()
  }

  private resolveStyleValue<T>(stateValue: T | undefined, defaultValue: T | undefined): T | undefined {
    return stateValue !== undefined ? stateValue : defaultValue
  }

  private applyRoundedRectangleStyleState(
    target: RoundedRectangleStoredState,
    stateParams: RoundedRectangleVisualState | undefined,
    defaultParams: RoundedRectangleVisualState | undefined
  ): void {
    const baseType = this.resolveStyleValue<BaseType>(stateParams?.baseType, defaultParams?.baseType)
    if (baseType !== undefined) target.baseType = baseType

    const gradient = this.resolveStyleValue<GradientParameters>(stateParams?.baseGradient, defaultParams?.baseGradient)
    if (gradient !== undefined) target.gradient = gradient

    const texture = this.resolveStyleValue<Texture>(stateParams?.baseTexture, defaultParams?.baseTexture)
    if (texture !== undefined) target.texture = texture

    const hasBorder = this.resolveStyleValue<boolean>(stateParams?.hasBorder, defaultParams?.hasBorder)
    if (hasBorder !== undefined) target.hasBorder = hasBorder

    const borderType = this.resolveStyleValue<BorderType>(stateParams?.borderType, defaultParams?.borderType)
    if (borderType !== undefined) target.borderType = borderType

    const borderSize = this.resolveStyleValue<number>(stateParams?.borderSize, defaultParams?.borderSize)
    if (borderSize !== undefined) target.borderSize = borderSize

    const borderColor = this.resolveStyleValue<vec4>(stateParams?.borderColor, defaultParams?.borderColor)
    if (borderColor !== undefined) target.borderColor = borderColor

    const borderGradient = this.resolveStyleValue<GradientParameters>(
      stateParams?.borderGradient,
      defaultParams?.borderGradient
    )
    if (borderGradient !== undefined) target.borderGradient = borderGradient
  }

  private applyRoundedRectangleStyleParameters(parameters: Partial<RoundedRectangleVisualParameters>): void {
    const defaultParams = parameters.default
    this.applyRoundedRectangleStyleState(this._rrStates.default, parameters.default, defaultParams)
    this.applyRoundedRectangleStyleState(this._rrStates.hovered, parameters.hovered, defaultParams)
    this.applyRoundedRectangleStyleState(this._rrStates.triggered, parameters.triggered, defaultParams)
    this.applyRoundedRectangleStyleState(this._rrStates.inactive, parameters.inactive, defaultParams)
    this.applyRoundedRectangleStyleState(this._rrStates.toggledDefault, parameters.toggledDefault, defaultParams)
    this.applyRoundedRectangleStyleState(this._rrStates.toggledHovered, parameters.toggledHovered, defaultParams)
    this.applyRoundedRectangleStyleState(this._rrStates.toggledTriggered, parameters.toggledTriggered, defaultParams)

    const borderSoftness = defaultParams?.borderSoftness
    if (borderSoftness !== undefined) {
      this.roundedRectangle.borderSoftness = borderSoftness
    }

    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  protected applyStyleParameters(parameters: Partial<RoundedRectangleVisualParameters>) {
    super.applyStyleParameters(parameters)
    this.applyRoundedRectangleStyleParameters(parameters)
  }

  /**
   * Resolves the per-state RoundedRectangleVisualState from its base (color/scale/
   * position) and rounded-rectangle (fill/border) source states, mutating the stored
   * object in place (no per-rebuild allocation). `shouldState` / `borderColor` /
   * `localScale` default to `baseState` / `rrState` but are overridden for the error
   * states, which mix sources. Returns true only when the currently-applied state's
   * resolved values changed.
   */
  private setRoundedRectangleVisualState(
    stateName: StateName,
    baseState: BaseVisualStateSource,
    rrState: RoundedRectangleStoredState,
    shouldState: BaseVisualStateSource = baseState,
    borderColor: vec4 = rrState.borderColor,
    localScale: vec3 = baseState.scale
  ): boolean {
    const stored = this._roundedRectangleVisualStates.get(stateName)
    if (stored === undefined) {
      this._roundedRectangleVisualStates.set(stateName, {
        baseColor: baseState.color,
        baseType: rrState.baseType,
        baseGradient: rrState.gradient,
        baseTexture: rrState.texture,
        hasBorder: rrState.hasBorder,
        borderType: rrState.borderType,
        borderColor: borderColor,
        borderGradient: rrState.borderGradient,
        borderSize: rrState.borderSize,
        shouldPosition: shouldState.shouldPosition,
        shouldScale: shouldState.shouldScale,
        localScale: localScale,
        localPosition: baseState.position
      })
      return false
    }
    const changed =
      stored.baseColor !== baseState.color ||
      stored.baseType !== rrState.baseType ||
      stored.baseGradient !== rrState.gradient ||
      stored.baseTexture !== rrState.texture ||
      stored.hasBorder !== rrState.hasBorder ||
      stored.borderType !== rrState.borderType ||
      stored.borderColor !== borderColor ||
      stored.borderGradient !== rrState.borderGradient ||
      stored.borderSize !== rrState.borderSize ||
      stored.shouldPosition !== shouldState.shouldPosition ||
      stored.shouldScale !== shouldState.shouldScale ||
      stored.localScale !== localScale ||
      stored.localPosition !== baseState.position
    if (!changed) {
      return false
    }
    stored.baseColor = baseState.color
    stored.baseType = rrState.baseType
    stored.baseGradient = rrState.gradient
    stored.baseTexture = rrState.texture
    stored.hasBorder = rrState.hasBorder
    stored.borderType = rrState.borderType
    stored.borderColor = borderColor
    stored.borderGradient = rrState.borderGradient
    stored.borderSize = rrState.borderSize
    stored.shouldPosition = shouldState.shouldPosition
    stored.shouldScale = shouldState.shouldScale
    stored.localScale = localScale
    stored.localPosition = baseState.position
    return stored === this._state
  }

  protected updateVisualStates(): void {
    const baseStates = this._states
    const rrStates = this._rrStates
    // `|| currentStateChanged` keeps a prior true while still evaluating every call
    // (the call has the side effect of (re)building the stored state — don't short it).
    let currentStateChanged = false
    currentStateChanged =
      this.setRoundedRectangleVisualState(StateName.default, baseStates.default, rrStates.default) ||
      currentStateChanged
    currentStateChanged =
      this.setRoundedRectangleVisualState(StateName.hovered, baseStates.hovered, rrStates.hovered) ||
      currentStateChanged
    currentStateChanged =
      this.setRoundedRectangleVisualState(StateName.triggered, baseStates.triggered, rrStates.triggered) ||
      currentStateChanged
    currentStateChanged =
      this.setRoundedRectangleVisualState(
        StateName.toggledHovered,
        baseStates.toggledHovered,
        rrStates.toggledHovered
      ) || currentStateChanged
    currentStateChanged =
      this.setRoundedRectangleVisualState(
        StateName.toggledDefault,
        baseStates.toggledDefault,
        rrStates.toggledDefault
      ) || currentStateChanged
    currentStateChanged =
      this.setRoundedRectangleVisualState(
        StateName.toggledTriggered,
        baseStates.toggledTriggered,
        rrStates.toggledTriggered
      ) || currentStateChanged
    // error / errorHovered mix sources: base color/position from `error`, fill+border
    // config and should* from default/hovered, and border color forced to the error color.
    currentStateChanged =
      this.setRoundedRectangleVisualState(
        StateName.error,
        baseStates.error,
        rrStates.default,
        baseStates.default,
        baseStates.error.color
      ) || currentStateChanged
    currentStateChanged =
      this.setRoundedRectangleVisualState(
        StateName.errorHovered,
        baseStates.error,
        rrStates.hovered,
        baseStates.hovered,
        baseStates.error.color,
        baseStates.hovered.scale
      ) || currentStateChanged
    currentStateChanged =
      this.setRoundedRectangleVisualState(StateName.inactive, baseStates.inactive, rrStates.inactive) ||
      currentStateChanged

    const currentState = this._state
    const nextState = this._roundedRectangleVisualStates.get(this.stateName)
    if (currentState !== nextState) {
      this.setState(this.stateName)
    } else if (this.initialized && currentStateChanged) {
      this.applyCurrentVisualState()
      this.applyRoundedRectangleState()
    }
  }

  private get roundedRectangle(): BaseRoundedRectangle {
    return this._baseRoundedRectangle
  }
}

/**
 * Applies a corner radius to a control's visual when it is a rounded
 * rectangle, skipping redundant writes. The composite components derive
 * their radii from row heights, so this runs both at build time and from
 * layout after a resize. Non-rounded-rect visuals (e.g. the prism styles'
 * BeveledPrismVisual) are deliberately left alone — they own their own
 * radius.
 */
export function applyVisualCornerRadius(visual: unknown, cornerRadius: number): void {
  if (visual instanceof RoundedRectangleVisual && visual.cornerRadius !== cornerRadius) {
    visual.cornerRadius = cornerRadius
  }
}

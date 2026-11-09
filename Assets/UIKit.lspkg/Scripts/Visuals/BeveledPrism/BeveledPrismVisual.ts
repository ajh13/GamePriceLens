// @module BeveledPrism/BeveledPrismVisual — DO NOT REMOVE: prevents Lens Studio module collision
import {Interactor, InteractorInputType} from "InteractionKit.lspkg/Core/Interactor/Interactor"
import {InteractorEvent} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import {HandInputData} from "InteractionKit.lspkg/Providers/HandInputData/HandInputData"
import TrackedHand from "InteractionKit.lspkg/Providers/HandInputData/TrackedHand"
import {easingFunctions} from "InteractionKit.lspkg/Utils/animate"
import * as MotionChannels from "Motion.lspkg/Channels"
import {linear, power2, power3} from "Motion.lspkg/Eases"
import {Motion} from "Motion.lspkg/Motion"
import {StateName} from "../../Components/Element"
import {animateState} from "../../Motion/StateMotion"
import {
  PRISM_ACTIVE_COLORS,
  PRISM_HOVER_COLORS,
  PRISM_IDLE_COLORS,
  PRISM_SELECTED_COLORS,
  PrismStateColors as SharedPrismStateColors
} from "../../Themes/System-3.0/Gradients/PrismPalette"
import {colorLerp} from "../../Utility/UIKitUtilities"
import {Visual, VisualArgs, VisualParameters, VisualState} from "../Visual"
import {BeveledPrism} from "./BeveledPrism"

export {PRISM_ACTIVE_COLORS, PRISM_HOVER_COLORS, PRISM_IDLE_COLORS}
export type PrismStateColors = SharedPrismStateColors

// Spin rate of the bevel-edge highlight band, degrees/second.
const EDGE_HIGHLIGHT_SPIN_DEG_PER_SEC = 180

// Easing for the prism's motion tweens: the hover pop (extrusion /
// bodyDepthScale, which compose into the same frontExtrusion shader uniform)
// and the per-state position/scale offsets (via Visual.motionEasing). Fast
// start, gentle settle — and because ease-out starts at full speed, a tween
// re-targeted mid-flight (quick hover exit) picks up without a hesitation.
const MOTION_EASING = "ease-out-cubic"

// Multiplier on animateDuration for the pop-forward tweens ONLY (extrusion +
// bodyDepthScale — the two that compose into the frontExtrusion uniform).
// 1 = the base 200 ms; 3 ≈ 600 ms full pop. Colors / opacity / matcap /
// position / scale keep the base duration.
const POP_DURATION_SCALE = 3

// Multiplier on animateDuration for the bevel spin (matcapRotation) tween.
// The spin travels 4.5x further than it originally did (-90/-135 deg
// states), so it gets a long slow glide: 6 = ~1.2 s full spin at the
// 200 ms base.
const SPIN_DURATION_SCALE = 6

/**
 * Prism palette constants live in Themes/System-3.0/Gradients/PrismPalette
 * so theme data does not import this visual implementation. The re-export
 * above keeps existing BeveledPrismVisual imports source-compatible.
 */
export type BeveledPrismVisualState = {
  prismColors?: PrismStateColors
  // One-shot geometry config — read once from the `default` state at theme
  // application. Not state-driven (no per-state tween). Shader clamps to
  // min(cornerRadius, depth/2), so values beyond that are safe but ignored.
  bevelRadius?: number
  // One-shot corner radius. Button overrides this for Capsule/Round shapes
  // (which need size-derived radii); for Rectangle the theme value wins
  // unless the button's `cornerRadius` is set.
  cornerRadius?: number
  // Forward-only Z displacement (cm). Front face/bevel pop forward; back
  // face is anchored. Tweens between states alongside prismColors.
  // `BeveledPrism._depth` (collider/AABB) does NOT change — only the
  // visual mesh deforms. Undefined treated as 0. Negative clamped to 0.
  extrusion?: number
  // Body presence in [0, 1]. 1 = natural depth. 0 = front face pulled
  // back to the back face (visually flat plane). Composes with
  // `extrusion`: final shader uniform =
  //   -depth * (1 - bodyDepthScale) + extrusion,
  // clamped to [-depth, +inf). PrismGhost uses 0 at idle (flat) and 1
  // on hover (full body). Undefined treated as 1 so existing styles
  // keep natural depth.
  bodyDepthScale?: number
  // Rotation in degrees. Drives BOTH the matcap UV rotation and the colour
  // band axis (see BeveledPrismShader), so animating it spins the gradient
  // colours around the centre. Per-state values are 0 at idle/hover (no
  // spin) and step up on trigger, so a press rotates the colours rather than
  // recolouring them. Tweens alongside prismColors. Undefined treated as 0.
  matcapRotation?: number
  // Per-state body opacity in [0, 1]. Tweens on state change to power
  // the PrismGhost style (fully transparent at idle, fades up on hover).
  // Undefined treated as 1 so styles that don't set it stay opaque.
  opacity?: number
} & VisualState

export type BeveledPrismVisualParameters = {
  default: BeveledPrismVisualState
  hovered: BeveledPrismVisualState
  triggered: BeveledPrismVisualState
  toggledDefault: BeveledPrismVisualState
  toggledHovered: BeveledPrismVisualState
  toggledTriggered: BeveledPrismVisualState
  inactive: BeveledPrismVisualState
} & VisualParameters

// Euclidean RGB-space distance — used below to scale palette-tween
// duration by magnitude of change. Kept local instead of swapping to
// UIKitUtilities.colorDistance: the latter returns normalized hue
// distance ∈ [0, 1] and ignores saturation/value, which is the wrong
// shape for "how much did this 7-stop palette change overall."
function vec4Distance(a: vec4, b: vec4): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  const dw = a.w - b.w
  return Math.sqrt(dx * dx + dy * dy + dz * dz + dw * dw)
}

function lerpPrismColors(a: PrismStateColors, b: PrismStateColors, t: number): PrismStateColors {
  return {
    master0: colorLerp(a.master0, b.master0, t),
    master1: colorLerp(a.master1, b.master1, t),
    master2: colorLerp(a.master2, b.master2, t),
    accent0: colorLerp(a.accent0, b.accent0, t),
    accent1: colorLerp(a.accent1, b.accent1, t),
    accent2: colorLerp(a.accent2, b.accent2, t),
    accent3: colorLerp(a.accent3, b.accent3, t)
  }
}

// Max component-wise vec4 distance across all seven stops. Used to scale
// transition duration so a small palette change tweens quickly and a big
// one takes the full animateDuration — same pattern as Visual.updateColors.
function prismColorsDistance(a: PrismStateColors, b: PrismStateColors): number {
  return Math.max(
    vec4Distance(a.master0, b.master0),
    vec4Distance(a.master1, b.master1),
    vec4Distance(a.master2, b.master2),
    vec4Distance(a.accent0, b.accent0),
    vec4Distance(a.accent1, b.accent1),
    vec4Distance(a.accent2, b.accent2),
    vec4Distance(a.accent3, b.accent3)
  )
}

/**
 * The `BeveledPrismVisual` class renders the iridescent prism button. It owns
 * a `BeveledPrism` Shape and tweens the seven palette uniforms (3 master + 4
 * accent stops) on state changes. Mirrors `RoundedRectangleVisual`'s pattern:
 * per-state stored values, animated lerp on `setState()`, theme-driven
 * defaults via `applyStyleParameters`.
 *
 * The vertex shader evaluates the gradients per vertex from `faceUV`-derived
 * inputs, so this class only needs to push the lerped stops as material
 * uniforms each frame during the transition.
 *
 * @extends Visual
 */
export class BeveledPrismVisual extends Visual {
  private static readonly CONTENT_Z_EPSILON = 0.1
  // Multiplier on animateDuration for opacity HIDE direction only.
  // PrismGhost reads as "fade up fast / fade out slow" with ~1.75× the
  // base duration on the way down.
  private static readonly HIDE_DURATION_SCALE = 1.75

  // Per-state shader/animation config grouped into one object (was 35 separate
  // fields) to keep the instance's own-property count low. Pure storage
  // relocation behind unchanged accessors. Semantics unchanged:
  //  - extrusion (cm): forward pop; setters clamp <0 to 0 and propagate the
  //    worst-case max to the BeveledPrism AABB (see propagateMaxExtrusion).
  //  - bodyDepthScale [0,1]: body presence; composes with extrusion at the
  //    shader push site.
  //  - matcapRotation (deg): animated reflection sweep.
  //  - opacity [0,1]: per-state body opacity (powers PrismGhost fade).
  private readonly _prismStates: Record<
    "default" | "hovered" | "triggered" | "inactive" | "toggledDefault" | "toggledHovered" | "toggledTriggered",
    {prismColors: PrismStateColors; extrusion: number; bodyDepthScale: number; matcapRotation: number; opacity: number}
  > = {
    default: {prismColors: PRISM_IDLE_COLORS, extrusion: 0, bodyDepthScale: 1, matcapRotation: 0, opacity: 1},
    hovered: {prismColors: PRISM_HOVER_COLORS, extrusion: 0, bodyDepthScale: 1, matcapRotation: 0, opacity: 1},
    triggered: {prismColors: PRISM_ACTIVE_COLORS, extrusion: 0, bodyDepthScale: 1, matcapRotation: 0, opacity: 1},
    inactive: {prismColors: PRISM_IDLE_COLORS, extrusion: 0, bodyDepthScale: 1, matcapRotation: 0, opacity: 1},
    toggledDefault: {
      prismColors: PRISM_SELECTED_COLORS,
      extrusion: 0,
      bodyDepthScale: 1,
      matcapRotation: 0,
      opacity: 1
    },
    toggledHovered: {prismColors: PRISM_HOVER_COLORS, extrusion: 0, bodyDepthScale: 1, matcapRotation: 0, opacity: 1},
    toggledTriggered: {prismColors: PRISM_ACTIVE_COLORS, extrusion: 0, bodyDepthScale: 1, matcapRotation: 0, opacity: 1}
  }

  private _currentPrismColors: PrismStateColors = PRISM_IDLE_COLORS
  private _currentExtrusion: number = 0
  private _currentBodyDepthScale: number = 1
  private _currentMatcapRotation: number = 0
  private _currentOpacity: number = 1

  // State transitions on Motion channels. Prism colors are a multi-uniform
  // struct (not an AnimatableValue), so they ride a scalar progress channel
  // whose write lerps the captured endpoints — Motion still owns the clock
  // and interruption.
  private _prismColorsTransition: {from: PrismStateColors; to: PrismStateColors} | null = null
  private _prismColorsProgress: number = 1
  private readonly _prismColorsChannel = MotionChannels.custom<number>("prism.colors", () => ({
    read: () => this._prismColorsProgress,
    write: (t: number) => {
      this._prismColorsProgress = t
      const transition = this._prismColorsTransition
      if (transition === null) {
        return
      }
      this._currentPrismColors = lerpPrismColors(transition.from, transition.to, t)
      this.pushPrismColors(this._currentPrismColors)
    }
  }))
  private readonly _extrusionChannel = MotionChannels.custom<number>("prism.extrusion", () => ({
    read: () => this._currentExtrusion,
    write: (value: number) => this.setCurrentExtrusion(value)
  }))
  private readonly _bodyDepthScaleChannel = MotionChannels.custom<number>("prism.bodyDepthScale", () => ({
    read: () => this._currentBodyDepthScale,
    write: (value: number) => this.setCurrentBodyDepthScale(value)
  }))
  private readonly _matcapRotationChannel = MotionChannels.custom<number>("prism.matcapRotation", () => ({
    read: () => this._currentMatcapRotation,
    write: (value: number) => {
      this._currentMatcapRotation = value
      this.beveledPrism.setMatcapRotation(value)
    }
  }))
  private readonly _opacityChannel = MotionChannels.custom<number>("prism.opacity", () => ({
    read: () => this._currentOpacity,
    write: (value: number) => {
      this._currentOpacity = value
      this.applyEffectiveOpacity()
    }
  }))

  // Cursor-following ray. Driven per-frame while hovered: the ray center
  // tracks the interactor's hit point (projected into face space).
  // Replaces the old matcap cursor-follow. Ray strength is hardcoded in
  // the shader, so on/off is gated purely by the center — when no
  // interactor hovers we push it far off-face (RAY_OFF_CENTER) and the
  // shader's gaussian falloff makes the ray vanish. The world→local
  // projection + follow smoothing live here so the shader stays cheap.
  private static readonly RAY_OFF_CENTER = 100
  // Time-constant of the follow-smoothing lerp, in seconds. ~90 ms gives a
  // smooth follow that actually smooths at 60-90 fps (0.04 was so tight it was
  // near-snap and jittery at low fps); raise for slower, lower for snappier.
  private static readonly RAY_SMOOTHING_TC = 0.09
  // Set of all interactors currently hovering. The ray follows the first
  // one inserted (Set iteration in JS is insertion order); when that one
  // exits, the next one in the set takes over. Empties -> center snaps off
  // face and the loop self-disables.
  private _currentInteractors: Set<Interactor> = new Set()
  // Ray center in face space ([-0.5, 0.5] per axis on the face). Starts far
  // off-face so the ray is hidden until the first hover.
  private _currentRayCenter: vec2 = new vec2(BeveledPrismVisual.RAY_OFF_CENTER, BeveledPrismVisual.RAY_OFF_CENTER)
  private _targetRayCenter: vec2 = new vec2(BeveledPrismVisual.RAY_OFF_CENTER, BeveledPrismVisual.RAY_OFF_CENTER)
  // True while the ray is actively following a hover. Used to snap the
  // center to the cursor on the hover-enter transition (so the ray appears
  // at the finger instead of sliding in from the off-face center).
  private _rayHovering: boolean = false
  private _rayUpdateEvent: SceneEvent | null = null
  // Beam axis (face space, unit-ish). While a hand hovers it follows the
  // hand's knuckle line (index→pinky) projected onto the face, so the
  // streak's angle turns with the wrist; mouse/mobile keep the authored
  // -20° default. Smoothed like the center; sign is irrelevant (the beam
  // is symmetric around the cursor).
  private static readonly RAY_DEFAULT_AXIS = new vec2(0.93969, -0.34202)
  private _currentRayAxis: vec2 = new vec2(0.93969, -0.34202)
  private _targetRayAxis: vec2 = new vec2(0.93969, -0.34202)

  // Spinning bevel-edge highlight (e.g. voice "listening"). Hosted on the owned
  // BeveledPrism like the ray loop; angle spins while active.
  private _edgeHighlightUpdateEvent: SceneEvent | null = null
  private _edgeHighlightAngle: number = 0
  private _edgeHighlightActive: boolean = false

  // Toggled-idle "breathing": while a toggle rests in its on state the FACE
  // matcap (front/back flat faces only — the shader masks by faceRegion)
  // slowly rotates back and forth. Sine from phase 0, so every entry into
  // toggledDefault starts gently from the authored position; on exit the
  // loop disables and pushes 0, snapping the matcap back to authored for
  // every other state.
  private static readonly BREATH_AMPLITUDE_DEG = 6
  private static readonly BREATH_PERIOD_S = 4
  private _breathUpdateEvent: SceneEvent | null = null
  private _breathTime: number = 0

  public override onHoverEnter(event: InteractorEvent): void {
    if (event.propagationPhase !== "Target") {
      return
    }
    this._currentInteractors.add(event.interactor as Interactor)
    if (this._rayUpdateEvent) {
      this._rayUpdateEvent.enabled = true
    }
  }

  // Drop the exiting interactor. If others remain (two-hand hover), the
  // ray loop keeps following the next one in insertion order — we follow
  // whoever entered first until they exit. Once the set empties, the ray
  // center snaps off-face (RAY_OFF_CENTER) and the loop self-disables.
  public override onHoverExit(event: InteractorEvent): void {
    if (event.propagationPhase !== "Target") {
      return
    }
    this._currentInteractors.delete(event.interactor as Interactor)
  }

  private _beveledPrismVisualStates: Map<StateName, BeveledPrismVisualState>
  protected _state: BeveledPrismVisualState = undefined
  protected prevState: BeveledPrismVisualState = undefined

  protected get visualStates(): Map<StateName, BeveledPrismVisualState> {
    return this._beveledPrismVisualStates
  }

  // Ease the base class's position/scale tweens with the same curve as the
  // extrusion pop so all state-driven motion on the prism moves as one.
  protected override get motionEasing(): keyof typeof easingFunctions {
    return MOTION_EASING
  }

  public constructor(args: VisualArgs) {
    super(args)
    this._sceneObject = args.sceneObject
    this.beveledPrism = this._sceneObject.createComponent(BeveledPrism.getTypeName())
    this.managedComponents.push(this.beveledPrism)
    this.beveledPrism.initialize()
    this.beveledPrism.size = new vec2(this.size.x, this.size.y)
    this.beveledPrism.depth = this.size.z
    this._transform = this._sceneObject.getTransform()
    // Push initial palette so the shader has valid uniforms before the first
    // frame renders (otherwise they'd be whatever the .mat has on disk).
    this.pushPrismColors(this._currentPrismColors)
    this.beveledPrism.setFrontExtrusion(this.composedFrontExtrusion)
    this.beveledPrism.setMatcapRotation(this._currentMatcapRotation)
    this.beveledPrism.setRayCenter(this._currentRayCenter)
    this.applyEffectiveOpacity()
    // Per-frame cursor-following-ray loop. Hosted on the owned BeveledPrism
    // (a BaseScriptComponent — Visual itself isn't one) so it gets torn down
    // with the rest of the Visual via managedComponents. Enabled only while
    // hovered; see onHoverEnter / onHoverExit / updateRay.
    this._rayUpdateEvent = this.beveledPrism.createEvent("LateUpdateEvent")
    this._rayUpdateEvent.bind(() => this.updateRay())
    this._rayUpdateEvent.enabled = false
    // Force the edge highlight off on every prism at init (don't rely on the
    // material's saved default), so only the voice button ever turns it on.
    this.beveledPrism.setEdgeHighlightStrength(0)
    this._edgeHighlightUpdateEvent = this.beveledPrism.createEvent("LateUpdateEvent")
    this._edgeHighlightUpdateEvent.bind(() => this.updateEdgeHighlight())
    this._edgeHighlightUpdateEvent.enabled = false
    // Toggled-idle breathing loop — enabled only while in toggledDefault
    // (see setState); idle/hover/etc. cost nothing.
    this._breathUpdateEvent = this.beveledPrism.createEvent("LateUpdateEvent")
    this._breathUpdateEvent.bind(() => this.updateBreathing())
    this._breathUpdateEvent.enabled = false
    this.initialize()
    this._styleCornerRadius = this.beveledPrism.cornerRadius
  }

  // Start/stop the spinning bevel-edge highlight (white->blue), e.g. while the
  // voice button is listening.
  public setEdgeHighlightActive(active: boolean): void {
    this._edgeHighlightActive = active
    this.beveledPrism.setEdgeHighlightStrength(active ? 1 : 0)
    if (this._edgeHighlightUpdateEvent) {
      this._edgeHighlightUpdateEvent.enabled = active
    }
  }

  private updateEdgeHighlight(): void {
    if (!this._edgeHighlightActive) {
      if (this._edgeHighlightUpdateEvent) {
        this._edgeHighlightUpdateEvent.enabled = false
      }
      return
    }
    this._edgeHighlightAngle = (this._edgeHighlightAngle + EDGE_HIGHLIGHT_SPIN_DEG_PER_SEC * getDeltaTime()) % 360
    this.beveledPrism.setEdgeHighlightAngle(this._edgeHighlightAngle)
  }

  public destroy(): void {
    if (this._rayUpdateEvent) {
      this._rayUpdateEvent.enabled = false
    }
    if (this._edgeHighlightUpdateEvent) {
      this._edgeHighlightUpdateEvent.enabled = false
    }
    if (this._breathUpdateEvent) {
      this._breathUpdateEvent.enabled = false
    }
    this._currentInteractors.clear()
    Motion.killTweensOf(this, "prism.colors")
    Motion.killTweensOf(this, "prism.extrusion")
    Motion.killTweensOf(this, "prism.bodyDepthScale")
    Motion.killTweensOf(this, "prism.matcapRotation")
    Motion.killTweensOf(this, "prism.opacity")
    super.destroy()
  }

  public get size(): vec3 {
    return super.size
  }

  public set size(size: vec3) {
    if (size === undefined) {
      return
    }
    const previousContentZOffset = this.contentZOffset
    super.size = size
    if (this.initialized) {
      this.beveledPrism.size = new vec2(size.x, size.y)
      this.beveledPrism.depth = size.z
    }
    const nextContentZOffset = this.contentZOffset
    if (Math.abs(nextContentZOffset - previousContentZOffset) > 1e-6) {
      this.notifyContentZOffsetChanged(nextContentZOffset)
    }
  }

  public get renderMeshVisual(): RenderMeshVisual {
    return this.beveledPrism.renderMeshVisual
  }

  // Required by the Visual abstract contract. BeveledPrism doesn't have
  // a border feature (the analytical edge mask covers the rim look),
  // so these are constant — false / 0.
  public get hasBorder(): boolean {
    return false
  }

  public get borderSize(): number {
    return 0
  }

  // Stored only to satisfy the Visual.baseColor abstract contract. The prism
  // shader doesn't consume a single base color — body comes from the
  // master*/accent* state palettes evaluated per vertex.
  private _baseColorStorage: vec4 = new vec4(1, 1, 1, 1)

  public get baseColor(): vec4 {
    return this._baseColorStorage
  }

  protected set baseColor(value: vec4) {
    this._baseColorStorage = value
  }

  // External opacity multiplier (Button / Frame fade APIs). Composed with
  // the state-tweened `_currentOpacity` so a PrismGhost button that's
  // mid-fade for autoShowHide still respects its per-state opacity curve.
  private _externalOpacity: number = 1

  public get opacity(): number {
    return this._externalOpacity
  }

  public set opacity(value: number) {
    this._externalOpacity = value
    this.applyEffectiveOpacity()
  }

  private applyEffectiveOpacity(): void {
    this.beveledPrism.opacity = this._currentOpacity * this._externalOpacity
  }

  public get cornerRadius(): number {
    return this.beveledPrism.cornerRadius
  }

  public set cornerRadius(value: number) {
    if (value === undefined) {
      return
    }
    this.beveledPrism.cornerRadius = value
  }

  private readonly _styleCornerRadius: number

  /**
   * Corner radius in cm the style gave this visual at construction: the
   * style's `default.cornerRadius`, or the shape's own default when the style
   * sets none. Later `cornerRadius` writes leave it alone, so an owner that
   * overrides the radius can restore the themed one (see Button.cornerRadius).
   */
  public get styleCornerRadius(): number {
    return this._styleCornerRadius
  }

  public get bevelRadius(): number {
    return this.beveledPrism.bevelRadius
  }

  public set bevelRadius(value: number) {
    if (value === undefined) {
      return
    }
    this.beveledPrism.bevelRadius = value
  }

  public get currentPrismColors(): PrismStateColors {
    return this._currentPrismColors
  }

  public get defaultPrismColors(): PrismStateColors {
    return this._prismStates.default.prismColors
  }

  public set defaultPrismColors(value: PrismStateColors) {
    if (value === undefined) {
      return
    }
    this._prismStates.default.prismColors = value
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get hoveredPrismColors(): PrismStateColors {
    return this._prismStates.hovered.prismColors
  }

  public set hoveredPrismColors(value: PrismStateColors) {
    if (value === undefined) {
      return
    }
    this._prismStates.hovered.prismColors = value
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get triggeredPrismColors(): PrismStateColors {
    return this._prismStates.triggered.prismColors
  }

  public set triggeredPrismColors(value: PrismStateColors) {
    if (value === undefined) {
      return
    }
    this._prismStates.triggered.prismColors = value
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get inactivePrismColors(): PrismStateColors {
    return this._prismStates.inactive.prismColors
  }

  public set inactivePrismColors(value: PrismStateColors) {
    if (value === undefined) {
      return
    }
    this._prismStates.inactive.prismColors = value
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get toggledDefaultPrismColors(): PrismStateColors {
    return this._prismStates.toggledDefault.prismColors
  }

  public set toggledDefaultPrismColors(value: PrismStateColors) {
    if (value === undefined) {
      return
    }
    this._prismStates.toggledDefault.prismColors = value
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get toggledHoveredPrismColors(): PrismStateColors {
    return this._prismStates.toggledHovered.prismColors
  }

  public set toggledHoveredPrismColors(value: PrismStateColors) {
    if (value === undefined) {
      return
    }
    this._prismStates.toggledHovered.prismColors = value
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get toggledTriggeredPrismColors(): PrismStateColors {
    return this._prismStates.toggledTriggered.prismColors
  }

  public set toggledTriggeredPrismColors(value: PrismStateColors) {
    if (value === undefined) {
      return
    }
    this._prismStates.toggledTriggered.prismColors = value
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get currentExtrusion(): number {
    return this._currentExtrusion
  }

  // Content tracks the LIVE front face, but never retreats behind the visual's
  // own ORIGIN plane. Note where the clamp sits: around the whole face position,
  // not just the extrusion term.
  //
  // A PrismGhost body idles at bodyDepthScale 0, which collapses it to a sheet on
  // the back plane, so the live face is at -size.z * 0.5. Two failure modes
  // bracket this, and the clamp point is what separates them:
  //
  //   - Clamping the extrusion term alone (`size.z * 0.5 + max(0, composed)`,
  //     which is what #7555 did) pins ghost content to the NATURAL front face, so
  //     it floats a full size.z above the collapsed sheet — a depth-1 button's
  //     icon hovers 1.1cm off the surface it looks seated on.
  //   - No clamp at all lets content follow the sheet down to -size.z * 0.5.
  //     That reads correctly ONLY when the author seated the button back-face-
  //     flush; a free-standing ghost button just pushes its icon backward into
  //     whatever scene geometry happens to be behind it, and the icon vanishes.
  //     Measured: with a panel ~0.5cm behind the origin, depths >= 1.4 disappear.
  //
  // Clamping at the origin plane satisfies both: ghost content sits EPS in front
  // of the plane the author positioned the button at (so it can never be occluded
  // by anything the button is placed in front of) instead of EPS in front of a
  // natural face that isn't there. Plain Prism is untouched — its bodyDepthScale
  // is always 1, so the clamp never binds.
  //
  // Residual, accepted: under strict back-face-flush seating the icon ends up
  // size.z * 0.5 proud of the surface rather than flat on it. A consumer that
  // wants it flatter can push it via ElementContent.zOffset, the same hook
  // VoiceInputButton uses to drive its icon down to the back plane.
  //
  // The collider getters below keep their own clamps for an unrelated reason.
  public override get contentZOffset(): number {
    return Math.max(0, this.size.z * 0.5 + this.composedFrontExtrusion) + BeveledPrismVisual.CONTENT_Z_EPSILON
  }

  // The prism body is BlendMode.Glass, so it shares the transparent queue with
  // companion text/icons. At equal renderOrder and with no Canvas, LS sorts
  // that queue by camera distance — and the prism's sort key comes from the
  // mesh asset's BAKED bounds (z half-extent 1.0; the whole form is vertex-
  // shader displacement the sorter can't see, which is also why frustum
  // culling has to be hand-authored in BeveledPrism.updateSize). Content at
  // contentZOffset only reads as nearer once size.z * 0.5 + 0.15 > 1.0, i.e.
  // depth > 1.7cm; below that the body draws last and its glass blends over
  // the icon, which looks like the icon is sunk INSIDE the button. +1 puts
  // content above the body regardless of depth.
  public override get contentRenderOrderOffset(): number {
    return 1
  }

  // Collider never shrinks below natural depth — PrismGhost's flat-at-idle
  // state still needs a full-size collider so the invisible button can
  // catch hover. Only positive composed extrusion widens it.
  public override get colliderSizeOffset(): vec3 {
    return new vec3(0, 0, Math.max(0, this.composedFrontExtrusion))
  }

  public override get colliderCenterOffset(): vec3 {
    return new vec3(0, 0, Math.max(0, this.composedFrontExtrusion) * 0.5)
  }

  // Single source of truth for the shader uniform: combine the per-state
  // cm-based pop with the per-state body-depth scale, then clamp so the
  // front face can never cross the anchored back face.
  private get composedFrontExtrusion(): number {
    const composed = -this.size.z * (1 - this._currentBodyDepthScale) + this._currentExtrusion
    return Math.max(-this.size.z, composed)
  }

  public get defaultExtrusion(): number {
    return this._prismStates.default.extrusion
  }

  public set defaultExtrusion(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.default.extrusion = Math.max(0, value)
    this.propagateMaxExtrusion()
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get hoveredExtrusion(): number {
    return this._prismStates.hovered.extrusion
  }

  public set hoveredExtrusion(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.hovered.extrusion = Math.max(0, value)
    this.propagateMaxExtrusion()
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get triggeredExtrusion(): number {
    return this._prismStates.triggered.extrusion
  }

  public set triggeredExtrusion(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.triggered.extrusion = Math.max(0, value)
    this.propagateMaxExtrusion()
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get inactiveExtrusion(): number {
    return this._prismStates.inactive.extrusion
  }

  public set inactiveExtrusion(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.inactive.extrusion = Math.max(0, value)
    this.propagateMaxExtrusion()
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get toggledDefaultExtrusion(): number {
    return this._prismStates.toggledDefault.extrusion
  }

  public set toggledDefaultExtrusion(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.toggledDefault.extrusion = Math.max(0, value)
    this.propagateMaxExtrusion()
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get toggledHoveredExtrusion(): number {
    return this._prismStates.toggledHovered.extrusion
  }

  public set toggledHoveredExtrusion(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.toggledHovered.extrusion = Math.max(0, value)
    this.propagateMaxExtrusion()
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get toggledTriggeredExtrusion(): number {
    return this._prismStates.toggledTriggered.extrusion
  }

  public set toggledTriggeredExtrusion(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.toggledTriggered.extrusion = Math.max(0, value)
    this.propagateMaxExtrusion()
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get currentBodyDepthScale(): number {
    return this._currentBodyDepthScale
  }

  public get defaultBodyDepthScale(): number {
    return this._prismStates.default.bodyDepthScale
  }

  public set defaultBodyDepthScale(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.default.bodyDepthScale = Math.max(0, Math.min(1, value))
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get hoveredBodyDepthScale(): number {
    return this._prismStates.hovered.bodyDepthScale
  }

  public set hoveredBodyDepthScale(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.hovered.bodyDepthScale = Math.max(0, Math.min(1, value))
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get triggeredBodyDepthScale(): number {
    return this._prismStates.triggered.bodyDepthScale
  }

  public set triggeredBodyDepthScale(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.triggered.bodyDepthScale = Math.max(0, Math.min(1, value))
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get inactiveBodyDepthScale(): number {
    return this._prismStates.inactive.bodyDepthScale
  }

  public set inactiveBodyDepthScale(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.inactive.bodyDepthScale = Math.max(0, Math.min(1, value))
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get toggledDefaultBodyDepthScale(): number {
    return this._prismStates.toggledDefault.bodyDepthScale
  }

  public set toggledDefaultBodyDepthScale(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.toggledDefault.bodyDepthScale = Math.max(0, Math.min(1, value))
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get toggledHoveredBodyDepthScale(): number {
    return this._prismStates.toggledHovered.bodyDepthScale
  }

  public set toggledHoveredBodyDepthScale(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.toggledHovered.bodyDepthScale = Math.max(0, Math.min(1, value))
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get toggledTriggeredBodyDepthScale(): number {
    return this._prismStates.toggledTriggered.bodyDepthScale
  }

  public set toggledTriggeredBodyDepthScale(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.toggledTriggered.bodyDepthScale = Math.max(0, Math.min(1, value))
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get currentMatcapRotation(): number {
    return this._currentMatcapRotation
  }

  public get defaultMatcapRotation(): number {
    return this._prismStates.default.matcapRotation
  }

  public set defaultMatcapRotation(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.default.matcapRotation = value
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get hoveredMatcapRotation(): number {
    return this._prismStates.hovered.matcapRotation
  }

  public set hoveredMatcapRotation(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.hovered.matcapRotation = value
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get triggeredMatcapRotation(): number {
    return this._prismStates.triggered.matcapRotation
  }

  public set triggeredMatcapRotation(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.triggered.matcapRotation = value
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get inactiveMatcapRotation(): number {
    return this._prismStates.inactive.matcapRotation
  }

  public set inactiveMatcapRotation(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.inactive.matcapRotation = value
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get toggledDefaultMatcapRotation(): number {
    return this._prismStates.toggledDefault.matcapRotation
  }

  public set toggledDefaultMatcapRotation(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.toggledDefault.matcapRotation = value
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get toggledHoveredMatcapRotation(): number {
    return this._prismStates.toggledHovered.matcapRotation
  }

  public set toggledHoveredMatcapRotation(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.toggledHovered.matcapRotation = value
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get toggledTriggeredMatcapRotation(): number {
    return this._prismStates.toggledTriggered.matcapRotation
  }

  public set toggledTriggeredMatcapRotation(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.toggledTriggered.matcapRotation = value
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get currentOpacity(): number {
    return this._currentOpacity
  }

  public get defaultOpacity(): number {
    return this._prismStates.default.opacity
  }

  public set defaultOpacity(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.default.opacity = Math.max(0, Math.min(1, value))
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get hoveredOpacity(): number {
    return this._prismStates.hovered.opacity
  }

  public set hoveredOpacity(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.hovered.opacity = Math.max(0, Math.min(1, value))
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get triggeredOpacity(): number {
    return this._prismStates.triggered.opacity
  }

  public set triggeredOpacity(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.triggered.opacity = Math.max(0, Math.min(1, value))
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get inactiveOpacity(): number {
    return this._prismStates.inactive.opacity
  }

  public set inactiveOpacity(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.inactive.opacity = Math.max(0, Math.min(1, value))
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get toggledDefaultOpacity(): number {
    return this._prismStates.toggledDefault.opacity
  }

  public set toggledDefaultOpacity(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.toggledDefault.opacity = Math.max(0, Math.min(1, value))
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get toggledHoveredOpacity(): number {
    return this._prismStates.toggledHovered.opacity
  }

  public set toggledHoveredOpacity(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.toggledHovered.opacity = Math.max(0, Math.min(1, value))
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  public get toggledTriggeredOpacity(): number {
    return this._prismStates.toggledTriggered.opacity
  }

  public set toggledTriggeredOpacity(value: number) {
    if (value === undefined) {
      return
    }
    this._prismStates.toggledTriggered.opacity = Math.max(0, Math.min(1, value))
    if (this.initialized) {
      this.needsVisualStateUpdate = true
    }
  }

  // Worst-case forward extrusion across all per-state values, propagated
  // to the owned BeveledPrism so its frustum-cull AABB widens once.
  // Avoids re-sizing the AABB every frame during a tween.
  private propagateMaxExtrusion(): void {
    const max = Math.max(
      this._prismStates.default.extrusion,
      this._prismStates.hovered.extrusion,
      this._prismStates.triggered.extrusion,
      this._prismStates.inactive.extrusion,
      this._prismStates.toggledDefault.extrusion,
      this._prismStates.toggledHovered.extrusion,
      this._prismStates.toggledTriggered.extrusion
    )
    this.beveledPrism.maxFrontExtrusion = max
  }

  // Synchronous first paint: applies the resolved state while prevState is still
  // undefined, so the update* appliers snap instead of tweening from field defaults.
  protected override applyInitialVisualState(): boolean {
    if (!this._state) {
      return false
    }
    this.applyCurrentVisualState()
    this.updatePrismColors(this._state.prismColors)
    this.updateExtrusion(this._state.extrusion)
    this.updateBodyDepthScale(this._state.bodyDepthScale)
    this.updateMatcapRotation(this._state.matcapRotation)
    this.updateOpacity(this._state.opacity)
    return true
  }

  public setState(stateName: StateName) {
    super.setState(stateName)
    if (this.initialized) {
      this.updatePrismColors(this._state.prismColors)
      this.updateExtrusion(this._state.extrusion)
      this.updateBodyDepthScale(this._state.bodyDepthScale)
      this.updateMatcapRotation(this._state.matcapRotation)
      this.updateOpacity(this._state.opacity)
      this.updateBreathingActive(stateName === StateName.toggledDefault)
    }
  }

  // Enable/disable the toggled-idle breathing loop. Phase resets to 0 on
  // every (re)entry so the swing always starts gently from the authored
  // matcap position; on exit the uniform snaps back to 0 (authored) for
  // all other states.
  private updateBreathingActive(active: boolean): void {
    if (!this._breathUpdateEvent || this._breathUpdateEvent.enabled === active) {
      return
    }
    this._breathUpdateEvent.enabled = active
    if (active) {
      this._breathTime = 0
    } else {
      this.beveledPrism.setFaceBreathRotation(0)
    }
  }

  private updateBreathing(): void {
    this._breathTime += getDeltaTime()
    const phase = (2 * Math.PI * this._breathTime) / BeveledPrismVisual.BREATH_PERIOD_S
    this.beveledPrism.setFaceBreathRotation(BeveledPrismVisual.BREATH_AMPLITUDE_DEG * Math.sin(phase))
  }

  protected updateColors(_targetColor: vec4): void {}

  protected updatePrismColors(targetColors: PrismStateColors) {
    if (!targetColors || !this.shouldColorChange) {
      return
    }
    // First apply (no prevState) or animation disabled: snap, don't fade in.
    if (this.prevState === undefined || this.animateDuration <= 0) {
      Motion.killTweensOf(this, "prism.colors")
      this._currentPrismColors = targetColors
      this.pushPrismColors(this._currentPrismColors)
      return
    }
    const initial = this._currentPrismColors
    const remaining = prismColorsDistance(targetColors, initial)
    const full = this.prevState?.prismColors ? prismColorsDistance(targetColors, this.prevState.prismColors) : remaining
    const ratio = full > 1e-6 ? Math.min(Math.max(remaining / full, 0), 1) : remaining > 1e-6 ? 1 : 0
    if (ratio === 0) {
      Motion.killTweensOf(this, "prism.colors")
      this._currentPrismColors = targetColors
      this.pushPrismColors(this._currentPrismColors)
      return
    }
    this._prismColorsTransition = {from: initial, to: targetColors}
    animateState({
      intent: "state.prism.colors",
      target: this,
      channel: this._prismColorsChannel,
      from: 0,
      value: 1,
      duration: ratio * this.animateDuration,
      ease: linear,
      onFinish: (forward: boolean) => {
        if (forward) {
          this._currentPrismColors = targetColors
          this.pushPrismColors(this._currentPrismColors)
        }
      }
    })
  }

  private pushPrismColors(c: PrismStateColors) {
    const pass = this.renderMeshVisual.mainPass
    pass.master0 = c.master0
    pass.master1 = c.master1
    pass.master2 = c.master2
    pass.accent0 = c.accent0
    pass.accent1 = c.accent1
    pass.accent2 = c.accent2
    pass.accent3 = c.accent3
  }

  private setCurrentExtrusion(value: number): void {
    const previousExtrusion = this._currentExtrusion
    const previousContentZOffset = this.contentZOffset
    this._currentExtrusion = Math.max(0, value)
    this.beveledPrism.setFrontExtrusion(this.composedFrontExtrusion)
    const nextContentZOffset = this.contentZOffset
    if (Math.abs(nextContentZOffset - previousContentZOffset) > 1e-6) {
      this.notifyContentZOffsetChanged(nextContentZOffset)
    }
    if (Math.abs(this._currentExtrusion - previousExtrusion) > 1e-6) {
      this.notifyColliderBoundsChanged()
    }
  }

  // Mirrors setCurrentExtrusion: bodyDepthScale lives on the same shader
  // uniform via `composedFrontExtrusion`, so a change here recomputes the
  // composed value and pushes it. Content-Z follows the front face too,
  // so we fire the layout event on change. Collider never shrinks below
  // natural depth — bodyDepthScale changes do NOT trigger a collider
  // notify (clamp in colliderSizeOffset keeps it stable).
  private setCurrentBodyDepthScale(value: number): void {
    const previousContentZOffset = this.contentZOffset
    this._currentBodyDepthScale = Math.max(0, Math.min(1, value))
    this.beveledPrism.setFrontExtrusion(this.composedFrontExtrusion)
    const nextContentZOffset = this.contentZOffset
    if (Math.abs(nextContentZOffset - previousContentZOffset) > 1e-6) {
      this.notifyContentZOffsetChanged(nextContentZOffset)
    }
  }

  // Mirrors updatePrismColors: scales transition duration by remaining/full
  // distance so a partial tween that gets re-targeted finishes in proportional
  // time instead of restarting the full animateDuration. Treats undefined as 0.
  protected updateExtrusion(target: number | undefined) {
    const targetValue = Math.max(0, target ?? 0)
    // First apply (no prevState) or animation disabled: snap, don't animate.
    if (this.prevState === undefined || this.animateDuration <= 0) {
      Motion.killTweensOf(this, "prism.extrusion")
      this.setCurrentExtrusion(targetValue)
      return
    }
    const remaining = Math.abs(targetValue - this._currentExtrusion)
    const prevTarget = this.prevState?.extrusion ?? 0
    const full = Math.abs(targetValue - prevTarget)
    const ratio = full > 1e-6 ? Math.min(Math.max(remaining / full, 0), 1) : remaining > 1e-6 ? 1 : 0
    if (ratio === 0) {
      Motion.killTweensOf(this, "prism.extrusion")
      this.setCurrentExtrusion(targetValue)
      return
    }
    animateState({
      intent: "state.prism.extrusion",
      target: this,
      channel: this._extrusionChannel,
      value: targetValue,
      duration: ratio * this.animateDuration * POP_DURATION_SCALE,
      ease: power2.out
    })
  }

  // Mirrors updateExtrusion: tweens the per-state body-depth scale (0..1)
  // and pushes the recomposed shader uniform via setCurrentBodyDepthScale.
  // Undefined target treated as 1 (natural depth) so styles that don't
  // set it keep their full body.
  protected updateBodyDepthScale(target: number | undefined) {
    const targetValue = Math.max(0, Math.min(1, target ?? 1))
    // First state application — snap so a freshly-spawned PrismGhost
    // button starts at bodyDepthScale 0 (flat) instead of tweening from
    // the field's initial-value default of 1.
    if (this.prevState === undefined || this.animateDuration <= 0) {
      Motion.killTweensOf(this, "prism.bodyDepthScale")
      this.setCurrentBodyDepthScale(targetValue)
      return
    }
    const remaining = Math.abs(targetValue - this._currentBodyDepthScale)
    const prevTarget = this.prevState.bodyDepthScale ?? 1
    const full = Math.abs(targetValue - prevTarget)
    const ratio = full > 1e-6 ? Math.min(Math.max(remaining / full, 0), 1) : remaining > 1e-6 ? 1 : 0
    if (ratio === 0) {
      Motion.killTweensOf(this, "prism.bodyDepthScale")
      this.setCurrentBodyDepthScale(targetValue)
      return
    }
    animateState({
      intent: "state.prism.bodyDepthScale",
      target: this,
      channel: this._bodyDepthScaleChannel,
      value: targetValue,
      duration: ratio * this.animateDuration * POP_DURATION_SCALE,
      ease: power2.out
    })
  }

  // Mirrors updateExtrusion: scales transition duration by remaining/full
  // distance so a partial tween that gets re-targeted finishes in
  // proportional time. Treats undefined as 0.
  //
  // The spin is bevel-only in the shader now. MOTION_EASING (ease-out-cubic,
  // shared with the pop) at SPIN_DURATION_SCALE x the base duration reads as
  // a long decelerating glide around the chamfer.
  protected updateMatcapRotation(target: number | undefined) {
    const targetValue = target ?? 0
    // First apply (no prevState) or animation disabled: snap, don't animate.
    if (this.prevState === undefined || this.animateDuration <= 0) {
      Motion.killTweensOf(this, "prism.matcapRotation")
      this._currentMatcapRotation = targetValue
      this.beveledPrism.setMatcapRotation(this._currentMatcapRotation)
      return
    }
    const remaining = Math.abs(targetValue - this._currentMatcapRotation)
    const prevTarget = this.prevState?.matcapRotation ?? 0
    const full = Math.abs(targetValue - prevTarget)
    const ratio = full > 1e-6 ? Math.min(Math.max(remaining / full, 0), 1) : remaining > 1e-6 ? 1 : 0
    if (ratio === 0) {
      Motion.killTweensOf(this, "prism.matcapRotation")
      this._currentMatcapRotation = targetValue
      this.beveledPrism.setMatcapRotation(this._currentMatcapRotation)
      return
    }
    animateState({
      intent: "state.prism.matcapRotation",
      target: this,
      channel: this._matcapRotationChannel,
      value: targetValue,
      duration: ratio * this.animateDuration * SPIN_DURATION_SCALE,
      ease: power2.out
    })
  }

  // Mirrors updateExtrusion: scales transition duration by remaining/full
  // distance so a re-targeted tween finishes in proportional time.
  // Undefined target treated as 1 (fully opaque) so styles that don't
  // set opacity stay opaque.
  //
  // Asymmetric show/hide cadence so PrismGhost feels right:
  //   - Show: snappy fade-in (ease-out-quart) at the base animate
  //     duration — opacity climbs quickly at the start of hover.
  //   - Hide: lingering fade-out (ease-in-quart) at HIDE_DURATION_SCALE×
  //     the base duration — the ghost stays visible a beat after exit.
  // Extrusion keeps its own neutral tween, so geometry and opacity
  // intentionally desync.
  protected updateOpacity(target: number | undefined) {
    const targetValue = Math.max(0, Math.min(1, target ?? 1))
    // First state application — snap so a freshly-spawned PrismGhost
    // button starts at opacity 0 instead of tweening from the field's
    // initial-value default of 1.
    if (this.prevState === undefined || this.animateDuration <= 0) {
      Motion.killTweensOf(this, "prism.opacity")
      this._currentOpacity = targetValue
      this.applyEffectiveOpacity()
      return
    }
    const initial = this._currentOpacity
    const remaining = Math.abs(targetValue - initial)
    const prevTarget = this.prevState.opacity ?? 1
    const full = Math.abs(targetValue - prevTarget)
    const ratio = full > 1e-6 ? Math.min(Math.max(remaining / full, 0), 1) : remaining > 1e-6 ? 1 : 0
    if (ratio === 0) {
      Motion.killTweensOf(this, "prism.opacity")
      this._currentOpacity = targetValue
      this.applyEffectiveOpacity()
      return
    }
    const isShow = targetValue >= initial
    animateState({
      intent: "state.prism.opacity",
      target: this,
      channel: this._opacityChannel,
      value: targetValue,
      duration: ratio * (isShow ? this.animateDuration : this.animateDuration * BeveledPrismVisual.HIDE_DURATION_SCALE),
      ease: isShow ? power3.out : power3.in
    })
  }

  // Per-frame: read the active interactor's hit point, project to the
  // button's local face XY, and drive the cursor-following ray — the
  // center tracks the hit point, the strength eases toward 1 while hovered
  // and 0 otherwise. Frame-rate-aware lerp via `1 - exp(-dt/TC)` keeps the
  // smoothing half-life constant at any framerate. Once no interactor
  // remains and the strength has faded below epsilon, the loop disables
  // itself so idle buttons cost nothing (the shader skips the ray branch
  // at strength 0).
  private updateRay(): void {
    // Set iteration is insertion order, so `.values().next().value` gives
    // us the first interactor that entered and is still hovering — stable
    // first-in/last-out tracking through multi-interactor scenarios.
    const interactor: Interactor | undefined = this._currentInteractors.values().next().value
    if (interactor) {
      const hitWS = interactor.targetHitPosition
      // Wait for a valid hit before showing anything — avoids a one-frame
      // flash at face center if targetHitPosition isn't ready on the enter frame.
      if (!hitWS) {
        return
      }
      const local = this._transform.getInvertedWorldTransform().multiplyPoint(hitWS)
      // sx/sy are the hit point in face space ([-0.5, 0.5]) — the same space
      // as the shader's facePos, so the ray centers right under the cursor.
      // Clamp guards against rare extrapolation past the edge.
      const sx = this.size.x > 1e-5 ? local.x / this.size.x : 0
      const sy = this.size.y > 1e-5 ? local.y / this.size.y : 0
      this._targetRayCenter.x = Math.max(-0.5, Math.min(0.5, sx))
      this._targetRayCenter.y = Math.max(-0.5, Math.min(0.5, sy))
      // Wrist-driven beam axis: the hand's knuckle line (index→pinky)
      // projected onto the face plane. Mouse/mobile → authored default.
      // A hand nearly perpendicular to the face (degenerate projection)
      // keeps the previous target rather than jumping.
      const hand = this.resolveHand(interactor)
      if (hand !== null && hand.isTracked()) {
        const dirWS = hand.indexKnuckle.position.sub(hand.pinkyKnuckle.position)
        const dirLocal = this._transform.getInvertedWorldTransform().multiplyDirection(dirWS)
        const planar = Math.sqrt(dirLocal.x * dirLocal.x + dirLocal.y * dirLocal.y)
        if (planar > 1e-3) {
          this._targetRayAxis.x = dirLocal.x / planar
          this._targetRayAxis.y = dirLocal.y / planar
        }
      } else if (hand === null) {
        this._targetRayAxis.x = BeveledPrismVisual.RAY_DEFAULT_AXIS.x
        this._targetRayAxis.y = BeveledPrismVisual.RAY_DEFAULT_AXIS.y
      }
      // The beam is symmetric around the cursor, so ±axis are the same
      // look — flip the target into the current hemisphere so the smoothing
      // lerp always takes the short path instead of swinging through zero.
      if (this._currentRayAxis.x * this._targetRayAxis.x + this._currentRayAxis.y * this._targetRayAxis.y < 0) {
        this._targetRayAxis.x = -this._targetRayAxis.x
        this._targetRayAxis.y = -this._targetRayAxis.y
      }
      if (this._rayHovering) {
        // Already hovering: ease the center toward the cursor for a smooth
        // follow. Frame-rate-aware lerp keeps the half-life constant.
        const dt = getDeltaTime()
        const t = 1 - Math.exp(-dt / BeveledPrismVisual.RAY_SMOOTHING_TC)
        this._currentRayCenter.x += (this._targetRayCenter.x - this._currentRayCenter.x) * t
        this._currentRayCenter.y += (this._targetRayCenter.y - this._currentRayCenter.y) * t
        // Axis follows the wrist with the same smoothing; renormalize after
        // the lerp (guarded — a degenerate mid-lerp vector keeps last frame).
        this._currentRayAxis.x += (this._targetRayAxis.x - this._currentRayAxis.x) * t
        this._currentRayAxis.y += (this._targetRayAxis.y - this._currentRayAxis.y) * t
        const axisLen = Math.sqrt(
          this._currentRayAxis.x * this._currentRayAxis.x + this._currentRayAxis.y * this._currentRayAxis.y
        )
        if (axisLen > 1e-3) {
          this._currentRayAxis.x /= axisLen
          this._currentRayAxis.y /= axisLen
        }
      } else {
        // Hover-enter: snap to the cursor so the ray appears at the finger
        // rather than sliding in from the off-face center. Axis snaps too.
        this._currentRayCenter.x = this._targetRayCenter.x
        this._currentRayCenter.y = this._targetRayCenter.y
        this._currentRayAxis.x = this._targetRayAxis.x
        this._currentRayAxis.y = this._targetRayAxis.y
        this._rayHovering = true
      }
      this.beveledPrism.setRayCenter(this._currentRayCenter)
      this.beveledPrism.setRayAxis(this._currentRayAxis)
    } else {
      // Hover ended: snap the center off-face so the gaussian vanishes
      // (strength is hardcoded in the shader), then disable the loop so
      // idle buttons cost nothing.
      this._rayHovering = false
      this._currentRayCenter.x = BeveledPrismVisual.RAY_OFF_CENTER
      this._currentRayCenter.y = BeveledPrismVisual.RAY_OFF_CENTER
      this.beveledPrism.setRayCenter(this._currentRayCenter)
      if (this._rayUpdateEvent) {
        this._rayUpdateEvent.enabled = false
      }
    }
  }

  // TrackedHand for a hovering hand interactor, or null for mouse/mobile/
  // other input types (callers fall back to the authored beam axis).
  private resolveHand(interactor: Interactor): TrackedHand | null {
    if ((interactor.inputType & InteractorInputType.LeftHand) === InteractorInputType.LeftHand) {
      return HandInputData.getInstance().getHand("left")
    }
    if ((interactor.inputType & InteractorInputType.RightHand) === InteractorInputType.RightHand) {
      return HandInputData.getInstance().getHand("right")
    }
    return null
  }

  protected applyStyleParameters(parameters: Partial<BeveledPrismVisualParameters>) {
    super.applyStyleParameters(parameters)
    this.applyStyleProperty<Partial<BeveledPrismVisualParameters>, BeveledPrismVisualState, PrismStateColors>(
      parameters,
      "prismColors",
      {
        default: (value) => (this.defaultPrismColors = value),
        hovered: (value) => (this.hoveredPrismColors = value),
        triggered: (value) => (this.triggeredPrismColors = value),
        inactive: (value) => (this.inactivePrismColors = value),
        toggledDefault: (value) => (this.toggledDefaultPrismColors = value),
        toggledHovered: (value) => (this.toggledHoveredPrismColors = value),
        toggledTriggered: (value) => (this.toggledTriggeredPrismColors = value)
      }
    )

    this.applyStyleProperty<Partial<BeveledPrismVisualParameters>, BeveledPrismVisualState, number>(
      parameters,
      "extrusion",
      {
        default: (value) => (this.defaultExtrusion = value),
        hovered: (value) => (this.hoveredExtrusion = value),
        triggered: (value) => (this.triggeredExtrusion = value),
        inactive: (value) => (this.inactiveExtrusion = value),
        toggledDefault: (value) => (this.toggledDefaultExtrusion = value),
        toggledHovered: (value) => (this.toggledHoveredExtrusion = value),
        toggledTriggered: (value) => (this.toggledTriggeredExtrusion = value)
      }
    )

    this.applyStyleProperty<Partial<BeveledPrismVisualParameters>, BeveledPrismVisualState, number>(
      parameters,
      "bodyDepthScale",
      {
        default: (value) => (this.defaultBodyDepthScale = value),
        hovered: (value) => (this.hoveredBodyDepthScale = value),
        triggered: (value) => (this.triggeredBodyDepthScale = value),
        inactive: (value) => (this.inactiveBodyDepthScale = value),
        toggledDefault: (value) => (this.toggledDefaultBodyDepthScale = value),
        toggledHovered: (value) => (this.toggledHoveredBodyDepthScale = value),
        toggledTriggered: (value) => (this.toggledTriggeredBodyDepthScale = value)
      }
    )

    this.applyStyleProperty<Partial<BeveledPrismVisualParameters>, BeveledPrismVisualState, number>(
      parameters,
      "matcapRotation",
      {
        default: (value) => (this.defaultMatcapRotation = value),
        hovered: (value) => (this.hoveredMatcapRotation = value),
        triggered: (value) => (this.triggeredMatcapRotation = value),
        inactive: (value) => (this.inactiveMatcapRotation = value),
        toggledDefault: (value) => (this.toggledDefaultMatcapRotation = value),
        toggledHovered: (value) => (this.toggledHoveredMatcapRotation = value),
        toggledTriggered: (value) => (this.toggledTriggeredMatcapRotation = value)
      }
    )

    this.applyStyleProperty<Partial<BeveledPrismVisualParameters>, BeveledPrismVisualState, number>(
      parameters,
      "opacity",
      {
        default: (value) => (this.defaultOpacity = value),
        hovered: (value) => (this.hoveredOpacity = value),
        triggered: (value) => (this.triggeredOpacity = value),
        inactive: (value) => (this.inactiveOpacity = value),
        toggledDefault: (value) => (this.toggledDefaultOpacity = value),
        toggledHovered: (value) => (this.toggledHoveredOpacity = value),
        toggledTriggered: (value) => (this.toggledTriggeredOpacity = value)
      }
    )

    // One-shot geometry: pull bevelRadius / cornerRadius from default. Not
    // state-driven — applied once at theme load and on subsequent style swaps.
    const bevel = parameters.default?.bevelRadius
    if (bevel !== undefined) {
      this.bevelRadius = bevel
    }
    const corner = parameters.default?.cornerRadius
    if (corner !== undefined) {
      this.cornerRadius = corner
    }
  }

  protected updateVisualStates(): void {
    this._beveledPrismVisualStates = new Map([
      [
        StateName.default,
        {
          baseColor: this.baseDefaultColor,
          prismColors: this.defaultPrismColors,
          extrusion: this._prismStates.default.extrusion,
          bodyDepthScale: this._prismStates.default.bodyDepthScale,
          matcapRotation: this._prismStates.default.matcapRotation,
          opacity: this._prismStates.default.opacity,
          shouldPosition: this.defaultShouldPosition,
          shouldScale: this.defaultShouldScale,
          localScale: this.defaultScale,
          localPosition: this.defaultPosition
        }
      ],
      [
        StateName.hovered,
        {
          baseColor: this.baseHoveredColor,
          prismColors: this.hoveredPrismColors,
          extrusion: this._prismStates.hovered.extrusion,
          bodyDepthScale: this._prismStates.hovered.bodyDepthScale,
          matcapRotation: this._prismStates.hovered.matcapRotation,
          opacity: this._prismStates.hovered.opacity,
          shouldPosition: this.hoveredShouldPosition,
          shouldScale: this.hoveredShouldScale,
          localScale: this.hoveredScale,
          localPosition: this.hoveredPosition
        }
      ],
      [
        StateName.triggered,
        {
          baseColor: this.baseTriggeredColor,
          prismColors: this.triggeredPrismColors,
          extrusion: this._prismStates.triggered.extrusion,
          bodyDepthScale: this._prismStates.triggered.bodyDepthScale,
          matcapRotation: this._prismStates.triggered.matcapRotation,
          opacity: this._prismStates.triggered.opacity,
          shouldPosition: this.triggeredShouldPosition,
          shouldScale: this.triggeredShouldScale,
          localScale: this.triggeredScale,
          localPosition: this.triggeredPosition
        }
      ],
      [
        StateName.toggledDefault,
        {
          baseColor: this.baseToggledDefaultColor,
          prismColors: this.toggledDefaultPrismColors,
          extrusion: this._prismStates.toggledDefault.extrusion,
          bodyDepthScale: this._prismStates.toggledDefault.bodyDepthScale,
          matcapRotation: this._prismStates.toggledDefault.matcapRotation,
          opacity: this._prismStates.toggledDefault.opacity,
          shouldPosition: this.toggledDefaultShouldPosition,
          shouldScale: this.toggledDefaultShouldScale,
          localScale: this.toggledScale,
          localPosition: this.toggledPosition
        }
      ],
      [
        StateName.toggledHovered,
        {
          baseColor: this.baseToggledHoveredColor,
          prismColors: this.toggledHoveredPrismColors,
          extrusion: this._prismStates.toggledHovered.extrusion,
          bodyDepthScale: this._prismStates.toggledHovered.bodyDepthScale,
          matcapRotation: this._prismStates.toggledHovered.matcapRotation,
          opacity: this._prismStates.toggledHovered.opacity,
          shouldPosition: this.toggledHoveredShouldPosition,
          shouldScale: this.toggledHoveredShouldScale,
          localScale: this.toggledHoveredScale,
          localPosition: this.toggledHoveredPosition
        }
      ],
      [
        StateName.toggledTriggered,
        {
          baseColor: this.baseToggledTriggeredColor,
          prismColors: this.toggledTriggeredPrismColors,
          extrusion: this._prismStates.toggledTriggered.extrusion,
          bodyDepthScale: this._prismStates.toggledTriggered.bodyDepthScale,
          matcapRotation: this._prismStates.toggledTriggered.matcapRotation,
          opacity: this._prismStates.toggledTriggered.opacity,
          shouldPosition: this.toggledTriggeredShouldPosition,
          shouldScale: this.toggledTriggeredShouldScale,
          localScale: this.toggledTriggeredScale,
          localPosition: this.toggledTriggeredPosition
        }
      ],
      [
        StateName.error,
        {
          baseColor: this.baseErrorColor,
          prismColors: this.defaultPrismColors,
          extrusion: this._prismStates.default.extrusion,
          bodyDepthScale: this._prismStates.default.bodyDepthScale,
          matcapRotation: this._prismStates.default.matcapRotation,
          opacity: this._prismStates.default.opacity,
          shouldPosition: this.defaultShouldPosition,
          shouldScale: this.defaultShouldScale,
          localScale: this.errorScale,
          localPosition: this.errorPosition
        }
      ],
      [
        StateName.errorHovered,
        {
          baseColor: this.baseErrorColor,
          prismColors: this.hoveredPrismColors,
          extrusion: this._prismStates.hovered.extrusion,
          bodyDepthScale: this._prismStates.hovered.bodyDepthScale,
          matcapRotation: this._prismStates.hovered.matcapRotation,
          opacity: this._prismStates.hovered.opacity,
          shouldPosition: this.hoveredShouldPosition,
          shouldScale: this.hoveredShouldScale,
          localScale: this.hoveredScale,
          localPosition: this.errorPosition
        }
      ],
      [
        StateName.inactive,
        {
          baseColor: this.baseInactiveColor,
          prismColors: this.inactivePrismColors,
          extrusion: this._prismStates.inactive.extrusion,
          bodyDepthScale: this._prismStates.inactive.bodyDepthScale,
          matcapRotation: this._prismStates.inactive.matcapRotation,
          opacity: this._prismStates.inactive.opacity,
          shouldPosition: this.inactiveShouldPosition,
          shouldScale: this.inactiveShouldScale,
          localScale: this.inactiveScale,
          localPosition: this.inactivePosition
        }
      ]
    ])
    super.updateVisualStates()
  }

  private get beveledPrism(): BeveledPrism {
    return this._visualComponent as BeveledPrism
  }

  private set beveledPrism(value: BeveledPrism) {
    this._visualComponent = value
  }
}

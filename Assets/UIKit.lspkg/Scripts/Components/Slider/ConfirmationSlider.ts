import {DragInteractorEvent} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import animate, {CancelSet} from "InteractionKit.lspkg/Utils/animate"
import Event, {PublicApi, unsubscribe} from "InteractionKit.lspkg/Utils/Event"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import {
  ConfirmationSliderFillDarkYellow,
  ConfirmationSliderFillLightGray,
  ConfirmationSliderFillMediumYellow,
  ConfirmationSliderKnobBorderBottom,
  ConfirmationSliderKnobBorderTop,
  ConfirmationSliderKnobBright,
  ConfirmationSliderKnobDark,
  ConfirmationSliderKnobHoverBorderBottom,
  ConfirmationSliderKnobHoverBorderTop,
  ConfirmationSliderKnobHoverBright,
  ConfirmationSliderKnobHoverDark,
  ConfirmationSliderKnobTriggeredBorderMid,
  ConfirmationSliderKnobTriggeredBorderYellow,
  ConfirmationSliderKnobTriggeredBright,
  ConfirmationSliderKnobTriggeredDark,
  ConfirmationSliderShineColor,
  ConfirmationSliderTrackBorderGray,
  ConfirmationSliderTrackBorderLight,
  ConfirmationSliderTrackBorderTransparent,
  ConfirmationSliderTrackDarkGray,
  ConfirmationSliderTrackGray
} from "../../Themes/System-2.0/Colors"
import {SYSTEM_3_NAME} from "../../Themes/Theme"
import {Callback, createCallbacks} from "../../Utility/SceneUtilities"
import {BeveledPrismVisual} from "../../Visuals/BeveledPrism/BeveledPrismVisual"
import {
  GradientParameters,
  RoundedRectangle,
  RoundedRectBlendMode
} from "../../Visuals/RoundedRectangle/RoundedRectangle"
import {
  RoundedRectangleVisual,
  RoundedRectangleVisualParameters
} from "../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {Visual} from "../../Visuals/Visual"
import {StateName} from "../Element"
import {Slider} from "./Slider"

const log = new NativeLogger("ConfirmationSlider")

// System3 default knob icon — the mockup's white arrow. Overridable per
// instance via the inherited `_knobIcon` input.
const DefaultArrowIcon: Texture = requireAsset("Icons.lspkg/Iconography/Arrows/arrow-right.png") as Texture

const KNOB_FADE_DURATION = 0.3

// The completion fade waits for the knob to reach (very nearly) the end of
// the track before starting — the spring approaches 1 asymptotically, so a
// hair under 1 avoids waiting on the tail.
const KNOB_SETTLED_VALUE = 0.995

// Local Z of the knob backer relative to the KNOB's local position (whose
// origin sits at the track's front face under System3) — just behind the
// prism's back-anchored mesh, still well in front of the fill. The backer is a
// sibling created BEFORE the knob (Canvas tree order must draw it first: the
// prism writes depth, so a backer drawn after it would be rejected), and it
// follows the knob's position on every knob move.
const KNOB_BACKER_Z_OFFSET = -0.005

const DEFAULT_FILL_OPACITY = {idle: 1, full: 1}

// Cap on the prism knob's depth, as a fraction of track height. The knob's
// depth and its forward offset both derive from `size.z`, but a `.meta`
// default only reaches newly added components — already-authored instances
// keep whatever z they have (e.g. a z=3 track authored at 2.5 cm tall would
// give a 3 cm-deep knob shoved 1.5 cm off the face). Clamping keeps those
// instances sane instead of relying on every consumer re-authoring.
const PRISM_DEPTH_MAX_HEIGHT_FACTOR = 0.5

type FillGradientColors = Record<string, vec4>

const FillGradient: FillGradientColors = {
  stop0Color0: ConfirmationSliderFillLightGray,
  stop0Color1: ConfirmationSliderFillDarkYellow,
  stop1Color0: ConfirmationSliderFillMediumYellow,
  stop1Color1: ConfirmationSliderFillMediumYellow
}

const DefaultShineColor: vec3 = ConfirmationSliderShineColor

interface ConfirmationSliderThemeData {
  fill?: FillGradientColors | StatefulFillGradient
  // System3 progress-driven fill: the gradient is written once at setup and
  // drag progress lerps the fill's opacity between `fillOpacity.idle` (faint
  // hint) and `.full` (completed). When present it replaces the legacy
  // two-stop `fill` path.
  fillGradient?: GradientParameters
  fillOpacity?: {idle: number; full: number}
  shineColor?: vec3
}

type StatefulFillGradient = Record<string, FillGradientColors>

const DefaultStatefulFillGradient: StatefulFillGradient = {
  default: FillGradient,
  hovered: FillGradient,
  triggered: FillGradient
}

function isStatefulFill(fill: unknown): fill is StatefulFillGradient {
  return fill !== null && typeof fill === "object" && "default" in (fill as object)
}

function normalizeStatefulFill(fill: FillGradientColors | StatefulFillGradient): StatefulFillGradient {
  if (isStatefulFill(fill)) {
    return fill
  }
  return {default: fill, hovered: fill, triggered: fill}
}

const FillParameters: Partial<GradientParameters> = {
  start: new vec2(-1, 0),
  end: new vec2(1, 0)
}

const SliderVisualParameters: Partial<RoundedRectangleVisualParameters> = {
  default: {
    baseType: "Gradient",
    baseGradient: {
      start: new vec2(0, 1),
      end: new vec2(0, -1),
      stop0: {
        percent: 0,
        color: ConfirmationSliderTrackDarkGray
      },
      stop1: {
        percent: 1,
        color: ConfirmationSliderTrackGray
      }
    },
    hasBorder: true,
    borderSize: 0.1,
    borderType: "Gradient",
    borderGradient: {
      start: new vec2(-0.9, 1),
      end: new vec2(0.9, -1),
      stop0: {
        percent: 0,
        color: ConfirmationSliderTrackBorderLight
      },
      stop1: {
        percent: 0.5,
        color: ConfirmationSliderTrackBorderTransparent
      },
      stop2: {
        percent: 1,
        color: ConfirmationSliderTrackBorderGray
      }
    }
  }
}

const KnobVisualParameters: Partial<RoundedRectangleVisualParameters> = {
  default: {
    baseType: "Gradient",
    baseGradient: {
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {
        percent: 0,
        color: ConfirmationSliderKnobDark
      },
      stop1: {
        percent: 1,
        color: ConfirmationSliderKnobBright
      }
    },
    hasBorder: true,
    borderType: "Gradient",
    borderGradient: {
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {
        percent: 0,
        color: ConfirmationSliderKnobBorderTop
      },
      stop1: {
        percent: 1,
        color: ConfirmationSliderKnobBorderBottom
      }
    }
  },
  hovered: {
    baseGradient: {
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {
        percent: 0,
        color: ConfirmationSliderKnobHoverDark
      },
      stop1: {
        percent: 1,
        color: ConfirmationSliderKnobHoverBright
      }
    },
    borderGradient: {
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {
        percent: 0,
        color: ConfirmationSliderKnobHoverBorderTop
      },
      stop1: {
        percent: 1,
        color: ConfirmationSliderKnobHoverBorderBottom
      }
    }
  },
  triggered: {
    baseGradient: {
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {
        percent: 0,
        color: ConfirmationSliderKnobTriggeredDark
      },
      stop1: {
        percent: 1,
        color: ConfirmationSliderKnobTriggeredBright
      }
    },
    borderGradient: {
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {
        percent: 0,
        color: ConfirmationSliderKnobTriggeredBorderYellow
      },
      stop1: {
        percent: 0.5,
        color: ConfirmationSliderKnobTriggeredBorderMid
      },
      stop2: {
        percent: 1,
        color: ConfirmationSliderKnobTriggeredBorderYellow
      }
    }
  }
}

/**
 * Component for a confirmation slider that allows users to slide to confirm an action.
 * It provides visual feedback and triggers an event when the confirmation is successful.
 */
@component
export class ConfirmationSlider extends Slider {
  @input
  @showIf("addCallbacks")
  @label("On Confirmation Callbacks")
  private onConfirmationCallbacks: Callback[] = []

  @input
  @showIf("addCallbacks")
  @label("On Reset Callbacks")
  private onResetCallbacks: Callback[] = []

  @input("number", "0.9")
  private _confirmationThreshold: number = 0.9

  private onConfirmationEvent = new Event<void>()
  /**
   * Event that is triggered when the slider is successfully confirmed.
   */
  private _onConfirmation?: PublicApi<void>
  public get onConfirmation(): PublicApi<void> {
    return (this._onConfirmation ??= this.onConfirmationEvent.publicApi())
  }

  private onResetEvent = new Event<void>()
  /**
   * Event that is triggered when the slider is reset to its initial state.
   */
  private _onReset?: PublicApi<void>
  public get onReset(): PublicApi<void> {
    return (this._onReset ??= this.onResetEvent.publicApi())
  }

  private customFillObject: SceneObject
  private customTrackFill: RoundedRectangle
  private _fillColors: StatefulFillGradient = DefaultStatefulFillGradient
  private _fillGradient: GradientParameters | null = null
  private _fillOpacity: {idle: number; full: number} = DEFAULT_FILL_OPACITY
  private _shineColor: vec3 = DefaultShineColor

  public readonly hasTrackVisual: boolean = true
  protected override _knobSize: vec2 = new vec2(3, 3)
  // Always true: the 1.5:1 knob is set in createDefaultVisual, and the flag
  // stops Slider's orchestrator + size handler from resetting it to square.
  // Not an inspector input here (absent from this component's meta).
  public readonly customKnobSize: boolean = true

  private shineCancel: CancelSet = new CancelSet()
  private knobFadeCancel: CancelSet = new CancelSet()
  private knobSettleUnsubscribe: unsubscribe | null = null
  // Prism visuals can't read their opacity back from mainPass, so the fade
  // tracks it here. 1 = fully visible.
  private _knobOpacity: number = 1
  // System 3.0: opaque knob-shaped rounded rect between the fill and the prism.
  // The prism's body is translucent, so the backer is what masks the fill to
  // the knob's exact silhouette — the gradient emerges hugging the knob's
  // rounded corners with no bleed-through and no gaps. A sibling created before
  // the knob (Canvas tree order must draw it under the depth-writing prism), so
  // it follows the knob's position explicitly (syncKnobBackerPosition) and is
  // shown/hidden with it explicitly (setKnobObjectsEnabled).
  private knobBacker: RoundedRectangle | null = null
  private knobBackerObject: SceneObject | null = null

  /**
   * Sets the value that the slider must reach on finished to trigger a confirmation.
   * @param value - A number between 0 and 1 representing the threshold.
   */
  public set confirmationThreshold(value: number) {
    if (value === undefined) {
      return
    }
    if (value < 0 || value > 1) {
      log.w("Confirmation threshold must be between 0 and 1.")
      return
    }
    this._confirmationThreshold = value
  }

  /**
   * Gets the current confirmation threshold.
   * @returns The confirmation threshold value (0 to 1).
   */
  public get confirmationThreshold(): number {
    return this._confirmationThreshold
  }

  public onAwake(): void {
    super.onAwake()
  }

  // System3 renders the prism knob + gradient fill; everything else keeps
  // the classic shine-material track and RR knob.
  private get isDS3(): boolean {
    return this.resolveTheme()?.name === SYSTEM_3_NAME
  }

  // The shine band lives in the bespoke ConfirmationSlider.mat swapped in
  // for System2 — the stock squircle material (System3 track) has no
  // shineFactor uniform, so the shine tweens must not touch it.
  private get usesShineMaterial(): boolean {
    return !this.isDS3
  }

  protected override get defaultTrackStyle(): Partial<RoundedRectangleVisualParameters> {
    return (this.resolveTheme()?.styles?.["ConfirmationSliderTrack"]?.["default"] ??
      SliderVisualParameters) as Partial<RoundedRectangleVisualParameters>
  }

  protected override get defaultKnobStyle(): Partial<RoundedRectangleVisualParameters> {
    return (this.resolveTheme()?.styles?.["ConfirmationSliderKnob"]?.["default"] ??
      KnobVisualParameters) as Partial<RoundedRectangleVisualParameters>
  }

  // The custom fill child below replaces Slider's trackFill in both themes.
  protected override get shouldCreateTrackFillVisual(): boolean {
    return false
  }

  protected createDefaultVisual(): void {
    const theme = this.resolveTheme()
    const themeData = theme.componentData?.["ConfirmationSlider"] as ConfirmationSliderThemeData | undefined
    this._fillColors = normalizeStatefulFill(themeData?.fill ?? FillGradient)
    this._fillGradient = themeData?.fillGradient ?? null
    this._fillOpacity = themeData?.fillOpacity ?? DEFAULT_FILL_OPACITY
    this._shineColor = themeData?.shineColor ?? DefaultShineColor

    // Wide 1.5:1 knob — set before Slider's orchestrator so
    // createDefaultKnobVisual reads the right size (customKnobSize keeps the
    // orchestrator from squaring it). Re-asserted on resize: this listener
    // registers before Slider's own size handler (added in initialize), so
    // the handler's updateKnobSize picks up the fresh value.
    this.applyKnobSizing()
    super.createDefaultVisual()
    this.applyKnobCornerRadius()
    this.onSizeChanged.add(() => {
      this.applyKnobSizing()
      this.applyKnobCornerRadius()
    })
  }

  // Fill and knob backer are created here — after the track, before the knob —
  // so Canvas tree order draws track → fill → backer → knob → knob icon.
  protected override createPreKnobVisuals(): void {
    this.customFillObject = global.scene.createSceneObject("ConfirmationSliderFill")
    this.managedSceneObjects.add(this.customFillObject)
    this.customFillObject.layer = this.sceneObject.layer
    this.customFillObject.setParent(this.sceneObject)
    this.customTrackFill = this.customFillObject.createComponent(RoundedRectangle.getTypeName())
    this.addManagedComponent(this.customTrackFill)
    this.customTrackFill.initialize()
    this.customTrackFill.gradient = true
    if (this._fillGradient) {
      // The idle->full progression is opacity-driven, and the raw shape's
      // default Disabled blend ignores opacityFactor — so the faint idle
      // hint needs real blending. DS2 keeps Disabled (it renders opaque).
      this.customTrackFill.blendMode = RoundedRectBlendMode.Normal
      // Stops are static; only opacity moves per frame (updateCustomFillSize).
      this.customTrackFill.setBackgroundGradient(this._fillGradient)
    }
    this.updateCustomFillSize()
    this.onKnobMoved.add(this.updateCustomFillSize.bind(this))

    // Only the visible System3 prism knob gets a backer (it masks the fill to
    // the knob's silhouette; the prism body is translucent).
    if (this.isDS3 && this.prismKnobVisible) {
      const trackBorder = this._visual?.hasBorder ? this._visual.borderSize : 0
      this.createKnobBacker(new vec2(this._knobSize.x - trackBorder * 2, this._knobSize.y - trackBorder * 2))
    }
  }

  private get prismKnobVisible(): boolean {
    const knobThemeData = this.resolveTheme()?.componentData?.["ConfirmationSliderKnob"] as
      | {knobVisible?: boolean}
      | undefined
    return knobThemeData?.knobVisible !== false
  }

  // State to fall back to when the slider stops being driven (drag cancelled,
  // reset). `inactive` is a separate flag that drives StateName.inactive, so
  // snapping blindly to `default` would un-gray a slider whose `inactive` is
  // still true.
  private get restingStateName(): StateName {
    return this.inactive ? StateName.inactive : StateName.default
  }

  private applyKnobSizing(): void {
    this._knobSize = new vec2(this.size.y * 1.5, this.size.y)
  }

  // Slider.updateKnobSize skips cornerRadius for non-RR knobs (instanceof
  // guard), so the prism path sets it here — the track formula, matching
  // Switch, so knob and track silhouettes stay in sync at any size.
  private applyKnobCornerRadius(): void {
    if (this._knobVisual instanceof BeveledPrismVisual) {
      this._knobVisual.cornerRadius = this.size.y * this.cornerRadiusFactor
    }
    if (this.knobBacker) {
      const trackBorder = this._visual?.hasBorder ? this._visual.borderSize : 0
      this.knobBacker.size = new vec2(this._knobSize.x - trackBorder * 2, this._knobSize.y - trackBorder * 2)
      this.knobBacker.cornerRadius = this.size.y * this.cornerRadiusFactor
    }
  }

  protected override createDefaultTrackVisual(): Visual {
    const visual = super.createDefaultTrackVisual()
    if (this.usesShineMaterial) {
      // The swapped compose material draws the track in-shader — freeze the
      // variant ladder BEFORE the override so a state change can't swap it
      // away.
      if (visual instanceof RoundedRectangleVisual) {
        visual.materialVariantsEnabled = false
      }
      visual.renderMeshVisual.mainMaterial = requireAsset("../../../Materials/ConfirmationSlider.mat") as Material
      visual.renderMeshVisual.mainPass.shineColor = this._shineColor
    }
    return visual
  }

  // System 3.0: beveled prism knob (Switch's prism pattern). System2: Slider's
  // RR knob with the legacy premultiplied blend. Both honor
  // ConfirmationSliderKnob.knobVisible from componentData — the prism path
  // deliberately skips super's SliderKnob.knobVisible check (false under
  // System3, where plain Sliders hide their knob).
  protected override createDefaultKnobVisual(): Visual {
    const knobVisible = this.prismKnobVisible

    let visual: Visual
    if (this.isDS3) {
      const knobObject = global.scene.createSceneObject(this.knobObjectName)
      this.managedSceneObjects.add(knobObject)
      // Inherit the component root's render layer so a bespoke layer propagates
      // onto the knob (the backer below already does the same).
      knobObject.layer = this.sceneObject.layer
      knobObject.setParent(this.sceneObject)

      const prismKnob = new BeveledPrismVisual({
        sceneObject: knobObject,
        style: {
          visualElementType: "ConfirmationSliderKnob",
          style: "default",
          themeName: "System 3.0"
        }
      })
      const trackBorder = this._visual?.hasBorder ? this._visual.borderSize : 0
      prismKnob.size = new vec3(
        this._knobSize.x - trackBorder * 2,
        this._knobSize.y - trackBorder * 2,
        this.prismKnobDepth
      )
      // The backer was created in createPreKnobVisuals (before the knob).
      visual = prismKnob
    } else {
      visual = super.createDefaultKnobVisual()
      visual.renderMeshVisual.mainPass.blendMode = BlendMode.PremultipliedAlphaAuto
    }

    if (!knobVisible) {
      this.setKnobRenderMeshEnabled(false, visual)
    }
    return visual
  }

  // Opaque, track-colored, knob-shaped rounded rect just behind the prism's
  // back face. Masks the fill to the knob's silhouette (the prism body is
  // translucent). A sibling of the knob created before it, so Canvas tree
  // order draws it above the fill and below the prism at one flat renderOrder;
  // syncKnobBackerPosition keeps it under the knob.
  private createKnobBacker(backerSize: vec2): void {
    const backerObject = global.scene.createSceneObject("SliderKnobBacker")
    this.managedSceneObjects.add(backerObject)
    backerObject.layer = this.sceneObject.layer
    backerObject.setParent(this.sceneObject)
    backerObject.getTransform().setLocalPosition(new vec3(0, 0, this.knobZOffset + KNOB_BACKER_Z_OFFSET))
    this.knobBackerObject = backerObject
    this.onKnobMoved.add(() => this.syncKnobBackerPosition())

    const backer = backerObject.createComponent(RoundedRectangle.getTypeName())
    this.addManagedComponent(backer)
    backer.initialize()
    // Default blend is Disabled (opaque), which ignores opacityFactor — the
    // completion fade needs alpha blending.
    backer.blendMode = RoundedRectBlendMode.Normal
    backer.renderOrder = this._renderOrder
    backer.size = backerSize
    backer.cornerRadius = this.size.y * this.cornerRadiusFactor
    // Same gradient as the track so the masked region reads as plain track
    // through the prism face.
    const trackGradient = this.defaultTrackStyle?.default?.baseGradient
    if (trackGradient) {
      backer.gradient = true
      backer.setBackgroundGradient(trackGradient)
    }
    this.knobBacker = backer
  }

  // The backer is a sibling of the knob, not a child, so hiding the knob object
  // no longer takes it along — an invisible zero-opacity backer would otherwise
  // keep being submitted after every confirmation until reset().
  private setKnobObjectsEnabled(enabled: boolean): void {
    if (this._knobVisual && !isNull(this._knobVisual)) {
      this._knobVisual.sceneObject.enabled = enabled
    }
    if (this.knobBackerObject && !isNull(this.knobBackerObject)) {
      this.knobBackerObject.enabled = enabled
    }
  }

  private syncKnobBackerPosition(): void {
    if (!this.knobBackerObject || isNull(this.knobBackerObject) || !this._knobVisual || isNull(this._knobVisual)) {
      return
    }
    const knobLocal = this._knobVisual.transform.getLocalPosition()
    this.knobBackerObject
      .getTransform()
      .setLocalPosition(new vec3(knobLocal.x, knobLocal.y, knobLocal.z + KNOB_BACKER_Z_OFFSET))
  }

  // Slider's policy covers `_trackFillVisual` and a RoundedRectangle knob; this
  // slider replaces the fill with a raw Shape (`customTrackFill`) and adds a backer,
  // which Slider cannot see — without this override the real fill kept writing
  // depth and a developer child at z≈0 was rejected over the filled span. Shape
  // has no depthWrite API, so this goes through the pass (as Switch pins its
  // markers). Opacity decides the rule: the System 2.0 fill is opaque (blend
  // Disabled) and follows the intermediate-fill policy; the System 3.0 fill is
  // blended (opacity-driven gradient) and, like every other transparent layer in
  // the kit, never writes depth. The backer is opaque at rest and follows the
  // policy; it matters little — the depth-writing prism sits in front of it.
  protected override applyIntermediateFillDepthWritePolicy(): void {
    super.applyIntermediateFillDepthWritePolicy()
    const write = this.intermediateFillDepthWrite
    if (this.customTrackFill && !isNull(this.customTrackFill)) {
      const opaque = this.customTrackFill.blendMode === RoundedRectBlendMode.Disabled
      this.customTrackFill.renderMeshVisual.mainPass.depthWrite = opaque ? write : false
    }
    if (this.knobBacker && !isNull(this.knobBacker)) {
      this.knobBacker.renderMeshVisual.mainPass.depthWrite = write
    }
  }

  protected override applyOwnedRenderOrders(): void {
    super.applyOwnedRenderOrders()
    // Shape.renderOrder keeps the Shape's own cache in step with its mesh.
    if (this.customTrackFill && !isNull(this.customTrackFill)) {
      this.customTrackFill.renderOrder = this._renderOrder
    }
    if (this.knobBacker && !isNull(this.knobBacker)) {
      this.knobBacker.renderOrder = this._renderOrder
    }
  }

  // The BeveledPrism mesh is back-anchored (back face at local Z=0, front
  // extends to +depth) while the track is centered — push the knob origin to
  // the track's front face so the prism sits on it (Switch's prism offset).
  protected override get knobZOffset(): number {
    return this.isDS3 ? super.knobZOffset + this.prismKnobDepth * 0.5 : super.knobZOffset
  }

  // Depth of the prism knob, clamped against the track height so an authored
  // `size.z` can't produce a knob deeper than the track is tall (see
  // PRISM_DEPTH_MAX_HEIGHT_FACTOR). Also the basis for `knobZOffset`, so the
  // two can't drift.
  private get prismKnobDepth(): number {
    return Math.min(this.size.z, this.size.y * PRISM_DEPTH_MAX_HEIGHT_FACTOR)
  }

  // Slider.updateKnobSize writes `size.z` straight into the knob's depth on
  // every resize, so the clamp has to be re-asserted afterwards. This
  // listener is registered after super.initialize() — i.e. after Slider's own
  // size handler — so it runs last and wins.
  public override initialize(): boolean {
    const initialized = super.initialize()
    if (initialized) {
      this.syncKnobBackerPosition()
      this.applyPrismKnobDepth()
      this.onSizeChanged.add(() => this.applyPrismKnobDepth())
    }
    return initialized
  }

  private applyPrismKnobDepth(): void {
    if (!(this._knobVisual instanceof BeveledPrismVisual)) {
      return
    }
    const knobSize = this._knobVisual.size
    const depth = this.prismKnobDepth
    if (Math.abs(knobSize.z - depth) > 1e-6) {
      this._knobVisual.size = new vec3(knobSize.x, knobSize.y, depth)
    }
  }

  // System3 ships the mockup's arrow by default; an authored `_knobIcon`
  // still wins in both themes.
  protected override get hasKnobIcon(): boolean {
    return super.hasKnobIcon || this.isDS3
  }

  protected override get knobIconTexture(): Texture | null {
    return this._knobIcon ?? (this.isDS3 ? DefaultArrowIcon : null)
  }

  protected setUpEventCallbacks(): void {
    if (this.addCallbacks) {
      this.onConfirmation.add(createCallbacks(this.onConfirmationCallbacks))
      this.onReset.add(createCallbacks(this.onResetCallbacks))
    }
    super.setUpEventCallbacks()
  }

  protected setState(stateName: StateName) {
    super.setState(stateName)
    if (this.customTrackFill) {
      this.updateCustomFillSize()
    }
  }

  private getFillColorsForState(): FillGradientColors {
    const stateKey =
      this.stateName === StateName.hovered
        ? "hovered"
        : this.stateName === StateName.triggered
          ? "triggered"
          : "default"
    return this._fillColors[stateKey] ?? this._fillColors.default
  }

  private updateCustomFillSize() {
    const borderSize = (this._visual as RoundedRectangleVisual).borderSize
    const fillSize = this.customTrackFill.size.uniformScale(1)
    fillSize.y = this.size.y - borderSize * 2
    fillSize.x = MathUtils.lerp(fillSize.y, this.size.x - borderSize * 2, this.knobValue)
    const xPos = MathUtils.lerp((this.size.x - borderSize * 2) * -0.5 + fillSize.y * 0.5, 0, this.knobValue)
    // Z from Slider's getter, not a local constant: customTrackFill IS this slider's
    // fill, and an override of trackFillZOffset must move it together with the
    // chrome stacked above it (see Slider.updateFillSize).
    this.customFillObject.getTransform().setLocalPosition(new vec3(xPos, 0, this.trackFillZOffset))
    this.customTrackFill.cornerRadius = fillSize.y * this.cornerRadiusFactor
    this.customTrackFill.size = fillSize
    if (this._fillGradient) {
      // Progress-driven sweep (System3): faint hint -> full palette as the
      // knob travels. Only the opacity moves — the stops were written once at
      // setup, so this is a single uniform write rather than a per-frame
      // gradient rebuild (four HSV round-trips + a full stop re-upload).
      // The fill's leading edge always rides under the knob (verified:
      // fillRight - knobLeft = h + v*(knobW - h) > 0 and fillRight <=
      // knobRight for all v), where the opaque knobBacker masks it to the
      // knob's silhouette — so the gradient emerges exactly at the knob's
      // edge, and the completion fade reveals the already-full-width fill.
      this.customTrackFill.opacity = MathUtils.lerp(this._fillOpacity.idle, this._fillOpacity.full, this.knobValue)
      return
    }
    const colors = this.getFillColorsForState()
    this.customTrackFill.setBackgroundGradient({
      ...FillParameters,
      stop0: {
        percent: 0,
        color: vec4.lerp(colors.stop0Color0, colors.stop0Color1, this.knobValue)
      },
      stop1: {
        percent: 1,
        color: vec4.lerp(colors.stop1Color0, colors.stop1Color1, this.knobValue)
      }
    })
  }

  protected onInteractableDragEnd(dragEvent: DragInteractorEvent): void {
    super.onInteractableDragEnd(dragEvent)
    this.animateShineTo(1)
    if (this.currentValue < this._confirmationThreshold) {
      this.updateCurrentValue(0, true)
      this.setState(this.restingStateName)
    } else {
      this.interactable.enabled = false
      this.updateCurrentValue(1, true)
      this.setState(StateName.toggledDefault)
      // Fade only once the knob has settled at the end of the track —
      // fading mid-travel reads as a muddy half-transparent knob sliding
      // to its resting spot.
      this.fadeOutKnobWhenSettled()
      // Invoke external callbacks LAST: onConfirmation is synchronous, and a
      // listener may call reset() to reuse the control — reset() cancels the
      // fade and clears the settle listener, so nothing here re-arms after it.
      this.onConfirmationEvent.invoke()
    }
  }

  protected onInteractableDragStart(dragEvent: DragInteractorEvent): void {
    super.onInteractableDragStart(dragEvent)
    this.animateShineTo(0)
  }

  private animateShineTo(target: number): void {
    if (!this.usesShineMaterial) {
      return
    }
    const shineFactor = this.visual.renderMeshVisual.mainPass.shineFactor
    this.shineCancel?.cancel()
    animate({
      cancelSet: this.shineCancel,
      duration: 0.2 * Math.abs(shineFactor - target),
      update: (t) => {
        this.visual.renderMeshVisual.mainPass.shineFactor = MathUtils.lerp(shineFactor, target, t)
      }
    })
  }

  // Knob opacity spans both knob flavors: the prism composes an external
  // multiplier (its material has no opacityFactor), the RR knob writes
  // mainPass directly. The knob's backer and its `_knobIcon` content fade in
  // step.
  //
  // LIMITATION: this only covers renderables this component owns. Content a
  // consumer parents onto `knobVisual.sceneObject` itself does NOT fade — it
  // stays fully opaque through the completion fade and then disappears with
  // the knob object. Consumers that attach their own knob content and want it
  // to fade should drive it themselves (e.g. a VisibilityGroup over their
  // subtree, `Utility/VisibilityGroup`) off `onConfirmation`.
  private setKnobOpacity(value: number): void {
    this._knobOpacity = value
    if (this._knobVisual instanceof BeveledPrismVisual) {
      this._knobVisual.opacity = value
    } else {
      this._knobVisual.renderMeshVisual.mainPass.opacityFactor = value
    }
    if (this.knobBacker) {
      this.knobBacker.opacity = value
    }
    this.setKnobIconOpacity(value)
  }

  private clearKnobSettleListener(): void {
    this.knobSettleUnsubscribe?.()
    this.knobSettleUnsubscribe = null
  }

  private fadeOutKnobWhenSettled(): void {
    this.clearKnobSettleListener()
    if (this.knobValue >= KNOB_SETTLED_VALUE) {
      this.fadeOutKnob()
      return
    }
    this.knobSettleUnsubscribe = this.onKnobMoved.add((value) => {
      if (value >= KNOB_SETTLED_VALUE) {
        this.clearKnobSettleListener()
        this.fadeOutKnob()
      }
    })
  }

  private fadeOutKnob(): void {
    this.knobFadeCancel.cancel()
    const startOpacity = this._knobOpacity
    animate({
      cancelSet: this.knobFadeCancel,
      duration: KNOB_FADE_DURATION * Math.abs(startOpacity),
      update: (t) => {
        // The backer fades with the knob, revealing the (already full-width)
        // gradient fill underneath.
        this.setKnobOpacity(MathUtils.lerp(startOpacity, 0, t))
      },
      ended: () => {
        this.setKnobObjectsEnabled(false)
      }
    })
  }

  /**
   * Reset the confirmation slider to its initial state.
   *
   * Runs as a programmatic write: listeners it fires, {@link onReset}
   * included, read {@link isDragging} as false, even mid-drag.
   */
  public reset() {
    this.runProgrammaticWrite(() => {
      if (this._initialized) {
        this.interactable.enabled = true
        this.clearKnobSettleListener()
        this.knobFadeCancel.cancel()
        this.setKnobObjectsEnabled(true)
        this.setKnobOpacity(1)
        this.setState(this.restingStateName)
      }
      this.updateCurrentValue(0, false)
      this.onResetEvent.invoke()
    })
  }

  protected override release(): void {
    // The fade/shine tweens run on IK's global animation manager and the
    // settle listener holds a knob reference — cancel them all before the
    // base tears down and nulls the visuals, or the next animation frame
    // dereferences a destroyed knob.
    this.clearKnobSettleListener()
    this.knobFadeCancel.cancel()
    this.shineCancel.cancel()
    super.release()
  }

  protected enableManagedComponents() {
    for (const {component, disabledWhenInactive} of this.managedComponents) {
      if (!isNull(component) && component) {
        if (component === this.interactable) {
          // The interactable also depends on runtime progress, beyond the
          // inactive flag — the one rule that can't be expressed declaratively.
          component.enabled = !this.inactive && this.currentValue < this._confirmationThreshold
        } else {
          component.enabled = !(this.inactive && disabledWhenInactive)
        }
      }
    }
  }
}

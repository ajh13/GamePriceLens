import {DragInteractorEvent, InteractorEvent} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import Event, {PublicApi, unsubscribe} from "InteractionKit.lspkg/Utils/Event"
import {clamp, lerp} from "InteractionKit.lspkg/Utils/mathUtils"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import {SpringAnimate} from "InteractionKit.lspkg/Utils/springAnimate"
import {
  DarkerLessGray,
  DarkestGray,
  DarkestYellow,
  DarkWarmGray,
  MediumDarkGray,
  MediumWarmGray,
  SliderKnobTriggeredBorderMid,
  SwitchBorderYellowLight,
  SwitchKnobBorderGray,
  SwitchKnobBorderTransparent,
  SwitchKnobBorderYellow,
  SwitchKnobBorderYellowBright,
  SwitchKnobBorderYellowMedium,
  SwitchTrackBorderGray,
  SwitchTrackBorderTransparent,
  SwitchTrackGray,
  SwitchYellowBright,
  SwitchYellowDark,
  TriggeredBorderClearGray,
  TriggeredBorderYellow
} from "../../Themes/System-2.0/Colors"
import {applyFlatRenderOrder} from "../../Utility/DrawOrderLayering"
import {
  Callback,
  createCallbacks,
  createChildSceneObjectWithParentLayer,
  reappendChild
} from "../../Utility/SceneUtilities"
import {commitSliderDragValue, isEqual} from "../../Utility/UIKitUtilities"
import {
  RoundedRectangleVisual,
  RoundedRectangleVisualParameters
} from "../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {Visual} from "../../Visuals/Visual"
import {ElementContent, TextAlignment} from "../Content/ElementContent"
import {StateName} from "../Element"
import {VisualElement} from "../VisualElement"

const log = new NativeLogger("Slider")

const SPRING_EPSILON: number = 0.001
// Local +Z steps. Draw order between track, fill and knob is the Canvas tree
// order; for the OPAQUE fill and RoundedRectangle knob (both write depth) the
// step is what keeps the depth test from rejecting the later layer. Both are
// below Utility/DrawOrderLayering.Z_LAYER_STEP (0.05) — pre-existing values,
// kept: the knob's Z also anchors the prism knobs (Switch, ConfirmationSlider
// add size.z/2 to it), so raising it is a geometry decision, not a sorting one.
const KNOB_Z_OFFSET: number = 0.015
const TRACKFILL_Z_OFFSET: number = 0.01

const TRIGGER_START_AUDIO_TRACK: AudioTrackAsset = requireAsset(
  "../../../Audio/TriggerStartAudioTrack.wav"
) as AudioTrackAsset
const TRIGGER_START_AUDIO_VOLUME: number = 1

export const DEFAULT_CORNER_RADIUS_FACTOR: number = 0.1667

const SliderVisualParameters: Partial<RoundedRectangleVisualParameters> = {
  default: {
    baseType: "Gradient",
    baseGradient: {
      type: "Linear",
      start: new vec2(0, 1),
      end: new vec2(0, -1),
      stop0: {
        percent: 0,
        color: SwitchTrackGray
      },
      stop1: {
        percent: 1,
        color: DarkerLessGray
      }
    },
    hasBorder: true,
    borderSize: 0.1,
    borderType: "Gradient",
    borderGradient: {
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {
        percent: 0,
        color: SwitchTrackBorderGray
      },
      stop1: {
        percent: 0.5,
        color: SwitchTrackBorderTransparent
      },
      stop2: {
        percent: 1,
        color: SwitchTrackBorderGray
      }
    }
  },
  hovered: {},
  triggered: {
    baseGradient: {
      start: new vec2(0, 1),
      end: new vec2(0, -1),
      stop0: {
        percent: 0,
        color: DarkestYellow
      },
      stop1: {
        percent: 1,
        color: DarkestYellow
      }
    },
    borderGradient: {
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {
        percent: 0,
        color: SwitchKnobBorderYellow
      },
      stop1: {
        percent: 0.5,
        color: SwitchKnobBorderYellowMedium
      },
      stop2: {
        percent: 1,
        color: SwitchKnobBorderYellow
      }
    }
  }
}

const KnobVisualParameters: Partial<RoundedRectangleVisualParameters> = {
  default: {
    baseType: "Gradient",
    borderSize: 0.07,
    baseGradient: {
      enabled: true,
      type: "Linear",
      start: new vec2(-1, 1),
      end: new vec2(1, -1),
      stop0: {percent: 0, color: DarkestGray},
      stop1: {percent: 1, color: DarkWarmGray}
    },
    hasBorder: true,
    borderType: "Gradient",
    borderGradient: {
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {
        percent: 0,
        color: SwitchKnobBorderGray
      },
      stop1: {
        percent: 1,
        color: SwitchKnobBorderTransparent
      }
    }
  },
  hovered: {
    baseGradient: {
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {
        percent: 0,
        color: DarkWarmGray
      },
      stop1: {
        percent: 1,
        color: SwitchKnobBorderGray
      }
    },
    borderGradient: {
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {
        percent: 0,
        color: MediumWarmGray
      },
      stop1: {
        percent: 1,
        color: TriggeredBorderClearGray
      }
    }
  },
  triggered: {
    baseGradient: {
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {
        percent: 0,
        color: SwitchYellowDark
      },
      stop1: {
        percent: 1,
        color: SwitchYellowBright
      }
    },
    borderGradient: {
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {
        percent: 0,
        color: TriggeredBorderYellow
      },
      stop1: {
        percent: 0.5,
        color: SliderKnobTriggeredBorderMid
      },
      stop2: {
        percent: 1,
        color: SwitchKnobBorderYellowBright
      }
    }
  }
}

const TrackVisualParameters: Partial<RoundedRectangleVisualParameters> = {
  default: {
    baseType: "Color",
    baseColor: MediumDarkGray,
    hasBorder: false
  },
  hovered: {
    baseColor: MediumWarmGray
  },
  triggered: {
    baseColor: SwitchBorderYellowLight
  }
}

/**
 * Configuration object for spring animation parameters.
 */
type SpringConfig = {
  /**
   * Spring constant (stiffness). Higher values create a stiffer spring.
   * @defaultValue 150
   * @remarks Typical range: 50-500. Higher values make the animation reach the target faster but may cause more oscillation.
   */
  k?: number
  /**
   * Damping constant. Higher values reduce oscillation and settling time.
   * @defaultValue 21
   * @remarks Typical range: 10-50. Higher values create less bouncy, more controlled motion.
   */
  damp?: number
  /**
   * Mass of the animated object. Higher values make the animation slower and more sluggish.
   * @defaultValue 1
   * @remarks Typical range: 0.5-3. Lower values create lighter, more responsive motion.
   */
  mass?: number
}

const DEFAULT_SPRING_CONFIG: SpringConfig = {
  k: 150, // Spring constant
  damp: 21, // Damping constant
  mass: 1 // Mass of the object
}

/**
 * Represents a slider component that allows users to select a value within a specified range.
 * The slider includes a draggable knob and emits events when the value changes or interaction finishes.
 *
 * @remarks
 * - The slider's value is constrained between 0 and 1.
 * - The knob's position is updated based on the current value.
 * - The component supports animations for knob position updates.
 *
 * @extends VisualElement
 */
@component
export class Slider extends VisualElement {
  // To add per-theme styles, add @input fields like:
  //
  // @input
  // @showIf("_themeOverride", "System3")
  // @label("Style")
  // @widget(new ComboBoxWidget([
  //   new ComboBoxItem("StyleName", "StyleName"),
  // ]))
  // protected _styleSystem3: string = "StyleName"

  @input
  @hint("Size of the element in centimeters")
  protected _size: vec3 = new vec3(6, 3, 1)

  @input
  @hint("The default value of the slider, should be between 0 and 1")
  @widget(new SliderWidget(0, 1, 0.01))
  protected _defaultValue: number = 0

  @input
  @hint("Enable triggering anywhere on the slider track to snap the knob to that position")
  protected snapToTriggerPosition: boolean = false

  @input
  @hint("Enable this to make the slider segmented, with a fixed number of segments")
  protected _segmented: boolean = false

  @input
  @hint("The number of segments for the segmented slider, must be at least 2")
  @showIf("_segmented")
  protected _numberOfSegments: number = 5

  @input
  @hint("Enable this to show a fill on the track up to the knob position")
  public hasTrackVisual: boolean = true

  @input
  @hint("Enable this to customize the knob size")
  public customKnobSize: boolean = false

  @input
  @showIf("customKnobSize")
  protected _knobSize: vec2 = new vec2(3, 3)

  private _knobCornerRadiusOverride: number | null = null

  @input
  @allowUndefined
  @hint("Optional icon rendered on the knob (moves with it). Leave empty for no knob icon.")
  protected _knobIcon: Texture | null = null

  @input
  @hint("Enable this to add functions from another script to this component's callbacks")
  protected addCallbacks: boolean = false
  @input
  @showIf("addCallbacks")
  @label("On Value Changed Callbacks")
  private onValueChangeCallbacks: Callback[] = []

  protected _knobVisual: Visual
  protected _trackFillVisual: Visual
  private _knobContentObject: SceneObject | null = null
  private _knobIconContent: ElementContent | null = null
  private _knobCollider: ColliderComponent | null = null
  private _clipColliders: ColliderComponent[] = []

  protected _currentValue: number = this._segmented ? this.snapToSegment(this._defaultValue) : this._defaultValue
  private _knobValue: number = this._currentValue
  private _knobPosition: number = 0
  private _initialDragPosition: vec3 | null = null

  /**
   * Invoked when the current value has changed.
   */
  private onValueChangeEvent: Event<number> = new Event()
  private _onValueChange?: PublicApi<number>
  public get onValueChange(): PublicApi<number> {
    return (this._onValueChange ??= this.onValueChangeEvent.publicApi())
  }
  /**
   * Invoked when the knob has moved.
   */
  private onKnobMovedEvent: Event<number> = new Event()
  private _onKnobMoved?: PublicApi<number>
  public get onKnobMoved(): PublicApi<number> {
    return (this._onKnobMoved ??= this.onKnobMovedEvent.publicApi())
  }
  /**
   * Invoked when cached clip collider transform, size, or enabled intent changes.
   * Collider replacements still require VirtualizedLayout structure invalidation.
   */
  private onClipCollidersDirtyEvent: Event<void> = new Event()
  private _onClipCollidersDirty?: PublicApi<void>
  public get onClipCollidersDirty(): PublicApi<void> {
    return (this._onClipCollidersDirty ??= this.onClipCollidersDirtyEvent.publicApi())
  }

  private _knobSpringAnimate = new SpringAnimate(
    DEFAULT_SPRING_CONFIG.k,
    DEFAULT_SPRING_CONFIG.damp,
    DEFAULT_SPRING_CONFIG.mass
  )

  private _springCurrent = new vec3(0, 0, KNOB_Z_OFFSET)
  private _springTarget = new vec3(0, 0, KNOB_Z_OFFSET)
  private _springResult = new vec3(0, 0, KNOB_Z_OFFSET)

  private _knobLocalPos = new vec3(0, 0, KNOB_Z_OFFSET)
  // Float64 mirror of the Z last written into _knobLocalPos. vec3 fields are
  // float32-backed (new vec3(0, 0, 0.015).z reads back 0.01499999966…), so
  // comparing the vec3 against the float64 getter is never equal; this field is
  // what updateKnobPositionFromValue compares. NaN = nothing applied yet.
  private _appliedKnobZ: number = Number.NaN
  // Whether the current knob's RenderMeshVisual should be drawn. Theme-driven
  // hides (SliderKnob.knobVisible is false under System 3.0; ColorSlider,
  // ConfirmationSlider and Switch key off their own componentData) record their
  // verdict here because Visual.enable() re-enables every managed component —
  // including a RenderMeshVisual that was hidden on purpose — so a disable/enable
  // cycle would otherwise resurrect the knob. enableVisuals re-applies it. Reset
  // to true whenever the knob is replaced: a replacement arrives visible.
  private _knobRenderMeshEnabled: boolean = true
  private _trackFillLocalPos = new vec3(0, 0, TRACKFILL_Z_OFFSET)

  private _knobValueAtDragStart: number = 0
  // Nesting depth of writes the slider makes on its own behalf (see
  // runProgrammaticWrite). isDragging reads false while it is above 0.
  private _programmaticWriteDepth: number = 0

  private knobVisualEventHandlerUnsubscribes: unsubscribe[] = []
  private trackVisualEventHandlerUnsubscribes: unsubscribe[] = []

  private sizeListenerAttached: boolean = false

  /**
   * Gets the render order of the Slider.
   *
   * @returns {number} The render order of the Slider.
   */
  public get renderOrder(): number {
    return this._renderOrder
  }

  /**
   * Sets the render order of the Slider.
   *
   * @param order - The render order of the Slider.
   */
  public set renderOrder(order: number) {
    if (order === undefined) {
      return
    }
    super.renderOrder = order
    if (this._initialized) {
      this.applyOwnedRenderOrders()
    }
  }

  /**
   * Gets the visual representation of the slider's track fill.
   *
   * @returns {Visual} The visual object representing the track fill.
   */
  public get trackFillVisual(): Visual {
    return this._trackFillVisual
  }

  /**
   * Sets the visual representation of the slider's track fill.
   * If a previous visual exists, it will be destroyed before assigning the new one.
   * Same ownership note as {@link knobVisual}: the supplied object stays the
   * caller's to destroy, and while it carries the current fill it is layered as
   * the slider's own — kept behind the knob and left out of the depth-write
   * policy's child count.
   *
   * @param value - The new visual to be assigned to the track fill.
   */
  public set trackFillVisual(value: Visual) {
    if (value === undefined) {
      return
    }
    if (isEqual<Visual>(this._trackFillVisual, value)) {
      return
    }
    this.destroyTrackFillVisual()
    this._trackFillVisual = value
    if (this._initialized) {
      this.configureTrackFillVisual()
      this.updateFillSize()
      this.applyOwnedRenderOrders()
      // The replacement's object was appended after the knob; the knob goes back
      // in front of it (and developer children back in front of the knob). The
      // refreshChildren() inside re-runs the depth-write policy.
      this.moveKnobToFrontOfOwnedChildren()
    }
  }

  /**
   * Gets the visual representation of the slider's knob.
   *
   * @returns {Visual} The visual object representing the knob.
   */
  public get knobVisual(): Visual {
    return this._knobVisual
  }

  /**
   * Sets the visual representation of the slider's knob.
   * If a previous visual exists, it will be destroyed before assigning the new one.
   *
   * Ownership note: the slider does not take ownership of the supplied visual's
   * SceneObject (Visual.destroy() destroys components, not the object), so that
   * object is NOT registered as a managed child and release() leaves it alone.
   * For draw-order layering it still counts as the slider's own while it carries
   * the current knob (see {@link hostsSuppliedVisual}): developer-owned children
   * stay in front of it and it does not count as a child for the depth-write
   * policy. Once a later replacement retires it, the leftover object is an
   * ordinary developer-owned child again — remove or destroy it yourself.
   * Register the object via registerManagedChild() if you want the slider to
   * destroy it on release.
   *
   * @param value - The new visual to be assigned to the knob.
   */
  public set knobVisual(value: Visual) {
    if (value === undefined) {
      return
    }
    if (isEqual<Visual>(this._knobVisual, value)) {
      return
    }
    this.destroyKnobVisual()
    this._knobVisual = value
    // A replacement knob arrives visible; only a subclass rule that runs from
    // configureKnobVisual (ColorSlider) re-decides for it.
    this._knobRenderMeshEnabled = true
    if (this._initialized) {
      this.createKnobCollider()
      this.configureKnobVisual()
      this.updateKnobSize()
      this.relayoutKnobPosition()
      // Unconditional: the value has not changed, so the line above is a no-op, but
      // the replacement object arrives with whatever local position it was created at.
      this.setKnobLocalPos(this._knobPosition)
      this.syncKnobIcon()
      this.applyOwnedRenderOrders()
      // The replacement's object was appended last; developer-owned children go
      // back in front of it (invariant 7), and the depth-write policy re-runs from
      // onContentChildrenChanged. Same recovery the trackFillVisual setter does.
      this.refreshChildren()
    }
  }

  /**
   * Gets the size of the knob.
   *
   * @returns {vec2} The size of the knob.
   */
  public get knobSize(): vec2 {
    return this._knobSize
  }

  /**
   * Sets the size of the knob.
   * If the new size is different from the current size, it updates the knob size.
   *
   * Stores by copy via `copyFrom`, matching {@link Element.size}: callers may
   * reuse one vec2 across setters, and mutating it afterwards does not alias
   * this Slider's `_knobSize`. That is what lets the equality guard above be
   * trusted — stored by reference, a caller mutating its own retained vec2
   * would make `_knobSize` and `size` the same object, so the guard would
   * report "unchanged" and skip the refresh the mutation actually needs.
   *
   * @param size - The new size of the knob.
   */
  public set knobSize(size: vec2) {
    if (size === undefined) {
      return
    }
    if (isEqual<vec2>(this._knobSize, size)) {
      return
    }
    this._knobSize.copyFrom(size)
    if (this._initialized) {
      this.updateKnobSize()
      this.relayoutKnobPosition()
    }
  }

  /**
   * Optional absolute corner radius for the knob visual, in centimeters.
   * Set to null to resume the active theme's size-derived radius.
   */
  public get knobCornerRadiusOverride(): number | null {
    return this._knobCornerRadiusOverride
  }

  public set knobCornerRadiusOverride(radius: number | null) {
    if (radius === undefined || radius === this._knobCornerRadiusOverride) {
      return
    }
    this._knobCornerRadiusOverride = radius
    if (this._initialized) {
      this.updateKnobSize()
    }
  }

  /**
   * Gets a value indicating whether the slider component is draggable.
   *
   * @returns {boolean} always return true, as it is always draggable.
   */
  public get isDraggable(): boolean {
    return true
  }

  /**
   * Whether the wearer is dragging the knob right now.
   *
   * True from the drag's start until it ends. IK ends a drag right after
   * trigger end, trigger end outside and trigger cancel, so all three clear
   * it; listeners of those trigger events (including {@link onTriggerUp})
   * still read true. With snapToTriggerPosition on, that tells a drag release
   * from a tap. A default slider drags instantly (enableInstantDrag is on
   * unless snapToTriggerPosition is), so IK starts a drag on the pinch's
   * second frame and even a quick tap reads true there. It also reads false
   * as soon as the slider goes inactive, is disabled, or is destroyed
   * mid-drag, without waiting for IK's cancel to arrive.
   *
   * Always false while the slider applies a write of its own:
   * {@link resetToValue}, {@link updateCurrentValue} (and so the
   * {@link currentValue} setter and the commit at release), and knob
   * relayouts after a size, knob size or knob visual change. That holds even
   * when the write lands mid-drag, so an {@link onKnobMoved} listener can tell
   * the wearer's drag from a programmatic sync and skip writing the synced
   * value back.
   *
   * Knob motion that is not a drag reads false too: the spring that carries
   * the knob to a tapped position (snapToTriggerPosition, Switch's tap toggle)
   * and ConfirmationSlider's snap after release. That motion is
   * user-initiated, but its value was already committed through
   * {@link onValueChange} when the tap or release happened, and the frames in
   * between are animation, not input. To follow every value the wearer
   * chooses, write from onKnobMoved while isDragging (live drag) and from
   * onValueChange (taps and release commits).
   */
  public get isDragging(): boolean {
    // `inactive` is read directly: hosts such as VirtualizedLayout can
    // re-enable an inactive slider's Interactable.
    if (!this._isDragged || this._programmaticWriteDepth > 0 || this.inactive) {
      return false
    }
    // Disabling or destroying the slider disables or destroys its
    // Interactable at once, while IK only cancels the drag on its next
    // update (and never once the Interactable is gone).
    const interactable = this.interactable
    return !!interactable && !isNull(interactable) && interactable.enabled
  }

  /**
   * Gets the current value of the slider.
   * This is the actual value of the element, and is updated immediately after user input
   *
   * @returns {number} The current value.
   */
  public get currentValue(): number {
    return this._currentValue
  }

  /**
   * Sets the current value of the slider.
   *
   * @param value - The new value to set, which should be between 0 and 1.
   *
   * If the value is outside the range [0, 1] or is NaN, a warning is logged and the value is not set.
   * If the value is the same as the current value, a debug message is logged and the value is not set.
   * Otherwise, the current value is updated, a debug message is logged, the knob position is updated,
   * and the onValueChangeEvent is invoked.
   */
  public set currentValue(value: number) {
    if (value === undefined) {
      return
    }
    this.updateCurrentValue(value)
  }

  /**
   * The current position of the knob as a normalized value from 0-1.
   * This differs from the `currentValue`, as the `currentValue` may be set, while the `knobValue` is animating to that position. If you want the actual value of the element, please use `currentValue`
   *
   * @returns {number} The current knob position as a normalized 0-1 value.
   */
  public get knobValue(): number {
    return this._knobValue
  }

  /**
   * Gets the current spring animation configuration for the knob.
   *
   * @returns The current spring configuration including stiffness (k), damping, and mass values.
   *
   */
  public get knobSpringConfig(): SpringConfig {
    return {
      k: this._knobSpringAnimate.k,
      damp: this._knobSpringAnimate.damp,
      mass: this._knobSpringAnimate.mass
    }
  }

  /**
   * Updates the spring animation configuration for the knob.
   *
   * @param springConfig - The new spring configuration. Only provided properties will be updated.
   *
   */
  public set knobSpringConfig(springConfig: SpringConfig) {
    if (springConfig === undefined) {
      return
    }
    this._knobSpringAnimate.k = springConfig.k ? springConfig.k : this._knobSpringAnimate.k
    this._knobSpringAnimate.damp = springConfig.damp ? springConfig.damp : this._knobSpringAnimate.damp
    this._knobSpringAnimate.mass = springConfig.mass ? springConfig.mass : this._knobSpringAnimate.mass

    this._knobSpringAnimate.reset()
  }

  /**
   * Gets whether the slider is segmented.
   *
   * @returns {boolean} Whether the slider is segmented.
   */
  public get segmented(): boolean {
    return this._segmented
  }

  /**
   * Sets whether the slider is segmented. If the slider is segmented, the current value is updated to the closest segment.
   *
   * @param segmented - Whether the slider is segmented.
   */
  public set segmented(segmented: boolean) {
    if (segmented === undefined) {
      return
    }

    this._segmented = segmented
    if (this._segmented) {
      if (this._numberOfSegments < 2) {
        throw new Error(`Number of segments ${this._numberOfSegments} should be at least 2`)
      }

      this.updateCurrentValue(this._currentValue, false)
    }
  }

  /**
   * Gets the number of segments for the segmented slider.
   *
   * @returns {number} The number of segments for the segmented slider.
   */
  public get numberOfSegments(): number {
    return this._numberOfSegments
  }

  /**
   * Sets the number of segments for the segmented slider. If the slider is segmented, the current value is updated to the closest segment.
   *
   * @param numberOfSegments - The number of segments for the segmented slider, must be at least 2.
   */
  public set numberOfSegments(numberOfSegments: number) {
    if (numberOfSegments === undefined) {
      return
    }

    if (numberOfSegments < 2) {
      throw new Error(`Number of segments ${numberOfSegments} should be at least 2`)
    }

    this._numberOfSegments = numberOfSegments
    if (this._segmented) {
      this.updateCurrentValue(this._currentValue, false)
    }
  }

  /**
   * Updates the current value of the slider with optional animation control. If the slider is segmented, the value is rounded to the closest segment.
   *
   * @param value - The new value to set. Must be between 0 and 1 (inclusive).
   * @param shouldAnimate - Whether to animate the transition to the new value using spring physics.
   *                        When `true`, the knob will spring animate from current to target value.
   *                        When `false` (default), the knob jumps immediately to the new value.
   *
   * Runs as a programmatic write: listeners it fires read {@link isDragging}
   * as false, even mid-drag.
   */
  public updateCurrentValue(value: number, shouldAnimate: boolean = false) {
    // Inlined rather than runProgrammaticWrite: ScrollBar writes currentValue
    // every scroll frame, and the closure would allocate each time.
    this._programmaticWriteDepth++
    try {
      this.writeCurrentValue(value, shouldAnimate)
    } finally {
      this._programmaticWriteDepth--
    }
  }

  private writeCurrentValue(value: number, shouldAnimate: boolean): void {
    // Phrased so NaN fails it too; `value < 0 || value > 1` let NaN through.
    if (!(value >= 0 && value <= 1)) {
      log.w(`Value ${value} should be between 0 and 1`)
      return
    }

    if (this._segmented) {
      value = this.snapToSegment(value)
    }

    if (value === this._currentValue) {
      log.d(`slider ${this.sceneObject.name} value is already set to ${this._currentValue}`)
      return
    }

    if (this._initialized) {
      this._knobSpringAnimate.reset()
      if (!shouldAnimate) {
        this._knobValue = value
        log.d(`slider ${this.sceneObject.name} value changed to ${this._knobValue}`)
        this.updateKnobPositionFromValue()
      }
      this._currentValue = value
      this.onValueChangeEvent.invoke(this._currentValue)
    } else {
      this._currentValue = value
      this._knobValue = value
    }
  }

  /**
   * Initializes the slider component. This method sets up the visual and knob visual elements
   * if they are not already defined, and ensures the default value is within the valid range.
   */
  public initialize(): boolean {
    if (this.initialized) {
      return false
    }
    if (this._defaultValue < 0 || this._defaultValue > 1) {
      throw new Error(`Default value ${this._defaultValue} should be between 0 and 1`)
    }

    if (this._segmented && this._numberOfSegments < 2) {
      throw new Error(`Number of segments ${this._numberOfSegments} should be at least 2`)
    }

    if (!super.initialize()) {
      return false
    }

    this.applyOwnedRenderOrders()

    this.interactable.enableInstantDrag = !this.snapToTriggerPosition
    this.interactable.keepHoverOnTrigger = true

    this.configureKnobVisual()
    this.configureTrackFillVisual()

    this.updateKnobSize()

    this._knobPosition = this.getKnobPositionFromValue(this._knobValue)
    this.setKnobLocalPos(this._knobPosition)
    this.updateFillSize()

    if (!this.sizeListenerAttached) {
      this.onSizeChanged.add(() => {
        this.updateKnobSize()
        this.relayoutKnobPosition()
        this.updateFillSize()
        // Skip the track cornerRadius update for non-RoundedRectangle
        // visuals — mirrors the guard in updateKnobSize. Subclasses that
        // swap the track for a non-RR visual handle their own cornerRadius.
        if (this._visual instanceof RoundedRectangleVisual) {
          this._visual.cornerRadius = this.size.y * this.cornerRadiusFactor
        }
      })
      this.sizeListenerAttached = true
    }
    return true
  }

  protected get defaultTrackStyle(): Partial<RoundedRectangleVisualParameters> {
    const themed = this.resolveTheme()?.styles["SliderTrack"]?.["default"]
    return themed ?? SliderVisualParameters
  }

  protected get defaultKnobStyle(): Partial<RoundedRectangleVisualParameters> {
    const themed = this.resolveTheme()?.styles["SliderKnob"]?.["default"]
    return themed ?? KnobVisualParameters
  }

  protected get defaultTrackFillStyle(): Partial<RoundedRectangleVisualParameters> {
    const themed = this.resolveTheme()?.styles["SliderFill"]?.["default"]
    return themed ?? TrackVisualParameters
  }

  protected get cornerRadiusFactor(): number {
    const sliderData = this.resolveTheme()?.componentData?.["Slider"] as {cornerRadiusFactor?: number} | undefined
    return sliderData?.cornerRadiusFactor ?? DEFAULT_CORNER_RADIUS_FACTOR
  }

  // Local-Z offset for the knob relative to the track origin. Default keeps
  // the knob nominally co-planar with the track (small epsilon for
  // z-fighting). Subclasses can override — e.g. Switch's prism styles push
  // the knob forward so its back face clears the track front face.
  protected get knobZOffset(): number {
    return KNOB_Z_OFFSET
  }

  // Local-Z offset of the track fill. Subclasses that draw chrome over the fill
  // (Switch's track markers) stack from here rather than hard-coding a Z.
  protected get trackFillZOffset(): number {
    return TRACKFILL_Z_OFFSET
  }

  // Whether createDefaultVisual should mount a trackFill visual. Default
  // honors the public `hasTrackVisual` inspector input. Subclasses can
  // override to gate fill creation on internal state (e.g. Switch's prism
  // styles skip it without stomping the @input).
  protected get shouldCreateTrackFillVisual(): boolean {
    return this.hasTrackVisual
  }

  protected get knobObjectName(): string {
    return "SliderKnob"
  }

  protected get trackFillObjectName(): string {
    return "SliderTrackFill"
  }

  protected createDefaultVisual(): void {
    if (!this._visual) {
      this._visual = this.createDefaultTrackVisual()
    }
    // _knobSize default before knob creation so subclass overrides of
    // createDefaultKnobVisual can read the right size from `this._knobSize`.
    if (!this.customKnobSize) {
      this._knobSize = new vec2(this.size.y, this.size.y)
    }
    // Creation order IS the draw order under the Hierarchy Canvas: the fill
    // before the knob, so the knob stays on top without a renderOrder bump.
    // Subclasses add fill-side layers in createPreKnobVisuals(); anything
    // created after the knob draws over it.
    if (!this._trackFillVisual && this.shouldCreateTrackFillVisual) {
      this._trackFillVisual = this.createDefaultTrackFillVisual()
    }
    this.createPreKnobVisuals()
    if (!this._knobVisual) {
      this._knobVisual = this.createDefaultKnobVisual()
    } else {
      // A knob supplied before initialize sits wherever its object was authored,
      // and the fill and pre-knob layers created above were appended after it.
      // Its object is not content (hostsSuppliedVisual), so the foreground move
      // in beforeInitialized no longer drags it behind them by accident.
      this.reappendKnobObject()
    }
    this.createKnobIcon()
    if (!this._knobCollider) {
      this.createKnobCollider()
    }
  }

  /**
   * Hook for subclasses that own renderables which must draw between the track
   * fill and the knob (ConfirmationSlider's custom fill and knob backer). Runs
   * after the fill and before the knob, so tree order places them correctly.
   * Default: nothing.
   */
  protected createPreKnobVisuals(): void {}

  // Draw-order Canvas on this SceneObject (VisualElement.managesDrawOrderCanvas):
  // the track body draws first, then children in tree order — the fill, any
  // pre-knob layers, the knob (its icon content rides under the knob object),
  // and last the developer-owned children VisualElement keeps in the foreground.
  // Every owned renderable sits at ONE flat renderOrder (applyOwnedRenderOrders);
  // a bump would outrank the Canvas and lift the knob above sibling chrome.
  protected get managesDrawOrderCanvas(): boolean {
    return true
  }

  /**
   * Puts every renderable this slider owns beside the body at the body's own
   * renderOrder; layering between them is the Canvas tree order. Subclasses
   * that own more renderables (ConfirmationSlider's fill and backer, Switch's
   * track markers) extend this.
   */
  protected applyOwnedRenderOrders(): void {
    applyFlatRenderOrder(
      [this._trackFillVisual?.renderMeshVisual ?? null, this._knobVisual?.renderMeshVisual ?? null],
      this._renderOrder
    )
    if (this._knobIconContent && !isNull(this._knobIconContent)) {
      this._knobIconContent.renderOrder = this._renderOrder
    }
  }

  protected forwardCanvasBindingInvalidation(): void {
    super.forwardCanvasBindingInvalidation()
    // The knob icon's ElementContent caches its own governing-Canvas answer.
    this._knobIconContent?.invalidateCanvasBinding()
  }

  /**
   * Re-appends the knob object as the last owned child so Canvas tree order
   * draws it above every owned layer created after it, then puts the
   * developer-owned children back in the foreground. Local transforms are
   * kept as-is. For owned layers created after the knob (Switch's track
   * markers, a replaced track fill).
   */
  protected moveKnobToFrontOfOwnedChildren(): void {
    this.reappendKnobObject()
    // Unconditional on purpose: with no knob (or one parented elsewhere) the
    // caller's newly appended layer still has to yield to developer children.
    this.refreshChildren()
  }

  // Re-appends the knob object as the last child, local transform untouched.
  // No-op without a knob, or with one parented elsewhere.
  private reappendKnobObject(): void {
    const knobObject = this._knobVisual?.sceneObject
    if (knobObject && !isNull(knobObject) && knobObject.getParent() === this.sceneObject) {
      reappendChild(knobObject)
    }
  }

  /**
   * The track body owns depth occlusion. The fill and an opaque
   * (RoundedRectangle) knob are intermediate layers: they write depth like the
   * body except while developer-owned foreground children are present, so a
   * child at z≈0 that tree order places above them is not depth-rejected.
   * Blended knobs (BeveledPrismVisual) keep their own flags — opacity, not
   * position, decides those. Same policy as RadioButton / Checkbox.
   */
  public get depthWrite(): boolean {
    return super.depthWrite
  }

  public set depthWrite(depthWrite: boolean) {
    super.depthWrite = depthWrite
    if (this._initialized) {
      this.applyIntermediateFillDepthWritePolicy()
    }
  }

  protected onContentChildrenChanged(): void {
    super.onContentChildrenChanged()
    this.applyIntermediateFillDepthWritePolicy()
  }

  /**
   * A fill or knob supplied through the public setters lives on an object the
   * slider does not own (ownership note on {@link knobVisual}), so it is not a
   * managed child; for layering it is still the slider's own. Without this
   * claim a replacement fill on an unregistered object is content: the
   * refreshChildren() in the setter moves it behind the knob, where the opaque
   * System 2.0 fill paints over the knob's overlapping half, and the depth-write
   * policy sees a child for as long as it is installed.
   */
  protected hostsSuppliedVisual(child: SceneObject): boolean {
    return (
      super.hostsSuppliedVisual(child) ||
      this.isObjectOfVisual(this._trackFillVisual, child) ||
      this.isObjectOfVisual(this._knobVisual, child)
    )
  }

  private isObjectOfVisual(visual: Visual | null, child: SceneObject): boolean {
    return !!visual && !isNull(visual) && visual.sceneObject === child
  }

  protected applyIntermediateFillDepthWritePolicy(): void {
    const write = this.intermediateFillDepthWrite
    if (this._trackFillVisual && !isNull(this._trackFillVisual)) {
      this._trackFillVisual.depthWrite = write
    }
    if (this._knobVisual && !isNull(this._knobVisual) && this._knobVisual instanceof RoundedRectangleVisual) {
      this._knobVisual.depthWrite = write
    }
  }

  // RoundedRectangleVisual mounted on this.sceneObject for the track body.
  // Subclasses can override to swap in a different Visual.
  protected createDefaultTrackVisual(): Visual {
    const visual = new RoundedRectangleVisual({
      sceneObject: this.sceneObject,
      style: this.defaultTrackStyle
    })
    visual.cornerRadius = this.size.y * this.cornerRadiusFactor
    return visual
  }

  // Creates a child SceneObject for the knob, mounts a RoundedRectangleVisual
  // on it, and honors `SliderKnob.knobVisible` from theme componentData.
  // Subclasses override to swap in a different Visual (e.g. Switch's prism
  // styles return a BeveledPrismVisual directly without the RR detour).
  protected createDefaultKnobVisual(): Visual {
    // Inherit the component root's render layer so a developer-set (bespoke)
    // layer propagates onto the knob and everything parented under it (knob
    // content sources its layer from the knob). A raw createSceneObject would
    // land on the default layer regardless of parent.
    const knobObject = createChildSceneObjectWithParentLayer(this.knobObjectName, this.sceneObject)
    this.managedSceneObjects.add(knobObject)

    const visual = new RoundedRectangleVisual({
      sceneObject: knobObject,
      style: this.defaultKnobStyle
    })
    visual.cornerRadius = (this.size.y - visual.borderSize * 2) * this.cornerRadiusFactor

    const knobData = this.resolveTheme()?.componentData?.["SliderKnob"] as {knobVisible?: boolean} | undefined
    this.setKnobRenderMeshEnabled(knobData?.knobVisible !== false, visual)
    return visual
  }

  /**
   * Shows or hides the knob's RenderMeshVisual and remembers the verdict so
   * enableVisuals() can restore it after Visual.enable() has re-enabled every
   * managed component. Theme rules that decide knob visibility go through here
   * rather than writing `renderMeshVisual.enabled` directly. Pass `visual` when
   * the knob is not installed as knobVisual yet (createDefaultKnobVisual).
   */
  protected setKnobRenderMeshEnabled(enabled: boolean, visual: Visual | null = this._knobVisual): void {
    this._knobRenderMeshEnabled = enabled
    if (visual && !isNull(visual) && visual.renderMeshVisual) {
      visual.renderMeshVisual.enabled = enabled
    }
  }

  /** Whether this Slider can display knob content. Subclasses may include
   * additional texture sources that are not represented by `_knobIcon`. */
  protected get hasKnobIcon(): boolean {
    return this._knobIcon !== null
  }

  /** Texture currently displayed on the knob. */
  protected get knobIconTexture(): Texture | null {
    return this._knobIcon
  }

  /** Knob icon width/height in centimeters. */
  protected get knobIconSize(): number {
    return Math.min(this._knobSize.x, this._knobSize.y) * 0.5
  }

  /** Text to display on the knob instead of an icon, or null to use the icon.
   * Subclasses (e.g. Switch) override to mirror a text-mode side. */
  protected get knobIconText(): string | null {
    return null
  }

  /** Font size (LS units) for knob text when {@link knobIconText} is set. */
  protected get knobTextSize(): number {
    return 48
  }

  // ElementContent owns the icon renderable and layout. A dedicated carrier
  // SceneObject can be reparented when knobVisual changes without rebuilding
  // the content component.
  protected createKnobIcon(): void {
    this.syncKnobIcon()
  }

  /**
   * Synchronizes the reusable knob ElementContent with the active visual and
   * texture. Switch overrides the texture selection while sharing the same
   * ownership, resizing, and null-texture behavior.
   */
  protected syncKnobIcon(): void {
    if (!this._knobVisual || (!this.hasKnobIcon && !this._knobIconContent)) {
      return
    }

    this.ensureKnobIconContent()
    if (!this._knobContentObject || !this._knobIconContent) {
      return
    }

    const knobObject = this._knobVisual.sceneObject
    if (this._knobContentObject.getParent() !== knobObject) {
      this._knobContentObject.setParent(knobObject)
    }
    this.updateKnobContentLayer()

    this.updateKnobIconLayout()
    const text = this.knobIconText
    if (text !== null) {
      // Text mode: clear the icon and show the glyph. textSize is set before
      // the text so a freshly-created text item picks it up.
      this._knobIconContent.leadingIcon = null
      this._knobIconContent.textSize = this.knobTextSize
      this._knobIconContent.text = text
      this._knobIconContent.setRenderingEnabled(text !== "")
    } else {
      const texture = this.knobIconTexture
      // Only clear when transitioning from text so icon-only sliders (Slider,
      // ConfirmationSlider, ColorSlider) don't schedule a layout flush every sync.
      if (this._knobIconContent.text !== "") {
        this._knobIconContent.text = ""
      }
      this._knobIconContent.leadingIcon = texture
      this._knobIconContent.setRenderingEnabled(texture !== null)
    }
  }

  /** Applies an opacity multiplier to the knob icon content, if any.
   * Lets subclasses fade the icon in step with their knob visual
   * (`_knobIconContent` is private so the tween can't reach it directly). */
  protected setKnobIconOpacity(opacity: number): void {
    if (this._knobIconContent) {
      this._knobIconContent.opacity = opacity
    }
  }

  private ensureKnobIconContent(): void {
    if (this._knobContentObject && this._knobIconContent) {
      return
    }

    const contentObject = global.scene.createSceneObject("KnobContent")
    this.managedSceneObjects.add(contentObject)
    contentObject.layer = this._knobVisual.sceneObject.layer
    contentObject.setParent(this._knobVisual.sceneObject)

    const content = contentObject.createComponent(ElementContent.getTypeName()) as ElementContent
    content.text = ""
    content.trailingIcon = null
    content.textAlignment = TextAlignment.Center
    content.spacing = 0
    content.padding = {top: 0, right: 0, bottom: 0, left: 0}
    content.autoResize = false
    // The previous raw Image icon was untinted white; keep that appearance
    // while delegating renderable ownership and layout to ElementContent.
    content.useThemeColors = false

    this._knobContentObject = contentObject
    this._knobIconContent = content
  }

  private updateKnobIconLayout(): void {
    if (!this._knobContentObject || !this._knobIconContent || !this._knobVisual) {
      return
    }
    this._knobContentObject.getTransform().setLocalPosition(new vec3(0, 0, this._knobVisual.contentZOffset))
    this._knobIconContent.sizeOverride = new vec2(this._knobSize.x, this._knobSize.y)
    this._knobIconContent.leadingIconSize = this.knobIconSize
    // Shares the knob visual's render order; the icon draws above it via child
    // draw-order + the contentZOffset Z anchor. The knob content sits on its
    // own SceneObject under the knob visual rather than beside a VisualElement,
    // so it can't discover a host to source this from — hand it over, or a
    // blended knob (BeveledPrismVisual, Switch's prism styles) blends over the
    // icon below 1.7cm depth. ElementContent still suppresses it under a
    // Hierarchy-sorting Canvas.
    this._knobIconContent.hostRenderOrderOffset = this._knobVisual.contentRenderOrderOffset
    this._knobIconContent.renderOrder = this._renderOrder
  }

  private updateKnobContentLayer(): void {
    if (!this._knobContentObject || !this._knobVisual) return
    const layer = this._knobVisual.sceneObject.layer
    const applyLayer = (sceneObject: SceneObject): void => {
      sceneObject.layer = layer
      for (const child of sceneObject.children) {
        applyLayer(child)
      }
    }
    applyLayer(this._knobContentObject)
  }

  // Creates a child SceneObject for the fill and mounts a RoundedRectangleVisual.
  protected createDefaultTrackFillVisual(): Visual {
    // Inherit the component root's render layer (see createDefaultKnobVisual).
    const trackFillObject = createChildSceneObjectWithParentLayer(this.trackFillObjectName, this.sceneObject)
    this.managedSceneObjects.add(trackFillObject)

    return new RoundedRectangleVisual({
      sceneObject: trackFillObject,
      style: this.defaultTrackFillStyle
    })
  }

  protected configureVisual(): void {
    super.configureVisual()
    if (this._visual) {
      this.visualEventHandlerUnsubscribes.push(
        this._visual.onDestroyed.add(() => {
          // knobs and trackFill are children of the visual
          this.destroyKnobCollider()
          this._trackFillVisual = null
          this._knobVisual = null
        })
      )
    }
  }

  protected configureKnobVisual(): void {
    if (this._knobVisual) {
      this.knobVisualEventHandlerUnsubscribes.push(
        this._knobVisual.onDestroyed.add(() => {
          this.destroyKnobCollider()
          this._knobIconContent?.setRenderingEnabled(false)
          this._knobVisual = null
        }),
        this._knobVisual.onContentZOffsetChanged.add(() => this.updateKnobIconLayout())
      )
    }
  }

  private destroyKnobVisual(): void {
    this.knobVisualEventHandlerUnsubscribes.forEach((unsubscribe) => unsubscribe())
    this.knobVisualEventHandlerUnsubscribes = []
    this.destroyKnobCollider()
    if (this._knobVisual) {
      this._knobVisual.destroy()
      this._knobVisual = null
    }
  }

  private configureTrackFillVisual(): void {
    if (this._trackFillVisual) {
      this.trackVisualEventHandlerUnsubscribes.push(
        this._trackFillVisual.onDestroyed.add(() => {
          this._trackFillVisual = null
        })
      )
    }
  }

  private destroyTrackFillVisual(): void {
    this.trackVisualEventHandlerUnsubscribes.forEach((unsubscribe) => unsubscribe())
    this.trackVisualEventHandlerUnsubscribes = []
    if (this._trackFillVisual) {
      this._trackFillVisual.destroy()
      this._trackFillVisual = null
    }
  }

  protected setUpEventCallbacks(): void {
    if (this.addCallbacks) {
      this.onValueChange.add(createCallbacks(this.onValueChangeCallbacks))
    }
    super.setUpEventCallbacks()
  }

  protected onTriggerDownHandler(stateEvent: InteractorEvent) {
    super.onTriggerDownHandler(stateEvent)
    // Toggles (e.g. Switch) only play TriggerEnd via Element on trigger up.
    if (stateEvent.propagationPhase === "Target" && !this.isToggle) {
      this.playAudioTrack(TRIGGER_START_AUDIO_TRACK, TRIGGER_START_AUDIO_VOLUME)
    }
  }

  protected onTriggerUpHandler(stateEvent: InteractorEvent) {
    super.onTriggerUpHandler(stateEvent)
    this.onTriggerRespond(stateEvent)
  }

  protected onTriggerRespond(event: InteractorEvent) {
    if (!this._isDragged) {
      if (this.snapToTriggerPosition) {
        const triggerValue = clamp(
          (this.transform.getInvertedWorldTransform().multiplyPoint(event.interactor.planecastPoint).x +
            this.size.x / 2) /
            this.size.x,
          0,
          1
        )
        this.updateCurrentValue(triggerValue, true)
      }
    }
  }

  protected onInteractableDragStart(dragEvent: DragInteractorEvent): void {
    super.onInteractableDragStart(dragEvent)
    this._initialDragPosition = this.getInteractionPosition(dragEvent.interactor)
    this._knobValueAtDragStart = this._currentValue
  }

  protected onInteractableDragUpdate(dragEvent: DragInteractorEvent): void {
    if (this._isDragged) {
      if (dragEvent.interactor) {
        const currentDragPosition = this.getInteractionPosition(dragEvent.interactor)
        const dragDelta = currentDragPosition.sub(this._initialDragPosition).x
        const unclampedValue =
          this._knobValueAtDragStart +
          (this._segmented ? Math.round(dragDelta / this.stateInterval) * this.stateInterval : dragDelta) /
            this.trackLength
        const newValue = clamp(unclampedValue, 0, 1)
        const valueChanged = this._knobValue !== newValue
        if (valueChanged) {
          this._knobValue = newValue
          log.d(`slider ${this.sceneObject.name} updating to ${this._knobValue}`)
          this.updateKnobPositionFromValue()
        }
      }
    }
    super.onInteractableDragUpdate(dragEvent)
  }

  protected onInteractableDragEnd(dragEvent: DragInteractorEvent): void {
    const wasDragged = this._isDragged
    try {
      if (wasDragged) {
        // The release ends the drag, so the commit reads isDragging as false.
        this._programmaticWriteDepth++
        try {
          // Commit through the public virtual path so subclasses can synchronize
          // state derived from the value (for example, Switch's side-specific icon).
          commitSliderDragValue(this)
          this.updateKnobPositionFromValue()
        } finally {
          this._programmaticWriteDepth--
        }
      }
    } finally {
      // Runs even when a commit listener throws: super clears _isDragged, and
      // skipping it would leave isDragging true after the release.
      if (wasDragged) {
        this._knobSpringAnimate.reset()
      }
      super.onInteractableDragEnd(dragEvent)
    }
  }

  protected update(): void {
    if (!this._knobVisual) {
      return
    }
    if (this._isDragged) {
      return
    }
    if (Math.abs(this._knobValue - this._currentValue) <= SPRING_EPSILON) {
      return
    }
    const min = Math.min(this._currentValue, this._knobValue)
    const max = Math.max(this._currentValue, this._knobValue)
    this._springCurrent.x = this._knobValue
    this._springTarget.x = this._currentValue
    this._springResult.x = this._knobValue
    this._knobSpringAnimate.evaluate(this._springCurrent, this._springTarget, this._springResult)
    this._knobValue = clamp(this._springResult.x, min, max)
    if (Math.abs(this._knobValue - this._currentValue) <= SPRING_EPSILON) {
      this._knobValue = this._currentValue
    }
    this.updateKnobPositionFromValue()
  }

  /**
   * Sets width, height, and knob size in a single pass to avoid redundant
   * recalculation rounds when multiple dimensions change at once.
   * @param width - The new slider width.
   * @param height - The new slider height.
   * @param knobSize - The new knob size. Stored by copy, so the caller may
   * reuse or mutate the vector afterwards.
   */
  public resetDimensions(width: number, height: number, knobSize: vec2): void {
    const knobSizeChanged = !isEqual<vec2>(this._knobSize, knobSize)
    // Copy, don't alias (see the knobSize setter): a retained-and-mutated
    // caller vec2 would otherwise be the same object as `_knobSize`, and the
    // comparison above could never observe the change.
    this._knobSize.copyFrom(knobSize)
    const nextSize = new vec3(width, height, this.size.z)
    const sizeChanged = !isEqual<vec3>(this.size, nextSize)
    this.size = nextSize
    // The size write drives the knob refresh through the size-changed
    // listener, which is why this can set both in one pass. An unchanged
    // size never fires it (Element.size is equality-guarded), so a
    // knob-size-only call has to refresh explicitly — otherwise the knob
    // visual, its collider, and any subclass geometry keyed to the knob
    // width all keep their previous size. Mirrors the `knobSize` setter.
    if (knobSizeChanged && !sizeChanged && this._initialized) {
      this.updateKnobSize()
      this.relayoutKnobPosition()
    }
  }

  /**
   * Unconditionally resets the slider to the given value without firing
   * {@link onValueChange}. Bypasses the same-value guard in
   * {@link updateCurrentValue}, resets the spring, and repositions the knob
   * in a single pass.
   *
   * Moving the knob still fires {@link onKnobMoved}, which is what keeps
   * knob-following UI (labels, icons, ConfirmationSlider's backer) in step
   * with a sync. {@link isDragging} reads false inside those listeners, even
   * when the reset lands mid-drag, so a listener that writes live drag values
   * somewhere can skip the synced value instead of echoing it back.
   * @param value - The value to reset to (0–1).
   */
  public resetToValue(value: number): void {
    this._programmaticWriteDepth++
    try {
      this._currentValue = value
      this._knobValue = value
      this._knobSpringAnimate.reset()
      if (this._initialized) {
        this.updateKnobPositionFromValue()
      }
    } finally {
      this._programmaticWriteDepth--
    }
  }

  /**
   * Runs a write the slider makes on its own behalf (a value sync or a
   * relayout) so that everything it fires reads {@link isDragging} as false.
   * Nests. Subclass overrides of the programmatic APIs wrap their extra work
   * in it; Slider's own writes inline the same counter to stay
   * allocation-free on per-frame paths.
   */
  protected runProgrammaticWrite(write: () => void): void {
    this._programmaticWriteDepth++
    try {
      write()
    } finally {
      this._programmaticWriteDepth--
    }
  }

  // Repositions the knob after a relayout (size, knob size, knob visual). The
  // wearer did not move it, so onKnobMoved listeners read isDragging false.
  protected relayoutKnobPosition(): void {
    this._programmaticWriteDepth++
    try {
      this.updateKnobPositionFromValue()
    } finally {
      this._programmaticWriteDepth--
    }
  }

  protected updateKnobPositionFromValue() {
    if (!this._knobVisual) {
      return
    }
    const oldKnobPosition = this._knobPosition
    this._knobPosition = this.getKnobPositionFromValue(this._knobValue)
    // Also when only Z went stale: knobZOffset derives from size.z for the prism
    // knobs (Switch, ConfirmationSlider), and a resize that touches only size.z
    // leaves X unchanged. Going through updateKnobPosition also fires
    // onKnobMoved, which is what carries ConfirmationSlider's backer along.
    if (this._knobPosition !== oldKnobPosition || this._appliedKnobZ !== this.knobZOffset) {
      this.updateKnobPosition(this._knobPosition)
    }
  }

  private updateKnobPosition(value: number) {
    this.setKnobLocalPos(value)
    this.updateFillSize()
    this.markClipCollidersDirty()
    this.onKnobMovedEvent.invoke(this.knobValue)
  }

  // Writes the knob's local position via the cached vec3, refreshing Z
  // from `knobZOffset` on every call so a runtime change in size.z
  // (Switch's prism styles depend on it) doesn't leave the stored Z stale.
  private setKnobLocalPos(x: number): void {
    if (!this._knobVisual) return
    this._knobLocalPos.x = x
    this._knobLocalPos.z = this.knobZOffset
    this._appliedKnobZ = this.knobZOffset
    this._knobVisual.transform.setLocalPosition(this._knobLocalPos)
  }

  protected setState(stateName: StateName) {
    super.setState(stateName)
    this._knobVisual?.setState(stateName)
    this._trackFillVisual?.setState(stateName)
  }

  /**
   * Resizes the knob visual, its corner radius, and its collider from the
   * current knob size. Runs on every path that can change the knob's
   * rendered width — the size listener, the `knobSize` and `knobVisual`
   * setters, and {@link resetDimensions} — so a subclass whose visuals are
   * laid out from the knob width (e.g. ColorSlider's inset track gradient)
   * can override this and rebuild after calling `super`.
   */
  protected updateKnobSize() {
    if (!this._knobVisual) {
      return
    }
    this._knobVisual.size = this._visual.hasBorder
      ? new vec3(
          this._knobSize.x - this._visual.borderSize * 2,
          this._knobSize.y - this._visual.borderSize * 2,
          this.size.z
        )
      : new vec3(this._knobSize.x, this._knobSize.y, this.size.z)
    // Skip cornerRadius update for non-RoundedRectangle knobs (e.g. the
    // BeveledPrismVisual used by Switch's prism styles). Those visuals set
    // their own cornerRadius from the theme; Switch.ts handles any
    // size-derived overrides (pill knob = half-height) directly.
    if (this._knobVisual instanceof RoundedRectangleVisual) {
      this._knobVisual.cornerRadius =
        this._knobCornerRadiusOverride ?? this._knobVisual.size.y * this.cornerRadiusFactor
    }

    if (this._knobCollider) {
      const knobShape = Shape.createBoxShape()
      knobShape.size = new vec3(this._knobSize.x, this._knobSize.y, this.size.z)
      this._knobCollider.shape = knobShape
      this.markClipCollidersDirty()
    }

    this.updateKnobIconLayout()
  }

  // collider is discovered by the interaction manager and attached to slider interactible
  // otherwise if knob is bigger than track, it won't be responsive
  private createKnobCollider(): void {
    if (!this._knobVisual) {
      return
    }
    this._knobCollider = this._knobVisual.sceneObject.createComponent("ColliderComponent")
    this._knobCollider.fitVisual = false
    this._knobCollider.enabled = !this.inactive
    const knobShape = Shape.createBoxShape()
    knobShape.size = new vec3(this._knobSize.x, this._knobSize.y, this.size.z)
    this._knobCollider.shape = knobShape
    // Interaction component: the base keeps it disabled while inactive (and
    // across a disabled->enabled transition) without Slider re-asserting it.
    this.addInteractionComponent(this._knobCollider)
    this._clipColliders = [this._knobCollider]
    this.markClipCollidersDirty()
  }

  private removeKnobColliderFromInteractable(knobCollider: ColliderComponent): void {
    const interactable = this.interactable
    if (!interactable || isNull(interactable) || !interactable.colliders) {
      return
    }
    // Unwire before destroy so later OnDisable cascades do not iterate stale destroyed handles.
    interactable.colliders = interactable.colliders.filter((collider) => {
      if (!collider || isNull(collider)) return false
      return !collider.isSame(knobCollider)
    })
  }

  private destroyKnobCollider(): void {
    const hadClipColliders = this._clipColliders.length > 0
    this._clipColliders = []
    const knobCollider = this._knobCollider
    if (knobCollider) {
      this.removeManagedComponent(knobCollider)
      if (!isNull(knobCollider)) {
        this.removeKnobColliderFromInteractable(knobCollider)
        knobCollider.destroy()
      }
      this._knobCollider = null
    }
    if (hadClipColliders || knobCollider) {
      this.markClipCollidersDirty()
    }
  }

  private markClipCollidersDirty(): void {
    this.onClipCollidersDirtyEvent.invoke()
  }

  public override get inactive(): boolean {
    return super.inactive
  }

  public override set inactive(inactive: boolean) {
    const wasInactive = super.inactive
    super.inactive = inactive
    if (wasInactive !== super.inactive) {
      // The base toggles the knob collider via its interaction-component
      // registration; Slider only needs to refresh clip colliders on change.
      this.markClipCollidersDirty()
    }
  }

  private updateFillSize() {
    if (!this._trackFillVisual) {
      return
    }
    const borderSize = (this._visual as RoundedRectangleVisual).borderSize
    const fillSize = this.trackFillVisual.size.uniformScale(1)
    fillSize.y = this.size.y - borderSize * 2
    fillSize.x = lerp(fillSize.y, this.size.x - borderSize * 2, this.knobValue)
    this._trackFillLocalPos.x = lerp((this.size.x - borderSize * 2) * -0.5 + fillSize.y * 0.5, 0, this.knobValue)
    // Refresh Z from the getter on every call, like setKnobLocalPos does for the
    // knob: subclasses stack chrome from `trackFillZOffset` (Switch's markers), so
    // an override must move the fill itself, not just what sits above it.
    this._trackFillLocalPos.z = this.trackFillZOffset
    this.trackFillVisual.transform.setLocalPosition(this._trackFillLocalPos)
    ;(this.trackFillVisual as RoundedRectangleVisual).cornerRadius = fillSize.y * this.cornerRadiusFactor
    this.trackFillVisual.size = fillSize
  }

  protected getKnobPositionFromValue(value: number): number {
    return (value - 0.5) * (this.size.x - this.knobSize.x)
  }

  protected get trackLength(): number {
    return this.size.x - this._knobSize.x
  }

  /**
   * Axis-aligned box colliders exposed to VirtualizedLayout for explicit
   * sub-collider clipping. VirtualizedLayout treats clipping as an
   * all-or-nothing enabled/debugDraw mask; it does not resize these colliders.
   *
   * Returned colliders should remain stable until the slider is structurally
   * invalidated or rebuilt. `onClipCollidersDirty` wakes clipping for cached
   * collider transform, size, or provider-enabled intent changes; it does not
   * make VirtualizedLayout rediscover replacement colliders. `isClipColliderEnabled`
   * reports Slider-owned enabled intent independent of VirtualizedLayout's mask.
   */
  public get clipColliders(): ColliderComponent[] {
    return this._clipColliders
  }

  public isClipColliderEnabled(collider: ColliderComponent): boolean {
    if (!collider || isNull(collider) || !this._knobCollider || isNull(this._knobCollider)) {
      return false
    }
    return collider.isSame(this._knobCollider) && !this.inactive
  }

  private get stateInterval(): number {
    return (1.0 / (this._numberOfSegments - 1)) * this.trackLength
  }

  private snapToSegment(value: number): number {
    const segmentStep = 1 / (this._numberOfSegments - 1)
    return clamp(Math.round(value / segmentStep) * segmentStep, 0, 1)
  }

  protected enableVisuals() {
    super.enableVisuals()
    if (this._initialized) {
      if (!isNull(this.knobVisual) && this.knobVisual) {
        this.knobVisual.enable()
        // Visual.enable() just re-enabled the knob's RenderMeshVisual along with
        // everything else it manages; restore the theme's verdict (hidden under
        // System 3.0) so the cycle doesn't resurrect a knob the theme hid.
        this.setKnobRenderMeshEnabled(this._knobRenderMeshEnabled)
      }
      if (!isNull(this.trackFillVisual) && this.trackFillVisual) {
        this.trackFillVisual.enable()
      }
    }
  }

  protected disableVisuals() {
    super.disableVisuals()
    if (this._initialized) {
      if (!isNull(this.knobVisual) && this.knobVisual) {
        this.knobVisual.disable()
      }
      if (!isNull(this.trackFillVisual) && this.trackFillVisual) {
        this.trackFillVisual.disable()
      }
    }
  }

  protected release(): void {
    this.destroyKnobCollider()
    if (!isNull(this.knobVisual) && this.knobVisual) {
      this._knobVisual?.destroy()
    }
    this._knobVisual = null
    if (!isNull(this.trackFillVisual) && this.trackFillVisual) {
      this._trackFillVisual.destroy()
    }
    this._trackFillVisual = null
    super.release()
  }
}

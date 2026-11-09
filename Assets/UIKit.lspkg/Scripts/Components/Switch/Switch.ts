import {DragInteractorEvent, InteractorEvent} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import Event, {PublicApi} from "InteractionKit.lspkg/Utils/Event"
import {
  DarkerLessGray,
  DarkestGray,
  DarkGray,
  DarkWarmGray,
  MediumDarkGray,
  MediumWarmGray,
  SwitchBorderYellowBright,
  SwitchBorderYellowBrighter,
  SwitchBorderYellowLight,
  SwitchBorderYellowMedium,
  SwitchHoverOrange,
  SwitchHoverYellow,
  SwitchKnobBorderGray,
  SwitchKnobBorderTransparent,
  SwitchKnobBorderTransparentHover,
  SwitchKnobBorderYellow,
  SwitchKnobBorderYellowBright,
  SwitchKnobBorderYellowHover,
  SwitchKnobBorderYellowMedium,
  SwitchKnobGray,
  SwitchTrackBorderGray,
  SwitchTrackBorderTransparent,
  SwitchTrackFillGray,
  SwitchTrackGray,
  SwitchTrackYellowDark,
  SwitchTrackYellowMedium,
  SwitchYellowBright,
  SwitchYellowBrightestHover,
  SwitchYellowBrightHover,
  SwitchYellowDark,
  TriggeredBorderYellow
} from "../../Themes/System-2.0/Colors"
import {SwitchKnobAspect, SwitchStyle} from "../../Themes/System-3.0/Styles/SwitchParameters"
import {SYSTEM_3_NAME} from "../../Themes/Theme"
import {IMAGE_MATERIAL_ASSET} from "../../Utility/Assets"
import {applyFlatRenderOrder, Z_LAYER_STEP} from "../../Utility/DrawOrderLayering"
import {Callback, createCallbacks, createChildSceneObjectWithParentLayer} from "../../Utility/SceneUtilities"
import {setTextRect} from "../../Utility/UIKitUtilities"
import {BeveledPrismVisual} from "../../Visuals/BeveledPrism/BeveledPrismVisual"
import {RoundedRectangleVisualParameters} from "../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {Visual} from "../../Visuals/Visual"
import {Slider} from "../Slider/Slider"
import {Toggleable} from "../Toggle/Toggleable"

// _trackIconSize is a cm footprint (icon markers scale a unit quad by it). Text
// markers need a font size in LS units, so map cm -> font size with this
// empirical factor to keep text and icon markers a similar footprint. Tunable.
const TRACK_TEXT_SIZE_PER_CM = 32

// Track visual style
const trackStyle: Partial<RoundedRectangleVisualParameters> = {
  default: {
    baseGradient: {
      type: "Linear",
      start: new vec2(-1, 0),
      end: new vec2(1, 0),
      stop0: {percent: 0, color: SwitchTrackGray},
      stop1: {percent: 0.5, color: SwitchTrackGray},
      stop2: {percent: 1, color: SwitchTrackGray}
    },
    baseType: "Gradient",
    hasBorder: true,
    borderSize: 0.1,
    borderType: "Gradient",
    borderGradient: {
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {percent: 0, color: SwitchTrackBorderGray},
      stop1: {percent: 0.5, color: SwitchTrackBorderTransparent},
      stop2: {percent: 1, color: SwitchTrackBorderGray}
    }
  },
  hovered: {
    baseGradient: {
      start: new vec2(0, 1.8),
      end: new vec2(0, -1.8),
      stop0: {percent: 0, color: DarkGray},
      stop1: {percent: 0.5, color: DarkGray},
      stop2: {percent: 1, color: MediumDarkGray}
    }
  },
  triggered: {
    baseGradient: {
      start: new vec2(-1, 0),
      end: new vec2(1, 0),
      stop0: {percent: 0, color: SwitchTrackGray},
      stop1: {percent: 0.5, color: SwitchTrackGray},
      stop2: {percent: 1, color: SwitchTrackGray}
    }
  },
  toggledDefault: {
    borderGradient: {
      type: "Linear",
      start: new vec2(-0.9, 1),
      end: new vec2(0.9, -1),
      stop0: {percent: 0, color: SwitchBorderYellowLight},
      stop1: {percent: 0.55, color: SwitchBorderYellowMedium},
      stop2: {percent: 1, color: SwitchBorderYellowLight}
    }
  },
  toggledHovered: {
    borderGradient: {
      type: "Linear",
      start: new vec2(-0.9, 1),
      end: new vec2(0.9, -1),
      stop0: {percent: 0, color: SwitchBorderYellowBright},
      stop1: {percent: 0.55, color: SwitchBorderYellowBrighter},
      stop2: {percent: 1, color: SwitchBorderYellowBright}
    }
  },
  toggledTriggered: {
    borderGradient: {
      type: "Linear",
      start: new vec2(-0.9, 1),
      end: new vec2(0.9, -1),
      stop0: {percent: 0, color: SwitchBorderYellowLight},
      stop1: {percent: 0.55, color: SwitchBorderYellowMedium},
      stop2: {percent: 1, color: SwitchBorderYellowLight}
    }
  }
}

// Track Fill visual style
const trackFillStyle: Partial<RoundedRectangleVisualParameters> = {
  default: {
    baseGradient: {
      type: "Linear",
      start: new vec2(-1, 0),
      end: new vec2(1, 0),
      stop0: {percent: 0, color: SwitchTrackFillGray},
      stop1: {percent: 1, color: SwitchTrackFillGray}
    },
    baseType: "Gradient"
  },
  hovered: {
    baseGradient: {
      type: "Linear",
      start: new vec2(-1, 0),
      end: new vec2(1, 0),
      stop0: {percent: 0, color: SwitchHoverOrange},
      stop1: {percent: 1, color: SwitchHoverYellow}
    }
  },
  toggledDefault: {
    baseGradient: {
      type: "Linear",
      start: new vec2(-1, 0),
      end: new vec2(1, 0),
      stop0: {percent: 0, color: SwitchTrackYellowDark},
      stop1: {percent: 1, color: SwitchTrackYellowDark}
    }
  },
  toggledHovered: {
    baseGradient: {
      type: "Linear",
      start: new vec2(-1, 0),
      end: new vec2(1, 0),
      stop0: {percent: 0, color: SwitchTrackYellowMedium},
      stop1: {percent: 1, color: SwitchTrackYellowMedium}
    }
  },
  toggledTriggered: {
    baseGradient: {
      type: "Linear",
      start: new vec2(-1, 0),
      end: new vec2(1, 0),
      stop0: {percent: 0, color: SwitchTrackYellowDark},
      stop1: {percent: 1, color: SwitchTrackYellowDark}
    }
  }
}

// Knob visual style
const knobStyle: Partial<RoundedRectangleVisualParameters> = {
  default: {
    baseGradient: {
      enabled: true,
      type: "Linear",
      start: new vec2(-1, 1),
      end: new vec2(1, -1),
      stop0: {percent: 0, color: DarkestGray},
      stop1: {percent: 1, color: DarkWarmGray}
    },
    baseType: "Gradient",
    hasBorder: true,
    borderSize: 0.05,
    borderType: "Gradient",
    borderGradient: {
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {percent: 0, color: SwitchKnobBorderGray},
      stop1: {percent: 1, color: SwitchKnobBorderTransparent}
    }
  },
  hovered: {
    baseGradient: {
      enabled: true,
      type: "Linear",
      start: new vec2(-1, 1),
      end: new vec2(1, -1),
      stop0: {percent: 0, color: DarkerLessGray},
      stop1: {percent: 1, color: SwitchKnobGray}
    },
    borderGradient: {
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {percent: 0, color: MediumWarmGray},
      stop1: {percent: 1, color: SwitchKnobBorderTransparentHover}
    }
  },
  triggered: {
    baseGradient: {
      enabled: true,
      type: "Linear",
      stop0: {percent: 0, color: SwitchYellowDark},
      stop1: {percent: 1, color: SwitchYellowBright}
    }
  },
  toggledDefault: {
    baseGradient: {
      enabled: true,
      type: "Linear",
      stop0: {percent: 0, color: SwitchYellowDark},
      stop1: {percent: 1, color: SwitchYellowBright}
    },
    borderGradient: {
      type: "Linear",
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {percent: 0, color: SwitchKnobBorderYellow},
      stop1: {percent: 0.55, color: SwitchKnobBorderYellowMedium},
      stop2: {percent: 1, color: SwitchKnobBorderYellowBright}
    }
  },
  toggledHovered: {
    baseGradient: {
      enabled: true,
      type: "Linear",
      stop0: {percent: 0, color: SwitchYellowBrightHover},
      stop1: {percent: 1, color: SwitchYellowBrightestHover}
    },
    borderGradient: {
      type: "Linear",
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {percent: 0, color: TriggeredBorderYellow},
      stop1: {percent: 0.55, color: SwitchKnobBorderYellowHover},
      stop2: {percent: 1, color: TriggeredBorderYellow}
    }
  },
  toggledTriggered: {
    baseGradient: {
      enabled: true,
      type: "Linear",
      stop0: {percent: 0, color: SwitchYellowDark},
      stop1: {percent: 1, color: SwitchYellowBright}
    },
    borderGradient: {
      type: "Linear",
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {percent: 0, color: SwitchKnobBorderYellow},
      stop1: {percent: 0.55, color: SwitchKnobBorderYellowMedium},
      stop2: {percent: 1, color: SwitchKnobBorderYellowBright}
    }
  }
}

/**
 * Represents a Switch component that extends the Slider functionality.
 *
 * @extends Slider
 * @implements Toggleable
 */
@component
export class Switch extends Slider implements Toggleable {
  @input
  @hint("Size of the element in centimeters")
  protected _size: vec3 = new vec3(4.5, 2.5, 1)

  @input
  @showIf("_themeOverride", "System3")
  @label("Style")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Flat", "Flat"),
      new ComboBoxItem("Prism", "Prism"),
      new ComboBoxItem("PrismWide", "PrismWide"),
      new ComboBoxItem("PrismSquare", "PrismSquare")
    ])
  )
  protected _styleSystem3: string = "Flat"

  @input
  @showIf("addCallbacks")
  @label("On Interaction Finished Callbacks")
  private onFinishedCallbacks: Callback[] = []

  @input("int")
  @hint("The default state of the switch")
  @widget(new ComboBoxWidget([new ComboBoxItem("Off", 0), new ComboBoxItem("On", 1)]))
  protected _defaultValue: number = 0

  @input
  @label("Left Marker Is Text")
  @hint("Show text on the left half of the track instead of an icon image.")
  protected _leftIsText: boolean = false

  @input
  @allowUndefined
  @showIf("_leftIsText", false)
  @hint("Optional icon pinned to the left half of the track (stays above the knob).")
  protected _leftIcon: Texture | null = null

  @input
  @showIf("_leftIsText", true)
  @label("Left Text")
  @hint("Short label/glyph pinned to the left half of the track (stays above the knob).")
  protected _leftText: string = ""

  @input
  @label("Right Marker Is Text")
  @hint("Show text on the right half of the track instead of an icon image.")
  protected _rightIsText: boolean = false

  @input
  @allowUndefined
  @showIf("_rightIsText", false)
  @hint("Optional icon pinned to the right half of the track (stays above the knob).")
  protected _rightIcon: Texture | null = null

  @input
  @showIf("_rightIsText", true)
  @label("Right Text")
  @hint("Short label/glyph pinned to the right half of the track (stays above the knob).")
  protected _rightText: string = ""

  @input
  @hint("Width/height (cm) of the left/right track markers. Text markers derive their font size from this.")
  protected _trackIconSize: number = 1.5

  // Hidden inputs
  protected _segmented: boolean = true
  protected snapToTriggerPosition: boolean = true
  protected _numberOfSegments: number = 2
  protected get isToggle(): boolean {
    return true
  }

  protected get effectiveStyle(): SwitchStyle | undefined {
    if (this.resolveTheme()?.name !== SYSTEM_3_NAME) return undefined
    const raw = this._styleSystem3
    // Migrate old System3 style names that were removed in favor of the
    // Prism family. Without this, stale scenes serialized with "Float" or
    // "System" would pass the string through unchecked and miss the theme
    // lookup, silently downgrading to the System2 fallback.
    if (raw === "Float" || raw === "System") return "Flat"
    return raw as SwitchStyle
  }

  /** Theme-styles lookup key. Falls back to "default" for non-System3 themes (System2 keys its
   * SwitchParameters under "default"). System3 themes hit "Flat" | "Prism" | "PrismWide" | "PrismSquare". */
  private get styleKey(): string {
    return this.effectiveStyle ?? "default"
  }

  /**
   * An internal event invoked when the switch interaction is finished.
   *
   * @remarks
   * The `explicit` parameter indicates the source of the change:
   * - `true` — triggered by direct user interaction or developer action.
   * - `false` — triggered programmatically by a ToggleGroup.
   */
  private onFinishedEvent: Event<boolean> = new Event()
  private _onFinished?: PublicApi<boolean>
  public get onFinished(): PublicApi<boolean> {
    return (this._onFinished ??= this.onFinishedEvent.publicApi())
  }

  /**
   * Gets the current state of the switch.
   *
   * @returns {boolean} - Returns `true` if the switch's current state is not set to 0, otherwise `false`.
   */
  public get isOn(): boolean {
    return this._currentValue !== 0
  }

  /**
   * Sets the state of the switch to either "on" or "off".
   *
   * @param on - A boolean value indicating whether the switch should be turned on (`true`) or off (`false`).
   */
  public set isOn(on: boolean) {
    if (on === undefined) {
      return
    }
    this.setOn(on, false)
  }

  /**
   * Toggles the switch to the on/off state.
   *
   * This method sets the current state of the switch to 1 or 0 and updates the knob position accordingly.
   * @param on - A boolean value indicating the desired toggle state.
   */
  public toggle(on: boolean): void {
    this.setOn(on, true)
  }

  // Gray background markers (Image or Text per side); owned renderables, so they
  // sit at the switch's flat renderOrder like the knob (applyOwnedRenderOrders).
  private trackMarkers: BaseMeshVisual[] = []
  // Set once a script writes knobSize; the style then leaves the knob size alone.
  private _knobSizePinned: boolean = false

  /**
   * Initializes the switch component.
   *
   * This method sets the default state
   */
  public initialize(): boolean {
    if (!super.initialize()) {
      return false
    }
    // Snap the startup sync so a pre-init snapToValue/isOn write doesn't tween.
    this.withZeroAnimateDuration(() => {
      this._interactableStateMachine.toggle = this.currentValue > 0
    })
    this.createSwitchIcons()
    this.updateSwitchKnobIcon()
    return true
  }

  // Gray background icons are pinned to each half of the track. Slider's
  // ElementContent-backed knob icon rides the knob and swaps texture by side.
  // The markers are created after the knob (post-initialize), so the knob is
  // re-appended last: the switch's Hierarchy Canvas then paints it above the
  // background pair, and developer children go back in front of the knob.
  private createSwitchIcons(): void {
    // Markers are transparent chrome drawn AFTER the fill (System 2.0 has one at
    // trackFillZOffset) and BEFORE the knob. Against the opaque, depth-writing fill
    // an equal Z is a coin toss (LESS rejects, LEQUAL z-fights), so they sit a real
    // Z_LAYER_STEP above it; against the knob they rely on draw order alone — they
    // never write depth, so the later-drawn knob paints over them at any Z.
    const markerZ = this.trackFillZOffset + Z_LAYER_STEP
    const makeImageBg = (name: string, texture: Texture, x: number) => {
      const obj = global.scene.createSceneObject(name)
      this.managedSceneObjects.add(obj)
      obj.layer = this.sceneObject.layer
      obj.setParent(this.sceneObject)
      const image = obj.createComponent("Component.Image") as Image
      image.mainMaterial = IMAGE_MATERIAL_ASSET.clone()
      image.mainPass.baseTex = texture
      image.mainPass.baseColor = new vec4(0.6, 0.6, 0.6, 1) // idle gray
      image.stretchMode = StretchMode.Stretch
      image.mainPass.depthTest = true
      image.mainPass.depthWrite = false
      image.renderOrder = this._renderOrder
      this.trackMarkers.push(image)
      const t = obj.getTransform()
      t.setLocalPosition(new vec3(x, 0, markerZ))
      t.setLocalScale(new vec3(this._trackIconSize, this._trackIconSize, 1))
    }
    const makeTextBg = (name: string, text: string, x: number) => {
      const obj = global.scene.createSceneObject(name)
      this.managedSceneObjects.add(obj)
      obj.layer = this.sceneObject.layer
      obj.setParent(this.sceneObject)
      const label = obj.createComponent("Component.Text") as Text
      label.text = text
      label.size = this.markerTextSize
      label.textFill.color = new vec4(0.6, 0.6, 0.6, 1) // idle gray, matches icon markers
      label.horizontalAlignment = HorizontalAlignment.Center
      label.verticalAlignment = VerticalAlignment.Center
      label.horizontalOverflow = HorizontalOverflow.Overflow
      label.verticalOverflow = VerticalOverflow.Overflow
      // Lens Studio's Text defaults depthTest to false (it would show through geometry in
      // front of the switch); every other Text in the kit turns it on.
      label.depthTest = true
      // Text declares no depthWrite, but at runtime it exposes a per-instance mainPass
      // (measured: toggling one Text's pass leaves another's unchanged — see the
      // ComponentCanvasSortingTest legacy-switch guard). Pin it: the marker sits in front of
      // the knob in Z, and only "never writes depth" keeps the later-drawn knob on top.
      const labelPass = (label as unknown as {mainPass?: Pass | null}).mainPass
      if (labelPass) {
        labelPass.depthWrite = false
      }
      label.renderOrder = this._renderOrder
      this.trackMarkers.push(label)
      setTextRect(label, obj, this._trackIconSize, this._trackIconSize)
      obj.getTransform().setLocalPosition(new vec3(x, 0, markerZ))
    }
    // Truthy checks, not `!== null`: unassigned @allowUndefined icons are
    // `undefined`, and `undefined !== null` would wrongly build an Image with
    // no texture (renders LS's missing-texture placeholder over the switch).
    const showLeft = this._leftIsText ? this._leftText !== "" : !!this._leftIcon
    const showRight = this._rightIsText ? this._rightText !== "" : !!this._rightIcon
    const q = this.size.x * 0.25
    if (showLeft) {
      if (this._leftIsText) makeTextBg("TrackTextLeft", this._leftText, -q)
      else makeImageBg("TrackIconLeft", this._leftIcon!, -q)
    }
    if (showRight) {
      if (this._rightIsText) makeTextBg("TrackTextRight", this._rightText, q)
      else makeImageBg("TrackIconRight", this._rightIcon!, q)
    }
    if (showLeft || showRight) {
      this.moveKnobToFrontOfOwnedChildren()
    }
  }

  protected override applyOwnedRenderOrders(): void {
    super.applyOwnedRenderOrders()
    applyFlatRenderOrder(this.trackMarkers, this._renderOrder)
  }

  /** Font size (LS units) for text markers, derived from the cm footprint. */
  private get markerTextSize(): number {
    return this._trackIconSize * TRACK_TEXT_SIZE_PER_CM
  }

  /** True when the given side shows text (and has a non-empty label). */
  private sideIsText(right: boolean): boolean {
    return right ? this._rightIsText : this._leftIsText
  }

  protected override get hasKnobIcon(): boolean {
    return (
      super.hasKnobIcon ||
      !!this._leftIcon ||
      !!this._rightIcon ||
      (this._leftIsText && this._leftText !== "") ||
      (this._rightIsText && this._rightText !== "")
    )
  }

  // Side-specific textures take precedence; Slider's inherited icon is the
  // fallback when the current side has no dedicated texture. A text-mode side
  // has no texture, so the knob mirror uses knobIconText instead. Coerce to
  // null so an unassigned (undefined) icon disables the knob renderable
  // instead of sampling a missing-texture placeholder.
  protected override get knobIconTexture(): Texture | null {
    if (this.sideIsText(this.currentValue > 0)) return null
    const sideTexture = this.currentValue > 0 ? this._rightIcon : this._leftIcon
    return sideTexture ?? super.knobIconTexture ?? null
  }

  // Mirror the active side's text onto the knob (null → icon path).
  protected override get knobIconText(): string | null {
    if (!this.sideIsText(this.currentValue > 0)) return null
    return this.currentValue > 0 ? this._rightText : this._leftText
  }

  protected override get knobTextSize(): number {
    return this.markerTextSize
  }

  protected override get knobIconSize(): number {
    return this._trackIconSize
  }

  private updateSwitchKnobIcon(): void {
    this.syncKnobIcon()
  }

  protected setUpEventCallbacks(): void {
    if (this.addCallbacks) {
      this.onFinished.add(createCallbacks(this.onFinishedCallbacks))
    }
    super.setUpEventCallbacks()
  }

  protected onTriggerUpHandler(event: InteractorEvent) {
    super.onTriggerUpHandler(event)
    if (!this._isDragged) {
      this.onFinishedEvent.invoke(true)
    }
  }

  protected onInteractableDragEnd(dragEvent: DragInteractorEvent): void {
    super.onInteractableDragEnd(dragEvent)
    this.onFinishedEvent.invoke(true)
  }

  protected onInteractableDragUpdate(dragEvent: DragInteractorEvent): void {
    super.onInteractableDragUpdate(dragEvent)
    const knobDraggedOn = this.knobValue > 0
    if (this._interactableStateMachine.toggle !== knobDraggedOn) this._interactableStateMachine.toggle = knobDraggedOn
  }

  protected onTriggerRespond(): void {
    if (!this._isDragged) {
      if (this._segmented && this.snapToTriggerPosition) {
        const newValue = this.currentValue === 0 ? 1 : 0
        this.updateCurrentValue(newValue, true)
      }
    }
  }

  private setOn(on: boolean, explicit: boolean) {
    if ((on && this._currentValue === 1) || (!on && this._currentValue === 0)) {
      return
    }
    // onFinished belongs to the write too, so it reads isDragging false mid-drag.
    this.runProgrammaticWrite(() => {
      this.updateCurrentValue(on ? 1 : 0, true)
      if (this._initialized) {
        this.onFinishedEvent.invoke(explicit)
      }
    })
  }

  public updateCurrentValue(value: number, shouldAnimate: boolean = false): void {
    // The toggle sync runs before super's write; keep isDragging false for it too.
    this.runProgrammaticWrite(() => {
      if (this._initialized && !shouldAnimate) {
        this.updateCurrentValueWithZeroAnimateDuration(value)
        return
      }
      if (this._initialized) {
        this._interactableStateMachine.toggle = value > 0
      }
      super.updateCurrentValue(value, shouldAnimate)
      this.updateSwitchKnobIcon()
    })
  }

  /**
   * Snap to `value` (0 or 1) immediately, without animating colors.
   */
  public snapToValue(value: number): void {
    this.updateCurrentValue(value, false)
  }

  private updateCurrentValueWithZeroAnimateDuration(value: number): void {
    this.withZeroAnimateDuration(() => {
      this._interactableStateMachine.toggle = value > 0
      super.updateCurrentValue(value, false)
    })
    this.updateSwitchKnobIcon()
  }

  private withZeroAnimateDuration(action: () => void): void {
    // Every visual the state cascade reaches. Add new visuals here if the cascade grows.
    const visuals = [this._visual, this._knobVisual, this._trackFillVisual, this.shadowVisual]
    const saved = visuals.map((v) => v?.animateDuration)
    for (const v of visuals) {
      if (v) v.animateDuration = 0
    }
    try {
      action()
    } finally {
      for (let i = 0; i < visuals.length; i++) {
        const v = visuals[i]
        const d = saved[i]
        if (v && d !== undefined) v.animateDuration = d
      }
    }
  }

  /**
   * @override Syncs the interactable toggle state before delegating to super.
   * The whole reset, toggle sync included, reads isDragging as false.
   */
  public override resetToValue(value: number): void {
    this.runProgrammaticWrite(() => {
      if (this._initialized) {
        this.withZeroAnimateDuration(() => {
          this._interactableStateMachine.toggle = value > 0
        })
      }
      super.resetToValue(value)
      this.updateSwitchKnobIcon()
    })
  }

  protected get defaultTrackStyle(): Partial<RoundedRectangleVisualParameters> {
    return this.resolveTheme()?.styles["SwitchTrack"]?.[this.styleKey] ?? trackStyle
  }

  protected get defaultKnobStyle(): Partial<RoundedRectangleVisualParameters> {
    return this.resolveTheme()?.styles["SwitchKnob"]?.[this.styleKey] ?? knobStyle
  }

  protected get defaultTrackFillStyle(): Partial<RoundedRectangleVisualParameters> {
    return this.resolveTheme()?.styles["SwitchFill"]?.[this.styleKey] ?? trackFillStyle
  }

  protected get cornerRadiusFactor(): number {
    const data = this.resolveTheme()?.componentData?.["Switch"] as
      | {cornerRadiusFactor?: Record<string, number>}
      | undefined
    return data?.cornerRadiusFactor?.[this.styleKey] ?? 0.5
  }

  protected get knobObjectName(): string {
    return "SwitchKnob"
  }

  protected get trackFillObjectName(): string {
    return "SwitchTrackFill"
  }

  protected createDefaultVisual(): void {
    super.createDefaultVisual()

    // Slider's createDefaultKnobVisual honors componentData["SliderKnob"].knobVisible,
    // which is `false` under System 3.0 (Sliders hide their knob). Switch needs its
    // knob for every Switch style, so override that decision with SwitchKnob.knobVisible —
    // explicit true re-enables, explicit false keeps it off, undefined leaves
    // whatever super decided.
    const knobData = this.resolveTheme()?.componentData?.["SwitchKnob"] as
      | {knobVisible?: Record<string, boolean>}
      | undefined
    const visible = knobData?.knobVisible?.[this.styleKey]
    if (visible !== undefined) {
      this.setKnobRenderMeshEnabled(visible)
    }

    this.applyStyleKnobSize()
    this.onSizeChanged.add(() => this.applyStyleKnobSize())
  }

  // Prism styles construct BeveledPrismVisual directly instead of letting
  // Slider build a RoundedRectangleVisual that we then destroy and replace
  // (the old swap pattern). For non-prism styles we defer to Slider's
  // default RR knob. _knobSize is already populated by Slider's orchestrator
  // before this hook fires, so the prism's initial size lines up with what
  // Slider.updateKnobSize will write later.
  protected override createDefaultKnobVisual(): Visual {
    if (!this.usesPrismKnob) {
      return super.createDefaultKnobVisual()
    }
    // Inherit the component root's render layer so a bespoke layer propagates
    // onto the prism knob (see Slider.createDefaultKnobVisual).
    const knobObject = createChildSceneObjectWithParentLayer(this.knobObjectName, this.sceneObject)
    this.managedSceneObjects.add(knobObject)

    const prismKnob = new BeveledPrismVisual({
      sceneObject: knobObject,
      style: {
        visualElementType: "SwitchKnob",
        style: this.effectiveStyle ?? "Prism",
        themeName: "System 3.0"
      }
    })
    const trackBorder = this._visual?.hasBorder ? this._visual.borderSize : 0
    prismKnob.size = new vec3(this._knobSize.x - trackBorder * 2, this._knobSize.y - trackBorder * 2, this.size.z)
    return prismKnob
  }

  // No track fill on System3 switches: the knob carries on/off via its
  // position + colour, so the fill bar isn't wanted. Prism styles never had
  // one (the prism knob carries the colour and a transparent RR fill would
  // punch depth against it); Flat now matches (its dark fill bar is dropped).
  // System2 keeps its fill. Routed through this hook instead of mutating the
  // public `hasTrackVisual` @input (which still drives the track itself).
  protected override get shouldCreateTrackFillVisual(): boolean {
    if (this.resolveTheme()?.name === SYSTEM_3_NAME) return false
    return this.hasTrackVisual && !this.usesPrismKnob
  }

  // Prism styles render the knob with BeveledPrismVisual instead of the
  // RoundedRectangleVisual Slider builds. Only valid under System3 — earlier
  // themes don't ship the prism material.
  protected get usesPrismKnob(): boolean {
    if (this.resolveTheme()?.name !== SYSTEM_3_NAME) return false
    const style = this.effectiveStyle
    return style === "Prism" || style === "PrismWide" || style === "PrismSquare"
  }

  // Pull the prism knob forward so its back face sits just in front of the
  // track's front face. The BeveledPrism mesh is back-anchored (back at
  // its SceneObject's local Z=0, front extends to +depth), and the track is
  // centered with front face at size.z/2 — so placing the knob origin at
  // size.z/2 + epsilon lines the prism's back up with the track's front.
  protected override get knobZOffset(): number {
    return this.usesPrismKnob ? super.knobZOffset + this.size.z * 0.5 : super.knobZOffset
  }

  // The Flat knob is inset (smaller than the track), so travel it between the
  // track's rounded-end centres — one corner-radius in from each edge —
  // instead of flush to the track edges. That keeps the smaller knob
  // concentric with the track's corner radius, with a uniform margin all
  // round. Display (getKnobPositionFromValue) and drag range (trackLength)
  // share the same span. Prism knobs are full track height, so they keep
  // Slider's default flush travel.
  private get flatKnobTravel(): number {
    return this.size.x - 2 * this.size.y * this.cornerRadiusFactor
  }

  protected override getKnobPositionFromValue(value: number): number {
    if (this.usesPrismKnob) return super.getKnobPositionFromValue(value)
    return (value - 0.5) * this.flatKnobTravel
  }

  protected override get trackLength(): number {
    return this.usesPrismKnob ? super.trackLength : this.flatKnobTravel
  }

  // Per-style knob aspect strategy. `Wide` gives a half-track-wide
  // rectangular knob; `Square` forces a square knob. undefined (record-miss)
  // leaves Slider's default sizing in place (square pill at track height).
  protected get knobAspect(): SwitchKnobAspect | undefined {
    const data = this.resolveTheme()?.componentData?.["SwitchKnob"] as
      | {knobAspect?: Partial<Record<string, SwitchKnobAspect>>}
      | undefined
    return data?.knobAspect?.[this.styleKey]
  }

  /**
   * The knob size. Setting it from script with {@link customKnobSize} on pins
   * it: the style's knob aspect (and the flat-knob inset) no longer resize the
   * knob on initialize or on size changes, so an explicit `knobSize` wins. A
   * size authored in the Inspector loads without this setter and stays the
   * style's, and a write with customKnobSize off (ToolbarToggle's layout) never
   * pins.
   */
  public get knobSize(): vec2 {
    return super.knobSize
  }

  public set knobSize(size: vec2) {
    if (size === undefined) {
      return
    }
    if (this.customKnobSize) {
      this._knobSizePinned = true
    }
    super.knobSize = size
  }

  private applyStyleKnobSize(): void {
    const aspect = this.knobAspect
    if (this._knobSizePinned) {
      // A script set knobSize; keep it. Only the prism radius below follows the track.
    } else if (aspect !== undefined) {
      this.customKnobSize = true
      // Direct write to the protected `_knobSize` field instead of the
      // public knobSize setter: the setter fires `updateKnobSize()` as a
      // side effect, which Slider's own onSizeChanged listener also calls
      // moments later — doubling the work. Writing the field directly lets
      // Slider's listener pick up the new value with a single update.
      if (aspect === SwitchKnobAspect.Wide) {
        const w = Math.max(this.size.x * 0.5, this.size.y)
        this._knobSize = new vec2(w, this.size.y * 1.1)
      } else if (aspect === SwitchKnobAspect.Square) {
        const side = this.size.y * 1.1
        this._knobSize = new vec2(side, side)
      }
    } else if (!this.usesPrismKnob) {
      // Flat knob: square pill inset 0.1 cm in radius (0.2 cm in diameter)
      // below the track height, so the knob reads slightly smaller than the
      // track. customKnobSize stops Slider's size handler resetting it to the
      // full track height. (Prism pill: left at Slider's default.)
      this.customKnobSize = true
      const side = this.size.y - 0.2
      this._knobSize = new vec2(side, side)
    }
    // Single cornerRadius formula for every prism style: match Slider's
    // track formula so knob and track silhouettes stay in sync at any
    // track size. For the pill (Prism, cornerRadiusFactor=0.5) this
    // produces a radius >= the knob's actual half-height — BeveledPrism
    // clamps internally so it still reads as a pill. Slider's updateKnobSize
    // skips cornerRadius for non-RR knobs (instanceof guard), so we set it
    // explicitly here for the prism path.
    if (this._knobVisual instanceof BeveledPrismVisual) {
      this._knobVisual.cornerRadius = this.size.y * this.cornerRadiusFactor
    }
  }
}

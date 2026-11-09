import animate, {CancelSet} from "InteractionKit.lspkg/Utils/animate"
import Event, {PublicApi} from "InteractionKit.lspkg/Utils/Event"
import {CancelToken, clearTimeout, setTimeout} from "InteractionKit.lspkg/Utils/FunctionTimingUtils"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import {VoiceInputProvider} from "../../Services/VoiceInputProvider"
import {TextInputFieldVoiceEdge, Transparent} from "../../Themes/System-3.0/Colors"
import {SecondaryGradients} from "../../Themes/System-3.0/Gradients/SecondaryGradients"
import {
  DEFAULT_SILENCE_UNTIL_TERMINATION_MS,
  normalizeLanguageTags,
  normalizeSilenceUntilTerminationMs
} from "../../Utility/UIKitUtilities"
import {BeveledPrismVisual} from "../../Visuals/BeveledPrism/BeveledPrismVisual"
import {GradientParameters} from "../../Visuals/RoundedRectangle/RoundedRectangle"
import {
  RoundedRectangleVisual,
  RoundedRectangleVisualParameters
} from "../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {ElementContent, TextAlignment} from "../Content/ElementContent"
import {StateName} from "../Element"
import {AsrHoldAnimator, TEXT_INPUT_FIELD_DS3_ASR_SWEEP_PALETTE} from "../TextInput/AsrVoiceAnimation"
import {CORNER_RADIUS, STATE_ANIMATION_DURATION} from "../TextInput/TextInputConsts"
import {Button} from "./Button"

const MICROPHONE_ICON: Texture = requireAsset("Icons.lspkg/Iconography/Media/microphone-on.png") as Texture
const STOP_ICON: Texture = requireAsset("Icons.lspkg/Iconography/Media/stop.png") as Texture
const ERROR_ICON: Texture = requireAsset("Icons.lspkg/Iconography/Alerts-notifications/warning-badge.png") as Texture

const log = new NativeLogger("VoiceInputButton")

// The voice icon scales with the button: its size is this fraction of the button's smaller side.
// This is the proportion TextInputField gives its other action-slot icons
// (ACTION_SLOT_ICON_SIZE_FACTOR), and the ratio this button used before its icon was pinned at a
// fixed size, which showed the same glyph on buttons of every size.
// Exported so the automatic size is stated in exactly one place: the public `voiceIconSize` doc
// links this symbol rather than repeating its value, and verification imports it rather than
// mirroring it.
export const VOICE_ICON_SIZE_FACTOR = 0.56
// Visible fallback for a degenerate button size (zero or NaN), so the icon never collapses.
const DEGENERATE_SIZE_VOICE_ICON_CM = 1
const ERROR_RESET_DELAY_MS = 5000

// The recording chip sits at the prism's BACK plane (-size.z/2, which rests
// flush on the text field surface) plus this epsilon to avoid z-fighting the
// field background. The icon content stays well in front (contentZOffset =
// +size.z/2 + 0.1).
const RECORDING_CHIP_Z_EPSILON = 0.05

// While the embedded button is recording, the prism crossfades out and this
// flat chip takes its place: Secondary-style — a fully transparent body whose
// accent border only appears while hovered (borderSize 0 everywhere else), so
// at rest only the stop icon shows on the field. The chip only ever shows in
// toggled states (recording = toggle on), but the non-toggled states mirror
// them so nothing flashes during the crossfade back to the prism.
const RECORDING_CHIP_BODY = {
  baseType: "Color" as const,
  baseColor: Transparent
}
const RECORDING_CHIP_STYLE: Partial<RoundedRectangleVisualParameters> = {
  default: {
    ...RECORDING_CHIP_BODY,
    hasBorder: true,
    borderSize: 0,
    borderSoftness: 0.07,
    borderType: "Gradient",
    borderGradient: SecondaryGradients.selectedBorder
  },
  hovered: {
    ...RECORDING_CHIP_BODY,
    borderSize: 0.2,
    borderGradient: SecondaryGradients.onHoveredBorder
  },
  triggered: {
    ...RECORDING_CHIP_BODY,
    borderSize: 0.175,
    borderGradient: SecondaryGradients.pressedBorder
  },
  toggledDefault: {
    ...RECORDING_CHIP_BODY,
    borderSize: 0,
    borderGradient: SecondaryGradients.selectedBorder
  },
  toggledHovered: {
    ...RECORDING_CHIP_BODY,
    borderSize: 0.2,
    borderGradient: SecondaryGradients.onHoveredBorder
  },
  toggledTriggered: {
    ...RECORDING_CHIP_BODY,
    borderSize: 0.175,
    borderGradient: SecondaryGradients.pressedBorder
  },
  inactive: {
    ...RECORDING_CHIP_BODY,
    borderSize: 0,
    borderGradient: SecondaryGradients.inactiveBorder
  }
}
// --- Border light loop (standalone listening indicator) ---
// The scan's light blue (#A5E7FF), shared with the field's bottom-edge scan.
const BORDER_LOOP_COLOR = TextInputFieldVoiceEdge
// Glow falloff radius in the border-gradient's normalized rect space
// (center 0, edges ±1 — the squircle vertex shader emits uv = localPos *
// 2/size): distance at which the lobe fades to transparent. NOTE this space
// is a unit square regardless of aspect, so distances are aspect-distorted
// and the glow reads wider than tall on a wide button.
const BORDER_LOOP_GLOW_RADIUS = 1.5
// Border thickness while the light is active, in cm (the style is borderless,
// borderSize 0 — the light needs a real ribbon to paint on).
const BORDER_LOOP_BORDER_SIZE = 0.15
// Seconds for the light to complete one full lap of the border. The light
// moves at uniform physical (cm/s) speed along the perimeter — straights and
// corner arcs included — so it doesn't rush the long edges. Negate to
// reverse direction (positive = clockwise from the top-center).
const BORDER_LOOP_LAP_SECONDS = 1.6
// Fade-out on stop: the glow's alpha ramps to 0 over this many seconds while
// the orbit keeps moving. DERIVED to always outlast the hold animator's body
// ramp (STATE_ANIMATION_DURATION): the loop's final cleanup does a full
// state refresh, which must not land while the body is still ramping.
const BORDER_LOOP_FADE_OUT_MARGIN_SECONDS = 0.067
const BORDER_LOOP_FADE_OUT_SECONDS = STATE_ANIMATION_DURATION + BORDER_LOOP_FADE_OUT_MARGIN_SECONDS

@component
export class VoiceInputButton extends Button {
  @input("string", "default")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Default", "default"),
      new ComboBoxItem("Search", "search"),
      new ComboBoxItem("URL", "url")
    ])
  )
  private _format: "default" | "search" | "url" = "default"

  @input("number", "1500")
  @label("Silence Until Termination (ms)")
  private _silenceUntilTerminationMs: number = DEFAULT_SILENCE_UNTIL_TERMINATION_MS

  @input
  @label("Secondary Languages")
  @hint(
    "Additional BCP-47 language tags speech may switch to alongside the device language, e.g. the languages typical of the place being navigated to."
  )
  private _secondaryLanguages: string[] = []

  private readonly voiceInputProvider: VoiceInputProvider = VoiceInputProvider.getInstance()

  // Traveling border light shown while the standalone button listens.
  private borderLoop: BorderLoopAnimator | null = null

  private readonly onListeningUpdateEvent = new Event<[text: string, isFinal: boolean]>()
  private _onListeningUpdate?: PublicApi<[text: string, isFinal: boolean]>
  /**
   * Event fired when speech-to-text produces partial or final transcript text.
   */
  public get onListeningUpdate(): PublicApi<[text: string, isFinal: boolean]> {
    return (this._onListeningUpdate ??= this.onListeningUpdateEvent.publicApi())
  }
  private readonly onListeningErrorEvent = new Event<AsrModule.AsrStatusCode>()
  private _onListeningError?: PublicApi<AsrModule.AsrStatusCode>
  /**
   * Event fired when voice recognition reports an error status code.
   */
  public get onListeningError(): PublicApi<AsrModule.AsrStatusCode> {
    return (this._onListeningError ??= this.onListeningErrorEvent.publicApi())
  }

  private readonly onListeningErrorAutoResetEvent = new Event<void>()
  private _onListeningErrorAutoReset?: PublicApi<void>
  /**
   * Event fired when the button automatically clears a listening error state.
   */
  public get onListeningErrorAutoReset(): PublicApi<void> {
    return (this._onListeningErrorAutoReset ??= this.onListeningErrorAutoResetEvent.publicApi())
  }

  private _voiceIconContent: ElementContent | null = null
  private _voiceIconSizeOverride: number | null = null
  /** Optional embedded treatment that retains the prism body and only swaps its voice glyph. */
  private _preservePrismWhileListening: boolean = false
  private errorResetCancelToken: CancelToken | null = null
  // Embedded = hosted by a TextInputField/TextInputArea (the field owns the
  // voice background animation and the button renders as a BeveledPrism). The
  // host calls markEmbeddedInField() before this button initializes. Standalone
  // (the default) renders as a grey RoundedRectangle that mimics the field and
  // plays the field's voice "hold" + finish-pulse animation on its own body.
  private _embeddedInField: boolean = false
  // Only created for the standalone (RoundedRectangle) button; drives the voice
  // hold + finish pulse on this button's body while listening.
  private holdAnimator: AsrHoldAnimator | null = null
  // Embedded-only: the flat Secondary-style chip (RECORDING_CHIP_STYLE) that
  // replaces the prism while recording. Created at initialize (see
  // createDefaultVisual) on a managed child object, BEFORE the icon content's
  // container exists, so hierarchy order draws it under the icon; hidden until
  // the first record. ensureRecordingChip() stays lazy-safe as a fallback.
  private recordingChip: RoundedRectangleVisual | null = null
  // Crossfade position: 0 = prism fully visible, 1 = recording chip fully visible.
  private recordingFade: number = 0
  private readonly recordingFadeCancelSet: CancelSet = new CancelSet()
  // The icon content's resting zOffset, captured before the crossfade first
  // modifies it (the crossfade brings the icon down flat with the chip).
  private voiceIconBaseZOffset: number | null = null
  // Icon dip-to-transparent during the crossfade: alpha multiplier that runs
  // 1 -> 0 -> 1 across the animation; the glyph texture swap is deferred to
  // the midpoint (dip bottom) so it never pops while visible.
  private voiceIconDip: number = 1
  private recordingFadeAnimating: boolean = false
  private pendingVoiceIconTexture: Texture | null = null

  /**
   * Marks this button as embedded inside a text field, so it renders as the
   * BeveledPrism action-slot button (the field drives the voice animation).
   * MUST be called before initialize() — createDefaultVisual() reads this to
   * pick the visual. Standalone buttons leave this unset.
   */
  public markEmbeddedInField(): void {
    this._embeddedInField = true
  }

  /**
   * Gets the content component used to render the voice icon.
   * @returns The icon content component, or null before the default visual is created.
   */
  public get voiceIconContent(): ElementContent | null {
    return this._voiceIconContent
  }

  /**
   * Gets the texture currently displayed in the voice icon slot.
   * @returns The active voice icon texture, or null before icon content exists.
   */
  public get voiceIconTexture(): Texture | null {
    return this._voiceIconContent?.leadingIcon ?? null
  }

  /**
   * Voice icon size override in cm, or null (default) for the automatic size:
   * {@link VOICE_ICON_SIZE_FACTOR} of the button's smaller side, the same
   * proportion as the field's other action-slot icons.
   * The button re-asserts the icon size on every layout pass, so writing
   * `voiceIconContent.leadingIconSize` directly gets overwritten — this
   * accessor is the supported knob and is safe to set at any time, before or
   * after initialization.
   */
  public get voiceIconSize(): number | null {
    return this._voiceIconSizeOverride
  }

  public set voiceIconSize(value: number | null) {
    if (value === undefined || value === this._voiceIconSizeOverride) {
      return
    }
    this._voiceIconSizeOverride = value
    this.updateVoiceIconSize()
  }

  /**
   * Keeps an embedded button's prism visual while listening instead of replacing it with the flat
   * recording chip. Configure before initialize(); standalone voice buttons are unaffected.
   */
  public get preservePrismWhileListening(): boolean {
    return this._preservePrismWhileListening
  }

  public set preservePrismWhileListening(value: boolean) {
    if (value === undefined || value === this._preservePrismWhileListening) {
      return
    }
    if (this._initialized) {
      log.w("preservePrismWhileListening must be configured before initialize()")
      return
    }
    this._preservePrismWhileListening = value
  }

  /**
   * Gets the button size.
   * @returns The current button size.
   */
  public get size(): vec3 {
    return super.size
  }

  /**
   * Sets the button size and recalculates the voice icon size.
   * @param size - The new button size.
   */
  public set size(size: vec3) {
    super.size = size
    if (this.recordingChip) {
      this.recordingChip.size = this._size
      this.recordingChip.cornerRadius = this.cornerRadius
      this.recordingChip.sceneObject
        .getTransform()
        .setLocalPosition(new vec3(0, 0, -this._size.z * 0.5 + RECORDING_CHIP_Z_EPSILON))
      // The flat icon target depends on size.z — re-apply mid-recording.
      this.applyRecordingCrossfade()
    }
    this.updateVoiceIconSize()
  }

  /**
   * Gets the button opacity.
   * @returns The current opacity.
   */
  public get opacity(): number {
    return super.opacity
  }

  /**
   * Sets the button opacity and applies it to the voice icon content.
   * @param value - The new opacity.
   */
  public set opacity(value: number) {
    super.opacity = value
    if (this._voiceIconContent) {
      this._voiceIconContent.opacity = value
    }
    // Re-scale the prism/chip pair: the base setter pushed the raw value onto
    // the prism, which is only correct outside a recording crossfade.
    this.applyRecordingCrossfade()
  }

  /**
   * Gets the button render order.
   * @returns The current render order.
   */
  public get renderOrder(): number {
    return super.renderOrder
  }

  /**
   * Sets the button render order. The icon content and the recording chip share
   * it flat; they layer by hierarchy order under the button's Canvas (see the
   * layering note above initialize), not by renderOrder bumps.
   * @param value - The new render order.
   */
  public set renderOrder(value: number) {
    super.renderOrder = value
    if (this._voiceIconContent) {
      this._voiceIconContent.renderOrder = value
    }
    const chipRmv = this.recordingChip?.renderMeshVisual
    if (chipRmv) {
      chipRmv.renderOrder = value
    }
  }

  /**
   * Gets whether the button is inactive.
   * @returns `true` when the button cannot be toggled on.
   */
  public get inactive(): boolean {
    return super.inactive
  }

  /**
   * Sets whether the button is inactive.
   * Setting inactive to `true` cancels any active listening session.
   * @param inactive - `true` to disable interaction.
   */
  public set inactive(inactive: boolean) {
    if (inactive) {
      this.cancelActiveListening()
    }
    super.inactive = inactive
  }

  public get format(): "default" | "search" | "url" {
    return this._format
  }

  public set format(value: "default" | "search" | "url") {
    this._format = value
  }

  /**
   * The ASR silence-until-termination timeout in ms. Non-finite or non-positive
   * values are coerced to DEFAULT_SILENCE_UNTIL_TERMINATION_MS.
   */
  public get silenceUntilTerminationMs(): number {
    return normalizeSilenceUntilTerminationMs(this._silenceUntilTerminationMs)
  }

  public set silenceUntilTerminationMs(value: number) {
    this._silenceUntilTerminationMs = normalizeSilenceUntilTerminationMs(value)
  }

  /**
   * Additional BCP-47 tags speech may switch to alongside the device language (the
   * primary transcription language) — e.g. the languages typical of the place the user is
   * navigating to. An empty list (the default) falls back to
   * `VoiceInputProvider.defaultSecondaryLanguages`. Returns a copy; assign a new array to
   * change it. Changes apply the next time listening starts.
   */
  public get secondaryLanguages(): string[] {
    return normalizeLanguageTags(this._secondaryLanguages)
  }

  public set secondaryLanguages(value: readonly string[]) {
    this._secondaryLanguages = normalizeLanguageTags(value)
  }

  // Draw order under the button's Canvas (inherited from BaseButton; see
  // VisualElement.managesDrawOrderCanvas) is hierarchy order at one flat
  // renderOrder: body (prism or grey plate, on this object) → recording chip
  // (embedded only; created at initialize so it precedes the icon) → icon
  // content container (built after onInitialized) → developer-owned children
  // (kept in the foreground by VisualElement). Z agrees with that order: the
  // chip sits at the back plane (-size.z/2 + ε) and the crossfade lowers the
  // icon to 2ε, still in front of it. Before this the chip was created lazily
  // on the first record and therefore landed AFTER the icon container; it never
  // showed only because the chip body is fully transparent and its hover border
  // is a perimeter ring the centered icon does not overlap — the order is now
  // structural rather than incidental.
  //
  // Nesting with TextInputField / TextInputArea: the field runs its OWN
  // CanvasController, and its initialize() ensures that Canvas before
  // applyActionSlotMode() -> createActionSlot() creates this button, so the
  // field's Canvas always pre-exists this button's initialize(). This button's
  // controller therefore INHERITS it (allowInherited defaults to true) and never
  // mints a nested one — guaranteed by that order, not by luck. Post-init
  // action-slot changes run through the field's batched flush, likewise after
  // the Canvas exists. Standalone buttons mint their own like any other Button.

  /**
   * Initializes the button and wires toggle changes to voice listening ownership.
   */
  public initialize(): boolean {
    if (this._initialized) {
      return false
    }
    if (!super.initialize()) {
      return false
    }
    this.onValueChange.add((value) => this.onToggleValueChanged(value === 1))
    return true
  }

  protected createDefaultVisual(): void {
    if (this._visual) {
      // A visual assigned before initialize: Button gives it a radius set before initialize.
      super.createDefaultVisual()
      return
    }
    if (this._embeddedInField) {
      // Embedded action-slot button: the BeveledPrism path (usesPrismVisual).
      super.createDefaultVisual()
      // Toggled == recording, where the prism is hidden behind the recording
      // chip — zero its toggled extrusions so the invisible prism's hover pop
      // can't drive contentZOffset and shove the stop icon forward.
      const prism = this.prismVisual
      if (prism && !this._preservePrismWhileListening) {
        prism.toggledDefaultExtrusion = 0
        prism.toggledHoveredExtrusion = 0
        prism.toggledTriggeredExtrusion = 0
      }
      this.createVoiceIconContent()
      // Create the chip now, while the icon content's container does not exist
      // yet, so it precedes the icon in child order (hierarchy = draw order).
      this.ensureRecordingChip()
      return
    }

    // Standalone: a grey RoundedRectangle that mimics the TextInputField, using
    // the field's registered System3 style so the resting/hover/etc. states match.
    const themedStyle: Partial<RoundedRectangleVisualParameters> | undefined =
      this.resolveTheme().styles["TextInputField"]?.["default"]
    if (!themedStyle) {
      // No field style registered (non-System3 theme) — fall back to the default button.
      super.createDefaultVisual()
      this.createVoiceIconContent()
      return
    }
    const visual = new RoundedRectangleVisual({
      sceneObject: this.sceneObject,
      style: themedStyle,
      transparent: this._opacity < 1.0
    })
    visual.size = this._size
    visual.cornerRadius = this.getCornerRadius()
    visual.opacity = this._opacity
    this._visual = visual
    // Drives the voice "hold" + finish pulse on this body while listening.
    // skipBorder: the border channel belongs to the listening border light
    // (see applyBorderLoopProbe) — the hold animator only paints the body.
    this.holdAnimator = new AsrHoldAnimator(
      () => (this._visual instanceof RoundedRectangleVisual ? this._visual : null),
      () => TEXT_INPUT_FIELD_DS3_ASR_SWEEP_PALETTE,
      () => this.stateName,
      true
    )
    this.borderLoop = new BorderLoopAnimator(
      this,
      () => (this._visual instanceof RoundedRectangleVisual ? this._visual : null),
      () => this._size,
      // The plate's resting blend follows Button.opacity's rule: translucent
      // below 1, opaque at 1, always blending for the outline styles.
      () => this.isAlwaysTransparent || this._opacity < 1
    )
    this.createVoiceIconContent()
  }

  protected release(): void {
    this.cancelScheduledErrorReset()
    this.stopListening()
    this.borderLoop?.stop(true)
    this.holdAnimator?.cancel()
    this.recordingFadeCancelSet.cancel()
    this.recordingFadeAnimating = false
    this.flushPendingVoiceIconTexture()
    this.recordingChip?.destroy()
    this.recordingChip = null
    super.release()
  }

  protected setState(stateName: StateName): void {
    super.setState(stateName)
    this.recordingChip?.setState(stateName)
  }

  protected onDisabled(): void {
    const clearedListeningError = this.clearListeningError()
    this.cancelActiveListening()
    if (clearedListeningError) {
      this.onListeningErrorAutoResetEvent.invoke()
    }
    super.onDisabled()
  }

  protected get isToggle(): boolean {
    return true
  }

  // Always a System-3.0 button: embedded resolves the prism style, standalone
  // resolves the grey TextInputField style (see createDefaultVisual).
  protected get normalizedThemeOverride(): string {
    return "System 3.0"
  }

  // Embedded → BeveledPrism ("Prism"); standalone → a non-prism style so
  // usesPrismVisual is false and we build the grey RoundedRectangle ourselves.
  protected get effectiveStyle(): string {
    return this._embeddedInField ? "Prism" : "Primary"
  }

  // The standalone plate matches the text field's corner radius. Embedded
  // buttons are prisms, which take the theme's radius instead.
  protected get defaultRectangleCornerRadius(): number {
    return this._embeddedInField ? super.defaultRectangleCornerRadius : CORNER_RADIUS
  }

  // The recording chip stands in for the prism, so it follows the radius too.
  protected applyCornerRadius(): void {
    super.applyCornerRadius()
    if (this.recordingChip) {
      this.recordingChip.cornerRadius = this.cornerRadius
    }
  }

  protected setOn(on: boolean, explicit: boolean): void {
    if (on && this.inactive) return
    super.setOn(on, explicit)
  }

  private createVoiceIconContent(): void {
    if (this._voiceIconContent) return

    this._voiceIconContent =
      (this.sceneObject.getComponent(ElementContent.getTypeName()) as ElementContent | null) ??
      (this.sceneObject.createComponent(ElementContent.getTypeName()) as ElementContent)

    this._voiceIconContent.text = ""
    this._voiceIconContent.trailingIcon = null
    this._voiceIconContent.textAlignment = TextAlignment.Center
    this._voiceIconContent.iconLayout = "left"
    this._voiceIconContent.spacing = 0
    this._voiceIconContent.padding = {top: 0, right: 0, bottom: 0, left: 0}
    this._voiceIconContent.autoResize = false
    this._voiceIconContent.opacity = this.opacity
    this._voiceIconContent.renderOrder = this._renderOrder
    this._voiceIconContent.leadingIconSize = this.computeVoiceIconSize()
    this._voiceIconContent.leadingIcon = MICROPHONE_ICON
  }

  private updateVoiceIconSize(): void {
    if (!this._voiceIconContent) return
    this._voiceIconContent.leadingIconSize = this.computeVoiceIconSize()
  }

  private computeVoiceIconSize(): number {
    if (this._voiceIconSizeOverride !== null) return this._voiceIconSizeOverride
    const side = Math.min(this._size.x, this._size.y)
    // A degenerate (zero or NaN) size keeps a visible icon instead of collapsing it; a later valid
    // size re-derives the icon through the size setter.
    return isFinite(side) && side > 0 ? side * VOICE_ICON_SIZE_FACTOR : DEGENERATE_SIZE_VOICE_ICON_CM
  }

  private setVoiceIconTexture(texture: Texture): void {
    // Mid-crossfade the icon is dipping to transparent — defer the swap to
    // the dip's midpoint instead of popping the glyph while visible.
    if (this.recordingFadeAnimating) {
      this.pendingVoiceIconTexture = texture
      return
    }
    if (this._voiceIconContent) {
      this._voiceIconContent.leadingIcon = texture
    }
  }

  private flushPendingVoiceIconTexture(): void {
    if (!this.pendingVoiceIconTexture) {
      return
    }
    if (this._voiceIconContent) {
      this._voiceIconContent.leadingIcon = this.pendingVoiceIconTexture
    }
    this.pendingVoiceIconTexture = null
  }

  private onToggleValueChanged(isOn: boolean): void {
    if (isOn) {
      this.startListening()
    } else {
      this.stopListening()
    }
  }

  // The prism visual (embedded buttons), crossfaded against the recording chip.
  private get prismVisual(): BeveledPrismVisual | null {
    return this._visual instanceof BeveledPrismVisual ? this._visual : null
  }

  private ensureRecordingChip(): RoundedRectangleVisual | null {
    if (!this._embeddedInField) {
      return null
    }
    if (this.recordingChip) {
      return this.recordingChip
    }
    const chipObject = global.scene.createSceneObject("VoiceRecordingChip")
    chipObject.layer = this.sceneObject.layer
    chipObject.setParent(this.sceneObject)
    chipObject.getTransform().setLocalPosition(new vec3(0, 0, -this._size.z * 0.5 + RECORDING_CHIP_Z_EPSILON))
    this.registerManagedChild(chipObject)
    const chip = new RoundedRectangleVisual({
      sceneObject: chipObject,
      style: RECORDING_CHIP_STYLE,
      transparent: true
    })
    chip.opacity = 0
    chip.size = this._size
    chip.cornerRadius = this.cornerRadius
    // Transparent chrome, so it depth-TESTS (it must still be occluded by real
    // scene geometry) but never depth-WRITES: the body is a fully transparent
    // color with only a border ring, and a transparent surface that writes
    // depth would occlude whatever is drawn behind it afterwards — here the
    // field's own chrome, since the chip spans the whole button footprint and
    // sits on the field surface. Same treatment as NumberPicker's edge fade.
    // NOT the RadioButton/Checkbox intermediate-fill policy: those fills are
    // opaque and legitimately own occlusion when no developer child needs to
    // compose above them.
    chip.depthTest = true
    chip.depthWrite = false
    const chipRmv = chip.renderMeshVisual
    if (chipRmv) {
      chipRmv.renderOrder = this.renderOrder
      // Hidden until the crossfade brings it in (applyRecordingCrossfade
      // re-enables it on the first frame with fade > 0).
      chipRmv.enabled = this.recordingFade > 0
    }
    chip.setState(this.stateName)
    this.recordingChip = chip
    this.voiceIconBaseZOffset ??= this._voiceIconContent?.zOffset ?? null
    log.d(`recording chip created (size ${this._size.x}x${this._size.y}, radius ${chip.cornerRadius})`)
    return chip
  }

  // Drive the prism <-> recording chip crossfade (embedded only). The two
  // opacities are complementary: prism at (1 - fade), chip at fade, both
  // scaled by the button's own opacity.
  private setRecordingChipActive(active: boolean): void {
    if (!this._embeddedInField || this._preservePrismWhileListening) {
      return
    }
    const chip = active ? this.ensureRecordingChip() : this.recordingChip
    if (!chip) {
      return
    }
    const target = active ? 1 : 0
    if (target === this.recordingFade) {
      return
    }
    if (active) {
      chip.setState(this.stateName)
    }
    const from = this.recordingFade
    this.recordingFadeCancelSet.cancel()
    log.d(`recording crossfade ${from} -> ${target}`)
    this.recordingFadeAnimating = true
    animate({
      duration: Math.abs(target - from) * STATE_ANIMATION_DURATION,
      cancelSet: this.recordingFadeCancelSet,
      update: (t) => {
        this.recordingFade = from + (target - from) * t
        // Dip and glyph swap are derived from the ABSOLUTE fade (not the
        // animation's own t, which restarts at 0): a reversed mid-crossfade
        // resumes the dip from where it is instead of popping to full
        // opacity. The swap fires once the fade reaches the target-side half
        // (dip bottom is at fade 0.5).
        this.voiceIconDip = Math.abs(1 - 2 * this.recordingFade)
        const pastDipBottom = target === 1 ? this.recordingFade >= 0.5 : this.recordingFade <= 0.5
        if (pastDipBottom) {
          this.flushPendingVoiceIconTexture()
        }
        if (t >= 1) {
          this.recordingFadeAnimating = false
          this.flushPendingVoiceIconTexture()
        }
        this.applyRecordingCrossfade()
      }
    })
  }

  private applyRecordingCrossfade(): void {
    if (!this._embeddedInField) {
      return
    }
    const prism = this.prismVisual
    if (prism) {
      prism.opacity = this._opacity * (1 - this.recordingFade)
      // The prism shader keeps a residual (reflection/edge layers) even at
      // opacity 0, so hard-disable the mesh once the chip fully owns the
      // button; re-enables on the first frame of the fade back.
      const prismRmv = prism.renderMeshVisual
      if (prismRmv) {
        prismRmv.enabled = this.recordingFade < 1
      }
    }
    if (this.recordingChip) {
      this.recordingChip.opacity = this._opacity * this.recordingFade
      const chipRmv = this.recordingChip.renderMeshVisual
      if (chipRmv) {
        chipRmv.enabled = this.recordingFade > 0
      }
    }
    // Bring the icon down with the fade: its container z is
    // (zOffset + contentZOffset), normally floating at the prism's front
    // face. Lerp the zOffset so at fade 1 the container sits just above the
    // chip, flat on the field.
    const icon = this._voiceIconContent
    if (icon && this.voiceIconBaseZOffset !== null) {
      const flatContainerZ = -this._size.z * 0.5 + 2 * RECORDING_CHIP_Z_EPSILON
      const flatZOffset = flatContainerZ - this.contentZOffset
      icon.zOffset = this.voiceIconBaseZOffset * (1 - this.recordingFade) + flatZOffset * this.recordingFade
      icon.opacity = this._opacity * this.voiceIconDip
    }
  }

  private startListening(): void {
    if (!this.voiceInputProvider) return

    this.clearListeningError()
    // Embedded: crossfade the prism out and the flat recording chip in.
    // Standalone: ramp the body into the voice "hold" color (one of these is
    // a no-op depending on the visual). Start the crossfade BEFORE setting
    // the icon so the glyph swap defers to the dip midpoint.
    this.setRecordingChipActive(true)
    this.setVoiceIconTexture(STOP_ICON)
    this.holdAnimator?.start()
    this.borderLoop?.start()
    this.voiceInputProvider.acquireListening(
      this,
      {
        onListeningUpdate: ([text, isFinal]) => this.onListeningUpdateHandler(text, isFinal),
        onListeningError: (statusCode: AsrModule.AsrStatusCode) => this.onListeningErrorHandler(statusCode),
        onListeningOwnershipLost: () => this.onListeningOwnershipLostHandler()
      },
      this._format,
      this.silenceUntilTerminationMs,
      this.secondaryLanguages
    )
  }

  private stopListening(): void {
    this.setRecordingChipActive(false)
    this.setVoiceIconTexture(this._hasError ? ERROR_ICON : MICROPHONE_ICON)
    this.borderLoop?.stop()
    // Ramp the body back to grey. No-op if a finish pulse is already running
    // (final transcript) — that pulse owns the return to grey.
    this.holdAnimator?.stop()
    this.voiceInputProvider?.releaseListening(this)
  }

  private cancelActiveListening(): void {
    if (this.isOn) {
      this.toggle(false)
    }
  }

  private onListeningUpdateHandler(text: string, isFinal: boolean): void {
    this.onListeningUpdateEvent.invoke([text, isFinal])
    if (isFinal) {
      // Standalone end-of-listening deliberately does NOT play the finish
      // pulse (no bounce): the toggle-off's stop() ramps the body back to
      // grey while the border light fades out (see BorderLoopAnimator).
      this.cancelActiveListening()
    }
  }

  private onListeningErrorHandler(statusCode: AsrModule.AsrStatusCode): void {
    this.cancelActiveListening()
    this.setListeningError(statusCode)
  }

  private onListeningOwnershipLostHandler(): void {
    this.cancelActiveListening()
  }

  private setListeningError(statusCode: AsrModule.AsrStatusCode): void {
    this._hasError = true
    this.setVoiceIconTexture(ERROR_ICON)
    this.setState(
      this.stateName === StateName.hovered || this.stateName === StateName.errorHovered
        ? StateName.errorHovered
        : StateName.error
    )
    this.scheduleErrorReset()
    this.onListeningErrorEvent.invoke(statusCode)
  }

  private clearListeningError(): boolean {
    this.cancelScheduledErrorReset()
    if (!this._hasError) return false
    this._hasError = false
    if (this.stateName === StateName.error) {
      this.setState(StateName.default)
    } else if (this.stateName === StateName.errorHovered) {
      this.setState(StateName.hovered)
    }
    this.setVoiceIconTexture(MICROPHONE_ICON)
    return true
  }

  private scheduleErrorReset(): void {
    this.cancelScheduledErrorReset()
    this.errorResetCancelToken = setTimeout(() => {
      this.errorResetCancelToken = null
      this.resetListeningError()
    }, ERROR_RESET_DELAY_MS)
  }

  private cancelScheduledErrorReset(): void {
    if (!this.errorResetCancelToken) return
    clearTimeout(this.errorResetCancelToken)
    this.errorResetCancelToken = null
  }

  private resetListeningError(): void {
    if (!this.clearListeningError()) return
    this.onListeningErrorAutoResetEvent.invoke()
  }
}

/**
 * The standalone button's "listening" border light: a soft #A5E7FF radial
 * lobe that loops continuously around the RoundedRectangle border. Pure TS —
 * each frame it places a radial border-gradient center at a point on the
 * button's perimeter, walked at uniform physical speed (arc-length
 * parameterized over the 4 straights + 4 corner arcs, in cm, then mapped
 * into the shader's aspect-normalized ±1 uv space).
 *
 * Private to VoiceInputButton by design (see the focused plan). Border
 * cleanup after stop() rides the hold animator's ending
 * refreshRoundedRectangleState(), which clears the transient border override
 * and re-disables the border (forcing its size back to 0).
 */
class BorderLoopAnimator {
  private updateEvent: SceneEvent | null = null
  private mode: "off" | "on" | "fading" = "off"
  // Alpha multiplier on the glow: 1 while on, ramping to 0 during the fade.
  private fade = 1
  // Arc-length progress around the perimeter, in [0, 1). 0 = top-center,
  // increasing clockwise.
  private progress = 0

  // Reused per-frame objects — apply() runs every frame while the light is
  // active, so the gradient and its vectors are mutated in place instead of
  // reallocated (the visual's uniform cache compares by value, so in-place
  // mutation still propagates).
  private readonly scratchCm = new vec2(0, 0)
  private readonly gradientCenter = new vec2(0, 0)
  private readonly gradientEnd = new vec2(0, 0)
  private readonly headColor = new vec4(
    BORDER_LOOP_COLOR.x,
    BORDER_LOOP_COLOR.y,
    BORDER_LOOP_COLOR.z,
    BORDER_LOOP_COLOR.w
  )
  private readonly tailColor = new vec4(BORDER_LOOP_COLOR.x, BORDER_LOOP_COLOR.y, BORDER_LOOP_COLOR.z, 0)
  private readonly gradient: GradientParameters = {
    enabled: true,
    type: "Radial",
    start: this.gradientCenter,
    end: this.gradientEnd,
    stop0: {enabled: true, percent: 0, color: this.headColor},
    stop1: {enabled: true, percent: 1, color: this.tailColor}
  }

  public constructor(
    private readonly component: BaseScriptComponent,
    private readonly getVisual: () => RoundedRectangleVisual | null,
    private readonly getSize: () => vec3,
    // The blend the plate should rest at once the light is gone.
    private readonly wantsTransparency: () => boolean
  ) {}

  public start(): void {
    const visual = this.getVisual()
    if (!visual) return
    // The light fades via alpha, which the opaque blend discards.
    if (!visual.transparencyEnabled) {
      visual.transparencyEnabled = true
    }
    this.progress = 0
    this.fade = 1
    this.mode = "on"
    if (!this.updateEvent) {
      this.updateEvent = this.component.createEvent("UpdateEvent")
      this.updateEvent.bind(() => this.update())
    }
    this.updateEvent.enabled = true
    this.apply(visual)
  }

  /**
   * End the light. Default: keep orbiting while the glow's alpha ramps to 0
   * over BORDER_LOOP_FADE_OUT_SECONDS, then tear down. immediate = true
   * (release/destroy) tears down this frame.
   */
  public stop(immediate: boolean = false): void {
    if (this.mode === "off") return
    if (immediate) {
      this.finishFade(this.getVisual())
      return
    }
    if (this.mode === "on") {
      this.mode = "fading"
    }
  }

  private update(): void {
    const visual = this.getVisual()
    if (this.mode === "off" || !visual) {
      this.finishFade(visual)
      return
    }
    this.progress = (this.progress + getDeltaTime() / BORDER_LOOP_LAP_SECONDS) % 1
    if (this.progress < 0) this.progress += 1
    if (this.mode === "fading") {
      this.fade -= getDeltaTime() / BORDER_LOOP_FADE_OUT_SECONDS
      if (this.fade <= 0) {
        this.finishFade(visual)
        return
      }
    }
    this.apply(visual)
  }

  private finishFade(visual: RoundedRectangleVisual | null): void {
    this.mode = "off"
    this.fade = 0
    if (this.updateEvent) {
      this.updateEvent.enabled = false
    }
    if (visual) {
      // Hide the ribbon immediately (the border only renders with size > 0),
      // then snap the whole visual back to its state style — this clears the
      // transient border-gradient override and re-disables the border. The
      // fade outlasts the hold animator's 0.333s body ramp, so this refresh
      // never catches the body mid-animation.
      visual.borderSize = 0
      visual.refreshRoundedRectangleState()
      // Hand the blend back to the button's rule rather than to what start()
      // found: an opacity written during the run (a toolbar's fade settling on
      // a fraction) must leave the plate translucent, and restoring "opaque"
      // here kept it solid until the next opacity write.
      visual.transparencyEnabled = this.wantsTransparency()
    }
  }

  private apply(visual: RoundedRectangleVisual): void {
    const size = this.getSize()
    // Skip the frame while the button has no real dimensions (e.g. listening
    // started programmatically before a layout pass): the uv mapping divides
    // by size and the perimeter walk divides by the corner radius, so a zero
    // size would push NaNs into the gradient uniforms.
    if (size.x <= 1e-5 || size.y <= 1e-5) {
      return
    }
    this.perimeterPointCm(size.x, size.y, visual.cornerRadius, this.progress, this.scratchCm)
    // cm -> the shader's uv space (edges at ±1 on both axes).
    this.gradientCenter.x = (2 * this.scratchCm.x) / size.x
    this.gradientCenter.y = (2 * this.scratchCm.y) / size.y
    // Radial falloff hits percent 1 at |end - start| / 2 from the center.
    this.gradientEnd.x = this.gradientCenter.x + 2 * BORDER_LOOP_GLOW_RADIUS
    this.gradientEnd.y = this.gradientCenter.y
    this.headColor.w = BORDER_LOOP_COLOR.w * this.fade
    visual.applyBorderGradientNow(this.gradient)
    // Re-assert the ribbon width every frame: the hold animator's own state
    // refresh (end of its 0.333s ramp-down) lands MID-fade and force-zeroes
    // the border size; the next apply re-enables and re-sizes it so the
    // fading glow survives to the end of its own envelope.
    visual.borderSize = BORDER_LOOP_BORDER_SIZE
  }

  // Point on the rounded-rect outline (corner radius `radius`, the plate's
  // own) at arc-length fraction s in [0, 1), in centered local cm, written
  // into `out` (per-frame path, no allocations). Path: top-center ->
  // clockwise (right along the top edge, down the right side, ...). Uniform
  // speed everywhere, corner arcs included.
  private perimeterPointCm(w: number, h: number, radius: number, s: number, out: vec2): void {
    const r = Math.min(radius, Math.min(w, h) / 2)
    const sx = w / 2 - r // straight half-length, x
    const sy = h / 2 - r // straight half-length, y
    const arc = (Math.PI * r) / 2
    const total = 4 * sx + 4 * sy + 4 * arc
    let d = s * total

    // 1. top edge, center -> right
    if (d < sx) {
      out.x = d
      out.y = h / 2
      return
    }
    d -= sx
    // 2. top-right arc (90° -> 0°)
    if (d < arc) {
      const a = Math.PI / 2 - d / r
      out.x = sx + r * Math.cos(a)
      out.y = sy + r * Math.sin(a)
      return
    }
    d -= arc
    // 3. right edge, top -> bottom
    if (d < 2 * sy) {
      out.x = w / 2
      out.y = sy - d
      return
    }
    d -= 2 * sy
    // 4. bottom-right arc (0° -> -90°)
    if (d < arc) {
      const a = -d / r
      out.x = sx + r * Math.cos(a)
      out.y = -sy + r * Math.sin(a)
      return
    }
    d -= arc
    // 5. bottom edge, right -> left
    if (d < 2 * sx) {
      out.x = sx - d
      out.y = -h / 2
      return
    }
    d -= 2 * sx
    // 6. bottom-left arc (-90° -> -180°)
    if (d < arc) {
      const a = -Math.PI / 2 - d / r
      out.x = -sx + r * Math.cos(a)
      out.y = -sy + r * Math.sin(a)
      return
    }
    d -= arc
    // 7. left edge, bottom -> top
    if (d < 2 * sy) {
      out.x = -w / 2
      out.y = -sy + d
      return
    }
    d -= 2 * sy
    // 8. top-left arc (180° -> 90°)
    if (d < arc) {
      const a = Math.PI - d / r
      out.x = -sx + r * Math.cos(a)
      out.y = sy + r * Math.sin(a)
      return
    }
    d -= arc
    // 9. top edge, left -> center
    out.x = -sx + d
    out.y = h / 2
  }
}

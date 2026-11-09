import type {Interactor} from "InteractionKit.lspkg/Core/Interactor/Interactor"
import {DragInteractorEvent, InteractorEvent} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import animate, {CancelSet} from "InteractionKit.lspkg/Utils/animate"
import Event, {PublicApi, unsubscribe} from "InteractionKit.lspkg/Utils/Event"
import {CancelToken, clearTimeout, setTimeout} from "InteractionKit.lspkg/Utils/FunctionTimingUtils"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import {RoundedRectangleVisual} from "../../../Scripts/Visuals/RoundedRectangle/RoundedRectangleVisual"
import {TextInputFieldVoiceEdge} from "../../Themes/System-3.0/Colors"
import {SYSTEM_3_NAME} from "../../Themes/Theme"
import {isComponentBeingDestroyed} from "../../Utility/SceneUtilities"
import {fitLabelSize, isEqual, labelRatioDrifted, labelWidthPerSizeUnit} from "../../Utility/UIKitUtilities"
import {Button} from "../Button/Button"
import {VoiceInputButton} from "../Button/VoiceInputButton"
import {TextAlignment as ContentTextAlignment, ElementContent} from "../Content/ElementContent"
import {StateName} from "../Element"
import {
  AsrVisualSweepMode,
  AsrVisualSweepPalette,
  TEXT_INPUT_FIELD_DS3_ASR_SWEEP_PALETTE
} from "../TextInput/AsrVoiceAnimation"
import {BaseTextInputComponent} from "../TextInput/BaseTextInputComponent"
import type {SystemKeyboardEditContext, SystemKeyboardEditDisposition} from "../TextInput/SystemKeyboardModule"
import {
  FONT_SIZE_SCALE,
  IconState,
  INSET_FACTOR_SINGLE_LINE,
  MASK_Z_OFFSET,
  STATE_ANIMATION_DURATION,
  TextAlignment
} from "../TextInput/TextInputConsts"
import type {NumericDragAxis, ScaledDecimal} from "./DragAdjustUtilities"
import {
  dragAxisDelta,
  dragStepsForDelta,
  formatNumberWithSuffix,
  parseNumberWithSuffix,
  stepScaledDecimal
} from "./DragAdjustUtilities"

const log = new NativeLogger("TextInputField")

const EYE_ICON: Texture = requireAsset("Icons.lspkg/Iconography/System/eye.png") as Texture
const EYE_OFF_ICON: Texture = requireAsset("Icons.lspkg/Iconography/System/eye-off.png") as Texture

// Anchors the text input field LocalizationsAsset into the package build. Calls
// to localizationSystem.localize() do not create an asset reference by
// themselves, so the static requireAsset() is required for key resolution.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const TEXT_INPUT_FIELD_LOCALIZATIONS_ASSET = requireAsset(
  "../../../Localization/TextInputField/strings"
) as LocalizationsAsset

const CLEAR_BUTTON_LABEL_KEY = "@uikit:text-input-field:clear"
const CLEAR_BUTTON_LABEL_FALLBACK = "Clear"

const BUTTON_INSET_FACTOR = 0.15

const ACTION_SLOT_HEIGHT_FACTOR = 0.6
const ACTION_SLOT_ICON_SIZE_FACTOR = 0.56

const CLEAR_BUTTON_HEIGHT_FACTOR = 0.73
const CLEAR_BUTTON_WIDTH_TO_HEIGHT_RATIO = 1.36
const CLEAR_BUTTON_CORNER_RADIUS = 0.3
// The label may span at most this fraction of the clear button's width. English "Clear" sits well
// under it, so the default look is unchanged; a wider translation ("Effacer", "Löschen") renders at
// a smaller font size instead of running into the rounded body.
const CLEAR_BUTTON_LABEL_MAX_WIDTH_FACTOR = 0.8
// Shrink floor, as a fraction of the field's font size. A translation that would need more is left
// to overflow at this size rather than shrink into an unreadable smear.
const CLEAR_BUTTON_LABEL_MIN_SCALE = 0.5
// Relative change in the label's measured width-per-size ratio below which a later reading counts as
// the same metrics (float noise between passes), not as font metrics having settled.
const CLEAR_BUTTON_LABEL_RATIO_TOLERANCE = 0.01

const PASSWORD_CHARACTER_REVEAL_DURATION_MS = 1000

// Drag-to-adjust: one value step per this fraction of the field height travelled along the axis
// (0.45 cm on the default 3 cm-tall field). Height-relative so a scaled field keeps the same feel.
const DRAG_ADJUST_STEP_DISTANCE_FACTOR = 0.15

// Width absorbed (as a factor of height) when the voice slot hides while the field is
// docked at the keyboard: the slot's text inset collapses to the plain single-line inset.
const DOCK_CONTRACTION_FACTOR = 0.5 + ACTION_SLOT_HEIGHT_FACTOR * 0.5 + BUTTON_INSET_FACTOR - INSET_FACTOR_SINGLE_LINE

export type TextInputType = "default" | "numeric" | "password" | "pin" | "url" | "email"
export type ActionSlotMode = "none" | "password" | "voiceInput" | "iconChange"
export type {NumericDragAxis} from "./DragAdjustUtilities"
type FieldControlOpacityTarget = "all" | "actionSlot" | "clearButton"
type CodePointRange = {start: number; end: number}
type PasswordCharacterReveal = CodePointRange & {sourceText: string}
type KeyboardTextAssignmentContext = {
  setterCalls: number
  lastMutatingSetterHandlerRevision: number
}
// One drag-to-adjust gesture, owned by the interactor that started it, from drag start to drag
// end. `adjusting` drops to false when the keyboard or voice input takes over mid-drag. Whether
// the press as a whole changed the value is tracked separately on the field
// (dragAdjustChangedValue): IK ends drags per interactor but fires the trigger end once, when
// the last hand lets go, so that decision must outlive any single session.
type DragAdjustSession = {
  interactor: Interactor
  startPosition: vec3
  startValue: ScaledDecimal
  // The unit suffix the text opened with ("%"), re-appended to every stepped value.
  suffix: string
  stepDistance: number
  lastSteps: number
  adjusting: boolean
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff
}

function isCodePointBoundary(text: string, index: number): boolean {
  if (!Number.isInteger(index) || index < 0 || index > text.length) return false
  if (index === 0 || index === text.length) return true
  return !(isHighSurrogate(text.charCodeAt(index - 1)) && isLowSurrogate(text.charCodeAt(index)))
}

function getFinalCodePointInRange(text: string, rangeStart: number, rangeEnd: number): CodePointRange | null {
  if (rangeEnd <= rangeStart || !isCodePointBoundary(text, rangeEnd)) return null

  let start = rangeEnd - 1
  if (isLowSurrogate(text.charCodeAt(start)) && start > rangeStart && isHighSurrogate(text.charCodeAt(start - 1))) {
    start--
  }
  if (start < rangeStart || !isCodePointBoundary(text, start)) return null
  return {start, end: rangeEnd}
}

function detectSoleInsertedCodePointFromEditContext(
  previousText: string,
  nextText: string,
  editContext: SystemKeyboardEditContext
): PasswordCharacterReveal | null {
  const {replacementStart, replacementEnd, insertedText} = editContext
  const insertedEnd = replacementStart + insertedText.length
  const validRanges =
    isCodePointBoundary(previousText, replacementStart) &&
    isCodePointBoundary(previousText, replacementEnd) &&
    replacementStart <= replacementEnd &&
    isCodePointBoundary(nextText, replacementStart) &&
    isCodePointBoundary(nextText, insertedEnd)
  if (!validRanges) return null

  const expectedText = previousText.slice(0, replacementStart) + insertedText + previousText.slice(replacementEnd)
  if (expectedText !== nextText) return null

  // Only a splice that inserted exactly one code point may peek. The bridge's provenance is also
  // authoritative for multi-code-point payloads (a commitText paste, a composition suffix
  // extension), so requiring the final code point to span the whole insertion keeps those masked
  // regardless of which keyboard callback delivered the edit.
  const range = getFinalCodePointInRange(nextText, replacementStart, insertedEnd)
  if (!range || range.start !== replacementStart) return null
  return {...range, sourceText: nextText}
}

/**
 * TextInputField
 * Single-line text input component.
 * Supports password masking and a single action slot whose
 * behavior is driven by `inputType` (password) and action slot
 * (none / voiceInput / iconChange).
 */
@component
export class TextInputField extends BaseTextInputComponent {
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Alignment</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Horizontal text alignment</span>')
  @input("string", "left")
  @widget(new ComboBoxWidget([new ComboBoxItem("Left", "left"), new ComboBoxItem("Right", "right")]))
  @hint("Alignment of the text within the text field.")
  protected _horizontalTextAlignment: TextAlignment = TextAlignment.Left

  // ─── Input Type ──────────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Input Type</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Validation and keyboard behavior</span>')
  @input("string", "default")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Default", "default"),
      new ComboBoxItem("Numeric", "numeric"),
      new ComboBoxItem("Password", "password"),
      new ComboBoxItem("Pin", "pin"),
      new ComboBoxItem("URL", "url"),
      new ComboBoxItem("Email", "email")
    ])
  )
  public inputType: TextInputType = "default"

  @input("string", "none")
  @label("Drag Adjust Axis")
  @showIf("inputType", "numeric")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("None", "none"),
      new ComboBoxItem("Horizontal", "horizontal"),
      new ComboBoxItem("Vertical", "vertical")
    ])
  )
  @hint(
    "Drag the field along this axis to step the number by its displayed precision (2.50 steps by 0.01); a unit after the number (50%) is kept. Ignored while the keyboard or voice input is active."
  )
  private _dragAdjustAxis: NumericDragAxis = "none"

  @input
  @hint("Throw error if unfocused with no input")
  public contentRequiredOnDeactivate: boolean = false

  // ─── Action Slot ─────────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Action Slot</span>')
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Action slot follows horizontal text alignment. `password` input type overrides this with an eye-icon toggle.</span>'
  )
  @input
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("None", "none"),
      new ComboBoxItem("Voice Input", "voiceInput"),
      new ComboBoxItem("Icon Change", "iconChange")
    ])
  )
  private _actionSlot: string = "voiceInput"

  @input
  @showIf("_actionSlot", "iconChange")
  @allowUndefined
  @hint("Icon Texture")
  public icon: Texture

  @input
  @showIf("_actionSlot", "iconChange")
  @hint("Switch to a different icon on focus")
  public changeIconOnFocus: boolean = false

  @input
  @showIf("changeIconOnFocus", true)
  @allowUndefined
  @hint("Alternate icon used on focus")
  public alternateIcon: Texture

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Clear Button</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Show a clear button when text has been entered</span>')
  @input
  @label("Show Clear Button")
  @hint("Show a clear button when text has been entered")
  private _showClearButton: boolean = true

  private actionSlotObject: SceneObject | null = null
  private actionSlotTransform: Transform | null = null
  private actionSlotButton: Button | null = null
  private _actionSlotContent: ElementContent | null = null

  private voiceInputUnsubscribe: unsubscribe | null = null
  private voiceStateUnsubscribe: unsubscribe | null = null
  private readonly voiceStateChangedEvent: Event<boolean> = new Event<boolean>()
  /**
   * Fires true when a voice-input session starts and false when it ends, by any
   * cause: final transcript, ASR error, lost listening ownership, or the
   * keyboard force-stopping it. Only the voiceInput action slot drives it, so a
   * field in another action-slot mode never fires. Use this instead of reaching
   * for the action-slot button, which is internal.
   */
  public readonly onVoiceStateChanged: PublicApi<boolean> = this.voiceStateChangedEvent.publicApi()
  private _actionSlotIconSizeOverride: number | null = null

  private clearButtonObject: SceneObject | null = null
  private clearButtonTransform: Transform | null = null
  private clearButton: Button | null = null
  private clearButtonContent: ElementContent | null = null
  // Natural width of the clear label per unit of font size, from the latest usable glyph measurement
  // taken while the button was showing (null until the first lands). The device language is fixed
  // per boot, so it only moves if the font's metrics settle after the first reading; hidden fits and
  // refused measurements run from the stored value.
  private clearLabelWidthPerSizeUnit: number | null = null
  private clearContentInitializedUnsubscribe: unsubscribe | null = null
  private clearLabelLayoutUnsubscribe: unsubscribe | null = null

  private currentActionSlotMode: ActionSlotMode = "voiceInput"

  private hidePassword: boolean = true
  private passwordButtonHovered: boolean = false
  private passwordCharacterReveal: PasswordCharacterReveal | null = null
  private passwordCharacterRevealCancelToken: CancelToken | null = null
  private passwordButtonUnsubscribes: unsubscribe[] = []
  private passwordButtonEpoch: number = 0
  private passwordButtonAvailabilityRevision: number = 0
  private textChangeHandlerRevision: number = 0
  private passwordPresentationRevision: number = 0
  private keyboardTextAssignmentContext: KeyboardTextAssignmentContext | null = null

  private _textOffset: vec2 = vec2.zero()
  private _textSideInset: number | null = null
  private textAvailableWidth: number = 0

  private _actionSlotModeDirty: boolean = false
  // Docked-at-keyboard contraction: 0 = normal, 1 = voice slot hidden with its width
  // absorbed. The keyboard provides its own dictation, so the mic is redundant while docked.
  private dockContractionProgress: number = 0
  private dockSlotHidden: boolean = false
  private readonly dockContractionCancelSet = new CancelSet()
  private readonly actionSlotPosition: vec3 = vec3.zero()
  private readonly clearButtonPosition: vec3 = vec3.zero()

  private _scrollOffsetX: number = 0
  protected scrollCooldownSec: number = 0.05

  private dragAdjustSession: DragAdjustSession | null = null
  // True once any drag in the current press stepped the value; consumed by the press's release
  // so it does not focus the field. Reset when a new press begins.
  private dragAdjustChangedValue: boolean = false

  /**
   * Gets the per-side base text inset override in centimeters, or null
   * (default) for the automatic height-derived inset.
   * @returns The inset override, or null for automatic.
   */
  public get textSideInset(): number | null {
    return this._textSideInset
  }

  /**
   * Sets the per-side base text inset in centimeters; null restores the
   * automatic height-derived inset (INSET_FACTOR_SINGLE_LINE of the field
   * height). The text viewport — and with it the clipping mask, caret
   * scrolling, and available width — follows this value, so it is the
   * supported way to widen a narrow field's text band. The action slot and
   * clear button still widen their side's inset when present.
   * @param value - The per-side inset in centimeters, or null for automatic.
   */
  public set textSideInset(value: number | null) {
    if (value === undefined || value === this._textSideInset) return
    this._textSideInset = value
    if (this._initialized) {
      this.markTextLayoutDirty()
    }
  }

  /**
   * Gets the horizontal text offset applied inside the field.
   * @returns The current text offset.
   */
  public get textOffset(): vec2 {
    return this._textOffset
  }

  /**
   * Sets the horizontal text offset applied inside the field.
   * Triggers a batched text layout update after initialization.
   * @param offset - The new text offset.
   */
  public set textOffset(offset: vec2) {
    if (offset === undefined || isEqual(offset, this._textOffset)) return
    this._textOffset = offset
    if (this._initialized) {
      this.markTextLayoutDirty()
    }
  }

  public override get text(): string {
    return super.text
  }

  public override set text(value: string) {
    const keyboardTextAssignmentContext = this.keyboardTextAssignmentContext
    const changesText = value !== undefined && !isEqual(value, this._text)
    if (keyboardTextAssignmentContext) {
      keyboardTextAssignmentContext.setterCalls++
      if (changesText) {
        keyboardTextAssignmentContext.lastMutatingSetterHandlerRevision = this.textChangeHandlerRevision
      }
    }
    let passwordRevealCleared = false
    if (!keyboardTextAssignmentContext && changesText) {
      // Cancel at mutation time rather than waiting for the batched render. This prevents an
      // away-and-back programmatic write from ending on the old reveal's source text.
      this.passwordPresentationRevision++
      passwordRevealCleared = this.clearPasswordCharacterReveal(false)
    }
    super.text = value
    if (passwordRevealCleared) {
      // A mutation from onTextChanged can run after this field's LateUpdate already painted the
      // peek. Repaint the newly assigned value now; the normal dirty flush still emits exactly one
      // onTextChanged for the mutation because this visibility-only refresh passes false.
      this.refreshPasswordPresentation()
    }
  }

  /**
   * Gets the horizontal text alignment.
   * @returns The current horizontal alignment.
   */
  public get horizontalTextAlignment(): TextAlignment {
    return super.horizontalTextAlignment
  }

  /**
   * Sets the horizontal text alignment.
   * Center alignment is unsupported for single-line fields and is ignored.
   * @param value - The desired horizontal alignment.
   */
  public set horizontalTextAlignment(value: TextAlignment) {
    if (value === TextAlignment.Center) {
      log.w("TextInputField does not support center text alignment.")
      return
    }
    super.horizontalTextAlignment = value
  }

  public override get inactive(): boolean {
    return super.inactive
  }

  public override set inactive(value: boolean) {
    const inactiveChanged = value !== this.inactive
    let characterRevealCleared = false
    if (value) {
      // Stops stepping now instead of waiting for the gesture to end: disabling the interactable below
      // ends it on the interaction system's next update, when IK cancels the trigger (the manager
      // clears the disabled interactable, then dispatches TriggerCanceled, which still fires
      // onDragEnd — so a subscriber pairing drag start with drag end stays balanced).
      this.resetDragAdjust()
    }
    if (inactiveChanged) {
      // Rotate stale snapshots while keeping one live binding. The button remains interactive when
      // its parent field is inactive, so current events must still keep its physical state in sync.
      this.invalidatePasswordPresentation()
      if (value) {
        characterRevealCleared = this.clearPasswordCharacterReveal(false)
      }
    }
    super.inactive = value
    if (inactiveChanged && (this.passwordButtonHovered || characterRevealCleared)) {
      // Physical hover is retained across inactivity but is reveal-eligible only while active.
      this.refreshPasswordPresentation()
    }
  }

  /**
   * Sets the input behavior and refreshes keyboard, masking, and action slot state.
   * @param type - The input type to apply.
   */
  public setInputType = (type: TextInputType) => {
    if (type === undefined || isEqual(type, this.inputType)) return
    const passwordPresentationCanChange = this.inputType === "password" || type === "password"
    this.invalidatePasswordPresentation(false)
    this.clearPasswordCharacterReveal(false)
    if (this.currentActionSlotMode === "password") {
      if (this.actionSlotButton?.isOn) {
        this.actionSlotButton.toggle(false)
      } else {
        this.hidePassword = true
      }
    }
    this.inputType = type
    // The final type can round-trip back to password before the batched action-slot mode changes.
    // Reconcile the existing button immediately so it is neither stale nor left unsubscribed.
    this.rebindPasswordButtonEvents()
    if (this._initialized) {
      this.systemKeyboardModule.keyboardType = this.keyboardType
      if (passwordPresentationCanChange) {
        // Apply the final mode synchronously. This closes same-LateUpdate password -> other ->
        // password round trips without adding an onTextChanged notification.
        this.refreshPasswordPresentation()
      }
      this.markActionSlotModeDirty()
      this.markTextDirty()
    }
  }

  /**
   * Axis along which dragging a `numeric` field steps its value; `none` (default) disables the
   * gesture. Each step changes the last displayed decimal place ("2.50" steps by 0.01, "7" by 1),
   * with right and up increasing; a unit suffix after the number ("50%", "2.5 cm") is kept. The
   * gesture is ignored while the field is being edited with the keyboard or a voice session is
   * running. A drag that changed the value does not open the keyboard on release; a tap, or a
   * drag too short to reach a step, still focuses the field. Has no effect for other input types.
   * @returns The configured drag-adjust axis.
   */
  public get dragAdjustAxis(): NumericDragAxis {
    return this._dragAdjustAxis
  }

  /**
   * Sets the drag-adjust axis. Takes effect on the next drag; a drag already in progress keeps
   * adjusting along the new axis, or stops adjusting when set to `none`.
   * @param axis - The axis to drag along, or `none` to disable drag-to-adjust.
   */
  public set dragAdjustAxis(axis: NumericDragAxis) {
    if (axis === undefined || isEqual(axis, this._dragAdjustAxis)) return
    this._dragAdjustAxis = axis
  }

  /**
   * Gets the configured action slot mode.
   * Password input overrides this setting at runtime.
   * @returns The configured action slot mode.
   */
  public get actionSlot(): string {
    return this._actionSlot
  }

  /**
   * Sets the configured action slot mode.
   * Password input still forces the effective action slot to the password toggle.
   * @param action - The action slot mode to configure.
   */
  public set actionSlot(action: "none" | "voiceInput" | "iconChange") {
    if (action === undefined || isEqual(action, this._actionSlot)) return
    this._actionSlot = action
    if (this._initialized) {
      this.markActionSlotModeDirty()
    }
  }

  /**
   * Gets whether the clear button should be created and shown when text is present.
   * @returns `true` when clear button support is enabled.
   */
  public get showClearButton(): boolean {
    return this._showClearButton
  }

  /**
   * Sets whether the clear button should be created and shown when text is present.
   * Rebuilds clear-button UI and refreshes text layout after initialization.
   * @param value - `true` to enable the clear button.
   */
  public set showClearButton(value: boolean) {
    if (value === undefined || isEqual(value, this._showClearButton)) return
    this._showClearButton = value
    if (this._initialized) {
      if (this._showClearButton) {
        this.createClearButton()
        this.updateClearButtonLayout()
        this.updateClearButtonVisibility()
      } else {
        this.destroyClearButton()
      }
      this.markTextLayoutDirty()
    }
  }

  /**
   * The embedded voice input button created for the `"voiceInput"` action slot, exposed so
   * a lens can configure it directly — e.g. set its `secondaryLanguages` to a destination's
   * languages. The field owns the button's lifecycle: configure it, but do not destroy or
   * re-register it. Null before the field initializes, whenever the effective action slot
   * is not voice input (password fields force the password toggle), and until a runtime
   * `actionSlot` change has been applied on the next batched update.
   * @returns The embedded voice input button, or null when the field has none.
   */
  public get voiceInputButton(): VoiceInputButton | null {
    return this.currentActionSlotMode === "voiceInput" ? (this.actionSlotButton as VoiceInputButton) : null
  }

  /**
   * Gets the content component used by the current action slot.
   * @returns The active action slot content, or null when no slot content exists.
   */
  public get actionSlotContent(): ElementContent | null {
    return this.currentActionSlotMode === "voiceInput"
      ? (this.voiceInputButton?.voiceIconContent ?? null)
      : this._actionSlotContent
  }

  /**
   * Action-slot icon size override in cm, or null (default) for the automatic
   * size (slot side × icon factor). The field re-asserts the icon size on every
   * layout pass, so writing the content's `leadingIconSize` directly gets
   * overwritten — this accessor is the supported knob and survives layout,
   * resize, and mode switches.
   */
  public get actionSlotIconSize(): number | null {
    return this._actionSlotIconSizeOverride
  }

  public set actionSlotIconSize(value: number | null) {
    if (value === undefined || value === this._actionSlotIconSizeOverride) return
    this._actionSlotIconSizeOverride = value
    this.applyActionSlotIconSize()
  }

  /**
   * Initializes field-specific action slot state and clear button visibility.
   */
  public initialize(): boolean {
    if (!super.initialize()) {
      return false
    }
    this.applyActionSlotMode()
    this.updateClearButtonVisibility()
    // Honor a rendering-off state set before initialization now that every renderable exists.
    if (!this._renderingEnabled) {
      this.applyRenderingEnabled()
    }
    this.sortHierarchy()
    return true
  }

  /**
   * Applies the interaction state and updates icon-change slot visuals when needed.
   * @param stateName - The state to apply.
   */
  public setState(stateName: StateName) {
    super.setState(stateName)
    if (this.currentActionSlotMode !== "iconChange" || !this._actionSlotContent) {
      return
    }
    const state = this._states.get(stateName)
    const nextIcon =
      state.icon === IconState.alternate && this.changeIconOnFocus && this.alternateIcon
        ? this.alternateIcon
        : this.icon
    if (nextIcon && this._actionSlotContent.leadingIcon !== nextIcon) {
      this._actionSlotContent.leadingIcon = nextIcon
    }
  }

  protected override getAsrVisualSweepMode(): AsrVisualSweepMode {
    return this.resolveTheme()?.name === SYSTEM_3_NAME ? "hold" : super.getAsrVisualSweepMode()
  }

  protected override getAsrVisualSweepPalette(): AsrVisualSweepPalette {
    return this.resolveTheme()?.name === SYSTEM_3_NAME
      ? TEXT_INPUT_FIELD_DS3_ASR_SWEEP_PALETTE
      : super.getAsrVisualSweepPalette()
  }

  protected override getAsrBottomEdgeColor(): vec4 | null {
    return this.resolveTheme()?.name === SYSTEM_3_NAME ? TextInputFieldVoiceEdge : super.getAsrBottomEdgeColor()
  }

  protected get keyboardType(): TextInputSystem.KeyboardType {
    switch (this.inputType) {
      case "numeric":
        return TextInputSystem.KeyboardType.Num
      case "password":
        return TextInputSystem.KeyboardType.Password
      case "pin":
        return TextInputSystem.KeyboardType.Pin
      case "url":
        return TextInputSystem.KeyboardType.Url
      case "email":
        return TextInputSystem.KeyboardType.Email
      case "default":
      default:
        return TextInputSystem.KeyboardType.Text
    }
  }

  // Supersedes the base handler rather than calling super: the reveal and reentrancy guards need
  // seams between the base's three steps (text setter → typingEvent → selection sync), which the
  // base applies atomically. The replicated semantics must stay in sync with
  // BaseTextInputComponent.onTextChangedHandler.
  public override onTextChangedHandler(
    text: string,
    selectionStart?: number,
    selectionEnd?: number,
    editContext?: SystemKeyboardEditContext,
    editDisposition?: SystemKeyboardEditDisposition
  ): void {
    const textChangeHandlerRevision = ++this.textChangeHandlerRevision
    const passwordPresentationRevision = ++this.passwordPresentationRevision
    const previousText = this._text

    // Native callbacks can race blur, hierarchy disable, render release, or destruction. The text
    // commit still flows to the base handler, but only an active, visible edit session may peek.
    const canRevealPasswordCharacter = this.canRevealPasswordCharacter
    // Whole-text snapshots and cached selections cannot prove which characters came from the
    // keyboard. Only an authoritative single-code-point splice may create or restart a password peek.
    const reveal =
      canRevealPasswordCharacter && editContext
        ? detectSoleInsertedCodePointFromEditContext(previousText, text, editContext)
        : null

    // Only a no-change callback proven by the keyboard bridge may retain the original deadline.
    // Context-free same-text snapshots are ambiguous and fail closed like other whole-text updates.
    const isProvenNoChange = editDisposition === "compositionEcho" || editDisposition === "emptyCollapsedNoOp"
    const preservesExistingReveal = previousText === text && !reveal && editContext === undefined && isProvenNoChange

    if (!preservesExistingReveal && !reveal) {
      // Deletions and ambiguous snapshots fail closed before staging the new text. Masking the old
      // coherent frame immediately avoids retaining its exposed character until the next flush.
      this.clearPasswordCharacterReveal(true)
    }

    // Preserve the public setter's virtual dispatch from mainline so downstream subclasses can
    // sanitize or normalize keyboard text. The scoped assignment context prevents this class's
    // own programmatic-write guard from cancelling an otherwise authoritative keyboard peek.
    const previousKeyboardTextAssignmentContext = this.keyboardTextAssignmentContext
    const keyboardTextAssignmentContext: KeyboardTextAssignmentContext = {
      setterCalls: 0,
      lastMutatingSetterHandlerRevision: textChangeHandlerRevision
    }
    this.keyboardTextAssignmentContext = keyboardTextAssignmentContext
    try {
      this.text = text
    } finally {
      this.keyboardTextAssignmentContext = previousKeyboardTextAssignmentContext
    }
    // Equality-guarded subclass setters may legitimately skip the base setter for a proven IME
    // no-op. Do not extend that exception to same-text replacements, which must remain fail-closed
    // when the subclass's acceptance cannot be observed.
    const setterAcceptedKeyboardText =
      keyboardTextAssignmentContext.setterCalls === 1 ||
      (keyboardTextAssignmentContext.setterCalls === 0 && preservesExistingReveal)
    const setterCommittedText = this._text
    const keyboardTextAcceptedUnchanged = setterAcceptedKeyboardText && setterCommittedText === text
    const newerKeyboardCallbackOwnsPresentation =
      this.textChangeHandlerRevision > keyboardTextAssignmentContext.lastMutatingSetterHandlerRevision
    if (!keyboardTextAcceptedUnchanged && !newerKeyboardCallbackOwnsPresentation) {
      // A downstream setter changed, rejected, or multiply reassigned the callback value. Its raw
      // splice no longer describes the committed text, so fail closed immediately.
      this.clearPasswordCharacterReveal(true)
    }
    this.typingEvent.invoke()
    // Keyboard-callback ownership is separate from password-presentation validity. Programmatic
    // away-and-back writes cancel the peek but must retain this callback's authoritative selection;
    // same-length normalization preserves compatible UTF-16 indices when they remain code-point
    // boundaries, while a nested keyboard callback owns its newer selection instead. A setter that
    // changes the text's length (e.g. a future max-length truncation) must clamp and resync the
    // selection itself — this path intentionally skips the sync rather than apply indices that
    // refer to the keyboard's differently-sized text.
    const callbackStillOwnsCommittedText =
      this.textChangeHandlerRevision === textChangeHandlerRevision && this._text === setterCommittedText
    const selectionIndexSpaceCompatible =
      setterAcceptedKeyboardText &&
      setterCommittedText.length === text.length &&
      (selectionStart === undefined || isCodePointBoundary(setterCommittedText, selectionStart)) &&
      (selectionEnd === undefined || isCodePointBoundary(setterCommittedText, selectionEnd))

    if (
      callbackStillOwnsCommittedText &&
      selectionIndexSpaceCompatible &&
      selectionStart !== undefined &&
      selectionEnd !== undefined
    ) {
      this.onSetSelectionHandler(selectionStart, selectionEnd)
    }

    const presentationStillCurrent =
      keyboardTextAcceptedUnchanged &&
      callbackStillOwnsCommittedText &&
      this.passwordPresentationRevision === passwordPresentationRevision
    if (!presentationStillCurrent) return

    if (preservesExistingReveal) return

    if (this.canRevealPasswordCharacter) {
      // The keyboard assignment completed without another synchronous text mutation, keyboard
      // callback, or lifecycle transition. Any such intervening work keeps the field masked.
      this.setPasswordCharacterReveal(reveal)
      // Paint keyboard text and its authoritative selection in the same batched flush. This keeps
      // caret geometry coherent even when the callback arrives after this field's LateUpdate.
      this.markTextPresentationDirty()
    }
  }

  private get effectiveActionSlotMode(): ActionSlotMode {
    if (this.inputType === "password") return "password"
    return (this._actionSlot as ActionSlotMode) ?? "none"
  }

  private get isPasswordFullyVisible(): boolean {
    return !this.hidePassword || this.isPasswordHoverRevealActive
  }

  private get isPasswordHoverRevealActive(): boolean {
    const passwordButton = this.actionSlotButton
    return (
      this.passwordButtonHovered &&
      this.inputType === "password" &&
      this.currentActionSlotMode === "password" &&
      !!passwordButton &&
      this.isCurrentPasswordButtonSource(passwordButton) &&
      this.canEnterPasswordReveal(passwordButton)
    )
  }

  private get canRevealPasswordCharacter(): boolean {
    return (
      this.inputType === "password" &&
      this.isEditing &&
      this._renderingEnabled &&
      !this.inactive &&
      !isComponentBeingDestroyed(this) &&
      this.isEnabledInHierarchy
    )
  }

  private get isClearButtonVisible(): boolean {
    return !this.voiceStatusPlaceholderActive && !this.isPlaceholder && this._text !== ""
  }

  private get isRightAligned(): boolean {
    return this._horizontalTextAlignment === TextAlignment.Right
  }

  protected createDefaultVisual(): void {
    super.createDefaultVisual()
    if (this._showClearButton) {
      this.createClearButton()
    }
  }

  protected initializeTextComponent(): void {
    this.applyTextAlignment()
    // A single-line field never scrolls vertically, so native clipping can always constrain that
    // axis. Horizontally, inactive text is native-truncated; editing temporarily uses Overflow so
    // the text rect can scroll behind the lazily allocated ancestor mask.
    this.textComponent.verticalOverflow = VerticalOverflow.Truncate
    this.applyHorizontalOverflow(false)
  }

  protected updateVisibleText(text: string): void {
    if (this.inputType !== "password" || this.isPlaceholder || this.isPasswordFullyVisible) {
      this.textComponent.text = text
      return
    }

    const reveal = this.passwordCharacterReveal
    if (
      reveal &&
      reveal.sourceText === text &&
      reveal.start >= 0 &&
      reveal.end <= text.length &&
      reveal.start < reveal.end
    ) {
      // Keep the legacy UTF-16 mask width so display/caret indices remain aligned. A supplementary
      // character occupies two code units and therefore returns to two mask glyphs after the peek.
      this.textComponent.text =
        "*".repeat(reveal.start) + text.slice(reveal.start, reveal.end) + "*".repeat(text.length - reveal.end)
      return
    }

    this.textComponent.text = "*".repeat(text.length)
  }

  protected onTextUpdated(textChanged: boolean = true): void {
    if (this.passwordCharacterReveal && this.passwordCharacterReveal.sourceText !== this._text) {
      // Programmatic, voice, clear, and text-manipulation updates do not inherit a keyboard peek.
      this.clearPasswordCharacterReveal(false)
    }
    super.onTextUpdated(textChanged)
    if (this._text === "" && this.contentRequiredOnDeactivate) {
      this._hasError = true
    }
    this.updateClearButtonVisibility()
  }

  protected updateSize() {
    super.updateSize()
    if (this.currentActionSlotMode !== "none") {
      this.updateActionSlotLayout()
    }
    this.updateClearButtonLayout()
    this.applyDockContraction()
  }

  protected applyOpacity(): void {
    super.applyOpacity()
    this.applyFieldControlOpacity()
  }

  private applyFieldControlOpacity(target: FieldControlOpacityTarget = "all"): void {
    if (target === "all" || target === "actionSlot") {
      if (this.actionSlotButton) {
        this.actionSlotButton.opacity = this._opacity
      }
      if (this._actionSlotContent) {
        this._actionSlotContent.opacity = this._opacity
      }
    }
    if (target === "all" || target === "clearButton") {
      if (this.clearButton) {
        this.clearButton.opacity = this._opacity
      }
      if (this.clearButtonContent) {
        this.clearButtonContent.opacity = this._opacity
      }
    }
  }

  /**
   * Extends the base release (background + shadow, text, and any allocated mask) with the
   * action-slot and clear-button controls owned by the field.
   */
  protected applyRenderingEnabled(): void {
    // Pre-initialization gate: controls do not exist yet (isNull does not catch undefined members),
    // and the end-of-initialize tail applies the held flag once they do.
    if (!this._initialized) {
      return
    }
    if (!this._renderingEnabled) {
      this.clearPasswordTransientState(true)
    }
    super.applyRenderingEnabled()
    this.applyControlRendering()
  }

  public override setRenderingEnabled(enabled: boolean): void {
    const renderingChanged = enabled !== this._renderingEnabled
    if (!enabled) {
      // Releasing rendering disables the interactable: as on the inactive path, stop stepping now and
      // let IK's cancel deliver the gesture's drag end on the next interaction update.
      this.resetDragAdjust()
    }
    if (renderingChanged) {
      this.passwordButtonAvailabilityRevision++
      // Unsubscribe before child controls are restored; the post-restore rebind is a second barrier
      // against callbacks synchronously dispatched while their components are re-enabled.
      this.invalidatePasswordPresentation(false)
    }
    super.setRenderingEnabled(enabled)
    if (enabled && renderingChanged) {
      this.rebindPasswordButtonEvents()
    }
  }

  /**
   * Drives the action-slot and clear-button controls (and their content) to {@link _renderingEnabled}.
   * Split out so creation paths can reconcile freshly-built controls without touching the field's own
   * background / text / masking.
   */
  private applyControlRendering(): void {
    this.setButtonRenderingEnabled(this.actionSlotButton, this._renderingEnabled)
    // Reach the action-slot content via the getter: in voiceInput mode the icon lives on the
    // VoiceInputButton's voiceIconContent and _actionSlotContent is null.
    const slotContent = this.actionSlotContent
    if (slotContent) {
      slotContent.setRenderingEnabled(this._renderingEnabled)
    }
    this.setButtonRenderingEnabled(this.clearButton, this._renderingEnabled)
    if (this.clearButtonContent) {
      this.clearButtonContent.setRenderingEnabled(this._renderingEnabled)
    }
  }

  /**
   * Component-level gate: disabling the button component releases its visuals AND interaction in a
   * single race-free step - a button component left disabled never fires its own onEnabled/
   * enableVisuals cascade, which is what beats the re-enable race that a bare renderMeshVisual
   * toggle loses.
   */
  private setButtonRenderingEnabled(button: Button | null, enabled: boolean): void {
    if (isNull(button)) {
      return
    }
    button.enabled = enabled
  }

  /**
   * Extends the base render-gated set (field text and any allocated mask) with the action-slot and
   * clear buttons. Content components are excluded - their renderables are held released by
   * ElementContent's own persistent flag, and ElementContent has no onEnabled to clobber.
   */
  protected isRenderGatedManagedComponent(component: Component): boolean {
    return (
      super.isRenderGatedManagedComponent(component) ||
      component === this.actionSlotButton ||
      component === this.clearButton
    )
  }

  private updateActionSlotLayout(): void {
    const slotSide = this.updateActionSlotPosition()
    if (slotSide === null) return

    this.updateActionSlotButtonLayout(slotSide)
    this.updateActionSlotContentLayout(slotSide)
  }

  private updateActionSlotPosition(): number | null {
    if (!this.actionSlotTransform) return null

    const slotSide = this._size.y * ACTION_SLOT_HEIGHT_FACTOR
    this.actionSlotPosition.x = this.isRightAligned
      ? this._size.x * 0.5 - this._size.y * 0.5
      : -this._size.x * 0.5 + this._size.y * 0.5
    this.actionSlotPosition.y = 0
    this.actionSlotPosition.z = MASK_Z_OFFSET + 0.5
    this.actionSlotTransform.setLocalPosition(this.actionSlotPosition)

    return slotSide
  }

  private updateActionSlotButtonLayout(slotSide: number): void {
    if (!this.actionSlotButton) return

    const currentButtonSize = this.actionSlotButton.size
    if (currentButtonSize.x !== slotSide || currentButtonSize.y !== slotSide || currentButtonSize.z !== 1) {
      this.actionSlotButton.size = new vec3(slotSide, slotSide, 1)
    }
    this.updateFullHeightButtonCollider(this.actionSlotButton)
  }

  private updateActionSlotContentLayout(slotSide: number): void {
    if (!this._actionSlotContent) return

    const slotWidth = this.actionSlotButton?.size.x ?? slotSide
    const slotHeight = this.actionSlotButton?.size.y ?? slotSide
    this._actionSlotContent.sizeOverride = new vec2(slotWidth, slotHeight)
    this._actionSlotContent.leadingIconSize = this.computeActionSlotIconSize(slotWidth, slotHeight)
  }

  private computeActionSlotIconSize(slotWidth: number, slotHeight: number): number {
    return this._actionSlotIconSizeOverride ?? Math.min(slotWidth, slotHeight) * ACTION_SLOT_ICON_SIZE_FACTOR
  }

  // Push the current override to whichever content the active mode uses.
  // Voice mode delegates to the button's own timing-proof override.
  private applyActionSlotIconSize(): void {
    const voiceButton = this.voiceInputButton
    if (voiceButton) {
      voiceButton.voiceIconSize = this._actionSlotIconSizeOverride
      return
    }
    if (this._actionSlotContent) {
      const slotSide = this._size.y * ACTION_SLOT_HEIGHT_FACTOR
      const slotWidth = this.actionSlotButton?.size.x ?? slotSide
      const slotHeight = this.actionSlotButton?.size.y ?? slotSide
      this._actionSlotContent.leadingIconSize = this.computeActionSlotIconSize(slotWidth, slotHeight)
    }
  }

  protected flushBatchedUpdates(): void {
    const sizeDirty = this._sizeDirty
    const fontDirty = this._fontDirty
    const fontSizeDirty = this._fontSizeDirty
    super.flushBatchedUpdates()
    const actionSlotModeDirty = this._actionSlotModeDirty
    const alignmentDirty = this._alignmentDirty
    this._actionSlotModeDirty = false
    this._alignmentDirty = false
    if (actionSlotModeDirty) {
      this.applyActionSlotMode()
    }
    if (alignmentDirty) {
      this.applyTextAlignment()
      this.applyHorizontalOverflow(this.isEditing)
      this._scrollOffsetX = 0
      if (!sizeDirty) {
        this.updateSize()
      }
    }
    const textLayoutDirty = this._textLayoutDirty
    this._textLayoutDirty = false
    this.refreshTextGeometryAndLayout({
      fromFont: fontDirty,
      fromFontSize: fontSizeDirty || sizeDirty,
      fromAnchors: sizeDirty,
      fromAlignment: alignmentDirty,
      updateTextLayout: sizeDirty || alignmentDirty || textLayoutDirty
    })
  }

  protected hasPendingBatchedUpdates(): boolean {
    return super.hasPendingBatchedUpdates() || this._actionSlotModeDirty
  }

  private markActionSlotModeDirty(): void {
    if (!this._initialized) return
    this._actionSlotModeDirty = true
    this.batchUpdate()
  }

  protected override onEditModeChanged(editing: boolean): void {
    super.onEditModeChanged(editing)
    if (!editing) {
      // Blur cancels only the timed keyboard peek. A physical eye hover remains authoritative until
      // its real exit or an availability boundary such as disable, render release, or teardown.
      this.passwordPresentationRevision++
      this.clearPasswordCharacterReveal(true)
    }
    // Edit listeners (notably ToolbarTextField) may synchronously change the logical alignment.
    // Reconcile native truncation after those listeners so Right immediately uses TruncateFront.
    this.applyHorizontalOverflow(editing)
    this.markTextLayoutDirty()
    this.updateDockContraction()
  }

  /**
   * Switches native horizontal clipping before the manipulation mask changes state. Editing needs
   * unconstrained text so the text rect can scroll behind the fixed ancestor mask; inactive fields
   * use native truncation unless their configured offsets extend the Text bounds past the viewport.
   */
  protected override prepareTextManipulationEditMode(editing: boolean): void {
    if (!editing) {
      this._scrollOffsetX = 0
      this.applyScrollOffset()
    }
    this.applyHorizontalOverflow(editing)
    this.markTextLayoutDirty()
  }

  // ─── Drag to adjust (numeric) ────────────────────────────────────────

  /**
   * `true` while a drag on the field may step its number: numeric type with an axis chosen, and
   * neither the keyboard (edit mode) nor a voice session owns the text. Re-checked on every drag
   * update so either taking over mid-gesture stops the adjustment immediately.
   */
  private get canDragAdjust(): boolean {
    return (
      this.inputType === "numeric" &&
      this._dragAdjustAxis !== "none" &&
      !this.isEditing &&
      !this.isVoiceInputListening &&
      !this.inactive &&
      this._renderingEnabled
    )
  }

  /**
   * `true` for drag events the field's own interactable is the target of. IK also delivers the
   * clear button's and action slot's drags here as they propagate up the hierarchy; those must
   * not step the number, the same way the base trigger handler ignores them.
   */
  private isOwnDragEvent(dragEvent: DragInteractorEvent): boolean {
    return dragEvent.target === this.interactable
  }

  private resetDragAdjust(): void {
    this.dragAdjustSession = null
    this.dragAdjustChangedValue = false
  }

  protected override onTriggerDownHandler(event: InteractorEvent): void {
    if (event.target === this.interactable) {
      // IK fires this once per press, when the first hand pinches. A new press starts a new
      // gesture, which also drops state whose drag end never arrived (an ancestor stopped
      // propagation, or the interactable was disabled mid-drag), so a stale session can never
      // keep swallowing taps. A second hand joining mid-press does not come through here; it
      // takes the gesture over in onInteractableDragStart instead.
      this.resetDragAdjust()
    }
    super.onTriggerDownHandler(event)
  }

  protected override onInteractableDragStart(dragEvent: DragInteractorEvent): void {
    super.onInteractableDragStart(dragEvent)
    if (!this.isOwnDragEvent(dragEvent)) return
    this.dragAdjustSession = null
    if (!this.canDragAdjust) return

    const startPosition = this.getInteractionPosition(dragEvent.interactor)
    if (!startPosition) return
    // Placeholder shows as "" and parses as 0, and a unit suffix ("50%") rides along unchanged;
    // anything that is not a plain decimal, with or without one, is left alone.
    const start = parseNumberWithSuffix(this._text)
    if (!start) {
      log.d(`${this.sceneObject.name} drag-adjust skipped: "${this._text}" is not a number`)
      return
    }
    // A tap on this field may have queued a deferred focus (field switch / recently closed
    // keyboard). The drag now owns the gesture, so that keyboard must not open underneath it.
    this.cancelRequestKeyboard()
    this.dragAdjustSession = {
      interactor: dragEvent.interactor,
      startPosition,
      startValue: start.value,
      suffix: start.suffix,
      stepDistance: this._size.y * DRAG_ADJUST_STEP_DISTANCE_FACTOR,
      lastSteps: 0,
      adjusting: true
    }
  }

  protected override onInteractableDragUpdate(dragEvent: DragInteractorEvent): void {
    const session = this.dragAdjustSession
    if (session?.adjusting && session.interactor === dragEvent.interactor && this.isOwnDragEvent(dragEvent)) {
      if (this.canDragAdjust) {
        this.applyDragAdjust(session, dragEvent)
      } else {
        session.adjusting = false
      }
    }
    super.onInteractableDragUpdate(dragEvent)
  }

  protected override onInteractableDragEnd(dragEvent: DragInteractorEvent): void {
    if (this.dragAdjustSession?.interactor === dragEvent.interactor) {
      this.dragAdjustSession = null
    }
    super.onInteractableDragEnd(dragEvent)
  }

  protected override focusOnRelease(): boolean {
    // IK fires the release once per press, when the last hand lets go (and before that hand's drag
    // end). A press that stepped the value still reports its release but doesn't focus the field;
    // a tap or a too-short drag opens the keyboard as before.
    if (this.dragAdjustChangedValue) {
      this.dragAdjustChangedValue = false
      return false
    }
    return true
  }

  private applyDragAdjust(session: DragAdjustSession, dragEvent: DragInteractorEvent): void {
    const position = this.getInteractionPosition(dragEvent.interactor)
    if (!position) return

    const delta = dragAxisDelta(this._dragAdjustAxis, session.startPosition, position)
    const steps = dragStepsForDelta(delta, session.stepDistance)
    if (steps === session.lastSteps) return

    const next = stepScaledDecimal(session.startValue, steps)
    if (!next) return
    session.lastSteps = steps
    this.dragAdjustChangedValue = true
    this.text = formatNumberWithSuffix(next, session.suffix)
    // Like a keyboard session ending, a completed edit clears a content-required error. Cleared
    // here, while the field is still in its triggered state, so the release transition computes
    // the hovered state from the new value.
    this._hasError = false
  }

  private applyHorizontalOverflow(editing: boolean): void {
    const nextOverflow = editing
      ? HorizontalOverflow.Overflow
      : this.isRightAligned
        ? HorizontalOverflow.TruncateFront
        : HorizontalOverflow.Truncate
    if (this.textComponent.horizontalOverflow === nextOverflow) return

    this.textComponent.horizontalOverflow = nextOverflow
    if (this.textManipulationModule) {
      this.textManipulationModule.refresh({fromOverflow: true})
    }
  }

  protected updateTextLayout(): void {
    const baseInset = this._textSideInset ?? this._size.y * INSET_FACTOR_SINGLE_LINE
    let leftInset = baseInset
    let rightInset = baseInset
    const buttonInset = this._size.y * BUTTON_INSET_FACTOR

    if (this.currentActionSlotMode !== "none") {
      const actionSlotHalfWidth = this._size.y * ACTION_SLOT_HEIGHT_FACTOR * 0.5
      let actionSlotInset = this._size.y * 0.5 + actionSlotHalfWidth + buttonInset
      // While docked the slot is hidden and the field contracts by the same width; blending
      // the inset keeps the text viewport width (and thus the text itself) steady mid-tween.
      actionSlotInset += (this._size.y * INSET_FACTOR_SINGLE_LINE - actionSlotInset) * this.dockContractionProgress
      if (this.isRightAligned) {
        rightInset = actionSlotInset
      } else {
        leftInset = actionSlotInset
      }
    }

    if (this.clearButtonObject && this.isClearButtonVisible) {
      const clearInset = this.clearButtonWidth + buttonInset * 2
      if (this.isRightAligned) {
        leftInset = clearInset
      } else {
        rightInset = clearInset
      }
    }

    const halfWidth = this.dockEffectiveWidth * 0.5
    this.setTextViewportBounds(-halfWidth + leftInset, halfWidth - rightInset, this._size.y * -0.5, this._size.y * 0.5)

    this.updateTextAvailableWidth()
    let scrollOffsetApplied = false
    if (this.isEditing) {
      scrollOffsetApplied = this.updateScrollOffset(this.textManipulationModule.caretIndex)
      if (!scrollOffsetApplied) {
        this.clampScrollOffset()
      }
    } else {
      this._scrollOffsetX = 0
    }
    if (!scrollOffsetApplied) {
      this.applyScrollOffset()
    }
  }

  private updateTextAvailableWidth(): void {
    const viewportWidth = this.textViewportBounds.getSize().x
    this.textAvailableWidth = viewportWidth - this.textOffset.x + this.textOffset.y
  }

  private applyScrollOffset(): void {
    if (!this.textObjectScreenTransform) return
    const leftOffset = this.textOffset.x + this._scrollOffsetX
    const rightOffset = this.textOffset.y + this._scrollOffsetX
    this.textObjectScreenTransform.offsets.left = leftOffset
    this.textObjectScreenTransform.offsets.right = rightOffset

    // Native Truncate clips to the Text component's translated bounds, not to the fixed field
    // viewport. Preserve the ancestor mask whenever either edge extends beyond that viewport.
    this.setTextOverflowRequiresMask(leftOffset < 0 || rightOffset > 0)
  }

  private clampScrollOffset(): void {
    const boundingBox = this.textManipulationModule?.boundingBox
    if (!boundingBox) return
    const textWidth = boundingBox.getSize().x
    if (textWidth <= this.textAvailableWidth) {
      this._scrollOffsetX = 0
      return
    }
    const scrollRange = textWidth - this.textAvailableWidth
    if (this.isRightAligned) {
      this._scrollOffsetX = Math.max(0, Math.min(scrollRange, this._scrollOffsetX))
    } else {
      this._scrollOffsetX = Math.max(-scrollRange, Math.min(0, this._scrollOffsetX))
    }
  }

  protected updateScrollOffset(targetIndex: number): boolean {
    if (!this.isEditing) return false
    const cursorPositionData = this.textManipulationModule.cursorPositions?.[targetIndex]
    if (!cursorPositionData) return false

    const previousScroll = this._scrollOffsetX
    const boundingBox = this.textManipulationModule.boundingBox
    const textWidth = boundingBox ? boundingBox.getSize().x : 0

    if (textWidth <= this.textAvailableWidth) {
      this._scrollOffsetX = 0
    } else {
      const halfWidth = this.textAvailableWidth / 2
      const caretX = cursorPositionData.position.x
      if (caretX > halfWidth) {
        this._scrollOffsetX -= caretX - halfWidth
      } else if (caretX < -halfWidth) {
        this._scrollOffsetX += -halfWidth - caretX
      }
      const scrollRange = textWidth - this.textAvailableWidth
      if (this.isRightAligned) {
        this._scrollOffsetX = Math.max(0, Math.min(scrollRange, this._scrollOffsetX))
      } else {
        this._scrollOffsetX = Math.max(-scrollRange, Math.min(0, this._scrollOffsetX))
      }
    }

    if (this._scrollOffsetX === previousScroll) return false

    this.applyScrollOffset()
    return true
  }

  private updateClearButtonVisibility(): void {
    if (!this.clearButtonObject) return
    const wasClearButtonVisible = this.clearButtonObject.enabled
    if (wasClearButtonVisible === this.isClearButtonVisible) return
    this.clearButtonObject.enabled = this.isClearButtonVisible
    this.markTextLayoutDirty()
    // Showing is the first moment the label may be measured (hidden Texts are never probed), and
    // the moment an unfitted label would become visible.
    if (this.isClearButtonVisible) this.fitClearButtonLabel()
  }

  /** Width of the clear button's body; also the room its label is fitted into. */
  private get clearButtonWidth(): number {
    return this._size.y * CLEAR_BUTTON_HEIGHT_FACTOR * CLEAR_BUTTON_WIDTH_TO_HEIGHT_RATIO
  }

  private updateClearButtonLayout(): void {
    if (!this.clearButtonObject || !this.clearButton || !this.clearButtonTransform) return

    const h = this._size.y * CLEAR_BUTTON_HEIGHT_FACTOR
    const w = this.clearButtonWidth
    const inset = this._size.y * BUTTON_INSET_FACTOR
    this.clearButton.size = new vec3(w, h, 1)
    this.updateFullHeightButtonCollider(this.clearButton)
    const halfWidth = this.dockEffectiveWidth * 0.5
    const clearX = this.isRightAligned ? -halfWidth + w * 0.5 + inset : halfWidth - w * 0.5 - inset
    this.clearButtonPosition.x = clearX
    this.clearButtonPosition.y = 0
    this.clearButtonPosition.z = MASK_Z_OFFSET + 0.01
    this.clearButtonTransform.setLocalPosition(this.clearButtonPosition)
    this.fitClearButtonLabel()
  }

  /**
   * Sizes the clear label to its button. The label renders at the field's font size unless its
   * measured natural width would exceed {@link CLEAR_BUTTON_LABEL_MAX_WIDTH_FACTOR} of the button
   * width; a longer translation ("Effacer") then shrinks to span exactly that room. The width comes
   * from a real glyph measurement, never a character count. Text width is linear in font size, so
   * the measured per-size-unit ratio stays exact across field resizes and font-size changes. The
   * measurement is re-read while the button is showing (a cache hit once the label has settled) so
   * ElementContent's own correction for late-landing font metrics is picked up, and the ratio only
   * moves when a reading drifts past {@link CLEAR_BUTTON_LABEL_RATIO_TOLERANCE}. A hidden button's
   * Text is never probed: it can read zero and would leave the content's measurement continuation
   * pending, so hidden fits run from the stored ratio.
   *
   * Until the first measurement lands (the content is not built yet, or the host refused this
   * frame's attempt) the label keeps the base size; the content's layout hook and the show-time fit
   * retry it. That can show a long translation unfitted for a frame on its first appearance; a label
   * that never measures keeps today's behavior (base size) rather than disappearing.
   */
  private fitClearButtonLabel(): void {
    const content = this.clearButtonContent
    if (!content || isNull(content)) return
    const baseSize = this.computeFontSize()
    const button = this.clearButtonObject
    if (button && !isNull(button) && button.enabled) {
      const measuredWidth = content.measureNaturalTextWidth()
      const text = content.textComponent
      if (measuredWidth !== null && text && !isNull(text)) {
        const ratio = labelWidthPerSizeUnit(measuredWidth, text.size)
        if (
          ratio !== null &&
          labelRatioDrifted(this.clearLabelWidthPerSizeUnit, ratio, CLEAR_BUTTON_LABEL_RATIO_TOLERANCE)
        ) {
          this.clearLabelWidthPerSizeUnit = ratio
        }
      }
    }
    if (this.clearLabelWidthPerSizeUnit === null) {
      content.textSize = baseSize
      return
    }
    const maxWidth = this.clearButtonWidth * CLEAR_BUTTON_LABEL_MAX_WIDTH_FACTOR
    content.textSize = fitLabelSize(baseSize, this.clearLabelWidthPerSizeUnit, maxWidth, CLEAR_BUTTON_LABEL_MIN_SCALE)
  }

  /**
   * Re-runs the fit after every layout pass of the clear content, for the content's lifetime.
   * ElementContent re-lays out when its bounded font revalidation finds the label's metrics moved
   * after the first measurement; by then the corrected natural width is a cache hit, so the label
   * refits in the same frame the metrics settle instead of waiting for the next field update. The
   * same hook retries a first measurement the host refused, since the content keeps laying out
   * each frame while that is outstanding. Never a synchronous re-layout: a size written here is
   * flushed by ElementContent's own deferred pass, and an unchanged size is a no-op on its setter.
   */
  private subscribeClearLabelLayout(): void {
    if (this.clearLabelLayoutUnsubscribe) return
    const layout = this.clearButtonContent?.layout
    if (!layout) return
    this.clearLabelLayoutUnsubscribe = layout.onLayoutComplete.add(() => this.fitClearButtonLabel())
  }

  private unsubscribeClearLabelFit(): void {
    if (this.clearContentInitializedUnsubscribe) {
      this.clearContentInitializedUnsubscribe()
      this.clearContentInitializedUnsubscribe = null
    }
    if (this.clearLabelLayoutUnsubscribe) {
      this.clearLabelLayoutUnsubscribe()
      this.clearLabelLayoutUnsubscribe = null
    }
  }

  private updateFullHeightButtonCollider(button: Button | null): void {
    if (!button) return

    const buttonSize = button.size
    button.colliderFitElement = false
    // Stretch the tap target to the field's full height but keep the button's visual width:
    // scaling the width too made the collider as wide as the field is tall, stealing taps from
    // the text area beside the button.
    button.colliderSize = new vec3(buttonSize.x, this._size.y, buttonSize.z)
  }

  /**
   * Field width with the docked contraction applied. Background/edge geometry only — the
   * authored size, canvas, and collider are untouched.
   */
  private get dockEffectiveWidth(): number {
    return this._size.x - this._size.y * DOCK_CONTRACTION_FACTOR * this.dockContractionProgress
  }

  private get shouldContractForDock(): boolean {
    // Only the edited field tucks in. A plain deselect undocks immediately (zero release
    // grace), so the restore rides the return flight; on a field switch within a docked
    // panel this field restores at blur while the panel stays put.
    return (
      this.focusFrameDocked &&
      this.isEditing &&
      this.currentActionSlotMode === "voiceInput" &&
      this.actionSlotObject !== null
    )
  }

  protected override onFocusFrameDockChanged(_docked: boolean): void {
    this.updateDockContraction()
  }

  private updateDockContraction(): void {
    const target = this.shouldContractForDock ? 1 : 0

    if (target === 1 && !this.dockSlotHidden && this.actionSlotObject) {
      // Hide up front (the tween then closes the gap). End an in-flight recording first so
      // the session doesn't keep running behind an invisible button.
      const voiceButton = this.voiceInputButton
      if (voiceButton?.isOn) {
        voiceButton.toggle(false)
      }
      this.actionSlotObject.enabled = false
      this.dockSlotHidden = true
    }

    if (target === this.dockContractionProgress) {
      this.finishDockContraction(target)
      return
    }

    this.dockContractionCancelSet()
    if (!this._initialized) {
      this.dockContractionProgress = target
      this.finishDockContraction(target)
      return
    }

    const start = this.dockContractionProgress
    animate({
      cancelSet: this.dockContractionCancelSet,
      duration: STATE_ANIMATION_DURATION,
      easing: "ease-in-out-cubic",
      update: (t: number) => {
        this.dockContractionProgress = start + (target - start) * t
        this.applyDockContraction()
        this.updateClearButtonLayout()
        this.markTextLayoutDirty()
      },
      ended: () => this.finishDockContraction(target)
    })
  }

  /** Restores the slot only once fully expanded, so it never overlaps the closing edge. */
  private finishDockContraction(target: number): void {
    if (target === 0 && this.dockSlotHidden) {
      if (this.actionSlotObject) {
        this.actionSlotObject.enabled = true
      }
      this.dockSlotHidden = false
    }
  }

  /** Applies the contracted width to the background (and its shadow) only. */
  private applyDockContraction(): void {
    if (!this._initialized) return
    const visual = this.visual
    if (!(visual instanceof RoundedRectangleVisual)) return
    const width = this.dockEffectiveWidth
    if (visual.size.x !== width) {
      visual.size = new vec3(width, this._size.y, this._size.z)
    }
    const shadow = this.shadowVisual
    if (shadow && shadow.size.x !== width) {
      shadow.size = new vec3(width, this._size.y, this._size.z)
    }
  }

  protected updateRenderOrder(value: number) {
    super.updateRenderOrder(value)
    if (this.currentActionSlotMode !== "none" && this.actionSlotButton) {
      this.actionSlotButton.renderOrder = value
    }
    if (this.actionSlotContent) {
      this.actionSlotContent.renderOrder = value
    }
    if (this.clearButton) this.clearButton.renderOrder = value
    if (this.clearButtonContent) {
      this.clearButtonContent.renderOrder = value
    }
  }

  protected sortAdditionalHierarchy(): void {
    this.moveHierarchyChildToForeground(this.clearButtonObject)
    this.moveHierarchyChildToForeground(this.actionSlotObject)
  }

  protected computeFontSize(): number {
    if (this._fontSize > 0) {
      return this._fontSize * (this._size.y / this._originalSize.y)
    }
    return this._size.y * FONT_SIZE_SCALE
  }

  protected release() {
    this.resetDragAdjust()
    this.dockContractionCancelSet()
    this.dockContractionProgress = 0
    this.invalidatePasswordPresentation(false)
    this.destroyActionSlot()
    this.unsubscribeClearLabelFit()
    super.release()
  }

  protected override onDisabled(): void {
    this.resetDragAdjust()
    this.passwordButtonAvailabilityRevision++
    this.invalidatePasswordPresentation(false)
    this.clearPasswordTransientState(true)
    super.onDisabled()
  }

  protected override onEnabled(): void {
    this.passwordButtonAvailabilityRevision++
    // The host is enabled before this event runs, but managed child controls are still disabled.
    // Invalidate first so restoring them cannot run an old callback in an eligible hierarchy.
    this.invalidatePasswordPresentation(false)
    super.onEnabled()
    this.rebindPasswordButtonEvents()
  }

  private createActionSlot(mode: Exclude<ActionSlotMode, "none">): void {
    if (this.actionSlotObject) return

    const isVoiceInput = mode === "voiceInput"
    const isIconChange = mode === "iconChange"

    this.actionSlotObject = global.scene.createSceneObject(
      isVoiceInput ? "VoiceInputButton" : isIconChange ? "ActionIconSlot" : "ActionSlotButton"
    )
    this.managedSceneObjects.add(this.actionSlotObject)
    this.actionSlotTransform = this.actionSlotObject.getTransform()
    this.actionSlotObject.layer = this.sceneObject.layer
    this.actionSlotObject.setParent(this.sceneObject)

    if (!isIconChange) {
      this.actionSlotButton = isVoiceInput
        ? (this.actionSlotObject.createComponent(VoiceInputButton.getTypeName()) as VoiceInputButton)
        : this.actionSlotObject.createComponent(Button.getTypeName())
      this.addManagedComponent(this.actionSlotButton)
      this.actionSlotButton.renderOrder = this._renderOrder
      this.actionSlotButton.setTheme("System 3.0", "PrismGhost")
    }

    if (isVoiceInput && this.actionSlotButton) {
      const voiceInputButton = this.actionSlotButton as VoiceInputButton
      // Mark embedded BEFORE the button initializes (createComponent hasn't run
      // the button's OnStart yet), so it renders as the BeveledPrism action-slot
      // button and the field — not the button — owns the voice animation.
      voiceInputButton.markEmbeddedInField()
      if (this._actionSlotIconSizeOverride !== null) {
        voiceInputButton.voiceIconSize = this._actionSlotIconSizeOverride
      }
      this.registerVoiceInputButton(voiceInputButton)
      // The button's toggle value is the one signal that covers every session
      // end, not just a final transcript, so republish it as field-level state.
      this.voiceStateUnsubscribe = voiceInputButton.onValueChange.add((value: number) =>
        this.voiceStateChangedEvent.invoke(value === 1)
      )
      this.voiceInputUnsubscribe = voiceInputButton.onInitialized.add(() => {
        this.updateActionSlotLayout()
        this.updateRenderOrder(this._renderOrder)
      })
      this.sortHierarchy()
      return
    }

    this.createActionSlotContent(isIconChange ? "iconChange" : "password")

    const passwordButton = this.actionSlotButton
    if (passwordButton) {
      passwordButton.setIsToggleable(true)
      passwordButton.onInitialized.add(() => {
        this.updateActionSlotLayout()
        this.updateRenderOrder(this._renderOrder)
      })
      this.rebindPasswordButtonEvents()
    }
    this.sortHierarchy()
  }

  private createActionSlotContent(mode: Exclude<ActionSlotMode, "none" | "voiceInput">): void {
    if (!this.actionSlotObject) return

    this._actionSlotContent = this.actionSlotObject.createComponent(ElementContent.getTypeName()) as ElementContent
    this.addManagedComponent(this._actionSlotContent)
    this._actionSlotContent.text = ""
    this._actionSlotContent.trailingIcon = null
    this._actionSlotContent.textAlignment = ContentTextAlignment.Center
    this._actionSlotContent.iconLayout = "left"
    this._actionSlotContent.spacing = 0
    this._actionSlotContent.padding = {top: 0, right: 0, bottom: 0, left: 0}
    this._actionSlotContent.autoResize = false
    this._actionSlotContent.renderOrder = this._renderOrder

    const slotSide = this._size.y * ACTION_SLOT_HEIGHT_FACTOR
    this._actionSlotContent.sizeOverride = new vec2(slotSide, slotSide)
    this._actionSlotContent.leadingIconSize = this.computeActionSlotIconSize(slotSide, slotSide)
    this._actionSlotContent.leadingIcon = this.getActionSlotIcon(mode)
  }

  private getActionSlotIcon(mode: Exclude<ActionSlotMode, "none" | "voiceInput">): Texture | null {
    if (mode === "password") {
      return this.isPasswordFullyVisible ? EYE_ICON : EYE_OFF_ICON
    }
    return this.icon ?? null
  }

  private destroyActionSlot(): void {
    this.dockSlotHidden = false
    const actionSlotObject = this.actionSlotObject
    const actionSlotButton = this.actionSlotButton
    const wasVoiceInput = this.currentActionSlotMode === "voiceInput"

    this.passwordButtonAvailabilityRevision++
    this.clearPasswordTransientState(false)
    // Invalidate snapshotted callbacks before changing or destroying their source button.
    this.unsubscribePasswordButtonEvents()
    if (actionSlotButton?.isOn) {
      actionSlotButton.toggle(false)
    }
    this.hidePassword = true
    if (wasVoiceInput) {
      this.deregisterVoiceInputButton()
    }
    this.unsubscribeVoiceInputEvents()

    if (this.actionSlotButton) {
      this.removeManagedComponent(this.actionSlotButton)
    }
    if (this._actionSlotContent) {
      this.removeManagedComponent(this._actionSlotContent)
    }
    if (this.actionSlotObject) {
      this.managedSceneObjects.delete(this.actionSlotObject)
    }

    if (actionSlotObject) {
      actionSlotObject.destroy()
    }

    this.actionSlotObject = null
    this.actionSlotTransform = null
    this.actionSlotButton = null
    this._actionSlotContent = null
  }

  private createClearButton(): void {
    if (this.clearButtonObject) return

    this.clearButtonObject = global.scene.createSceneObject("ClearButton")
    this.managedSceneObjects.add(this.clearButtonObject)
    this.clearButtonTransform = this.clearButtonObject.getTransform()
    this.clearButtonObject.layer = this.sceneObject.layer
    this.clearButtonObject.setParent(this.sceneObject)

    this.clearButton = this.clearButtonObject.createComponent(Button.getTypeName())
    this.addManagedComponent(this.clearButton)
    this.clearButton.renderOrder = this._renderOrder
    this.clearButton.setTheme("System 3.0", "Secondary")
    // On the button, not its visual: updateClearButtonLayout resizes the
    // button, and size writes reset a radius written to the visual.
    this.clearButton.cornerRadius = CLEAR_BUTTON_CORNER_RADIUS

    this.clearButtonContent = this.clearButtonObject.createComponent(ElementContent.getTypeName()) as ElementContent
    this.addManagedComponent(this.clearButtonContent)
    // setLocalizedText, not an "@key" on text: the button is fixed-size
    // (autoResize off), so a missed lookup must fall back to English rather
    // than shrink the raw key into the cell sized for "Clear".
    this.clearButtonContent.setLocalizedText(CLEAR_BUTTON_LABEL_KEY, CLEAR_BUTTON_LABEL_FALLBACK)
    this.clearButtonContent.leadingIcon = null
    this.clearButtonContent.trailingIcon = null
    this.clearButtonContent.textAlignment = ContentTextAlignment.Center
    this.clearButtonContent.iconLayout = "left"
    this.clearButtonContent.spacing = 0
    this.clearButtonContent.padding = {top: 0, right: 0, bottom: 0, left: 0}
    this.clearButtonContent.autoResize = false
    // Single line always: the label is fitted to the button width (fitClearButtonLabel), and a
    // two-word translation wrapping inside a 0.73-height button would be truncated vertically.
    this.clearButtonContent.wrapText = false
    this.fitClearButtonLabel()
    // The label's Text exists only once the content builds (first time the button shows), so the
    // first real measurement, and with it the fit, lands there; the layout hook keeps it current.
    this.clearContentInitializedUnsubscribe = this.clearButtonContent.onInitialized.add(() => {
      this.subscribeClearLabelLayout()
      this.fitClearButtonLabel()
    })
    // Shares the clear button's order; the glyph draws above the opaque
    // background via child draw-order + Z, not a renderOrder split.
    this.clearButtonContent.renderOrder = this._renderOrder

    this.clearButton.onTriggerUp.add(() => this.onClearPressed())

    this.applyFieldControlOpacity("clearButton")
    this.clearButtonObject.enabled = false
    // Reconcile: the clear button is built enabled; if the field is currently released, hold it off.
    if (!this._renderingEnabled) {
      this.applyControlRendering()
    }
    if (this._initialized) {
      this.sortHierarchy()
    }
  }

  private destroyClearButton(): void {
    const clearButtonObject = this.clearButtonObject

    this.unsubscribeClearLabelFit()
    if (this.clearButton) {
      this.removeManagedComponent(this.clearButton)
    }
    if (this.clearButtonContent) {
      this.removeManagedComponent(this.clearButtonContent)
    }
    if (this.clearButtonObject) {
      this.managedSceneObjects.delete(this.clearButtonObject)
    }

    if (clearButtonObject) {
      clearButtonObject.destroy()
    }

    this.clearButtonObject = null
    this.clearButtonTransform = null
    this.clearButton = null
    this.clearButtonContent = null
  }

  private onClearPressed(): void {
    if (this.text === "") return
    this.clearPasswordCharacterReveal(false)
    this._text = ""
    this.updateText()
    this.systemKeyboardModule.updateText(this.text, 0, 0)
  }

  private applyActionSlotMode(): void {
    if (!this._initialized) return

    const mode = this.effectiveActionSlotMode
    const previousMode = this.currentActionSlotMode

    if (previousMode !== mode) {
      this.destroyActionSlot()
    }

    this.currentActionSlotMode = mode

    if (mode === "none") {
      this.markTextLayoutDirty()
      return
    }

    if (!this.actionSlotObject) {
      this.createActionSlot(mode)
    }

    this.updateActionSlotLayout()

    switch (mode) {
      case "password":
        this.updatePasswordActionSlotIcon()
        break
      case "voiceInput":
        this.updateVoiceInputButtonFormat()
        break
      case "iconChange":
        this.setActionSlotIcon(this.icon ?? null)
        break
    }

    this.applyFieldControlOpacity("actionSlot")
    // Reconcile: createActionSlot / createActionSlotContent build controls enabled, with no awareness
    // of a rendering-off state, so changing mode while released would resurrect them. Re-apply here.
    if (!this._renderingEnabled) {
      this.applyControlRendering()
    }
    this.markTextLayoutDirty()
    // A recreated slot is built enabled and must re-hide if still docked; switching away
    // from voiceInput while docked releases the contraction.
    this.updateDockContraction()
  }

  private onPasswordToggleValueChanged(sourceButton: Button, epoch: number, isOn: boolean): void {
    const ownsCurrentSource = this.isCurrentPasswordButtonSource(sourceButton)
    const ownsCurrentPresentation = this.isCurrentPasswordButtonEvent(sourceButton, epoch)

    if (!isOn) {
      // The event argument can be stale after a lifecycle rotation. Hide only when the live source
      // is actually off; a newer click pin has already put it back on and must win.
      if (!ownsCurrentSource || sourceButton.isOn) return
      this.hidePassword = true
      // Turning the eye off is an explicit hide action. Do not let an older typing peek become
      // visible when hover ends.
      this.invalidatePasswordPresentation()
      this.clearPasswordCharacterReveal(false)
      if (!isComponentBeingDestroyed(this)) {
        this.refreshPasswordPresentation()
      }
      return
    }

    if (!ownsCurrentPresentation || !this.canEnterPasswordReveal(sourceButton)) {
      // A late/programmatic toggle can arrive after its button has become unavailable. Restore a
      // newly-on hidden button when it is still safe to touch, but preserve an existing click pin.
      if (
        this.hidePassword &&
        this.actionSlotButton === sourceButton &&
        !isNull(sourceButton) &&
        !isComponentBeingDestroyed(this) &&
        !isComponentBeingDestroyed(sourceButton) &&
        sourceButton.isOn
      ) {
        sourceButton.toggle(false)
      }
      return
    }

    this.hidePassword = false
    this.refreshPasswordPresentation()
  }

  private onPasswordHoverChanged(sourceButton: Button, availabilityRevision: number, hovered: boolean): void {
    if (this.passwordButtonHovered === hovered) return

    if (!hovered) {
      // Exit is fail-closed: a snapshotted callback from the retained live button must still remove
      // visibility even if another listener rotated the epoch earlier in the same dispatch.
      if (!this.isCurrentPasswordButtonSource(sourceButton)) return
      this.passwordButtonHovered = false
      if (!isComponentBeingDestroyed(this)) {
        this.refreshPasswordPresentation()
      }
      return
    }

    if (
      availabilityRevision !== this.passwordButtonAvailabilityRevision ||
      this.currentActionSlotMode !== "password" ||
      !this.isCurrentPasswordButtonSource(sourceButton)
    ) {
      return
    }
    if (!this.canTrackPasswordButtonHover(sourceButton)) return
    // This callback is authoritative hover provenance even if an earlier listener rebound the
    // field during this dispatch. Availability revisions reject the same snapshot after lifecycle
    // disable, render release, action teardown, or source replacement.
    this.passwordButtonHovered = true
    if (this.canEnterPasswordReveal(sourceButton)) {
      this.refreshPasswordPresentation()
    }
  }

  private canEnterPasswordReveal(sourceButton: Button): boolean {
    return (
      this.inputType === "password" &&
      this.currentActionSlotMode === "password" &&
      this.isCurrentPasswordButtonSource(sourceButton) &&
      !this.inactive &&
      this.canTrackPasswordButtonHover(sourceButton)
    )
  }

  private canTrackPasswordButtonHover(sourceButton: Button): boolean {
    return this._renderingEnabled && this.isEnabledInHierarchy && sourceButton.isEnabledInHierarchy
  }

  private isCurrentPasswordButtonEvent(sourceButton: Button, epoch: number): boolean {
    return (
      epoch === this.passwordButtonEpoch &&
      this.inputType === "password" &&
      this.currentActionSlotMode === "password" &&
      this.isCurrentPasswordButtonSource(sourceButton)
    )
  }

  private isCurrentPasswordButtonSource(sourceButton: Button): boolean {
    return (
      this.actionSlotButton === sourceButton &&
      !isNull(sourceButton) &&
      !isComponentBeingDestroyed(this) &&
      !isComponentBeingDestroyed(sourceButton)
    )
  }

  private setPasswordCharacterReveal(reveal: PasswordCharacterReveal | null): void {
    this.clearPasswordCharacterReveal(false)
    this.passwordCharacterReveal = reveal
    if (!reveal) return

    const cancelToken = setTimeout(() => {
      if (this.passwordCharacterRevealCancelToken !== cancelToken || this.passwordCharacterReveal !== reveal) return
      this.passwordCharacterRevealCancelToken = null
      this.passwordCharacterReveal = null
      this.refreshPasswordPresentation()
    }, PASSWORD_CHARACTER_REVEAL_DURATION_MS)
    this.passwordCharacterRevealCancelToken = cancelToken
  }

  private clearPasswordCharacterReveal(refresh: boolean): boolean {
    const changed = this.passwordCharacterReveal !== null || this.passwordCharacterRevealCancelToken !== null
    if (this.passwordCharacterRevealCancelToken) {
      clearTimeout(this.passwordCharacterRevealCancelToken)
      this.passwordCharacterRevealCancelToken = null
    }
    this.passwordCharacterReveal = null
    if (changed && refresh) {
      this.refreshPasswordPresentation()
    }
    return changed
  }

  private clearPasswordTransientState(refresh: boolean): void {
    const hoverChanged = this.passwordButtonHovered
    this.passwordButtonHovered = false
    const characterRevealChanged = this.clearPasswordCharacterReveal(false)
    if (refresh && (hoverChanged || characterRevealChanged)) {
      this.refreshPasswordPresentation()
    }
  }

  private invalidatePasswordPresentation(rebindButtonEvents: boolean = true): void {
    // Advance even when no reveal exists yet: an onTyping listener may cross a lifecycle boundary
    // while the outer keyboard callback is still holding a not-yet-installed reveal.
    this.passwordPresentationRevision++
    this.unsubscribePasswordButtonEvents()
    if (rebindButtonEvents) {
      this.subscribePasswordButtonEvents()
    }
  }

  private refreshPasswordPresentation(): void {
    if (!this._initialized || !this.textComponent || isNull(this.textComponent)) return
    this.updatePasswordActionSlotIcon()
    this.updateVisibleText(this.isPlaceholder ? this._placeholderText : this._text)
    this.onTextUpdated(false)
  }

  private updatePasswordActionSlotIcon(): void {
    if (this.currentActionSlotMode === "password") {
      this.setActionSlotIcon(this.isPasswordFullyVisible ? EYE_ICON : EYE_OFF_ICON)
    }
  }

  private bindPasswordButtonEvents(passwordButton: Button): void {
    const epoch = this.passwordButtonEpoch
    const availabilityRevision = this.passwordButtonAvailabilityRevision
    this.passwordButtonUnsubscribes.push(
      passwordButton.onHoverEnter.add(() => this.onPasswordHoverChanged(passwordButton, availabilityRevision, true)),
      passwordButton.onHoverExit.add(() => this.onPasswordHoverChanged(passwordButton, availabilityRevision, false)),
      passwordButton.onValueChange.add((v) => this.onPasswordToggleValueChanged(passwordButton, epoch, v === 1))
    )
  }

  private rebindPasswordButtonEvents(): void {
    this.unsubscribePasswordButtonEvents()
    this.subscribePasswordButtonEvents()
  }

  private subscribePasswordButtonEvents(): void {
    const passwordButton = this.actionSlotButton
    if (
      this.currentActionSlotMode === "password" &&
      passwordButton &&
      !isNull(passwordButton) &&
      !isComponentBeingDestroyed(this) &&
      !isComponentBeingDestroyed(passwordButton) &&
      this.canTrackPasswordButtonHover(passwordButton)
    ) {
      this.bindPasswordButtonEvents(passwordButton)
    }
  }

  private unsubscribePasswordButtonEvents(): void {
    this.passwordButtonEpoch++
    for (let i = 0; i < this.passwordButtonUnsubscribes.length; i++) {
      this.passwordButtonUnsubscribes[i]()
    }
    this.passwordButtonUnsubscribes.length = 0
  }

  private setActionSlotIcon(texture: Texture | null): void {
    if (this._actionSlotContent) {
      this._actionSlotContent.leadingIcon = texture
    }
  }

  protected onVoiceStatusPlaceholderChanged(): void {
    this.updateClearButtonVisibility()
  }

  private unsubscribeVoiceInputEvents(): void {
    if (this.voiceInputUnsubscribe) {
      this.voiceInputUnsubscribe()
      this.voiceInputUnsubscribe = null
    }
    if (this.voiceStateUnsubscribe) {
      this.voiceStateUnsubscribe()
      this.voiceStateUnsubscribe = null
    }
  }

  private updateVoiceInputButtonFormat(): void {
    const voiceInputButton = this.voiceInputButton
    if (voiceInputButton) {
      voiceInputButton.format = this.voiceInputButtonFormat
    }
  }

  private get voiceInputButtonFormat(): "default" | "search" | "url" {
    switch (this.inputType) {
      case "url":
        return "url"
      default:
        return "search"
    }
  }
}

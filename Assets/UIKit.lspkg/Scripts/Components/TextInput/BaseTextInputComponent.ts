require("LensStudio:TextInputModule") // eslint-disable-line @typescript-eslint/no-require-imports

import {InteractorEvent} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import animate, {CancelSet} from "InteractionKit.lspkg/Utils/animate"
import Event, {PublicApi, unsubscribe} from "InteractionKit.lspkg/Utils/Event"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import {FocusFrameFollower} from "../../FocusFrame/FocusFrameFollower"
import {OpacityControllable} from "../../Interfaces/OpacityControllable"
import {CanvasController} from "../../Utility/CanvasController"
import {Callback, createCallbacks, reappendChild} from "../../Utility/SceneUtilities"
import {areRectsEqual, copyRect, expandRect, isEqual, localizeOr, setRect} from "../../Utility/UIKitUtilities"
import {GradientParameters, GradientStop} from "../../Visuals/RoundedRectangle/RoundedRectangle"
import {
  RoundedRectangleVisual,
  RoundedRectangleVisualParameters
} from "../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {Visual} from "../../Visuals/Visual"
import {VoiceInputButton} from "../Button/VoiceInputButton"
import {StateName} from "../Element"
import {Frame} from "../Frame/Frame"
import {VisualElement} from "../VisualElement"
import type {
  SystemKeyboardDelegate,
  SystemKeyboardEditContext,
  SystemKeyboardEditDisposition
} from "./SystemKeyboardModule"
import {SystemKeyboardModule} from "./SystemKeyboardModule"
import {TextInputComponentManager} from "./TextInputComponentManager"
import {
  CORNER_RADIUS,
  createTextInputStateMap,
  DEBUG_RENDER,
  DEFAULT_BEHAVIOR,
  DEFAULT_TEXT_COLOR,
  HOVER_SCALE_FACTOR,
  INSET_FACTOR_SINGLE_LINE,
  KEYBOARD_DELAY_DESELECT,
  MASK_Z_OFFSET,
  PLACEHOLDER_TEXT_COLOR,
  STATE_ANIMATION_DURATION,
  TEXT_INPUT_VISUAL_STYLE,
  TextAlignment,
  TextInputStateType
} from "./TextInputConsts"
import {TextGeometryRefreshReasons, TextManipulationModule} from "./TextManipulation/TextManipulationModule"
import {HANDLE_HEIGHT_RATIO, HANDLE_WIDTH_RATIO} from "./TextManipulation/Visuals/GrabHandle"

const log = new NativeLogger("BaseTextInputComponent")

// GrabHandle owns its visual ratios; text input owns how much mask overflow to reveal.
// The handle width ratio behaves as a half-width around its anchor edge, and
// the handle extends half of its extra height past each vertical edge.
const MASK_VERTICAL_GRAB_HANDLE_EDGE_PADDING_RATIO = 0.02
const MASK_HORIZONTAL_GRAB_HANDLE_OVERFLOW_RATIO = HANDLE_WIDTH_RATIO * 2
const MASK_VERTICAL_GRAB_HANDLE_OVERFLOW_RATIO =
  (HANDLE_HEIGHT_RATIO - 1) * 0.5 + MASK_VERTICAL_GRAB_HANDLE_EDGE_PADDING_RATIO

// Anchors the text input LocalizationsAsset into the package build. Calls to
// localizationSystem.localize() do not create an asset reference by
// themselves, so the static requireAsset() is required for key resolution.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const TEXT_INPUT_LOCALIZATIONS_ASSET = requireAsset(
  "../../../Localization/TextInputField/strings"
) as LocalizationsAsset

// Voice status placeholders. Resolved each time one is shown rather than at module load, so
// a table that is not wired up yet in the editor is never cached as a permanent miss.
const LISTENING_TEXT_KEY = "@uikit:text-input-field:voice-listening"
const LISTENING_TEXT_FALLBACK = "Listening"
const ERROR_TEXT_KEY = "@uikit:text-input-field:voice-error"
const ERROR_TEXT_FALLBACK = "Error"

// "loop": colors cycle along a fixed gradient axis.
// "hold": ramp to a static gradient and hold it.
// "radial": a Radial gradient whose center orbits the field over time (the glow
//           moves), using colors[0] at the center and colors[last] at the edge.
export type AsrVisualSweepMode = "loop" | "hold" | "radial"

// loop reads 3 colors; hold reads 4; radial reads center=colors[0], edge=colors[last].
// Require at least 3 (the loop minimum).
export type AsrVisualSweepColors = readonly [vec4, vec4, vec4, ...vec4[]]

export type AsrVisualSweepPalette = {
  start: vec2
  end: vec2
  stopPercents?: readonly number[]
  background: AsrVisualSweepColors
  border: AsrVisualSweepColors
}

type AsrVisualSweepGradients = {
  background: GradientParameters
  border: GradientParameters
}

const ASR_SWEEP_DURATION_SECONDS = 1.8
const ASR_LOOP_STOP_PERCENTS = [0, 0.25, 0.5, 0.75, 1] as const
const ASR_HOLD_STOP_PERCENTS = [0, 0.43, 0.66, 1] as const
// "radial" mode tuning: seconds per orbit, how far the glow center orbits the
// field center, and the radial falloff span (larger = larger, softer glow).
const ASR_RADIAL_ORBIT_PERIOD_SECONDS = 16
const ASR_RADIAL_ORBIT_RADIUS = 0.5
const ASR_RADIAL_SPAN = 8

// "hold" finish (matching TextInput_bg 5 / TextInputBehavior.ts): on final, the
// color bounces full -> gray -> full (revealing the message at the gray midpoint),
// then dims full -> gray. Both legs are 0.3s, ease-out-cubic.
const ASR_FINISH_BOUNCE_DURATION = 1.3
const ASR_FINISH_DIM_DURATION = 0.5

// Bottom-edge ("Bottom Line") scan: a dedicated thin child visual pinned to the
// field's bottom, with a light-blue highlight that scans horizontally
// (xCenter = -sin(t * speed); ping-pong, period 2*PI/speed ≈ PI at speed 2). All tunable.
const ASR_BOTTOM_EDGE_SPEED = 2
const ASR_BOTTOM_EDGE_HEIGHT_FACTOR = 0.07 // band height as a fraction of field height
const ASR_BOTTOM_EDGE_Z = 0.2 // forward offset so it sits in front of the fill
// Keep TRAVEL + RADIUS <= 1 so the lobe never reaches the strip's left/right ends.
const ASR_BOTTOM_EDGE_RADIUS = 0.5 // horizontal lobe half-width (peak -> transparent)
const ASR_BOTTOM_EDGE_TRAVEL = 0.4 // scan amplitude (peak x in [-0.4, 0.4])
const ASR_BOTTOM_EDGE_CORNER_RADIUS = 0.05

export const DEFAULT_ASR_VISUAL_SWEEP_PALETTE: AsrVisualSweepPalette = {
  start: new vec2(-1, 0.2),
  end: new vec2(1, -0.2),
  background: [new vec4(0.28, 0.25, 0.52, 1), new vec4(0.25, 0.42, 0.62, 1), new vec4(0.25, 0.6, 0.52, 1)],
  border: [new vec4(0.58, 0.5, 0.96, 1), new vec4(0.36, 0.62, 0.92, 1), new vec4(0.18, 0.82, 0.68, 1)]
}

function createAsrSweepGradientTemplate(): GradientParameters {
  return {
    enabled: true,
    type: "Linear",
    start: DEFAULT_ASR_VISUAL_SWEEP_PALETTE.start,
    end: DEFAULT_ASR_VISUAL_SWEEP_PALETTE.end,
    stop0: {enabled: true, percent: ASR_LOOP_STOP_PERCENTS[0], color: new vec4(0, 0, 0, 0)},
    stop1: {enabled: true, percent: ASR_LOOP_STOP_PERCENTS[1], color: new vec4(0, 0, 0, 0)},
    stop2: {enabled: true, percent: ASR_LOOP_STOP_PERCENTS[2], color: new vec4(0, 0, 0, 0)},
    stop3: {enabled: true, percent: ASR_LOOP_STOP_PERCENTS[3], color: new vec4(0, 0, 0, 0)},
    stop4: {enabled: true, percent: ASR_LOOP_STOP_PERCENTS[4], color: new vec4(0, 0, 0, 0)}
  }
}

/**
 * Abstract base class for text input components that provides shared state management,
 * keyboard integration, visual styling, and lifecycle hooks.
 *
 * BaseTextInputComponent handles the common behavior for all text input variants:
 * - **Keyboard management**: Opens/dismisses the system keyboard and routes text changes
 * - **State animation**: Animates size transitions on hover, trigger, and toggle states
 * - **Batched updates**: Coalesces text and size changes into a single end-of-frame flush
 * - **Placeholder text**: Displays configurable placeholder text when the input is empty
 * - **Visual styling**: Creates a default {@link RoundedRectangleVisual} with gradient borders
 *
 * Subclasses must implement the following hooks:
 * - {@link initializeTextComponent} — configure text alignment and overflow modes
 * - {@link updateVisibleText} — render the current text string to the text component
 * - {@link computeFontSize} — compute the font size based on the component height
 *
 * @remarks
 * - This class is abstract and should not be instantiated directly
 * - Use {@link TextInputField} for single-line input or {@link TextInputArea} for multiline input
 *
 * @see {@link TextInputField} - Single-line text input implementation
 * @see {@link TextInputArea} - Multiline text input implementation
 * @see {@link TextInputComponentManager} - Manages focus across all text input instances
 * @see {@link TextInputConsts} - Shared constants and types for text input styling and behavior
 */
export abstract class BaseTextInputComponent
  extends VisualElement
  implements SystemKeyboardDelegate, OpacityControllable
{
  /**
   *  add per-theme styles, add @input fields like:
   *
   * @input
   * @showIf("_themeOverride", "System3")
   * @label("Style")
   * @widget(new ComboBoxWidget([
   *   new ComboBoxItem("StyleName", "StyleName"),
   * ]))
   * protected _styleSystem3: string = "StyleName"
   */

  // ─── Text Properties ──────────────────────────────────────────────────

  @input("float", "1")
  @widget(new SliderWidget(0, 1))
  @hint("Opacity multiplier applied to the background, text, and manipulation visuals.")
  protected _opacity: number = 1.0

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Text Properties</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Font and placeholder configuration</span>')
  @input("int")
  @hint("Custom font size. If not set, it will automatically scale from size.y")
  protected _fontSize: number = 0

  @input
  @hint("Font Family")
  @allowUndefined
  protected _fontFamily: Font

  @input
  @hint("Text that is displayed before any text is entered")
  protected _placeholderText: string = ""

  @input("string", "left")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Left", "left"),
      new ComboBoxItem("Center", "center"),
      new ComboBoxItem("Right", "right")
    ])
  )
  @hint("Horizontal text alignment")
  protected _horizontalTextAlignment: TextAlignment = TextAlignment.Left

  // ─── Event Callbacks ──────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Event Callbacks</span>')
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Optional script functions to trigger on component events</span>'
  )
  @input
  @hint("Enable this to add functions from another script to this component's callbacks")
  protected addCallbacks: boolean = false

  @input
  @showIf("addCallbacks")
  @label("On Text Changed Callbacks")
  protected onTextChangedCallbacks: Callback[] = []

  @input
  @showIf("addCallbacks")
  @label("On Keyboard State Changed Callbacks")
  protected onKeyboardStateChangedCallbacks: Callback[] = []

  // ─── Focus Frame ──────────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Focus Frame</span>')
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Move this field (or its panel) next to the keyboard while editing</span>'
  )
  @input
  @hint(
    "When enabled, this field docks to the system keyboard's focus-frame anchor while it is \
being edited, then returns to rest when editing ends. Requires the platform focus-frame \
source to be active; inert otherwise."
  )
  protected enableFocusFrame: boolean = true

  @input
  @showIf("enableFocusFrame")
  @allowUndefined
  @label("Focus Frame Target")
  @hint(
    "Object that moves toward the keyboard. Leave empty to move the nearest ancestor Frame \
(the whole panel), or this field itself if it has no Frame ancestor."
  )
  protected focusFrameTarget: SceneObject | undefined = undefined

  /**
   * Whether hover state should animate the component size using the configured hover scale.
   */
  public scaleOnHover: boolean = false
  /**
   * Text component used to display placeholder, visible text, and keyboard edits.
   */
  public textComponent: Text

  protected mask: SceneObject
  protected maskScreenTransform: ScreenTransform
  protected textObject: SceneObject
  protected textObjectScreenTransform: ScreenTransform

  protected _visual: RoundedRectangleVisual
  protected _originalSize: vec3 = this._size
  protected _text: string = ""
  private readonly _textFillBaseColor: vec4 = new vec4(
    DEFAULT_TEXT_COLOR.r,
    DEFAULT_TEXT_COLOR.g,
    DEFAULT_TEXT_COLOR.b,
    DEFAULT_TEXT_COLOR.a
  )
  private readonly _textFillDisplayColor: vec4 = new vec4(
    DEFAULT_TEXT_COLOR.r,
    DEFAULT_TEXT_COLOR.g,
    DEFAULT_TEXT_COLOR.b,
    DEFAULT_TEXT_COLOR.a
  )
  private _opacityVisualBaseTransparencyEnabled: boolean = false
  private _opacityVisualBaseTransparencySource: RoundedRectangleVisual | null = null
  protected isPlaceholder: boolean = true
  protected isEditing: boolean = false
  // Persistent rendering-off state, independent of opacity. When false, the component's renderables
  // are released and held released across the lifecycle: the enableVisuals / enableManagedComponents
  // gates re-apply it instead of letting the engine's re-enable cascade resurrect renderables.
  // See setRenderingEnabled / applyRenderingEnabled.
  protected _renderingEnabled: boolean = true
  protected voiceStatusPlaceholderActive: boolean = false
  protected stateCancelSet = new CancelSet()

  // Focus frame: follows the keyboard anchor while this field is being edited.
  private focusFrameFollower: FocusFrameFollower | null = null
  private focusFrameUnsubscribe: unsubscribe | null = null
  private focusFrameDockUnsubscribe: unsubscribe | null = null
  // True while the follower is docked/docking at the keyboard (per-panel for shared
  // followers — combine with isEditing for a per-field signal).
  protected focusFrameDocked: boolean = false
  private textBoundingBoxUnsubscribe: unsubscribe | null = null

  private _textDirty: boolean = false
  private _textPresentationDirty: boolean = false
  protected _sizeDirty: boolean = false
  protected _fontDirty: boolean = false
  protected _fontSizeDirty: boolean = false
  private _selectionDirty: boolean = false
  protected _textLayoutDirty: boolean = false
  protected _alignmentDirty: boolean = false
  private readonly canvasSize: vec2 = vec2.zero()
  private canvasController: CanvasController | null = null
  private canvasBindingDirty: boolean = false
  private _batchUpdateEvent: SceneEvent
  private asrVisualSweepEvent: SceneEvent | null = null
  private readonly asrVisualSweepRampCancelSet = new CancelSet()
  private asrVisualSweepActive: boolean = false
  private asrVisualSweepTimeSeconds: number = 0
  private readonly asrBackgroundGradient: GradientParameters = createAsrSweepGradientTemplate()
  private readonly asrBorderGradient: GradientParameters = createAsrSweepGradientTemplate()
  private asrCurrentBackgroundGradient: GradientParameters | null = null
  private asrCurrentBorderGradient: GradientParameters | null = null
  private asrVisualSweepRampOutActive: boolean = false
  // Dedicated bottom-edge glow element (separate child visual, isolated from the
  // field fill). Lazily created on first voice start.
  private asrBottomEdgeObject: SceneObject | null = null
  private asrBottomEdgeTransform: Transform | null = null
  private asrBottomEdgeVisual: RoundedRectangleVisual | null = null
  private asrBottomEdgeEvent: SceneEvent | null = null
  private asrBottomEdgeActive: boolean = false
  private asrBottomEdgeTimeSeconds: number = 0
  private asrBottomEdgeColor: vec4 | null = null
  private asrBottomEdgeColorTransparent: vec4 | null = null
  private readonly asrBottomEdgeGradient: GradientParameters = createAsrSweepGradientTemplate()
  // True while the multi-phase finish (bounce + dim) is playing, so a duplicate
  // stop / listening teardown doesn't restore the message text early.
  private asrFinishInProgress: boolean = false
  // Pending finish-sequence reveal (commits the final transcript to the text
  // model + restores the placeholder). Stored so cancel paths FLUSH it
  // instead of dropping it: the reveal only fires at the bounce midpoint,
  // and cancelling before that (new dictation session, release) would
  // otherwise lose the recognized text from the field.
  private asrPendingReveal: (() => void) | null = null
  // Resolved once at voice start so start/stop agree even if the global theme
  // changes mid-session (existing visuals are not dynamically rethemed).
  private asrActiveSweepMode: AsrVisualSweepMode = "loop"
  private asrActiveSweepPalette: AsrVisualSweepPalette = DEFAULT_ASR_VISUAL_SWEEP_PALETTE
  private voiceInputActive: boolean = true
  // True from a voice session's start until its final transcript, error, or stop. Independent of
  // the sweep visuals so it also holds for fields without a RoundedRectangleVisual.
  private voiceSessionActive: boolean = false

  protected textManipulationModule: TextManipulationModule
  private textManipulationObject: SceneObject | null = null
  protected systemKeyboardModule: SystemKeyboardModule
  protected maskingComponent: Component | null = null
  private _textOverflowRequiresMask: boolean = false
  protected scrollCooldownSec: number = 0.15

  private lastScrollTime: number = 0
  private readonly _maskOverflowPadding: vec2 = vec2.zero()
  private readonly _maskBounds: Rect = Rect.create(0, 0, 0, 0)
  private readonly _previousMaskAnchors: Rect = Rect.create(0, 0, 0, 0)
  private readonly _previousMaskOffsets: Rect = Rect.create(0, 0, 0, 0)
  private readonly _previousTextObjectAnchors: Rect = Rect.create(0, 0, 0, 0)
  private readonly _previousTextObjectOffsets: Rect = Rect.create(0, 0, 0, 0)
  protected readonly textViewportBounds: Rect = Rect.create(0, 0, 0, 0)

  private registeredVoiceInputButton: VoiceInputButton | null = null
  private registeredVoiceInputButtonPreviousInactive: boolean = false
  private registeredVoiceInputUnsubscribes: unsubscribe[] = []

  protected readonly _states: Map<StateName, TextInputStateType> = createTextInputStateMap(
    () => this._originalSize,
    () => this.calculateHoverScale()
  )

  protected typingEvent = new Event()
  /**
   * Event fired on each keystroke while the user is typing.
   */
  private _onTyping?: PublicApi<void>
  public get onTyping(): PublicApi<void> {
    return (this._onTyping ??= this.typingEvent.publicApi())
  }

  protected onTextChangedEvent = new Event<string>()
  /**
   * Event fired when the text content changes.
   * The event payload is the new text string.
   */
  private _onTextChanged?: PublicApi<string>
  public get onTextChanged(): PublicApi<string> {
    return (this._onTextChanged ??= this.onTextChangedEvent.publicApi())
  }

  protected returnKeyPressed = new Event<string>()
  /**
   * Event fired when the return/done key is pressed on the keyboard.
   * The event payload is the current text string.
   */
  private _onReturnKeyPressed?: PublicApi<string>
  public get onReturnKeyPressed(): PublicApi<string> {
    return (this._onReturnKeyPressed ??= this.returnKeyPressed.publicApi())
  }

  protected onVoiceFinalizeEvent = new Event<string>()
  /**
   * Event fired when a registered voice input button returns final speech-to-text content.
   * The event payload is the final transcript string.
   */
  private _onVoiceFinalize?: PublicApi<string>
  public get onVoiceFinalize(): PublicApi<string> {
    return (this._onVoiceFinalize ??= this.onVoiceFinalizeEvent.publicApi())
  }

  protected onVoiceErrorEvent = new Event<AsrModule.AsrStatusCode>()
  /**
   * Event fired when a registered voice input button reports an error status code.
   */
  private _onVoiceError?: PublicApi<AsrModule.AsrStatusCode>
  public get onVoiceError(): PublicApi<AsrModule.AsrStatusCode> {
    return (this._onVoiceError ??= this.onVoiceErrorEvent.publicApi())
  }

  protected keyboardStateChanged = new Event<boolean>()
  /**
   * Event fired when the system keyboard opens or closes.
   * The event payload is `true` when the keyboard is open, `false` when closed.
   */
  private _onKeyboardStateChanged?: PublicApi<boolean>
  public get onKeyboardStateChanged(): PublicApi<boolean> {
    return (this._onKeyboardStateChanged ??= this.keyboardStateChanged.publicApi())
  }

  protected editModeEvent = new Event<boolean>()
  /**
   * Event fired when the component enters or exits edit mode.
   * The event payload is `true` when entering edit mode, `false` when exiting.
   */
  private _onEditMode?: PublicApi<boolean>
  public get onEditMode(): PublicApi<boolean> {
    return (this._onEditMode ??= this.editModeEvent.publicApi())
  }

  private _textInputComponentManager = TextInputComponentManager.getInstance()

  private onCaretIndexChangedEvent: Event<number> = new Event<number>()
  private _onCaretIndexChanged?: PublicApi<number>
  private lastPublishedCaretCharIndex: number | null = null
  /**
   * Event fired when the caret index changes.
   * The payload is the caret position in UTF-16 character units.
   */
  public get onCaretIndexChanged(): PublicApi<number> {
    return (this._onCaretIndexChanged ??= this.onCaretIndexChangedEvent.publicApi())
  }
  private onHighlightUpdatedEvent: Event<string> = new Event<string>()
  private _onHighlightUpdated?: PublicApi<string>
  /**
   * Event fired when highlighted text changes.
   * The payload is the currently highlighted substring, or an empty string when selection clears.
   */
  public get onHighlightUpdated(): PublicApi<string> {
    return (this._onHighlightUpdated ??= this.onHighlightUpdatedEvent.publicApi())
  }

  /**
   * Gets the current size of the text input component.
   * @returns The size as a vec3 (width, height, depth).
   */
  public get size(): vec3 {
    return this._size
  }

  /**
   * Sets the size of the text input component.
   * Triggers a batched size update that recalculates the visual, font size, and text content anchors.
   * @param size - The new size as a vec3 (width, height, depth).
   */
  public set size(size: vec3) {
    if (size === undefined || isEqual(size, this._size)) return
    super.size = size
    this.markSizeDirty()
    this.markTextLayoutDirty()
  }

  /**
   * Schedules the inherited Canvas binding to be re-evaluated before rendering.
   * Call this after reparenting the text input or changing ancestor Canvas topology
   * or configuration through raw Lens APIs. A live locally managed Canvas remains
   * authoritative and is not replaced by an ancestor Canvas.
   */
  public invalidateCanvasBinding(): void {
    if (!this.canvasController) {
      return
    }

    this.canvasController.invalidate()
    if (!this._initialized) {
      return
    }

    this.canvasBindingDirty = true
    this.batchUpdate()
  }

  protected applySizeImmediately(size: vec3): void {
    if (size === undefined || isEqual(size, this._size)) return
    super.size = size
    this.updateSize()
  }

  /**
   * Gets the original (baseline) size of the text input component.
   * Used as the reference size for hover scale calculations and font size scaling.
   * @returns The original size as a vec3.
   */
  public get originalSize(): vec3 {
    return this._originalSize
  }

  /**
   * Sets the original (baseline) size of the text input component.
   * Also updates the current size to match.
   * @param originalSize - The new original size as a vec3.
   */
  public set originalSize(originalSize: vec3) {
    if (originalSize === undefined || isEqual(originalSize, this._originalSize)) return
    this._originalSize = originalSize
    this.size = originalSize
  }

  /**
   * Gets the current text content of the input.
   * @returns The current text string, or an empty string if only placeholder text is shown.
   */
  public get text() {
    return this._text
  }

  /**
   * Sets the text content of the input.
   * Triggers a batched text update and fires the {@link onTextChanged} event when initialized.
   * @param text - The new text string.
   */
  public set text(text: string) {
    if (text === undefined || isEqual(text, this._text)) return
    this._text = text
    if (this._initialized) {
      this.markTextDirty()
    }
  }

  /**
   * Gets the placeholder text displayed when the input is empty and not in edit mode.
   * @returns The placeholder text string.
   */
  public get placeholderText(): string {
    return this._placeholderText
  }

  /**
   * Sets the placeholder text displayed when the input is empty and not in edit mode.
   * @param value - The new placeholder text string.
   */
  public set placeholderText(value: string) {
    if (value === undefined || isEqual(value, this._placeholderText)) return
    this._placeholderText = value
    this.markTextDirty()
  }

  /**
   * Gets the horizontal text alignment within the input.
   * @returns The current horizontal text alignment.
   */
  public get horizontalTextAlignment(): TextAlignment {
    return this._horizontalTextAlignment
  }

  /**
   * Sets the horizontal text alignment within the input.
   * Triggers a batched alignment update at the end of the frame.
   * @param value - The desired horizontal text alignment.
   */
  public set horizontalTextAlignment(value: TextAlignment) {
    if (value === undefined || isEqual(value, this._horizontalTextAlignment)) return
    this._horizontalTextAlignment = value
    this.markAlignmentDirty()
  }

  /**
   * Gets the custom font size.
   * A value of 0 means the font size is automatically derived from the component height.
   * @returns The font size, or 0 for automatic sizing.
   */
  public get fontSize(): number {
    return this._fontSize
  }

  /**
   * Sets the custom font size.
   * Set to 0 to use automatic font sizing based on the component height.
   * @param value - The new font size, or 0 for automatic sizing.
   */
  public set fontSize(value: number) {
    if (value === undefined || isEqual(value, this._fontSize)) return
    this._fontSize = value
    this.markSizeDirty()
    this.markTextLayoutDirty()
    this.markFontSizeDirty()
  }

  /**
   * Gets the font family used for text rendering.
   * @returns The current Font asset, or undefined if using the default font.
   */
  public get fontFamily(): Font {
    return this._fontFamily
  }

  /**
   * Sets the font family used for text rendering.
   * Triggers a size recalculation since different fonts may have different metrics.
   * @param value - The Font asset to use.
   */
  public set fontFamily(value: Font) {
    if (value === undefined || isEqual(value, this._fontFamily)) return
    this._fontFamily = value
    if (this._initialized) {
      this.textComponent.font = this._fontFamily
      this.markSizeDirty()
      this.markTextLayoutDirty()
      this.markFontDirty()
    }
  }

  /**
   * Sets the shared render order for text-input visuals.
   * Relative stacking within the component is determined by Canvas hierarchy order.
   * @param value - The base render order value.
   */
  public set renderOrder(value: number) {
    if (value === undefined || isEqual(value, this._renderOrder)) return
    this._renderOrder = value
    if (this._initialized) {
      this.updateRenderOrder(value)
    }
  }

  /**
   * The base render order. Declared alongside the setter because a subclass
   * accessor with only a setter shadows the inherited get/set pair, which left
   * this read as `undefined` on every text input.
   */
  public get renderOrder(): number {
    return this._renderOrder
  }

  /**
   * Opacity multiplier applied to the text input visual, text, and text manipulation affordances.
   */
  public get opacity(): number {
    return this._opacity
  }

  /**
   * @param opacity - Opacity multiplier. Values are intentionally not clamped.
   * @see opacity
   */
  public set opacity(opacity: number) {
    if (opacity === undefined) return
    if (opacity === this._opacity) return

    this._opacity = opacity
    this.applyOpacity()
  }

  /**
   * Gets whether the text input can be dragged by the interaction system.
   * @returns Always `true` for text input components.
   */
  public get isDraggable() {
    return true
  }

  /**
   * Gets the caret position in UTF-16 character units.
   * @returns The caret character index, or 0 before text manipulation is initialized.
   */
  public get caretCharIndex(): number {
    if (!this._initialized || !this.textManipulationModule) return 0
    return this.textManipulationModule.caretCharIndex
  }

  /**
   * Gets the currently highlighted text.
   * @returns The highlighted substring, or an empty string when no text is highlighted.
   */
  public get highlightedText(): string {
    if (!this._initialized || !this.textManipulationModule) return ""
    return this.textManipulationModule.getHighlightedText()
  }

  /**
   * Selects all text while the component is editing.
   * @returns `true` if all text was highlighted.
   */
  public selectAll(): boolean {
    if (!this._initialized || !this.isEditing || !this.textManipulationModule) return false
    return this.textManipulationModule.setHighlightAll()
  }

  /**
   * Removes the currently highlighted text while the component is editing.
   * @returns `true` if highlighted text was removed.
   */
  public cut(): boolean {
    if (!this._initialized || !this.isEditing || !this.textManipulationModule) return false
    return this.textManipulationModule.removeHighlightedText()
  }

  /**
   * Inserts text at the caret or replaces the current highlight while editing.
   * @param text - The text to paste.
   * @returns `true` if the paste operation was staged.
   */
  public paste(text: string): boolean {
    if (!this._initialized || !this.isEditing || !this.textManipulationModule) return false
    return this.textManipulationModule.replaceHighlightedText(text)
  }

  /**
   * Registers a voice input button to drive listening visuals and speech-to-text updates.
   * A text input can only observe one voice input button at a time; registering a new one
   * first deregisters the current button without changing that button's own lifecycle state.
   */
  public registerVoiceInputButton(voiceInputButton: VoiceInputButton): void {
    if (!voiceInputButton || this.registeredVoiceInputButton === voiceInputButton) return

    this.deregisterVoiceInputButton()
    this.registeredVoiceInputButton = voiceInputButton
    this.registeredVoiceInputButtonPreviousInactive = voiceInputButton.inactive
    this.registeredVoiceInputUnsubscribes = [
      voiceInputButton.onValueChange.add((value) => this.onVoiceInputToggleValueChanged(value === 1)),
      voiceInputButton.onListeningUpdate.add(([text, isFinal]) => this.onVoiceListeningUpdate(text, isFinal)),
      voiceInputButton.onListeningError.add((statusCode) => this.onVoiceListeningError(statusCode)),
      voiceInputButton.onListeningErrorAutoReset.add(() => this.onVoiceListeningErrorAutoReset())
    ]
    this.applyRegisteredVoiceInputButtonInactive()

    if (this._initialized && this.voiceInputActive && voiceInputButton.isOn) {
      this.onVoiceInputToggleValueChanged(true)
    }
  }

  /**
   * Deregisters the currently observed voice input button.
   * This removes text-input-owned subscriptions and visual state only; it does not toggle,
   * destroy the button, or leave behind an inactive override from this text input.
   */
  public deregisterVoiceInputButton(): void {
    const voiceInputButton = this.registeredVoiceInputButton
    this.unsubscribeRegisteredVoiceInputEvents()
    this.stopVoiceInputListeningState()
    if (voiceInputButton) {
      voiceInputButton.inactive = this.registeredVoiceInputButtonPreviousInactive
    }
    this.registeredVoiceInputButton = null
    this.registeredVoiceInputButtonPreviousInactive = false
  }

  /**
   * Programmatically starts or stops the voice-input listening visual — the same
   * path the voice button drives (placeholder text + ASR background sweep), so it
   * works without a microphone. Useful for app-driven voice entry and for tests
   * that need to preview the voice-mode background. If a voice button is
   * registered, its toggle is kept in sync; otherwise the visual is driven directly.
   */
  public setVoiceListening(active: boolean): void {
    const voiceInputButton = this.registeredVoiceInputButton
    if (voiceInputButton && voiceInputButton.isOn !== active) {
      voiceInputButton.toggle(active)
      return
    }
    this.onVoiceInputToggleValueChanged(active)
  }

  /**
   * Simulates an ASR transcript result without a microphone — the same path the
   * real speech engine drives. Pass `isFinal: true` to trigger the finish
   * sequence (the color bounce + message reveal). Requires listening to be
   * active first (see {@link setVoiceListening}). Intended for app/test use.
   */
  public simulateVoiceResult(text: string, isFinal: boolean): void {
    this.onVoiceListeningUpdate(text, isFinal)
  }

  /**
   * Enters or exits edit mode, managing keyboard visibility and input state.
   *
   * When entering edit mode: toggles the interactable state, clears placeholder text if present,
   * sets the initial keyboard text, requests the system keyboard, and registers this field as active.
   *
   * When exiting edit mode: untoggles the interactable state, dismisses the keyboard,
   * deregisters this field, updates the displayed text, and cancels any pending keyboard requests.
   *
   * @param editing - `true` to enter edit mode, `false` to exit.
   */
  public editMode(editing: boolean) {
    // A released component cannot enter edit mode; the early return is before any event fires.
    if (editing && !this._renderingEnabled) {
      log.d(`editMode(true) ignored while rendering is released: ${this.sceneObject.name}`)
      return
    }
    if (editing === this.isEditing) return
    if (editing) {
      // A new edit session owns a fresh scroll epoch. Its end-caret projection may arrive after
      // native truncation is replaced, and must not inherit startup or prior-session throttling.
      this.lastScrollTime = Number.NEGATIVE_INFINITY
    } else {
      this._selectionDirty = false
    }
    this.updateTextManipulationEditMode(editing)
    // Caret drags follow the hand from the press's second frame while editing, instead of waiting for
    // IK's drag threshold; most intended caret moves are shorter than it. TextManipulationModule is
    // built for this: it cancels hold-to-select on caret movement, not on drag start. Off again on blur,
    // see the note in initialize().
    const interactable = this.interactable
    if (interactable) {
      interactable.enableInstantDrag = editing
    }
    this.editModeEvent.invoke(editing)
    if (DEFAULT_BEHAVIOR) {
      if (editing) {
        this._interactableStateMachine.toggle = true
        this.isEditing = true
        this.applyTextFillColor(DEFAULT_TEXT_COLOR)
        if (this.isPlaceholder) {
          this._text = ""
          this.updateText(false)
          this.systemKeyboardModule.requestKeyboard("", 0, 0)
        } else {
          this.systemKeyboardModule.requestKeyboard(this.text, this.text.length, this.text.length)
        }
        this.textInputComponentManager.registerActive(this)
      } else {
        this._interactableStateMachine.toggle = false
        this.isEditing = false
        this.updateText(false)
        this.textInputComponentManager.deregisterActive(this)
        this.systemKeyboardModule.dismissKeyboard()
        this.cancelRequestKeyboard()
      }
    }
    this.onEditModeChanged(editing)
  }

  protected onEditModeChanged(_editing: boolean): void {}

  /**
   * Called when the focus frame follower docks at / undocks from the keyboard. Fires at
   * dock start and undock start (not motion completion). May fire before initialize() and,
   * for a shared follower, once per PANEL dock rather than per field — implementations
   * must recompute from their own state (e.g. isEditing) rather than trust the argument
   * alone.
   */
  protected onFocusFrameDockChanged(_docked: boolean): void {}

  /**
   * Lets subclasses prepare native text overflow/layout for a manipulation transition while Base
   * preserves the required mask ordering. Entry preparation runs before the mask and manipulation
   * are enabled; exit preparation runs after manipulation descendants are synchronously hidden and
   * before the final mask state is applied.
   */
  protected prepareTextManipulationEditMode(_editing: boolean): void {}

  /**
   * Clears a pending visual focus toggle when the component is not actively editing.
   * This is intended for {@link TextInputComponentManager}; application code should use
   * focus-related APIs rather than calling this directly.
   */
  public resetPendingFocusState(): void {
    if (this.isEditing || !this._interactableStateMachine.toggle) return

    this._interactableStateMachine.toggle = false
  }

  private updateTextManipulationEditMode(editing: boolean): void {
    if (!this.textManipulationModule) return

    // Render-gated: a released component never shows the caret/highlight.
    const manipulationActive = editing && this._renderingEnabled
    if (manipulationActive) {
      this.prepareTextManipulationEditMode(true)
      // Manipulation renderers and grab-handle interactions are descendants of textObject rather
      // than part of the native Text component. Enable their ancestor mask before activating them.
      this.applyMaskingComponentState(true)
      this.textManipulationModule.active = true
      // Native truncation can leave cursorPositions describing only the inactive visible text.
      // Target the logical UTF-16 end instead; TextManipulationModule retains that target until
      // the overflow-mode refresh publishes the full cursor geometry.
      this.textManipulationModule.setHighlightByCharIndex(this._text.length, this._text.length)
    } else {
      // TextManipulationModule synchronously hides its descendants when deactivated, so it is now
      // safe for the subclass to restore inactive overflow behavior before applying mask demand.
      const wasManipulationActive = this.textManipulationModule.active
      this.textManipulationModule.active = false
      if (wasManipulationActive) {
        this.prepareTextManipulationEditMode(false)
      }
      this.applyMaskingComponentState()
    }
  }

  /**
   * Releases (or restores) the component's render cost independent of opacity, so a component faded
   * to alpha 0 stops holding the viewport. Disabling releases the renderables owned at this level
   * (background + shadow, text) and makes the component fully inert: its interaction components are
   * held disabled alongside, so an invisible component cannot intercept taps or steal focus. The
   * state is held across the lifecycle (see {@link applyRenderingEnabled} and the enableVisuals /
   * enableManagedComponents gates), so the engine's re-enable cascade cannot resurrect anything;
   * restore re-applies the normal inactive semantics. Subclasses extend coverage by overriding
   * {@link applyRenderingEnabled} and {@link isRenderGatedManagedComponent}. Safe to call before
   * initialization: the flag is held and applied by the end-of-initialize tail.
   * @param enabled - Whether the component's renderables and interaction should be active.
   */
  public setRenderingEnabled(enabled: boolean): void {
    if (enabled === this._renderingEnabled) {
      return
    }
    this._renderingEnabled = enabled
    if (!enabled) {
      // A released component cannot be edited: exit edit mode (dismisses the keyboard, deregisters,
      // drops the caret/highlight) or, if not editing, kill any pending deferred focus request and
      // clear a click-set focus toggle, so a queued editMode(true) cannot land after the release
      // and a restore does not resurface a stale focus highlight. Neither exists pre-init.
      if (this.isEditing) {
        this.editMode(false)
      } else if (this._initialized) {
        this.cancelRequestKeyboard()
        this.resetPendingFocusState()
      }
      // End any in-progress voice session so a release mid-listen does not leave the button armed;
      // onEnabled / keyboard-close reactivation is gated on the flag so it cannot re-arm while held.
      this.setVoiceInputActive(false)
      this.stopVoiceInputListeningState()
    } else {
      // Restore voice input, symmetric to the release above. A render-only
      // toggle (setRenderingEnabled(false) then true) with no SceneObject
      // enable cycle and no keyboard close otherwise leaves voiceInputActive
      // false, so the voice button stays inactive (dimmed + interactable/
      // collider held disabled) after the component is shown again. Runs
      // before applyRenderingEnabled so the button is active when its
      // interaction components re-enable.
      this.setVoiceInputActive(true)
    }
    this.applyRenderingEnabled()
  }

  /**
   * Drives the renderables and managed components owned at this level to {@link _renderingEnabled}.
   * Called on a state change and on initialization; idempotent so it is safe to re-apply.
   * Subclasses override to extend coverage to the renderables they own, calling super first.
   */
  protected applyRenderingEnabled(): void {
    // The gated hooks own the routing: enableVisuals releases/restores the background + shadow, and
    // enableManagedComponents drives every managed entry (text, interaction, sub-widgets) to its
    // released or restored state.
    this.enableVisuals()
    this.enableManagedComponents()
    // Re-sync the caret/highlight with the released state (drops it on release; restores it only
    // if still editing, which setRenderingEnabled(false) prevents by exiting edit mode first).
    this.updateTextManipulationEditMode(this.isEditing)
    if (!this._renderingEnabled) {
      // Disabled masks do not count toward Lens Studio's enabled-mask limit. Rendering release is
      // nevertheless a structural lifecycle boundary, so discard the allocation and recreate it
      // lazily on future demand.
      this.destroyMaskingComponent()
    }
  }

  /**
   * Managed components whose enabled-state is render rather than interaction. The text-manipulation
   * module is excluded: it stays enabled and its own `active` flag gates the caret/highlight
   * visuals. Any allocated mask is render-gated, then reconciled to its content/editing demand
   * after each managed-component restore.
   */
  protected isRenderGatedManagedComponent(component: Component): boolean {
    return component === this.textComponent || component === this.maskingComponent
  }

  /**
   * Transitions the component to the specified interaction state.
   * Animates the component size toward the target state's size when {@link scaleOnHover} is enabled.
   * @param stateName - The target interaction state.
   */
  public setState(stateName: StateName) {
    super.setState(stateName)
    const state = this._states.get(stateName)
    if (!this.voiceStatusPlaceholderActive) {
      this.applyTextFillColor(this.getCurrentTextFillColor())
    }
    this.stateCancelSet()
    if (this.scaleOnHover) {
      animate({
        cancelSet: this.stateCancelSet,
        duration: STATE_ANIMATION_DURATION,
        easing: "ease-in-quart",
        update: (t) => {
          const newSize = state.size ? state.size() : this._originalSize
          this.size = vec3.lerp(this._size, newSize, t)
        }
      })
    }
  }

  /**
   * Initializes the text input component after scene objects are created.
   * Sets up the text hierarchy, configures keyboard callbacks, applies the initial
   * font, size, and text state, and invokes the subclass hook
   * {@link initializeTextComponent}
   */
  public initialize(): boolean {
    if (this._initialized) {
      return false
    }

    this.syncCanvasSize()
    this.canvasController ??= new CanvasController(this.sceneObject)
    this.canvasController.ensure(this.canvasSize)

    if (!super.initialize()) {
      return false
    }

    // Instant drag is the editing-only mode; editMode() turns it on with the caret module and off again on
    // blur. Unfocused it must stay off: IK's drag threshold is the dead zone that keeps a tap from
    // stepping a numeric field's drag-adjust value, and a release that is not a drag lets the state
    // machine toggle the field immediately instead of waiting for the deferred focus.
    this.interactable.enableInstantDrag = false

    this.mask.setParent(this.sceneObject)
    this.textObject.setParent(this.mask)
    this.maskScreenTransform.position = new vec3(0, 0, MASK_Z_OFFSET)

    this.textComponent.depthTest = true
    this.textComponent.horizontalAlignment = HorizontalAlignment.Left
    this.textObjectScreenTransform.offsets = Rect.create(0, 0, 0, 0)
    this.textObjectScreenTransform.enableDebugRendering = DEBUG_RENDER
    this.maskScreenTransform.enableDebugRendering = DEBUG_RENDER

    this.systemKeyboardModule = new SystemKeyboardModule(this.keyboardType, this.returnKeyType, this)

    this.initializeTextComponent()

    this._interactableStateMachine.untoggleOnClick = false

    this.updateRenderOrder(this._renderOrder)
    if (this._fontFamily) this.textComponent.font = this._fontFamily
    this.textComponent.size = this.computeFontSize()

    this.textManipulationObject = global.scene.createSceneObject("textManipulation")
    this.textManipulationObject.setParent(this.sceneObject)
    this.textManipulationObject.layer = this.sceneObject.layer
    this.managedSceneObjects.add(this.textManipulationObject)

    this.textManipulationModule = this.textManipulationObject.createComponent(
      TextManipulationModule.getTypeName()
    ) as TextManipulationModule
    this.addManagedComponent(this.textManipulationModule)
    this.textManipulationModule.textComponent = this.textComponent
    this.textManipulationModule.interactable = this.interactable
    this.textManipulationModule.isEditable = true
    this.textManipulationModule.setRenderOrder(this._renderOrder)
    this.textManipulationModule.active = false
    this.textManipulationModule.opacity = this._opacity
    this.textBoundingBoxUnsubscribe = this.textManipulationModule.onTextBoundingBoxUpdated.add(() => {
      // A getBoundingBox() query can be rate-limited and complete during a later module flush.
      // Re-run layout then so overflow-driven masking reconciles with the eventual measurement.
      this.markTextLayoutDirty()
    })
    this.textManipulationModule.onInitialized.add(() => {
      this.lastPublishedCaretCharIndex = this.textManipulationModule.caretCharIndex
      this.textManipulationModule.onTextUpdated.add((update) => {
        if (update.text === this._text) return
        this._text = update.text
        this.updateText()
        this.systemKeyboardModule.updateText(
          update.text,
          update.highlightStartCharIndex ?? update.caretCharIndex,
          update.highlightEndCharIndex ?? update.caretCharIndex
        )
      })

      this.textManipulationModule.onCaretIndexChanged.add(() => {
        const caretIndex = this.textManipulationModule.caretCharIndex
        if (this.lastPublishedCaretCharIndex !== caretIndex) {
          this.lastPublishedCaretCharIndex = caretIndex
          this.onCaretIndexChangedEvent.invoke(caretIndex)
        }

        // Cursor geometry can reproject the hidden pre-selection caret while the logical highlight
        // remains unchanged. Keep the native keyboard aligned with that authoritative range instead
        // of treating the geometry-only caret update as a request to collapse the selection.
        if (this.textManipulationModule.isHighlighted) {
          const start = this.textManipulationModule.highlightStartCharIndex
          const end = this.textManipulationModule.highlightEndCharIndex
          // A native selection callback can arrive after the parent LateUpdate. Its cached range is
          // newer than the logical highlight and will become authoritative in the next parent flush.
          if (
            start !== undefined &&
            end !== undefined &&
            !this._selectionDirty &&
            (this.systemKeyboardModule.selectionStart !== start || this.systemKeyboardModule.selectionEnd !== end)
          ) {
            this.systemKeyboardModule.updateSelectionRange(start, end)
          }
          return
        }

        if (
          this.systemKeyboardModule.selectionStart === caretIndex &&
          this.systemKeyboardModule.selectionEnd === caretIndex
        ) {
          return
        }

        this.systemKeyboardModule.updateSelectionRange(caretIndex, caretIndex)
      })

      this.textManipulationModule.onHighlightUpdated.add((text) => {
        this.onHighlightUpdatedEvent.invoke(text)

        const start = this.textManipulationModule.highlightStartCharIndex ?? this.textManipulationModule.caretCharIndex
        const end = this.textManipulationModule.highlightEndCharIndex ?? this.textManipulationModule.caretCharIndex
        if (this.systemKeyboardModule.selectionStart === start && this.systemKeyboardModule.selectionEnd === end) {
          return
        }

        this.systemKeyboardModule.updateSelectionRange(start, end)
      })

      this.textManipulationModule.onCaretIndexChanged.add(() => {
        if (this.textManipulationModule.isHighlighted) return
        this.scrollToIndex(this.textManipulationModule.caretIndex)
      })
      this.textManipulationModule.onCaretDragged.add(() => {
        this.scrollToIndex(this.textManipulationModule.caretIndex)
      })
      this.textManipulationModule.onHighlightHandleDragged.add((params) => {
        this.scrollToIndex(params.index)
      })

      this.updateSize()
      this.updateText(false)
    })

    this.applyOpacity()

    // Honor a rendering-off state set before initialization now that the renderables exist.
    if (!this._renderingEnabled) {
      this.applyRenderingEnabled()
    } else {
      this.applyMaskingComponentState()
    }
    this.sortHierarchy()
    return true
  }

  /**
   * Called when the component is first created.
   * Creates the mask and text scene objects, and sets up the batched update event.
   */
  public onAwake(): void {
    this._batchUpdateEvent = this.createEvent("LateUpdateEvent")
    this._batchUpdateEvent.enabled = false
    this._batchUpdateEvent.bind(() => this.flushBatchedUpdatesAndUpdateEvent())

    this.asrVisualSweepEvent = this.createEvent("UpdateEvent")
    this.asrVisualSweepEvent.enabled = false
    this.asrVisualSweepEvent.bind(() => this.updateAsrVisualSweep())

    this.asrBottomEdgeEvent = this.createEvent("UpdateEvent")
    this.asrBottomEdgeEvent.enabled = false
    this.asrBottomEdgeEvent.bind(() => this.updateAsrBottomEdge())

    this.mask = global.scene.createSceneObject("mask")
    this.managedSceneObjects.add(this.mask)
    this.mask.layer = this.sceneObject.layer
    this.maskScreenTransform = this.mask.createComponent("ScreenTransform")

    this.textObject = global.scene.createSceneObject("textObject")
    this.textObject.layer = this.sceneObject.layer
    this.textObjectScreenTransform = this.textObject.createComponent("ScreenTransform")
    this.textComponent = this.textObject.getComponent("Text") || this.textObject.createComponent("Text")
    this.addManagedComponent(this.textComponent)

    this.setupFocusFrame()

    super.onAwake()
  }

  /**
   * Wires up the focus-frame follower for this field: resolves which transform moves,
   * constructs the follower, registers it, and bridges edit mode to focus requests. The
   * follower is inert until the platform focus-frame source reports the keyboard open.
   */
  private setupFocusFrame(): void {
    if (!this.enableFocusFrame) return

    const {target, frame} = this.resolveFocusFrameTarget()

    // Content height lifts the docked element off the anchor so its bottom edge rests on
    // it. A Frame reports its full panel height; when the field moves itself, it reports
    // its own height. An explicit non-Frame target has no known height (no lift).
    let getContentHeight: (() => number) | undefined
    if (frame) {
      getContentHeight = () => frame.totalSize.y
    } else if (target === this.sceneObject) {
      getContentHeight = () => this._size.y
    }

    // Acquire a follower keyed by the target scene object: sibling fields inside the same
    // Frame share ONE mover, so switching between them doesn't make the panel fight itself.
    this.focusFrameFollower = FocusFrameFollower.acquire({
      target: target.getTransform(),
      sceneObject: target,
      getContentHeight: getContentHeight,
      // Keep the panel docked across a field switch: TextInputComponentManager blurs the
      // old field immediately but delays focusing the new one by KEYBOARD_DELAY_DESELECT,
      // so hold focus for that window rather than bouncing home and back.
      releaseGraceMs: KEYBOARD_DELAY_DESELECT,
      // When the target is a Frame, the focus frame temporarily owns its pose
      // and scale while docked; Frame's wrapper runs the full sequence.
      onFocusStart: frame ? () => frame.suspendForFocusFrame() : undefined,
      onReturnComplete: frame ? () => frame.resumeFromFocusFrame() : undefined
    })

    this.focusFrameDockUnsubscribe = this.focusFrameFollower.onDockStateChanged.add((docked: boolean) => {
      this.focusFrameDocked = docked
      this.onFocusFrameDockChanged(docked)
    })
    if (this.focusFrameFollower.isDocked) {
      // Late acquirer of a shared follower that is already docked. Seed from the event
      // state, not isFocused — isFocused stays true through the return flight, whose
      // false event already fired and would never reach this subscriber.
      this.focusFrameDocked = true
      this.onFocusFrameDockChanged(true)
    }

    // Docking is driven by edit mode: requesting focus when editing begins, releasing it
    // when editing ends. The manager independently suspends docking while the source
    // is disabled, retaining the field's focus until this edit-mode release.
    this.focusFrameUnsubscribe = this.onEditMode.add((editing: boolean) => {
      if (!this.focusFrameFollower) return
      if (editing) {
        this.focusFrameFollower.requestFocus()
      } else if (this.textInputComponentManager.isFocusSwitchInProgress) {
        // A field switch: hold the dock through the manager's focus-switch delay so the
        // panel doesn't bounce home and back.
        this.focusFrameFollower.releaseFocus()
      } else {
        // A plain deselect: no refocus is coming, fly home immediately.
        this.focusFrameFollower.releaseFocus(0)
      }
    })
  }

  /**
   * Resolves the object that moves toward the keyboard. Precedence:
   *  1. An explicitly assigned `focusFrameTarget`.
   *  2. The nearest ancestor Frame that participates in the focus frame (moves the whole
   *     panel).
   *  3. This field's own scene object.
   */
  private resolveFocusFrameTarget(): {target: SceneObject; frame: Frame | null} {
    if (this.focusFrameTarget) {
      const explicitFrame = this.focusFrameTarget.getComponent(Frame.getTypeName()) as Frame | null
      return {target: this.focusFrameTarget, frame: explicitFrame ?? null}
    }

    let parent: SceneObject | null = this.sceneObject.getParent()
    while (parent) {
      const frame = parent.getComponent(Frame.getTypeName()) as Frame | null
      if (frame && frame.useFocusFrame) {
        return {target: parent, frame}
      }
      parent = parent.getParent()
    }

    return {target: this.sceneObject, frame: null}
  }

  protected get isToggle(): boolean {
    return true
  }

  protected get textInputComponentManager() {
    return this._textInputComponentManager
  }

  /** Subclass hook to configure text alignment and overflow modes. */
  protected abstract initializeTextComponent(): void

  /** Subclass hook to render text to the text component. */
  protected abstract updateVisibleText(text: string): void

  /** Subclass hook to compute the font size */
  protected abstract computeFontSize(): number

  /** Subclass hook to update text content layout after text, size, or control visibility changes. */
  protected abstract updateTextLayout(): void

  /** Subclass hook to keep the caret or selection handle visible while editing. */
  protected abstract updateScrollOffset(targetIndex: number): boolean

  protected get keyboardType(): TextInputSystem.KeyboardType {
    return TextInputSystem.KeyboardType.Text
  }

  protected get returnKeyType(): TextInputSystem.ReturnKeyType {
    return TextInputSystem.ReturnKeyType.Done
  }

  protected getAsrVisualSweepMode(): AsrVisualSweepMode {
    return "loop"
  }

  protected getAsrVisualSweepPalette(): AsrVisualSweepPalette {
    return DEFAULT_ASR_VISUAL_SWEEP_PALETTE
  }

  // Return a color to enable the animated bottom-edge scan during voice mode (a
  // dedicated child element), or null to disable it (default).
  protected getAsrBottomEdgeColor(): vec4 | null {
    return null
  }

  /**
   * Handles native keyboard open and close callbacks.
   * This is intended for {@link SystemKeyboardModule} delegate use and should not be
   * called directly by application code.
   * @param isOpen - `true` when the native keyboard opened, `false` when it closed.
   */
  public onKeyboardStateChangedHandler(isOpen: boolean): void {
    if (isOpen) {
      this.setVoiceInputActive(false)
      this.stopVoiceInputListeningState()
    }

    this.keyboardStateChanged.invoke(isOpen)
    if (DEFAULT_BEHAVIOR) {
      if (!isOpen) {
        this._hasError = false
        this.editMode(false)
      }
    }
    if (!isOpen) {
      this.setVoiceInputActive(this._renderingEnabled)
    }
  }

  /**
   * Handles selection updates sent by the native keyboard.
   * This is intended for {@link SystemKeyboardModule} delegate use and should not be
   * called directly by application code.
   * @param start - Selection start in UTF-16 character units.
   * @param end - Selection end in UTF-16 character units.
   */
  public onSetSelectionHandler(start: number, end: number): void {
    if (!this.isEditing) return

    if (this.systemKeyboardModule.selectionStart !== start || this.systemKeyboardModule.selectionEnd !== end) {
      this.systemKeyboardModule.selectionRange = {start, end}
      this._selectionDirty = true
      this.batchUpdate()
    }
  }

  /**
   * Handles text updates sent by the native keyboard.
   * This is intended for {@link SystemKeyboardModule} delegate use and should not be
   * called directly by application code.
   *
   * NOTE: TextInputField supersedes this handler without calling super — its password-reveal and
   * reentrancy guards need seams between the three steps below, which this method applies
   * atomically. Behavioral changes here must be mirrored in that override.
   * @param text - The updated text content.
   * @param selectionStart - Optional selection start in UTF-16 character units.
   * @param selectionEnd - Optional selection end in UTF-16 character units.
   * @param editContext - Optional authoritative splice metadata for incremental keyboard edits.
   * @param editDisposition - Optional authoritative classification for a callback that changed no text.
   */
  public onTextChangedHandler(
    text: string,
    selectionStart?: number,
    selectionEnd?: number,
    _editContext?: SystemKeyboardEditContext,
    _editDisposition?: SystemKeyboardEditDisposition
  ): void {
    this.text = text

    this.typingEvent.invoke()
    if (selectionStart !== undefined && selectionEnd !== undefined) {
      this.onSetSelectionHandler(selectionStart, selectionEnd)
    }
  }

  /**
   * Handles native return-key activation by emitting the current text.
   * This is intended for {@link SystemKeyboardModule} delegate use and should not be
   * called directly by application code.
   */
  public onReturnKeyPressedHandler(): void {
    this.returnKeyPressed.invoke(this.text)
  }

  protected createDefaultVisual(): void {
    if (!this._visual) {
      const defaultVisual: RoundedRectangleVisual = new RoundedRectangleVisual({
        sceneObject: this.sceneObject,
        style: TEXT_INPUT_VISUAL_STYLE
      })
      defaultVisual.cornerRadius = CORNER_RADIUS
      this._visual = defaultVisual
    }
    this.captureOpacityVisualBaseTransparency(this.roundedRectangleVisual)
  }

  protected applyOpacity(): void {
    const visual = this.roundedRectangleVisual
    this.captureOpacityVisualBaseTransparency(visual)
    if (visual) {
      visual.transparencyEnabled = this._opacity < 1.0 || this._opacityVisualBaseTransparencyEnabled
      visual.opacity = this._opacity
    }
    this.applyTextOpacity()
    if (this.textManipulationModule) {
      this.textManipulationModule.opacity = this._opacity
    }
  }

  protected applyTextFillColor(color: vec4): void {
    if (color === undefined) return

    this._textFillBaseColor.r = color.r
    this._textFillBaseColor.g = color.g
    this._textFillBaseColor.b = color.b
    this._textFillBaseColor.a = color.a
    this.applyTextOpacity()
  }

  private getCurrentTextFillColor(): vec4 {
    const stateColor = this._states.get(this.stateName)?.textColor ?? DEFAULT_TEXT_COLOR
    if (this.stateName === StateName.inactive) {
      return stateColor
    }
    return this.isPlaceholder ? PLACEHOLDER_TEXT_COLOR : stateColor
  }

  private applyTextOpacity(): void {
    if (!this.textComponent) return

    const color = this._textFillBaseColor
    this._textFillDisplayColor.r = color.r
    this._textFillDisplayColor.g = color.g
    this._textFillDisplayColor.b = color.b
    this._textFillDisplayColor.a = color.a * this._opacity
    this.textComponent.textFill.color = this._textFillDisplayColor
  }

  private captureOpacityVisualBaseTransparency(visual: RoundedRectangleVisual | null): void {
    if (this._opacityVisualBaseTransparencySource === visual) return

    this._opacityVisualBaseTransparencySource = visual
    this._opacityVisualBaseTransparencyEnabled = visual?.transparencyEnabled ?? false
  }

  protected setUpEventCallbacks(): void {
    if (this.addCallbacks) {
      this.onTextChanged.add(createCallbacks(this.onTextChangedCallbacks))
      this.onKeyboardStateChanged.add(createCallbacks(this.onKeyboardStateChangedCallbacks))
    }
    super.setUpEventCallbacks()
  }

  protected calculateHoverScale(): vec3 {
    return this._originalSize.uniformScale(HOVER_SCALE_FACTOR)
  }

  protected onTriggerUpHandler(event: InteractorEvent): void {
    // Focus is queued before onTriggerUp goes out, so a listener that removes or releases the field
    // cancels it (deregisterActive). Queued after, it would open a field that is gone.
    if (event.target === this.interactable) {
      // Asked on every release, editing or not: an override may clear per-press state here.
      const focus = this.focusOnRelease()
      if (focus && !this.isEditing) {
        this.textInputComponentManager.requestFocus(this)
      }
    }
    // Element raises onTriggerUp (and its release sound) for every release on the field, focusing
    // or not; ToolbarTextField and other consumers listen for it.
    super.onTriggerUpHandler(event)
  }

  /** Whether a release on the field opens it for editing. TextInputField declines after a drag-to-adjust. */
  protected focusOnRelease(): boolean {
    return true
  }

  protected updateRenderOrder(value: number) {
    this._visual.renderMeshVisual.renderOrder = value
    this.textComponent.renderOrder = value
    this.textManipulationModule?.setRenderOrder(value)
    if (this.asrBottomEdgeVisual) {
      this.asrBottomEdgeVisual.renderMeshVisual.renderOrder = value
    }
  }

  protected updateText(textChanged: boolean = true): void {
    this._textDirty = false
    this._textPresentationDirty = false
    this.isPlaceholder = !this.isEditing && this._text === ""
    this.updateVisibleText(this.isPlaceholder ? this._placeholderText : this._text)
    this.onTextUpdated(textChanged)
  }

  protected onTextUpdated(textChanged: boolean = true): void {
    this.applyTextFillColor(this.getCurrentTextFillColor())

    this.textManipulationModule.refresh({text: this._text})
    this.markTextLayoutDirty()

    if (textChanged) {
      this.onTextChangedEvent.invoke(this._text)
    }
  }

  protected onVoiceStatusPlaceholderChanged(): void {
    // Subclasses can update auxiliary controls whose visibility depends on the voice status placeholder.
  }

  private onVoiceInputToggleValueChanged(isOn: boolean): void {
    if (isOn) {
      if (!this.voiceInputActive) {
        this.registeredVoiceInputButton?.toggle(false)
        return
      }

      this.voiceSessionActive = true
      this.startAsrVisualSweep()
      this.showVoiceStatusPlaceholder()
      return
    }

    this.stopVoiceInputListeningState()
  }

  private showVoiceStatusPlaceholder(text: string = localizeOr(LISTENING_TEXT_KEY, LISTENING_TEXT_FALLBACK)): void {
    this.voiceStatusPlaceholderActive = true
    if (this._initialized && this.textComponent) {
      this.updateVisibleText(text)
      this.applyTextFillColor(PLACEHOLDER_TEXT_COLOR)
      this.textManipulationModule.refresh({fromText: true})
      this.markTextLayoutDirty()
    }
    this.onVoiceStatusPlaceholderChanged()
  }

  private restoreTextAfterVoiceStatusPlaceholder(): void {
    if (!this.voiceStatusPlaceholderActive) return

    this.voiceStatusPlaceholderActive = false
    if (this._initialized && this.textComponent) {
      this.updateText(false)
    }
    this.onVoiceStatusPlaceholderChanged()
  }

  private onVoiceListeningUpdate(text: string, isFinal: boolean): void {
    if (!this.voiceInputActive) {
      if (this.registeredVoiceInputButton?.isOn) {
        this.registeredVoiceInputButton.toggle(false)
      }
      this.stopVoiceInputListeningState()
      return
    }

    if (isFinal) {
      // The session ends with its final transcript; a deferred hold-mode commit is still covered
      // by asrFinishInProgress until it lands.
      this.voiceSessionActive = false
    }

    // On final, if the colored "hold" background is showing, play the finish
    // sequence (bounce to gray -> color returns as the message appears -> dim)
    // and reveal the recognized message at the bounce's gray midpoint.
    if (isFinal && this.canRunAsrFinishSequence()) {
      this.runAsrHoldFinishSequence(() => {
        // Set the final text BEFORE restoring the placeholder, so the restore
        // renders the recognized message (not the stale/empty pre-final text).
        this.text = text
        if (this.voiceStatusPlaceholderActive) {
          this.restoreTextAfterVoiceStatusPlaceholder()
        }
      })
      // Fire finalize immediately (with the text payload) rather than inside the
      // deferred reveal, so the event is never dropped if the finish is cancelled.
      this.onVoiceFinalizeEvent.invoke(text)
      return
    }

    if (this.voiceStatusPlaceholderActive) {
      this.restoreTextAfterVoiceStatusPlaceholder()
    }

    this.text = text
    if (isFinal) {
      this.stopAsrVisualSweep()
      this.onVoiceFinalizeEvent.invoke(text)
    }
  }

  private canRunAsrFinishSequence(): boolean {
    return this.asrVisualSweepActive && this.asrActiveSweepMode === "hold" && this.roundedRectangleVisual !== null
  }

  // Final-result finish for "hold" mode: bounce the fill full color -> gray ->
  // full color over ASR_FINISH_BOUNCE_DURATION (revealing the message at the gray
  // midpoint), then dim full color -> gray over ASR_FINISH_DIM_DURATION. Mirrors
  // the reference TextInput_bg 5 stage bounce (0.5 -> 1 -> 0.5, then 0.5 -> 0).
  private flushAsrPendingReveal(): void {
    const reveal = this.asrPendingReveal
    this.asrPendingReveal = null
    reveal?.()
  }

  private runAsrHoldFinishSequence(revealMessage: () => void): void {
    const visual = this.roundedRectangleVisual
    if (!visual) {
      revealMessage()
      this.stopAsrVisualSweep()
      return
    }

    // Two finals back-to-back: commit the previous one before superseding it.
    this.flushAsrPendingReveal()
    this.asrVisualSweepRampCancelSet.cancel()
    this.asrVisualSweepActive = false
    this.asrVisualSweepRampOutActive = true
    this.asrFinishInProgress = true
    // Listening ended: hide the scanning bottom edge as the finish bounce begins.
    this.stopAsrBottomEdge()

    const colorGradients = this.createAsrHoldGradients()
    // Gray target with the SAME 4-stop topology as the color gradient (every stop
    // = the idle color), so all stops cross-fade color->gray uniformly. Lerping
    // straight to the 2-stop idle gradient instead makes the extra (teal-side)
    // stops fade by alpha while the purple side fades by color, so the teal lags.
    const grayGradients = this.asrGrayGradients(colorGradients)
    let revealed = false
    const reveal = (): void => {
      if (!revealed) {
        revealed = true
        this.asrPendingReveal = null
        revealMessage()
      }
    }
    this.asrPendingReveal = reveal

    // Anchor at full color before the bounce: animate() advances time before its
    // first update, and a fast final can arrive before the hold ramp-in finished,
    // so without this the first frame could jump from a partial fill.
    this.applyAsrColorAmount(visual, grayGradients, colorGradients, 1)

    animate({
      cancelSet: this.asrVisualSweepRampCancelSet,
      duration: ASR_FINISH_BOUNCE_DURATION,
      // Symmetric easing so the dip to gray and the return to color are both
      // paced and clearly visible (ease-out would flash to gray then linger).
      easing: "ease-in-out-cubic",
      update: (t) => {
        // colorAmount: 1 (color) -> 0 (gray) -> 1 (color). t is already eased.
        this.applyAsrColorAmount(visual, grayGradients, colorGradients, 1 - Math.sin(t * Math.PI))
        if (t >= 0.5) {
          reveal()
        }
      },
      ended: () => {
        reveal()
        animate({
          cancelSet: this.asrVisualSweepRampCancelSet,
          duration: ASR_FINISH_DIM_DURATION,
          easing: "ease-out-cubic",
          update: (t) => this.applyAsrColorAmount(visual, grayGradients, colorGradients, 1 - t),
          ended: () => {
            this.asrFinishInProgress = false
            this.asrVisualSweepRampOutActive = false
            this.asrCurrentBackgroundGradient = null
            this.asrCurrentBorderGradient = null
            visual.refreshRoundedRectangleState()
          }
        })
      }
    })
  }

  // Blend between the gray and color gradients (same 4-stop topology), so every
  // stop fades color<->gray together. amount: 1 = full color, 0 = full gray.
  private applyAsrColorAmount(
    visual: RoundedRectangleVisual,
    grayGradients: AsrVisualSweepGradients,
    colorGradients: AsrVisualSweepGradients,
    amount: number
  ): void {
    const background = GradientParameters.lerp(grayGradients.background, colorGradients.background, amount)
    const border = GradientParameters.lerp(grayGradients.border, colorGradients.border, amount)
    this.asrCurrentBackgroundGradient = background
    this.asrCurrentBorderGradient = border
    visual.applyBaseGradientNow(background)
    visual.applyBorderGradientNow(border)
  }

  // Build gray gradients matching the color gradients' 4-stop topology, every
  // stop set to the current idle background color, so a color<->gray blend fades
  // uniformly (no per-stop alpha lag). Ends at the same gray the field restores
  // to via refreshRoundedRectangleState().
  private asrGrayGradients(colorGradients: AsrVisualSweepGradients): AsrVisualSweepGradients {
    const visual = this.roundedRectangleVisual
    const stateGradients = visual ? this.getCurrentRoundedRectangleStateGradients(visual) : null
    const bgGray = stateGradients?.background.stop0?.color ?? stateGradients?.background.stop1?.color
    const borderGray = stateGradients?.border.stop0?.color ?? bgGray
    return {
      background: this.gradientWithUniformColor(colorGradients.background, bgGray),
      border: this.gradientWithUniformColor(colorGradients.border, borderGray ?? bgGray)
    }
  }

  private gradientWithUniformColor(template: GradientParameters, color: vec4 | undefined): GradientParameters {
    const grayStop = (stop?: GradientStop): GradientStop | undefined =>
      stop === undefined ? undefined : {enabled: stop.enabled, percent: stop.percent, color: color ?? stop.color}
    return {
      enabled: template.enabled,
      type: template.type,
      start: template.start,
      end: template.end,
      stop0: grayStop(template.stop0),
      stop1: grayStop(template.stop1),
      stop2: grayStop(template.stop2),
      stop3: grayStop(template.stop3),
      stop4: grayStop(template.stop4)
    }
  }

  private onVoiceListeningError(statusCode: AsrModule.AsrStatusCode): void {
    this.voiceSessionActive = false
    this.stopAsrVisualSweep()
    this.showVoiceStatusPlaceholder(localizeOr(ERROR_TEXT_KEY, ERROR_TEXT_FALLBACK))
    this.onVoiceErrorEvent.invoke(statusCode)
  }

  private onVoiceListeningErrorAutoReset(): void {
    this.restoreTextAfterVoiceStatusPlaceholder()
  }

  protected setVoiceInputActive(active: boolean): void {
    if (this.voiceInputActive === active) return
    this.voiceInputActive = active
    this.applyRegisteredVoiceInputButtonInactive()
  }

  /**
   * `true` while a voice-input session owns the field's text: the registered voice button is
   * listening, a session is awaiting its final transcript (button-driven or app-driven via
   * setVoiceListening), the field shows a voice status placeholder (listening or error), the ASR
   * sweep is running, or the hold-mode finish sequence is still playing and may hold a deferred
   * final-transcript commit. Subclasses use this to hold off interactions that would race the
   * transcript for the text model.
   */
  protected get isVoiceInputListening(): boolean {
    return (
      this.registeredVoiceInputButton?.isOn === true ||
      this.voiceSessionActive ||
      this.voiceStatusPlaceholderActive ||
      this.asrVisualSweepActive ||
      this.asrFinishInProgress
    )
  }

  private stopVoiceInputListeningState(): void {
    this.voiceSessionActive = false
    this.stopAsrVisualSweep()
    // During the finish sequence the message reveal is owned by the bounce
    // midpoint, so don't restore the placeholder->text early here.
    if (!this.asrFinishInProgress) {
      this.restoreTextAfterVoiceStatusPlaceholder()
    }
  }

  private applyRegisteredVoiceInputButtonInactive(): void {
    if (!this.registeredVoiceInputButton) return

    this.registeredVoiceInputButton.inactive = this.registeredVoiceInputButtonPreviousInactive || !this.voiceInputActive
  }

  private deregisterVoiceInputButtonForLifecycle(): void {
    if (this.registeredVoiceInputButton?.isOn) {
      this.registeredVoiceInputButton.toggle(false)
    }
    this.deregisterVoiceInputButton()
  }

  private startAsrVisualSweep(): void {
    // Commit any pending final transcript BEFORE cancelling the finish
    // sequence — otherwise a rapid re-dictation drops the reveal and the
    // recognized text never reaches the model. The new session's placeholder
    // overlays it immediately after, in the right order.
    this.flushAsrPendingReveal()
    this.asrVisualSweepRampCancelSet.cancel()
    // A fresh start supersedes any in-progress ramp-out / finish sequence (whose
    // `ended` won't fire once cancelled), so clear the guards explicitly.
    this.asrVisualSweepRampOutActive = false
    this.asrFinishInProgress = false
    this.stopAsrBottomEdge()
    // Cache the resolved mode/palette for the whole sweep so stop matches start.
    this.asrActiveSweepMode = this.getAsrVisualSweepMode()
    this.asrActiveSweepPalette = this.getAsrVisualSweepPalette()
    const visual = this.roundedRectangleVisual
    if (!visual) {
      this.asrCurrentBackgroundGradient = null
      this.asrCurrentBorderGradient = null
      return
    }

    this.asrVisualSweepActive = true
    this.asrVisualSweepTimeSeconds = 0
    // Bottom-edge scan runs alongside any voice mode (gated by the color hook).
    this.startAsrBottomEdge()
    if (this.asrActiveSweepMode === "hold") {
      if (this.asrVisualSweepEvent) {
        this.asrVisualSweepEvent.enabled = false
      }
      this.startAsrHoldVisualSweep(visual)
      return
    }

    this.asrCurrentBackgroundGradient = null
    this.asrCurrentBorderGradient = null
    if (this.asrVisualSweepEvent) {
      this.asrVisualSweepEvent.enabled = true
    }
    this.applyAsrVisualSweepGradientPalette()
  }

  private stopAsrVisualSweep(): void {
    // Voice end fires stop twice (final transcript, then the VoiceInputButton
    // toggling off). If a hold ramp-out is already easing out, let it finish
    // rather than cancelling it and snapping via refreshRoundedRectangleState().
    if (this.asrVisualSweepRampOutActive) {
      return
    }
    this.asrVisualSweepRampCancelSet.cancel()
    if (this.asrVisualSweepEvent) {
      this.asrVisualSweepEvent.enabled = false
    }
    this.stopAsrBottomEdge()

    const visual = this.roundedRectangleVisual
    if (!this.asrVisualSweepActive) {
      if (visual && (this.asrCurrentBackgroundGradient || this.asrCurrentBorderGradient)) {
        this.asrCurrentBackgroundGradient = null
        this.asrCurrentBorderGradient = null
        visual.refreshRoundedRectangleState()
      }
      return
    }

    this.asrVisualSweepActive = false
    this.asrVisualSweepTimeSeconds = 0
    if (!visual) {
      this.asrCurrentBackgroundGradient = null
      this.asrCurrentBorderGradient = null
      return
    }

    if (this.asrActiveSweepMode === "hold") {
      this.stopAsrHoldVisualSweep(visual)
      return
    }

    this.asrCurrentBackgroundGradient = null
    this.asrCurrentBorderGradient = null
    visual.refreshRoundedRectangleState()
  }

  private updateAsrVisualSweep(): void {
    if (!this.asrVisualSweepActive) {
      if (this.asrVisualSweepEvent) {
        this.asrVisualSweepEvent.enabled = false
      }
      return
    }

    const visual = this.roundedRectangleVisual
    if (!visual) {
      this.asrVisualSweepRampCancelSet.cancel()
      this.stopAsrVisualSweep()
      return
    }

    this.asrVisualSweepTimeSeconds += getDeltaTime()
    this.applyAsrVisualSweepGradientPalette()
  }

  private applyAsrVisualSweepGradientPalette(): void {
    const visual = this.roundedRectangleVisual
    if (!visual) {
      this.asrVisualSweepRampCancelSet.cancel()
      return
    }

    if (this.asrActiveSweepMode === "radial") {
      this.applyAsrRadialGradient(visual)
      return
    }

    const palette = this.asrActiveSweepPalette
    const phase = this.getAsrSweepPhase()
    this.configureAsrLoopGradient(this.asrBackgroundGradient, palette)
    this.configureAsrLoopGradient(this.asrBorderGradient, palette)
    this.updateAsrSweepGradient(
      this.asrBackgroundGradient,
      phase,
      palette.background[0],
      palette.background[1],
      palette.background[2]
    )
    this.updateAsrSweepGradient(this.asrBorderGradient, phase, palette.border[0], palette.border[1], palette.border[2])
    visual.applyBaseGradientNow(this.asrBackgroundGradient)
    visual.applyBorderGradientNow(this.asrBorderGradient)
  }

  // "radial" mode: a Radial gradient whose center orbits the field center over
  // time, so the colored glow moves — approximating the DS3.0 "Responding"
  // material's moving radial glow. Driven each frame by the sweep UpdateEvent.
  private applyAsrRadialGradient(visual: RoundedRectangleVisual): void {
    const palette = this.asrActiveSweepPalette
    const theta = (this.asrVisualSweepTimeSeconds / ASR_RADIAL_ORBIT_PERIOD_SECONDS) * Math.PI * 2
    const centerX = ASR_RADIAL_ORBIT_RADIUS * Math.cos(theta)
    const centerY = ASR_RADIAL_ORBIT_RADIUS * Math.sin(theta)
    this.writeAsrRadialGradient(this.asrBackgroundGradient, palette.background, centerX, centerY)
    this.writeAsrRadialGradient(this.asrBorderGradient, palette.border, centerX, centerY)
    visual.applyBaseGradientNow(this.asrBackgroundGradient)
    visual.applyBorderGradientNow(this.asrBorderGradient)
  }

  private writeAsrRadialGradient(
    gradient: GradientParameters,
    colors: AsrVisualSweepColors,
    centerX: number,
    centerY: number
  ): void {
    gradient.enabled = true
    gradient.type = "Radial"
    // For Radial: start is the center; |end - start| sets the radial falloff.
    // New vec2 each frame (the template's start/end may alias shared palette refs).
    gradient.start = new vec2(centerX, centerY)
    gradient.end = new vec2(centerX + ASR_RADIAL_SPAN, centerY)
    gradient.stop0.enabled = true
    gradient.stop0.percent = 0
    gradient.stop0.color.copyFrom(colors[0]) // center
    gradient.stop1.enabled = true
    gradient.stop1.percent = 1
    gradient.stop1.color.copyFrom(colors[colors.length - 1]) // edge
    gradient.stop2.enabled = false
    gradient.stop3.enabled = false
    gradient.stop4.enabled = false
  }

  // --- Bottom-edge scan (dedicated child element) ---

  private ensureAsrBottomEdge(): RoundedRectangleVisual | null {
    if (this.asrBottomEdgeVisual) {
      return this.asrBottomEdgeVisual
    }
    const edgeObject = global.scene.createSceneObject("VoiceBottomEdge")
    edgeObject.setParent(this.sceneObject)
    edgeObject.layer = this.sceneObject.layer
    this.managedSceneObjects.add(edgeObject)
    this.asrBottomEdgeObject = edgeObject
    this.asrBottomEdgeTransform = edgeObject.getTransform()
    const edgeStyle: Partial<RoundedRectangleVisualParameters> = {
      default: {baseType: "Gradient", baseGradient: this.asrBottomEdgeGradient, shouldPosition: true}
    }
    const visual = new RoundedRectangleVisual({
      sceneObject: edgeObject,
      style: edgeStyle,
      transparent: true
    })
    visual.renderMeshVisual.renderOrder = this._renderOrder
    visual.cornerRadius = ASR_BOTTOM_EDGE_CORNER_RADIUS
    this.asrBottomEdgeVisual = visual
    this.sortHierarchy()
    return visual
  }

  // Pin the edge element to the field's bottom, sized to the field width.
  private layoutAsrBottomEdge(): void {
    if (!this.asrBottomEdgeVisual || !this.asrBottomEdgeTransform) {
      return
    }
    const height = this._size.y * ASR_BOTTOM_EDGE_HEIGHT_FACTOR
    // Inset the width by the field's corner radius on each side so the bottom
    // line stays within the rounded corners.
    const width = this._size.x - 2 * CORNER_RADIUS
    this.asrBottomEdgeVisual.size = new vec3(width, height, 1)
    // Sit the strip just inside the field's bottom edge (bottom flush, no
    // overhang below the edge).
    this.asrBottomEdgeTransform.setLocalPosition(new vec3(0, -(this._size.y / 2 - height / 2), ASR_BOTTOM_EDGE_Z))
  }

  private startAsrBottomEdge(): void {
    const color = this.getAsrBottomEdgeColor()
    if (!color) {
      return
    }
    const visual = this.ensureAsrBottomEdge()
    if (!visual) {
      return
    }
    this.asrBottomEdgeColor = color
    this.asrBottomEdgeColorTransparent = new vec4(color.x, color.y, color.z, 0)
    this.layoutAsrBottomEdge()
    if (this.asrBottomEdgeObject) {
      this.asrBottomEdgeObject.enabled = true
    }
    this.asrBottomEdgeActive = true
    this.asrBottomEdgeTimeSeconds = 0
    if (this.asrBottomEdgeEvent) {
      this.asrBottomEdgeEvent.enabled = true
    }
    this.applyAsrBottomEdge()
  }

  private updateAsrBottomEdge(): void {
    if (!this.asrBottomEdgeActive) {
      if (this.asrBottomEdgeEvent) {
        this.asrBottomEdgeEvent.enabled = false
      }
      return
    }
    this.asrBottomEdgeTimeSeconds += getDeltaTime()
    this.applyAsrBottomEdge()
  }

  private applyAsrBottomEdge(): void {
    const visual = this.asrBottomEdgeVisual
    const color = this.asrBottomEdgeColor
    const transparent = this.asrBottomEdgeColorTransparent
    if (!visual || !color || !transparent) {
      return
    }
    // A light-blue horizontal lobe (transparent -> bright -> transparent) whose
    // bright peak scans left<->right: a Linear gradient centered at xCenter.
    const xCenter = -Math.sin(this.asrBottomEdgeTimeSeconds * ASR_BOTTOM_EDGE_SPEED) * ASR_BOTTOM_EDGE_TRAVEL
    const gradient = this.asrBottomEdgeGradient
    gradient.enabled = true
    gradient.type = "Linear"
    gradient.start = new vec2(xCenter - ASR_BOTTOM_EDGE_RADIUS, 0)
    gradient.end = new vec2(xCenter + ASR_BOTTOM_EDGE_RADIUS, 0)
    gradient.stop0.enabled = true
    gradient.stop0.percent = 0
    gradient.stop0.color.copyFrom(transparent)
    gradient.stop1.enabled = true
    gradient.stop1.percent = 0.5
    gradient.stop1.color.copyFrom(color) // bright peak at xCenter
    gradient.stop2.enabled = true
    gradient.stop2.percent = 1
    gradient.stop2.color.copyFrom(transparent)
    gradient.stop3.enabled = false
    gradient.stop4.enabled = false
    visual.applyBaseGradientNow(gradient)
  }

  private stopAsrBottomEdge(): void {
    this.asrBottomEdgeActive = false
    if (this.asrBottomEdgeEvent) {
      this.asrBottomEdgeEvent.enabled = false
    }
    if (this.asrBottomEdgeObject) {
      this.asrBottomEdgeObject.enabled = false
    }
  }

  private destroyAsrBottomEdge(): void {
    this.stopAsrBottomEdge()
    this.asrBottomEdgeVisual = null
    this.asrBottomEdgeTransform = null
    if (this.asrBottomEdgeObject) {
      this.managedSceneObjects.delete(this.asrBottomEdgeObject)
      this.asrBottomEdgeObject.destroy()
      this.asrBottomEdgeObject = null
    }
  }

  private startAsrHoldVisualSweep(visual: RoundedRectangleVisual): void {
    const colorGradients = this.createAsrHoldGradients()
    // Ramp gray -> color over a uniform 4-stop topology so every stop fades in
    // together (no per-stop alpha lag from a 2-stop -> 4-stop morph).
    const grayGradients = this.asrGrayGradients(colorGradients)
    this.animateAsrVisualSweepGradients(
      visual,
      // Ramp from whatever is currently applied (e.g. a half-finished ramp-out
      // when voice restarts), falling back to the gray gradient.
      this.asrCurrentBackgroundGradient ?? grayGradients.background,
      this.asrCurrentBorderGradient ?? grayGradients.border,
      colorGradients.background,
      colorGradients.border
    )
  }

  private stopAsrHoldVisualSweep(visual: RoundedRectangleVisual): void {
    const colorGradients = this.createAsrHoldGradients()
    const grayGradients = this.asrGrayGradients(colorGradients)
    this.asrVisualSweepRampOutActive = true
    this.animateAsrVisualSweepGradients(
      visual,
      this.asrCurrentBackgroundGradient ?? colorGradients.background,
      this.asrCurrentBorderGradient ?? colorGradients.border,
      grayGradients.background,
      grayGradients.border,
      () => {
        this.asrVisualSweepRampOutActive = false
        this.asrCurrentBackgroundGradient = null
        this.asrCurrentBorderGradient = null
        visual.refreshRoundedRectangleState()
      }
    )
  }

  private animateAsrVisualSweepGradients(
    visual: RoundedRectangleVisual,
    fromBackgroundGradient: GradientParameters,
    fromBorderGradient: GradientParameters,
    toBackgroundGradient: GradientParameters,
    toBorderGradient: GradientParameters,
    ended?: () => void
  ): void {
    animate({
      cancelSet: this.asrVisualSweepRampCancelSet,
      duration: STATE_ANIMATION_DURATION,
      update: (t) => {
        const backgroundGradient = GradientParameters.lerp(fromBackgroundGradient, toBackgroundGradient, t)
        const borderGradient = GradientParameters.lerp(fromBorderGradient, toBorderGradient, t)
        this.asrCurrentBackgroundGradient = backgroundGradient
        this.asrCurrentBorderGradient = borderGradient
        visual.applyBaseGradientNow(backgroundGradient)
        visual.applyBorderGradientNow(borderGradient)
      },
      ended: () => {
        this.asrCurrentBackgroundGradient = toBackgroundGradient
        this.asrCurrentBorderGradient = toBorderGradient
        visual.applyBaseGradientNow(toBackgroundGradient)
        visual.applyBorderGradientNow(toBorderGradient)
        ended?.()
      }
    })
  }

  private createAsrHoldGradients(): AsrVisualSweepGradients {
    const palette = this.asrActiveSweepPalette
    const stopPercents = palette.stopPercents ?? ASR_HOLD_STOP_PERCENTS
    return {
      background: this.createAsrStaticGradient(palette, palette.background, stopPercents),
      border: this.createAsrStaticGradient(palette, palette.border, stopPercents)
    }
  }

  private createAsrStaticGradient(
    palette: AsrVisualSweepPalette,
    colors: AsrVisualSweepColors,
    stopPercents: readonly number[]
  ): GradientParameters {
    const stop3Color = colors[3] ?? colors[colors.length - 1]
    return {
      enabled: true,
      type: "Linear",
      start: palette.start,
      end: palette.end,
      stop0: {enabled: true, percent: stopPercents[0], color: colors[0]},
      stop1: {enabled: true, percent: stopPercents[1], color: colors[1]},
      stop2: {enabled: true, percent: stopPercents[2], color: colors[2]},
      stop3: {enabled: true, percent: stopPercents[3], color: stop3Color}
    }
  }

  private getCurrentRoundedRectangleStateGradients(visual: RoundedRectangleVisual): AsrVisualSweepGradients {
    // Keep error mappings aligned with RoundedRectangleVisual.updateVisualStates().
    switch (this.stateName) {
      case StateName.hovered:
      case StateName.errorHovered:
        return {background: visual.hoveredGradient, border: visual.borderHoveredGradient}
      case StateName.triggered:
        return {background: visual.triggeredGradient, border: visual.borderTriggeredGradient}
      case StateName.inactive:
        return {background: visual.inactiveGradient, border: visual.borderInactiveGradient}
      case StateName.toggledDefault:
        return {background: visual.toggledDefaultGradient, border: visual.borderToggledDefaultGradient}
      case StateName.toggledHovered:
        return {background: visual.toggledHoveredGradient, border: visual.borderToggledHoveredGradient}
      case StateName.toggledTriggered:
        return {background: visual.toggledTriggeredGradient, border: visual.borderToggledTriggeredGradient}
      case StateName.error:
      case StateName.default:
      default:
        return {background: visual.defaultGradient, border: visual.borderDefaultGradient}
    }
  }

  private configureAsrLoopGradient(gradient: GradientParameters, palette: AsrVisualSweepPalette): void {
    gradient.enabled = true
    gradient.type = "Linear"
    gradient.start = palette.start
    gradient.end = palette.end
    gradient.stop0.enabled = true
    gradient.stop0.percent = ASR_LOOP_STOP_PERCENTS[0]
    gradient.stop1.enabled = true
    gradient.stop1.percent = ASR_LOOP_STOP_PERCENTS[1]
    gradient.stop2.enabled = true
    gradient.stop2.percent = ASR_LOOP_STOP_PERCENTS[2]
    gradient.stop3.enabled = true
    gradient.stop3.percent = ASR_LOOP_STOP_PERCENTS[3]
    gradient.stop4.enabled = true
    gradient.stop4.percent = ASR_LOOP_STOP_PERCENTS[4]
  }

  private getAsrSweepPhase(): number {
    return (this.asrVisualSweepTimeSeconds % ASR_SWEEP_DURATION_SECONDS) / ASR_SWEEP_DURATION_SECONDS
  }

  private updateAsrSweepGradient(
    gradient: GradientParameters,
    phase: number,
    stop0Color: vec4,
    stop1Color: vec4,
    stop2Color: vec4
  ): void {
    this.writeAsrLoopedColor(gradient.stop0.color, phase, stop0Color, stop1Color, stop2Color)
    this.writeAsrLoopedColor(gradient.stop1.color, phase + 0.25, stop0Color, stop1Color, stop2Color)
    this.writeAsrLoopedColor(gradient.stop2.color, phase + 0.5, stop0Color, stop1Color, stop2Color)
    this.writeAsrLoopedColor(gradient.stop3.color, phase + 0.75, stop0Color, stop1Color, stop2Color)
    gradient.stop4.color.copyFrom(gradient.stop0.color)
  }

  private writeAsrLoopedColor(out: vec4, phase: number, color0: vec4, color1: vec4, color2: vec4): void {
    const wrapped = phase - Math.floor(phase)
    const segment = wrapped * 3
    const index = Math.floor(segment)
    const t = segment - index

    if (index === 0) {
      this.writeAsrLerpedColor(out, color0, color1, t)
      return
    }
    if (index === 1) {
      this.writeAsrLerpedColor(out, color1, color2, t)
      return
    }
    this.writeAsrLerpedColor(out, color2, color0, t)
  }

  private writeAsrLerpedColor(out: vec4, from: vec4, to: vec4, t: number): void {
    out.copyFrom(from)
    out.lerpInPlace(to, t)
  }

  private unsubscribeRegisteredVoiceInputEvents(): void {
    for (let i = 0; i < this.registeredVoiceInputUnsubscribes.length; i++) {
      this.registeredVoiceInputUnsubscribes[i]()
    }
    this.registeredVoiceInputUnsubscribes = []
  }

  private get roundedRectangleVisual(): RoundedRectangleVisual | null {
    return this._visual instanceof RoundedRectangleVisual ? this._visual : null
  }

  protected updateSize() {
    this.syncCanvasSize()

    const inset = this.computeInset()
    this.textComponent.size = this.computeFontSize()
    this.setTextViewportBounds(
      this._size.x * -0.5 + inset,
      this._size.x * 0.5 - inset,
      this._size.y * -0.5,
      this._size.y * 0.5
    )
  }

  /** Keeps a locally managed Canvas aligned with the current component size. */
  protected syncCanvasSize(): void {
    this.canvasSize.x = this._size.x
    this.canvasSize.y = this._size.y
    this.canvasController?.setSize(this.canvasSize)
  }

  protected setTextViewportBounds(left: number, right: number, bottom: number, top: number): void {
    setRect(this.textViewportBounds, left, right, bottom, top)

    const maskOverflowPadding = this.computeMaskOverflowPadding()
    expandRect(this.textViewportBounds, maskOverflowPadding, this._maskBounds)
    // Anchors are parent-relative; the viewport bounds are centimeters in the
    // Canvas's world-offset coordinate space.
    setRect(this.maskScreenTransform.anchors, 0, 0, 0, 0)
    copyRect(this._maskBounds, this.maskScreenTransform.offsets)
    this.setTextObjectAnchorsFromBounds()
  }

  private setTextObjectAnchorsFromBounds(): void {
    const maskCenterX = (this._maskBounds.left + this._maskBounds.right) * 0.5
    const maskCenterY = (this._maskBounds.bottom + this._maskBounds.top) * 0.5
    const maskHalfWidth = (this._maskBounds.right - this._maskBounds.left) * 0.5
    const maskHalfHeight = (this._maskBounds.top - this._maskBounds.bottom) * 0.5
    const textObjectAnchors = this.textObjectScreenTransform.anchors

    textObjectAnchors.left = this.toChildAnchor(this.textViewportBounds.left, maskCenterX, maskHalfWidth)
    textObjectAnchors.right = this.toChildAnchor(this.textViewportBounds.right, maskCenterX, maskHalfWidth)
    textObjectAnchors.bottom = this.toChildAnchor(this.textViewportBounds.bottom, maskCenterY, maskHalfHeight)
    textObjectAnchors.top = this.toChildAnchor(this.textViewportBounds.top, maskCenterY, maskHalfHeight)
  }

  private toChildAnchor(value: number, parentCenter: number, parentHalfSize: number): number {
    return parentHalfSize > 0 ? (value - parentCenter) / parentHalfSize : 0
  }

  private computeMaskOverflowPadding(): vec2 {
    const cursorHeight = this.textManipulationModule.cursorHeight
    this._maskOverflowPadding.x = cursorHeight * MASK_HORIZONTAL_GRAB_HANDLE_OVERFLOW_RATIO
    this._maskOverflowPadding.y = cursorHeight * MASK_VERTICAL_GRAB_HANDLE_OVERFLOW_RATIO
    return this._maskOverflowPadding
  }

  protected markTextDirty(): void {
    if (!this._initialized) return
    this._textDirty = true
    this.batchUpdate()
  }

  /** Schedules a text repaint without reporting a logical text change. */
  protected markTextPresentationDirty(): void {
    if (!this._initialized) return
    this._textPresentationDirty = true
    this.batchUpdate()
  }

  protected markSizeDirty(): void {
    if (!this._initialized) return
    this._sizeDirty = true
    this.batchUpdate()
  }

  protected markFontDirty(): void {
    if (!this._initialized) return
    this._fontDirty = true
    this.batchUpdate()
  }

  protected markFontSizeDirty(): void {
    if (!this._initialized) return
    this._fontSizeDirty = true
    this.batchUpdate()
  }

  protected markTextLayoutDirty(): void {
    if (!this._initialized) return
    this._textLayoutDirty = true
    this.batchUpdate()
  }

  protected markAlignmentDirty(): void {
    if (!this._initialized) return
    this._alignmentDirty = true
    this.batchUpdate()
  }

  protected batchUpdate(): void {
    this._batchUpdateEvent.enabled = true
  }

  /** Appends subclass-owned foreground controls after the base text layer. */
  protected sortAdditionalHierarchy(): void {}

  /** Re-appends a direct owned child with its local transform untouched. */
  protected moveHierarchyChildToForeground(sceneObject: SceneObject | null): void {
    if (!sceneObject || isNull(sceneObject) || sceneObject.getParent() !== this.sceneObject) {
      return
    }

    reappendChild(sceneObject)
  }

  /**
   * Establishes back-to-front Canvas hierarchy order, then appends developer-owned
   * content so it remains in the foreground.
   */
  protected sortHierarchy(): void {
    const contentChildren = [...this.contentChildren]

    this.moveHierarchyChildToForeground(this.asrBottomEdgeObject)
    this.moveHierarchyChildToForeground(this.mask)
    this.moveHierarchyChildToForeground(this.textManipulationObject)
    this.sortAdditionalHierarchy()

    for (const child of contentChildren) {
      if (!isNull(child) && !this.managedSceneObjects.has(child) && child.getParent() === this.sceneObject) {
        reappendChild(child)
      }
    }
  }

  private flushBatchedUpdatesAndUpdateEvent(): void {
    this._batchUpdateEvent.enabled = false
    const canvasBindingDirty = this.canvasBindingDirty
    this.canvasBindingDirty = false
    try {
      this.flushBatchedUpdates()
      if (canvasBindingDirty) {
        this.canvasController?.reconcile()
        // The module's visuals live under our text object. A subtree walker may
        // have invalidated the module before this deferred reconcile ran, so
        // re-resolve it against the Canvas we just settled on.
        this.textManipulationModule?.invalidateCanvasBinding()
      }
    } catch (error) {
      if (canvasBindingDirty) {
        this.canvasBindingDirty = true
      }
      throw error
    } finally {
      this._batchUpdateEvent.enabled = this.hasPendingBatchedUpdates()
    }
  }

  protected hasPendingBatchedUpdates(): boolean {
    return (
      this._sizeDirty ||
      this._fontDirty ||
      this._fontSizeDirty ||
      this._textDirty ||
      this._textPresentationDirty ||
      this._selectionDirty ||
      this._textLayoutDirty ||
      this._alignmentDirty ||
      this.canvasBindingDirty
    )
  }

  /** Creates and registers the mask structure on first demand. */
  protected ensureMaskingComponent(initiallyEnabled: boolean = false): void {
    if (this.maskingComponent && !isNull(this.maskingComponent)) return

    if (this.maskingComponent) {
      this.removeManagedComponent(this.maskingComponent)
    }
    this.maskingComponent = this.mask.createComponent("MaskingComponent")
    this.maskingComponent.enabled = initiallyEnabled
    this.addManagedComponent(this.maskingComponent)
  }

  /** Removes the allocated mask structure on rendering release or terminal teardown. */
  protected destroyMaskingComponent(): void {
    const maskingComponent = this.maskingComponent
    if (!maskingComponent) return

    this.removeManagedComponent(maskingComponent)
    if (!isNull(maskingComponent)) {
      maskingComponent.destroy()
    }
    this.maskingComponent = null
  }

  /**
   * Updates the measured-content contribution to mask demand without changing mask identity.
   */
  protected setTextOverflowRequiresMask(required: boolean): void {
    this._textOverflowRequiresMask = required
    this.applyMaskingComponentState()
  }

  /**
   * Lets overflow-driven subclasses conservatively retain masking until deferred text measurement
   * and layout work has settled. Single-line fields use native truncation while inactive, so their
   * default is false even when a layout update is pending.
   */
  protected shouldKeepMaskingEnabledWhileTextLayoutPending(): boolean {
    return false
  }

  /**
   * Applies runtime mask demand, allocating only on first concrete demand. Once allocated, text,
   * editing, and layout changes only toggle the component; rendering release discards the allocation.
   * @param manipulationActive - Optional prospective manipulation state used to establish masking
   * before edit-mode descendants are activated.
   */
  protected applyMaskingComponentState(
    manipulationActive: boolean = this.textManipulationModule?.active ?? false
  ): void {
    let maskingComponent = this.maskingComponent
    const hasMaskingComponent = maskingComponent !== null && !isNull(maskingComponent)
    const concreteDemand = this._textOverflowRequiresMask || manipulationActive
    // Pending layout only keeps an already-allocated mask active. If a measurement retry proves
    // overflow, TextInputArea promotes that to concrete demand before the next rendered frame.
    const pendingDemand =
      hasMaskingComponent && maskingComponent.enabled && this.shouldKeepMaskingEnabledWhileTextLayoutPending()
    const shouldEnable = this._renderingEnabled && (concreteDemand || pendingDemand)

    if (!hasMaskingComponent && shouldEnable) {
      this.ensureMaskingComponent(true)
      maskingComponent = this.maskingComponent
    }
    if (!maskingComponent || isNull(maskingComponent)) return

    if (maskingComponent.enabled !== shouldEnable) {
      maskingComponent.enabled = shouldEnable
    }
  }

  protected applyTextAlignment(): void {
    switch (this._horizontalTextAlignment) {
      case TextAlignment.Left:
        this.textComponent.horizontalAlignment = HorizontalAlignment.Left
        break
      case TextAlignment.Center:
        this.textComponent.horizontalAlignment = HorizontalAlignment.Center
        break
      case TextAlignment.Right:
        this.textComponent.horizontalAlignment = HorizontalAlignment.Right
        break
    }
  }

  protected applyLayoutChange(layoutUpdate: () => void): boolean {
    if (!this.maskScreenTransform || !this.textObjectScreenTransform || !this.textManipulationModule) {
      layoutUpdate()
      return false
    }

    const maskAnchors = this.maskScreenTransform.anchors
    const maskOffsets = this.maskScreenTransform.offsets
    const textObjectAnchors = this.textObjectScreenTransform.anchors
    const textObjectOffsets = this.textObjectScreenTransform.offsets
    copyRect(maskAnchors, this._previousMaskAnchors)
    copyRect(maskOffsets, this._previousMaskOffsets)
    copyRect(textObjectAnchors, this._previousTextObjectAnchors)
    copyRect(textObjectOffsets, this._previousTextObjectOffsets)

    layoutUpdate()

    const ancestorGeometryChanged =
      !areRectsEqual(maskAnchors, this._previousMaskAnchors) ||
      !areRectsEqual(maskOffsets, this._previousMaskOffsets) ||
      !areRectsEqual(textObjectAnchors, this._previousTextObjectAnchors)
    const textOffsetChanged = !areRectsEqual(textObjectOffsets, this._previousTextObjectOffsets)

    if (ancestorGeometryChanged) {
      this.textManipulationModule.refresh({fromAnchors: true})
      return true
    }
    if (textOffsetChanged) {
      this.textManipulationModule.refresh({fromTextOffset: true})
      return true
    }
    return false
  }

  protected refreshTextGeometryAndLayout(reasons: TextGeometryRefreshReasons): void {
    const shouldRefreshTextMetrics = reasons.fromFont === true || reasons.fromFontSize === true
    const shouldRefreshGeometry =
      reasons.fromAnchors === true || reasons.fromAlignment === true || reasons.fromOverflow === true
    const shouldRefreshLayout =
      reasons.updateTextLayout === true ||
      reasons.fromTextOffset === true ||
      shouldRefreshGeometry ||
      shouldRefreshTextMetrics

    if (shouldRefreshTextMetrics) {
      this.textManipulationModule.refresh({
        fromFont: reasons.fromFont,
        fromFontSize: reasons.fromFontSize
      })
      this.updateSize()
    }

    if (shouldRefreshGeometry) {
      this.textManipulationModule.refresh({
        fromAnchors: reasons.fromAnchors,
        fromAlignment: reasons.fromAlignment,
        fromOverflow: reasons.fromOverflow
      })
    }

    let layoutRefreshed = false
    if (shouldRefreshLayout) {
      layoutRefreshed = this.applyLayoutChange(() => this.updateTextLayout())
    }

    if (reasons.fromTextOffset === true && !layoutRefreshed) {
      this.textManipulationModule.refresh({fromTextOffset: true})
    }
  }

  private scrollToIndex(targetIndex: number): void {
    const now = getTime()
    if (now - this.lastScrollTime < this.scrollCooldownSec) return

    let scrolled = false
    this.applyLayoutChange(() => {
      scrolled = this.updateScrollOffset(targetIndex)
    })

    if (scrolled) {
      this.lastScrollTime = now
    }
  }

  protected flushBatchedUpdates(): void {
    const sizeDirty = this._sizeDirty
    const textDirty = this._textDirty
    const textPresentationDirty = this._textPresentationDirty
    const selectionDirty = this._selectionDirty
    this._sizeDirty = false
    this._fontDirty = false
    this._fontSizeDirty = false
    this._textDirty = false
    this._textPresentationDirty = false
    this._selectionDirty = false

    if (sizeDirty) {
      this.updateSize()
    }
    if (textDirty) {
      this.updateText()
    } else if (textPresentationDirty) {
      this.updateText(false)
    }

    if (selectionDirty && this.isEditing) {
      this.textManipulationModule.setHighlightByCharIndex(
        this.systemKeyboardModule.selectionStart,
        this.systemKeyboardModule.selectionEnd
      )
    }
  }

  protected cancelRequestKeyboard = () => {
    log.d(`cancelling focus request ${this.sceneObject.name}`)
    this.textInputComponentManager.cancelFocusRequest(this)
  }

  protected computeInset(): number {
    return this._size.y * INSET_FACTOR_SINGLE_LINE
  }

  /**
   * Gate the background re-enable to {@link _renderingEnabled}. This class owns the hook, so
   * setting the final state directly here is race-free.
   */
  protected enableVisuals(): void {
    if (this._renderingEnabled) {
      super.enableVisuals()
    } else {
      this.disableVisuals()
    }
  }

  /**
   * Gate the managed-component re-enable to {@link _renderingEnabled}. When released, the component
   * is fully inert: render-gated entries AND interaction components are held at their final
   * disabled state directly - never enable-then-disable, which would let a sub-component's own
   * onEnabled cascade win the race. Only entries that manage their own renderables stay enabled
   * (content components hold theirs via their own persistent flag; the text-manipulation module's
   * `active` flag gates the caret). Restore routes through the base, preserving inactive semantics.
   */
  protected enableManagedComponents(): void {
    // Restore an active editor/overflow mask before managed descendants can become visible.
    // Fitting inputs remain allocation-free because applyMaskingComponentState is demand-lazy.
    this.applyMaskingComponentState()
    for (const {component, disabledWhenInactive} of this.managedComponents) {
      if (isNull(component) || !component || component === this.maskingComponent) {
        continue
      }
      component.enabled = this._renderingEnabled
        ? !(this.inactive && disabledWhenInactive)
        : !disabledWhenInactive && !this.isRenderGatedManagedComponent(component)
    }
  }

  /**
   * VisualElement's visual / hasShadow setters build fresh renderables enabled; re-assert the
   * released state so a theme or shadow swap on a released component stays released.
   */
  public set visual(value: Visual) {
    super.visual = value
    if (!this._renderingEnabled) {
      this.disableVisuals()
    }
  }

  public get visual(): Visual {
    return super.visual
  }

  public set hasShadow(value: boolean) {
    super.hasShadow = value
    if (!this._renderingEnabled) {
      this.disableVisuals()
    }
  }

  public get hasShadow(): boolean {
    return super.hasShadow
  }

  /**
   * Element's inactive setter drives interaction components directly; re-assert full inertness so
   * an inactive toggle on a released component cannot re-arm its collider/interactable.
   */
  public set inactive(value: boolean) {
    super.inactive = value
    if (!this._renderingEnabled) {
      this.enableManagedComponents()
    }
  }

  public get inactive(): boolean {
    return super.inactive
  }

  protected onEnabled(): void {
    super.onEnabled()
    // Do not re-arm voice input on a host re-enable while rendering is released.
    this.setVoiceInputActive(this._renderingEnabled)
    this.invalidateCanvasBinding()
  }

  protected onDisabled(): void {
    this.setVoiceInputActive(false)
    this.stopVoiceInputListeningState()
    super.onDisabled()
  }

  protected release() {
    this.canvasBindingDirty = false
    try {
      this.deregisterVoiceInputButtonForLifecycle()
      if (this.isEditing) {
        this.editMode(false)
      } else {
        this.textInputComponentManager.deregisterActive(this)
      }
      if (this.focusFrameUnsubscribe) {
        this.focusFrameUnsubscribe()
        this.focusFrameUnsubscribe = null
      }
      if (this.focusFrameDockUnsubscribe) {
        this.focusFrameDockUnsubscribe()
        this.focusFrameDockUnsubscribe = null
      }
      this.focusFrameDocked = false
      if (this.focusFrameFollower) {
        // Release our shared reference; the follower is destroyed when the last field
        // referencing this target releases it.
        this.focusFrameFollower.releaseShared()
        this.focusFrameFollower = null
      }
      this.stateCancelSet()
      // Keep the text model consistent at teardown: commit any pending final
      // transcript before cancelling the finish animation that carries it.
      this.flushAsrPendingReveal()
      this.asrVisualSweepRampCancelSet.cancel()
      this.destroyAsrBottomEdge()
      if (this.textBoundingBoxUnsubscribe) {
        this.textBoundingBoxUnsubscribe()
        this.textBoundingBoxUnsubscribe = null
      }
      this.destroyMaskingComponent()
      super.release()
    } finally {
      const canvasController = this.canvasController
      this.canvasController = null
      canvasController?.release()
    }
  }
}

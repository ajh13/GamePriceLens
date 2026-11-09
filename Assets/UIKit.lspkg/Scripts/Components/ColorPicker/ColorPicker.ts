import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import animate, {CancelSet} from "InteractionKit.lspkg/Utils/animate"
import Event, {PublicApi, unsubscribe} from "InteractionKit.lspkg/Utils/Event"
import {clamp} from "InteractionKit.lspkg/Utils/mathUtils"
import ReplayEvent from "InteractionKit.lspkg/Utils/ReplayEvent"
import {
  ColorPickerBackplateRestingColor,
  ColorPickerBackplateStateColors,
  ColorPickerFormatTriggerHoveredColor,
  ColorPickerFormatTriggerRestingColor,
  ColorPickerFormatTriggerToggledColor,
  ColorPickerFormatTriggerTriggeredColor,
  ColorPickerLabelTextColor,
  ColorPickerPanelColor
} from "../../Themes/System-3.0/Colors"
import {CanvasController} from "../../Utility/CanvasController"
import {
  createChildSceneObjectWithParentLayer,
  isBeingDestroyedError,
  isSceneObjectAncestorOf,
  reparentExternalChild,
  unparentExternalChild
} from "../../Utility/SceneUtilities"
import {configureScreenTransformToFillParent, enableDepthOcclusion, isEqual} from "../../Utility/UIKitUtilities"
import {RoundedRectangle, RoundedRectBlendMode} from "../../Visuals/RoundedRectangle/RoundedRectangle"
import {
  applyVisualCornerRadius,
  RoundedRectangleVisual,
  RoundedRectangleVisualParameters
} from "../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {Button} from "../Button/Button"
import {applyContentTextColor, setButtonToggledImmediate} from "../Calendar/CalendarUtilities"
import {ElementContent, TextAlignment} from "../Content/ElementContent"
import {addContentToElement} from "../Content/ElementContentFactory"
import {Dropdown, DropdownOption} from "../Dropdown/Dropdown"
import {StateName} from "../Element"
import {FlexItem} from "../Layout2D/Flex/FlexItem"
import {FlexLayout} from "../Layout2D/Flex/FlexLayout"
import {FlexAlign, FlexDirection, FlexJustify} from "../Layout2D/Flex/FlexTypes"
import {UIKitBrands} from "../Layout2D/UIKitBrands"
import {ColorSlider, ColorSliderMode} from "../Slider/ColorSlider"
import {FONT_SIZE_SCALE, INSET_FACTOR_SINGLE_LINE} from "../TextInput/TextInputConsts"
import {TextInputField} from "../TextInputField/TextInputField"
import {ColorArea} from "./ColorArea"
import {
  FIELD_GLYPH_SAMPLES,
  fitTextSizeToBand,
  GlyphAdvanceProbe,
  measureGlyphAdvanceStep,
  TEXT_FIT_FLOOR,
  worstAlphaPercentWidthPerPoint,
  worstHexWidthPerPoint,
  worstNumericWidthPerPoint
} from "./ColorPickerTextFit"
import {
  areHSVAColorsEqual,
  channelNormalizedValues,
  cloneHSVA,
  ColorPickerChannelSpec,
  ColorPickerFormat,
  colorToHSVA,
  FORMAT_CHANNEL_SPECS,
  FORMAT_OPTIONS,
  formatAlphaPercent,
  formatChannelValue,
  formatColorToHex,
  hexColorKey,
  HSVAColor,
  hsvaToColor,
  hsvaWithChannel,
  hueToSliderValue,
  MAX_CHANNEL_FIELD_COUNT,
  normalizeFormat,
  normalizeHSVA,
  parseAlphaPercent,
  parseChannelValue,
  parseHexColor,
  quantizeAlphaPercent,
  quantizeChannelValue,
  sliderValueToHue
} from "./ColorPickerUtilities"

// Re-exported: the format enum is part of this component's public API.
export {ColorPickerFormat} from "./ColorPickerUtilities"

type ColorPickerPanelState = {
  object: SceneObject | null
  transform: Transform | null
  rectangle: RoundedRectangle | null
  position: vec3
  size: vec2
}

/**
 * The row backplate plus its animated tint. `displayColor` is what the
 * plate currently shows; `targetColor` is where it is heading.
 */
type ColorPickerBackplateState = ColorPickerPanelState & {
  displayColor: vec4
  targetColor: vec4
  cancelSet: CancelSet
}

type ColorPickerSwatchState = {
  object: SceneObject | null
  button: Button | null
  visual: RoundedRectangleVisual | null
  flexItem: FlexItem | null
  ready: boolean
  // Latest interaction state of the swatch button, mirrored onto the row
  // backplate (see updateBackplateColor).
  stateName: StateName
  buttonSize: vec3
}

/**
 * The field row's flex container. Item membership follows the selected
 * format (see applyFormatToRow); `activeItems` is what is currently added,
 * Calendar-style, so a format switch can remove exactly what it added.
 */
type ColorPickerRowState = {
  object: SceneObject | null
  layout: FlexLayout | null
  activeItems: FlexItem[]
}

type ColorPickerDropdownState = {
  object: SceneObject | null
  dropdown: Dropdown | null
  flexItem: FlexItem | null
  // Custom trigger (see createFormatDropdown): the picker owns the button,
  // its label/chevron content, and its size, since a generated trigger
  // would carry a theme preset's border.
  triggerButton: Button | null
  triggerContent: ElementContent | null
  triggerSize: vec3
  // Label content of each drawer-option plate, captured as the Dropdown
  // binds it (see the onBindItem hook). Retained — not just configured and
  // forgotten — because option padding has to be re-scaled on every resize
  // alongside the plate widths it is subtracted from, and onBindItem only
  // fires on setData and on scroll, never on drawer open. Dropdown-owned
  // pooled objects, so these are references to release, not children.
  optionContents: Map<Button, ElementContent>
  // Authored depth-write policy per pool button, captured on first fade
  // write so applyFormatOptionDepthWrite can restore it at full opacity.
  itemDepthWriteCache: Map<Button, boolean>
}

type ColorPickerFormatState = {
  mode: ColorPickerFormat
  // A programmatic write landed (the interesting case is before start):
  // initialize() keeps it instead of seeding from the inspector default.
  explicitlySet: boolean
}

type ColorPickerFieldState = {
  object: SceneObject | null
  field: TextInputField | null
  flexItem: FlexItem | null
  ready: boolean
  editing: boolean
  // Text captured when an edit session opens, so a session the user never
  // typed in can end without committing (see subscribeTextField).
  textAtEditStart: string | null
  // The last canonical string the picker wrote to the field (see
  // writeFieldText); null until the first write. The field's echo of a
  // programmatic write is recognized by comparing against this.
  canonicalText: string | null
  // The quantized display value behind canonicalText (a rounded channel,
  // an alpha percent, or packed hex bytes); NaN until the first write and
  // after invalidateCellCache. Lets the refresh skip rebuilding a string
  // the field already shows (see isCellCurrent).
  displayKey: number
  fieldSize: vec3
}

type ColorPickerAreaState = {
  object: SceneObject | null
  transform: Transform | null
  area: ColorArea | null
  ready: boolean
  position: vec3
}

type ColorPickerSliderState = {
  object: SceneObject | null
  transform: Transform | null
  slider: ColorSlider | null
  ready: boolean
  position: vec3
}

type ColorPickerPopupState = {
  object: SceneObject | null
  transform: Transform | null
  expanded: boolean
  position: vec3
}

type ColorPickerColorState = {
  hsva: HSVAColor
  // True while the picker pushes the canonical color into its controls, so
  // their change events can be told apart from user interaction.
  applyingToControls: boolean
  // A programmatic write landed (the interesting case is before start):
  // initialize() keeps it instead of seeding from the inspector default.
  explicitlySet: boolean
}

/**
 * Tracks whether the selected color is still being dragged, so
 * {@link ColorPicker.onColorCommitted} can fire once per settled change
 * instead of once per frame.
 */
type ColorPickerCommitState = {
  // Counted, not a flag: the area and the two sliders are independently
  // draggable, so two interactors can hold two controls at once and the
  // commit must wait for the last release.
  activeDragCount: number
  // A change arrived while a drag was live, so the release owes a commit.
  // Stays false for a drag that never moved the value, which then settles
  // silently.
  pendingCommit: boolean
}

type ColorPickerLifecycleState = {
  renderOrder: number
  initialized: boolean
  initializedEventFired: boolean
  releasing: boolean
}

type ColorPickerChildrenState = {
  container: SceneObject | null
  pendingAuthored: SceneObject[] | null
  ownedRootObjects: Set<SceneObject>
}

type ColorPickerBatchState = {
  canvasBindingDirty: boolean
  layoutDirty: boolean
  updateEvent: SceneEvent | null
}

// "field": a single glyph measured on the alpha field's Text (the value
// fields share its font), as an advance in two halves that may land on
// different flushes (see measureGlyphAdvanceStep). "label": a whole format
// label measured on the trigger content's Text (the drawer options share
// its font and style).
type ColorPickerTextProbe = ({target: "field"} & GlyphAdvanceProbe) | {target: "label"; sample: string}

/**
 * The measured inputs and current output of the label text fit (see
 * computeFittedTextSize). Widths are centimeters per font point, measured
 * from the picker's own live Text components — real glyph measurement,
 * never an estimate. Measurements drain greedily at boot and on each
 * batched flush (see drainTextFitProbes); anything the engine's
 * rate-limited getBoundingBox refuses retries on a later flush, with
 * `appliedSize` holding the floor until every needed width exists — so
 * labels may step up from the floor once, but are never clipped in
 * transit.
 */
type ColorPickerTextFitState = {
  fieldGlyphWidths: Map<string, number>
  labelWidths: Map<string, number>
  pendingProbes: ColorPickerTextProbe[]
  appliedSize: number
}

type ColorPickerSubscriptionsState = {
  unsubscribes: unsubscribe[]
}

type ColorPickerState = {
  children: ColorPickerChildrenState
  backplate: ColorPickerBackplateState
  panel: ColorPickerPanelState
  row: ColorPickerRowState
  swatch: ColorPickerSwatchState
  formatDropdown: ColorPickerDropdownState
  format: ColorPickerFormatState
  hexField: ColorPickerFieldState
  channelFields: ColorPickerFieldState[]
  alphaField: ColorPickerFieldState
  area: ColorPickerAreaState
  hueSlider: ColorPickerSliderState
  alphaSlider: ColorPickerSliderState
  popup: ColorPickerPopupState
  color: ColorPickerColorState
  commit: ColorPickerCommitState
  lifecycle: ColorPickerLifecycleState
  batch: ColorPickerBatchState
  textFit: ColorPickerTextFitState
  subscriptions: ColorPickerSubscriptionsState
}

function createFieldCellState(): ColorPickerFieldState {
  return {
    object: null,
    field: null,
    flexItem: null,
    ready: false,
    editing: false,
    textAtEditStart: null,
    canonicalText: null,
    displayKey: NaN,
    fieldSize: vec3.zero()
  }
}

const POPUP_OBJECT_NAME = "ColorPickerPopup"
const BACKPLATE_OBJECT_NAME = "ColorPickerFieldBackplate"
const PANEL_OBJECT_NAME = "ColorPickerPanel"
const FIELD_ROW_OBJECT_NAME = "ColorPickerFieldRow"
const SWATCH_OBJECT_NAME = "ColorPickerSwatch"
const FORMAT_DROPDOWN_OBJECT_NAME = "ColorPickerFormatDropdown"
const FORMAT_TRIGGER_OBJECT_NAME = "ColorPickerFormatTrigger"
const HEX_FIELD_OBJECT_NAME = "ColorPickerHexField"
const CHANNEL_FIELD_OBJECT_NAME_PREFIX = "ColorPickerChannelField"
const ALPHA_FIELD_OBJECT_NAME = "ColorPickerAlphaField"
const COLOR_AREA_OBJECT_NAME = "ColorPickerArea"
const HUE_SLIDER_OBJECT_NAME = "ColorPickerHueSlider"
const ALPHA_SLIDER_OBJECT_NAME = "ColorPickerAlphaSlider"
const CHILDREN_CONTAINER_OBJECT_NAME = "ChildrenContainer"

const HEX_FIELD_PLACEHOLDER = "FFFFFF"
const ALPHA_FIELD_PLACEHOLDER = "100%"

// Reference metrics in centimeters; horizontal metrics scale with the
// picker's width and panel-vertical metrics with the panel height (see
// widthScale / panelHeightScale). Knob sizes ride the panel height too,
// with the tracks they sit on, so a knob keeps its proportion to its track
// and its shape at any panel height (see areaKnobSize). Exception:
// REFERENCE_PANEL_PADDING is width-scaled but spent on both axes, keeping
// the panel inset uniform on all four edges.
// Text sizes anchor to the default size at the reference geometry and
// scale with the smaller of the width and field-height scales (see
// fieldTextCap), FITTED down further whenever a cell's width would
// otherwise wrap or clip its label (see computeFittedTextSize).
// The reference proportions are measured from
// the design spec: the field row is 0.15x the width, and the panel height
// is the one that makes the saturation/value area an exact square.
const REFERENCE_WIDTH = 28
const REFERENCE_PANEL_HEIGHT = 36
// The field-row geometry the text baseline anchors to: at width 28 and
// field height 3.5 every label renders at the default text size (see
// fieldTextCap), and the size expands/shrinks from there with the picker.
const REFERENCE_FIELD_HEIGHT = 3.5
// Tight enough that CMYK's four channel fields keep room for three-digit
// values inside the fields' own text insets.
const REFERENCE_CONTROL_GAP = 0.6
const REFERENCE_PANEL_PADDING = 0.65
const REFERENCE_SLIDER_HEIGHT = 2.5
const REFERENCE_SLIDER_GAP = 1.5
// Shared by the trigger button and the drawer, so the two read as one
// control. The floor is the drawer's option text: its band is this less
// the drawer's own side padding, and "CMYK" wraps below roughly 4.5cm of
// band — so narrowing this further needs a smaller option text size.
const REFERENCE_FORMAT_DROPDOWN_WIDTH = 5.5
const REFERENCE_ALPHA_FIELD_WIDTH = 4
const REFERENCE_AREA_KNOB_SIZE = 1.4
const REFERENCE_SLIDER_KNOB_WIDTH = 2
const REFERENCE_SLIDER_KNOB_HEIGHT = 3.1

// Hue span mapped across the hue slider. Deliberately short of the full
// 360° wrap so the two ends select distinct hues (left red, right
// rose-pink) instead of both wrapping to red. Hues past the span — pasted
// hex entries in the 330-360° crimson tail — stay in the color state; only
// the slider knob clamps to the track end while they're selected.
const HUE_SLIDER_RANGE_DEGREES = 330

// Hue and alpha.
const SLIDER_ROW_COUNT = 2

const MIN_SIZE_SCALE = 0.01
const MIN_CONTENT_SIZE = 0.001
// Inset between the row backplate's edges and the controls resting on it,
// as a fraction of the row height (applied on every side).
const ROW_PADDING_FACTOR = 0.11
// Corner radii as fractions of the height they belong to, so the silhouette
// keeps the spec's proportions at any size. The row backplate and the popup
// panel share one radius (they read as the same plate in the spec); the
// swatch and the inset fields are rounder relative to their smaller height.
const PLATE_CORNER_RADIUS_FACTOR = 0.13
const SWATCH_CORNER_RADIUS_FACTOR = 0.21
const FIELD_CORNER_RADIUS_FACTOR = 0.15
const FIELD_DEPTH = 1
const AREA_DEPTH = 1
// Vertical gap between the field row and the popup panel at the reference
// geometry, in centimeters; scaled by the field-height scale when applied
// (see updatePopupLayout).
const POPUP_VERTICAL_GAP = 0.75
// The panel writes depth, as do the controls resting on it; sit the panel
// just behind them so coplanar surfaces can't z-fight (Calendar separates
// its cells from its background the same way).
const PANEL_Z_OFFSET = -0.05
// The format dropdown sits slightly forward of the row plane so its
// depth-tested drawer (drawn at the dropdown's z − 0.2) still lands in
// front of the expanded popup panel and its controls when it opens over
// them. Small enough that the trigger's perspective skew is invisible.
const DROPDOWN_Z_OFFSET = 0.25

const CHEVRON_DOWN: Texture = requireAsset("Icons.lspkg/Iconography/Arrows/chevron-down.png") as Texture
const CHEVRON_UP: Texture = requireAsset("Icons.lspkg/Iconography/Arrows/chevron-up.png") as Texture
// Chevron size at the Dropdown's reference text size; scaled proportionally.
const CHEVRON_BASE_SIZE = 1.5
const CHEVRON_BASE_TEXT_SIZE = 60

// Label-content paddings and gaps at the reference geometry — the stock
// ElementContent / Dropdown defaults, so the reference rendering is
// unchanged — scaled proportionally with the picker: side paddings and
// the icon gap with the width, vertical paddings and the drawer row gap
// with the field height. Fixed values would starve the label bands at
// narrow sizes (at width 16 fixed overhead eats two thirds of the trigger
// plate, pinning the fitted text at its floor long before the geometry
// demands it) and read oversized on a large picker.
const REFERENCE_CONTENT_SIDE_PADDING = 0.8
const REFERENCE_CONTENT_VERTICAL_PADDING = 0.5
const REFERENCE_CONTENT_SPACING = 0.5
// Drawer plate inset (x/y) and row gap at the reference geometry — the
// Dropdown defaults. Applied at creation only: they are part of the pool
// geometry, which is frozen when the pool is built (see optionPlateWidth).
const REFERENCE_DRAWER_PADDING = 0.5
const REFERENCE_DRAWER_ITEM_SPACING = 0.5

/**
 * Format-dropdown trigger plate: borderless in every state and transparent
 * at rest, so the row backplate shows through. Hover and press fill with
 * the shared input-surface tints, matching TextInputField's own state
 * backgrounds (TEXT_INPUT_VISUAL_STYLE) so the trigger and the value
 * fields beside it read as one control — the row backplate tracks the
 * SWATCH button rather than this one, so this plate is the trigger's only
 * state feedback. The trigger is toggleable, with `isOn` pinned to the
 * drawer's expanded state, so the toggled states are the open look and
 * hold #3D4242 throughout.
 */
const FormatTriggerVisualParameters: Partial<RoundedRectangleVisualParameters> = {
  default: {baseType: "Color", baseColor: ColorPickerFormatTriggerRestingColor, hasBorder: false},
  hovered: {baseType: "Color", baseColor: ColorPickerFormatTriggerHoveredColor, hasBorder: false},
  triggered: {baseType: "Color", baseColor: ColorPickerFormatTriggerTriggeredColor, hasBorder: false},
  toggledDefault: {baseType: "Color", baseColor: ColorPickerFormatTriggerToggledColor, hasBorder: false},
  toggledHovered: {baseType: "Color", baseColor: ColorPickerFormatTriggerToggledColor, hasBorder: false},
  toggledTriggered: {baseType: "Color", baseColor: ColorPickerFormatTriggerToggledColor, hasBorder: false},
  inactive: {baseType: "Color", baseColor: ColorPickerFormatTriggerRestingColor, hasBorder: false}
}

const SwatchBorderTop = new vec4(0.45, 0.45, 0.45, 0.6)
const SwatchBorderBottom = new vec4(0.25, 0.25, 0.25, 0.3)

// Swatch button. The fill is updated at runtime from the selected color
// (shouldColorChange = false) while the border keeps animating on
// hover/trigger so the swatch reads as tappable; the row backplate carries
// the state background (see updateBackplateColor and
// ColorPickerBackplateStateColors).
const SwatchVisualParameters: Partial<RoundedRectangleVisualParameters> = {
  default: {
    baseType: "Color",
    baseColor: new vec4(1, 0, 0, 1),
    hasBorder: true,
    borderSize: 0.07,
    borderType: "Gradient",
    borderGradient: {
      type: "Linear",
      start: new vec2(-0.8, 1),
      end: new vec2(0.8, -1),
      stop0: {percent: 0, color: SwatchBorderTop},
      stop1: {percent: 1, color: SwatchBorderBottom}
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
 * A field-style color picker composing a {@link ColorArea}, hue and alpha
 * {@link ColorSlider}s, and hex / alpha-percent {@link TextInputField}s.
 *
 * The picker rests in a compact field row on a shared backplate — a swatch
 * button previewing the selected color, a format {@link Dropdown} (Hex,
 * RGB, HSB, CMYK), the format's value field(s), and an alpha percentage
 * field. Hex shows one hex text field; the other formats show one numeric
 * field per channel (RGB 0-255, HSB 360/100/100, CMYK percentages). The
 * row is a {@link FlexLayout}: the value fields share the width the rigid
 * controls leave over.
 * Tapping the swatch — the sole expansion trigger — toggles a popup
 * panel below the row holding the saturation/value area, a hue rainbow
 * slider, and an alpha transparent-to-color slider. The popup overlays
 * content below the row: {@link computeContentSize} reports only the
 * field row.
 *
 * The canonical color state is HSVA so hue and saturation stay stable while
 * dragging through black or gray. Every input path — area, sliders, text
 * fields, and the public setters — funnels into the same state, and
 * {@link onColorChanged} fires with the new RGBA color on any change.
 * {@link onColorCommitted} reports the same changes coalesced per settled
 * value, so a drag notifies once on release instead of every frame.
 *
 * Text field entries commit on Return and when editing ends (the close
 * re-commits only text changed after the Return); invalid entries revert
 * to the canonical formatting when editing ends. Hex entries accept an
 * optional leading "#"
 * and 3, 4, 6, or 8 hex digits, and preserve the current alpha unless alpha
 * digits are provided.
 *
 * The numeric fields also step by drag: a sideways drag on a channel or the
 * alpha field changes its last digit per step (TextInputField's
 * drag-to-adjust), committing through the same parse as a typed entry; the
 * alpha field keeps its "%" across steps. A drag that stepped does not open
 * the keyboard on release.
 *
 * @example
 * ```typescript
 * const colorPicker = sceneObject.createComponent(ColorPicker.getTypeName()) as ColorPicker;
 * colorPicker.onColorChanged.add((color) => {
 *   print(`Selected: ${color}`);
 * });
 * ```
 *
 * @see {@link ColorArea} - The embedded saturation/value picking area
 * @see {@link ColorSlider} - The embedded hue and alpha sliders
 */
@component
export class ColorPicker extends BaseScriptComponent {
  public readonly __uikitBrand = UIKitBrands.LayoutContainer

  // ─── Size ───────────────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Size</span>')
  @input
  @label("Width")
  @hint("Width of the field row and the expanded popup panel, in centimeters.")
  private _width: number = 28

  @input
  @label("Field Height")
  @hint("Height of the field-row backplate; the controls sit inset within it.")
  private _fieldHeight: number = REFERENCE_FIELD_HEIGHT

  @input
  @label("Panel Height")
  @hint("Height of the expanded popup panel below the field row.")
  private _panelHeight: number = 36

  // ─── Color ──────────────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Color</span>')
  @input
  @label("Default Color")
  @widget(new ColorWidget())
  private _defaultColor: vec4 = new vec4(1, 0, 0, 1)

  @input
  @label("Default Format")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Hex", "Hex"),
      new ComboBoxItem("RGB", "RGB"),
      new ComboBoxItem("HSB", "HSB"),
      new ComboBoxItem("CMYK", "CMYK")
    ])
  )
  @hint("Value-field format the picker opens with; the format dropdown switches it at runtime.")
  private _defaultFormat: string = "Hex"

  // ─── Internal State ─────────────────────────────────────────────────

  private canvasController: CanvasController | null = null
  private readonly canvasSize: vec2 = vec2.zero()

  private readonly state: ColorPickerState = {
    children: {
      container: null,
      pendingAuthored: null,
      ownedRootObjects: new Set<SceneObject>()
    },
    backplate: {
      object: null,
      transform: null,
      rectangle: null,
      position: vec3.zero(),
      size: vec2.zero(),
      displayColor: ColorPickerBackplateRestingColor.clone(),
      targetColor: ColorPickerBackplateRestingColor.clone(),
      cancelSet: new CancelSet()
    },
    panel: {
      object: null,
      transform: null,
      rectangle: null,
      position: vec3.zero(),
      size: vec2.zero()
    },
    row: {
      object: null,
      layout: null,
      activeItems: []
    },
    swatch: {
      object: null,
      button: null,
      visual: null,
      flexItem: null,
      ready: false,
      stateName: StateName.default,
      buttonSize: vec3.zero()
    },
    formatDropdown: {
      object: null,
      dropdown: null,
      flexItem: null,
      triggerButton: null,
      triggerContent: null,
      triggerSize: vec3.zero(),
      optionContents: new Map(),
      itemDepthWriteCache: new Map()
    },
    format: {
      mode: ColorPickerFormat.Hex,
      explicitlySet: false
    },
    hexField: createFieldCellState(),
    channelFields: Array.from({length: MAX_CHANNEL_FIELD_COUNT}, () => createFieldCellState()),
    alphaField: createFieldCellState(),
    area: {
      object: null,
      transform: null,
      area: null,
      ready: false,
      position: vec3.zero()
    },
    hueSlider: {
      object: null,
      transform: null,
      slider: null,
      ready: false,
      position: vec3.zero()
    },
    alphaSlider: {
      object: null,
      transform: null,
      slider: null,
      ready: false,
      position: vec3.zero()
    },
    popup: {
      object: null,
      transform: null,
      expanded: false,
      position: vec3.zero()
    },
    color: {
      hsva: {hue: 0, saturation: 1, value: 1, alpha: 1},
      applyingToControls: false,
      explicitlySet: false
    },
    commit: {
      activeDragCount: 0,
      pendingCommit: false
    },
    lifecycle: {
      renderOrder: 0,
      initialized: false,
      initializedEventFired: false,
      releasing: false
    },
    batch: {
      canvasBindingDirty: false,
      layoutDirty: false,
      updateEvent: null
    },
    textFit: {
      fieldGlyphWidths: new Map(),
      labelWidths: new Map(),
      pendingProbes: [],
      appliedSize: TEXT_FIT_FLOOR
    },
    subscriptions: {
      unsubscribes: []
    }
  }

  // ─── Events ─────────────────────────────────────────────────────────

  private readonly events = {
    initialized: new ReplayEvent<void>(),
    colorChanged: new Event<vec4>(),
    colorCommitted: new Event<vec4>(),
    expandedChanged: new ReplayEvent<boolean>()
  }

  /**
   * Event fired once the picker and its embedded controls are built.
   * Replays to late subscribers.
   */
  public readonly onInitialized: PublicApi<void> = this.events.initialized.publicApi()

  /**
   * Event fired whenever the selected color changes — from the area, the
   * sliders, the text fields, or the public setters. The event payload is
   * the new RGBA color.
   */
  public readonly onColorChanged: PublicApi<vec4> = this.events.colorChanged.publicApi()

  /**
   * Event fired when the selected color settles, with the new RGBA color.
   * The same changes as {@link onColorChanged}, coalesced: a drag on the
   * saturation/value area, either slider, or a numeric value field
   * (TextInputField's drag-to-adjust, which steps the value as the drag
   * travels) fires this once on release rather than every frame. Typed
   * text-field entries and the public setters — already discrete — fire
   * it immediately, unless a drag is in flight: any change landing
   * mid-drag folds into the release commit. A drag that ends without
   * having moved the color fires nothing.
   *
   * Prefer this over {@link onColorChanged} for work that shouldn't run
   * per frame — persisting a setting, a network write, rebuilding an
   * asset. Use {@link onColorChanged} for live preview.
   */
  public readonly onColorCommitted: PublicApi<vec4> = this.events.colorCommitted.publicApi()

  /**
   * Event fired when the picker popup expands or collapses.
   * The event payload is `true` when the popup is open. Replays to late subscribers.
   */
  public readonly onExpandedChanged: PublicApi<boolean> = this.events.expandedChanged.publicApi()

  // ─── Public Properties ──────────────────────────────────────────────

  /**
   * Gets the width of the field row and popup panel in centimeters.
   * @returns The width in centimeters.
   */
  public get width(): number {
    return this._width
  }

  /**
   * Sets the width of the field row and popup panel.
   * Triggers a batched layout update at the end of the frame.
   * @param value - The width in centimeters.
   */
  public set width(value: number) {
    if (value === undefined || isEqual(value, this._width)) return
    this._width = value
    this.markLayoutDirty()
  }

  /**
   * Gets the layout height — an alias of {@link fieldHeight}. Only the
   * compact field row counts toward layout; the popup panel overlays
   * content below it.
   * @returns The field row height in centimeters.
   */
  public get height(): number {
    return this._fieldHeight
  }

  /**
   * Sets the layout height — an alias of {@link fieldHeight}, present so
   * parent Layout2D containers can assign the resolved height back. The
   * reported measurement is rigid, so this normally receives the same
   * value {@link computeContentSize} returned.
   * @param value - The field row height in centimeters.
   */
  public set height(value: number) {
    this.fieldHeight = value
  }

  /**
   * Gets the height of the field row in centimeters.
   * @returns The field row height in centimeters.
   */
  public get fieldHeight(): number {
    return this._fieldHeight
  }

  /**
   * Sets the height of the field row.
   * Triggers a batched layout update at the end of the frame.
   * @param value - The field row height in centimeters.
   */
  public set fieldHeight(value: number) {
    if (value === undefined || isEqual(value, this._fieldHeight)) return
    this._fieldHeight = value
    this.markLayoutDirty()
  }

  /**
   * Gets the height of the expanded popup panel in centimeters.
   * @returns The popup panel height in centimeters.
   */
  public get panelHeight(): number {
    return this._panelHeight
  }

  /**
   * Sets the height of the expanded popup panel.
   * Triggers a batched layout update at the end of the frame.
   * @param value - The popup panel height in centimeters.
   */
  public set panelHeight(value: number) {
    if (value === undefined || isEqual(value, this._panelHeight)) return
    this._panelHeight = value
    this.markLayoutDirty()
  }

  /**
   * Gets whether the picker popup is open.
   * @returns True while the popup is open.
   */
  public get expanded(): boolean {
    return this.state.popup.expanded
  }

  /**
   * Gets the value-field format.
   * @returns The current format.
   */
  public get format(): ColorPickerFormat {
    return this.state.format.mode
  }

  /**
   * Sets the value-field format: Hex shows the single hex text field, the
   * other formats show one numeric field per channel. The selected color is
   * unaffected. A write that lands before the component starts is kept — the
   * Default Format input seeds only untouched state.
   * @param value - The format to show.
   */
  public set format(value: ColorPickerFormat) {
    if (value === undefined || FORMAT_OPTIONS.indexOf(value) < 0) return
    // Marked before the equality return: a pre-start write equal to the
    // constructor default still claims the format over the inspector input.
    this.state.format.explicitlySet = true
    if (value === this.state.format.mode) return

    // Live edit sessions must not survive the switch, and must be ended
    // while the OLD format is still current (see the helper's doc).
    this.discardFormatFieldEditSessions()
    this.state.format.mode = value
    if (!this.state.lifecycle.initialized) return

    const cell = this.state.formatDropdown
    if (cell.triggerContent) {
      cell.triggerContent.text = value
    }
    if (cell.dropdown) {
      // selectDataAt fires onSelectionChanged (not onItemTapped), so a
      // programmatic format change can't loop back through the tap handler.
      cell.dropdown.selectDataAt(FORMAT_OPTIONS.indexOf(value))
    }
    this.applyFormatToRow()
    this.refreshFieldTexts()
  }

  /**
   * Gets the selected color.
   * @returns The selected RGBA color.
   */
  public get selectedColor(): vec4 {
    return hsvaToColor(this.state.color.hsva)
  }

  /**
   * Sets the selected color. Grayscale colors preserve the current hue and
   * black preserves the current saturation, so the controls don't snap.
   * @param color - The RGBA color to select.
   */
  public set selectedColor(color: vec4) {
    if (color === undefined || color === null) return
    this.setHSVA(colorToHSVA(color, this.state.color.hsva))
  }

  /**
   * Gets the selected hue in degrees.
   * @returns The hue in degrees [0, 360].
   */
  public get hue(): number {
    return this.state.color.hsva.hue
  }

  /**
   * Sets the selected hue.
   * @param value - The hue in degrees [0, 360].
   */
  public set hue(value: number) {
    if (value === undefined || !isFinite(value)) return
    this.setHSVA({...cloneHSVA(this.state.color.hsva), hue: value})
  }

  /**
   * Gets the selected saturation.
   * @returns The saturation in [0, 1].
   */
  public get saturation(): number {
    return this.state.color.hsva.saturation
  }

  /**
   * Sets the selected saturation.
   * @param value - The saturation in [0, 1].
   */
  public set saturation(value: number) {
    if (value === undefined || !isFinite(value)) return
    this.setHSVA({...cloneHSVA(this.state.color.hsva), saturation: value})
  }

  /**
   * Gets the selected value (brightness).
   * @returns The value in [0, 1].
   */
  public get value(): number {
    return this.state.color.hsva.value
  }

  /**
   * Sets the selected value (brightness).
   * @param value - The value in [0, 1].
   */
  public set value(value: number) {
    if (value === undefined || !isFinite(value)) return
    this.setHSVA({...cloneHSVA(this.state.color.hsva), value: value})
  }

  /**
   * Gets the selected alpha.
   * @returns The alpha in [0, 1].
   */
  public get alpha(): number {
    return this.state.color.hsva.alpha
  }

  /**
   * Sets the selected alpha.
   * @param value - The alpha in [0, 1].
   */
  public set alpha(value: number) {
    if (value === undefined || !isFinite(value)) return
    this.setHSVA({...cloneHSVA(this.state.color.hsva), alpha: value})
  }

  /**
   * Gets the base render order shared by all picker-owned visuals. Their
   * relative draw order is determined by the SceneObject hierarchy.
   * @returns The base render order.
   */
  public get renderOrder(): number {
    return this.state.lifecycle.renderOrder
  }

  /**
   * Sets the base render order and propagates it to all picker parts.
   * @param value - The base render order.
   */
  public set renderOrder(value: number) {
    if (value === undefined || isEqual(value, this.state.lifecycle.renderOrder)) return
    this.state.lifecycle.renderOrder = value
    if (this.state.lifecycle.initialized) {
      this.updateRenderOrder(value)
    }
  }

  /**
   * Gets the embedded saturation/value area — an escape hatch for advanced
   * configuration. Null before {@link onInitialized}.
   * @returns The embedded ColorArea component, or null.
   */
  public get colorArea(): ColorArea | null {
    return this.state.area.area
  }

  /**
   * Gets the embedded hue slider — an escape hatch for advanced
   * configuration. Null before {@link onInitialized}.
   * @returns The embedded hue ColorSlider component, or null.
   */
  public get hueSlider(): ColorSlider | null {
    return this.state.hueSlider.slider
  }

  /**
   * Gets the embedded alpha slider — an escape hatch for advanced
   * configuration. Null before {@link onInitialized}.
   * @returns The embedded alpha ColorSlider component, or null.
   */
  public get alphaSlider(): ColorSlider | null {
    return this.state.alphaSlider.slider
  }

  /**
   * Gets the embedded hex text field — an escape hatch for advanced
   * configuration. Null before {@link onInitialized}.
   * @returns The embedded hex TextInputField component, or null.
   */
  public get hexField(): TextInputField | null {
    return this.state.hexField.field
  }

  /**
   * Gets the developer-managed content children of this picker.
   *
   * After initialization, the children are hosted by the foreground
   * `ChildrenContainer`; before initialization and after teardown, this falls
   * back to the root's unmanaged children.
   */
  public get contentChildren(): SceneObject[] {
    const childrenContainer = this.getChildrenContainer()
    return childrenContainer
      ? childrenContainer.children.filter((child) => !this.state.children.ownedRootObjects.has(child))
      : this.getRootContentChildren()
  }

  /**
   * Gets the number of developer-managed content children of this picker.
   */
  public get contentChildrenCount(): number {
    return this.contentChildren.length
  }

  /**
   * Gets the developer-managed children of this picker.
   *
   * After initialization, these are the direct children of the foreground
   * `ChildrenContainer`. Before initialization, they are the authored root
   * children that will be moved into that container.
   */
  public get children(): SceneObject[] {
    return this.contentChildren
  }

  /**
   * Gets a developer-managed child by index.
   * @param index - Zero-based child index.
   * @returns The child, or null when the index is invalid.
   */
  public getChild(index: number): SceneObject | null {
    if (!Number.isInteger(index) || index < 0) {
      return null
    }

    const children = this.children
    return index < children.length ? children[index] : null
  }

  /**
   * Gets the number of developer-managed children.
   * @returns The child count.
   */
  public getChildrenCount(): number {
    return this.children.length
  }

  /**
   * Schedules the inherited Canvas binding to be re-evaluated before
   * rendering. Call this after reparenting the picker or changing ancestor
   * Canvas topology or configuration through raw Lens APIs. A live locally
   * managed Canvas remains authoritative and is not replaced by an ancestor
   * Canvas.
   */
  public invalidateCanvasBinding(): void {
    if (!this.canvasController) {
      return
    }

    this.canvasController.invalidate()
    if (!this.state.lifecycle.initialized) {
      return
    }

    this.state.batch.canvasBindingDirty = true
    this.batchUpdate()
  }

  /**
   * Adds a developer-owned SceneObject to the foreground children container.
   * Before initialization, the object is added to the root and is captured by
   * the children container during initialization.
   * Non-ScreenTransform children retain their world position, rotation, and scale.
   * @param sceneObject - The SceneObject to add.
   */
  public addChild(sceneObject: SceneObject): void {
    const parent = this.getChildrenParent()
    if (
      !parent ||
      isNull(sceneObject) ||
      this.state.children.ownedRootObjects.has(sceneObject) ||
      isSceneObjectAncestorOf(sceneObject, parent) ||
      sceneObject.getParent() === parent
    ) {
      return
    }

    reparentExternalChild(sceneObject, parent)
  }

  /**
   * Removes a direct developer-managed child without destroying it. Non-ScreenTransform
   * children retain their world position, rotation, and scale.
   * @param sceneObject - The SceneObject to remove.
   */
  public removeChild(sceneObject: SceneObject): void {
    const parent = this.getChildrenParent()
    if (
      !parent ||
      isNull(sceneObject) ||
      this.state.children.ownedRootObjects.has(sceneObject) ||
      sceneObject.getParent() !== parent
    ) {
      return
    }

    unparentExternalChild(sceneObject)
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /** Opens the picker popup. */
  public expand(): void {
    this.setExpanded(true)
  }

  /** Closes the picker popup. */
  public collapse(): void {
    this.setExpanded(false)
  }

  /** Toggles the picker popup. */
  public toggle(): void {
    this.setExpanded(!this.state.popup.expanded)
  }

  /**
   * Sets the selected hue, saturation, value, and alpha in a single pass,
   * firing at most one {@link onColorChanged} event — and one
   * {@link onColorCommitted} unless a drag is in flight, in which case the
   * commit is deferred to the release. A write that lands before the
   * component starts (through this or any color setter) is kept — the
   * Default Color input seeds only untouched state.
   * @param hsva - The HSVA color to select; every channel is clamped to its
   * valid range.
   */
  public setHSVA(hsva: HSVAColor): void {
    const normalized = normalizeHSVA(hsva)
    // Marked before the equality return: a pre-start write equal to the
    // constructor default still claims the color over the inspector input.
    this.state.color.explicitlySet = true
    if (areHSVAColorsEqual(this.state.color.hsva, normalized)) return

    this.state.color.hsva = normalized
    if (this.state.lifecycle.initialized) {
      this.applyColorToControls()
    }
    const color = this.selectedColor
    this.events.colorChanged.invoke(color)
    // A changed-subscriber may write the color back (clamp, quantize,
    // snap-to-palette), re-entering setHSVA during the invoke above. The
    // nested call owns the settled value's commit then — this frame's
    // change was superseded, and committing it too would duplicate the
    // settled value (the docs promise one commit per settled value).
    if (!areHSVAColorsEqual(this.state.color.hsva, normalized)) return
    // Text-field commits and programmatic writes are already discrete, so
    // they settle immediately; a value arriving mid-drag waits for the
    // release (see handleControlDragEnd).
    if (this.state.commit.activeDragCount > 0) {
      this.state.commit.pendingCommit = true
    } else {
      // Fresh read (not the pre-invoke snapshot), matching
      // handleControlDragEnd — under the guard above the two are equal,
      // but the settled-value stream should never depend on that.
      this.events.colorCommitted.invoke(this.selectedColor)
    }
  }

  /**
   * Reports the picker's intrinsic size to a parent Layout2D container.
   * Only the compact field row counts — the popup panel overlays whatever
   * sits below it.
   */
  public computeContentSize(_opts?: {mode?: "preferred" | "min" | "max"}): {width: number; height: number} {
    return {
      width: this._width,
      height: this._fieldHeight
    }
  }

  /** All three modes are locked to the compact field-row size. */
  public computeContentSizeAllModes(): {
    preferred: {width: number; height: number}
    min: {width: number; height: number}
    max: {width: number; height: number}
  } {
    const size = this.computeContentSize()
    return {preferred: {...size}, min: {...size}, max: {...size}}
  }

  /**
   * Forces any pending picker layout work to complete. Part of the
   * LayoutContainer contract — parent Layout2D containers call this after
   * assigning {@link width} and {@link height}.
   */
  public forceLayout(): void {
    if (this.hasPendingBatchedUpdates()) {
      this.flushBatchedUpdates()
      // Same clean-at-end accounting as the LateUpdate handler: stay armed
      // only if the flush re-raised dirt, instead of firing a no-op tick.
      if (this.state.batch.updateEvent) {
        this.state.batch.updateEvent.enabled = this.hasPendingBatchedUpdates()
      }
    }
  }

  // ─── Lifecycle / Construction ───────────────────────────────────────

  /**
   * Called when the component is first created.
   * Sets up the batched layout update event and binds the start and destroy
   * lifecycle handlers.
   */
  public onAwake(): void {
    this.state.batch.updateEvent = this.createEvent("LateUpdateEvent")
    this.state.batch.updateEvent.enabled = false
    this.state.batch.updateEvent.bind(() => this.flushBatchedUpdatesAndUpdateEvent())

    this.createEvent("OnEnableEvent").bind(() => this.invalidateCanvasBinding())
    this.createEvent("OnStartEvent").bind(() => this.initialize())
    this.createEvent("OnDestroyEvent").bind(() => this.onDestroy())
  }

  private initialize(): void {
    if (this.state.lifecycle.initialized) return

    // The inspector defaults seed only untouched state: a programmatic write
    // that landed before start (createComponent-and-configure) wins, and its
    // already-fired colorChanged/colorCommitted stay truthful. A partial
    // pre-start write (e.g. only hue) claims the whole color.
    if (!this.state.color.explicitlySet) {
      this.state.color.hsva = colorToHSVA(this._defaultColor, this.state.color.hsva)
    }
    if (!this.state.format.explicitlySet) {
      this.state.format.mode = normalizeFormat(this._defaultFormat)
    }
    this.state.children.pendingAuthored = this.getRootContentChildren()
    this.canvasSize.setXY(this._width, this._fieldHeight)
    this.canvasController ??= new CanvasController(this.sceneObject)
    this.canvasController.ensure(this.canvasSize)

    // Build the row backplate first so it draws under every sibling, then
    // the popup, then the field row (DatePicker orders its shell the same
    // way). The popup starts enabled so its controls can run their own
    // start-phase initialization; it is hidden once they are ready (see
    // tryCompleteInitialization).
    this.createFieldBackplate()
    this.createPopup()
    this.createFieldRow()
    this.createChildrenContainer(this.state.children.pendingAuthored)
    this.state.children.pendingAuthored = null

    this.state.lifecycle.initialized = true
    this.applyFormatToRow()
    this.updateLayout()
    this.queueTextFitProbes()
    this.applyColorToControls()
    this.tryCompleteInitialization()
  }

  private createChildrenContainer(authoredChildren: SceneObject[] | null): void {
    if (this.getChildrenContainer()) return

    const authored = authoredChildren ?? []
    const rootContentChildren = this.getRootContentChildren()
    const childrenToMove = [
      ...authored.filter((child) => rootContentChildren.includes(child)),
      ...rootContentChildren.filter((child) => !authored.includes(child))
    ]
    const childrenContainer = createChildSceneObjectWithParentLayer(CHILDREN_CONTAINER_OBJECT_NAME, this.sceneObject)
    const childrenContainerScreenTransform = childrenContainer.createComponent("ScreenTransform") as ScreenTransform
    configureScreenTransformToFillParent(childrenContainerScreenTransform)
    this.state.children.ownedRootObjects.add(childrenContainer)
    this.state.children.container = childrenContainer

    for (const child of childrenToMove) {
      if (
        !isNull(child) &&
        !this.state.children.ownedRootObjects.has(child) &&
        child.getParent() === this.sceneObject
      ) {
        // The container fills this picker exactly, so the child's local values
        // already place it where it was. A world-preserving move breaks under a
        // zero-scale ancestor (see reappendChild).
        child.setParent(childrenContainer)
      }
    }
  }

  private getRootContentChildren(): SceneObject[] {
    return this.sceneObject.children.filter((child) => !this.state.children.ownedRootObjects.has(child))
  }

  private getChildrenContainer(): SceneObject | null {
    const childrenContainer = this.state.children.container
    return childrenContainer && !isNull(childrenContainer) ? childrenContainer : null
  }

  private getChildrenParent(): SceneObject | null {
    return this.getChildrenContainer() ?? (this.state.lifecycle.releasing ? null : this.sceneObject)
  }

  private restoreChildrenContainer(): void {
    const childrenContainer = this.state.children.container
    this.state.children.container = null
    if (!childrenContainer || isNull(childrenContainer)) {
      return
    }

    for (const child of [...childrenContainer.children]) {
      if (isNull(child) || this.state.children.ownedRootObjects.has(child)) {
        continue
      }

      try {
        // Back onto the picker with local values kept; see createChildrenContainer.
        child.setParent(this.sceneObject)
      } catch (error) {
        if (!isBeingDestroyedError(error)) {
          throw error
        }
      }
    }
  }

  /**
   * The shared plate the compact field row rests on. The field visuals and
   * the swatch render opaquely on top of it; the plate fills the row's
   * rounded silhouette so the label doesn't float over open scenery.
   */
  private createFieldBackplate(): void {
    if (this.state.backplate.object) return

    this.state.backplate.object = createChildSceneObjectWithParentLayer(BACKPLATE_OBJECT_NAME, this.sceneObject)
    this.state.children.ownedRootObjects.add(this.state.backplate.object)
    this.state.backplate.transform = this.state.backplate.object.getTransform()
    this.state.backplate.position.setXYZ(0, 0, PANEL_Z_OFFSET)
    this.state.backplate.transform.setLocalPosition(this.state.backplate.position)

    const backplate = this.state.backplate.object.createComponent(RoundedRectangle.getTypeName()) as RoundedRectangle
    this.state.backplate.rectangle = backplate
    this.state.backplate.size.setXY(this._width, this._fieldHeight)
    backplate.size = this.state.backplate.size
    backplate.cornerRadius = this.plateCornerRadius
    backplate.gradient = false
    // Resting tint; the swatch button's interaction state retints the whole
    // plate from here (see updateBackplateColor).
    backplate.backgroundColor = this.state.backplate.displayColor
    backplate.blendMode = RoundedRectBlendMode.Normal
    backplate.renderOrder = this.state.lifecycle.renderOrder
    this.state.subscriptions.unsubscribes.push(backplate.onInitialized.add(() => enableDepthOcclusion(backplate)))
  }

  private createPopup(): void {
    if (this.state.popup.object) return

    this.state.popup.object = createChildSceneObjectWithParentLayer(POPUP_OBJECT_NAME, this.sceneObject)
    this.state.children.ownedRootObjects.add(this.state.popup.object)
    this.state.popup.transform = this.state.popup.object.getTransform()

    this.createPanelVisual()
    this.createColorArea()
    this.createHueSlider()
    this.createAlphaSlider()
  }

  private createPanelVisual(): void {
    if (this.state.panel.object || !this.state.popup.object) return

    this.state.panel.object = createChildSceneObjectWithParentLayer(PANEL_OBJECT_NAME, this.state.popup.object)
    this.state.panel.transform = this.state.panel.object.getTransform()

    const panel = this.state.panel.object.createComponent(RoundedRectangle.getTypeName()) as RoundedRectangle
    this.state.panel.rectangle = panel
    this.state.panel.size.setXY(this._width, this._panelHeight)
    panel.size = this.state.panel.size
    panel.cornerRadius = this.plateCornerRadius
    panel.gradient = false
    panel.backgroundColor = ColorPickerPanelColor
    panel.blendMode = RoundedRectBlendMode.Normal
    panel.renderOrder = this.state.lifecycle.renderOrder
    this.state.subscriptions.unsubscribes.push(panel.onInitialized.add(() => enableDepthOcclusion(panel)))
  }

  private createSwatchButton(): void {
    if (this.state.swatch.object) return

    const swatch = this.state.swatch
    swatch.object = createChildSceneObjectWithParentLayer(SWATCH_OBJECT_NAME, this.state.row.object!)

    const button = swatch.object.createComponent(Button.getTypeName()) as Button
    swatch.button = button
    // Custom visual assigned before the button initializes so the preset
    // path is skipped. Transparent so a translucent selection previews
    // translucently. Toggleable so the expanded picker can hold the row
    // backplate's toggled color; isOn is reassigned after every interaction
    // rather than trusted (the IK toggle auto-flips before onTriggerUp
    // handlers run — see syncSwatchToggleState).
    const swatchVisual = new RoundedRectangleVisual({
      sceneObject: swatch.object,
      style: SwatchVisualParameters,
      transparent: true
    })
    swatchVisual.shouldColorChange = false
    swatchVisual.cornerRadius = this.swatchCornerRadius
    button.visual = swatchVisual
    swatch.visual = swatchVisual
    button.setIsToggleable(true)
    button.renderOrder = this.state.lifecycle.renderOrder
    swatch.buttonSize.setXYZ(this.controlHeight, this.controlHeight, FIELD_DEPTH)
    button.size = swatch.buttonSize
    swatch.flexItem = this.createRigidFlexItem(swatch.object)

    this.state.subscriptions.unsubscribes.push(
      button.onInitialized.add(() => {
        swatch.ready = true
        applyVisualCornerRadius(button.visual, this.swatchCornerRadius)
        this.syncSwatchToggleState()
        // Replays the current state immediately, seeding the plate tint.
        this.state.subscriptions.unsubscribes.push(
          button.onStateChanged.add((stateName) => this.handleSwatchStateChanged(stateName))
        )
        let isDragging = false
        this.state.subscriptions.unsubscribes.push(
          button.onTriggerUp.add(() => this.handleSwatchTap(isDragging)),
          button.interactable.onDragStart.add(() => {
            isDragging = true
          }),
          button.interactable.onDragEnd.add(() => {
            isDragging = false
          })
        )
        this.applyColorToControls()
        this.tryCompleteInitialization()
      })
    )
  }

  /**
   * The field row: a FlexLayout container hosting the swatch, the format
   * dropdown, the format's value field(s), and the alpha field. Items are
   * managed manually so a format switch can swap which value fields
   * participate (see applyFormatToRow); the value fields flex-grow to share
   * the space the rigid controls leave over.
   */
  private createFieldRow(): void {
    if (this.state.row.object) return

    const rowObject = createChildSceneObjectWithParentLayer(FIELD_ROW_OBJECT_NAME, this.sceneObject)
    this.state.children.ownedRootObjects.add(rowObject)
    this.state.row.object = rowObject

    const layout = rowObject.createComponent(FlexLayout.getTypeName()) as FlexLayout
    this.state.row.layout = layout
    layout.autoDiscoverItemsOnStart = false
    layout.direction = FlexDirection.Row
    layout.justifyContent = FlexJustify.Start
    layout.alignItems = FlexAlign.Center
    layout.width = this.rowContentWidth
    layout.height = -1
    layout.columnGap = this.controlGap

    this.createSwatchButton()
    this.createFormatDropdown()
    this.createHexField()
    for (let i = 0; i < MAX_CHANNEL_FIELD_COUNT; i++) {
      this.createChannelField(i)
    }
    this.createAlphaField()
  }

  private createFormatDropdown(): void {
    if (this.state.formatDropdown.object) return

    const cell = this.state.formatDropdown
    cell.object = createChildSceneObjectWithParentLayer(FORMAT_DROPDOWN_OBJECT_NAME, this.state.row.object!)
    // Slightly forward so the drawer, drawn behind the dropdown's own plane,
    // still depth-beats the popup content it opens over. setLocalXY (the
    // flex apply path) preserves this z.
    cell.object.getTransform().setLocalPosition(new vec3(0, 0, DROPDOWN_Z_OFFSET))

    this.createFormatTrigger(cell)

    const dropdown = cell.object.createComponent(Dropdown.getTypeName()) as Dropdown
    cell.dropdown = dropdown
    dropdown.startExpanded = false
    dropdown.selectionMode = "single"
    dropdown.allowEmptySelection = false
    dropdown.collapseOnSelect = true
    dropdown.maxVisibleItems = FORMAT_OPTIONS.length
    // The picker owns the trigger so its plate can be authored borderless
    // and transparent; a generated trigger always takes a theme preset.
    // Both are init-only and set before the Dropdown's own start pass.
    dropdown.customTrigger = true
    dropdown.topButton = cell.triggerButton!
    // Still authored: triggerButtonSize backs computeContentSize (the size
    // the flex row measures), which a custom trigger never updates.
    dropdown.triggerButtonSize = new vec2(this.formatDropdownWidth, this.controlHeight)
    // Detach the drawer from the trigger and align its top edge with the
    // row backplate's bottom edge (the trigger sits centered in the row,
    // so the plate's edge is half the row height below the origin).
    dropdown.drawerTopOffset = this.fieldHeight / 2
    dropdown.hasTriggerBackground = false
    // The drawer follows the trigger footprint deterministically — without
    // the override its width would read a default until the dropdown's own
    // start pass, and the flex measure would see that stale width.
    dropdown.overrideWidth = true
    dropdown.configureWidth(this.formatDropdownWidth)
    dropdown.itemHeight = this.controlHeight
    // Drawer plate insets and row gap scale with the picker like every
    // other metric. Creation-only on purpose: they are pool geometry,
    // frozen when the pool is built (see optionPlateWidth).
    dropdown.dropdownPadding = new vec2(
      this.widthScaled(REFERENCE_DRAWER_PADDING),
      this.fieldHeightScaled(REFERENCE_DRAWER_PADDING)
    )
    dropdown.itemSpacing = this.fieldHeightScaled(REFERENCE_DRAWER_ITEM_SPACING)
    // The pool is born at the fit's floor and grows to the fitted size as
    // measurements arrive (optionTextSize is live; see applyFittedTextSizes).
    dropdown.optionTextSize = this.fieldTextSize
    // Centered to match the trigger's own label. Read when the drawer's
    // button pool is built, so it must precede setData.
    dropdown.optionTextAlignment = TextAlignment.Center
    // Same no-wrap policy as the trigger label (see createFormatTrigger);
    // init-only, read at pool creation.
    dropdown.optionWrapText = false
    dropdown.triggerRenderOrder = this.state.lifecycle.renderOrder
    dropdown.drawerRenderOrder = this.state.lifecycle.renderOrder
    // The drawer's rows fade over the popup, and a translucent squircle
    // still writes depth — the popup content (drawn later) gets
    // depth-rejected behind the invisible rows, which reads as row-shaped
    // holes once the closing drawer background no longer backs those
    // pixels. Suspend row depth writes while translucent, through the
    // Dropdown's public fade hook so the stock Dropdown keeps its
    // behavior for every other host.
    dropdown.onFadeItem = (button: Button, alpha: number) => this.applyFormatOptionDepthWrite(button, alpha)
    // Width-scale each option label's side padding, like the trigger's
    // (fixed padding would starve the option band at narrow widths), and
    // record what was applied: the fit computes the option band from the
    // recorded value, which — like the pool plates themselves — is frozen
    // at pool-bind time and doesn't track later resizes.
    dropdown.onBindItem = (button: Button) => this.applyFormatOptionContentPadding(button)
    dropdown.setData(FORMAT_OPTIONS.map((format) => new DropdownOption(format)))
    dropdown.selectDataAt(FORMAT_OPTIONS.indexOf(this.state.format.mode))
    cell.flexItem = this.createRigidFlexItem(cell.object)

    this.state.subscriptions.unsubscribes.push(
      dropdown.onItemTapped.add((event) => this.handleFormatSelected(event.index)),
      // A custom trigger opts out of the Dropdown's own chevron/toggle
      // upkeep (that path is generated-trigger only), so mirror the drawer
      // state onto the plate and the icon here.
      dropdown.onExpandedChanged.add((expanded: boolean) => this.applyFormatTriggerExpanded(expanded))
    )
  }

  /**
   * Builds the dropdown's trigger: a toggleable button carrying the
   * authored borderless plate (see FormatTriggerVisualParameters) plus the
   * format label and chevron. Lives on its own child at the dropdown's
   * origin, which is where the Dropdown expects a custom trigger to sit
   * when it places the drawer beneath it.
   */
  private createFormatTrigger(cell: ColorPickerDropdownState): void {
    const triggerObject = createChildSceneObjectWithParentLayer(FORMAT_TRIGGER_OBJECT_NAME, cell.object!)

    const button = triggerObject.createComponent(Button.getTypeName()) as Button
    cell.triggerButton = button
    // Custom visual assigned before the button initializes so the preset
    // path is skipped. Transparent blending so the closed plate really
    // shows the row backplate through it.
    const triggerVisual = new RoundedRectangleVisual({
      sceneObject: triggerObject,
      style: FormatTriggerVisualParameters,
      transparent: true
    })
    triggerVisual.cornerRadius = this.fieldCornerRadius
    button.visual = triggerVisual
    // Toggleable so the open drawer can hold the toggled plate; isOn is
    // pinned to the drawer state rather than trusted (the IK toggle
    // auto-flips before the Dropdown's own trigger handler runs).
    button.setIsToggleable(true)
    button.renderOrder = this.state.lifecycle.renderOrder
    cell.triggerSize.setXYZ(this.formatDropdownWidth, this.controlHeight, FIELD_DEPTH)
    button.size = cell.triggerSize

    const content = addContentToElement(triggerObject, {
      text: this.state.format.mode,
      textSize: this.fieldTextSize,
      textAlignment: TextAlignment.Center,
      trailingIcon: CHEVRON_DOWN
    })
    // The label never wraps: the fitted text size keeps it inside the
    // trigger band (see computeFittedTextSize), and below the fit's floor
    // it overflows the plate rather than wrap into the clipped second line
    // ElementContent's pinned vertical Truncate would eat.
    content.wrapText = false
    this.applyTriggerContentSpacing(content)
    content.renderOrder = this.state.lifecycle.renderOrder
    applyContentTextColor(content, ColorPickerLabelTextColor)
    cell.triggerContent = content
    this.applyFormatTriggerIconSize()

    // Built and settled now, while the row is still assembling: the
    // Dropdown reads the trigger's size during its own start pass, and an
    // uninitialized button would have no interactable for it to wire.
    // initialize() is idempotent; the deferred onStart becomes a no-op.
    button.initialize()
  }

  private createHexField(): void {
    if (this.state.hexField.object) return

    const cell = this.state.hexField
    const field = this.createRowTextField(cell, HEX_FIELD_OBJECT_NAME)
    field.placeholderText = HEX_FIELD_PLACEHOLDER

    this.subscribeTextField(cell, () => this.commitHexFieldText())

    // Eager initialization (idempotent; the deferred onStart becomes a
    // no-op): a non-Hex default format disables this field before its
    // start phase would ever run, and a disabled object never starts —
    // the stranded ready flag would hold tryCompleteInitialization (and
    // the startup popup collapse) forever (the Calendar pooled-cell
    // rationale).
    field.initialize()
  }

  private createChannelField(index: number): void {
    const cell = this.state.channelFields[index]
    if (cell.object) return

    const field = this.createRowTextField(cell, CHANNEL_FIELD_OBJECT_NAME_PREFIX + index)
    // Direct input assignment: the field is pre-initialization, so its
    // keyboard type is derived from inputType when it builds — the same
    // path an inspector-authored numeric field takes.
    field.inputType = "numeric"
    // A sideways drag steps the value by one (TextInputField's drag-to-adjust).
    // Each stepped text arrives through onTextChanged like a programmatic write
    // and commits through the same parse as a typed entry (see
    // subscribeTextField), so a step past the channel's range clamps and the
    // refresh rewrites the clamped text.
    field.dragAdjustAxis = "horizontal"

    this.subscribeTextField(cell, () => this.commitChannelFieldText(index))
    // Eager initialization (idempotent; the deferred onStart becomes a
    // no-op): formats that don't use this channel disable it before its
    // start phase would ever run, and a disabled object never starts — the
    // ready flag would strand tryCompleteInitialization (the Calendar
    // pooled-cell rationale).
    field.initialize()
  }

  private createAlphaField(): void {
    if (this.state.alphaField.object) return

    const cell = this.state.alphaField
    const field = this.createRowTextField(cell, ALPHA_FIELD_OBJECT_NAME)
    field.inputType = "numeric"
    // Same sideways drag as the channel fields; the field carries the "%"
    // through each step, so the text keeps its canonical shape and
    // parseAlphaPercent reads it unchanged.
    field.dragAdjustAxis = "horizontal"
    field.placeholderText = ALPHA_FIELD_PLACEHOLDER
    // The alpha field keeps its authored width (the shared shell already
    // sized it alphaFieldWidth x controlHeight); only the value fields flex.
    // Basis must go back to auto — the shared shell set it to 0 for the
    // grow-to-fill cells, and 0 basis with 0 grow allocates zero width.
    cell.flexItem!.flexGrow = 0
    cell.flexItem!.flexShrink = 0
    cell.flexItem!.flexBasis = "auto"

    this.subscribeTextField(cell, () => this.commitAlphaFieldText())

    // Eager initialization (idempotent; the deferred onStart becomes a
    // no-op). Unlike the hex/channel fields this cell is never hidden, so
    // it doesn't need the stranded-ready-flag protection — it initializes
    // eagerly because it is the text fit's glyph-measurement target (see
    // queueTextFitProbes), and its Text component must exist for the boot
    // burst that fits the labels before the first rendered frame.
    field.initialize()
  }

  /**
   * Shared shell for the row's text fields: object under the row, the
   * field component with the row-wide config, and a grow-to-fill FlexItem
   * (rigid cells override the flex factors after).
   */
  private createRowTextField(cell: ColorPickerFieldState, name: string): TextInputField {
    cell.object = createChildSceneObjectWithParentLayer(name, this.state.row.object!)

    const field = cell.object.createComponent(TextInputField.getTypeName()) as TextInputField
    cell.field = field
    field.actionSlot = "none"
    field.showClearButton = false
    field.renderOrder = this.state.lifecycle.renderOrder
    cell.fieldSize.setXYZ(this.alphaFieldWidth, this.controlHeight, FIELD_DEPTH)
    field.size = cell.fieldSize
    // The picker owns the font size — the field's own automatic sizing
    // reads only its height, and field text must also shrink when its cell
    // narrows. Seeded at the fit's floor here; applyFittedTextSizes grows
    // it once measurements and the flex-allocated widths exist.
    field.fontSize = this.fieldTextSize

    const flexItem = cell.object.createComponent(FlexItem.getTypeName()) as FlexItem
    flexItem.flexGrow = 1
    flexItem.flexShrink = 1
    flexItem.flexBasis = 0
    cell.flexItem = flexItem
    return field
  }

  /** A FlexItem that keeps its content's measured size under flex pressure. */
  private createRigidFlexItem(sceneObject: SceneObject): FlexItem {
    const flexItem = sceneObject.createComponent(FlexItem.getTypeName()) as FlexItem
    flexItem.flexGrow = 0
    flexItem.flexShrink = 0
    return flexItem
  }

  /**
   * Wires a text field's lifecycle and commit paths:
   * - Return commits the entry immediately.
   * - An ending edit session commits only when the user changed the text —
   *   an untouched session refreshes to the canonical formatting instead,
   *   so a color changed elsewhere mid-session isn't reverted by the
   *   field's stale text.
   * - A text change outside an edit session (a programmatic write) commits
   *   too, so the field can't rest on stale or empty text. Text equal to
   *   the cell's cached canonical text is left alone — that's the picker's
   *   own write arriving on the field's batched flush, after
   *   {@link ColorPickerColorState.applyingToControls} has already
   *   cleared. The cache, not a fresh derivation, is the comparator so a
   *   drag frame's echoes don't repeat the color-space projection once per
   *   field; see writeFieldText for why it can't be stale here.
   * - A drag-to-adjust step (the numeric fields; see createChannelField) is
   *   a programmatic write too, so it commits per step through that path.
   *   Those fields' interactables join the commit coalescing on initialize,
   *   so {@link onColorCommitted} fires once on release like a slider drag:
   *   a step's text flushes in the LateUpdate of the frame that wrote it,
   *   always before the next frame's drag end (IK dispatches a drag update
   *   and a drag end in separate passes), so every step folds into the
   *   release commit.
   */
  private subscribeTextField(cell: ColorPickerFieldState, commit: () => void): void {
    const field = cell.field
    if (!field) return

    this.state.subscriptions.unsubscribes.push(
      field.onInitialized.add(() => {
        cell.ready = true
        applyVisualCornerRadius(field.visual, this.fieldCornerRadius)
        // Only a field that can drag-adjust joins the coalescing: its drag is
        // a color drag like a slider's (see subscribeControlDrag).
        if (field.dragAdjustAxis !== "none") {
          this.subscribeControlDrag(field.interactable)
        }
        this.applyColorToControls()
        this.tryCompleteInitialization()
      }),
      field.onEditMode.add((editing: boolean) => {
        cell.editing = editing
        if (editing) {
          cell.textAtEditStart = field.text
          return
        }

        const userChangedText = cell.textAtEditStart !== null && field.text !== cell.textAtEditStart
        cell.textAtEditStart = null
        if (userChangedText) {
          commit()
        } else {
          this.refreshFieldTexts()
        }
      }),
      field.onReturnKeyPressed.add(() => {
        commit()
        // Return commits without ending the edit session (the keyboard
        // stays up), so the session diff must be re-baselined: otherwise
        // the close sees text != textAtEditStart and commits the same
        // entry AGAIN — which lands on a different color for CMYK, whose
        // channels re-derive from the already-changed color.
        if (cell.editing) {
          cell.textAtEditStart = field.text
        }
      }),
      field.onTextChanged.add(() => {
        if (!this.state.lifecycle.initialized || this.state.color.applyingToControls || cell.editing) {
          return
        }
        // A null cache means the picker has never written this cell, so
        // whatever arrived isn't an echo.
        if (field.text === cell.canonicalText) {
          return
        }
        commit()
      })
    )
  }

  private createColorArea(): void {
    if (this.state.area.object || !this.state.popup.object) return

    this.state.area.object = createChildSceneObjectWithParentLayer(COLOR_AREA_OBJECT_NAME, this.state.popup.object)
    this.state.area.transform = this.state.area.object.getTransform()

    const area = this.state.area.object.createComponent(ColorArea.getTypeName()) as ColorArea
    this.state.area.area = area
    const hsva = this.state.color.hsva
    area.setHSV(hsva.hue, hsva.saturation, hsva.value)
    area.renderOrder = this.state.lifecycle.renderOrder
    area.size = new vec3(this.areaWidth, this.areaHeight, AREA_DEPTH)
    area.knobSize = new vec2(this.areaKnobSize, this.areaKnobSize)

    this.state.subscriptions.unsubscribes.push(
      area.onInitialized.add(() => {
        this.state.area.ready = true
        this.subscribeControlDrag(area.interactable)
        this.applyColorToControls()
        this.tryCompleteInitialization()
      }),
      area.onColorChange.add(() => this.handleAreaColorChange())
    )
  }

  private createHueSlider(): void {
    if (this.state.hueSlider.object || !this.state.popup.object) return

    this.state.hueSlider.object = createChildSceneObjectWithParentLayer(HUE_SLIDER_OBJECT_NAME, this.state.popup.object)
    this.state.hueSlider.transform = this.state.hueSlider.object.getTransform()

    const slider = this.createColorSlider(this.state.hueSlider.object, ColorSliderMode.Hue)
    this.state.hueSlider.slider = slider
    slider.hueRangeDegrees = HUE_SLIDER_RANGE_DEGREES
    slider.updateCurrentValue(hueToSliderValue(this.state.color.hsva.hue, HUE_SLIDER_RANGE_DEGREES))

    this.state.subscriptions.unsubscribes.push(
      slider.onInitialized.add(() => {
        this.state.hueSlider.ready = true
        this.subscribeControlDrag(slider.interactable)
        this.applyColorToControls()
        this.tryCompleteInitialization()
      }),
      slider.onKnobMoved.add((knobValue: number) => this.handleHueKnobMoved(knobValue))
    )
  }

  private createAlphaSlider(): void {
    if (this.state.alphaSlider.object || !this.state.popup.object) return

    this.state.alphaSlider.object = createChildSceneObjectWithParentLayer(
      ALPHA_SLIDER_OBJECT_NAME,
      this.state.popup.object
    )
    this.state.alphaSlider.transform = this.state.alphaSlider.object.getTransform()

    const slider = this.createColorSlider(this.state.alphaSlider.object, ColorSliderMode.Alpha)
    this.state.alphaSlider.slider = slider
    const rgba = this.selectedColor
    slider.hueColor = new vec4(rgba.r, rgba.g, rgba.b, 1)
    slider.updateCurrentValue(this.state.color.hsva.alpha)

    this.state.subscriptions.unsubscribes.push(
      slider.onInitialized.add(() => {
        this.state.alphaSlider.ready = true
        this.subscribeControlDrag(slider.interactable)
        this.applyColorToControls()
        this.tryCompleteInitialization()
      }),
      slider.onKnobMoved.add((knobValue: number) => this.handleAlphaKnobMoved(knobValue))
    )
  }

  private createColorSlider(sliderObject: SceneObject, mode: ColorSliderMode): ColorSlider {
    const slider = sliderObject.createComponent(ColorSlider.getTypeName()) as ColorSlider
    slider.mode = mode
    slider.customKnobSize = true
    // Inset knob travel: the knob stays inside the track's ends instead of
    // hanging over the panel padding at 0 and 1. It stands taller than the
    // track, as in the design spec, at every size: both knob dims ride
    // panelHeightScale with the track height (see sliderKnobWidth), so the
    // knob neither sinks into a taller track nor changes shape when the
    // picker narrows. Its width is thus independent of the picker's width;
    // a narrow picker spends a larger share of its track on the knob.
    slider.knobOverflow = false
    slider.renderOrder = this.state.lifecycle.renderOrder
    slider.resetDimensions(this.contentWidth, this.sliderHeight, new vec2(this.sliderKnobWidth, this.sliderKnobHeight))
    return slider
  }

  // ─── Interaction ────────────────────────────────────────────────────

  /**
   * Publishes the picker initialization only once every embedded control has
   * built its own visuals, so subscribers observe a fully-formed picker.
   * This is also where a collapsed picker first hides its popup — the popup
   * must stay enabled until its controls have run their start phase.
   */
  private tryCompleteInitialization(): void {
    if (this.state.lifecycle.initializedEventFired) return
    if (
      !this.state.lifecycle.initialized ||
      !this.state.swatch.ready ||
      !this.state.hexField.ready ||
      !this.state.channelFields.every((cell) => cell.ready) ||
      !this.state.alphaField.ready ||
      !this.state.area.ready ||
      !this.state.hueSlider.ready ||
      !this.state.alphaSlider.ready
    ) {
      return
    }

    this.applyColorToControls()
    if (!this.state.popup.expanded && this.state.popup.object && !isNull(this.state.popup.object)) {
      this.state.popup.object.enabled = false
    }
    this.state.lifecycle.initializedEventFired = true
    this.events.initialized.invoke()
  }

  private setExpanded(expanded: boolean): void {
    if (this.state.popup.expanded === expanded) return

    this.state.popup.expanded = expanded
    if (this.state.lifecycle.initialized) {
      if (this.state.popup.object && !isNull(this.state.popup.object)) {
        // Enabling is safe at any time; disabling waits for the popup
        // controls' start phase (tryCompleteInitialization performs the
        // startup default-collapsed hide).
        if (expanded || this.state.lifecycle.initializedEventFired) {
          this.state.popup.object.enabled = expanded
        }
      }
      this.syncSwatchToggleState()
    }
    this.events.expandedChanged.invoke(expanded)
  }

  /**
   * Suspends a format option's depth writes while the drawer fade holds it
   * translucent, then restores the authored policy at full opacity. A
   * translucent plate that writes depth punches a row-shaped hole into
   * popup content drawn after it — visible as bright rectangles while the
   * closing drawer background shrinks away (the drawer normally backs
   * exactly those pixels).
   */
  private applyFormatOptionDepthWrite(button: Button, alpha: number): void {
    const visual = button?.visual
    if (!visual) return

    const cache = this.state.formatDropdown.itemDepthWriteCache
    if (!cache.has(button)) {
      cache.set(button, visual.depthWrite)
    }
    visual.depthWrite = alpha >= 1 ? cache.get(button)! : false
  }

  /**
   * Mirrors the drawer's open state onto the trigger: the toggled plate
   * fill and the flipped chevron. The toggle is applied without the
   * state-transition fade, so re-pinning after the IK auto-flip is
   * invisible.
   */
  private applyFormatTriggerExpanded(expanded: boolean): void {
    const cell = this.state.formatDropdown
    if (cell.triggerButton) {
      setButtonToggledImmediate(cell.triggerButton, expanded)
    }
    if (cell.triggerContent) {
      const icon = expanded ? CHEVRON_UP : CHEVRON_DOWN
      if (cell.triggerContent.trailingIcon !== icon) {
        cell.triggerContent.trailingIcon = icon
      }
    }
  }

  /**
   * Applies the width-scaled label paddings to the trigger content. Runs at
   * creation and again on every fit pass, so a live width change keeps the
   * overhead proportional.
   */
  private applyTriggerContentSpacing(content: ElementContent): void {
    const side = this.contentSidePadding
    const vertical = this.contentVerticalPadding
    content.padding = {top: vertical, right: side, bottom: vertical, left: side}
    content.spacing = this.contentSpacing
  }

  /**
   * Applies the width-scaled side padding to a drawer option's label
   * content and records the applied sum for the fit's option-band math.
   * Invoked from the Dropdown's onBindItem hook, so it lands when the pool
   * first binds and idempotently on every rebind.
   */
  private applyFormatOptionContentPadding(button: Button): void {
    if (!button || isNull(button)) return
    const content = button.sceneObject.getComponent(ElementContent.getTypeName()) as ElementContent | null
    if (!content || isNull(content)) return

    // Re-fit only when the very first plate binds — that is when the option
    // band becomes measurable at all. Later binds carry the size already
    // (Dropdown's optionTextSize write covers the whole pool), and this hook
    // also fires per row while the drawer scrolls, where re-fitting would be
    // pure waste.
    const wasEmpty = this.state.formatDropdown.optionContents.size === 0
    this.state.formatDropdown.optionContents.set(button, content)
    this.applyOptionContentPaddings()
    if (wasEmpty) {
      this.applyFittedTextSizes()
    }
  }

  /**
   * Re-scales the label padding on every retained drawer-option plate.
   * Runs on each bind and on each fit pass, so the padding the fit
   * subtracts from a plate is the padding that plate actually carries even
   * after a resize — the Dropdown restretches the plates on its own, but
   * nothing re-invokes the bind hook.
   * @returns The side padding total (left + right) now applied.
   */
  private applyOptionContentPaddings(): number {
    const side = this.contentSidePadding
    const vertical = this.contentVerticalPadding
    for (const [button, content] of this.state.formatDropdown.optionContents) {
      if (isNull(button) || !content || isNull(content)) continue
      content.padding = {top: vertical, right: side, bottom: vertical, left: side}
    }
    return side * 2
  }

  /**
   * Scales the chevron with the FITTED label size, matching the Dropdown's
   * own label-to-icon ratio, so the icon shrinks and grows with the text.
   * The fit stays non-circular because the trigger constraint folds the
   * chevron's per-point width into the label's instead of subtracting the
   * chevron from the band (see computeFittedTextSize).
   */
  private applyFormatTriggerIconSize(): void {
    const content = this.state.formatDropdown.triggerContent
    if (!content) return

    content.trailingIconSize = CHEVRON_BASE_SIZE * (this.fieldTextSize / CHEVRON_BASE_TEXT_SIZE)
  }

  /**
   * Ends any live edit session on the format-dependent row cells (the hex
   * field and the channel fields; the alpha field keeps its meaning across
   * formats). A session must not survive a format switch: a cell hidden
   * mid-edit keeps `editing` until the next field focus blurs it —
   * refreshFieldTexts skips it the whole time (stale text) — and that
   * deferred blur would commit the abandoned digits under the NEW format's
   * channel semantics. textAtEditStart is dropped first so the session end
   * routes through the refresh branch: the digits are abandoned, never
   * committed. Must run before state.format.mode changes, so the refresh
   * fired by the session end still formats under the old format.
   */
  private discardFormatFieldEditSessions(): void {
    const cells = [this.state.hexField, ...this.state.channelFields]
    for (const cell of cells) {
      if (!cell.editing) continue
      cell.textAtEditStart = null
      if (cell.field) {
        // Ends the field's own session: keyboard dismissed, manager
        // deregistered, and our onEditMode(false) handler clears the flags.
        cell.field.editMode(false)
      }
      // The handler normally cleared these; force them for a field whose
      // session flags were already out of sync and skipped the event.
      cell.editing = false
      cell.textAtEditStart = null
    }
  }

  private handleFormatSelected(index: number): void {
    if (!this.state.lifecycle.initialized) return

    const format = FORMAT_OPTIONS[index]
    if (format !== undefined) {
      this.format = format
    }
  }

  /**
   * Rebuilds the row's flex membership for the current format: the swatch
   * and dropdown, then the hex field or the format's channel fields, then
   * the alpha field. Fields outside the format are removed from the layout
   * AND disabled, so they neither reserve space nor render.
   */
  private applyFormatToRow(): void {
    const layout = this.state.row.layout
    if (!this.state.lifecycle.initialized || !layout) return

    const specs = this.currentChannelSpecs
    const hexVisible = specs.length === 0

    const items: FlexItem[] = []
    if (this.state.swatch.flexItem) items.push(this.state.swatch.flexItem)
    if (this.state.formatDropdown.flexItem) items.push(this.state.formatDropdown.flexItem)

    this.setRowCellVisible(this.state.hexField, hexVisible, items)
    for (let i = 0; i < this.state.channelFields.length; i++) {
      const spec = specs[i]
      const cell = this.state.channelFields[i]
      this.setRowCellVisible(cell, spec !== undefined, items)
      if (spec !== undefined && cell.field) {
        cell.field.placeholderText = spec.placeholder
      }
    }
    if (this.state.alphaField.flexItem) items.push(this.state.alphaField.flexItem)

    layout.removeItems(this.state.row.activeItems)
    layout.addItems(items)
    this.state.row.activeItems = items
    layout.forceLayout()
    // The visible value cells (and their flex widths) just changed; re-fit
    // the shared label size to the new format's worst case.
    this.applyFittedTextSizes()
  }

  private setRowCellVisible(cell: ColorPickerFieldState, visible: boolean, items: FlexItem[]): void {
    if (cell.object && !isNull(cell.object) && cell.object.enabled !== visible) {
      cell.object.enabled = visible
    }
    if (visible && cell.flexItem) {
      items.push(cell.flexItem)
    }
  }

  private get currentChannelSpecs(): ColorPickerChannelSpec[] {
    return FORMAT_CHANNEL_SPECS[this.state.format.mode]
  }

  private handleSwatchTap(isDragging: boolean): void {
    if (!this.state.lifecycle.initialized) return

    if (!isDragging) {
      this.toggle()
    }
    // Re-assert the toggle state after every interaction: the IK toggle
    // auto-flipped isOn before this handler ran, including for drag-rejected
    // taps that changed nothing.
    this.syncSwatchToggleState()
  }

  /**
   * Pins the swatch button's toggled state to {@link expanded} so the row
   * backplate holds its expanded color exactly while the popup is open.
   * Applied without the state-transition fade — for the common tap path the
   * IK auto-flip already landed on this value, so any correction here is a
   * mismatch that should not animate twice.
   */
  private syncSwatchToggleState(): void {
    const button = this.state.swatch.button
    if (!this.state.swatch.ready || !button) return

    setButtonToggledImmediate(button, this.state.popup.expanded)
  }

  private handleSwatchStateChanged(stateName: StateName): void {
    this.state.swatch.stateName = stateName
    this.updateBackplateColor()
  }

  /**
   * Retints the whole row backplate to the color of the swatch-button state
   * resting on it (see ColorPickerBackplateStateColors for the per-state
   * tints). The fade runs over the swatch visual's animateDuration so the
   * plate moves in lockstep with the swatch's own state transition —
   * including the zero-duration window {@link setButtonToggledImmediate}
   * opens, where both snap together.
   */
  private updateBackplateColor(): void {
    if (!this.state.backplate.rectangle) return

    const targetColor = ColorPickerBackplateStateColors[this.state.swatch.stateName] ?? ColorPickerBackplateRestingColor
    const duration = this.state.swatch.button?.visual?.animateDuration ?? 0
    this.animateBackplateColor(targetColor, duration)
  }

  /**
   * Fades the backplate toward a target color. An unchanged target leaves
   * the in-flight fade untouched.
   */
  private animateBackplateColor(targetColor: vec4, durationSeconds: number): void {
    const backplate = this.state.backplate
    if (isEqual(backplate.targetColor, targetColor)) return

    backplate.targetColor.copyFrom(targetColor)
    backplate.cancelSet()

    if (durationSeconds <= 0) {
      backplate.displayColor.copyFrom(targetColor)
      if (backplate.rectangle) {
        backplate.rectangle.backgroundColor = backplate.displayColor
      }
      return
    }

    const initialColor = backplate.displayColor.clone()
    animate({
      cancelSet: backplate.cancelSet,
      duration: durationSeconds,
      update: (t) => {
        backplate.displayColor.r = initialColor.r + (targetColor.r - initialColor.r) * t
        backplate.displayColor.g = initialColor.g + (targetColor.g - initialColor.g) * t
        backplate.displayColor.b = initialColor.b + (targetColor.b - initialColor.b) * t
        backplate.displayColor.a = initialColor.a + (targetColor.a - initialColor.a) * t
        if (backplate.rectangle) {
          backplate.rectangle.backgroundColor = backplate.displayColor
        }
      }
    })
  }

  /**
   * Subscribes a draggable control's interactable so the committed event
   * can coalesce the drag. Called from the control's own initialized
   * handler — `interactable` only exists once it has initialized — which
   * also puts these handlers after the control's internal drag handlers
   * (registered during its initialize). That order matters on release:
   * Slider commits its final value from its own drag-end handler, so the
   * value has already landed by the time the commit fires here.
   */
  private subscribeControlDrag(interactable: Interactable): void {
    this.state.subscriptions.unsubscribes.push(
      interactable.onDragStart.add(() => this.handleControlDragStart()),
      interactable.onDragEnd.add(() => this.handleControlDragEnd())
    )
  }

  private handleControlDragStart(): void {
    this.state.commit.activeDragCount++
  }

  private handleControlDragEnd(): void {
    if (this.state.commit.activeDragCount > 0) {
      this.state.commit.activeDragCount--
    }
    // Another control is still held — the commit belongs to the last release.
    if (this.state.commit.activeDragCount > 0) return
    if (!this.state.commit.pendingCommit) return

    this.state.commit.pendingCommit = false
    this.events.colorCommitted.invoke(this.selectedColor)
  }

  private handleAreaColorChange(): void {
    if (!this.state.lifecycle.initialized || this.state.color.applyingToControls) return

    const area = this.state.area.area
    if (!area) return

    const hsva = this.state.color.hsva
    this.setHSVA({hue: hsva.hue, saturation: area.saturation, value: area.value, alpha: hsva.alpha})
  }

  private handleHueKnobMoved(knobValue: number): void {
    if (!this.state.lifecycle.initialized || this.state.color.applyingToControls) return

    const hsva = this.state.color.hsva
    this.setHSVA({
      hue: sliderValueToHue(knobValue, HUE_SLIDER_RANGE_DEGREES),
      saturation: hsva.saturation,
      value: hsva.value,
      alpha: hsva.alpha
    })
  }

  private handleAlphaKnobMoved(knobValue: number): void {
    if (!this.state.lifecycle.initialized || this.state.color.applyingToControls) return

    const hsva = this.state.color.hsva
    this.setHSVA({hue: hsva.hue, saturation: hsva.saturation, value: hsva.value, alpha: knobValue})
  }

  /**
   * Parses and applies the hex field text. Hex entries without alpha digits
   * preserve the current alpha. Whatever the outcome, the field is rewritten
   * to the canonical formatting, reverting invalid entries — deferred to the
   * end of a live edit session so the rewrite doesn't fight the keyboard.
   */
  private commitHexFieldText(): void {
    const cell = this.state.hexField
    if (!this.state.lifecycle.initialized || !cell.field || !cell.ready) return

    const parsed = parseHexColor(cell.field.text)
    if (parsed) {
      const hsva = colorToHSVA(parsed.color, this.state.color.hsva)
      if (!parsed.hasAlpha) {
        hsva.alpha = this.state.color.hsva.alpha
      }
      this.setHSVA(hsva)
    }
    this.refreshFieldTexts()
  }

  /**
   * Parses and applies a channel field entry against the current format,
   * replacing just that channel of the selected color. Whatever the
   * outcome, the fields are rewritten to the canonical formatting,
   * reverting invalid entries.
   */
  private commitChannelFieldText(index: number): void {
    const cell = this.state.channelFields[index]
    const spec = this.currentChannelSpecs[index]
    if (!this.state.lifecycle.initialized || !cell?.field || !cell.ready || !spec) return

    const parsed = parseChannelValue(cell.field.text, spec.max)
    if (parsed !== null) {
      this.setHSVA(hsvaWithChannel(this.state.color.hsva, this.state.format.mode, index, parsed))
    }
    this.refreshFieldTexts()
  }

  /**
   * Parses and applies the alpha percentage field text. Whatever the
   * outcome, the field is rewritten to the canonical formatting, reverting
   * invalid entries.
   */
  private commitAlphaFieldText(): void {
    const cell = this.state.alphaField
    if (!this.state.lifecycle.initialized || !cell.field || !cell.ready) return

    const alpha = parseAlphaPercent(cell.field.text)
    if (alpha !== null) {
      this.setHSVA({...cloneHSVA(this.state.color.hsva), alpha})
    }
    this.refreshFieldTexts()
  }

  // ─── Color Application ──────────────────────────────────────────────

  /**
   * Pushes the canonical HSVA state into every embedded control. Controls
   * echo programmatic writes through their own change events, so the pass
   * is bracketed by {@link ColorPickerColorState.applyingToControls} and the
   * interaction handlers drop events raised while it is set.
   */
  private applyColorToControls(): void {
    if (!this.state.lifecycle.initialized) return

    const hsva = this.state.color.hsva
    const rgba = hsvaToColor(hsva)
    this.state.color.applyingToControls = true
    try {
      if (this.state.swatch.visual) {
        this.state.swatch.visual.applyBaseColorNow(rgba)
      }
      if (this.state.area.ready && this.state.area.area) {
        this.state.area.area.setHSV(hsva.hue, hsva.saturation, hsva.value)
      }
      if (this.state.hueSlider.ready && this.state.hueSlider.slider) {
        this.state.hueSlider.slider.resetToValue(hueToSliderValue(hsva.hue, HUE_SLIDER_RANGE_DEGREES))
      }
      if (this.state.alphaSlider.ready && this.state.alphaSlider.slider) {
        const alphaSlider = this.state.alphaSlider.slider
        const opaqueColor = new vec4(rgba.r, rgba.g, rgba.b, 1)
        if (!isEqual(alphaSlider.hueColor, opaqueColor)) {
          alphaSlider.hueColor = opaqueColor
        }
        alphaSlider.resetToValue(hsva.alpha)
      }
      this.refreshFieldTexts(rgba)
    } finally {
      this.state.color.applyingToControls = false
    }
  }

  /**
   * The hex field's canonical formatting of the current color: always the
   * six RGB digits. Alpha has its own percentage field, so it never appears
   * here — an eight-digit entry is still accepted and applies its alpha
   * (see commitHexFieldText), it just renders back as six.
   * @param rgba - The current color's RGBA projection.
   */
  private hexCanonicalText(rgba: vec4): string {
    return formatColorToHex(rgba, false)
  }

  /** The alpha field's canonical formatting of the current alpha. */
  private alphaCanonicalText(): string {
    return formatAlphaPercent(this.state.color.hsva.alpha)
  }

  /**
   * Rewrites the value and alpha fields with the canonical formatting of
   * the current color. Fields mid-edit are skipped so programmatic writes
   * can't fight the keyboard; they re-sync when their edit session ends.
   *
   * Runs on every frame of an area or slider drag (via
   * applyColorToControls), so it does only what the frame needs:
   * - The hex cell is written only while visible (Hex format — the same
   *   hexVisible rule as applyFormatToRow). The format setter refreshes
   *   after a switch, so the cell is current the moment it shows. While
   *   hidden its key is still tracked, and its cache is dropped the moment
   *   the color moves past it (see invalidateCellCache), so the cache is
   *   never stale — only exact or null.
   * - The channel values are derived once for the whole row, reusing the
   *   caller's RGBA when it has one.
   * - Each cell's display value is quantized to a numeric key first, and a
   *   cell already showing that key's text is skipped before any string is
   *   built (see isCellCurrent). The text setter's own equality guard
   *   still backstops the write.
   * Writes go through writeFieldText, which records the string and its key
   * so echoes and repeats are recognized without re-deriving.
   * @param rgba - The current color's RGBA projection, when the caller has
   * already derived it.
   */
  private refreshFieldTexts(rgba?: vec4): void {
    const hsva = this.state.color.hsva
    const specs = this.currentChannelSpecs
    const hexVisible = specs.length === 0

    const hexCell = this.state.hexField
    if (hexCell.ready && hexCell.field && !hexCell.editing) {
      if (hexVisible) {
        const color = rgba ?? this.selectedColor
        const key = hexColorKey(color)
        if (!this.isCellCurrent(hexCell, key)) {
          this.writeFieldText(hexCell, this.hexCanonicalText(color), key)
        }
      } else if (hexCell.canonicalText !== null) {
        // Hidden: the string isn't built, but a cache that no longer
        // describes the color must not survive to be mistaken for an echo.
        // Once dropped, the hidden cell costs this null check per frame.
        if (hexColorKey(rgba ?? this.selectedColor) !== hexCell.displayKey) {
          this.invalidateCellCache(hexCell)
        }
      }
    }

    if (specs.length > 0) {
      const values = channelNormalizedValues(hsva, this.state.format.mode, rgba)
      for (let i = 0; i < specs.length; i++) {
        const cell = this.state.channelFields[i]
        if (cell.ready && cell.field && !cell.editing) {
          const key = quantizeChannelValue(values[i], specs[i].max)
          if (!this.isCellCurrent(cell, key)) {
            this.writeFieldText(cell, formatChannelValue(values[i], specs[i].max), key)
          }
        }
      }
    }

    const alphaCell = this.state.alphaField
    if (alphaCell.ready && alphaCell.field && !alphaCell.editing) {
      const key = quantizeAlphaPercent(hsva.alpha)
      if (!this.isCellCurrent(alphaCell, key)) {
        this.writeFieldText(alphaCell, this.alphaCanonicalText(), key)
      }
    }
  }

  /**
   * True when a cell already shows the text its display key would format
   * to, so the refresh can skip building the string. Both halves are
   * required: an equal key says the NEW canonical string would match the
   * cached one, but not that the field still shows it — after a failed
   * commit (an unparseable entry, or an external write of one) the field
   * holds the bad text while the key is unchanged, and the refresh must
   * still revert it. The text compare is against the cached canonical
   * string, so it allocates nothing.
   */
  private isCellCurrent(cell: ColorPickerFieldState, key: number): boolean {
    return key === cell.displayKey && cell.field !== null && cell.field.text === cell.canonicalText
  }

  /**
   * The single write path for a value field's text. Records the string as
   * the cell's canonical text, and the quantized value it was built from
   * as the display key, before assigning it: the string lets the field's
   * echo (its batched onTextChanged) be recognized by comparison in
   * subscribeTextField instead of re-derived, and the key lets the next
   * refresh skip an unchanged cell (see isCellCurrent). Recorded even when
   * the setter's equality guard suppresses the write, so the cache tracks
   * the canonical formatting rather than the last flush.
   *
   * The cache can't be stale when the echo handler compares against it:
   * every color change refreshes through applyColorToControls, the format
   * setter refreshes after switching mode, a cell skipped mid-edit has its
   * handler return early on `editing` until a session-end path — all of
   * which refresh — has rewritten it, and the hex cell skipped while hidden
   * has its cache dropped as soon as its key no longer matches (see
   * invalidateCellCache).
   */
  private writeFieldText(cell: ColorPickerFieldState, text: string, key: number): void {
    if (!cell.field) return
    cell.canonicalText = text
    cell.displayKey = key
    cell.field.text = text
  }

  /**
   * Drops a cell's cached canonical text and display key. For a cell the
   * refresh deliberately isn't writing (the hex cell while hidden), this
   * runs once the color has moved past what the cache describes, so the
   * echo handler in subscribeTextField treats any text that then arrives
   * as external and commits it rather than mistaking it for the picker's
   * own write. Keeps the invariant the handler relies on — every cell's
   * cache is exact or null — without depending on the engine never
   * delivering a batched flush to a component on a disabled object.
   */
  private invalidateCellCache(cell: ColorPickerFieldState): void {
    cell.canonicalText = null
    cell.displayKey = NaN
  }

  // ─── Batched Updates ────────────────────────────────────────────────

  private markLayoutDirty(): void {
    if (!this.state.lifecycle.initialized) return
    this.state.batch.layoutDirty = true
    this.batchUpdate()
  }

  private batchUpdate(): void {
    if (this.state.batch.updateEvent) {
      this.state.batch.updateEvent.enabled = true
    }
  }

  private flushBatchedUpdatesAndUpdateEvent(): void {
    if (!this.state.batch.updateEvent) return

    this.state.batch.updateEvent.enabled = false
    try {
      this.flushBatchedUpdates()
    } finally {
      this.state.batch.updateEvent.enabled = this.hasPendingBatchedUpdates()
    }
  }

  private hasPendingBatchedUpdates(): boolean {
    return (
      this.state.batch.canvasBindingDirty || this.state.batch.layoutDirty || this.state.textFit.pendingProbes.length > 0
    )
  }

  private flushBatchedUpdates(): void {
    const canvasBindingDirty = this.state.batch.canvasBindingDirty
    const layoutDirty = this.state.batch.layoutDirty
    this.state.batch.canvasBindingDirty = false
    this.state.batch.layoutDirty = false

    try {
      if (layoutDirty) {
        this.updateLayout()
      }
      if (canvasBindingDirty) {
        this.canvasController?.reconcile()
      }
    } catch (error) {
      if (canvasBindingDirty) {
        this.state.batch.canvasBindingDirty = true
      }
      throw error
    }
    this.drainTextFitProbes()
  }

  // ─── Layout ─────────────────────────────────────────────────────────

  private updateLayout(): void {
    if (!this.state.lifecycle.initialized) return

    // Resizing a slider re-fires onKnobMoved from its size listener (the
    // knob is repositioned from the stored value), so a layout pass must
    // count as the picker pushing state into controls. Unguarded, the hue
    // echo re-enters setHSVA through knobValue * range — lossy: hues past
    // the 330° track end collapse to 330, and in-range hues pick up float
    // noise — firing colorChanged/colorCommitted from a pure layout op.
    // Saved and restored (not set/cleared) so a future caller that is
    // already applying doesn't get un-guarded mid-pass.
    const wasApplying = this.state.color.applyingToControls
    this.state.color.applyingToControls = true
    try {
      this.canvasSize.setXY(this._width, this._fieldHeight)
      this.canvasController?.setSize(this.canvasSize)

      this.updateFieldRowLayout()
      this.updatePopupLayout()
    } finally {
      this.state.color.applyingToControls = wasApplying
    }
  }

  /**
   * Applies the row's rigid metrics — the backplate, the fixed-size
   * controls, and the flex container's own width — then lets the
   * FlexLayout position everything and share the leftover width among
   * the value fields.
   */
  private updateFieldRowLayout(): void {
    const controlHeight = this.controlHeight

    const backplate = this.state.backplate
    if (backplate.rectangle) {
      backplate.size.setXY(this._width, this._fieldHeight)
      backplate.rectangle.size = backplate.size
      backplate.rectangle.cornerRadius = this.plateCornerRadius
    }
    if (backplate.transform) {
      backplate.position.setXYZ(0, 0, PANEL_Z_OFFSET)
      backplate.transform.setLocalPosition(backplate.position)
    }

    const swatch = this.state.swatch
    if (swatch.button) {
      const currentSize = swatch.button.size
      if (currentSize.x !== controlHeight || currentSize.y !== controlHeight || currentSize.z !== FIELD_DEPTH) {
        swatch.buttonSize.setXYZ(controlHeight, controlHeight, FIELD_DEPTH)
        swatch.button.size = swatch.buttonSize
      }
      applyVisualCornerRadius(swatch.button.visual, this.swatchCornerRadius)
    }

    const dropdownCell = this.state.formatDropdown
    if (dropdownCell.dropdown) {
      dropdownCell.dropdown.triggerButtonSize = new vec2(this.formatDropdownWidth, controlHeight)
      dropdownCell.dropdown.drawerTopOffset = this.fieldHeight / 2
      dropdownCell.dropdown.configureWidth(this.formatDropdownWidth)
    }
    if (dropdownCell.triggerButton) {
      const currentSize = dropdownCell.triggerButton.size
      if (currentSize.x !== this.formatDropdownWidth || currentSize.y !== controlHeight) {
        dropdownCell.triggerSize.setXYZ(this.formatDropdownWidth, controlHeight, FIELD_DEPTH)
        dropdownCell.triggerButton.size = dropdownCell.triggerSize
      }
      applyVisualCornerRadius(dropdownCell.triggerButton.visual, this.fieldCornerRadius)
    }

    this.updateFieldCellHeight(this.state.hexField)
    for (const cell of this.state.channelFields) {
      this.updateFieldCellHeight(cell)
    }
    const alphaCell = this.state.alphaField
    if (alphaCell.field) {
      const currentSize = alphaCell.field.size
      if (currentSize.x !== this.alphaFieldWidth || currentSize.y !== controlHeight) {
        alphaCell.fieldSize.setXYZ(this.alphaFieldWidth, controlHeight, FIELD_DEPTH)
        alphaCell.field.size = alphaCell.fieldSize
      }
      if (alphaCell.ready) {
        applyVisualCornerRadius(alphaCell.field.visual, this.fieldCornerRadius)
      }
    }

    const layout = this.state.row.layout
    if (layout) {
      layout.width = this.rowContentWidth
      layout.columnGap = this.controlGap
      layout.forceLayout()
    }
    // After the flex pass: the fit reads the value fields' flex-allocated
    // widths, so it must follow forceLayout.
    this.applyFittedTextSizes()
  }

  /**
   * Re-asserts a value field's height (and corner radius); its width is
   * owned by the flex allocation, and its font size by the text fit.
   */
  private updateFieldCellHeight(cell: ColorPickerFieldState): void {
    if (!cell.field) return

    const currentSize = cell.field.size
    if (currentSize.y !== this.controlHeight || currentSize.z !== FIELD_DEPTH) {
      cell.fieldSize.setXYZ(currentSize.x, this.controlHeight, FIELD_DEPTH)
      cell.field.size = cell.fieldSize
    }
    if (cell.ready) {
      applyVisualCornerRadius(cell.field.visual, this.fieldCornerRadius)
    }
  }

  private updatePopupLayout(): void {
    const popup = this.state.popup
    if (popup.transform) {
      // Sits POPUP_VERTICAL_GAP below the field row, coplanar with it: the
      // two never overlap, and sharing a depth keeps the panel and the row
      // backplate the same distance from the camera so equal widths project
      // as equal widths. Draw order against content the popup overlays is
      // left to render order and hierarchy sorting.
      popup.position.setXYZ(
        0,
        -(this._fieldHeight / 2 + this.fieldHeightScaled(POPUP_VERTICAL_GAP) + this._panelHeight / 2),
        0
      )
      popup.transform.setLocalPosition(popup.position)
    }

    const panel = this.state.panel
    if (panel.rectangle) {
      panel.size.setXY(this._width, this._panelHeight)
      panel.rectangle.size = panel.size
      panel.rectangle.cornerRadius = this.plateCornerRadius
    }
    if (panel.transform) {
      panel.position.setXYZ(0, 0, PANEL_Z_OFFSET)
      panel.transform.setLocalPosition(panel.position)
    }

    const area = this.state.area
    if (area.area) {
      area.area.size = new vec3(this.areaWidth, this.areaHeight, AREA_DEPTH)
      area.area.knobSize = new vec2(this.areaKnobSize, this.areaKnobSize)
    }
    if (area.transform) {
      area.position.setXYZ(0, this.areaCenterY, 0)
      area.transform.setLocalPosition(area.position)
    }

    this.updateSliderLayout(this.state.hueSlider, this.hueSliderCenterY)
    this.updateSliderLayout(this.state.alphaSlider, this.alphaSliderCenterY)
  }

  private updateSliderLayout(sliderState: ColorPickerSliderState, centerY: number): void {
    if (sliderState.slider) {
      sliderState.slider.resetDimensions(
        this.contentWidth,
        this.sliderHeight,
        new vec2(this.sliderKnobWidth, this.sliderKnobHeight)
      )
    }
    if (sliderState.transform) {
      sliderState.position.setXYZ(0, centerY, 0)
      sliderState.transform.setLocalPosition(sliderState.position)
    }
  }

  private updateRenderOrder(value: number): void {
    if (this.state.backplate.rectangle) {
      this.state.backplate.rectangle.renderOrder = value
    }
    if (this.state.panel.rectangle) {
      this.state.panel.rectangle.renderOrder = value
    }
    if (this.state.swatch.button) {
      this.state.swatch.button.renderOrder = value
    }
    if (this.state.formatDropdown.dropdown) {
      this.state.formatDropdown.dropdown.triggerRenderOrder = value
      this.state.formatDropdown.dropdown.drawerRenderOrder = value
    }
    if (this.state.formatDropdown.triggerButton) {
      this.state.formatDropdown.triggerButton.renderOrder = value
    }
    if (this.state.formatDropdown.triggerContent) {
      this.state.formatDropdown.triggerContent.renderOrder = value
    }
    if (this.state.hexField.field) {
      this.state.hexField.field.renderOrder = value
    }
    for (const cell of this.state.channelFields) {
      if (cell.field) {
        cell.field.renderOrder = value
      }
    }
    if (this.state.alphaField.field) {
      this.state.alphaField.field.renderOrder = value
    }
    if (this.state.area.area) {
      this.state.area.area.renderOrder = value
    }
    if (this.state.hueSlider.slider) {
      this.state.hueSlider.slider.renderOrder = value
    }
    if (this.state.alphaSlider.slider) {
      this.state.alphaSlider.slider.renderOrder = value
    }
  }

  // ─── Metrics ────────────────────────────────────────────────────────

  private get widthScale(): number {
    return clamp(this._width / REFERENCE_WIDTH, MIN_SIZE_SCALE, Number.MAX_VALUE)
  }

  private get panelHeightScale(): number {
    return clamp(this._panelHeight / REFERENCE_PANEL_HEIGHT, MIN_SIZE_SCALE, Number.MAX_VALUE)
  }

  private get fieldHeightScale(): number {
    return clamp(this._fieldHeight / REFERENCE_FIELD_HEIGHT, MIN_SIZE_SCALE, Number.MAX_VALUE)
  }

  private widthScaled(referenceValue: number): number {
    return referenceValue * this.widthScale
  }

  private panelHeightScaled(referenceValue: number): number {
    return referenceValue * this.panelHeightScale
  }

  private fieldHeightScaled(referenceValue: number): number {
    return referenceValue * this.fieldHeightScale
  }

  private get controlGap(): number {
    return this.widthScaled(REFERENCE_CONTROL_GAP)
  }

  private get panelPadding(): number {
    return this.widthScaled(REFERENCE_PANEL_PADDING)
  }

  private get sliderHeight(): number {
    return this.panelHeightScaled(REFERENCE_SLIDER_HEIGHT)
  }

  private get sliderGap(): number {
    return this.panelHeightScaled(REFERENCE_SLIDER_GAP)
  }

  /** Width shared by the trigger button and its drawer. */
  private get formatDropdownWidth(): number {
    return this.widthScaled(REFERENCE_FORMAT_DROPDOWN_WIDTH)
  }

  /**
   * Side padding for the trigger and option label contents: the stock
   * ElementContent default at the reference width, scaling proportionally
   * with it in both directions — fixed padding would starve the label
   * bands on a narrow picker and read oversized on a large one.
   */
  private get contentSidePadding(): number {
    return this.widthScaled(REFERENCE_CONTENT_SIDE_PADDING)
  }

  /** Label-to-chevron gap on the trigger; same width scaling. */
  private get contentSpacing(): number {
    return this.widthScaled(REFERENCE_CONTENT_SPACING)
  }

  /** Top/bottom padding of the label contents; rides the field height. */
  private get contentVerticalPadding(): number {
    return this.fieldHeightScaled(REFERENCE_CONTENT_VERTICAL_PADDING)
  }

  private get alphaFieldWidth(): number {
    return this.widthScaled(REFERENCE_ALPHA_FIELD_WIDTH)
  }

  /**
   * Knob sizes ride the panel height with the tracks they sit on, so the
   * slider knob keeps its spec proportion to the track (taller than it)
   * and the area knob its proportion to the area's height, whatever the
   * panel height. Riding the smaller of the width and height scales
   * instead left the knobs at their reference size on a tall panel, sunk
   * into tracks that had grown past them.
   */
  private get areaKnobSize(): number {
    return this.panelHeightScaled(REFERENCE_AREA_KNOB_SIZE)
  }

  private get sliderKnobWidth(): number {
    return this.panelHeightScaled(REFERENCE_SLIDER_KNOB_WIDTH)
  }

  private get sliderKnobHeight(): number {
    return this.panelHeightScaled(REFERENCE_SLIDER_KNOB_HEIGHT)
  }

  /** Inset between the row backplate's edges and the controls on it. */
  private get rowPadding(): number {
    return this._fieldHeight * ROW_PADDING_FACTOR
  }

  /** Corner radius shared by the row backplate and the popup panel. */
  private get plateCornerRadius(): number {
    return this._fieldHeight * PLATE_CORNER_RADIUS_FACTOR
  }

  private get swatchCornerRadius(): number {
    return this.controlHeight * SWATCH_CORNER_RADIUS_FACTOR
  }

  private get fieldCornerRadius(): number {
    return this.controlHeight * FIELD_CORNER_RADIUS_FACTOR
  }

  /** Height of the controls resting on the row backplate. */
  private get controlHeight(): number {
    return clamp(this._fieldHeight - this.rowPadding * 2, MIN_CONTENT_SIZE, Number.MAX_VALUE)
  }

  /** Width of the field row's flex container — the backplate less its insets. */
  private get rowContentWidth(): number {
    return clamp(this._width - this.rowPadding * 2, MIN_CONTENT_SIZE, Number.MAX_VALUE)
  }

  private get contentWidth(): number {
    return clamp(this._width - this.panelPadding * 2, MIN_CONTENT_SIZE, Number.MAX_VALUE)
  }

  private get areaWidth(): number {
    return this.contentWidth
  }

  /**
   * The saturation/value area absorbs the panel height left over by the
   * padding and the two slider rows, so resizing the panel stretches the
   * area rather than the fixed-height rows.
   */
  private get areaHeight(): number {
    const sliderRowsHeight = SLIDER_ROW_COUNT * (this.sliderGap + this.sliderHeight)
    return clamp(this._panelHeight - this.panelPadding * 2 - sliderRowsHeight, MIN_CONTENT_SIZE, Number.MAX_VALUE)
  }

  // Popup-local Y positions: the popup origin is the panel center.
  private get areaCenterY(): number {
    return this._panelHeight / 2 - this.panelPadding - this.areaHeight / 2
  }

  private get hueSliderCenterY(): number {
    return this._panelHeight / 2 - this.panelPadding - this.areaHeight - this.sliderGap - this.sliderHeight / 2
  }

  private get alphaSliderCenterY(): number {
    return this.hueSliderCenterY - this.sliderHeight - this.sliderGap
  }

  /**
   * The ceiling for the fitted label size: the default text size — what
   * TextInputField's own automatic sizing (computeFontSize: size.y *
   * FONT_SIZE_SCALE) picks for the control height at the reference
   * geometry (REFERENCE_WIDTH x REFERENCE_FIELD_HEIGHT) — scaled by how
   * far the picker is from that geometry. The smaller of the two axes'
   * scales drives it, so text grows when the picker grows proportionally
   * and shrinks with whichever axis narrows; the measured fit below only
   * ever shrinks it further when a cell's width demands it.
   */
  private get fieldTextCap(): number {
    const referenceControlHeight = REFERENCE_FIELD_HEIGHT * (1 - 2 * ROW_PADDING_FACTOR)
    return referenceControlHeight * FONT_SIZE_SCALE * Math.min(this.widthScale, this.fieldHeightScale)
  }

  /**
   * The shared label size currently applied to everything the picker owns
   * (trigger label, drawer options, value fields). Seeded at the fit's
   * floor until measurements arrive; see computeFittedTextSize.
   */
  private get fieldTextSize(): number {
    return this.state.textFit.appliedSize
  }

  // ─── Text Fit ───────────────────────────────────────────────────────

  /**
   * Queues the measurements the label fit needs — each glyph the value
   * fields can show (on the alpha field's Text: the fields share a font,
   * and the alpha field is the one cell no format ever hides) and each
   * format label (on the trigger content's Text: the drawer options share
   * its font and style) — then drains as much as the engine allows right
   * away. The glyphs can measure synchronously here (the alpha field is
   * eagerly initialized); the trigger content's Text builds during its own
   * start pass, so the label probes wait for this frame's LateUpdate flush
   * at the earliest.
   *
   * The queue is 38 getBoundingBox calls (17 glyphs × 2 halves for the
   * advance, plus 4 labels) against a per-frame budget the engine does not
   * document. Whether that lands before the first render or over several
   * frames is therefore not known from here: until the last needed width
   * lands, the fit holds at TEXT_FIT_FLOOR and then steps up once (see
   * computeFittedTextSize). What the code does guarantee is progress under
   * any budget of at least one call per frame (see measureGlyphAdvanceStep).
   */
  private queueTextFitProbes(): void {
    this.state.textFit.pendingProbes = [
      ...FORMAT_OPTIONS.map((label): ColorPickerTextProbe => ({target: "label", sample: label})),
      ...FIELD_GLYPH_SAMPLES.map(
        (glyph): ColorPickerTextProbe => ({target: "field", sample: glyph, singleWidthPerPoint: null})
      )
    ]
    this.drainTextFitProbes()
    this.batchUpdate()
  }

  /**
   * Drains queued measurements greedily — each pending probe is attempted
   * at most once per pass — and re-fits once when anything landed. A probe
   * whose source Text doesn't exist yet is skipped (kept pending); a
   * failed measurement (getBoundingBox is rate-limited per frame and
   * throws when it refuses) aborts the pass, and the remainder retries on
   * the next flush. A glyph probe keeps the half it has already won across
   * that abort (see measureGlyphAdvanceStep), so a refusal costs one
   * wasted call, never the probe's progress.
   */
  private drainTextFitProbes(): void {
    if (!this.state.lifecycle.initialized) return

    const fit = this.state.textFit
    let measured = false
    let index = 0
    while (index < fit.pendingProbes.length) {
      const probe = fit.pendingProbes[index]
      const text =
        probe.target === "field"
          ? this.state.alphaField.field?.textComponent
          : this.state.formatDropdown.triggerContent?.textComponent
      if (!text || isNull(text)) {
        index++
        continue
      }

      // Field glyphs need ADVANCES (their widths get summed into composed
      // worst cases); labels are measured whole, where ink extents are
      // exactly the rendered width.
      const widthPerPoint =
        probe.target === "field"
          ? measureGlyphAdvanceStep(probe, (sample) => this.measureTextWidthPerPoint(text, sample))
          : this.measureTextWidthPerPoint(text, probe.sample)
      if (widthPerPoint === null) break

      fit.pendingProbes.splice(index, 1)
      const table = probe.target === "field" ? fit.fieldGlyphWidths : fit.labelWidths
      table.set(probe.sample, widthPerPoint)
      measured = true
    }

    if (measured) {
      this.applyFittedTextSizes()
    }
  }

  /**
   * Measures a sample's rendered ink width per font point on a live Text —
   * swap, measure, restore in one synchronous block (the Layout2D text
   * handler's own pattern, so the swap is never visible). Exactly right
   * for whole labels; for glyphs that get SUMMED, go through
   * measureGlyphAdvanceStep instead. Returns null when getBoundingBox
   * refuses (it is rate-limited and throws), letting the caller retry on a
   * later flush.
   */
  private measureTextWidthPerPoint(text: Text, sample: string): number | null {
    const savedText = text.text
    const savedOverflow = text.horizontalOverflow
    try {
      text.horizontalOverflow = HorizontalOverflow.Overflow
      text.text = sample
      const width = Math.abs(text.getBoundingBox().getSize().x)
      return width > 0 && text.size > 0 ? width / text.size : null
    } catch {
      return null
    } finally {
      text.text = savedText
      text.horizontalOverflow = savedOverflow
    }
  }

  /**
   * Computes and applies the shared fitted label size to everything the
   * picker owns. One size for all of them — the tightest cell governs —
   * so the row reads as one control at every picker size. Runs after
   * every row layout pass (the fit reads the fields' flex-allocated
   * widths) and after every measurement that arrives.
   */
  private applyFittedTextSizes(): void {
    if (!this.state.lifecycle.initialized) return

    const fit = this.state.textFit
    const dropdownCell = this.state.formatDropdown
    // Re-scale the trigger's label paddings before computing: the fit reads
    // them back as part of the trigger band.
    if (dropdownCell.triggerContent) {
      this.applyTriggerContentSpacing(dropdownCell.triggerContent)
    }
    this.applyOptionContentPaddings()
    fit.appliedSize = this.computeFittedTextSize()

    if (dropdownCell.triggerContent) {
      dropdownCell.triggerContent.textSize = fit.appliedSize
    }
    this.applyFormatTriggerIconSize()
    if (dropdownCell.dropdown) {
      dropdownCell.dropdown.optionTextSize = fit.appliedSize
    }
    this.applyFieldTextMetrics(this.state.hexField)
    for (const cell of this.state.channelFields) {
      this.applyFieldTextMetrics(cell)
    }
    this.applyFieldTextMetrics(this.state.alphaField)
  }

  /**
   * The largest shared label size at which nothing the picker owns can
   * wrap or clip: the format labels against the trigger band and the
   * drawer's option band, and the current format's value fields (plus the
   * always-present alpha field) against their widths less their effective
   * insets (see fieldTextInset). Each cell is fitted against the WORST-CASE text
   * it can ever show, never the live text — fitting live text would resize
   * the font mid-drag as values gain and lose digits. While any needed
   * measurement is still pending this reports the floor and grows up when
   * it lands. Cells narrower than their own insets bottom out at the floor
   * (that is geometry — no font size helps, and always-fits-but-illegible
   * is not better).
   */
  private computeFittedTextSize(): number {
    const cap = this.fieldTextCap
    const floor = Math.min(TEXT_FIT_FLOOR, cap)
    const fit = this.state.textFit

    let worstLabel = 0
    for (const label of FORMAT_OPTIONS) {
      const widthPerPoint = fit.labelWidths.get(label)
      if (widthPerPoint === undefined) return floor
      worstLabel = Math.max(worstLabel, widthPerPoint)
    }

    // The trigger band: the plate less the content's own side padding and
    // the icon gap. The chevron scales with the fitted size itself (see
    // applyFormatTriggerIconSize), so rather than subtracting it from the
    // band — which would make the band depend on the fit's own result —
    // its per-point width rides the label's, and the one-division fit
    // sizes label and chevron together.
    const content = this.state.formatDropdown.triggerContent
    const padding = content ? content.padding.left + content.padding.right : 0
    const spacing = content ? content.spacing : 0
    const chevronWidthPerPoint = CHEVRON_BASE_SIZE / CHEVRON_BASE_TEXT_SIZE
    const triggerBand = this.formatDropdownWidth - padding - spacing
    let size = Math.min(cap, fitTextSizeToBand(triggerBand, worstLabel + chevronWidthPerPoint, cap, floor))

    // The drawer's option band. Both terms are live: the Dropdown
    // restretches its plates to the drawer width (optionPlateWidth reports
    // that), and applyOptionContentPaddings has just re-scaled the padding
    // on those same plates. Skipped until a plate has bound, since there is
    // no band to fit against before that.
    const dropdown = this.state.formatDropdown.dropdown
    if (dropdown && dropdown.optionPlateWidth > 0 && this.state.formatDropdown.optionContents.size > 0) {
      const optionBand = dropdown.optionPlateWidth - this.contentSidePadding * 2
      size = Math.min(size, fitTextSizeToBand(optionBand, worstLabel, cap, floor))
    }

    const specs = this.currentChannelSpecs
    if (specs.length === 0) {
      const widthPerPoint = worstHexWidthPerPoint(fit.fieldGlyphWidths)
      if (widthPerPoint === null) return floor
      size = Math.min(size, fitTextSizeToBand(this.fieldTextBand(this.state.hexField), widthPerPoint, cap, floor))
    }
    for (let i = 0; i < specs.length; i++) {
      const widthPerPoint = worstNumericWidthPerPoint(specs[i].max, fit.fieldGlyphWidths)
      if (widthPerPoint === null) return floor
      size = Math.min(
        size,
        fitTextSizeToBand(this.fieldTextBand(this.state.channelFields[i]), widthPerPoint, cap, floor)
      )
    }
    const alphaWidthPerPoint = worstAlphaPercentWidthPerPoint(fit.fieldGlyphWidths)
    if (alphaWidthPerPoint === null) return floor
    size = Math.min(size, fitTextSizeToBand(this.fieldTextBand(this.state.alphaField), alphaWidthPerPoint, cap, floor))

    return Math.max(size, floor)
  }

  /**
   * The width-aspect factor for the value fields' text insets. The fields'
   * own insets are height-derived (INSET_FACTOR_SINGLE_LINE of the field
   * height per side), which is proportional under uniform scaling — but
   * when the width narrows faster than the field height, fixed-at-height
   * insets eat the narrowing cells and drag the fit below the proportional
   * cap. Scale them down by the aspect deficit, matching how the label
   * paddings ride the width; never above 1 (the fields' native inset is
   * the ceiling — reclaiming works by extending the text rect, and a
   * positive offset would shrink it instead).
   */
  private get fieldInsetScale(): number {
    return Math.min(1, this.widthScale / this.fieldHeightScale)
  }

  /** A value field's effective text inset per side; see fieldInsetScale. */
  private fieldTextInset(field: TextInputField): number {
    return INSET_FACTOR_SINGLE_LINE * field.size.y * this.fieldInsetScale
  }

  /**
   * A value field's usable text width: its (flex-allocated) width less the
   * effective insets (see fieldTextInset; these fields have no action slot
   * and no clear button). Must stay in lockstep with the textSideInset
   * applyFieldTextMetrics writes — the fit sizes text for exactly the
   * viewport that inset builds.
   */
  private fieldTextBand(cell: ColorPickerFieldState): number {
    const field = cell.field
    if (!field) return 0
    return field.size.x - 2 * this.fieldTextInset(field)
  }

  /**
   * Applies the fitted size and the effective insets to a value field.
   *
   * Font size goes through TextInputField's fontSize, divided by the
   * field's own height ratio: computeFontSize multiplies an explicit
   * fontSize by size.y / originalSize.y. The ratio is 1 today (the field's
   * _originalSize aliases its _size), but dividing through the public pair
   * keeps the applied size exact if that ever changes.
   *
   * The inset goes through textSideInset, which drives the field's actual
   * text viewport — the clipping mask, caret scrolling, and available
   * width all follow it. (Not textOffset: an offset extends the text rect
   * PAST the viewport, and the field's mask clips at the viewport, eating
   * the leading glyphs.) At or above the reference aspect the value equals
   * the field's own automatic inset, so the default rendering is untouched.
   */
  private applyFieldTextMetrics(cell: ColorPickerFieldState): void {
    const field = cell.field
    if (!field) return

    const originalHeight = field.originalSize.y
    const ratio = originalHeight > 0 ? field.size.y / originalHeight : 1
    field.fontSize = ratio > 0 ? this.state.textFit.appliedSize / ratio : this.state.textFit.appliedSize
    field.textSideInset = this.fieldTextInset(field)
  }

  // ─── Teardown ───────────────────────────────────────────────────────

  private onDestroy(): void {
    const canvasController = this.canvasController
    this.canvasController = null
    this.state.lifecycle.releasing = true
    try {
      // Flip initialized first so in-flight control callbacks early-return
      // instead of touching natives being torn down.
      this.state.lifecycle.initialized = false
      this.state.lifecycle.initializedEventFired = false
      this.state.swatch.ready = false
      this.state.hexField.ready = false
      this.state.hexField.editing = false
      this.state.hexField.textAtEditStart = null
      this.state.alphaField.ready = false
      this.state.alphaField.editing = false
      this.state.alphaField.textAtEditStart = null
      for (const cell of this.state.channelFields) {
        cell.ready = false
        cell.editing = false
        cell.textAtEditStart = null
      }
      this.state.area.ready = false
      this.state.hueSlider.ready = false
      this.state.alphaSlider.ready = false
      this.state.color.applyingToControls = false
      this.state.commit.activeDragCount = 0
      this.state.commit.pendingCommit = false
      this.state.batch.canvasBindingDirty = false
      this.state.batch.layoutDirty = false
      this.state.textFit.pendingProbes = []
      this.state.textFit.fieldGlyphWidths.clear()
      this.state.textFit.labelWidths.clear()
      this.state.children.pendingAuthored = null
      this.state.backplate.cancelSet()
      this.state.swatch.stateName = StateName.default

      for (let i = 0; i < this.state.subscriptions.unsubscribes.length; i++) {
        this.state.subscriptions.unsubscribes[i]()
      }
      this.state.subscriptions.unsubscribes = []

      // Developer children must leave the foreground wrapper before any
      // picker-owned roots are destroyed.
      this.restoreChildrenContainer()
      this.destroyOwnedRootObjects()

      this.state.popup.object = null
      this.state.popup.transform = null
      this.state.backplate.object = null
      this.state.backplate.transform = null
      this.state.backplate.rectangle = null
      this.state.panel.object = null
      this.state.panel.transform = null
      this.state.panel.rectangle = null
      this.state.row.object = null
      this.state.row.layout = null
      this.state.row.activeItems = []
      this.state.swatch.object = null
      this.state.swatch.button = null
      this.state.swatch.visual = null
      this.state.swatch.flexItem = null
      this.state.formatDropdown.object = null
      this.state.formatDropdown.dropdown = null
      this.state.formatDropdown.flexItem = null
      this.state.formatDropdown.triggerButton = null
      this.state.formatDropdown.triggerContent = null
      // Dropdown-owned pooled labels: references released, not destroyed.
      this.state.formatDropdown.optionContents.clear()
      this.state.formatDropdown.itemDepthWriteCache.clear()
      this.clearFieldCell(this.state.hexField)
      for (const cell of this.state.channelFields) {
        this.clearFieldCell(cell)
      }
      this.clearFieldCell(this.state.alphaField)
      this.state.area.object = null
      this.state.area.transform = null
      this.state.area.area = null
      this.state.hueSlider.object = null
      this.state.hueSlider.transform = null
      this.state.hueSlider.slider = null
      this.state.alphaSlider.object = null
      this.state.alphaSlider.transform = null
      this.state.alphaSlider.slider = null
    } finally {
      canvasController?.release()
    }
  }

  private clearFieldCell(cell: ColorPickerFieldState): void {
    cell.object = null
    cell.field = null
    cell.flexItem = null
    cell.ready = false
    cell.editing = false
    cell.textAtEditStart = null
  }

  private destroyOwnedRootObjects(): void {
    const ownedRootObjects = [...this.state.children.ownedRootObjects]
    this.state.children.ownedRootObjects.clear()

    for (const sceneObject of ownedRootObjects) {
      if (isNull(sceneObject)) continue

      try {
        sceneObject.destroy()
      } catch (error) {
        if (!isBeingDestroyedError(error)) {
          throw error
        }
      }
    }
  }
}

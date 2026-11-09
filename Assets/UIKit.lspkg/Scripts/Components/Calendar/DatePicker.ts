import animate, {CancelSet} from "InteractionKit.lspkg/Utils/animate"
import Event, {PublicApi, unsubscribe} from "InteractionKit.lspkg/Utils/Event"
import {clamp} from "InteractionKit.lspkg/Utils/mathUtils"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import ReplayEvent from "InteractionKit.lspkg/Utils/ReplayEvent"
import {
  DatePickerFieldBackplateColor,
  DatePickerFieldStatePlateColors,
  DatePickerFieldTextColor
} from "../../Themes/System-3.0/Colors"
import {CanvasController} from "../../Utility/CanvasController"
import {
  createChildSceneObjectWithParentLayer,
  isBeingDestroyedError,
  isSceneObjectAncestorOf,
  reparentExternalChild,
  unparentExternalChild
} from "../../Utility/SceneUtilities"
import {configureScreenTransformToFillParent, isEqual, setTextRect} from "../../Utility/UIKitUtilities"
import {RoundedRectangle, RoundedRectBlendMode} from "../../Visuals/RoundedRectangle/RoundedRectangle"
import {
  applyVisualCornerRadius,
  RoundedRectangleVisual,
  RoundedRectangleVisualParameters
} from "../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {Button} from "../Button/Button"
import {ElementContent, TextAlignment} from "../Content/ElementContent"
import {addContentToElement} from "../Content/ElementContentFactory"
import {StateName} from "../Element"
import {UIKitBrands} from "../Layout2D/UIKitBrands"
import {FONT_SIZE_SCALE} from "../TextInput/TextInputConsts"
import {
  TextManipulationModule,
  type TextManipulationRefreshReasons
} from "../TextInput/TextManipulation/TextManipulationModule"
import {Calendar, CalendarSelectionChangedEvent, CalendarSelectionMode} from "./Calendar"
import {
  applyContentTextColor,
  CalendarDate,
  cloneDate,
  formatCalendarDate,
  MAX_MONTH,
  MIN_MONTH,
  setButtonToggledImmediate
} from "./CalendarUtilities"

const log = new NativeLogger("DatePicker")

export enum DatePickerMode {
  Single = "Single",
  Range = "Range"
}

@typedef
export class DateInput {
  @input("int")
  @label("Year")
  public year: number = 2026

  @input
  @label("Month")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("January", 1),
      new ComboBoxItem("February", 2),
      new ComboBoxItem("March", 3),
      new ComboBoxItem("April", 4),
      new ComboBoxItem("May", 5),
      new ComboBoxItem("June", 6),
      new ComboBoxItem("July", 7),
      new ComboBoxItem("August", 8),
      new ComboBoxItem("September", 9),
      new ComboBoxItem("October", 10),
      new ComboBoxItem("November", 11),
      new ComboBoxItem("December", 12)
    ])
  )
  public month: number = 10
}

type DatePickerField = "start" | "end"

type DatePickerFieldCell = {
  sceneObject: SceneObject
  transform: Transform
  button: Button
  content: ElementContent
  buttonSize: vec3
  module: TextManipulationModule | null
  buttonReady: boolean
  moduleReady: boolean
  pendingTextRefresh: TextManipulationRefreshReasons | null
  labelText: string
}

/**
 * One animated half of the split backplate. `displayColor` is what the
 * gradient stop currently shows; `targetColor` is where it is heading.
 */
type DatePickerPlateHalf = {
  stopIndex: number
  displayColor: vec4
  targetColor: vec4
  cancelSet: CancelSet
}

const FIELD_ROW_OBJECT_NAME = "DatePickerFieldRow"
const FIELD_BACKPLATE_OBJECT_NAME = "DatePickerFieldBackplate"
const START_FIELD_OBJECT_NAME = "DatePickerStartField"
const END_FIELD_OBJECT_NAME = "DatePickerEndField"
const FIELD_SEPARATOR_OBJECT_NAME = "DatePickerFieldSeparator"
const POPUP_OBJECT_NAME = "DatePickerPopup"
const CHILDREN_CONTAINER_OBJECT_NAME = "ChildrenContainer"

const PLACEHOLDER_LABEL = global.localizationSystem.localize("@uikit:date-picker:select-date")
const FIELD_SEPARATOR_LABEL = "–"

// Field visuals mirror the backplate state colors. The shared backplate still
// fills the whole rounded silhouette, while fields can render opaquely without
// exposing the transparent color's black RGB fallback.
const FIELD_VISUAL_STYLE: Partial<RoundedRectangleVisualParameters> = {
  default: {baseType: "Color", baseColor: DatePickerFieldStatePlateColors.default},
  hovered: {baseType: "Color", baseColor: DatePickerFieldStatePlateColors.hovered},
  triggered: {baseType: "Color", baseColor: DatePickerFieldStatePlateColors.triggered},
  toggledDefault: {baseType: "Color", baseColor: DatePickerFieldStatePlateColors.toggledDefault},
  toggledHovered: {baseType: "Color", baseColor: DatePickerFieldStatePlateColors.toggledHovered},
  toggledTriggered: {baseType: "Color", baseColor: DatePickerFieldStatePlateColors.toggledTriggered},
  inactive: {baseType: "Color", baseColor: DatePickerFieldStatePlateColors.inactive}
}

// The plate's background gradient splits into two halves at the field seam:
// a horizontal linear gradient whose two stops sit a hair apart, giving a
// crisp edge with just enough blend to anti-alias. Each half is retinted to
// mirror its field button's state, so a state fill reaches the plate's own
// rounded silhouette edge to edge instead of stopping at the field button's
// inner corners.
const BACKPLATE_GRADIENT_START = new vec2(-1, 0)
const BACKPLATE_GRADIENT_END = new vec2(1, 0)
const BACKPLATE_SPLIT_LEFT_PERCENT = 0.498
const BACKPLATE_SPLIT_RIGHT_PERCENT = 0.502
const DEFAULT_FIELD_CORNER_RADIUS = 0.75

function createPlateHalf(stopIndex: number): DatePickerPlateHalf {
  return {
    stopIndex,
    displayColor: DatePickerFieldBackplateColor.clone(),
    targetColor: DatePickerFieldBackplateColor.clone(),
    cancelSet: new CancelSet()
  }
}

type DatePickerFieldRowState = {
  object: SceneObject | null
  start: DatePickerFieldCell | null
  end: DatePickerFieldCell | null
  separatorObject: SceneObject | null
  separatorTransform: Transform | null
  separatorText: Text | null
  startPosition: vec3
  endPosition: vec3
  separatorPosition: vec3
}

type DatePickerBackplateState = {
  object: SceneObject | null
  transform: Transform | null
  rectangle: RoundedRectangle | null
  position: vec3
  size: vec2
  ready: boolean
  startHalf: DatePickerPlateHalf
  endHalf: DatePickerPlateHalf
}

type DatePickerPopupState = {
  object: SceneObject | null
  transform: Transform | null
  calendar: Calendar | null
  calendarReady: boolean
  position: vec3
}

type DatePickerSelectionState = {
  expanded: boolean
  fillEndFirst: boolean
  startDate: CalendarDate | null
  endDate: CalendarDate | null
  pending: {start: CalendarDate | null; end: CalendarDate | null} | null
}

type DatePickerFieldStates = {
  start: StateName
  end: StateName
}

type DatePickerLifecycleState = {
  renderOrder: number
  initialized: boolean
  initializedEventFired: boolean
  releasing: boolean
}

type DatePickerChildrenState = {
  container: SceneObject | null
  pendingAuthored: SceneObject[] | null
  ownedRootObjects: Set<SceneObject>
}

type DatePickerBatchState = {
  canvasBindingDirty: boolean
  layoutDirty: boolean
  updateEvent: SceneEvent | null
}

type DatePickerSubscriptionsState = {
  unsubscribes: unsubscribe[]
}

type DatePickerGeometryState = {
  singleFieldWidth: number | null
  singleFieldEditReady: boolean
  singleFieldAnchorRefreshSuppressed: boolean
  singleFieldAnchorRefreshNeedsFinal: boolean
  singleFieldAnchorRefreshFallbackFrames: number
  singleFieldWidthCancelSet: CancelSet
}

type DatePickerState = {
  children: DatePickerChildrenState
  fieldRow: DatePickerFieldRowState
  backplate: DatePickerBackplateState
  popup: DatePickerPopupState
  selection: DatePickerSelectionState
  fieldStates: DatePickerFieldStates
  lifecycle: DatePickerLifecycleState
  batch: DatePickerBatchState
  subscriptions: DatePickerSubscriptionsState
  geometry: DatePickerGeometryState
}

const FIELD_BUTTON_DEPTH = 1
// Popup sits physically forward of the field row while hierarchy sorting
// determines the visual draw order.
const POPUP_Z_OFFSET = 0.5
// Vertical gap between the field row and the calendar popup, in centimeters.
const POPUP_VERTICAL_GAP = 0.25
// Match ElementContent's default content-container lift so the direct Text
// separator is not depth-occluded by the field surfaces.
const FIELD_SEPARATOR_TEXT_Z_OFFSET = 0.05
// Both the plate and the field visuals write depth, so coplanar
// placement z-fights; sit the plate just behind the fields (Calendar
// separates its cells from its background the same way).
const BACKPLATE_Z_OFFSET = -0.05
const FIELD_GEOMETRY_ANIMATION_DURATION = 0.2
const SINGLE_FIELD_ANCHOR_REFRESH_FALLBACK_FRAMES = 2
const SINGLE_FIELD_ANCHOR_REFRESH_FALLBACK_INACTIVE = -1

/**
 * Field-style date picker composing a {@link Calendar} popup.
 *
 * DatePicker shows one field button (Single mode) or start and end field
 * buttons (Range mode) resting on a shared solid backplate:
 * - **Single**: tapping the field toggles a calendar below; picking a date
 *   fills the field ("October 12 2026")
 * - **Range**: the highlighted field is the one the next calendar tap fills.
 *   Tapping the end field first fills the end date first; the second pick
 *   completes the range, swapping if needed so start ≤ end (Calendar
 *   normalization).
 *
 * The popup auto-closes when a selection completes — a single date, or a
 * range's end date. Clearing never auto-closes. The popup overlays content
 * below it: {@link computeContentSize} reports only the closed field row.
 *
 * @example
 * ```typescript
 * const datePicker = sceneObject.createComponent(DatePicker.getTypeName()) as DatePicker;
 * datePicker.mode = DatePickerMode.Range;
 * datePicker.onSelectionChanged.add((event) => {
 *   print(`Selected: ${event.selectedStartDate?.day} – ${event.selectedEndDate?.day}`);
 * });
 * ```
 *
 * @see {@link Calendar} - The embedded calendar that renders the month grid
 */
@component
export class DatePicker extends BaseScriptComponent {
  public readonly __uikitBrand = UIKitBrands.LayoutContainer

  // ─── Size ───────────────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Size</span>')
  @input
  @label("Width")
  @hint("Width of the field row and the calendar popup, in centimeters.")
  private _width: number = 28

  @input
  @label("Field Height")
  private _fieldHeight: number = 4

  @input
  @label("Calendar Max Height")
  @hint("Maximum popup height — the calendar shrinks to fit shorter months.")
  private _calendarMaxHeight: number = 30

  // ─── Mode ───────────────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Selection</span>')
  @input
  @label("Selection Mode")
  @widget(new ComboBoxWidget([new ComboBoxItem("Single", "Single"), new ComboBoxItem("Range", "Range")]))
  @hint("Single: one date field. Range: start and end date fields.")
  private _mode: string = DatePickerMode.Single

  // ─── Default Date ───────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Default Date</span>')
  @input
  @label("Current Date")
  @hint("Open the calendar on the device's current month and year.")
  private _defaultToCurrentDate: boolean = true

  @input
  @label("Default Date")
  @showIf("_defaultToCurrentDate", false)
  private _defaultDate: DateInput

  // ─── Internal State ─────────────────────────────────────────────────

  private canvasController: CanvasController | null = null
  private readonly canvasSize: vec2 = vec2.zero()

  private readonly state: DatePickerState = {
    children: {
      container: null,
      pendingAuthored: null,
      ownedRootObjects: new Set<SceneObject>()
    },
    fieldRow: {
      object: null,
      start: null,
      end: null,
      separatorObject: null,
      separatorTransform: null,
      separatorText: null,
      startPosition: vec3.zero(),
      endPosition: vec3.zero(),
      separatorPosition: vec3.zero()
    },
    backplate: {
      object: null,
      transform: null,
      rectangle: null,
      position: vec3.zero(),
      size: vec2.zero(),
      // The backplate buffers gradient stops until its own initialization;
      // pushing uniforms before that would touch a missing mesh visual.
      ready: false,
      // Animated halves of the split backplate, each fading in lockstep with
      // the field fill above it.
      startHalf: createPlateHalf(0),
      endHalf: createPlateHalf(1)
    },
    popup: {
      object: null,
      transform: null,
      calendar: null,
      calendarReady: false,
      position: vec3.zero()
    },
    selection: {
      expanded: false,
      // Range mode: the end field was tapped while the selection was empty, so
      // the first picked date renders into the end field (the calendar itself
      // always stores a lone date as its start).
      fillEndFirst: false,
      startDate: null,
      endDate: null,
      // Selection requested before the calendar initialized; last write wins.
      pending: null
    },
    // Latest interaction state per field button, mirrored onto the plate half
    // under it (see updateBackplatePalette).
    fieldStates: {
      start: StateName.default,
      end: StateName.default
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
    subscriptions: {
      unsubscribes: []
    },
    geometry: {
      singleFieldWidth: null,
      singleFieldEditReady: false,
      singleFieldAnchorRefreshSuppressed: false,
      singleFieldAnchorRefreshNeedsFinal: false,
      singleFieldAnchorRefreshFallbackFrames: SINGLE_FIELD_ANCHOR_REFRESH_FALLBACK_INACTIVE,
      singleFieldWidthCancelSet: new CancelSet()
    }
  }

  // ─── Events ─────────────────────────────────────────────────────────

  private readonly events = {
    initialized: new ReplayEvent<void>(),
    selectionChanged: new Event<CalendarSelectionChangedEvent>(),
    expandedChanged: new ReplayEvent<boolean>()
  }

  /**
   * Event fired once the picker and its embedded calendar are built.
   * Replays to late subscribers.
   */
  public readonly onInitialized: PublicApi<void> = this.events.initialized.publicApi()

  /**
   * Event fired whenever the selection changes — each start or end date
   * assignment, including clears. Re-emitted from the embedded calendar
   * after the field visuals have settled. The event payload holds clones.
   */
  public readonly onSelectionChanged: PublicApi<CalendarSelectionChangedEvent> =
    this.events.selectionChanged.publicApi()

  /**
   * Event fired when the calendar popup opens or closes.
   * The event payload is `true` when the popup is open. Replays to late subscribers.
   */
  public readonly onExpandedChanged: PublicApi<boolean> = this.events.expandedChanged.publicApi()

  // ─── Public Properties ──────────────────────────────────────────────

  /**
   * Gets the width of the field row and calendar popup in centimeters.
   * @returns The width in centimeters.
   */
  public get width(): number {
    return this._width
  }

  /**
   * Sets the width of the field row and calendar popup.
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
   * closed field row counts toward layout; the calendar popup overlays
   * content below it.
   * @returns The field row height in centimeters.
   */
  public get height(): number {
    return this._fieldHeight
  }

  /**
   * Sets the layout height — an alias of {@link fieldHeight}, present so
   * parent Layout2D containers (LayoutContainerHandler.apply) can assign
   * the resolved height back. The reported measurement is rigid, so this
   * normally receives the same value {@link computeContentSize} returned.
   * @param value - The field row height in centimeters.
   */
  public set height(value: number) {
    this.fieldHeight = value
  }

  /**
   * Gets the height of the field buttons in centimeters.
   * @returns The field height in centimeters.
   */
  public get fieldHeight(): number {
    return this._fieldHeight
  }

  /**
   * Sets the height of the field buttons.
   * Triggers a batched layout update at the end of the frame.
   * @param value - The field height in centimeters.
   */
  public set fieldHeight(value: number) {
    if (value === undefined || isEqual(value, this._fieldHeight)) return
    this._fieldHeight = value
    this.markLayoutDirty()
  }

  /**
   * Gets the maximum height of the calendar popup in centimeters.
   * @returns The maximum popup height in centimeters.
   */
  public get calendarMaxHeight(): number {
    return this._calendarMaxHeight
  }

  /**
   * Sets the maximum height of the calendar popup.
   * Triggers a batched layout update at the end of the frame.
   * @param value - The maximum popup height in centimeters.
   */
  public set calendarMaxHeight(value: number) {
    if (value === undefined || isEqual(value, this._calendarMaxHeight)) return
    this._calendarMaxHeight = value
    this.markLayoutDirty()
  }

  /**
   * Gets the picker mode.
   * @returns The current mode.
   */
  public get mode(): DatePickerMode {
    return this._mode as DatePickerMode
  }

  /**
   * Sets the picker mode. Switching modes collapses the popup and clears
   * any existing selection — a buffered pre-ready request directly, a live
   * one via the calendar's selection-mode change.
   * @param value - Single for one date field, Range for start and end fields.
   */
  public set mode(value: DatePickerMode) {
    if (value === undefined || isEqual(value, this._mode)) return
    if (value !== DatePickerMode.Single && value !== DatePickerMode.Range) {
      log.w(`DatePicker does not support mode "${value}".`)
      return
    }

    this._mode = value
    this.state.selection.fillEndFirst = false
    // A buffered selection is "existing selection" too: dropping it keeps
    // the pre-ready windows consistent with the live clear below.
    this.state.selection.pending = null
    if (!this.state.lifecycle.initialized) return

    this.collapse()
    if (this.isRangeMode) {
      this.ensureRangeFieldInfrastructure()
    }
    if (this.state.popup.calendar) {
      // Clears any selection; fires onSelectionChanged only when one existed.
      this.state.popup.calendar.selectionMode = this.calendarSelectionMode
    }
    this.markLayoutDirty()
    this.updateFieldVisuals()
  }

  /**
   * Gets whether the picker opens the calendar on the device's current date.
   * @returns True when the device's current date is used as the default date.
   */
  public get defaultToCurrentDate(): boolean {
    return this._defaultToCurrentDate
  }

  /**
   * Sets whether the picker opens the calendar on the device's current date.
   * When disabled, the picker uses {@link defaultYear} and
   * {@link defaultMonth} instead.
   * @param value - True to use the device's current date as the default date.
   */
  public set defaultToCurrentDate(value: boolean) {
    if (value === undefined || value === this._defaultToCurrentDate) return

    this._defaultToCurrentDate = value
    const calendar = this.state.popup.calendar
    if (!calendar) return

    if (value) {
      calendar.defaultToCurrentDate = true
      return
    }

    const defaultDate = this.defaultDate
    calendar.defaultYear = defaultDate.year
    calendar.defaultMonth = defaultDate.month
  }

  /**
   * Gets the authored default year — the fallback used when current-date
   * defaulting is disabled.
   * @returns The default year.
   */
  public get defaultYear(): number {
    return this.defaultDate.year
  }

  /**
   * Sets the default year used when the calendar initializes.
   * Disables current-date defaulting so the explicit default takes effect.
   * @param value - The default year.
   */
  public set defaultYear(value: number) {
    if (value === undefined || !isFinite(value)) return

    const year = Math.floor(value)
    const defaultDate = this.defaultDate
    if (year === defaultDate.year && !this._defaultToCurrentDate) return

    this._defaultToCurrentDate = false
    defaultDate.year = year
    if (this.state.popup.calendar) {
      this.state.popup.calendar.defaultYear = year
    }
  }

  /**
   * Gets the authored default month as a 1-based month number — the fallback
   * used when current-date defaulting is disabled.
   * @returns The default month, where January is 1 and December is 12.
   */
  public get defaultMonth(): number {
    return this.defaultDate.month
  }

  /**
   * Sets the default month as a 1-based month number.
   * Disables current-date defaulting so the explicit default takes effect.
   * @param value - The default month, where January is 1 and December is 12.
   */
  public set defaultMonth(value: number) {
    if (value === undefined || !isFinite(value)) return

    const month = Math.floor(clamp(value, MIN_MONTH, MAX_MONTH))
    const defaultDate = this.defaultDate
    if (month === defaultDate.month && !this._defaultToCurrentDate) return

    this._defaultToCurrentDate = false
    defaultDate.month = month
    if (this.state.popup.calendar) {
      this.state.popup.calendar.defaultMonth = month
    }
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
   * Gets whether the calendar popup is open.
   * @returns True while the popup is open.
   */
  public get expanded(): boolean {
    return this.state.selection.expanded
  }

  /**
   * Gets the selected start date (the only date in Single mode).
   * @returns The selected start date, or null when nothing is selected.
   */
  public get selectedStartDate(): CalendarDate | null {
    if (this.state.popup.calendarReady && this.state.popup.calendar) {
      return this.state.popup.calendar.selectedStartDate
    }
    return cloneDate(this.state.selection.pending?.start ?? null)
  }

  /**
   * Gets the selected end date.
   * @returns The selected end date, or null when the range is incomplete.
   */
  public get selectedEndDate(): CalendarDate | null {
    if (this.state.popup.calendarReady && this.state.popup.calendar) {
      return this.state.popup.calendar.selectedEndDate
    }
    return cloneDate(this.state.selection.pending?.end ?? null)
  }

  /**
   * Gets the embedded calendar — an escape hatch for advanced
   * configuration (view mode, paging). Null before {@link onInitialized}.
   * @returns The embedded Calendar component, or null.
   */
  public get calendar(): Calendar | null {
    return this.state.popup.calendar
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
   * Schedules inherited Canvas bindings for this picker and its embedded
   * calendar to be re-evaluated before rendering. Call this after reparenting
   * the picker or changing ancestor Canvas topology or configuration through
   * raw Lens APIs. A live locally managed Canvas remains authoritative and is
   * not replaced by an ancestor Canvas.
   */
  public invalidateCanvasBinding(): void {
    if (!this.canvasController) {
      return
    }

    this.canvasController.invalidate()
    this.state.popup.calendar?.invalidateCanvasBinding()
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

  /** Opens the calendar popup. */
  public expand(): void {
    this.setExpanded(true)
  }

  /** Closes the calendar popup. */
  public collapse(): void {
    this.setExpanded(false)
  }

  /** Toggles the calendar popup. */
  public toggle(): void {
    this.setExpanded(!this.state.selection.expanded)
  }

  /**
   * Sets the selected date range. Requests made before the embedded
   * calendar initializes are buffered (last write wins) and applied once
   * it is ready. The calendar normalizes the pair so start ≤ end and
   * drops the end date in Single mode.
   * @param startDate - The selected start date, or null to clear.
   * @param endDate - The selected end date, or null for a single date.
   */
  public setSelectedRange(startDate: CalendarDate | null, endDate: CalendarDate | null): void {
    if (this.state.popup.calendarReady && this.state.popup.calendar) {
      this.state.popup.calendar.setSelectedRange(startDate, endDate)
      return
    }
    this.state.selection.pending = {start: cloneDate(startDate), end: cloneDate(endDate)}
  }

  /** Clears the selected date range. */
  public clearSelection(): void {
    this.setSelectedRange(null, null)
  }

  /**
   * Reports the picker's intrinsic size to a parent Layout2D container.
   * Only the closed field row counts — the calendar popup overlays
   * whatever sits below it.
   */
  public computeContentSize(_opts?: {mode?: "preferred" | "min" | "max"}): {width: number; height: number} {
    return {
      width: this._width,
      height: this._fieldHeight
    }
  }

  /** All three modes are locked to the closed field-row size. */
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
   * assigning {@link width} and {@link height} (LayoutContainerHandler.apply).
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

    this.state.children.pendingAuthored = this.getRootContentChildren()
    this.canvasSize.setXY(this._width, this._fieldHeight)
    this.canvasController ??= new CanvasController(this.sceneObject)
    this.canvasController.ensure(this.canvasSize)

    // Create the field-row shell first for deterministic root hierarchy, then
    // build the popup before field visuals so its initial sizing still settles
    // before those visuals are presented.
    this.createFieldRowShell()
    this.createCalendarPopup()
    this.createFieldRowContents()
    if (this.isRangeMode) {
      this.ensureRangeFieldInfrastructure()
    }
    this.createChildrenContainer(this.state.children.pendingAuthored)
    this.state.children.pendingAuthored = null

    this.state.lifecycle.initialized = true
    this.updateLayout()
    this.updateFieldVisuals()
    this.tryCompleteInitialization()
  }

  private updateCanvasSize(): void {
    this.canvasSize.setXY(this._width, this._fieldHeight)
    this.canvasController?.setSize(this.canvasSize)
  }

  private createFieldRowShell(): void {
    if (this.state.fieldRow.object) return

    this.state.fieldRow.object = createChildSceneObjectWithParentLayer(FIELD_ROW_OBJECT_NAME, this.sceneObject)
    this.state.children.ownedRootObjects.add(this.state.fieldRow.object)
  }

  private createFieldRowContents(): void {
    this.createFieldRowShell()
    if (this.state.fieldRow.start) return

    this.createBackplate()
    this.state.fieldRow.start = this.createField(START_FIELD_OBJECT_NAME, "start")
  }

  private createChildrenContainer(authoredChildren: SceneObject[] | null): void {
    if (this.getChildrenContainer()) return

    const authored = authoredChildren ?? []
    const rootContentChildren = this.getRootContentChildren()
    const childrenToMove = [
      ...authored.filter((child) => rootContentChildren.includes(child)),
      ...rootContentChildren.filter((child) => !authored.includes(child))
    ]
    const childrenContainer = global.scene.createSceneObject(CHILDREN_CONTAINER_OBJECT_NAME)
    childrenContainer.layer = this.sceneObject.layer
    childrenContainer.setParent(this.sceneObject)
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

  private ensureRangeFieldInfrastructure(): void {
    if (!this.state.fieldRow.object) return

    if (!this.state.fieldRow.end) {
      this.state.fieldRow.end = this.createField(END_FIELD_OBJECT_NAME, "end")
    }
    if (!this.state.fieldRow.separatorObject) {
      this.createFieldSeparator()
    }
    if (this.state.fieldRow.end.sceneObject.enabled !== this.isRangeMode) {
      this.state.fieldRow.end.sceneObject.enabled = this.isRangeMode
    }
  }

  private createBackplate(): void {
    if (this.state.backplate.object) return

    this.state.backplate.object = createChildSceneObjectWithParentLayer(
      FIELD_BACKPLATE_OBJECT_NAME,
      this.state.fieldRow.object!
    )
    this.state.backplate.transform = this.state.backplate.object.getTransform()
    this.state.backplate.position.setXYZ(0, 0, BACKPLATE_Z_OFFSET)
    this.state.backplate.transform.setLocalPosition(this.state.backplate.position)

    const backplate = this.state.backplate.object.createComponent(RoundedRectangle.getTypeName()) as RoundedRectangle
    this.state.backplate.size.setXY(this._width, this._fieldHeight)
    backplate.size = this.state.backplate.size
    backplate.cornerRadius = DEFAULT_FIELD_CORNER_RADIUS
    backplate.backgroundColor = DatePickerFieldBackplateColor
    // Split-half gradient: both stops start on the resting color; state
    // changes retint them through updateBackplatePalette. Stops are written
    // without an update push until the plate initializes (configureMesh
    // applies the buffered values).
    backplate.gradientType = "Linear"
    backplate.setBackgroundGradientPositions(BACKPLATE_GRADIENT_START, BACKPLATE_GRADIENT_END)
    backplate.setBackgroundGradientStop(
      0,
      {color: DatePickerFieldBackplateColor, percent: BACKPLATE_SPLIT_LEFT_PERCENT, enabled: true},
      false
    )
    backplate.setBackgroundGradientStop(
      1,
      {color: DatePickerFieldBackplateColor, percent: BACKPLATE_SPLIT_RIGHT_PERCENT, enabled: true},
      false
    )
    backplate.gradient = true
    backplate.blendMode = RoundedRectBlendMode.Normal
    backplate.renderOrder = this.state.lifecycle.renderOrder
    this.state.backplate.rectangle = backplate

    this.state.subscriptions.unsubscribes.push(
      backplate.onInitialized.add(() => {
        this.state.backplate.ready = true
        this.updateBackplatePalette()
      })
    )
  }

  private createField(name: string, field: DatePickerField): DatePickerFieldCell {
    const sceneObject = createChildSceneObjectWithParentLayer(name, this.state.fieldRow.object!)

    const button = sceneObject.createComponent(Button.getTypeName()) as Button
    // Custom visual assigned before the button initializes so the preset path
    // is skipped. Its state colors match the plate half beneath it.
    const fieldVisual = new RoundedRectangleVisual({
      sceneObject,
      style: FIELD_VISUAL_STYLE
    })
    button.visual = fieldVisual
    // Toggleable so the active field can drive its toggled state; isOn is
    // reassigned after every interaction rather than trusted (the IK
    // toggle auto-flips before onTriggerUp handlers run).
    button.setIsToggleable(true)
    button.renderOrder = this.state.lifecycle.renderOrder
    const buttonSize = new vec3(this._width, this._fieldHeight, FIELD_BUTTON_DEPTH)
    button.size = buttonSize

    const content = addContentToElement(sceneObject, {
      text: PLACEHOLDER_LABEL,
      textSize: this.fieldTextSize,
      textAlignment: TextAlignment.Center
    })
    content.renderOrder = this.state.lifecycle.renderOrder
    applyContentTextColor(content, DatePickerFieldTextColor)

    const cell: DatePickerFieldCell = {
      sceneObject,
      transform: sceneObject.getTransform(),
      button,
      content,
      buttonSize,
      module: null,
      buttonReady: false,
      moduleReady: false,
      pendingTextRefresh: null,
      labelText: PLACEHOLDER_LABEL
    }

    this.state.subscriptions.unsubscribes.push(
      button.onInitialized.add(() => {
        cell.buttonReady = true
        applyVisualCornerRadius(button.visual, DEFAULT_FIELD_CORNER_RADIUS)
        // Replays the current state immediately, seeding the plate palette.
        this.state.subscriptions.unsubscribes.push(
          button.onStateChanged.add((state) => this.handleFieldStateChanged(field, state))
        )
        let isDragging = false
        this.state.subscriptions.unsubscribes.push(button.onTriggerUp.add(() => this.handleFieldTap(field, isDragging)))
        this.state.subscriptions.unsubscribes.push(
          button.interactable.onDragStart.add(() => {
            isDragging = true
          })
        )
        this.state.subscriptions.unsubscribes.push(
          button.interactable.onDragEnd.add(() => {
            isDragging = false
          })
        )
        this.setupFieldTextManipulationModule(field, cell)
      }),
      content.onInitialized.add(() => this.setupFieldTextManipulationModule(field, cell))
    )

    return cell
  }

  private createFieldSeparator(): void {
    if (this.state.fieldRow.separatorObject) return

    this.state.fieldRow.separatorObject = createChildSceneObjectWithParentLayer(
      FIELD_SEPARATOR_OBJECT_NAME,
      this.state.fieldRow.object!
    )
    this.state.fieldRow.separatorTransform = this.state.fieldRow.separatorObject.getTransform()

    const separatorText = this.state.fieldRow.separatorObject.createComponent("Component.Text") as Text
    separatorText.text = FIELD_SEPARATOR_LABEL
    separatorText.horizontalAlignment = HorizontalAlignment.Center
    separatorText.verticalAlignment = VerticalAlignment.Center
    separatorText.horizontalOverflow = HorizontalOverflow.Truncate
    separatorText.verticalOverflow = VerticalOverflow.Truncate
    separatorText.textFill.color = DatePickerFieldTextColor.clone()
    separatorText.depthTest = true
    this.applyFieldSeparatorTextLayout(separatorText)
    this.applyFieldSeparatorRenderOrder(separatorText, this.state.lifecycle.renderOrder)

    this.state.fieldRow.separatorText = separatorText
  }

  /**
   * Attaches a {@link TextManipulationModule} to a field's label once its Text
   * exists, reusing the field button's interactable. The module stays
   * `active` (so either label is highlightable) but starts non-editable; the
   * caret is driven per active field by {@link updateFieldEditState}.
   */
  private setupFieldTextManipulationModule(field: DatePickerField, cell: DatePickerFieldCell): void {
    if (cell.module) return
    if (!cell.buttonReady) return

    const textComponent = cell.content.textComponent
    if (!textComponent) return

    const moduleObject = createChildSceneObjectWithParentLayer(
      `${cell.sceneObject.name}TextManipulation`,
      cell.sceneObject
    )
    const textModule = moduleObject.createComponent(TextManipulationModule.getTypeName()) as TextManipulationModule
    textModule.textComponent = textComponent
    textModule.interactable = cell.button.interactable
    cell.module = textModule

    this.state.subscriptions.unsubscribes.push(
      textModule.onInitialized.add(() => {
        cell.moduleReady = true
        this.markFieldTextRefresh(cell, {text: cell.labelText})
        if (field === "start") {
          this.flushFinalSingleFieldAnchorRefresh()
        }
        this.updateFieldEditState()
      }),
      textModule.onHighlightUpdated.add((highlightedText) => this.handleFieldHighlightUpdated(field, highlightedText))
    )

    const layout = cell.content.layout
    if (layout) {
      this.state.subscriptions.unsubscribes.push(
        layout.onLayoutComplete.add(() => {
          this.handleFieldLayoutComplete(field, cell)
        })
      )
    }
  }

  private createCalendarPopup(): void {
    if (this.state.popup.object) return

    this.state.popup.object = createChildSceneObjectWithParentLayer(POPUP_OBJECT_NAME, this.sceneObject)
    this.state.children.ownedRootObjects.add(this.state.popup.object)
    this.state.popup.transform = this.state.popup.object.getTransform()

    const calendar = this.state.popup.object.createComponent(Calendar.getTypeName()) as Calendar
    this.state.popup.calendar = calendar
    calendar.width = this._width
    calendar.height = this._calendarMaxHeight
    calendar.selectionMode = this.calendarSelectionMode
    calendar.renderOrder = this.state.lifecycle.renderOrder
    if (!this._defaultToCurrentDate) {
      const defaultDate = this.defaultDate
      calendar.defaultYear = defaultDate.year
      calendar.defaultMonth = defaultDate.month
    }

    this.state.subscriptions.unsubscribes.push(
      calendar.onSelectionChanged.add((event) => this.handleSelectionChanged(event)),
      calendar.onInitialized.add(() => this.handleCalendarInitialized())
    )
  }

  private get defaultDate(): DateInput {
    if (!this._defaultDate) {
      this._defaultDate = new DateInput()
    }
    return this._defaultDate
  }

  // ─── Interaction ────────────────────────────────────────────────────

  private handleCalendarInitialized(): void {
    this.state.popup.calendarReady = true
    if (!this.state.selection.expanded && this.state.popup.object && !isNull(this.state.popup.object)) {
      this.state.popup.object.enabled = false
    }
    this.tryCompleteInitialization()
  }

  /**
   * The embedded calendar can initialize inline while DatePicker is still
   * constructing its own field row. Publish DatePicker initialization only once
   * both sides are ready and the field visuals have received their first layout.
   */
  private tryCompleteInitialization(): void {
    if (this.state.lifecycle.initializedEventFired) return
    if (!this.state.lifecycle.initialized || !this.state.popup.calendarReady) return

    this.applyPendingSelection()
    this.updateFieldVisuals()
    this.state.lifecycle.initializedEventFired = true
    this.events.initialized.invoke()
  }

  private applyPendingSelection(): void {
    if (!this.state.selection.pending || !this.state.popup.calendar) return

    const pending = this.state.selection.pending
    this.state.selection.pending = null
    this.state.popup.calendar.setSelectedRange(pending.start, pending.end)
  }

  private handleFieldTap(field: DatePickerField, isDragging: boolean = false): void {
    if (!this.state.lifecycle.initialized || isDragging) return

    if (!this.state.selection.expanded) {
      if (this.isRangeMode && !this.state.selection.startDate) {
        this.state.selection.fillEndFirst = field === "end"
      }
      this.expand()
      return
    }

    if (field === this.activeField) {
      this.collapse()
      return
    }

    if (this.isRangeMode && !this.state.selection.startDate) {
      // Both fields empty — switch which one the first pick fills.
      this.state.selection.fillEndFirst = field === "end"
      this.updateFieldVisuals()
      return
    }

    this.collapse()
  }

  /**
   * Fires on every calendar selection change, including clears. The
   * payload arrives normalized (start ≤ end), so an end-first pick pair
   * lands in the right fields without extra work here.
   */
  private handleSelectionChanged(event: CalendarSelectionChangedEvent): void {
    this.state.selection.startDate = cloneDate(event.selectedStartDate)
    this.state.selection.endDate = cloneDate(event.selectedEndDate)

    const rangeComplete = event.selectedStartDate !== null && event.selectedEndDate !== null
    const cleared = event.selectedStartDate === null && event.selectedEndDate === null
    // Reset fill order when the entry ends — completion or full clear — so
    // fillEndFirst means "an end-first entry is in progress" and nothing
    // else. Gated to the fully-cleared branch so the partial end-first state
    // (start set, end null) keeps the flag it relies on.
    if (rangeComplete || cleared) {
      this.state.selection.fillEndFirst = false
    }

    this.updateFieldVisuals()

    // Auto-close on completion; clears never close, so tap-to-clear inside
    // the popup leaves it open for re-selection.
    if (this.isRangeMode ? rangeComplete : event.selectedStartDate !== null) {
      this.collapse()
    }

    this.events.selectionChanged.invoke({
      selectedStartDate: cloneDate(this.state.selection.startDate),
      selectedEndDate: cloneDate(this.state.selection.endDate)
    })
  }

  private setExpanded(expanded: boolean): void {
    if (this.state.selection.expanded === expanded) return

    this.state.selection.expanded = expanded
    if (this.state.lifecycle.initialized) {
      if (this.state.popup.object && !isNull(this.state.popup.object)) {
        this.state.popup.object.enabled = expanded
      }
      if (expanded && this.state.popup.calendar) {
        // Flush any layout work batched while the popup was disabled.
        this.state.popup.calendar.forceLayout()
      }
      if (this.isRangeMode) {
        this.ensureRangeFieldInfrastructure()
        this.state.geometry.singleFieldWidthCancelSet()
        this.clearSingleFieldAnchorRefreshState()
      } else {
        this.animateSingleFieldGeometry(expanded)
      }
      this.updateFieldSeparatorVisibility()
      this.updateFieldHighlights()
    }
    this.events.expandedChanged.invoke(expanded)
  }

  // ─── Field Visuals ──────────────────────────────────────────────────

  /**
   * The field the next calendar tap fills. Pure function of the cached
   * selection and fillEndFirst; every interaction path re-renders
   * from it so the visuals can't desynchronize.
   */
  private get activeField(): DatePickerField {
    if (!this.isRangeMode) return "start"
    if (!this.state.selection.startDate) return this.state.selection.fillEndFirst ? "end" : "start"
    if (!this.state.selection.endDate) return this.state.selection.fillEndFirst ? "start" : "end"
    // Complete range — the next tap outside it starts a new one.
    return "start"
  }

  private updateFieldVisuals(): void {
    if (!this.state.lifecycle.initialized) return
    if (this.isRangeMode) {
      this.ensureRangeFieldInfrastructure()
    }

    this.updateFieldLabels()
    this.updateFieldHighlights()
    this.updateBackplatePalette()
  }

  private handleFieldStateChanged(field: DatePickerField, state: StateName): void {
    if (field === "start") {
      this.state.fieldStates.start = state
    } else {
      this.state.fieldStates.end = state
    }
    this.updateBackplatePalette()
    this.updateFieldSeparatorVisibility()
  }

  private fieldStateHidesSeparator(state: StateName): boolean {
    return (
      state === StateName.hovered ||
      state === StateName.toggledHovered ||
      state === StateName.triggered ||
      state === StateName.toggledTriggered
    )
  }

  /**
   * Retints the plate halves to the colors of the field-button states
   * resting on them. In Single mode the lone field owns the whole plate,
   * so both stops share its color.
   *
   * Each half fades over its own button visual's animateDuration so the
   * plate moves in lockstep with the field fill on top — including the
   * zero-duration window {@link setButtonToggledImmediate} opens, where
   * both layers snap together.
   */
  private updateBackplatePalette(): void {
    if (!this.state.backplate.rectangle) return

    const startColor = DatePickerFieldStatePlateColors[this.state.fieldStates.start] ?? DatePickerFieldBackplateColor
    const endColor = this.isRangeMode
      ? (DatePickerFieldStatePlateColors[this.state.fieldStates.end] ?? DatePickerFieldBackplateColor)
      : startColor
    const startDuration = this.state.fieldRow.start?.button.visual?.animateDuration ?? 0
    // In Single mode the lone field owns the whole plate, so both halves
    // move with its fade.
    const endDuration = this.isRangeMode
      ? (this.state.fieldRow.end?.button.visual?.animateDuration ?? 0)
      : startDuration
    this.animatePlateHalf(this.state.backplate.startHalf, startColor, startDuration)
    this.animatePlateHalf(this.state.backplate.endHalf, endColor, endDuration)
  }

  /**
   * Fades one plate half toward a target color. An unchanged target leaves
   * the in-flight fade untouched. The field visual renders the same color
   * above it, so both layers stay visually aligned through state changes.
   */
  private animatePlateHalf(half: DatePickerPlateHalf, targetColor: vec4, durationSeconds: number): void {
    if (isEqual(half.targetColor, targetColor)) return

    half.targetColor.copyFrom(targetColor)
    half.cancelSet()

    // Pre-init writes buffer (configureMesh applies them); zero duration
    // snaps — both reuse the direct-write path.
    if (!this.state.backplate.ready || durationSeconds <= 0) {
      half.displayColor.copyFrom(targetColor)
      this.state.backplate.rectangle?.setBackgroundGradientStop(
        half.stopIndex,
        {color: half.displayColor},
        this.state.backplate.ready
      )
      return
    }

    const initialColor = half.displayColor.clone()
    animate({
      cancelSet: half.cancelSet,
      duration: durationSeconds,
      update: (t) => {
        half.displayColor.r = initialColor.r + (targetColor.r - initialColor.r) * t
        half.displayColor.g = initialColor.g + (targetColor.g - initialColor.g) * t
        half.displayColor.b = initialColor.b + (targetColor.b - initialColor.b) * t
        half.displayColor.a = initialColor.a + (targetColor.a - initialColor.a) * t
        this.state.backplate.rectangle?.setBackgroundGradientStop(half.stopIndex, {color: half.displayColor}, true)
      }
    })
  }

  private updateFieldLabels(): void {
    if (!this.state.fieldRow.start) return

    const start = this.state.selection.startDate
    const end = this.state.selection.endDate

    if (!this.isRangeMode) {
      this.setFieldLabel(this.state.fieldRow.start, start ? formatCalendarDate(start) : PLACEHOLDER_LABEL)
      return
    }

    this.ensureRangeFieldInfrastructure()
    const endField = this.state.fieldRow.end
    if (!endField) return

    // A lone end-first pick is stored by the calendar as its start date but
    // renders into the end field.
    const endFirstPending = this.isEndFirstPendingSelection()
    this.setFieldLabel(
      this.state.fieldRow.start,
      start && !endFirstPending ? formatCalendarDate(start) : PLACEHOLDER_LABEL
    )
    this.setFieldLabel(
      endField,
      end ? formatCalendarDate(end) : endFirstPending ? formatCalendarDate(start!) : PLACEHOLDER_LABEL
    )
  }

  /**
   * Sets a field's label and keeps its text-manipulation module in step. The
   * module's internal text drives caret/highlight character conversions, so it
   * must mirror the rendered label.
   */
  private setFieldLabel(cell: DatePickerFieldCell, label: string): void {
    if (cell.labelText !== label) {
      cell.labelText = label
      cell.content.text = label
      if (cell.module && cell.moduleReady) {
        this.markFieldTextRefresh(cell, {text: label})
      }
    }
  }

  private isEndFirstPendingSelection(): boolean {
    return (
      this.isRangeMode &&
      this.state.selection.fillEndFirst &&
      this.state.selection.startDate !== null &&
      this.state.selection.endDate === null
    )
  }

  private updateFieldHighlights(): void {
    if (!this.state.fieldRow.start) return
    if (this.isRangeMode) {
      this.ensureRangeFieldInfrastructure()
    }

    const active = this.state.selection.expanded ? this.activeField : null
    // Toggle without the state-transition fade so reassigning highlights
    // after the IK toggle auto-flips is invisible.
    setButtonToggledImmediate(this.state.fieldRow.start.button, active === "start")
    if (this.state.fieldRow.end) {
      setButtonToggledImmediate(this.state.fieldRow.end.button, active === "end")
    }

    this.updateFieldEditState()
  }

  /**
   * Drives each field label's caret. Only the active field while the popup is
   * open is editable, and its caret is pinned to the end of the label. Both
   * fields stay highlightable regardless (the module's `active` flag is left
   * on); only the caret differs.
   */
  private updateFieldEditState(): void {
    this.applyFieldEditState(this.state.fieldRow.start, "start")
    this.applyFieldEditState(this.state.fieldRow.end, "end")
  }

  private applyFieldEditState(cell: DatePickerFieldCell | null, field: DatePickerField): void {
    if (!cell || !cell.module || !cell.moduleReady) return

    const editable = this.fieldCanShowCaret(field)
    cell.module.isEditable = editable
    if (editable) {
      this.pinCaretToEnd(cell)
    }
  }

  private fieldCanShowCaret(field: DatePickerField): boolean {
    if (!this.state.selection.expanded || this.activeField !== field) return false
    return this.isRangeMode || this.state.geometry.singleFieldEditReady
  }

  /**
   * Collapses any highlight and places the caret at the end of the label. The
   * character index is resolved against cursor positions inside the module's
   * own flush, so this stays correct even when the label just changed and the
   * text geometry has not caught up. A no-op for the caret on a non-editable
   * field (it simply clears the highlight).
   */
  private pinCaretToEnd(cell: DatePickerFieldCell): void {
    if (!cell.module || !cell.moduleReady) return
    cell.module.caretIndex = cell.labelText.length
  }

  /**
   * Keeps a single highlight across the two fields: when one field reports a
   * non-empty highlight, the other's is cleared. The other field keeps its end
   * caret if it is the active editable one; otherwise it clears with no caret.
   * Empty payloads (the clear itself) are ignored so the two fields don't
   * ping-pong.
   */
  private handleFieldHighlightUpdated(field: DatePickerField, highlightedText: string): void {
    if (highlightedText.length === 0) return

    const otherField: DatePickerField = field === "start" ? "end" : "start"
    const other = this.fieldCell(otherField)
    if (!other || !other.module || !other.moduleReady) return

    if (this.state.selection.expanded && this.activeField === otherField) {
      this.pinCaretToEnd(other)
    } else {
      other.module.setHighlightByCharIndex(0, 0)
    }
  }

  private fieldCell(field: DatePickerField): DatePickerFieldCell | null {
    return field === "start" ? this.state.fieldRow.start : this.state.fieldRow.end
  }

  private markFieldTextRefresh(cell: DatePickerFieldCell, reasons: TextManipulationRefreshReasons): void {
    cell.pendingTextRefresh = {
      ...(cell.pendingTextRefresh ?? {}),
      ...reasons
    }
    this.batchUpdate()
  }

  private handleFieldLayoutComplete(field: DatePickerField, cell: DatePickerFieldCell): void {
    if (!cell.module || !cell.moduleReady) return

    if (this.shouldSuppressFieldAnchorRefresh(field)) {
      this.state.geometry.singleFieldAnchorRefreshNeedsFinal = true
      return
    }

    if (this.shouldFlushFinalSingleFieldAnchorRefresh(field)) {
      this.flushFinalSingleFieldAnchorRefresh()
      return
    }

    this.markFieldTextRefresh(cell, {fromAnchors: true})
  }

  private shouldSuppressFieldAnchorRefresh(field: DatePickerField): boolean {
    return field === "start" && !this.isRangeMode && this.state.geometry.singleFieldAnchorRefreshSuppressed
  }

  private shouldFlushFinalSingleFieldAnchorRefresh(field: DatePickerField): boolean {
    return field === "start" && !this.isRangeMode && this.state.geometry.singleFieldAnchorRefreshNeedsFinal
  }

  private hasPendingFieldTextRefreshes(): boolean {
    return !!this.state.fieldRow.start?.pendingTextRefresh || !!this.state.fieldRow.end?.pendingTextRefresh
  }

  private hasPendingSingleFieldAnchorRefreshFallback(): boolean {
    return this.state.geometry.singleFieldAnchorRefreshFallbackFrames !== SINGLE_FIELD_ANCHOR_REFRESH_FALLBACK_INACTIVE
  }

  private flushFieldTextRefresh(cell: DatePickerFieldCell | null): void {
    if (!cell || !cell.pendingTextRefresh) return
    if (!cell.module || !cell.moduleReady) return

    const reasons = cell.pendingTextRefresh
    cell.pendingTextRefresh = null
    cell.module.refresh(reasons)
  }

  private flushFieldTextRefreshes(): void {
    this.flushFieldTextRefresh(this.state.fieldRow.start)
    this.flushFieldTextRefresh(this.state.fieldRow.end)
  }

  // ─── Batched Updates ────────────────────────────────────────────────

  private markLayoutDirty(): void {
    if (!this.state.lifecycle.initialized) return
    this.state.batch.layoutDirty = true
    this.batchUpdate()
  }

  private batchUpdate(): void {
    this.state.batch.updateEvent.enabled = true
  }

  private flushBatchedUpdatesAndUpdateEvent(): void {
    this.state.batch.updateEvent.enabled = false
    try {
      this.flushBatchedUpdates()
    } finally {
      this.state.batch.updateEvent.enabled = this.hasPendingBatchedUpdates()
    }
  }

  private hasPendingBatchedUpdates(): boolean {
    return (
      this.state.batch.canvasBindingDirty ||
      this.state.batch.layoutDirty ||
      this.hasPendingFieldTextRefreshes() ||
      this.hasPendingSingleFieldAnchorRefreshFallback()
    )
  }

  private flushBatchedUpdates(): void {
    const canvasBindingDirty = this.state.batch.canvasBindingDirty
    const layoutDirty = this.state.batch.layoutDirty
    this.state.batch.canvasBindingDirty = false
    this.state.batch.layoutDirty = false

    try {
      this.flushFieldTextRefreshes()

      if (layoutDirty) {
        this.updateLayout()
      }

      this.flushSingleFieldAnchorRefreshFallback()
      if (canvasBindingDirty) {
        this.canvasController?.reconcile()
      }
    } catch (error) {
      if (canvasBindingDirty) {
        this.state.batch.canvasBindingDirty = true
      }
      throw error
    }
  }

  // ─── Layout ─────────────────────────────────────────────────────────

  private updateLayout(): void {
    this.updateCanvasSize()
    if (!this.state.fieldRow.start) return

    // Popup first: it syncs the calendar width
    this.updatePopupLayout()
    this.updateFieldRowLayout()
  }

  private updateFieldRowLayout(): void {
    if (!this.state.fieldRow.start) return

    const range = this.isRangeMode
    this.prepareSingleFieldAnchorRefreshForRowLayout(range)

    if (range) {
      this.ensureRangeFieldInfrastructure()
    }

    const endField = this.state.fieldRow.end
    if (endField && endField.sceneObject.enabled !== range) {
      endField.sceneObject.enabled = range
    }
    this.updateFieldSeparatorVisibility()

    if (range) {
      this.applyRangeFieldGeometry()
    } else {
      this.applySingleFieldGeometry(this.singleFieldTargetWidth)
      this.state.geometry.singleFieldEditReady = this.state.selection.expanded
      this.updateFieldEditState()
    }

    this.updateFieldSeparatorLayout()
  }

  private applyRangeFieldGeometry(): void {
    if (!this.state.fieldRow.start) return
    this.ensureRangeFieldInfrastructure()
    const endField = this.state.fieldRow.end
    if (!endField) return

    const fieldWidth = this.rangeFieldWidth
    this.state.geometry.singleFieldWidth = this.collapsedSingleFieldWidth
    this.applyBackplateGeometry(this._width, this.rowLeftEdge)
    this.updateFieldCellLayout(this.state.fieldRow.start, fieldWidth)
    this.updateFieldCellLayout(endField, fieldWidth)
    this.applyFieldCellPosition(
      this.state.fieldRow.start,
      this.state.fieldRow.startPosition,
      this.rowLeftEdge,
      fieldWidth
    )
    this.applyFieldCellPosition(endField, this.state.fieldRow.endPosition, 0, fieldWidth)
  }

  private applySingleFieldGeometry(fieldWidth: number): void {
    if (!this.state.fieldRow.start) return

    this.state.geometry.singleFieldWidth = fieldWidth
    this.applyBackplateGeometry(fieldWidth, this.rowLeftEdge)
    this.updateFieldCellLayout(this.state.fieldRow.start, fieldWidth)
    this.applyFieldCellPosition(
      this.state.fieldRow.start,
      this.state.fieldRow.startPosition,
      this.rowLeftEdge,
      fieldWidth
    )
  }

  private animateSingleFieldGeometry(expanded: boolean): void {
    if (!this.state.fieldRow.start) return

    this.state.geometry.singleFieldWidthCancelSet()
    this.clearSingleFieldAnchorRefreshState()

    const startWidth = this.currentSingleFieldWidth
    const targetWidth = this.singleFieldTargetWidth
    if (isEqual(startWidth, targetWidth)) {
      this.applySingleFieldGeometry(targetWidth)
      this.state.geometry.singleFieldEditReady = expanded
      this.updateFieldEditState()
      return
    }

    this.state.geometry.singleFieldEditReady = false
    this.updateFieldEditState()
    this.beginSingleFieldAnchorRefreshSuppression()
    animate({
      duration: FIELD_GEOMETRY_ANIMATION_DURATION,
      easing: expanded ? "ease-out-sine" : "ease-in-sine",
      cancelSet: this.state.geometry.singleFieldWidthCancelSet,
      update: (t: number) => {
        this.applySingleFieldGeometry(startWidth + (targetWidth - startWidth) * t)
      },
      ended: () => {
        if (this.isRangeMode) {
          this.clearSingleFieldAnchorRefreshState()
          return
        }
        this.finishSingleFieldAnchorRefreshSuppression()
        this.state.geometry.singleFieldEditReady = expanded
        this.updateFieldEditState()
      }
    })
  }

  private beginSingleFieldAnchorRefreshSuppression(): void {
    this.state.geometry.singleFieldAnchorRefreshSuppressed = true
    this.state.geometry.singleFieldAnchorRefreshNeedsFinal = false
  }

  private finishSingleFieldAnchorRefreshSuppression(): void {
    this.state.geometry.singleFieldAnchorRefreshSuppressed = false
    this.state.geometry.singleFieldAnchorRefreshNeedsFinal = true
    // Prefer the next post-suppression layout callback. If no layout callback
    // arrives, fall back after a couple of LateUpdates so the final geometry
    // still gets one anchor refresh.
    this.state.geometry.singleFieldAnchorRefreshFallbackFrames = SINGLE_FIELD_ANCHOR_REFRESH_FALLBACK_FRAMES
    this.batchUpdate()
  }

  private flushFinalSingleFieldAnchorRefresh(): void {
    if (!this.state.geometry.singleFieldAnchorRefreshNeedsFinal) return
    if (this.isRangeMode) return
    if (this.state.geometry.singleFieldAnchorRefreshSuppressed) return

    const start = this.state.fieldRow.start
    if (!start || !start.module || !start.moduleReady) return

    this.state.geometry.singleFieldAnchorRefreshNeedsFinal = false
    this.state.geometry.singleFieldAnchorRefreshFallbackFrames = SINGLE_FIELD_ANCHOR_REFRESH_FALLBACK_INACTIVE
    this.markFieldTextRefresh(start, {fromAnchors: true})
  }

  private flushSingleFieldAnchorRefreshFallback(): void {
    const fallbackFrames = this.state.geometry.singleFieldAnchorRefreshFallbackFrames
    if (fallbackFrames === SINGLE_FIELD_ANCHOR_REFRESH_FALLBACK_INACTIVE) return
    if (!this.state.geometry.singleFieldAnchorRefreshNeedsFinal) {
      this.state.geometry.singleFieldAnchorRefreshFallbackFrames = SINGLE_FIELD_ANCHOR_REFRESH_FALLBACK_INACTIVE
      return
    }

    if (fallbackFrames > 1) {
      this.state.geometry.singleFieldAnchorRefreshFallbackFrames = fallbackFrames - 1
      return
    }

    this.flushFinalSingleFieldAnchorRefresh()
  }

  // Row layout can coalesce with animation completion; preserve an owed final
  // anchor refresh through single-mode snaps, but drop it for range replacement.
  private prepareSingleFieldAnchorRefreshForRowLayout(range: boolean): void {
    const wasSuppressing = this.state.geometry.singleFieldAnchorRefreshSuppressed
    const needsFinalRefresh = this.state.geometry.singleFieldAnchorRefreshNeedsFinal
    this.state.geometry.singleFieldWidthCancelSet()

    if (range) {
      this.clearSingleFieldAnchorRefreshState()
      return
    }

    if (wasSuppressing) {
      this.finishSingleFieldAnchorRefreshSuppression()
      return
    }

    if (needsFinalRefresh) {
      this.state.geometry.singleFieldAnchorRefreshFallbackFrames = SINGLE_FIELD_ANCHOR_REFRESH_FALLBACK_FRAMES
      this.batchUpdate()
      return
    }

    this.clearSingleFieldAnchorRefreshState()
  }

  private clearSingleFieldAnchorRefreshState(): void {
    this.state.geometry.singleFieldAnchorRefreshSuppressed = false
    this.state.geometry.singleFieldAnchorRefreshNeedsFinal = false
    this.state.geometry.singleFieldAnchorRefreshFallbackFrames = SINGLE_FIELD_ANCHOR_REFRESH_FALLBACK_INACTIVE
  }

  private applyBackplateGeometry(width: number, leftEdge: number): void {
    if (this.state.backplate.rectangle) {
      const backplateSize = this.state.backplate.rectangle.size
      if (backplateSize.x !== width || backplateSize.y !== this._fieldHeight) {
        this.state.backplate.size.setXY(width, this._fieldHeight)
        this.state.backplate.rectangle.size = this.state.backplate.size
      }
    }

    if (this.state.backplate.transform) {
      this.state.backplate.position.setXYZ(this.centerXForLeftEdge(leftEdge, width), 0, BACKPLATE_Z_OFFSET)
      this.state.backplate.transform.setLocalPosition(this.state.backplate.position)
    }
  }

  private applyFieldCellPosition(
    field: DatePickerFieldCell,
    position: vec3,
    leftEdge: number,
    fieldWidth: number
  ): void {
    position.setXYZ(this.centerXForLeftEdge(leftEdge, fieldWidth), 0, 0)
    field.transform.setLocalPosition(position)
  }

  private updateFieldCellLayout(field: DatePickerFieldCell, fieldWidth: number): void {
    const currentSize = field.button.size
    if (currentSize.x !== fieldWidth || currentSize.y !== this._fieldHeight || currentSize.z !== FIELD_BUTTON_DEPTH) {
      field.buttonSize.setXYZ(fieldWidth, this._fieldHeight, FIELD_BUTTON_DEPTH)
      field.button.size = field.buttonSize
    }
    const textSize = this.fieldTextSize
    if (field.content.textSize !== textSize) {
      field.content.textSize = textSize
      if (field.module && field.moduleReady) {
        this.markFieldTextRefresh(field, {fromFontSize: true})
      }
    }
  }

  private updateFieldSeparatorLayout(): void {
    if (!this.state.fieldRow.separatorTransform || !this.state.fieldRow.separatorText) return

    this.state.fieldRow.separatorPosition.setXYZ(0, 0, FIELD_SEPARATOR_TEXT_Z_OFFSET)
    this.state.fieldRow.separatorTransform.setLocalPosition(this.state.fieldRow.separatorPosition)

    this.applyFieldSeparatorTextLayout(this.state.fieldRow.separatorText)
  }

  private updateFieldSeparatorVisibility(): void {
    if (!this.state.fieldRow.separatorObject || isNull(this.state.fieldRow.separatorObject)) return

    const visible =
      this.isRangeMode &&
      !this.state.selection.expanded &&
      !this.fieldStateHidesSeparator(this.state.fieldStates.start) &&
      !this.fieldStateHidesSeparator(this.state.fieldStates.end)
    if (this.state.fieldRow.separatorObject.enabled !== visible) {
      this.state.fieldRow.separatorObject.enabled = visible
    }
  }

  private updatePopupLayout(): void {
    if (!this.state.popup.transform) return

    // Sits POPUP_VERTICAL_GAP below the field row. The calendar's origin is
    // its full-height center with the background top edge pinned at
    // +height/2, so the gap holds when short months shrink the background
    // upward-pinned (Calendar.applyBackgroundFit).
    this.state.popup.position.setXYZ(
      0,
      -(this._fieldHeight / 2 + POPUP_VERTICAL_GAP + this._calendarMaxHeight / 2),
      POPUP_Z_OFFSET
    )
    this.state.popup.transform.setLocalPosition(this.state.popup.position)

    if (this.state.popup.calendar) {
      this.state.popup.calendar.width = this._width
      this.state.popup.calendar.height = this._calendarMaxHeight

      if (this.state.selection.expanded) {
        this.state.popup.calendar.forceLayout()
      }
    }
  }

  private updateRenderOrder(value: number): void {
    if (this.state.backplate.rectangle) {
      this.state.backplate.rectangle.renderOrder = value
    }
    if (this.state.fieldRow.start) {
      this.state.fieldRow.start.button.renderOrder = value
      this.state.fieldRow.start.content.renderOrder = value
    }
    if (this.state.fieldRow.end) {
      this.state.fieldRow.end.button.renderOrder = value
      this.state.fieldRow.end.content.renderOrder = value
    }
    if (this.state.fieldRow.separatorText) {
      this.applyFieldSeparatorRenderOrder(this.state.fieldRow.separatorText, value)
    }
    if (this.state.popup.calendar) {
      this.state.popup.calendar.renderOrder = value
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private get isRangeMode(): boolean {
    return this._mode === DatePickerMode.Range
  }

  private applyFieldSeparatorTextLayout(text: Text): void {
    text.size = this.fieldTextSize
    setTextRect(text, text.sceneObject, this.fieldSeparatorWidth, this._fieldHeight)
  }

  private applyFieldSeparatorRenderOrder(text: Text, value: number): void {
    text.renderOrder = value
  }

  private get calendarSelectionMode(): CalendarSelectionMode {
    return this.isRangeMode ? CalendarSelectionMode.Range : CalendarSelectionMode.Single
  }

  private centerXForLeftEdge(leftEdge: number, width: number): number {
    return leftEdge + width * 0.5
  }

  private get rowLeftEdge(): number {
    return -this._width * 0.5
  }

  private get rangeFieldWidth(): number {
    return this._width * 0.5
  }

  private get collapsedSingleFieldWidth(): number {
    return this._width * 0.5
  }

  private get singleFieldTargetWidth(): number {
    return this.state.selection.expanded ? this._width : this.collapsedSingleFieldWidth
  }

  private get currentSingleFieldWidth(): number {
    if (this.state.geometry.singleFieldWidth !== null) {
      return this.state.geometry.singleFieldWidth
    }

    return this.singleFieldTargetWidth
  }

  private get fieldSeparatorWidth(): number {
    return Math.max(this._fieldHeight, 1)
  }

  // Text sizes derive from the heights they sit in, the same scale
  // TextInputField uses (computeFontSize: size.y * FONT_SIZE_SCALE).
  private get fieldTextSize(): number {
    return this._fieldHeight * FONT_SIZE_SCALE
  }

  // ─── Teardown ───────────────────────────────────────────────────────

  private onDestroy(): void {
    const canvasController = this.canvasController
    this.canvasController = null
    this.state.lifecycle.releasing = true
    try {
      // Flip initialized first so in-flight button callbacks early-return
      // instead of touching natives being torn down.
      this.state.lifecycle.initialized = false
      this.state.lifecycle.initializedEventFired = false
      this.state.popup.calendarReady = false
      this.state.backplate.ready = false
      this.state.batch.canvasBindingDirty = false
      this.state.batch.layoutDirty = false
      this.state.children.pendingAuthored = null
      this.state.backplate.startHalf.cancelSet()
      this.state.backplate.endHalf.cancelSet()
      this.state.geometry.singleFieldWidthCancelSet()
      this.state.geometry.singleFieldWidth = null
      this.state.geometry.singleFieldEditReady = false
      this.clearSingleFieldAnchorRefreshState()

      for (let i = 0; i < this.state.subscriptions.unsubscribes.length; i++) {
        this.state.subscriptions.unsubscribes[i]()
      }
      this.state.subscriptions.unsubscribes = []

      // Developer children must leave the foreground wrapper before any
      // picker-owned roots are destroyed.
      this.restoreChildrenContainer()
      this.destroyOwnedRootObjects()

      this.state.fieldRow.object = null
      this.state.backplate.object = null
      this.state.backplate.transform = null
      this.state.backplate.rectangle = null
      this.state.fieldRow.start = null
      this.state.fieldRow.end = null
      this.state.fieldRow.separatorObject = null
      this.state.fieldRow.separatorTransform = null
      this.state.fieldRow.separatorText = null
      this.state.popup.object = null
      this.state.popup.transform = null
      this.state.popup.calendar = null
    } finally {
      canvasController?.release()
    }
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

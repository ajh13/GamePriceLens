import animate, {CancelSet, mix} from "InteractionKit.lspkg/Utils/animate"
import Event, {PublicApi} from "InteractionKit.lspkg/Utils/Event"
import {clamp} from "InteractionKit.lspkg/Utils/mathUtils"
import ReplayEvent from "InteractionKit.lspkg/Utils/ReplayEvent"
import {
  CalendarBackgroundColor,
  CalendarCellButtonTextColor,
  CalendarDayHeaderTextColor,
  CalendarRectangleButtonTextColor,
  CalendarTodayIndicatorColor,
  CalendarWeekendHeaderTextColor,
  HighlightDefaultColor
} from "../../Themes/System-3.0/Colors"
import {System3, System3Styles} from "../../Themes/System-3.0/System3"
import {CanvasController} from "../../Utility/CanvasController"
import {
  createChildSceneObjectWithParentLayer,
  isBeingDestroyedError,
  isSceneObjectAncestorOf,
  reparentExternalChild,
  unparentExternalChild
} from "../../Utility/SceneUtilities"
import {configureScreenTransformToFillParent, enableDepthOcclusion, toCmString} from "../../Utility/UIKitUtilities"
import {RoundedRectangle, RoundedRectBlendMode} from "../../Visuals/RoundedRectangle/RoundedRectangle"
import {Button, DEFAULT_BUTTON_CORNER_RADIUS} from "../Button/Button"
import {ElementContent, TextAlignment} from "../Content/ElementContent"
import {addContentToElement} from "../Content/ElementContentFactory"
import {GridItem} from "../Layout2D/Grid/GridItem"
import {GridLayout} from "../Layout2D/Grid/GridLayout"
import {GridAlign} from "../Layout2D/Grid/GridTypes"
import {UIKitBrands} from "../Layout2D/UIKitBrands"
import {
  applyContentTextColor,
  areDatesConsecutive,
  areDatesEqual,
  areNullableDatesEqual,
  CalendarDate,
  cloneDate,
  compareDates,
  DAY_NAMES,
  DAYS_PER_WEEK,
  getDaysInMonth,
  getDecadeStart,
  getDeviceDate,
  getFirstDayColumn,
  isDateInRange,
  MAX_MONTH,
  MIN_MONTH,
  MONTH_NAMES,
  normalizeMonth,
  setButtonToggledImmediate
} from "./CalendarUtilities"

export enum CalendarViewMode {
  Dates = "Dates",
  Months = "Months",
  Years = "Years"
}

export enum CalendarSelectionMode {
  None = "None",
  Single = "Single",
  Range = "Range"
}

export type CalendarSelectionChangedEvent = {
  selectedStartDate: CalendarDate | null
  selectedEndDate: CalendarDate | null
}

type CalendarButtonStyle = "Ghost" | "PrismGhost"

type CalendarCell = {
  sceneObject: SceneObject
  gridItem: GridItem
  content: ElementContent
  button?: Button
}

type CalendarHighlight = {
  sceneObject: SceneObject
  transform: Transform
  rectangle: RoundedRectangle
  localPosition: vec3
  size: vec2
}

type CalendarCellOptions = {
  name: string
  text: string
  textSize: number
  textColor: vec4
  buttonStyle?: CalendarButtonStyle
  toggleable?: boolean
  onTriggerUp?: () => void
  onHoverEnter?: () => void
  onHoverExit?: () => void
}

type CalendarModeConfig = {
  templateRows: () => string
  fittedHeight: () => number
  centerDisabled: boolean
  renderView: () => void
}

type CalendarGridState = {
  object: SceneObject | null
  transform: Transform | null
  layout: GridLayout | null
}

type CalendarBackgroundState = {
  object: SceneObject | null
  transform: Transform | null
  rectangle: RoundedRectangle | null
  fitHeight: number
}

type CalendarHighlightsState = {
  rangeLayer: SceneObject | null
  todayLayer: SceneObject | null
  range: CalendarHighlight[]
  today: CalendarHighlight | null
}

type CalendarCellsState = {
  leftButton: CalendarCell | null
  centerButton: CalendarCell | null
  rightButton: CalendarCell | null
  dayLabels: CalendarCell[]
  dateButtons: CalendarCell[]
  monthButtons: CalendarCell[]
  yearButtons: CalendarCell[]
  activeItems: GridItem[]
}

type CalendarViewState = {
  mode: CalendarViewMode
  displayMonthIndex: number
  displayYear: number
  yearsStart: number
  yearPageAnchorStart: number
  deviceToday: CalendarDate
  pendingRender: boolean
  renderedMode: CalendarViewMode
  hasRendered: boolean
}

type CalendarSelectionState = {
  startDate: CalendarDate | null
  endDate: CalendarDate | null
  hoverDate: CalendarDate | null
}

type CalendarLifecycleState = {
  renderOrder: number
  initialized: boolean
}

type CalendarBatchState = {
  updateEvent: SceneEvent | null
  canvasBindingDirty: boolean
  layoutDirty: boolean
  viewDirty: boolean
  selectionDirty: boolean
}

type CalendarScratchState = {
  gridLocalPosition: vec3
  backgroundLocalPosition: vec3
  backgroundSize: vec2
  buttonSize: vec3
  backgroundFitCancelSet: CancelSet
}

type CalendarMetricsState = {
  scalesDirty: boolean
  sizeScale: number
  heightScale: number
}

type CalendarState = {
  childrenContainer: SceneObject | null
  grid: CalendarGridState
  background: CalendarBackgroundState
  highlights: CalendarHighlightsState
  cells: CalendarCellsState
  view: CalendarViewState
  selection: CalendarSelectionState
  lifecycle: CalendarLifecycleState
  batch: CalendarBatchState
  scratch: CalendarScratchState
  metrics: CalendarMetricsState
}

const CALENDAR_GRID_OBJECT_NAME = "CalendarGrid"
const CALENDAR_BACKGROUND_OBJECT_NAME = "CalendarBackground"
const RANGE_HIGHLIGHTS_LAYER_OBJECT_NAME = "CalendarRangeHighlightsLayer"
const TODAY_INDICATOR_LAYER_OBJECT_NAME = "CalendarTodayIndicatorLayer"
const CHILDREN_CONTAINER_OBJECT_NAME = "ChildrenContainer"
const RANGE_HIGHLIGHT_OBJECT_NAME_PREFIX = "CalendarRangeHighlight"
const TODAY_INDICATOR_OBJECT_NAME = "CalendarTodayIndicator"
const PREVIOUS_BUTTON_OBJECT_NAME = "CalendarPreviousButton"
const CENTER_BUTTON_OBJECT_NAME = "CalendarModeButton"
const NEXT_BUTTON_OBJECT_NAME = "CalendarNextButton"
const DAY_LABEL_OBJECT_NAME_PREFIX = "CalendarDay"
const DATE_BUTTON_OBJECT_NAME_PREFIX = "CalendarDate"
const MONTH_BUTTON_OBJECT_NAME_PREFIX = "CalendarMonth"
const YEAR_BUTTON_OBJECT_NAME_PREFIX = "CalendarYear"

const GRID_COLUMNS = 21
const GRID_TEMPLATE_COLUMNS = `repeat(${GRID_COLUMNS}, 1fr)`
const DATE_COLUMN_SPAN = 3
const MONTH_YEAR_COLUMN_SPAN = 7
const HEADER_ARROW_SPAN = 3
const HEADER_CENTER_SPAN = 15
const MAX_DAYS_IN_MONTH = 31
const MONTH_YEAR_CELL_COUNT = 12
const MONTH_YEAR_COLUMNS = 3
const REFERENCE_WIDTH = 28
const REFERENCE_HEIGHT = 30
const MIN_SIZE_SCALE = 0.01
const MIN_GRID_TRACK_SIZE = 0.001
const REFERENCE_COLUMN_GAP = 0.12
const REFERENCE_ROW_GAP = 0.45
const REFERENCE_PADDING = 0.35
const BACKGROUND_CORNER_RADIUS = 0.75
const REFERENCE_RANGE_HIGHLIGHT_Z_OFFSET = 0.01
const REFERENCE_TODAY_INDICATOR_Z_OFFSET = 0.015
const REFERENCE_CONTENT_Z_OFFSET = 0.02
const REFERENCE_HEADER_TEXT_SIZE = 44
const REFERENCE_BODY_TEXT_SIZE = 34
const REFERENCE_DAY_HEADER_TEXT_SIZE = 26
const REFERENCE_HEADER_ROW_HEIGHT = 3
const REFERENCE_DAY_HEADER_ROW_HEIGHT = 2
const REFERENCE_BUTTON_HEIGHT = 3
const REFERENCE_BUTTON_DEPTH = 1
const YEAR_PAGE_SIZE = MONTH_YEAR_CELL_COUNT
// A month spans at most six week rows (31 days starting on the week's last
// column). All six are reserved every month so row geometry stays constant
// while paging instead of reflowing between five- and six-week months;
// shorter months keep this grid geometry and only the background shrinks to
// fit (see fittedHeight).
const DATE_BODY_ROW_COUNT = 6
const MAX_RANGE_HIGHLIGHT_ROWS = DATE_BODY_ROW_COUNT
const MONTH_YEAR_BODY_ROW_COUNT = 4
const AUTO_TRACK_SIZE = "1fr"
const DATES_BODY_ROWS_TEMPLATE = `repeat(${DATE_BODY_ROW_COUNT}, 1fr)`
// Months and Years views occupy the five-row Dates footprint — the most
// common month shape — so entering them from a five-row month never resizes.
const MONTH_YEAR_EQUIVALENT_DATE_ROWS = 5
const BACKGROUND_FIT_ANIMATION_SECONDS = 0.25
const BACKGROUND_FIT_EASING = "ease-in-out-cubic"
const BACKGROUND_FIT_EPSILON = 0.001
const SYSTEM_3_THEME = System3.name
const RECTANGLE_BUTTON_SHAPE = System3.defaultShapeName
const GHOST_BUTTON_STYLE: CalendarButtonStyle = System3Styles.Ghost
const PRISM_GHOST_BUTTON_STYLE: CalendarButtonStyle = System3Styles.PrismGhost

/**
 * Single-grid calendar layout component.
 *
 * Renders real Gregorian calendar data: each month shows its actual day
 * count (leap years included) with dates aligned to their weekday columns.
 * Opens on the device's current date unless {@link defaultToCurrentDate} is
 * disabled in favor of the default year and month inputs. Whenever the
 * device's current date is visible, a purple indicator marks its cell.
 *
 * The height input is a maximum — the height of a six-row month. Months
 * spanning fewer week rows animate the background shrinking to fit, with the
 * top edge pinned so the header never moves. The Months and Years views fit
 * the five-row footprint.
 *
 * Date selection is governed by {@link selectionMode}: None makes dates
 * non-selectable, Single selects one date at a time, and Range (the default)
 * selects a start and end date.
 */
@component
export class Calendar extends BaseScriptComponent {
  public readonly __uikitBrand = UIKitBrands.LayoutContainer

  // ─── Calendar Size ──────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Size</span>')
  @input
  @label("Width")
  private _width: number = REFERENCE_WIDTH

  @input
  @label("Height")
  private _height: number = REFERENCE_HEIGHT
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Maximum height — the calendar shrinks to fit months spanning fewer than six week rows</span>'
  )

  // ─── Default Date ───────────────────────────────────────────────────
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Default Date</span>')
  @input
  @label("Current Date")
  @hint("Open the calendar on the device's current month and year.")
  private _defaultToCurrentDate: boolean = true

  @input("int")
  @label("Default Year")
  @showIf("_defaultToCurrentDate", false)
  private _defaultYear: number = 2011

  @input
  @label("Default Month")
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
  @showIf("_defaultToCurrentDate", false)
  private _defaultMonth: number = 9

  // ─── Selection ──────────────────────────────────────────────────────
  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Selection</span>')
  @input
  @label("Selection Mode")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("None", "None"),
      new ComboBoxItem("Single", "Single"),
      new ComboBoxItem("Range", "Range")
    ])
  )
  @hint("None: dates are not selectable. Single: one date at a time. Range: a start and end date.")
  private _selectionMode: string = CalendarSelectionMode.Range

  // ─── Internal State ─────────────────────────────────────────────────

  private readonly state: CalendarState = {
    childrenContainer: null,
    grid: {
      object: null,
      transform: null,
      layout: null
    },
    background: {
      object: null,
      transform: null,
      rectangle: null,
      // Background height currently applied, which trails fittedHeight while a
      // fit animation is in flight.
      fitHeight: 0
    },
    highlights: {
      rangeLayer: null,
      todayLayer: null,
      range: [],
      today: null
    },
    cells: {
      leftButton: null,
      centerButton: null,
      rightButton: null,
      dayLabels: [],
      dateButtons: [],
      monthButtons: [],
      yearButtons: [],
      activeItems: []
    },
    view: {
      mode: CalendarViewMode.Dates,
      displayMonthIndex: this._defaultMonth - 1,
      displayYear: this._defaultYear,
      yearsStart: getDecadeStart(this._defaultYear),
      // Decade anchor for year paging, captured from the resolved default date
      // in applyDefaultDate so the page grid stays fixed for the session even
      // if the device clock crosses a decade boundary. The initializer covers
      // pre-initialization callers; applyDefaultDate re-anchors at startup.
      yearPageAnchorStart: getDecadeStart(this._defaultYear),
      // Real device date captured independently from the calendar's authored
      // default date, so the today indicator stays correct for custom defaults.
      deviceToday: getDeviceDate(),
      // True only while an expand animation defers renderCurrentView to its end.
      pendingRender: false,
      // View mode of the grid currently on screen; trails mode while a
      // cross-mode render is deferred behind an expand.
      renderedMode: CalendarViewMode.Dates,
      hasRendered: false
    },
    selection: {
      startDate: null,
      endDate: null,
      hoverDate: null
    },
    lifecycle: {
      renderOrder: 0,
      initialized: false
    },
    batch: {
      updateEvent: null,
      canvasBindingDirty: false,
      layoutDirty: false,
      viewDirty: false,
      selectionDirty: false
    },
    scratch: {
      gridLocalPosition: vec3.zero(),
      backgroundLocalPosition: vec3.zero(),
      backgroundSize: vec2.zero(),
      buttonSize: vec3.zero(),
      backgroundFitCancelSet: new CancelSet()
    },
    metrics: {
      // sizeScale/heightScale derive solely from _width/_height and feed every
      // scaled metric (track sizes, gaps, text sizes, z-offsets), read many
      // times per layout and per hover-driven highlight pass. They are cached
      // here and recomputed lazily only after _width/_height change: the
      // width/height setters raise scalesDirty, and the initial dirty state
      // makes the first read pick up @input-deserialized values (which bypass
      // the setters).
      scalesDirty: true,
      sizeScale: 1,
      heightScale: 1
    }
  }

  private readonly canvasSize: vec2 = vec2.zero()
  private canvasController: CanvasController | null = null
  private readonly managedSceneObjects: Set<SceneObject> = new Set()
  private isReleasing: boolean = false

  private readonly modeConfigs: Record<CalendarViewMode, CalendarModeConfig> = {
    [CalendarViewMode.Dates]: {
      templateRows: () =>
        `${toCmString(this.headerRowHeight)} ${toCmString(this.dayHeaderRowHeight)} ${DATES_BODY_ROWS_TEMPLATE}`,
      fittedHeight: () => this.fittedHeightForDateRows(this.displayedDateRowCount),
      centerDisabled: false,
      renderView: () => this.renderDatesView()
    },
    [CalendarViewMode.Months]: {
      templateRows: () => `${toCmString(this.headerRowHeight)} ${this.monthYearBodyRowsTemplate}`,
      fittedHeight: () => this.fiveRowFittedHeight,
      centerDisabled: false,
      renderView: () => this.renderMonthsView()
    },
    [CalendarViewMode.Years]: {
      templateRows: () => `${toCmString(this.headerRowHeight)} ${this.monthYearBodyRowsTemplate}`,
      fittedHeight: () => this.fiveRowFittedHeight,
      centerDisabled: true,
      renderView: () => this.renderYearsView()
    }
  }

  private readonly events = {
    initialized: new ReplayEvent<void>(),
    selectionChanged: new Event<CalendarSelectionChangedEvent>(),
    displayYearChanged: new Event<number>(),
    displayMonthChanged: new Event<number>()
  }

  /** Fired once the calendar has built its visuals; replays to late subscribers. */
  public readonly onInitialized: PublicApi<void> = this.events.initialized.publicApi()

  /**
   * Fired whenever the stored selection changes, including each start or
   * end date assignment and clear. Payload holds clones of the new start
   * and end dates.
   */
  public readonly onSelectionChanged: PublicApi<CalendarSelectionChangedEvent> =
    this.events.selectionChanged.publicApi()

  /** Fired when the displayed year changes. Payload is the new year. */
  public readonly onDisplayYearChanged: PublicApi<number> = this.events.displayYearChanged.publicApi()

  /** Fired when the displayed month changes. Payload is the new 1-based month. */
  public readonly onDisplayMonthChanged: PublicApi<number> = this.events.displayMonthChanged.publicApi()

  // ─── Lifecycle ──────────────────────────────────────────────────────

  public onAwake(): void {
    this.createBatchUpdateEvent()
    this.createEvent("OnEnableEvent").bind(() => this.invalidateCanvasBinding())
    this.createEvent("OnStartEvent").bind(() => this.initialize())
    this.createEvent("OnDestroyEvent").bind(() => this.onDestroy())
  }

  public onDestroy(): void {
    const canvasController = this.canvasController
    this.canvasController = null
    this.isReleasing = true

    // Flip initialized first so any in-flight button callbacks or batched
    // flushes early-return instead of touching natives being torn down.
    this.state.lifecycle.initialized = false
    this.state.batch.canvasBindingDirty = false
    this.state.batch.layoutDirty = false
    this.state.batch.viewDirty = false
    this.state.batch.selectionDirty = false
    this.state.scratch.backgroundFitCancelSet()
    this.state.view.pendingRender = false
    this.state.view.hasRendered = false

    try {
      this.restoreChildrenContainer()
      this.destroyOwnedVisuals()

      this.state.grid.object = null
      this.state.grid.transform = null
      this.state.grid.layout = null
      this.state.background.object = null
      this.state.background.transform = null
      this.state.background.rectangle = null
      this.state.highlights.rangeLayer = null
      this.state.highlights.todayLayer = null
      this.state.highlights.range = []
      this.state.highlights.today = null
      this.state.cells.leftButton = null
      this.state.cells.centerButton = null
      this.state.cells.rightButton = null
      this.state.cells.dayLabels = []
      this.state.cells.dateButtons = []
      this.state.cells.monthButtons = []
      this.state.cells.yearButtons = []
      this.state.cells.activeItems = []
    } finally {
      canvasController?.release()
    }
  }

  // ─── Public Getters / Setters ───────────────────────────────────────

  /**
   * Schedules the inherited Canvas binding to be re-evaluated before rendering.
   * Call this after reparenting the calendar or changing ancestor Canvas topology
   * or configuration through raw Lens APIs. A live locally managed Canvas remains
   * authoritative and is not replaced by an ancestor Canvas.
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
   * Gets the render order shared by all calendar-owned visuals. Their
   * relative draw order is determined by the Canvas hierarchy.
   * @returns The current render order.
   */
  public get renderOrder(): number {
    return this.state.lifecycle.renderOrder
  }

  /**
   * Sets the render order shared by all calendar-owned visuals. Their
   * relative draw order is determined by the Canvas hierarchy.
   * @param value - The new render order.
   */
  public set renderOrder(value: number) {
    if (value === undefined || this.state.lifecycle.renderOrder === value) return

    this.state.lifecycle.renderOrder = value
    this.updateRenderOrder()
  }

  /**
   * Gets the developer-managed content children of this calendar.
   *
   * After initialization, the children are hosted by the foreground
   * `ChildrenContainer`; before initialization and after teardown, this falls
   * back to the root's unmanaged children.
   */
  public get contentChildren(): SceneObject[] {
    const childrenContainer = this.getChildrenContainer()
    return childrenContainer
      ? childrenContainer.children.filter((child) => !this.managedSceneObjects.has(child))
      : this.getRootContentChildren()
  }

  /** Gets the number of developer-managed content children of this calendar. */
  public get contentChildrenCount(): number {
    return this.contentChildren.length
  }

  /**
   * Gets the developer-managed children of this calendar.
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
      this.managedSceneObjects.has(sceneObject) ||
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
      this.managedSceneObjects.has(sceneObject) ||
      sceneObject.getParent() !== parent
    ) {
      return
    }

    unparentExternalChild(sceneObject)
  }

  /**
   * Gets the calendar width in centimeters.
   * @returns The calendar width.
   */
  public get width(): number {
    return this._width
  }

  /**
   * Sets the calendar width in centimeters.
   * @param value - The new calendar width.
   */
  public set width(value: number) {
    if (value === undefined || this._width === value) return

    this._width = value
    this.state.metrics.scalesDirty = true
    this.markLayoutDirty()
  }

  /**
   * Gets the calendar's maximum height in centimeters — the height of a
   * month spanning six week rows.
   * @returns The calendar maximum height.
   */
  public get height(): number {
    return this._height
  }

  /**
   * Sets the calendar's maximum height in centimeters. Months spanning fewer
   * than six week rows shrink the background to fit the rendered rows.
   * @param value - The new calendar maximum height.
   */
  public set height(value: number) {
    if (value === undefined || this._height === value) return

    this._height = value
    this.state.metrics.scalesDirty = true
    this.markLayoutDirty()
  }

  /**
   * Gets whether the calendar defaults to the device's current date.
   * @returns True when the device's current date is used as the default date.
   */
  public get defaultToCurrentDate(): boolean {
    return this._defaultToCurrentDate
  }

  /**
   * Sets whether the calendar defaults to the device's current date.
   * When enabled, re-anchors the displayed month and year to the current date.
   * @param value - True to use the device's current date as the default date.
   */
  public set defaultToCurrentDate(value: boolean) {
    if (value === undefined || value === this._defaultToCurrentDate) return

    this._defaultToCurrentDate = value
    if (this.state.lifecycle.initialized) {
      this.applyDefaultDate()
      this.markViewDirty()
    }
  }

  /**
   * Gets the authored default year — the fallback used when
   * {@link defaultToCurrentDate} is disabled.
   * @returns The default year.
   */
  public get defaultYear(): number {
    return this._defaultYear
  }

  /**
   * Sets the default year used when the calendar initializes.
   * Disables {@link defaultToCurrentDate} so the explicit default takes effect.
   * @param value - The default year.
   */
  public set defaultYear(value: number) {
    if (value === undefined || !isFinite(value)) return

    const year = Math.floor(value)
    if (year === this._defaultYear && !this._defaultToCurrentDate) return

    this._defaultToCurrentDate = false
    this._defaultYear = year
    if (this.state.lifecycle.initialized) {
      this.applyDefaultDate()
      this.markViewDirty()
    }
  }

  /**
   * Gets the authored default month as a 1-based month number — the
   * fallback used when {@link defaultToCurrentDate} is disabled.
   * @returns The default month, where January is 1 and December is 12.
   */
  public get defaultMonth(): number {
    return this._defaultMonth
  }

  /**
   * Sets the default month as a 1-based month number.
   * Disables {@link defaultToCurrentDate} so the explicit default takes effect.
   * @param value - The default month, where January is 1 and December is 12.
   */
  public set defaultMonth(value: number) {
    if (value === undefined || !isFinite(value)) return

    const month = Math.floor(clamp(value, MIN_MONTH, MAX_MONTH))
    if (month === this._defaultMonth && !this._defaultToCurrentDate) return

    this._defaultToCurrentDate = false
    this._defaultMonth = month
    if (this.state.lifecycle.initialized) {
      this.applyDefaultDate()
      this.markViewDirty()
    }
  }

  /**
   * Gets the currently displayed year.
   * @returns The displayed year.
   */
  public get displayYear(): number {
    return this.state.view.displayYear
  }

  /**
   * Gets the currently displayed month as a 1-based month number.
   * @returns The displayed month, where January is 1 and December is 12.
   */
  public get displayMonth(): number {
    return this.state.view.displayMonthIndex + 1
  }

  /**
   * Gets the current calendar view mode.
   * @returns The current view mode.
   */
  public get viewMode(): CalendarViewMode {
    return this.state.view.mode
  }

  /**
   * Sets the current calendar view mode.
   * @param value - The view mode to display.
   */
  public set viewMode(value: CalendarViewMode) {
    this.updateViewMode(value)
  }

  /**
   * Gets the current selection mode.
   * @returns The current selection mode.
   */
  public get selectionMode(): CalendarSelectionMode {
    return this._selectionMode as CalendarSelectionMode
  }

  /**
   * Sets the selection mode. Changing the mode clears any existing
   * selection.
   * @param value - The selection mode: None makes dates non-selectable,
   * Single selects one date at a time, and Range selects a start and end
   * date.
   */
  public set selectionMode(value: CalendarSelectionMode) {
    if (value === undefined || value === this._selectionMode) return

    if (
      value !== CalendarSelectionMode.None &&
      value !== CalendarSelectionMode.Single &&
      value !== CalendarSelectionMode.Range
    ) {
      return
    }

    this._selectionMode = value
    this.clearSelection()
  }

  /**
   * Gets the selected range start date.
   * @returns The selected start date, or null when no date is selected.
   */
  public get selectedStartDate(): CalendarDate | null {
    return cloneDate(this.state.selection.startDate)
  }

  /**
   * Gets the selected range end date.
   * @returns The selected end date, or null when the range is incomplete.
   */
  public get selectedEndDate(): CalendarDate | null {
    return cloneDate(this.state.selection.endDate)
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /** Shows the date grid. */
  public showDates(): void {
    this.updateViewMode(CalendarViewMode.Dates)
  }

  /** Shows the month grid. */
  public showMonths(): void {
    this.updateViewMode(CalendarViewMode.Months)
  }

  /** Shows the year grid. */
  public showYears(): void {
    this.updateViewMode(CalendarViewMode.Years)
  }

  /** Advances the currently displayed period. No-op before {@link onInitialized} fires. */
  public next(): void {
    this.handleNextButton()
  }

  /** Moves the currently displayed period backward. No-op before {@link onInitialized} fires. */
  public previous(): void {
    this.handlePreviousButton()
  }

  /** Clears the selected date range. No-op before {@link onInitialized} fires. */
  public clearSelection(): void {
    this.setSelectedRange(null, null)
  }

  /**
   * Sets the selected date range. No-op before {@link onInitialized} fires —
   * configure a startup selection from an onInitialized subscriber.
   * A single date can be selected as (date, null) or (date, date). A null
   * start with a non-null end is normalized to (end, null).
   * The {@link selectionMode} constrains the stored selection: in None mode
   * only clearing is allowed (other calls no-op), and in Single mode only
   * one date is kept — the chronologically earlier one when both are given,
   * since the range is normalized before the end date is dropped.
   * @param startDate - The selected start date, or null to clear the selection.
   * @param endDate - The selected end date, or null for a single-date selection.
   */
  public setSelectedRange(startDate: CalendarDate | null, endDate: CalendarDate | null): void {
    if (!this.state.lifecycle.initialized) return

    if (!startDate && endDate) {
      startDate = endDate
      endDate = null
    }

    if (startDate && endDate && compareDates(startDate, endDate) > 0) {
      const previousStartDate = startDate
      startDate = endDate
      endDate = previousStartDate
    }

    if (this._selectionMode === CalendarSelectionMode.None && (startDate || endDate)) return

    if (this._selectionMode === CalendarSelectionMode.Single) {
      endDate = null
    }

    if (
      areNullableDatesEqual(this.state.selection.startDate, startDate) &&
      areNullableDatesEqual(this.state.selection.endDate, endDate)
    ) {
      return
    }

    this.state.selection.startDate = cloneDate(startDate)
    this.state.selection.endDate = cloneDate(endDate)
    this.clearHoverDate()
    this.events.selectionChanged.invoke({
      selectedStartDate: cloneDate(this.state.selection.startDate),
      selectedEndDate: cloneDate(this.state.selection.endDate)
    })
    this.markSelectionDirty()
  }

  /**
   * Returns whether a date is currently selected or inside the selected range.
   * @param date - The date to test.
   */
  public isDateSelected(date: CalendarDate): boolean {
    if (!this.state.selection.startDate) return false
    if (!this.state.selection.endDate) return areDatesEqual(date, this.state.selection.startDate)

    return isDateInRange(date, this.state.selection.startDate, this.state.selection.endDate)
  }

  /**
   * Reports the Calendar's intrinsic size to a parent Layout2D container.
   * Calendar is sized by its public width and maximum height rather than by
   * the currently rendered view, so parents don't reflow while paging
   * between five- and six-week months.
   */
  public computeContentSize(_opts?: {mode?: "preferred" | "min" | "max"}): {width: number; height: number} {
    return {
      width: this._width,
      height: this._height
    }
  }

  /** All three modes are width/height locked for parent layout measurement. */
  public computeContentSizeAllModes(): {
    preferred: {width: number; height: number}
    min: {width: number; height: number}
    max: {width: number; height: number}
  } {
    const size = this.computeContentSize()
    return {preferred: {...size}, min: {...size}, max: {...size}}
  }

  /** Forces any pending calendar layout work to complete. */
  public forceLayout(): void {
    if (this.hasPendingBatchedUpdates()) {
      this.flushBatchedUpdates()
      // Same clean-at-end accounting as the LateUpdate handler: stay armed
      // only if the flush re-raised dirt, instead of firing a no-op tick.
      if (this.state.batch.updateEvent) {
        this.state.batch.updateEvent.enabled = this.hasPendingBatchedUpdates()
      }
    }
    // Fast-forward any in-flight background fit so callers observe settled
    // geometry and a deferred view render completes now. Settle before
    // forcing the grid: a completed render lays out the new view itself,
    // so forcing first would spend a pass on the about-to-be-replaced view.
    const rendered = this.settleBackgroundFit()
    if (!rendered && this.state.grid.layout) {
      this.state.grid.layout.forceLayout()
    }
  }

  // ─── Creation ───────────────────────────────────────────────────────

  private initialize(): void {
    if (this.state.lifecycle.initialized) return

    const authoredChildren = this.getRootContentChildren()
    this.state.view.deviceToday = getDeviceDate()
    this.applyDefaultDate()

    this.canvasSize.setXY(this._width, this._height)
    this.canvasController ??= new CanvasController(this.sceneObject)
    this.canvasController.ensure(this.canvasSize)
    this.createBackgroundVisual()
    this.createHighlightLayers()
    this.createCalendarGrid()
    this.createCalendarCells()
    this.createChildrenContainer(authoredChildren)

    this.state.lifecycle.initialized = true
    this.updateCalendarLayout()
    this.events.initialized.invoke()
  }

  private createChildrenContainer(authoredChildren: SceneObject[]): void {
    if (this.getChildrenContainer()) {
      return
    }

    const rootContentChildren = this.getRootContentChildren()
    const childrenToMove = [
      ...authoredChildren.filter((child) => rootContentChildren.includes(child)),
      ...rootContentChildren.filter((child) => !authoredChildren.includes(child))
    ]
    const childrenContainer = createChildSceneObjectWithParentLayer(CHILDREN_CONTAINER_OBJECT_NAME, this.sceneObject)
    const childrenContainerScreenTransform = childrenContainer.createComponent("ScreenTransform") as ScreenTransform
    configureScreenTransformToFillParent(childrenContainerScreenTransform)
    this.managedSceneObjects.add(childrenContainer)
    this.state.childrenContainer = childrenContainer

    for (const child of childrenToMove) {
      if (!isNull(child) && !this.managedSceneObjects.has(child) && child.getParent() === this.sceneObject) {
        // The container fills this picker exactly, so the child's local values
        // already place it where it was. A world-preserving move breaks under a
        // zero-scale ancestor (see reappendChild).
        child.setParent(childrenContainer)
      }
    }
  }

  private getRootContentChildren(): SceneObject[] {
    return this.sceneObject.children.filter((child) => !this.managedSceneObjects.has(child))
  }

  private getChildrenContainer(): SceneObject | null {
    const childrenContainer = this.state.childrenContainer
    return childrenContainer && !isNull(childrenContainer) ? childrenContainer : null
  }

  private getChildrenParent(): SceneObject | null {
    return this.getChildrenContainer() ?? (this.isReleasing ? null : this.sceneObject)
  }

  private restoreChildrenContainer(): void {
    const childrenContainer = this.state.childrenContainer
    this.state.childrenContainer = null
    if (!childrenContainer || isNull(childrenContainer)) {
      return
    }

    for (const child of [...childrenContainer.children]) {
      if (isNull(child) || this.managedSceneObjects.has(child)) {
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

  private destroyOwnedVisuals(): void {
    const managedSceneObjects = [...this.managedSceneObjects]
    this.managedSceneObjects.clear()

    for (const sceneObject of managedSceneObjects) {
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

  private createBackgroundVisual(): void {
    if (this.state.background.object || this.state.background.rectangle) return

    this.state.background.object = createChildSceneObjectWithParentLayer(
      CALENDAR_BACKGROUND_OBJECT_NAME,
      this.sceneObject
    )
    this.managedSceneObjects.add(this.state.background.object)
    this.state.background.transform = this.state.background.object.getTransform()

    const background = this.state.background.object.createComponent(RoundedRectangle.getTypeName()) as RoundedRectangle
    this.state.background.rectangle = background
    this.state.background.fitHeight = this._height
    background.size = new vec2(this._width, this._height)
    background.cornerRadius = BACKGROUND_CORNER_RADIUS
    background.gradient = false
    background.backgroundColor = CalendarBackgroundColor
    background.blendMode = RoundedRectBlendMode.Normal
    background.renderOrder = this.state.lifecycle.renderOrder
    background.onInitialized.add(() => enableDepthOcclusion(background))
  }

  private createHighlightLayers(): void {
    if (!this.state.highlights.rangeLayer) {
      this.state.highlights.rangeLayer = createChildSceneObjectWithParentLayer(
        RANGE_HIGHLIGHTS_LAYER_OBJECT_NAME,
        this.sceneObject
      )
      this.managedSceneObjects.add(this.state.highlights.rangeLayer)
    }
    if (!this.state.highlights.todayLayer) {
      this.state.highlights.todayLayer = createChildSceneObjectWithParentLayer(
        TODAY_INDICATOR_LAYER_OBJECT_NAME,
        this.sceneObject
      )
      this.managedSceneObjects.add(this.state.highlights.todayLayer)
    }
  }

  private createCalendarGrid(): void {
    if (this.state.grid.object || this.state.grid.layout) return

    this.state.grid.object = createChildSceneObjectWithParentLayer(CALENDAR_GRID_OBJECT_NAME, this.sceneObject)
    this.managedSceneObjects.add(this.state.grid.object)
    this.state.grid.transform = this.state.grid.object.getTransform()
    this.updateGridLocalPosition()

    this.state.grid.layout = this.state.grid.object.createComponent(GridLayout.getTypeName()) as GridLayout
    this.updateGridLayout()
  }

  private createCalendarCells(): void {
    if (!this.state.grid.object) return

    this.state.cells.leftButton = this.createCell({
      name: PREVIOUS_BUTTON_OBJECT_NAME,
      text: "<",
      textSize: this.headerTextSize,
      textColor: CalendarCellButtonTextColor,
      buttonStyle: GHOST_BUTTON_STYLE,
      onTriggerUp: () => this.handlePreviousButton()
    })
    this.state.cells.centerButton = this.createCell({
      name: CENTER_BUTTON_OBJECT_NAME,
      text: this.getCenterTitle(),
      textSize: this.headerTextSize,
      textColor: CalendarRectangleButtonTextColor,
      buttonStyle: PRISM_GHOST_BUTTON_STYLE,
      onTriggerUp: () => this.handleCenterButton()
    })
    this.state.cells.rightButton = this.createCell({
      name: NEXT_BUTTON_OBJECT_NAME,
      text: ">",
      textSize: this.headerTextSize,
      textColor: CalendarCellButtonTextColor,
      buttonStyle: GHOST_BUTTON_STYLE,
      onTriggerUp: () => this.handleNextButton()
    })

    for (let i = 0; i < DAY_NAMES.length; i++) {
      this.state.cells.dayLabels.push(
        this.createCell({
          name: DAY_LABEL_OBJECT_NAME_PREFIX + i,
          text: DAY_NAMES[i],
          textSize: this.dayHeaderTextSize,
          textColor: this.getDayHeaderTextColor(i)
        })
      )
    }

    for (let i = 0; i < MAX_DAYS_IN_MONTH; i++) {
      this.state.cells.dateButtons.push(
        this.createCell({
          name: DATE_BUTTON_OBJECT_NAME_PREFIX + i,
          text: "",
          textSize: this.bodyTextSize,
          textColor: CalendarCellButtonTextColor,
          buttonStyle: GHOST_BUTTON_STYLE,
          toggleable: true,
          onTriggerUp: () => this.handleDateButton(i + 1),
          onHoverEnter: () => this.handleDateHoverEnter(i + 1),
          onHoverExit: () => this.handleDateHoverExit(i + 1)
        })
      )
    }

    this.disableAllCells()
  }

  private ensureMonthButtonsBuilt(): void {
    if (this.state.cells.monthButtons.length > 0 || !this.state.grid.object) return

    for (let i = 0; i < MONTH_YEAR_CELL_COUNT; i++) {
      const cell = this.createCell({
        name: MONTH_BUTTON_OBJECT_NAME_PREFIX + i,
        text: MONTH_NAMES[i],
        textSize: this.bodyTextSize,
        textColor: CalendarCellButtonTextColor,
        buttonStyle: GHOST_BUTTON_STYLE,
        onTriggerUp: () => this.handleMonthButton(i)
      })
      this.prepareLazyMonthYearCell(cell)
      this.state.cells.monthButtons.push(cell)
    }
  }

  private ensureYearButtonsBuilt(): void {
    if (this.state.cells.yearButtons.length > 0 || !this.state.grid.object) return

    for (let i = 0; i < MONTH_YEAR_CELL_COUNT; i++) {
      const cell = this.createCell({
        name: YEAR_BUTTON_OBJECT_NAME_PREFIX + i,
        text: "",
        textSize: this.bodyTextSize,
        textColor: CalendarCellButtonTextColor,
        buttonStyle: GHOST_BUTTON_STYLE,
        onTriggerUp: () => this.handleYearButton(this.state.view.yearsStart + i)
      })
      this.prepareLazyMonthYearCell(cell)
      this.state.cells.yearButtons.push(cell)
    }
  }

  private prepareLazyMonthYearCell(cell: CalendarCell): void {
    this.updateMonthYearCellSizing(cell)
    this.setCellEnabled(cell, false)
  }

  private createCell(options: CalendarCellOptions): CalendarCell {
    const sceneObject = createChildSceneObjectWithParentLayer(options.name, this.state.grid.object!)

    let button: Button | undefined
    const isButton = options.buttonStyle !== undefined
    if (isButton) {
      button = sceneObject.createComponent(Button.getTypeName()) as Button
      button.setVariant({theme: SYSTEM_3_THEME, shape: RECTANGLE_BUTTON_SHAPE, style: options.buttonStyle})
      if (options.toggleable) {
        button.setIsToggleable(true)
      }
      button.renderOrder = this.state.lifecycle.renderOrder
      button.size = this.buttonSize

      if (options.onTriggerUp) {
        button.onTriggerUp.add(() => options.onTriggerUp!())
      }
      if (options.onHoverEnter) {
        button.onHoverEnter.add(() => options.onHoverEnter!())
      }
      if (options.onHoverExit) {
        button.onHoverExit.add(() => options.onHoverExit!())
      }

      // Build the visual and settle its resting state now, while the pooled
      // cell is still enabled during construction. Cells unused by the
      // opening month are disabled before their start phase ever runs, so
      // without this the button would initialize on its first activation
      // instead — visibly fading its default plate toward the Ghost resting
      // state mid-interaction. initialize() is idempotent; the deferred
      // onStart becomes a no-op.
      button.initialize()
    }

    const content = addContentToElement(sceneObject, {
      text: options.text,
      textSize: options.textSize,
      textAlignment: TextAlignment.Center,
      sizeOverride: isButton ? this.buttonContentSize : this.textContentSize
    })
    content.renderOrder = this.state.lifecycle.renderOrder
    applyContentTextColor(content, options.textColor)

    const gridItem = sceneObject.createComponent(GridItem.getTypeName()) as GridItem
    const baseSize = isButton ? this.buttonContentSize : this.textContentSize
    // Buttons keep the width override pinned to 0 from birth (see
    // updateButtonCellSizing); text cells declare their span width.
    gridItem.overrideWidth = isButton ? 0 : baseSize.x
    gridItem.overrideHeight = baseSize.y
    gridItem.justifySelf = GridAlign.Stretch
    gridItem.alignSelf = GridAlign.Stretch

    return {sceneObject, gridItem, content, button}
  }

  // ─── Layout Updates ─────────────────────────────────────────────────

  /**
   * Switches the view mode, re-anchoring the year page when entering the
   * Years view. Applies layout only once initialized.
   * @param value - The view mode to display.
   */
  private updateViewMode(value: CalendarViewMode): void {
    if (value === undefined || value === this.state.view.mode) return

    if (!this.modeConfigs[value]) return

    if (value === CalendarViewMode.Years) {
      this.state.view.yearsStart = this.getYearPageStart(this.state.view.displayYear)
    }

    this.state.view.mode = value
    if (this.state.lifecycle.initialized) {
      this.markViewDirty()
    }
  }

  /**
   * Rebuilds the current view with a direction-aware background fit.
   * @param snapFit - True when an explicit size change shares this flush:
   * parent layouts expect immediate geometry, so the fit snaps and the view
   * renders now instead of animating (matching updateCalendarSizing's
   * contract). Without it, an expand would defer renderCurrentView and leave
   * the old view laid out against the new dimensions with a stale row
   * template until the tween ends.
   */
  private updateCalendarLayout(snapFit: boolean = false): void {
    if (
      !this.state.lifecycle.initialized ||
      !this.state.grid.layout ||
      !this.state.cells.leftButton ||
      !this.state.cells.centerButton ||
      !this.state.cells.rightButton
    )
      return

    // Background, grid, and cell metrics derive solely from _width/_height,
    // so pure view flushes (paging, mode changes) skip re-applying them.
    // snapFit doubles as the size-dirty signal: flushBatchedUpdates passes
    // layoutDirty, which only the width/height setters raise. The first
    // layout still applies them over createCell's generic initial sizes.
    if (snapFit || !this.state.view.hasRendered) {
      this.canvasSize.setXY(this._width, this._height)
      this.canvasController?.setSize(this.canvasSize)
      this.updateBackgroundVisual()
      this.updateGridLayout()
      this.updateCellSizing()
    }

    // Direction-aware background fit keeps content inside the background at
    // every frame: expands grow over empty space before the new view appears,
    // shrinks swap to the shorter view first and then close the empty gap.
    const target = this.fittedHeight
    const delta = target - this.state.background.fitHeight
    if (snapFit || !this.state.view.hasRendered || Math.abs(delta) <= BACKGROUND_FIT_EPSILON) {
      this.state.scratch.backgroundFitCancelSet()
      this.state.view.pendingRender = false
      this.applyBackgroundFit(target)
      this.renderCurrentView()
    } else if (delta > 0) {
      this.state.view.pendingRender = true
      this.animateBackgroundFit(target)
    } else {
      this.state.view.pendingRender = false
      this.renderCurrentView()
      this.animateBackgroundFit(target)
    }
  }

  /**
   * Applies a pure size change without rebuilding the view: cells keep
   * their grid membership and placement, skipping the remove/disable/
   * re-enable/add churn of renderCurrentView.
   */
  private updateCalendarSizing(): void {
    if (!this.state.lifecycle.initialized || !this.state.grid.layout) return

    this.canvasSize.setXY(this._width, this._height)
    this.canvasController?.setSize(this.canvasSize)
    this.updateBackgroundVisual()
    this.updateGridLayout()
    this.updateCellSizing()
    // Explicit size changes snap rather than animate: parent layouts expect
    // immediate geometry. Settling before the template/layout below also
    // completes a deferred cross-mode render first, so the old mode's cells
    // are never laid out against the new mode's template. The sizing calls
    // above ran first, so a completed render already applied the new-size
    // template and laid out the grid — the explicit pass is only needed
    // when nothing rendered.
    const rendered = this.settleBackgroundFit()
    if (!rendered) {
      this.state.grid.layout.templateRows = this.modeConfigs[this.state.view.mode].templateRows()
      this.state.grid.layout.forceLayout()
    }
  }

  private updateRenderOrder(): void {
    if (this.state.background.rectangle) {
      this.state.background.rectangle.renderOrder = this.state.lifecycle.renderOrder
    }
    this.updateHighlightRenderOrder()

    this.updateCellRenderOrder(this.state.cells.leftButton)
    this.updateCellRenderOrder(this.state.cells.centerButton)
    this.updateCellRenderOrder(this.state.cells.rightButton)

    for (const cell of this.state.cells.dayLabels) this.updateCellRenderOrder(cell)
    for (const cell of this.state.cells.dateButtons) this.updateCellRenderOrder(cell)
    for (const cell of this.state.cells.monthButtons) this.updateCellRenderOrder(cell)
    for (const cell of this.state.cells.yearButtons) this.updateCellRenderOrder(cell)
  }

  private updateCellRenderOrder(cell: CalendarCell | null): void {
    if (!cell) return

    if (cell.button) {
      cell.button.renderOrder = this.state.lifecycle.renderOrder
    }
    cell.content.renderOrder = this.state.lifecycle.renderOrder
  }

  private updateBackgroundVisual(): void {
    if (this.state.background.rectangle) {
      this.state.background.rectangle.backgroundColor = CalendarBackgroundColor
    }
  }

  /**
   * Applies a background height with the top edge pinned at +height/2, so a
   * fitted month trims unused date rows off the bottom while the grid keeps
   * its max-height row geometry (header and nav never move while paging).
   */
  private applyBackgroundFit(height: number): void {
    this.state.background.fitHeight = height
    if (!this.state.background.rectangle) return

    this.state.scratch.backgroundSize.setXY(this._width, height)
    this.state.background.rectangle.size = this.state.scratch.backgroundSize
    this.state.scratch.backgroundLocalPosition.setXYZ(0, (this._height - height) * 0.5, 0)
    this.state.background.transform?.setLocalPosition(this.state.scratch.backgroundLocalPosition)
  }

  /**
   * Tweens the background to a target fitted height. Retargets cancel the
   * in-flight tween without firing ended, so a view render deferred by an
   * expand survives until a natural completion or an explicit snap.
   */
  private animateBackgroundFit(target: number): void {
    this.state.scratch.backgroundFitCancelSet()
    const from = this.state.background.fitHeight
    animate({
      duration: BACKGROUND_FIT_ANIMATION_SECONDS,
      easing: BACKGROUND_FIT_EASING,
      update: (t: number) => this.applyBackgroundFit(mix(from, target, t)),
      ended: () => this.renderPendingView(),
      cancelSet: this.state.scratch.backgroundFitCancelSet
    })
  }

  /**
   * Completes a view render deferred behind an expand animation.
   * @returns True when a deferred render ran.
   */
  private renderPendingView(): boolean {
    if (!this.state.lifecycle.initialized || !this.state.view.pendingRender) return false

    this.state.view.pendingRender = false
    this.renderCurrentView()
    return true
  }

  /**
   * Cancels any in-flight fit tween, snaps the background to the current
   * fitted height, and completes a view render an expand had deferred. Not
   * a substitute for updateCalendarLayout's snap branch, which must render
   * even when no render is pending.
   * @returns True only when a deferred view render completed — that render
   * lays out the grid itself, so callers may skip their own grid pass.
   * False means only background geometry settled.
   */
  private settleBackgroundFit(): boolean {
    this.state.scratch.backgroundFitCancelSet()
    if (!this.state.lifecycle.initialized) return false

    this.applyBackgroundFit(this.fittedHeight)
    return this.renderPendingView()
  }

  private updateGridLayout(): void {
    if (!this.state.grid.layout) return

    this.updateGridLocalPosition()

    this.state.grid.layout.width = this._width
    this.state.grid.layout.height = this._height
    this.state.grid.layout.templateColumns = GRID_TEMPLATE_COLUMNS
    this.state.grid.layout.autoRows = AUTO_TRACK_SIZE
    this.state.grid.layout.autoColumns = AUTO_TRACK_SIZE
    this.state.grid.layout.columnGap = this.columnGap
    this.state.grid.layout.rowGap = this.rowGap
    this.state.grid.layout.paddingTop = this.padding
    this.state.grid.layout.paddingRight = this.padding
    this.state.grid.layout.paddingBottom = this.padding
    this.state.grid.layout.paddingLeft = this.padding
    this.state.grid.layout.justifyItems = GridAlign.Stretch
    this.state.grid.layout.alignItems = GridAlign.Stretch
  }

  private updateGridLocalPosition(): void {
    if (!this.state.grid.object) return

    this.state.scratch.gridLocalPosition.setXYZ(0, 0, this.contentZOffset)
    this.state.grid.transform?.setLocalPosition(this.state.scratch.gridLocalPosition)
  }

  private updateCellSizing(): void {
    const arrowWidth = this.gridSpanWidth(HEADER_ARROW_SPAN)
    const centerWidth = this.gridSpanWidth(HEADER_CENTER_SPAN)
    const dateCellWidth = this.dateCellWidth
    const dateRowHeight = this.dateRowHeight

    this.updateButtonCellSizing(this.state.cells.leftButton, this.headerTextSize, arrowWidth, this.headerRowHeight)
    this.updateButtonCellSizing(this.state.cells.centerButton, this.headerTextSize, centerWidth, this.headerRowHeight)
    this.updateButtonCellSizing(this.state.cells.rightButton, this.headerTextSize, arrowWidth, this.headerRowHeight)
    this.updateCenterButtonClearance()

    for (const cell of this.state.cells.dayLabels) this.updateTextCellSizing(cell, this.dayHeaderTextSize)
    for (const cell of this.state.cells.dateButtons)
      this.updateButtonCellSizing(cell, this.bodyTextSize, dateCellWidth, dateRowHeight)
    for (const cell of this.state.cells.monthButtons) this.updateMonthYearCellSizing(cell)
    for (const cell of this.state.cells.yearButtons) this.updateMonthYearCellSizing(cell)
  }

  private updateMonthYearCellSizing(cell: CalendarCell | null): void {
    this.updateButtonCellSizing(
      cell,
      this.bodyTextSize,
      this.gridSpanWidth(MONTH_YEAR_COLUMN_SPAN),
      this.monthYearRowHeight
    )
  }

  /**
   * Declares a button cell's sizes from the grid row height and column span
   * it occupies. The button and content rects get the real span width: they
   * are what render while an expand defers the layout pass, and an accurate
   * width keeps wide cells like the center title from wrapping their text
   * mid-animation.
   *
   * The grid item's width override is pinned to 0 ("no preferred width"):
   * a spanning cell's preferred width feeds Grid2D's track sizing and
   * inflates fr columns wherever its span isn't uniformly pre-seeded by
   * narrower items (the Months/Years views), while Stretch alignment grants
   * the full track allocation regardless of the declared width. That
   * inflation is a Grid2D deviation from CSS Grid §11.5 — spanning items'
   * preferred widths should not grow flexible tracks under definite sizing
   * — so the pin becomes removable if the engine aligns with the spec.
   */
  private updateButtonCellSizing(
    cell: CalendarCell | null,
    textSize: number,
    cellWidth: number,
    cellHeight: number
  ): void {
    if (!cell || !cell.button) return

    // Element.size stores by copy, so one scratch is safe across cells.
    // sizeOverride stores by reference — it must keep a fresh instance per
    // cell, or every cell would alias the last-written values.
    const buttonSize = this.state.scratch.buttonSize
    buttonSize.setXYZ(cellWidth, cellHeight, this.buttonDepth)
    cell.button.size = buttonSize
    cell.content.textSize = textSize
    cell.content.sizeOverride = new vec2(cellWidth, cellHeight)
    cell.gridItem.overrideWidth = 0
    cell.gridItem.overrideHeight = cellHeight
  }

  private updateTextCellSizing(cell: CalendarCell | null, textSize: number): void {
    if (!cell) return

    const contentSize = this.textContentSize
    cell.content.textSize = textSize
    cell.content.sizeOverride = contentSize
    cell.gridItem.overrideWidth = contentSize.x
    cell.gridItem.overrideHeight = contentSize.y
  }

  private updateCenterButtonClearance(): void {
    if (!this.state.cells.centerButton) return

    const transform = this.state.cells.centerButton.sceneObject.getTransform()
    const position = transform.getLocalPosition()
    position.z = this.buttonDepth * 0.5
    transform.setLocalPosition(position)
  }

  // ─── Rendering ──────────────────────────────────────────────────────

  private renderCurrentView(): void {
    if (!this.state.grid.layout) return

    this.state.grid.layout.removeItems(this.state.cells.activeItems)
    this.disableAllCells()
    this.state.cells.activeItems = []
    this.clearHoverDate()

    const config = this.modeConfigs[this.state.view.mode]
    this.state.grid.layout.templateRows = config.templateRows()
    this.renderHeader(config.centerDisabled)
    config.renderView()

    this.state.grid.layout.addItems(this.state.cells.activeItems)
    this.state.grid.layout.forceLayout()
    this.syncRangeHighlights()
    this.syncTodayIndicator()
    this.state.view.renderedMode = this.state.view.mode
    this.state.view.hasRendered = true
  }

  private renderHeader(centerDisabled: boolean): void {
    if (!this.state.cells.leftButton || !this.state.cells.centerButton || !this.state.cells.rightButton) return

    this.state.cells.centerButton.content.text = this.getCenterTitle()
    this.setButtonInactive(this.state.cells.centerButton, centerDisabled)
    this.activateCell(this.state.cells.centerButton)
    this.placeGridItem(this.state.cells.centerButton.gridItem, 0, HEADER_ARROW_SPAN, 1, HEADER_CENTER_SPAN)

    this.setButtonInactive(this.state.cells.leftButton, false)
    this.setButtonInactive(this.state.cells.rightButton, false)
    this.activateCell(this.state.cells.leftButton)
    this.activateCell(this.state.cells.rightButton)
    this.placeGridItem(this.state.cells.leftButton.gridItem, 0, 0, 1, HEADER_ARROW_SPAN)
    this.placeGridItem(this.state.cells.rightButton.gridItem, 0, GRID_COLUMNS - HEADER_ARROW_SPAN, 1, HEADER_ARROW_SPAN)
  }

  private renderDatesView(): void {
    for (let i = 0; i < this.state.cells.dayLabels.length; i++) {
      const label = this.state.cells.dayLabels[i]
      this.activateCell(label)
      this.placeGridItem(label.gridItem, 1, i * DATE_COLUMN_SPAN, 1, DATE_COLUMN_SPAN)
    }

    // Buttons beyond the displayed month's length stay disabled from the
    // disableAllCells pass in renderCurrentView.
    const firstDayColumn = this.displayedFirstDayColumn
    const daysInMonth = this.displayedDaysInMonth
    for (let i = 0; i < daysInMonth; i++) {
      const cell = this.state.cells.dateButtons[i]
      const day = i + 1
      cell.content.text = String(day)
      this.setButtonInactive(cell, false)
      // Immediate toggle: view builds repurpose pooled buttons for different
      // dates, so an animated fade would flash the previous month's selection
      // over the new labels while paging. User-driven selection changes keep
      // the fade (see syncDateButtonSelection).
      setButtonToggledImmediate(cell.button, this.isDateEndpointSelected(this.createDisplayedDate(day)))
      this.activateCell(cell)

      const cellIndex = firstDayColumn + i
      const row = 2 + Math.floor(cellIndex / DAYS_PER_WEEK)
      const col = (cellIndex % DAYS_PER_WEEK) * DATE_COLUMN_SPAN
      this.placeGridItem(cell.gridItem, row, col, 1, DATE_COLUMN_SPAN)
    }
  }

  private renderMonthsView(): void {
    this.ensureMonthButtonsBuilt()

    for (let i = 0; i < this.state.cells.monthButtons.length; i++) {
      const cell = this.state.cells.monthButtons[i]
      cell.content.text = MONTH_NAMES[i]
      this.setButtonInactive(cell, false)
      this.activateCell(cell)
      this.placeMonthYearCell(cell.gridItem, i)
    }
  }

  private renderYearsView(): void {
    this.ensureYearButtonsBuilt()

    for (let i = 0; i < this.state.cells.yearButtons.length; i++) {
      const cell = this.state.cells.yearButtons[i]
      cell.content.text = String(this.state.view.yearsStart + i)
      this.setButtonInactive(cell, false)
      this.activateCell(cell)
      this.placeMonthYearCell(cell.gridItem, i)
    }
  }

  private placeMonthYearCell(gridItem: GridItem, index: number): void {
    const row = 1 + Math.floor(index / MONTH_YEAR_COLUMNS)
    const col = (index % MONTH_YEAR_COLUMNS) * MONTH_YEAR_COLUMN_SPAN
    this.placeGridItem(gridItem, row, col, 1, MONTH_YEAR_COLUMN_SPAN)
  }

  private placeGridItem(gridItem: GridItem, row: number, col: number, rowSpan: number, colSpan: number): void {
    gridItem.autoPlacement = false
    gridItem.gridRow = row
    gridItem.gridColumn = col
    gridItem.gridRowSpan = rowSpan
    gridItem.gridColumnSpan = colSpan
  }

  private activateCell(cell: CalendarCell): void {
    cell.sceneObject.enabled = true
    this.state.cells.activeItems.push(cell.gridItem)
  }

  private disableAllCells(): void {
    this.setCellEnabled(this.state.cells.leftButton, false)
    this.setCellEnabled(this.state.cells.centerButton, false)
    this.setCellEnabled(this.state.cells.rightButton, false)

    for (const cell of this.state.cells.dayLabels) this.setCellEnabled(cell, false)
    for (const cell of this.state.cells.dateButtons) this.setCellEnabled(cell, false)
    for (const cell of this.state.cells.monthButtons) this.setCellEnabled(cell, false)
    for (const cell of this.state.cells.yearButtons) this.setCellEnabled(cell, false)
  }

  private setCellEnabled(cell: CalendarCell | null, enabled: boolean): void {
    if (cell) {
      cell.sceneObject.enabled = enabled
    }
  }

  private setButtonInactive(cell: CalendarCell | null, inactive: boolean): void {
    if (cell?.button) {
      cell.button.inactive = inactive
    }
  }

  // ─── Interaction ────────────────────────────────────────────────────

  /**
   * True while an expand defers a render for a different view mode than the
   * grid on screen. Nav taps in that window would act on the hidden mode
   * (e.g. paging the year while a Dates grid is visible), so the nav
   * handlers drop them. Same-mode expands — ordinary month paging — keep
   * prev/next responsive; the center title uses the stricter
   * pendingRender guard instead (see handleCenterButton).
   */
  private get isViewModeTransitionPending(): boolean {
    return this.state.view.pendingRender && this.state.view.renderedMode !== this.state.view.mode
  }

  private handlePreviousButton(): void {
    if (this.isViewModeTransitionPending) return

    this.stepCurrentView(-1)
  }

  private handleNextButton(): void {
    if (this.isViewModeTransitionPending) return

    this.stepCurrentView(1)
  }

  private handleCenterButton(): void {
    if (this.state.view.pendingRender) return

    if (this.state.view.mode === CalendarViewMode.Dates) {
      this.updateViewMode(CalendarViewMode.Months)
    } else if (this.state.view.mode === CalendarViewMode.Months) {
      this.updateViewMode(CalendarViewMode.Years)
    }
  }

  private handleMonthButton(monthIndex: number): void {
    if (this.state.view.pendingRender) return

    this.setDisplayMonthIndex(monthIndex)
    this.updateViewMode(CalendarViewMode.Dates)
  }

  private handleYearButton(year: number): void {
    if (this.state.view.pendingRender) return

    this.setDisplayYear(year)
    this.updateViewMode(CalendarViewMode.Months)
  }

  private handleDateButton(day: number): void {
    if (this.state.view.pendingRender) return

    const selectedDate = this.createDisplayedDate(day)

    if (this.selectionMode === CalendarSelectionMode.None) {
      // The toggleable button auto-flipped before this handler ran; fade it
      // back off — None mode can never store a selection.
      const button = this.state.cells.dateButtons[day - 1]?.button
      if (button) {
        button.isOn = false
      }
      return
    }

    if (!this.state.selection.startDate) {
      this.setSelectedRange(selectedDate, null)
    } else if (this.selectionMode === CalendarSelectionMode.Single) {
      // Tap the selected date to clear it; tap another date to move the
      // selection.
      if (areDatesEqual(this.state.selection.startDate, selectedDate)) {
        this.clearSelection()
      } else {
        this.setSelectedRange(selectedDate, null)
      }
    } else if (!this.state.selection.endDate) {
      if (areDatesEqual(this.state.selection.startDate, selectedDate)) {
        this.clearSelection()
      } else {
        this.setSelectedRange(this.state.selection.startDate, selectedDate)
      }
    } else if (isDateInRange(selectedDate, this.state.selection.startDate, this.state.selection.endDate)) {
      this.clearSelection()
    } else {
      this.setSelectedRange(selectedDate, null)
    }
  }

  private handleDateHoverEnter(day: number): void {
    if (!this.shouldPreviewHoveredRange()) return

    const hoverDate = this.createDisplayedDate(day)
    if (areNullableDatesEqual(this.state.selection.hoverDate, hoverDate)) return

    this.state.selection.hoverDate = hoverDate
    this.syncRangeHighlights()
  }

  private handleDateHoverExit(day: number): void {
    const hoverDate = this.createDisplayedDate(day)
    if (!areNullableDatesEqual(this.state.selection.hoverDate, hoverDate)) return

    this.clearHoverDate()
    this.syncRangeHighlights()
  }

  private shouldPreviewHoveredRange(): boolean {
    return (
      this.state.lifecycle.initialized &&
      this.state.view.mode === CalendarViewMode.Dates &&
      this.selectionMode === CalendarSelectionMode.Range &&
      !this.state.view.pendingRender &&
      !!this.state.selection.startDate &&
      !this.state.selection.endDate
    )
  }

  private stepCurrentView(delta: number): void {
    if (!this.state.lifecycle.initialized || delta === 0) return

    if (this.state.view.mode === CalendarViewMode.Dates) {
      let monthIndex = this.state.view.displayMonthIndex + delta
      let year = this.state.view.displayYear
      while (monthIndex < 0) {
        monthIndex += MONTH_YEAR_CELL_COUNT
        year--
      }
      while (monthIndex >= MONTH_YEAR_CELL_COUNT) {
        monthIndex -= MONTH_YEAR_CELL_COUNT
        year++
      }
      this.setDisplayDate(year, monthIndex)
    } else if (this.state.view.mode === CalendarViewMode.Months) {
      this.setDisplayDate(this.state.view.displayYear + delta, this.state.view.displayMonthIndex)
    } else if (this.state.view.mode === CalendarViewMode.Years) {
      this.state.view.yearsStart += delta * YEAR_PAGE_SIZE
    }

    this.markViewDirty()
  }

  private setDisplayMonthIndex(monthIndex: number): void {
    this.setDisplayDate(this.state.view.displayYear, Math.floor(clamp(monthIndex, 0, MONTH_YEAR_CELL_COUNT - 1)))
  }

  private setDisplayYear(year: number): void {
    this.setDisplayDate(year, this.state.view.displayMonthIndex)
  }

  private setDisplayDate(year: number, monthIndex: number): void {
    const yearChanged = year !== this.state.view.displayYear
    const monthChanged = monthIndex !== this.state.view.displayMonthIndex
    this.state.view.displayYear = year
    this.state.view.displayMonthIndex = monthIndex

    if (!this.state.lifecycle.initialized) return

    if (yearChanged) this.events.displayYearChanged.invoke(year)
    // The year invoke runs subscriber code that can re-enter setDisplayDate and
    // move the month again; that re-entrant call already fired the fresh month
    // event. Only deliver ours if the month is still current, so the payload
    // never contradicts the displayMonth getter.
    if (monthChanged && this.state.view.displayMonthIndex === monthIndex) {
      this.events.displayMonthChanged.invoke(monthIndex + 1)
    }
  }

  private applyDefaultDate(): void {
    this._defaultMonth = normalizeMonth(this._defaultMonth, this._defaultMonth)
    this._defaultYear = Math.floor(this._defaultYear)

    const defaultDate = this.resolveDefaultDate()
    // Anchor before setDisplayDate: its change events can run subscriber
    // code that re-enters year paging.
    this.state.view.yearPageAnchorStart = getDecadeStart(defaultDate.year)
    this.setDisplayDate(defaultDate.year, defaultDate.monthIndex)
    this.state.view.yearsStart = this.getYearPageStart(this.state.view.displayYear)
  }

  /**
   * Resolves the date the calendar should open on without mutating the
   * authored defaults: the device's current date when
   * {@link defaultToCurrentDate} is enabled, otherwise the default year
   * and month inputs.
   */
  private resolveDefaultDate(): {year: number; monthIndex: number} {
    if (this._defaultToCurrentDate) {
      const deviceDate = getDeviceDate()
      return {year: deviceDate.year, monthIndex: deviceDate.month - 1}
    }

    return {year: Math.floor(this._defaultYear), monthIndex: normalizeMonth(this._defaultMonth, this._defaultMonth) - 1}
  }

  // ─── Batching ───────────────────────────────────────────────────────

  private createBatchUpdateEvent(): void {
    if (this.state.batch.updateEvent) return

    this.state.batch.updateEvent = this.createEvent("LateUpdateEvent")
    this.state.batch.updateEvent.enabled = false
    this.state.batch.updateEvent.bind(() => this.flushBatchedUpdatesAndUpdateEvent())
  }

  private markLayoutDirty(): void {
    if (!this.state.lifecycle.initialized) return

    this.state.batch.layoutDirty = true
    this.batchUpdate()
  }

  private markViewDirty(): void {
    if (!this.state.lifecycle.initialized) return

    this.state.batch.viewDirty = true
    this.batchUpdate()
  }

  private markSelectionDirty(): void {
    if (!this.state.lifecycle.initialized) return

    this.state.batch.selectionDirty = true
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
      this.state.batch.canvasBindingDirty ||
      this.state.batch.layoutDirty ||
      this.state.batch.viewDirty ||
      this.state.batch.selectionDirty
    )
  }

  private flushBatchedUpdates(): void {
    const canvasBindingDirty = this.state.batch.canvasBindingDirty
    const layoutDirty = this.state.batch.layoutDirty
    const viewDirty = this.state.batch.viewDirty
    const selectionDirty = this.state.batch.selectionDirty
    this.state.batch.canvasBindingDirty = false
    this.state.batch.layoutDirty = false
    this.state.batch.viewDirty = false
    this.state.batch.selectionDirty = false

    try {
      if (viewDirty) {
        // A full view rebuild already refreshes size-dependent visuals and grid
        // layout, and Dates mode applies selection state while rendering. An
        // explicit size change riding along forces the snap path so resize
        // geometry never animates or renders against a stale row template.
        this.updateCalendarLayout(layoutDirty)
      } else {
        if (layoutDirty) {
          this.updateCalendarSizing()
        }
        // While an expand defers renderCurrentView, the visible pooled buttons
        // still show the previous month, so selection visuals computed from
        // the new display date would land on the wrong labels. Skip them — the
        // deferred render re-applies toggle state and highlights from the
        // stored selection when it completes. A layout flush settles the fit
        // in updateCalendarSizing above, so this only affects selection-only
        // flushes that land mid-tween (programmatic setSelectedRange calls;
        // date taps are guarded in handleDateButton).
        if (selectionDirty && !this.state.view.pendingRender) {
          this.syncDateButtonSelection()
        }
        if ((layoutDirty || selectionDirty) && !this.state.view.pendingRender) {
          // Highlight geometry depends on both sizing and selection, so sync
          // once per flush instead of from each helper above.
          this.syncRangeHighlights()
        }
        if (layoutDirty) {
          // The today indicator tracks sizing only; selection never moves it.
          this.syncTodayIndicator()
        }
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
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private getCenterTitle(): string {
    if (this.state.view.mode === CalendarViewMode.Dates) {
      return MONTH_NAMES[this.state.view.displayMonthIndex] + " " + this.state.view.displayYear
    }
    if (this.state.view.mode === CalendarViewMode.Months) {
      return String(this.state.view.displayYear)
    }
    return this.state.view.yearsStart + " - " + (this.state.view.yearsStart + YEAR_PAGE_SIZE - 1)
  }

  private getDayHeaderTextColor(index: number): vec4 {
    return index === 0 || index === DAYS_PER_WEEK - 1 ? CalendarWeekendHeaderTextColor : CalendarDayHeaderTextColor
  }

  private createDisplayedDate(day: number): CalendarDate {
    return {
      year: this.state.view.displayYear,
      month: this.state.view.displayMonthIndex + 1,
      day
    }
  }

  private clearHoverDate(): void {
    this.state.selection.hoverDate = null
  }

  private syncDateButtonSelection(): void {
    const daysInMonth = this.displayedDaysInMonth
    for (let i = 0; i < daysInMonth; i++) {
      const button = this.state.cells.dateButtons[i].button
      if (button) {
        button.isOn = this.isDateEndpointSelected(this.createDisplayedDate(i + 1))
      }
    }
  }

  private isDateEndpointSelected(date: CalendarDate): boolean {
    if (!this.state.selection.startDate) return false
    if (!this.state.selection.endDate) return areDatesEqual(date, this.state.selection.startDate)

    return areDatesEqual(date, this.state.selection.startDate) || areDatesEqual(date, this.state.selection.endDate)
  }

  private syncRangeHighlights(): void {
    if (this.state.view.mode !== CalendarViewMode.Dates) {
      this.hideRangeHighlightsFrom(0)
      return
    }

    const highlightedRange = this.getHighlightedDateRange()
    if (!highlightedRange || this.isRangeTooShortForHighlight(highlightedRange.startDate, highlightedRange.endDate)) {
      this.hideRangeHighlightsFrom(0)
      return
    }

    const visibleRange = this.getVisibleHighlightedDayRange(highlightedRange.startDate, highlightedRange.endDate)
    if (!visibleRange) {
      this.hideRangeHighlightsFrom(0)
      return
    }

    let activeHighlightCount = 0
    const firstDayColumn = this.displayedFirstDayColumn
    const daysInMonth = this.displayedDaysInMonth
    const startRow = Math.floor((firstDayColumn + visibleRange.startDay - 1) / DAYS_PER_WEEK)
    const endRow = Math.floor((firstDayColumn + visibleRange.endDay - 1) / DAYS_PER_WEEK)

    for (let row = startRow; row <= endRow && activeHighlightCount < MAX_RANGE_HIGHLIGHT_ROWS; row++) {
      const rowStartDay = Math.max(row * DAYS_PER_WEEK + 1 - firstDayColumn, 1)
      const rowEndDay = Math.min((row + 1) * DAYS_PER_WEEK - firstDayColumn, daysInMonth)
      const segmentStartDay = Math.max(visibleRange.startDay, rowStartDay)
      const segmentEndDay = Math.min(visibleRange.endDay, rowEndDay)

      const highlight = this.getRangeHighlightFromPool(activeHighlightCount)
      if (!highlight) break

      this.applyRangeHighlight(highlight, row, segmentStartDay, segmentEndDay)
      activeHighlightCount++
    }

    this.hideRangeHighlightsFrom(activeHighlightCount)
  }

  private getHighlightedDateRange(): {startDate: CalendarDate; endDate: CalendarDate} | null {
    const startDate = this.state.selection.startDate
    const endDate = this.state.selection.endDate ?? this.state.selection.hoverDate
    if (!startDate || !endDate) return null

    if (compareDates(startDate, endDate) <= 0) {
      return {startDate, endDate}
    }

    return {startDate: endDate, endDate: startDate}
  }

  private isRangeTooShortForHighlight(startDate: CalendarDate, endDate: CalendarDate): boolean {
    if (areDatesEqual(startDate, endDate)) return true

    return areDatesConsecutive(startDate, endDate)
  }

  private getVisibleHighlightedDayRange(
    startDate: CalendarDate,
    endDate: CalendarDate
  ): {startDay: number; endDay: number} | null {
    const daysInMonth = this.displayedDaysInMonth
    const visibleStartDate = this.createDisplayedDate(1)
    const visibleEndDate = this.createDisplayedDate(daysInMonth)

    if (compareDates(endDate, visibleStartDate) < 0 || compareDates(startDate, visibleEndDate) > 0) {
      return null
    }

    const startDay = compareDates(startDate, visibleStartDate) <= 0 ? 1 : startDate.day
    const endDay = compareDates(endDate, visibleEndDate) >= 0 ? daysInMonth : endDate.day

    return {startDay, endDay}
  }

  private getRangeHighlightFromPool(index: number): CalendarHighlight | null {
    if (index >= MAX_RANGE_HIGHLIGHT_ROWS) return null

    while (this.state.highlights.range.length <= index) {
      this.state.highlights.range.push(
        this.createHighlight(
          RANGE_HIGHLIGHT_OBJECT_NAME_PREFIX + this.state.highlights.range.length,
          HighlightDefaultColor,
          this.state.highlights.rangeLayer!,
          DEFAULT_BUTTON_CORNER_RADIUS
        )
      )
    }

    return this.state.highlights.range[index]
  }

  /** Builds a disabled, unit-sized highlight rectangle parented to its stable hierarchy layer. */
  private createHighlight(name: string, color: vec4, parent: SceneObject, cornerRadius: number): CalendarHighlight {
    const sceneObject = createChildSceneObjectWithParentLayer(name, parent)
    const transform = sceneObject.getTransform()
    const size = new vec2(1, 1)

    const rectangle = sceneObject.createComponent(RoundedRectangle.getTypeName()) as RoundedRectangle
    rectangle.size = size
    rectangle.cornerRadius = cornerRadius
    rectangle.gradient = false
    rectangle.backgroundColor = color
    rectangle.blendMode = RoundedRectBlendMode.Normal
    rectangle.renderOrder = this.state.lifecycle.renderOrder
    rectangle.onInitialized.add(() => enableDepthOcclusion(rectangle))

    sceneObject.enabled = false
    return {
      sceneObject,
      transform,
      rectangle,
      localPosition: vec3.zero(),
      size
    }
  }

  private applyRangeHighlight(
    highlight: CalendarHighlight,
    dateRowIndex: number,
    startDay: number,
    endDay: number
  ): void {
    const firstDayColumn = this.displayedFirstDayColumn
    const startDayColumn = (firstDayColumn + startDay - 1) % DAYS_PER_WEEK
    const endDayColumn = (firstDayColumn + endDay - 1) % DAYS_PER_WEEK
    const startGridColumn = startDayColumn * DATE_COLUMN_SPAN
    const gridColumnSpan = (endDayColumn - startDayColumn + 1) * DATE_COLUMN_SPAN
    const width = this.gridSpanWidth(gridColumnSpan)
    const height = this.dateRowHeight

    const localPosition = highlight.localPosition
    localPosition.setXYZ(
      this.getGridSpanCenterX(startGridColumn, width),
      this.getDateRowCenterY(dateRowIndex, height),
      this.rangeHighlightZOffset
    )
    highlight.transform.setLocalPosition(localPosition)

    highlight.size.setXY(width, height)
    highlight.rectangle.size = highlight.size
    highlight.sceneObject.enabled = true
  }

  private hideRangeHighlightsFrom(startIndex: number): void {
    for (let i = startIndex; i < this.state.highlights.range.length; i++) {
      this.state.highlights.range[i].sceneObject.enabled = false
    }
  }

  /**
   * Shows the today indicator behind the device's current date when that
   * date's month is displayed in the Dates view, hiding it otherwise.
   */
  private syncTodayIndicator(): void {
    const today = this.state.view.deviceToday
    if (
      this.state.view.mode !== CalendarViewMode.Dates ||
      today.year !== this.state.view.displayYear ||
      today.month !== this.state.view.displayMonthIndex + 1
    ) {
      if (this.state.highlights.today) {
        this.state.highlights.today.sceneObject.enabled = false
      }
      return
    }

    if (!this.state.highlights.today) {
      // The date buttons render at the cell size with the fixed Rectangle
      // button corner radius, so the indicator reads as a button state.
      this.state.highlights.today = this.createHighlight(
        TODAY_INDICATOR_OBJECT_NAME,
        CalendarTodayIndicatorColor,
        this.state.highlights.todayLayer!,
        DEFAULT_BUTTON_CORNER_RADIUS
      )
    }

    const cellIndex = this.displayedFirstDayColumn + today.day - 1
    const row = Math.floor(cellIndex / DAYS_PER_WEEK)
    const column = cellIndex % DAYS_PER_WEEK
    const width = this.dateCellWidth
    const height = this.dateRowHeight

    const localPosition = this.state.highlights.today.localPosition
    localPosition.setXYZ(
      this.getGridSpanCenterX(column * DATE_COLUMN_SPAN, width),
      this.getDateRowCenterY(row, height),
      this.todayIndicatorZOffset
    )
    this.state.highlights.today.transform.setLocalPosition(localPosition)

    this.state.highlights.today.size.setXY(width, height)
    this.state.highlights.today.rectangle.size = this.state.highlights.today.size
    this.state.highlights.today.sceneObject.enabled = true
  }

  private updateHighlightRenderOrder(): void {
    for (const highlight of this.state.highlights.range) {
      highlight.rectangle.renderOrder = this.state.lifecycle.renderOrder
    }
    if (this.state.highlights.today) {
      this.state.highlights.today.rectangle.renderOrder = this.state.lifecycle.renderOrder
    }
  }

  private get displayedDaysInMonth(): number {
    return getDaysInMonth(this.state.view.displayYear, this.state.view.displayMonthIndex + 1)
  }

  private get displayedFirstDayColumn(): number {
    return getFirstDayColumn(this.state.view.displayYear, this.state.view.displayMonthIndex + 1)
  }

  /** The number of week rows the displayed month actually occupies (4-6). */
  private get displayedDateRowCount(): number {
    return Math.ceil((this.displayedFirstDayColumn + this.displayedDaysInMonth) / DAYS_PER_WEEK)
  }

  /**
   * Year pages are anchored to the decade of the resolved default date —
   * the date the calendar opened on, captured by applyDefaultDate — so the
   * first page a user sees starts at a decade boundary regardless of how
   * far they have navigated.
   */
  private getYearPageStart(year: number): number {
    const anchorPageStart = this.state.view.yearPageAnchorStart
    if (!isFinite(year)) return anchorPageStart

    return anchorPageStart + Math.floor((year - anchorPageStart) / YEAR_PAGE_SIZE) * YEAR_PAGE_SIZE
  }

  private get sizeScale(): number {
    this.ensureSizeScales()
    return this.state.metrics.sizeScale
  }

  private get heightScale(): number {
    this.ensureSizeScales()
    return this.state.metrics.heightScale
  }

  /**
   * Recomputes the cached size/height scales when _width/_height have changed
   * since the last read. Both derive only from _width/_height, so this runs
   * at most once per resize instead of re-deriving the clamp/min on every
   * scaled() / heightScaled() access.
   */
  private ensureSizeScales(): void {
    const metrics = this.state.metrics
    if (!metrics.scalesDirty) return

    metrics.scalesDirty = false
    metrics.sizeScale = clamp(
      Math.min(this._width / REFERENCE_WIDTH, this._height / REFERENCE_HEIGHT),
      MIN_SIZE_SCALE,
      Number.MAX_VALUE
    )
    metrics.heightScale = clamp(this._height / REFERENCE_HEIGHT, MIN_SIZE_SCALE, Number.MAX_VALUE)
  }

  private scaled(referenceValue: number): number {
    return referenceValue * this.sizeScale
  }

  private heightScaled(referenceValue: number): number {
    return referenceValue * this.heightScale
  }

  private get columnGap(): number {
    return this.scaled(REFERENCE_COLUMN_GAP)
  }

  private get rowGap(): number {
    return this.scaled(REFERENCE_ROW_GAP)
  }

  private get padding(): number {
    return this.scaled(REFERENCE_PADDING)
  }

  private get rangeHighlightZOffset(): number {
    return this.scaled(REFERENCE_RANGE_HIGHLIGHT_Z_OFFSET)
  }

  private get todayIndicatorZOffset(): number {
    return this.scaled(REFERENCE_TODAY_INDICATOR_Z_OFFSET)
  }

  private get contentZOffset(): number {
    return this.scaled(REFERENCE_CONTENT_Z_OFFSET)
  }

  private get headerTextSize(): number {
    return this.scaled(REFERENCE_HEADER_TEXT_SIZE)
  }

  private get bodyTextSize(): number {
    return this.scaled(REFERENCE_BODY_TEXT_SIZE)
  }

  private get dayHeaderTextSize(): number {
    return this.scaled(REFERENCE_DAY_HEADER_TEXT_SIZE)
  }

  private get headerRowHeight(): number {
    return this.heightScaled(REFERENCE_HEADER_ROW_HEIGHT)
  }

  private get dayHeaderRowHeight(): number {
    return this.heightScaled(REFERENCE_DAY_HEADER_ROW_HEIGHT)
  }

  private get dateRowHeight(): number {
    const totalRowGaps = (DATE_BODY_ROW_COUNT + 1) * this.rowGap
    const availableHeight = this._height - this.padding * 2 - totalRowGaps
    const dateRowsHeight = availableHeight - this.headerRowHeight - this.dayHeaderRowHeight
    return clamp(dateRowsHeight / DATE_BODY_ROW_COUNT, MIN_GRID_TRACK_SIZE, Number.MAX_VALUE)
  }

  /**
   * The background height that exactly fits a Dates layout spanning
   * rowCount week rows. Clamped like the track getters so degenerate tiny
   * heights stay positive.
   */
  private fittedHeightForDateRows(rowCount: number): number {
    const emptyRows = DATE_BODY_ROW_COUNT - rowCount
    return clamp(this._height - emptyRows * (this.dateRowHeight + this.rowGap), MIN_GRID_TRACK_SIZE, Number.MAX_VALUE)
  }

  /**
   * The five-row Dates footprint the Months and Years views match, so the
   * calendar doesn't resize when entering them from the most common month
   * shape.
   */
  private get fiveRowFittedHeight(): number {
    return this.fittedHeightForDateRows(MONTH_YEAR_EQUIVALENT_DATE_ROWS)
  }

  /**
   * The background height that hugs the rendered content, declared per view
   * mode in modeConfigs: the displayed month's week-row count in the Dates
   * view and the five-row footprint in the Months and Years views, reaching
   * the full (max) height only for six-row months.
   */
  private get fittedHeight(): number {
    return this.modeConfigs[this.state.view.mode].fittedHeight()
  }

  /**
   * Months/Years body rows are fixed-size tracks rather than fractions of
   * the full-height grid, so they pack at the top and the leftover space
   * sits under the shrunk background, like a short month's empty date rows.
   */
  private get monthYearBodyRowsTemplate(): string {
    return `repeat(${MONTH_YEAR_BODY_ROW_COUNT}, ${toCmString(this.monthYearRowHeight)})`
  }

  private get monthYearRowHeight(): number {
    const totalRowGaps = MONTH_YEAR_BODY_ROW_COUNT * this.rowGap
    const availableHeight = this.fiveRowFittedHeight - this.padding * 2 - totalRowGaps - this.headerRowHeight
    return clamp(availableHeight / MONTH_YEAR_BODY_ROW_COUNT, MIN_GRID_TRACK_SIZE, Number.MAX_VALUE)
  }

  private get buttonDepth(): number {
    return this.scaled(REFERENCE_BUTTON_DEPTH)
  }

  private get buttonSize(): vec3 {
    return new vec3(this.dateCellWidth, this.heightScaled(REFERENCE_BUTTON_HEIGHT), this.buttonDepth)
  }

  private get buttonContentSize(): vec2 {
    const size = this.buttonSize
    return new vec2(size.x, size.y)
  }

  private get textContentSize(): vec2 {
    return new vec2(this.dateCellWidth, this.dayHeaderRowHeight)
  }

  private get gridTrackWidth(): number {
    const totalColumnGaps = (GRID_COLUMNS - 1) * this.columnGap
    const availableWidth = this._width - this.padding * 2 - totalColumnGaps
    return clamp(availableWidth / GRID_COLUMNS, MIN_GRID_TRACK_SIZE, Number.MAX_VALUE)
  }

  /** Width of a span of grid columns, including the gaps inside the span. */
  private gridSpanWidth(columnSpan: number): number {
    return this.gridTrackWidth * columnSpan + (columnSpan - 1) * this.columnGap
  }

  private get dateCellWidth(): number {
    return this.gridSpanWidth(DATE_COLUMN_SPAN)
  }

  private getGridSpanCenterX(startGridColumn: number, width: number): number {
    const startX = this.padding + startGridColumn * (this.gridTrackWidth + this.columnGap)
    return startX + width * 0.5 - this._width * 0.5
  }

  private getDateRowCenterY(dateRowIndex: number, height: number): number {
    const dateRowsStartY = this.padding + this.headerRowHeight + this.rowGap + this.dayHeaderRowHeight + this.rowGap
    const rowStartY = dateRowsStartY + dateRowIndex * (height + this.rowGap)
    return this._height * 0.5 - (rowStartY + height * 0.5)
  }
}

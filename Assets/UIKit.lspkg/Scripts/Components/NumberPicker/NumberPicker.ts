import {Interactor} from "InteractionKit.lspkg/Core/Interactor/Interactor"
import {DragInteractorEvent, InteractorEvent} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import animate, {CancelSet} from "InteractionKit.lspkg/Utils/animate"
import Event, {PublicApi} from "InteractionKit.lspkg/Utils/Event"
import {clamp} from "InteractionKit.lspkg/Utils/mathUtils"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import {
  createChildSceneObjectWithParentLayer,
  isSceneObjectAncestorOf,
  reappendChild,
  reparentExternalChild,
  unparentExternalChild
} from "../../../Scripts/Utility/SceneUtilities"
import type {NumberPickerFieldData, NumberPickerFieldDataOperation} from "../../../Scripts/Utility/UIKitUtilities"
import {
  applyNumberPickerFieldDataOperations,
  getNumberPickerFieldInitialIndex,
  getNumberPickerFieldOptionValues,
  getNumberPickerVisibleRowCount,
  isEqual,
  isValidNumberPickerFieldIndex,
  positiveModulo,
  shouldWrapNumberPickerField
} from "../../../Scripts/Utility/UIKitUtilities"
import {
  ContentIdleGray,
  NumberPickerBackgroundColor,
  NumberPickerDraggedSelectedOptionTextColor,
  NumberPickerSelectionBandDefaultColor,
  NumberPickerSelectionBandHoveredColor,
  NumberPickerSelectionBandPressedColor
} from "../../Themes/System-3.0/Colors"
import {CanvasController} from "../../Utility/CanvasController"
import {VerticalEdgeFadeBandMesh} from "../../Utility/EdgeFadeMesh"
import {RoundedRectangle} from "../../Visuals/RoundedRectangle/RoundedRectangle"
import {
  RoundedRectangleVisual,
  RoundedRectangleVisualParameters
} from "../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {StateName} from "../Element"
import {FlexItem} from "../Layout2D/Flex/FlexItem"
import {FlexLayout} from "../Layout2D/Flex/FlexLayout"
import {FlexAlign, FlexDirection} from "../Layout2D/Flex/FlexTypes"
import {VisualElement} from "../VisualElement"
import {NumberPickerFieldScroller} from "./NumberPickerFieldScroller"

const log = new NativeLogger("NumberPicker")

const CONTAINER_OBJECT_NAME = "NumberPickerContainer"
const BACKGROUND_OBJECT_NAME = "NumberPickerBackground"
const FIELD_LAYOUT_OBJECT_NAME = "NumberPickerFieldLayout"
const FIELD_OBJECT_NAME_PREFIX = "NumberPickerField_"
const FIELD_CONTENT_OBJECT_NAME_PREFIX = "NumberPickerFieldContent_"
const OPTION_OBJECT_NAME_PREFIX = "NumberPickerFieldOption_"
const EDGE_FADE_OBJECT_NAME = "NumberPickerEdgeFade"
const SELECTION_BAND_OBJECT_NAME = "NumberPickerSelectionBand"
const SELECTED_FIELD_VISUAL_OBJECT_NAME = "NumberPickerSelectedFieldVisual"
const BACKGROUND_CORNER_RADIUS = 0.5
const SELECTION_BAND_CORNER_RADIUS = 0.5
const SELECTION_BAND_HORIZONTAL_PADDING = 0.25
const SELECTED_FIELD_VISUAL_SIZE_RATIO = 0.88
const OPTION_TEXT_SIZE_SCALE = 11
const OPTION_POOL_BUFFER_ROWS = 1
const WRAP_AROUND_EXTRA_BUFFER_ROWS = OPTION_POOL_BUFFER_ROWS
const OPTION_TEXT_OPACITY_STEP = 1 / 16
const OPTION_TEXT_FADE_OUT_INSET_RATIO = 0.15
const FORM_ANIMATION_DURATION = 0.2
const SELECTED_FIELD_OPACITY_EPSILON = 0.001
const SELECTED_FIELD_MOVE_ANIMATION_DURATION = 0.05
const SELECTION_BAND_Z_OFFSET = 0.1
const SELECTED_FIELD_VISUAL_Z_OFFSET = 0.2
const OPTION_TEXT_Z_OFFSET = 0.3
const EDGE_FADE_Z_OFFSET = 0.05

const SELECTION_BAND_STYLE: Partial<RoundedRectangleVisualParameters> = {
  default: {
    baseType: "Color",
    baseColor: NumberPickerSelectionBandDefaultColor,
    hasBorder: false
  },
  hovered: {
    baseType: "Color",
    baseColor: NumberPickerSelectionBandHoveredColor,
    hasBorder: false
  },
  triggered: {
    baseType: "Color",
    baseColor: NumberPickerSelectionBandPressedColor,
    hasBorder: false
  },
  toggledDefault: {
    baseType: "Color",
    baseColor: NumberPickerSelectionBandDefaultColor,
    hasBorder: false
  },
  toggledHovered: {
    baseType: "Color",
    baseColor: NumberPickerSelectionBandDefaultColor,
    hasBorder: false
  },
  toggledTriggered: {
    baseType: "Color",
    baseColor: NumberPickerSelectionBandDefaultColor,
    hasBorder: false
  }
}

const ALWAYS_EXPANDED_SELECTION_BAND_STYLE: Partial<RoundedRectangleVisualParameters> = {
  default: SELECTION_BAND_STYLE.toggledDefault,
  hovered: SELECTION_BAND_STYLE.toggledHovered,
  triggered: SELECTION_BAND_STYLE.toggledTriggered
}

const SELECTED_FIELD_STYLE: Partial<RoundedRectangleVisualParameters> = {
  default: {
    baseType: "Color",
    baseColor: NumberPickerSelectionBandHoveredColor,
    hasBorder: false
  },
  triggered: {
    baseType: "Color",
    baseColor: NumberPickerSelectionBandPressedColor,
    hasBorder: false
  }
}

@typedef
export class NumberPickerFieldInput {
  @input
  @widget(new ComboBoxWidget([new ComboBoxItem("Range", "range"), new ComboBoxItem("Custom", "custom")]))
  private fieldType: string = "range"

  @input("int")
  @showIf("fieldType", "range")
  private minRange: number = 0

  @input("int")
  @showIf("fieldType", "range")
  private maxRange: number = 9

  @input("int")
  @showIf("fieldType", "range")
  private step: number = 1

  @input("int")
  @showIf("fieldType", "range")
  private minNumberDigits: number = 1

  @input
  @showIf("fieldType", "custom")
  private customValues: string[] = []

  @input
  private wrapAround: boolean = false

  @input("int")
  @showIf("fieldType", "range")
  private defaultNumber: number = 0

  @input
  @showIf("fieldType", "custom")
  private defaultValue: string = ""
}

type NumberPickerField = {
  object: SceneObject
  item: FlexItem
  contentObject: SceneObject
  contentLayout: FlexLayout
  scroller: NumberPickerFieldScroller
  committedSelection: NumberPickerCommittedFieldSelection
  optionValues: string[]
  renderedOptionValues: string[]
  options: NumberPickerFieldOption[]
  contentHeight: number
  poolStartIndex: number
  dragSelectedRenderedIndex: number
  dragSelectedPoolStartIndex: number
  wrapAround: boolean
}

type NumberPickerFieldOption = {
  object: SceneObject
  item: FlexItem
  text: Text
  textEnabled: boolean
  edgeOpacity: number
}

type NumberPickerCommittedFieldSelection = {
  optionIndex: number
  optionValue: string | null
}

type NumberPickerContainerState = {
  object: SceneObject | null
  transform: Transform | null
  edgeFadeObject: SceneObject | null
  edgeFadeTransform: Transform | null
  edgeFadeVisual: RenderMeshVisual | null
  edgeFadeMesh: VerticalEdgeFadeBandMesh | null
  edgeFadeMaterial: Material
  edgeFadePosition: vec3
  edgeFadeScale: vec3
  position: vec3
  size: vec2
}

type NumberPickerBackgroundState = {
  object: SceneObject | null
  transform: Transform | null
  roundedRectangle: RoundedRectangle | null
  size: vec2
  visualSize: vec2
}

type NumberPickerFieldsState = {
  layoutObject: SceneObject | null
  layout: FlexLayout | null
  items: NumberPickerField[]
  optionPosition: vec3
  pendingDataOperations: NumberPickerFieldDataOperation[]
}

type NumberPickerSelectionState = {
  bandObject: SceneObject | null
  bandVisual: RoundedRectangleVisual | null
  bandPosition: vec3
  bandSize: vec3
  selectedObject: SceneObject | null
  selectedTransform: Transform | null
  selectedVisual: RoundedRectangleVisual | null
  hoveredInteractor: Interactor | null
  activeField: NumberPickerField | null
  isExpanded: boolean
  selectedField: number
  targetField: NumberPickerField | null
  opacity: number
  fadeTargetOpacity: number
  position: vec3
  moveStartPosition: vec3
  moveTargetPosition: vec3
  animatedPosition: vec3
  size: vec3
}

type NumberPickerAnimationState = {
  formCancelSet: CancelSet
  selectedFieldFadeCancelSet: CancelSet
  selectedFieldMoveCancelSet: CancelSet
}

type NumberPickerBatchState = {
  updateEvent: SceneEvent | null
  canvasBindingDirty: boolean
  geometryDirty: boolean
  visualSizeDirty: boolean
  fieldLayoutDirty: boolean
  renderOrderDirty: boolean
  colliderDirty: boolean
  selectedFieldVisualDirty: boolean
  selectedValuesDirty: boolean
  selectedValuesSnapshot: (string | null)[]
}

type NumberPickerState = {
  container: NumberPickerContainerState
  background: NumberPickerBackgroundState
  fields: NumberPickerFieldsState
  selection: NumberPickerSelectionState
  animation: NumberPickerAnimationState
  batch: NumberPickerBatchState
}

/**
 * Multi-field wheel picker for choosing range or custom string values.
 *
 * NumberPicker owns one scrollable column per field and exposes runtime APIs
 * for reading, setting, resetting, and changing field data.
 * Selection getters expose the last committed wheel selection. Non-animated
 * programmatic changes commit synchronously; animated and dragged changes commit
 * after every field settles. Selection-change events remain batched.
 */
@component
export class NumberPicker extends VisualElement {
  private readonly optionTextDisplayColor: vec4 = vec4.zero()

  // ─── Layout ──────────────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Layout</span>')
  @input("int")
  @widget(new SliderWidget(1, 10, 1))
  private _numberOfRowsShown: number = 5

  @input
  private _alwaysExpanded: boolean = false

  // ─── Fields ──────────────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Fields</span>')
  @input
  private _fields: NumberPickerFieldInput[]

  // ─── Internal State ──────────────────────────────────────────────────

  private readonly state: NumberPickerState = {
    container: {
      object: null,
      transform: null,
      edgeFadeObject: null,
      edgeFadeTransform: null,
      edgeFadeVisual: null,
      edgeFadeMesh: null,
      edgeFadeMaterial: (requireAsset("../../../Materials/NumberPickerFadeMask.mat") as Material).clone(),
      edgeFadePosition: new vec3(0, 0, EDGE_FADE_Z_OFFSET),
      edgeFadeScale: vec3.one(),
      position: vec3.zero(),
      size: vec2.zero()
    },
    background: {
      object: null,
      transform: null,
      roundedRectangle: null,
      size: vec2.zero(),
      visualSize: vec2.zero()
    },
    fields: {
      layoutObject: null,
      layout: null,
      items: [],
      optionPosition: new vec3(0, 0, OPTION_TEXT_Z_OFFSET),
      pendingDataOperations: []
    },
    selection: {
      bandObject: null,
      bandVisual: null,
      bandPosition: new vec3(0, 0, SELECTION_BAND_Z_OFFSET),
      bandSize: vec3.one(),
      selectedObject: null,
      selectedTransform: null,
      selectedVisual: null,
      hoveredInteractor: null,
      activeField: null,
      isExpanded: false,
      selectedField: -1,
      targetField: null,
      opacity: 0,
      fadeTargetOpacity: 0,
      position: vec3.zero(),
      moveStartPosition: vec3.zero(),
      moveTargetPosition: vec3.zero(),
      animatedPosition: vec3.zero(),
      size: vec3.one()
    },
    animation: {
      formCancelSet: new CancelSet(),
      selectedFieldFadeCancelSet: new CancelSet(),
      selectedFieldMoveCancelSet: new CancelSet()
    },
    batch: {
      updateEvent: null,
      canvasBindingDirty: false,
      geometryDirty: false,
      visualSizeDirty: false,
      fieldLayoutDirty: false,
      renderOrderDirty: false,
      colliderDirty: false,
      selectedFieldVisualDirty: false,
      selectedValuesDirty: false,
      selectedValuesSnapshot: []
    }
  }

  private isReleasing: boolean = false
  private canvasController: CanvasController | null = null
  private pendingAuthoredChildren: SceneObject[] | null = null
  private requestedIntermediateFillDepthWrite: boolean = true

  // ─── Events ──────────────────────────────────────────────────────────

  private readonly events = {
    selectedFieldChange: new Event<number>(),
    selectedValuesChange: new Event<string[]>()
  }

  /** Event fired when the selected field index changes. */
  public readonly onSelectedFieldChange: PublicApi<number> = this.events.selectedFieldChange.publicApi()

  /**
   * Event fired after every field settles and one or more committed field values change.
   * Public selected-value getters are updated before listeners are invoked.
   * A field without a value is emitted as an empty string; use getFieldOptionValue
   * to distinguish it from an option whose value is an empty string.
   */
  public readonly onSelectedValuesChange: PublicApi<string[]> = this.events.selectedValuesChange.publicApi()

  // ─── Public Getters / Setters ────────────────────────────────────────

  public get isDraggable(): boolean {
    return this._alwaysExpanded || this.state.selection.isExpanded
  }

  /**
   * Gets whether the picker stays expanded and draggable instead of toggling.
   * @returns Whether the picker is always expanded.
   */
  public get alwaysExpanded(): boolean {
    return this._alwaysExpanded
  }

  /**
   * Sets whether the picker stays expanded and draggable instead of toggling.
   * @param value - Whether the picker should always stay expanded.
   */
  public set alwaysExpanded(value: boolean) {
    if (value === undefined) return
    if (value === this._alwaysExpanded) return

    this._alwaysExpanded = value

    if (this.initialized) {
      this.setExpanded(value)
      this.recreateSelectionBandVisual()
      this.syncAlwaysExpandedInteractionMode()
    }
  }

  /**
   * Gets the depth-write state currently applied to the selection-band visual.
   * Setting this property also updates requestedDepthWrite. Foreground children can
   * force the applied value to remain false while present.
   */
  public get depthWrite(): boolean {
    return super.depthWrite
  }

  /**
   * @see depthWrite
   */
  public set depthWrite(depthWrite: boolean) {
    this.requestedDepthWrite = depthWrite
  }

  /**
   * Controls the depth-write state to restore when no foreground children are present.
   * Defaults to true for compatibility. Developer-owned foreground children force the
   * applied depthWrite value to false while present so children at z=0 remain visible.
   * Children managed through addChild and removeChild are tracked automatically; call
   * refreshChildren after changing the child hierarchy through raw Lens APIs.
   */
  public get requestedDepthWrite(): boolean {
    return this.requestedIntermediateFillDepthWrite
  }

  /**
   * @see requestedDepthWrite
   */
  public set requestedDepthWrite(depthWrite: boolean) {
    if (depthWrite === undefined) return
    this.requestedIntermediateFillDepthWrite = depthWrite
    this.applyIntermediateFillDepthWritePolicy()
  }

  /**
   * Gets the base render order used by picker visuals.
   * @returns The base render order.
   */
  public get renderOrder(): number {
    return super.renderOrder
  }

  /**
   * Sets the base render order used by picker visuals.
   * @param value - The new integer render order.
   */
  public set renderOrder(value: number) {
    if (value === undefined) return
    if (!Number.isInteger(value)) {
      log.w(`renderOrder: ${value} is not an integer`)
      return
    }
    if (value === this.renderOrder) return

    super.renderOrder = value
    this.markRenderOrderDirty()
  }

  /**
   * Gets the picker size.
   * @returns The picker size.
   */
  public get size(): vec3 {
    return super.size
  }

  /**
   * Sets the picker size.
   * @param size - The new picker size.
   */
  public set size(size: vec3) {
    if (size === undefined || isEqual(size, this.size)) return

    this.state.animation.formCancelSet.cancel()
    super.size = size
    this.markGeometryDirty()
    this.markVisualSizeDirty()
    this.markColliderDirty()
  }

  /**
   * Gets the number of rows shown while expanded.
   * @returns The expanded visible row count.
   */
  public get numberOfRowsShown(): number {
    return this._numberOfRowsShown
  }

  /**
   * Sets the number of rows shown while expanded.
   * @param value - Integer row count in the inclusive range [1, 10].
   */
  public set numberOfRowsShown(value: number) {
    if (value === undefined) return
    if (value < 1 || value > 10) {
      log.w(`numberOfRowsShown: ${value} is out of range [1, 10]`)
      return
    }
    if (!Number.isInteger(value)) {
      log.w(`numberOfRowsShown: ${value} is not an integer`)
      return
    }
    if (value === this.numberOfRowsShown) return

    this.state.animation.formCancelSet.cancel()
    this._numberOfRowsShown = value
    this.markGeometryDirty()
    this.markVisualSizeDirty()
    this.markColliderDirty()
  }

  /**
   * Gets the developer-managed children of this picker.
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
   * Reconciles developer-owned foreground children after raw Lens API hierarchy changes.
   * Current direct children are moved after picker-owned visuals in hierarchy order and
   * the effective depth-write policy is refreshed. Prefer addChild and removeChild when possible.
   */
  public refreshChildren(): void {
    if (this.isReleasing) {
      return
    }

    if (this.initialized) {
      this.moveChildrenToForeground(this.getRootContentChildren())
    }
    this.applyIntermediateFillDepthWritePolicy()
  }

  /**
   * Schedules the inherited Canvas binding to be re-evaluated before rendering.
   * Call this after reparenting the picker or changing ancestor Canvas topology
   * or configuration through raw Lens APIs. A live locally managed Canvas remains
   * authoritative and is not replaced by an ancestor Canvas.
   */
  public invalidateCanvasBinding(): void {
    if (!this.canvasController) {
      return
    }

    this.canvasController.invalidate()
    if (!this.initialized) {
      return
    }

    this.state.batch.canvasBindingDirty = true
    this.batchUpdate()
  }

  /**
   * Adds a developer-owned SceneObject as a foreground child.
   * Before initialization, root children are moved to the foreground during
   * initialization.
   * Non-ScreenTransform children retain their world position, rotation, and scale.
   * @param sceneObject - The SceneObject to add.
   */
  public addChild(sceneObject: SceneObject): void {
    const parent = this.getChildrenParent()
    if (
      !parent ||
      isNull(sceneObject) ||
      this.managedSceneObjects.has(sceneObject) ||
      isSceneObjectAncestorOf(sceneObject, parent)
    ) {
      return
    }

    if (sceneObject.getParent() !== parent) {
      reparentExternalChild(sceneObject, parent)
    }
    this.applyIntermediateFillDepthWritePolicy()
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
    this.applyIntermediateFillDepthWritePolicy()
  }

  /**
   * Gets the number of configured picker fields, including queued pre-initialization changes.
   * @returns The field count.
   */
  public get fieldCount(): number {
    if (this.initialized) {
      return this.state.fields.items.length
    }

    return applyNumberPickerFieldDataOperations(this.fields, this.state.fields.pendingDataOperations).length
  }

  /**
   * Gets the selected field index, or -1 when the picker has no fields.
   * @returns The selected field index.
   */
  public get selectedField(): number {
    return this.fieldCount > 0 ? this.state.selection.selectedField : -1
  }

  /**
   * Sets the selected field index.
   * @param fieldIndex - Field index, or -1 to clear the selected-field visual.
   */
  public set selectedField(fieldIndex: number) {
    if (!this.initialized) return
    if (fieldIndex === undefined) return
    if (!isValidNumberPickerFieldIndex(fieldIndex, this.fieldCount) && fieldIndex !== -1) {
      log.w(`selectedField: ${fieldIndex} is out of range [-1, ${this.fieldCount - 1}]`)
      return
    }

    this.setSelectedFieldIndex(fieldIndex, true)
  }

  /**
   * Gets the committed selected option index for a field.
   * @param fieldIndex - Field index to query.
   * @returns The selected option index, or -1 when the field is invalid.
   */
  public getFieldOptionIndex(fieldIndex: number): number {
    return this.state.fields.items[fieldIndex]?.committedSelection.optionIndex ?? -1
  }

  /**
   * Gets the committed selected option value for a field.
   * @param fieldIndex - Field index to query.
   * @returns The selected value, or null when the field has no value.
   */
  public getFieldOptionValue(fieldIndex: number): string | null {
    return this.state.fields.items[fieldIndex]?.committedSelection.optionValue ?? null
  }

  /**
   * Sets the selected option index for a field.
   * @param fieldIndex - Field index to update.
   * @param index - Option index to select.
   * @param animate - Whether to animate to the selected option.
   */
  public setFieldOptionIndex(fieldIndex: number, index: number, animate: boolean = false): void {
    if (!this.initialized) return
    if (this.setFieldOptionIndexInternal(fieldIndex, index, animate)) {
      this.markSelectedValuesDirty()
    }
  }

  /**
   * Sets the selected option value for a field.
   * @param fieldIndex - Field index to update.
   * @param value - Option value to select.
   * @param animate - Whether to animate to the selected option.
   */
  public setFieldOptionValue(fieldIndex: number, value: string, animate: boolean = false): void {
    if (!this.initialized) return
    if (this.setFieldOptionValueInternal(fieldIndex, value, animate)) {
      this.markSelectedValuesDirty()
    }
  }

  /**
   * Resets every field to its configured default value.
   */
  public reset(): void {
    if (!this.initialized) return
    let didChange = false
    const fieldData = this.fields
    for (let i = 0; i < this.state.fields.items.length; i++) {
      const field = this.state.fields.items[i]
      didChange =
        this.setFieldOptionIndexInternal(
          i,
          getNumberPickerFieldInitialIndex(fieldData[i], field.optionValues),
          false
        ) || didChange
    }
    if (didChange) {
      this.markSelectedValuesDirty()
    }
  }

  /**
   * Gets the committed selected option indices in field order.
   * @returns The selected option indices.
   */
  public getSelectedValuesIndices(): number[] {
    return this.state.fields.items.map((field) => field.committedSelection.optionIndex)
  }

  /**
   * Gets the committed selected option values in field order.
   * @returns The selected values.
   */
  public getSelectedValues(): string[] {
    return this.state.fields.items.map((field) => field.committedSelection.optionValue ?? "")
  }

  /**
   * Sets the selected option values in field order.
   * @param values - Values to select.
   * @param animate - Whether to animate fields to their selected options.
   */
  public setSelectedValues(values: string[], animate: boolean = false): void {
    if (!this.initialized) return
    if (values === undefined) return
    if (values.length !== this.fieldCount) {
      log.w(`setSelectedValues: expected ${this.fieldCount} values, got ${values.length}`)
      return
    }

    const indices: number[] = []
    for (let i = 0; i < values.length; i++) {
      const field = this.state.fields.items[i]
      const optionIndex = field.optionValues.indexOf(values[i])
      if (optionIndex < 0) {
        log.w(`setSelectedValues: value "${values[i]}" was not found in field ${i}`)
        return
      }
      indices.push(optionIndex)
    }

    let didChange = false
    for (let i = 0; i < indices.length; i++) {
      didChange = this.setFieldOptionIndexInternal(i, indices[i], animate) || didChange
    }
    if (didChange) {
      this.markSelectedValuesDirty()
    }
  }

  /**
   * Appends field data, or replaces the field data at the given index.
   * @param data - Field data to apply.
   * @param fieldIndex - Field index to replace, or -1 to append a new field.
   */
  public setFieldData(data: NumberPickerFieldData, fieldIndex: number = -1): void {
    if (data === undefined) return

    if (!this.initialized) {
      this.queuePendingSetFieldData(data, fieldIndex)
      return
    }

    const fieldData = this.fields
    if (fieldIndex === -1) {
      fieldData.push(data)
      this.appendRuntimeField(data)
      this.markSelectedValuesDirty()
      return
    }

    if (!isValidNumberPickerFieldIndex(fieldIndex, this.fieldCount)) {
      log.w(`setFieldData: fieldIndex ${fieldIndex} is out of range [0, ${fieldData.length - 1}]`)
      return
    }

    fieldData[fieldIndex] = data
    this.replaceRuntimeField(fieldIndex, data)
    this.markSelectedValuesDirty()
  }

  /**
   * Removes field data at the given index.
   * @param fieldIndex - Field index to remove.
   */
  public removeFieldData(fieldIndex: number): void {
    if (!this.initialized) {
      this.queuePendingRemoveFieldData(fieldIndex)
      return
    }

    const fieldData = this.fields
    if (!isValidNumberPickerFieldIndex(fieldIndex, this.fieldCount)) {
      log.w(`removeFieldData: fieldIndex ${fieldIndex} is out of range [0, ${fieldData.length - 1}]`)
      return
    }

    const previousSelectedField = this.state.selection.selectedField
    fieldData.splice(fieldIndex, 1)
    this.removeRuntimeField(fieldIndex, previousSelectedField)
    this.markSelectedValuesDirty()
  }

  public initialize(): boolean {
    if (this.initialized) {
      return false
    }

    this.pendingAuthoredChildren = this.getRootContentChildren()
    this.state.selection.isExpanded = this._alwaysExpanded

    this.updateContainerGeometry()
    this.applyPendingFieldDataOperations()
    this.canvasController ??= new CanvasController(this.sceneObject)
    this.canvasController.ensure(this.state.container.size)

    if (!super.initialize()) {
      return false
    }
    this.applyIntermediateFillDepthWritePolicy()
    this.interactable.allowMultipleInteractors = false
    this.updateVisualSizes()
    this.updateVisualRenderOrders()
    this.state.selection.selectedField =
      this.state.selection.selectedField === -1 || this.state.fields.items.length === 0
        ? -1
        : clamp(this.state.selection.selectedField, 0, this.fieldCount - 1)
    return true
  }

  protected release(): void {
    this.isReleasing = true
    this.state.batch.canvasBindingDirty = false
    try {
      this.state.animation.formCancelSet.cancel()
      this.state.animation.selectedFieldFadeCancelSet.cancel()
      this.state.animation.selectedFieldMoveCancelSet.cancel()
      this.state.selection.targetField = null
      this.state.selection.opacity = 0
      this.state.selection.fadeTargetOpacity = 0
      if (this.state.selection.selectedVisual && !isNull(this.state.selection.selectedVisual)) {
        this.state.selection.selectedVisual.destroy()
      }
      this.state.selection.selectedVisual = null
      this.state.selection.selectedTransform = null
      this.state.selection.selectedObject = null
      super.release()
    } finally {
      const canvasController = this.canvasController
      this.canvasController = null
      canvasController?.release()
    }
  }

  protected get isToggle(): boolean {
    return !this._alwaysExpanded
  }

  protected get shouldEnableInstantDrag(): boolean {
    return false
  }

  protected onEnabled(): void {
    super.onEnabled()
    this.invalidateCanvasBinding()
  }

  /**
   * Seeds the committed selection and moves developer-owned children after
   * picker-owned visuals in hierarchy order before Element publishes its
   * initialized event.
   */
  protected beforeInitialized(): void {
    super.beforeInitialized()
    this.state.batch.selectedValuesSnapshot = this.getCommittedFieldValues()

    const authoredChildren = this.pendingAuthoredChildren
    this.pendingAuthoredChildren = null
    if (authoredChildren) {
      this.moveChildrenToForeground(authoredChildren)
    }
  }

  protected createDefaultVisual(): void {
    if (!this.state.batch.updateEvent) {
      this.createBatchUpdateEvent()
    }
    if (!this.state.background.object) {
      this.createBackgroundVisual()
    }
    if (!this._visual) {
      this.createSelectionBandVisual()
    }
    if (!this.state.selection.selectedObject) {
      this.createSelectedFieldVisual()
    }
    if (!this.state.container.object) {
      this.createContainer()
    }
    if (!this.state.fields.layoutObject) {
      this.createHorizontalFieldLayout()
    }
    if (!this.state.container.edgeFadeVisual) {
      this.createEdgeFadeVisual()
    }
  }

  private moveChildrenToForeground(authoredChildren: SceneObject[]): void {
    const rootContentChildren = this.getRootContentChildren()
    const childrenToMove = [
      ...authoredChildren.filter((child) => rootContentChildren.includes(child)),
      ...rootContentChildren.filter((child) => !authoredChildren.includes(child))
    ]

    for (const child of childrenToMove) {
      if (!isNull(child) && !this.managedSceneObjects.has(child) && child.getParent() === this.sceneObject) {
        reappendChild(child)
      }
    }
  }

  private getRootContentChildren(): SceneObject[] {
    return super.contentChildren
  }

  private getChildrenParent(): SceneObject | null {
    return this.isReleasing ? null : this.sceneObject
  }

  private createContainer(): void {
    this.state.container.object = createChildSceneObjectWithParentLayer(CONTAINER_OBJECT_NAME, this.sceneObject)
    this.state.container.transform = this.state.container.object.getTransform()
    this.managedSceneObjects.add(this.state.container.object)
  }

  private createEdgeFadeVisual(): void {
    const container = this.state.container
    container.edgeFadeObject = createChildSceneObjectWithParentLayer(EDGE_FADE_OBJECT_NAME, container.object!)
    container.edgeFadeTransform = container.edgeFadeObject.getTransform()
    container.edgeFadeTransform.setLocalPosition(container.edgeFadePosition)

    container.edgeFadeVisual = container.edgeFadeObject.createComponent("RenderMeshVisual")
    container.edgeFadeMesh = new VerticalEdgeFadeBandMesh()
    container.edgeFadeVisual.mesh = container.edgeFadeMesh.mesh
    container.edgeFadeVisual.mainMaterial = container.edgeFadeMaterial
    container.edgeFadeVisual.mainPass.fadeColor = new vec3(
      NumberPickerBackgroundColor.x,
      NumberPickerBackgroundColor.y,
      NumberPickerBackgroundColor.z
    )
    // Track the background plane with only a small forward separation, keeping
    // the silhouettes aligned without z-fighting or losing scene depth occlusion.
    container.edgeFadeVisual.mainPass.depthTest = true
    container.edgeFadeVisual.mainPass.depthWrite = false
    container.edgeFadeVisual.enabled = false
  }

  private createBackgroundVisual(): void {
    this.state.background.object = createChildSceneObjectWithParentLayer(BACKGROUND_OBJECT_NAME, this.sceneObject)
    this.managedSceneObjects.add(this.state.background.object)
    this.state.background.transform = this.state.background.object.getTransform()

    this.state.background.roundedRectangle = this.state.background.object.createComponent(
      RoundedRectangle.getTypeName()
    ) as RoundedRectangle
    this.state.background.roundedRectangle.backgroundColor = NumberPickerBackgroundColor
    this.state.background.roundedRectangle.cornerRadius = BACKGROUND_CORNER_RADIUS
    this.state.background.roundedRectangle.border = false
  }

  private createHorizontalFieldLayout(): void {
    this.state.fields.layoutObject = createChildSceneObjectWithParentLayer(
      FIELD_LAYOUT_OBJECT_NAME,
      this.state.container.object!
    )

    this.state.fields.layout = this.state.fields.layoutObject.createComponent(FlexLayout.getTypeName()) as FlexLayout
    this.state.fields.layout.autoDiscoverItemsOnStart = false
    this.state.fields.layout.direction = FlexDirection.Row
    this.state.fields.layout.alignItems = FlexAlign.Stretch
    this.state.fields.layout.width = this.getFieldLayoutWidth()
    this.state.fields.layout.height = this.state.container.size.y

    this.createFieldOptionColumns()
  }

  private createFieldOptionColumns(): void {
    const fieldData = this.fields
    const fieldCount = fieldData.length
    const fieldWidth = this.getFieldWidth(fieldCount)
    const fieldItems: FlexItem[] = []
    for (let i = 0; i < fieldCount; i++) {
      const field = this.createFieldOptionColumn(i, fieldData[i], fieldWidth)
      this.state.fields.items.push(field)
      fieldItems.push(field.item)
    }

    if (fieldItems.length > 0) {
      this.state.fields.layout.addItems(fieldItems)
    }
  }

  private createFieldOptionColumn(
    fieldIndex: number,
    fieldData: NumberPickerFieldData,
    fieldWidth = this.getFieldWidth()
  ): NumberPickerField {
    const optionValues = getNumberPickerFieldOptionValues(fieldData)
    const wrapAround = shouldWrapNumberPickerField(fieldData, optionValues)
    const renderedOptionValues = this.getRenderedOptionValues(optionValues, wrapAround)
    const fieldObject = createChildSceneObjectWithParentLayer(
      `${FIELD_OBJECT_NAME_PREFIX}${fieldIndex}`,
      this.state.fields.layoutObject!
    )

    const fieldItem = fieldObject.createComponent(FlexItem.getTypeName()) as FlexItem
    fieldItem.setFlex(1)
    fieldItem.overrideWidth = fieldWidth
    fieldItem.overrideHeight = this.state.container.size.y

    const contentObject = createChildSceneObjectWithParentLayer(
      `${FIELD_CONTENT_OBJECT_NAME_PREFIX}${fieldIndex}`,
      fieldObject
    )
    const contentLayout = contentObject.createComponent(FlexLayout.getTypeName()) as FlexLayout
    contentLayout.autoDiscoverItemsOnStart = false
    contentLayout.direction = FlexDirection.Column
    contentLayout.alignItems = FlexAlign.Stretch
    contentLayout.width = fieldWidth

    const initialSelectedIndex = getNumberPickerFieldInitialIndex(fieldData, optionValues)
    const field: NumberPickerField = {
      object: fieldObject,
      item: fieldItem,
      contentObject: contentObject,
      contentLayout: contentLayout,
      scroller: new NumberPickerFieldScroller(contentObject.getTransform(), initialSelectedIndex),
      committedSelection: {
        optionIndex: initialSelectedIndex,
        optionValue: optionValues[initialSelectedIndex] ?? null
      },
      optionValues: optionValues,
      renderedOptionValues: renderedOptionValues,
      options: [],
      contentHeight: this.getFieldContentHeight(renderedOptionValues.length),
      poolStartIndex: -1,
      dragSelectedRenderedIndex: -1,
      dragSelectedPoolStartIndex: -1,
      wrapAround: wrapAround
    }

    this.updateOptionPoolSize(field)
    this.updateFieldLayout(field, renderedOptionValues.length, fieldWidth)
    this.rebalanceOptionPoolForField(field, true)
    return field
  }

  private createOptionRow(fieldObject: SceneObject, poolIndex: number): NumberPickerFieldOption {
    const optionObject = createChildSceneObjectWithParentLayer(`${OPTION_OBJECT_NAME_PREFIX}${poolIndex}`, fieldObject)
    optionObject.getTransform().setLocalPosition(this.state.fields.optionPosition)

    const optionText = optionObject.createComponent("Component.Text") as Text
    this.configureOptionText(optionText, "")
    optionText.depthTest = true
    optionText.renderOrder = this._renderOrder

    const optionItem = optionObject.createComponent(FlexItem.getTypeName()) as FlexItem
    optionItem.setFlex(1)

    return {
      object: optionObject,
      item: optionItem,
      text: optionText,
      textEnabled: true,
      edgeOpacity: 1
    }
  }

  private configureOptionText(optionText: Text, text: string): void {
    optionText.text = text
    optionText.size = this.optionTextSize
    optionText.textFill.color = ContentIdleGray
    optionText.horizontalAlignment = HorizontalAlignment.Center
    optionText.verticalAlignment = VerticalAlignment.Center
    optionText.horizontalOverflow = HorizontalOverflow.Truncate
    optionText.verticalOverflow = VerticalOverflow.Truncate
    optionText.layoutRect = Rect.create(-0.5, 0.5, -0.5, 0.5)
  }

  private createSelectionBandVisual(): void {
    this.state.selection.bandObject = createChildSceneObjectWithParentLayer(
      SELECTION_BAND_OBJECT_NAME,
      this.sceneObject
    )
    this.managedSceneObjects.add(this.state.selection.bandObject)
    this.state.selection.bandObject.getTransform().setLocalPosition(this.state.selection.bandPosition)

    this.state.selection.bandVisual = this.createSelectionBandRoundedRectangleVisual()
    this.visual = this.state.selection.bandVisual
  }

  private createSelectionBandRoundedRectangleVisual(): RoundedRectangleVisual {
    const visual = new RoundedRectangleVisual({
      sceneObject: this.state.selection.bandObject,
      style: this.selectionBandStyle
    })
    visual.cornerRadius = SELECTION_BAND_CORNER_RADIUS
    return visual
  }

  private createSelectedFieldVisual(): void {
    this.state.selection.selectedObject = createChildSceneObjectWithParentLayer(
      SELECTED_FIELD_VISUAL_OBJECT_NAME,
      this.sceneObject
    )
    this.state.selection.selectedTransform = this.state.selection.selectedObject.getTransform()
    this.managedSceneObjects.add(this.state.selection.selectedObject)
    this.state.selection.selectedObject.enabled = false

    this.state.selection.selectedVisual = new RoundedRectangleVisual({
      sceneObject: this.state.selection.selectedObject,
      style: SELECTED_FIELD_STYLE,
      transparent: true
    })
    this.state.selection.selectedVisual.cornerRadius = SELECTION_BAND_CORNER_RADIUS
    this.state.selection.targetField = null
    this.state.selection.fadeTargetOpacity = 0
    this.setSelectedFieldOpacity(0)
  }

  private updateVisualRenderOrders(): void {
    if (this.state.background.roundedRectangle) {
      this.state.background.roundedRectangle.renderOrder = this._renderOrder
    }

    for (const field of this.state.fields.items) {
      for (const option of field.options) {
        option.text.renderOrder = this._renderOrder
      }
    }

    if (this.state.selection.bandVisual) {
      this.state.selection.bandVisual.renderMeshVisual.renderOrder = this._renderOrder
    }

    if (this.state.selection.selectedVisual) {
      this.state.selection.selectedVisual.renderMeshVisual.renderOrder = this._renderOrder
    }

    if (this.state.container.edgeFadeVisual) {
      this.state.container.edgeFadeVisual.renderOrder = this._renderOrder
    }
  }

  private updateVisualSizes(): void {
    this.updateSelectionBandVisualSize()
    this.updateSelectedFieldVisualSize()

    this.updateContainerVisualSizes()
    this.updateFieldLayoutSizes()
  }

  private updateSelectionBandVisualSize(): void {
    if (!this._visual) {
      return
    }

    this.state.selection.bandSize.x = this.getFieldLayoutWidth()
    this.state.selection.bandSize.y = this.size.y
    this.state.selection.bandSize.z = this.size.z
    this._visual.size = this.state.selection.bandSize
  }

  private updateContainerVisualSizes(): void {
    this.canvasController?.setSize(this.state.container.size)

    if (this.state.background.roundedRectangle) {
      this.state.background.object.enabled = this.state.background.size.x > 0 && this.state.background.size.y > 0
      this.state.background.transform?.setLocalPosition(this.state.container.position)
      this.state.background.visualSize.x = this.state.background.size.x
      this.state.background.visualSize.y = this.state.background.size.y
      this.state.background.roundedRectangle.size = this.state.background.visualSize
    }

    this.state.container.transform?.setLocalPosition(this.state.container.position)

    this.updateEdgeFadeVisual()
  }

  private updateEdgeFadeVisual(): void {
    if (
      !this.state.container.edgeFadeObject ||
      !this.state.container.edgeFadeTransform ||
      !this.state.container.edgeFadeVisual ||
      !this.state.container.edgeFadeMaterial
    ) {
      return
    }

    const container = this.state.container
    const backgroundSize = this.state.background.size
    const fadeSize = backgroundSize.y > 0 ? this.size.y / backgroundSize.y : 0
    container.edgeFadeScale.x = backgroundSize.x
    container.edgeFadeScale.y = backgroundSize.y
    container.edgeFadeScale.z = 1
    container.edgeFadeTransform.setLocalScale(container.edgeFadeScale)
    container.edgeFadeMesh?.setEdgeRatio(fadeSize)
    container.edgeFadeMaterial.mainPass.fadeSize = fadeSize
    container.edgeFadeMaterial.mainPass.windowSize = backgroundSize
    container.edgeFadeMaterial.mainPass.radius = BACKGROUND_CORNER_RADIUS
    container.edgeFadeVisual.enabled = backgroundSize.x > 0 && backgroundSize.y > 0
  }

  private updateFieldLayoutSizes(): void {
    if (!this.state.fields.layout) {
      return
    }

    this.state.fields.layout.width = this.getFieldLayoutWidth()
    this.state.fields.layout.height = this.state.container.size.y
    const fieldWidth = this.getFieldWidth()
    for (const field of this.state.fields.items) {
      this.updateRenderedOptionsForField(field)
      this.updateFieldLayout(field, field.renderedOptionValues.length, fieldWidth)
      this.rebalanceOptionPoolForField(field, true)
    }
    this.state.fields.layout.markDirty()
  }

  private updateRenderedOptionsForField(field: NumberPickerField): void {
    const renderedOptionValues = this.getRenderedOptionValues(field.optionValues, field.wrapAround)
    if (
      field.renderedOptionValues.length === renderedOptionValues.length &&
      field.renderedOptionValues.every((value, index) => value === renderedOptionValues[index])
    ) {
      this.updateOptionPoolSize(field)
      return
    }

    field.renderedOptionValues = renderedOptionValues
    field.poolStartIndex = -1
    this.updateOptionPoolSize(field)
  }

  // ─── Batching ────────────────────────────────────────────────────────

  private createBatchUpdateEvent(): void {
    this.state.batch.updateEvent = this.createEvent("LateUpdateEvent")
    this.state.batch.updateEvent.enabled = false
    this.state.batch.updateEvent.bind(() => this.flushBatchedUpdatesAndUpdateEvent())
  }

  private markGeometryDirty(): void {
    if (!this.initialized) return
    this.state.batch.geometryDirty = true
    this.batchUpdate()
  }

  private markVisualSizeDirty(): void {
    if (!this.initialized) return
    this.state.batch.visualSizeDirty = true
    this.batchUpdate()
  }

  private markFieldLayoutDirty(): void {
    if (!this.initialized) return
    this.state.batch.fieldLayoutDirty = true
    this.batchUpdate()
  }

  private markRenderOrderDirty(): void {
    if (!this.initialized) return
    this.state.batch.renderOrderDirty = true
    this.batchUpdate()
  }

  private markColliderDirty(): void {
    if (!this.initialized) return
    this.state.batch.colliderDirty = true
    this.batchUpdate()
  }

  private markSelectedFieldVisualDirty(): void {
    if (!this.initialized) return
    this.state.batch.selectedFieldVisualDirty = true
    this.batchUpdate()
  }

  private markSelectedValuesDirty(): void {
    if (!this.initialized) return
    this.state.batch.selectedValuesDirty = true
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
      this.state.batch.geometryDirty ||
      this.state.batch.visualSizeDirty ||
      this.state.batch.fieldLayoutDirty ||
      this.state.batch.renderOrderDirty ||
      this.state.batch.colliderDirty ||
      this.state.batch.selectedFieldVisualDirty ||
      this.state.batch.selectedValuesDirty
    )
  }

  private flushBatchedUpdates(): void {
    const canvasBindingDirty = this.state.batch.canvasBindingDirty
    const geometryDirty = this.state.batch.geometryDirty
    const visualSizeDirty = this.state.batch.visualSizeDirty
    const fieldLayoutDirty = this.state.batch.fieldLayoutDirty
    const renderOrderDirty = this.state.batch.renderOrderDirty
    const colliderDirty = this.state.batch.colliderDirty
    const selectedFieldVisualDirty = this.state.batch.selectedFieldVisualDirty
    const selectedValuesDirty = this.state.batch.selectedValuesDirty

    this.state.batch.canvasBindingDirty = false
    this.state.batch.geometryDirty = false
    this.state.batch.visualSizeDirty = false
    this.state.batch.fieldLayoutDirty = false
    this.state.batch.renderOrderDirty = false
    this.state.batch.colliderDirty = false
    this.state.batch.selectedFieldVisualDirty = false
    this.state.batch.selectedValuesDirty = false

    try {
      if (geometryDirty) {
        this.updateContainerGeometry()
      }
      if (visualSizeDirty) {
        this.updateVisualSizes()
      } else if (fieldLayoutDirty) {
        this.updateFieldLayoutSizes()
      }
      if (renderOrderDirty) {
        this.updateVisualRenderOrders()
      }
      if (colliderDirty) {
        this.updateCollider()
      }
      if (selectedFieldVisualDirty) {
        this.updateSelectedFieldVisual()
      }
      if (selectedValuesDirty) {
        this.invokeSelectedValuesChangeIfSettled()
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

  protected setState(stateName: StateName): void {
    super.setState(stateName)
    const shouldBeExpanded = this._alwaysExpanded || this.isExpandedState(stateName)
    if (this.state.selection.isExpanded !== shouldBeExpanded) {
      this.setExpanded(shouldBeExpanded)
    }
  }

  protected onHoverEnterHandler(event: InteractorEvent): void {
    super.onHoverEnterHandler(event)
    if (event.propagationPhase !== "Target") {
      return
    }

    this.state.selection.hoveredInteractor = event.interactor
    this.updateSelectedField()
  }

  protected onHoverExitHandler(event: InteractorEvent): void {
    super.onHoverExitHandler(event)
    if (event.propagationPhase !== "Target") {
      return
    }

    if (this.state.selection.hoveredInteractor === event.interactor) {
      this.state.selection.hoveredInteractor = null
    }

    if (!this._isDragged) {
      this.setSelectedFieldIndex(-1, true)
    }
  }

  protected onInteractableDragStart(dragEvent: DragInteractorEvent): void {
    const interactionPosition = this.getInteractionPosition(dragEvent.interactor)
    this.state.selection.activeField = interactionPosition ? this.getFieldAtLocalX(interactionPosition.x) : null
    if (interactionPosition && this.state.selection.activeField) {
      this._isDragged = true
      this.state.selection.activeField.scroller.beginDrag(interactionPosition.y)
      this.updateDraggedOptionTextColorsForField(this.state.selection.activeField)
    }
    this.updateSelectedField()
  }

  protected onInteractableDragUpdate(dragEvent: DragInteractorEvent): void {
    if (!this._isDragged || !this.state.selection.activeField) {
      return
    }

    const interactionPosition = this.getInteractionPosition(dragEvent.interactor)
    if (interactionPosition) {
      if (this.state.selection.activeField.scroller.updateDrag(interactionPosition.y)) {
        this.rebalanceOptionPoolForField(this.state.selection.activeField)
        this.markSelectedValuesDirty()
      }
    }
  }

  protected onInteractableDragEnd(_dragEvent: DragInteractorEvent): void {
    this.endActiveFieldDrag()
    if (!this.getHoveredField()) {
      this.setSelectedFieldIndex(-1, true)
    } else {
      this.updateSelectedField()
    }
  }

  protected update(): void {
    super.update()
    for (const field of this.state.fields.items) {
      if (field.scroller.update()) {
        this.rebalanceOptionPoolForField(field)
        this.markSelectedValuesDirty()
      }
    }
    if (this.state.selection.isExpanded && this.state.selection.hoveredInteractor) {
      this.updateSelectedField()
    }
  }

  protected updateCollider(): void {
    if (this._colliderFitElement) {
      const dp = this.deltaPosition
      const ds = this.deltaScale
      const dx = dp.x / ds.x
      const dy = dp.y / ds.y
      const dz = dp.z / ds.z
      this._colliderSize.x = this.state.container.size.x + dx
      this._colliderSize.y = this.state.container.size.y + dy
      this._colliderSize.z = this.size.z + dz
      this.colliderShape.size = this._colliderSize
      this.collider.shape = this.colliderShape
      this._colliderPosScratch.x = -dx * 0.5 + this.state.container.position.x
      this._colliderPosScratch.y = -dy * 0.5 + this.state.container.position.y
      this._colliderPosScratch.z = -dz * 0.5 + this.state.container.position.z
      this.colliderTransform.setLocalPosition(this._colliderPosScratch)
    }
  }

  private setExpanded(expanded: boolean): void {
    if (this.state.selection.isExpanded === expanded) {
      return
    }

    this.state.animation.formCancelSet.cancel()

    if (!expanded) {
      this.endActiveFieldDrag()
    }

    const startHeight = this.state.container.size.y
    const startY = this.state.container.position.y
    const startBackgroundHeight = this.state.background.size.y
    const targetHeight = this.getContainerHeight(this.size, expanded)
    const targetY = this.getContainerYOffset(this.size.y, expanded)
    const targetBackgroundHeight = this.getBackgroundHeight(this.size, expanded)

    this.state.selection.isExpanded = expanded
    this.syncInteractableDraggableState()
    if (expanded) {
      this.updateSelectedField()
    } else {
      this.setSelectedFieldIndex(-1, true)
    }

    if (!this.initialized) {
      this.updateContainerGeometry()
      return
    }

    animate({
      duration: FORM_ANIMATION_DURATION,
      easing: expanded ? "ease-out-sine" : "ease-in-sine",
      cancelSet: this.state.animation.formCancelSet,
      update: (t: number) => {
        this.updateContainerGeometry(
          this.size,
          startHeight + (targetHeight - startHeight) * t,
          startY + (targetY - startY) * t,
          startBackgroundHeight + (targetBackgroundHeight - startBackgroundHeight) * t
        )
        this.updateVisualSizes()
      },
      ended: () => {
        this.updateContainerGeometry()
        this.updateVisualSizes()
        this.updateCollider()
      }
    })
  }

  private syncAlwaysExpandedInteractionMode(): void {
    if (this._interactableStateMachine) {
      this._interactableStateMachine.isToggle = this.isToggle
      if (this._interactableStateMachine.toggle) {
        this._interactableStateMachine.toggle = false
      }
    }
  }

  private recreateSelectionBandVisual(): void {
    if (!this.state.selection.bandObject) {
      return
    }

    this.state.selection.bandVisual = this.createSelectionBandRoundedRectangleVisual()
    this.visual = this.state.selection.bandVisual
    this.applyIntermediateFillDepthWritePolicy()
    this.updateSelectionBandVisualSize()
    this.updateVisualRenderOrders()
  }

  private applyIntermediateFillDepthWritePolicy(): void {
    // The background owns picker depth occlusion. These hierarchy-ordered fills
    // stop writing depth only while developer-owned foreground children need it.
    const effectiveDepthWrite = this.requestedIntermediateFillDepthWrite && this.getRootContentChildren().length === 0
    super.depthWrite = effectiveDepthWrite
    if (this.state.selection.selectedVisual) {
      this.state.selection.selectedVisual.depthWrite = effectiveDepthWrite
    }
  }

  private get selectionBandStyle(): Partial<RoundedRectangleVisualParameters> {
    return this._alwaysExpanded ? ALWAYS_EXPANDED_SELECTION_BAND_STYLE : SELECTION_BAND_STYLE
  }

  private endActiveFieldDrag(): void {
    const field = this.state.selection.activeField
    field?.scroller.endDrag()
    this.state.selection.activeField = null
    this._isDragged = false
    if (field) {
      this.resetOptionTextColorsForField(field)
    }
  }

  private get fields(): NumberPickerFieldData[] {
    if (!this._fields) {
      this._fields = []
    }
    return this._fields as unknown as NumberPickerFieldData[]
  }

  private queuePendingSetFieldData(data: NumberPickerFieldData, fieldIndex: number): void {
    if (fieldIndex === -1) {
      this.state.fields.pendingDataOperations.push({type: "append", data: data})
      return
    }

    const pendingFieldData = applyNumberPickerFieldDataOperations(this.fields, this.state.fields.pendingDataOperations)
    if (!isValidNumberPickerFieldIndex(fieldIndex, pendingFieldData.length)) {
      log.w(`setFieldData: fieldIndex ${fieldIndex} is out of range [0, ${pendingFieldData.length - 1}]`)
      return
    }

    this.state.fields.pendingDataOperations.push({type: "replace", fieldIndex: fieldIndex, data: data})
  }

  private queuePendingRemoveFieldData(fieldIndex: number): void {
    const pendingFieldData = applyNumberPickerFieldDataOperations(this.fields, this.state.fields.pendingDataOperations)
    if (!isValidNumberPickerFieldIndex(fieldIndex, pendingFieldData.length)) {
      log.w(`removeFieldData: fieldIndex ${fieldIndex} is out of range [0, ${pendingFieldData.length - 1}]`)
      return
    }

    this.state.fields.pendingDataOperations.push({type: "remove", fieldIndex: fieldIndex})
  }

  private applyPendingFieldDataOperations(): void {
    if (this.state.fields.pendingDataOperations.length === 0) {
      return
    }

    this._fields = applyNumberPickerFieldDataOperations(
      this.fields,
      this.state.fields.pendingDataOperations
    ) as unknown as NumberPickerFieldInput[]
    this.state.fields.pendingDataOperations.length = 0
  }

  private setSelectedFieldIndex(fieldIndex: number, updateVisual: boolean): void {
    if (!isValidNumberPickerFieldIndex(fieldIndex, this.fieldCount) && fieldIndex !== -1) {
      return
    }

    const nextSelectedField = this.fieldCount > 0 ? fieldIndex : -1
    if (nextSelectedField === this.state.selection.selectedField) {
      if (updateVisual) {
        this.markSelectedFieldVisualDirty()
      }
      return
    }

    this.state.selection.selectedField = nextSelectedField
    this.events.selectedFieldChange.invoke(this.state.selection.selectedField)
    if (updateVisual) {
      this.markSelectedFieldVisualDirty()
    }
  }

  private updateSelectedFieldVisual(): void {
    const selection = this.state.selection
    if (!selection.isExpanded) {
      this.hideSelectedFieldVisual()
      return
    }

    const field =
      this._isDragged && selection.activeField
        ? selection.activeField
        : this.state.fields.items[selection.selectedField]
    if (!field) {
      this.hideSelectedFieldVisual()
      return
    }

    selection.position.x = this.getFieldCenterX(field)
    selection.position.y = 0
    selection.position.z = SELECTED_FIELD_VISUAL_Z_OFFSET
    this.showSelectedField(field, selection.position, this._isDragged ? StateName.triggered : StateName.hovered)
  }

  private setFieldOptionIndexInternal(fieldIndex: number, index: number, animate: boolean): boolean {
    const field = this.state.fields.items[fieldIndex]
    if (!field) {
      return false
    }

    if (!Number.isInteger(index)) {
      log.w(`setFieldOptionIndex: index ${index} is not an integer`)
      return false
    }

    if (field.optionValues.length === 0) {
      log.w(`setFieldOptionIndex: field ${fieldIndex} has no options`)
      return false
    }

    if (index < 0 || index >= field.optionValues.length) {
      log.w(`setFieldOptionIndex: index ${index} is out of range [0, ${field.optionValues.length - 1}]`)
      return false
    }

    if (this.state.selection.activeField === field) {
      this.endActiveFieldDrag()
    }

    const didChange = field.scroller.setSelectedIndex(index, animate)
    if (didChange || !animate) {
      this.rebalanceOptionPoolForField(field, true)
    }
    const didCommit = !animate && this.commitLiveFieldSelection(field)
    return didChange || didCommit
  }

  private setFieldOptionValueInternal(fieldIndex: number, value: string, animate: boolean): boolean {
    const field = this.state.fields.items[fieldIndex]
    if (!field) {
      return false
    }

    const optionIndex = field.optionValues.indexOf(value)
    if (optionIndex < 0) {
      log.w(`setFieldOptionValue: value "${value}" was not found in field ${fieldIndex}`)
      return false
    }

    return this.setFieldOptionIndexInternal(fieldIndex, optionIndex, animate)
  }

  private appendRuntimeField(data: NumberPickerFieldData): void {
    if (!this.state.fields.layout) {
      return
    }

    const previousSelectedField = this.state.selection.selectedField
    const field = this.createFieldOptionColumn(
      this.state.fields.items.length,
      data,
      this.getFieldWidth(this.state.fields.items.length + 1)
    )
    this.state.fields.items.push(field)
    this.state.fields.layout.addItems([field.item])
    this.syncFieldLayoutItemOrder()
    this.markRuntimeFieldLayoutDirty()
    this.clampSelectedFieldAfterFieldMutation(previousSelectedField)
  }

  private replaceRuntimeField(fieldIndex: number, data: NumberPickerFieldData): void {
    if (!this.state.fields.layout || !this.state.fields.items[fieldIndex]) {
      return
    }

    const previousSelectedField = this.state.selection.selectedField
    const oldField = this.state.fields.items[fieldIndex]
    this.destroyRuntimeField(oldField)

    const newField = this.createFieldOptionColumn(fieldIndex, data, this.getFieldWidth())
    this.state.fields.items[fieldIndex] = newField
    this.state.fields.layout.addItems([newField.item])
    this.syncFieldLayoutItemOrder()
    this.markRuntimeFieldLayoutDirty()
    this.clampSelectedFieldAfterFieldMutation(previousSelectedField)
  }

  private removeRuntimeField(fieldIndex: number, previousSelectedField: number): void {
    if (!this.state.fields.layout || !this.state.fields.items[fieldIndex]) {
      this.clampSelectedFieldAfterFieldMutation(previousSelectedField)
      return
    }

    const removedField = this.state.fields.items.splice(fieldIndex, 1)[0]
    this.destroyRuntimeField(removedField)
    this.syncFieldLayoutItemOrder()
    this.markRuntimeFieldLayoutDirty()

    let preferredSelectedField = previousSelectedField
    if (previousSelectedField === fieldIndex) {
      preferredSelectedField = Math.min(fieldIndex, this.fieldCount - 1)
    } else if (previousSelectedField > fieldIndex) {
      preferredSelectedField = previousSelectedField - 1
    }
    this.clampSelectedFieldAfterFieldMutation(preferredSelectedField)
  }

  private destroyRuntimeField(field: NumberPickerField): void {
    if (this.state.selection.activeField === field) {
      this.endActiveFieldDrag()
    }
    if (this.state.selection.targetField === field) {
      this.hideSelectedFieldVisual()
    }
    if (this.state.fields.layout) {
      this.state.fields.layout.removeItems([field.item])
    }
    if (field.object && !isNull(field.object)) {
      field.object.destroy()
    }
  }

  private syncFieldLayoutItemOrder(): void {
    if (!this.state.fields.layout || this.state.fields.layout.itemCount !== this.state.fields.items.length) {
      return
    }
    this.state.fields.layout.reorderItems(this.state.fields.items.map((field) => field.item))
  }

  private markRuntimeFieldLayoutDirty(): void {
    this.markGeometryDirty()
    this.markVisualSizeDirty()
    this.markFieldLayoutDirty()
    this.markRenderOrderDirty()
    this.markColliderDirty()
  }

  private clampSelectedFieldAfterFieldMutation(preferredSelectedField: number): void {
    if (preferredSelectedField === -1) {
      this.setSelectedFieldIndex(-1, this.state.selection.isExpanded)
      return
    }

    const nextSelectedField =
      this.state.fields.items.length > 0 ? clamp(preferredSelectedField, 0, this.state.fields.items.length - 1) : -1
    this.setSelectedFieldIndex(nextSelectedField, this.state.selection.isExpanded)
  }

  private invokeSelectedValuesChangeIfSettled(): void {
    if (!this.areSelectedValuesSettled()) {
      this.state.batch.selectedValuesDirty = true
      return
    }

    const nextSelection = this.captureLiveSelection()
    const selectedValues = nextSelection.map((field) => field.optionValue)
    const selectedValuesChanged = !this.areSelectedFieldValuesEqual(
      this.state.batch.selectedValuesSnapshot,
      selectedValues
    )
    for (let i = 0; i < nextSelection.length; i++) {
      this.state.fields.items[i].committedSelection = nextSelection[i]
    }

    if (!selectedValuesChanged) {
      return
    }

    this.state.batch.selectedValuesSnapshot = selectedValues.slice()
    this.events.selectedValuesChange.invoke(this.getSelectedValues())
  }

  private captureLiveSelection(): NumberPickerCommittedFieldSelection[] {
    return this.state.fields.items.map((field) => this.captureLiveFieldSelection(field))
  }

  private captureLiveFieldSelection(field: NumberPickerField): NumberPickerCommittedFieldSelection {
    const optionIndex = field.scroller.selectedIndex
    return {
      optionIndex: optionIndex,
      optionValue: field.optionValues[optionIndex] ?? null
    }
  }

  private commitLiveFieldSelection(field: NumberPickerField): boolean {
    const nextSelection = this.captureLiveFieldSelection(field)
    if (
      field.committedSelection.optionIndex === nextSelection.optionIndex &&
      field.committedSelection.optionValue === nextSelection.optionValue
    ) {
      return false
    }

    field.committedSelection = nextSelection
    return true
  }

  private getCommittedFieldValues(): (string | null)[] {
    return this.state.fields.items.map((field) => field.committedSelection.optionValue)
  }

  private areSelectedValuesSettled(): boolean {
    for (const field of this.state.fields.items) {
      if (!field.scroller.isSettled) {
        return false
      }
    }
    return true
  }

  private areSelectedFieldValuesEqual(a: (string | null)[], b: (string | null)[]): boolean {
    if (a.length !== b.length) {
      return false
    }

    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        return false
      }
    }
    return true
  }

  private updateSelectedField(): void {
    const selection = this.state.selection
    if (!selection.selectedObject || !selection.selectedVisual) {
      return
    }

    const field = this._isDragged && selection.activeField ? selection.activeField : this.getHoveredField()
    if (!field) {
      this.setSelectedFieldIndex(-1, true)
      return
    }

    this.setSelectedFieldIndex(this.state.fields.items.indexOf(field), false)
    this.markSelectedFieldVisualDirty()
  }

  private getHoveredField(): NumberPickerField | null {
    if (!this.state.selection.isExpanded) {
      return null
    }

    if (!this.state.selection.hoveredInteractor) {
      return null
    }

    const interactionPosition = this.getInteractionPosition(this.state.selection.hoveredInteractor)
    if (!interactionPosition || !this.isInteractionInsideContainer(interactionPosition)) {
      return null
    }

    return this.getFieldAtLocalX(interactionPosition.x)
  }

  private isInteractionInsideContainer(interactionPosition: vec3): boolean {
    const leftEdge = this.state.container.size.x * -0.5
    const rightEdge = this.state.container.size.x * 0.5
    const bottomEdge = this.state.container.position.y - this.state.container.size.y * 0.5
    const topEdge = this.state.container.position.y + this.state.container.size.y * 0.5
    return (
      interactionPosition.x >= leftEdge &&
      interactionPosition.x <= rightEdge &&
      interactionPosition.y >= bottomEdge &&
      interactionPosition.y <= topEdge
    )
  }

  private getFieldCenterX(field: NumberPickerField): number {
    const fieldIndex = this.state.fields.items.indexOf(field)
    if (fieldIndex < 0) {
      return 0
    }

    return this.getFieldLayoutWidth() * -0.5 + this.getFieldWidth() * (fieldIndex + 0.5)
  }

  private updateSelectedFieldVisualSize(): void {
    if (!this.state.selection.selectedVisual) {
      return
    }

    const selectedFieldVisualHeight = this.size.y * SELECTED_FIELD_VISUAL_SIZE_RATIO
    const selectedFieldVisualVerticalInset = Math.max(0, (this.size.y - selectedFieldVisualHeight) * 0.5)
    const selectedFieldVisualWidth = Math.min(
      selectedFieldVisualHeight,
      this.getFieldWidth() - selectedFieldVisualVerticalInset * 2
    )
    this.state.selection.size.x = selectedFieldVisualWidth
    this.state.selection.size.y = selectedFieldVisualHeight
    this.state.selection.size.z = this.size.z
    this.state.selection.selectedVisual.size = this.state.selection.size
  }

  private hideSelectedFieldVisual(): void {
    if (!this.state.selection.selectedObject || !this.state.selection.selectedVisual) {
      return
    }

    const wasTargetingField = this.state.selection.targetField !== null
    this.state.selection.targetField = null
    if (wasTargetingField) {
      this.state.animation.selectedFieldMoveCancelSet.cancel()
    }

    this.animateSelectedFieldOpacity(0)
  }

  private showSelectedField(field: NumberPickerField, targetPosition: vec3, stateName: StateName): void {
    const selection = this.state.selection
    if (!selection.selectedObject || !selection.selectedTransform || !selection.selectedVisual) {
      return
    }

    const wasHidden = !selection.selectedObject.enabled || selection.opacity <= SELECTED_FIELD_OPACITY_EPSILON
    const targetChanged =
      selection.targetField !== field || !isEqual<vec3>(selection.moveTargetPosition, targetPosition)

    selection.selectedVisual.setState(stateName)
    selection.selectedObject.enabled = true
    selection.targetField = field

    if (wasHidden) {
      this.snapSelectedFieldToPosition(targetPosition)
    } else if (targetChanged) {
      this.animateSelectedFieldMove(targetPosition)
    }

    this.animateSelectedFieldOpacity(1)
  }

  private snapSelectedFieldToPosition(targetPosition: vec3): void {
    if (!this.state.selection.selectedTransform) {
      return
    }

    this.state.animation.selectedFieldMoveCancelSet.cancel()
    this.state.selection.moveTargetPosition.copyFrom(targetPosition)
    this.state.selection.selectedTransform.setLocalPosition(this.state.selection.moveTargetPosition)
  }

  private animateSelectedFieldMove(targetPosition: vec3): void {
    const selection = this.state.selection
    if (!selection.selectedTransform) {
      return
    }

    this.state.animation.selectedFieldMoveCancelSet.cancel()
    selection.moveStartPosition.copyFrom(selection.selectedTransform.getLocalPosition())
    selection.moveTargetPosition.copyFrom(targetPosition)

    if (isEqual<vec3>(selection.moveStartPosition, selection.moveTargetPosition)) {
      selection.selectedTransform.setLocalPosition(selection.moveTargetPosition)
      return
    }

    animate({
      duration: SELECTED_FIELD_MOVE_ANIMATION_DURATION,
      easing: "ease-out-sine",
      cancelSet: this.state.animation.selectedFieldMoveCancelSet,
      update: (t: number) => {
        if (!selection.selectedTransform) {
          return
        }
        selection.animatedPosition.x =
          selection.moveStartPosition.x + (selection.moveTargetPosition.x - selection.moveStartPosition.x) * t
        selection.animatedPosition.y =
          selection.moveStartPosition.y + (selection.moveTargetPosition.y - selection.moveStartPosition.y) * t
        selection.animatedPosition.z =
          selection.moveStartPosition.z + (selection.moveTargetPosition.z - selection.moveStartPosition.z) * t
        selection.selectedTransform.setLocalPosition(selection.animatedPosition)
      },
      ended: () => {
        if (selection.selectedTransform) {
          selection.selectedTransform.setLocalPosition(selection.moveTargetPosition)
        }
      }
    })
  }

  private animateSelectedFieldOpacity(targetOpacity: number): void {
    const selection = this.state.selection
    if (!selection.selectedObject || !selection.selectedVisual) {
      return
    }

    const clampedTargetOpacity = clamp(targetOpacity, 0, 1)
    const targetUnchanged =
      Math.abs(selection.fadeTargetOpacity - clampedTargetOpacity) <= SELECTED_FIELD_OPACITY_EPSILON
    const opacityAtTarget = Math.abs(selection.opacity - clampedTargetOpacity) <= SELECTED_FIELD_OPACITY_EPSILON
    if (targetUnchanged) {
      if (opacityAtTarget) {
        this.setSelectedFieldOpacity(clampedTargetOpacity)
        this.updateSelectedFieldEnabledForOpacity(clampedTargetOpacity)
      }
      return
    }

    this.state.animation.selectedFieldFadeCancelSet.cancel()
    selection.fadeTargetOpacity = clampedTargetOpacity

    if (opacityAtTarget) {
      this.setSelectedFieldOpacity(clampedTargetOpacity)
      this.updateSelectedFieldEnabledForOpacity(clampedTargetOpacity)
      return
    }

    const startOpacity = selection.opacity
    animate({
      duration: FORM_ANIMATION_DURATION,
      easing: clampedTargetOpacity > startOpacity ? "ease-out-sine" : "ease-in-sine",
      cancelSet: this.state.animation.selectedFieldFadeCancelSet,
      update: (t: number) => {
        this.setSelectedFieldOpacity(startOpacity + (clampedTargetOpacity - startOpacity) * t)
      },
      ended: () => {
        this.setSelectedFieldOpacity(clampedTargetOpacity)
        this.updateSelectedFieldEnabledForOpacity(clampedTargetOpacity)
      }
    })
  }

  private updateSelectedFieldEnabledForOpacity(opacity: number): void {
    if (!this.state.selection.selectedObject) {
      return
    }

    if (opacity <= SELECTED_FIELD_OPACITY_EPSILON && this.state.selection.targetField === null) {
      this.state.selection.selectedObject.enabled = false
    }
  }

  private setSelectedFieldOpacity(opacity: number): void {
    this.state.selection.opacity = clamp(opacity, 0, 1)
    if (this.state.selection.selectedVisual) {
      this.state.selection.selectedVisual.opacity = this.state.selection.opacity
    }
  }

  private updateContainerGeometry(
    size: vec3 = this.size,
    containerHeight = this.getContainerHeight(size, this.state.selection.isExpanded),
    containerYOffset = this.getContainerYOffset(size.y, this.state.selection.isExpanded),
    backgroundHeight = this.getBackgroundHeight(size, this.state.selection.isExpanded),
    backgroundWidth = this.getBackgroundWidth(size, backgroundHeight)
  ): void {
    this.state.container.size.x = size.x
    this.state.container.size.y = containerHeight
    this.state.container.position.y = containerYOffset
    this.state.background.size.x = backgroundWidth
    this.state.background.size.y = backgroundHeight
  }

  private getContainerHeight(size: vec3, expanded: boolean): number {
    return size.y * this.getActiveRowCount(expanded)
  }

  private getBackgroundHeight(size: vec3, expanded: boolean): number {
    return expanded ? this.getContainerHeight(size, true) : 0
  }

  private getBackgroundWidth(size: vec3, backgroundHeight: number): number {
    if (size.y === 0) {
      return 0
    }

    return size.x * clamp(backgroundHeight / size.y, 0, 1)
  }

  private updateFieldLayout(field: NumberPickerField, optionCount: number, fieldWidth = this.getFieldWidth()): void {
    field.item.overrideWidth = fieldWidth
    field.item.overrideHeight = this.state.container.size.y

    const contentHeight = this.getFieldContentHeight(optionCount)
    const visibleRowCount = this.visibleRowCount
    field.contentHeight = contentHeight
    field.contentLayout.width = fieldWidth
    field.contentLayout.height = contentHeight
    for (const option of field.options) {
      option.text.size = this.optionTextSize
    }
    field.scroller.configure({
      rowHeight: this.size.y,
      windowHeight: this.state.container.size.y,
      contentHeight: contentHeight,
      optionCount: optionCount,
      wrapAround: field.wrapAround,
      logicalOptionCount: field.optionValues.length,
      visibleRowCount: visibleRowCount
    })
  }

  private updateOptionPoolSize(field: NumberPickerField): void {
    const targetPoolSize = this.getOptionPoolSize(field.renderedOptionValues.length)
    if (field.options.length === targetPoolSize) {
      return
    }

    if (targetPoolSize < field.options.length) {
      const removedOptions = field.options.splice(targetPoolSize)
      if (removedOptions.length > 0) {
        field.contentLayout.removeItems(removedOptions.map((option) => option.item))
        for (const option of removedOptions) {
          option.object.destroy()
        }
      }
    } else {
      const addedOptions: NumberPickerFieldOption[] = []
      for (let i = field.options.length; i < targetPoolSize; i++) {
        const option = this.createOptionRow(field.contentObject, i)
        field.options.push(option)
        addedOptions.push(option)
      }
      if (addedOptions.length > 0) {
        field.contentLayout.addItems(addedOptions.map((option) => option.item))
      }
    }

    field.poolStartIndex = -1
  }

  private rebalanceOptionPoolForField(field: NumberPickerField, force = false): void {
    const renderedOptionCount = field.renderedOptionValues.length
    const activeCount = Math.min(field.options.length, renderedOptionCount)
    if (renderedOptionCount === 0 || activeCount === 0) {
      if (field.poolStartIndex !== 0 || force) {
        field.poolStartIndex = 0
        field.contentLayout.paddingTop = 0
        field.contentLayout.paddingBottom = 0
        field.contentLayout.forceLayout()
      }
      return
    }

    const maxStartIndex = Math.max(0, renderedOptionCount - activeCount)
    const contentPositionY = field.scroller.contentPositionY
    const contentTopInWindow = field.contentHeight * 0.5 - this.fieldTopPadding + contentPositionY
    const firstVisibleIndex = Math.floor((contentTopInWindow - this.state.container.size.y * 0.5) / this.size.y)
    const poolStartIndex = clamp(firstVisibleIndex - OPTION_POOL_BUFFER_ROWS, 0, maxStartIndex)

    if (!force && poolStartIndex === field.poolStartIndex) {
      this.updateDraggedOptionTextColorsForField(field)
      this.updateOptionTextOpacitiesForField(field, contentPositionY)
      return
    }

    field.poolStartIndex = poolStartIndex
    field.contentLayout.paddingTop = this.fieldTopPadding + poolStartIndex * this.size.y
    field.contentLayout.paddingBottom =
      this.fieldBottomPadding + (renderedOptionCount - poolStartIndex - activeCount) * this.size.y

    for (let i = 0; i < activeCount; i++) {
      field.options[i].text.text = field.renderedOptionValues[poolStartIndex + i]
    }
    field.contentLayout.forceLayout()
    this.updateDraggedOptionTextColorsForField(field)
    this.updateOptionTextOpacitiesForField(field, contentPositionY)
  }

  private updateDraggedOptionTextColorsForField(field: NumberPickerField): void {
    if (!this._isDragged || this.state.selection.activeField !== field) {
      return
    }

    const selectedRenderedIndex = field.scroller.selectedRenderedIndex
    if (
      field.dragSelectedRenderedIndex === selectedRenderedIndex &&
      field.dragSelectedPoolStartIndex === field.poolStartIndex
    ) {
      return
    }

    this.updateOptionTextColorsForField(field, selectedRenderedIndex)
    field.dragSelectedRenderedIndex = selectedRenderedIndex
    field.dragSelectedPoolStartIndex = field.poolStartIndex
  }

  private resetOptionTextColorsForField(field: NumberPickerField): void {
    this.updateOptionTextColorsForField(field, -1)
    field.dragSelectedRenderedIndex = -1
    field.dragSelectedPoolStartIndex = -1
  }

  private updateOptionTextColorsForField(field: NumberPickerField, selectedRenderedIndex: number): void {
    const activeCount = Math.min(field.options.length, field.renderedOptionValues.length)

    for (let i = 0; i < field.options.length; i++) {
      const renderedIndex = field.poolStartIndex + i
      const isSelectedDraggedOption =
        i < activeCount && selectedRenderedIndex >= 0 && renderedIndex === selectedRenderedIndex
      this.applyOptionTextColor(
        field.options[i],
        isSelectedDraggedOption ? NumberPickerDraggedSelectedOptionTextColor : ContentIdleGray
      )
    }
  }

  private updateOptionTextOpacitiesForField(field: NumberPickerField, contentPositionY: number): void {
    const activeCount = Math.min(field.options.length, field.renderedOptionValues.length)
    const rowHeight = Math.max(0, this.size.y)
    const edgeFadeCenterY = this.state.container.position.y + this.state.container.edgeFadePosition.y
    const edgeFadeHalfHeight = Math.max(0, this.state.background.size.y * 0.5)
    const selectionBandCenterY = this.state.selection.bandPosition.y
    const selectionBandHalfHeight = rowHeight * 0.5
    // The visible window is the union of the animated edge-fade plane and the
    // fixed selection band; their bounds diverge during form transitions.
    let coveredBottomY = selectionBandCenterY - selectionBandHalfHeight
    let coveredTopY = selectionBandCenterY + selectionBandHalfHeight
    if (edgeFadeHalfHeight > 0) {
      coveredBottomY = Math.min(coveredBottomY, edgeFadeCenterY - edgeFadeHalfHeight)
      coveredTopY = Math.max(coveredTopY, edgeFadeCenterY + edgeFadeHalfHeight)
    }

    // Finish fading before glyphs cross the finite edge-fade overlay, preventing
    // their outer pixels from reappearing after the overlay has hidden them.
    const fadeOutInset = rowHeight * OPTION_TEXT_FADE_OUT_INSET_RATIO
    const bottomFadeDistance = Math.min(rowHeight, Math.max(0, selectionBandCenterY - coveredBottomY))
    const topFadeDistance = Math.min(rowHeight, Math.max(0, coveredTopY - selectionBandCenterY))
    const bottomFadeRange = bottomFadeDistance - fadeOutInset
    const topFadeRange = topFadeDistance - fadeOutInset
    const firstRowCenterY = contentPositionY + field.contentHeight * 0.5 - this.fieldTopPadding - rowHeight * 0.5
    const selectedRenderedIndex =
      this._isDragged && this.state.selection.activeField === field ? field.scroller.selectedRenderedIndex : -1

    for (let i = 0; i < field.options.length; i++) {
      const renderedIndex = field.poolStartIndex + i
      const rowCenterY = firstRowCenterY - renderedIndex * rowHeight
      const pickerRowCenterY = this.state.container.position.y + rowCenterY
      let edgeOpacity = 0
      if (i < activeCount && bottomFadeRange > 0 && topFadeRange > 0) {
        const bottomOpacity = clamp((pickerRowCenterY - coveredBottomY - fadeOutInset) / bottomFadeRange, 0, 1)
        const topOpacity = clamp((coveredTopY - pickerRowCenterY - fadeOutInset) / topFadeRange, 0, 1)
        edgeOpacity = Math.min(bottomOpacity, topOpacity)
      }
      const option = field.options[i]
      const opacityAtEndpoint = edgeOpacity === 0 || edgeOpacity === 1
      if (!opacityAtEndpoint && Math.abs(option.edgeOpacity - edgeOpacity) < OPTION_TEXT_OPACITY_STEP) {
        continue
      }

      // The edge-fade shader supplies the continuous visual transition. This
      // secondary row opacity only prevents glyphs escaping its finite bounds,
      // so quantize it to bound native Text color writes and visual re-preps.
      edgeOpacity = Math.round(edgeOpacity / OPTION_TEXT_OPACITY_STEP) * OPTION_TEXT_OPACITY_STEP
      if (option.edgeOpacity === edgeOpacity) {
        continue
      }

      option.edgeOpacity = edgeOpacity
      this.applyOptionTextColor(
        option,
        selectedRenderedIndex >= 0 && renderedIndex === selectedRenderedIndex
          ? NumberPickerDraggedSelectedOptionTextColor
          : ContentIdleGray
      )
    }
  }

  private applyOptionTextColor(option: NumberPickerFieldOption, baseColor: vec4): void {
    const alpha = baseColor.a * option.edgeOpacity
    this.optionTextDisplayColor.r = baseColor.r
    this.optionTextDisplayColor.g = baseColor.g
    this.optionTextDisplayColor.b = baseColor.b
    this.optionTextDisplayColor.a = alpha
    option.text.textFill.color = this.optionTextDisplayColor
    const textEnabled = alpha > 0
    if (option.textEnabled !== textEnabled) {
      option.textEnabled = textEnabled
      option.text.enabled = textEnabled
    }
  }

  private getFieldAtLocalX(localX: number): NumberPickerField | null {
    const fieldCount = this.state.fields.items.length
    if (fieldCount === 0) {
      return null
    }

    const fieldLayoutWidth = this.getFieldLayoutWidth()
    const leftEdge = fieldLayoutWidth * -0.5
    const rightEdge = fieldLayoutWidth * 0.5
    if (localX < leftEdge || localX > rightEdge) {
      return null
    }

    const fieldWidth = fieldLayoutWidth / fieldCount
    const fieldIndex = clamp(Math.floor((localX - leftEdge) / fieldWidth), 0, fieldCount - 1)
    return this.state.fields.items[fieldIndex]
  }

  private getFieldWidth(fieldCount = this.state.fields.items.length): number {
    const fieldLayoutWidth = this.getFieldLayoutWidth()
    return fieldCount > 0 ? fieldLayoutWidth / fieldCount : fieldLayoutWidth
  }

  private getFieldLayoutWidth(): number {
    return this.size.x - SELECTION_BAND_HORIZONTAL_PADDING * 2
  }

  private getFieldContentHeight(optionCount: number): number {
    if (optionCount <= 0) {
      return this.state.container.size.y
    }
    return this.size.y * optionCount + this.fieldTopPadding + this.fieldBottomPadding
  }

  private getOptionPoolSize(renderedOptionCount: number): number {
    if (renderedOptionCount <= 0) {
      return 0
    }
    return Math.min(renderedOptionCount, this.visibleRowCount + OPTION_POOL_BUFFER_ROWS * 2)
  }

  private getRenderedOptionValues(optionValues: string[], wrapAround: boolean): string[] {
    if (!wrapAround || optionValues.length <= 1) {
      return optionValues
    }

    const bufferRowCount = this.wrapAroundBufferRowCount
    const renderedOptionCount = optionValues.length + bufferRowCount * 2
    const renderedOptionValues: string[] = []
    for (let i = 0; i < renderedOptionCount; i++) {
      renderedOptionValues.push(optionValues[positiveModulo(i - bufferRowCount, optionValues.length)])
    }
    return renderedOptionValues
  }

  private getContainerYOffset(rowHeight = this.size.y, expanded = this.state.selection.isExpanded): number {
    return this.getActiveRowCount(expanded) % 2 === 0 ? rowHeight * -0.5 : 0
  }

  private get optionTextSize(): number {
    return this.size.y * OPTION_TEXT_SIZE_SCALE
  }

  private get fieldTopPadding(): number {
    return Math.max(0, this.state.container.size.y * 0.5 - this.snapAnchorY - this.size.y * 0.5)
  }

  private get fieldBottomPadding(): number {
    return Math.max(0, this.state.container.size.y * 0.5 + this.snapAnchorY - this.size.y * 0.5)
  }

  private get visibleRowCount(): number {
    return getNumberPickerVisibleRowCount(this.state.container.size.y, this.size.y, this.activeRowCount)
  }

  private get wrapAroundBufferRowCount(): number {
    return this.visibleRowCount + WRAP_AROUND_EXTRA_BUFFER_ROWS
  }

  private get snapAnchorY(): number {
    return -this.state.container.position.y
  }

  private get activeRowCount(): number {
    return this.getActiveRowCount(this.state.selection.isExpanded)
  }

  private getActiveRowCount(expanded: boolean): number {
    return expanded ? this.numberOfRowsShown : 1
  }

  private isExpandedState(stateName: StateName): boolean {
    return (
      stateName === StateName.toggledDefault ||
      stateName === StateName.toggledHovered ||
      stateName === StateName.toggledTriggered
    )
  }
}

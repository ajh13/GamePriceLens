// ═══════════════════════════════════════════════════════════════════════════
// GridItem.ts — Per-item component exposing grid placement properties.
//
// Attach this to each child SceneObject of a GridLayout container.
// Extends LayoutItem2D for shared handler resolution and measure/apply.
// ═══════════════════════════════════════════════════════════════════════════

import {LayoutItem2D} from "../LayoutItem2D"
import {GridAlign, GridItemInput} from "./GridTypes"

/**
 * Per-item grid layout component. Attach to each child SceneObject of a
 * {@link GridLayout} container to control its grid placement (row, column,
 * span, named area) and per-cell alignment overrides.
 */
@component
export class GridItem extends LayoutItem2D {
  // ─── Placement ────────────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Placement</span>')
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Grid cell position, spanning, and named area assignment</span>'
  )
  @input
  @label("Auto Placement")
  @hint("If true, the grid auto-places this item. If false, use gridRow/gridColumn.")
  private _autoPlacement: boolean = true

  @input("int")
  @label("Row")
  @showIf("_autoPlacement", false)
  @hint("0-based row index for explicit placement.")
  private _gridRow: number = 0

  @input("int")
  @label("Column")
  @showIf("_autoPlacement", false)
  @hint("0-based column index for explicit placement.")
  private _gridColumn: number = 0

  @input("int")
  @label("Row Span")
  @showIf("_autoPlacement", false)
  @hint("Number of rows this item spans (>= 1).")
  private _gridRowSpan: number = 1

  @input("int")
  @label("Column Span")
  @showIf("_autoPlacement", false)
  @hint("Number of columns this item spans (>= 1).")
  private _gridColumnSpan: number = 1

  @input
  @label("Grid Area")
  @hint("Named grid area (from templateAreas). Empty = no area assignment.")
  private _gridArea: string = ""

  // ─── Alignment ────────────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Alignment</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Per-item alignment overrides within the grid cell</span>')
  @input
  @label("Justify Self")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Auto (inherit)", "auto"),
      new ComboBoxItem("Start", "start"),
      new ComboBoxItem("Center", "center"),
      new ComboBoxItem("End", "end"),
      new ComboBoxItem("Stretch", "stretch")
    ])
  )
  @hint("Horizontal alignment of this item within its grid cell.")
  private _justifySelf: string = "auto"

  @input
  @label("Align Self")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Auto (inherit)", "auto"),
      new ComboBoxItem("Start", "start"),
      new ComboBoxItem("Center", "center"),
      new ComboBoxItem("End", "end"),
      new ComboBoxItem("Stretch", "stretch")
    ])
  )
  @hint("Vertical alignment of this item within its grid cell.")
  private _alignSelf: string = "auto"

  // ─── Size Override ──────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Size Override</span>')
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Explicit intrinsic size — use for items without a recognized content type (e.g. prefab roots with no renderer). 0 = auto-detect from content.</span>'
  )
  @input
  @label("Override Width")
  @hint("Explicit intrinsic width in cm. 0 = auto-detect from content handler.")
  protected _overrideWidth: number = 0

  @input
  @label("Override Height")
  @hint("Explicit intrinsic height in cm. 0 = auto-detect from content handler.")
  protected _overrideHeight: number = 0

  // Programmatic override flags — see LayoutItem2D.hasOverrideWidth/Height.
  protected _hasOverrideWidth: boolean = false
  protected _hasOverrideHeight: boolean = false

  // Aspect ratio is consumed only by the Flex engine; declared here to satisfy
  // the LayoutItem2D contract. Grid sizes its tracks per-axis and ignores it.
  protected _aspectRatio: number = 0

  // ─── Size Constraints ──────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Size Constraints</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Minimum and maximum size limits for this item</span>')
  @input
  @label("Min Width")
  @hint("Minimum width (0 = no minimum).")
  protected _minWidth: number = 0

  @input
  @label("Max Width")
  @hint("Maximum width (0 = no maximum).")
  protected _maxWidth: number = 0

  @input
  @label("Min Height")
  @hint("Minimum height (0 = no minimum).")
  protected _minHeight: number = 0

  @input
  @label("Max Height")
  @hint("Maximum height (0 = no maximum).")
  protected _maxHeight: number = 0

  // ─── Public Getters / Setters ────────────────────────────────────────

  /** Whether the grid auto-places this item. Set to false to use explicit gridRow/gridColumn. */
  public get autoPlacement(): boolean {
    return this._autoPlacement
  }
  public set autoPlacement(value: boolean) {
    if (this._autoPlacement === value) return
    this._autoPlacement = value
    this._parentLayout?.markDirty()
  }

  /** 0-based row index for explicit placement (clamped >= 0). */
  public get gridRow(): number {
    return this._gridRow
  }
  public set gridRow(value: number) {
    if (this._gridRow === value) return
    this._gridRow = Math.max(0, value)
    this._parentLayout?.markDirty()
  }

  /** 0-based column index for explicit placement (clamped >= 0). */
  public get gridColumn(): number {
    return this._gridColumn
  }
  public set gridColumn(value: number) {
    if (this._gridColumn === value) return
    this._gridColumn = Math.max(0, value)
    this._parentLayout?.markDirty()
  }

  /** Number of rows this item spans (clamped >= 1). */
  public get gridRowSpan(): number {
    return this._gridRowSpan
  }
  public set gridRowSpan(value: number) {
    if (this._gridRowSpan === value) return
    this._gridRowSpan = Math.max(1, value)
    this._parentLayout?.markDirty()
  }

  /** Number of columns this item spans (clamped >= 1). */
  public get gridColumnSpan(): number {
    return this._gridColumnSpan
  }
  public set gridColumnSpan(value: number) {
    if (this._gridColumnSpan === value) return
    this._gridColumnSpan = Math.max(1, value)
    this._parentLayout?.markDirty()
  }

  /** Named grid area (from templateAreas). Empty string means no area assignment. */
  public get gridArea(): string {
    return this._gridArea
  }
  public set gridArea(value: string) {
    if (this._gridArea === value) return
    this._gridArea = value
    this._parentLayout?.markDirty()
  }

  /** Horizontal alignment of this item within its grid cell. `Auto` inherits from the container. */
  public get justifySelf(): GridAlign {
    return this._justifySelf as GridAlign
  }
  public set justifySelf(value: GridAlign) {
    if (this._justifySelf === value) return
    this._justifySelf = value
    this._parentLayout?.markDirty()
  }

  /** Vertical alignment of this item within its grid cell. `Auto` inherits from the container. */
  public get alignSelf(): GridAlign {
    return this._alignSelf as GridAlign
  }
  public set alignSelf(value: GridAlign) {
    if (this._alignSelf === value) return
    this._alignSelf = value
    this._parentLayout?.markDirty()
  }

  // ─── Methods Called by GridLayout ────────────────────────────────────

  /**
   * Builds a {@link GridItemInput} snapshot for the pure layout engine.
   * Measures intrinsic size via the resolved handler and combines it with
   * all placement, alignment, and size constraint properties.
   * @param index - The item's index within the parent GridLayout's item list.
   */
  public toInput(index: number, intrinsicMode: "preferred" | "min" | "max" = "preferred"): GridItemInput {
    const out = {} as GridItemInput
    this.fillInput(out, index, intrinsicMode)
    return out
  }

  /**
   * Writes all layout-relevant properties into an existing {@link GridItemInput}
   * object, avoiding allocation. Used by the orchestrator's pre-allocated
   * input buffer for zero-allocation layout passes.
   *
   * `intrinsicMode` (defaults to `"preferred"`) selects which axis of the
   * three-value measurement becomes the engine's `intrinsicWidth/Height`.
   * Used by `GridLayout.computeContentSize({mode})` for nested-layout
   * shrink-fit / grow-fit reporting.
   *
   * @param out - The object to write into.
   * @param index - The item's index within the parent GridLayout's item list.
   */
  public fillInput(out: GridItemInput, index: number, intrinsicMode: "preferred" | "min" | "max" = "preferred"): void {
    this.resetFitContentPending()
    const intrinsic = this.measureIntrinsic()
    const chosen =
      intrinsicMode === "min" ? intrinsic.min : intrinsicMode === "max" ? intrinsic.max : intrinsic.preferred
    out.index = index
    out.intrinsicWidth = chosen.width
    out.intrinsicHeight = chosen.height
    out.contentMinWidth = intrinsic.min.width
    out.contentMinHeight = intrinsic.min.height
    out.contentMaxWidth = intrinsic.max.width
    out.contentMaxHeight = intrinsic.max.height
    out.minWidth = this._minWidth
    out.maxWidth = this._maxWidth
    out.minHeight = this._minHeight
    out.maxHeight = this._maxHeight
    out.autoPlacement = this._autoPlacement
    out.gridRow = this._gridRow
    out.gridColumn = this._gridColumn
    out.rowSpan = this._gridRowSpan
    out.columnSpan = this._gridColumnSpan
    out.gridArea = this._gridArea
    out.justifySelf = this._justifySelf as GridAlign
    out.alignSelf = this._alignSelf as GridAlign
    // Only the preferred probe lays the item out at a real width; the min/max
    // probes would measure text at longest-word / natural width for nothing.
    out.heightForWidth = intrinsicMode === "preferred" ? this.heightForWidthProvider() : undefined
  }
}

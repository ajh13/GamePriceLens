// ═══════════════════════════════════════════════════════════════════════════
// FlexItem.ts — Per-item component exposing flex properties to the inspector.
//
// Attach this to each child SceneObject of a FlexLayout container.
// Extends LayoutItem2D for shared handler resolution and measure/apply.
// ═══════════════════════════════════════════════════════════════════════════

import type {ContentMeasurement} from "../ItemHandlerRegistry"
import {LayoutItem2D} from "../LayoutItem2D"
import {
  FLEX_BASIS_AUTO,
  FLEX_BASIS_MAX_CONTENT,
  FLEX_BASIS_MIN_CONTENT,
  FlexAlignSelf,
  FlexBasis,
  FlexItemInput
} from "./FlexTypes"

/**
 * Normalizes a public-facing {@link FlexBasis} value (CSS-style number or
 * intrinsic keyword) into the engine sentinel range.
 *
 * Accepts:
 * - a number `>= 0` — passed through as an explicit cm value
 * - `"auto"` → {@link FLEX_BASIS_AUTO}
 * - `"min-content"` → {@link FLEX_BASIS_MIN_CONTENT}
 * - `"max-content"` → {@link FLEX_BASIS_MAX_CONTENT}
 * - legacy `-1` → `"auto"` (with a deprecation warning)
 */
function normalizeFlexBasis(value: FlexBasis): number {
  if (typeof value === "number") {
    if (value === -1) {
      print('[FlexItem] flexBasis = -1 is deprecated; use "auto" instead.')
      return FLEX_BASIS_AUTO
    }
    return value
  }
  if (value === "auto") return FLEX_BASIS_AUTO
  if (value === "min-content") return FLEX_BASIS_MIN_CONTENT
  if (value === "max-content") return FLEX_BASIS_MAX_CONTENT
  return FLEX_BASIS_AUTO
}

/**
 * Per-item flex layout component. Attach to each child SceneObject of a
 * {@link FlexLayout} container to control its flex behavior (grow, shrink,
 * basis, order, alignment, and margins).
 */
@component
export class FlexItem extends LayoutItem2D {
  // ─── Inspector Inputs ────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Flex Properties</span>')
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Controls how this item grows, shrinks, and aligns within the flex container</span>'
  )
  @input("int")
  @label("Order")
  @hint("Visual reordering without changing hierarchy. Lower values appear first.")
  private _order: number = 0

  @input
  @label("Flex Grow")
  @hint("How much this item grows to fill available space (0 = don't grow).")
  private _flexGrow: number = 0

  @input
  @label("Flex Shrink")
  @hint("How much this item shrinks when space is insufficient (0 = don't shrink).")
  private _flexShrink: number = 1

  @input
  @label("Flex Basis")
  @hint("Initial main-axis size before grow/shrink. -1 = use intrinsic size.")
  private _flexBasis: number = -1

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
  @hint("Override the container's cross-axis alignment for this item.")
  private _alignSelf: string = "auto"

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Margin</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Outer spacing around this item</span>')
  @input
  @label("Top")
  @hint("Top margin in cm (>= 0).")
  private _marginTop: number = 0

  @input
  @label("Right")
  @hint("Right margin in cm (>= 0).")
  private _marginRight: number = 0

  @input
  @label("Bottom")
  @hint("Bottom margin in cm (>= 0).")
  private _marginBottom: number = 0

  @input
  @label("Left")
  @hint("Left margin in cm (>= 0).")
  private _marginLeft: number = 0

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

  // Programmatic override flags — set by the `overrideWidth`/`overrideHeight`
  // setters so callers can distinguish "explicit 0" from "unset". Inspector
  // users follow the legacy `> 0` fallback baked into `hasOverrideWidth/Height`.
  protected _hasOverrideWidth: boolean = false
  protected _hasOverrideHeight: boolean = false

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

  // ─── Aspect Ratio ───────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Aspect Ratio</span>')
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Width ÷ height. When active and the main axis is auto (flex-basis auto, no grow/shrink), the item derives its main size from its resolved cross size to hold this ratio. 0 = inherit content (e.g. an Image\'s texture aspect), -1 = disabled, &gt;0 = explicit.</span>'
  )
  @input
  @label("Aspect Ratio")
  @hint("Width / height. 0 = inherit content (e.g. Image texture), -1 = disabled, >0 = explicit ratio.")
  protected _aspectRatio: number = 0

  // ─── Public Getters / Setters ────────────────────────────────────────

  /** Visual ordering index. Lower values appear first in the layout. */
  public get order(): number {
    return this._order
  }
  public set order(value: number) {
    if (this._order === value) return
    this._order = value
    this._parentLayout?.markDirty()
  }

  /** Flex grow factor. Controls how much this item grows to fill available space (0 = don't grow). */
  public get flexGrow(): number {
    return this._flexGrow
  }
  public set flexGrow(value: number) {
    if (this._flexGrow === value) return
    this._flexGrow = Math.max(0, value)
    this._parentLayout?.markDirty()
  }

  /** Flex shrink factor. Controls how much this item shrinks when space is insufficient (0 = don't shrink). */
  public get flexShrink(): number {
    return this._flexShrink
  }
  public set flexShrink(value: number) {
    if (this._flexShrink === value) return
    this._flexShrink = Math.max(0, value)
    this._parentLayout?.markDirty()
  }

  /**
   * Initial main-axis size before grow/shrink, mirroring CSS `flex-basis`.
   *
   * Accepts a number (cm), `"auto"` (use intrinsic preferred size),
   * `"min-content"`, or `"max-content"`. Internally normalized to an
   * engine sentinel (-1 / -2 / -3).
   */
  public get flexBasis(): FlexBasis {
    if (this._flexBasis === FLEX_BASIS_AUTO) return "auto"
    if (this._flexBasis === FLEX_BASIS_MIN_CONTENT) return "min-content"
    if (this._flexBasis === FLEX_BASIS_MAX_CONTENT) return "max-content"
    return this._flexBasis
  }
  public set flexBasis(value: FlexBasis) {
    const normalized = normalizeFlexBasis(value)
    if (this._flexBasis === normalized) return
    this._flexBasis = normalized
    this._parentLayout?.markDirty()
  }

  /** Per-item cross-axis alignment override. `Auto` inherits from the container's `alignItems`. */
  public get alignSelf(): FlexAlignSelf {
    return this._alignSelf as FlexAlignSelf
  }
  public set alignSelf(value: FlexAlignSelf) {
    if (this._alignSelf === value) return
    this._alignSelf = value
    this._parentLayout?.markDirty()
  }

  /** Top margin in cm (clamped >= 0). */
  public get marginTop(): number {
    return this._marginTop
  }
  public set marginTop(value: number) {
    const clamped = Math.max(0, value)
    if (this._marginTop === clamped) return
    this._marginTop = clamped
    this._parentLayout?.markDirty()
  }

  /** Right margin in cm (clamped >= 0). */
  public get marginRight(): number {
    return this._marginRight
  }
  public set marginRight(value: number) {
    const clamped = Math.max(0, value)
    if (this._marginRight === clamped) return
    this._marginRight = clamped
    this._parentLayout?.markDirty()
  }

  /** Bottom margin in cm (clamped >= 0). */
  public get marginBottom(): number {
    return this._marginBottom
  }
  public set marginBottom(value: number) {
    const clamped = Math.max(0, value)
    if (this._marginBottom === clamped) return
    this._marginBottom = clamped
    this._parentLayout?.markDirty()
  }

  /** Left margin in cm (clamped >= 0). */
  public get marginLeft(): number {
    return this._marginLeft
  }
  public set marginLeft(value: number) {
    const clamped = Math.max(0, value)
    if (this._marginLeft === clamped) return
    this._marginLeft = clamped
    this._parentLayout?.markDirty()
  }

  /** Sets all four margins to the same value (in cm, clamped >= 0). */
  public set margin(value: number) {
    const clamped = Math.max(0, value)
    this._marginTop = clamped
    this._marginRight = clamped
    this._marginBottom = clamped
    this._marginLeft = clamped
    this._parentLayout?.markDirty()
  }

  // ─── Public Methods ─────────────────────────────────────────────────

  /**
   * CSS `flex` shorthand.
   * - setFlex(1)       → grow:1, shrink:1, basis:0    (fill space equally)
   * - setFlex(0)       → grow:0, shrink:1, basis:-1   (natural size, can shrink)
   * - setFlex(1, 0)    → grow:1, shrink:0, basis:0    (grow, never shrink)
   * - setFlex(0, 0)    → grow:0, shrink:0, basis:-1   (rigid)
   * - setFlex(1, 1, 5) → explicit grow/shrink/basis
   */
  public setFlex(grow: number, shrink?: number, basis?: number): void {
    this._flexGrow = Math.max(0, grow)
    this._flexShrink = Math.max(0, shrink ?? 1)
    this._flexBasis = basis ?? (grow > 0 ? 0 : -1)
    this._parentLayout?.markDirty()
  }

  // ─── Methods Called by FlexLayout ────────────────────────────────────

  /**
   * Builds a {@link FlexItemInput} snapshot for the pure layout engine.
   * Measures intrinsic size via the resolved handler and combines it with
   * all flex properties, margins, and size constraints.
   *
   * `intrinsicMode` selects which axis of the three-value measurement
   * becomes the FlexItemInput's `intrinsicWidth/Height` — `"preferred"`
   * (default) for normal layout, `"min"` for shrink-fit content measure,
   * `"max"` for grow-fit content measure. Used by
   * `FlexLayout.computeContentSize({mode})` so nested layouts can report
   * their true min/max-content to a parent layout's intrinsic-sizing pass.
   */
  public toInput(
    intrinsicMode: "preferred" | "min" | "max" = "preferred",
    measurement?: ContentMeasurement
  ): FlexItemInput {
    const out = {} as FlexItemInput
    this.fillInput(out, intrinsicMode, measurement)
    return out
  }

  /**
   * Writes all layout-relevant properties into an existing {@link FlexItemInput}
   * object, avoiding allocation. Used by the orchestrator's pre-allocated
   * input buffer for zero-allocation layout passes.
   */
  public fillInput(
    out: FlexItemInput,
    intrinsicMode: "preferred" | "min" | "max" = "preferred",
    measurement?: ContentMeasurement
  ): void {
    this.resetFitContentPending()
    const intrinsic = measurement ?? this.measureIntrinsic()
    const chosen =
      intrinsicMode === "min" ? intrinsic.min : intrinsicMode === "max" ? intrinsic.max : intrinsic.preferred
    out.intrinsicWidth = chosen.width
    out.intrinsicHeight = chosen.height
    out.contentMinWidth = intrinsic.min.width
    out.contentMinHeight = intrinsic.min.height
    out.contentMaxWidth = intrinsic.max.width
    out.contentMaxHeight = intrinsic.max.height
    out.flexGrow = this._flexGrow
    out.flexShrink = this._flexShrink
    out.flexBasis = this._flexBasis
    out.order = this._order
    out.alignSelf = this._alignSelf as FlexAlignSelf
    out.minWidth = this._minWidth
    out.maxWidth = this._maxWidth
    out.minHeight = this._minHeight
    out.maxHeight = this._maxHeight
    out.marginTop = this._marginTop
    out.marginRight = this._marginRight
    out.marginBottom = this._marginBottom
    out.marginLeft = this._marginLeft
    out.aspectRatio = intrinsic.aspectRatio
    // Only the preferred probe lays the item out at a real width; the min/max
    // probes would measure text at longest-word / natural width for nothing.
    out.heightForWidth = intrinsicMode === "preferred" ? this.heightForWidthProvider() : undefined
  }
}

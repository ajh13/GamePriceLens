import {clampSizeWithConstraints, getAxisInfo, getAxisSize} from "../Types/ToolbarLayoutTypes"
import {
  isNumericAxisSize,
  isPerAxisSize,
  isVec2Size,
  ToolbarAlignment,
  ToolbarAttachmentPosition,
  ToolbarDirection,
  ToolbarItemSize,
  ToolbarItemSizeMode
} from "../Types/ToolbarSchema"

/**
 * Pure config-to-flex mapping for the Toolbar. No Lens Studio component
 * dependencies so the layout semantics stay unit-testable headlessly.
 */

export interface ToolbarCellInput {
  sizeConfig?: ToolbarItemSize
  sizeMode: ToolbarItemSizeMode
  intrinsicSize: vec2
  minSize?: vec2
  maxSize?: vec2
}

export interface ToolbarCellSize {
  preferredSize: vec2
  wantsFillPrimary: boolean
  /** Numeric maxSize on the primary axis when the item wants FILL, else null. */
  fillPrimaryMax: number | null
  /**
   * Numeric minSize on the primary axis, or 0 when the item declares none.
   * Clamping preferredSize is not enough: without this floor reaching the flex
   * item, weighted shrink pulls the item back below its declared minimum.
   * Pass the cells through {@link fitCellMinsToContentSpace} before handing
   * these to flex -- a floor wider than the row overflows instead of shrinking.
   */
  minPrimary?: number
}

export interface ToolbarItemSizeResolutionInput {
  sizeConfig?: ToolbarItemSize
  sizeMode: ToolbarItemSizeMode
  intrinsicSize: vec2
  fillSize: vec2
  direction: ToolbarDirection
  defaultCrossAxisSize: number
  minSize?: vec2
  maxSize?: vec2
}

export interface ToolbarItemSizeResolution {
  size: vec2
  wantsFillPrimary: boolean
  wantsFillCross: boolean
}

export function resolveToolbarItemSize(input: ToolbarItemSizeResolutionInput): ToolbarItemSizeResolution {
  const axisInfo = getAxisInfo(input.direction)
  let sizeConfig = input.sizeConfig

  if (!sizeConfig) {
    if (input.sizeMode === ToolbarItemSizeMode.MANUAL) {
      sizeConfig = input.intrinsicSize
    } else {
      sizeConfig = axisInfo.isHorizontal
        ? {x: ToolbarItemSizeMode.FILL, y: input.defaultCrossAxisSize}
        : {x: input.defaultCrossAxisSize, y: ToolbarItemSizeMode.FILL}
    }
  }

  let width = 0
  let height = 0
  let wantsFillPrimary = false
  let wantsFillCross = false

  if (isVec2Size(sizeConfig)) {
    width = sizeConfig.x
    height = sizeConfig.y
  } else if (isPerAxisSize(sizeConfig)) {
    if (isNumericAxisSize(sizeConfig.x)) {
      width = sizeConfig.x
    } else {
      width = input.fillSize.x
      if (axisInfo.primary === "x") wantsFillPrimary = true
      else wantsFillCross = true
    }

    if (isNumericAxisSize(sizeConfig.y)) {
      height = sizeConfig.y
    } else {
      height = input.fillSize.y
      if (axisInfo.primary === "y") wantsFillPrimary = true
      else wantsFillCross = true
    }
  }

  if (!wantsFillCross && axisInfo.cross === "x" && width === 0) {
    width = input.defaultCrossAxisSize
  }
  if (!wantsFillCross && axisInfo.cross === "y" && height === 0) {
    height = input.defaultCrossAxisSize
  }

  return {
    size: clampSizeWithConstraints(new vec2(width, height), input.minSize, input.maxSize),
    wantsFillPrimary,
    wantsFillCross
  }
}

/**
 * Computes an item's layout cell: its preferred size (clamped by the item's
 * min/max and the available content space) and whether it fills the primary axis.
 */
export function computeItemCellSize(
  input: ToolbarCellInput,
  direction: ToolbarDirection,
  defaultCrossAxisSize: number,
  availableSpace: vec2
): ToolbarCellSize {
  const axisInfo = getAxisInfo(direction)
  const resolved = resolveToolbarItemSize({
    ...input,
    fillSize: vec2.zero(),
    direction,
    defaultCrossAxisSize
  })
  let preferredSize = resolved.size
  preferredSize = clampSizeWithConstraints(preferredSize, undefined, availableSpace)

  let fillPrimaryMax: number | null = null
  if (resolved.wantsFillPrimary && input.maxSize) {
    const primaryMax = getAxisSize(input.maxSize, axisInfo.primary)
    fillPrimaryMax = primaryMax > 0 ? primaryMax : null
  }

  const minPrimary = input.minSize ? Math.max(0, getAxisSize(input.minSize, axisInfo.primary)) : 0

  return {preferredSize, wantsFillPrimary: resolved.wantsFillPrimary, fillPrimaryMax, minPrimary}
}

/**
 * Scales declared primary-axis minimums down so their total plus the gaps
 * between them fits the content space. A user min is a hard floor in the flex
 * engine, so mins that together exceed the row would push items outside the
 * toolbar instead of shrinking; scaling preserves their relative weights and
 * keeps the always-fits guarantee.
 *
 * Exact for the single-row flex path. Under the grid arrangement each group is
 * laid out in its own column, so a per-row budget is only an upper bound there
 * and a group whose share is narrower than its mins can still overflow.
 */
export function fitCellMinsToContentSpace(
  cells: ToolbarCellSize[],
  availablePrimary: number,
  gapTotal: number
): ToolbarCellSize[] {
  const budget = availablePrimary - gapTotal
  const total = cells.reduce((sum, cell) => sum + (cell.minPrimary ?? 0), 0)
  if (total <= 0) {
    return cells
  }
  if (budget <= 0) {
    return cells.map((cell) => ({...cell, minPrimary: 0}))
  }
  if (total <= budget) {
    return cells
  }

  const scale = budget / total
  return cells.map((cell) => ({...cell, minPrimary: (cell.minPrimary ?? 0) * scale}))
}

export type ToolbarJustify = "start" | "center" | "end"

export interface ToolbarArrangement {
  /** True when a center group coexists with a side group and the grid can seat them; a crushed fit falls back to the flex row. */
  useGrid: boolean
  justify: ToolbarJustify
  /** A grow spacer between the left and right groups keeps the right group flush right. */
  needsSpacer: boolean
}

/**
 * Context for the center-grid feasibility check. Omit to keep the legacy
 * decision (grid whenever a center group coexists with a side group); pass it
 * to fall back to flex when equal side tracks would crush a side group.
 * marginByIndex carries each item's non-shrinkable attachment margin (primary
 * axis) so the check counts space the nested flex cannot reclaim.
 */
export interface ToolbarGridFit {
  leftIndices: number[]
  centerIndices: number[]
  rightIndices: number[]
  trackBudget: number
  spacing: number
  isHorizontal: boolean
  marginByIndex?: number[]
}

/**
 * Decides the container shape from the alignment groups. The spacer is needed
 * only when no FILL item will absorb the free space -- or when every FILL item
 * is capped by a numeric primary maxSize, which would otherwise strand the
 * leftover space mid-row and pull the right group off the right edge. A center
 * group routes to the grid only when {@link centerGridFitsSideGroups} confirms
 * the equal side tracks can seat the side content; otherwise it falls back to
 * the always-fits flex row so an over-stuffed side group stays legible.
 */
export function planArrangement(
  groupCounts: {left: number; center: number; right: number},
  cells: ToolbarCellSize[],
  gridFit?: ToolbarGridFit
): ToolbarArrangement {
  const wantsGrid = groupCounts.center > 0 && (groupCounts.left > 0 || groupCounts.right > 0)
  const gridFits =
    gridFit === undefined ||
    centerGridFitsSideGroups(
      cells,
      gridFit.leftIndices,
      gridFit.centerIndices,
      gridFit.rightIndices,
      gridFit.trackBudget,
      gridFit.isHorizontal,
      gridFit.spacing,
      gridFit.marginByIndex
    )
  const useGrid = wantsGrid && gridFits
  const fills = cells.filter((cell) => cell.wantsFillPrimary)
  const hasUncappedFill = fills.some((cell) => cell.fillPrimaryMax === null)
  const centerOnly = groupCounts.center > 0 && groupCounts.left === 0 && groupCounts.right === 0

  const needsSpacer = !useGrid && groupCounts.right > 0 && groupCounts.left > 0 && !hasUncappedFill

  let justify: ToolbarJustify = "start"
  if (centerOnly) {
    justify = "center"
  } else if (groupCounts.right > 0 && groupCounts.left === 0 && groupCounts.center === 0 && !hasUncappedFill) {
    justify = "end"
  }

  return {useGrid, justify, needsSpacer}
}

/** Resolves an item's alignment group, defaulting to LEFT like the legacy layout. */
export function resolveAlignment(alignment: ToolbarAlignment | undefined): ToolbarAlignment {
  return alignment ?? ToolbarAlignment.LEFT
}

/**
 * Summed primary-axis preferred sizes of the given cells plus the gaps between
 * them (cm), including each item's non-shrinkable attachment margin when
 * marginByIndex is supplied. Zero for an empty group.
 */
export function groupExtent(
  cells: ToolbarCellSize[],
  indices: number[],
  isHorizontal: boolean,
  spacing: number,
  marginByIndex?: number[]
): number {
  if (indices.length === 0) return 0
  let total = 0
  for (const index of indices) {
    const size = cells[index]?.preferredSize
    if (size) total += isHorizontal ? size.x : size.y
    if (marginByIndex) total += marginByIndex[index] ?? 0
  }
  return total + spacing * (indices.length - 1)
}

/**
 * Equal side-track reserve for the center-grid path: the larger of the two side
 * groups' content extents (summed primary-axis preferred sizes plus the gaps
 * between them), capped so the two equal side tracks plus the center still fit
 * the track budget. Flooring both side tracks at this via minmax(reserve, 1fr)
 * keeps the center group on the true midline (equal tracks) while neither side
 * is starved by a plain equal-share 1fr split; the cap lets a genuinely narrow
 * bar shrink the sides to fit instead of overflowing.
 */
export function computeCenterGridSideReserve(
  cells: ToolbarCellSize[],
  leftIndices: number[],
  centerIndices: number[],
  rightIndices: number[],
  trackBudget: number,
  isHorizontal: boolean,
  spacing: number,
  marginByIndex?: number[]
): number {
  const contentReserve = Math.max(
    groupExtent(cells, leftIndices, isHorizontal, spacing, marginByIndex),
    groupExtent(cells, rightIndices, isHorizontal, spacing, marginByIndex)
  )
  const cap = Math.max(0, (trackBudget - groupExtent(cells, centerIndices, isHorizontal, spacing, marginByIndex)) / 2)
  return Math.min(contentReserve, cap)
}

/**
 * Whether the center-grid can seat the center and both side groups without
 * crushing. The center track (auto) must fit the budget on its own, and the
 * equal side tracks give each side (trackBudget - centerExtent) / 2; when either
 * the center overflows the budget or the heavier side's content (with its
 * attachment margins) exceeds its equal share, the Toolbar falls back to the
 * always-fits flex row instead of crushing content to honour centering.
 */
export function centerGridFitsSideGroups(
  cells: ToolbarCellSize[],
  leftIndices: number[],
  centerIndices: number[],
  rightIndices: number[],
  trackBudget: number,
  isHorizontal: boolean,
  spacing: number,
  marginByIndex?: number[]
): boolean {
  const centerExtent = groupExtent(cells, centerIndices, isHorizontal, spacing, marginByIndex)
  if (centerExtent > trackBudget + 1e-4) return false
  const contentReserve = Math.max(
    groupExtent(cells, leftIndices, isHorizontal, spacing, marginByIndex),
    groupExtent(cells, rightIndices, isHorizontal, spacing, marginByIndex)
  )
  const cap = Math.max(0, (trackBudget - centerExtent) / 2)
  return contentReserve <= cap + 1e-4
}

/** Small outward gap (cm) between an attached item and its target's edge. */
export const ATTACHMENT_PADDING = 0.3

/** Per-side flow-space reservation (cm) contributed by attached items. */
export interface ToolbarMargins {
  left: number
  right: number
  top: number
  bottom: number
}

/** One attached item's demand for flow space beside its target. */
export interface AttachmentReservationInput {
  /** The attachTo target's id. */
  targetId: string
  /** Physical edge the attachment occupies, from {@link attachmentReservationSide}. */
  side: "left" | "right" | "top" | "bottom"
  /** The attachment's preferred extent along the toolbar's primary axis (cm). */
  primarySize: number
}

/**
 * The physical margin edge a primary-axis attachment reserves flow space on, or
 * null when it is a pure overlay. A horizontal toolbar reserves for LEFT/RIGHT
 * attachments (its primary axis); a vertical toolbar for TOP/BOTTOM. Cross-axis
 * attachments (e.g. TOP on a horizontal bar) and CENTER never collide with flow
 * siblings, so they stay overlays and reserve nothing.
 */
export function attachmentReservationSide(
  position: ToolbarAttachmentPosition,
  isHorizontal: boolean
): "left" | "right" | "top" | "bottom" | null {
  if (isHorizontal) {
    if (position === ToolbarAttachmentPosition.RIGHT) return "right"
    if (position === ToolbarAttachmentPosition.LEFT) return "left"
    return null
  }
  if (position === ToolbarAttachmentPosition.TOP) return "top"
  if (position === ToolbarAttachmentPosition.BOTTOM) return "bottom"
  return null
}

/**
 * Per-target flow-space reservation for primary-axis attached items. A LEFT/
 * RIGHT (horizontal) or TOP/BOTTOM (vertical) attachment is drawn flush past its
 * target's edge by {@link ATTACHMENT_PADDING}; reserving that footprint as a
 * target margin keeps the next flow sibling from packing into the same space --
 * which is what makes an attached side button overlap its neighbour. Multiple
 * attachments on the same side accumulate. Overlay attachments contribute
 * nothing (they are filtered out by {@link attachmentReservationSide}).
 */
export function computeAttachmentReservations(attachments: AttachmentReservationInput[]): Map<string, ToolbarMargins> {
  const reservations = new Map<string, ToolbarMargins>()
  for (const attachment of attachments) {
    const margins = reservations.get(attachment.targetId) ?? {left: 0, right: 0, top: 0, bottom: 0}
    margins[attachment.side] += attachment.primarySize + ATTACHMENT_PADDING
    reservations.set(attachment.targetId, margins)
  }
  return reservations
}

/** One attached item's reservation demand before its per-target aggregation. */
export interface AttachmentReservationItem {
  /** The attachTo target's id. */
  targetId: string
  /** Where the item attaches; overlay/cross-axis positions reserve nothing. */
  position: ToolbarAttachmentPosition
}

/**
 * Builds one attached item's flow-space reservation, or null when it reserves
 * nothing (a cross-axis or CENTER overlay, per {@link attachmentReservationSide}).
 * The reserved primary extent is the primary-axis component of `attachedSize` --
 * the single per-rebuild size {@link resolveNormalizedAttachedItemSize} produced
 * and the Toolbar stored -- so reservation and the {@link
 * ToolbarAttachedItemPositioner} render/apply from the exact same vec2. This is a
 * pure projection: it does not re-resolve size, so equality with the rendered
 * size holds by construction, even if the target later shrinks. Pure so the
 * shared contract is unit-testable headlessly.
 */
export function computeAttachmentReservationInput(
  item: AttachmentReservationItem,
  attachedSize: vec2,
  direction: ToolbarDirection
): AttachmentReservationInput | null {
  const axisInfo = getAxisInfo(direction)
  const side = attachmentReservationSide(item.position, axisInfo.isHorizontal)
  if (!side) {
    return null
  }
  return {
    targetId: item.targetId,
    side,
    primarySize: axisInfo.isHorizontal ? attachedSize.x : attachedSize.y
  }
}

/**
 * Computes an attached item's local position relative to its target: pushed
 * outward past the target's edge by its own half-size plus {@link
 * ATTACHMENT_PADDING}, shifted by attachmentOffset, and 0.1 cm ahead in z.
 * CENTER overlays the target (offset only). Pure so the placement stays
 * unit-testable headlessly.
 */
export function computeAttachmentPosition(
  targetPosition: vec3,
  targetSize: vec2,
  itemSize: vec2,
  attachmentPosition: ToolbarAttachmentPosition,
  attachmentOffset: vec2
): vec3 {
  const position = new vec3(targetPosition.x, targetPosition.y, targetPosition.z + 0.1)

  const halfItemWidth = itemSize.x / 2
  const halfItemHeight = itemSize.y / 2
  const halfTargetWidth = targetSize.x / 2
  const halfTargetHeight = targetSize.y / 2

  switch (attachmentPosition) {
    case ToolbarAttachmentPosition.LEFT:
      position.x = targetPosition.x - halfTargetWidth - halfItemWidth - ATTACHMENT_PADDING + attachmentOffset.x
      position.y = targetPosition.y + attachmentOffset.y
      break
    case ToolbarAttachmentPosition.RIGHT:
      position.x = targetPosition.x + halfTargetWidth + halfItemWidth + ATTACHMENT_PADDING + attachmentOffset.x
      position.y = targetPosition.y + attachmentOffset.y
      break
    case ToolbarAttachmentPosition.TOP:
      position.x = targetPosition.x + attachmentOffset.x
      position.y = targetPosition.y + halfTargetHeight + halfItemHeight + ATTACHMENT_PADDING + attachmentOffset.y
      break
    case ToolbarAttachmentPosition.BOTTOM:
      position.x = targetPosition.x + attachmentOffset.x
      position.y = targetPosition.y - halfTargetHeight - halfItemHeight - ATTACHMENT_PADDING + attachmentOffset.y
      break
    case ToolbarAttachmentPosition.CENTER:
      position.x = targetPosition.x + attachmentOffset.x
      position.y = targetPosition.y + attachmentOffset.y
      break
  }

  return position
}

/** Inputs for resolving an attached item's cell size. */
export interface AttachedItemSizeInput {
  /** The attached item's `config.size`, or undefined to use the direction default. */
  sizeConfig?: ToolbarItemSize
  /** The resolved size of the attachTo target, used to fill an axis marked FILL. */
  targetSize: vec2
  /** Toolbar direction, used to pick the default per-axis size when sizeConfig is unset. */
  direction: ToolbarDirection
  /** Item minSize; floors the resolved size on each axis. */
  minSize?: vec2
  /** Item maxSize; caps the resolved size on each axis. */
  maxSize?: vec2
}

/**
 * Resolves an attached item's cell size: a numeric axis is used verbatim, a FILL
 * axis takes the target's dimension, and an unset config falls back to the
 * direction default (FILL on the primary axis, a 3 cm cross axis). The resolved
 * size is then clamped to the item's `minSize` / `maxSize` via
 * {@link clampSizeWithConstraints}, so attached manual, per-axis, and FILL sizes
 * share the same constraint contract a non-attached item gets from
 * {@link computeItemCellSize}. Pure so the attached-sizing contract is
 * unit-testable.
 */
export function resolveAttachedItemSize(input: AttachedItemSizeInput): vec2 {
  return resolveToolbarItemSize({
    sizeConfig: input.sizeConfig,
    sizeMode: ToolbarItemSizeMode.FILL,
    intrinsicSize: input.targetSize,
    fillSize: input.targetSize,
    direction: input.direction,
    defaultCrossAxisSize: 3,
    minSize: input.minSize,
    maxSize: input.maxSize
  }).size
}

/**
 * A stable, nonzero target reference for sizing an attached FILL item. Each axis
 * takes the target's flow `preferred` size when positive, else its `intrinsic`
 * size, else `fallback`. A primary-axis FILL target has a preferred primary of 0
 * (it grows via flex, so its final width is unknown pre-layout); normalizing to
 * the intrinsic gives an attached FILL item a real width to match instead of
 * collapsing to zero. This mirrors the positioner's existing intrinsic fallback
 * for a zero-sized target, so the reference is continuous with prior behavior.
 * Pure so the normalization is unit-testable headlessly.
 */
export function normalizeAttachmentTargetSize(preferred: vec2, intrinsic: vec2, fallback: number = 3): vec2 {
  const pick = (p: number, i: number): number => (p > 0 ? p : i > 0 ? i : fallback)
  return new vec2(pick(preferred.x, intrinsic.x), pick(preferred.y, intrinsic.y))
}

/** Inputs for the once-per-rebuild attached-item size resolution. */
export interface NormalizedAttachedItemSizeInput {
  /** The attached item's `config.size`, or undefined for the direction default. */
  sizeConfig?: ToolbarItemSize
  /** The target's flow preferred cell size (a FILL axis is 0 here). */
  targetPreferredSize: vec2
  /** The target's intrinsic size, used to normalize a zero preferred axis. */
  targetIntrinsicSize: vec2
  /** Toolbar direction, for the default per-axis size and the FILL axis. */
  direction: ToolbarDirection
  /** Item minSize; floors the resolved size on each axis. */
  minSize?: vec2
  /** Item maxSize; caps the resolved size on each axis. */
  maxSize?: vec2
}

/**
 * Resolves an attached item's size once per rebuild against a stable, nonzero
 * target reference ({@link normalizeAttachmentTargetSize}), then through the same
 * {@link resolveAttachedItemSize} contract a manual/per-axis/FILL attachment uses.
 * The Toolbar stores this single vec2 and feeds it to both the reservation
 * ({@link computeAttachmentReservationInput}) and the {@link
 * ToolbarAttachedItemPositioner}, so reserved and rendered sizes are identical by
 * construction and never chase the target's post-layout size. Pure so the
 * one-size contract is unit-testable headlessly.
 */
export function resolveNormalizedAttachedItemSize(input: NormalizedAttachedItemSizeInput): vec2 {
  const targetSize = normalizeAttachmentTargetSize(input.targetPreferredSize, input.targetIntrinsicSize)
  return resolveAttachedItemSize({
    sizeConfig: input.sizeConfig,
    targetSize,
    direction: input.direction,
    minSize: input.minSize,
    maxSize: input.maxSize
  })
}

/**
 * Resolves the size a ToolbarItemInput inspector emits into config: a MANUAL
 * item takes its manual vec2 (falling back to the per-type default when unset),
 * and a FILL item fills the primary axis with a fixed cross-axis size (the
 * cross default 3 cm when the field is non-positive), primary/cross assigned by
 * toolbar direction. Pure so the inspector-to-config size contract is
 * unit-testable headlessly; the LS-bound direction lookup stays in the caller.
 */
export function resolveInspectorItemSize(
  sizeMode: string,
  manualSize: vec2 | null,
  crossAxisSize: number,
  defaultManualSize: vec2,
  isHorizontal: boolean
): ToolbarItemSize {
  if (sizeMode === ToolbarItemSizeMode.MANUAL) {
    return manualSize ?? defaultManualSize
  }
  const effectiveCrossAxisSize = crossAxisSize > 0 ? crossAxisSize : 3
  return isHorizontal
    ? {x: ToolbarItemSizeMode.FILL, y: effectiveCrossAxisSize}
    : {x: effectiveCrossAxisSize, y: ToolbarItemSizeMode.FILL}
}

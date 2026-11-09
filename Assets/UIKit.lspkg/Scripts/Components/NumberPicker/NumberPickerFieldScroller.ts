import {clamp} from "InteractionKit.lspkg/Utils/mathUtils"
import {getNumberPickerVisibleRowCount, positiveModulo} from "../../../Scripts/Utility/UIKitUtilities"
import {BaseScroller} from "../BaseScroller"
import {makeScroller, NUMBER_PICKER_DETENT_PRESET} from "../ScrollerPresets"
import type {SnapSettleOptions, SnapSettleResult} from "../ScrollUtilities"
import {projectSnapPageFromStart, SnapScrollPolicy} from "../ScrollUtilities"

// Physics tuning lives in the "crisp" feel bundle (ScrollerPresets.ts); the values
// below are re-derived from the generated config for the inline read sites.
const NUMBER_PICKER_SCROLLER = makeScroller(NUMBER_PICKER_DETENT_PRESET)
const NUMBER_PICKER_SCROLLER_CONFIG = NUMBER_PICKER_SCROLLER.config
// Non-null by construction: the detent preset always emits snap-policy params.
const NUMBER_PICKER_SNAP_POLICY = NUMBER_PICKER_SCROLLER.snapPolicy!
const SCROLL_EPSILON = NUMBER_PICKER_SCROLLER_CONFIG.epsilon
const VELOCITY_BASE_FRAME_TIME = NUMBER_PICKER_SCROLLER_CONFIG.velocityBaseFrameTime
const MINIMUM_SCROLLING_VELOCITY = NUMBER_PICKER_SCROLLER_CONFIG.minimumScrollingVelocity
const SNAP_POSITION_SETTLE_THRESHOLD = SCROLL_EPSILON
const SNAP_VELOCITY_SETTLE_THRESHOLD = MINIMUM_SCROLLING_VELOCITY * 0.05
const MAX_OVERSHOOT_FACTOR = NUMBER_PICKER_DETENT_PRESET.maxOverscrollFraction
// Geometry-dependent wrap cap (scaled by logicalOptionCount at the use site) — stays consumer-side.
const MAX_WRAP_FLING_CYCLES = 3

export type NumberPickerFieldScrollerGeometry = {
  rowHeight: number
  windowHeight: number
  contentHeight: number
  optionCount: number
  wrapAround?: boolean
  logicalOptionCount?: number
  visibleRowCount?: number
}

export class NumberPickerFieldScroller extends BaseScroller {
  private readonly contentPosition: vec3 = vec3.zero()

  private rowHeight: number = 1
  private windowHeight: number = 0
  private contentHeight: number = 0
  private optionCount: number = 0
  private logicalOptionCount: number = 0
  private visibleRowCount: number = 1
  private wrapAround: boolean = false
  private scrollPositionY: number = 0
  // Snap latch + drag-start page anchor live in the policy collaborator; the
  // rendered-index twin of the latch stays here (selection semantics).
  private readonly snapPolicy = new SnapScrollPolicy(NUMBER_PICKER_SNAP_POLICY.snapVelocityHandoffScale)
  private readonly snapSettleResult: SnapSettleResult = {
    position: 0,
    settled: true,
    alreadyAtTarget: true,
    velocity: 0
  }
  private readonly normalizeSnapPosition = (position: number): number => this.normalizeWrappedSnapPosition(position)
  private readonly snapSettleOptions: SnapSettleOptions = {
    normalizePosition: this.normalizeSnapPosition
  }
  private committedSnapTargetIndex: number | null = null
  private _selectedIndex: number = 0

  public constructor(
    private readonly contentTransform: Transform,
    initialSelectedIndex: number = 0
  ) {
    super(NUMBER_PICKER_SCROLLER_CONFIG)
    this._selectedIndex = Number.isFinite(initialSelectedIndex) ? Math.max(0, Math.floor(initialSelectedIndex)) : 0
    this.contentPosition.copyFrom(this.contentTransform.getLocalPosition())
  }

  public get selectedIndex(): number {
    return this._selectedIndex
  }

  public get contentPositionY(): number {
    return this.scrollPositionY
  }

  public get selectedRenderedIndex(): number {
    if (this.optionCount <= 0) {
      return -1
    }

    return this.normalizePageIndex(this.getPageIndexFromPosition(this.scrollPositionY))
  }

  public get isSettled(): boolean {
    if (this.isDragging) {
      return false
    }

    if (!this.canScroll) {
      return Math.abs(this.scrollPositionY) <= SCROLL_EPSILON
    }

    if (this.isScrollOutOfBounds(this.scrollPositionY)) {
      return false
    }

    return this.isSettledOnSelectedIndex()
  }

  public setSelectedIndex(index: number, animate: boolean = false): boolean {
    if (!Number.isFinite(index)) {
      return false
    }

    const previousSelectedIndex = this._selectedIndex
    const selectedIndex = this.normalizeSelectedIndex(Math.floor(index))

    this.cancelMotion()

    if (this.optionCount <= 0) {
      this._selectedIndex = 0
      this.clearCommittedSnapTarget()
      const didMove = this.setScrollPosition(0)
      this.startPosition = this.scrollPositionY
      this.lastPosition = this.scrollPositionY
      this.snapPolicy.startingPageIndex = 0
      return previousSelectedIndex !== this._selectedIndex || didMove
    }

    const currentPageIndex = this.getPageIndexFromPosition(this.scrollPositionY)
    const targetRenderedIndex = this.getNearestRenderedIndexForSelectedIndex(selectedIndex, currentPageIndex)

    this._selectedIndex = selectedIndex
    this.startPosition = this.scrollPositionY
    this.lastPosition = this.scrollPositionY
    this.snapPolicy.startingPageIndex = currentPageIndex

    if (animate && this.canScroll) {
      this.resetSpring()
      if (this.isWrapping) {
        this.setWrappedCommittedSnapTarget(targetRenderedIndex)
      } else {
        this.setCommittedSnapTarget(targetRenderedIndex)
      }
      return previousSelectedIndex !== this._selectedIndex
    }

    this.clearCommittedSnapTarget()
    this.resetSpring()
    const didMove = this.setScrollPosition(this.getScrollPositionForIndex(targetRenderedIndex))
    this.startPosition = this.scrollPositionY
    this.lastPosition = this.scrollPositionY
    this.snapPolicy.startingPageIndex = targetRenderedIndex
    return previousSelectedIndex !== this._selectedIndex || didMove
  }

  public configure(geometry: NumberPickerFieldScrollerGeometry): void {
    const oldRowHeight = this.rowHeight
    const oldTopEdge = this.topEdge
    const oldOptionCount = this.optionCount
    const oldLogicalOptionCount = this.logicalOptionCount
    const oldIsWrapping = this.isWrapping
    const oldCanScroll = this.canScroll
    const oldFractionalRowPosition = (this.scrollPositionY - oldTopEdge) / oldRowHeight
    const oldStartFractionalRowPosition = (this.startPosition - oldTopEdge) / oldRowHeight
    const oldCommittedTargetIndex =
      this.committedSnapTargetIndex !== null && oldOptionCount > 0
        ? clamp(this.committedSnapTargetIndex, 0, oldOptionCount - 1)
        : null
    const oldSnapVelocityY = this.springVelocity
    const shouldPreserveGestureAnchor =
      this.isDragging || this.hasPendingFlingVelocity || oldCommittedTargetIndex !== null

    this.rowHeight = Math.max(SCROLL_EPSILON, geometry.rowHeight)
    this.windowHeight = Math.max(0, geometry.windowHeight)
    this.optionCount = Math.max(0, geometry.optionCount)
    this.visibleRowCount = Number.isFinite(geometry.visibleRowCount)
      ? Math.max(1, Math.floor(geometry.visibleRowCount as number))
      : getNumberPickerVisibleRowCount(this.windowHeight, geometry.rowHeight)
    const requestedLogicalOptionCount = Number.isFinite(geometry.logicalOptionCount)
      ? Math.max(0, Math.floor(geometry.logicalOptionCount as number))
      : this.optionCount
    this.wrapAround =
      geometry.wrapAround === true && requestedLogicalOptionCount > 1 && this.optionCount > requestedLogicalOptionCount
    this.logicalOptionCount = this.wrapAround ? requestedLogicalOptionCount : this.optionCount
    this.contentHeight = this.optionCount > 0 ? Math.max(this.windowHeight, geometry.contentHeight) : this.windowHeight
    this._selectedIndex = this.normalizeSelectedIndex(this._selectedIndex)
    const shouldResetForWrapGeometry =
      oldIsWrapping !== this.isWrapping ||
      (this.isWrapping && (oldOptionCount !== this.optionCount || oldLogicalOptionCount !== this.logicalOptionCount))

    if (!this.canScroll) {
      this.resetMotionState()
      this.setScrollPosition(0)
      this.startPosition = this.scrollPositionY
      this.lastPosition = this.scrollPositionY
      return
    }

    if (!oldCanScroll || oldRowHeight <= SCROLL_EPSILON || shouldResetForWrapGeometry) {
      this.resetMotionState()
      this.setScrollPosition(this.getScrollPositionForIndex(this.getRenderedIndexForSelectedIndex(this._selectedIndex)))
      this.startPosition = this.scrollPositionY
      this.lastPosition = this.scrollPositionY
      return
    }

    const rowHeightScale = this.rowHeight / oldRowHeight
    const preservedFractionalRowPosition = this.normalizeFractionalRowPosition(oldFractionalRowPosition)
    const preservedStartFractionalRowPosition = this.normalizeFractionalRowPosition(oldStartFractionalRowPosition)

    if (oldCommittedTargetIndex !== null) {
      this.setCommittedSnapTarget(oldCommittedTargetIndex)
      this.springVelocity = oldSnapVelocityY * rowHeightScale
    } else {
      this.clearCommittedSnapTarget()
      this.resetSpring()
    }

    if (this.hasPendingFlingVelocity) {
      this.scaleFlingVelocity(rowHeightScale)
    }

    this.setScrollPosition(this.getScrollPositionForFractionalRow(preservedFractionalRowPosition))
    this.startPosition = shouldPreserveGestureAnchor
      ? this.getScrollPositionForFractionalRow(preservedStartFractionalRowPosition)
      : this.scrollPositionY
    this.snapPolicy.startingPageIndex = shouldPreserveGestureAnchor
      ? this.normalizePageIndex(this.snapPolicy.startingPageIndex)
      : this.getRenderedIndexForSelectedIndex(this._selectedIndex)
    this.lastPosition = this.scrollPositionY
  }

  public beginDrag(localY: number): void {
    if (!this.canScroll) {
      return
    }
    super.beginDrag(this.scrollPositionY, localY)
    this.clearCommittedSnapTarget()
    this.snapPolicy.startingPageIndex = this.getPageIndexFromPosition(this.startPosition)
  }

  public updateDrag(localY: number): boolean {
    if (!this.isDragging || !this.canScroll) {
      return false
    }

    const dragPosition = this.getDragPosition(localY)
    const rawNextPosition = this.isWrapping ? dragPosition : this.applyOverscrollIfNeeded(dragPosition)
    const nextPosition = this.normalizeWrappedScrollPosition(rawNextPosition)
    const normalizationDelta = nextPosition - rawNextPosition
    if (Math.abs(normalizationDelta) > SCROLL_EPSILON) {
      this.offsetGestureAnchor(normalizationDelta)
      this.snapPolicy.startingPageIndex = this.getPageIndexFromPosition(this.startPosition)
    }
    const didMove = this.setScrollPosition(nextPosition)
    this.updateVelocityFromPosition(nextPosition)
    return didMove
  }

  public endDrag(): void {
    if (!this.isDragging) {
      return
    }

    super.endDrag()
  }

  public update(): boolean {
    if (this.isDragging) {
      return false
    }

    if (!this.canScroll) {
      if (Math.abs(this.scrollPositionY) > SCROLL_EPSILON) {
        return this.setScrollPosition(0)
      }
      return false
    }

    if (this.isScrollOutOfBounds(this.scrollPositionY)) {
      return this.processSnapScrolling()
    }

    if (this.isSettledOnSelectedIndex()) {
      return false
    }

    return this.processSnapScrolling()
  }

  private processSnapScrolling(): boolean {
    if (!this.snapPolicy.hasCommittedTarget) {
      let targetPosition: number

      if (!this.hasPendingFlingVelocity) {
        targetPosition = this.setCommittedSnapTarget(this.getPageIndexFromPosition(this.scrollPositionY))
      } else {
        const targetPageIndex = projectSnapPageFromStart({
          startPageIndex: this.snapPolicy.startingPageIndex,
          releasePageIndex: this.getPageIndexFromPosition(this.scrollPositionY),
          currentPosition: this.scrollPositionY,
          startPosition: this.startPosition,
          velocity: this.flingVelocity,
          minFlingVelocity: MINIMUM_SCROLLING_VELOCITY,
          projectedDistance: this.getProjectedFlingDistance(Math.abs(this.flingVelocity)),
          pitch: this.rowHeight,
          deadzone: this.rowHeight * NUMBER_PICKER_SNAP_POLICY.deadzoneFraction,
          maxProjectedPages: this.isWrapping
            ? this.logicalOptionCount * MAX_WRAP_FLING_CYCLES
            : Number.POSITIVE_INFINITY
        })
        targetPosition = this.isWrapping
          ? this.setWrappedCommittedSnapTarget(targetPageIndex)
          : this.setCommittedSnapTarget(targetPageIndex)
      }
      this.resetSpring()
      this.seedSnapSpringVelocity(targetPosition)
    }

    const step = this.snapPolicy.stepSettleInto(
      this,
      this.scrollPositionY,
      SNAP_POSITION_SETTLE_THRESHOLD,
      SNAP_VELOCITY_SETTLE_THRESHOLD,
      this.snapSettleResult,
      this.snapSettleOptions
    )

    if (step.settled) {
      return this.finishSnapScrolling(step.position)
    }

    return this.setScrollPosition(step.position)
  }

  private isSettledOnSelectedIndex(): boolean {
    if (this.snapPolicy.hasCommittedTarget || this.hasPendingFlingVelocity) {
      return false
    }

    const currentPageIndex = this.getPageIndexFromPosition(this.scrollPositionY)
    const targetPosition = this.getScrollPositionForIndex(
      this.getNearestRenderedIndexForSelectedIndex(this._selectedIndex, currentPageIndex)
    )
    return this.isSpringSettled(
      this.scrollPositionY,
      targetPosition,
      SNAP_POSITION_SETTLE_THRESHOLD,
      SNAP_VELOCITY_SETTLE_THRESHOLD
    )
  }

  private setScrollPosition(y: number): boolean {
    if (y === this.scrollPositionY) {
      return false
    }
    this.scrollPositionY = y
    this.contentPosition.y = y
    this.contentTransform.setLocalPosition(this.contentPosition)
    this.updateSelectedIndexFromPosition()
    return true
  }

  private updateSelectedIndexFromPosition(): void {
    if (this.optionCount <= 0) {
      this._selectedIndex = 0
      return
    }
    if (this.committedSnapTargetIndex !== null) {
      this._selectedIndex = this.getSelectedIndexForRenderedIndex(this.committedSnapTargetIndex)
      return
    }
    this._selectedIndex = this.getSelectedIndexForRenderedIndex(this.getPageIndexFromPosition(this.scrollPositionY))
  }

  private getPageIndexFromPosition(position: number): number {
    return Math.round((position - this.topEdge) / this.rowHeight)
  }

  private getScrollPositionForIndex(index: number): number {
    return this.topEdge + clamp(index, 0, Math.max(0, this.optionCount - 1)) * this.rowHeight
  }

  private getScrollPositionForFractionalRow(fractionalRow: number): number {
    return this.topEdge + fractionalRow * this.rowHeight
  }

  private getClampedScrollPosition(position: number): number {
    if (!this.canScroll) {
      return 0
    }
    if (this.isWrapping) {
      return position
    }
    return clamp(position, this.topEdge, this.bottomEdge)
  }

  private isScrollOutOfBounds(position: number): boolean {
    return Math.abs(position - this.getClampedScrollPosition(position)) > SCROLL_EPSILON
  }

  private applyOverscrollIfNeeded(position: number): number {
    return this.applyOverscroll(position, {min: this.topEdge, max: this.bottomEdge}, this.maxOverscroll)
  }

  private seedSnapSpringVelocity(targetPosition: number): void {
    const maxHandoffVelocity = this.rowHeight / VELOCITY_BASE_FRAME_TIME
    this.springVelocity = this.snapPolicy.consumeSnapVelocityHandoff(
      this,
      targetPosition,
      this.scrollPositionY,
      maxHandoffVelocity
    )
  }

  private finishSnapScrolling(targetPosition: number): boolean {
    let didMove = this.setScrollPosition(targetPosition)
    const normalizedPosition = this.normalizeWrappedScrollPosition(this.scrollPositionY)
    if (Math.abs(normalizedPosition - this.scrollPositionY) > SCROLL_EPSILON) {
      didMove = this.setScrollPosition(normalizedPosition) || didMove
    }
    this.clearCommittedSnapTarget()
    this.resetSpring()
    this.clearPendingFlingVelocity()
    return didMove
  }

  private resetMotionState(): void {
    this.cancelMotion()
    this.clearCommittedSnapTarget()
    this.snapPolicy.startingPageIndex = this.getRenderedIndexForSelectedIndex(this._selectedIndex)
  }

  private setCommittedSnapTarget(index: number): number {
    const committedIndex = this.normalizePageIndex(index)
    const committedPosition = this.getScrollPositionForIndex(committedIndex)
    this._selectedIndex = this.getSelectedIndexForRenderedIndex(committedIndex)
    this.committedSnapTargetIndex = committedIndex
    return this.snapPolicy.commitTarget(committedPosition)
  }

  private setWrappedCommittedSnapTarget(index: number): number {
    const selectedIndex = this.getSelectedIndexForRenderedIndex(index)
    const committedIndex = this.getNearestRenderedIndexForSelectedIndex(selectedIndex, index)
    const committedPosition = this.getScrollPositionForFractionalRow(index)
    this._selectedIndex = selectedIndex
    this.committedSnapTargetIndex = committedIndex
    return this.snapPolicy.commitTarget(committedPosition)
  }

  private clearCommittedSnapTarget(): void {
    this.snapPolicy.clearTarget()
    this.committedSnapTargetIndex = null
  }

  private get topEdge(): number {
    return this.contentHeight * -0.5 + this.windowHeight * 0.5
  }

  private get bottomEdge(): number {
    return this.contentHeight * 0.5 - this.windowHeight * 0.5
  }

  private get maxOverscroll(): number {
    return this.windowHeight * MAX_OVERSHOOT_FACTOR
  }

  private get canScroll(): boolean {
    return this.optionCount > 1 && this.contentHeight > this.windowHeight + SCROLL_EPSILON
  }

  private get isWrapping(): boolean {
    return this.wrapAround
  }

  private get renderedOptionOffset(): number {
    return this.isWrapping ? Math.floor((this.optionCount - this.logicalOptionCount) / 2) : 0
  }

  private normalizeSelectedIndex(index: number): number {
    const selectableCount = this.isWrapping ? this.logicalOptionCount : this.optionCount
    if (selectableCount <= 0) {
      return 0
    }
    return clamp(index, 0, selectableCount - 1)
  }

  private getRenderedIndexForSelectedIndex(index: number): number {
    if (!this.isWrapping) {
      return clamp(index, 0, Math.max(0, this.optionCount - 1))
    }
    return this.renderedOptionOffset + positiveModulo(index, this.logicalOptionCount)
  }

  private getSelectedIndexForRenderedIndex(index: number): number {
    if (!this.isWrapping) {
      return clamp(index, 0, Math.max(0, this.optionCount - 1))
    }
    return positiveModulo(index - this.renderedOptionOffset, this.logicalOptionCount)
  }

  private getNearestRenderedIndexForSelectedIndex(selectedIndex: number, targetPageIndex: number): number {
    if (!this.isWrapping) {
      return clamp(selectedIndex, 0, Math.max(0, this.optionCount - 1))
    }

    const baseRenderedIndex = this.getRenderedIndexForSelectedIndex(selectedIndex)
    const safeMinPage = this.hasWrapSafeRange ? this.wrapSafeMinPage : 0
    const safeMaxPage = this.hasWrapSafeRange ? this.wrapSafeMaxPage : this.optionCount - 1
    const minCycle = Math.ceil((safeMinPage - baseRenderedIndex) / this.logicalOptionCount)
    const maxCycle = Math.floor((safeMaxPage - baseRenderedIndex) / this.logicalOptionCount)
    const targetCycle = clamp(
      Math.round((targetPageIndex - baseRenderedIndex) / this.logicalOptionCount),
      minCycle,
      maxCycle
    )
    return baseRenderedIndex + targetCycle * this.logicalOptionCount
  }

  private normalizePageIndex(index: number): number {
    if (!this.isWrapping) {
      return clamp(index, 0, Math.max(0, this.optionCount - 1))
    }
    return this.getNearestRenderedIndexForSelectedIndex(this.getSelectedIndexForRenderedIndex(index), index)
  }

  private normalizeFractionalRowPosition(fractionalRowPosition: number): number {
    if (!this.isWrapping) {
      return clamp(fractionalRowPosition, 0, this.optionCount - 1)
    }

    const minVisiblePage = this.wrapSafeMinPage
    const maxVisiblePage = this.wrapSafeMaxPage
    if (!this.hasWrapSafeRange) {
      return this.normalizePageIndex(Math.round(fractionalRowPosition))
    }

    let normalizedPage = fractionalRowPosition
    if (normalizedPage < minVisiblePage) {
      normalizedPage += Math.ceil((minVisiblePage - normalizedPage) / this.logicalOptionCount) * this.logicalOptionCount
    } else if (normalizedPage > maxVisiblePage) {
      normalizedPage -= Math.ceil((normalizedPage - maxVisiblePage) / this.logicalOptionCount) * this.logicalOptionCount
    }
    return normalizedPage
  }

  private normalizeWrappedScrollPosition(position: number): number {
    if (!this.isWrapping) {
      return position
    }
    const fractionalRowPosition = (position - this.topEdge) / this.rowHeight
    return this.getScrollPositionForFractionalRow(this.normalizeFractionalRowPosition(fractionalRowPosition))
  }

  private normalizeWrappedSnapPosition(position: number): number {
    if (!this.isWrapping) {
      return position
    }

    const normalizedResult = this.normalizeWrappedScrollPosition(position)
    const normalizationDelta = normalizedResult - position
    if (Math.abs(normalizationDelta) <= SCROLL_EPSILON) {
      return position
    }

    return normalizedResult
  }

  private get wrapSafeMinPage(): number {
    return this.visibleRowCount
  }

  private get wrapSafeMaxPage(): number {
    return this.optionCount - 1 - this.visibleRowCount
  }

  private get hasWrapSafeRange(): boolean {
    return this.wrapSafeMinPage <= this.wrapSafeMaxPage
  }
}

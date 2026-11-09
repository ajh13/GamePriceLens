import {PublicApi} from "InteractionKit.lspkg/Utils/Event"
import {LINE_CENTER_OFFSET_RATIO} from "../../../Utility/TextManipulationUtils"

const EPSILON = 0.001

/**
 * A drag in progress, passed to every {@link TextGeometryResolver.getIndexFromDragPosition} call of that
 * drag. Begin each drag with `startPosition` set to null.
 */
export type TextDrag = {
  /** The caret index the drag moves from. */
  startIndex: number
  /** Set by the resolver when the drag first resolves to an index other than `startIndex`; null until then. */
  startPosition: vec2 | null
}

/**
 * A utility class responsible for mapping between 3D space and 2D text cursor positions.
 *
 * TextGeometryResolver translates world coordinates, local coordinates, and drag deltas into
 * logical text caret indices. It uses the visual cursor positions provided by the Lens Studio
 * Text component to perform accurate geometric lookups for interactions like tapping to place
 * the caret or dragging to select text.
 */
export class TextGeometryResolver {
  private readonly textTransform: Transform
  private readonly textScreenTransform: ScreenTransform | null
  private cursorPositions: CursorPosition[] | null = null
  private cursorHeight: number = 0

  private readonly _offsetVector: vec3 = vec3.zero()
  private readonly _targetLocalPos: vec3 = vec3.zero()

  private unsubscribes: (() => void)[] = []

  public constructor(
    private readonly textComponent: Text,
    onCursorPositionsUpdated: PublicApi<CursorPosition[]> | null = null,
    onCursorHeightUpdated: PublicApi<number> | null = null
  ) {
    const textObject = this.textComponent.getSceneObject()
    this.textTransform = textObject.getTransform()
    this.textScreenTransform = textObject.getComponent("ScreenTransform")
    if (onCursorPositionsUpdated) {
      this.unsubscribes.push(
        onCursorPositionsUpdated.add((cursorPositions: CursorPosition[]) => {
          this.cursorPositions = cursorPositions
        })
      )
    }
    if (onCursorHeightUpdated) {
      this.unsubscribes.push(
        onCursorHeightUpdated.add((cursorHeight: number) => {
          this.cursorHeight = cursorHeight
        })
      )
    }
  }

  public destroy() {
    this.unsubscribes.forEach((unsub) => unsub())
    this.unsubscribes = []
  }

  /**
   * Checks if a caret index is at the beginning or end of a line.
   * Used to allow clearing highlights by touching line boundaries.
   * @param index - The caret index to check
   * @returns True if the index is at the start or end of its line
   */
  public isAtLineBoundary(index: number): boolean {
    if (
      !this.cursorPositions ||
      this.cursorPositions.length === 0 ||
      index < 0 ||
      index >= this.cursorPositions.length
    ) {
      return false
    }

    const targetPos = this.cursorPositions[index]
    if (!targetPos || !targetPos.position) {
      return false
    }

    const targetY = targetPos.position.y

    let isMin = true
    let isMax = true

    // Scan backwards - stop as soon as we find a character on the same line
    for (let i = index - 1; i >= 0; i--) {
      const pos = this.cursorPositions[i]
      if (pos && pos.position && Math.abs(pos.position.y - targetY) < EPSILON) {
        isMin = false
        break
      } else if (pos && pos.position) {
        break // Reached a different line
      }
    }

    // Scan forwards - stop as soon as we find a character on the same line
    for (let i = index + 1; i < this.cursorPositions.length; i++) {
      const pos = this.cursorPositions[i]
      if (pos && pos.position && Math.abs(pos.position.y - targetY) < EPSILON) {
        isMax = false
        break
      } else if (pos && pos.position) {
        break // Reached a different line
      }
    }

    return isMin || isMax
  }

  /**
   * Retrieves the local 3D position of a specific caret index.
   *
   * @param index - The caret index to look up
   * @returns The local position of the caret, or null if the cursor positions are unavailable
   */
  public getLocalPositionForIndex(index: number): vec3 | null {
    if (!this.cursorPositions || this.cursorPositions.length === 0) return null
    const validIndex = Math.max(0, Math.min(index, this.cursorPositions.length - 1))
    const pos = this.cursorPositions[validIndex]?.position
    if (!pos) return null
    return new vec3(pos.x - this.textOffsetX, pos.y - this.textOffsetY, 0)
  }

  /**
   * Calculates the nearest caret index from a world space position.
   * @param worldPos - World space position to convert
   * @returns Index of nearest caret position (0 to text.length)
   */
  public getIndexFromWorldPosition(worldPos: vec3): number {
    this._offsetVector.x = this.textOffsetX
    this._offsetVector.y = this.textOffsetY
    const localPos = this.textTransform.getInvertedWorldTransform().multiplyPoint(worldPos).add(this._offsetVector)

    return this.getIndexFromLocalPosition(localPos)
  }

  /**
   * Calculates the target caret index during a drag operation.
   *
   * The drag moves the cursor position of `drag.startIndex` (the index a caret press resolved to, or the
   * highlight edge a handle started from) by the drag delta. The delta is taken in the text's local space
   * so the selection follows the interactor regardless of the text component's rotation or scale. Both
   * positions must come from the same source (for example the interactor's planecast point), so that any
   * constant bias of that source, such as the planecast's depth parallax from the collider hit, cancels
   * in the delta.
   *
   * Cursor positions move when the text scrolls. Until the drag first resolves to another index, it starts
   * from where `drag.startIndex` is now, so a scroll that brings the start line into view cannot move a
   * still drag. From then on it keeps the start position it had at that moment, fixed in the viewport
   * while the text scrolls under it, so a drag held past the edge of scrolling text keeps reaching the
   * text beyond the edge as the host scrolls it in.
   *
   * @param drag - The drag in progress; its `startPosition` is set when the drag first resolves to another index
   * @param dragStart - The world space position where the drag started
   * @param currentPos - The current world space position of the drag
   * @param sensitivity - Multiplier for the drag delta to adjust responsiveness
   * @returns The nearest caret index to the dragged position
   */
  public getIndexFromDragPosition(
    drag: TextDrag,
    dragStart: vec3,
    currentPos: vec3,
    sensitivity: vec2 = vec2.one()
  ): number {
    if (!this.cursorPositions || this.cursorPositions.length === 0) {
      return 0
    }

    const validIndex = Math.max(0, Math.min(drag.startIndex, this.cursorPositions.length - 1))
    const startPosition = drag.startPosition ?? this.cursorPositions[validIndex]?.position
    if (!startPosition) {
      return validIndex
    }

    // Convert drag positions to local space to calculate deltas.
    // Scroll offset cancels in the delta since both points are transformed the same way.
    const invertedTransform = this.textTransform.getInvertedWorldTransform()
    const startLocal = invertedTransform.multiplyPoint(dragStart)
    const currLocal = invertedTransform.multiplyPoint(currentPos)

    const scaledDeltaX = (currLocal.x - startLocal.x) * sensitivity.x
    const scaledDeltaY = (currLocal.y - startLocal.y) * sensitivity.y

    // targetLocalPos is in cursor-position space (raw, no scroll offset). The drag starts from the line's
    // visual center rather than its cursor Y, so switching lines takes the same travel up as down.
    this._targetLocalPos.x = startPosition.x + scaledDeltaX
    this._targetLocalPos.y = startPosition.y + this.lineCenterOffset + scaledDeltaY
    this._targetLocalPos.z = 0

    const index = this.getIndexFromLocalPosition(this._targetLocalPos)
    if (!drag.startPosition && index !== validIndex) {
      // Once per drag: from here on the drag keeps this start position.
      drag.startPosition = new vec2(startPosition.x, startPosition.y)
    }
    return index
  }

  /**
   * Finds the caret index nearest to a visual position in cursor-position space: the line whose visual
   * center is nearest to `localPos.y`, then the cursor on that line nearest to `localPos.x`.
   */
  private getIndexFromLocalPosition(localPos: {x: number; y: number}): number {
    if (!this.cursorPositions || this.cursorPositions.length === 0) {
      return 0
    }

    const nearestLineY = this.getNearestLineY(localPos.y)
    if (nearestLineY === null) {
      return 0
    }

    let nearestIndex = 0
    let minDx = Infinity

    for (let i = 0; i < this.cursorPositions.length; i++) {
      const cursorData = this.cursorPositions[i]
      if (!cursorData || !cursorData.position) continue

      const pos = cursorData.position
      if (Math.abs(pos.y - nearestLineY) >= EPSILON) continue

      const dx = Math.abs(localPos.x - pos.x)
      if (dx < minDx) {
        minDx = dx
        nearestIndex = i
      }
    }

    return nearestIndex
  }

  /**
   * Returns the cursor Y of the line whose visual center is nearest to `targetY`, a visual position.
   * Comparing against the cursor Y itself would put the boundary between two lines a quarter of the
   * cursor height too low, handing the top of every line to the line above.
   */
  private getNearestLineY(targetY: number): number | null {
    if (!this.cursorPositions || this.cursorPositions.length === 0) {
      return null
    }

    const lineCenterOffset = this.lineCenterOffset
    let currentLineY: number | null = null
    let nearestLineY: number | null = null
    let minLineDistance = Infinity

    for (let i = 0; i < this.cursorPositions.length; i++) {
      const cursorData = this.cursorPositions[i]
      if (!cursorData || !cursorData.position) continue

      const y = cursorData.position.y
      if (currentLineY !== null && Math.abs(y - currentLineY) < EPSILON) continue

      currentLineY = y
      const lineDistance = Math.abs(targetY - (y + lineCenterOffset))
      if (lineDistance < minLineDistance) {
        minLineDistance = lineDistance
        nearestLineY = y
      }
    }

    return nearestLineY
  }

  // Distance from a line's cursor Y up to its visual center; 0 until the cursor height is known, so line
  // selection falls back to comparing against cursor Y.
  private get lineCenterOffset(): number {
    return this.cursorHeight * LINE_CENTER_OFFSET_RATIO
  }

  private get textOffsetX(): number {
    const offsets = this.textScreenTransform?.offsets
    if (!offsets) return 0
    return (offsets.left + offsets.right) / 2
  }

  private get textOffsetY(): number {
    const offsets = this.textScreenTransform?.offsets
    if (!offsets) return 0
    return (offsets.top + offsets.bottom) / 2
  }
}

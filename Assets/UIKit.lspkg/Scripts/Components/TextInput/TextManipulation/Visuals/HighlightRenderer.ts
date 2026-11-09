import {PublicApi} from "InteractionKit.lspkg/Utils/Event"
import {HighlightDefaultColor} from "../../../../Themes/System-3.0/Colors"
import {UNIT_PLANE_MESH_ASSET} from "../../../../Utility/Assets"
import {getUtf16IndexFromCursorIndex, LINE_CENTER_OFFSET_RATIO} from "../../../../Utility/TextManipulationUtils"

const HIGHLIGHT_MATERIAL: Material = requireAsset("../../../../../Materials/HighlightMat.mat") as Material

// Constants
// Backmost of the text-manipulation visuals (see CaretRenderer for the ladder).
const HIGHLIGHT_Z_OFFSET = 0.005
const EPSILON = 0.001

/**
 * Represents the rendered local-space geometry of an active highlight segment.
 */
export type HighlightRect = {
  centerX: number
  centerY: number
  width: number
  leftX: number
  rightX: number
  handleAnchorY: number
  height: number
}

/**
 * Outcome of {@link HighlightRenderer.measureRange}.
 * - `"measured"`: `out` holds the range's first visible rectangle.
 * - `"retry"`: no geometry could be read this frame. Either `Text.getHighlightRects` was rate-limited or
 *   the range could not be resolved to characters yet (cursor positions not ready), in which case nothing
 *   was queried and asking again is free.
 * - `"none"`: `Text.getHighlightRects` ran and reported no visible rectangle. Asking again would spend the
 *   shared per-frame Text geometry budget for the same answer.
 */
export type MeasureRangeResult = "measured" | "retry" | "none"

/** UTF-16 character range handed to `Text.getHighlightRects`. */
type CharRange = {
  start: number
  end: number
}

/**
 * Represents a highlight visual that can be reused from a pool.
 */
interface PooledHighlight {
  sceneObject: SceneObject
  transform: Transform
  // Mirrored with sceneObject.enabled so a pooled-hidden segment doesn't leave an alpha-0
  // RenderMeshVisual enabled in the render pipeline.
  rmv: RenderMeshVisual
  active: boolean
}

/**
 * Handles text selection highlight visual rendering.
 * Supports multi-line selections via object pooling.
 */
export class HighlightRenderer {
  private readonly highlightLayer: SceneObject
  private highlightPool: PooledHighlight[] = []
  private readonly rectsPool: HighlightRect[] = []
  private readonly activeRects: HighlightRect[] = []
  // Scratch for resolveCharRange, so a query allocates nothing.
  private readonly _charRange: CharRange = {start: 0, end: 0}
  private readonly textScreenTransform: ScreenTransform | null = null
  private cursorPositions: CursorPosition[] | null = null

  private readonly highlightMaterial: Material = HIGHLIGHT_MATERIAL.clone()
  private _renderOrder: number
  private readonly _highlightPosition: vec3 = vec3.zero()
  private readonly _highlightScale: vec3 = vec3.one()

  private unsubscribes: (() => void)[] = []

  public constructor(
    private readonly textComponent: Text,
    onCursorPositionsUpdated: PublicApi<CursorPosition[]>,
    color: vec4 = HighlightDefaultColor
  ) {
    const textSceneObject = textComponent.getSceneObject()
    this.textScreenTransform = textSceneObject.getComponent("ScreenTransform")
    this._renderOrder = textComponent.getRenderOrder()
    this.highlightLayer = global.scene.createSceneObject("HighlightLayer")
    this.highlightLayer.layer = textSceneObject.layer
    this.highlightLayer.setParent(textSceneObject)
    this.setColor(color)
    // Shared by every pooled quad: transparent chrome over the glyphs, so
    // depth-test but never depth-write (see CaretRenderer). HighlightMat.mat
    // already ships these flags; set here so the invariant does not depend on the asset.
    this.highlightMaterial.mainPass.depthTest = true
    this.highlightMaterial.mainPass.depthWrite = false

    this.unsubscribes.push(
      onCursorPositionsUpdated.add((cursorPositions: CursorPosition[]) => {
        this.cursorPositions = cursorPositions
      })
    )
  }

  public get color(): vec4 {
    return this.highlightMaterial.mainPass.baseColor
  }

  public set color(color: vec4) {
    if (color === undefined) return

    this.setColor(color)
  }

  /** Keeps every pooled highlight in the text input's shared render-order band. */
  public set renderOrder(renderOrder: number) {
    this._renderOrder = renderOrder
    for (const highlight of this.highlightPool) {
      highlight.rmv.setRenderOrder(renderOrder)
    }
  }

  /**
   * Updates the highlight position and size based on selection range.
   * Handles multi-line selections by creating multiple highlight segments.
   *
   * @param startIndex - The start index of the selection
   * @param endIndex - The end index of the selection
   * @returns The rendered local-space bounds for each active highlight rectangle, or `null` when the Text
   * component's rate-limited geometry query was unavailable this frame. In that case the previously rendered
   * rectangles are left untouched and the caller should retry on a later frame.
   */
  public updateHighlight(startIndex: number, endIndex: number): ReadonlyArray<HighlightRect> | null {
    if (startIndex === endIndex) {
      this.hide()
      return this.activeRects
    }

    if (!this.cursorPositions || this.cursorPositions.length === 0) {
      this.hide()
      return this.activeRects
    }

    const minIndex = Math.min(startIndex, endIndex)
    const maxIndex = Math.max(startIndex, endIndex)
    const maxCursorIndex = this.cursorPositions.length - 1
    const validStart = Math.max(0, Math.min(minIndex, maxCursorIndex))
    const validEnd = Math.max(0, Math.min(maxIndex, maxCursorIndex))

    if (validStart >= validEnd) {
      this.hide()
      return this.activeRects
    }

    // Calculate highlight rectangles
    const numRects = this.calculateSelectionRects(validStart, validEnd)
    if (numRects === null) return null
    this.activeRects.length = 0

    // Render rects
    for (let i = 0; i < numRects; i++) {
      const rect = this.rectsPool[i]
      const highlight = this.getHighlightFromPool(i)

      this.applyRectToTransform(rect, highlight.transform)
      this.activeRects.push(rect)

      if (!highlight.active) {
        highlight.sceneObject.enabled = true
        highlight.rmv.enabled = true
        highlight.active = true
      }
    }

    // Disable unused rects
    for (let i = numRects; i < this.highlightPool.length; i++) {
      const unusedHighlight = this.highlightPool[i]
      if (!unusedHighlight.active) break
      unusedHighlight.sceneObject.enabled = false
      unusedHighlight.rmv.enabled = false
      unusedHighlight.active = false
    }

    return this.activeRects
  }

  /**
   * Measures the first rendered rectangle of a cursor range without touching the rendered highlight.
   * Used to grow the caret into the word under it while a long press is held, so the caret lands on
   * the first rectangle {@link updateHighlight} will draw once the press fires.
   *
   * @param startIndex - The start cursor index of the range
   * @param endIndex - The end cursor index of the range
   * @param out - Receives the rect's local-space center and size
   * @returns `"measured"` when `out` was filled; `"retry"` when nothing could be read this frame and the
   * caller should ask again later; `"none"` when the host reported no visible rect, so the caller should
   * stop asking. See {@link MeasureRangeResult}.
   */
  public measureRange(
    startIndex: number,
    endIndex: number,
    out: Pick<HighlightRect, "centerX" | "centerY" | "width" | "height">
  ): MeasureRangeResult {
    if (!this.resolveCharRange(startIndex, endIndex, this._charRange)) return "retry"
    const highlightRects = this.getHighlightRectsGuarded(this._charRange)
    if (highlightRects === null) return "retry"

    for (const highlightRect of highlightRects) {
      const size = highlightRect.getSize()
      if (size.x <= EPSILON || size.y <= EPSILON) continue

      const center = highlightRect.getCenter()
      out.centerX = center.x - this.textOffsetX
      out.centerY = center.y - this.textOffsetY
      out.width = size.x
      out.height = size.y
      return "measured"
    }
    return "none"
  }

  /**
   * Calculates the geometric rectangles for the selection.
   * Uses the Text component's native highlight rects so each visual run is handled by Lens.
   *
   * @param start - The start index of the selection
   * @param end - The end index of the selection
   * @returns The number of active highlight rectangles, or `null` when `Text.getHighlightRects` was
   * rate-limited this frame and no geometry could be read
   */
  private calculateSelectionRects(start: number, end: number): number | null {
    if (!this.resolveCharRange(start, end, this._charRange)) return 0
    const highlightRects = this.getHighlightRectsGuarded(this._charRange)
    if (highlightRects === null) return null

    let rectCount = 0
    for (const highlightRect of highlightRects) {
      const size = highlightRect.getSize()
      if (size.x <= EPSILON || size.y <= EPSILON) continue

      const center = highlightRect.getCenter()
      this.saveRectToPool(rectCount++, center.x - this.textOffsetX, center.y - this.textOffsetY, size.x, size.y)
    }

    return rectCount
  }

  /**
   * Resolves a cursor range to the UTF-16 character range `Text.getHighlightRects` expects. Nothing is
   * queried here, so a `false` result costs nothing to retry.
   *
   * @param out - Receives the ordered character range
   * @returns `false` when the range cannot be resolved: no cursor positions yet, an index outside them,
   * or a collapsed range
   */
  private resolveCharRange(startIndex: number, endIndex: number, out: CharRange): boolean {
    const text = this.textComponent.text
    const cursorPositions = this.cursorPositions
    if (!cursorPositions || cursorPositions.length === 0) return false

    const startCharIndex = getUtf16IndexFromCursorIndex(startIndex, cursorPositions, text)
    const endCharIndex = getUtf16IndexFromCursorIndex(endIndex, cursorPositions, text)
    if (startCharIndex === undefined || endCharIndex === undefined) return false

    const minCharIndex = Math.min(startCharIndex, endCharIndex)
    const maxCharIndex = Math.max(startCharIndex, endCharIndex)
    if (minCharIndex >= maxCharIndex) return false

    out.start = minCharIndex
    out.end = maxCharIndex
    return true
  }

  /**
   * Calls `Text.getHighlightRects` for a resolved character range. This is the only host call in the
   * renderer and it draws on the per-frame Text geometry budget, so callers query at most once per frame.
   *
   * @returns The native rects, or `null` when the call was rate-limited this frame
   */
  private getHighlightRectsGuarded(range: CharRange): ReadonlyArray<Rect> | null {
    try {
      return this.textComponent.getHighlightRects(range.start, range.end)
    } catch {
      // getHighlightRects has a per-frame rate limit and throws when it is exceeded; an uncaught throw
      // here aborts the hosting Lens app. Callers keep their previous state and retry on a later frame.
      return null
    }
  }

  private saveRectToPool(index: number, centerX: number, centerY: number, width: number, height: number): void {
    const leftX = centerX - width / 2
    const rightX = centerX + width / 2
    const handleAnchorY = centerY - height * LINE_CENTER_OFFSET_RATIO
    const rect = this.rectsPool[index]
    if (!rect) {
      this.rectsPool[index] = {centerX, centerY, width, leftX, rightX, handleAnchorY, height}
    } else {
      rect.centerX = centerX
      rect.centerY = centerY
      rect.width = width
      rect.leftX = leftX
      rect.rightX = rightX
      rect.handleAnchorY = handleAnchorY
      rect.height = height
    }
  }

  private applyRectToTransform(rect: HighlightRect, transform: Transform): void {
    this._highlightPosition.x = rect.centerX
    this._highlightPosition.y = rect.centerY
    this._highlightPosition.z = HIGHLIGHT_Z_OFFSET

    this._highlightScale.x = rect.width
    this._highlightScale.y = rect.height
    this._highlightScale.z = 1

    transform.setLocalPosition(this._highlightPosition)
    transform.setLocalScale(this._highlightScale)
  }

  /**
   * Retrieves a highlight object from the pool, creating a new one if necessary.
   *
   * @param index - The index of the highlight to retrieve
   * @returns The pooled highlight object
   */
  private getHighlightFromPool(index: number): PooledHighlight {
    // Expand pool if needed
    while (this.highlightPool.length <= index) {
      const obj = global.scene.createSceneObject(`Highlight_${this.highlightPool.length}`)
      obj.layer = this.highlightLayer.layer
      obj.setParent(this.highlightLayer)

      const rmv = obj.createComponent("RenderMeshVisual")
      rmv.mesh = UNIT_PLANE_MESH_ASSET
      if (this.highlightMaterial) {
        rmv.mainMaterial = this.highlightMaterial
      }
      rmv.setRenderOrder(this._renderOrder)

      obj.enabled = false
      rmv.enabled = false
      this.highlightPool.push({
        sceneObject: obj,
        transform: obj.getTransform(),
        rmv,
        active: false
      })
    }

    return this.highlightPool[index]
  }

  /**
   * Resets all highlight objects in the pool by disabling them.
   */
  private resetPool(): void {
    for (const obj of this.highlightPool) {
      if (obj.active) {
        if (!isNull(obj.sceneObject)) {
          obj.sceneObject.enabled = false
          obj.rmv.enabled = false
        }
        obj.active = false
      }
    }
  }

  /**
   * Hides the highlight.
   */
  public hide(): void {
    this.activeRects.length = 0
    this.resetPool()
  }

  /**
   * Destroys the highlight renderer and cleans up resources.
   */
  public destroy(): void {
    this.unsubscribes.forEach((unsub) => unsub())
    this.unsubscribes = []
    this.hide()
    if (!isNull(this.highlightLayer)) {
      this.highlightLayer.destroy()
    }
    this.highlightPool = []
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

  private setColor(color: vec4): void {
    this.highlightMaterial.mainPass.baseColor = color
  }
}

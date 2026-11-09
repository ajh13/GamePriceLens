import {FlexItem} from "../Components/Layout2D/Flex/FlexItem"
import {FlexLayout} from "../Components/Layout2D/Flex/FlexLayout"
import {FlexAlign, FlexAlignSelf, FlexDirection, FlexLayoutResult} from "../Components/Layout2D/Flex/FlexTypes"
import {RoundedRectangle} from "../Visuals/RoundedRectangle/RoundedRectangle"
import {createChildSceneObjectWithParentLayer} from "./SceneUtilities"

/**
 * Common item interface for {@link FlexContainer.applyNonStretchLayout}.
 * `DropdownItem` satisfies it structurally; other callers (e.g.
 * `ElementGroup`) build an ephemeral object that matches the shape.
 */
export interface FlexCellItem {
  width: number
  height: number
  element: {width: number; height: number} | null
  flexAlignSelf: FlexAlignSelf
  alignment: string
}

/**
 * Configuration for creating a FlexContainer's layout and background.
 */
export interface FlexContainerConfig {
  direction: FlexDirection
  alignItems: FlexAlign
  width: number
  height: number
  rowGap?: number
  columnGap?: number
  paddingLeft?: number
  paddingRight?: number
  autoDiscoverItems?: boolean
}

/**
 * A background segment: a SceneObject with a RoundedRectangle component.
 */
export interface BgSegment {
  object: SceneObject
  rect: RoundedRectangle
}

/**
 * FlexContainer — abstract base class that pairs a FlexLayout with a pool of
 * RoundedRectangle background segments. Extends BaseScriptComponent so that
 * concrete subclasses (ElementGroup, Dropdown) can use the @component decorator.
 *
 * Subclasses call `createFlexContainer()` during initialization and override
 * `onFlexLayoutComplete()` to implement their specific background update logic.
 */
export abstract class FlexContainer extends BaseScriptComponent {
  protected layoutObject!: SceneObject
  protected flexLayout!: FlexLayout
  protected bgSegments: BgSegment[] = []
  protected flexContainerLayoutReady: boolean = false

  private containerParent!: SceneObject

  /**
   * Creates the layout container SceneObject, FlexLayout component, and
   * wires up the onLayoutComplete callback.
   */
  protected createFlexContainer(parent: SceneObject, config: FlexContainerConfig): void {
    this.containerParent = parent
    // A created SceneObject lands on the default layer regardless of its parent;
    // copy the host's layer so the layout subtree renders with the host.
    this.layoutObject = createChildSceneObjectWithParentLayer("FlexContainerContent", parent)

    this.flexLayout = this.layoutObject.createComponent(FlexLayout.getTypeName()) as FlexLayout
    this.flexLayout.direction = config.direction
    this.flexLayout.alignItems = config.alignItems
    this.flexLayout.width = config.width
    this.flexLayout.height = config.height
    this.flexLayout.autoDiscoverItemsOnStart = config.autoDiscoverItems ?? true
    if (config.rowGap !== undefined) this.flexLayout.rowGap = config.rowGap
    if (config.columnGap !== undefined) this.flexLayout.columnGap = config.columnGap
    if (config.paddingLeft !== undefined) this.flexLayout.paddingLeft = config.paddingLeft
    if (config.paddingRight !== undefined) this.flexLayout.paddingRight = config.paddingRight

    this.flexLayout.onLayoutComplete.add((result: FlexLayoutResult) => {
      this.flexContainerLayoutReady = true
      this.onFlexLayoutComplete(result)
    })
  }

  /**
   * Ensures exactly `count` background segments exist. Creates new ones as needed,
   * hides extras, and shows active ones.
   */
  protected ensureBgSegmentCount(count: number, cornerRadius: number, enabled: boolean): void {
    while (this.bgSegments.length < count) {
      const obj = createChildSceneObjectWithParentLayer(
        "FlexContainerBg" + this.bgSegments.length,
        this.containerParent
      )
      const rect = obj.createComponent(RoundedRectangle.getTypeName()) as RoundedRectangle
      rect.cornerRadius = cornerRadius
      this.bgSegments.push({object: obj, rect})
    }
    for (let i = count; i < this.bgSegments.length; i++) {
      this.bgSegments[i].object.enabled = false
    }
    for (let i = 0; i < count; i++) {
      this.bgSegments[i].object.enabled = enabled
      this.bgSegments[i].rect.cornerRadius = cornerRadius
    }
  }

  /**
   * Called after every FlexLayout pass. Subclasses override to update
   * backgrounds from the layout result.
   */
  protected abstract onFlexLayoutComplete(result: FlexLayoutResult): void

  /**
   * When stretchToFill is off, the cell reserves the item's width/height space
   * but the element keeps its natural size. We use margins to pad the element
   * so the FlexItem handler doesn't resize it.
   *
   * When `item.width`/`item.height` is 0 (synthesized cell, no explicit size)
   * AND there's no `item.element`, we fall back to the FlexItem's
   * handler-resolved preferred size so non-VisualElement content (Text,
   * Image, custom widget) gets a natural cell instead of a 0×0 collapse.
   */
  protected applyNonStretchLayout(flexItem: FlexItem, item: FlexCellItem): void {
    const intrinsic = flexItem.measureIntrinsic().preferred
    const cellW = item.width > 0 ? item.width : intrinsic.width
    const cellH = item.height > 0 ? item.height : intrinsic.height
    const el = item.element
    const elW = el ? el.width : cellW
    const elH = el ? el.height : cellH
    const gapW = Math.max(0, cellW - elW)
    const gapH = Math.max(0, cellH - elH)

    flexItem.overrideWidth = elW
    flexItem.overrideHeight = elH
    flexItem.alignSelf = item.flexAlignSelf

    const align = item.alignment
    if (align === "Center") {
      flexItem.marginLeft = gapW / 2
      flexItem.marginRight = gapW / 2
    } else if (align === "Right") {
      flexItem.marginLeft = gapW
      flexItem.marginRight = 0
    } else {
      flexItem.marginLeft = 0
      flexItem.marginRight = gapW
    }
    flexItem.marginTop = gapH / 2
    flexItem.marginBottom = gapH / 2
  }

  /** Cleans up background segments, destroys the layout object, and resets state. */
  protected destroyFlexContainer(): void {
    for (const seg of this.bgSegments) {
      if (isNull(seg.object)) continue
      seg.object.destroy()
    }
    this.bgSegments = []
    if (this.layoutObject && !isNull(this.layoutObject)) {
      this.layoutObject.destroy()
    }
    this.flexContainerLayoutReady = false
  }
}

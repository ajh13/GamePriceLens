import {ToolbarItem} from "../Items/ToolbarItem"
import {ToolbarAttachmentPosition} from "../Types/ToolbarSchema"
import {ToolbarFactory} from "./ToolbarFactory"
import {ToolbarFlexItem} from "./ToolbarFlexItem"
import {computeAttachmentPosition, resolveAttachedItemSize} from "./ToolbarFlexMapping"
import {applyToolbarItemLayout} from "./ToolbarItemLayoutContract"

export class ToolbarAttachedItemPositioner {
  public constructor(private factory: ToolbarFactory) {}

  /**
   * Full setup for attached items: applies size, scale, render order, and layout callbacks.
   * Call this from layout (Toolbar.updateLayout) when the toolbar is fully rebuilt.
   * `attachedSizes` is the Toolbar's single per-rebuild size per attached item id
   * (keyed by {@link ToolbarItem.id}); the item is sized and reservation-matched
   * from this stored vec2. The target's final geometry is read only for placement.
   */
  public positionAttachedItems(items: ToolbarItem[], attachedSizes: Map<string, vec2>): void {
    items.forEach((item) => {
      const config = item.config
      if (!config.attachTo) {
        return
      }

      const targetItem = this.factory.getItem(config.attachTo)
      if (!targetItem) {
        return
      }

      const targetSize = targetItem.getAttachmentTargetSize()
      // Consume the Toolbar's stored size so render matches reservation exactly.
      // The fallback covers an attachment whose target is not an active flow item
      // (no stored entry, and no reservation either), preserving prior behavior.
      const itemSize = attachedSizes.get(item.id) ?? this.fallbackAttachedItemSize(item, targetSize)

      // A vertical attached Slider / TextField must rotate 90° like its flow
      // counterpart. configureItemFlex only runs for flow items, so the flip is
      // set here on the attached item's Content-child ToolbarFlexItem; the size
      // write below is swapped to match.
      const transpose = item.shouldTransposeLayout()
      if (item.contentObject) {
        const flexItem = item.contentObject.getComponent(ToolbarFlexItem.getTypeName()) as ToolbarFlexItem
        if (flexItem) {
          flexItem.transposeAxes = transpose
        }
      }

      const attachmentPosition = config.attachmentPosition ?? ToolbarAttachmentPosition.RIGHT
      const attachmentOffset = config.attachmentOffset ?? new vec2(0, 0)
      // Target geometry comes from the target's laid-out Content child (the flow
      // member the outer layout placed), not the anchor — the anchor stays pinned
      // at container-local origin for canonical items. Separator/Custom targets
      // have no Content child; their anchor carries the laid-out position.
      const targetPosition = targetItem.contentTransform
        ? targetItem.contentTransform.getLocalPosition()
        : targetItem.transform.getLocalPosition()
      const position = this.calculateAttachmentPosition(
        targetPosition,
        targetSize,
        itemSize,
        attachmentPosition,
        attachmentOffset
      )

      // position is where the attached item's Content center must land in the
      // shared container-local frame, but item.transform is the anchor and the
      // Content child sits at contentTransform's local offset relative to it.
      // Subtract that offset so the canonical Content z-offset (and any x/y
      // retained from a flow-to-attached transition) is not counted twice.
      // Separator/Custom have no Content child, so their anchor subtracts zero.
      // position is a fresh vec3 from computeAttachmentPosition, safe to mutate.
      if (item.contentTransform) {
        const contentOffset = item.contentTransform.getLocalPosition()
        position.x -= contentOffset.x
        position.y -= contentOffset.y
        position.z -= contentOffset.z
      }

      item.transform.setLocalPosition(position)

      // Attachment never picks a render order on its own — a consumer who wants
      // an attached item drawn above/below its target sets config.renderOrder.
      applyToolbarItemLayout(item, itemSize, transpose, config.renderOrder)

      if (item.onLayoutSizeApplied) {
        item.onLayoutSizeApplied()
      }
    })
  }

  // Size for an attachment with no stored entry (its target is not an active flow
  // item, so the Toolbar resolved no size and reserved nothing). Mirrors the flow
  // sizing contract against the placement target so such overlays still render.
  private fallbackAttachedItemSize(item: ToolbarItem, targetSize: vec2): vec2 {
    return resolveAttachedItemSize({
      sizeConfig: item.config.size,
      targetSize,
      direction: item.getToolbarDirection(),
      minSize: item.config.minSize,
      maxSize: item.config.maxSize
    })
  }

  private calculateAttachmentPosition(
    targetPosition: vec3,
    targetSize: vec2,
    itemSize: vec2,
    attachmentPosition: ToolbarAttachmentPosition,
    attachmentOffset: vec2
  ): vec3 {
    return computeAttachmentPosition(targetPosition, targetSize, itemSize, attachmentPosition, attachmentOffset)
  }
}

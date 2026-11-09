import {createChildSceneObjectWithParentLayer} from "../../../Utility/SceneUtilities"
import {ToolbarButton} from "../Items/ToolbarButton"
import {ToolbarCustomItem} from "../Items/ToolbarCustomItem"
import {ToolbarItem} from "../Items/ToolbarItem"
import {ToolbarSeparator} from "../Items/ToolbarSeparator"
import {ToolbarSlider} from "../Items/ToolbarSlider"
import {ToolbarTextField} from "../Items/ToolbarTextField"
import {ToolbarToggle} from "../Items/ToolbarToggle"
import {AnyToolbarItemConfig, ToolbarItemType, validateItemConfig} from "../Types/ToolbarSchema"

type ToolbarFactoryInput = {
  root: SceneObject
  /**
   * The toolbar's flat base render order, read at item creation. Every item
   * without an explicit `config.renderOrder` adopts it (defaults to 0).
   */
  baseRenderOrder?: () => number
}

// Local-Z of the Content child so canonical items sit ahead of the toolbar
// background plate. The flow layout writes the child's local x/y and preserves
// z, so this offset survives every layout pass (mirrors the legacy anchor
// ITEM_Z_OFFSET, which now lives on the Content child). Under the toolbar's
// Hierarchy Canvas tree order already draws items after the plate; this step
// (>= Z_LAYER_STEP) is what keeps a depth-tested item from being rejected
// against the plate, and what keeps the no-Canvas fallback correct by distance.
const CONTENT_Z_OFFSET = 0.1

// Item types whose canonical component is an Element and therefore owns its own
// size through the Content-child ElementHandler. Separator (RoundedRectangleVisual)
// and Custom (consumer object, never scaled) keep no Content-child Element.
const CANONICAL_CONTENT_TYPES: ReadonlySet<ToolbarItemType> = new Set([
  ToolbarItemType.BUTTON,
  ToolbarItemType.TEXTFIELD,
  ToolbarItemType.SLIDER,
  ToolbarItemType.TOGGLE
])

export class ToolbarFactory {
  private readonly root: SceneObject
  private readonly baseRenderOrder: () => number
  private createdItems: Map<string, ToolbarItem> = new Map()

  public constructor(input: ToolbarFactoryInput) {
    this.root = input.root
    this.baseRenderOrder = input.baseRenderOrder ?? (() => 0)
  }

  public createItem(config: AnyToolbarItemConfig): ToolbarItem {
    validateItemConfig(config)
    const id = config.id!

    if (this.createdItems.has(id)) {
      throw new Error(`Toolbar item with id '${id}' already exists`)
    }

    // A created SceneObject lands on the default layer regardless of parent;
    // copy the toolbar's so the item renders with the bar.
    const itemObject = createChildSceneObjectWithParentLayer(`ToolbarItem_${id}`, this.root)
    let item: ToolbarItem
    try {
      item = this.buildItem(itemObject, config)
    } catch (error) {
      // createdItems doesn't hold the object yet, so reset() would never reach it
      // and it would stay under the bar. Anything the item already adopted (a
      // custom item's object) is destroyed with it.
      itemObject.destroy()
      throw error
    }
    this.createdItems.set(id, item)
    if (config.onCreated) {
      config.onCreated(item)
    }

    return item
  }

  public getItem(id: string): ToolbarItem | undefined {
    return this.createdItems.get(id)
  }

  public hasItem(id: string): boolean {
    return this.createdItems.has(id)
  }

  public destroyItem(id: string): boolean {
    const item = this.createdItems.get(id)
    if (!item) {
      return false
    }

    item.sceneObject.destroy()
    this.createdItems.delete(id)
    return true
  }

  public reset(): void {
    this.createdItems.forEach((item) => {
      item.sceneObject.destroy()
    })
    this.createdItems.clear()
  }

  public getAllItems(): ToolbarItem[] {
    return Array.from(this.createdItems.values())
  }

  public getItemsMap(): ReadonlyMap<string, ToolbarItem> {
    return this.createdItems
  }

  private buildItem(itemObject: SceneObject, config: AnyToolbarItemConfig): ToolbarItem {
    let item: ToolbarItem

    switch (config.type) {
      case ToolbarItemType.BUTTON:
        item = itemObject.createComponent(ToolbarButton.getTypeName()) as ToolbarButton
        break
      case ToolbarItemType.SEPARATOR:
        item = itemObject.createComponent(ToolbarSeparator.getTypeName()) as ToolbarSeparator
        break
      case ToolbarItemType.TEXTFIELD:
        item = itemObject.createComponent(ToolbarTextField.getTypeName()) as ToolbarTextField
        break
      case ToolbarItemType.SLIDER:
        item = itemObject.createComponent(ToolbarSlider.getTypeName()) as ToolbarSlider
        break
      case ToolbarItemType.TOGGLE:
        item = itemObject.createComponent(ToolbarToggle.getTypeName()) as ToolbarToggle
        break
      case ToolbarItemType.CUSTOM:
        item = itemObject.createComponent(ToolbarCustomItem.getTypeName()) as ToolbarCustomItem
        break
      default:
        throw new Error(`Unknown toolbar item type: ${(config as any).type}`)
    }

    // Canonical items host their Element on a Content child so its own
    // ElementHandler owns size/apply; the anchor stays pinned at origin. Created
    // before initializeWithConfig so the wrapper builds its component on it.
    if (CANONICAL_CONTENT_TYPES.has(config.type)) {
      const contentObject = createChildSceneObjectWithParentLayer("Content", itemObject)
      contentObject.getTransform().setLocalPosition(new vec3(0, 0, CONTENT_Z_OFFSET))
      item.setContentObject(contentObject)
    }

    // The flat base order lands before the wrapper builds its component, so the
    // component and its companions are created at that order (invariant 4).
    item.setBaseRenderOrder(this.baseRenderOrder())
    item.initializeWithConfig(config)
    return item
  }
}

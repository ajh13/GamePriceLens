import {ContentMeasurement, ItemHandler, ItemHandlerRegistry, setLocalXY} from "../../Layout2D/ItemHandlerRegistry"
import {ToolbarItem} from "../Items/ToolbarItem"

function findToolbarItem(sceneObject: SceneObject): ToolbarItem | null {
  for (const c of sceneObject.getComponents("ScriptComponent")) {
    if (c instanceof ToolbarItem) {
      return c
    }
  }
  return null
}

// Positions only, and now only for Separator/Custom anchors. Canonical items
// (Button/Slider/Switch/TextInputField) host their Element on a Content child
// whose own ElementHandler owns size/apply, so their anchor carries no Element
// and never reaches this handler. Separator (RoundedRectangleVisual) and Custom
// (never-scaled consumer object) keep no Content child, so this handler resolves
// their anchor cell and places it without sizing.
const ToolbarItemHandler: ItemHandler = {
  name: "ToolbarItemHandler",

  canHandle(sceneObject: SceneObject): boolean {
    return findToolbarItem(sceneObject) !== null
  },

  resolveComponent(sceneObject: SceneObject): unknown {
    return findToolbarItem(sceneObject)
  },

  measure(_sceneObject: SceneObject, component: unknown, _transform: Transform): ContentMeasurement {
    const item = component as ToolbarItem | null
    const preferred = item && !isNull(item) ? item.intrinsicSize : vec2.zero()
    return {
      min: {width: 0, height: 0},
      preferred: {width: preferred.x, height: preferred.y},
      max: {width: Infinity, height: Infinity}
    }
  },

  apply(
    sceneObject: SceneObject,
    x: number,
    y: number,
    _width: number,
    _height: number,
    _component: unknown,
    transform: Transform
  ): void {
    setLocalXY(sceneObject, x, y, transform)
  }
}

// Above the content handlers (ElementHandler is 100) so a Separator or Custom
// anchor resolves here as a position-only cell and is never sized by a lower-
// priority visual handler. Canonical items keep no Element on the anchor, so
// only Separator/Custom reach this handler.
ItemHandlerRegistry.register(ToolbarItemHandler, 130)

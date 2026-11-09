// ═══════════════════════════════════════════════════════════════════════════
// UIKitItemHandlers.ts — UIKit-specific Layout2D ItemHandlers.
//
// Registers handlers for content types that exist only in UIKit:
// Element-derived components, Shape, ElementContent (standalone),
// FlexLayout/GridLayout containers, and CustomFlexContainer adapters.
//
// The split from ItemHandlerRegistry.ts is forward-looking — if/when
// the registry + native handlers (Text/Text3D, Image, BaseMeshVisual,
// ScreenTransform, BoxCollider) move to a shared engine-side module,
// this file stays in UIKit and registers on top.
//
// Pulled in via the side-effect import in UIKitBootstrap.ts (which every UIKit
// component imports). LayoutItem2D no longer imports this directly, so the
// engine + native registry stay UIKit-free.
// ═══════════════════════════════════════════════════════════════════════════

import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import {CustomFlexContainer} from "./CustomFlexContainer"
import {
  ContentMeasurement,
  FIT_CONTENT_PENDING,
  FitContentHeight,
  ItemHandler,
  ItemHandlerRegistry,
  rigidMeasurement,
  setLocalXY,
  Size
} from "./ItemHandlerRegistry"
import {UIKitBrands} from "./UIKitBrands"

const log = new NativeLogger("UIKitItemHandlers")

/** Auto-Resize content's natural size, independent of the Element's layout allocation. */
export const elementContentSizes = new WeakMap<object, Size>()

// ─── Brand-based finders ────────────────────────────────────────────────
//
// Each UIKit base class exposes `public readonly __uikitBrand: <const>`
// which subclasses inherit unchanged. The finders match on this brand
// instead of probing private property names — eliminates the silent
// collision where any user ScriptComponent with `{width, height,
// onSizeChanged}` was being treated as a UIKit Element.

function findByBrand(sceneObject: SceneObject, brand: string): any | null {
  for (const c of sceneObject.getComponents("ScriptComponent")) {
    const comp = c as any
    if (comp && comp.__uikitBrand === brand) {
      return comp
    }
  }
  return null
}

function findLayoutContainer(sceneObject: SceneObject): any | null {
  return findByBrand(sceneObject, UIKitBrands.LayoutContainer)
}

function findElement(sceneObject: SceneObject): any | null {
  return findByBrand(sceneObject, UIKitBrands.Element)
}

function findStandaloneContent(sceneObject: SceneObject): any | null {
  return findByBrand(sceneObject, UIKitBrands.ElementContent)
}

function findShape(sceneObject: SceneObject): any | null {
  return findByBrand(sceneObject, UIKitBrands.Shape)
}

function findCustomContainer(sceneObject: SceneObject): CustomFlexContainer | null {
  for (const c of sceneObject.getComponents("ScriptComponent")) {
    if (c instanceof CustomFlexContainer) {
      return c
    }
  }
  return null
}

// ─── Handlers ────────────────────────────────────────────────────────────

// Priority 120 — CustomFlexContainer is intended for atomic widgets that
// aggregate their own internal layout. If a LayoutContainer (FlexLayout /
// GridLayout) is also present on the same SceneObject the user has set up
// a conflict — CustomContainer wins by priority, but the user almost
// certainly didn't intend both. We warn once so the misconfig is visible.
const _customContainerWarned = new WeakSet<SceneObject>()
const CustomContainerHandler: ItemHandler = {
  name: "CustomContainerHandler",

  canHandle(sceneObject: SceneObject): boolean {
    const has = findCustomContainer(sceneObject) != null
    if (has && findLayoutContainer(sceneObject) !== null && !_customContainerWarned.has(sceneObject)) {
      _customContainerWarned.add(sceneObject)
      log.w(
        `${sceneObject.name} has both CustomFlexContainer and a Layout container ` +
          `(FlexLayout / GridLayout). CustomFlexContainer will be used for layout. ` +
          `Remove one of them — they are mutually exclusive at the same SceneObject.`
      )
    }
    return has
  },

  resolveComponent(sceneObject: SceneObject): any {
    return findCustomContainer(sceneObject)
  },

  measure(_sceneObject: SceneObject, component: any, _transform: Transform): ContentMeasurement {
    const comp = component as CustomFlexContainer
    if (!comp) {
      log.w("CustomContainerHandler.measure – component no longer found")
      return rigidMeasurement(1, 1)
    }
    const inner = comp.getHandler().measure() as any
    // Accept both the new three-value `ContentMeasurement` and the legacy
    // 2D `{width, height}` form for backward compat with existing
    // CustomFlexContainer subclasses.
    if (inner && inner.preferred && inner.min && inner.max) {
      return inner as ContentMeasurement
    }
    return rigidMeasurement(inner.width, inner.height)
  },

  apply(
    sceneObject: SceneObject,
    x: number,
    y: number,
    width: number,
    height: number,
    component: any,
    transform: Transform
  ): void {
    const comp = component as CustomFlexContainer
    if (!comp) {
      return
    }
    comp.getHandler().apply(x, y, width, height)
    setLocalXY(sceneObject, x, y, transform)
  }
}

// Priority 110: Layout containers (FlexLayout, GridLayout, etc.)
const LayoutContainerHandler: ItemHandler = {
  name: "LayoutContainerHandler",

  canHandle(sceneObject: SceneObject): boolean {
    return findLayoutContainer(sceneObject) !== null
  },

  resolveComponent(sceneObject: SceneObject): any {
    return findLayoutContainer(sceneObject)
  },

  measure(_sceneObject: SceneObject, component: any, _transform: Transform): ContentMeasurement {
    if (!component) {
      log.w("LayoutContainerHandler.measure – component no longer found")
      return rigidMeasurement(1, 1)
    }
    // One call returns all three intrinsic axes (preferred / min / max) sharing
    // the container's per-mode memo. Max is capped at Infinity when the inner
    // engine reports a non-finite result (flexible content).
    const sizes = component.computeContentSizeAllModes()
    const maxW = isFinite(sizes.max.width) ? sizes.max.width : Infinity
    const maxH = isFinite(sizes.max.height) ? sizes.max.height : Infinity
    return {
      min: {width: sizes.min.width, height: sizes.min.height},
      preferred: {width: sizes.preferred.width, height: sizes.preferred.height},
      max: {width: maxW, height: maxH},
      // Any of the three probes built on a placeholder → the parent must not
      // settle on these intrinsics either.
      pending: component.fitContentProbePending === true
    }
  },

  // Nested layouts are the other width-dependent content: a column of wrapped
  // text reports its wrapped height once the parent tells it how wide it is.
  measureHeightForWidth(
    _sceneObject: SceneObject,
    component: any,
    _transform: Transform,
    width: number
  ): FitContentHeight {
    if (!component || typeof component.computeContentHeightForWidth !== "function") return null
    const height = component.computeContentHeightForWidth(width)
    // A child still waiting on a rate-limited measure makes this answer
    // provisional too: surface pending so the parent retries next frame.
    if (component.fitContentProbePending === true) return FIT_CONTENT_PENDING
    return Number.isFinite(height) ? height : null
  },

  apply(
    sceneObject: SceneObject,
    x: number,
    y: number,
    width: number,
    height: number,
    component: any,
    transform: Transform
  ): void {
    if (component) {
      component.width = width
      component.height = height
      component.forceLayout()
    }
    setLocalXY(sceneObject, x, y, transform)
  }
}

// Priority 100: Layoutable components (Element, Shape, Frame, ScrollWindow, layouts)
const ElementHandler: ItemHandler = {
  name: "ElementHandler",

  canHandle(sceneObject: SceneObject): boolean {
    return findElement(sceneObject) !== null
  },

  resolveComponent(sceneObject: SceneObject): any {
    return findElement(sceneObject)
  },

  measure(_sceneObject: SceneObject, component: any, _transform: Transform): ContentMeasurement {
    if (!component) {
      log.w("ElementHandler.measure – component no longer found")
      return rigidMeasurement(1, 1)
    }
    // Flexible content: preferred = natural Auto-Resize content or declared size, min = 0 (can
    // shrink under flex pressure), max = Infinity (can grow when the parent
    // gives space via flex-grow or `flex-basis: max-content`). The previous
    // rigid-from-rigidMeasurement returned max = declared, which capped
    // max-content sizing at the author's number and made Elements behave
    // unlike CSS non-replaced elements.
    return {
      min: {width: 0, height: 0},
      preferred: elementContentSizes.get(component) ?? {width: component.width, height: component.height},
      max: {width: Infinity, height: Infinity}
    }
  },

  apply(
    sceneObject: SceneObject,
    x: number,
    y: number,
    width: number,
    height: number,
    component: any,
    transform: Transform
  ): void {
    if (component) {
      // One `size` write instead of the width-then-height pair: the width/height
      // setters route through `size`, so two writes fired onSizeChanged twice
      // with a transient `(newW, oldH)`. A single write of the component's own
      // size type (vec3 preserving z, or a vec2 like BackPlate's) drives its
      // size machinery once with the final size. Components without a `size`
      // accessor (Frame, ScrollWindow) keep the width-then-height pair.
      const current = component.size
      if (current != null && typeof current.z === "number") {
        component.size = new vec3(width, height, current.z)
      } else if (current != null && typeof current.y === "number") {
        component.size = new vec2(width, height)
      } else {
        component.width = width
        component.height = height
      }
    }
    setLocalXY(sceneObject, x, y, transform)
  }
}

// Priority 95: Standalone ElementContent (matched by brand via findStandaloneContent).
// Below Element (100) so companion-mode buttons use ElementHandler.
// Above Shape (90) so standalone content labels measure correctly.
const StandaloneContentHandler: ItemHandler = {
  name: "StandaloneContentHandler",

  canHandle(sceneObject: SceneObject): boolean {
    return findStandaloneContent(sceneObject) !== null
  },

  resolveComponent(sceneObject: SceneObject): any {
    return findStandaloneContent(sceneObject)
  },

  measure(_sceneObject: SceneObject, component: any, _transform: Transform): ContentMeasurement {
    if (!component) return rigidMeasurement(1, 1)
    return rigidMeasurement(component._sizeOverride.x, component._sizeOverride.y)
  },

  apply(
    sceneObject: SceneObject,
    x: number,
    y: number,
    _width: number,
    _height: number,
    _component: any,
    transform: Transform
  ): void {
    setLocalXY(sceneObject, x, y, transform)
  }
}

// Priority 90: Shape components (has _size vec2 + renderMeshVisual)
const ShapeHandler: ItemHandler = {
  name: "ShapeHandler",

  canHandle(sceneObject: SceneObject): boolean {
    return findShape(sceneObject) !== null
  },

  resolveComponent(sceneObject: SceneObject): any {
    return findShape(sceneObject)
  },

  measure(_sceneObject: SceneObject, component: any, _transform: Transform): ContentMeasurement {
    if (!component) {
      log.w("ShapeHandler.measure – component no longer found")
      return rigidMeasurement(1, 1)
    }
    return rigidMeasurement(component.width ?? component._size.x, component.height ?? component._size.y)
  },

  apply(
    sceneObject: SceneObject,
    x: number,
    y: number,
    width: number,
    height: number,
    component: any,
    transform: Transform
  ): void {
    if (component) {
      if ("width" in component) component.width = width
      if ("height" in component) component.height = height
    }
    setLocalXY(sceneObject, x, y, transform)
  }
}

// ─── Register UIKit handlers ─────────────────────────────────────────────

ItemHandlerRegistry.register(CustomContainerHandler, 120)
ItemHandlerRegistry.register(LayoutContainerHandler, 110)
ItemHandlerRegistry.register(ElementHandler, 100)
ItemHandlerRegistry.register(StandaloneContentHandler, 95)
ItemHandlerRegistry.register(ShapeHandler, 90)

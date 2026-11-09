/**
 * Draw-order layering helpers for components on the Canvas + hierarchy model.
 *
 * Under a Hierarchy-sorting Canvas every renderable a component owns sits at ONE
 * flat renderOrder and tree order is the z-order. Two things still need a small
 * local +Z step between coplanar layers:
 *  - opaque layers that both write depth (a fill over a body): draw order alone
 *    does not decide — the later layer must also be the nearer one for the depth
 *    test, or it is rejected;
 *  - the no-Canvas fallback: equal-order quads distance-sort, and the step turns
 *    "random" into "correct by distance".
 *
 * Deliberately import-free: UIKitUtilities.ts must stay an import leaf, and a
 * Visuals import from a shared utility crashes 36 entry points at lens load.
 */

/**
 * Minimum +Z step, in cm, between coplanar layers. 0.05 cm is the smallest step
 * that stays clear of z-fighting at panel distance (RadioButton's recorded
 * figure); anything smaller is cosmetic, not a depth-test guarantee.
 */
export const Z_LAYER_STEP: number = 0.05

/** Local Z for the `index`-th layer above the base (index 1 = first layer). */
export function stackLayerZ(index: number): number {
  return index * Z_LAYER_STEP
}

/**
 * Puts every renderable at the same flat order; null/destroyed entries are skipped.
 * `renderOrder` lives on Lens Studio's Visual base, so any mesh visual qualifies —
 * RenderMeshVisual, Image, Text. (A UIKit Shape should go through its own
 * `renderOrder` setter instead, which keeps the Shape's cached order in step.)
 */
export function applyFlatRenderOrder(renderables: readonly (BaseMeshVisual | null)[], order: number): void {
  for (const renderable of renderables) {
    if (renderable && !isNull(renderable)) {
      renderable.renderOrder = order
    }
  }
}

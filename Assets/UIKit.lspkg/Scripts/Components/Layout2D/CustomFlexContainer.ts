import {ContentMeasurement} from "./ItemHandlerRegistry"

/**
 * Adapter returned by {@link CustomFlexContainer} to bridge a custom component
 * into the Layout2D measurement and apply pipeline.
 *
 * `measure()` returns the same `{min, preferred, max}` triple that
 * `ItemHandler.measure()` returns — so a CustomFlexContainer is a
 * first-class participant in CSS intrinsic sizing (`min-content`,
 * `max-content`, `min-width: auto`).
 *
 * **Legacy callers:** Returning `{width, height}` is also accepted (the
 * registry wrapper auto-promotes it to `rigidMeasurement(width, height)`).
 * Prefer the three-value form for new code so the composite can opt into
 * shrinking / growing under flex pressure.
 *
 * @example
 * ```ts
 * class LabeledSlider extends CustomFlexContainer {
 *   getHandler(): CustomFlexContainerHandler {
 *     return {
 *       measure: () => ({
 *         min: {width: 4, height: 1.5},      // shrink floor: knob + tiny label
 *         preferred: {width: 12, height: 2}, // natural slider + label
 *         max: {width: 24, height: 2}        // grows to fill but caps wide
 *       }),
 *       apply: (x, y, w, h) => this.layoutInternals(x, y, w, h)
 *     }
 *   }
 * }
 * ```
 */
export interface CustomFlexContainerHandler {
  /**
   * Reports the component's intrinsic size in the parent layout's local
   * space. Returns either a {@link ContentMeasurement} triple or — for
   * legacy callers — a plain `{width, height}` which is treated as
   * `min = 0, preferred = max = {width, height}`.
   */
  measure(): ContentMeasurement | {width: number; height: number}

  /**
   * Applies the layout result in parent-local coordinates.
   * @param x - Center X position in the parent layout's local space.
   * @param y - Center Y position in the parent layout's local space.
   * @param width - Allocated width in local-space units.
   * @param height - Allocated height in local-space units.
   */
  apply(x: number, y: number, width: number, height: number): void
}

/**
 * Base class for custom components that want to participate in Layout2D as a
 * single measurable/appliable item without exposing their internal structure.
 *
 * Use this when you're building a *composite widget* — a thing that has its
 * own internal layout but participates in a parent flex/grid as one atomic
 * item with its own size contract. Examples: a labeled slider, a search
 * field with icon + input + clear button, a tab strip with custom underline.
 */
export abstract class CustomFlexContainer extends BaseScriptComponent {
  /**
   * Returns the handler used by Layout2D to measure and position this component.
   */
  public abstract getHandler(): CustomFlexContainerHandler
}

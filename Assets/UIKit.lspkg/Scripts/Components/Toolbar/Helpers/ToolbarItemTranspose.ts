// Pure axis-transpose primitives for toolbar items whose content is rotated 90°
// relative to the toolbar's layout axes (vertical slider / text field). No Lens
// Studio dependencies so the transpose contract stays unit-testable headlessly.
//
// A ToolbarFlexItem overriding LayoutItem2D.toLayoutMeasurement calls
// transposeContentMeasurement so the canonical ItemHandler's measurement is
// expressed in layout axes before the override/min/max merge. The apply-side
// axis swap uses the scalar LayoutItem2D.handlerApplyWidth/Height hooks directly
// (a single dimension each), so no allocation-bearing size primitive is needed.

import type {ContentMeasurement} from "../../Layout2D/ItemHandlerRegistry"

/**
 * Inverts an intrinsic aspect ratio (`width / height` → `height / width`) for a
 * 90° axis transpose. Only a finite, positive ratio is inverted; `undefined`, `0`,
 * negative (the "disabled" sentinel), and non-finite values pass through unchanged
 * so the tri-state semantics in {@link LayoutItem2D.measureIntrinsic} are preserved.
 */
export function invertAspectRatio(aspectRatio: number | undefined): number | undefined {
  if (aspectRatio !== undefined && Number.isFinite(aspectRatio) && aspectRatio > 0) {
    return 1 / aspectRatio
  }
  return aspectRatio
}

/**
 * Returns a new {@link ContentMeasurement} with width and height swapped on each
 * of min / preferred / max, the aspect ratio inverted via {@link invertAspectRatio},
 * and `baseline` carried through unchanged (baseline has no meaning across a 90°
 * transpose for the toolbar's content types, which never report one). Pure: the
 * input is not mutated, so applying it twice yields a measurement equal to the
 * original.
 */
export function transposeContentMeasurement(measurement: ContentMeasurement): ContentMeasurement {
  return {
    min: {width: measurement.min.height, height: measurement.min.width},
    preferred: {width: measurement.preferred.height, height: measurement.preferred.width},
    max: {width: measurement.max.height, height: measurement.max.width},
    baseline: measurement.baseline,
    aspectRatio: invertAspectRatio(measurement.aspectRatio),
    pending: measurement.pending
  }
}

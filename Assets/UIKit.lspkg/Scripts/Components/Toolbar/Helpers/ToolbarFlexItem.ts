import {DegToRad} from "InteractionKit.lspkg/Utils/mathUtils"
import {FlexItem} from "../../Layout2D/Flex/FlexItem"
import type {ContentMeasurement} from "../../Layout2D/ItemHandlerRegistry"
import {transposeContentMeasurement} from "./ToolbarItemTranspose"

// Lazily constructed on first use and cached at module scope, so no quaternion or
// vec3 is built at module evaluation (CC16), on any layout/apply pass, or per
// instance — each rotation is created at most once across all ToolbarFlexItems.
let contentRotationTransposed: quat | null = null
let contentRotationIdentity: quat | null = null

function getContentRotationTransposed(): quat {
  return (contentRotationTransposed ??= quat.fromEulerVec(new vec3(0, 0, 90 * DegToRad)))
}

function getContentRotationIdentity(): quat {
  return (contentRotationIdentity ??= quat.fromEulerVec(new vec3(0, 0, 0)))
}

/**
 * FlexItem on a canonical toolbar item's Content child (Button, Slider, Switch,
 * or TextInputField). It leaves measurement and allocated-size application with
 * the content's own ItemHandler and only bends the axis-frame hooks
 * {@link LayoutItem2D} exposes, in two independent, mutually-exclusive modes:
 *
 * - {@link transposeAxes} (a vertical Slider / TextInputField): the content is
 *   rotated 90° relative to the toolbar's layout axes. {@link toLayoutMeasurement}
 *   transposes the handler's measurement into layout axes before the base
 *   override/min/max merge, and the scalar {@link handlerApplyWidth} /
 *   {@link handlerApplyHeight} hooks swap the allocation fed to `handler.apply`
 *   (allocation-free — a single dimension each). The 90° Content-object rotation
 *   is applied once, in the setter, from a shared lazily cached quaternion —
 *   never per layout pass.
 * - {@link applyWidthOverride} (the vertical FILL Toggle): the Switch must span
 *   the toolbar's content width while its cell stays a primary-axis grow member,
 *   so {@link handlerApplyWidth} returns the override and {@link handlerApplyHeight}
 *   returns the flex-allocated width.
 *
 * In both modes `fillInput` and `allocatedSize` stay inherited, so exported flex
 * input and the recorded allocation remain the logical flex cell in layout axes.
 */
@component
export class ToolbarFlexItem extends FlexItem {
  private _transposeAxes: boolean = false
  private _applyWidthOverride: number = -1

  /**
   * Whether this item's content is rotated 90° relative to the toolbar's layout
   * axes. Setting it rotates the Content SceneObject once and invalidates the
   * cached measurement so the next layout pass re-measures in the new frame.
   */
  public get transposeAxes(): boolean {
    return this._transposeAxes
  }

  public set transposeAxes(value: boolean) {
    if (this._transposeAxes === value) {
      return
    }
    this._transposeAxes = value
    // Rotate the Content SceneObject here (config-time), not in the per-layout
    // apply path; the quaternion is built at most once and cached at module scope.
    this.sceneObject
      .getTransform()
      .setLocalRotation(value ? getContentRotationTransposed() : getContentRotationIdentity())
    this.invalidateMeasure()
  }

  /**
   * Apply-time width the canonical component receives, or -1 for the flex-allocated
   * width (identity). Set >= 0 for the vertical FILL toggle: the Switch must span
   * the toolbar's content width while its cell stays a primary-axis grow member,
   * so `handler.apply` gets (override, allocated width) while measurement and
   * {@link allocatedSize} stay the logical flex cell. Apply-only (allocation-free,
   * a single stored scalar) — no re-measure; a re-layout is requested so the new
   * apply value lands. Mutually exclusive with {@link transposeAxes} (the toggle
   * never transposes). Reset to -1 by the toolbar each layout pass, so a direction
   * or config change that stops needing it restores identity.
   */
  public get applyWidthOverride(): number {
    return this._applyWidthOverride
  }

  public set applyWidthOverride(value: number) {
    const next = value >= 0 ? value : -1
    if (this._applyWidthOverride === next) {
      return
    }
    this._applyWidthOverride = next
    this._parentLayout?.markDirty()
  }

  protected override toLayoutMeasurement(measurement: ContentMeasurement): ContentMeasurement {
    return this._transposeAxes ? transposeContentMeasurement(measurement) : measurement
  }

  // A transposed item's "height" is the content's width; the fit-content pass
  // would measure the wrong axis, so it only runs in the untransposed frame.
  protected override supportsHeightForWidth(): boolean {
    return !this._transposeAxes
  }

  protected override handlerApplyWidth(width: number, height: number): number {
    if (this._applyWidthOverride >= 0) {
      return this._applyWidthOverride
    }
    return this._transposeAxes ? height : width
  }

  protected override handlerApplyHeight(width: number, height: number): number {
    if (this._applyWidthOverride >= 0) {
      // The flex-allocated width becomes the canonical height, matching the
      // pre-canonical getFinalLayoutSize(contentSpace.x, allocatedWidth).
      return width
    }
    return this._transposeAxes ? width : height
  }
}

import {OpacityControllable} from "../../Interfaces/OpacityControllable"
import {Shape} from "../Shape"

/**
 * A flat isosceles triangle (rounded apex) primitive Shape.
 *
 * The unit mesh has its base flat against y = 0 and the apex pointing toward
 * -Y, with the **local origin at the top-middle of the base** — i.e. the
 * natural attach point when joining this shape to another (e.g. a tooltip
 * bubble, popover, callout connector).
 *
 * Because the underlying mesh is unit-sized and the material is a trivial
 * solid-color shader (no SDF / size uniform), {@link size} stretches the
 * mesh by setting the SceneObject's local scale rather than mutating any
 * shader state. The Shape's reported {@link width}/{@link height} continue
 * to reflect the requested logical size for layout purposes.
 *
 * Intended for compositional use; do not parent additional content under a
 * Triangle SceneObject — children would inherit the non-uniform local scale.
 */
@component
export class Triangle extends Shape implements OpacityControllable {
  @input("vec4", "{1,1,1,1}")
  @hint("Solid fill color of the triangle.")
  @widget(new ColorWidget())
  private _baseColor: vec4 = new vec4(1, 1, 1, 1)

  @input("float", "1")
  @widget(new SliderWidget(0, 1, 0.01))
  @hint("Opacity multiplier applied to the material.")
  private _opacity: number = 1.0

  private static _mesh: RenderMesh = requireAsset("../../../Meshes/Triangle.mesh") as RenderMesh
  private static _materialAsset: Material = requireAsset("../../../Materials/Triangle.mat") as Material

  protected get materialSource(): Material {
    return Triangle._materialAsset
  }

  /**
   * Solid fill color (premultiplied-auto blend, so alpha drives transparency).
   */
  public get baseColor(): vec4 {
    return this._baseColor
  }

  public set baseColor(color: vec4) {
    if (color === undefined) return
    this._baseColor = color
    this.applyMaterialColor()
  }

  /**
   * Opacity multiplier (0..1) applied on top of {@link baseColor}'s own alpha.
   *
   * Implementation note: {@link Triangle} is built on `ImageShader`, which
   * does NOT expose an `opacityFactor` uniform (unlike the `CollapsedSquircle`
   * shader used by `RoundedRectangle`). We therefore fold opacity into the
   * material's `baseColor.a`, relying on the `PremultipliedAlphaAuto` blend
   * mode to handle transparency correctly. The getter always returns a real
   * number — never reads back a non-existent uniform.
   */
  public get opacity(): number {
    return this._opacity
  }

  public set opacity(opacity: number) {
    if (opacity === undefined) return
    this._opacity = opacity
    this.applyMaterialColor()
  }

  protected configureMesh(): void {
    this._rmv.mesh = Triangle._mesh
    this.applyMaterialColor()
  }

  private applyMaterialColor(): void {
    if (!this._material) return
    const c = this._baseColor
    this._material.mainPass.baseColor = new vec4(c.x, c.y, c.z, c.w * this._opacity)
  }

  /**
   * The unit mesh measures 1×1 in local space; scale the SceneObject's
   * transform to project it to the requested width/height. Z scale is
   * pinned to 1 — depth is meaningless for this 2D primitive.
   */
  protected updateSize(): void {
    this._transform.setLocalScale(new vec3(this._size.x, this._size.y, 1))
  }
}

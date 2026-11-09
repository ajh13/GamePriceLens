import {Shape} from "../../../../Scripts/Visuals/Shape"

/**
 * The `Capsule` class represents a 3D capsule component in the scene. It extends the `BaseScriptComponent`
 * and provides functionality for rendering and customizing the capsule's appearance.
 *
 * @decorator `@component`
 */
@component
export class Capsule3D extends Shape {
  @input("vec4", "{.8,.8,.8,1.}")
  @widget(new ColorWidget())
  private _backgroundColor: vec4

  private static _mesh: RenderMesh = requireAsset("../../../../Meshes/DefaultCapsule.mesh") as RenderMesh
  private static _materialAsset: Material = requireAsset("../../../../Materials/DefaultCapsule.mat") as Material

  /**
   * Gets the background color of the capsule.
   *
   * @returns {vec4} The current background color as a vec4.
   */
  public get backgroundColor(): vec4 {
    return this._backgroundColor
  }

  /**
   * Sets the background color of the capsule.
   *
   * @param value - A `vec4` representing the RGBA color to set as the background color.
   */
  public set backgroundColor(value: vec4) {
    if (value === undefined) {
      return
    }
    this._backgroundColor = value
    if (this._initialized) {
      this._material.mainPass.baseColor = value
    }
  }

  protected get materialSource(): Material {
    return Capsule3D._materialAsset
  }

  protected configureMesh(): void {
    // setup mesh
    this._rmv.mesh = Capsule3D._mesh
    this._rmv.mainPass.frustumCullMode = FrustumCullMode.UserDefinedAABB

    // Initializing Background Color
    this._material.mainPass.baseColor = this._backgroundColor
  }

  protected updateSize(): void {
    if (this.renderMeshVisual.mainPass) {
      const scale = new vec3(this._size.x, this._size.y, this._depth)
      this.renderMeshVisual.mainPass.size = scale

      // Update frustum culling bounds based on desired size
      this.renderMeshVisual.mainPass.frustumCullMode = FrustumCullMode.UserDefinedAABB
      this.renderMeshVisual.mainPass.frustumCullMin = new vec3(-this._size.x / 2, -this._size.y / 2, -this._depth / 2)
      this.renderMeshVisual.mainPass.frustumCullMax = new vec3(this._size.x / 2, this._size.y / 2, this._depth / 2)
    }
  }
}

import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import {Shape} from "../../../../Scripts/Visuals/Shape"
import {isEqual} from "../../../Utility/UIKitUtilities"

const log = new NativeLogger("Sphere")

/**
 * The `Sphere` class represents a 3D sphere component in the scene. It extends the `BaseScriptComponent`
 * and provides functionality for rendering and customizing the sphere's appearance.
 *
 * @decorator `@component`
 */
@component
export class Sphere extends Shape {
  @input
  @hint("Size of Sphere In Local Space Units")
  private _radius: number = 4

  @input("vec4", "{.8,.8,.8,1.}")
  @widget(new ColorWidget())
  private _backgroundColor: vec4

  @input
  @allowUndefined
  private _icon: Texture

  private static _mesh: RenderMesh = requireAsset("../../../../Meshes/DefaultSphere.mesh") as RenderMesh
  private static _materialAsset: Material = requireAsset("../../../../Materials/DefaultSphereSimple.mat") as Material

  private _zBackScale: number = 1.0

  protected get materialSource(): Material {
    return Sphere._materialAsset
  }

  /**
   * Gets the radius of the sphere.
   *
   * @returns {number} The radius of the sphere in local space units.
   */
  public get radius(): number {
    return this._radius
  }

  /**
   * Sets the radius of the sphere by updating its transform's local scale.
   *
   * @param radius - A `number` object representing the new radius of the sphere
   */
  public set radius(radius: number) {
    if (radius === undefined) {
      return
    }
    this._radius = radius
    const localScale = vec3.one().uniformScale(radius)
    this._transform.setLocalScale(localScale)
    if (this._initialized) {
      if (this.renderMeshVisual.mainPass) {
        this.renderMeshVisual.mainPass.frustumCullMin = localScale.uniformScale(-0.5)
        this.renderMeshVisual.mainPass.frustumCullMax = localScale.uniformScale(0.5)
      }
    }
  }

  /**
   * Gets the scale factor for the back of the sphere along the Z-axis.
   *
   * @returns {number} The scale factor for the back of the sphere.
   */
  public get zBackScale(): number {
    return this._zBackScale
  }

  /**
   * Sets the scale factor for the back of the sphere along the Z-axis.
   *
   * @param zBackScale - A number representing the scale factor for the back of the sphere.
   *                     A value closer to 0.0 makes the back of the sphere flatter,
   *                     while a value closer to 1.0 retains its original shape.
   */
  public set zBackScale(zBackScale: number) {
    if (zBackScale === undefined) {
      return
    }
    if (isEqual<number>(this._zBackScale, zBackScale)) {
      return
    }
    this._zBackScale = zBackScale
    if (this._initialized) {
      this._rmv.setBlendShapeWeight("Z depth", 1.0 - zBackScale)
    }
  }

  /**
   * Gets the background color of the sphere.
   *
   * @returns {vec4} The current background color as a vec4.
   */
  public get backgroundColor(): vec4 {
    return this._backgroundColor
  }

  /**
   * Sets the background color of the sphere.
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

  /**
   * Gets the icon texture of the sphere.
   *
   * @returns {Texture} The icon texture of the sphere, or undefined if there is none.
   */
  public get icon(): Texture | undefined {
    return this._icon
  }

  /**
   * Sets the icon texture of the sphere.
   *
   * @param icon - The icon texture to set.
   */
  public set icon(icon: Texture | undefined) {
    this._icon = icon
    if (this._initialized) {
      if (icon) {
        this._material.mainPass.hasIcon = 1
        this._material.mainPass.icon = icon
      } else {
        this._material.mainPass.hasIcon = 0
      }
    }
  }

  protected configureMesh(): void {
    // setup mesh
    this._rmv.mesh = Sphere._mesh
    this._rmv.mainPass.frustumCullMode = FrustumCullMode.UserDefinedAABB

    // Initializing Background Color
    this._material.mainPass.baseColor = this._backgroundColor

    // Initializing Icon
    if (this._icon) {
      this._material.mainPass.hasIcon = 1
      this._material.mainPass.icon = this._icon
    } else {
      this._material.mainPass.hasIcon = 0
    }
  }

  /**
   * Gets the size of the sphere.
   *
   * @returns A `vec2` representing the dimensions of the sphere.
   */
  public get size(): vec2 {
    const diameter = this._radius * 2
    return new vec2(diameter, diameter)
  }

  /**
   * Sets the size of the sphere.
   *
   * @param value - A `vec2` representing the dimensions of the sphere.
   */
  public set size(value: vec2) {
    if (value === undefined) {
      return
    }
    this._radius = value.x / 2
    super.size = value
  }

  public get depth(): number {
    return this._radius * 2
  }

  public set depth(depth: number) {
    log.d("Setting Sphere depth is not supported, please use size or radius instead")
  }

  protected updateSize(): void {
    const localScale = vec3.one().uniformScale(this._radius)
    this._transform.setLocalScale(localScale)
    this._rmv.mainPass.frustumCullMin = localScale.uniformScale(-0.5)
    this._rmv.mainPass.frustumCullMax = localScale.uniformScale(0.5)
    this._rmv.setBlendShapeWeight("Z depth", 1.0 - this._zBackScale)
  }
}

import {Shape} from "../Shape"

/**
 * Geometric AA margin (centimeters) added around the analytic ring on both
 * the radial and angular axes. The fragment SDF antialiases with `fwidth`,
 * so the mesh only needs to *cover* about one screen pixel beyond the crisp
 * edge; 0.15 cm is comfortably past 1 px at typical UI distances.
 */
const AA_PAD_CM = 0.15

/**
 * Floor for the antialiasing half-width (centimeters). The fragment SDF
 * antialiases over `max(edgeSoftness, half a screen pixel via fwidth)`, so
 * this only matters extremely close up; the geometric band ({@link
 * AA_PAD_CM}) must always cover the soft edge.
 */
const EDGE_SOFTNESS_CM = 0.01

/**
 * Floor for the ring thickness (centimeters) — the SDF degenerates if the
 * band collapses to zero width.
 */
const MIN_THICKNESS_CM = 0.01

const HALF_PI = Math.PI / 2

/**
 * A circular arc / ring primitive Shape — the render layer of the Spinner
 * (circle loader) component, also usable standalone.
 *
 * The underlying mesh (`Meshes/RingStrip.mesh`) is a flat 64-segment unit
 * strip; `SpinnerVertex.customCode` bends it to exactly the visible arc from
 * uniforms each frame, and `SpinnerFragment.customCode` cuts the analytic
 * shape (band edges + rounded end caps) per pixel with an SDF. Nothing here
 * scales the transform — {@link size} and {@link thickness} drive shader
 * uniforms in local-space centimeters, so fragments are paid only over the
 * lit arc and edges stay crisp at any size.
 *
 * Arc addressing: {@link setArc} takes the arc's *center* angle and *half*
 * aperture, both in radians (runtime angles are radians per the LS
 * convention). Angle 0 points along +X, angles increase counterclockwise; a
 * half-aperture of π renders the full ring (caps vanish automatically in
 * the SDF). The default state is a full ring so a standalone SpinnerVisual
 * dropped into a scene renders something sensible.
 */
@component
export class SpinnerVisual extends Shape {
  @input("float", "0.4")
  @hint("Ring thickness in centimeters.")
  private _thickness: number = 0.4

  @input("vec4", "{1,0,1,0.25}")
  @hint("Arc color at the tail end (gradient runs tail to head).")
  @widget(new ColorWidget())
  private _colorTail: vec4 = new vec4(1, 0, 1, 0.25)

  @input("vec4", "{0,1,1,1}")
  @hint("Arc color at the head end (gradient runs tail to head).")
  @widget(new ColorWidget())
  private _colorHead: vec4 = new vec4(0, 1, 1, 1)

  private static _mesh: RenderMesh = requireAsset("../../../Meshes/RingStrip.mesh") as RenderMesh
  private static _materialAsset: Material = requireAsset("../../../Materials/Spinner.mat") as Material

  // Arc state cached so pre-initialize writes survive until configureMesh().
  private _arcCenter: number = HALF_PI
  private _arcAperture: number = Math.PI
  private _arcFade: number = 0
  private _arcFadeLift: number = 0
  private _opacity: number = 1
  // The owner's opacity (Spinner.opacity), multiplied with the component's own fades.
  private _hostOpacity: number = 1

  // Preallocated scratch — setArc runs every frame while spinning, and the
  // color writes run every frame during whole-ring fades.
  private _arcScScratch = new vec2(0, 1)
  private _arcRotScratch = new vec2(1, 0)
  private _colorTailScratch = new vec4(0, 0, 0, 0)
  private _colorHeadScratch = new vec4(0, 0, 0, 0)
  private _cullMinScratch = new vec3(0, 0, 0)
  private _cullMaxScratch = new vec3(0, 0, 0)

  protected get materialSource(): Material {
    return SpinnerVisual._materialAsset
  }

  /**
   * Ring thickness in centimeters, measured radially. Clamped so the band
   * never exceeds the ring's outer radius (equal thickness and outer radius
   * renders a full disc).
   */
  public get thickness(): number {
    return this._thickness
  }

  public set thickness(value: number) {
    if (value === undefined || value === this._thickness) {
      return
    }
    this._thickness = value
    if (this._initialized) {
      this.applyGeometryUniforms()
    }
  }

  /**
   * Arc color at the tail end of the sweep.
   */
  public get colorTail(): vec4 {
    return this._colorTail
  }

  public set colorTail(color: vec4) {
    if (color === undefined) {
      return
    }
    this._colorTail = color
    this.applyColorUniforms()
  }

  /**
   * Arc color at the head end of the sweep.
   */
  public get colorHead(): vec4 {
    return this._colorHead
  }

  public set colorHead(color: vec4) {
    if (color === undefined) {
      return
    }
    this._colorHead = color
    this.applyColorUniforms()
  }

  /**
   * Fraction of the arc length over which each end fades to transparent
   * (0 = hard rounded ends, 0.5 = the fades meet mid-arc). Applied along
   * the arc on top of the tail-to-head color gradient.
   */
  public get arcFade(): number {
    return this._arcFade
  }

  public set arcFade(value: number) {
    if (value === undefined || value === this._arcFade) {
      return
    }
    this._arcFade = Math.min(Math.max(value, 0), 0.5)
    this.applyColorUniforms()
  }

  /**
   * Blends the end-fade envelope toward fully solid (0 = normal soft ends,
   * 1 = no fade anywhere) WITHOUT changing the fade's shape — the soft
   * valley floods up instead of the ends sharpening. Used by the
   * completion sequence to melt the closing seam soft-to-soft.
   */
  public get arcFadeLift(): number {
    return this._arcFadeLift
  }

  public set arcFadeLift(value: number) {
    if (value === undefined || value === this._arcFadeLift) {
      return
    }
    this._arcFadeLift = Math.min(Math.max(value, 0), 1)
    this.applyColorUniforms()
  }

  /**
   * Whole-arc opacity multiplier (0..1) — used by the component for the
   * start/stop fade. Folded into the color uniforms' alpha (the shader has
   * no separate opacity uniform).
   */
  public get opacity(): number {
    return this._opacity
  }

  public set opacity(value: number) {
    if (value === undefined || value === this._opacity) {
      return
    }
    this._opacity = Math.min(Math.max(value, 0), 1)
    this.applyColorUniforms()
  }

  /**
   * Opacity (0..1) the Spinner's owner applies on top of the component's own
   * start/stop fades, for example a panel fading out. Multiplied into the
   * same color alphas as {@link opacity}.
   */
  public get hostOpacity(): number {
    return this._hostOpacity
  }

  public set hostOpacity(value: number) {
    if (value === undefined || value === this._hostOpacity) {
      return
    }
    this._hostOpacity = Math.min(Math.max(value, 0), 1)
    this.applyColorUniforms()
  }

  /**
   * Positions the visible arc. Cheap enough to call every frame — writes
   * three shader uniforms and allocates nothing.
   *
   * @param centerRad - angle of the arc's center, radians, 0 along +X,
   *   counterclockwise positive.
   * @param apertureRad - HALF-aperture, radians, clamped to (0, π]. The arc
   *   spans `centerRad ± apertureRad`; π means the full ring (end caps
   *   disappear analytically — no branch, no seam).
   */
  public setArc(centerRad: number, apertureRad: number): void {
    this._arcCenter = centerRad
    this._arcAperture = Math.min(Math.max(apertureRad, 0), Math.PI)
    if (this._initialized) {
      this.applyArcUniforms()
    }
  }

  protected configureMesh(): void {
    this._rmv.mesh = SpinnerVisual._mesh
    this.applyArcUniforms()
    this.applyColorUniforms()
    // Geometry uniforms are applied by updateSize(), which Shape.initialize()
    // calls right after configureMesh().
  }

  /**
   * The mesh is repositioned entirely in the vertex shader, so size feeds
   * uniforms (and the culling AABB) instead of the transform's scale.
   */
  protected updateSize(): void {
    this.applyGeometryUniforms()
  }

  private applyArcUniforms(): void {
    if (!this._material) {
      return
    }
    // Trig of uniforms is precomputed here so the GPU never runs sin/cos of
    // a constant per vertex/pixel (~2.7x a multiply-add each on Adreno 621),
    // and the fragment's gradient divide ships as a reciprocal.
    const pass = this._material.mainPass
    pass.arcAperture = this._arcAperture
    const rot = this._arcCenter - HALF_PI
    this._arcRotScratch.x = Math.cos(rot)
    this._arcRotScratch.y = Math.sin(rot)
    pass.arcRot = this._arcRotScratch
    this._arcScScratch.x = Math.sin(this._arcAperture)
    this._arcScScratch.y = Math.cos(this._arcAperture)
    pass.arcSc = this._arcScScratch
    pass.arcGradInv = 1 / Math.max(2 * this._arcAperture, 1.0e-4)
  }

  private applyColorUniforms(): void {
    if (!this._material) {
      return
    }
    const pass = this._material.mainPass
    this._colorTailScratch.x = this._colorTail.x
    this._colorTailScratch.y = this._colorTail.y
    this._colorTailScratch.z = this._colorTail.z
    this._colorTailScratch.w = this._colorTail.w * this._opacity * this._hostOpacity
    pass.colorTail = this._colorTailScratch
    this._colorHeadScratch.x = this._colorHead.x
    this._colorHeadScratch.y = this._colorHead.y
    this._colorHeadScratch.z = this._colorHead.z
    this._colorHeadScratch.w = this._colorHead.w * this._opacity * this._hostOpacity
    pass.colorHead = this._colorHeadScratch
    pass.arcFade = this._arcFade
    pass.arcFadeLift = this._arcFadeLift
  }

  private applyGeometryUniforms(): void {
    if (!this._material) {
      return
    }
    const outerRadius = Math.min(this._size.x, this._size.y) / 2
    const thickness = Math.min(Math.max(this._thickness, MIN_THICKNESS_CM), outerRadius)
    const halfThickness = thickness / 2

    const pass = this._material.mainPass
    pass.ringRadius = outerRadius - halfThickness
    pass.halfThickness = halfThickness
    pass.aaPad = AA_PAD_CM
    pass.edgeSoftness = EDGE_SOFTNESS_CM

    // The strip's vertices start as a tiny unit quad; without a user AABB the
    // engine would cull against that, not the shader-inflated ring.
    const extent = outerRadius + AA_PAD_CM
    this._cullMinScratch.x = -extent
    this._cullMinScratch.y = -extent
    this._cullMinScratch.z = -AA_PAD_CM
    this._cullMaxScratch.x = extent
    this._cullMaxScratch.y = extent
    this._cullMaxScratch.z = AA_PAD_CM
    pass.frustumCullMode = FrustumCullMode.UserDefinedAABB
    pass.frustumCullMin = this._cullMinScratch
    pass.frustumCullMax = this._cullMaxScratch
  }
}

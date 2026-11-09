import {Shape} from "../Shape"

/**
 * Geometric AA margin (centimeters) added around the analytic bar on every
 * side. The fragment SDF antialiases with `fwidth`, so the quad only needs
 * to *cover* about one screen pixel beyond the crisp edge.
 */
const AA_PAD_CM = 0.05

/**
 * Floor for the antialiasing half-width (centimeters) — see SpinnerVisual.
 */
const EDGE_SOFTNESS_CM = 0.01

/**
 * The Loading Bar's render layer — a single quad whose fragment shader
 * draws the swept band (indeterminate) or the fill (determinate) as a light
 * FIELD: the band's own leading bloom and trailing falloff define its ends,
 * and the bar's extents are only a square bounding clip. There is no
 * silhouette, so there is no corner radius to tune. Nothing here scales the
 * transform: {@link size} drives shader uniforms in local-space centimeters
 * (the vertex stage inflates a unit quad), so edges stay crisp at any size,
 * and extra height buys the comet glow more room to bleed.
 *
 * The sweep itself is driven EXTERNALLY: the LoadingBar component points
 * Motion channels (`Channels.shaderFloat(visual.material, "headPos")` and
 * `"lagSpan"`) at the cloned material, each on its own tween — the head's
 * position and how far the trail hangs back behind it — so this class only
 * owns the static look uniforms.
 */
@component
export class LoadingBarVisual extends Shape {
  @input("vec4", "{0.25,0.95,0.85,0}")
  @hint("Sweep color at the trailing end.")
  @widget(new ColorWidget())
  private _colorTail: vec4 = new vec4(0.25, 0.95, 0.85, 0)

  @input("vec4", "{0.25,0.95,0.85,1}")
  @hint("Sweep color at the head (leading) end.")
  @widget(new ColorWidget())
  private _colorHead: vec4 = new vec4(0.25, 0.95, 0.85, 1)

  private static _materialAsset: Material = requireAsset("../../../Materials/LoadingBar.mat") as Material
  private static _quadMesh: RenderMesh | null = null

  // Uniform state cached so pre-initialize writes survive until configureMesh().
  // A resting pose rather than an empty span, so a standalone
  // LoadingBarVisual dropped into a scene renders something sensible (the
  // same courtesy SpinnerVisual's default full ring pays). The LoadingBar
  // component overwrites both as soon as a sweep or fill starts.
  private _headPos: number = 0.7
  private _lagSpan: number = 0.6
  private _solid: boolean = false
  private _glowShape: number = 0
  private _headSoftness: number = 0.3
  private _opacity: number = 1

  // Preallocated scratch (color writes run during fades).
  private _barSizeScratch = new vec2(1, 1)
  private _colorTailScratch = new vec4(0, 0, 0, 0)
  private _colorHeadScratch = new vec4(0, 0, 0, 0)
  private _cullMinScratch = new vec3(0, 0, 0)
  private _cullMaxScratch = new vec3(0, 0, 0)

  protected get materialSource(): Material {
    return LoadingBarVisual._materialAsset
  }

  /**
   * The cloned material whose `progress` uniform the LoadingBar component
   * drives through `Channels.shaderFloat`. Null before initialization.
   */
  public get material(): Material | null {
    return this._material ?? null
  }

  /**
   * Trailing color of the sweep gradient.
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
   * Head (leading) color of the sweep gradient.
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
   * Vertical glow falloff exponent: 0 lights the quad uniformly (thin line
   * variant); anything above 0 hugs the bottom edge and bleeds upward (pill
   * comet).
   */
  public get glowShape(): number {
    return this._glowShape
  }

  public set glowShape(value: number) {
    if (value === undefined || value === this._glowShape) {
      return
    }
    this._glowShape = value
    this.applyLookUniforms()
  }

  /**
   * Leading-edge bloom, as a fraction of the CURRENT lit span: how far ahead
   * of the head the light ramps in. 0 is a hard vertical cut; the comet's
   * soft head is the reason this exists. Being span-relative means a
   * squashed streak stays proportionally soft.
   */
  public get headSoftness(): number {
    return this._headSoftness
  }

  public set headSoftness(value: number) {
    if (value === undefined || value === this._headSoftness) {
      return
    }
    this._headSoftness = value
    this.applyLookUniforms()
  }

  /**
   * Determinate mode: the lit span becomes a flat fill instead of a
   * tail→head gradient, and the shader pins the trail's start at the bar's
   * left edge so `headPos` reads as the fill level.
   */
  public get solid(): boolean {
    return this._solid
  }

  public set solid(value: boolean) {
    if (value === undefined || value === this._solid) {
      return
    }
    this._solid = value
    if (this._material) {
      this._material.mainPass.solid = value ? 1 : 0
    }
  }

  /**
   * Parks the streak, for the mode switch and for pre-initialize writes:
   * `head` is 0..1 along the bar and `lag` is how far the trail hangs back
   * behind it. While a sweep or fill is running, Motion owns these uniforms.
   */
  public setSpan(head: number, lag: number): void {
    this._headPos = head
    this._lagSpan = lag
    if (this._material) {
      this._material.mainPass.headPos = head
      this._material.mainPass.lagSpan = lag
    }
  }

  /**
   * Whole-bar opacity multiplier (0..1) — the component's show/hide fade
   * target (an OpacityWriter, so Motion's alpha channel binds directly).
   */
  public get opacity(): number {
    return this._opacity
  }

  public set opacity(value: number) {
    if (value === undefined || value === this._opacity) {
      return
    }
    this._opacity = Math.min(Math.max(value, 0), 1)
    if (this._material) {
      this._material.mainPass.barOpacity = this._opacity
    }
  }

  protected configureMesh(): void {
    this._rmv.mesh = LoadingBarVisual.quadMesh()
    this.applyColorUniforms()
    this.applyLookUniforms()
    if (this._material) {
      this._material.mainPass.barOpacity = this._opacity
      this._material.mainPass.solid = this._solid ? 1 : 0
      this._material.mainPass.headPos = this._headPos
      this._material.mainPass.lagSpan = this._lagSpan
    }
    // Geometry uniforms are applied by updateSize(), which Shape.initialize()
    // calls right after configureMesh().
  }

  /**
   * The mesh is sized entirely in the vertex shader, so size feeds uniforms
   * (and the culling AABB) instead of the transform's scale.
   */
  protected updateSize(): void {
    this.applyGeometryUniforms()
  }

  private applyGeometryUniforms(): void {
    if (!this._material) {
      return
    }
    const pass = this._material.mainPass
    this._barSizeScratch.x = Math.max(this._size.x, 1.0e-4)
    this._barSizeScratch.y = Math.max(this._size.y, 1.0e-4)
    pass.barSize = this._barSizeScratch
    pass.aaPad = AA_PAD_CM
    pass.edgeSoftness = EDGE_SOFTNESS_CM

    // The quad's raw vertices are a unit square; without a user AABB the
    // engine would cull against that, not the shader-inflated bar.
    const halfW = this._barSizeScratch.x / 2 + AA_PAD_CM
    const halfH = this._barSizeScratch.y / 2 + AA_PAD_CM
    this._cullMinScratch.x = -halfW
    this._cullMinScratch.y = -halfH
    this._cullMinScratch.z = -AA_PAD_CM
    this._cullMaxScratch.x = halfW
    this._cullMaxScratch.y = halfH
    this._cullMaxScratch.z = AA_PAD_CM
    pass.frustumCullMode = FrustumCullMode.UserDefinedAABB
    pass.frustumCullMin = this._cullMinScratch
    pass.frustumCullMax = this._cullMaxScratch
  }

  private applyColorUniforms(): void {
    if (!this._material) {
      return
    }
    const pass = this._material.mainPass
    this._colorTailScratch.x = this._colorTail.x
    this._colorTailScratch.y = this._colorTail.y
    this._colorTailScratch.z = this._colorTail.z
    this._colorTailScratch.w = this._colorTail.w
    pass.colorTail = this._colorTailScratch
    this._colorHeadScratch.x = this._colorHead.x
    this._colorHeadScratch.y = this._colorHead.y
    this._colorHeadScratch.z = this._colorHead.z
    this._colorHeadScratch.w = this._colorHead.w
    pass.colorHead = this._colorHeadScratch
  }

  private applyLookUniforms(): void {
    if (!this._material) {
      return
    }
    const pass = this._material.mainPass
    pass.glowShape = this._glowShape
    pass.headSoftness = this._headSoftness
  }

  /**
   * Unit quad (positions ±0.5 in XY), shared by every LoadingBarVisual —
   * the vertex stage inflates it to the padded bar rect from uniforms.
   */
  private static quadMesh(): RenderMesh {
    if (LoadingBarVisual._quadMesh !== null) {
      return LoadingBarVisual._quadMesh
    }
    const builder = new MeshBuilder([
      {name: "position", components: 3},
      {name: "normal", components: 3},
      {name: "texture0", components: 2}
    ])
    builder.topology = MeshTopology.Triangles
    builder.indexType = MeshIndexType.UInt16
    const h = 0.5
    // prettier-ignore
    builder.appendVerticesInterleaved([
      -h, -h, 0, 0, 0, 1, 0, 0,
      h, -h, 0, 0, 0, 1, 1, 0,
      h, h, 0, 0, 0, 1, 1, 1,
      -h, h, 0, 0, 0, 1, 0, 1
    ])
    builder.appendIndices([0, 1, 2, 2, 3, 0])
    builder.updateMesh()
    LoadingBarVisual._quadMesh = builder.getMesh()
    return LoadingBarVisual._quadMesh
  }
}

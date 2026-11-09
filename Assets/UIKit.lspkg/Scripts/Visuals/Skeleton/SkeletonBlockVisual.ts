import {Shape} from "../Shape"

/** Geometric AA margin (centimeters) — see SpinnerVisual. */
const AA_PAD_CM = 0.05

/** Floor for the antialiasing half-width (centimeters). */
const EDGE_SOFTNESS_CM = 0.01

/** Spawn-time group-pulse parameterization for one block. */
export interface SkeletonPulseParams {
  /** Unit wave direction in group space. */
  bandDirX: number
  bandDirY: number
  /** dot(blockCenterInGroup, bandDir) − groupMin, cm. */
  blockProj: number
  /** 1 / (groupMax − groupMin), 1/cm. */
  spanInv: number
  /** waveDuration / wavePeriod — fraction of the loop the band spends crossing. */
  duty: number
  /** Band width as a fraction of the group span. */
  bandWidth: number
  /** Peak added brightness under the band. */
  waveBoost: number
  /** Post-pass afterglow brightness. */
  emberBoost: number
  /** Afterglow settle window, as a fraction of the period. */
  emberFall: number
  /** This block's clock offset in loop-phase units (hierarchy-depth cascade). */
  phaseDelay: number
  /** 1 = this block is PRESENT only while the wave is on it (alpha rides the
   * band + afterglow envelope); 0 = always present. Chrome passes 0, every
   * deeper block 1 — at idle only the top-level visual shows. */
  waveReveal: number
  /** Grouped alpha breathing range. */
  pulseMin: number
  pulseMax: number
}

/**
 * One generated skeleton placeholder block — a rounded-rect SDF quad whose
 * material carries the group-pulse parameterization: the shared `phase`
 * clock (fanned out by the Skeleton component), the wave direction, and
 * this block's own placement along the group span (`blockProj`, `spanInv`).
 *
 * Everything here is set ONCE at spawn by the Skeleton component; the only
 * per-frame write is the group's phase fan-out straight to the material
 * pass. Nothing scales the transform — {@link size} drives shader uniforms
 * in local-space centimeters.
 */
@component
export class SkeletonBlockVisual extends Shape {
  private static _materialAsset: Material = requireAsset("../../../Materials/SkeletonBlock.mat") as Material
  private static _quadMesh: RenderMesh | null = null

  // Uniform state cached so pre-initialize writes survive until configureMesh().
  private _baseColor: vec4 = new vec4(0.16, 0.18, 0.18, 1)
  private _cornerRadius: number = 0.6
  private _bandDirX: number = 1
  private _bandDirY: number = 0
  private _blockProj: number = 0
  private _spanInv: number = 1
  private _duty: number = 0.45
  private _bandWidth: number = 0.35
  private _waveBoost: number = 0.35
  private _emberBoost: number = 0.16
  private _emberFall: number = 0.26
  private _phaseDelay: number = 0
  private _waveReveal: number = 0
  private _pulseMin: number = 0.75
  private _pulseMax: number = 1
  private _opacity: number = 1

  private _barSizeScratch = new vec2(1, 1)
  private _bandDirScratch = new vec2(1, 0)
  private _cullMinScratch = new vec3(0, 0, 0)
  private _cullMaxScratch = new vec3(0, 0, 0)

  protected get materialSource(): Material {
    return SkeletonBlockVisual._materialAsset
  }

  /**
   * The cloned material whose `phase` uniform the Skeleton clock fan-out
   * writes every tick. Null before initialization.
   */
  public get material(): Material | null {
    return this._material ?? null
  }

  /**
   * Block fill color (the flat dark placeholder tone).
   */
  public get baseColor(): vec4 {
    return this._baseColor
  }

  public set baseColor(color: vec4) {
    if (color === undefined) {
      return
    }
    this._baseColor = color
    if (this._material) {
      this._material.mainPass.baseColor = color
    }
  }

  /**
   * Corner radius in centimeters (clamped by the shader to the block).
   */
  public get cornerRadius(): number {
    return this._cornerRadius
  }

  public set cornerRadius(value: number) {
    if (value === undefined || value === this._cornerRadius) {
      return
    }
    this._cornerRadius = value
    if (this._material) {
      this._material.mainPass.cornerRadius = value
    }
  }

  /**
   * Whole-block opacity multiplier (0..1) — the group's show/hide fade
   * target (an OpacityWriter for Motion's alpha channel).
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
      this._material.mainPass.blockOpacity = this._opacity
    }
  }

  /**
   * Sets the group-pulse parameterization in one call (spawn-time only).
   */
  public setPulseParams(params: SkeletonPulseParams): void {
    this._bandDirX = params.bandDirX
    this._bandDirY = params.bandDirY
    this._blockProj = params.blockProj
    this._spanInv = params.spanInv
    this._duty = params.duty
    this._bandWidth = params.bandWidth
    this._waveBoost = params.waveBoost
    this._emberBoost = params.emberBoost
    this._emberFall = params.emberFall
    this._phaseDelay = params.phaseDelay
    this._waveReveal = params.waveReveal
    this._pulseMin = params.pulseMin
    this._pulseMax = params.pulseMax
    this.applyPulseUniforms()
  }

  protected configureMesh(): void {
    this._rmv.mesh = SkeletonBlockVisual.quadMesh()
    this.applyPulseUniforms()
    if (this._material) {
      const pass = this._material.mainPass
      pass.baseColor = this._baseColor
      pass.cornerRadius = this._cornerRadius
      pass.blockOpacity = this._opacity
      pass.phase = 0
    }
  }

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
    pass.blockSize = this._barSizeScratch
    pass.aaPad = AA_PAD_CM
    pass.edgeSoftness = EDGE_SOFTNESS_CM

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

  private applyPulseUniforms(): void {
    if (!this._material) {
      return
    }
    const pass = this._material.mainPass
    this._bandDirScratch.x = this._bandDirX
    this._bandDirScratch.y = this._bandDirY
    pass.bandDir = this._bandDirScratch
    pass.blockProj = this._blockProj
    pass.spanInv = this._spanInv
    pass.duty = this._duty
    pass.bandWidth = this._bandWidth
    pass.waveBoost = this._waveBoost
    pass.emberBoost = this._emberBoost
    pass.emberFall = this._emberFall
    pass.phaseDelay = this._phaseDelay
    pass.waveReveal = this._waveReveal
    pass.pulseMin = this._pulseMin
    pass.pulseMax = this._pulseMax
  }

  /**
   * Unit quad (positions ±0.5 in XY), shared by every block — the vertex
   * stage inflates it to the padded block rect from uniforms.
   */
  private static quadMesh(): RenderMesh {
    if (SkeletonBlockVisual._quadMesh !== null) {
      return SkeletonBlockVisual._quadMesh
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
    SkeletonBlockVisual._quadMesh = builder.getMesh()
    return SkeletonBlockVisual._quadMesh
  }
}

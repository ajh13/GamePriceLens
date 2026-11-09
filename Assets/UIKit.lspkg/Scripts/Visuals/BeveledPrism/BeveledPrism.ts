import {PRISM_IDLE_COLORS, PRISM_REFLECTION_INTENSITY} from "../../Themes/System-3.0/Gradients/PrismPalette"
import {Shape} from "../Shape"

@component
export class BeveledPrism extends Shape {
  @input("vec2", "{8,4}")
  @hint("Size of Shape In Local Space Centimeters")
  protected _size: vec2 = new vec2(8, 4)

  @input
  protected _depth: number = 2.2

  @input("float", "0.5")
  @hint("Corner radius applied uniformly to all corners")
  private _cornerRadius: number = 0.5

  @input("float", "0.5")
  @hint("Bevel curve radius")
  private _bevelRadius: number = 0.5

  // Worst-case forward extrusion across all per-state values, used only
  // to widen the +Z frustum-cull AABB so the popped form doesn't get
  // clipped during a hover transition. Live extrusion is pushed via
  // `setFrontExtrusion`; this field is updated once on theme load (and
  // again if any per-state value changes at runtime).
  private _maxFrontExtrusion: number = 0

  private _opacity: number = 1
  // BeveledPrism.mat defaults to 0.8; configureMesh overwrites this when
  // Lens Studio exposes a numeric uniform readback on the cloned material.
  private _baseMaterialOpacity: number = 0.8

  private static _mesh: RenderMesh = requireAsset("../../../Meshes/BeveledPrism.mesh") as RenderMesh
  private static _materialAsset: Material = requireAsset("../../../Materials/BeveledPrism.mat") as Material

  protected get materialSource(): Material {
    return BeveledPrism._materialAsset
  }

  protected configureMesh(): void {
    this._rmv.mesh = BeveledPrism._mesh
    this._rmv.mainPass.frustumCullMode = FrustumCullMode.UserDefinedAABB

    this._baseMaterialOpacity =
      typeof this._material.mainPass.opacity === "number" ? this._material.mainPass.opacity : this._baseMaterialOpacity
    this._material.mainPass.targetSize = new vec3(this._size.x, this._size.y, this._depth)
    this._material.mainPass.cornerRadius = new vec4(
      this._cornerRadius,
      this._cornerRadius,
      this._cornerRadius,
      this._cornerRadius
    )
    this._material.mainPass.bevelRadius = this._bevelRadius
    this._material.mainPass.frontExtrusion = 0
    this._material.mainPass.faceBreathRotation = 0
    // Ray center (face space); doubles as the on/off gate (ray strength is
    // hardcoded in the shader). Default far off-face so a bare/idle prism
    // shows no ray; BeveledPrismVisual pushes the cursor position while
    // hovered. See BeveledPrismShader.
    this._material.mainPass.cursorOffset = new vec2(100, 100)
    // Beam axis default = the authored -20 deg tilt (cos/sin). While a hand
    // hovers, BeveledPrismVisual overwrites this per frame with the wrist's
    // projected knuckle line. See setRayAxis.
    this._material.mainPass.rayAxis = new vec2(0.93969, -0.34202)

    // Push the shared idle palette so a bare BeveledPrism gets the same
    // dark-glass look as a BeveledPrismVisual-wrapped button.
    this._material.mainPass.master0 = PRISM_IDLE_COLORS.master0
    this._material.mainPass.master1 = PRISM_IDLE_COLORS.master1
    this._material.mainPass.master2 = PRISM_IDLE_COLORS.master2
    this._material.mainPass.accent0 = PRISM_IDLE_COLORS.accent0
    this._material.mainPass.accent1 = PRISM_IDLE_COLORS.accent1
    this._material.mainPass.accent2 = PRISM_IDLE_COLORS.accent2
    this._material.mainPass.accent3 = PRISM_IDLE_COLORS.accent3

    // Demote the matcap to a subtle highlight on top of the fixed master
    // dome (see PRISM_REFLECTION_INTENSITY). Static, like the reference —
    // the reflection layer doesn't vary by state; the body palette does.
    // Overrides the .mat's "Intensity" so the look is guaranteed without a
    // Material Editor step.
    this._material.mainPass.reflIntensity = PRISM_REFLECTION_INTENSITY
    this.applyOpacity()
  }

  protected updateSize(): void {
    if (!this.renderMeshVisual?.mainPass) {
      return
    }

    this._material.mainPass.targetSize = new vec3(this._size.x, this._size.y, this._depth)

    const halfX = this._size.x * 0.5 + this._bevelRadius
    const halfY = this._size.y * 0.5 + this._bevelRadius
    const halfZ = this._depth * 0.5 + this._bevelRadius
    // Front-only padding: extrusion shifts +Z verts forward but anchors
    // -Z, so the AABB grows asymmetrically. -Z bound is unchanged.
    const frontPad = Math.max(0, this._maxFrontExtrusion)
    this.renderMeshVisual.mainPass.frustumCullMode = FrustumCullMode.UserDefinedAABB
    this.renderMeshVisual.mainPass.frustumCullMin = new vec3(-halfX, -halfY, -halfZ)
    this.renderMeshVisual.mainPass.frustumCullMax = new vec3(halfX, halfY, halfZ + frontPad)
  }

  public get cornerRadius(): number {
    return this._cornerRadius
  }

  public set cornerRadius(value: number) {
    if (value === undefined) {
      return
    }
    this._cornerRadius = value
    if (this._initialized) {
      this._material.mainPass.cornerRadius = new vec4(value, value, value, value)
    }
  }

  public get bevelRadius(): number {
    return this._bevelRadius
  }

  public set bevelRadius(value: number) {
    if (value === undefined) {
      return
    }
    this._bevelRadius = value
    if (this._initialized) {
      this._material.mainPass.bevelRadius = value
      this.updateSize()
    }
  }

  // Hot-path: called every frame during a per-state extrusion tween from
  // BeveledPrismVisual. Accepts negative values so the visual layer can
  // pull the front face back toward the anchored back face (PrismGhost
  // collapses to flat at idle). Visual-side clamps to [-depth, +inf) so
  // the front can never cross the back — this layer trusts the caller.
  public setFrontExtrusion(value: number): void {
    if (value === undefined) {
      return
    }
    if (this._initialized) {
      this._material.mainPass.frontExtrusion = value
    }
  }

  // Hot-path: called every frame during a per-state matcap-rotation tween.
  // Value is in degrees, rotates the matcap UV around (0.5, 0.5). Wraps
  // naturally — no clamp.
  public setMatcapRotation(value: number): void {
    if (value === undefined) {
      return
    }
    if (this._initialized) {
      this._material.mainPass.rotation = value
    }
  }

  // Hot-path: called every frame while a BeveledPrismVisual is tracking
  // the cursor. Vec2 in face space ([-0.5, 0.5] per axis); positions the
  // cursor-following ray's center. (0,0) = face center. No clamp — values
  // can briefly exceed the natural range during smoothing lerps.
  public setRayCenter(value: vec2): void {
    if (value === undefined) {
      return
    }
    if (this._initialized) {
      this._material.mainPass.cursorOffset = value
    }
  }

  // Hot-path: called every frame while a hand hovers. Direction of the
  // cursor ray in face space (cm); need not be unit — the shader
  // normalizes (and falls back to the authored -20 deg axis on degenerate
  // input). Sign irrelevant: the beam is symmetric around the cursor.
  public setRayAxis(value: vec2): void {
    if (value === undefined) {
      return
    }
    if (this._initialized) {
      this._material.mainPass.rayAxis = value
    }
  }

  // Hot-path: called every frame by BeveledPrismVisual's toggled-idle
  // breathing loop. Degrees; rotates the matcap on the flat Z faces only
  // (the shader masks by faceRegion). 0 = authored matcap position.
  public setFaceBreathRotation(value: number): void {
    if (value === undefined) {
      return
    }
    if (this._initialized) {
      this._material.mainPass.faceBreathRotation = value
    }
  }

  // Spinning bevel-edge highlight. Angle is in degrees (the band's rotating
  // position); strength gates it (0 = off). Wire both as material parameters in
  // the BeveledPrism graph (custom-code inputs edgeHighlightAngle / Strength).
  public setEdgeHighlightAngle(value: number): void {
    if (value === undefined) {
      return
    }
    if (this._initialized) {
      this._material.mainPass.edgeHighlightAngle = value
    }
  }

  public setEdgeHighlightStrength(value: number): void {
    if (value === undefined) {
      return
    }
    if (this._initialized) {
      this._material.mainPass.edgeHighlightStrength = value
    }
  }

  public get opacity(): number {
    return this._opacity
  }

  public set opacity(value: number) {
    if (value === undefined) {
      return
    }
    this._opacity = value
    if (this._initialized) {
      this.applyOpacity()
    }
  }

  // Cold-path: called once when theme/inputs settle. Recomputes the
  // frustum-cull AABB so the popped form doesn't get culled mid-tween.
  public get maxFrontExtrusion(): number {
    return this._maxFrontExtrusion
  }

  public set maxFrontExtrusion(value: number) {
    if (value === undefined) {
      return
    }
    this._maxFrontExtrusion = Math.max(0, value)
    if (this._initialized) {
      this.updateSize()
    }
  }

  private applyOpacity(): void {
    if (!this._material?.mainPass) {
      return
    }
    this._material.mainPass.opacity = this._baseMaterialOpacity * this._opacity
  }
}

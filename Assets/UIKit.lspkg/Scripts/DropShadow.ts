const SHADOW_MESH: RenderMesh = requireAsset("../Meshes/CollapsedSquircle.mesh") as RenderMesh
const SHADOW_MATERIAL: Material = requireAsset("../Materials/DropShadow.mat") as Material

/**
 * Renders a rounded-rectangle drop shadow with a dedicated minimal material
 * (DropShadow.mat). The CollapsedSquircle mesh provides the falloff for free:
 * its vertex alpha ramps 0 -> 1 across the corner-radius band and the fragment
 * fades the shadow out over the outer `spread` fraction of that band — no
 * gradient loops, no texture, no per-pixel vertex-code re-evaluation.
 *
 * Sizing follows CSS box-shadow semantics when `blur`/`spreadRadius` are used:
 * the shadow silhouette is the element rect grown by `spreadRadius`, with a
 * soft band `blur` wide centered on the silhouette edge, translated by
 * `offset`. The legacy `spread` fraction (0-1 of the corner-radius band) is
 * still honored when `blur` is unset.
 */
@component
export class DropShadow extends BaseScriptComponent {
  @input("int")
  private _renderOrder: number = 0

  @input
  private _size: vec2 = new vec2(3, 3)

  @input
  private _cornerRadius: number = 1.5

  // 5% gray (hsv 0,0,5) — the kit's standard shadow tint.
  @input("vec4", "{.05,.05,.05,.35}")
  @widget(new ColorWidget())
  private _color: vec4 = new vec4(0.05, 0.05, 0.05, 0.35)

  // Legacy 0-1 fraction of the corner-radius band. Still an @input so
  // serialized values on existing assets keep loading (and rendering through
  // the legacy model), but hidden from the inspector via ScriptInputsHidden —
  // `blur` (cm) is the authoring control. See the `spread` accessors.
  @input
  @widget(new SliderWidget(0.0, 1.0))
  private _spread: number = 0.5

  @input
  private _offset: vec2 = new vec2(0, 0)

  // Default 0 so pre-CSS serialized assets (which carry no _blur) resolve to
  // the legacy model and render exactly as before. A fresh component also
  // starts on the legacy default (spread 0.5 — the same soft look as ever);
  // setting any nonzero blur or spreadRadius opts into the CSS model. The
  // decorator-arg default is required: LS's importer does not reliably pick
  // up TS initializers for the serialized inspector default.
  @input("float", "0")
  private _blur: number = 0

  @input
  private _spreadRadius: number = 0

  private meshObject: SceneObject
  private rmv: RenderMeshVisual
  private material: Material
  private useCssModel: boolean = false
  private _opacity: number = 1
  private initialized: boolean = false

  /**
   * The size of the element casting the shadow.
   * @type {vec2}
   */
  public get size(): vec2 {
    return this._size
  }

  /**
   * The size of the element casting the shadow.
   * @param {vec2} value - The new size of the drop shadow.
   */
  public set size(value: vec2) {
    if (value === undefined) {
      return
    }
    this._size = value
    this.applyShapeUniforms()
  }

  /**
   * The corner radius of the drop shadow silhouette.
   * @type {number}
   */
  public get cornerRadius(): number {
    return this._cornerRadius
  }

  /**
   * The corner radius of the drop shadow silhouette.
   * @param {number} value - The new corner radius of the drop shadow.
   */
  public set cornerRadius(value: number) {
    if (value === undefined) {
      return
    }
    this._cornerRadius = value
    this.applyShapeUniforms()
  }

  /**
   * The color of the drop shadow.
   * @type {vec4}
   */
  public get color(): vec4 {
    return this._color
  }

  /**
   * The color of the drop shadow.
   * @param {vec4} value - The new color of the drop shadow.
   */
  public set color(value: vec4) {
    this._color = value
    if (this.initialized) {
      this.rmv.mainPass.shadowColor = value
    }
  }

  /**
   * The translation of the shadow relative to its owner, in world units (cm).
   * Mirrors CSS box-shadow offset-x / offset-y (y is up).
   * @type {vec2}
   */
  public get offset(): vec2 {
    return this._offset
  }

  /**
   * The translation of the shadow relative to its owner, in world units (cm).
   * @param {vec2} value - The new shadow offset.
   */
  public set offset(value: vec2) {
    if (value === undefined) {
      return
    }
    this._offset = value
    if (this.initialized) {
      const transform = this.meshObject.getTransform()
      const z = transform.getLocalPosition().z
      transform.setLocalPosition(new vec3(value.x, value.y, z))
    }
  }

  /**
   * CSS-style blur: the width of the soft falloff band in world units (cm),
   * centered on the shadow silhouette edge. Setting this switches the shadow
   * to the CSS sizing model; the legacy `spread` fraction is ignored while a
   * blur is active.
   * @type {number}
   */
  public get blur(): number {
    return this._blur
  }

  /**
   * CSS-style blur in world units (cm).
   * @param {number} value - The new blur band width.
   */
  public set blur(value: number) {
    if (value === undefined) {
      return
    }
    this._blur = value
    this.useCssModel = true
    this.applyShapeUniforms()
  }

  /**
   * CSS-style spread radius in world units (cm): grows (positive) or shrinks
   * (negative) the shadow silhouette relative to `size`. Only applied in the
   * CSS sizing model (once `blur` or `spreadRadius` has been set).
   * @type {number}
   */
  public get spreadRadius(): number {
    return this._spreadRadius
  }

  /**
   * CSS-style spread radius in world units (cm).
   * @param {number} value - The new spread radius.
   */
  public set spreadRadius(value: number) {
    if (value === undefined) {
      return
    }
    this._spreadRadius = value
    this.useCssModel = true
    this.applyShapeUniforms()
  }

  /**
   * The spread amount of the drop shadow as a 0-1 fraction of the
   * corner-radius band.
   * @deprecated Prefer the CSS-style `blur` / `spreadRadius` properties.
   * @type {number}
   */
  public get spread(): number {
    return this._spread
  }

  /**
   * The spread amount of the drop shadow as a 0-1 fraction of the
   * corner-radius band. Setting this switches back to the legacy sizing model.
   * @deprecated Prefer the CSS-style `blur` / `spreadRadius` properties.
   * @param {number} spread - The new spread amount of the drop shadow.
   */
  public set spread(spread: number) {
    if (spread === undefined) {
      return
    }
    this._spread = spread
    this.useCssModel = false
    this.applyShapeUniforms()
  }

  /**
   * A 0-1 multiplier on the shadow's outgoing alpha (the material's
   * `opacityFactor` uniform).
   * @type {number}
   */
  public get opacity(): number {
    return this._opacity
  }

  /**
   * A 0-1 multiplier on the shadow's outgoing alpha.
   * @param {number} value - The new opacity multiplier.
   */
  public set opacity(value: number) {
    if (value === undefined) {
      return
    }
    this._opacity = value
    if (this.initialized) {
      this.rmv.mainPass.opacityFactor = value
    }
  }

  /**
   * The render order of the shadow.
   */
  public get renderOrder(): number {
    return this._renderOrder
  }

  /**
   * The render order of the shadow.
   */
  public set renderOrder(value: number) {
    if (value === undefined) {
      return
    }
    this._renderOrder = value
    if (this.initialized) {
      this.rmv.renderOrder = value
    }
  }

  public get renderMeshVisual(): RenderMeshVisual {
    return this.rmv
  }

  public onAwake() {
    this.initialize()
    this.createEvent("OnEnableEvent").bind(() => {
      if (!isNull(this.rmv) && this.rmv) {
        this.rmv.enabled = true
      }
    })
    this.createEvent("OnDisableEvent").bind(() => {
      if (!isNull(this.rmv) && this.rmv) {
        this.rmv.enabled = false
      }
    })
    this.createEvent("OnDestroyEvent").bind(() => {
      if (!isNull(this.meshObject) && this.meshObject) {
        this.meshObject.destroy()
      }
      this.meshObject = null
      this.rmv = null
    })
  }

  /**
   * Initializes the drop shadow component: creates a child SceneObject holding
   * a RenderMeshVisual with the CollapsedSquircle mesh and a per-instance
   * clone of the dedicated DropShadow material.
   */
  public initialize() {
    if (this.initialized) {
      return
    }
    // Model selection is value-driven — a serialized flag can't distinguish
    // pre-CSS assets (a missing key deserializes to the default). Rule:
    // nonzero blur or spreadRadius = CSS model; otherwise the legacy spread
    // fraction applies, so old assets and untouched fresh components render
    // identically to the pre-CSS component.
    this.useCssModel = this._blur > 0 || this._spreadRadius !== 0

    this.meshObject = global.scene.createSceneObject(this.sceneObject.name + " Mesh")
    this.meshObject.layer = this.sceneObject.layer
    this.meshObject.setParent(this.sceneObject)
    this.meshObject.getTransform().setLocalPosition(new vec3(this._offset.x, this._offset.y, 0))

    this.rmv = this.meshObject.createComponent("RenderMeshVisual")
    this.rmv.mesh = SHADOW_MESH
    this.material = SHADOW_MATERIAL.clone()
    this.rmv.mainMaterial = this.material

    const pass = this.rmv.mainPass
    pass.blendMode = BlendMode.PremultipliedAlphaAuto
    pass.frustumCullMode = FrustumCullMode.UserDefinedAABB
    pass.colorMask = new vec4b(true, true, true, true)
    pass.depthTest = true
    pass.depthWrite = true
    pass.shadowColor = this._color
    pass.opacityFactor = this._opacity
    this.rmv.renderOrder = this._renderOrder

    this.initialized = true
    this.applyShapeUniforms()
  }

  /**
   * Resolves the mesh `size` / `cornerRadius` / `spread` uniforms (and the
   * matching frustum-cull bounds) from either the CSS model (blur/spread
   * radius in cm) or the legacy spread fraction.
   */
  private applyShapeUniforms(): void {
    if (!this.initialized) {
      return
    }
    let meshWidth: number
    let meshHeight: number
    let meshRadius: number
    let spreadFraction: number
    if (this.useCssModel) {
      meshWidth = Math.max(this._size.x + 2 * this._spreadRadius + this._blur, 0)
      meshHeight = Math.max(this._size.y + 2 * this._spreadRadius + this._blur, 0)
      meshRadius = Math.max(this._cornerRadius + this._spreadRadius + this._blur * 0.5, this._blur)
      // The CollapsedSquircle vertex clamps the radius to the FULL smallest
      // dimension, not half of it, so radii past half-height self-overlap the
      // corner arcs. Clamp to the geometrically valid pill radius here.
      meshRadius = Math.min(meshRadius, Math.min(meshWidth, meshHeight) * 0.5)
      spreadFraction = meshRadius > 0 ? Math.min(this._blur / meshRadius, 1) : 0
    } else {
      meshWidth = this._size.x
      meshHeight = this._size.y
      meshRadius = this._cornerRadius
      spreadFraction = this._spread
    }
    // Floor keeps the shader's smoothstep edges distinct — edge0 == edge1 is
    // undefined behavior in GLSL (division by zero on some GPUs). A 1e-4
    // fraction of the corner-radius band is far below a pixel.
    spreadFraction = Math.min(Math.max(spreadFraction, 0.0001), 1)
    const pass = this.rmv.mainPass
    pass.size = new vec2(meshWidth, meshHeight)
    pass.cornerRadius = meshRadius
    pass.spread = spreadFraction
    pass.frustumCullMin = new vec3(meshWidth * -0.5, meshHeight * -0.5, 0)
    pass.frustumCullMax = new vec3(meshWidth * 0.5, meshHeight * 0.5, 0)
  }
}

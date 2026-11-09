import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import {formatLensValue} from "../../Utility/UIKitUtilities"
import type {
  BaseGradientConfig,
  BaseGradientStopConfig,
  BaseRoundedRectangleConfig,
  BorderType,
  GradientParameters,
  GradientStop,
  GradientType,
  RoundedRectangleBaseType,
  TextureMode,
  TextureWrap
} from "./RoundedRectangleTypes"
import {
  isSharedDefaultBackgroundGradient,
  isSharedDefaultBorderGradient,
  RoundedRectBlendMode
} from "./RoundedRectangleTypes"
export type {BaseGradientConfig, BaseGradientStopConfig, BaseRoundedRectangleConfig} from "./RoundedRectangleTypes"

const log = new NativeLogger("RoundedRectangle")

type GradientUniformCache = {
  stops: number
  type: number
  startX: number
  startY: number
  endX: number
  endY: number
  colorsDirty: boolean
  percentsDirty: boolean
}

type ShapeState = {
  size: vec2
  cornerRadius: number
  blendMode: RoundedRectBlendMode
  opacity: number
}

type BackgroundState = {
  color: vec4
  gradient: boolean
  useTexture: boolean
  texture: Texture
  textureMode: TextureMode
  textureWrap: TextureWrap
}

type BorderState = {
  enabled: boolean
  size: number
  softness: number
  color: vec4
  type: BorderType
}

type UniformState = {
  borderEnabled: number
  gradient: GradientUniformCache
  borderGradient: GradientUniformCache
}

function createGradientUniformCache(): GradientUniformCache {
  return {
    stops: -1,
    type: -1,
    startX: NaN,
    startY: NaN,
    endX: NaN,
    endY: NaN,
    colorsDirty: true,
    percentsDirty: true
  }
}

/**
 * Material variant ladder rungs, leanest first. Each rung's shader simply
 * does not contain the features above it — no branch, no register/occupancy
 * presence tax (the branch-gated #7688 rig measured that tax directly: a
 * branch-off arm still cost measurably more than a shader without the code).
 */
type MaterialVariant = "solid" | "fill" | "full"

export class BaseRoundedRectangle {
  private static _mesh: RenderMesh | null = null
  private static _materialAsset: Material | null = null
  private static _fillMaterialAsset: Material | null = null
  private static _solidMaterialAsset: Material | null = null

  // Transient reused buffers, shared across instances - each update*Gradient call
  // fills then consumes them synchronously (single-threaded JS, no interleaving), so
  // they don't need to be per-instance.
  private static readonly gradientColorsScratch: vec4[] = []
  private static readonly gradientPercentsScratch: number[] = []
  private static readonly borderGradientColorsScratch: vec4[] = []
  private static readonly borderGradientPercentsScratch: number[] = []

  /** RenderMeshVisual driven by this rounded-rectangle renderer. */
  public readonly renderMeshVisual: RenderMeshVisual

  private _material: Material
  private readonly _shape: ShapeState
  private readonly _background: BackgroundState
  private _backgroundGradient: BaseGradientConfig
  private readonly _border: BorderState
  private _borderGradient: BaseGradientConfig
  private readonly _uniforms: UniformState
  private _initialized: boolean = false
  private _disposed: boolean = false

  // Material variant ladder: which rung is bound, the per-rung clones (made
  // lazily; most visuals only ever touch one), and whether the ladder runs
  // at all — disabled for consumers with bespoke materials.
  private _activeVariant: MaterialVariant = "full"
  private readonly _variantClones: Partial<Record<MaterialVariant, Material>> = {}
  private _useVariants: boolean = true

  // Render-only border visibility (see borderVisible). Unlike the `border`
  // setter this never mutates the authored borderSize, so hover-style
  // show/hide toggles survive round trips.
  private _borderVisible: boolean = true

  // Whether anything the stock shader draws can be seen: any fill or border alpha above
  // zero, or a texture. Opacity is left out on purpose: VisibilityGroup and other layers
  // write the pass opacity directly, so this class can't track it.
  private _contentVisible: boolean = true
  // Opt-in (see cullWhenTransparent): while nothing is visible, the pass's cull box is moved
  // out of view so the engine skips the draw. The cull box rather than `enabled`, because
  // VisibilityGroup and several components own `enabled` and would fight it.
  private _cullWhenTransparent: boolean = false
  private _cullIncludesOpacity: boolean = false
  private _culled: boolean = false

  /** Returns the shared rounded-rectangle mesh asset, loading it on first use. */
  public static getMesh(): RenderMesh {
    if (BaseRoundedRectangle._mesh === null) {
      BaseRoundedRectangle._mesh = requireAsset("../../../Meshes/CollapsedSquircle.mesh") as RenderMesh
    }
    return BaseRoundedRectangle._mesh
  }

  /** Returns the shared rounded-rectangle material asset, loading it on first use. */
  public static getMaterialAsset(): Material {
    if (BaseRoundedRectangle._materialAsset === null) {
      BaseRoundedRectangle._materialAsset = requireAsset("../../../Materials/CollapsedSquircle.mat") as Material
    }
    return BaseRoundedRectangle._materialAsset
  }

  /** Returns the shared material asset for a variant-ladder rung. */
  public static getVariantMaterialAsset(variant: MaterialVariant): Material {
    if (variant === "solid") {
      if (BaseRoundedRectangle._solidMaterialAsset === null) {
        BaseRoundedRectangle._solidMaterialAsset = requireAsset(
          "../../../Materials/CollapsedSquircleSolid.mat"
        ) as Material
      }
      return BaseRoundedRectangle._solidMaterialAsset
    }
    if (variant === "fill") {
      if (BaseRoundedRectangle._fillMaterialAsset === null) {
        BaseRoundedRectangle._fillMaterialAsset = requireAsset(
          "../../../Materials/CollapsedSquircleFill.mat"
        ) as Material
      }
      return BaseRoundedRectangle._fillMaterialAsset
    }
    return BaseRoundedRectangle.getMaterialAsset()
  }

  /** Clones the shared rounded-rectangle material for instance-specific uniforms. */
  public static cloneMaterialAsset(): Material {
    return BaseRoundedRectangle.getMaterialAsset().clone()
  }

  private static cloneVec2(value: vec2): vec2 {
    return new vec2(value.x, value.y)
  }

  private static cloneVec4(value: vec4): vec4 {
    return new vec4(value.x, value.y, value.z, value.w)
  }

  private static cloneGradientStopConfig(stop: BaseGradientStopConfig): BaseGradientStopConfig {
    return {
      color: BaseRoundedRectangle.cloneVec4(stop.color),
      percent: stop.percent,
      enabled: stop.enabled
    }
  }

  private static cloneGradientConfig(config: BaseGradientConfig): BaseGradientConfig {
    return {
      type: config.type,
      start: BaseRoundedRectangle.cloneVec2(config.start),
      end: BaseRoundedRectangle.cloneVec2(config.end),
      stop0: BaseRoundedRectangle.cloneGradientStopConfig(config.stop0),
      stop1: BaseRoundedRectangle.cloneGradientStopConfig(config.stop1),
      stop2: BaseRoundedRectangle.cloneGradientStopConfig(config.stop2),
      stop3: BaseRoundedRectangle.cloneGradientStopConfig(config.stop3),
      stop4: BaseRoundedRectangle.cloneGradientStopConfig(config.stop4),
      stop5: BaseRoundedRectangle.cloneGradientStopConfig(config.stop5),
      stop6: BaseRoundedRectangle.cloneGradientStopConfig(config.stop6)
    }
  }

  // Returns a public GradientStop with a CLONED color, so a caller mutating the
  // returned color can't corrupt the (possibly shared-default) config in place.
  private static readStop(stop: BaseGradientStopConfig, includeEnabled: boolean): GradientStop {
    return includeEnabled
      ? {color: BaseRoundedRectangle.cloneVec4(stop.color), percent: stop.percent, enabled: stop.enabled}
      : {color: BaseRoundedRectangle.cloneVec4(stop.color), percent: stop.percent}
  }

  /** Creates a rounded-rectangle renderer around an existing RenderMeshVisual and material. */
  public constructor(renderMeshVisual: RenderMeshVisual, material: Material, config: BaseRoundedRectangleConfig) {
    this.renderMeshVisual = renderMeshVisual
    this._material = material
    this._shape = {
      size: config.size,
      cornerRadius: config.cornerRadius,
      blendMode: config.blendMode,
      opacity: config.opacity
    }
    this._background = {
      color: config.background.color,
      gradient: config.background.gradient,
      useTexture: config.background.useTexture,
      texture: config.background.texture,
      textureMode: config.background.textureMode,
      textureWrap: config.background.textureWrap
    }
    this._backgroundGradient = config.background.gradientConfig
    this._border = {
      enabled: config.border.enabled,
      size: config.border.size,
      softness: config.border.softness,
      color: config.border.color,
      type: config.border.type
    }
    this._borderGradient = config.border.gradientConfig
    this._uniforms = {
      borderEnabled: -1,
      gradient: createGradientUniformCache(),
      borderGradient: createGradientUniformCache()
    }
  }

  private ensureOwnedBackgroundGradient(): void {
    if (isSharedDefaultBackgroundGradient(this._backgroundGradient)) {
      this._backgroundGradient = BaseRoundedRectangle.cloneGradientConfig(this._backgroundGradient)
    }
  }

  private ensureOwnedBorderGradient(): void {
    if (isSharedDefaultBorderGradient(this._borderGradient)) {
      this._borderGradient = BaseRoundedRectangle.cloneGradientConfig(this._borderGradient)
    }
  }

  /** Attaches the mesh and material, then writes the initial uniforms once. */
  public initialize(): void {
    if (this._initialized || this._disposed) {
      return
    }

    this.renderMeshVisual.mesh = BaseRoundedRectangle.getMesh()
    this.renderMeshVisual.mainMaterial = this._material
    this.applyMaterialBaseState()
    this._initialized = true

    const mainPass = this.renderMeshVisual.mainPass

    // Initializing Corner Radius
    mainPass.cornerRadius = this._shape.cornerRadius

    // Initializing Border
    this.updateBorderEnabledUniform(mainPass)
    // need border calculations if using gradient type rectangle
    if (!this._border.enabled) {
      this._border.size = 0
    }
    this.applyBorderUniforms(mainPass)
    // borderColor is always written: the border can be enabled without _border (e.g.
    // gradientType === "Rectangle" via getBorderEnabledUniform), so it must not be skipped.
    mainPass.borderColor = this._border.color
    this.updateBorderGradient()

    // Initializing Background Color
    mainPass.backgroundColor = this._background.color

    // Initializing Background Gradient
    this.updateBackgroundGradient()

    // Initializing Texture (detail uniforms written only when texturing is on)
    this.applyTextureUniforms(mainPass)

    // Variant ladder: the constructor's material is the full-variant clone;
    // seed it, then drop to the leanest rung that renders this state.
    this._variantClones.full = this._material
    this.updateMaterialVariant()
  }

  /**
   * Marks this renderer disposed.
   * Later property writes only update backing state and do not touch material uniforms.
   */
  public dispose(): void {
    this._disposed = true
    this._initialized = false
  }

  /**
   * Writes the borderSize/borderSoftness uniforms from the backing state,
   * parking borderSize at 0 while the border is hidden (see borderVisible)
   * so a Rectangle background gradient's forced border uniform can't draw it.
   */
  private applyBorderUniforms(mainPass?: Pass): void {
    if (!this._initialized || this._disposed) {
      return
    }
    const pass = mainPass ?? this.renderMeshVisual.mainPass
    pass.borderSize = this._borderVisible ? this._border.size : 0
    if (typeof pass.borderSoftness === "number") {
      pass.borderSoftness = Math.max(this._border.softness, 0)
    }
  }

  /** Whether the material variant ladder may swap this instance's material. */
  public get materialVariantsEnabled(): boolean {
    return this._useVariants
  }

  /**
   * Disables (or re-enables) the variant ladder. Consumers that override the
   * bound material with a bespoke shader MUST disable this first, or a later
   * state change would swap their material away. Disabling rebinds the full
   * variant so every feature keeps rendering.
   */
  public set materialVariantsEnabled(enabled: boolean) {
    if (enabled === undefined || enabled === this._useVariants) {
      return
    }
    this._useVariants = enabled
    if (!this._initialized || this._disposed) {
      return
    }
    if (!enabled && this._activeVariant !== "full") {
      this.bindVariant("full")
    } else if (enabled) {
      this.updateMaterialVariant()
    }
    this.applyCull()
  }

  // The leanest rung that renders the current feature state.
  private desiredVariant(): MaterialVariant {
    if (this._border.enabled && this._borderVisible && this._border.size > 0) {
      return "full"
    }
    if (this._background.gradient || this._background.useTexture) {
      return "fill"
    }
    return "solid"
  }

  /**
   * Rebinds the leanest material variant for the current state. Called from
   * every feature-state mutation; a no-op when the right rung is already
   * bound, when the ladder is disabled, or before initialize.
   */
  private updateMaterialVariant(): void {
    // Every feature-state mutation lands here, so visibility follows them all.
    this.refreshContentVisibility()
    if (!this._useVariants || !this._initialized || this._disposed) {
      return
    }
    // A consumer that replaced renderMeshVisual.mainMaterial directly (e.g. a
    // punch-hole pattern) is invisible to `set material` — detect
    // the takeover here and permanently hand the material over. isSame, not
    // identity: mainMaterial re-reads the same native material through a new
    // wrapper.
    const bound = this.renderMeshVisual.mainMaterial
    if (isNull(bound) || !bound.isSame(this._material)) {
      this._useVariants = false
      this.applyCull()
      return
    }
    const desired = this.desiredVariant()
    if (desired !== this._activeVariant) {
      this.bindVariant(desired)
    }
  }

  private bindVariant(variant: MaterialVariant): void {
    let clone = this._variantClones[variant]
    if (clone === undefined) {
      clone = BaseRoundedRectangle.getVariantMaterialAsset(variant).clone()
      this._variantClones[variant] = clone
    }
    // Pass render state is written by layers this class can't see (Visual's
    // depthSettings, RoundedRectangleVisual's transparent colorMask, direct
    // blendMode/twoSided writes, VisibilityGroup's opacity fades, mask stencil
    // setup, externally-widened cull bounds) — snapshot the outgoing pass so
    // the swap is invisible to them.
    const outgoingPass = this._material.mainPass
    const depthTest = outgoingPass.depthTest
    const depthWrite = outgoingPass.depthWrite
    const colorMask = outgoingPass.colorMask
    const polygonOffset = outgoingPass.polygonOffset
    const blendMode = outgoingPass.blendMode
    const twoSided = outgoingPass.twoSided
    const cullMode = outgoingPass.cullMode
    const opacityFactor = outgoingPass.opacityFactor
    const frustumCullMin = outgoingPass.frustumCullMin
    const frustumCullMax = outgoingPass.frustumCullMax
    // Stencil (mask clipping) is carried field-by-field: assigning the live
    // StencilState object could alias it across two passes.
    const outgoingStencil = outgoingPass.stencilState
    const stencilEnabled = outgoingStencil.enabled
    const stencilCompareFunction = outgoingStencil.stencilCompareFunction
    const stencilReferenceValue = outgoingStencil.referenceValue
    const stencilReadMask = outgoingStencil.readMask
    const stencilWriteMask = outgoingStencil.writeMask
    const stencilPassOp = outgoingStencil.depthStencilPassOperation
    const stencilFailOp = outgoingStencil.stencilFailureOperation
    const stencilDepthFailOp = outgoingStencil.depthFailureOperation
    // Set the rung BEFORE re-applying state: applyMaterial re-runs setters,
    // and updateMaterialVariant's equality check is what stops the cycle.
    this._activeVariant = variant
    this._material = clone
    this.renderMeshVisual.mainMaterial = clone
    // Re-establish every uniform on the newly bound clone (writes to
    // uniforms a lean variant lacks are tolerated no-ops). applyMaterial
    // covers everything except the size/culling set — re-push it too.
    this.applyMaterial()
    this.updateSize(this._shape.size)
    // Restore AFTER applyMaterial/updateSize: the snapshot (which carries any
    // direct consumer writes — including mid-fade opacity and externally
    // widened cull bounds) wins over the shape-derived values just set.
    const incomingPass = this._material.mainPass
    incomingPass.depthTest = depthTest
    incomingPass.depthWrite = depthWrite
    incomingPass.colorMask = colorMask
    incomingPass.polygonOffset = polygonOffset
    incomingPass.blendMode = blendMode
    incomingPass.twoSided = twoSided
    incomingPass.cullMode = cullMode
    incomingPass.opacityFactor = opacityFactor
    incomingPass.frustumCullMin = frustumCullMin
    incomingPass.frustumCullMax = frustumCullMax
    const incomingStencil = incomingPass.stencilState
    incomingStencil.enabled = stencilEnabled
    incomingStencil.stencilCompareFunction = stencilCompareFunction
    incomingStencil.referenceValue = stencilReferenceValue
    incomingStencil.readMask = stencilReadMask
    incomingStencil.writeMask = stencilWriteMask
    incomingStencil.depthStencilPassOperation = stencilPassOp
    incomingStencil.stencilFailureOperation = stencilFailOp
    incomingStencil.depthFailureOperation = stencilDepthFailOp
  }

  /** Whether an enabled border is currently rendered (see the setter). */
  public get borderVisible(): boolean {
    return this._borderVisible
  }

  /**
   * Shows/hides the border WITHOUT touching the authored border state —
   * unlike `border = false`, which zeroes borderSize. This is the toggle for
   * hover-style borders (Frame's panel): flip visibility every transition
   * while size/color persist (borderSize is parked at 0 while hidden so a
   * Rectangle background gradient's forced border uniform can't draw it).
   */
  public set borderVisible(visible: boolean) {
    if (visible === undefined || visible === this._borderVisible) {
      return
    }
    this._borderVisible = visible
    if (this._initialized && !this._disposed) {
      this.updateBorderEnabledUniform()
      this.applyBorderUniforms()
      this.updateMaterialVariant()
    }
  }

  /** Updates the backing size and, when initialized, dependent size/culling uniforms. */
  public updateSize(size: vec2): void {
    if (size === undefined) {
      return
    }
    this._shape.size.copyFrom(size)
    if (!this._initialized || this._disposed) {
      return
    }
    const mainPass = this.renderMeshVisual.mainPass
    const width = this._shape.size.x
    const height = this._shape.size.y
    mainPass.size = this._shape.size
    mainPass.uvSize = new vec2(2 / width, 2 / height)
    this.applyCullBounds(mainPass)
  }

  /** Gets the material currently owned by this rounded rectangle. */
  public get material(): Material {
    return this._material
  }

  /** Replaces the material and reapplies the current backing state when initialized. */
  public set material(material: Material) {
    if (material === undefined) {
      return
    }
    // An external material replacement is a bespoke override — the variant
    // ladder must never swap it away.
    this._useVariants = false
    this._material = material
    if (this._initialized && !this._disposed) {
      this.renderMeshVisual.mainMaterial = material
      this.applyMaterial()
      this.applyCull()
    }
  }

  /** Gets the rounded rectangle size in local-space centimeters. */
  public get size(): vec2 {
    return this._shape.size
  }

  /** Sets the rounded rectangle size in local-space centimeters. */
  public set size(size: vec2) {
    this.updateSize(size)
  }

  /** Sets the blend mode used by the material pass. */
  public set blendMode(blendMode: RoundedRectBlendMode) {
    this._shape.blendMode = blendMode
    if (this._initialized && !this._disposed) {
      this._material.mainPass.blendMode = this.getScenariumBlendMode()
      this.applyCull()
    }
  }

  /** Gets the configured rounded-rectangle blend mode. */
  public get blendMode(): RoundedRectBlendMode {
    return this._shape.blendMode
  }

  /** Sets the material opacity factor. */
  public set opacity(opacity: number) {
    if (opacity === undefined) {
      return
    }
    this._shape.opacity = opacity
    if (this._initialized && !this._disposed) {
      this._material.mainPass.opacityFactor = opacity
      if (this._cullIncludesOpacity) {
        this.refreshContentVisibility()
      }
    }
  }

  /** Gets the live material opacity when initialized, otherwise the backing opacity. */
  public get opacity(): number {
    if (!this._initialized || this._disposed) {
      return this._shape.opacity
    }
    return this._material.mainPass.opacityFactor
  }

  /** Gets the corner radius in local-space centimeters. */
  public get cornerRadius(): number {
    return this._shape.cornerRadius
  }

  /** Sets the corner radius in local-space centimeters. */
  public set cornerRadius(cornerRadius: number) {
    if (cornerRadius === undefined) {
      return
    }
    this._shape.cornerRadius = cornerRadius
    if (this._initialized && !this._disposed) {
      this.renderMeshVisual.mainPass.cornerRadius = cornerRadius
    }
  }

  /** Gets the solid background color. */
  public get backgroundColor(): vec4 {
    return this._background.color
  }

  /** Sets the solid background color. */
  public set backgroundColor(color: vec4) {
    if (color === undefined) {
      return
    }
    this._background.color = color
    if (this._initialized && !this._disposed) {
      this.renderMeshVisual.mainPass.backgroundColor = color
      this.refreshContentVisibility()
    }
  }

  /** Gets the active background fill mode derived from gradient and texture flags. */
  public get baseType(): RoundedRectangleBaseType {
    if (this._background.useTexture) {
      return "Texture"
    }
    if (this._background.gradient) {
      return "Gradient"
    }
    return "Color"
  }

  /** Sets the active background fill mode. */
  public set baseType(baseType: RoundedRectangleBaseType) {
    if (baseType === undefined || baseType === this.baseType) {
      return
    }
    this.applyBaseMaterialState(baseType)
  }

  /** Gets whether the background texture path is active. */
  public get useTexture(): boolean {
    return this._background.useTexture
  }

  /** Enables or disables the background texture path. */
  public set useTexture(use: boolean) {
    if (use === undefined || use === this._background.useTexture) {
      return
    }
    this._background.useTexture = use
    if (this._initialized && !this._disposed) {
      this.updateMaterialVariant()
      // Enabling re-establishes the texture-detail uniforms skipped at init.
      this.applyTextureUniforms()
    }
  }

  /** Gets the background texture asset. */
  public get texture(): Texture {
    return this._background.texture
  }

  /** Sets the background texture asset. */
  public set texture(texture: Texture) {
    if (texture === undefined) {
      return
    }
    this._background.texture = texture
    if (this._initialized && !this._disposed) {
      this.renderMeshVisual.mainPass.backgroundTexture = this._background.texture
      // The textureMode uniform is aspect-corrected from the texture, so a
      // runtime swap must re-derive it or the new texture inherits the old
      // one's aspect and renders stretched.
      this.applyTextureUniforms()
    }
  }

  /** Gets the background texture sizing mode. */
  public get textureMode(): TextureMode {
    return this._background.textureMode
  }

  /** Sets the background texture sizing mode. */
  public set textureMode(mode: TextureMode) {
    if (mode === undefined || mode === this._background.textureMode) {
      return
    }
    this._background.textureMode = mode
    if (this._initialized && !this._disposed) {
      const textureAspect = this._background.texture
        ? (this._background.texture.control.getAspect() * this.size.y) / this.size.x
        : 1
      this.updateTextureModeUniform(textureAspect, this.renderMeshVisual.mainPass)
    }
  }

  /** Gets the background texture wrap mode. */
  public get textureWrap(): TextureWrap {
    return this._background.textureWrap
  }

  /** Sets the background texture wrap mode. */
  public set textureWrap(wrap: TextureWrap) {
    if (wrap === undefined) {
      return
    }
    this._background.textureWrap = wrap
    if (this._initialized && !this._disposed) {
      this.renderMeshVisual.mainPass.textureWrap = this.getTextureWrapUniform()
    }
  }

  /** Gets whether the background gradient is enabled. */
  public get gradient(): boolean {
    return this._background.gradient
  }

  /** Enables or disables the background gradient. */
  public set gradient(enabled: boolean) {
    if (enabled === undefined || enabled === this._background.gradient) {
      return
    }
    this._background.gradient = enabled
    if (this._initialized && !this._disposed) {
      this.updateMaterialVariant()
      this.updateBackgroundGradient()
    }
  }

  /** Gets the background gradient type. */
  public get gradientType(): GradientType {
    return this._backgroundGradient.type
  }

  /** Sets the background gradient type and refreshes dependent border uniforms. */
  public set gradientType(type: GradientType) {
    if (type === undefined || type === this._backgroundGradient.type) {
      return
    }
    this.ensureOwnedBackgroundGradient()
    this._backgroundGradient.type = type
    if (this._initialized && !this._disposed) {
      this.updateBorderEnabledUniform()
      this.updateBackgroundGradient()
    }
  }

  /** Gets the background gradient start position. */
  public get gradientStartPosition(): vec2 {
    return BaseRoundedRectangle.cloneVec2(this._backgroundGradient.start)
  }

  /** Sets the background gradient start position. */
  public set gradientStartPosition(position: vec2) {
    if (position === undefined) {
      return
    }
    this.ensureOwnedBackgroundGradient()
    this._backgroundGradient.start = position
    if (this._initialized && !this._disposed && this._backgroundGradient.end !== undefined) {
      this.updateBackgroundGradient()
    }
  }

  /** Gets the background gradient end position. */
  public get gradientEndPosition(): vec2 {
    return BaseRoundedRectangle.cloneVec2(this._backgroundGradient.end)
  }

  /** Sets the background gradient end position. */
  public set gradientEndPosition(position: vec2) {
    if (position === undefined) {
      return
    }
    this.ensureOwnedBackgroundGradient()
    this._backgroundGradient.end = position
    if (this._initialized && !this._disposed && this._backgroundGradient.start !== undefined) {
      this.updateBackgroundGradient()
    }
  }

  /** Gets whether the inset border is enabled. */
  public get border(): boolean {
    return this._border.enabled
  }

  /** Enables or disables the inset border. */
  public set border(enabled: boolean) {
    if (enabled === undefined || enabled === this._border.enabled) {
      return
    }
    this._border.enabled = enabled
    if (this._initialized && !this._disposed) {
      this.updateBorderEnabledUniform()
      if (!enabled) {
        this.borderSize = 0
      }
      this.updateBorderGradient()
      this.updateMaterialVariant()
    }
  }

  /** Gets the inset border size in local-space centimeters. */
  public get borderSize(): number {
    return this._border.size
  }

  /** Sets the inset border size in local-space centimeters. */
  public set borderSize(borderSize: number) {
    if (borderSize === undefined) {
      return
    }
    this._border.size = borderSize
    if (this._initialized && !this._disposed) {
      this.applyBorderUniforms()
      this.updateMaterialVariant()
    }
  }

  /** Gets the inner-edge border softness in local-space units. */
  public get borderSoftness(): number {
    return this._border.softness
  }

  /** Sets the inner-edge border softness when the material exposes the uniform. */
  public set borderSoftness(borderSoftness: number) {
    if (borderSoftness === undefined) {
      return
    }
    this._border.softness = borderSoftness
    if (this._initialized && !this._disposed) {
      this.applyBorderUniforms()
    }
  }

  /** Gets the solid border color. */
  public get borderColor(): vec4 {
    return this._border.color
  }

  /** Sets the solid border color. */
  public set borderColor(color: vec4) {
    if (color === undefined) {
      return
    }
    this._border.color = color
    if (this._initialized && !this._disposed) {
      this.renderMeshVisual.mainPass.borderColor = color
      this.refreshContentVisibility()
    }
  }

  /** Gets whether the border is rendered as a color or gradient. */
  public get borderType(): BorderType {
    return this._border.type
  }

  /** Sets whether the border is rendered as a color or gradient. */
  public set borderType(type: BorderType) {
    if (type === undefined || type === this._border.type) {
      return
    }
    this._border.type = type
    if (this._initialized && !this._disposed) {
      this.updateBorderGradient()
    }
  }

  /** Gets the border gradient type. */
  public get borderGradientType(): GradientType {
    return this._borderGradient.type
  }

  /** Sets the border gradient type. */
  public set borderGradientType(type: GradientType) {
    if (type === undefined || type === this._borderGradient.type) {
      return
    }
    this.ensureOwnedBorderGradient()
    this._borderGradient.type = type
    if (this._initialized && !this._disposed) {
      this.updateBorderGradient()
    }
  }

  /** Gets the border gradient start position. */
  public get borderGradientStartPosition(): vec2 {
    return BaseRoundedRectangle.cloneVec2(this._borderGradient.start)
  }

  /** Sets the border gradient start position. */
  public set borderGradientStartPosition(position: vec2) {
    if (position === undefined) {
      return
    }
    this.ensureOwnedBorderGradient()
    this._borderGradient.start = position
    if (this._initialized && !this._disposed && this._borderGradient.end !== undefined) {
      this.updateBorderGradient()
    }
  }

  /** Gets the border gradient end position. */
  public get borderGradientEndPosition(): vec2 {
    return BaseRoundedRectangle.cloneVec2(this._borderGradient.end)
  }

  /** Sets the border gradient end position. */
  public set borderGradientEndPosition(position: vec2) {
    if (position === undefined) {
      return
    }
    this.ensureOwnedBorderGradient()
    this._borderGradient.end = position
    if (this._initialized && !this._disposed && this._borderGradient.start !== undefined) {
      this.updateBorderGradient()
    }
  }

  /** Sets both background gradient positions and updates uniforms once when live. */
  public setBackgroundGradientPositions(gradientStartPosition: vec2, gradientEndPosition: vec2): void {
    let changed = false
    if (gradientStartPosition !== undefined) {
      this.ensureOwnedBackgroundGradient()
      this._backgroundGradient.start = gradientStartPosition
      changed = true
    }
    if (gradientEndPosition !== undefined) {
      this.ensureOwnedBackgroundGradient()
      this._backgroundGradient.end = gradientEndPosition
      changed = true
    }
    if (
      changed &&
      this._initialized &&
      !this._disposed &&
      this._backgroundGradient.start !== undefined &&
      this._backgroundGradient.end !== undefined
    ) {
      this.updateBackgroundGradient()
    }
  }

  /** Sets both border gradient positions and updates uniforms once when live. */
  public setBorderGradientPositions(gradientStartPosition: vec2, gradientEndPosition: vec2): void {
    let changed = false
    if (gradientStartPosition !== undefined) {
      this.ensureOwnedBorderGradient()
      this._borderGradient.start = gradientStartPosition
      changed = true
    }
    if (gradientEndPosition !== undefined) {
      this.ensureOwnedBorderGradient()
      this._borderGradient.end = gradientEndPosition
      changed = true
    }
    if (
      changed &&
      this._initialized &&
      !this._disposed &&
      this._borderGradient.start !== undefined &&
      this._borderGradient.end !== undefined
    ) {
      this.updateBorderGradient()
    }
  }

  /** Applies a background fill mode by updating the gradient and texture mode flags together. */
  public applyBaseMaterialState(baseType: RoundedRectangleBaseType): void {
    this._background.gradient = baseType === "Gradient"
    this._background.useTexture = baseType === "Texture"

    if (!this._initialized || this._disposed) {
      return
    }

    // Both flags feed desiredVariant — swap BEFORE the uniform writes below
    // so they land on the rung that actually has those uniforms.
    this.updateMaterialVariant()

    const mainPass = this.renderMeshVisual.mainPass
    // applyTextureUniforms establishes useTexture + (when texturing) the detail
    // uniforms, so switching into Texture mode backfills the mode/wrap/asset.
    this.applyTextureUniforms(mainPass)
    this.updateBorderEnabledUniform(mainPass)
    this.updateBackgroundGradient()
  }

  /** Gets a background gradient stop by index; invalid indexes return an empty stop. */
  public getBackgroundGradientStop(index: number): GradientStop {
    const gradient = this._backgroundGradient
    switch (index) {
      case 0:
        return BaseRoundedRectangle.readStop(gradient.stop0, false)
      case 1:
        return BaseRoundedRectangle.readStop(gradient.stop1, false)
      case 2:
        return BaseRoundedRectangle.readStop(gradient.stop2, true)
      case 3:
        return BaseRoundedRectangle.readStop(gradient.stop3, true)
      case 4:
        return BaseRoundedRectangle.readStop(gradient.stop4, true)
      case 5:
        return BaseRoundedRectangle.readStop(gradient.stop5, true)
      case 6:
        return BaseRoundedRectangle.readStop(gradient.stop6, true)
      default:
        return {}
    }
  }

  /**
   * Sets a background gradient stop.
   * Stops 0 and 1 stay shader-enabled regardless of the stop's enabled field.
   */
  public setBackgroundGradientStop(index: number, stop: GradientStop, needsUpdate: boolean = true): void {
    // Static-key writes (switch) instead of computed string keys. stop0/1 enabled
    // remains ignored to preserve the shader's hardcoded first two stops.
    const color = stop.color
    const percent = stop.percent
    const enabled = stop.enabled !== undefined ? stop.enabled : true
    this.ensureOwnedBackgroundGradient()
    const gradient = this._backgroundGradient
    let colorsDirty = false
    let percentsDirty = false
    switch (index) {
      case 0:
        if (color !== undefined) {
          gradient.stop0.color = color
          colorsDirty = true
        }
        if (percent !== undefined && percent !== gradient.stop0.percent) {
          gradient.stop0.percent = percent
          percentsDirty = true
        }
        break
      case 1:
        if (color !== undefined) {
          gradient.stop1.color = color
          colorsDirty = true
        }
        if (percent !== undefined && percent !== gradient.stop1.percent) {
          gradient.stop1.percent = percent
          percentsDirty = true
        }
        break
      case 2:
        if (color !== undefined) {
          gradient.stop2.color = color
          colorsDirty = true
        }
        if (percent !== undefined && percent !== gradient.stop2.percent) {
          gradient.stop2.percent = percent
          percentsDirty = true
        }
        if (enabled !== gradient.stop2.enabled) {
          gradient.stop2.enabled = enabled
          colorsDirty = true
          percentsDirty = true
        }
        break
      case 3:
        if (color !== undefined) {
          gradient.stop3.color = color
          colorsDirty = true
        }
        if (percent !== undefined && percent !== gradient.stop3.percent) {
          gradient.stop3.percent = percent
          percentsDirty = true
        }
        if (enabled !== gradient.stop3.enabled) {
          gradient.stop3.enabled = enabled
          colorsDirty = true
          percentsDirty = true
        }
        break
      case 4:
        if (color !== undefined) {
          gradient.stop4.color = color
          colorsDirty = true
        }
        if (percent !== undefined && percent !== gradient.stop4.percent) {
          gradient.stop4.percent = percent
          percentsDirty = true
        }
        if (enabled !== gradient.stop4.enabled) {
          gradient.stop4.enabled = enabled
          colorsDirty = true
          percentsDirty = true
        }
        break
      case 5:
        if (color !== undefined) {
          gradient.stop5.color = color
          colorsDirty = true
        }
        if (percent !== undefined && percent !== gradient.stop5.percent) {
          gradient.stop5.percent = percent
          percentsDirty = true
        }
        if (enabled !== gradient.stop5.enabled) {
          gradient.stop5.enabled = enabled
          colorsDirty = true
          percentsDirty = true
        }
        break
      case 6:
        if (color !== undefined) {
          gradient.stop6.color = color
          colorsDirty = true
        }
        if (percent !== undefined && percent !== gradient.stop6.percent) {
          gradient.stop6.percent = percent
          percentsDirty = true
        }
        if (enabled !== gradient.stop6.enabled) {
          gradient.stop6.enabled = enabled
          colorsDirty = true
          percentsDirty = true
        }
        break
    }
    if (colorsDirty) this._uniforms.gradient.colorsDirty = true
    if (percentsDirty) this._uniforms.gradient.percentsDirty = true
    if (needsUpdate) this.updateBackgroundGradient()
  }

  /** Applies a background gradient parameter set and refreshes dependent uniforms. */
  public setBackgroundGradient(gradientParameters: GradientParameters): void {
    this.ensureOwnedBackgroundGradient()
    this.applyBackgroundGradientParameters(gradientParameters)
    if (this._initialized && !this._disposed) {
      this.updateBorderEnabledUniform()
    }
    this.updateBackgroundGradient()
    this.updateMaterialVariant()
  }

  /** Gets a border gradient stop by index; invalid indexes return an empty stop. */
  public getBorderGradientStop(index: number): GradientStop {
    const gradient = this._borderGradient
    switch (index) {
      case 0:
        return BaseRoundedRectangle.readStop(gradient.stop0, false)
      case 1:
        return BaseRoundedRectangle.readStop(gradient.stop1, false)
      case 2:
        return BaseRoundedRectangle.readStop(gradient.stop2, true)
      case 3:
        return BaseRoundedRectangle.readStop(gradient.stop3, true)
      case 4:
        return BaseRoundedRectangle.readStop(gradient.stop4, true)
      case 5:
        return BaseRoundedRectangle.readStop(gradient.stop5, true)
      case 6:
        return BaseRoundedRectangle.readStop(gradient.stop6, true)
      default:
        return {}
    }
  }

  /**
   * Sets a border gradient stop.
   * Stops 0 and 1 stay shader-enabled regardless of the stop's enabled field.
   */
  public setBorderGradientStop(index: number, stop: GradientStop, needsUpdate: boolean = true): void {
    // Static-key writes (see setBackgroundGradientStop). stop0/1 enabled remains ignored.
    const color = stop.color
    const percent = stop.percent
    const enabled = stop.enabled !== undefined ? stop.enabled : true
    this.ensureOwnedBorderGradient()
    const gradient = this._borderGradient
    let colorsDirty = false
    let percentsDirty = false
    switch (index) {
      case 0:
        if (color !== undefined) {
          gradient.stop0.color = color
          colorsDirty = true
        }
        if (percent !== undefined && percent !== gradient.stop0.percent) {
          gradient.stop0.percent = percent
          percentsDirty = true
        }
        break
      case 1:
        if (color !== undefined) {
          gradient.stop1.color = color
          colorsDirty = true
        }
        if (percent !== undefined && percent !== gradient.stop1.percent) {
          gradient.stop1.percent = percent
          percentsDirty = true
        }
        break
      case 2:
        if (color !== undefined) {
          gradient.stop2.color = color
          colorsDirty = true
        }
        if (percent !== undefined && percent !== gradient.stop2.percent) {
          gradient.stop2.percent = percent
          percentsDirty = true
        }
        if (enabled !== gradient.stop2.enabled) {
          gradient.stop2.enabled = enabled
          colorsDirty = true
          percentsDirty = true
        }
        break
      case 3:
        if (color !== undefined) {
          gradient.stop3.color = color
          colorsDirty = true
        }
        if (percent !== undefined && percent !== gradient.stop3.percent) {
          gradient.stop3.percent = percent
          percentsDirty = true
        }
        if (enabled !== gradient.stop3.enabled) {
          gradient.stop3.enabled = enabled
          colorsDirty = true
          percentsDirty = true
        }
        break
      case 4:
        if (color !== undefined) {
          gradient.stop4.color = color
          colorsDirty = true
        }
        if (percent !== undefined && percent !== gradient.stop4.percent) {
          gradient.stop4.percent = percent
          percentsDirty = true
        }
        if (enabled !== gradient.stop4.enabled) {
          gradient.stop4.enabled = enabled
          colorsDirty = true
          percentsDirty = true
        }
        break
      case 5:
        if (color !== undefined) {
          gradient.stop5.color = color
          colorsDirty = true
        }
        if (percent !== undefined && percent !== gradient.stop5.percent) {
          gradient.stop5.percent = percent
          percentsDirty = true
        }
        if (enabled !== gradient.stop5.enabled) {
          gradient.stop5.enabled = enabled
          colorsDirty = true
          percentsDirty = true
        }
        break
      case 6:
        if (color !== undefined) {
          gradient.stop6.color = color
          colorsDirty = true
        }
        if (percent !== undefined && percent !== gradient.stop6.percent) {
          gradient.stop6.percent = percent
          percentsDirty = true
        }
        if (enabled !== gradient.stop6.enabled) {
          gradient.stop6.enabled = enabled
          colorsDirty = true
          percentsDirty = true
        }
        break
    }
    if (colorsDirty) this._uniforms.borderGradient.colorsDirty = true
    if (percentsDirty) this._uniforms.borderGradient.percentsDirty = true
    if (needsUpdate) this.updateBorderGradient()
  }

  /** Applies a border gradient parameter set and refreshes border gradient uniforms. */
  public setBorderGradient(gradientParameters: GradientParameters): void {
    this.ensureOwnedBorderGradient()
    this.applyBorderGradientParameters(gradientParameters)
    this.updateBorderGradient()
  }

  /** Prints the current rounded-rectangle configuration for debugging. */
  public printConfig(): void {
    const configOutput: any = {}

    configOutput.size = this.size
    configOutput.cornerRadius = this.cornerRadius

    configOutput.background = {}
    if (this.gradient) {
      configOutput.backgroundGradient = {}
      configOutput.backgroundGradient.type = this.gradientType
      configOutput.backgroundGradient.start = this.gradientStartPosition
      configOutput.backgroundGradient.end = this.gradientEndPosition
      configOutput.backgroundGradient.stop0 = this.getBackgroundGradientStop(0)
      configOutput.backgroundGradient.stop1 = this.getBackgroundGradientStop(1)
      configOutput.backgroundGradient.stop2 = this.getBackgroundGradientStop(2)
      configOutput.backgroundGradient.stop3 = this.getBackgroundGradientStop(3)
      configOutput.backgroundGradient.stop4 = this.getBackgroundGradientStop(4)
      configOutput.backgroundGradient.stop5 = this.getBackgroundGradientStop(5)
      configOutput.backgroundGradient.stop6 = this.getBackgroundGradientStop(6)
    } else if (this.useTexture) {
      configOutput.texture = this.texture
      configOutput.textureMode = this.textureMode
      configOutput.textureWrap = this.textureWrap
    } else {
      configOutput.backgroundColor = this.backgroundColor
    }

    if (this.border) {
      configOutput.border = {}
      configOutput.border.borderSize = this.borderSize
      if (this.borderType === "Gradient") {
        configOutput.borderGradient = {}
        configOutput.borderGradient.type = this.borderGradientType
        configOutput.borderGradient.start = this.borderGradientStartPosition
        configOutput.borderGradient.end = this.borderGradientEndPosition
        configOutput.borderGradient.stop0 = this.getBorderGradientStop(0)
        configOutput.borderGradient.stop1 = this.getBorderGradientStop(1)
        configOutput.borderGradient.stop2 = this.getBorderGradientStop(2)
        configOutput.borderGradient.stop3 = this.getBorderGradientStop(3)
        configOutput.borderGradient.stop4 = this.getBorderGradientStop(4)
        configOutput.borderGradient.stop5 = this.getBorderGradientStop(5)
        configOutput.borderGradient.stop6 = this.getBorderGradientStop(6)
      } else {
        configOutput.border.color = this.borderColor
      }
    }

    log.d("RoundedRectangle Configuration:")
    log.d(formatLensValue(configOutput))
  }

  private updateTextureModeUniform(textureAspect: number, mainPass: Pass): void {
    if (this._background.textureMode === "Stretch") {
      mainPass.textureMode = new vec2(1, 1)
    } else if (this._background.textureMode === "Fill Height") {
      mainPass.textureMode = new vec2(1 / textureAspect, 1)
    } else if (this._background.textureMode === "Fill Width") {
      mainPass.textureMode = new vec2(1, textureAspect)
    }
  }

  private getTextureWrapUniform(): number {
    if (this._background.textureWrap === "Repeat") {
      return 1
    }
    if (this._background.textureWrap === "Clamp") {
      return 2
    }
    return 0
  }

  private applyTextureUniforms(mainPass?: Pass): void {
    if (!this._initialized || this._disposed) {
      return
    }
    const pass = mainPass ?? this.renderMeshVisual.mainPass
    pass.useTexture = this._background.useTexture ? 1 : 0
    if (!this._background.useTexture) {
      return
    }
    const textureAspect = this._background.texture
      ? (this._background.texture.control.getAspect() * this.size.y) / this.size.x
      : 1
    this.updateTextureModeUniform(textureAspect, pass)
    pass.textureWrap = this.getTextureWrapUniform()
    if (this._background.texture) {
      pass.backgroundTexture = this._background.texture
    }
  }

  /** Whether any fill or border alpha is above zero (or a texture is shown). Ignores opacity. */
  public get contentVisible(): boolean {
    return this._contentVisible
  }

  /**
   * When true, the draw is skipped while every fill and border color has alpha 0 (an idle
   * Ghost button, an unchecked toggle layer) instead of shading an invisible quad every
   * frame. Drawing resumes the same frame any color becomes visible. Only applies to the
   * stock materials on a blended pass; opacity is not considered. Leave off for a
   * transparent shape that must still write depth (an invisible occluder).
   */
  public get cullWhenTransparent(): boolean {
    return this._cullWhenTransparent
  }

  public set cullWhenTransparent(value: boolean) {
    if (value === undefined || value === this._cullWhenTransparent) {
      return
    }
    this._cullWhenTransparent = value
    this.applyCull()
  }

  /**
   * Counts this class's opacity toward {@link cullWhenTransparent}, so opacity 0 also skips
   * the draw. Only for owners that write opacity themselves every frame or exclusively;
   * a layer that writes the pass opacity directly would not be seen.
   */
  public get cullIncludesOpacity(): boolean {
    return this._cullIncludesOpacity
  }

  public set cullIncludesOpacity(value: boolean) {
    if (value === undefined || value === this._cullIncludesOpacity) {
      return
    }
    this._cullIncludesOpacity = value
    this.refreshContentVisibility()
  }

  /** Whether the draw is currently skipped by {@link cullWhenTransparent}. */
  public get culled(): boolean {
    return this._culled
  }

  /**
   * Whether skipping the draw is safe while {@link contentVisible} is false: the stock
   * material ladder is bound (no bespoke or taken-over material that ignores these
   * colors) and the pass blends, so alpha 0 really draws nothing. Reads the bound
   * material, so call it only when about to cull.
   */
  private canCullInvisibleContent(): boolean {
    if (!this._useVariants || !this._initialized || this._disposed) {
      return false
    }
    if (this._shape.blendMode !== RoundedRectBlendMode.Normal) {
      return false
    }
    const bound = this.renderMeshVisual.mainMaterial
    if (isNull(bound) || !bound.isSame(this._material)) {
      return false
    }
    return this._material.mainPass.blendMode !== BlendMode.Disabled
  }

  private refreshContentVisibility(): void {
    if (!this._initialized || this._disposed) {
      return
    }
    const visible = this.computeContentVisible()
    if (visible === this._contentVisible) {
      return
    }
    this._contentVisible = visible
    this.applyCull()
  }

  private applyCull(): void {
    // The native probe in canCullInvisibleContent runs only when about to cull.
    const cull = this._cullWhenTransparent && !this._contentVisible && this.canCullInvisibleContent()
    if (cull === this._culled) {
      return
    }
    this._culled = cull
    this.applyCullBounds()
  }

  // The culled box is a point far along local +Z: behind the viewer for UI facing the camera,
  // past the far plane otherwise. A valid (non-inverted) box is required; the engine treats an
  // inverted user box as "don't cull".
  private applyCullBounds(mainPass?: Pass): void {
    if (!this._initialized || this._disposed) {
      return
    }
    const pass = mainPass ?? this.renderMeshVisual.mainPass
    if (this._culled) {
      // Never park a material that isn't ours. A consumer that replaced mainMaterial since the
      // cull (takeover is otherwise noticed lazily) is handed the material and gets the normal
      // size box below, as every resize did before culling existed.
      const bound = this.renderMeshVisual.mainMaterial
      if (isNull(bound) || !bound.isSame(this._material)) {
        this._culled = false
        this._useVariants = false
      } else {
        pass.frustumCullMin = BaseRoundedRectangle.culledBoundsPoint
        pass.frustumCullMax = BaseRoundedRectangle.culledBoundsPoint
        return
      }
    }
    const width = this._shape.size.x
    const height = this._shape.size.y
    pass.frustumCullMin = new vec3(width * -0.5, height * -0.5, 0)
    pass.frustumCullMax = new vec3(width * 0.5, height * 0.5, 0)
  }

  private static readonly culledBoundsPoint = new vec3(0, 0, 1e9)

  private computeContentVisible(): boolean {
    if (this._cullIncludesOpacity && !(this._shape.opacity > 0)) {
      return false
    }
    const background = this._background
    if (background.useTexture) {
      return true
    }
    if (
      background.gradient ? BaseRoundedRectangle.gradientHasAlpha(this._backgroundGradient) : background.color.a > 0
    ) {
      return true
    }
    const border = this._border
    if (!border.enabled || !this._borderVisible || border.size <= 0) {
      return false
    }
    return border.type === "Gradient" ? BaseRoundedRectangle.gradientHasAlpha(this._borderGradient) : border.color.a > 0
  }

  // Any enabled stop with alpha counts, contiguous or not, so this can only err toward
  // drawing.
  private static gradientHasAlpha(gradient: BaseGradientConfig): boolean {
    return (
      gradient.stop0.color.a > 0 ||
      gradient.stop1.color.a > 0 ||
      (gradient.stop2.enabled && gradient.stop2.color.a > 0) ||
      (gradient.stop3.enabled && gradient.stop3.color.a > 0) ||
      (gradient.stop4.enabled && gradient.stop4.color.a > 0) ||
      (gradient.stop5.enabled && gradient.stop5.color.a > 0) ||
      (gradient.stop6.enabled && gradient.stop6.color.a > 0)
    )
  }

  private getBorderEnabledUniform(): number {
    // Ring-routed, the fill shader never draws the border itself; its border
    // branch only stays up when a Rectangle background gradient needs the
    // mesh-alpha distance field (borderSize stays 0, so nothing is drawn).
    const fillDrawsBorder = this._border.enabled && this._borderVisible
    return fillDrawsBorder || this._backgroundGradient.type === "Rectangle" ? 1 : 0
  }

  private updateBorderEnabledUniform(mainPass?: Pass): void {
    if (!this._initialized || this._disposed) {
      return
    }
    const borderEnabled = this.getBorderEnabledUniform()
    if (this._uniforms.borderEnabled === borderEnabled) {
      return
    }
    this._uniforms.borderEnabled = borderEnabled
    const pass = mainPass ?? this.renderMeshVisual.mainPass
    pass.border = borderEnabled
  }

  private exhaustive(value: never): never {
    throw new Error(`Switch/case never condition reached (value = ${value})`)
  }

  private getScenariumBlendMode(): BlendMode {
    switch (this._shape.blendMode) {
      case RoundedRectBlendMode.Disabled:
        return BlendMode.Disabled
      case RoundedRectBlendMode.Normal:
        return BlendMode.PremultipliedAlphaAuto
      default:
        return this.exhaustive(this._shape.blendMode)
    }
  }

  private validateMaterialUniforms(): void {
    if (typeof this._material.mainPass.opacityFactor != "number") {
      throw new Error("OpacityFactor uniform is missing from material.")
    }
  }

  private resetGradientUniformCache(cache: GradientUniformCache): void {
    cache.stops = -1
    cache.type = -1
    cache.startX = NaN
    cache.startY = NaN
    cache.endX = NaN
    cache.endY = NaN
    cache.colorsDirty = true
    cache.percentsDirty = true
  }

  private resetGradientUniformCaches(): void {
    this._uniforms.borderEnabled = -1
    this.resetGradientUniformCache(this._uniforms.gradient)
    this.resetGradientUniformCache(this._uniforms.borderGradient)
  }

  private getGradientTypeUniform(type: GradientType): number {
    if (type === "Linear") {
      return 0
    }
    if (type === "Radial") {
      return 1
    }
    return 2
  }

  private applyMaterialBaseState(): void {
    this.validateMaterialUniforms()
    this.resetGradientUniformCaches()

    const mainPass = this._material.mainPass
    mainPass.blendMode = this.getScenariumBlendMode()
    mainPass.frustumCullMode = FrustumCullMode.UserDefinedAABB
    mainPass.opacityFactor = this._shape.opacity
  }

  private applyMaterial(): void {
    this.applyMaterialBaseState()

    this.cornerRadius = this._shape.cornerRadius
    this.backgroundColor = this._background.color

    this.gradient = this._background.gradient
    this.gradientType = this._backgroundGradient.type

    this.border = this._border.enabled

    if (this.border) {
      this.borderType = this._border.type
      this.borderSize = this._border.size
      this.borderColor = this._border.color
    }
    this.applyTextureUniforms()

    this.updateBorderEnabledUniform()
    this.updateBackgroundGradient()
    this.updateBorderGradient()
  }

  private applyBackgroundGradientParameters(gradientParameters: GradientParameters): void {
    this.ensureOwnedBackgroundGradient()
    const gradient = this._backgroundGradient
    let stopsDirty = false
    if (gradientParameters.enabled !== undefined && gradientParameters.enabled !== this._background.gradient) {
      this._background.gradient = gradientParameters.enabled
      stopsDirty = true
    }
    if (gradientParameters.type !== undefined) gradient.type = gradientParameters.type
    if (gradientParameters.stop0) this.setBackgroundGradientStop(0, gradientParameters.stop0, false)
    if (gradientParameters.stop1) this.setBackgroundGradientStop(1, gradientParameters.stop1, false)
    if (gradientParameters.stop2) this.setBackgroundGradientStop(2, gradientParameters.stop2, false)
    else if (gradient.stop2.enabled) {
      gradient.stop2.enabled = false
      stopsDirty = true
    }
    if (gradientParameters.stop3) this.setBackgroundGradientStop(3, gradientParameters.stop3, false)
    else if (gradient.stop3.enabled) {
      gradient.stop3.enabled = false
      stopsDirty = true
    }
    if (gradientParameters.stop4) this.setBackgroundGradientStop(4, gradientParameters.stop4, false)
    else if (gradient.stop4.enabled) {
      gradient.stop4.enabled = false
      stopsDirty = true
    }
    if (gradientParameters.stop5) this.setBackgroundGradientStop(5, gradientParameters.stop5, false)
    else if (gradient.stop5.enabled) {
      gradient.stop5.enabled = false
      stopsDirty = true
    }
    if (gradientParameters.stop6) this.setBackgroundGradientStop(6, gradientParameters.stop6, false)
    else if (gradient.stop6.enabled) {
      gradient.stop6.enabled = false
      stopsDirty = true
    }
    if (gradientParameters.start !== undefined) {
      gradient.start = gradientParameters.start
    }
    if (gradientParameters.end !== undefined) gradient.end = gradientParameters.end
    if (stopsDirty) {
      this._uniforms.gradient.colorsDirty = true
      this._uniforms.gradient.percentsDirty = true
    }
  }

  private applyBorderGradientParameters(gradientParameters: GradientParameters): void {
    this.ensureOwnedBorderGradient()
    const gradient = this._borderGradient
    let stopsDirty = false
    if (gradientParameters.enabled !== undefined) {
      const borderType = gradientParameters.enabled ? "Gradient" : "Color"
      if (borderType !== this._border.type) {
        this._border.type = borderType
        stopsDirty = true
      }
    }
    if (gradientParameters.type !== undefined) gradient.type = gradientParameters.type
    if (gradientParameters.stop0) this.setBorderGradientStop(0, gradientParameters.stop0, false)
    if (gradientParameters.stop1) this.setBorderGradientStop(1, gradientParameters.stop1, false)
    if (gradientParameters.stop2) this.setBorderGradientStop(2, gradientParameters.stop2, false)
    else if (gradient.stop2.enabled) {
      gradient.stop2.enabled = false
      stopsDirty = true
    }
    if (gradientParameters.stop3) this.setBorderGradientStop(3, gradientParameters.stop3, false)
    else if (gradient.stop3.enabled) {
      gradient.stop3.enabled = false
      stopsDirty = true
    }
    if (gradientParameters.stop4) this.setBorderGradientStop(4, gradientParameters.stop4, false)
    else if (gradient.stop4.enabled) {
      gradient.stop4.enabled = false
      stopsDirty = true
    }
    if (gradientParameters.stop5) this.setBorderGradientStop(5, gradientParameters.stop5, false)
    else if (gradient.stop5.enabled) {
      gradient.stop5.enabled = false
      stopsDirty = true
    }
    if (gradientParameters.stop6) this.setBorderGradientStop(6, gradientParameters.stop6, false)
    else if (gradient.stop6.enabled) {
      gradient.stop6.enabled = false
      stopsDirty = true
    }
    if (gradientParameters.start !== undefined) {
      gradient.start = gradientParameters.start
    }
    if (gradientParameters.end !== undefined) gradient.end = gradientParameters.end
    if (stopsDirty) {
      this._uniforms.borderGradient.colorsDirty = true
      this._uniforms.borderGradient.percentsDirty = true
    }
  }

  private updateBackgroundGradient(): void {
    // Reachable before the mesh exists: gradient setters can push state before
    // initialize() to fold first paint into the initial material pass.
    if (!this._initialized || this._disposed) {
      return
    }
    const mainPass = this.renderMeshVisual.mainPass
    const cache = this._uniforms.gradient
    const gradient = this._backgroundGradient
    let stops = 0
    if (this._background.gradient) {
      const colors = BaseRoundedRectangle.gradientColorsScratch
      const percents = BaseRoundedRectangle.gradientPercentsScratch
      stops = 2
      colors[0] = gradient.stop0.color
      percents[0] = gradient.stop0.percent
      colors[1] = gradient.stop1.color
      percents[1] = gradient.stop1.percent
      // Nested so a disabled stop short-circuits the rest - @showIf is
      // inspector-only, so a deserialized/prefab state can leave a later stop
      // enabled while an earlier one is off; contiguous writes must be guaranteed
      // here or the shader reads a hole.
      if (gradient.stop2.enabled) {
        stops = 3
        colors[2] = gradient.stop2.color
        percents[2] = gradient.stop2.percent
        if (gradient.stop3.enabled) {
          stops = 4
          colors[3] = gradient.stop3.color
          percents[3] = gradient.stop3.percent
          if (gradient.stop4.enabled) {
            stops = 5
            colors[4] = gradient.stop4.color
            percents[4] = gradient.stop4.percent
            if (gradient.stop5.enabled) {
              stops = 6
              colors[5] = gradient.stop5.color
              percents[5] = gradient.stop5.percent
              if (gradient.stop6.enabled) {
                stops = 7
                colors[6] = gradient.stop6.color
                percents[6] = gradient.stop6.percent
              }
            }
          }
        }
      }
      colors.length = stops
      percents.length = stops
      const stopsChanged = cache.stops !== stops
      if (cache.colorsDirty || stopsChanged) {
        mainPass.colors = colors
        cache.colorsDirty = false
      }
      if (cache.percentsDirty || stopsChanged) {
        mainPass.percents = percents
        cache.percentsDirty = false
      }

      const startPosition = gradient.start
      const endPosition = gradient.end
      const startX = startPosition.x
      const startY = startPosition.y
      const endX = endPosition.x
      const endY = endPosition.y
      const gradientType = this.getGradientTypeUniform(gradient.type)
      // The derived uniforms below depend only on the positions + type. Gate the
      // whole recompute on those inputs so a color-only transition (the common
      // hover/trigger/toggle case) skips the trig and the writes entirely.
      if (
        cache.startX !== startX ||
        cache.startY !== startY ||
        cache.endX !== endX ||
        cache.endY !== endY ||
        cache.type !== gradientType
      ) {
        cache.startX = startX
        cache.startY = startY
        cache.endX = endX
        cache.endY = endY
        cache.type = gradientType
        if (gradient.type === "Linear") {
          const x = endX - startX
          const y = endY - startY
          const angle = Math.atan2(y, x)
          const inverseAngle = -angle
          const sinAngle = Math.sin(inverseAngle)
          const cosAngle = Math.cos(inverseAngle)
          const linearGradientStart = startX * cosAngle - startY * sinAngle
          const linearGradientEnd = endX * cosAngle - endY * sinAngle
          mainPass.linearGradientStart = linearGradientStart
          mainPass.linearGradientEnd = linearGradientEnd
          mainPass.linearGradientAngle = angle
          mainPass.sinLinearGradientAngle = sinAngle
          mainPass.cosLinearGradientAngle = cosAngle
          mainPass.linearGradientLength = linearGradientEnd - linearGradientStart
        } else if (gradient.type === "Radial") {
          const x = endX - startX
          const y = endY - startY
          mainPass.radialGradientLength = 2 / Math.sqrt(x * x + y * y)
        }
        mainPass.gradientType = gradientType
        mainPass.gradientStartPosition = startPosition
      }
    }

    if (cache.stops !== stops) {
      cache.stops = stops
      mainPass.stops = stops
    }
    this.refreshContentVisibility()
  }

  private updateBorderGradient(): void {
    // See updateBackgroundGradient: reachable before the mesh exists via the border
    // gradient setters / pre-init wrapper push. initialize() re-runs this once live.
    if (!this._initialized || this._disposed) {
      return
    }
    const mainPass = this.renderMeshVisual.mainPass
    const cache = this._uniforms.borderGradient
    const gradient = this._borderGradient
    let stops = 0
    if (this._border.type === "Gradient" && this.border) {
      const colors = BaseRoundedRectangle.borderGradientColorsScratch
      const percents = BaseRoundedRectangle.borderGradientPercentsScratch
      stops = 2

      colors[0] = gradient.stop0.color
      percents[0] = gradient.stop0.percent
      colors[1] = gradient.stop1.color
      percents[1] = gradient.stop1.percent
      // Nested so a disabled stop short-circuits the rest (see updateBackgroundGradient).
      if (gradient.stop2.enabled) {
        stops = 3
        colors[2] = gradient.stop2.color
        percents[2] = gradient.stop2.percent
        if (gradient.stop3.enabled) {
          stops = 4
          colors[3] = gradient.stop3.color
          percents[3] = gradient.stop3.percent
          if (gradient.stop4.enabled) {
            stops = 5
            colors[4] = gradient.stop4.color
            percents[4] = gradient.stop4.percent
            if (gradient.stop5.enabled) {
              stops = 6
              colors[5] = gradient.stop5.color
              percents[5] = gradient.stop5.percent
              if (gradient.stop6.enabled) {
                stops = 7
                colors[6] = gradient.stop6.color
                percents[6] = gradient.stop6.percent
              }
            }
          }
        }
      }
      colors.length = stops
      percents.length = stops
      const stopsChanged = cache.stops !== stops
      if (cache.colorsDirty || stopsChanged) {
        mainPass.borderGradientColors = colors
        cache.colorsDirty = false
      }
      if (cache.percentsDirty || stopsChanged) {
        mainPass.borderGradientPercents = percents
        cache.percentsDirty = false
      }

      const startPosition = gradient.start
      const endPosition = gradient.end
      const startX = startPosition.x
      const startY = startPosition.y
      const endX = endPosition.x
      const endY = endPosition.y
      const gradientType = this.getGradientTypeUniform(gradient.type)
      // Derived uniforms depend only on positions + type - see updateBackgroundGradient.
      if (
        cache.startX !== startX ||
        cache.startY !== startY ||
        cache.endX !== endX ||
        cache.endY !== endY ||
        cache.type !== gradientType
      ) {
        cache.startX = startX
        cache.startY = startY
        cache.endX = endX
        cache.endY = endY
        cache.type = gradientType
        if (gradient.type === "Linear") {
          const x = endX - startX
          const y = endY - startY
          const angle = Math.atan2(y, x)
          const inverseAngle = -angle
          const sinAngle = Math.sin(inverseAngle)
          const cosAngle = Math.cos(inverseAngle)
          const linearGradientStart = startX * cosAngle - startY * sinAngle
          const linearGradientEnd = endX * cosAngle - endY * sinAngle
          mainPass.borderLinearGradientStart = linearGradientStart
          mainPass.borderLinearGradientEnd = linearGradientEnd
          mainPass.borderLinearGradientAngle = angle
          mainPass.borderSinLinearGradientAngle = sinAngle
          mainPass.borderCosLinearGradientAngle = cosAngle
          mainPass.borderLinearGradientLength = linearGradientEnd - linearGradientStart
        } else if (gradient.type === "Radial") {
          const x = endX - startX
          const y = endY - startY
          mainPass.borderRadialGradientLength = 2 / Math.sqrt(x * x + y * y)
        }
        mainPass.borderGradientType = gradientType
        mainPass.borderGradientStartPosition = startPosition
      }
    }

    if (cache.stops !== stops) {
      cache.stops = stops
      mainPass.borderGradientStops = stops
    }
    this.refreshContentVisibility()
  }
}

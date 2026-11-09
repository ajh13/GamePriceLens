import animate, {CancelSet} from "InteractionKit.lspkg/Utils/animate"
import {withAlpha} from "InteractionKit.lspkg/Utils/color"
import Event from "InteractionKit.lspkg/Utils/Event"
import {CancelToken, clearTimeout, setTimeout} from "InteractionKit.lspkg/Utils/FunctionTimingUtils"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import ReplayEvent from "InteractionKit.lspkg/Utils/ReplayEvent"
import {ThemeService} from "./Themes/ThemeService"
import {IMAGE_MATERIAL_ASSET} from "./Utility/Assets"
import {setTextRect} from "./Utility/UIKitUtilities"
import {GradientParameters, RoundedRectangle} from "./Visuals/RoundedRectangle/RoundedRectangle"
import {Triangle} from "./Visuals/Triangle/Triangle"

const log = new NativeLogger("Tooltip")

export enum TailDirection {
  Down = "Down",
  Up = "Up",
  Left = "Left",
  Right = "Right"
}

const TOOLTIP_FADE_DURATION = 0.333
// Push the tail's base slightly past the backing's edge so anti-aliasing along
// the border doesn't leave a visible seam at the join.
const TOOLTIP_TAIL_SEAM_OVERLAP = 0.02

const DEFAULT_TAIL_COLOR: vec4 = vec4.one()
const DEFAULT_ICON_SIZE: number = 0.75

// The label/icon sit this far ahead of the backing in +Z (toward the viewer) so
// they read on top of it by depth, not by a render-order gap. Matches the 0.1cm
// z-step the rest of the kit uses to separate co-located surfaces.
const TOOLTIP_CONTENT_Z_OFFSET: number = 0.1

/**
 * Default visual parameters used when the active theme does not provide a
 * `Tooltip` entry in its `componentData`. Mirrors the System 2.0 look so the
 * Tooltip remains visually unchanged when no theme is bound.
 */
const TOOLTIP_DEFAULTS = {
  backingGradient: {
    enabled: true,
    type: "Rectangle",
    stop0: {enabled: true, percent: -1, color: new vec4(0.15, 0.15, 0.15, 1)},
    stop1: {enabled: true, percent: 1, color: new vec4(0.24, 0.24, 0.24, 1)}
  } as GradientParameters,
  borderGradient: {
    enabled: true,
    type: "Linear",
    start: new vec2(1, 1),
    end: new vec2(-1, -1),
    stop0: {enabled: true, percent: -1, color: new vec4(0.05, 0.05, 0.05, 1)},
    stop1: {enabled: true, percent: 1, color: new vec4(0.4, 0.4, 0.4, 1)}
  } as GradientParameters,
  borderSize: 0.05,
  text: {
    color: new vec4(0.72, 0.72, 0.72, 1),
    horizontalAlignment: HorizontalAlignment.Left,
    verticalAlignment: VerticalAlignment.Center,
    enableRichText: false
  },
  padding: new vec2(0.75, 0.75)
}
type TooltipParams = typeof TOOLTIP_DEFAULTS

@component
export class Tooltip extends BaseScriptComponent {
  @input
  @label("Theme")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Inherited", "Inherited"),
      new ComboBoxItem("System 2.0", "System2"),
      new ComboBoxItem("System 3.0", "System3")
    ])
  )
  @hint(
    "The theme used to style this tooltip. <code>Inherited</code> defers to the active global theme \
configured on a <code>ThemeManager</code> in the scene."
  )
  private _themeOverride: string = "Inherited"

  @input("int")
  private _renderOrder: number = 1000

  @input
  @widget(new TextAreaWidget())
  @hint("Tooltip body.")
  private _tip: string = "Helpful Hint"

  @input("float")
  @label("Fade-In Delay (ms)")
  @hint("Milliseconds to wait before the fade-in animation starts.")
  private _fadeInDelayMs: number = 50

  @input("float")
  @label("Fade-Out Delay (ms)")
  @hint("Milliseconds to wait before the fade-out animation starts.")
  private _fadeOutDelayMs: number = 0

  @input
  @label("Tail")
  @hint("Render a triangular connector hanging off one edge of the tooltip backing.")
  private _tailEnabled: boolean = false

  @input("vec2", "{1.0,0.6}")
  @label("Tail Size")
  @hint("Base width and apex-depth of the tail, in local-space centimeters.")
  @showIf("_tailEnabled", true)
  private _tailSize: vec2 = new vec2(1.0, 0.6)

  @input("string")
  @label("Tail Direction")
  @hint("Which edge of the tooltip backing the tail hangs off.")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Down"),
      new ComboBoxItem("Up"),
      new ComboBoxItem("Left"),
      new ComboBoxItem("Right")
    ])
  )
  @showIf("_tailEnabled", true)
  private _tailDirection: TailDirection = TailDirection.Down

  @input("float", "0")
  @label("Tail Offset")
  @hint(
    "Shifts the tail along the edge it's anchored to (centimeters). \
Positive moves toward +X for top/bottom edges, +Y for left/right edges."
  )
  @showIf("_tailEnabled", true)
  private _tailOffsetAlongEdge: number = 0

  @input
  @label("Use Icon")
  @hint("Display an icon alongside the tooltip text.")
  private _useIcon: boolean = false

  @input
  @showIf("_useIcon", true)
  @allowUndefined
  @label("Icon")
  @hint("Texture to display as the tooltip icon.")
  private _iconTexture: Texture | null = null

  @input("float", "1.0")
  @showIf("_useIcon", true)
  @label("Icon Size")
  @hint("Width and height of the icon in local-space centimeters.")
  private _iconSize: number = DEFAULT_ICON_SIZE

  @input("float", "0.5")
  @showIf("_useIcon", true)
  @label("Icon Gap")
  @hint("Gap between the icon and the text in local-space centimeters.")
  private _iconGap: number = 0.5

  private _cachedTooltipParams: TooltipParams | null = null
  private getTooltipParams(): TooltipParams {
    if (this._cachedTooltipParams) return this._cachedTooltipParams
    const mgr = ThemeService.getInstance()
    const theme =
      this._themeOverride !== "Inherited" ? (mgr.getTheme(this._themeOverride) ?? mgr.currentTheme) : mgr.currentTheme
    // Shallow-merge theme overrides onto defaults so themes can supply a subset
    // (e.g. only colors) without having to replicate the full TOOLTIP_DEFAULTS shape.
    const themeData = theme.componentData?.["Tooltip"] as Partial<TooltipParams> | undefined
    this._cachedTooltipParams = {...TOOLTIP_DEFAULTS, ...(themeData ?? {})}
    return this._cachedTooltipParams
  }

  private backing: RoundedRectangle
  private textComponent: Text
  private textTransform: Transform | null = null
  private tail: Triangle | null = null
  private iconSceneObject: SceneObject | null = null
  private iconTransform: Transform | null = null
  private iconImage: Image | null = null

  private fadeCancelSet: CancelSet = new CancelSet()
  private delayCancelToken: CancelToken | null = null

  private _size: vec2 = vec2.zero()

  // avoid creating new vecX instances for garbage collection optimization
  private _iconScale: vec3 = new vec3(DEFAULT_ICON_SIZE, DEFAULT_ICON_SIZE, 1)
  private _textPosition: vec3 = new vec3(0, 0, TOOLTIP_CONTENT_Z_OFFSET)
  private _iconPosition: vec3 = new vec3(0, 0, TOOLTIP_CONTENT_Z_OFFSET)
  private _tailPosition: vec3 = vec3.zero()

  private managedSceneObjects: SceneObject[] = []
  private managedComponents: Component[] = []

  private isUpdatingBackingSize: boolean = false
  private onCompleteHandlers: (() => void)[] = []

  private initialized: boolean = false

  private onDestroyEvent: Event = new Event()
  public readonly onDestroy = this.onDestroyEvent.publicApi()

  private readonly onInitializedEvent = new ReplayEvent<void>()
  public readonly onInitialized = this.onInitializedEvent.publicApi()

  private readonly onSizeChangedEvent = new ReplayEvent<vec2>()
  public readonly onSizeChanged = this.onSizeChangedEvent.publicApi()

  /**
   * The current tooltip text.
   * @returns The tooltip string associated with this instance.
   */
  public get tip(): string {
    return this._tip
  }

  /**
   * The current tooltip text.
   * @param value - The new tooltip text to display.
   */
  public set tip(value: string) {
    if (value === undefined) {
      return
    }
    this._tip = value
    if (this.textComponent) {
      if (this.textComponent.text !== this._tip) {
        this.textComponent.text = this._tip
        this.updateBackingSize()
      }
    }
  }

  /**
   * The render order of the tooltip.
   */
  public get renderOrder(): number {
    return this._renderOrder
  }

  /**
   * The render order of the tooltip.
   */
  public set renderOrder(value: number) {
    if (value === undefined) {
      return
    }
    this._renderOrder = value
    if (this.initialized) {
      this.backing.renderOrder = value
      this.textComponent.renderOrder = value + 1
      if (this.tail) {
        this.tail.renderOrder = value
      }
      if (this.iconImage) {
        this.iconImage.renderOrder = value + 1
      }
    }
  }

  /**
   * Whether the tail (triangular connector) is rendered.
   * Toggling this at runtime creates or destroys the tail SceneObject.
   */
  public get tailEnabled(): boolean {
    return this._tailEnabled
  }

  public set tailEnabled(value: boolean) {
    if (value === undefined || value === this._tailEnabled) return
    this._tailEnabled = value
    if (!this.initialized) return
    if (value && !this.tail) {
      this.createTail(this.getTooltipParams())
      this.positionTail()
    } else if (!value && this.tail) {
      this.destroyTail()
    }
  }

  /**
   * Which edge of the tooltip backing the tail hangs off.
   */
  public get tailDirection(): TailDirection {
    return this._tailDirection
  }

  public set tailDirection(value: TailDirection) {
    if (value === undefined || value === this._tailDirection) return
    this._tailDirection = value
    if (this.tail) {
      this.applyTailRotation()
      this.positionTail()
    }
  }

  /**
   * Base width (x) and apex-depth (y) of the tail, in local-space centimeters.
   */
  public get tailSize(): vec2 {
    return this._tailSize
  }

  public set tailSize(value: vec2) {
    if (value === undefined) return
    this._tailSize = value
    if (this.tail) {
      this.tail.size = value
      this.positionTail()
    }
  }

  /**
   * Shift along the edge the tail is anchored to (centimeters).
   */
  public get tailOffsetAlongEdge(): number {
    return this._tailOffsetAlongEdge
  }

  public set tailOffsetAlongEdge(value: number) {
    if (value === undefined || value === this._tailOffsetAlongEdge) return
    this._tailOffsetAlongEdge = value

    if (this.tail) {
      this.positionTail()
    }
  }

  /**
   * The icon texture displayed alongside the tooltip text.
   * Setting to `null` removes the icon.
   */
  public get icon(): Texture | null {
    return this._iconTexture
  }

  public set icon(value: Texture | null) {
    this._iconTexture = value
    this._useIcon = value !== null
    if (!this.initialized) return

    if (value && !this.iconSceneObject) {
      this.createIcon()
      this.updateBackingSize()
    } else if (value && this.iconImage) {
      this.iconImage.mainPass.baseTex = value
    } else if (!value && this.iconSceneObject) {
      this.destroyIcon()
      this.updateBackingSize()
    }
  }

  /**
   * Width and height of the icon in local-space centimeters.
   */
  public get iconSize(): number {
    return this._iconSize
  }

  public set iconSize(value: number) {
    if (value === undefined || value === this._iconScale.x) return
    this._iconSize = value
    this._iconScale.x = value
    this._iconScale.y = value
    if (this.iconSceneObject) {
      this.iconTransform.setLocalScale(this._iconScale)
      this.updateBackingSize()
    }
  }

  /**
   * Gap between the icon and the text in local-space centimeters.
   */
  public get iconGap(): number {
    return this._iconGap
  }

  public set iconGap(value: number) {
    if (value === undefined || value === this._iconGap) return
    this._iconGap = value
    if (this.iconSceneObject) {
      this.updateBackingSize()
    }
  }

  /**
   * Milliseconds to wait after `setOn(true)` before the fade-in animation
   * starts. Defaults to 0 (immediate).
   */
  public get fadeInDelayMs(): number {
    return this._fadeInDelayMs
  }

  public set fadeInDelayMs(value: number) {
    if (value === undefined) return
    this._fadeInDelayMs = Math.max(0, value)
  }

  /**
   * Milliseconds to wait after `setOn(false)` before the fade-out animation
   * starts. Defaults to 0 (immediate).
   */
  public get fadeOutDelayMs(): number {
    return this._fadeOutDelayMs
  }

  public set fadeOutDelayMs(value: number) {
    if (value === undefined) return
    this._fadeOutDelayMs = Math.max(0, value)
  }

  /**
   * Sets the tooltip's visibility state.
   *
   * @param isOn - If `true`, the tooltip will be shown; if `false`, it will be hidden.
   *
   * Respects `fadeInDelayMs` / `fadeOutDelayMs`: the corresponding delay
   * elapses before the fade animation begins. A subsequent call to `setOn`
   * cancels any pending delayed fade from a previous call.
   */
  public setOn(isOn: boolean) {
    if (this.delayCancelToken) {
      clearTimeout(this.delayCancelToken)
      this.delayCancelToken = null
    }

    if (!this.backing || !this.textComponent) return

    const delayMs = isOn ? this._fadeInDelayMs : this._fadeOutDelayMs
    if (delayMs > 0) {
      this.delayCancelToken = setTimeout(() => {
        this.delayCancelToken = null
        this.fadeAlpha(isOn ? 1 : 0, () => {})
      }, delayMs)
    } else {
      this.fadeAlpha(isOn ? 1 : 0, () => {})
    }
  }

  public updateBackingSize(onComplete?: () => void) {
    if (onComplete) {
      this.onCompleteHandlers.push(onComplete)
    }
    if (this.isUpdatingBackingSize) {
      return
    }
    this.isUpdatingBackingSize = true
  }

  private initialize(): void {
    if (this.initialized) return
    const params = this.getTooltipParams()

    this.backing = this.sceneObject.createComponent(RoundedRectangle.getTypeName())
    this.managedComponents.push(this.backing)
    this.backing.initialize()
    this.backing.gradient = true
    this.backing.setBackgroundGradient(params.backingGradient)
    this.backing.border = params.borderGradient.enabled
    this.backing.setBorderGradient(params.borderGradient)
    this.backing.borderSize = params.borderSize
    this.backing.renderMeshVisual.mainPass.blendMode = BlendMode.PremultipliedAlphaAuto
    // Depth-tested like the rest of the kit: the tooltip floats above the bar by
    // sitting nearer the viewer in +Z (see positionTooltip), and its label/icon
    // sit a further TOOLTIP_CONTENT_Z_OFFSET ahead of this backing — so layering
    // is decided by geometry, not by disabling depth or stacking render order.
    this.backing.renderMeshVisual.mainMaterial.mainPass.opacityFactor = 0
    this.backing.renderOrder = this._renderOrder
    this.backing.cornerRadius = 0.5

    if (this._tailEnabled) {
      this.createTail(params)
    }

    if (this._useIcon) {
      if (!this._iconTexture) {
        log.w("Tooltip: icon is enabled, but texture is not set. Icon will not be displayed.")
      } else {
        this.createIcon()
      }
    }

    const textObject = global.scene.createSceneObject("TooltipText")
    this.managedSceneObjects.push(textObject)
    textObject.layer = this.sceneObject.layer
    this.textComponent = textObject.createComponent("Component.Text")
    this.managedComponents.push(this.textComponent)

    this.textComponent.textFill.color = params.text.color
    this.textComponent.horizontalAlignment = params.text.horizontalAlignment
    this.textComponent.verticalAlignment = params.text.verticalAlignment
    this.textComponent.enableRichText = params.text.enableRichText
    this.textComponent.renderOrder = this._renderOrder + 1
    this.textComponent.text = this._tip

    this.textComponent.textFill.color = withAlpha(this.textComponent.textFill.color, 0)

    textObject.setParent(this.sceneObject)
    this.textTransform = textObject.getTransform()

    this.setOpacity(0)

    this.updateBackingSize()

    this.initialized = true
    this.onInitializedEvent.invoke()
  }

  public onAwake() {
    this.createEvent("OnStartEvent").bind(() => {
      this.initialize()
    })

    this.createEvent("LateUpdateEvent").bind(() => {
      if (this.isUpdatingBackingSize) {
        this.calculateBackingSize()
        this.onCompleteHandlers.forEach((handler) => {
          handler()
        })
        this.onCompleteHandlers = []
      }
    })

    this.createEvent("OnEnableEvent").bind(() => {
      // Re-enable managed components to match the current opacity, not unconditionally: a tooltip
      // re-enabled while faded to alpha 0 must stay released. Shape-backed components (backing, tail)
      // drive their own RMV from this enabled flag via Shape.OnEnable/OnDisable, so gating here never
      // resurrects a hidden renderable — unlike a blanket re-enable, which Shape's cascade turns back on.
      const visible = !isNull(this.backing) && this.backing.renderMeshVisual.mainPass.opacityFactor > 0
      this.managedComponents.forEach((component) => {
        if (!isNull(component) && component) {
          component.enabled = visible
        }
      })
    })

    this.createEvent("OnDisableEvent").bind(() => {
      this.managedComponents.forEach((component) => {
        if (!isNull(component) && component) {
          component.enabled = false
        }
      })
    })

    this.createEvent("OnDestroyEvent").bind(() => {
      if (this.delayCancelToken) {
        clearTimeout(this.delayCancelToken)
        this.delayCancelToken = null
      }
      this.fadeCancelSet.cancel()
      this.managedComponents.forEach((component) => {
        if (!isNull(component) && component) {
          component.destroy()
        }
      })
      this.managedComponents = []
      this.managedSceneObjects.forEach((sceneObject) => {
        if (!isNull(sceneObject) && sceneObject) {
          sceneObject.destroy()
        }
      })
      this.managedSceneObjects = []
      this.onDestroyEvent.invoke()
    })
  }

  private calculateBackingSize(): void {
    if (this.textComponent && this.backing) {
      const params = this.getTooltipParams()
      const textBoundingBox = this.textComponent.getBoundingBox()
      const textW = textBoundingBox.getSize().x
      const textH = textBoundingBox.getSize().y

      const hasIcon = this.iconSceneObject !== null
      const iconS = this._iconScale.x
      const iconExtra = hasIcon ? iconS + this._iconGap : 0
      this._size.x = textW + params.padding.x * 2 + iconExtra
      this._size.y = Math.max(textH, hasIcon ? iconS : 0) + params.padding.y * 2

      this.backing.size = this._size
      this.positionTail()

      setTextRect(this.textComponent, this.textComponent.sceneObject, textW, textH)

      if (hasIcon) {
        const halfW = this._size.x / 2
        const iconX = -halfW + params.padding.x + iconS / 2
        this._iconPosition.x = iconX
        this.iconTransform.setLocalPosition(this._iconPosition)

        // The backing grew by iconExtra but is centered at origin, so
        // half the extra went right — pushing the right edge past the
        // text. Shift the text right by half the extra so it's centered
        // in the text portion of the backing, not the full backing.
        this._textPosition.x = iconExtra / 2
        this.textTransform.setLocalPosition(this._textPosition)
      } else {
        this._textPosition.x = 0
        this.textTransform.setLocalPosition(this._textPosition)
      }

      this.isUpdatingBackingSize = false
      this.onSizeChangedEvent.invoke(new vec2(this._size.x, this._size.y))
    }
  }

  private setOpacity(opacity: number): void {
    // Drive enabled-state from opacity so a faded tooltip releases its renderables instead of holding
    // render/mask cost at alpha 0. For Shape-backed visuals (backing, tail) toggle the component, not
    // the RMV directly: Shape mirrors its RMV from the component's enabled flag (Shape.OnEnable/
    // OnDisable), so the component stays the single owner and we don't fight Shape's enable cascade
    // (e.g. when the host SceneObject is re-enabled).
    this.backing.renderMeshVisual.mainPass.opacityFactor = opacity
    this.backing.enabled = opacity > 0
    this.textComponent.textFill.color = withAlpha(this.textComponent.textFill.color, opacity)
    this.textComponent.enabled = opacity > 0
    if (this.tail) {
      this.tail.opacity = opacity
      this.tail.enabled = opacity > 0
    }
    if (this.iconImage) {
      this.iconImage.mainPass.baseColor = withAlpha(this.iconImage.mainPass.baseColor, opacity)
      this.iconImage.enabled = opacity > 0
    }
  }

  private createTail(params: TooltipParams): void {
    const tailObject = global.scene.createSceneObject("TooltipTail")
    this.managedSceneObjects.push(tailObject)
    tailObject.layer = this.sceneObject.layer
    tailObject.setParent(this.sceneObject)

    const tail = tailObject.createComponent(Triangle.getTypeName()) as Triangle
    this.managedComponents.push(tail)
    tail.size = this._tailSize
    tail.baseColor = this.resolveTailColor(params)
    tail.initialize()
    tail.renderMeshVisual.mainPass.blendMode = BlendMode.PremultipliedAlphaAuto
    // Layer the tail by depth like the backing, not by draw order. Under a
    // hierarchy-sorted Canvas the surrounding UI (e.g. a toolbar) draws by depth;
    // the tail's Triangle.mat ships depthTest/depthWrite off, so it neither wins
    // depth against nearer UI nor writes depth to protect its own pixels, and any
    // overlapping surface overdraws it. Enabling both lets the tail sit in front
    // via its +Z offset, exactly as the depth-tested backing already does.
    tail.renderMeshVisual.mainMaterial.mainPass.depthTest = true
    tail.renderMeshVisual.mainMaterial.mainPass.depthWrite = true
    tail.renderOrder = this._renderOrder
    tail.opacity = this.backing.renderMeshVisual.mainPass.opacityFactor

    this.tail = tail
    this.applyTailRotation()
  }

  private destroyTail(): void {
    if (!this.tail) return
    const tailObj = this.tail.sceneObject
    const idx = this.managedComponents.indexOf(this.tail)
    if (idx !== -1) this.managedComponents.splice(idx, 1)
    const objIdx = this.managedSceneObjects.indexOf(tailObj)
    if (objIdx !== -1) this.managedSceneObjects.splice(objIdx, 1)
    tailObj.destroy()
    this.tail = null
  }

  private applyTailRotation(): void {
    if (!this.tail) return
    let rotZ = 0
    // The unit mesh's apex points toward -Y. Rotate around +Z (right-hand rule)
    // to retarget: +π/2 sweeps -Y → +X (Right), -π/2 sweeps -Y → -X (Left).
    switch (this._tailDirection) {
      case TailDirection.Up:
        rotZ = Math.PI
        break
      case TailDirection.Right:
        rotZ = Math.PI / 2
        break
      case TailDirection.Left:
        rotZ = -Math.PI / 2
        break
      case TailDirection.Down:
      default:
        rotZ = 0
        break
    }
    this.tail.transform.setLocalRotation(quat.angleAxis(rotZ, vec3.forward()))
  }

  /**
   * Creates the icon Image following the same pattern as ElementContent's
   * createIconSceneObject: a SceneObject with an Image component using a
   * cloned IMAGE_MATERIAL_ASSET, sized via local scale.
   */
  private createIcon(): void {
    if (!this._iconTexture) return

    const iconObject = global.scene.createSceneObject("TooltipIcon")
    this.managedSceneObjects.push(iconObject)
    iconObject.layer = this.sceneObject.layer
    iconObject.setParent(this.sceneObject)

    const image = iconObject.createComponent("Component.Image") as Image
    image.mainMaterial = IMAGE_MATERIAL_ASSET.clone()
    image.mainPass.baseTex = this._iconTexture
    image.stretchMode = StretchMode.Stretch
    image.verticalAlignment = VerticalAlignment.Center
    image.horizontalAlignment = HorizontalAlignment.Center
    image.renderOrder = this._renderOrder + 1
    image.mainPass.baseColor = withAlpha(image.mainPass.baseColor, this.backing.renderMeshVisual.mainPass.opacityFactor)
    this.managedComponents.push(image)

    this._iconScale.x = this._iconSize
    this._iconScale.y = this._iconSize

    this.iconTransform = iconObject.getTransform()
    this.iconTransform.setLocalScale(this._iconScale)

    this.iconSceneObject = iconObject
    this.iconImage = image
  }

  private destroyIcon(): void {
    if (!this.iconSceneObject) return
    const idx = this.managedComponents.indexOf(this.iconImage!)
    if (idx !== -1) this.managedComponents.splice(idx, 1)
    const objIdx = this.managedSceneObjects.indexOf(this.iconSceneObject)
    if (objIdx !== -1) this.managedSceneObjects.splice(objIdx, 1)
    this.iconSceneObject.destroy()
    this.iconSceneObject = null
    this.iconTransform = null
    this.iconImage = null
  }

  /**
   * Resolves the tail's solid fill color. Defaults to the backing gradient's
   * primary stop, which matches the System 3.0 design (uniform fill) and the
   * System 2.0 default (the tail isn't rendered there anyway).
   */
  private resolveTailColor(params: TooltipParams): vec4 {
    return params.backingGradient.stop0?.color ?? DEFAULT_TAIL_COLOR
  }

  /**
   * Snaps the tail to the appropriate edge of the freshly-sized backing.
   * `_tailOffsetAlongEdge` shifts the tail along the parallel axis (e.g.
   * left/right along the bottom edge for `Down`).
   */
  private positionTail(): void {
    if (!this.tail) return
    const offset = this._tailOffsetAlongEdge
    const halfW = this._size.x / 2
    const halfH = this._size.y / 2
    const seam = TOOLTIP_TAIL_SEAM_OVERLAP

    switch (this._tailDirection) {
      case TailDirection.Up:
        this._tailPosition.x = offset
        this._tailPosition.y = halfH - seam
        this._tailPosition.z = 0
        break
      case TailDirection.Left:
        this._tailPosition.x = -halfW + seam
        this._tailPosition.y = offset
        this._tailPosition.z = 0
        break
      case TailDirection.Right:
        this._tailPosition.x = halfW - seam
        this._tailPosition.y = offset
        this._tailPosition.z = 0
        break
      case TailDirection.Down:
      default:
        this._tailPosition.x = offset
        this._tailPosition.y = -halfH + seam
        this._tailPosition.z = 0
        break
    }
    this.tail.transform.setLocalPosition(this._tailPosition)
  }

  private fadeAlpha = (alpha: number, onComplete: () => void = () => {}) => {
    const startingOpacity = this.backing.renderMeshVisual.mainPass.opacityFactor
    this.fadeCancelSet.cancel()
    animate({
      duration: TOOLTIP_FADE_DURATION * Math.abs(alpha - startingOpacity),
      cancelSet: this.fadeCancelSet,
      update: (t) => {
        this.setOpacity(MathUtils.lerp(startingOpacity, alpha, t))
      },
      ended: () => {
        onComplete()
      }
    })
  }
}

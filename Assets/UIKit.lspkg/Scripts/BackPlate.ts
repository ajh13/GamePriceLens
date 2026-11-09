import {Interactable, TargetingVisual} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {InteractionPlane} from "InteractionKit.lspkg/Components/Interaction/InteractionPlane/InteractionPlane"
import Event from "InteractionKit.lspkg/Utils/Event"
import ReplayEvent from "InteractionKit.lspkg/Utils/ReplayEvent"
import {Layoutable} from "./Components/Layout2D/Layoutable"
import {UIKitBrands} from "./Components/Layout2D/UIKitBrands"
import {HSVtoRGB} from "./Utility/UIKitUtilities"
import {GradientParameters, RoundedRectangle} from "./Visuals/RoundedRectangle/RoundedRectangle"

const BackPlateDepth = 1

const BackPlateConstants = {
  nearFieldInteractionZoneDistance: 15
}

export type BackPlateStyle = "default" | "dark" | "simple"

type BackPlateBackgroundStyle = {
  background: GradientParameters | vec4
}

type BackPlateColors = {
  [key: string]: BackPlateBackgroundStyle
}

const BackPlateColors: BackPlateColors = {
  dark: {
    background: {
      type: "Linear",
      start: new vec2(-1.3, 1.25),
      end: new vec2(1.25, -1.3),
      stop0: {
        enabled: true,
        color: HSVtoRGB(0, 0.0, 0.09, 1),
        percent: 0
      },
      stop1: {
        enabled: true,
        color: HSVtoRGB(0, 0.0, 0.26, 1),
        percent: 1
      }
    }
  },
  default: {
    background: {
      type: "Radial",
      start: new vec2(-0.05, 0.5),
      end: new vec2(0.7, -0.8),
      stop0: {
        enabled: true,
        color: HSVtoRGB(0, 0.0, 0.27, 1),
        percent: 0
      },
      stop1: {
        enabled: true,
        color: HSVtoRGB(0, 0.0, 0.11, 1),
        percent: 1
      }
    }
  },
  simple: {background: HSVtoRGB(0, 0.0, 0.17, 1)}
}

/**
 * The BackPlate component creates a customizable back plate with a rounded rectangle shape.
 * It supports different styles and sizes, and includes an interactable component for user interaction.
 * BackPlate can be used as a background for other UI elements.
 */
@component
export class BackPlate extends BaseScriptComponent implements Layoutable {
  /**
   * Type brand consumed by the Layout2D `ElementHandler` finder. BackPlate
   * is `Layoutable` (has width/height/onSizeChanged) but doesn't extend
   * Element, so we brand it explicitly. See
   * `Components/Layout2D/UIKitBrands.ts`.
   */
  public readonly __uikitBrand = UIKitBrands.Element

  @input("int")
  private _renderOrder: number = 0

  @input
  private _size: vec2 = new vec2(10, 10)

  private _depth: number = BackPlateDepth

  @input
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Default", "default"),
      new ComboBoxItem("Dark", "dark"),
      new ComboBoxItem("Simple", "simple")
    ])
  )
  private _style: string = "default"
  @ui.separator
  @ui.group_start("Interaction Plane")
  @hint("Settings for an interaction plane that extends around the frame.")
  /**
   * Enables an Interaction Plane that creates a near-field targeting zone around the frame that improves
   * precision when interacting with buttons and UI elements using hand tracking.
   */
  @input
  @hint(
    "Enables an Interaction Plane that creates a near-field targeting zone around the frame that improves \
precision when interacting with buttons and UI elements using hand tracking."
  )
  private _enableInteractionPlane: boolean = true

  @input
  @showIf("_enableInteractionPlane")
  @hint("Offset position for the interaction plane relative to the frame center.")
  private _interactionPlaneOffset: vec3 = new vec3(0, 0, 0)

  /**
   * Get the offset position for the interaction plane relative to the frame center.
   */
  public get interactionPlaneOffset(): vec3 {
    return this._interactionPlaneOffset
  }

  /**
   * Set the offset position for the interaction plane relative to the frame center.
   * @param offset - The new offset.
   */
  public set interactionPlaneOffset(offset: vec3) {
    this._interactionPlaneOffset = offset
    this.updateInteractionPlane()
  }

  @input
  @showIf("_enableInteractionPlane")
  @hint("Padding that extends the InteractionPlane size.")
  private _interactionPlanePadding: vec2 = new vec2(0, 0)
  @ui.group_end

  /**
   * Sets the preferred targeting visual.
   * An enclosing InteractionPlane's value overrides this unless `ignoreInteractionPlane` is set.
   * - 0: None
   * - 1: Cursor (default)
   * - 2: Ray
   */
  @input
  @showIf("_enableInteractionPlane")
  @hint(
    "Sets the preferred targeting visual. An enclosing InteractionPlane overrides this unless Ignore Interaction Plane is set.\n\n\
- 0: None\n\
- 1: Cursor (default)\n\
- 2: Ray"
  )
  @widget(new ComboBoxWidget([new ComboBoxItem("None", 0), new ComboBoxItem("Cursor", 1), new ComboBoxItem("Ray", 2)]))
  private _targetingVisual: number = TargetingVisual.Cursor

  /**
   * Get the size of the padding around the InteractionPlane.
   */
  public get interactionPlanePadding(): vec2 {
    return this._interactionPlanePadding
  }

  /**
   * Set the size of the padding around the InteractionPlane.
   * @param padding - The new padding.
   */
  public set interactionPlanePadding(padding: vec2) {
    this._interactionPlanePadding = padding
    this.updateInteractionPlane()
  }

  private roundedRectangle: RoundedRectangle
  private collider: ColliderComponent
  private colliderShape: BoxShape = Shape.createBoxShape()

  private _interactable: Interactable
  private managedComponents: Component[] = []

  private _interactionPlane!: InteractionPlane
  private _interactionPlaneTransform: Transform | null = null

  public get interactionPlane() {
    return this._interactionPlane
  }

  private set interactionPlane(interactionPlane: InteractionPlane) {
    this._interactionPlane = interactionPlane
    this._interactionPlaneTransform = interactionPlane.getTransform()
  }

  private _initialized = false

  public get initialized(): boolean {
    return this._initialized
  }

  private _onInitializedEvent = new ReplayEvent<void>()
  public readonly onInitialized = this._onInitializedEvent.publicApi()

  private _onSizeChangedEvent = new Event<vec3>()
  public readonly onSizeChanged = this._onSizeChangedEvent.publicApi()

  /**
   * Sets the size of the back plate.
   * @param size The new size of the back plate.
   * The size is a vec2 representing the width and height of the back plate.
   * The collider shape is also updated to match the new size.
   */
  public set size(size: vec2) {
    if (size === undefined) {
      return
    }
    this._size = size
    if (this.initialized) {
      this.roundedRectangle.size = size
      this.colliderShape.size = new vec3(size.x, size.y, this._depth)
      this.collider.shape = this.colliderShape
      this.updateInteractionPlane()
      this._onSizeChangedEvent.invoke(this.layoutSize)
    }
  }

  /**
   * Gets the size of the back plate.
   * @returns The current size of the back plate.
   */
  public get size(): vec2 {
    return this._size
  }

  /**
   * Gets the layout size of the back plate as a 3D vector.
   * @returns The layout size with width, height, and depth.
   */
  public get layoutSize(): vec3 {
    return new vec3(this._size.x, this._size.y, this._depth)
  }

  /**
   * Gets the width of the back plate.
   * @returns The current width of the back plate.
   */
  public get width(): number {
    return this._size.x
  }

  /**
   * Sets the width of the back plate.
   * @param value - The new width value.
   */
  public set width(value: number) {
    this.size = new vec2(value, this._size.y)
  }

  /**
   * Gets the height of the back plate.
   * @returns The current height of the back plate.
   */
  public get height(): number {
    return this._size.y
  }

  /**
   * Sets the height of the back plate.
   * @param value - The new height value.
   */
  public set height(value: number) {
    this.size = new vec2(this._size.x, value)
  }

  /**
   * Gets the depth of the back plate.
   * @returns The current depth of the back plate.
   */
  public get depth(): number {
    return this._depth
  }

  /**
   * Sets the depth of the back plate.
   * This is a no-op as depth is not configurable for 2D components.
   * @param value - The new depth value (ignored).
   */
  public set depth(value: number) {
    // No-op, depth is not configurable for 2D component
  }

  /**
   * Gets the render order of the back plate.
   * @returns The current render order value.
   */
  public get renderOrder(): number {
    return this._renderOrder
  }

  /**
   * Sets the render order of the back plate.
   * @param value - The new render order value.
   */
  public set renderOrder(value: number) {
    if (value === undefined) {
      return
    }
    this._renderOrder = value
    if (this.initialized) {
      this.roundedRectangle.renderOrder = value
    }
  }

  /**
   * Gets the interactable component of the back plate.
   * @returns The interactable component associated with the back plate.
   */
  public get interactable(): Interactable {
    return this._interactable
  }

  /**
   * Sets the style of the back plate.
   * @param style The new style of the back plate.
   * The style can be "default", "dark", or "simple".
   */
  public get style(): string {
    return this._style
  }

  /**
   * Sets the style of the back plate.
   * The style determines the background gradient and color of the back plate.
   * - "default" has lighter gradient.
   * - "dark" has darker gradient.
   * - "simple" uses a solid color.
   * @param style The new style of the back plate.
   */
  public set style(style: BackPlateStyle) {
    if (style === undefined) {
      return
    }
    this._style = style
    if (this.initialized) {
      if (style !== "simple") {
        this.roundedRectangle.gradient = true
        this.roundedRectangle.setBackgroundGradient(BackPlateColors[style].background as GradientParameters)
      } else {
        this.roundedRectangle.gradient = false
        this.roundedRectangle.backgroundColor = BackPlateColors.simple.background as vec4
      }
    }
  }

  public onAwake() {
    this.roundedRectangle = this.sceneObject.createComponent(RoundedRectangle.getTypeName())
    this.managedComponents.push(this.roundedRectangle)

    this.createEvent("OnStartEvent").bind(this.initialize.bind(this))
    this.createEvent("OnEnableEvent").bind(() => {
      this.managedComponents.forEach((component) => {
        if (!isNull(component) && component) {
          component.enabled = true
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
      this.managedComponents.forEach((component) => {
        if (!isNull(component) && component) {
          component.destroy()
        }
      })
      this.managedComponents = []
    })
  }

  private initialize() {
    this.roundedRectangle.initialize()
    this.roundedRectangle.renderMeshVisual.mainPass.blendMode = BlendMode.PremultipliedAlphaAuto
    this.roundedRectangle.renderMeshVisual.mainPass.colorMask = new vec4b(true, true, true, true)
    this.roundedRectangle.renderOrder = this._renderOrder
    this.collider = this.sceneObject.createComponent("ColliderComponent")
    this.managedComponents.push(this.collider)
    this.collider.fitVisual = false
    this.collider.shape = this.colliderShape
    // TODO: consider replacing with lighter weight solution
    this._interactable = this.sceneObject.createComponent(Interactable.getTypeName())
    this.managedComponents.push(this._interactable)

    if (this._style !== "simple") {
      this.roundedRectangle.gradient = true
      this.roundedRectangle.setBackgroundGradient(BackPlateColors[this._style].background as GradientParameters)
    } else {
      this.roundedRectangle.gradient = false
      this.roundedRectangle.backgroundColor = BackPlateColors.simple.background as vec4
    }

    this.roundedRectangle.size = this._size
    this.colliderShape.size = new vec3(this._size.x, this._size.y, this._depth)
    this.collider.shape = this.colliderShape

    this._interactionPlane = this.sceneObject.createComponent(InteractionPlane.getTypeName())
    this.managedComponents.push(this._interactionPlane)
    this._interactionPlane.proximityDistance = BackPlateConstants.nearFieldInteractionZoneDistance
    this._interactionPlane.targetingVisual = this._targetingVisual
    this._interactionPlane.enabled = this._enableInteractionPlane
    this._interactionPlaneTransform = this._interactionPlane.getTransform()
    this.updateInteractionPlane()

    this._initialized = true
    this._onInitializedEvent.invoke()
  }

  private updateInteractionPlane() {
    if (!this._interactionPlane || !this._interactionPlaneTransform) {
      return
    }

    const paddedSize = this.size.add(this._interactionPlanePadding)
    this._interactionPlane.planeSize = paddedSize
    this._interactionPlane.offset = this._interactionPlaneOffset
    this._interactionPlane.targetingVisual = this._targetingVisual
  }
}

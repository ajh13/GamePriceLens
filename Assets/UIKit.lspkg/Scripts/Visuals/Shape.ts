import Event, {PublicApi} from "InteractionKit.lspkg/Utils/Event"
import ReplayEvent from "InteractionKit.lspkg/Utils/ReplayEvent"
import {Layoutable} from "../Components/Layout2D/Layoutable"
import {UIKitBrands} from "../Components/Layout2D/UIKitBrands"
import {isEqual} from "../Utility/UIKitUtilities"
// Side-effect import — register UIKit Layout2D handlers. Shape doesn't
// extend Element, so it needs its own bootstrap reference.
import "../UIKitBootstrap"

export abstract class Shape extends BaseScriptComponent implements Layoutable {
  /**
   * Type brand consumed by the Layout2D `ShapeHandler` finder. See
   * `Components/Layout2D/UIKitBrands.ts`.
   */
  public readonly __uikitBrand = UIKitBrands.Shape

  @input("number", "0")
  protected _renderOrder: number = 0

  @input("vec2", "{1,1}")
  @hint("Size of Shape In Local Space Centimeters")
  protected _size: vec2 = new vec2(1, 1)

  @input
  protected _depth: number = 1

  protected _transform: Transform = this.sceneObject.getTransform()
  protected _material: Material
  protected _usesCustomMaterial: boolean = false
  protected _rmv: RenderMeshVisual

  protected _initialized: boolean = false

  // Keeps the RenderMeshVisual off while the Shape stays enabled, for owners that stop drawing
  // when nothing of the pass is visible. The enable handler respects it, so a SceneObject enable
  // cycle can't silently turn the visual back on.
  private _renderSuppressed: boolean = false

  private onInitializedEvent: ReplayEvent<void> = new ReplayEvent<void>()
  private _onInitialized?: PublicApi<void>
  public get onInitialized(): PublicApi<void> {
    return (this._onInitialized ??= this.onInitializedEvent.publicApi())
  }

  private onSizeChangedEvent: Event<vec3> = new Event<vec3>()
  private _onSizeChanged?: PublicApi<vec3>
  /**
   * An event that is triggered when the size or depth of the shape changes.
   * The event payload is a vec3(width, height, depth).
   */
  public get onSizeChanged(): PublicApi<vec3> {
    return (this._onSizeChanged ??= this.onSizeChangedEvent.publicApi())
  }

  protected abstract configureMesh(): void
  protected abstract updateSize(): void
  protected abstract get materialSource(): Material

  /**
   * Gets whether the shape is initialized.
   * @returns True if the shape is initialized, false otherwise.
   */
  public get initialized(): boolean {
    return this._initialized
  }

  /**
   * Gets the layout width in local space centimeters.
   * @returns The current width of the shape.
   */
  public get width(): number {
    return this._size.x
  }

  /**
   * Sets the layout width in local space centimeters.
   * @param value - The new width value.
   */
  public set width(value: number) {
    this.size = new vec2(value, this._size.y)
  }

  /**
   * Gets the layout height in local space centimeters.
   * @returns The current height of the shape.
   */
  public get height(): number {
    return this._size.y
  }

  /**
   * Sets the layout height in local space centimeters.
   * @param value - The new height value.
   */
  public set height(value: number) {
    this.size = new vec2(this._size.x, value)
  }

  /**
   * Gets the layout size as a vec3 (width, height, depth).
   * @returns The layout size with width, height, and depth.
   */
  public get layoutSize(): vec3 {
    return this.shapeSize
  }

  /**
   * Gets the transform of the Shape.
   * @returns The transform of the shape.
   */
  public get transform(): Transform {
    return this._transform
  }

  /**
   * Gets the render mesh visual of the Shape.
   * @returns The render mesh visual of the shape.
   */
  public get renderMeshVisual(): RenderMeshVisual {
    return this._rmv
  }

  /**
   * Whether the render mesh visual is kept off while the Shape itself stays enabled.
   * Use this rather than writing `renderMeshVisual.enabled`, which the Shape resets to true
   * whenever its SceneObject is re-enabled.
   */
  public get renderSuppressed(): boolean {
    return this._renderSuppressed
  }

  public set renderSuppressed(value: boolean) {
    if (value === this._renderSuppressed) {
      return
    }
    this._renderSuppressed = value
    if (this._initialized && !isNull(this._rmv)) {
      this._rmv.enabled = !value && this.isEnabledInHierarchy
    }
  }

  /**
   * Gets the size of the Shape in centimeters in local space.
   * @returns The size as a vec2.
   */
  public get size(): vec2 {
    return this._size
  }

  /**
   * Sets the size of the Shape in centimeters in local space.
   *
   * Stores by copy via `copyFrom` (matching `Element.set size`) — callers
   * may reuse the same vec2 reference across multiple Shapes, and external
   * mutation of the passed vec2 after the call does not alias this Shape's
   * `_size`. Short-circuits if the new size equals the current one.
   *
   * @param size - A `vec2` object representing the dimensions of the Shape.
   */
  public set size(size: vec2) {
    if (size === undefined) {
      return
    }
    if (isEqual<vec2>(this._size, size)) {
      return
    }
    this._size.copyFrom(size)
    if (this._initialized) {
      this.updateSize()
      this.onSizeChangedEvent.invoke(this.shapeSize)
    }
  }

  /**
   * The depth of the Shape.
   *
   * @returns The depth of the Shape.
   */
  public get depth(): number {
    return this._depth
  }

  /**
   * Set the depth of the Shape.
   *
   * @param depth - The new depth of the Shape.
   */
  public set depth(depth: number) {
    if (depth === undefined) {
      return
    }
    this._depth = depth
    if (this._initialized) {
      this.updateSize()
      this.onSizeChangedEvent.invoke(this.shapeSize)
    }
  }

  /**
   * The render order of the Shape.
   */
  public get renderOrder(): number {
    return this._renderOrder
  }

  /**
   * The render order of the Shape.
   */
  public set renderOrder(value: number) {
    if (value === undefined) {
      return
    }
    this._renderOrder = value
    if (this._initialized) {
      this._rmv.renderOrder = value
    }
  }

  public onAwake() {
    this.createEvent("OnStartEvent").bind(() => {
      this.initialize()
    })
    this.createEvent("OnEnableEvent").bind(() => {
      if (this._initialized) {
        if (!isNull(this._rmv)) {
          this._rmv.enabled = !this._renderSuppressed
        }
      }
    })
    this.createEvent("OnDisableEvent").bind(() => {
      if (this._initialized) {
        if (!isNull(this._rmv)) {
          this._rmv.enabled = false
        }
      }
    })
    this.createEvent("OnDestroyEvent").bind(() => {
      if (!isNull(this._rmv)) {
        this._rmv.destroy()
      }
      this._rmv = null
    })
  }

  public initialize(): void {
    if (this._initialized) return

    // setup mesh
    this._rmv = this.sceneObject.createComponent("RenderMeshVisual")
    if (this._renderSuppressed) {
      this._rmv.enabled = false
    }
    // A pre-set material that isn't the stock asset means the caller swapped
    // in a bespoke shader (Frame body/panel compose materials) — subclasses
    // use this to keep shader-coupled features on the legacy path.
    this._usesCustomMaterial = !!this._material && this._material !== this.materialSource
    if (!this._material) {
      this._material = this.materialSource
    }
    this._material = this._material.clone()
    this._rmv.mainMaterial = this._material

    this.configureMesh()
    this.updateRenderOrder()
    this.updateSize()
    this._initialized = true
    this.onInitializedEvent.invoke()
  }

  protected updateRenderOrder(): void {
    this._rmv.renderOrder = this._renderOrder
  }

  /**
   * Gets the shape size as a vec3 (width, height, depth).
   */
  private get shapeSize(): vec3 {
    return new vec3(this._size.x, this._size.y, this._depth)
  }
}

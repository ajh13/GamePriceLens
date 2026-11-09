import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {TargetingMode} from "InteractionKit.lspkg/Core/Interactor/Interactor"
import {InteractorEvent} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import animate, {CancelSet} from "InteractionKit.lspkg/Utils/animate"
import Event from "InteractionKit.lspkg/Utils/Event"
import {UNIT_PLANE_MESH_ASSET} from "../../../../Utility/Assets"
import {reappendChild} from "../../../../Utility/SceneUtilities"
import {LINE_CENTER_OFFSET_RATIO} from "../../../../Utility/TextManipulationUtils"
import {colorLerp} from "../../../../Utility/UIKitUtilities"
import type {HighlightRect} from "./HighlightRenderer"

const GRAB_HANDLE_MATERIAL_ASSET: Material = requireAsset("../../../../../Materials/GrabHandleMat.mat") as Material

// Handle size ratios relative to visual height
export const HANDLE_WIDTH_RATIO = 0.15 // Width as fraction of visual height
export const HANDLE_HEIGHT_RATIO = 1.3

export const HANDLE_DEFAULT_COLOR = new vec4(85 / 255, 115 / 255, 101 / 255, 0.4)
export const HANDLE_ACTIVE_COLOR = new vec4(1, 1, 1, 0.4)

// Foreground-most of the text-manipulation visuals; the Z ladder (highlight
// 0.005 -> caret 0.008 -> handles) is cosmetic agreement with the draw order,
// see CaretRenderer.
const HANDLE_Z_OFFSET = 0.01

// Collider size ratio
const HANDLE_COLLIDER_RELATIVE_WIDTH = 5
const HANDLE_COLLIDER_RELATIVE_HEIGHT = 2
const HANDLE_COLLIDER_DEPTH = 0.1

// Animation
const COLOR_ANIMATION_DURATION = 0.15
const SNAP_BACK_ANIMATION_DURATION = 0.2

/**
 * Event payload for handle drag updates.
 */
export type HandleDragUpdateEvent = {
  dragStartWorldPosition: vec3
  dragCurrentWorldPosition: vec3
}

/**
 * Physical side where the grab handle sits relative to its highlight anchor side.
 */
export type HandleSide = "left" | "right"

/**
 * Handles visual rendering and interaction for a text selection grab handle.
 */
export class GrabHandle {
  private readonly sceneObject: SceneObject
  private readonly transform: Transform
  private readonly interactable: Interactable
  private readonly collider: ColliderComponent
  private readonly handleSide: HandleSide
  private readonly rmv: RenderMeshVisual

  private readonly colorAnimationCancelSet = new CancelSet()
  private readonly positionAnimationCancelSet = new CancelSet()

  private isHovered: boolean = false
  private isDragging: boolean = false
  private readonly targetPosition: vec3 = vec3.zero()
  private readonly _compensatedAnchorPosition: vec3 = vec3.zero()

  private readonly _handlePosition: vec3 = vec3.zero()
  private readonly _handleScale: vec3 = vec3.one()
  private readonly _handleColor: vec4 = vec4.zero()
  private readonly _defaultColor: vec4 = vec4.zero()
  private readonly _activeColor: vec4 = vec4.zero()
  private readonly _startPosition: vec3 = vec3.zero()
  private readonly _startColor: vec4 = vec4.zero()
  private readonly _endColor: vec4 = vec4.zero()

  // Visual height for scaling - all sizes derive from this
  private _visualHeight: number = 0
  private _handleWidth: number = 0

  private dragStartWorldPos: vec3 | null = null

  private unsubscribes: (() => void)[] = []

  private readonly onDragUpdateEvent: Event<HandleDragUpdateEvent> = new Event<HandleDragUpdateEvent>()

  /**
   * Event triggered when the handle is dragged.
   */
  public readonly onDragUpdate = this.onDragUpdateEvent.publicApi()

  private readonly onDragStartEvent: Event<InteractorEvent> = new Event<InteractorEvent>()

  /**
   * Event triggered when the handle drag starts.
   */
  public readonly onDragStart = this.onDragStartEvent.publicApi()

  private readonly onDragEndEvent: Event<InteractorEvent> = new Event<InteractorEvent>()

  /**
   * Event triggered when the handle drag ends.
   */
  public readonly onDragEnd = this.onDragEndEvent.publicApi()

  /**
   * Gets the local position of the handle.
   */
  public get position(): vec3 {
    return this.transform.getLocalPosition()
  }

  /**
   * Sets the local position of the handle, cancelling any ongoing snap-back animations.
   *
   * @param pos - The new local position
   */
  public set position(pos: vec3) {
    this.targetPosition.x = pos.x
    this.targetPosition.y = pos.y
    this.targetPosition.z = pos.z
    // Cancel any ongoing snap-back animations so it doesn't fight this setter
    this.positionAnimationCancelSet.cancel()
    this.transform.setLocalPosition(pos)
  }

  public get defaultColor(): vec4 {
    return this._defaultColor
  }

  public set defaultColor(color: vec4) {
    if (color === undefined) return

    this._defaultColor.copyFrom(color)
    if (!this.isHovered && !this.isDragging) {
      this.colorAnimationCancelSet.cancel()
      this.setHandleColor(this._defaultColor)
    }
  }

  public get activeColor(): vec4 {
    return this._activeColor
  }

  public set activeColor(color: vec4) {
    if (color === undefined) return

    this._activeColor.copyFrom(color)
    if (this.isHovered || this.isDragging) {
      this.colorAnimationCancelSet.cancel()
      this.setHandleColor(this._activeColor)
    }
  }

  public constructor(
    parent: SceneObject,
    renderOrder: number,
    handleSide: HandleSide,
    defaultColor: vec4 = HANDLE_DEFAULT_COLOR,
    activeColor: vec4 = HANDLE_ACTIVE_COLOR
  ) {
    this.handleSide = handleSide
    this._defaultColor.copyFrom(defaultColor)
    this._activeColor.copyFrom(activeColor)

    // Create scene object
    this.sceneObject = global.scene.createSceneObject(`Handle_${handleSide}`)
    // Layer is not inherited from the parent; copy it so the Text's Camera renders the handle.
    this.sceneObject.layer = parent.layer
    this.sceneObject.setParent(parent)
    this.transform = this.sceneObject.getTransform()

    // Create visual
    this.rmv = this.sceneObject.createComponent("RenderMeshVisual")
    this.rmv.mesh = UNIT_PLANE_MESH_ASSET
    this.rmv.mainMaterial = GRAB_HANDLE_MATERIAL_ASSET.clone()
    // Transparent chrome: depth-test, never depth-write (see CaretRenderer).
    // GrabHandleMat.mat already ships these flags; set here so the invariant
    // does not depend on the asset.
    this.rmv.mainMaterial.mainPass.depthTest = true
    this.rmv.mainMaterial.mainPass.depthWrite = false
    // Flat by default; TextManipulationModule.applyRenderOrders owns the
    // no-Canvas fallback bump.
    this.rmv.setRenderOrder(renderOrder)
    this.setHandleColor(this._defaultColor)

    // Create collider
    this.collider = this.sceneObject.createComponent("Physics.ColliderComponent")
    this.initColliderShape()
    this.collider.intangible = false
    this.collider.fitVisual = false
    this.collider.debugDrawEnabled = false

    // Create interactable
    this.interactable = this.sceneObject.createComponent(Interactable.getTypeName()) as Interactable
    this.interactable.targetingMode = TargetingMode.All
    this.interactable.enableInstantDrag = true
    this.interactable.colliders = [this.collider]

    // Bind events
    this.unsubscribes.push(
      this.interactable.onHoverEnter.add(() => {
        this.isHovered = true
        this.onHandleHoverEnter()
      }),
      this.interactable.onHoverExit.add(() => {
        this.isHovered = false
        if (!this.isDragging) {
          this.onHandleHoverExit()
        }
      }),
      this.interactable.onDragStart.add((event: InteractorEvent) => {
        this.isDragging = true
        this.onHandleDragStart(event)
      }),
      this.interactable.onDragUpdate.add((event: InteractorEvent) => {
        if (this.isDragging) {
          this.onHandleDragUpdate(event)
        }
      }),
      this.interactable.onDragEnd.add((event: InteractorEvent) => {
        if (this.isDragging) {
          this.isDragging = false
          this.onHandleDragEnd(event)
        }
      }),
      this.interactable.onTriggerEnd.add((event: InteractorEvent) => {
        if (this.isDragging) {
          this.isDragging = false
          this.onHandleDragEnd(event)
        }
      }),
      this.interactable.onTriggerEndOutside.add((event: InteractorEvent) => {
        if (this.isDragging) {
          this.isDragging = false
          this.onHandleDragEnd(event)
        }
      }),
      this.interactable.onTriggerCanceled.add((event: InteractorEvent) => {
        if (this.isDragging) {
          this.isDragging = false
          this.onHandleDragEnd(event)
        }
      })
    )

    // Initialize as hidden. Mirror the RMV's enabled flag to the scene object's at every toggle
    // site so a hidden handle doesn't leave an alpha-0 RenderMeshVisual enabled in the render pipeline.
    this.sceneObject.enabled = false
    this.rmv.enabled = false
  }

  /** Keeps the handle in the text input's shared hierarchy-sorted render-order band. */
  public set renderOrder(renderOrder: number) {
    this.rmv.setRenderOrder(renderOrder)
  }

  /** Re-appends the handle after a lazily created caret while preserving its local transform. */
  public moveToForeground(): void {
    if (isNull(this.sceneObject)) return
    reappendChild(this.sceneObject)
  }

  /**
   * Destroys the handle and cleans up resources.
   */
  public destroy(): void {
    this.colorAnimationCancelSet.cancel()
    this.positionAnimationCancelSet.cancel()
    this.unsubscribes.forEach((unsub) => unsub())
    this.unsubscribes = []
    if (!isNull(this.sceneObject)) {
      this.sceneObject.destroy()
    }
  }

  /**
   * Shows the handle.
   */
  public show(): void {
    this.sceneObject.enabled = true
    this.rmv.enabled = true
  }

  /**
   * Hides the handle.
   */
  public hide(): void {
    this.colorAnimationCancelSet.cancel()
    this.positionAnimationCancelSet.cancel()
    this.sceneObject.enabled = false
    this.rmv.enabled = false
    this.isHovered = false
    this.setHandleColor(this._defaultColor)
  }

  /**
   * Updates the visual position of the handle, either animating to it (if releasing)
   * or snapping directly to it.
   * Note: `pos` should already be compensated for this handle's physical side.
   *
   * @param pos - The compensated local anchor to align with
   * @param isReleasing - Whether the handle is being released and should animate to position
   */
  private updateVisualState(pos: vec3, isReleasing: boolean): void {
    const widthOffset = this.getSideDirection(this.handleSide) * (this._handleWidth / 2)
    this._handlePosition.x = pos.x + widthOffset
    this._handlePosition.y = pos.y + this._visualHeight * LINE_CENTER_OFFSET_RATIO
    this._handlePosition.z = HANDLE_Z_OFFSET

    if (!this.isDragging && isReleasing) {
      this.targetPosition.x = this._handlePosition.x
      this.targetPosition.y = this._handlePosition.y
      this.targetPosition.z = this._handlePosition.z
      this.animateToTargetPosition(() => {
        if (!this.isHovered) this.animateToDefaultColor()
      })
    } else {
      this.position = this._handlePosition
    }
  }

  /**
   * Updates from highlight rect bounds, compensating when the anchor side differs
   * from this handle's physical side.
   *
   * @param rect - The highlight rect to align with
   * @param anchorSide - The side of the highlight rect this handle should attach to
   * @param isReleasing - Whether the handle is being released and should animate to position
   */
  public updateVisualStateFromRect(rect: HighlightRect, anchorSide: HandleSide, isReleasing: boolean): void {
    const anchorX = anchorSide === "left" ? rect.leftX : rect.rightX
    this.updateVisualHeight(rect.height)
    this._compensatedAnchorPosition.x = this.getCompensatedAnchorX(anchorX, anchorSide)
    this._compensatedAnchorPosition.y = rect.handleAnchorY
    this._compensatedAnchorPosition.z = 0
    this.updateVisualState(this._compensatedAnchorPosition, isReleasing)
  }

  private updateVisualHeight(height: number): void {
    if (this._visualHeight === height) {
      return
    }
    this._visualHeight = height
    this._handleWidth = height * HANDLE_WIDTH_RATIO
    this._handleScale.x = this._handleWidth
    this._handleScale.y = height * HANDLE_HEIGHT_RATIO
    this._handleScale.z = 1
    this.transform.setLocalScale(this._handleScale)
  }

  /**
   * Event handler for when dragging starts.
   *
   * @param event - The interactor event
   */
  private onHandleDragStart(event: InteractorEvent): void {
    this.dragStartWorldPos = event.interactor?.planecastPoint
    this.onDragStartEvent.invoke(event)
    this.animateToActiveColor()
  }

  /**
   * Event handler for when the handle is hovered.
   */
  private onHandleHoverEnter(): void {
    this.animateToActiveColor()
  }

  /**
   * Event handler for when the handle hover ends.
   */
  private onHandleHoverExit(): void {
    this.animateToDefaultColor()
  }

  /**
   * Event handler for drag updates.
   *
   * @param event - The interactor event
   */
  private onHandleDragUpdate(event: InteractorEvent): void {
    const pos = event.interactor?.planecastPoint

    // Skip update to avoid janky jumps
    if (!pos || !this.dragStartWorldPos) return

    this.onDragUpdateEvent.invoke({
      dragStartWorldPosition: this.dragStartWorldPos!,
      dragCurrentWorldPosition: pos
    })
  }

  /**
   * Event handler for when dragging ends.
   *
   * @param event - The interactor event
   */
  private onHandleDragEnd(event: InteractorEvent): void {
    this.dragStartWorldPos = null
    this.onDragEndEvent.invoke(event)

    if (!this.isHovered) {
      this.animateToDefaultColor()
    }
  }

  private getSideDirection(side: HandleSide): number {
    return side === "left" ? -1 : 1
  }

  private getCompensatedAnchorX(anchorX: number, anchorSide: HandleSide): number {
    const desiredOffsetDirection = this.getSideDirection(anchorSide)
    const handleOffsetDirection = this.getSideDirection(this.handleSide)
    return anchorX + ((desiredOffsetDirection - handleOffsetDirection) * this._handleWidth) / 2
  }

  private setHandleColor(color: vec4): void {
    this._handleColor.x = color.x
    this._handleColor.y = color.y
    this._handleColor.z = color.z
    this._handleColor.w = color.w
    this.rmv.mainPass.baseColor = this._handleColor
  }

  private animateToDefaultColor(): void {
    this.animateToTargetColor(this._defaultColor)
  }

  private animateToActiveColor(): void {
    this.animateToTargetColor(this._activeColor)
  }

  private readonly onPositionAnimationUpdate = (t: number): void => {
    this._handlePosition.x = this._startPosition.x + (this.targetPosition.x - this._startPosition.x) * t
    this._handlePosition.y = this._startPosition.y + (this.targetPosition.y - this._startPosition.y) * t
    this._handlePosition.z = this._startPosition.z + (this.targetPosition.z - this._startPosition.z) * t
    this.transform.setLocalPosition(this._handlePosition)
  }

  /**
   * Animates the handle position back to its target highlight side.
   *
   * @param onComplete - Optional callback when animation finishes
   */
  private animateToTargetPosition(onComplete?: () => void): void {
    this.positionAnimationCancelSet.cancel()

    const startPos = this.position
    this._startPosition.x = startPos.x
    this._startPosition.y = startPos.y
    this._startPosition.z = startPos.z

    animate({
      duration: SNAP_BACK_ANIMATION_DURATION,
      easing: "ease-out-cubic",
      cancelSet: this.positionAnimationCancelSet,
      update: this.onPositionAnimationUpdate,
      ended: onComplete
    })
  }

  private readonly onColorAnimationUpdate = (t: number): void => {
    this.rmv.mainPass.baseColor = colorLerp(this._startColor, this._endColor, t)
  }

  /**
   * Animates the handle color to a target color.
   *
   * @param targetColor - The color to animate to
   */
  private animateToTargetColor(targetColor: vec4): void {
    this.colorAnimationCancelSet.cancel()

    const currentColor = this.rmv.mainPass.baseColor
    this._startColor.x = currentColor.x
    this._startColor.y = currentColor.y
    this._startColor.z = currentColor.z
    this._startColor.w = currentColor.w

    this._endColor.x = targetColor.x
    this._endColor.y = targetColor.y
    this._endColor.z = targetColor.z
    this._endColor.w = targetColor.w

    animate({
      duration: COLOR_ANIMATION_DURATION,
      easing: "ease-out-cubic",
      cancelSet: this.colorAnimationCancelSet,
      update: this.onColorAnimationUpdate
    })
  }

  private initColliderShape(): void {
    const shape = Shape.createBoxShape()
    shape.size = new vec3(HANDLE_COLLIDER_RELATIVE_WIDTH, HANDLE_COLLIDER_RELATIVE_HEIGHT, HANDLE_COLLIDER_DEPTH)
    this.collider.shape = shape
  }
}

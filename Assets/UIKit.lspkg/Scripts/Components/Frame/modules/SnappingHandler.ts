import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import TrackedHand from "InteractionKit.lspkg/Providers/HandInputData/TrackedHand"
import animate, {CancelSet, mix} from "InteractionKit.lspkg/Utils/animate"
import Event, {PublicApi, unsubscribe} from "InteractionKit.lspkg/Utils/Event"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"

import {InteractorInputType} from "InteractionKit.lspkg/Core/Interactor/Interactor"
import type {InteractorEvent} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import WorldCameraFinderProvider from "InteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import {HandInputData} from "InteractionKit.lspkg/Providers/HandInputData/HandInputData"
import {withAlpha} from "InteractionKit.lspkg/Utils/color"
import {RoundedRectangle} from "../../../Visuals/RoundedRectangle/RoundedRectangle"
import {Frame} from "../Frame"

const TAG = "SnappableBehavior"
const log = new NativeLogger(TAG)

export type SnappableOptions = {
  frame: Frame
  worldSnapping: boolean
  itemSnapping: boolean
  interactable: Interactable
  onSnappingCompleteEvent: Event
  onScalingUpdate: PublicApi<void>
  /** Called synchronously after snapping changes the owning Frame's pose. */
  onPoseUpdated?: () => void
  /**
   * Called before raw-cancellation cleanup. Return false when the gesture
   * remains active so snapping keeps its query/active state.
   */
  onCancellationPreflight?: (event: InteractorEvent) => boolean | void
  /**
   * Called synchronously right before a release snap tween takes over the
   * owning Frame's pose, before any release or tween state is changed.
   * Return false to veto the takeover. Final-release cleanup still runs.
   */
  onPoseTakeover?: () => boolean | void
}

const quatId: quat = quat.quatIdentity()

// A variable for 'up' (but not exactly up) We can't have it be exactly up because when
// we do a cross to get our angles and our raycast result points straight up we cross two
// vectors that are the same and it won't give us a sane result
const NOT_QUITE_UP = new vec3(0.0000001, 0.9999999, 0.0000001).normalize()

/*
 * Class for the snapping behaviors for
 * Specifically implemented for 2D content... so far!
 *
 */

export default class SnappingHandler {
  private stickyZoneSize: number = 1
  private gutterSize: number = 4
  private snappableDebugDraw: boolean = false
  private frame: Frame = this.options.frame

  private content: SceneObject | null = this.frame.content
  private parent: SceneObject | null = this.content?.getParent() ?? null
  private parentTransform: Transform | null = this.parent?.getTransform() ?? null
  private parentParent: SceneObject | null = this.parent ? this.parent.getParent() : null
  private contentTransform: Transform | null = this.content?.getTransform() ?? null
  private contentPosition: vec3 | null = this.contentTransform?.getWorldPosition() ?? null

  private interactable: Interactable = this.options.interactable

  private animationCancelSet = new CancelSet()

  private ghostParentsName: string

  private camera: Camera = WorldCameraFinderProvider.getInstance().getComponent()

  private ghost: SceneObject
  private ghostRoundedRectangle: RoundedRectangle
  private ghostTransform: Transform

  private itemSnapping = this.options.itemSnapping

  private boundingBox: SceneObject
  private boundingBoxTransform: Transform
  private useConstantBoundingBoxPadding: boolean = true

  private snapTo: SceneObject | null = null
  private snapPosition: vec3 = vec3.zero()
  private colliderTransform: Transform | null = null
  private colliderPosition: vec3 = vec3.zero()
  private colliderRotation: quat = quat.quatIdentity()
  private colliderScale: vec3 | null = vec3.zero()

  private itemSnappingRange: boolean = false
  private worldSnappingRange: boolean = false

  private _isTweening: boolean = false
  /**
   * Returns true if the snapping handler is currently tweening to a new position or rotation.
   */
  public get isTweening(): boolean {
    return this._isTweening
  }
  private _isActive: boolean = false
  /**
   * Returns true if the snapping handler is currently active, meaning it is ready to snap to a position.
   */
  public get isActive(): boolean {
    return this._isActive
  }
  private _isEnabled: boolean = true
  private _isScaling: boolean = false

  private unSubscribeList: unsubscribe[] = []

  private handInputData = HandInputData.getInstance()
  private rightHand: TrackedHand = this.handInputData.getHand("right")
  private leftHand: TrackedHand = this.handInputData.getHand("left")

  private worldQueryAsset: WorldQueryModule | null = null
  private hitTestSession: HitTestSession | null = null
  private useWorldQuery: boolean = false

  private queryBuffer: {
    distance: number
    hitPosition: vec3
    hitNormal: vec3
  }[] = []
  private queryBufferMaxLength: number = 20
  private lastIndexTipPosition: vec3 = vec3.zero()
  private lastIndexForward: vec3 = vec3.forward()
  private missedCount: number = 0
  private hitTestSessionStarted: boolean = false
  private worldQueryTweenCancel: CancelSet = new CancelSet()

  /**
   * Refresh the snap ghost's corner radius. The ghost mirrors the frame's
   * radius for visual consistency during snap; call this when the frame's
   * radius changes (via `Frame.cornerRadius`, `resetCornerRadius`, or an
   * appearance switch).
   */
  public setGhostCornerRadius(radius: number): void {
    if (!isNull(this.ghostRoundedRectangle)) {
      this.ghostRoundedRectangle.cornerRadius = radius
    }
  }

  public constructor(private options: SnappableOptions) {
    if (options.worldSnapping) {
      this.enableWorldSnapping(true)
    }

    this.unSubscribeList.push(this.frame.onTranslationStart.add(this.onTriggerStart))
    this.unSubscribeList.push(this.frame.onTranslationEnd.add(this.onTriggerRelease))
    this.unSubscribeList.push(this.interactable.onTriggerCanceled.add(this.onTriggerCanceled))

    this.ghost = global.scene.createSceneObject("Ghost")
    this.ghost.layer = this.frame.sceneObject.layer
    this.ghostRoundedRectangle = this.ghost.createComponent(RoundedRectangle.getTypeName())
    this.ghostTransform = this.ghost.getTransform()

    this.ghost.enabled = false
    this.ghost.setParent(this.parent)
    this.ghostParentsName = this.parent.name
    this.ghostTransform = this.ghost.getTransform()

    this.ghostRoundedRectangle.initialize()

    this.ghostRoundedRectangle.cornerRadius = this.frame.cornerRadius
    this.ghostRoundedRectangle.gradient = true
    this.ghostRoundedRectangle.renderMeshVisual.mainPass.blendMode = BlendMode.PremultipliedAlphaAuto
    this.ghostRoundedRectangle.renderMeshVisual.mainPass.colorMask = new vec4b(true, true, true, true)
    this.ghostRoundedRectangle.renderMeshVisual.setRenderOrder(this.frame.renderOrder - 1)
    this.ghostRoundedRectangle.renderMeshVisual.mainPass.depthTest = false

    this.ghostRoundedRectangle.setBackgroundGradient({
      type: "Rectangle",
      stop0: {
        enabled: true,
        color: new vec4(0.2, 0.2, 0.2, 0.1),
        percent: -6
      },
      stop1: {
        enabled: true,
        color: new vec4(0.5, 0.5, 0.5, 0.4),
        percent: 1
      },
      stop2: {enabled: false},
      stop3: {enabled: false},
      stop4: {enabled: false}
    })

    this.ghostRoundedRectangle.border = true
    this.ghostRoundedRectangle.borderSize = 0.3
    this.ghostRoundedRectangle.borderColor = new vec4(0.6, 0.6, 0.6, 0.6)

    this.boundingBox = global.scene.createSceneObject("boundingBox")
    this.boundingBox.layer = this.frame.sceneObject.layer
    this.boundingBoxTransform = this.boundingBox.getTransform()
    this.boundingBox.setParent(this.content)
    this.boundingBox.layer = LayerSet.fromNumber(4)

    const boundingBoxFilter: Filter = Physics.Filter.create() as Filter
    boundingBoxFilter.onlyLayers = this.boundingBox.layer

    const boundingBoxCollider: ColliderComponent = this.boundingBox.createComponent("ColliderComponent")
    const boxShape: BoxShape = Shape.createBoxShape()
    if (!this.useConstantBoundingBoxPadding) {
      // maximumDepthForBoundingBox
      const maxBoxDepth = 40
      // amplifier for boxDepth
      const boxDepthScalar = 0.4
      // amplifier for shapeSize
      const shapeScalar = 1.34

      const boxSize = Math.max(this.frame.totalSize.x, this.frame.totalSize.y)
      const boxDepth = Math.max(Math.min(boxSize, maxBoxDepth), 1)

      this.boundingBoxTransform.setWorldScale(
        new vec3(this.frame.totalSize.x, this.frame.totalSize.y, boxDepth * boxDepthScalar)
      )
      boxShape.size = vec3.one().uniformScale(shapeScalar)
    } else {
      boxShape.size = vec3.one()
    }
    boundingBoxCollider.shape = boxShape
    boundingBoxCollider.filter = boundingBoxFilter as Filter
    boundingBoxCollider.overlapFilter = boundingBoxFilter as Filter
    boundingBoxCollider.debugDrawEnabled = this.snappableDebugDraw

    const onOverlapEnterEvent = boundingBoxCollider.onOverlapEnter.add(this.checkItemOverlaps)
    const onOverlapStayEvent = boundingBoxCollider.onOverlapStay.add(this.checkItemOverlaps)
    const onOverlapExitEvent = boundingBoxCollider.onOverlapExit.add(this.onOverlapExit)

    this.unSubscribeList.push(() => {
      if (!isNull(boundingBoxCollider) && !isNull(onOverlapEnterEvent)) {
        boundingBoxCollider.onOverlapEnter.remove(onOverlapEnterEvent)
      }
    })
    this.unSubscribeList.push(() => {
      if (!isNull(boundingBoxCollider) && !isNull(onOverlapStayEvent)) {
        boundingBoxCollider.onOverlapStay.remove(onOverlapStayEvent)
      }
    })
    this.unSubscribeList.push(() => {
      if (!isNull(boundingBoxCollider) && !isNull(onOverlapExitEvent)) {
        boundingBoxCollider.onOverlapExit.remove(onOverlapExitEvent)
      }
    })

    if (this.useConstantBoundingBoxPadding) {
      this.unSubscribeList.push(this.options.onScalingUpdate.add(this.scaleConstantBoundingBox))
      this.scaleConstantBoundingBox()
    }

    this.unSubscribeList.push(this.options.onScalingUpdate.add(this.setAspectRatio))
    this.setAspectRatio()
  }

  private enableWorldSnapping = (enable: boolean) => {
    if (enable) {
      if (this.worldQueryAsset === null) {
        // eslint-disable-next-line
        this.worldQueryAsset = require("LensStudio:WorldQueryModule") as WorldQueryModule

        const sessionOptions = HitTestSessionOptions.create()
        sessionOptions.filter = true
        this.hitTestSession = this.worldQueryAsset.createHitTestSessionWithOptions(sessionOptions)

        // turn off until used
        this.hitTestSession.stop()
      }
    }
    this.useWorldQuery = enable
  }

  public destroy(): void {
    log.d("destroy")
    // Every writer stops first, before anything below can throw. The ghost's
    // own slide runs on a separate CancelSet from the pose tweens. Left
    // running, its update kept writing to the ghost Transform after
    // ghost.destroy() below, inside animate()'s shared handler: that loses the
    // tween and every animation queued after it, and Lens Studio never calls a
    // handler that threw again, so every animation in the lens would stop for
    // good. Stopping the hit-test session ends the world query; a result
    // already in flight can still land, and the callback's ghost check drops it.
    this.animationCancelSet.cancel()
    this.worldQueryTweenCancel.cancel()
    if (this.hitTestSessionStarted) {
      this.hitTestSession?.stop()
      this.hitTestSessionStarted = false
    }
    this.setTweening(false)
    this.abortSnapping()
    // Puts things back only when the frame outlives this component. A dying
    // frame is left where it sits (see deParent), and the ghost is destroyed
    // below wherever item snapping parked it.
    this.deParent()
    this.unSubscribeList.forEach((sub) => {
      sub()
    })
    this.unSubscribeList = []
    if (!isNull(this.ghost)) this.ghost.destroy()
    if (!isNull(this.boundingBox)) this.boundingBox.destroy()
  }

  private scaleConstantBoundingBox = () => {
    // the padding of the constant size added to the bounding box
    const boxPadding = 5
    const boxSize = Math.max(this.frame.totalSize.x, this.frame.totalSize.y)
    const boxDepth = Math.max(Math.min(boxSize, 40), 1)
    this.boundingBoxTransform.setWorldScale(
      new vec3(this.frame.totalSize.x + boxPadding, this.frame.totalSize.y + boxPadding, boxDepth)
    )
  }

  private setActive = (val: boolean) => {
    this._isActive = val
  }

  private setTweening = (val: boolean) => {
    this._isTweening = val
  }

  // Puts the frame back under its original parent after an item snap, and the
  // ghost back under the frame. Lens Studio throws on any reparent into or out
  // of an object being destroyed, so a dying frame is left where it sits, even
  // mid-snap under its target: it is destroyed there.
  private deParent = () => {
    const frameObject = this.parent
    if (frameObject === null || isNull(frameObject) || frameObject.isBeingDestroyed) {
      return
    }
    if (frameObject.getParent() !== this.parentParent) {
      frameObject.setParentPreserveWorldTransform(this.parentParent!)
    }
    this.returnGhostHome()
  }

  // Item snapping parks the ghost under the frame it previews against (see
  // calculateItemSnapping). It comes back once nothing uses it there: left
  // behind, it dies along with that frame, and this one's next drag would
  // touch a destroyed object.
  private returnGhostHome(): void {
    const frameObject = this.parent
    if (isNull(this.ghost) || frameObject === null || isNull(frameObject)) {
      return
    }
    if (this.ghost.getParent() === frameObject || this.ghost.isBeingDestroyed || frameObject.isBeingDestroyed) {
      return
    }
    this.ghost.setParentPreserveWorldTransform(frameObject)
    this.ghostParentsName = frameObject.name
  }

  private abortTweening = () => {
    this.animationCancelSet.cancel()
    this.deParent()
    this.setTweening(false)
  }

  private setAspectRatio = () => {
    if (isNull(this.ghost)) {
      log.e(`ERROR: ghost is null - parent: ${this.ghostParentsName}`)
      return
    }
    if (isNull(this.ghostTransform)) {
      log.e(`ERROR: ghostTransform is null - parent: ${this.ghostParentsName}`)
      return
    }

    this.ghostRoundedRectangle.size = new vec2(this.frame.totalSize.x, this.frame.totalSize.y)
  }

  private readonly abortSnapping = () => {
    this.setActive(false)
    if (!isNull(this.ghost)) {
      this.ghost.enabled = false
    }

    this._isEnabled = false
    this.itemSnappingRange = false
    this.worldSnappingRange = false
  }

  private onTriggerStart = () => {
    if (this._isTweening) {
      this.abortTweening()
    }

    if (!this._isTweening && !this._isScaling && !this._isActive) {
      this.setAspectRatio()
      if (this.useWorldQuery) {
        this.queryBuffer = []
        this.hitTestSession?.start()
        this.hitTestSessionStarted = true
      }
      this.setActive(true)
    }
  }

  private onTriggerCanceled = (event: InteractorEvent) => {
    // A raw cancellation is per-interactor, so one hand can cancel while the
    // other continues the same gesture. Frame has not processed this event
    // yet (its cancellation subscriber runs after ours), so pass the event to
    // let it predict whether the gesture will remain active after this end.
    if (this.options.onCancellationPreflight?.(event) === false) return
    this.onTriggerRelease()
  }

  private onTriggerRelease = () => {
    const canSnap = this._isActive && !this._isScaling && this._isEnabled
    const itemSnapPending =
      canSnap && this.itemSnappingRange && !this._isTweening && this.parent?.getParent() !== this.snapTo
    const worldSnapPending =
      canSnap && !itemSnapPending && this.parentTransform !== null && this.worldSnappingRange && !this._isTweening

    // Ask before mutating release/tween state, but a veto suppresses only the
    // pose takeover. A final release must still stop the query and deactivate
    // snapping; only the cancellation preflight above may preserve the full
    // active state for a gesture that continues under another interactor.
    const poseTakeoverVetoed = (itemSnapPending || worldSnapPending) && this.options.onPoseTakeover?.() === false

    if (this.useWorldQuery && this.hitTestSessionStarted) {
      this.hitTestSession?.stop()
      this.hitTestSessionStarted = false
    }
    if (canSnap) {
      this.setActive(false)
      if (!isNull(this.ghost)) this.ghost.enabled = false

      if (poseTakeoverVetoed) {
        this.itemSnappingRange = false
        this.worldSnappingRange = false
      } else if (itemSnapPending) {
        this.setTweening(true)
        this.itemSnappingRange = false

        this.parent?.setParentPreserveWorldTransform(this.snapTo!)

        const startPosition = this.parentTransform?.getLocalPosition() || vec3.zero()
        animate({
          cancelSet: this.animationCancelSet,
          duration: 0.15,
          start: 0,
          end: 1,
          ended: this.tweenCompleted,
          update: (t) => {
            this.parentTransform?.setLocalPosition(mix(startPosition, this.snapPosition, t))
            this.options.onPoseUpdated?.()
          }
        })
        const startRot: quat = this.parentTransform?.getWorldRotation() || quat.quatIdentity()
        const endRot: quat = this.snapTo!.getTransform().getWorldRotation()
        animate({
          cancelSet: this.animationCancelSet,
          duration: 0.14,
          start: 0,
          end: 1,
          update: (t) => {
            this.parentTransform?.setWorldRotation(mix(startRot, endRot, t))
            this.options.onPoseUpdated?.()
          }
        })
      } else if (worldSnapPending) {
        this.setTweening(true)
        this.worldSnappingRange = false

        // worldSnapPending proves parentTransform is non-null.
        const parentTransform = this.parentTransform!
        const startPosition = parentTransform.getWorldPosition()

        animate({
          cancelSet: this.animationCancelSet,
          duration: 0.15,
          start: 0,
          end: 1,
          ended: this.tweenCompleted,
          update: (t) => {
            this.parentTransform?.setWorldPosition(mix(startPosition, this.colliderPosition, t))
            this.options.onPoseUpdated?.()
          }
        })
        const startRot: quat = parentTransform.getWorldRotation()
        const endRot: quat = this.colliderRotation
        animate({
          cancelSet: this.animationCancelSet,
          duration: 0.14,
          start: 0,
          end: 1,
          update: (t) => {
            this.parentTransform?.setWorldRotation(mix(startRot, endRot, t))
            this.options.onPoseUpdated?.()
          }
        })
      }
    }
    // A snap brings the ghost home when its tween completes. A release that
    // starts none (a near miss, a veto) leaves nothing using it where item
    // snapping parked it.
    if (!this._isTweening) this.returnGhostHome()
  }

  private queryWorld = () => {
    const rayLength = 300
    const containerPosition = this.parentTransform.getWorldPosition()

    let indexTipPos, indexForward
    let thisHand = this.rightHand
    if (this.frame.currentInteractor.inputType === InteractorInputType.RightHand) {
      thisHand = this.rightHand
    } else if (this.frame.currentInteractor.inputType === InteractorInputType.LeftHand) {
      thisHand = this.leftHand
    }

    if (thisHand.isTracked() && thisHand.indexTip) {
      indexTipPos = thisHand.indexTip.position
      this.lastIndexTipPosition = indexTipPos
      indexForward = containerPosition.sub(indexTipPos).normalize()
      this.lastIndexForward = indexForward
    } else {
      indexTipPos = this.lastIndexTipPosition
      indexForward = this.lastIndexForward
    }

    const endPos = indexTipPos.add(indexForward.uniformScale(rayLength))

    if (this.hitTestSessionStarted) {
      this.hitTestSession.hitTest(indexTipPos, endPos, (hitResult) => {
        // A result can land after destroy(); the ghost it would move is gone.
        if (isNull(this.ghost)) {
          return
        }
        if (hitResult === null) {
          this.missedCount += 1
          return
        } else {
          const hitPosition: vec3 = hitResult.position
          const hitNormal: vec3 = hitResult.normal

          const containerFromHit = containerPosition.distanceSquared(hitPosition)
          if (containerFromHit > 2500) {
            // more than 25 away from world mesh too far away
            this.missedCount += 1
            return
          }

          const indexDistance = indexTipPos.distance(hitPosition)
          if (hitPosition === vec3.zero()) {
            this.missedCount += 1
            return
          }
          if (indexDistance < 20) {
            // probably an error
            this.missedCount += 1
            return
          }

          this.queryBuffer.push({
            distance: indexDistance,
            hitPosition: hitPosition,
            hitNormal: hitNormal
          })

          if (this.queryBuffer.length === this.queryBufferMaxLength) {
            let sumPosition = vec3.zero()
            let sumNormal = vec3.zero()
            this.queryBuffer.forEach((queryObj, _i) => {
              sumPosition = sumPosition.add(queryObj.hitPosition)
              sumNormal = sumNormal.add(queryObj.hitNormal)
            })
            const avgPositon = sumPosition.uniformScale(1 / this.queryBuffer.length)
            const avgNormal = sumNormal.uniformScale(1 / this.queryBuffer.length)

            let toRotation: quat
            if (avgNormal.y > 0.95) {
              toRotation = quat.lookAt(avgNormal, this.camera.getTransform().back)
            } else {
              toRotation = quat.lookAt(avgNormal, NOT_QUITE_UP)
            }

            const ghostPos = this.ghostTransform.getWorldPosition()
            const ghostRot = this.ghostTransform.getWorldRotation()

            if (this.worldQueryTweenCancel) this.worldQueryTweenCancel()
            animate({
              duration: 0.05,
              cancelSet: this.worldQueryTweenCancel,
              update: (t) => {
                if (isNull(this.ghost)) {
                  this.worldQueryTweenCancel.cancel()
                  return
                }
                this.ghostTransform.setWorldPosition(vec3.lerp(ghostPos, avgPositon, t))
                this.ghostTransform.setWorldRotation(quat.slerp(ghostRot, toRotation, t))
              }
            })

            this.colliderPosition = avgPositon
            this.colliderRotation = toRotation
            this.colliderScale = new vec3(this.frame.totalSize.x, this.frame.totalSize.y, 1)
            this.worldSnappingRange = true

            this.queryBuffer.shift()
            this.missedCount = 0
          } else {
            this.worldSnappingRange = false
            this.missedCount = 0
          }
        }
      })
    }

    if (this.missedCount >= 20) this.worldSnappingRange = false
  }

  private calculateItemSnapping = () => {
    if (!isNull(this.ghost) && this.ghost.getParent() !== this.snapTo && this.snapTo !== null) {
      this.ghost.setParentPreserveWorldTransform(this.snapTo)
      this.ghostParentsName = this.snapTo.name
    }

    this.contentPosition = this.contentTransform.getWorldPosition().sub(this.colliderPosition)

    this.contentPosition = this.colliderRotation.multiplyVec3(this.contentPosition)

    const snapToScalar = this.snapTo!.getTransform().getWorldScale()
    const thisWorldScale = this.frame.transform.getWorldScale()

    // prevent 0 division
    if (snapToScalar.x === 0) snapToScalar.x = 0.0001
    if (snapToScalar.y === 0) snapToScalar.y = 0.0001

    // assuming height of 1
    const halfFrameSize = {
      x: (this.frame.totalSize.x * 0.5 * thisWorldScale.x) / snapToScalar.x,
      y: (this.frame.totalSize.y * 0.5 * thisWorldScale.y) / snapToScalar.y
    }

    const halfColliderImageScale = {
      x: this.colliderScale.x * 0.5,
      y: this.colliderScale.y * 0.5
    }

    let xOffset: number = 0
    let yOffset: number = 0

    if (Math.abs(this.contentPosition.x) >= Math.abs(this.contentPosition.y)) {
      // snap to left or right
      xOffset = halfColliderImageScale.x + halfFrameSize.x + this.gutterSize / snapToScalar.x
      if (this.contentPosition.x > 0) {
        this.snapPosition.x = xOffset
      } else {
        this.snapPosition.x = -xOffset
      }

      if (Math.abs(this.contentPosition.y) < this.stickyZoneSize) {
        // in sticky center
        this.snapPosition.y = 0
      } else if (Math.abs(this.contentPosition.y + halfFrameSize.y - halfColliderImageScale.y) < this.stickyZoneSize) {
        // at top
        this.snapPosition.y = halfColliderImageScale.y - halfFrameSize.y
      } else if (Math.abs(this.contentPosition.y - halfFrameSize.y + halfColliderImageScale.y) < this.stickyZoneSize) {
        // at bottom
        this.snapPosition.y = -halfColliderImageScale.y + halfFrameSize.y
      } else {
        // sliding
        this.snapPosition.y = this.contentPosition.y
      }
    } else {
      // snap to top or bottom
      yOffset = halfColliderImageScale.y + halfFrameSize.y + this.gutterSize / snapToScalar.y

      if (this.contentPosition.y > 0) {
        this.snapPosition.y = yOffset
      } else {
        this.snapPosition.y = -yOffset
      }

      if (Math.abs(this.contentPosition.x) < this.stickyZoneSize) {
        // in sticky center
        this.snapPosition.x = 0
      } else if (Math.abs(this.contentPosition.x + halfFrameSize.x - halfColliderImageScale.x) < this.stickyZoneSize) {
        // at right
        this.snapPosition.x = halfColliderImageScale.x - halfFrameSize.x
      } else if (Math.abs(this.contentPosition.x - halfFrameSize.x + halfColliderImageScale.x) < this.stickyZoneSize) {
        // at left
        this.snapPosition.x = -halfColliderImageScale.x + halfFrameSize.x
      } else {
        // sliding
        this.snapPosition.x = this.contentPosition.x
      }
    }

    this.snapPosition.z = 0

    // ghost temporarily parented to snapTo object
    if (!isNull(this.ghostTransform)) {
      this.ghostTransform.setLocalRotation(quatId)
      this.ghostTransform.setLocalPosition(this.snapPosition)
    }
    if (!isNull(this.ghost) && !this.ghost.enabled) this.ghost.enabled = true
  }

  public update = () => {
    if (this._isActive && !this._isScaling && this._isEnabled && !this.frame.following) {
      if (this.itemSnappingRange) {
        this.calculateItemSnapping()
      } else if (this.useWorldQuery) {
        this.queryWorld()
      } else if (!this.worldSnappingRange) {
        // if not in snapping range
        if (!this._isTweening && !isNull(this.content) && this.content.getParent() !== this.parent) {
          this.deParent()
        }
        if (!isNull(this.ghost) && this.ghost.enabled) this.ghost.enabled = false
      }
      // confirm ghost
      if (this.worldSnappingRange) {
        if (!isNull(this.ghost) && !this.ghost.enabled) this.ghost.enabled = true
      }
    } else {
      if (!isNull(this.ghost) && this.ghost.enabled) this.ghost.enabled = false
      if (!this._isTweening && !isNull(this.content) && this.content.getParent() !== this.parent) {
        this.deParent()
      }
    }
    if (!isNull(this.ghost) && this.ghost.enabled) {
      this.ghostRoundedRectangle.borderColor = withAlpha(
        this.ghostRoundedRectangle.borderColor,
        0.5 + Math.sin(getTime() * 5) * 0.1
      )
    }

    if (!this.worldSnappingRange && !this.itemSnappingRange) {
      if (!isNull(this.ghost) && this.ghost.enabled) this.ghost.enabled = false
      if (!isNull(this.ghost) && !isNull(this.ghostTransform)) {
        this.ghostTransform.setWorldPosition(this.frame.transform.getWorldPosition())
        this.ghostTransform.setWorldRotation(this.frame.transform.getWorldRotation())
      }
    }
  }

  private checkItemOverlaps = (e: any) => {
    if (
      this._isActive &&
      !this._isScaling &&
      !this._isTweening &&
      !this.frame.following &&
      this.itemSnapping &&
      this._isEnabled
    ) {
      let lastDistance = Infinity
      for (let i = 0; i < e.currentOverlaps.length; i++) {
        const overlap = e.currentOverlaps[i]
        const colliderObject: SceneObject = overlap.collider.getSceneObject().getParent().getParent()
        // getParent of boundingBox

        const colliderFrameComponent = colliderObject.getComponent(Frame.getTypeName())

        if (isNull(colliderFrameComponent)) {
          continue
        }
        if (colliderFrameComponent!.isSnappingActive() || colliderFrameComponent!.isSnappingTweening()) {
          continue
        }
        if (colliderObject === this.parent) {
          continue
        }
        this.colliderTransform = colliderObject.getTransform()
        const thisColliderPosition: vec3 = this.colliderTransform.getWorldPosition()
        const thisDistance = thisColliderPosition.distanceSquared(this.contentTransform.getWorldPosition())
        if (thisDistance < lastDistance) {
          this.snapTo = colliderObject

          this.colliderPosition = thisColliderPosition

          this.colliderScale = new vec3(colliderFrameComponent!.totalSize.x, colliderFrameComponent!.totalSize.y, 1)

          this.colliderRotation = this.colliderTransform!.getWorldRotation()
          this.colliderRotation.x *= -1
          this.colliderRotation.y *= -1
          this.colliderRotation.z *= -1

          this.itemSnappingRange = true
          lastDistance = thisDistance
        }
      }
    }
  }

  private tweenCompleted = () => {
    // deparent when tween complete
    this.deParent()
    this.setTweening(false)
    this.options.onPoseUpdated?.()
    this.options.onSnappingCompleteEvent.invoke()
  }

  private onOverlapExit = (e: any) => {
    if (e.currentOverlaps.length === 0) {
      if (!isNull(this.ghost)) this.ghost.enabled = false
      this.itemSnappingRange = false
    }
  }
}

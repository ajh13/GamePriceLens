import {clamp, DegToRad, RadToDeg, smoothDamp, smoothDampAngle} from "InteractionKit.lspkg/Utils/mathUtils"

import WorldCameraFinderProvider from "InteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import {PublicApi, unsubscribe} from "InteractionKit.lspkg/Utils/Event"
import {computeBillboardRotation} from "./FollowBillboard"

export type SmoothFollowOptions = {
  transform: Transform
  visibleWidth: number
  onFollowUpdate: PublicApi<void>
  onDragStart: PublicApi<void>
  onDragEnd: PublicApi<void>
  onScalingStart: PublicApi<void>
  onScalingEnd: PublicApi<void>
  onSizeChanged: PublicApi<vec3>
  tiltEnabled?: boolean
  tiltUpThreshold?: number
  tiltDownThreshold?: number
}

const minDistance: number = 25
const maxDistance: number = 110
const minElevation: number = -40
const maxElevation: number = 40
const translationTime: number = 0.45
const rotationTime: number = 0.55

// Tilt mode
const tiltExitBuffer: number = 5
const tiltRecoveryThreshold: number = 1

/**
 * SmoothFollow is a body dynamic behavior which when applied to a scene object,
 * makes it stay in the same relative horizontal position and distance to the
 * user's field of view as they turn their head left and right and move around.
 * It doesn't affect the positioning of the scene object when the user looks up
 * and down or changes elevation. Interpolation is handled by a spring-damper
 * in cylindrical coordinates.
 *
 * When tiltEnabled is true, the follow behavior switches to gaze-tracking
 * once the camera pitch exceeds the configured thresholds. In tilt mode, the
 * frame moves on a sphere of constant radius centered on the camera, and
 * the billboard up-vector transitions from gravity-aligned to camera-aligned
 * to avoid the lookAt singularity near vertical orientations.
 */
export default class SmoothFollow {
  private mainCamera: Camera = WorldCameraFinderProvider.getInstance().getComponent()
  private cameraTransform: Transform = this.mainCamera.getTransform()
  private transform: Transform = this.options.transform
  private fieldOfView: number = 26
  private tangentHalfFOV: number = Math.tan((this.fieldOfView / 2) * DegToRad)
  private visibleWidth: number = 20

  // These fields are configured from Frame at runtime; `inTiltMode` is read-only
  // because it reports the internal hysteresis state rather than external config.
  /** Enables tilt mode, which switches to gaze-tracking beyond the pitch thresholds. */
  public tiltEnabled: boolean = false
  /** Camera pitch (degrees) looking UP at which gaze-tracking activates. */
  public tiltUpThreshold: number = 25
  /** Camera pitch (degrees) looking DOWN at which gaze-tracking activates. */
  public tiltDownThreshold: number = 35
  /** Whether the follow is currently in tilt/gaze-tracking mode. */
  public get inTiltMode(): boolean {
    return this._inTiltMode
  }
  private _inTiltMode: boolean = false

  private target: vec3 // cylindrical coords of where the follower wants to be
  private velocity: vec3 // current velocity of follower in cylindrical space
  private omega: number // current rotational velocity of the follower's heading
  private heading: number // current direction the follower is facing in world space, with -z being 0
  private initialRot: quat // original orientation of the follower that the dynamic heading is applied to
  private dragging: boolean // to reposition the follow position, the manipulator will turn this on then back off
  private baseDistance: number = 0 // radial distance at neutral pitch, used as sphere radius in tilt mode
  private savedElevation: number = 0 // elevation snapshot taken on entering tilt mode, restored on return
  private prevTiltMode: boolean = false // previous frame tilt state for edge detection
  private tiltRecovering: boolean = false // true while frame is returning to pre-tilt elevation

  private unsubscribes: unsubscribe[] = []

  public constructor(private options: SmoothFollowOptions) {
    this.target = vec3.zero()
    this.velocity = vec3.zero()
    this.omega = 0
    this.heading = 0
    this.dragging = false
    this.initialRot = this.transform.getLocalRotation()
    this.heading = this.cameraHeading

    this.resize(options.visibleWidth)
    this.setTilt(
      options.tiltEnabled ?? this.tiltEnabled,
      options.tiltUpThreshold ?? this.tiltUpThreshold,
      options.tiltDownThreshold ?? this.tiltDownThreshold
    )

    // Self-subscribe to lifecycle events
    this.unsubscribes.push(
      options.onFollowUpdate.add(() => this.onUpdate()),
      options.onDragStart.add(() => this.startDragging()),
      options.onDragEnd.add(() => this.finishDragging()),
      options.onScalingStart.add(() => this.startDragging()),
      options.onScalingEnd.add(() => this.finishDragging()),
      options.onSizeChanged.add((size: vec3) => this.resize(size.x))
    )
  }

  public destroy() {
    this.unsubscribes.forEach((u) => u())
    this.unsubscribes = []
  }

  public setTilt(enabled: boolean, upThreshold: number, downThreshold: number): void {
    this.tiltEnabled = enabled
    this.tiltUpThreshold = upThreshold
    this.tiltDownThreshold = downThreshold
  }

  private startDragging(): void {
    this.dragging = true
  }

  private finishDragging(): void {
    this.dragging = false
    this.clampPosition()
  }

  /**
   * Re-derive the at-rest follow target from the frame's current pose, for
   * external systems that legitimately move the frame after finishDragging
   * captured the release-time target (e.g. the released depth-clamp
   * correction). No-op mid-drag.
   */
  public recaptureRestTarget(): void {
    this.clampPosition()
  }

  private resize(visibleWidth: number): void {
    if (visibleWidth === undefined) {
      return
    }
    this.visibleWidth = visibleWidth
    this.clampPosition()
  }

  private clampPosition(): void {
    if (this.dragging) return

    this.target = this.cartesianToCylindrical(this.worldToBody(this.worldPos))

    this.target.z = clamp(this.target.z, minDistance, maxDistance)
    this.target.z = Math.max(this.target.z, (1.1 * this.visibleWidth) / 2 / this.tangentHalfFOV) // handle very wide panels
    this.baseDistance = this.target.z
    this.target.y = clamp(this.target.y, minElevation, maxElevation)
    this.savedElevation = this.target.y
    this.tiltRecovering = false
    this.prevTiltMode = false
    const dist = new vec2(this.target.y, this.target.z).length
    const halfFov = Math.atan((this.tangentHalfFOV * dist - this.visibleWidth / 2) / this.target.z)
    this.target.x = clamp(this.target.x, -halfFov, halfFov)
    this.velocity = vec3.zero()
    this.omega = 0
  }

  private onUpdate() {
    if (!this.dragging) {
      const pos = this.cartesianToCylindrical(this.worldToBody(this.worldPos))

      const pitch = this.cameraPitch
      const pitchDeg = pitch * RadToDeg
      this.updateTiltState(pitchDeg)

      if (this._inTiltMode) {
        if (!this.prevTiltMode) {
          this.savedElevation = clamp(pos.y, minElevation, maxElevation)
        }
        this.target.y = this.baseDistance * Math.sin(pitch)
        this.target.z = this.baseDistance * Math.cos(pitch)
        this.tiltRecovering = true
      } else if (this.tiltRecovering) {
        this.target.y = this.savedElevation
        this.target.z = this.baseDistance
        if (Math.abs(pos.y - this.savedElevation) < tiltRecoveryThreshold) {
          this.tiltRecovering = false
        }
      } else {
        this.target.y = clamp(pos.y, minElevation, maxElevation)
        this.target.z = this.baseDistance
      }
      this.prevTiltMode = this._inTiltMode
      ;[pos.x, this.velocity.x] = smoothDamp(pos.x, this.target.x, this.velocity.x, translationTime, getDeltaTime())
      ;[pos.y, this.velocity.y] = smoothDamp(pos.y, this.target.y, this.velocity.y, translationTime, getDeltaTime())
      ;[pos.z, this.velocity.z] = smoothDamp(pos.z, this.target.z, this.velocity.z, translationTime, getDeltaTime())
      this.worldPos = this.bodyToWorld(this.cylindricalToCartesian(pos))
      ;[this.heading, this.omega] = smoothDampAngle(
        this.heading,
        this.cameraHeading,
        this.omega,
        rotationTime,
        getDeltaTime()
      )
      const lookDir = this.cameraPos.sub(this.worldPos).normalize()
      this.worldRot = computeBillboardRotation(lookDir, this.cameraTransform.up, this.initialRot)
    }
  }

  /**
   * Evaluates whether tilt mode should be active based on camera pitch,
   * with hysteresis to prevent flickering at the threshold boundary.
   */
  private updateTiltState(pitchDeg: number): void {
    if (this._inTiltMode) {
      const exitUp = this.tiltUpThreshold - Math.min(tiltExitBuffer, this.tiltUpThreshold / 2)
      const exitDown = this.tiltDownThreshold - Math.min(tiltExitBuffer, this.tiltDownThreshold / 2)
      this._inTiltMode = this.tiltEnabled && (pitchDeg > exitUp || pitchDeg < -exitDown)
    } else {
      this._inTiltMode = this.tiltEnabled && (pitchDeg > this.tiltUpThreshold || pitchDeg < -this.tiltDownThreshold)
    }
  }

  private cartesianToCylindrical(v: vec3): vec3 {
    return new vec3(Math.atan2(-v.x, -v.z), v.y, Math.sqrt(v.x * v.x + v.z * v.z))
  }

  private cylindricalToCartesian(v: vec3): vec3 {
    return new vec3(v.z * -Math.sin(v.x), v.y, v.z * -Math.cos(v.x))
  }

  private worldToBody(v: vec3): vec3 {
    return quat.angleAxis(-this.cameraHeading, vec3.up()).multiplyVec3(v.sub(this.cameraPos))
  }

  private bodyToWorld(v: vec3): vec3 {
    return quat.angleAxis(this.cameraHeading, vec3.up()).multiplyVec3(v).add(this.cameraPos)
  }

  private get cameraPitch(): number {
    const forward = this.cameraTransform.forward
    return Math.atan2(-forward.y, Math.sqrt(forward.x * forward.x + forward.z * forward.z))
  }

  private get cameraHeading(): number {
    const forward = this.cameraTransform.forward
    return Math.atan2(forward.x, forward.z)
  }

  private get cameraPos(): vec3 {
    return this.cameraTransform.getWorldPosition()
  }

  private get worldRot(): quat {
    return this.transform.getWorldRotation()
  }

  private set worldRot(value: quat) {
    this.transform.setWorldRotation(value)
  }

  private get worldPos(): vec3 {
    return this.transform.getWorldPosition()
  }

  private set worldPos(value: vec3) {
    this.transform.setWorldPosition(value)
  }
}

import WorldCameraFinderProvider from "InteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import Event, {PublicApi, unsubscribe} from "InteractionKit.lspkg/Utils/Event"
import {clamp, RadToDeg} from "InteractionKit.lspkg/Utils/mathUtils"
import {computeBillboardRotation} from "./FollowBillboard"

/** Number of velocity samples kept in the rolling average ring buffer. */
const VELOCITY_SAMPLE_COUNT = 4

/** Seconds to suppress dead-zone checks after a reposition to prevent re-triggering. */
const SETTLE_COOLDOWN: number = 0.5

/** Default minimum distance (cm) between camera and panel. */
const DEFAULT_MIN_DISTANCE: number = 20
/** Default maximum distance (cm) between camera and panel. */
const DEFAULT_MAX_DISTANCE: number = 200

enum TagAlongState {
  /** Frame is world-locked. Dead-zone checked each frame. */
  Idle,
  /** Dead zone exceeded — waiting for user to come to rest or timeout. */
  Pending
}

export type TagAlongOptions = {
  transform: Transform
  onFollowUpdate: PublicApi<void>
  onDragStart: PublicApi<void>
  onDragEnd: PublicApi<void>
  onScalingStart: PublicApi<void>
  onScalingEnd: PublicApi<void>
  onSizeChanged: PublicApi<vec3>
  deadZoneAngle?: number
  followDistance?: number
  verticalOffset?: number
  angularRestThreshold?: number
  translationalRestThreshold?: number
  pendingTimeout?: number
}

/**
 * Tag-along follow behavior for {@link Frame}.
 *
 * The frame stays world-locked and does not move until the user has looked
 * far enough away (horizontal dead-zone), moved too close / too far, AND
 * come to rest (or a timeout elapses). At that point the frame silently
 * teleports in front of the user.
 *
 * Because the user is looking away from the frame's old position when
 * repositioning triggers, the teleport is not visible — the frame simply
 * appears at the new location when the user turns back.
 */
export default class TagAlong {
  private mainCamera: Camera = WorldCameraFinderProvider.getInstance().getComponent()
  private cameraTransform: Transform = this.mainCamera.getTransform()
  private transform: Transform = this.options.transform

  private deadZoneAngle: number
  public followDistance: number
  private verticalOffset: number
  private angularRestThreshold: number
  private translationalRestThreshold: number
  private pendingTimeout: number

  private state: TagAlongState = TagAlongState.Idle
  private dragging: boolean = false
  private paused: boolean = false
  // Skip one frame before the initial teleport so device tracking has a
  // full engine cycle to report an accurate camera pose.
  private initFramesRemaining: number = 1
  private dragAccepted: boolean = false

  private prevCameraForward: vec3
  private prevCameraPos: vec3

  // Ring-buffer velocity tracking — O(1) insertion, no array shifting.
  private angularSamples: number[] = new Array(VELOCITY_SAMPLE_COUNT).fill(0)
  private translationalSamples: number[] = new Array(VELOCITY_SAMPLE_COUNT).fill(0)
  private sampleIndex: number = 0
  private samplesFilled: boolean = false

  private pendingTimer: number = 0

  private idleCooldown: number = 0
  private unsubscribes: unsubscribe[] = []

  // Per-frame cached values to avoid redundant computation.
  private cachedAngle: number = 0
  private cachedDistance: number = 0

  /** Fires when the frame begins a reposition teleport. */
  private _onRecenterEvent: Event<void> = new Event<void>()
  public readonly onRecenter: PublicApi<void> = this._onRecenterEvent.publicApi()

  /** Whether the tag-along is currently in the process of repositioning. */
  private _isMoving: boolean = false
  public get isMoving(): boolean {
    return this._isMoving
  }

  public constructor(private options: TagAlongOptions) {
    this.deadZoneAngle = options.deadZoneAngle ?? 35
    this.followDistance = options.followDistance ?? 110
    this.verticalOffset = options.verticalOffset ?? -5
    this.angularRestThreshold = options.angularRestThreshold ?? 12
    this.translationalRestThreshold = options.translationalRestThreshold ?? 40
    this.pendingTimeout = options.pendingTimeout ?? 2.0

    this.prevCameraForward = this.cameraTransform.forward
    this.prevCameraPos = this.cameraTransform.getWorldPosition()

    this.unsubscribes.push(
      options.onFollowUpdate.add(() => this.onUpdate()),
      options.onDragStart.add(() => this.startDragging()),
      options.onDragEnd.add(() => this.finishDragging()),
      options.onScalingStart.add(() => this.startDragging()),
      options.onScalingEnd.add(() => this.finishDragging()),
      options.onSizeChanged.add(() => {})
    )
  }

  private startDragging(): void {
    this.dragging = true
  }

  private finishDragging(): void {
    this.dragging = false
    this.dragAccepted = true
    this.state = TagAlongState.Idle
    this._isMoving = false
    this.idleCooldown = SETTLE_COOLDOWN
  }

  /** Pause all tag-along processing (e.g. while interacting with world-locked content). */
  public pause(): void {
    this.paused = true
  }

  /** Resume tag-along processing after a pause. Resets velocity history. */
  public resume(): void {
    this.paused = false
    this.resetVelocitySamples()
    this.prevCameraForward = this.cameraTransform.forward
    this.prevCameraPos = this.cameraTransform.getWorldPosition()
  }

  /** Force the frame to recenter in front of the camera immediately. */
  public recenter(): void {
    this.teleportToTarget()
  }

  /** Release resources. Called when the parent Frame is disabled/destroyed. */
  public destroy(): void {
    this.paused = true
    this.resetVelocitySamples()
    this.unsubscribes.forEach((u) => u())
    this.unsubscribes = []
  }

  private onUpdate(): void {
    if (this.initFramesRemaining >= 0) {
      if (this.initFramesRemaining === 0) {
        this.teleportToTarget()
      }
      this.initFramesRemaining--
      return
    }

    if (this.dragging || this.paused) return

    const dt = getDeltaTime()
    if (dt <= 0) return

    this.updateVelocityTracking(dt)

    this.cachedAngle = this.computeOffAxisAngle()
    this.cachedDistance = this.distanceToPanel()

    switch (this.state) {
      case TagAlongState.Idle:
        this.updateIdle(dt)
        break
      case TagAlongState.Pending:
        this.updatePending(dt)
        break
    }
  }

  // ── State handlers ──────────────────────────────────────────────────

  private updateIdle(dt: number): void {
    if (this.idleCooldown > 0) {
      this.idleCooldown -= dt
      return
    }

    const outOfDeadZone = this.cachedAngle > this.deadZoneAngle

    // After a manual drag, suppress distance-based triggers so the user's
    // placement is respected. Only an angle-based trigger (looking away)
    // will recenter and clear this flag.
    const tooFar = !this.dragAccepted && this.cachedDistance > DEFAULT_MAX_DISTANCE
    const tooClose = !this.dragAccepted && this.cachedDistance < DEFAULT_MIN_DISTANCE

    if (outOfDeadZone || tooFar || tooClose) {
      this.state = TagAlongState.Pending
      this._isMoving = true
      this.pendingTimer = 0
    }
  }

  private updatePending(dt: number): void {
    const withinDeadZone = this.cachedAngle <= this.deadZoneAngle
    const withinDistance = this.cachedDistance >= DEFAULT_MIN_DISTANCE && this.cachedDistance <= DEFAULT_MAX_DISTANCE

    if (withinDeadZone && withinDistance) {
      this.state = TagAlongState.Idle
      this._isMoving = false
      return
    }

    this.pendingTimer += dt

    // The timeout is a fallback for when velocity data is incomplete.
    // Once we have a full window of samples, only reposition when the
    // user has actually slowed down — never while still moving fast.
    const timedOut = this.pendingTimer >= this.pendingTimeout && !this.samplesFilled

    if (this.isUserAtRest() || timedOut) {
      this.teleportToTarget()
    }
  }

  // ── Reposition ──────────────────────────────────────────────────────

  /**
   * Instantly move the frame to directly in front of the user and
   * billboard it to face them. The teleport is invisible because the
   * user is looking away from the frame's old position.
   */
  private teleportToTarget(): void {
    const radius = this.followDistance

    const viewDir = this.horizontalViewDirection
    this.worldPos = this.cameraPos.add(viewDir.uniformScale(radius)).add(new vec3(0, this.verticalOffset, 0))

    this.updateBillboard()

    this.state = TagAlongState.Idle
    this._isMoving = false
    this.dragAccepted = false
    this.idleCooldown = SETTLE_COOLDOWN
    this._onRecenterEvent.invoke()
  }

  // ── Dead zone ───────────────────────────────────────────────────────

  /**
   * Horizontal angle (degrees) between the camera's viewing direction and
   * the direction to the panel, measured on the XZ plane. Pitch is ignored
   * so that looking up/down does not trigger repositioning.
   */
  private computeOffAxisAngle(): number {
    const toPanel = this.worldPos.sub(this.cameraPos)
    const viewDir = this.horizontalViewDirection

    const toPanelFlat = new vec3(toPanel.x, 0, toPanel.z)

    const toPanelLen = toPanelFlat.length
    if (toPanelLen < 0.001) {
      return 180
    }

    const dot = clamp(toPanelFlat.dot(viewDir) / toPanelLen, -1, 1)
    return Math.acos(dot) * RadToDeg
  }

  /** Distance (cm) from the camera to the panel. */
  private distanceToPanel(): number {
    return this.worldPos.sub(this.cameraPos).length
  }

  // ── Velocity-aware rest detection ───────────────────────────────────

  private updateVelocityTracking(dt: number): void {
    const currentForward = this.cameraTransform.forward
    const currentPos = this.cameraPos

    const forwardDot = clamp(currentForward.dot(this.prevCameraForward), -1, 1)
    const angularVelocity = (Math.acos(forwardDot) * RadToDeg) / dt
    const translationalVelocity = currentPos.sub(this.prevCameraPos).length / dt

    this.angularSamples[this.sampleIndex] = angularVelocity
    this.translationalSamples[this.sampleIndex] = translationalVelocity
    this.sampleIndex = (this.sampleIndex + 1) % VELOCITY_SAMPLE_COUNT
    if (!this.samplesFilled && this.sampleIndex === 0) {
      this.samplesFilled = true
    }

    this.prevCameraForward = currentForward
    this.prevCameraPos = currentPos
  }

  /**
   * Returns true when both angular and translational velocity rolling
   * averages have dropped below their respective thresholds. Requires a
   * full window of samples to avoid false positives on startup.
   */
  private isUserAtRest(): boolean {
    if (!this.samplesFilled) {
      return false
    }

    let angularSum = 0
    let translationalSum = 0
    for (let i = 0; i < VELOCITY_SAMPLE_COUNT; i++) {
      angularSum += this.angularSamples[i]
      translationalSum += this.translationalSamples[i]
    }

    return (
      angularSum / VELOCITY_SAMPLE_COUNT < this.angularRestThreshold &&
      translationalSum / VELOCITY_SAMPLE_COUNT < this.translationalRestThreshold
    )
  }

  private resetVelocitySamples(): void {
    this.angularSamples.fill(0)
    this.translationalSamples.fill(0)
    this.sampleIndex = 0
    this.samplesFilled = false
  }

  // ── Billboard rotation ──────────────────────────────────────────────

  /**
   * Orient the frame to face the camera. Uses a gravity-aligned up-vector
   * that slerps toward camera-up near vertical orientations to avoid the
   * lookAt singularity.
   */
  private updateBillboard(): void {
    const lookDir = this.cameraPos.sub(this.worldPos).normalize()
    this.worldRot = computeBillboardRotation(lookDir, this.cameraTransform.up)
  }

  // ── Camera accessors ────────────────────────────────────────────────

  /**
   * Unit-length horizontal viewing direction derived from the camera's
   * left axis crossed with world up. This is immune to the forward/back
   * ambiguity that varies across camera configurations.
   */
  private get horizontalViewDirection(): vec3 {
    const raw = this.cameraTransform.left.cross(vec3.up())
    const len = raw.length
    return len > 0.001 ? raw.uniformScale(1 / len) : new vec3(0, 0, -1)
  }

  private get cameraPos(): vec3 {
    return this.cameraTransform.getWorldPosition()
  }

  // ── Transform accessors ─────────────────────────────────────────────

  private get worldPos(): vec3 {
    return this.transform.getWorldPosition()
  }

  private set worldPos(value: vec3) {
    this.transform.setWorldPosition(value)
  }

  private set worldRot(value: quat) {
    this.transform.setWorldRotation(value)
  }
}

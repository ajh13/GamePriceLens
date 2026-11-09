import WorldCameraFinderProvider from "InteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"

/**
 * helper internal plane class for frustum calculations
 */
class Plane {
  public constructor(
    public normal: vec3,
    public constant: number
  ) {}

  public name: string = ""

  public distanceToPoint(point: vec3): number {
    return this.normal.dot(point) + this.constant
  }

  public coplanarPoint = (target: vec3): vec3 => {
    target = this.normal
    return target.uniformScale(-this.constant)
  }

  public setFromNormalAndCoplanarPoint(normal: vec3, point: vec3) {
    // Store a fresh copy of the normal so callers can pass scratch vectors
    // without aliasing this plane's normal.
    this.normal = normal.uniformScale(1)
    this.constant = -point.dot(this.normal)

    return this
  }

  public setFromCoplanarPoints = (a: vec3, b: vec3, c: vec3) => {
    // normal = normalize((c - b) x (a - b))
    const normal = c.sub(b).cross(a.sub(b)).normalize()
    this.setFromNormalAndCoplanarPoint(normal, a)
  }

  public projectPoint = (point: vec3): vec3 => {
    return point.add(this.normal.uniformScale(-1 * this.distanceToPoint(point)))
  }
}

/**
 * Simple Frustum for calculating 3D visibility in a frustum with an spatially arbitrary near plane
 */

const FRUSTUM_PLANE_COUNT = 6
const FRUSTUM_CORNER_COUNT = 8

// Below this squared camera-to-window distance the near-plane fov math is
// singular (fov -> PI, tan -> Inf). Guarded so we never cache NaN geometry.
const DEGENERATE_DISTANCE_SQ = 1e-6

// Debug-render colors, shared across render()'s draw calls. Safe to share: debugRenderSystem.draw*
// reads the color immediately and never retains or mutates it.
const DEBUG_CORNER_COLOR = new vec4(0, 1, 0, 1) // green — frustum corners
const DEBUG_LINE_COLOR = new vec4(1, 0, 0, 1) // red — near/far/connecting edges
const DEBUG_NORMAL_COLOR = new vec4(0, 1, 1, 1) // cyan — plane normals

export class Frustum {
  private planes: Plane[] = []
  private corners: vec3[] = []
  private names: string[] = ["left", "right", "top", "bottom", "near", "far"]

  // Lazy-refresh inputs. While camera/transform are unset, refresh() is a no-op
  // and the frustum reflects whatever the last (deprecated) setFromNearPlane()
  // produced — preserving the legacy call pattern.
  private _camera: Camera | null = null
  private _transform: Transform | null = null
  private _localSize: vec2 = vec2.zero()

  // Dirty + frame-coalesce state. _dirty forces a recompute on next read (set by the
  // config setters); _lastEvalTime makes repeated reads within the same frame free.
  private _dirty: boolean = true
  private _hasComputed: boolean = false
  private _lastEvalTime: number = -1

  /**
   * @param camera camera component whose transform position and `far` drive the frustum
   * @param transform transform of the near plane
   * @param localSize near-plane size in the transform's local space
   */
  public constructor(camera?: Camera, transform?: Transform, localSize?: vec2) {
    for (let i = 0; i < FRUSTUM_PLANE_COUNT; i++) {
      const newPlane = new Plane(vec3.one(), 0)
      newPlane.name = this.names[i]
      this.planes.push(newPlane)
    }
    // Pre-allocate corners so getters never return undefined before the first
    // compute. recompute() replaces these with fresh objects.
    for (let i = 0; i < FRUSTUM_CORNER_COUNT; i++) {
      this.corners.push(vec3.zero())
    }
    if (camera) {
      this._camera = camera
    }
    if (transform) {
      this._transform = transform
    }
    if (localSize) {
      this._localSize.copyFrom(localSize)
    }
  }

  // ---- configuration (preferred, lazy path) --------------------------------

  /** Set the camera whose world position and `far` drive the frustum. Recomputes on next read. */
  public setCamera(camera: Camera): void {
    this._camera = camera
    this._dirty = true
  }

  /** Set the near-plane transform. Recomputes on next read. */
  public setTransform(transform: Transform): void {
    this._transform = transform
    this._dirty = true
  }

  /** Set the near-plane size in local space (world size = this × the transform's world scale). Recomputes on next read. */
  public setSize(localSize: vec2): void {
    this._localSize.copyFrom(localSize)
    this._dirty = true
  }

  /**
   * get left plane
   */
  public get left() {
    this.refresh()
    return this.planes[0]
  }

  /**
   * set left plane
   */
  public set left(plane: Plane) {
    this.planes[0] = plane
  }

  /**
   * get right plane
   */
  public get right() {
    this.refresh()
    return this.planes[1]
  }

  /**
   * set right plane
   */
  public set right(plane: Plane) {
    this.planes[1] = plane
  }

  /**
   * get top plane
   */
  public get top() {
    this.refresh()
    return this.planes[2]
  }

  /**
   * set top plane
   */
  public set top(plane: Plane) {
    this.planes[2] = plane
  }

  /**
   * get bottom plane
   */
  public get bottom() {
    this.refresh()
    return this.planes[3]
  }

  /**
   * set bottom plane
   */
  public set bottom(plane: Plane) {
    this.planes[3] = plane
  }

  /**
   * get near plane
   */
  public get near() {
    this.refresh()
    return this.planes[4]
  }

  /**
   * set near plane
   */
  public set near(plane: Plane) {
    this.planes[4] = plane
  }

  /**
   * get far plane
   */
  public get far() {
    this.refresh()
    return this.planes[5]
  }

  /**
   * set far plane
   */
  public set far(plane: Plane) {
    this.planes[5] = plane
  }

  /**
   * get vec3 point of nearTopLeft Corner
   */
  public get nearTopLeft() {
    this.refresh()
    return this.corners[0]
  }

  /**
   * set vec3 point of nearTopLeft Corner
   */
  public set nearTopLeft(corner: vec3) {
    this.corners[0] = corner
  }

  /**
   * get vec3 point of nearTopRight Corner
   */
  public get nearTopRight() {
    this.refresh()
    return this.corners[1]
  }

  /**
   * set vec3 point of nearTopRight Corner
   */
  public set nearTopRight(corner: vec3) {
    this.corners[1] = corner
  }

  /**
   * get vec3 point of nearBottomRight Corner
   */
  public get nearBottomRight() {
    this.refresh()
    return this.corners[2]
  }

  /**
   * set vec3 point of nearBottomRight Corner
   */
  public set nearBottomRight(corner: vec3) {
    this.corners[2] = corner
  }

  /**
   * get vec3 point of nearBottomLeft Corner
   */
  public get nearBottomLeft() {
    this.refresh()
    return this.corners[3]
  }

  /**
   * set vec3 point of nearBottomLeft Corner
   */
  public set nearBottomLeft(corner: vec3) {
    this.corners[3] = corner
  }

  /**
   * get vec3 point of farTopLeft Corner
   */
  public get farTopLeft() {
    this.refresh()
    return this.corners[4]
  }

  /**
   * set vec3 point of farTopLeft Corner
   */
  public set farTopLeft(corner: vec3) {
    this.corners[4] = corner
  }

  /**
   * get vec3 point of farTopRight Corner
   */
  public get farTopRight() {
    this.refresh()
    return this.corners[5]
  }

  /**
   * set vec3 point of farTopRight Corner
   */
  public set farTopRight(corner: vec3) {
    this.corners[5] = corner
  }

  /**
   * get vec3 point of farBottomRight Corner
   */
  public get farBottomRight() {
    this.refresh()
    return this.corners[6]
  }

  /**
   * set vec3 point of farBottomRight Corner
   */
  public set farBottomRight(corner: vec3) {
    this.corners[6] = corner
  }

  /**
   * get vec3 point of farBottomLeft Corner
   */
  public get farBottomLeft() {
    this.refresh()
    return this.corners[7]
  }

  /**
   * set vec3 point of farBottomLeft Corner
   */
  public set farBottomLeft(corner: vec3) {
    this.corners[7] = corner
  }

  /**
   * @deprecated Prefer configuring once (constructor or {@link setCamera} / {@link setTransform} /
   * {@link setSize}) and just reading the frustum — it then recomputes lazily, at most once per
   * frame. This eager path still works, but don't mix it with the lazy config on one instance: it
   * marks the cache dirty, so the next read re-syncs from setCamera/setTransform/setSize.
   *
   * @param cameraProvider from WorldCameraFinderProvider
   * @param cameraFar camera far render distance
   * @param size near-plane size (world space)
   * @param transform near-plane transform
   */
  public setFromNearPlane(
    cameraProvider: WorldCameraFinderProvider,
    cameraFar: number,
    size: vec2,
    transform: Transform
  ) {
    this.recompute(
      cameraProvider.getWorldPosition(),
      transform.getWorldPosition(),
      transform.up,
      transform.right,
      transform.forward,
      cameraFar,
      size.x,
      size.y
    )
    this._dirty = true
  }

  /**
   * Recompute the frustum from its camera / transform / size if needed (at most once per frame;
   * repeated same-frame reads are free). Called automatically on read; exposed so callers can
   * pre-warm it. No-op until a camera and transform are set.
   */
  public refresh(): void {
    if (this._camera === null || this._transform === null) {
      return
    }
    if (isNull(this._camera) || isNull(this._transform)) {
      return
    }

    const t = getTime()
    // Already current this frame — repeated reads (e.g. culling many points) are free.
    if (!this._dirty && this._hasComputed && t === this._lastEvalTime) {
      return
    }

    const camPos = this._camera.getTransform().getWorldPosition()
    const winPos = this._transform.getWorldPosition()
    const up = this._transform.up
    const right = this._transform.right
    const forward = this._transform.forward
    const scale = this._transform.getWorldScale()
    const far = this._camera.far

    // abs(): a mirrored/negative parent scale would make the scaled size negative, which trips the
    // degenerate guard below and freezes the frustum. The near plane is symmetric, so |size| is right.
    const sizeX = Math.abs(this._localSize.x * scale.x)
    const sizeY = Math.abs(this._localSize.y * scale.y)
    // Degenerate inputs (zero-area plane, or camera at the window) -> NaN/Inf fov math. Skip without
    // touching the cache: keep the last good frustum and retry next read.
    if (sizeX <= 0 || sizeY <= 0 || camPos.distanceSquared(winPos) < DEGENERATE_DISTANCE_SQ) {
      return
    }

    // recompute touches only raw planes/corners + scratch (never the public getters),
    // so it cannot re-enter refresh().
    this.recompute(camPos, winPos, up, right, forward, far, sizeX, sizeY)

    this._dirty = false
    this._hasComputed = true
    this._lastEvalTime = t
  }

  /**
   * Core geometry. Writes the 8 corners (fresh objects) and 6 planes. Uses only raw
   * `this.planes[i]` / `this.corners[i]` access — never the public getters — so it is
   * safe to call from within refresh(). Runs at most once per frame, only when the
   * frustum is actually read.
   */
  private recompute(
    camPos: vec3,
    winPos: vec3,
    up: vec3,
    right: vec3,
    forward: vec3,
    cameraFar: number,
    sizeX: number,
    sizeY: number
  ): void {
    // distance to near plane from camera
    const camDist = camPos.distance(winPos)
    // direction to camera: normalize(camPos - winPos)
    const camDir = camPos.sub(winPos).normalize()
    // aspect ratio of near plane
    const aspectRatio = sizeX / sizeY
    // fov = 2 * atan( nearPlaneHeight / ( 2 * nearPlaneDistance ) )
    const fov = 2 * Math.atan(sizeY / (2 * camDist))

    const thisFar = cameraFar * 0.5
    // far plane center: winPos - camDir * thisFar
    const farPos = winPos.add(camDir.uniformScale(-thisFar))

    // size of far plane
    const farHeight = 2 * Math.tan(fov / 2) * (thisFar + camDist)
    const farWidth = farHeight * aspectRatio

    // half-extent offset vectors (computed once, read-only below)
    const rightFar = right.uniformScale(0.5 * farWidth)
    const upFar = up.uniformScale(0.5 * farHeight)
    const rightNear = right.uniformScale(0.5 * sizeX)
    const upNear = up.uniformScale(0.5 * sizeY)

    // corners — each a fresh vec3 (add/sub return new), so external holders of a
    // previous corner are never mutated underneath them on the next recompute.
    this.corners[4] = farPos.sub(rightFar).add(upFar) // farTopLeft
    this.corners[5] = farPos.add(rightFar).add(upFar) // farTopRight
    this.corners[7] = farPos.sub(rightFar).sub(upFar) // farBottomLeft
    this.corners[6] = farPos.add(rightFar).sub(upFar) // farBottomRight
    this.corners[0] = winPos.sub(rightNear).add(upNear) // nearTopLeft
    this.corners[1] = winPos.add(rightNear).add(upNear) // nearTopRight
    this.corners[3] = winPos.sub(rightNear).sub(upNear) // nearBottomLeft
    this.corners[2] = winPos.add(rightNear).sub(upNear) // nearBottomRight

    // left: camDir x down (down = -up)
    this.planes[0].setFromCoplanarPoints(this.corners[0], this.corners[3], this.corners[4])
    if (this.planes[0].normal.dot(camDir.cross(up.uniformScale(-1))) < 0) {
      this.flipPlane(this.planes[0])
    }

    // right: camDir x up
    this.planes[1].setFromCoplanarPoints(this.corners[1], this.corners[2], this.corners[5])
    if (this.planes[1].normal.dot(camDir.cross(up)) < 0) {
      this.flipPlane(this.planes[1])
    }

    // top: camDir x left (left = -right)
    this.planes[2].setFromCoplanarPoints(this.corners[0], this.corners[1], this.corners[5])
    if (this.planes[2].normal.dot(camDir.cross(right.uniformScale(-1))) < 0) {
      this.flipPlane(this.planes[2])
    }

    // bottom: camDir x right
    this.planes[3].setFromCoplanarPoints(this.corners[3], this.corners[2], this.corners[6])
    if (this.planes[3].normal.dot(camDir.cross(right)) < 0) {
      this.flipPlane(this.planes[3])
    }

    // near: dot(back) < 0 ; back = -forward
    this.planes[4].setFromCoplanarPoints(this.corners[3], this.corners[1], this.corners[2])
    if (this.planes[4].normal.dot(forward.uniformScale(-1)) < 0) {
      this.flipPlane(this.planes[4])
    }

    // far: dot(forward) < 0.5
    this.planes[5].setFromCoplanarPoints(this.corners[4], this.corners[5], this.corners[6])
    if (this.planes[5].normal.dot(forward) < 0.5) {
      this.flipPlane(this.planes[5])
    }
  }

  // Flip a plane's orientation: negate the normal and constant.
  private flipPlane(plane: Plane): void {
    plane.normal = plane.normal.uniformScale(-1)
    plane.constant *= -1
  }

  /**
   *
   * @param point position in world space
   * @returns whether or not given vector is visible through frustum
   */
  public isPointInside = (point: vec3): boolean => {
    this.refresh()
    for (let i = 0; i < this.planes.length; i++) {
      const plane = this.planes[i]
      if (plane.distanceToPoint(point) < 0) {
        return false
      }
    }
    return true
  }

  /**
   *
   * @param aabbMin minimum extent
   * @param aabbMax maximum extent
   * @returns whether or not a box defined by aabbMin and aabbMax is visible in frustum
   */
  public isAABBInside = (aabbMin: vec3, aabbMax: vec3): boolean => {
    this.refresh()
    const center = aabbMin.add(aabbMax).uniformScale(0.5)
    const halfExtents = aabbMax.sub(aabbMin).uniformScale(0.5)
    for (const plane of this.planes) {
      const d = plane.normal.dot(center) + plane.constant
      const r =
        halfExtents.x * Math.abs(plane.normal.x) +
        halfExtents.y * Math.abs(plane.normal.y) +
        halfExtents.z * Math.abs(plane.normal.z)
      if (d + r < 0) {
        return false
      }
    }
    return true
  }

  /**
   *
   * @param position position of sphere
   * @param radius radius of sphere
   * @returns whether or not sphere is visible in frustum
   */
  public isSphereInside = (position: vec3, radius: number): boolean => {
    this.refresh()
    for (const plane of this.planes) {
      const d = plane.normal.dot(position) + plane.constant
      const r =
        radius * Math.abs(plane.normal.x) + radius * Math.abs(plane.normal.y) + radius * Math.abs(plane.normal.z)
      if (d + r < 0) {
        // Cube is entirely outside this plane
        return false
      }
    }
    // Cube is inside or intersects all planes
    return true
  }

  /**
   * Debug Rendering
   */
  public render = () => {
    this.refresh()
    const ntl = this.corners[0]
    const ntr = this.corners[1]
    const nbr = this.corners[2]
    const nbl = this.corners[3]
    const ftl = this.corners[4]
    const ftr = this.corners[5]
    const fbr = this.corners[6]
    const fbl = this.corners[7]

    // corners
    global.debugRenderSystem.drawSphere(ftl, 3, DEBUG_CORNER_COLOR)
    global.debugRenderSystem.drawSphere(ftr, 3, DEBUG_CORNER_COLOR)
    global.debugRenderSystem.drawSphere(fbr, 3, DEBUG_CORNER_COLOR)
    global.debugRenderSystem.drawSphere(fbl, 3, DEBUG_CORNER_COLOR)

    global.debugRenderSystem.drawSphere(ntl, 3, DEBUG_CORNER_COLOR)
    global.debugRenderSystem.drawSphere(ntr, 3, DEBUG_CORNER_COLOR)
    global.debugRenderSystem.drawSphere(nbr, 3, DEBUG_CORNER_COLOR)
    global.debugRenderSystem.drawSphere(nbl, 3, DEBUG_CORNER_COLOR)

    // near plane lines
    global.debugRenderSystem.drawLine(ntl, ntr, DEBUG_LINE_COLOR)
    global.debugRenderSystem.drawLine(ntr, nbr, DEBUG_LINE_COLOR)
    global.debugRenderSystem.drawLine(nbr, nbl, DEBUG_LINE_COLOR)
    global.debugRenderSystem.drawLine(nbl, ntl, DEBUG_LINE_COLOR)

    // far plane lines
    global.debugRenderSystem.drawLine(ftl, ftr, DEBUG_LINE_COLOR)
    global.debugRenderSystem.drawLine(ftr, fbr, DEBUG_LINE_COLOR)
    global.debugRenderSystem.drawLine(fbr, fbl, DEBUG_LINE_COLOR)
    global.debugRenderSystem.drawLine(fbl, ftl, DEBUG_LINE_COLOR)

    // lines between
    global.debugRenderSystem.drawLine(ntl, ftl, DEBUG_LINE_COLOR)
    global.debugRenderSystem.drawLine(ntr, ftr, DEBUG_LINE_COLOR)
    global.debugRenderSystem.drawLine(nbr, fbr, DEBUG_LINE_COLOR)
    global.debugRenderSystem.drawLine(nbl, fbl, DEBUG_LINE_COLOR)

    // plane normals between
    const nearCenterLeft = nbl.add(ntl.sub(nbl).uniformScale(0.5))
    const nearCenterRight = nbr.add(ntr.sub(nbr).uniformScale(0.5))
    const nearCenterTop = ntr.add(ntl.sub(ntr).uniformScale(0.5))
    const nearCenterBottom = nbr.add(nbl.sub(nbr).uniformScale(0.5))
    global.debugRenderSystem.drawLine(
      nearCenterLeft,
      nearCenterLeft.add(this.planes[0].normal.uniformScale(3)),
      DEBUG_NORMAL_COLOR
    )
    global.debugRenderSystem.drawLine(
      nearCenterRight,
      nearCenterRight.add(this.planes[1].normal.uniformScale(3)),
      DEBUG_NORMAL_COLOR
    )
    global.debugRenderSystem.drawLine(
      nearCenterTop,
      nearCenterTop.add(this.planes[2].normal.uniformScale(3)),
      DEBUG_NORMAL_COLOR
    )
    global.debugRenderSystem.drawLine(
      nearCenterBottom,
      nearCenterBottom.add(this.planes[3].normal.uniformScale(3)),
      DEBUG_NORMAL_COLOR
    )
  }
}

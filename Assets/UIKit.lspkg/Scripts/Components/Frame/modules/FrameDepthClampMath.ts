const DEPTH_EPSILON = 1e-4
const MINIMUM_SCALE_FACTOR = 1e-4
// Effectively-unbounded finite cap so `maximumDepth = Infinity` means "no far
// limit" instead of collapsing the range (1e6 cm = 10 km).
const MAXIMUM_FINITE_DEPTH = 1e6
// Overflow defense for absurd finite scale inputs. Infinity scale endpoints
// fall back instead (see normalizeDepthScaleRange) — scale endpoints are curve
// outputs reached at finite depths, so a huge cap would actually be applied.
const MAXIMUM_FINITE_SCALE_FACTOR = 1e4
// cos(60°). Following a ray steeper than this divides the depth correction by
// a small z component, amplifying it into a many-times-larger lateral jump.
const MINIMUM_RAY_FORWARD_RATIO = 0.5
// The ray solution fades in over this forward-ratio band above the floor so
// the resolver stays continuous in ray angle — hand tremor at the threshold
// cannot flip the resolved position between branches frame-to-frame.
const RAY_FORWARD_BLEND_WIDTH = 0.1
// Bounds the radial fallback's outward push to this multiple of the anchor's
// current lateral offset; the raw resolvedDepth/|z| ratio diverges as the
// anchor nears the camera plane.
const MAXIMUM_RADIAL_RATIO = 2

export type DepthClampRay = {
  startWorld: vec3
  directionWorld: vec3
}

export type DepthClampInput = {
  proposedOriginWorld: vec3
  anchorOffsetWorld: vec3
  cameraWorldTransform: mat4
  cameraInvertedWorldTransform: mat4
  minimumDepth: number
  maximumDepth: number
  ray?: DepthClampRay | null
}

export type DepthClampResult = {
  worldPosition: vec3
  anchorWorldPosition: vec3
  requestedDepth: number
  resolvedDepth: number
  wasClamped: boolean
}

export type DepthScaleRange = {
  minimum: number
  maximum: number
}

/**
 * Normalizes a public depth range into positive, ordered, finite camera-forward
 * distances. "No limit" semantics are only coherent on the far side, so a
 * +Infinity maximum clamps to the supported far bound; any other non-finite
 * endpoint falls back (minimum → 0, maximum → the minimum endpoint).
 */
export function normalizeDepthRange(minimumDepth: number, maximumDepth: number): {minimum: number; maximum: number} {
  const finiteMinimum = Number.isFinite(minimumDepth) ? Math.min(MAXIMUM_FINITE_DEPTH, Math.max(0, minimumDepth)) : 0
  const finiteMaximum =
    maximumDepth === Infinity
      ? MAXIMUM_FINITE_DEPTH
      : Number.isFinite(maximumDepth)
        ? Math.min(MAXIMUM_FINITE_DEPTH, Math.max(0, maximumDepth))
        : finiteMinimum
  return finiteMinimum <= finiteMaximum
    ? {minimum: finiteMinimum, maximum: finiteMaximum}
    : {minimum: finiteMaximum, maximum: finiteMinimum}
}

/**
 * Normalize public scale factors into a finite, positive, ordered range. Scale
 * endpoints are curve outputs reached at finite depths, so "no limit" has no
 * meaning here: every non-finite endpoint falls back (minimum → 1, maximum →
 * the minimum endpoint) instead of applying an enormous scale.
 */
export function normalizeDepthScaleRange(minimumScale: number, maximumScale: number): DepthScaleRange {
  const finiteMinimum = Number.isFinite(minimumScale)
    ? Math.min(MAXIMUM_FINITE_SCALE_FACTOR, Math.max(MINIMUM_SCALE_FACTOR, minimumScale))
    : 1
  const finiteMaximum = Number.isFinite(maximumScale)
    ? Math.min(MAXIMUM_FINITE_SCALE_FACTOR, Math.max(MINIMUM_SCALE_FACTOR, maximumScale))
    : finiteMinimum
  return finiteMinimum <= finiteMaximum
    ? {minimum: finiteMinimum, maximum: finiteMaximum}
    : {minimum: finiteMaximum, maximum: finiteMinimum}
}

/** Camera-forward depth (`-cameraSpace.z`) for a world-space point. */
export function cameraForwardDepth(pointWorld: vec3, cameraInvertedWorldTransform: mat4): number {
  return -cameraInvertedWorldTransform.multiplyPoint(pointWorld).z
}

/**
 * Resolve a uniform scale factor on a clamped linear depth curve. A collapsed
 * depth interval deliberately resolves to the far/maximum scale.
 */
export function resolveDepthScaleFactor(
  depth: number,
  minimumDepth: number,
  maximumDepth: number,
  minimumScale: number,
  maximumScale: number
): number {
  const depths = normalizeDepthRange(minimumDepth, maximumDepth)
  const scales = normalizeDepthScaleRange(minimumScale, maximumScale)
  if (!Number.isFinite(depth) || depths.maximum - depths.minimum <= DEPTH_EPSILON) return scales.maximum

  const t = Math.max(0, Math.min(1, (depth - depths.minimum) / (depths.maximum - depths.minimum)))
  return scales.minimum + (scales.maximum - scales.minimum) * t
}

/**
 * Resolve the scale factor for a Frame whose scaling pivots around a grabbed
 * anchor, keeping the factor consistent with the ORIGIN's depth curve. The
 * world anchor offset is linear in the factor (`offsetWorld(f) = f *
 * offsetWorld(1)`), so with `anchorDepth` the camera-forward depth of the
 * displayed anchor and `offsetDepthPerFactor` the camera-forward depth
 * component of the factor-1 offset, the origin sits at depth
 * `anchorDepth - f * offsetDepthPerFactor`. The returned `f` is the fixed
 * point of `f = resolveDepthScaleFactor(anchorDepth - f * k, ...)`, so an
 * origin-based recompute after release reproduces the applied factor exactly —
 * release cannot pop the scale. Piecewise-linear curve → closed form.
 *
 * `offsetDepthPerFactor = 0` (grab at the origin, or offset perpendicular to
 * the camera axis) reduces exactly to `resolveDepthScaleFactor(anchorDepth)`.
 */
export function resolveAnchorPivotedScaleFactor(
  anchorDepth: number,
  offsetDepthPerFactor: number,
  minimumDepth: number,
  maximumDepth: number,
  minimumScale: number,
  maximumScale: number
): number {
  const depths = normalizeDepthRange(minimumDepth, maximumDepth)
  const scales = normalizeDepthScaleRange(minimumScale, maximumScale)
  const depthSpan = depths.maximum - depths.minimum
  if (!Number.isFinite(anchorDepth) || depthSpan <= DEPTH_EPSILON) return scales.maximum

  const offsetDepth = Number.isFinite(offsetDepthPerFactor) ? offsetDepthPerFactor : 0
  const scaleSpan = scales.maximum - scales.minimum
  // Saturated ends of the curve: the factor is pinned, so the origin depth is
  // determined and only has to land on the matching flat segment. These are
  // not steps — at each cutoff the interior formula's numerator factors to
  // scales.max*(D + S*k) / scales.min*(D + S*k), i.e. exactly the pinned
  // value, so the resolver is continuous (and monotone) in anchorDepth and
  // hand tremor at a cutoff cannot flip the factor. The sole discontinuity
  // lives in the degenerate D + S*k <= 0 regime below.
  if (anchorDepth - scales.maximum * offsetDepth >= depths.maximum) return scales.maximum
  if (anchorDepth - scales.minimum * offsetDepth <= depths.minimum) return scales.minimum

  // Interior fixed point of f = min + span * (anchorDepth - f*k - dMin)/dSpan.
  // A non-positive denominator means the offset's forward-depth gain exceeds
  // the curve's depth-to-scale gain (extreme corner offsets toward the camera
  // with a steep curve); no stable interior solution exists, so fall back to
  // the far/maximum convention shared with resolveDepthScaleFactor.
  const denominator = depthSpan + scaleSpan * offsetDepth
  if (denominator <= DEPTH_EPSILON) return scales.maximum
  const factor = (scales.minimum * depthSpan + scaleSpan * (anchorDepth - depths.minimum)) / denominator
  return Math.max(scales.minimum, Math.min(scales.maximum, factor))
}

/**
 * Clamp a proposed Frame origin by the camera-space depth of its manipulation
 * anchor. The anchor is shifted along the interaction ray when it points
 * sufficiently camera-forward (fading in across a ratio band so the result is
 * continuous in ray angle); the capped camera view line is the deterministic
 * fallback for missing or too-steep rays.
 *
 * This function is intentionally pure and has no knowledge of Frame, IK
 * lifecycle, Billboard, or cursor state.
 */
export function resolveDepthClampedPosition(input: DepthClampInput): DepthClampResult {
  const range = normalizeDepthRange(input.minimumDepth, input.maximumDepth)
  const anchorWorld = input.proposedOriginWorld.add(input.anchorOffsetWorld)
  const anchorCamera = input.cameraInvertedWorldTransform.multiplyPoint(anchorWorld)
  const requestedDepth = -anchorCamera.z

  if (!Number.isFinite(requestedDepth)) {
    return {
      worldPosition: input.proposedOriginWorld,
      anchorWorldPosition: anchorWorld,
      requestedDepth,
      resolvedDepth: requestedDepth,
      wasClamped: false
    }
  }

  const resolvedDepth = Math.max(range.minimum, Math.min(range.maximum, requestedDepth))
  if (Math.abs(resolvedDepth - requestedDepth) <= DEPTH_EPSILON) {
    return {
      worldPosition: input.proposedOriginWorld,
      anchorWorldPosition: anchorWorld,
      requestedDepth,
      resolvedDepth,
      wasClamped: false
    }
  }

  // Radial baseline: slide the anchor along the camera-to-anchor line. The
  // capped ratio keeps near-plane anchors (|z| -> 0) from being flung outward,
  // and anchors at/behind the camera plane hold their lateral offset instead
  // of mirroring through the camera origin via a negative ratio.
  let targetAnchorCamera: vec3
  if (anchorCamera.z < -DEPTH_EPSILON) {
    const ratio = Math.min(MAXIMUM_RADIAL_RATIO, resolvedDepth / -anchorCamera.z)
    targetAnchorCamera = new vec3(anchorCamera.x * ratio, anchorCamera.y * ratio, -resolvedDepth)
  } else {
    targetAnchorCamera = new vec3(anchorCamera.x, anchorCamera.y, -resolvedDepth)
  }

  const ray = input.ray
  if (ray) {
    const rayStartCamera = input.cameraInvertedWorldTransform.multiplyPoint(ray.startWorld)
    const rayEndCamera = input.cameraInvertedWorldTransform.multiplyPoint(ray.startWorld.add(ray.directionWorld))
    const rayDirectionCamera = rayEndCamera.sub(rayStartCamera)
    const rayLength = rayDirectionCamera.length
    const forwardRatio = rayLength > DEPTH_EPSILON ? Math.abs(rayDirectionCamera.z) / rayLength : 0
    if (forwardRatio > MINIMUM_RAY_FORWARD_RATIO) {
      const distanceAlongRay = (-resolvedDepth - anchorCamera.z) / rayDirectionCamera.z
      const rayAnchorCamera = anchorCamera.add(rayDirectionCamera.uniformScale(distanceAlongRay))
      const rayWeight = Math.min(1, (forwardRatio - MINIMUM_RAY_FORWARD_RATIO) / RAY_FORWARD_BLEND_WIDTH)
      // Both solutions share z = -resolvedDepth, so the blend is lateral-only.
      targetAnchorCamera = new vec3(
        targetAnchorCamera.x + (rayAnchorCamera.x - targetAnchorCamera.x) * rayWeight,
        targetAnchorCamera.y + (rayAnchorCamera.y - targetAnchorCamera.y) * rayWeight,
        -resolvedDepth
      )
    }
  }

  const targetAnchorWorld = input.cameraWorldTransform.multiplyPoint(targetAnchorCamera)
  return {
    worldPosition: targetAnchorWorld.sub(input.anchorOffsetWorld),
    anchorWorldPosition: targetAnchorWorld,
    requestedDepth,
    resolvedDepth,
    wasClamped: true
  }
}

export function copyRay(ray: DepthClampRay | null): DepthClampRay | null {
  if (ray === null) return null
  return {
    startWorld: new vec3(ray.startWorld.x, ray.startWorld.y, ray.startWorld.z),
    directionWorld: new vec3(ray.directionWorld.x, ray.directionWorld.y, ray.directionWorld.z)
  }
}

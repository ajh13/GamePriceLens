import {colorLerp, RGBtoHSV} from "../../Utility/UIKitUtilities"

/**
 * Size Modes For Texture Background
 */
export type TextureMode = "Stretch" | "Fill Height" | "Fill Width"
/**
 * Wrap Modes For Texture Background
 */
export type TextureWrap = "None" | "Repeat" | "Clamp"
/**
 * Base fill modes for the rounded rectangle background.
 */
export type RoundedRectangleBaseType = "Color" | "Gradient" | "Texture"
/**
 * Gradient Types for background and border
 */
export type GradientType = "Linear" | "Radial" | "Rectangle"
/**
 * Whether border is solid color or gradient
 */
export type BorderType = "Color" | "Gradient"

/**
 * Helper Type For Gradient Stops
 */
export type GradientStop = {
  color?: vec4
  percent?: number
  enabled?: boolean
}

/**
 * Parameters for Border setting functions
 */
export type GradientParameters = {
  enabled?: boolean
  start?: vec2
  end?: vec2
  type?: GradientType
  stop0?: GradientStop
  stop1?: GradientStop
  stop2?: GradientStop
  stop3?: GradientStop
  stop4?: GradientStop
  stop5?: GradientStop
  stop6?: GradientStop
}

export type BaseGradientStopConfig = {
  color: vec4
  percent: number
  enabled: boolean
}

export type BaseGradientConfig = {
  type: GradientType
  start: vec2
  end: vec2
  stop0: BaseGradientStopConfig
  stop1: BaseGradientStopConfig
  stop2: BaseGradientStopConfig
  stop3: BaseGradientStopConfig
  stop4: BaseGradientStopConfig
  stop5: BaseGradientStopConfig
  stop6: BaseGradientStopConfig
}

export type BaseRoundedRectangleConfig = {
  size: vec2
  cornerRadius: number
  blendMode: RoundedRectBlendMode
  opacity: number
  background: {
    color: vec4
    gradient: boolean
    useTexture: boolean
    texture: Texture
    textureMode: TextureMode
    textureWrap: TextureWrap
    gradientConfig: BaseGradientConfig
  }
  border: {
    enabled: boolean
    size: number
    softness: number
    color: vec4
    type: BorderType
    gradientConfig: BaseGradientConfig
  }
}

export const GradientParameters = {
  /**
   * Interpolates between two gradient parameter sets.
   * - t is clamped to [0, 1].
   * - Colors are interpolated in HSV space using the shortest hue path; alpha is linear.
   * - For non-stop fields (enabled, type, start, end), values prefer 'to' when defined, otherwise use 'from'.
   * - For stops: when both exist they are interpolated; if only 'to' exists it fades in with t as alpha; if only 'from' exists it fades out.
   */
  lerp(from: GradientParameters, to: GradientParameters, t: number): GradientParameters {
    const result: GradientParameters = {
      enabled: to.enabled !== undefined ? to.enabled : from.enabled,
      type: to.type !== undefined ? to.type : from.type,
      start: to.start !== undefined ? to.start : from.start,
      end: to.end !== undefined ? to.end : from.end
    }

    result.stop0 = this.lerpStop(from.stop0, to.stop0, t)
    result.stop1 = this.lerpStop(from.stop1, to.stop1, t)
    result.stop2 = this.lerpStop(from.stop2, to.stop2, t)
    result.stop3 = this.lerpStop(from.stop3, to.stop3, t)
    result.stop4 = this.lerpStop(from.stop4, to.stop4, t)
    result.stop5 = this.lerpStop(from.stop5, to.stop5, t)
    result.stop6 = this.lerpStop(from.stop6, to.stop6, t)

    return result
  },

  lerpStop(fromStop: GradientStop | undefined, toStop: GradientStop | undefined, t: number): GradientStop | undefined {
    const fromExists = !!fromStop
    const toExists = !!toStop
    const clampT = MathUtils.clamp(t, 0, 1)

    // Case matrix for existence of stops:
    // - toExists && fromExists: interpolate colors and prefer 'to' for percent/enabled when defined
    // - toExists && !fromExists: fade in 'to' color with alpha = clampT
    // - !toExists && fromExists: fade out 'from' color with alpha scaled by (1 - clampT); disappears at t=1
    // - !toExists && !fromExists: no stop
    if (toExists && fromExists) {
      const fromColor = fromStop!.color ?? vec4.zero()
      const toColor = toStop!.color ?? vec4.zero()
      return {
        color: colorLerp(fromColor, toColor, t),
        percent: toStop!.percent !== undefined ? toStop!.percent : fromStop!.percent,
        enabled: toStop!.enabled !== undefined ? toStop!.enabled : fromStop!.enabled
      }
    }

    if (toExists && !fromExists) {
      const base = toStop!.color ?? vec4.zero()
      return {
        color: new vec4(base.x, base.y, base.z, clampT),
        percent: toStop!.percent,
        enabled: toStop!.enabled
      }
    }

    if (!toExists && fromExists) {
      if (clampT >= 1) {
        return undefined
      }
      const base = fromStop!.color ?? vec4.zero()
      return {
        color: new vec4(base.r, base.g, base.b, (1 - clampT) * base.a),
        percent: fromStop!.percent,
        enabled: fromStop!.enabled
      }
    }

    return undefined
  },

  /**
   * Computes a normalized difference [0, 1] between two gradient parameter sets.
   * Considers enabled, type, start/end, and all stops. For colors, compares HSV with circular hue distance and alpha.
   * Returns the maximum component-wise difference to reflect the most significant change.
   */
  distance(from: GradientParameters, to: GradientParameters): number {
    // Difference is automatically maximum (1) between GradientParameters if:
    // - one is enabled and the other is not
    // - the types are different
    // - one has a start/end position and the other does not
    if ((from.enabled ?? false) !== (to.enabled ?? false) || from.type !== to.type) {
      return 1
    }
    const dStart = from.start && to.start ? from.start.distance(to.start) : from.start || to.start ? 1 : 0
    const dEnd = from.end && to.end ? from.end.distance(to.end) : from.end || to.end ? 1 : 0

    const dStops = Math.max(
      this.stopDistance(from.stop0, to.stop0),
      this.stopDistance(from.stop1, to.stop1),
      this.stopDistance(from.stop2, to.stop2),
      this.stopDistance(from.stop3, to.stop3),
      this.stopDistance(from.stop4, to.stop4),
      this.stopDistance(from.stop5, to.stop5),
      this.stopDistance(from.stop6, to.stop6)
    )

    return MathUtils.clamp(Math.max(dStart, dEnd, dStops), 0, 1)
  },

  stopDistance(a?: GradientStop, b?: GradientStop): number {
    const aExists = !!a
    const bExists = !!b
    if (!aExists && !bExists) return 0
    if (aExists && !bExists) return 1
    if (!aExists && bExists) return 1

    const dEnabled = (a!.enabled ?? false) === (b!.enabled ?? false) ? 0 : 1

    const aPercent = a!.percent
    const bPercent = b!.percent
    const dPercent =
      aPercent === undefined && bPercent === undefined
        ? 0
        : aPercent === undefined || bPercent === undefined
          ? 1
          : MathUtils.clamp(Math.abs(aPercent - bPercent), 0, 1)

    const aColor = a!.color
    const bColor = b!.color
    let dColor: number
    if (!aColor && !bColor) {
      dColor = 0
    } else if (aColor && !bColor) {
      dColor = 1
    } else if (!aColor && bColor) {
      dColor = 1
    } else {
      const hsvA = RGBtoHSV(aColor!)
      const hsvB = RGBtoHSV(bColor!)
      const sA = hsvA.y
      const sB = hsvB.y
      // Inline colorDistance's hue distance using the HSV we already converted above -
      // calling colorDistance(aColor, bColor) would run RGBtoHSV on both colors a second time.
      const dH = sA === 0 && sB === 0 ? 0 : MathUtils.clamp(Math.abs(((hsvB.x - hsvA.x + 540) % 360) - 180) / 180, 0, 1)
      const dS = Math.abs(sA - sB)
      const dV = Math.abs(hsvA.z - hsvB.z)
      const dA = Math.abs(aColor!.a - bColor!.a)
      dColor = Math.max(dH, dS, dV, dA)
    }

    return Math.max(dEnabled, dPercent, dColor)
  }
}

export enum RoundedRectBlendMode {
  Disabled,
  Normal
}

function createDisabledStopConfig(): BaseGradientStopConfig {
  return {color: new vec4(0, 0, 0, 0), percent: 1, enabled: false}
}

export function createDefaultBackgroundGradientConfig(): BaseGradientConfig {
  return {
    type: "Linear",
    start: new vec2(-1, -1),
    end: new vec2(1, 1),
    stop0: {color: new vec4(0.5, 0.5, 0.5, 1), percent: 0, enabled: true},
    stop1: {color: new vec4(0.75, 0.75, 0.7, 1), percent: 0, enabled: true},
    stop2: createDisabledStopConfig(),
    stop3: createDisabledStopConfig(),
    stop4: createDisabledStopConfig(),
    stop5: createDisabledStopConfig(),
    stop6: createDisabledStopConfig()
  }
}

export function createDefaultBorderGradientConfig(): BaseGradientConfig {
  return {
    type: "Linear",
    start: new vec2(-1, -1),
    end: new vec2(1, 1),
    stop0: {color: new vec4(0.5, 0.5, 0.5, 1), percent: 0, enabled: true},
    stop1: {color: new vec4(0.75, 0.75, 0.7, 1), percent: 1, enabled: true},
    stop2: createDisabledStopConfig(),
    stop3: createDisabledStopConfig(),
    stop4: createDisabledStopConfig(),
    stop5: createDisabledStopConfig(),
    stop6: createDisabledStopConfig()
  }
}

// Shared by default RoundedRectangleVisual configs. BaseRoundedRectangle treats
// identity with these objects as a COW sentinel; read paths must not mutate them.
// Lazily built on first use (CC16) so surfaces that never create a RoundedRectangle
// pay nothing at turnOn; the isSharedDefault* checks are null-safe before first build.
let sharedDefaultBackgroundGradient: BaseGradientConfig | null = null
let sharedDefaultBorderGradient: BaseGradientConfig | null = null

export function getSharedDefaultBackgroundGradient(): BaseGradientConfig {
  if (sharedDefaultBackgroundGradient === null) {
    sharedDefaultBackgroundGradient = createDefaultBackgroundGradientConfig()
  }
  return sharedDefaultBackgroundGradient
}

export function getSharedDefaultBorderGradient(): BaseGradientConfig {
  if (sharedDefaultBorderGradient === null) {
    sharedDefaultBorderGradient = createDefaultBorderGradientConfig()
  }
  return sharedDefaultBorderGradient
}

export function isSharedDefaultBackgroundGradient(config: BaseGradientConfig): boolean {
  return config === sharedDefaultBackgroundGradient
}

export function isSharedDefaultBorderGradient(config: BaseGradientConfig): boolean {
  return config === sharedDefaultBorderGradient
}

export function createDefaultRoundedRectangleConfig(
  size: vec2,
  blendMode: RoundedRectBlendMode
): BaseRoundedRectangleConfig {
  return {
    size,
    cornerRadius: 1,
    blendMode,
    opacity: 1,
    background: {
      color: new vec4(0.8, 0.8, 0.8, 1),
      gradient: false,
      useTexture: false,
      texture: null,
      textureMode: "Stretch",
      textureWrap: "None",
      gradientConfig: getSharedDefaultBackgroundGradient()
    },
    border: {
      enabled: false,
      size: 0.2,
      softness: 0.005,
      color: new vec4(0.8, 0.8, 0.8, 1),
      type: "Color",
      gradientConfig: getSharedDefaultBorderGradient()
    }
  }
}

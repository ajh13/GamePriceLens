import {clamp} from "InteractionKit.lspkg/Utils/mathUtils"
import {HSVtoRGB, RGBtoHSV} from "../../Utility/UIKitUtilities"

/**
 * Shared color-picker-domain types, constants, and helpers used by
 * ColorPicker and ColorArea: pure HSVA/hex color math, the value-field
 * format model, plus the small formatting helpers the picker applies to
 * its text fields.
 */

export enum ColorPickerFormat {
  Hex = "Hex",
  RGB = "RGB",
  HSB = "HSB",
  CMYK = "CMYK"
}

/** Dropdown option order; the tapped index maps back through this list. */
export const FORMAT_OPTIONS: ColorPickerFormat[] = [
  ColorPickerFormat.Hex,
  ColorPickerFormat.RGB,
  ColorPickerFormat.HSB,
  ColorPickerFormat.CMYK
]

export type ColorPickerChannelSpec = {
  placeholder: string
  /** The channel's display maximum; field entries clamp to [0, max]. */
  max: number
}

// Value-field composition per format: Hex uses the single hex text field;
// the other formats show one numeric field per channel.
//
// The channel abbreviations are deliberately NOT localized: RGB, HSB, and
// CMYK are invariant technical standards, and their initialisms are read as
// part of the notation rather than as prose. Each placeholder therefore
// carries an l10n-ignore so the localization audit stops treating these
// literals as untranslated copy.
export const FORMAT_CHANNEL_SPECS: Record<ColorPickerFormat, ColorPickerChannelSpec[]> = {
  [ColorPickerFormat.Hex]: [],
  [ColorPickerFormat.RGB]: [
    {placeholder: "R", max: 255}, // l10n-ignore
    {placeholder: "G", max: 255}, // l10n-ignore
    {placeholder: "B", max: 255} // l10n-ignore
  ],
  [ColorPickerFormat.HSB]: [
    {placeholder: "H", max: 360}, // l10n-ignore
    {placeholder: "S", max: 100}, // l10n-ignore
    {placeholder: "B", max: 100} // l10n-ignore
  ],
  [ColorPickerFormat.CMYK]: [
    {placeholder: "C", max: 100}, // l10n-ignore
    {placeholder: "M", max: 100}, // l10n-ignore
    {placeholder: "Y", max: 100}, // l10n-ignore
    {placeholder: "K", max: 100} // l10n-ignore
  ]
}

/** The widest format's channel count — sizes the picker's field pool. */
export const MAX_CHANNEL_FIELD_COUNT = FORMAT_CHANNEL_SPECS[ColorPickerFormat.CMYK].length

/** Resolves a serialized format string, falling back to Hex. */
export function normalizeFormat(value: string): ColorPickerFormat {
  return FORMAT_OPTIONS.indexOf(value as ColorPickerFormat) >= 0 ? (value as ColorPickerFormat) : ColorPickerFormat.Hex
}

/**
 * An HSVA color with hue in degrees [0, 360] and saturation, value, and
 * alpha in [0, 1]. HSVA is the picker's canonical color state: unlike RGBA
 * it keeps hue and saturation stable while value or saturation pass through
 * zero, so the controls don't snap while dragging through black or gray.
 */
export type HSVAColor = {
  hue: number
  saturation: number
  value: number
  alpha: number
}

/** A parsed hex color and whether the source text carried alpha digits. */
export type ParsedHexColor = {
  color: vec4
  hasAlpha: boolean
}

const MIN_HUE = 0
const MAX_HUE = 360

const HEX_DIGIT_PATTERN = /^[0-9a-fA-F]+$/
const HEX_CHANNEL_MAX = 255
const ALPHA_PERCENT_MAX = 100

/** Clamps a channel to [0, 1], mapping non-finite values to a fallback. */
export function clampUnit(value: number, fallback: number = 0): number {
  if (!isFinite(value)) return fallback

  return clamp(value, 0, 1)
}

/** Clamps a hue to [0, 360] degrees, mapping non-finite values to a fallback. */
export function clampHue(value: number, fallback: number = 0): number {
  if (!isFinite(value)) return fallback

  return clamp(value, MIN_HUE, MAX_HUE)
}

/** Returns a copy of an HSVA color. */
export function cloneHSVA(color: HSVAColor): HSVAColor {
  return {
    hue: color.hue,
    saturation: color.saturation,
    value: color.value,
    alpha: color.alpha
  }
}

/** Returns whether two HSVA colors are channel-for-channel equal. */
export function areHSVAColorsEqual(a: HSVAColor, b: HSVAColor): boolean {
  return a.hue === b.hue && a.saturation === b.saturation && a.value === b.value && a.alpha === b.alpha
}

/** Returns a copy of an HSVA color with every channel clamped to its valid range. */
export function normalizeHSVA(color: HSVAColor): HSVAColor {
  return {
    hue: clampHue(color.hue),
    saturation: clampUnit(color.saturation),
    value: clampUnit(color.value),
    alpha: clampUnit(color.alpha, 1)
  }
}

/** Converts an HSVA color to an RGBA vec4. */
export function hsvaToColor(color: HSVAColor): vec4 {
  return HSVtoRGB(color.hue, color.saturation, color.value, color.alpha)
}

/**
 * Converts an RGBA color to HSVA. Grayscale colors have no defined hue and
 * black has no defined saturation, so those channels are preserved from the
 * previous HSVA state instead of collapsing to zero — otherwise a picker
 * dragged through black would lose its hue and saturation positions.
 * @param color - The RGBA color to convert.
 * @param previous - The HSVA state whose degenerate channels are preserved.
 */
export function colorToHSVA(color: vec4, previous?: HSVAColor): HSVAColor {
  const hsv = RGBtoHSV(color)
  const value = clampUnit(hsv.z)
  const saturation = value === 0 ? (previous?.saturation ?? clampUnit(hsv.y)) : clampUnit(hsv.y)
  const hue = saturation === 0 || value === 0 ? (previous?.hue ?? clampHue(hsv.x)) : clampHue(hsv.x)
  return {
    hue,
    saturation,
    value,
    alpha: clampUnit(color.a, 1)
  }
}

/**
 * The byte a channel renders as in hex, 0-255. Shared by
 * {@link formatColorToHex} and {@link hexColorKey} so a key and its string
 * can never round differently.
 * @param channel - The channel value in [0, 1].
 */
export function quantizeHexByte(channel: number): number {
  return Math.round(clampUnit(channel) * HEX_CHANNEL_MAX)
}

function channelToHexByte(channel: number): string {
  return quantizeHexByte(channel).toString(16).toUpperCase().padStart(2, "0")
}

/**
 * Formats an RGBA color as an uppercase hex string without a leading "#",
 * e.g. "FF0000" or, with alpha included, "FF0000CC".
 * @param color - The RGBA color to format.
 * @param includeAlpha - True to append the alpha channel as two hex digits.
 */
export function formatColorToHex(color: vec4, includeAlpha: boolean = false): string {
  const hex = channelToHexByte(color.r) + channelToHexByte(color.g) + channelToHexByte(color.b)
  return includeAlpha ? hex + channelToHexByte(color.a) : hex
}

/**
 * The three rounded RGB bytes of a color packed into one integer: equal
 * keys mean {@link formatColorToHex} (six-digit form) would produce equal
 * strings, so a caller can tell whether a rebuild is needed without
 * building it. Alpha is excluded, matching the six-digit form.
 * @param color - The RGBA color to key.
 */
export function hexColorKey(color: vec4): number {
  return (quantizeHexByte(color.r) << 16) | (quantizeHexByte(color.g) << 8) | quantizeHexByte(color.b)
}

function parseHexByte(text: string, index: number): number {
  return parseInt(text.substring(index, index + 2), 16) / HEX_CHANNEL_MAX
}

function parseHexShorthandDigit(text: string, index: number): number {
  const digit = parseInt(text.charAt(index), 16)
  return (digit * 16 + digit) / HEX_CHANNEL_MAX
}

/**
 * Parses a hex color string into an RGBA color. Accepts an optional leading
 * "#" and 3 (RGB), 4 (RGBA), 6 (RRGGBB), or 8 (RRGGBBAA) hex digits,
 * case-insensitive. Colors without alpha digits report `hasAlpha: false`
 * and an alpha of 1 so callers can preserve their current alpha instead.
 * @param text - The candidate hex string.
 * @returns The parsed color, or null when the text is not a valid hex color.
 */
export function parseHexColor(text: string): ParsedHexColor | null {
  if (typeof text !== "string") return null

  let hex = text.trim()
  if (hex.startsWith("#")) {
    hex = hex.substring(1)
  }
  if (!HEX_DIGIT_PATTERN.test(hex)) return null

  if (hex.length === 3 || hex.length === 4) {
    const hasAlpha = hex.length === 4
    return {
      color: new vec4(
        parseHexShorthandDigit(hex, 0),
        parseHexShorthandDigit(hex, 1),
        parseHexShorthandDigit(hex, 2),
        hasAlpha ? parseHexShorthandDigit(hex, 3) : 1
      ),
      hasAlpha
    }
  }

  if (hex.length === 6 || hex.length === 8) {
    const hasAlpha = hex.length === 8
    return {
      color: new vec4(
        parseHexByte(hex, 0),
        parseHexByte(hex, 2),
        parseHexByte(hex, 4),
        hasAlpha ? parseHexByte(hex, 6) : 1
      ),
      hasAlpha
    }
  }

  return null
}

/** A CMYK color with all channels normalized to [0, 1]. */
export type CMYKColor = {
  cyan: number
  magenta: number
  yellow: number
  black: number
}

/**
 * Converts an RGBA color to CMYK using the max-black convention: black
 * carries as much of the darkness as possible, so pure grays convert to
 * C = M = Y = 0. Alpha is not part of the CMYK model and is dropped.
 * @param color - The RGBA color to convert.
 */
export function colorToCMYK(color: vec4): CMYKColor {
  const black = 1 - Math.max(color.r, Math.max(color.g, color.b))
  if (black >= 1) {
    return {cyan: 0, magenta: 0, yellow: 0, black: 1}
  }

  const inverseBlack = 1 - black
  return {
    cyan: clampUnit((1 - color.r - black) / inverseBlack),
    magenta: clampUnit((1 - color.g - black) / inverseBlack),
    yellow: clampUnit((1 - color.b - black) / inverseBlack),
    black
  }
}

/**
 * Converts an HSVA color to CMYK through the max-black decomposition,
 * reading the chromatic part from hue/saturation rather than from the RGB
 * projection. For any value > 0 this matches
 * `colorToCMYK(hsvaToColor(hsva))` exactly — under the standard HSV
 * mapping max(rgb) = value, so K = 1 − value and C/M/Y depend only on
 * hue and saturation — but at value = 0 the chroma survives instead of
 * collapsing through {@link colorToCMYK}'s all-black branch, mirroring
 * how {@link colorToHSVA} preserves hue and saturation through black.
 * @param hsva - The HSVA color to convert.
 */
export function hsvaToCMYK(hsva: HSVAColor): CMYKColor {
  const cmyk = colorToCMYK(hsvaToColor({hue: hsva.hue, saturation: hsva.saturation, value: 1, alpha: 1}))
  cmyk.black = clampUnit(1 - hsva.value)
  return cmyk
}

/**
 * Converts a CMYK color to RGBA.
 * @param cmyk - The CMYK color to convert.
 * @param alpha - The alpha carried into the RGBA result.
 */
export function cmykToColor(cmyk: CMYKColor, alpha: number = 1): vec4 {
  const inverseBlack = 1 - clampUnit(cmyk.black)
  return new vec4(
    (1 - clampUnit(cmyk.cyan)) * inverseBlack,
    (1 - clampUnit(cmyk.magenta)) * inverseBlack,
    (1 - clampUnit(cmyk.yellow)) * inverseBlack,
    clampUnit(alpha, 1)
  )
}

/**
 * A normalized channel as the whole number it displays on its scale, e.g.
 * 0.5 at max 255 → 128. {@link formatChannelValue} is this number as a
 * string, so an unchanged quantized value means an unchanged string.
 * @param normalized - The channel value in [0, 1].
 * @param max - The channel's display maximum (255, 360, or 100).
 */
export function quantizeChannelValue(normalized: number, max: number): number {
  return Math.round(clampUnit(normalized) * max)
}

/**
 * Formats a normalized channel as a whole number on its display scale,
 * e.g. 0.5 at max 255 → "128".
 * @param normalized - The channel value in [0, 1].
 * @param max - The channel's display maximum (255, 360, or 100).
 */
export function formatChannelValue(normalized: number, max: number): string {
  return String(quantizeChannelValue(normalized, max))
}

/**
 * Parses a whole-or-decimal channel entry on its display scale.
 * @param text - The candidate entry, e.g. "128".
 * @param max - The channel's display maximum; entries clamp to [0, max].
 * @returns The normalized channel in [0, 1], or null when the text is not
 * a valid non-negative number.
 */
export function parseChannelValue(text: string, max: number): number | null {
  if (typeof text !== "string") return null

  const trimmed = text.trim()
  if (trimmed.length === 0 || !/^\d+(\.\d+)?$/.test(trimmed)) return null

  const value = Number(trimmed)
  if (!isFinite(value)) return null

  return clamp(value, 0, max) / max
}

/** Formats a normalized alpha as a whole percentage string, e.g. "100%". */
export function formatAlphaPercent(alpha: number): string {
  return quantizeAlphaPercent(alpha) + "%"
}

/**
 * An alpha as the whole percent it displays, e.g. 0.755 → 76.
 * {@link formatAlphaPercent} is this number with a "%" suffix, so an
 * unchanged quantized value means an unchanged string.
 * @param alpha - The alpha value in [0, 1].
 */
export function quantizeAlphaPercent(alpha: number): number {
  return Math.round(clampUnit(alpha, 1) * ALPHA_PERCENT_MAX)
}

/**
 * Parses an alpha percentage string, accepting an optional trailing "%".
 * @param text - The candidate percentage string, e.g. "75" or "75%".
 * @returns The normalized alpha in [0, 1], or null when the text is not a
 * valid percentage.
 */
export function parseAlphaPercent(text: string): number | null {
  if (typeof text !== "string") return null

  let percentText = text.trim()
  if (percentText.endsWith("%")) {
    percentText = percentText.substring(0, percentText.length - 1).trim()
  }
  if (percentText.length === 0 || !/^\d+(\.\d+)?$/.test(percentText)) return null

  const percent = Number(percentText)
  if (!isFinite(percent)) return null

  return clamp(percent, 0, ALPHA_PERCENT_MAX) / ALPHA_PERCENT_MAX
}

/**
 * A color with one channel of the given format replaced.
 * HSB edits write the HSVA state directly (no RGB round trip, so grays
 * keep their hue); RGB and CMYK edits convert back through
 * {@link colorToHSVA}, preserving degenerate channels from the previous
 * state.
 * @param hsva - The current canonical color.
 * @param format - The format whose channel semantics apply.
 * @param index - The channel index within the format.
 * @param normalized - The new channel value in [0, 1].
 */
export function hsvaWithChannel(
  hsva: HSVAColor,
  format: ColorPickerFormat,
  index: number,
  normalized: number
): HSVAColor {
  const next = cloneHSVA(hsva)

  if (format === ColorPickerFormat.HSB) {
    if (index === 0) next.hue = normalized * 360
    else if (index === 1) next.saturation = normalized
    else next.value = normalized
    return next
  }

  if (format === ColorPickerFormat.RGB) {
    const rgba = hsvaToColor(hsva)
    if (index === 0) rgba.r = normalized
    else if (index === 1) rgba.g = normalized
    else rgba.b = normalized
    return colorToHSVA(rgba, next)
  }

  if (format === ColorPickerFormat.CMYK) {
    // Projected from canonical HSVA, not the RGB round trip: at black the
    // RGB projection zeroes C/M/Y (colorToCMYK's all-black branch), so
    // K=100 -> K=0 would land on white instead of restoring the chroma
    // that hue/saturation still carry.
    const cmyk = hsvaToCMYK(hsva)
    if (index === 0) cmyk.cyan = normalized
    else if (index === 1) cmyk.magenta = normalized
    else if (index === 2) cmyk.yellow = normalized
    else cmyk.black = normalized
    return colorToHSVA(cmykToColor(cmyk, hsva.alpha), next)
  }

  return next
}

/**
 * The normalized [0, 1] values every channel field displays for a color
 * under the given format, in {@link FORMAT_CHANNEL_SPECS} order. One
 * projection serves the whole row: on the CMYK path a projection is a vec4
 * and two objects, and the picker refreshes all of its fields on every
 * frame of a drag. CMYK reads back through the max-black normalization, so
 * an entry like C=M=Y may re-render as its normalized equivalent — the
 * same color, expressed with the largest possible K.
 * @param hsva - The current canonical color.
 * @param format - The format whose channel semantics apply.
 * @param rgba - `hsvaToColor(hsva)`, when the caller has already derived
 * it; saves the RGB path its own projection. Must be that projection —
 * it is trusted, not checked.
 */
export function channelNormalizedValues(hsva: HSVAColor, format: ColorPickerFormat, rgba?: vec4): number[] {
  if (format === ColorPickerFormat.HSB) {
    return [hsva.hue / 360, hsva.saturation, hsva.value]
  }

  if (format === ColorPickerFormat.RGB) {
    const color = rgba ?? hsvaToColor(hsva)
    return [color.r, color.g, color.b]
  }

  if (format === ColorPickerFormat.CMYK) {
    // Same HSVA-based projection as hsvaWithChannel, so the displayed
    // fields and the edit basis can't disagree — including at black,
    // where C/M/Y keep reading the preserved chroma.
    const cmyk = hsvaToCMYK(hsva)
    return [cmyk.cyan, cmyk.magenta, cmyk.yellow, cmyk.black]
  }

  return []
}

/**
 * Maps a hue in degrees onto a shortened hue-slider span. Hues in the
 * unreachable tail past the span clamp the KNOB to the track end while
 * the true hue lives on in the color state — this pair is deliberately
 * lossy upward, so a knob-position echo must never be written back as a
 * hue unless the user actually moved the knob (see ColorPicker's
 * layout-pass guard).
 * @param hue - The hue in degrees.
 * @param rangeDegrees - The span mapped across the slider; must be > 0.
 */
export function hueToSliderValue(hue: number, rangeDegrees: number): number {
  return Math.min(hue / rangeDegrees, 1)
}

/**
 * The inverse of {@link hueToSliderValue} over the reachable span: a knob
 * value t selects hue `t * rangeDegrees`.
 * @param value - The slider value in [0, 1].
 * @param rangeDegrees - The span mapped across the slider.
 */
export function sliderValueToHue(value: number, rangeDegrees: number): number {
  return value * rangeDegrees
}

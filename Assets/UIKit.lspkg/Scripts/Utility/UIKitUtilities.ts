import {Element} from "../Components/Element"
import type {RoundedRectangle} from "../Visuals/RoundedRectangle/RoundedRectangle"
import type {GradientParameters} from "../Visuals/RoundedRectangle/RoundedRectangleTypes"

const NUMBER_PICKER_CUSTOM_FIELD_TYPE = "custom"
const MIN_CM_TRACK_SIZE = 0.001
export const NUMBER_PICKER_ROW_HEIGHT_EPSILON = 0.0025

/**
 * Represents a 3D axis-aligned bounding box with min/max corners, size, and center.
 */
export type Bounds3D = {
  /** Minimum corner of the bounding box */
  min: vec3
  /** Maximum corner of the bounding box */
  max: vec3
  /** Size of the bounding box (max - min) */
  size: vec3
  /** Center point of the bounding box */
  center: vec3
}

/** Public surface needed to commit the final value of a slider drag. */
export interface SliderDragValueTarget {
  readonly currentValue: number
  readonly knobValue: number
  updateCurrentValue(value: number, shouldAnimate?: boolean): void
}

/**
 * Commits a changed drag value through the target's virtual update path.
 *
 * @returns `true` when a changed value was committed.
 */
export function commitSliderDragValue(target: SliderDragValueTarget): boolean {
  if (target.knobValue === target.currentValue) {
    return false
  }
  target.updateCurrentValue(target.knobValue, false)
  return true
}

export type NumberPickerFieldData =
  | {
      fieldType: "range"
      minRange: number
      maxRange: number
      step: number
      wrapAround?: boolean
      defaultNumber?: number
      minNumberDigits?: number
    }
  | {fieldType: "custom"; customValues?: string[]; wrapAround?: boolean; defaultValue?: string}

export type NumberPickerFieldDataOperation =
  | {
      type: "append"
      data: NumberPickerFieldData
    }
  | {
      type: "replace"
      fieldIndex: number
      data: NumberPickerFieldData
    }
  | {
      type: "remove"
      fieldIndex: number
    }

export function isValidNumberPickerFieldIndex(fieldIndex: number, fieldCount: number): boolean {
  return Number.isInteger(fieldIndex) && fieldIndex >= 0 && fieldIndex < fieldCount
}

export function applyNumberPickerFieldDataOperations(
  fieldData: NumberPickerFieldData[],
  operations: NumberPickerFieldDataOperation[]
): NumberPickerFieldData[] {
  const nextFieldData = fieldData.slice()
  for (const operation of operations) {
    if (operation.type === "append") {
      nextFieldData.push(operation.data)
    } else if (operation.type === "replace") {
      if (isValidNumberPickerFieldIndex(operation.fieldIndex, nextFieldData.length)) {
        nextFieldData[operation.fieldIndex] = operation.data
      }
    } else if (isValidNumberPickerFieldIndex(operation.fieldIndex, nextFieldData.length)) {
      nextFieldData.splice(operation.fieldIndex, 1)
    }
  }
  return nextFieldData
}

function getRangeMinNumberDigits(minNumberDigits: number | undefined): number {
  if (minNumberDigits === undefined) {
    return 1
  }

  if (!Number.isFinite(minNumberDigits)) {
    return 0
  }

  return Math.max(0, Math.floor(minNumberDigits))
}

function formatRangeValue(value: number, minNumberDigits: number): string {
  if (minNumberDigits <= 0) {
    return value.toString()
  }

  const sign = value < 0 ? "-" : ""
  const absoluteValue = Math.abs(value).toString()
  return `${sign}${absoluteValue.padStart(minNumberDigits, "0")}`
}

export function getNumberPickerFieldOptionValues(field: unknown): string[] {
  const fieldData = field as NumberPickerFieldData
  if (fieldData.fieldType === NUMBER_PICKER_CUSTOM_FIELD_TYPE) {
    return fieldData.customValues ?? []
  }

  if (fieldData.maxRange < fieldData.minRange) {
    return []
  }

  const effectiveStep = Math.max(1, fieldData.step)
  const minNumberDigits = getRangeMinNumberDigits(fieldData.minNumberDigits)
  const values: string[] = []
  for (let value = fieldData.minRange; value <= fieldData.maxRange; value += effectiveStep) {
    values.push(formatRangeValue(value, minNumberDigits))
  }
  return values
}

export function getNumberPickerFieldInitialIndex(field: unknown, optionValues: string[]): number {
  if (optionValues.length === 0) {
    return 0
  }

  const fieldData = field as NumberPickerFieldData
  if (fieldData.fieldType === NUMBER_PICKER_CUSTOM_FIELD_TYPE) {
    const defaultValue = fieldData.defaultValue ?? ""
    const defaultValueIndex = optionValues.indexOf(defaultValue)
    return defaultValueIndex >= 0 ? defaultValueIndex : 0
  }

  const defaultNumber = fieldData.defaultNumber ?? 0
  if (!Number.isFinite(defaultNumber)) {
    return 0
  }

  let nearestOptionIndex = 0
  let nearestOptionDistance = Math.abs(defaultNumber - Number(optionValues[0]))
  for (let i = 1; i < optionValues.length; i++) {
    const optionDistance = Math.abs(defaultNumber - Number(optionValues[i]))
    if (optionDistance < nearestOptionDistance) {
      nearestOptionIndex = i
      nearestOptionDistance = optionDistance
    }
  }

  return nearestOptionIndex
}

export function shouldWrapNumberPickerField(field: unknown, optionValues: string[]): boolean {
  const fieldData = field as NumberPickerFieldData
  return fieldData.wrapAround === true && optionValues.length > 1
}

export function getNumberPickerVisibleRowCount(
  windowHeight: number,
  rowHeight: number,
  fallbackRowCount: number = 1
): number {
  if (!Number.isFinite(windowHeight) || !Number.isFinite(rowHeight) || rowHeight <= NUMBER_PICKER_ROW_HEIGHT_EPSILON) {
    return Math.max(1, Number.isFinite(fallbackRowCount) ? Math.ceil(fallbackRowCount) : 1)
  }

  return Math.max(1, Math.ceil(Math.max(0, windowHeight) / rowHeight))
}

export function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor
}

/**
 * Converts a numeric GridLayout track size to a centimeter unit string, clamped to a tiny positive size.
 *
 * @param value - The value in centimeters.
 * @returns The clamped centimeter string.
 */
export function toGridTrackCmString(value: number): string {
  return Math.max(MIN_CM_TRACK_SIZE, value).toString() + "cm"
}

/**
 * Normalizes optional text-like values for UI setters.
 *
 * @param value - The value to normalize.
 * @returns Undefined when no value was provided, otherwise a string.
 */
export function normalizeTextValue(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (value === null) return ""
  return typeof value === "string" ? value : String(value)
}

/**
 * Normalizes optional boolean values for UI setters.
 *
 * @param value - The value to normalize.
 * @returns Undefined when no value was provided, otherwise true only for literal true.
 */
export function normalizeBooleanValue(value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  return value === true
}

/**
 * Normalizes optional function handlers for button-like UI setters.
 *
 * @param value - The handler candidate.
 * @returns The handler when the value is a function, otherwise null.
 */
export function normalizeButtonHandler<T extends (...args: any[]) => unknown>(value: unknown): T | null {
  return typeof value === "function" ? (value as T) : null
}

/**
 * Default silence-until-termination timeout (ms) for ASR voice input. Deliberately
 * higher than the ASR module's documented 750ms default for a less clipped dictation
 * feel. Backs the VoiceInputButton inspector default, the VoiceInputProvider
 * `acquireListening()` default, and the fallback in `normalizeSilenceUntilTerminationMs`.
 */
export const DEFAULT_SILENCE_UNTIL_TERMINATION_MS = 1500

/**
 * Clamps a requested ASR silence-until-termination timeout to a usable value. Any
 * non-finite or non-positive input — including the 0 that a blank inspector field
 * yields — falls back to `DEFAULT_SILENCE_UNTIL_TERMINATION_MS`: a 0ms timeout would
 * terminate on the first silent frame, so it is treated as "unset".
 * @param value - The requested timeout in milliseconds.
 * @returns A finite, strictly-positive timeout in milliseconds.
 */
export function normalizeSilenceUntilTerminationMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SILENCE_UNTIL_TERMINATION_MS
}

/**
 * Sentinel AsrModule accepts as the transcription language: the service detects the
 * spoken language instead of being told it. Used only when the device reports no
 * language; otherwise the device language is the primary transcription language.
 */
export const ASR_LANGUAGE_AUTO = "auto"

/** Languages handed to AsrModule for one listening session, as BCP-47 tags (`"en"`, `"pt-BR"`). */
export type VoiceInputLanguages = {
  /** Language speech is primarily expected in: the device language. */
  language: string
  /**
   * Additional languages speech may switch to alongside the primary one — e.g. the
   * languages typical of a place the user is navigating to. Listing them nudges the
   * ASR model toward those languages in multi-language settings.
   */
  secondaryLanguages: string[]
}

/**
 * Trims a language tag, mapping non-string or blank input to `""` ("unset").
 * @param value - The raw tag, typically from an inspector field or a caller.
 * @returns The trimmed tag, or `""` when there is none.
 */
export function normalizeLanguageTag(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/**
 * Cleans a list of BCP-47 language tags: trims each entry, drops blanks and
 * non-strings, drops `ASR_LANGUAGE_AUTO` (a detection sentinel, not a language), and
 * removes case-insensitive duplicates, keeping the first spelling seen. Always returns
 * a fresh array.
 * @param values - The raw tags, typically from an inspector list or a caller.
 * @returns The cleaned tags in their original order.
 */
export function normalizeLanguageTags(values: readonly unknown[] | null | undefined): string[] {
  const seen = new Set<string>()
  const tags: string[] = []
  for (const value of values ?? []) {
    const tag = normalizeLanguageTag(value)
    const key = tag.toLowerCase()
    if (tag === "" || key === ASR_LANGUAGE_AUTO || seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
  }
  return tags
}

/**
 * Resolves the languages for an ASR listening session. The primary language is the
 * device language, falling back to `ASR_LANGUAGE_AUTO` when the device reports none.
 * Secondary languages come from the session when it lists any, otherwise from the
 * provider-wide defaults; the primary is then removed from them so a language is never
 * listed twice.
 * @param deviceLanguage - The device language, from `global.localizationSystem.getLanguage()`.
 * @param requestedSecondaryLanguages - Per-session secondary languages, e.g. a VoiceInputButton's input.
 * @param defaultSecondaryLanguages - Provider-wide fallbacks, e.g. a lens's destination languages.
 * @returns Fresh, normalized languages ready to assign to the transcription options.
 */
export function resolveVoiceInputLanguages(
  deviceLanguage: string,
  requestedSecondaryLanguages: readonly unknown[] | null | undefined,
  defaultSecondaryLanguages: readonly unknown[] | null | undefined = []
): VoiceInputLanguages {
  const language = normalizeLanguageTag(deviceLanguage) || ASR_LANGUAGE_AUTO

  const requested = normalizeLanguageTags(requestedSecondaryLanguages)
  const candidates = requested.length > 0 ? requested : normalizeLanguageTags(defaultSecondaryLanguages)
  const primaryKey = language.toLowerCase()
  const secondaryLanguages = candidates.filter((tag) => tag.toLowerCase() !== primaryKey)

  return {language, secondaryLanguages}
}

/**
 * The device language for ASR, or `""` when it cannot be read.
 * `global.localizationSystem` can be entirely absent in the editor before a
 * LocalizationsAsset is wired up and in unit tests, so it is checked first (`localizeOr`
 * below guards the same way). The lookup is also wrapped because VoiceInputProvider calls this
 * inside the voice button's interaction callback, where an uncaught throw would abort the
 * lens. `""` resolves to `ASR_LANGUAGE_AUTO` in `resolveVoiceInputLanguages`.
 * @returns The device language tag, or `""` when unavailable.
 */
export function getDeviceLanguage(): string {
  const localizationSystem = global.localizationSystem
  if (!localizationSystem) {
    return ""
  }
  try {
    return localizationSystem.getLanguage()
  } catch {
    return ""
  }
}

/**
 * Resolves a string-table key, falling back on anything that isn't a clean hit.
 * `global.localizationSystem` can be entirely absent in the editor
 * before a LocalizationsAsset is wired up and in unit tests, and `localize()` fails soft on
 * a miss by returning `""` or echoing the key back; each of those, and a throwing lookup,
 * yields `fallback`. The caller must still anchor its table with a literal-path
 * `requireAsset()`, or every key misses at once.
 * @param key - The `@namespace:component:name` string-table key.
 * @param fallback - The text shown when the key does not resolve, normally the English source.
 * @returns The translated text, or `fallback` on any miss.
 */
export function localizeOr(key: string, fallback: string): string {
  const localizationSystem = global.localizationSystem
  if (!localizationSystem) {
    return fallback
  }
  let resolved: string | null = null
  try {
    resolved = localizationSystem.localize(key)
  } catch {
    return fallback
  }
  if (!resolved || resolved === key) {
    return fallback
  }
  return resolved
}

// ═══════════════════════════════════════════════════════════════════════════
// NUMERIC SANITIZERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Smallest magnitude the strictly-positive sanitizers emit. Keeps degenerate
 * inputs (0, NaN with a 0 fallback) from producing zero-size geometry or
 * divide-by-zero factors downstream.
 */
export const MIN_POSITIVE_MAGNITUDE = 0.001

/**
 * Replaces a non-finite value with a fallback. The base sanitizer for
 * inspector inputs and public setters, where NaN/Infinity must never reach
 * layout or transform math.
 *
 * @param value - The candidate value.
 * @param fallback - Returned when `value` is NaN or infinite.
 * @returns `value` when finite, otherwise `fallback`.
 */
export function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

/**
 * Sanitizes to a strictly-positive value, flooring at
 * {@link MIN_POSITIVE_MAGNITUDE}. Use for sizes, scales, and durations where
 * zero is degenerate.
 *
 * @param value - The candidate value.
 * @param fallback - Used when `value` is non-finite; also floored.
 * @returns A finite value of at least {@link MIN_POSITIVE_MAGNITUDE}.
 */
export function positiveFinite(value: number, fallback: number): number {
  return Math.max(MIN_POSITIVE_MAGNITUDE, finiteOr(value, fallback))
}

/**
 * Sanitizes to a non-negative value, allowing zero. Use for distances and
 * extents where zero is meaningful but negatives are not.
 *
 * @param value - The candidate value.
 * @param fallback - Used when `value` is non-finite; also clamped to zero.
 * @returns A finite value of at least zero.
 */
export function nonNegativeFinite(value: number, fallback: number = 0): number {
  return Math.max(0, finiteOr(value, fallback))
}

/**
 * Sanitizes to a strictly-positive magnitude, discarding sign. Use where a
 * signed authored value expresses a distance.
 *
 * @param value - The candidate value.
 * @param fallback - Used when `value` is non-finite.
 * @returns `|value|`, at least {@link MIN_POSITIVE_MAGNITUDE}.
 */
export function positiveMagnitude(value: number, fallback: number): number {
  return Math.max(MIN_POSITIVE_MAGNITUDE, Math.abs(finiteOr(value, fallback)))
}

/**
 * Copies a vec2, replacing non-finite components from a fallback. Also
 * defends against a caller retaining a reference to the passed vector.
 *
 * @param value - The candidate vector.
 * @param fallback - Supplies replacements per component.
 * @returns A new vec2 with finite components.
 */
export function sanitizedVec2(value: vec2, fallback: vec2): vec2 {
  return new vec2(finiteOr(value.x, fallback.x), finiteOr(value.y, fallback.y))
}

/**
 * Copies a vec3, replacing non-finite components from a fallback. Also
 * defends against a caller retaining a reference to the passed vector.
 *
 * @param value - The candidate vector.
 * @param fallback - Supplies replacements per component.
 * @returns A new vec3 with finite components.
 */
export function sanitizedVec3(value: vec3, fallback: vec3): vec3 {
  return new vec3(finiteOr(value.x, fallback.x), finiteOr(value.y, fallback.y), finiteOr(value.z, fallback.z))
}

/**
 * Retrieves the first `Element` instance found among the `ScriptComponent`s attached to the given `SceneObject`.
 *
 * @param root - The root `SceneObject` to search for an `Element` component.
 * @returns The first `Element` found, or `null` if none is present.
 */
export function getElement(root: SceneObject): Element | null {
  if (root === null) {
    return null
  }
  const components = root.getComponents("ScriptComponent")
  for (let i = 0; i < components.length; i++) {
    const component = components[i]
    if (component instanceof Element) {
      return component
    }
  }
  return null
}

// ═══════════════════════════════════════════════════════════════════════════
// VISUAL HELPERS
//
// Keep visual imports type-only here: theme palettes depend on this module.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The z-offset layering of a panel behind its controls only resolves
 * through depth testing, so pin both flags on instead of inheriting the
 * values serialized on the shared material asset.
 * Run from onInitialized handlers: initialization assigns an
 * instance-cloned material, so the writes affect only this visual's pass.
 */
export function enableDepthOcclusion(shape: RoundedRectangle): void {
  const mainPass = shape.renderMeshVisual.mainPass
  mainPass.depthTest = true
  mainPass.depthWrite = true
}

/**
 * Fraction of a track each end gives up to a knob whose center travels
 * inset by half the knob span ("knob overflow" disabled). A gradient laid
 * out across the full track sits this far out of step with the knob's
 * value, so its stops must be remapped into `[inset, 1 - inset]` — the
 * knob otherwise renders one color while physically sitting over another
 * (the ColorSlider/ColorArea desync bug). Capped below 0.5 so a knob as
 * wide as its track still leaves a non-degenerate ramp instead of
 * collapsing every stop onto one point. Returns 0 for a non-positive
 * track span.
 * @param knobSpan - The knob's extent along the travel axis.
 * @param trackSpan - The track's extent along the same axis.
 */
export function knobTravelInsetFraction(knobSpan: number, trackSpan: number): number {
  if (trackSpan <= 0) {
    return 0
  }
  return Math.min((knobSpan * 0.5) / trackSpan, 0.499)
}

/**
 * Creates a deep clone of a given `GradientParameters` object.
 *
 * This function copies all defined properties from the input gradient,
 * including shallow copies of the `stop0` through `stop6` properties (if present),
 * ensuring that the returned object is a new instance with the same values.
 *
 * @param gradient - The `GradientParameters` object to clone.
 * @returns A new `GradientParameters` object with the same properties as the input.
 */
export function gradientParameterClone(gradient: GradientParameters): GradientParameters {
  const newGradient: GradientParameters = {}
  if (gradient.type !== undefined) newGradient.type = gradient.type
  if (gradient.start !== undefined) newGradient.start = gradient.start
  if (gradient.end !== undefined) newGradient.end = gradient.end
  if (gradient.enabled !== undefined) newGradient.enabled = gradient.enabled
  if (gradient.stop0 !== undefined) newGradient.stop0 = {...gradient.stop0}
  if (gradient.stop1 !== undefined) newGradient.stop1 = {...gradient.stop1}
  if (gradient.stop2 !== undefined) newGradient.stop2 = {...gradient.stop2}
  if (gradient.stop3 !== undefined) newGradient.stop3 = {...gradient.stop3}
  if (gradient.stop4 !== undefined) newGradient.stop4 = {...gradient.stop4}
  if (gradient.stop5 !== undefined) newGradient.stop5 = {...gradient.stop5}
  if (gradient.stop6 !== undefined) newGradient.stop6 = {...gradient.stop6}

  return newGradient
}

/**
 * Remaps a gradient's stop positions into a knob's travel range so the
 * color under the knob is the color its value selects: each stop percent p
 * becomes `inset + p * (1 - 2 * inset)` — exactly the knob-center position
 * for value p, so the mapping is precise, not approximate. Positions
 * outside the remapped range clamp to the end colors, giving both
 * shoulders for free. Returns the input untouched when the inset is not
 * positive; otherwise a shallow clone via {@link gradientParameterClone}
 * with only the copied stops' percents rewritten (stop colors stay shared
 * with the input).
 * @param gradient - The gradient laid out over [0, 1].
 * @param insetFraction - The travel inset, typically
 * {@link knobTravelInsetFraction}.
 */
export function insetGradientStops(gradient: GradientParameters, insetFraction: number): GradientParameters {
  if (insetFraction <= 0) {
    return gradient
  }

  const scale = 1 - insetFraction * 2
  const insetGradient = gradientParameterClone(gradient)
  const stops = [
    insetGradient.stop0,
    insetGradient.stop1,
    insetGradient.stop2,
    insetGradient.stop3,
    insetGradient.stop4,
    insetGradient.stop5,
    insetGradient.stop6
  ]
  for (const stop of stops) {
    if (stop?.percent !== undefined) {
      stop.percent = insetFraction + stop.percent * scale
    }
  }
  return insetGradient
}

/**
 * Formats a numeric centimeter value for layout template strings.
 * @param value - The centimeter value.
 * @param minValue - Minimum emitted value, used to avoid degenerate tracks.
 * @param precision - Number of decimal places.
 * @returns A string like `"1.250cm"`.
 */
export function toCmString(value: number, minValue: number = 0.001, precision: number = 3): string {
  return Math.max(minValue, value).toFixed(precision) + "cm"
}

/**
 * Creates a vec4 color from 0-255 RGB channels and a normalized alpha.
 * @param red - Red channel from 0 to 255.
 * @param green - Green channel from 0 to 255.
 * @param blue - Blue channel from 0 to 255.
 * @param alpha - Alpha channel from 0 to 1.
 * @returns The normalized color.
 */
export function colorFrom255(red: number, green: number, blue: number, alpha: number = 1): vec4 {
  return new vec4(red / 255, green / 255, blue / 255, alpha)
}

/**
 * Formats arbitrary values (including Lens vec2/vec3/vec4, arrays and nested
 * objects) into a readable multi-line string. Debug helper used by component
 * `printConfig()` methods.
 */
export function formatLensValue(value: any, indent: number = 0): string {
  const spaces = "  ".repeat(indent)

  if (value === null || value === undefined) {
    return "null"
  }

  const formatNumber = (num: number): string => {
    if (Number.isInteger(num)) return num.toString()
    return parseFloat(num.toFixed(3)).toString()
  }

  // Handle vec2
  if (value && typeof value === "object" && "x" in value && "y" in value && !("z" in value)) {
    return `vec2(${formatNumber(value.x)}, ${formatNumber(value.y)})`
  }

  // Handle vec3
  if (value && typeof value === "object" && "x" in value && "y" in value && "z" in value && !("w" in value)) {
    return `vec3(${formatNumber(value.x)}, ${formatNumber(value.y)}, ${formatNumber(value.z)})`
  }

  // Handle vec4
  if (value && typeof value === "object" && "x" in value && "y" in value && "z" in value && "w" in value) {
    return `vec4(${formatNumber(value.x)}, ${formatNumber(value.y)}, ${formatNumber(value.z)}, ${formatNumber(value.w)})`
  }

  // Handle arrays
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    const items = value.map((item) => formatLensValue(item, 0)).join(", ")
    return `[${items}]`
  }

  // Handle objects
  if (typeof value === "object") {
    const entries = Object.entries(value)
    if (entries.length === 0) return "{}"

    const formatted = entries
      .map(([key, val]) => {
        return `${spaces}  ${key}: ${formatLensValue(val, indent + 1)}`
      })
      .join(",\n")

    return `{\n${formatted}\n${spaces}}`
  }

  // Handle primitives
  if (typeof value === "string") {
    return `"${value}"`
  }

  if (typeof value === "number") {
    return formatNumber(value)
  }

  return String(value)
}

/**
 * Converts an HSV color to RGB.
 * This function takes a color in HSV format (Hue, Saturation, Value)
 * and converts it to RGB format (Red, Green, Blue).
 * The function can accept either a vec4 representing the HSV color or a number representing the hue.
 * @param colHSV - A vec4 representing the HSV color (hue, saturation, value, alpha) or a number representing the hue.
 * If a number is provided, saturation, value, and alpha must also be provided.
 * @param saturation - The saturation component (0 to 1).
 * @param value - The value (brightness) component (0 to 1).
 * @param alpha - The alpha (opacity) component (0 to 1).
 * @returns A vec4 representing the RGB color (red, green, blue, alpha).
 */
export function HSVtoRGB(colHSV: vec4 | number, saturation?: number, value?: number, alpha?: number): vec4 {
  let h, s, v
  if (typeof colHSV === "object") {
    h = colHSV.x
    s = colHSV.y
    v = colHSV.z
  } else {
    if (saturation === undefined || value === undefined || alpha === undefined) {
      throw new Error("If colHSV is a number, saturation, value, and alpha must be provided.")
    }
    h = colHSV
    s = saturation
    v = value
  }
  h = h / 360
  let r: number, g: number, b: number

  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)

  switch (i % 6) {
    case 0:
      r = v
      g = t
      b = p
      break
    case 1:
      r = q
      g = v
      b = p
      break
    case 2:
      r = p
      g = v
      b = t
      break
    case 3:
      r = p
      g = q
      b = v
      break
    case 4:
      r = t
      g = p
      b = v
      break
    case 5:
      r = v
      g = p
      b = q
      break
    default:
      throw new Error("Invalid input value for HSVtoRGB function.")
  }

  if (typeof colHSV === "object") {
    return new vec4(r, g, b, colHSV.a)
  } else {
    return new vec4(r, g, b, alpha)
  }
}

/**
 * Converts an RGB color to HSV.
 * Accepts either a vec4 (r, g, b, a) or a number for red with green, blue, alpha provided.
 * Returns hue in degrees [0, 360), saturation and value in [0, 1], and preserves alpha.
 * Round-trips with HSVtoRGB: HSVtoRGB(RGBtoHSV(rgb)) ≈ rgb.
 * @param colRGB - vec4 (r,g,b,a) or number for red
 * @param green - green component (0 to 1) when colRGB is a number
 * @param blue - blue component (0 to 1) when colRGB is a number
 * @param alpha - alpha component (0 to 1) when colRGB is a number
 * @returns vec4(h, s, v, a) with hue in degrees
 */
export function RGBtoHSV(colRGB: vec4 | number, green?: number, blue?: number, alpha?: number): vec4 {
  let r: number, g: number, b: number
  if (typeof colRGB === "object") {
    r = colRGB.x
    g = colRGB.y
    b = colRGB.z
  } else {
    if (green === undefined || blue === undefined || alpha === undefined) {
      throw new Error("If colRGB is a number, green, blue, and alpha must be provided.")
    }
    r = colRGB
    g = green
    b = blue
  }

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min

  const v = max
  const s = max === 0 ? 0 : delta / max

  let h = 0
  if (delta !== 0) {
    if (max === r) {
      h = (g - b) / delta + (g < b ? 6 : 0)
    } else if (max === g) {
      h = (b - r) / delta + 2
    } else {
      h = (r - g) / delta + 4
    }
    h *= 60
    if (h >= 360) {
      h -= 360
    }
  }

  if (typeof colRGB === "object") {
    return new vec4(h, s, v, colRGB.a)
  } else {
    return new vec4(h, s, v, alpha)
  }
}

/**
 * Lerps between two RGB colors in HSV space (shortest hue path), return RGB.
 * @param fromColor - The starting color.
 * @param toColor - The ending color.
 * @param t - The interpolation factor (0 to 1).
 * @returns The interpolated color.
 */
export function colorLerp(fromColor: vec4, toColor: vec4, t: number): vec4 {
  const clampT = Math.max(0, Math.min(1, t))
  // Equal-endpoint fast-path: skip the HSV roundtrip when start and end colors match.
  if (isEqual(fromColor, toColor)) {
    return new vec4(fromColor.x, fromColor.y, fromColor.z, fromColor.a)
  }
  // Lerp colors in HSV space (shortest hue path), return RGB
  const fromHSV = RGBtoHSV(fromColor)
  const toHSV = RGBtoHSV(toColor)

  let hFrom = fromHSV.x
  let hTo = toHSV.x

  // If either color is achromatic, borrow the other's hue to avoid jumps
  if (fromHSV.y === 0) {
    hFrom = hTo
  }
  if (toHSV.y === 0) {
    hTo = hFrom
  }

  const deltaH = ((hTo - hFrom + 540) % 360) - 180
  const h = (hFrom + clampT * deltaH + 360) % 360
  const s = fromHSV.y + (toHSV.y - fromHSV.y) * clampT
  const v = fromHSV.z + (toHSV.z - fromHSV.z) * clampT
  const a = fromColor.a + (toColor.a - fromColor.a) * clampT

  const lerpedRGB = HSVtoRGB(new vec4(h, s, v, a))
  return lerpedRGB
}

/**
 * Computes normalized hue distance [0,1] between two RGB colors (vec4).
 * - Converts to HSV via RGBtoHSV
 * - If both colors are achromatic (s == 0), hue distance is 0
 * - Uses shortest circular hue distance on a 0..360 ring, then normalizes by 180
 */
export function colorDistance(rgbA: vec4, rgbB: vec4): number {
  const hsvA = RGBtoHSV(rgbA)
  const hsvB = RGBtoHSV(rgbB)
  const sA = hsvA.y
  const sB = hsvB.y
  if (sA === 0 && sB === 0) {
    return 0
  }
  const hA = hsvA.x
  const hB = hsvB.x
  const delta = Math.abs(((hB - hA + 540) % 360) - 180)
  const normalized = Math.max(0, Math.min(1, delta / 180))
  return normalized
}

/**
 * Performs a deep equality check between two values of the same type.
 * Handles primitives, objects, arrays, vec2, vec3, vec4, and other complex types.
 *
 * @param a - The first value to compare.
 * @param b - The second value to compare.
 * @returns `true` if the values are deeply equal, `false` otherwise.
 */
export function isEqual<T>(a: T, b: T): boolean {
  // Handle strict equality (primitives, same reference)
  if (a === b) {
    return true
  }

  // Handle null/undefined cases
  if (a == null || b == null) {
    return a === b
  }

  // Handle different types
  if (typeof a !== typeof b) {
    return false
  }

  // Handle vec2, vec3, vec4 types (Lens Studio specific)
  if (isVectorType(a) && isVectorType(b)) {
    return compareVectors(a as any, b as any)
  }

  // Handle arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false
    }
    for (let i = 0; i < a.length; i++) {
      if (!isEqual(a[i], b[i])) {
        return false
      }
    }
    return true
  }

  // Handle objects
  if (typeof a === "object" && typeof b === "object") {
    const keysA = Object.keys(a as any)
    const keysB = Object.keys(b as any)

    if (keysA.length !== keysB.length) {
      return false
    }

    for (const key of keysA) {
      if (!keysB.includes(key)) {
        return false
      }
      if (!isEqual((a as any)[key], (b as any)[key])) {
        return false
      }
    }
    return true
  }

  return false
}

/**
 * Helper function to check if a value is a Lens Studio vector type (vec2, vec3, vec4).
 *
 * @param value - The value to check.
 * @returns `true` if the value is a vector type, `false` otherwise.
 */
function isVectorType(value: any): boolean {
  return value instanceof vec2 || value instanceof vec3 || value instanceof vec4
}

/**
 * Helper function to compare vector types (vec2, vec3, vec4).
 *
 * @param a - First vector.
 * @param b - Second vector.
 * @returns `true` if vectors are equal, `false` otherwise.
 */
function compareVectors(a: any, b: any): boolean {
  // Check x, y components (present in vec2, vec3, vec4)
  if (a.x !== b.x || a.y !== b.y) {
    return false
  }

  // Check z component (present in vec3, vec4)
  if ((a.z !== undefined || b.z !== undefined) && a.z !== b.z) {
    return false
  }

  // Check w component (present in vec4)
  if ((a.w !== undefined || b.w !== undefined) && a.w !== b.w) {
    return false
  }

  // Check a component (alpha in vec4 colors)
  if ((a.a !== undefined || b.a !== undefined) && a.a !== b.a) {
    return false
  }

  return true
}

/**
 * Shallow equality check for better performance when deep equality is not needed.
 * Only compares the first level of properties.
 *
 * @param a - The first value to compare.
 * @param b - The second value to compare.
 * @returns `true` if the values are shallowly equal, `false` otherwise.
 */
export function isShallowEqual<T>(a: T, b: T): boolean {
  if (a === b) {
    return true
  }

  if (a == null || b == null) {
    return a === b
  }

  if (typeof a !== typeof b) {
    return false
  }

  if (typeof a === "object") {
    const keysA = Object.keys(a as any)
    const keysB = Object.keys(b as any)

    if (keysA.length !== keysB.length) {
      return false
    }

    for (const key of keysA) {
      if (!keysB.includes(key) || (a as any)[key] !== (b as any)[key]) {
        return false
      }
    }
    return true
  }

  return false
}

export const EPSILON = 0.0001

/**
 * Checks if two vec3 values are approximately equal within EPSILON tolerance.
 * Use this instead of vec3.equal() for floating point comparisons.
 * @param a - First vector.
 * @param b - Second vector.
 * @param epsilon - Tolerance for comparison (defaults to EPSILON).
 * @returns True if the vectors are approximately equal.
 */
export function vec3ApproximatelyEqual(a: vec3, b: vec3, epsilon: number = EPSILON): boolean {
  return a.distance(b) < epsilon
}

/**
 * Returns a vec3 with the maximum of each component from two vectors.
 * @param a - First vector.
 * @param b - Second vector.
 * @returns A new vec3 with max(a.x, b.x), max(a.y, b.y), max(a.z, b.z).
 */
export function maxVec3Components(a: vec3, b: vec3): vec3 {
  return new vec3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z))
}

/**
 * Returns a vec3 with the minimum of each component from two vectors.
 * @param a - First vector.
 * @param b - Second vector.
 * @returns A new vec3 with min(a.x, b.x), min(a.y, b.y), min(a.z, b.z).
 */
export function minVec3Components(a: vec3, b: vec3): vec3 {
  return new vec3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z))
}

/**
 * Computes the scale ratio needed to transform from currentSize to targetSize.
 * Returns 1 for any axis where currentSize is 0 to avoid division by zero.
 * @param currentSize - The current size.
 * @param targetSize - The target size.
 * @returns A vec3 with the scale ratio for each axis.
 */
export function computeScaleRatio(currentSize: vec3, targetSize: vec3): vec3 {
  const scaleX = currentSize.x !== 0 ? targetSize.x / currentSize.x : 1
  const scaleY = currentSize.y !== 0 ? targetSize.y / currentSize.y : 1
  const scaleZ = currentSize.z !== 0 ? targetSize.z / currentSize.z : 1
  return new vec3(scaleX, scaleY, scaleZ)
}

/**
 * Computes a unified scale ratio by taking the minimum of multiple scale sources.
 * Useful when an object contains multiple visual components (mesh, image) that all need to fit.
 * @param scales - Array of scale vectors (nullable).
 * @returns The unified scale vector (min of all valid scales), or vec3.one() if none valid.
 */
export function computeUnifiedScaleRatio(...scales: (vec3 | null)[]): vec3 {
  let finalScale: vec3 | null = null

  for (const scale of scales) {
    if (scale) {
      if (finalScale) {
        finalScale = minVec3Components(finalScale, scale)
      } else {
        finalScale = scale
      }
    }
  }

  return finalScale || vec3.one()
}

/** Set a Text component's worldSpaceRect in local cm, converting to world space. */
export function setTextRect(text: Text, sceneObject: SceneObject, localW: number, localH: number): void {
  const t = text as any
  if ("layoutRect" in t) {
    // `layoutRect` (LS Scripting v364+) is in the text SceneObject's LOCAL
    // coordinate space — the runtime scales it by the worldScale automatically.
    // Just pass the local size straight through.
    t.layoutRect = Rect.create(-localW / 2, localW / 2, -localH / 2, localH / 2)
  } else {
    // Legacy `worldSpaceRect` is in WORLD units, so scale by the parent's
    // worldScale to compensate. Kept for older LS runtimes that don't expose
    // `layoutRect`.
    const parent = sceneObject.getParent()
    const parentScale = parent ? parent.getTransform().getWorldScale() : vec3.one()
    const worldW = localW * Math.abs(parentScale.x)
    const worldH = localH * Math.abs(parentScale.y)
    text.worldSpaceRect = Rect.create(-worldW / 2, worldW / 2, -worldH / 2, worldH / 2)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TEXT FITTING
//
// Pure math over a real glyph measurement (Text.getBoundingBox, normally via
// ElementContent.measureNaturalTextWidth or the Layout2D measurement
// coordinator). Never a character-count estimate. No engine access and no
// import edge, so these take no part in the VISUAL HELPERS cycle above.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Natural (unwrapped) label width per unit of font size, derived from a real glyph measurement
 * taken at `measuredSize`. Rendered text width is linear in font size, so one measurement at any
 * size predicts the width at every other size. Returns `null` for a degenerate measurement (zero,
 * negative, or non-finite) so a refused or not-yet-resolved measurement is never mistaken for a fit.
 * @param measuredWidth - The measured natural width, in the Text's layout units (cm in UIKit).
 * @param measuredSize - The Text `size` the measurement was taken at.
 * @returns Width per unit of font size, or `null` when the measurement is unusable.
 */
export function labelWidthPerSizeUnit(measuredWidth: number, measuredSize: number): number | null {
  if (!isFinite(measuredWidth) || !isFinite(measuredSize)) return null
  if (measuredWidth <= 0 || measuredSize <= 0) return null
  return measuredWidth / measuredSize
}

/**
 * The font size a single-line label should render at inside a fixed-width cell: `baseSize` when
 * the label's natural width at that size already fits within `maxWidth`, otherwise the size at
 * which it spans exactly `maxWidth`, never below `baseSize × minScale` — an extreme translation is
 * left to overflow legibly rather than shrunk into an unreadable smear. TextInputField uses this to
 * keep a translated clear label ("Effacer") inside its fixed-size button.
 *
 * Degenerate inputs (non-positive or non-finite base size, ratio, or cell width, or a non-finite
 * floor) fit nothing and return `baseSize` unchanged.
 * @param baseSize - The font size the label renders at when it fits.
 * @param widthPerSizeUnit - The label's width per unit of font size, from {@link labelWidthPerSizeUnit}.
 * @param maxWidth - The room the label may span, in the same units as the measurement.
 * @param minScale - Shrink floor as a fraction of `baseSize`; a value of 1 or more disables shrinking.
 * @returns The fitted font size.
 */
export function fitLabelSize(baseSize: number, widthPerSizeUnit: number, maxWidth: number, minScale: number): number {
  if (!isFinite(baseSize) || !isFinite(widthPerSizeUnit) || !isFinite(maxWidth) || !isFinite(minScale)) {
    return baseSize
  }
  if (baseSize <= 0 || widthPerSizeUnit <= 0 || maxWidth <= 0) return baseSize
  const naturalWidth = baseSize * widthPerSizeUnit
  if (naturalWidth <= maxWidth) return baseSize
  const scale = Math.max(Math.min(minScale, 1), maxWidth / naturalWidth)
  return baseSize * scale
}

/**
 * Whether a fresh width-per-size reading should replace the stored one: always when nothing is
 * stored yet, otherwise only when it moved by more than `relativeTolerance` of the stored value.
 * Absorbs the float noise of re-reading the same glyphs at a new font size, while a real change
 * (font metrics that settled after the first measurement) still gets through. A non-finite or
 * non-positive `next` never replaces anything.
 * @param previous - The stored ratio, or `null` when none has landed.
 * @param next - The fresh ratio, from {@link labelWidthPerSizeUnit}.
 * @param relativeTolerance - Change below which the two readings count as the same metrics.
 * @returns `true` when `next` should replace `previous`.
 */
export function labelRatioDrifted(previous: number | null, next: number, relativeTolerance: number): boolean {
  if (!isFinite(next) || next <= 0) return false
  if (previous === null) return true
  return Math.abs(next - previous) > previous * relativeTolerance
}

// ═══════════════════════════════════════════════════════════════════════════
// TEXTURE UTILITIES
//
// Deliberately outside the VISUAL HELPERS block above: these touch only
// engine globals, add no import edge to this file, and so take no part in
// that section's import cycle.
// ═══════════════════════════════════════════════════════════════════════════

// The conventional transparency-checkerboard greys — the universal "what
// shows through here is transparency, not colour" pattern, not brand
// tokens, which is why they are not theme colours.
const CHECKERBOARD_LIGHT_BYTE = 255
const CHECKERBOARD_DARK_BYTE = 214
// Pixels per square. The texture holds one full 2x2 cycle, so it is twice
// this on a side — big enough that the bilinear filtering applied when it
// is magnified only softens each square's edge by a small fraction of the
// square.
const CHECKERBOARD_SQUARE_PIXELS = 16

// One texture for the whole lens: the pattern is identical everywhere, so
// building it per consumer would be waste. Populated on first use and never
// at module scope, where the engine globals are not ready yet.
let transparencyCheckerboardTexture: Texture | null = null
// Latches a failed build. Whether this host can make a procedural texture
// is a capability, not a transient condition, so one failure answers for
// the rest of the session — and callers can sit on a hot path (a slider
// repaints its backing on every colour change, i.e. per frame while
// dragging), where retrying would mean a throwing native call and an
// exception unwind every frame, forever.
let transparencyCheckerboardUnavailable = false

/**
 * The shared transparency checkerboard, or null when this host cannot
 * provide a procedural texture (callers should then skip the backing rather
 * than fail). Built at most once per session either way: a success is
 * cached and a failure is latched, so this is safe to call from a hot path.
 *
 * SQUARE on purpose, which is what makes it tile correctly on a rounded
 * rectangle: `textureMode = "Fill Height"` scales the UVs by
 * `size.x / size.y` for a square texture, so paired with
 * `textureWrap = "Repeat"` a single 2x2 cycle repeats along the long axis
 * and lands exactly two rows tall at any size. Note that a later resize
 * does NOT re-derive that scale — re-assign `texture` to refresh it (the
 * `textureMode` setter is equality-guarded and cannot).
 */
export function getTransparencyCheckerboardTexture(): Texture | null {
  if (transparencyCheckerboardTexture) {
    return transparencyCheckerboardTexture
  }
  if (transparencyCheckerboardUnavailable) {
    return null
  }

  const side = CHECKERBOARD_SQUARE_PIXELS * 2
  try {
    // createWithFormat, not the deprecated create(): RGBA8Unorm is the
    // format setPixels documents for Uint8Array data.
    const texture = ProceduralTextureProvider.createWithFormat(side, side, TextureFormat.RGBA8Unorm)
    const pixels = new Uint8Array(side * side * 4)
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const isLight =
          (Math.floor(x / CHECKERBOARD_SQUARE_PIXELS) + Math.floor(y / CHECKERBOARD_SQUARE_PIXELS)) % 2 === 0
        const value = isLight ? CHECKERBOARD_LIGHT_BYTE : CHECKERBOARD_DARK_BYTE
        const offset = (y * side + x) * 4
        pixels[offset] = value
        pixels[offset + 1] = value
        pixels[offset + 2] = value
        pixels[offset + 3] = 255
      }
    }
    ;(texture.control as ProceduralTextureProvider).setPixels(0, 0, side, side, pixels)
    transparencyCheckerboardTexture = texture
    return texture
  } catch {
    // No procedural-texture support on this host: report null so callers
    // can skip the checkerboard rather than fail. Bare catch — the reason
    // is the absence of the API, not anything the error object carries.
    // Latched, so this is paid once rather than on every caller pass; that
    // also covers a setPixels failure, which would otherwise allocate and
    // discard a texture each time.
    transparencyCheckerboardUnavailable = true
    return null
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RECT UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/** Mutates a Rect to the provided edge values and returns it. */
export function setRect(rect: Rect, left: number, right: number, bottom: number, top: number): Rect {
  rect.left = left
  rect.right = right
  rect.bottom = bottom
  rect.top = top
  return rect
}

/** Configures a ScreenTransform to fill its parent's bounds at a fixed x/y offset. */
export function configureScreenTransformToFillParent(
  screenTransform: ScreenTransform,
  offsetX: number = 0,
  offsetY: number = 0
): void {
  setRect(screenTransform.anchors, -1, 1, -1, 1)
  setRect(screenTransform.offsets, offsetX, offsetX, offsetY, offsetY)
}

/** Copies one Rect's edge values into another Rect. */
export function copyRect(source: Rect, target: Rect): Rect {
  return setRect(target, source.left, source.right, source.bottom, source.top)
}

/** Expands a Rect by x/y amounts on both sides and writes the result to target. */
export function expandRect(source: Rect, expansion: vec2, target: Rect): Rect {
  return setRect(
    target,
    source.left - expansion.x,
    source.right + expansion.x,
    source.bottom - expansion.y,
    source.top + expansion.y
  )
}

/** Checks exact equality of Rect edge values. */
export function areRectsEqual(a: Rect, b: Rect): boolean {
  return a.left === b.left && a.right === b.right && a.bottom === b.bottom && a.top === b.top
}

// ═══════════════════════════════════════════════════════════════════════════
// BOUNDS UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Returns an empty Bounds3D with all vectors set to zero.
 * @returns A Bounds3D with min, max, size, and center all set to vec3.zero().
 */
export function emptyBounds(): Bounds3D {
  return {min: vec3.zero(), max: vec3.zero(), size: vec3.zero(), center: vec3.zero()}
}

/**
 * Combines multiple Bounds3D into a single bounding box that encompasses all of them.
 * @param boundsArray - Array of Bounds3D to combine.
 * @returns Combined Bounds3D encompassing all input bounds, or empty bounds if array is empty.
 */
export function combineBounds(boundsArray: Bounds3D[]): Bounds3D {
  if (boundsArray.length === 0) {
    return emptyBounds()
  }

  let min = new vec3(Infinity, Infinity, Infinity)
  let max = new vec3(-Infinity, -Infinity, -Infinity)

  for (const b of boundsArray) {
    min = minVec3Components(min, b.min)
    max = maxVec3Components(max, b.max)
  }

  const size = max.sub(min)
  const center = min.add(max).uniformScale(0.5)

  return {min, max, size, center}
}

/**
 * Creates a Bounds3D centered at zero with the given size.
 * @param size - The size of the bounds.
 * @returns A Bounds3D centered at vec3.zero().
 */
export function createCenteredBounds(size: vec3): Bounds3D {
  const half = size.uniformScale(0.5)
  return {
    min: new vec3(-half.x, -half.y, -half.z),
    max: new vec3(half.x, half.y, half.z),
    size: size,
    center: vec3.zero()
  }
}

/**
 * Computes the local bounds from a world-space AABB.
 * The result is in local space and unscaled.
 * @param worldMin - World space AABB minimum corner.
 * @param worldMax - World space AABB maximum corner.
 * @param worldToLocal - Matrix to transform from world to local space.
 * @returns The calculated Bounds3D.
 */
export function computeLocalBoundsFromWorldAabb(worldMin: vec3, worldMax: vec3, worldToLocal: mat4): Bounds3D {
  // 8 corners of the AABB
  const corners = [
    new vec3(worldMin.x, worldMin.y, worldMin.z),
    new vec3(worldMin.x, worldMin.y, worldMax.z),
    new vec3(worldMin.x, worldMax.y, worldMin.z),
    new vec3(worldMin.x, worldMax.y, worldMax.z),
    new vec3(worldMax.x, worldMin.y, worldMin.z),
    new vec3(worldMax.x, worldMin.y, worldMax.z),
    new vec3(worldMax.x, worldMax.y, worldMin.z),
    new vec3(worldMax.x, worldMax.y, worldMax.z)
  ]

  let min = new vec3(Infinity, Infinity, Infinity)
  let max = new vec3(-Infinity, -Infinity, -Infinity)

  corners.forEach((p) => {
    const localP = worldToLocal.multiplyPoint(p)
    min = minVec3Components(min, localP)
    max = maxVec3Components(max, localP)
  })

  const size = max.sub(min)
  const center = min.add(size.uniformScale(0.5))

  return {
    min,
    max,
    size,
    center
  }
}

/**
 * Computes the local bounds from a world-space AABB and applies local scale.
 * Transforms world bounds to local space and scales by the provided localScale.
 * Ensures correct min/max ordering after scale application (handles negative scales).
 * @param worldMin - World space AABB minimum corner.
 * @param worldMax - World space AABB maximum corner.
 * @param worldToLocal - Matrix to transform from world to local space.
 * @param localScale - Scale to apply to the local bounds.
 * @returns An object with min and max corners of the scaled local bounds.
 */
export function computeLocalBoundsFromWorldAabbScaled(
  worldMin: vec3,
  worldMax: vec3,
  worldToLocal: mat4,
  localScale: vec3
): {min: vec3; max: vec3} {
  const bounds = computeLocalBoundsFromWorldAabb(worldMin, worldMax, worldToLocal)

  const rawMin = new vec3(bounds.min.x * localScale.x, bounds.min.y * localScale.y, bounds.min.z * localScale.z)
  const rawMax = new vec3(bounds.max.x * localScale.x, bounds.max.y * localScale.y, bounds.max.z * localScale.z)

  // Ensure correct ordering after scale (negative scales can flip min/max)
  return {
    min: minVec3Components(rawMin, rawMax),
    max: maxVec3Components(rawMin, rawMax)
  }
}

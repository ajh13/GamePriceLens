/**
 * Pure helpers behind TextInputField's numeric drag-to-adjust mode (`dragAdjustAxis`).
 *
 * The displayed number is held as an integer count of its smallest displayed unit
 * ({@link ScaledDecimal}) so that stepping never accumulates floating-point drift and the
 * formatted result keeps exactly the precision the user typed: "2.50" steps by 0.01, "7" by 1.
 * A unit suffix after the number ("50%", "2.5 cm") is split off before stepping and written back
 * unchanged ({@link NumberWithSuffix}), so a field can show its value with its unit and still be
 * dragged.
 *
 * No Lens Studio imports — everything here is unit-testable under jest.
 */

/** Axis along which dragging the field steps its numeric value. `none` disables the gesture. */
export type NumericDragAxis = "none" | "horizontal" | "vertical"

/**
 * A decimal number as `scaled × 10^-decimals`, with `scaled` a safe integer.
 * `{scaled: 250, decimals: 2}` is 2.50; `{scaled: -7, decimals: 0}` is -7.
 */
export type ScaledDecimal = {scaled: number; decimals: number}

/** A 2D point; only the components the axis needs are read. */
export type DragAdjustPoint = {x: number; y: number}

/**
 * Field text split into the number a drag steps and the unit suffix that trails it: "50%" is 50
 * with suffix "%", "2.5 cm" is 2.5 with suffix " cm". The suffix is kept verbatim (including a
 * separating space) so the stepped number can be written back in the same shape.
 */
export type NumberWithSuffix = {value: ScaledDecimal; suffix: string}

// Plain decimal notation only: optional sign, digits, optional fraction ("5", "-2.50", "+.5", "5.").
// Exponents, hex, thousands separators, and words are rejected rather than guessed at.
const PLAIN_DECIMAL_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)$/
// A plain decimal followed by a unit suffix: trailing text that opens with something other than a
// digit, sign, dot, or space and contains no digit ("%", "°", " cm"). Anything else after the
// number — an exponent, a thousands separator, a second number — leaves the whole text to
// PLAIN_DECIMAL_PATTERN, which rejects it; a trailing dot stays part of the number ("5.").
const NUMBER_WITH_SUFFIX_PATTERN = /^([+-]?(?:\d+\.?\d*|\.\d+))(\s*[^\d\s.+-]\D*)$/

/**
 * Parses field text into a {@link ScaledDecimal}.
 *
 * Empty or whitespace-only text (the field is showing its placeholder) parses as `0` with no
 * decimals, so the first drag step produces "1" / "-1". Text that is not a plain decimal, or
 * whose digits exceed the safe-integer range, returns `null` and must not be adjusted.
 */
export function parseScaledDecimal(text: string): ScaledDecimal | null {
  const trimmed = text.trim()
  if (trimmed === "") return {scaled: 0, decimals: 0}
  if (!PLAIN_DECIMAL_PATTERN.test(trimmed)) return null

  const dot = trimmed.indexOf(".")
  const decimals = dot === -1 ? 0 : trimmed.length - dot - 1
  // Dropping the dot leaves the sign and every digit: "-2.50" -> "-250" -> -250 at 2 decimals.
  const scaled = Number(trimmed.replace(".", ""))
  if (!Number.isSafeInteger(scaled)) return null
  return {scaled, decimals}
}

/**
 * Parses field text into its number and unit suffix. The number follows
 * {@link parseScaledDecimal} exactly (empty text is 0; anything but a plain decimal is rejected),
 * so text without a suffix parses as before, with an empty one. Leading text ("$5") is not a
 * suffix and returns `null`.
 */
export function parseNumberWithSuffix(text: string): NumberWithSuffix | null {
  const trimmed = text.trim()
  const match = NUMBER_WITH_SUFFIX_PATTERN.exec(trimmed)
  const value = parseScaledDecimal(match ? match[1] : trimmed)
  return value ? {value, suffix: match ? match[2] : ""} : null
}

/**
 * Moves `start` by `steps` smallest units. Returns `null` when the result would leave the
 * safe-integer range, so a runaway drag can never produce imprecise digits.
 */
export function stepScaledDecimal(start: ScaledDecimal, steps: number): ScaledDecimal | null {
  if (!Number.isSafeInteger(steps)) return null
  const scaled = start.scaled + steps
  if (!Number.isSafeInteger(scaled)) return null
  return {scaled, decimals: start.decimals}
}

/**
 * Formats a {@link ScaledDecimal} with exactly `decimals` fraction digits, built from the integer
 * digits directly (no division), so "0.10" never becomes "0.1" and -0 never prints as "-0".
 */
export function formatScaledDecimal(value: ScaledDecimal): string {
  const {scaled, decimals} = value
  const magnitude = String(Math.abs(scaled))
  const sign = scaled < 0 ? "-" : ""
  if (decimals <= 0) return sign + magnitude

  const digits = magnitude.padStart(decimals + 1, "0")
  const split = digits.length - decimals
  return `${sign}${digits.slice(0, split)}.${digits.slice(split)}`
}

/**
 * Writes a stepped number back in the shape it was parsed from: {@link formatScaledDecimal}
 * followed by the suffix.
 */
export function formatNumberWithSuffix(value: ScaledDecimal, suffix: string): string {
  return formatScaledDecimal(value) + suffix
}

/**
 * Signed drag distance along `axis` in the field's local units: right and up are positive.
 * `none` always yields 0.
 */
export function dragAxisDelta(axis: NumericDragAxis, start: DragAdjustPoint, current: DragAdjustPoint): number {
  switch (axis) {
    case "horizontal":
      return current.x - start.x
    case "vertical":
      return current.y - start.y
    default:
      return 0
  }
}

/**
 * Converts a drag distance into whole steps. Truncation (not rounding) means a step registers
 * only once the hand has travelled a full `stepDistance`, which gives a dead zone around the
 * grab point and identical behavior in both directions. Non-positive or non-finite inputs give 0.
 */
export function dragStepsForDelta(delta: number, stepDistance: number): number {
  if (!(stepDistance > 0) || !Number.isFinite(delta)) return 0
  // `+ 0` folds the -0 that Math.trunc returns for small negative deltas into 0.
  return Math.trunc(delta / stepDistance) + 0
}

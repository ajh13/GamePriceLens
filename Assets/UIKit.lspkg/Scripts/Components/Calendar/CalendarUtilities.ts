import {clamp} from "InteractionKit.lspkg/Utils/mathUtils"
import type {Button} from "../Button/Button"
import type {ElementContent} from "../Content/ElementContent"

// Anchors the calendar LocalizationsAsset into the package build. Calls to
// localizationSystem.localize() do not create an asset reference by
// themselves, so the static requireAsset() is required for key resolution.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const CALENDAR_LOCALIZATIONS_ASSET = requireAsset("../../../Localization/Calendar/strings") as LocalizationsAsset

/**
 * Shared calendar-domain types, constants, and helpers used by Calendar and
 * DatePicker: pure Gregorian date math plus the small UI helpers both
 * components apply to their cells and fields.
 */

/** A Gregorian calendar date with a 1-based month. */
export type CalendarDate = {
  year: number
  month: number
  day: number
}

export const MIN_MONTH = 1
export const MAX_MONTH = 12

const LOCALIZATION_REFERENCE_YEAR = 2024
const LOCALIZATION_REFERENCE_DAY = 1
const LOCALIZATION_REFERENCE_HOUR = 12

/** Full localized month names indexed by 0-based month. */
export const MONTH_NAMES = Array.from({length: MAX_MONTH}, (_, monthIndex) =>
  global.localizationSystem.getMonth(
    new Date(LOCALIZATION_REFERENCE_YEAR, monthIndex, LOCALIZATION_REFERENCE_DAY, LOCALIZATION_REFERENCE_HOUR)
  )
)

/** Abbreviated day names starting at Sunday, matching weekday column order. */
const DAY_NAME_KEYS = [
  "@uikit:calendar:weekday-sunday-short",
  "@uikit:calendar:weekday-monday-short",
  "@uikit:calendar:weekday-tuesday-short",
  "@uikit:calendar:weekday-wednesday-short",
  "@uikit:calendar:weekday-thursday-short",
  "@uikit:calendar:weekday-friday-short",
  "@uikit:calendar:weekday-saturday-short"
]

export const DAY_NAMES = DAY_NAME_KEYS.map((key) => global.localizationSystem.localize(key))

/** Number of days in a week — the weekday column count of a date grid. */
export const DAYS_PER_WEEK = DAY_NAMES.length

const DAYS_PER_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const FEBRUARY = 2
// Per-month offsets for Sakamoto's day-of-week algorithm.
const SAKAMOTO_MONTH_OFFSETS = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]

/** Encodes a date as a single number that orders chronologically. */
export function getDateKey(date: CalendarDate): number {
  return date.year * 10000 + date.month * 100 + date.day
}

/**
 * Compares two dates chronologically.
 * @returns A negative number when a precedes b, zero when equal, positive
 * when a follows b.
 */
export function compareDates(a: CalendarDate, b: CalendarDate): number {
  return getDateKey(a) - getDateKey(b)
}

/** Returns whether two dates are the same day. */
export function areDatesEqual(a: CalendarDate, b: CalendarDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day
}

/** Returns whether two nullable dates are both null or the same day. */
export function areNullableDatesEqual(a: CalendarDate | null, b: CalendarDate | null): boolean {
  if (!a || !b) return a === b

  return areDatesEqual(a, b)
}

/** Returns whether a date falls within [startDate, endDate], inclusive. */
export function isDateInRange(date: CalendarDate, startDate: CalendarDate, endDate: CalendarDate): boolean {
  const key = getDateKey(date)
  return key >= getDateKey(startDate) && key <= getDateKey(endDate)
}

/** Returns whether endDate is the day immediately after startDate. */
export function areDatesConsecutive(startDate: CalendarDate, endDate: CalendarDate): boolean {
  if (startDate.year === endDate.year && startDate.month === endDate.month) {
    return endDate.day - startDate.day === 1
  }

  const nextMonth = startDate.month === MAX_MONTH ? MIN_MONTH : startDate.month + 1
  const nextYear = startDate.month === MAX_MONTH ? startDate.year + 1 : startDate.year

  return (
    startDate.day === getDaysInMonth(startDate.year, startDate.month) &&
    endDate.day === 1 &&
    endDate.month === nextMonth &&
    endDate.year === nextYear
  )
}

/** Returns a copy of a date, or null for a null input. */
export function cloneDate(date: CalendarDate | null): CalendarDate | null {
  if (!date) return null

  return {
    year: date.year,
    month: date.month,
    day: date.day
  }
}

/** Returns whether a year is a Gregorian leap year. */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/**
 * Returns the number of days in a month, accounting for leap years.
 * @param year - The year containing the month.
 * @param month - The 1-based month number.
 */
export function getDaysInMonth(year: number, month: number): number {
  if (month === FEBRUARY && isLeapYear(year)) {
    return DAYS_PER_MONTH[FEBRUARY - 1] + 1
  }

  return DAYS_PER_MONTH[month - 1]
}

/**
 * Returns the weekday column (0 = Sunday) of the first day of a month,
 * computed with Sakamoto's algorithm. Pure Gregorian math, so it avoids
 * the Date constructor's 0-99 two-digit-year remapping.
 * @param year - The year containing the month.
 * @param month - The 1-based month number.
 */
export function getFirstDayColumn(year: number, month: number): number {
  // Sakamoto's algorithm counts January and February as months 13 and 14
  // of the previous year.
  const adjustedYear = month < 3 ? year - 1 : year
  const dayOfWeek =
    adjustedYear +
    Math.floor(adjustedYear / 4) -
    Math.floor(adjustedYear / 100) +
    Math.floor(adjustedYear / 400) +
    SAKAMOTO_MONTH_OFFSETS[month - 1] +
    1
  return ((dayOfWeek % DAYS_PER_WEEK) + DAYS_PER_WEEK) % DAYS_PER_WEEK
}

/** Returns the first year of the decade containing a year. */
export function getDecadeStart(year: number): number {
  return Math.floor(year / 10) * 10
}

/** The device's current date with a 1-based month. */
export function getDeviceDate(): CalendarDate {
  const deviceDate = new Date()
  return {year: deviceDate.getFullYear(), month: deviceDate.getMonth() + 1, day: deviceDate.getDate()}
}

/**
 * Clamps a month to the valid 1-12 range, flooring fractional values.
 * @param month - The candidate 1-based month number.
 * @param fallback - Returned when month is not a finite number.
 */
export function normalizeMonth(month: number, fallback: number): number {
  if (!isFinite(month)) return fallback

  return Math.floor(clamp(month, MIN_MONTH, MAX_MONTH))
}

/** Formats a date for field display, e.g. "October 12, 2026". */
export function formatCalendarDate(date: CalendarDate): string {
  // The multi-argument Date constructor remaps years 0-99 to 1900-1999.
  // Start from a stable local noon and set every date field explicitly so
  // localization receives the same year represented by CalendarDate.
  const formattedDate = new Date(2000, 0, 1, 12)
  formattedDate.setFullYear(date.year, date.month - 1, date.day)
  return global.localizationSystem.getDateFormatted(formattedDate)
}

/**
 * Applies a toggle state without the visual's state-transition fade, so the
 * new state lands instantly instead of cross-fading.
 */
export function setButtonToggledImmediate(button: Button | undefined, on: boolean): void {
  if (!button || button.isOn === on) return

  // The toggle's state change reaches the visual synchronously, so the
  // zero-duration window covers the transition it starts.
  const visual = button.visual
  const fadeDuration = visual?.animateDuration
  if (visual) {
    visual.animateDuration = 0
  }
  button.isOn = on
  if (visual && fadeDuration !== undefined) {
    visual.animateDuration = fadeDuration
  }
}

/** Recolors an element content's text via its color override. */
export function applyContentTextColor(content: ElementContent, color: vec4): void {
  content.useTextColorOverride = true
  content.textColorOverride = color
}

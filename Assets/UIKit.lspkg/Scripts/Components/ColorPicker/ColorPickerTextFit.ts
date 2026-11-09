/**
 * Pure text-fit math for {@link ColorPicker}'s dynamic label sizing.
 *
 * The picker fits one shared font size to every label it owns so that no
 * label ever wraps or clips: for each cell it computes the worst-case
 * rendered width per font point of the text that cell can ever show, then
 * solves the one-division fit `size = band * TEXT_FIT_SAFETY / widthPerPoint`
 * against the cell's available text band. Width is linear in font size, so
 * the fit needs no search.
 *
 * Everything here is arithmetic over a glyph-width table measured at
 * runtime from the picker's live Text components (real glyph measurement,
 * never a character-count estimate). The table maps a single glyph to its
 * ADVANCE — pen travel, not ink extents — in centimeters per font point;
 * see GlyphWidthTable for why. This module has zero imports so unit tests
 * can exercise the candidate logic directly.
 */

/**
 * Fraction of a cell's text band the fitted text may occupy. The headroom
 * absorbs kerning wobble that per-glyph additive composition can't see.
 */
export const TEXT_FIT_SAFETY = 0.96

/**
 * Fitted sizes never go below this, even when a cell's band is too narrow
 * (or negative — a cell narrower than its own insets). Always-fits-but-
 * illegible is not better; below the floor the text is allowed to clip.
 * Boot also holds at the floor until every measurement the fit needs has
 * landed, then applies the fitted size in one step (a partial glyph table
 * yields no fit — see the worst-width functions below), so text is never
 * clipped in transit. How many frames that takes depends on the engine's
 * per-frame getBoundingBox budget, which is not documented; see
 * measureGlyphAdvanceStep for how the probes make progress under a tight
 * one.
 */
export const TEXT_FIT_FLOOR = 10

/**
 * Single-glyph ADVANCES (pen travel), in centimeters per font point —
 * deliberately not ink extents. A rendered string's ink width is the sum
 * of its advances less only the two END bearings, so summing per-glyph
 * inks drops every inner bearing pair and undershoots real strings by
 * 8-18% for this font's digits — far more than TEXT_FIT_SAFETY covers.
 * Sums of advances instead UPPER-bound the rendered width (by those two
 * end bearings), so composed worst cases err on the safe side. The picker
 * measures each advance as ink("gg") - ink("g"); see
 * measureGlyphAdvanceStep.
 */
export type GlyphWidthTable = ReadonlyMap<string, number>

const DIGIT_GLYPHS = "0123456789"
const HEX_GLYPHS = "0123456789ABCDEF"
const PERCENT_GLYPH = "%"

/** Every glyph the value fields can show; the probe queue measures these. */
export const FIELD_GLYPH_SAMPLES: readonly string[] = (HEX_GLYPHS + PERCENT_GLYPH).split("")

/**
 * A pending single-glyph measurement. `singleWidthPerPoint` is the ink
 * width of the glyph alone once that half has landed, kept across a
 * refusal of the doubled half so the probe never re-spends a call it has
 * already won (see measureGlyphAdvanceStep).
 */
export type GlyphAdvanceProbe = {
  sample: string
  singleWidthPerPoint: number | null
}

/**
 * One attempt at a glyph probe's ADVANCE per font point, as ink("gg") -
 * ink("g") (see GlyphWidthTable for why advances, not inks; same-glyph
 * kerning is ~0 for digits, and TEXT_FIT_SAFETY absorbs the cross-pair
 * kerning composition can't see). Each half costs one rate-limited
 * getBoundingBox call, and the engine's per-frame budget is undocumented:
 * at a budget of one, a probe that re-measured both halves on every
 * attempt would win the single, be refused the double, and repeat forever
 * — the fit pinned at the floor. So the single width is kept on the probe
 * once it lands, and a later attempt spends its call on the doubled sample
 * only. An inconsistent pair (a non-positive advance) drops the kept width
 * so the next attempt re-measures both.
 * @param probe - The glyph probe; its `singleWidthPerPoint` is read and
 * updated in place.
 * @param measure - Measures a sample's ink width per font point on the
 * live Text; null when the engine refuses or the width is unusable.
 * @returns The advance per font point, or null to retry on a later pass.
 */
export function measureGlyphAdvanceStep(
  probe: GlyphAdvanceProbe,
  measure: (sample: string) => number | null
): number | null {
  if (probe.singleWidthPerPoint === null) {
    const single = measure(probe.sample)
    if (single === null) return null
    probe.singleWidthPerPoint = single
  }

  const doubled = measure(probe.sample + probe.sample)
  if (doubled === null) return null

  const advance = doubled - probe.singleWidthPerPoint
  if (!(advance > 0)) {
    probe.singleWidthPerPoint = null
    return null
  }
  return advance
}

/** The number of digits the hex field renders (see hexCanonicalText). */
const HEX_FIELD_DIGIT_COUNT = 6

function hasGlyphs(table: GlyphWidthTable, glyphs: string): boolean {
  for (const glyph of glyphs) {
    if (!(table.get(glyph)! > 0)) return false
  }
  return true
}

function widestGlyph(table: GlyphWidthTable, glyphs: string): number {
  let widest = 0
  for (const glyph of glyphs) {
    widest = Math.max(widest, table.get(glyph) ?? 0)
  }
  return widest
}

function stringWidth(table: GlyphWidthTable, text: string): number {
  let width = 0
  for (const glyph of text) {
    width += table.get(glyph) ?? 0
  }
  return width
}

/**
 * The widest rendered width (per font point) any integer in [0, max] can
 * take under the given glyph table, or null while the digit glyphs are
 * still unmeasured.
 *
 * A single tight walk of `String(max)` is not enough — with '8' the widest
 * digit, max 255 is out-widthed by "188" and "248". The exhaustive
 * candidate set is:
 * - the tight string `String(max)` itself,
 * - for each position, the tight prefix, then the widest digit strictly
 *   below the tight digit there, then the widest digit filling the free
 *   positions after (the drop makes every later digit unconstrained),
 * - for each shorter length, the all-widest-digits string.
 * A leading zero is barred only for multi-digit strings — "0" is a real
 * value, so the length-1 candidate may be '0'.
 */
export function worstNumericWidthPerPoint(max: number, table: GlyphWidthTable): number | null {
  if (!hasGlyphs(table, DIGIT_GLYPHS)) return null

  const tight = String(Math.max(0, Math.trunc(max)))
  const length = tight.length
  const widestAnyDigit = widestGlyph(table, DIGIT_GLYPHS)
  const widestNonZeroDigit = widestGlyph(table, DIGIT_GLYPHS.substring(1))

  let worst = stringWidth(table, tight)
  for (let i = 0; i < length; i++) {
    const tightDigit = tight.charCodeAt(i) - 48
    const lowestAllowed = i === 0 && length > 1 ? 1 : 0
    if (tightDigit - 1 < lowestAllowed) continue
    const dropDigits = DIGIT_GLYPHS.substring(lowestAllowed, tightDigit)
    const candidate =
      stringWidth(table, tight.substring(0, i)) + widestGlyph(table, dropDigits) + (length - 1 - i) * widestAnyDigit
    worst = Math.max(worst, candidate)
  }
  for (let shorter = 1; shorter < length; shorter++) {
    const candidate = shorter === 1 ? widestAnyDigit : widestNonZeroDigit + (shorter - 1) * widestAnyDigit
    worst = Math.max(worst, candidate)
  }
  return worst
}

/**
 * The widest width (per font point) the hex field can show — six of the
 * widest hex glyph (see hexCanonicalText: always exactly six uppercase hex
 * digits, and the "FFFFFF" placeholder is a subset). Null while any hex
 * glyph is unmeasured.
 */
export function worstHexWidthPerPoint(table: GlyphWidthTable): number | null {
  if (!hasGlyphs(table, HEX_GLYPHS)) return null
  return HEX_FIELD_DIGIT_COUNT * widestGlyph(table, HEX_GLYPHS)
}

/**
 * The widest width (per font point) the alpha field can show — the worst
 * integer percentage in [0, 100] plus the trailing '%' (see
 * formatAlphaPercent; the "100%" placeholder is one of the candidates).
 * Null while a needed glyph is unmeasured.
 */
export function worstAlphaPercentWidthPerPoint(table: GlyphWidthTable): number | null {
  const numeric = worstNumericWidthPerPoint(100, table)
  const percent = table.get(PERCENT_GLYPH)
  if (numeric === null || !(percent! > 0)) return null
  return numeric + percent!
}

/**
 * Solves the one-division fit for a cell: the largest font size whose
 * worst-case text still fits the band with {@link TEXT_FIT_SAFETY}
 * headroom, clamped to [floor, cap]. A non-positive band (a cell narrower
 * than its own insets) bottoms out at the floor — that is geometry, and no
 * font size helps.
 */
export function fitTextSizeToBand(band: number, widthPerPoint: number, cap: number, floor: number): number {
  const lower = Math.min(floor, cap)
  if (!(widthPerPoint > 0) || band <= 0) return lower
  return Math.max(lower, Math.min(cap, (band * TEXT_FIT_SAFETY) / widthPerPoint))
}

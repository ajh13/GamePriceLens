/**
 * Shared Text measurement and semantic caches; at most one native attempt per Text per frame.
 * Cache invalidation never resets the attempt allowance. Callers own retries.
 * See Layout2D/README.md for the measurement and presentation contracts.
 */

/** A 2D size in cm. */
export interface TextSize {
  width: number
  height: number
}

/** Pending values are display fallbacks, not measurements for the current key. */
export type Measurement<T> = {status: "ready"; value: T} | {status: "pending"; previous?: T}

// ─── Frame token ─────────────────────────────────────────────────────────

let frameTokenProvider: (() => number) | null = null

/**
 * Shared host frame identity. Assumes getTime() is constant within each frame;
 * device-trace verification remains pending. Tests can replace the source.
 */
export function getFrameToken(): number {
  if (frameTokenProvider) return frameTokenProvider()
  const g = globalThis as unknown as {getTime?: () => number}
  return typeof g.getTime === "function" ? g.getTime() : 0
}

/** Replace (or with `null`, restore) the frame token source. Internal to UIKit; tests use it. */
export function setFrameTokenProvider(provider: (() => number) | null): void {
  frameTokenProvider = provider
}

// ─── Per-Text state ──────────────────────────────────────────────────────

/** Semantic results, valid for `key` only. Cleared by invalidation or a key change. */
interface TextResults {
  key: string
  natural: TextSize | null
  /** min-content width; null until measured. Equals natural.width for single-run content. */
  minWidth: number | null
  wrapped: Map<number, number>
}

/** Attempt accounting. Survives invalidation and key changes on purpose. */
interface AttemptRecord {
  lastAttemptToken: number
  attempts: number
  /** Last natural size ever measured for this Text, any key — the `previous` fallback. */
  lastKnownNatural: TextSize | null
}

// Results per Text, per key, most-recently-used last. Two slots: a
// content-sized control stages a replacement label by measuring the NEW text
// on the same Text while the OLD text stays displayed, and the displayed
// label's ordinary layout queries must not evict the staged target's result
// (or the other way round) frame after frame. Anything beyond two live keys
// evicts the least recently used.
const RESULT_SLOTS = 2
const results = new WeakMap<object, Map<string, TextResults>>()
const attempts = new WeakMap<object, AttemptRecord>()

/** Bounded per-Text storage for wrapped heights at several widths (nested probes alternate widths). */
const WRAPPED_CACHE_WIDTHS = 8

/** Wide enough that vertical overflow never clips a wrapped measurement. */
const MEASURE_RECT_HEIGHT = 1e4

function attemptRecord(text: object): AttemptRecord {
  let record = attempts.get(text)
  if (!record) {
    record = {lastAttemptToken: Number.NaN, attempts: 0, lastKnownNatural: null}
    attempts.set(text, record)
  }
  return record
}

/**
 * Claims this frame's single attempt for `text`. Returns false when it is
 * already spent (by any caller, any query kind, any key).
 */
function claimAttempt(text: object): boolean {
  const record = attemptRecord(text)
  const token = getFrameToken()
  if (record.lastAttemptToken === token) return false
  record.lastAttemptToken = token
  record.attempts++
  return true
}

/** Number of native attempts made on this Text so far (diagnostics and tests). */
export function textMeasurementAttempts(text: object): number {
  return attempts.get(text)?.attempts ?? 0
}

function currentResults(text: object, key: string): TextResults {
  let slots = results.get(text)
  if (!slots) {
    slots = new Map()
    results.set(text, slots)
  }
  let entry = slots.get(key)
  if (entry) {
    // Refresh recency (Map iterates in insertion order).
    slots.delete(key)
    slots.set(key, entry)
    return entry
  }
  entry = {key, natural: null, minWidth: null, wrapped: new Map()}
  slots.set(key, entry)
  while (slots.size > RESULT_SLOTS) {
    const oldest = slots.keys().next().value
    if (oldest === undefined) break
    slots.delete(oldest)
  }
  return entry
}

// ─── Identity ────────────────────────────────────────────────────────────

/**
 * Content/style fingerprint the caches key on: content, font size, font
 * asset identity (uniqueIdentifier before a possibly duplicated name), font style,
 * capitalization, size-to-fit, and spacing. Read defensively so a missing property is absent
 * from the key rather than throwing. Best-effort: a metric-affecting change it
 * does not see is what {@link invalidateTextMeasurements} is for. Taken before
 * any temporary mutation (word probes swap `text`), never after.
 */
export function textMetricsKey(text: any): string {
  const size = typeof text.size === "number" ? text.size : 0
  const font = text.font
  const fontSig = font ? (font.uniqueIdentifier ?? font.name ?? "f") : "0"
  const weight = text.weight ?? ""
  const letter = text.letterSpacing ?? ""
  const line = text.lineSpacing ?? ""
  const italic = text.italic ?? ""
  const style = text.preferredStyle ?? ""
  const capitalization = text.capitilizationOverride ?? ""
  const sizeToFit = text.sizeToFit ?? false
  const content = typeof text.text === "string" ? text.text : ""
  return `${size}|${fontSig}|${weight}|${italic}|${style}|${capitalization}|${sizeToFit}|${letter}|${line}|${content}`
}

/**
 * Longest whitespace-delimited run in `s`, as a [start, end) char range.
 * `null` for empty / single-run strings (min-content == natural there).
 * Longest-by-character is a cheap proxy for widest-by-render. A string with
 * no whitespace is one unbreakable run; CJK soft-break points are not detected.
 */
export function longestWordRange(s: string): {start: number; end: number} | null {
  let bestStart = -1
  let bestLen = 0
  let runs = 0
  let runStart = -1
  for (let i = 0; i <= s.length; i++) {
    const isWs = i === s.length || /\s/.test(s.charAt(i))
    if (!isWs) {
      if (runStart < 0) runStart = i
    } else if (runStart >= 0) {
      runs++
      const len = i - runStart
      if (len > bestLen) {
        bestLen = len
        bestStart = runStart
      }
      runStart = -1
    }
  }
  if (bestStart < 0 || runs <= 1) return null
  return {start: bestStart, end: bestStart + bestLen}
}

// ─── Rect helpers ────────────────────────────────────────────────────────
// Lens Scripting v364 renamed `worldSpaceRect` → `layoutRect`; read either,
// write only the new name. Rects are copied by value: the host hands out a
// mutable alias, and restoring an alias restores nothing.

function readRectCopy(text: any): {left: number; right: number; bottom: number; top: number} | null {
  const rect = text.layoutRect ?? text.worldSpaceRect
  if (!rect) return null
  return {left: rect.left, right: rect.right, bottom: rect.bottom, top: rect.top}
}

function writeRect(text: any, left: number, right: number, bottom: number, top: number): void {
  text.layoutRect = Rect.create(left, right, bottom, top)
}

function readBox(text: any): TextSize | null {
  const size = text.getBoundingBox().getSize()
  const width = Math.abs(size.x)
  const height = Math.abs(size.y)
  if (!isFinite(width) || !isFinite(height)) return null
  return {width, height}
}

// ─── Requests ────────────────────────────────────────────────────────────

/**
 * Natural (unwrapped, max-content) extent. Empty content is a ready 0 × 0
 * with no host call. Any other content needs one attempt under the current
 * key; the Text's `horizontalOverflow` is forced to Overflow for the call and
 * restored on every exit. A zero box is valid for whitespace; other non-empty
 * content treats it as a refusal.
 */
export function measureNaturalSize(text: any): Measurement<TextSize> {
  if (!text) return {status: "pending"}
  const content = typeof text.text === "string" ? text.text : ""
  if (content === "") return {status: "ready", value: {width: 0, height: 0}}

  const key = textMetricsKey(text)
  const entry = currentResults(text, key)
  if (entry.natural) return {status: "ready", value: entry.natural}

  const record = attemptRecord(text)
  const previous = record.lastKnownNatural ?? undefined
  if (!claimAttempt(text)) return {status: "pending", previous}

  const savedOverflow = text.horizontalOverflow
  try {
    text.horizontalOverflow = HorizontalOverflow.Overflow
    const box = readBox(text)
    if (!box || (box.width <= 0 && box.height <= 0 && content.trim() !== "")) return {status: "pending", previous}
    entry.natural = box
    record.lastKnownNatural = box
    // Single-run content: min-content equals the natural width, no probe needed.
    if (longestWordRange(content) === null) entry.minWidth = box.width
    return {status: "ready", value: box}
  } catch {
    return {status: "pending", previous}
  } finally {
    text.horizontalOverflow = savedOverflow
  }
}

/**
 * Min-content width: the widest unbreakable run (CSS Sizing 3 §5.1). Needs a
 * ready natural size first (it caps the result); for multi-run content it then
 * spends its own attempt on a temporary `text` swap, restored on every exit.
 * Pending while either is outstanding — a natural-only consumer never waits on
 * this, and this never borrows a frame the natural measure needs.
 */
export function measureMinContentWidth(text: any): Measurement<number> {
  if (!text) return {status: "pending"}
  const content = typeof text.text === "string" ? text.text : ""
  if (content === "") return {status: "ready", value: 0}

  const natural = measureNaturalSize(text)
  const key = textMetricsKey(text)
  const entry = currentResults(text, key)
  if (entry.minWidth !== null) return {status: "ready", value: entry.minWidth}
  if (natural.status !== "ready") return {status: "pending"}

  const range = longestWordRange(content)
  if (!range) {
    entry.minWidth = natural.value.width
    return {status: "ready", value: entry.minWidth}
  }
  if (!claimAttempt(text)) return {status: "pending"}

  const savedText = text.text
  const savedOverflow = text.horizontalOverflow
  try {
    text.horizontalOverflow = HorizontalOverflow.Overflow
    text.text = content.substring(range.start, range.end)
    const box = readBox(text)
    if (!box || box.width <= 0) return {status: "pending"}
    // Never report a min wider than the whole line.
    entry.minWidth = Math.min(box.width, natural.value.width)
    return {status: "ready", value: entry.minWidth}
  } catch {
    return {status: "pending"}
  } finally {
    text.text = savedText
    text.horizontalOverflow = savedOverflow
  }
}

/**
 * Height the Text needs when its rect is `width` cm wide.
 * Empty content is a ready 0. A cache hit for this exact width costs nothing;
 * a cached height for a different width is never substituted. Otherwise one
 * attempt: rect swapped to `width × tall` with vertical overflow off, then
 * restored on every exit. Callers decide whether wrapping applies
 * (`horizontalOverflow === Wrap`); this measures with whatever mode is set.
 */
export function measureWrappedHeight(text: any, width: number): Measurement<number> {
  if (!text) return {status: "pending"}
  const content = typeof text.text === "string" ? text.text : ""
  if (content === "") return {status: "ready", value: 0}
  if (!(width > 0)) return {status: "pending"}

  const key = textMetricsKey(text)
  const entry = currentResults(text, key)
  const hit = entry.wrapped.get(width)
  if (hit !== undefined) return {status: "ready", value: hit}

  const savedRect = readRectCopy(text)
  if (!savedRect) return {status: "pending"}
  if (!claimAttempt(text)) return {status: "pending"}

  const savedVertical = text.verticalOverflow
  try {
    writeRect(text, -width * 0.5, width * 0.5, -MEASURE_RECT_HEIGHT * 0.5, MEASURE_RECT_HEIGHT * 0.5)
    if (savedVertical !== undefined) text.verticalOverflow = VerticalOverflow.Overflow
    const box = readBox(text)
    if (!box || (box.height <= 0 && content.trim() !== "")) return {status: "pending"}
    if (entry.wrapped.size >= WRAPPED_CACHE_WIDTHS) {
      const oldest = entry.wrapped.keys().next().value
      if (oldest !== undefined) entry.wrapped.delete(oldest)
    }
    entry.wrapped.set(width, box.height)
    return {status: "ready", value: box.height}
  } catch {
    return {status: "pending"}
  } finally {
    writeRect(text, savedRect.left, savedRect.right, savedRect.bottom, savedRect.top)
    if (savedVertical !== undefined) text.verticalOverflow = savedVertical
  }
}

/** True when this frame's single attempt for `text` has not been spent yet (no host call). */
export function canAttemptThisFrame(text: object): boolean {
  if (!text) return false
  const record = attempts.get(text)
  return !record || record.lastAttemptToken !== getFrameToken()
}

/**
 * Re-measures the natural size under the CURRENT key even though one is
 * cached — for metrics that finish resolving after a positive first
 * measurement (font load, TextStylePresets). Spends this frame's attempt.
 *
 * Drift is a KNOWN cached natural size moving past `tolerance`. Filling an
 * entry that had no natural size yet is not drift (nothing is known to have
 * changed) and is reported with `changed: false`. On drift the active entry's
 * natural is replaced, its dependent min-content / wrapped results are dropped,
 * and every OTHER result slot for this Text is dropped too: a second label
 * measured before the font settled carries the old metrics in its natural,
 * min-content, and wrapped results alike, and would otherwise commit at a
 * stale size the next time it is displayed. The Text's attempt record is
 * untouched, so switching to an invalidated label in the same frame reports
 * pending rather than spending another native attempt. Invalidation is local
 * to this Text; other Texts sharing the font are not assumed to have changed.
 * When nothing moved, every cache is kept, so a revalidation that finds
 * nothing costs one attempt and no re-layout. Pending when the attempt is
 * spent or refused.
 */
export function refreshNaturalSize(
  text: any,
  tolerance = 0.005
): {status: "ready"; value: TextSize; changed: boolean} | {status: "pending"} {
  if (!text) return {status: "pending"}
  const content = typeof text.text === "string" ? text.text : ""
  if (content === "") return {status: "ready", value: {width: 0, height: 0}, changed: false}
  const key = textMetricsKey(text)
  const entry = currentResults(text, key)
  if (!claimAttempt(text)) return {status: "pending"}

  const savedOverflow = text.horizontalOverflow
  try {
    text.horizontalOverflow = HorizontalOverflow.Overflow
    const box = readBox(text)
    if (!box || (box.width <= 0 && box.height <= 0 && content.trim() !== "")) return {status: "pending"}
    const previous = entry.natural
    const drifted =
      previous !== null &&
      (Math.abs(previous.width - box.width) > tolerance || Math.abs(previous.height - box.height) > tolerance)
    if (previous === null || drifted) {
      entry.natural = box
      entry.minWidth = longestWordRange(content) === null ? box.width : null
      entry.wrapped.clear()
      attemptRecord(text).lastKnownNatural = box
    }
    if (drifted) {
      // The glyph metrics moved: no other slot's results can be trusted.
      const slots = results.get(text)
      if (slots) {
        for (const otherKey of [...slots.keys()]) {
          if (otherKey !== key) slots.delete(otherKey)
        }
      }
    }
    return {status: "ready", value: entry.natural!, changed: drifted}
  } catch {
    return {status: "pending"}
  } finally {
    text.horizontalOverflow = savedOverflow
  }
}

/**
 * Drops every semantic result for `text` (natural, min-content, wrapped
 * heights). The frame allowance is NOT replenished: a caller that mutates the
 * Text and invalidates in the same frame the attempt was spent waits for the
 * next frame like everyone else. The `previous` fallback survives.
 */
export function invalidateTextMeasurements(text: object): void {
  if (!text) return
  results.delete(text)
}

/** True when a natural size is cached for the Text's CURRENT key (no host call). */
export function hasReadyNaturalSize(text: any): boolean {
  if (!text) return false
  const content = typeof text.text === "string" ? text.text : ""
  if (content === "") return true
  return getCachedNaturalSize(text) !== null
}

/** Current cached sample identity, or null; never measures or changes cache/attempt state. */
export function getCachedNaturalSize(text: any): TextSize | null {
  return text ? (results.get(text)?.get(textMetricsKey(text))?.natural ?? null) : null
}

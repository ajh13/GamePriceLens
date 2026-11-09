export type CursorIndex = number | undefined

/**
 * Fraction of a line's height that cursor Y from Text.getCursorPositions sits below the line's visual
 * center. Each caller scales it by the line height it has: the cursor height, or a highlight rect's height.
 * Everything that converts between cursor positions and visual positions shares it: CaretRenderer centers
 * the caret this fraction of its height above cursor Y, TextGeometryResolver picks lines by visual center,
 * TextInputArea scrolls to the caret's drawn bounds, and HighlightRenderer anchors handles this fraction of
 * a rect's height below its center, which GrabHandle adds back to center the handle on the rect.
 */
export const LINE_CENTER_OFFSET_RATIO = 0.25

export const SEPARATOR_REGEX = /[\s.,;:!?(){}[\]]/
const WHITESPACE_REGEX = /\s/

export function isSeparator(c: string): boolean {
  return SEPARATOR_REGEX.test(c)
}

/**
 * Gets the exact UTF-16 JS string index of a cursor position.
 * @param cursorIndex - The index in the cursor positions array
 * @param cursorPositions - The array of cursor positions
 * @param textString - The full text string
 * @returns The exact UTF-16 code unit index, or undefined if the cursor position is invalid
 */
export function getUtf16IndexFromCursorIndex(
  cursorIndex: number,
  cursorPositions: CursorPosition[],
  textString: string
): number | undefined {
  if (!cursorPositions || cursorPositions.length === 0) return undefined
  if (cursorIndex < 0 || cursorIndex >= cursorPositions.length) return undefined

  const cursorPositionIndex = cursorPositions[cursorIndex].index
  // Not a wrap cursor
  if (cursorPositionIndex !== 0) {
    return cursorPositionIndex
  }

  // It's a wrap cursor
  if (cursorIndex > 0) {
    // To find the true UTF-16 index of a wrap cursor, we look forward at the NEXT valid cursor.
    // We cannot look backward because Lens Studio omits trailing spaces at the end of wrapped lines.
    for (let i = cursorIndex + 1; i < cursorPositions.length; i++) {
      const nextIndex = cursorPositions[i].index
      if (nextIndex > 0) {
        // The wrap cursor sits immediately before the character ending at nextIndex.
        // We check if the character is a low surrogate (emoji) to accurately subtract code units.
        const charCode = textString.charCodeAt(nextIndex - 1)
        if (charCode >= 0xdc00 && charCode <= 0xdfff) {
          return nextIndex - 2
        }
        return nextIndex - 1
      }
    }
    // If we found no valid cursors ahead, the wrap cursor is at the very end of the string
    return textString.length
  }
  return 0
}

/**
 * Gets the closest cursor index for a given UTF-16 JS string index.
 * @param utf16Index - The UTF-16 string index to convert
 * @param cursorPositions - The array of cursor positions
 * @param textString - The full text string
 * @param isStart - Whether we are looking for the start boundary (affects line wrap preference)
 * @returns The closest index in the cursor positions array, or undefined if invalid
 */
export function getCursorIndexFromUtf16Index(
  utf16Index: number,
  cursorPositions: CursorPosition[],
  textString: string,
  isStart: boolean
): CursorIndex {
  if (!cursorPositions || cursorPositions.length === 0) return undefined

  let bestCaret = -1
  let cachedWrapIndex = -1

  for (let i = 0; i < cursorPositions.length; i++) {
    let cursorPositionIndex = cursorPositions[i].index

    // Clear cache if we hit a normal cursor
    if (cursorPositionIndex > 0) {
      cachedWrapIndex = -1
    }

    if (cursorPositionIndex === 0 && i > 0) {
      if (cachedWrapIndex !== -1) {
        cursorPositionIndex = cachedWrapIndex
      } else {
        cursorPositionIndex = getUtf16IndexFromCursorIndex(i, cursorPositions, textString) ?? 0
        cachedWrapIndex = cursorPositionIndex
      }
    }

    if (cursorPositionIndex === utf16Index) {
      if (bestCaret === -1 || isStart) {
        bestCaret = i
      }
    } else if (cursorPositionIndex > utf16Index) {
      if (bestCaret !== -1) {
        // We already found the exact matches, stop searching so we don't hit corrupted reset indices later in the array!
        break
      } else {
        // Safely snaps to the closest cursor boundary if an index falls inside an emoji
        return isStart ? Math.max(0, i - 1) : i
      }
    }
  }

  if (bestCaret === -1) {
    // Safely snap to the very last cursor position if utf16Index exceeds the maximum jsIndex
    // This happens because Lens Studio omits cursor positions for trailing spaces on wrapped lines
    return cursorPositions.length - 1
  }
  return bestCaret
}

export function trimOuterWhitespaceFromCursorRange(
  cursorStart: number,
  cursorEnd: number,
  cursorPositions: CursorPosition[],
  textString: string
): {cursorStart: number; cursorEnd: number} {
  if (!cursorPositions || cursorStart === cursorEnd) return {cursorStart, cursorEnd}

  let startCharIndex = getUtf16IndexFromCursorIndex(cursorStart, cursorPositions, textString)
  let endCharIndex = getUtf16IndexFromCursorIndex(cursorEnd, cursorPositions, textString)
  if (startCharIndex === undefined || endCharIndex === undefined) return {cursorStart, cursorEnd}

  const wasReversed = startCharIndex > endCharIndex
  if (wasReversed) {
    const temp = startCharIndex
    startCharIndex = endCharIndex
    endCharIndex = temp
  }

  let trimmedStartCharIndex = startCharIndex
  let trimmedEndCharIndex = endCharIndex

  while (trimmedStartCharIndex < trimmedEndCharIndex && isWhitespaceAt(textString, trimmedStartCharIndex)) {
    trimmedStartCharIndex++
  }

  while (trimmedEndCharIndex > trimmedStartCharIndex && isWhitespaceAt(textString, trimmedEndCharIndex - 1)) {
    trimmedEndCharIndex--
  }

  if (trimmedStartCharIndex === startCharIndex && trimmedEndCharIndex === endCharIndex) {
    return {cursorStart, cursorEnd}
  }

  if (trimmedStartCharIndex >= trimmedEndCharIndex) {
    return {cursorStart, cursorEnd}
  }

  const trimmedCursorStart = getCursorIndexFromUtf16Index(trimmedStartCharIndex, cursorPositions, textString, true)
  const trimmedCursorEnd = getCursorIndexFromUtf16Index(trimmedEndCharIndex, cursorPositions, textString, false)

  if (trimmedCursorStart === undefined || trimmedCursorEnd === undefined) {
    return {cursorStart, cursorEnd}
  }

  return wasReversed
    ? {cursorStart: trimmedCursorEnd, cursorEnd: trimmedCursorStart}
    : {cursorStart: trimmedCursorStart, cursorEnd: trimmedCursorEnd}
}

function isWhitespaceAt(textString: string, index: number): boolean {
  return WHITESPACE_REGEX.test(textString[index] ?? "")
}

/**
 * Trims leading whitespace from each line and adjusts caret position.
 * Required because the Text component's getCursorPositions() doesn't return
 * positions for leading whitespace on any line.
 *
 * @param text - The text to trim
 * @param charPos - The current caret position in the original text
 * @returns Object containing the trimmed text and adjusted char position
 */
export function trimLinesWithCaretAdjustment(text: string, charPos: number): {text: string; charPos: number} {
  const lines = text.split("\n")
  let trimmedCharPos = 0
  let currentPos = 0
  let isCaretAdjusted = false
  for (let i = 0; i < lines.length; i++) {
    const originalLine = lines[i]
    const trimmedLine = originalLine.trimStart()
    lines[i] = trimmedLine // Mutate the array in place to save memory
    const leadingSpaces = originalLine.length - trimmedLine.length
    const lineEnd = currentPos + originalLine.length
    if (!isCaretAdjusted && charPos <= lineEnd) {
      // Caret is on this line
      const posInLine = charPos - currentPos
      if (posInLine > leadingSpaces) {
        trimmedCharPos += posInLine - leadingSpaces
      }
      isCaretAdjusted = true
    } else if (!isCaretAdjusted) {
      // Move past this line (including newline char)
      trimmedCharPos += trimmedLine.length + 1
    }
    currentPos = lineEnd + 1
  }
  const trimmedText = lines.join("\n") // Use the mutated 'lines' array
  return {
    text: trimmedText,
    charPos: Math.max(0, Math.min(trimmedCharPos, trimmedText.length))
  }
}

/**
 * Checks if a caret index is at the beginning of a line.
 * @param index - The cursor index to check
 * @param cursorPositions - The array of cursor positions
 * @param text - The full text string
 * @returns True if the index is at the start of its line
 */
export function isAtLineStart(index: number, cursorPositions: CursorPosition[], text: string): boolean {
  if (!cursorPositions || index <= 0 || index >= cursorPositions.length) return false

  const currentPosData = cursorPositions[index]
  if (!currentPosData) return false

  // 1. Check if the current character is a line wrap point (Lens Studio uses index 0 for wrap cursors)
  if (currentPosData.index === 0) return true

  // 2. Check if the index is right after a newline character
  const utf16Index = getUtf16IndexFromCursorIndex(index, cursorPositions, text)
  if (utf16Index !== undefined && utf16Index > 0) {
    // text length check not strictly needed for >0 since it implies length >= 1
    if (text[utf16Index - 1] === "\n") return true
  }

  // 3. Fallback to visual Y-coordinate check
  const pos = currentPosData.position
  const prevPos = cursorPositions[index - 1]?.position
  if (!pos || !prevPos) return false

  return Math.abs(pos.y - prevPos.y) > 0.1
}

/**
 * Checks if a caret index is at the end of a line.
 * @param index - The cursor index to check
 * @param cursorPositions - The array of cursor positions
 * @param text - The full text string
 * @returns True if the index is at the end of its line
 */
export function isAtLineEnd(index: number, cursorPositions: CursorPosition[], text: string): boolean {
  if (!cursorPositions || index < 0 || index >= cursorPositions.length - 1) return false

  const nextPosData = cursorPositions[index + 1]
  if (!nextPosData) return false

  // 1. Check if the next character is a line wrap point (Lens Studio uses index 0 for wrap cursors)
  if (nextPosData.index === 0) return true

  // 2. Check if the current character is a newline
  const utf16Index = getUtf16IndexFromCursorIndex(index, cursorPositions, text)
  if (utf16Index !== undefined && utf16Index < text.length) {
    if (text[utf16Index] === "\n") return true
  }

  // 3. Fallback to visual Y-coordinate check
  const currentPosData = cursorPositions[index]
  const pos = currentPosData?.position
  const nextPos = nextPosData.position
  if (!pos || !nextPos) return false

  return Math.abs(pos.y - nextPos.y) > 0.1
}

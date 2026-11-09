import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import {KeyboardTrackingFocusFrameSource} from "../../FocusFrame/KeyboardTrackingFocusFrameSource"

const log = new NativeLogger("SystemKeyboardModule")

export type SystemKeyboardEditContext = Readonly<{
  /** UTF-16 range in the previous text that was replaced. */
  replacementStart: number
  replacementEnd: number
  /** Exact text spliced into the replacement range. */
  insertedText: string
}>

/** A no-change callback classification that the keyboard bridge has proven authoritatively. */
export type SystemKeyboardEditDisposition = "compositionEcho" | "emptyCollapsedNoOp"

export interface SystemKeyboardDelegate {
  onKeyboardStateChangedHandler(isOpen: boolean): void
  onSetSelectionHandler(start: number, end: number): void
  onTextChangedHandler(
    text: string,
    selectionStart?: number,
    selectionEnd?: number,
    editContext?: SystemKeyboardEditContext,
    editDisposition?: SystemKeyboardEditDisposition
  ): void
  onReturnKeyPressedHandler(): void
  readonly text: string
}

export class SystemKeyboardModule {
  /**
   * Whether this bridge believes its keyboard session is open. Set by requestKeyboard and by the engine's own
   * open callback, cleared by dismissKeyboard and by the engine's close callback. Two consumers: the state report
   * (nothing is reported to a closed session) and dismissKeyboard, which is a no-op while closed, so a field whose
   * session the engine already ended cannot dismiss the keyboard out from under whichever field owns it now, and,
   * inside a stale-close window, a real dismiss is skipped until the next open re-asserts the flag. An open can
   * only re-assert a session this bridge requested and has not dismissed (see sessionRequested).
   */
  private isKeyboardOpen: boolean = false
  /**
   * Bridge-side intent, as opposed to the engine-reported state above: set by requestKeyboard, cleared by every
   * explicit dismissKeyboard, including one the engine's own close has already made a native no-op. The engine's
   * close leaves it set so its following open can heal a stale close; a dismiss clears it so a stale or delayed
   * open cannot reopen a session this field already gave up.
   */
  private sessionRequested: boolean = false
  /**
   * Incremented by every requestKeyboard, so a callback can tell whether the delegate re-requested the keyboard
   * while it was being forwarded and must not have that new session closed by the cleanup for the old one.
   */
  private sessionGeneration: number = 0
  private isComposing: boolean = false
  /** True only while the active composing region contains text this bridge applied. */
  private hasAppliedComposingText: boolean = false
  /**
   * Armed by onBeginBatchEdit and cleared by the next legacy onTextChanged, which on the AR-keyboard path is the
   * echo of the batch just applied. Independent of onEndBatchEdit because the echo lands after the batch has
   * ended and must still be discarded, or it would be applied as a wholesale replacement and reset the
   * composition. A single boolean: it cannot tell a lagging echo from the next one, and after an echo-less
   * batch it swallows one genuine legacy callback. Both are pre-existing limits of this heuristic.
   */
  private expectingBatchEditEcho: boolean = false
  /**
   * Nesting depth of the engine's batch edit session, clamped at zero. Editors may not send updates while it is
   * above zero. A counter rather than a boolean because the InputConnection contract this mirrors nests batch
   * edits, and a boolean would report inside an open outer batch at the first inner end; the counter's own
   * failure, a dropped end deferring reports for the rest of the session, is bounded by the resets in
   * dismissKeyboard and requestKeyboard.
   */
  private batchEditDepth: number = 0
  /** A commit applied inside a batch edit (or while composing) still owes the engine its state report. */
  private hasPendingCommitReport: boolean = false
  /**
   * The text the report describes: the bridge's most recent splice, or the last state pushed by the field. The
   * report goes out while the delegate holds text of the same length: a same-length normalization keeps the splice's
   * indices valid (TextInputField's own contract), so the delegate's text is what gets reported; a length change
   * means the subclass owns that resync itself and the report is abandoned.
   */
  private lastSpliceText: string | null = null
  /**
   * The selection the report describes, kept as the newest information about it: a splice records its collapsed
   * caret, and anything the field asserts afterwards (a highlight drag, an accepted selection, a field-side push)
   * overwrites it, while a delegate that declines a splice caret leaves the splice caret standing. Not the raw
   * selection cache, which the delegate may decline to refresh.
   */
  private reportSelectionStart: number = 0
  private reportSelectionEnd: number = 0
  /**
   * True from the first setComposingText received outside a batch edit until the next commit: a speech-to-text
   * style episode whose first payload composes over the current selection rather than over a composing region
   * left behind by earlier typing (see onSetComposingText).
   */
  private isProcessingSTT: boolean = false

  private readonly _selectionRange: vec2 = vec2.zero()
  private readonly composingRegion: vec2 = new vec2(-1, -1)

  private readonly keyboardOptions = new TextInputSystem.KeyboardOptions()

  /**
   * Gets the native keyboard layout type used for future keyboard requests.
   * @returns The configured keyboard type.
   */
  public get keyboardType(): TextInputSystem.KeyboardType {
    return this.keyboardOptions.keyboardType
  }

  /**
   * Sets the native keyboard layout type used for future keyboard requests.
   * @param keyboardType - The keyboard type to use.
   */
  public set keyboardType(keyboardType: TextInputSystem.KeyboardType) {
    this.keyboardOptions.keyboardType = keyboardType
  }

  /**
   * Gets the native return key type used for future keyboard requests.
   * @returns The configured return key type.
   */
  public get returnKeyType(): TextInputSystem.ReturnKeyType {
    return this.keyboardOptions.returnKeyType
  }

  /**
   * Sets the native return key type used for future keyboard requests.
   * @param returnKeyType - The return key type to use.
   */
  public set returnKeyType(returnKeyType: TextInputSystem.ReturnKeyType) {
    this.keyboardOptions.returnKeyType = returnKeyType
  }

  /**
   * Current selection start in UTF-16 character units.
   * Exposed as a primitive so external callers cannot mutate the underlying `vec2`.
   */
  public get selectionStart(): number {
    return this._selectionRange.x
  }

  /**
   * Current selection end in UTF-16 character units.
   * Exposed as a primitive so external callers cannot mutate the underlying `vec2`.
   */
  public get selectionEnd(): number {
    return this._selectionRange.y
  }

  /**
   * Updates the cached selection range without notifying the system keyboard.
   *
   * Use this when the engine is the authoritative source of the change (e.g. the
   * engine invoked `onSetSelection` / `onUpdateText`), so pushing back would be
   * either redundant or cause a feedback loop. For selection changes originating
   * on our side (caret moved, highlight dragged), use {@link updateSelectionRange}
   * instead, which also calls `setSelectedTextRange` on the engine.
   */
  public set selectionRange(range: {start: number; end: number}) {
    this._selectionRange.x = range.start
    this._selectionRange.y = range.end
    this.recordReportSelection(range.start, range.end)
  }

  /**
   * Creates a keyboard bridge for a text input delegate.
   * @param keyboardType - Initial native keyboard layout type.
   * @param returnKeyType - Initial native return key type.
   * @param delegate - Object that receives keyboard state, selection, text, and return-key callbacks.
   */
  public constructor(
    keyboardType: TextInputSystem.KeyboardType,
    returnKeyType: TextInputSystem.ReturnKeyType,
    private delegate: SystemKeyboardDelegate
  ) {
    this.keyboardOptions.keyboardType = keyboardType
    this.keyboardOptions.returnKeyType = returnKeyType
    this.keyboardOptions.enablePreview = false

    this.setupCallbacks()
  }

  private setupCallbacks(): void {
    this.keyboardOptions.onKeyboardStateChanged = (isOpen: boolean) => {
      if (isOpen && this.sessionRequested) {
        // Re-asserted BEFORE forwarding, so a dismissal the delegate performs while handling the open wins, and
        // only for a session this bridge requested and has not dismissed, so a stale open cannot reopen one. A
        // close from a previous session can land after this field re-requested the keyboard; the new session's
        // own open then heals the flag here. (A close arriving after that open would stick until the next
        // request; the callbacks carry no session identity to tell the two apart.)
        this.isKeyboardOpen = true
      }
      const generationBeforeForwarding = this.sessionGeneration
      this.delegate.onKeyboardStateChangedHandler(isOpen)
      if (!isOpen && this.sessionGeneration === generationBeforeForwarding) {
        // Forwarded first so a delegate that dismisses in response runs its normal dismiss path; the session is
        // then closed here regardless, so the report guard (and dismissKeyboard, which shares the flag; see
        // isKeyboardOpen) does not depend on the delegate doing so. Unless the delegate re-requested the keyboard
        // while handling the close: that new session must not be closed by the cleanup for the old one.
        this.closeSession()
      }
    }

    this.keyboardOptions.onError = (code: number, description: string) => {
      log.e(`Keyboard engine error ${code}: ${description}`)
    }

    this.keyboardOptions.onSetSelection = (start: number, end: number) => {
      this.delegate.onSetSelectionHandler(start, end)
      // A selection update (often the engine's own post-commit echo) is a free chance to retry a rejected report.
      this.flushPendingReportOutsideBatch()
    }

    this.keyboardOptions.onSetComposingRegion = (start: number, end: number) => {
      this.handleSetComposingRegion(start, end)
      // Clearing the region ends the composition; a report owed from earlier in it can go out now.
      this.flushPendingReportOutsideBatch()
    }

    // Delta (incremental) text updates.
    this.keyboardOptions.onSetComposingText = (text: string, newCursorPosition: number) => {
      // Outside a batch edit (speech-to-text) the engine does not re-declare the composing region, so the
      // first payload of an episode composes over the current selection instead of a stale region. "Outside"
      // keeps the legacy meaning: not between begin and end, and not before the batch's echo has landed.
      if (this.batchEditDepth === 0 && !this.expectingBatchEditEcho && !this.isProcessingSTT) {
        this.isProcessingSTT = true
        if (this.isComposing) {
          this.hasAppliedComposingText =
            this.hasAppliedComposingText &&
            this.composingRegion.x === this._selectionRange.x &&
            this.composingRegion.y === this._selectionRange.y
          this.composingRegion.x = this._selectionRange.x
          this.composingRegion.y = this._selectionRange.y
        }
      }

      this.handleSetComposingText(text, newCursorPosition)
      // An empty payload ends the composition; a report owed from earlier in it can go out now.
      this.flushPendingReportOutsideBatch()
    }

    this.keyboardOptions.onBeginBatchEdit = () => {
      this.batchEditDepth++
      this.expectingBatchEditEcho = true
    }

    // Editors may not send updates while a batch edit is open; a commit applied inside the batch is reported
    // once the outermost batch ends. An end at depth zero still attempts the flush, so a report stranded at any
    // earlier point goes out here too.
    this.keyboardOptions.onEndBatchEdit = () => {
      this.batchEditDepth = Math.max(0, this.batchEditDepth - 1)
      this.flushPendingReportOutsideBatch()
    }

    // TODO: Remove the echo discard and this legacy onTextChanged handler once the mobile keyboard
    // supports the batch-edit API.
    this.keyboardOptions.onTextChanged = (text: string, range: vec2) => {
      if (this.expectingBatchEditEcho) {
        // AR virtual keyboard already applied changes via batch edit API; discard the post-batch echo.
        this.expectingBatchEditEcho = false
        return
      }

      // Paired-phone keyboard path: the legacy API emits onTextChanged with a wholesale string and selection range.
      // Reset composing region since this is a full replacement, not an incremental edit.
      const previousText = this.delegate.text
      const previousSelectionStart = this._selectionRange.x
      const previousSelectionEnd = this._selectionRange.y
      this.resetCompositionProvenance()

      const selectionRange = this.resolveTextChangedSelectionRange(text, range)
      const editContext =
        this.detectLegacySingleCodePointInsertion(previousText, text, range) ??
        this.detectLegacySingleCodePointReplacement(
          previousText,
          text,
          range,
          previousSelectionStart,
          previousSelectionEnd
        )

      this.delegate.onTextChangedHandler(text, selectionRange.start, selectionRange.end, editContext)

      // Push the latest state back to the keyboard so it stays consistent with what the delegate now holds.
      this.updateText(text, selectionRange.start, selectionRange.end)
    }

    // "Insert this string at the current cursor position (and clear any composing region)."
    this.keyboardOptions.onCommitText = (text: string, newCursorPosition: number) => {
      this.handleSetComposingText(text, newCursorPosition)
      this.resetCompositionProvenance()
      this.isProcessingSTT = false
      // A commit ends the engine's composition, so the editor reports its committed text and caret back.
      this.reportCommittedSplice()
    }

    this.keyboardOptions.onPerformEditorAction = (action: number) => {
      this.handlePerformEditorAction(action)
      // An editor action often ends an episode with no later commit, so retry a rejected report here too. For a
      // newline that follows a still-owed commit, that report then already includes the newline.
      this.flushPendingReportOutsideBatch()
    }

    // Pushing full text state updates
    // Pasting large blocks of text
    this.keyboardOptions.onUpdateText = (updateText: TextInputSystem.TextUpdate) => {
      const text = updateText.text
      const selectionStart = updateText.selectionStart
      const selectionEnd = updateText.selectionEnd

      const textChanged = text !== undefined && text !== this.delegate.text
      const selectionChanged = selectionStart !== undefined && selectionEnd !== undefined

      if (text !== undefined) {
        // The engine has just asserted the full text itself, so nothing is owed to it from earlier commits and
        // no splice is outstanding.
        this.hasPendingCommitReport = false
        this.lastSpliceText = null
      }
      if (textChanged) {
        // Cold reset: engine pushed the full editor state, so any composing region we were tracking is gone.
        this.resetCompositionProvenance()
        // Updates text and optionally range if provided
        this.delegate.onTextChangedHandler(
          text,
          selectionChanged ? selectionStart : undefined,
          selectionChanged ? selectionEnd : undefined
        )
      } else if (selectionChanged) {
        // If only the selection changed (e.g. user tapped elsewhere in the text box)
        this.delegate.onSetSelectionHandler(selectionStart, selectionEnd)
      }
    }
    this.keyboardOptions.onReturnKeyPressed = () => {
      if (this.keyboardOptions.returnKeyType !== TextInputSystem.ReturnKeyType.Return) {
        this.delegate.onReturnKeyPressedHandler()
      }
    }

    // Install focus-frame keyboard-tracking callbacks on the same options. Inert until the
    // TextInputSystem keyboard-tracking bindings land in the build; guarded so it can't error.
    KeyboardTrackingFocusFrameSource.getInstance().attachTo(this.keyboardOptions)
  }

  private resolveTextChangedSelectionRange(text: string, range: vec2): {start: number; end: number} {
    if (
      range !== undefined &&
      Number.isFinite(range.x) &&
      Number.isFinite(range.y) &&
      range.x >= 0 &&
      range.y >= 0 &&
      range.x <= text.length &&
      range.y <= text.length
    ) {
      return {start: range.x, end: range.y}
    }

    return {start: text.length, end: text.length}
  }

  /**
   * Recovers provenance only for a legacy key callback that is independently provable as one
   * Unicode-code-point insertion immediately before its collapsed post-caret. This restores normal
   * Preview/mobile typing without trusting cached pre-edit selection or guessing at ambiguous
   * replacement/paste snapshots.
   */
  private detectLegacySingleCodePointInsertion(
    previousText: string,
    nextText: string,
    range: vec2
  ): SystemKeyboardEditContext | undefined {
    if (
      range === undefined ||
      !Number.isInteger(range.x) ||
      !Number.isInteger(range.y) ||
      range.x !== range.y ||
      range.x <= 0 ||
      range.x > nextText.length
    ) {
      return undefined
    }

    const insertedEnd = range.x
    let insertedStart = insertedEnd - 1
    const trailingCodeUnit = nextText.charCodeAt(insertedStart)
    const isLowSurrogate = trailingCodeUnit >= 0xdc00 && trailingCodeUnit <= 0xdfff
    if (isLowSurrogate) {
      if (insertedStart === 0) return undefined
      const leadingCodeUnit = nextText.charCodeAt(insertedStart - 1)
      if (leadingCodeUnit < 0xd800 || leadingCodeUnit > 0xdbff) return undefined
      insertedStart--
    } else if (trailingCodeUnit >= 0xd800 && trailingCodeUnit <= 0xdbff) {
      return undefined
    }

    if (nextText.slice(0, insertedStart) + nextText.slice(insertedEnd) !== previousText) {
      return undefined
    }

    return {
      replacementStart: insertedStart,
      replacementEnd: insertedStart,
      insertedText: nextText.slice(insertedStart, insertedEnd)
    }
  }

  /**
   * Recovers a conservative subset of legacy selected replacements. The callback exposes only a
   * whole-text snapshot and post-edit selection, so cached selection is accepted only when it
   * exactly matches the minimal text diff. Requiring one code point that was absent from the
   * replaced slice prevents a contraction from exposing retained password content while still
   * allowing the same character elsewhere in the password.
   */
  private detectLegacySingleCodePointReplacement(
    previousText: string,
    nextText: string,
    range: vec2,
    previousSelectionStart: number,
    previousSelectionEnd: number
  ): SystemKeyboardEditContext | undefined {
    if (
      range === undefined ||
      !Number.isInteger(range.x) ||
      !Number.isInteger(range.y) ||
      range.x !== range.y ||
      !Number.isInteger(previousSelectionStart) ||
      !Number.isInteger(previousSelectionEnd)
    ) {
      return undefined
    }

    const replacementStart = Math.min(previousSelectionStart, previousSelectionEnd)
    const replacementEnd = Math.max(previousSelectionStart, previousSelectionEnd)
    if (replacementStart < 0 || replacementEnd > previousText.length || replacementStart === replacementEnd) {
      return undefined
    }

    const commonPrefixLength = this.getCommonCodePointPrefixLength(previousText, nextText)
    const commonSuffixLength = this.getCommonCodePointSuffixLength(previousText, nextText, commonPrefixLength)

    const previousDiffEnd = previousText.length - commonSuffixLength
    const nextDiffEnd = nextText.length - commonSuffixLength
    if (commonPrefixLength !== replacementStart || previousDiffEnd !== replacementEnd || nextDiffEnd !== range.x) {
      return undefined
    }

    const insertedText = nextText.slice(commonPrefixLength, nextDiffEnd)
    const replacedText = previousText.slice(replacementStart, replacementEnd)
    if (!this.isSingleUnicodeCodePoint(insertedText) || replacedText.includes(insertedText)) {
      return undefined
    }

    return {replacementStart, replacementEnd, insertedText}
  }

  private getCommonCodePointPrefixLength(firstText: string, secondText: string): number {
    let offset = 0
    while (offset < firstText.length && offset < secondText.length) {
      const firstCodePoint = firstText.codePointAt(offset)
      if (firstCodePoint === undefined || firstCodePoint !== secondText.codePointAt(offset)) break
      offset += firstCodePoint > 0xffff ? 2 : 1
    }
    return offset
  }

  private getCommonCodePointSuffixLength(firstText: string, secondText: string, commonPrefixLength: number): number {
    let firstEnd = firstText.length
    let secondEnd = secondText.length
    while (firstEnd > commonPrefixLength && secondEnd > commonPrefixLength) {
      const firstStart = this.getPreviousCodePointStart(firstText, firstEnd)
      const secondStart = this.getPreviousCodePointStart(secondText, secondEnd)
      if (firstStart < commonPrefixLength || secondStart < commonPrefixLength) break
      if (firstText.slice(firstStart, firstEnd) !== secondText.slice(secondStart, secondEnd)) break
      firstEnd = firstStart
      secondEnd = secondStart
    }
    return firstText.length - firstEnd
  }

  private getPreviousCodePointStart(text: string, end: number): number {
    let start = end - 1
    const trailingCodeUnit = text.charCodeAt(start)
    if (start > 0 && trailingCodeUnit >= 0xdc00 && trailingCodeUnit <= 0xdfff) {
      const leadingCodeUnit = text.charCodeAt(start - 1)
      if (leadingCodeUnit >= 0xd800 && leadingCodeUnit <= 0xdbff) start--
    }
    return start
  }

  private isSingleUnicodeCodePoint(text: string): boolean {
    if (text.length === 1) {
      const codeUnit = text.charCodeAt(0)
      return codeUnit < 0xd800 || codeUnit > 0xdfff
    }
    if (text.length !== 2) return false

    const leadingCodeUnit = text.charCodeAt(0)
    const trailingCodeUnit = text.charCodeAt(1)
    return (
      leadingCodeUnit >= 0xd800 && leadingCodeUnit <= 0xdbff && trailingCodeUnit >= 0xdc00 && trailingCodeUnit <= 0xdfff
    )
  }

  private getUniqueSingleCodePointInsertion(
    previousText: string,
    nextText: string
  ): SystemKeyboardEditContext | undefined {
    if (nextText.length <= previousText.length) return undefined

    let insertion: SystemKeyboardEditContext | undefined
    let start = 0
    while (start < nextText.length) {
      const codePoint = nextText.codePointAt(start)
      if (codePoint === undefined) return undefined
      const end = start + (codePoint > 0xffff ? 2 : 1)
      const insertedText = nextText.slice(start, end)

      if (
        this.isSingleUnicodeCodePoint(insertedText) &&
        nextText.slice(0, start) + nextText.slice(end) === previousText
      ) {
        // Repeated characters can make the insertion position ambiguous. Without a unique range,
        // keep the composition context-free rather than claiming provenance for retained text.
        if (insertion) return undefined
        insertion = {replacementStart: start, replacementEnd: start, insertedText}
      }
      start = end
    }

    return insertion
  }

  private handleSetComposingRegion(start: number, end: number): void {
    if (start === -1 || end === -1 || start === end) {
      this.isComposing = false
      this.hasAppliedComposingText = false
    } else {
      const normalizedStart = Math.min(start, end)
      const normalizedEnd = Math.max(start, end)
      this.hasAppliedComposingText =
        this.isComposing &&
        this.hasAppliedComposingText &&
        this.composingRegion.x === normalizedStart &&
        this.composingRegion.y === normalizedEnd
      this.isComposing = true
      // Ensure x is min and y is max
      this.composingRegion.x = normalizedStart
      this.composingRegion.y = normalizedEnd
    }
  }

  private handleSetComposingText(textToInsert: string, newCursorPosition: number): void {
    let start: number
    let end: number

    if (this.isComposing) {
      start = this.composingRegion.x
      end = this.composingRegion.y
    } else {
      start = Math.min(this._selectionRange.x, this._selectionRange.y)
      end = Math.max(this._selectionRange.x, this._selectionRange.y)
      // Replace the whole selection. TODO: verify — this runtime appears not to pre-declare
      // a composing region before a selection-replacing edit, so the range is derived here
      // rather than trusting one to have been set.
    }

    // 1. Splice the new text. Derive the context indices from the actual substring pieces so even
    // malformed native ranges use the same normalized UTF-16 offsets as the resulting text.
    const previousText = this.delegate.text
    const prefix = previousText.substring(0, start)
    const suffix = previousText.substring(end)
    const replacementStart = prefix.length
    const replacementEnd = previousText.length - suffix.length
    const newText = prefix + textToInsert + suffix
    // While a composing region is active, its current content is the value this payload replaces —
    // whether this bridge applied it or the engine declared the region over existing text. Treating
    // it as the prior composing value means a recomposition of committed text can only ever attach
    // provenance through the conservative replacement, echo, or insertion proofs below.
    const previousComposingText = this.isComposing ? previousText.slice(replacementStart, replacementEnd) : null

    // 2. Calculate new absolute cursor position (Android InputConnection semantics)
    const composingEnd = start + textToInsert.length
    let absoluteCursorPos: number
    if (newCursorPosition > 0) {
      absoluteCursorPos = composingEnd + newCursorPosition - 1
    } else {
      absoluteCursorPos = start + newCursorPosition
    }
    absoluteCursorPos = Math.max(0, Math.min(absoluteCursorPos, newText.length))
    this.lastSpliceText = newText
    this.recordReportSelection(absoluteCursorPos, absoluteCursorPos)

    // 3. Apply the changes. Android permits the post-caret to land outside the inserted span, so
    // carry the authoritative splice separately. Proven same-text echoes and collapsed no-ops carry
    // an explicit disposition so ambiguous whole-text snapshots remain distinguishable.
    const isCompositionEcho = this.hasAppliedComposingText && previousComposingText !== null && newText === previousText
    const isEmptyCollapsedNoOp = replacementStart === replacementEnd && textToInsert.length === 0
    if (isCompositionEcho || isEmptyCollapsedNoOp) {
      const editDisposition: SystemKeyboardEditDisposition = isCompositionEcho
        ? "compositionEcho"
        : "emptyCollapsedNoOp"
      this.delegate.onTextChangedHandler(newText, absoluteCursorPos, absoluteCursorPos, undefined, editDisposition)
    } else if (previousComposingText === null) {
      // A non-composing insert or commit authoritatively replaces the selection with exactly this
      // payload.
      this.delegate.onTextChangedHandler(newText, absoluteCursorPos, absoluteCursorPos, {
        replacementStart,
        replacementEnd,
        insertedText: textToInsert
      })
    } else if (
      !this.hasAppliedComposingText &&
      replacementStart < replacementEnd &&
      this.isSingleUnicodeCodePoint(textToInsert) &&
      !previousComposingText.includes(textToInsert)
    ) {
      // The first payload over a newly declared nonempty region can prove a one-code-point
      // replacement only when that value cannot have been retained from the replaced region.
      this.delegate.onTextChangedHandler(newText, absoluteCursorPos, absoluteCursorPos, {
        replacementStart,
        replacementEnd,
        insertedText: textToInsert
      })
    } else if (textToInsert.length > previousComposingText.length && textToInsert.startsWith(previousComposingText)) {
      // Composition callbacks carry the entire composing value. A strict suffix extension proves
      // its new delta; contractions and rewrites must not expose retained text.
      this.delegate.onTextChangedHandler(newText, absoluteCursorPos, absoluteCursorPos, {
        replacementStart: replacementEnd,
        replacementEnd,
        insertedText: textToInsert.slice(previousComposingText.length)
      })
    } else {
      // Once this bridge has applied the prior composing value, a unique single-code-point splice
      // anywhere inside that value is also authoritative. Ambiguous insertions, contractions, and
      // rewrites remain context-free.
      const composingInsertion = this.hasAppliedComposingText
        ? this.getUniqueSingleCodePointInsertion(previousComposingText, textToInsert)
        : undefined
      this.delegate.onTextChangedHandler(
        newText,
        absoluteCursorPos,
        absoluteCursorPos,
        composingInsertion
          ? {
              replacementStart: replacementStart + composingInsertion.replacementStart,
              replacementEnd: replacementStart + composingInsertion.replacementEnd,
              insertedText: composingInsertion.insertedText
            }
          : undefined
      )
    }

    // 4. Update the composing region bounds
    if (textToInsert.length > 0) {
      this.isComposing = true
      this.hasAppliedComposingText = this.delegate.text === newText
      this.composingRegion.x = start
      this.composingRegion.y = start + textToInsert.length
    } else {
      this.isComposing = false
      this.hasAppliedComposingText = false
    }
  }

  private handlePerformEditorAction(action: number): void {
    if (action === TextInputSystem.TextFieldAction.NewLine) {
      const min = Math.min(this._selectionRange.x, this._selectionRange.y)
      const max = Math.max(this._selectionRange.x, this._selectionRange.y)

      // Splice the newline into the text at the current selection range
      const newText = this.delegate.text.substring(0, min) + "\n" + this.delegate.text.substring(max)
      const newStart = min + 1
      const newEnd = min + 1

      // Record the splice so a commit report deferred across this newline describes the text as it now is
      // instead of being abandoned as a divergence at the batch end. The newline itself is not reported here.
      this.lastSpliceText = newText
      this.recordReportSelection(newStart, newEnd)
      // One call updates text, updates range, invokes typingEvent, flags dirty, and triggers batchUpdate
      this.delegate.onTextChangedHandler(newText, newStart, newEnd)
    } else {
      this.delegate.onReturnKeyPressedHandler()
    }
  }

  /**
   * Reports a just-applied commit to the engine: immediately when no batch edit is open, otherwise deferred to
   * onEndBatchEdit, because editors may not send updates while a batch is open.
   */
  private reportCommittedSplice(): void {
    // Record the debt first: the report keeps it while composing or when the push is rejected, and clears it
    // when it goes out or is abandoned.
    this.hasPendingCommitReport = true
    if (this.batchEditDepth === 0) {
      this.reportCommittedStateToEngine()
    }
  }

  /** Flushes an owed report while no batch is open; called from every callback that can follow a rejected push. */
  private flushPendingReportOutsideBatch(): void {
    if (this.batchEditDepth > 0 || !this.hasPendingCommitReport) return
    this.reportCommittedStateToEngine()
  }

  /**
   * Reports the delegate's committed text and the newest known selection (see lastSpliceText and
   * reportSelectionStart) to the keyboard engine so its context matches what the editor now holds. Skipped while
   * a composing region is active: a text update is a whole-state resync, and sending one mid-composition would
   * make the engine drop the composition it still owns. The pending flag is consumed when a report goes out or
   * when the debt is abandoned: the session was dismissed (the engine may already be serving another field), no
   * splice is recorded, or the delegate holds text of a different length than the splice because a subclass
   * changed it and owns that resync itself (a same-length normalization is reported as the delegate's text). Only
   * a live composition and a rejected push keep it owed, to be flushed by
   * whatever ends the composition or by the next flush opportunity: a batch end, a composition callback, a
   * selection update from the engine, or an editor action. There is no timer behind that: a push rejected with
   * none of those to follow stays owed until the next one arrives. The report
   * writes the selection back so the cache re-converges with the text the bridge is actually splicing against.
   */
  private reportCommittedStateToEngine(): void {
    if (this.isComposing) return
    if (!this.isKeyboardOpen || this.lastSpliceText === null) {
      this.hasPendingCommitReport = false
      return
    }

    const text = this.delegate.text
    if (text.length !== this.lastSpliceText.length) {
      this.hasPendingCommitReport = false
      return
    }

    const selection = this.toReportableSelection(this.reportSelectionStart, this.reportSelectionEnd, text)
    // A rejected push keeps the debt visible so the next flush opportunity, if one arrives, retries it.
    this.hasPendingCommitReport = !this.updateText(text, selection.start, selection.end)
  }

  /** Notes the newest known editor selection for the next report (see reportSelectionStart). */
  private recordReportSelection(start: number, end: number): void {
    this.reportSelectionStart = start
    this.reportSelectionEnd = end
  }

  /**
   * Normalizes a selection for an outgoing report. A range with a non-finite or non-integer end is treated as
   * corrupt as a whole and falls back to a collapsed caret at the end of the text, the convention
   * resolveTextChangedSelectionRange uses for an invalid incoming range, rather than pairing the surviving end
   * with the text end into a highlight nobody asked for. A valid range is ordered and clamped, and an end inside
   * a surrogate pair snaps outward, the start before the pair and the end after it, while a collapsed caret
   * snaps after the pair like a collapsed caret elsewhere.
   */
  private toReportableSelection(start: number, end: number, text: string): {start: number; end: number} {
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      return {start: text.length, end: text.length}
    }
    const clamp = (index: number): number => Math.max(0, Math.min(index, text.length))
    const splitsSurrogatePair = (index: number): boolean =>
      index > 0 &&
      index < text.length &&
      text.charCodeAt(index) >= 0xdc00 &&
      text.charCodeAt(index) <= 0xdfff &&
      text.charCodeAt(index - 1) >= 0xd800 &&
      text.charCodeAt(index - 1) <= 0xdbff

    const orderedStart = clamp(Math.min(start, end))
    const orderedEnd = clamp(Math.max(start, end))
    if (orderedStart === orderedEnd) {
      const caret = splitsSurrogatePair(orderedStart) ? orderedStart + 1 : orderedStart
      return {start: caret, end: caret}
    }
    return {
      start: splitsSurrogatePair(orderedStart) ? orderedStart - 1 : orderedStart,
      end: splitsSurrogatePair(orderedEnd) ? orderedEnd + 1 : orderedEnd
    }
  }

  /**
   * Opens the native system keyboard with the provided text and selection state.
   * @param initialText - Text to seed into the keyboard field.
   * @param selectionStart - Initial selection start in UTF-16 character units.
   * @param selectionEnd - Initial selection end in UTF-16 character units.
   */
  public requestKeyboard(initialText: string = "", selectionStart: number = 0, selectionEnd: number = 0): void {
    this.resetCompositionProvenance()
    // A new session cannot inherit an open batch edit, a pending commit report, or a splice to report.
    // expectingBatchEditEcho is deliberately left alone. This bridge is per field, so an armed flag can only
    // swallow this field's own next legacy text callback: a late echo from its previous session, which is
    // redundant, or after an echo-less batch one genuine phone-keyboard keystroke, a pre-existing limit of
    // the boolean. Resetting it would instead apply that stale echo as a wholesale replacement of whatever
    // text this field holds now.
    // isProcessingSTT is also left alone: it is per composition episode and is cleared by the next commit, as
    // before this change; a stale episode flag only skips one selection re-anchor in favor of a region the
    // engine declared.
    this.batchEditDepth = 0
    this.hasPendingCommitReport = false
    this.lastSpliceText = null
    this.recordReportSelection(selectionStart, selectionEnd)
    this.keyboardOptions.initialText = initialText
    this._selectionRange.x = selectionStart
    this._selectionRange.y = selectionEnd
    this.keyboardOptions.initialSelectedRange = this._selectionRange
    // Mark this options as the active focus-frame session so its tracking callbacks are the
    // ones honored (stale callbacks from a previously-open field are ignored).
    KeyboardTrackingFocusFrameSource.getInstance().activate(this.keyboardOptions)
    global.textInputSystem.requestKeyboard(this.keyboardOptions)
    this.isKeyboardOpen = true
    this.sessionRequested = true
    this.sessionGeneration++
  }

  /**
   * Dismisses the native system keyboard if it is currently open.
   */
  public dismissKeyboard(): void {
    // An explicit dismissal always withdraws the request, even when the engine's own close already marked the
    // session closed, so a delayed open cannot reopen it. Only the native call depends on the flag.
    this.sessionRequested = false
    if (!this.isKeyboardOpen) return
    global.textInputSystem.dismissKeyboard()
    this.closeSession()
    // Focus-frame disable is driven by the platform keyboard-tracking kind change (leaving
    // AR), NOT by our dismiss — a field switch dismisses and re-requests the keyboard, and
    // synthesizing a disable here would bounce the panel home mid-switch.
  }

  /**
   * Marks the session closed and drops what was owed to it: nothing may be reported to a closed session (the
   * engine may soon serve another field), and a late batch end must not carry state into the next session.
   * Composition state is deliberately kept: an engine that commits its composing text as the session closes
   * delivers that commit after the close, and splicing it against the tracked region replaces the composed text,
   * whereas a reset region would insert it at the caret and duplicate the word. requestKeyboard resets it.
   */
  private closeSession(): void {
    this.isKeyboardOpen = false
    this.batchEditDepth = 0
    this.hasPendingCommitReport = false
    this.lastSpliceText = null
  }

  /**
   * Pushes the authoritative text and selection range to the keyboard engine.
   * @param text - Current text content.
   * @param selectionStart - Selection start in UTF-16 character units.
   * @param selectionEnd - Selection end in UTF-16 character units.
   * @returns Whether the host call completed without throwing (e.g. a per-frame rate limit). This says nothing
   * about how the engine applied the update. On failure the cached selection is left unchanged. A successful
   * push records the editor's last applied state and, outside a batch edit, settles any report still owed.
   */
  public updateText(text: string, selectionStart: number, selectionEnd: number): boolean {
    try {
      const updateText = new TextInputSystem.TextUpdate()
      updateText.text = text
      updateText.selectionStart = selectionStart
      updateText.selectionEnd = selectionEnd
      global.textInputSystem.updateText(updateText)
      this._selectionRange.x = selectionStart
      this._selectionRange.y = selectionEnd
      this.lastSpliceText = text
      this.recordReportSelection(selectionStart, selectionEnd)
      // Inside an open batch the engine may discard this update, so it settles nothing owed until the batch ends.
      if (this.batchEditDepth === 0) {
        this.hasPendingCommitReport = false
      }
      return true
    } catch (error) {
      log.w(`Error updating text: ${error}`)
      return false
    }
  }

  /**
   * Updates the cached selection range and forwards it to the keyboard engine.
   * @param start - Selection start in UTF-16 character units.
   * @param end - Selection end in UTF-16 character units.
   */
  public updateSelectionRange(start: number, end: number): void {
    this._selectionRange.x = start
    this._selectionRange.y = end
    this.recordReportSelection(start, end)

    try {
      global.textInputSystem.setSelectedTextRange(this._selectionRange)
    } catch (error) {
      log.e(`Error setting selected text range: ${error}`)
    }
  }

  /**
   * Moves the keyboard engine editing position to a collapsed caret index.
   * @param index - Caret position in UTF-16 character units.
   */
  public setEditingPosition(index: number): void {
    try {
      global.textInputSystem.setEditingPosition(index)
    } catch (error) {
      log.e(`Error setting editing position: ${error}`)
    }
  }

  private resetCompositionProvenance(): void {
    this.isComposing = false
    this.hasAppliedComposingText = false
    this.composingRegion.x = -1
    this.composingRegion.y = -1
  }
}

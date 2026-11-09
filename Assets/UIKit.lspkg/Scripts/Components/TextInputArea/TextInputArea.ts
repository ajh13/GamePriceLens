import {LINE_CENTER_OFFSET_RATIO} from "../../Utility/TextManipulationUtils"
import {isEqual} from "../../Utility/UIKitUtilities"
import {VoiceInputButton} from "../Button/VoiceInputButton"
import {BaseTextInputComponent} from "../TextInput/BaseTextInputComponent"
import {AutoSizeAnchor, DEFAULT_FONT_SIZE, OverflowMode, RESIZE_THRESHOLD} from "../TextInput/TextInputConsts"

const SCREEN_RECT_CORNERS: vec2[] = [new vec2(-1, -1), new vec2(-1, 1), new vec2(1, -1), new vec2(1, 1)]

/**
 * A multiline text input component that wraps text and supports
 * configurable overflow behavior.
 *
 * TextInputArea extends {@link BaseTextInputComponent} with multiline-specific features:
 * - **Overflow modes**: Choose how text that exceeds the visible area is handled
 *   - `Scroll` — vertically scrolls to keep the latest text visible, masking only when it overflows
 *   - `Truncate` — clips text that overflows both horizontally and vertically
 *   - `AutoSize` — automatically expands the component height to fit all text content
 * - **Text alignment**: Configure left or right horizontal alignment
 * - **Auto Size anchor**: Choose whether height changes keep the top, center, or bottom fixed
 *
 * @example
 * ```typescript
 * const textArea = sceneObject.getComponent(TextInputArea.getTypeName());
 * textArea.overflowMode = OverflowMode.AutoSize;
 * textArea.horizontalTextAlignment = TextAlignment.Left;
 * textArea.placeholderText = "Enter your message...";
 *
 * textArea.onTextChanged.add((text) => {
 *   print("User typed: " + text);
 * });
 * ```
 *
 * @see {@link BaseTextInputComponent} - The abstract base class providing shared text input behavior
 * @see {@link TextInputField} - Single-line text input variant
 */
@component
export class TextInputArea extends BaseTextInputComponent {
  // ─── Text Properties ──────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Text Properties</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Multiline text configuration and alignment</span>')
  @input
  @widget(new TextAreaWidget())
  @hint("Text that is displayed before any text is entered")
  protected _placeholderText: string = ""

  @input("string", "scroll")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Scroll", "scroll"),
      new ComboBoxItem("Truncate", "truncate"),
      new ComboBoxItem("Auto Size Height", "autoSize")
    ])
  )
  @hint("How text overflow is handled: scroll vertically, truncate, or auto-expand height")
  protected _overflowMode: OverflowMode = OverflowMode.Scroll

  @input("string", "center")
  @showIf("_overflowMode", "autoSize")
  @label("Auto Size Anchor")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Top", "top"),
      new ComboBoxItem("Center", "center"),
      new ComboBoxItem("Bottom", "bottom")
    ])
  )
  @hint("Which edge stays fixed when Auto Size changes the field height")
  private _autoSizeAnchor: AutoSizeAnchor = AutoSizeAnchor.Center

  @input("float")
  @showIf("_overflowMode", "autoSize")
  @label("Max Height")
  @ui.label(
    '<span style="color: #94A3B8; font-size: 11px;">Values at or below field height keep Auto Size uncapped.</span>'
  )
  @hint("Maximum height used before Auto Size switches to scrolling.")
  private _maxHeight: number = this._size.y

  // ─── Padding ─────────────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Padding</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Inner spacing between the field boundary and text</span>')
  @input
  private _paddingLeft: number = 0

  @input
  private _paddingRight: number = 0

  @input
  private _paddingTop: number = 0

  @input
  private _paddingBottom: number = 0

  // ─── Voice Input ────────────────────────────────────────────────────

  @ui.separator
  @ui.label('<span style="color: #60A5FA;">Voice Input</span>')
  @ui.label('<span style="color: #94A3B8; font-size: 11px;">Optional external voice input button</span>')
  @input
  @allowUndefined
  @hint("External VoiceInputButton that drives listening animation and speech-to-text updates.")
  private voiceInputButton: VoiceInputButton

  private _overflowModeDirty: boolean = false
  private _restoreHeightDirty: boolean = false
  private _autoSizeScrollActive: boolean = false
  private _scrollOffsetY: number = 0
  private _restoreHeightAnchor: AutoSizeAnchor | null = null
  private readonly _autoSizeTargetSize: vec3 = vec3.zero()
  private readonly _autoSizeLocalAnchorOffset: vec3 = vec3.zero()
  private readonly _autoSizeTargetPosition: vec3 = vec3.zero()

  /**
   * Gets the current overflow mode that controls how text exceeding the visible area is handled.
   * @returns The current overflow mode.
   */
  public get overflowMode(): OverflowMode {
    return this._overflowMode
  }

  /**
   * Sets the overflow mode that controls how text exceeding the visible area is handled.
   * Triggers a batched update that reconfigures overflow settings, masking, and text overflow
   * at the end of the frame.
   * @param value - The desired overflow mode.
   */
  public set overflowMode(value: OverflowMode) {
    if (value === undefined || isEqual(value, this._overflowMode)) return
    const oldOverflowMode = this._overflowMode
    this._overflowMode = value
    this.markOverflowModeDirty()
    if (oldOverflowMode === OverflowMode.AutoSize) {
      this._restoreHeightAnchor = this._autoSizeAnchor
      this.markRestoreHeightDirty()
    }
  }

  /**
   * Gets the anchor used when Auto Size changes the component height.
   * @returns The configured Auto Size anchor.
   */
  public get autoSizeAnchor(): AutoSizeAnchor {
    return this._autoSizeAnchor
  }

  /**
   * Sets the anchor used when Auto Size changes the component height.
   * @param value - The desired Auto Size anchor.
   */
  public set autoSizeAnchor(value: AutoSizeAnchor) {
    if (value === undefined || isEqual(value, this._autoSizeAnchor)) return
    if (this._initialized && this._overflowMode === OverflowMode.AutoSize) {
      this.repositionForAutoSizeAnchorChange(this._autoSizeAnchor, value)
    }
    this._autoSizeAnchor = value
  }

  /**
   * Gets the Auto Size height cap. Values at or below the field height keep Auto Size uncapped.
   * @returns The configured maximum height.
   */
  public get maxHeight(): number {
    return this._maxHeight
  }

  /**
   * Sets the Auto Size height cap. When greater than the field height, Auto Size grows to this
   * height and then scrolls internally without changing {@link overflowMode}.
   * @param value - The maximum height in centimeters.
   */
  public set maxHeight(value: number) {
    if (value === undefined) return
    if (isEqual(value, this._maxHeight)) return

    this._maxHeight = value
    this.markTextLayoutDirty()
  }

  /**
   * Gets the left padding between the area boundary and text content.
   * @returns The left padding in centimeters.
   */
  public get paddingLeft(): number {
    return this._paddingLeft
  }

  /**
   * Sets the left padding between the area boundary and text content.
   * Triggers batched size and text layout updates.
   * @param value - The left padding in centimeters.
   */
  public set paddingLeft(value: number) {
    if (value === undefined || isEqual(value, this._paddingLeft)) return
    this._paddingLeft = value
    this.markSizeDirty()
    this.markTextLayoutDirty()
  }

  /**
   * Gets the right padding between the area boundary and text content.
   * @returns The right padding in centimeters.
   */
  public get paddingRight(): number {
    return this._paddingRight
  }

  /**
   * Sets the right padding between the area boundary and text content.
   * Triggers batched size and text layout updates.
   * @param value - The right padding in centimeters.
   */
  public set paddingRight(value: number) {
    if (value === undefined || isEqual(value, this._paddingRight)) return
    this._paddingRight = value
    this.markSizeDirty()
    this.markTextLayoutDirty()
  }

  /**
   * Gets the top padding between the area boundary and text content.
   * @returns The top padding in centimeters.
   */
  public get paddingTop(): number {
    return this._paddingTop
  }

  /**
   * Sets the top padding between the area boundary and text content.
   * Triggers batched size and text layout updates.
   * @param value - The top padding in centimeters.
   */
  public set paddingTop(value: number) {
    if (value === undefined || isEqual(value, this._paddingTop)) return
    this._paddingTop = value
    this.markSizeDirty()
    this.markTextLayoutDirty()
  }

  /**
   * Gets the bottom padding between the area boundary and text content.
   * @returns The bottom padding in centimeters.
   */
  public get paddingBottom(): number {
    return this._paddingBottom
  }

  /**
   * Sets the bottom padding between the area boundary and text content.
   * Triggers batched size and text layout updates.
   * @param value - The bottom padding in centimeters.
   */
  public set paddingBottom(value: number) {
    if (value === undefined || isEqual(value, this._paddingBottom)) return
    this._paddingBottom = value
    this.markSizeDirty()
    this.markTextLayoutDirty()
  }

  /**
   * Initializes multiline text area state and voice input registration.
   */
  public initialize(): boolean {
    if (this.initialized) {
      return false
    }
    this._originalSize = new vec3(this._size.x, this._size.y, this._size.z)
    if (!super.initialize()) {
      return false
    }
    if (this.voiceInputButton) {
      // This (externally-assigned) button drives the area's voice animation, so
      // it's embedded — render it as the BeveledPrism, not the standalone grey
      // body. Effective only if the area initializes before the button does.
      this.voiceInputButton.markEmbeddedInField()
      this.registerVoiceInputButton(this.voiceInputButton)
    }
    return true
  }

  protected get returnKeyType(): TextInputSystem.ReturnKeyType {
    return TextInputSystem.ReturnKeyType.Return
  }

  protected initializeTextComponent(): void {
    this.textObjectScreenTransform.offsets.left = 1
    this.textObjectScreenTransform.offsets.right = -1
    this.applyScrollOffset()
    this.textComponent.verticalAlignment = VerticalAlignment.Top
    this.applyTextAlignment()
    this.applyOverflow()
  }

  protected updateVisibleText(text: string): void {
    this.textComponent.text = text
  }

  protected computeFontSize(): number {
    if (this._fontSize > 0) {
      return this._fontSize
    }
    return DEFAULT_FONT_SIZE
  }

  private applyOverflow() {
    switch (this._overflowMode) {
      case OverflowMode.Scroll:
      case OverflowMode.AutoSize:
        this.textComponent.verticalOverflow = VerticalOverflow.Overflow
        this.textComponent.horizontalOverflow = HorizontalOverflow.Wrap
        break
      case OverflowMode.Truncate:
        this.textComponent.verticalOverflow = VerticalOverflow.Truncate
        this.textComponent.horizontalOverflow = HorizontalOverflow.Wrap
        break
    }
  }

  private restoreHeight(): void {
    if (this._overflowMode === OverflowMode.AutoSize) {
      this._restoreHeightAnchor = null
      return
    }
    const restoreAnchor = this._restoreHeightAnchor ?? this._autoSizeAnchor
    this._restoreHeightAnchor = null
    if (Math.abs(this._size.y - this._originalSize.y) <= RESIZE_THRESHOLD) return

    this.applyHeight(this._originalSize.y, restoreAnchor)
  }

  private applyHeight(targetHeight: number, anchor: AutoSizeAnchor = this._autoSizeAnchor): void {
    const deltaHeight = targetHeight - this._size.y
    this._autoSizeTargetSize.x = this._size.x
    this._autoSizeTargetSize.y = targetHeight
    this._autoSizeTargetSize.z = this._size.z
    this.applySizeImmediately(this._autoSizeTargetSize)
    this.applyAutoSizeAnchorOffset(deltaHeight, anchor)
  }

  private applyAutoSizeAnchorOffset(deltaHeight: number, anchor: AutoSizeAnchor): void {
    if (Math.abs(deltaHeight) <= RESIZE_THRESHOLD) return
    const offsetY = this.getAutoSizeAnchorOffsetY(deltaHeight, anchor)
    if (offsetY === 0) return
    this.applyLocalAnchorOffsetY(offsetY)
  }

  private repositionForAutoSizeAnchorChange(previousAnchor: AutoSizeAnchor, nextAnchor: AutoSizeAnchor): void {
    const deltaHeight = this._size.y - this._originalSize.y
    if (Math.abs(deltaHeight) <= RESIZE_THRESHOLD) return

    const previousOffsetY = this.getAutoSizeAnchorOffsetY(deltaHeight, previousAnchor)
    const nextOffsetY = this.getAutoSizeAnchorOffsetY(deltaHeight, nextAnchor)
    this.applyLocalAnchorOffsetY(nextOffsetY - previousOffsetY)
  }

  private getAutoSizeAnchorOffsetY(deltaHeight: number, anchor: AutoSizeAnchor): number {
    let offsetY = 0
    switch (anchor) {
      case AutoSizeAnchor.Top:
        offsetY = -deltaHeight * 0.5
        break
      case AutoSizeAnchor.Bottom:
        offsetY = deltaHeight * 0.5
        break
      case AutoSizeAnchor.Center:
      default:
        break
    }
    return offsetY
  }

  private applyLocalAnchorOffsetY(offsetY: number): void {
    const position = this.transform.getLocalPosition()
    const scale = this.transform.getLocalScale()
    const rotation = this.transform.getLocalRotation()
    this._autoSizeLocalAnchorOffset.x = 0
    this._autoSizeLocalAnchorOffset.y = offsetY * scale.y
    this._autoSizeLocalAnchorOffset.z = 0
    const parentSpaceOffset = rotation.multiplyVec3(this._autoSizeLocalAnchorOffset)

    this._autoSizeTargetPosition.x = position.x + parentSpaceOffset.x
    this._autoSizeTargetPosition.y = position.y + parentSpaceOffset.y
    this._autoSizeTargetPosition.z = position.z + parentSpaceOffset.z
    this.transform.setLocalPosition(this._autoSizeTargetPosition)
  }

  private applyScrollOffset(): void {
    if (!this.textObjectScreenTransform) return
    // Move the text rect without resizing it; changing only top alters ScreenTransform height.
    this.textObjectScreenTransform.offsets.top = this._scrollOffsetY
    this.textObjectScreenTransform.offsets.bottom = this._scrollOffsetY
  }

  private resetScrollOffset(): void {
    this._scrollOffsetY = 0
    this.applyScrollOffset()
  }

  private clampScrollOffset(maxOffset: number): void {
    this._scrollOffsetY = Math.max(0, Math.min(maxOffset, this._scrollOffsetY))
  }

  private setAutoSizeScrollActive(active: boolean): void {
    if (this._autoSizeScrollActive === active) return
    this._autoSizeScrollActive = active
  }

  protected override shouldKeepMaskingEnabledWhileTextLayoutPending(): boolean {
    return (
      this._overflowMode !== OverflowMode.Truncate &&
      (this.hasPendingBatchedUpdates() || this.textManipulationModule?.isBoundingBoxUpdatePending === true)
    )
  }

  protected override prepareTextManipulationEditMode(editing: boolean): void {
    // Truncate intentionally exposes only visible native cursor positions. Keep the full logical
    // caret/selection authoritative, but let manipulation settle on the nearest renderable cursor
    // instead of polling for geometry that this overflow mode can never publish.
    this.textManipulationModule.setCursorGeometryMayRemainPartial(
      editing && this._overflowMode === OverflowMode.Truncate
    )
    if (!editing) {
      // Exit can replace an empty editing value with a placeholder after Base first evaluates mask
      // demand. Keep masking until that new visible text has been measured and laid out.
      this.markTextLayoutDirty()
    }
  }

  private isTargetOnFirstLine(targetIndex: number): boolean {
    const cursorPositions = this.textManipulationModule.cursorPositions
    const targetPosition = cursorPositions?.[targetIndex]?.position
    const firstPosition = cursorPositions?.[0]?.position
    if (!targetPosition || !firstPosition) return false

    return Math.abs(targetPosition.y - firstPosition.y) <= 0.1
  }

  protected updateTextLayout(): void {
    if (this._overflowMode === OverflowMode.Truncate) {
      this.setAutoSizeScrollActive(false)
      this.setTextOverflowRequiresMask(false)
      this.resetScrollOffset()
      return
    }

    // A failed getBoundingBox() leaves the previous bounds cached. Preserve the last concrete
    // demand; pending-state retention keeps only an already-enabled mask active, so unknown fitting
    // content neither enables a new mask nor re-enables an idle mask.
    if (this.textManipulationModule.isBoundingBoxUpdatePending) {
      return
    }

    const textBoundingBox = this.textManipulationModule.boundingBox
    const textBounds = textBoundingBox.getSize()
    const viewportSize = this.textViewportBounds.getSize()
    const anchorHeight = viewportSize.y

    if (this._overflowMode === OverflowMode.Scroll) {
      this.setAutoSizeScrollActive(false)
      const hasHorizontalOverflow = this.hasHorizontalMaskOverflow(textBoundingBox)
      const hasVerticalOverflow = textBounds.y > anchorHeight + RESIZE_THRESHOLD
      this.setTextOverflowRequiresMask(hasHorizontalOverflow || hasVerticalOverflow)
      if (hasVerticalOverflow) {
        const overflow = textBounds.y - anchorHeight
        this.clampScrollOffset(overflow)
      } else {
        this._scrollOffsetY = 0
      }
      this.applyScrollOffset()
    } else if (this._overflowMode === OverflowMode.AutoSize) {
      if (anchorHeight < RESIZE_THRESHOLD) {
        this.setAutoSizeScrollActive(false)
        this.setTextOverflowRequiresMask(false)
        this.resetScrollOffset()
        return
      }
      const verticalInset = this.visual.borderSize * 2 + this._paddingTop + this._paddingBottom
      const contentHeight = Math.max(this._originalSize.y, textBounds.y + verticalInset)
      const hasHeightCap = this._maxHeight > this._originalSize.y + RESIZE_THRESHOLD
      const targetHeight = hasHeightCap ? Math.min(contentHeight, this._maxHeight) : contentHeight
      const scrollActive = hasHeightCap && contentHeight > this._maxHeight + RESIZE_THRESHOLD
      const hasHorizontalOverflow = this.hasHorizontalMaskOverflow(textBoundingBox)
      const wasAutoSizeScrollActive = this._autoSizeScrollActive
      const heightChanged = Math.abs(targetHeight - this._size.y) > RESIZE_THRESHOLD

      if (heightChanged) {
        this.applyHeight(targetHeight)
      }

      this.setAutoSizeScrollActive(scrollActive)
      this.setTextOverflowRequiresMask(hasHorizontalOverflow || scrollActive)
      if (scrollActive) {
        const currentAnchorHeight = this.textViewportBounds.getSize().y
        this.clampScrollOffset(Math.max(0, textBounds.y - currentAnchorHeight))
        this.applyScrollOffset()
        if (!wasAutoSizeScrollActive || heightChanged) {
          this.updateScrollOffset(this.textManipulationModule.caretIndex)
        }
      } else {
        this.resetScrollOffset()
      }
    }
  }

  private hasHorizontalMaskOverflow(textBounds: Rect): boolean {
    const worldToTextLocal = this.textComponent.getTransform().getInvertedWorldTransform()
    let maskLeft = Infinity
    let maskRight = -Infinity

    for (const corner of SCREEN_RECT_CORNERS) {
      const textLocalCorner = worldToTextLocal.multiplyPoint(this.maskScreenTransform.localPointToWorldPoint(corner))
      maskLeft = Math.min(maskLeft, textLocalCorner.x)
      maskRight = Math.max(maskRight, textLocalCorner.x)
    }

    return textBounds.left < maskLeft - RESIZE_THRESHOLD || textBounds.right > maskRight + RESIZE_THRESHOLD
  }

  protected updateScrollOffset(targetIndex: number): boolean {
    if (!this.isEditing || !(this._overflowMode === OverflowMode.Scroll || this._autoSizeScrollActive)) return false

    const cursorPositionData = this.textManipulationModule.cursorPositions?.[targetIndex]
    if (!cursorPositionData) return false

    const anchors = this.textViewportBounds
    const areaTop = anchors.top
    const areaBottom = anchors.bottom
    const caretPosition = cursorPositionData.position.y

    const textBounds = this.textManipulationModule.boundingBox.getSize()
    const anchorHeight = anchors.getSize().y
    const maxOffset = Math.max(0, textBounds.y - anchorHeight)
    const previousOffset = this._scrollOffsetY

    if (maxOffset === 0) {
      this._scrollOffsetY = 0
      if (this._scrollOffsetY === previousOffset) return false

      this.applyScrollOffset()
      return true
    }

    if (previousOffset > 0 && this.isTargetOnFirstLine(targetIndex)) {
      this._scrollOffsetY = 0
      this.applyScrollOffset()
      return true
    }

    const cursorHeight = this.textManipulationModule.cursorHeight
    const halfLine = cursorHeight / 2

    // Scroll to the caret as drawn, which is centered above cursor Y.
    const caretCenter = caretPosition + cursorHeight * LINE_CENTER_OFFSET_RATIO
    const caretTop = caretCenter + halfLine
    const caretBottom = caretCenter - halfLine
    if (caretTop > areaTop) {
      this._scrollOffsetY -= caretTop - areaTop
    } else if (caretBottom < areaBottom) {
      this._scrollOffsetY += areaBottom - caretBottom
    } else {
      return false
    }

    this.clampScrollOffset(maxOffset)
    if (this._scrollOffsetY === previousOffset) return false

    this.applyScrollOffset()
    return true
  }

  protected flushBatchedUpdates(): void {
    const sizeDirty = this._sizeDirty
    const fontDirty = this._fontDirty
    const fontSizeDirty = this._fontSizeDirty
    super.flushBatchedUpdates()
    const overflowModeDirty = this._overflowModeDirty
    const restoreHeightDirty = this._restoreHeightDirty
    const textLayoutDirty = this._textLayoutDirty
    const alignmentDirty = this._alignmentDirty
    this._overflowModeDirty = false
    this._restoreHeightDirty = false
    this._textLayoutDirty = false
    this._alignmentDirty = false

    if (overflowModeDirty) {
      this.applyOverflow()
      this.textManipulationModule.setCursorGeometryMayRemainPartial(
        this.isEditing && this._overflowMode === OverflowMode.Truncate
      )
    }

    if (restoreHeightDirty) {
      this.restoreHeight()
    }

    if (alignmentDirty) {
      this.applyTextAlignment()
    }

    this.refreshTextGeometryAndLayout({
      fromFont: fontDirty,
      fromFontSize: fontSizeDirty,
      fromAnchors: sizeDirty || restoreHeightDirty,
      fromAlignment: alignmentDirty,
      fromOverflow: overflowModeDirty,
      updateTextLayout: sizeDirty || overflowModeDirty || restoreHeightDirty || textLayoutDirty
    })
  }

  protected hasPendingBatchedUpdates(): boolean {
    return super.hasPendingBatchedUpdates() || this._overflowModeDirty || this._restoreHeightDirty
  }

  private markOverflowModeDirty(): void {
    if (!this._initialized) return
    this._overflowModeDirty = true
    this.batchUpdate()
  }

  private markRestoreHeightDirty(): void {
    if (!this._initialized) return
    this._restoreHeightDirty = true
    this.batchUpdate()
  }

  protected updateSize() {
    this.syncCanvasSize()
    this.textComponent.size = this.computeFontSize()
    this.setTextViewportBounds(
      this._size.x * -0.5 + this.visual.borderSize + this._paddingLeft,
      this._size.x * 0.5 - this.visual.borderSize - this._paddingRight,
      this._size.y * -0.5 + this.visual.borderSize + this._paddingBottom,
      this._size.y * 0.5 - this.visual.borderSize - this._paddingTop
    )
  }
}

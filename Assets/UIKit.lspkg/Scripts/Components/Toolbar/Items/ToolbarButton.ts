import animate, {CancelSet} from "InteractionKit.lspkg/Utils/animate"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import {ThemeService} from "../../../Themes/ThemeService"
import {IMAGE_MATERIAL_ASSET} from "../../../Utility/Assets"
import {createChildSceneObjectWithParentLayer} from "../../../Utility/SceneUtilities"
import {Button} from "../../Button/Button"
import {LongPressButton} from "../../Button/LongPressButton"
import {VoiceInputButton} from "../../Button/VoiceInputButton"
import {ElementContent, IconLayout, TextAlignment, TextSizing} from "../../Content/ElementContent"
import {
  getSizeModeFromSize,
  ToolbarAlignment,
  ToolbarButtonBehavior,
  ToolbarButtonConfig,
  ToolbarButtonType,
  ToolbarHorizontalAlignment,
  ToolbarIconSizeMode,
  ToolbarItemSizeMode,
  ToolbarTextSize
} from "../Types/ToolbarSchema"
import {ToolbarItem} from "./ToolbarItem"

const log = new NativeLogger("ToolbarButton")

const TEXT_ALIGNMENT_MAP: Record<ToolbarAlignment, TextAlignment> = {
  [ToolbarAlignment.LEFT]: TextAlignment.Left,
  [ToolbarAlignment.CENTER]: TextAlignment.Center,
  [ToolbarAlignment.RIGHT]: TextAlignment.Right
}

/**
 * Toolbar button item (rectangle or capsule, with optional icon and text). Obtain via {@link Toolbar.getItem} or {@link Toolbar.allItems}.
 * `config.behavior` picks what a press does: tap, toggle, hold (a LongPressButton) or voice (a
 * VoiceInputButton); see {@link ToolbarButtonBehavior}.
 */
@component
export class ToolbarButton extends ToolbarItem {
  private button: Button
  private _elementContent: ElementContent | null = null
  private fillIconObject: SceneObject | null = null
  private fillIconImage: Image | null = null
  private fillIconTransform: Transform | null = null
  private hasIcon: boolean = false
  private hasText: boolean = false
  private _iconSize: number | null = null
  private textHiddenDueToSize: boolean = false
  private cachedNaturalTextWidth: number | null = null
  private hideTextRecheckUnsubscribe: (() => void) | null = null
  private iconPositionTween: CancelSet = new CancelSet()
  // The icon slide's pending one-shot. Held so the next slide and release()
  // drop it: left behind by a change that never announced, it would fire on an
  // unrelated later presentation and slide the icon from a stale start.
  private iconSlideUnsubscribe: (() => void) | null = null
  // Set in release(). Gates the one-shot layout and presentation callbacks,
  // which can still be pending when the item is destroyed, so none of them
  // starts a tween.
  private released: boolean = false

  private readonly DEFAULT_ICON_SIZE = 1.1
  private readonly MIN_BUTTON_SIZE = 3.0
  private readonly DEFAULT_TEXT_SIZE = 30
  private readonly TEXT_PADDING = 1
  private readonly VERTICAL_PADDING = 0.5
  private readonly ICON_TEXT_SPACING = 0.6
  private readonly HIDE_TEXT_PADDING = 0.3
  private readonly HIDE_TEXT_THRESHOLD_FACTOR = 0.85
  private readonly ICON_TWEEN_DURATION = 0.2
  private readonly FILL_ICON_Z_POSITION = new vec3(0, 0, 0.1)
  private readonly MIN_BUTTON_SIZE_VEC2 = new vec2(this.MIN_BUTTON_SIZE, this.MIN_BUTTON_SIZE)

  /** Underlying button component. */
  public get buttonComponent(): Button {
    return this.button
  }

  /** Companion content component hosting the label and fixed-size icon, or null for icon-FILL and empty buttons. */
  public get elementContent(): ElementContent | null {
    return this._elementContent
  }

  /** What a press does; `tap` unless the config chose otherwise. */
  public get behavior(): ToolbarButtonBehavior {
    return this.buttonConfig.behavior ?? ToolbarButtonBehavior.TAP
  }

  /**
   * A `toggle` button's latch, or whether a `voice` button is listening. Writes
   * are ignored for the other behaviours, which have no on state to set.
   */
  public get isOn(): boolean {
    return this.button.isOn
  }

  public set isOn(value: boolean) {
    if (this.behavior === ToolbarButtonBehavior.TOGGLE || this.behavior === ToolbarButtonBehavior.VOICE) {
      this.button.isOn = value
    }
  }

  /** The LongPressButton behind a `hold` button, else null. Its `reset()` re-arms a completed hold. */
  public get longPressButton(): LongPressButton | null {
    return this.button instanceof LongPressButton ? this.button : null
  }

  /** The VoiceInputButton behind a `voice` button, else null. */
  public get voiceInputButton(): VoiceInputButton | null {
    return this.button instanceof VoiceInputButton ? this.button : null
  }

  /** Button label text. */
  public get text(): string {
    return this.buttonConfig.text ?? this._elementContent?.text ?? ""
  }

  public set text(value: string) {
    if (this.rejectsLabelWrite("text")) {
      return
    }
    this.buttonConfig.text = value
    this.hasText = value.length > 0
    if (!value && !this._elementContent) {
      return
    }
    const content = this.ensureElementContent()
    // While hidden the label component does not exist, so the stale cached width
    // keeps the re-show threshold answerable; it refreshes on the next visible pass.
    if (!this.textHiddenDueToSize) {
      this.cachedNaturalTextWidth = null
      content.text = value
    }
  }

  /** Button icon texture. */
  public get icon(): Texture | undefined {
    return this.buttonConfig.icon
  }

  public set icon(value: Texture | undefined) {
    if (!value || this.rejectsLabelWrite("icon")) return
    const config = this.buttonConfig
    config.icon = value
    this.hasIcon = true
    const iconSizeMode = config.iconSizeMode || ToolbarIconSizeMode.FIXED

    if (iconSizeMode === ToolbarIconSizeMode.FILL) {
      if (this.fillIconImage) {
        this.fillIconImage.mainPass.baseTex = value
      } else {
        this.createFillIcon(value)
      }
      this.syncFillIconSize()
    } else {
      const content = this.ensureElementContent()
      content.leadingIconSize = this.iconSize
      content.leadingIcon = value
      this.applyContentLayout(content)
    }
  }

  /** Label size, as a raw size or a TextStylePresets ranking. Defaults to 30. */
  public get textSize(): ToolbarTextSize {
    return this.buttonConfig.textSize ?? this.DEFAULT_TEXT_SIZE
  }

  public set textSize(value: ToolbarTextSize) {
    this.buttonConfig.textSize = value
    if (this._elementContent) {
      this.applyTextSize(this._elementContent, value)
    }
  }

  /** Fixed-mode icon cell size in centimeters. Defaults to the standard toolbar icon size. */
  public get iconSize(): number {
    return this._iconSize ?? this.DEFAULT_ICON_SIZE
  }

  public set iconSize(value: number) {
    this._iconSize = value
    if (this._elementContent && this.hasIcon) {
      this._elementContent.leadingIconSize = value
    }
  }

  /** Icon alignment within the button. */
  public set iconAlignment(value: ToolbarHorizontalAlignment) {
    this.buttonConfig.iconAlignment = value
    if (this._elementContent) {
      this.applyContentLayout(this._elementContent)
    }
  }

  /** Intrinsic size from config or measured from the content layout. */
  public get intrinsicSize(): vec2 {
    const config = this.buttonConfig
    if (config.size instanceof vec2) {
      return config.size
    }
    return this.measureIntrinsicSize() ?? config.minSize ?? this.MIN_BUTTON_SIZE_VEC2
  }

  /** Called by the toolbar when the item is created. Not intended for external callers. */
  public initializeWithConfig(config: ToolbarButtonConfig) {
    this._config = config

    // A voice button keeps VoiceInputButton's own mic icon content, which adopts
    // any ElementContent on its object, so the wrapper builds no label for it.
    const voice = config.behavior === ToolbarButtonBehavior.VOICE
    if (voice && (config.icon || config.text)) {
      log.w(`"${config.id}": a voice button keeps its own mic icon; the icon and text config are ignored`)
    }
    this.hasIcon = !voice && !!config.icon
    const iconSizeMode = config.iconSizeMode || ToolbarIconSizeMode.FIXED
    this.hasText = !voice && iconSizeMode !== ToolbarIconSizeMode.FILL && !!config.text

    this.createButton(config)

    const size = this.intrinsicSize
    this._size = new vec3(size.x, size.y, 0)

    super.initializeWithConfig(config)
  }

  /** Size mode: fill or manual from config.size. */
  public getSizeMode(): ToolbarItemSizeMode {
    return getSizeModeFromSize(this.buttonConfig.size)
  }

  public applyLayoutSize(size: vec2, transpose: boolean): void {
    const contentSize = transpose ? new vec2(size.y, size.x) : size
    this.computedSize = size
    this.buttonComponent.size = new vec3(contentSize.x, contentSize.y, 0)
    this.transform.setLocalScale(vec3.one())
  }

  /**
   * Applies a render order to the button, its label content and its fill icon,
   * and nothing else: visibility and opacity belong to `setVisualAlpha`, so a
   * consumer's `elementContent.setRenderingEnabled(false)` holds across the
   * per-pass calls an attached item receives.
   */
  public applyRenderOrder(renderOrder?: number): void {
    if (renderOrder === undefined) {
      return
    }
    if (this.button) {
      // Through the Button's own setter, so button.renderOrder stays the truth.
      this.button.renderOrder = renderOrder
    }
    if (this._elementContent) {
      this._elementContent.renderOrder = renderOrder
    }
    if (this.fillIconImage) {
      this.fillIconImage.renderOrder = renderOrder
    }
  }

  /** Called when the toolbar applies the item's final cell size (e.g. fill or manual). */
  public onLayoutSizeApplied() {
    this.updateHideTextState()
    this.syncFillIconSize()
  }

  /**
   * Stops the icon tween and drops the pending one-shots before the base
   * destroys the objects they write to. IK's animate() runs every animation
   * from one shared handler with no try/catch, so a tween left writing to a
   * destroyed icon transform would lose itself and every animation queued
   * after it, and Lens Studio never calls a handler that threw again, so every
   * animation in the lens would stop for good.
   */
  protected release(): void {
    this.released = true
    this.iconPositionTween.cancel()
    this.hideTextRecheckUnsubscribe?.()
    this.hideTextRecheckUnsubscribe = null
    this.iconSlideUnsubscribe?.()
    this.iconSlideUnsubscribe = null
    super.release()
  }

  protected onInactiveChanged(inactive: boolean): void {
    if (this.button) {
      this.button.inactive = inactive
    }
  }

  protected setVisualAlpha(alpha: number, effectiveAlpha: number): void {
    if (this.button) {
      if (this.button.visual?.renderMeshVisual) {
        this.button.visual.renderMeshVisual.enabled = alpha > 0
      }
      this.button.opacity = alpha
    }

    // The plate and the ElementContent get the undimmed alpha: the button's
    // inactive state already re-resolves both to the theme's inactive colors, so
    // multiplying DISABLED_ALPHA in as well would double-dim them. The fill icon
    // is a plain Image outside the theme, so it takes the dimmed effectiveAlpha.
    // An `inactive` toggle re-derives through here too (the base class's
    // updateDisabledVisuals), so a toggle and a fade always agree.
    this.applyContentAlpha(alpha, effectiveAlpha)
  }

  private get buttonConfig(): ToolbarButtonConfig {
    return this._config as ToolbarButtonConfig
  }

  private applyContentAlpha(contentAlpha: number, fillIconAlpha: number): void {
    if (this._elementContent) {
      this._elementContent.opacity = contentAlpha
    }
    if (this.fillIconImage) {
      const currentColor = this.fillIconImage.mainPass.baseColor
      this.fillIconImage.mainPass.baseColor = new vec4(currentColor.r, currentColor.g, currentColor.b, fillIconAlpha)
    }
  }

  private createButton(config: ToolbarButtonConfig) {
    // The canonical Button and its companions (ElementContent label, fill icon)
    // live on the Content child so the child's own ElementHandler owns size; the
    // wrapper's anchor SceneObject stays pinned at container-local origin.
    this.button = this.createButtonComponent(config)
    this.managedComponents.add(this.button)
    this.applyButtonVariant(config)

    const iconSizeMode = config.iconSizeMode || ToolbarIconSizeMode.FIXED
    if (this.hasText || (this.hasIcon && iconSizeMode !== ToolbarIconSizeMode.FILL)) {
      this.createElementContent(config)
    }

    this.button.initialize()
    // Flat at the item's order (the toolbar's base unless config.renderOrder):
    // under the toolbar's Canvas the plate, this button and its companions sort
    // by tree order and z, not by a per-item bump.
    this.button.renderOrder = this.renderOrder
    if (this._elementContent) {
      this._elementContent.renderOrder = this.button.renderOrder
    }

    this.button.onTriggerUp.add((e) => this.invokeOnTriggerUp(e))
    this.button.onTriggerDown.add((e) => this.invokeOnTriggerDown(e))
    this.button.onHoverEnter.add((e) => this.invokeOnHoverEnter(e))
    this.button.onHoverExit.add((e) => this.invokeOnHoverExit(e))

    if (this.button.visual?.renderMeshVisual) {
      this.button.visual.renderMeshVisual.mainMaterial.mainPass.blendMode = BlendMode.PremultipliedAlphaAuto
    }
    this.wireBehaviorCallbacks(config)

    if (this.hasIcon && iconSizeMode === ToolbarIconSizeMode.FILL && config.icon) {
      this.createFillIcon(config.icon)
    }
  }

  private applyButtonVariant(config: ToolbarButtonConfig) {
    // VoiceInputButton pins System 3.0 and its own style, and its size setter
    // re-applies the field corner radius, so shape, theme and style would be
    // dropped or undone; setVariant would only warn about them.
    if (config.behavior === ToolbarButtonBehavior.VOICE) {
      return
    }
    const buttonType = config.buttonType || ToolbarButtonType.RECTANGLE
    const shape = buttonType === ToolbarButtonType.CAPSULE ? "Capsule" : "Rectangle"
    let theme = config.theme
    let style = config.style

    // Button drops shape and style writes while the theme override is "Inherited",
    // so a capsule or explicit style without a theme resolves the active theme;
    // pinning the theme's default style keeps inherited-style resolution unchanged.
    if (!theme && (shape === "Capsule" || style)) {
      const currentTheme = ThemeService.getInstance().currentTheme
      theme = currentTheme.name
      style = style ?? currentTheme.defaultStyleName
    }

    if (theme) {
      this.button.setVariant({theme, shape, style})
    }
  }

  // The Button subclass the behaviour needs. Toggle mode and a starting state
  // are set before initialize(), where BaseButton reads them; a LongPressButton's
  // 0 durations mean "the theme's", so only positive values are forwarded.
  private createButtonComponent(config: ToolbarButtonConfig): Button {
    const host = this._contentObject!
    switch (config.behavior ?? ToolbarButtonBehavior.TAP) {
      case ToolbarButtonBehavior.HOLD: {
        const button = host.createComponent(LongPressButton.getTypeName()) as LongPressButton
        if (config.holdSeconds) {
          button.holdSeconds = config.holdSeconds
        }
        if (config.drainSeconds) {
          button.drainSeconds = config.drainSeconds
        }
        if (config.repeatable !== undefined) {
          button.repeatable = config.repeatable
        }
        return button
      }
      case ToolbarButtonBehavior.VOICE: {
        const button = host.createComponent(VoiceInputButton.getTypeName()) as VoiceInputButton
        if (config.voiceFormat) {
          button.format = config.voiceFormat
        }
        return button
      }
      case ToolbarButtonBehavior.TOGGLE: {
        const button = host.createComponent(Button.getTypeName()) as Button
        button.setIsToggleable(true)
        if (config.isOn !== undefined) {
          button.isOn = config.isOn
        }
        return button
      }
      default:
        return host.createComponent(Button.getTypeName()) as Button
    }
  }

  // The behaviour's own callbacks, on top of the trigger and hover ones every
  // item wires in setupCallbacks. Called once the button is initialized.
  private wireBehaviorCallbacks(config: ToolbarButtonConfig) {
    const onToggled = config.onToggled
    const hasOnState = this.behavior === ToolbarButtonBehavior.TOGGLE || this.behavior === ToolbarButtonBehavior.VOICE
    if (onToggled && hasOnState) {
      this.button.onValueChange.add((value) => onToggled(value === 1))
    }
    const longPress = this.longPressButton
    if (longPress) {
      if (config.onHoldStart) {
        longPress.onHoldStart.add(config.onHoldStart)
      }
      if (config.onHoldComplete) {
        longPress.onHoldComplete.add(config.onHoldComplete)
      }
      if (config.onHoldCanceled) {
        longPress.onHoldCanceled.add(config.onHoldCanceled)
      }
    }
    const voice = this.voiceInputButton
    if (voice) {
      const onListeningUpdate = config.onListeningUpdate
      if (onListeningUpdate) {
        voice.onListeningUpdate.add(([text, isFinal]) => onListeningUpdate(text, isFinal))
      }
      if (config.onListeningError) {
        voice.onListeningError.add(config.onListeningError)
      }
    }
  }

  // A voice button's label and icon belong to VoiceInputButton: a wrapper
  // ElementContent on the same object would be adopted as its icon content.
  private rejectsLabelWrite(what: string): boolean {
    if (!this.voiceInputButton) {
      return false
    }
    log.w(`"${this.id}": a voice button keeps its own mic icon; the ${what} write is ignored`)
    return true
  }

  // A ranking carries its own size and weight, so the two forms are exclusive:
  // clearing the ranking is what lets a raw size take effect again.
  private applyTextSize(content: ElementContent, textSize: ToolbarTextSize | undefined): void {
    if (typeof textSize === "string") {
      content.ranking = textSize
      return
    }
    content.ranking = null
    content.textSize = textSize ?? this.DEFAULT_TEXT_SIZE
  }

  private createElementContent(config: ToolbarButtonConfig): ElementContent {
    const content = this._contentObject!.createComponent(ElementContent.getTypeName()) as ElementContent
    this._elementContent = content

    this.applyTextSize(content, config.textSize)
    // Toolbar labels never wrap: a squeezed cell keeps a single line (legacy
    // behavior) instead of splitting the label across lines.
    content.wrapText = false
    content.spacing = this.ICON_TEXT_SPACING
    content.padding = {
      top: this.VERTICAL_PADDING,
      right: this.TEXT_PADDING,
      bottom: this.VERTICAL_PADDING,
      left: this.TEXT_PADDING
    }

    if (this.hasText && config.text) {
      content.text = config.text
    }
    if (this.hasIcon && config.icon) {
      content.leadingIconSize = this.iconSize
      content.leadingIcon = config.icon
    }
    this.applyContentLayout(content)
    return content
  }

  private applyContentLayout(content: ElementContent) {
    const config = this.buttonConfig
    const iconAlignment = config.iconAlignment || ToolbarHorizontalAlignment.LEFT
    const textAlignment = config.textAlignment || ToolbarAlignment.CENTER

    content.iconLayout = iconAlignment === ToolbarHorizontalAlignment.RIGHT ? IconLayout.Right : IconLayout.Left
    // Centered icon+text moves as one group: Fit sizing hugs the text's natural
    // width so justifyContent centers the icon+label pair like the legacy layout.
    content.textSizing =
      iconAlignment === ToolbarHorizontalAlignment.CENTER && this.hasIcon && this.hasText
        ? TextSizing.Fit
        : TextSizing.Hug
    content.textAlignment = TEXT_ALIGNMENT_MAP[textAlignment] ?? TextAlignment.Center
  }

  private ensureElementContent(): ElementContent {
    if (this._elementContent) {
      return this._elementContent
    }
    const content = this.createElementContent(this.buttonConfig)
    if (this.button) {
      content.renderOrder = this.button.renderOrder
    }
    return content
  }

  private createFillIcon(texture: Texture) {
    this.fillIconObject = createChildSceneObjectWithParentLayer("Icon", this._contentObject!)
    this.managedSceneObjects.add(this.fillIconObject)
    this.fillIconTransform = this.fillIconObject.getTransform()

    this.fillIconImage = this.fillIconObject.createComponent("Component.Image") as Image
    this.fillIconImage.mainMaterial = IMAGE_MATERIAL_ASSET.clone()
    this.fillIconImage.mainPass.baseTex = texture
    this.fillIconImage.stretchMode = StretchMode.Stretch
    this.fillIconImage.verticalAlignment = VerticalAlignment.Center
    this.fillIconImage.horizontalAlignment = HorizontalAlignment.Center
    this.fillIconImage.renderOrder = this.button?.renderOrder ?? this.renderOrder

    this.syncFillIconSize()
    this.fillIconTransform.setLocalPosition(this.FILL_ICON_Z_POSITION)
  }

  private syncFillIconSize() {
    if (!this.fillIconTransform || !this.button) {
      return
    }
    const buttonSize = this.button.size
    this.fillIconTransform.setLocalScale(new vec3(buttonSize.x, buttonSize.y, 1))
  }

  private measureIntrinsicSize(): vec2 | null {
    const elementContent = this._elementContent
    const layout = elementContent?.layout
    if (!elementContent || !layout) {
      return null
    }
    // An unresolved label measures zero but padding+icon still yield a positive
    // content size; treat that half-measured state as not-yet-measurable so the
    // config/min-size fallback applies instead of a truncated width.
    if (this.hasText && elementContent.measureNaturalTextWidth() === null) {
      return null
    }
    const content = layout.computeContentSize()
    if (content.width <= 0 || content.height <= 0 || !isFinite(content.width) || !isFinite(content.height)) {
      return null
    }
    return new vec2(Math.max(content.width, this.MIN_BUTTON_SIZE), Math.max(content.height, this.MIN_BUTTON_SIZE))
  }

  private updateHideTextState() {
    const config = this.buttonConfig
    if (!config.hideTextWhenTooSmall || !this.hasIcon || !this.hasText || !this._elementContent) {
      return
    }

    this.refreshCachedTextWidth()
    if (this.cachedNaturalTextWidth === null) {
      // Nothing measurable yet: a fresh label's first query can come back
      // pending, or the content has not built its Text at all, and the toolbar
      // may never run another layout pass. Re-check when the content can next
      // answer; see scheduleHideTextRecheck.
      this.scheduleHideTextRecheck()
      return
    }

    const textWidth = this.cachedNaturalTextWidth + this.HIDE_TEXT_PADDING * 2
    const minWidthForBoth = this.iconSize + this.ICON_TEXT_SPACING + textWidth + this.TEXT_PADDING * 2
    const hideThreshold = minWidthForBoth * this.HIDE_TEXT_THRESHOLD_FACTOR
    const actualButtonWidth = this.button.size.x

    if (actualButtonWidth < hideThreshold && !this.textHiddenDueToSize) {
      this.textHiddenDueToSize = true
      this.animateIconAcrossContentChange(() => {
        this._elementContent!.text = ""
      })
    } else if (actualButtonWidth >= hideThreshold && this.textHiddenDueToSize) {
      this.textHiddenDueToSize = false
      this.animateIconAcrossContentChange(() => {
        this._elementContent!.text = this.buttonConfig.text ?? ""
      })
    }
  }

  // A re-created label measures null on its first layout pass and while hidden the
  // Text component does not exist at all, so threshold checks run on the last valid
  // measurement instead of flapping on degenerate reads.
  private refreshCachedTextWidth() {
    if (this.textHiddenDueToSize) {
      return
    }
    const natural = this._elementContent?.measureNaturalTextWidth()
    if (natural !== null && natural !== undefined) {
      this.cachedNaturalTextWidth = natural
    }
  }

  // Re-checks on the content's NEXT LAYOUT PASS. The text handler has just
  // measured the label there, so this check's own query is a cache hit, which
  // also clears a pending answer its earlier query left on the content; still
  // unmeasurable, it re-arms. onPresentationReady alone is the wrong trigger for
  // a retry: it fires once per request generation and never again for one that
  // already announced, and presentationReady reads false whenever anything is
  // pending, so "not yet" and "already announced" look alike. It stays as the
  // second trigger because a content that has not built yet has no layout to
  // wait on, and its first presentation is the first moment the label is
  // measurable. Whichever fires first runs the check and drops both; the
  // identity test skips a stale call from an event snapshot already in flight.
  private scheduleHideTextRecheck() {
    if (this.hideTextRecheckUnsubscribe) {
      return
    }
    const content = this._elementContent
    if (!content) {
      return
    }
    const unsubscribes: (() => void)[] = []
    const unsubscribeAll = () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe()
      }
    }
    const recheck = () => {
      if (this.hideTextRecheckUnsubscribe !== unsubscribeAll) {
        return
      }
      unsubscribeAll()
      this.hideTextRecheckUnsubscribe = null
      if (this.released) {
        return
      }
      this.updateHideTextState()
    }
    unsubscribes.push(content.onPresentationReady.add(recheck))
    const layout = content.layout
    if (layout) {
      unsubscribes.push(layout.onLayoutComplete.add(recheck))
    }
    this.hideTextRecheckUnsubscribe = unsubscribeAll
  }

  // Slides the icon from where the label change finds it to where it lands.
  // The label write starts a new presentation generation, so the content's
  // next onPresentationReady is this change's: it fires once the new label is
  // measured and laid out, when the icon's target is final. The content
  // layout's onLayoutComplete is too early: showing a label creates a new
  // Text, and the first pass after that runs before the Text is measured. In
  // Lens Studio that pass put a centred icon at a provisional spot past its
  // final one, and a slide keyed on it ended there. The one-shot
  // lives in iconSlideUnsubscribe, so a newer slide replaces it and release()
  // drops it; the identity test skips a superseded call from an event snapshot
  // already in flight.
  private animateIconAcrossContentChange(mutate: () => void) {
    this.iconSlideUnsubscribe?.()
    this.iconSlideUnsubscribe = null
    const content = this._elementContent
    const iconObject = content?.leadingIconObject
    if (!content || !iconObject) {
      mutate()
      return
    }

    const iconTransform = iconObject.getTransform()
    const startPosition = iconTransform.getLocalPosition()
    const unsubscribe = content.onPresentationReady.add(() => {
      if (this.iconSlideUnsubscribe !== unsubscribe) {
        return
      }
      unsubscribe()
      this.iconSlideUnsubscribe = null
      // Never start a tween for a released item or a vanished icon: the tween's
      // writes would land on destroyed objects inside animate()'s shared handler.
      if (this.released || isNull(iconObject)) {
        return
      }

      const targetPosition = iconTransform.getLocalPosition()
      if (targetPosition.distance(startPosition) < 0.001) {
        return
      }
      iconTransform.setLocalPosition(startPosition)
      this.iconPositionTween.cancel()
      animate({
        duration: this.ICON_TWEEN_DURATION,
        // The icon object can also be destroyed while the button lives on (a
        // consumer clearing elementContent.leadingIcon destroys it), which
        // release() does not cover. Bail and cancel rather than write to it.
        update: (t: number) => {
          if (isNull(iconObject)) {
            this.iconPositionTween.cancel()
            return
          }
          iconTransform.setLocalPosition(vec3.lerp(startPosition, targetPosition, t))
        },
        ended: () => {
          if (!isNull(iconObject)) {
            iconTransform.setLocalPosition(targetPosition)
          }
        },
        cancelSet: this.iconPositionTween
      })
    })
    this.iconSlideUnsubscribe = unsubscribe
    mutate()
  }
}

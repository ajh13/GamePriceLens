import {withAlpha} from "InteractionKit.lspkg/Utils/color"
import Event, {PublicApi, unsubscribe} from "InteractionKit.lspkg/Utils/Event"
import {clamp} from "InteractionKit.lspkg/Utils/mathUtils"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import {StateName} from "./Components/Element"
import {ScrollWindow} from "./Components/ScrollWindow/ScrollWindow"
import {Slider} from "./Components/Slider/Slider"
import {normalizeThemeName, SYSTEM_2_NAME, SYSTEM_3_NAME} from "./Themes/Theme"
import {ThemeService} from "./Themes/ThemeService"
import {gradientParameterClone, isEqual} from "./Utility/UIKitUtilities"
import {GradientParameters} from "./Visuals/RoundedRectangle/RoundedRectangle"
import {
  RoundedRectangleVisual,
  RoundedRectangleVisualParameters
} from "./Visuals/RoundedRectangle/RoundedRectangleVisual"

const log = new NativeLogger("ScrollBar")

enum ScrollOrientation {
  Horizontal = "Horizontal",
  Vertical = "Vertical"
}

const darkGray = new vec4(0.22, 0.22, 0.22, 1)
const mediumGray = new vec4(0.31, 0.31, 0.31, 1)
const lightGray = new vec4(0.4, 0.4, 0.4, 1)

const bgDarkGray = new vec4(0.15, 0.15, 0.15, 1)
const bgMediumGray = new vec4(0.2, 0.2, 0.2, 1)
const bgLightGray = new vec4(0.25, 0.25, 0.25, 1)

const SCROLL_BAR_BACKGROUND_GRADIENT: GradientParameters = {
  enabled: true,
  type: "Rectangle",
  start: new vec2(0, -1),
  end: new vec2(0, 1),
  stop0: {enabled: true, percent: -1, color: bgMediumGray},
  stop1: {enabled: true, percent: 2, color: bgDarkGray}
}

const SCROLL_BAR_BACKGROUND_HOVERED_GRADIENT: GradientParameters = {
  enabled: true,
  type: "Rectangle",
  start: new vec2(0, -1),
  end: new vec2(0, 1),
  stop0: {enabled: true, percent: -1, color: bgLightGray},
  stop1: {enabled: true, percent: 2, color: bgMediumGray}
}

const SCROLL_BAR_BACKGROUND_TRIGGERED_GRADIENT: GradientParameters = SCROLL_BAR_BACKGROUND_HOVERED_GRADIENT

const SCROLL_BAR_BACKGROUND_INACTIVE_GRADIENT: GradientParameters = {
  enabled: true,
  type: "Rectangle",
  start: new vec2(0, -1),
  end: new vec2(0, 1),
  stop0: {enabled: true, percent: 0, color: withAlpha(bgMediumGray, 0)},
  stop1: {enabled: true, percent: 1, color: withAlpha(bgDarkGray, 0)}
}

// System3 track: idle-hidden to match the idle-invisible knob — transparent at
// idle/inactive, gray on hover / direct interaction.
const SCROLL_BAR_BACKGROUND_GRADIENT_SYSTEM3: GradientParameters = {
  enabled: true,
  type: "Rectangle",
  start: new vec2(0, -1),
  end: new vec2(0, 1),
  stop0: {enabled: true, percent: -1, color: withAlpha(bgMediumGray, 0)},
  stop1: {enabled: true, percent: 2, color: withAlpha(bgDarkGray, 0)}
}

const SCROLL_BAR_BACKGROUND_HOVERED_GRADIENT_SYSTEM3: GradientParameters = SCROLL_BAR_BACKGROUND_HOVERED_GRADIENT

const SCROLL_BAR_BACKGROUND_TRIGGERED_GRADIENT_SYSTEM3: GradientParameters = SCROLL_BAR_BACKGROUND_HOVERED_GRADIENT

const SCROLL_BAR_BACKGROUND_INACTIVE_GRADIENT_SYSTEM3: GradientParameters = SCROLL_BAR_BACKGROUND_GRADIENT_SYSTEM3

const SCROLL_BAR_KNOB_GRADIENT: GradientParameters = {
  enabled: true,
  type: "Rectangle",
  stop0: {enabled: true, percent: -1, color: darkGray},
  stop1: {enabled: true, percent: -0.25, color: darkGray},
  stop2: {enabled: true, percent: 2, color: mediumGray}
}

const SCROLL_BAR_KNOB_HOVERED_GRADIENT: GradientParameters = {
  enabled: true,
  type: "Rectangle",
  stop0: {enabled: true, percent: -1, color: mediumGray},
  stop1: {enabled: true, percent: -0.25, color: mediumGray},
  stop2: {enabled: true, percent: 2, color: lightGray}
}

const SCROLL_BAR_KNOB_TRIGGERED_GRADIENT: GradientParameters = SCROLL_BAR_KNOB_HOVERED_GRADIENT

const SCROLL_BAR_KNOB_INACTIVE_GRADIENT: GradientParameters = {
  enabled: true,
  type: "Rectangle",
  stop0: {enabled: true, percent: -1, color: withAlpha(darkGray, 0)},
  stop1: {enabled: true, percent: -0.25, color: withAlpha(darkGray, 0)},
  stop2: {enabled: true, percent: 2, color: withAlpha(mediumGray, 0)}
}

// System3 (DS3.0) knob states (matches the 3.0 scrollbar mock):
//   idle        → invisible (transparent)
//   hovered     → gray (indirect interaction / hover)
//   triggered   → magenta→cyan linear gradient along the thumb length
//   inactive    → invisible
// Selected when the resolved theme is System3; the gray set above is the
// classic System2 look.
const s3Magenta = new vec4(0.42, 0.32, 0.62, 1)
const s3Cyan = new vec4(0.28, 0.5, 0.52, 1)

const SCROLL_BAR_KNOB_GRADIENT_SYSTEM3: GradientParameters = {
  enabled: true,
  type: "Linear",
  start: new vec2(-1, 0),
  end: new vec2(1, 0),
  stop0: {enabled: true, percent: 0, color: withAlpha(mediumGray, 0)},
  stop1: {enabled: true, percent: 1, color: withAlpha(mediumGray, 0)}
}

const SCROLL_BAR_KNOB_HOVERED_GRADIENT_SYSTEM3: GradientParameters = {
  enabled: true,
  type: "Linear",
  start: new vec2(-1, 0),
  end: new vec2(1, 0),
  stop0: {enabled: true, percent: 0, color: mediumGray},
  stop1: {enabled: true, percent: 1, color: lightGray}
}

const SCROLL_BAR_KNOB_TRIGGERED_GRADIENT_SYSTEM3: GradientParameters = {
  enabled: true,
  type: "Linear",
  start: new vec2(-1, 0),
  end: new vec2(1, 0),
  stop0: {enabled: true, percent: 0, color: s3Magenta},
  stop1: {enabled: true, percent: 1, color: s3Cyan}
}

const SCROLL_BAR_KNOB_INACTIVE_GRADIENT_SYSTEM3: GradientParameters = SCROLL_BAR_KNOB_GRADIENT_SYSTEM3

@component
export class ScrollBar extends BaseScriptComponent {
  @input("int", "0")
  private _renderOrder: number = 0

  @input
  private _size: vec2 = new vec2(20, 1.8)

  @input
  @widget(new ComboBoxWidget([new ComboBoxItem("Horizontal", "Horizontal"), new ComboBoxItem("Vertical", "Vertical")]))
  private orientation: string = "Vertical"

  @input
  @label("Theme")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Inherited", "Inherited"),
      new ComboBoxItem("System 2.0", "System2"),
      new ComboBoxItem("System 3.0", "System3")
    ])
  )
  @hint(
    "Inherited follows the global theme. System 2.0 = classic always-visible gray knob. System 3.0 = magenta→cyan gradient thumb with scroll auto-hide."
  )
  private _themeOverride: string = "Inherited"

  // Optional so a bar built from code can be given its window with setScrollWindow.
  @input
  @allowUndefined
  private scrollWindow: ScrollWindow

  @input
  private _playAudio: boolean = false

  private slider: Slider
  private _trackVisual: RoundedRectangleVisual | undefined
  private _knobVisual: RoundedRectangleVisual | undefined

  private contentLength: number = 0

  private get windowSize(): number {
    if (!this.scrollWindow) return 0
    if (this.orientation === ScrollOrientation.Horizontal) {
      return this.scrollWindow.windowSize.x
    } else {
      return this.scrollWindow.windowSize.y
    }
  }

  private _inactive: boolean = false

  private initialized: boolean = false
  private started: boolean = false

  private isDraggingSlider: boolean = false
  /** Borrowed by ScrollWindow while sampling; fully overwritten whenever refreshed. */
  private readonly velocitySampleScale: vec2 = vec2.zero()
  private velocitySampleScaleDirty: boolean = true
  private _currentValue: number = 0

  // System3 auto-hide: show the bar (gray) on ANY scroll activity, then slowly
  // fade it back out after a full second of no scrolling. Direct hover/drag on
  // the bar is left to the slider's own state machine.
  private _barHovered: boolean = false
  private _lastScrollTime: number = -Infinity
  private static readonly SCROLL_SHOW_HOLD = 1.0 // seconds visible after last scroll
  private static readonly SCROLL_FADE_DURATION = 0.5 // seconds to fade out

  private unsubscribes: unsubscribe[] = []

  private onScrolledEvent: Event<number> = new Event()

  /**
   * Sets the size of the scrollbar track.
   *
   * @param sz - The new size as a vec2 (x = length along scroll axis, y = thickness).
   */
  public set size(sz: vec2) {
    this.invalidateVelocitySampleScale()
    this._size = sz
    if (this.initialized) {
      this.slider.size = new vec3(sz.x, sz.y, 1)
      if (this._trackVisual) {
        this._trackVisual.cornerRadius = sz.y * 0.5
      }
      this.updateSliderKnobSize()
    }
  }

  /**
   * Gets the size of the scrollbar track.
   *
   * @returns {vec2} The current size (x = length, y = thickness).
   */
  public get size(): vec2 {
    return this._size
  }

  /**
   * Event that is invoked when the scrollbar value changes.
   * Provides the current normalized value (0-1) of the scrollbar position.
   */
  public readonly onScrolled: PublicApi<number> = this.onScrolledEvent.publicApi()

  /**
   * Gets whether audio should be played for scrollbar interactions.
   *
   * @returns {boolean} `true` if audio should be played; otherwise, `false`.
   */
  public get playAudio(): boolean {
    return this._playAudio
  }

  /**
   * Sets whether audio should be played for scrollbar interactions.
   *
   * @param playAudio - A boolean indicating whether audio should be played (`true`) or not (`false`).
   */
  public set playAudio(playAudio: boolean) {
    if (playAudio === undefined) {
      return
    }
    this._playAudio = playAudio
    if (this.initialized) {
      this.slider.playAudio = playAudio
    }
  }

  /**
   * Gets the render order of the scrollbar.
   *
   * @returns {number} The render order of the scrollbar.
   */
  public get renderOrder(): number {
    return this._renderOrder
  }

  /**
   * Sets the render order of the scrollbar.
   *
   * @param order - The render order of the scrollbar.
   */
  public set renderOrder(order: number) {
    if (order === undefined) {
      return
    }
    this._renderOrder = order
    if (this.initialized) {
      this.slider.renderOrder = order
    }
  }

  /**
   * Gets the track visual of the scrollbar.
   *
   * @returns {RoundedRectangleVisual | undefined} The track visual of the scrollbar.
   */
  public get trackVisual(): RoundedRectangleVisual | undefined {
    return this._trackVisual
  }

  /**
   * Sets the track visual of the scrollbar.
   *
   * @param visual - The new track visual of the scrollbar.
   */
  public set trackVisual(visual: RoundedRectangleVisual | undefined) {
    if (visual === undefined) {
      return
    }
    if (isEqual<RoundedRectangleVisual>(this._trackVisual, visual)) {
      return
    }
    this._trackVisual = visual
    if (this.initialized) {
      this.slider.visual = this._trackVisual
    }
  }

  /**
   * Gets the knob visual of the scrollbar.
   *
   * @returns {RoundedRectangleVisual | undefined} The knob visual of the scrollbar.
   */
  public get knobVisual(): RoundedRectangleVisual | undefined {
    return this._knobVisual
  }

  /**
   * Sets the knob visual of the scrollbar.
   *
   * @param visual - The new knob visual of the scrollbar.
   */
  public set knobVisual(visual: RoundedRectangleVisual | undefined) {
    if (visual === undefined) {
      return
    }
    if (isEqual<RoundedRectangleVisual>(this._knobVisual, visual)) {
      return
    }
    this._knobVisual = visual
    if (this.initialized) {
      this.slider.knobVisual = this._knobVisual
    }
  }

  /**
   * Gets whether the scrollbar is inactive.
   *
   * @returns {boolean} `true` if the scrollbar is inactive; otherwise, `false`.
   */
  public get inactive(): boolean {
    return this._inactive
  }

  /**
   * Sets whether the scrollbar is inactive.
   *
   * @param inactive - A boolean indicating whether the scrollbar should be inactive (`true`) or not (`false`).
   */
  public set inactive(inactive: boolean) {
    if (inactive === undefined) {
      return
    }
    this._inactive = inactive
    if (this.initialized) {
      this.updateSliderVisibility()
    }
  }

  /**
   * Gets whether the scrollbar is scrollable.
   *
   * @returns {boolean} `true` if the scrollbar is scrollable; otherwise, `false`.
   */
  public get isScrollable(): boolean {
    if (!this.scrollWindow) {
      return false
    }
    return (
      ((this.orientation === ScrollOrientation.Horizontal && this.scrollWindow.horizontal) ||
        (this.orientation === ScrollOrientation.Vertical && this.scrollWindow.vertical)) &&
      this.contentLength > this.windowSize
    )
  }

  /**
   * Gets the current value of the scrollbar.
   *
   * @returns {number} The current value of the scrollbar.
   */
  public get currentValue(): number {
    return this._currentValue
  }

  /**
   * Sets the ScrollWindow this bar scrolls, for a bar built from code. Call it before the bar
   * starts; a bar that started without one builds itself once it has it. A bar that has built
   * keeps its window.
   *
   * @param scrollWindow - The ScrollWindow to scroll. It must scroll along the bar's orientation.
   */
  public setScrollWindow(scrollWindow: ScrollWindow): void {
    if (!scrollWindow || scrollWindow === this.scrollWindow) {
      return
    }
    if (this.isBuilt("setScrollWindow")) {
      return
    }
    this.scrollWindow = scrollWindow
    if (this.started) {
      this.build()
    }
  }

  /**
   * Sets whether the bar follows the window's horizontal or vertical scroll. Vertical by default.
   * Call it before the bar builds. The bar always draws along its object's X axis, so rotate a
   * vertical bar's object 90 degrees about Z, as UIKit's example prefab does.
   *
   * @param orientation - "Horizontal" or "Vertical".
   */
  public setOrientation(orientation: "Horizontal" | "Vertical"): void {
    if (orientation !== ScrollOrientation.Horizontal && orientation !== ScrollOrientation.Vertical) {
      return
    }
    if (this.isBuilt("setOrientation")) {
      return
    }
    this.orientation = orientation
  }

  /**
   * Pins the bar to a theme instead of the global one, as the Inspector's Theme does. Call it
   * before the bar builds.
   *
   * @param theme - "Inherited", "System2" or "System3".
   */
  public setThemeOverride(theme: string): void {
    if (theme === undefined || this.isBuilt("setThemeOverride")) {
      return
    }
    this._themeOverride = theme
  }

  // A bar builds its slider and visuals once, from its window, orientation and theme.
  private isBuilt(setter: string): boolean {
    if (this.slider === undefined) {
      return false
    }
    log.w(`${setter} on ${this.sceneObject.name} has no effect once the bar has built; call it before the bar starts`)
    return true
  }

  /**
   * Lifecycle method called when the component awakens. The bar builds its slider, visuals and
   * event handlers when it starts, or once it has a window if it starts without one.
   */
  public onAwake() {
    this.createEvent("OnStartEvent").bind(() => {
      this.started = true
      if (this.scrollWindow) {
        this.build()
      } else {
        log.w(`${this.sceneObject.name} started without a ScrollWindow; it builds once setScrollWindow gives it one`)
      }
    })
  }

  private build(): void {
    if (this.orientation === ScrollOrientation.Horizontal) {
      if (!this.scrollWindow.horizontal) {
        throw new Error(
          "Error setting up scrollbar: ScrollWindow orientation is not compatible with horizontal scrollbar"
        )
      }
    } else if (this.orientation === ScrollOrientation.Vertical) {
      if (!this.scrollWindow.vertical) {
        throw new Error(
          "Error setting up scrollbar: ScrollWindow orientation is not compatible with vertical scrollbar"
        )
      }
    }

    const sliderObject = global.scene.createSceneObject("ScrollBarSlider")
    sliderObject.setParent(this.sceneObject)
    this.slider = sliderObject.createComponent(Slider.getTypeName())
    this.slider.knobCornerRadiusOverride = this._size.y * 0.5
    this.setupDefaultVisuals()
    this.slider.visual = this._trackVisual
    this.slider.knobVisual = this._knobVisual
    this.slider.hasTrackVisual = false
    this.slider.playAudio = this._playAudio
    // A late setScrollWindow can build a bar whose component is disabled. Its slider stays off
    // until the bar's OnEnable, which also subscribes to the window.
    this.slider.enabled = this.enabled

    this.updateContentLength()

    this.slider.onInitialized.add(() => {
      this.initialized = true
      this.slider.size = new vec3(this.size.x, this.size.y, 1)
      this.slider.renderOrder = this._renderOrder
      if (this.enabled && this.unsubscribes.length === 0) {
        this.setupScrollWindowEventHandlers()
        this.setupSliderEventHandlers()
      }
      this.updateSliderKnobPosition()
      this.updateSliderKnobSize()
      this.updateSliderVisibility()
    })

    this.createEvent("UpdateEvent").bind(() => {
      this.updateScrollFade()
    })

    this.createEvent("OnEnableEvent").bind(() => {
      if (this.unsubscribes.length === 0) {
        this.setupScrollWindowEventHandlers()
        this.setupSliderEventHandlers()
      }
      this.slider.enabled = true
    })
    this.createEvent("OnDisableEvent").bind(() => {
      this.finishSliderDrag()
      this.unsubscribes.forEach((unsubscribe) => unsubscribe())
      this.unsubscribes = []
      this.slider.enabled = false
    })
    this.createEvent("OnDestroyEvent").bind(() => {
      this.finishSliderDrag()
      this.unsubscribes.forEach((unsubscribe) => unsubscribe())
      this.unsubscribes = []
      if (!isNull(this.slider)) {
        this.slider.sceneObject.destroy()
      }
    })
    this.slider.createEvent("OnDestroyEvent").bind(() => {
      this.finishSliderDrag()
      this.unsubscribes.forEach((unsubscribe) => unsubscribe())
      this.unsubscribes = []
    })
  }

  // Resolved theme: an explicit override wins; "Inherited" (and the legacy
  // serialized "Default") follows the global ThemeService theme.
  private get isSystem3Theme(): boolean {
    // Normalized so a pre-rename explicit override ("SnapOS3") is still treated
    // as explicit, rather than falling through to the global theme.
    switch (normalizeThemeName(this._themeOverride)) {
      case SYSTEM_3_NAME:
        return true
      case SYSTEM_2_NAME:
        return false
      default:
        return ThemeService.getInstance().currentTheme.name === SYSTEM_3_NAME
    }
  }

  private setupDefaultVisuals() {
    const isSystem3Track = this.isSystem3Theme
    if (this._trackVisual === undefined) {
      const trackDefault = isSystem3Track ? SCROLL_BAR_BACKGROUND_GRADIENT_SYSTEM3 : SCROLL_BAR_BACKGROUND_GRADIENT
      const trackHovered = isSystem3Track
        ? SCROLL_BAR_BACKGROUND_HOVERED_GRADIENT_SYSTEM3
        : SCROLL_BAR_BACKGROUND_HOVERED_GRADIENT
      const trackTriggered = isSystem3Track
        ? SCROLL_BAR_BACKGROUND_TRIGGERED_GRADIENT_SYSTEM3
        : SCROLL_BAR_BACKGROUND_TRIGGERED_GRADIENT
      const trackInactive = isSystem3Track
        ? SCROLL_BAR_BACKGROUND_INACTIVE_GRADIENT_SYSTEM3
        : SCROLL_BAR_BACKGROUND_INACTIVE_GRADIENT
      const trackParameters: Partial<RoundedRectangleVisualParameters> = {
        default: {
          baseType: "Gradient",
          hasBorder: false,
          baseGradient: gradientParameterClone(trackDefault)
        },
        hovered: {
          baseGradient: gradientParameterClone(trackHovered)
        },
        triggered: {
          baseGradient: gradientParameterClone(trackTriggered)
        },
        inactive: {
          baseGradient: gradientParameterClone(trackInactive)
        }
      }
      this._trackVisual = new RoundedRectangleVisual({
        sceneObject: this.slider.sceneObject,
        style: trackParameters,
        transparent: true
      })
      this._trackVisual.renderMeshVisual.mainPass.blendMode = BlendMode.PremultipliedAlphaAuto
      this._trackVisual.renderMeshVisual.mainPass.colorMask = new vec4b(true, true, true, true)
      this._trackVisual.shouldColorChange = true
      this._trackVisual.cornerRadius = this._size.y * 0.5
      this._trackVisual.initialize()
      // The auto-hide fade rests at opacity 0 and rewrites opacity every frame; skip the draw there.
      this._trackVisual.cullIncludesOpacity = true
    }
    if (this._knobVisual === undefined) {
      const isSystem3 = this.isSystem3Theme
      const knobDefault = isSystem3 ? SCROLL_BAR_KNOB_GRADIENT_SYSTEM3 : SCROLL_BAR_KNOB_GRADIENT
      const knobHovered = isSystem3 ? SCROLL_BAR_KNOB_HOVERED_GRADIENT_SYSTEM3 : SCROLL_BAR_KNOB_HOVERED_GRADIENT
      const knobTriggered = isSystem3 ? SCROLL_BAR_KNOB_TRIGGERED_GRADIENT_SYSTEM3 : SCROLL_BAR_KNOB_TRIGGERED_GRADIENT
      const knobInactive = isSystem3 ? SCROLL_BAR_KNOB_INACTIVE_GRADIENT_SYSTEM3 : SCROLL_BAR_KNOB_INACTIVE_GRADIENT
      const knobParameters: Partial<RoundedRectangleVisualParameters> = {
        default: {
          baseType: "Gradient",
          hasBorder: false,
          baseGradient: gradientParameterClone(knobDefault)
        },
        hovered: {
          baseGradient: gradientParameterClone(knobHovered)
        },
        triggered: {
          baseGradient: gradientParameterClone(knobTriggered)
        },
        inactive: {
          baseGradient: gradientParameterClone(knobInactive)
        }
      }
      const knobObject = global.scene.createSceneObject("ScrollBarKnob")
      knobObject.setParent(this.slider.sceneObject)
      this._knobVisual = new RoundedRectangleVisual({
        sceneObject: knobObject,
        style: knobParameters,
        transparent: true
      })
      this._knobVisual.renderMeshVisual.mainPass.blendMode = BlendMode.PremultipliedAlphaAuto
      this._knobVisual.renderMeshVisual.mainPass.colorMask = new vec4b(true, true, true, true)
      this._knobVisual.shouldColorChange = true
      this._knobVisual.initialize()
      this._knobVisual.cullIncludesOpacity = true
    }
  }

  private setupScrollWindowEventHandlers() {
    this.unsubscribes.push(
      this.scrollWindow.onScrollDimensionsUpdated.add(() => {
        this.updateContentLength()
        this.updateSliderKnobPosition()
        this.updateSliderKnobSize()
        this.updateSliderVisibility()
      })
    )
    this.unsubscribes.push(
      this.scrollWindow.onSizeChanged.add(() => {
        this.invalidateVelocitySampleScale()
        this.updateSliderKnobPosition()
        this.updateSliderKnobSize()
        this.updateSliderVisibility()
      })
    )
    this.unsubscribes.push(
      this.scrollWindow.onScrollPositionUpdated.add(() => {
        // Any scroll — direct on the bar or indirect in the window — shows the
        // bar and (re)starts the fade-out timer.
        this.restartScrollFadeHold()
        if (!this.isDraggingSlider) {
          this.updateSliderKnobPosition()
        }
      })
    )
  }

  private setupSliderEventHandlers() {
    this.unsubscribes.push(
      this.slider.interactable.onHoverEnter.add(() => {
        this._barHovered = true
      })
    )
    this.unsubscribes.push(
      this.slider.interactable.onHoverExit.add(() => {
        this._barHovered = false
        this.restartScrollFadeHold()
      })
    )

    this.unsubscribes.push(
      this.slider.onTriggerDown.add(() => {
        // Transform has no change notification, so snapshot the exact
        // directional world scales once at the start of every scrub.
        this.refreshVelocitySampleScale()
        this.isDraggingSlider = true
        this.scrollWindow.isControlledExternally = true
      })
    )

    this.unsubscribes.push(
      this.slider.onTriggerUp.add(() => {
        this.finishSliderDrag(true)
        this.restartScrollFadeHold()
      })
    )

    // Element only forwards the interactable's onTriggerEnd to slider.onTriggerUp,
    // so end-outside and cancel must be handled at the interactable level to
    // release external control on every way a scrub can finish.
    this.unsubscribes.push(
      this.slider.interactable.onTriggerEndOutside.add(() => {
        this.finishSliderDrag(true)
        this.restartScrollFadeHold()
      })
    )

    this.unsubscribes.push(
      this.slider.interactable.onTriggerCanceled.add(() => {
        this.finishSliderDrag()
        this.restartScrollFadeHold()
      })
    )

    this.unsubscribes.push(
      this.slider.onKnobMoved.add(() => {
        if (this.isDraggingSlider) {
          const sliderValue = this.slider.knobValue
          if (this.scrollWindow) {
            const normalizedPosition = this.scrollWindow.scrollPositionNormalized
            // scrollPositionNormalized is reading-order 0..1 (0 = top/left);
            // the vertical binding keeps the classic knob orientation
            // (knob 1 = content top), so the vertical axis inverts.
            if (this.orientation === ScrollOrientation.Horizontal) {
              normalizedPosition.x = sliderValue
            } else if (this.orientation === ScrollOrientation.Vertical) {
              normalizedPosition.y = 1 - sliderValue
            }
            this.scrollWindow.setExternalScrollPositionNormalized(normalizedPosition, this.getVelocitySampleScale())
          }
          if (this._currentValue !== sliderValue) {
            this._currentValue = sliderValue
            this.onScrolledEvent.invoke(this._currentValue)
          }
        }
      })
    )
  }

  /** Ends a thumb scrub exactly once, handing normal releases to the assigned ScrollWindow's physics. */
  private finishSliderDrag(allowFling: boolean = false): void {
    if (!this.isDraggingSlider) return
    this.isDraggingSlider = false
    if (this.scrollWindow && !isNull(this.scrollWindow)) {
      this.scrollWindow.releaseExternalControl(allowFling)
    }
  }

  /**
   * Returns the cached conversion from sampled thumb velocity to the local hand
   * speed a direct ScrollWindow drag would have produced. Geometry changes mark
   * the cache dirty; transform changes are captured unconditionally at the next
   * trigger-down because Lens exposes no general transform-change notification.
   */
  private getVelocitySampleScale(): vec2 {
    if (this.velocitySampleScaleDirty) {
      this.refreshVelocitySampleScale()
    }
    return this.velocitySampleScale
  }

  private invalidateVelocitySampleScale(): void {
    this.velocitySampleScaleDirty = true
  }

  /** Recomputes the cached scale without allocating a per-sample result vector. */
  private refreshVelocitySampleScale(): void {
    const result = this.velocitySampleScale
    result.x = 0
    result.y = 0

    const contentTravel = this.contentLength - this.windowSize
    const thumbTravel = this.slider.size.x - this.slider.knobSize.x
    if (!Number.isFinite(contentTravel) || !Number.isFinite(thumbTravel) || contentTravel <= 0 || thumbTravel <= 0) {
      this.velocitySampleScaleDirty = false
      return
    }

    const sliderAxisScale = this.slider.sceneObject
      .getTransform()
      .getWorldTransform()
      .multiplyDirection(vec3.right()).length
    const scrollAxis = this.orientation === ScrollOrientation.Horizontal ? vec3.right() : vec3.up()
    const scrollWindowAxisScale = this.scrollWindow.sceneObject
      .getTransform()
      .getWorldTransform()
      .multiplyDirection(scrollAxis).length
    const axisScale = (thumbTravel * sliderAxisScale) / (contentTravel * scrollWindowAxisScale)
    const safeAxisScale =
      Number.isFinite(sliderAxisScale) &&
      Number.isFinite(scrollWindowAxisScale) &&
      sliderAxisScale > 0 &&
      scrollWindowAxisScale > 0 &&
      Number.isFinite(axisScale) &&
      axisScale >= 0
        ? axisScale
        : 0

    if (this.orientation === ScrollOrientation.Horizontal) {
      result.x = safeAxisScale
    } else {
      result.y = safeAxisScale
    }
    this.velocitySampleScaleDirty = false
  }

  private updateContentLength() {
    this.invalidateVelocitySampleScale()
    if (this.scrollWindow) {
      const scrollDimensions = this.scrollWindow.scrollDimensions
      if (this.orientation === ScrollOrientation.Horizontal) {
        if (scrollDimensions.x === -1) {
          throw new Error(
            "Error setting up scrollbar: ScrollWindow horizontal dimension is not compatible with horizontal scrollbar"
          )
        } else {
          this.contentLength = scrollDimensions.x
        }
      } else if (this.orientation === ScrollOrientation.Vertical) {
        if (scrollDimensions.y === -1) {
          throw new Error(
            "Error setting up scrollbar: ScrollWindow vertical dimension is not compatible with vertical scrollbar"
          )
        } else {
          this.contentLength = scrollDimensions.y
        }
      }
    }
  }

  private updateSliderKnobPosition() {
    if (this.slider) {
      let scrollPosition = 0
      if (this.orientation === ScrollOrientation.Horizontal) {
        scrollPosition = this.scrollWindow.scrollPositionNormalized.x
      } else if (this.orientation === ScrollOrientation.Vertical) {
        // Reading-order 0..1 space; vertical inverts to keep the classic knob
        // orientation (knob 1 = content top).
        scrollPosition = 1 - this.scrollWindow.scrollPositionNormalized.y
      }

      const newCurrentValue = clamp(scrollPosition, 0, 1)
      if (this._currentValue !== newCurrentValue) {
        this._currentValue = newCurrentValue
        this.slider.currentValue = this._currentValue
        this.onScrolledEvent.invoke(this._currentValue)
      }
    }
  }

  private updateSliderKnobSize() {
    if (this.slider && this._knobVisual) {
      // Mark dirty before mutating Slider dimensions: its setters can
      // synchronously reposition the knob and emit onKnobMoved.
      this.invalidateVelocitySampleScale()
      const width = this.slider.customKnobSize ? this.slider.knobSize.y : this.slider.size.y
      let length = this.slider.size.x
      if (this.contentLength > 0) {
        length *= Math.min(this.windowSize / this.contentLength, 1)
      }
      this.slider.knobSize = new vec2(Math.max(length, width), width)
      this.slider.knobCornerRadiusOverride = width * 0.5
    }
  }

  private updateSliderVisibility() {
    if (this.slider) {
      this.slider.inactive = this._inactive
      this.slider.interactable.enabled = this.isScrollable
    }
  }

  private restartScrollFadeHold(): void {
    this._lastScrollTime = getTime()
  }

  // System3 auto-hide fade. Direct hover/drag is left to the slider's own state
  // machine (full opacity). Otherwise the bar shows gray on scroll, holds for
  // SCROLL_SHOW_HOLD, then fades opacity to 0 over SCROLL_FADE_DURATION. The
  // System2 theme keeps the bar always visible.
  private updateScrollFade(): void {
    if (!this.isSystem3Theme || !this._trackVisual || !this._knobVisual) {
      return
    }
    // Inactive and non-scrollable state is applied by updateSliderVisibility;
    // the fade loop must not replace it with hovered visuals or positive opacity.
    if (this._inactive || !this.isScrollable) {
      return
    }
    // Direct interaction with the bar: the slider drives the visual state; just
    // make sure it's fully opaque.
    if (this._barHovered || this.isDraggingSlider) {
      this._trackVisual.opacity = 1
      this._knobVisual.opacity = 1
      return
    }
    const elapsed = getTime() - this._lastScrollTime
    const hold = ScrollBar.SCROLL_SHOW_HOLD
    const fade = ScrollBar.SCROLL_FADE_DURATION
    let opacity: number
    if (elapsed <= hold) {
      opacity = 1
    } else if (elapsed < hold + fade) {
      opacity = 1 - (elapsed - hold) / fade
    } else {
      opacity = 0
    }
    // Show the gray (hovered) look while scroll-visible so indirect scrolling
    // reads the same as a hover.
    if (opacity > 0) {
      this._trackVisual.setState(StateName.hovered)
      this._knobVisual.setState(StateName.hovered)
    }
    this._trackVisual.opacity = opacity
    this._knobVisual.opacity = opacity
  }
}

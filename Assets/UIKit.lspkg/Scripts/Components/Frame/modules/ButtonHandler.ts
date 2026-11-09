import {Button} from "../../Button/Button"
import {ElementContent} from "../../Content/ElementContent"
import {Frame} from "../Frame"
import {FRAME_BUTTON_SETTINGS_BY_APPEARANCE} from "../FrameButtonSettings"
import {FramePanelVisual, PANEL_CLOSE_BUTTON_DEPTH} from "../FramePanelVisual"

const CLASSIC_BUTTON_DEPTH = 1

type ButtonConfig = {
  imageTexture: Texture
  type: "close" | "follow"
  isToggle?: boolean
}

type ButtonHandlerConfig = {
  frame: Frame
  onButtonTriggerUp: () => void
}

const closeIcon: Texture = requireAsset("Icons.lspkg/Iconography/System/close.png") as Texture
const followIcon: Texture = requireAsset("Icons.lspkg/Iconography/System/follow.png") as Texture

/**
 * ButtonHandler — manages the close button on every frame, and the follow
 * button for System2 (classic) frames. System3 (panel) frames route follow
 * through {@link RightDrawer} instead, so on panel frames this module owns
 * only the close button.
 *
 * Both themes use the same `Button` + `ElementContent` companion structure;
 * the only differences are theme/shape/style/depth. ElementContent's
 * theme-driven icon tint means System2 icons now respond to state on
 * hover/triggered transitions, where the previous static `Component.Image`
 * approach kept the icon at texture color.
 */
export default class ButtonHandler {
  public closeButton: Button
  public followButton: Button

  private closeContent: ElementContent | null = null
  private followContent: ElementContent | null = null
  private _opacity: number = 1
  private _renderOrder: number = 0
  private _runtimeEnabled: boolean = true
  private _destroyed: boolean = false

  private _closeButtonOffset: vec3 = vec3.zero()
  private _closeButtonEnabled: boolean = false
  private _closeButtonSuppressed: boolean = false
  public set closeButtonOffset(value: vec3) {
    if (value === undefined) {
      return
    }
    this._closeButtonOffset = value
    this.resize()
  }
  public get closeButtonOffset(): vec3 {
    return this._closeButtonOffset
  }

  private _followButtonOffset: vec3 = vec3.zero()
  private _followButtonEnabled: boolean = false
  public set followButtonOffset(value: vec3) {
    if (value === undefined) {
      return
    }
    this._followButtonOffset = value
    this.resize()
  }
  public get followButtonOffset(): vec3 {
    return this._followButtonOffset
  }

  private frame: Frame = this.options.frame

  public constructor(private options: ButtonHandlerConfig) {}

  public enableCloseButton(enable: boolean) {
    if (this._destroyed) return
    this._closeButtonEnabled = enable
    // Creation follows the request, not the composed visibility: a composing
    // component may ask for the affordance while its own policy withholds it,
    // and callers still expect `frame.closeButton` to exist so they can wire
    // an icon or a handler to it.
    if (enable && !this.closeButton) {
      this.createButton({type: "close", imageTexture: closeIcon})
    }
    this.refreshCloseButtonState()
  }

  /**
   * Withholds the close affordance without touching the request, so a
   * composing component's policy cannot be punched open by a consumer setting
   * {@link Frame.showCloseButton}. The request is re-derived when suppression
   * lifts, so a write made during the window lands intact.
   */
  public setCloseButtonSuppressed(suppressed: boolean): void {
    if (this._destroyed) return
    this._closeButtonSuppressed = suppressed
    this.refreshCloseButtonState()
  }

  private refreshCloseButtonState(): void {
    if (!this.closeButton) return
    this.applyButtonState(this.closeButton, this.closeContent, this._closeButtonEnabled && !this._closeButtonSuppressed)
  }

  /**
   * Enable/disable the follow button. On System3 (panel) frames this is a
   * no-op — the follow button lives in {@link RightDrawer} instead.
   */
  public enableFollowButton(enable: boolean) {
    if (this.isPanel || this._destroyed) return
    this._followButtonEnabled = enable
    if (enable && !this.followButton) {
      this.createButton({type: "follow", imageTexture: followIcon, isToggle: true})
    }
    if (this.followButton) this.applyButtonState(this.followButton, this.followContent, enable)
    this.resize()
  }

  /** Suspend hit-testing/visuals without changing authored enabled states. */
  public setRuntimeEnabled(enabled: boolean): void {
    if (this._destroyed) return
    this._runtimeEnabled = enabled
    this.refreshCloseButtonState()
    if (this.followButton) this.applyButtonState(this.followButton, this.followContent, this._followButtonEnabled)
  }

  /** Stop updating buttons; child SceneObjects die with the Frame visual. */
  public destroy(): void {
    this._destroyed = true
  }

  private get isPanel(): boolean {
    return this.frame.frameVisual instanceof FramePanelVisual
  }

  private createButton(config: ButtonConfig): void {
    const settings = FRAME_BUTTON_SETTINGS_BY_APPEARANCE[this.frame.appearance]
    const isPanel = this.isPanel

    const buttonObject = global.scene.createSceneObject("FrameButton")
    buttonObject.setParent(this.frame.frameObject)
    buttonObject.layer = this.frame.frameObject.layer

    const thisButton = buttonObject.createComponent(Button.getTypeName()) as Button
    if (isPanel) {
      thisButton.setVariant({theme: "System 3.0", shape: "Rectangle", style: "Prism"})
      // Depth comes from FramePanelVisual.PANEL_CLOSE_BUTTON_DEPTH; the
      // anchor z in FramePanelVisual.getButtonAnchor("close", …) is half
      // this so the back face lands flush with the body's front plane.
      thisButton.size = new vec3(settings.buttonSize, settings.buttonSize, PANEL_CLOSE_BUTTON_DEPTH)
    } else {
      thisButton.setVariant({theme: "System 2.0", shape: "Round", style: "PrimaryNeutral"})
      thisButton.size = new vec3(settings.buttonSize, settings.buttonSize, CLASSIC_BUTTON_DEPTH)
    }

    thisButton.onTriggerUp.add(() => this.options.onButtonTriggerUp())
    if (config.isToggle) thisButton.setIsToggleable?.(true)
    thisButton.initialize()

    const content = buttonObject.createComponent(ElementContent.getTypeName()) as ElementContent
    content.leadingIconSize = settings.iconSize
    content.leadingIcon = config.imageTexture

    if (config.type === "close") {
      this.closeButton = thisButton
      this.closeContent = content
    } else {
      this.followButton = thisButton
      this.followContent = content
    }

    this.applyRenderOrder(thisButton, content)
    this.applyButtonState(thisButton, content, true)
    this.resize()
  }

  public resize() {
    if (this._destroyed) return
    const {buttonSize, offset} = FRAME_BUTTON_SETTINGS_BY_APPEARANCE[this.frame.appearance]
    const totalSize = this.frame.totalSize
    const visual = this.frame.frameVisual
    // Panel close button uses the Prism depth; classic buttons stay at 1.
    // Writing the wrong z here would clobber the depth set at creation,
    // which in turn breaks the back-face-flush-with-body alignment.
    const depth = this.isPanel ? PANEL_CLOSE_BUTTON_DEPTH : CLASSIC_BUTTON_DEPTH
    const size = new vec3(buttonSize, buttonSize, depth)

    if (this.closeButton) {
      this.closeButton.size = size
      const anchor = visual.getButtonAnchor("close", totalSize, buttonSize, offset)
      this.closeButton.transform.setLocalPosition(anchor.add(this._closeButtonOffset))
    }

    if (this.closeContent) {
      this.closeContent.leadingIconSize = FRAME_BUTTON_SETTINGS_BY_APPEARANCE[this.frame.appearance].iconSize
    }

    if (this.followButton) {
      this.followButton.size = size
      const anchor = visual.getButtonAnchor("follow", totalSize, buttonSize, offset)
      this.followButton.transform.setLocalPosition(anchor.add(this._followButtonOffset))
    }
    if (this.followContent) {
      this.followContent.leadingIconSize = FRAME_BUTTON_SETTINGS_BY_APPEARANCE[this.frame.appearance].iconSize
    }
  }

  public set opacity(alpha: number) {
    if (alpha === undefined) {
      return
    }
    if (this._destroyed) return
    this._opacity = alpha
    this.refreshCloseButtonState()
    if (this.followButton) this.applyButtonState(this.followButton, this.followContent, this._followButtonEnabled)
  }

  public set renderOrder(renderOrder: number) {
    if (renderOrder === undefined) {
      return
    }
    if (this._destroyed) return
    this._renderOrder = renderOrder
    if (this.closeButton) this.applyRenderOrder(this.closeButton, this.closeContent)
    if (this.followButton) this.applyRenderOrder(this.followButton, this.followContent)
  }

  private applyButtonState(button: Button, content: ElementContent | null, enabled: boolean): void {
    const visible = enabled && this._runtimeEnabled && this._opacity > 0
    button.sceneObject.enabled = visible
    button.opacity = this._opacity
    if (content) {
      content.opacity = this._opacity
      content.setRenderingEnabled(visible)
    }
  }

  private applyRenderOrder(button: Button, content: ElementContent | null): void {
    button.renderOrder = this._renderOrder
    // Flat renderOrder: under the frame's canvas, layering comes from
    // hierarchy order (icon container is a child of the button object) plus
    // ElementContent's z gap — offsets would override the canvas sorting.
    if (content) content.renderOrder = this._renderOrder
  }
}

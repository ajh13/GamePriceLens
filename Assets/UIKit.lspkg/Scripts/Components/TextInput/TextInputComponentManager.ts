import {Singleton} from "InteractionKit.lspkg/Decorators/Singleton"
import {CancelToken, clearTimeout, setTimeout} from "InteractionKit.lspkg/Utils/FunctionTimingUtils"
import {BaseTextInputComponent} from "./BaseTextInputComponent"
import {KEYBOARD_DELAY_DEFAULT, KEYBOARD_DELAY_DESELECT} from "./TextInputConsts"

/**
 * TextInputComponentManager controls focus across all text input components
 * (both TextInputField and TextInputArea).
 * This class is created and handled automatically and dynamically.
 * You should not have to add it manually.
 * If you see it in the scene preview that is good!
 */
@Singleton
export class TextInputComponentManager {
  public static getInstance: () => TextInputComponentManager

  private activeTextInputComponent: BaseTextInputComponent | null = null
  private pendingFocusTextInputComponent: BaseTextInputComponent | null = null
  private pendingFocusCancelToken: CancelToken | null = null
  private recentlyClosed: boolean = false
  private recentlyClosedCancelToken: CancelToken | null = null
  private focusSwitchInProgress: boolean = false

  /**
   * True while the manager is blurring the previous field on behalf of a new one — i.e.
   * the blur a field is currently handling is a field switch, not a plain deselect. Blur
   * handlers use this to decide whether a refocus is imminent (e.g. the focus frame holds
   * its dock through a switch but flies home immediately on a plain deselect).
   */
  public get isFocusSwitchInProgress(): boolean {
    return this.focusSwitchInProgress
  }

  public requestFocus = (textInputComponent: BaseTextInputComponent): void => {
    if (this.activeTextInputComponent === textInputComponent) return

    const needsSwitchDelay = this.activeTextInputComponent !== null || this.recentlyClosed
    this.focusSwitchInProgress = true
    try {
      this.cancelPendingFocus()
      this.blurActive()
    } finally {
      this.focusSwitchInProgress = false
    }

    this.pendingFocusTextInputComponent = textInputComponent
    this.pendingFocusCancelToken = setTimeout(
      () => {
        if (this.pendingFocusTextInputComponent !== textInputComponent) return

        this.pendingFocusTextInputComponent = null
        this.pendingFocusCancelToken = null
        textInputComponent.editMode(true)
      },
      needsSwitchDelay ? KEYBOARD_DELAY_DESELECT : KEYBOARD_DELAY_DEFAULT
    )
  }

  public cancelFocusRequest = (textInputComponent: BaseTextInputComponent): void => {
    if (this.pendingFocusTextInputComponent !== textInputComponent) return

    this.cancelPendingFocus()
  }

  public registerActive = (textInputComponent: BaseTextInputComponent) => {
    if (this.activeTextInputComponent === textInputComponent) return

    this.focusSwitchInProgress = true
    try {
      this.cancelPendingFocus()
      this.blurActive()
    } finally {
      this.focusSwitchInProgress = false
    }
    this.activeTextInputComponent = textInputComponent
  }

  public deregisterActive = (textInputComponent: BaseTextInputComponent) => {
    this.cancelFocusRequest(textInputComponent)

    if (this.activeTextInputComponent !== textInputComponent) return

    this.activeTextInputComponent = null
    this.markRecentlyClosed()
  }

  private blurActive = (): void => {
    this.activeTextInputComponent?.editMode(false)
  }

  private cancelPendingFocus = (): void => {
    const pendingFocusTextInputComponent = this.pendingFocusTextInputComponent
    if (this.pendingFocusCancelToken) {
      clearTimeout(this.pendingFocusCancelToken)
    }
    pendingFocusTextInputComponent?.resetPendingFocusState()
    this.pendingFocusCancelToken = null
    this.pendingFocusTextInputComponent = null
  }

  private markRecentlyClosed = (): void => {
    this.recentlyClosed = true
    if (this.recentlyClosedCancelToken) {
      clearTimeout(this.recentlyClosedCancelToken)
    }
    this.recentlyClosedCancelToken = setTimeout(() => {
      this.recentlyClosed = false
      this.recentlyClosedCancelToken = null
    }, KEYBOARD_DELAY_DESELECT)
  }
}

import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import {TextAlignment} from "../../TextInput/TextInputConsts"
import {TextInputField} from "../../TextInputField/TextInputField"
import {
  getSizeModeFromSize,
  ToolbarAlignment,
  ToolbarDirections,
  ToolbarItemSizeMode,
  ToolbarTextFieldConfig
} from "../Types/ToolbarSchema"
import {ToolbarItem} from "./ToolbarItem"

const log = new NativeLogger("ToolbarTextField")

/**
 * Toolbar text field item. Obtain via {@link Toolbar.getItem} or {@link Toolbar.allItems}.
 */
@component
export class ToolbarTextField extends ToolbarItem {
  private readonly DEFAULT_WIDTH = 10.0
  private readonly DEFAULT_HEIGHT = 3.0
  private textField: TextInputField
  private textFieldConfig: ToolbarTextFieldConfig
  private userIsEditing: boolean = false

  /** Underlying text input field component. */
  public get textFieldComponent(): TextInputField {
    return this.textField
  }

  /** The field's current text. Forwards to {@link textFieldComponent}. */
  public get text(): string {
    return this.textField.text
  }

  public set text(value: string) {
    this.textField.text = value
  }

  /** Intrinsic size from config or defaults. */
  public get intrinsicSize(): vec2 {
    if (!this.textFieldConfig) {
      return new vec2(this.DEFAULT_WIDTH, this.DEFAULT_HEIGHT)
    }

    const sizeConfig = this.textFieldConfig.size
    if (sizeConfig instanceof vec2) {
      return new vec2(sizeConfig.x, sizeConfig.y)
    }

    if (typeof sizeConfig === "object") {
      const x = typeof sizeConfig.x === "number" ? sizeConfig.x : this.DEFAULT_WIDTH
      const y = typeof sizeConfig.y === "number" ? sizeConfig.y : this.DEFAULT_HEIGHT
      return new vec2(x, y)
    }

    return new vec2(this.DEFAULT_WIDTH, this.DEFAULT_HEIGHT)
  }

  /** Called by the toolbar when the item is created. Not intended for external callers. */
  public initializeWithConfig(config: ToolbarTextFieldConfig) {
    this.textFieldConfig = config
    // The base reads config.renderOrder through _config, and createTextField
    // runs before super.initializeWithConfig assigns it.
    this._config = config

    const size = this.intrinsicSize
    this._size = new vec3(size.x, size.y, 0)

    this.createTextField(config)

    super.initializeWithConfig(config)
  }

  /** Size mode: fill or manual from config.size. */
  public getSizeMode(): ToolbarItemSizeMode {
    return getSizeModeFromSize(this.textFieldConfig.size)
  }

  public applyLayoutSize(size: vec2, transpose: boolean): void {
    const contentSize = transpose ? new vec2(size.y, size.x) : size
    this.computedSize = size
    this.textFieldComponent.size = new vec3(contentSize.x, contentSize.y, 0)
    this.transform.setLocalScale(vec3.one())
  }

  public applyRenderOrder(renderOrder?: number): void {
    if (renderOrder === undefined) {
      return
    }
    this.textField.renderOrder = renderOrder
    if (this.textField.shadowVisual?.renderMeshVisual) {
      this.textField.shadowVisual.renderMeshVisual.renderOrder = renderOrder - 1
    }
  }

  public shouldTransposeLayout(): boolean {
    return this.getToolbarDirection() === ToolbarDirections.VERTICAL
  }

  public getAttachmentTargetSize(): vec2 {
    if (this.getToolbarDirection() !== ToolbarDirections.VERTICAL) {
      const actualSize = this.textFieldComponent.size
      if (actualSize.x > 0 && actualSize.y > 0) {
        return new vec2(actualSize.x, actualSize.y)
      }
    }
    return super.getAttachmentTargetSize()
  }

  protected onInactiveChanged(inactive: boolean): void {
    if (this.textField) {
      this.textField.inactive = inactive
    }
  }

  protected setVisualAlpha(_alpha: number, effectiveAlpha: number): void {
    // Drive the field's own opacity rather than individual sub-visuals: its
    // applyOpacity fades the body (and toggles transparencyEnabled), the text,
    // and the text-manipulation module, then TextInputField extends it to the
    // action-slot button and the clear button. Hand-poking visual/text/
    // actionSlotContent reached neither the clear button nor transparency.
    if (this.textField) {
      this.textField.opacity = effectiveAlpha
      // A faded-out field still costs render and mask work, and opacity alone
      // doesn't release it. This also holds the field's interaction components
      // disabled, which is safe here because hover auto-reveal watches the
      // toolbar's own background collider, not the items'.
      this.textField.setRenderingEnabled(effectiveAlpha !== 0)
    }

    // Not covered by applyOpacity: the drop shadow is a separate visual.
    if (this.textField?.shadowVisual?.renderMeshVisual?.mainMaterial?.mainPass) {
      this.textField.shadowVisual.renderMeshVisual.mainMaterial.mainPass.opacityFactor = effectiveAlpha
      this.textField.shadowVisual.renderMeshVisual.enabled = true
    }
  }

  private createTextField(config: ToolbarTextFieldConfig) {
    // Canonical TextInputField lives on the Content child so its own
    // ElementHandler owns size (its size setter batches the field relayout);
    // the wrapper anchor stays pinned at container-local origin, and the 90°
    // rotation for a vertical toolbar is applied to the Content child by
    // ToolbarFlexItem.transposeAxes, not by the wrapper transform.
    this.textField = this._contentObject!.createComponent(TextInputField.getTypeName()) as TextInputField
    this.managedComponents.add(this.textField)

    // Theme resolves at init time, so the override has to land before initialize().
    if (config.theme) {
      this.textField.setThemeOverride(config.theme)
    }

    // The keyboard type is snapshotted at init, so it has to land before initialize().
    if (config.inputType) {
      this.textField.inputType = config.inputType
    }

    const intrinsicSize = this.intrinsicSize
    this.textField.size = new vec3(intrinsicSize.x, intrinsicSize.y, 0)

    // Deprecated no-op since TextInputField dropped setIconSide: the slot's side
    // follows textAlignment. Kept in the schema so a config that sets it still
    // compiles; say so instead of dropping it silently.
    if (config.iconSide !== undefined) {
      log.w(
        `ToolbarTextField "${config.id}": config.iconSide is deprecated and has no effect; the action slot's side ` +
          `follows textAlignment.`
      )
    }

    if (config.icon) {
      // The field's action slot is EXCLUSIVE and defaults to "voiceInput", so an
      // icon replaces the dictation button. Say so rather than doing it silently:
      // the voice callbacks below stay wired, but the field can no longer raise
      // them from user speech. onVoiceStateChanged has its single invoke site
      // inside the voice-button wiring, so it becomes unreachable; onVoiceFinalize
      // is then only reachable through TextInputField.simulateVoiceResult().
      // Letting a caller pick the slot instead would need a new config field.
      if (config.onVoiceFinalize || config.onVoiceStateChanged) {
        log.w(
          `ToolbarTextField "${config.id}": config.icon takes the field's single action slot, which would otherwise ` +
            `hold the voice-input button, so the voice callbacks passed with it cannot fire from user speech. Drop ` +
            `config.icon to keep dictation, or drop the voice callbacks to keep the icon.`
        )
      }
      this.textField.actionSlot = "iconChange"
      this.textField.icon = config.icon
    }

    this.textField.placeholderText = config.placeholder ?? ""

    this.textField.initialize()

    if (config.initialText) {
      this.textField.text = config.initialText
    }

    this.textField.onHoverEnter.add((e) => this.invokeOnHoverEnter(e))
    this.textField.onHoverExit.add((e) => this.invokeOnHoverExit(e))
    this.textField.onTriggerUp.add((e) => this.invokeOnTriggerUp(e))
    this.textField.onTriggerDown.add((e) => this.invokeOnTriggerDown(e))

    // Flat at the item's order (the toolbar's base unless config.renderOrder).
    // The shadow stays one below on purpose: renderOrder outranks Canvas
    // hierarchy sorting, and the shadow is a child of the body's object, so at
    // an equal order tree order would draw it in front (plan §0.5).
    const renderOrder = this.renderOrder
    this.textField.renderOrder = renderOrder
    if (this.textField.shadowVisual?.renderMeshVisual) {
      this.textField.shadowVisual.renderMeshVisual.renderOrder = renderOrder - 1
    }

    if (config.textAlignment) {
      this.applyTextAlignment()
    }

    const textChangedHandler = (text: string) => {
      if (config.onTextChanged) {
        config.onTextChanged(text)
      }
      if (this.textFieldConfig.textAlignment) {
        this.applyTextAlignment()
      }
    }

    this.textField.onTextChanged.add(textChangedHandler)

    if (config.onSubmit) {
      this.textField.onReturnKeyPressed.add((text: string) => {
        config.onSubmit?.(text)
      })
    }

    if (config.onVoiceFinalize) {
      this.textField.onVoiceFinalize.add((text: string) => {
        config.onVoiceFinalize?.(text)
      })
    }

    if (config.onVoiceStateChanged) {
      this.textField.onVoiceStateChanged.add((isActive: boolean) => {
        config.onVoiceStateChanged?.(isActive)
      })
    }

    if (config.onFocusGained) {
      this.textField.onEditMode.add((isEditing: boolean) => {
        this.userIsEditing = isEditing
        if (isEditing) {
          config.onFocusGained?.()
        }
        if (this.textFieldConfig.textAlignment) {
          this.applyTextAlignment()
        }
      })
    } else if (this.textFieldConfig.textAlignment) {
      this.textField.onEditMode.add((isEditing: boolean) => {
        this.userIsEditing = isEditing
        this.applyTextAlignment()
      })
    }

    if (config.onFocusLost) {
      this.textField.onKeyboardStateChanged.add((isOpen: boolean) => {
        if (!isOpen) {
          config.onFocusLost?.()
        }
      })
    }

    if (this.textField.visual && this.textField.visual.renderMeshVisual) {
      this.textField.visual.renderMeshVisual.mainMaterial.mainPass.blendMode = BlendMode.PremultipliedAlphaAuto
    }
  }

  private applyTextAlignment() {
    if (!this.textField?.textComponent) {
      return
    }
    if (this.textFieldConfig.textAlignment && !this.userIsEditing) {
      const alignment = this.textFieldConfig.textAlignment
      if (alignment === ToolbarAlignment.LEFT) {
        this.textField.horizontalTextAlignment = TextAlignment.Left
      } else if (alignment === ToolbarAlignment.RIGHT) {
        this.textField.horizontalTextAlignment = TextAlignment.Right
      } else {
        this.textField.textComponent.horizontalAlignment = HorizontalAlignment.Center
      }
    } else {
      this.textField.horizontalTextAlignment = TextAlignment.Left
      // Center-aligned toolbar fields set the native Text alignment directly because the public
      // TextInputField API intentionally rejects Center. Its logical alignment is already Left, so
      // assigning the public property alone can be a no-op on edit entry.
      this.textField.textComponent.horizontalAlignment = HorizontalAlignment.Left
    }
  }
}

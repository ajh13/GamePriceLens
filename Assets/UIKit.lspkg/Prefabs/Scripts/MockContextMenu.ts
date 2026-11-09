import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import {Button} from "../../Scripts/Components/Button/Button"
import {BaseTextInputComponent} from "../../Scripts/Components/TextInput/BaseTextInputComponent"

const log = new NativeLogger("MockContextMenu")

@component
export class MockContextMenu extends BaseScriptComponent {
  @input
  private selectAllButton: Button

  @input
  private copyTextButton: Button

  @input
  private replaceTextButton: Button

  @input
  private cutTextButton: Button

  @input
  private pasteLabel: Text

  @input
  private textInputComponents: BaseTextInputComponent[]

  private focusedTextInputComponent: BaseTextInputComponent | null = null
  private copiedText: string = ""

  public onAwake() {
    this.createEvent("OnStartEvent").bind(this.onStart.bind(this))
  }

  private onStart() {
    this.textInputComponents.forEach((component) => {
      component.onEditMode.add((editing) => {
        if (editing) {
          this.focusedTextInputComponent = component
        } else if (this.focusedTextInputComponent === component) {
          this.focusedTextInputComponent = null
        }
      })
    })

    this.copyTextButton.onTriggerUp.add(() => {
      if (this.focusedTextInputComponent) {
        if (this.focusedTextInputComponent.highlightedText !== "") {
          this.copiedText = this.focusedTextInputComponent.highlightedText
          this.pasteLabel.text = `Paste: \n"${this.copiedText}"`
        } else {
          print("No highlighted text")
          log.w("No highlighted text")
        }
      } else {
        print("No focused text input component")
        log.w("No focused text input component")
      }
    })

    this.cutTextButton.onTriggerUp.add(() => {
      if (this.focusedTextInputComponent) {
        if (this.focusedTextInputComponent.highlightedText !== "") {
          this.copiedText = this.focusedTextInputComponent.highlightedText
          this.focusedTextInputComponent.cut()
          this.pasteLabel.text = `Paste: \n"${this.copiedText}"`
        } else {
          print("No highlighted text")
          log.w("No highlighted text")
        }
      } else {
        print("No focused text input component")
        log.w("No focused text input component")
      }
    })

    this.replaceTextButton.onTriggerUp.add(() => {
      if (this.focusedTextInputComponent) {
        this.focusedTextInputComponent.paste(this.copiedText)
      } else {
        print("No focused text input component")
        log.w("No focused text input component")
      }
    })

    this.selectAllButton.onTriggerUp.add(() => {
      if (this.focusedTextInputComponent) {
        this.focusedTextInputComponent.selectAll()
      } else {
        print("No focused text input component")
        log.w("No focused text input component")
      }
    })
  }
}

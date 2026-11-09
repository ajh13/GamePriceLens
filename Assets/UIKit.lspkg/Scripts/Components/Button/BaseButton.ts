import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"

import Event, {PublicApi} from "InteractionKit.lspkg/Utils/Event"
import {Callback, createCallbacks} from "../../../Scripts/Utility/SceneUtilities"
import {StateName} from "../Element"
import {Toggleable} from "../Toggle/Toggleable"
import {VisualElement} from "../VisualElement"

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const log = new NativeLogger("Button")

/**
 * The `Button` class represents a button component in the UI Kit.
 * It extends the `VisualElement` class and initializes a default visual if none is provided.
 *
 * @extends VisualElement
 */
export abstract class BaseButton extends VisualElement implements Toggleable {
  // To add per-theme styles or shapes, add @input fields like:
  //
  // @input
  // @showIf("_themeOverride", "System3")
  // @label("Style")
  // @widget(new ComboBoxWidget([
  //   new ComboBoxItem("StyleName", "StyleName"),
  // ]))
  // protected _styleSystem3: string = "StyleName"

  protected get effectiveStyle(): string | undefined {
    return undefined
  }

  protected get effectiveShape(): string {
    return "Rectangle"
  }

  // Buttons layer by hierarchy under a Canvas: the body visual sits on this
  // SceneObject and draws first, then children in tree order — the visuals
  // created at initialize (RadioButton/Checkbox toggled + check), a companion
  // ElementContent's container (built after onInitialized), and last the
  // developer-owned children, which VisualElement keeps in the foreground
  // (addChild / removeChild; authored children are moved there at initialize).
  // The shadow keeps its renderOrder − 1. See VisualElement.managesDrawOrderCanvas.
  protected get managesDrawOrderCanvas(): boolean {
    return true
  }

  @input
  private _toggleable: boolean = false
  @input
  @showIf("_toggleable")
  @hint("The default state of the Toggle")
  protected _defaultToOn: boolean = false
  @input
  @hint("Enable this to add functions from another script to this component's callbacks")
  protected addCallbacks: boolean = false
  @ui.group_start("Callbacks")
  @showIf("addCallbacks")
  @input
  @label("On Trigger Up Callbacks")
  private triggerUpCallbacks: Callback[] = []
  @input
  @label("On Trigger Down Callbacks")
  private triggerDownCallbacks: Callback[] = []
  @input
  @showIf("_toggleable")
  @label("On Value Changed Callbacks")
  protected onValueChangeCallbacks: Callback[] = []
  @input
  @showIf("_toggleable")
  @label("On Finished Callbacks")
  protected onFinishedCallbacks: Callback[] = []
  @ui.group_end
  private _isOn: boolean = false

  protected get isToggle(): boolean {
    return this._toggleable
  }

  private onValueChangeEvent: Event<number> = new Event<number>()
  private _onValueChange?: PublicApi<number>
  public get onValueChange(): PublicApi<number> {
    return (this._onValueChange ??= this.onValueChangeEvent.publicApi())
  }
  private onFinishedEvent: Event<boolean> = new Event<boolean>()
  private _onFinished?: PublicApi<boolean>
  public get onFinished(): PublicApi<boolean> {
    return (this._onFinished ??= this.onFinishedEvent.publicApi())
  }

  /**
   * Gets the current state of the toggle.
   *
   * @returns {boolean} - Returns `true` if the toggle is on, otherwise `false`.
   */
  public get isOn(): boolean {
    return this._isOn
  }

  /**
   * Sets the state of the toggle.
   * If the new state is different from the current state, it updates the state,
   * triggers the updateCheck method, and invokes the onValueChangeEvent.
   *
   * @param on - A boolean indicating the new state of the toggle.
   */
  public set isOn(on: boolean) {
    if (on === undefined) {
      return
    }
    this.setOn(on, false)
  }

  public setIsToggleable(isToggle: boolean): void {
    // Only a live button is being converted; one made toggleable before
    // initialize(), a toolbar toggle item for instance, is being configured.
    if (this._toggleable === false && isToggle && this.initialized) {
      print(`WARNING: ${this.sceneObject.name} is being automatically converted to a toggle.`)
    }
    this._toggleable = isToggle
    // undo previous settings
    this.removeInteractableListeners()
    // sets interactable state machine to be a toggle
    this.setUpInteractableListeners()
  }

  public initialize(): boolean {
    if (this.initialized) {
      return false
    }
    this._isOn = this._defaultToOn
    this.stateName = this._defaultToOn ? StateName.toggledDefault : StateName.default
    if (!super.initialize()) {
      return false
    }

    if (this.isToggle) {
      this._interactableStateMachine.toggle = this._isOn
    }
    return true
  }

  protected setUpEventCallbacks(): void {
    super.setUpEventCallbacks()
    if (this.addCallbacks) {
      this.onTriggerUp.add(createCallbacks(this.triggerUpCallbacks))
      this.onTriggerDown.add(createCallbacks(this.triggerDownCallbacks))
      this.onValueChange.add(createCallbacks(this.onValueChangeCallbacks))
      this.onFinished.add(createCallbacks(this.onFinishedCallbacks))
    }
  }

  protected setState(stateName: StateName): void {
    super.setState(stateName)
    // Inactive has no toggled form, so it says nothing about selection: a button that is on stays
    // on, without value events a ToggleGroup would react to.
    if (stateName === StateName.inactive) {
      return
    }
    const shouldBeOn =
      stateName === StateName.toggledDefault ||
      stateName === StateName.toggledHovered ||
      stateName === StateName.toggledTriggered
    if (this._isOn !== shouldBeOn) {
      this.setOnFromState(shouldBeOn)
    }
  }

  // Coming back from inactive, a button that is on shows its toggled look rather than turning off.
  protected get activeRestingState(): StateName {
    return this._isOn ? StateName.toggledDefault : StateName.default
  }

  /** Separates state inference from external selection requests. */
  protected setOnFromState(on: boolean): void {
    this.setOn(on, true) // explicit = true to notify toggle group
  }

  /**
   * Toggle on/off the toggle by setting its state
   *
   * @param on - A boolean value indicating the desired toggle state.
   */
  public toggle(on: boolean): void {
    if (this.isToggle) {
      this.setOn(on, true)
    } else {
      print("WARNING: this is not in toggle mode! Did you mean to check `isToggle`?")
    }
  }

  protected abstract createDefaultVisual(): void

  protected setOn(on: boolean, explicit: boolean): void {
    if (this.initialized) {
      if (this._isOn === on) {
        return
      }
      this._isOn = on
      if (this.isToggle) {
        this._interactableStateMachine.toggle = on
      }
      this.onValueChangeEvent.invoke(this._isOn ? 1 : 0)
      this.onFinishedEvent.invoke(explicit)
    } else {
      this._defaultToOn = on
    }
  }
}

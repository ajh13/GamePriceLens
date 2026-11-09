import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {InteractorInputType} from "InteractionKit.lspkg/Core/Interactor/Interactor"
import {InteractorEvent} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import Event, {PublicApi, unsubscribe} from "InteractionKit.lspkg/Utils/Event"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"

const log = new NativeLogger("InteractableStateMachine")

enum State {
  "default" = "default",
  "hovered" = "hovered",
  "triggered" = "triggered",
  "toggledDefault" = "toggledDefault",
  "toggledHovered" = "toggledHovered",
  "toggledTriggered" = "toggledTriggered"
}

enum Action {
  "hover" = "hover",
  "unHover" = "unHover",
  "triggerStart" = "triggerStart",
  "triggerEnd" = "triggerEnd",
  "triggerEndOutside" = "triggerEndOutside",
  "triggerCancel" = "triggerCancel",
  "toggleOn" = "toggleOn",
  "toggleOff" = "toggleOff"
}

export type StateEvent = {
  state: State
  event?: InteractorEvent
}

const DYNAMIC_TRIGGERED_TRIGGER_END = "dynamic:triggeredTriggerEnd"
const DYNAMIC_TOGGLED_TRIGGERED_TRIGGER_END = "dynamic:toggledTriggeredTriggerEnd"

type DynamicTransition = typeof DYNAMIC_TRIGGERED_TRIGGER_END | typeof DYNAMIC_TOGGLED_TRIGGERED_TRIGGER_END
type TransitionCell = State | DynamicTransition
type TransitionTable = Readonly<{
  [key in State]: Readonly<{
    [innerKey in Action]: TransitionCell
  }>
}>

const TRANSITIONS: TransitionTable = {
  default: {
    hover: State.hovered,
    unHover: State.default,
    triggerStart: State.triggered,
    triggerEnd: State.default,
    triggerEndOutside: State.default,
    triggerCancel: State.default,
    toggleOn: State.toggledDefault,
    toggleOff: State.default
  },
  hovered: {
    hover: State.hovered,
    unHover: State.default,
    triggerStart: State.triggered,
    triggerEnd: State.hovered,
    triggerEndOutside: State.default,
    triggerCancel: State.hovered,
    toggleOn: State.toggledHovered,
    toggleOff: State.hovered
  },
  triggered: {
    hover: State.triggered,
    unHover: State.default,
    triggerStart: State.triggered,
    triggerEnd: DYNAMIC_TRIGGERED_TRIGGER_END,
    triggerEndOutside: State.default,
    triggerCancel: State.default,
    toggleOn: State.toggledTriggered,
    toggleOff: State.triggered
  },
  toggledDefault: {
    hover: State.toggledHovered,
    unHover: State.toggledDefault,
    triggerStart: State.toggledTriggered,
    triggerEnd: State.toggledHovered,
    triggerEndOutside: State.toggledDefault,
    triggerCancel: State.toggledDefault,
    toggleOn: State.toggledDefault,
    toggleOff: State.default
  },
  toggledHovered: {
    hover: State.toggledHovered,
    unHover: State.toggledDefault,
    triggerStart: State.toggledTriggered,
    triggerEnd: State.toggledHovered,
    triggerEndOutside: State.toggledDefault,
    triggerCancel: State.toggledDefault,
    toggleOn: State.toggledHovered,
    toggleOff: State.hovered
  },
  toggledTriggered: {
    hover: State.toggledHovered,
    unHover: State.toggledDefault,
    triggerStart: State.toggledTriggered,
    triggerEnd: DYNAMIC_TOGGLED_TRIGGERED_TRIGGER_END,
    triggerEndOutside: State.toggledDefault,
    triggerCancel: State.toggledDefault,
    toggleOn: State.toggledTriggered,
    toggleOff: State.triggered
  }
}

export class InteractableStateMachine {
  public interactable: Interactable

  private initialized: boolean = false

  private _state: State = State.default

  public isToggle: boolean = false
  public isDraggable: boolean = false
  public untoggleOnClick: boolean = true
  /**
   * While true, hover and press events leave the state alone, as while the Interactable is
   * disabled. The owner's input is paused but its Interactable stays enabled. Toggling still
   * applies.
   */
  public inputPaused: boolean = false

  public events: {[key in State]: Event<StateEvent>} = {
    default: new Event<StateEvent>(),
    hovered: new Event<StateEvent>(),
    triggered: new Event<StateEvent>(),
    toggledDefault: new Event<StateEvent>(),
    toggledHovered: new Event<StateEvent>(),
    toggledTriggered: new Event<StateEvent>()
  }

  private _onDefault?: PublicApi<StateEvent>
  public get onDefault(): PublicApi<StateEvent> {
    return (this._onDefault ??= this.events.default.publicApi())
  }
  private _onHovered?: PublicApi<StateEvent>
  public get onHovered(): PublicApi<StateEvent> {
    return (this._onHovered ??= this.events.hovered.publicApi())
  }
  private _onTriggered?: PublicApi<StateEvent>
  public get onTriggered(): PublicApi<StateEvent> {
    return (this._onTriggered ??= this.events.triggered.publicApi())
  }
  private _onToggledDefault?: PublicApi<StateEvent>
  public get onToggledDefault(): PublicApi<StateEvent> {
    return (this._onToggledDefault ??= this.events.toggledDefault.publicApi())
  }
  private _onToggledHovered?: PublicApi<StateEvent>
  public get onToggledHovered(): PublicApi<StateEvent> {
    return (this._onToggledHovered ??= this.events.toggledHovered.publicApi())
  }
  private _onToggledTriggered?: PublicApi<StateEvent>
  public get onToggledTriggered(): PublicApi<StateEvent> {
    return (this._onToggledTriggered ??= this.events.toggledTriggered.publicApi())
  }

  private triggered: boolean = false
  private isDragging: boolean = false
  private interactableUnsubs: unsubscribe[] = []

  public constructor(interactable: Interactable, ownerSceneObject?: SceneObject) {
    this.interactable = interactable
    if (!this.interactable) {
      log.e(`Interactable not found on this object: ${ownerSceneObject ? ownerSceneObject.name : "unknown"}`)
    }
  }

  private get takesInput(): boolean {
    return this.interactable.enabled && !this.inputPaused
  }

  /**
   * Drops hover and any press in flight when the owner is disabled or pauses
   * its input, and emits the resting state so the owner repaints it. IK's
   * TriggerCanceled for the disabled Interactable is ignored by the handlers
   * below, so without this a mid-press disable would leave the machine
   * triggered.
   *
   * isDragging is kept for {@link resumePress}. It is only read on a release
   * from a pressed state, and every IK end event clears it.
   */
  public handleOwnerDisabled(): void {
    this.triggered = false
    this.state = this.restingState()
  }

  /**
   * Drops hover and any press in flight when the owner goes inactive. Silent:
   * an inactive owner ignores state events and paints its inactive look
   * itself. IK's TriggerCanceled and HoverExit for the disabled Interactable
   * are ignored by the handlers below, and a hover keeps the triggered state,
   * so without this the next hover after the owner is active again would show
   * the pressed look. A host that keeps the Interactable enabled delivers the
   * release instead, which must not run the click transition for an owner
   * that is not taking input.
   *
   * isDragging is kept, as in {@link handleOwnerDisabled}.
   */
  public handleOwnerInactive(): void {
    this.triggered = false
    this._state = this.restingState()
  }

  /**
   * Puts back a press dropped by {@link handleOwnerDisabled} or
   * {@link handleOwnerInactive} when the owner is active again before IK
   * canceled it, i.e. within the same frame. IK then never cancels, so the
   * release still arrives and must run from the pressed state, or a toggle
   * would not flip. Emits the pressed state.
   *
   * @returns Whether a press was restored.
   */
  public resumePress(): boolean {
    if (this.triggered || !this.takesInput || this.interactable.triggeringInteractor === InteractorInputType.None) {
      return false
    }
    this.triggered = true
    this.state = this.toggle ? State.toggledTriggered : State.triggered
    return true
  }

  public initialize(): void {
    if (this.initialized) {
      return
    }

    const u = this.interactableUnsubs
    u.push(
      this.interactable.onHoverEnter.add((e: InteractorEvent) => {
        if (this.takesInput) {
          if (this.triggered) this.transition(Action.triggerStart)
          else this.transition(Action.hover, e)
        }
      })
    )

    u.push(
      this.interactable.onHoverExit.add((e: InteractorEvent) => {
        if (this.takesInput) {
          if (this.triggered) {
            // Only unhover the Interactable if the Interactable is not meant to keep hover on trigger.
            if (!this.interactable.keepHoverOnTrigger) {
              this.transition(Action.unHover, e)
            }
          } else {
            this.transition(Action.unHover, e)
          }
        }
      })
    )

    u.push(
      this.interactable.onTriggerStart.add((e: InteractorEvent) => {
        if (this.takesInput && e.propagationPhase === "Target") {
          this.transition(Action.triggerStart, e)
          this.triggered = true
        }
      })
    )

    u.push(
      this.interactable.onDragStart.add(() => {
        if (this.takesInput) {
          if (this.isDraggable) this.isDragging = true
        }
      })
    )

    u.push(
      this.interactable.onTriggerEnd.add((e: InteractorEvent) => {
        if (this.takesInput) {
          this.transition(Action.triggerEnd, e)
        }
        this.triggered = false
        this.isDragging = false
      })
    )

    u.push(
      this.interactable.onTriggerEndOutside.add((e: InteractorEvent) => {
        if (this.takesInput) {
          this.transition(Action.triggerEndOutside, e)
        }
        this.triggered = false
        this.isDragging = false
      })
    )

    u.push(
      this.interactable.onTriggerCanceled.add((e: InteractorEvent) => {
        // Unlike its TriggerEnd, IK fires TriggerCanceled for every interactor. It clears the
        // canceled one first, so one still listed means another hand holds the press.
        if (this.interactable.triggeringInteractor !== InteractorInputType.None) {
          return
        }
        if (this.takesInput) {
          this.transition(Action.triggerCancel, e)
        }
        this.triggered = false
        this.isDragging = false
      })
    )

    this.initialized = true
  }

  public teardown(): void {
    for (let i = 0; i < this.interactableUnsubs.length; i++) {
      this.interactableUnsubs[i]()
    }
    this.interactableUnsubs.length = 0
    this.initialized = false
    this.triggered = false
    this.isDragging = false
  }

  public get state() {
    return this._state
  }

  public set state(newState: State) {
    if (newState === undefined || newState === this._state) {
      return
    }
    const lastState = this._state
    this._state = newState
    this.events[this._state].invoke({state: lastState})
  }

  public transition(action: Action, e: InteractorEvent = null): void {
    const lastState = this._state
    this._state = this.getTransition(action)
    log.d(`----------------------`)
    log.d(`lastState = ${lastState}`)
    log.d(`action = ${action}`)
    log.d(`state = ${this.state}`)
    this.events[this.state].invoke({state: lastState, event: e})
  }

  public set toggle(on: boolean) {
    if (on === undefined) {
      return
    }
    if (on) {
      this.transition(Action.toggleOn)
    } else {
      this.transition(Action.toggleOff)
    }
  }

  public get toggle() {
    return (
      this.state === State.toggledTriggered ||
      this.state === State.toggledDefault ||
      this.state === State.toggledHovered
    )
  }

  private triggeredTriggerEnd(): State {
    if (this.isToggle) {
      if (this.isDragging) {
        if (!this.toggle) return State.hovered
        else return State.toggledTriggered
      }
      return State.toggledHovered
    }
    return State.hovered
  }

  private toggledTriggeredTriggerEnd(): State {
    if (this.untoggleOnClick) {
      if (this.isDragging) {
        if (!this.toggle) return State.hovered
        else return State.toggledTriggered
      }
      return State.hovered
    }
    return State.toggledTriggered
  }

  // The current state without hover or press, keeping the toggle.
  private restingState(): State {
    switch (this._state) {
      case State.hovered:
      case State.triggered:
        return State.default
      case State.toggledHovered:
      case State.toggledTriggered:
        return State.toggledDefault
      default:
        return this._state
    }
  }

  private getTransition(action: Action): State {
    const thisTransition = TRANSITIONS[this.state][action]
    switch (thisTransition) {
      case DYNAMIC_TRIGGERED_TRIGGER_END:
        return this.triggeredTriggerEnd()
      case DYNAMIC_TOGGLED_TRIGGERED_TRIGGER_END:
        return this.toggledTriggeredTriggerEnd()
      default:
        return thisTransition
    }
  }
}

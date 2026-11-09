import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {Interactor} from "InteractionKit.lspkg/Core/Interactor/Interactor"
import {InteractorEvent} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import Event, {unsubscribe} from "InteractionKit.lspkg/Utils/Event"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import StateMachine from "InteractionKit.lspkg/Utils/StateMachine"

const TAG = "HoverBehavior"

enum State {
  Inactive = "Inactive",
  InactiveToActive = "InactiveToActive",
  Active = "Active",
  ActiveToInactive = "ActiveToInactive"
}

enum Signal {
  RequestActive = "RequestActive",
  RequestInActive = "RequestInActive"
}

const STATE_CHANGE_DEBOUNCE_TIME_S = 0.05 // 50ms

const DEBUG_MESSAGES = false

/**
 * Per-interactor entry tracking one hand/cursor's hover lifecycle. Each
 * Interactor that hovers the Interactable gets its own entry so two hands
 * can drive independent hoverStart / hoverUpdate / hoverEnd streams.
 */
interface InteractorEntry {
  stateMachine: StateMachine
  isActive: boolean
  requestActive: boolean
  hoverActive: boolean
  eventData: InteractorEvent
}

/**
 * Behavior for handling nested interactable hover events. Tracks each
 * interactor (hand, mouse, mobile) independently so concurrent hovers fire
 * matched start/update/end events per source.
 */
export default class HoverBehavior {
  private hoverStart = new Event<InteractorEvent>()
  public readonly onHoverStart = this.hoverStart.publicApi()

  private hoverEnd = new Event<InteractorEvent>()
  public readonly onHoverEnd = this.hoverEnd.publicApi()

  private hoverUpdate = new Event<InteractorEvent>()
  public readonly onHoverUpdate = this.hoverUpdate.publicApi()

  private requestChange = new Event<void>()
  /**
   * Fires whenever a raw Interactable event flips an entry's requested-active
   * state (hover enter, hover exit, implicit enter via hover-update, or
   * trigger-finished off-frame). A consumer that parks its lateUpdate() pump
   * while {@link isSettled} must subscribe to this and re-wake on it: a request
   * that flips while the pump is parked is otherwise never delivered. In
   * particular, a hover-exit landing during the InactiveToActive debounce would
   * let the entry's StateMachine complete to Active and fire a phantom
   * hoverStart for a hand that already left.
   */
  public readonly onRequestChange = this.requestChange.publicApi()

  private entries: Map<Interactor, InteractorEntry> = new Map()

  private unsubscribeList: unsubscribe[] = []
  private isDestroyed: boolean = false

  private log = new NativeLogger(TAG)

  public constructor(
    private interactable: Interactable,
    private name: string = "HoverBehavior"
  ) {
    this.bindHoverEvents()
  }

  public destroy(): void {
    this.log.d(`has been destroyed!`)
    this.isDestroyed = true
    for (const entry of this.entries.values()) {
      entry.stateMachine.destroy()
    }
    this.entries.clear()
    this.unBindHoverEvents()
  }

  private bindHoverEvents(): void {
    // Per-interactor event tier. The plain onHoverEnter / onHoverExit are
    // AGGREGATE events: enter fires only when the FIRST interactor arrives
    // (bitmask None → set) and exit only when the LAST one leaves. Built on
    // those, a second hand entering while the first hovered never created an
    // entry (its cursor was never driven — stuck in Auto), and the first
    // hand leaving while the second stayed never fired its exit (stale
    // state). The onInteractor* tier fires once per interactor.
    this.unsubscribeList.push(this.interactable.onInteractorHoverEnter.add(this.onHoverEnter))
    this.unsubscribeList.push(this.interactable.onInteractorHoverExit.add(this.onHoverExit))
    this.unsubscribeList.push(this.interactable.onHoverUpdate.add(this.onHoverUpdated))

    // All three trigger-end variants must re-evaluate hover. onHoverExit is
    // deliberately swallowed while the interactor is triggering (so an
    // on-frame drag that drifts off the collider doesn't end the hover), but
    // that means the ONLY exit signal for a hand that released off-frame is
    // whichever trigger-end event fires. Subscribing only to EndOutside left
    // a hole: a trigger that ends via onTriggerEnd or onTriggerCanceled with
    // the hand already off the frame would leave the entry Active forever —
    // no further hover event ever arrives for a hand that's already outside,
    // so the consumer (Frame) kept writing stale cursor modes (e.g. a Scale
    // cursor persisting after hover-exit).
    this.unsubscribeList.push(this.interactable.onTriggerEnd.add(this.onTriggerFinished))
    this.unsubscribeList.push(this.interactable.onTriggerEndOutside.add(this.onTriggerFinished))
    this.unsubscribeList.push(this.interactable.onTriggerCanceled.add(this.onTriggerFinished))
  }

  private unBindHoverEvents(): void {
    this.unsubscribeList.forEach((sub) => {
      sub()
    })
    this.unsubscribeList = []
  }

  /**
   * Get the entry for an interactor, creating one on demand. New entries
   * arrive in the Inactive state with their own StateMachine.
   */
  private getOrCreateEntry(eventData: InteractorEvent): InteractorEntry {
    const interactor = eventData.interactor
    let entry = this.entries.get(interactor)
    if (entry === undefined) {
      const stateMachine = new StateMachine(`${this.name}#${this.interactorTag(interactor)}`)
      entry = {
        stateMachine,
        isActive: false,
        requestActive: false,
        hoverActive: false,
        eventData
      }
      this.entries.set(interactor, entry)
      this.setupStateMachine(entry)
      stateMachine.enterState(State.Inactive)
    }
    return entry
  }

  /** Best-effort short label for an interactor used in StateMachine names. */
  private interactorTag(interactor: Interactor): string {
    return `Interactor${interactor.inputType}`
  }

  /**
   * Set an entry's requested-active state, firing {@link onRequestChange} only
   * on an actual flip (so a gated consumer wakes on the edge, and the
   * every-frame hover-update stream doesn't re-fire while already requested).
   */
  private setRequestActive(entry: InteractorEntry, value: boolean): void {
    if (entry.requestActive === value) return
    entry.requestActive = value
    this.requestChange.invoke()
  }

  private onHoverEnter = (eventData: InteractorEvent): void => {
    const entry = this.getOrCreateEntry(eventData)
    entry.eventData = eventData
    this.setRequestActive(entry, true)
  }

  private onHoverExit = (eventData: InteractorEvent): void => {
    if (eventData.interactor.isTriggering) {
      return
    }
    const entry = this.entries.get(eventData.interactor)
    if (entry === undefined) return
    entry.eventData = eventData
    this.setRequestActive(entry, false)
  }

  private onTriggerFinished = (eventData: InteractorEvent): void => {
    if (!eventData.interactor.isHoveringInteractableHierarchy(this.interactable)) {
      const entry = this.entries.get(eventData.interactor)
      if (entry === undefined) return
      entry.eventData = eventData
      this.setRequestActive(entry, false)
    }
  }

  private onHoverUpdated = (eventData: InteractorEvent): void => {
    // Implicit enter: hover updates only flow for interactors that are
    // actually hovering, so an update from an unknown interactor means its
    // enter event was missed (or arrived through a path we don't cover).
    // Create the entry and request Active rather than dropping the data —
    // a registered-late hand is strictly better than one that's invisible
    // to consumers for its entire hover.
    const entry = this.getOrCreateEntry(eventData)
    entry.eventData = eventData
    this.setRequestActive(entry, true)
  }

  /** A pending request lateUpdate() still has to deliver to the entry's SM. */
  private static hasPending(entry: InteractorEntry): boolean {
    return entry.isActive !== entry.requestActive
  }

  public lateUpdate = (): void => {
    for (const entry of this.entries.values()) {
      if (HoverBehavior.hasPending(entry)) {
        if (DEBUG_MESSAGES) {
          this.log.d(`container requested active state:${entry.requestActive}`)
        }
        entry.stateMachine.sendSignal(entry.requestActive ? Signal.RequestActive : Signal.RequestInActive)
      }
      // Update actual state immediately
      entry.isActive = entry.requestActive
    }
  }

  /**
   * True when there is no pending request for lateUpdate() to deliver — every
   * entry's actual state already matches its requested state, so lateUpdate()
   * would be a no-op. (The per-entry StateMachines finish their debounce
   * transitions and fire start/end on their own update events, independent of
   * lateUpdate().) A gated consumer can stop calling lateUpdate() once this is
   * true and resume on the next raw Interactable hover event.
   */
  public isSettled(): boolean {
    for (const entry of this.entries.values()) {
      if (HoverBehavior.hasPending(entry)) {
        return false
      }
    }
    return true
  }

  /**
   * Configure the per-entry state machine. Closes over `entry` so events
   * fire with that entry's own eventData, isolated from other interactors.
   */
  private setupStateMachine(entry: InteractorEntry): void {
    const sm = entry.stateMachine

    // Inactive State
    sm.addState({
      name: State.Inactive,
      onEnter: (_state) => {
        // Idle-gate this retained SM. Parked in Inactive it has no per-frame
        // work — the only exit is the RequestActive signal, which lateUpdate()
        // delivers via sendSignal (independent of this SM's own update events).
        // So disable its dispatcher update/lateUpdate events while parked;
        // re-enabled in InactiveToActive.onEnter.
        sm.updateEvent.enabled = false
        sm.lateUpdateEvent.enabled = false

        // Only treat this as an "exit" if we were previously active. The
        // initial `enterState(State.Inactive)` for a fresh entry hits this
        // path too — we must not fire hoverEnd there.
        //
        // We deliberately keep the entry (and its StateMachine) in the
        // map after hover-end. IK reuses Interactor references (≈4–5 per
        // scene), so the next hover from the same Interactor reuses this
        // entry — flipping requestActive=true on the next onHoverEnter,
        // which signals Inactive → Active and re-invokes hoverStart.
        // Destroying the SM here would be wrong twice over: (1) it nulls
        // _currentState mid-tick while we're inside the SM's own update
        // → onEnter cascade (the "Cannot read property 'onUpdate' of null"
        // crash in IK StateMachine.update), and (2) it forces an
        // expensive rebuild on every re-hover for no benefit. Final
        // cleanup of all entries happens in HoverBehavior.destroy().
        if (entry.hoverActive) {
          this.hoverEnd.invoke(entry.eventData)
          entry.hoverActive = false
        }
      },
      transitions: [
        {
          nextStateName: State.InactiveToActive,
          checkOnSignal: (signal, _data) => {
            return signal === Signal.RequestActive
          }
        }
      ]
    })

    // Inactive Transition State
    sm.addState({
      name: State.InactiveToActive,
      onEnter: (_state) => {
        // Leaving the parked Inactive state — re-enable the dispatcher events so
        // the debounce (the checkOnUpdate → Active transition below) can tick.
        sm.updateEvent.enabled = true
        sm.lateUpdateEvent.enabled = true
      },
      transitions: [
        {
          nextStateName: State.Inactive,
          checkOnSignal: (signal, _data) => {
            return signal === Signal.RequestInActive
          }
        },
        {
          nextStateName: State.Active,
          checkOnUpdate: (state) => {
            return state.stateElapsedTime > STATE_CHANGE_DEBOUNCE_TIME_S
          }
        }
      ]
    })

    // Active State
    sm.addState({
      name: State.Active,
      onEnter: (_state) => {
        if (!entry.hoverActive) {
          this.hoverStart.invoke(entry.eventData)
        }
        entry.hoverActive = true
      },
      onUpdate: (_state) => {
        if (this.isDestroyed) {
          this.log.d("Already destroyed!")
          return
        }

        try {
          this.hoverUpdate.invoke(entry.eventData)
        } catch (e) {
          // If we arrive here, the script is dead and will be cleaned up eventually
          // Any calls that cross the native boundary could throw an exception
          this.log.e(`Error invoking hoverUpdate: ${e}`)
        }
      },
      transitions: [
        {
          nextStateName: State.ActiveToInactive,
          checkOnSignal: (signal, _data) => {
            return signal === Signal.RequestInActive
          }
        }
      ]
    })

    //  Active Transition State
    sm.addState({
      name: State.ActiveToInactive,
      transitions: [
        {
          nextStateName: State.Inactive,
          checkOnUpdate: (state) => {
            return state.stateElapsedTime > STATE_CHANGE_DEBOUNCE_TIME_S
          }
        },
        {
          nextStateName: State.Active,
          checkOnSignal: (signal, _data) => {
            return signal === Signal.RequestActive
          }
        }
      ]
    })
  }
}

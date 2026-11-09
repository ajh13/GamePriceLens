import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {InteractorEvent} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import {unsubscribe} from "InteractionKit.lspkg/Utils/Event"
import ReplayEvent from "InteractionKit.lspkg/Utils/ReplayEvent"
import {nextFrame} from "Leaf.lspkg/Utils/common/Utils"

export class ReplayInteractable {
  private onHoverEnterEvent = new ReplayEvent<InteractorEvent>()
  private onHoverExitEvent = new ReplayEvent<InteractorEvent>()
  private onDragStartEvent = new ReplayEvent<InteractorEvent>()
  private onDragUpdateEvent = new ReplayEvent<InteractorEvent>()
  private onDragEndEvent = new ReplayEvent<InteractorEvent>()
  private onInteractorTriggerStartEvent = new ReplayEvent<InteractorEvent>()
  private onTriggerStartEvent = new ReplayEvent<InteractorEvent>()
  private onTriggerUpdateEvent = new ReplayEvent<InteractorEvent>()
  private onTriggerEndEvent = new ReplayEvent<InteractorEvent>()
  private onInteractorTriggerEndEvent = new ReplayEvent<InteractorEvent>()

  private unsubscribeCbs: unsubscribe[] = []

  onHoverEnter = this.onHoverEnterEvent.publicApi()
  onHoverExit = this.onHoverExitEvent.publicApi()
  onDragStart = this.onDragStartEvent.publicApi()
  onDragUpdate = this.onDragUpdateEvent.publicApi()
  onDragEnd = this.onDragEndEvent.publicApi()
  onInteractorTriggerStart = this.onInteractorTriggerStartEvent.publicApi()
  onTriggerStart = this.onTriggerStartEvent.publicApi()
  onTriggerUpdate = this.onTriggerUpdateEvent.publicApi()
  onTriggerEnd = this.onTriggerEndEvent.publicApi()
  onInteractorTriggerEnd = this.onInteractorTriggerEndEvent.publicApi()

  static async create(interactable: Interactable): Promise<ReplayInteractable> {
    const replayInteractable = new ReplayInteractable(interactable)
    await nextFrame()
    return replayInteractable
  }

  private constructor(interactable: Interactable) {
    this.unsubscribeCbs.push(
      interactable.onHoverEnter.add((interactorEvent) =>
        this.onHoverEnterEvent.invoke(interactorEvent),
      ),
    )
    this.unsubscribeCbs.push(
      interactable.onHoverExit.add((interactorEvent) =>
        this.onHoverExitEvent.invoke(interactorEvent),
      ),
    )
    this.unsubscribeCbs.push(
      interactable.onDragStart.add((interactorEvent) =>
        this.onDragStartEvent.invoke(interactorEvent),
      ),
    )
    this.unsubscribeCbs.push(
      interactable.onDragUpdate.add((interactorEvent) =>
        this.onDragUpdateEvent.invoke(interactorEvent),
      ),
    )
    this.unsubscribeCbs.push(
      interactable.onDragEnd.add((interactorEvent) =>
        this.onDragEndEvent.invoke(interactorEvent),
      ),
    )
    this.unsubscribeCbs.push(
      interactable.onInteractorTriggerStart.add((interactorEvent) =>
        this.onInteractorTriggerStartEvent.invoke(interactorEvent),
      ),
    )
    this.unsubscribeCbs.push(
      interactable.onTriggerStart.add((interactorEvent) =>
        this.onTriggerStartEvent.invoke(interactorEvent),
      ),
    )
    this.unsubscribeCbs.push(
      interactable.onTriggerUpdate.add((interactorEvent) =>
        this.onTriggerUpdateEvent.invoke(interactorEvent),
      ),
    )
    this.unsubscribeCbs.push(
      interactable.onTriggerEnd.add((interactorEvent) =>
        this.onTriggerEndEvent.invoke(interactorEvent),
      ),
    )
    this.unsubscribeCbs.push(
      interactable.onInteractorTriggerEnd.add((interactorEvent) => {
        this.onInteractorTriggerEndEvent.invoke(interactorEvent)
      }),
    )
  }

  unsubscribe(): void {
    this.unsubscribeCbs.forEach((unsubscribe) => unsubscribe())
    this.unsubscribeCbs = []
  }
}

import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {
  EventPropagationPhase,
  InteractorEvent,
} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import {InteractorInputType} from "InteractionKit.lspkg/Core/Interactor/Interactor"
import {IK} from "InteractionKit.lspkg/IK"
import {LeafLifecycle} from "Leaf.lspkg/Utils/common/LeafLifecycle"
import {Logger} from "Leaf.lspkg/Utils/common/Logger"

const LOG = new Logger("InteractionTracer")

type EventName =
  | "onHoverEnter"
  | "onHoverExit"
  | "onTriggerStart"
  | "onTriggerEnd"
  | "onTriggerEndOutside"
  | "onTriggerCanceled"
  | "onDragStart"
  | "onDragEnd"
  | "onInteractorHoverEnter"
  | "onInteractorHoverExit"
  | "onInteractorTriggerStart"
  | "onInteractorTriggerEnd"
  | "onInteractorTriggerEndOutside"

/** Public event surface every Interactable shares. `(cb) => unsubscribe`. */
type PublicApi<T> = {add: (cb: (arg: T) => void) => () => void}

const DEFAULT_EVENT_NAMES: ReadonlyArray<EventName> = [
  "onInteractorTriggerStart",
  "onInteractorTriggerEnd",
  "onInteractorTriggerEndOutside",
  "onTriggerCanceled",
  "onDragStart",
  "onDragEnd",
]

const DEFAULT_PHASES: ReadonlyArray<EventPropagationPhase> = ["Target"]
const MAX_LABEL_CHARS = 40

export type InteractionTracerConfig = {
  /** Restrict attachment + dynamic registry hook to descendants of this SceneObject. Defaults to the entire scene. */
  root?: SceneObject
  /** Event names to listen to. Defaults to per-interactor trigger + drag + trigger-canceled. */
  events?: ReadonlyArray<EventName>
  /** Propagation phases to log. Defaults to `["Target"]` to avoid 2-3x duplicates from ancestor TrickleDown / BubbleUp. */
  phases?: ReadonlyArray<EventPropagationPhase>
  /** When `true`, also attach `onHoverUpdate` / `onTriggerUpdate` / `onDragUpdate`. Off by default. */
  includeUpdates?: boolean
  /** When `true` (the default), subscribes to {@link LeafLifecycle.onCleanup} so the tracer stops automatically at scenario end. */
  autoDestroyOnCleanup?: boolean
}

function describeInteractor(interactor: InteractorEvent["interactor"]): string {
  if (interactor === undefined || interactor === null) return "?"
  switch (interactor.inputType) {
    case InteractorInputType.LeftHand:
      return "left"
    case InteractorInputType.RightHand:
      return "right"
    case InteractorInputType.BothHands:
      return "both"
    default:
      return `input=${interactor.inputType ?? "?"}`
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

function describeSceneObject(sceneObject: SceneObject): string {
  const childName = sceneObject.name
  const parent = sceneObject.getParent()
  if (isNull(parent)) return truncate(childName, MAX_LABEL_CHARS)
  const full = `${childName} (${parent.name})`
  if (full.length <= MAX_LABEL_CHARS) return full
  const parentBudget = MAX_LABEL_CHARS - childName.length - 3
  if (parentBudget < 4) return truncate(childName, MAX_LABEL_CHARS)
  return `${childName} (${truncate(parent.name, parentBudget)})`
}

/**
 * Traces interaction events (hover/trigger/drag) on Interactables in the scene. Logs timestamp, event name, interactor, target Interactable, and propagation phase. Monkey-patches `InteractionManager.register/deregister` so Interactables added mid-scenario are tracked. Auto-detaches via {@link LeafLifecycle.onCleanup}.
 */
export class InteractionTracer {
  private readonly _events: ReadonlyArray<EventName>
  private readonly _phases: ReadonlySet<EventPropagationPhase>
  private readonly _interactableUnsubscribes = new Map<
    Interactable,
    Array<() => void>
  >()
  private _uninstallManagerPatch?: () => void
  private _uninstallLifecycleHook?: () => void

  constructor(private readonly config: InteractionTracerConfig = {}) {
    this._events = [
      ...(config.events ?? DEFAULT_EVENT_NAMES),
      ...(config.includeUpdates === true
        ? ["onHoverUpdate" as EventName, "onTriggerUpdate" as EventName, "onDragUpdate" as EventName]
        : []),
    ]
    this._phases = new Set(config.phases ?? DEFAULT_PHASES)

    this.installManagerPatch()

    if (config.autoDestroyOnCleanup !== false) {
      this._uninstallLifecycleHook = LeafLifecycle.getInstance().onCleanup.add(
        () => this.destroy(),
      )
    }

    LOG.debug(
      `attached; phases=${Array.from(this._phases).join("|")}`,
    )
  }

  /** Detach all listeners and restore patches. Safe to call multiple times. */
  destroy(): void {
    if (this._uninstallManagerPatch === undefined) return
    for (const unsubscribes of this._interactableUnsubscribes.values()) {
      for (const unsubscribe of unsubscribes) unsubscribe()
    }
    this._interactableUnsubscribes.clear()
    this._uninstallManagerPatch()
    this._uninstallManagerPatch = undefined
    this._uninstallLifecycleHook?.()
    this._uninstallLifecycleHook = undefined
  }

  private attach(interactable: Interactable): void {
    if (this._interactableUnsubscribes.has(interactable)) return
    if (this.config.root !== undefined) {
      const root = this.config.root
      if (!isDescendantOf(interactable.getSceneObject(), root)) return
    }
    const sceneObject = interactable.getSceneObject()
    const unsubscribes: Array<() => void> = []
    for (const eventName of this._events) {
      const event = (interactable as unknown as Record<string, unknown>)[
        eventName
      ] as PublicApi<InteractorEvent> | undefined
      if (event === undefined || typeof event.add !== "function") continue
      unsubscribes.push(
        event.add((arg: InteractorEvent) => {
          if (
            arg.propagationPhase !== undefined &&
            !this._phases.has(arg.propagationPhase)
          ) {
            return
          }
          const interactorLabel = describeInteractor(arg.interactor)
          const interactableLabel = describeSceneObject(sceneObject)
          const targetLabel =
            arg.target !== undefined && arg.target !== interactable
              ? ` target=${describeSceneObject(arg.target.getSceneObject())}`
              : ""
          const phase =
            arg.propagationPhase !== undefined
              ? ` phase=${arg.propagationPhase}`
              : ""
          LOG.debug(
            `[${interactableLabel}]\n${eventName} interactor=${interactorLabel}${targetLabel}${phase}`,
          )
        }),
      )
    }
    this._interactableUnsubscribes.set(interactable, unsubscribes)
  }

  private detach(interactable: Interactable): void {
    const unsubscribes = this._interactableUnsubscribes.get(interactable)
    if (unsubscribes === undefined) return
    for (const unsubscribe of unsubscribes) unsubscribe()
    this._interactableUnsubscribes.delete(interactable)
  }

  /** IK doesn't expose a register event; monkey-patch to catch Interactables added after construction. */
  private installManagerPatch(): void {
    const manager = IK.InteractionManager as unknown as {
      registerInteractable: (interactable: Interactable) => void
      deregisterInteractable: (interactable: Interactable) => void
    }
    const originalRegister = manager.registerInteractable.bind(manager)
    const originalDeregister = manager.deregisterInteractable.bind(manager)
    manager.registerInteractable = (interactable: Interactable) => {
      originalRegister(interactable)
      this.attach(interactable)
      LOG.debug(
        `registered ${describeSceneObject(interactable.getSceneObject())} (${this._interactableUnsubscribes.size} total)`,
      )
    }
    manager.deregisterInteractable = (interactable: Interactable) => {
      const label = describeSceneObject(interactable.getSceneObject())
      this.detach(interactable)
      LOG.debug(`deregistered ${label} (${this._interactableUnsubscribes.size} total)`)
      originalDeregister(interactable)
    }
    this._uninstallManagerPatch = () => {
      manager.registerInteractable = originalRegister
      manager.deregisterInteractable = originalDeregister
    }
  }
}

function isDescendantOf(sceneObject: SceneObject, root: SceneObject): boolean {
  let ancestor: SceneObject | null = sceneObject
  while (!isNull(ancestor)) {
    if (ancestor!.isSame(root)) return true
    ancestor = ancestor!.getParent()
  }
  return false
}

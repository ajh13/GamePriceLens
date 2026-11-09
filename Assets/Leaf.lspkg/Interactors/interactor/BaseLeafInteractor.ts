import {
  InteractorInputType,
  InteractorTriggerType,
  TargetingMode,
} from "InteractionKit.lspkg/Core/Interactor/Interactor"
import {callback, PublicApi} from "InteractionKit.lspkg/Utils/Event"
import BaseInteractor from "InteractionKit.lspkg/Core/Interactor/BaseInteractor"
import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {
  awaitEventOnce,
  getColliderSize,
  makeEventPromise,
  nextFrame,
  sleep,
  withEventTimeout,
} from "Leaf.lspkg/Utils/common/Utils"
import {awaitInteractorEvent} from "../InteractableUtils"
import {Logger} from "Leaf.lspkg/Utils/common/Logger"
import {SECS_TO_MS} from "Leaf.lspkg/Utils/common/Constants"
import {LeafLifecycle} from "Leaf.lspkg/Utils/common/LeafLifecycle"
import {PropertyStore} from "Leaf.lspkg/Utils/common/PropertyStore"
import {InteractorEvent} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import WorldCameraFinderProvider from "InteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import {UserInputSuppressor} from "./UserInputSuppressor"

interface CustomCommandArgs {
  [key: string]: any
}

type CustomCommand = (args?: CustomCommandArgs) => Promise<void>

const INTERACTOR_IDLE_STRENGTH = 0
const INTERACTOR_HOVER_STRENGTH = 0.2
const INTERACTOR_TRIGGER_STRENGTH = 0.8
export const INTERACTION_DURATION_MS = 200

export type TriggerConfig = {
  targetingMode?: TargetingMode
  /**
   * If true, the hand returns to its last known position after the trigger
   * completes. Consumed by subclasses; the base `trigger` passes the full
   * config through to `executeTrigger` unchanged.
   */
  resetOnComplete?: boolean
}

const LOG = new Logger("BaseLeafInteractor")

/**
 * Describes the base class for a {@link BaseLeafInteractor} that is used for testing.
 * It is instantiated from the scenario and creates a {@link BaseInteractor} component
 * in the scene, which is used to simulate interactions with the scene.
 *
 * Assumes indirect targeting with the interactor position at origin for simplicity,
 * If other targeting modes are required, override sikInteractor.startPoint.
 */
export abstract class BaseLeafInteractor {
  /**
   * Timeout for every awaited IK event (hover/trigger/drag), in ms. Set this to fail with a timeout error naming the event instead of waiting indefinitely, `DEFAULT_EVENT_TIMEOUT_MS` is the recommended value.
   */
  eventTimeoutMs: number = -1

  private customCommandsById = new Map<string, CustomCommand>()

  protected overrideInteractable?: Interactable
  private overrideTrigger = InteractorTriggerType.None
  protected overrideDragVector?: vec3
  private initialSikProperties: PropertyStore<BaseInteractor>

  private camera = WorldCameraFinderProvider.getInstance()

  private raycastHit: RayCastHit | null = null

  private lifecycle = LeafLifecycle.getInstance()

  /** Offset from the interaction point when dragging a 1-unit large interactable.
   * Will be scaled to the interactable size.
   * This is used to enable dual interactor interactions like scaling,
   * relying on non-zero interactor distance.
   */
  protected interactionOffset: vec3 = vec3.zero()
  protected targetingMode: TargetingMode = TargetingMode.Indirect

  // Default/reset positions of start and end points when no interaction is happening.
  protected readonly initialInteractorPosition: vec3 = vec3.zero()
  protected readonly initialInteractionPosition: vec3 = vec3.zero()

  protected startPoint = this.initialInteractorPosition
  protected endPoint = this.initialInteractionPosition

  private destroyCallback: callback<void> = () => {
    this.destroy()
  }

  constructor(protected sikInteractor: BaseInteractor) {
    if (isNull(sikInteractor)) {
      throw new Error(
        `${this.constructor.name} was given no IK interactor to drive. The lookup that produced it found nothing registered with IK's InteractionManager.`,
      )
    }

    /* Allow before the PropertyStore snapshot, so it never captures the suppressed `enabled` state. */
    UserInputSuppressor.getInstance().allow(this.sikInteractor)

    this.initialSikProperties = new PropertyStore<BaseInteractor>(
      this.sikInteractor,
    )
    const sikUpdateState = this.sikInteractor.updateState.bind(
      this.sikInteractor,
    )
    this.sikInteractor.updateState = () => {
      sikUpdateState()
      this.updateState()
    }
    this.overrideSikProperties()
    this.resetStartEndPoint()

    this.lifecycle.onCleanup.add(this.destroyCallback)
  }

  protected destroy(): void {
    LOG.debug(`Destroying BaseLeafInteractor ${this.sikInteractor.name}`, false)
    this.initialSikProperties.resetProperties()
    this.lifecycle.onCleanup.remove(this.destroyCallback)
  }

  /**
   * Defines the interactor's input type. This can be used for prioritization
   * or for discerning controller vs hands.
   *
   * @param - inputType to set
   */
  set inputType(inputType: InteractorInputType) {
    this.sikInteractor["inputType"] = inputType
  }

  /**
   * Scales the offset by the size of the interactable.
   * This is used to support proper scaling up and down of interactables,
   * while ensuring the interactor always interacts at an appropriate location.
   * @param interactable - Interactable to scale the start point offset by
   * @param point - Offset to scale
   * @returns Scaled 3d offset based on the interactable size
   */
  protected scalePointByInteractableSize(
    interactable: Interactable,
    point: vec3,
  ): vec3 {
    if (interactable.colliders.length === 0) {
      throw new Error("Interactable has no colliders.")
    }

    let size = vec3.zero()
    for (const collider of interactable.colliders) {
      size = vec3.max(getColliderSize(collider), size)
    }
    size = size
      .mult(interactable.getTransform().getWorldScale())
      .uniformScale(0.5)

    return point.mult(size)
  }

  /** Awaits `event` on `target`, naming both in the timeout error. */
  private awaitInteractableEvent(
    event: PublicApi<InteractorEvent>,
    eventName: string,
    target: Interactable,
  ): Promise<void> {
    return awaitEventOnce(event, {
      timeoutMs: this.eventTimeoutMs,
      description: `${eventName} on "${target.getSceneObject().name}"`,
    })
  }

  /** Core IK hover → select → release sequence, not overrideable. */
  private async executeTrigger(target: Interactable): Promise<void> {
    LOG.debug(`trigger: "${target.getSceneObject().name}"`, false)
    await this.enterHover(target)
    await nextFrame()

    try {
      const triggerStarted = this.awaitInteractableEvent(
        target.onTriggerStart,
        "onTriggerStart",
        target,
      )
      this.overrideTrigger = InteractorTriggerType.Select
      await triggerStarted
      await nextFrame()

      const triggerEnded = this.awaitInteractableEvent(
        target.onTriggerEnd,
        "onTriggerEnd",
        target,
      )
      this.overrideTrigger = InteractorTriggerType.None
      await nextFrame()

      await triggerEnded
    } catch (error) {
      /*
       * Restore synchronously: after a timeout, event delivery is unhealthy, so
       * awaiting exitHover would time out again and mask this error.
       */
      this.overrideTrigger = InteractorTriggerType.None
      this.overrideInteractable = undefined
      throw error
    }
    await this.exitHover()
    LOG.debug(`trigger: "${target.getSceneObject().name}" complete`, false)
  }

  /**
   * Targets and triggers an interactable.
   *
   * @param target - Interactable to trigger.
   * @param config - Optional config: `targetingMode` temporarily switches targeting mode for the
   *   duration of the trigger; `resetOnComplete` is available for subclasses to use.
   */
  async trigger(target: Interactable, config?: TriggerConfig): Promise<void> {
    const {targetingMode} = config ?? {}
    if (targetingMode !== undefined) {
      const previousMode = this.targetingMode
      this.targetingMode = targetingMode
      try {
        await this.executeTrigger(target)
      } finally {
        this.targetingMode = previousMode
      }
    } else {
      await this.executeTrigger(target)
    }
  }

  /**
   * Sets the trigger type of this interactor. This is used to set an trigger type without
   * triggering an interactable.
   *
   * @param triggerType - Input type to set
   */
  protected setTriggerType(triggerType: InteractorTriggerType): void {
    this.overrideTrigger = triggerType
  }

  /**
   * Targets and hovers over an interactable
   *
   * @param interactable - Interactable to hover over
   * @param hoverDurationMs - Duration of the hover
   * @returns true if the interactable is valid (not destroy, enabled), false otherwise
   */
  async hover(
    target: Interactable,
    hoverDurationMs: number = INTERACTION_DURATION_MS,
  ): Promise<void> {
    LOG.debug(
      `hover: "${target.getSceneObject().name}" for ${hoverDurationMs}ms`,
      false,
    )
    await this.enterHover(target)
    await sleep(hoverDurationMs)
    await this.exitHover()
    LOG.debug(`hover: "${target.getSceneObject().name}" complete`, false)
  }

  /**
   * Starts hovering over an interactable
   * @param target - Interactable to hover over
   */
  protected async enterHover(target: Interactable): Promise<void> {
    LOG.debug(`enterHover: "${target.getSceneObject().name}"`, false)
    this.assertInteractorEnabled()
    const hoverEntered = this.awaitInteractableEvent(
      target.onHoverEnter,
      "onHoverEnter",
      target,
    )
    await this.setTarget(target)
    try {
      await hoverEntered
    } catch (error) {
      /*
       * setTarget already pointed us at target, so clear it: a failed hover
       * must not leave a phantom currentInteractable.
       */
      this.overrideInteractable = undefined
      throw error
    }
  }

  /**
   * Throws if the IK interactor is disabled. `InteractionManager` skips disabled
   * interactors, so the awaited events would never fire.
   */
  private assertInteractorEnabled(): void {
    if (this.sikInteractor.enabled) {
      return
    }
    throw new Error(
      `Interactor "${this.sikInteractor.sceneObject.name}" is disabled, so IK will not dispatch its interaction events. If the user input suppressor disabled it, allow it with UserInputSuppressor.allow().`,
    )
  }

  /**
   * Stops hovering over an interactable
   */
  protected async exitHover(): Promise<void> {
    LOG.debug(`exitHover`, false)
    if (isNull(this.overrideInteractable)) {
      this.overrideInteractable = undefined
      return
    }
    if (this.overrideTrigger !== InteractorTriggerType.None) {
      return
    }

    const hoverExited = awaitInteractorEvent(
      this.overrideInteractable.onInteractorHoverExit,
      this.sikInteractor,
      {
        timeoutMs: this.eventTimeoutMs,
        description: `onInteractorHoverExit on "${this.overrideInteractable.getSceneObject().name}"`,
      },
    )
    await nextFrame()
    this.overrideInteractable = undefined
    await hoverExited
  }

  /**
   * Targets, triggers, and drags, an interactable
   *
   * @param interactable - Interactable to drag
   * @param dragVector - Vector to drag per time unit
   * @param dragDurationMs - duration of the drag in milliseconds
   * @param beforeTrigger - Called after hover is entered but before TriggerStart fires.
   *   Used internally by {@link LeafTwoHandInteractor} to synchronize TriggerStart
   *   timing across hands. Not intended for direct use in scenarios.
   */
  async drag(
    target: Interactable,
    dragVector: vec3,
    dragDurationMs: number,
    beforeTrigger?: () => Promise<void>,
  ): Promise<void> {
    LOG.debug(
      `drag: "${target.getSceneObject().name}" vector=(${dragVector.x.toFixed(2)}, ${dragVector.y.toFixed(2)}, ${dragVector.z.toFixed(2)}) duration=${dragDurationMs}ms`,
      false,
    )
    const unsubscribeDragUpdate = target.onDragUpdate.add(() => {
      this.startPoint = this.startPoint.add(dragVector)
      this.endPoint = this.endPoint.add(dragVector)
    })

    /* The loop deadline can outlive the target, so read the name up front. */
    const targetName = target.getSceneObject().name

    /*
     * Listen now so neither event is missed, but start each timeout at its
     * await: a clock started here would be spent on hover and beforeTrigger.
     */
    const [dragStartFired, cancelDragStart] = makeEventPromise(
      target.onDragStart,
    )
    const [dragEndFired, cancelDragEnd] = makeEventPromise(target.onDragEnd)
    const timeoutDisabled =
      !Number.isFinite(this.eventTimeoutMs) || this.eventTimeoutMs <= 0

    try {
      await this.enterHover(target)
      if (beforeTrigger !== undefined) await beforeTrigger()
      await nextFrame()
      await nextFrame()
      const startTimeMs = getTime() * SECS_TO_MS
      this.overrideTrigger = InteractorTriggerType.Select
      await nextFrame()

      this.overrideDragVector = dragVector

      await withEventTimeout(dragStartFired, cancelDragStart, {
        timeoutMs: this.eventTimeoutMs,
        description: `onDragStart on "${targetName}"`,
      })

      /* One budget for the whole loop, because a per-frame timeout would leak an uncancellable DelayedCallbackEvent every frame. */
      const dragTimedOut: Promise<void> = timeoutDisabled
        ? new Promise<void>(() => {})
        : sleep(dragDurationMs + this.eventTimeoutMs).then(() => {
            throw new Error(
              `Timed out waiting for onTriggerUpdate on "${targetName}"`,
            )
          })
      /* The loop usually finishes first, leaving this rejection with nobody
       * awaiting it. Attach a no-op catch so it never surfaces as an unhandled
       * rejection. The race below still sees the original rejection. */
      dragTimedOut.catch(() => {})

      /* Detach in a finally so the losing listener never outlives the race. */
      while (getTime() * SECS_TO_MS < startTimeMs + dragDurationMs) {
        const [updated, cancel] = makeEventPromise(target.onTriggerUpdate)
        try {
          await Promise.race([updated, dragTimedOut])
        } finally {
          cancel()
        }
      }

      this.overrideTrigger = InteractorTriggerType.None
      await withEventTimeout(dragEndFired, cancelDragEnd, {
        timeoutMs: this.eventTimeoutMs,
        description: `onDragEnd on "${targetName}"`,
      })
    } catch (error) {
      /* Restore synchronously: exitHover would await and mask this error. */
      this.overrideTrigger = InteractorTriggerType.None
      this.overrideInteractable = undefined
      throw error
    } finally {
      /*
       * These listeners outlive the interactor, so detach on both paths;
       * cancel() is idempotent, so an already-fired event is a no-op.
       */
      unsubscribeDragUpdate()
      cancelDragStart()
      cancelDragEnd()
      this.overrideDragVector = undefined
      this.resetStartEndPoint()
    }

    await this.exitHover()
    LOG.debug(`drag: "${target.getSceneObject().name}" complete`, false)
  }

  /**
   * Triggers a custom command
   *
   * @param commandId - ID of the command to trigger
   * @returns true if the command exists and was run successfully, false otherwise.
   */
  async triggerCustomCommand(
    commandId,
    args?: CustomCommandArgs,
  ): Promise<void> {
    LOG.debug(`triggerCustomCommand: "${commandId}"`, false)
    const command = this.customCommandsById.get(commandId)
    if (!command) {
      throw new Error(`Command "${commandId}" does not exist.`)
    }
    return command(args)
  }

  /**
   * @returns an array of all custom command names defined for this lens.
   */
  getCustomCommands(): string[] {
    return Array.from(this.customCommandsById.keys())
  }

  /**
   * Creates a binding to a command id, e.g: "open_capture_view". Useful to expose commands
   * to external component through Snips, and avoid low level control.
   *
   * @param commandId - ID of the command to bind
   * @param command - command to trigger
   */
  protected bindCustomCommand(commandId: string, command: CustomCommand): void {
    if (this.customCommandsById.has(commandId)) {
      LOG.warn(`Command ID "${commandId}" already exists. Overriding.`, false)
    }
    this.customCommandsById.set(commandId, command)
  }

  protected async setTarget(target: Interactable): Promise<void> {
    if (isNull(target)) {
      throw new Error(`Target "${target}" is null.`)
    }
    this.overrideInteractable = target
    Physics.createGlobalProbe().rayCast(
      this.camera.getWorldPosition(),
      target.getTransform().getWorldPosition(),
      (hit) => {
        // Only aim at the probe hit when it lands on the target (or a
        // descendant); a miss or an occluder would target the wrong object.
        this.startPoint = this.camera.getWorldPosition()
        if (!isNull(hit) && hitBelongsTo(hit, target.getSceneObject())) {
          this.raycastHit = hit
          this.endPoint = hit.position
        } else {
          LOG.debug(
            `setTarget: probe ${isNull(hit) ? "missed" : `hit "${isNull(hit.collider) ? "destroyed" : hit.collider.getSceneObject().name}"`}; aiming at "${target.getSceneObject().name}" transform`,
            false,
          )
          this.raycastHit = null
          this.endPoint = target.getTransform().getWorldPosition()
        }
      },
    )
  }

  protected resetStartEndPoint(): void {
    this.startPoint = this.camera.getWorldPosition()
    this.endPoint = this.initialInteractionPosition
  }

  private getDirection(): vec3 {
    return this.endPoint.sub(this.startPoint).normalize()
  }

  private getInteractablePosition(): vec3 | null {
    return isNull(this.overrideInteractable)
      ? null
      : this.overrideInteractable.getTransform().getWorldPosition()
  }

  /**
   * Updates the state of the {@link sikInteractor} to match the current state of the
   * {@link overrideInteractable}, {@link overrideTrigger}, and {@link overrideDragVector}.
   */
  private updateState(): void {
    if (isNull(this.overrideInteractable)) {
      this.overrideInteractable = undefined
    }
    this.sikInteractor["currentInteractable"] =
      this.overrideInteractable ?? null
    this.sikInteractor["currentTrigger"] = this.overrideTrigger
    this.sikInteractor["currentDragVector"] = this.overrideDragVector ?? null
  }

  /**
   * Mocks all the properties of the {@link sikInteractor} to be used in testing.
   */
  protected overrideSikProperties(): void {
    Object.defineProperties(this.sikInteractor, {
      startPoint: {
        get: () => {
          return this.startPoint
        },
        configurable: true,
      },
      endPoint: {
        get: () => {
          return this.endPoint
        },
        configurable: true,
      },
      direction: {
        get: () => {
          return this.getDirection()
        },
        configurable: true,
      },
      orientation: {
        get: () => {
          return quat.lookAt(this.getDirection(), vec3.up())
        },
        configurable: true,
      },
      distanceToTarget: {
        get: () => {
          const position = this.getInteractablePosition()
          return position === null ? null : this.startPoint.distance(position)
        },
        configurable: true,
      },
      targetHitPosition: {
        get: () => this.getInteractablePosition(),
        configurable: true,
      },
      targetHitInfo: {
        get: () => {
          /**
           * IK's CursorViewModel reads `targetHitInfo?.hit.position` — optional chaining
           * short-circuits on null targetHitInfo but NOT on null `hit`. Return null here when
           * no physics rayCast has been performed (direct / IK interactions) so the cursor's
           * `?? fallback` fires instead of crashing on `null.position`.
           */
          if (isNull(this.overrideInteractable) || isNull(this.raycastHit))
            return null
          return {
            /**
             * The {@link Interactable} that was hit
             */
            interactable: this.overrideInteractable,
            /**
             * The {@link vec3} representing the hit position relative to the Interactable's local space.
             */
            localHitPosition: this.raycastHit.position,
            /**
             * The detected hit {@link RayCastHit} from the collision
             */
            hit: this.raycastHit,
            /**
             * The {@link TargetingMode} that resulted in this collision
             */
            targetMode: this.targetingMode,
          }
        },
        configurable: true,
      },
      planecastDragVector: {
        get: () => {
          return this.sikInteractor.currentDragVector
        },
        configurable: true,
      },
      planecastPoint: {
        // Add `endPoint` (the accumulated drag offset, zero when not dragging) so
        // the point travels during a drag — widgets like Slider read its delta.
        get: () => {
          const interactablePosition = this.getInteractablePosition()
          return interactablePosition === null
            ? this.endPoint
            : interactablePosition.add(this.endPoint)
        },
        configurable: true,
      },
      activeTargetingMode: {
        get: () => {
          return this.targetingMode
        },
        configurable: true,
      },
      maxRaycastDistance: {
        get: () => {
          return 0
        },
        configurable: true,
      },
      interactionStrength: {
        get: () => {
          if (
            this.sikInteractor.currentTrigger !== InteractorTriggerType.None
          ) {
            return INTERACTOR_TRIGGER_STRENGTH
          } else if (this.sikInteractor.currentInteractable !== null) {
            return INTERACTOR_HOVER_STRENGTH
          } else {
            return INTERACTOR_IDLE_STRENGTH
          }
        },
        configurable: true,
      },
    })

    // Must report targeting once LEAF aims at a target: IK only runs
    // far-field selection for interactors that already report isTargeting(),
    // so deriving this from currentInteractable alone is circular.
    this.sikInteractor.isTargeting = () => {
      return (
        !isNull(this.overrideInteractable) ||
        !isNull(this.sikInteractor.currentInteractable)
      )
    }

    this.sikInteractor.isActive = () => {
      return true
    }
  }

  /**
   * Sets the interactor trigger type to selecting.
   */
  startSelecting(): void {
    this.setTriggerType(InteractorTriggerType.Select)
  }

  /**
   * Sets the interactor trigger type to none.
   */
  stopSelecting(): void {
    this.setTriggerType(InteractorTriggerType.None)
  }
}

/** True when `hit`'s collider sits on `targetSceneObject` or one of its descendants. */
function hitBelongsTo(
  hit: RayCastHit,
  targetSceneObject: SceneObject,
): boolean {
  if (isNull(hit.collider)) return false
  let current: SceneObject | null = hit.collider.getSceneObject()
  while (!isNull(current)) {
    if (current!.isSame(targetSceneObject)) return true
    current = current!.getParent()
  }
  return false
}

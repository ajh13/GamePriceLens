import {
  InteractorInputType,
  TargetingMode,
} from "InteractionKit.lspkg/Core/Interactor/Interactor"
import {HandInteractor} from "InteractionKit.lspkg/Core/HandInteractor/HandInteractor"
import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {HandType} from "InteractionKit.lspkg/Providers/HandInputData/HandType"
import {IK} from "InteractionKit.lspkg/IK"

import {Hand} from "./Hand"
import {PINCH_POSITION_OFFSET, VERTICAL_HAND_ROTATION} from "./Gestures"
import TrackedHandWrapper from "./TrackedHandWrapper"
import {
  INTERACTION_DURATION_MS,
  BaseLeafInteractor,
  TriggerConfig,
} from "../BaseLeafInteractor"
import {Logger} from "Leaf.lspkg/Utils/common/Logger"
import {ignoreAnimationCancellationError} from "Leaf.lspkg/Utils/common/Animate"

const LOG = new Logger("LeafSingleHandInteractor")

/*
 * Hand interactions are the ones that silently stop registering: near-field
 * targeting has to actually reach the collider, and when it does not, the
 * awaited IK event never arrives. Default the event guard on for hands so
 * those runs name the event that never fired instead of hanging until the
 * harness gives up. Scenarios can still widen or disable it per instance.
 */
const HAND_EVENT_TIMEOUT_MS = 3000

export type HandFace = "palm" | "back"

/**
 * The IK {@link HandInteractor} for a hand.
 *
 * Empty until IK's prefab has awoken, since `inputType` is tagged in
 * `onAwake`, and empty in a lens with no hand interactor.
 *
 * @throws when none is registered.
 */
function requireSikHandInteractor(handType: HandType): HandInteractor {
  const interactors = IK.InteractionManager.getInteractorsByType(
    handType === "right"
      ? InteractorInputType.RightHand
      : InteractorInputType.LeftHand,
  )
  const handInteractor = interactors[0] as HandInteractor | undefined
  if (isNull(handInteractor)) {
    throw new Error(
      `IK has no registered "${handType}" HandInteractor. Add IK's hand prefab to the scene, and build the interactor from the scenario's run() so IK has finished waking.`,
    )
  }
  return handInteractor
}

/**
 * Offsets at which the start point of the interactor is placed when dragging an interactable,
 * to enable two hands manipulation.
 */
const TRIGGER_OFFSETS = {
  left: new vec3(-0.4, 0, 0),
  right: new vec3(0.4, 0, 0),
}

/**
 * Single-hand interactor implementation. Simulates hand input through IK
 * HandInteractor.
 *
 * Not constructable directly: obtain instances through
 * {@link LeafHandInteractor.get} for a single hand, or the `.left` / `.right`
 * hands of a {@link LeafTwoHandInteractor}. This keeps a single shared interactor
 * per hand and avoids duplicate interactors for the same hand. Subclasses (e.g.
 * domain-specific hand interactors) may still be constructed directly.
 */
export class LeafSingleHandInteractor extends BaseLeafInteractor {
  private handWrapper: TrackedHandWrapper
  private handWrapperDestroy: () => void
  /** Set while trigger() runs; see setTarget. */
  private aimStraightOn = false

  constructor(
    protected handType: HandType,
    debugMode: boolean = true,
  ) {
    if (new.target === LeafSingleHandInteractor) {
      throw new Error(
        "LeafSingleHandInteractor cannot be constructed directly. Use LeafHandInteractor.get(handType) or a LeafTwoHandInteractor's .left / .right hands.",
      )
    }
    if (!debugMode) {
      throw new Error("Debug mode must be enabled for LeafSingleHandInteractor")
    }
    super(requireSikHandInteractor(handType))

    const sikHand = IK.HandInputData.getHand(handType)
    if (!sikHand) {
      throw new Error(`Hand of type ${handType} not found`)
    }

    ;({hand: this.handWrapper, destroy: this.handWrapperDestroy} =
      TrackedHandWrapper.create(sikHand, debugMode))

    this.eventTimeoutMs = HAND_EVENT_TIMEOUT_MS
    this.interactionOffset = TRIGGER_OFFSETS[handType]
    this.targetingMode = TargetingMode.Direct

    // Ensure hand is in the correct initial position
    this.hand.hide().catch(ignoreAnimationCancellationError)
    this.hand
      .setRotation(VERTICAL_HAND_ROTATION[handType])
      .catch(ignoreAnimationCancellationError)

    // Override hovering-related methods specific to hand interaction
    this.overrideHandHoveringMethods()
  }

  /**
   * Overrides hovering-related methods for hand-specific behavior
   */
  private overrideHandHoveringMethods(): void {
    Object.defineProperty(this.sikInteractor, "isHoveringCurrentInteractable", {
      get: () => {
        return this.sikInteractor.currentInteractable !== null
      },
      configurable: true,
    })

    Object.defineProperty(this.sikInteractor, "hoveredInteractables", {
      get: () => {
        return this.sikInteractor.currentInteractable
          ? [this.sikInteractor.currentInteractable]
          : []
      },
      configurable: true,
    })

    this.sikInteractor.isHoveringInteractable = (interactable: any) => {
      return this.sikInteractor.currentInteractable === interactable
    }

    this.sikInteractor.isHoveringInteractableHierarchy = (
      interactable: any,
    ) => {
      return this.sikInteractor.currentInteractable === interactable
    }
  }

  // @override
  protected destroy(): void {
    this.handWrapperDestroy()
    super.destroy()
  }

  /**
   * @returns The hand wrapper that can be used to manipulate the hand gesture.
   */
  get hand(): Hand {
    return this.handWrapper.hand
  }

  /**
   * @override
   * Move the hand to the target interactable before triggering it.
   * @param target - The interactable to trigger.
   * @param resetOnComplete - If true, the hand will be reset to its last known
   */
  async trigger(target: Interactable, config?: TriggerConfig): Promise<void> {
    const previousPosition = this.hand.wrist.position
    const previousGesture = this.hand.lastGesture
    const targetPosition = target
      .getSceneObject()
      .getTransform()
      .getWorldPosition()
    LOG.debug(
      `trigger [${this.handType}]: "${target.getSceneObject().name}" at (${targetPosition.x.toFixed(2)}, ${targetPosition.y.toFixed(2)}, ${targetPosition.z.toFixed(2)}) gesture=pinch`,
      false,
    )
    await this.hand.setPosition(
      targetPosition.add(PINCH_POSITION_OFFSET[this.handType]),
    )
    await this.hand.makeGesture("pinch")
    await this.alignIndexTip(target)
    this.aimStraightOn = true
    try {
      await super.trigger(target, config)
    } finally {
      this.aimStraightOn = false
      /* Restore the gesture even when the trigger threw, or the hand stays pinched for the rest of the scenario. */
      try {
        await this.hand.makeGesture(previousGesture)
        if (config?.resetOnComplete) {
          await this.hand.setPosition(previousPosition)
        }
      } catch (restoreError) {
        LOG.warn(`trigger: hand restore failed: ${restoreError}`, false)
      }
    }
  }

  /**
   * @override
   * For hand interactors, we set the target directly without raycast.
   * This ensures the hand-specific offset (interactionOffset) is preserved
   * for two-hand manipulation (scaling).
   */
  protected async setTarget(target: Interactable): Promise<void> {
    if (isNull(target)) {
      throw new Error(`Target "${target}" is null.`)
    }
    this.overrideInteractable = target
    const targetPos = target.getSceneObject().getTransform().getWorldPosition()
    const scaledOffset = this.scalePointByInteractableSize(
      target,
      this.interactionOffset,
    )
    this.endPoint = targetPos.add(scaledOffset)
    const pinchOffset = PINCH_POSITION_OFFSET[this.handType]
    if (this.aimStraightOn) {
      /* Cast along the target's normal, from the side the hand is on, so the
       * ray lands where the index tip projects on any plane parallel to the
       * target (see alignIndexTip). */
      const normal = target.getSceneObject().getTransform().forward
      const side = pinchOffset.dot(normal) >= 0 ? 1 : -1
      this.startPoint = this.endPoint.add(
        normal.uniformScale(side * pinchOffset.length),
      )
    } else {
      this.startPoint = this.endPoint.add(pinchOffset)
    }
  }

  /**
   * Shift the hand in the target's plane so the index tip projects onto the
   * point the trigger ray aims at.
   *
   * UIKit 4.0's ScrollWindow anchors a pinch on its children at the ray's hit
   * and then tracks the index tip's projection; when they are more than
   * 2.5 cm apart it reads the pinch as a scroll and swallows the child's
   * onTriggerEnd.
   */
  private async alignIndexTip(target: Interactable): Promise<void> {
    const transform = target.getSceneObject().getTransform()
    const normal = transform.forward
    const aim = transform
      .getWorldPosition()
      .add(this.scalePointByInteractableSize(target, this.interactionOffset))
    const delta = aim.sub(this.hand.indexTip.position)
    const lateral = delta.sub(normal.uniformScale(delta.dot(normal)))
    if (lateral.length > 0.01) {
      await this.hand.setPosition(this.hand.wrist.position.add(lateral))
    }
  }

  /**
   * @override
   * Move the hand to the target interactable before triggering it.
   * @param target - The interactable to drag.
   * @param dragVector - The vector to drag the target interactable.
   * @param dragDurationMs - Duration to drag the target interactable, in milliseconds.
   * @param beforeTrigger - See {@link BaseLeafInteractor.drag}.
   * @param resetOnComplete - If true, the hand will be reset to its last known position
   * after dragging.
   */
  async drag(
    target: Interactable,
    dragVector: vec3,
    dragDurationMs: number,
    beforeTrigger?: () => Promise<void>,
    resetOnComplete: boolean = false,
  ): Promise<void> {
    const previousPosition = this.hand.wrist.position
    const previousGesture = this.hand.lastGesture

    // Set the hand position to the target interactable with the hand-specific offset
    const targetPos = target.getTransform().getWorldPosition()
    LOG.debug(
      `drag [${this.handType}]: "${target.getSceneObject().name}" vector=(${dragVector.x.toFixed(2)}, ${dragVector.y.toFixed(2)}, ${dragVector.z.toFixed(2)}) duration=${dragDurationMs}ms`,
      false,
    )
    await this.hand.setPosition(
      targetPos
        .add(this.scalePointByInteractableSize(target, this.interactionOffset))
        .add(PINCH_POSITION_OFFSET[this.handType]),
    )
    await this.hand.makeGesture("pinch")

    // Follow the target position while dragging
    const unsubscribeDragUpdate = target.onDragUpdate.add(() => {
      this.hand.setPosition(
        this.endPoint.add(PINCH_POSITION_OFFSET[this.handType]),
        0,
      )
    })
    try {
      await super.drag(target, dragVector, dragDurationMs, beforeTrigger)
    } finally {
      /* A timed-out drag never reaches onDragEnd, so unsubscribe here or the onDragUpdate listener outlives this drag. */
      unsubscribeDragUpdate()
      try {
        await this.hand.makeGesture(previousGesture)
        if (resetOnComplete) {
          await this.hand.setPosition(previousPosition)
        }
      } catch (restoreError) {
        LOG.warn(`drag: hand restore failed: ${restoreError}`, false)
      }
    }
  }

  /**
   * @override
   *  Move the hand to the target interactable before triggering it.
   * @param target - The interactable to hover over.
   * @param hoverDurationMs - Duration to hover over the target interactable, in milliseconds.
   * If not specified, defaults to {@link INTERACTION_DURATION_MS}.
   * @param resetOnComplete - If true, the hand will be reset to its last known
   * position after hovering.
   */
  async hover(
    target: Interactable,
    hoverDurationMs: number = INTERACTION_DURATION_MS,
    resetOnComplete: boolean = false,
  ): Promise<void> {
    const previousPosition = this.hand.wrist.position
    const previousGesture = this.hand.lastGesture
    const targetPosition = target
      .getSceneObject()
      .getTransform()
      .getWorldPosition()
    LOG.debug(
      `hover [${this.handType}]: "${target.getSceneObject().name}" at (${targetPosition.x.toFixed(2)}, ${targetPosition.y.toFixed(2)}, ${targetPosition.z.toFixed(2)}) duration=${hoverDurationMs}ms`,
      false,
    )
    const offset = this.hand.wrist.position.sub(this.hand.indexTip.position)

    // Move the hand to the target and trigger it
    await this.hand.setPosition(targetPosition.add(offset))
    await this.hand.makeGesture("relaxed")
    try {
      await super.hover(target, hoverDurationMs)
    } finally {
      try {
        await this.hand.makeGesture(previousGesture)
        if (resetOnComplete) {
          await this.hand.setPosition(previousPosition)
          LOG.debug(
            `hover [${this.handType}]: "${target.getSceneObject().name}" reset to (${previousPosition.x.toFixed(2)}, ${previousPosition.y.toFixed(2)}, ${previousPosition.z.toFixed(2)})`,
            false,
          )
        }
      } catch (restoreError) {
        LOG.warn(`hover: hand restore failed: ${restoreError}`, false)
      }
    }
  }
}

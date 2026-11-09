import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {HandType} from "InteractionKit.lspkg/Providers/HandInputData/HandType"
import WorldCameraFinderProvider from "InteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import {nextFrame} from "Leaf.lspkg/Utils/common/Utils"
import {DiagnosticRecorder} from "Leaf.lspkg/Diagnostic/DiagnosticRecorder"
import {withTimeoutOrRecord} from "Leaf.lspkg/Diagnostic/categories/ConvergenceTimeout"
import {TargetMissing} from "Leaf.lspkg/Diagnostic/categories/TargetMissing"

import {IKHand, PINCH_GESTURE_DURATION_MS} from "./IKHand"

const PINCH_CONVERGENCE_CM = 1.5
const HOVER_ENTER_TIMEOUT_MS = 3000
/** Per-frame pinch-midpoint motion under which the wrist is "settled". */
const SETTLED_MOTION_CM = 0.05
const SETTLED_STABLE_FRAMES = 5

/** Surface that {@link DirectInteraction} needs from its host (the IK hand interactor). */
export type DirectInteractionHost = {
  readonly hand: IKHand
  readonly cameraProvider: WorldCameraFinderProvider
  readonly handType: HandType
  isAlive(): boolean
  removeFromNearbyInteractables(target: Interactable): void
  pinchAndAwaitTriggerEnd(
    target: Interactable,
    hoverEntered: Promise<void>,
  ): Promise<void>
  finishTrigger(): Promise<void>
}

/**
 * In-reach interaction strategy: aim the wrist so the pinch midpoint
 * lands on the target, then close the pinch for IK's physical
 * proximity provider to fire `onHoverEnter` → `onTriggerStart/End`.
 */
export class DirectInteraction {
  private _currentTarget?: Interactable
  private _currentAimPoint?: vec3

  constructor(private readonly _host: DirectInteractionHost) {}

  /** Active direct target while an interaction is in flight. */
  get currentTarget(): Interactable | undefined {
    return this._currentTarget
  }

  /** Per-frame pinch-midpoint target for the host's IK loop. */
  get currentAimPoint(): vec3 | undefined {
    if (this._currentAimPoint !== undefined) return this._currentAimPoint
    return this._currentTarget
      ?.getSceneObject()
      .getTransform()
      .getWorldPosition()
  }

  /**
   * Pinch-trigger `target`.
   *
   * @param target       - The interactable to trigger; must be within arm reach.
   * @param hoverEntered - Pre-armed promise that resolves on `target.onHoverEnter`.
   * @returns Resolves when the host's pinch + trigger-end sequence completes.
   */
  async trigger(
    target: Interactable,
    hoverEntered: Promise<void>,
  ): Promise<void> {
    try {
      this._currentTarget = target
      const targetPosition = target
        .getSceneObject()
        .getTransform()
        .getWorldPosition()
      await this.waitForInFoV(targetPosition)
      await this.waitForPinchMidpointConvergence(
        targetPosition,
        PINCH_CONVERGENCE_CM,
      )
      await this._host.hand.makeGesture(
        "pinch",
        undefined,
        PINCH_GESTURE_DURATION_MS,
      )
      await this._host.pinchAndAwaitTriggerEnd(target, hoverEntered)
    } finally {
      this._host.removeFromNearbyInteractables(target)
      this._currentTarget = undefined
      await this._host.finishTrigger()
    }
  }

  /**
   * Pinch `target` then slide the wrist by `worldDelta`.
   *
   * @param target       - The interactable to drag; must be within arm reach.
   * @param worldDelta   - Cursor translation in world-space centimeters.
   * @param hoverEntered - Pre-armed promise that resolves on `target.onHoverEnter`.
   */
  async drag(
    target: Interactable,
    worldDelta: vec3,
    hoverEntered: Promise<void>,
    afterConvergence?: () => Promise<void>,
    gripOffset?: vec3,
  ): Promise<void> {
    const targetCenter = target
      .getSceneObject()
      .getTransform()
      .getWorldPosition()
    const startPosition =
      gripOffset !== undefined ? targetCenter.add(gripOffset) : targetCenter
    const endPosition = startPosition.add(worldDelta)

    try {
      this._currentAimPoint = startPosition
      await this.waitForPinchMidpointConvergence(
        startPosition,
        PINCH_CONVERGENCE_CM,
      )

      /** Pinch before awaiting hover so IK's proximity sensor sees the fingertips contact the collider. */
      await this._host.hand.makeGesture(
        "pinch",
        undefined,
        PINCH_GESTURE_DURATION_MS,
      )
      /** Target was destroyed during the prior awaits — record the destruction instead of waiting for a hover IK will never fire. */
      if (DiagnosticRecorder.getInstance().checkAndRecord(new TargetMissing(target, "drag", this._host.handType))) return
      const targetName = target.getSceneObject().name
      await withTimeoutOrRecord(hoverEntered, HOVER_ENTER_TIMEOUT_MS, {
        handSide: this._host.handType,
        interactableName: targetName,
        message: `[IK ${this._host.handType}] drag hoverEnter timed out for "${targetName}"`,
      })
      if (afterConvergence !== undefined) await afterConvergence()
      this._host.hand.setPinching(true)

      /** Wait for settle, not absolute distance — a short drag can land within threshold before IK sees motion. */
      this._currentAimPoint = endPosition
      await this.waitForPinchMidpointSettled()
    } finally {
      this._currentAimPoint = undefined
      await this._host.finishTrigger()
    }
  }

  private async waitForInFoV(position: vec3): Promise<void> {
    while (this._host.isAlive() && !this._host.cameraProvider.inFoV(position)) {
      await nextFrame()
    }
  }

  /** Poll until the hand's predicted pinch midpoint is within `thresholdCm` of `targetPosition`. */
  private async waitForPinchMidpointConvergence(
    targetPosition: vec3,
    thresholdCm: number,
  ): Promise<void> {
    while (this._host.isAlive()) {
      const midpoint = this._host.hand.pinchEndpointWorld
      if (midpoint.distance(targetPosition) <= thresholdCm) return
      await nextFrame()
    }
  }

  /** Poll until pinch-midpoint motion drops below {@link SETTLED_MOTION_CM} for {@link SETTLED_STABLE_FRAMES} frames. */
  private async waitForPinchMidpointSettled(): Promise<void> {
    let previous = this._host.hand.pinchEndpointWorld
    let stableFrames = 0
    while (this._host.isAlive()) {
      await nextFrame()
      const current = this._host.hand.pinchEndpointWorld
      if (current.distance(previous) < SETTLED_MOTION_CM) {
        if (++stableFrames >= SETTLED_STABLE_FRAMES) return
      } else {
        stableFrames = 0
      }
      previous = current
    }
  }
}

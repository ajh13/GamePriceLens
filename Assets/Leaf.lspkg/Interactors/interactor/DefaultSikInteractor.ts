import BaseInteractor from "InteractionKit.lspkg/Core/Interactor/BaseInteractor"
import {
  InteractorInputType,
  InteractorTriggerType,
  TargetingMode,
} from "InteractionKit.lspkg/Core/Interactor/Interactor"
import {InteractableHitInfo} from "InteractionKit.lspkg/Providers/TargetProvider/TargetProvider"

const INTERACTOR_IDLE_STRENGTH = 0
const INTERACTOR_HOVER_STRENGTH = 0.2
const INTERACTOR_TRIGGER_STRENGTH = 0.8

/**
 * Default IK interactor component.
 * Represents CustomController input type.
 */
@component
export class DefaultSikInteractor extends BaseInteractor {
  constructor() {
    super()
    this.inputType = InteractorInputType.CustomController
  }

  /** @inheritdoc */
  get startPoint(): vec3 | null {
    return vec3.zero()
  }

  /** @inheritdoc */
  get endPoint(): vec3 | null {
    return vec3.zero()
  }

  /** @inheritdoc */
  get direction(): vec3 | null {
    return vec3.forward()
  }

  /** @inheritdoc */
  get orientation(): quat | null {
    return quat.quatIdentity()
  }

  /** @inheritdoc */
  get distanceToTarget(): number | null {
    return 0
  }

  /** @inheritdoc */
  get targetHitPosition(): vec3 | null {
    return this.currentInteractable?.getTransform().getWorldPosition() ?? null
  }

  /** @inheritdoc */
  get targetHitInfo(): InteractableHitInfo | null {
    return null
  }

  /** @inheritdoc */
  override get planecastDragVector(): vec3 | null {
    return this.currentDragVector
  }

  /** @inheritdoc */
  override get planecastPoint(): vec3 | null {
    return this.currentInteractable?.getTransform().getWorldPosition() ?? null
  }

  /** @inheritdoc */
  get activeTargetingMode(): TargetingMode {
    return TargetingMode.All
  }

  /** @inheritdoc */
  get maxRaycastDistance(): number {
    return 0
  }

  /** @inheritdoc */
  get interactionStrength(): number {
    if (this.currentTrigger !== InteractorTriggerType.None) {
      return INTERACTOR_TRIGGER_STRENGTH
    } else if (!isNull(this.currentInteractable)) {
      return INTERACTOR_HOVER_STRENGTH
    } else {
      return INTERACTOR_IDLE_STRENGTH
    }
  }

  set drawDebug(debug: boolean) {}
  get drawDebug(): boolean {
    return true
  }

  /** @inheritdoc */
  isTargeting(): boolean {
    return !isNull(this.currentInteractable)
  }

  /** @inheritdoc */
  isActive(): boolean {
    return true
  }

  /** @inheritdoc */
  get isHoveringCurrentInteractable(): boolean {
    return this.currentInteractable !== null
  }

  /** @inheritdoc */
  get hoveredInteractables(): any[] {
    return this.currentInteractable ? [this.currentInteractable] : []
  }

  /** @inheritdoc */
  isHoveringInteractable(interactable: any): boolean {
    return this.currentInteractable === interactable
  }

  /** @inheritdoc */
  isHoveringInteractableHierarchy(interactable: any): boolean {
    return this.isHoveringInteractable(interactable)
  }

  /** @inheritdoc */
  protected clearCurrentHitInfo(): void {}
}

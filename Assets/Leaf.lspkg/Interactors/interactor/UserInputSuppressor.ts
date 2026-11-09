import {
  Interactor,
  InteractorInputType,
} from "InteractionKit.lspkg/Core/Interactor/Interactor"
import {IK} from "InteractionKit.lspkg/IK"
import {Logger} from "Leaf.lspkg/Utils/common/Logger"

const LOG = new Logger("UserInputSuppressor")

/**
 * Suppresses real user input while a scenario runs, by clearing `enabled` on the
 * interactors registered with IK's `InteractionManager`. Interactors LEAF takes
 * over are handed back through {@link allow}.
 *
 * {@link suppress} acts on the interactors registered at the time it is called.
 * IK registers an interactor from `BaseInteractor`'s constructor and only
 * deregisters it on destroy, so its prefab interactors are all registered at
 * scene load, well before a scenario starts: hand-tracking loss and recovery
 * change tracking data, not registration. A lens that builds an interactor
 * mid-run (for instance by instantiating a prefab containing one) would not be
 * covered. {@link suppress} is re-entrant and records each interactor's state
 * only once, so it can be called again to pick up late arrivals.
 */
export class UserInputSuppressor {
  private static instance: UserInputSuppressor

  private previousEnabled = new Map<Interactor, boolean>()
  private allowed = new Set<Interactor>()

  /**
   * @returns The singleton instance, creating it on first access.
   */
  static getInstance(): UserInputSuppressor {
    if (!this.instance) {
      this.instance = new UserInputSuppressor()
    }
    return this.instance
  }

  /**
   * Disables every registered interactor that LEAF has not allowed, remembering
   * its previous state.
   */
  suppress(): void {
    const interactors = IK.InteractionManager.getInteractorsByType(
      InteractorInputType.All,
    )
    for (const interactor of interactors) {
      /* Skip anything already held, so a second suppress cannot record the disabled state as the original. */
      if (
        isNull(interactor) ||
        this.allowed.has(interactor) ||
        this.previousEnabled.has(interactor)
      ) {
        continue
      }
      this.previousEnabled.set(interactor, interactor.enabled)
      interactor.enabled = false
    }

    LOG.info(
      `User input suppressed (${this.previousEnabled.size} interactors)`,
      false,
    )
  }

  /**
   * Marks an interactor as driven by LEAF, so it is left enabled. Works before or
   * after {@link suppress}: scenarios that build their interactor in a field
   * initializer do so while the scenario component is created, which is before
   * the scenario manager suppresses input.
   *
   * @param interactor - The IK interactor LEAF has taken over.
   */
  allow(interactor: Interactor): void {
    if (isNull(interactor)) {
      return
    }
    this.allowed.add(interactor)

    const previous = this.previousEnabled.get(interactor)
    if (previous !== undefined) {
      this.previousEnabled.delete(interactor)
      interactor.enabled = previous
    }
  }

  /** Re-enables every suppressed interactor and clears the allow list. */
  restore(): void {
    if (this.previousEnabled.size > 0) {
      LOG.info(
        `User input restored (${this.previousEnabled.size} interactors)`,
        false,
      )
    }
    this.previousEnabled.forEach((enabled, interactor) => {
      if (!isNull(interactor)) {
        interactor.enabled = enabled
      }
    })
    this.previousEnabled.clear()
    this.allowed.clear()
  }
}

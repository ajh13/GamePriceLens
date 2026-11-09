import {ScenarioMetadata} from "../ScenarioMetadata"
import {
  EnsembleInfo,
  EnsembleMetadata,
  toEnsembleInfo,
} from "../../connected/EnsembleMetadata"

/**
 * The scenario manager's registry: Scenarios and Ensembles in one id namespace
 *, with the invariants enforced at registration - whichever side
 * registers second sees a clash - and Role resolution for ConnectedRuns.
 *
 * Pure (no Lens Studio globals) so it is unit-testable outside the runtime;
 * {@link DefaultScenarioManager} owns one and adds the runtime concerns.
 */
export class ScenarioRegistry {
  private scenarioMetadataById: Map<string, ScenarioMetadata> = new Map()
  private ensemblesById: Map<string, EnsembleMetadata> = new Map()

  /** @throws if the id is already a Scenario or an Ensemble. */
  registerScenario(metadata: ScenarioMetadata): void {
    if (this.scenarioMetadataById.has(metadata.id)) {
      throw new Error(
        `Scenario ID "${metadata.id}" already exists. Please choose a unique scenario ID.`,
      )
    }
    if (this.ensemblesById.has(metadata.id)) {
      throw new Error(
        `"${metadata.id}" is already registered as an Ensemble. Ensemble and Scenario ids share one namespace; choose a unique id.`,
      )
    }
    this.scenarioMetadataById.set(metadata.id, metadata)
  }

  /**
   * @throws if the id is already an Ensemble or a Scenario, or a Role maps to a
   *   Scenario that is not registered.
   */
  registerEnsemble(metadata: EnsembleMetadata): void {
    if (this.ensemblesById.has(metadata.id)) {
      throw new Error(
        `Ensemble ID "${metadata.id}" already exists. Please choose a unique ensemble ID.`,
      )
    }
    if (this.scenarioMetadataById.has(metadata.id)) {
      throw new Error(
        `"${metadata.id}" is already registered as a Scenario. Ensemble and Scenario ids share one namespace; choose a unique id.`,
      )
    }
    for (const [role, scenarioId] of Object.entries(metadata.roles)) {
      if (!this.scenarioMetadataById.has(scenarioId)) {
        throw new Error(
          `Ensemble "${metadata.id}" maps Role "${role}" to Scenario "${scenarioId}", which is not registered.`,
        )
      }
    }
    this.ensemblesById.set(metadata.id, metadata)
  }

  getScenario(scenarioId: string): ScenarioMetadata | undefined {
    return this.scenarioMetadataById.get(scenarioId)
  }

  hasEnsemble(id: string): boolean {
    return this.ensemblesById.has(id)
  }

  /**
   * Standalone-runnable Scenario ids. Per-Role Scenarios are hidden: a lone
   * Role (e.g. a host with no joiner) is not runnable on its own; they stay
   * reachable through {@link resolveRole}.
   */
  listScenarioIds(): string[] {
    const roleIds = this.roleScenarioIds()
    return Array.from(this.scenarioMetadataById.keys()).filter(
      (id) => !roleIds.has(id),
    )
  }

  /** Registered Ensembles, in registration order, as their discovery shape. */
  listEnsembles(): EnsembleInfo[] {
    return Array.from(this.ensemblesById.values()).map(toEnsembleInfo)
  }

  /** @throws if the Ensemble is unknown or does not declare the Role. */
  resolveRole(ensembleId: string, role: string): string {
    const metadata = this.ensemblesById.get(ensembleId)
    if (!metadata) {
      throw new Error(
        `No Ensemble with ID "${ensembleId}". Known Ensembles: ${Array.from(this.ensemblesById.keys()).join(", ") || "(none)"}`,
      )
    }
    const scenarioId = metadata.roles[role]
    if (!scenarioId) {
      throw new Error(
        `Ensemble "${ensembleId}" has no Role "${role}". Declared Roles: ${Object.keys(metadata.roles).join(", ") || "(none)"}`,
      )
    }
    return scenarioId
  }

  private roleScenarioIds(): Set<string> {
    const ids = new Set<string>()
    for (const metadata of this.ensemblesById.values()) {
      for (const scenarioId of Object.values(metadata.roles)) {
        ids.add(scenarioId)
      }
    }
    return ids
  }
}

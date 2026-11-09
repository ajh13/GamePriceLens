import {ScenarioConfig} from "../ScenarioConfig"
import {ParameterType, ScenarioMetadata} from "../ScenarioMetadata"
import {EnsembleInfo, EnsembleMetadata} from "../../connected/EnsembleMetadata"
import {PublicApi} from "Leaf.lspkg/Utils/common/Event"

/**
 * Resolves when scenario completes successfully, throws otherwise
 */
export type AwaitScenarioComplete = Promise<void>

/**
 * Interface for ScenarioManager. Coordinates the different scenarios.
 */
export interface ScenarioManager {
  onScenarioComplete: PublicApi<void>
  /**
   * Registers a scenario.
   *
   * @param scenarioMetadata - Metadata for the scenario.
   *
   * @throws if the ID already exists.
   */
  registerScenario(scenarioMetadata: ScenarioMetadata): void

  /**
   * Registers an Ensemble, which is a Role to Scenario mapping run as a ConnectedRun
   * across several Participants. Ensemble and Scenario ids share one namespace.
   *
   * @param ensembleMetadata - The Ensemble and the (internal) Scenario id each
   *   Role runs; those Role Scenarios must already be registered.
   *
   * @throws if the ID already exists as an Ensemble or a Scenario.
   */
  registerEnsemble(ensembleMetadata: EnsembleMetadata): void

  /**
   * @returns an array of all scenario IDs that can be run standalone. Ensembles
   *   and the per-Role Scenarios they own are not included.
   */
  listScenarioIds(): string[]

  /**
   * @returns each registered Ensemble's id and Role names, for discovery, in
   *   registration order.
   */
  listEnsembles(): EnsembleInfo[]

  /**
   * @param scenarioId - ID of the scenario.
   *
   * @returns a Record of parameter names and default values for the scenario.
   * @throws if the scenario doesn't exist.
   */
  listScenarioParameters(scenarioId: string): Record<string, string>

  /**
   * @param scenarioId - ID of the scenario.
   *
   * @returns a Record of parameter names and their declared types for the
   * scenario. Parameters the scenario did not type are absent.
   * @throws if the scenario doesn't exist.
   */
  listScenarioParameterTypes(scenarioId: string): Record<string, ParameterType>

  /**
   * Start the Scenario registered under `scenarioId` by instantiating its
   * `typename` component. When `args` carries `__leaf__role`, `scenarioId` is
   * an Ensemble id and this starts one Participant's leg of a ConnectedRun (the
   * Role resolves to the Scenario actually run).
   *
   * @param scenarioId - ID of the Scenario (or, with a Role, the Ensemble).
   * @param args - Start config; reserved `__leaf__` keys are consumed by the manager.
   *
   * @throws synchronously if the id is unknown, names an Ensemble without a
   *   Role, or (with a Role) the lens has not opted into ConnectedRuns or the
   *   start is malformed.
   * @throws (via the returned promise) if the scenario failed.
   */
  startScenario(
    scenarioId: string,
    args?: ScenarioConfig,
  ): AwaitScenarioComplete
}

import {ScenarioConfig} from "./ScenarioConfig"
import {ParticipantContext} from "../connected/ParticipantContext"

/**
 * Describes a test scenario to run.
 * To avoid polluting the hierarchy, a {@link Scenario} shouldn't be added directly in the
 * scene: the scenario manager instantiates it from its `@scenariosIndex` entry when run, so
 * the component does not exist in the scene until {@link run()} is called. A failing run
 * rejects with a `FAILED: <id>` error.
 */
@component
export abstract class Scenario extends BaseScriptComponent {
  /**
   * Runs the scenario as async function. As a best practices, every call in run should be
   * prefix with {@link await} to ensure that async errors are thrown and not silently swallowed.
   * @param config Configuration to pass to the scenario.
   * @param context Identity and Rendezvous API for a ConnectedRun; absent for ordinary runs.
   */
  abstract run(
    config?: ScenarioConfig,
    context?: ParticipantContext,
  ): Promise<void>
}

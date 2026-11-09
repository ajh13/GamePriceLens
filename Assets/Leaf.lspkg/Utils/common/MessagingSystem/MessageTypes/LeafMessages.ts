import {BaseMessage} from "./BaseMessage"

// ========= Requests sent Plugin -> Lens =========
/**
 * Message to notify initialization of the plugin.
 */
export interface ScenarioListRequest extends BaseMessage {
  type: "ScenarioListRequest"
}

/**
 * Message to start the scenario with the given name and configuration.
 */
export interface ScenarioStartRequest extends BaseMessage {
  type: "ScenarioStartRequest"
  scenarioId: string
  config: Record<string, string>
}

/**
 * Message to get notified when a scenario is finished.
 */
export interface ScenarioCompletedRequest extends BaseMessage {
  type: "ScenarioCompletedRequest"
  scenarioId: string
}

// ========= Responses sent Lens -> Plugin =========
type Scenario = {
  id: string
  config: Record<string, string>
  /* Mirrors ParameterType in Scenarios/scenario/ScenarioMetadata, inlined so
     this layer keeps not importing from Scenarios. Adding a type there breaks
     the assignment in MessageScenarioHandler until it is added here too. */
  parameterTypes: Record<
    string,
    {type: "string"} | {type: "enum"; options: string[]}
  >
}

/**
 * Message to notify about all available scenarios.
 */
export interface ScenarioListResponse extends BaseMessage {
  type: "ScenarioListResponse"
  scenarios: Scenario[]
}

/**
 * Message to signal that a scenario has started.
 */
export interface ScenarioStartResponse extends BaseMessage {
  type: "ScenarioStartResponse"
  scenarioId: string
  status: "running" | "error"
  /** Start-refusal reason, when available; absent on successful starts. */
  reason?: string
}

/**
 * Message to signal that a scenario has completed or failed.
 */
export interface ScenarioCompletedResponse extends BaseMessage {
  type: "ScenarioCompletedResponse"
  scenarioId: string
  status: "succeeded" | "failed"
}

export type Response =
  ScenarioListResponse | ScenarioStartResponse | ScenarioCompletedResponse

export type Request =
  ScenarioListRequest | ScenarioStartRequest | ScenarioCompletedRequest

export type LeafMessage = Response | Request

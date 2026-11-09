import {ScenarioManager, AwaitScenarioComplete} from "./manager/ScenarioManager"
import {ScenarioConfig} from "./ScenarioConfig"
import {
  Request,
  Response,
  ScenarioListResponse,
  ScenarioStartRequest,
  ScenarioStartResponse,
  ScenarioCompletedRequest,
  ScenarioCompletedResponse,
} from "Leaf.lspkg/Utils/common/MessagingSystem/MessageTypes/LeafMessages"
import {
  DeviceParticipantTransport,
  reportRefusedStart,
} from "../connected/ParticipantTransport"
import {
  RENDEZVOUS_STEP_REQUEST,
  RENDEZVOUS_STEP_RESPONSE,
  RendezvousStepResponse,
  isConnectedRunStart,
  isRendezvousStepRequest,
  isRunAborted,
} from "../connected/ConnectedMessages"
import {Logger} from "Leaf.lspkg/Utils/common/Logger"

const LOG = new Logger("DeviceMessageReceiver")

const TOPIC = "leaf"

/**
 * Runs scenarios for the LEAF plugin when the lens is on-device.
 *
 * Instantiated by {@link MessagingBridge}, it answers plugin requests arriving
 * over a "leaf" MessageEvent. The on-device counterpart to
 * {@link MessageScenarioHandler}.
 */
export class DeviceMessageReceiver {
  private running = new Map<string, AwaitScenarioComplete>()

  /**
   * @param script - Component whose MessageEvent receives plugin requests.
   * @param transport - The device ConnectedRun transport, driven by step
   *   requests; shared with the process-wide ParticipantAgent.
   * @param scenarioManager - The manager that registers and runs Scenarios.
   */
  constructor(
    script: BaseScriptComponent,
    private transport: DeviceParticipantTransport,
    private readonly scenarioManager: ScenarioManager,
  ) {
    /*
     * Creating the MessageEvent subscribes to a device connectivity service; a
     * missing service must not crash the lens.
     */
    let messageEvent: MessageEvent
    try {
      messageEvent = script.createEvent("MessageEvent")
    } catch (error) {
      LOG.error(
        `MessageEvent unavailable; device message routing disabled: ${error}`,
      )
      return
    }
    messageEvent.bind(async (event) => {
      if (event.topic !== TOPIC) {
        return
      }
      /* Capture the token per request; list polling may overlap running steps. */
      const token = event.replyToken
      // event.data is already parsed and reply() takes a value, so no JSON here.
      const data = event.data
      /* The abort also settles this run's pending step through the transport. */
      if (isRunAborted(data)) {
        this.transport.deliverAbort(data.runId, data.reason)
        try {
          event.reply({type: data.type, runId: data.runId}, token)
        } catch (replyError) {
          LOG.error(`Failed to ack run abort: ${replyError}`)
        }
        return
      }
      if (
        typeof data === "object" &&
        data !== null &&
        data.type === RENDEZVOUS_STEP_REQUEST
      ) {
        try {
          if (!isRendezvousStepRequest(data))
            throw new Error(
              "Malformed RendezvousStepRequest: expected runId and valid releases.",
            )
          this.transport.applyReleases(data.runId, data.releases)
          const stop = await this.transport.awaitNextStop(data.runId)
          const response: RendezvousStepResponse = {
            type: RENDEZVOUS_STEP_RESPONSE,
            runId: data.runId,
            ...stop,
          }
          event.reply(response, token)
        } catch (error) {
          LOG.error(`Failed to handle step request: ${error}`)
          /* Reply with the failure so the coordinator need not wait for the transport timeout. */
          const failed: RendezvousStepResponse = {
            type: RENDEZVOUS_STEP_RESPONSE,
            runId: typeof data.runId === "string" ? data.runId : "",
            state: "done",
            status: "failed",
            detail: error instanceof Error ? error.message : String(error),
          }
          try {
            event.reply(failed, token)
          } catch (replyError) {
            LOG.error(`Failed to reply step failure: ${replyError}`)
          }
        }
        return
      }
      const request = data as Request
      try {
        const response = await this.handleRequest(request)
        event.reply(response, token)
      } catch (error) {
        // Unexpected request errors have no generic protocol response.
        LOG.error(`Failed to handle "${request?.type}" request: ${error}`)
      }
    })
  }

  private async handleRequest(request: Request): Promise<Response> {
    switch (request.type) {
      case "ScenarioListRequest":
        return this.handleScenarioListRequest()
      case "ScenarioStartRequest":
        return this.handleScenarioStartRequest(request)
      case "ScenarioCompletedRequest":
        return this.handleScenarioCompletedRequest(request)
      default:
        // The wire carries unvalidated data; the Request union does not.
        throw new Error(
          `Unknown request type "${(request as {type?: string})?.type}"`,
        )
    }
  }

  private handleScenarioListRequest(): ScenarioListResponse {
    const scenarioIds = this.scenarioManager.listScenarioIds()
    LOG.debug(
      `ScenarioListRequest: ${scenarioIds.length} scenario(s) registered`,
      false,
    )
    const scenarios = scenarioIds.map((scenarioId) => ({
      id: scenarioId,
      config: this.scenarioManager.listScenarioParameters(scenarioId),
      parameterTypes:
        this.scenarioManager.listScenarioParameterTypes(scenarioId),
    }))
    return {
      type: "ScenarioListResponse",
      scenarios: scenarios,
    }
  }

  private handleScenarioStartRequest(
    request: ScenarioStartRequest,
  ): ScenarioStartResponse {
    LOG.debug(
      `ScenarioStartRequest: "${request.scenarioId}" config=${JSON.stringify(request.config)}`,
      false,
    )
    try {
      const scenarioConfig = ScenarioConfig.fromRecord(request.config)
      const awaitScenarioComplete = this.scenarioManager.startScenario(
        request.scenarioId,
        scenarioConfig,
      )
      /* Connected outcomes use step replies, so no completion request drains a running entry. */
      if (isConnectedRunStart(request.config)) {
        awaitScenarioComplete.catch(() => {})
      } else {
        this.running.set(request.scenarioId, awaitScenarioComplete)
      }
      return {
        type: "ScenarioStartResponse",
        scenarioId: request.scenarioId,
        status: "running",
      }
    } catch (error) {
      LOG.error(
        `Failed to start scenario "${request.scenarioId}": ${error}`,
        false,
      )
      if (isConnectedRunStart(request.config)) {
        /* Retain an attributed refusal for any pending step; the start-error reply also fails the driver. */
        reportRefusedStart(this.transport, request.config, error)
      }
      return {
        type: "ScenarioStartResponse",
        scenarioId: request.scenarioId,
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async handleScenarioCompletedRequest(
    request: ScenarioCompletedRequest,
  ): Promise<ScenarioCompletedResponse> {
    LOG.debug(`ScenarioCompletedRequest: "${request.scenarioId}"`, false)

    const awaitScenarioComplete = this.running.get(request.scenarioId)
    if (!awaitScenarioComplete) {
      LOG.error(
        `ScenarioCompletedRequest received for "${request.scenarioId}" but ScenarioStartRequest is not sent or failed`,
      )
      return {
        type: "ScenarioCompletedResponse",
        scenarioId: request.scenarioId,
        status: "failed",
      }
    }

    try {
      await awaitScenarioComplete
      LOG.debug(
        `Scenario "${request.scenarioId}" completed successfully`,
        false,
      )
      return {
        type: "ScenarioCompletedResponse",
        scenarioId: request.scenarioId,
        status: "succeeded",
      }
    } catch (error) {
      LOG.debug(
        `Scenario "${request.scenarioId}" completed with failure: ${error}`,
        false,
      )
      return {
        type: "ScenarioCompletedResponse",
        scenarioId: request.scenarioId,
        status: "failed",
      }
    } finally {
      this.running.delete(request.scenarioId)
    }
  }
}

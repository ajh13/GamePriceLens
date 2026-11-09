import {ScenarioManager, AwaitScenarioComplete} from "./manager/ScenarioManager"
import {ScenarioConfig} from "./ScenarioConfig"
import {MessageBroker} from "Leaf.lspkg/Utils/common/MessagingSystem/MessageBroker"
import {MessagePublisher} from "Leaf.lspkg/Utils/common/MessagingSystem/MessagePublisher"
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
  ConnectedRunOutbound,
  ENSEMBLE_LIST_REQUEST,
  ENSEMBLE_LIST_RESPONSE,
  EnsembleListRequestMessage,
  EnsembleListResponseMessage,
  RENDEZVOUS_RELEASE,
  CONNECTED_RUN_ABORTED,
  RendezvousReleaseMessage,
  RunAbortedMessage,
  isConnectedRunStart,
} from "../connected/ConnectedMessages"
import {
  PreviewParticipantTransport,
  reportRefusedStart,
} from "../connected/ParticipantTransport"
import {Logger} from "Leaf.lspkg/Utils/common/Logger"

const LOG = new Logger("MessageScenarioHandler")

/** Plugin requests, ConnectedRun control messages, and discovery probes sent to the lens. */
export type LensInbound =
  | Request
  | RendezvousReleaseMessage
  | RunAbortedMessage
  | EnsembleListRequestMessage
/** Lens responses, ConnectedRun progress, and Ensemble declarations sent to the plugin. */
export type LensOutbound =
  Response | ConnectedRunOutbound | EnsembleListResponseMessage

/**
 * Bridge between Lens Studio Plugin and ScenarioManager in the scene.
 * Handles Plugin <-> Lens communication via messaging system.
 *
 * Instantiated dynamically by {@link MessagingBridge} only when running inside
 * Lens Studio, since it talks to the plugin through `Editor.context`, which does
 * not exist on-device. One publisher dispatches every message type on the lens's
 * one plugin channel: the `LeafMessages` request/response pairs and the
 * ConnectedRun messages - the same shape as DeviceMessageReceiver on
 * the device leg.
 */
export class MessageScenarioHandler {
  private messagePublisher: MessagePublisher<LensInbound, LensOutbound>
  // TODO (SAP-1494): add unique id for Request/Response pairs and check if promise belongs to current run
  private awaitScenarioComplete?: AwaitScenarioComplete

  /**
   * @param broker - The lens's plugin channel (owned by the MessagingBridge).
   * @param transport - The editor ConnectedRun transport; Rendezvous releases
   *   arriving on the channel are delivered into it (shared with the
   *   process-wide ParticipantAgent, like DeviceMessageReceiver's).
   * @param scenarioManager - The manager that registers and runs Scenarios.
   */
  constructor(
    broker: MessageBroker<LensInbound, LensOutbound>,
    private transport: PreviewParticipantTransport,
    private readonly scenarioManager: ScenarioManager,
  ) {
    this.messagePublisher = new MessagePublisher<LensInbound, LensOutbound>(
      broker,
    )

    this.messagePublisher.subscribe("ScenarioListRequest", () => {
      this.handleScenarioListRequest()
    })
    this.messagePublisher.subscribe("ScenarioStartRequest", (request) => {
      this.handleScenarioStartRequest(request)
    })
    this.messagePublisher.subscribe("ScenarioCompletedRequest", (request) => {
      this.handleScenarioCompletedRequest(request)
    })
    this.messagePublisher.subscribe(RENDEZVOUS_RELEASE, (release) => {
      this.transport.deliver(release)
    })
    this.messagePublisher.subscribe(CONNECTED_RUN_ABORTED, (aborted) => {
      this.transport.deliver(aborted)
    })
    this.messagePublisher.subscribe(ENSEMBLE_LIST_REQUEST, (request) => {
      this.handleEnsembleListRequest(request)
    })
  }

  /**
   * Answer the plugin's Ensemble-discovery request so it can display Ensembles
   * and their Roles and choose a Binding. A lens-level query, not part of any
   * run - editor leg only (the plugin discovers over `postMessage`).
   */
  private handleEnsembleListRequest(request: EnsembleListRequestMessage) {
    const response: EnsembleListResponseMessage = {
      type: ENSEMBLE_LIST_RESPONSE,
      ensembles: this.scenarioManager.listEnsembles(),
      // Echo the probe token so the plugin can tell which preview replied.
      probeId: request.probeId,
    }
    this.messagePublisher.notify(response)
  }

  private handleScenarioListRequest() {
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
    this.notifyResponse({
      type: "ScenarioListResponse",
      scenarios: scenarios,
    })
  }

  private async handleScenarioStartRequest(request: ScenarioStartRequest) {
    LOG.debug(
      `ScenarioStartRequest: "${request.scenarioId}" config=${JSON.stringify(request.config)}`,
      false,
    )

    /* Ordinary runs retain a completion promise; ConnectedRuns report through their transport. */
    if (this.awaitScenarioComplete && !isConnectedRunStart(request.config)) {
      LOG.error(
        `Previous ScenarioStartRequest is still running, send new ScenarioStartRequest only after ScenarioCompletedResponse is received`,
      )
      this.notifyResponse({
        type: "ScenarioStartResponse",
        scenarioId: request.scenarioId,
        status: "error",
        reason:
          "Previous ScenarioStartRequest is still running; wait for ScenarioCompletedResponse before starting another Scenario.",
      })
      return
    }

    let awaitScenarioComplete: AwaitScenarioComplete
    try {
      const scenarioConfig = ScenarioConfig.fromRecord(request.config)
      awaitScenarioComplete = this.scenarioManager.startScenario(
        request.scenarioId,
        scenarioConfig,
      )
      this.notifyResponse({
        type: "ScenarioStartResponse",
        scenarioId: request.scenarioId,
        status: "running",
      })
    } catch (error) {
      LOG.error(
        `Failed to start scenario "${request.scenarioId}": ${error}`,
        false,
      )
      if (isConnectedRunStart(request.config)) {
        /* Attribute the refusal immediately instead of waiting for the run-start watchdog. */
        reportRefusedStart(this.transport, request.config, error)
      }
      this.notifyResponse({
        type: "ScenarioStartResponse",
        scenarioId: request.scenarioId,
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
      })
      return
    }

    /* Connected outcomes use Participant results, so no completion request drains this slot. */
    if (isConnectedRunStart(request.config)) {
      awaitScenarioComplete.catch(() => {})
      return
    }

    this.awaitScenarioComplete = awaitScenarioComplete
  }

  private async handleScenarioCompletedRequest(
    request: ScenarioCompletedRequest,
  ) {
    LOG.debug(`ScenarioCompletedRequest: "${request.scenarioId}"`, false)

    if (this.awaitScenarioComplete) {
      try {
        await this.awaitScenarioComplete
        LOG.debug(
          `Scenario "${request.scenarioId}" completed successfully`,
          false,
        )
        this.notifyResponse({
          type: "ScenarioCompletedResponse",
          scenarioId: request.scenarioId,
          status: "succeeded",
        })
      } catch (error) {
        LOG.debug(
          `Scenario "${request.scenarioId}" completed with failure: ${error}`,
          false,
        )
        this.notifyResponse({
          type: "ScenarioCompletedResponse",
          scenarioId: request.scenarioId,
          status: "failed",
        })
      } finally {
        this.awaitScenarioComplete = undefined
      }
    } else {
      LOG.error(
        `ScenarioCompletedRequest received for "${request.scenarioId}" but ScenarioStartRequest is not sent or failed`,
      )
      this.notifyResponse({
        type: "ScenarioCompletedResponse",
        scenarioId: request.scenarioId,
        status: "failed",
      })
    }
  }

  private notifyResponse(
    response:
      ScenarioListResponse | ScenarioStartResponse | ScenarioCompletedResponse,
  ) {
    this.messagePublisher.notify(response)
  }
}

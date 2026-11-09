import {
  LensInbound,
  LensOutbound,
  MessageScenarioHandler,
} from "./MessageScenarioHandler"
import {DeviceMessageReceiver} from "./DeviceMessageReceiver"
import {ParticipantAgent} from "../connected/ParticipantAgent"
import {
  PreviewParticipantTransport,
  DeviceParticipantTransport,
} from "../connected/ParticipantTransport"
import {DefaultScenarioManager} from "./manager/DefaultLeafScenarioManager"
import {LensMessageBroker} from "Leaf.lspkg/Utils/common/MessagingSystem/LensMessageBroker"
import {Logger} from "Leaf.lspkg/Utils/common/Logger"

const LOG = new Logger("MessagingBridge")

/**
 * Bootstrap component the LEAF plugin attaches to the scene.
 *
 * The plugin <-> lens bridge talks to the plugin over a MessageEvent bound to
 * this component, so it is torn down with this component's object (e.g. when
 * the plugin closes). It runs {@link MessageScenarioHandler} in Lens Studio and
 * {@link DeviceMessageReceiver} on-device.
 */
@component
export class MessagingBridge extends BaseScriptComponent {
  private handler?: MessageScenarioHandler
  private receiver?: DeviceMessageReceiver

  onAwake() {
    if (global.deviceInfoSystem.isEditor()) {
      /* Preview: ordinary and ConnectedRun messages share the lens plugin channel. */
      const broker = new LensMessageBroker<LensInbound, LensOutbound>(
        this.createEvent("MessageEvent"),
      )
      const transport = new PreviewParticipantTransport(broker)
      ParticipantAgent.installInstance(new ParticipantAgent(transport))
      this.handler = new MessageScenarioHandler(
        broker,
        transport,
        DefaultScenarioManager.getInstance(),
      )
      LOG.debug("LEAF messaging bridge started (editor).", false)
    } else {
      /* Device: reply to ordinary requests and drive ConnectedRuns through step requests. */
      const transport = new DeviceParticipantTransport()
      ParticipantAgent.installInstance(new ParticipantAgent(transport))
      this.receiver = new DeviceMessageReceiver(
        this,
        transport,
        DefaultScenarioManager.getInstance(),
      )
      LOG.debug("LEAF messaging bridge started (device).", false)
    }
  }
}

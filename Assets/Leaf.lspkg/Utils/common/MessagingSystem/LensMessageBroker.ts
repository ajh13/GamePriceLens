import {BaseMessage} from "./MessageTypes/BaseMessage"
import {MessageBroker} from "./MessageBroker"
import {MessageObject} from "./MessagePublisher"
import Event from "../Event"

/**
 * LensMessageBroker binds the scene's MessageEvent to the {@link MessagePublisher}
 * so subscribers in the Lens get notified when the plugin posts a message.
 */
export class LensMessageBroker<
  In extends BaseMessage = BaseMessage,
  Out extends BaseMessage = BaseMessage,
> implements MessageBroker<In, Out> {
  private onMessageReceiveEvent: Event<In> = new Event<In>()
  onMessageReceived = this.onMessageReceiveEvent.publicApi()

  /**
   * @param messageEvent - The scene event that receives plugin messages.
   */
  constructor(messageEvent: SceneEvent) {
    messageEvent.bind((event: SceneEvent & MessageObject<In>) => {
      this.onMessageReceiveEvent.invoke(event.data)
    })
  }

  /**
   * Posts a message to the editor context.
   * Use this for communication with the plugin system.
   * @param message - Message to be posted.
   */
  notify(message: Out): void {
    //@ts-ignore
    Editor.context.postMessage(message)
  }
}

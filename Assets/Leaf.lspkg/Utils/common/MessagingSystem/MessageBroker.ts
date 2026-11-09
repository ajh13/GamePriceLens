import {PublicApi} from "../Event"
import {BaseMessage} from "./MessageTypes/BaseMessage"

/**
 * MessageBroker interface defines the methods for subscribing to and posting messages.
 *
 * @template In - The type of incoming messages.
 * @template Out - The type of outgoing messages.
 */
export interface MessageBroker<
  In extends BaseMessage,
  Out extends BaseMessage,
> {
  onMessageReceived: PublicApi<In>

  /**
   * Notifies all subscribers of a specific message type.
   * @param message - The message to notify subscribers about.
   */
  notify: (message: Out) => void
}

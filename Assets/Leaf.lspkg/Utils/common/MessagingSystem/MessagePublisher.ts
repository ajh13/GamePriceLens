import {BaseMessage} from "./MessageTypes/BaseMessage"
import {MessageBroker} from "./MessageBroker"
import {unsubscribe} from "../Event"

export type MessageObject<T extends BaseMessage> = {
  data: T
}
export type MessageListenerCb<T extends BaseMessage> = (message: T) => void

/**
 * MessagePublisher manages message subscriptions and notifications.
 * It allows different parts of the Lens and Plugin to communicate by subscribing to specific message types
 * and receiving notifications when those messages are posted.
 * @template In - The type of incoming messages from the MessageBroker.
 * @template Out - The type of outgoing messages to the MessageBroker.
 */
export class MessagePublisher<In extends BaseMessage, Out extends BaseMessage> {
  protected registeredCallbacks: Partial<
    Record<BaseMessage["type"], ((message: In) => void)[]>
  > = {}

  constructor(private messageBroker: MessageBroker<In, Out>) {
    messageBroker.onMessageReceived.add((message: In) => {
      this.process(message)
    })
  }

  /**
   * Subscribes to a specific message type and registers a callback to be invoked
   * when a message of that type is posted. The callback receives the member of
   * `In` whose `type` is `messageType`.
   * @param messageType - The message type string (e.g., "ScenarioStartRequest")
   * @param listenerCb - The callback function to be invoked when a message of the specified type is posted.
   */
  subscribe<K extends In["type"]>(
    messageType: K,
    listenerCb: MessageListenerCb<Extract<In, {type: K}>>,
  ): unsubscribe {
    // Storage is keyed by the runtime `type` string, so the narrowing is sound.
    const cb = listenerCb as unknown as (message: In) => void
    if (!this.registeredCallbacks[messageType]) {
      this.registeredCallbacks[messageType] = []
    }
    this.registeredCallbacks[messageType].push(cb)

    return () => {
      this.registeredCallbacks[messageType] = this.registeredCallbacks[
        messageType
      ]?.filter((registered) => registered !== cb)
    }
  }

  /**
   * Processes a message object by checking its type and notifying the appropriate subscribers.
   * Fed by the {@link MessageBroker}'s onMessageReceived.
   * @param messageObject - An object representing a message, which must have a "type" property.
   * @returns
   */
  private process(message: In): void {
    this.registeredCallbacks[message.type]?.forEach((cb) => {
      cb?.(message)
    })
  }

  notify(message: Out): void {
    this.messageBroker.notify(message)
  }
}

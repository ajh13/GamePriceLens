import Event from "./Event"
import {combineErrors} from "./Errors"

/**
 * This class provides a dispatcher for UpdateEvents produced by LensCore.
 */
export class UpdateDispatcher {
  private static instance: UpdateDispatcher

  private sceneObject: SceneObject
  private script: ScriptComponent

  private onUpdateEvent: Event<UpdateEvent> = new Event<UpdateEvent>()
  public onUpdate = this.onUpdateEvent.publicApi()

  private onLateUpdateEvent: Event<LateUpdateEvent> = new Event<LateUpdateEvent>()
  /**
   * Fires once per frame at the end of the frame, after `Update`, Physics,
   * and Animation events but before rendering. Use this when a callback
   * needs to override values written by an `AnimationPlayer` or physics
   * tick earlier in the same frame.
   */
  public onLateUpdate = this.onLateUpdateEvent.publicApi()

  public static getInstance(): UpdateDispatcher {
    if (!this.instance) {
      this.instance = new UpdateDispatcher()
    }
    return this.instance
  }

  /**
   * Creates an event that fires on the next frame.
   * Uses UpdateEvent with time check to guarantee next-frame execution.
   * @param resolveCb - function to execute on the next frame
   * @returns a function that removes the pending event.
   */
  public createNextFrameEvent(resolveCb: () => void): () => void {
    const creationTime = getTime()
    const updateEvent = this.script.createEvent("UpdateEvent")
    let active = true
    const cancel = () => {
      if (!active) return
      active = false
      this.script.removeEvent(updateEvent)
    }
    updateEvent.bind(() => {
      // Only fire once time has advanced past creation time (i.e., next frame)
      if (active && getTime() > creationTime) {
        this.fireOnce(cancel, resolveCb)
      }
    })
    return cancel
  }

  /**
   * Creates a DelayedCallbackEvent that will execute the provided callback after the specified delay.
   * @param resolveCb - function to execute after the timeout
   * @param delaySeconds - finite positive time to wait in seconds
   * @throws Error if delaySeconds is nonfinite, zero, or negative
   * @returns a function that removes the pending event.
   */
  public createDelayedEvent(resolveCb: () => void, delaySeconds: number): () => void {
    if (!Number.isFinite(delaySeconds) || delaySeconds <= 0) {
      throw new Error(
        `createDelayedEvent requires a positive delay. Got ${delaySeconds}. Use createNextFrameEvent() for next-frame execution.`
      )
    }
    const delayedEvent = this.script.createEvent("DelayedCallbackEvent")
    let active = true
    const cancel = () => {
      if (!active) return
      active = false
      this.script.removeEvent(delayedEvent)
    }
    delayedEvent.bind(() => {
      if (active) this.fireOnce(cancel, resolveCb)
    })
    delayedEvent.reset(delaySeconds)
    return cancel
  }

  private fireOnce(cancel: () => void, callback: () => void): void {
    const errors: unknown[] = []
    try { cancel() } catch (error) { errors.push(error) }
    try { callback() } catch (error) { errors.push(error) }
    if (errors.length) throw combineErrors(errors)
  }

  private constructor() {
    this.sceneObject = global.scene.createSceneObject("update-EventDispatcher")
    this.script = this.sceneObject.createComponent("ScriptComponent")

    this.script.createEvent("UpdateEvent").bind((eventArgs: UpdateEvent) => {
      this.onUpdateEvent.invoke(eventArgs)
    })
    this.script
      .createEvent("LateUpdateEvent")
      .bind((eventArgs: LateUpdateEvent) => {
        this.onLateUpdateEvent.invoke(eventArgs)
      })
  }
}

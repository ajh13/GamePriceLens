import {UpdateDispatcher} from "./UpdateDispatcher"
import {MS_TO_SECS} from "./Constants"
import {CancelCb, CancellablePromise} from "./CancellablePromise"
import {LeafLifecycle} from "./LeafLifecycle"

/** Animation callbacks and duration in seconds. */
export type AnimateConfig = {
  update: (t: number) => void
  duration: number
  ended?: () => void
  cancelled?: (reason?: Error) => void
}

/** Rejection reason for an animation cancelled before completion. */
export class AnimationCancelledError extends Error {
  constructor() {
    super("Animation cancelled")
    this.name = "AnimationCancelledError"
  }
}

/** Handles expected cancellation of initialization animations; rethrows other errors. */
export function ignoreAnimationCancellationError(error: unknown): void {
  if (!(error instanceof AnimationCancelledError)) {
    throw error
  }
}

/**
 * Asynchronously performs the animation. It subscribes to LensCore UpdateEvent through
 * the UpdateDispatcher, and updates the animation on each frame.
 * @param AnimateConfig - config for the animation
 * @returns CancelCb - A function to cancel the animation
 */
export function animate(config: AnimateConfig): CancelCb {
  const scope = LeafLifecycle.getInstance().currentScope
  let elapsedTime: number | undefined = undefined
  let unsubscribe: (() => void) | undefined
  let unsubscribeCancel: (() => void) | undefined
  let stopped = false

  const updateFrame = () => {
    /* Event dispatch may already have captured this callback when cancelled. */
    if (stopped) {
      return true
    }
    const deltaTime = getDeltaTime()

    // Skip all updates when deltaTime is 0, ensuring that the animation
    // does not progress incorrectly when in capture mode.
    if (deltaTime === 0) {
      return false
    }

    elapsedTime = elapsedTime === undefined ? 0 : elapsedTime + deltaTime
    const t = Math.min(1.0, elapsedTime / config.duration)
    config.update(t)
    const ended = elapsedTime >= config.duration

    if (ended) {
      stopped = true
      // unsubscribe from UpdateDispatcher if already subscribed
      unsubscribe?.()
      unsubscribe = undefined
      unsubscribeCancel?.()
      config.ended?.()
    }

    return ended
  }

  /**
   * Cancellation function to stop this animation at any time
   */
  const cancel = (reason?: Error) => {
    if (stopped) {
      return
    }
    stopped = true
    unsubscribe?.()
    unsubscribe = undefined
    unsubscribeCancel?.()
    config.cancelled?.(reason ?? new AnimationCancelledError())
  }

  // Perform the first frame update synchronously to start the animation without delay.
  const ended = updateFrame()
  if (ended) {
    return cancel
  }

  // Subscribe to the dispatcher to listen to subsequent UpdateEvents and update frames.
  unsubscribe = UpdateDispatcher.getInstance().onUpdate(() => updateFrame())
  unsubscribeCancel = scope?.onCancel(cancel)
  return cancel
}

/**
 * Creates a Promise containing an {@link animate}, resolving when the animation has ended.
 * @param durationMs Duration of the animation in milliseconds
 * @param updateCb Update function called each frame with the current time t
 * @returns
 */
export function animatePromise(
  durationMs: number,
  updateCb: (t: number) => void,
): CancellablePromise<void> {
  let cancelFn: CancelCb
  const promise = new CancellablePromise<void>(
    (resolve, reject) => {
      cancelFn = animate({
        duration: durationMs * MS_TO_SECS,
        update: (t: number) => {
          updateCb(t)
        },
        ended: () => {
          resolve()
        },
        cancelled: (reason) => {
          reject(reason)
        },
      })
    },
    () => cancelFn?.(),
  )
  promise.catch(() => {})
  return promise
}

/**
 * Smoothly animates the position to the target position.
 * @param transform The transform to animate
 * @param targetPosition End position of the animation
 * @param durationMs Duration of the animation in milliseconds
 * @param local Whether to use local or world position
 * @returns
 */
export function translate(
  transform: Transform,
  targetPosition: vec3,
  durationMs: number,
  local: boolean = false,
): CancellablePromise<void> {
  const startPosition = local
    ? transform.getLocalPosition()
    : transform.getWorldPosition()

  return animatePromise(durationMs, (t: number) => {
    const position = vec3.lerp(startPosition, targetPosition, t)
    if (local) {
      transform.setLocalPosition(position)
    } else {
      transform.setWorldPosition(position)
    }
  })
}

/**
 * Smoothly animates the rotation to the target rotation.
 * @param transform - The transform to animate.
 * @param targetRotation - The target world rotation as a quat.
 * @param durationMs - The duration of the animation in milliseconds.
 * @param local - Whether to use local or world rotation.
 */
export function rotate(
  transform: Transform,
  targetRotation: quat,
  durationMs: number,
  local: boolean = false,
): CancellablePromise<void> {
  const startRotation = local
    ? transform.getLocalRotation()
    : transform.getWorldRotation()

  return animatePromise(durationMs, (t: number) => {
    const rotation = quat.slerp(startRotation, targetRotation, t)
    if (local) {
      transform.setLocalRotation(rotation)
    } else {
      transform.setWorldRotation(rotation)
    }
  })
}

import {HandType} from "InteractionKit.lspkg/Providers/HandInputData/HandType"
import {nextFrame} from "./Utils"

/** Two-hand rendezvous: both hands call `wait(handType)` and resolve together; the left hand additionally awaits one extra frame so each `setPinching(true)` lands in a distinct IK frame (IK's per-frame triggering-interactor cache otherwise misses the second hand). */
export type TwoHandPinchBarrier = {
  /** Block until both hands have called `wait`; the left hand additionally awaits one extra frame. */
  wait(hand: HandType): Promise<void>
  /** Release both waits with `error`. Idempotent. */
  abort(error: unknown): void
}

/** @returns a fresh single-use {@link TwoHandPinchBarrier}. */
export function createTwoHandPinchBarrier(): TwoHandPinchBarrier {
  let arrived = 0
  let pendingError: unknown | undefined
  let open!: () => void
  let fail!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => {
    open = resolve
    fail = reject
  })
  return {
    wait: async (hand: HandType): Promise<void> => {
      if (pendingError !== undefined) throw pendingError
      if (++arrived >= 2) open()
      await ready
      if (hand === "left") await nextFrame()
    },
    /** If a hand is already awaiting `ready`, reject it so the waiter resumes with `error`. Otherwise stash it so the next `wait` caller surfaces it (rejecting an unawaited promise would log as unhandled). */
    abort: (error: unknown) => {
      if (arrived === 0) {
        pendingError = error
      } else {
        fail(error)
      }
    },
  }
}

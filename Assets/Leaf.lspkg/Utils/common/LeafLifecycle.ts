import Event from "./Event"
import {UpdateDispatcher} from "./UpdateDispatcher"
import {combineErrors} from "./Errors"

/** Owns LEAF waits, timers, and animations created during one Scenario body. */
class ScenarioScope {
  private reason?: Error
  private readonly callbacks = new Set<(reason: Error) => void>()
  /** Whether owned operations have been cancelled; arbitrary external work is unaffected. */
  get cancelled(): boolean {
    return this.reason !== undefined
  }

  /** Throw if this Scenario has ended or was cancelled. */
  throwIfCancelled(): void {
    if (this.reason) throw this.reason
  }

  /** Subscribe to cancellation; an already cancelled scope calls back immediately. */
  onCancel(callback: (reason: Error) => void): () => void {
    if (this.reason) callback(this.reason)
    else this.callbacks.add(callback)
    return () => {
      this.callbacks.delete(callback)
    }
  }

  /** Cancel all pending operations once, preserving errors from cancellation callbacks. */
  cancel(reason: Error): void {
    if (this.reason) return
    this.reason = reason
    const errors: unknown[] = []
    for (const callback of Array.from(this.callbacks)) {
      try {
        callback(reason)
      } catch (error) {
        errors.push(error)
      }
    }
    this.callbacks.clear()
    if (errors.length) throw combineErrors(errors)
  }

  /** Reject an owned wait on cancellation and release its native resources. */
  track<T>(promise: Promise<T>, cancel: () => void = () => {}): Promise<T> {
    let unsubscribe: (() => void) | undefined
    const tracked = new Promise<T>((resolve, reject) => {
      unsubscribe = this.onCancel((reason) => {
        try {
          cancel()
        } finally {
          reject(reason)
        }
      })
      promise.then(resolve, reject)
    }).finally(() => unsubscribe?.())
    /* Event waits are often created a few awaits before the caller consumes them. */
    tracked.catch(() => {})
    return tracked
  }
}

/** Runner controls scoped to one Scenario body and its cleanup. */
export interface ScenarioRun {
  readonly scope: ScenarioScope
  bodyStarted(): void
  bodySettled(): void
  cleanupFinished(): void
}

/**
 * Owns Scenario operations and emits cleanup for resources such as interactors.
 */
export class LeafLifecycle {
  private static instance: LeafLifecycle

  private cleanupEvent = new Event()
  private scope: ScenarioScope | undefined
  private readonly unsettled = new Map<ScenarioScope, Promise<void>>()
  /** Release interactors and other per-Scenario resources after each run. */
  readonly onCleanup = this.cleanupEvent.publicApi()

  private constructor() {}

  /** Operation ownership ends before completion and cleanup callbacks. */
  get currentScope(): ScenarioScope | undefined {
    return this.scope?.cancelled ? undefined : this.scope
  }

  /** Refuse reuse while the previous Scenario body can still execute. */
  assertReusable(): void {
    if (this.unsettled.size)
      throw new Error(
        "Previous Scenario is still executing or cleaning up; wait for it to settle or reset this lens before reusing it.",
      )
  }

  /** Give cancelled promise chains one frame to unwind before refusing reuse. */
  async waitForReusable(): Promise<void> {
    if (!this.unsettled.size) return
    let cancel = () => {}
    const frame = new Promise<void>((resolve) => {
      cancel = UpdateDispatcher.getInstance().createNextFrameEvent(resolve)
    })
    try {
      await Promise.race([Promise.all(this.unsettled.values()), frame])
    } finally {
      cancel()
    }
    this.assertReusable()
  }

  /** Begin a Scenario and return controls that cannot settle any other run. */
  beginScenario(): ScenarioRun {
    if (this.scope)
      throw new Error("Previous Scenario is still running or cleaning up.")
    const scope = (this.scope = new ScenarioScope())
    let bodyPending = false
    let cleanupDone = false
    let settle = () => {}
    const finished = new Promise<void>((resolve) => {
      settle = () => {
        if (bodyPending || !cleanupDone) return
        this.unsettled.delete(scope)
        resolve()
      }
    })
    this.unsettled.set(scope, finished)
    return {
      scope,
      bodyStarted: () => {
        bodyPending = true
      },
      bodySettled: () => {
        bodyPending = false
        settle()
      },
      cleanupFinished: () => {
        cleanupDone = true
        /* Ordinary suites can continue after cleanup; ConnectedRuns wait for the body too. */
        if (this.scope === scope) this.scope = undefined
        settle()
      },
    }
  }

  static getInstance(): LeafLifecycle {
    if (!this.instance) {
      this.instance = new LeafLifecycle()
    }
    return this.instance
  }

  invokeCleanup(): void {
    this.cleanupEvent.invoke()
  }
}

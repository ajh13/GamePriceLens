import {UpdateDispatcher} from "./UpdateDispatcher"
import {LeafLifecycle} from "./LeafLifecycle"

/**
 * Creates a promise that resolves the next time `event` fires, paired with a cancel function
 * that removes the listener without resolving. Use `cancel()` in a `finally` block when racing
 * multiple event promises so the losing listener is always cleaned up.
 */
export function makeEventPromise<T>(
  event: {add: (callback: (event: T) => void) => () => void},
): [Promise<void>, () => void] {
  const scope = LeafLifecycle.getInstance().currentScope
  let unsub: (() => void) | undefined
  let unsubscribeCancel: (() => void) | undefined
  const cancel = () => {
    unsub?.()
    unsub = undefined
    unsubscribeCancel?.()
  }
  const promise = new Promise<void>((resolve, reject) => {
    unsub = event.add(() => { cancel(); resolve() })
    unsubscribeCancel = scope?.onCancel((reason) => { cancel(); reject(reason) })
  })
  promise.catch(() => {})
  return [promise, cancel]
}

/**
 * Suspend the code execution for a specified number of milliseconds.
 *
 * @param ms - time to wait in milliseconds.
 * @returns a promise that rejects when its owning Scenario is cancelled.
 */
export function sleep(ms: number): Promise<void> {
  const scope = LeafLifecycle.getInstance().currentScope
  let cancel = () => {}
  const promise = new Promise<void>((resolve) => {
    cancel = UpdateDispatcher.getInstance().createDelayedEvent(resolve, ms / 1000)
  })
  return scope ? scope.track(promise, cancel) : promise
}

/**
 * Race a promise against a timeout. Rejects if the timeout expires first.
 *
 * @param promise - the promise to race.
 * @param timeoutMs - timeout in milliseconds.
 * @param message - optional error message on timeout.
 * @returns a promise that resolves with the result, or rejects on timeout or
 *   Scenario cancellation.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message = `Timed out after ${timeoutMs / 1000}s`,
): Promise<T> {
  const scope = LeafLifecycle.getInstance().currentScope
  let cancel = () => {}
  const timeoutPromise = new Promise<never>((_, reject) => {
    cancel = UpdateDispatcher.getInstance().createDelayedEvent(() => reject(new Error(message)), timeoutMs / 1000)
  })
  const race = Promise.race([promise, timeoutPromise])
  const result = (scope ? scope.track(race, cancel) : race).finally(cancel)
  result.catch(() => {})
  return result
}

/** Default timeout for a single awaited event, in milliseconds. */
export const DEFAULT_EVENT_TIMEOUT_MS = 10 * 1000

/** Options for awaiting a single event with a timeout. */
export type AwaitEventOnceOptions = {
  /**
   * Milliseconds before rejecting; `Infinity` or non-positive waits forever.
   * Defaults to {@link DEFAULT_EVENT_TIMEOUT_MS}.
   */
  timeoutMs?: number
  /** Event named in the timeout error, e.g. `onTriggerStart on "Btn"`. */
  description?: string
}

/**
 * Rejects `eventFired` once `options.timeoutMs` has elapsed. `cancel` runs
 * whichever way the race settles, so a timed-out wait leaves no listener behind
 * on an event that normally outlives the scenario.
 *
 * @param eventFired - promise that resolves when the event fires.
 * @param cancel - detaches the event listener without resolving.
 * @param options - timeout and error-message overrides.
 * @returns a Promise that resolves when the event fires, or rejects on timeout.
 */
export function withEventTimeout(
  eventFired: Promise<void>,
  cancel: () => void,
  options?: AwaitEventOnceOptions,
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_EVENT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return eventFired
  }
  const guarded = withTimeout(
    eventFired,
    timeoutMs,
    `Timed out after ${timeoutMs}ms waiting for ${options?.description ?? "event"}`,
  ).finally(cancel)
  /* A caller racing several of these keeps only the winner, so the losers are
   * left rejecting with nobody awaiting them. Attach a no-op catch to stop that
   * becoming an unhandled rejection. Callers still see the rejection. */
  guarded.catch(() => {})
  return guarded
}

/**
 * Returns a promise that resolves the next time `event` fires, or rejects
 * after `options.timeoutMs` (default {@link DEFAULT_EVENT_TIMEOUT_MS}).
 *
 * @param event - event to subscribe to; `add` returns its unsubscribe.
 * @param options - timeout and error-message overrides.
 * @returns a Promise that resolves on the next event, or rejects on timeout.
 */
export function awaitEventOnce<T>(
  event: {add: (callback: (event: T) => void) => () => void},
  options?: AwaitEventOnceOptions,
): Promise<void> {
  const [eventFired, cancel] = makeEventPromise<T>(event)
  return withEventTimeout(eventFired, cancel, options)
}

/**
 * Wait for the next frame to execute.
 * @returns a promise that resolves next frame or rejects on Scenario cancellation.
 */
export function nextFrame(): Promise<void> {
  const scope = LeafLifecycle.getInstance().currentScope
  let cancel = () => {}
  const promise = new Promise<void>((resolve) => {
    cancel = UpdateDispatcher.getInstance().createNextFrameEvent(resolve)
  })
  return scope ? scope.track(promise, cancel) : promise
}

/**
 * Poll a predicate once per frame until it is satisfied, or reject when the
 * timeout elapses. Useful for waiting on state that becomes true asynchronously
 * (e.g. a UIKit button's Interactable being created, a networked value
 * arriving) without a fixed sleep.
 * @param predicate - Checked immediately and then every frame; the wait ends the
 *   first time it returns true.
 * @param timeoutMs - How long to wait before rejecting.
 * @param detail - Optional detail appended to the timeout error, for context.
 * @returns a promise that resolves once the predicate holds, or rejects on
 *   timeout, a predicate error, or Scenario cancellation.
 */
export function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  detail?: () => string,
): Promise<void> {
  const scope = LeafLifecycle.getInstance().currentScope
  const promise = (async () => {
    let timedOut = false
    const cancel = UpdateDispatcher.getInstance().createDelayedEvent(() => { timedOut = true }, timeoutMs / 1000)
    try {
      while (true) {
        scope?.throwIfCancelled()
        if (predicate()) return
        if (timedOut) {
          throw new Error(
            `waitUntil timed out after ${timeoutMs}ms${
              detail ? `: ${detail()}` : ""
            }`,
          )
        }
        await nextFrame()
      }
    } finally {
      cancel()
    }
  })()
  promise.catch(() => {})
  return promise
}

/**
 * setTimeout will create a DelayedCallbackEvent using UpdateDispatcher
 * @param resolveCb - function to execute after the timeout
 * @param time - time to wait in milliseconds
 * @returns a cancellation function; Scenario cleanup also cancels this callback.
 */
export function setTimeout(resolveCb: () => void, time: number): () => void {
  const scope = LeafLifecycle.getInstance().currentScope
  let unsubscribe: (() => void) | undefined
  const cancel = UpdateDispatcher.getInstance().createDelayedEvent(() => {
    unsubscribe?.()
    resolveCb()
  }, time / 1000)
  unsubscribe = scope?.onCancel(cancel)
  return () => { unsubscribe?.(); cancel() }
}

/**
 * Generic matcher function.
 *
 * @param target - {@link SceneObject} to match.
 * @returns the corresponding component or the SceneObject itself if matches,
 * undefined otherwise.
 */
export type MatcherFn<T> = (target: SceneObject) => T | undefined

/**
 * Match {@link SceneObject} name.
 *
 * @param name - name of {@link SceneObject} to match.
 * @returns the SceneObject if the name matches, undefined otherwise.
 */
export const matchSceneObjectName = (name: string): MatcherFn<SceneObject> => {
  return (sceneObject: SceneObject) => {
    return sceneObject.name === name ? sceneObject : undefined
  }
}

/**
 * Matches {@link SceneObject} parent's name.
 *
 * @param name - name of {@link SceneObject}'s parent to match.
 * @returns the SceneObject if the parent's name matches, undefined otherwise.
 */
export const matchSceneObjectParentName = (
  name: string,
): MatcherFn<SceneObject> => {
  return (sceneObject: SceneObject) => {
    return sceneObject.getParent()?.name === name ? sceneObject : undefined
  }
}

/**
 * Search for a SceneObject or component from a root SceneObject.
 *
 * @param matcher – A predicate function used to select SceneObjects.
 * This matcher function should take a SceneObject as an argument and return a SceneObject or a
 * component of it if it matches, otherwise return undefined
 * @param root - The root SceneObject of the tree to search.
 * @returns An array of SceneObjects or Components that match the predicate if they exist in the tree, or an empty array otherwise.
 */
export function findInScene<T>(matcher: MatcherFn<T>, root?: SceneObject): T[] {
  let results: T[] = []

  if (root === undefined || isNull(root)) {
    for (let i = 0; i < global.scene.getRootObjectsCount(); i++) {
      results = results.concat(
        findInScene(matcher, global.scene.getRootObject(i)),
      )
    }
  } else {
    const matched = matcher(root)
    if (matched !== undefined && !isNull(matched)) {
      results.push(matched)
    }

    for (let i = 0; i < root.getChildrenCount(); i++) {
      results = results.concat(findInScene(matcher, root.getChild(i)))
    }
  }

  return results
}

/**
 * Search for a SceneObject from a root SceneObject.
 *
 * @param matcher – A predicate function used to select SceneObjects.
 * @param root - The root SceneObject of the tree to search.
 * @returns An array of SceneObjects that match the predicate if they exist in the tree, or an empty array otherwise.
 */
export function findSceneObjects(
  matcher: MatcherFn<SceneObject>,
  root?: SceneObject,
): SceneObject[] {
  return findInScene<SceneObject>(matcher, root)
}

/**
 * Search for a SceneObject with a given name in the scene.
 *
 * @param name - The name of the SceneObject to search for.
 * @param root - The root SceneObject of the tree to search. If not provided, the search will start from the global scene root.
 * @returns An array of SceneObjects with the given name if they exist in the tree, or an empty array otherwise.
 */
export function findSceneObjectsByName(
  name: string,
  root?: SceneObject,
): SceneObject[] {
  return findSceneObjects(matchSceneObjectName(name), root)
}

/**
 * Search for a SceneObject that matches a predicate.
 *
 * @param matcher - A predicate used to filter scene objects.
 * @param root - The root SceneObject of the tree to search. If not provided, the search will start from the global scene root.
 * @returns The first SceneObject that matches the predicate if it exists in the tree, or undefined otherwise.
 */
export function findSceneObject(
  matcher: MatcherFn<SceneObject>,
  root?: SceneObject,
): SceneObject | undefined {
  const sceneObjects = findSceneObjects(matcher, root)
  return sceneObjects.length > 0 ? sceneObjects[0] : undefined
}

/**
 * Search for a SceneObject with a given name in the scene.
 *
 * @param name - The name of the SceneObject to search for.
 * @param root - The root SceneObject of the tree to search. If not provided, the search will start from the global scene root.
 * @returns The first SceneObject with the given name if it exists in the tree, or undefined otherwise.
 */
export function findSceneObjectByName(
  name: string,
  root?: SceneObject,
): SceneObject | undefined {
  const sceneObjects = findSceneObjectsByName(name, root)
  return sceneObjects.length > 0 ? sceneObjects[0] : undefined
}

/**
 * Check whether any ancestor of a SceneObject has the given name.
 *
 * @param sceneObj - starting SceneObject (may be null).
 * @param name - the name to search for.
 * @param exact - when true (default) uses strict equality; when false uses substring match.
 * @returns true if an ancestor (including sceneObj itself) matches, false otherwise.
 */
export function hasAncestorWithName(
  sceneObj: SceneObject | null,
  name: string,
  exact = true,
): boolean {
  let current: SceneObject | null = sceneObj
  while (current) {
    const matches = exact ? current.name === name : current.name.includes(name)
    if (matches) return true
    current = current.getParent()
  }
  return false
}

/**
 * Visit the topmost descendants where `matcher` is satisfied — recursion
 * stops at each match, so the visitor sees disjoint subtree roots
 * (useful when you want to act on a subtree as a whole, not on every
 * matching descendant).
 *
 * @param matcher - Predicate selecting matching SceneObjects.
 * @param visit - Invoked once per topmost-matching subtree root.
 * @param root - Root of the search. Defaults to the global scene root.
 */
export function forEachTopmostSceneObject(
  matcher: MatcherFn<SceneObject>,
  visit: (object: SceneObject) => void,
  root?: SceneObject,
): void {
  if (root === undefined || isNull(root)) {
    for (let i = 0; i < global.scene.getRootObjectsCount(); i++) {
      forEachTopmostSceneObject(matcher, visit, global.scene.getRootObject(i))
    }
    return
  }
  if (matcher(root)) {
    visit(root)
    return
  }
  for (let i = 0; i < root.getChildrenCount(); i++) {
    forEachTopmostSceneObject(matcher, visit, root.getChild(i))
  }
}

/**
 * Capitalize the first character of `s`, preserving the rest. Typed to
 * return TS's built-in `Capitalize<T>` so template-literal joint names
 * stay strongly typed.
 *
 * @param s - String to capitalize.
 * @returns `s` with its first character upper-cased.
 */
export function capitalize<T extends string>(s: T): Capitalize<T> {
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}` as Capitalize<T>
}

/**
 * Visit `root` and every descendant. Use for any per-node operation
 * (layer, enabled, name lookup, …).
 *
 * @param root - Subtree root.
 * @param visit - Invoked once per SceneObject in the subtree.
 */
export function forEachSceneObjectInSubtree(
  root: SceneObject,
  visit: (object: SceneObject) => void,
): void {
  visit(root)
  for (let i = 0; i < root.getChildrenCount(); i++) {
    forEachSceneObjectInSubtree(root.getChild(i), visit)
  }
}

/**
 * Visit every component matching one of `types` on `root` and its
 * descendants. The caller asserts the structural type of the
 * components it requests.
 *
 * @param root - Subtree root.
 * @param types - LS component type strings, e.g.
 *   `["Component.RenderMeshVisual", "Component.MaterialMeshVisual"]`.
 * @param visit - Invoked once per matching component found.
 */
export function forEachComponentInSubtree<T>(
  root: SceneObject,
  types: readonly string[],
  visit: (component: T) => void,
): void {
  const accessor = root as unknown as {
    getComponents(type: string): unknown[]
  }
  for (const type of types) {
    const components = accessor.getComponents(type) as T[]
    for (const component of components) visit(component)
  }
  for (let i = 0; i < root.getChildrenCount(); i++) {
    forEachComponentInSubtree(root.getChild(i), types, visit)
  }
}

/**
 * Get the size of the colliders in a SceneObject in x, y and z direction.
 * @param collider - ColliderComponent object to get the size of.
 */
export function getColliderSize(collider: ColliderComponent): vec3 {
  if (collider.shape.isOfType("BoxShape")) {
    return (collider.shape as BoxShape).size
  } else if (collider.shape.isOfType("SphereShape")) {
    const diameter = (collider.shape as SphereShape).radius * 2
    return new vec3(diameter, diameter, diameter)
  } else if (
    collider.shape.isOfType("CapsuleShape") ||
    collider.shape.isOfType("CylinderShape") ||
    collider.shape.isOfType("ConeShape")
  ) {
    const shape = collider.shape as CapsuleShape | CylinderShape | ConeShape
    const length = shape.length
    const diameter = shape.radius * 2

    switch (shape.axis) {
      case Axis.X: {
        return new vec3(length, diameter, diameter)
      }
      case Axis.Y: {
        return new vec3(diameter, length, diameter)
      }
      case Axis.Z: {
        return new vec3(diameter, diameter, length)
      }
    }
  } else if (collider.shape.isOfType("MeshShape")) {
    const meshShape = collider.shape as MeshShape
    return meshShape.mesh.aabbMax.sub(meshShape.mesh.aabbMin)
  }
  throw new Error(`Unsupported collider shape: ${collider.shape.getTypeName()}`)
}

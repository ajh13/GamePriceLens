import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {TargetingMode} from "InteractionKit.lspkg/Core/Interactor/Interactor"
import {IK} from "InteractionKit.lspkg/IK"
import WorldCameraFinderProvider from "InteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import {
  AwaitEventOnceOptions,
  MatcherFn,
  findInScene,
  matchSceneObjectParentName,
  hasAncestorWithName,
  withEventTimeout,
} from "Leaf.lspkg/Utils/common/Utils"
import {PublicApi} from "InteractionKit.lspkg/Utils/Event"
import BaseInteractor from "InteractionKit.lspkg/Core/Interactor/BaseInteractor"
import {InteractorEvent} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import {LeafLifecycle} from "Leaf.lspkg/Utils/common/LeafLifecycle"

/**
 * Matches name of the SceneObject containing an {@link Interactable}.
 *
 * @param name - name of {@link SceneObject} to match.
 * @param enabledOnly - if true, only returns the Interactable if it is enabled
 *                      (both component and scene hierarchy). Defaults to false.
 * @returns the Interactable if the name matches (and enabled if enabledOnly), undefined otherwise.
 */
export const matchInteractableName = (
  name: string,
  enabledOnly?: boolean,
): MatcherFn<Interactable> => {
  return (sceneObject: SceneObject) => {
    if (sceneObject.name !== name) {
      return undefined
    }
    const interactables = sceneObject.getComponents(
      Interactable.getTypeName(),
    ) as Interactable[]
    if (enabledOnly) {
      return interactables.find(isEnabled)
    }
    return interactables[0]
  }
}

/**
 * Matches name of the parent scene object of this {@link Interactable}'s scene object.
 *
 * @param name - name of {@link SceneObject}'s parent to match.
 * @param enabledOnly - if true, only returns the Interactable if it is enabled
 *                      (both component and scene hierarchy). Defaults to false.
 * @returns the Interactable if the parent's name matches (and enabled if enabledOnly), undefined otherwise.
 */
export const matchInteractableParentName = (
  name: string,
  enabledOnly?: boolean,
): MatcherFn<Interactable> => {
  return (sceneObject: SceneObject) => {
    const interactables = sceneObject.getComponents(
      Interactable.getTypeName(),
    ) as Interactable[]
    if (enabledOnly) {
      return interactables.find((interactable) => {
        if (!isEnabled(interactable)) {
          return false
        }
        return (
          matchSceneObjectParentName(name)(interactable.getSceneObject()) !==
          undefined
        )
      })
    }
    const interactable = interactables[0]
    if (!interactable) {
      return undefined
    }
    const parentMatch = matchSceneObjectParentName(name)(
      interactable.getSceneObject(),
    )
    return parentMatch !== undefined ? interactable : undefined
  }
}

/**
 * Optional filter configuration for {@link getInteractables}.
 * All fields are optional; only specified fields are applied.
 */
export type FilterInteractableConfig = {
  enabled?: boolean
  enabledInHierarchy?: boolean
  sceneObjectName?: string
  parentName?: string
  ancestorName?: string
  /** When true, keep only interactables whose world position is in the camera's field of view. */
  inFoV?: boolean
}

function matchesFilter<T>(expected: T | undefined, received: T): boolean {
  return expected === undefined || expected === received
}

/**
 * @param filterConfig - optional filter to narrow results.
 * @returns all {@link Interactable} in the scene matching the filter
 *          (or every Interactable when no filter is provided).
 */
export function getInteractables(
  filterConfig?: FilterInteractableConfig,
): Interactable[] {
  const cameraProvider = filterConfig?.inFoV
    ? WorldCameraFinderProvider.getInstance()
    : undefined
  return IK.InteractionManager.getInteractablesThatTarget(
    TargetingMode.All,
  ).filter((interactable) => {
    if (!filterConfig) return true
    const sceneObject = interactable.getSceneObject()
    return (
      matchesFilter(filterConfig.enabled, interactable.enabled) &&
      matchesFilter(
        filterConfig.enabledInHierarchy,
        sceneObject.isEnabledInHierarchy,
      ) &&
      matchesFilter(filterConfig.sceneObjectName, sceneObject.name) &&
      matchesFilter(filterConfig.parentName, sceneObject.getParent()?.name) &&
      (filterConfig.ancestorName === undefined ||
        hasAncestorWithName(sceneObject, filterConfig.ancestorName)) &&
      (cameraProvider === undefined ||
        cameraProvider.inFoV(sceneObject.getTransform().getWorldPosition()))
    )
  })
}

/**
 * Filters the given components down to those a LEAF interactor can actually
 * hover: enabled in the hierarchy and carrying at least one collider. Disabled
 * or collider-less ones never receive a hover, so triggering them would only
 * time out.
 *
 * @param components - anything exposing a SceneObject and an `interactable` to filter.
 * @returns the subset that is enabled in the hierarchy and has a collider.
 */
export function withCollider<
  T extends {
    getSceneObject(): SceneObject
    interactable: {colliders: ColliderComponent[]}
  },
>(components: T[]): T[] {
  return components.filter(
    (component) =>
      component.getSceneObject().isEnabledInHierarchy &&
      component.interactable.colliders.length > 0,
  )
}

/**
 * Find every drivable component of `typeName` under `root` — enabled in the
 * hierarchy and carrying a collider a LEAF interactor can hover (see
 * {@link withCollider}). The parameter type mirrors `SceneObject.getComponent`
 * so call sites can pass `Widget.getTypeName()` unchanged.
 *
 * @param root - root SceneObject of the subtree to search.
 * @param typeName - component type to find, e.g. `Button.getTypeName()`.
 * @returns the matching components that are enabled and have a collider.
 */
export function findComponentsWithCollider<
  T extends BaseScriptComponent & {
    interactable: {colliders: ColliderComponent[]}
  },
>(
  root: SceneObject,
  typeName: T extends BaseScriptComponent ? TypeName<T> : never,
): T[] {
  return withCollider(
    findInScene<T>((object) => object.getComponent<T>(typeName) ?? undefined, root),
  )
}

/**
 * Searches within the SceneObject tree rooted at the SceneObject,
 * looking for a child SceneObject which has an Interactable component,
 * and returns the Interactable component.
 *
 * @param matcher - A predicate function used to select Interactables.
 * @param root - The root SceneObject of the tree to search. If not provided,
 *               the search will start from the global scene root.
 * @param enabledOnly - if true, only returns Interactables that are enabled
 *                      (both component and scene hierarchy). Defaults to false.
 * @returns The matching Interactable components, or empty array if none found.
 */
export function findInteractables(
  matcher: MatcherFn<Interactable>,
  root?: SceneObject,
  enabledOnly?: boolean,
): Interactable[] {
  const results = findInScene<Interactable>(matcher, root)
  if (enabledOnly) {
    return results.filter(isEnabled)
  }
  return results
}

/**
 * Searches within the SceneObject tree rooted at the SceneObject with the given name,
 * looking for a child SceneObject whose name exactly matches `interactableName`,
 * and returns its Interactable component.
 *
 * @param name - name of the {@link SceneObject}
 * @param root - The root SceneObject of the tree to search. If not provided, the search will start from the global scene root.
 * @param enabledOnly - if true, only returns Interactables that are enabled
 *                      (both component and scene hierarchy). Defaults to false.
 * @returns the Interactables in the scene attached to SceneObjects with the given name.
 */
export function findInteractablesByName(
  name: string,
  root?: SceneObject,
  enabledOnly?: boolean,
): Interactable[] {
  return findInteractables(matchInteractableName(name), root, enabledOnly)
}

/**
 * @param name - name of the {@link SceneObject}
 * @param root - The root SceneObject of the tree to search. If not provided, the search will start from the global scene root.
 * @param enabledOnly - if true, only returns Interactables that are enabled
 *                      (both component and scene hierarchy). Defaults to false.
 * @returns the first Interactable in the scene attached to a SceneObject with the given name, or `undefined`.
 */
export function findInteractableByName(
  name: string,
  root?: SceneObject,
  enabledOnly?: boolean,
): Interactable | undefined {
  return findInteractablesByName(name, root, enabledOnly)[0]
}

/**
 * Checks whether an Interactable is enabled.
 *
 * This checks both that the Interactable component is enabled AND that its
 * SceneObject (and all parent SceneObjects) are enabled in the hierarchy.
 *
 * @param interactable - The Interactable to check (can be undefined)
 * @returns true if the interactable and its scene hierarchy are enabled, false otherwise
 */
export function isEnabled(interactable: Interactable | undefined): boolean {
  return !!(
    interactable !== undefined &&
    !isNull(interactable) &&
    interactable.enabled &&
    interactable.getSceneObject().isEnabledInHierarchy
  )
}

/**
 * Returns a promise that resolves the next time `event` fires for
 * `interactor`, or rejects after `options.timeoutMs`
 *
 * @param event - The event to listen on.
 * @param interactor - The interactor to filter by.
 */
export function awaitInteractorEvent(
  event: PublicApi<InteractorEvent>,
  interactor: BaseInteractor,
  options?: AwaitEventOnceOptions,
): Promise<void> {
  const scope = LeafLifecycle.getInstance().currentScope
  let unsubscribe: (() => void) | undefined
  const cancel = () => {
    unsubscribe?.()
    unsubscribe = undefined
  }
  const eventFired = new Promise<void>((resolve) => {
    unsubscribe = event.add((event) => {
      if (event.interactor === interactor) {
        cancel()
        resolve()
      }
    })
  })
  return withEventTimeout(
    scope ? scope.track(eventFired, cancel) : eventFired,
    cancel,
    options,
  )
}

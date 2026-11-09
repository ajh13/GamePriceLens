@typedef
export class Callback {
  @input
  @allowUndefined
  public scriptComponent: ScriptComponent
  @input
  @allowUndefined
  public functionName: string
}

/**
 * Searches for components with the given type in the tree rooted at the given root SceneObject.
 *
 * @param root - The root SceneObject of the tree to search.
 * @param name - The component typename to search for.
 * @returns An array of the components with that type
 *
 * @deprecated Use findAllComponentsInSelfOrChildren from InteractionKit.lspkg/Utils/SceneObjectUtils instead.
 */
export function findAllChildComponents(root: SceneObject | null, name: keyof ComponentNameMap): Component[] {
  const children = root?.children ?? getSceneRoots()
  const components = root?.getComponents(name) ?? []
  components.push(...children.flatMap((c) => findAllChildComponents(c, name)))
  return components
}

/**
 * Searches `start` and then each ancestor for a component of the given type, returning the
 * first match.
 *
 * @param start - The SceneObject to search from; checked before its ancestors.
 * @param name - The component typename to search for.
 * @returns The first matching component, or null if none is found.
 *
 * @deprecated Use findComponentInSelfOrParents from InteractionKit.lspkg/Utils/SceneObjectUtils instead.
 */
export function findComponentInAncestors(start: SceneObject, name: keyof ComponentNameMap): Component {
  let parent = start
  let component = null
  while (parent !== null) {
    component = parent.getComponent(name)
    if (component) break
    parent = parent.getParent()
  }

  return component
}

/**
 * Returns an array of all root objects in the scene.
 */
export function getSceneRoots(): SceneObject[] {
  const nodes: SceneObject[] = []
  for (let i = 0; i < global.scene.getRootObjectsCount(); i++) {
    nodes.push(global.scene.getRootObject(i))
  }
  return nodes
}

/** Returns whether a Component is being destroyed when supported by the runtime. */
export function isComponentBeingDestroyed(component: Component): boolean {
  const compatibleComponent = component as unknown as {isBeingDestroyed?: boolean}
  return "isBeingDestroyed" in compatibleComponent && compatibleComponent.isBeingDestroyed === true
}

/** Returns whether an error reports an operation against an object being destroyed. */
export function isBeingDestroyedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("being destroyed")
}

/**
 * Returns whether `ancestor` is an ancestor of `descendant`, including when
 * both arguments reference the same SceneObject.
 *
 * @param ancestor - The SceneObject that may be in the ancestor chain.
 * @param descendant - The SceneObject whose parent chain to inspect.
 */
export function isSceneObjectAncestorOf(ancestor: SceneObject, descendant: SceneObject): boolean {
  let current: SceneObject | null = descendant
  while (current && !isNull(current)) {
    if (current === ancestor) {
      return true
    }
    current = current.getParent()
  }

  return false
}

/** Returns whether a SceneObject's placement is driven by a ScreenTransform component. */
export function usesScreenTransform(sceneObject: SceneObject): boolean {
  return !!sceneObject.getComponent("ScreenTransform")
}

/** Reparents a SceneObject while preserving the transform semantics of its component type. */
export function reparentExternalChild(sceneObject: SceneObject, parent: SceneObject): void {
  if (usesScreenTransform(sceneObject)) {
    sceneObject.setParent(parent)
    return
  }

  sceneObject.setParentPreserveWorldTransform(parent)
}

/** Removes a SceneObject's parent while preserving the transform semantics of its component type. */
export function unparentExternalChild(sceneObject: SceneObject): void {
  if (usesScreenTransform(sceneObject)) {
    sceneObject.removeParent()
    return
  }

  sceneObject.removeParentPreserveWorldTransform()
}

/**
 * Moves a SceneObject to the end of its current parent's child list, the
 * foreground under Hierarchy sorting, with its local transform untouched.
 *
 * The parent does not change, so there is nothing to convert: the plain
 * removeParent / setParent pair keeps the local values as they are. Do not
 * use the world-preserving pair here. Under a zero-scale ancestor (a panel
 * collapsed to scale 0 until its first layout) the parent's world matrix
 * cannot be inverted, and the round trip writes local scale 0 plus the
 * object's world position into local space.
 *
 * No-op for a root object.
 */
export function reappendChild(sceneObject: SceneObject): void {
  const parent = sceneObject.getParent()
  if (!parent || isNull(parent)) {
    return
  }

  sceneObject.removeParent()
  sceneObject.setParent(parent)
}

/**
 * Creates a SceneObject parented under the given parent, inheriting the
 * parent's render layer.
 * @param name - The name for the new SceneObject.
 * @param parent - The parent to attach to; its layer is copied to the child.
 * @returns The newly created SceneObject.
 */
export function createChildSceneObjectWithParentLayer(name: string, parent: SceneObject): SceneObject {
  const sceneObject = global.scene.createSceneObject(name)
  sceneObject.layer = parent.layer
  sceneObject.setParent(parent)
  return sceneObject
}

/**
 * Sets only the local z position of a transform, preserving local x/y.
 *
 * @param transform - The transform to update.
 * @param zOffset - The local z value to assign.
 */
export function setTransformZOffset(transform: Transform, zOffset: number): void {
  const position = transform.getLocalPosition()
  position.z = zOffset
  transform.setLocalPosition(position)
}

export function createCallbacks<T>(callbacks: Callback[]): (args: T) => void {
  if (callbacks === undefined || callbacks.length === 0) {
    return () => {}
  }
  return (args) => {
    for (let i = 0; i < callbacks.length; i++) {
      if ((callbacks[i].scriptComponent as any)[callbacks[i].functionName as any]) {
        ;(callbacks[i].scriptComponent as any)[callbacks[i].functionName as any](args)
      }
    }
  }
}

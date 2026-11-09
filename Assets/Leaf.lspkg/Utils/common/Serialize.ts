import {Logger} from "./Logger"

const LOG = new Logger("Serialize")

/**
 *  Converts a string representation of a 4x4 matrix into a `mat4` object.
 * @param matrixString  - A string representation of a 4x4 matrix in the format:
 *                        `[[x1, y1, z1, w1], [x2, y2, z2, w2], [x3, y3, z3, w3], [x4, y4, z4, w4]]`
 *                        where each inner array represents a column of the matrix.
 * @returns  A `mat4` object constructed from the provided string.
 */
export function stringToMat4(matrixString: string): mat4 {
  const columns = JSON.parse(matrixString).map((col: number[]) => {
    if (!Array.isArray(col) || col.length !== 4) {
      throw new Error(
        "Invalid matrix format. Each column must contain exactly 4 elements.",
      )
    }
    return new vec4(col[0], col[1], col[2], col[3])
  })
  if (columns.length !== 4) {
    throw new Error("Invalid matrix format. Expected a 4x4 matrix.")
  }
  return mat4.fromColumns(columns[0], columns[1], columns[2], columns[3])
}

/**
 *  Converts a `mat4` object into a string representation.
 * @param matrix  - The matrix to convert to a string.
 * @returns The string representation of the matrix formatted as a JSON-like representation:
 *  `[[x1, y1, z1, w1],[x2, y2, z2, w2],[x3, y3, z3, w3],[x4, y4, z4, w4]]`
 */
export function mat4ToString(matrix: mat4): string {
  const columns = [
    matrix.column0,
    matrix.column1,
    matrix.column2,
    matrix.column3,
  ]
  return `[${columns
    .map((col) => `[${col.x}, ${col.y}, ${col.z}, ${col.w}]`)
    .join(",")}]`
}

/**
 * Looks up a transform for a scene object name, handling hand tracking keypoint naming conventions.
 * Hand tracking keypoints typically include the joint name followed by a suffix,
 * e.g., "wrist_0_150279482965091965:1414157077024952791".
 * This function extracts the base joint name before the "_0_" delimiter and uses it to query the configuration map.
 *
 * @param name - The name of the SceneObject, potentially containing a hand tracking keypoint suffix.
 * @param ConfigMap - A mapping from base joint names to their serialized world transform strings.
 * @returns The serialized world transform string if found, otherwise undefined.
 */
function attachmentPointTransformLookUp(
  name: string,
  ConfigMap: Record<string, string>,
): string | undefined {
  const trimmedName = name.split("_0_")[0]
  return ConfigMap[trimmedName]
}

/**
 * Sets the world transform of a SceneObject based on its name and a provided configuration map.
 *
 * @throws {Error} If no configuration is found for the SceneObject.
 * @param sceneObject - The SceneObject whose world transform will be set.
 * @param ConfigMap - A mapping from scene object names to their serialized world transform strings.
 */
function setSceneObjectTransform(
  sceneObject: SceneObject,
  ConfigMap: Record<string, string>,
): void {
  const data =
    ConfigMap[sceneObject.name] ??
    attachmentPointTransformLookUp(sceneObject.name, ConfigMap)
  if (!data) {
    LOG.warn(
      `No initial configuration found for scene object: ${sceneObject.name}, skipping.`,
      false,
    )
    return
  }
  sceneObject.getTransform().setWorldTransform(stringToMat4(data))
}

/**
 * Resets the world transform of a scene object and all its descendants in the hierarchy
 * to their configuration as specified in the provided data map.
 * See {@link INITIAL_HAND_WORLD_TRANSFORMS}.
 *
 * @param sceneObject - The root SceneObject whose hierarchy will be reset.
 * @param data - A mapping from scene object names to their serialized world transform strings.
 *
 * @throws {Error} If no initial configuration is found for a scene object.
 */
export function setSceneObjectHierarchyTransform(
  sceneObject: SceneObject,
  data: Record<string, string>,
): void {
  setSceneObjectTransform(sceneObject, data)

  sceneObject.children.forEach((child) => {
    setSceneObjectHierarchyTransform(child, data)
  })
}

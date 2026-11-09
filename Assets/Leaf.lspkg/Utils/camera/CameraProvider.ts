/**
 * Defines available camera apis
 */
export default interface CameraProvider {
  /**
   * Add SceneObject as a child of the camera's SceneObject
   *
   * @param sceneObject - SceneObject to attach
   */
  attachSceneObject(sceneObject: SceneObject): void
}

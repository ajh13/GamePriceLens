import {findInScene} from "../common/Utils"
import CameraProvider from "./CameraProvider"

/**
 * Base class that provides camera related apis
 */
export default class WorldCameraFinderProvider implements CameraProvider {
  protected cameraComponent!: Camera
  protected cameraTransform!: Transform

  private static instance: WorldCameraFinderProvider
  /**
   * @returns singleton instance. Creates one if it doesn't exist, and register
   * it as a SnipsService.
   */
  public static getInstance(): WorldCameraFinderProvider {
    if (!this.instance) {
      this.instance = new WorldCameraFinderProvider()
    }
    return this.instance
  }

  constructor() {
    const cameraComponent = this.lookForCameraComponent()
    this.setCamera(cameraComponent)
  }

  /** @inheritDoc */
  attachSceneObject(sceneObject: SceneObject): void {
    sceneObject.setParent(this.cameraComponent.getSceneObject())
  }

  /**
   * Checks the {@link SceneObject} passed if it has a {@link Camera} component
   * with the right render target.
   * @param object - The SceneObject to check.
   * Returns a reference to the {@link Camera} if true, undefined if not.
   */
  protected matchSameRenderTargetCamera(object: SceneObject): Camera | null {
    const cameraComponent = object.getComponent("Component.Camera")

    // It is possible the liveTarget is not set, in this case we use the captureTarget
    const targetRenderTarget =
      global.scene.liveTarget ?? global.scene.captureTarget

    if (
      object.enabled &&
      !isNull(cameraComponent) &&
      cameraComponent.type === Camera.Type.Perspective &&
      cameraComponent.renderTarget.isSame(targetRenderTarget)
    ) {
      return cameraComponent
    } else {
      return undefined
    }
  }

  protected setCamera(cameraComponent: Camera): void {
    if (isNull(cameraComponent)) {
      throw new Error(
        "Could not find any suitable camera in the scene, make sure it is setup correctly",
      )
    }
    this.cameraComponent = cameraComponent
    this.cameraTransform = this.cameraComponent.getTransform()
  }

  private lookForCameraComponent(): Camera | undefined {
    const cameras = findInScene<Camera>(this.matchSameRenderTargetCamera)
    return cameras.length > 0 ? cameras[0] : undefined
  }
}

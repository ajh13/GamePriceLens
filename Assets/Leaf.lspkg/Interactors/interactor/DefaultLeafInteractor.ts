import {DefaultSikInteractor} from "./DefaultSikInteractor"
import {BaseLeafInteractor} from "./BaseLeafInteractor"

/**
 * Base Interactor class used for testing.
 * Simulates hand input through IK HandInteractor.
 */
export class DefaultLeafInteractor extends BaseLeafInteractor {
  private interactorSceneObject: SceneObject
  constructor(interactorName: string = "DefaultLeafInteractor") {
    const sceneObject = global.scene.createSceneObject(interactorName)
    const interactorComponent = sceneObject.createComponent(
      DefaultSikInteractor.getTypeName(),
    )
    super(interactorComponent)
    this.interactorSceneObject = sceneObject
  }

  //@override
  protected destroy(): void {
    super.destroy()
    this.interactorSceneObject.destroy()
  }
}

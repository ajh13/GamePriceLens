import {BaseLeafInteractor} from "../BaseLeafInteractor"
import {
  CustomComponentTypename,
  LeafInteractorManager,
} from "./LeafInteractorManager"
import {Logger} from "Leaf.lspkg/Utils/common/Logger"

const LOG = new Logger("DefaultLeafInteractorManager")

/**
 * Not a component, because it shouldn't be set directly in the space.
 */
export class DefaultLeafInteractorManager implements LeafInteractorManager {
  private interactorTypenamesById: Map<string, CustomComponentTypename> =
    new Map<string, CustomComponentTypename>()

  private static instance: LeafInteractorManager
  private constructor(private owner: SceneObject) {}

  static getInstance(): LeafInteractorManager {
    if (!this.instance) {
      this.instance = new DefaultLeafInteractorManager(
        global.scene.createSceneObject("LeafInteractorManager"),
      )
    }

    return this.instance
  }

  registerLeafInteractor(
    interactorId: string,
    interactorTypename: CustomComponentTypename,
  ): void {
    LOG.info(`Register interactor: ${interactorId}`, false)
    if (this.interactorTypenamesById.has(interactorId)) {
      LOG.warn(
        `Interactor ID "${interactorId}" already exists. Will override the value.`,
        false,
      )
    }
    this.interactorTypenamesById.set(interactorId, interactorTypename)
  }

  listLeafInteractors(): string[] {
    return Array.from(this.interactorTypenamesById.keys())
  }

  async startInteractor(interactorId: string): Promise<BaseLeafInteractor> {
    // Return a dummy promise to avoid breaking the API
    return new Promise((resolve) => {
      resolve(null)
    })
  }
}

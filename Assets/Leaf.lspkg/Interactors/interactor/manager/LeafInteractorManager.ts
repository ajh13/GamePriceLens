import {BaseLeafInteractor} from "../BaseLeafInteractor"

export type CustomComponentTypename = keyof ComponentNameMap

export interface LeafInteractorManager {
  registerLeafInteractor(
    interactorId: string,
    interactorTypename: CustomComponentTypename,
  ): void

  listLeafInteractors(): string[]

  startInteractor(interactorId: string): Promise<BaseLeafInteractor>
}

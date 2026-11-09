/**
 * Callback called when a function is cancelled
 */
export type CancelCb = () => void

/**
 * A cancellable promise that can be cancelled by calling the `cancel` method.
 * This is useful for promises that may need to be cancelled, such as animations.
 */
export class CancellablePromise<T> extends Promise<T> {
  constructor(
    executor: (
      resolve: (value: T | PromiseLike<T>) => void,
      reject: (reason?: any) => void,
    ) => void,
    private cancelFn: CancelCb,
  ) {
    super(executor)
  }

  public cancel() {
    if (this.cancelFn) {
      this.cancelFn()
    }
  }
}

import {Interactable} from "InteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import animate, {CancelSet} from "InteractionKit.lspkg/Utils/animate"

export class ToolbarAutoHideManager {
  private readonly OPACITY_TWEEN_DURATION = 0.4
  private readonly AUTO_HIDE_ALPHA = 0
  private readonly AUTO_SHOW_ALPHA = 1

  private _currentAlpha: number = 1
  private _alphaCancel: CancelSet = new CancelSet()
  // The hover subscriptions live on the hover TARGET, and when the bar is docked
  // that target is the Frame's SceneObject, which can outlive the toolbar. They
  // are kept so dispose() can remove them: left in place, the next hover over a
  // surviving Frame would start a fresh fade against a destroyed toolbar.
  private _hoverUnsubscribes: (() => void)[] = []
  private _disposed: boolean = false

  public constructor(
    private _hoverTarget: SceneObject,
    private setAlpha: (alpha: number) => void
  ) {}

  public setup(): void {
    const interactable = this._hoverTarget.getComponent(Interactable.getTypeName()) as Interactable
    if (!interactable) {
      return
    }

    this._hoverUnsubscribes.push(
      interactable.onHoverEnter.add(() => {
        this.tweenAlpha(this._currentAlpha, this.AUTO_SHOW_ALPHA)
      }),
      interactable.onHoverExit.add(() => {
        this.tweenAlpha(this._currentAlpha, this.AUTO_HIDE_ALPHA)
      })
    )
  }

  public getInitialAlpha(): number {
    return this.AUTO_HIDE_ALPHA
  }

  private tweenAlpha(fromAlpha: number, toAlpha: number): void {
    if (this._disposed) {
      return
    }
    this._alphaCancel.cancel()

    const duration = this.OPACITY_TWEEN_DURATION * Math.abs(toAlpha - fromAlpha)

    animate({
      duration: duration,
      update: (t: number) => {
        this._currentAlpha = fromAlpha + (toAlpha - fromAlpha) * t
        this.setAlpha(this._currentAlpha)
      },
      ended: () => {
        this._currentAlpha = toAlpha
        this.setAlpha(this._currentAlpha)
      },
      cancelSet: this._alphaCancel
    })
  }

  /**
   * Cancels the in-flight fade AND removes the hover subscriptions, for good.
   * Call this when the toolbar goes away, on every destroy path.
   *
   * It matters more than a stray write would suggest. IK's `animate()` runs every
   * animation in the lens from ONE shared update handler, which empties its queue
   * before looping and lets each animation re-queue itself only at the END of its
   * own frame, with no try/catch. So a fade whose `update` or `ended` throws on a
   * destroyed toolbar (both call setAlpha) loses itself and every animation queued
   * after it, and Lens Studio never calls a handler that threw again, so every
   * animation in the lens stops for good. Idempotent.
   */
  public dispose(): void {
    this._disposed = true
    this._alphaCancel.cancel()
    for (const unsubscribeHover of this._hoverUnsubscribes) {
      unsubscribeHover()
    }
    this._hoverUnsubscribes = []
  }
}

import {InteractorEvent} from "InteractionKit.lspkg/Core/Interactor/InteractorEvent"
import Event, {PublicApi} from "InteractionKit.lspkg/Utils/Event"
import NativeLogger from "InteractionKit.lspkg/Utils/NativeLogger"
import * as MotionChannels from "Motion.lspkg/Channels"
import {linear} from "Motion.lspkg/Eases"
import {Motion} from "Motion.lspkg/Motion"
import {LongPressButtonComponentDataType} from "../../Themes/System-3.0/Styles/LongPressButtonParameters"
import {Callback, createCallbacks} from "../../Utility/SceneUtilities"
import {RoundedRectangleVisual} from "../../Visuals/RoundedRectangle/RoundedRectangleVisual"
import {StateName} from "../Element"
import {Button} from "./Button"
import {buildFillGradient, DEFAULT_FILL_EDGE_EPSILON, FillPaletteStop, readPaletteStops} from "./LongPressFillGradient"
import {isRestingState, resolveLongPressState} from "./LongPressStateCoercion"

const log = new NativeLogger("LongPressButton")

/** Motion channel id. One live tween per (target, id), which is what we want. */
const FILL_CHANNEL_ID: string = "longPress.fill"

/**
 * `RoundedRectangleVisual`'s own border-size channel id. The component owns
 * `borderSize` (see `applyBorderForProgress`), so it has to kill the visual's
 * state-driven tween on this channel rather than race it.
 */
const BORDER_SIZE_CHANNEL_ID: string = "rr.borderSize"

/** Below this the fill is treated as empty and the button hands its gradient back. */
const EMPTY_PROGRESS_THRESHOLD: number = 1e-4

const FALLBACK_HOLD_SECONDS: number = 1.0
const FALLBACK_DRAIN_SECONDS: number = 0.25
const FALLBACK_HOLD_BORDER_SIZE: number = 0.175

/**
 * `LongPressButton` — a Primary-looking button that only fires after the user
 * holds it. The interior fills left-to-right while held, like a slider being
 * driven by time instead of by a drag.
 *
 * ## Two modes
 *
 * - **Latching** (default, `Repeatable` off). Completing leaves the button filled
 *   in a "Completed" state until reset or external deselection. The button is a toggle,
 *   so the Completed look is the theme's `toggledDefault` / `toggledHovered`
 *   palette and `isOn` / `onFinished` come from `BaseButton`. For one-shot,
 *   irreversible confirmations: delete, unpair, power off.
 * - **Repeatable** (`Repeatable` on). Completing fires and the fill stays full for
 *   as long as the pinch is held; ending the trigger drains it and re-arms. The
 *   button is a plain momentary control — nothing latches, `isOn` stays false.
 *   For actions you may want to invoke again: send, capture, skip.
 *
 * Timing is themeable (`componentData["LongPressButton"]`) with per-instance
 * overrides: `Hold Duration (s)` for how long the fill takes, `Drain Duration (s)`
 * for how fast it empties.
 *
 * ## The states
 *
 * | state           | background            |
 * |-----------------|-----------------------|
 * | default (idle)  | idle tone             |
 * | hovered         | track tone (recessed) |
 * | triggered       | track tone + fill     |
 * | toggled* (done) | fill palette (full)   |
 *
 * Hovering recesses the button to the tone it will fill from; pressing fills it.
 * Backgrounds come from `styles["LongPressButton"]`, not `styles["Button"]` — see
 * {@link visualStyleType}.
 *
 * The OUTLINE is not in that table on purpose. It follows the fill, not the
 * state: any fill at all shows it, an empty fill hides it, and a completed button
 * keeps it because completed is just a full fill. See
 * {@link applyBorderForProgress}.
 *
 * ## Why it extends Button
 *
 * Shape, size, opacity, theme resolution and the Prism/RoundedRect visual choice
 * are all inherited. Only the state palette and the fill are bespoke.
 *
 * ## How the fill is drawn
 *
 * Not a child mesh. `RoundedRectangle` has one scalar `cornerRadius` — no
 * per-corner radii — so a child quad cannot have rounded left corners and a
 * sharp right edge without a mask. Instead the wipe is a hard-edged stop pushed
 * into the button's OWN background gradient via
 * `RoundedRectangleVisual.applyBaseGradientNow`. That clips to the squircle for
 * free and adds no draw call. See `LongPressFillGradient.ts` for the stop math.
 *
 * `applyBaseGradientNow` sets a transient override that makes state transitions
 * skip the base gradient while still applying the border — which is what lets the
 * border track the fill independently of the state.
 *
 * The override is handed back to the theme in exactly ONE place:
 * `writeProgress(0)`, i.e. when the fill actually empties. Completion does NOT
 * release it — at progress 1 the wipe already emits the authored palette verbatim,
 * and the theme keeps `fillPalette` equal to the toggled background, so releasing
 * there would repaint identical pixels while adding a force-restore path that only
 * ran in that one window. It was also where the outline went missing.
 *
 * The handoff SNAPS, so the theme keeps `trackColor` equal to the hovered /
 * triggered background: an empty fill handed back mid-hover is then
 * pixel-identical to the state underneath. See the no-pop invariant in
 * `Themes/System-3.0/Styles/LongPressButtonParameters.ts`.
 *
 * ## How the hold is clocked
 *
 * Motion drives it, so there is no per-frame `update()` and no idle cost — the
 * base `Element` only binds an `UpdateEvent` when a subclass overrides
 * `update()`, and this one does not.
 *
 * ## Events
 *
 * `onTriggerDown` / `onTriggerUp` are inherited from `BaseButton` and remain RAW
 * INPUT. A short tap fires them and does NOT complete the action. Consumers that
 * want "the button was activated" must use {@link onHoldComplete}.
 *
 * ## Inspector note
 *
 * `Toggleable` and `Default To On` are inherited `BaseButton` inputs and neither
 * does anything here: toggle-ness is decided by `Repeatable` (see
 * {@link isToggle}), and in latching mode completion is what turns the button on.
 * Both should be hidden via `ScriptInputsHidden` in `LongPressButton.ts.meta`
 * once Lens Studio has generated it, the same way `Link.ts.meta` hides them. To
 * start a latching instance already completed, call {@link complete} rather than
 * checking `Default To On`.
 *
 * @extends Button
 */
@component
export class LongPressButton extends Button {
  @input
  @label("Hold Duration (s)")
  @hint("Seconds of continuous hold to fill and complete. 0 uses the theme value (1.0s in both themes).")
  private _holdSecondsOverride: number = 0

  @input
  @label("Drain Duration (s)")
  @hint("Seconds for the fill to empty after an early release. 0 uses the theme value (0.25s in both themes).")
  private _drainSecondsOverride: number = 0

  @input
  @label("Repeatable")
  @hint("Off (default): stays filled once completed until reset() is called. On: re-arms when the trigger ends.")
  private _repeatable: boolean = false

  @input
  @label("Cancel When Pointer Leaves")
  // NOTE: decorator arguments must be single string literals — LensifyTS's
  // component compiler rejects a concatenated expression with "Expected string
  // literal", and `tsc-only` does not catch it.
  @hint("Off (default): the hold survives the hand drifting off, as long as the pinch holds. On: moving off aborts.")
  private _cancelOnPointerLeave: boolean = false

  @input
  @label("Emit Progress Events")
  @hint("Fire onHoldProgress every frame while filling. Off by default — it is a per-frame event.")
  private _emitProgressEvents: boolean = false

  @input
  @hint("Enable this to add functions from another script to this component's long-press callbacks")
  private addLongPressCallbacks: boolean = false
  @ui.group_start("Long Press Callbacks")
  @showIf("addLongPressCallbacks")
  @input
  @label("On Hold Complete Callbacks")
  private holdCompleteCallbacks: Callback[] = []
  @input
  @label("On Hold Canceled Callbacks")
  private holdCanceledCallbacks: Callback[] = []
  @ui.group_end
  private _progress: number = 0
  private _completed: boolean = false
  /** True while a pinch is down and the fill is climbing. */
  private _holding: boolean = false
  /** Distinguishes a replacement hold started synchronously inside a callback. */
  private _holdAttempt: number = 0
  /** Set around the `super` call that would otherwise play the wrong cue. */
  private _suppressInheritedAudio: boolean = false

  private _fillPalette: FillPaletteStop[] = []
  private _trackColor: vec4 = new vec4(0, 0, 0, 1)
  private _edgeSoftness: number = DEFAULT_FILL_EDGE_EPSILON
  private _themeHoldSeconds: number = FALLBACK_HOLD_SECONDS
  private _themeDrainSeconds: number = FALLBACK_DRAIN_SECONDS
  /** Outline width used whenever there is any fill. See applyBorderForProgress. */
  private _holdBorderSize: number = FALLBACK_HOLD_BORDER_SIZE
  /** Set when the style has no gradient fill to drive (Prism); disables the wipe. */
  private _fillSupported: boolean = true
  /** Whether a transient base-gradient override is currently installed. */
  private _overrideActive: boolean = false

  private readonly _fillChannel = MotionChannels.custom<number>(FILL_CHANNEL_ID, () => ({
    read: () => this._progress,
    write: (value: number) => this.writeProgress(value)
  }))

  private holdStartEvent: Event<void> = new Event<void>()
  private _onHoldStart?: PublicApi<void>
  /** Fires when a hold begins (pinch down on the button). */
  public get onHoldStart(): PublicApi<void> {
    return (this._onHoldStart ??= this.holdStartEvent.publicApi())
  }

  private holdProgressEvent: Event<number> = new Event<number>()
  private _onHoldProgress?: PublicApi<number>
  /**
   * Fires with progress in [0, 1] as the fill moves. Only emitted when
   * "Emit Progress Events" is on — it is a per-frame event.
   */
  public get onHoldProgress(): PublicApi<number> {
    return (this._onHoldProgress ??= this.holdProgressEvent.publicApi())
  }

  private holdCanceledEvent: Event<number> = new Event<number>()
  private _onHoldCanceled?: PublicApi<number>
  /** Fires with the progress reached when a hold is abandoned before completing. */
  public get onHoldCanceled(): PublicApi<number> {
    return (this._onHoldCanceled ??= this.holdCanceledEvent.publicApi())
  }

  private holdCompleteEvent: Event<void> = new Event<void>()
  private _onHoldComplete?: PublicApi<void>
  /**
   * Fires once when the hold completes. THIS is the button's activation event —
   * not `onTriggerUp`, which is raw input and also fires on a short tap.
   */
  public get onHoldComplete(): PublicApi<void> {
    return (this._onHoldComplete ??= this.holdCompleteEvent.publicApi())
  }

  /** Current fill progress in [0, 1]. */
  public get progress(): number {
    return this._progress
  }

  /** True once completed or externally selected, until reset or deselection. */
  public get completed(): boolean {
    return this._completed
  }

  /** Seconds of hold required to complete, at full travel. */
  public get holdSeconds(): number {
    return this._holdSecondsOverride > 0 ? this._holdSecondsOverride : this._themeHoldSeconds
  }

  /**
   * Accepts 0, which is the "use the theme value" sentinel — rejecting it would
   * make an override impossible to clear once set. Matches `drainSeconds`.
   */
  public set holdSeconds(seconds: number) {
    if (seconds === undefined || !(seconds >= 0)) {
      return
    }
    this._holdSecondsOverride = seconds
  }

  /** Seconds for the fill to drain after an early release. */
  public get drainSeconds(): number {
    return this._drainSecondsOverride > 0 ? this._drainSecondsOverride : this._themeDrainSeconds
  }

  public set drainSeconds(seconds: number) {
    if (seconds === undefined || !(seconds >= 0)) {
      return
    }
    this._drainSecondsOverride = seconds
  }

  /**
   * True when the button re-arms after each completion instead of latching.
   * @see reset
   */
  public get repeatable(): boolean {
    return this._repeatable
  }

  /**
   * Switches between latching and repeatable behavior. Safe before or after
   * `initialize()`.
   *
   * After initialize this has to re-wire the interactable listeners, because
   * {@link isToggle} changes and `InteractableStateMachine` is told whether it is
   * a toggle at subscription time — the same reason `BaseButton.setIsToggleable`
   * exists. Any latched state is cleared first, under the OLD semantics, so a
   * toggled state machine is properly untoggled before toggle-ness changes
   * underneath it.
   */
  public set repeatable(value: boolean) {
    if (value === undefined || value === this._repeatable) {
      return
    }
    if (this.initialized) {
      this.reset(false)
    }
    this._repeatable = value
    if (!this.initialized) {
      return
    }
    this.removeInteractableListeners()
    this.setUpInteractableListeners()
  }

  /**
   * In LATCHING mode (the default) the button is a toggle: completion is what
   * turns it on, so `BaseButton`'s toggle plumbing supplies the Completed visual
   * state (`toggledDefault` / `toggledHovered`) and the `isOn` / `onFinished`
   * surface. Adding a `completed` entry to `StateName` instead would ripple
   * through every `Style` record in both themes.
   *
   * In REPEATABLE mode it is a plain momentary button. Nothing latches, so the
   * toggled states would never be a truthful description of it — and staying a
   * toggle would leave the state machine holding an `isOn` that completion never
   * sets. Read once at initialize by `BaseButton`, so `Repeatable` must be set
   * before then (it is an `@input`, so the inspector path is fine; programmatic
   * callers should use `setVariant`-style pre-initialize configuration).
   */
  protected get isToggle(): boolean {
    return !this._repeatable
  }

  /**
   * Resolves per-state looks from `styles["LongPressButton"]` instead of
   * `styles["Button"]`. The hold redefines what the states mean — hover recesses
   * to the track tone with no border, the border only appears while committing,
   * and the completed state keeps it — so a Button palette would be wrong rather
   * than merely unstyled. Registered in BOTH themes; a missing component key has
   * no fallback and leaves the visual unstyled.
   */
  protected get visualStyleType(): string {
    return "LongPressButton"
  }

  public initialize(): boolean {
    if (!super.initialize()) {
      return false
    }

    this.readThemeData()
    this.checkFillSupport()

    // Forgiving by default: an AR pinch drifts, and losing a one-second hold to
    // a few millimetres of hand travel feels broken. Same idiom as Slider.
    const interactable = this.interactable
    if (interactable && !isNull(interactable)) {
      interactable.keepHoverOnTrigger = !this._cancelOnPointerLeave
    }

    // Latching mode only (repeatable mode is not a toggle at all): a completed
    // button must never untoggle from a stray tap — reset or external deselection clears it.
    if (this._interactableStateMachine) {
      this._interactableStateMachine.untoggleOnClick = false
    }

    // `BaseButton.initialize` seeds `isOn` from the `Default To On` input. Keep
    // the long-press bookkeeping consistent with it, so an instance authored as
    // already-completed doesn't offer a hold that fills from an apparently
    // full bar.
    if (this.isOn) {
      // Through `becomeFull`, not a bare `_progress = 1`: the assignment marked the
      // button complete without painting, so the gradient override was never
      // installed (nothing to hand back on a later `reset`, which popped to the dim
      // track for a frame) and the outline was never asserted — a full fill with no
      // outline, breaking the fill-follows-outline rule this component is built on.
      this.becomeFull()
      // `super.initialize()` already painted a state, and it did so while
      // `_completed` was still false — so `unlatchedStateFor` coerced
      // `toggledDefault` down to `default` AND wrote that back to `this.stateName`.
      // Re-apply the latched state explicitly now that the flag is set.
      this.setState(StateName.toggledDefault)
    }

    return true
  }

  protected setUpEventCallbacks(): void {
    super.setUpEventCallbacks()
    if (this.addLongPressCallbacks) {
      this.onHoldComplete.add(createCallbacks(this.holdCompleteCallbacks))
      this.onHoldCanceled.add(createCallbacks(this.holdCanceledCallbacks))
    }
  }

  /**
   * Paints the fill at an explicit progress without completing.
   *
   * Deliberately does NOT fire {@link onHoldComplete} even at 1 — a hold that
   * the user did not perform must not read as a confirmation. Use
   * {@link complete} for that. Cancels any hold in flight.
   *
   * @param value - Progress in [0, 1]; out-of-range values are clamped.
   */
  public setProgress(value: number): void {
    if (value === undefined) {
      return
    }
    this._holding = false
    Motion.killTweensOf(this, FILL_CHANNEL_ID)
    this.writeProgress(value)
  }

  /**
   * Completes the hold immediately, as if the user had held to the end: latches
   * the button and fires {@link onHoldComplete}. Idempotent once completed.
   */
  public complete(): void {
    this.completeHold()
  }

  /**
   * Clears a completed hold and returns the button to idle.
   *
   * The main entry point in latching mode. In repeatable mode the button re-arms
   * itself when the trigger ends, so this is only needed to clear a completed
   * fill while the pinch is still being held.
   *
   * @param animated - When true (default) the fill drains; when false it snaps.
   */
  public reset(animated: boolean = true): void {
    this._completed = false
    this._holding = false
    if (this.isOn) {
      this.setOn(false, false)
    }
    if (animated) {
      this.drainFill()
    } else {
      Motion.killTweensOf(this, FILL_CHANNEL_ID)
      this.writeProgress(0)
    }
  }

  // ───────────────────────────────── input ─────────────────────────────────

  protected onTriggerDownHandler(event: InteractorEvent): void {
    super.onTriggerDownHandler(event)
    if (event.propagationPhase !== "Target") {
      return
    }
    this.beginHold()
  }

  protected onTriggerUpHandler(event: InteractorEvent): void {
    // `Element.onTriggerUpHandler` plays its trigger-end cue on EVERY release. On a
    // hold-to-confirm control that sounds a confirmation for a short tap that
    // confirmed nothing — the audio would say "done" while `onHoldComplete` never
    // fired. Suppressed here and re-issued from `completeHold` instead, so the cue
    // marks the thing it is supposed to mark. (It also never played on completion
    // before: a hold completes mid-press, not on release, and the
    // `triggerEndOutside` / `triggerCanceled` paths never reach this method at all.)
    this._suppressInheritedAudio = true
    super.onTriggerUpHandler(event)
    this._suppressInheritedAudio = false

    if (event.propagationPhase !== "Target") {
      return
    }
    this.abandonHold()
  }

  /**
   * Gates the inherited trigger-end cue. See {@link onTriggerUpHandler} for why the
   * release is the wrong moment for it on this component.
   */
  protected playAudioTrack(audioTrack: AudioTrackAsset, volume: number): void {
    if (this._suppressInheritedAudio) {
      return
    }
    super.playAudioTrack(audioTrack, volume)
  }

  protected onHoverExitHandler(event: InteractorEvent): void {
    super.onHoverExitHandler(event)
    // Target phase only, matching the trigger handlers. `Element` guards its own
    // event dispatch this way but the guard does not carry into an override, so
    // without it a hover-exit BUBBLED from an interactable child would cancel a
    // hold the user is still performing on this button.
    if (event.propagationPhase !== "Target") {
      return
    }
    if (this._cancelOnPointerLeave) {
      this.abandonHold()
    }
  }

  /**
   * Two jobs.
   *
   * 1. **Pin the completed look.** `InteractableStateMachine` has no "latched"
   *    concept: with `untoggleOnClick = false`, releasing a pinch while still
   *    hovering a toggled button re-invokes `toggledTriggered`, which would
   *    repaint the completed button with the dim PRESSED palette. There is also
   *    no way to steer it from here — its `State` and `Action` enums are not
   *    exported. Coercing the request is robust regardless of how the machine
   *    routes, and pressing an already-completed button showing no press
   *    feedback is correct anyway: there is no further action to invite.
   * 2. **React to the trigger ending.** Dropping into a resting state is the one
   *    signal that covers every way a press can finish — `triggerEnd`,
   *    `triggerEndOutside` and `triggerCanceled`, the last two of which never
   *    reach `onTriggerUpHandler`. An unfinished hold is abandoned; a completed
   *    repeatable one drains and re-arms here, which is what makes the
   *    confirmation last exactly as long as the pinch.
   *
   * See `LongPressStateCoercion` for the mapping and why it is a separate module.
   */
  protected setState(stateName: StateName): void {
    // Cast: the coercion module is import-free (so it can be unit-tested) and
    // therefore works in StateName's string values rather than the enum itself.
    const effective = resolveLongPressState(stateName, this._completed, this._repeatable) as StateName
    super.setState(effective)
    // The state change may have written the theme's `borderSize` for `default`.
    // Re-assert the outline against the fill, which is the only thing that
    // decides it.
    this.applyBorderForProgress()

    if (!isRestingState(effective)) {
      return
    }
    if (this._holding) {
      this.abandonHold()
    } else if (this._repeatable && this._completed) {
      this.reArmAfterCompletion()
    }
  }

  /**
   * A plain state must not infer that a completed button was deselected; only reset or an external
   * deselection clears completion. BaseButton already ignores inactive, so this now covers the rest:
   * an error state, or a repeatable button selected through `isOn`.
   */
  protected setOnFromState(on: boolean): void {
    if (!on && this._completed) {
      return
    }
    super.setOnFromState(on)
  }

  /** External selection, including ToggleGroup, keeps completion and fill coherent. */
  protected setOn(on: boolean, explicit: boolean): void {
    if (this.initialized) {
      if (!on && this._completed) {
        this._completed = false
        this._holding = false
        Motion.killTweensOf(this, FILL_CHANNEL_ID)
        this.writeProgress(0)
      } else if (on && !this._completed) {
        this.becomeFull()
        if (!this._completed) {
          return // A progress callback reset the selection.
        }
      }
    }
    super.setOn(on, explicit)
  }

  /**
   * Cancels any hold in flight when this component (or an ancestor) is disabled.
   *
   * The hold clock lives on Motion's global ticker, which does not care that the
   * SceneObject is disabled — `Element.onDisabled` turns off the collider,
   * interactable and visual, but nothing stops the tween. Without this, hiding or
   * disabling the UI mid-hold leaves the clock running and `onHoldComplete` can
   * fire for a destructive confirmation whose control is no longer on screen.
   *
   * Snaps rather than drains: an animation for an off-screen control is pointless,
   * and a killed mid-drain would leave a stranded partial fill (and its outline) to
   * greet the user on re-enable.
   *
   * A completed latch is deliberately preserved — being disabled is not the same
   * as being reset. A repeatable completion is not a latch: it lasts as long as
   * the pinch, which the disable ends, so it re-arms here, snapped. Left to
   * `super.onDisabled`, the resting state it paints would re-arm it with an
   * animated drain.
   */
  protected onDisabled(): void {
    this.abandonHold(false)
    if (this._repeatable && this._completed) {
      this._completed = false
    }
    if (!this._completed) {
      // Covers a drain that was already in flight, which `abandonHold` skips
      // because `_holding` is already false.
      Motion.killTweensOf(this, FILL_CHANNEL_ID)
      this.writeProgress(0)
    }
    super.onDisabled()
  }

  /** Repeatable only: end the confirmation, drain the fill, accept a new hold. */
  private reArmAfterCompletion(): void {
    this._completed = false
    this.drainFill()
  }

  /**
   * The ONE way this component becomes "full": bookkeeping plus a real paint.
   * Deliberately fires no events, so it can be shared by a hold the user actually
   * performed ({@link completeHold}) and an instance authored already-completed
   * (`initialize`, when `Default To On` is set).
   *
   * This exists because "the button is full" has three entry points — the fill
   * tween landing on 1, the public `complete()`, and initialization — and every
   * bug where one of them diverged came from a bare `_progress = 1` assignment
   * skipping the paint. Painting through `writeProgress` is what installs the
   * gradient override AND asserts the outline, so a path that skips it produces a
   * button that is logically complete but visually wrong (no override to hand
   * back, no outline despite a full fill).
   *
   * Killing the fill tween first matters for the same reason: reaching 1 naturally
   * is not the only way in, and `complete()` can land mid-hold where a surviving
   * tween would keep writing partial values and drag the finished button back.
   */
  private becomeFull(): void {
    Motion.killTweensOf(this, FILL_CHANNEL_ID)
    this._completed = true
    this._holding = false
    this.writeProgress(1)
  }

  // ─────────────────────────────── hold clock ───────────────────────────────

  private beginHold(): void {
    // Note: an unsupported fill (`_fillSupported === false`, e.g. a Prism style)
    // does NOT block the hold. The clock and the events are the contract; the
    // wipe is the affordance. Silently refusing to complete would make the
    // button look dead, which is worse than completing without a fill — and
    // `checkFillSupport` has already warned loudly. `writeProgress` skips the
    // painting side on its own.
    // inputPaused too: an onTriggerDown listener can pause the button before this runs.
    if (this._completed || this.inactive || this.inputPaused) {
      return
    }
    const attempt = ++this._holdAttempt
    this._holding = true
    this.holdStartEvent.invoke()
    if (!this._holding || attempt !== this._holdAttempt) {
      return
    }

    const remaining = 1 - this._progress
    const duration = this.holdSeconds * remaining
    if (!(duration > 0)) {
      this.completeHold()
      return
    }

    // Deliberately `Motion.to` and NOT `animateState`: the hold ramp is an
    // interaction requirement, not decoration. A reduced-motion policy returning
    // `snap` would complete a deliberate confirmation gesture instantly, which
    // is a correctness bug rather than a comfort win. The drain and any
    // completion flourish DO respect the policy.
    //
    // Duration scales by remaining travel so re-pressing a partly-filled button
    // finishes at the authored rate instead of restarting the full clock —
    // the same convention StateMotion documents for value-parameterized motion.
    Motion.to(this, {
      channel: this._fillChannel,
      value: 1,
      duration,
      ease: linear,
      onFinish: (forward: boolean) => {
        if (forward && this._holding && attempt === this._holdAttempt) {
          this.completeHold()
        }
      }
    })
  }

  /**
   * Release / cancel before completion. No-op if not holding — which also covers
   * the post-completion case, since `completeHold` clears `_holding` before the
   * real trigger-up arrives.
   */
  private abandonHold(animated: boolean = true): void {
    if (!this._holding) {
      return
    }
    this._holding = false
    const reached = this._progress
    if (animated) {
      this.drainFill()
    } else {
      // Teardown path (see onDisabled): snap, so nothing is left on Motion's
      // global ticker for a control that is going off screen.
      Motion.killTweensOf(this, FILL_CHANNEL_ID)
      this.writeProgress(0)
    }
    this.holdCanceledEvent.invoke(reached)
  }

  private drainFill(): void {
    // Kill FIRST, unconditionally, before any early-out. A release on the same
    // frame as the press leaves progress at exactly 0, and an "already empty"
    // early return that skipped this would leave the climbing hold tween live to
    // reach 1 and fire completion on its own — a confirmation the user never
    // performed. `killTweensOf` is cheap and idempotent, so it is not worth
    // guarding.
    Motion.killTweensOf(this, FILL_CHANNEL_ID)
    const duration = this.drainSeconds
    if (this._progress <= EMPTY_PROGRESS_THRESHOLD || !(duration > 0)) {
      // Nothing to animate, but still write: this is what releases the visual's
      // transient gradient override back to the theme.
      this.writeProgress(0)
      return
    }
    Motion.to(this, {channel: this._fillChannel, value: 0, duration, ease: linear})
  }

  private completeHold(): void {
    if (this._completed) {
      return
    }
    this.becomeFull()

    // The success cue belongs here, not on release — this is the moment the action
    // actually happened. Deliberately in `completeHold` rather than `becomeFull`,
    // so an instance authored already-completed does not announce itself at
    // startup. Uses the inherited trigger-end track so `Play Audio` and the
    // per-instance track/volume inputs keep working unchanged.
    this.playAudioTrack(this.triggerEndAudioTrack, this.triggerEndAudioVolume)

    if (this._repeatable) {
      // Nothing latches. The full fill stays up for as long as the pinch does —
      // the confirmation is visible exactly as long as the user holds it — and
      // ending the trigger is what drains and re-arms (see setState).
      // `_completed` stays true until then, which also blocks a second completion
      // landing on top of this one: `beginHold` would otherwise see progress at 1,
      // compute a zero-length hold, and re-complete immediately.
      this.holdCompleteEvent.invoke()

      // ...unless there is no trigger to end. A programmatic `complete()` on a
      // button that is already at rest never sees that transition, so nothing
      // would ever drain it and it would sit at 100% until something unrelated
      // moved the state. Re-arm immediately instead: a momentary button completed
      // out of band should still return to empty on its own.
      if (isRestingState(this.stateName)) {
        this.reArmAfterCompletion()
      }
      return
    }

    // `setOn` moves the visual to toggledDefault / toggledHovered and fires
    // BaseButton's onValueChange + onFinished.
    this.setOn(true, true)

    // Deliberately NOT releasing the fill override here.
    //
    // At progress 1 `buildFillGradient` emits the authored palette verbatim, and
    // the theme keeps `fillPalette` equal to the toggled background (the no-pop
    // invariant), so the override is already painting exactly what handing the
    // base back would paint. It bought nothing and cost the one code path unique
    // to the held-completed window: `refreshRoundedRectangleState` force-restores
    // the base there and nowhere else in this sequence, and that window was the
    // one where the outline went missing while `borderSize` stayed correct.
    //
    // The override is released when the fill actually empties — `reset` drains it
    // and `writeProgress(0)` hands the base back then. Keeping it installed until
    // then also means a completed button's base is painted by one owner for its
    // whole life instead of changing hands mid-state.
    this.holdCompleteEvent.invoke()
  }

  // ──────────────────────────────── rendering ────────────────────────────────

  private writeProgress(value: number): void {
    const clamped = value < 0 ? 0 : value > 1 ? 1 : value
    this._progress = clamped

    if (this._emitProgressEvents) {
      const attempt = this._holdAttempt
      this.holdProgressEvent.invoke(clamped)
      if (this._progress !== clamped || attempt !== this._holdAttempt) {
        return // The callback replaced this progress write or started another hold.
      }
    }

    if (!this._fillSupported) {
      return
    }

    this.applyBorderForProgress()

    if (clamped <= EMPTY_PROGRESS_THRESHOLD) {
      this.releaseFillOverride()
      return
    }

    const visual = this.fillVisual
    if (visual === undefined) {
      return
    }
    visual.applyBaseGradientNow(
      buildFillGradient({
        palette: this._fillPalette,
        trackColor: this._trackColor,
        progress: clamped,
        epsilon: this._edgeSoftness
      })
    )
    this._overrideActive = true
  }

  /**
   * Shows the outline whenever there is ANY fill, hides it when the fill is
   * empty — including once completed, which is just a full fill.
   *
   * Written straight to the visual rather than expressed per state. Three
   * state-based attempts failed before this, each because "is there a fill" was
   * being inferred from an interaction state that can disagree with the actual
   * progress; the progress cannot disagree with itself. `RoundedRectangleVisual`'s
   * `borderSize` setter writes through with no gating, and no state except
   * `default` authors a `borderSize`, so nothing clobbers this except that one
   * transition — which re-asserts (see `setState`).
   */
  private applyBorderForProgress(): void {
    const visual = this.fillVisual
    if (visual === undefined) {
      return
    }
    // Kill the theme's border-size animation before writing, or it wins.
    //
    // `_rrStates` resolves each state's `borderSize` with a fallback to `default`
    // (`resolveStyleValue(stateParams?.borderSize, defaultParams?.borderSize)`), and
    // `default` is the one state that authors it — as 0. So EVERY state resolves
    // `borderSize` to 0, and `applyRoundedRectangleState` calls `updateBorderSize(0)`
    // on every transition, which starts an `rr.borderSize` tween toward 0 that keeps
    // writing for frames afterwards.
    //
    // While the fill is running that tween is invisible, because `writeProgress`
    // re-writes the real value every frame and always gets the last word. The
    // moment the fill stops — i.e. completion — the per-frame writes stop, the
    // tween finishes its job, and the outline fades out. That is exactly the
    // reported symptom: outline correct while filling, gone once full, flickering
    // back for a frame on any later state change.
    //
    // `default` keeps authoring 0 deliberately: it makes the competing target
    // deterministic and errs toward "no outline" if this assertion is ever missed,
    // rather than a stuck-on ring.
    Motion.killTweensOf(visual, BORDER_SIZE_CHANNEL_ID)
    visual.borderSize = this._progress > EMPTY_PROGRESS_THRESHOLD ? this._holdBorderSize : 0
  }

  /** Returns the base gradient to the theme's per-state control. */
  private releaseFillOverride(): void {
    if (!this._overrideActive) {
      return
    }
    this._overrideActive = false
    this.fillVisual?.refreshRoundedRectangleState()
    // refreshRoundedRectangleState re-applies the current state's style, which
    // for `default` includes borderSize 0. Re-assert against the fill.
    this.applyBorderForProgress()
  }

  private get fillVisual(): RoundedRectangleVisual | undefined {
    const visual = this._visual
    if (!visual || isNull(visual) || !(visual instanceof RoundedRectangleVisual)) {
      return undefined
    }
    return visual
  }

  // ───────────────────────────────── theme ─────────────────────────────────

  private readThemeData(): void {
    const data = this.resolveTheme()?.componentData?.["LongPressButton"] as LongPressButtonComponentDataType | undefined
    if (data === undefined) {
      log.w(
        `${this.sceneObject.name}: no LongPressButton theme data for "${this.resolveTheme()?.name}". ` +
          `The hold still works, but the fill will not draw.`
      )
      this._fillPalette = []
      return
    }
    this._fillPalette = readPaletteStops(data.fillPalette)
    this._trackColor = data.trackColor
    this._edgeSoftness = data.edgeSoftness > 0 ? data.edgeSoftness : DEFAULT_FILL_EDGE_EPSILON
    this._themeHoldSeconds = data.holdSeconds > 0 ? data.holdSeconds : FALLBACK_HOLD_SECONDS
    this._themeDrainSeconds = data.drainSeconds >= 0 ? data.drainSeconds : FALLBACK_DRAIN_SECONDS
    this._holdBorderSize = data.holdBorderSize > 0 ? data.holdBorderSize : FALLBACK_HOLD_BORDER_SIZE
  }

  /**
   * The wipe needs a gradient-backed rounded rect. The Prism styles render
   * through `BeveledPrismVisual`, which has no background-gradient seam, so the
   * fill is disabled rather than silently doing nothing on every frame.
   */
  private checkFillSupport(): void {
    if (this.fillVisual !== undefined && this._fillPalette.length > 0) {
      this._fillSupported = true
      return
    }
    this._fillSupported = false
    if (this.usesPrismVisual) {
      log.w(
        `${this.sceneObject.name}: style "${this.effectiveStyle}" renders as a beveled prism, which has no ` +
          `gradient fill. Use Primary, Secondary or Ghost for a long-press fill. The hold still completes.`
      )
    }
  }

  protected release(): void {
    this._holding = false
    Motion.killTweensOf(this, FILL_CHANNEL_ID)
    super.release()
  }
}

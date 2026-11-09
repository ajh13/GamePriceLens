/**
 * Which interaction state a `LongPressButton` should actually paint.
 *
 * `InteractableStateMachine` has no concept of "latched". Its
 * `triggeredTriggerEnd()` returns `toggledHovered` whenever `isToggle` is set —
 * it treats "released" as "toggled on". Latching mode DOES set `isToggle` (that
 * is where the Completed palette and `isOn` come from), so without this mapping
 * abandoning a hold lands on the completed look — full accent, border kept — and
 * `BaseButton.setState` then infers `isOn` from the state name and fires a false
 * `onFinished(true)`. On a long press, only a finished hold may latch.
 *
 * Coercing the request is deliberate rather than steering the machine: its
 * `State` and `Action` enums are not exported, and there is nothing to configure.
 * The machine's own state is allowed to drift — every transition out of a toggled
 * state lands somewhere this mapping also handles.
 *
 * ## Why this is its own file, and why it takes strings
 *
 * It has ZERO imports so it can be unit-tested. `StateName` lives in
 * `Components/Element.ts`, and importing that pulls the entire IK interaction
 * stack (`Interactable`, `HandInteractor`, `InteractionPlane` and its
 * `@ui.separator` decorators) plus `requireAsset` calls at module scope, none of
 * which exist under jest. The names below therefore mirror `StateName`'s string
 * values as literals; the caller casts back to the enum. Those values are also
 * the per-state keys in every theme `Style` record, so renaming them is already a
 * breaking change that would fail loudly in many other places.
 */

const DEFAULT = "default"
const HOVERED = "hovered"
const TRIGGERED = "triggered"
const INACTIVE = "inactive"
const TOGGLED_DEFAULT = "toggledDefault"
const TOGGLED_HOVERED = "toggledHovered"
const TOGGLED_TRIGGERED = "toggledTriggered"

/** Repeatable completion must keep resting states reachable so release can re-arm. */
export function resolveLongPressState(requested: string, completed: boolean, repeatable: boolean): string {
  return completed && !repeatable ? latchedStateFor(requested) : unlatchedStateFor(requested)
}

/**
 * State to paint while the button IS completed: the mirror of
 * {@link unlatchedStateFor}. Every plain interaction state maps to its toggled
 * equivalent, because while completed a plain state is the lie.
 *
 * Pressing a finished button shows no press feedback — there is no further action
 * to invite — so `triggered` reads as the settled latched look rather than a
 * distinct pressed one.
 *
 * `default` needs mapping for a real reason, not symmetry: leaving `inactive`
 * makes `Element` assign `stateName = default` and repaint, which would otherwise
 * drop a completed button back to the idle palette.
 *
 * @param requested - State the interactable state machine asked for.
 * @returns The state to actually apply.
 */
export function latchedStateFor(requested: string): string {
  switch (requested) {
    case DEFAULT:
      return TOGGLED_DEFAULT
    case HOVERED:
    case TRIGGERED:
    case TOGGLED_TRIGGERED:
      return TOGGLED_HOVERED
    default:
      // `inactive` and the error states pass through: an inactive completed button
      // should look inactive, and the latch is preserved by `setOn` rather than by
      // painting the toggled palette over it.
      return requested
  }
}

/**
 * State to paint while the button is NOT completed: every toggled state maps back
 * to its plain equivalent.
 *
 * @param requested - State the interactable state machine asked for.
 * @returns The state to actually apply.
 */
export function unlatchedStateFor(requested: string): string {
  switch (requested) {
    case TOGGLED_TRIGGERED:
      return TRIGGERED
    case TOGGLED_HOVERED:
      return HOVERED
    case TOGGLED_DEFAULT:
      return DEFAULT
    default:
      return requested
  }
}

/**
 * Whether a state means "no press is in progress".
 *
 * Reaching one of these is the single signal that covers every way a press can
 * end, including `triggerEndOutside` and `triggerCanceled`, which never reach
 * `onTriggerUpHandler`. `LongPressButton` uses it twice: to unwind an abandoned
 * hold, and to decide whether a repeatable completion has a trigger-end coming
 * that will drain it — a programmatic `complete()` from rest does not, and would
 * otherwise sit at full fill forever.
 *
 * Takes the state after coercion. Only completed latching buttons keep toggled
 * states, which must not count as resting. Repeatable buttons keep plain states
 * so release can drain and re-arm them.
 *
 * @param state - Coerced state name.
 * @returns True when no press is in progress.
 */
export function isRestingState(state: string): boolean {
  return state === DEFAULT || state === HOVERED || state === INACTIVE
}

// Pure trigger state machine for Frame's single-hand / dual-grab gesture
// lifecycle. Lives outside Frame so it can be unit-tested without a Lens
// Studio runtime. Frame consumes the state transitions in its onTriggerStart
// / onTriggerUpdate / onTriggerEnd callbacks — see Frame.ts.
//
// States:
//   idle                          — no interactor is triggering
//   single(primary)               — exactly one interactor is triggering
//   dual(primary, secondary)      — two interactors are triggering, ordered
//                                    by arrival (primary triggered first)
//
// Transitions are total (defined for every state × event) and pure (no side
// effects). Frame layers the side effects (billboard pivot, scale state,
// drag anchor rebase) on top by diffing the previous and next states.

import {Interactor} from "InteractionKit.lspkg/Core/Interactor/Interactor"

export type TriggerState =
  | {kind: "idle"}
  | {kind: "single"; primary: Interactor}
  | {kind: "dual"; primary: Interactor; secondary: Interactor}

/** Convenience singleton for the idle state — saves allocation churn. */
export const idleState: TriggerState = {kind: "idle"}

/**
 * Whether a snapping pose takeover may settle DepthBehavior's gesture state.
 * A translation can end mid-dual when translation permission changes, so a
 * dual state must keep the depth gesture alive until an actual trigger end.
 */
export function shouldSettleDepthOnPoseTakeover(state: TriggerState): boolean {
  return state.kind !== "dual"
}

/**
 * Transition for a TriggerStart event. Idempotent for already-tracked
 * interactors (re-triggering the same hand is a no-op). A third triggerer
 * is silently ignored — there are only ever two hands, but defensive
 * handling keeps the machine stable if event ordering surprises us.
 */
export function onTriggerStart(state: TriggerState, interactor: Interactor): TriggerState {
  if (state.kind === "idle") {
    return {kind: "single", primary: interactor}
  }
  if (state.kind === "single") {
    if (state.primary === interactor) return state
    return {kind: "dual", primary: state.primary, secondary: interactor}
  }
  // dual: any further triggers are ignored (idempotent for tracked,
  // defensive drop for untracked).
  return state
}

/**
 * Transition for a TriggerEnd / TriggerEndOutside / TriggerCanceled event.
 *
 * - End on an untracked interactor is a no-op (defensive).
 * - End on the secondary in dual → drop back to single(primary).
 * - End on the primary in dual → promote the secondary to single(secondary).
 *   Frame is responsible for rebasing its drag anchor on this transition.
 * - End on the only triggerer in single → idle.
 */
export function onTriggerEnd(state: TriggerState, interactor: Interactor): TriggerState {
  if (state.kind === "idle") return state
  if (state.kind === "single") {
    if (state.primary === interactor) return idleState
    return state
  }
  // dual
  if (state.primary === interactor) {
    return {kind: "single", primary: state.secondary}
  }
  if (state.secondary === interactor) {
    return {kind: "single", primary: state.primary}
  }
  return state
}

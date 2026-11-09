/**
 * The policy-aware entry point for VALUE-PARAMETERIZED motion.
 *
 * Intents (SpecIntents.ts) cover authored choreography: fixed endpoints, one
 * spec table each, resolved from a profile at construction time. Component
 * STATE transitions are the other half of the system and don't fit that
 * shape — a hover colour, a press scale, a gradient swap, a partial frame
 * fade all animate to a value the component computes at the moment of the
 * interaction, over a duration scaled by how far there is left to travel.
 *
 * Those were reaching `Motion.to` / `Motion.fromTo` directly, which meant
 * they never consulted the comfort / reduced-motion policy — a policy asking
 * for `snap` would still leave every button hover, press and colour fade
 * animating at full duration, which is the highest-frequency motion in the
 * product and the half that matters most for comfort. Everything
 * value-parameterized goes through here instead, so the policy is consulted
 * exactly once per transition, in one place.
 *
 * Semantics:
 *  - `snap`: write the destination through the channel and fire `onFinish`.
 *    Delta-composed channels (a visual's scale/position offsets) and
 *    scalar-progress channels (gradients, prism colours) both land correctly,
 *    because the write goes through the channel rather than around it.
 *  - `animate` with a `durationScale`: the policy shortens these transitions
 *    explicitly. Their durations come from a component input, not a profile
 *    token, so there is no token for the policy to retune — hence the scale.
 *    A scale that leaves no time at all is treated as a snap.
 */

import * as Channels from "Motion.lspkg/Channels"
import {Motion} from "Motion.lspkg/Motion"
import {AnimatableValue, Directional, DirectionalCallback, EaseFn} from "Motion.lspkg/MotionTypes"
import {Tween} from "Motion.lspkg/Tween"
import {applyMotionPolicy, ensureProfileValidated, getActiveMotionProfile} from "./MotionTokens"

export interface StateMotionVars<T extends AnimatableValue> {
  /**
   * Policy context name. Every state transition is prefixed `state.` so a
   * policy can act on the whole class (`intent.startsWith("state.")`) without
   * enumerating renderer internals; the suffix names the property.
   */
  intent: string
  target: unknown
  channel: Channels.ChannelSelector<T>
  /** Destination value. */
  value: T
  /** Explicit start value; omitted = capture the live value. */
  from?: T
  duration: number
  ease?: Directional<EaseFn>
  onFinish?: DirectionalCallback
}

/**
 * Runs a state transition under the motion policy. Returns the tween, or null
 * when the policy snapped (nothing is left animating).
 */
export function animateState<T extends AnimatableValue>(vars: StateMotionVars<T>): Tween<T> | null {
  const requested = getActiveMotionProfile()
  const decision = applyMotionPolicy({intent: vars.intent, direction: "forward", profile: requested})
  if (decision.profile !== undefined) {
    ensureProfileValidated(decision.profile)
  }
  // Component durations come from a component input, not a profile token, so
  // the policy scales them explicitly rather than us inferring a ratio from an
  // unrelated duration. A non-finite or zero budget means "no time" — snap.
  const scale = decision.durationScale ?? 1
  const duration = vars.duration * scale
  if (decision.action === "snap" || !(isFinite(duration) && duration > 0)) {
    Motion.set(vars.target, {channel: vars.channel, value: vars.value})
    vars.onFinish?.(true)
    return null
  }
  if (vars.from !== undefined) {
    return Motion.fromTo(vars.target, {
      channel: vars.channel,
      from: vars.from,
      value: vars.value,
      duration,
      ease: vars.ease,
      onFinish: vars.onFinish
    })
  }
  return Motion.to(vars.target, {
    channel: vars.channel,
    value: vars.value,
    duration,
    ease: vars.ease,
    onFinish: vars.onFinish
  })
}

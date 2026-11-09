// @module System-3.0/Styles/LongPressButtonParameters — DO NOT REMOVE: prevents Lens Studio module collision
import {FILL_AXIS_END, FILL_AXIS_START} from "../../../Components/Button/LongPressFillGradient"
import {GradientParameters} from "../../../Visuals/RoundedRectangle/RoundedRectangle"
import {Style} from "../../Style"
import {
  AccentBlueBright,
  AccentPurpleBright,
  AccentTealBright,
  InactivePrimary,
  OutlineBrightness,
  UIlevel1,
  WarmLightGray
} from "../Colors"
import {PrimaryGradients} from "../Gradients/PrimaryGradients"
import {System3Styles} from "../System3"

/**
 * Theme data for `LongPressButton`.
 *
 * Unlike most Button subclasses this ships its OWN `styles` entry rather than
 * reusing `styles["Button"]`, because the hold changes what each interaction
 * state means:
 *
 * | state           | background             |
 * |-----------------|------------------------|
 * | default (idle)  | WarmLightGray          |
 * | hovered         | UIlevel1 (the track)   |
 * | triggered       | UIlevel1 + accent fill |
 * | toggled* (done) | accent (full)          |
 * | inactive        | InactivePrimary        |
 *
 * Hovering recesses the button to the tone it will fill from. Pressing starts
 * filling the accent in from the left. Completing leaves it fully accent.
 *
 * The outline is deliberately absent from that table — it tracks the fill, not
 * the state. See "The outline follows the FILL" below.
 *
 * ## The no-pop invariant
 *
 * The component paints the fill by overriding the base gradient, and hands it
 * back to the theme when the fill empties or the button latches. That handoff
 * SNAPS (`refreshRoundedRectangleState` force-restores whenever a transient
 * override was active), so it is only invisible if the fill's endpoints equal the
 * state backgrounds it hands off to. Two pairings must stay in sync:
 *
 * - `trackColor` === the `hovered` / `triggered` background (an empty fill handed
 *   back while still hovering)
 * - `fillPalette` === the `toggledDefault` / `toggledHovered` background (a full
 *   fill handed back on completion)
 * - and every base gradient here shares the wipe's horizontal AXIS, not just its
 *   colors — see {@link AXIS_START}
 *
 * Break any of the three and the button visibly jumps at the end of a drain, or
 * at completion. All of them are wired to shared constants below for exactly this
 * reason — do not "tidy" one away.
 *
 * ## The outline follows the FILL, not the state
 *
 * Rule: any fill at all → outline. Completely empty → no outline. So the
 * component owns `borderSize` directly (`LongPressButton.applyBorderForProgress`),
 * driven by the one scalar it already updates every frame, and `holdBorderSize`
 * below is the width it uses.
 *
 * That is why no state here authors `borderSize` except `default` (which needs a
 * starting value of 0): `RoundedRectangleVisual.updateBorderSize` early-returns on
 * `undefined`, so a state change cannot clobber what the component set. Every
 * state also keeps `hasBorder: true`, so nothing about whether the ring EXISTS
 * depends on which state we are in.
 *
 * The border's COLOUR is also identical in every state — see {@link HOLD_BORDER}
 * for why a per-state border colour reads as the outline dropping out at
 * completion.
 *
 * Getting here took three wrong turns, all state-based, all worth not repeating:
 *
 * 1. **Toggling `hasBorder` per state — the outline never drew at all.** Nothing
 *    else in the repo does it (every `hasBorder: false` in Themes/ sits on a
 *    `default` state that never turns one on later), and the path is
 *    destructively asymmetric: `BaseRoundedRectangle`'s `set border(false)` zeroes
 *    `borderSize`, while `updateBorderSize` early-returns whenever `hasBorder` is
 *    false — so the size can only ever be restored on a frame where the border is
 *    already enabled.
 * 2. **A transparent `borderGradient` — paints a BLACK ring.** The fragment
 *    shader composites with `mix(fillColor, borderResult, distFromEdge)` under an
 *    opaque blend mode, so alpha 0 is not "nothing".
 * 3. **Matching `borderGradient` to the background — desynced.** It only looks
 *    right while base and border are pixel-identical at every instant, and they
 *    are not: `updateGradient` and `updateBorderGradient` animate on separate
 *    channels, each scaling its duration by its own `prevState` distance. The
 *    first transition from a freshly snapped state stays in sync; every later one
 *    interrupts a tween mid-flight and the ring becomes visible.
 *
 * The common flaw: each tried to infer "is there a fill" from the interaction
 * state, across seven states that can each disagree with the actual progress.
 * Reading the progress directly cannot disagree with itself.
 *
 * ## Everything is a gradient on purpose
 *
 * The flat tones are expressed as flat gradients rather than
 * `baseType: "Color"` + `baseColor`. `RoundedRectangleVisual.updateColors`
 * early-returns unless `baseType === "Color"`, while gradients animate through
 * the `rr.gradient` channel, so mixing the two baseTypes across states in one
 * style makes transitions depend on which state you came from. Keeping one
 * baseType throughout is what `ButtonParameters.Primary` does, and the existing
 * `idleBackground` / `inactiveBackground` are already flat gradients.
 *
 * ## Styles
 *
 * Only `Primary` is defined. Style resolution falls back to the theme's default
 * style name (also `Primary`), so `Secondary` and `Ghost` instances render the
 * same long-press treatment rather than going unstyled. The inherited Style
 * dropdown therefore has no visual effect here yet; give the other styles their
 * own entries if that changes.
 *
 */

// Every BASE gradient here runs on the wipe's own axis, imported rather than
// re-declared so the two cannot drift — see FILL_AXIS_START for why a mismatch
// pops. (The border gradient is exempt: the component never overrides the border,
// so its axis is the same in every state that draws one and cannot snap.)
const AXIS_START = FILL_AXIS_START
const AXIS_END = FILL_AXIS_END

/** A single flat tone expressed as a gradient. See "Everything is a gradient". */
function flat(color: vec4): GradientParameters {
  return {
    type: "Linear",
    start: AXIS_START,
    end: AXIS_END,
    stop0: {enabled: true, percent: 0, color},
    stop1: {enabled: true, percent: 0.5, color},
    stop2: {enabled: true, percent: 1, color}
  }
}

/** The recessed tone a hovered or actively-filling button sits on. */
const TRACK_COLOR = UIlevel1
const TRACK_GRADIENT = flat(TRACK_COLOR)

const IDLE_GRADIENT = flat(WarmLightGray)
const INACTIVE_GRADIENT = flat(InactivePrimary)

/**
 * The palette the hold reveals, and the completed button's background.
 *
 * Re-axed to horizontal rather than used as authored — see {@link AXIS_START}.
 * Only the axis changes; the accent stops are `hoverBackground`'s.
 */
const FILL_PALETTE: GradientParameters = {
  ...PrimaryGradients.hoverBackground,
  start: AXIS_START,
  end: AXIS_END
}

/**
 * The outline colour — ONE gradient, used by every state.
 *
 * Deliberately not two. Splitting it into a hold colour and a brighter completed
 * colour makes the border CROSSFADE at the moment of completion, and that
 * crossfade is visible as a dropout: the base snaps to the full accent
 * immediately (`refreshRoundedRectangleState` force-restores it) while the border
 * eases, so for the first part of the ease the ring is still the dim colour on top
 * of a full-accent fill — invisible. One colour, no transition, nothing to dip.
 *
 * It has to be bright enough to read against the FULL fill, which is the hard
 * case: DS3's `pressedBorder` is the accent stops plus `OutlineBrightness` (only
 * +0.102), tuned against `pressedBackground` (the DIM accents), so on a
 * full-accent fill it is +10% brightness over an identical hue and disappears.
 * Brightened once more here. It reads fine against the dark track too, so the
 * partial-fill case needs nothing of its own.
 *
 * Purely a contrast value — tune freely; nothing depends on the exact colour.
 */
const HOLD_BORDER: GradientParameters = {
  type: "Linear",
  start: AXIS_START,
  end: AXIS_END,
  stop0: {enabled: true, percent: 0, color: AccentPurpleBright.add(OutlineBrightness)},
  stop1: {enabled: true, percent: 0.5, color: AccentBlueBright.add(OutlineBrightness)},
  stop2: {enabled: true, percent: 1, color: AccentTealBright.add(OutlineBrightness)}
}

const BORDER_SIZE = 0.175
const BORDER_SOFTNESS = 0.07

export type LongPressButtonComponentDataType = {
  /**
   * Palette revealed left-to-right as the hold progresses. Its authored axis is
   * ignored — the component forces a horizontal axis so the wipe edge is
   * vertical (the DS3 accent gradients sit on a slight diagonal, which would
   * slant the edge ~11 degrees).
   *
   * Must match the toggled-state background. See the no-pop invariant above.
   */
  fillPalette: GradientParameters
  /**
   * Flat color of the not-yet-filled region behind the wipe.
   *
   * Must match the hovered/triggered background. See the no-pop invariant above.
   */
  trackColor: vec4
  /**
   * Width of the cut between filled and unfilled, as a fraction of button
   * width. The shader smoothsteps across it, so this is the edge's softness:
   * 0.005 is roughly 0.45 mm on a 9 cm button.
   */
  edgeSoftness: number
  /** Seconds of continuous hold required to complete, measured at full travel. */
  holdSeconds: number
  /** Seconds for the fill to drain back to empty after an early release. */
  drainSeconds: number
  /**
   * Outline width, in local cm, whenever the button has ANY fill. Zero when the
   * fill is empty. The component writes this straight to the visual rather than
   * going through per-state style values — see "The outline follows the FILL".
   */
  holdBorderSize: number
}

export const LongPressButtonComponentData: LongPressButtonComponentDataType = {
  fillPalette: FILL_PALETTE,
  trackColor: TRACK_COLOR,
  edgeSoftness: 0.005,
  holdSeconds: 1.0,
  drainSeconds: 0.25,
  holdBorderSize: BORDER_SIZE
}

export const LongPressButtonParameters: Partial<Record<System3Styles, Style>> = {
  Primary: {
    default: {
      baseType: "Gradient",
      baseGradient: IDLE_GRADIENT,
      // `hasBorder` stays true in EVERY state, and every state uses the same
      // HOLD_BORDER gradient — the outline's VISIBILITY is not a state concern.
      // The component drives `borderSize` from the fill progress; see the header.
      hasBorder: true,
      borderType: "Gradient",
      borderGradient: HOLD_BORDER,
      // The only `borderSize` authored anywhere here: the starting value. No other
      // state sets it, so `updateBorderSize(undefined)` early-returns and a state
      // change cannot clobber what the component wrote.
      borderSize: 0,
      // Softness is global rather than per-state (the style loader reads it from
      // `default` only), so it is authored once here.
      borderSoftness: BORDER_SOFTNESS,
      shouldScale: false,
      shouldPosition: true,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    // Hover recesses into the track tone the fill will run over. Still no
    // outline — the outline is the "you are committing" signal.
    hovered: {
      baseGradient: TRACK_GRADIENT,
      hasBorder: true,
      borderGradient: HOLD_BORDER,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    // The base here is what shows THROUGH the unfilled part of the wipe, so it
    // has to equal `trackColor`. The component's gradient override owns the base
    // while the hold runs; this is the value it hands back to. The outline grows
    // in as `borderSize` animates up.
    triggered: {
      baseGradient: TRACK_GRADIENT,
      hasBorder: true,
      borderGradient: HOLD_BORDER,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    // Completed: full accent, outline kept.
    toggledDefault: {
      baseGradient: FILL_PALETTE,
      hasBorder: true,
      borderGradient: HOLD_BORDER,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    toggledHovered: {
      baseGradient: FILL_PALETTE,
      hasBorder: true,
      borderGradient: HOLD_BORDER,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    // Not reached in practice: LongPressButton coerces toggledTriggered to
    // toggledHovered once completed, so pressing a finished button gives no
    // press feedback. Defined so a future change can't land on an unstyled state.
    toggledTriggered: {
      baseGradient: FILL_PALETTE,
      hasBorder: true,
      borderGradient: HOLD_BORDER,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    },
    inactive: {
      baseGradient: INACTIVE_GRADIENT,
      hasBorder: true,
      borderGradient: HOLD_BORDER,
      localScale: new vec3(1, 1, 1),
      localPosition: new vec3(0, 0, 0)
    }
  }
}
